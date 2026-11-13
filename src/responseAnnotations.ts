import { sourceTranslation, type DisplayTranslator } from "./displayTranslation.ts";
import { userAttachmentEnvelope } from "../shared/user-attachment-envelope.mjs";
export type ResponseAnnotation = { text: string; comment?: string };
type AnnotationAttachment = { name: string; kind: "image" | "file" };
export type ResponseAnnotations = { query: string; annotations: ResponseAnnotation[]; envelopeAttachments?: AnnotationAttachment[] };

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
  const block = /^\r?\n(?:\r?\n)*<response-annotations>\r?\n([\s\S]*?)\r?\n<\/response-annotations>/.exec(rest.slice(notice.length));
  if (!block || block[1].length > 256 * 1024) return null;
  const tail = rest.slice(notice.length + block[0].length);
  const request = /^\r?\n(?:\r?\n)*## My request:\r?\n/.exec(tail);
  let query: string;
  let envelopeAttachments: AnnotationAttachment[] | undefined;
  if (request) query = tail.slice(request[0].length);
  else {
    // Native annotation + attachment messages put the generated file context
    // between these two envelopes. Reuse its bounded presentation schema;
    // source paths remain metadata and never become file/image capabilities.
    const attachmentTail = tail.replace(/^(?:\r?\n)+/, "\n");
    const files = userAttachmentEnvelope(attachmentTail) ||
      (!attachmentTail.endsWith("\n") && userAttachmentEnvelope(attachmentTail + "\n"));
    if (!files) return null;
    // The native reading projection can append its unavailable-image notice
    // after the formatter's newline. Supplying a presentation-only terminator
    // validates that complete shape without changing any canonical input.
    // With no image transport, keep the exact displayed query bytes. This
    // composite native projection has no provenance flag identifying a final
    // newline as formatter-owned, so it must not trim a user's final newline.
    query = files.query + (!files.imageTransport && attachmentTail.endsWith("\n") ? "\n" : "");
    envelopeAttachments = files.attachments.map(({ name, kind }) => ({ name, kind }));
  }
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
  return { query, annotations, ...(envelopeAttachments ? { envelopeAttachments } : {}) };
}

export function readableAnnotationMessage(query: string, annotations: readonly ResponseAnnotation[], translate: DisplayTranslator = sourceTranslation) {
  const references = annotations.map((item, index) => [
    translate("引用{{number}}：\n{{text}}", { number: annotations.length > 1 ? ` ${index + 1}` : "", text: item.text }),
    item.comment?.trim() ? translate("批注：\n{{text}}", { text: item.comment }) : "",
  ].filter(Boolean).join("\n\n"));
  return [...(query.trim() ? [query] : []), ...references].join("\n\n");
}
