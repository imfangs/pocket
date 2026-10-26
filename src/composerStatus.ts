import type { History } from "./conversationFeed";

const routineDesktopHints = new Set([
  "消息会在 Mac 的原任务中运行，沿用原模型与权限。",
  "消息会在 Mac 的会话中运行，沿用原模型与权限。",
  "正在运行，新消息默认进入 Pocket 待发列表。",
]);

// Hide a known explanation only when its structured state has its own visible
// control or card. Unfamiliar restrictions still need their original message.
export function desktopComposerHint(history: History | null) {
  if (!history || history.source !== "desktop") return undefined;
  const hint = history.hint;
  if (history.canSend && routineDesktopHints.has(hint)) return undefined;
  if (history.compaction?.active && hint === "正在压缩上下文，完成后可继续。") return undefined;
  if (history.pendingRequests?.length && hint === "任务正在等待你确认操作，可在下方查看并响应。") return undefined;
  return hint?.replaceAll("原任务", "会话").replaceAll("原会话", "会话");
}

// An accepted request has its own reading-bar control, even while history is
// catching up. Only a submission or an unknown result needs the larger editor.
export function compactionKeepsComposerExpanded(status?: string) {
  return status === "pending" || status === "unknown";
}
