import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import { currentMachineId, machineApiPath, type MachineId } from "./machineScope";
import { useImagePreview } from "./ImagePreviewProvider";
import { diagnoseImageFailure, imageReadPermissionMessage } from "./imageFailureDiagnostic";

type ImageFailure = { src: string; machine: MachineId | null; permission: boolean };

export default function MessageImage({ src, alt }: { src: string; alt: string }) {
  useLocale();
  const machine = currentMachineId();
  const [failure, setFailure] = useState<ImageFailure | null>(null);
  const diagnostic = useRef<AbortController | null>(null), generation = useRef(0);
  const identity = useRef({ src, machine }); identity.current = { src, machine };
  const cancelDiagnostic = useCallback(() => {
    generation.current++; diagnostic.current?.abort(); diagnostic.current = null;
  }, []);
  useEffect(() => cancelDiagnostic, [src, machine, cancelDiagnostic]);
  const failed = failure?.src === src && failure.machine === machine;
  const imageFailed = () => {
    cancelDiagnostic();
    const controller = new AbortController(), attempt = generation.current;
    diagnostic.current = controller; setFailure({ src, machine, permission: false });
    void diagnoseImageFailure(src, machine, controller.signal).then(reason => {
      if (reason !== "permission" || controller.signal.aborted || generation.current !== attempt
        || identity.current.src !== src || identity.current.machine !== machine || currentMachineId() !== machine) return;
      setFailure(previous => previous?.src === src && previous.machine === machine ? { ...previous, permission: true } : previous);
    }).finally(() => { if (diagnostic.current === controller) diagnostic.current = null; });
  };
  const openImage = useImagePreview();
  return (
    <span className="message-image">
      {failed ? (
        <span className="message-image-frame message-image-failed">
          <span role="status">{failure.permission ? t(imageReadPermissionMessage) : t("{{name}}暂时无法显示", { name: alt || t("图片") })}</span>
          <button type="button" onClick={() => { cancelDiagnostic(); setFailure(null); }}>{t("重试")}</button>
        </span>
      ) : (
        <button type="button" className="message-image-frame" aria-haspopup="dialog" aria-label={t("查看大图：{{value0}}", { value0: alt || t("图片") })}
          onClick={event => openImage(src, alt, event.currentTarget)}>
          <img src={machineApiPath(src, machine)} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={imageFailed} />
          <AppIcon icon={Maximize2} kind="action" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
