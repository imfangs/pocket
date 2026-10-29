import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { MachineId } from "./machineScope";
import { MOTION_MS } from "./motion";
import { requestActivity } from "./requestActivity";
import "./network-title.css";

const idle = () => false;
const documentVisible = () => typeof document !== "undefined" && document.visibilityState === "visible";
function subscribeVisibility(listener: () => void) {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

/** A visual delay smooths request bursts; it never delays or owns a request. */
export default function NetworkTitle({ children, className, machine, threadId }: {
  children: string; className?: string; machine: MachineId | null; threadId?: string;
}) {
  const readPending = useCallback(() => requestActivity.isPending(machine, threadId), [machine, threadId]);
  const pending = useSyncExternalStore(requestActivity.subscribe, readPending, idle);
  const visible = useSyncExternalStore(subscribeVisibility, documentVisible, idle);
  const scope = JSON.stringify([machine, threadId ?? null]);
  const [activeScope, setActiveScope] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!visible || activeScope !== null && activeScope !== scope) {
      if (activeScope !== null) setActiveScope(null);
      return;
    }
    if (pending && activeScope === null) {
      const timer = window.setTimeout(() => setActiveScope(scope), MOTION_MS.feedback);
      return () => window.clearTimeout(timer);
    }
    if (!pending && activeScope === scope) {
      const timer = window.setTimeout(() => setActiveScope(null), MOTION_MS.content);
      return () => window.clearTimeout(timer);
    }
  }, [scope, pending, visible, activeScope]);

  return <span className={[className, "network-title"].filter(Boolean).join(" ")}
    aria-busy={pending || undefined} data-network-active={visible && activeScope === scope || undefined}>
    {children}
  </span>;
}
