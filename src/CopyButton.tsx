import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export default function CopyButton({
  text,
  label,
}: {
  text: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="copy-button"
      aria-label={copied ? "已复制" : label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1800);
        } catch {
          toast.error("复制未完成，请长按选择文字后复制");
        }
      }}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
      <span className="sr-only" role="status">
        {copied ? "已复制" : ""}
      </span>
    </button>
  );
}
