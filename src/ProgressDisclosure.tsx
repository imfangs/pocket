import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import "./progress-disclosure.css";

export default function ProgressDisclosure({ id, count, open, onOpenChange, children }: {
  id: string;
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const contentId = `${id}-content`;
  return <div className="progress-disclosure">
    <button id={`${id}-toggle`} type="button" className="progress-disclosure-toggle" aria-expanded={open} aria-controls={contentId}
      onClick={() => onOpenChange(!open)}>
      <ChevronRight className="progress-disclosure-chevron" size={14} aria-hidden="true" />
      <span>{open ? "收起过程" : "查看过程"}</span>
      <span className="progress-disclosure-count">· {count} 条</span>
    </button>
    <div id={contentId} className="progress-disclosure-body" hidden={!open}>
      {children}
    </div>
  </div>;
}
