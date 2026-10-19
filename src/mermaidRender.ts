import { detectType, register, registered, render } from "pele/core";
import { DIAGRAM_LIMITS, sourceWithinLimits, validDiagramResult, type DiagramResult } from "./mermaidPolicy";

// Only these three families have passed Pocket's reading fixtures. Other
// Mermaid types remain source instead of claiming the whole dialect works.
async function load(type: ReturnType<typeof detectType>) {
  if (type === null) return false;
  if (registered(type)) return true;
  if (type === "flowchart") register((await import("pele/diagrams/flowchart")).default);
  else if (type === "sequence") register((await import("pele/diagrams/sequence")).default);
  else if (type === "state") register((await import("pele/diagrams/state")).default);
  else return false;
  return true;
}

export async function renderMermaid(source: string, width: number, rendering: () => void): Promise<DiagramResult> {
  if (typeof source !== "string" || !sourceWithinLimits(source)) return { ok: false, reason: "limit" };
  try {
    if (!await load(detectType(source))) return { ok: false, reason: "unsupported" };
  } catch { return { ok: false, reason: "unavailable" }; }
  rendering();
  try {
    const output = render(source, { links: false, images: false, limit: DIAGRAM_LIMITS.source, outputLimit: DIAGRAM_LIMITS.output,
      maxEdges: DIAGRAM_LIMITS.edges, maxWidth: Math.max(280, Math.min(720, width)), fontSize: 15,
      fontFamily: "system-ui, sans-serif", responsive: false, padding: 16, idPrefix: "pocket-diagram" });
    const result = { ok: true as const, svg: output.svg, width: output.width, height: output.height };
    return validDiagramResult(result) ? result : { ok: false, reason: "limit" };
  } catch (error) {
    return { ok: false, reason: typeof error === "object" && error !== null && "code" in error && error.code === "limit" ? "limit" : "invalid" };
  }
}
