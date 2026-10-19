import { IconButton as RadixIconButton, type IconButtonProps as RadixIconButtonProps } from "@radix-ui/themes/components/icon-button";
import { forwardRef } from "react";

export type IconButtonProps = RadixIconButtonProps;

/** Callers provide aria-label or aria-labelledby alongside the existing action. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, size = "3", variant = "ghost", color = "gray", type, asChild, ...props },
  ref,
) {
  return (
    <RadixIconButton
      {...props}
      ref={ref}
      asChild={asChild}
      type={type ?? (asChild ? undefined : "button")}
      size={size}
      variant={variant}
      color={color}
      className={["pocket-icon-button", className].filter(Boolean).join(" ")}
    />
  );
});
