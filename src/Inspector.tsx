import {
  ArrowUpRight,
  ChevronLeft,
  CalendarDays,
  Check,
  Clipboard,
  Folder,
  GitBranch,
  MessageSquare,
  Save,
  X,
} from "lucide-react";
import { useEffect, useState, useCallback, useRef, useLayoutEffect } from "react";
import type { MutableRefObject } from "react";
import type { Group, Intent, Thread } from "./types";
import { intentLabels } from "./types";
import { groupPath } from "./model";
import Conversation from "./Conversation";
import type { QueryDraft } from "./Conversation";
import { bindInspectorSwipe, bindInspectorViewport } from "./mobileInspector";
import type { HistoryCache } from "./conversationFeed";
import { holdReload, useReloadGuard } from "./updateSafety";
import type { OpenThreadResult } from "./threadConnection";
type Draft = {
  intent: Intent;
  note: string;
  reviewAt: string | null;
  groupIds: string[];
};
const draftOf = (t: Thread): Draft => ({
  intent: t.intent,
  note: t.note,
  reviewAt: t.reviewAt,
  groupIds: t.groupIds,
});
interface Props {
  queryDrafts: Map<string, QueryDraft>;
  historyCache: HistoryCache;
  thread: Thread;
  groups: Group[];
  onSave: (
    id: string,
    patch: Draft & { expectedRevision: number },
  ) => Promise<Thread>;
  onOpen: (t: Thread) => Promise<OpenThreadResult>;
  onClose: () => void;
  onActivity?: () => void;
  flushRef: MutableRefObject<(() => Promise<void>) | null>;
  onToast: (s: string) => void;
}
export default function Inspector(p: Props) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(p.onClose);
  useLayoutEffect(() => { close.current = p.onClose; }, [p.onClose]);
  useLayoutEffect(() => {
    if (!panel.current) return;
    const releaseViewport = bindInspectorViewport(panel.current);
    const releaseSwipe = bindInspectorSwipe(panel.current, () => close.current());
    return () => { releaseViewport(); releaseSwipe(); };
  }, []);
  const [tab, setTab] = useState<"conversation" | "organize">("conversation");
  const [draft, setDraft] = useState<Draft>(() => draftOf(p.thread)),
    [base, setBase] = useState<Draft>(() => draftOf(p.thread)),
    [baseRevision, setBaseRevision] = useState(p.thread.revision),
    [saving, setSaving] = useState(false),
    [conflict, setConflict] = useState(false),
    [error, setError] = useState("");
  const pendingSave = useRef<Promise<void> | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  useReloadGuard(() => saving || pendingSave.current ? "整理正在保存，请稍后更新。"
    : dirty ? "整理还有未保存的修改，请保存后再更新。" : null);
  useEffect(() => {
    if (!dirty && p.thread.revision !== baseRevision) {
      const fresh = draftOf(p.thread);
      setDraft(fresh);
      setBase(fresh);
      setBaseRevision(p.thread.revision);
    }
  }, [p.thread.revision, dirty, baseRevision]);
  const save = useCallback(async () => {
    if (pendingSave.current) return pendingSave.current;
    if (!dirty) return;
    const operation = async () => {
      const release = holdReload();
      setSaving(true);
      setError("");
      setConflict(false);
      try {
        const t = await p.onSave(p.thread.id, {
          ...draft,
          expectedRevision: baseRevision,
        });
        const next = draftOf(t);
        setDraft(next);
        setBase(next);
        setBaseRevision(t.revision);
      } catch (e) {
        setError((e as Error).message);
        setConflict((e as Error & { status?: number }).status === 409);
        throw e;
      } finally {
        release();
        setSaving(false);
      }
    };
    const promise = operation();
    pendingSave.current = promise;
    try {
      await promise;
    } finally {
      if (pendingSave.current === promise) pendingSave.current = null;
    }
  }, [dirty, draft, p.thread.id, baseRevision, p.onSave]);
  useEffect(() => {
    p.flushRef.current = save;
    return () => {
      p.flushRef.current = null;
    };
  }, [save]);
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((old) => ({ ...old, [key]: value }));
  const open = async () => {
    try {
      await save();
      await p.onOpen(p.thread);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <aside className="inspector" aria-label="接续详情" ref={panel}>
      <div className="inspector-header">
        <span className="inspector-desktop-label">
          <MessageSquare size={15} />
          任务详情
        </span>
        <strong className="inspector-mobile-title" title={p.thread.title}>{p.thread.separator ? "分隔符会话" : p.thread.title}</strong>
        <button
          className="icon-button"
          aria-label="关闭详情"
          onClick={p.onClose}
        >
          <ChevronLeft size={23} className="inspector-back-icon" />
          <X size={18} className="inspector-close-icon" />
        </button>
      </div>
      <div className="inspector-tabs" role="tablist" aria-label="任务详情视图">
        <button
          role="tab"
          aria-selected={tab === "conversation"}
          onClick={() => setTab("conversation")}
        >
          会话
        </button>
        <button
          role="tab"
          aria-selected={tab === "organize"}
          onClick={() => setTab("organize")}
        >
          整理{dirty ? " · 未保存" : ""}
        </button>
      </div>
      <div
        className={
          tab === "conversation" ? "inspector-conversation" : "inspector-body"
        }
      >
        <div className="inspector-summary">
          <div className="source-line">
            {p.thread.projectName}
            {p.thread.archived && <span>已归档</span>}
          </div>
          <h2>{p.thread.separator ? "分隔符会话" : p.thread.title}</h2>
          {p.thread.separator && (
            <p className="inline-hint">原版用作分隔符的会话，历史仍然保留。</p>
          )}
          <button
            className="primary open-primary"
            onClick={open}
            disabled={saving || p.thread.missing}
          >
            在 Mac 打开原任务
            <ArrowUpRight size={17} />
          </button>
        </div>
        {tab === "conversation" ? (
          <Conversation
            key={p.thread.id}
            thread={p.thread}
            drafts={p.queryDrafts}
            historyCache={p.historyCache}
            onActivity={p.onActivity}
            onConnect={async () => {
              await save();
              return p.onOpen(p.thread);
            }}
          />
        ) : (
          <>
            <fieldset disabled={saving} className="inspector-fields">
              <label className="field-label" htmlFor="intent">
                分类
              </label>
              <div className="intent-options" id="intent">
                {(["none", "active", "later", "reference"] as Intent[]).map(
                  (intent) => (
                    <button
                      key={intent}
                      type="button"
                      className={draft.intent === intent ? "chosen" : ""}
                      aria-pressed={draft.intent === intent}
                      onClick={() => update("intent", intent)}
                    >
                      {intentLabels[intent]}
                    </button>
                  ),
                )}
              </div>
              <label className="field-label">分组</label>
              <div className="membership-list">
                {p.groups.map((g) => (
                  <label key={g.id}>
                    <input
                      type="checkbox"
                      checked={draft.groupIds.includes(g.id)}
                      onChange={(e) =>
                        update(
                          "groupIds",
                          e.target.checked
                            ? [...draft.groupIds, g.id]
                            : draft.groupIds.filter((id) => id !== g.id),
                        )
                      }
                    />
                    <Folder size={14} color={g.color} />
                    <span>{groupPath(p.groups, g.id)}</span>
                  </label>
                ))}
                {!p.groups.length && (
                  <p className="field-help">先在左侧新建一个分组。</p>
                )}
              </div>
              <label className="field-label note-label" htmlFor="continuation">
                接续说明
              </label>
              <textarea
                id="continuation"
                value={draft.note}
                maxLength={12000}
                rows={2}
                onInput={(e) => update("note", e.currentTarget.value)}
                onChange={(e) => update("note", e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void save().catch(() => {});
                  }
                }}
              />
              {draft.intent === "later" && (
                <label className="review-date">
                  <span>
                    <CalendarDays size={15} />
                    哪天再看 <small>可选</small>
                  </span>
                  <input
                    type="date"
                    aria-label="回顾日期"
                    value={draft.reviewAt || ""}
                    onInput={(e) =>
                      update("reviewAt", e.currentTarget.value || null)
                    }
                    onChange={(e) => update("reviewAt", e.target.value || null)}
                  />
                </label>
              )}
            </fieldset>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            {conflict && (
              <button
                className="text-button"
                onClick={() => {
                  const fresh = draftOf(p.thread);
                  setDraft(fresh);
                  setBase(fresh);
                  setBaseRevision(p.thread.revision);
                  setError("");
                  setConflict(false);
                }}
              >
                载入最新内容，放弃这份草稿
              </button>
            )}
            <details className="source-details">
              <summary>原会话信息</summary>
              <dl>
                <dt>工作目录</dt>
                <dd>{p.thread.cwd}</dd>
                {p.thread.branch && (
                  <>
                    <dt>
                      <GitBranch size={12} /> 分支
                    </dt>
                    <dd>{p.thread.branch}</dd>
                  </>
                )}
                <dt>创建时间</dt>
                <dd>{new Date(p.thread.createdAt).toLocaleString("zh-CN")}</dd>
                <dt>原会话 ID</dt>
                <dd className="thread-id">{p.thread.id}</dd>
              </dl>
              <button
                className="text-button desktop-action"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      `codex://threads/${p.thread.id}`,
                    );
                    p.onToast("原会话链接已复制");
                  } catch {
                    p.onToast("复制未完成，请在原会话信息中选取 ID");
                  }
                }}
              >
                <Clipboard size={13} />
                复制原会话链接
              </button>
            </details>
          </>
        )}
      </div>
      {tab === "organize" && (
        <div className="save-row inspector-savebar">
          <span aria-live="polite">
            {saving ? (
              "正在保存…"
            ) : dirty ? (
              "有未保存的修改"
            ) : (
              <>
                <Check size={13} />
                已保存
              </>
            )}
          </span>
          <button
            className="primary"
            onClick={() => void save().catch(() => {})}
            disabled={!dirty || saving}
          >
            <Save size={14} />
            {saving ? "保存中" : "保存"}
          </button>
        </div>
      )}
    </aside>
  );
}
