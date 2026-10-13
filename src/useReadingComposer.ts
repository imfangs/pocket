import { useLayoutEffect, useRef, useState } from "react";

const mobileQuery = "(max-width: 760px) and (hover: none) and (pointer: coarse)";
export type ComposerState = {
  mobile: boolean; hasContent: boolean; hasDraft: boolean; hasAttachments: boolean;
  focused: boolean; composing: boolean; picking: boolean; keyboardOpen: boolean;
  pending: boolean; feedback: boolean;
};

export function compactComposer(state: ComposerState) {
  return state.mobile && state.hasContent && !state.hasDraft && !state.hasAttachments &&
    !state.focused && !state.composing && !state.picking && !state.keyboardOpen &&
    !state.pending && !state.feedback;
}

export function useReadingComposer(content: Pick<ComposerState, "hasContent" | "hasDraft" | "hasAttachments" | "pending" | "feedback">) {
  const ref = useRef<HTMLFormElement>(null);
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia(mobileQuery).matches);
  const [focused, setFocused] = useState(false), [composing, setComposing] = useState(false);
  const [picking, setPicking] = useState(false), [keyboardOpen, setKeyboardOpen] = useState(false);
  useLayoutEffect(() => {
    const form = ref.current, panel = form?.closest(".inspector"), media = window.matchMedia(mobileQuery);
    if (!form) return;
    const updateFocus = () => setFocused(form.contains(document.activeElement));
    const updateKeyboard = () => setKeyboardOpen(!!panel?.hasAttribute("data-keyboard-open"));
    const updateMobile = () => setMobile(media.matches);
    // Defer focusout until the next control has received focus. The native file
    // picker has its own hold, so neither a blur nor a background hop closes it.
    let frame = 0;
    const blur = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(updateFocus); };
    form.addEventListener("focusin", updateFocus); form.addEventListener("focusout", blur);
    media.addEventListener("change", updateMobile);
    const observer = new MutationObserver(updateKeyboard);
    if (panel) observer.observe(panel, { attributes: true, attributeFilter: ["data-keyboard-open"] });
    updateFocus(); updateKeyboard(); updateMobile();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); media.removeEventListener("change", updateMobile);
      form.removeEventListener("focusin", updateFocus); form.removeEventListener("focusout", blur);
    };
  }, []);
  return { ref, compact: compactComposer({ ...content, mobile, focused, composing, picking, keyboardOpen }),
    setPicking, onCompositionStart: () => setComposing(true), onCompositionEnd: () => setComposing(false) };
}
