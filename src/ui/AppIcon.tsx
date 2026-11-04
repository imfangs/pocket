import { forwardRef } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";

export const iconMetrics = {
  auxiliary: { size: 16, strokeWidth: 1.75 },
  action: { size: 18, strokeWidth: 1.75 },
  navigation: { size: 20, strokeWidth: 1.75 },
  // Compact status marks and existing empty-state illustrations are explicit
  // exceptions. They never change the surrounding control's hit target.
  marker: { size: 13, strokeWidth: 2 },
  illustration: { size: 32, strokeWidth: 1.75 },
} as const;
export type AppIconKind = keyof typeof iconMetrics;
type AppIconProps = Omit<LucideProps, "size" | "strokeWidth"> & { icon: LucideIcon } & (
  | { kind?: "auxiliary" | "action" | "navigation"; size?: never; strokeWidth?: never }
  | { kind: "marker" | "illustration"; size?: LucideProps["size"]; strokeWidth?: LucideProps["strokeWidth"] }
);

/** Lucide geometry belongs to its role; native Radix icons and brand SVGs stay separate. */
export const AppIcon = forwardRef<SVGSVGElement, AppIconProps>(function AppIcon({
  icon: Icon, kind = "action", size, strokeWidth, ...props
}, ref) {
  const metric = iconMetrics[kind];
  const hidden = props["aria-hidden"] ?? (props.role === "img" || props["aria-label"] || props["aria-labelledby"] ? undefined : true);
  return <Icon {...props} ref={ref} size={size ?? metric.size} strokeWidth={strokeWidth ?? metric.strokeWidth}
    aria-hidden={hidden} data-pocket-icon={kind} />;
});
