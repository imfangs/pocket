import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import { currentMachineId, type MachineId } from "./machineScope";
import { useImagePreview, useImagePreviewRegistration } from "./ImagePreviewProvider";
import { diagnoseImageFailure, imageReadPermissionMessage } from "./imageFailureDiagnostic";
import { ImageReadError } from "./imageReadCache";
import { useImageReadUrl } from "./imageReadCacheReact";

type ImageFailure = { src: string; machine: MachineId | null; key: string; permission: boolean };

export default function MessageImage({ src, alt }: { src: string; alt: string }) {
  useLocale();
  const machine = currentMachineId();
  const image = useImageReadUrl({ src, machine }, { lazy: true });
  const [failure, setFailure] = useState<ImageFailure | null>(null);
  const diagnostic = useRef<AbortController | null>(null), generation = useRef(0);
  const identity = useRef({ src, machine, key: image.requestKey, url: image.url }); identity.current = { src, machine, key: image.requestKey, url: image.url };
  const cancelDiagnostic = useCallback(() => {
    generation.current++; diagnostic.current?.abort(); diagnostic.current = null;
  }, []);
  useEffect(() => cancelDiagnostic, [src, machine, image.requestKey, cancelDiagnostic]);
  const failed = failure?.src === src && failure.machine === machine && failure.key === image.requestKey;
  const imageFailed = useCallback((reason?: unknown) => {
    cancelDiagnostic();
    if (reason instanceof ImageReadError && reason.status) { setFailure({ src, machine, key: image.requestKey, permission: reason.permission }); return; }
    const controller = new AbortController(), attempt = generation.current;
    diagnostic.current = controller; setFailure({ src, machine, key: image.requestKey, permission: false });
    void diagnoseImageFailure(src, machine, controller.signal).then(reason => {
      if (reason !== "permission" || controller.signal.aborted || generation.current !== attempt
        || identity.current.src !== src || identity.current.machine !== machine || identity.current.key !== image.requestKey || currentMachineId() !== machine) return;
      setFailure(previous => previous?.src === src && previous.machine === machine && previous.key === image.requestKey ? { ...previous, permission: true } : previous);
    }).finally(() => { if (diagnostic.current === controller) diagnostic.current = null; });
  }, [src, machine, image.requestKey, cancelDiagnostic]);
  useEffect(() => { if (image.phase === "failed") imageFailed(image.error); }, [image.phase, image.error, imageFailed]);
  const openImage = useImagePreview();
  const imageRegistration = useImagePreviewRegistration(src, alt);
  const register = useCallback((element: HTMLElement | null) => {
    image.ref(element); const unregister = imageRegistration(element);
    return () => { if (typeof unregister === "function") unregister(); image.ref(null); };
  }, [image.ref, imageRegistration]);
  return (
    <span ref={register} className="message-image" data-registered-source={src}>
      {failed ? (
        <span className="message-image-frame message-image-failed">
          <span role="status">{failure.permission ? t(imageReadPermissionMessage) : t("{{name}}暂时无法显示", { name: alt || t("图片") })}</span>
          <button type="button" onClick={() => { cancelDiagnostic(); setFailure(null); image.retry(); }}>{t("重试")}</button>
        </span>
      ) : (
        <button type="button" className="message-image-frame" aria-haspopup="dialog" aria-label={t("查看大图：{{value0}}", { value0: alt || t("图片") })}
          onClick={event => openImage(src, alt, event.currentTarget)}>
          {image.url && <img src={image.url} data-registered-source={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer"
            onError={event => { if (identity.current.key === image.requestKey && event.currentTarget.getAttribute("src") === identity.current.url) imageFailed(); }} />}
          <AppIcon icon={Maximize2} kind="action" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
