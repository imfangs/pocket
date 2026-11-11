import { useEffect, useState } from "react";
import { CircleAlert, ChevronDown } from "lucide-react";
import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import CopyButton from "./CopyButton";
import type { TurnFailure } from "./conversationFeed";
import type { AnnotationLayoutChange } from "./AnnotationQuotes";
import { failureHasDetails, turnFailureDetails, turnFailureSummary } from "./turnFailures";
import { useDisclosureMotion } from "./useDisclosureMotion";
import "./turn-failure.css";

export default function TurnFailureMessage({ failure, changeLayout }: { failure: TurnFailure; changeLayout?: AnnotationLayoutChange }) {
  useLocale();
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [failure.turnId]);
  const details = turnFailureDetails(failure), expandable = failureHasDetails(failure), motion = useDisclosureMotion(open, true);
  const summary = turnFailureSummary(failure);
  return <article className="turn-failure" data-turn-failure-id={failure.turnId} aria-label={t("本轮运行失败")}>
    <div className="turn-failure-heading"><AppIcon icon={CircleAlert} kind="auxiliary" aria-hidden="true" /><strong>{t("本轮运行失败")}</strong></div>
    <p className="turn-failure-summary" dir="auto">{summary === failure.message ? summary : t(summary)}</p>
    {expandable && <button type="button" className="turn-failure-disclosure" aria-expanded={open}
      onClick={event => {
        motion.prepare(event.currentTarget);
        const update = () => setOpen(value => !value);
        if (changeLayout) changeLayout(event.currentTarget, update); else update();
      }}><AppIcon icon={ChevronDown} kind="auxiliary" aria-hidden="true" />{t(open ? "收起错误详情" : "查看错误详情")}</button>}
    {expandable && <div className="turn-failure-detail" ref={motion.ref} hidden={!open}>
      <pre dir="auto">{details}</pre>
      <CopyButton text={details} label={t("复制错误信息")} />
    </div>}
  </article>;
}
