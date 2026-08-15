// kumulio Service Worker: empfängt Push-Nachrichten (z. B. Preisfehler-Alarm)
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { }
  e.waitUntil(self.registration.showNotification(d.title || 'kumulio', {
    body: d.body || '',
    icon: '/brand/kumulio-icon.svg',
    badge: '/brand/kumulio-icon.svg',
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow((e.notification.data && e.notification.data.url) || '/'));
});
