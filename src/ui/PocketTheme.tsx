import { Theme } from "@radix-ui/themes/components/theme";
import { useSyncExternalStore, type ReactNode } from "react";

function subscribeAppearance(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("pocket-theme-changed", onChange);
  return () => window.removeEventListener("pocket-theme-changed", onChange);
}

function readAppearance(): "light" | "dark" {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
    ? "dark"
    : "light";
}

const serverAppearance = () => "light" as const;

/** public/theme.js owns persistence and system preference; this only reflects it. */
export default function PocketTheme({ children }: { children: ReactNode }) {
  const appearance = useSyncExternalStore(subscribeAppearance, readAppearance, serverAppearance);
  return (
    <Theme
      className="pocket-theme"
      appearance={appearance}
      accentColor="indigo"
      grayColor="slate"
      panelBackground="solid"
      radius="large"
      scaling="100%"
      hasBackground={false}
    >
      {children}
    </Theme>
  );
}

/** Keep a custom portal's original element and its focus/positioning behavior. */
export function PocketPortalTheme({ children }: { children: ReactNode }) {
  return <Theme asChild hasBackground={false}>{children}</Theme>;
}
