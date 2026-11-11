import type { api } from "./api";
import type { Catalog, Thread } from "./types";
import { hasPriorityState, pocketPriority } from "./priority.ts";
import { readingCatalogScope } from "./readingCache.ts";

// The write remains explicit and idempotent. A reply from an older reading
// source can confirm its own preference, but must not update the new catalog.
export async function updateThreadPriority(thread: Thread, request: typeof api,
  options: { priority?: boolean; scope?: string; isCurrent?: () => boolean } = {}): Promise<Thread> {
  if (!hasPriorityState(thread)) throw new Error("请更新 Mac 上的 Pocket 后再使用优先关注。");
  const priority = options.priority ?? !pocketPriority(thread);
  const revision = Number.isSafeInteger(thread.pinRevision) && thread.pinRevision! >= 0 ? thread.pinRevision! : 0;
  const assertCurrent = () => { if (options.isCurrent && !options.isCurrent()) throw new Error("会话来源已变化，请重新选择。"); };
  const matches = (value: Thread | undefined): value is Thread => !!value && value.id === thread.id && hasPriorityState(value)
    && value.pocketPriority === priority && Number.isSafeInteger(value.pinRevision) && value.pinRevision! >= revision;
  let result: Thread;
  assertCurrent();
  try {
    result = await request<Thread>(`/api/tasks/${thread.id}/priority`, "POST", { priority }, { signal: AbortSignal.timeout(15000) });
  } catch (error) {
    assertCurrent();
    const status = (error as Error & { status?: number }).status;
    if (status && status < 500) throw error;
    // Only read back after an uncertain response; no automatic second POST.
    try {
      const fresh = await request<Catalog>("/api/catalog", "GET", undefined, { signal: AbortSignal.timeout(15000) });
      assertCurrent();
      if (options.scope && readingCatalogScope(fresh) !== options.scope) throw error;
      const confirmed = fresh.threads.find(item => item.id === thread.id);
      if (!matches(confirmed)) throw error;
      result = confirmed;
    } catch { assertCurrent(); throw new Error("关注状态尚未确认，请刷新后再试。"); }
  }
  assertCurrent();
  if (!matches(result)) throw new Error("关注状态尚未确认，请刷新后再试。");
  return result;
}
