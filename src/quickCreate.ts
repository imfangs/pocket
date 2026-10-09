import { creationDirectories, creationLocation } from "./creationLocations.ts";
import { readCreationPreference, type CreationPreference } from "./creationPreference.ts";
import type { CreateLocation } from "./taskOperations.ts";

export type QuickCreateInput = { locationId: string; initialQuery: string };
export type QuickCreatePreparation = { kind: "ready"; input: QuickCreateInput }
  | { kind: "choose" | "paste"; text: string; hint: string };

export async function prepareQuickCreate(options: {
  readClipboard: () => Promise<string>;
  readLocations: () => Promise<{ available: boolean; locations: CreateLocation[] }>;
  readPreference?: () => CreationPreference | null;
}): Promise<QuickCreatePreparation> {
  // Invoke readText in the original click before awaiting any network request:
  // Safari ties clipboard access to that user activation.
  let text: string;
  try { text = await options.readClipboard(); }
  catch { return { kind: "paste", text: "", hint: "浏览器未能读取剪贴板，请在首条消息中长按粘贴。" }; }
  if (!text.trim()) throw new Error("剪贴板里没有文字，请先复制要发送的内容。");
  if (text.length > 16000) throw new Error("剪贴板文字超过16000字，请先缩短后再新建。");
  text = text.trim();
  const saved = (options.readPreference ?? readCreationPreference)();
  if (!saved?.locationId) return { kind: "choose", text, hint: "先选一次工作目录和项目，以后即可从剪贴板一键新建。" };
  const result = await options.readLocations();
  if (!result.available) throw new Error("暂时无法读取工作目录，请稍后重试。");
  const location = creationLocation(creationDirectories(result.locations), saved.cwd, saved.locationId);
  // A single new project at the same path must not replace the remembered one.
  if (!location || location.id !== saved.locationId)
    return { kind: "choose", text, hint: "上次的目录或项目已不可用，请为这条消息重新选择。" };
  return { kind: "ready", input: { locationId: location.id, initialQuery: text } };
}
