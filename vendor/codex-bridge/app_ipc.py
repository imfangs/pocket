"""Small, protocol-pinned client for the desktop app's local coordination socket.

Never starts another app-server, writes Codex storage, or claims thread ownership.
The socket is protected by the current user's filesystem permissions.
"""
import json
import os
import socket
import stat
import struct
import time
import uuid
from contracts import CompatibilityError


class AppIPC:
    def __init__(self, path):
        if not stat.S_ISDIR(path.parent.lstat().st_mode):
            raise RuntimeError("unsafe_socket_parent")
        for entry in (path.parent, path):
            info = entry.lstat()
            if info.st_uid != os.getuid() or info.st_mode & 0o022:
                raise RuntimeError("unsafe_socket_permissions")
        if not stat.S_ISSOCK(path.lstat().st_mode):
            raise RuntimeError("not_an_app_socket")
        self.socket = socket.socket(socket.AF_UNIX)
        self.socket.settimeout(12)
        self.socket.connect(str(path))
        self.client_id = None
        self.snapshots = {}
        self.following = {}
        try:
            result = self.request("initialize", {"clientType": "fbt-retry-watchdog"}, 0)
            data = result.get("result")
            if not isinstance(data, dict) or not isinstance(data.get("clientId"), str) or not data["clientId"]:
                raise CompatibilityError("unsupported_app_protocol:client_id")
            self.client_id = data["clientId"]
        except Exception:
            self.socket.close()
            raise

    def send(self, message):
        body = json.dumps(message, ensure_ascii=False).encode()
        self.socket.sendall(struct.pack("<I", len(body)) + body)

    def exact(self, size):
        result = bytearray()
        while len(result) < size:
            data = self.socket.recv(size - len(result))
            if not data:
                raise EOFError("app_disconnected")
            result.extend(data)
        return result

    def receive(self):
        size = struct.unpack("<I", self.exact(4))[0]
        if not 0 < size <= 64 * 1024 * 1024:
            raise CompatibilityError("unsupported_app_protocol:frame")
        try:
            message = json.loads(self.exact(size))
        except (ValueError, UnicodeError) as error:
            raise CompatibilityError("unsupported_app_protocol:message") from error
        if not isinstance(message, dict):
            raise CompatibilityError("unsupported_app_protocol:message")
        if message.get("type") == "client-discovery-request":
            self.send({"type": "client-discovery-response",
                       "requestId": message["requestId"], "response": {"canHandle": False}})
        if message.get("method") == "thread-stream-state-changed":
            params = message.get("params", {})
            if not isinstance(params, dict):
                raise CompatibilityError("unsupported_app_protocol:snapshot_envelope")
            thread_id = params.get("conversationId")
            if not isinstance(thread_id, str) or not thread_id:
                raise CompatibilityError("unsupported_app_protocol:snapshot_envelope")
            if thread_id not in self.following:
                return message
            source = message.get("sourceClientId")
            if not isinstance(source, str) or not source:
                raise CompatibilityError("unsupported_app_protocol:snapshot_envelope")
            if source != self.following[thread_id]:
                # Delayed broadcasts from a former owner cannot satisfy this subscription.
                return message
            if (message.get("type") != "broadcast"
                    or not isinstance(message.get("targetClientIds"), list)
                    or self.client_id not in message["targetClientIds"] or params.get("hostId") != "local"):
                raise CompatibilityError("unsupported_app_protocol:snapshot_envelope")
            change = params.get("change", {})
            if message.get("version") != 11:
                raise CompatibilityError("unsupported_snapshot_protocol")
            if not isinstance(change, dict):
                raise CompatibilityError("unsupported_app_protocol:snapshot_envelope")
            if change.get("type") == "snapshot":
                state = change.get("conversationState")
                if not isinstance(state, dict) or state.get("id") != thread_id or state.get("hostId") != "local":
                    raise CompatibilityError("unsupported_app_protocol:snapshot_envelope")
                self.snapshots[thread_id] = state
        return message

    def request(self, method, params, version, owner=None):
        request_id = str(uuid.uuid4())
        self.send({"type": "request", "method": method, "version": version,
                   "requestId": request_id, "sourceClientId": self.client_id,
                   "targetClientId": owner, "params": params, "timeoutMs": 10000})
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            message = self.receive()
            if message.get("type") == "response" and message.get("requestId") == request_id:
                if message.get("resultType") != "success":
                    raise RuntimeError(message.get("error", "app_request_failed"))
                if message.get("method") != method:
                    raise CompatibilityError("unsupported_app_protocol:response_method")
                handled_by = message.get("handledByClientId")
                if not isinstance(handled_by, str) or not handled_by or owner is not None and handled_by != owner:
                    raise CompatibilityError("unsupported_app_protocol:response_owner")
                return message
        raise TimeoutError("app_response_timeout")

    def set_following(self, thread_id, owner, following):
        self.send({"type": "broadcast", "method": "thread-stream-following-changed",
                   "version": 1, "sourceClientId": self.client_id,
                   "targetClientIds": [owner], "params": {"hostId": "local",
                   "conversationId": thread_id, "following": following}})
        if following:
            self.following[thread_id] = owner
        else:
            self.following.pop(thread_id, None)

    def snapshot(self, thread_id):
        owner = self.request("thread-owner-discovery", {
            "hostId": "local", "conversationId": thread_id}, 1)["handledByClientId"]
        if thread_id in self.following:
            self.set_following(thread_id, self.following[thread_id], False)
        self.snapshots.pop(thread_id, None)
        self.set_following(thread_id, owner, True)
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            self.receive()
            if thread_id in self.snapshots:
                state = self.snapshots.pop(thread_id)
                if state.get("id") != thread_id or state.get("hostId") != "local":
                    raise RuntimeError("snapshot_identity_mismatch")
                return owner, state
        raise TimeoutError("snapshot_timeout")

    def start(self, thread_id, owner, message_id, prompt):
        # No model, settings, permission, raw history, or tool-output overrides.
        return self.request("thread-follower-start-turn", {
            "conversationId": thread_id,
            "turnStart": {"request": {"threadId": thread_id,
                "clientUserMessageId": message_id,
                "input": [{"type": "text", "text": prompt, "text_elements": []}]},
                "context": {"inheritThreadSettings": True}}}, 2, owner)

    def close(self):
        try:
            for thread_id, owner in list(self.following.items()):
                self.set_following(thread_id, owner, False)
        finally:
            self.socket.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        try:
            self.close()
        except OSError:
            pass
