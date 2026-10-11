import { Check, CircleAlert, Info, TriangleAlert } from "lucide-react";
import { Toaster } from "sonner";
import "./toast.css";

export default function PocketToaster() {
  return <Toaster className="pocket-toaster" position="top-center" theme="system"
    duration={2800} visibleToasts={1} offset={20} containerAriaLabel="操作提示"
    mobileOffset={{ top: "calc(env(safe-area-inset-top, 0px) + 12px)", left: 16, right: 16 }}
    icons={{ success: <Check size={15} />, error: <CircleAlert size={15} />,
      info: <Info size={15} />, warning: <TriangleAlert size={15} /> }}
    toastOptions={{ unstyled: true, classNames: { toast: "pocket-toast" } }} />;
}
