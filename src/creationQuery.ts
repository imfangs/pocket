import type { TaskOperation } from "./taskOperations";

export async function prepareCreationDialog(options: {
  existing?: TaskOperation;
  getLatest: (requestId: string) => TaskOperation | undefined;
  flush: () => Promise<void>;
}) {
  // Opening the form must not request clipboard permission. Pasting is an
  // ordinary user action in the Query field after the dialog is visible.
  await options.flush();
  const operation = options.existing ? options.getLatest(options.existing.requestId) ?? options.existing : undefined;
  if (operation?.status === "succeeded" && operation.threadId) return { kind: "open" as const, operation, threadId: operation.threadId };
  return { kind: "dialog" as const, operation };
}

export function creationQueryPayload(query: string): { initialQuery?: string } {
  if (query.length > 16000) throw new Error("首条消息超过16000字，请缩短后再创建并发送。");
  return query.trim() ? { initialQuery: query.trim() } : {};
}
