import { t, useLocale } from "./i18n";
import { Button } from "./ui/Button";
import { Download, Share2 } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Modal } from "./Dialogs";
import { createPwaInstallController, type PwaInstallController } from "./pwaInstallController";

export function usePwaInstallController() {
  const [controller] = useState(() => createPwaInstallController(typeof window === "undefined" ? undefined : window));
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  return controller;
}

export default function PwaInstall({ controller }: { controller: PwaInstallController }) {
  useLocale();
  const [guide, setGuide] = useState(false);
  const { installed, busy } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const install = async () => {
    const result = await controller.install();
    if (result === "unavailable" || result === "failed") setGuide(true);
  };
  if (installed) return null;
  return (
    <>
      <Button type="button" className="pwa-install" variant="soft" color="gray" disabled={busy} onClick={() => void install()}>
        <Download size={16} />
        <span>{t("添加到主屏幕")}</span>
      </Button>
      {guide && (
        <Modal title={t("添加到手机主屏幕")} className="install-dialog" onClose={() => setGuide(false)}>
          <div className="install-guide">
            <Share2 size={28} />
            <p>iPhone / iPad</p>
            <ol>
              <li>{t("用 Safari 打开当前地址并登录。")}</li>
              <li>{t("点“共享”，选择“添加到主屏幕”。")}</li>
              <li>{t("确认名称为“Pocket”，点击“添加”。")}</li>
            </ol>
            <p>Android</p>
            <ol>
              <li>{t("用 Chrome 打开当前地址。")}</li>
              <li>{t("从菜单选择“安装应用”或“添加到主屏幕”。")}</li>
            </ol>
            <small>{t("主屏幕首次打开可能需要重新登录。任务同步与执行需要 Mac 在线。")}</small>
          </div>
        </Modal>
      )}
    </>
  );
}
