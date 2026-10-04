import { useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import AutoTextarea from "./AutoTextarea";
import { api } from "./api";
import type { AsyncQuestion } from "./conversationFeed";
import type { QueryDraft } from "./Conversation";
import { holdReload, useReloadGuard } from "./updateSafety";
import { captureDraft } from "./draftTransaction";

type Props = { threadId: string; questions: AsyncQuestion[]; disabled: boolean; drafts: Map<string, QueryDraft>; refresh: () => Promise<void> | undefined;
  readMarker?: { sourceMessageId: string; rootRef: Ref<HTMLElement>; markerRef: Ref<HTMLDivElement> } };
function QuestionCard({ threadId, question, disabled, drafts, refresh, endMarker }: Omit<Props, "questions" | "readMarker"> & { question: AsyncQuestion; endMarker?: Ref<HTMLDivElement> }) {
  const key = `${threadId}/question/${question.key}`;
  const [draft, setDraft] = useState<QueryDraft>(() => drafts.get(key) || { text: "" });
  const [custom, setCustom] = useState(() => !question.options.length || !!draft.text && !question.options.includes(draft.text));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const viewGeneration = useRef(0);
  useEffect(() => () => { viewGeneration.current++; }, [key]);
  useReloadGuard(() => {
    const saved = drafts.get(key);
    return busy ? "回答尚未提交完成，请稍后更新。"
      : saved?.text || saved?.requestId ? "还有未提交或待核对的回答，请处理后再更新。" : null;
  });
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
    const release = holdReload();
    const generation = viewGeneration.current;
    const currentView = () => viewGeneration.current === generation;
    const saved = captureDraft(drafts, key);
    const updateSubmitted = (value: QueryDraft) => {
      if (!saved.set(value)) return false;
      if (currentView()) setDraft(value);
      return true;
    };
    setBusy(true); setError("");
    const requestId = draft.requestId || (waiting ? question.response?.requestId : null) || crypto.randomUUID();
    try {
      let result: { status: string };
      if (waiting) {
        await refresh();
        result = await api(`/api/tasks/${threadId}/messages/${requestId}`);
      } else {
        if (!draft.text.trim()) return;
        updateSubmitted({ ...draft, requestId });
        result = await api(`/api/tasks/${threadId}/questions/${question.key}/answer`, "POST", { requestId, text: draft.text });
      }
      if (result.status === "accepted") saved.clear();
      else if (["rejected", "not_found"].includes(result.status)) {
        if (updateSubmitted({ text: draft.text }) && currentView()) setError("问题可能已经变化，请刷新后再回答。");
      }
      if (currentView()) await refresh();
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      if (status && status < 500) updateSubmitted({ text: draft.text });
      if (currentView()) setError(status && status < 500 ? (e as Error).message : "回答结果待确认，请核对状态，避免重复提交。");
    } finally { release(); if (currentView()) setBusy(false); }
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
    {endMarker && <div ref={endMarker} aria-hidden="true" style={{ height: 1 }} />}
  </form>;
}
export default function QuestionPrompts(props: Props) {
  if (!props.questions.length) return null;
  const lastObserved = props.questions.reduce((last, question, index) => question.sourceMessageId === props.readMarker?.sourceMessageId ? index : last, -1);
  return <section ref={props.readMarker?.rootRef} className="question-prompts" aria-label="等待回答的问题">
    <strong>Codex 想确认</strong>
    {props.questions.map((question, index) => <QuestionCard key={question.key} threadId={props.threadId} question={question} disabled={props.disabled} drafts={props.drafts} refresh={props.refresh}
      endMarker={index === lastObserved ? props.readMarker?.markerRef : undefined} />)}
  </section>;
}
