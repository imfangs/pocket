import MarkdownCode from "./MarkdownCode";
import MessageImage from "./MessageImage";
import { memo, useMemo } from "react";
import { pocketTaskUrl, readableCodexMarkdown } from "./codexMarkup";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];
const imageRoute = /^\/api\/tasks\/[a-f0-9-]{36}\/images\/[a-f0-9]{64}$/i;
type Props = { text: string; images?: Record<string, string>; codex?: boolean };

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
    const taskUrl = href && pocketTaskUrl(href);
    if (taskUrl) return <a className="pocket-task-link" href={taskUrl} onClick={event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      window.dispatchEvent(new CustomEvent("pocket-open-task", { detail: taskUrl.slice("/?task=".length) }));
    }}>{children}</a>;
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

export default memo(function MessageMarkdown({ text, images, codex = true }: Props) {
  const markdown = useMemo(() => codex ? readableCodexMarkdown(text) : text, [text, codex]);
  const urlTransform = (value: string, key: string) => {
    if (key === "src" && images) {
      try {
        const url = images[decodeURIComponent(value)];
        if (url && imageRoute.test(url)) return url;
      } catch { /* Keep malformed or unregistered references as text. */ }
    }
    return key === "href" ? pocketTaskUrl(value) || publicUrl(value) : publicUrl(value);
  };
  return (
    <div className="message-text message-markdown">
      <Markdown remarkPlugins={plugins} components={components} urlTransform={urlTransform} skipHtml>
        {markdown}
      </Markdown>
    </div>
  );
}, (before, after) => before.text === after.text && before.codex === after.codex &&
  Object.keys(before.images || {}).length === Object.keys(after.images || {}).length &&
  Object.entries(before.images || {}).every(([source, url]) => after.images?.[source] === url));
