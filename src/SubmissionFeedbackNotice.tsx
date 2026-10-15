import { CheckCircle2 } from "lucide-react";
import type { AcceptedFeedback } from "./submissionFeedback";
import "./submission-feedback.css";

export default function SubmissionFeedbackNotice({ leaving = false }: { feedback: AcceptedFeedback; leaving?: boolean }) {
  return <p className="message-notice send-feedback" role="status" data-phase={leaving ? "leaving" : "visible"} aria-hidden={leaving || undefined}>
    <CheckCircle2 size={18} aria-hidden="true" />
    <span><strong>已发送</strong></span>
  </p>;
}
