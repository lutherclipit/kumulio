// kumulio Service Worker: empfängt Push-Nachrichten (Preisfehler, DMs, Erwähnungen)
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { }
  e.waitUntil((async () => {
    // App gerade offen und sichtbar? Dann übernimmt das In-App-Banner
    // (das weiß auch, ob man genau in diesem Chat steckt), keine System-Notification obendrauf
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = wins.find(w => w.visibilityState === 'visible');
    if (visible && (d.kind === 'dm' || d.kind === 'mention')) {
      wins.forEach(w => w.postMessage({ type: 'push', data: d }));
      return;
    }
    await self.registration.showNotification(d.title || 'kumulio', {
      body: d.body || '',
      icon: '/brand/kumulio-icon.svg',
      badge: '/brand/kumulio-icon.svg',
      tag: d.tag || '',
      data: { url: d.url || '/' },
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      // Offenes Fenster wiederverwenden statt ein zweites zu öffnen
      const w = wins[0];
      await w.focus();
      w.postMessage({ type: 'open', url });
      return;
    }
    await clients.openWindow(url);
  })());
});
