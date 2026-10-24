import { useLayoutEffect, useRef, useState } from "react";

const mobileQuery = "(max-width: 760px) and (hover: none) and (pointer: coarse)";
export type ComposerState = {
  mobile: boolean; hasContent: boolean; hasDraft: boolean; hasAttachments: boolean;
  focused: boolean; composing: boolean; picking: boolean; keyboardOpen: boolean;
  pending: boolean; feedback: boolean;
};

export function compactComposer(state: ComposerState) {
  return state.mobile && state.hasContent && !state.hasAttachments &&
    !state.focused && !state.composing && !state.picking && !state.keyboardOpen &&
    !state.pending && !state.feedback;
}

export function useReadingComposer(content: Pick<ComposerState, "hasContent" | "hasDraft" | "hasAttachments" | "pending" | "feedback">) {
  const ref = useRef<HTMLFormElement>(null);
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia(mobileQuery).matches);
  const [focused, setFocused] = useState(false), [composing, setComposing] = useState(false);
  const [picking, setPicking] = useState(false), [keyboardOpen, setKeyboardOpen] = useState(false);
  const interaction = useRef({ composing, picking });
  interaction.current = { composing, picking };
  useLayoutEffect(() => {
    const form = ref.current, panel = form?.closest(".inspector"), media = window.matchMedia(mobileQuery);
    if (!form) return;
    const updateFocus = () => {
      const active = document.activeElement;
      // Stopping is available in either layout. Taking focus must not move
      // that pressed control before its native touch click can arrive.
      if (form.contains(active) && active?.closest("[data-composer-reading-control]")) return;
      setFocused(form.contains(active));
    };
    let hadKeyboard = !!panel?.hasAttribute("data-keyboard-open");
    const updateKeyboard = () => {
      const open = !!panel?.hasAttribute("data-keyboard-open");
      // iOS can dismiss its keyboard while leaving the textarea focused.
      // This changes presentation only; the input node, value and caret survive.
      if (hadKeyboard && !open && document.visibilityState === "visible" &&
          !interaction.current.composing && !interaction.current.picking &&
          document.activeElement === form.querySelector("textarea")) setFocused(false);
      hadKeyboard = open;
      setKeyboardOpen(open);
    };
    const updateMobile = () => setMobile(media.matches);
    // Defer focusout until the next control has received focus. The native file
    // picker has its own hold, so neither a blur nor a background hop closes it.
    let frame = 0;
    const blur = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(updateFocus); };
    const resumeEditing = (event: Event) => {
      if (event instanceof KeyboardEvent && ["Tab", "Shift", "Control", "Alt", "Meta", "Escape"].includes(event.key)) return;
      if (event.target === form.querySelector("textarea")) setFocused(true);
    };
    form.addEventListener("focusin", updateFocus); form.addEventListener("focusout", blur);
    form.addEventListener("click", resumeEditing); form.addEventListener("input", resumeEditing);
    // Grow only after a tap has chosen its native target, not in pointerdown.
    form.addEventListener("keydown", resumeEditing); form.addEventListener("contextmenu", resumeEditing);
    media.addEventListener("change", updateMobile);
    const observer = new MutationObserver(updateKeyboard);
    if (panel) observer.observe(panel, { attributes: true, attributeFilter: ["data-keyboard-open"] });
    updateFocus(); updateKeyboard(); updateMobile();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); media.removeEventListener("change", updateMobile);
      form.removeEventListener("focusin", updateFocus); form.removeEventListener("focusout", blur);
      form.removeEventListener("click", resumeEditing); form.removeEventListener("input", resumeEditing);
      form.removeEventListener("keydown", resumeEditing); form.removeEventListener("contextmenu", resumeEditing);
    };
  }, []);
  const canCollapse = mobile && content.hasContent && !content.hasAttachments && !content.pending && !content.feedback && !composing && !picking;
  const collapse = () => {
    if (!canCollapse) return;
    const body = ref.current?.closest(".conversation")?.querySelector<HTMLElement>(".conversation-messages");
    body?.focus({ preventScroll: true });
    setFocused(false);
  };
  return { ref, compact: compactComposer({ ...content, mobile, focused, composing, picking, keyboardOpen }), canCollapse, collapse, expand: () => setFocused(true),
    composing, setPicking, onCompositionStart: () => setComposing(true), onCompositionEnd: () => setComposing(false) };
}
