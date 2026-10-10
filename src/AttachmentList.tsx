import { FileText, Image as ImageIcon, Paperclip, RefreshCw, X } from "lucide-react";
import { useRef } from "react";
import { attachmentSize, safeAttachmentUrl, type AttachmentDraftController, type DraftAttachment, type PublicAttachment } from "./attachments";
import "./attachments.css";

function Preview({ attachment, image }: { attachment?: PublicAttachment; image: boolean }) {
  const url = attachment && safeAttachmentUrl(attachment.previewUrl ?? attachment.url);
  return image && url ? <img className="attachment-preview" src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
    : <span className="attachment-placeholder" aria-hidden="true">{image ? <ImageIcon size={20} /> : <FileText size={20} />}</span>;
}

export default function AttachmentList({ attachments = [] }: { attachments?: readonly PublicAttachment[] }) {
  if (!attachments.length) return null;
  return <div className="attachment-list" aria-label="消息附件">
    {attachments.map(attachment => {
      const url = safeAttachmentUrl(attachment.url);
      const contents = <><Preview attachment={attachment} image={attachment.kind === "image"} /><span className="attachment-details">
        <span className="attachment-name" title={attachment.name}>{attachment.name}</span><small>{attachmentSize(attachment.size)}</small></span></>;
      return url ? <a className="attachment-card" key={attachment.id} data-attachment-id={attachment.id} href={url} target="_blank" rel="noopener noreferrer"
        {...(attachment.kind === "file" ? { download: attachment.name } : {})} aria-label={`查看附件 ${attachment.name}`}>{contents}</a>
        : <div className="attachment-card" key={attachment.id} data-attachment-id={attachment.id}>{contents}</div>;
    })}
  </div>;
}

const labels: Record<DraftAttachment["status"], string> = { queued: "等待上传", uploading: "上传中…", uploaded: "已上传", failed: "上传未完成", unknown: "结果待核对", removing: "正在移除…" };
export function DraftAttachmentList({ threadId, items, controller, disabled, error, onRecover }: {
  threadId: string; items: readonly DraftAttachment[]; controller: AttachmentDraftController; disabled: boolean; error?: string; onRecover?: () => void;
}) {
  if (!items.length && !error) return null;
  return <section className="draft-attachments" aria-label="待发送附件">
    {items.map(item => <div className="attachment-card attachment-draft" key={item.id} data-attachment-id={item.id} data-upload-status={item.status}
      aria-busy={item.status === "uploading" || item.status === "removing" || item.checking || undefined}>
      <Preview attachment={item.attachment} image={item.attachment?.kind === "image" || item.kind === "image"} />
      <span className="attachment-details"><span className="attachment-name" title={item.name}>{item.name}</span>
        <small role="status">{item.checking ? "正在核对…" : labels[item.status]} · {attachmentSize(item.size)}</small>
        {item.error && <small className="attachment-error" role="alert">{item.error}</small>}
      </span>
      <div className="attachment-controls">
        {item.status === "failed" && <button type="button" disabled={disabled} aria-label={`重试上传 ${item.name}`} onClick={() => controller.retry(threadId, item.id)}><RefreshCw size={15} /></button>}
        {item.status === "unknown" && <button type="button" disabled={disabled || item.checking} aria-label={`核对附件 ${item.name}`} onClick={() => void controller.check(threadId, item.id)}>核对</button>}
        <button type="button" disabled={disabled || item.status === "removing" || item.checking} aria-label={`移除附件 ${item.name}`} onClick={() => void controller.remove(threadId, item.id)}><X size={16} /></button>
      </div>
    </div>)}
    {(error || items.length > 6) && <p className="attachment-error" role="alert">{error || "每条消息最多6个附件，请移除多余附件。"}</p>}
    {onRecover && <button type="button" className="text-button" disabled={disabled} onClick={onRecover}>载入已上传附件</button>}
  </section>;
}

export function AttachmentPicker({ disabled, onFiles }: { disabled: boolean; onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <button type="button" className="attachment-picker icon-button" aria-label="添加附件" title="添加图片或文件" disabled={disabled} onClick={() => input.current?.click()}><Paperclip size={18} aria-hidden="true" /></button>
    <input ref={input} type="file" hidden multiple data-attachment-input="" aria-label="选择附件" disabled={disabled}
      onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ""; if (files.length) onFiles(files); }} />
  </>;
}
