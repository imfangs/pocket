import {
  Clock3,
  Search,
  Pin,
  ArrowUpRight,
  Inbox,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { Group, Thread, View } from "./types";
import { ago, today, groupPath } from "./model";
import { emptyListContent, threadListStates } from "./listPresentation";
import type { TaskStatus } from "./taskStatuses";
interface Props {
  threads: Thread[];
  groups: Group[];
  selected: string | null;
  view: View;
  unreadAvailable?: boolean;
  unreadPending?: number;
  onSelect: (id: string) => void;
  onOpen: (t: Thread) => void;
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
  const [selecting, setSelecting] = useState(false);
  const empty = emptyListContent({ view: p.view, query: p.query, hasFilters: p.hasFilters, unreadAvailable: p.unreadAvailable, unreadPending: p.unreadPending,
    runtimeAvailable: !p.runtimeLoading && !p.runtimeUnavailable, runtimeLoading: p.runtimeLoading });
  const emptyAction = empty.action === "create" ? p.onCreate : empty.action === "showAll" ? p.onShowAll
    : empty.action === "refresh" ? p.onRefresh : empty.action === "clearFilters" ? p.onClearFilters : p.onClearQuery;
  useEffect(() => setLimit(80), [p.threads.length, p.query, p.view]);
  return (
    <div
      className={`task-list-surface ${selecting || p.checked.size ? "is-selecting" : ""}`}
    >
      {p.checked.size > 0 ? (
        <div className="batch-bar">
          <span>已选 {p.checked.size} 条</span>
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
          <button
            className="icon-button"
            aria-label="清除选择"
            onClick={() => {
              p.onClear();
              setSelecting(false);
            }}
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <div className="list-caption">
          <label className="select-all">
            <input
              type="checkbox"
              checked={
                p.threads.length > 0 &&
                p.threads.every((t) => p.checked.has(t.id))
              }
              onChange={p.onCheckAll}
              aria-label="全选当前结果"
            />
            会话
          </label>
          <button
            className="mobile-selection-toggle"
            aria-pressed={selecting}
            onClick={() => setSelecting(!selecting)}
          >
            {selecting ? "完成" : "选择"}
          </button>
        </div>
      )}
      {(p.runtimeUnavailable || p.runtimeLoading) && <p className="task-runtime-availability" role="status">
        {p.runtimeUnavailable ? "运行状态暂不可用" : "正在读取运行状态…"}
      </p>}
      {p.threads.length === 0 ? (
        <div className="empty-list">
          {p.query ? <Search size={30} /> : <Inbox size={32} />}
          <h2>{empty.title}</h2>
          <p>{empty.description}</p>
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
              <div
                className={`task-row ${p.selected === t.id ? "is-selected" : ""} ${p.checked.has(t.id) ? "is-checked" : ""}`}
                key={t.id}
                role="listitem"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-codex-thread", t.id);
                  e.dataTransfer.effectAllowed = "copy";
                }}
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
                  onClick={() => p.onSelect(t.id)}
                  aria-pressed={p.selected === t.id}
                  title={t.title}
                >
                  <div className="row-first">
                    <strong>{t.separator ? "分隔符会话" : t.title}</strong>
                    {t.pinned && <Pin size={13} className="pin-icon" />}
                    <time dateTime={new Date(t.updatedAt).toISOString()}>
                      {ago(t.updatedAt)}
                    </time>
                  </div>
                  <div className="row-second">
                    <span className="project-label">
                      {t.projectName === "无项目" ? "独立会话" : t.projectName}
                    </span>
                    {t.intent !== "none" && (
                      <span className={`intent-dot ${t.intent}`}>
                        {t.intent === "active"
                          ? "推进中"
                          : t.intent === "later"
                            ? "稍后继续"
                            : "参考"}
                      </span>
                    )}
                    {states.map(state => <span key={state.key} className="task-state-badge" data-state={state.key}>{state.label}</span>)}
                    {due && <span className="due-label">到回顾时间了</span>}
                  </div>
                  {t.note && (
                    <p className="note-preview"><span className="task-note-label">接续</span> {t.note.replace(/\n/g, " ")}</p>
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
              </div>
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
          <div className="list-end">
            {p.threads.length <= limit ? "已显示全部" : `${limit} / ${p.threads.length} 条会话`}
          </div>
        </div>
      )}
    </div>
  );
}
