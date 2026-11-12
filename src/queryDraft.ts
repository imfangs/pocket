import type { DraftAttachment } from "./attachmentTypes";

// Input belongs to the authenticated session, not to a rendered conversation.
// Async writers use captureDraft to preserve edits made after they started.
export type QueryDraft = {
  text: string; requestId?: string; revision?: number;
  attachments?: readonly DraftAttachment[];
  answerMode?: "options" | "custom"; customText?: string; optionText?: string;
};
