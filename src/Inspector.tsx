import { AppIcon } from "./ui/AppIcon";
import { t, useLocale, formatDate } from "./i18n";
import { IconButton } from "./ui/IconButton";
import { Button } from "./ui/Button";
import { Archive, ArchiveRestore, ArrowUpRight, ChevronDown, ChevronLeft, Clipboard, GitBranch, Pencil, X } from "lucide-react";
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
import { focusInspectorEntry, inspectorEntryFromClick, type InspectorCloseOrigin, type InspectorEntryOrigin } from "./inspectorFocus";
import { currentMachineId, machineTaskUrl } from "./machineScope";
import ThreadModelSettings from "./ThreadModelSettings";
import ThreadAutomations from "./ThreadAutomations";
import UsageFeedback from "./UsageFeedback";
import type { ReadingCache } from "./readingCache";
import type { HoldTranscriptPrefetch, TranscriptRead } from "./transcriptReader";
import NetworkTitle from "./NetworkTitle";
import type { NativeListObservation } from "./listActivityCache";

interface Props {
  feedback?: { ready: boolean; enabled: boolean; open: (threadId?: string) => Promise<void> };
  queryDrafts: Map<string, QueryDraft>;
  submissions?: SubmittedQueryStore;
  historyCache: HistoryCache;
  readingCache?: ReadingCache | null;
  readingScope?: string;
  readTranscript?: TranscriptRead;
  holdPrefetch?: HoldTranscriptPrefetch;
  thread: Thread;
  onOpen: (t: Thread, options?: ConnectOptions) => Promise<OpenThreadResult>;
  operation?: TaskOperation;
  operationError?: string;
  onArchive: (thread: Thread, archived: boolean) => Promise<void>;
  onRenamed: (thread: Thread) => void;
  onCheckOperation: (requestId: string) => void;
  onCancelOperation: (requestId: string) => void;
  onClose: (origin: InspectorCloseOrigin) => void;
  onActivity?: () => void;
  onNativeListObservation?: NativeListObservation;
  animateEntry?: boolean;
  entryOrigin?: InspectorEntryOrigin;
}
export default function Inspector(p: Props) {
  useLocale();
  const panel = useRef<HTMLElement>(null);
  const close = useRef(p.onClose), overlayOpen = useRef(false), actionPending = useRef(false);
  const navigation = useRef<ReturnType<typeof bindInspectorMotion> | null>(null);
  const [infoOpen, setInfoOpen] = useState(false), [renaming, setRenaming] = useState(false);
  const [actionBusy, setActionBusy] = useState(false), [error, setError] = useState("");
  const [modelBusy, setModelBusy] = useState(false);
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
    const controller = bindInspectorMotion(panel.current, { onClose: origin => close.current(origin), enabled: () => !overlayOpen.current, animateEntry: p.animateEntry });
    navigation.current = controller;
    return () => { controller.dispose(); navigation.current = null; releaseViewport(); };
  }, []);
  useEffect(() => { window.dispatchEvent(new Event("pocket-reading-visibility-change")); }, [infoOpen, renaming]);
  const runAction = async (action: () => Promise<unknown>) => {
    if (actionPending.current || modelBusy || p.thread.missing || managementBlocked) return;
    actionPending.current = true; setActionBusy(true); setError("");
    try { await action(); }
    catch (failure) { setError((failure as Error).message); }
    finally { actionPending.current = false; setActionBusy(false); }
  };
  const operationStatus = p.operation && <TaskOperationStatus operation={p.operation} error={p.operationError}
    onCheck={() => p.onCheckOperation(p.operation!.requestId)} onCancel={() => p.onCancelOperation(p.operation!.requestId)} />;
  return (
    <ImagePreviewProvider scope={p.thread.id}><aside className="inspector" aria-label={t("接续详情")} ref={panel} tabIndex={-1} style={{ outline: "none" }}>
      <div className="inspector-header">
        <h2 className="inspector-title" title={p.thread.title}>
          <button type="button" className="inspector-title-trigger" aria-label={t("会话信息：{{value0}}", { value0: p.thread.title })}
            aria-haspopup="dialog" aria-expanded={infoOpen} onClick={() => { setError(""); setCopied(false); setInfoOpen(true); }}>
            <NetworkTitle machine={currentMachineId()} threadId={p.thread.id}>{p.thread.separator ? t("分隔符会话") : p.thread.title}</NetworkTitle>
            <AppIcon icon={ChevronDown} kind="auxiliary" aria-hidden="true" />
          </button>
        </h2>
        <IconButton type="button" data-inspector-close className="icon-button" aria-label={t("关闭详情")} onClick={event => navigation.current?.close(event.detail !== 0, inspectorEntryFromClick(event))}>
          <AppIcon icon={ChevronLeft} kind="navigation" className="inspector-back-icon" />
          <AppIcon icon={X} kind="action" className="inspector-close-icon" />
        </IconButton>
      </div>
      <div className="inspector-conversation">
        {!infoOpen && operationStatus}
        <Conversation key={p.thread.id} thread={p.thread} drafts={p.queryDrafts} submissions={p.submissions}
          historyCache={p.historyCache} onActivity={p.onActivity} managementBlocked={managementBlocked}
          readingCache={p.readingCache} readingScope={p.readingScope} readTranscript={p.readTranscript} holdPrefetch={p.holdPrefetch}
          onNativeListObservation={p.onNativeListObservation}
          managementHint={managementBlocked && p.operation ? operationText(p.operation) : undefined}
          onConnect={options => p.onOpen(p.thread, options)} onRestore={() => p.onArchive(p.thread, false)} />
      </div>
      {infoOpen && <Modal title={t("会话信息")} onClose={() => setInfoOpen(false)} busy={actionBusy || modelBusy} initialFocus="title">
        <div className="conversation-info">
          <p className="conversation-info-title">{p.thread.title}</p>
          <ThreadModelSettings thread={p.thread} disabled={actionBusy || managementBlocked}
            onConnect={() => p.onOpen(p.thread, { quiet: true })} onActivity={p.onActivity} onBusyChange={setModelBusy} />
          <div className="thread-management-actions">
            <Button variant="soft" color="gray" type="button" className="secondary" disabled={actionBusy || modelBusy || p.thread.missing || p.thread.archived || managementBlocked}
              onClick={() => setRenaming(true)}><AppIcon icon={Pencil} kind="auxiliary" aria-hidden="true" />{t("重命名")}</Button>
            <Button variant="soft" color="gray" type="button" className="secondary" disabled={actionBusy || modelBusy || p.thread.missing || managementBlocked}
              onClick={() => void runAction(() => p.onArchive(p.thread, !p.thread.archived))}>
              {p.thread.archived ? <AppIcon icon={ArchiveRestore} kind="auxiliary" aria-hidden="true" /> : <AppIcon icon={Archive} kind="auxiliary" aria-hidden="true" />}{p.thread.archived ? t("取消归档") : t("归档会话")}
            </Button>
            {showMacOpen && <Button variant="soft" color="gray" type="button" className="secondary" disabled={actionBusy || modelBusy || p.thread.missing || managementBlocked}
              onClick={() => void runAction(async () => { await p.onOpen(p.thread); setInfoOpen(false); })}>{t("在 Mac 打开")}<AppIcon icon={ArrowUpRight} kind="auxiliary" aria-hidden="true" /></Button>}
          </div>
          {p.thread.missing ? <p className="field-help">{t("会话暂不可用，请刷新。")}</p>
            : p.thread.archived ? <p className="field-help">{t("取消归档后可继续对话或重命名。")}</p> : null}
          {operationStatus}
          {p.operation?.code === "outbox_not_empty" && <button type="button" className="text-button" onClick={() => setInfoOpen(false)}>{t("查看待发消息")}</button>}
          {error && <p className="inline-error" role="alert">{t(error)}</p>}
          <ThreadAutomations thread={p.thread} />
          <UsageFeedback threadId={p.thread.id} pending={p.feedback && !p.feedback.ready}
            onStart={p.feedback?.enabled ? () => { setInfoOpen(false); void p.feedback!.open(p.thread.id); } : undefined} />
          <dl className="conversation-info-details">
            <dt>{t("来源项目")}</dt><dd>{p.thread.projectName === "无项目" ? t("独立会话") : p.thread.projectName}</dd>
            <dt>{t("工作目录")}</dt><dd>{p.thread.cwd}</dd>
            {p.thread.branch && <><dt><AppIcon icon={GitBranch} kind="auxiliary" aria-hidden="true" />{t("分支")}</dt><dd>{p.thread.branch}</dd></>}
            <dt>{t("创建时间")}</dt><dd>{formatDate(p.thread.createdAt)}</dd>
            <dt>{t("会话 ID")}</dt><dd className="thread-id">{p.thread.id}</dd>
          </dl>
          <button type="button" className="text-button" onClick={async () => {
            try { await navigator.clipboard.writeText(new URL(machineTaskUrl(p.thread.id), location.origin).href); setCopied(true); }
            catch { setError("复制未完成，请选取上方的会话 ID"); }
          }}><AppIcon icon={Clipboard} kind="auxiliary" aria-hidden="true" /><span aria-live="polite">{copied ? t("链接已复制") : t("复制会话链接")}</span></button>
        </div>
      </Modal>}
      {renaming && <RenameThreadDialog thread={p.thread} onClose={() => setRenaming(false)}
        onSaved={thread => { p.onRenamed(thread); setRenaming(false); }} />}
    </aside></ImagePreviewProvider>
  );
}
