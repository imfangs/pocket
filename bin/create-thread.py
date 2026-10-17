"""Create an empty durable thread through a short-lived official App Server."""
from contextlib import closing
import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bundled_cli import bundled_cli, verify_cli, BundledCLIError

from bridge_config import load_bridge_config

CONFIG = load_bridge_config()
ALLOWED_METHODS = {"initialize", "project/read", "thread/start", "thread/name/set", "thread/read", "thread/metadata/update"}


class CreateError(Exception):
    def __init__(self, code, status="unknown"):
        self.code, self.status = code, status


class RpcError(CreateError):
    def __init__(self, error):
        super().__init__("official_rpc_failed")
        self.rpc_code = error.get("code")
        self.rpc_message = error.get("message")


def child_environment(home):
    env = dict(os.environ, CODEX_HOME=str(home), CODEX_SQLITE_HOME=str(home))
    env.pop("CODEX_THREAD_ID", None)
    return env


class StdioServer:
    """A bounded allowlist; no turn/start, injected items, tools, or model work."""
    def __init__(self, binary, home, cwd, timeout=15):
        self.binary, self.home, self.cwd, self.timeout = binary, home, cwd, timeout
        self.process = None
        self.sequence, self.buffer, self.methods = 0, b"", []
        self.stopped = True

    def __enter__(self):
        self.process = subprocess.Popen(
            [str(self.binary), "app-server", "--stdio", "-c", "sqlite_home=" + json.dumps(str(self.home))],
            cwd=self.cwd, env=child_environment(self.home), stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        self.stopped = False
        try:
            result = self.call("initialize", {
                "clientInfo": {"name": "pocket_create_thread", "version": "0.1"},
                "capabilities": {"experimentalApi": True},
            })
            if Path(result.get("codexHome", "")).resolve() != self.home:
                raise CreateError("server_home_mismatch", "unavailable")
            self.process.stdin.write(b'{"method":"initialized"}\n')
            self.process.stdin.flush()
            return self
        except BaseException:
            self.close()
            raise

    def call(self, method, params):
        if method not in ALLOWED_METHODS:
            raise CreateError("rpc_not_allowed", "rejected")
        self.sequence += 1
        request_id = self.sequence
        self.methods.append(method)
        self.process.stdin.write((json.dumps({"id": request_id, "method": method, "params": params}) + "\n").encode())
        self.process.stdin.flush()
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            if b"\n" not in self.buffer:
                ready, _, _ = select.select([self.process.stdout], [], [], max(0, deadline - time.monotonic()))
                if not ready:
                    break
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    raise CreateError("server_disconnected")
                self.buffer += chunk
                if len(self.buffer) > 2 * 1024 * 1024:
                    raise CreateError("rpc_response_too_large")
                continue
            line, self.buffer = self.buffer.split(b"\n", 1)
            response = json.loads(line)
            if "method" in response and "id" in response:
                raise CreateError("unexpected_server_request")
            if response.get("id") != request_id:
                continue
            if "error" in response:
                raise RpcError(response["error"])
            if "result" not in response:
                raise CreateError("invalid_rpc_response")
            return response["result"]
        raise CreateError("rpc_timeout")

    def close(self):
        if self.process is None:
            return
        try:
            self.process.stdin.close()
        except OSError:
            pass
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        self.process.stdout.close()
        self.stopped = self.process.poll() is not None

    def __exit__(self, *_):
        self.close()


def identifier(value):
    if not isinstance(value, str):
        raise CreateError("invalid_create_request", "rejected")
    try:
        parsed = str(uuid.UUID(value))
    except ValueError:
        raise CreateError("invalid_create_request", "rejected")
    if parsed != value.lower():
        raise CreateError("invalid_create_request", "rejected")
    return parsed


def parse_input(data):
    required = {"requestId", "codexHome", "cwd", "receiptPath"}
    if not isinstance(data, dict) or not required <= set(data) or set(data) - required - {"name", "projectId"}:
        raise CreateError("invalid_create_request", "rejected")
    result = {"requestId": identifier(data["requestId"])}
    for key in ("codexHome", "cwd", "receiptPath"):
        if not isinstance(data[key], str) or not Path(data[key]).is_absolute():
            raise CreateError("invalid_create_request", "rejected")
        result[key] = Path(data[key]).resolve()
    if not result["codexHome"].is_dir() or not result["cwd"].is_dir():
        raise CreateError("directory_unavailable", "rejected")
    if result["receiptPath"].is_relative_to(result["codexHome"]):
        raise CreateError("receipt_path_in_codex_home", "rejected")
    name = data.get("name")
    if name is not None:
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 220 or any(ord(c) < 32 for c in name):
            raise CreateError("invalid_thread_name", "rejected")
        result["name"] = name.strip()
    if data.get("projectId") is not None:
        result["projectId"] = identifier(data["projectId"])
    return result


def intent_hash(data):
    intent = {key: str(value) for key, value in data.items() if key != "receiptPath"}
    return hashlib.sha256(json.dumps(intent, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def checkpoint(path, receipt):
    descriptor, temporary = tempfile.mkstemp(prefix=".create-thread-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(receipt, stream, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def binary_for(home):
    try:
        binary = bundled_cli(CONFIG["appPath"])["entrypoint"]
        verify_cli(binary, home)
    except BundledCLIError as error:
        raise CreateError(error.code, "unavailable") from error
    return binary


def verify_persisted(data, thread_id, *, empty):
    home = data["codexHome"]
    with closing(sqlite3.connect((home / "state_5.sqlite").as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
        db.row_factory = sqlite3.Row
        row = db.execute("SELECT id,cwd,project_id,rollout_path,name,tokens_used,has_user_event FROM threads WHERE id=?", (thread_id,)).fetchone()
    if row is None or row["id"] != thread_id or Path(row["cwd"]).resolve() != data["cwd"] or row["project_id"] != data.get("projectId"):
        raise CreateError("created_thread_mismatch")
    path = Path(row["rollout_path"])
    path = (path if path.is_absolute() else home / path).resolve(strict=True)
    if not any(path.is_relative_to(home / part) for part in ("sessions", "archived_sessions")):
        raise CreateError("created_history_mismatch")
    with path.open("rb") as stream:
        header = stream.readline(65536)
        first = json.loads(header)
        if first.get("type") != "session_meta" or first.get("payload", {}).get("id") != thread_id:
            raise CreateError("created_history_mismatch")
        if empty:
            remaining = stream.read(1024 * 1024 + 1)
            if len(remaining) > 1024 * 1024 or remaining.strip() or row["tokens_used"] != 0 or row["has_user_event"] != 0:
                raise CreateError("created_thread_not_empty")
    if data.get("name") is not None and row["name"] != data["name"]:
        raise CreateError("created_name_mismatch")
    result = {"threadId": thread_id, "cwd": str(data["cwd"]), "projectId": row["project_id"], "name": row["name"]}
    if empty:
        result["turnCount"] = 0
    return result


def public_receipt(receipt):
    keys = ("requestId", "status", "threadId", "verified", "processStopped", "code", "cwd", "projectId", "name", "turnCount")
    return {key: receipt[key] for key in keys if key in receipt}


def execute(data, receipt):
    path, home = data["receiptPath"], data["codexHome"]
    binary = binary_for(home)
    methods = []
    if receipt:
        if receipt.get("requestId") != data["requestId"] or receipt.get("intentHash") != intent_hash(data):
            raise CreateError("create_request_conflict", "rejected")
        if not receipt.get("threadId"):
            return public_receipt(receipt)
        # A retry can inspect only the recorded ID; it never starts another thread.
        thread_id = identifier(receipt["threadId"])
        reader = StdioServer(binary, home, data["cwd"])
        try:
            with reader:
                reader.call("thread/read", {"threadId": thread_id, "includeTurns": False})
            state = verify_persisted(data, thread_id, empty=receipt.get("status") != "created")
            receipt.update(state, status="created", verified=True, processStopped=reader.stopped, phase="verified")
            receipt.pop("code", None)
        except Exception as error:
            receipt.update(status="unknown", code=getattr(error, "code", "create_readback_unavailable"),
                           verified=False, processStopped=reader.stopped)
        checkpoint(path, receipt)
        return public_receipt(receipt)

    receipt = {"schemaVersion": 1, "requestId": data["requestId"], "intentHash": intent_hash(data),
               "status": "unknown", "phase": "initializing", "verified": False, "processStopped": False}
    checkpoint(path, receipt)
    creator = StdioServer(binary, home, data["cwd"])
    started = False
    try:
        with creator:
            if data.get("projectId"):
                project = creator.call("project/read", {"projectId": data["projectId"]})
                if project.get("project", {}).get("id") != data["projectId"]:
                    raise CreateError("project_unavailable", "rejected")
            receipt.update(phase="starting", creatorPid=creator.process.pid)
            checkpoint(path, receipt)
            print("POCKET_BRIDGE_PHASE_V1 dispatch", file=sys.stderr, flush=True)
            started = True
            created = creator.call("thread/start", {"cwd": str(data["cwd"]), "ephemeral": False,
                "historyMode": "paginated", **({"projectId": data["projectId"]} if data.get("projectId") else {})})
            thread_id = identifier(created.get("thread", {}).get("id"))
            receipt.update(threadId=thread_id, phase="created_in_process")
            checkpoint(path, receipt)
            if data.get("name"):
                creator.call("thread/name/set", {"threadId": thread_id, "name": data["name"]})
            try:
                hydrated = creator.call("thread/read", {"threadId": thread_id, "includeTurns": True})
                if hydrated.get("thread", {}).get("id") != thread_id or hydrated["thread"].get("turns") != []:
                    raise CreateError("created_thread_not_empty")
            except RpcError as error:
                # 0.153.4 materializes an unnamed paginated session before this
                # precise initial read error. A fresh metadata-only reader below
                # must still repair/verify its index; the error is not success.
                if data.get("name") or error.rpc_code != -32601 or error.rpc_message != "list_turns is not supported yet":
                    raise
                receipt["materialization"] = "empty_paginated_read"
            if data.get("projectId"):
                # An unnamed thread's initial rollout does not carry projectId.
                # Persist the explicitly selected project after materialization,
                # before another reader repairs the otherwise unassigned index.
                creator.call("thread/metadata/update", {"threadId": thread_id, "projectId": data["projectId"]})
            receipt["phase"] = "materialized"
            checkpoint(path, receipt)
        methods.extend(creator.methods)
        receipt["processStopped"] = creator.stopped
        checkpoint(path, receipt)
        with StdioServer(binary, home, data["cwd"]) as reader:
            read = reader.call("thread/read", {"threadId": thread_id, "includeTurns": False})
            if read.get("thread", {}).get("id") != thread_id:
                raise CreateError("created_thread_mismatch")
        methods.extend(reader.methods)
        receipt.update(verify_persisted(data, thread_id, empty=True), status="created", phase="verified",
                       verified=True, processStopped=creator.stopped and reader.stopped, rpcMethods=methods)
        receipt.pop("code", None)
    except Exception as error:
        receipt.update(status="unknown" if started else getattr(error, "status", "unavailable"),
                       code=getattr(error, "code", "create_unavailable"), processStopped=creator.stopped,
                       rpcMethods=methods or creator.methods)
    checkpoint(path, receipt)
    return public_receipt(receipt)


def main():
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise CreateError("invalid_create_request", "rejected")
        data = parse_input(json.loads(raw))
        path = data["receiptPath"]
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with open(str(path) + ".lock", "a+") as lock:
            os.chmod(lock.name, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {"requestId": data["requestId"], "status": "unknown", "code": "create_in_progress", "processStopped": False}
            receipt = json.loads(path.read_text()) if path.exists() else None
            print("POCKET_BRIDGE_PHASE_V1 preflight", file=sys.stderr, flush=True)
            return execute(data, receipt)
    except Exception as error:
        return {"status": getattr(error, "status", "unavailable"), "code": getattr(error, "code", "invalid_create_request"),
                **({"requestId": data["requestId"]} if "data" in locals() else {})}


if __name__ == "__main__":
    print(json.dumps(main(), ensure_ascii=False))
