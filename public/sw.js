/* Crypto Sentinel service worker: shows push notifications. No caching, no network interception. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = { title: "Crypto Sentinel", body: "New alert. Open the dashboard.", tag: "alert", url: "/" };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (e) {
    /* keep defaults */
  }
  event.waitUntil(
    self.registration.showNotification(String(data.title).slice(0, 100), {
      body: String(data.body).slice(0, 300),
      tag: String(data.tag),
      renotify: true,
      requireInteraction: false,
      data: { url: "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow("/");
    }),
  );
});
