import React from "react";
import { createRoot } from "react-dom/client";
import PocketToaster from "./PocketToaster";
import AccessGate from "./AccessGate";
import PocketTheme from "./ui/PocketTheme";
import { currentMachineId } from "./machineScope";
import { defaultMachineId } from "./clientConfig";
import { storeNotificationTarget, type NotificationEntryEvent } from "./notificationTarget";
import "@radix-ui/themes/styles.css";
import "./design-tokens.css";
import "./styles.css";
import "./pwa.css";
import "./polish.css";
import "./motion.css";
import "./english-polish.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PocketTheme>
      <AccessGate />
      <PocketToaster />
    </PocketTheme>
  </React.StrictMode>,
);
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", event => {
    if (!["pocket-open-task", "pocket-open-machine-task"].includes(event.data?.type) || !/^[a-f0-9-]{36}$/i.test(event.data.threadId)) return;
    if ((event.data.machineId ?? defaultMachineId) !== currentMachineId()) return;
    let retained = false;
    try { storeNotificationTarget(sessionStorage, location.search, event.data.threadId); retained = true; } catch {}
    const target: NotificationEntryEvent = new CustomEvent("pocket-open-task", { detail: event.data.threadId, cancelable: true });
    window.dispatchEvent(target);
    if (!target.targetRejected && (retained || target.defaultPrevented)) event.ports[0]?.postMessage("pocket-task-received");
  });
  navigator.serviceWorker
    .register("/sw.js")
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      document.documentElement.dataset.pwaState = "ready";
      window.dispatchEvent(new Event("navigator-pwa-state"));
    })
    .catch((error) => {
      document.documentElement.dataset.pwaState = "unavailable";
      window.dispatchEvent(new Event("navigator-pwa-state"));
      console.warn("PWA offline shell unavailable:", error.message);
    });
} else document.documentElement.dataset.pwaState = "unavailable";
