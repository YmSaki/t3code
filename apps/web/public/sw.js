/* Minimal PWA Web Push service worker. Never intercepts /ws or /api fetch traffic. */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let title = "T3 Code";
  let body = "";
  let tag = "t3code-notification";
  let targetUrl = "/";

  if (event.data) {
    try {
      const payload = event.data.json();
      if (payload && typeof payload === "object") {
        if (typeof payload.title === "string" && payload.title.length > 0) {
          title = payload.title;
        }
        if (typeof payload.body === "string") {
          body = payload.body;
        }
        if (typeof payload.dedupeKey === "string" && payload.dedupeKey.length > 0) {
          tag = payload.dedupeKey;
        }
        if (typeof payload.url === "string" && payload.url.length > 0) {
          targetUrl = payload.url;
        } else if (typeof payload.threadId === "string" && payload.threadId.length > 0) {
          targetUrl = `/threads/${encodeURIComponent(payload.threadId)}`;
        }
      }
    } catch {
      body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192x192.png",
      badge: "/icon-192x192.png",
      tag,
      data: { url: targetUrl },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawUrl =
    event.notification.data && typeof event.notification.data.url === "string"
      ? event.notification.data.url
      : "/";
  const resolvedUrl = new URL(rawUrl, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (!client.url.startsWith(self.location.origin)) continue;
        if ("navigate" in client && client.url !== resolvedUrl) {
          return client.navigate(resolvedUrl).then(() => client.focus());
        }
        return client.focus();
      }
      return self.clients.openWindow(resolvedUrl);
    }),
  );
});
