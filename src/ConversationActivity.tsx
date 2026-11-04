import { t } from "./i18n";
import "./conversation-activity.css";

export default function ConversationActivity({ turnId }: { turnId: string }) {
  return <div className="conversation-working" role="status" aria-live="polite" aria-atomic="true" data-turn-id={turnId}>
    <span className="sr-only">{t("正在运行")}</span>
    <span className="conversation-working-dots" aria-hidden="true">
      <span className="conversation-working-dot" />
      <span className="conversation-working-dot" />
      <span className="conversation-working-dot" />
    </span>
  </div>;
}
