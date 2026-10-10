"""Resolve the CLI layouts shipped with explicitly verified desktop releases."""
import os
from pathlib import Path


_RELEASES = {
    "26.903.71938:8576": ("codex", "codex", "codex-cli 0.153.4"),
    "26.1007.21159:20052": (
        "codex-cli/bin/codex",
        "codex-cli/CodexCLI.app/Contents/MacOS/codex",
        "codex-cli 0.162.0-alpha.17.2",
    ),
}


class BundledCLIError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def bundled_cli(app, desktop_version):
    release = _RELEASES.get(desktop_version)
    if release is None:
        raise BundledCLIError("app_version_changed")
    resources = Path(app).resolve() / "Contents/Resources"
    paths = []
    for relative in release[:2]:
        try:
            path = (resources / relative).resolve(strict=True)
        except OSError as error:
            raise BundledCLIError("bundled_cli_unavailable") from error
        if not path.is_relative_to(resources) or not path.is_file() or not os.access(path, os.X_OK):
            raise BundledCLIError("bundled_cli_unavailable")
        paths.append(path)
    # The packaged shell entrypoint execs the signed Mach-O. Process discovery
    # must match that executable, while launches retain the package entrypoint.
    return {"entrypoint": paths[0], "executable": paths[1], "version": release[2]}
