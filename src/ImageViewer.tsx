import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import { ChevronLeft, ChevronRight, Minus, Plus, RotateCcw, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { bindImageGestures, clampImageTransform, fitImage, imageIdentity, readableDiagramTransform, IMAGE_ZOOM_MAX, zoomImage, type ImageBounds, type ImageTransform } from "./imageViewerGestures";
import "./image-viewer.css";
import { currentMachineId } from "./machineScope";
import { diagramDataPrefix } from "./mermaidPolicy";
import type { ImagePreviewItem } from "./imagePreviewGallery";
import { useImageReadUrl } from "./imageReadCacheReact";

export default function ImageViewer({ src, alt, onClose, opener, diagram = false, gallery }: { src: string; alt: string; onClose: () => void; opener?: HTMLElement | null; diagram?: boolean; gallery?: readonly ImagePreviewItem[] }) {
  useLocale();
  const items = useMemo(() => !diagram && gallery?.length && gallery.some(item => item.src === src) ? gallery : [{ src, alt }], [gallery, src, alt, diagram]);
  const [index, setIndex] = useState(() => Math.max(0, items.findIndex(item => item.src === src)));
  const selected = items[index] ?? { src, alt }, hasGallery = items.length > 1;
  const machine = useRef(currentMachineId()).current;
  const cached = useImageReadUrl({ src: diagram ? "" : selected.src, machine });
  const imageSrc = diagram && selected.src.startsWith(diagramDataPrefix) ? selected.src : cached.url;
  const noun = diagram ? "图表" : "图片";
  const dialog = useRef<HTMLDialogElement>(null), stage = useRef<HTMLDivElement>(null), canvas = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null), activeSource = useRef(selected.src);
  activeSource.current = selected.src;
  const activeBlob = useRef(imageSrc); activeBlob.current = imageSrc;
  const galleryState = useRef({ items, index }); galleryState.current = { items, index };
  const navigate = useRef<(delta: -1 | 1) => void>(() => {});
  const close = useRef(onClose); close.current = onClose;
  const returnFocus = useRef(opener ?? (typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const mounted = useRef(false), closing = useRef(false), generation = useRef(0);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading"), ready = useRef(false);
  const [retry, setRetry] = useState({ src, attempt: 0 });
  const attempt = retry.src === selected.src ? retry.attempt : 0;
  const [natural, setNatural] = useState({ width: 0, height: 0 }), naturalRef = useRef(natural);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [value, setValue] = useState(imageIdentity), valueRef = useRef(value);
  const commit = (next: ImageTransform) => { valueRef.current = next; setValue(next); };
  const bounds = (): ImageBounds => {
    const rect = canvas.current?.getBoundingClientRect();
    const size = { width: rect?.width ?? 0, height: rect?.height ?? 0 }, fitted = fitImage(naturalRef.current, size);
    return { ...size, imageWidth: fitted.width, imageHeight: fitted.height, centerX: (rect?.left ?? 0) + size.width / 2, centerY: (rect?.top ?? 0) + size.height / 2 };
  };
  const visibility = () => window.dispatchEvent(new Event("pocket-reading-visibility-change"));
  const requestClose = () => {
    if (!mounted.current || closing.current) return;
    closing.current = true;
    if (dialog.current?.open) dialog.current.close();
    close.current();
    queueMicrotask(visibility);
  };
  navigate.current = delta => {
    const current = galleryState.current, next = current.index + delta;
    if (!mounted.current || closing.current || next < 0 || next >= current.items.length) return;
    // Invalidate old image events before React commits the next picture.
    galleryState.current = { ...current, index: next };
    activeSource.current = current.items[next].src;
    ready.current = false;
    setIndex(next);
    stage.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const turn = ++generation.current;
    mounted.current = true; closing.current = false;
    const body = document.body, html = document.documentElement;
    const previous = { bodyOverflow: body.style.overflow, htmlOverflow: html.style.overflow, bodyOverscroll: body.style.overscrollBehavior, htmlOverscroll: html.style.overscrollBehavior };
    body.style.overflow = html.style.overflow = "hidden";
    body.style.overscrollBehavior = html.style.overscrollBehavior = "none";
    if (returnFocus.current?.isConnected && !returnFocus.current.closest("[inert]")) returnFocus.current.focus({ preventScroll: true });
    if (!element.open) element.showModal();
    stage.current?.focus({ preventScroll: true });
    visibility();
    return () => {
      mounted.current = false;
      if (element.open) element.close();
      body.style.overflow = previous.bodyOverflow; html.style.overflow = previous.htmlOverflow;
      body.style.overscrollBehavior = previous.bodyOverscroll; html.style.overscrollBehavior = previous.htmlOverscroll;
      queueMicrotask(() => {
        if (mounted.current || generation.current !== turn) return;
        visibility();
        const trigger = returnFocus.current, other = document.querySelector("dialog[open]");
        if (trigger?.isConnected && !trigger.closest("[inert]") && (!other || other.contains(trigger))) trigger.focus({ preventScroll: true });
      });
    };
  }, []);
  useLayoutEffect(() => {
    ready.current = false; setPhase("loading");
    naturalRef.current = { width: 0, height: 0 }; setNatural(naturalRef.current); commit(imageIdentity());
  }, [selected.src, attempt, imageSrc]);
  useLayoutEffect(() => {
    if (!diagram && cached.phase === "failed") { ready.current = false; setPhase("failed"); }
  }, [diagram, cached.phase]);
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setFrame(previous => previous.width === rect.width && previous.height === rect.height ? previous : { width: rect.width, height: rect.height });
      commit(clampImageTransform(valueRef.current, bounds()));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element); window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  useLayoutEffect(() => {
    if (!stage.current) return;
    return bindImageGestures(stage.current, { bounds, get: () => valueRef.current, set: commit, ready: () => ready.current, close: requestClose,
      ...(hasGallery ? { navigate: (delta: -1 | 1) => navigate.current(delta) } : {}) });
  }, [hasGallery]);
  const fitted = fitImage(natural, frame);
  const changeZoom = (scale: number) => commit(zoomImage(valueRef.current, scale, { x: 0, y: 0 }, bounds()));
  if (typeof document === "undefined") return null;
  return createPortal(<dialog ref={dialog} className="pocket-image-viewer" data-image-viewer="" data-diagram-viewer={diagram || undefined} data-reading-overlay="" data-gallery-index={hasGallery ? index : undefined} aria-label={t("查看{{noun}}：{{value1}}", { noun: t(noun), value1: selected.alt || t(noun) })}
    onCancel={event => { event.preventDefault(); requestClose(); }}
    onKeyDown={event => {
      if (!hasGallery || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); navigate.current(event.key === "ArrowLeft" ? -1 : 1);
    }}>
    <div ref={stage} className="image-viewer-stage" tabIndex={-1} role="region" aria-label={t("{{noun}}预览", { noun: t(noun) })} style={{ outline: "none" }}>
      <div ref={canvas} className="image-viewer-canvas">
        {imageSrc && <img ref={picture} key={`${selected.src}:${attempt}:${imageSrc}`} className="image-viewer-image" src={imageSrc} data-registered-source={selected.src} alt={selected.alt || t(noun)} draggable={false} decoding="async" referrerPolicy="no-referrer"
          data-scale={value.scale} style={{ width: fitted.width || undefined, height: fitted.height || undefined, visibility: phase === "ready" ? "visible" : "hidden",
            transform: `translate(-50%, -50%) translate(${value.x}px, ${value.y}px) scale(${value.scale})` }}
          onLoad={event => {
            const image = event.currentTarget;
            if (!mounted.current || closing.current || image !== picture.current || activeSource.current !== selected.src || image.getAttribute("src") !== activeBlob.current) return;
            if (!image.naturalWidth || !image.naturalHeight) { ready.current = false; setPhase("failed"); return; }
            naturalRef.current = { width: image.naturalWidth, height: image.naturalHeight }; setNatural(naturalRef.current);
            ready.current = true; setPhase("ready"); commit(diagram ? readableDiagramTransform(bounds()) : clampImageTransform(valueRef.current, bounds()));
          }} onError={event => {
            if (!mounted.current || closing.current || event.currentTarget !== picture.current || activeSource.current !== selected.src || event.currentTarget.getAttribute("src") !== activeBlob.current) return;
            ready.current = false; setPhase("failed");
          }} />}
      </div>
      {phase !== "ready" && <div className="image-viewer-message">
        {phase === "loading" ? <p role="status">{t("正在加载图片…")}</p> : <><p role="alert">{t("图片暂时无法显示")}</p>
          <button type="button" data-image-viewer-control="" onClick={() => { ready.current = false; setPhase("loading"); commit(imageIdentity()); if (!diagram) cached.retry(); setRetry(previous => ({ src: selected.src, attempt: previous.src === selected.src ? previous.attempt + 1 : 1 })); }}>{t("重新加载图片")}</button></>}
      </div>}
    </div>
    {hasGallery && <>
      <span className="image-viewer-counter" role="status" aria-live="polite" aria-atomic="true" aria-label={t("第{{index}}张，共{{total}}张", { index: index + 1, total: items.length })}>{index + 1} / {items.length}</span>
      <button type="button" className="image-viewer-previous" aria-label={t("上一张图片")} disabled={index === 0} onClick={() => navigate.current(-1)}><AppIcon icon={ChevronLeft} kind="navigation" aria-hidden="true" /></button>
      <button type="button" className="image-viewer-next" aria-label={t("下一张图片")} disabled={index === items.length - 1} onClick={() => navigate.current(1)}><AppIcon icon={ChevronRight} kind="navigation" aria-hidden="true" /></button>
    </>}
    <button type="button" className="image-viewer-close" aria-label={t("关闭{{noun}}", { noun: t(noun) })} onClick={requestClose}><AppIcon icon={X} kind="action" aria-hidden="true" /><span>{t("关闭")}</span></button>
    <div className="image-viewer-zoom" role="group" aria-label={t("{{noun}}缩放", { noun: t(noun) })}>
      <button type="button" aria-label={t("缩小{{noun}}", { noun: t(noun) })} disabled={phase !== "ready" || value.scale <= 1} onClick={() => changeZoom(valueRef.current.scale / 1.5)}><AppIcon icon={Minus} kind="action" aria-hidden="true" /></button>
      <button type="button" className="image-viewer-reset" aria-label={t("复位{{noun}}", { noun: t(noun) })} disabled={phase !== "ready" || value.scale === 1 && value.x === 0 && value.y === 0} onClick={() => commit(imageIdentity())}><AppIcon icon={RotateCcw} kind="action" aria-hidden="true" /><span>{t("复位")}</span></button>
      <button type="button" aria-label={t("放大{{noun}}", { noun: t(noun) })} disabled={phase !== "ready" || value.scale >= IMAGE_ZOOM_MAX} onClick={() => changeZoom(valueRef.current.scale * 1.5)}><AppIcon icon={Plus} kind="action" aria-hidden="true" /></button>
    </div>
  </dialog>, document.body);
}
