import { Button as RadixButton, type ButtonProps as RadixButtonProps } from "@radix-ui/themes/components/button";
import { forwardRef } from "react";

export type ButtonProps = RadixButtonProps;

/** Keep Radix's native button contract; form submission is always explicit. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, size = "3", variant = "solid", type, asChild, ...props },
  ref,
) {
  return (
    <RadixButton
      {...props}
      ref={ref}
      asChild={asChild}
      type={type ?? (asChild ? undefined : "button")}
      size={size}
      variant={variant}
      className={["pocket-button", className].filter(Boolean).join(" ")}
    />
  );
});
