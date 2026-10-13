import {
  Search,
  Pin,
  ArrowUpRight,
  Inbox,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Thread, View } from "./types";
import { ago } from "./model";
import { emptyListContent, threadListPresentation } from "./listPresentation";
import type { TaskStatus } from "./taskStatuses";
import SwipeTaskRow from "./SwipeTaskRow";
import "./task-list-status.css";
interface Props {
  threads: Thread[];
  projectScope?: string;
  selected: string | null;
  view: View;
  unreadAvailable?: boolean;
  unreadPending?: number;
  onSelect: (id: string) => void;
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
  const [limit, setLimit] = useState(80);
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const [pinningId, setPinningId] = useState<string | null>(null);
  const [pinErrors, setPinErrors] = useState<Record<string, string>>({});
  const pinning = useRef<string | null>(null), mounted = useRef(true), list = useRef<HTMLDivElement>(null);
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
  const pin = async (thread: Thread) => {
    if (!p.onPin || p.busy || pinning.current) return;
    pinning.current = thread.id; setPinningId(thread.id); setOpenRowId(thread.id); clearPinError(thread.id);
    try {
      await p.onPin(thread);
      if (mounted.current) setOpenRowId(current => current === thread.id ? null : current);
    } catch (failure) {
      if (mounted.current) setPinErrors(previous => ({ ...previous, [thread.id]: failure instanceof Error ? failure.message : "置顶未完成，请重试。" }));
    } finally {
      pinning.current = null;
      if (mounted.current) setPinningId(null);
    }
  };
  const empty = emptyListContent({ view: p.view, query: p.query, hasFilters: p.hasFilters, unreadAvailable: p.unreadAvailable, unreadPending: p.unreadPending,
    runtimeAvailable: !p.runtimeLoading && !p.runtimeUnavailable, runtimeLoading: p.runtimeLoading });
  const emptyAction = empty.action === "create" ? p.onCreate : empty.action === "showAll" ? p.onShowAll
    : empty.action === "refresh" ? p.onRefresh : empty.action === "clearFilters" ? p.onClearFilters : p.onClearQuery;
  useEffect(() => setLimit(80), [p.threads.length, p.query, p.view]);
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
            const runtime = p.runtimeUnavailable || p.runtimeLoading ? undefined : p.runtimeStates?.get(t.id);
            const presentation = threadListPresentation(t, p.draftIds?.has(t.id), runtime);
            const states = presentation.secondaryStates.filter(state => state.key !== "archived" || p.view !== "archived");
            return (
              <SwipeTaskRow
                className={`task-row ${p.selected === t.id ? "is-selected" : ""}`}
                key={t.id}
                threadId={t.id} title={t.title} pinned={t.pinned} open={openRowId === t.id}
                disabled={p.busy || !!pinningId} pending={pinningId === t.id} error={pinErrors[t.id]}
                onPin={p.onPin ? () => void pin(t) : undefined}
                onOpenChange={value => setOpenRowId(current => value ? t.id : current === t.id ? null : current)}
                onClaim={() => setOpenRowId(current => current === t.id ? current : null)} onDismissError={() => clearPinError(t.id)}
              >
                <button
                  className="task-select"
                  data-thread-id={t.id}
                  onClick={() => { setOpenRowId(null); p.onSelect(t.id); }}
                  aria-pressed={p.selected === t.id}
                  title={t.title}
                >
                  <div className="row-first">
                    <strong>{t.separator ? "分隔符会话" : t.title}</strong>
                    {t.pinned && p.view !== "pinned" && <Pin size={13} className="pin-icon"
                      data-pin-source={t.pinSource ?? "codex"} role="img"
                      aria-label={t.pinSource === "pocket" ? "Pocket 置顶" : "Codex 置顶"} />}
                    <span className="row-status-slot">
                      {presentation.primaryState ? <span className="task-state-badge" data-state={presentation.primaryState.key}>
                        {presentation.primaryState.label}
                      </span> : <time dateTime={new Date(t.updatedAt).toISOString()}>{ago(t.updatedAt)}</time>}
                    </span>
                  </div>
                  {(!p.projectScope || states.length > 0 || pinningId === t.id) && <div className="row-second">
                    {!p.projectScope && <span className="project-label">
                      {t.projectName === "无项目" ? "独立会话" : t.projectName}
                    </span>}
                    {states.map(state => <span key={state.key} className="task-state-badge" data-state={state.key}>{state.label}</span>)}
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
              onClick={() => setLimit((n) => n + 80)}
            >
              显示更多 · 还有 {p.threads.length - limit} 条
            </button>
          )}
        </div>
      )}
    </div>
  );
}
