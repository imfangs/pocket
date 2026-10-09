import {
  ArrowUpRight,
  ChevronLeft,
  Check,
  Clipboard,
  GitBranch,
  MessageSquare,
  MoreHorizontal,
  Save,
  X,
} from "lucide-react";
import { useEffect, useState, useCallback, useId, useRef, useLayoutEffect } from "react";
import type { MutableRefObject } from "react";
import type { Group, Intent, Thread } from "./types";
import Conversation from "./Conversation";
import type { QueryDraft } from "./Conversation";
import { bindInspectorSwipe, bindInspectorViewport } from "./mobileInspector";
import type { HistoryCache } from "./conversationFeed";
import { holdReload, useReloadGuard } from "./updateSafety";
import type { OpenThreadResult } from "./threadConnection";
import { activeOperation, operationText, type TaskOperation } from "./taskOperations";
import TaskOperationStatus from "./TaskOperationStatus";
import ThreadProperties from "./ThreadProperties";
import type { SubmittedQueryStore } from "./submittedQueries";
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
  submissions?: SubmittedQueryStore;
  historyCache: HistoryCache;
  thread: Thread;
  groups: Group[];
  onSave: (
    id: string,
    patch: Draft & { expectedRevision: number },
  ) => Promise<Thread>;
  onOpen: (t: Thread) => Promise<OpenThreadResult>;
  operation?: TaskOperation;
  operationError?: string;
  onArchive: (thread: Thread, archived: boolean) => Promise<void>;
  onCheckOperation: (requestId: string) => void;
  onCancelOperation: (requestId: string) => void;
  onClose: () => void;
  onActivity?: () => void;
  flushRef: MutableRefObject<(() => Promise<void>) | null>;
  onToast: (s: string) => void;
}
export default function Inspector(p: Props) {
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(p.onClose);
  useLayoutEffect(() => { close.current = p.onClose; }, [p.onClose]);
  useLayoutEffect(() => {
    if (!panel.current) return;
    const releaseViewport = bindInspectorViewport(panel.current);
    const releaseSwipe = bindInspectorSwipe(panel.current, () => close.current());
    return () => { releaseViewport(); releaseSwipe(); };
  }, []);
  useLayoutEffect(() => {
    if (window.matchMedia("(max-width: 760px)").matches) closeButton.current?.focus({ preventScroll: true });
  }, []);
  const [tab, setTab] = useState<"conversation" | "organize">("conversation");
  const [managementOpen, setManagementOpen] = useState(false);
  const accessibilityId = useId();
  const tabButtons = useRef<{ conversation: HTMLButtonElement | null; organize: HTMLButtonElement | null }>({ conversation: null, organize: null });
  const managementTrigger = useRef<HTMLButtonElement>(null), managementPanel = useRef<HTMLDivElement>(null);
  const focusManagement = useRef(false);
  useLayoutEffect(() => {
    if (focusManagement.current && managementOpen && tab === "organize") { focusManagement.current = false; managementPanel.current?.focus({ preventScroll: true }); }
  }, [managementOpen, tab]);
  const [draft, setDraft] = useState<Draft>(() => draftOf(p.thread)),
    [base, setBase] = useState<Draft>(() => draftOf(p.thread)),
    [baseRevision, setBaseRevision] = useState(p.thread.revision),
    [saving, setSaving] = useState(false),
    [conflict, setConflict] = useState(false),
    [error, setError] = useState("");
  const pendingSave = useRef<Promise<void> | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const managementBlocked = activeOperation(p.operation);
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
          会话详情
        </span>
        <strong className="inspector-mobile-title" title={p.thread.title}>{p.thread.separator ? "分隔符会话" : p.thread.title}</strong>
        <div className="inspector-header-actions">
          <button ref={managementTrigger} type="button" className="inspector-management-trigger"
            aria-expanded={tab === "organize" && managementOpen} aria-controls={`${accessibilityId}-management`}
            onClick={() => {
              const opening = !(managementOpen && tab === "organize");
              focusManagement.current = opening; setManagementOpen(opening); setTab("organize");
            }}>
            <MoreHorizontal size={17} aria-hidden="true" /><span>管理</span>
          </button>
        </div>
        <button
          ref={closeButton}
          className="icon-button"
          aria-label="关闭详情"
          onClick={p.onClose}
        >
          <ChevronLeft size={23} className="inspector-back-icon" />
          <X size={18} className="inspector-close-icon" />
        </button>
      </div>
      <div className="inspector-tabs" role="tablist" aria-label="任务详情视图" aria-orientation="horizontal"
        onKeyDown={event => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const next = event.key === "Home" ? "conversation" : event.key === "End" ? "organize"
            : ["ArrowLeft", "ArrowRight"].includes(event.key) ? tab === "conversation" ? "organize" : "conversation" : null;
          if (!next) return;
          event.preventDefault(); setTab(next); tabButtons.current[next]?.focus();
        }}>
        <button
          ref={element => { tabButtons.current.conversation = element; }}
          role="tab"
          id={`${accessibilityId}-tab-conversation`}
          aria-controls={`${accessibilityId}-panel-conversation`}
          tabIndex={tab === "conversation" ? 0 : -1}
          aria-selected={tab === "conversation"}
          onClick={() => setTab("conversation")}
        >
          会话
        </button>
        <button
          ref={element => { tabButtons.current.organize = element; }}
          role="tab"
          id={`${accessibilityId}-tab-organize`}
          aria-controls={`${accessibilityId}-panel-organize`}
          tabIndex={tab === "organize" ? 0 : -1}
          aria-selected={tab === "organize"}
          onClick={() => setTab("organize")}
        >
          整理{dirty ? " · 未保存" : ""}
        </button>
      </div>
      <div
        id={`${accessibilityId}-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`${accessibilityId}-tab-${tab}`}
        tabIndex={0}
        className={
          tab === "conversation" ? "inspector-conversation" : "inspector-body"
        }
      >
        {p.operation && <TaskOperationStatus operation={p.operation} error={p.operationError}
          onCheck={() => p.onCheckOperation(p.operation!.requestId)} onCancel={() => p.onCancelOperation(p.operation!.requestId)} />}
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
            disabled={saving || p.thread.missing || managementBlocked}
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
            submissions={p.submissions}
            historyCache={p.historyCache}
            onActivity={p.onActivity}
            managementBlocked={managementBlocked}
            managementHint={managementBlocked && p.operation ? operationText(p.operation) : undefined}
            onConnect={async () => {
              await save();
              return p.onOpen(p.thread);
            }}
          />
        ) : (
          <>
            {managementOpen && <div ref={managementPanel} id={`${accessibilityId}-management`} className="archive-conversation inspector-management-panel" tabIndex={-1} aria-label="原会话管理">
              <strong>原会话管理</strong>
              <p className="field-description">{p.thread.archived ? "恢复后可以继续这段对话。" : "归档会同步到 Codex，已有草稿会保留。"}</p>
              <button type="button" className="secondary" disabled={saving || p.thread.missing || managementBlocked}
                onClick={async () => {
                  try { await save(); await p.onArchive(p.thread, !p.thread.archived); }
                  catch (failure) { setError((failure as Error).message); }
                }}>{p.thread.archived ? "恢复会话" : "归档会话"}</button>
              {p.operation?.code === "outbox_not_empty" && <button className="text-button" onClick={() => setTab("conversation")}>查看待发消息</button>}
              <button type="button" className="text-button" onClick={() => { setManagementOpen(false); managementTrigger.current?.focus(); }}>收起管理</button>
            </div>}
            <ThreadProperties value={draft} groups={p.groups} disabled={saving}
              onChange={patch => setDraft(previous => ({ ...previous, ...patch }))} onSave={save} />
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
      <div hidden role="tabpanel" id={`${accessibilityId}-panel-${tab === "conversation" ? "organize" : "conversation"}`}
        aria-labelledby={`${accessibilityId}-tab-${tab === "conversation" ? "organize" : "conversation"}`} />
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
