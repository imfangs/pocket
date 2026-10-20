import { useMemo, useSyncExternalStore } from "react";
import { currentMachineId, machineStorageKey, type MachineId } from "./machineScope.ts";

export type ControlKind = "compact" | "stop";
export type ControlIdentity = {
  threadId: string;
  kind: ControlKind;
  requestId: string;
  targetTurnId?: string;
};
export type ControlReceipt = { requestId: string; status: string; targetTurnId?: string };
export type ControlState = { identity: ControlIdentity; status: string; posting: boolean };
type RequestStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9_-]{1,160}$/i.test(value);
export const controlUnresolved = (status?: string) => ["pending", "accepted", "unknown"].includes(status || "");
const terminalStatuses: Record<ControlKind, string[]> = {
  compact: ["completed", "failed", "rejected", "not_found"],
  stop: ["stopped", "ended", "rejected", "not_found"],
};

/** One owner outlives a detail view. Storage contains identities, never message text. */
export function createControlRequests(storage: () => RequestStorage = () => sessionStorage, machine: () => MachineId | null = currentMachineId) {
  const owners = new Map<string, ReturnType<typeof createOwner>>();
  function createOwner(threadId: string, kind: ControlKind, key: string) {
    const read = (): ControlIdentity | null => {
      try {
        const value = JSON.parse(storage().getItem(key) || "null");
        if (value?.threadId !== threadId || value?.kind !== kind || !validId(value?.requestId) ||
          value.targetTurnId !== undefined && !validId(value.targetTurnId)) return null;
        return { threadId, kind, requestId: value.requestId, ...(kind === "stop" && value.targetTurnId ? { targetTurnId: value.targetTurnId } : {}) };
      } catch { return null; }
    };
    const remember = (identity: ControlIdentity) => {
      try {
        const value = JSON.stringify(identity), target = storage();
        target.setItem(key, value);
        return target.getItem(key) === value;
      } catch { return false; }
    };
    const forget = (identity: ControlIdentity) => {
      try { if (read()?.requestId === identity.requestId) storage().removeItem(key); }
      catch { /* A failed removal can require another read after refresh, never another POST. */ }
    };
    const restored = read();
    let state: ControlState | null = restored ? { identity: restored, status: "unknown", posting: false } : null;
    const listeners = new Set<() => void>();
    const publish = (next: ControlState) => { state = next; listeners.forEach(listener => listener()); };
    const receive = (receipt: ControlReceipt | null | undefined, source: "history" | "check" | "post") => {
      if (!state || !receipt || receipt.requestId !== state.identity.requestId ||
          receipt.targetTurnId && state.identity.targetTurnId && receipt.targetTurnId !== state.identity.targetTurnId) return false;
      const terminal = terminalStatuses[kind].includes(receipt.status);
      if (!terminal && !controlUnresolved(receipt.status)) return false;
      // An early GET may beat the original POST to the Mac. It cannot cancel
      // an in-flight request, nor may a late pending reply undo a final result.
      if (receipt.status === "not_found" && (source !== "check" || state.posting)) return false;
      if (terminalStatuses[kind].includes(state.status)) return false;
      if (terminal && !state.posting) forget(state.identity);
      if (state.status !== receipt.status) publish({ ...state, status: receipt.status });
      return true;
    };
    return {
      getSnapshot: () => state,
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      begin(requestId: string, targetTurnId?: string) {
        if (!validId(threadId) || !validId(requestId) || kind === "stop" && !validId(targetTurnId) ||
            state && (state.posting || controlUnresolved(state.status))) return false;
        const identity: ControlIdentity = { threadId, kind, requestId, ...(kind === "stop" ? { targetTurnId } : {}) };
        if (!remember(identity)) return false;
        publish({ identity, status: "pending", posting: true });
        return true;
      },
      observe(receipt: ControlReceipt | null | undefined) {
        if (!receipt || !validId(receipt.requestId)) return;
        if ((!state || !state.posting && !controlUnresolved(state.status)) && controlUnresolved(receipt.status) && state?.identity.requestId !== receipt.requestId) {
          const identity: ControlIdentity = { threadId, kind, requestId: receipt.requestId,
            ...(kind === "stop" && validId(receipt.targetTurnId) ? { targetTurnId: receipt.targetTurnId } : {}) };
          // An observed server request can still be checked if storage is
          // unavailable; only creating a new request requires durable identity.
          remember(identity);
          publish({ identity, status: receipt.status, posting: false });
        } else receive(receipt, "history");
      },
      receive,
      finishPost(requestId: string) {
        if (!state || state.identity.requestId !== requestId || !state.posting) return;
        if (terminalStatuses[kind].includes(state.status)) forget(state.identity);
        publish({ ...state, posting: false });
      },
    };
  }
  return {
    for(threadId: string, kind: ControlKind) {
      const key = machineStorageKey(`pocket.control-request.v1.${kind}.${threadId}`, machine());
      let owner = owners.get(key);
      if (!owner) { owner = createOwner(threadId, kind, key); owners.set(key, owner); }
      return owner;
    },
  };
}

export function controlReceipt(state: ControlState | null, history: ControlReceipt | null | undefined): ControlReceipt | null {
  if (state && (state.posting || controlUnresolved(state.status) || !history || state.identity.requestId === history.requestId)) {
    return { requestId: state.identity.requestId, status: state.status, ...(state.identity.targetTurnId ? { targetTurnId: state.identity.targetTurnId } : {}) };
  }
  return history || null;
}

const requests = createControlRequests();
const serverSnapshot = () => null;
export function useControlRequest(threadId: string, kind: ControlKind) {
  const owner = useMemo(() => requests.for(threadId, kind), [threadId, kind]);
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, serverSnapshot);
  return { owner, state };
}
