"""Version-gated client of the existing desktop owner; never starts an agent."""
import json
import plistlib
import sys
from pathlib import Path

CONFIG = json.loads((Path(__file__).resolve().parent.parent / "config/desktop-bridge.json").read_text())
sys.path.insert(0, CONFIG["ipcModuleDirectory"])
from app_ipc import AppIPC


class NavigatorIPC(AppIPC):
    def send(self, message):
        if message.get("type") == "request" and message.get("method") == "thread-owner-discovery":
            message = {**message, "timeoutMs": 2000}
        return super().send(message)

    def request(self, method, params, version, owner=None):
        if method == "initialize":
            params = {**params, "clientType": "codex-navigator"}
        return super().request(method, params, version, owner)


def ordered_turns(state):
    history = state.get("turnHistory", {})
    if history.get("kind") != "canonical":
        return state.get("turns", [])
    h = history["history"]
    return [h["entitiesByKey"][e["value"]] for island in h["islands"]
            for e in island["entries"] if e["value"] in h["entitiesByKey"]]


def input_text(content):
    return "\n".join(c.get("text", "") if c.get("type") in ("text", "input_text", "output_text")
                     else "[附件]" for c in (content or []) if isinstance(c, dict))


def writable(state):
    runtime = state.get("threadRuntimeStatus", {}).get("type")
    if state.get("requests") or state.get("unconfirmedTurnSubmissions"):
        return False, "任务正在等待审批或输入，请在 Mac 的 Codex 中处理。"
    if runtime == "active":
        return False, "任务正在运行，完成后可以发送下一条消息。"
    if runtime not in ("idle", "systemError") or state.get("resumeState") != "resumed":
        return False, "先连接 Mac 中的原任务，再发送消息。"
    if state.get("threadSource") == "subagent" or state.get("parentThreadId"):
        return False, "子任务请通过其原任务继续。"
    return True, "消息会在 Mac 的原任务中运行，沿用原模型与权限。"


def history(state):
    turns = ordered_turns(state)
    messages = []
    for turn in turns[-30:]:
        tid = turn.get("turnId")
        params = turn.get("params") or {}
        items = turn.get("items") or []
        common = {"turnId": tid, "timestamp": turn.get("turnStartedAtMs"), "turnStatus": turn.get("status")}
        if not any(i.get("type") == "userMessage" for i in items):
            text = input_text(params.get("input"))
            if text:
                messages.append({**common, "id": str(tid)+":user", "role": "user", "text": text,
                                 "clientMessageId": params.get("clientUserMessageId")})
        for item in items:
            if item.get("type") == "userMessage":
                text = input_text(item.get("content"))
                msg = {"role": "user", "clientMessageId": params.get("clientUserMessageId") or item.get("clientId")}
            elif item.get("type") == "agentMessage" and item.get("phase") != "analysis":
                text = item.get("text", "")
                msg = {"role": "assistant", "phase": item.get("phase"),
                       "timestamp": (turn.get("aeonAssistantMessageStartedAtMsById") or {}).get(item.get("id")) or turn.get("turnStartedAtMs")}
            else:
                continue
            if text:
                messages.append({**common, **msg, "id": item.get("id") or str(tid)+":"+str(len(messages)), "text": text})
    messages = messages[-80:]
    budget = 160000
    for message in reversed(messages):
        original = message["text"]
        message["text"] = original[:min(24000, max(0, budget))]
        message["truncated"] = len(message["text"]) < len(original)
        budget -= len(message["text"])
    messages = [m for m in messages if m["text"]]
    allowed, hint = writable(state)
    return {"source": "desktop", "messages": messages, "runtime": state.get("threadRuntimeStatus", {}).get("type"),
            "canSend": allowed, "hint": hint, "hasMore": not state.get("turnsPagination", {}).get("hasLoadedOldest", False) or len(turns) > 30,
            "latestTurnId": turns[-1].get("turnId") if turns else None}


def main():
    data = json.loads(sys.stdin.buffer.read(70000))
    thread_id = data["threadId"]
    info = plistlib.loads((Path(CONFIG["appPath"]) / "Contents/Info.plist").read_bytes())
    version = info.get("CFBundleShortVersionString", "") + ":" + info.get("CFBundleVersion", "")
    if info.get("CFBundleIdentifier") != "com.openai.codex" or version != CONFIG["supportedVersion"]:
        return {"ok": False, "code": "app_version_changed", "sent": False}
    dispatched = False
    try:
        with NavigatorIPC(Path(data["codexHome"]) / "ipc/ipc.sock") as client:
            owner, state = client.snapshot(thread_id)
            if data["operation"] == "history":
                return {"ok": True, **history(state)}
            if data["operation"] != "send":
                return {"ok": False, "code": "unsupported_operation", "sent": False}
            message_id = data["requestId"]
            for turn in ordered_turns(state):
                if (turn.get("params") or {}).get("clientUserMessageId") == message_id:
                    return {"ok": True, "status": "accepted", "turnId": turn.get("turnId")}
            allowed, _ = writable(state)
            if not allowed:
                return {"ok": False, "code": "thread_not_ready", "sent": False}
            # A second owner/state read narrows the race with another desktop client.
            fresh_owner, fresh = client.snapshot(thread_id)
            if fresh_owner != owner or not writable(fresh)[0]:
                return {"ok": False, "code": "thread_changed", "sent": False}
            dispatched = True
            client.start(thread_id, owner, message_id, data["text"])
            return {"ok": True, "status": "accepted", "turnId": None}
    except Exception:
        return {"ok": False, "code": "dispatch_unknown" if dispatched else "desktop_unavailable", "sent": None if dispatched else False}


if __name__ == "__main__":
    try:
        result = main()
    except Exception:
        result = {"ok": False, "code": "desktop_unavailable", "sent": False}
    print(json.dumps(result, ensure_ascii=False))
