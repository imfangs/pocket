import type { Message } from "./conversationFeed";

const scalarFields = [
  "role", "turnId", "phase", "text", "isQuestion", "truncated", "origin",
  "clientMessageId", "turnDurationMs", "timestamp",
] as const satisfies readonly (keyof Message)[];

// These values come from JSON feeds. Compare their structure without treating
// undefined as null or allocating another copy of the complete message text.
function sameReferenceValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameReferenceValue(value, right[index]));
  }
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key =>
    Object.hasOwn(b, key) && sameReferenceValue(a[key], b[key]));
}

function sameDisplayMessage(left: Message, right: Message) {
  return scalarFields.every(field => Object.is(left[field], right[field])) &&
    sameReferenceValue(left.images, right.images) &&
    sameReferenceValue(left.files, right.files) &&
    sameReferenceValue(left.attachments, right.attachments);
}

// Presentation only: source arrays still own receipts, capabilities and reading
// evidence. Keep the first exact row and its original object; conflicting rows
// and rows without a usable ID remain visible in their original order.
export function uniqueDisplayMessages(messages: readonly Message[]): Message[] {
  const byId = new Map<string, Message[]>(), visible: Message[] = [];
  for (const message of messages) {
    if (typeof message.id !== "string" || !message.id.trim()) {
      visible.push(message);
      continue;
    }
    const previous = byId.get(message.id);
    if (previous?.some(candidate => sameDisplayMessage(candidate, message))) continue;
    if (previous) previous.push(message); else byId.set(message.id, [message]);
    visible.push(message);
  }
  return visible;
}

// Callers count occurrences among the exact same ID in the rendered list.
// A conflicting same-ID row must not reuse the first row's React key. JSON
// framing also avoids collisions with IDs containing any separator or suffix.
export function renderMessageKey(message: Message, indexAmongSameId = 0): string {
  return JSON.stringify(["display-message", message.id, indexAmongSameId]);
}
