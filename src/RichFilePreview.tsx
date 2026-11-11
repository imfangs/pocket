import { Component, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Download, X } from "lucide-react";
import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import type { MessageFileReference } from "./conversationFeed";
import { machineApiPath, type MachineId } from "./machineScope";
import { richFilePreviewBytes, type RichFilePreviewKind } from "./filePreviewKind";
import { parseOfficePreview, OfficePreviewError, type OfficePreviewData } from "./officePreview";
import OfficeFileContent from "./officePreviewContent";
import "./rich-file-preview.css";

class ContentBoundary extends Component<{ children: ReactNode; retry: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="text-file-state"><p role="alert">{t("文件预览加载失败，可重试或下载原文件。")}</p>
      <button type="button" onClick={this.props.retry}>{t("重试")}</button></div> : this.props.children;
  }
}
type Reader = (file: MessageFileReference, threadId: string, options: { machine: MachineId; signal: AbortSignal; maxBytes: number }) => Promise<Blob>;
const parsingError = (failure: unknown) => failure instanceof OfficePreviewError
  ? failure.code === "limit" ? "文档较大，请下载后查看。" : failure.code === "timeout" ? "文档解析较慢，请重试或下载原文件。" : "文件内容无法解析，请下载后查看。"
  : failure instanceof Error && /[\u3400-\u9fff]/.test(failure.message) ? failure.message : "读取未完成，请检查连接后重试。";

export default function RichFilePreview({ file, threadId, kind, machine, opener, onClose, readFile, download, downloading, downloadError }: {
  file: MessageFileReference; threadId: string; kind: RichFilePreviewKind; machine: MachineId; opener: HTMLElement; onClose: () => void;
  readFile: Reader; download: (blob?: Blob) => void; downloading: boolean; downloadError: string;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null), title = useRef<HTMLHeadingElement>(null), audio = useRef<HTMLAudioElement>(null);
  const [result, setResult] = useState<{ blob: Blob; office?: OfficePreviewData } | null>(null), [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0), [parsing, setParsing] = useState(false);
  const [contentAttempt, setContentAttempt] = useState(0);
  const PdfFileContent = useMemo(() => lazy(() => import("./PdfFileContent")), [contentAttempt]);
  const SvgFileContent = useMemo(() => lazy(() => import("./SvgFileContent")), [contentAttempt]);
  const mounted = useRef(false), generation = useRef(0);
  const visibility = () => window.dispatchEvent(new Event("pocket-reading-visibility-change"));
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const turn = ++generation.current; mounted.current = true;
    const body = document.body, html = document.documentElement;
    const previous = { body: body.style.overflow, html: html.style.overflow };
    body.style.overflow = html.style.overflow = "hidden";
    if (!element.open) element.showModal();
    title.current?.focus({ preventScroll: true }); visibility();
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
    const media = audio.current;
    return () => { if (media) { media.pause(); media.removeAttribute("src"); media.load(); } };
  }, [file.url, kind, attempt]);
  useEffect(() => {
    if (kind === "audio") return;
    const controller = new AbortController(); let current = true;
    setResult(null); setError(""); setParsing(false);
    const timeout = window.setTimeout(() => controller.abort(new DOMException("读取超时", "TimeoutError")), 30000);
    void readFile(file, threadId, { machine, signal: controller.signal, maxBytes: richFilePreviewBytes(kind) })
      .then(async blob => {
        controller.signal.throwIfAborted();
        if (!current) throw new DOMException("Cancelled", "AbortError");
        if (kind === "docx" || kind === "xlsx" || kind === "pptx" || kind === "archive") {
          setParsing(true);
          const office = await parseOfficePreview(blob, kind, controller.signal);
          return { blob, office };
        }
        return { blob };
      }).then(value => { controller.signal.throwIfAborted(); if (current) { setResult(value); setParsing(false); } })
      .catch(failure => { if (current) { setParsing(false); setError(controller.signal.reason?.name === "TimeoutError" ? "读取较慢，请重试。" : parsingError(failure)); } })
      .finally(() => window.clearTimeout(timeout));
    return () => { current = false; controller.abort(); window.clearTimeout(timeout); };
  }, [file.url, file.name, threadId, machine, kind, attempt, readFile]);
  if (typeof document === "undefined") return null;
  return createPortal(<dialog ref={dialog} className="text-file-viewer" data-rich-file-preview={kind} data-reading-overlay=""
    aria-label={t("预览文件：{{value0}}", { value0: file.name })} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="text-file-toolbar">
      <h2 ref={title} tabIndex={-1} title={file.name} style={{ outline: "none" }}>{file.name}</h2>
      <button type="button" disabled={downloading} aria-busy={downloading || undefined}
        aria-label={t("{{action}}：{{name}}", { action: downloading ? t("正在下载") : t("下载文件"), name: file.name })} onClick={() => download(result?.blob)}>
        <AppIcon icon={Download} kind="action" aria-hidden="true" /><span>{downloading ? t("下载中…") : t("下载")}</span>
      </button>
      <button type="button" className="text-file-close" aria-label={t("关闭文件预览")} onClick={onClose}><AppIcon icon={X} kind="action" aria-hidden="true" /><span>{t("关闭")}</span></button>
    </header>
    {downloadError && <p className="text-file-download-error" role="alert">{t(downloadError)}</p>}
    <div className="text-file-scroll rich-file-content ph-no-capture ph-mask" tabIndex={0} role="region" aria-label={t("文件内容")}>
      {kind === "audio" ? <div className="audio-file-content">
        <audio ref={audio} key={attempt} controls preload="metadata" src={machineApiPath(file.url + "/audio", machine)}
          onLoadedMetadata={event => { if (mounted.current && event.currentTarget === audio.current) setError(""); }}
          onError={event => { if (mounted.current && event.currentTarget === audio.current) setError("音频暂时无法播放，请重试或下载原文件。"); }} />
        {error && <div className="text-file-state"><p role="alert">{t(error)}</p><button type="button" onClick={() => { setError(""); setAttempt(value => value + 1); }}>{t("重试")}</button></div>}
      </div> : result ? <ContentBoundary key={contentAttempt} retry={() => setContentAttempt(value => value + 1)}>
        {result.office ? <OfficeFileContent data={result.office} /> : <Suspense fallback={<div className="text-file-state"><p role="status">{t("正在读取文件…")}</p></div>}>
          {kind === "pdf" ? <PdfFileContent blob={result.blob} /> : <SvgFileContent blob={result.blob} />}
        </Suspense>}
      </ContentBoundary> : error ? <div className="text-file-state"><p role="alert">{t(error)}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>{t("重试")}</button></div>
        : <div className="text-file-state"><p role="status">{t(parsing ? "正在解析文件…" : "正在读取文件…")}</p></div>}
    </div>
  </dialog>, document.body);
}
