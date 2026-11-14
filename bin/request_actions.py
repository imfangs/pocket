"""Project pending desktop requests and validate responses against a fresh owner snapshot."""
import hashlib
import json
import re


_OPTION_ID = re.compile(r"^[a-f0-9]{64}$")
_SIMPLE_COMMAND_DECISIONS = ("accept", "acceptForSession", "decline", "cancel")
_REFUSALS = ("decline", "cancel")
_AMBIGUOUS_TEXT = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f\ud800-\udfff]")


def _ambiguous(value):
    if isinstance(value, str):
        return _AMBIGUOUS_TEXT.search(value) is not None
    if isinstance(value, list):
        return any(_ambiguous(item) for item in value)
    if isinstance(value, dict):
        return any(_ambiguous(key) or _ambiguous(item) for key, item in value.items())
    return False


def _plain_text(value):
    return isinstance(value, str) and bool(value) and not _ambiguous(value) and "\n" not in value and "\t" not in value


def _visible(value):
    if isinstance(value, str):
        return _AMBIGUOUS_TEXT.sub(lambda match: "\\u%04x" % ord(match.group()), value)
    if isinstance(value, list):
        return [_visible(item) for item in value]
    if isinstance(value, dict):
        return {_visible(key): _visible(item) for key, item in value.items()}
    return value


def _path(value):
    return _plain_text(value) and bool(value.strip()) and len(value) <= 8192


def _permission_path(value):
    if not isinstance(value, dict):
        return False
    kind = value.get("type")
    if kind in ("path", "glob_pattern"):
        field = "path" if kind == "path" else "pattern"
        return set(value) == {"type", field} and _path(value.get(field))
    if kind != "special" or set(value) != {"type", "value"} or not isinstance(value.get("value"), dict):
        return False
    special = value["value"]
    if special.get("kind") in ("root", "minimal", "tmpdir", "slash_tmp"):
        return set(special) == {"kind"}
    return special.get("kind") == "project_roots" and set(special) <= {"kind", "subpath"} and (special.get("subpath") is None or _path(special["subpath"]))


def _permissions(value):
    # Session approval lends exactly this known profile, never arbitrary JSON
    # or fields newly introduced by a later desktop protocol.
    if not isinstance(value, dict) or not set(value) <= {"network", "fileSystem"}:
        return False
    network = value.get("network")
    if network is not None and (not isinstance(network, dict) or not set(network) <= {"enabled"} or
                                network.get("enabled") is not None and not isinstance(network["enabled"], bool)):
        return False
    files = value.get("fileSystem")
    if files is None:
        return True
    if not isinstance(files, dict) or not set(files) <= {"read", "write", "entries", "globScanMaxDepth"}:
        return False
    for key in ("read", "write"):
        paths = files.get(key)
        if paths is not None and (not isinstance(paths, list) or len(paths) > 256 or not all(_path(path) for path in paths)):
            return False
    depth = files.get("globScanMaxDepth")
    if depth is not None and (type(depth) is not int or not 1 <= depth <= 2**53 - 1):
        return False
    entries = files.get("entries")
    return entries is None or isinstance(entries, list) and len(entries) <= 256 and all(
        isinstance(entry, dict) and set(entry) == {"access", "path"} and
        entry.get("access") in ("read", "write", "deny") and _permission_path(entry.get("path")) for entry in entries)


def _execpolicy(value):
    return isinstance(value, list) and 1 <= len(value) <= 128 and _plain_text(value[0]) and all(
        isinstance(token, str) and len(token) <= 4096 and not _ambiguous(token) and "\n" not in token and "\t" not in token for token in value)


def _network_policy(value):
    return isinstance(value, dict) and set(value) == {"host", "action"} and value.get("action") in ("allow", "deny") and \
        _plain_text(value.get("host")) and len(value["host"]) <= 4096 and not any(c.isspace() for c in value["host"])


def _option_id(key, native, kind, context):
    # Legacy request keys also index durable accepted/unknown receipts, so their
    # preimage must not change. Only the new option identity binds this owner
    # context, including older requests with no params.threadId.
    return fingerprint(["pocket-approval-option-v2", context, key, native, kind])


def _decision_option(decision, key, context, human=False):
    if isinstance(decision, str) and decision in _SIMPLE_COMMAND_DECISIONS:
        if human and decision == "acceptForSession":
            return None
        result = {"kind": decision, "scope": "session" if decision == "acceptForSession" else "once"}
    elif not human and isinstance(decision, dict) and set(decision) == {"acceptWithExecpolicyAmendment"}:
        value = decision["acceptWithExecpolicyAmendment"]
        if not isinstance(value, dict) or set(value) != {"execpolicy_amendment"} or not _execpolicy(value["execpolicy_amendment"]):
            return None
        result = {"kind": "execpolicy", "scope": "rule", "rule": value["execpolicy_amendment"]}
    elif not human and isinstance(decision, dict) and set(decision) == {"applyNetworkPolicyAmendment"}:
        value = decision["applyNetworkPolicyAmendment"]
        if not isinstance(value, dict) or set(value) != {"network_policy_amendment"} or not _network_policy(value["network_policy_amendment"]):
            return None
        policy = value["network_policy_amendment"]
        result = {"kind": "networkPolicy", "scope": "rule", "host": policy["host"], "action": policy["action"]}
    else:
        return None
    result["id"] = _option_id(key, decision, result["kind"], context)
    return result


def _command_options(params, key, context):
    kind = params.get("kind", "command")
    human = kind == "humanCommand"
    if params.get("availableDecisions") is None:
        # The installed desktop's notification actions and managed-network UI
        # both offer acceptForSession without the experimental decision list.
        decisions = list(_SIMPLE_COMMAND_DECISIONS if not human else ("accept", "decline", "cancel"))
        if not human and _execpolicy(params.get("proposedExecpolicyAmendment")):
            decisions.append({"acceptWithExecpolicyAmendment": {"execpolicy_amendment": params["proposedExecpolicyAmendment"]}})
        if not human and isinstance(params.get("proposedNetworkPolicyAmendments"), list):
            decisions.extend({"applyNetworkPolicyAmendment": {"network_policy_amendment": value}}
                             for value in params["proposedNetworkPolicyAmendments"] if _network_policy(value))
    else:
        decisions = params["availableDecisions"] if isinstance(params["availableDecisions"], list) else []
    if kind not in ("command", "writeStdin", "humanCommand") or params.get("additionalPermissions") is not None and not _permissions(params["additionalPermissions"]):
        decisions = [value for value in decisions if isinstance(value, str) and value in _REFUSALS]
    result, seen = [], set()
    for decision in decisions[:64]:
        option = _decision_option(decision, key, context, human)
        if option and option["id"] not in seen:
            result.append(option)
            seen.add(option["id"])
    return result


def _file_complete(changes):
    return isinstance(changes, list) and bool(changes) and all(
        isinstance(change, dict) and _path(change.get("path")) and isinstance(change.get("diff"), str) for change in changes)


def _file_changes(params, turns):
    for turn in turns if isinstance(turns, list) else []:
        if not isinstance(turn, dict) or turn.get("turnId") != params.get("turnId"):
            continue
        items = turn.get("items")
        if not isinstance(items, list):
            continue
        for item in items:
            if isinstance(item, dict) and item.get("type") == "fileChange" and item.get("id") == params.get("itemId"):
                return item.get("changes")
    return None


def _permission_options(permissions, key, context):
    result = []
    if _permissions(permissions):
        for scope, kind in (("turn", "permissionTurn"), ("session", "permissionSession")):
            native = {"permissions": permissions, "scope": scope}
            result.append({"id": _option_id(key, native, kind, context), "kind": kind, "scope": scope})
    denial = {"permissions": {}, "scope": "turn"}
    result.append({"id": _option_id(key, denial, "cancel", context), "kind": "cancel", "scope": "turn"})
    return result


def _native_option(option, request):
    kind = option["kind"]
    if kind == "execpolicy":
        return {"acceptWithExecpolicyAmendment": {"execpolicy_amendment": option["rule"]}}
    if kind == "networkPolicy":
        return {"applyNetworkPolicyAmendment": {"network_policy_amendment": {"host": option["host"], "action": option["action"]}}}
    if request.get("method") == "item/permissions/requestApproval":
        return {"permissions": {} if kind == "cancel" else request["params"]["permissions"], "scope": option["scope"]}
    return kind


def fingerprint(value):
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    try:
        encoded = canonical.encode("utf-8")
    except UnicodeEncodeError:
        # Valid historical UTF-8 request hashes remain byte-for-byte identical.
        # Malformed Unicode could never have had such a hash; tag only its new
        # deterministic fallback and keep it outside the reviewable grant path.
        encoded = b"pocket-invalid-unicode-key-v1\x00" + json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    return hashlib.sha256(encoded).hexdigest()


def request_view(request, state, turns):
    if not isinstance(request, dict) or request.get("params") is not None and not isinstance(request["params"], dict):
        return None
    params = request.get("params") or {}
    if params.get("threadId") is not None and params["threadId"] != state.get("id"):
        return None
    method = request.get("method")
    shown = {"key": fingerprint(request), "kind": "unsupported", "reason": str(params.get("reason") or "需要你确认操作"),
             "cwd": str(params.get("cwd") or state.get("cwd") or ""), "choices": [], "details": ""}
    option_context = {"conversationId": state.get("id"), "hostId": state.get("hostId")}
    changes = None
    if method == "item/commandExecution/requestApproval":
        command = params.get("command")
        network = params.get("networkApprovalContext")
        if not isinstance(command, str) and not isinstance(network, dict):
            return None
        shown.update(kind="command", command=command if isinstance(command, str) else "", reason=str(params.get("reason") or "确认这次命令执行"))
        details = {k: params[k] for k in ("kind", "networkApprovalContext", "additionalPermissions", "environmentId") if params.get(k) is not None}
        shown["details"] = json.dumps(details, ensure_ascii=False, indent=2) if details else ""
        shown["approvalOptions"] = _command_options(params, shown["key"], option_context)
        shown["choices"] = [option["kind"] for option in shown["approvalOptions"] if option["kind"] in ("accept", "cancel")]
    elif method == "item/fileChange/requestApproval":
        changes = _file_changes(params, turns)
        shown.update(kind="file", reason=str(params.get("reason") or "确认文件改动"), choices=["cancel"])
        shown["key"] = fingerprint({"request": request, "changes": changes})
        complete = _file_complete(changes)
        if complete:
            shown["details"] = json.dumps(changes, ensure_ascii=False, indent=2)
            if params.get("grantRoot") is None:
                shown["choices"].append("accept")
        else:
            shown["details"] = "改动内容尚未加载，请在 Mac 查看后处理。"
        if params.get("grantRoot"):
            shown["details"] += "\n本会话目录写入范围：" + str(params["grantRoot"])
        grant_root = params.get("grantRoot")
        decisions = list(_SIMPLE_COMMAND_DECISIONS) if complete and (grant_root is None or _path(grant_root)) else list(_REFUSALS)
        shown["approvalOptions"] = [_decision_option(value, shown["key"], option_context) for value in decisions]
        if grant_root is not None:
            for option in shown["approvalOptions"]:
                if option["kind"] in ("accept", "acceptForSession"):
                    option.update(scope="session", grantRoot=grant_root)
    elif method == "item/permissions/requestApproval":
        permissions = params.get("permissions")
        shown.update(kind="permissions", reason=str(params.get("reason") or "确认本轮所需权限"), choices=["cancel"])
        if _permissions(permissions):
            shown["details"] = json.dumps(permissions, ensure_ascii=False, indent=2)
            shown["choices"].append("accept")
        else:
            shown["details"] = "权限内容暂不支持，请在 Mac 查看后处理。"
        shown["approvalOptions"] = _permission_options(permissions, shown["key"], option_context)
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
    if _ambiguous(request) or _ambiguous(changes) or _ambiguous(option_context) or _ambiguous(shown):
        # Display escaping alone cannot authorize a native operation. Both
        # projection and prepare_response use this exact reviewed option set.
        shown["approvalOptions"] = [option for option in shown.get("approvalOptions", []) if option["kind"] in _REFUSALS]
        shown["choices"] = [value for value in shown["choices"] if value == "cancel"]
        if shown["kind"] == "questions":
            shown["questions"] = []
        shown["details"] = "内容中含有无法明确展示的字符，请在 Mac 查看后处理。\n" + shown["details"]
        shown = _visible(shown)
    # Never offer approval for content omitted from the review surface.
    if len(json.dumps(shown, ensure_ascii=False)) > 60000:
        refusals = [option for option in shown.get("approvalOptions", []) if option["kind"] in _REFUSALS]
        shown.update(reason="需要处理的请求", details="请求内容过长，请在 Mac 查看完整内容后处理。", command="", questions=[], choices=["cancel"] if "cancel" in shown["choices"] else [])
        shown["approvalOptions"] = refusals
    return shown


def projected_requests(state, turns):
    result = []
    for request in state.get("requests", []):
        shown = request_view(request, state, turns)
        if shown:
            result.append(shown)
    return result[:20]


def prepare_response(state, turns, key, decision=None, answers=None, option_id=None):
    for request in state.get("requests", []):
        shown = request_view(request, state, turns)
        if shown and shown["key"] == key:
            break
    else:
        return None
    base = {"conversationId": state["id"], "requestId": request["id"]}
    if shown["kind"] == "questions":
        questions = shown.get("questions") or []
        if option_id is not None or decision is not None or not questions or not isinstance(answers, dict) or set(answers) != {q["id"] for q in questions}:
            return None
        if any(not isinstance(v, str) or not v.strip() or len(v) > 16000 for v in answers.values()) or sum(map(len, answers.values())) > 32000:
            return None
        return "thread-follower-submit-user-input", {**base, "response": {"answers": {k: {"answers": [v]} for k, v in answers.items()}}}
    if option_id is not None:
        if answers is not None or decision is not None or not isinstance(option_id, str) or not _OPTION_ID.fullmatch(option_id):
            return None
        option = next((value for value in shown.get("approvalOptions", []) if value["id"] == option_id), None)
        if option is None:
            return None
        response = _native_option(option, request)
        if shown["kind"] in ("command", "file"):
            return "thread-follower-" + ("command" if shown["kind"] == "command" else "file") + "-approval-decision", {**base, "decision": response}
        if shown["kind"] == "permissions":
            return "thread-follower-permissions-request-approval-response", {**base, "response": response}
        return None
    if answers is not None or not isinstance(decision, str) or decision not in shown["choices"]:
        return None
    if shown["kind"] in ("command", "file"):
        return "thread-follower-" + ("command" if shown["kind"] == "command" else "file") + "-approval-decision", {**base, "decision": decision}
    if shown["kind"] == "permissions":
        permissions = request["params"]["permissions"] if decision == "accept" else {}
        return "thread-follower-permissions-request-approval-response", {**base, "response": {"permissions": permissions, "scope": "turn"}}
    return None
