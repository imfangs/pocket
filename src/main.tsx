import React from "react";
import { createRoot } from "react-dom/client";
import PocketToaster from "./PocketToaster";
import AccessGate from "./AccessGate";
import "./styles.css";
import "./pwa.css";
import "./polish.css";
import "./theme.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AccessGate />
    <PocketToaster />
  </React.StrictMode>,
);
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", event => {
    if (event.data?.type !== "pocket-open-task" || !/^[a-f0-9-]{36}$/i.test(event.data.threadId)) return;
    try { sessionStorage.setItem("pocket.pending-task", event.data.threadId); } catch {}
    window.dispatchEvent(new CustomEvent("pocket-open-task", { detail: event.data.threadId }));
    event.ports[0]?.postMessage("pocket-task-received");
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
