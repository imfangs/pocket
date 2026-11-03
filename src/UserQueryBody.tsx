import { t, useLocale } from "./i18n";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import MessageMarkdown from "./MessageMarkdown";
import { useDisclosureMotion } from "./useDisclosureMotion";
import "./user-query.css";

export type QueryDisclosure = {
  expanded: boolean;
  toggle: (expanded: boolean, anchor: HTMLElement) => void;
};

// Keep the original Markdown nodes (and selection) across polling and toggles.
// Only controls clipped out of the preview become inert; visible links still work.
export default function UserQueryBody({ text, images, disclosure }: {
  text: string;
  images?: Record<string, string>;
  disclosure: QueryDisclosure;
}) {
  useLocale();
  const id = useId();
  const content = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  // Inline pictures are content in their own right, not lines of Query text.
  const hasInlineImages = !!images && Object.keys(images).length > 0;
  const expanded = disclosure.expanded || hasInlineImages;
  const motion = useDisclosureMotion(expanded);
  const viewport = motion.ref;

  useLayoutEffect(() => {
    const frame = viewport.current, body = content.current;
    if (!frame || !body) return;
    const hiddenControls = new Set<HTMLElement>();
    const scrollContainers = new Map<HTMLElement, string>();
    const restoreControls = () => {
      hiddenControls.forEach(element => { element.inert = false; });
      hiddenControls.clear();
      scrollContainers.forEach((tabIndex, element) => element.setAttribute("tabindex", tabIndex));
      scrollContainers.clear();
    };
    const measure = () => {
      restoreControls();
      const limit = parseFloat(getComputedStyle(frame).lineHeight) * 6;
      const height = body.getBoundingClientRect().height;
      const long = !hasInlineImages && height > limit + 1;
      setOverflows(long);
      if (!long || expanded) return;
      const bottom = frame.getBoundingClientRect().top + limit;
      for (const element of body.querySelectorAll<HTMLElement>("a, button, input, select, textarea, [tabindex]")) {
        if (!element.inert && element.getBoundingClientRect().bottom > bottom + 1) {
          if (element.matches(".markdown-table, pre")) {
            // Disabling a scrolling region must not disable its visible links.
            scrollContainers.set(element, element.getAttribute("tabindex")!);
            element.tabIndex = -1;
            continue;
          }
          element.inert = true;
          hiddenControls.add(element);
        }
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => { observer.disconnect(); restoreControls(); };
  }, [text, images, expanded, hasInlineImages]);

  return <div className="user-query-body" data-query-expanded={expanded}>
    <div id={id} ref={viewport} className="query-body-viewport">
      <div ref={content} className="query-body-content">
        <MessageMarkdown images={images} text={text} codex={false} />
      </div>
    </div>
    {overflows && <button type="button" className="query-disclosure-toggle"
      aria-expanded={expanded} aria-controls={id}
      onClick={event => {
        const anchor = expanded ? event.currentTarget : viewport.current!;
        motion.prepare(anchor);
        disclosure.toggle(!expanded, anchor);
      }}>
      {expanded ? t("收起") : t("展开更多")}
      {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
    </button>}
  </div>;
}
