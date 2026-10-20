import { Code2, Maximize2, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import CopyButton from "./CopyButton";
import { useDiagramPreview } from "./ImagePreviewProvider";
import { diagramDataUrl, type DiagramResult } from "./mermaidPolicy";
import { renderDiagram } from "./mermaidRenderer";
import "./mermaid.css";

export default function MermaidBlock({ source, complete }: { source: string; complete: boolean }) {
  const frame = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false), [width, setWidth] = useState(320);
  const [dark, setDark] = useState(() => typeof document !== "undefined" && document.documentElement.dataset.theme === "dark");
  const [result, setResult] = useState<{ source: string; width: number; value: DiagramResult } | null>(null);
  const [sourceChoice, setSourceChoice] = useState(false), [attempt, setAttempt] = useState(0);
  const openDiagram = useDiagramPreview();
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(280, Math.min(720, Math.round((element.clientWidth - 24) / 40) * 40)));
    measure();
    const resize = new ResizeObserver(measure); resize.observe(element);
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: "160px" });
    observer.observe(element);
    return () => { observer.disconnect(); resize.disconnect(); };
  }, []);
  useEffect(() => {
    const changed = () => setDark(document.documentElement.dataset.theme === "dark");
    window.addEventListener("pocket-theme-changed", changed);
    return () => window.removeEventListener("pocket-theme-changed", changed);
  }, []);
  // The shared renderer owns a bounded cache. Off-screen messages must not each
  // retain another full SVG and encoded data URL after scrolling a long chat.
  useEffect(() => { if (!visible) setResult(null); }, [visible]);
  useEffect(() => {
    if (!complete || !visible) return;
    const controller = new AbortController();
    renderDiagram(source, width, controller.signal, attempt > 0)
      .then(value => { if (!controller.signal.aborted) setResult({ source, width, value }); })
      .catch(() => { if (!controller.signal.aborted) setResult({ source, width, value: { ok: false, reason: "unavailable" } }); });
    return () => controller.abort();
  }, [source, width, complete, visible, attempt]);
  const current = complete && result?.source === source ? result.value : null;
  const url = useMemo(() => {
    try { return current?.ok ? diagramDataUrl(current.svg, dark) : null; } catch { return null; }
  }, [current, dark]);
  const showSource = sourceChoice || !url;
  const failure = current?.ok === false ? current.reason : current?.ok && !url ? "invalid" : null;
  const note = !complete ? "绘制完成后显示图表" : !visible ? "" : failure === "unsupported" ? "此类图表暂以源码显示"
    : failure === "limit" || failure === "timeout" ? "图表较复杂，已保留源码" : failure ? "暂时无法绘制，已保留源码" : !current ? "正在绘制…" : "";
  return <div className="code-block mermaid-block" data-diagram-state={!complete ? "incomplete" : !visible ? "deferred" : failure || (url ? "ready" : "loading")}>
    <div className="code-block-header">
      <span>图表</span>
      <div className="diagram-actions">
        {url && <button type="button" className="diagram-source-toggle" aria-pressed={sourceChoice} onClick={() => setSourceChoice(value => !value)}><Code2 size={14} aria-hidden="true" />源码</button>}
        {failure && failure !== "unsupported" && failure !== "limit" && <button type="button" aria-label="重试绘制" onClick={() => { setResult(null); setAttempt(value => value + 1); }}><RotateCcw size={15} aria-hidden="true" /></button>}
        <CopyButton text={source} label="复制图表源码" />
      </div>
    </div>
    <div ref={frame} className="diagram-frame">
      {showSource ? <pre tabIndex={0} aria-label="图表源码" onPointerDown={() => setSourceChoice(true)} onFocus={() => setSourceChoice(true)}><code>{source}</code></pre> : <>
        <div className="diagram-preview-scroll" tabIndex={0} role="region" aria-label="图表预览，可上下滚动">
          <button type="button" className="diagram-preview" aria-label="放大查看图表" aria-haspopup="dialog"
            onClick={event => openDiagram(url!, "图表", event.currentTarget)}>
            <img src={url!} alt="Mermaid 图表，可查看源码或放大" decoding="async" draggable={false}
              onError={() => setResult({ source, width, value: { ok: false, reason: "invalid" } })} />
          </button>
        </div>
        <span className="diagram-enlarge"><Maximize2 size={14} aria-hidden="true" />放大</span>
      </>}
      {note && <span className="diagram-note" role="status">{note}</span>}
    </div>
  </div>;
}
