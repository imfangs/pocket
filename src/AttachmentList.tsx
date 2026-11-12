import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import { FileText, Image as ImageIcon, Paperclip, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { attachmentSize, canRemoveLocalAttachment, safeAttachmentUrl, MAX_ATTACHMENTS, type AttachmentDraftController, type DraftAttachment, type PublicAttachment } from "./attachments";
import "./attachments.css";
import { machineApiPath } from "./machineScope";
import { ImagePreviewGroup, useImagePreview, useImagePreviewRegistration } from "./ImagePreviewProvider";
import { readableRequestError } from "./requestError";
import { useImageReadProof, useImageReadUrl } from "./imageReadCacheReact";

function Preview({ attachment, image }: { attachment?: PublicAttachment; image: boolean }) {
  useLocale();
  const url = attachment && safeAttachmentUrl(attachment.previewUrl ?? attachment.url);
  const preview = url?.endsWith("?preview=1");
  useImageReadProof({ src: image && attachment ? safeAttachmentUrl(attachment.url) : "", sha256: attachment?.sha256,
    mime: attachment?.mime, size: attachment?.size, variant: "original" });
  const cached = useImageReadUrl({ src: image && url ? url : "", sha256: preview ? attachment?.previewSha256 : attachment?.sha256,
    mime: preview ? attachment?.previewMime : attachment?.mime, size: preview ? attachment?.previewSize : attachment?.size,
    variant: preview ? "preview" : "original" }, { lazy: true });
  return <span ref={cached.ref} className={image && cached.url ? "attachment-preview" : "attachment-placeholder"} aria-hidden="true">
    {image && cached.url ? <img className="attachment-preview" src={cached.url} data-registered-source={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
      : image ? <AppIcon icon={ImageIcon} kind="auxiliary" /> : <AppIcon icon={FileText} kind="auxiliary" />}
  </span>;
}

function ImageAttachment({ attachment, url, children }: { attachment: PublicAttachment; url: string; children: ReactNode }) {
  const openImage = useImagePreview();
  const imageButton = useImagePreviewRegistration(url, attachment.name);
  return <button ref={imageButton} type="button" className="attachment-card" data-attachment-id={attachment.id}
    aria-haspopup="dialog" aria-label={t("查看大图：{{value0}}", { value0: attachment.name })}
    onClick={event => openImage(url, attachment.name, event.currentTarget)}>{children}</button>;
}

function AttachmentCards({ attachments }: { attachments: readonly PublicAttachment[] }) {
  useLocale();
  return <div className="attachment-list" aria-label={t("消息附件")}>
    {attachments.map(attachment => {
      const url = safeAttachmentUrl(attachment.url);
      const contents = <><Preview attachment={attachment} image={attachment.kind === "image"} /><span className="attachment-details">
        <span className="attachment-name" title={attachment.name}>{attachment.name}</span><small>{attachmentSize(attachment.size)}</small></span></>;
      return url && attachment.kind === "image" ? <ImageAttachment key={attachment.id} attachment={attachment} url={url}>{contents}</ImageAttachment>
        : url ? <a className="attachment-card" key={attachment.id} data-attachment-id={attachment.id} href={machineApiPath(url)} target="_blank" rel="noopener noreferrer"
        {...(attachment.kind === "file" ? { download: attachment.name } : {})} aria-label={t("查看附件 {{value0}}", { value0: attachment.name })}>{contents}</a>
        : <div className="attachment-card" key={attachment.id} data-attachment-id={attachment.id}>{contents}</div>;
    })}
  </div>;
}

export default function AttachmentList({ attachments = [] }: { attachments?: readonly PublicAttachment[] }) {
  if (!attachments.length) return null;
  return <ImagePreviewGroup fallback><AttachmentCards attachments={attachments} /></ImagePreviewGroup>;
}

const labels: Record<DraftAttachment["status"], string> = { queued: "等待上传", uploading: "上传中…", uploaded: "已上传", failed: "上传未完成", unknown: "结果待核对", removing: "正在移除…" };
export function DraftAttachmentList({ threadId, items, controller, disabled, localRemovalAllowed = false, error, onRecover }: {
  threadId: string; items: readonly DraftAttachment[]; controller: AttachmentDraftController; disabled: boolean; localRemovalAllowed?: boolean; error?: string; onRecover?: () => void;
}) {
  useLocale();
  if (!items.length && !error) return null;
  return <section className="draft-attachments" aria-label={t("待发送附件")}>
    {items.map(item => <div className="attachment-card attachment-draft" key={item.id} data-attachment-id={item.id} data-upload-status={item.status}
      aria-busy={item.status === "uploading" || item.status === "removing" || item.checking || undefined}>
      <Preview attachment={item.attachment} image={item.attachment?.kind === "image" || item.kind === "image"} />
      <span className="attachment-details"><span className="attachment-name" title={item.name}>{item.name}</span>
        <small role="status">{item.checking ? t("正在核对…") : t(labels[item.status])} · {attachmentSize(item.size)}</small>
        {item.error && <small className="attachment-error" role="alert">{t(readableRequestError(item.error, "附件处理未完成，请重试。"))}</small>}
      </span>
      <div className="attachment-controls">
        {item.status === "failed" && <button type="button" disabled={disabled} aria-label={t("重试上传 {{value0}}", { value0: item.name })} onClick={() => controller.retry(threadId, item.id)}><AppIcon icon={RefreshCw} kind="action" /></button>}
        {item.status === "unknown" && <button type="button" disabled={disabled || item.checking} aria-label={t("核对附件 {{value0}}", { value0: item.name })} onClick={() => void controller.check(threadId, item.id)}>{t("核对")}</button>}
        <button type="button" disabled={disabled && !(localRemovalAllowed && canRemoveLocalAttachment(item)) || item.status === "removing" || item.checking} aria-label={t("移除附件 {{value0}}", { value0: item.name })} onClick={() => void controller.remove(threadId, item.id)}><AppIcon icon={X} kind="action" /></button>
      </div>
    </div>)}
    {(error || items.length > MAX_ATTACHMENTS) && <p className="attachment-error" role="alert">{error ? t(readableRequestError(error, "附件暂未同步，请重试。")) : t("每条消息最多{{count}}个附件，请移除多余附件。", { count: MAX_ATTACHMENTS })}</p>}
    {onRecover && <button type="button" className="text-button" disabled={disabled} onClick={onRecover}>{t("载入已上传附件")}</button>}
  </section>;
}

export function AttachmentPicker({ disabled, onFiles, onPickingChange, preserveFocus = false }: { disabled: boolean; onFiles: (files: File[]) => void; onPickingChange?: (picking: boolean) => void; preserveFocus?: boolean }) {
  useLocale();
  const input = useRef<HTMLInputElement>(null);
  const picking = useRef(false), returnTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const finish = () => { clearTimeout(returnTimer.current); picking.current = false; onPickingChange?.(false); };
  useEffect(() => {
    if (!onPickingChange) return;
    const field = input.current;
    const cancel = () => { clearTimeout(returnTimer.current); picking.current = false; onPickingChange?.(false); };
    const returned = () => {
      if (picking.current && document.visibilityState !== "hidden") {
        clearTimeout(returnTimer.current); returnTimer.current = setTimeout(cancel, 300);
      }
    };
    field?.addEventListener("cancel", cancel);
    window.addEventListener("focus", returned); document.addEventListener("visibilitychange", returned);
    return () => {
      clearTimeout(returnTimer.current); field?.removeEventListener("cancel", cancel);
      window.removeEventListener("focus", returned); document.removeEventListener("visibilitychange", returned);
    };
  }, [onPickingChange]);
  return <>
    <button type="button" className="attachment-picker icon-button" aria-label={t("添加附件")} title={t("添加图片或文件")} disabled={disabled}
      onPointerDown={event => {
        // Keep the pressed target stationary until click opens the native picker.
        // Keyboard focus still works, and an existing editor selection survives.
        // Cancelling a touch pointerdown suppresses the subsequent click in
        // WebKit. Touch keeps its native click; deferred focusout preserves layout.
        if (preserveFocus && event.pointerType !== "touch") event.preventDefault();
      }} onClick={() => {
      picking.current = true; onPickingChange?.(true);
      try { input.current?.click(); } catch (error) { finish(); throw error; }
    }}><AppIcon icon={Paperclip} kind="action" aria-hidden="true" /></button>
    <input ref={input} type="file" hidden multiple data-attachment-input="" aria-label={t("选择附件")} disabled={disabled}
      onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ""; try { if (files.length) onFiles(files); } finally { finish(); } }} />
  </>;
}
