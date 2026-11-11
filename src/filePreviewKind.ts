import { isMessageAudio } from "../shared/message-media.mjs";

export type RichFilePreviewKind = "pdf" | "svg" | "audio" | "docx" | "xlsx" | "pptx" | "archive";

export function richFilePreviewKind(name: string): RichFilePreviewKind | null {
  if (typeof name !== "string" || name.length > 4096 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  if (isMessageAudio(name)) return "audio";
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase();
  if (extension === "zip") return "archive";
  return extension && ["pdf", "svg", "docx", "xlsx", "pptx"].includes(extension) ? extension as RichFilePreviewKind : null;
}

export const richFilePreviewBytes = (kind: RichFilePreviewKind) => kind === "svg" ? 1024 * 1024 : 20 * 1024 * 1024;
