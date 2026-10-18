"""Original-owner model projection and a credential-free bundled model catalog.

Only the current model's effort can be changed. Catalog discovery starts no
thread, connects no provider, and never uses the user's Codex home or credentials.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import select
import subprocess
import tempfile
import time

from bundled_cli import bundled_cli, verify_cli

MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}\Z")
THREAD_ID = re.compile(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}\Z")
EFFORTS = frozenset({"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"})


class ModelSettingsError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def valid_thread_id(value):
    return isinstance(value, str) and THREAD_ID.fullmatch(value) is not None


def _model(value):
    return value if isinstance(value, str) and MODEL_ID.fullmatch(value) else None


def _dict(value):
    return value if isinstance(value, dict) else {}


def _fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":")).encode()).hexdigest()


def validate_identity(state, thread_id, owner):
    if (not valid_thread_id(thread_id) or not isinstance(owner, str) or not owner
            or state.get("id") != thread_id or state.get("hostId") != "local"):
        raise ModelSettingsError("model_thread_changed")


def current_settings(state):
    settings = _dict(state.get("latestThreadSettings"))
    collaboration = _dict(settings.get("collaborationMode")) or _dict(state.get("latestCollaborationMode"))
    collaboration_settings = _dict(collaboration.get("settings"))
    # Native inheritThreadSettings reads latestThreadSettings before the older
    # latestReasoningEffort field, which can remain null during an active turn.
    effort = settings["effort"] if "effort" in settings else (
        collaboration_settings["reasoning_effort"] if "reasoning_effort" in collaboration_settings
        else state.get("latestReasoningEffort"))
    return {
        "model": _model(settings.get("model")) or _model(collaboration_settings.get("model"))
                 or _model(state.get("latestModel")),
        "effort": effort if isinstance(effort, str) and effort in EFFORTS else None,
        "provider": _model(settings.get("modelProvider")) or _model(state.get("modelProvider")),
    }


def _without_model_effort(collaboration):
    if not isinstance(collaboration, dict):
        return collaboration
    result = dict(collaboration)
    if isinstance(result.get("settings"), dict):
        result["settings"] = {key: value for key, value in result["settings"].items()
                              if key not in ("model", "reasoning_effort")}
    return result


def preserved_binding(state, owner):
    # Keep private instructions and permissions inside a one-way fingerprint;
    # they never enter Pocket's response or logs.
    settings = _dict(state.get("latestThreadSettings"))
    stable = {key: value for key, value in settings.items()
              if key not in ("model", "effort", "collaborationMode")}
    stable["collaborationMode"] = _without_model_effort(settings.get("collaborationMode"))
    return _fingerprint({
        "owner": owner,
        "thread": {key: state.get(key) for key in (
            "id", "hostId", "modelProvider", "cwd", "mode", "threadSource", "threadStartKind",
            "parentThreadId", "ephemeral", "sideConversation", "resumeState", "archived", "isArchived",
            "archivedAt", "currentPermissions")},
        "settings": stable,
        "collaborationMode": _without_model_effort(state.get("latestCollaborationMode")),
    })


def model_projection(state, owner, thread_id):
    validate_identity(state, thread_id, owner)
    current = current_settings(state)
    settings = _dict(state.get("latestThreadSettings"))
    collaboration = _dict(state.get("latestCollaborationMode"))
    revision = _fingerprint({
        "binding": preserved_binding(state, owner), "current": current,
        "raw": {"model": state.get("latestModel"), "effort": state.get("latestReasoningEffort"),
                "threadModel": settings.get("model"), "threadEffort": settings.get("effort"),
                "hasThreadEffort": "effort" in settings,
                "collaborationSettings": collaboration.get("settings")},
    })
    return {"threadId": thread_id, "source": "desktop", "current": current, "revision": revision}


def model_state(state, owner, thread_id, models, writable):
    projected = model_projection(state, owner, thread_id)
    current = projected["current"]
    choices = [item for item in models if item.get("id") == current["model"]]
    reason = None
    if not current["model"] or not current["provider"]:
        reason = "model_settings_unavailable"
    elif (state.get("archived") or state.get("isArchived") or state.get("archivedAt")
          or state.get("ephemeral") or state.get("sideConversation")
          or state.get("parentThreadId") or state.get("threadSource") in ("subagent", "subAgentThreadSpawn")
          or state.get("mode") not in (None, "default", "plan") or not writable):
        reason = "thread_not_ready"
    elif (not _model(state.get("latestModel")) or state.get("latestReasoningEffort") is not None
          and state.get("latestReasoningEffort") not in EFFORTS):
        reason = "model_settings_unavailable"
    elif not choices:
        reason = "model_catalog_unavailable"
    return {**projected, "models": choices, "catalogSource": "bundled",
            "canChange": reason is None, "canChangeModel": False, "reason": reason}


def validate_change(data, projected):
    if (not isinstance(data.get("model"), str) or not MODEL_ID.fullmatch(data["model"])
            or not isinstance(data.get("effort"), str) or data["effort"] not in EFFORTS
            or not isinstance(data.get("expectedRevision"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", data["expectedRevision"])):
        return "invalid_model_settings"
    if data["model"] != projected["current"]["model"]:
        return "model_change_unsupported"
    if data["expectedRevision"] != projected["revision"]:
        return "model_state_changed"
    if not projected["canChange"]:
        return projected["reason"] or "thread_not_ready"
    model = next((item for item in projected["models"] if item["id"] == data["model"]), None)
    if model is None or data["effort"] not in model["supportedEfforts"]:
        return "model_effort_unsupported"
    return None


def read_bundled_model(app, model):
    """Return only this installed CLI's visible metadata for the exact model.

    The result describes the bundled picker, not provider availability or
    cross-model history compatibility. Failure keeps the model visible but
    disables editing. No persistent catalog or credential copy is created.
    """
    if not _model(model):
        return []
    binary = bundled_cli(app)["entrypoint"]
    with tempfile.TemporaryDirectory(prefix="pocket-model-catalog-") as directory:
        home = Path(directory).resolve()
        # A separate provider with an unreachable loopback endpoint ensures the
        # catalog helper cannot contact the real provider or inherit its auth.
        (home / "config.toml").write_text(
            'model_provider = "pocket_catalog"\ncli_auth_credentials_store = "file"\n'
            'check_for_update_on_startup = false\n'
            '[analytics]\nenabled = false\n[feedback]\nenabled = false\n'
            '[model_providers.pocket_catalog]\nname = "Pocket catalog"\n'
            'base_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n')
        verify_cli(binary, home)
        env = {key: os.environ[key] for key in ("PATH", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR")
               if key in os.environ}
        env.update(CODEX_HOME=str(home), CODEX_SQLITE_HOME=str(home))
        process = subprocess.Popen([str(binary), "app-server", "--stdio"], cwd=home, env=env,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        buffer, sequence = b"", 0
        catalog_deadline = time.monotonic() + 5

        def call(method, params):
            nonlocal buffer, sequence
            if method not in ("initialize", "model/list"):
                raise ModelSettingsError("model_catalog_unavailable")
            sequence += 1
            process.stdin.write((json.dumps({"id": sequence, "method": method, "params": params}) + "\n").encode())
            process.stdin.flush()
            deadline = min(catalog_deadline, time.monotonic() + 4)
            while time.monotonic() < deadline:
                if b"\n" not in buffer:
                    readable, _, _ = select.select([process.stdout], [], [], max(0, deadline - time.monotonic()))
                    if not readable:
                        break
                    chunk = os.read(process.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    buffer += chunk
                    if len(buffer) > 2 * 1024 * 1024:
                        break
                    continue
                line, buffer = buffer.split(b"\n", 1)
                response = json.loads(line)
                if "method" in response and "id" in response:
                    break
                if response.get("id") == sequence:
                    if "error" in response or not isinstance(response.get("result"), dict):
                        break
                    return response["result"]
            raise ModelSettingsError("model_catalog_unavailable")

        try:
            initialized = call("initialize", {"clientInfo": {"name": "pocket_model_catalog", "version": "1"}})
            if Path(initialized.get("codexHome", "")).resolve() != home:
                raise ModelSettingsError("model_catalog_unavailable")
            process.stdin.write(b'{"method":"initialized"}\n')
            process.stdin.flush()
            cursor, seen = None, set()
            for _ in range(5):
                result = call("model/list", {"includeHidden": False, "cursor": cursor, "limit": 100})
                records = result.get("data")
                if not isinstance(records, list) or len(records) > 100:
                    raise ModelSettingsError("model_catalog_unavailable")
                for item in records:
                    if not isinstance(item, dict) or item.get("model") != model or item.get("hidden") is not False:
                        continue
                    name, default = item.get("displayName"), item.get("defaultReasoningEffort")
                    raw_efforts = item.get("supportedReasoningEfforts")
                    if (not isinstance(name, str) or not 0 < len(name) <= 100
                            or any(ord(c) < 32 for c in name) or not isinstance(raw_efforts, list)):
                        raise ModelSettingsError("model_catalog_unavailable")
                    efforts = [entry.get("reasoningEffort") for entry in raw_efforts if isinstance(entry, dict)]
                    if (len(efforts) != len(raw_efforts) or not efforts or len(efforts) > len(EFFORTS)
                            or any(not isinstance(effort, str) or effort not in EFFORTS for effort in efforts)
                            or len(efforts) != len(set(efforts)) or default not in efforts):
                        raise ModelSettingsError("model_catalog_unavailable")
                    return [{"id": model, "name": name, "supportedEfforts": efforts, "defaultEffort": default}]
                cursor = result.get("nextCursor")
                if cursor is None:
                    return []
                if not isinstance(cursor, str) or cursor in seen or len(cursor) > 4096:
                    raise ModelSettingsError("model_catalog_unavailable")
                seen.add(cursor)
            raise ModelSettingsError("model_catalog_unavailable")
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=1)
            process.stdout.close()
