import { useEffect, useState } from "react";
import type { TurnTiming } from "./conversationFeed";

export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}:${String(seconds % 60).padStart(2, "0")}`
    : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function elapsedDuration(timing: TurnTiming, extraMs = 0) {
  if (timing.status !== "inProgress") return timing.durationMs;
  return timing.startedAt == null ? null : Math.max(0, timing.observedAt - timing.startedAt + extraMs);
}

// Tick only this small label, never the message list. Anchor to Mac time so a
// phone with a different clock still displays the same elapsed duration.
export default function TurnDuration({ timing, live }: { timing?: TurnTiming | null; live: boolean }) {
  const [tick, setTick] = useState<{ observedAt: number; turnId: string | null; extraMs: number } | null>(null);
  const observedAt = timing?.observedAt;
  const turnId = timing?.turnId;
  const running = timing?.status === "inProgress";
  useEffect(() => {
    if (!live || !running || observedAt == null || turnId === undefined) return;
    const baseline = performance.now();
    const update = () => {
      if (document.visibilityState === "visible")
        setTick({ observedAt, turnId, extraMs: performance.now() - baseline });
    };
    const timer = window.setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [live, running, observedAt, turnId]);
  if (!timing) return null;
  const extra = live && tick && tick.observedAt === observedAt && tick.turnId === turnId ? tick.extraMs : 0;
  const elapsed = elapsedDuration(timing, extra);
  if (elapsed == null) return null;
  const label = running ? live ? "" : "已记录" : "总用时";
  const duration = formatDuration(elapsed);
  return <span className="turn-duration" title="本轮从开始到结束的用时，包含工具执行和等待确认">
    {label && `${label} `}<time aria-label={label ? undefined : `本轮用时 ${duration}`}>{duration}</time>
  </span>;
}
