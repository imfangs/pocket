import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, RefreshCw, Send, Monitor } from "lucide-react";
import { api } from "./api";
import type { Thread } from "./types";
import MessageMarkdown from "./MessageMarkdown";
import { rememberHistory, startConversationFeed } from "./conversationFeed";
import type { History, HistoryCache } from "./conversationFeed";
import Outbox from "./Outbox";
export type QueryDraft = { text: string; requestId?: string; revision?: number };
type Receipt = {
  requestId: string;
  status: "accepted" | "queued" | "pending" | "unknown" | "rejected" | "not_found";
  code?: string;
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
  onConnect,
}: {
  thread: Thread;
  drafts: Map<string, QueryDraft>;
  historyCache: HistoryCache;
  onConnect: () => Promise<void>;
}) {
  const [history, setHistory] = useState<History | null>(() => historyCache.get(thread.id)?.history ?? null),
    [loading, setLoading] = useState(true),
    [draft, setDraft] = useState<QueryDraft>(
      () => drafts.get(thread.id) || { text: "" },
    ),
    [sending, setSending] = useState(false),
    [connecting, setConnecting] = useState(false),
    [error, setError] = useState(""),
    [historyError, setHistoryError] = useState(""),
    [notice, setNotice] = useState("");
  const messages = useRef<HTMLDivElement>(null),
    nearBottom = useRef(historyCache.get(thread.id)?.nearBottom ?? true),
    restoreScroll = useRef<number | null>(historyCache.get(thread.id)?.scrollTop ?? null),
    feed = useRef<ReturnType<typeof startConversationFeed> | null>(null);
  const updateDraft = useCallback(
    (next: QueryDraft) => {
      setDraft(next);
      if (next.text) drafts.set(thread.id, next);
      else drafts.delete(thread.id);
    },
    [drafts, thread.id],
  );
  const load = useCallback(() => feed.current?.refresh(), []);
  useEffect(() => {
    const subscription = startConversationFeed({
      request: (signal) => api<History>(`/api/tasks/${thread.id}/history`, "GET", undefined, { signal }),
      onData(data) {
        rememberHistory(historyCache, thread.id, data);
        setHistory(data);
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
  }, [history]);
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
  const receive = (receipt: Receipt) => {
    if (receipt.status === "accepted" || receipt.status === "queued") {
      updateDraft({ text: "" });
      setNotice(receipt.status === "queued" ? "已加入待发列表，当前轮完成后发送。" : "消息已交给 Mac 中的原任务。");
      nearBottom.current = true;
    } else if (
      receipt.status === "rejected" ||
      receipt.status === "not_found"
    ) {
      updateDraft({ text: draft.text });
      setError(
        receipt.status === "not_found"
          ? "未收到这次提交，可以重新发送。"
          : "原任务暂时无法接收消息，请检查当前状态或重新连接。",
      );
    } else setNotice("发送结果尚未确认。先刷新历史；核对状态不会重复发送。");
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending || !draft.text.trim()) return;
    setSending(true);
    setError("");
    setNotice("");
    try {
      if (draft.requestId) {
        receive(
          await api<Receipt>(
            `/api/tasks/${thread.id}/messages/${draft.requestId}`,
          ),
        );
      } else {
        const requestId = crypto.randomUUID();
        updateDraft({ ...draft, requestId });
        receive(
          await api<Receipt>(`/api/tasks/${thread.id}/messages`, "POST", {
            text: draft.text,
            requestId,
            ...(history?.runtime === "active" || history?.outbox?.length ? { enqueue: true } : {}),
          }),
        );
      }
      void load();
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      if (status && status < 500) {
        updateDraft({ text: draft.text });
        setError((e as Error).message);
      } else
        setNotice("连接中断，发送结果尚未确认。请核对状态，避免重复提交。");
    } finally {
      setSending(false);
    }
  };
  return (
    <section className="conversation" aria-label="会话历史与发送">
      <div className="conversation-toolbar">
        <span className={!loading && !historyError && history?.runtime === "active" ? "runtime-active" : ""}>
          {loading
            ? history ? "正在更新…" : "正在读取历史…"
            : historyError ? "等待重连" : statuses[history?.runtime || ""] || "任务状态"}
        </span>
        <div>
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
        {history?.hasMore && (
          <p className="history-boundary">
            显示最近的对话，完整历史可在 Codex 中查看。
          </p>
        )}
        {!loading && !historyError && !history?.messages.length && (
          <p className="history-empty">
            暂时没有可显示的消息。可以连接原任务后刷新。
          </p>
        )}
        {history?.messages.map((m) => (
          <article
            className={`conversation-message ${m.role}`}
            key={m.id}
          >
            <div className="message-label">
              <strong>
                {m.role === "user"
                  ? "你"
                  : m.phase === "commentary"
                    ? "Codex · 进展"
                    : "Codex"}
              </strong>
              {m.timestamp && (
                <time>
                  {new Date(m.timestamp).toLocaleString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              )}
            </div>
            <MessageMarkdown text={m.text} />
            {m.truncated && <small>内容较长，此处已截取。</small>}
          </article>
        ))}
      </div>
      <div className="conversation-status">
        <p>{history?.hint}</p>
        {!loading && history && history.source !== "desktop" && !thread.archived && (
          <button
            className="secondary"
            disabled={connecting}
            onClick={async () => {
              setConnecting(true);
              setError("");
              try {
                await onConnect();
                await load();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setConnecting(false);
              }
            }}
          >
            <Monitor size={15} />
            {connecting ? "正在连接…" : "连接 Mac 中的原任务"}
          </button>
        )}
        {(error || historyError) && (
          <p className="inline-error" role="alert">
            {error || historyError}
          </p>
        )}
        {notice && (
          <p className="message-notice" role="status">
            {notice}
          </p>
        )}
      </div>
      <Outbox threadId={thread.id} items={history?.outbox ?? []} disabled={loading || !!historyError} allowSend={!thread.archived && !thread.missing && !!history?.canSend} refresh={load} drafts={drafts} />
      <form className="conversation-composer" onSubmit={(e) => void submit(e)}>
        <label className="sr-only" htmlFor="user-query">
          发送给原任务的消息
        </label>
        <textarea
          id="user-query"
          aria-label="发送给原任务的消息"
          placeholder={history?.runtime === "active" ? "写下下一步，完成当前轮后发送…" : "在原任务中继续问…"}
          value={draft.text}
          maxLength={16000}
          disabled={sending}
          onChange={(e) => updateDraft({ text: e.target.value })}
          onInput={(e) => updateDraft({ text: e.currentTarget.value })}
        />
        <div className="composer-actions">
          <small>沿用原任务 · 在 Mac 执行</small>
          <button
            className="primary"
            disabled={
              sending ||
              loading ||
              !!historyError ||
              !draft.text.trim() ||
              (!history?.canSend && !draft.requestId)
            }
          >
            <Send size={15} />
            {sending ? "提交中…" : draft.requestId ? "核对发送状态" : history?.runtime === "active" || history?.outbox?.length ? "加入队列" : "发送"}
          </button>
        </div>
      </form>
    </section>
  );
}
