import AutoTextarea from "./AutoTextarea";
import ContextStatus from "./ContextStatus";
import RequestActions from "./RequestActions";
import StopExecution from "./StopExecution";
import TurnDuration from "./TurnDuration";
import QuestionPrompts from "./QuestionPrompts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowDown, RefreshCw, Send, LoaderCircle } from "lucide-react";
import { api } from "./api";
import type { Thread } from "./types";
import ConversationMessage from "./ConversationMessage";
import ProgressDisclosure from "./ProgressDisclosure";
import { useProgressMessages } from "./useProgressMessages";
import { rememberHistory, rememberTranscript, startConnectionFeed, startConversationFeed, startTranscriptFeed } from "./conversationFeed";
import type { History, HistoryCache, SavedTranscript, Message } from "./conversationFeed";
import { displayMessages } from "./transcript";
import { currentQuestions } from "./currentQuestions";
import Outbox from "./Outbox";
import { waitForSubmission, type SubmissionReceipt as Receipt } from "./submissionReceipt";
import { holdReload, useReloadGuard } from "./updateSafety";
import { connectionFailureHint, connectionFromHistory, isConnectionCompatibilityFailure, newerConnection } from "./threadConnection";
import type { ConnectOptions, OpenThreadResult, ThreadConnection } from "./threadConnection";
import { bindComposerConnectionIntent, createComposerConnectionIntent } from "./composerConnection";
import "./composer-connection.css";
import { displayedReadObservation, observeVisibleRead } from "./readObservation";
import type { ReadAttempts, ReadObservation, ReadReceipt } from "./readObservation";
import { createSubmissionFeedbackTracker } from "./submissionFeedback";
import type { AcceptedFeedback } from "./submissionFeedback";
import SubmittedQueryCards from "./SubmittedQueryCards";
import { createSubmittedQueryStore, submittedOutbox, visibleSubmittedQueries, withSubmittedAttachments, withSubmittedQueryPost } from "./submittedQueries";
import type { SubmittedQuery, SubmittedQueryStore, SubmittedQueryReceipt } from "./submittedQueries";
import { attachmentDraftController, attachmentRefs, hasDraftAttachments, MAX_ATTACHMENTS, readyAttachments, sameAttachments, type DraftAttachment } from "./attachments";
import { AttachmentPicker, DraftAttachmentList } from "./AttachmentList";
import { useReadingComposer } from "./useReadingComposer";
import "./reading-composer.css";
import { receiptHandoffs } from "./receiptMotion";
import { useReceiptEntrances } from "./useReceiptHandoff";
import { questionComposerPending, questionPresentationStore } from "./questionPresentation";
export type QueryDraft = {
  text: string; requestId?: string; revision?: number;
  attachments?: readonly DraftAttachment[];
  answerMode?: "options" | "custom"; customText?: string; optionText?: string;
};
const statuses: Record<string, string> = {
  active: "正在运行",
  idle: "可继续",
  systemError: "上次运行出错",
  unavailable: "未连接",
};
const routineDesktopHints = new Set([
  "消息会在 Mac 的原任务中运行，沿用原模型与权限。",
  "消息会在 Mac 的会话中运行，沿用原模型与权限。",
  "正在运行，新消息默认进入 Pocket 待发列表。",
]);
export default function Conversation({
  thread,
  drafts,
  historyCache,
  submissions: providedSubmissions,
  onConnect,
  onRestore,
  onActivity,
  managementBlocked = false,
  managementHint,
}: {
  thread: Thread;
  drafts: Map<string, QueryDraft>;
  historyCache: HistoryCache;
  submissions?: SubmittedQueryStore;
  onConnect: (options?: ConnectOptions) => Promise<OpenThreadResult>;
  onRestore?: () => Promise<void>;
  onActivity?: () => void;
  managementBlocked?: boolean;
  managementHint?: string;
}) {
  const [localSubmissions] = useState(createSubmittedQueryStore);
  const submissions = providedSubmissions ?? localSubmissions;
  const submitted = useSyncExternalStore(submissions.subscribe, () => submissions.getThread(thread.id), () => submissions.getThread(thread.id));
  const [uploads] = useState(() => attachmentDraftController(drafts));
  const subscribeAttachments = useCallback((listener: () => void) => uploads.subscribe(thread.id, listener), [uploads, thread.id]);
  const attachments = useSyncExternalStore(subscribeAttachments, () => uploads.get(thread.id), () => uploads.get(thread.id));
  const [attachmentError, setAttachmentError] = useState("");
  const [attachmentRecoveryNeeded, setAttachmentRecoveryNeeded] = useState(false);
  const [history, setHistory] = useState<History | null>(() => historyCache.get(thread.id)?.history ?? null),
    [transcript, setTranscript] = useState<SavedTranscript | null>(() => historyCache.get(thread.id)?.transcript ?? null),
    [freshTranscript, setFreshTranscript] = useState<SavedTranscript | null>(null),
    [readFeedback, setReadFeedback] = useState<{ version: string; status: ReadReceipt["status"] } | null>(null),
    [readRetry, setReadRetry] = useState(0),
    [retryingRead, setRetryingRead] = useState(false),
    [loading, setLoading] = useState(true),
    [draft, setDraft] = useState<QueryDraft>(
      () => drafts.get(thread.id) || { text: "" },
    ),
    [sending, setSending] = useState(false),
    [restoring, setRestoring] = useState(false),
    [opening, setOpening] = useState(false),
    [connection, setConnection] = useState<ThreadConnection>(() => historyCache.get(thread.id)?.history?.connection ?? { status: "idle" }),
    [connectionError, setConnectionError] = useState(""),
    [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false),
    [error, setError] = useState(""),
    [historyError, setHistoryError] = useState(""),
    [notice, setNotice] = useState(""),
    [awayFromLatest, setAwayFromLatest] = useState(() => historyCache.get(thread.id)?.nearBottom === false),
    [hasNewContent, setHasNewContent] = useState(false);
  const [feedbackTracker] = useState(createSubmissionFeedbackTracker);
  const [recentAccepted, setRecentAccepted] = useState(new Map<string, number>());
  const showAcceptedFeedback = useCallback((feedback: AcceptedFeedback) => {
    setRecentAccepted(previous => new Map(previous).set(feedback.requestId, feedback.expiresAt));
    setNotice(previous => /^(已加入|消息已交给|已在(?:原任务|会话)历史)/.test(previous) ? "" : previous);
  }, []);
  const confirmAccepted = useCallback((receipt: Receipt, source: AcceptedFeedback["source"] = "composer") => {
    const feedback = feedbackTracker.accept(receipt, source);
    if (feedback) showAcceptedFeedback(feedback);
  }, [feedbackTracker, showAcceptedFeedback]);
  useEffect(() => {
    if (!recentAccepted.size) return;
    const timer = setTimeout(() => setRecentAccepted(current => new Map([...current].filter(([, expiresAt]) => expiresAt > Date.now()))),
      Math.max(0, Math.min(...recentAccepted.values()) - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [recentAccepted]);
  const messages = useRef<HTMLDivElement>(null),
    conversationRoot = useRef<HTMLElement>(null),
    readSentinel = useRef<HTMLDivElement>(null),
    attemptedReads = useRef<ReadAttempts>(new Map()),
    latestReadObservation = useRef<ReadObservation | null>(null),
    manualReadRetry = useRef<string | null>(null),
    readViewGeneration = useRef(0),
    nearBottom = useRef(historyCache.get(thread.id)?.nearBottom ?? true),
    restoreScroll = useRef<number | null>(historyCache.get(thread.id)?.scrollTop ?? null),
    previousLatest = useRef<{ id: string; text: string } | null>(null),
    feed = useRef<ReturnType<typeof startConversationFeed> | null>(null),
    textFeed = useRef<ReturnType<typeof startTranscriptFeed> | null>(null);
  const shownMessages = useMemo(() => displayMessages(
    history ? { ...history, messages: withSubmittedAttachments(history.messages, submitted) } : null,
    transcript ? { ...transcript, messages: withSubmittedAttachments(transcript.messages, submitted) } : null,
  ), [history, transcript, submitted]);
  const toolbarTiming = history?.turnTiming && history.runtime !== "active" && history.turnTiming.status !== "inProgress" && history.turnTiming.turnId &&
    shownMessages.some(message => message.role === "assistant" && message.turnId === history.turnTiming!.turnId &&
      ["final", "final_answer"].includes(message.phase || "") && message.turnDurationMs != null) ? null : history?.turnTiming;
  const shownOutbox = useMemo(() => submittedOutbox(submitted, shownMessages, history?.outbox ?? []), [submitted, shownMessages, history?.outbox]);
  const visibleSubmissions = useMemo(() => visibleSubmittedQueries(submitted, shownMessages, shownOutbox), [submitted, shownMessages, shownOutbox]);
  const handoffs = useMemo(() => receiptHandoffs(submitted, shownMessages, shownOutbox), [submitted, shownMessages, shownOutbox]);
  const submissionIds = useMemo(() => visibleSubmissions.map(item => item.requestId), [visibleSubmissions]);
  const queueIds = useMemo(() => shownOutbox.map(item => item.id), [shownOutbox]);
  useReceiptEntrances(conversationRoot, submissionIds, queueIds, handoffs.messageIds);
  useLayoutEffect(() => { submissions.observeQueue(thread.id, history?.outbox ?? []); }, [submissions, thread.id, history?.outbox]);
  useEffect(() => { submissions.observeMessages(thread.id, shownMessages); }, [submissions, thread.id, shownMessages, submitted]);
  const questions = useMemo(() => currentQuestions(history, transcript), [history, transcript]);
  const [questionStore] = useState(questionPresentationStore);
  const readQuestionPending = useCallback(() => questionComposerPending(questionStore, thread.id, questions, drafts), [questionStore, thread.id, questions, drafts]);
  const hasPendingQuestions = useSyncExternalStore(questionStore.subscribe, readQuestionPending, readQuestionPending);
  const questionsByMessage = useMemo(() => {
    const groups = new Map<string, typeof questions>();
    for (const question of questions) groups.set(question.sourceMessageId, [...(groups.get(question.sourceMessageId) ?? []), question]);
    return groups;
  }, [questions]);
  const protectedProgressIds = useMemo(() => new Set(questionsByMessage.keys()), [questionsByMessage]);
  const progress = useProgressMessages({ messages: shownMessages, protectedIds: protectedProgressIds,
    root: messages, nearBottom, away: awayFromLatest, cache: historyCache, threadId: thread.id,
    onPosition: atBottom => { setAwayFromLatest(!atBottom); if (atBottom) setHasNewContent(false); } });
  const [expandedQueries, setExpandedQueries] = useState(() => new Set(historyCache.get(thread.id)?.expandedQueries ?? []));
  const toggleQuery = (message: Message, open: boolean, anchor: HTMLElement) => {
    const key = message.clientMessageId || message.id;
    progress.changeLayout(anchor, () => setExpandedQueries(current => {
      const visible = new Set(shownMessages.filter(item => item.role === "user").map(item => item.clientMessageId || item.id));
      const next = new Set([...current].filter(id => visible.has(id)));
      if (open) next.add(key); else next.delete(key);
      return next;
    }));
  };
  useLayoutEffect(() => {
    const saved = historyCache.get(thread.id);
    if (saved) saved.expandedQueries = [...expandedQueries];
  }, [historyCache, thread.id, expandedQueries]);
  const unplacedQuestions = useMemo(() => questions.filter(question => !shownMessages.some(message => message.id === question.sourceMessageId)), [questions, shownMessages]);
  // If the native question arrives before its source message, still offer it
  // inline but wait for matching visible text before marking the task as read.
  const readObservation = useMemo(() => unplacedQuestions.length ? null : displayedReadObservation(freshTranscript, shownMessages), [freshTranscript, shownMessages, unplacedQuestions]);
  const readVersion = readObservation?.visibleVersion, readItemId = readObservation?.lastVisibleItemId;
  useLayoutEffect(() => { latestReadObservation.current = readObservation; }, [readObservation]);
  const currentReadFeedback = thread.hasUnreadTurn !== false && readFeedback &&
    (!readObservation || readFeedback.version === readObservation.visibleVersion) ? readFeedback : null;
  const observedConnection = connectionFromHistory(connection, history);
  const connecting = opening || observedConnection.status === "connecting";
  useReloadGuard(() => sending || connecting || restoring ? "操作尚未完成，请稍后更新。"
    : draft.text || draft.requestId || attachments.length ? "还有未发送或待核对的消息，请处理后再更新。" : submissions.reloadBlocker());
  const updateDraft = useCallback(
    (next: QueryDraft, preserveAttachments = true) => {
      const files = preserveAttachments ? uploads.get(thread.id) : next.attachments;
      const value = { ...next, attachments: files?.length ? files : undefined };
      setDraft(value);
      if (value.text || value.requestId || hasDraftAttachments(value)) drafts.set(thread.id, value);
      else drafts.delete(thread.id);
      uploads.notify(thread.id);
    },
    [drafts, thread.id, uploads],
  );
  const addFiles = (files: File[]) => {
    try { uploads.add(thread.id, files); setAttachmentError(""); void inputConnection.current?.request(); }
    catch (failure) { setAttachmentError((failure as Error).message); }
  };
  const recoverAttachments = async () => {
    try { await uploads.recover(thread.id); setAttachmentError(""); setAttachmentRecoveryNeeded(false); }
    catch (failure) { setAttachmentError((failure as Error).message); setAttachmentRecoveryNeeded(true); }
  };
  const load = useCallback(async () => { await Promise.all([feed.current?.refresh(), textFeed.current?.refresh()]); }, []);
  const returnToLatest = useCallback(() => {
    nearBottom.current = true;
    setAwayFromLatest(false);
    setHasNewContent(false);
    const element = messages.current;
    if (element) {
      element.focus({ preventScroll: true });
      element.scrollTop = element.scrollHeight;
    }
  }, []);
  const receiptRead = useRef<AbortController | null>(null);
  const checkingSubmissions = useRef(new Map<string, AbortController>());
  const connectionOpen = useRef<AbortController | null>(null);
  const restorePending = useRef(false);
  const inputConnection = useRef<ReturnType<typeof createComposerConnectionIntent> | null>(null);
  useEffect(() => () => receiptRead.current?.abort(), [thread.id]);
  useEffect(() => () => { checkingSubmissions.current.forEach(controller => controller.abort()); checkingSubmissions.current.clear(); }, [thread.id]);
  useEffect(() => () => connectionOpen.current?.abort(), [thread.id]);
  useEffect(() => () => { readViewGeneration.current++; }, [thread.id]);
  useEffect(() => {
    const observation = latestReadObservation.current;
    const root = messages.current;
    const target = readSentinel.current;
    if (!observation || !root || !target) return;
    return observeVisibleRead({
      root, target, observation, getObservation: () => progress.canObserve() ? latestReadObservation.current : null, attempted: attemptedReads.current,
      submit: (input, signal) => api<ReadReceipt>(`/api/tasks/${thread.id}/read`, "POST", input,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) }),
      onRead: onActivity,
      onResult(result) {
        if (result.status === "read") setReadFeedback(null);
        else {
          setReadFeedback({ version: observation.visibleVersion, status: result.status });
          if (result.status === "stale") void textFeed.current?.refresh();
        }
      },
    });
  }, [thread.id, readVersion, readItemId, readRetry, onActivity, progress.canObserve]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  const targetAvailable = !thread.archived && !thread.missing && !managementBlocked;
  useEffect(() => {
    if (!targetAvailable) return;
    const recover = () => { void uploads.recover(thread.id).catch(failure => {
      setAttachmentError(failure?.message || "暂时无法载入已上传附件，请重试。"); setAttachmentRecoveryNeeded(true);
    }); };
    recover(); window.addEventListener("online", recover);
    return () => window.removeEventListener("online", recover);
  }, [uploads, thread.id, targetAvailable]);
  const canQueue = targetAvailable && history?.canQueue !== false;
  const connectionFailureCode = observedConnection.status === "failed" ? observedConnection.code : undefined;
  const compatibilityCode = isConnectionCompatibilityFailure(history?.readOnlyReason) ? history?.readOnlyReason
    : isConnectionCompatibilityFailure(connectionFailureCode) ? connectionFailureCode : undefined;
  const canAttemptSend = targetAvailable && !compatibilityCode && !!(history?.canAttemptSend ?? history?.canSend);
  const staleConnection = observedConnection.status === "connected" && history?.source !== "desktop" && (history?.checkedAt ?? 0) > observedConnection.checkedAt;
  const showConnectionState = targetAvailable &&
    (history?.source !== "desktop" || connecting || observedConnection.status === "failed" || !!connectionError);
  const desktopHint = history?.source === "desktop" && history.canSend && routineDesktopHints.has(history.hint) ? undefined
    : history?.hint?.replaceAll("原任务", "会话").replaceAll("原会话", "会话");
  const connectionHint = managementHint || (thread.archived ? "会话已归档，恢复后可继续。"
    : !targetAvailable ? "会话暂不可用" : history?.source === "desktop" ? desktopHint : undefined);
  const connectionFailed = !!connectionError || staleConnection || observedConnection.status === "failed";
  const connectionLabel = !online ? "离线" : connecting ? "连接中…"
    : compatibilityCode ? connectionFailureHint(compatibilityCode)
    : connectionFailed ? connectionFailureHint(connectionFailureCode)
    : observedConnection.status === "connected" ? "同步中…" : "未连接";
  // Queue storage only needs the Mac API; a stale desktop read is not a reason
  // to reject the user's next instruction. Dispatch still checks fresh state.
  const enqueue = !!compatibilityCode || history?.runtime === "active" || !!history?.outbox?.length || !history?.canSend || !!historyError;
  const sendAndConnect = !compatibilityCode && enqueue && history?.runtime !== "active" && !history?.outbox?.length && history?.source !== "desktop";
  const composer = useReadingComposer({ hasContent: shownMessages.length > 0, hasDraft: draft.text.length > 0,
    hasAttachments: attachments.length > 0 || !!attachmentError || attachmentRecoveryNeeded,
    pending: sending || connecting || !!draft.requestId || shownOutbox.length > 0 || visibleSubmissions.length > 0 ||
      !!history?.pendingRequests?.length || hasPendingQuestions,
    feedback: !!(error || historyError || connectionError || connectionFailed || compatibilityCode || notice || currentReadFeedback) });
  const checkSubmissionReceipt = useCallback(async (requestId: string) => {
    if (checkingSubmissions.current.has(requestId)) return;
    const controller = new AbortController();
    checkingSubmissions.current.set(requestId, controller);
    try {
      const receipt = await api<SubmittedQueryReceipt>(`/api/tasks/${thread.id}/messages/${requestId}`, "GET", undefined,
        { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      if (receipt.requestId !== requestId) throw new Error("回执与这条消息不匹配，请重新核对。");
      // The shared store knows whether the original POST is still in flight,
      // even if this view has changed or several checks returned not_found.
      submissions.receipt(thread.id, receipt);
      if (!controller.signal.aborted && receipt.status === "accepted") {
        confirmAccepted({ requestId, status: "accepted" }); onActivity?.();
      }
    } finally { if (checkingSubmissions.current.get(requestId) === controller) checkingSubmissions.current.delete(requestId); }
  }, [thread.id, submissions, confirmAccepted, onActivity]);
  const checkSubmitted = async (item: SubmittedQuery) => {
    if (!["accepted", "not_queued"].includes(item.status)) await checkSubmissionReceipt(item.requestId);
    await load();
  };
  const restoreSubmitted = async (item: SubmittedQuery) => {
    if (!["rejected", "not_found"].includes(item.status)) return;
    const generation = readViewGeneration.current;
    const value = await uploads.restoreDraft(thread.id, item, () => generation === readViewGeneration.current);
    setDraft(value);
    submissions.dismiss(thread.id, item.requestId); setAttachmentError("");
  };
  const connectingId = observedConnection.status === "connecting" ? observedConnection.requestId : null;
  useEffect(() => {
    if (!connectingId || managementBlocked) return;
    const subscription = startConnectionFeed({
      request: signal => api<ThreadConnection>(`/api/tasks/${thread.id}/connection`, "GET", undefined, { signal }),
      onData(data) {
        setConnectionError("");
        setConnection(previous => data.status === "idle" && previous.status === "connecting" && previous.requestId === connectingId
          ? { ...previous, status: "failed", checkedAt: Date.now(), code: "connection_unknown" }
          : newerConnection(previous, data));
        if (data.status !== "connecting") void load();
      },
      onError() { setConnectionError("连接状态待确认"); },
    });
    return () => subscription.stop();
  }, [thread.id, connectingId, load, managementBlocked]);
  useEffect(() => {
    const subscription = startTranscriptFeed({
      request: signal => api<SavedTranscript>(`/api/tasks/${thread.id}/transcript`, "GET", undefined, { signal }),
      onData(data) {
        rememberTranscript(historyCache, thread.id, data);
        setTranscript(data);
        const observation = data.readObservation;
        if (observation) {
          const previous = attemptedReads.current.get(observation.visibleVersion);
          if (manualReadRetry.current === observation.visibleVersion) {
            manualReadRetry.current = null;
            attemptedReads.current.delete(observation.visibleVersion);
            setReadRetry(value => value + 1);
          } else if (previous?.status === "stale" && previous.token !== observation.token) {
            // Stale means definitely not written. A fresh token can be used even
            // when only a completion event changed, leaving visible text intact.
            setReadRetry(value => value + 1);
          }
        }
        setFreshTranscript(data);
      },
      onError() { /* Keep readable content and let the native feed report connection state. */ },
    });
    textFeed.current = subscription;
    return () => { subscription.stop(); if (textFeed.current === subscription) textFeed.current = null; };
  }, [thread.id, historyCache]);
  useEffect(() => {
    if (managementBlocked) { setLoading(false); return; }
    const subscription = startConversationFeed({
      request: (signal) => api<History>(`/api/tasks/${thread.id}/history`, "GET", undefined, { signal }),
      onData(data) {
        feedbackTracker.observeHistory(data).forEach(showAcceptedFeedback);
        const cancelledRequests = new Set(submissions.getThread(thread.id).filter(item => item.status === "cancelled").map(item => item.requestId));
        uploads.claim(thread.id, [...(data.outbox ?? []).filter(item => !cancelledRequests.has(item.id)).flatMap(item => item.attachments?.map(file => file.id) ?? []), ...data.messages.flatMap(message => message.attachments?.map(file => file.id) ?? [])]);
        const queueChecks = new Set(submissions.observeQueue(thread.id, data.outbox ?? []));
        if (data.source === "desktop") for (const message of data.messages) {
          if (message.role === "user" && message.clientMessageId) submissions.receipt(thread.id, { requestId: message.clientMessageId, status: "accepted" });
        }
        const queuedIds = new Set((data.outbox ?? []).map(item => item.id));
        for (const entry of submissions.getThread(thread.id)) {
          if (!entry.echoed && !entry.dismissed && (queueChecks.has(entry.requestId) || (!queuedIds.has(entry.requestId) && ["pending", "queued"].includes(entry.status))))
            void checkSubmissionReceipt(entry.requestId).catch(() => {});
        }
        rememberHistory(historyCache, thread.id, data);
        setHistory(data);
        setConnection(previous => connectionFromHistory(newerConnection(previous, data.connection), data));
        if (data.source === "desktop" && data.resumeState === "resumed") setConnectionError("");
        setHistoryError("");
        setLoading(false);
        const saved = drafts.get(thread.id);
        if (
          saved?.requestId && data.source === "desktop" &&
          data.messages.some((m) => m.role === "user" && m.clientMessageId === saved.requestId && !m.truncated && m.text.trim() === saved.text.trim()
            && sameAttachments(attachmentRefs(saved.attachments ?? []), m.attachments))
        ) {
          updateDraft({ text: "" }, false);
          if (data.source === "desktop" && data.messages.some(message => message.role === "user" && message.clientMessageId === saved.requestId)) {
            confirmAccepted({ requestId: saved.requestId, status: "accepted" });
            setNotice("");
          } else setNotice("已在会话历史中确认这条消息。");
        }
      },
      onError(error) {
        setHistoryError(error.message === "Failed to fetch" ? "连接暂时中断，正在自动重试。" : error.message);
        setLoading(false);
      },
    });
    feed.current = subscription;
    return () => {
      subscription.stop();
      if (feed.current === subscription) feed.current = null;
    };
  }, [thread.id, drafts, historyCache, updateDraft, managementBlocked, feedbackTracker, showAcceptedFeedback, confirmAccepted, submissions, checkSubmissionReceipt, uploads]);
  useLayoutEffect(() => {
    const element = messages.current;
    if (!element) return;
    const latest = shownMessages.at(-1), previous = previousLatest.current;
    if (nearBottom.current && !progress.readingProtected()) {
      element.scrollTop = element.scrollHeight;
      setAwayFromLatest(false);
      setHasNewContent(false);
    } else {
      if (restoreScroll.current !== null) element.scrollTop = restoreScroll.current;
      if (latest && previous && (latest.id !== previous.id || latest.text !== previous.text)) setHasNewContent(true);
    }
    previousLatest.current = latest ? { id: latest.id, text: latest.text } : null;
    restoreScroll.current = null;
  }, [shownMessages, visibleSubmissions, progress.entries, progress.readingProtected]);
  useLayoutEffect(() => {
    const element = messages.current;
    if (!element) return;
    // Composer growth and the software keyboard resize the reading area even
    // when no message changes. Follow only while the reader is already at bottom.
    const observer = new ResizeObserver(() => {
      if (nearBottom.current && !progress.readingProtected()) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [progress.readingProtected]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (draft.text || uploads.get(thread.id).length || submissions.reloadBlocker()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft.text, submissions, uploads, thread.id]);
  useEffect(() => {
    if (!/^(消息已交给|已加入(?: Mac )?待发|已在(?:原任务|会话)历史|当前执行已中断|这一轮已经结束)/.test(notice)) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const receive = (receipt: Receipt) => {
    submissions.receipt(thread.id, receipt);
    if (receipt.status === "accepted" || receipt.status === "queued") {
      if (receipt.status === "accepted") { onActivity?.(); confirmAccepted(receipt); }
      else feedbackTracker.trackQueued(receipt.requestId);
      setNotice(receipt.status === "queued" && !feedbackTracker.hasAccepted(receipt.requestId)
        ? history?.source === "desktop" ? "已加入待发列表，当前轮完成后发送。" : "已加入待发列表，连接后发送。" : "");
      nearBottom.current = true;
    } else if (
      receipt.status === "rejected" ||
      receipt.status === "not_found"
    ) {
      setError(
        receipt.status === "not_found"
          ? "未收到这次提交，可以重新发送。"
          : receipt.code === "desktop_preflight_timeout" ? "连接超时，这次没有发送，可以重试。"
          : "会话暂时无法接收消息，请稍后重试。",
      );
    } else setNotice("发送结果尚未确认。先刷新历史；核对状态不会重复发送。");
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending || (!draft.requestId && ((!draft.text.trim() && !attachments.length) || !readyAttachments(attachments)))) return;
    const release = holdReload();
    setSending(true);
    setError("");
    setNotice("");
    const controller = new AbortController();
    const requestId = draft.requestId || crypto.randomUUID();
    const submittedText = draft.text;
    const submittedAttachments = attachmentRefs(attachments);
    receiptRead.current = controller;
    nearBottom.current = true;
    // Capture before clearing the composer. Every later receipt updates this
    // request's immutable snapshot, never whatever the user is typing next.
    submissions.seed({ threadId: thread.id, requestId, text: submittedText,
      attachments: submittedAttachments, status: draft.requestId ? "unknown" : sendAndConnect ? "connecting" : "submitting" });
    uploads.claim(thread.id, submittedAttachments.map(item => item.id));
    updateDraft({ text: "" }, false); setAttachmentError("");
    const ownsView = () => !controller.signal.aborted && receiptRead.current === controller;
    try {
      let receipt: Receipt;
      if (draft.requestId) {
        receipt = await api<Receipt>(
            `/api/tasks/${thread.id}/messages/${requestId}`,
          );
      } else {
        receipt = await withSubmittedQueryPost(submissions, thread.id, requestId, () => api<Receipt>(`/api/tasks/${thread.id}/messages`, "POST", {
            text: submittedText,
            requestId,
            ...(submittedAttachments.length ? { attachments: submittedAttachments.map(item => item.id) } : {}),
            ...(enqueue ? { enqueue: true } : {}),
          }));
      }
      if (receipt.requestId !== requestId) throw new Error("回执与当前消息不匹配，请重新核对。");
      submissions.receipt(thread.id, receipt);
      if (!ownsView()) return;
      if (receipt.status === "pending") setNotice("Pocket 已收到，正在确认…");
      const confirmed = await waitForSubmission(receipt, signal => api<Receipt>(`/api/tasks/${thread.id}/messages/${requestId}`, "GET", undefined, { signal }), controller.signal);
      submissions.receipt(thread.id, confirmed);
      if (!ownsView()) return;
      receive(confirmed);
      void load();
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      submissions.receipt(thread.id, { requestId, status: status && status < 500 ? "rejected" : "unknown" });
      if (!ownsView()) return;
      if (status && status < 500) {
        setError((e as Error).message);
      } else
        setNotice("连接中断，发送结果尚未确认。请核对状态，避免重复提交。");
    } finally {
      release();
      if (receiptRead.current === controller) {
        receiptRead.current = null;
        if (!controller.signal.aborted) setSending(false);
      }
    }
  };
  const connect = async () => {
    if (connecting || connectionOpen.current || !online || !targetAvailable || compatibilityCode) return;
    const controller = new AbortController();
    connectionOpen.current = controller;
    setOpening(true);
    setError("");
    setConnectionError("");
    const ownsView = () => !controller.signal.aborted && connectionOpen.current === controller;
    try {
      const result = await onConnect({ quiet: true });
      if (!ownsView()) return;
      if (result.connection) setConnection(previous => newerConnection(previous, result.connection));
      else setConnectionError("连接状态待确认");
      void load();
    } catch (error) {
      if (ownsView()) setConnectionError("连接失败");
    } finally {
      if (ownsView()) { connectionOpen.current = null; setOpening(false); }
    }
  };
  const restore = async () => {
    if (!onRestore || !thread.archived || thread.missing || managementBlocked || restorePending.current || sending || !online || draft.requestId) return;
    restorePending.current = true;
    const generation = readViewGeneration.current;
    const release = holdReload();
    setRestoring(true); setError("");
    try { await onRestore(); }
    catch (failure) { if (generation === readViewGeneration.current) setError((failure as Error).message || "恢复未完成，请重试。"); }
    finally { restorePending.current = false; release(); if (generation === readViewGeneration.current) setRestoring(false); }
  };
  const preconnectBlocked = !!thread.sourceExcluded || thread.separator || !!draft.requestId || sending || restoring || !!compatibilityCode || history?.canAttemptSend === false || !!history?.pendingRequests?.length ||
    !!history?.compaction?.active || !!history?.queuePaused ||
    ["pending", "accepted", "unknown"].includes(history?.compactionRequest?.status ?? "") ||
    ["pending", "accepted", "unknown"].includes(history?.stopRequest?.status ?? "") ||
    shownOutbox.some(item => ["pending", "unknown"].includes(item.status)) ||
    visibleSubmissions.some(item => ["pending", "submitting", "connecting", "unknown"].includes(item.status));
  const hasComposerContent = !!draft.text.trim() || attachments.length > 0;
  const restoreOnlyAction = thread.archived && !!onRestore && !draft.requestId;
  const retryConnection = showConnectionState && connectionFailed && !compatibilityCode && !hasComposerContent && !draft.requestId && !preconnectBlocked;
  const connectionOnlyAction = !hasComposerContent && !draft.requestId && (retryConnection || connecting);
  const connectionContext = useRef<{ connect: () => Promise<void>; available: () => boolean }>({ connect, available: () => false });
  connectionContext.current = { connect, available: () => online && targetAvailable && !preconnectBlocked && !connecting &&
    (history?.source !== "desktop" || !!historyError) && (observedConnection.status !== "connected" || staleConnection) &&
    document.visibilityState !== "hidden" && !!composer.ref.current?.isConnected &&
    !composer.ref.current.closest('[inert], [aria-hidden="true"]') && !document.querySelector("[data-reading-overlay]") };
  useEffect(() => {
    const form = composer.ref.current;
    if (!form) return;
    const controller = createComposerConnectionIntent({ available: () => connectionContext.current.available(), connect: () => connectionContext.current.connect() });
    inputConnection.current = controller;
    const unbind = bindComposerConnectionIntent(form, () => { void controller.request(); });
    return () => { unbind(); controller.dispose(); if (inputConnection.current === controller) inputConnection.current = null; };
  }, [thread.id]);
  const retryRead = async () => {
    if (retryingRead) return;
    const generation = readViewGeneration.current;
    manualReadRetry.current = readObservation?.visibleVersion ?? currentReadFeedback?.version ?? null;
    setRetryingRead(true);
    try {
      await textFeed.current?.refresh();
    } finally {
      if (generation === readViewGeneration.current) {
        manualReadRetry.current = null;
        setRetryingRead(false);
        // A lost HTTP reply may follow a successful native write. A fresh
        // transcript then has no token, so refresh the authoritative catalog too.
        onActivity?.();
      }
    }
  };
  return (
    <section ref={conversationRoot} className="conversation" aria-label="会话历史与发送">
      <div className="conversation-toolbar">
        <div className="conversation-overview">
        <div className="runtime-summary">
        {(!showConnectionState || composer.compact) && <span className={!loading && !historyError && !history?.pendingRequests?.length && history?.runtime === "active" ? "runtime-active" : ""}>
          {connecting ? "连接中…" : observedConnection.status === "failed" && history?.source !== "desktop" ? "未连接" : loading
            ? shownMessages.length ? "正在同步状态…" : "正在读取历史…"
            : historyError ? "未连接" : history?.pendingRequests?.length ? "等待确认" : history?.latestTurnStatus === "interrupted" && history?.runtime === "idle" ? "已中断" : statuses[history?.runtime || ""] || "会话状态"}
        </span>}
          <TurnDuration timing={toolbarTiming} live={!loading && !historyError && history?.source === "desktop" && history.runtime === "active"} />
        </div>
          <ContextStatus threadId={thread.id} history={compatibilityCode && history ? { ...history, canCompact: false, canAttemptCompact: false } : history} disabled={!online || thread.archived || thread.missing || managementBlocked} refresh={load} />
        </div>
        <div className="conversation-controls">
          <StopExecution threadId={thread.id} history={history} disabled={loading || !!historyError || thread.archived || thread.missing || managementBlocked} refresh={load} notify={setNotice} />
          <button
            className="icon-button"
            aria-label="刷新会话历史"
            onClick={() => void load()}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      <div className="conversation-feed">
      <div
        className="conversation-messages"
        role="region"
        aria-label="会话正文"
        tabIndex={0}
        ref={messages}
        onScroll={() => {
          const el = messages.current;
          if (el) {
            nearBottom.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 100;
            setAwayFromLatest(!nearBottom.current);
            if (nearBottom.current) setHasNewContent(false);
            const cached = historyCache.get(thread.id);
            if (cached) {
              cached.scrollTop = el.scrollTop;
              cached.nearBottom = nearBottom.current;
            }
          }
        }}
      >
        {(history?.hasMore || transcript?.hasMore) && (
          <p className="history-boundary">
            仅显示最近的对话
          </p>
        )}
        {!loading && !historyError && !shownMessages.length && !visibleSubmissions.length && !shownOutbox.length && (
          <div className="history-empty conversation-empty">
            <h3>{targetAvailable ? "从一句话开始" : "暂时没有可显示的消息"}</h3>
            {targetAvailable && <p>写下你想讨论或完成的事。</p>}
          </div>
        )}
        {progress.entries.map(entry => {
          if (entry.type === "progress") return <ProgressDisclosure key={entry.id} id={entry.id} count={entry.messages.length}
            open={progress.expanded.has(entry.id)} onOpenChange={open => progress.toggle(entry.id, open)}>
            {entry.messages.map(message => <ConversationMessage key={message.id} message={message} />)}
          </ProgressDisclosure>;
          const message = entry.message;
          const messageQuestions = questionsByMessage.get(message.id);
          return messageQuestions?.length ? <QuestionPrompts key={message.id} threadId={thread.id} questions={messageQuestions} sourceText={message.text} sourceImages={message.images} sourceTruncated={message.truncated}
            disabled={loading || !!historyError || !targetAvailable || !history?.canSend} drafts={drafts} refresh={load} presentationStore={questionStore} />
            : <ConversationMessage key={message.id} message={message}
              queryDisclosure={message.role === "user" ? { expanded: expandedQueries.has(message.clientMessageId || message.id),
                toggle: (open, anchor) => toggleQuery(message, open, anchor) } : undefined}
              recentlySent={!!message.clientMessageId && (recentAccepted.get(message.clientMessageId) ?? 0) > Date.now()} />;
        })}
        {!!unplacedQuestions.length && <QuestionPrompts threadId={thread.id} questions={unplacedQuestions}
          disabled={loading || !!historyError || !targetAvailable || !history?.canSend} drafts={drafts} refresh={load} presentationStore={questionStore} />}
        <div ref={readSentinel} aria-hidden="true" style={{ height: 1 }} />
        <SubmittedQueryCards items={visibleSubmissions} exitIds={handoffs.submissions} explicitExitIds={handoffs.explicit} connecting={connecting || history?.source !== "desktop"} paused={!!history?.queuePaused}
          disabled={!online || managementBlocked} check={checkSubmitted} dismiss={requestId => submissions.dismiss(thread.id, requestId)} restore={restoreSubmitted} />
      </div>
      {awayFromLatest && <button type="button" className="conversation-latest" onClick={returnToLatest}>
        <ArrowDown size={14} aria-hidden="true" />
        {hasNewContent ? "有新内容 · 返回最新" : "返回最新消息"}
      </button>}
      </div>
      <div className="conversation-status">
        {connectionHint && <div className="conversation-connection">
        {connectionHint && <p role="status">{connectionHint}</p>}
        </div>}
        {(error || historyError || notice || currentReadFeedback) && <div className="conversation-feedback">
        {(error || historyError) && (
          <p className="inline-error" role="alert">
            {error || historyError}
          </p>
        )}
        {notice && (
          <p className={`message-notice${/^已加入(?: Mac )?待发/.test(notice) ? " queue-receipt-notice" : ""}`} role="status">
            {notice}
          </p>
        )}
        {currentReadFeedback && <p className="inline-hint" role="status">
          {currentReadFeedback.status === "stale" ? "进展已有更新，读取最新内容后再同步。" : currentReadFeedback.status === "unavailable" ? "暂时无法同步已读状态。" : "已读状态尚未确认。"}
          {" "}<button type="button" className="text-button" disabled={!online || retryingRead} onClick={() => void retryRead()}>{retryingRead ? "正在核对…" : "同步已读"}</button>
        </p>}
        </div>}
      </div>
      <RequestActions threadId={thread.id} requests={history?.pendingRequests ?? []} disabled={loading || !!historyError || thread.archived || thread.missing || managementBlocked} refresh={load} drafts={drafts} />
      <Outbox threadId={thread.id} items={shownOutbox} exitIds={handoffs.outbox} explicitExitIds={handoffs.explicit} paused={history?.queuePaused} disabled={!online || managementBlocked} allowSend={canAttemptSend} connectionPending={history?.source !== "desktop"} refresh={load} drafts={drafts} submissions={submissions} onActivity={onActivity}
        onAccepted={receipt => confirmAccepted(receipt, "queue")} onAttachmentRecovery={(recovered, error) => {
          setAttachmentError(error ?? ""); setAttachmentRecoveryNeeded(!!error);
          setNotice(error ? "待发消息已删除，附件可重新载入草稿。" : recovered ? "待发消息已删除，附件已放回草稿。" : "待发消息已删除。");
        }} />
      <form ref={composer.ref} className={`conversation-composer${composer.compact ? " is-compact" : ""}`}
        data-composer-state={composer.compact ? "compact" : "expanded"}
        onCompositionStart={composer.onCompositionStart} onCompositionEnd={composer.onCompositionEnd}
        onSubmit={(e) => void submit(e)}>
        <DraftAttachmentList threadId={thread.id} items={attachments} controller={uploads} disabled={!online || !targetAvailable || !!draft.requestId} error={attachmentError}
          localRemovalAllowed={targetAvailable && !draft.requestId}
          onRecover={attachmentRecoveryNeeded ? () => void recoverAttachments() : undefined} />
        <label className="sr-only" htmlFor="user-query">
          发送消息
        </label>
        <AutoTextarea
          id="user-query"
          aria-label="发送消息"
          rows={composer.compact ? 1 : 2}
          placeholder={composer.compact ? "继续对话…" : enqueue ? "写下下一步，稍后依次发送…" : "写下想法，继续这段对话…"}
          value={draft.text}
          maxLength={16000}
          onChange={(e) => updateDraft({ text: e.target.value })}
          onInput={(e) => updateDraft({ text: e.currentTarget.value })}
          onPaste={event => {
            const files = [...event.clipboardData.items].filter(item => item.kind === "file" && item.type.startsWith("image/")).flatMap(item => { const file = item.getAsFile(); return file ? [file] : []; });
            if (files.length) { event.preventDefault(); if (targetAvailable && !draft.requestId) addFiles(files); }
          }}
        />
        <div className="composer-actions">
          <AttachmentPicker disabled={!targetAvailable || !!draft.requestId || attachments.length >= MAX_ATTACHMENTS} onFiles={addFiles} onPickingChange={composer.setPicking} preserveFocus />
          {showConnectionState && <span className="composer-connection-state" data-failed={connectionFailed || !!compatibilityCode || undefined}>
            <span role="status">{connectionLabel}</span>
          </span>}
          <button
            className="primary"
            type={restoreOnlyAction || connectionOnlyAction ? "button" : "submit"}
            onClick={restoreOnlyAction ? () => { void restore(); } : retryConnection ? () => { void inputConnection.current?.request(true); } : undefined}
            disabled={
              restoreOnlyAction ? !online || thread.missing || managementBlocked || restoring || sending : connectionOnlyAction ? !online || connecting || preconnectBlocked : sending || restoring ||
              !online ||
              (!draft.requestId && (!hasComposerContent || !readyAttachments(attachments) ||
                (enqueue ? !canQueue : !targetAvailable || !history?.canSend)))
            }
          >
            {restoring || connectionOnlyAction && connecting ? <LoaderCircle size={15} className="composer-connection-spinner" aria-hidden="true" /> : restoreOnlyAction || connectionOnlyAction ? <RefreshCw size={15} aria-hidden="true" /> : <Send size={15} />}
            {restoreOnlyAction ? restoring ? "恢复中…" : "恢复会话" : connectionOnlyAction ? connecting ? "连接中…" : "重试连接" : sending ? "提交中…" : draft.requestId ? "核对发送状态" : managementBlocked ? "暂不可发送" : sendAndConnect ? "发送" : enqueue ? "加入队列" : "发送"}
          </button>
        </div>
      </form>
    </section>
  );
}
