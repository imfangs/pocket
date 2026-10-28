import { machineStorageKey } from "./machineScope.ts";

const key = "pocket.creation-confirmed-at.v1";
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const validTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Date.now() + 60000;

// Session-only UI metadata. Never stores a Query, and never makes a creation
// successful; it just prevents reloads from renewing an observed green cue.
export function readCreationConfirmations(storage?: Pick<Storage, "getItem">): Map<string, number> {
  try {
    const values: unknown = JSON.parse((storage ?? sessionStorage).getItem(machineStorageKey(key)) || "[]");
    if (!Array.isArray(values)) return new Map();
    const result = new Map<string, number>();
    for (const value of values.slice(-100)) if (Array.isArray(value) && validId(value[0]) && validTime(value[1]))
      result.set(value[0], Math.min(result.get(value[0]) ?? value[1], value[1]));
    return result;
  } catch { return new Map(); }
}

export function saveCreationConfirmations(values: ReadonlyMap<string, number>, storage?: Pick<Storage, "setItem">) {
  try {
    const entries = [...values].filter(([id, time]) => validId(id) && validTime(time)).sort((a, b) => a[1] - b[1]).slice(-100);
    (storage ?? sessionStorage).setItem(machineStorageKey(key), JSON.stringify(entries));
  } catch { /* In-page confirmation still applies if storage is unavailable. */ }
}
