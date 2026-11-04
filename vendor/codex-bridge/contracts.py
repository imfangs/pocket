"""Validate the IPC data used for retry decisions, independently of App releases."""
import math


class CompatibilityError(RuntimeError):
    pass


def require(condition, field, history=False):
    if not condition:
        prefix = "unsupported_task_history:" if history else "unsupported_task_state:"
        raise CompatibilityError(prefix + field)


def ordered_turns(state):
    require(isinstance(state, dict), "object")
    history = state.get("turnHistory")
    if history is None:
        turns = state.get("turns")
        require(isinstance(turns, list), "turns", history=True)
        require(all(isinstance(turn, dict) for turn in turns), "turn", history=True)
        return turns
    require(isinstance(history, dict) and history.get("kind") == "canonical", "kind", history=True)
    history = history.get("history")
    require(isinstance(history, dict), "canonical", history=True)
    entities, islands = history.get("entitiesByKey"), history.get("islands")
    require(isinstance(entities, dict) and isinstance(islands, list), "collections", history=True)
    if islands:
        tail = islands[-1]
        require(isinstance(tail, dict) and isinstance(tail.get("newerBoundary"), dict)
                and tail["newerBoundary"].get("status") == "exhausted", "latest_boundary", history=True)
    turns = []
    for island in islands:
        require(isinstance(island, dict) and isinstance(island.get("entries"), list), "island", history=True)
        for entry in island["entries"]:
            require(isinstance(entry, dict) and isinstance(entry.get("value"), str), "entry", history=True)
            turn = entities.get(entry["value"])
            require(isinstance(turn, dict), "entity_reference", history=True)
            turns.append(turn)
    require(bool(turns) or not entities, "empty_islands", history=True)
    return turns


def describe(state, expected_id=None):
    require(isinstance(state, dict), "object")
    require(isinstance(state.get("id"), str) and bool(state["id"])
            and (expected_id is None or state["id"] == expected_id), "identity")
    require(state.get("hostId") == "local", "host")
    runtime = state.get("threadRuntimeStatus")
    require(isinstance(runtime, dict) and runtime.get("type") in ("active", "idle", "systemError"), "runtime")
    require(isinstance(state.get("requests"), list), "requests")
    flags = runtime.get("activeFlags", [])
    require(isinstance(flags, list) and all(isinstance(flag, str) for flag in flags), "activeFlags")
    unconfirmed = state.get("unconfirmedTurnSubmissions", [])
    require(isinstance(unconfirmed, list), "unconfirmedTurnSubmissions")
    turns = ordered_turns(state)
    local_turns = state.get("turns", [])
    require(isinstance(local_turns, list), "turns")
    last = turns[-1] if turns else {}
    model, effort = state.get("latestModel"), state.get("latestReasoningEffort")
    if turns:
        require(isinstance(last.get("turnId"), str) and bool(last["turnId"]), "turn_id")
        require(last.get("status") in ("inProgress", "completed", "failed", "interrupted"), "turn_status")
        require(isinstance(model, str) and bool(model.strip()), "model")
        require("latestReasoningEffort" in state and
                (effort is None or isinstance(effort, str) and bool(effort.strip())), "effort")
    error = last.get("error")
    require(error is None or isinstance(error, dict), "error")
    start, duration = last.get("turnStartedAtMs"), last.get("durationMs")
    for field, value in (("turnStartedAtMs", start), ("durationMs", duration)):
        if value is not None or last.get("status") == "failed":
            require(type(value) in (int, float) and math.isfinite(value) and value >= 0, field)
    provisional = state.get("turnHistory") is not None and bool(local_turns)
    side = state.get("sideConversation")
    return {"thread_id": state["id"], "runtime": runtime["type"],
            "turn_id": last.get("turnId"), "turn_status": last.get("status"),
            "model": model, "effort": effort, "started": (start or 0) / 1000,
            "finished": ((start or 0) + (duration or 0)) / 1000, "error": error or {},
            "pending": bool(state["requests"] or unconfirmed or flags or provisional
                            or state.get("threadGoalResumeConfirmation")),
            "side_conversation": (side is not None and side is not False) or bool(state.get("agentNickname")),
            # Compare available execution settings, without guessing defaults or
            # adding them to the public scan report.
            "execution_context": {key: state[key] for key in
                                  ("cwd", "currentPermissions", "latestThreadSettings", "modelProvider", "shellEnvironmentPolicy")
                                  if key in state}}
