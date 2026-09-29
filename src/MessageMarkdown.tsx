import MarkdownCode from "./MarkdownCode";
import MessageImage from "./MessageImage";
import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];
const imageRoute = /^\/api\/tasks\/[a-f0-9-]{36}\/images\/[a-f0-9]{64}$/i;
type Props = { text: string; images?: Record<string, string> };

function publicUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? value : "";
  } catch {
    return "";
  }
}

const components: Components = {
  a({ href, children }) {
    return href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  img({ src, alt }) {
    if (typeof src === "string" && imageRoute.test(src))
      return <MessageImage key={src} src={src} alt={alt || ""} />;
    // Reading a private conversation must not load third-party image URLs.
    const href = typeof src === "string" && /^https?:/.test(src) ? src : "";
    return (
      <span className="markdown-image-reference">
        {alt || "图片"}
        {href && (
          <a href={href} target="_blank" rel="noopener noreferrer">
            查看图片
          </a>
        )}
      </span>
    );
  },
  table({ children }) {
    return (
      <div className="markdown-table" tabIndex={0} role="region" aria-label="表格，可横向滚动">
        <table>{children}</table>
      </div>
    );
  },
  pre({ children }) {
    return <MarkdownCode>{children}</MarkdownCode>;
  },
};

export default memo(function MessageMarkdown({ text, images }: Props) {
  const urlTransform = (value: string, key: string) => {
    if (key === "src" && images) {
      try {
        const url = images[decodeURIComponent(value)];
        if (url && imageRoute.test(url)) return url;
      } catch { /* Keep malformed or unregistered references as text. */ }
    }
    return publicUrl(value);
  };
  return (
    <div className="message-text message-markdown">
      <Markdown remarkPlugins={plugins} components={components} urlTransform={urlTransform} skipHtml>
        {text}
      </Markdown>
    </div>
  );
}, (before, after) => before.text === after.text &&
  Object.keys(before.images || {}).length === Object.keys(after.images || {}).length &&
  Object.entries(before.images || {}).every(([source, url]) => after.images?.[source] === url));
