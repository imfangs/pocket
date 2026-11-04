import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import { Check, CircleAlert, Info, TriangleAlert } from "lucide-react";
import { Toaster } from "sonner";
import "./toast.css";

export default function PocketToaster() {
  useLocale();
  return <Toaster className="pocket-toaster" position="top-center" theme="system"
    duration={2800} visibleToasts={1} offset={20} containerAriaLabel={t("操作提示")}
    mobileOffset={{ top: "calc(env(safe-area-inset-top, 0px) + 12px)", left: 16, right: 16 }}
    icons={{ success: <AppIcon icon={Check} kind="auxiliary" />, error: <AppIcon icon={CircleAlert} kind="auxiliary" />,
      info: <AppIcon icon={Info} kind="auxiliary" />, warning: <AppIcon icon={TriangleAlert} kind="auxiliary" /> }}
    toastOptions={{ unstyled: true, classNames: { toast: "pocket-toast" } }} />;
}
