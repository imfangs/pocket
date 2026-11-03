const CACHE = "navigator-public-shell-v12";
const PUBLIC_FILES = [
  "/startup.css",
  "/theme.js",
  "/language.js",
  "/offline.html",
  "/manifest.webmanifest",
  "/icons/pocket-v1.svg",
  "/icons/pocket-v1-16.png",
  "/icons/pocket-v1-32.png",
  "/icons/pocket-v1-180.png",
  "/icons/pocket-v1-192.png",
  "/icons/pocket-v1-512.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable.png",
  "/icons/apple-touch-icon.png",
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(async (cache) => {
        await cache.addAll(PUBLIC_FILES);
        const offline = await cache.match("/offline.html");
        const html = offline ? await offline.text() : "";
        // During a CDN rollout the script and offline page may arrive at
        // different times. Keep the active shell until this pair agrees.
        if (!html.includes(`name="pocket-offline-shell" content="${CACHE}"`))
          throw new Error("Offline shell version is not ready");
      })
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("push", event => {
  let data;
  try { data = event.data.json(); } catch { return; }
  if (!/^[a-f0-9-]{36}$/i.test(data?.threadId) || typeof data.body !== "string") return;
  const machineId = data.machineId ?? "ged";
  if (!["ged", "wandou"].includes(machineId)) return;
  event.waitUntil(self.registration.showNotification("Pocket", {
    body: data.body.slice(0, 100), icon: "/icons/pocket-v1-192.png", badge: "/icons/pocket-v1-192.png",
    tag: `pocket-${machineId}-${data.eventId}`, data: { threadId: data.threadId, machineId },
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const id = event.notification.data?.threadId;
  if (!/^[a-f0-9-]{36}$/i.test(id)) return;
  const machineId = event.notification.data?.machineId ?? "ged";
  if (!["ged", "wandou"].includes(machineId)) return;
  const target = machineId === "ged" ? `/?task=${encodeURIComponent(id)}`
    : `/?machine=${encodeURIComponent(machineId)}&task=${encodeURIComponent(id)}`;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find(client => {
      const url = new URL(client.url);
      return url.origin === self.location.origin && (url.searchParams.get("machine") ?? "ged") === machineId;
    });
    if (existing) {
      await existing.focus();
      const acknowledged = await new Promise(resolve => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 3000);
        channel.port1.onmessage = message => {
          if (message.data !== "pocket-task-received") return;
          clearTimeout(timer); channel.port1.close(); resolve(true);
        };
        // Older clients do not understand machine IDs. Never send them a
        // remote task through the legacy unscoped message type.
        existing.postMessage({ type: machineId === "ged" ? "pocket-open-task" : "pocket-open-machine-task", threadId: id, machineId }, [channel.port2]);
      });
      // A silent/old client can still own drafts. Keep it intact on fallback.
      if (!acknowledged) await self.clients.openWindow(target);
    } else await self.clients.openWindow(target);
  })());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (k) => k.startsWith("navigator-public-shell-") && k !== CACHE,
            )
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    event.request.method !== "GET" ||
    url.pathname.startsWith("/api/")
  )
    return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then((response) =>
          response.status >= 500 ? caches.match("/offline.html") : response,
        )
        .catch(() => caches.match("/offline.html")),
    );
    return;
  }
  if (PUBLIC_FILES.includes(url.pathname) && !url.search)
    event.respondWith(
      caches
        .match(event.request)
        .then((cached) => cached || fetch(event.request)),
    );
});
