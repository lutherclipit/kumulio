// kumulio Service Worker: empfängt Push-Nachrichten (Preisfehler, DMs, Geschenke, Gutschriften)
// und nimmt Bilder an, die man aus anderen Apps mit kumulio teilt (Android).

// Neue Fassung sofort aktiv (der Worker cacht keine App-Dateien, nichts kann veralten)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Teilen -> kumulio: Das Teilen-Menue schickt die Dateien als POST an /teilen
// (manifest.json, share_target). Sie kommen kurz in den Cache, dann oeffnet
// die App mit ?teilen=<id> und holt sie dort ab.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'POST' || url.origin !== self.location.origin || url.pathname !== '/teilen') return;
  // Das Teilen-Menue schickt keinen fremden Referrer; ein Formular einer
  // anderen Seite schon — das wird nicht angenommen (die App prueft zusaetzlich)
  const ref = e.request.referrer;
  if (ref && ref !== 'about:client' && new URL(ref).origin !== self.location.origin) {
    e.respondWith(Response.redirect(new URL('/', self.location.origin).href, 303));
    return;
  }
  e.respondWith((async () => {
    try {
      const form = await e.request.formData();
      const dateien = form.getAll('bilder').filter(f => f && typeof f === 'object' && f.size > 0 && f.size < 25e6).slice(0, 10);
      const text = ['title', 'text', 'url'].map(k => form.get(k)).filter(x => typeof x === 'string' && x).join(' ').slice(0, 2000);
      const id = Date.now().toString(36);
      const cache = await caches.open('kumulio-teilen');
      for (const k of await cache.keys()) await cache.delete(k);
      let n = 0;
      for (const f of dateien) {
        await cache.put(`/teilen-datei/${id}/${n++}`, new Response(f, { headers: { 'Content-Type': f.type || 'image/jpeg' } }));
      }
      if (text) await cache.put(`/teilen-datei/${id}/text`, new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
      return Response.redirect(new URL(`/?teilen=${id}&n=${n}`, self.location.origin).href, 303);
    } catch {
      return Response.redirect(new URL('/?teilen=fehler', self.location.origin).href, 303);
    }
  })());
});
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { }
  e.waitUntil((async () => {
    // App gerade offen und sichtbar? Dann übernimmt das In-App-Banner
    // (das weiß auch, ob man genau in diesem Chat steckt), keine System-Notification obendrauf
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = wins.find(w => w.visibilityState === 'visible');
    if (visible && (d.kind === 'dm' || d.kind === 'gift')) {
      wins.forEach(w => w.postMessage({ type: 'push', data: d }));
      return;
    }
    await self.registration.showNotification(d.title || 'kumulio', {
      body: d.body || '',
      // PNG statt SVG: Android zeigt SVG-Icons in Mitteilungen nicht an; das
      // Badge ist einfarbig (Android nutzt nur die Deckkraft)
      icon: '/brand/icon-192.png?v=2',
      badge: '/brand/badge-96.png',
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
