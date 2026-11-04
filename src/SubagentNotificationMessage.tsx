import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import { useId, useState, type Ref } from "react";
import { ChevronDown, ChevronUp, GitBranch } from "lucide-react";
import MessageMarkdown from "./MessageMarkdown";
import type { AnnotationLayoutChange } from "./AnnotationQuotes";
import type { SubagentNotification } from "./subagentNotification";
import { heartbeatFieldMarkdown } from "./heartbeatMessage";
import { useDisclosureMotion } from "./useDisclosureMotion";
import "./subagent-notification.css";

export default function SubagentNotificationMessage({ notification, changeLayout, readMarker }: {
  notification: SubagentNotification; changeLayout?: AnnotationLayoutChange; readMarker?: Ref<HTMLDivElement>;
}) {
  useLocale();
  const id = useId(), [open, setOpen] = useState(false);
  const motion = useDisclosureMotion(open, true);
  return <div className="subagent-notification" data-status={notification.status}>
    <div className="subagent-notification-heading">
      <span><AppIcon icon={GitBranch} kind="auxiliary" aria-hidden="true" />{t(notification.label)}</span>
      {notification.text && <button type="button" aria-expanded={open} aria-controls={id}
        onPointerDown={event => {
          // Protect the target while focus moves from another message control.
          // Otherwise near-bottom following can move it before the click lands.
          // A cancelled pointer needs no special cleanup: prepare expires next frame.
          if (event.button === 0 && event.isPrimary && !motion.ref.current?.hasAttribute("data-disclosure-motion"))
            motion.prepare(event.currentTarget);
        }} onPointerUp={event => {
          // Touch focus can move only after pointerup, including a held press.
          // An active transition already holds reading. Do not cancel it for a
          // pointer that might never click: a collapse must still finish hidden.
          if (event.button === 0 && event.isPrimary && !motion.ref.current?.hasAttribute("data-disclosure-motion"))
            motion.prepare(event.currentTarget);
        }} onClick={event => {
        motion.prepare(event.currentTarget);
        const update = () => setOpen(!open);
        if (changeLayout) changeLayout(event.currentTarget, update); else update();
      }}>{open ? t("收起结果") : t("查看结果")}{open ? <AppIcon icon={ChevronUp} kind="auxiliary" aria-hidden="true" /> : <AppIcon icon={ChevronDown} kind="auxiliary" aria-hidden="true" />}</button>}
    </div>
    {notification.text && <div id={id} ref={motion.ref} hidden={!open} className="subagent-notification-body">
      {/* A notification's result is inert Markdown, without file/image grants. */}
      <MessageMarkdown text={heartbeatFieldMarkdown(notification.text)} codex={false} />
      {open && readMarker && <div ref={readMarker} data-pocket-read-marker="" aria-hidden="true" style={{ height: 1 }} />}
    </div>}
  </div>;
}
