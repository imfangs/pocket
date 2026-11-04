"""Read the same machine-local bridge configuration as the Node service."""
import json
import os
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parent.parent
BUNDLED_MODULES = ROOT / "vendor/codex-bridge"


def _absolute(value, field):
    if not isinstance(value, str) or not value or not Path(value).is_absolute():
        raise ValueError(f"{field} must be an absolute path")
    return value


def _modules(value, field, required, automatic):
    if value is None:
        return str(BUNDLED_MODULES)
    value = _absolute(value, field)
    if automatic and not all((Path(value) / name).is_file() for name in required):
        return str(BUNDLED_MODULES)
    return value


def _python(value, automatic):
    if value is not None and (not isinstance(value, str) or not value):
        raise ValueError("python must name an executable")
    if value and Path(value).is_absolute():
        if not automatic or (Path(value).is_file() and os.access(value, os.X_OK)):
            return value
    elif value:
        if "/" in value or "\\" in value:
            raise ValueError("python must be absolute or an executable name")
        resolved = shutil.which(value)
        if resolved:
            return os.path.abspath(resolved)
        if not automatic:
            raise ValueError("Configured Python executable was not found")
    resolved = shutil.which("python3")
    if not resolved:
        raise ValueError("Python 3 was not found on PATH")
    return os.path.abspath(resolved)


def _app(value, automatic):
    if value is not None:
        value = _absolute(value, "appPath")
        if not automatic or Path(value).is_dir():
            return value
    candidates = (Path("/Applications/Codex.app"), Path.home() / "Applications/Codex.app")
    return str(next((path for path in candidates if path.is_dir()), candidates[0]))


def load_bridge_config():
    override = os.environ.get("NAVIGATOR_BRIDGE_CONFIG")
    if override and not Path(override).is_absolute():
        raise ValueError("NAVIGATOR_BRIDGE_CONFIG must be absolute")
    path = Path(override) if override else ROOT / "config/desktop-bridge.json"
    config = json.loads(path.read_text()) if path.exists() or override else {}
    if not isinstance(config, dict):
        raise ValueError("Bridge configuration must be an object")
    automatic = not bool(override)
    return {**config,
            "python": _python(config.get("python"), automatic),
            "ipcModuleDirectory": _modules(config.get("ipcModuleDirectory"), "ipcModuleDirectory", ("app_ipc.py", "contracts.py"), automatic),
            "metadataModuleDirectory": _modules(config.get("metadataModuleDirectory"), "metadataModuleDirectory", ("archive_cli.py", "metadata_cli.py"), automatic),
            "appPath": _app(config.get("appPath"), automatic)}
