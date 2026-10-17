import { useState } from "react";
import { Maximize2 } from "lucide-react";
import { machineApiPath } from "./machineScope";
import { useImagePreview } from "./ImagePreviewProvider";

export default function MessageImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const openImage = useImagePreview();
  return (
    <span className="message-image">
      {failed ? (
        <span className="message-image-frame message-image-failed">
          <span>{alt || "图片"}暂时无法显示</span>
          <button type="button" onClick={() => setFailed(false)}>重试</button>
        </span>
      ) : (
        <button type="button" className="message-image-frame" aria-haspopup="dialog" aria-label={`查看大图：${alt || "图片"}`}
          onClick={event => openImage(src, alt || "图片", event.currentTarget)}>
          <img src={machineApiPath(src)} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
          <Maximize2 size={16} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
