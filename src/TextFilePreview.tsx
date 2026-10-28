import { Download, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MessageFileReference } from "./conversationFeed";
import { decodeMessageFileText, maxTextFilePreviewBytes, messageFileTextFormat } from "./messageFileText";
import type { MachineId } from "./machineScope";

type Reader = (file: MessageFileReference, threadId: string, options: { machine: MachineId; signal: AbortSignal; maxBytes: number }) => Promise<Blob>;
const plugins = [remarkGfm];
const components: Components = {
  a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
  img: ({ alt }) => <span className="markdown-image-reference">{alt || "图片"}</span>,
  table: ({ children }) => <div className="markdown-table" tabIndex={0} role="region" aria-label="表格，可横向滚动"><table>{children}</table></div>,
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
  return text ? messageFileTextFormat(name) === "markdown"
    ? <div className="message-text message-markdown"><Markdown remarkPlugins={plugins} components={components} urlTransform={safeLink} skipHtml>{text}</Markdown></div>
    : <pre className="text-file-plain">{text}</pre>
    : <p className="text-file-empty">空文件</p>;
}

export default function TextFilePreview({ file, threadId, machine, opener, onClose, readFile, download, downloading, downloadError }: {
  file: MessageFileReference; threadId: string; machine: MachineId; opener: HTMLElement; onClose: () => void;
  readFile: Reader; download: (blob?: Blob) => void; downloading: boolean; downloadError: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const [result, setResult] = useState<{ text: string; blob: Blob } | null>(null), [error, setError] = useState("");
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
    closeButton.current?.focus({ preventScroll: true });
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
    void readFile(file, threadId, { machine, signal: controller.signal, maxBytes: maxTextFilePreviewBytes })
      .then(async blob => ({ text: await decodeMessageFileText(blob), blob }))
      .then(value => { controller.signal.throwIfAborted(); if (current) setResult(value); })
      .catch(failure => {
        if (current) setError(controller.signal.reason?.name === "TimeoutError" ? "读取较慢，请重试。"
          : failure instanceof Error && /[\u3400-\u9fff]/.test(failure.message) ? failure.message : "读取未完成，请检查连接后重试。");
      })
      .finally(() => window.clearTimeout(timeout));
    return () => { current = false; controller.abort(); window.clearTimeout(timeout); };
  }, [file.url, file.name, threadId, machine, attempt, readFile]);
  if (typeof document === "undefined") return null;
  return createPortal(<dialog ref={dialog} className="text-file-viewer" data-reading-overlay="" aria-label={`预览文件：${file.name}`}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="text-file-toolbar">
      <h2>{file.name}</h2>
      <button type="button" disabled={downloading} aria-busy={downloading || undefined} aria-label={`${downloading ? "正在下载" : "下载文件"}：${file.name}`} onClick={() => download(result?.blob)}>
        <Download size={18} aria-hidden="true" /><span>{downloading ? "下载中…" : "下载"}</span>
      </button>
      <button ref={closeButton} type="button" className="text-file-close" aria-label="关闭文件预览" onClick={onClose}><X size={18} aria-hidden="true" /><span>关闭</span></button>
    </header>
    {downloadError && <p className="text-file-download-error" role="alert">{downloadError}</p>}
    <div className="text-file-scroll ph-no-capture ph-mask" tabIndex={0} role="region" aria-label="文件内容">
      {result ? <TextFileContent name={file.name} text={result.text} />
        : error ? <div className="text-file-state"><p role="alert">{error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></div>
        : <div className="text-file-state"><p role="status">正在读取文件…</p></div>}
    </div>
  </dialog>, document.body);
}
