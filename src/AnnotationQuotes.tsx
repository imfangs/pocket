import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useDisclosureMotion } from "./useDisclosureMotion";
import type { ResponseAnnotation } from "./responseAnnotations";
import "./response-annotations.css";

export type AnnotationLayoutChange = (anchor: HTMLElement | null, update: () => void) => void;
const updateLayout: AnnotationLayoutChange = (_anchor, update) => update();

function AnnotationQuote({ annotation, index, numbered, changeLayout }: {
  annotation: ResponseAnnotation; index: number; numbered: boolean; changeLayout: AnnotationLayoutChange;
}) {
  useLocale();
  const id = useId(), body = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false), [overflows, setOverflows] = useState(false);
  const motion = useDisclosureMotion(expanded);
  useLayoutEffect(() => {
    const text = body.current, viewport = motion.ref.current;
    if (!text || !viewport) return;
    const measure = () => setOverflows(text.getBoundingClientRect().height > parseFloat(getComputedStyle(viewport).lineHeight) * 3 + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    return () => observer.disconnect();
  }, [annotation.text]);
  return <div className="response-annotation" data-annotation-index={index}>
    {numbered && <span className="response-annotation-label">{t("引用 {{value1}}", { value1: index })}</span>}
    <blockquote className="response-annotation-quote" aria-label={t("引用 {{value1}}", { value1: index })} data-annotation-expanded={expanded}>
      <div id={id} ref={motion.ref} className="annotation-quote-viewport">
        <p ref={body} className="annotation-quote-text">{annotation.text}</p>
      </div>
      {overflows && <button type="button" className="annotation-quote-toggle" aria-expanded={expanded} aria-controls={id}
        onClick={event => {
          const anchor = expanded ? event.currentTarget : motion.ref.current;
          motion.prepare(anchor);
          changeLayout(anchor, () => setExpanded(!expanded));
        }}>
        {expanded ? t("收起引用") : t("展开引用")}
        {expanded ? <AppIcon icon={ChevronUp} kind="auxiliary" aria-hidden="true" /> : <AppIcon icon={ChevronDown} kind="auxiliary" aria-hidden="true" />}
      </button>}
    </blockquote>
    {annotation.comment?.trim() && <p className="response-annotation-comment">{annotation.comment}</p>}
  </div>;
}

export default function AnnotationQuotes({ annotations, changeLayout = updateLayout }: {
  annotations: readonly ResponseAnnotation[]; changeLayout?: AnnotationLayoutChange;
}) {
  useLocale();
  const id = useId(), container = useRef<HTMLDivElement>(null), [expanded, setExpanded] = useState(false);
  const motion = useDisclosureMotion(expanded);
  const numbered = annotations.length > 1;
  return <div ref={container} className="response-annotations" role="group" aria-label={t("引用内容")}>
    {annotations.slice(0, 2).map((annotation, index) => <AnnotationQuote key={index} annotation={annotation} index={index + 1} numbered={numbered} changeLayout={changeLayout} />)}
    {annotations.length > 2 && <>
      {/* Keep hidden quotes measurable so their overflow controls exist before
          the group's opening height is captured. Inert preserves disclosure. */}
      <div id={id} ref={motion.ref} className="annotation-more-quotes" data-expanded={expanded} inert={!expanded} aria-hidden={!expanded}>
        {annotations.slice(2).map((annotation, index) => <AnnotationQuote key={index + 2} annotation={annotation} index={index + 3} numbered changeLayout={changeLayout} />)}
      </div>
      <button type="button" className="annotation-more-toggle" aria-expanded={expanded} aria-controls={id}
        onClick={event => {
          const anchor = expanded ? event.currentTarget : container.current;
          motion.prepare(anchor);
          changeLayout(anchor, () => setExpanded(!expanded));
        }}>
        {expanded ? t("收起其余引用") : t("展开其余 {{value1}} 处引用", { value1: annotations.length - 2 })}
        {expanded ? <AppIcon icon={ChevronUp} kind="auxiliary" aria-hidden="true" /> : <AppIcon icon={ChevronDown} kind="auxiliary" aria-hidden="true" />}
      </button>
    </>}
  </div>;
}
