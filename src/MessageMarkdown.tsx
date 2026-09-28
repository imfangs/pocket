import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];

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
    return <pre tabIndex={0}>{children}</pre>;
  },
};

export default memo(function MessageMarkdown({ text }: { text: string }) {
  return (
    <div className="message-text message-markdown">
      <Markdown remarkPlugins={plugins} components={components} urlTransform={publicUrl} skipHtml>
        {text}
      </Markdown>
    </div>
  );
});
