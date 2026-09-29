import { useState } from "react";
import { Maximize2 } from "lucide-react";

export default function MessageImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="message-image">
      {failed ? (
        <span className="message-image-frame message-image-failed">
          <span>{alt || "图片"}暂时无法显示</span>
          <button type="button" onClick={() => setFailed(false)}>重试</button>
        </span>
      ) : (
        <a className="message-image-frame" href={src} target="_blank" rel="noopener noreferrer" aria-label={`查看大图：${alt || "图片"}`}>
          <img src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
          <Maximize2 size={16} aria-hidden="true" />
        </a>
      )}
    </span>
  );
}
