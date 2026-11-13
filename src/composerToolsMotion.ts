import { MOTION_EASE, MOTION_MS, prefersReducedMotion } from "./motion.ts";

export function createComposerToolsMotion(form: HTMLFormElement) {
  let previousCompact: boolean | null = null, animation: Animation | null = null, closed = false;
  const tools = form.querySelector<HTMLElement>(".composer-actions"), doc = form.ownerDocument, browser = doc.defaultView;
  const cancel = () => { animation?.cancel(); animation = null; tools?.removeAttribute("data-composer-tools-motion"); };
  const events = ["pointerdown", "keydown", "beforeinput", "input", "compositionstart", "change"];
  events.forEach(type => form.addEventListener(type, cancel));
  const viewport = browser?.visualViewport;
  const media = browser?.matchMedia("(prefers-reduced-motion: reduce)");
  const preference = () => { if (media?.matches) cancel(); };
  media?.addEventListener("change", preference);
  viewport?.addEventListener("resize", cancel); viewport?.addEventListener("scroll", cancel);
  const hide = () => { if (doc.visibilityState !== "visible") cancel(); };
  doc.addEventListener("visibilitychange", hide);
  return {
    observe(compact: boolean, eligible: boolean) {
      const opening = previousCompact === true && !compact; previousCompact = compact;
      if (closed || !tools) return;
      if (!eligible || compact) { cancel(); return; }
      if (!opening || prefersReducedMotion(browser ?? undefined) || doc.visibilityState !== "visible" || typeof tools.animate !== "function") return;
      cancel(); tools.setAttribute("data-composer-tools-motion", "");
      let current: Animation;
      try { current = tools.animate([{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }],
        { duration: MOTION_MS.feedback, easing: MOTION_EASE.out }); }
      catch { cancel(); return; }
      animation = current;
      current.onfinish = () => { if (animation === current) { animation = null; tools.removeAttribute("data-composer-tools-motion"); } };
    },
    dispose() { closed = true; cancel(); events.forEach(type => form.removeEventListener(type, cancel)); viewport?.removeEventListener("resize", cancel); viewport?.removeEventListener("scroll", cancel); doc.removeEventListener("visibilitychange", hide); media?.removeEventListener("change", preference); },
  };
}
