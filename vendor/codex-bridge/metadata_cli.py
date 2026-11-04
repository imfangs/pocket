#!/usr/bin/env python3
"""Change Codex names and project membership through a short official stdio server.

Only the official process writes Codex data. FBT reads SQLite and rollout files
independently, keeps private receipts outside both storage roots, and never
starts a model turn, daemon, private IPC connection, or arbitrary RPC.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import time

from archive_cli import ArchiveError, Store, checkpoint, find_binary, identity, utc_now


ALLOWED_METHODS = frozenset({"initialize", "thread/name/set", "project/create",
                             "project/read", "thread/metadata/update"})


class StdioServer:
    """Private allowlisted transport; its lifetime is one CLI invocation."""

    def __init__(self, binary, store, timeout, experimental):
        self.binary, self.store = binary, store
        self.timeout, self.experimental = timeout, experimental
        self.process = None
        self.buffer, self.sequence, self.methods = b"", 0, []
        self.stopped = False

    def __enter__(self):
        child_env = dict(os.environ, CODEX_HOME=str(self.store.home),
                         CODEX_SQLITE_HOME=str(self.store.sqlite_home))
        child_env.pop("CODEX_THREAD_ID", None)
        self.process = subprocess.Popen(
            [self.binary, "app-server", "--stdio", "-c",
             "sqlite_home=" + json.dumps(str(self.store.sqlite_home))],
            cwd=self.store.home, env=child_env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        try:
            result = self.call("initialize", {
                "clientInfo": {"name": "fbt_codex_metadata", "version": "0.1.0"},
                "capabilities": {"experimentalApi": self.experimental},
            })
            if Path(result.get("codexHome", "")).resolve() != self.store.home:
                raise ArchiveError("server_home_mismatch", "Official server reported a different Codex home.")
            self.process.stdin.write(b'{"method":"initialized"}\n')
            self.process.stdin.flush()
            return self
        except BaseException:
            self.close()
            raise

    def call(self, method, params):
        if method not in ALLOWED_METHODS:
            raise ArchiveError("rpc_not_allowed", "This transport only accepts the metadata operation allowlist.")
        self.sequence += 1
        request_id = self.sequence
        self.methods.append(method)
        self.process.stdin.write((json.dumps({"id": request_id, "method": method,
                                              "params": params}) + "\n").encode())
        self.process.stdin.flush()
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            if b"\n" not in self.buffer:
                ready, _, _ = select.select([self.process.stdout], [], [],
                                            max(0, deadline - time.monotonic()))
                if not ready:
                    break
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    raise ArchiveError("server_disconnected", "Official stdio server closed before its response.")
                self.buffer += chunk
                if len(self.buffer) > 8 * 1024 * 1024:
                    raise ArchiveError("rpc_response_too_large", "Official server exceeded the bounded response size.")
                continue
            line, self.buffer = self.buffer.split(b"\n", 1)
            response = json.loads(line)
            if "method" in response and "id" in response:
                raise ArchiveError("unexpected_server_request", "Metadata operations must not request tools or approvals.")
            if response.get("id") != request_id:
                continue
            if "error" in response:
                error = response["error"]
                raise ArchiveError("official_rpc_failed", f"{method}: {str(error.get('message', 'RPC failed'))[:500]}")
            if "result" not in response:
                raise ArchiveError("invalid_rpc_response", "Official server response has no result.")
            return response["result"]
        raise ArchiveError("rpc_timeout", "Official RPC timed out; inspect persisted state before retrying.")

    def close(self):
        if self.process is None:
            return
        if self.process.stdin:
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
        if self.process.stdout:
            self.process.stdout.close()
        self.stopped = self.process.poll() is not None

    def __exit__(self, *exc):
        self.close()


class MetadataStore(Store):
    def thread_snapshot(self, thread_id):
        result = self.snapshot(thread_id)
        with closing(self.connect()) as database:
            row = database.execute(
                "SELECT name,title,project_id,cwd FROM threads WHERE id=?", (thread_id,)
            ).fetchone()
        result.update(dict(row))
        if result["history_mode"] == "legacy":
            result["indexed_name"] = self.indexed_name(thread_id)
            result["name_storage"] = "threads.title + session_index.thread_name"
        elif result["history_mode"] == "paginated":
            result["name_storage"] = "threads.name"
        else:
            raise ArchiveError("unsupported_history_mode", "The thread uses an unverified history mode.")
        return result

    def indexed_name(self, thread_id):
        index = self.home / "session_index.jsonl"
        if not index.exists():
            return None
        result = None
        with index.open() as stream:
            for line in stream:
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if item.get("id") == thread_id and isinstance(item.get("thread_name"), str):
                    result = item["thread_name"]
        return result

    def project(self, project_id):
        with closing(self.connect()) as database:
            row = database.execute("SELECT id,name FROM projects WHERE id=?", (project_id,)).fetchone()
            if row is None:
                return None
            roots = database.execute(
                "SELECT path FROM project_roots WHERE project_id=? ORDER BY position", (project_id,)
            ).fetchall()
        return {"id": row["id"], "name": row["name"], "roots": [row["path"] for row in roots]}

    def project_for_key(self, key):
        with closing(self.connect()) as database:
            row = database.execute("SELECT project_id FROM project_idempotency_keys WHERE key=?", (key,)).fetchone()
        return self.project(row[0]) if row else None


def name_value(value):
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise ArchiveError("invalid_name", "Provide a nonempty name without NUL characters.")
    return value.strip()


def same_content(before, after):
    return all(before[key] == after[key] for key in (
        "thread_id", "cwd", "archived", "archived_at", "rollout_path", "history_mode",
        "rollout_sha256", "rollout_bytes",
    ))


def desired_name(state, wanted):
    if state["history_mode"] == "legacy":
        return state["title"] == wanted and state["indexed_name"] == wanted
    return state["name"] == wanted


def execute(args):
    start = time.monotonic()
    receipt = {"ok": False, "capability": "codex-threads", "operation": args.operation,
               "backend": "official-app-server-stdio", "dry_run": args.dry_run,
               "started_at": utc_now(), "outputs": [], "warnings": [], "targets": [],
               "counts": {"requested": 1, "verified": 0, "changed": 0},
               "model_turns_started": 0, "rpc_methods": [], "server_started": False}
    output = None
    server = None
    store = None
    item = {"verified": False, "changed": False}
    receipt["targets"].append(item)
    try:
        home = Path(args.codex_home).expanduser().resolve()
        wanted_output = Path(args.out).expanduser().resolve() if args.out else None
        if wanted_output and wanted_output.is_relative_to(home):
            raise ArchiveError("receipt_inside_store", "Keep receipts outside both Codex and SQLite homes.")
        if not 0 < args.timeout <= 300:
            raise ArchiveError("invalid_argument", "timeout must be between 0 and 300 seconds.")
        store = MetadataStore(home, args.sqlite_home)
        if wanted_output and wanted_output.is_relative_to(store.sqlite_home):
            raise ArchiveError("receipt_inside_store", "Keep receipts outside both Codex and SQLite homes.")
        output = str(wanted_output) if wanted_output else None
        receipt["outputs"] = [output] if output else []
        binary = find_binary(args.codex_bin)
        receipt.update(codex_bin=binary, codex_home=str(store.home), state_db=str(store.database))
        creating = args.operation == "project-create"
        if creating:
            if args.thread_id or args.project_id or args.clear_project:
                raise ArchiveError("invalid_argument", "project-create does not accept thread-id or project assignment options.")
            wanted_name = name_value(args.name)
            key = identity(args.idempotency_key)
            if not args.project_root:
                raise ArchiveError("invalid_argument", "project-create requires at least one --project-root.")
            roots = []
            for value in args.project_root:
                path = Path(value).expanduser()
                if not path.is_absolute() or not path.is_dir():
                    raise ArchiveError("invalid_project_root", "Project roots must be existing absolute directories.")
                roots.append(str(path.resolve()))
            if len(set(roots)) != len(roots):
                raise ArchiveError("duplicate_project_root", "Project roots must be distinct.")
            before = store.project_for_key(key)
            desired = {"name": wanted_name, "roots": roots}
            if before and any(before[k] != v for k, v in desired.items()):
                raise ArchiveError("idempotency_conflict", "This idempotency key already identifies a different project request.")
            item.update(before=before, desired=desired, idempotency_key=key)
            already = before is not None
            method = "project/create"
            params = {"name": wanted_name, "roots": [{"path": p} for p in roots], "idempotencyKey": key}
        else:
            if args.project_root or args.idempotency_key:
                raise ArchiveError("invalid_argument", "project-root and idempotency-key apply only to project-create.")
            thread_id = identity(args.thread_id)
            before = store.thread_snapshot(thread_id)
            item.update(thread_id=thread_id, before=before)
            if before["archived"]:
                raise ArchiveError("archived_thread", "Restore this exact thread before changing its metadata.")
            if before["terminal_event"] not in {"task_complete", "turn_aborted"}:
                raise ArchiveError("active_or_unknown_thread", "The target has no completed/interrupted lifecycle record.")
            if args.operation == "rename":
                if args.project_id or args.clear_project:
                    raise ArchiveError("invalid_argument", "rename does not accept project assignment options.")
                wanted_name = name_value(args.name)
                desired = {"name": wanted_name}
                already = desired_name(before, wanted_name)
                method, params = "thread/name/set", {"threadId": thread_id, "name": wanted_name}
            else:
                if args.name or bool(args.project_id) == args.clear_project:
                    raise ArchiveError("invalid_argument", "project-assign requires exactly one of --project-id or --clear-project, without --name.")
                project_id = identity(args.project_id) if args.project_id else None
                project = store.project(project_id) if project_id else None
                if project_id and project is None:
                    raise ArchiveError("project_not_found", "The exact project UUID does not exist in the selected database.")
                desired = {"project_id": project_id}
                already = before["project_id"] == project_id
                item["project"] = project
                method, params = "thread/metadata/update", {"threadId": thread_id, "projectId": project_id or ""}
            item["desired"] = desired
        if args.dry_run:
            item.update(verified=already, planned=not already)
        elif already:
            item.update(after=before, verified=True, verified_at=utc_now())
        else:
            server = StdioServer(binary, store, args.timeout, experimental=args.operation != "rename")
            receipt["server_started"] = True
            with server:
                current = store.project_for_key(key) if creating else store.thread_snapshot(thread_id)
                if current != before:
                    raise ArchiveError("state_changed", "Target state changed after preflight; no mutation was sent.")
                item.update(mutation_attempted=True, changed=None)
                checkpoint(receipt, output)
                response = server.call(method, params)
                if creating:
                    created_id = identity(response.get("project", {}).get("id"))
                    readback = server.call("project/read", {"projectId": created_id}).get("project", {})
                    if readback.get("id") != created_id or readback.get("name") != wanted_name:
                        raise ArchiveError("verification_mismatch", "Independent official project/read did not match creation.")
            # Verify only after the process has exited: no in-memory response can prove persistence.
            after = store.project_for_key(key) if creating else store.thread_snapshot(thread_id)
            item["after"] = after
            if creating:
                valid = after is not None and after["id"] == created_id and all(after[k] == v for k, v in desired.items())
            else:
                valid = same_content(before, after)
                if args.operation == "rename":
                    valid = valid and desired_name(after, wanted_name) and after["project_id"] == before["project_id"]
                else:
                    valid = valid and after["project_id"] == project_id and all(
                        after.get(k) == before.get(k) for k in ("name", "title", "indexed_name"))
            if not valid:
                raise ArchiveError("verification_mismatch", "Persisted metadata or unchanged rollout/cwd checks failed.")
            item.update(verified=True, changed=True, verified_at=utc_now())
        receipt["ok"] = True
    except Exception as error:
        receipt.update(code=getattr(error, "code", "metadata_error"), error=str(error))
        if item.get("mutation_attempted"):
            item["retry_safe"] = False
            try:
                item["after"] = store.project_for_key(item["idempotency_key"]) if args.operation == "project-create" else store.thread_snapshot(item["thread_id"])
                item["changed"] = item["after"] != item.get("before")
            except Exception:
                item["readback_unavailable"] = True
    finally:
        if server:
            server.close()
            receipt.update(rpc_methods=server.methods, server_started=server.process is not None,
                           server_stopped=server.stopped)
    receipt.update(finished_at=utc_now(), duration_ms=round((time.monotonic() - start) * 1000))
    checkpoint(receipt, output)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["rename", "project-create", "project-assign"])
    parser.add_argument("--thread-id")
    parser.add_argument("--name")
    parser.add_argument("--project-id")
    parser.add_argument("--clear-project", action="store_true")
    parser.add_argument("--project-root", action="append", help="Existing absolute directory; repeat for additional roots")
    parser.add_argument("--idempotency-key", help="Required UUID for project-create; reuse the same key to recover a retry")
    parser.add_argument("--codex-home", default=os.environ.get("CODEX_HOME") or str(Path.home() / ".codex"))
    parser.add_argument("--sqlite-home")
    parser.add_argument("--codex-bin")
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--out", help="Private atomic receipt outside both Codex and SQLite homes")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    receipt = execute(args)
    print(json.dumps(receipt, ensure_ascii=False, indent=2) if args.json else
          f"{args.operation}: {'verified' if receipt['ok'] else receipt.get('code')} {receipt['counts']}")
    return 0 if receipt["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
