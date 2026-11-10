import { AppIcon } from "./ui/AppIcon";
import { t as tr, useLocale } from "./i18n";
import { RefreshCw } from "lucide-react";
import "./collection-feedback.css";

export default function CollectionReadFeedback({ hasCatalog, pending, error, stale = false, cachedStatus = false, cachedList = false, retry }: {
  hasCatalog: boolean;
  pending: boolean;
  error: string;
  stale?: boolean;
  cachedStatus?: boolean;
  cachedList?: boolean;
  retry: () => void;
}) {
  useLocale();
  if (!pending && !error && !stale && !cachedList) return null;
  if (!hasCatalog) return <div className="collection-load-state" role="status" data-pending={pending || undefined}>
    {pending ? <><AppIcon icon={RefreshCw} kind="auxiliary" aria-hidden="true" /><p>{tr("正在读取会话…")}</p></>
      : <><h2>{tr("暂时无法读取会话")}</h2><p>{tr(error)}</p>
        <button type="button" className="collection-feedback-retry" aria-label={tr("重试刷新")} onClick={retry}><AppIcon icon={RefreshCw} kind="auxiliary" aria-hidden="true" />{tr("重新读取")}</button></>}
  </div>;
  return <div className="collection-feedback" role="status" data-pending={pending || undefined}>
    {pending && !stale ? <><AppIcon icon={RefreshCw} kind="auxiliary" aria-hidden="true" /><span>{tr("正在刷新…")}</span></>
      : <><span>{tr(stale ? cachedStatus ? "状态尚未同步，显示上次同步的列表状态" : "状态尚未同步" : "暂未更新，显示上次列表")}</span>
        <button type="button" className="collection-feedback-retry" aria-label={tr("重试刷新")} onClick={retry}><AppIcon icon={RefreshCw} kind="auxiliary" aria-hidden="true" />{tr("重试")}</button></>}
  </div>;
}
