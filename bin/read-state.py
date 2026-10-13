"""Protocol-validated mark-read broadcast; original Codex files are read-only here."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import uuid
from bundled_cli import desktop_app, BundledCLIError

CONFIG = json.loads((Path(__file__).resolve().parent.parent / "config/desktop-bridge.json").read_text())
sys.path.insert(0, CONFIG["ipcModuleDirectory"])
from app_ipc import AppIPC
from contracts import CompatibilityError


class ReadStateIPC(AppIPC):
    def request(self, method, params, version, owner=None):
        if method == "initialize":
            params = {**params, "clientType": "codex-navigator"}
        return super().request(method, params, version, owner)


class ReadStateError(Exception):
    def __init__(self, code, status="unavailable"):
        self.code = code
        self.status = status


def digest(parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def snapshot(codex_home, thread_id):
    home = Path(codex_home).resolve(strict=True)
    auth = json.loads((home / "auth.json").read_text())
    if auth.get("auth_mode") != "apikey":
        raise ReadStateError("unsupported_auth_mode")
    identity_key = digest(["execution-storage", "apikey"])
    host_key = "local:" + digest(["local", "local", None])
    global_state = json.loads((home / ".codex-global-state.json").read_text())
    state = global_state.get("electron-thread-read-state-v1")
    if not isinstance(state, dict) or state.get("version") != 1 or not isinstance(state.get("unreadByIdentity"), dict):
        raise ReadStateError("read_state_unavailable")
    identity = state["unreadByIdentity"].get(identity_key, {})
    if not isinstance(identity, dict):
        raise ReadStateError("read_state_unavailable")
    unread = identity.get(host_key, [])
    if not isinstance(unread, list) or any(not isinstance(value, str) or not value for value in unread):
        raise ReadStateError("read_state_unavailable")
    with closing(sqlite3.connect((home / "state_5.sqlite").as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
        row = db.execute("SELECT rollout_path FROM threads WHERE id=?", (thread_id,)).fetchone()
    if row is None or not row[0]:
        raise ReadStateError("history_unavailable")
    path = Path(row[0])
    path = (path if path.is_absolute() else home / path).resolve(strict=True)
    if not any(path.is_relative_to(home / directory) for directory in ("sessions", "archived_sessions")):
        raise ReadStateError("history_identity_mismatch")
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        meta = json.loads(stream.readline(65536))
        if meta.get("type") != "session_meta" or meta.get("payload", {}).get("id") != thread_id:
            raise ReadStateError("history_identity_mismatch")
        after = os.fstat(stream.fileno())
    fields = lambda value: [str(value.st_dev), str(value.st_ino), str(value.st_size), str(value.st_mtime_ns)]
    if fields(before) != fields(after):
        raise ReadStateError("observation_changed", "stale")
    return {"sourceVersion": digest(fields(after)), "identityKey": identity_key,
            "executionHostKey": host_key, "unread": thread_id in unread}


def matches(expected, actual):
    return all(expected[key] == actual[key] for key in ("sourceVersion", "identityKey", "executionHostKey"))


def main():
    dispatched = False
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise ReadStateError("invalid_read_request")
        data = json.loads(raw)
        if not isinstance(data, dict) or set(data) != {"operation", "threadId", "requestId", "codexHome", "expected"} or data["operation"] != "mark-read":
            raise ReadStateError("invalid_read_request")
        thread_id = str(uuid.UUID(data["threadId"]))
        uuid.UUID(data["requestId"])
        expected = data["expected"]
        if not isinstance(expected, dict) or set(expected) != {"sourceVersion", "identityKey", "executionHostKey"} or any(
            not isinstance(expected[key], str) or not re.fullmatch(r"[a-f0-9]{64}" if key != "executionHostKey" else r"local:[a-f0-9]{64}", expected[key])
            for key in expected
        ):
            raise ReadStateError("invalid_read_request")
        print("POCKET_BRIDGE_PHASE_V1 preflight", file=sys.stderr, flush=True)
        desktop_app(CONFIG["appPath"])
        current = snapshot(data["codexHome"], thread_id)
        if not matches(expected, current):
            raise ReadStateError("observation_changed", "stale")
        if not current["unread"]:
            return {"status": "read"}
        with ReadStateIPC(Path(data["codexHome"]) / "ipc/ipc.sock") as client:
            current = snapshot(data["codexHome"], thread_id)
            if not matches(expected, current):
                raise ReadStateError("observation_changed", "stale")
            if not current["unread"]:
                return {"status": "read"}
            # The original main process validates this candidate against its live
            # identity and execution host. There is no per-thread revision/CAS.
            dispatched = True
            print("POCKET_BRIDGE_PHASE_V1 dispatch", file=sys.stderr, flush=True)
            client.send({"type": "broadcast", "method": "thread-read-state-changed", "version": 3,
                         "sourceClientId": client.client_id,
                         "params": {"hostId": "local", "conversationId": thread_id, "hasUnreadTurn": False,
                                    "context": {"identity": {"kind": "execution-storage", "authMode": "apikey"},
                                                "executionHostKey": current["executionHostKey"]}}})
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                after = snapshot(data["codexHome"], thread_id)
                if not matches(expected, after):
                    return {"status": "unknown", "code": "observation_changed_after_write"}
                if not after["unread"]:
                    return {"status": "read"}
                time.sleep(0.05)
            return {"status": "unknown", "code": "readback_unconfirmed"}
    except (BundledCLIError, CompatibilityError) as error:
        return {"status": "unknown" if dispatched else "unavailable",
                "code": "read_outcome_unknown" if dispatched else
                        error.code if isinstance(error, BundledCLIError) else "desktop_protocol_incompatible"}
    except ReadStateError as error:
        return {"status": "unknown" if dispatched else error.status, "code": "read_outcome_unknown" if dispatched else error.code}
    except Exception:
        return {"status": "unknown" if dispatched else "unavailable", "code": "read_outcome_unknown" if dispatched else "read_state_unavailable"}


if __name__ == "__main__":
    print(json.dumps(main()))
