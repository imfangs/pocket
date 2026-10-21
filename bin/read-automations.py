#!/usr/bin/env python3
"""Read a bounded, coherent snapshot of native thread heartbeats. Never writes."""

import json
import os
import re
import stat
import sys
import time
import tomllib

MAX_ENTRIES = 512
MAX_FILES = 256
MAX_FILE_BYTES = 128 * 1024
MAX_TOTAL_BYTES = 1024 * 1024
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$", re.I)
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def identity(info):
    return (info.st_dev, info.st_ino)


def unchanged(before, after):
    if fingerprint(before) != fingerprint(after):
        raise ValueError("source_changed")


def heartbeat(data, directory):
    # A project, cwd, origin or automation id never establishes thread ownership.
    if data.get("kind") == "cron":
        return None
    if data.get("kind") != "heartbeat":
        raise ValueError("invalid_automation")
    target = data.get("target_thread_id")
    if not isinstance(target, str) or not UUID.fullmatch(target):
        raise ValueError("invalid_automation")
    identifier, name, prompt, rule = (data.get(key) for key in ("id", "name", "prompt", "rrule"))
    if (data.get("version") != 1 or isinstance(data.get("version"), bool)
            or not isinstance(identifier, str) or not ID.fullmatch(identifier) or identifier != directory
            or not isinstance(name, str) or not name.strip() or len(name) > 240
            or any(ord(char) < 32 or ord(char) == 127 for char in name)
            or not isinstance(prompt, str) or len(prompt) > 65536
            or not isinstance(rule, str) or len(rule) > 2048):
        raise ValueError("invalid_automation")
    status = data.get("status")
    if not isinstance(status, str) or not re.fullmatch(r"[A-Z_]{1,32}", status):
        raise ValueError("invalid_automation")
    row = {"id": identifier, "threadId": target, "name": name, "prompt": prompt,
           "rrule": rule, "status": status if status in ("ACTIVE", "PAUSED") else "UNKNOWN"}
    for source, destination in (("created_at", "createdAt"), ("updated_at", "updatedAt")):
        value = data.get(source)
        if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 8640000000000000:
            row[destination] = value
    return row


def read_snapshot(codex_home):
    if not isinstance(codex_home, str) or not os.path.isabs(codex_home):
        raise ValueError("invalid_home")
    deadline = time.monotonic() + 2
    home_fd = os.open(codex_home, DIRECTORY_FLAGS)
    root_fd = None
    try:
        try:
            root_fd = os.open("automations", DIRECTORY_FLAGS, dir_fd=home_fd)
        except FileNotFoundError:
            # Missing automations in an existing configured home is known empty.
            if identity(os.fstat(home_fd)) != identity(os.stat(codex_home, follow_symlinks=False)):
                raise ValueError("source_changed")
            try:
                os.stat("automations", dir_fd=home_fd, follow_symlinks=False)
            except FileNotFoundError:
                return {"ok": True, "automations": []}
            raise ValueError("source_changed")
        root_before = os.fstat(root_fd)
        names = []
        with os.scandir(root_fd) as entries:
            for count, entry in enumerate(entries, 1):
                if count > MAX_ENTRIES or time.monotonic() > deadline:
                    raise ValueError("source_limit")
                if entry.is_symlink():
                    raise ValueError("source_symlink")
                if entry.is_dir(follow_symlinks=False):
                    names.append(entry.name)
                    if len(names) > MAX_FILES:
                        raise ValueError("source_limit")
        rows, observed, total = [], [], 0
        for name in sorted(names):
            if time.monotonic() > deadline:
                raise ValueError("source_timeout")
            child_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=root_fd)
            file_fd = None
            try:
                child_before = os.fstat(child_fd)
                file_fd = os.open("automation.toml", FILE_FLAGS, dir_fd=child_fd)
                before = os.fstat(file_fd)
                if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_FILE_BYTES:
                    raise ValueError("source_limit")
                total += before.st_size
                if total > MAX_TOTAL_BYTES:
                    raise ValueError("source_limit")
                chunks, size = [], 0
                while True:
                    chunk = os.read(file_fd, min(65536, MAX_FILE_BYTES + 1 - size))
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_FILE_BYTES or time.monotonic() > deadline:
                        raise ValueError("source_limit")
                    chunks.append(chunk)
                unchanged(before, os.fstat(file_fd))
                unchanged(before, os.stat("automation.toml", dir_fd=child_fd, follow_symlinks=False))
                unchanged(child_before, os.fstat(child_fd))
                if size != before.st_size:
                    raise ValueError("source_changed")
                data = tomllib.loads(b"".join(chunks).decode("utf-8"))
                row = heartbeat(data, name)
                if row is not None:
                    rows.append(row)
                observed.append((name, child_before, before))
            finally:
                if file_fd is not None:
                    os.close(file_fd)
                os.close(child_fd)
        # A later read must not combine an earlier file with a replaced sibling.
        for name, directory_before, file_before in observed:
            if time.monotonic() > deadline:
                raise ValueError("source_timeout")
            child_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=root_fd)
            try:
                unchanged(directory_before, os.fstat(child_fd))
                unchanged(file_before, os.stat("automation.toml", dir_fd=child_fd, follow_symlinks=False))
            finally:
                os.close(child_fd)
        unchanged(root_before, os.fstat(root_fd))
        unchanged(root_before, os.stat("automations", dir_fd=home_fd, follow_symlinks=False))
        if identity(os.fstat(home_fd)) != identity(os.stat(codex_home, follow_symlinks=False)):
            raise ValueError("source_changed")
        return {"ok": True, "automations": rows}
    finally:
        if root_fd is not None:
            os.close(root_fd)
        os.close(home_fd)


def main():
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise ValueError("invalid_input")
        payload = json.loads(raw)
        result = read_snapshot(payload.get("codexHome"))
    except Exception:
        # Paths, raw TOML and prompt content do not belong in diagnostics.
        result = {"ok": False, "code": "automation_source_unavailable"}
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
