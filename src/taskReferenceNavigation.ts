import type { MouseEvent } from "react";
import { pocketTaskTarget } from "./codexMarkup";
import { changeMachine, currentMachineId } from "./machineScope";
import { t } from "./i18n";
import { toast } from "sonner";

export function navigateTaskReference(event: MouseEvent<HTMLAnchorElement>, url: string) {
  if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = pocketTaskTarget(url);
  if (!target) return;
  event.preventDefault();
  if (target.machine !== currentMachineId()) {
    const error = changeMachine(target.machine, target.threadId);
    if (error) toast.error(t(error));
  } else window.dispatchEvent(new CustomEvent("pocket-open-reference", {
    detail: { threadId: target.threadId, origin: event.detail === 0 ? "keyboard" : "pointer" }, cancelable: true,
  }));
}
