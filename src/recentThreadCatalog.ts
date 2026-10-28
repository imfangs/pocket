type Options = {
  createdAt?: number;
  sync: () => Promise<unknown>;
  browser?: Window;
  visibility?: Document;
  now?: () => number;
};

// Native automatic naming may finish after the creation receipt. Only the
// open recent thread or tracked background creation borrows a bounded faster cadence.
// The creation time fixes the deadline; rerenders and reopening cannot renew it.
export function startRecentThreadCatalogSync(options: Options) {
  const browser = options.browser ?? window, visibility = options.visibility ?? document;
  const now = options.now ?? Date.now;
  const createdAt = options.createdAt, startedAt = now(), interval = 5000;
  if (!Number.isFinite(createdAt) || createdAt! <= 0 || createdAt! > startedAt || startedAt - createdAt! >= 60000)
    return () => {};
  const deadline = createdAt! + 60000;
  let stopped = false, pending = false, timer: number | undefined;
  const ready = () => !stopped && visibility.visibilityState === "visible" && browser.navigator.onLine !== false;
  const clear = () => { browser.clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    clear();
    if (!ready() || pending || now() + interval >= deadline) return;
    timer = browser.setTimeout(() => { void refresh(); }, interval);
  };
  const refresh = async () => {
    timer = undefined;
    if (!ready() || pending || now() >= deadline) return;
    pending = true;
    try { await options.sync(); }
    catch { /* The existing catalog reader owns failures and late-response protection. */ }
    finally { pending = false; schedule(); }
  };
  // App's normal foreground handler already performs the immediate shared read.
  // Resume only the supplemental cadence, without sending another eager request.
  visibility.addEventListener("visibilitychange", schedule);
  browser.addEventListener("online", schedule);
  browser.addEventListener("offline", schedule);
  browser.addEventListener("pageshow", schedule);
  schedule();
  return () => {
    stopped = true; clear();
    visibility.removeEventListener("visibilitychange", schedule);
    browser.removeEventListener("online", schedule);
    browser.removeEventListener("offline", schedule);
    browser.removeEventListener("pageshow", schedule);
  };
}
