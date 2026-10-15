import { Minus, Plus, RotateCcw, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { bindImageGestures, clampImageTransform, fitImage, imageIdentity, IMAGE_ZOOM_MAX, zoomImage, type ImageBounds, type ImageTransform } from "./imageViewerGestures";
import "./image-viewer.css";

export default function ImageViewer({ src, alt, onClose, opener }: { src: string; alt: string; onClose: () => void; opener?: HTMLElement | null }) {
  const dialog = useRef<HTMLDialogElement>(null), stage = useRef<HTMLDivElement>(null), canvas = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const returnFocus = useRef(opener ?? (typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const mounted = useRef(false), closing = useRef(false), generation = useRef(0);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading"), ready = useRef(false);
  const [attempt, setAttempt] = useState(0);
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
    closeButton.current?.focus({ preventScroll: true });
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
    ready.current = false; setPhase("loading"); setAttempt(0);
    naturalRef.current = { width: 0, height: 0 }; setNatural(naturalRef.current); commit(imageIdentity());
  }, [src]);
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
    return bindImageGestures(stage.current, { bounds, get: () => valueRef.current, set: commit, ready: () => ready.current, close: requestClose });
  }, []);
  const fitted = fitImage(natural, frame);
  const changeZoom = (scale: number) => commit(zoomImage(valueRef.current, scale, { x: 0, y: 0 }, bounds()));
  if (typeof document === "undefined") return null;
  return createPortal(<dialog ref={dialog} className="pocket-image-viewer" data-image-viewer="" data-reading-overlay="" aria-label={`查看图片：${alt || "图片"}`}
    onCancel={event => { event.preventDefault(); requestClose(); }}>
    <div ref={stage} className="image-viewer-stage">
      <div ref={canvas} className="image-viewer-canvas">
        <img key={`${src}:${attempt}`} className="image-viewer-image" src={src} alt={alt || "图片"} draggable={false} decoding="async" referrerPolicy="no-referrer"
          data-scale={value.scale} style={{ width: fitted.width || undefined, height: fitted.height || undefined, visibility: phase === "ready" ? "visible" : "hidden",
            transform: `translate(-50%, -50%) translate(${value.x}px, ${value.y}px) scale(${value.scale})` }}
          onLoad={event => {
            const image = event.currentTarget;
            if (!image.naturalWidth || !image.naturalHeight) { ready.current = false; setPhase("failed"); return; }
            naturalRef.current = { width: image.naturalWidth, height: image.naturalHeight }; setNatural(naturalRef.current);
            ready.current = true; setPhase("ready"); commit(clampImageTransform(valueRef.current, bounds()));
          }} onError={() => { ready.current = false; setPhase("failed"); }} />
      </div>
      {phase !== "ready" && <div className="image-viewer-message" data-image-viewer-control="">
        {phase === "loading" ? <p role="status">正在加载图片…</p> : <><p role="alert">图片暂时无法显示</p>
          <button type="button" onClick={() => { ready.current = false; setPhase("loading"); commit(imageIdentity()); setAttempt(value => value + 1); }}>重新加载图片</button></>}
      </div>}
    </div>
    <button ref={closeButton} type="button" className="image-viewer-close" aria-label="关闭图片" onClick={requestClose}><X size={20} aria-hidden="true" /><span>关闭</span></button>
    <div className="image-viewer-zoom" role="group" aria-label="图片缩放">
      <button type="button" aria-label="缩小图片" disabled={phase !== "ready" || value.scale <= 1} onClick={() => changeZoom(valueRef.current.scale / 1.5)}><Minus size={20} aria-hidden="true" /></button>
      <button type="button" className="image-viewer-reset" aria-label="复位图片" disabled={phase !== "ready" || value.scale === 1 && value.x === 0 && value.y === 0} onClick={() => commit(imageIdentity())}><RotateCcw size={17} aria-hidden="true" /><span>复位</span></button>
      <button type="button" aria-label="放大图片" disabled={phase !== "ready" || value.scale >= IMAGE_ZOOM_MAX} onClick={() => changeZoom(valueRef.current.scale * 1.5)}><Plus size={20} aria-hidden="true" /></button>
    </div>
  </dialog>, document.body);
}
