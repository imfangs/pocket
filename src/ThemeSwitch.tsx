import { t, useLocale } from "./i18n";
import { Button } from "./ui/Button";
import { useSyncExternalStore } from "react";
import { Sun, Moon, Monitor } from "lucide-react";

const subscribe = (update: () => void) => {
  window.addEventListener("pocket-theme-changed", update);
  return () => window.removeEventListener("pocket-theme-changed", update);
};
const snapshot = () => document.documentElement.dataset.themePreference || "system";
const choices = [
  { value: "light", label: "亮色", Icon: Sun },
  { value: "dark", label: "暗色", Icon: Moon },
  { value: "system", label: "系统", Icon: Monitor },
];
export default function ThemeSwitch() {
  useLocale();
  const preference = useSyncExternalStore(subscribe, snapshot, () => "system");
  return <div className="theme-switch" role="group" aria-label={t("外观主题")}>
    {choices.map(({ value, label, Icon }) => <Button key={value} type="button" size="2" variant="soft" color={preference === value ? "indigo" : "gray"}
      aria-label={value === "system" ? t("跟随系统") : t("{{label}}模式", { label: t(label) })}
      aria-pressed={preference === value}
      onClick={() => window.dispatchEvent(new CustomEvent("pocket-set-theme", { detail: value }))}>
      <Icon size={14} aria-hidden="true" />{t(label)}
    </Button>)}
  </div>;
}
