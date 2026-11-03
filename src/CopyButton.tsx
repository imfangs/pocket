import { t, useLocale } from "./i18n";
import { IconButton } from "./ui/IconButton";
import { Check, Copy } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MOTION_EASE, MOTION_MS, prefersReducedMotion } from "./motion";

export default function CopyButton({
  text,
  label,
}: {
  text: string;
  label: string;
}) {
  useLocale();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const icon = useRef<HTMLSpanElement>(null), previous = useRef(copied);
  useLayoutEffect(() => {
    if (previous.current === copied) return;
    previous.current = copied;
    if (!icon.current || prefersReducedMotion() || typeof icon.current.animate !== "function") return;
    const animation = icon.current.animate([{ opacity: .25 }, { opacity: 1 }], { duration: MOTION_MS.feedback, easing: MOTION_EASE.out });
    return () => animation.cancel();
  }, [copied]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <IconButton
      type="button"
      className="copy-button"
      data-copied={copied || undefined}
      aria-label={copied ? t("已复制") : t(label)}
      title={t(label)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1800);
        } catch {
          toast.error(t("复制未完成，请长按选择文字后复制"));
        }
      }}
    >
      <span ref={icon} className="copy-feedback-icon" aria-hidden="true">{copied ? <Check size={15} /> : <Copy size={15} />}</span>
      <span className="sr-only" role="status">
        {copied ? t("已复制") : ""}
      </span>
    </IconButton>
  );
}
