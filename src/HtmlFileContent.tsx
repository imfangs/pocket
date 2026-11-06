import { useMemo } from "react";
import { renderHtmlPreview } from "../shared/html-preview.mjs";
import { t, useLocale } from "./i18n";

export default function HtmlFileContent({ name, source, images, hidden }: {
  name: string; source: string; images: Record<string, string>; hidden: boolean;
}) {
  useLocale();
  const document = useMemo(() => {
    try { return renderHtmlPreview(source, images); } catch { return null; }
  }, [source, images]);
  return <div className="html-file-preview ph-no-capture" hidden={hidden}>
    {document === null ? <p className="text-file-state" role="alert">{t("页面暂时无法预览，可切换到源码查看。")}</p>
      : <iframe className="ph-no-capture" title={t("HTML 页面：{{name}}", { name })}
        sandbox="" referrerPolicy="no-referrer" srcDoc={document} />}
  </div>;
}
