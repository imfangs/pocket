import { forwardRef, useCallback, useLayoutEffect, useRef, type ComponentPropsWithoutRef } from "react";
import { createDisclosureMotion } from "./useDisclosureMotion";
import "./disclosure-motion.css";

// Keep a real details element: form validation may set ref.current.open = true.
// Its native open state changes immediately, including while reversing a click.
const AnimatedDetails = forwardRef<HTMLDetailsElement, ComponentPropsWithoutRef<"details">>(function AnimatedDetails({ onClick, ...props }, forwardedRef) {
  const element = useRef<HTMLDetailsElement | null>(null);
  const motion = useRef<ReturnType<typeof createDisclosureMotion> | null>(null);
  const expectedOpen = useRef<boolean | null>(null);
  const setRef = useCallback((node: HTMLDetailsElement | null) => {
    element.current = node;
    if (typeof forwardedRef === "function") forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);
  useLayoutEffect(() => {
    const details = element.current;
    if (!details) return;
    const observer = new MutationObserver(() => {
      if (expectedOpen.current !== null && details.open !== expectedOpen.current) {
        expectedOpen.current = null;
        motion.current?.cancel();
      }
    });
    observer.observe(details, { attributes: true, attributeFilter: ["open"] });
    return () => { observer.disconnect(); motion.current?.dispose(); motion.current = null; };
  }, []);
  return <details {...props} ref={setRef} onClick={event => {
    onClick?.(event);
    const details = event.currentTarget;
    const summary = (event.target as Element).closest("summary");
    if (event.defaultPrevented || event.button !== 0 || summary?.parentElement !== details ||
        (event.target as Element).closest("a, button, input, select, textarea")) return;
    // Older WebKit cannot keep a closing details body visible without lying
    // about .open. It retains the native instant toggle instead.
    const css = details.ownerDocument.defaultView?.CSS;
    if (!css?.supports("selector(details::details-content)") || details.open && !css.supports("interactivity: inert")) {
      expectedOpen.current = null;
      motion.current?.cancel();
      return;
    }
    event.preventDefault();
    motion.current ??= createDisclosureMotion(details);
    motion.current.prepare(summary);
    details.open = !details.open;
    expectedOpen.current = details.open;
    motion.current.commit();
  }} />;
});
export default AnimatedDetails;
