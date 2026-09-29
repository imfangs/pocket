"""Version-gated client of the existing desktop owner; never starts an agent."""
from request_actions import projected_requests, prepare_response
import json
import plistlib
import sys
import time
import math
import hashlib
from pathlib import Path

CONFIG = json.loads((Path(__file__).resolve().parent.parent / "config/desktop-bridge.json").read_text())
sys.path.insert(0, CONFIG["ipcModuleDirectory"])
from app_ipc import AppIPC


class NavigatorIPC(AppIPC):
    owner_lookup_timeout = None

    def receive(self):
        deadline = getattr(self, "_owner_deadline", None)
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("owner_lookup_timeout")
            self.socket.settimeout(remaining)
        return super().receive()

    def send(self, message):
        if message.get("type") == "request" and message.get("method") == "thread-owner-discovery":
            message = {**message, "timeoutMs": int((self.owner_lookup_timeout or 10) * 1000)}
        return super().send(message)

    def request(self, method, params, version, owner=None):
        if method == "initialize":
            params = {**params, "clientType": "codex-navigator"}
        if method != "thread-owner-discovery" or self.owner_lookup_timeout is None:
            return super().request(method, params, version, owner)
        # The desktop does not honor the shorter timeoutMs for discovery.
        # Bound only read-side discovery; full snapshots and sends keep their budget.
        previous_timeout = self.socket.gettimeout()
        self._owner_deadline = time.monotonic() + self.owner_lookup_timeout
        try:
            return super().request(method, params, version, owner)
        finally:
            self._owner_deadline = None
            self.socket.settimeout(previous_timeout)


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
    if runtime not in ("idle", "systemError", "active") or state.get("resumeState") != "resumed":
        return False, "先连接 Mac 中的原任务，再发送消息。"
    if state.get("threadSource") == "subagent" or state.get("parentThreadId"):
        return False, "子任务请通过其原任务继续。"
    if compaction_state(state)["active"]:
        return False, "正在压缩上下文，完成后可继续。"
    if runtime == "active":
        return True, "正在运行，新消息默认进入 Pocket 待发列表。"
    return True, "消息会在 Mac 的原任务中运行，沿用原模型与权限。"


def compaction_state(state):
    items = [(t, i) for t in ordered_turns(state) for i in t.get("items", [])
             if i.get("type") == "contextCompaction"]
    if not items:
        return {"active": False, "latestId": None}
    turn, item = items[-1]
    completed = turn.get("status") != "inProgress" or item.get("completed", True)
    return {"active": not completed, "latestId": item.get("id"), "completed": completed,
            "turnStatus": turn.get("status"), "turnId": turn.get("turnId")}


def context_usage(state):
    usage = state.get("latestTokenUsageInfo") or {}
    window, used = usage.get("modelContextWindow"), (usage.get("last") or {}).get("totalTokens")
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in (window, used)):
        return None
    if window <= 0 or used < 0:
        return None
    used = min(used, window)
    return {"usedTokens": used, "contextWindow": window, "remainingTokens": window-used,
            "percent": used/window*100}


def request_key(request):
    return hashlib.sha256(json.dumps(request, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def pending_requests(state):
    return projected_requests(state, ordered_turns(state))


def async_questions(state):
    turns = ordered_turns(state)
    answered = set()
    for turn in turns:
        items = list(turn.get("items") or [])
        if (turn.get("params") or {}).get("input"):
            items.append({"type": "userMessage", "content": turn["params"]["input"]})
        for item in items:
            if item.get("type") == "userMessage":
                content = item.get("content") or []
            elif item.get("type") == "steeringUserMessage" and item.get("status") == "accepted":
                content = item.get("input") or []
            else:
                continue
            if len(content) != 1 or content[0].get("type") != "text":
                continue
            text = content[0].get("text", "").strip()
            start, end = "<send_user_message_question_reply>", "</send_user_message_question_reply>"
            if text.startswith(start) and text.endswith(end):
                try:
                    rows = json.loads(text[len(start):-len(end)])
                    for row in rows if isinstance(rows, list) else [rows]:
                        if isinstance(row, dict) and isinstance(row.get("answer"), str):
                            answered.add(row.get("questionItemId"))
                except (ValueError, TypeError):
                    pass
    questions = []
    for turn in turns[-30:]:
        for item in turn.get("items", []):
            if item.get("type") != "agentMessage" or item.get("delivery") != "async":
                continue
            if not isinstance(item.get("id"), str) or not isinstance(item.get("questions"), list):
                continue
            for index, question in enumerate(item["questions"]):
                if not isinstance(question, dict):
                    continue
                title, options = question.get("title"), question.get("options") or []
                qid = json.dumps(["request_user_input_async", item.get("id"), index], separators=(",", ":"), ensure_ascii=False)
                if qid in answered or not isinstance(title, str) or not title or len(title) > 8000:
                    continue
                if not isinstance(options, list) or len(options) > 20 or any(not isinstance(o, str) or len(o) > 2000 for o in options):
                    continue
                shown = {"id": qid, "sourceMessageId": item.get("id"), "title": title, "options": options}
                questions.append({**shown, "key": request_key(shown)})
    result, budget = [], 45000
    for question in reversed(questions[-10:]):
        size = len(question["title"]) + sum(map(len, question["options"]))
        if size <= budget:
            result.insert(0, question)
            budget -= size
    return result


def can_compact(state):
    return writable(state)[0] and state.get("threadRuntimeStatus", {}).get("type") == "idle"


def active_turn_id(state):
    turns = [t for t in ordered_turns(state) if t.get("turnId")]
    if state.get("resumeState") != "resumed" or state.get("threadRuntimeStatus", {}).get("type") != "active":
        return None
    if state.get("threadSource") == "subagent" or state.get("parentThreadId"):
        return None
    return turns[-1]["turnId"] if turns and turns[-1].get("status") == "inProgress" else None


def turn_timing(turn, observed_at):
    def number(value):
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else None
    return {"turnId": turn.get("turnId"), "status": turn.get("status"),
            "startedAt": number(turn.get("turnStartedAtMs")),
            "durationMs": number(turn.get("durationMs")) if turn.get("status") != "inProgress" else None,
            "observedAt": observed_at}


def history(state):
    turns = ordered_turns(state)
    observed_at = int(time.time() * 1000)
    messages = []
    for turn in turns[-30:]:
        tid = turn.get("turnId")
        params = turn.get("params") or {}
        items = turn.get("items") or []
        user_item_ids = {i.get("id") for i in items if i.get("type") == "userMessage"}
        common = {"turnId": tid, "timestamp": turn.get("turnStartedAtMs"), "turnStatus": turn.get("status")}
        if not any(i.get("type") == "userMessage" for i in items):
            text = input_text(params.get("input"))
            if text:
                messages.append({**common, "id": str(tid)+":user", "role": "user", "text": text,
                                 "clientMessageId": params.get("clientUserMessageId")})
        for item in items:
            message_id = item.get("id") or str(tid)+":"+str(len(messages))
            if item.get("type") == "userMessage":
                text = input_text(item.get("content"))
                msg = {"role": "user", "clientMessageId": item.get("clientId") or params.get("clientUserMessageId")}
            elif item.get("type") == "steeringUserMessage" and item.get("status") == "accepted":
                # Input added mid-turn remains a distinct visible user message.
                # The desktop may later materialize it as a regular userMessage.
                if item.get("serverUserMessageId") in user_item_ids:
                    continue
                text = input_text(item.get("input"))
                message_id = item.get("serverUserMessageId") or message_id
                msg = {"role": "user", "clientMessageId": item.get("clientUserMessageId"),
                       "timestamp": (item.get("restoreMessage") or {}).get("createdAt") or common["timestamp"]}
            elif item.get("type") == "agentMessage" and item.get("phase") != "analysis":
                text = item.get("text", "")
                msg = {"role": "assistant", "phase": item.get("phase"),
                       "isQuestion": item.get("delivery") == "async" and bool(item.get("questions")),
                       "timestamp": (turn.get("aeonAssistantMessageStartedAtMsById") or {}).get(item.get("id")) or turn.get("turnStartedAtMs")}
            else:
                continue
            if text:
                messages.append({**common, **msg, "id": message_id, "text": text})
        timing = turn_timing(turn, observed_at)
        if timing["durationMs"] is not None:
            final = next((m for m in reversed(messages) if m.get("turnId") == tid and
                          m["role"] == "assistant" and m.get("phase") in ("final", "final_answer")), None)
            if final is not None:
                final["turnDurationMs"] = timing["durationMs"]
    messages = messages[-80:]
    budget = 160000
    for message in reversed(messages):
        original = message["text"]
        message["text"] = original[:min(24000, max(0, budget))]
        message["truncated"] = len(message["text"]) < len(original)
        budget -= len(message["text"])
    messages = [m for m in messages if m["text"]]
    allowed, hint = writable(state)
    requests = pending_requests(state)
    if requests:
        hint = "任务正在等待你确认操作，可在下方查看并响应。"
    return {"source": "desktop", "messages": messages, "runtime": state.get("threadRuntimeStatus", {}).get("type"),
            "contextUsage": context_usage(state), "compaction": compaction_state(state), "canCompact": can_compact(state),
            "pendingRequests": requests,
            "asyncQuestions": async_questions(state),
            "activeTurnId": active_turn_id(state), "canStop": active_turn_id(state) is not None,
            "recentTurns": [{"id": t.get("turnId"), "status": t.get("status")} for t in turns[-30:] if t.get("turnId")],
            "latestTurnStatus": turns[-1].get("status") if turns else None,
            "turnTiming": turn_timing(turns[-1], observed_at) if turns else None,
            "canSend": allowed, "hint": hint, "hasMore": not state.get("turnsPagination", {}).get("hasLoadedOldest", False) or len(turns) > 30,
            "queueReady": allowed and state.get("threadRuntimeStatus", {}).get("type") == "idle" and
                          (not turns or turns[-1].get("status") == "completed"),
            "latestTurnId": turns[-1].get("turnId") if turns else None}


def main():
    data = json.loads(sys.stdin.buffer.read(70000))
    thread_id = data["threadId"]
    info = plistlib.loads((Path(CONFIG["appPath"]) / "Contents/Info.plist").read_bytes())
    version = info.get("CFBundleShortVersionString", "") + ":" + info.get("CFBundleVersion", "")
    if info.get("CFBundleIdentifier") != "com.openai.codex" or version != CONFIG["supportedVersion"]:
        return {"ok": False, "code": "app_version_changed", "sent": False}
    dispatched = False
    print("POCKET_BRIDGE_PHASE_V1 preflight", file=sys.stderr, flush=True)
    try:
        with NavigatorIPC(Path(data["codexHome"]) / "ipc/ipc.sock") as client:
            if data["operation"] == "history":
                client.owner_lookup_timeout = {5000: 5.0, 10000: 10.0}.get(data.get("ownerLookupTimeoutMs"), 2.0)
            owner, state = client.snapshot(thread_id)
            if data["operation"] == "history":
                return {"ok": True, **history(state)}
            if data["operation"] == "stop":
                target = data.get("expectedTurnId")
                if not isinstance(target, str) or not target:
                    return {"ok": False, "code": "invalid_turn", "sent": False}
                fresh_owner, fresh = client.snapshot(thread_id)
                if fresh_owner != owner or active_turn_id(fresh) != target:
                    return {"ok": False, "code": "turn_changed", "sent": False}
                dispatched = True
                print("POCKET_BRIDGE_PHASE_V1 dispatch", file=sys.stderr, flush=True)
                client.request("thread-follower-interrupt-turn", {"conversationId": thread_id,
                    "mode": "user-stop", "expectedTurnId": target}, 4, owner)
                return {"ok": True, "status": "accepted", "turnId": target}
            if data["operation"] == "respond":
                fresh_owner, fresh = client.snapshot(thread_id)
                shown = next((r for r in pending_requests(fresh) if r["key"] == data.get("requestKey")), None)
                if fresh_owner != owner or fresh.get("resumeState") != "resumed" or not shown:
                    return {"ok": False, "code": "request_changed", "sent": False}
                prepared = prepare_response(fresh, ordered_turns(fresh), data.get("requestKey"), data.get("decision"), data.get("answers"))
                if not prepared:
                    return {"ok": False, "code": "invalid_decision", "sent": False}
                method, params = prepared
                dispatched = True
                print("POCKET_BRIDGE_PHASE_V1 dispatch", file=sys.stderr, flush=True)
                client.request(method, params, 1, owner)
                return {"ok": True, "status": "accepted"}
            if data["operation"] == "compact":
                if not can_compact(state):
                    return {"ok": False, "code": "thread_not_ready", "sent": False}
                fresh_owner, fresh = client.snapshot(thread_id)
                if fresh_owner != owner or not can_compact(fresh) or compaction_state(fresh)["latestId"] != data.get("expectedCompactionId"):
                    return {"ok": False, "code": "thread_changed", "sent": False}
                dispatched = True
                print("POCKET_BRIDGE_PHASE_V1 dispatch", file=sys.stderr, flush=True)
                client.request("thread-follower-compact-thread", {"conversationId": thread_id}, 1, owner)
                return {"ok": True, "status": "accepted"}
            if data["operation"] not in ("send", "answer"):
                return {"ok": False, "code": "unsupported_operation", "sent": False}
            message_id = data["requestId"]
            for turn in ordered_turns(state):
                if (turn.get("params") or {}).get("clientUserMessageId") == message_id:
                    return {"ok": True, "status": "accepted", "turnId": turn.get("turnId")}
                if any(i.get("type") == "steeringUserMessage" and i.get("clientUserMessageId") == message_id and
                       i.get("status") in ("accepted", "pending") for i in turn.get("items", [])):
                    return {"ok": True, "status": "accepted", "turnId": turn.get("turnId")}
            allowed, _ = writable(state)
            if not allowed:
                return {"ok": False, "code": "thread_not_ready", "sent": False}
            if data.get("delivery") != "now" and state.get("threadRuntimeStatus", {}).get("type") == "active":
                return {"ok": False, "code": "thread_active", "sent": False}
            # A second owner/state read narrows the race with another desktop client.
            fresh_owner, fresh = client.snapshot(thread_id)
            if fresh_owner != owner or not writable(fresh)[0]:
                return {"ok": False, "code": "thread_changed", "sent": False}
            active = fresh.get("threadRuntimeStatus", {}).get("type") == "active"
            if data["operation"] == "answer":
                question = next((q for q in async_questions(fresh) if q["key"] == data.get("questionKey")), None)
                if question is None:
                    return {"ok": False, "code": "question_changed", "sent": False}
                data["text"] = "<send_user_message_question_reply>\n" + json.dumps([{
                    "questionItemId": question["id"], "question": question["title"], "answer": data["text"]
                }], ensure_ascii=False, separators=(",", ":")) + "\n</send_user_message_question_reply>"
            if active and data.get("delivery") != "now":
                return {"ok": False, "code": "thread_active", "sent": False}
            turns = ordered_turns(fresh)
            if data.get("delivery") == "resume" and (
                fresh.get("threadRuntimeStatus", {}).get("type") != "idle" or not turns or
                turns[-1].get("turnId") != data.get("resumeAfterTurnId") or turns[-1].get("status") != "interrupted"
            ):
                return {"ok": False, "code": "thread_changed", "sent": False}
            if data.get("delivery") == "auto" and (
                fresh.get("threadRuntimeStatus", {}).get("type") != "idle" or
                (turns and turns[-1].get("status") != "completed")
            ):
                return {"ok": False, "code": "thread_not_ready", "sent": False}
            dispatched = True
            print("POCKET_BRIDGE_PHASE_V1 dispatch", file=sys.stderr, flush=True)
            if active:
                cwd = fresh.get("cwd") or "/"
                restore = {"id": message_id, "text": data["text"], "cwd": cwd, "createdAt": int(time.time()*1000),
                           "context": {"prompt": data["text"], "addedFiles": [], "fileAttachments": [],
                                       "ideContext": None, "imageAttachments": [], "workspaceRoots": [cwd]}}
                client.request("thread-follower-steer-turn", {"conversationId": thread_id,
                    "clientUserMessageId": message_id, "input": [{"type": "text", "text": data["text"], "text_elements": []}],
                    "restoreMessage": restore, "attachments": []}, 1, owner)
            else:
                client.start(thread_id, owner, message_id, data["text"])
            return {"ok": True, "status": "accepted", "turnId": turns[-1].get("turnId") if active and turns else None}
    except Exception:
        return {"ok": False, "code": "dispatch_unknown" if dispatched else "desktop_unavailable", "sent": None if dispatched else False}


if __name__ == "__main__":
    try:
        result = main()
    except Exception:
        result = {"ok": False, "code": "desktop_unavailable", "sent": False}
    print(json.dumps(result, ensure_ascii=False))
