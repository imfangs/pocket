import type { TaskOperation } from "./taskOperations";

export type CreationClipboard = { text: string; hint?: string };
export type CreationQueryDraft = { text: string; revision: number; hint?: string };

// Call this from the initiating click, before flushing edits or awaiting any
// other work. The dialog only consumes this already-started read.
export function beginCreationClipboard(readText: () => Promise<string>, recovering = false): Promise<CreationClipboard> | undefined {
  if (recovering) return undefined;
  const unavailable = () => ({ text: "", hint: "未能读取剪贴板，可以在这里手动粘贴。" });
  try { return readText().then(text => ({ text }), unavailable); }
  catch { return Promise.resolve(unavailable()); }
}

export async function prepareCreationDialog(options: {
  existing?: TaskOperation;
  getLatest: (requestId: string) => TaskOperation | undefined;
  readText: () => Promise<string>;
  flush: () => Promise<void>;
}) {
  const clipboardRead = beginCreationClipboard(options.readText, !!options.existing);
  await options.flush();
  const operation = options.existing ? options.getLatest(options.existing.requestId) ?? options.existing : undefined;
  if (operation?.status === "succeeded" && operation.threadId) return { kind: "open" as const, operation, threadId: operation.threadId };
  return { kind: "dialog" as const, operation, clipboardRead };
}

export function editCreationQuery(current: CreationQueryDraft, text: string): CreationQueryDraft {
  // Clearing an already empty field still claims it against a late clipboard
  // response. Submission also claims the current text before its first await.
  return { text, revision: current.revision + 1 };
}

export function applyCreationClipboard(current: CreationQueryDraft, clipboard: CreationClipboard): CreationQueryDraft {
  return current.revision === 0 ? { ...current, ...clipboard } : current;
}

export function creationQueryPayload(query: string): { initialQuery?: string } {
  if (query.length > 16000) throw new Error("首条消息超过16000字，请缩短后再创建并发送。");
  return query.trim() ? { initialQuery: query.trim() } : {};
}
