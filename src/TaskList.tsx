import {
  Search,
  Pin,
  Star,
  ArrowUpRight,
  Inbox,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ActivityFilter, Thread, ThreadSort, View } from "./types";
import { ago } from "./model";
import { lastMessageTime } from "./threadTime";
import { codexPinned, pocketPriority } from "./priority";
import { emptyListContent, threadListPresentation } from "./listPresentation";
import type { TaskStatus } from "./taskStatuses";
import SwipeTaskRow from "./SwipeTaskRow";
import { bindTaskListMotion } from "./taskListMotion";
import { bindListInteraction, heldListRows } from "./listInteraction";
import { inspectorEntryFromClick, type InspectorEntryOrigin } from "./inspectorFocus";
import "./task-list-status.css";
interface Props {
  threads: Thread[];
  projectScope?: string;
  selected: string | null;
  view: View;
  activity?: ActivityFilter;
  sort?: ThreadSort;
  unreadAvailable?: boolean;
  unreadPending?: number;
  onSelect: (id: string, animate?: boolean, origin?: InspectorEntryOrigin) => void;
  onOpen: (t: Thread) => void;
  onPriority?: (t: Thread) => Promise<void>;
  busy: boolean;
  query: string;
  onClearQuery: () => void;
  onCreate?: () => void;
  onShowAll?: () => void;
  onSearchAll?: () => void;
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
  const [prioritizingId, setPrioritizingId] = useState<string | null>(null);
  const [priorityErrors, setPriorityErrors] = useState<Record<string, string>>({});
  const prioritizing = useRef<string | null>(null), mounted = useRef(true), list = useRef<HTMLDivElement>(null);
  const motion = useRef<ReturnType<typeof bindTaskListMotion> | null>(null);
  const scope = `${p.view}\0${p.projectScope || ""}\0${p.activity || "all"}\0${p.sort || "smart"}\0${p.query}`;
  const limit = limits.get(scope) ?? 80;
  const [held, setHeld] = useState<{ scope: string; rows: Thread[] } | null>(null);
  const currentRows = new Map(p.threads.map(thread => [thread.id, thread]));
  const rows = held?.scope === scope ? heldListRows(p.threads, held.rows) : p.threads.slice(0, limit);
  const latest = useRef({ scope, rows, currentRows });
  latest.current = { scope, rows, currentRows };
  const interaction = useRef<ReturnType<typeof bindListInteraction> | null>(null);
  useLayoutEffect(() => {
    if (!list.current) return;
    const control = bindListInteraction(list.current, {
      scope: () => latest.current.scope,
      current: id => latest.current.currentRows.has(id),
      hold: () => setHeld({ scope: latest.current.scope, rows: latest.current.rows }),
      release: () => setHeld(null),
    });
    interaction.current = control;
    return () => { control.dispose(); interaction.current = null; };
  }, []);
  useLayoutEffect(() => { interaction.current?.scopeChanged(); }, [scope]);
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
  }, [p.threads, p.selected, p.runtimeStates, p.runtimeUnavailable, p.runtimeLoading, p.draftIds, prioritizingId, held, scope, limit, rememberAnchor]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setOpenRowId(null); }, [scope]);
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
  const clearPriorityError = (id: string) => setPriorityErrors(previous => { const next = { ...previous }; delete next[id]; return next; });
  const changePriority = async (thread: Thread, animate: boolean) => {
    if (!p.onPriority || p.busy || prioritizing.current) return;
    const current = latest.current.currentRows.get(thread.id);
    if (!current) return;
    thread = current;
    motion.current?.beginPriority(thread.id, !pocketPriority(thread), animate);
    prioritizing.current = thread.id; setPrioritizingId(thread.id); setOpenRowId(thread.id); clearPriorityError(thread.id);
    try {
      await p.onPriority(thread);
      motion.current?.confirmPriority(thread.id);
      if (mounted.current) setOpenRowId(current => current === thread.id ? null : current);
    } catch (failure) {
      motion.current?.cancelPriority(thread.id);
      if (mounted.current) setPriorityErrors(previous => ({ ...previous, [thread.id]: failure instanceof Error ? failure.message : "关注状态未保存，请重试。" }));
    } finally {
      prioritizing.current = null;
      if (mounted.current) setPrioritizingId(null);
    }
  };
  const empty = emptyListContent({ view: p.view, activity: p.activity, query: p.query, projectScope: p.projectScope, hasFilters: p.hasFilters, unreadAvailable: p.unreadAvailable, unreadPending: p.unreadPending,
    runtimeAvailable: !p.runtimeLoading && !p.runtimeUnavailable, runtimeLoading: p.runtimeLoading });
  const emptyAction = empty.action === "create" ? p.onCreate : empty.action === "showAll" ? p.onShowAll : empty.action === "searchAll" ? p.onSearchAll
    : empty.action === "refresh" ? p.onRefresh : empty.action === "clearFilters" ? p.onClearFilters : p.onClearQuery;
  return (
    <div
      ref={list}
      className="task-list-surface"
    >
      {rows.length > 0 && p.runtimeUnavailable && <p className="task-runtime-availability" role="status">
        运行状态暂不可用
      </p>}
      {rows.length === 0 ? (
        <div className="empty-list">
          {p.query ? <Search size={30} /> : <Inbox size={32} />}
          <h2>{empty.title}</h2>
          {empty.description && <p>{empty.description}</p>}
          {emptyAction && empty.actionLabel && <div className="empty-list-actions">
            <button className={empty.action === "create" ? "primary" : "secondary"} onClick={emptyAction} disabled={p.busy}>{empty.actionLabel}</button>
          </div>}
        </div>
      ) : (
        <div className="task-list" role="list" aria-label="会话列表">
          {rows.map((t) => {
            const inactive = !currentRows.has(t.id);
            const messageAt = lastMessageTime(t);
            const runtime = p.runtimeUnavailable || p.runtimeLoading ? undefined : p.runtimeStates?.get(t.id);
            const presentation = threadListPresentation(t, p.draftIds?.has(t.id), runtime);
            const states = presentation.secondaryStates.filter(state => state.key !== "archived" || p.view !== "archived");
            const rowState = presentation.primaryState?.key ?? states.find(state => state.key === "unread")?.key;
            return (
              <SwipeTaskRow
                className={`task-row ${p.selected === t.id ? "is-selected" : ""}`}
                key={t.id}
                threadId={t.id} title={t.title} prioritized={pocketPriority(t)} open={openRowId === t.id}
                disabled={inactive || p.busy || !!prioritizingId} pending={prioritizingId === t.id} error={priorityErrors[t.id]}
                onPriority={p.onPriority ? animate => void changePriority(t, animate) : undefined}
                onOpenChange={value => setOpenRowId(current => value ? t.id : current === t.id ? null : current)}
                onClaim={() => setOpenRowId(current => current === t.id ? current : null)} onDismissError={() => clearPriorityError(t.id)}
              >
                <button
                  className="task-select"
                  data-thread-id={t.id}
                  data-row-state={rowState}
                  disabled={inactive}
                  onClick={event => { if (!latest.current.currentRows.has(t.id)) return; setOpenRowId(null); p.onSelect(t.id, event.detail !== 0, inspectorEntryFromClick(event)); }}
                  aria-pressed={p.selected === t.id}
                  title={t.title}
                >
                  <div className="row-first">
                    <strong>{t.separator ? "分隔符会话" : t.title}</strong>
                    {pocketPriority(t) && <Star size={13} className="priority-icon"
                      data-list-status="priority" data-list-status-key="pocket" role="img" aria-label="Pocket 优先关注" />}
                    {codexPinned(t) && <Pin size={13} className="pin-icon"
                      data-list-status="codex-pin" data-list-status-key="codex" data-pin-source="codex" role="img" aria-label="Codex 置顶" />}
                    <span className="row-status-slot" data-list-status="primary" data-list-status-key={presentation.primaryState?.key ?? "time"}>
                      {presentation.primaryState ? <span className="task-state-badge" data-state={presentation.primaryState.key}>
                        {presentation.primaryState.label}
                      </span> : messageAt !== null ? <time dateTime={new Date(messageAt).toISOString()} title={`最后消息：${new Date(messageAt).toLocaleString("zh-CN")}`}>{ago(messageAt)}</time>
                        : <span aria-label="暂无可确认的消息时间" title="暂无可确认的消息时间">—</span>}
                    </span>
                  </div>
                  {(!p.projectScope || states.length > 0 || prioritizingId === t.id) && <div className="row-second">
                    {!p.projectScope && <span className="project-label">
                      {t.projectName === "无项目" ? "独立会话" : t.projectName}
                    </span>}
                    {states.length > 0 && <span className="row-secondary-states" data-list-status="secondary" data-list-status-key={states.map(state => state.key).join(" ")}>
                      {states.map(state => <span key={state.key} className="task-state-badge" data-state={state.key}>{state.label}</span>)}
                    </span>}
                    {prioritizingId === t.id && <span className="row-priority-pending" role="status">正在保存…</span>}
                  </div>}
                </button>
                <button
                  className="row-open icon-button"
                  aria-label={`在 Codex 打开 ${t.title}`}
                  title="在 Codex 打开"
                  onClick={() => { const current = latest.current.currentRows.get(t.id); if (current) p.onOpen(current); }}
                  disabled={inactive || t.missing}
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
