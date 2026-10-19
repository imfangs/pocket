import { Button } from "./ui/Button";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { Ref } from "react";
import AutoTextarea from "./AutoTextarea";
import { api } from "./api";
import type { AsyncQuestion, Message } from "./conversationFeed";
import type { QueryDraft } from "./Conversation";
import { holdReload, useReloadGuard } from "./updateSafety";
import { captureDraft } from "./draftTransaction";
import { answerMode, editAnswer, hasAnswerText, switchAnswerMode } from "./questionDrafts";
import MessageMarkdown from "./MessageMarkdown";
import { checkQuestionAnswer, discardQuestionDraft, ignoreQuestion, questionPresentation, questionPresentationStore, questionSourceText, withQuestionAnswerPost, type QuestionPresentationStore } from "./questionPresentation";

type Props = { threadId: string; questions: AsyncQuestion[]; disabled: boolean; drafts: Map<string, QueryDraft>; refresh: () => Promise<void> | undefined;
  sourceText?: string; sourceImages?: Message["images"]; sourceTruncated?: boolean; presentationStore?: QuestionPresentationStore;
  readMarker?: { sourceMessageId: string; rootRef?: Ref<HTMLElement>; markerRef: Ref<HTMLDivElement> } };
function QuestionCard({ threadId, question, disabled, drafts, refresh, endMarker, presentationStore: providedStore }: Omit<Props, "questions" | "readMarker" | "sourceText"> & { question: AsyncQuestion; endMarker?: Ref<HTMLDivElement> }) {
  const key = `${threadId}/question/${question.key}`;
  const presentationStore = providedStore ?? questionPresentationStore();
  const ignored = useSyncExternalStore(presentationStore.subscribe,
    () => presentationStore.isIgnored(threadId, question.key), () => presentationStore.isIgnored(threadId, question.key));
  const activeRequestId = useSyncExternalStore(presentationStore.subscribe,
    () => presentationStore.answerRequestId(threadId, question.key), () => presentationStore.answerRequestId(threadId, question.key));
  const [draft, setDraft] = useState<QueryDraft>(() => drafts.get(key) || { text: "" });
  const custom = answerMode(draft, question.options) === "custom";
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [answerOpen, setAnswerOpen] = useState(() => question.options.length > 0);
  const submitting = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const viewGeneration = useRef(0);
  useEffect(() => () => { viewGeneration.current++; }, [key]);
  useReloadGuard(() => {
    const saved = drafts.get(key);
    return busy ? "回答尚未提交完成，请稍后更新。"
      : hasAnswerText(saved) || saved?.requestId ? "还有未提交或待核对的回答，请处理后再更新。" : null;
  });
  useEffect(() => {
    const focus = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Element && target.matches("input,textarea,[contenteditable='true']") && !form.current?.contains(target)) setEditing(false);
    };
    document.addEventListener("focusin", focus);
    return () => document.removeEventListener("focusin", focus);
  }, []);
  const presentation = questionPresentation({ ignored, draft, responseStatus: question.response?.status, busy, answerOpen, postPending: !!activeRequestId });
  const { waiting, expanded } = presentation;
  const update = (value: QueryDraft) => { setDraft(value); drafts.set(key, value); presentationStore.notifyDraftChange(); };
  const discard = () => {
    if (!discardQuestionDraft(presentationStore, threadId, question.key, drafts,
      { responseStatus: question.response?.status, busy: submitting.current })) return;
    setDraft({ text: "" }); setError(""); setEditing(false); setAnswerOpen(false);
  };
  const ignore = () => {
    if (!ignoreQuestion(presentationStore, threadId, question.key,
      { draft: drafts.get(key), responseStatus: question.response?.status, busy: submitting.current })) return;
    setAnswerOpen(false); setEditing(false); setError("");
  };
  const openAnswer = () => {
    presentationStore.setIgnored(threadId, question.key, false);
    setAnswerOpen(true);
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || submitting.current || disabled) return;
    submitting.current = true;
    const release = holdReload();
    const generation = viewGeneration.current;
    const currentView = () => viewGeneration.current === generation;
    const saved = captureDraft(drafts, key);
    const updateSubmitted = (value: QueryDraft) => {
      if (!saved.set(value)) return false;
      if (currentView()) setDraft(value);
      presentationStore.notifyDraftChange();
      return true;
    };
    setBusy(true); setError("");
    const currentRequestId = presentationStore.answerRequestId(threadId, question.key);
    const checking = waiting || !!currentRequestId;
    const requestId = currentRequestId || draft.requestId || (checking ? question.response?.requestId : null) || crypto.randomUUID();
    try {
      let result: { status: string };
      if (checking) {
        result = await checkQuestionAnswer(presentationStore, threadId, question.key, requestId, async () => {
          await refresh();
          return api(`/api/tasks/${threadId}/messages/${requestId}`);
        });
      } else {
        if (!draft.text.trim()) return;
        updateSubmitted({ ...draft, requestId });
        result = await withQuestionAnswerPost(presentationStore, threadId, question.key, requestId,
          () => api(`/api/tasks/${threadId}/questions/${question.key}/answer`, "POST", { requestId, text: draft.text }));
      }
      if (result.status === "accepted" && saved.clear()) {
        if (currentView()) setDraft({ text: "" });
        presentationStore.notifyDraftChange();
      }
      else if (["rejected", "not_found"].includes(result.status)) {
        if (updateSubmitted({ ...draft, requestId: undefined }) && currentView()) setError("问题可能已经变化，请刷新后再回答。");
      }
      if (currentView()) await refresh();
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      if (status && status < 500) updateSubmitted({ ...draft, requestId: undefined });
      if (currentView()) setError(status && status < 500 ? (e as Error).message : "回答结果待确认，请核对状态，避免重复提交。");
    } finally { submitting.current = false; release(); if (currentView()) setBusy(false); }
  };
  return <form ref={form} className="question-card" data-editing={editing || undefined} data-question-state={presentation.state} onSubmit={e => void submit(e)} aria-label={question.title}>
    {!expanded && <>
      <p className="question-title" id={titleId}>{question.title}</p>
      <div className="question-presentation-actions">
        {presentation.ignored && <span className="question-ignored-label">已忽略</span>}
        <button type="button" className="question-answer-toggle" aria-expanded={false} aria-controls={`${titleId}-answer`} onClick={openAnswer}>回答</button>
        {!presentation.ignored && <button type="button" className="question-ignore" disabled={!presentation.canIgnore} onClick={ignore}>忽略</button>}
        {presentation.ignored && presentation.hasDraft && <small className="question-draft-preserved">答案草稿已保留</small>}
        {presentation.hasDraft && presentation.canIgnore && <button type="button" className="question-ignore" onClick={discard}>丢弃草稿</button>}
      </div>
    </>}
    {expanded && <div className="question-answer-panel" id={`${titleId}-answer`}>
    <fieldset className="question-fields" disabled={disabled || busy || waiting}>
    <legend className="question-title" id={titleId}>{question.title}</legend>
    {!custom && question.options.map(option => <label className="question-option" key={option}>
      <input type="radio" name={question.key} checked={!custom && draft.text === option} disabled={disabled || busy || waiting}
        onChange={() => update(editAnswer(draft, question.options, option, "options"))} />
      <span>{option}</span>
    </label>)}
    {!!question.options.length && <button type="button" className="question-custom" disabled={disabled || busy || waiting}
      onClick={() => { setEditing(false); update(switchAnswerMode(draft, question.options, custom ? "options" : "custom")); }}>{custom ? "改用选项" : "自己填写"}</button>}
    {custom && <AutoTextarea aria-label="自行填写回答" aria-labelledby={titleId} value={draft.text} maxLength={16000} disabled={disabled || busy || waiting}
      onFocus={() => setEditing(true)}
      onChange={e => update(editAnswer(draft, question.options, e.target.value, "custom"))} />}
    </fieldset>
    <div className="question-submit"><button type="button" className="question-ignore" disabled={!presentation.canIgnore} onClick={ignore}>忽略</button>
    {presentation.hasDraft && presentation.canIgnore && <button type="button" className="question-ignore" onClick={discard}>丢弃草稿</button>}
    <Button type="submit" className="primary" disabled={disabled || busy || (!waiting && !draft.text.trim())}>
      {busy ? "提交中…" : waiting ? "核对回答状态" : "提交回答"}
    </Button></div>
    </div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {endMarker && <div ref={endMarker} aria-hidden="true" style={{ height: 1 }} />}
  </form>;
}
export default function QuestionPrompts(props: Props) {
  if (!props.questions.length) return null;
  const lastObserved = props.questions.reduce((last, question, index) => question.sourceMessageId === props.readMarker?.sourceMessageId ? index : last, -1);
  const sourceText = questionSourceText(props.sourceText, props.questions.map(question => question.title),
    !!props.sourceImages && Object.keys(props.sourceImages).length > 0, props.questions.map(question => question.options));
  return <section ref={props.readMarker?.rootRef} className="question-prompts" aria-label="Codex 想确认的问题">
    {sourceText && <div className="question-source-text"><MessageMarkdown text={sourceText} images={props.sourceImages} /></div>}
    {props.sourceTruncated && <small className="question-source-truncated">内容较长，此处已截取。</small>}
    <strong>Codex 想确认</strong>
    {props.questions.map((question, index) => <QuestionCard key={`${props.threadId}/${question.key}`} threadId={props.threadId} question={question} disabled={props.disabled} drafts={props.drafts} refresh={props.refresh}
      presentationStore={props.presentationStore} endMarker={index === lastObserved ? props.readMarker?.markerRef : undefined} />)}
  </section>;
}
