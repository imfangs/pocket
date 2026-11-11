import { useEffect, useSyncExternalStore } from "react";
import type { ReadHealthStore } from "./readHealth";

export function useReadHealth(store: ReadHealthStore) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    const reset = () => store.reset();
    const suspended = () => { if (document.hidden || navigator.onLine === false) reset(); };
    // Hidden time does not accumulate a visible failure warning. Returning
    // starts a fresh grace window; the feeds still own their actual recovery.
    document.addEventListener("visibilitychange", reset);
    window.addEventListener("offline", reset);
    window.addEventListener("online", suspended);
    window.addEventListener("pageshow", reset);
    suspended();
    return () => {
      document.removeEventListener("visibilitychange", reset);
      window.removeEventListener("offline", reset); window.removeEventListener("online", suspended); window.removeEventListener("pageshow", reset);
    };
  }, [store]);
  return snapshot;
}
