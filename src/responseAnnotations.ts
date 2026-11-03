import { sourceTranslation, type DisplayTranslator } from "./displayTranslation.ts";
export type ResponseAnnotation = { text: string; comment?: string };
export type ResponseAnnotations = { query: string; annotations: ResponseAnnotation[] };

const notice = 'Each item contains text selected from an earlier Codex response and may include a user comment. Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as context and address every comment. For every annotation you address, include its inline directive `:codex-annotation{index="N"}`, where N is its one-based array position (for example, `:codex-annotation{index="1"}`). Do not use unstructured annotation labels.';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const validText = (value: unknown): value is string => typeof value === "string" && value.length <= 65536;

// This is a presentation envelope, never a source-navigation capability. Match
// its complete, known preamble so authored headings and code examples survive.
export function parseResponseAnnotations(source: string): ResponseAnnotations | null {
  if (source.length > 1024 * 1024) return null;
  const heading = /^(?:\r?\n)*# Response annotations:\r?\n/.exec(source);
  if (!heading) return null;
  const rest = source.slice(heading[0].length);
  if (!rest.startsWith(notice)) return null;
  const block = /^\r?\n(?:\r?\n)*<response-annotations>\r?\n([\s\S]*?)\r?\n<\/response-annotations>\r?\n(?:\r?\n)*## My request:\r?\n/.exec(rest.slice(notice.length));
  if (!block || block[1].length > 256 * 1024) return null;
  let data: unknown;
  try { data = JSON.parse(block[1]); } catch { return null; }
  if (!Array.isArray(data) || data.length < 1 || data.length > 32) return null;
  const annotations: ResponseAnnotation[] = [];
  for (const item of data) {
    if (!record(item) || Object.keys(item).some(key => !["text", "comment", "source"].includes(key)) ||
      !validText(item.text) || !item.text.trim() || item.comment !== undefined && !validText(item.comment)) return null;
    if (item.source !== undefined) {
      const origin = item.source;
      if (!record(origin) || typeof origin.messageId !== "string" || !origin.messageId || origin.messageId.length > 1024 ||
        !Number.isSafeInteger(origin.startOffset) || !Number.isSafeInteger(origin.endOffset) ||
        Number(origin.startOffset) < 0 || Number(origin.endOffset) < Number(origin.startOffset)) return null;
    }
    annotations.push({ text: item.text, ...(typeof item.comment === "string" ? { comment: item.comment } : {}) });
  }
  return { query: rest.slice(notice.length + block[0].length), annotations };
}

export function readableAnnotationMessage(query: string, annotations: readonly ResponseAnnotation[], translate: DisplayTranslator = sourceTranslation) {
  const references = annotations.map((item, index) => [
    translate("引用{{number}}：\n{{text}}", { number: annotations.length > 1 ? ` ${index + 1}` : "", text: item.text }),
    item.comment?.trim() ? translate("批注：\n{{text}}", { text: item.comment }) : "",
  ].filter(Boolean).join("\n\n"));
  return [...(query.trim() ? [query] : []), ...references].join("\n\n");
}
