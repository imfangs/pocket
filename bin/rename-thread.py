"""Rename one original Codex thread through an official, metadata-only process."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import stat
import sys
import time
import unicodedata

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bundled_cli import bundled_cli, verify_cli, BundledCLIError

from bridge_config import load_bridge_config

CONFIG = load_bridge_config()
FBT_METADATA = Path(CONFIG["ipcModuleDirectory"]).resolve().parents[1] / "codex-threads/scripts"
sys.path.insert(0, str(FBT_METADATA))
from archive_cli import ArchiveError, identity
from metadata_cli import StdioServer

ALLOWED_METHODS = frozenset({"initialize", "thread/name/set"})
PROTECTED_FIELDS = (
    "id", "cwd", "project_id", "archived", "archived_at", "rollout_path", "history_mode",
    "model_provider", "model", "reasoning_effort", "sandbox_policy", "approval_policy", "approval_mode",
    "approvals_reviewer", "source", "thread_source", "agent_path", "created_at",
    "parent_thread_id", "forked_from_id", "is_pinned", "thread_section_id", "section_position",
)
MAX_INPUT_BYTES = 8192
MAX_INDEX_BYTES = 32 * 1024 * 1024


def utf16_length(value):
    return len(value.encode("utf-16-le")) // 2


def display_title(name, title):
    value = (name or title or "未命名会话").split("\n", 1)[0]
    # Match the bounded title supplied by server/source.mjs, including JS slice.
    return value.encode("utf-16-le", errors="surrogatepass")[:440].decode("utf-16-le", errors="surrogatepass")


def parse_input(data):
    allowed = {"operation", "threadId", "codexHome", "name", "expectedName", "expectedFingerprint"}
    if not isinstance(data, dict) or set(data) - allowed or data.get("operation") not in {"inspect", "rename"}:
        raise ArchiveError("invalid_rename_request", "Invalid rename request")
    result = {"operation": data["operation"], "threadId": identity(data.get("threadId"))}
    home = data.get("codexHome", os.environ.get("CODEX_HOME") or str(Path.home() / ".codex"))
    if not isinstance(home, str) or not Path(home).is_absolute():
        raise ArchiveError("invalid_rename_request", "Codex home must be an absolute directory")
    result["codexHome"] = Path(home).resolve(strict=True)
    if not result["codexHome"].is_dir():
        raise ArchiveError("invalid_rename_request", "Codex home must be a directory")
    if result["operation"] == "inspect":
        if set(data) & {"name", "expectedName", "expectedFingerprint"}:
            raise ArchiveError("invalid_rename_request", "Inspection cannot carry a mutation")
        return result
    name = data.get("name")
    if (not isinstance(name, str) or not name.strip() or
            any(unicodedata.category(char) in {"Cc", "Zl", "Zp"} for char in name)):
        raise ArchiveError("invalid_thread_name", "A single-line name is required")
    try:
        if utf16_length(name.strip()) > 220:
            raise ValueError()
    except (UnicodeError, ValueError):
        raise ArchiveError("invalid_thread_name", "The name exceeds the supported length") from None
    result["name"] = name.strip()
    if "expectedName" in data:
        expected = data["expectedName"]
        if not isinstance(expected, str) or len(expected.encode("utf-16-le", errors="surrogatepass")) > 440:
            raise ArchiveError("invalid_rename_request", "Invalid expected name")
        result["expectedName"] = expected
    fingerprint = data.get("expectedFingerprint")
    if fingerprint is not None:
        if not isinstance(fingerprint, str) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
            raise ArchiveError("invalid_rename_request", "Invalid expected name fingerprint")
        result["expectedFingerprint"] = fingerprint
    return result


class RenameStore:
    def __init__(self, home):
        # Pocket imports this exact database. Do not silently switch to an ambient
        # CODEX_SQLITE_HOME or a different config.toml SQLite destination.
        self.home = self.sqlite_home = home
        self.database = home / "state_5.sqlite"

    def indexed_name(self, thread_id):
        index = self.home / "session_index.jsonl"
        if not index.exists():
            return None
        result = None
        with index.open("rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_INDEX_BYTES:
                raise ArchiveError("invalid_name_index", "The original name index exceeds the inspection bound")
            remaining = info.st_size
            while remaining:
                line = stream.readline(min(remaining, 65537))
                if not line:
                    break
                remaining -= len(line)
                if len(line) > 65536:
                    raise ArchiveError("invalid_name_index", "An original name index entry exceeds the inspection bound")
                try:
                    item = json.loads(line)
                except (ValueError, UnicodeError):
                    continue
                if isinstance(item, dict) and item.get("id") == thread_id and isinstance(item.get("thread_name"), str):
                    result = item["thread_name"]
        return result

    def snapshot(self, thread_id):
        with closing(sqlite3.connect(self.database.as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA query_only = ON")
            row = db.execute("SELECT * FROM threads WHERE id=?", (thread_id,)).fetchone()
        if row is None:
            raise ArchiveError("thread_not_found", "The exact original thread is absent")
        row = dict(row)
        if not {"id", "title", "name", "cwd", "archived", "rollout_path", "history_mode"} <= row.keys():
            raise ArchiveError("source_schema_changed", "The original thread schema has changed")
        if row["history_mode"] not in {"legacy", "paginated"}:
            raise ArchiveError("unsupported_history_mode", "The history mode is not verified")
        path = Path(row["rollout_path"])
        path = (path if path.is_absolute() else self.home / path).resolve(strict=True)
        folder = self.home / ("archived_sessions" if row["archived"] else "sessions")
        if not path.is_relative_to(folder):
            raise ArchiveError("state_path_mismatch", "The source location and archive state differ")
        with path.open("rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ArchiveError("invalid_rollout", "The original history is not a regular file")
            header = stream.readline(1024 * 1024 + 1)
        if len(header) > 1024 * 1024:
            raise ArchiveError("invalid_rollout", "The original history header exceeds the bound")
        first = json.loads(header)
        if first.get("type") != "session_meta" or first.get("payload", {}).get("id") != thread_id:
            raise ArchiveError("identity_mismatch", "The original history identity does not match")
        protected = {key: row.get(key) for key in PROTECTED_FIELDS}
        protected["headerSha256"] = hashlib.sha256(header).hexdigest()
        indexed_name = self.indexed_name(thread_id) if row["history_mode"] == "legacy" else None
        names = {key: row.get(key) for key in ("name", "title", "history_mode")}
        names["indexedName"] = indexed_name
        fingerprint = hashlib.sha256(json.dumps(names, sort_keys=True, ensure_ascii=True).encode()).hexdigest()
        return {"threadId": thread_id, "name": row["name"], "rawTitle": row["title"],
                "title": display_title(row["name"], row["title"]), "archived": bool(row["archived"]),
                "nameFingerprint": fingerprint, "historyMode": row["history_mode"], "indexedName": indexed_name,
                "protected": protected}


class RenameServer(StdioServer):
    def __init__(self, binary, store):
        super().__init__(str(binary), store, timeout=15, experimental=False)
        self.mutation_attempted = False
        self.deadline = time.monotonic() + 25

    def call(self, method, params):
        if method not in ALLOWED_METHODS:
            raise ArchiveError("rpc_not_allowed", "Rename accepts no execution or other metadata operations")
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise ArchiveError("rpc_timeout", "The metadata process exhausted its total request budget")
        self.timeout = min(15, remaining)
        if method == "thread/name/set":
            self.mutation_attempted = True
            print("POCKET_BRIDGE_PHASE_V1 dispatch", file=sys.stderr, flush=True)
        return super().call(method, params)


def binary_for(store):
    try:
        binary = bundled_cli(CONFIG["appPath"])["entrypoint"]
        verify_cli(binary, store.home, store.sqlite_home)
    except BundledCLIError as error:
        raise ArchiveError(error.code, "The official CLI behavior contract is unavailable") from error
    return binary


def desired(state, name):
    # Legacy names are stored in title; paginated histories have a separate name.
    if state["historyMode"] == "legacy":
        return state["rawTitle"] == name and state["indexedName"] == name
    return state["name"] == name


def receipt(state, status, *, verified=False, code=None, server=None):
    result = {"status": status, "verified": verified,
              "processStopped": server is None or server.process is None or server.stopped,
              "mutationAttempted": bool(server and server.mutation_attempted),
              "rpcMethods": server.methods if server else [], "modelTurnsStarted": 0}
    if state:
        result.update({key: state[key] for key in ("threadId", "title", "archived", "nameFingerprint")})
        result["name"] = None if state["name"] is None else display_title(state["name"], None)
    if code:
        result["code"] = code
    return result


def conflict(state, data):
    return (("expectedName" in data and data["expectedName"] != state["title"]) or
            ("expectedFingerprint" in data and data["expectedFingerprint"] != state["nameFingerprint"]))


def execute(raw, *, server_factory=RenameServer, binary_resolver=binary_for):
    before = current = server = None
    try:
        data = parse_input(raw)
        store = RenameStore(data["codexHome"])
        before = current = store.snapshot(data["threadId"])
        if data["operation"] == "inspect":
            result = receipt(before, "unchanged", verified=True)
            try:
                if before["archived"]:
                    raise ArchiveError("archived_thread", "Archived threads cannot be renamed")
                binary_resolver(store)
                result["canRename"] = True
            except Exception as error:
                result.update(canRename=False, code=getattr(error, "code", "rename_unavailable"))
            return result
        if before["archived"]:
            return receipt(before, "unavailable", code="archived_thread")
        if desired(before, data["name"]):
            return receipt(before, "unchanged", verified=True)
        if conflict(before, data):
            return receipt(before, "changed", code="name_changed")
        binary = binary_resolver(store)
        server = server_factory(binary, store)
        error_code = None
        try:
            with server:
                current = store.snapshot(data["threadId"])
                # Recheck after process startup, immediately before the one write.
                if current["protected"] != before["protected"] or current["nameFingerprint"] != before["nameFingerprint"]:
                    error_code = "thread_changed"
                else:
                    server.call("thread/name/set", {"threadId": data["threadId"], "name": data["name"]})
        except Exception as error:
            error_code = getattr(error, "code", "rename_unavailable")
        if not server.mutation_attempted:
            return receipt(current, "changed" if error_code == "thread_changed" else "unavailable",
                           code=error_code, server=server)
        # The short process has stopped. Independent persisted state, rather than
        # an RPC acknowledgement or in-memory title, resolves a lost response.
        current = store.snapshot(data["threadId"])
        if current["protected"] == before["protected"] and desired(current, data["name"]) and server.stopped:
            return receipt(current, "renamed", verified=True, server=server)
        code = "thread_metadata_changed" if current["protected"] != before["protected"] else "rename_outcome_unknown"
        return receipt(current, "unknown", code=code, server=server)
    except Exception as error:
        attempted = bool(server and server.mutation_attempted)
        return receipt(current, "unknown" if attempted else "unavailable",
                       code=getattr(error, "code", "rename_unavailable"), server=server)


def interrupted(*_):
    # Raising through the transport context closes, terminates and reaps the
    # official child. A supervisor timeout must not leave an unseen writer.
    raise InterruptedError("rename_interrupted")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise ArchiveError("invalid_rename_request", "Request exceeds the input bound")
        print("POCKET_BRIDGE_PHASE_V1 preflight", file=sys.stderr, flush=True)
        result = execute(json.loads(raw))
    except Exception as error:
        result = receipt(None, "unavailable", code=getattr(error, "code", "invalid_rename_request"))
    print(json.dumps(result, ensure_ascii=True))
