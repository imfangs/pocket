export type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
type InstallBrowser = Pick<Window, "addEventListener" | "removeEventListener"> & {
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: Navigator & { standalone?: boolean };
};
type InstallSnapshot = { installed: boolean; canPrompt: boolean; busy: boolean };

// The page owner keeps the one-shot browser event in memory while an install
// button is absent, moved between login/settings, or temporarily unmounted.
export function createPwaInstallController(browser?: InstallBrowser) {
  let prompt: InstallPromptEvent | null = null, listening = false;
  let snapshot: InstallSnapshot = { installed: !!(browser?.matchMedia?.("(display-mode: standalone)").matches || browser?.navigator?.standalone), canPrompt: false, busy: false };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<InstallSnapshot>) => {
    const next = { ...snapshot, ...patch };
    if (next.installed === snapshot.installed && next.canPrompt === snapshot.canPrompt && next.busy === snapshot.busy) return;
    snapshot = next; listeners.forEach(listener => listener());
  };
  const before = (event: Event) => {
    const candidate = event as InstallPromptEvent;
    if (typeof candidate.prompt !== "function" || typeof candidate.userChoice?.then !== "function") return;
    event.preventDefault();
    if (snapshot.installed) return;
    prompt = candidate; update({ canPrompt: true });
  };
  const installed = () => { prompt = null; update({ installed: true, canPrompt: false }); };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      if (!browser || listening) return;
      listening = true;
      browser.addEventListener("beforeinstallprompt", before);
      browser.addEventListener("appinstalled", installed);
    },
    stop() {
      if (!browser || !listening) return;
      listening = false;
      browser.removeEventListener("beforeinstallprompt", before);
      browser.removeEventListener("appinstalled", installed);
    },
    async install(): Promise<"accepted" | "dismissed" | "unavailable" | "failed" | "busy"> {
      if (snapshot.busy) return "busy";
      const current = prompt;
      if (!current || snapshot.installed) return "unavailable";
      prompt = null; update({ canPrompt: false, busy: true });
      try {
        await current.prompt();
        const choice = await current.userChoice;
        if (choice.outcome === "accepted") { installed(); return "accepted"; }
        return "dismissed";
      } catch { return "failed"; }
      finally { update({ busy: false }); }
    },
  };
}
export type PwaInstallController = ReturnType<typeof createPwaInstallController>;
