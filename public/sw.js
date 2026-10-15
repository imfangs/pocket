const CACHE = "navigator-public-shell-v8";
const PUBLIC_FILES = [
  "/startup.css",
  "/theme.js",
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
      .then((cache) => cache.addAll(PUBLIC_FILES))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("push", event => {
  let data;
  try { data = event.data.json(); } catch { return; }
  if (!/^[a-f0-9-]{36}$/i.test(data?.threadId) || typeof data.body !== "string") return;
  event.waitUntil(self.registration.showNotification("Pocket", {
    body: data.body.slice(0, 100), icon: "/icons/pocket-v1-192.png", badge: "/icons/pocket-v1-192.png",
    tag: `pocket-${data.eventId}`, data: { threadId: data.threadId },
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const id = event.notification.data?.threadId;
  if (!/^[a-f0-9-]{36}$/i.test(id)) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      const acknowledged = await new Promise(resolve => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 3000);
        channel.port1.onmessage = message => {
          if (message.data !== "pocket-task-received") return;
          clearTimeout(timer); channel.port1.close(); resolve(true);
        };
        existing.postMessage({ type: "pocket-open-task", threadId: id }, [channel.port2]);
      });
      if (!acknowledged) await existing.navigate(`/?task=${encodeURIComponent(id)}`);
    } else await self.clients.openWindow(`/?task=${encodeURIComponent(id)}`);
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
