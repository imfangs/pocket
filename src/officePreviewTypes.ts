export type OfficePreviewKind = "docx" | "xlsx" | "pptx" | "archive";
export type OfficePreviewWarning = "partial" | "images";
export type OfficePreviewErrorCode = "invalid" | "limit" | "unsupported" | "timeout";

export class OfficePreviewError extends Error {
  constructor(public readonly code: OfficePreviewErrorCode) {
    super(code);
    this.name = "OfficePreviewError";
  }
}

export type OfficeImage = { src: string; width: number; height: number; alt: string };
export type OfficeTextTag = "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "ul" | "ol" | "li" |
  "table" | "thead" | "tbody" | "tr" | "th" | "td" | "strong" | "em" | "u" | "s" | "sup" | "sub" | "br" | "a";
export type OfficeTextNode = { type: "text"; text: string } | { type: "element"; tag: OfficeTextTag; children: OfficeTextNode[]; href?: string; span?: number } |
  { type: "image"; image: OfficeImage };
export type OfficeWorksheet = { name: string; rows: string[][]; rowCount: number; columnCount: number; displayedColumns: number; truncated: boolean };
export type OfficeSlideBlock = { type: "paragraph"; text: string; heading: boolean; bullet: boolean } |
  { type: "image"; image: OfficeImage } | { type: "table"; rows: string[][] };
export type OfficeSlide = { number: number; blocks: OfficeSlideBlock[] };
export type OfficeArchiveEntry = { name: string; size: number; compressedSize: number; directory: boolean };
type Common = { warnings: OfficePreviewWarning[] };
export type OfficePreviewData = Common & (
  { kind: "docx"; nodes: OfficeTextNode[] } |
  { kind: "xlsx"; sheets: OfficeWorksheet[] } |
  { kind: "pptx"; slides: OfficeSlide[]; totalSlides: number } |
  { kind: "archive"; entries: OfficeArchiveEntry[]; expandedSize: number }
);

export const OFFICE_PREVIEW_LIMITS = Object.freeze({
  compressedBytes: 20 * 1024 * 1024, entries: 2000, expandedBytes: 40 * 1024 * 1024,
  entryBytes: 8 * 1024 * 1024, xmlBytes: 4 * 1024 * 1024, totalXmlBytes: 8 * 1024 * 1024,
  xmlNodes: 100000, xmlDepth: 128, textChars: 400000, outputNodes: 15000,
  imageBytes: 1024 * 1024, totalImageBytes: 4 * 1024 * 1024, images: 24,
  imageEdge: 8192, imagePixels: 8 * 1024 * 1024, totalImagePixels: 16 * 1024 * 1024,
  sheets: 20, rows: 300, columns: 50, cells: 20000, inputCells: 50000, inputColumns: 50000,
  slides: 100, timeoutMs: 12000,
});
