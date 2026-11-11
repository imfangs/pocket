"""Bounded display-only failure facts from validated native turns."""
import math
import re

MAX_FAILURES = 30
MAX_MESSAGE = 2000
MAX_DETAILS = 4000
MAX_CODE = 128
_controls = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def text(value, limit):
    if not isinstance(value, str):
        return None
    value = _controls.sub("", value).strip()
    return value[:limit] if value else None


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 8640000000000000 else None


def failure(turn):
    if not isinstance(turn, dict) or turn.get("status") != "failed":
        return None
    turn_id = turn.get("turnId")
    if not isinstance(turn_id, str) or not turn_id or turn_id.strip() != turn_id or len(turn_id) > 128 or _controls.search(turn_id):
        return None
    result = {"turnId": turn_id}
    error = turn.get("error")
    if isinstance(error, dict):
        message = text(error.get("message"), MAX_MESSAGE)
        if message is not None:
            result["message"] = message
        details = error.get("additionalDetails")
        if details is None:
            result["additionalDetails"] = None
        else:
            details = text(details, MAX_DETAILS)
            if details is not None:
                result["additionalDetails"] = details
        for key in ("code", "codexErrorInfo", "codex_error_info"):
            code = text(error.get(key), MAX_CODE)
            if code is not None and re.fullmatch(r"[A-Za-z0-9_:-]+", code):
                result["code"] = code
                break
    start, duration = number(turn.get("turnStartedAtMs")), number(turn.get("durationMs"))
    if start is not None and duration is not None and number(start + duration) is not None:
        result["timestamp"] = start + duration
    return result


def turn_failures(turns, visible_turn_ids=None):
    # Current history renders its latest 30 turns. If a caller has an earlier
    # visible window, admit those exact identities too, still bounded to 30.
    visible = set(visible_turn_ids or [])
    selected = [(index, turn) for index, turn in enumerate(turns) if isinstance(turn, dict)
                and (index >= len(turns) - MAX_FAILURES or turn.get("turnId") in visible)]
    result, seen = [], set()
    for _, turn in reversed(selected):
        value = failure(turn)
        if value is not None and value["turnId"] not in seen:
            result.append(value)
            seen.add(value["turnId"])
            if len(result) >= MAX_FAILURES:
                break
    return list(reversed(result))


def latest_turn_id(turns):
    value = turns[-1].get("turnId") if turns else None
    return value if isinstance(value, str) and 0 < len(value) <= 128 and value.strip() == value and not _controls.search(value) else None
