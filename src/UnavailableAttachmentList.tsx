import { FileText, Image as ImageIcon } from "lucide-react";
import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import "./attachments.css";

export default function UnavailableAttachmentList({ attachments = [] }: {
  attachments?: readonly { name: string; kind: 'image' | 'file' }[];
}) {
  useLocale();
  if (!attachments.length) return null;
  return <div className="attachment-list" aria-label={t("消息附件")}>
    {attachments.map((attachment, index) => <div className="attachment-card" key={index}>
      <span className="attachment-placeholder" aria-hidden="true"><AppIcon icon={attachment.kind === 'image' ? ImageIcon : FileText} kind="auxiliary" /></span>
      <span className="attachment-details"><span className="attachment-name">{attachment.name}</span>
        <small>{t("附件需在 Mac 中查看")}</small></span>
    </div>)}
  </div>;
}
