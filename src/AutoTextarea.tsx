import { useLayoutEffect, useRef, type ComponentProps } from "react";

// Measure rendered wrapping, so pasted text, deletion and viewport changes all fit.
export default function AutoTextarea(props: ComponentProps<"textarea">) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    let frame = 0;
    const resize = () => {
      const style = getComputedStyle(input);
      const min = parseFloat(style.minHeight) || 0;
      const viewport = window.visualViewport?.height ?? window.innerHeight;
      const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const scroll = input.scrollTop;
      input.style.height = "0px";
      const natural = input.scrollHeight + border;
      const conversation = input.closest<HTMLElement>(".conversation");
      const group = input.closest<HTMLElement>(".conversation-composer, .outbox");
      let available = Infinity;
      if (conversation && group) {
        const fixed = [...conversation.children].filter(el => el !== group && !el.classList.contains("conversation-messages"))
          .reduce((sum, el) => sum + el.getBoundingClientRect().height, 0);
        const controls = group.scrollHeight - input.getBoundingClientRect().height;
        available = conversation.clientHeight - fixed - controls - 24;
      }
      const max = Math.max(min, Math.min(parseFloat(style.maxHeight) || 240, viewport * 0.32, available));
      input.style.height = `${Math.max(min, Math.min(max, natural))}px`;
      input.style.overflowY = natural > max ? "auto" : "hidden";
      input.scrollTop = scroll;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    };
    let width = input.getBoundingClientRect().width;
    let containerHeight = input.closest(".conversation")?.clientHeight;
    const observer = new ResizeObserver(() => {
      const next = input.getBoundingClientRect().width;
      const height = input.closest(".conversation")?.clientHeight;
      if (next !== width || height !== containerHeight) { width = next; containerHeight = height; schedule(); }
    });
    observer.observe(input);
    const conversation = input.closest(".conversation");
    if (conversation) observer.observe(conversation);
    const panel = input.closest(".inspector");
    const attributes = new MutationObserver(schedule);
    if (panel) attributes.observe(panel, { attributes: true, attributeFilter: ["data-keyboard-open", "style"] });
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    resize();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); attributes.disconnect();
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [props.value]);
  return <textarea {...props} ref={ref} rows={2} />;
}
