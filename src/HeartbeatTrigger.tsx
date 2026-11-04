import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import { useId, useState } from "react";
import { ChevronDown, ChevronUp, Clock3 } from "lucide-react";
import MessageMarkdown from "./MessageMarkdown";
import type { AnnotationLayoutChange } from "./AnnotationQuotes";
import { useDisclosureMotion } from "./useDisclosureMotion";
import { heartbeatFieldMarkdown } from "./heartbeatMessage";
import "./heartbeat-message.css";

export default function HeartbeatTrigger({ instructions, changeLayout }: {
  instructions: string; changeLayout?: AnnotationLayoutChange;
}) {
  useLocale();
  const id = useId(), [open, setOpen] = useState(false);
  const motion = useDisclosureMotion(open, true);
  return <div className="heartbeat-trigger">
    <div className="heartbeat-trigger-heading">
      <span><AppIcon icon={Clock3} kind="auxiliary" aria-hidden="true" />{t("定时检查")}</span>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={event => {
        motion.prepare(event.currentTarget);
        const update = () => setOpen(!open);
        if (changeLayout) changeLayout(event.currentTarget, update); else update();
      }}>{open ? t("收起检查内容") : t("查看检查内容")}
        {open ? <AppIcon icon={ChevronUp} kind="auxiliary" aria-hidden="true" /> : <AppIcon icon={ChevronDown} kind="auxiliary" aria-hidden="true" />}
      </button>
    </div>
    <div id={id} ref={motion.ref} hidden={!open} className="heartbeat-trigger-body">
      <MessageMarkdown text={heartbeatFieldMarkdown(instructions)} codex={false} />
    </div>
  </div>;
}
