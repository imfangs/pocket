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
  const [answers, setAnswers] = useState<Record<string, Record<string, string>>>({});
  const act = async (request: PendingRequest, decision?: "accept" | "cancel" | "answer") => {
    if (busy) return;
    setBusy(request.key); setError("");
    const saved = pending[request.key] || request.response;
    const responseId = saved && saved.status !== "rejected" ? saved.responseId : crypto.randomUUID();
    try {
      let result: Reply;
      if (!decision) {
        await refresh();
        result = await api<Reply>(`/api/tasks/${threadId}/responses/${responseId}`);
      } else {
        setPending(p => ({ ...p, [request.key]: { responseId, status: "pending" } }));
        result = await api<Reply>(`/api/tasks/${threadId}/requests/${request.key}/respond`, "POST", {
          responseId, ...(decision === "answer" ? { answers: answers[request.key] || {} } : { decision }),
        });
      }
      setPending(p => ({ ...p, [request.key]: result }));
      if (["accepted", "resolved"].includes(result.status)) setAnswers(old => {
        const next = {...old}; delete next[request.key]; return next;
      });
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
        {request.cwd && <><small>工作目录</small><div className="approval-cwd">{request.cwd}</div></>}
        {request.command && <><small>将执行的命令</small><pre>{request.command}</pre></>}
        {request.details && <><small>{request.kind === "file" ? "文件改动" : request.kind === "permissions" ? "申请权限 · 仅本轮" : "请求详情"}</small><pre>{request.details}</pre></>}
        {request.questions?.map(question => <fieldset key={question.id} disabled={disabled || !!busy || waiting} className="approval-question">
          <legend>{question.question}</legend>
          {question.options?.map(option => <label key={option.label}>
            <input type="radio" name={`${request.key}-${question.id}`} checked={answers[request.key]?.[question.id] === option.label}
              onChange={() => setAnswers(old => ({...old, [request.key]: {...old[request.key], [question.id]: option.label}}))}/>
            <span>{option.label}{option.description && <small>{option.description}</small>}</span>
          </label>)}
          <input type={question.isSecret ? "password" : "text"} aria-label={question.question} autoComplete="off"
            value={answers[request.key]?.[question.id] || ""} maxLength={16000}
            onChange={event => setAnswers(old => ({...old, [request.key]: {...old[request.key], [question.id]: event.target.value}}))}/>
        </fieldset>)}
        <div className="approval-buttons">
          {waiting ? <><small>{reply.status === "unknown" ? "结果待核对，不会重复响应" : "已提交，等待原任务更新"}</small>
            <button disabled={disabled || !!busy} onClick={() => void act(request)}>核对状态</button></>
            : <>{request.choices.includes("cancel") && <button disabled={disabled || !!busy} onClick={() => void act(request, "cancel")}>拒绝本次</button>}
              {request.choices.includes("accept") && <button className="primary" disabled={disabled || !!busy} onClick={() => void act(request, "accept")}>{request.kind === "permissions" ? "允许本轮" : "允许这一次"}</button>}
              {!!request.questions?.length && <button className="primary" disabled={disabled || !!busy || request.questions.some(q => !answers[request.key]?.[q.id]?.trim())} onClick={() => void act(request, "answer")}>提交回答</button>}</>}
        </div>
      </article>;
    })}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
