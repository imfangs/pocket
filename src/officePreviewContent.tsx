import { createElement, useEffect, useMemo, useState, type ReactNode } from "react";
import { t, useLocale } from "./i18n";
import { safeOfficeImage } from "./officePreviewImages";
import { OFFICE_TEXT_TAGS, safeOfficeHref } from "./officePreviewPolicy";
import type { OfficeImage, OfficePreviewData, OfficeTextNode } from "./officePreviewTypes";
import "./officePreview.css";

function OfficePicture({ image }: { image: OfficeImage }) {
  const safe = useMemo(() => safeOfficeImage(image), [image]);
  return safe ? <img className="office-preview-image" src={image.src} alt={image.alt} width={image.width} height={image.height} loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : null;
}
function officeNode(node: OfficeTextNode, key: number): ReactNode {
  if (node.type === "text") return node.text;
  if (node.type === "image") return <OfficePicture key={key} image={node.image} />;
  if (node.type !== "element" || !OFFICE_TEXT_TAGS.has(node.tag)) return null;
  const children = node.children.map(officeNode), props: Record<string, unknown> = { key };
  if (node.tag === "a") {
    const href = safeOfficeHref(node.href || "");
    if (!href) return <span key={key}>{children}</span>;
    props.href = href; props.target = "_blank"; props.rel = "noopener noreferrer";
  }
  if ((node.tag === "td" || node.tag === "th") && Number.isInteger(node.span) && node.span! > 1 && node.span! <= 50) props.colSpan = node.span;
  const element = createElement(node.tag, props, node.tag === "br" ? undefined : children);
  return node.tag === "table" ? <div className="office-preview-table" key={key} tabIndex={0} role="region" aria-label={t("表格，可横向滚动")}>{element}</div> : element;
}
const columnName = (index: number) => index < 26 ? String.fromCharCode(65 + index) : "A" + String.fromCharCode(65 + index - 26);
function OfficeWorkbook({ data }: { data: Extract<OfficePreviewData, { kind: "xlsx" }> }) {
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [data]);
  const sheet = data.sheets[Math.min(selected, data.sheets.length - 1)];
  return <>
    <p className="office-preview-note">{t("展示文件中保存的单元格结果。")}</p>
    {data.sheets.length > 0 && <div className="office-preview-sheets" role="group" aria-label={t("工作表")}>
      {data.sheets.map((sheet, index) => <button type="button" key={index} aria-pressed={selected === index} onClick={() => setSelected(index)}>{sheet.name}</button>)}
    </div>}
    {sheet && <p className="office-preview-dimensions">{t("{{rows}} 行 · {{columns}} 列", { rows: sheet.rowCount, columns: sheet.columnCount })}</p>}
    {sheet?.rows.length && sheet.displayedColumns ? <div className="office-preview-table office-preview-workbook" tabIndex={0} role="region" aria-label={t("工作表：{{name}}", { name: sheet.name })}>
      <table><thead><tr><th aria-label={t("行号")} />{Array.from({ length: sheet.displayedColumns }, (_, index) => <th scope="col" key={index}>{columnName(index)}</th>)}</tr></thead>
        <tbody>{sheet.rows.map((row, index) => <tr key={index}><th scope="row">{index + 1}</th>{row.map((value, column) => <td key={column}>{value}</td>)}</tr>)}</tbody>
      </table>
    </div> : <p className="office-preview-empty">{t(sheet && sheet.rowCount > 0 && sheet.columnCount > 0 ? "已显示部分内容，下载原文件可查看完整内容。" : "空工作表")}</p>}
  </>;
}
function OfficePresentation({ data }: { data: Extract<OfficePreviewData, { kind: "pptx" }> }) {
  return <>
    <p className="office-preview-note">{t("以内容预览展示，排版可能与 PowerPoint 不同。")}</p>
    {data.slides.length ? <div className="office-preview-slides">{data.slides.map(slide => <article className="office-preview-slide" key={slide.number}>
      <div className="office-preview-slide-number">{t("幻灯片 {{number}}", { number: slide.number })}</div>
      {slide.blocks.length ? slide.blocks.map((block, index) => block.type === "image" ? <OfficePicture key={index} image={block.image} />
        : block.type === "table" ? <div className="office-preview-table" key={index} tabIndex={0} role="region" aria-label={t("表格，可横向滚动")}><table><tbody>
          {block.rows.map((row, index) => <tr key={index}>{row.map((value, index) => <td key={index}>{value}</td>)}</tr>)}</tbody></table></div>
          : block.heading ? <h3 key={index}>{block.text}</h3> : <p className={block.bullet ? "office-preview-bullet" : ""} key={index}>{block.text}</p>)
        : <p className="office-preview-empty">{t("此页没有可显示的内容。")}</p>}
    </article>)}</div> : <p className="office-preview-empty">{t("没有可显示的内容。")}</p>}
  </>;
}
function OfficeArchive({ data }: { data: Extract<OfficePreviewData, { kind: "archive" }> }) {
  const locale = useLocale(), size = (bytes: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes < 1024 ? bytes : bytes / 1024) + (bytes < 1024 ? " B" : " KiB");
  return <>
    <p className="office-preview-note">{t("压缩包文件列表")}</p>
    {data.entries.length ? <div className="office-preview-table office-preview-archive" tabIndex={0} role="region" aria-label={t("压缩包文件列表")}>
      <table><thead><tr><th scope="col">{t("名称")}</th><th scope="col">{t("大小")}</th></tr></thead><tbody>
        {data.entries.map((entry, index) => <tr key={index}><td>{entry.directory ? <span className="office-preview-folder">{t("文件夹")} · </span> : null}{entry.name}</td><td>{entry.directory ? "—" : size(entry.size)}</td></tr>)}
      </tbody></table>
    </div> : <p className="office-preview-empty">{t("空压缩包")}</p>}
  </>;
}
export function OfficeFileContent({ data }: { data: OfficePreviewData }) {
  useLocale();
  return <div className={`office-preview-content office-preview-${data.kind} ph-no-capture ph-mask`}>
    {data.warnings.includes("partial") && <p className="office-preview-note">{t("已显示部分内容，下载原文件可查看完整内容。")}</p>}
    {data.warnings.includes("images") && <p className="office-preview-note">{t("部分图片未能载入，原文件仍可下载。")}</p>}
    {data.kind === "docx" ? data.nodes.length ? <div className="office-preview-document">{data.nodes.map(officeNode)}</div> : <p className="office-preview-empty">{t("没有可显示的内容。")}</p>
      : data.kind === "xlsx" ? <OfficeWorkbook data={data} /> : data.kind === "pptx" ? <OfficePresentation data={data} /> : <OfficeArchive data={data} />}
  </div>;
}
export default OfficeFileContent;
