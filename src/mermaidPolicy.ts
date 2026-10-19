export const DIAGRAM_LIMITS = { source: 20_000, lines: 300, edges: 150, output: 400_000, dimension: 8192, area: 16_000_000 } as const;
export type DiagramFailure = "unsupported" | "limit" | "invalid" | "unavailable" | "timeout";
export type DiagramResult = { ok: true; svg: string; width: number; height: number } | { ok: false; reason: DiagramFailure };
export const diagramDataPrefix = "data:image/svg+xml;charset=utf-8,";

export function sourceWithinLimits(source: string) {
  return source.length <= DIAGRAM_LIMITS.source && source.split(/\r\n|\r|\n/).length <= DIAGRAM_LIMITS.lines;
}
export function validDiagramResult(result: unknown): result is Extract<DiagramResult, { ok: true }> {
  if (!result || typeof result !== "object") return false;
  const value = result as Partial<Extract<DiagramResult, { ok: true }>>;
  return value.ok === true && typeof value.svg === "string" && value.svg.length <= DIAGRAM_LIMITS.output &&
    /^<svg\s/.test(value.svg) && typeof value.width === "number" && typeof value.height === "number" &&
    Number.isFinite(value.width) && Number.isFinite(value.height) && value.width > 0 && value.height > 0 &&
    value.width <= DIAGRAM_LIMITS.dimension && value.height <= DIAGRAM_LIMITS.dimension && value.width * value.height <= DIAGRAM_LIMITS.area;
}

// The SVG is an inert image, never inserted into the message DOM. Its palette
// must travel with it: CSS variables on the page do not enter an <img> document.
export function diagramDataUrl(svg: string, dark: boolean) {
  const colors = dark
    ? ["#20201f", "#e9e9e5", "#bcbcb4", "#bcbcb4", "#2c2c29", "#343431", "#83837b", "#8dbde6"]
    : ["#fafaf8", "#272724", "#676760", "#676760", "#f0f0ec", "#e6e6df", "#92928a", "#397ca8"];
  const names = ["bg", "fg", "muted", "line", "surface", "surface-alt", "border", "accent"];
  const palette = names.map((name, index) => `--pele-${name}:${colors[index]}`).join(";");
  return diagramDataPrefix + encodeURIComponent(svg.replace(/(<svg\b[^>]*>)/, `$1<style>svg{${palette};background:${colors[0]}}</style>`));
}
