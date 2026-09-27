import {
  Check,
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
interface Props {
  threads: Thread[];
  groups: Group[];
  selected: string | null;
  view: View;
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
}
export default function TaskList(p: Props) {
  const [limit, setLimit] = useState(80);
  useEffect(() => setLimit(80), [p.threads.length, p.query, p.view]);
  return (
    <>
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
            onClick={p.onClear}
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
            任务
          </label>
          <span>最近活动</span>
        </div>
      )}
      {p.threads.length === 0 ? (
        <div className="empty-list">
          {p.query ? <Search size={30} /> : <Inbox size={32} />}
          <h2>
            {p.query
              ? "没有找到相关任务"
              : p.view === "later"
                ? "想以后继续的，留在这里"
                : "这里还没有任务"}
          </h2>
          <p>
            {p.query
              ? "试试任务名、项目名或接续说明里的词。"
              : p.view === "later"
                ? "选中一条任务，标记「稍后继续」。下次回来，从这里接上。"
                : "可以切换视图，或把任务拖入这个分组。"}
          </p>
          {p.query && (
            <button className="secondary" onClick={p.onClearQuery}>
              清除搜索
            </button>
          )}
        </div>
      ) : (
        <div className="task-list" role="list" aria-label="任务列表">
          {p.threads.slice(0, limit).map((t) => {
            const due =
              t.intent === "later" && t.reviewAt && t.reviewAt <= today();
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
                  onClick={() => p.onSelect(t.id)}
                  aria-pressed={p.selected === t.id}
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
                    {t.archived && <span>原版已归档</span>}
                    {due && <span className="due-label">到回顾时间了</span>}
                    {t.missing && <span className="due-label">来源待核对</span>}
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
            <Check size={12} /> {Math.min(limit, p.threads.length)} /{" "}
            {p.threads.length} 条任务
          </div>
        </div>
      )}
    </>
  );
}
