import { useState } from "react";
import { MessageSquareWarning } from "lucide-react";
import { Button } from "./ui/Button";
import { usage, usageConfigured } from "./usageAnalytics";
import type { FeedbackReason } from "./usageJournal";
import "./usage-feedback.css";

const reasons: [FeedbackReason, string][] = [["slow", "慢"], ["unresponsive", "没反应"], ["position", "跳位置"], ["hard_to_find", "没找到"], ["other", "其他"]];
export default function UsageFeedback({ threadId }: { threadId: string }) {
  const [feedbackId, setFeedbackId] = useState<string | null>(null), [reason, setReason] = useState<FeedbackReason>("unspecified");
  const [note, setNote] = useState(""), [sent, setSent] = useState(false), [error, setError] = useState("");
  if (!usageConfigured()) return null;
  return <section className="usage-feedback" aria-label="使用反馈">
    {!feedbackId ? <Button variant="soft" color="gray" onClick={() => {
      const id = usage.feedback(threadId);
      if (id) { setFeedbackId(id); setError(""); }
      else setError("反馈暂时不可用，请稍后再试。");
    }}><MessageSquareWarning size={14} aria-hidden="true" />刚才不顺</Button> : <>
      <p role="status">{sent ? "已补充，谢谢。" : "已标记这段操作，可补充原因。"}</p>
      {!sent && <form onSubmit={event => {
        event.preventDefault();
        if (usage.feedbackDetails(threadId, feedbackId, reason, note)) { setSent(true); setError(""); }
        else setError("补充未提交，请稍后再试。");
      }}>
        <div className="usage-feedback-reasons" role="group" aria-label="哪里不顺">
          {reasons.map(([value, label]) => <Button type="button" key={value} variant={reason === value ? "solid" : "soft"}
            color={reason === value ? undefined : "gray"} aria-pressed={reason === value} onClick={() => setReason(value)}>{label}</Button>)}
        </div>
        <label className="sr-only" htmlFor="usage-feedback-note">补充说明（可选）</label>
        <textarea id="usage-feedback-note" rows={2} maxLength={500} value={note} placeholder="也可以说一句当时想做什么（可选）"
          onChange={event => setNote(event.target.value)} />
        <Button type="submit" variant="soft" disabled={reason === "unspecified" && !note.trim()}>补充反馈</Button>
      </form>}
    </>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
