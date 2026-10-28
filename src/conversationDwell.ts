// One passive attempt after a continuous foreground visit. This is separate
// from input intention: a skipped/failed prefetch never spends the first real
// input attempt, and background time cannot open a Mac conversation later.
export function bindConversationDwellConnection(document: Document, options: {
  available: () => boolean;
  visible?: () => boolean;
  connect: () => Promise<unknown>;
  delayMs?: number;
}) {
  const browser = document.defaultView;
  if (!browser) return () => {};
  let timer: number | undefined, attempted = false, disposed = false, pageActive = true, active = false;
  const cancel = () => { browser.clearTimeout(timer); timer = undefined; };
  const visible = () => pageActive && document.visibilityState === "visible" && browser.navigator.onLine !== false &&
    !document.querySelector?.('dialog[open], [data-reading-overlay]') && (options.visible?.() ?? true);
  const sync = () => {
    const next = visible();
    if (next === active) return;
    active = next;
    cancel();
    if (disposed || attempted || !next) return;
    timer = browser.setTimeout(() => {
      timer = undefined;
      if (disposed) return;
      if (!visible()) { active = false; return; }
      if (!options.available()) return;
      attempted = true;
      // Input/explicit retry owns any recovery. Do not create a background
      // retry loop or an unhandled rejection from a passive visit.
      void options.connect().catch(() => {});
    }, options.delayMs ?? 5000);
  };
  const hide = () => { pageActive = false; sync(); };
  const show = () => { pageActive = true; sync(); };
  document.addEventListener("visibilitychange", sync);
  browser.addEventListener("online", sync);
  browser.addEventListener("offline", sync);
  browser.addEventListener("pageshow", show);
  browser.addEventListener("pagehide", hide);
  browser.addEventListener("pocket-reading-visibility-change", sync);
  sync();
  return () => {
    disposed = true; cancel();
    document.removeEventListener("visibilitychange", sync);
    browser.removeEventListener("online", sync);
    browser.removeEventListener("offline", sync);
    browser.removeEventListener("pageshow", show);
    browser.removeEventListener("pagehide", hide);
    browser.removeEventListener("pocket-reading-visibility-change", sync);
  };
}
