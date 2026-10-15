export type ImageTransform = { scale: number; x: number; y: number };
export type ImageBounds = { width: number; height: number; imageWidth: number; imageHeight: number; centerX: number; centerY: number };
export const IMAGE_ZOOM_MAX = 8;
export const imageIdentity = (): ImageTransform => ({ scale: 1, x: 0, y: 0 });
export function fitImage(image: { width: number; height: number }, frame: { width: number; height: number }) {
  if (![image.width, image.height, frame.width, frame.height].every(value => Number.isFinite(value) && value > 0)) return { width: 0, height: 0 };
  const ratio = Math.min(1, frame.width / image.width, frame.height / image.height);
  return { width: image.width * ratio, height: image.height * ratio };
}
export function clampImageTransform(value: ImageTransform, bounds: ImageBounds): ImageTransform {
  const scale = Math.max(1, Math.min(IMAGE_ZOOM_MAX, Number.isFinite(value.scale) ? value.scale : 1));
  const maxX = Math.max(0, (bounds.imageWidth * scale - bounds.width) / 2);
  const maxY = Math.max(0, (bounds.imageHeight * scale - bounds.height) / 2);
  return { scale, x: Math.max(-maxX, Math.min(maxX, Number.isFinite(value.x) ? value.x : 0)),
    y: Math.max(-maxY, Math.min(maxY, Number.isFinite(value.y) ? value.y : 0)) };
}
export function zoomImage(value: ImageTransform, scale: number, anchor: { x: number; y: number }, bounds: ImageBounds) {
  const nextScale = Math.max(1, Math.min(IMAGE_ZOOM_MAX, scale));
  const ratio = nextScale / value.scale;
  return clampImageTransform({ scale: nextScale, x: anchor.x - (anchor.x - value.x) * ratio, y: anchor.y - (anchor.y - value.y) * ratio }, bounds);
}
type Point = { x: number; y: number };
type Contact = Point & { start: Point; at: number; moved: boolean; image: boolean };
type Options = {
  bounds: () => ImageBounds;
  get: () => ImageTransform;
  set: (value: ImageTransform) => void;
  close: () => void;
  ready: () => boolean;
};

export function bindImageGestures(stage: HTMLElement, options: Options) {
  const pointers = new Map<number, Contact>();
  let multiple = false;
  let baseline: { value: ImageTransform; midpoint: Point; distance: number } | null = null;
  let lastTap: { at: number; point: Point } | null = null;
  const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const local = (point: Point): Point => { const bounds = options.bounds(); return { x: point.x - bounds.centerX, y: point.y - bounds.centerY }; };
  const onImage = (point: Point) => {
    if (!options.ready()) return false;
    const bounds = options.bounds(), value = options.get(), position = local(point);
    return Math.abs(position.x - value.x) <= bounds.imageWidth * value.scale / 2 && Math.abs(position.y - value.y) <= bounds.imageHeight * value.scale / 2;
  };
  const rebase = () => {
    const [a, b] = [...pointers.values()];
    baseline = a ? { value: options.get(), midpoint: b ? local(midpoint(a, b)) : local(a), distance: b ? Math.max(1, distance(a, b)) : 0 } : null;
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || (event.target as Element | null)?.closest?.("[data-image-viewer-control]")) return;
    const point = { x: event.clientX, y: event.clientY };
    if (!pointers.size) multiple = false;
    pointers.set(event.pointerId, { ...point, start: point, at: event.timeStamp, moved: false, image: onImage(point) });
    if (pointers.size > 1) { multiple = true; lastTap = null; }
    rebase();
    try { stage.setPointerCapture(event.pointerId); } catch { /* Capture is optional for synthetic or already-cancelled input. */ }
    event.preventDefault();
  };
  const move = (event: PointerEvent) => {
    const point = pointers.get(event.pointerId);
    if (!point || !baseline) return;
    point.x = event.clientX; point.y = event.clientY;
    if (distance(point, point.start) > 7) point.moved = true;
    if (!options.ready()) return;
    const [a, b] = [...pointers.values()], bounds = options.bounds();
    if (b) {
      const center = local(midpoint(a, b)), scale = Math.max(1, Math.min(IMAGE_ZOOM_MAX, baseline.value.scale * distance(a, b) / baseline.distance));
      const ratio = scale / baseline.value.scale;
      options.set(clampImageTransform({ scale, x: center.x - (baseline.midpoint.x - baseline.value.x) * ratio,
        y: center.y - (baseline.midpoint.y - baseline.value.y) * ratio }, bounds));
    } else if (baseline.value.scale > 1) {
      const position = local(a);
      options.set(clampImageTransform({ ...baseline.value, x: baseline.value.x + position.x - baseline.midpoint.x, y: baseline.value.y + position.y - baseline.midpoint.y }, bounds));
    }
    event.preventDefault();
  };
  const finish = (event: PointerEvent, cancelled = false) => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX; point.y = event.clientY;
    const tap = !cancelled && !multiple && !point.moved && distance(point, point.start) <= 7 && event.timeStamp - point.at < 450;
    pointers.delete(event.pointerId);
    try { stage.releasePointerCapture(event.pointerId); } catch { /* It may already be released by the browser. */ }
    if (tap && !pointers.size) {
      if (!point.image && !onImage(point)) { lastTap = null; options.close(); }
      else if (options.ready()) {
        if (lastTap && event.timeStamp - lastTap.at < 320 && distance(point, lastTap.point) < 30) {
          options.set(zoomImage(options.get(), options.get().scale > 1 ? 1 : 2.5, local(point), options.bounds())); lastTap = null;
        } else lastTap = { at: event.timeStamp, point: { x: point.x, y: point.y } };
      }
    } else if (cancelled || point.moved || multiple) lastTap = null;
    rebase();
  };
  const up = (event: PointerEvent) => finish(event);
  const cancel = (event: PointerEvent) => finish(event, true);
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    if (!options.ready()) return;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 200 : 1);
    options.set(zoomImage(options.get(), options.get().scale * Math.exp(-Math.max(-300, Math.min(300, delta)) / 300), local({ x: event.clientX, y: event.clientY }), options.bounds()));
    lastTap = null;
  };
  stage.addEventListener("pointerdown", down);
  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", cancel);
  stage.addEventListener("lostpointercapture", cancel);
  stage.addEventListener("wheel", wheel, { passive: false });
  return () => {
    pointers.clear(); baseline = lastTap = null;
    stage.removeEventListener("pointerdown", down);
    stage.removeEventListener("pointermove", move);
    stage.removeEventListener("pointerup", up);
    stage.removeEventListener("pointercancel", cancel);
    stage.removeEventListener("lostpointercapture", cancel);
    stage.removeEventListener("wheel", wheel);
  };
}
