import { feedbackSourceText, type FeedbackTranslate } from "./localization.ts";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { FEEDBACK_LIMITS, normalizeFeedbackInput, type FeedbackAnnotation, type FeedbackContext, type FeedbackInput, type FeedbackReceipt } from "../contracts.ts";
import { createFeedbackDraftStore, type FeedbackDraftStore } from "../browser/drafts.ts";
import { normalizeFeedbackImage, type FeedbackCapture } from "../browser/capture.ts";
import { renderFeedbackAnnotations, toFeedbackImage } from "../browser/annotations.ts";
import { createFeedbackPanelController, type FeedbackPanelController } from "./controller.ts";
import AnnotationEditor from "./AnnotationEditor.tsx";
import "./feedback-panel.css";

export type FeedbackPanelProps = {
  appId: string; scope: string; context: FeedbackContext; initialCapture?: FeedbackCapture;
  capture?: (signal?: AbortSignal) => Promise<FeedbackCapture>;
  submit: (input: FeedbackInput, signal: AbortSignal) => Promise<FeedbackReceipt>;
  status: (id: string, signal: AbortSignal) => Promise<FeedbackReceipt | null>;
  retry?: (id: string, signal: AbortSignal) => Promise<FeedbackReceipt>;
  onClose: () => void; translate?: FeedbackTranslate; autoDirect?: boolean; draftStore?: FeedbackDraftStore;
};
const statusText = {
  received: "反馈已保存", waiting_webhook: "等待转发", sending: "正在送到开发会话",
  queued: "已排入开发队列", delivered: "开发会话已接收", needs_attention: "反馈已保存，转发需要检查",
} as const;

export default function FeedbackPanel(props: FeedbackPanelProps) {
  return <FeedbackPanelSession key={JSON.stringify([props.appId, props.scope])} {...props} />;
}
function FeedbackPanelSession(props: FeedbackPanelProps) {
  const t = props.translate ?? feedbackSourceText;
  const initialProps = useRef(props);
  const [controller, setController] = useState<FeedbackPanelController | null>(null);
  useEffect(() => {
    // StrictMode replays effect setup/cleanup while preserving component state.
    // A controller belongs to one setup: a disposed controller is never revived.
    const options = initialProps.current;
    const store = options.draftStore ?? createFeedbackDraftStore();
    const next = createFeedbackPanelController({ ...options, store,
      prepare: async draft => {
        const images = draft.image ? [await toFeedbackImage(draft.image, "original")] : [];
        if (draft.image && draft.annotations.length)
          images.push(await toFeedbackImage(await renderFeedbackAnnotations(draft.image, draft.annotations), "annotated"));
        return normalizeFeedbackInput({ schemaVersion: 1, id: draft.id, appId: draft.appId, context: draft.context,
          note: draft.note, reason: draft.reason, annotations: draft.annotations, images, autoDirect: draft.autoDirect });
      },
    });
    setController(next); void next.initialize();
    return () => {
      const settled = next.dispose();
      if (!options.draftStore) void settled.finally(() => store.dispose());
    };
  }, []);
  return controller ? <FeedbackPanelView {...props} controller={controller} />
    : <section className="feedback-kit-panel" data-feedback-ignore="" aria-label={t("发送使用反馈")}><p role="status">{t("正在准备反馈…")}</p></section>;
}
function FeedbackPanelView(props: FeedbackPanelProps & { controller: FeedbackPanelController }) {
  const t = props.translate ?? feedbackSourceText;
  const noteId = useId(), annotationNoteId = `${noteId}-annotation`;
  const { controller } = props;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [drawing, setDrawing] = useState(false), [selected, setSelected] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false), [imageError, setImageError] = useState("");
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  const [undo, setUndo] = useState<FeedbackAnnotation[][]>([]);
  const imageInput = useRef<HTMLInputElement>(null), imageOperation = useRef<AbortController | null>(null);
  const draft = state.draft, receipt = draft?.receipt;
  const locked = !draft || state.busy || draft.phase !== "editing" || !!receipt || imageBusy;
  const [url, setUrl] = useState("");
  useEffect(() => {
    return () => { const image = imageOperation.current; imageOperation.current = null; image?.abort(); };
  }, [controller]);
  useEffect(() => {
    const blob = draft?.image?.blob;
    if (!blob) { setUrl(""); return; }
    const value = URL.createObjectURL(blob); setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [draft?.image?.id, draft?.image?.blob]);
  useEffect(() => { setDrawing(false); setSelected(null); setUndo([]); }, [draft?.id]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  useEffect(() => {
    if (!draft || draft.phase !== "unknown" || receipt?.status === "delivered") return;
    const check = () => { if (document.visibilityState === "visible" && navigator.onLine !== false) void controller.check(); };
    const timer = setInterval(check, 5000);
    document.addEventListener("visibilitychange", check); window.addEventListener("online", check);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", check); window.removeEventListener("online", check); };
  }, [controller, draft?.phase, receipt?.status]);
  const changeAnnotations = (next: FeedbackAnnotation[], history = true) => {
    if (!draft || locked) return;
    if (history) setUndo(values => [...values.slice(-19), structuredClone(draft.annotations)]);
    controller.setAnnotations(next);
  };
  const replaceImage = async (operation: (signal: AbortSignal) => Promise<FeedbackCapture>) => {
    if (locked) return;
    const signal = new AbortController(); imageOperation.current?.abort(); imageOperation.current = signal;
    setImageBusy(true); setImageError("");
    try {
      const image = await operation(signal.signal);
      if (signal.signal.aborted || imageOperation.current !== signal) return;
      controller.replaceImage(image); setSelected(null); setUndo([]); setDrawing(false);
    } catch {
      if (!signal.signal.aborted) setImageError("截图暂未生成，可选择已有截图，或只发送说明。");
    } finally { if (imageOperation.current === signal) { imageOperation.current = null; setImageBusy(false); } }
  };
  const activeIndex = draft?.annotations.findIndex(value => value.id === selected) ?? -1;
  const active = activeIndex >= 0 ? draft!.annotations[activeIndex] : null;
  const canSubmit = !!draft && (!!draft.image || !!draft.note.trim() || draft.reason !== "unspecified" || draft.annotations.some(value => value.note.trim()));
  return <section className="feedback-kit-panel" data-feedback-capture-ignore="" data-feedback-ignore="" aria-label={t("发送使用反馈")}>
    {!state.ready ? <div className="feedback-kit-empty" role="status">
      <p>{state.error ? t(state.error) : t("正在准备反馈…")}</p>
      {state.error && <button type="button" onClick={() => void controller.initialize()}>{t("重试")}</button>}
    </div> : draft && <>
      {state.restored && !receipt && <div className="feedback-kit-restored">
        <span>{draft.phase === "unknown" ? t("已恢复待确认的反馈") : t("已恢复上次未发送的反馈")}</span>
        {draft.phase === "editing" && <button type="button" className="feedback-kit-quiet" disabled={locked}
          onClick={() => void controller.startNew()}>{t("重新开始")}</button>}
      </div>}
      {draft.image && url ? <>
        <div className="feedback-kit-toolbar">
          <button type="button" aria-pressed={drawing} disabled={locked || !drawing && draft.annotations.length >= FEEDBACK_LIMITS.annotations}
            onClick={() => setDrawing(value => !value)}>{drawing ? t("完成框选") : t("框选位置")}</button>
          <button type="button" disabled={locked || !undo.length} onClick={() => {
            const previous = undo.at(-1); if (!previous) return;
            controller.setAnnotations(previous); setUndo(values => values.slice(0, -1)); setSelected(null); setDrawing(false);
          }}>{t("撤销")}</button>
          {!receipt && draft.phase === "editing" && <button type="button" className="feedback-kit-quiet" disabled={locked}
            onClick={() => { controller.replaceImage(); setSelected(null); setUndo([]); setDrawing(false); }}>{t("移除截图")}</button>}
        </div>
        <AnnotationEditor key={draft.image.id} url={url} width={draft.image.width} height={draft.image.height} annotations={draft.annotations}
          disabled={locked} drawing={drawing} selected={selected} onChange={changeAnnotations} onSelect={setSelected}
          onCreated={() => setDrawing(false)} translate={t} />
        {!locked && <p className="feedback-kit-help">{drawing ? t("拖动框出位置；完成后可补充说明。") : t("上下滑动查看截图，点击「框选位置」添加标注。")}</p>}
      </> : !receipt && <div className="feedback-kit-empty-image">
        <span>{imageBusy ? t("正在生成截图…") : t("可附上截图，也可以只发送说明。")}</span>
        <div>
          {props.capture && <button type="button" disabled={locked} onClick={() => void replaceImage(signal => props.capture!(signal))}>{t("截取当前页面")}</button>}
          <button type="button" disabled={locked} onClick={() => imageInput.current?.click()}>{t("选择截图")}</button>
        </div>
      </div>}
      <input ref={imageInput} className="feedback-kit-file-input" type="file" accept="image/png,image/jpeg" aria-label={t("选择反馈截图")}
        disabled={locked} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
          if (file) void replaceImage(() => normalizeFeedbackImage(file)); }} />
      {!!draft.annotations.length && <div className="feedback-kit-annotation-list" aria-label={t("标注位置")}>
        {draft.annotations.map((value, index) => <button type="button" key={value.id} aria-label={t("标注 {{value0}}", { value0: index + 1 })}
          aria-pressed={selected === value.id} onClick={() => setSelected(value.id)}>{index + 1}</button>)}
      </div>}
      {active && <div className="feedback-kit-annotation-note">
        <label htmlFor={annotationNoteId}>{activeIndex + 1} {t("· 这个位置的说明")}</label>
        <textarea id={annotationNoteId} rows={2} maxLength={FEEDBACK_LIMITS.annotationNoteCharacters} value={active.note}
          readOnly={locked} placeholder={t("想怎么调整（可选）")} onChange={event => changeAnnotations(draft.annotations.map(value =>
            value.id === active.id ? { ...value, note: event.currentTarget.value } : value), false)} />
        {!locked && <button type="button" className="feedback-kit-quiet" onClick={() => { changeAnnotations(draft.annotations.filter(value => value.id !== active.id)); setSelected(null); }}>{t("删除这个标注")}</button>}
      </div>}
      <label className="feedback-kit-note-label" htmlFor={noteId}>{draft.annotations.length ? t("补充说明") : t("哪里不顺，或者想怎么改？")}</label>
      <textarea id={noteId} className="feedback-kit-note" rows={3} maxLength={FEEDBACK_LIMITS.noteCharacters} value={draft.note}
        placeholder={draft.annotations.length ? t("也可以说说整体想法（可选）") : t("说一句当时遇到了什么")} readOnly={locked}
        onChange={event => controller.edit({ note: event.currentTarget.value })} />
      {(imageError || state.error || state.storageError) && <p className="feedback-kit-error" role="alert">{t(imageError || state.error || state.storageError)}</p>}
      {!online && <p className="feedback-kit-help" role="status">{t("暂时离线，反馈草稿会保留。")}</p>}
      <footer className="feedback-kit-actions">
        {receipt ? <>
          <div role="status"><strong>{t(statusText[receipt.status])}</strong>
            {!["delivered", "needs_attention"].includes(receipt.status) && <small>{t("可先关闭，后台会继续处理。")}</small>}</div>
          {receipt.status === "needs_attention" && <button type="button" disabled={!online || state.checking}
            onClick={() => void (props.retry && !state.recoveryUnknown ? controller.retryDelivery() : controller.check())}>
            {state.checking ? t("正在核对…") : props.retry && !state.recoveryUnknown ? t("重试转发") : t("核对状态")}</button>}
          <button type="button" className="feedback-kit-primary" onClick={props.onClose}>{t("完成")}</button>
        </> : draft.phase === "unknown" ? <>
          <span role="status">{state.busy ? t("正在提交反馈…") : t("发送结果待确认")}</span>
          {state.notFound && <button type="button" disabled={!online || state.busy || state.checking} onClick={() => void controller.submit(true)}>{t("重试原反馈")}</button>}
          <button type="button" className="feedback-kit-primary" disabled={!online || state.busy || state.checking}
            onClick={() => void controller.check()}>{state.checking ? t("正在核对…") : t("核对状态")}</button>
        </> : <>
          <span>{state.busy ? t("正在保存反馈…") : t("反馈会自动送到开发会话")}</span>
          <button type="button" className="feedback-kit-primary" disabled={!online || locked || !canSubmit}
            onClick={() => { setDrawing(false); void controller.submit(); }}>{state.busy ? t("正在提交…") : t("发送反馈")}</button>
        </>}
      </footer>
    </>}
  </section>;
}
