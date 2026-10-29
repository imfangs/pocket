import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { LoaderCircle, MessageSquareWarning } from "lucide-react";
import { Modal } from "./Dialogs";
import { Button } from "./ui/Button";
import { api } from "./api";
import { currentMachineId } from "./machineScope";
import { feedbackDrafts } from "./feedbackClient";
import { feedbackReplayContext } from "./usageAnalytics";
import { readAutoDirectPreference } from "./sendingPreference";
import { createAppUpdate } from "./appUpdate";
import { getReloadBlocker } from "./updateSafety";
import { captureFeedback, type FeedbackCapture } from "../packages/feedback-kit/browser/capture.ts";
import { bindShakeFeedback, requestShakePermission } from "../packages/feedback-kit/browser/shake.ts";
import type { FeedbackContext, FeedbackInput, FeedbackReceipt } from "../packages/feedback-kit/contracts.ts";
import type { FeedbackPanelProps } from "../packages/feedback-kit/react/FeedbackPanel.tsx";
import "./pocket-feedback.css";

function FeedbackPanelLoader(props: FeedbackPanelProps) {
  const [Panel, setPanel] = useState<ComponentType<FeedbackPanelProps> | null>(null);
  const [failed, setFailed] = useState(false), [busy, setBusy] = useState(false), [hint, setHint] = useState("");
  const [recovery] = useState(() => createAppUpdate({
    currentId: typeof __POCKET_BUILD_ID__ === "string" ? __POCKET_BUILD_ID__ : "development",
    request: (input, init) => fetch(input, init), blocker: getReloadBlocker, onAvailable() {},
    entryUrl: () => location.pathname + location.search,
    reload: () => location.reload(),
  }));
  useEffect(() => {
    let active = true;
    recovery.resume();
    // Loading an optional tool must not unmount the conversation on weak networks.
    void import("../packages/feedback-kit/react/FeedbackPanel.tsx")
      .then(module => { if (active) setPanel(() => module.default); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; recovery.stop(); };
  }, [recovery]);
  if (Panel) return <Panel {...props} />;
  return failed ? <section className="feedback-load-failure" role="alert">
    <p>反馈组件未能载入，请联网后重新加载 Pocket。</p>
    {hint && <p role="status">{hint}</p>}
    <Button type="button" variant="soft" disabled={busy} onClick={async () => {
      setBusy(true); setHint("");
      const result = await recovery.apply({ reloadCurrent: true });
      if (result.status !== "updated") { setBusy(false); setHint(result.reason || "暂时无法重新加载，请稍后再试。"); }
    }}>{busy ? "检查中…" : "重新加载 Pocket"}</Button>
  </section> : <p role="status">正在打开反馈…</p>;
}
const shakeKey = "pocket.feedback-shake-v1";
const shakePreferred = () => { try { return localStorage.getItem(shakeKey) === "on"; } catch { return false; } };
type Session = { scope: string; baseScope: string; context: FeedbackContext; image?: FeedbackCapture };

export function usePocketFeedback({ readingScope, threadId, title }: { readingScope?: string; threadId?: string; title?: string }) {
  const machine = currentMachineId(), baseScope = `pocket:${machine}:${readingScope || "pending"}`;
  const [enabled, setEnabled] = useState(false), [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null), [preparing, setPreparing] = useState(false);
  const [shakeEnabled, setShakeEnabled] = useState(shakePreferred), [shakeHint, setShakeHint] = useState("");
  const current = useRef({ machine, baseScope, threadId, title, enabled, session, preparing });
  current.current = { machine, baseScope, threadId, title, enabled, session, preparing };
  const operation = useRef<AbortController | null>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setEnabled(false); setReady(false);
    void api<{ enabled: boolean }>("/api/feedback/config", "GET", undefined, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setEnabled(result.enabled === true); })
      .catch(() => {}).finally(() => { if (!controller.signal.aborted) setReady(true); });
    return () => controller.abort();
  }, [machine]);
  useEffect(() => { operation.current?.abort(); setSession(null); setPreparing(false); }, [baseScope]);
  useEffect(() => { operation.current?.abort(); setSession(null); setPreparing(false); }, [threadId]);
  const open = useCallback(async (sourceThreadId?: string) => {
    const state = current.current;
    if (!state.enabled || state.preparing || state.session || !state.machine) return;
    operation.current?.abort(); const controller = new AbortController(); operation.current = controller;
    const valid = () => mounted.current && !controller.signal.aborted && operation.current === controller &&
      current.current.baseScope === state.baseScope && current.current.threadId === state.threadId;
    const visual = window.visualViewport;
    const context: FeedbackContext = { pageUrl: location.href, pageTitle: state.title || document.title,
      frontendVersion: typeof __POCKET_BUILD_ID__ === "string" ? __POCKET_BUILD_ID__ : "development",
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
        ...(visual ? { visualWidth: visual.width, visualHeight: visual.height, offsetTop: visual.offsetTop } : {}), scrollX, scrollY },
      ...(sourceThreadId ? { sourceThreadId } : {}), userAgent: navigator.userAgent.slice(0, 500), ...feedbackReplayContext() };
    setPreparing(true);
    try {
      // The info/settings launcher closes first. Other dialogs stay in the
      // captured scene, including an input whose problem is being reported.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!valid()) return;
      let image: FeedbackCapture | undefined;
      try { image = await captureFeedback(document.body, { signal: controller.signal }); }
      catch { /* Text and manual screenshot feedback remain available. */ }
      if (valid()) setSession({ baseScope: state.baseScope, scope: `${state.baseScope}:${sourceThreadId || "list"}`, context, image });
    } finally { if (valid()) { setPreparing(false); operation.current = null; } }
  }, []);
  useEffect(() => bindShakeFeedback({ permission: shakeEnabled ? "granted" : "denied",
    enabled: () => current.current.enabled && !current.current.session && !current.current.preparing,
    onShake: () => open(current.current.threadId) }), [open, shakeEnabled]);
  const toggleShake = async () => {
    if (shakeEnabled) {
      setShakeEnabled(false); setShakeHint(""); try { localStorage.removeItem(shakeKey); } catch {} return;
    }
    const permission = await requestShakePermission(window); // Direct user gesture, before lazy imports.
    if (!mounted.current) return;
    if (permission === "granted") {
      setShakeEnabled(true); setShakeHint(""); try { localStorage.setItem(shakeKey, "on"); } catch {}
    } else setShakeHint(permission === "unsupported" ? "此浏览器暂不支持摇动，可继续点击反馈。" : "未获得运动权限，可继续点击反馈。");
  };
  const own = (value: Session) => {
    if (!mounted.current || current.current.baseScope !== value.baseScope) throw new DOMException("反馈来源已变化", "AbortError");
  };
  const submit = async (value: FeedbackInput, signal: AbortSignal) => {
    const owner = session!; own(owner);
    const result = await api<FeedbackReceipt>("/api/feedback", "POST", value, { signal }); own(owner); return result;
  };
  const status = async (id: string, signal: AbortSignal) => {
    const owner = session!; own(owner);
    try { const result = await api<FeedbackReceipt>(`/api/feedback/${id}`, "GET", undefined, { signal }); own(owner); return result; }
    catch (error) { if ((error as { status?: number }).status === 404) return null; throw error; }
  };
  const retry = async (id: string, signal: AbortSignal) => {
    const owner = session!; own(owner);
    const result = await api<FeedbackReceipt>(`/api/feedback/${id}/retry`, "POST", {}, { signal }); own(owner); return result;
  };
  return {
    enabled, ready, open,
    settings: enabled ? <section className="pocket-feedback-settings" aria-label="使用反馈">
      <h3>使用反馈</h3>
      <label><span>摇一摇反馈</span><input type="checkbox" checked={shakeEnabled} onChange={() => void toggleShake()} /></label>
      <small>{shakeHint || "启用后，摇动手机可打开截图反馈。"}</small>
    </section> : null,
    element: <>
      {preparing && <div className="feedback-capture-progress" data-feedback-ignore="" data-reading-overlay="" role="status">
        <LoaderCircle size={15} className="spinning" />正在准备反馈…
        <button type="button" onClick={() => { operation.current?.abort(); operation.current = null; setPreparing(false); }}>取消</button>
      </div>}
      {session && <Modal title="使用反馈" className="feedback-dialog" captureIgnore onClose={() => setSession(null)}>
          <FeedbackPanelLoader key={session.scope} appId="pocket" scope={session.scope} context={session.context} initialCapture={session.image}
            capture={signal => captureFeedback(document.body, { signal })} draftStore={feedbackDrafts}
            submit={submit} status={status} retry={retry} onClose={() => setSession(null)} autoDirect={readAutoDirectPreference()} />
      </Modal>}
    </>,
    button: (onOpen: () => void) => <Button type="button" variant="soft" color="gray" disabled={!ready} onClick={onOpen}>
      <MessageSquareWarning size={14} aria-hidden="true" />反馈问题
    </Button>,
  };
}
