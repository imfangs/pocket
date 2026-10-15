import { Archive, ArrowUpRight, ChevronDown, ChevronLeft, Clipboard, GitBranch, Pencil, X } from "lucide-react";
import { useEffect, useState, useRef, useLayoutEffect } from "react";
import type { Thread } from "./types";
import Conversation from "./Conversation";
import type { QueryDraft } from "./Conversation";
import { bindInspectorViewport } from "./mobileInspector";
import { bindInspectorMotion } from "./inspectorMotion";
import type { HistoryCache } from "./conversationFeed";
import type { ConnectOptions, OpenThreadResult } from "./threadConnection";
import { activeOperation, operationText, type TaskOperation } from "./taskOperations";
import TaskOperationStatus from "./TaskOperationStatus";
import { Modal } from "./Dialogs";
import RenameThreadDialog from "./RenameThreadDialog";
import type { SubmittedQueryStore } from "./submittedQueries";
import { isMacBrowser } from "./browserPlatform";
import "./navigation-motion.css";
import ImagePreviewProvider from "./ImagePreviewProvider";
import { focusInspectorEntry, type InspectorEntryOrigin } from "./inspectorFocus";

interface Props {
  queryDrafts: Map<string, QueryDraft>;
  submissions?: SubmittedQueryStore;
  historyCache: HistoryCache;
  thread: Thread;
  onOpen: (t: Thread, options?: ConnectOptions) => Promise<OpenThreadResult>;
  operation?: TaskOperation;
  operationError?: string;
  onArchive: (thread: Thread, archived: boolean) => Promise<void>;
  onRenamed: (thread: Thread) => void;
  onCheckOperation: (requestId: string) => void;
  onCancelOperation: (requestId: string) => void;
  onClose: () => void;
  onActivity?: () => void;
  animateEntry?: boolean;
  entryOrigin?: InspectorEntryOrigin;
}
export default function Inspector(p: Props) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(p.onClose), overlayOpen = useRef(false), actionPending = useRef(false);
  const navigation = useRef<ReturnType<typeof bindInspectorMotion> | null>(null);
  const [infoOpen, setInfoOpen] = useState(false), [renaming, setRenaming] = useState(false);
  const [actionBusy, setActionBusy] = useState(false), [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const showMacOpen = isMacBrowser(typeof navigator === "undefined" ? undefined : navigator);
  const managementBlocked = activeOperation(p.operation);
  overlayOpen.current = infoOpen || renaming;
  useLayoutEffect(() => { close.current = p.onClose; }, [p.onClose]);
  useLayoutEffect(() => {
    if (panel.current && window.matchMedia("(max-width: 760px)").matches) focusInspectorEntry(panel.current, p.entryOrigin);
  }, []);
  useLayoutEffect(() => {
    if (!panel.current) return;
    const releaseViewport = bindInspectorViewport(panel.current);
    const controller = bindInspectorMotion(panel.current, { onClose: () => close.current(), enabled: () => !overlayOpen.current, animateEntry: p.animateEntry });
    navigation.current = controller;
    return () => { controller.dispose(); navigation.current = null; releaseViewport(); };
  }, []);
  useEffect(() => { window.dispatchEvent(new Event("pocket-reading-visibility-change")); }, [infoOpen, renaming]);
  const runAction = async (action: () => Promise<unknown>) => {
    if (actionPending.current || p.thread.missing || managementBlocked) return;
    actionPending.current = true; setActionBusy(true); setError("");
    try { await action(); }
    catch (failure) { setError((failure as Error).message); }
    finally { actionPending.current = false; setActionBusy(false); }
  };
  const operationStatus = p.operation && <TaskOperationStatus operation={p.operation} error={p.operationError}
    onCheck={() => p.onCheckOperation(p.operation!.requestId)} onCancel={() => p.onCancelOperation(p.operation!.requestId)} />;
  return (
    <ImagePreviewProvider scope={p.thread.id}><aside className="inspector" aria-label="接续详情" ref={panel} tabIndex={-1} style={{ outline: "none" }}>
      <div className="inspector-header">
        <h2 className="inspector-title" title={p.thread.title}>
          <button type="button" className="inspector-title-trigger" aria-label={`会话信息：${p.thread.title}`}
            aria-haspopup="dialog" aria-expanded={infoOpen} onClick={() => { setError(""); setCopied(false); setInfoOpen(true); }}>
            <span>{p.thread.separator ? "分隔符会话" : p.thread.title}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </h2>
        <button data-inspector-close className="icon-button" aria-label="关闭详情" onClick={event => navigation.current?.close(event.detail !== 0)}>
          <ChevronLeft size={23} className="inspector-back-icon" />
          <X size={18} className="inspector-close-icon" />
        </button>
      </div>
      <div className="inspector-conversation">
        {!infoOpen && operationStatus}
        <Conversation key={p.thread.id} thread={p.thread} drafts={p.queryDrafts} submissions={p.submissions}
          historyCache={p.historyCache} onActivity={p.onActivity} managementBlocked={managementBlocked}
          managementHint={managementBlocked && p.operation ? operationText(p.operation) : undefined}
          onConnect={options => p.onOpen(p.thread, options)} onRestore={() => p.onArchive(p.thread, false)} />
      </div>
      {infoOpen && <Modal title="会话信息" onClose={() => setInfoOpen(false)} busy={actionBusy}>
        <div className="conversation-info">
          <p className="conversation-info-title">{p.thread.title}</p>
          <div className="thread-management-actions">
            <button type="button" className="secondary" disabled={actionBusy || p.thread.missing || p.thread.archived || managementBlocked}
              onClick={() => setRenaming(true)}><Pencil size={14} aria-hidden="true" />重命名</button>
            <button type="button" className="secondary" disabled={actionBusy || p.thread.missing || managementBlocked}
              onClick={() => void runAction(() => p.onArchive(p.thread, !p.thread.archived))}>
              <Archive size={14} aria-hidden="true" />{p.thread.archived ? "恢复会话" : "归档会话"}
            </button>
            {showMacOpen && <button type="button" className="secondary" disabled={actionBusy || p.thread.missing || managementBlocked}
              onClick={() => void runAction(async () => { await p.onOpen(p.thread); setInfoOpen(false); })}>在 Mac 打开<ArrowUpRight size={14} aria-hidden="true" /></button>}
          </div>
          {p.thread.missing ? <p className="field-help">会话暂不可用，请刷新。</p>
            : p.thread.archived ? <p className="field-help">会话已归档，恢复后可继续对话或重命名。</p> : null}
          {operationStatus}
          {p.operation?.code === "outbox_not_empty" && <button type="button" className="text-button" onClick={() => setInfoOpen(false)}>查看待发消息</button>}
          {error && <p className="inline-error" role="alert">{error}</p>}
          <dl className="conversation-info-details">
            <dt>来源项目</dt><dd>{p.thread.projectName === "无项目" ? "独立会话" : p.thread.projectName}</dd>
            <dt>工作目录</dt><dd>{p.thread.cwd}</dd>
            {p.thread.branch && <><dt><GitBranch size={12} aria-hidden="true" />分支</dt><dd>{p.thread.branch}</dd></>}
            <dt>创建时间</dt><dd>{new Date(p.thread.createdAt).toLocaleString("zh-CN")}</dd>
            <dt>会话 ID</dt><dd className="thread-id">{p.thread.id}</dd>
          </dl>
          <button type="button" className="text-button" onClick={async () => {
            try { await navigator.clipboard.writeText(`codex://threads/${p.thread.id}`); setCopied(true); }
            catch { setError("复制未完成，请选取上方的会话 ID"); }
          }}><Clipboard size={13} aria-hidden="true" /><span aria-live="polite">{copied ? "链接已复制" : "复制会话链接"}</span></button>
        </div>
      </Modal>}
      {renaming && <RenameThreadDialog thread={p.thread} onClose={() => setRenaming(false)}
        onSaved={thread => { p.onRenamed(thread); setRenaming(false); }} />}
    </aside></ImagePreviewProvider>
  );
}
