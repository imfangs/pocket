import { attachmentSize } from "./attachments";
import { t, useLocale } from "./i18n";
import type { AttachmentUploadDescriptor } from "./submittedQueries";

const uploadLabel = (status: AttachmentUploadDescriptor["status"]) => status === "uploaded" ? "已上传"
  : status === "failed" ? "上传未完成" : status === "unknown" ? "上传结果待核对" : status === "uploading" ? "上传中" : "等待上传";

// Descriptors carry no file capability. Only AttachmentList renders validated
// uploaded references elsewhere in the same message row.
export default function SubmittedUploadDetails({ items }: { items?: readonly AttachmentUploadDescriptor[] }) {
  useLocale();
  if (!items?.length) return null;
  return <details className="submitted-upload-details">
    <summary>{t("查看附件 {{count}}", { count: items.length })}</summary>
    <ul>{items.map(item => <li key={item.id} data-upload-status={item.status}>
      <span className="submitted-upload-name">{item.name}</span>
      <span className="submitted-upload-status">{t(uploadLabel(item.status))} · {attachmentSize(item.size)}</span>
      {item.error && ["failed", "unknown"].includes(item.status ?? "") && <span className="submitted-upload-error">{t(item.error)}</span>}
    </li>)}</ul>
  </details>;
}
