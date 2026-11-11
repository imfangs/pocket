import mammoth from "mammoth/mammoth.browser.js";
import ExcelJS from "exceljs";
import { readBoundedOfficeArchive, safeOfficeZip } from "./officePreviewArchive";
import { createOfficeImageCollector } from "./officePreviewImages";
import { officeWordNodes } from "./officePreviewWord";
import { officeRelationships, officeXmlWithoutNodes, parseOfficeXml, validateOfficeXmlFiles, xmlAttr, xmlChildren, xmlFind, xmlName, xmlText, type OfficeXmlNode } from "./officePreviewXml";
import { OFFICE_PREVIEW_LIMITS as limits, OfficePreviewError, type OfficeImage, type OfficePreviewData, type OfficePreviewKind, type OfficeSlide, type OfficeSlideBlock, type OfficeWorksheet } from "./officePreviewTypes";

function clippedText(value: string): string { return value.length > 10000 ? value.slice(0, 10000) + "…" : value; }
function cellText(value: ExcelJS.CellValue | undefined, formula?: string): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isFinite(value.valueOf()) ? value.toISOString().replace(/T00:00:00\.000Z$/, "") : "";
  if (typeof value === "string") return clippedText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Formula results are cached source values; formulas are never evaluated.
  if ("formula" in value || "sharedFormula" in value) {
    const result = "result" in value ? value.result : undefined;
    return result === undefined ? clippedText("=" + (formula || ("formula" in value ? value.formula : ""))) : cellText(result);
  }
  if ("richText" in value) return clippedText(value.richText.map(run => run.text).join(""));
  if ("text" in value) return clippedText(value.text);
  if ("error" in value) return value.error;
  return "";
}

async function parseWorkbook(files: Map<string, Uint8Array>, xml: Map<string, string>): Promise<OfficePreviewData> {
  const source = xml.get("xl/workbook.xml");
  if (!source) throw new OfficePreviewError("invalid");
  const declarations = xmlFind(parseOfficeXml(source), "sheet"), sheetRelationships = officeRelationships(xml, "xl/workbook.xml");
  if (declarations.length > limits.sheets) throw new OfficePreviewError("limit");
  const usedPaths = new Set<string>();
  for (const sheet of declarations) {
    const path = sheetRelationships.get(xmlAttr(sheet, "r:id"))?.path;
    if (path && usedPaths.has(path)) throw new OfficePreviewError("invalid");
    if (path) usedPaths.add(path);
  }
  // ExcelJS's loader matches worksheet filenames with this unanchored pattern.
  // Count all parts it may consume, including unusual prefix/suffix names.
  const parts = [...xml].filter(([name]) => /xl\/worksheets\/sheet\d+\.xml/.test(name));
  if (parts.length > limits.sheets) throw new OfficePreviewError("limit");
  let inputColumns = 0, inputCells = 0;
  for (const [, sheetSource] of parts) {
    const document = parseOfficeXml(sheetSource), cells = xmlFind(document, "c");
    inputCells += cells.length;
    if (inputCells > limits.inputCells) throw new OfficePreviewError("limit");
    let maxColumn = 0;
    for (const cell of cells) {
      const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/i.exec(xmlAttr(cell, "r"));
      if (!match) throw new OfficePreviewError("invalid");
      const column = [...match[1].toUpperCase()].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
      if (column > 16384 || Number(match[2]) > 1048576) throw new OfficePreviewError("limit");
      maxColumn = Math.max(maxColumn, column);
    }
    for (const row of xmlFind(document, "row")) {
      const number = Number(xmlAttr(row, "r"));
      if (!Number.isInteger(number) || number < 1 || number > 1048576) throw new OfficePreviewError("limit");
    }
    // Even one XFD1 source cell creates 16,384 Column objects in ExcelJS.
    // Bound the implicit column model across input sheets before loading.
    inputColumns += maxColumn;
    if (inputColumns > limits.inputColumns) throw new OfficePreviewError("limit");
  }
  // A tiny named range can make ExcelJS allocate an entire worksheet grid.
  // Named ranges and layout ranges are not needed to read saved cell values.
  files.set("xl/workbook.xml", new TextEncoder().encode(officeXmlWithoutNodes(source, new Set(["definedNames"]))));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(safeOfficeZip(files) as unknown as Parameters<typeof workbook.xlsx.load>[0], {
    ignoreNodes: ["cols", "mergeCells", "sheetProtection", "dataValidations", "conditionalFormatting", "drawing", "extLst", "picture", "legacyDrawing", "webPublishing"],
  });
  const sheets: OfficeWorksheet[] = [];
  let availableCells = limits.cells, textChars = 0, partial = workbook.worksheets.length > limits.sheets;
  for (const worksheet of workbook.worksheets.slice(0, limits.sheets)) {
    const rowCount = worksheet.rowCount, columnCount = worksheet.columnCount;
    const displayedColumns = Math.min(columnCount, limits.columns);
    const displayedRows = displayedColumns ? Math.min(rowCount, limits.rows, Math.floor(availableCells / displayedColumns)) : 0;
    const rows: string[][] = [];
    let shortened = false;
    for (let row = 1; row <= displayedRows; row++) {
      const values: string[] = [];
      for (let column = 1; column <= displayedColumns; column++) {
        const cell = worksheet.getRow(row).getCell(column), value = cellText(cell.value, cell.formula);
        if (value.length >= 10000) shortened = true;
        textChars += value.length;
        if (textChars > limits.textChars) throw new OfficePreviewError("limit");
        values.push(value);
      }
      rows.push(values);
    }
    availableCells -= displayedRows * displayedColumns;
    const truncated = shortened || displayedRows < rowCount || displayedColumns < columnCount;
    partial ||= truncated;
    sheets.push({ name: worksheet.name.slice(0, 200), rows, rowCount, columnCount, displayedColumns, truncated });
  }
  return { kind: "xlsx", sheets, warnings: partial ? ["partial"] : [] };
}

async function parseWord(files: Map<string, Uint8Array>): Promise<OfficePreviewData> {
  if (!files.has("word/document.xml")) throw new OfficePreviewError("invalid");
  const images = new Map<string, OfficeImage>(), collector = createOfficeImageCollector();
  const result = await mammoth.convertToHtml({ arrayBuffer: safeOfficeZip(files) }, {
    externalFileAccess: false, includeEmbeddedStyleMap: false, includeDefaultStyleMap: true, idPrefix: "office-content-",
    convertImage: mammoth.images.imgElement(async image => {
      try {
        const safe = collector.add(new Uint8Array(await image.readAsArrayBuffer()));
        if (safe) { const id = "office-image-" + images.size; images.set(id, safe); return { src: id }; }
      } catch { collector.add(new Uint8Array()); }
      return { src: "" };
    }),
  });
  return { kind: "docx", nodes: officeWordNodes(result.value, images), warnings: collector.omitted ? ["images"] : [] };
}

function slideParagraphs(nodes: OfficeXmlNode[], heading: boolean): OfficeSlideBlock[] {
  return xmlFind(nodes, "a:p").flatMap(paragraph => {
    const text = xmlText(xmlChildren(paragraph)).trim();
    if (!text) return [];
    const children = xmlChildren(paragraph), bullet = xmlFind(children, "a:buChar").length > 0 || xmlFind(children, "a:buAutoNum").length > 0;
    return [{ type: "paragraph" as const, text, heading, bullet }];
  });
}
function parsePresentation(files: Map<string, Uint8Array>, xml: Map<string, string>): OfficePreviewData {
  const source = xml.get("ppt/presentation.xml");
  if (!source) throw new OfficePreviewError("invalid");
  const relationships = officeRelationships(xml, "ppt/presentation.xml"), ids = xmlFind(parseOfficeXml(source), "p:sldId");
  const slides: OfficeSlide[] = [], collector = createOfficeImageCollector();
  let textChars = 0, outputNodes = 0, partial = ids.length > limits.slides;
  for (let index = 0; index < Math.min(ids.length, limits.slides); index++) {
    const relation = relationships.get(xmlAttr(ids[index], "r:id")), path = relation?.path;
    const source = path && xml.get(path);
    if (!path || !source || !relation?.type.endsWith("/slide")) throw new OfficePreviewError("invalid");
    const document = parseOfficeXml(source), slideRels = officeRelationships(xml, path), blocks: OfficeSlideBlock[] = [];
    const shapeTree = xmlFind(document, "p:spTree")[0];
    const visitShapes = (nodes: OfficeXmlNode[]) => {
      for (const shape of nodes) {
        const name = xmlName(shape), children = xmlChildren(shape);
        if (name === "p:grpSp") { visitShapes(children); continue; }
        if (name === "p:sp") {
          const placeholders = xmlFind(children, "p:ph"), heading = placeholders.some(node => ["title", "ctrTitle"].includes(xmlAttr(node, "type")));
          blocks.push(...slideParagraphs(children, heading));
        } else if (name === "p:pic") {
          const blip = xmlFind(children, "a:blip")[0], imageRelation = blip && slideRels.get(xmlAttr(blip, "r:embed"));
          const bytes = imageRelation?.path && files.get(imageRelation.path), metadata = xmlFind(children, "p:cNvPr")[0];
          const image = collector.add(bytes || new Uint8Array(), metadata ? xmlAttr(metadata, "descr") || xmlAttr(metadata, "name") : "");
          if (image) blocks.push({ type: "image", image });
        } else if (name === "p:graphicFrame") {
          const tables = xmlFind(children, "a:tbl");
          if (!tables.length) partial = true;
          for (const table of tables) {
            const allRows = xmlFind(xmlChildren(table), "a:tr");
            if (allRows.length > 50) partial = true;
            const rows = allRows.slice(0, 50).map(row => {
              const cells = xmlChildren(row).filter(node => xmlName(node) === "a:tc");
              if (cells.length > limits.columns) partial = true;
              return cells.slice(0, limits.columns).map(cell => xmlFind(xmlChildren(cell), "a:p").map(p => xmlText(xmlChildren(p))).join("\n"));
            });
            blocks.push({ type: "table", rows });
          }
        }
      }
    };
    if (shapeTree) visitShapes(xmlChildren(shapeTree));
    for (const block of blocks) {
      textChars += block.type === "paragraph" ? block.text.length : block.type === "table" ? block.rows.flat().reduce((sum, value) => sum + value.length, 0) : 0;
      outputNodes += block.type === "table" ? block.rows.reduce((sum, row) => sum + row.length, 0) : 1;
      if (textChars > limits.textChars || outputNodes > limits.outputNodes) throw new OfficePreviewError("limit");
    }
    slides.push({ number: index + 1, blocks });
  }
  return { kind: "pptx", slides, totalSlides: ids.length, warnings: [...(partial ? ["partial" as const] : []), ...(collector.omitted ? ["images" as const] : [])] };
}

// This module is imported only by the lazy worker (and synthetic tests). No
// Office bytes, text, or images leave the worker/page memory or enter storage.
export async function parseOfficePreviewBytes(bytes: Uint8Array, kind: OfficePreviewKind): Promise<OfficePreviewData> {
  try {
    if (!["docx", "xlsx", "pptx", "archive"].includes(kind)) throw new OfficePreviewError("unsupported");
    const archive = readBoundedOfficeArchive(bytes, kind !== "archive");
    if (kind === "archive") return { kind, entries: archive.entries, expandedSize: archive.expandedSize, warnings: [] };
    const xml = validateOfficeXmlFiles(archive.files);
    if (!xml.has("[Content_Types].xml")) throw new OfficePreviewError("invalid");
    if (kind === "docx") return await parseWord(archive.files);
    if (kind === "xlsx") return await parseWorkbook(archive.files, xml);
    return parsePresentation(archive.files, xml);
  } catch (error) {
    if (error instanceof OfficePreviewError) throw error;
    throw new OfficePreviewError("invalid");
  }
}
