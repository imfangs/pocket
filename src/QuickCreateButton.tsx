import { ClipboardPlus, LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "./api";
import { holdReload } from "./updateSafety";
import { prepareQuickCreate, type QuickCreateInput } from "./quickCreate";
import type { CreateLocation } from "./taskOperations";

export default function QuickCreateButton({ disabled, onCreate, onFallback, onError, onBusyChange }: {
  disabled: boolean;
  onCreate: (input: QuickCreateInput) => Promise<unknown>;
  onFallback: (text: string, hint: string) => Promise<void>;
  onError: (message: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const submitting = useRef(false), [busy, setBusy] = useState(false);
  const start = async () => {
    if (disabled || submitting.current) return;
    submitting.current = true; setBusy(true); onBusyChange(true);
    const release = holdReload("正在读取剪贴板并新建会话，请稍后更新。");
    try {
      const result = await prepareQuickCreate({
        readClipboard: () => navigator.clipboard.readText(),
        readLocations: () => api<{ available: boolean; locations: CreateLocation[] }>("/api/tasks/create-options"),
      });
      if (result.kind === "ready") await onCreate(result.input);
      else await onFallback(result.text, result.hint);
    } catch (error) { onError((error as Error).message); }
    finally { release(); submitting.current = false; setBusy(false); onBusyChange(false); }
  };
  return <button type="button" className="quick-create-button" disabled={disabled || busy}
    aria-label="从剪贴板新建并发送" title="读取剪贴板文字，沿用上次目录新建并发送" onClick={() => void start()}>
    {busy ? <LoaderCircle size={16} aria-hidden="true" /> : <ClipboardPlus size={16} aria-hidden="true" />}
    <span>{busy ? "正在新建…" : "剪贴板新建"}</span>
  </button>;
}
