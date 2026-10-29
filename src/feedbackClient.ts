import { createFeedbackDraftStore } from "../packages/feedback-kit/browser/drafts.ts";

export const feedbackDrafts = createFeedbackDraftStore();
export async function clearFeedbackDrafts(machine?: string): Promise<boolean> {
  try {
    if (machine) await feedbackDrafts.clearPrefix(`pocket:${machine}:`);
    else await feedbackDrafts.clearAll();
    return true;
  } catch { return false; }
}
