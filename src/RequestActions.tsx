import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import type { PendingRequest } from "./conversationFeed";
import { holdReload, useReloadGuard } from "./updateSafety";
import type { QueryDraft } from "./Conversation";
import AutoTextarea from "./AutoTextarea";
import { captureDraft } from "./draftTransaction";
import { requestAnswerKey, requestAnswerValues } from "./questionDrafts";

type Reply = { responseId: string; status: string };
export default function RequestActions({ threadId, requests, disabled, refresh, drafts }: {
  threadId: string; requests: PendingRequest[]; disabled: boolean; refresh: () => Promise<void> | undefined;
  drafts: Map<string, QueryDraft>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, Reply>>({});
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState<Record<string, Record<string, string>>>(() => Object.fromEntries(
    requests.map(request => [request.key, requestAnswerValues(drafts, threadId, request)])));
  const viewGeneration = useRef(0), currentRequests = useRef(requests);
  useEffect(() => () => { viewGeneration.current++; }, [threadId]);
  useLayoutEffect(() => { currentRequests.current = requests; }, [requests]);
  const values = (request: PendingRequest) => answers[request.key] ?? requestAnswerValues(drafts, threadId, request);
  const answer = (request: PendingRequest, questionId: string, text: string) => {
    drafts.set(requestAnswerKey(threadId, request.key, questionId), { text });
    setAnswers(old => ({ ...old, [request.key]: { ...(old[request.key] ?? requestAnswerValues(drafts, threadId, request)), [questionId]: text } }));
  };
  useReloadGuard(() => {
    if (busy) return "确认操作尚未完成，请稍后更新。";
    // Requests can disappear after a turn advances. Their old local state no
    // longer represents an editable answer or a live confirmation surface.
    for (const request of requests) {
      const reply = pending[request.key] || request.response;
      if (["pending", "unknown"].includes(pending[request.key]?.status || ""))
        return "确认结果尚待核对，请处理后再更新。";
      if (!["accepted", "resolved"].includes(reply?.status || "") &&
          Object.values(values(request)).some(value => value.length > 0))
        return "还有未提交的回答，请处理后再更新。";
    }
    return null;
  });
  const act = async (request: PendingRequest, decision?: "accept" | "cancel" | "answer") => {
    if (busy) return;
    const release = holdReload();
    const generation = viewGeneration.current;
    const currentView = () => generation === viewGeneration.current && currentRequests.current.some(item => item.key === request.key);
    const submittedAnswers = { ...values(request) };
    const savedAnswers = (request.questions ?? []).map(question => captureDraft(drafts, requestAnswerKey(threadId, request.key, question.id)));
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
          responseId, ...(decision === "answer" ? { answers: submittedAnswers } : { decision }),
        });
      }
      if (["accepted", "resolved"].includes(result.status)) {
        savedAnswers.forEach(saved => saved.clear());
        if (currentView()) setAnswers(old => ({ ...old, [request.key]: requestAnswerValues(drafts, threadId, request) }));
      }
      if (currentView()) {
        setPending(p => ({ ...p, [request.key]: result }));
        if (result.status === "rejected") setError("请求已变化或无法响应，请刷新后查看。");
        await refresh();
      }
    } catch (e) {
      const status = (e as Error & {status?: number}).status;
      if (currentView()) {
        setPending(p => ({ ...p, [request.key]: { responseId, status: status && status < 500 ? "rejected" : "unknown" } }));
        setError((e as Error).message);
      }
    } finally { release(); if (generation === viewGeneration.current) setBusy(null); }
  };
  if (!requests.length) return null;
  return <section className="request-actions" aria-label="等待确认">
    <strong>等待确认</strong>
    {requests.map(request => {
      const reply = pending[request.key] || request.response;
      const waiting = !!reply && ["pending", "accepted", "unknown", "resolved"].includes(reply.status);
      const requestAnswers = values(request);
      return <article className="approval-card" key={request.key}>
        <span className="approval-kind">{request.kind === "file" ? "文件改动" : request.kind === "permissions" ? "本轮权限" : request.questions?.length ? "需要回答" : request.command ? "命令执行" : "操作确认"}</span>
        <p>{request.reason}</p>
        {request.cwd && <><small>工作目录</small><div className="approval-cwd">{request.cwd}</div></>}
        {request.command && <><small>将执行的命令</small><pre>{request.command}</pre></>}
        {request.details && <><small>{request.kind === "file" ? "文件改动" : request.kind === "permissions" ? "申请权限 · 仅本轮" : "请求详情"}</small><pre>{request.details}</pre></>}
        {request.questions?.map(question => <fieldset key={question.id} disabled={disabled || !!busy || waiting} className="approval-question">
          <legend>{question.question}</legend>
          {question.options?.map(option => <label key={option.label}>
            <input type="radio" name={`${request.key}-${question.id}`} checked={requestAnswers[question.id] === option.label}
              onChange={() => answer(request, question.id, option.label)}/>
            <span>{option.label}{option.description && <small>{option.description}</small>}</span>
          </label>)}
          {question.isSecret ? <input type="password" aria-label={question.question} autoComplete="off"
            value={requestAnswers[question.id] || ""} maxLength={16000}
            onChange={event => answer(request, question.id, event.target.value)} />
            : <AutoTextarea className="approval-text-answer" aria-label={question.question}
              value={requestAnswers[question.id] || ""} maxLength={16000}
              onChange={event => answer(request, question.id, event.target.value)} />}
        </fieldset>)}
        <div className="approval-buttons">
          {waiting ? <><small>{reply.status === "unknown" ? "结果待核对，不会重复响应" : "已提交，等待更新"}</small>
            <button disabled={disabled || !!busy} onClick={() => void act(request)}>核对状态</button></>
            : <>{request.choices.includes("cancel") && <button disabled={disabled || !!busy} onClick={() => void act(request, "cancel")}>拒绝本次</button>}
              {request.choices.includes("accept") && <button className="primary" disabled={disabled || !!busy} onClick={() => void act(request, "accept")}>{request.kind === "permissions" ? "允许本轮" : "允许这一次"}</button>}
              {!!request.questions?.length && <button className="primary" disabled={disabled || !!busy || request.questions.some(q => !requestAnswers[q.id]?.trim())} onClick={() => void act(request, "answer")}>提交回答</button>}</>}
        </div>
      </article>;
    })}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
