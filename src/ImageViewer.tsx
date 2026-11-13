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
import { createImageViewerMotion, decodedViewerImage, type ViewerMotion } from "./imageViewerMotion";

type ViewerEntry = { id: string; item: ImagePreviewItem; index: number };
type DecodedEntry = { entry: ViewerEntry; natural: { width: number; height: number } };
function ViewerPicture({ entry, current, machine, diagram, fitted, value, ready, status }: {
  entry: ViewerEntry; current: boolean; machine: ReturnType<typeof currentMachineId>; diagram: boolean;
  fitted: { width: number; height: number }; value: ImageTransform;
  ready: (entry: ViewerEntry, natural: { width: number; height: number }) => void;
  status: (id: string, phase: "loading" | "ready" | "failed", retry: () => void) => void;
}) {
  const cached = useImageReadUrl({ src: diagram ? "" : entry.item.src, machine });
  const url = diagram && entry.item.src.startsWith(diagramDataPrefix) ? entry.item.src : cached.url;
  const [reload, setReload] = useState(0);
  const key = diagram ? JSON.stringify([entry.item.src, reload]) : cached.requestKey;
  const pair = JSON.stringify([key, url]);
  const image = useRef<HTMLImageElement>(null), identity = useRef({ key, url }); identity.current = { key, url };
  const successfulPair = useRef<string | null>(null);
  const [decoded, setDecoded] = useState(""), [failed, setFailed] = useState("");
  const loaded = decoded === pair && !!url, broken = failed === pair || !diagram && cached.phase === "failed";
  const handlers = useRef({ ready, status }); handlers.current = { ready, status };
  useLayoutEffect(() => {
    handlers.current.status(entry.id, broken ? "failed" : loaded ? "ready" : "loading", () => {
      if (diagram) setReload(previous => previous + 1); else cached.retry();
    });
  }, [entry.id, key, url, broken, loaded, cached.retry, diagram]);
  if (!url || broken) return null;
  return <img ref={image} key={`${key}:${url}`} className="image-viewer-image" src={url} data-registered-source={entry.item.src}
    data-image-viewer-current={current || undefined} data-image-viewer-candidate={!current || undefined}
    alt={current ? entry.item.alt || t(diagram ? "图表" : "图片") : ""} aria-hidden={!current || undefined} draggable={false} decoding="async" referrerPolicy="no-referrer"
    data-scale={value.scale} style={{ width: fitted.width || undefined, height: fitted.height || undefined, visibility: current && loaded ? "visible" : "hidden",
      transform: `translate(-50%, -50%) translate(${value.x}px, ${value.y}px) scale(${value.scale})` }}
    onLoad={event => {
      const element = event.currentTarget, expected = identity.current;
      const expectedPair = JSON.stringify([expected.key, expected.url]);
      const valid = () => element === image.current && identity.current.key === expected.key && identity.current.url === expected.url && element.getAttribute("src") === expected.url;
      if (!valid() || successfulPair.current === expectedPair) return;
      void decodedViewerImage(element, valid).then(natural => {
        if (!natural || !valid() || successfulPair.current === expectedPair) return;
        // This ref closes the gap before React publishes decoded state. A
        // repeated event for these immutable bytes cannot retire a proven frame.
        successfulPair.current = expectedPair;
        setDecoded(expectedPair); handlers.current.ready(entry, natural);
      }).catch(() => { if (valid() && successfulPair.current !== expectedPair) setFailed(expectedPair); });
    }} onError={event => {
      if (event.currentTarget === image.current && event.currentTarget.getAttribute("src") === identity.current.url && successfulPair.current !== pair) setFailed(pair);
    }} />;
}


export default function ImageViewer({ src, alt, onClose, opener, diagram = false, gallery }: { src: string; alt: string; onClose: () => void; opener?: HTMLElement | null; diagram?: boolean; gallery?: readonly ImagePreviewItem[] }) {
  useLocale();
  const items = useMemo(() => !diagram && gallery?.length && gallery.some(item => item.src === src) ? gallery : [{ src, alt }], [gallery, src, alt, diagram]);
  const [index, setIndex] = useState(() => Math.max(0, items.findIndex(item => item.src === src)));
  const selected = items[index] ?? { src, alt }, hasGallery = items.length > 1;
  const machine = useRef(currentMachineId()).current;
  const wanted: ViewerEntry = { id: JSON.stringify([index, selected.src]), item: selected, index };
  const [displayed, setDisplayed] = useState<DecodedEntry | null>(null), displayedRef = useRef(displayed); displayedRef.current = displayed;
  const wantedRef = useRef(wanted); wantedRef.current = wanted;
  const [currentReady, setCurrentReady] = useState(false);
  const imageMotion = useRef<ReturnType<typeof createImageViewerMotion> | null>(null), pendingMotion = useRef<ViewerMotion>("open");
  const noun = diagram ? "图表" : "图片";
  const dialog = useRef<HTMLDialogElement>(null), stage = useRef<HTMLDivElement>(null), canvas = useRef<HTMLDivElement>(null);
  const targetRetry = useRef<() => void>(() => {});
  const galleryState = useRef({ items, index }); galleryState.current = { items, index };
  const navigate = useRef<(delta: -1 | 1) => void>(() => {});
  const close = useRef(onClose); close.current = onClose;
  const returnFocus = useRef(opener ?? (typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const mounted = useRef(false), closing = useRef(false), generation = useRef(0);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading"), ready = useRef(false);
  const natural = displayed?.natural ?? { width: 0, height: 0 }, naturalRef = useRef(natural);
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
    closing.current = true; imageMotion.current?.cancel();
    if (dialog.current?.open) dialog.current.close();
    close.current();
    queueMicrotask(visibility);
  };
  navigate.current = delta => {
    const current = galleryState.current, next = current.index + delta;
    if (!mounted.current || closing.current || next < 0 || next >= current.items.length) return;
    // Invalidate old image events before React commits the next picture.
    galleryState.current = { ...current, index: next };
    imageMotion.current?.cancel(); pendingMotion.current = delta > 0 ? "next" : "previous";
    wantedRef.current = { id: JSON.stringify([next, current.items[next].src]), item: current.items[next], index: next };
    // Returning to a retained decoded node does not trigger another load/status
    // event. Its existing display ownership is sufficient to finish navigation.
    const retained = displayedRef.current?.entry.id === wantedRef.current.id && ready.current;
    setPhase(retained ? "ready" : "loading"); setIndex(next);
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
    if (!canvas.current) return;
    imageMotion.current = createImageViewerMotion(canvas.current);
    return () => { imageMotion.current?.dispose(); imageMotion.current = null; };
  }, []);
  useLayoutEffect(() => {
    if (displayed) imageMotion.current?.play(pendingMotion.current);
  }, [displayed?.entry.id]);
  const loaded = (entry: ViewerEntry, size: { width: number; height: number }) => {
    if (!mounted.current || closing.current || entry.id !== wantedRef.current.id && entry.id !== displayedRef.current?.entry.id) return;
    const next = { entry, natural: size };
    const changed = displayedRef.current?.entry.id !== entry.id;
    displayedRef.current = next; naturalRef.current = size;
    setDisplayed(next); ready.current = true; setCurrentReady(true);
    if (entry.id === wantedRef.current.id) setPhase("ready");
    if (changed) commit(diagram ? readableDiagramTransform(bounds()) : imageIdentity());
  };
  const imageStatus = (id: string, state: "loading" | "ready" | "failed", retry: () => void) => {
    if (!mounted.current || closing.current) return;
    if (id === displayedRef.current?.entry.id) { ready.current = state === "ready"; setCurrentReady(state === "ready"); }
    if (id === wantedRef.current.id) { targetRetry.current = retry; setPhase(state); }
  };
  const interrupt = (cancelPending = true) => {
    imageMotion.current?.cancel();
    const current = displayedRef.current;
    if (cancelPending && current && current.entry.id !== wantedRef.current.id) {
      wantedRef.current = current.entry; galleryState.current = { ...galleryState.current, index: current.entry.index };
      setIndex(current.entry.index); setPhase(currentReady ? "ready" : "loading");
    }
  };
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const measure = () => {
      imageMotion.current?.cancel();
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
  const changeZoom = (scale: number) => { interrupt(); commit(zoomImage(valueRef.current, scale, { x: 0, y: 0 }, bounds())); };
  const visible = displayed?.entry ?? wanted;
  const entries = displayed && displayed.entry.id !== wanted.id ? [displayed.entry, wanted] : [wanted];
  if (typeof document === "undefined") return null;
  return createPortal(<dialog ref={dialog} className="pocket-image-viewer" data-image-viewer="" data-diagram-viewer={diagram || undefined} data-reading-overlay="" data-gallery-index={hasGallery ? visible.index : undefined} data-gallery-requested-index={hasGallery ? index : undefined} aria-label={t("查看{{noun}}：{{value1}}", { noun: t(noun), value1: visible.item.alt || t(noun) })}
    onCancel={event => { event.preventDefault(); requestClose(); }}
    onKeyDown={event => {
      if (!hasGallery || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); navigate.current(event.key === "ArrowLeft" ? -1 : 1);
    }}>
    <div ref={stage} className="image-viewer-stage" onPointerDownCapture={event => interrupt(!(event.target as Element).closest("[data-image-viewer-control], .image-viewer-message"))} onWheelCapture={() => interrupt()} tabIndex={-1} role="region" aria-label={t("{{noun}}预览", { noun: t(noun) })} style={{ outline: "none" }}>
      <div ref={canvas} className="image-viewer-canvas">
        {entries.map(entry => <ViewerPicture key={entry.id} entry={entry} current={entry.id === displayed?.entry.id} machine={machine} diagram={diagram}
          fitted={fitted} value={value} ready={loaded} status={imageStatus} />)}
      </div>
      {phase !== "ready" && <div className={`image-viewer-message${displayed && currentReady ? " is-retained-image" : ""}`}>
        {phase === "loading" ? <p role="status">{t("正在加载图片…")}</p> : <><p role="alert">{t("图片暂时无法显示")}</p>
          <button type="button" data-image-viewer-control="" onClick={() => { interrupt(false); setPhase("loading"); targetRetry.current(); }}>{t("重新加载图片")}</button></>}
      </div>}
    </div>
    {hasGallery && <>
      <span className="image-viewer-counter" role="status" aria-live="polite" aria-atomic="true" aria-label={t("第{{index}}张，共{{total}}张", { index: visible.index + 1, total: items.length })}>{visible.index + 1} / {items.length}</span>
      <button type="button" className="image-viewer-previous" aria-label={t("上一张图片")} disabled={index === 0} onClick={() => navigate.current(-1)}><AppIcon icon={ChevronLeft} kind="navigation" aria-hidden="true" /></button>
      <button type="button" className="image-viewer-next" aria-label={t("下一张图片")} disabled={index === items.length - 1} onClick={() => navigate.current(1)}><AppIcon icon={ChevronRight} kind="navigation" aria-hidden="true" /></button>
    </>}
    <button type="button" className="image-viewer-close" aria-label={t("关闭{{noun}}", { noun: t(noun) })} onClick={requestClose}><AppIcon icon={X} kind="action" aria-hidden="true" /><span>{t("关闭")}</span></button>
    <div className="image-viewer-zoom" role="group" aria-label={t("{{noun}}缩放", { noun: t(noun) })}>
      <button type="button" aria-label={t("缩小{{noun}}", { noun: t(noun) })} disabled={!currentReady || value.scale <= 1} onClick={() => changeZoom(valueRef.current.scale / 1.5)}><AppIcon icon={Minus} kind="action" aria-hidden="true" /></button>
      <button type="button" className="image-viewer-reset" aria-label={t("复位{{noun}}", { noun: t(noun) })} disabled={!currentReady || value.scale === 1 && value.x === 0 && value.y === 0} onClick={() => { interrupt(); commit(imageIdentity()); }}><AppIcon icon={RotateCcw} kind="action" aria-hidden="true" /><span>{t("复位")}</span></button>
      <button type="button" aria-label={t("放大{{noun}}", { noun: t(noun) })} disabled={!currentReady || value.scale >= IMAGE_ZOOM_MAX} onClick={() => changeZoom(valueRef.current.scale * 1.5)}><AppIcon icon={Plus} kind="action" aria-hidden="true" /></button>
    </div>
  </dialog>, document.body);
}
