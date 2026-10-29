import { localFileReference } from "../shared/codex-directives.mjs";
import type { MessageFileReference, MessageFiles } from "./conversationFeed";

const fileRoute = /^\/api\/tasks\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/files\/[a-f0-9]{64}$/i;

export function safeMessageFile(value: unknown, threadId?: string): MessageFileReference | null {
  if (!value || typeof value !== "object" || typeof threadId !== "string") return null;
  const file = value as Partial<MessageFileReference>;
  const match = typeof file.url === "string" && fileRoute.exec(file.url);
  if (!match || match[1].toLowerCase() !== threadId.toLowerCase() || typeof file.name !== "string" ||
      !file.name.trim() || /[\u0000-\u001f\u007f/\\]/.test(file.name)) return null;
  return { url: file.url!, name: file.name };
}

export function registeredMessageFile(value: string, files?: MessageFiles, threadId?: string): MessageFileReference | null {
  if (!files) return null;
  for (const source of [localFileReference(value), localFileReference(value, true)]) {
    if (source && Object.hasOwn(files, source)) return safeMessageFile(files[source], threadId);
  }
  return null;
}
