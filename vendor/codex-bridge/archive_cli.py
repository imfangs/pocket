#!/usr/bin/env python3
"""Archive saved Codex sessions with the official CLI and independent readback.

SQLite and rollout files are read-only here. Only the official Codex process
performs archive/unarchive writes. Receipts are private, resumable checkpoints.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time
import tomllib
import uuid


class ArchiveError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def identity(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value.lower():
            raise ValueError()
    except ValueError:
        raise ArchiveError("invalid_thread_id", "Use an exact thread UUID, not a title.") from None
    return value.lower()


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def checkpoint(receipt, out):
    receipt["counts"]["verified"] = sum(x.get("verified") is True for x in receipt["targets"])
    receipt["counts"]["changed"] = sum(x.get("changed") is True for x in receipt["targets"])
    if out:
        path = Path(out).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(receipt, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)


class Store:
    def __init__(self, home, sqlite_home=None):
        self.home = Path(home).expanduser().resolve(strict=True)
        config = self.home / "config.toml"
        configured = tomllib.loads(config.read_text()).get("sqlite_home") if config.is_file() else None
        self.sqlite_home = Path(sqlite_home or configured or os.environ.get("CODEX_SQLITE_HOME") or self.home).expanduser().resolve(strict=True)
        databases = list(self.sqlite_home.glob("state_*.sqlite"))
        if len(databases) != 1:
            raise ArchiveError("ambiguous_state_db", "Expected exactly one state_*.sqlite in the selected SQLite home.")
        self.database = databases[0]

    def connect(self):
        connection = sqlite3.connect(self.database.as_uri() + "?mode=ro", uri=True, timeout=5)
        connection.row_factory = sqlite3.Row
        return connection

    def descendants(self, thread_id):
        with closing(self.connect()) as connection:
            rows = connection.execute("""WITH RECURSIVE descendants(id) AS (
                SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id=?
                UNION SELECT e.child_thread_id FROM thread_spawn_edges e
                JOIN descendants d ON e.parent_thread_id=d.id
            ) SELECT id FROM descendants ORDER BY id""", (thread_id,)).fetchall()
        result = [identity(row[0]) for row in rows]
        if thread_id in result:
            raise ArchiveError("invalid_spawn_graph", "A thread is its own descendant.")
        return result

    def snapshot(self, thread_id):
        with closing(self.connect()) as connection:
            row = connection.execute("SELECT id, archived, archived_at, rollout_path, updated_at, history_mode FROM threads WHERE id=?", (thread_id,)).fetchone()
        if row is None:
            raise ArchiveError("thread_not_found", "The exact thread ID is absent from the selected database.")
        path = Path(row["rollout_path"]).resolve(strict=True)
        folder = self.home / ("archived_sessions" if row["archived"] else "sessions")
        if not path.is_relative_to(folder):
            raise ArchiveError("state_path_mismatch", "The rollout location does not match the recorded archive state.")
        first_stat = path.stat()
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            first = stream.readline(1024 * 1024)
            meta = json.loads(first)
            payload = meta.get("payload", {})
            if meta.get("type") != "session_meta" or payload.get("id") != thread_id:
                raise ArchiveError("identity_mismatch", "Rollout header does not match the exact requested ID.")
            # Subagent session_id identifies the root session; payload.id is this thread.
            digest.update(first)
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
            stream.seek(max(0, first_stat.st_size - 2 * 1024 * 1024))
            if stream.tell():
                stream.readline()
            terminal = None
            for line in stream:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                event_type = event.get("payload", {}).get("type")
                if event.get("type") == "event_msg" and event_type in {
                    "task_started", "task_complete", "turn_aborted", "user_message"
                }:
                    terminal = event_type
        final_stat = path.stat()
        if (first_stat.st_size, first_stat.st_mtime_ns) != (final_stat.st_size, final_stat.st_mtime_ns):
            raise ArchiveError("thread_changed", "The rollout changed while being inspected.")
        return {"thread_id": thread_id, "archived": bool(row["archived"]),
                "archived_at": row["archived_at"], "rollout_path": str(path),
                "history_mode": row["history_mode"], "updated_at": row["updated_at"],
                "rollout_sha256": digest.hexdigest(), "rollout_bytes": final_stat.st_size,
                "terminal_event": terminal}


def resolve_targets(args):
    selected = list(args.thread_id or [])
    excluded = set(args.exclude_thread_id or [])
    # Read-only inspection does not need the automatic write/controller guard.
    # Explicit exclusions and plan controllers still apply to every operation.
    current = os.environ.get("CODEX_THREAD_ID") if getattr(args, "operation", None) != "inspect" else None
    if current:
        excluded.add(current)
    if args.plan:
        plan = json.loads(Path(args.plan).read_text())
        if plan.get("controller_thread_id"):
            excluded.add(plan["controller_thread_id"])
        if "targets" in plan:
            selected.extend(row["thread_id"] for row in plan["targets"])
        else:
            selected.extend(plan["thread_ids"])
    selected = [identity(value) for value in selected]
    excluded = {identity(value) for value in excluded}
    if len(set(selected)) != len(selected):
        raise ArchiveError("duplicate_thread_id", "The input contains duplicate IDs.")
    current_was_selected = current and current.lower() in selected
    selected = [value for value in selected if value not in excluded]
    if not selected:
        if current_was_selected:
            raise ArchiveError("no_targets", "FBT default protection excludes the current CODEX_THREAD_ID; no unprotected exact thread IDs remain. This is a local wrapper policy, not a platform capability limitation.")
        raise ArchiveError("no_targets", "No unprotected exact thread IDs were selected.")
    return selected, excluded


def find_binary(value):
    candidates = [value] if value else ["/Applications/ChatGPT.app/Contents/Resources/codex", shutil.which("codex")]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    raise ArchiveError("codex_cli_missing", "Select an official Codex CLI that supports archive and unarchive.")


def execute(args):
    started = time.monotonic()
    # Use exactly the same canonical receipt destination for validation and writing.
    args.out = str(Path(args.out).expanduser().resolve()) if args.out else None
    # No receipt file may be written until every storage-root guard has passed.
    checkpoint_out = None
    output_in_home = bool(args.out and Path(args.out).resolve().is_relative_to(Path(args.codex_home).expanduser().resolve()))
    if output_in_home:
        checkpoint_out = None
    receipt = {"ok": False, "capability": "codex-threads", "operation": args.operation,
               "backend": "official-codex-cli", "dry_run": args.dry_run,
               "verification_scope": "persistent_state_and_rollout", "desktop_ui_verified": False,
               "started_at": utc_now(), "outputs": [],
               "warnings": [], "targets": [], "counts": {"requested": 0, "verified": 0, "changed": 0}}
    try:
        if output_in_home:
            receipt["outputs"] = []
            raise ArchiveError("receipt_inside_store", "Keep FBT receipts outside the Codex data directory.")
        if not 0 < args.timeout <= 300:
            raise ArchiveError("invalid_argument", "timeout must be between 0 and 300 seconds.")
        if args.operation == "set_thread_archived" and args.archived not in ("true", "false"):
            raise ArchiveError("invalid_argument", "set_thread_archived requires --archived true or false.")
        targets, excluded = resolve_targets(args)
        receipt["counts"]["requested"] = len(targets)
        receipt["excluded_thread_ids"] = sorted(excluded)
        store = Store(args.codex_home, args.sqlite_home)
        if args.out and Path(args.out).resolve().is_relative_to(store.sqlite_home):
            checkpoint_out = None
            receipt["outputs"] = []
            raise ArchiveError("receipt_inside_store", "Keep FBT receipts outside the Codex data directory.")
        checkpoint_out = args.out
        receipt["outputs"] = [checkpoint_out] if checkpoint_out else []
        binary = find_binary(args.codex_bin)
        receipt.update(codex_bin=binary, codex_home=str(store.home), state_db=str(store.database))
        desired = args.operation == "archive" if args.operation != "set_thread_archived" else args.archived == "true"
        if args.operation == "inspect":
            desired = None
        # Scope CODEX_HOME only to the official child process; never change the caller environment.
        child_env = dict(os.environ, CODEX_HOME=str(store.home))
        for thread_id in targets:
            item = {"thread_id": thread_id, "verified": False, "changed": False}
            receipt["targets"].append(item)
            try:
                before = store.snapshot(thread_id)
                item["before"] = before
                descendants = store.descendants(thread_id) if desired is not False else []
                if excluded.intersection(descendants):
                    raise ArchiveError("protected_descendant", "A protected thread belongs to this archive subtree.")
                children = [store.snapshot(value) for value in descendants]
                item["descendants"] = [{"thread_id": x["thread_id"], "before": x} for x in children]
                affected = [before, *children] if desired else [before]
                if desired is True:
                    for state in affected:
                        if not state["archived"] and state["terminal_event"] not in {"task_complete", "turn_aborted"}:
                            raise ArchiveError("active_or_unknown_thread", "A target or descendant has no final completed/interrupted lifecycle record.")
                if desired is None:
                    item["verified"] = True
                elif args.dry_run:
                    item.update(desired_archived=desired, verified=before["archived"] == desired)
                elif before["archived"] == desired:
                    if desired and any(not x["archived"] for x in children):
                        raise ArchiveError("partial_subtree", "Parent is archived but a descendant is not; inspect the subtree before proceeding.")
                    item.update(after=before, verified=True, verified_at=utc_now())
                    for child in item["descendants"]:
                        child.update(after=child["before"], verified=True, changed=False, verified_at=utc_now())
                else:
                    # Catch new activity since the preflight. Official ThreadStore also holds writer locks.
                    for state in affected:
                        if store.snapshot(state["thread_id"]) != state:
                            raise ArchiveError("thread_changed", "A target changed after the preflight.")
                    item.update(mutation_attempted=True, changed=None)
                    checkpoint(receipt, checkpoint_out)
                    operation = "archive" if desired else "unarchive"
                    result = subprocess.run([binary, operation, thread_id, "-c", "sqlite_home=" + json.dumps(str(store.sqlite_home))],
                                            cwd=store.home, env=child_env, capture_output=True, text=True, timeout=args.timeout)
                    item["cli_returncode"] = result.returncode
                    if result.returncode:
                        raise ArchiveError("official_cli_failed", "Official CLI returned a failure; inspect current state before retrying.")
                    for state, result_row in [(before, item), *zip(children, item["descendants"])]:
                        after = store.snapshot(state["thread_id"])
                        result_row["after"] = after
                        if after["archived"] != desired or after["rollout_sha256"] != state["rollout_sha256"]:
                            raise ArchiveError("verification_mismatch", "Archive state or rollout content failed independent readback.")
                        result_row.update(verified=True, changed=state["archived"] != desired, verified_at=utc_now())
                checkpoint(receipt, checkpoint_out)
            except Exception as error:
                item.update(code=getattr(error, "code", "archive_error"), error=str(error), verified=False)
                if item.get("mutation_attempted"):
                    item["retry_safe"] = False
                    try:
                        item["after"] = store.snapshot(thread_id)
                        if item["after"] == item.get("before"):
                            item["changed"] = False
                    except Exception:
                        item["readback_unavailable"] = True
                raise
        receipt["ok"] = True
    except Exception as error:
        receipt.update(code=getattr(error, "code", "archive_error"), error=str(error))
    receipt.update(finished_at=utc_now(), duration_ms=round((time.monotonic() - started) * 1000))
    checkpoint(receipt, checkpoint_out)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["inspect", "archive", "unarchive", "set_thread_archived"])
    parser.add_argument("--thread-id", action="append")
    parser.add_argument("--plan", help="JSON with targets[{thread_id}] or thread_ids; controller_thread_id is excluded")
    parser.add_argument("--exclude-thread-id", action="append")
    parser.add_argument("--archived", choices=["true", "false"])
    parser.add_argument("--codex-home", default=os.environ.get("CODEX_HOME") or str(Path.home() / ".codex"))
    parser.add_argument("--sqlite-home", help="Explicit SQLite directory; defaults to Codex config/env/home resolution")
    parser.add_argument("--codex-bin")
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--out", help="Atomic receipt/checkpoint outside Codex home")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    receipt = execute(args)
    print(json.dumps(receipt, ensure_ascii=False, indent=2) if args.json else
          f"{args.operation}: {'verified' if receipt['ok'] else receipt.get('code')} {receipt['counts']}")
    return 0 if receipt["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
