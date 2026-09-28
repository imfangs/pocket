import React from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import AccessGate from "./AccessGate";
import "./styles.css";
import "./pwa.css";
import "./polish.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AccessGate />
    <Toaster
      position="top-center"
      duration={2800}
      visibleToasts={1}
      offset={20}
      mobileOffset={{
        top: "calc(env(safe-area-inset-top, 0px) + 12px)",
        left: 16,
        right: 16,
      }}
      toastOptions={{
        style: {
          fontFamily: "inherit",
          fontSize: 13,
          borderRadius: 14,
          background: "var(--ink)",
          color: "white",
          border: "none",
        },
      }}
    />
  </React.StrictMode>,
);
if ("serviceWorker" in navigator) {
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
