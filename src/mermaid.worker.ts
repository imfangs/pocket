import { renderMermaid } from "./mermaidRender";

self.onmessage = async (event: MessageEvent<{ id: number; source: string; width: number }>) => {
  const { id, source, width } = event.data;
  const result = await renderMermaid(source, width, () => self.postMessage({ id, phase: "rendering" }));
  self.postMessage({ id, result });
};
