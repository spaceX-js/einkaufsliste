// Service Worker: zeigt Benachrichtigungen an und öffnet beim Antippen die Liste.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch (e) { m = { title: "Einkaufsliste", body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(m.title || "Einkaufsliste", {
    body: m.body || "",
    tag: m.tag || "einkauf",        // gleiche Person → neue Nachricht ersetzt die alte
    renotify: true,
    icon: "/icon.png",
    badge: "/icon.png",
    data: { url: m.url || "/" }
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) { if ("focus" in w) { try { await w.navigate(url); } catch (e) {} return w.focus(); } }
    return self.clients.openWindow(url);
  })());
});
