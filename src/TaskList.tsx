import {
  Search,
  Pin,
  ArrowUpRight,
  Inbox,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Thread, View } from "./types";
import { ago } from "./model";
import { lastMessageTime } from "./threadTime";
import { emptyListContent, threadListPresentation } from "./listPresentation";
import type { TaskStatus } from "./taskStatuses";
import SwipeTaskRow from "./SwipeTaskRow";
import { bindTaskListMotion } from "./taskListMotion";
import "./task-list-status.css";
interface Props {
  threads: Thread[];
  projectScope?: string;
  selected: string | null;
  view: View;
  unreadAvailable?: boolean;
  unreadPending?: number;
  onSelect: (id: string, animate?: boolean) => void;
  onOpen: (t: Thread) => void;
  onPin?: (t: Thread) => Promise<void>;
  busy: boolean;
  query: string;
  onClearQuery: () => void;
  onCreate?: () => void;
  onShowAll?: () => void;
  onRefresh?: () => void;
  onClearFilters?: () => void;
  hasFilters?: boolean;
  draftIds?: ReadonlySet<string>;
  runtimeStates?: ReadonlyMap<string, TaskStatus>;
  runtimeUnavailable?: boolean;
  runtimeLoading?: boolean;
}
export default function TaskList(p: Props) {
  const [limits, setLimits] = useState(() => new Map<string, number>());
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const [pinningId, setPinningId] = useState<string | null>(null);
  const [pinErrors, setPinErrors] = useState<Record<string, string>>({});
  const pinning = useRef<string | null>(null), mounted = useRef(true), list = useRef<HTMLDivElement>(null);
  const motion = useRef<ReturnType<typeof bindTaskListMotion> | null>(null);
  const scope = `${p.view}\0${p.projectScope || ""}\0${p.query}`;
  const limit = limits.get(scope) ?? 80;
  const anchor = useRef<{ scope: string; id: string; offset: number } | null>(null);
  useLayoutEffect(() => {
    if (!list.current) return;
    const controller = bindTaskListMotion(list.current);
    motion.current = controller;
    return () => { controller.dispose(); motion.current = null; };
  }, []);
  const rememberAnchor = useCallback(() => {
    const root = list.current, panel = root?.closest<HTMLElement>(".list-panel");
    if (!root || !panel?.clientHeight || motion.current?.isMoving()) return;
    if (panel.scrollTop < 1) { anchor.current = null; return; }
    const top = panel.getBoundingClientRect().top;
    const first = [...root.querySelectorAll<HTMLElement>("[data-thread-id]")].find(node => node.getBoundingClientRect().bottom > top);
    anchor.current = first ? { scope, id: first.dataset.threadId!, offset: first.getBoundingClientRect().top - top } : null;
  }, [scope]);
  useEffect(() => {
    const panel = list.current?.closest<HTMLElement>(".list-panel");
    let frame = 0;
    const scroll = () => {
      if (panel && panel.scrollTop < 1) anchor.current = null;
      cancelAnimationFrame(frame); frame = requestAnimationFrame(rememberAnchor);
    };
    panel?.addEventListener("scroll", scroll, { passive: true });
    return () => { panel?.removeEventListener("scroll", scroll); cancelAnimationFrame(frame); };
  }, [rememberAnchor]);
  useLayoutEffect(() => {
    // Remove only our temporary Y transform before measuring layout or restoring
    // the reading anchor. Swipe X and its in-flight touch remain independent.
    motion.current?.prepareLayout();
    const root = list.current, panel = root?.closest<HTMLElement>(".list-panel");
    if (!root || !panel?.clientHeight) { motion.current?.commit(scope); return; }
    const previous = anchor.current;
    // DOM moves may already have clamped scrollTop to zero. Use the saved
    // reader position, not that intermediate post-layout scroll value.
    if (previous?.scope === scope) {
      const target = [...root.querySelectorAll<HTMLElement>("[data-thread-id]")].find(node => node.dataset.threadId === previous.id);
      if (target) panel.scrollTop += target.getBoundingClientRect().top - panel.getBoundingClientRect().top - previous.offset;
    }
    rememberAnchor();
    motion.current?.commit(scope);
  }, [p.threads, p.selected, p.runtimeStates, p.runtimeUnavailable, p.runtimeLoading, p.draftIds, pinningId, scope, limit, rememberAnchor]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setOpenRowId(null); }, [p.view, p.query, p.projectScope]);
  useEffect(() => {
    if (openRowId && !p.threads.some(thread => thread.id === openRowId)) setOpenRowId(null);
  }, [p.threads, openRowId]);
  useEffect(() => {
    if (!openRowId) return;
    const outside = (event: Event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-swipe-row-id]") : null;
      if (!target || !list.current?.contains(target) || target.dataset.swipeRowId !== openRowId) setOpenRowId(null);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside); };
  }, [openRowId]);
  const clearPinError = (id: string) => setPinErrors(previous => { const next = { ...previous }; delete next[id]; return next; });
  const pin = async (thread: Thread, animate: boolean) => {
    if (!p.onPin || p.busy || pinning.current) return;
    motion.current?.beginPin(thread.id, !thread.pinned, animate);
    pinning.current = thread.id; setPinningId(thread.id); setOpenRowId(thread.id); clearPinError(thread.id);
    try {
      await p.onPin(thread);
      motion.current?.confirmPin(thread.id);
      if (mounted.current) setOpenRowId(current => current === thread.id ? null : current);
    } catch (failure) {
      motion.current?.cancelPin(thread.id);
      if (mounted.current) setPinErrors(previous => ({ ...previous, [thread.id]: failure instanceof Error ? failure.message : "置顶未完成，请重试。" }));
    } finally {
      pinning.current = null;
      if (mounted.current) setPinningId(null);
    }
  };
  const empty = emptyListContent({ view: p.view, query: p.query, projectScope: p.projectScope, hasFilters: p.hasFilters, unreadAvailable: p.unreadAvailable, unreadPending: p.unreadPending,
    runtimeAvailable: !p.runtimeLoading && !p.runtimeUnavailable, runtimeLoading: p.runtimeLoading });
  const emptyAction = empty.action === "create" ? p.onCreate : empty.action === "showAll" ? p.onShowAll
    : empty.action === "refresh" ? p.onRefresh : empty.action === "clearFilters" ? p.onClearFilters : p.onClearQuery;
  return (
    <div
      ref={list}
      className="task-list-surface"
    >
      {p.threads.length > 0 && p.runtimeUnavailable && <p className="task-runtime-availability" role="status">
        运行状态暂不可用
      </p>}
      {p.threads.length === 0 ? (
        <div className="empty-list">
          {p.query ? <Search size={30} /> : <Inbox size={32} />}
          <h2>{empty.title}</h2>
          {empty.description && <p>{empty.description}</p>}
          {emptyAction && empty.actionLabel && <div className="empty-list-actions">
            <button className={empty.action === "create" ? "primary" : "secondary"} onClick={emptyAction} disabled={p.busy}>{empty.actionLabel}</button>
          </div>}
        </div>
      ) : (
        <div className="task-list" role="list" aria-label="任务列表">
          {p.threads.slice(0, limit).map((t) => {
            const messageAt = lastMessageTime(t);
            const runtime = p.runtimeUnavailable || p.runtimeLoading ? undefined : p.runtimeStates?.get(t.id);
            const presentation = threadListPresentation(t, p.draftIds?.has(t.id), runtime);
            const states = presentation.secondaryStates.filter(state => state.key !== "archived" || p.view !== "archived");
            const rowState = presentation.primaryState?.key ?? states.find(state => state.key === "unread")?.key;
            return (
              <SwipeTaskRow
                className={`task-row ${p.selected === t.id ? "is-selected" : ""}`}
                key={t.id}
                threadId={t.id} title={t.title} pinned={t.pinned} open={openRowId === t.id}
                disabled={p.busy || !!pinningId} pending={pinningId === t.id} error={pinErrors[t.id]}
                onPin={p.onPin ? animate => void pin(t, animate) : undefined}
                onOpenChange={value => setOpenRowId(current => value ? t.id : current === t.id ? null : current)}
                onClaim={() => setOpenRowId(current => current === t.id ? current : null)} onDismissError={() => clearPinError(t.id)}
              >
                <button
                  className="task-select"
                  data-thread-id={t.id}
                  data-row-state={rowState}
                  onClick={event => { setOpenRowId(null); p.onSelect(t.id, event.detail !== 0); }}
                  aria-pressed={p.selected === t.id}
                  title={t.title}
                >
                  <div className="row-first">
                    <strong>{t.separator ? "分隔符会话" : t.title}</strong>
                    {t.pinned && p.view !== "pinned" && <Pin size={13} className="pin-icon"
                      data-list-status="pin" data-list-status-key={t.pinSource ?? "codex"}
                      data-pin-source={t.pinSource ?? "codex"} role="img"
                      aria-label={t.pinSource === "pocket" ? "Pocket 置顶" : "Codex 置顶"} />}
                    <span className="row-status-slot" data-list-status="primary" data-list-status-key={presentation.primaryState?.key ?? "time"}>
                      {presentation.primaryState ? <span className="task-state-badge" data-state={presentation.primaryState.key}>
                        {presentation.primaryState.label}
                      </span> : messageAt !== null ? <time dateTime={new Date(messageAt).toISOString()} title={`最后消息：${new Date(messageAt).toLocaleString("zh-CN")}`}>{ago(messageAt)}</time>
                        : <span aria-label="暂无可确认的消息时间" title="暂无可确认的消息时间">—</span>}
                    </span>
                  </div>
                  {(!p.projectScope || states.length > 0 || pinningId === t.id) && <div className="row-second">
                    {!p.projectScope && <span className="project-label">
                      {t.projectName === "无项目" ? "独立会话" : t.projectName}
                    </span>}
                    {states.length > 0 && <span className="row-secondary-states" data-list-status="secondary" data-list-status-key={states.map(state => state.key).join(" ")}>
                      {states.map(state => <span key={state.key} className="task-state-badge" data-state={state.key}>{state.label}</span>)}
                    </span>}
                    {pinningId === t.id && <span className="row-pin-pending" role="status">正在处理置顶…</span>}
                  </div>}
                </button>
                <button
                  className="row-open icon-button"
                  aria-label={`在 Codex 打开 ${t.title}`}
                  title="在 Codex 打开"
                  onClick={() => p.onOpen(t)}
                  disabled={t.missing}
                >
                  <ArrowUpRight size={18} />
                </button>
              </SwipeTaskRow>
            );
          })}
          {p.threads.length > limit && (
            <button
              className="load-more"
              onClick={() => setLimits(previous => {
                const next = new Map(previous);
                next.delete(scope); next.set(scope, limit + 80);
                if (next.size > 10) next.delete(next.keys().next().value!);
                return next;
              })}
            >
              显示更多 · 还有 {p.threads.length - limit} 条
            </button>
          )}
        </div>
      )}
    </div>
  );
}
