import { currentMachineId, machineStorageKey, type MachineId } from "./machineScope.ts";
import type { History } from "./conversationFeed";

export const sendingPreferenceKey = "pocket.auto-direct-send.v1";
const changedEvent = "pocket-sending-preference-changed";
type PreferenceBrowser = Pick<Window, "localStorage" | "addEventListener" | "removeEventListener" | "dispatchEvent">;
type PreferenceChange = { key: string; enabled: boolean; persisted: boolean };

export function createSendingPreferenceStore({
  browser = () => typeof window === "undefined" ? undefined : window,
  machine = currentMachineId,
}: { browser?: () => PreferenceBrowser | undefined; machine?: () => MachineId | null } = {}) {
  // If browser storage is unavailable, an explicit choice still applies for
  // this page. Only a boolean preference is stored; messages remain untouched.
  const transient = new Map<string, boolean>();
  const key = () => { const id = machine(); return id ? machineStorageKey(sendingPreferenceKey, id) : null; };
  const read = () => {
    const scopedKey = key();
    if (!scopedKey) return true;
    if (transient.has(scopedKey)) return transient.get(scopedKey)!;
    try { return browser()?.localStorage.getItem(scopedKey) !== "false"; }
    catch { return true; }
  };
  const save = (enabled: boolean) => {
    const target = browser(), scopedKey = key();
    if (!target || !scopedKey) return;
    let persisted = false;
    try { target.localStorage.setItem(scopedKey, String(enabled)); transient.delete(scopedKey); persisted = true; }
    catch { transient.set(scopedKey, enabled); }
    target.dispatchEvent(new CustomEvent<PreferenceChange>(changedEvent, { detail: { key: scopedKey, enabled, persisted } }));
  };
  const subscribe = (notify: () => void) => {
    const target = browser(), scopedKey = key();
    if (!target || !scopedKey) return () => {};
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<PreferenceChange>).detail;
      if (detail?.key !== scopedKey) return;
      if (detail.persisted) transient.delete(scopedKey); else transient.set(scopedKey, detail.enabled);
      notify();
    };
    const stored = (event: StorageEvent) => {
      if (event.key !== null && event.key !== scopedKey) return;
      try { if (event.storageArea && event.storageArea !== target.localStorage) return; }
      catch { return; }
      transient.delete(scopedKey);
      notify();
    };
    target.addEventListener(changedEvent, changed);
    target.addEventListener("storage", stored);
    return () => { target.removeEventListener(changedEvent, changed); target.removeEventListener("storage", stored); };
  };
  return { read, save, subscribe };
}

const sendingPreference = createSendingPreferenceStore();
export const readAutoDirectPreference = sendingPreference.read;
export const saveAutoDirectPreference = sendingPreference.save;
export const subscribeSendingPreference = sendingPreference.subscribe;

export function shouldEnqueueNewMessage(
  autoDirect: boolean,
  history: Pick<History, "source" | "runtime" | "canSend" | "outbox" | "queuePaused"> | null | undefined,
  blocked = false,
) {
  return blocked || history?.source !== "desktop" || !history.canSend || !!history.outbox?.length ||
    !!history.queuePaused || (history.runtime === "active" && !autoDirect);
}
