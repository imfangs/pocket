import MarkdownCode from "./MarkdownCode";
import MessageImage from "./MessageImage";
import MessageFile, { registeredMessageFile } from "./MessageFile";
import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import { localFileReference } from "../shared/codex-directives.mjs";
import type { MessageFileReference, MessageFiles } from "./conversationFeed";
import { pocketTaskTarget, pocketTaskUrl, readableCodexMarkdown } from "./codexMarkup";
import { changeMachine, currentMachineId } from "./machineScope";
import { toast } from "sonner";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMermaid from "./mermaidMarkdown";

const plugins = [remarkGfm, remarkMermaid];
const imageRoute = /^\/api\/tasks\/[a-f0-9-]{36}\/images\/[a-f0-9]{64}$/i;
type Props = { text: string; images?: Record<string, string>; files?: MessageFiles; threadId?: string; codex?: boolean };
const FileLinksContext = createContext<{ links: Map<string, MessageFileReference | null>; threadId?: string }>({ links: new Map() });

function publicUrl(value: string) {
  try {
    const url = new URL(value);
    if (/^\/api\/(?:machines\/[^/]+\/)?tasks\/[^/]+\/files(?:\/|$)/i.test(decodeURIComponent(url.pathname))) return "";
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? value : "";
  } catch {
    return "";
  }
}

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const { links, threadId } = useContext(FileLinksContext);
  if (href && links.has(href)) {
    const file = links.get(href);
    return file && threadId ? <MessageFile key={`${threadId}/${file.url}`} file={file} threadId={threadId} />
      : <span className="message-file-fallback">{children}<small>文件保存在电脑上</small></span>;
  }
  const taskUrl = href && pocketTaskUrl(href);
  if (taskUrl) return <a className="pocket-task-link" href={taskUrl} onClick={event => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const target = pocketTaskTarget(taskUrl);
    if (!target) return;
    if (target.machine !== currentMachineId()) {
      const error = changeMachine(target.machine, target.threadId);
      if (error) toast.error(error);
    } else window.dispatchEvent(new CustomEvent("pocket-open-task", { detail: target.threadId }));
  }}>{children}</a>;
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

const components: Components = {
  a: MarkdownLink,
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

export default memo(function MessageMarkdown({ text, images, files, threadId, codex = true }: Props) {
  const markdown = useMemo(() => codex ? readableCodexMarkdown(text) : text, [text, codex]);
  // Only the exact source reference can mint a render token. A raw or forged
  // /api/.../files URL never inherits another link's registered capability.
  const fileLinks = new Map<string, MessageFileReference | null>();
  const urlTransform = (value: string, key: string) => {
    if (key === "src" && images) {
      try {
        const url = images[decodeURIComponent(value)];
        if (url && imageRoute.test(url)) return url;
      } catch { /* Keep malformed or unregistered references as text. */ }
    }
    if (key === "href") {
      const task = pocketTaskUrl(value);
      if (task) return task;
      if (localFileReference(value) || localFileReference(value, true)) {
        const token = `pocket-file-reference:${fileLinks.size}`;
        fileLinks.set(token, registeredMessageFile(value, files, threadId));
        return token;
      }
    }
    return publicUrl(value);
  };
  return (
    <div className="message-text message-markdown">
      <FileLinksContext.Provider value={{ links: fileLinks, threadId }}>
        <Markdown remarkPlugins={plugins} components={components} urlTransform={urlTransform} skipHtml>
          {markdown}
        </Markdown>
      </FileLinksContext.Provider>
    </div>
  );
}, (before, after) => before.text === after.text && before.codex === after.codex && before.threadId === after.threadId &&
  Object.keys(before.images || {}).length === Object.keys(after.images || {}).length &&
  Object.entries(before.images || {}).every(([source, url]) => after.images?.[source] === url) &&
  Object.keys(before.files || {}).length === Object.keys(after.files || {}).length &&
  Object.entries(before.files || {}).every(([source, file]) => after.files?.[source]?.url === file?.url && after.files?.[source]?.name === file?.name));
