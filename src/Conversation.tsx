import AutoTextarea from "./AutoTextarea";
import ContextStatus from "./ContextStatus";
import RequestActions from "./RequestActions";
import StopExecution from "./StopExecution";
import TurnDuration from "./TurnDuration";
import QuestionPrompts from "./QuestionPrompts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
export type QueryDraft = { text: string; requestId?: string; revision?: number };
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
  onConnect,
  onActivity,
}: {
  thread: Thread;
  drafts: Map<string, QueryDraft>;
  historyCache: HistoryCache;
  onConnect: () => Promise<OpenThreadResult>;
  onActivity?: () => void;
}) {
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
    [notice, setNotice] = useState("");
  const messages = useRef<HTMLDivElement>(null),
    readSentinel = useRef<HTMLDivElement>(null),
    questionReadRoot = useRef<HTMLElement>(null),
    questionReadSentinel = useRef<HTMLDivElement>(null),
    attemptedReads = useRef<ReadAttempts>(new Map()),
    latestReadObservation = useRef<ReadObservation | null>(null),
    manualReadRetry = useRef<string | null>(null),
    readViewGeneration = useRef(0),
    nearBottom = useRef(historyCache.get(thread.id)?.nearBottom ?? true),
    restoreScroll = useRef<number | null>(historyCache.get(thread.id)?.scrollTop ?? null),
    feed = useRef<ReturnType<typeof startConversationFeed> | null>(null),
    textFeed = useRef<ReturnType<typeof startTranscriptFeed> | null>(null);
  const shownMessages = useMemo(() => displayMessages(history, transcript), [history, transcript]);
  const questions = useMemo(() => currentQuestions(history, transcript), [history, transcript]);
  const renderedMessages = useMemo(() => shownMessages.filter(message => !message.isQuestion || !questions.some(q => q.sourceMessageId === message.id)), [shownMessages, questions]);
  const readObservation = useMemo(() => displayedReadObservation(freshTranscript, shownMessages), [freshTranscript, shownMessages]);
  const lastShown = shownMessages.at(-1);
  const readTargetKind = lastShown?.isQuestion && questions.some(question => question.sourceMessageId === lastShown.id) ? "question" : "message";
  const readVersion = readObservation?.visibleVersion, readItemId = readObservation?.lastVisibleItemId;
  useLayoutEffect(() => { latestReadObservation.current = readObservation; }, [readObservation]);
  const currentReadFeedback = thread.hasUnreadTurn !== false && readFeedback &&
    (!readObservation || readFeedback.version === readObservation.visibleVersion) ? readFeedback : null;
  const observedConnection = connectionFromHistory(connection, history);
  const connecting = opening || observedConnection.status === "connecting";
  useReloadGuard(() => sending || connecting ? "操作尚未完成，请稍后更新。"
    : draft.text || draft.requestId ? "还有未发送或待核对的消息，请处理后再更新。" : null);
  const updateDraft = useCallback(
    (next: QueryDraft) => {
      setDraft(next);
      if (next.text) drafts.set(thread.id, next);
      else drafts.delete(thread.id);
    },
    [drafts, thread.id],
  );
  const load = useCallback(async () => { await Promise.all([feed.current?.refresh(), textFeed.current?.refresh()]); }, []);
  const receiptRead = useRef<AbortController | null>(null);
  const connectionOpen = useRef<AbortController | null>(null);
  useEffect(() => () => receiptRead.current?.abort(), [thread.id]);
  useEffect(() => () => connectionOpen.current?.abort(), [thread.id]);
  useEffect(() => () => { readViewGeneration.current++; }, [thread.id]);
  useEffect(() => {
    const observation = latestReadObservation.current;
    const root = readTargetKind === "question" ? questionReadRoot.current : messages.current;
    const target = readTargetKind === "question" ? questionReadSentinel.current : readSentinel.current;
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
  }, [thread.id, readVersion, readItemId, readTargetKind, readRetry, onActivity]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  const targetAvailable = !thread.archived && !thread.missing;
  const canQueue = targetAvailable && history?.canQueue !== false;
  const canAttemptSend = targetAvailable && !!(history?.canAttemptSend ?? history?.canSend);
  const staleConnection = observedConnection.status === "connected" && history?.source !== "desktop" && (history?.checkedAt ?? 0) > observedConnection.checkedAt;
  const connectionHint = !targetAvailable ? history?.hint : connecting
    ? "正在连接 Mac 中的原任务。可以继续输入，草稿和待发消息会保留。"
    : observedConnection.status === "failed" ? connectionFailureHint(observedConnection.code)
    : history?.readOnlyReason === "app_version_changed" ? history.hint
    : staleConnection ? "暂时无法读取原任务的实时状态。草稿和待发消息已保留，可以重试连接。"
    : observedConnection.status === "connected" && history?.source !== "desktop" ? "已连接 Mac 中的原任务，正在同步发送状态。"
    : history?.source === "desktop" && observedConnection.status === "connected" ? `已连接 Mac 中的原任务。${history.hint || ""}`
    : history?.source !== "desktop" && history ? "正在显示已保存的历史。连接原任务，或提交消息后自动连接。" : history?.hint;
  // Queue storage only needs the Mac API; a stale desktop read is not a reason
  // to reject the user's next instruction. Dispatch still checks fresh state.
  const enqueue = history?.runtime === "active" || !!history?.outbox?.length || !history?.canSend || !!historyError;
  const connectingId = observedConnection.status === "connecting" ? observedConnection.requestId : null;
  useEffect(() => {
    if (!connectingId) return;
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
  }, [thread.id, connectingId, load]);
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
    const subscription = startConversationFeed({
      request: (signal) => api<History>(`/api/tasks/${thread.id}/history`, "GET", undefined, { signal }),
      onData(data) {
        rememberHistory(historyCache, thread.id, data);
        setHistory(data);
        setConnection(previous => connectionFromHistory(newerConnection(previous, data.connection), data));
        if (data.source === "desktop" && data.resumeState === "resumed") setConnectionError("");
        setHistoryError("");
        setLoading(false);
        const saved = drafts.get(thread.id);
        if (
          saved?.requestId &&
          data.messages.some((m) => m.clientMessageId === saved.requestId)
        ) {
          updateDraft({ text: "" });
          setNotice("已在原任务历史中确认这条消息。");
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
  }, [thread.id, drafts, historyCache, updateDraft]);
  useLayoutEffect(() => {
    const element = messages.current;
    if (!element) return;
    if (nearBottom.current) element.scrollTop = element.scrollHeight;
    else if (restoreScroll.current !== null) element.scrollTop = restoreScroll.current;
    restoreScroll.current = null;
  }, [shownMessages]);
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
      if (draft.text) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft.text]);
  useEffect(() => {
    if (!/^(消息已交给|已加入(?: Mac )?待发|已在原任务历史|当前执行已中断|这一轮已经结束)/.test(notice)) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const receive = (receipt: Receipt) => {
    if (receipt.status === "accepted" || receipt.status === "queued") {
      if (receipt.status === "accepted") onActivity?.();
      updateDraft({ text: "" });
      setNotice(receipt.status === "queued" ? history?.source === "desktop" ? "已加入待发列表，当前轮完成后发送。" : "已加入 Mac 待发列表，正在连接原任务；确认可接收后发送。" : "消息已交给 Mac 中的原任务。");
      nearBottom.current = true;
    } else if (
      receipt.status === "rejected" ||
      receipt.status === "not_found"
    ) {
      updateDraft({ text: draft.text });
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
    const controller = new AbortController();
    const requestId = draft.requestId || crypto.randomUUID();
    receiptRead.current = controller;
    // A submission belongs to this view and this exact draft. Leaving must not
    // let its late response rewrite a newer draft held by the next view.
    const ownsDraft = () => !controller.signal.aborted && receiptRead.current === controller &&
      drafts.get(thread.id)?.requestId === requestId;
    try {
      let receipt: Receipt;
      if (draft.requestId) {
        receipt = await api<Receipt>(
            `/api/tasks/${thread.id}/messages/${requestId}`,
          );
      } else {
        updateDraft({ ...draft, requestId });
        receipt = await api<Receipt>(`/api/tasks/${thread.id}/messages`, "POST", {
            text: draft.text,
            requestId,
            ...(enqueue ? { enqueue: true } : {}),
          });
      }
      if (!ownsDraft()) return;
      if (receipt.requestId !== requestId) throw new Error("回执与当前消息不匹配，请重新核对。");
      if (receipt.status === "pending") setNotice("Pocket 已收到，正在确认原任务…");
      const confirmed = await waitForSubmission(receipt, signal => api<Receipt>(`/api/tasks/${thread.id}/messages/${requestId}`, "GET", undefined, { signal }), controller.signal);
      if (!ownsDraft()) return;
      receive(confirmed);
      void load();
    } catch (e) {
      if (!ownsDraft()) return;
      const status = (e as Error & { status?: number }).status;
      if (status && status < 500) {
        updateDraft({ text: draft.text });
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
          <ContextStatus threadId={thread.id} history={history} disabled={!online || thread.archived || thread.missing} refresh={load} />
        </div>
        <div className="conversation-controls">
          <StopExecution threadId={thread.id} history={history} disabled={loading || !!historyError || thread.archived || thread.missing} refresh={load} notify={setNotice} />
          <button
            className="icon-button"
            aria-label="跳到最新消息"
            onClick={() => {
              nearBottom.current = true;
              if (messages.current)
                messages.current.scrollTop = messages.current.scrollHeight;
            }}
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
      <div
        className="conversation-messages"
        ref={messages}
        onScroll={() => {
          const el = messages.current;
          if (el) {
            nearBottom.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 100;
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
        {!loading && !historyError && !shownMessages.length && (
          <p className="history-empty">
            暂时没有可显示的消息
          </p>
        )}
        {renderedMessages.map((message) => (
          <ConversationMessage key={message.id} message={message} />
        ))}
        <div ref={readSentinel} aria-hidden="true" style={{ height: 1 }} />
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
          <p className="message-notice" role="status">
            {notice}
          </p>
        )}
        {currentReadFeedback && <p className="inline-hint" role="status">
          {currentReadFeedback.status === "stale" ? "进展已有更新，读取最新内容后再同步。" : currentReadFeedback.status === "unavailable" ? "暂时无法同步已读状态。" : "已读状态尚未确认。"}
          {" "}<button type="button" className="text-button" disabled={!online || retryingRead} onClick={() => void retryRead()}>{retryingRead ? "正在核对…" : "同步已读"}</button>
        </p>}
      </div>
      <QuestionPrompts threadId={thread.id} questions={questions} disabled={loading || !!historyError || thread.archived || thread.missing || !history?.canSend} drafts={drafts} refresh={load}
        readMarker={readTargetKind === "question" && readItemId ? { sourceMessageId: readItemId, rootRef: questionReadRoot, markerRef: questionReadSentinel } : undefined} />
      <RequestActions threadId={thread.id} requests={history?.pendingRequests ?? []} disabled={loading || !!historyError || thread.archived || thread.missing} refresh={load} />
      <Outbox threadId={thread.id} items={history?.outbox ?? []} paused={history?.queuePaused} disabled={!online} allowSend={canAttemptSend} connectionPending={history?.source !== "desktop"} refresh={load} drafts={drafts} onActivity={onActivity} />
      <form className="conversation-composer" onSubmit={(e) => void submit(e)}>
        <label className="sr-only" htmlFor="user-query">
          发送给原任务的消息
        </label>
        <AutoTextarea
          id="user-query"
          aria-label="发送给原任务的消息"
          value={draft.text}
          maxLength={16000}
          disabled={sending}
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
            {sending ? "提交中…" : draft.requestId ? "核对发送状态" : enqueue ? "加入队列" : "发送"}
          </button>
        </div>
      </form>
    </section>
  );
}
