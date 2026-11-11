import createDOMPurify, { type WindowLike } from "dompurify";

export const maxSvgPreviewBytes = 1024 * 1024;
const svgNamespace = "http://www.w3.org/2000/svg";
const maxSvgDimension = 8192, maxSvgPixels = 16 * 1024 * 1024, maxSvgElements = 5000;
const forbiddenTags = ["script", "foreignobject", "animate", "animatemotion", "animatetransform", "set", "discard", "mpath", "a", "style", "image", "feimage"];
const styleProperties = new Set(["color", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-opacity", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity",
  "font-family", "font-size", "font-weight", "font-style", "text-anchor", "dominant-baseline", "visibility", "display", "clip-path", "mask", "filter"]);
const fragment = /^#[A-Za-z_][\w.:-]*$/;

function localResourcesOnly(value: string): boolean {
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return false;
  const withoutFragments = value.replace(/url\(\s*(["']?)#[A-Za-z_][\w.:-]*\1\s*\)/gi, "");
  return !/url\s*\(/i.test(withoutFragments) && !/(?:@import|expression\s*\()/i.test(value);
}

function svgLength(value: string | null): number | null {
  if (value === null || value.trim().endsWith("%")) return null;
  const match = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(value);
  if (!match) throw new Error("SVG 尺寸暂不支持预览，请下载后查看。");
  const units: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
  return Number(match[1]) * (units[match[2]?.toLowerCase() ?? "px"] ?? 1);
}

export function sanitizeSvgPreview(source: string, environment: WindowLike): { source: string; width: number; height: number } {
  if (new TextEncoder().encode(source).length > maxSvgPreviewBytes) throw new Error("SVG 较大，请下载后查看。");
  // An SVG image needs no document type, entities or stylesheet processing instructions.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source) || /<\?xml-stylesheet\b/i.test(source))
    throw new Error("此 SVG 暂不支持静态预览，请下载后查看。");
  const parsed = new environment.DOMParser().parseFromString(source, "image/svg+xml");
  const original = parsed.documentElement;
  if (original.localName !== "svg" || original.namespaceURI !== svgNamespace || parsed.getElementsByTagName("parsererror").length)
    throw new Error("此文件不是有效的 SVG，请下载后查看。");
  const viewBox = original.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (viewBox && (viewBox.length !== 4 || !viewBox.every(Number.isFinite) || Math.abs(viewBox[0]) > 1000000 || Math.abs(viewBox[1]) > 1000000 || viewBox[2] <= 0 || viewBox[3] <= 0 || viewBox[2] > maxSvgDimension || viewBox[3] > maxSvgDimension || viewBox[2] * viewBox[3] > maxSvgPixels))
    throw new Error("SVG 尺寸暂不支持预览，请下载后查看。");
  const originalWidth = svgLength(original.getAttribute("width")), originalHeight = svgLength(original.getAttribute("height"));
  const width = originalWidth ?? (originalHeight && viewBox ? originalHeight * viewBox[2] / viewBox[3] : viewBox?.[2] ?? 300);
  const height = originalHeight ?? (originalWidth && viewBox ? originalWidth * viewBox[3] / viewBox[2] : viewBox?.[3] ?? 150);
  if (![width, height].every(value => Number.isFinite(value) && value > 0 && value <= maxSvgDimension) || width * height > maxSvgPixels)
    throw new Error("SVG 尺寸暂不支持预览，请下载后查看。");
  const originalElements = Array.from(original.querySelectorAll("*"));
  if (originalElements.length > maxSvgElements) throw new Error("此 SVG 暂不支持静态预览，请下载后查看。");
  for (const element of originalElements) {
    let depth = 0, parent = element.parentElement;
    while (parent && depth <= 64) { depth++; parent = parent.parentElement; }
    if (depth > 64) throw new Error("此 SVG 暂不支持静态预览，请下载后查看。");
  }
  const purifier = createDOMPurify(environment);
  const clean = purifier.sanitize(source, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["use"],
    FORBID_TAGS: forbiddenTags, FORBID_ATTR: ["xml:base", "src"], ALLOW_DATA_ATTR: false });
  const document = new environment.DOMParser().parseFromString(clean, "image/svg+xml");
  const root = document.documentElement;
  if (root.localName !== "svg" || root.namespaceURI !== svgNamespace || document.getElementsByTagName("parsererror").length)
    throw new Error("此文件不是有效的 SVG，请下载后查看。");
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (element.namespaceURI !== svgNamespace || forbiddenTags.includes(element.localName.toLowerCase())) { element.remove(); continue; }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase(), value = attribute.value;
      if (name.startsWith("on") || name === "src" || name === "xml:base" || name === "base" || name === "target" ||
          name === "externalresourcesrequired" || ((name === "href" || name === "xlink:href") && !fragment.test(value)) ||
          !localResourcesOnly(value)) element.removeAttributeNode(attribute);
    }
    const style = element.getAttribute("style");
    if (style !== null) {
      const safeStyle = style.split(";").map(declaration => {
        const colon = declaration.indexOf(":"), name = declaration.slice(0, colon).trim().toLowerCase();
        const value = declaration.slice(colon + 1).trim();
        return colon > 0 && styleProperties.has(name) && value && localResourcesOnly(value) ? `${name}:${value}` : "";
      }).filter(Boolean).join(";");
      if (safeStyle) element.setAttribute("style", safeStyle); else element.removeAttribute("style");
    }
  }
  root.setAttribute("xmlns", svgNamespace); root.setAttribute("width", String(width)); root.setAttribute("height", String(height));
  if (!viewBox) root.setAttribute("viewBox", `0 0 ${width} ${height}`);
  return { source: root.outerHTML, width, height };
}

export async function readSvgPreviewBlob(blob: Blob, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (blob.size > maxSvgPreviewBytes) throw new Error("SVG 较大，请下载后查看。");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  signal?.throwIfAborted();
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error("此文件不是有效的 SVG，请下载后查看。"); }
}
