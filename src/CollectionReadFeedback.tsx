import { RefreshCw } from "lucide-react";
import "./collection-feedback.css";

export default function CollectionReadFeedback({ hasCatalog, pending, error, retry }: {
  hasCatalog: boolean;
  pending: boolean;
  error: string;
  retry: () => void;
}) {
  if (!pending && !error) return null;
  if (!hasCatalog) return <div className="collection-load-state" role="status" data-pending={pending || undefined}>
    {pending ? <><RefreshCw size={20} aria-hidden="true" /><p>正在读取会话…</p></>
      : <><h2>暂时无法读取会话</h2><p>{error}</p>
        <button type="button" className="collection-feedback-retry" aria-label="重试刷新" onClick={retry}><RefreshCw size={14} aria-hidden="true" />重新读取</button></>}
  </div>;
  return <div className="collection-feedback" role="status" data-pending={pending || undefined}>
    {pending ? <><RefreshCw size={14} aria-hidden="true" /><span>正在刷新…</span></>
      : <><span>暂未更新，显示上次列表</span>
        <button type="button" className="collection-feedback-retry" aria-label="重试刷新" onClick={retry}><RefreshCw size={14} aria-hidden="true" />重试</button></>}
  </div>;
}
