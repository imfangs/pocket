import { FEEDBACK_LIMITS } from "../contracts.ts";

export type FeedbackCapture = {
  blob: Blob; width: number; height: number; mime: "image/png" | "image/jpeg";
};
export type CaptureViewport = { width: number; height: number; left?: number; top?: number };
export class FeedbackCaptureError extends Error {
  readonly code: string;
  constructor(message: string, code = "capture_unavailable") {
    super(message); this.name = "FeedbackCaptureError"; this.code = code;
  }
}
const MAX_SIDE = 2048;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_PIXELS = 16 * 1024 * 1024;
const EMPTY_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
// WebKit exposes hundreds of non-paint properties per node. Copy the layout,
// text and vector paint contract instead of serializing every engine extension.
const PAINT_PROPERTIES = (`display visibility position top right bottom left z-index float clear opacity box-sizing
width height min-width min-height max-width max-height aspect-ratio margin padding border-top border-right border-bottom border-left
border-radius border-image-source border-image-slice border-image-width border-image-outset border-image-repeat
background-color background-image background-position background-size background-repeat background-origin background-clip
box-shadow outline outline-offset filter backdrop-filter overflow overflow-x overflow-y clip clip-path isolation
font-family font-size font-weight font-style font-variant font-stretch font-feature-settings font-variation-settings font-kerning
font-synthesis font-optical-sizing font-size-adjust text-size-adjust -webkit-text-size-adjust -webkit-font-smoothing -moz-osx-font-smoothing
line-height letter-spacing word-spacing color text-align text-indent text-decoration text-transform white-space word-break overflow-wrap
text-overflow text-shadow text-rendering vertical-align direction writing-mode text-orientation unicode-bidi content
flex flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-self align-content justify-content justify-items justify-self
order gap row-gap column-gap grid-template-columns grid-template-rows grid-auto-flow grid-auto-columns grid-auto-rows grid-column grid-row
border-collapse border-spacing table-layout empty-cells object-fit object-position list-style-type list-style-position list-style-image
transform transform-origin transform-box perspective perspective-origin rotate scale translate zoom
fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit
marker-start marker-mid marker-end vector-effect paint-order stop-color stop-opacity shape-rendering text-anchor dominant-baseline alignment-baseline
-webkit-text-fill-color -webkit-text-stroke -webkit-line-clamp -webkit-box-orient -webkit-appearance -webkit-mask-image
appearance color-scheme accent-color`).split(/\s+/);
function checkSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("截图已取消", "AbortError");
}
function dimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[0] === 137 && String.fromCharCode(...bytes.subarray(1, 4)) === "PNG")
    return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes[0] !== 255 || bytes[1] !== 216) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 255) return null;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 217 || marker === 218) return null;
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    if (offset + 2 > bytes.length) return null;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (length < 7) return null;
      return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
    }
    offset += length;
  }
  return null;
}

export async function loadCaptureImage(blob: Blob, signal?: AbortSignal): Promise<HTMLImageElement> {
  checkSignal(signal);
  if (!blob.size || blob.size > MAX_INPUT_BYTES || !["image/png", "image/jpeg"].includes(blob.type))
    throw new FeedbackCaptureError("请选择20MiB以内的PNG或JPEG截图。", "image_format");
  const size = dimensions(new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer()));
  checkSignal(signal);
  if (!size || size.width < 1 || size.height < 1 || size.width > 8192 || size.height > 8192 || size.width * size.height > MAX_INPUT_PIXELS)
    throw new FeedbackCaptureError("截图尺寸过大或无法读取，请截取当前画面后重试。", "image_dimensions");
  const url = URL.createObjectURL(blob), image = new Image();
  image.decoding = "async";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new FeedbackCaptureError("截图读取较慢，请换一张图片。", "capture_timeout")), 8000);
      const abort = () => finish(new DOMException("截图已取消", "AbortError"));
      const finish = (error?: Error) => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        image.onload = image.onerror = null;
        if (error) { image.src = ""; reject(error); } else resolve();
      };
      image.onload = () => finish();
      image.onerror = () => finish(new FeedbackCaptureError("这张截图无法读取，请重新选择。", "image_decode"));
      signal?.addEventListener("abort", abort, { once: true });
      image.src = url;
    });
    checkSignal(signal);
    if ((image.naturalWidth !== size.width || image.naturalHeight !== size.height) &&
        !(blob.type === "image/jpeg" && image.naturalWidth === size.height && image.naturalHeight === size.width))
      throw new FeedbackCaptureError("截图尺寸不一致，请重新选择。", "image_dimensions");
    return image;
  } finally { URL.revokeObjectURL(url); }
}

function blobFromCanvas(canvas: HTMLCanvasElement, mime: "image/png" | "image/jpeg", quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    try { canvas.toBlob(blob => blob ? resolve(blob) : reject(new FeedbackCaptureError("截图导出失败，请重试。")), mime, quality); }
    catch { reject(new FeedbackCaptureError("当前画面含无法导出的内容，可选择已有截图。", "capture_assets")); }
  });
}

/** Always returns a bounded raster; never mutates the original capture. */
export async function encodeFeedbackCanvas(source: HTMLCanvasElement, signal?: AbortSignal): Promise<FeedbackCapture> {
  checkSignal(signal);
  const ratio = Math.min(1, MAX_SIDE / Math.max(source.width, source.height));
  let canvas = source;
  if (ratio < 1) {
    canvas = source.ownerDocument.createElement("canvas");
    canvas.width = Math.max(1, Math.round(source.width * ratio));
    canvas.height = Math.max(1, Math.round(source.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new FeedbackCaptureError("当前浏览器无法生成截图。");
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
  }
  let blob = await blobFromCanvas(canvas, "image/png");
  checkSignal(signal);
  if (blob.size <= FEEDBACK_LIMITS.imageBytes)
    return { blob, width: canvas.width, height: canvas.height, mime: "image/png" };
  // Large photographic screenshots have a bounded JPEG fallback. Flatten the
  // alpha channel explicitly so a transparent page does not become black.
  const opaque = source.ownerDocument.createElement("canvas");
  opaque.width = canvas.width; opaque.height = canvas.height;
  const context = opaque.getContext("2d");
  if (!context) throw new FeedbackCaptureError("当前浏览器无法生成截图。");
  context.fillStyle = "#ffffff"; context.fillRect(0, 0, opaque.width, opaque.height);
  context.drawImage(canvas, 0, 0);
  for (const quality of [.9, .78, .65]) {
    blob = await blobFromCanvas(opaque, "image/jpeg", quality); checkSignal(signal);
    if (blob.size <= FEEDBACK_LIMITS.imageBytes)
      return { blob, width: opaque.width, height: opaque.height, mime: "image/jpeg" };
  }
  throw new FeedbackCaptureError("截图较大，请缩小范围或选择一张较小的截图。", "image_size");
}

export async function normalizeFeedbackImage(blob: Blob, signal?: AbortSignal): Promise<FeedbackCapture> {
  const image = await loadCaptureImage(blob, signal);
  const scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new FeedbackCaptureError("当前浏览器无法读取图片。");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return encodeFeedbackCanvas(canvas, signal);
}

const intersects = (a: DOMRect, b: { left: number; top: number; width: number; height: number }) =>
  a.width > 0 && a.height > 0 && a.right > b.left && a.bottom > b.top && a.left < b.left + b.width && a.top < b.top + b.height;

/** Capture the current webpage viewport, not the device screen or other apps. */
export async function captureFeedback(root: HTMLElement, options: {
  signal?: AbortSignal; viewport?: CaptureViewport;
} = {}): Promise<FeedbackCapture> {
  checkSignal(options.signal);
  const document = root.ownerDocument, browser = document.defaultView;
  if (!browser || !root.isConnected) throw new FeedbackCaptureError("当前页面暂时无法截图。");
  if (root === document.documentElement) root = document.body;
  const visual = browser.visualViewport;
  const viewport = { width: options.viewport?.width ?? visual?.width ?? browser.innerWidth,
    height: options.viewport?.height ?? visual?.height ?? browser.innerHeight,
    left: options.viewport?.left ?? visual?.offsetLeft ?? 0, top: options.viewport?.top ?? visual?.offsetTop ?? 0 };
  if (![viewport.width, viewport.height].every(n => Number.isFinite(n) && n >= 1 && n <= 20000))
    throw new FeedbackCaptureError("当前页面尺寸无法截图。", "image_dimensions");
  const nodes = [root, ...root.querySelectorAll<HTMLElement>("*")];
  if (nodes.length > 6000) throw new FeedbackCaptureError("当前页面较复杂，可以选择已有截图。", "capture_limit");
  const visibleUrls = new Set<string>();
  const loadedImages = new Map<string, HTMLImageElement>();
  const styles = new Map<Element, CSSStyleDeclaration>();
  const styleOf = (node: Element) => {
    let style = styles.get(node);
    if (!style) { style = browser.getComputedStyle(node); styles.set(node, style); }
    return style;
  };
  const visibleSubtrees = new Set<Element>(), pruned = new Set<Element>();
  let inlineImageBytes = 0, canvasPixels = 0;
  const visible = (node: Element) => {
    const box = node.getBoundingClientRect();
    if (!intersects(box, viewport)) return false;
    let left = Math.max(box.left, viewport.left), right = Math.min(box.right, viewport.left + viewport.width);
    let top = Math.max(box.top, viewport.top), bottom = Math.min(box.bottom, viewport.top + viewport.height);
    for (let parent = node.parentElement; parent && parent !== root.parentElement; parent = parent.parentElement) {
      const style = styleOf(parent);
      if (/(?:auto|scroll|hidden|clip)/.test(style.overflow + style.overflowX + style.overflowY)) {
        const clip = parent.getBoundingClientRect();
        left = Math.max(left, clip.left); right = Math.min(right, clip.right);
        top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
        if (right <= left || bottom <= top) return false;
      }
    }
    return true;
  };
  for (const node of nodes) {
    if (node.closest("[data-feedback-ignore]")) continue;
    if (node instanceof browser.HTMLCanvasElement) {
      canvasPixels += node.width * node.height;
      if (canvasPixels > MAX_INPUT_PIXELS) throw new FeedbackCaptureError("当前画布较大，请使用手机截图。", "capture_limit");
    }
    if (node instanceof browser.HTMLImageElement && node.src.startsWith("data:")) {
      inlineImageBytes += node.src.length;
      if (inlineImageBytes > 12 * 1024 * 1024) throw new FeedbackCaptureError("当前页面图片较大，请使用手机截图。", "capture_limit");
    }
    if (/^(?:IFRAME|VIDEO|AUDIO|OBJECT|EMBED)$/.test(node.tagName) && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0)
      throw new FeedbackCaptureError("这段内容请使用手机截图后选择图片。", "capture_media");
    if (!visible(node)) continue;
    for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) {
      visibleSubtrees.add(ancestor); if (ancestor === root) break;
    }
    if (node instanceof browser.HTMLImageElement) {
      const url = node.currentSrc || node.src;
      visibleUrls.add(url);
      if (node.complete && node.naturalWidth && node.naturalHeight) loadedImages.set(url, node);
    }
    if (node instanceof browser.HTMLInputElement && node.type === "image") visibleUrls.add(node.src);
    if (node.tagName.toLowerCase() === "image") visibleUrls.add(node.getAttribute("href") || node.getAttribute("xlink:href") || "");
    const style = styleOf(node);
    for (const value of [style.backgroundImage, style.maskImage, style.borderImageSource, style.listStyleImage])
      if (typeof value === "string") for (const match of value.matchAll(/url\(["']?([^"')]+)["']?\)/g)) visibleUrls.add(new URL(match[1], document.baseURI).href);
  }
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (node !== root && !visibleSubtrees.has(node) && rect.width > 0 && rect.height > 0 &&
        !["inline", "contents", "none"].includes(styleOf(node).display)) pruned.add(node);
  }
  const controller = new AbortController();
  const abort = () => controller.abort(); options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let timedOut = false, context: Awaited<ReturnType<typeof import("modern-screenshot")["createContext"]>> | undefined;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 8000);
  let resourceCount = 0, resourceBytes = 0, failedResource = false;
  const resources = new Map<string, Promise<string>>();
  type ImageSlot = { index: number; node: Element; visible: boolean };
  type CloneFrame = { original: Element; childIndex: number; images: ImageSlot[] };
  const cloneFrames: CloneFrame[] = [{ original: root, childIndex: 0, images: [] }];
  try {
    checkSignal(controller.signal);
    const { createContext, domToCanvas, destroyContext } = await import("modern-screenshot");
    checkSignal(controller.signal);
    const originalRect = root.getBoundingClientRect();
    const background = browser.getComputedStyle(root).backgroundColor;
    const fetchImage = (raw: string): Promise<string> => {
      const url = new URL(raw, document.baseURI);
      if (!visibleUrls.has(raw) && !visibleUrls.has(url.href)) return Promise.resolve(EMPTY_IMAGE);
      let promise = resources.get(url.href);
      if (!promise) {
        promise = (async () => {
          if (++resourceCount > 32) throw new FeedbackCaptureError("截图中的图片较多，请缩小范围。", "capture_limit");
          const loaded = loadedImages.get(raw) || loadedImages.get(url.href);
          if (loaded) {
            // Reuse pixels already visible to the browser. In particular an
            // old signed attachment URL need not be fetched again to capture it.
            const canvas = document.createElement("canvas");
            const scale = Math.min(1, MAX_SIDE / Math.max(loaded.naturalWidth, loaded.naturalHeight));
            canvas.width = Math.max(1, Math.round(loaded.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(loaded.naturalHeight * scale));
            const context = canvas.getContext("2d");
            if (!context) throw new Error("canvas_unavailable");
            context.drawImage(loaded, 0, 0, canvas.width, canvas.height);
            const asset = await encodeFeedbackCanvas(canvas, controller.signal);
            resourceBytes += asset.blob.size;
            if (resourceBytes > 8 * 1024 * 1024) throw new Error("resource_too_large");
            return await new Promise<string>((resolve, reject) => {
              const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(asset.blob);
            });
          }
          if (!["http:", "https:", "blob:"].includes(url.protocol) || url.origin !== browser.location.origin) throw new Error("cross_origin_resource");
          const response = await browser.fetch(url.href, { credentials: "same-origin", cache: "force-cache", redirect: "error", signal: controller.signal });
          if (!response.ok || !response.body) throw new Error("resource_unavailable");
          const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read(); if (done) break;
              size += value.byteLength; resourceBytes += value.byteLength;
              if (size > 2 * 1024 * 1024 || resourceBytes > 8 * 1024 * 1024) throw new Error("resource_too_large");
              chunks.push(value);
            }
          } finally { await reader.cancel().catch(() => {}); }
          const blob = new Blob(chunks as BlobPart[], { type: response.headers.get("content-type") || "image/png" });
          return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
          });
        })().catch(() => { failedResource = true; return EMPTY_IMAGE; });
        resources.set(url.href, promise);
      }
      return promise;
    };
    context = await createContext(root, {
      width: viewport.width, height: viewport.height, scale: Math.min(2, MAX_SIDE / Math.max(viewport.width, viewport.height)),
      maximumCanvasSize: MAX_SIDE, font: false, workerNumber: 0, timeout: 2500,
      includeStyleProperties: PAINT_PROPERTIES,
      backgroundColor: background === "rgba(0, 0, 0, 0)" ? "#ffffff" : background,
      features: { restoreScrollPosition: true, copyScrollbar: false }, fetchFn: fetchImage,
      style: { width: `${originalRect.width}px`, height: `${originalRect.height}px`, position: "absolute", margin: "0",
        left: `${originalRect.left}px`, top: `${originalRect.top}px`, transform: "none" },
      onCreateForeignObjectSvg(svg) {
        // Crop the final coordinate space, including fixed descendants. Moving
        // only the cloned root leaves a fixed child behind during viewport pan.
        svg.setAttribute("viewBox", `${viewport.left} ${viewport.top} ${viewport.width} ${viewport.height}`);
        const content = svg.querySelector("foreignObject");
        content?.setAttribute("width", String(Math.max(browser.innerWidth, viewport.left + viewport.width)));
        content?.setAttribute("height", String(Math.max(browser.innerHeight, viewport.top + viewport.height)));
        for (const script of svg.querySelectorAll("script")) script.remove();
        // The library can copy a referenced SVG definition after clone hooks.
        // Do not let an external href hidden in that definition escape the
        // bounded, same-origin asset resolver during final image decoding.
        for (const resource of svg.querySelectorAll("image, use")) {
          const href = resource.getAttribute("href") || resource.getAttribute("xlink:href");
          if (href && !href.startsWith("data:") && !href.startsWith("#")) {
            resource.removeAttribute("href"); resource.removeAttribute("xlink:href"); failedResource = true;
          }
        }
      },
      filter(node) {
        checkSignal(controller.signal);
        // Keep the offscreen block itself (its computed width/height preserve
        // flow), but skip its descendants. A long chat should not serialize or
        // fetch every hidden old message merely to capture one viewport.
        for (let parent = node.parentElement; parent && parent !== root.parentElement; parent = parent.parentElement)
          if (pruned.has(parent)) return false;
        const parent = cloneFrames.at(-1);
        if (node.nodeType !== 1) { if (parent) parent.childIndex++; return true; }
        const element = node as Element;
        if (element.matches('script, style, link, meta, base, iframe, video, audio, source, object, embed, [data-feedback-ignore], [id^="__SANDBOX__"]')) return false;
        if (element.tagName === "IMG" || element.tagName.toLowerCase() === "image" || element.matches('input[type="image"]')) {
          // Native cloneNode of a lazy image may start a request before the
          // library's fetch hook runs. Insert a data-only image at the same
          // child position after cloning its parent instead.
          parent?.images.push({ index: parent.childIndex++, node: element, visible: visible(element) });
          return false;
        }
        if (parent) parent.childIndex++;
        cloneFrames.push({ original: element, childIndex: 0, images: [] });
        return true;
      },
      async onCloneEachNode(node) {
        checkSignal(controller.signal);
        if (node.nodeType !== 1) return;
        const frame = cloneFrames.pop();
        const element = node as HTMLElement;
        if (!frame || frame.original.tagName !== element.tagName && frame.original.tagName !== "CANVAS")
          throw new FeedbackCaptureError("页面结构暂时无法截图，请选择已有截图。", "capture_structure");
        for (const slot of frame?.images ?? []) {
          const original = slot.node;
          const svg = original.namespaceURI === "http://www.w3.org/2000/svg";
          const replacement = svg ? document.createElementNS(original.namespaceURI!, "image") : document.createElement("img");
          const src = original instanceof browser.HTMLImageElement ? original.currentSrc || original.src
            : original instanceof browser.HTMLInputElement ? original.src
            : original.getAttribute("href") || original.getAttribute("xlink:href") || "";
          if (slot.visible) {
            visibleUrls.add(src);
            if (original instanceof browser.HTMLImageElement && original.complete && original.naturalWidth && original.naturalHeight)
              loadedImages.set(src, original);
          }
          const data = slot.visible ? await fetchImage(src) : EMPTY_IMAGE;
          checkSignal(controller.signal);
          for (const name of svg ? ["x", "y", "width", "height", "preserveAspectRatio", "transform"] : ["alt", "width", "height"]) {
            const value = original.getAttribute(name); if (value !== null) replacement.setAttribute(name, value);
          }
          const computed = styleOf(original), style = (replacement as HTMLElement | SVGImageElement).style;
          for (const name of PAINT_PROPERTIES) {
            const value = computed.getPropertyValue(name); if (value) style.setProperty(name, value);
          }
          // Empty placeholders retain replaced-element geometry and therefore
          // cannot pull visible siblings upward inside a scrolled container.
          style.width = computed.width; style.height = computed.height;
          if (svg) replacement.setAttribute("href", data); else replacement.setAttribute("src", data);
          element.insertBefore(replacement, element.childNodes.item(slot.index));
        }
        for (const name of element.getAttributeNames()) if (/^on/i.test(name)) element.removeAttribute(name);
        if (element.matches('input[type="password"], [data-feedback-redact]')) {
          element.setAttribute("value", ""); element.textContent = "";
        } else if (element.tagName === "TEXTAREA") element.textContent = element.getAttribute("value") || "";
        if (element.tagName === "INPUT" && (element as HTMLInputElement).checked) element.setAttribute("checked", "");
        if (element.tagName === "SELECT") for (const option of element.querySelectorAll("option"))
          option.toggleAttribute("selected", option.value === element.getAttribute("value"));
        if (element.tagName.toLowerCase() === "use") {
          const href = element.getAttribute("href") || element.getAttribute("xlink:href");
          if (href && !href.startsWith("#")) { element.removeAttribute("href"); element.removeAttribute("xlink:href"); }
        }
      },
    });
    try {
      const canvas = await domToCanvas(context); checkSignal(controller.signal);
      if (!root.isConnected) throw new FeedbackCaptureError("页面已经切换，请重新截图。", "capture_changed");
      if (failedResource) throw new FeedbackCaptureError("部分页面图片无法安全截取，可选择手机截图或仅发送说明。", "capture_assets");
      return await encodeFeedbackCanvas(canvas, controller.signal);
    } finally { destroyContext(context); context = undefined; }
  } catch (error) {
    if (timedOut) throw new FeedbackCaptureError("页面截图较慢，可重试、选图或仅发送说明。", "capture_timeout");
    throw error;
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
    controller.abort();
    if (context) { const { destroyContext } = await import("modern-screenshot"); destroyContext(context); }
  }
}
