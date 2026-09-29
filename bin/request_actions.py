"""Project pending desktop requests and validate responses against a fresh owner snapshot."""
import hashlib
import json


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def request_view(request, state, turns):
    params = request.get("params") or {}
    method = request.get("method")
    shown = {"key": fingerprint(request), "kind": "unsupported", "reason": str(params.get("reason") or "需要你确认操作"),
             "cwd": str(params.get("cwd") or state.get("cwd") or ""), "choices": [], "details": ""}
    if method == "item/commandExecution/requestApproval":
        command = params.get("command")
        network = params.get("networkApprovalContext")
        if not isinstance(command, str) and not isinstance(network, dict):
            return None
        shown.update(kind="command", command=command if isinstance(command, str) else "", reason=str(params.get("reason") or "确认这次命令执行"))
        details = {k: params[k] for k in ("kind", "networkApprovalContext", "additionalPermissions", "environmentId") if params.get(k) is not None}
        shown["details"] = json.dumps(details, ensure_ascii=False, indent=2) if details else ""
        decisions = params.get("availableDecisions")
        shown["choices"] = [d for d in (decisions if isinstance(decisions, list) else ["accept", "cancel"]) if d in ("accept", "cancel")]
    elif method == "item/fileChange/requestApproval":
        item = next((i for t in turns if t.get("turnId") == params.get("turnId") for i in t.get("items", [])
                     if i.get("type") == "fileChange" and i.get("id") == params.get("itemId")), None)
        changes = item.get("changes") if item else None
        shown.update(kind="file", reason=str(params.get("reason") or "确认文件改动"), choices=["cancel"])
        shown["key"] = fingerprint({"request": request, "changes": changes})
        if isinstance(changes, list) and changes:
            shown["details"] = json.dumps(changes, ensure_ascii=False, indent=2)
            if not params.get("grantRoot"):
                shown["choices"].append("accept")
        else:
            shown["details"] = "改动内容尚未加载，请在 Mac 查看后处理。"
        if params.get("grantRoot"):
            shown["details"] += "\n该请求包含会话范围目录授权，请在 Mac 处理：" + str(params["grantRoot"])
    elif method == "item/permissions/requestApproval":
        permissions = params.get("permissions")
        shown.update(kind="permissions", reason=str(params.get("reason") or "确认本轮所需权限"), choices=["cancel"])
        if isinstance(permissions, dict) and set(permissions) <= {"network", "fileSystem"}:
            shown["details"] = json.dumps(permissions, ensure_ascii=False, indent=2)
            shown["choices"].append("accept")
    elif method == "item/tool/requestUserInput":
        questions = params.get("questions")
        if not isinstance(questions, list) or not 1 <= len(questions) <= 10:
            return None
        if any(not isinstance(q, dict) or not isinstance(q.get("id"), str) or not isinstance(q.get("question"), str) for q in questions):
            return None
        if len({q["id"] for q in questions}) != len(questions):
            return None
        for q in questions:
            if not q["id"] or len(q["id"]) > 128 or q["id"] in ("__proto__", "constructor", "prototype") or len(q["question"]) > 8000:
                return None
            options = q.get("options")
            if options is not None and (not isinstance(options, list) or len(options) > 20 or any(
                not isinstance(o, dict) or not isinstance(o.get("label"), str) or not o["label"] or len(o["label"]) > 2000 or
                not isinstance(o.get("description", ""), str) or len(o.get("description", "")) > 8000 for o in options)):
                return None
        shown.update(kind="questions", reason="请回答后继续", questions=questions, choices=[])
    elif method == "mcpServer/elicitation/request":
        shown.update(reason="MCP 请求：" + str(params.get("message") or params.get("serverName") or "需要处理"))
        shown["details"] = "此类 MCP 表单暂需在 Mac 处理。"
    else:
        shown["details"] = "此类请求暂需在 Mac 处理。"
    # Never offer approval for content omitted from the review surface.
    if len(json.dumps(shown, ensure_ascii=False)) > 60000:
        shown.update(reason="需要处理的请求", details="请求内容过长，请在 Mac 查看完整内容后处理。", command="", questions=[], choices=["cancel"] if shown["kind"] in ("command", "file", "permissions") else [])
    return shown


def projected_requests(state, turns):
    result = []
    for request in state.get("requests", []):
        shown = request_view(request, state, turns)
        if shown:
            result.append(shown)
    return result[:20]


def prepare_response(state, turns, key, decision=None, answers=None):
    for request in state.get("requests", []):
        shown = request_view(request, state, turns)
        if shown and shown["key"] == key:
            break
    else:
        return None
    base = {"conversationId": state["id"], "requestId": request["id"]}
    if shown["kind"] == "questions":
        questions = shown.get("questions") or []
        if decision is not None or not questions or not isinstance(answers, dict) or set(answers) != {q["id"] for q in questions}:
            return None
        if any(not isinstance(v, str) or not v.strip() or len(v) > 16000 for v in answers.values()) or sum(map(len, answers.values())) > 32000:
            return None
        return "thread-follower-submit-user-input", {**base, "response": {"answers": {k: {"answers": [v]} for k, v in answers.items()}}}
    if answers is not None or decision not in shown["choices"]:
        return None
    if shown["kind"] in ("command", "file"):
        return "thread-follower-" + ("command" if shown["kind"] == "command" else "file") + "-approval-decision", {**base, "decision": decision}
    if shown["kind"] == "permissions":
        permissions = request["params"]["permissions"] if decision == "accept" else {}
        return "thread-follower-permissions-request-approval-response", {**base, "response": {"permissions": permissions, "scope": "turn"}}
    return None
