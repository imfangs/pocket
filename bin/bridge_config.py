"""Read the same machine-local bridge configuration as the Node service."""
import json
import os
from pathlib import Path


def load_bridge_config():
    override = os.environ.get("NAVIGATOR_BRIDGE_CONFIG")
    if override and not Path(override).is_absolute():
        raise ValueError("NAVIGATOR_BRIDGE_CONFIG must be absolute")
    path = Path(override) if override else Path(__file__).resolve().parent.parent / "config/desktop-bridge.json"
    return json.loads(path.read_text())
