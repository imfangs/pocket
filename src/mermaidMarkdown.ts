import type { Code, Root, RootContent } from "mdast";

// mdast accepts an unfinished fence while a reply streams. Only a real matching
// closing fence grants rendering; the original Markdown and code stay intact.
export function closedMermaidFence(node: Code, markdown: string) {
  if (node.lang?.toLowerCase() !== "mermaid" || node.position?.start.offset == null || node.position.end.offset == null) return false;
  const raw = markdown.slice(node.position.start.offset, node.position.end.offset);
  const lines = raw.split(/\r\n|\r|\n/);
  const open = lines[0].match(/^(`{3,}|~{3,})/);
  if (!open || lines.length < 2) return false;
  const close = lines.at(-1)!.match(/^[\t >]*(`{3,}|~{3,})[\t ]*$/);
  // A fence-looking final line inside the code is still content. mdast removes
  // an actual closer from value, including within lists and blockquotes.
  const contentLines = node.value ? node.value.split(/\r\n|\r|\n/).length : 0;
  return !!close && contentLines <= lines.length - 2 && close[1][0] === open[1][0] && close[1].length >= open[1].length;
}

export default function remarkMermaid() {
  return (tree: Root, file: { value: unknown }) => {
    const markdown = String(file.value);
    const visit = (node: Root | RootContent) => {
      if (node.type === "code" && node.lang?.toLowerCase() === "mermaid") {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, "data-mermaid-closed": closedMermaidFence(node, markdown) ? "true" : "false" } };
      }
      if ("children" in node) for (const child of node.children) visit(child as RootContent);
    };
    visit(tree);
  };
}
