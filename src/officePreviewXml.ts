import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import { OFFICE_PREVIEW_LIMITS as limits, OfficePreviewError } from "./officePreviewTypes";

export type OfficeXmlNode = { [name: string]: OfficeXmlNode[] | string | Record<string, string> };
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: false, ignoreDeclaration: true });
const decoder = new TextDecoder("utf-8", { fatal: true });
function xmlPart(name: string, bytes: Uint8Array): boolean {
  if (/\.(?:xml|rels|vml)$/i.test(name)) return true;
  // Office relationship targets are not required to end in .xml. Include
  // renamed markup parts in the same limits before the engines resolve them.
  let start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while ([9, 10, 13, 32].includes(bytes[start])) start++;
  return bytes[start] === 60 || (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
}

export function validateOfficeXmlFiles(files: Map<string, Uint8Array>): Map<string, string> {
  const xml = new Map<string, string>();
  let totalBytes = 0, nodes = 0, cells = 0;
  const verify = (name: string, bytes: Uint8Array) => {
    if (xml.has(name)) return;
    totalBytes += bytes.length;
    if (bytes.length > limits.xmlBytes || totalBytes > limits.totalXmlBytes) throw new OfficePreviewError("limit");
    let source: string;
    try { source = decoder.decode(bytes); } catch { throw new OfficePreviewError("invalid"); }
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new OfficePreviewError("unsupported");
    // Count structure before any XML/Office engine allocates a tree. The
    // parser then validates real XML; this is a resource guard, not an engine.
    let depth = 0;
    // Skip comments, CDATA, and processing instructions as complete lexical
    // units. Fake closing tags inside comments must not defeat the depth cap;
    // quoted '>' and Unicode element names must not defeat the node cap.
    for (const match of source.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?([^\s!?/<>"'=]+)(?:"[^"]*"|'[^']*'|[^<>"'])*>/g)) {
      if (!match[1]) continue;
      const token = match[0];
      if (token.startsWith("</")) depth--;
      else {
        if (++nodes > limits.xmlNodes) throw new OfficePreviewError("limit");
        if (/(?:^|:)c$/.test(match[1]) && /^xl\/worksheets\//i.test(name) && ++cells > limits.inputCells) throw new OfficePreviewError("limit");
        if (!token.endsWith("/>")) depth++;
        if (depth > limits.xmlDepth) throw new OfficePreviewError("limit");
      }
    }
    if (XMLValidator.validate(source) !== true) throw new OfficePreviewError("invalid");
    xml.set(name, source);
  };
  for (const [name, bytes] of files) if (xmlPart(name, bytes)) verify(name, bytes);
  // Resolve known XML relationships and explicit XML content types too. This
  // does not rely on a part's extension or on forgiving XML parsers accepting
  // a non-whitespace prefix. Targets are map lookups, never file/network reads.
  const findLocal = (items: OfficeXmlNode[], name: string): OfficeXmlNode[] => items.flatMap(node => xmlName(node).split(":").at(-1) === name ? [node] : findLocal(xmlChildren(node), name));
  const verifyTarget = (path: string | null) => { const bytes = path && files.get(path); if (path && bytes) verify(path, bytes); };
  for (const [name, source] of xml) {
    if (/\.rels$/i.test(name)) {
      const parts = name.split("/"), relName = parts.pop() || "";
      if (parts.pop() !== "_rels") continue;
      const base = relName === ".rels" ? "" : [...parts, relName.replace(/\.rels$/i, "")].join("/");
      for (const relation of findLocal(parseOfficeXml(source), "Relationship")) {
        // Mammoth discards TargetMode for main/styles/notes relationships.
        // Guard a matching package part even when it is marked External.
        // Protocol URLs still cannot resolve to a ZIP map entry.
        if (/\/(?:officeDocument|styles|numbering|footnotes|endnotes|comments|header|footer|settings|theme|worksheet|sharedStrings|calcChain|vmlDrawing|chart|table|drawing)$/.test(xmlAttr(relation, "Type")))
          verifyTarget(officeRelationshipPath(base, xmlAttr(relation, "Target")));
      }
    } else if (name === "[Content_Types].xml") {
      const types = parseOfficeXml(source);
      for (const override of findLocal(types, "Override"))
        if (/(?:\+xml|\/xml)(?:;|$)/i.test(xmlAttr(override, "ContentType"))) verifyTarget(xmlAttr(override, "PartName").replace(/^\//, ""));
      for (const rule of findLocal(types, "Default")) {
        if (!/(?:\+xml|\/xml)(?:;|$)/i.test(xmlAttr(rule, "ContentType"))) continue;
        const extension = xmlAttr(rule, "Extension").toLowerCase();
        for (const [partName, bytes] of files) if (partName.split(".").at(-1)?.toLowerCase() === extension) verify(partName, bytes);
      }
    }
  }
  return xml;
}
export function parseOfficeXml(source: string): OfficeXmlNode[] { return parser.parse(source) as OfficeXmlNode[]; }
export function officeXmlWithoutNodes(source: string, removed: ReadonlySet<string>): string {
  const visit = (nodes: OfficeXmlNode[]): OfficeXmlNode[] => nodes.flatMap(node => {
    const name = xmlName(node);
    if (removed.has(name)) return [];
    return Array.isArray(node[name]) ? [{ ...node, [name]: visit(xmlChildren(node)) }] : [node];
  });
  return new XMLBuilder({ preserveOrder: true, ignoreAttributes: false }).build(visit(parseOfficeXml(source))) as string;
}
export function xmlName(node: OfficeXmlNode): string { return Object.keys(node).find(key => key !== ":@") || ""; }
export function xmlChildren(node: OfficeXmlNode): OfficeXmlNode[] { const value = node[xmlName(node)]; return Array.isArray(value) ? value : []; }
export function xmlAttr(node: OfficeXmlNode, name: string): string { return (node[":@"] as Record<string, string> | undefined)?.["@_" + name] || ""; }
export function xmlFind(nodes: OfficeXmlNode[], name: string): OfficeXmlNode[] {
  return nodes.flatMap(node => xmlName(node) === name ? [node] : xmlFind(xmlChildren(node), name));
}
export function xmlText(nodes: OfficeXmlNode[]): string {
  return nodes.map(node => xmlName(node) === "#text" ? String(node["#text"]) : xmlName(node) === "a:br" ? "\n" : xmlText(xmlChildren(node))).join("");
}
export function officeRelationshipPath(base: string, target: string): string | null {
  if (!target || target.length > 512 || /[\x00-\x1f\\:]/.test(target) || target.startsWith("//")) return null;
  // A leading slash is an absolute package part, never a filesystem path.
  // Mammoth resolves these targets too, so they must share the XML guard.
  const parts = target.startsWith("/") ? [] : base.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join("/");
}
export function officeRelationships(xml: Map<string, string>, base: string): Map<string, { path: string | null; external: boolean; target: string; type: string }> {
  const parts = base.split("/"), filename = parts.pop() || "";
  const source = xml.get([...parts, "_rels", filename + ".rels"].join("/"));
  const result = new Map<string, { path: string | null; external: boolean; target: string; type: string }>();
  if (!source) return result;
  for (const relationship of xmlFind(parseOfficeXml(source), "Relationship")) {
    const id = xmlAttr(relationship, "Id"), target = xmlAttr(relationship, "Target"), external = xmlAttr(relationship, "TargetMode").toLowerCase() === "external";
    if (id && !result.has(id)) result.set(id, { path: external ? null : officeRelationshipPath(base, target), external, target, type: xmlAttr(relationship, "Type") });
  }
  return result;
}
