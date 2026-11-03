import { t, useLocale } from "./i18n";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useDisclosureMotion } from "./useDisclosureMotion";
import "./progress-disclosure.css";

export default function ProgressDisclosure({ id, count, open, onOpenChange, children }: {
  id: string;
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  useLocale();
  const contentId = `${id}-content`;
  const motion = useDisclosureMotion(open, true);
  return <div className="progress-disclosure">
    <button id={`${id}-toggle`} type="button" className="progress-disclosure-toggle" aria-expanded={open} aria-controls={contentId}
      onClick={event => { motion.prepare(event.currentTarget); onOpenChange(!open); }}>
      <ChevronRight className="progress-disclosure-chevron" size={14} aria-hidden="true" />
      <span>{open ? t("收起过程") : t("查看过程")}</span>
      <span className="progress-disclosure-count">{t("· {{count}} 条", { count })}</span>
    </button>
    <div id={contentId} ref={motion.ref} className="progress-disclosure-body" hidden={!open}>
      {children}
    </div>
  </div>;
}
