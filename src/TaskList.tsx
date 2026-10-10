import {
  Clock3,
  Search,
  Pin,
  ArrowUpRight,
  Inbox,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Group, Thread, View } from "./types";
import { ago, today, groupPath } from "./model";
import { emptyListContent, threadListStates } from "./listPresentation";
import type { TaskStatus } from "./taskStatuses";
import SwipeTaskRow from "./SwipeTaskRow";
interface Props {
  threads: Thread[];
  selecting?: boolean;
  projectScope?: string;
  groups: Group[];
  selected: string | null;
  view: View;
  unreadAvailable?: boolean;
  unreadPending?: number;
  onSelect: (id: string) => void;
  onOpen: (t: Thread) => void;
  onPin?: (t: Thread) => Promise<void>;
  checked: Set<string>;
  onCheck: (id: string) => void;
  onCheckAll: () => void;
  onBatch: (change: { intent?: string; groupId?: string }) => void;
  onClear: () => void;
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
  const selecting = !!p.selecting || p.checked.size > 0;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setOpenRowId(null); }, [selecting, p.view, p.query, p.projectScope]);
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
    if (!p.onPin || selecting || p.busy || pinning.current) return;
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
      className={`task-list-surface ${selecting || p.checked.size ? "is-selecting" : ""}`}
    >
      {selecting && (
        <div className="batch-bar" role="region" aria-label="批量操作">
          <label className="select-all"><input type="checkbox" checked={p.threads.length > 0 && p.threads.every(t => p.checked.has(t.id))}
            onChange={p.onCheckAll} aria-label="全选当前结果" />全选</label>
          {p.checked.size > 0 && <><span>已选 {p.checked.size} 条</span>
          <button
            onClick={() => p.onBatch({ intent: "later" })}
            disabled={p.busy}
          >
            <Clock3 size={14} />
            稍后继续
          </button>
          <select
            aria-label="批量加入分组"
            value=""
            onChange={(e) =>
              e.target.value && p.onBatch({ groupId: e.target.value })
            }
            disabled={p.busy}
          >
            <option value="">加入分组…</option>
            {p.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {groupPath(p.groups, g.id)}
              </option>
            ))}
          </select>
          </>}
          <button type="button" className="text-button selection-done" onClick={p.onClear} aria-label="完成选择">完成</button>
        </div>
      )}
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
            const due =
              t.intent === "later" && t.reviewAt && t.reviewAt <= today();
            const runtime = p.runtimeUnavailable || p.runtimeLoading ? undefined : p.runtimeStates?.get(t.id);
            const states = threadListStates(t, p.draftIds?.has(t.id), runtime);
            return (
              <SwipeTaskRow
                className={`task-row ${p.selected === t.id ? "is-selected" : ""} ${p.checked.has(t.id) ? "is-checked" : ""}`}
                key={t.id}
                threadId={t.id} title={t.title} pinned={t.pinned} open={openRowId === t.id}
                disabled={selecting || p.busy || !!pinningId} pending={pinningId === t.id} error={pinErrors[t.id]}
                onPin={p.onPin ? () => void pin(t) : undefined}
                onOpenChange={value => setOpenRowId(current => value ? t.id : current === t.id ? null : current)}
                onClaim={() => setOpenRowId(current => current === t.id ? current : null)} onDismissError={() => clearPinError(t.id)}
              >
                <label className="row-check">
                  <input
                    type="checkbox"
                    checked={p.checked.has(t.id)}
                    onChange={() => p.onCheck(t.id)}
                    aria-label={`选择 ${t.title}`}
                  />
                </label>
                <button
                  className="task-select"
                  data-thread-id={t.id}
                  onClick={() => { setOpenRowId(null); selecting ? p.onCheck(t.id) : p.onSelect(t.id); }}
                  aria-pressed={selecting ? p.checked.has(t.id) : p.selected === t.id}
                  title={t.title}
                >
                  <div className="row-first">
                    <strong>{t.separator ? "分隔符会话" : t.title}</strong>
                    {t.pinned && p.view !== "pinned" && <Pin size={13} className="pin-icon"
                      data-pin-source={t.pinSource ?? "codex"} role="img"
                      aria-label={t.pinSource === "pocket" ? "Pocket 置顶" : "Codex 置顶"} />}
                    <time dateTime={new Date(t.updatedAt).toISOString()}>
                      {ago(t.updatedAt)}
                    </time>
                  </div>
                  <div className="row-second">
                    {!p.projectScope && <span className="project-label">
                      {t.projectName === "无项目" ? "独立会话" : t.projectName}
                    </span>}
                    {t.intent !== "none" && t.intent !== p.view && (
                      <span className={`intent-dot ${t.intent}`}>
                        {t.intent === "active"
                          ? "推进中"
                          : t.intent === "later"
                            ? "稍后继续"
                            : "参考"}
                      </span>
                    )}
                    {states.filter(state => state.key !== "archived" || p.view !== "archived").map(state => <span key={state.key} className="task-state-badge" data-state={state.key}>{state.label}</span>)}
                    {due && <span className="due-label">到回顾时间了</span>}
                    {pinningId === t.id && <span className="row-pin-pending" role="status">正在处理置顶…</span>}
                  </div>
                  {t.note && (
                    <p className="note-preview">{t.note.replace(/\n/g, " ")}</p>
                  )}
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
