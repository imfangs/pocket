import { useEffect, useRef, useState } from "react";
import { t, useLocale } from "./i18n";
import { readSvgPreviewBlob, sanitizeSvgPreview } from "./svgFilePreview";
import "./svg-file-content.css";

const loadError = "SVG 暂时无法预览，可下载原文件。";
export default function SvgFileContent({ blob, onError }: { blob: Blob; onError?: (error: Error) => void }) {
  useLocale();
  const [url, setUrl] = useState(""), [failure, setFailure] = useState("");
  const errorCallback = useRef(onError); errorCallback.current = onError;
  useEffect(() => {
    const controller = new AbortController();
    let current = true, objectUrl = "";
    setUrl(""); setFailure("");
    void readSvgPreviewBlob(blob, controller.signal).then(source => {
      controller.signal.throwIfAborted();
      const preview = sanitizeSvgPreview(source, window);
      if (!current) return;
      objectUrl = URL.createObjectURL(new Blob([preview.source], { type: "image/svg+xml" }));
      setUrl(objectUrl);
    }).catch(error => {
      if (!current || controller.signal.aborted) return;
      const message = error instanceof Error && /[\u3400-\u9fff]/.test(error.message) ? error.message : loadError;
      setFailure(message); errorCallback.current?.(new Error(message));
    });
    return () => { current = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [blob]);
  return <div className="svg-file-content ph-no-capture ph-mask">
    {failure ? <p className="text-file-state" role="alert">{t(failure)}</p>
      : url ? <img src={url} alt={t("图片")} onError={() => { setFailure(loadError); errorCallback.current?.(new Error(loadError)); }} />
      : <p className="text-file-state" role="status">{t("正在加载图片…")}</p>}
  </div>;
}
