export const maxTextFilePreviewBytes = 1024 * 1024;
export const textFileTooLarge = "文件较大，请下载后查看。";

export function messageFileTextFormat(name: string): "markdown" | "html" | "text" | null {
  if (/\.(?:md|markdown)$/i.test(name)) return "markdown";
  if (/\.html?$/i.test(name)) return "html";
  if (/\.(?:txt|text|log|json|jsonl|csv|tsv|ya?ml|toml|ini|conf|xml|html?|css|scss|less|svg|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|swift|sh|bash|zsh|sql|c|h|cc|cpp|hpp|diff|patch|mmd|mdx)$/i.test(name) ||
      /^(?:readme|license|licence|notice|changelog|makefile|dockerfile|\.gitignore|\.gitattributes)$/i.test(name)) return "text";
  return null;
}

export async function decodeMessageFileText(blob: Blob): Promise<string> {
  if (blob.size > maxTextFilePreviewBytes) throw new Error(textFileTooLarge);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) throw new Error("binary");
    return text;
  } catch {
    throw new Error("此文件暂不支持文本预览，请下载后查看。");
  }
}
