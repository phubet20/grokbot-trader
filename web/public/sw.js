// Grok Bot service worker — Web Push + offline shell for the installed PWA.
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (err) {
    try { data = { body: event.data.text() }; } catch { data = {}; }
  }
  const title = data.title || 'Grok Bot';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: data.url || './', side: data.side, symbol: data.symbol },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || './';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { c.focus(); return; } }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
