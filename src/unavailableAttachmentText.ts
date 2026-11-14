// Older clients still read the server's generated generic placeholder. Hide
// exactly that one suffix only when its descriptive projection proves origin.
export function unavailableAttachmentText(text: string, count: number, generated: boolean) {
  if (!generated || count < 1) return text;
  const placeholder = count === 1 ? "[附件需在 Mac 中查看]" : `[${count} 个附件需在 Mac 中查看]`;
  if (text === placeholder) return "";
  const suffix = "\n\n" + placeholder;
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}
