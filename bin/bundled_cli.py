"""Resolve Codex bundle identity and layouts independently of App releases."""
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
from xml.parsers.expat import ExpatError


# These CLI behavior contracts cover the metadata RPCs, empty-thread
# materialization, and archive/unarchive semantics used by Pocket. They are
# exercised by the isolated create/rename/archive protocol tests, not inferred
# from an App release number or a syntactically valid CLI version string.
# Membership records tested behavior; it is not a gate for newer valid CLIs.
_VERIFIED_CLI_VERSIONS = frozenset({
    "codex-cli 0.153.4",
    "codex-cli 0.162.0-alpha.17.2",
    "codex-cli 0.163.0-alpha.10.2",
    "codex-cli 0.164.0-alpha.11.1",
})
_PACKAGED_LAYOUT = ("codex-cli/bin/codex", "codex-cli/CodexCLI.app/Contents/MacOS/codex")
_NUMBER = r"(?:0|[1-9][0-9]*)"
_PRERELEASE = rf"(?:{_NUMBER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
_CLI_VERSION = re.compile(
    rf"codex-cli {_NUMBER}\.{_NUMBER}\.{_NUMBER}"
    rf"(?:-{_PRERELEASE}(?:\.{_PRERELEASE})*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)


class BundledCLIError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def desktop_app(app):
    """Validate bundle identity; the release string is diagnostic data only."""
    try:
        path = Path(app).resolve(strict=True)
        plist = (path / "Contents/Info.plist").resolve(strict=True)
        if not path.is_dir() or not plist.is_relative_to(path) or not plist.is_file():
            raise ValueError("Invalid bundle layout")
        info = plistlib.loads(plist.read_bytes())
        if not isinstance(info, dict):
            raise ValueError("Invalid bundle info")
    except (OSError, ValueError, TypeError, plistlib.InvalidFileException, ExpatError) as error:
        raise BundledCLIError("bundled_app_unavailable") from error
    if info.get("CFBundleIdentifier") != "com.openai.codex":
        raise BundledCLIError("unsupported_app_identity")
    version = ":".join(str(info.get(key) or "") for key in ("CFBundleShortVersionString", "CFBundleVersion"))
    return {"path": path, "version": version if version != ":" else "unknown", "info": info}


def bundled_cli(app, desktop_version=None):
    # desktop_version remains accepted for older callers; it never grants or
    # denies compatibility. Process discovery must not launch a CLI probe.
    resources = desktop_app(app)["path"] / "Contents/Resources"
    package = resources / "codex-cli"
    layout = _PACKAGED_LAYOUT if package.exists() or package.is_symlink() else ("codex", "codex")
    paths = []
    for relative in layout:
        try:
            path = (resources / relative).resolve(strict=True)
        except OSError as error:
            raise BundledCLIError("bundled_cli_unavailable") from error
        if not path.is_relative_to(resources) or not path.is_file() or not os.access(path, os.X_OK):
            raise BundledCLIError("bundled_cli_unavailable")
        paths.append(path)
    # The packaged shell entrypoint execs the signed Mach-O. Process discovery
    # must match that executable, while launches retain the package entrypoint.
    return {"entrypoint": paths[0], "executable": paths[1]}


def verify_cli(binary, home, sqlite_home=None):
    """Require a working Codex CLI probe; annotate unverified behavior contracts."""
    env = {**os.environ, "CODEX_HOME": str(home), "CODEX_SQLITE_HOME": str(sqlite_home or home)}
    env.pop("CODEX_THREAD_ID", None)
    try:
        result = subprocess.run([str(binary), "--version"], cwd=home, env=env,
                                capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError, UnicodeError) as error:
        raise BundledCLIError("bundled_cli_unavailable") from error
    version = result.stdout.strip()
    if result.returncode or len(version) > 160 or not _CLI_VERSION.fullmatch(version):
        raise BundledCLIError("bundled_cli_unavailable")
    if version not in _VERIFIED_CLI_VERSIONS:
        warning = "POCKET_BRIDGE_WARNING_V1 " + json.dumps(
            {"code": "unverified_cli_version", "cliVersion": version}, separators=(",", ":")
        )
        # Bypass TextIO buffering: after a broken pipe, a caught print() failure
        # can be flushed again at interpreter shutdown and force exit code 120.
        # No usable stderr FD means no diagnostic, never a fallback to stdout.
        try:
            if sys.stderr is not None:
                descriptor = sys.stderr.fileno()
                if isinstance(descriptor, int) and descriptor >= 2:
                    os.write(descriptor, (warning + "\n").encode("utf-8"))
        except (AttributeError, OSError, ValueError):
            pass
    return version
