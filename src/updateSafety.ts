import { useLayoutEffect, useRef } from "react";

type ReloadGuard = () => string | null;
const unfinished = "操作尚未完成，请稍后更新。";

// Keep only getters and fixed UI reasons in memory. Drafts, answers and secrets
// remain owned by their existing components; this registry never persists them.
export function createReloadSafety() {
  const guards = new Map<symbol, ReloadGuard>();
  const holds = new Map<symbol, string>();
  return {
    register(getter: ReloadGuard) {
      const id = Symbol();
      guards.set(id, getter);
      return () => { guards.delete(id); };
    },
    hold(reason = unfinished) {
      const id = Symbol();
      holds.set(id, reason);
      return () => { holds.delete(id); };
    },
    getBlocker(): string | null {
      for (const reason of holds.values()) return reason;
      for (const getter of guards.values()) {
        try {
          const reason = getter();
          if (reason) return reason;
        } catch {
          // An unavailable guard cannot establish that reloading is safe.
          return unfinished;
        }
      }
      return null;
    },
  };
}

const safety = createReloadSafety();
export const registerReloadGuard = safety.register;
export const holdReload = safety.hold;
export const getReloadBlocker = safety.getBlocker;

export function useReloadGuard(getter: ReloadGuard) {
  const latest = useRef(getter);
  latest.current = getter;
  useLayoutEffect(() => registerReloadGuard(() => latest.current()), []);
}

export function isReloadBlockingRequest(path: string, method: string) {
  const verb = method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(verb)) return false;
  // Source synchronization reads Codex and does not submit user-authored work.
  return !(verb === "POST" && path.split("?")[0] === "/api/sync");
}
