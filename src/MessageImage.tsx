import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import { useState } from "react";
import { Maximize2 } from "lucide-react";
import { machineApiPath } from "./machineScope";
import { useImagePreview } from "./ImagePreviewProvider";

export default function MessageImage({ src, alt }: { src: string; alt: string }) {
  useLocale();
  const [failed, setFailed] = useState(false);
  const openImage = useImagePreview();
  return (
    <span className="message-image">
      {failed ? (
        <span className="message-image-frame message-image-failed">
          <span>{t("{{name}}暂时无法显示", { name: alt || t("图片") })}</span>
          <button type="button" onClick={() => setFailed(false)}>{t("重试")}</button>
        </span>
      ) : (
        <button type="button" className="message-image-frame" aria-haspopup="dialog" aria-label={t("查看大图：{{value0}}", { value0: alt || t("图片") })}
          onClick={event => openImage(src, alt, event.currentTarget)}>
          <img src={machineApiPath(src)} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
          <AppIcon icon={Maximize2} kind="action" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
