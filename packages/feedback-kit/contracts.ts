export const FEEDBACK_SCHEMA_VERSION = 1 as const;
export const FEEDBACK_LIMITS = Object.freeze({
  annotations: 8, noteCharacters: 2000, annotationNoteCharacters: 500,
  imageBytes: 2 * 1024 * 1024, totalImageBytes: 4 * 1024 * 1024,
  imageSide: 4096, imagePixels: 8 * 1024 * 1024,
});
export type FeedbackReason = "unspecified" | "slow" | "unresponsive" | "position" | "hard_to_find" | "other";
export type FeedbackAnnotation = { id: string; x: number; y: number; width: number; height: number; note: string };
export type FeedbackImage = { kind: "original" | "annotated"; mime: "image/png" | "image/jpeg"; width: number; height: number; base64: string };
export type FeedbackViewport = { width: number; height: number; dpr: number; visualWidth?: number; visualHeight?: number; offsetTop?: number; scrollX?: number; scrollY?: number };
export type FeedbackContext = {
  pageUrl: string; pageTitle: string; frontendVersion: string; viewport: FeedbackViewport;
  sourceThreadId?: string; userAgent?: string; distinctId?: string; sessionId?: string; replayUrl?: string;
};
export type FeedbackInput = {
  schemaVersion: 1; id: string; appId: string; note: string; reason: FeedbackReason;
  context: FeedbackContext; annotations: FeedbackAnnotation[]; images: FeedbackImage[]; autoDirect: boolean;
};
export type FeedbackStatus = "received" | "waiting_webhook" | "sending" | "queued" | "delivered" | "needs_attention";
export type FeedbackReceipt = {
  schemaVersion: 1; id: string; sourceMachine: string; appId: string; digest: string;
  status: FeedbackStatus; createdAt: number; updatedAt: number; code?: string; requestId: string;
};
export type FeedbackTarget = { machineId: string; key: string };

export class FeedbackError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "invalid_feedback") {
    super(message); this.name = "FeedbackError"; this.status = status; this.code = code;
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MACHINE = /^[a-z][a-z0-9-]{0,31}$/;
const APP = /^[a-z][a-z0-9_-]{0,63}$/;
const reasons = new Set<FeedbackReason>(["unspecified", "slow", "unresponsive", "position", "hard_to_find", "other"]);
const fail = (message = "反馈格式无效") => { throw new FeedbackError(message); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return fail();
  return value as Record<string, unknown>;
}
function string(value: unknown, limit: number, required = false): string {
  if (typeof value !== "string" || value.length > limit || /\u0000/.test(value) || required && !value.trim()) return fail();
  return value;
}
function number(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) return fail();
  return value;
}
export function validateFeedbackId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) return fail("反馈编号无效");
  return value.toLowerCase();
}
export function validateMachineId(value: unknown): string {
  if (typeof value !== "string" || !MACHINE.test(value)) return fail("反馈来源无效");
  return value;
}
export function validateFeedbackTarget(value: unknown): FeedbackTarget {
  const data = object(value, ["machineId", "key"]);
  return { machineId: validateMachineId(data.machineId), key: string(data.key, 200, true) };
}
function pageUrl(value: unknown): string {
  const raw = string(value, 2048);
  if (!raw) return "";
  try {
    const url = new URL(raw, "https://feedback.invalid");
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return fail("页面地址无效");
    // A screenshot locator is informational, never a fetch capability. Do not
    // carry common credentials into analytics merely because a page uses them.
    for (const key of [...url.searchParams.keys()])
      if (/(?:token|secret|password|authorization|api[_-]?key|code)/i.test(key)) url.searchParams.delete(key);
    url.hash = "";
    return url.origin === "https://feedback.invalid" ? url.pathname + url.search : url.href;
  } catch { return fail("页面地址无效"); }
}
function context(value: unknown): FeedbackContext {
  const data = object(value, ["pageUrl", "pageTitle", "frontendVersion", "viewport", "sourceThreadId", "userAgent", "distinctId", "sessionId", "replayUrl"]);
  const view = object(data.viewport, ["width", "height", "dpr", "visualWidth", "visualHeight", "offsetTop", "scrollX", "scrollY"]);
  const viewport: FeedbackViewport = { width: number(view.width, 1, 20000), height: number(view.height, 1, 20000), dpr: number(view.dpr, .1, 16) };
  for (const key of ["visualWidth", "visualHeight", "offsetTop", "scrollX", "scrollY"] as const)
    if (view[key] !== undefined) viewport[key] = number(view[key], key === "scrollX" || key === "scrollY" ? -10000000 : 0, 10000000);
  const result: FeedbackContext = { pageUrl: pageUrl(data.pageUrl), pageTitle: string(data.pageTitle, 300),
    frontendVersion: string(data.frontendVersion, 160), viewport };
  if (data.sourceThreadId !== undefined) result.sourceThreadId = validateFeedbackId(data.sourceThreadId);
  if (data.userAgent !== undefined) result.userAgent = string(data.userAgent, 500);
  if (data.distinctId !== undefined) result.distinctId = string(data.distinctId, 200);
  if (data.sessionId !== undefined) result.sessionId = validateFeedbackId(data.sessionId);
  if (data.replayUrl !== undefined) result.replayUrl = pageUrl(data.replayUrl);
  return result;
}
export function feedbackImageBytes(image: FeedbackImage): number {
  return image.base64.length / 4 * 3 - (image.base64.endsWith("==") ? 2 : image.base64.endsWith("=") ? 1 : 0);
}
/** Normalization is shared by clients and the authenticated host adapter. */
export function normalizeFeedbackInput(value: unknown): FeedbackInput {
  const data = object(value, ["schemaVersion", "id", "appId", "note", "reason", "context", "annotations", "images", "autoDirect"]);
  if (data.schemaVersion !== 1 || typeof data.appId !== "string" || !APP.test(data.appId)) return fail();
  const note = string(data.note ?? "", FEEDBACK_LIMITS.noteCharacters).trim();
  const reason = data.reason ?? "unspecified";
  if (!reasons.has(reason as FeedbackReason)) return fail();
  if (!Array.isArray(data.annotations ?? []) || (data.annotations as unknown[] | undefined)?.length! > FEEDBACK_LIMITS.annotations) return fail("最多标注8处");
  const ids = new Set<string>();
  const annotations = ((data.annotations ?? []) as unknown[]).map(value => {
    const item = object(value, ["id", "x", "y", "width", "height", "note"]);
    const id = validateFeedbackId(item.id);
    if (ids.has(id)) return fail("标注编号重复"); ids.add(id);
    const result = { id, x: number(item.x, 0, 1), y: number(item.y, 0, 1),
      width: number(item.width, .000001, 1), height: number(item.height, .000001, 1), note: string(item.note ?? "", FEEDBACK_LIMITS.annotationNoteCharacters).trim() };
    if (result.x + result.width > 1.000001 || result.y + result.height > 1.000001) return fail("标注超出图片");
    return result;
  });
  if (!Array.isArray(data.images ?? []) || (data.images as unknown[] | undefined)?.length! > 2) return fail("反馈最多包含原图和标注图");
  const kinds = new Set<string>(); let total = 0;
  const images = ((data.images ?? []) as unknown[]).map(value => {
    const image = object(value, ["kind", "mime", "width", "height", "base64"]);
    if (!["original", "annotated"].includes(String(image.kind)) || kinds.has(String(image.kind)) || !["image/png", "image/jpeg"].includes(String(image.mime))) return fail("截图格式无效");
    kinds.add(String(image.kind));
    const width = number(image.width, 1, FEEDBACK_LIMITS.imageSide), height = number(image.height, 1, FEEDBACK_LIMITS.imageSide);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width * height > FEEDBACK_LIMITS.imagePixels) return fail("截图尺寸过大");
    const base64 = string(image.base64, Math.ceil(FEEDBACK_LIMITS.imageBytes / 3) * 4, true);
    if (base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) return fail("截图编码无效");
    const result = { kind: image.kind, mime: image.mime, width, height, base64 } as FeedbackImage;
    const bytes = feedbackImageBytes(result);
    if (!bytes || bytes > FEEDBACK_LIMITS.imageBytes) return fail("截图超过2MiB"); total += bytes;
    return result;
  });
  if (total > FEEDBACK_LIMITS.totalImageBytes || annotations.length && !kinds.has("original") || kinds.has("annotated") && !kinds.has("original")) return fail("标注需要对应原图");
  if (!note && reason === "unspecified" && !images.length && !annotations.some(item => item.note)) return fail("请附上截图或说一句哪里不顺");
  if (data.autoDirect !== undefined && typeof data.autoDirect !== "boolean") return fail();
  return { schemaVersion: 1, id: validateFeedbackId(data.id), appId: data.appId, note, reason: reason as FeedbackReason,
    context: context(data.context), annotations, images, autoDirect: data.autoDirect === true };
}
