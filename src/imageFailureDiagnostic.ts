import { clientVersionHeaders } from "./clientVersion.ts";
import { checkMachineResponse, currentMachineId, machineApiPath, type MachineId } from "./machineScope.ts";
import { createRequestDeadline } from "./requestDeadline.ts";

export const imageReadPermissionMessage = "Mac 服务无权读取这张图片，请在电脑上检查文件访问权限";
const registeredImage = /^\/api\/tasks\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/images\/[a-f0-9]{64}$/i;
const maxErrorBytes = 1024;

// Only an already registered image that failed to decode may use this bounded
// diagnostic. A successful response is cancelled without reading image bytes.
export async function diagnoseImageFailure(src: string, machine: MachineId | null, signal: AbortSignal,
  request: typeof fetch = (...args) => fetch(...args)): Promise<"permission" | null> {
  if (!registeredImage.test(src) || !machine || machine !== currentMachineId() || signal.aborted) return null;
  const deadline = createRequestDeadline(signal, 3000);
  let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelRead = () => { void reader?.cancel().catch(() => {}); };
  try {
    response = await request(machineApiPath(src, machine), { method: "GET", cache: "no-store", mode: "same-origin",
      credentials: "same-origin", redirect: "error", signal: deadline.signal, headers: { ...clientVersionHeaders(), Accept: "application/json" } });
    checkMachineResponse(response, machine);
    if (response.status !== 403 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")
      || Number(response.headers.get("Content-Length")) > maxErrorBytes || !response.body) return null;
    reader = response.body.getReader();
    deadline.signal.addEventListener("abort", cancelRead, { once: true });
    deadline.signal.throwIfAborted();
    const bytes = new Uint8Array(maxErrorBytes); let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      deadline.signal.throwIfAborted();
      if (done) break;
      if (length + value.byteLength > maxErrorBytes) return null;
      bytes.set(value, length); length += value.byteLength;
    }
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    return !signal.aborted && machine === currentMachineId() && typeof data === "object" && data !== null
      && "error" in data && data.error === imageReadPermissionMessage ? "permission" : null;
  } catch { return null; }
  finally {
    deadline.signal.removeEventListener("abort", cancelRead);
    try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch { /* Aborted transport is already released. */ }
    deadline.dispose();
  }
}
