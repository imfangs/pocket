import { t, useLocale } from "./i18n";
import { Download, FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isMessageVideo } from "../shared/message-media.mjs";
import type { MessageFileReference } from "./conversationFeed";
import { checkMachineResponse, currentMachineId, machineApiPath, requireMachine, type MachineId } from "./machineScope";
import TextFilePreview from "./TextFilePreview";
import { messageFileTextFormat, textFileTooLarge } from "./messageFileText";
import { safeMessageFile } from "./messageFileReference";
import MessageVideo from "./MessageVideo";
import { clientVersionHeaders } from "./clientVersion";
import "./message-file.css";

export { safeMessageFile, registeredMessageFile } from "./messageFileReference";
export const maxMessageFileBytes = 20 * 1024 * 1024;
const tooLarge = "文件超过20 MiB，请在电脑上查看。";

export async function fetchMessageFile(file: MessageFileReference, threadId: string, options: {
  machine?: MachineId | null; signal?: AbortSignal; request?: typeof fetch; maxBytes?: number;
} = {}) {
  const registered = safeMessageFile(file, threadId);
  if (!registered) throw new Error("文件保存在电脑上");
  const machine = requireMachine(options.machine ?? currentMachineId());
  const limit = Number.isSafeInteger(options.maxBytes) && options.maxBytes! > 0
    ? Math.min(options.maxBytes!, maxMessageFileBytes) : maxMessageFileBytes;
  const sizeError = limit < maxMessageFileBytes ? textFileTooLarge : tooLarge;
  const response = await (options.request ?? fetch)(machineApiPath(registered.url, machine), {
    method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: options.signal,
    headers: clientVersionHeaders(),
  });
  checkMachineResponse(response, machine);
  if (!response.ok) {
    if (response.status === 401) throw new Error("登录已过期，请重新登录后重试。");
    if (response.status === 404 || response.status === 410) throw new Error("文件已移动或无法读取，请在电脑上查看。");
    if (response.status === 409) throw new Error("文件已更新，请刷新会话后重试。");
    if (response.status === 413) throw new Error(tooLarge);
    throw new Error("文件读取未完成，请稍后重试。");
  }
  const length = response.headers.get("Content-Length");
  if (length && /^\d+$/.test(length) && Number(length) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error(sizeError);
  }
  if (!response.body) {
    const blob = await response.blob();
    options.signal?.throwIfAborted();
    if (blob.size > limit) throw new Error(sizeError);
    return blob;
  }
  const reader = response.body.getReader(), chunks: BlobPart[] = [];
  let bytes = 0;
  try {
    while (true) {
      options.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      options.signal?.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error(sizeError);
      chunks.push(value.slice());
    }
    return new Blob(chunks, { type: response.headers.get("Content-Type") || "application/octet-stream" });
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export function saveMessageFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url; link.download = name; link.rel = "noopener"; link.hidden = true;
    document.body.append(link);
    try { link.click(); } finally { link.remove(); }
  } finally {
    // Keep the object alive while the browser takes ownership of its download.
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

export default function MessageFile({ file, threadId, label }: { file: MessageFileReference; threadId: string; label?: string }) {
  useLocale();
  const registered = safeMessageFile(file, threadId);
  if (!registered) return <span className="message-file-fallback">{file.name}<small>{t("文件保存在电脑上")}</small></span>;
  return isMessageVideo(registered.name) ? <MessageVideo file={registered} threadId={threadId} label={label} />
    : <MessageDocument file={registered} threadId={threadId} />;
}

function MessageDocument({ file, threadId }: { file: MessageFileReference; threadId: string }) {
  useLocale();
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [preview, setPreview] = useState<{ opener: HTMLElement; machine: MachineId } | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    setPending(false); setError(""); setPreview(null);
    return () => { active.current?.abort(); active.current = null; };
  }, [file.url, threadId]);
  const registered = file;
  const textPreview = messageFileTextFormat(registered.name) !== null;
  const download = async (previewBlob?: Blob) => {
    if (active.current) return;
    // Save precisely the already-validated bytes the user is reading. This
    // snapshot belongs only to the open preview, never a persistent cache.
    if (previewBlob) { setError(""); saveMessageFile(previewBlob, registered.name); return; }
    const controller = new AbortController(); active.current = controller;
    setPending(true); setError("");
    const timeout = window.setTimeout(() => controller.abort(new DOMException("下载超时", "TimeoutError")), 60000);
    try {
      const blob = await fetchMessageFile(registered, threadId, { machine: preview?.machine, signal: controller.signal });
      if (active.current === controller) saveMessageFile(blob, registered.name);
    } catch (failure) {
      if (active.current === controller) setError(controller.signal.reason?.name === "TimeoutError"
        ? "下载较慢，请稍后重试。" : failure instanceof Error && /[\u3400-\u9fff]/.test(failure.message)
          ? failure.message : "下载未完成，请检查连接后重试。");
    } finally {
      window.clearTimeout(timeout);
      if (active.current === controller) { active.current = null; setPending(false); }
    }
  };
  return <span className="message-file">
    <button type="button" className="message-file-button" disabled={!textPreview && pending} aria-busy={!textPreview && pending || undefined}
      aria-label={t("{{action}}：{{name}}", { action: textPreview ? t("预览文件") : pending ? t("正在下载") : t("下载文件"), name: registered.name })} onClick={event => {
        if (textPreview) {
          try { setPreview({ opener: event.currentTarget, machine: requireMachine() }); } catch { setError("请选择电脑后继续。"); }
        } else void download();
      }}>
      <FileText size={19} aria-hidden="true" />
      <span className="message-file-name">{registered.name}</span>
      <span className="message-file-action">{textPreview ? t("查看") : pending ? t("下载中…") : t("下载")}</span>
      {!textPreview && <Download size={15} aria-hidden="true" />}
    </button>
    {error && <span className="message-file-error" role="alert">{t(error)}</span>}
    {preview && <TextFilePreview key={`${preview.machine}/${threadId}/${registered.url}/${registered.name}`} file={registered} threadId={threadId} machine={preview.machine} opener={preview.opener}
      onClose={() => setPreview(null)} readFile={fetchMessageFile} download={blob => void download(blob)} downloading={pending} downloadError={error} />}
  </span>;
}
