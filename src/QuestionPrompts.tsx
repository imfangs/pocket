import { useEffect, useRef, useState } from "react";
import AutoTextarea from "./AutoTextarea";
import { api } from "./api";
import type { AsyncQuestion } from "./conversationFeed";
import type { QueryDraft } from "./Conversation";

type Props = { threadId: string; questions: AsyncQuestion[]; disabled: boolean; drafts: Map<string, QueryDraft>; refresh: () => Promise<void> | undefined };
function QuestionCard({ threadId, question, disabled, drafts, refresh }: Omit<Props, "questions"> & { question: AsyncQuestion }) {
  const key = `${threadId}/question/${question.key}`;
  const [draft, setDraft] = useState<QueryDraft>(() => drafts.get(key) || { text: "" });
  const [custom, setCustom] = useState(() => !question.options.length || !!draft.text && !question.options.includes(draft.text));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const focus = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Element && target.matches("input,textarea,[contenteditable='true']") && !form.current?.contains(target)) setEditing(false);
    };
    document.addEventListener("focusin", focus);
    return () => document.removeEventListener("focusin", focus);
  }, []);
  const waiting = !!draft.requestId || ["pending", "accepted", "unknown"].includes(question.response?.status || "");
  const update = (value: QueryDraft) => { setDraft(value); drafts.set(key, value); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || disabled) return;
    setBusy(true); setError("");
    const requestId = draft.requestId || (waiting ? question.response?.requestId : null) || crypto.randomUUID();
    try {
      let result: { status: string };
      if (waiting) {
        await refresh();
        result = await api(`/api/tasks/${threadId}/messages/${requestId}`);
      } else {
        if (!draft.text.trim()) return;
        update({ ...draft, requestId });
        result = await api(`/api/tasks/${threadId}/questions/${question.key}/answer`, "POST", { requestId, text: draft.text });
      }
      if (result.status === "accepted") drafts.delete(key);
      else if (["rejected", "not_found"].includes(result.status)) {
        update({ text: draft.text }); setError("问题可能已经变化，请刷新后再回答。");
      }
      await refresh();
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      if (status && status < 500) update({ text: draft.text });
      setError(status && status < 500 ? (e as Error).message : "回答结果待确认，请核对状态，避免重复提交。");
    } finally { setBusy(false); }
  };
  return <form ref={form} className="question-card" data-editing={editing || undefined} onSubmit={e => void submit(e)} aria-label={question.title}>
    <p className="question-title">{question.title}</p>
    {!custom && question.options.map(option => <label className="question-option" key={option}>
      <input type="radio" name={question.key} checked={!custom && draft.text === option} disabled={disabled || busy || waiting}
        onChange={() => { setCustom(false); update({ text: option }); }} />
      <span>{option}</span>
    </label>)}
    {!!question.options.length && <button type="button" className="question-custom" disabled={disabled || busy || waiting}
      onClick={() => { setCustom(!custom); update({ text: "" }); }}>{custom ? "改用选项" : "自己填写"}</button>}
    {custom && <AutoTextarea aria-label="自行填写回答" value={draft.text} maxLength={16000} disabled={disabled || busy || waiting}
      onFocus={() => setEditing(true)}
      onChange={e => update({ text: e.target.value })} />}
    <div className="question-submit"><button type="submit" className="primary" disabled={disabled || busy || (!waiting && !draft.text.trim())}>
      {busy ? "提交中…" : waiting ? "核对回答状态" : "提交回答"}
    </button></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </form>;
}
export default function QuestionPrompts(props: Props) {
  if (!props.questions.length) return null;
  return <section className="question-prompts" aria-label="等待回答的问题">
    <strong>Codex 想确认</strong>
    {props.questions.map(question => <QuestionCard key={question.key} threadId={props.threadId} question={question} disabled={props.disabled} drafts={props.drafts} refresh={props.refresh} />)}
  </section>;
}
