// kumulio, Frontend-Logik (Vanilla JS, kein Framework)

const $ = sel => document.querySelector(sel);

// API-Basis: im Web leer (gleiche Origin). In der iOS/Android-App (Capacitor)
// zeigt sie auf den gehosteten Server, in index.html RA_API_BASE setzen.
const API_BASE = (window.RA_API_BASE || localStorage.getItem('ra.apiBase') || '').replace(/\/$/, '');
const state = {
  channels: [],
  follows: JSON.parse(localStorage.getItem('ra.follows') || 'null'), // null = Onboarding nötig
  stars: JSON.parse(localStorage.getItem('ra.stars') || '{}'),       // { dealId: 1..5 }
  wallet: JSON.parse(localStorage.getItem('ra.wallet') || '{"vouchers":[],"cards":[]}'),
  favs: JSON.parse(localStorage.getItem('ra.favs') || '{}'),         // { dealId: {deal, ts, remindAt, notified} }
  pins: JSON.parse(localStorage.getItem('ra.pins') || '["freebies","preisfehler"]'), // angeheftete Feed-Menüs
  aff: JSON.parse(localStorage.getItem('ra.aff') || '{"ch":{},"m":{}}'), // Verhalten für "Für dich"
  activeChip: 'fuer-dich',
  search: '',
  orderIds: null, // eingefrorene Sortierung, Votes würfeln den Feed nicht sofort um
  orderKey: '',
  activeView: 'feed',
  deals: [],
  currentDeal: null,
  sheetMode: null, // 'deal' | 'channels' | 'favs'
  userName: localStorage.getItem('ra.user') || '',
  token: localStorage.getItem('ra.token') || '',
  featured: [],
  notif: JSON.parse(localStorage.getItem('ra.notif') || '{"msgs":true,"mention":true,"reminder":true}'),
};

// ---------------- Dark Mode ----------------

let themeAnimTimer = null;
function applyTheme(t, animate = false) {
  const root = document.documentElement;
  // Weiche Überblendung aller Farben, nur beim aktiven Umschalten, nicht beim Start
  if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    root.classList.add('theme-anim');
    clearTimeout(themeAnimTimer);
    themeAnimTimer = setTimeout(() => root.classList.remove('theme-anim'), 500);
    document.getElementById('btn-theme')?.classList.add('spin');
    setTimeout(() => document.getElementById('btn-theme')?.classList.remove('spin'), 400);
  }
  root.dataset.theme = t;
  localStorage.setItem('ra.theme', t);
  const sw = document.getElementById('sw-theme');
  if (sw) sw.checked = t === 'dark';
}
applyTheme(localStorage.getItem('ra.theme')
  || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

const VIEW_ORDER = ['wallet', 'feed', 'chat', 'search', 'profile', 'settings', 'friends', 'user', 'inventory', 'shop', 'editprofile'];
const FEED_LIMIT = 40;

// Menüpunkte oben: Sparen / Verdienen / Neukunden / Coupons.
// "Gespeichert" läuft nur noch über den Gold-Stern oben rechts.
const SEGMENTS = [
  { slug: 'fuer-dich', name: 'Für dich', icon: 'star' },
  { slug: 'sparen', name: 'Sparen', icon: 'gift' },
  { slug: 'verdienen', name: 'Verdienen', icon: 'banknote' },
  { slug: 'neukunden', name: 'Neukunden', icon: 'sparkle' },
];

// Coupon-Quellen: offizielle Apps/Seiten der Anbieter, ordentlich unterteilt
const COUPON_SOURCES = [
  { cat: 'Drogerie', items: [
    { name: 'Rossmann', url: 'https://www.rossmann.de/de/coupons', desc: 'Coupons in der Rossmann-App & im Coupon-Center' },
    { name: 'Müller', url: 'https://www.mueller.de/', desc: 'Vorteile & Coupons über „Mein Müller"' },
  ]},
  { cat: 'Supermärkte', items: [
    { name: 'Lidl Plus', url: 'https://www.lidl.de/c/lidl-plus/s10007389', desc: 'Wochen-Coupons & Rubbellos in der Lidl-Plus-App' },
    { name: 'REWE', url: 'https://www.rewe.de/angebote/', desc: 'App-Coupons & Payback-Punkte bei REWE' },
    { name: 'EDEKA', url: 'https://www.edeka.de/', desc: 'Coupons & Aktionen in der EDEKA-App' },
    { name: 'Netto', url: 'https://www.netto-online.de/', desc: 'Rabatt-Coupons in der Netto-App, oft ohne Mindestwert' },
  ]},
  { cat: 'Fast Food', items: [
    { name: 'McDonalds', url: 'https://www.mcdonalds.com/de/de-de.html', desc: 'App-Coupons & McDonald’s-Methode-Basics' },
    { name: 'Burger King', url: 'https://www.burgerking.de/', desc: 'King-Deals & Coupons in der BK-App' },
    { name: 'Subway', url: 'https://www.subway.com/de-DE', desc: 'Angebote & Coupons über die Subway-App' },
  ]},
  { cat: 'Einrichtung', items: [
    { name: 'IKEA', url: 'https://www.ikea.com/de/de/ikea-family/', desc: 'IKEA-Family-Angebote & Aktionen' },
  ]},
];

// Marken-Farben für die Logo-Chips (bekannte Anbieter; Rest bekommt eine stabile Farbe)
const BRAND_COLORS = {
  rewe: '#cc071e', amazon: '#232f3e', wunschgutschein: '#e6007e', zalando: '#ff6900',
  lidl: '#0050aa', aldi: '#00005f', netto: '#f6d500', penny: '#cd1414', kaufland: '#e10915',
  edeka: '#ffd400', dm: '#144995', rossmann: '#c3002d', ikea: '#0058a3', payback: '#003eb0',
  wolt: '#00c2e8', lieferando: '#ff8000', spotify: '#1db954', youtube: '#ff0000',
  ebay: '#e53238', otto: '#d4021d', mediamarkt: '#df0000', saturn: '#eb680b',
  mcdonalds: '#ffbc0d', 'burger king': '#d62300', shopback: '#e6293d', steam: '#1b2838',
  'deutsche bahn': '#ec0016', db: '#ec0016', 'nintendo eshop': '#e60012',
  'müller': '#e85d00', mueller: '#e85d00', subway: '#008c15', 'lidl plus': '#0050aa',
};
function brandColor(name) {
  const key = (name || '').toLowerCase().trim();
  if (BRAND_COLORS[key]) return BRAND_COLORS[key];
  for (const [k, v] of Object.entries(BRAND_COLORS)) if (key.includes(k)) return v;
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h}, 45%, 42%)`;
}
function brandInitials(name) {
  const parts = (name || '?').trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : (name || '?').slice(0, 2)).toUpperCase();
}

// ---------------- Verhalten lernen (Basis für "Für dich") ----------------

function bumpAff(d, w) {
  if (!d) return;
  if (d.channel) state.aff.ch[d.channel] = (state.aff.ch[d.channel] || 0) + w;
  if (d.merchant) state.aff.m[d.merchant] = (state.aff.m[d.merchant] || 0) + w;
  save('aff', state.aff);
}

function trackClick(d) {
  if (!d) return;
  bumpAff(d, 1);
  d.clicks = (d.clicks || 0) + 1;
  api('/api/click', { method: 'POST', body: JSON.stringify({ dealId: d.id }) }).catch(() => {});
}

// Beliebtheit: Sterne-Summe + Klicks + Kommentare
function hotScore(d) {
  return (d.rating || 0) * (d.ratingCount || 0) + (d.clicks || 0) + (d.comments || 0);
}

function forYouScore(d) {
  const ageH = (Date.now() - d.ts) / 3600e3;
  return (state.aff.ch[d.channel] || 0) * 3
    + (d.merchant ? (state.aff.m[d.merchant] || 0) * 2 : 0)
    + hotScore(d) * 0.5
    + (ageH < 6 ? 2 : ageH < 24 ? 1 : 0)
    - (d.stale ? 6 : 0);
}

// ---------------- Hilfen ----------------

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

function icon(name, cls = 'icon') {
  return `<svg class="${cls}"><use href="#i-${esc(name)}"/></svg>`;
}

function timeAgo(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'gerade eben';
  const m = Math.round(s / 60);
  if (m < 60) return `vor ${m} Min.`;
  const h = Math.round(m / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24);
  return `vor ${d} Tag${d > 1 ? 'en' : ''}`;
}

async function api(path, opts) {
  const auth = state.token ? { 'Authorization': 'Bearer ' + state.token } : {};
  const res = await fetch(API_BASE + path, {
    ...(opts || {}),
    headers: { ...(opts ? { 'Content-Type': 'application/json' } : {}), ...auth, ...((opts && opts.headers) || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Fehler ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function channelBySlug(slug) { return state.channels.find(c => c.slug === slug); }
function save(key, val) { localStorage.setItem('ra.' + key, JSON.stringify(val)); }

// ---------------- Island (Status-Kapsel) ----------------

let islandTimer = null;
function island(text, holdMs = 2600) {
  $('#island-text').textContent = text;
  $('#island').classList.add('show');
  clearTimeout(islandTimer);
  if (holdMs) islandTimer = setTimeout(() => $('#island').classList.remove('show'), holdMs);
}

// ---------------- Toast (In-App-Notification) ----------------

let toastTimer = null;
function showToast({ title, text, iconName = 'star', actions = [], success = false }, autohideMs = 6000) {
  const t = $('#toast');
  // Erfolgs-Moment: der kumulio-Punkt quittiert (einmal, kein Konfetti), Text bleibt Pflichtsignal
  const successMark = success && window.KBrand ? window.KBrand.successMarkHTML() : '';
  t.innerHTML = `
    <div class="toast-head">${successMark || icon(iconName)} ${esc(title)}</div>
    ${text ? `<div class="toast-text">${esc(text)}</div>` : ''}
    ${actions.length ? `<div class="toast-actions">${actions.map((a, i) =>
      `<button class="btn ${a.ghost ? 'btn-ghost' : ''}" data-action="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}`;
  t.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      hideToast();
      actions[Number(btn.dataset.action)].fn?.();
    });
  });
  t.classList.add('show');
  if (success && window.KBrand) window.KBrand.playSuccess(t);
  clearTimeout(toastTimer);
  if (autohideMs) toastTimer = setTimeout(hideToast, autohideMs);
}
function hideToast() { $('#toast').classList.remove('show'); }

// ---------------- View-Wechsel mit Slide ----------------

// Die schwarze Pille gleitet zum aktiven Tab (Feder-Physik über CSS-Transition)
function moveTabPill() {
  const active = document.querySelector('.tabbtn.active');
  const pill = $('#tab-pill');
  if (!pill) return;
  if (!active) { pill.style.width = '0px'; return; } // z. B. Profil-View (oben rechts)
  pill.style.width = active.offsetWidth + 'px';
  pill.style.transform = `translateX(${active.offsetLeft}px)`;
}
window.addEventListener('resize', moveTabPill);

let viewCleanupTimer = null;

// Laufende Übergänge sofort sauber beenden, verhindert, dass bei schnellem
// Tab-Wechsel ein alter Timer die inzwischen aktive View versteckt/verschiebt
function settleViews() {
  clearTimeout(viewCleanupTimer);
  document.querySelectorAll('.view').forEach(v => {
    v.classList.remove('enter-right', 'enter-left', 'enter-drop');
    v.classList.toggle('hidden', v.id !== 'view-' + state.activeView);
  });
}

// Wechsel ohne Überlappung: alte View sofort weg, nur die neue animiert herein.
// So kann bei schnellem Durchschalten nichts springen oder doppelt erscheinen.
function switchView(next, animClass) {
  if (next === state.activeView) return;
  settleViews();
  const oldView = $('#view-' + state.activeView);
  const newView = $('#view-' + next);
  const dir = VIEW_ORDER.indexOf(next) > VIEW_ORDER.indexOf(state.activeView) ? 1 : -1;
  state.activeView = next;

  document.querySelectorAll('.tabbtn').forEach(t => t.classList.toggle('active', t.dataset.view === next));
  moveTabPill();

  oldView.classList.add('hidden');
  window.scrollTo(0, 0);
  newView.classList.remove('hidden');
  newView.classList.add(animClass || (dir === 1 ? 'enter-right' : 'enter-left'));
  // Login-Captcha erst rendern, wenn die Profil-Seite sichtbar ist
  if (next === 'profile' && !state.token) renderTurnstile('login');
  if (next === 'chat') {
    updateChatGate();
    pollChat(true);
    // Immer unten einsteigen: die neueste Nachricht ist das Wichtigste
    requestAnimationFrame(() => { const b = $('#chat-box'); b.scrollTop = b.scrollHeight; });
  }
  if (next === 'friends') renderFriendsView();
  if (next === 'inventory') renderInventoryPage();
  if (next === 'shop') renderShopPage();
  if (next !== 'wallet') $('#wallet-mini')?.classList.remove('show');
  document.body.classList.toggle('chat-locked', next === 'chat');
  if (next !== 'chat') document.body.style.transform = ''; // Tastatur-Versatz zurücksetzen
  refreshAdminUi();
  viewCleanupTimer = setTimeout(settleViews, 520);
}

// Suche: fällt mit Feder-Bounce von oben ein (Lupe oben links), Zurück-Button führt heim
let searchReturnView = 'feed';
$('#btn-search-top').addEventListener('click', () => {
  if (state.activeView === 'search') return;
  searchReturnView = state.activeView;
  switchView('search', 'enter-drop');
  setTimeout(() => $('#search').focus(), 420);
});
$('#btn-search-back').addEventListener('click', () => switchView(searchReturnView, 'enter-drop'));
$('#btn-settings-back').addEventListener('click', () => switchView('profile', 'enter-drop'));
$('#btn-friends-back').addEventListener('click', () => switchView('profile', 'enter-drop'));
$('#btn-user-back').addEventListener('click', () => switchView(userPageReturn, 'enter-drop'));
$('#btn-inv-back').addEventListener('click', () => switchView('profile', 'enter-drop'));
$('#btn-shop-back').addEventListener('click', () => switchView('profile', 'enter-drop'));
$('#btn-edit-back').addEventListener('click', () => switchView('profile', 'enter-drop'));

// ---- Freunde-Bereich: Liste mit Profilbild, Profil ansehen oder schreiben
async function renderFriendsView() {
  const host = $('#friends-list');
  host.innerHTML = '<div class="status">Lade …</div>';
  try {
    const r = await api('/api/dm/list');
    const friends = myProfile?.friends || [];
    const meta = {};
    r.list.forEach(l => { meta[l.partner] = { avatar: l.avatar, ts: l.lastTs }; });
    (r.friends || []).forEach(f => { meta[f.name] = meta[f.name] || { avatar: f.avatar, ts: 0 }; });
    const sorted = [...friends].sort((a, b) => (meta[b]?.ts || 0) - (meta[a]?.ts || 0));
    host.innerHTML = sorted.length ? sorted.map(f => `
      <div class="friend-row">
        ${meta[f]?.avatar ? `<img class="avatar-big" src="${meta[f].avatar}" alt="">`
        : `<span class="avatar-big" style="background:${chatColor(f)}">${esc(f[0].toUpperCase())}</span>`}
        <span class="friend-name">@${esc(f)}</span>
        <button class="btn btn-small btn-ghost" data-fr-profile="${esc(f)}">Profil</button>
        <button class="btn btn-small" data-fr-write="${esc(f)}">Schreiben</button>
      </div>`).join('')
      : '<div class="status">Noch keine Freunde. Schick oben eine Anfrage!</div>';
    host.querySelectorAll('[data-fr-profile]').forEach(b => b.onclick = () => openUserPop(b.dataset.frProfile));
    host.querySelectorAll('[data-fr-write]').forEach(b => b.onclick = () => {
      switchView('chat');
      setChatMode('dm', b.dataset.frWrite);
    });
  } catch { host.innerHTML = '<div class="status">Konnte die Liste nicht laden.</div>'; }
}
$('#fr-add-send').addEventListener('click', async () => {
  const name = $('#fr-add-name').value.trim();
  if (!name) return;
  await api('/api/friend', { method: 'POST', body: JSON.stringify({ user: name, action: 'add' }) })
    .then(r => {
      if (myProfile) { myProfile.friends = r.friends; myProfile.friendRequests = r.friendRequests; }
      island(r.friends.includes(name) ? 'Ihr seid jetzt Freunde!' : 'Anfrage gesendet');
      $('#fr-add-name').value = '';
      renderFriendsView();
    }).catch(e => island(e.message));
});

// Konto löschen: doppelte Rückfrage, dann endgültig
$('#btn-account-delete').addEventListener('click', async () => {
  if (!await askConfirm('Willst du dein Konto wirklich löschen? Profil, Wallet und Chats sind dann weg.', { okLabel: 'Ja, weiter' })) return;
  if (!await askConfirm('Letzte Frage: endgültig löschen? Das lässt sich nicht rückgängig machen.', { okLabel: 'Endgültig löschen' })) return;
  try {
    await api('/api/account/delete', { method: 'POST', body: '{}' });
    state.token = ''; state.userName = ''; state.role = '';
    localStorage.removeItem('ra.token'); localStorage.removeItem('ra.user'); localStorage.removeItem('ra.wallet');
    myProfile = null;
    refreshProfileTab();
    switchView('feed');
    island('Konto gelöscht. Mach es gut!');
  } catch (e) { island(e.message); }
});

$('#tabbar').addEventListener('click', e => {
  const btn = e.target.closest('.tabbtn');
  if (!btn) return;
  // Nochmal auf den aktiven Tab tippen = smooth nach ganz oben
  if (btn.dataset.view === state.activeView) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  switchView(btn.dataset.view);
});

// ---------------- Onboarding ----------------

function showOnboarding() {
  const grid = $('#onboarding-channels');
  const picked = new Set(['hot', 'preisfehler', 'freebies']);
  grid.innerHTML = state.channels.map(c => `
    <button class="onboarding-chip ${picked.has(c.slug) ? 'active' : ''}" data-slug="${esc(c.slug)}">
      ${icon(c.icon)} ${esc(c.name)}
    </button>`).join('');
  grid.onclick = e => {
    const b = e.target.closest('.onboarding-chip');
    if (!b) return;
    const slug = b.dataset.slug;
    picked.has(slug) ? picked.delete(slug) : picked.add(slug);
    b.classList.toggle('active', picked.has(slug));
  };
  $('#btn-onboarding-done').onclick = () => {
    state.follows = [...picked];
    if (!state.follows.length) state.follows = ['hot'];
    save('follows', state.follows);
    $('#onboarding').classList.add('hidden');
    renderChipbar();
    loadFeed();
  };
  $('#onboarding').classList.remove('hidden');
}

// ---------------- Chipbar + Feed ----------------

// Chip-Leiste: Beliebt + angeheftete Kanäle, Rest hinter "Mehr" ausklappbar.
// Was angeheftet ist, stellt der Nutzer im Kanäle-Sheet selbst ein.
// Genau drei Menüpunkte: Für dich · Luthers Picks · Gespeichert
// Feed-Chips als 3D-Karussell: der aktive sitzt mittig, die Nachbarn
// rutschen kleiner und leicht nach hinten, antippen dreht durch
function renderChipbar() {
  $('#chipbar').innerHTML = SEGMENTS.map(c =>
    `<button class="chip carousel-chip" data-slug="${esc(c.slug)}">${icon(c.icon)} ${esc(c.name)}</button>`).join('');
  requestAnimationFrame(layoutChipCarousel);
}
function layoutChipCarousel() {
  const chips = [...document.querySelectorAll('#chipbar .carousel-chip')];
  let ai = SEGMENTS.findIndex(s => s.slug === state.activeChip);
  if (ai < 0) ai = 0;
  const GAP = 14;
  const scaleOf = o => o === 0 ? 1 : Math.max(.68, .84 - Math.abs(o) * .06);
  // Mittelpunkte aus den ECHTEN (skalierten) Chip-Breiten aufsummieren, damit
  // die Lücke zwischen allen Nachbarn gleich groß ist (feste 112px waren es nicht)
  const centers = chips.map(() => 0);
  for (let i = ai + 1; i < chips.length; i++) {
    centers[i] = centers[i - 1]
      + (chips[i - 1].offsetWidth * scaleOf(i - 1 - ai)) / 2 + GAP
      + (chips[i].offsetWidth * scaleOf(i - ai)) / 2;
  }
  for (let i = ai - 1; i >= 0; i--) {
    centers[i] = centers[i + 1]
      - ((chips[i + 1].offsetWidth * scaleOf(i + 1 - ai)) / 2 + GAP
      + (chips[i].offsetWidth * scaleOf(i - ai)) / 2);
  }
  chips.forEach((ch, i) => {
    const o = i - ai;
    ch.style.transform = `translateX(calc(-50% + ${Math.round(centers[i])}px)) scale(${scaleOf(o)})`;
    ch.style.opacity = o === 0 ? 1 : Math.max(.3, .6 - Math.abs(o) * .14);
    ch.style.zIndex = 20 - Math.abs(o);
    ch.classList.toggle('active', o === 0 && state.activeChip === SEGMENTS[i]?.slug);
  });
}

function moveChipPill() {
  const active = $('#chipbar .chip.active');
  const pill = $('#chip-pill');
  if (!pill) return;
  if (!active) { pill.style.width = '0px'; return; }
  pill.style.width = active.offsetWidth + 'px';
  pill.style.transform = `translateX(${active.offsetLeft}px)`;
}
window.addEventListener('resize', moveChipPill);

$('#chipbar').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.activeChip = chip.dataset.slug;
  layoutChipCarousel();
  renderFeed(true);
});

async function loadFeed() {
  // Ladezustand: der kumulio-Punkt ersetzt den Spinner (zeigt sich erst nach 200 ms)
  const loader = window.KBrand
    ? window.KBrand.createLoader($('#feed'), { mode: 'inline' })
    : { done() { } };
  try {
    const data = await api('/api/deals?channels=' + state.channels.map(c => c.slug).join(','));
    state.deals = data.deals;
    const errSlugs = Object.keys(data.errors || {});
    if (errSlugs.length) {
      island(`${errSlugs.map(s => channelBySlug(s)?.name || s).join(', ')} gerade nicht erreichbar`);
    }
  } catch (e) {
    island('Feed nicht erreichbar');
  }
  loader.done();
  renderFeed(true);
  enrichCompares();
}

// Suche als eigener Tab: durchsucht alle Angebote (Titel, Marke, Text)
function renderSearch() {
  const s = $('#search').value.trim().toLowerCase();
  const box = $('#search-results');
  if (s.length < 2) { box.innerHTML = '<div class="status">Tippe mindestens 2 Zeichen.</div>'; return; }
  const hits = state.deals.filter(d =>
    (d.title + ' ' + (d.merchant || '') + ' ' + (d.excerpt || '')).toLowerCase().includes(s));
  box.innerHTML = hits.length
    ? hits.slice(0, FEED_LIMIT).map((d, i) => renderOfferCard(d, i, false)).join('')
    : `<div class="status">Nichts gefunden für „${esc(s)}".</div>`;
}
$('#search').addEventListener('input', renderSearch);

function quality(d) {
  return d.ratingCount ? (d.rating || 0) / 5 : null;
}

// Sterne-Anzeige: ★★★★☆ 4.2 (12)
function renderStars(d) {
  const avg = d.rating || 0;
  const full = Math.round(avg);
  return `
    <span class="stars">
      ${[1, 2, 3, 4, 5].map(i => icon('star', 'icon' + (i <= full && d.ratingCount ? ' on' : ''))).join('')}
      ${d.ratingCount ? `<span class="stars-value">${avg.toFixed(1)}</span> <span class="stars-count">(${d.ratingCount})</span>` : ''}
    </span>`;
}

// Eine Sternereihe fürs Sheet: zeigt den Schnitt und nimmt deine Bewertung an
function renderStarsCombined(d) {
  const mine = state.stars[d.id] || 0;
  const avg = d.rating || 0;
  const shown = mine || Math.round(avg);
  return `
    <div class="stars-combined" data-rate-deal="${esc(d.id)}">
      <span class="stars-input">${[1, 2, 3, 4, 5].map(i => icon('star', 'icon' + (i <= shown ? ' on' : ''))).join('')}</span>
      <span class="stars-meta">${d.ratingCount ? `${avg.toFixed(1)} von 5 (${d.ratingCount})` : 'Noch keine Bewertungen'}${mine ? ` · deine Bewertung: ${mine}` : ' · tippe einen Stern zum Bewerten'}</span>
    </div>`;
}

document.addEventListener('click', async e => {
  const box = e.target.closest('[data-rate-deal]');
  if (!box) return;
  const iconEl = e.target.closest('.icon');
  if (!iconEl) return;
  const starsEls = [...box.querySelectorAll('.icon')];
  const val = starsEls.indexOf(iconEl) + 1;
  if (val < 1) return;
  const id = box.dataset.rateDeal;
  const d = state.deals.find(x => x.id === id) || state.favs[id]?.deal;
  if (!d) return;
  const prev = state.stars[id] || null;
  state.stars[id] = val;
  save('stars', state.stars);
  if (val >= 4) bumpAff(d, 2);
  // Feedback: Stern schwebt hoch
  const fl = document.createElement('div');
  fl.className = 'vote-float up';
  fl.textContent = '★'.repeat(val);
  fl.style.left = (e.clientX - 20) + 'px';
  fl.style.top = (e.clientY - 26) + 'px';
  document.body.appendChild(fl);
  setTimeout(() => fl.remove(), 750);
  try {
    const r = await api('/api/rate', { method: 'POST', body: JSON.stringify({ dealId: id, stars: val, prev }) });
    d.rating = r.rating; d.ratingCount = r.ratingCount;
  } catch { /* offline */ }
  renderFeed();
  if (state.sheetMode === 'deal' && state.currentDeal?.id === id) {
    const slot = $('#sheet-stars-slot');
    if (slot) slot.innerHTML = renderStarsCombined(d);
  }
});

// Spar-Badges: Rabatt / Gratis / Verdienst / Preisfehler, auf einen Blick
function renderBadges(d, withTimer) {
  const out = [];
  if (d.channel === 'preisfehler') {
    out.push(`<span class="badge badge-pf"><span class="pf-glitch" data-text="PREISFEHLER">PREISFEHLER</span></span>`);
    if (withTimer) out.push(`<span class="pf-timer" data-pf-ts="${d.ts}">${icon('clock')} <span>${pfElapsed(d.ts)}</span></span>`);
  }
  if (d.free) {
    out.push(`<span class="badge badge-free">GRATIS</span>`);
  } else if (d.discount != null) {
    out.push(d.discount >= 50
      ? `<span class="badge badge-hot">${icon('flame')} −${d.discount} %</span>`
      : `<span class="badge badge-discount">−${d.discount} %</span>`);
  }
  if (d.earn) out.push(`<span class="badge badge-earn">+ VERDIENST</span>`);
  if (d.newCustomer) out.push(`<span class="badge badge-free" style="background:rgba(90,150,240,.18); color:#3d6fb4">NUR NEUKUNDEN</span>`);
  if (d.compareChecked) out.push(`<span class="badge badge-free" title="Vergleichspreis mit billiger.de geprüft">${icon('check', 'icon icon-sm')} geprüft</span>`);
  return out.join(' ');
}

// Countdown "Läuft ab in …" für Deals mit Enddatum
function cdText(ts) {
  let s = Math.floor((ts - Date.now()) / 1000);
  if (s <= 0) return 'Abgelaufen';
  const d = Math.floor(s / 86400); s %= 86400;
  return `Läuft ab in ${d ? d + 't ' : ''}${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m ${s % 60}s`;
}

// Live-Zähler: wie lange gibt es den Preisfehler schon?
function pfElapsed(ts) {
  let s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return (d ? d + 'd ' : '') + `${h}:${m}:${sec}`;
}
setInterval(() => {
  document.querySelectorAll('.pf-timer').forEach(el => {
    const span = el.querySelector('span');
    if (span) span.textContent = pfElapsed(Number(el.dataset.pfTs));
  });
  document.querySelectorAll('[data-cd]').forEach(el => {
    el.textContent = cdText(Number(el.dataset.cd));
  });
}, 1000);

// Flammen/%-Burst beim Antippen stark reduzierter Deals
function spawnBurst(x, y, hot) {
  for (let i = 0; i < 6; i++) {
    const el = document.createElement('div');
    el.className = 'burst-item';
    el.innerHTML = hot && i % 2 === 0 ? icon('flame') : '%';
    el.style.left = (x - 10 + (Math.random() * 44 - 22)) + 'px';
    el.style.top = (y - 10) + 'px';
    el.style.setProperty('--bx', (Math.random() * 70 - 35) + 'px');
    el.style.setProperty('--br', (Math.random() * 50 - 25) + 'deg');
    el.style.animationDelay = (i * 40) + 'ms';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1100);
  }
}


// Deals, die im aktiven Segment sichtbar sind (Gespeichert nutzt die Merkliste)
function segmentDeals() {
  if (state.activeChip === 'saved') {
    return Object.values(state.favs)
      .sort((a, b) => b.ts - a.ts)
      .map(f => state.deals.find(d => d.id === f.deal.id) || f.deal);
  }
  if (state.activeChip === 'fuer-dich') {
    // Für dich: alles auf einen Blick, filtern geht über die anderen Chips
    return state.deals;
  }
  if (state.activeChip === 'sparen') {
    // Sparen: gratis bekommen und günstiger einkaufen (ohne Neukunden-Aktionen)
    return state.deals.filter(d => d.channel !== 'geld-verdienen' && !d.newCustomer);
  }
  if (state.activeChip === 'verdienen') {
    // Verdienen: KWK-Deals, Referrals, Prämien (ohne Neukunden-Aktionen)
    return state.deals.filter(d => d.channel === 'geld-verdienen' && !d.newCustomer);
  }
  if (state.activeChip === 'neukunden') {
    // Neukunden: Aktionen, die nur für neue Kunden gelten
    return state.deals.filter(d => d.newCustomer);
  }
  return state.deals;
}

function computeOrder() {
  state.orderIds = segmentDeals().map(d => d.id);
  state.orderKey = state.activeChip;
}

// Coupons (im Wallet): Verzeichnis der offiziellen Coupon-Quellen + GzG + Payback
function renderCoupons(host) {
  host = host || $('#coupons-content');
  const hasPayback = state.wallet.cards.some(c => /payback/i.test(c.name));
  const gzg = state.deals.filter(d => /geld.?zur(ü|ue)ck|gzg\b/i.test(d.title + ' ' + (d.excerpt || '')));

  // Alle Quellen als App-Kacheln, Reihenfolge merkt sich die App (Ziehen zum Sortieren)
  const all = [{
    name: 'Payback', url: 'https://www.payback.de/coupons', cat: 'Punkte',
    desc: hasPayback ? 'Coupon-Center: eCoupons für deine verbundene Karte aktivieren'
      : 'Karte in der Wallet verbinden, dann findest du hier dein Coupon-Center',
  }];
  COUPON_SOURCES.forEach(sec => sec.items.forEach(it => all.push({ ...it, cat: sec.cat })));
  const order = JSON.parse(localStorage.getItem('ra.couponOrder') || '[]');
  const pos = n => { const i = order.indexOf(n); return i < 0 ? 999 : i; };
  all.sort((a, b) => pos(a.name) - pos(b.name));
  const q = (state.couponQuery || '').trim().toLowerCase();
  const shown = all.filter(it => !q || it.name.toLowerCase().includes(q)
    || it.cat.toLowerCase().includes(q) || (it.desc || '').toLowerCase().includes(q));

  host.innerHTML = `
    <input id="coupon-search" class="input" type="search" placeholder="Coupons suchen; z.B. Lidl, Drogerie …" value="${esc(state.couponQuery || '')}">
    <p class="muted grid-hint">Antippen öffnet die offizielle Coupon-Seite. Gedrückt halten und ziehen zum Sortieren.</p>
    <div class="app-grid" id="coupon-grid">
      ${shown.map(it => `
      <a class="app-tile" data-cpn="${esc(it.name)}" title="${esc(it.desc || '')}"
         href="${esc(it.url)}" target="_blank" rel="noopener noreferrer" style="--bc:${brandColor(it.name)}">
        ${brandChipHtml(it.name)}
        <span class="app-tile-name">${esc(it.name)}</span>
        <span class="app-tile-desc">${esc(it.cat)}</span>
      </a>`).join('')
      || '<div class="status">Nichts gefunden.</div>'}
    </div>
    <h3 class="wallet-h" style="margin-top:18px">Geld-zurück-Garantien (GzG)</h3>
    ${gzg.length
      ? gzg.map((d, i) => renderOfferCard(d, i, false)).join('')
      : '<div class="status">Aktuelle GzG-Aktionen postet die Redaktion über das Admin-Panel, sie erscheinen dann hier.</div>'}`;

  const cs = host.querySelector('#coupon-search');
  cs.addEventListener('input', () => {
    state.couponQuery = cs.value;
    const at = cs.selectionStart;
    renderCoupons(host);
    const again = host.querySelector('#coupon-search');
    again.focus();
    again.setSelectionRange(at, at);
  });
  makeGridSortable(host.querySelector('#coupon-grid'), '[data-cpn]', newOrder => {
    if ((state.couponQuery || '').trim()) return;
    localStorage.setItem('ra.couponOrder', JSON.stringify(newOrder));
  }, el => el.dataset.cpn);
}

function renderFeed(reorder = false) {
  const ch = channelBySlug(state.activeChip);
  const isCommunity = ch?.type === 'community';
  $('#community-banner').classList.toggle('hidden', !isCommunity);

  // Sortierung nur bei Chip-Wechsel/Neuladen neu berechnen, ein Vote soll den
  // Feed nicht sofort umwürfeln, das pendelt sich beim nächsten Laden ein
  if (reorder || !state.orderIds || state.orderKey !== state.activeChip) computeOrder();
  const deals = state.orderIds
    .map(id => state.deals.find(d => d.id === id) || state.favs[id]?.deal)
    .filter(Boolean);
  const shown = deals.slice(0, FEED_LIMIT);

  if (!shown.length) {
    $('#feed').innerHTML = `<div class="status">${state.activeChip === 'saved'
      ? 'Noch nichts gespeichert, tippe auf den Stern eines Angebots oder wische die Karte nach links.'
      : state.activeChip === 'neukunden'
        ? 'Aktuell keine Neukunden-Aktionen, neue kommen über das Admin-Panel.'
        : 'Noch keine Angebote in diesem Bereich, neue kommen über das Admin-Panel.'}</div>`;
    return;
  }

  $('#feed').innerHTML = shown.map((d, i) => renderOfferCard(d, i, reorder)).join('')
    + (deals.length > FEED_LIMIT ? `<div class="status">Zeige die neuesten ${FEED_LIMIT} von ${deals.length}.</div>` : '');
}

function renderOfferCard(d, i, reorder) {
  {
    const c = channelBySlug(d.channel);
    const q = quality(d);
    const isFav = !!state.favs[d.id];
    const cta = d.dealUrl || d.sourceUrl;
    const brand = d.merchant || c?.name || 'Deal';
    return `
    <div class="deal-wrap ${reorder ? 'anim' : ''}" data-deal="${esc(d.id)}" ${reorder ? `style="animation-delay:${Math.min(i, 8) * 45}ms"` : ''}>
      <div class="fav-hint">${icon('star')}</div>
      <article class="deal offer ${d.channel === 'preisfehler' ? 'deal-pf' : ''} ${d.stale ? 'stale' : ''} ${isFav ? 'faved' : ''}" style="display:block">
        <div class="offer-head">
          ${brandChipHtml(brand)}
          <div class="offer-brand">
            <div class="offer-merchant">${esc(brand)}</div>
            <div class="offer-cat">${esc(d.kind === 'gutschein' ? 'Gutscheine' : (c?.name || 'Angebot'))} · ${esc(timeAgo(d.ts))}</div>
          </div>
          <div class="offer-side">
            ${renderStars(d)}
            <span class="stars-count">${icon('message', 'icon icon-sm')} ${d.comments || 0}</span>
          </div>
        </div>
        <div class="deal-title" style="margin-top:8px">${esc(d.title)}</div>
        <div class="deal-sub">
          ${d.price ? `<span class="price">${esc(d.price)}</span>` : ''}
          <span class="compare-slot">${renderComparePrice(d)}</span>
          ${renderBadges(d)}
          ${d.endTs && !d.stale ? `<span class="pill pill-danger" data-cd="${d.endTs}">${cdText(d.endTs)}</span>` : ''}
          ${d.stale ? `<span class="badge badge-stale">VERMUTLICH VORBEI</span>` : ''}
        </div>
        <div class="offer-actions">
          ${cta ? `<a class="cta-mini" href="${esc(cta)}" target="_blank" rel="noopener noreferrer" data-cta="${esc(d.id)}">zum Deal ${icon('arrow-right')}</a>` : ''}
          <button class="offer-iconbtn ${isFav ? 'on' : ''}" data-bm="${esc(d.id)}" aria-label="Merken">${icon('star')}</button>
          <button class="offer-iconbtn" data-share="${esc(d.id)}" aria-label="Teilen">${icon('share')}</button>
        </div>
      </article>
    </div>`;
  }
}

// ---------------- Swipe nach links = merken ----------------

const drag = { id: null, el: null, startX: 0, startY: 0, dx: 0, active: false };
let suppressClickUntil = 0;

$('#feed').addEventListener('pointerdown', e => {
  const wrap = e.target.closest('.deal-wrap');
  if (!wrap) return;
  drag.id = wrap.dataset.deal;
  drag.el = wrap;
  drag.startX = e.clientX;
  drag.startY = e.clientY;
  drag.dx = 0;
  drag.active = false;
});

$('#feed').addEventListener('pointermove', e => {
  if (!drag.el) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (!drag.active) {
    if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy)) return;
    drag.active = true;
    drag.el.classList.add('dragging');
    document.body.classList.add('no-select');
    try { drag.el.setPointerCapture(e.pointerId); } catch { /* synthetische Pointer */ }
  }
  drag.dx = Math.min(0, dx);
  drag.el.querySelector('.deal').style.transform = `translateX(${drag.dx}px)`;
});

function endDrag() {
  if (!drag.el) return;
  const card = drag.el.querySelector('.deal');
  if (drag.active) {
    suppressClickUntil = Date.now() + 350;
    if (drag.dx < -80) toggleFav(drag.id);
    card.style.transform = '';
    drag.el.classList.remove('dragging');
    document.body.classList.remove('no-select');
  }
  drag.el = null;
  drag.active = false;
  drag.dx = 0;
}
$('#feed').addEventListener('pointerup', endDrag);
$('#feed').addEventListener('pointercancel', endDrag);

async function shareDeal(d) {
  const shareUrl = d.dealUrl || d.sourceUrl || location.href;
  try {
    if (navigator.share) { await navigator.share({ title: d.title, url: shareUrl }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(shareUrl); island('Link kopiert'); }
  catch { island('Teilen nicht möglich'); }
}

function onOfferClick(e) {
  if (Date.now() < suppressClickUntil) { e.preventDefault(); return; }
  const share = e.target.closest('[data-share]');
  if (share) { shareDeal(state.deals.find(x => x.id === share.dataset.share)); return; }
  const bm = e.target.closest('[data-bm]');
  if (bm) { toggleFav(bm.dataset.bm); return; }
  const ctaLink = e.target.closest('a[data-cta]');
  if (ctaLink) { trackClick(state.deals.find(x => x.id === ctaLink.dataset.cta)); return; } // Link öffnet, kein Sheet
  const wrap = e.target.closest('.deal-wrap');
  if (wrap) {
    const d = state.deals.find(x => x.id === wrap.dataset.deal);
    if (!d) return;
    // Stark reduziert oder gratis: Flammen und Prozente sprühen beim Antippen
    if ((d.discount != null && d.discount >= 50) || d.free) {
      spawnBurst(e.clientX, e.clientY, d.discount != null && d.discount >= 50);
    }
    trackClick(d);
    openDealSheet(d);
  }
}
$('#feed').addEventListener('click', onOfferClick);
$('#search-results').addEventListener('click', onOfferClick);

// ---------------- Favoriten + Erinnerungen ----------------

function toggleFav(dealId) {
  const d = state.deals.find(x => x.id === dealId) || state.favs[dealId]?.deal;
  if (!d) return;
  if (state.favs[dealId]) {
    delete state.favs[dealId];
    save('favs', state.favs);
    renderFeed();
    showToast({ title: 'Aus der Merkliste entfernt', iconName: 'x', text: d.title.slice(0, 60) }, 3000);
    return;
  }
  state.favs[dealId] = { deal: d, ts: Date.now(), remindAt: null, notified: false };
  bumpAff(d, 2);
  save('favs', state.favs);
  renderFeed();
  showToast({
    title: 'Deal gemerkt',
    text: 'Wann sollen wir dich erinnern, damit er nicht untergeht?',
    iconName: 'star',
    success: true,
    actions: [
      { label: 'In 1 Std.', fn: () => setReminder(dealId, 60) },
      { label: 'In 3 Std.', fn: () => setReminder(dealId, 180) },
      { label: 'Morgen 9 Uhr', fn: () => setReminder(dealId, 'morning') },
      { label: 'Ohne Timer', ghost: true, fn: () => {} },
    ],
  }, 12000);
}

function setReminder(dealId, minutesOrMorning) {
  const fav = state.favs[dealId];
  if (!fav) return;
  let at;
  if (minutesOrMorning === 'morning') {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    at = d.getTime();
  } else {
    at = Date.now() + minutesOrMorning * 60 * 1000;
  }
  fav.remindAt = at;
  fav.notified = false;
  save('favs', state.favs);
  island('Erinnerung gestellt');
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function checkReminders() {
  if (state.notif.reminder === false) return;
  const now = Date.now();
  for (const [id, fav] of Object.entries(state.favs)) {
    if (fav.remindAt && !fav.notified && fav.remindAt <= now) {
      fav.notified = true;
      save('favs', state.favs);
      island('Deal-Erinnerung');
      showToast({
        title: 'Erinnerung an deinen Deal',
        text: fav.deal.title.slice(0, 80),
        iconName: 'bell',
        actions: [
          { label: 'Ansehen', fn: () => openDealSheet(fav.deal) },
          { label: 'OK', ghost: true, fn: () => {} },
        ],
      }, 0);
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('kumulio, Deal-Erinnerung', { body: fav.deal.title.slice(0, 100) });
      }
    }
  }
}
setInterval(checkReminders, 30 * 1000);

// ---------------- Sheet (generisch) ----------------

function openSheetShell() {
  // Formulare (Hinzufügen) kompakt statt Vollbild, kein leerer Swipe-Raum
  $('#sheet').classList.toggle('compact', state.sheetMode === 'wallet-add');
  $('#sheet-backdrop').classList.remove('hidden');
  requestAnimationFrame(() => {
    $('#sheet-backdrop').classList.add('show');
    $('#sheet').classList.add('open');
  });
  $('#sheet-content').scrollTop = 0;
}

function closeSheet() {
  $('#sheet').classList.remove('open');
  $('#sheet-backdrop').classList.remove('show');
  setTimeout(() => $('#sheet-backdrop').classList.add('hidden'), 300);
  state.currentDeal = null;
  state.sheetMode = null;
}
$('#sheet-backdrop').addEventListener('click', closeSheet);
$('#sheet-handle').addEventListener('click', () => { if (!sheetDrag.moved) closeSheet(); });
$('#sheet-fab').addEventListener('click', closeSheet);
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeSheet(); hideToast(); } });

// Sheet mit Runterwischen schließen: immer über die Greifzone oben,
// im Inhalt nur, wenn er ganz nach oben gescrollt ist
const sheetDrag = { startY: 0, dy: 0, active: false, tracking: false, moved: false };
const sheetEl = $('#sheet');

sheetEl.addEventListener('pointerdown', e => {
  const content = $('#sheet-content');
  if (e.target.closest('.sheet-fab')) return;
  if (content.scrollTop > 0 && content.contains(e.target)) return;
  // Textauswahl/Native-Drag unterbinden, aber Eingabefelder & Buttons normal lassen
  if (!e.target.closest('input, textarea, button, a, .votebtn')) e.preventDefault();
  sheetDrag.tracking = true;
  sheetDrag.startY = e.clientY;
  sheetDrag.dy = 0;
  sheetDrag.active = false;
  sheetDrag.moved = false;
});

sheetEl.addEventListener('pointermove', e => {
  if (!sheetDrag.tracking) return;
  const dy = e.clientY - sheetDrag.startY;
  if (!sheetDrag.active) {
    if (dy < 8) return;
    sheetDrag.active = true;
    sheetDrag.moved = true;
    sheetEl.classList.add('dragging');
    document.body.classList.add('no-select');
    try { sheetEl.setPointerCapture(e.pointerId); } catch { /* synthetische Pointer */ }
  }
  sheetDrag.dy = Math.max(0, dy);
  sheetEl.style.transform = `translate(-50%, ${sheetDrag.dy}px)`;
});

function endSheetDrag() {
  if (!sheetDrag.tracking) return;
  sheetDrag.tracking = false;
  if (!sheetDrag.active) return;
  sheetEl.classList.remove('dragging');
  document.body.classList.remove('no-select');
  sheetEl.style.transform = '';
  if (sheetDrag.dy > 110) closeSheet();
  sheetDrag.active = false;
  sheetDrag.dy = 0;
}
sheetEl.addEventListener('pointerup', endSheetDrag);
sheetEl.addEventListener('pointercancel', endSheetDrag);

// ---------------- Deal-Detail ----------------

// Nur echte, vergleichbare Produkte bekommen den idealo-Preisvergleich.
// Reisen, Cashback, Tarife, Gutscheine, Gastro & Ingame-Zeug haben dort nichts zu suchen.
const NON_PRODUCT = /urlaub|reise\b|\bnächte\b|hotel|\bflug\b|übernachtung|ferien|kreuzfahrt|\babos?\b|gutschein|cashback|payback|\bpunkte\b|e-?sim\b|\btarif|allnet|sim.?only|vertrag|konto|kredit|depot|versicherung|\bticket|eintritt|\bkino\b|konzert|\[lokal|lokal\]|mcdonald|burger king|kfc|subway|lieferando|gta\$|in-?game|\bdlc\b|guthaben|\bcoins\b|spotify|netflix|disney\+|streaming/i;
function isProduct(d) {
  return d.source === 'mydealz'
    && !['cashback', 'geld-verdienen', 'methoden'].includes(d.channel)
    && !NON_PRODUCT.test(d.title);
}

// ---------------- Echter Preisvergleich (billiger.de, lazy nachgeladen) ----------------

function parsePriceNum(s) { return s ? parseFloat(s.replace(/\./g, '').replace(',', '.')) : null; }

// Nur anzeigen, wenn der Marktpreis zum Deal passt (falscher Produkt-Treffer → lieber nichts)
function plausibleCompare(d, r) {
  if (!r || r.miss || !r.priceNum) return false;
  const p = parsePriceNum(d.price);
  if (p) return r.priceNum >= p * 0.5 && r.priceNum <= p * 5;
  return true;
}

// Durchgestrichener Vergleichspreis: live vom Markt (inkl. Versand), sonst "statt"-Preis
function renderComparePrice(d) {
  if (d.free) return '';
  if (d.compare?.price) {
    const label = d.compare.last ? 'zuletzt ' : 'ab ';
    const tip = (d.compare.last ? 'Zuletzt bekannter Marktpreis' : 'Günstigster Marktpreis')
      + (d.compare.shippingIncluded ? ' inkl. Versand' : '') + ' (billiger.de)';
    return `<span class="compare-price" title="${tip}">${label}${esc(d.compare.price)}</span>`;
  }
  if (d.origPrice) return `<span class="compare-price" title="Vergleichspreis laut Deal">${esc(d.origPrice)}</span>`;
  return '';
}

function renderCompareBtn(d) {
  if (d.free || !d.compare?.url) return '';
  return `<a class="btn btn-block btn-compare" href="${esc(d.compare.url)}" target="_blank" rel="noopener noreferrer">
    ${icon('chart', 'icon icon-sm')} Preisvergleich: ab ${esc(d.compare.price)} · billiger.de</a>`;
}

function patchCompare(d) {
  const slot = document.querySelector(`.deal-wrap[data-deal="${d.id}"] .compare-slot`);
  if (slot) slot.innerHTML = renderComparePrice(d);
  if (state.sheetMode === 'deal' && state.currentDeal?.id === d.id) openDealSheet(d);
}

function requestCompare(d) {
  if (!isProduct(d) || d.compare !== undefined) return;
  d.compare = null; // markiert "angefragt"
  const hint = parsePriceNum(d.price);
  // Der direkte Produktlink des Deals identifiziert das Produkt am präzisesten
  const u = d.dealUrl && /^https?:\/\//.test(d.dealUrl) ? '&u=' + encodeURIComponent(d.dealUrl) : '';
  api('/api/compare?q=' + encodeURIComponent(compareQuery(d.title)) + (hint ? '&p=' + hint : '') + u)
    .then(r => { if (plausibleCompare(d, r)) { d.compare = r; patchCompare(d); } })
    .catch(() => {});
}

// Alle Produkt-Deals bekommen automatisch einen Vergleichspreis (Server drosselt + cacht)
function enrichCompares() {
  // Gratis-Deals brauchen keinen Marktvergleich
  state.deals.filter(d => isProduct(d) && !d.free && d.compare === undefined).slice(0, 60).forEach(requestCompare);
}

// Suchbegriff für den Preisvergleich aus dem Titel destillieren
function compareQuery(title) {
  return title
    .replace(/\[.*?\]|\(.*?\)/g, ' ')
    .replace(/preisfehler|sammeldeal|gutscheinfehler/gi, ' ')
    .split(/\bfür\b|\bstatt\b|[|,–]| - /i)[0]
    .replace(/\d+[.,]?\d*\s*€|\d+\s?%/g, ' ')
    .replace(/\s+/g, ' ').trim().split(' ').slice(0, 7).join(' ');
}

function openDealSheet(deal) {
  state.currentDeal = deal;
  state.sheetMode = 'deal';
  const d = deal;
  const c = channelBySlug(d.channel);
  const cta = d.dealUrl || d.sourceUrl;
  const isFav = !!state.favs[d.id];
  const images = (d.images && d.images.length ? d.images : (d.image ? [d.image] : []));
  const flags = (d.flags || []).map(f => `<span class="pill pill-warn">${icon('warning', 'icon icon-sm')} ${esc(f)}</span>`).join(' ');
  requestCompare(d); // Marktpreis nachladen, falls noch nicht da
  // Preisvergleich: Markt-Preis (live) und/oder "statt"-Preis aus dem Deal
  const priceNum = parsePriceNum(d.price);
  const origNum = parsePriceNum(d.origPrice);
  const cmpNum = d.compare?.priceNum || null;
  const maxNum = Math.max(priceNum || 0, origNum || 0, cmpNum || 0);
  const bar = v => Math.max(10, Math.round(v / maxNum * 150));

  $('#sheet-content').innerHTML = `
    ${images.length ? `
    <div class="gallery">
      <div class="gallery-track" id="gal-track">
        ${images.map(u => `<img src="${esc(u)}" alt="" draggable="false" onerror="this.closest('.gallery')?.remove()">`).join('')}
      </div>
      ${images.length > 1 ? `<div class="gallery-dots" id="gal-dots">${images.map((_, i) => `<i class="${i === 0 ? 'on' : ''}"></i>`).join('')}</div>` : ''}
    </div>` : BRAND_DOMAINS[(d.merchant || '').toLowerCase()] ? `
    <div class="brand-hero" style="--bc:${brandColor(d.merchant)}">
      <img src="https://www.google.com/s2/favicons?domain=${BRAND_DOMAINS[(d.merchant || '').toLowerCase()]}&sz=128" alt="${esc(d.merchant)}" onerror="this.closest('.brand-hero').remove()">
    </div>` : ''}
    <div class="sheet-title">${esc(d.title)}</div>
    <div class="sheet-subrow">
      ${d.price ? `<span class="sheet-price">${esc(d.price)}</span>` : ''}
      <span style="font-size:1.05rem">${renderComparePrice(d)}</span>
      <span id="sheet-stars-slot">${renderStarsCombined(d)}</span>
    </div>
    <div class="sheet-subrow">
      ${d.endTs && !d.stale ? `<span class="pill pill-danger" data-cd="${d.endTs}">${cdText(d.endTs)}</span>` : ''}
      ${d.stale ? `<span class="badge badge-stale">VERMUTLICH VORBEI</span>` : ''}
      ${renderBadges(d, true)}
      ${d.merchant ? `<span class="pill">${esc(d.merchant)}</span>` : ''}
      ${d.user ? `<span class="pill pill-accent">@${esc(d.user)}</span>` : ''}
      ${c ? `<span class="pill">${icon(c.icon, 'icon icon-sm')} ${esc(c.name)}</span>` : ''}
      <span class="pill">${esc(timeAgo(d.ts))}</span>
      ${flags}
      <button class="btn-share" id="btn-sheet-share" aria-label="Teilen">${icon('share')}</button>
    </div>
    ${state.role === 'admin' && d.source === 'community' ? `
    <button class="btn btn-small btn-ghost" id="btn-deal-edit" style="margin-top:10px">Deal bearbeiten</button>` : ''}
    ${cta ? `
    <div class="sheet-cta">
      <a class="btn btn-block" href="${esc(cta)}" target="_blank" rel="noopener noreferrer">
        ${d.source === 'community' ? 'Link öffnen, auf eigene Gefahr' : 'zum Produkt'} ${icon('arrow-right', 'icon icon-sm')}
      </a>
      ${renderCompareBtn(d)}
      ${d.source === 'mydealz' ? `<div class="sheet-source">${d.dealUrl ? 'öffnet die Händlerseite' : 'öffnet die Deal-Quelle'} · automatisch gefunden</div>` : ''}
    </div>` : ''}
    ${priceNum && (origNum || cmpNum) ? `
    <div class="sheet-section compare">
      <h3>${icon('chart', 'icon icon-sm')} Preisvergleich</h3>
      ${origNum ? `<div class="compare-row"><span class="compare-label">vorher</span><span class="compare-bar" style="width:${bar(origNum)}px"></span><b>${esc(d.origPrice)}</b></div>` : ''}
      ${cmpNum ? `<div class="compare-row"><span class="compare-label">Markt ab</span><span class="compare-bar" style="width:${bar(cmpNum)}px"></span><b>${esc(d.compare.price)}</b></div>` : ''}
      <div class="compare-row"><span class="compare-label">Deal</span><span class="compare-bar now" style="width:${bar(priceNum)}px"></span><b>${esc(d.price)}${d.discount != null ? ` (−${d.discount} %)` : ''}</b></div>
      <div class="sheet-source" style="text-align:left; margin-top:6px">${cmpNum ? 'Marktpreis live von billiger.de (günstigstes Angebot)' : 'Vergleichspreis aus den Deal-Angaben'} · Preishistorie folgt mit dem Backend</div>
    </div>` : ''}
    <div class="sheet-votebar">
      <button class="votebtn" id="btn-sheet-fav">${icon('star')} ${isFav ? 'Gemerkt, entfernen' : 'Merken'}</button>
    </div>
    ${d.excerpt ? `
    <div class="sheet-section">
      <h3>Beschreibung</h3>
      <div class="sheet-desc ${d.excerpt.length > 240 ? 'clamped' : ''}" id="sheet-desc">${esc(d.excerpt)}</div>
      ${d.excerpt.length > 240 ? '<button class="desc-more" id="desc-more">Mehr anzeigen</button>' : ''}
    </div>` : ''}
    ${c?.rules?.length ? `
    <div class="sheet-section">
      <details class="rules-fold">
        <summary>${icon('list', 'icon icon-sm')} Regeln &amp; Richtlinien ${icon('chevron', 'icon icon-sm chev')}</summary>
        <div class="rules">
          ${c.rules.map(r => `<div class="rule">${icon('check')} <span>${esc(r)}</span></div>`).join('')}
        </div>
      </details>
    </div>` : ''}
    <div class="sheet-section">
      <h3>${icon('message', 'icon icon-sm')} Kommentare</h3>
      <div id="sheet-comments" class="sheet-comments"><div class="status">Lade …</div></div>
      <input type="hidden" id="comment-parent" value="">
      <div id="comment-replyhint" class="form-msg hidden"></div>
      ${state.token
        ? `<textarea id="comment-text" class="input" maxlength="600" rows="2" placeholder="Kommentar schreiben …"></textarea>
      <div class="form-row">
        <button id="btn-comment-send" class="btn">Senden</button>
        <span id="comment-msg" class="form-msg"></span>
      </div>`
        : '<div class="status">Zum Kommentieren bitte anmelden.</div>'}
    </div>`;

  $('#btn-comment-send')?.addEventListener('click', sendComment);
  $('#desc-more')?.addEventListener('click', () => {
    const dd = $('#sheet-desc');
    const collapsed = dd.classList.toggle('clamped');
    $('#desc-more').textContent = collapsed ? 'Mehr anzeigen' : 'Weniger anzeigen';
  });
  $('#btn-sheet-share')?.addEventListener('click', () => shareDeal(d));
  $('#btn-deal-edit')?.addEventListener('click', () => openAdminPost(d));
  $('#btn-sheet-fav').addEventListener('click', () => {
    toggleFav(d.id);
    openDealSheet(d); // Button-Text aktualisieren
  });
  // Galerie-Punkte beim Swipen mitführen
  const track = $('#gal-track');
  const dots = $('#gal-dots');
  if (track && dots) {
    track.addEventListener('scroll', () => {
      const i = Math.round(track.scrollLeft / track.clientWidth);
      dots.querySelectorAll('i').forEach((el, j) => el.classList.toggle('on', j === i));
    }, { passive: true });
  }
  openSheetShell();
  refreshComments();
}

// Ein Kommentar mit Badge, Reaktionen (Like/Hilfreich/Emote), Antworten und Löschen
function commentHtml(c, replies) {
  if (c.deleted) {
    return `<div class="comment"><div class="comment-text chat-deleted">Kommentar gelöscht</div>
      ${replies.map(r => commentHtml(r, [])).join('')}</div>`;
  }
  const badge = c.badge && chatBadges[c.badge]
    ? `<svg class="icon icon-sm chat-badge"><use href="#i-${chatBadges[c.badge].icon}"/></svg>` : '';
  const role = c.role === 'admin' ? `<svg class="icon icon-sm chat-badge role-admin"><use href="#i-crown"/></svg>` : '';
  const rx = c.reactions || {};
  const mine = k => (rx[k] || []).includes(state.userName);
  const emoteRx = Object.keys(rx).filter(k => k !== 'like' && k !== 'helpful');
  const canDelete = state.userName === c.user || ['admin', 'mod'].includes(state.role);
  return `
    <div class="comment" data-cid="${esc(c.id)}">
      <div class="comment-head">
        ${role}${badge}<span class="comment-user" style="color:${chatColor(c.user)}">@${esc(c.user)}</span>
        <span class="comment-time">${esc(timeAgo(c.ts))}</span>
        ${(c.flags || []).map(f => `<span class="pill pill-warn">${icon('warning', 'icon icon-sm')} ${esc(f)}</span>`).join('')}
      </div>
      <div class="comment-text">${withEmotes(esc(c.text))}</div>
      <div class="comment-actions">
        <button class="c-act ${mine('like') ? 'on' : ''}" data-creact="like">${icon('thumb-up', 'icon icon-sm')} ${(rx.like || []).length || ''}</button>
        <button class="c-act ${mine('helpful') ? 'on' : ''}" data-creact="helpful">${icon('check', 'icon icon-sm')} Hilfreich ${(rx.helpful || []).length || ''}</button>
        <button class="c-act" data-cemote="1">${icon('smile', 'icon icon-sm')}</button>
        <button class="c-act" data-creply="${esc(c.user)}">Antworten</button>
        ${canDelete ? `<button class="c-act" data-cdel="1">Löschen</button>` : ''}
        ${emoteRx.map(k => `<button class="c-act emote-rx ${mine(k) ? 'on' : ''}" data-creact="${esc(k)}">${emoteHtml(k)} ${rx[k].length}</button>`).join('')}
      </div>
      ${replies.map(r => commentHtml(r, [])).join('')}
    </div>`;
}

async function refreshComments() {
  if (!state.currentDeal) return;
  const list = await api('/api/comments?dealId=' + state.currentDeal.id).catch(() => []);
  const box = $('#sheet-comments');
  if (!box) return;
  const tops = list.filter(c => !c.parent);
  const repliesOf = id => list.filter(c => c.parent === id);
  box.innerHTML = tops.length
    ? tops.map(c => commentHtml(c, repliesOf(c.id))).join('')
    : '<div class="status">Noch keine Kommentare, sei der Erste.</div>';

  const dealId = state.currentDeal.id;
  const react = (cid, kind) => api('/api/comments/react', {
    method: 'POST', body: JSON.stringify({ dealId, id: cid, kind }),
  }).then(refreshComments).catch(e => island(e.message));
  box.querySelectorAll('[data-creact]').forEach(b => b.onclick = () =>
    react(b.closest('.comment').dataset.cid, b.dataset.creact));
  box.querySelectorAll('[data-cemote]').forEach(b => b.onclick = () => {
    // Kleine Emote-Auswahl direkt unterm Kommentar
    const names = Object.keys(chatEmotes).slice(0, 12);
    const cid = b.closest('.comment').dataset.cid;
    const pick = document.createElement('div');
    pick.className = 'comment-emote-pick';
    pick.innerHTML = names.map(n => `<button data-e="${esc(n)}">${emoteHtml(n)}</button>`).join('');
    b.closest('.comment-actions').after(pick);
    pick.querySelectorAll('[data-e]').forEach(x => x.onclick = () => { react(cid, x.dataset.e); pick.remove(); });
    setTimeout(() => document.addEventListener('click', () => pick.remove(), { once: true }), 50);
  });
  box.querySelectorAll('[data-creply]').forEach(b => b.onclick = () => {
    $('#comment-parent').value = b.closest('.comment').dataset.cid;
    const hint = $('#comment-replyhint');
    hint.classList.remove('hidden');
    hint.textContent = `Antwort an @${b.dataset.creply} (tippen zum Abbrechen)`;
    hint.onclick = () => { $('#comment-parent').value = ''; hint.classList.add('hidden'); };
    $('#comment-text')?.focus();
  });
  box.querySelectorAll('[data-cdel]').forEach(b => b.onclick = async () => {
    if (!await askConfirm('Diesen Kommentar löschen?', { okLabel: 'Löschen' })) return;
    api('/api/comments/delete', {
      method: 'POST', body: JSON.stringify({ dealId, id: b.closest('.comment').dataset.cid }),
    }).then(refreshComments).catch(e => island(e.message));
  });
}

async function sendComment() {
  const msg = $('#comment-msg');
  msg.className = 'form-msg';
  try {
    await api('/api/comments', {
      method: 'POST',
      body: JSON.stringify({ dealId: state.currentDeal.id, text: $('#comment-text').value, parent: $('#comment-parent').value }),
    });
    $('#comment-text').value = '';
    $('#comment-parent').value = '';
    $('#comment-replyhint').classList.add('hidden');
    msg.textContent = '';
    await refreshComments();
    const d = state.deals.find(x => x.id === state.currentDeal.id);
    if (d) d.comments = (d.comments || 0) + 1;
    renderFeed();
  } catch (e) {
    msg.className = 'form-msg error';
    msg.textContent = e.message;
  }
}

// ---------------- Feeds & Kanäle-Menü (Chip neben den Tabs) ----------------

function openChannelsSheet() {
  state.sheetMode = 'channels';
  const pinRow = (c, extra = '') => {
    const pinned = state.pins.includes(c.slug);
    return `
    <div class="channel-row">
      <div class="channel-icon ${c.type === 'community' ? 'community' : ''}">${icon(c.icon)}</div>
      <div class="channel-info">
        <div class="channel-name">${esc(c.name)} ${extra}</div>
        ${c.desc ? `<div class="channel-desc">${esc(c.desc)}</div>` : ''}
      </div>
      <button class="iconbtn ${pinned ? 'pinned' : ''}" data-pin="${esc(c.slug)}" title="${pinned ? 'Aus der Leiste lösen' : 'Oben anheften'}">${icon('pin')}</button>
    </div>`;
  };
  const specials = SPECIAL_CHIPS.slice(1); // Für dich ist immer da
  $('#sheet-content').innerHTML = `
    <div class="sheet-title">Feeds anpassen</div>
    <p class="muted" style="font-size:.85rem; margin-top:6px; line-height:1.5">
      „Für dich" ist immer oben. Mit dem Pin bestimmst du, welche Feeds und Kanäle
      daneben stehen, so viele oder wenige du willst.</p>
    <div class="channel-list">
      ${specials.map(s => pinRow({ ...s, desc: s.slug === 'beliebt' ? 'Am meisten geliked und geklickt.' : s.slug === 'trending' ? 'Was gerade Fahrt aufnimmt.' : 'Alles, chronologisch.' })).join('')}
      ${state.channels.map(c => pinRow(
        c.slug === 'freebies' ? { ...c, name: 'Gratis' } : c,
        c.type === 'rss'
          ? '<span class="pill pill-accent">automatisch</span>'
          : `<span class="pill pill-warn">${icon('warning', 'icon icon-sm')} Community</span>`
      )).join('')}
    </div>`;

  $('#sheet-content').querySelectorAll('[data-pin]').forEach(btn => {
    btn.addEventListener('click', () => {
      const slug = btn.dataset.pin;
      if (state.pins.includes(slug)) {
        state.pins = state.pins.filter(s => s !== slug);
        if (state.activeChip === slug) state.activeChip = 'fuer-dich';
      } else {
        state.pins.push(slug);
        if (!state.follows.includes(slug) && channelBySlug(slug)) state.follows.push(slug);
        save('follows', state.follows);
      }
      save('pins', state.pins);
      renderChipbar();
      loadFeed();
      openChannelsSheet();
    });
  });

  openSheetShell();
}

// ---------------- Favoriten-Sheet ----------------

// Goldener Stern oben (aktuell aus dem Header entfernt, Gespeichert bleibt über Karten-Sterne erreichbar)
$('#btn-favs')?.addEventListener('click', () => {
  state.activeChip = 'saved';
  renderChipbar();
  renderFeed(true);
  if (state.activeView !== 'feed') switchView('feed');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

function openFavsSheet() {
  state.sheetMode = 'favs';
  const favs = Object.entries(state.favs).sort((a, b) => b[1].ts - a[1].ts);
  $('#sheet-content').innerHTML = `
    <div class="sheet-title">Gemerkte Deals</div>
    <p class="muted" style="font-size:.85rem; margin:6px 0 14px; line-height:1.5">
      Karten im Feed nach links ziehen, um Deals hier zu sammeln.</p>
    ${favs.length ? favs.map(([id, f]) => `
      <div class="fav-row" data-fav-open="${esc(id)}">
        ${f.deal.image ? `<img class="fav-img" src="${esc(f.deal.image)}" alt="">` : `<div class="fav-img"></div>`}
        <div class="fav-info">
          <div class="fav-title">${esc(f.deal.title)}</div>
          <div class="fav-meta">
            ${f.deal.price ? `<span class="price">${esc(f.deal.price)}</span>` : ''}
            ${f.remindAt && !f.notified ? `<span class="pill">${icon('bell', 'icon icon-sm')} ${new Date(f.remindAt).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>` : ''}
          </div>
        </div>
        <button class="fav-remove" data-fav-remove="${esc(id)}" aria-label="Entfernen">${icon('x', 'icon icon-sm')}</button>
      </div>`).join('')
    : '<div class="status">Noch nichts gemerkt.</div>'}`;

  $('#sheet-content').querySelectorAll('[data-fav-remove]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      delete state.favs[btn.dataset.favRemove];
      save('favs', state.favs);
      renderFeed();
      openFavsSheet();
    });
  });
  $('#sheet-content').querySelectorAll('[data-fav-open]').forEach(row => {
    row.addEventListener('click', () => openDealSheet(state.favs[row.dataset.favOpen].deal));
  });

  openSheetShell();
}

// ---------------- Profil: Registrieren / Anmelden ----------------

function refreshProfileTab() {
  // Oben rechts: "Anmelden"-Button (Gast) bzw. Avatar mit Initiale (angemeldet)
  const btn = $('#btn-profile-top');
  if (state.token && state.userName) {
    btn.className = 'iconbtn';
    btn.innerHTML = `<span class="avatar-mini">${esc(state.userName[0].toUpperCase())}</span>`;
    btn.setAttribute('aria-label', 'Profil: ' + state.userName);
  } else {
    btn.className = 'btn-auth';
    btn.textContent = 'Anmelden';
    btn.setAttribute('aria-label', 'Anmelden / Registrieren');
  }
  $('#auth-card').classList.toggle('hidden', !!state.token);
  $('#me-card').classList.toggle('hidden', !state.token);
  $('#gami-card').classList.toggle('hidden', !state.token);
  $('#btn-logout').classList.toggle('hidden', !state.token);
  $('#danger-card').classList.toggle('hidden', !state.token);
  if (!state.token) $('#bio-card').classList.add('hidden'); // öffnet nur über "Profil bearbeiten"
  if (state.token) {
    // Eigener Name mit dem angelegten Paint, auch auf dem eigenen Profil
    const me = $('#me-name');
    me.textContent = state.userName;
    if (myProfile?.activePaint) {
      const ns = nameStyleOf(state.userName, myProfile.activePaint);
      me.className = ns.cls.trim();
      me.setAttribute('style', ns.style);
    } else {
      me.className = '';
      me.removeAttribute('style');
    }
    refreshGami();
  }
  renderWallet(); // Wallet-Sperre folgt dem Login-Status
  updateChatGate();
}

// ---------------- Gamification: Coins, Kisten, Badges ----------------

let myProfile = null;
function badgeChip(id, def, active) {
  return `<button class="badge-chip rar-${def.rar === 'häufig' ? 'common' : def.rar === 'selten' ? 'rare' : 'epic'} ${active ? 'on' : ''}" data-badge="${esc(id)}" title="${esc(def.rar)}">
    <svg class="icon icon-sm"><use href="#i-${def.icon}"/></svg><span>${esc(def.name)}</span>
  </button>`;
}
async function refreshGami() {
  if (!state.token) return;
  try { myProfile = await api('/api/profile'); } catch { return; }
  const oldCoins = Number($('#g-coins').textContent) || 0;
  animateInt($('#g-coins'), oldCoins, myProfile.coins || 0);
  $('#g-bio').value = myProfile.bio || '';
  $('#g-public').checked = myProfile.publicProfile !== false;
  // Profilbild + Lieblings-Kleinigkeiten
  const av = $('#g-avatar-preview');
  if (myProfile.avatar) av.outerHTML = `<img class="avatar-big" id="g-avatar-preview" src="${myProfile.avatar}" alt="">`;
  else av.outerHTML = `<span class="avatar-big" id="g-avatar-preview" style="background:${chatColor(state.userName || '?')}">${esc((state.userName || '?')[0].toUpperCase())}</span>`;
  $('#g-avatar-del').classList.toggle('hidden', !myProfile.avatar);
  // Profil so zeigen, wie Besucher es sehen
  const rank = rankFor(renderWallet.lastTotal || 0);
  $('#g-rank-row').innerHTML = `<span class="rank-chip">${esc(rank.name)}</span>`;
  $('#me-avatar').innerHTML = myProfile.avatar
    ? `<img class="avatar-big" src="${myProfile.avatar}" alt="">`
    : `<span class="avatar-big" style="background:${chatColor(state.userName || '?')}">${esc((state.userName || '?')[0].toUpperCase())}</span>`;
  $('#me-bio').textContent = myProfile.bio || 'Noch keine Bio. Erzähl kurz, wer du bist!';
  // Lieblings-Sachen als Marken-Logos, wo wir das Logo kennen
  const mf = myProfile.favs || {};
  const favChip = v => BRAND_DOMAINS[String(v || '').toLowerCase()]
    ? `<span class="fav-logo">${brandChipHtml(v)}<small>${esc(v)}</small></span>`
    : `<span class="pill">${esc(v)}</span>`;
  $('#me-favs').innerHTML = ['discounter', 'supermarkt', 'essen', 'onlineshop', 'mode']
    .map(k => mf[k] ? favChip(mf[k]) : '').join('');
  // Nur EIN Badge im Profil: das getragene (auswählen geht im Inventar)
  const ab = myProfile.activeBadge;
  $('#me-badges').innerHTML = ab && myProfile.badgesAll[ab]
    ? badgeChip(ab, myProfile.badgesAll[ab], true)
    : '<span class="stars-count">Kein Badge angelegt. Wähl eins im Inventar.</span>';
  $('#me-handle').textContent = '@' + (state.userName || '');
  // Showcase: bis zu 3 Items zum Flexen
  const sc = gami?.showcase || [];
  $('#me-showcase').innerHTML = sc.length ? sc.map(key => {
    const [kind, id] = key.split(':');
    const rar = itemRarity(kind, id);
    const col = (gami?.rarity || {})[rar]?.color || '#888';
    const fl = (gami?.floats || {})[key] ?? 0;
    return `<div class="sc-slot ${isShinyF(fl) ? 'shiny' : ''}" style="--rc:${col}" title="${esc(itemName(kind, id))}">
      ${itemVisual(kind, id)}<span class="inv-float">#${String(fl).padStart(3, '0')}</span>
    </div>`;
  }).join('') : '';
  renderFavPickers();
  // Topbar-Avatar: Profilbild statt Initiale + roter Punkt bei Anfragen
  if (myProfile.avatar && state.token) $('#btn-profile-top').innerHTML = `<img class="avatar-mini avatar-img" src="${myProfile.avatar}" alt="">`;
  updateReqDot();
  refreshGamiSystem();
}
// Ganze Zahlen animiert zählen (Coins)
function animateInt(el, from, to, ms = 600) {
  if (!el) return;
  if (reducedMotion() || from === to) { el.textContent = String(to); return; }
  const t0 = performance.now();
  const safety = setTimeout(() => { el.textContent = String(to); }, ms + 100);
  const tick = now => {
    const p = Math.min(1, (now - t0) / ms);
    el.textContent = String(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(tick); else clearTimeout(safety);
  };
  requestAnimationFrame(tick);
}
$('#g-daily').addEventListener('click', async () => {
  const m = $('#g-msg');
  setBtnLoading($('#g-daily'), true);
  try {
    const r = await api('/api/daily', { method: 'POST', body: '{}' });
    playSfx('coin'); buzz(30); moneyFlash('green');
    animateInt($('#g-coins'), r.coins - r.gained, r.coins);
    m.className = 'form-msg ok';
    m.textContent = `+${r.gained} Coins! Serie: ${r.streak} Tag${r.streak > 1 ? 'e' : ''}.${r.caseWon ? ' Und eine Kiste!' : ''}`;
    myProfile && (myProfile.coins = r.coins);
    refreshGamiSystem();
  } catch (e) { m.className = 'form-msg error'; m.textContent = e.message; }
  finally { setBtnLoading($('#g-daily'), false); }
});
// ---------------- Ränge, Kisten (nur erspielbar) und Paints ----------------

let gami = null;
const CASE_IMGS = { standard: 'case-01-standard', silber: 'case-02-silber', gold: 'case-03-gold', prisma: 'case-04-prisma' };
const rankFile = r => `/gamification/rank-${String(r.tier).padStart(2, '0')}-${r.id}.svg`;
const paintById = id => (gami?.paintsAll || chatPaints || []).find(x => x.id === id);

// Item-Helfer: Anzeige, Float, Shiny, Wert
const isShinyF = f => {
  const s = String(f ?? 0).padStart(3, '0');
  return (s[0] === s[1] && s[1] === s[2]) || (+s[1] === +s[0] + 1 && +s[2] === +s[1] + 1);
};
function itemVisual(kind, id) {
  if (kind === 'paint') {
    const pnt = paintById(id);
    return `<span class="reel-paint" style="background-image:${pnt?.css || 'none'}"></span>`;
  }
  if (kind === 'badge') return `<svg class="icon"><use href="#i-${(gami?.badgesAll || {})[id]?.icon || 'star'}"/></svg>`;
  return `<img class="emote" style="height:26px" src="https://cdn.7tv.app/emote/${(gami?.emotesAll || {})[id]?.id}/2x.webp" alt="">`;
}
function itemRarity(kind, id) {
  if (kind === 'paint') return paintById(id)?.rarity || 'common';
  if (kind === 'badge') return ({ 'häufig': 'common', 'selten': 'rare', 'episch': 'epic' })[(gami?.badgesAll || {})[id]?.rar] || 'common';
  return (gami?.emotesAll || {})[id]?.rarity || 'common';
}
function itemName(kind, id) {
  if (kind === 'paint') return paintById(id)?.name || id;
  if (kind === 'badge') return (gami?.badgesAll || {})[id]?.name || id;
  return id;
}
// Item inspecten: groß anschauen, mit Float, Rarität und Shiny-Glitzer
function openInspect(kind, id, float, rarity) {
  const col = (gami?.rarity || {})[rarity]?.color || '#888';
  const shiny = isShinyF(float);
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `
    <div class="modal case-modal inspect ${shiny ? 'shiny' : ''}" style="--rc:${col}">
      <div class="case-win-visual inspect-visual">${itemVisual(kind, id)}</div>
      <b style="font-size:1.15rem">${esc(itemName(kind, id))}</b>
      <span class="inv-float">#${String(float ?? 0).padStart(3, '0')}${shiny ? ' ✦ SHINY' : ''}</span>
      <span style="color:${col}; font-weight:800">${esc((gami?.rarity || {})[rarity]?.label || rarity)}</span>
    </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener('click', () => { wrap.classList.add('closing'); setTimeout(() => wrap.remove(), 280); });
}

function myItems() {
  if (!gami) return [];
  return [
    ...gami.paints.map(id => ({ kind: 'paint', id })),
    ...(gami.badgesOwned || myProfile?.badges || []).map(id => ({ kind: 'badge', id })),
    ...(gami.emotes || []).map(id => ({ kind: 'emote', id })),
  ].map(it => ({ ...it, float: (gami.floats || {})[`${it.kind}:${it.id}`] ?? 0, rarity: itemRarity(it.kind, it.id) }));
}

async function refreshGamiSystem() {
  if (!state.token) return;
  try { gami = await api('/api/gami'); } catch { return; }
  animateInt($('#g-coins'), Number($('#g-coins').textContent) || 0, gami.coins || 0);
  // Rank-Up feiern: einmalige Vollbild-Celebration
  const lastTier = Number(localStorage.getItem('ra.tier') || 0);
  if (lastTier && gami.rank.tier > lastTier) rankUpFx(gami.rank);
  localStorage.setItem('ra.tier', gami.rank.tier);
  // Quests: gebündelt, kompakt, Coins per "Abholen"
  const GROUPS = [
    ['Community', ['comment', 'rate', 'chat', 'friend']],
    ['Wallet', ['voucher', 'booking']],
    ['Täglich', ['daily', 'newsletter', 'push']],
  ];
  const claimables = gami.claimable || [];
  $('#quests-claim-count').textContent = claimables.length ? `(${claimables.length} abholbar)` : '';
  $('#gm-quests').innerHTML = GROUPS.map(([label, keys]) => `
    <div class="quest-group"><b>${label}</b>
    ${keys.map(k => {
      const q = gami.quests.find(x => x.key === k);
      if (!q) return '';
      const claim = claimables.find(c => c.key === k);
      const nextMs = q.milestones.find(([n]) => !q.awarded.includes(`${q.key}:${n}`));
      const target = nextMs ? nextMs[0] : q.milestones[q.milestones.length - 1][0];
      const done = !nextMs && !claim;
      return `
      <div class="quest-row ${done ? 'done' : ''}">
        <div class="quest-main">
          <span>${esc(q.name)} <small>${Math.min(q.progress, target)}/${target}</small></span>
          ${claim ? `<button class="btn btn-small" data-qclaim="${esc(claim.tag)}">Abholen +${claim.coins}</button>`
            : `<small>${done ? 'komplett' : `+${nextMs[1]} Coins`}</small>`}
        </div>
        <div class="rank-progress"><div class="rank-progress-fill" style="width:${Math.min(100, Math.round(q.progress / target * 100))}%"></div></div>
      </div>`;
    }).join('')}</div>`).join('');
  $('#gm-quests').querySelectorAll('[data-qclaim]').forEach(b => b.onclick = async () => {
    try {
      const r = await api('/api/quests/claim', { method: 'POST', body: JSON.stringify({ tag: b.dataset.qclaim }) });
      achvToast(`Quest geschafft: ${r.quest}`, `+${r.gained} Coins`);
      playSfx('coin'); buzz(25);
      refreshGamiSystem();
    } catch (e) { island(e.message); }
  });
  const rank = gami.rank;
  // RANG: Name, Fortschritt ab dem AKTUELLEN Rang, klare Punkteanzeige
  $('#gm-rank-head').innerHTML = `
    <div class="gm-rank-row">
      <img class="px-icon big" src="${rankFile(rank)}" alt="">
      <div class="gm-rank-text">
        <b>RANG: <span style="color:${rank.color}">${esc(rank.name)}</span></b>
        ${gami.next
          ? `<span>${gami.points - rank.points} / ${gami.next.points - rank.points} Punkte bis ${esc(gami.next.name)} (${gami.next.points} nötig)</span>`
          : '<span>Höchste Stufe erreicht!</span>'}
      </div>
    </div>
    ${gami.next ? `<div class="rank-progress big"><div class="rank-progress-fill" style="width:${Math.round((gami.points - rank.points) / (gami.next.points - rank.points) * 100)}%"></div></div>` : ''}`;
  // Leiter: Punkte-Anforderung sichtbar, scrollt automatisch zum aktuellen Rang
  $('#gm-ladder').innerHTML = gami.ranks.map(r => `
    <div class="gm-step ${r.tier <= rank.tier ? 'done' : ''} ${r.tier === rank.tier ? 'current' : ''}" title="${esc(r.name)}">
      <img class="px-icon" src="${rankFile(r)}" alt="${esc(r.name)}">
      <span>${esc(r.name)}</span>
      <small>${r.points} P.</small>
    </div>`).join('');
  setTimeout(() => $('#gm-ladder .gm-step.current')?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }), 200);
  $('#gm-paints').innerHTML = (gami.paints || []).length
    ? gami.paints.map(id => {
      const pnt = paintById(id);
      if (!pnt) return '';
      return `<button class="gm-paint ${gami.activePaint === id ? 'on' : ''}" data-paint="${esc(id)}">
        <span class="paint" style="--paint:${pnt.css}; color:${pnt.fallbackColor}">${esc(pnt.name)}</span>
      </button>`;
    }).join('')
    : '<span class="form-msg">Paints kommen aus Kisten und färben deinen Namen im Chat.</span>';
  $('#gm-paints').querySelectorAll('[data-paint]').forEach(b => b.onclick = async () => {
    const next = gami.activePaint === b.dataset.paint ? '' : b.dataset.paint;
    await api('/api/paint', { method: 'POST', body: JSON.stringify({ id: next }) }).catch(() => { });
    gami.activePaint = next;
    refreshGamiSystem();
    island(next ? 'Paint angelegt' : 'Paint abgelegt');
  });
}

// Info: Wie sammelt man Aktivitätspunkte?
$('#gm-rank-info').addEventListener('click', () => askConfirm(
  'So sammelst du Aktivitätspunkte: 2 je Abbuchung, 5 je Gutschein in der Wallet, 1 je aktivem Tag (Tagesbonus) und 8 je aufgebrauchtem Gutschein. Es zählt dein Sparverhalten, nie die Betragshöhe.',
  { alertOnly: true }));

// Inventar: alle Items mit Float, Shiny-Glitzer, Anlegen/Showcase/Verkaufen
function openInventory() {
  state.sheetMode = 'gami-inv';
  const items = myItems();
  $('#sheet-content').innerHTML = `
    <div class="sheet-title">Inventar</div>
    <p class="muted" style="font-size:.8rem">Float bis 999: Schnapszahlen und Straßen glitzern und sind beim Verkauf das Fünffache wert. Bis zu 3 Items kannst du in dein Profil stellen.</p>
    ${items.length ? `<div class="inv-grid">${items.map(it => {
      const col = (gami.rarity || {})[it.rarity]?.color || '#888';
      const shiny = isShinyF(it.float);
      const val = (gami.sellValues || {})[it.rarity] * (shiny ? 5 : 1);
      const inShowcase = (gami.showcase || []).includes(`${it.kind}:${it.id}`);
      const equipped = (it.kind === 'paint' && gami.activePaint === it.id) || (it.kind === 'badge' && myProfile?.activeBadge === it.id);
      return `
      <div class="inv-item ${shiny ? 'shiny' : ''}" style="--rc:${col}">
        <div class="inv-visual">${itemVisual(it.kind, it.id)}</div>
        <b>${esc(itemName(it.kind, it.id))}</b>
        <span class="inv-float">#${String(it.float).padStart(3, '0')}${shiny ? ' ✦' : ''}</span>
        <span style="color:${col}; font-size:.68rem">${esc((gami.rarity || {})[it.rarity]?.label || it.rarity)}</span>
        <div class="inv-actions">
          ${it.kind !== 'emote' ? `<button class="c-act ${equipped ? 'on' : ''}" data-inv-equip="${it.kind}:${esc(it.id)}">${equipped ? 'Angelegt' : 'Anlegen'}</button>` : ''}
          <button class="c-act ${inShowcase ? 'on' : ''}" data-inv-show="${it.kind}:${esc(it.id)}">Profil</button>
          <button class="c-act" data-inv-sell="${it.kind}:${esc(it.id)}">Verkaufen (${val})</button>
        </div>
      </div>`;
    }).join('')}</div>` : '<div class="status">Noch keine Items. Öffne Kisten!</div>'}`;
  $('#sheet-content').querySelectorAll('[data-inv-equip]').forEach(b => b.onclick = async () => {
    const [kind, id] = b.dataset.invEquip.split(':');
    if (kind === 'paint') {
      const next = gami.activePaint === id ? '' : id;
      await api('/api/paint', { method: 'POST', body: JSON.stringify({ id: next }) }).catch(() => { });
      gami.activePaint = next;
    } else {
      const next = myProfile.activeBadge === id ? '' : id;
      await api('/api/profile', { method: 'POST', body: JSON.stringify({ activeBadge: next }) }).catch(() => { });
      myProfile.activeBadge = next;
    }
    openInventory(); refreshGami();
  });
  $('#sheet-content').querySelectorAll('[data-inv-show]').forEach(b => b.onclick = async () => {
    const key = b.dataset.invShow;
    let sc = gami.showcase || [];
    if (sc.includes(key)) sc = sc.filter(x => x !== key);
    else if (sc.length >= 3) { island('Maximal 3 Items im Profil'); return; }
    else sc = [...sc, key];
    await api('/api/profile', { method: 'POST', body: JSON.stringify({ showcase: sc }) }).catch(() => { });
    gami.showcase = sc;
    openInventory(); refreshGami();
  });
  $('#sheet-content').querySelectorAll('[data-inv-sell]').forEach(b => b.onclick = async () => {
    const [kind, id] = b.dataset.invSell.split(':');
    if (!await askConfirm(`${esc(itemName(kind, id))} wirklich verkaufen?`, { okLabel: 'Verkaufen' })) return;
    try {
      const r = await api('/api/item/sell', { method: 'POST', body: JSON.stringify({ kind, id }) });
      playSfx('coin'); island(`Verkauft für ${r.value} Coins`);
      await refreshGamiSystem(); await refreshGami();
      openInventory();
    } catch (e) { island(e.message); }
  });
  openSheetShell();
}
$('#gm-inv-btn')?.addEventListener('click', () => switchView('inventory', 'enter-drop'));

// ---- Inventar als eigene Seite: Items UND Kisten, filterbar
let invFilter = 'alle';
async function renderInventoryPage() {
  if (!gami) await refreshGamiSystem();
  const host = $('#inv-page');
  if (!gami) { host.innerHTML = '<div class="status">Bitte anmelden.</div>'; return; }
  const items = myItems();
  const showCases = invFilter === 'alle' || invFilter === 'case';
  const list = invFilter === 'alle' ? items : items.filter(it => it.kind === invFilter);
  host.innerHTML = `
    ${showCases && gami.cases.length ? `<h3 class="gm-h" style="margin-top:0">Kisten</h3>
    <div class="gm-cases">${gami.cases.map(c => `
      <button class="gm-case" data-case-open="${esc(c.id)}">
        <img class="px-icon big" src="/gamification/${CASE_IMGS[c.type] || CASE_IMGS.standard}.svg" alt="">
        <span>${esc(c.type)}</span>
      </button>`).join('')}</div>` : ''}
    ${invFilter !== 'case' ? `${showCases && gami.cases.length ? '<h3 class="gm-h">Items</h3>' : ''}
    <div class="inv-grid">${list.map(it => {
      const col = (gami.rarity || {})[it.rarity]?.color || '#888';
      const shiny = isShinyF(it.float);
      const val = ((gami.sellValues || {})[it.rarity] || 20) * (shiny ? 5 : 1);
      const inShowcase = (gami.showcase || []).includes(`${it.kind}:${it.id}`);
      const equipped = (it.kind === 'paint' && gami.activePaint === it.id) || (it.kind === 'badge' && myProfile?.activeBadge === it.id);
      return `
      <div class="inv-item ${shiny ? 'shiny' : ''}" style="--rc:${col}">
        <div class="inv-visual">${itemVisual(it.kind, it.id)}</div>
        <b>${esc(itemName(it.kind, it.id))}</b>
        <span class="inv-float">#${String(it.float).padStart(3, '0')}${shiny ? ' ✦' : ''}</span>
        <span style="color:${col}; font-size:.68rem">${esc((gami.rarity || {})[it.rarity]?.label || it.rarity)}</span>
        <div class="inv-actions">
          ${it.kind !== 'emote' ? `<button class="c-act ${equipped ? 'on' : ''}" data-inv-equip="${it.kind}:${esc(it.id)}">${equipped ? 'Angelegt' : 'Anlegen'}</button>` : ''}
          <button class="c-act ${inShowcase ? 'on' : ''}" data-inv-show="${it.kind}:${esc(it.id)}">Profil</button>
          <button class="c-act" data-inv-sell="${it.kind}:${esc(it.id)}">Verkaufen (${val})</button>
        </div>
      </div>`;
    }).join('') || '<div class="status">Nichts in dieser Kategorie. Öffne Kisten!</div>'}</div>` : ''}`;
  host.querySelectorAll('[data-case-open]').forEach(b => b.onclick = () =>
    openCaseModal(gami.cases.find(c => c.id === b.dataset.caseOpen)));
  // Antippen des Item-Bilds = groß inspecten
  host.querySelectorAll('.inv-item').forEach(el => {
    const vis = el.querySelector('.inv-visual');
    if (!vis) return;
    const sellBtn = el.querySelector('[data-inv-sell]');
    if (!sellBtn) return;
    const [kind, id] = sellBtn.dataset.invSell.split(':');
    vis.style.cursor = 'zoom-in';
    vis.onclick = () => openInspect(kind, id, (gami.floats || {})[`${kind}:${id}`] ?? 0, itemRarity(kind, id));
  });
  host.querySelectorAll('[data-inv-equip]').forEach(b => b.onclick = async () => {
    const [kind, id] = b.dataset.invEquip.split(':');
    if (kind === 'paint') {
      const next = gami.activePaint === id ? '' : id;
      await api('/api/paint', { method: 'POST', body: JSON.stringify({ id: next }) }).catch(() => { });
      gami.activePaint = next;
    } else {
      const next = myProfile.activeBadge === id ? '' : id;
      await api('/api/profile', { method: 'POST', body: JSON.stringify({ activeBadge: next }) }).catch(() => { });
      myProfile.activeBadge = next;
    }
    renderInventoryPage(); refreshGami();
  });
  host.querySelectorAll('[data-inv-show]').forEach(b => b.onclick = async () => {
    const key = b.dataset.invShow;
    let sc = gami.showcase || [];
    if (sc.includes(key)) sc = sc.filter(x => x !== key);
    else if (sc.length >= 3) { island('Maximal 3 Items im Profil'); return; }
    else sc = [...sc, key];
    await api('/api/profile', { method: 'POST', body: JSON.stringify({ showcase: sc }) }).catch(() => { });
    gami.showcase = sc;
    renderInventoryPage(); refreshGami();
  });
  host.querySelectorAll('[data-inv-sell]').forEach(b => b.onclick = async () => {
    const [kind, id] = b.dataset.invSell.split(':');
    if (!await askConfirm(`${esc(itemName(kind, id))} wirklich verkaufen?`, { okLabel: 'Verkaufen' })) return;
    try {
      const r = await api('/api/item/sell', { method: 'POST', body: JSON.stringify({ kind, id }) });
      playSfx('coin'); island(`Verkauft für ${r.value} Coins`);
      await refreshGamiSystem();
      renderInventoryPage(); refreshGami();
    } catch (e) { island(e.message); }
  });
}
document.querySelectorAll('[data-invf]').forEach(b => b.addEventListener('click', () => {
  invFilter = b.dataset.invf;
  document.querySelectorAll('[data-invf]').forEach(x => x.classList.toggle('active', x === b));
  renderInventoryPage();
}));

// ---- Kistenshop als eigene Seite
async function renderShopPage() {
  if (!gami) await refreshGamiSystem();
  $('#shop-coins').textContent = gami?.coins ?? 0;
  $('#shop-page').innerHTML = Object.entries(gami?.shop || {}).map(([type, price]) => `
    <button class="gm-case" data-shop-buy2="${esc(type)}">
      <img class="px-icon big" src="/gamification/${CASE_IMGS[type]}.svg" alt="">
      <span>${esc(type)}</span>
      <span class="shop-price">${price} Coins</span>
    </button>`).join('');
  $('#shop-page').querySelectorAll('[data-shop-buy2]').forEach(b => b.onclick = async () => {
    try {
      const r = await api('/api/shop/buy', { method: 'POST', body: JSON.stringify({ type: b.dataset.shopBuy2 }) });
      playSfx('kaching'); buzz(30);
      island('Kiste gekauft, ab ins Inventar!');
      gami.coins = r.coins; gami.cases = r.cases;
      renderShopPage();
    } catch (e) { island(e.message); }
  });
}

// ---- Rank-Up: Vollbild-Feier
function rankUpFx(rank) {
  const el = document.createElement('div');
  el.className = 'rankup';
  el.innerHTML = `
    <div class="rankup-inner" style="--rc:${rank.color}">
      <img class="px-icon" src="${rankFile(rank)}" alt="">
      <b>RANG-AUFSTIEG!</b>
      <span style="color:${rank.color}">${esc(rank.name)}</span>
    </div>`;
  document.body.appendChild(el);
  playSfx('kaching'); buzz([40, 40, 80]);
  if (!reducedMotion()) {
    for (let i = 0; i < 18; i++) {
      const s = document.createElement('span');
      s.className = 'case-spark';
      s.style.background = rank.color;
      s.style.left = '50%'; s.style.top = '45%';
      s.style.setProperty('--dx', (Math.random() * 300 - 150) + 'px');
      s.style.setProperty('--dy', (Math.random() * -240 - 20) + 'px');
      s.style.animationDelay = (i * 30) + 'ms';
      el.appendChild(s);
    }
  }
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 500); }, 3200);
  el.addEventListener('click', () => el.remove());
}

// Sammlung: alles was es gibt, nach Seltenheit, plus Kisten-Übersicht
async function openCatalogSheet() {
  if (!gami) await refreshGamiSystem();
  state.sheetMode = 'gami-catalog';
  const all = [
    ...(gami?.paintsAll || []).map(x => ({ kind: 'paint', id: x.id, rarity: x.rarity })),
    ...Object.keys(gami?.badgesAll || {}).map(id => ({ kind: 'badge', id, rarity: itemRarity('badge', id) })),
    ...Object.entries(gami?.emotesAll || {}).map(([id, v]) => ({ kind: 'emote', id, rarity: v.rarity })),
  ];
  const owned = new Set(myItems().map(it => `${it.kind}:${it.id}`));
  const order = ['legendary', 'epic', 'rare', 'uncommon', 'common'];
  $('#sheet-content').innerHTML = `
    <div class="sheet-title">Sammlung</div>
    ${order.map(rar => {
      const list = all.filter(x => x.rarity === rar);
      if (!list.length) return '';
      const col = (gami.rarity || {})[rar]?.color || '#888';
      return `<h3 class="gm-h" style="color:${col}">${esc((gami.rarity || {})[rar]?.label || rar)}</h3>
      <div class="inv-grid">${list.map(it => `
        <div class="inv-item ${owned.has(`${it.kind}:${it.id}`) ? '' : 'locked'}" style="--rc:${col}">
          <div class="inv-visual">${itemVisual(it.kind, it.id)}</div>
          <b>${esc(itemName(it.kind, it.id))}</b>
          <span style="font-size:.66rem; opacity:.6">${owned.has(`${it.kind}:${it.id}`) ? 'im Besitz' : 'noch nicht gefunden'}</span>
        </div>`).join('')}</div>`;
    }).join('')}
    <h3 class="gm-h">Die Kisten</h3>
    <div class="gm-cases">${Object.entries(CASE_IMGS).map(([type, img]) => `
      <div class="gm-case" style="cursor:default">
        <img class="px-icon big" src="/gamification/${img}.svg" alt="">
        <span>${esc(type)}</span>
      </div>`).join('')}</div>
    <p class="muted" style="font-size:.78rem">Bessere Kisten heben die Chancen auf seltene Items. Die genauen Prozente stehen beim Öffnen unter „Chancen anzeigen".</p>`;
  openSheetShell();
}

// Kistenshop: Kauf ausschließlich mit erspielten Coins
$('#gm-shop-btn')?.addEventListener('click', () => switchView('shop', 'enter-drop'));

// ---- Kisten-Öffnung: Ergebnis kommt VOR der Animation vom Server, die Walze ist Show
let caseCtx = null;
function openCaseModal(box) {
  if (!box) return;
  caseCtx = { box, phase: 0, result: null, timers: [] };
  $('#case-img').src = `/gamification/${CASE_IMGS[box.type] || CASE_IMGS.standard}.svg`;
  $('#case-img').classList.remove('hidden');
  $('#case-img').classList.add('case-idle');
  $('#case-title').textContent = `${box.type.charAt(0).toUpperCase() + box.type.slice(1)}-Kiste`;
  $('#reel-wrap').classList.add('hidden');
  $('#case-result').classList.add('hidden');
  $('#case-open-btn').classList.remove('hidden');
  $('#case-skip').classList.add('hidden');
  // Droprates offen zeigen, angepasst an die Kistenart
  const w = { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 };
  if (box.type === 'silber') w.common = 30;
  if (box.type === 'gold') { w.common = 10; w.uncommon = 35; }
  if (box.type === 'prisma') { w.common = 0; w.uncommon = 20; w.rare = 45; }
  const tot = Object.values(w).reduce((s, x) => s + x, 0);
  $('#case-odds-panel').innerHTML = Object.entries(w).filter(([, x]) => x > 0).map(([k, x]) =>
    `<div class="odds-row"><span style="color:${(gami?.rarity || {})[k]?.color || '#888'}">${esc((gami?.rarity || {})[k]?.label || k)}</span><b>${(x / tot * 100).toFixed(1)} %</b></div>`).join('');
  $('#case-backdrop').classList.remove('hidden');
}
function caseItemHtml(it) {
  const col = (gami?.rarity || {})[it.rarity]?.color || '#888';
  return `<div class="reel-item" style="--rc:${col}">
    ${it.kind === 'badge'
      ? `<svg class="icon"><use href="#i-${(myProfile?.badgesAll || {})[it.id]?.icon || 'star'}"/></svg>`
      : `<span class="reel-paint" style="background-image:${paintById(it.id)?.css || 'none'}"></span>`}
  </div>`;
}
async function startCaseOpen() {
  const { box } = caseCtx;
  let r;
  try { r = await api('/api/case/open', { method: 'POST', body: JSON.stringify({ id: box.id }) }); }
  catch (e) { island(e.message); return; }
  caseCtx.result = r;
  $('#case-open-btn').classList.add('hidden');
  const col = (gami?.rarity || {})[r.win.rarity]?.color || '#888';
  const label = (gami?.rarity || {})[r.win.rarity]?.label || r.win.rarity;
  const bigReveal = () => {
    caseCtx.timers.forEach(clearTimeout);
    if (caseCtx.revealed) return;
    caseCtx.revealed = true;
    $('#reel-wrap').classList.add('hidden');
    $('#case-img').classList.add('hidden');
    $('#case-skip').classList.add('hidden');
    $('#case-result').classList.remove('hidden');
    const epicPlus = ['epic', 'legendary'].includes(r.win.rarity);
    $('#case-result').innerHTML = `
      <div class="case-win v2 ${r.win.shiny ? 'shiny' : ''} ${epicPlus ? 'epic-glow' : ''}" style="--rc:${col}">
        <div class="case-win-visual">${itemVisual(r.win.kind, r.win.id)}</div>
        <b>${esc(r.win.name)}</b>
        <span class="inv-float">#${String(r.win.float).padStart(3, '0')}${r.win.shiny ? ' ✦ SHINY' : ''}</span>
        <span style="color:${col}; font-weight:800">${esc(label)} · Wert: ${r.win.value} Coins</span>
        ${r.dupe ? '<span class="stars-count">Schon vorhanden: +40 Coins gutgeschrieben</span>' : `
        <div class="form-row" style="justify-content:center; margin-top:10px">
          <button class="btn btn-small" id="cw-keep">Behalten</button>
          <button class="btn btn-small btn-ghost" id="cw-sell">Verkaufen für ${r.win.value} Coins</button>
        </div>`}
      </div>`;
    if (epicPlus && !reducedMotion()) {
      // Partikel-Burst in der Rarity-Farbe, einmalig
      for (let i = 0; i < 14; i++) {
        const s = document.createElement('span');
        s.className = 'case-spark';
        s.style.background = col;
        s.style.setProperty('--dx', (Math.random() * 220 - 110) + 'px');
        s.style.setProperty('--dy', (Math.random() * -180 - 30) + 'px');
        s.style.animationDelay = (i * 25) + 'ms';
        $('#case-result').appendChild(s);
        setTimeout(() => s.remove(), 1400);
      }
    }
    buzz(r.win.shiny ? [30, 40, 60] : 18);
    playSfx(r.dupe ? 'coin' : 'kaching');
    $('#cw-keep')?.addEventListener('click', () => { hideOverlay($('#case-backdrop')); island('Ab ins Inventar!'); });
    // Item groß anschauen (inspecten)
    $('#case-result').querySelector('.case-win-visual')?.addEventListener('click', () =>
      openInspect(r.win.kind, r.win.id, r.win.float, r.win.rarity));
    $('#cw-sell')?.addEventListener('click', async () => {
      try {
        const sold = await api('/api/item/sell', { method: 'POST', body: JSON.stringify({ kind: r.win.kind, id: r.win.id }) });
        playSfx('coin');
        hideOverlay($('#case-backdrop'));
        island(`Verkauft für ${sold.value} Coins`);
        refreshGamiSystem();
      } catch (e) { island(e.message); }
    });
    refreshGamiSystem();
    refreshGami();
  };
  caseCtx.bigReveal = bigReveal;
  if (reducedMotion()) { bigReveal(); return; }
  // Sound startet sofort, die Animation richtet sich nach seiner Länge:
  // Intro (fallen + schütteln + aufplatzen) ~1.8s, dann läuft die CS-Walze,
  // das Einrasten landet kurz vor dem Ende des Sounds.
  const soundDur = sfxDuration('case') || 8;
  const reelMs = Math.max(2600, Math.min(9500, (soundDur - 2.6) * 1000));
  const img = $('#case-img');
  img.classList.remove('case-idle');
  img.classList.add('case-drop');
  $('#case-skip').classList.remove('hidden');
  caseCtx.timers.push(setTimeout(() => {
    img.classList.remove('case-drop');
    img.classList.add('case-shake');
    // Sound startet mit dem Schütteln, so sitzt das Finale auf dem Reveal
    caseCtx.snd = playSfx('case');
    caseCtx.timers.push(setTimeout(() => {
      img.classList.remove('case-shake');
      img.classList.add('case-burst');
      const flash = document.createElement('div');
      flash.className = 'case-flash';
      flash.style.setProperty('--rc', col);
      img.parentElement.insertBefore(flash, img);
      setTimeout(() => flash.remove(), 700);
      // Jetzt die Walze: Gewinn liegt fest auf Index 60, alles andere ist Show
      caseCtx.timers.push(setTimeout(() => {
        img.classList.add('hidden');
        const pool = [
          ...(gami?.paintsAll || []).map(x => ({ kind: 'paint', id: x.id, rarity: x.rarity })),
          ...Object.entries(gami?.badgesAll || myProfile?.badgesAll || {}).map(([k, v]) => ({ kind: 'badge', id: k, rarity: v.rar === 'häufig' ? 'common' : v.rar === 'selten' ? 'rare' : 'epic' })),
          ...Object.entries(gami?.emotesAll || {}).map(([k, v]) => ({ kind: 'emote', id: k, rarity: v.rarity })),
        ];
        const items = Array.from({ length: 64 }, (_, i) => i === 60 ? { kind: r.win.kind, id: r.win.id, rarity: r.win.rarity } : pool[Math.floor(Math.random() * pool.length)]);
        $('#reel').innerHTML = items.map(it => {
          const c2 = (gami?.rarity || {})[it.rarity]?.color || '#888';
          return `<div class="reel-item" style="--rc:${c2}">${itemVisual(it.kind, it.id)}</div>`;
        }).join('');
        $('#reel-wrap').classList.remove('hidden');
        const ITEM_W = 74;
        const wrapW = $('#reel-wrap').clientWidth;
        const jitter = (Math.random() * 0.76 - 0.38) * ITEM_W;
        const target = 60 * ITEM_W + ITEM_W / 2 - wrapW / 2 + jitter;
        const reel = $('#reel');
        reel.style.willChange = 'transform';
        reel.style.transition = 'none';
        reel.style.transform = 'translate3d(0,0,0)';
        requestAnimationFrame(() => requestAnimationFrame(() => {
          reel.style.transition = `transform ${reelMs}ms cubic-bezier(0.08, 0.82, 0.12, 1)`;
          reel.style.transform = `translate3d(${-target}px,0,0)`;
        }));
        caseCtx.timers.push(setTimeout(() => {
          reel.style.willChange = '';
          reel.children[60]?.classList.add('reel-win');
          caseCtx.timers.push(setTimeout(bigReveal, 620));
        }, reelMs + 120));
      }, 480));
    }, 700));
  }, 650));
}
async function startCaseOpenLegacy() {
  const r = caseCtx.result;
  const reveal = () => {
    caseCtx.timers.forEach(clearTimeout);
    $('#reel-wrap').classList.add('hidden');
    $('#case-skip').classList.add('hidden');
    const col = (gami?.rarity || {})[r.win.rarity]?.color || '#888';
    const label = (gami?.rarity || {})[r.win.rarity]?.label || r.win.rarity;
    $('#case-result').classList.remove('hidden');
    $('#case-result').innerHTML = `
      <div class="case-win" style="--rc:${col}">
        ${r.win.kind === 'badge'
        ? `<svg class="icon" style="width:44px;height:44px"><use href="#i-${(myProfile?.badgesAll || {})[r.win.id]?.icon || 'star'}"/></svg>`
        : `<span class="reel-paint big" style="background-image:${paintById(r.win.id)?.css || 'none'}"></span>`}
        <b>${esc(r.win.name)}</b>
        <span style="color:${col}">${esc(label)}${r.dupe ? ' · schon vorhanden, +40 Coins' : ''}</span>
      </div>`;
    buzz(18);
    playSfx('kaching');
    refreshGamiSystem();
    refreshGami();
  };
  if (reducedMotion()) { $('#case-img').classList.add('hidden'); reveal(); return; }
  // Phase 1: Antizipation
  $('#case-img').classList.remove('case-idle');
  $('#case-img').classList.add('case-pop');
  caseCtx.timers.push(setTimeout(() => {
    $('#case-img').classList.add('hidden');
    // Phase 2: Walze, Gewinn liegt fest auf Index 60
    const pool = [
      ...(gami?.paintsAll || []).map(x => ({ kind: 'paint', id: x.id, rarity: x.rarity })),
      ...Object.entries(myProfile?.badgesAll || {}).map(([k, v]) => ({ kind: 'badge', id: k, rarity: v.rar === 'häufig' ? 'common' : v.rar === 'selten' ? 'rare' : 'epic' })),
    ];
    const items = Array.from({ length: 64 }, (_, i) => i === 60 ? { ...r.win } : pool[Math.floor(Math.random() * pool.length)]);
    $('#reel').innerHTML = items.map(caseItemHtml).join('');
    $('#reel-wrap').classList.remove('hidden');
    $('#case-skip').classList.remove('hidden');
    const ITEM_W = 74;
    const wrapW = $('#reel-wrap').clientWidth;
    const jitter = (Math.random() * 0.76 - 0.38) * ITEM_W;
    const target = 60 * ITEM_W + ITEM_W / 2 - wrapW / 2 + jitter;
    const reel = $('#reel');
    reel.style.willChange = 'transform';
    reel.style.transition = 'none';
    reel.style.transform = 'translate3d(0,0,0)';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      reel.style.transition = 'transform 4200ms cubic-bezier(0.08, 0.82, 0.12, 1)';
      reel.style.transform = `translate3d(${-target}px,0,0)`;
    }));
    // Phase 3+4: Einrasten und Reveal
    caseCtx.timers.push(setTimeout(() => {
      reel.style.willChange = '';
      const winEl = reel.children[60];
      winEl?.classList.add('reel-win');
      caseCtx.timers.push(setTimeout(reveal, 560));
    }, 4300));
  }, 340));
}
$('#case-open-btn').addEventListener('click', startCaseOpen);
$('#case-skip').addEventListener('click', () => {
  caseCtx?.snd?.stop();
  if (caseCtx?.bigReveal) caseCtx.bigReveal();
});
// Überspringen springt direkt zum Ergebnis
function startCaseOpenReveal() {
  const r = caseCtx.result;
  if (!r) return;
  $('#reel-wrap').classList.add('hidden');
  $('#case-skip').classList.add('hidden');
  const col = (gami?.rarity || {})[r.win.rarity]?.color || '#888';
  const label = (gami?.rarity || {})[r.win.rarity]?.label || r.win.rarity;
  $('#case-result').classList.remove('hidden');
  $('#case-result').innerHTML = `
    <div class="case-win" style="--rc:${col}">
      <b>${esc(r.win.name)}</b>
      <span style="color:${col}">${esc(label)}${r.dupe ? ' · schon vorhanden, +40 Coins' : ''}</span>
    </div>`;
  refreshGamiSystem();
  refreshGami();
}
$('#case-close').addEventListener('click', () => {
  caseCtx?.timers.forEach(clearTimeout);
  caseCtx?.snd?.stop();
  hideOverlay($('#case-backdrop'));
});
$('#case-odds').addEventListener('click', () => $('#case-odds-panel').classList.toggle('hidden'));
// Lieblings-Kategorien: Auswahl-Chips wie bei den Gutscheinen + eigenes Feld
const FAV_OPTIONS = {
  discounter: { label: 'Lieblings-Discounter', opts: ['Lidl', 'Aldi', 'Netto', 'Penny', 'Norma'] },
  supermarkt: { label: 'Lieblings-Supermarkt', opts: ['REWE', 'EDEKA', 'Kaufland', 'Globus', 'tegut'] },
  essen: { label: 'Lieblingsessen', opts: ['Pizza', 'Döner', 'Burger', 'Sushi', 'Pasta'] },
  onlineshop: { label: 'Lieblings-Onlineshop', opts: ['Amazon', 'Zalando', 'Otto', 'eBay', 'Temu'] },
  mode: { label: 'Lieblings-Modemarke', opts: ['Nike', 'Adidas', 'H&M', 'Zara', 'Shein'] },
};
const favPick = {};
function renderFavPickers() {
  const host = $('#fav-pickers');
  if (!host) return;
  const favs = myProfile?.favs || {};
  host.innerHTML = Object.entries(FAV_OPTIONS).map(([key, def]) => {
    const cur = favPick[key] ?? favs[key] ?? '';
    favPick[key] = cur;
    const isCustom = cur && !def.opts.includes(cur);
    // Marken-Logos in den Auswahl-Chips, wo wir sie kennen
    const optChip = o => BRAND_DOMAINS[o.toLowerCase()]
      ? `<button type="button" class="chip fav-opt ${cur === o ? 'active' : ''}" data-favopt="${esc(o)}">${brandChipHtml(o)} ${esc(o)}</button>`
      : `<button type="button" class="chip ${cur === o ? 'active' : ''}" data-favopt="${esc(o)}">${esc(o)}</button>`;
    return `
    <label class="f-label">${def.label}</label>
    <div class="fav-row" data-favkey="${key}">
      ${def.opts.map(optChip).join('')}
      <button type="button" class="chip ${isCustom ? 'active' : ''}" data-favopt="__custom">Eigenes</button>
      <input class="input fav-custom ${isCustom ? '' : 'hidden'}" maxlength="30" placeholder="eigene Antwort" value="${esc(isCustom ? cur : '')}">
    </div>`;
  }).join('');
  host.querySelectorAll('.fav-row').forEach(row => {
    const key = row.dataset.favkey;
    row.querySelectorAll('[data-favopt]').forEach(b => b.addEventListener('click', () => {
      const inp = row.querySelector('.fav-custom');
      const wasActive = b.classList.contains('active');
      row.querySelectorAll('[data-favopt]').forEach(x => x.classList.remove('active'));
      if (b.dataset.favopt === '__custom') {
        favPick[key] = inp.value.trim();
        b.classList.add('active');
        inp.classList.remove('hidden'); inp.focus();
      } else {
        favPick[key] = wasActive ? '' : b.dataset.favopt;
        if (!wasActive) b.classList.add('active');
        inp.classList.add('hidden'); inp.value = '';
      }
    }));
    row.querySelector('.fav-custom').addEventListener('input', e => { favPick[key] = e.target.value.trim(); });
  });
}

// @Handle ändern (einmal pro Monat, Server zieht überall mit um)
$('#g-handle-save').addEventListener('click', async () => {
  const neu = $('#g-handle').value.trim();
  if (!neu) return;
  if (!await askConfirm(`Deinen Namen zu @${esc(neu)} ändern? Das geht dann erst in 30 Tagen wieder.`, { okLabel: 'Ja, ändern' })) return;
  try {
    const r = await api('/api/handle', { method: 'POST', body: JSON.stringify({ name: neu }) });
    state.userName = r.user;
    localStorage.setItem('ra.user', r.user);
    $('#g-handle').value = '';
    island(`Du heißt jetzt @${r.user}`);
    refreshProfileTab();
  } catch (e) { island(e.message); }
});

// Overlays raus aus den Views auf Body-Ebene, sonst versteckt .view.hidden sie mit
// (Kisten-Popup erschien z. B. erst nach dem Zurückgehen ins Profil)
document.body.appendChild($('#case-backdrop'));
document.body.appendChild($('#user-pop-backdrop'));

// "Profil bearbeiten": eigene Seite, nach dem Speichern geht es automatisch zurück
$('#editprofile-host').appendChild($('#bio-card'));
$('#bio-card').classList.remove('hidden', 'modal-left');
$('#btn-edit-profile').addEventListener('click', () => switchView('editprofile', 'enter-drop'));

$('#g-bio-save').addEventListener('click', async () => {
  const m = $('#g-bio-msg');
  try {
    const r = await api('/api/profile', {
      method: 'POST',
      body: JSON.stringify({
        bio: $('#g-bio').value, publicProfile: $('#g-public').checked,
        favs: { ...favPick },
      }),
    });
    $('#g-bio').value = r.bio; // Server-Fassung (ggf. zensiert) zurückspiegeln
    island('Profil gespeichert');
    refreshGami();
    switchView('profile', 'enter-drop'); // direkt zurück
  } catch (e) { m.className = 'form-msg error'; m.textContent = e.message; }
});

// Profilbild: quadratisch auf 96px verkleinert, als kleines JPEG gespeichert
$('#g-avatar').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const url = await new Promise((res, rej) => {
      const rd = new FileReader();
      rd.onload = () => res(rd.result); rd.onerror = rej; rd.readAsDataURL(f);
    });
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.createElement('canvas');
    c.width = c.height = 96;
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, 96, 96);
    const avatar = c.toDataURL('image/jpeg', 0.82);
    await api('/api/profile', { method: 'POST', body: JSON.stringify({ avatar }) });
    island('Profilbild gespeichert');
    refreshGami();
    refreshProfileTab();
  } catch { island('Bild konnte nicht verarbeitet werden'); }
});
$('#g-avatar-del').addEventListener('click', async () => {
  await api('/api/profile', { method: 'POST', body: JSON.stringify({ avatar: '' }) }).catch(() => { });
  refreshGami();
  refreshProfileTab();
});

// Oben rechts: Gäste landen direkt beim Anmelden, Angemeldete bekommen ein Menü
$('#btn-profile-top').addEventListener('click', () => {
  if (!state.token) { if (state.activeView !== 'profile') switchView('profile'); return; }
  toggleTopMenu();
});

// Menü-Backdrop blendet weich ein und aus (Blur + Abdunklung über Klasse)
function hideTopBackdrop() {
  const bd = $('#top-menu-backdrop');
  bd.classList.remove('show');
  setTimeout(() => bd.classList.add('hidden'), 380);
}
function toggleTopMenu() {
  const menu = $('#top-menu');
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); hideTopBackdrop(); return; }
  const bd = $('#top-menu-backdrop');
  bd.classList.remove('hidden');
  requestAnimationFrame(() => bd.classList.add('show'));
  const reqs = myProfile?.friendRequests || [];
  const rank = rankFor(renderWallet.lastTotal || 0);
  menu.innerHTML = `
    <div class="tm-head">
      ${myProfile?.avatar ? `<img class="avatar-big" src="${myProfile.avatar}" alt="">`
        : `<span class="avatar-big" style="background:${chatColor(state.userName || '?')}">${esc((state.userName || '?')[0].toUpperCase())}</span>`}
      <div style="flex:1">
        <div class="tm-name">${esc(state.userName)} ${state.role === 'admin' ? icon('crown', 'icon icon-sm role-admin') : ''}</div>
        <div class="tm-sub">
          ${gami?.rank ? `<img class="px-icon" src="${rankFile(gami.rank)}" alt="" style="vertical-align:-4px"> ${esc(gami.rank.name)}` : esc(rank.name)}
          · <svg class="icon icon-sm" style="vertical-align:-3px"><use href="#i-coin"/></svg> ${gami?.coins ?? myProfile?.coins ?? 0}
        </div>
      </div>
      <svg class="icon icon-sm" style="opacity:.5"><use href="#i-chevron"/></svg>
    </div>
    ${reqs.length ? `<div class="tm-section">Freundschaftsanfragen</div>
    ${reqs.map(u => `<div class="tm-req">
      <span class="avatar-mini" style="background:${chatColor(u)}">${esc(u[0].toUpperCase())}</span>
      <span style="flex:1; font-weight:700">${esc(u)}</span>
      <button class="btn btn-small" data-freq-ok="${esc(u)}">Annehmen</button>
      <button class="btn btn-small btn-ghost" data-freq-no="${esc(u)}">Ablehnen</button>
    </div>`).join('')}` : ''}
    <div class="tm-section">Freunde</div>
    <div id="tm-friends"><div class="tm-sub" style="padding:4px 0">Lade …</div></div>
    <button class="tm-item" id="tm-all-friends">${icon('user', 'icon icon-sm')} Alle Freunde</button>
    <button class="tm-item" id="tm-inv">${icon('gift', 'icon icon-sm')} Inventar</button>
    <button class="tm-item" id="tm-shop">${icon('banknote', 'icon icon-sm')} Kistenshop</button>
    <button class="tm-item" id="tm-catalog">${icon('list', 'icon icon-sm')} Sammlung</button>
    <button class="tm-item" id="tm-quests">${icon('trophy', 'icon icon-sm')} Quests ${(gami?.claimable || []).length ? `<span class="dm-unread-pill">${gami.claimable.length}</span>` : ''}</button>
    <button class="tm-item" id="tm-favs">${icon('star', 'icon icon-sm')} Favoriten</button>
    <button class="tm-item" id="tm-settings">${icon('sliders', 'icon icon-sm')} Einstellungen</button>`;
  menu.classList.remove('hidden');
  const done = () => { menu.classList.add('hidden'); hideTopBackdrop(); };
  // Der Profil-Banner selbst führt zum Profil
  menu.querySelector('.tm-head').style.cursor = 'pointer';
  menu.querySelector('.tm-head').onclick = () => { done(); switchView('profile'); };
  $('#tm-inv').onclick = () => { done(); switchView('inventory', 'enter-drop'); };
  $('#tm-shop').onclick = () => { done(); switchView('shop', 'enter-drop'); };
  $('#tm-catalog').onclick = () => { done(); openCatalogSheet(); };
  $('#tm-quests').onclick = () => {
    done(); switchView('profile');
    setTimeout(() => {
      const f = $('#quests-fold');
      f.open = true;
      f.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 400);
  };
  $('#tm-favs').onclick = () => {
    done();
    state.activeChip = 'saved';
    renderChipbar(); renderFeed(true);
    if (state.activeView !== 'feed') switchView('feed');
  };
  $('#tm-settings').onclick = () => { done(); switchView('settings', 'enter-drop'); };
  $('#tm-all-friends').onclick = () => { done(); switchView('friends', 'enter-drop'); };
  // Die letzten 3 Freunde (nach letzter Interaktion), mit Profilbild
  api('/api/dm/list').then(r => {
    const rows = [
      ...r.list.map(l => ({ name: l.partner, avatar: l.avatar, ts: l.lastTs })),
      ...(r.friends || []).map(f => ({ name: f.name, avatar: f.avatar, ts: 0 })),
    ].filter(x => (myProfile?.friends || []).includes(x.name)).slice(0, 3);
    $('#tm-friends').innerHTML = rows.length ? rows.map(f => `
      <div class="tm-req">
        <span class="tm-friend-open" data-tm-user="${esc(f.name)}" style="display:flex; align-items:center; gap:8px; flex:1; cursor:pointer">
          ${f.avatar ? `<img class="avatar-mini avatar-img" src="${f.avatar}" alt="">`
        : `<span class="avatar-mini" style="background:${chatColor(f.name)}">${esc(f.name[0].toUpperCase())}</span>`}
          <span style="font-weight:700">@${esc(f.name)}</span>
        </span>
        <button class="btn btn-small btn-ghost" data-tm-whisper="${esc(f.name)}">Schreiben</button>
      </div>`).join('')
      : '<div class="tm-sub" style="padding:4px 0">Noch keine Freunde.</div>';
    menu.querySelectorAll('[data-tm-user]').forEach(b => b.onclick = () => { done(); openUserPop(b.dataset.tmUser); });
    menu.querySelectorAll('[data-tm-whisper]').forEach(b => b.onclick = () => {
      done();
      if (state.activeView !== 'chat') switchView('chat');
      setChatMode('dm', b.dataset.tmWhisper);
    });
  }).catch(() => { $('#tm-friends').innerHTML = ''; });
  menu.querySelectorAll('[data-freq-ok]').forEach(b => b.onclick = async () => {
    const r = await api('/api/friend', { method: 'POST', body: JSON.stringify({ user: b.dataset.freqOk, action: 'accept' }) }).catch(e => { island(e.message); });
    if (r && myProfile) { myProfile.friends = r.friends; myProfile.friendRequests = r.friendRequests; }
    island('Ihr seid jetzt Freunde!');
    done(); updateReqDot();
  });
  menu.querySelectorAll('[data-freq-no]').forEach(b => b.onclick = async () => {
    const r = await api('/api/friend', { method: 'POST', body: JSON.stringify({ user: b.dataset.freqNo, action: 'decline' }) }).catch(() => { });
    if (r && myProfile) myProfile.friendRequests = r.friendRequests;
    done(); updateReqDot();
  });
}
// Roter Punkt am Avatar, wenn Anfragen warten
function updateReqDot() {
  $('#btn-profile-top').classList.toggle('has-dot', !!(myProfile?.friendRequests || []).length);
}
document.addEventListener('click', e => {
  const menu = $('#top-menu');
  if (!menu.classList.contains('hidden') && !e.target.closest('#top-menu') && !e.target.closest('#btn-profile-top')) {
    menu.classList.add('hidden');
    hideTopBackdrop();
  }
});

// ---- Benachrichtigungen: Achievements unten rechts, Nachrichten-Banner oben

// Quest-/Achievement-Toast wie in Games: dezent unten rechts überm Menü
function achvToast(title, sub) {
  const el = document.createElement('div');
  el.className = 'achv';
  el.innerHTML = `${icon('trophy', 'icon icon-sm')}<span><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>`;
  $('#achv-stack').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 5200);
}

// Banner über dem Header: antippen springt zur Nachricht
let bannerTimer = null;
function showNoteBanner(text, onTap) {
  const b = $('#note-banner');
  b.innerHTML = `${icon('message', 'icon icon-sm')} <span>${text}</span>`;
  b.classList.remove('hidden');
  requestAnimationFrame(() => b.classList.add('show'));
  b.onclick = () => { hideBanner(); onTap?.(); };
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(hideBanner, 6500);
  function hideBanner() {
    b.classList.remove('show');
    setTimeout(() => b.classList.add('hidden'), 350);
  }
}

// ---- Freundschaftsanfragen live: Popup schiebt sich von unten hoch
let knownReqs = null;
function showReqToast(user) {
  const t = $('#req-toast');
  t.innerHTML = `
    <span class="avatar-mini" style="background:${chatColor(user)}">${esc(user[0].toUpperCase())}</span>
    <span style="flex:1"><b>@${esc(user)}</b> möchte dein Freund sein</span>
    <button class="btn btn-small" id="rt-ok">Annehmen</button>
    <button class="btn btn-small btn-ghost" id="rt-no">Ablehnen</button>`;
  t.classList.remove('hidden');
  t.classList.add('show');
  const hide = () => { t.classList.remove('show'); setTimeout(() => t.classList.add('hidden'), 350); };
  $('#rt-ok').onclick = async () => {
    const r = await api('/api/friend', { method: 'POST', body: JSON.stringify({ user, action: 'accept' }) }).catch(() => null);
    if (r && myProfile) { myProfile.friends = r.friends; myProfile.friendRequests = r.friendRequests; }
    island('Ihr seid jetzt Freunde!'); playSfx('kaching');
    hide(); updateReqDot();
  };
  $('#rt-no').onclick = async () => {
    const r = await api('/api/friend', { method: 'POST', body: JSON.stringify({ user, action: 'decline' }) }).catch(() => null);
    if (r && myProfile) myProfile.friendRequests = r.friendRequests;
    hide(); updateReqDot();
  };
  setTimeout(hide, 12000);
}
async function checkFriendReqs() {
  if (!state.token) return;
  try {
    const p = await api('/api/profile');
    const reqs = p.friendRequests || [];
    if (knownReqs !== null) {
      const fresh = reqs.filter(u => !knownReqs.includes(u));
      if (fresh.length) { buzz(25); showReqToast(fresh[0]); }
    }
    knownReqs = reqs;
    if (myProfile) { myProfile.friendRequests = reqs; myProfile.friends = p.friends || myProfile.friends; }
    updateReqDot();
  } catch { }
}
setInterval(checkFriendReqs, 20000);

// Cloudflare Turnstile: etabliertes Captcha für Login und Registrierung
const tsWidgets = { login: null, reg: null };
let tsSitekey = null;
const tsTries = { login: 0, reg: 0 };
function renderTurnstile(which) {
  const el = $('#ts-' + which);
  if (!el) return;
  // Erst rendern, wenn Sitekey UND Cloudflare-Script da sind, sonst kurz warten
  if (!tsSitekey || !window.turnstile) {
    if (++tsTries[which] > 40) {
      el.innerHTML = '<span class="form-msg error">Captcha-Widget lädt nicht (Netzwerk/Werbeblocker?), ohne Bestätigung ist keine Anmeldung möglich.</span>';
      return;
    }
    setTimeout(() => renderTurnstile(which), 500);
    return;
  }
  tsTries[which] = 0;
  if (tsWidgets[which] !== null) { try { turnstile.reset(tsWidgets[which]); } catch { } return; }
  tsWidgets[which] = turnstile.render(el, {
    sitekey: tsSitekey,
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
    language: 'de',
  });
}
async function initTurnstile() {
  try {
    const r = await api('/api/turnstile');
    tsSitekey = r.sitekey;
    // Kein Render hier: Turnstile in unsichtbaren Containern bleibt leer.
    // Gerendert wird beim Öffnen der Profil-Seite bzw. des Register-Popups.
  } catch { /* offline */ }
}
function tsToken(which) {
  try { return turnstile.getResponse(tsWidgets[which]); } catch { return ''; }
}

// Kleiner Bestätigungs-Dialog (Ja/Abbrechen) bzw. Hinweis-Popup (nur OK)
function askConfirm(text, { okLabel = 'Ja, löschen', alertOnly = false } = {}) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'overlay';
    wrap.innerHTML = `<div class="modal modal-left">
      <p style="font-size:.94rem; line-height:1.5">${text}</p>
      <div class="form-row" style="margin-top:14px; justify-content:flex-end">
        ${alertOnly ? '' : '<button class="btn btn-small btn-ghost" data-c="0">Abbrechen</button>'}
        <button class="btn btn-small" data-c="1">${alertOnly ? 'Okay' : okLabel}</button>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', e => {
      const b = e.target.closest('[data-c]');
      if (!b && e.target !== wrap) return;
      wrap.classList.add('closing');
      setTimeout(() => wrap.remove(), 280);
      resolve(b ? b.dataset.c === '1' : false);
    });
  });
}

// Overlays weich schließen (statt hart zu verschwinden)
function hideOverlay(el) {
  if (!el || el.classList.contains('hidden')) return;
  el.classList.add('closing');
  setTimeout(() => { el.classList.add('hidden'); el.classList.remove('closing'); }, 280);
}

// Button zeigt beim Warten den pulsierenden kumulio-Punkt
function setBtnLoading(btn, on) {
  if (!btn) return;
  btn.disabled = on; // hart sperren: kein Doppelklick, solange gearbeitet wird
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.style.minWidth = btn.offsetWidth + 'px'; // Breite halten, nichts verrutscht
    btn.classList.add('btn-loading');
    const still = window.KBrand?.prefersReducedMotion?.();
    btn.innerHTML = `<span class="btn-dot${still ? '' : ' k-pulse'}"></span>`;
  } else {
    btn.classList.remove('btn-loading');
    btn.textContent = btn.dataset.label || btn.textContent;
    btn.style.minWidth = '';
  }
}

function authOk(r, { welcome = false } = {}) {
  state.token = r.token;
  state.userName = r.user;
  localStorage.setItem('ra.token', r.token);
  localStorage.setItem('ra.user', r.user);
  refreshProfileTab();
  pullWallet(); // Wallet vom Konto holen (Gerätewechsel/Neuinstallation)
  connectStream(); // Echtzeit-Stream mit dem frischen Token neu verbinden
  api('/api/me').then(x => { state.role = x.role || ''; refreshAdminUi(); }).catch(() => { });
  if (welcome) {
    // Willkommens-Moment: der Punkt quittiert das neue Konto
    $('#welcome-title').textContent = `Willkommen, ${r.user}!`;
    $('#welcome-mark').innerHTML = window.KBrand ? window.KBrand.successMarkHTML() : '';
    $('#welcome').classList.remove('hidden');
    window.KBrand?.playSuccess($('#welcome'));
    setTimeout(() => hideOverlay($('#welcome')),
      window.KBrand?.prefersReducedMotion?.() ? 1400 : 2200);
  } else {
    showToast({ title: `Willkommen zurück, ${r.user}!`, success: true }, 3000);
  }
}

$('#btn-login').addEventListener('click', async () => {
  const msg = $('#auth-msg');
  msg.className = 'form-msg'; msg.textContent = '';
  setBtnLoading($('#btn-login'), true);
  try {
    const r = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        user: $('#auth-user').value, pass: $('#auth-pass').value,
        turnstileToken: tsToken('login'),
      }),
    });
    $('#auth-pass').value = '';
    authOk(r);
  } catch (e) {
    msg.className = 'form-msg error'; msg.textContent = e.message;
    renderTurnstile('login');
  } finally {
    setBtnLoading($('#btn-login'), false);
  }
});

// Registrieren: eigenes Popup mit E-Mail-Pflicht + Captcha
$('#btn-register-open').addEventListener('click', () => {
  $('#reg-msg').textContent = '';
  $('#register-backdrop').classList.remove('hidden');
  renderTurnstile('reg');
});
$('#btn-register-close').addEventListener('click', () => hideOverlay($('#register-backdrop')));

$('#btn-register').addEventListener('click', async () => {
  const msg = $('#reg-msg');
  msg.className = 'form-msg'; msg.textContent = '';
  setBtnLoading($('#btn-register'), true);
  try {
    const r = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        user: $('#reg-user').value, email: $('#reg-email').value, pass: $('#reg-pass').value,
        newsletter: $('#reg-news').checked,
        turnstileToken: tsToken('reg'),
      }),
    });
    hideOverlay($('#register-backdrop'));
    $('#reg-pass').value = '';
    authOk(r, { welcome: true });
    if (state.activeView !== 'profile') switchView('profile');
  } catch (e) {
    msg.className = 'form-msg error'; msg.textContent = e.message;
    renderTurnstile('reg');
  } finally {
    setBtnLoading($('#btn-register'), false);
  }
});
$('#btn-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
  state.token = '';
  localStorage.removeItem('ra.token');
  refreshProfileTab();
  island('Abgemeldet');
});

// Dark Mode als On/Off-Schalter in den Einstellungen
const swTheme = $('#sw-theme');
if (swTheme) {
  swTheme.checked = document.documentElement.dataset.theme === 'dark';
  swTheme.addEventListener('change', () => applyTheme(swTheme.checked ? 'dark' : 'light', true));
}
// Mitteilungs-Schalter: Banner/Sounds pro Kategorie an- und abschaltbar
[['msgs', '#sw-n-msgs'], ['mention', '#sw-n-mention'], ['reminder', '#sw-n-reminder']].forEach(([key, sel]) => {
  const el = $(sel);
  if (!el) return;
  el.checked = state.notif[key] !== false;
  el.addEventListener('change', () => { state.notif[key] = el.checked; save('notif', state.notif); });
});

// ---------------- Fullscreen-Onboarding beim ersten Start ----------------
// Splash und Tutorial sind ein Fluss: Logo animiert, rutscht nach oben,
// dann wird der Nutzer Schritt für Schritt begrüßt und zum Konto geführt.

// Jeder Step zeigt die Möglichkeit als kleines Stück echter UI (visual)
const OB_STEPS = [
  { title: 'Schön, dass du da bist.', text: 'kumulio ist deine kuratierte Spar-App: handverlesene Angebote, deine Gutschein-Wallet und alle Coupons an einem Ort, ohne Deal-Spam.', cta: 'Los geht’s' },
  {
    title: 'Sparen & Verdienen', text: 'Oben wechselst du zwischen Sparen, Verdienen und Neukunden-Aktionen, sauber getrennt, damit du sofort findest, was du suchst.', cta: 'Weiter',
    visual: () => `
      <span class="chip active">${icon('gift')} Sparen</span>
      <span class="chip">${icon('banknote')} Verdienen</span>
      <span class="chip">${icon('sparkle')} Neukunden</span>`,
  },
  {
    title: 'Deine Wallet', text: 'Gutschein fotografieren, Felder füllen sich automatisch. Restguthaben abbuchen, PIN und Barcode griffbereit, und Sparkarten wie Payback immer dabei.', cta: 'Weiter',
    visual: () => `
      <div class="wallet-card ob-mini" style="--bc:${brandColor('rewe')}">
        <div class="wallet-card-head">
          <span class="brand-chip" style="--bc:rgba(255,255,255,.22)">RE</span>
          <span class="wallet-card-name">REWE</span>
          <span class="wallet-card-balance">25,00 €</span>
        </div>
        <div class="wallet-card-sub"><span>GUTSCHEIN-123</span><span class="pill">PIN</span><span class="pill">QR</span></div>
      </div>`,
  },
  {
    title: 'Coupons & Merken', text: 'Der Coupons-Tab bündelt Rossmann, Lidl Plus, McDonald’s & Co. Mit dem Stern merkst du dir Angebote, auf Wunsch mit Erinnerung, bevor sie ablaufen.', cta: 'Weiter',
    visual: () => ['Rossmann', 'Lidl', 'McDonalds', 'Payback'].map(b =>
      `<span class="brand-chip" style="--bc:${brandColor(b)}">${esc(brandInitials(b))}</span>`).join('')
      + `<span class="ob-star">${icon('star')}</span>`,
  },
  {
    title: 'Bleib verbunden.', text: 'Mit deinem Profil sicherst du Wallet und Bewertungen. Den Newsletter kannst du optional dazunehmen, damit du keinen Top-Deal verpasst.', cta: 'Konto erstellen', final: true,
    visual: () => `
      <span class="avatar-mini" style="width:34px;height:34px;font-size:1rem">du</span>
      <span class="pill pill-accent">${icon('bell', 'icon icon-sm')} Newsletter optional</span>`,
  },
];
let obStep = 0;

// Läuft die App schon als Home-Bildschirm-App? Sonst zeigen wir die Anleitung.
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const uaIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const uaAndroid = /android/i.test(navigator.userAgent);
if (!isStandalone && (uaIOS || uaAndroid)) {
  OB_STEPS.splice(OB_STEPS.length - 1, 0, {
    title: 'Mach kumulio zur App',
    text: uaIOS
      ? 'Füg kumulio zum Home-Bildschirm hinzu, dann läuft alles im Vollbild und der Preisfehler-Alarm funktioniert.'
      : 'Installier kumulio über das Browser-Menü, dann läuft alles im Vollbild wie eine echte App.',
    cta: 'Weiter',
    visual: () => uaIOS ? `
      <div class="ob-install">
        <div class="ob-install-step"><b>1</b> Unten das ${icon('share', 'icon icon-sm')} Teilen-Symbol antippen</div>
        <div class="ob-install-step"><b>2</b> "Zum Home-Bildschirm" wählen</div>
        <div class="ob-install-step"><b>3</b> Oben rechts auf "Hinzufügen"</div>
      </div>` : `
      <div class="ob-install">
        <div class="ob-install-step"><b>1</b> Oben rechts das Menü (⋮) öffnen</div>
        <div class="ob-install-step"><b>2</b> "App installieren" antippen</div>
        <div class="ob-install-step"><b>3</b> Bestätigen, fertig</div>
      </div>`,
  });
}

function renderObStep() {
  const s = OB_STEPS[obStep];
  const stepEl = $('#ob-step');
  stepEl.innerHTML = `
    <div class="ob-step">
      ${s.visual ? `<div class="ob-visual">${s.visual()}</div>` : ''}
      <h2>${esc(s.title)}</h2>
      <p>${esc(s.text)}</p>
    </div>`;
  $('#ob-dots').innerHTML = OB_STEPS.map((_, i) => `<i class="${i === obStep ? 'on' : ''}"></i>`).join('');
  const next = $('#ob-next');
  next.textContent = s.cta;
  // Animationen neu anstoßen (Step-by-Step-Gefühl)
  next.style.animation = 'none';
  requestAnimationFrame(() => { next.style.animation = ''; });
  $('#ob-extra').innerHTML = s.final ? `
    <button class="ob-alt" id="ob-login">Schon angemeldet? Hier einloggen</button>
    <button class="ob-alt" id="ob-continue">Ohne Konto fortfahren</button>
    <p class="legal-line">Mit dem Konto akzeptierst du die
      <a href="/agb.html" target="_blank" rel="noopener">AGB</a> und die
      <a href="/datenschutz.html" target="_blank" rel="noopener">Datenschutzerklärung</a>.</p>` : '';
  $('#ob-continue')?.addEventListener('click', () => finishOnboarding(false));
  $('#ob-login')?.addEventListener('click', () => { finishOnboarding(false); switchView('profile'); });
  $('#ob-skip').classList.toggle('hidden', !!s.final);
}

function finishOnboarding(openRegister) {
  localStorage.setItem('ra.tutorialDone', '1');
  $('#onboard').classList.add('done');
  setTimeout(() => $('#onboard').classList.add('hidden'), 520);
  if (openRegister && !state.token) $('#btn-register-open').click();
}

function maybeShowOnboarding() {
  if (localStorage.getItem('ra.tutorialDone')) return;
  // Der Session-Splash entfällt, das Onboarding trägt den Markenmoment (kumulio-Punkt fällt)
  obStep = 0;
  $('#onboard').classList.remove('hidden');
  // Logo-Animation ausspielen, dann nach oben rutschen und begrüßen
  setTimeout(() => {
    $('#onboard').classList.add('step');
    renderObStep();
    $('#ob-content').classList.remove('hidden');
  }, 1600);
}

$('#ob-next').addEventListener('click', () => {
  if (obStep < OB_STEPS.length - 1) { obStep++; renderObStep(); }
  else finishOnboarding(true);
});
$('#ob-skip').addEventListener('click', () => finishOnboarding(false));
$('#btn-wallet-login').addEventListener('click', () => switchView('profile'));

// ---------------- Wallet 2.0: Gutscheine mit Guthaben + Sparkarten ----------------

// Migration alter Einträge: value-String -> Guthaben, neue Felder ergänzen
state.wallet.vouchers = state.wallet.vouchers.map(v => ({
  pin: '', img: '', codeImg: '', tx: [], balance: v.balance ?? (parseFloat(String(v.value || '').replace(',', '.')) || null),
  amount: v.amount ?? (parseFloat(String(v.value || '').replace(',', '.')) || null),
  ...v,
}));
state.wallet.cards = state.wallet.cards.map(c => ({ img: '', codeImg: '', ...c }));
// Bestandsdaten ohne Datum reparieren (sehr alte Einträge haben weder added
// noch Buchungs-Zeitstempel) – sonst ignoriert die Statistik sie stumm
function ensureWalletDates() {
  state.wallet.vouchers.forEach(v => {
    const stamps = (v.tx || []).map(t => t.ts).filter(Boolean);
    if (!v.added) v.added = stamps.length ? Math.min(...stamps) : Date.now();
    (v.tx || []).forEach(t => { if (!t.ts) t.ts = v.added; });
  });
}
ensureWalletDates();
// Payload-Diät: das Originalfoto ist überflüssig, sobald der Kassen-Zuschnitt da
// ist. Base64-Fotos machten die Wallet mehrere MB groß und ließen den Sync über
// Mobilfunk regelmäßig ins Timeout laufen ("Gutschein nur lokal gespeichert")
function slimWalletImages() {
  let changed = false;
  [...state.wallet.vouchers, ...state.wallet.cards].forEach(it => {
    if (it.img && it.codeImg) { it.img = ''; changed = true; }
  });
  return changed;
}
slimWalletImages();
// Zuschnitte aus früheren Versionen waren PNGs mit mehreren MB und sprengten den
// Konto-Sync: einmalig zu kompaktem JPEG umwandeln
(async function shrinkOldCodeImgs() {
  let changed = false;
  for (const item of [...state.wallet.vouchers, ...state.wallet.cards]) {
    if (item.codeImg && item.codeImg.startsWith('data:image/png') && item.codeImg.length > 300000) {
      try {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = item.codeImg; });
        const c = document.createElement('canvas');
        const s = Math.min(1, 700 / Math.max(img.width, img.height));
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        item.codeImg = c.toDataURL('image/jpeg', 0.88);
        changed = true;
      } catch { }
    }
  }
  if (changed) saveWallet();
})();

// Wallet: lokal speichern + (angemeldet) ans Konto syncen, Gutscheine überleben
// so App-Neuinstallation und Gerätewechsel
let walletSyncTimer = null;
// Solange etwas nicht beim Server angekommen ist, bleibt die Dirty-Marke stehen
// und der Sync wird wiederholt; so kann "gespeichert" nie mehr heimlich verloren gehen
let walletSyncError = '';
let walletSyncFatal = false; // true = der Server hat abgelehnt (Retry zwecklos)
let walletSyncInFlight = null; // Single-Flight: parallele Syncs teilen sich EINEN Upload
async function syncWalletNow() {
  if (!state.token) return true;
  // Läuft schon ein Upload, hängen sich alle dran, statt sich über Mobilfunk
  // gegenseitig die Bandbreite wegzunehmen (das provozierte Timeouts)
  if (walletSyncInFlight) return walletSyncInFlight;
  walletSyncInFlight = (async () => {
    renderSyncBadge();
    try {
      // Großzügiges Timeout: große Wallets über Mobilfunk brauchen ihre Zeit,
      // hängen darf trotzdem nichts
      const signal = AbortSignal.timeout ? AbortSignal.timeout(45000) : undefined;
      await api('/api/wallet', { method: 'POST', body: JSON.stringify(state.wallet), signal });
      localStorage.removeItem('ra.walletDirty');
      walletSyncError = '';
      walletSyncFatal = false;
      walletRetryDelay = 1500; // Backoff zurücksetzen
      clearTimeout(walletRetryTimer);
      return true;
    } catch (e) {
      walletSyncError = e.name === 'TimeoutError' || e.name === 'AbortError'
        ? 'Das Sichern dauert zu lange (Verbindung zu langsam?).'
        : (e.message || '');
      walletSyncFatal = e.status >= 400 && e.status < 500;
      localStorage.setItem('ra.walletDirty', '1');
      // Schnell nachfassen statt aufs 30s-Intervall zu warten: die PWA hat nach
      // dem Aufwachen oft 1-2s kein Netz, der erste Versuch scheitert dann leise
      if (!walletSyncFatal) {
        walletRetryDelay = Math.min(24000, walletRetryDelay * 2);
        clearTimeout(walletRetryTimer);
        walletRetryTimer = setTimeout(() => {
          if (state.token && localStorage.getItem('ra.walletDirty')) syncWalletNow();
        }, walletRetryDelay);
      }
      return false;
    } finally {
      walletSyncInFlight = null;
      renderSyncBadge();
    }
  })();
  return walletSyncInFlight;
}
let walletRetryTimer = null;
let walletRetryDelay = 1500;
function saveWallet() {
  save('wallet', state.wallet);
  renderWallet();
  if (state.token) {
    localStorage.setItem('ra.walletDirty', '1');
    clearTimeout(walletSyncTimer);
    walletSyncTimer = setTimeout(syncWalletNow, 800);
  }
}
// Nachzügler-Sync: sobald wieder Netz da ist, die App aufwacht/in den Vordergrund
// kommt (PWA!) oder regelmäßig im Hintergrund
function syncIfDirty() {
  if (state.token && localStorage.getItem('ra.walletDirty')) syncWalletNow();
}
window.addEventListener('online', syncIfDirty);
window.addEventListener('focus', syncIfDirty);
window.addEventListener('pageshow', syncIfDirty);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncIfDirty();
});
setInterval(syncIfDirty, 15000);

// Sicherungs-Ampel in der Wallet: zeigt ehrlich, ob alles beim Konto gesichert
// ist; antippen stößt die Sicherung sofort an
function renderSyncBadge() {
  const el = $('#wallet-sync-badge');
  if (!el) return;
  if (!state.token) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  if (walletSyncInFlight) {
    el.className = 'sync-badge syncing';
    el.innerHTML = `${icon('clock', 'icon icon-sm')} Sichere am Konto …`;
  } else if (localStorage.getItem('ra.walletDirty')) {
    el.className = 'sync-badge dirty';
    el.innerHTML = `${icon('warning', 'icon icon-sm')} Noch nicht gesichert, antippen zum Sichern`;
  } else {
    el.className = 'sync-badge ok';
    el.innerHTML = `${icon('check', 'icon icon-sm')} Alles am Konto gesichert`;
  }
}
$('#wallet-sync-badge')?.addEventListener('click', async () => {
  if (walletSyncInFlight || !localStorage.getItem('ra.walletDirty')) return;
  renderSyncBadge();
  const ok = await syncWalletNow();
  island(ok ? 'Alles gesichert' : 'Sichern fehlgeschlagen: ' + (walletSyncError || 'Server nicht erreichbar'));
});
async function pullWallet() {
  if (!state.token) return;
  try {
    const remote = await api('/api/wallet');
    const mergeById = (a = [], b = []) => {
      const seen = new Set(a.map(x => x.id));
      return [...a, ...b.filter(x => x && !seen.has(x.id))];
    };
    state.wallet.vouchers = mergeById(state.wallet.vouchers, remote.vouchers);
    state.wallet.cards = mergeById(state.wallet.cards, remote.cards);
    // Geschenke von Freunden einsammeln (Dupe-sicher über die Gutschein-ID)
    const neu = (remote.gifts || []).filter(g => !state.wallet.vouchers.some(v => v.id === g.id));
    neu.forEach(g => state.wallet.vouchers.unshift({ ...g, added: Date.now() }));
    ensureWalletDates(); // auch vom Konto gezogene Alt-Gutscheine kriegen ein Datum
    saveWallet(); // lokal sichern + Mergestand zurück zum Server
    if ((remote.gifts || []).length) {
      if (neu.length) {
        const g = neu[0];
        playSfx('kaching'); buzz([40, 40, 40]); moneyFlash('green'); billRain(9);
        showToast({
          title: `Geschenk von @${g.giftFrom}!`,
          text: `${g.vendor}-Gutschein${g.amount != null ? ' über ' + euroFmt(g.amount) : ''} ist jetzt in deiner Wallet.`,
          iconName: 'gift', success: true,
        }, 9000);
      }
      // Erst beim Server abhaken, wenn die eigene Wallet MIT dem Geschenk gesichert ist
      syncWalletNow().then(ok => {
        if (ok) api('/api/gift/claim', { method: 'POST', body: JSON.stringify({ ids: remote.gifts.map(g => g.id) }) }).catch(() => { });
      });
    }
  } catch { }
}
function euroFmt(n) { return n == null ? '' : n.toFixed(2).replace('.', ',') + ' €'; }

// ---- Spielgefühl: Sounds, Vibration, Aufleuchten, Geldscheine, Zähl-Animation ----

const SFX = { kaching: '/sounds/kaching.mp3', pay: '/sounds/pay.mp3', case: '/sounds/case.mp3', plop: '/sounds/plop.mp3', coin: '/sounds/coin.mp3', error: '/sounds/error.mp3' };
function sfxDuration(name) { return sfxBuffers[name]?.audio?.duration || 0; }
// WebAudio: Sounds vorgeladen und ohne Anlauf-Stille, spielen sofort beim Tipp
let sfxCtx = null;
const sfxBuffers = {};
function initSfx() {
  if (sfxCtx) return;
  try { sfxCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
  Object.entries(SFX).forEach(async ([k, url]) => {
    try {
      const raw = await (await fetch(url)).arrayBuffer();
      const audio = await sfxCtx.decodeAudioData(raw);
      const d = audio.getChannelData(0);
      let i = 0; while (i < d.length && Math.abs(d[i]) < 0.02) i++;
      sfxBuffers[k] = { audio, offset: i / audio.sampleRate };
    } catch { }
  });
}
document.addEventListener('pointerdown', initSfx, { once: true, capture: true });
function playSfx(name) {
  const b = sfxBuffers[name];
  if (sfxCtx && b) {
    try {
      if (sfxCtx.state === 'suspended') sfxCtx.resume();
      const src = sfxCtx.createBufferSource();
      src.buffer = b.audio;
      const gain = sfxCtx.createGain();
      gain.gain.value = 0.6;
      src.connect(gain); gain.connect(sfxCtx.destination);
      src.start(0, b.offset);
      return { stop() { try { src.stop(); } catch { } } };
    } catch { }
  }
  try {
    const a = new Audio(SFX[name]); a.volume = 0.55; a.play().catch(() => { });
    return { stop() { try { a.pause(); } catch { } } };
  } catch { }
  return { stop() { } };
}
function buzz(pattern) { try { navigator.vibrate && navigator.vibrate(pattern); } catch { } }

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function moneyFlash(kind) {
  if (reducedMotion()) return;
  const el = document.createElement('div');
  el.className = 'money-flash ' + kind;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 800);
}

// Geldscheine steigen vom unteren Bildschirmrand auf
function billRain(count = 6) {
  if (reducedMotion()) return;
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'bill-float';
    el.style.left = (12 + (i / count) * 76 + (i % 3) * 3) + 'vw';
    el.style.bottom = (90 + (i % 3) * 26) + 'px';
    el.style.setProperty('--rot', ((i % 2 ? 1 : -1) * (8 + i * 4)) + 'deg');
    el.style.animationDelay = (i * 70) + 'ms';
    el.innerHTML = icon('banknote', 'icon');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1500 + i * 70);
  }
}

// Zahl zählt sichtbar hoch/runter (Gesamtguthaben, Gutschein-Guthaben)
function animateNumber(el, from, to, ms = 700) {
  if (!el) return;
  if (reducedMotion() || from == null || from === to) { el.textContent = euroFmt(to) || '0,00 €'; return; }
  const t0 = performance.now();
  el.classList.remove('bal-bump'); void el.offsetWidth; el.classList.add('bal-bump');
  // Sicherung: Endwert landet auch, wenn rAF pausiert (Tab im Hintergrund)
  const safety = setTimeout(() => { el.textContent = euroFmt(to) || '0,00 €'; }, ms + 100);
  const tick = now => {
    const p = Math.min(1, (now - t0) / ms);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = euroFmt(from + (to - from) * eased) || '0,00 €';
    if (p < 1) requestAnimationFrame(tick);
    else clearTimeout(safety);
  };
  requestAnimationFrame(tick);
}

// ---- Spar-Ränge: motivieren, Guthaben zu sammeln ----
const RANKS = [
  { min: 0, name: 'Spar-Neuling', tier: 1 },
  { min: 25, name: 'Sparfuchs', tier: 2 },
  { min: 75, name: 'Schnäppchenjäger', tier: 3 },
  { min: 150, name: 'Spar-Meister', tier: 4 },
  { min: 300, name: 'Gutschein-Guru', tier: 4 },
  { min: 500, name: 'Wallet-Legende', tier: 5 },
];
function rankFor(total) {
  let cur = RANKS[0];
  for (const r of RANKS) if (total >= r.min) cur = r;
  const next = RANKS[RANKS.indexOf(cur) + 1] || null;
  return { ...cur, next };
}

// Code aus eingefügtem Text erkennen (regelbasiert, echte KI folgt mit dem Backend)
function detectCode(text) {
  const labeled = text.match(/(?:code|coupon|rabatt-?code|gutschein-?code)\s*[:=]\s*([A-Za-z0-9-]{4,24})/i);
  if (labeled) return labeled[1];
  const candidates = [...text.matchAll(/\b[A-Z0-9][A-Z0-9-]{5,19}\b/g)].map(m => m[0])
    .filter(c => /\d/.test(c) || /^[A-Z-]{8,}$/.test(c))
    .filter(c => !/^\d{1,4}[.,]\d{2}$/.test(c));
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || '';
}

// Screenshot (QR/Barcode) einlesen und fürs localStorage verkleinern
function readImageFile(file, max = 900, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      resolve(cv.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    img.src = url;
  });
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); island('Kopiert'); }
  catch { island('Kopieren nicht möglich'); }
}

// ---- Hinzufügen (großes Plus -> Sheet)
let addImg = '';
let addType = 'voucher';
let addPrefill = '';
let addCodeImg = ''; // ausgeschnittener Kassen-Code (falls der Scanner ihn findet)

// Doppelte Gutscheine: gleiche PIN beim gleichen Shop oder gleicher Code
function findDupe(v, extra = []) {
  return [...state.wallet.vouchers, ...extra].find(x =>
    (x.pin && v.pin && x.pin === v.pin && x.vendor.toLowerCase() === v.vendor.toLowerCase())
    || (v.code && x.code && x.code === v.code));
}
// Schon vorhanden: XP-Error-Sound, Wackeln, rotes Aufleuchten und das Formular
// wird KOMPLETT zurückgesetzt (frisches Sheet mit Hinweis-Banner oben)
function dupeReject(text) {
  playSfx('error');
  buzz([60, 50, 60]);
  moneyFlash('red');
  // Läuft gerade die Ergänzen-Warteschlange, geht es mit dem nächsten weiter
  if (!nextFixOrDone()) openWalletAdd(addType, addPrefill);
  const banner = document.createElement('div');
  banner.className = 'dupe-banner';
  banner.innerHTML = `${icon('warning', 'icon icon-sm')} <span>${text} Alles wurde zurückgesetzt.</span>`;
  $('#sheet-content').prepend(banner);
  const c = $('#sheet-content');
  if (c && !reducedMotion()) {
    c.classList.remove('shake-once'); void c.offsetWidth; c.classList.add('shake-once');
    setTimeout(() => c.classList.remove('shake-once'), 420);
  }
}

// Speichern läuft gerade: blockt Doppelklicks auf den Speichern-Button
let waSaving = false;

// Warteschlange „fehlende Angaben ergänzen": unvollständig gescannte Gutscheine
// aus dem Mehrfach-Upload landen hier statt im Müll
let waFixQueue = [];
let waFixTotal = 0;
function openFixForm(fix, pos, total) {
  openWalletAdd('voucher');
  addImg = fix.img || '';
  addCodeImg = fix.codeImg || '';
  if (addCodeImg || addImg) {
    $('#wa-preview').src = addCodeImg || addImg;
    $('#wa-preview').classList.remove('hidden');
    $('#wa-drop-empty').classList.add('hidden');
  }
  if (fix.vendor) {
    const tile = [...document.querySelectorAll('[data-vg]')].find(t => t.dataset.vg.toLowerCase() === fix.vendor.toLowerCase());
    if (tile) {
      if (tile.classList.contains('vendor-more')) $('#wa-vendor-showmore')?.click();
      tile.click();
    } else {
      [...document.querySelectorAll('[data-vg]')].find(t => t.dataset.vg === 'Anderer Gutschein')?.click();
      const inp = $('#wa-vendor');
      if (inp) { inp.classList.remove('hidden'); inp.value = fix.vendor; }
    }
  }
  if (fix.amount != null) $('#wa-amount').value = String(fix.amount).replace('.', ',');
  if (fix.pin) $('#wa-pin').value = fix.pin;
  if (fix.code) $('#wa-code').value = fix.code;
  const fehlt = [!fix.vendor && 'Shop', fix.amount == null && 'Wert', !fix.pin && 'PIN'].filter(Boolean).join(', ');
  const banner = document.createElement('div');
  banner.className = 'fix-banner';
  banner.innerHTML = `${icon('bulb', 'icon icon-sm')} <span><b>Gutschein ${pos} von ${total}:</b> alles Erkannte ist schon eingetragen, bitte noch ${esc(fehlt || 'die Felder prüfen')} ergänzen und speichern.</span>`;
  $('#sheet-content').prepend(banner);
  $('#sheet-content').scrollTop = 0;
}
function nextFixOrDone() {
  if (!waFixQueue.length) return false;
  openFixForm(waFixQueue.shift(), waFixTotal - waFixQueue.length, waFixTotal);
  return true;
}

// Bild aus der Zwischenablage (Strg+V) direkt ins offene Hinzufügen-Formular
let waHandleImage = null;
document.addEventListener('paste', e => {
  if (state.sheetMode !== 'wallet-add' || !waHandleImage) return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  waHandleImage(item.getAsFile());
  island('Bild aus der Zwischenablage übernommen');
});

// Bekannte Shops für die manuelle Schnell-Auswahl
const VENDOR_QUICK = ['REWE', 'Amazon', 'Wunschgutschein', 'Zalando', 'IKEA', 'Rossmann', 'Lidl', 'EDEKA'];

// Bild automatisch auslesen: QR/Barcode (BarcodeDetector) + Text (TextDetector, wo verfügbar).
// Volle KI-Auslese (Claude Vision) kommt mit dem Live-Backend.
// Kassen-Code ausschneiden: nur der Barcode/QR, großzügig gepolstert und
// hochskaliert, den hält man an der Kasse hin, perfekt lesbar
function cropCode(img, bb, pad = 1) {
  if (!bb || bb.width < 20 || bb.height < 10) return '';
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  // Großzügig Rand lassen: lieber etwas mehr Bild als ein angeschnittener Code
  const padX = Math.max(bb.width * 0.3, 36) * pad, padY = Math.max(bb.height * 0.5, 36) * pad;
  const x = Math.max(0, bb.x - padX), y = Math.max(0, bb.y - padY);
  const w = Math.min(iw - x, bb.width + padX * 2);
  const h = Math.min(ih - y, bb.height + padY * 2);
  // Immer 1:1: der Code sitzt mittig auf einem weißen Quadrat, an der Kasse perfekt scannbar.
  // JPEG statt PNG: Foto-Zuschnitte als PNG wurden mehrere MB groß und sprengten den Konto-Sync
  const side = Math.max(w, h);
  const out = Math.min(700, Math.max(440, Math.round(side)));
  const c = document.createElement('canvas');
  c.width = out; c.height = out;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out, out);
  const scale = (out * 0.9) / side;
  const dw = w * scale, dh = h * scale;
  ctx.drawImage(img, x, y, w, h, (out - dw) / 2, (out - dh) / 2, dw, dh);
  return c.toDataURL('image/jpeg', 0.88);
}

// Helle, farbarme Kästen im Foto finden (Kartennummer-Kasten, PIN-Kasten):
// helles Zeilen-Band suchen, darin getrennte Kästen über Lücken im
// Spalten-Histogramm auseinanderhalten; Ergebnis von links nach rechts
function findLightPanels(img) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!iw || !ih) return [];
  const W = 160;
  const H = Math.max(40, Math.round(ih / iw * W));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  let d;
  try { d = ctx.getImageData(0, 0, W, H).data; } catch { return []; }
  const light = (x, y) => {
    const i = (y * W + x) * 4;
    const mx = Math.max(d[i], d[i + 1], d[i + 2]);
    const mn = Math.min(d[i], d[i + 1], d[i + 2]);
    return mx > 160 && (mx - mn) < 46; // hell und (fast) unbunt = Papier/Kasten
  };
  const rowFrac = [];
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = 0; x < W; x++) if (light(x, y)) n++;
    rowFrac.push(n / W);
  }
  // Größtes zusammenhängendes helles Zeilen-Band suchen (>20% helle Pixel je Zeile:
  // auch wenn nur der schmale PIN-Kasten in der Zeile liegt, zählt sie mit)
  let best = null, run = null;
  for (let y = 0; y <= H; y++) {
    if (y < H && rowFrac[y] > 0.2) { run = run || { y0: y }; run.y1 = y; }
    else if (run) { if (!best || run.y1 - run.y0 > best.y1 - best.y0) best = run; run = null; }
  }
  if (!best || best.y1 - best.y0 < H * 0.08) return [];
  const bandH = best.y1 - best.y0 + 1;
  const colOn = [];
  for (let x = 0; x < W; x++) {
    let n = 0;
    for (let y = best.y0; y <= best.y1; y++) if (light(x, y)) n++;
    colOn.push(n / bandH > 0.5);
  }
  // Getrennte Kästen: Lücken von mindestens 4 Spalten teilen
  const segs = [];
  let s = null, gap = 0;
  for (let x = 0; x <= W; x++) {
    if (x < W && colOn[x]) {
      if (!s) s = { x0: x };
      s.x1 = x; gap = 0;
    } else if (s && ++gap >= 4) { segs.push(s); s = null; }
  }
  if (s) segs.push(s);
  const sx = iw / W, sy = ih / H;
  return segs
    .filter(seg => seg.x1 - seg.x0 >= W * 0.06)
    .map(seg => ({ x: seg.x0 * sx, y: best.y0 * sy, width: (seg.x1 - seg.x0 + 1) * sx, height: bandH * sy }));
}
// Für den Kassen-Zuschnitt: der größte Kasten (= Kartennummer-Kasten)
function findLightPanel(img) {
  const panels = findLightPanels(img);
  return panels.sort((a, b) => b.width * b.height - a.width * a.height)[0] || null;
}

// iPhone-Fallback: Safari hat keinen BarcodeDetector, ZXing (lokal in
// public/vendor, wird nur bei Bedarf geladen) liest QR/EAN/Code128 & Co.
async function zxingDetect(img) {
  if (!window.ZXing) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = '/vendor/zxing.min.js'; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    }).catch(() => { });
  }
  if (!window.ZXing) return null;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width; c.height = img.naturalHeight || img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  try {
    const source = new ZXing.HTMLCanvasElementLuminanceSource(c);
    const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source));
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    const result = new ZXing.MultiFormatReader().decode(bitmap, hints);
    const pts = (result.getResultPoints() || []).filter(Boolean);
    let box = null;
    if (pts.length >= 2) {
      const xs = pts.map(p => p.getX()), ys = pts.map(p => p.getY());
      box = {
        x: Math.min(...xs), y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      };
      // 1D-Barcodes liefern nur eine Scan-Linie, Höhe/Breite großzügig auffüllen
      if (box.height < 30) { box.y = Math.max(0, box.y - 70); box.height += 140; }
      if (box.width < 30) { box.x = Math.max(0, box.x - 70); box.width += 140; }
      // Die ZXing-Punkte sitzen auf den Finder-MITTEN, der Code reicht darüber
      // hinaus: Box aufblasen, damit garantiert kein Pixel des Codes fehlt
      const ix = box.width * 0.28, iy = box.height * 0.28;
      box = { x: Math.max(0, box.x - ix), y: Math.max(0, box.y - iy), width: box.width + ix * 2, height: box.height + iy * 2 };
    }
    return { text: result.getText(), box };
  } catch { return null; }
}

// Text im Bild lesen (Kartennummer, PIN, Wert): Tesseract-OCR, lokal aus
// public/vendor/tesseract, lädt nur beim ersten Gebrauch, Fortschritt via Callback
let ocrWorkerPromise = null;
let ocrStatusCb = null;
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}
async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      if (!window.Tesseract) await loadScript('/vendor/tesseract/tesseract.min.js');
      // ABSOLUTE URLs: der Tesseract-Worker läuft als Blob, dort sind relative
      // Pfade ungültig ("importScripts ... is invalid") und die OCR fiel stumm aus
      return Tesseract.createWorker('deu', 1, {
        workerPath: location.origin + '/vendor/tesseract/worker.min.js',
        corePath: location.origin + '/vendor/tesseract/tesseract-core-simd.wasm.js',
        langPath: location.origin + '/vendor/tesseract',
        logger: m => { if (m.status === 'recognizing text') ocrStatusCb?.(Math.round(m.progress * 100)); },
      });
    })().catch(e => { ocrWorkerPromise = null; throw e; });
  }
  return ocrWorkerPromise;
}

async function analyzeWalletImage(dataUrl, statusCb) {
  const out = { barcode: '', codeImg: '', text: '', supported: { barcode: true, text: true } };
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  const tryDetect = async source => {
    if ('BarcodeDetector' in window) {
      try {
        const codes = await new BarcodeDetector().detect(source);
        if (codes.length) return { text: codes[0].rawValue || '', box: codes[0].boundingBox };
      } catch { }
    }
    // Kein eingebauter Detector (iPhone) oder nichts gefunden → ZXing versucht es
    return zxingDetect(source);
  };
  let hit = await tryDetect(img);
  if (!hit || !hit.text) {
    // Kleine Codes (z. B. der Mini-Code auf REWE-Karten) brauchen mehr Pixel:
    // hochskaliert nochmal versuchen, die Box danach zurückrechnen
    const up = document.createElement('canvas');
    up.width = (img.naturalWidth || 0) * 2; up.height = (img.naturalHeight || 0) * 2;
    if (up.width && up.width <= 6000) {
      const ctx = up.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, up.width, up.height);
      const r2 = await tryDetect(up);
      if (r2 && r2.text) {
        hit = { text: r2.text, box: r2.box ? { x: r2.box.x / 2, y: r2.box.y / 2, width: r2.box.width / 2, height: r2.box.height / 2 } : null };
      }
    }
  }
  if (hit && hit.text) {
    out.barcode = hit.text;
    // Qualitätskontrolle: der Zuschnitt wird selbst nochmal gescannt. Nur wenn er
    // denselben Code liefert, ist sicher kein Pixel abgeschnitten; sonst wird mit
    // immer mehr Rand nachgeschnitten
    for (const pad of [1, 1.8, 3]) {
      const candidate = cropCode(img, hit.box, pad);
      if (!candidate) break;
      out.codeImg = candidate;
      try {
        const probe = new Image();
        await new Promise((res, rej) => { probe.onload = res; probe.onerror = rej; probe.src = candidate; });
        const re = await tryDetect(probe);
        if (re && re.text === hit.text) break; // Zuschnitt ist beweisbar scannbar
      } catch { break; }
    }
  }
  if (!out.codeImg) {
    // Kein Code lesbar (z. B. abfotografierter Bildschirm mit Moiré):
    // wenigstens den hellen Kartennummer-Kasten sauber ausschneiden
    const panel = findLightPanel(img);
    if (panel) out.codeImg = cropCode(img, panel);
  }
  // Text lesen: erst der schnelle native Weg (falls vorhanden), sonst Tesseract
  if ('TextDetector' in window) {
    try {
      const blocks = await new TextDetector().detect(img);
      out.text = blocks.map(b => b.rawValue).join('\n');
    } catch { }
  }
  if (!out.text) {
    try {
      ocrStatusCb = statusCb || null;
      const worker = await getOcrWorker();
      const { data } = await worker.recognize(dataUrl);
      out.text = data.text || '';
      out.words = data.words || []; // Wort-Koordinaten: damit lässt sich „PIN" im Bild ORTEN
    } catch { out.supported.text = false; }
    finally { ocrStatusCb = null; }
  }
  // PIN-Suche: erst im Volltext; der PIN-Kasten sitzt aber oft klein rechts außen
  // und geht in der Vollbild-OCR unter → rechten Randstreifen gezielt nochmal lesen
  const pinFrom = t => {
    // NUR Treffer mit „PIN"-Label; nackte Zahlen laufen über die strenge
    // Vertrauensprüfung in pinPick. Alphanumerischer PIN (Zalando) muss eine
    // Ziffer enthalten (filtert Wörter wie „für") und darf keine reine lange
    // Zahl sein (das wäre die Kartennummer)
    const alnum = t.match(/\bpin\b\s*[:=]?\s*([A-Za-z0-9]{6,20})\b/i);
    if (alnum && /\d/.test(alnum[1]) && !/^\d{11,}$/.test(alnum[1])) return alnum[1];
    return (t.match(/\bpin\b\D{0,80}?(\d{3,10})\b/i))?.[1] || '';
  };
  // Wert: „25,00 €", „5 €" und „€5" (manche Anbieter schreiben das Zeichen davor)
  const amtFrom = t => {
    const m = t.match(/(\d{1,4}[.,]\d{2})\s*€|\b(\d{1,3})\s*(?:€|EUR)\b/i)
      || t.match(/(?:€|EUR)\s*(\d{1,4}(?:[.,]\d{2})?)\b/i);
    return m ? (m[1] || m[2]) : '';
  };
  // Kandidaten werden NUR übernommen, wenn die OCR beim zugehörigen Wort sicher
  // war: mit PIN-Label reicht mittlere Sicherheit, eine nackte Zahl ohne Label
  // muss 4-stellig sein und sehr sicher gelesen worden sein. Nie raten!
  const pinPick = (text, words) => {
    const label = pinFrom(text);
    if (label) return ocrTrusted(words, label, 55) ? label : '';
    const bare = (text.match(/(?:^|\n)[^\S\n]*(\d{4})[^\S\n]*(?:\n|$)/) || [])[1];
    return bare && ocrTrusted(words, bare, 72) ? bare : '';
  };
  out.pin = pinPick(out.text, out.words);
  out.amount = amtFrom(out.text);
  // Am Text orientieren: das WORT „PIN" im Bild orten und den Kasten daneben/
  // darunter stark vergrößert nachlesen (der Wert geht im Vollbild oft unter)
  if (!out.pin) out.pin = await pinNearWord(img, out.words, pinPick);
  if (!out.pin || !out.amount) {
    // Zweitpass in hartem Schwarz-Weiß: Schrift auf farbigen Kacheln (z. B. der
    // Zalando-Kasten mit „€5") verschluckt die normale OCR sonst komplett
    const bw = await ocrBW(img);
    if (!out.amount) out.amount = amtFrom(bw.text);
    if (!out.pin) out.pin = pinPick(bw.text, bw.words) || await pinNearWord(bw.source, bw.words, pinPick);
  }
  if (!out.pin) {
    // Der PIN wohnt im RECHTEN hellen Kasten: den gezielt ausschneiden und lesen
    const panels = findLightPanels(img);
    if (panels.length > 1) {
      const p = panels[panels.length - 1];
      const reg = await ocrRegion(img, Math.max(0, p.x - p.width * 0.05), Math.max(0, p.y - p.height * 0.15), p.width * 1.15, p.height * 1.35);
      out.pin = pinPick(reg.text, reg.words) || pickBareDigits(reg);
    }
  }
  if (!out.pin) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const reg = await ocrRegion(img, Math.round(iw * 0.62), 0, iw - Math.round(iw * 0.62), ih);
    out.pin = pinPick(reg.text, reg.words) || pickBareDigits(reg);
  }
  // Ein PIN darf nie einfach ein Stück der Kartennummer sein
  if (out.pin && out.pin.length < 6 && (out.barcode || '').includes(out.pin)) out.pin = '';
  return out;
}

// Nackte 4-stellige Zahl ohne Label: nur mit sehr sicherer Lesung übernehmen
function pickBareDigits(reg) {
  const bare = (reg.text.match(/\b(\d{4})\b/) || [])[1];
  return bare && ocrTrusted(reg.words, bare, 72) ? bare : '';
}

// „PIN" wurde als Wort mit Koordinaten erkannt: die Umgebung (rechts daneben und
// darunter, wo der Wert steht) ausschneiden, hochskalieren und gezielt lesen
async function pinNearWord(source, words, pinPick) {
  const pinWord = (words || []).find(w => /^pin\b/i.test((w.text || '').trim()));
  if (!source || !pinWord || !pinWord.bbox) return '';
  const b = pinWord.bbox;
  const w = Math.max(12, b.x1 - b.x0), h = Math.max(10, b.y1 - b.y0);
  const iw = source.naturalWidth || source.width, ih = source.naturalHeight || source.height;
  const sx = Math.max(0, b.x0 - w * 1.5), sy = Math.max(0, b.y0 - h * 1.5);
  const reg = await ocrRegion(source, sx, sy, Math.min(iw - sx, w * 12), Math.min(ih - sy, h * 9));
  return pinPick(reg.text, reg.words) || pickBareDigits(reg);
}

// Bild hart binarisieren (dunkle Schrift → schwarz, alles andere → weiß) und lesen
async function ocrBW(img) {
  try {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const c = document.createElement('canvas');
    const s = Math.min(1, 1600 / Math.max(iw, ih));
    c.width = Math.round(iw * s); c.height = Math.round(ih * s);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const im = ctx.getImageData(0, 0, c.width, c.height);
    const d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = y < 110 ? 0 : 255;
    }
    ctx.putImageData(im, 0, 0);
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(c.toDataURL('image/jpeg', 0.9));
    // Wortkoordinaten beziehen sich auf den (skalieren) BW-Canvas → mitgeben
    return { text: data.text || '', words: data.words || [], source: c };
  } catch { return { text: '', words: [], source: null }; }
}

// Einen Bildausschnitt hochskaliert durch die OCR schicken (z. B. den PIN-Kasten)
async function ocrRegion(img, sx, sy, sw, sh) {
  if (sw < 30 || sh < 30) return { text: '', words: [] };
  const c = document.createElement('canvas');
  const scale = Math.min(3, Math.max(1, 900 / sw));
  c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(c.toDataURL('image/jpeg', 0.92));
    return { text: data.text || '', words: data.words || [] };
  } catch { return { text: '', words: [] }; }
}

// Vertrauens-Check: der Kandidat muss aus einem Wort stammen, bei dem sich die
// OCR sicher war. Lieber ein leeres Feld als eine geratene Zahl.
function ocrTrusted(words, token, minConf) {
  if (!token) return false;
  const hit = (words || []).find(w => (w.text || '').replace(/[^A-Za-z0-9]/g, '').includes(token));
  return !!hit && (hit.confidence ?? 0) >= minConf;
}

// Große, interaktive Shop-Auswahl beim Hinzufügen (erst 6, Rest hinter "Weitere")
const VENDOR_GRID = ['REWE', 'Amazon', 'Wunschgutschein', 'Zalando', 'IKEA', 'Rossmann', 'Lidl', 'EDEKA', 'Netto', 'dm', 'Müller', 'MediaMarkt', 'H&M', 'Douglas', 'Nike', 'Anderer Gutschein'];
const CARD_GRID = ['Payback', 'DeutschlandCard', 'Lidl Plus', 'IKEA Family', 'Rossmann', 'REWE', 'dm', 'Andere Karte'];

// Marken-Logos über den Favicon-Dienst, Initialen bleiben als Fallback darunter
const BRAND_DOMAINS = {
  rewe: 'rewe.de', amazon: 'amazon.de', wunschgutschein: 'wunschgutschein.de',
  zalando: 'zalando.de', ikea: 'ikea.com', rossmann: 'rossmann.de', lidl: 'lidl.de',
  edeka: 'edeka.de', netto: 'netto-online.de', dm: 'dm.de', 'müller': 'mueller.de',
  mediamarkt: 'mediamarkt.de', 'h&m': 'hm.com', douglas: 'douglas.de', nike: 'nike.com',
  payback: 'payback.de', wolt: 'wolt.com', lieferando: 'lieferando.de', spotify: 'spotify.com',
  deutschlandcard: 'deutschlandcard.de', 'lidl plus': 'lidl.de', 'ikea family': 'ikea.com',
  aldi: 'aldi-sued.de', penny: 'penny.de', norma: 'norma-online.de', kaufland: 'kaufland.de',
  globus: 'globus.de', tegut: 'tegut.com', otto: 'otto.de', ebay: 'ebay.de', temu: 'temu.com',
  adidas: 'adidas.de', zara: 'zara.com', shein: 'shein.com', saturn: 'saturn.de',
  mcdonalds: 'mcdonalds.com', 'burger king': 'burgerking.de', subway: 'subway.com',
  netflix: 'netflix.com', disney: 'disneyplus.com', 'uber eats': 'ubereats.com',
};
function brandChipHtml(name) {
  const domain = BRAND_DOMAINS[String(name || '').toLowerCase()];
  const logo = domain
    ? `<img class="brand-logo" src="https://www.google.com/s2/favicons?domain=${domain}&sz=64" alt="" loading="lazy" onerror="this.remove()">`
    : '';
  return `<span class="brand-chip" style="--bc:${brandColor(name)}">${logo}${esc(brandInitials(name))}</span>`;
}

function openWalletAdd(type, prefillName) {
  if (!state.token) { switchView('profile'); island('Für die Wallet bitte anmelden'); return; }
  waSaving = false;
  addType = type || 'voucher';
  addPrefill = prefillName || '';
  state.sheetMode = 'wallet-add';
  addImg = '';
  addCodeImg = '';
  const isCard = addType === 'card';
  $('#sheet-content').innerHTML = `
    <div class="sheet-title">${isCard ? 'Sparkarte hinzufügen' : 'Gutschein hinzufügen'}</div>

    <!-- Bild zuerst: hochladen, fotografieren oder einfach reinziehen -->
    <div class="dropzone" id="wa-drop">
      <div class="dropzone-empty" id="wa-drop-empty">
        ${icon('plus', 'icon')}
        <span>Screenshot / Foto hierher ziehen,<br>einfügen (Strg+V) oder unten auswählen</span>
      </div>
      <div class="scan-frame" id="wa-scan-frame">
        <img id="wa-preview" class="wallet-img hidden" alt="">
        <div class="scan-line hidden" id="wa-scanline"></div>
      </div>
      <div class="scan-progress hidden" id="wa-progress">
        <div class="scan-progress-track"><div class="scan-progress-fill" id="wa-progress-fill"></div></div>
        <span id="wa-progress-txt">0 %</span>
      </div>
      <div id="wa-result" class="hidden"></div>
      <div class="form-row" style="justify-content:center">
        <label class="btn btn-small btn-ghost" style="cursor:pointer">${isCard ? 'Bild' : 'Bilder'} hochladen
          <input id="wa-img" type="file" accept="image/*" ${isCard ? '' : 'multiple'} style="display:none"></label>
        <label class="btn btn-small btn-ghost" style="cursor:pointer">Foto aufnehmen
          <input id="wa-cam" type="file" accept="image/*" capture="environment" style="display:none"></label>
      </div>
      ${isCard ? '' : '<p class="muted" style="font-size:.72rem; text-align:center; margin-top:4px">Tipp: mehrere Bilder auswählen, dann landen alle erkannten Gutscheine auf einmal in der Wallet.</p>'}
      <div id="wa-ai-msg" class="form-msg" style="text-align:center"></div>
    </div>

    ${isCard ? `
    <label class="f-label">Karte <span class="req">*</span></label>
    <div class="vendor-grid" id="wa-card-grid">
      ${CARD_GRID.map(v => `<button class="vendor-tile ${addPrefill === v ? 'on' : ''}" data-cg="${esc(v)}">
        ${brandChipHtml(v)}
        <span>${esc(v)}</span>
      </button>`).join('')}
    </div>
    <input id="wa-cname" class="input ${addPrefill && !CARD_GRID.includes(addPrefill) ? '' : 'hidden'}" maxlength="30" placeholder="Kartenname eintippen" value="${esc(addPrefill && !CARD_GRID.includes(addPrefill) ? addPrefill : '')}">
    <label class="f-label">Kartennummer <span class="req">*</span></label>
    <input id="wa-cnumber" class="input" maxlength="30" placeholder="Nummer auf der Karte">
    ` : `
    <label class="f-label">Shop <span class="req">*</span></label>
    <div class="vendor-grid" id="wa-vendor-grid">
      ${VENDOR_GRID.map((v, i) => `<button class="vendor-tile ${i >= 6 ? 'hidden vendor-more' : ''}" data-vg="${esc(v)}">
        ${brandChipHtml(v)}
        <span>${esc(v)}</span>
      </button>`).join('')}
      <button class="vendor-tile" id="wa-vendor-showmore">
        <span class="brand-chip" style="--bc:rgba(127,127,127,.4)">…</span>
        <span>Weitere</span>
      </button>
    </div>
    <input id="wa-vendor" class="input hidden" maxlength="30" placeholder="Shop-Name eintippen">
    <div class="form-grid">
      <div>
        <label class="f-label" for="wa-amount">Wert (€) <span class="req">*</span></label>
        <input id="wa-amount" class="input" inputmode="decimal" placeholder="z. B. 25">
      </div>
      <div>
        <label class="f-label" for="wa-pin">PIN <span class="req">*</span></label>
        <input id="wa-pin" class="input" maxlength="16" placeholder="z. B. 0689">
      </div>
    </div>
    <label class="f-label" for="wa-code">Code / Kartennummer <span class="opt">(optional)</span></label>
    <input id="wa-code" class="input" maxlength="40" placeholder="Falls vorhanden: der Code für die Kasse">
    <label class="f-label" for="wa-end">Gültig bis <span class="opt">(optional)</span></label>
    <input id="wa-end" class="input" type="date">
    `}
    <div class="form-row" style="margin-top:14px">
      <button id="wa-save" class="btn">Speichern</button>
      <span id="wa-msg" class="form-msg"></span>
    </div>`;

  // Shop-Kacheln: Antippen wählt aus, "Anderer Gutschein" öffnet das Freitextfeld
  let pickedVendor = '';
  $('#wa-vendor-showmore')?.addEventListener('click', () => {
    $('#sheet-content').querySelectorAll('.vendor-more').forEach(x => x.classList.remove('hidden'));
    $('#wa-vendor-showmore').remove();
  });
  $('#sheet-content').querySelectorAll('[data-vg]').forEach(b => b.addEventListener('click', () => {
    $('#sheet-content').querySelectorAll('.vendor-tile').forEach(x => x.classList.toggle('on', x === b));
    if (b.dataset.vg === 'Anderer Gutschein') {
      pickedVendor = '';
      $('#wa-vendor').classList.remove('hidden');
      $('#wa-vendor').focus();
    } else {
      pickedVendor = b.dataset.vg;
      $('#wa-vendor').classList.add('hidden');
    }
  }));
  const currentVendor = () => pickedVendor || $('#wa-vendor')?.value.trim() || '';

  // Karten-Kacheln (Sparkarten): gleiche Mechanik wie beim Gutschein
  let pickedCard = CARD_GRID.includes(addPrefill) ? addPrefill : '';
  $('#sheet-content').querySelectorAll('[data-cg]').forEach(b => b.addEventListener('click', () => {
    $('#sheet-content').querySelectorAll('[data-cg]').forEach(x => x.classList.toggle('on', x === b));
    if (b.dataset.cg === 'Andere Karte') {
      pickedCard = '';
      $('#wa-cname').classList.remove('hidden');
      $('#wa-cname').focus();
    } else {
      pickedCard = b.dataset.cg;
      $('#wa-cname').classList.add('hidden');
    }
  }));
  const currentCard = () => pickedCard || $('#wa-cname')?.value.trim() || '';

  // Scan-Fortschritt: erst der Code-Scan (bis 20 %), dann die Text-Erkennung
  const scanProgress = p => {
    $('#wa-progress-fill').style.width = p + '%';
    $('#wa-progress-txt').textContent = Math.round(p) + ' %';
  };
  const handleImageFile = async f => {
    const m = $('#wa-ai-msg');
    if (!f) return;
    try {
      addImg = await readImageFile(f);
      $('#wa-preview').src = addImg;
      $('#wa-preview').classList.remove('hidden');
      $('#wa-drop-empty').classList.add('hidden');
      $('#wa-result').classList.add('hidden');
      // Scan-Optik: Laserlinie über dem Bild + cleaner Prozent-Balken
      $('#wa-scanline').classList.remove('hidden');
      $('#wa-progress').classList.remove('hidden');
      $('#wa-progress').classList.remove('done');
      scanProgress(4);
      m.className = 'form-msg';
      m.textContent = 'Scanne das Bild …';
      // Analyse auf hochauflösender Fassung: kleine Schrift bleibt für die OCR lesbar
      const hiRes = await readImageFile(f, 2200, 0.9);
      scanProgress(12);
      const r = await analyzeWalletImage(hiRes, p => {
        scanProgress(20 + p * 0.78);
        m.textContent = 'Lese den Text im Bild … (kann beim ersten Mal etwas dauern)';
      });
      if (r.codeImg) { addCodeImg = r.codeImg; $('#wa-preview').src = r.codeImg; }
      const filled = [];
      if (addType === 'voucher') {
        if (r.barcode && !$('#wa-code').value) { $('#wa-code').value = r.barcode.slice(0, 40); filled.push('Code (aus QR/Barcode)'); }
        // PIN kommt aus dem Scanner (Volltext ODER gezielte Zweit-Suche im rechten Kasten)
        if (r.pin && !$('#wa-pin').value) { $('#wa-pin').value = r.pin.slice(0, 16); filled.push('PIN'); }
        if (r.text) {
          // Wert kommt zentral aus dem Scanner (inkl. Schwarz-Weiß-Zweitpass)
          if (r.amount && !$('#wa-amount').value) { $('#wa-amount').value = r.amount.replace('.', ','); filled.push('Wert'); }
          if (!$('#wa-code').value) {
            // Beschriftete Kartennummer schlägt alles („Kartennummer 2094 2565 …")
            const kn = r.text.match(/karten\s*-?\s*(?:nr\.?|nummer)\D{0,30}?(\d[\d ]{6,28}\d)/i);
            const code = kn ? kn[1].replace(/\s+/g, '') : (!r.barcode ? detectCode(r.text) : '');
            if (code) { $('#wa-code').value = code.slice(0, 40); filled.push('Kartennummer'); }
          }
          const low = r.text.toLowerCase();
          if (!currentVendor()) {
            const hit = [...VENDOR_GRID.map(v => v.toLowerCase()), ...Object.keys(BRAND_COLORS)].find(k => low.includes(k));
            if (hit) {
              const tile = [...document.querySelectorAll('[data-vg]')].find(t => t.dataset.vg.toLowerCase() === hit);
              if (tile) tile.click();
              else { $('#wa-vendor').classList.remove('hidden'); $('#wa-vendor').value = hit.charAt(0).toUpperCase() + hit.slice(1); }
              filled.push('Shop');
            }
          }
        }
      } else {
        if (r.barcode && !$('#wa-cnumber').value) { $('#wa-cnumber').value = r.barcode.slice(0, 30); filled.push('Kartennummer (aus Barcode)'); }
        else if (r.text && !$('#wa-cnumber').value) {
          const kn = r.text.match(/karten\s*-?\s*(?:nr\.?|nummer)\D{0,30}?(\d[\d ]{6,28}\d)/i);
          const num = kn ? kn[1] : (r.text.match(/\d[\d ]{8,24}\d/g) || []).sort((a, b) => b.length - a.length)[0];
          if (num) { $('#wa-cnumber').value = num.replace(/\s+/g, '').slice(0, 30); filled.push('Kartennummer'); }
        }
      }
      if (r.codeImg) filled.push('Kassen-Code ausgeschnitten');
      // Scan fertig: Balken voll, Laserlinie aus, Ergebnis ordentlich untereinander
      scanProgress(100);
      $('#wa-progress').classList.add('done');
      $('#wa-scanline').classList.add('hidden');
      setTimeout(() => $('#wa-progress')?.classList.add('hidden'), 1400);
      const resRow = (label, val) => val
        ? `<div class="scan-row"><span>${label}</span><b>${esc(val)}</b></div>` : '';
      const resCode = addType === 'voucher' ? $('#wa-code').value : $('#wa-cnumber').value;
      const resRows = addType === 'voucher'
        ? resRow('Code', r.barcode && r.barcode !== resCode ? r.barcode : '')
          + resRow('Kartennummer', resCode)
          + resRow('PIN', $('#wa-pin').value)
        : resRow('Kartennummer', resCode);
      if (addCodeImg || resRows) {
        $('#wa-result').classList.remove('hidden');
        $('#wa-result').innerHTML = resRows;
      }
      // Lieber ehrlich als geraten: sagen, was fehlt und selbst geprüft werden muss
      const pinFehlt = addType === 'voucher' && !$('#wa-pin').value;
      if (filled.length) {
        m.className = 'form-msg ok';
        m.textContent = `Gescannt und ausgefüllt: ${filled.join(', ')}, bitte kurz prüfen.`
          + (pinFehlt ? ' Der PIN war nicht sicher lesbar, bitte selbst eintragen.' : '');
      } else {
        m.className = 'form-msg';
        m.textContent = 'Bild gespeichert, nichts sicher erkannt, bitte Felder ausfüllen.';
      }
    } catch {
      $('#wa-scanline')?.classList.add('hidden');
      $('#wa-progress')?.classList.add('hidden');
      m.className = 'form-msg error';
      m.textContent = 'Bild konnte nicht gelesen werden.';
    }
  };
  // Aus dem Scan einen fertigen Gutschein bauen (für den Mehrfach-Upload)
  const extractVoucher = r => {
    let code = '';
    if (r.barcode) code = r.barcode.slice(0, 40);
    else if (r.text) {
      const kn = r.text.match(/karten\s*-?\s*(?:nr\.?|nummer)\D{0,30}?(\d[\d ]{6,28}\d)/i);
      code = (kn ? kn[1].replace(/\s+/g, '') : detectCode(r.text) || '').slice(0, 40);
    }
    const low = (r.text || '').toLowerCase();
    const pool = [...VENDOR_GRID.filter(x => x !== 'Anderer Gutschein'), ...Object.keys(BRAND_COLORS)];
    const hit = pool.find(k => k.length > 2 && low.includes(k.toLowerCase()));
    const vendor = hit ? (hit === hit.toLowerCase() ? hit[0].toUpperCase() + hit.slice(1) : hit) : '';
    const amount = r.amount ? parseFloat(r.amount.replace(',', '.')) : NaN;
    return { vendor, code, pin: (r.pin || '').slice(0, 16), amount: isNaN(amount) ? null : amount };
  };

  // Mehrere Gutscheine auf einmal: alle Bilder scannen, Duplikate überspringen,
  // nur die neuen und vollständig erkannten wandern in die Wallet
  const handleImageBatch = async files => {
    const m = $('#wa-ai-msg');
    $('#wa-drop-empty').classList.add('hidden');
    $('#wa-preview').classList.remove('hidden');
    $('#wa-progress').classList.remove('hidden');
    $('#wa-progress').classList.remove('done');
    $('#wa-scanline').classList.remove('hidden');
    const results = [];
    const fresh = [];
    for (let i = 0; i < files.length; i++) {
      m.className = 'form-msg';
      m.textContent = `Scanne Gutschein ${i + 1} von ${files.length} …`;
      scanProgress((i / files.length) * 100);
      let small = '';
      try {
        small = await readImageFile(files[i]);
        $('#wa-preview').src = small;
        const hiRes = await readImageFile(files[i], 2200, 0.9);
        const r = await analyzeWalletImage(hiRes, p => scanProgress(((i + p / 100) / files.length) * 100));
        const ex = extractVoucher(r);
        // Duplikat zuerst prüfen: dafür reichen PIN+Shop bzw. der Code schon aus,
        // auch wenn z. B. der Wert nicht lesbar war
        const dupe = findDupe(ex, fresh);
        if (dupe) { results.push({ ok: false, name: ex.vendor || dupe.vendor, warum: 'schon in der Wallet, übersprungen' }); continue; }
        if (!ex.vendor || ex.amount == null || !ex.pin) {
          const fehlt = [!ex.vendor && 'Shop', ex.amount == null && 'Wert', !ex.pin && 'PIN'].filter(Boolean).join(', ');
          results.push({
            ok: false, name: ex.vendor || files[i].name,
            warum: `${fehlt} nicht sicher erkannt, unten ergänzen`,
            fix: { ...ex, img: small, codeImg: r.codeImg || '' },
          });
          continue;
        }
        const v = {
          id: Math.random().toString(36).slice(2, 9),
          vendor: ex.vendor.slice(0, 30), code: ex.code, pin: ex.pin, end: '',
          amount: ex.amount, balance: ex.amount,
          img: r.codeImg ? '' : small, codeImg: r.codeImg || '', tx: [], added: Date.now(),
        };
        fresh.push(v);
        results.push({ ok: true, v });
      } catch {
        results.push({
          ok: false, name: files[i].name, warum: 'Bild nicht lesbar, unten von Hand ergänzen',
          fix: small ? { vendor: '', code: '', pin: '', amount: null, img: small, codeImg: '' } : null,
        });
      }
    }
    scanProgress(100);
    $('#wa-progress').classList.add('done');
    $('#wa-scanline').classList.add('hidden');
    // Speichern mit derselben Ehrlichkeit wie beim Einzel-Gutschein
    if (fresh.length) {
      if (state.token && !navigator.onLine) {
        m.className = 'form-msg error';
        m.textContent = 'Keine Internetverbindung, es wurde nichts gespeichert. Bitte mit Netz erneut versuchen.';
        return;
      }
      state.wallet.vouchers.unshift(...fresh);
      save('wallet', state.wallet);
      renderWallet();
      if (state.token) {
        m.className = 'form-msg';
        m.textContent = 'Sichere am Konto …';
        const ok = await syncWalletNow();
        if (!ok && walletSyncFatal) {
          // Server hat aktiv abgelehnt: behalten wäre sinnlos
          state.wallet.vouchers = state.wallet.vouchers.filter(x => !fresh.includes(x));
          save('wallet', state.wallet);
          renderWallet();
          m.className = 'form-msg error';
          m.textContent = 'NICHT gespeichert: ' + (walletSyncError || 'Der Server hat abgelehnt.');
          return;
        }
        if (!ok) {
          // Netzwackler: Gutscheine bleiben auf dem Gerät, Sicherung folgt automatisch
          showToast({
            title: 'Gespeichert, Sicherung folgt',
            text: 'Der Server war gerade nicht erreichbar. Die Gutscheine bleiben auf dem Gerät und werden automatisch nachgesichert.',
            iconName: 'warning',
          }, 8000);
        }
      }
    }
    // Übersicht: was ist drin, was wurde übersprungen und warum; Unvollständiges
    // wandert in die Ergänzen-Warteschlange statt verloren zu gehen
    const fixes = results.filter(res => res.fix).map(res => res.fix);
    $('#sheet-content').innerHTML = `
      <div class="sheet-title">Mehrere Gutscheine gescannt</div>
      <p class="muted" style="font-size:.86rem">${fresh.length} von ${files.length} neu in der Wallet.</p>
      ${results.map(res => res.ok
        ? `<div class="batch-row ok">${icon('check', 'icon icon-sm')} <span><b>${esc(res.v.vendor)}</b> · ${euroFmt(res.v.amount)} · PIN ${esc(res.v.pin)}</span></div>`
        : `<div class="batch-row bad">${icon('warning', 'icon icon-sm')} <span><b>${esc(res.name || 'Bild')}</b>: ${esc(res.warum)}</span></div>`).join('')}
      <div class="form-row" style="margin-top:16px">
        ${fixes.length ? `<button class="btn" id="wa-batch-fix">Fehlende ergänzen (${fixes.length})</button>` : ''}
        <button class="btn ${fixes.length ? 'btn-ghost' : ''}" id="wa-batch-done">Fertig</button>
        <button class="btn btn-ghost" id="wa-batch-more">Weitere hinzufügen</button>
      </div>`;
    $('#sheet-content').scrollTop = 0;
    $('#wa-batch-done').onclick = closeSheet;
    $('#wa-batch-more').onclick = () => openWalletAdd('voucher');
    $('#wa-batch-fix')?.addEventListener('click', () => {
      waFixQueue = fixes;
      waFixTotal = fixes.length;
      nextFixOrDone();
    });
    if (fresh.length) {
      playSfx('kaching'); buzz(35); moneyFlash('green'); billRain(Math.min(9, 4 + fresh.length));
      island(`${fresh.length} Gutschein${fresh.length > 1 ? 'e' : ''} gespeichert`);
    } else {
      playSfx('error'); buzz([60, 50, 60]); moneyFlash('red');
      const c = $('#sheet-content');
      if (c && !reducedMotion()) {
        c.classList.remove('shake-once'); void c.offsetWidth; c.classList.add('shake-once');
        setTimeout(() => c.classList.remove('shake-once'), 420);
      }
    }
  };

  const pickFiles = files => {
    const list = [...files].filter(f => f && f.type.startsWith('image/'));
    if (!list.length) return;
    if (addType === 'voucher' && list.length > 1) handleImageBatch(list);
    else handleImageFile(list[0]);
  };
  $('#wa-img').addEventListener('change', e => pickFiles(e.target.files));
  $('#wa-cam').addEventListener('change', e => handleImageFile(e.target.files[0]));
  // Strg+V: der globale Paste-Listener reicht das Bild hierher durch
  waHandleImage = handleImageFile;
  // Drag & Drop (Web): Bilder einfach in die Zone ziehen (auch mehrere)
  const drop = $('#wa-drop');
  ['dragover', 'dragenter'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', e => pickFiles(e.dataTransfer.files));

  $('#wa-save').addEventListener('click', async () => {
    const msg = $('#wa-msg');
    // Doppelklick-Schutz: solange gespeichert wird, ist der Button tabu, sonst
    // meldet der zweite Klick den EIGENEN Gutschein als Duplikat
    if (waSaving) return;
    // Ohne Netz kein "gespeichert"-Theater: der Gutschein wäre beim nächsten
    // App-Start weg (PWA-Speicher ist flüchtig), also ehrlich blocken
    if (state.token && !navigator.onLine) {
      msg.className = 'form-msg error';
      msg.textContent = 'Keine Internetverbindung. Bitte mit Netz speichern, damit nichts verloren geht.';
      return;
    }
    let savedItem = null, savedList = null;
    if (addType === 'voucher') {
      const amount = parseFloat($('#wa-amount').value.replace(',', '.'));
      const v = {
        id: Math.random().toString(36).slice(2, 9),
        vendor: currentVendor().slice(0, 30),
        code: $('#wa-code').value.trim().slice(0, 40),
        pin: $('#wa-pin').value.trim().slice(0, 16),
        end: $('#wa-end').value || '',
        amount: isNaN(amount) ? null : amount,
        balance: isNaN(amount) ? null : amount,
        // Originalfoto nur behalten, wenn es keinen Kassen-Zuschnitt gibt (Payload-Diät)
        img: addCodeImg ? '' : addImg, codeImg: addCodeImg, tx: [], added: Date.now(),
      };
      // Pflicht: Shop, Wert, PIN (Code ist optional, fehlende Felder leuchten rot)
      $('#wa-amount').classList.toggle('err', v.amount == null);
      $('#wa-pin').classList.toggle('err', !v.pin);
      $('#wa-vendor-grid')?.classList.toggle('err', !v.vendor);
      if (!v.vendor || v.amount == null || !v.pin) {
        msg.className = 'form-msg error';
        msg.textContent = !v.vendor ? 'Bitte einen Shop auswählen.' : 'Bitte die rot markierten Pflichtfelder ausfüllen.';
        return;
      }
      // Doppelte Gutscheine abfangen: gleiche PIN beim gleichen Shop oder gleicher Code
      const dupe = findDupe(v);
      if (dupe) {
        dupeReject(`Diesen Gutschein hast du schon in der Wallet (${esc(dupe.vendor)}, gleiche ${dupe.code === v.code && v.code ? 'Kartennummer' : 'PIN'}).`);
        return;
      }
      state.wallet.vouchers.unshift(v);
      savedItem = v; savedList = state.wallet.vouchers;
    } else {
      const c = {
        id: Math.random().toString(36).slice(2, 9),
        name: currentCard().slice(0, 30),
        number: $('#wa-cnumber').value.trim().slice(0, 30),
        img: addCodeImg ? '' : addImg, codeImg: addCodeImg, added: Date.now(),
      };
      $('#wa-cnumber').classList.toggle('err', !c.number);
      $('#wa-card-grid')?.classList.toggle('err', !c.name);
      if (!c.name || !c.number) { msg.className = 'form-msg error'; msg.textContent = !c.name ? 'Bitte eine Karte auswählen.' : 'Bitte die Kartennummer eintragen.'; return; }
      state.wallet.cards.unshift(c);
      savedItem = c; savedList = state.wallet.cards;
    }
    save('wallet', state.wallet);
    renderWallet();
    // Erst wenn der Server es hat, gilt es als voll gesichert; unterwegs immer
    // sichtbar machen, dass gerade gespeichert wird
    if (state.token) {
      waSaving = true;
      setBtnLoading($('#wa-save'), true);
      msg.className = 'form-msg';
      msg.textContent = 'Speichere und sichere am Konto …';
      const ok = await syncWalletNow();
      waSaving = false;
      setBtnLoading($('#wa-save'), false);
      if (!ok && walletSyncFatal) {
        // Der Server hat aktiv abgelehnt (z. B. zu groß): behalten wäre sinnlos
        const idx = savedList.indexOf(savedItem);
        if (idx >= 0) savedList.splice(idx, 1);
        save('wallet', state.wallet);
        renderWallet();
        msg.className = 'form-msg error';
        msg.textContent = 'NICHT gespeichert: ' + (walletSyncError || 'Der Server hat abgelehnt.');
        return;
      }
      if (!ok) {
        // Netzwackler/Timeout: Gutschein BLEIBT auf dem Gerät, der Hintergrund-Sync
        // holt das Sichern nach — nichts wird still weggeworfen
        closeSheet();
        playSfx('kaching'); buzz(35);
        showToast({
          title: 'Gespeichert, Sicherung folgt',
          text: 'Der Server war gerade nicht erreichbar. Der Gutschein bleibt auf dem Gerät und wird automatisch nachgesichert.',
          iconName: 'warning',
        }, 8000);
        return;
      }
    }
    closeSheet();
    // Ka-ching! Neues Guthaben in der Wallet
    playSfx('kaching');
    buzz(35);
    moneyFlash('green');
    billRain(7);
    island('In der Wallet gespeichert');
    // Warten noch unvollständige Gutscheine aus dem Mehrfach-Upload? Direkt weiter
    nextFixOrDone();
  });
  openSheetShell();
}

// ---- Detail: Guthaben, Abbuchen/Aufladen mit Notiz, Verlauf mit Revert
function openVoucherSheet(id, animFrom) {
  const v = state.wallet.vouchers.find(x => x.id === id);
  if (!v) return;
  state.sheetMode = 'wallet-detail';
  const expired = v.end && Date.parse(v.end + 'T23:59:59') < Date.now();
  $('#sheet-content').innerHTML = `
    <div class="offer-head">
      <span class="brand-chip" style="--bc:${brandColor(v.vendor)}">${esc(brandInitials(v.vendor))}</span>
      <div class="offer-brand">
        <div class="offer-merchant">${esc(v.vendor)}</div>
        <div class="offer-cat">${v.end ? (expired ? 'abgelaufen' : 'gültig bis ' + new Date(v.end).toLocaleDateString('de-DE')) : 'Gutschein'}</div>
      </div>
      <button class="fav-remove" id="wv-close" aria-label="Schließen">${icon('x', 'icon icon-sm')}</button>
    </div>
    ${v.balance != null ? `<div class="balance-big" style="margin-top:12px"><span id="wv-balance">${euroFmt(v.balance)}</span>
      ${v.amount != null && v.amount !== v.balance ? `<span class="stars-count">von ${euroFmt(v.amount)}</span>` : ''}</div>` : ''}
    ${v.code ? `<div class="tx-row" style="margin-top:12px">
      <span class="wallet-code" style="flex:1">${esc(v.code)}</span>
      <button class="btn btn-small" data-copy-txt="${esc(v.code)}">Code kopieren</button>
    </div>` : ''}
    ${v.pin ? `<div class="tx-row"><span class="wallet-code" style="flex:1">PIN: ${esc(v.pin)}</span>
      <button class="btn btn-small btn-ghost" data-copy-txt="${esc(v.pin)}">PIN kopieren</button></div>` : ''}
    ${v.codeImg ? `<img class="wallet-code-img" src="${v.codeImg}" alt="Code für die Kasse">`
      : v.img ? `<img class="wallet-img" src="${v.img}" alt="QR/Barcode">` : ''}
    ${v.balance != null ? `
    <div class="sheet-section">
      <h3>Betrag abbuchen / aufladen</h3>
      <div class="amt-presets">
        ${[2, 5, 10].map(n => `<button class="chip" data-preset="${n}">${n} €</button>`).join('')}
        <button class="chip" data-preset="max">Max (${euroFmt(v.balance)})</button>
      </div>
      <div class="form-row">
        <input id="wv-amt" class="input" inputmode="decimal" placeholder="Betrag (€)">
        <input id="wv-note" class="input" maxlength="60" placeholder="Wofür? (Notiz)">
      </div>
      <div class="form-row">
        <button id="wv-sub" class="btn btn-book-sub">− Abbuchen</button>
        <button id="wv-addamt" class="btn btn-book-add">+ Aufladen</button>
        <span id="wv-msg" class="form-msg"></span>
      </div>
    </div>` : ''}
    ${(v.tx || []).length ? `
    <div class="sheet-section">
      <h3>Verlauf</h3>
      ${v.tx.map(t => `
      <div class="tx-row ${t.reverted ? 'reverted' : ''}">
        <span class="tx-amt ${t.amt < 0 ? 'minus' : 'plus'}">${t.amt < 0 ? '−' : '+'}${euroFmt(Math.abs(t.amt))}</span>
        <span class="tx-note">${esc(t.note || (t.amt < 0 ? 'Abbuchung' : 'Aufladung'))}
          <small>${new Date(t.ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</small></span>
        ${!t.reverted ? `<button class="btn btn-small btn-ghost" data-revert="${esc(t.id)}">Rückgängig</button>` : ''}
      </div>`).join('')}
    </div>` : ''}
    ${v.balance != null && v.balance > 0 ? `
    <div class="sheet-section">
      <button class="btn btn-ghost" id="wv-gift" style="width:100%">${icon('gift', 'icon icon-sm')}&nbsp;An Freund verschenken</button>
      <div id="wv-gift-pick" class="hidden"></div>
    </div>` : ''}
    ${v.giftFrom ? `<p class="added-line">${icon('gift', 'icon icon-sm')} Geschenk von @${esc(v.giftFrom)}</p>` : ''}
    ${v.added ? `<p class="added-line">Hinzugefügt am ${new Date(v.added).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })} um ${new Date(v.added).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr</p>` : ''}
    ${(v.balance == null || v.balance <= 0)
      ? '<button class="btn btn-danger" id="wv-del" style="margin-top:14px">Gutschein löschen</button>' : ''}`;

  $('#sheet-content').querySelectorAll('[data-copy-txt]').forEach(b => b.addEventListener('click', () => copyText(b.dataset.copyTxt)));
  $('#wv-close').addEventListener('click', closeSheet);
  // Verschenken: Freund auswählen, bestätigen, der Gutschein zieht komplett um
  $('#wv-gift')?.addEventListener('click', () => {
    const pick = $('#wv-gift-pick');
    if (!pick.classList.contains('hidden')) { pick.classList.add('hidden'); return; }
    const friends = myProfile?.friends || [];
    if (!friends.length) {
      pick.innerHTML = '<p class="muted" style="font-size:.82rem; margin-top:8px">Du hast noch keine Freunde in kumulio. Verschenken geht nur an Freunde.</p>';
      pick.classList.remove('hidden');
      return;
    }
    pick.innerHTML = '<p class="muted" style="font-size:.8rem; margin:8px 0 6px">An wen soll der Gutschein gehen?</p>'
      + friends.map(f => `<button class="btn btn-small btn-ghost" data-gift-to="${esc(f)}" style="margin:0 6px 6px 0">@${esc(f)}</button>`).join('');
    pick.classList.remove('hidden');
    pick.querySelectorAll('[data-gift-to]').forEach(b => b.addEventListener('click', async () => {
      const to = b.dataset.giftTo;
      if (!await askConfirm(`Deinen ${esc(v.vendor)}-Gutschein${v.balance != null ? ` (${euroFmt(v.balance)})` : ''} an @${esc(to)} verschenken? Er verschwindet dann aus deiner Wallet.`, { okLabel: 'Ja, verschenken' })) return;
      setBtnLoading(b, true);
      try {
        // Erst sichern, damit der Server den Gutschein garantiert kennt
        await syncWalletNow();
        await api('/api/gift/send', { method: 'POST', body: JSON.stringify({ to, id: v.id }) });
        state.wallet.vouchers = state.wallet.vouchers.filter(x => x.id !== v.id);
        save('wallet', state.wallet);
        renderWallet();
        closeSheet();
        playSfx('kaching'); buzz(35); moneyFlash('green'); billRain(6);
        island(`Verschenkt an @${to}`);
      } catch (e) {
        setBtnLoading(b, false);
        island(e.message);
      }
    }));
  });
  // Löschen gibt es nur bei aufgebrauchten Gutscheinen, immer mit Rückfrage
  $('#wv-del')?.addEventListener('click', async () => {
    if (v.balance != null && v.balance > 0) return;
    if (!await askConfirm(`Bist du sicher, dass du den ${esc(v.vendor)}-Gutschein löschen willst?`)) return;
    state.wallet.vouchers = state.wallet.vouchers.filter(x => x.id !== id);
    saveWallet(); closeSheet(); island('Gutschein gelöscht');
  });
  // Schnellbeträge: 2/5/10 € oder alles auf einmal
  $('#sheet-content').querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
    $('#wv-amt').value = b.dataset.preset === 'max'
      ? String(v.balance).replace('.', ',')
      : b.dataset.preset;
    $('#wv-amt').focus();
  }));
  const book = sign => {
    const amt = parseFloat($('#wv-amt').value.replace(',', '.'));
    const msg = $('#wv-msg');
    if (isNaN(amt) || amt <= 0) { msg.className = 'form-msg error'; msg.textContent = 'Betrag angeben.'; return; }
    // Nie ins Minus: mehr als das Restguthaben lässt sich nicht abbuchen
    if (sign < 0 && amt > v.balance + 0.001) {
      msg.className = 'form-msg error';
      msg.textContent = `Nur noch ${euroFmt(v.balance)} drauf, mehr geht nicht.`;
      return;
    }
    const before = v.balance;
    v.tx = v.tx || [];
    v.tx.unshift({ id: Math.random().toString(36).slice(2, 9), amt: sign * amt, note: $('#wv-note').value.trim().slice(0, 60), ts: Date.now() });
    v.balance = Math.round((v.balance + sign * amt) * 100) / 100;
    saveWallet();
    openVoucherSheet(id, before);
    // Spielgefühl: Geld raus = Apple-Pay-Sound, rotes Aufleuchten, kurzer Shake;
    // Geld rein = Ka-ching, grünes Aufleuchten, Geldscheine
    if (sign < 0) {
      playSfx('pay'); buzz([45, 40, 45]); moneyFlash('red');
      // Ein kurzer, kleiner Ruckler am Inhalt, nicht am Sheet selbst
      // (das ist per translateX(-50%) zentriert, ein Transform-Shake würde es zur Seite reißen)
      const c = $('#sheet-content');
      if (c && !reducedMotion()) {
        c.classList.remove('shake-once'); void c.offsetWidth; c.classList.add('shake-once');
        setTimeout(() => c.classList.remove('shake-once'), 420);
      }
    } else {
      playSfx('kaching'); buzz(35); moneyFlash('green'); billRain(5);
    }
    showToast({
      title: sign < 0 ? 'Abbuchung gespeichert' : 'Aufladung gespeichert',
      text: `Restguthaben: ${euroFmt(v.balance)}`,
      success: true,
    }, 3500);
  };
  $('#wv-sub')?.addEventListener('click', () => book(-1));
  $('#wv-addamt')?.addEventListener('click', () => book(1));
  // Guthaben zählt sichtbar vom alten zum neuen Stand
  if (animFrom != null && v.balance != null) animateNumber($('#wv-balance'), animFrom, v.balance);
  $('#sheet-content').querySelectorAll('[data-revert]').forEach(b => b.addEventListener('click', () => {
    const t = v.tx.find(x => x.id === b.dataset.revert);
    if (!t || t.reverted) return;
    const before = v.balance;
    t.reverted = true;
    v.balance = Math.round((v.balance - t.amt) * 100) / 100;
    saveWallet();
    openVoucherSheet(id, before);
    island('Buchung rückgängig gemacht');
  }));
  openSheetShell();
}

function openCardSheet(id) {
  const c = state.wallet.cards.find(x => x.id === id);
  if (!c) return;
  state.sheetMode = 'wallet-detail';
  $('#sheet-content').innerHTML = `
    <div class="offer-head">
      <span class="brand-chip" style="--bc:${brandColor(c.name)}">${esc(brandInitials(c.name))}</span>
      <div class="offer-brand"><div class="offer-merchant">${esc(c.name)}</div><div class="offer-cat">Sparkarte</div></div>
      <button class="fav-remove" id="wc-close" aria-label="Schließen">${icon('x', 'icon icon-sm')}</button>
    </div>
    <div class="tx-row" style="margin-top:12px">
      <span class="wallet-code" style="flex:1">${esc(c.number)}</span>
      <button class="btn btn-small" data-copy-txt="${esc(c.number)}">Kopieren</button>
    </div>
    ${c.codeImg ? `<img class="wallet-code-img" src="${c.codeImg}" alt="Code für die Kasse">`
      : c.img ? `<img class="wallet-img" src="${c.img}" alt="QR/Barcode">`
      : '<p class="muted" style="margin-top:10px; font-size:.82rem">Tipp: Screenshot vom Karten-Barcode anhängen (beim Anlegen), dann kannst du ihn an der Kasse scannen lassen.</p>'}
    <button class="btn btn-danger" id="wc-del" style="margin-top:18px">Karte löschen</button>`;
  $('#sheet-content').querySelectorAll('[data-copy-txt]').forEach(b => b.addEventListener('click', () => copyText(b.dataset.copyTxt)));
  $('#wc-close').addEventListener('click', closeSheet);
  $('#wc-del').addEventListener('click', async () => {
    if (!await askConfirm(`Bist du sicher, dass du die ${esc(c.name)}-Karte löschen willst?`)) return;
    state.wallet.cards = state.wallet.cards.filter(x => x.id !== id);
    saveWallet(); closeSheet(); island('Karte gelöscht');
  });
  openSheetShell();
}

// Drei Wallet-Bereiche: Gutscheine, Sparkarten (App-Raster), Coupons
let walletTab = 'gutscheine';
function updateWalletTab(anim) {
  const coupons = walletTab === 'coupons';
  const cards = walletTab === 'karten';
  const gated = !state.token && !coupons;
  $('#wallet-gate').classList.toggle('hidden', !gated);
  $('#wallet-content').classList.toggle('hidden', gated || coupons || cards);
  $('#cards-content').classList.toggle('hidden', gated || !cards);
  $('#coupons-content').classList.toggle('hidden', !coupons);
  if (coupons) renderCoupons($('#coupons-content'));
  if (!walletTab.startsWith('gutscheine')) $('#wallet-mini')?.classList.remove('show');
  if (anim) {
    const host = coupons ? $('#coupons-content') : cards ? $('#cards-content') : $('#wallet-content');
    host.classList.add('enter-drop');
    setTimeout(() => host.classList.remove('enter-drop'), 500);
  }
}

function renderWallet() {
  // Wallet nur mit Profil: Gast sieht die Anmelde-Sperre (Coupons bleiben offen)
  updateWalletTab(false);
  if (!state.token) return;

  const allActive = state.wallet.vouchers.filter(v => v.balance == null || v.balance > 0);
  const used = state.wallet.vouchers.filter(v => v.balance != null && v.balance <= 0);

  // Suche (Shop, Code, PIN, Buchungs-Notizen) + Filter-Chips
  const q = (state.walletQuery || '').trim().toLowerCase();
  const vMatch = v => !q
    || v.vendor.toLowerCase().includes(q)
    || v.code.toLowerCase().includes(q)
    || (v.pin || '').toLowerCase().includes(q)
    || (v.tx || []).some(t => (t.note || '').toLowerCase().includes(q));
  // Filter = die Shops, die man wirklich besitzt (dynamische Chips)
  const fMatch = v => !state.walletFilter || state.walletFilter === 'alle'
    || v.vendor.toLowerCase() === state.walletFilter.toLowerCase();
  let active = allActive.filter(v => vMatch(v) && fMatch(v));
  // Basis-Sortierung: WIRKLICH neueste zuerst (nach Hinzugefügt-Datum, nicht
  // nach Speicher-Reihenfolge – der Konto-Sync hängt gemergte Einträge hinten an)
  active = [...active].sort((a, b) => (b.added || 0) - (a.added || 0));
  // Sortierung übers Filter-Icon
  const ws = state.walletSort || '';
  if (ws === 'aelteste') active.reverse();
  if (ws === 'hoch') active = [...active].sort((a, b) => (b.balance || 0) - (a.balance || 0));
  if (ws === 'niedrig') active = [...active].sort((a, b) => (a.balance || 0) - (b.balance || 0));
  if (ws === 'bis10') active = active.filter(v => (v.balance || 0) <= 10);
  if (ws === 'ab25') active = active.filter(v => (v.balance || 0) >= 25);
  if (ws === 'ab50') active = active.filter(v => (v.balance || 0) >= 50);
  // Wert-Chips (10/25/50/100) neben dem Untertitel: erscheinen bei aktivem Markt-Filter
  const marketOn = state.walletFilter && state.walletFilter !== 'alle';
  const valHost = $('#wallet-val-chips');
  if (valHost) {
    valHost.innerHTML = marketOn
      ? [10, 25, 50, 100].map(n =>
        `<button class="chip val-chip ${state.walletVal === n ? 'active' : ''}" data-wval="${n}">${n}</button>`).join('')
      : '';
    valHost.querySelectorAll('[data-wval]').forEach(b => b.onclick = () => {
      const n = Number(b.dataset.wval);
      state.walletVal = state.walletVal === n ? 0 : n;
      renderWallet();
    });
  }
  if (marketOn && state.walletVal) {
    active = active.filter(v => (v.amount ?? v.balance ?? 0) === state.walletVal);
  }
  // Vendor-Chips neu aufbauen
  const vendors = [...new Set(allActive.map(v => v.vendor))];
  const vf = $('#wallet-vendor-filters');
  if (vf) {
    vf.innerHTML = [`<button class="chip ${!state.walletFilter || state.walletFilter === 'alle' ? 'active' : ''}" data-wvf="alle">Alle</button>`,
      ...vendors.map(vn => `<button class="chip ${state.walletFilter === vn ? 'active' : ''}" data-wvf="${esc(vn)}">${brandChipHtml(vn)}<span class="chip-label">${esc(vn)}</span></button>`)].join('');
    vf.querySelectorAll('[data-wvf]').forEach(b => b.onclick = () => {
      state.walletFilter = b.dataset.wvf === 'alle' ? '' : b.dataset.wvf;
      state.walletVal = 0;
      renderWallet();
    });
  }

  // Kontostand: Summe ALLER Restguthaben (unabhängig von Suche/Filter), zählt animiert
  const total = Math.round(allActive.reduce((s, v) => s + (v.balance || 0), 0) * 100) / 100;
  animateNumber($('#wallet-total'), renderWallet.lastTotal, total);
  renderWallet.lastTotal = total;
  $('#wallet-total-sub').textContent = allActive.length
    ? `über ${allActive.length} Gutschein${allActive.length > 1 ? 'e' : ''}`
    : 'noch keine Gutscheine mit Guthaben';

  // Spar-Rang: je mehr Guthaben, desto edler die Karte + Fortschritt zur nächsten Stufe
  const rank = rankFor(total);
  const card = $('#balance-card');
  if (card) {
    card.className = 'card balance-card tier-' + rank.tier;
    $('#wallet-rank').textContent = rank.name;
    if (rank.next) {
      const span = rank.next.min - rank.min;
      $('#wallet-rank-fill').style.width = Math.round(((total - rank.min) / span) * 100) + '%';
      $('#wallet-rank-next').textContent = `${euroFmt(rank.next.min - total)} bis ${rank.next.name}`;
    } else {
      $('#wallet-rank-fill').style.width = '100%';
      $('#wallet-rank-next').textContent = 'Höchste Stufe erreicht';
    }
  }
  // Gutschein-Karte: der Hintergrund füllt sich nach Restguthaben (rechts wird
  // durchsichtig, was schon ausgegeben ist), PIN steht unter der Kartennummer
  const vCard = v => {
    const pct = v.amount ? Math.max(0, Math.min(100, Math.round(((v.balance || 0) / v.amount) * 100))) : 100;
    return `
    <div class="wallet-card has-fill" data-wv="${esc(v.id)}" style="--bc:${brandColor(v.vendor)}; --fill:${pct}%">
      <div class="wallet-card-head">
        ${brandChipHtml(v.vendor)}
        <span class="wallet-card-name">${esc(v.vendor)}</span>
        ${v.balance != null ? `<span class="wallet-card-balance">${euroFmt(v.balance)}</span>` : ''}
      </div>
      <div class="wallet-card-sub">
        <span>${esc(v.code || 'Ohne Code')}</span>
        ${v.giftFrom ? `<span class="pill">${icon('gift', 'icon icon-sm')} von @${esc(v.giftFrom)}</span>` : ''}
        ${v.end ? `<span class="pill">bis ${new Date(v.end).toLocaleDateString('de-DE')}</span>` : ''}
      </div>
      ${v.pin ? `<div class="wallet-card-pin">PIN ${esc(v.pin)}</div>` : ''}
      ${v.added ? `<span class="wallet-card-date">${new Date(v.added).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>` : ''}
    </div>`;
  };

  $('#voucher-list').innerHTML =
    active.length ? active.map(vCard).join('')
      : `<div class="status">${q || marketOn || state.walletVal
        ? 'Kein Gutschein passt zu Suche/Filter.'
        : 'Noch keine Gutscheine, leg oben den ersten an.'}</div>`;
  $('#voucher-used').innerHTML = used.map(vCard).join('') || '<div class="status">Nichts aufgebraucht.</div>';
  $('#used-count').textContent = used.length ? `(${used.length})` : '';

  // Sparkarten als App-Raster mit Logos, eigene Suche, per Ziehen sortierbar
  const hasPayback = state.wallet.cards.some(c => /payback/i.test(c.name));
  const cq = (state.cardQuery || '').trim().toLowerCase();
  const cardsShown = state.wallet.cards.filter(c => !cq
    || c.name.toLowerCase().includes(cq) || c.number.toLowerCase().includes(cq));
  $('#cardw-list').innerHTML = cardsShown.map(c => `
    <button class="app-tile" data-wc="${esc(c.id)}" style="--bc:${brandColor(c.name)}">
      ${brandChipHtml(c.name)}
      <span class="app-tile-name">${esc(c.name)}</span>
    </button>`).join('')
    + `<button class="app-tile app-tile-add" data-wadd="card">
      <span class="app-add-plus">${icon('plus')}</span>
      <span class="app-tile-name">Hinzufügen</span>
    </button>`
    + (!hasPayback ? `
    <button class="app-tile app-tile-add" data-wadd-prefill="Payback" style="--bc:${brandColor('payback')}">
      ${brandChipHtml('Payback')}
      <span class="app-tile-name">Payback verbinden</span>
    </button>` : '');
  makeGridSortable($('#cardw-list'), '[data-wc]', order => {
    // Nur ungefiltert umsortieren, sonst würde die Reihenfolge lügen
    if ((state.cardQuery || '').trim()) return;
    const pos = id => { const i = order.indexOf(id); return i < 0 ? 999 : i; };
    state.wallet.cards.sort((a, b) => pos(a.id) - pos(b.id));
    save('wallet', state.wallet);
    if (state.token) syncWalletNow();
  }, el => el.dataset.wc);

  // Mini-Guthaben unten aktualisieren
  const mini = $('#wallet-mini-total');
  if (mini) mini.textContent = euroFmt(total) || '0,00 €';
  renderSyncBadge();

  // Suchergebnisse gleiten gestaffelt herein
  document.querySelectorAll('#voucher-list .wallet-card').forEach((el, i) => {
    el.classList.add('anim-item');
    el.style.animationDelay = Math.min(i * 45, 300) + 'ms';
  });
  $('#view-wallet').querySelectorAll('[data-wv]').forEach(el => el.onclick = () => openVoucherSheet(el.dataset.wv));
  $('#view-wallet').querySelectorAll('[data-wc]').forEach(el => el.onclick = () => openCardSheet(el.dataset.wc));
  $('#view-wallet').querySelectorAll('[data-wadd]').forEach(el => el.onclick = () => openWalletAdd(el.dataset.wadd));
  $('#view-wallet').querySelectorAll('[data-wadd-prefill]').forEach(el => el.onclick = () => openWalletAdd('card', el.dataset.waddPrefill));
}

// App-Raster per Gedrückthalten sortieren (Maus + Touch über Pointer Events)
function makeGridSortable(grid, tileSel, onReorder, idOf) {
  if (!grid || grid.dataset.sortable) return;
  grid.dataset.sortable = '1';
  let lifted = null, holdTimer = null, startX = 0, startY = 0;
  grid.addEventListener('pointerdown', e => {
    const tile = e.target.closest(tileSel);
    if (!tile) return;
    startX = e.clientX; startY = e.clientY;
    holdTimer = setTimeout(() => {
      lifted = tile;
      tile.classList.add('lifting');
      buzz(15);
      try { tile.setPointerCapture(e.pointerId); } catch { }
    }, 320);
  });
  grid.addEventListener('pointermove', e => {
    if (!lifted) {
      // Wackeln vor dem Anheben bricht den Timer ab (Scrollen bleibt möglich)
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 12) clearTimeout(holdTimer);
      return;
    }
    e.preventDefault();
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest(tileSel);
    if (under && under !== lifted && under.parentElement === grid) {
      const kids = [...grid.children];
      grid.insertBefore(lifted, kids.indexOf(under) > kids.indexOf(lifted) ? under.nextSibling : under);
    }
  });
  const drop = () => {
    clearTimeout(holdTimer);
    if (!lifted) return;
    lifted.classList.remove('lifting');
    lifted = null;
    onReorder([...grid.querySelectorAll(tileSel)].map(idOf));
  };
  grid.addEventListener('pointerup', drop);
  grid.addEventListener('pointercancel', drop);
}

// Wallet-Suche + Untertabs Gutscheine/Sparkarten/Coupons + Sortier-Menü
$('#wallet-search')?.addEventListener('input', e => {
  state.walletQuery = e.target.value;
  renderWallet();
});
$('#cardw-search')?.addEventListener('input', e => {
  state.cardQuery = e.target.value;
  renderWallet();
});
document.querySelectorAll('[data-wtab]').forEach(b => b.addEventListener('click', () => {
  walletTab = b.dataset.wtab;
  document.querySelectorAll('[data-wtab]').forEach(x => x.classList.toggle('active', x === b));
  updateWalletTab(true);
}));
// Hinzufügen ganz oben, ohne Scrollen
$('#wallet-add-top')?.addEventListener('click', () => openWalletAdd('voucher'));

// ---- Gesamtguthaben-Karte: antippen dreht zur Statistik (Monat/Jahr/Gesamt)
let statsRange = 'monat';
function walletStats(range) {
  const now = new Date();
  const inRange = ts => {
    if (!ts) return range === 'gesamt';
    const d = new Date(ts);
    if (range === 'monat') return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    if (range === 'jahr') return d.getFullYear() === now.getFullYear();
    return true;
  };
  let added = 0, spent = 0;
  state.wallet.vouchers.forEach(v => {
    if (v.amount != null && inRange(v.added)) added += v.amount;
    (v.tx || []).forEach(t => {
      if (t.reverted || !inRange(t.ts)) return;
      if (t.amt > 0) added += t.amt; else spent += -t.amt;
    });
  });
  return { added: Math.round(added * 100) / 100, spent: Math.round(spent * 100) / 100 };
}
function renderWalletStats(range) {
  statsRange = range;
  const s = walletStats(range);
  $('#balance-back').innerHTML = `
    <div class="offer-cat">Statistik</div>
    <div class="stat-ranges">
      ${[['monat', 'Monat'], ['jahr', 'Jahr'], ['gesamt', 'Gesamt']].map(([r, l]) =>
        `<button class="chip ${r === range ? 'active' : ''}" data-strange="${r}">${l}</button>`).join('')}
    </div>
    <div class="stat-row"><span>Guthaben hinzugefügt</span><b class="tx-amt plus">+${euroFmt(s.added) || '0,00 €'}</b></div>
    <div class="stat-row"><span>Ausgegeben</span><b class="tx-amt minus">−${euroFmt(s.spent) || '0,00 €'}</b></div>
    <div class="flip-hint">${icon('arrow-back', 'icon icon-sm')} Antippen zum Zurückdrehen</div>`;
  $('#balance-back').querySelectorAll('[data-strange]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    renderWalletStats(b.dataset.strange);
  });
}
let balanceFlipped = false;
let flipBusy = false;
$('#balance-flip')?.addEventListener('click', () => {
  if (flipBusy) return;
  balanceFlipped = !balanceFlipped;
  if (balanceFlipped) renderWalletStats(statsRange);
  buzz(15);
  const swap = () => {
    $('#balance-card').classList.toggle('hidden', balanceFlipped);
    $('#balance-back').classList.toggle('hidden', !balanceFlipped);
  };
  if (reducedMotion() || !$('#flip-inner').animate) { swap(); return; }
  // Eine DURCHGEHENDE Drehung: bis 90° beschleunigen, Seite tauschen, von -90°
  // in derselben Richtung weiterdrehen und weich ausrollen. Die Container-Höhe
  // wird mitanimiert, damit beim Seitenwechsel nichts springt.
  flipBusy = true;
  const inner = $('#flip-inner');
  const flip = $('#balance-flip');
  flip.style.height = flip.offsetHeight + 'px';
  const a1 = inner.animate(
    [{ transform: 'perspective(900px) rotateY(0deg)' }, { transform: 'perspective(900px) rotateY(90deg)' }],
    { duration: 230, easing: 'cubic-bezier(.55, 0, .8, .5)', fill: 'forwards' });
  a1.onfinish = () => {
    swap();
    const target = balanceFlipped ? $('#balance-back') : $('#balance-card');
    flip.style.transition = 'height .32s cubic-bezier(.2, .8, .3, 1)';
    flip.style.height = target.offsetHeight + 'px';
    const a2 = inner.animate(
      [{ transform: 'perspective(900px) rotateY(-90deg)' }, { transform: 'perspective(900px) rotateY(0deg)' }],
      { duration: 340, easing: 'cubic-bezier(.16, .6, .3, 1)', fill: 'forwards' });
    a2.onfinish = () => {
      a1.cancel(); a2.cancel();
      flip.style.transition = ''; flip.style.height = '';
      flipBusy = false;
    };
  };
});

// ---- Mini-Guthaben: erscheint über dem Menü, sobald die große Karte aus dem Bild ist
if ('IntersectionObserver' in window && $('#balance-flip')) {
  // Zählt schon als "aus dem Bild", wenn nur noch ein Rest der Karte zu sehen ist
  new IntersectionObserver(([e]) => {
    const show = state.activeView === 'wallet' && walletTab === 'gutscheine'
      && !!state.token && e.intersectionRatio < 0.25;
    $('#wallet-mini').classList.toggle('show', show);
  }, { threshold: [0, 0.25, 0.5] }).observe($('#balance-flip'));
}
$('#wallet-mini')?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
$('#wallet-sort-btn')?.addEventListener('click', () => {
  const menu = $('#wallet-sort-menu');
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
  const OPTIONS = [
    ['', 'Neueste zuerst'], ['aelteste', 'Älteste zuerst'],
    ['hoch', 'Guthaben: hoch zu niedrig'], ['niedrig', 'Guthaben: niedrig zu hoch'],
    ['bis10', 'Bis 10 €'], ['ab25', 'Ab 25 €'], ['ab50', 'Ab 50 €'],
  ];
  menu.innerHTML = OPTIONS.map(([v, l]) =>
    `<button class="cmd-row ${(state.walletSort || '') === v ? 'on' : ''}" data-wsort="${v}"><span>${l}</span></button>`).join('');
  menu.classList.remove('hidden');
  menu.querySelectorAll('[data-wsort]').forEach(x => x.onclick = () => {
    state.walletSort = x.dataset.wsort;
    menu.classList.add('hidden');
    renderWallet();
  });
});

$('#btn-home').addEventListener('click', () => {
  state.activeChip = 'fuer-dich';
  renderChipbar();
  renderFeed();
  if (state.activeView !== 'feed') switchView('feed');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ---------------- Admin direkt in der App: Deals posten ----------------

function refreshAdminUi() {
  // Deal posten schwebt unten mittig über dem Menü (nur im Feed, nur Admin)
  const b = $('#btn-admin-post');
  if (!b) return;
  if (b.parentElement !== document.body) {
    b.classList.add('admin-fab');
    document.body.appendChild(b);
  }
  b.classList.toggle('hidden', state.role !== 'admin' || state.activeView !== 'feed');
}
function openAdminPost(edit) {
  state.sheetMode = 'admin-post';
  const chs = state.channels.filter(c => c.type === 'community');
  // Beim Bearbeiten: Link aus dem Textende fischen, Rest ist die Beschreibung
  let editText = edit ? (edit.rawText ?? edit.excerpt ?? '') : '';
  let editLink = '';
  if (edit) {
    const m = editText.match(/\n?(https?:\/\/\S+)\s*$/);
    if (m) { editLink = m[1]; editText = editText.slice(0, m.index).trim(); }
  }
  let kind = edit?.kind || 'rabatt';
  $('#sheet-content').innerHTML = `
    <div class="sheet-title">${edit ? 'Deal bearbeiten' : 'Deal posten'} (Redaktion)</div>
    <label class="f-label">Art des Deals</label>
    <div class="form-row">
      <button class="chip ${kind === 'rabatt' ? 'active' : ''}" data-apkind="rabatt">Rabattaktion</button>
      <button class="chip ${kind === 'gutschein' ? 'active' : ''}" data-apkind="gutschein">Gutschein &amp; Aktion</button>
    </div>
    <label class="f-label">Kanal <span class="req">*</span></label>
    <select id="ap-channel" class="input">${chs.map(c => `<option value="${esc(c.slug)}" ${edit?.channel === c.slug ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    <label class="f-label">Deal-Link</label>
    <div class="form-row">
      <input id="ap-link" class="input" placeholder="https://…" style="flex:1" value="${esc(editLink)}">
      <button id="ap-extract" class="btn btn-small btn-ghost">Auslesen</button>
    </div>
    <label class="f-label">Titel <span class="req">*</span></label>
    <input id="ap-title" class="input" maxlength="90" value="${esc(edit?.title || '')}">
    <label class="f-label">Beschreibung</label>
    <textarea id="ap-text" class="input" rows="3" maxlength="1200">${esc(editText)}</textarea>
    <button id="ap-generate" class="btn btn-small btn-ghost" style="margin-top:6px">${icon('wand', 'icon icon-sm')}&nbsp;Beschreibung generieren</button>
    <div class="form-grid" id="ap-prices" ${kind === 'gutschein' ? 'style="display:none"' : ''}>
      <div><label class="f-label">Preis (€)</label><input id="ap-price" class="input" inputmode="decimal" value="${esc(edit?.priceNum != null ? String(edit.priceNum).replace('.', ',') : '')}"></div>
      <div><label class="f-label">Vergleichspreis (€)</label><input id="ap-compare" class="input" inputmode="decimal" value="${esc(edit?.compareNum != null ? String(edit.compareNum).replace('.', ',') : '')}"></div>
    </div>
    <div id="ap-codewrap" ${kind === 'gutschein' ? '' : 'style="display:none"'}>
      <label class="f-label">Gutscheincode <span class="opt">(optional)</span></label>
      <input id="ap-code" class="input" maxlength="40" placeholder="z. B. SPAR20">
    </div>
    <label class="f-label">Gültig bis <span class="opt">(optional)</span></label>
    <input id="ap-end" class="input" type="date" value="${edit?.endTs ? new Date(edit.endTs).toISOString().slice(0, 10) : ''}">
    <label style="display:flex; align-items:center; gap:8px; margin-top:10px; font-size:.86rem">
      <input type="checkbox" id="ap-newcustomer" style="width:auto" ${edit?.newCustomer ? 'checked' : ''}> Nur für Neukunden
    </label>
    <input type="hidden" id="ap-image" value="${esc(edit?.image || '')}">
    <div class="form-row" style="margin-top:12px">
      <button id="ap-post" class="btn">${edit ? 'Änderungen speichern' : 'Veröffentlichen'}</button>
      <span id="ap-msg" class="form-msg"></span>
    </div>`;
  // Typ umschalten: Rabatt zeigt Preise, Gutschein zeigt das Code-Feld
  $('#sheet-content').querySelectorAll('[data-apkind]').forEach(b => b.addEventListener('click', () => {
    kind = b.dataset.apkind;
    $('#sheet-content').querySelectorAll('[data-apkind]').forEach(x => x.classList.toggle('active', x === b));
    $('#ap-prices').style.display = kind === 'gutschein' ? 'none' : '';
    $('#ap-codewrap').style.display = kind === 'gutschein' ? '' : 'none';
  }));
  // Beschreibung generieren: mit Link über das Auslesen, sonst aus Titel und Preisen
  $('#ap-generate').addEventListener('click', async () => {
    const m = $('#ap-msg');
    setBtnLoading($('#ap-generate'), true);
    try {
      const link = $('#ap-link').value.trim();
      if (/^https?:\/\//.test(link)) {
        const r = await api('/api/extract?url=' + encodeURIComponent(link));
        if (r.draft) { $('#ap-text').value = r.draft; m.className = 'form-msg ok'; m.textContent = 'Beschreibung aus dem Link erstellt, bitte prüfen.'; }
        else throw new Error('Aus dem Link kam nichts, probier es ohne.');
      } else {
        const r = await api('/api/generate-desc', {
          method: 'POST',
          body: JSON.stringify({ title: $('#ap-title').value, kind, price: $('#ap-price')?.value, comparePrice: $('#ap-compare')?.value }),
        });
        $('#ap-text').value = r.draft;
        m.className = 'form-msg ok'; m.textContent = 'Beschreibung aus dem Titel erstellt, bitte prüfen.';
      }
    } catch (e) { m.className = 'form-msg error'; m.textContent = e.message; }
    finally { setBtnLoading($('#ap-generate'), false); }
  });
  $('#ap-extract').addEventListener('click', async () => {
    const m = $('#ap-msg');
    m.className = 'form-msg'; m.textContent = 'Lese den Link aus …';
    try {
      const r = await api('/api/extract?url=' + encodeURIComponent($('#ap-link').value.trim()));
      if (r.title && !$('#ap-title').value) $('#ap-title').value = r.title;
      if (r.draft && !$('#ap-text').value) $('#ap-text').value = r.draft;
      if (r.priceNum != null && !$('#ap-price').value) $('#ap-price').value = String(r.priceNum).replace('.', ',');
      if (r.compare?.priceNum != null && !$('#ap-compare').value) $('#ap-compare').value = String(r.compare.priceNum).replace('.', ',');
      if (r.image) $('#ap-image').value = r.image;
      m.className = 'form-msg ok'; m.textContent = 'Ausgelesen, bitte prüfen.';
    } catch (e) { m.className = 'form-msg error'; m.textContent = e.message; }
  });
  $('#ap-post').addEventListener('click', async () => {
    const m = $('#ap-msg');
    setBtnLoading($('#ap-post'), true);
    try {
      // Gutscheincode und Deal-Link wandern ans Ende der Beschreibung
      let text = $('#ap-text').value.trim();
      const code = $('#ap-code')?.value.trim();
      if (kind === 'gutschein' && code && !text.includes(code)) text += `\nCode: ${code}`;
      const link = $('#ap-link').value.trim();
      if (link) text += `\n${link}`;
      const body = {
        channel: $('#ap-channel').value, user: state.userName,
        title: $('#ap-title').value, text: text.trim(), kind,
        price: kind === 'gutschein' ? '' : $('#ap-price').value,
        comparePrice: kind === 'gutschein' ? '' : $('#ap-compare').value,
        endDate: $('#ap-end').value, newCustomer: $('#ap-newcustomer').checked,
        image: $('#ap-image').value, merchant: '',
      };
      if (edit) {
        await api('/api/admin/edit-post', { method: 'POST', body: JSON.stringify({ id: edit.id, ...body }) });
      } else {
        await api('/api/posts', { method: 'POST', body: JSON.stringify(body) });
      }
      closeSheet();
      island(edit ? 'Deal aktualisiert' : 'Deal veröffentlicht');
      loadFeed();
    } catch (e) { m.className = 'form-msg error'; m.textContent = e.message; }
    finally { setBtnLoading($('#ap-post'), false); }
  });
  openSheetShell();
}
$('#btn-admin-post').addEventListener('click', openAdminPost);

// ---------------- Preisfehler-Alarm (Web-Push) ----------------

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });

function urlB64ToUint8(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
// Push als On/Off-Schalter in den Einstellungen (Preisfehler + Nachrichten aufs Handy)
async function refreshPushBtn() {
  const sw = $('#sw-push');
  if (!sw || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    sw.checked = !!(await reg.pushManager.getSubscription());
  } catch { }
}
$('#sw-push')?.addEventListener('change', async () => {
  const sw = $('#sw-push');
  const m = $('#push-msg');
  m.className = 'form-msg'; m.textContent = '';
  sw.disabled = true;
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      throw new Error('Dieser Browser kann keine Push-Nachrichten. iPhone: kumulio erst zum Home-Bildschirm hinzufügen und dort öffnen.');
    }
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (!sw.checked && existing) {
      await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: existing.endpoint }) }).catch(() => { });
      await existing.unsubscribe();
      m.className = 'form-msg ok'; m.textContent = 'Push ist aus.';
    } else if (sw.checked && !existing) {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Benachrichtigungen wurden nicht erlaubt.');
      const { key } = await api('/api/push/key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
      await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub) });
      m.className = 'form-msg ok'; m.textContent = 'Push aktiv! Preisfehler und Nachrichten kommen jetzt aufs Handy.';
    }
  } catch (e) {
    m.className = 'form-msg error'; m.textContent = e.message;
  } finally {
    sw.disabled = false;
    refreshPushBtn();
  }
});
refreshPushBtn();

// Der Service Worker meldet sich, wenn eine Notification angetippt wurde
navigator.serviceWorker?.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'open' && d.url) handleOpenParams(d.url.split('?')[1] || '');
  // 'push' bei sichtbarer App: die In-App-Banner (Polling) übernehmen, nichts doppelt zeigen
});
// Direkt in den richtigen Chat springen (Notification-Klick oder Start-URL)
function handleOpenParams(qs) {
  const p = new URLSearchParams(qs);
  if (p.get('chat') === 'dm' && p.get('user')) {
    if (state.activeView !== 'chat') switchView('chat');
    setChatMode('dm', p.get('user'));
  } else if (p.get('chat') === 'global') {
    if (state.activeView !== 'chat') switchView('chat');
    setChatMode('global');
  } else if (p.get('tab') === 'wallet') {
    if (state.activeView !== 'wallet') switchView('wallet');
  }
}

// ---------------- Global-Chat (Twitch-artig) ----------------

let chatEmotes = {};
let chatBadges = {};
let chatPaints = [];
let chatRanks = [];
let chatLastTs = 0;
const chatSeenUsers = new Set();

const CHAT_COLORS = ['#e91e63', '#9c27b0', '#3f51b5', '#03a9f4', '#009688', '#4caf50', '#ff9800', '#f44336', '#8d6e63', '#607d8b'];
function chatColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CHAT_COLORS[h % CHAT_COLORS.length];
}
// Namens-Paint überall gleich: liefert Klasse+Style für einen gemalten Namen,
// Fallback ist die stabile Chat-Farbe
function nameStyleOf(name, paintId) {
  const pnt = paintId ? chatPaints.find(x => x.id === paintId) : null;
  return pnt
    ? { cls: ' paint', style: `--paint:${pnt.css}; color:${pnt.fallbackColor}` }
    : { cls: '', style: `color:${chatColor(name)}` };
}
function emoteHtml(name) {
  return `<img class="emote" src="https://cdn.7tv.app/emote/${chatEmotes[name]}/2x.webp" alt="${esc(name)}" title="${esc(name)}" loading="lazy">`;
}
function withEmotes(escapedText) {
  let t = escapedText;
  for (const name of Object.keys(chatEmotes)) {
    t = t.replace(new RegExp(`\\b${name}\\b`, 'g'), emoteHtml(name));
  }
  return t;
}
// "…" zum Löschen eigener Nachrichten (Web: beim Drüberfahren, Handy: gedrückt halten)
function msgMenuHtml(own, id) {
  return own ? `<button class="msg-menu" data-msg-del="${esc(id)}" aria-label="Nachricht löschen">…</button>` : '';
}
function chatMsgHtml(m) {
  if (m.deleted) {
    return `<div class="chat-msg" data-mid="${esc(m.id)}">
      <span class="chat-user" style="color:${chatColor(m.user)}">${esc(m.user)}</span>
      <span class="chat-text chat-deleted">Nachricht gelöscht</span>
    </div>`;
  }
  const badge = m.badge && chatBadges[m.badge]
    ? `<svg class="icon icon-sm chat-badge" aria-label="${esc(chatBadges[m.badge].name)}"><use href="#i-${chatBadges[m.badge].icon}"/></svg>`
    : '';
  const role = m.role === 'admin' ? `<svg class="icon icon-sm chat-badge role-admin" aria-label="Admin"><use href="#i-crown"/></svg>`
    : m.role === 'mod' ? `<svg class="icon icon-sm chat-badge role-mod" aria-label="Mod"><use href="#i-check"/></svg>` : '';
  // Rang-Icon (Pixel-Art, 20px) vor dem Namen, Paint färbt den Namen
  const rk = chatRanks.find(x => x.tier === (m.rank || 1));
  const rankImg = rk && rk.tier > 1
    ? `<img class="px-icon rank-badge" src="/gamification/rank-${String(rk.tier).padStart(2, '0')}-${rk.id}.svg" alt="" title="${esc(rk.name)}">`
    : '';
  const pnt = m.paint ? chatPaints.find(x => x.id === m.paint) : null;
  const nameStyle = pnt ? `--paint:${pnt.css}; color:${pnt.fallbackColor}` : `color:${chatColor(m.user)}`;
  // Maximal EIN Abzeichen neben dem Rang: das getragene Badge schlägt das Rollen-Icon
  const insignia = badge || role;
  chatSeenUsers.add(m.user);
  // Emotes zuerst, dann @Erwähnungen klickbar machen
  let body = withEmotes(esc(m.text));
  body = body.replace(/@([A-Za-z0-9_.-]{3,24})/g, '<button class="mention" data-user="$1">@$1</button>');
  return `<div class="chat-msg ${m.user === state.userName ? 'own' : ''}" data-mid="${esc(m.id)}">
    ${rankImg}${insignia}<span class="chat-user ${pnt ? 'paint' : ''}" style="${nameStyle}">${esc(m.user)}</span>
    <span class="chat-text">${body}</span>
    ${msgMenuHtml(m.user === state.userName, m.id)}
  </div>`;
}
// Chat-Modi: Global, Flüster-Liste oder ein konkreter Privat-Chat
let chatMode = 'global';
let dmPartner = '';
let dmLastTs = 0;

function setChatMode(mode, partner) {
  chatMode = mode;
  dmPartner = partner || '';
  dmLastTs = 0;
  $('#chat-list').innerHTML = '';
  chatLastTs = mode === 'global' ? 0 : chatLastTs;
  document.querySelectorAll('[data-cmode]').forEach(b =>
    b.classList.toggle('active', b.dataset.cmode === (mode === 'dm' ? 'dmlist' : mode)));
  $('#dm-head').classList.toggle('hidden', mode !== 'dm');
  $('#chat-pinbar').classList.toggle('hidden', mode !== 'global' || !$('#chat-pinbar').innerHTML);
  $('#chat-input-row').style.display = mode === 'dmlist' ? 'none' : 'flex';
  if (mode === 'dm') {
    $('#dm-partner-name').textContent = dmPartner;
    // Profilbild + Namens-Paint der Person im Chat-Kopf
    $('#dm-partner-ava').innerHTML = `<span class="avatar-mini" style="background:${chatColor(dmPartner)}">${esc(dmPartner[0].toUpperCase())}</span>`;
    api('/api/user?name=' + encodeURIComponent(dmPartner)).then(u => {
      if (u.avatar) $('#dm-partner-ava').innerHTML = `<img class="avatar-mini avatar-img" src="${u.avatar}" alt="">`;
      const ns = nameStyleOf(dmPartner, u.activePaint);
      const el = $('#dm-partner-name');
      el.className = ns.cls.trim();
      el.setAttribute('style', ns.style);
    }).catch(() => { });
  } else {
    $('#dm-partner-ava').innerHTML = '';
  }
  // Moduswechsel gleitet weich
  const cl = $('#chat-list');
  cl.classList.add('enter-drop');
  setTimeout(() => cl.classList.remove('enter-drop'), 500);
  delete $('#chat-box').dataset.scrolled;
  pollChat(true);
}

function renderPinbar(pinned) {
  const bar = $('#chat-pinbar');
  if (!pinned) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.innerHTML = `${icon('pin', 'icon icon-sm')}
    <span class="chat-user" style="color:${chatColor(pinned.user)}">${esc(pinned.user)}</span>
    <span class="pin-text">${esc(pinned.text)}</span>
    ${['admin', 'mod'].includes(state.role) ? `<button class="fav-remove" id="pin-remove">${icon('x', 'icon icon-sm')}</button>` : ''}`;
  bar.classList.toggle('hidden', chatMode !== 'global');
  $('#pin-remove')?.addEventListener('click', () =>
    api('/api/chat/mod', { method: 'POST', body: JSON.stringify({ action: 'unpin' }) }).then(() => renderPinbar(null)).catch(e => island(e.message)));
}

function dmMsgHtml(m) {
  if (m.deleted) {
    return `<div class="chat-msg" data-mid="${esc(m.id)}">
      <span class="chat-user" style="color:${chatColor(m.from)}">${esc(m.from)}</span>
      <span class="chat-text chat-deleted">Nachricht gelöscht</span>
    </div>`;
  }
  const own = m.from === state.userName;
  // Auch im Privatchat: Rang-Icon, Badge/Rolle und Namens-Paint wie im Global-Chat
  const badge = m.badge && chatBadges[m.badge]
    ? `<svg class="icon icon-sm chat-badge" aria-label="${esc(chatBadges[m.badge].name)}"><use href="#i-${chatBadges[m.badge].icon}"/></svg>`
    : '';
  const role = m.role === 'admin' ? `<svg class="icon icon-sm chat-badge role-admin" aria-label="Admin"><use href="#i-crown"/></svg>`
    : m.role === 'mod' ? `<svg class="icon icon-sm chat-badge role-mod" aria-label="Mod"><use href="#i-check"/></svg>` : '';
  const rk = chatRanks.find(x => x.tier === (m.rank || 1));
  const rankImg = rk && rk.tier > 1
    ? `<img class="px-icon rank-badge" src="/gamification/rank-${String(rk.tier).padStart(2, '0')}-${rk.id}.svg" alt="" title="${esc(rk.name)}">`
    : '';
  const ns = nameStyleOf(m.from, m.paint);
  return `<div class="chat-msg dm-${own ? 'me' : 'them'} ${own ? 'own' : ''}" data-mid="${esc(m.id)}">
    ${rankImg}${badge || role}<span class="chat-user${ns.cls}" style="${ns.style}">${esc(m.from)}</span>
    <span class="chat-text">${withEmotes(esc(m.text))}</span>
    ${msgMenuHtml(own, m.id)}
  </div>`;
}

async function pollChat(force) {
  // Global wird immer gepollt (für Erwähnungs-Benachrichtigungen), DMs nur im Chat
  if (!force && state.activeView !== 'chat' && chatMode !== 'global') return;
  try {
    if (chatMode === 'global') {
      const r = await api('/api/chat?since=' + chatLastTs);
      chatEmotes = r.emotes || chatEmotes;
      chatBadges = r.badges || chatBadges;
      chatPaints = r.paints || chatPaints;
      chatRanks = r.ranks || chatRanks;
      renderPinbar(r.pinned);
      // Nachträglich gelöschte Nachrichten gegen den Platzhalter tauschen
      (r.updates || []).forEach(id => {
        const el = $('#chat-list').querySelector(`[data-mid="${id}"] .chat-text`);
        if (el) { el.className = 'chat-text chat-deleted'; el.textContent = 'Nachricht gelöscht'; }
      });
      if (r.messages.length) {
        const box = $('#chat-box'), list = $('#chat-list');
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        // Erwähnungen: nur für WIRKLICH neue Nachrichten, nicht beim Neuladen der Historie
        const mentionSeen = Number(localStorage.getItem('ra.mentionSeen') || 0);
        let batchMax = mentionSeen;
        r.messages.forEach(m => {
          // Nie doppelt: die eigene Nachricht steht durch das Sende-Echo evtl. schon
          // da, während der Echtzeit-Ping parallel denselben Poll anstößt
          if (!list.querySelector(`[data-mid="${m.id}"]`)) list.insertAdjacentHTML('beforeend', chatMsgHtml(m));
          chatLastTs = Math.max(chatLastTs, m.ts);
          batchMax = Math.max(batchMax, m.ts);
          if (state.notif.mention !== false && state.userName && m.user !== state.userName && !m.deleted && m.ts > mentionSeen
            && new RegExp(`(^|\\W)@?${state.userName}(\\W|$)`, 'i').test(m.text)) {
            playSfx('plop'); buzz(25);
            if (state.activeView !== 'chat') {
              showNoteBanner(`<b>@${esc(m.user)}</b> hat dich erwähnt: ${esc(m.text.slice(0, 60))}`, () => {
                switchView('chat'); setChatMode('global');
              });
            }
          }
        });
        localStorage.setItem('ra.mentionSeen', String(batchMax));
        while (list.children.length > 150) list.firstChild.remove();
        if (nearBottom || !box.dataset.scrolled) box.scrollTop = box.scrollHeight;
        box.dataset.scrolled = '1';
      }
    } else if (chatMode === 'dmlist') {
      if (!state.token) { $('#chat-list').innerHTML = '<div class="status">Zum Flüstern bitte anmelden.</div>'; return; }
      const r = await api('/api/dm/list');
      const ava = (name, avatar) => avatar
        ? `<img class="avatar-mini avatar-img" src="${avatar}" alt="">`
        : `<span class="avatar-mini" style="background:${chatColor(name)}">${esc(name[0].toUpperCase())}</span>`;
      const rows = r.list.map(c => `
        <button class="dm-row" data-dm-open="${esc(c.partner)}">
          ${ava(c.partner, c.avatar)}
          <span class="dm-row-main">
            <span class="dm-row-name">${esc(c.partner)}</span>
            <span class="dm-row-last">${esc(c.lastText)}</span>
          </span>
          ${c.unread ? `<span class="dm-unread-pill">${c.unread}</span>` : ''}
        </button>`).join('');
      const friendRows = (r.friends || []).map(f => `
        <button class="dm-row" data-dm-open="${esc(f.name)}">
          ${ava(f.name, f.avatar)}
          <span class="dm-row-main"><span class="dm-row-name">${esc(f.name)}</span>
          <span class="dm-row-last">Freund, noch kein Chat</span></span>
        </button>`).join('');
      $('#chat-list').innerHTML = (rows + friendRows) || '<div class="status">Noch keine Flüster-Chats. Tippe im Global-Chat auf einen Namen, um zu flüstern.</div>';
      $('#chat-list').querySelectorAll('[data-dm-open]').forEach(b => b.onclick = () => setChatMode('dm', b.dataset.dmOpen));
    } else if (chatMode === 'dm') {
      const r = await api(`/api/dm/with?user=${encodeURIComponent(dmPartner)}&since=${dmLastTs}`);
      (r.updates || []).forEach(id => {
        const el = $('#chat-list').querySelector(`[data-mid="${id}"] .chat-text`);
        if (el) { el.className = 'chat-text chat-deleted'; el.textContent = 'Nachricht gelöscht'; }
      });
      if (r.messages.length) {
        const box = $('#chat-box'), list = $('#chat-list');
        r.messages.forEach(m => {
          if (!list.querySelector(`[data-mid="${m.id}"]`)) list.insertAdjacentHTML('beforeend', dmMsgHtml(m));
          dmLastTs = Math.max(dmLastTs, m.ts);
        });
        box.scrollTop = box.scrollHeight;
      }
    }
    refreshDmBadge();
  } catch { }
}

let dmBadgeLast = 0;
let dmUnreadKnown = null;
async function refreshDmBadge() {
  if (!state.token || Date.now() - dmBadgeLast < 8000) return;
  dmBadgeLast = Date.now();
  try {
    const r = await api('/api/dm/list');
    const unread = r.list.reduce((s, c) => s + c.unread, 0);
    const pill = $('#dm-unread');
    pill.textContent = unread;
    pill.classList.toggle('hidden', !unread);
    // Neue Flüsternachricht: Plop + Banner (außer man liest den Chat gerade oder hat es abgeschaltet)
    if (dmUnreadKnown !== null && unread > dmUnreadKnown && state.notif.msgs !== false) {
      const conv = r.list.find(c => c.unread > 0);
      if (conv && !(chatMode === 'dm' && dmPartner === conv.partner && state.activeView === 'chat')) {
        playSfx('plop'); buzz(25);
        showNoteBanner(`<b>@${esc(conv.partner)}</b>: ${esc(conv.lastText)}`, () => {
          if (state.activeView !== 'chat') switchView('chat');
          setChatMode('dm', conv.partner);
        });
      }
    }
    dmUnreadKnown = unread;
  } catch { }
}

// Command-Palette: erscheint, sobald die Eingabe mit "!" beginnt
const CHAT_COMMANDS = [
  { cmd: '!v', desc: 'Vanish: alle deine Nachrichten verschwinden' },
  { cmd: '!muenze', desc: 'Wirft eine Münze (Kopf oder Zahl)' },
  { cmd: '!stats', desc: 'Zeigt dir deine Coins und deinen Spar-Rang' },
  { cmd: '!hilfe', desc: 'Zeigt diese Übersicht' },
];
function renderCmdPalette(show) {
  let el = $('#chat-cmds');
  if (!el) {
    el = document.createElement('div');
    el.id = 'chat-cmds';
    $('#chat-input-row').before(el);
  }
  if (!show) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = CHAT_COMMANDS.map(c =>
    `<button class="cmd-row" data-cmd="${c.cmd}"><b>${c.cmd}</b><span>${c.desc}</span></button>`).join('');
  el.querySelectorAll('[data-cmd]').forEach(b => b.onclick = () => {
    $('#chat-input').value = b.dataset.cmd;
    renderCmdPalette(false);
    $('#chat-input').focus();
  });
}
$('#chat-input').addEventListener('input', e => {
  const v = e.target.value;
  // Command-Palette bei "!", @Namens-Vorschläge beim Tippen einer Erwähnung
  const at = v.match(/@([A-Za-z0-9_.-]*)$/);
  if (at && chatMode !== 'dm') {
    const pool = [...new Set([...(myProfile?.friends || []), ...chatSeenUsers])]
      .filter(n => n !== state.userName && n.toLowerCase().startsWith(at[1].toLowerCase()))
      .slice(0, 5);
    let el = $('#chat-cmds');
    if (!el) { el = document.createElement('div'); el.id = 'chat-cmds'; $('#chat-input-row').before(el); }
    if (pool.length) {
      el.style.display = 'block';
      el.innerHTML = pool.map(n => `<button class="cmd-row" data-atname="${esc(n)}"><b>@${esc(n)}</b></button>`).join('');
      el.querySelectorAll('[data-atname]').forEach(b => b.onclick = () => {
        $('#chat-input').value = v.replace(/@[A-Za-z0-9_.-]*$/, '@' + b.dataset.atname + ' ');
        el.style.display = 'none';
        $('#chat-input').focus();
      });
      return;
    }
    el.style.display = 'none';
    return;
  }
  renderCmdPalette(chatMode !== 'dm' && v.startsWith('!'));
});

async function sendChat() {
  const inp = $('#chat-input');
  const text = inp.value.trim();
  if (!text) return;
  renderCmdPalette(false);
  // Emote-Fenster schließt beim Absenden, die Nachricht ist ja raus
  if (!$('#chat-emotes').classList.contains('hidden')) toggleEmotes();
  // Client-Commands, die keinen Server brauchen
  if (text === '!hilfe') { inp.value = ''; renderCmdPalette(true); return; }
  if (text === '!stats') {
    inp.value = '';
    const rank = rankFor(renderWallet.lastTotal || 0);
    island(`${myProfile?.coins ?? 0} Coins, Rang: ${rank.name}`);
    return;
  }
  if (!state.token) { switchView('profile'); island('Zum Chatten bitte anmelden'); return; }
  try {
    if (chatMode === 'dm') {
      const r = await api('/api/dm/send', { method: 'POST', body: JSON.stringify({ to: dmPartner, text }) });
      inp.value = '';
      if (!$('#chat-list').querySelector(`[data-mid="${r.message.id}"]`)) $('#chat-list').insertAdjacentHTML('beforeend', dmMsgHtml(r.message));
      dmLastTs = Math.max(dmLastTs, r.message.ts);
      $('#chat-box').scrollTop = $('#chat-box').scrollHeight;
      return;
    }
    const r = await api('/api/chat', { method: 'POST', body: JSON.stringify({ text }) });
    inp.value = '';
    if (r.vanished) {
      // !v: eigene Nachrichten werden zum Platzhalter
      document.querySelectorAll('#chat-list .chat-msg').forEach(el => {
        if (el.querySelector('.chat-user')?.textContent === state.userName) {
          const t = el.querySelector('.chat-text');
          if (t) { t.className = 'chat-text chat-deleted'; t.textContent = 'Nachricht gelöscht'; }
        }
      });
      island('Deine Nachrichten sind gelöscht');
      return;
    }
    if (!$('#chat-list').querySelector(`[data-mid="${r.message.id}"]`)) $('#chat-list').insertAdjacentHTML('beforeend', chatMsgHtml(r.message));
    chatLastTs = Math.max(chatLastTs, r.message.ts);
    $('#chat-box').scrollTop = $('#chat-box').scrollHeight;
  } catch (e) { island(e.message); }
}

// ---- Nutzer-Profil: eigene Seite (ersetzt das alte Popup)
let userPageReturn = 'feed';
async function openUserPop(user, msgId) {
  if (user === state.userName) { switchView('profile'); return; }
  if (state.activeView !== 'user') userPageReturn = state.activeView;
  const pop = $('#user-page');
  pop.innerHTML = '<div class="status">Lade Profil …</div>';
  $('#user-page-title').textContent = '@' + user;
  switchView('user', 'enter-drop');
  let u = { user };
  try { u = await api('/api/user?name=' + encodeURIComponent(user)); } catch { }
  const isFriend = (myProfile?.friends || []).includes(user);
  const favLogo = v => BRAND_DOMAINS[String(v || '').toLowerCase()]
    ? `<span class="fav-logo">${brandChipHtml(v)}<small>${esc(v)}</small></span>`
    : `<span class="pill">${esc(v)}</span>`;
  pop.innerHTML = `
    <div class="offer-head">
      ${u.avatar ? `<img class="avatar-big" src="${u.avatar}" alt="">`
        : `<span class="avatar-big" style="background:${chatColor(user)}">${esc(user[0].toUpperCase())}</span>`}
      <div class="offer-brand">
        <div class="offer-merchant"><span class="${nameStyleOf(user, u.activePaint).cls.trim()}" style="${nameStyleOf(user, u.activePaint).style}">${esc(user)}</span> ${u.role === 'admin' ? icon('crown', 'icon icon-sm role-admin') : u.role === 'mod' ? icon('check', 'icon icon-sm role-mod') : ''}</div>
        <div class="offer-cat">${u.private ? 'Profil ist privat' : esc(u.bio || 'Keine Bio')}</div>
      </div>
    </div>
    ${!u.private && u.favs && Object.values(u.favs).some(Boolean) ? `
    <div class="favs-view">
      ${['discounter', 'supermarkt', 'essen', 'onlineshop', 'mode'].map(k => u.favs[k] ? favLogo(u.favs[k]) : '').join('')}
    </div>` : ''}
    ${!u.private && (u.showcase || []).length ? `<div class="me-showcase">
      ${u.showcase.map(key => {
        const [kind, id] = key.split(':');
        const fl = (u.floats || {})[key] ?? 0;
        return `<div class="sc-slot ${isShinyF(fl) ? 'shiny' : ''}" style="--rc:#8B96A5">${itemVisual(kind, id)}<span class="inv-float">#${String(fl).padStart(3, '0')}</span></div>`;
      }).join('')}
    </div>` : ''}
    ${!u.private && (u.badges || []).length ? `<div class="badge-grid" style="margin-top:10px">
      ${u.badges.map(id => u.badgesAll?.[id] ? badgeChip(id, u.badgesAll[id], id === u.activeBadge) : '').join('')}
    </div>` : ''}
    <div class="form-row" style="margin-top:14px; flex-wrap:wrap">
      <button class="btn btn-small" id="up-whisper">Flüstern</button>
      <button class="btn btn-small btn-ghost" id="up-friend">${isFriend ? 'Freund entfernen' : 'Freundschaftsanfrage'}</button>
      <button class="btn btn-small btn-ghost" id="up-report">Melden</button>
    </div>`;
  // Bewusst KEINE Mod-Buttons hier: die Profilseite zeigt das Profil, wie es der
  // Nutzer gestaltet hat; Moderation läuft über das Chat-Popup
  const close = () => switchView(userPageReturn, 'enter-drop');
  $('#up-whisper').onclick = () => {
    if (!state.token) { island('Zum Flüstern bitte anmelden'); return; }
    switchView('chat');
    setChatMode('dm', user);
  };
  $('#up-friend').onclick = async () => {
    if (!state.token) { island('Bitte anmelden'); return; }
    await api('/api/friend', { method: 'POST', body: JSON.stringify({ user, action: isFriend ? 'remove' : 'add' }) })
      .then(r => {
        if (myProfile) { myProfile.friends = r.friends; myProfile.friendRequests = r.friendRequests; }
        island(isFriend ? 'Freund entfernt' : r.friends.includes(user) ? 'Ihr seid jetzt Freunde!' : 'Anfrage gesendet');
      })
      .catch(e => island(e.message));
    close();
  };
  $('#up-report').onclick = async () => {
    await api('/api/chat/report', { method: 'POST', body: JSON.stringify({ user, id: msgId || '' }) })
      .then(() => island('Gemeldet, danke!')).catch(e => island(e.message));
    close();
  };
}
$('#user-pop-backdrop').addEventListener('click', e => { if (e.target.id === 'user-pop-backdrop') hideOverlay($('#user-pop-backdrop')); });
// Eigene Nachricht löschen (Global + Flüstern), wird zum Platzhalter
async function deleteOwnMsg(id) {
  if (!await askConfirm('Diese Nachricht löschen?', { okLabel: 'Löschen' })) return;
  try {
    if (chatMode === 'dm') await api('/api/dm/delete', { method: 'POST', body: JSON.stringify({ user: dmPartner, id }) });
    else await api('/api/chat/delete', { method: 'POST', body: JSON.stringify({ id }) });
    const el = $('#chat-list').querySelector(`[data-mid="${id}"]`);
    if (el) {
      const t = el.querySelector('.chat-text');
      if (t) { t.className = 'chat-text chat-deleted'; t.textContent = 'Nachricht gelöscht'; }
      el.querySelector('.msg-menu')?.remove();
    }
  } catch (e) { island(e.message); }
}
// Im Chat: kompaktes Popup mit Schnellaktionen, "Zum Profil" führt zur Seite
async function openUserSheet(user, msgId) {
  if (user === state.userName) { switchView('profile'); return; }
  const pop = $('#user-pop');
  pop.innerHTML = '<div class="status">Lade …</div>';
  $('#user-pop-backdrop').classList.remove('hidden');
  let u = { user };
  try { u = await api('/api/user?name=' + encodeURIComponent(user)); } catch { }
  const isFriend = (myProfile?.friends || []).includes(user);
  const mod = ['admin', 'mod'].includes(state.role);
  pop.innerHTML = `
    <button class="fav-remove us-close" id="us-close" aria-label="Schließen">${icon('x', 'icon icon-sm')}</button>
    <div class="us-head">
      ${u.avatar ? `<img class="avatar-big us-ava" src="${u.avatar}" alt="">`
      : `<span class="avatar-big us-ava" style="background:${chatColor(user)}">${esc(user[0].toUpperCase())}</span>`}
      <div class="us-name"><span class="${nameStyleOf(user, u.activePaint).cls.trim()}" style="${nameStyleOf(user, u.activePaint).style}">@${esc(user)}</span> ${u.role === 'admin' ? icon('crown', 'icon icon-sm role-admin') : u.role === 'mod' ? icon('check', 'icon icon-sm role-mod') : ''}</div>
      <div class="us-bio">${u.private ? 'Profil ist privat' : esc((u.bio || '').slice(0, 80) || 'Keine Bio')}</div>
    </div>
    <button class="btn btn-block" id="us-profile">${icon('user', 'icon icon-sm')}&nbsp;Zum Profil</button>
    <div class="us-actions">
      <button class="btn btn-small btn-ghost" id="us-whisper">${icon('message', 'icon icon-sm')}&nbsp;Flüstern</button>
      <button class="btn btn-small btn-ghost" id="us-friend">${isFriend ? 'Freund entfernen' : 'Anfragen'}</button>
      <button class="btn btn-small btn-ghost" id="us-report">Melden</button>
    </div>
    ${mod ? `<div class="us-modbox">
      <span class="tm-section" style="margin:0 0 6px">Moderation</span>
      <div class="us-actions">
        ${u.mutedUntil ? `<button class="btn btn-small btn-ghost" id="us-unban">Timeout aufheben</button>`
      : u.banned ? `<button class="btn btn-small btn-ghost" id="us-unban">Entsperren</button>`
      : `<button class="btn btn-small btn-ghost" id="us-timeout">Timeout 10 Min.</button>
        <button class="btn btn-small btn-ghost" id="us-ban">Sperren</button>`}
        ${msgId ? `<button class="btn btn-small btn-ghost" id="us-delmsg">Nachricht löschen</button>
        <button class="btn btn-small btn-ghost" id="us-pin">Anpinnen</button>` : ''}
      </div>
    </div>` : ''}`;
  const close = () => hideOverlay($('#user-pop-backdrop'));
  $('#us-close').onclick = close;
  $('#us-profile').onclick = () => { close(); openUserPop(user, msgId); };
  $('#us-whisper').onclick = () => { close(); if (!state.token) { island('Zum Flüstern bitte anmelden'); return; } setChatMode('dm', user); };
  $('#us-friend').onclick = async () => {
    if (!state.token) { island('Bitte anmelden'); return; }
    await api('/api/friend', { method: 'POST', body: JSON.stringify({ user, action: isFriend ? 'remove' : 'add' }) })
      .then(r => {
        if (myProfile) { myProfile.friends = r.friends; myProfile.friendRequests = r.friendRequests; }
        island(isFriend ? 'Freund entfernt' : r.friends.includes(user) ? 'Ihr seid jetzt Freunde!' : 'Anfrage gesendet');
      }).catch(e => island(e.message));
    close();
  };
  $('#us-report').onclick = async () => {
    await api('/api/chat/report', { method: 'POST', body: JSON.stringify({ user, id: msgId || '' }) })
      .then(() => island('Gemeldet, danke!')).catch(e => island(e.message));
    close();
  };
  const modAct = (action, extra) => api('/api/chat/mod', { method: 'POST', body: JSON.stringify({ action, user, id: msgId, ...extra }) })
    .then(() => { island('Erledigt'); $('#chat-list').innerHTML = ''; chatLastTs = 0; pollChat(true); close(); })
    .catch(e => island(e.message));
  $('#us-timeout')?.addEventListener('click', () => modAct('timeout', { minutes: 10 }));
  $('#us-ban')?.addEventListener('click', () => modAct('ban'));
  $('#us-unban')?.addEventListener('click', () => modAct('unban'));
  $('#us-delmsg')?.addEventListener('click', () => modAct('delete-msg'));
  $('#us-pin')?.addEventListener('click', () => modAct('pin'));
}

$('#chat-list').addEventListener('click', e => {
  const del = e.target.closest('[data-msg-del]');
  if (del) { deleteOwnMsg(del.dataset.msgDel); return; }
  const mention = e.target.closest('.mention');
  if (mention) { openUserSheet(mention.dataset.user); return; }
  const nameEl = e.target.closest('.chat-user');
  if (!nameEl || chatMode === 'dm') return;
  const msgEl = e.target.closest('.chat-msg');
  openUserSheet(nameEl.textContent, msgEl?.dataset.mid);
});
// Handy: eigene Nachricht gedrückt halten zum Löschen
let pressTimer = null;
$('#chat-list').addEventListener('touchstart', e => {
  const msg = e.target.closest('.chat-msg.own');
  if (!msg) return;
  pressTimer = setTimeout(() => { buzz(20); deleteOwnMsg(msg.dataset.mid); }, 550);
}, { passive: true });
['touchend', 'touchmove', 'touchcancel'].forEach(t =>
  $('#chat-list').addEventListener(t, () => clearTimeout(pressTimer), { passive: true }));
document.querySelectorAll('[data-cmode]').forEach(b => b.addEventListener('click', () => setChatMode(b.dataset.cmode)));
$('#dm-back').addEventListener('click', () => setChatMode('dmlist'));
// Im Privat-Chat: Name/Avatar oben antippen öffnet das Profil
$('#dm-partner-open')?.addEventListener('click', () => { if (dmPartner) openUserPop(dmPartner); });

// Gäste: Chat nur verschwommen, Eingabe zu, klarer Anmelden-Weg
function updateChatGate() {
  const guest = !state.token;
  $('#view-chat').classList.toggle('guest', guest);
  $('#chat-gate').classList.toggle('hidden', !guest);
  $('#chat-input').disabled = guest;
  $('#chat-send').disabled = guest;
}
$('#chat-gate-login').addEventListener('click', () => switchView('profile'));
function toggleEmotes() {
  const el = $('#chat-emotes');
  // Box macht Platz, damit die letzten Nachrichten sichtbar bleiben
  const opening = el.classList.contains('hidden');
  $('#view-chat').classList.toggle('emotes-open', opening);
  if (opening) {
    // Freigeschaltete Emotes nur zeigen, wenn man sie besitzt
    const locked = new Set(Object.keys(gami?.emotesAll || {}).filter(n => !(gami?.emotes || []).includes(n)));
    const usable = Object.keys(chatEmotes).filter(n => !locked.has(n));
    el.innerHTML = usable.length
      ? usable.map(n => `<button class="emote-pick" data-emote="${esc(n)}">${emoteHtml(n)}</button>`).join('')
      : '<span class="form-msg">Emotes laden …</span>';
    el.classList.remove('hidden');
    // Nachrichten nachziehen: die letzten bleiben beim Schreiben sichtbar
    setTimeout(() => { const box = $('#chat-box'); box.scrollTop = box.scrollHeight; }, 320);
    el.querySelectorAll('[data-emote]').forEach(b => b.onclick = () => {
      const i = $('#chat-input');
      i.value = (i.value + ' ' + b.dataset.emote + ' ').replace(/\s{2,}/g, ' ').trimStart();
      i.focus();
    });
  } else el.classList.add('hidden');
}
$('#chat-send').addEventListener('click', sendChat);
$('#chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
$('#chat-emote-btn').addEventListener('click', toggleEmotes);
setInterval(pollChat, 4000);
setInterval(refreshDmBadge, 12000);

// ---- Echtzeit: der Server pingt bei neuen Nachrichten, wir laden sofort nach.
// Das Polling oben bleibt nur als Fallback-Netz (alte Browser, Verbindungslücken)
let chatStream = null;
let streamRetry = 0;
function connectStream() {
  if (!window.EventSource) return;
  try { chatStream?.close(); } catch { }
  const tok = state.token ? '?token=' + encodeURIComponent(state.token) : '';
  const es = new EventSource(API_BASE + '/api/stream' + tok);
  chatStream = es;
  es.onopen = () => { streamRetry = 0; };
  es.addEventListener('chat', () => pollChat(true));
  es.addEventListener('gift', () => pullWallet()); // Geschenk kommt sofort an
  es.addEventListener('dm', () => {
    dmBadgeLast = 0;
    refreshDmBadge();
    if (chatMode === 'dm' && state.activeView === 'chat') pollChat(true);
  });
  es.onerror = () => {
    es.close();
    if (chatStream === es) chatStream = null;
    setTimeout(() => { if (!chatStream) connectStream(); }, Math.min(15000, 1500 * ++streamRetry));
  };
}
connectStream();

// ---------------- Start ----------------

// Tastatur auf dem Handy: die sichtbare Höhe als CSS-Variable, damit der Chat
// kompakt bleibt und nichts unkontrolliert hochgeschoben wird
if (window.visualViewport) {
  const applyVV = () => {
    const vv = window.visualViewport;
    document.documentElement.style.setProperty('--vvh', vv.height + 'px');
    // iOS schiebt beim Öffnen der Tastatur den sichtbaren Ausschnitt nach unten
    // (offsetTop) und der Chat "verschwindet" oben. Der Trick: den Body um genau
    // diesen Versatz mitschieben, dann bleibt alles lesbar an Ort und Stelle
    if (document.body.classList.contains('chat-locked') && vv.offsetTop > 1) {
      document.body.style.transform = `translateY(${Math.round(vv.offsetTop)}px)`;
    } else {
      document.body.style.transform = '';
    }
  };
  window.visualViewport.addEventListener('resize', applyVV);
  window.visualViewport.addEventListener('scroll', applyVV);
  applyVV();
}

// Als Home-Bildschirm-App: Pinch-Zoom (iOS-Geste) komplett blocken –
// Doppeltipp-Zoom verhindert touch-action in style.css
['gesturestart', 'gesturechange', 'gestureend'].forEach(t =>
  document.addEventListener(t, e => e.preventDefault(), { passive: false }));

// Verbindungs-Screen: springt ein, wenn kumulio nicht laden kann oder es lange dauert.
// Nur der i-Punkt hüpft (Markenregel), Text sagt ehrlich, was los ist.
function showConnScreen(kind) {
  let el = $('#conn-screen');
  if (!el) {
    el = document.createElement('div');
    el.id = 'conn-screen';
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <div class="conn-mark">${window.KBrand?.wordmarkHTML ? window.KBrand.wordmarkHTML({ height: 36 }) : '<b>kumulio</b>'}</div>
    <p>${kind === 'slow'
      ? 'Dauert gerade etwas länger, langsame Verbindung …'
      : 'Keine Verbindung. kumulio braucht kurz Internet, damit nichts verloren geht.'}</p>
    ${kind === 'slow' ? '' : '<button class="btn" id="conn-retry">Erneut versuchen</button>'}`;
  el.querySelector('.k-dot')?.classList.add('k-jump');
  $('#conn-retry')?.addEventListener('click', () => location.reload());
}
function hideConnScreen() { $('#conn-screen')?.remove(); }
window.addEventListener('online', () => { if ($('#conn-screen')) location.reload(); });

(async function init() {
  // Fallback: sollte das Brand-Modul je nicht laden, darf der Boot-Deckel
  // die App trotzdem nicht dauerhaft verdecken
  setTimeout(() => document.getElementById('boot-cover')?.remove(), 3200);
  refreshProfileTab();
  renderWallet();
  initTurnstile();
  // Emotes, Badges, Paints und Ränge früh laden, damit Profile und Chats sie kennen
  api('/api/chat?since=99999999999999').then(r => {
    chatEmotes = r.emotes || {};
    chatBadges = r.badges || {};
    chatPaints = r.paints || chatPaints;
    chatRanks = r.ranks || chatRanks;
  }).catch(() => { });
  if (state.token) {
    pullWallet(); // parallel statt hinter /api/me: Guthaben ist schneller aktuell
    api('/api/me').then(r => { state.userName = r.user; state.role = r.role || ''; refreshProfileTab(); refreshAdminUi(); })
      .catch(e => {
        // Nur bei ECHTEM 401 abmelden; ist der Server kurz weg, bleibt der Login stehen
        if (/401|anmelden/i.test(String(e.message))) {
          state.token = ''; localStorage.removeItem('ra.token'); refreshProfileTab();
        }
      });
  }
  moveTabPill();
  setTimeout(moveTabPill, 300); // nach Font-Laden nachjustieren
  renderSearch();
  maybeShowOnboarding();
  // Kanäle sind das Rückgrat: bei Hängern ehrlich einen Lade-/Offline-Screen zeigen
  const slowTimer = setTimeout(() => showConnScreen('slow'), 4000);
  let channels = null;
  try { channels = await api('/api/channels'); } catch { }
  clearTimeout(slowTimer);
  if (!channels) {
    window.KBrandReady?.then(K => K.appReady());
    showConnScreen('offline');
    return;
  }
  hideConnScreen();
  state.channels = channels;
  renderChipbar();
  loadFeed();
  checkReminders();
  handleOpenParams(location.search);
  // App ist bereit → der kumulio-Splash darf weg, sobald seine Animation durch ist
  window.KBrandReady?.then(K => K.appReady());
})();
