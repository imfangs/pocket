import { initialCreationDirectory, type CreationDirectory } from "./creationLocations.ts";

export type CreationPreference = { cwd: string; locationId: string };
const storageKey = "pocket.creation-location.v1";

export function readCreationPreference(storage?: Pick<Storage, "getItem">): CreationPreference | null {
  try {
    const value = JSON.parse((storage ?? localStorage).getItem(storageKey) || "null");
    if (!value || typeof value.cwd !== "string" || !value.cwd.startsWith("/") || value.cwd.length > 8192 ||
      typeof value.locationId !== "string" || value.locationId.length > 512) return null;
    return { cwd: value.cwd, locationId: value.locationId };
  } catch { return null; }
}

export function saveCreationPreference(value: CreationPreference, storage?: Pick<Storage, "setItem">) {
  if (!value.cwd) return;
  try { (storage ?? localStorage).setItem(storageKey, JSON.stringify(value)); }
  catch { /* A blocked preference store must not prevent creating a task. */ }
}

export function initialCreationSelection(directories: readonly CreationDirectory[], saved: CreationPreference | null, preferredCwd?: string): CreationPreference & { unavailable?: true } {
  const remembered = directories.find(directory => directory.cwd === saved?.cwd);
  if (saved && (!remembered || saved.locationId && !remembered.locations.some(location => location.id === saved.locationId)))
    return { cwd: "", locationId: "", unavailable: true };
  if (remembered) return { cwd: remembered.cwd,
    locationId: remembered.locations.find(location => location.id === saved?.locationId)?.id || "" };
  return { cwd: initialCreationDirectory(directories, preferredCwd), locationId: "" };
}
