"""Narrow model projection and configured same-provider choices; no credentials."""
import hashlib
import json
import os
import re
from pathlib import Path

MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}\Z")
EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
DEFAULT_CATALOG = Path(__file__).resolve().parent.parent / "config/model-catalog.json"


def model_projection(state, owner):
    settings = state.get("latestThreadSettings") or {}
    model = settings.get("model") or state.get("latestModel")
    provider = settings.get("modelProvider") or state.get("modelProvider")
    effort = settings.get("effort") if "effort" in settings else state.get("latestReasoningEffort")
    current = {
        "model": model if isinstance(model, str) and MODEL_ID.fullmatch(model) else None,
        "effort": effort if isinstance(effort, str) and effort in EFFORTS else None,
        "provider": provider if isinstance(provider, str) and MODEL_ID.fullmatch(provider) else None,
    }
    revision = hashlib.sha256(json.dumps(
        [state.get("id"), owner, current], sort_keys=True, separators=(",", ":")
    ).encode()).hexdigest()
    return {"source": "desktop", "current": current, "revision": revision}


def configured_models(provider, path=None):
    try:
        path = Path(path or os.environ.get("NAVIGATOR_MODEL_CATALOG") or DEFAULT_CATALOG)
        if not path.is_absolute():
            raise ValueError("catalog path must be absolute")
        with path.open("rb") as handle:
            raw = handle.read(65537)
        if len(raw) > 65536:
            raise ValueError("catalog too large")
        catalog = json.loads(raw)
        if catalog.get("schemaVersion") != 1 or catalog.get("modelProvider") != provider:
            return [], "model_provider_not_configured"
        records = catalog["models"]
        if not isinstance(records, list) or not 1 <= len(records) <= 50:
            raise ValueError("invalid catalog")
        models, seen = [], set()
        for item in records:
            model, name = item["id"], item["name"]
            efforts, default = item["supportedEfforts"], item["defaultEffort"]
            if (not isinstance(model, str) or not MODEL_ID.fullmatch(model) or model in seen
                    or not isinstance(name, str) or not 1 <= len(name) <= 100
                    or not isinstance(efforts, list) or not 1 <= len(efforts) <= len(EFFORTS)
                    or any(not isinstance(e, str) or e not in EFFORTS for e in efforts)
                    or len(set(efforts)) != len(efforts) or default not in efforts):
                raise ValueError("invalid model")
            seen.add(model)
            models.append({"id": model, "name": name, "supportedEfforts": efforts, "defaultEffort": default})
        return models, None
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return [], "model_catalog_unavailable"


def model_state(state, owner, writable):
    result = model_projection(state, owner)
    models, reason = configured_models(result["current"]["provider"])
    if not result["current"]["model"] or not result["current"]["provider"]:
        reason = "model_state_unavailable"
    # A terminated model failure still permits the owner's next-turn settings;
    # keep the existing writable gate and exclude actively running turns.
    elif not writable or state.get("threadRuntimeStatus", {}).get("type") not in ("idle", "systemError"):
        reason = "thread_not_ready"
    return {**result, "models": models, "catalogSource": "configured",
            "canChange": reason is None, "reason": reason}


def validate_model_change(data, state):
    if (not isinstance(data.get("model"), str) or not MODEL_ID.fullmatch(data["model"])
            or not isinstance(data.get("effort"), str) or data["effort"] not in EFFORTS):
        return "invalid_model"
    if not state["canChange"]:
        return state["reason"] or "thread_not_ready"
    if data.get("expectedRevision") != state["revision"]:
        return "model_state_changed"
    model = next((m for m in state["models"] if m["id"] == data["model"]), None)
    if model is None or data["effort"] not in model["supportedEfforts"]:
        return "model_not_configured"
    return None
