import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { OfficePreviewError, OFFICE_PREVIEW_LIMITS as limits, type OfficeImage, type OfficeTextNode, type OfficeTextTag } from "./officePreviewTypes";
import { OFFICE_TEXT_TAGS, safeOfficeHref } from "./officePreviewPolicy";
export { OFFICE_TEXT_TAGS, safeOfficeHref } from "./officePreviewPolicy";

// Parse HTML once in the worker into a deliberately small data model. React
// renders escaped text and explicit attributes, never this source HTML.
export function officeWordNodes(html: string, images: Map<string, OfficeImage>): OfficeTextNode[] {
  if (html.length > limits.textChars * 4 + limits.totalImageBytes * 2) throw new OfficePreviewError("limit");
  let textChars = 0, count = 0;
  const visit = (node: DefaultTreeAdapterMap["childNode"], depth: number): OfficeTextNode[] => {
    if (++count > limits.outputNodes || depth > limits.xmlDepth) throw new OfficePreviewError("limit");
    if (node.nodeName === "#text") {
      const text = (node as DefaultTreeAdapterMap["textNode"]).value;
      textChars += text.length;
      if (textChars > limits.textChars) throw new OfficePreviewError("limit");
      return [{ type: "text", text }];
    }
    if (!("tagName" in node)) return [];
    if (["script", "style", "iframe", "object", "embed", "svg", "math", "template", "form"].includes(node.tagName)) return [];
    const attrs = Object.fromEntries(node.attrs.map(attr => [attr.name, attr.value]));
    if (node.tagName === "img") { const image = images.get(attrs.src); return image ? [{ type: "image", image: { ...image, alt: (attrs.alt || image.alt).slice(0, 300) } }] : []; }
    const children = node.childNodes.flatMap(child => visit(child, depth + 1));
    if (!OFFICE_TEXT_TAGS.has(node.tagName)) return children;
    const element: OfficeTextNode = { type: "element", tag: node.tagName as OfficeTextTag, children };
    if (node.tagName === "a") element.href = safeOfficeHref(attrs.href);
    if (node.tagName === "td" || node.tagName === "th") {
      const span = Number(attrs.colspan);
      if (Number.isInteger(span) && span > 1 && span <= limits.columns) element.span = span;
    }
    return [element];
  };
  return parseFragment(html).childNodes.flatMap(node => visit(node, 0));
}
