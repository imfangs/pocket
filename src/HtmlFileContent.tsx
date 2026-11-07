import { useLayoutEffect, useMemo, useRef } from "react";
import { renderInteractiveHtmlPreview } from "../shared/html-preview.mjs";
import { htmlPreviewSandbox, htmlPreviewShellPath } from "../shared/html-runtime-policy.mjs";
import { t, useLocale } from "./i18n";

export default function HtmlFileContent({ name, source, images, hidden, onClose }: {
  name: string; source: string; images: Record<string, string>; hidden: boolean; onClose: () => void;
}) {
  useLocale();
  const frame = useRef<HTMLIFrameElement>(null), close = useRef(onClose);
  close.current = onClose;
  const document = useMemo(() => {
    try { return renderInteractiveHtmlPreview(source, images); } catch { return null; }
  }, [source, images]);
  const nonce = useMemo(() => crypto.randomUUID().replaceAll("-", ""), [document]);
  useLayoutEffect(() => {
    let initialized = false;
    const receive = (event: MessageEvent) => {
      if (document === null || event.source !== frame.current?.contentWindow || event.origin !== "null" ||
          !event.data || typeof event.data !== "object" || event.data.nonce !== nonce) return;
      if (event.data.type === "pocket-html-preview-ready" && !initialized) {
        initialized = true;
        frame.current?.contentWindow?.postMessage({ type: "pocket-html-preview-init", nonce, html: document }, "*");
      }
      else if (event.data.type === "pocket-html-preview-close") close.current();
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [document, nonce]);
  return <div className="html-file-preview ph-no-capture" hidden={hidden}>
    {document === null ? <p className="text-file-state" role="alert">{t("页面暂时无法预览，可切换到源码查看。")}</p>
      : <iframe ref={frame} className="ph-no-capture" title={t("HTML 页面：{{name}}", { name })}
        sandbox={htmlPreviewSandbox} referrerPolicy="no-referrer"
        src={`${htmlPreviewShellPath}#${nonce}`} />}
  </div>;
}
