import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import { Code2, Download, Eye, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MessageFileReference } from "./conversationFeed";
import { decodeMessageFileText, maxTextFilePreviewBytes, messageFileTextFormat } from "./messageFileText";
import type { MachineId } from "./machineScope";
import type { HtmlFileData } from "./htmlPreviewPayload";
import HtmlFileContent from "./HtmlFileContent";

type Reader = (file: MessageFileReference, threadId: string, options: { machine: MachineId; signal: AbortSignal; maxBytes: number }) => Promise<Blob>;
type HtmlReader = (file: MessageFileReference, threadId: string, options: { machine: MachineId; signal: AbortSignal }) => Promise<HtmlFileData>;
const plugins = [remarkGfm];
const components: Components = {
  a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
  img: ({ alt }) => <span className="markdown-image-reference">{alt || t("图片")}</span>,
  table: ({ children }) => <div className="markdown-table" tabIndex={0} role="region" aria-label={t("表格，可横向滚动")}><table>{children}</table></div>,
};
const safeLink = (value: string, key: string) => {
  if (key !== "href") return "";
  try {
    const url = new URL(value);
    // File contents never inherit the conversation's private file capabilities.
    if (/^\/api\/(?:machines\/[^/]+\/)?tasks\//i.test(decodeURIComponent(url.pathname))) return "";
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? value : "";
  } catch { return ""; }
};

export function TextFileContent({ name, text }: { name: string; text: string }) {
  useLocale();
  return text ? messageFileTextFormat(name) === "markdown"
    ? <div className="message-text message-markdown"><Markdown remarkPlugins={plugins} components={components} urlTransform={safeLink} skipHtml>{text}</Markdown></div>
    : <pre className="text-file-plain">{text}</pre>
    : <p className="text-file-empty">{t("空文件")}</p>;
}

export default function TextFilePreview({ file, threadId, machine, opener, onClose, readFile, readHtmlPreview, download, downloading, downloadError }: {
  file: MessageFileReference; threadId: string; machine: MachineId; opener: HTMLElement; onClose: () => void;
  readFile: Reader; readHtmlPreview: HtmlReader; download: (blob?: Blob) => void; downloading: boolean; downloadError: string;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null), title = useRef<HTMLHeadingElement>(null);
  const [result, setResult] = useState<({ text: string } & HtmlFileData) | null>(null), [error, setError] = useState("");
  const htmlFile = messageFileTextFormat(file.name) === "html";
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const contentId = useId();
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(false), generation = useRef(0);
  const visibility = () => window.dispatchEvent(new Event("pocket-reading-visibility-change"));
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const turn = ++generation.current;
    mounted.current = true;
    const body = document.body, html = document.documentElement;
    const previous = { body: body.style.overflow, html: html.style.overflow };
    body.style.overflow = html.style.overflow = "hidden";
    if (!element.open) element.showModal();
    title.current?.focus({ preventScroll: true });
    visibility();
    return () => {
      mounted.current = false;
      if (element.open) element.close();
      body.style.overflow = previous.body; html.style.overflow = previous.html;
      queueMicrotask(() => {
        if (mounted.current || generation.current !== turn) return;
        visibility();
        const other = document.querySelector("dialog[open]");
        if (opener.isConnected && !opener.closest("[inert]") && (!other || other.contains(opener))) opener.focus({ preventScroll: true });
      });
    };
  }, [opener]);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setResult(null); setError("");
    const timeout = window.setTimeout(() => controller.abort(new DOMException("读取超时", "TimeoutError")), 30000);
    const read = htmlFile ? readHtmlPreview(file, threadId, { machine, signal: controller.signal })
      : readFile(file, threadId, { machine, signal: controller.signal, maxBytes: maxTextFilePreviewBytes })
        .then(blob => ({ blob, images: Object.create(null) as Record<string, string>, omittedImages: 0, imagesAvailable: true }));
    void read.then(async value => ({ ...value, text: await decodeMessageFileText(value.blob) }))
      .then(value => { controller.signal.throwIfAborted(); if (current) setResult(value); })
      .catch(failure => {
        if (current) setError(controller.signal.reason?.name === "TimeoutError" ? "读取较慢，请重试。"
          : failure instanceof Error && /[\u3400-\u9fff]/.test(failure.message) ? failure.message : "读取未完成，请检查连接后重试。");
      })
      .finally(() => window.clearTimeout(timeout));
    return () => { current = false; controller.abort(); window.clearTimeout(timeout); };
  }, [file.url, file.name, threadId, machine, attempt, readFile, readHtmlPreview, htmlFile]);
  if (typeof document === "undefined") return null;
  return createPortal(<dialog ref={dialog} className="text-file-viewer" data-reading-overlay="" aria-label={t("预览文件：{{value0}}", { value0: file.name })}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="text-file-toolbar">
      <h2 ref={title} tabIndex={-1} title={file.name} style={{ outline: "none" }}>{file.name}</h2>
      <button type="button" disabled={downloading} aria-busy={downloading || undefined} aria-label={t("{{action}}：{{name}}", { action: downloading ? t("正在下载") : t("下载文件"), name: file.name })} onClick={() => download(result?.blob)}>
        <AppIcon icon={Download} kind="action" aria-hidden="true" /><span>{downloading ? t("下载中…") : t("下载")}</span>
      </button>
      <button type="button" className="text-file-close" aria-label={t("关闭文件预览")} title={t("关闭文件预览")} onClick={onClose}><AppIcon icon={X} kind="action" aria-hidden="true" /><span>{t("关闭")}</span></button>
    </header>
    {htmlFile && <div className="html-file-modes" role="group" aria-label={t("文件显示方式")}>
      <button type="button" aria-pressed={mode === "preview"} aria-controls={contentId} onClick={() => setMode("preview")}>
        <AppIcon icon={Eye} kind="auxiliary" />{t("预览")}</button>
      <button type="button" aria-pressed={mode === "source"} aria-controls={contentId} onClick={() => setMode("source")}>
        <AppIcon icon={Code2} kind="auxiliary" />{t("源码")}</button>
      <small title={t("脚本和外部资源不会在预览中运行。")}>{t("静态预览")}</small>
    </div>}
    {downloadError && <p className="text-file-download-error" role="alert">{t(downloadError)}</p>}
    {htmlFile && result && mode === "preview" && (!result.imagesAvailable || result.omittedImages > 0) &&
      <p className="html-file-note">{t("部分图片未能载入，原文件仍可下载。")}</p>}
    <div id={contentId} className={`text-file-scroll ph-no-capture ph-mask ${htmlFile ? "html-file-content" : ""}`}
      tabIndex={htmlFile ? -1 : 0} role="region" aria-label={t("文件内容")}>
      {result ? htmlFile && result.text ? <>
          <HtmlFileContent name={file.name} source={result.text} images={result.images} hidden={mode !== "preview"} />
          <div className="html-file-source" hidden={mode !== "source"} tabIndex={mode === "source" ? 0 : -1}
            role="region" aria-label={t("HTML 源码")}><TextFileContent name={file.name} text={result.text} /></div>
        </> : <TextFileContent name={file.name} text={result.text} />
        : error ? <div className="text-file-state"><p role="alert">{t(error)}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>{t("重试")}</button></div>
        : <div className="text-file-state"><p role="status">{t("正在读取文件…")}</p></div>}
    </div>
  </dialog>, document.body);
}
