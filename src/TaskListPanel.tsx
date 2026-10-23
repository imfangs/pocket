import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowDown, RefreshCw } from "lucide-react";
import { bindPullToRefresh } from "./pullToRefresh";

export default function TaskListPanel({ children, busy, onRefresh, scrollRef, inert = false, feedback }: {
  children: ReactNode;
  busy: boolean;
  onRefresh: () => Promise<void>;
  scrollRef?: RefObject<HTMLElement | null>;
  inert?: boolean;
  feedback?: ReactNode;
}) {
  const ownPanel = useRef<HTMLElement>(null);
  const panel = scrollRef ?? ownPanel;
  const latest = useRef({ busy, onRefresh });
  const [pull, setPull] = useState({ distance: 0, refreshing: false, armed: false });
  useLayoutEffect(() => { latest.current = { busy, onRefresh }; }, [busy, onRefresh]);
  useEffect(() => {
    if (!panel.current) return;
    return bindPullToRefresh(panel.current, {
      canRefresh: () => !latest.current.busy,
      refresh: () => latest.current.onRefresh(),
      onChange: setPull,
    });
  }, []);
  const visible = pull.distance > 0 || pull.refreshing;
  return (
    <section className="list-panel" ref={panel} aria-label="会话列表" inert={inert}>
      <div className="pull-refresh-indicator" data-loading={pull.refreshing || undefined}
        style={{ opacity: visible ? 1 : 0 }} role="status" aria-live="polite">
        {visible && <>{pull.refreshing ? <RefreshCw size={15} /> : <ArrowDown size={15} />}
          <span>{pull.refreshing ? "正在刷新…" : pull.armed ? "松开刷新" : "下拉刷新"}</span></>}
      </div>
      <div className="pull-refresh-content" data-dragging={visible && !pull.refreshing || undefined}
        style={{ transform: pull.distance ? `translateY(${pull.distance}px)` : undefined }}>
        {!pull.refreshing && feedback}
        {children}
      </div>
    </section>
  );
}
