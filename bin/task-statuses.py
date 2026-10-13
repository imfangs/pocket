"""Bounded, read-only status observations from the original desktop owner."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import sqlite3
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bundled_cli import bundled_cli, desktop_app
_spec = importlib.util.spec_from_file_location("pocket_status_bridge", Path(__file__).with_name("desktop-bridge.py"))
_bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_bridge)
CONFIG = _bridge.CONFIG

MAX_INPUT_BYTES = 256 * 1024
MAX_IDS = 10000
MAX_CANDIDATES = 32
TAIL_BYTES = 256 * 1024
TOTAL_SECONDS = 4.7
PROBE_SECONDS = 1.15


class StatusCancelled(BaseException):
    """Cancellation must cross per-candidate error recovery without retrying."""


def now_ms():
    return int(time.time() * 1000)


def remaining(deadline):
    value = deadline - time.monotonic()
    if value <= 0:
        raise TimeoutError("status_budget_exhausted")
    return value


def verify_app():
    bundle = desktop_app(CONFIG["appPath"])
    app, info = bundle["path"], bundle["info"]
    return {"binary": str(bundled_cli(app)["executable"]),
            "main": str((app / "Contents/MacOS" / info["CFBundleExecutable"]).resolve())}


def app_process_ids(text, app):
    processes = {}
    for line in text.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            processes[int(parts[0])] = (int(parts[1]), parts[2])
    result = set()
    for pid, (parent, command) in processes.items():
        if command != app["binary"]:
            continue
        seen = {pid}
        for _ in range(8):
            if parent in seen or parent not in processes:
                break
            seen.add(parent)
            parent, ancestor = processes[parent]
            if ancestor == app["main"]:
                result.add(pid)
                break
    return result


def writable_rollouts(text, pids):
    paths, pid, access = set(), None, None
    for line in text.splitlines():
        if line.startswith("p"):
            pid = int(line[1:]) if line[1:].isdigit() else None
            access = None
        elif line.startswith("f"):
            access = None
        elif line.startswith("a"):
            access = line[1:]
        elif line.startswith("n") and pid in pids and access in ("w", "u"):
            paths.add(line[1:])
    return paths


def discover_candidates(home, allowed, deadline, app):
    processes = subprocess.run(["/bin/ps", "-ww", "-axo", "pid=,ppid=,comm="],
                               capture_output=True, text=True, timeout=min(1.5, remaining(deadline)), check=True)
    pids = app_process_ids(processes.stdout, app)
    if not pids:
        return {"available": False, "candidates": []}
    opened = subprocess.run(["/usr/sbin/lsof", "-nP", "-a", "-p", ",".join(map(str, sorted(pids))), "-F", "pfan"],
                            capture_output=True, text=True, timeout=min(1.5, remaining(deadline)))
    if opened.returncode not in (0, 1) or opened.returncode == 1 and not opened.stdout.strip():
        raise RuntimeError("open_files_unavailable")
    paths = writable_rollouts(opened.stdout, pids)
    db = sqlite3.connect((home / "state_5.sqlite").as_uri() + "?mode=ro", uri=True,
                         timeout=min(0.2, remaining(deadline)))
    try:
        db.execute("PRAGMA query_only=ON")
        columns = {row[1] for row in db.execute("PRAGMA table_info(threads)")}
        if not {"id", "rollout_path", "archived", "source", "thread_source", "agent_path"}.issubset(columns):
            raise ValueError("source_schema_changed")
        order = "updated_at_ms" if "updated_at_ms" in columns else "updated_at" if "updated_at" in columns else "id"
        rows = db.execute(f"SELECT id,rollout_path,thread_source,agent_path FROM threads "
                          f"WHERE archived=0 AND source IN ('vscode','cli','exec','app') ORDER BY {order} DESC")
        candidates = []
        for thread_id, value, source, agent_path in rows:
            if thread_id not in allowed or source == "subagent" or agent_path not in (None, "", "/root"):
                continue
            if not isinstance(value, str) or not value:
                continue
            path = Path(value)
            path = path if path.is_absolute() else home / path
            if str(path) not in paths:
                continue
            candidates.append({"threadId": thread_id, "path": str(path)})
        return {"available": True, "candidates": candidates}
    finally:
        db.close()


def recorded_state(text):
    state, current, context, pending_new_input = "unknown", None, None, False
    lines = text.splitlines()
    for line in lines:
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except (ValueError, UnicodeError):
            # A skipped record could be the start of a newer turn.
            return "unknown"
        if not isinstance(row, dict) or not isinstance(row.get("payload"), dict):
            continue
        payload, kind = row["payload"], row.get("type")
        if kind == "turn_context" and isinstance(payload.get("turn_id"), str):
            context = payload["turn_id"]
            if context != current:
                current, state, pending_new_input = context, "unknown", False
        event = payload.get("type") if kind == "event_msg" else None
        user_message = event == "user_message" or kind == "response_item" and payload.get("role") == "user"
        if user_message:
            pending_new_input = pending_new_input or state == "ended" or current is None
            state = "unknown"
        elif kind == "compacted" or event == "context_compaction":
            pending_new_input = pending_new_input or state == "ended"
            state = "unknown"
        elif event in ("task_started", "turn_started"):
            current = payload.get("turn_id") or context
            state, pending_new_input = "unconfirmed", False
        elif event in ("task_complete", "turn_complete", "turn_aborted"):
            turn = payload.get("turn_id") or context
            if pending_new_input or not isinstance(turn, str) or not turn:
                continue
            if current and turn != current:
                continue
            current, state = turn, "ended"
    return state


def read_recorded_state(home, thread_id, value):
    try:
        path = Path(value).resolve(strict=True)
        if not path.is_relative_to(home / "sessions"):
            return "unknown"
        with path.open("rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode):
                return "unknown"
            header = json.loads(stream.readline(65537))
            if header.get("type") != "session_meta" or header.get("payload", {}).get("id") != thread_id:
                return "unknown"
            offset = max(0, before.st_size - TAIL_BYTES)
            stream.seek(offset)
            text = stream.read(TAIL_BYTES)
            if offset:
                text = text.split(b"\n", 1)[1] if b"\n" in text else b""
            after = os.fstat(stream.fileno())
        attributes = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
        if attributes(before) != attributes(after) or attributes(after) != attributes(path.stat()):
            return "unknown"
        return recorded_state(text.decode("utf8", errors="strict"))
    except (OSError, ValueError, TypeError, AttributeError):
        return "unknown"


def native_status(state):
    runtime = state.get("threadRuntimeStatus")
    if not isinstance(runtime, dict):
        return "unknown"
    if runtime.get("type") == "idle":
        return "idle"
    if runtime.get("type") != "active" or state.get("resumeState") != "resumed":
        return "unknown"
    flags = runtime.get("activeFlags", [])
    if not isinstance(flags, list) or any(not isinstance(flag, str) for flag in flags):
        return "unknown"
    if "waitingOnApproval" in flags:
        return "waiting_approval"
    if "waitingOnUserInput" in flags:
        return "waiting_input"
    return "running"


class TaskStatusIPC(_bridge.NavigatorIPC):
    def __init__(self, path, deadline):
        self.deadline = deadline
        try:
            super().__init__(path)
            self.owner_lookup_timeout = min(0.8, remaining(deadline))
        except BaseException:
            if hasattr(self, "socket"):
                self.socket.close()
            raise

    def exact(self, size):
        result = bytearray()
        while len(result) < size:
            timeout = remaining(self.deadline)
            owner_deadline = getattr(self, "_owner_deadline", None)
            if owner_deadline is not None:
                timeout = min(timeout, remaining(owner_deadline))
            self.socket.settimeout(timeout)
            chunk = self.socket.recv(size - len(result))
            if not chunk:
                raise EOFError("app_disconnected")
            result.extend(chunk)
        return result

    def status(self, thread_id):
        response = self.request("thread-owner-discovery", {"hostId": "local", "conversationId": thread_id}, 1)
        owner = response.get("handledByClientId")
        if not isinstance(owner, str) or not owner:
            raise ValueError("missing_owner")
        self.set_following(thread_id, owner, True)
        try:
            while True:
                remaining(self.deadline)
                message = self.receive()
                # NavigatorIPC retains full snapshots for history. This helper does not.
                self.snapshots.clear()
                params = message.get("params", {})
                if message.get("method") == "client-status-changed" and params.get("clientId") == owner and params.get("status") == "disconnected":
                    raise EOFError("owner_disconnected")
                if message.get("type") != "broadcast" or message.get("method") != "thread-stream-state-changed":
                    continue
                if message.get("sourceClientId") != owner:
                    continue
                if params.get("hostId") != "local" or params.get("conversationId") != thread_id:
                    continue
                change = params.get("change", {})
                if change.get("type") != "snapshot":
                    continue
                state = change.get("conversationState")
                if not isinstance(state, dict) or state.get("id") != thread_id or state.get("hostId") != "local":
                    raise ValueError("snapshot_identity_mismatch")
                remaining(self.deadline)
                return native_status(state)
        finally:
            # Detach even after a read timeout; never keep an idle writer alive.
            try:
                self.socket.settimeout(0.05)
                self.set_following(thread_id, owner, False)
            except (OSError, TimeoutError):
                # Closing the connection also releases following. Cleanup must
                # not replace an in-flight cancellation with a recoverable error.
                pass
            finally:
                self.following.pop(thread_id, None)


def execute(data, *, discover=discover_candidates, verify=verify_app, client_factory=TaskStatusIPC,
            budget_seconds=TOTAL_SECONDS):
    result = {"available": False, "checkedAt": now_ms(), "states": [],
              "scannedCandidates": 0, "checkedCandidates": 0}
    deadline = time.monotonic() + budget_seconds
    try:
        if not isinstance(data, dict) or set(data) - {"codexHome", "threadIds", "excludedThreadIds"}:
            return result
        ids, excluded = data.get("threadIds"), data.get("excludedThreadIds", [])
        valid_ids = lambda values: isinstance(values, list) and len(values) <= MAX_IDS and all(
            isinstance(value, str) and 0 < len(value) <= 128 for value in values)
        if not valid_ids(ids) or not valid_ids(excluded) or not isinstance(data.get("codexHome"), str):
            return result
        home = Path(data["codexHome"])
        if not home.is_absolute():
            return result
        home = home.resolve(strict=True)
        app = verify()
        allowed = set(ids) - set(excluded)
        if not allowed:
            result["available"] = True
            return result
        discovery = discover(home, allowed, deadline, app)
        if not discovery["available"]:
            return result
        result["available"] = True
        seen, candidates = set(), []
        for candidate in discovery["candidates"]:
            thread_id = candidate["threadId"]
            if thread_id in allowed and thread_id not in seen:
                seen.add(thread_id)
                candidates.append(candidate)
                if len(candidates) == MAX_CANDIDATES:
                    break
        result["scannedCandidates"] = len(candidates)
        result["states"] = [{"threadId": row["threadId"], "status": "unknown", "checkedAt": now_ms()} for row in candidates]
        pending = []
        for candidate, observation in zip(candidates, result["states"]):
            if deadline - time.monotonic() <= 0.08:
                break
            if read_recorded_state(home, candidate["threadId"], candidate["path"]) == "ended":
                observation.update(status="idle", checkedAt=now_ms())
            else:
                pending.append((candidate, observation))
        # Cheap terminal evidence must not wait behind a slow owner lookup.
        for candidate, observation in pending:
            if deadline - time.monotonic() <= 0.08:
                break
            result["checkedCandidates"] += 1
            try:
                with client_factory(home / "ipc/ipc.sock", min(deadline, time.monotonic() + PROBE_SECONDS)) as client:
                    status = client.status(candidate["threadId"])
                observation.update(status=status, checkedAt=now_ms())
            except Exception:
                observation["checkedAt"] = now_ms()
        return result
    except StatusCancelled:
        result["available"] = False
        for observation in result["states"]:
            observation.update(status="unknown", checkedAt=now_ms())
        return result
    except Exception:
        return result
    finally:
        result["checkedAt"] = now_ms()


def interrupted(*_):
    raise StatusCancelled("status_observation_cancelled")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.setitimer(signal.ITIMER_REAL, 5.0)
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        result = execute(json.loads(raw)) if len(raw) <= MAX_INPUT_BYTES else execute(None)
    except (StatusCancelled, Exception):
        result = execute(None)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    print(json.dumps(result, separators=(",", ":")))
