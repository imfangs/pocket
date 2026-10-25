import type { TaskOperation } from "./taskOperations";

export type CreationClipboard = { text: string; hint?: string };
export type CreationQueryDraft = { text: string; revision: number; hint?: string };
const unavailableClipboard = (): CreationClipboard => ({ text: "", hint: "未能读取剪贴板，可重试或手动粘贴。" });

// Call this from the initiating click before awaiting other work. The dialog
// only consumes this already-started read.
export function beginCreationClipboard(readText: () => Promise<string>, recovering = false): Promise<CreationClipboard> | undefined {
  if (recovering) return undefined;
  try { return readText().then(text => ({ text }), unavailableClipboard); }
  catch { return Promise.resolve(unavailableClipboard()); }
}

// Clipboard reads have no cancellation API. Supersede the old result locally
// when retrying, editing or leaving, while letting the browser own permission.
export function createCreationClipboardReader(options: {
  onPending: (pending: boolean) => void;
  onResult: (result: CreationClipboard, revision: number) => void;
}) {
  let generation = 0, disposed = false;
  return {
    watch(read: Promise<CreationClipboard>, revision: number) {
      if (disposed) return;
      const current = ++generation;
      options.onPending(true);
      void read.catch(unavailableClipboard).then(result => {
        if (disposed || current !== generation) return;
        options.onPending(false);
        options.onResult(result, revision);
      });
    },
    cancel() {
      generation++;
      if (!disposed) options.onPending(false);
    },
    dispose() { disposed = true; generation++; },
  };
}

export async function prepareCreationDialog(options: {
  existing?: TaskOperation;
  getLatest: (requestId: string) => TaskOperation | undefined;
  readText: () => Promise<string>;
  flush?: () => Promise<void>;
}) {
  const clipboardRead = beginCreationClipboard(options.readText, !!options.existing);
  await options.flush?.();
  const operation = options.existing ? options.getLatest(options.existing.requestId) ?? options.existing : undefined;
  if (operation?.status === "succeeded" && operation.threadId) return { kind: "open" as const, operation, threadId: operation.threadId };
  return { kind: "dialog" as const, operation, clipboardRead };
}

export function editCreationQuery(current: CreationQueryDraft, text: string): CreationQueryDraft {
  // Clearing an already empty field still claims it against a late clipboard
  // response. Submission also claims the current text before its first await.
  return { text, revision: current.revision + 1 };
}

export function applyCreationClipboard(current: CreationQueryDraft, clipboard: CreationClipboard, expectedRevision = 0): CreationQueryDraft {
  return current.revision === expectedRevision ? { ...current, ...clipboard } : current;
}

export function creationQueryPayload(query: string): { initialQuery?: string } {
  if (query.length > 16000) throw new Error("首条消息超过16000字，请缩短后再创建并发送。");
  return query.trim() ? { initialQuery: query.trim() } : {};
}
