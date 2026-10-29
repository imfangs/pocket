import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isMessageVideo } from "../shared/message-media.mjs";
import type { MessageFileReference } from "./conversationFeed";
import { currentMachineId, machineApiPath, requireMachine, type MachineId } from "./machineScope";
import { safeMessageFile } from "./messageFileReference";
import "./message-video.css";

const players = new Set<HTMLVideoElement>();

export function messageVideoSource(file: MessageFileReference, threadId: string, machine: MachineId | null = currentMachineId()) {
  const registered = safeMessageFile(file, threadId);
  if (!registered || !isMessageVideo(registered.name)) return null;
  try {
    const url = machineApiPath(`${registered.url}?video=1`, requireMachine(machine));
    return { ...registered, url, downloadUrl: `${url}&download=1` };
  } catch { return null; }
}

function stopTransfer(video: HTMLVideoElement) {
  video.pause();
  video.removeAttribute("src");
  // pause alone can leave a native media request buffering in the background.
  video.load();
}

export default function MessageVideo({ file, threadId, label }: { file: MessageFileReference; threadId: string; label?: string }) {
  const machine = currentMachineId(), source = messageVideoSource(file, threadId, machine);
  const url = source?.url ?? "", video = useRef<HTMLVideoElement>(null);
  const retry = useRef<(() => void) | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = !!url && failedUrl === url;
  const title = label?.trim() || file.name;

  useEffect(() => {
    const element = video.current;
    if (!element || !url) return;
    let active = true, suspended = false, generation = 0;
    const owns = () => active && !suspended && currentMachineId() === machine;
    const arm = () => { element.preload = "none"; element.src = url; };
    const fail = () => {
      if (!owns()) return;
      setFailedUrl(url);
      generation++;
      stopTransfer(element);
    };
    const error = () => {
      // Aborts caused by leaving this resource are not playback failures.
      if (!element.error || element.error.code === 1) return;
      const current = element.currentSrc;
      if (current && current !== new URL(url, document.baseURI).href) return;
      fail();
    };
    const play = () => {
      if (!owns()) { stopTransfer(element); return; }
      for (const other of players) if (other !== element) other.pause();
    };
    const restart = () => {
      if (!owns()) return;
      const attempt = ++generation;
      setFailedUrl(null);
      stopTransfer(element); arm(); element.load();
      // This runs directly in the retry gesture; native controls own later play/pause.
      void element.play().catch(failure => {
        if (owns() && generation === attempt && failure?.name !== "AbortError" && failure?.name !== "NotAllowedError") fail();
      });
    };
    const hide = () => { suspended = true; generation++; stopTransfer(element); };
    const show = () => { if (active && currentMachineId() === machine) { suspended = false; arm(); } };
    element.addEventListener("error", error); element.addEventListener("play", play);
    window.addEventListener("pagehide", hide); window.addEventListener("pageshow", show);
    players.add(element); retry.current = restart; arm();
    return () => {
      active = false; generation++;
      if (retry.current === restart) retry.current = null;
      players.delete(element);
      element.removeEventListener("error", error); element.removeEventListener("play", play);
      window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", show);
      stopTransfer(element);
    };
  }, [url, machine]);

  if (!source) return <span className="message-file-fallback">{file.name}<small>文件保存在电脑上</small></span>;
  return <span className="message-video" data-pocket-video="">
    <span className={`message-video-frame${failed ? " is-failed" : ""}`}>
      <video ref={video} src={url} controls playsInline preload="none" aria-label={`视频：${title}`} aria-hidden={failed || undefined} />
      {failed && <span className="message-video-failure" role="alert">
        <span>视频暂时无法播放，可重试或下载后查看。</span>
        <button type="button" aria-label={`重试播放：${source.name}`} onClick={() => retry.current?.()}>重试</button>
      </span>}
    </span>
    <span className="message-video-caption">
      <span className="message-video-name" title={title}>{title}</span>
      <a href={source.downloadUrl} download={source.name} aria-label={`下载视频：${source.name}`}><Download size={15} aria-hidden="true" />下载</a>
    </span>
  </span>;
}
