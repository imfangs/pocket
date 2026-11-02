import type { api } from "./api";
import type { Catalog, Thread } from "./types";

type HiddenState = { pocketHidden?: unknown; hiddenRevision?: unknown };

export const pocketHidden = (thread: HiddenState) => thread.pocketHidden === true;
export function hasHiddenState(thread: HiddenState): thread is { pocketHidden: boolean; hiddenRevision: number } {
  return typeof thread.pocketHidden === "boolean" && Number.isSafeInteger(thread.hiddenRevision) && Number(thread.hiddenRevision) >= 0;
}
export function hiddenFields(thread: HiddenState) {
  return hasHiddenState(thread) ? { pocketHidden: thread.pocketHidden, hiddenRevision: thread.hiddenRevision } : {};
}

// A lost response may follow a committed preference write. Read the current
// projection before inviting another click; never repeat a toggle implicitly.
export async function updateThreadHidden(thread: Thread, request: typeof api,
  options: { hidden?: boolean; scope?: string; isCurrent?: () => boolean } = {}): Promise<Thread> {
  if (!hasHiddenState(thread)) throw new Error("请更新 Mac 上的 Pocket 后再使用隐藏。");
  const hidden = options.hidden ?? !pocketHidden(thread);
  const assertCurrent = () => { if (options.isCurrent && !options.isCurrent()) throw new Error("会话来源已变化，请重新选择。"); };
  const revision = thread.hiddenRevision;
  const matches = (value: Thread | undefined): value is Thread => !!value && value.id === thread.id && hasHiddenState(value)
    && value.pocketHidden === hidden && value.hiddenRevision >= revision;
  let result: Thread;
  assertCurrent();
  try {
    const response = await request<Thread & { visibilityScope?: string }>(`/api/tasks/${thread.id}/hidden`, "POST",
      { hidden, ...(options.scope ? { scope: options.scope } : {}) }, { signal: AbortSignal.timeout(15000) });
    if (options.scope && response.visibilityScope !== options.scope) throw Object.assign(new Error("会话来源已变化，请重新选择。"), { status: 409 });
    result = response;
  } catch (error) {
    assertCurrent();
    const status = (error as Error & { status?: number }).status;
    if (status && status < 500) throw error;
    try {
      const catalog = await request<Catalog>("/api/catalog", "GET", undefined, { signal: AbortSignal.timeout(15000) });
      assertCurrent();
      if (options.scope && catalog.sourceInfo?.pocketRead?.scope !== options.scope) throw error;
      const confirmed = catalog.threads.find(item => item.id === thread.id);
      if (!matches(confirmed)) throw error;
      result = confirmed;
    } catch { assertCurrent(); throw new Error("隐藏状态尚未确认，请刷新后再试。"); }
  }
  assertCurrent();
  if (!matches(result)) throw new Error("隐藏状态尚未确认，请刷新后再试。");
  return result;
}
