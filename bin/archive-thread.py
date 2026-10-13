"""Archive through the official CLI after read-only lifecycle and writer checks."""
from contextlib import closing
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bundled_cli import bundled_cli, desktop_app, verify_cli, BundledCLIError

CONFIG = json.loads((Path(__file__).resolve().parent.parent / "config/desktop-bridge.json").read_text())
FBT_ARCHIVE = Path(CONFIG["ipcModuleDirectory"]).resolve().parents[1] / "codex-threads/scripts"
sys.path.insert(0, str(FBT_ARCHIVE))
from archive_cli import ArchiveError, Store, identity

TAIL_BYTES = 2 * 1024 * 1024
MAX_DESCENDANTS = 500


def lifecycle(text):
    state, current, context = "unknown", None, None
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except (ValueError, UnicodeError):
            if index == len(lines) - 1:
                return "unknown"
            continue
        payload = record.get("payload", {})
        if not isinstance(payload, dict):
            continue
        if record.get("type") == "turn_context" and payload.get("turn_id"):
            context = payload["turn_id"]
        if record.get("type") != "event_msg":
            continue
        kind = payload.get("type")
        if kind in ("task_started", "turn_started"):
            state, current = "active", payload.get("turn_id")
        elif kind == "user_message":
            state = "unknown"
        elif kind in ("task_complete", "turn_complete", "turn_aborted"):
            turn = payload.get("turn_id") or context
            if current and turn and turn != current:
                continue
            state, current = "ended", None
    return state


class ArchiveStore(Store):
    def snapshot(self, thread_id):
        with closing(self.connect()) as db:
            row = db.execute("SELECT id,archived,rollout_path,history_mode,tokens_used,has_user_event FROM threads WHERE id=?", (thread_id,)).fetchone()
        if row is None:
            raise ArchiveError("thread_not_found", "Requested thread does not exist")
        path = Path(row["rollout_path"])
        path = (path if path.is_absolute() else self.home / path).resolve(strict=True)
        folder = self.home / ("archived_sessions" if row["archived"] else "sessions")
        if not path.is_relative_to(folder):
            raise ArchiveError("state_path_mismatch", "Recorded archive state and source path differ")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise ArchiveError("invalid_rollout", "Expected a regular rollout file")
            first = stream.readline(1024 * 1024)
            meta = json.loads(first)
            if meta.get("type") != "session_meta" or meta.get("payload", {}).get("id") != thread_id:
                raise ArchiveError("identity_mismatch", "Rollout header does not match requested thread")
            digest.update(first)
            meta_only = True
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
                if chunk.strip():
                    meta_only = False
            offset = max(0, before.st_size - TAIL_BYTES)
            stream.seek(offset)
            if offset:
                stream.readline()
            ended = lifecycle(stream.read(TAIL_BYTES).decode("utf8", errors="replace"))
            after = os.fstat(stream.fileno())
        attributes = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns)
        if attributes(before) != attributes(after) or attributes(after) != attributes(path.stat()):
            raise ArchiveError("thread_changed", "Rollout changed while inspected")
        with closing(self.connect()) as db:
            final_row = db.execute("SELECT id,archived,rollout_path,history_mode,tokens_used,has_user_event FROM threads WHERE id=?", (thread_id,)).fetchone()
        if final_row is None or tuple(final_row) != tuple(row):
            raise ArchiveError("thread_changed", "Thread metadata changed while inspected")
        empty = meta_only and row["tokens_used"] == 0 and row["has_user_event"] == 0
        return {"id": thread_id, "archived": bool(row["archived"]), "historyMode": row["history_mode"],
                "rolloutSha256": digest.hexdigest(), "rolloutBytes": after.st_size,
                "lifecycle": "empty" if empty else ended}


def writer_busy(store, thread_id):
    path = store.home / "thread-writer-locks" / (thread_id + ".lock")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return False
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ArchiveError("unsafe_writer_lock", "Writer lock is not a regular file")
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        else:
            fcntl.flock(fd, fcntl.LOCK_UN)
            return False
    finally:
        os.close(fd)


def read_tree(store, root_id, root_only=False):
    descendants = [] if root_only else store.descendants(root_id)
    if len(descendants) > MAX_DESCENDANTS:
        raise ArchiveError("scope_too_large", "Archive subtree exceeds this bridge's bound")
    ids = sorted([root_id, *descendants])
    rows = [store.snapshot(value) for value in ids]
    if not root_only and store.descendants(root_id) != descendants:
        raise ArchiveError("thread_changed", "Archive subtree changed while inspected")
    fields = ("id", "archived", "historyMode", "rolloutSha256", "rolloutBytes")
    document = {"rootId": root_id, "threads": [{key: row[key] for key in fields} for row in rows]}
    fingerprint = hashlib.sha256(json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    root_document = {**document, "threads": [row for row in document["threads"] if row["id"] == root_id]}
    root_fingerprint = hashlib.sha256(json.dumps(root_document, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"rows": rows, "fingerprint": fingerprint, "rootFingerprint": root_fingerprint, "threadIds": ids,
            "descendantCount": len(descendants), "rootArchived": next(row["archived"] for row in rows if row["id"] == root_id)}


def receipt(tree, status, code=None, verified=False):
    return {"status": status, "fingerprint": tree["fingerprint"], "rootFingerprint": tree["rootFingerprint"], "threadIds": tree["threadIds"],
            "descendantCount": tree["descendantCount"], "rootArchived": tree["rootArchived"],
            "verified": verified, **({"code": code} if code else {})}


def readiness(store, tree, root_only=None):
    rows = tree["rows"] if root_only is None else [row for row in tree["rows"] if row["id"] == root_only]
    locks = {row["id"]: writer_busy(store, row["id"]) for row in rows}
    if any(row["lifecycle"] not in ("ended", "empty") and (not row["archived"] or locks[row["id"]]) for row in rows):
        return "blocked", "active_or_unknown_thread"
    if any(locks.values()):
        return "waiting", "writer_busy"
    return "ready", None


def official(binary, operation, root_id, store):
    env = {**os.environ, "CODEX_HOME": str(store.home), "CODEX_SQLITE_HOME": str(store.sqlite_home)}
    env.pop("CODEX_THREAD_ID", None)
    try:
        verify_cli(binary, store.home, store.sqlite_home)
    except BundledCLIError as error:
        raise ArchiveError(error.code, "The official CLI behavior contract is unavailable") from error
    print("POCKET_BRIDGE_PHASE_V1 dispatch", file=sys.stderr, flush=True)
    return subprocess.run([str(binary), "archive" if operation == "archive" else "unarchive", root_id,
                           "-c", "sqlite_home=" + json.dumps(str(store.sqlite_home))],
                          cwd=store.home, env=env, capture_output=True, text=True, timeout=30)


def execute(data, run_cli=official):
    tree = None
    attempted = False
    try:
        if not isinstance(data, dict) or set(data) - {"operation", "threadId", "codexHome", "expectedFingerprint", "rootOnly"}:
            raise ArchiveError("invalid_request", "Invalid archive request")
        operation = data.get("operation")
        if operation not in ("inspect", "archive", "restore"):
            raise ArchiveError("invalid_request", "Invalid archive operation")
        if "rootOnly" in data and (operation != "inspect" or data["rootOnly"] is not True):
            raise ArchiveError("invalid_request", "Only inspections accept rootOnly=true")
        root_only = operation == "restore" or data.get("rootOnly") is True
        root_id = identity(data.get("threadId"))
        expected = data.get("expectedFingerprint")
        if expected is not None and (not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected)):
            raise ArchiveError("invalid_request", "Invalid archive fingerprint")
        desktop_app(CONFIG["appPath"])
        store = ArchiveStore(data["codexHome"])
        tree = read_tree(store, root_id, root_only)
        if operation == "restore" and not tree["rootArchived"]:
            return receipt(tree, "restored", verified=True)
        if operation != "restore" and all(row["archived"] for row in tree["rows"]):
            status, code = readiness(store, tree)
            if status != "ready":
                return receipt(tree, status, code)
            return receipt(tree, "archived", verified=True)
        if operation != "restore" and tree["rootArchived"]:
            return receipt(tree, "blocked", "partial_subtree")
        if operation != "inspect" and expected is not None and expected != tree["fingerprint"]:
            return receipt(tree, "changed", "fingerprint_changed")
        if operation == "archive" and expected is None:
            return receipt(tree, "blocked", "fingerprint_required")
        status, code = readiness(store, tree, root_id if operation == "restore" else None)
        if status != "ready" or operation == "inspect":
            return receipt(tree, status, code)
        fresh = read_tree(store, root_id, root_only)
        if fresh["fingerprint"] != tree["fingerprint"]:
            return receipt(fresh, "changed", "fingerprint_changed")
        status, code = readiness(store, fresh, root_id if operation == "restore" else None)
        if status != "ready":
            return receipt(fresh, status, code)
        binary = bundled_cli(CONFIG["appPath"])["entrypoint"]
        attempted = True
        result = None
        try:
            result = run_cli(binary, operation, root_id, store)
        except ArchiveError as error:
            if error.code in ("cli_version_changed", "bundled_cli_unavailable"):
                return receipt(tree, "unavailable", error.code)
        except Exception:
            pass
        after = read_tree(store, root_id, root_only)
        unchanged_contents = tree["threadIds"] == after["threadIds"] and all(
            before["rolloutSha256"] == final["rolloutSha256"] for before, final in zip(tree["rows"], after["rows"])
        )
        achieved = all(row["archived"] for row in after["rows"]) if operation == "archive" else not after["rootArchived"]
        if achieved and unchanged_contents:
            return receipt(after, "archived" if operation == "archive" else "restored", verified=True)
        if after["fingerprint"] == tree["fingerprint"] and result is not None and result.returncode:
            status, code = readiness(store, after, root_id if operation == "restore" else None)
            if status == "waiting" or "already has an active writer" in result.stderr:
                return receipt(after, "waiting", "writer_busy")
        return receipt(after, "unknown", "archive_outcome_unknown" if operation == "archive" else "restore_outcome_unknown")
    except Exception as error:
        code = getattr(error, "code", "archive_unavailable")
        status = "unknown" if attempted else "changed" if code == "thread_changed" else "unavailable"
        return receipt(tree, status, code) if tree else {"status": status, "code": code, "verified": False}


def interrupted(*_):
    # Raising during subprocess.run makes its cleanup kill and reap the CLI.
    # A supervisor timeout must not leave an unobserved archive child running.
    raise InterruptedError("archive_interrupted")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    try:
        raw = sys.stdin.buffer.read(8193)
        print("POCKET_BRIDGE_PHASE_V1 preflight", file=sys.stderr, flush=True)
        result = execute(json.loads(raw)) if len(raw) <= 8192 else {"status": "unavailable", "code": "invalid_request"}
    except Exception:
        result = {"status": "unavailable", "code": "invalid_request"}
    print(json.dumps(result))
