import { t, useLocale } from "./i18n";
import { useEffect, useId, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { AppIcon } from "./ui/AppIcon";
import type { RuntimeFeedback } from "./conversationRuntimeActivity";
import "./conversation-activity.css";

const operationLabels = { command: "正在执行命令", tool: "工具处理中", file: "正在修改文件", delegation: "子会话处理中" };
const duration = (ms: number | null) => ms === null ? t("时间未知") : ms < 60000 ? t("不到1分钟")
  : ms < 3600000 ? t("{{count}}分钟", { count: Math.floor(ms / 60000) }) : t("{{count}}小时", { count: Math.floor(ms / 3600000) });
const ago = (ms: number | null) => ms === null ? t("时间未知") : ms < 60000 ? t("刚刚") : t("{{time}}前", { time: duration(ms) });

export default function ConversationActivity({ turnId, working = true, feedbackAt, authorityAt, refresh, onLayoutChange, onAuthorityChange }: {
  turnId: string;
  working?: boolean;
  feedbackAt?: (now: number) => RuntimeFeedback | null;
  authorityAt?: (now: number) => boolean;
  refresh?: () => Promise<void> | void;
  onLayoutChange?: () => void;
  onAuthorityChange?: (current: boolean) => void;
}) {
  useLocale();
  const [now, setNow] = useState(() => performance.now());
  const [checking, setChecking] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const latest = useRef({ working, feedbackAt, authorityAt, onLayoutChange, expanded });
  latest.current = { working, feedbackAt, authorityAt, onLayoutChange, expanded };
  const requestVersion = useRef(0), mounted = useRef(true);
  const renderNow = Math.max(now, performance.now());
  const feedback = feedbackAt?.(renderNow) ?? null;
  const current = working && (authorityAt?.(renderNow) ?? feedback?.state !== "unconfirmed");
  const showDetails = expanded && !!feedback;
  const layout = `${current}:${showDetails}`;
  const lastLayout = useRef(layout); lastLayout.current = layout;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestVersion.current++; };
  }, []);
  useEffect(() => { requestVersion.current++; setChecking(false); }, [turnId]);
  useEffect(() => { onAuthorityChange?.(current); }, [current, onAuthorityChange]);
  useEffect(() => {
    if (!feedbackAt && !authorityAt) return;
    const update = () => {
      if (document.hidden) return;
      const next = performance.now(), value = latest.current.feedbackAt?.(next);
      const current = latest.current.working && (latest.current.authorityAt?.(next) ?? value?.state !== "unconfirmed");
      const nextLayout = `${current}:${latest.current.expanded && !!value}`;
      if (nextLayout !== lastLayout.current) latest.current.onLayoutChange?.();
      setNow(next);
    };
    const timer = window.setInterval(update, 5000);
    document.addEventListener("visibilitychange", update);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [!!feedbackAt, !!authorityAt]);
  const check = async () => {
    if (checking || !refresh) return;
    const version = ++requestVersion.current;
    setChecking(true);
    try { await refresh(); }
    catch { /* The feed owns errors and observation certainty. */ }
    finally { if (mounted.current && requestVersion.current === version) setChecking(false); }
  };
  const toggle = () => {
    onLayoutChange?.();
    setExpanded(value => !value);
  };
  if (!current && !feedback) return null;
  const label = feedback?.state === "unconfirmed" ? t("状态待核对")
    : feedback?.operation ? t(operationLabels[feedback.operation]) : t("正在运行");
  const detail = feedback?.detail === "operation" ? duration(feedback.ageMs)
    : feedback?.detail === "activity" ? ago(feedback.ageMs)
    : feedback?.detail === "messages" ? t("暂无新消息：{{time}}", { time: duration(feedback.ageMs) })
    : t("上次确认：{{time}}", { time: ago(feedback?.confirmedAgeMs ?? null) });
  const title = feedback ? t("最近核对：{{time}}", { time: ago(feedback.confirmedAgeMs) }) : undefined;
  return <div className={current ? "conversation-working" : "conversation-activity-unconfirmed"} role="status" aria-live="polite" aria-atomic="true"
    data-turn-id={turnId} data-detail={showDetails ? "true" : undefined} data-current={current ? "true" : "false"}>
    <span className="sr-only">{current ? t("正在运行") : t("状态待核对")}</span>
    <button type="button" className="conversation-activity-toggle" aria-label={t(expanded ? "收起运行详情" : "展开运行详情")}
      aria-expanded={expanded} aria-controls={showDetails ? detailsId : undefined}
      onPointerDown={event => { if (event.button === 0) event.preventDefault(); }} onClick={toggle}>
    <span className="conversation-working-dots" aria-hidden="true">
      <span className="conversation-working-dot" />
      <span className="conversation-working-dot" />
      <span className="conversation-working-dot" />
    </span>
    </button>
    {showDetails && <span id={detailsId} className="conversation-activity-details">
      <span className="conversation-activity-summary" title={title}>
        <span className="conversation-activity-label">{label}</span>
        <span aria-hidden="true">·</span>
        <span className="conversation-activity-detail" aria-label={feedback?.detail === "activity" ? t("最近活动：{{time}}", { time: detail }) : undefined}>{detail}</span>
      </span>
      {refresh && <button type="button" className="conversation-activity-check" disabled={checking} aria-label={t("核对进展")} aria-busy={checking}
        onPointerDown={event => { if (event.button === 0) event.preventDefault(); }} onClick={() => void check()}>
        <AppIcon icon={RefreshCw} kind="marker" className={checking ? "conversation-activity-spinner" : undefined} aria-hidden="true" />
      </button>}
    </span>}
  </div>;
}
