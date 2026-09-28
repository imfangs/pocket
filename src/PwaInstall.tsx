import { Download, Check, Share2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal } from "./Dialogs";
type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
export default function PwaInstall() {
  const [workerReady, setWorkerReady] = useState(
    document.documentElement.dataset.pwaState === "ready",
  );
  useEffect(() => {
    const update = () =>
      setWorkerReady(document.documentElement.dataset.pwaState === "ready");
    window.addEventListener("navigator-pwa-state", update);
    return () => window.removeEventListener("navigator-pwa-state", update);
  }, []);
  const [prompt, setPrompt] = useState<InstallEvent | null>(null),
    [guide, setGuide] = useState(false),
    [installed, setInstalled] = useState(
      () =>
        matchMedia("(display-mode: standalone)").matches ||
        !!(navigator as Navigator & { standalone?: boolean }).standalone,
    );
  useEffect(() => {
    const before = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallEvent);
    };
    const done = () => {
      setInstalled(true);
      setPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", before);
    window.addEventListener("appinstalled", done);
    return () => {
      window.removeEventListener("beforeinstallprompt", before);
      window.removeEventListener("appinstalled", done);
    };
  }, []);
  const install = async () => {
    if (prompt) {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === "accepted") setInstalled(true);
      setPrompt(null);
    } else setGuide(true);
  };
  return (
    <>
      <button className="pwa-install" onClick={() => void install()}>
        {installed ? <Check size={16} /> : <Download size={16} />}
        <span>{installed ? "主屏幕使用说明" : "添加到主屏幕"}</span>
      </button>
      {guide && (
        <Modal title="添加到手机主屏幕" onClose={() => setGuide(false)}>
          <div className="install-guide">
            <Share2 size={28} />
            <p>iPhone / iPad</p>
            <ol>
              <li>用 Safari 打开当前地址并登录。</li>
              <li>点“共享”，选择“添加到主屏幕”。</li>
              <li>确认名称为“Pocket”，点击“添加”。</li>
            </ol>
            <p>Android</p>
            <ol>
              <li>用 Chrome 打开当前地址。</li>
              <li>从菜单选择“安装应用”或“添加到主屏幕”。</li>
            </ol>
            <small>
              {workerReady
                ? "离线提示页已准备好。"
                : "正在准备离线提示页；不影响在线使用。"}
              <br />
              主屏幕第一次打开可能需要再次登录。Mac
              需要保持联网运行；离线时不会缓存或显示私人任务数据。
            </small>
          </div>
        </Modal>
      )}
    </>
  );
}
