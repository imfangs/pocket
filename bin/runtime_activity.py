"""Display-only activity metadata from the validated latest desktop turn.

Tool completion means the call returned, not that the user's task succeeded.
An in-progress call may still be waiting or stalled. Never copy its body,
command, arguments, output, settings, or reasoning into this projection.
"""
import math
import re

_controls = re.compile(r"[\x00-\x1f\x7f]")
_event_types = frozenset({"agentMessage", "reasoning", "commandExecution", "mcpToolCall",
                          "fileChange", "collabAgentToolCall", "subAgentActivity", "contextCompaction"})
_operation_types = {"commandExecution": "command", "mcpToolCall": "tool", "fileChange": "file",
                    "collabAgentToolCall": "delegation"}


def identifier(value):
    return (isinstance(value, str) and 0 < len(value) <= 128 and value.strip() == value
            and not _controls.search(value))


def timestamp(value, observed_at, start=None):
    if type(value) not in (int, float) or not 0 <= value <= observed_at or not math.isfinite(value):
        return None
    if start is not None and value < start:
        return None
    return value


def mapped(turn, name, item_id):
    values = turn.get(name)
    return values.get(item_id) if isinstance(values, dict) and identifier(item_id) else None


def runtime_activity(turn, observed_at):
    if (not isinstance(turn, dict) or not identifier(turn.get("turnId"))
            or turn.get("status") not in ("inProgress", "completed", "failed", "interrupted")
            or type(observed_at) not in (int, float) or not math.isfinite(observed_at) or observed_at < 0):
        return None
    start = timestamp(turn.get("turnStartedAtMs"), observed_at)
    result = {"turnId": turn["turnId"], "lastEventAt": start, "lastMessageAt": None, "activeOperation": None}
    completed = turn.get("completedItemIds")
    completed = {value for value in completed if identifier(value)} if isinstance(completed, list) else set()
    items = turn.get("items")
    if not isinstance(items, list):
        return result
    selected_at = -1
    for item in items:
        if not isinstance(item, dict):
            continue
        kind, item_id = item.get("type"), item.get("id")
        if not isinstance(kind, str) or kind not in _event_types:
            continue
        started = timestamp(item.get("startedAtMs"), observed_at, start)
        ended = timestamp(item.get("completedAtMs"), observed_at, start)
        starts, ends = [started], [ended]
        if kind == "agentMessage":
            starts.append(timestamp(mapped(turn, "aeonAssistantMessageStartedAtMsById", item_id), observed_at, start))
            ends.append(timestamp(mapped(turn, "agentMessageCompletedAtMsById", item_id), observed_at, start))
        elif kind == "commandExecution":
            starts.append(timestamp(mapped(turn, "commandExecutionStartedAtMsById", item_id), observed_at, start))
        times = [value for value in starts + ends if value is not None]
        if times:
            result["lastEventAt"] = max(times + ([result["lastEventAt"]] if result["lastEventAt"] is not None else []))
            if kind == "agentMessage" and item.get("phase") != "analysis" and isinstance(item.get("text"), str) and item["text"].strip():
                result["lastMessageAt"] = max(times + ([result["lastMessageAt"]] if result["lastMessageAt"] is not None else []))
        operation = _operation_types.get(kind)
        valid_starts = [value for value in starts if value is not None]
        # Require a real start time for a call-level label. Legacy snapshots
        # without timing still retain the turn's independent runtime state.
        if (operation is not None and turn["status"] == "inProgress" and item.get("status") == "inProgress"
                and identifier(item_id) and item_id not in completed and valid_starts
                and item.get("completed") is not True and item.get("completedAtMs") is None):
            candidate_at = max(valid_starts)
            if candidate_at >= selected_at:
                result["activeOperation"] = {"kind": operation, "startedAt": candidate_at}
                selected_at = candidate_at
    return result
