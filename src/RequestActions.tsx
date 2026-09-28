import { useState } from "react";
import { api } from "./api";
import type { PendingRequest } from "./conversationFeed";

type Reply = { responseId: string; status: string };
export default function RequestActions({ threadId, requests, disabled, refresh }: {
  threadId: string; requests: PendingRequest[]; disabled: boolean; refresh: () => Promise<void> | undefined;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, Reply>>({});
  const [error, setError] = useState("");
  const act = async (request: PendingRequest, decision?: "accept" | "cancel") => {
    if (busy) return;
    setBusy(request.key); setError("");
    const saved = pending[request.key] || request.response;
    const responseId = saved?.responseId || crypto.randomUUID();
    try {
      let result: Reply;
      if (!decision) {
        await refresh();
        result = await api<Reply>(`/api/tasks/${threadId}/responses/${responseId}`);
      } else {
        setPending(p => ({ ...p, [request.key]: { responseId, status: "pending" } }));
        result = await api<Reply>(`/api/tasks/${threadId}/requests/${request.key}/respond`, "POST", { responseId, decision });
      }
      setPending(p => ({ ...p, [request.key]: result }));
      if (result.status === "rejected") setError("请求已变化或无法响应，请刷新后查看当前请求。");
      await refresh();
    } catch (e) {
      const status = (e as Error & {status?: number}).status;
      setPending(p => ({ ...p, [request.key]: { responseId, status: status && status < 500 ? "rejected" : "unknown" } }));
      setError((e as Error).message);
    } finally { setBusy(null); }
  };
  if (!requests.length) return null;
  return <section className="request-actions" aria-label="等待你的确认">
    <strong>等待你的确认</strong>
    {requests.map(request => {
      const reply = pending[request.key] || request.response;
      const waiting = !!reply && ["pending", "accepted", "unknown", "resolved"].includes(reply.status);
      return <article className="approval-card" key={request.key}>
        <p>{request.reason}</p>
        <small>工作目录</small><div className="approval-cwd">{request.cwd || "原任务目录"}</div>
        <small>将执行的命令</small><pre>{request.command}</pre>
        <div className="approval-buttons">
          {waiting ? <><small>{reply.status === "unknown" ? "结果待核对，不会重复响应" : "已提交，等待原任务更新"}</small>
            <button disabled={disabled || !!busy} onClick={() => void act(request)}>核对状态</button></>
            : <>{request.choices.includes("cancel") && <button disabled={disabled || !!busy} onClick={() => void act(request, "cancel")}>拒绝本次</button>}
              {request.choices.includes("accept") && <button className="primary" disabled={disabled || !!busy} onClick={() => void act(request, "accept")}>允许这一次</button>}</>}
        </div>
      </article>;
    })}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
