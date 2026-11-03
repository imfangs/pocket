import { t, useLocale } from "./i18n";
import MarkdownCode from "./MarkdownCode";
import MessageImage from "./MessageImage";
import MessageFile, { registeredMessageFile } from "./MessageFile";
import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import { localFileReference } from "../shared/codex-directives.mjs";
import { isMessageVideo } from "../shared/message-media.mjs";
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
type VideoReference = { file: MessageFileReference | null; href: string };
const FileLinksContext = createContext<{
  links: Map<string, MessageFileReference | null>; videos: Map<string, VideoReference>; threadId?: string;
}>({ links: new Map(), videos: new Map() });
const InsideLinkContext = createContext(false);

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
  useLocale();
  const { links, threadId } = useContext(FileLinksContext);
  const content = <InsideLinkContext.Provider value={true}>{children}</InsideLinkContext.Provider>;
  if (href && links.has(href)) {
    const file = links.get(href);
    return file && threadId ? <MessageFile key={`${threadId}/${file.url}`} file={file} threadId={threadId} />
      : <span className="message-file-fallback">{content}<small>{t("文件保存在电脑上")}</small></span>;
  }
  const taskUrl = href && pocketTaskUrl(href);
  if (taskUrl) return <a className="pocket-task-link" href={taskUrl} onClick={event => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const target = pocketTaskTarget(taskUrl);
    if (!target) return;
    if (target.machine !== currentMachineId()) {
      const error = changeMachine(target.machine, target.threadId);
      if (error) toast.error(t(error));
    } else window.dispatchEvent(new CustomEvent("pocket-open-task", { detail: target.threadId }));
  }}>{content}</a>;
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {content}
    </a>
  ) : (
    <span>{content}</span>
  );
}

function MarkdownMedia({ src, alt }: { src?: string | Blob; alt?: string }) {
  useLocale();
  const { videos, threadId } = useContext(FileLinksContext);
  const insideLink = useContext(InsideLinkContext);
  const video = typeof src === "string" ? videos.get(src) : undefined;
  if (video) {
    // A linked thumbnail retains its outer link's action. Even a capability
    // registered elsewhere must not put native controls inside an anchor.
    if (insideLink) return <span>{alt || video.file?.name || t("视频")}</span>;
    if (video.file && threadId) return <MessageFile key={`${threadId}/${video.file.url}`} file={video.file} threadId={threadId} label={alt} />;
    return <span className="markdown-image-reference">{alt || t("视频")}
      {video.href ? <a href={video.href} target="_blank" rel="noopener noreferrer">{t("查看视频")}</a>
        : <small>{t("文件保存在电脑上")}</small>}
    </span>;
  }
  if (typeof src === "string" && imageRoute.test(src))
    return <MessageImage key={src} src={src} alt={alt || ""} />;
  // Reading a private conversation must not load third-party image URLs.
  const href = typeof src === "string" && /^https?:/.test(src) ? src : "";
  return <span className="markdown-image-reference">
    {alt || t("图片")}
    {href && <a href={href} target="_blank" rel="noopener noreferrer">{t("查看图片")}</a>}
  </span>;
}

const components: Components = {
  a: MarkdownLink,
  img: MarkdownMedia,
  table({ children }) {
    return (
      <div className="markdown-table" tabIndex={0} role="region" aria-label={t("表格，可横向滚动")}>
        <table>{children}</table>
      </div>
    );
  },
  pre({ children }) {
    return <MarkdownCode>{children}</MarkdownCode>;
  },
};

export default memo(function MessageMarkdown({ text, images, files, threadId, codex = true }: Props) {
  const locale = useLocale();
  const markdown = useMemo(() => codex ? readableCodexMarkdown(text, t) : text, [text, codex, locale]);
  // Only the exact source reference can mint a render token. A raw or forged
  // /api/.../files URL never inherits another link's registered capability.
  const fileLinks = new Map<string, MessageFileReference | null>();
  const videoLinks = new Map<string, VideoReference>();
  const urlTransform = (value: string, key: string) => {
    if (key === "src" && images) {
      try {
        const url = images[decodeURIComponent(value)];
        if (url && imageRoute.test(url)) return url;
      } catch { /* Keep malformed or unregistered references as text. */ }
    }
    if (key === "src") {
      const file = registeredMessageFile(value, files, threadId);
      if (file && isMessageVideo(file.name) || isMessageVideo(value)) {
        const token = `pocket-video-reference:${videoLinks.size}`;
        videoLinks.set(token, { file: file && isMessageVideo(file.name) ? file : null, href: publicUrl(value) });
        return token;
      }
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
      <FileLinksContext.Provider value={{ links: fileLinks, videos: videoLinks, threadId }}>
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
