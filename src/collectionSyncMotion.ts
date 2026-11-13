import { MOTION_EASE, MOTION_MS, prefersReducedMotion } from "./motion.ts";
import type { ReadCompletion } from "./readHealth";

export function createCollectionSyncMotion(line: HTMLElement) {
  let scope: string | null = null, cycle: number[] | null = null, animation: Animation | null = null, closed = false;
  const stop = () => { animation?.cancel(); animation = null; line.removeAttribute("data-finishing"); };
  const cancelCycle = () => { cycle = null; stop(); };
  const doc = line.ownerDocument, browser = doc.defaultView;
  const media = browser?.matchMedia("(prefers-reduced-motion: reduce)");
  const preference = () => { if (media?.matches) cancelCycle(); };
  const hide = () => { if (doc.visibilityState !== "visible") cancelCycle(); };
  doc.addEventListener("visibilitychange", hide); browser?.addEventListener("pageshow", cancelCycle); browser?.addEventListener("offline", cancelCycle);
  media?.addEventListener("change", preference);
  return {
    observe(input: { scope: string | null; pending: boolean; current: boolean; completions: readonly ReadCompletion[] }) {
      if (closed) return;
      if (input.scope !== scope) { cancelCycle(); scope = input.scope; }
      if (doc.visibilityState !== "visible" || browser?.navigator.onLine === false) { cancelCycle(); return; }
      const counts = input.completions.map(item => item.serial);
      if (input.pending) { stop(); cycle ??= counts; return; }
      const started = cycle; cycle = null;
      const invalid = !scope || !input.current || input.completions.some(item => ["failed", "unavailable", "cancelled", "pending"].includes(item.outcome));
      if (!started) { if (invalid) stop(); return; }
      if (invalid || doc.visibilityState !== "visible" ||
        !counts.some((value, index) => value > (started[index] ?? value))) { stop(); return; }
      stop();
      if (prefersReducedMotion(browser ?? undefined) || typeof line.animate !== "function") return;
      line.setAttribute("data-finishing", "");
      let current: Animation;
      try { current = line.animate([{ opacity: .6 }, { opacity: 0 }], { duration: MOTION_MS.feedback, easing: MOTION_EASE.out }); }
      catch { stop(); return; }
      animation = current;
      current.onfinish = () => { if (animation === current) { animation = null; line.removeAttribute("data-finishing"); } };
    },
    dispose() { closed = true; cancelCycle(); doc.removeEventListener("visibilitychange", hide); browser?.removeEventListener("pageshow", cancelCycle); browser?.removeEventListener("offline", cancelCycle); media?.removeEventListener("change", preference); },
  };
}
