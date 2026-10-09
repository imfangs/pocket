import { CheckCircle2 } from "lucide-react";
import type { AcceptedFeedback } from "./submissionFeedback";
import "./submission-feedback.css";

export default function SubmissionFeedbackNotice({ feedback, leaving = false }: { feedback: AcceptedFeedback; leaving?: boolean }) {
  return <p className="message-notice send-feedback" role="status" data-phase={leaving ? "leaving" : "visible"} aria-hidden={leaving || undefined}>
    <CheckCircle2 size={18} aria-hidden="true" />
    <span><strong>已发送</strong><span>{feedback.source === "queue" ? "待发消息已被原任务接收" : "原任务已接收这条消息"}</span></span>
  </p>;
}
