import AutoTextarea from "./AutoTextarea";
import ContextStatus from "./ContextStatus";
import RequestActions from "./RequestActions";
import StopExecution from "./StopExecution";
import TurnDuration from "./TurnDuration";
import QuestionPrompts from "./QuestionPrompts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowDown, RefreshCw, Send, Link2 } from "lucide-react";
import { api } from "./api";
import type { Thread } from "./types";
import ConversationMessage from "./ConversationMessage";
import { rememberHistory, rememberTranscript, startConnectionFeed, startConversationFeed, startTranscriptFeed } from "./conversationFeed";
import type { History, HistoryCache, SavedTranscript } from "./conversationFeed";
import { displayMessages } from "./transcript";
import { currentQuestions } from "./currentQuestions";
import Outbox from "./Outbox";
import { waitForSubmission, type SubmissionReceipt as Receipt } from "./submissionReceipt";
import { holdReload, useReloadGuard } from "./updateSafety";
import { connectionFailureHint, connectionFromHistory, newerConnection } from "./threadConnection";
import type { OpenThreadResult, ThreadConnection } from "./threadConnection";
import { displayedReadObservation, observeVisibleRead } from "./readObservation";
import type { ReadAttempts, ReadObservation, ReadReceipt } from "./readObservation";
import { createSubmissionFeedbackTracker, SEND_FEEDBACK_EXIT_MS } from "./submissionFeedback";
import type { AcceptedFeedback } from "./submissionFeedback";
import SubmissionFeedbackNotice from "./SubmissionFeedbackNotice";
import SubmittedQueryCards from "./SubmittedQueryCards";
import { createSubmittedQueryStore, submittedOutbox, visibleSubmittedQueries, withSubmittedQueryPost } from "./submittedQueries";
import type { SubmittedQuery, SubmittedQueryStore, SubmittedQueryReceipt } from "./submittedQueries";
export type QueryDraft = {
  text: string; requestId?: string; revision?: number;
  answerMode?: "options" | "custom"; customText?: string; optionText?: string;
};
const statuses: Record<string, string> = {
  active: "正在运行",
  idle: "可继续",
  systemError: "上次运行出错",
  unavailable: "已保存的历史",
};
export default function Conversation({
  thread,
  drafts,
  historyCache,
  submissions: providedSubmissions,
  onConnect,
  onActivity,
  managementBlocked = false,
  managementHint,
}: {
  thread: Thread;
  drafts: Map<string, QueryDraft>;
  historyCache: HistoryCache;
  submissions?: SubmittedQueryStore;
  onConnect: () => Promise<OpenThreadResult>;
  onActivity?: () => void;
  managementBlocked?: boolean;
  managementHint?: string;
}) {
  const [localSubmissions] = useState(createSubmittedQueryStore);
  const submissions = providedSubmissions ?? localSubmissions;
  const submitted = useSyncExternalStore(submissions.subscribe, () => submissions.getThread(thread.id), () => submissions.getThread(thread.id));
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
  const [acceptedNotice, setAcceptedNotice] = useState<(AcceptedFeedback & { leaving?: boolean }) | null>(null);
  const [recentAccepted, setRecentAccepted] = useState(new Map<string, number>());
  const showAcceptedFeedback = useCallback((feedback: AcceptedFeedback) => {
    setRecentAccepted(previous => new Map(previous).set(feedback.requestId, feedback.expiresAt));
    setAcceptedNotice(feedback);
    setNotice(previous => /^(已加入|消息已交给|已在原任务历史)/.test(previous) ? "" : previous);
  }, []);
  const confirmAccepted = useCallback((receipt: Receipt, source: AcceptedFeedback["source"] = "composer") => {
    const feedback = feedbackTracker.accept(receipt, source);
    if (feedback) showAcceptedFeedback(feedback);
  }, [feedbackTracker, showAcceptedFeedback]);
  useEffect(() => {
    if (!acceptedNotice) return;
    const { requestId, expiresAt } = acceptedNotice;
    const remaining = Math.max(0, expiresAt - Date.now());
    const fade = setTimeout(() => setAcceptedNotice(current => current?.requestId === requestId ? { ...current, leaving: true } : current), remaining);
    const remove = setTimeout(() => setAcceptedNotice(current => current?.requestId === requestId ? null : current), remaining + SEND_FEEDBACK_EXIT_MS);
    return () => { clearTimeout(fade); clearTimeout(remove); };
  }, [acceptedNotice?.requestId, acceptedNotice?.expiresAt]);
  useEffect(() => {
    if (!recentAccepted.size) return;
    const timer = setTimeout(() => setRecentAccepted(current => new Map([...current].filter(([, expiresAt]) => expiresAt > Date.now()))),
      Math.max(0, Math.min(...recentAccepted.values()) - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [recentAccepted]);
  const messages = useRef<HTMLDivElement>(null),
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
  const shownMessages = useMemo(() => displayMessages(history, transcript), [history, transcript]);
  const shownOutbox = useMemo(() => submittedOutbox(submitted, shownMessages, history?.outbox ?? []), [submitted, shownMessages, history?.outbox]);
  const visibleSubmissions = useMemo(() => visibleSubmittedQueries(submitted, shownMessages, shownOutbox), [submitted, shownMessages, shownOutbox]);
  useLayoutEffect(() => { submissions.observeQueue(thread.id, history?.outbox ?? []); }, [submissions, thread.id, history?.outbox]);
  useEffect(() => { submissions.observeMessages(thread.id, shownMessages); }, [submissions, thread.id, shownMessages, submitted]);
  const questions = useMemo(() => currentQuestions(history, transcript), [history, transcript]);
  const questionsByMessage = useMemo(() => {
    const groups = new Map<string, typeof questions>();
    for (const question of questions) groups.set(question.sourceMessageId, [...(groups.get(question.sourceMessageId) ?? []), question]);
    return groups;
  }, [questions]);
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
  useReloadGuard(() => sending || connecting ? "操作尚未完成，请稍后更新。"
    : draft.text || draft.requestId ? "还有未发送或待核对的消息，请处理后再更新。" : submissions.reloadBlocker());
  const updateDraft = useCallback(
    (next: QueryDraft) => {
      setDraft(next);
      if (next.text) drafts.set(thread.id, next);
      else drafts.delete(thread.id);
    },
    [drafts, thread.id],
  );
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
      root, target, observation, getObservation: () => latestReadObservation.current, attempted: attemptedReads.current,
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
  }, [thread.id, readVersion, readItemId, readRetry, onActivity]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  const targetAvailable = !thread.archived && !thread.missing && !managementBlocked;
  const canQueue = targetAvailable && history?.canQueue !== false;
  const canAttemptSend = targetAvailable && !!(history?.canAttemptSend ?? history?.canSend);
  const staleConnection = observedConnection.status === "connected" && history?.source !== "desktop" && (history?.checkedAt ?? 0) > observedConnection.checkedAt;
  const connectionHint = managementHint || (thread.archived ? "会话已归档，恢复后可继续。" : !targetAvailable ? history?.hint : connecting
    ? "正在连接 Mac 中的原任务。可以继续输入，草稿和待发消息会保留。"
    : observedConnection.status === "failed" ? connectionFailureHint(observedConnection.code)
    : history?.readOnlyReason === "app_version_changed" ? history.hint
    : staleConnection ? "暂时无法读取原任务的实时状态。草稿和待发消息已保留，可以重试连接。"
    : observedConnection.status === "connected" && history?.source !== "desktop" ? "已连接 Mac 中的原任务，正在同步发送状态。"
    : history?.source === "desktop" && observedConnection.status === "connected" ? `已连接 Mac 中的原任务。${history.hint || ""}`
    : history?.source !== "desktop" && history ? "正在显示已保存的历史。连接原任务，或提交消息后自动连接。" : history?.hint);
  // Queue storage only needs the Mac API; a stale desktop read is not a reason
  // to reject the user's next instruction. Dispatch still checks fresh state.
  const enqueue = history?.runtime === "active" || !!history?.outbox?.length || !history?.canSend || !!historyError;
  const sendAndConnect = enqueue && history?.runtime !== "active" && !history?.outbox?.length && history?.source !== "desktop";
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
      onError() { setConnectionError("暂时无法核对连接状态，联网后会继续核对。草稿和待发消息已保留。"); },
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
          data.messages.some((m) => m.role === "user" && m.clientMessageId === saved.requestId && !m.truncated && m.text.trim() === saved.text.trim())
        ) {
          updateDraft({ text: "" });
          if (data.source === "desktop" && data.messages.some(message => message.role === "user" && message.clientMessageId === saved.requestId)) {
            confirmAccepted({ requestId: saved.requestId, status: "accepted" });
            setNotice("");
          } else setNotice("已在原任务历史中确认这条消息。");
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
  }, [thread.id, drafts, historyCache, updateDraft, managementBlocked, feedbackTracker, showAcceptedFeedback, confirmAccepted, submissions, checkSubmissionReceipt]);
  useLayoutEffect(() => {
    const element = messages.current;
    if (!element) return;
    const latest = shownMessages.at(-1), previous = previousLatest.current;
    if (nearBottom.current) {
      element.scrollTop = element.scrollHeight;
      setAwayFromLatest(false);
      setHasNewContent(false);
    } else {
      if (restoreScroll.current !== null) element.scrollTop = restoreScroll.current;
      if (latest && previous && (latest.id !== previous.id || latest.text !== previous.text)) setHasNewContent(true);
    }
    previousLatest.current = latest ? { id: latest.id, text: latest.text } : null;
    restoreScroll.current = null;
  }, [shownMessages, visibleSubmissions]);
  useLayoutEffect(() => {
    const element = messages.current;
    if (!element) return;
    // Composer growth and the software keyboard resize the reading area even
    // when no message changes. Follow only while the reader is already at bottom.
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (draft.text || submissions.reloadBlocker()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft.text, submissions]);
  useEffect(() => {
    if (!/^(消息已交给|已加入(?: Mac )?待发|已在原任务历史|当前执行已中断|这一轮已经结束)/.test(notice)) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const receive = (receipt: Receipt) => {
    submissions.receipt(thread.id, receipt);
    if (receipt.status === "accepted" || receipt.status === "queued") {
      if (receipt.status === "accepted") { onActivity?.(); confirmAccepted(receipt); }
      else feedbackTracker.trackQueued(receipt.requestId);
      setNotice(receipt.status === "queued" && !feedbackTracker.hasAccepted(receipt.requestId)
        ? history?.source === "desktop" ? "已加入待发列表，当前轮完成后发送。" : "已加入 Mac 待发列表，正在连接原任务；确认可接收后发送。" : "");
      nearBottom.current = true;
    } else if (
      receipt.status === "rejected" ||
      receipt.status === "not_found"
    ) {
      setError(
        receipt.status === "not_found"
          ? "未收到这次提交，可以重新发送。"
          : receipt.code === "desktop_preflight_timeout" ? "连接原任务超时，这次没有发送，可以重试。"
          : "原任务暂时无法接收消息，请检查当前状态或重新连接。",
      );
    } else setNotice("发送结果尚未确认。先刷新历史；核对状态不会重复发送。");
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending || !draft.text.trim()) return;
    const release = holdReload();
    setSending(true);
    setError("");
    setNotice("");
    setAcceptedNotice(null);
    const controller = new AbortController();
    const requestId = draft.requestId || crypto.randomUUID();
    const submittedText = draft.text;
    receiptRead.current = controller;
    nearBottom.current = true;
    // Capture before clearing the composer. Every later receipt updates this
    // request's immutable snapshot, never whatever the user is typing next.
    submissions.seed({ threadId: thread.id, requestId, text: submittedText,
      status: draft.requestId ? "unknown" : sendAndConnect ? "connecting" : "submitting" });
    updateDraft({ text: "" });
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
            ...(enqueue ? { enqueue: true } : {}),
          }));
      }
      if (receipt.requestId !== requestId) throw new Error("回执与当前消息不匹配，请重新核对。");
      submissions.receipt(thread.id, receipt);
      if (!ownsView()) return;
      if (receipt.status === "pending") setNotice("Pocket 已收到，正在确认原任务…");
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
    if (connecting || connectionOpen.current) return;
    const controller = new AbortController();
    connectionOpen.current = controller;
    setOpening(true);
    setError("");
    setConnectionError("");
    const ownsView = () => !controller.signal.aborted && connectionOpen.current === controller;
    try {
      const result = await onConnect();
      if (!ownsView()) return;
      if (result.connection) setConnection(previous => newerConnection(previous, result.connection));
      else setConnectionError("Mac 已收到打开请求，连接尚未确认。请刷新状态后重试。");
      void load();
    } catch (error) {
      if (ownsView()) setConnectionError((error as Error).message || "连接请求未完成，请重试连接。");
    } finally {
      if (ownsView()) { connectionOpen.current = null; setOpening(false); }
    }
  };
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
    <section className="conversation" aria-label="会话历史与发送">
      <div className="conversation-toolbar">
        <div className="conversation-overview">
        <div className="runtime-summary">
        <span className={!loading && !historyError && !history?.pendingRequests?.length && history?.runtime === "active" ? "runtime-active" : ""}>
          {connecting ? "正在连接原任务…" : observedConnection.status === "failed" && history?.source !== "desktop" ? "连接未完成" : loading
            ? shownMessages.length ? "正在同步状态…" : "正在读取历史…"
            : historyError ? "等待重连" : history?.pendingRequests?.length ? "等待确认" : history?.latestTurnStatus === "interrupted" && history?.runtime === "idle" ? "已中断" : statuses[history?.runtime || ""] || "任务状态"}
        </span>
          <TurnDuration timing={history?.turnTiming} live={!loading && !historyError && history?.source === "desktop" && history.runtime === "active"} />
        </div>
          <ContextStatus threadId={thread.id} history={history} disabled={!online || thread.archived || thread.missing || managementBlocked} refresh={load} />
        </div>
        <div className="conversation-controls">
          <StopExecution threadId={thread.id} history={history} disabled={loading || !!historyError || thread.archived || thread.missing || managementBlocked} refresh={load} notify={setNotice} />
          <button
            className="icon-button"
            aria-label="跳到最新消息"
            onClick={returnToLatest}
          >
            <ArrowDown size={16} />
          </button>
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
        {shownMessages.map(message => {
          const messageQuestions = questionsByMessage.get(message.id);
          return messageQuestions?.length ? <QuestionPrompts key={message.id} threadId={thread.id} questions={messageQuestions} sourceText={message.text} sourceImages={message.images} sourceTruncated={message.truncated}
            disabled={loading || !!historyError || !targetAvailable || !history?.canSend} drafts={drafts} refresh={load} />
            : <ConversationMessage key={message.id} message={message}
              recentlySent={!!message.clientMessageId && (recentAccepted.get(message.clientMessageId) ?? 0) > Date.now()} />;
        })}
        {!!unplacedQuestions.length && <QuestionPrompts threadId={thread.id} questions={unplacedQuestions}
          disabled={loading || !!historyError || !targetAvailable || !history?.canSend} drafts={drafts} refresh={load} />}
        <div ref={readSentinel} aria-hidden="true" style={{ height: 1 }} />
        <SubmittedQueryCards items={visibleSubmissions} connecting={connecting || history?.source !== "desktop"} paused={!!history?.queuePaused}
          disabled={!online || managementBlocked} check={checkSubmitted} dismiss={requestId => submissions.dismiss(thread.id, requestId)} />
      </div>
      {awayFromLatest && <button type="button" className="conversation-latest" onClick={returnToLatest}>
        <ArrowDown size={14} aria-hidden="true" />
        {hasNewContent ? "有新内容 · 返回最新" : "返回最新消息"}
      </button>}
      </div>
      <div className="conversation-status">
        <p role="status" className={history?.canSend || history?.pendingRequests?.length ? "routine-hint" : undefined}>{connectionHint}</p>
        {targetAvailable && (history || historyError) && (history?.source !== "desktop" || connecting || observedConnection.status === "failed" || !!connectionError) && (
          <button
            className="secondary"
            disabled={connecting || !online}
            title="连接原任务并重新读取实时状态"
            onClick={() => void connect()}
          >
            <Link2 size={15} />
            {connecting ? "正在连接…" : observedConnection.status === "failed" || staleConnection || connectionError ? "重试连接" : "连接任务"}
          </button>
        )}
        {(error || connectionError || historyError) && (
          <p className="inline-error" role="alert">
            {error || connectionError || historyError}
          </p>
        )}
        {notice && (
          <p className={`message-notice${/^已加入(?: Mac )?待发/.test(notice) ? " queue-receipt-notice" : ""}`} role="status">
            {notice}
          </p>
        )}
        {acceptedNotice && <SubmissionFeedbackNotice feedback={acceptedNotice} leaving={acceptedNotice.leaving} />}
        {currentReadFeedback && <p className="inline-hint" role="status">
          {currentReadFeedback.status === "stale" ? "进展已有更新，读取最新内容后再同步。" : currentReadFeedback.status === "unavailable" ? "暂时无法同步已读状态。" : "已读状态尚未确认。"}
          {" "}<button type="button" className="text-button" disabled={!online || retryingRead} onClick={() => void retryRead()}>{retryingRead ? "正在核对…" : "同步已读"}</button>
        </p>}
      </div>
      <RequestActions threadId={thread.id} requests={history?.pendingRequests ?? []} disabled={loading || !!historyError || thread.archived || thread.missing || managementBlocked} refresh={load} drafts={drafts} />
      <Outbox threadId={thread.id} items={shownOutbox} paused={history?.queuePaused} disabled={!online || managementBlocked} allowSend={canAttemptSend} connectionPending={history?.source !== "desktop"} refresh={load} drafts={drafts} submissions={submissions} onActivity={onActivity}
        onAccepted={receipt => confirmAccepted(receipt, "queue")} />
      <form className="conversation-composer" onSubmit={(e) => void submit(e)}>
        <label className="sr-only" htmlFor="user-query">
          发送给原任务的消息
        </label>
        <AutoTextarea
          id="user-query"
          aria-label="发送给原任务的消息"
          placeholder={enqueue ? "写下下一步，稍后依次发送…" : "写下想法，继续这段对话…"}
          value={draft.text}
          maxLength={16000}
          onChange={(e) => updateDraft({ text: e.target.value })}
          onInput={(e) => updateDraft({ text: e.currentTarget.value })}
        />
        <div className="composer-actions">
          <button
            className="primary"
            disabled={
              sending ||
              !online ||
              !draft.text.trim() ||
              (!draft.requestId && (enqueue ? !canQueue : !targetAvailable || !history?.canSend))
            }
          >
            <Send size={15} />
            {sending ? "提交中…" : draft.requestId ? "核对发送状态" : managementBlocked ? "暂不可发送" : sendAndConnect ? "发送并连接" : enqueue ? "加入队列" : "发送"}
          </button>
        </div>
      </form>
    </section>
  );
}
