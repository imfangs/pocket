import { parseOfficePreviewBytes } from "./officePreviewParse";
import { OfficePreviewError, type OfficePreviewKind } from "./officePreviewTypes";

self.onmessage = async (event: MessageEvent<{ blob: Blob; kind: OfficePreviewKind }>) => {
  try {
    const data = await parseOfficePreviewBytes(new Uint8Array(await event.data.blob.arrayBuffer()), event.data.kind);
    self.postMessage({ ok: true, data });
  } catch (error) {
    self.postMessage({ ok: false, code: error instanceof OfficePreviewError ? error.code : "invalid" });
  }
};
