import { Children, isValidElement, type ReactNode } from "react";
import CopyButton from "./CopyButton";

function plainText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number")
        return String(child);
      return isValidElement<{ children?: ReactNode }>(child)
        ? plainText(child.props.children)
        : "";
    })
    .join("");
}
export default function MarkdownCode({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find((child) =>
    isValidElement(child),
  );
  const language = isValidElement<{ className?: string }>(code)
    ? code.props.className?.match(/language-([^\s]+)/)?.[1]
    : undefined;
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>{language || "代码"}</span>
        <CopyButton label="复制代码" text={plainText(children)} />
      </div>
      <pre tabIndex={0}>{children}</pre>
    </div>
  );
}
