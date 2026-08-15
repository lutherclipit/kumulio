// kumulio – Frontend-Logik (Vanilla JS, kein Framework)

const $ = sel => document.querySelector(sel);

// API-Basis: im Web leer (gleiche Origin). In der iOS/Android-App (Capacitor)
// zeigt sie auf den gehosteten Server – in index.html RA_API_BASE setzen.
const API_BASE = (window.RA_API_BASE || localStorage.getItem('ra.apiBase') || '').replace(/\/$/, '');
const state = {
  channels: [],
  follows: JSON.parse(localStorage.getItem('ra.follows') || 'null'), // null = Onboarding nötig
  stars: JSON.parse(localStorage.getItem('ra.stars') || '{}'),       // { dealId: 1..5 }
  wallet: JSON.parse(localStorage.getItem('ra.wallet') || '{"vouchers":[],"cards":[]}'),
  favs: JSON.parse(localStorage.getItem('ra.favs') || '{}'),         // { dealId: {deal, ts, remindAt, notified} }
  pins: JSON.parse(localStorage.getItem('ra.pins') || '["freebies","preisfehler"]'), // angeheftete Feed-Menüs
  aff: JSON.parse(localStorage.getItem('ra.aff') || '{"ch":{},"m":{}}'), // Verhalten für "Für dich"
  activeChip: 'sparen',
  search: '',
  orderIds: null, // eingefrorene Sortierung – Votes würfeln den Feed nicht sofort um
  orderKey: '',
  activeView: 'feed',
  deals: [],
  currentDeal: null,
  sheetMode: null, // 'deal' | 'channels' | 'favs'
  userName: localStorage.getItem('ra.user') || '',
  token: localStorage.getItem('ra.token') || '',
  featured: [],
};

// ---------------- Dark Mode ----------------

let themeAnimTimer = null;
function applyTheme(t, animate = false) {
  const root = document.documentElement;
  // Weiche Überblendung aller Farben – nur beim aktiven Umschalten, nicht beim Start
  if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    root.classList.add('theme-anim');
    clearTimeout(themeAnimTimer);
    themeAnimTimer = setTimeout(() => root.classList.remove('theme-anim'), 500);
    document.getElementById('btn-theme')?.classList.add('spin');
    setTimeout(() => document.getElementById('btn-theme')?.classList.remove('spin'), 400);
  }
  root.dataset.theme = t;
  localStorage.setItem('ra.theme', t);
  const use = document.querySelector('#btn-theme use');
  if (use) use.setAttribute('href', t === 'dark' ? '#i-sun' : '#i-moon');
}
applyTheme(localStorage.getItem('ra.theme')
  || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

const VIEW_ORDER = ['wallet', 'feed', 'chat', 'search', 'profile'];
const FEED_LIMIT = 40;

// Menüpunkte oben: Sparen / Verdienen / Neukunden / Coupons.
// "Gespeichert" läuft nur noch über den Gold-Stern oben rechts.
const SEGMENTS = [
  { slug: 'sparen', name: 'Sparen', icon: 'gift' },
  { slug: 'verdienen', name: 'Verdienen', icon: 'banknote' },
  { slug: 'neukunden', name: 'Neukunden', icon: 'sparkle' },
  { slug: 'coupons', name: 'Coupons', icon: 'tag' },
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
    { name: 'Netto', url: 'https://www.netto-online.de/', desc: 'Rabatt-Coupons in der Netto-App – oft ohne Mindestwert' },
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
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
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
  // Erfolgs-Moment: der kumulio-Punkt quittiert (einmal, kein Konfetti) – Text bleibt Pflichtsignal
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

// Laufende Übergänge sofort sauber beenden – verhindert, dass bei schnellem
// Tab-Wechsel ein alter Timer die inzwischen aktive View versteckt/verschiebt
function settleViews() {
  clearTimeout(viewCleanupTimer);
  document.querySelectorAll('.view').forEach(v => {
    v.classList.remove('enter-right', 'enter-left');
    v.classList.toggle('hidden', v.id !== 'view-' + state.activeView);
  });
}

// Wechsel ohne Überlappung: alte View sofort weg, nur die neue animiert herein.
// So kann bei schnellem Durchschalten nichts springen oder doppelt erscheinen.
function switchView(next) {
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
  newView.classList.add(dir === 1 ? 'enter-right' : 'enter-left');
  // Login-Captcha erst rendern, wenn die Profil-Seite sichtbar ist
  if (next === 'profile' && !state.token) renderTurnstile('login');
  if (next === 'chat') pollChat(true);
  viewCleanupTimer = setTimeout(settleViews, 380);
}

$('#tabbar').addEventListener('click', e => {
  const btn = e.target.closest('.tabbtn');
  if (btn) switchView(btn.dataset.view);
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
function renderChipbar() {
  $('#chipbar').innerHTML = [
    '<div class="chip-pill" id="chip-pill"></div>',
    ...SEGMENTS.map(c => `<button class="chip ${state.activeChip === c.slug ? 'active' : ''}" data-slug="${esc(c.slug)}">${icon(c.icon)} ${esc(c.name)}</button>`),
  ].join('');
  requestAnimationFrame(moveChipPill);
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
  $('#chipbar').querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.slug === state.activeChip));
  moveChipPill();
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
      ${d.ratingCount ? `<span class="stars-value">${avg.toFixed(1)}</span> <span class="stars-count">(${d.ratingCount})</span>`
        : '<span class="stars-count">neu</span>'}
    </span>`;
}

// Interaktive Sterne fürs Sheet
function renderStarInput(d) {
  const mine = state.stars[d.id] || 0;
  return `
    <span class="stars-input" data-rate-deal="${esc(d.id)}">
      ${[1, 2, 3, 4, 5].map(i => icon('star', 'icon' + (i <= mine ? ' on' : ''))).join('')}
      <span class="stars-count">${mine ? 'deine Bewertung' : 'bewerten'}</span>
    </span>`;
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
    if (slot) slot.innerHTML = renderStars(d) + renderStarInput(d);
  }
});

// Spar-Badges: Rabatt / Gratis / Verdienst / Preisfehler – auf einen Blick
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

// Coupons-Tab: Verzeichnis der offiziellen Coupon-Quellen + GzG + Payback
function renderCoupons() {
  let animIdx = 0;
  const row = it => `
    <a class="channel-row coupon-row anim-item" style="animation-delay:${Math.min(animIdx++, 10) * 45}ms"
       href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">
      <span class="brand-chip" style="--bc:${brandColor(it.name)}">${esc(brandInitials(it.name))}</span>
      <div class="channel-info">
        <div class="channel-name">${esc(it.name)}</div>
        <div class="channel-desc">${esc(it.desc)}</div>
      </div>
      ${icon('arrow-out', 'icon icon-sm')}
    </a>`;

  const hasPayback = state.wallet.cards.some(c => /payback/i.test(c.name));
  const gzg = state.deals.filter(d => /geld.?zur(ü|ue)ck|gzg\b/i.test(d.title + ' ' + (d.excerpt || '')));

  $('#feed').innerHTML = `
    <p class="muted" style="font-size:.85rem; margin-bottom:14px; line-height:1.5">
      Die Coupons liegen in den Apps und Portalen der Anbieter – hier springst du direkt hin.
      Eingelöste Gutscheine verwaltest du in der Wallet.</p>
    ${hasPayback ? `
    <h3 class="wallet-h">Deine Payback-Coupons</h3>
    ${row({ name: 'Payback', url: 'https://www.payback.de/coupons', desc: 'Coupon-Center: eCoupons für deine verbundene Karte aktivieren' })}
    <p class="muted" style="font-size:.74rem; margin:6px 0 16px">Direkt-Sync in die App braucht die Payback-Partner-API (nicht öffentlich) – bis dahin geht es hier zum offiziellen Coupon-Center.</p>`
    : `
    <h3 class="wallet-h">Payback</h3>
    ${row({ name: 'Payback', url: 'https://www.payback.de/coupons', desc: 'Karte in der Wallet verbinden, dann findest du hier dein Coupon-Center' })}`}
    ${COUPON_SOURCES.map(sec => `
      <h3 class="wallet-h" style="margin-top:18px">${esc(sec.cat)}</h3>
      ${sec.items.map(row).join('')}`).join('')}
    <h3 class="wallet-h" style="margin-top:18px">Geld-zurück-Garantien (GzG)</h3>
    ${gzg.length
      ? gzg.map((d, i) => renderOfferCard(d, i, false)).join('')
      : '<div class="status">Aktuelle GzG-Aktionen postet die Redaktion über das Admin-Panel – sie erscheinen dann hier.</div>'}`;
}

function renderFeed(reorder = false) {
  const ch = channelBySlug(state.activeChip);
  const isCommunity = ch?.type === 'community';
  $('#community-banner').classList.toggle('hidden', !isCommunity);
  if (state.activeChip === 'coupons') { renderCoupons(); return; }

  // Sortierung nur bei Chip-Wechsel/Neuladen neu berechnen – ein Vote soll den
  // Feed nicht sofort umwürfeln, das pendelt sich beim nächsten Laden ein
  if (reorder || !state.orderIds || state.orderKey !== state.activeChip) computeOrder();
  const deals = state.orderIds
    .map(id => state.deals.find(d => d.id === id) || state.favs[id]?.deal)
    .filter(Boolean);
  const shown = deals.slice(0, FEED_LIMIT);

  if (!shown.length) {
    $('#feed').innerHTML = `<div class="status">${state.activeChip === 'saved'
      ? 'Noch nichts gespeichert – tippe auf den Stern eines Angebots oder wische die Karte nach links.'
      : state.activeChip === 'neukunden'
        ? 'Aktuell keine Neukunden-Aktionen – neue kommen über das Admin-Panel.'
        : 'Noch keine Angebote in diesem Bereich – neue kommen über das Admin-Panel.'}</div>`;
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
        ${q !== null ? `<div class="deal-fill ${q < .4 ? 'low' : ''}" style="height:${Math.round(q * 100)}%"></div>` : ''}
        <div class="offer-head">
          <span class="brand-chip" style="--bc:${brandColor(brand)}">${esc(brandInitials(brand))}</span>
          <div class="offer-brand">
            <div class="offer-merchant">${esc(brand)}</div>
            <div class="offer-cat">${esc(c?.name || 'Angebot')} · ${esc(timeAgo(d.ts))}</div>
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
        new Notification('kumulio – Deal-Erinnerung', { body: fav.deal.title.slice(0, 100) });
      }
    }
  }
}
setInterval(checkReminders, 30 * 1000);

// ---------------- Sheet (generisch) ----------------

function openSheetShell() {
  // Formulare (Hinzufügen) kompakt statt Vollbild – kein leerer Swipe-Raum
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
  // Textauswahl/Native-Drag unterbinden – aber Eingabefelder & Buttons normal lassen
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
        ${images.map(u => `<img src="${esc(u)}" alt="" draggable="false">`).join('')}
      </div>
      ${images.length > 1 ? `<div class="gallery-dots" id="gal-dots">${images.map((_, i) => `<i class="${i === 0 ? 'on' : ''}"></i>`).join('')}</div>` : ''}
    </div>` : ''}
    <div class="sheet-title">${esc(d.title)}</div>
    <div class="sheet-subrow">
      ${d.price ? `<span class="sheet-price">${esc(d.price)}</span>` : ''}
      <span style="font-size:1.05rem">${renderComparePrice(d)}</span>
      <span id="sheet-stars-slot">${renderStars(d)} ${renderStarInput(d)}</span>
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
    ${cta ? `
    <div class="sheet-cta">
      <a class="btn btn-block" href="${esc(cta)}" target="_blank" rel="noopener noreferrer">
        ${d.source === 'community' ? 'Link öffnen – auf eigene Gefahr' : 'zum Produkt'} ${icon('arrow-right', 'icon icon-sm')}
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
      <button class="votebtn" id="btn-sheet-fav">${icon('star')} ${isFav ? 'Gemerkt – entfernen' : 'Merken'}</button>
    </div>
    ${d.excerpt ? `
    <div class="sheet-section">
      <h3>Beschreibung</h3>
      <div class="sheet-desc">${esc(d.excerpt)}${d.excerpt.length >= 500 ? ' …' : ''}</div>
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
      <input id="comment-user" class="input" maxlength="24" placeholder="Dein Name (optional)" value="${esc(state.userName)}">
      <textarea id="comment-text" class="input" maxlength="600" rows="2" placeholder="Kommentar schreiben …"></textarea>
      <div class="form-row">
        <button id="btn-comment-send" class="btn">Senden</button>
        <span id="comment-msg" class="form-msg"></span>
      </div>
    </div>`;

  $('#btn-comment-send').addEventListener('click', sendComment);
  $('#btn-sheet-share')?.addEventListener('click', () => shareDeal(d));
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

async function refreshComments() {
  if (!state.currentDeal) return;
  const list = await api('/api/comments?dealId=' + state.currentDeal.id).catch(() => []);
  const box = $('#sheet-comments');
  if (!box) return;
  box.innerHTML = list.length ? list.map(c => `
    <div class="comment">
      <div class="comment-head">
        <span class="comment-user">@${esc(c.user)}</span>
        <span class="comment-time">${esc(timeAgo(c.ts))}</span>
        ${(c.flags || []).map(f => `<span class="pill pill-warn">${icon('warning', 'icon icon-sm')} ${esc(f)}</span>`).join('')}
      </div>
      <div class="comment-text">${esc(c.text)}</div>
    </div>`).join('')
    : '<div class="status">Noch keine Kommentare – sei der Erste.</div>';
}

async function sendComment() {
  const msg = $('#comment-msg');
  msg.className = 'form-msg';
  try {
    state.userName = $('#comment-user').value.trim();
    localStorage.setItem('ra.user', state.userName);
    await api('/api/comments', {
      method: 'POST',
      body: JSON.stringify({ dealId: state.currentDeal.id, user: state.userName, text: $('#comment-text').value }),
    });
    $('#comment-text').value = '';
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
      daneben stehen – so viele oder wenige du willst.</p>
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

// Goldener Stern oben (aktuell aus dem Header entfernt – Gespeichert bleibt über Karten-Sterne erreichbar)
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
  $('#bio-card').classList.toggle('hidden', !state.token);
  if (state.token) { $('#me-name').textContent = state.userName; refreshGami(); }
  renderWallet(); // Wallet-Sperre folgt dem Login-Status
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
  // Rang aus dem Wallet auch im Profil zeigen
  const rank = rankFor(renderWallet.lastTotal || 0);
  $('#g-rank-row').innerHTML = `<span class="rank-chip">${esc(rank.name)}</span>
    <span class="rank-next">Wallet-Rang – wächst mit deinem Guthaben</span>`;
  $('#g-badges').innerHTML = (myProfile.badges || []).length
    ? myProfile.badges.map(id => badgeChip(id, myProfile.badgesAll[id], id === myProfile.activeBadge)).join('')
    : '<span class="form-msg">Noch keine Badges – öffne eine Kiste.</span>';
  $('#g-badges').querySelectorAll('[data-badge]').forEach(b => b.onclick = async () => {
    const next = myProfile.activeBadge === b.dataset.badge ? '' : b.dataset.badge;
    await api('/api/profile', { method: 'POST', body: JSON.stringify({ activeBadge: next }) }).catch(() => { });
    myProfile.activeBadge = next;
    refreshGami();
    island(next ? 'Badge wird im Chat getragen' : 'Badge abgelegt');
  });
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
    playSfx('kaching'); buzz(30); moneyFlash('green');
    animateInt($('#g-coins'), r.coins - r.gained, r.coins);
    m.className = 'form-msg ok';
    m.textContent = `+${r.gained} Coins! Serie: ${r.streak} Tag${r.streak > 1 ? 'e' : ''}.`;
    myProfile && (myProfile.coins = r.coins);
  } catch (e) { m.className = 'form-msg error'; m.textContent = e.message; }
  finally { setBtnLoading($('#g-daily'), false); }
});
$('#g-chest').addEventListener('click', async () => {
  const m = $('#g-msg'); const out = $('#g-chest-result');
  setBtnLoading($('#g-chest'), true);
  try {
    const r = await api('/api/chest', { method: 'POST', body: '{}' });
    playSfx('kaching'); buzz([40, 30, 60]); moneyFlash('green');
    animateInt($('#g-coins'), (myProfile?.coins ?? r.coins + 100), r.coins);
    out.classList.remove('hidden');
    out.innerHTML = `<div class="chest-reveal">${badgeChip(r.badge, { name: r.name, icon: r.icon, rar: r.rar }, false)}
      <span>${r.dupe ? 'Schon vorhanden – dafür +40 Coins zurück!' : `Neues Badge (${esc(r.rar)})!`}</span></div>`;
    m.textContent = '';
    refreshGami();
  } catch (e) { m.className = 'form-msg error'; m.textContent = e.message; }
  finally { setBtnLoading($('#g-chest'), false); }
});
$('#g-bio-save').addEventListener('click', async () => {
  const m = $('#g-bio-msg');
  try {
    const r = await api('/api/profile', {
      method: 'POST',
      body: JSON.stringify({ bio: $('#g-bio').value, publicProfile: $('#g-public').checked }),
    });
    $('#g-bio').value = r.bio; // Server-Fassung (ggf. zensiert) zurückspiegeln
    m.className = 'form-msg ok'; m.textContent = 'Gespeichert.';
  } catch (e) { m.className = 'form-msg error'; m.textContent = e.message; }
});

$('#btn-profile-top').addEventListener('click', () => {
  if (state.activeView !== 'profile') switchView('profile');
});

// Cloudflare Turnstile: etabliertes Captcha für Login und Registrierung
const tsWidgets = { login: null, reg: null };
let tsSitekey = null;
const tsTries = { login: 0, reg: 0 };
function renderTurnstile(which) {
  const el = $('#ts-' + which);
  if (!el) return;
  // Erst rendern, wenn Sitekey UND Cloudflare-Script da sind – sonst kurz warten
  if (!tsSitekey || !window.turnstile) {
    if (++tsTries[which] > 40) {
      el.innerHTML = '<span class="form-msg error">Captcha-Widget lädt nicht (Netzwerk/Werbeblocker?) – ohne Bestätigung ist keine Anmeldung möglich.</span>';
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

// Overlays weich schließen (statt hart zu verschwinden)
function hideOverlay(el) {
  if (!el || el.classList.contains('hidden')) return;
  el.classList.add('closing');
  setTimeout(() => { el.classList.add('hidden'); el.classList.remove('closing'); }, 280);
}

// Button zeigt beim Warten den pulsierenden kumulio-Punkt
function setBtnLoading(btn, on) {
  if (!btn) return;
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

$('#btn-theme').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
});

// ---------------- Fullscreen-Onboarding beim ersten Start ----------------
// Splash und Tutorial sind ein Fluss: Logo animiert, rutscht nach oben,
// dann wird der Nutzer Schritt für Schritt begrüßt und zum Konto geführt.

// Jeder Step zeigt die Möglichkeit als kleines Stück echter UI (visual)
const OB_STEPS = [
  { title: 'Schön, dass du da bist.', text: 'kumulio ist deine kuratierte Spar-App: handverlesene Angebote, deine Gutschein-Wallet und alle Coupons an einem Ort – ohne Deal-Spam.', cta: 'Los geht’s' },
  {
    title: 'Sparen & Verdienen', text: 'Oben wechselst du zwischen Sparen, Verdienen und Neukunden-Aktionen – sauber getrennt, damit du sofort findest, was du suchst.', cta: 'Weiter',
    visual: () => `
      <span class="chip active">${icon('gift')} Sparen</span>
      <span class="chip">${icon('banknote')} Verdienen</span>
      <span class="chip">${icon('sparkle')} Neukunden</span>`,
  },
  {
    title: 'Deine Wallet', text: 'Gutschein fotografieren, Felder füllen sich automatisch. Restguthaben abbuchen, PIN und Barcode griffbereit – und Sparkarten wie Payback immer dabei.', cta: 'Weiter',
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
    title: 'Coupons & Merken', text: 'Der Coupons-Tab bündelt Rossmann, Lidl Plus, McDonald’s & Co. Mit dem Stern merkst du dir Angebote – auf Wunsch mit Erinnerung, bevor sie ablaufen.', cta: 'Weiter',
    visual: () => ['Rossmann', 'Lidl', 'McDonalds', 'Payback'].map(b =>
      `<span class="brand-chip" style="--bc:${brandColor(b)}">${esc(brandInitials(b))}</span>`).join('')
      + `<span class="ob-star">${icon('star')}</span>`,
  },
  {
    title: 'Bleib verbunden.', text: 'Mit deinem Profil sicherst du Wallet und Bewertungen. Den Newsletter kannst du optional dazunehmen – damit du keinen Top-Deal verpasst.', cta: 'Konto erstellen', final: true,
    visual: () => `
      <span class="avatar-mini" style="width:34px;height:34px;font-size:1rem">du</span>
      <span class="pill pill-accent">${icon('bell', 'icon icon-sm')} Newsletter optional</span>`,
  },
];
let obStep = 0;

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
    <button class="ob-alt" id="ob-continue">Ohne Konto fortfahren</button>
    <p class="legal-line">Mit dem Konto akzeptierst du die
      <a href="/agb.html" target="_blank" rel="noopener">AGB</a> und die
      <a href="/datenschutz.html" target="_blank" rel="noopener">Datenschutzerklärung</a>.</p>` : '';
  $('#ob-continue')?.addEventListener('click', () => finishOnboarding(false));
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
  // Der Session-Splash entfällt – das Onboarding trägt den Markenmoment (kumulio-Punkt fällt)
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

// Wallet: lokal speichern + (angemeldet) ans Konto syncen – Gutscheine überleben
// so App-Neuinstallation und Gerätewechsel
let walletSyncTimer = null;
function saveWallet() {
  save('wallet', state.wallet);
  renderWallet();
  if (state.token) {
    clearTimeout(walletSyncTimer);
    walletSyncTimer = setTimeout(() => {
      api('/api/wallet', { method: 'POST', body: JSON.stringify(state.wallet) }).catch(() => { });
    }, 800);
  }
}
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
    saveWallet(); // lokal sichern + Mergestand zurück zum Server
  } catch { }
}
function euroFmt(n) { return n == null ? '' : n.toFixed(2).replace('.', ',') + ' €'; }

// ---- Spielgefühl: Sounds, Vibration, Aufleuchten, Geldscheine, Zähl-Animation ----

const SFX = { kaching: '/sounds/kaching.mp3', pay: '/sounds/pay.mp3' };
// WebAudio: Sounds vorgeladen und ohne Anlauf-Stille – spielen sofort beim Tipp
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
      return;
    } catch { }
  }
  try { const a = new Audio(SFX[name]); a.volume = 0.55; a.play().catch(() => { }); } catch { }
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

// Code aus eingefügtem Text erkennen (regelbasiert – echte KI folgt mit dem Backend)
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
function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 900;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      resolve(cv.toDataURL('image/jpeg', 0.82));
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

// Bekannte Shops für die manuelle Schnell-Auswahl
const VENDOR_QUICK = ['REWE', 'Amazon', 'Wunschgutschein', 'Zalando', 'IKEA', 'Rossmann', 'Lidl', 'EDEKA'];

// Bild automatisch auslesen: QR/Barcode (BarcodeDetector) + Text (TextDetector, wo verfügbar).
// Volle KI-Auslese (Claude Vision) kommt mit dem Live-Backend.
async function analyzeWalletImage(dataUrl) {
  const out = { barcode: '', codeImg: '', text: '', supported: { barcode: 'BarcodeDetector' in window, text: 'TextDetector' in window } };
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  if (out.supported.barcode) {
    try {
      const codes = await new BarcodeDetector().detect(img);
      if (codes.length) {
        out.barcode = codes[0].rawValue || '';
        // Kassen-Code ausschneiden: nur der Barcode/QR, großzügig gepolstert –
        // den hält man an der Kasse hin, perfekt lesbar statt Mini-Ausschnitt im Foto
        const bb = codes[0].boundingBox;
        if (bb && bb.width > 20 && bb.height > 10) {
          const padX = bb.width * 0.14, padY = bb.height * 0.35;
          const x = Math.max(0, bb.x - padX), y = Math.max(0, bb.y - padY);
          const w = Math.min(img.naturalWidth - x, bb.width + padX * 2);
          const h = Math.min(img.naturalHeight - y, bb.height + padY * 2);
          const c = document.createElement('canvas');
          const scale = Math.min(2, 900 / w); // hochskalieren für Scanner-Schärfe
          c.width = Math.round(w * scale); c.height = Math.round(h * scale);
          c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, c.width, c.height);
          out.codeImg = c.toDataURL('image/png');
        }
      }
    } catch { }
  }
  if (out.supported.text) {
    try {
      const blocks = await new TextDetector().detect(img);
      out.text = blocks.map(b => b.rawValue).join('\n');
    } catch { }
  }
  return out;
}

function openWalletAdd(type, prefillName) {
  if (!state.token) { switchView('profile'); island('Für die Wallet bitte anmelden'); return; }
  if (type) addType = type;
  addPrefill = prefillName || '';
  state.sheetMode = 'wallet-add';
  addImg = '';
  addCodeImg = '';
  $('#sheet-content').innerHTML = `
    <div class="sheet-title">Zur Wallet hinzufügen</div>
    <div class="seg-type">
      <button class="btn btn-ghost ${addType === 'voucher' ? 'on' : ''}" data-wtype="voucher">Gutschein</button>
      <button class="btn btn-ghost ${addType === 'card' ? 'on' : ''}" data-wtype="card">Sparkarte</button>
    </div>

    <!-- Bild zuerst: hochladen oder direkt fotografieren, Felder füllen sich automatisch -->
    <div class="dropzone" id="wa-drop">
      <div class="dropzone-empty" id="wa-drop-empty">
        ${icon('plus', 'icon')}
        <span>Screenshot oder Foto vom Gutschein / der Karte</span>
      </div>
      <img id="wa-preview" class="wallet-img hidden" alt="">
      <div class="form-row" style="justify-content:center">
        <label class="btn btn-small btn-ghost" style="cursor:pointer">Bild hochladen
          <input id="wa-img" type="file" accept="image/*" style="display:none"></label>
        <label class="btn btn-small btn-ghost" style="cursor:pointer">Foto aufnehmen
          <input id="wa-cam" type="file" accept="image/*" capture="environment" style="display:none"></label>
      </div>
      <div id="wa-ai-msg" class="form-msg" style="text-align:center"></div>
    </div>

    <div id="wa-voucher" class="${addType === 'card' ? 'hidden' : ''}">
      <div class="vendor-quick" id="wa-vendor-quick">
        ${VENDOR_QUICK.map(v => `<button class="chip chip-vendor" data-vq="${esc(v)}">${esc(v)}</button>`).join('')}
      </div>
      <div class="form-row">
        <input id="wa-vendor" class="input" maxlength="30" placeholder="Shop (oder oben antippen)">
        <input id="wa-amount" class="input" inputmode="decimal" placeholder="Wert (€)">
      </div>
      <div class="form-row">
        <input id="wa-code" class="input" maxlength="40" placeholder="Code">
        <input id="wa-pin" class="input" maxlength="16" placeholder="PIN">
      </div>
      <input id="wa-end" class="input" type="date" title="Gültig bis (optional)">
      <textarea id="wa-paste" class="input" rows="2" placeholder="Oder Gutschein-Text einfügen – Code wird erkannt"></textarea>
      <div class="form-row">
        <button id="wa-detect" class="btn btn-ghost btn-small">Code aus Text erkennen</button>
        <span id="wa-detect-msg" class="form-msg"></span>
      </div>
    </div>
    <div id="wa-card" class="${addType === 'voucher' ? 'hidden' : ''}">
      <div class="form-row">
        <input id="wa-cname" class="input" maxlength="30" placeholder="Karte (Payback, Lidl Plus, IKEA Family …)" value="${esc(addType === 'card' ? addPrefill : '')}">
        <input id="wa-cnumber" class="input" maxlength="30" placeholder="Kartennummer">
      </div>
    </div>
    <div class="form-row">
      <button id="wa-save" class="btn">Speichern</button>
      <span id="wa-msg" class="form-msg"></span>
    </div>`;

  $('#sheet-content').querySelectorAll('[data-wtype]').forEach(b => b.addEventListener('click', () => {
    openWalletAdd(b.dataset.wtype);
  }));
  $('#sheet-content').querySelectorAll('[data-vq]').forEach(b => b.addEventListener('click', () => {
    $('#wa-vendor').value = b.dataset.vq;
  }));
  $('#wa-detect')?.addEventListener('click', () => {
    const code = detectCode($('#wa-paste').value);
    const m = $('#wa-detect-msg');
    if (code) { $('#wa-code').value = code; m.className = 'form-msg ok'; m.textContent = 'Code erkannt: ' + code; }
    else { m.className = 'form-msg error'; m.textContent = 'Keinen Code gefunden.'; }
  });

  const onImage = async e => {
    const f = e.target.files[0];
    const m = $('#wa-ai-msg');
    if (!f) return;
    try {
      addImg = await readImageFile(f);
      $('#wa-preview').src = addImg;
      $('#wa-preview').classList.remove('hidden');
      $('#wa-drop-empty').classList.add('hidden');
      m.className = 'form-msg';
      m.textContent = 'Lese das Bild aus …';
      const r = await analyzeWalletImage(addImg);
      if (r.codeImg) { addCodeImg = r.codeImg; $('#wa-preview').src = r.codeImg; }
      const filled = [];
      if (addType === 'voucher') {
        if (r.barcode && !$('#wa-code').value) { $('#wa-code').value = r.barcode.slice(0, 40); filled.push('Code (aus QR/Barcode)'); }
        if (r.text) {
          const pin = r.text.match(/\bpin\b[^0-9]{0,6}(\d{3,10})/i);
          if (pin && !$('#wa-pin').value) { $('#wa-pin').value = pin[1]; filled.push('PIN'); }
          const amt = r.text.match(/(\d{1,4}[.,]\d{2})\s*€|\b(\d{1,3})\s*(?:€|EUR)\b/i);
          if (amt && !$('#wa-amount').value) { $('#wa-amount').value = (amt[1] || amt[2]).replace('.', ','); filled.push('Wert'); }
          if (!r.barcode && !$('#wa-code').value) {
            const code = detectCode(r.text);
            if (code) { $('#wa-code').value = code; filled.push('Code'); }
          }
          const low = r.text.toLowerCase();
          if (!$('#wa-vendor').value) {
            const hit = [...VENDOR_QUICK.map(v => v.toLowerCase()), ...Object.keys(BRAND_COLORS)].find(k => low.includes(k));
            if (hit) { $('#wa-vendor').value = hit.charAt(0).toUpperCase() + hit.slice(1); filled.push('Shop'); }
          }
        }
      } else {
        if (r.barcode && !$('#wa-cnumber').value) { $('#wa-cnumber').value = r.barcode.slice(0, 30); filled.push('Kartennummer (aus Barcode)'); }
        else if (r.text) {
          const num = (r.text.match(/\d[\d ]{8,24}\d/g) || []).sort((a, b) => b.length - a.length)[0];
          if (num && !$('#wa-cnumber').value) { $('#wa-cnumber').value = num.replace(/\s+/g, ''); filled.push('Kartennummer'); }
        }
      }
      if (r.codeImg) filled.push('Kassen-Code ausgeschnitten');
      if (filled.length) {
        m.className = 'form-msg ok';
        m.textContent = `Automatisch ausgefüllt: ${filled.join(', ')} – bitte prüfen.`;
      } else if (!r.supported.barcode && !r.supported.text) {
        m.className = 'form-msg';
        m.textContent = 'Bild gespeichert. Automatische Auslese kann dieser Browser nicht – volle KI-Auslese kommt mit dem Backend.';
      } else {
        m.className = 'form-msg';
        m.textContent = 'Bild gespeichert – nichts sicher erkannt, bitte Felder ausfüllen.';
      }
    } catch {
      m.className = 'form-msg error';
      m.textContent = 'Bild konnte nicht gelesen werden.';
    }
  };
  $('#wa-img').addEventListener('change', onImage);
  $('#wa-cam').addEventListener('change', onImage);
  $('#wa-save').addEventListener('click', () => {
    const msg = $('#wa-msg');
    if (addType === 'voucher') {
      const amount = parseFloat($('#wa-amount').value.replace(',', '.'));
      const v = {
        id: Math.random().toString(36).slice(2, 9),
        vendor: $('#wa-vendor').value.trim().slice(0, 30),
        code: $('#wa-code').value.trim().slice(0, 40),
        pin: $('#wa-pin').value.trim().slice(0, 16),
        end: $('#wa-end').value || '',
        amount: isNaN(amount) ? null : amount,
        balance: isNaN(amount) ? null : amount,
        img: addImg, codeImg: addCodeImg, tx: [],
      };
      if (!v.vendor || !v.code) { msg.className = 'form-msg error'; msg.textContent = 'Anbieter und Code sind Pflicht.'; return; }
      state.wallet.vouchers.unshift(v);
    } else {
      const c = {
        id: Math.random().toString(36).slice(2, 9),
        name: $('#wa-cname').value.trim().slice(0, 30),
        number: $('#wa-cnumber').value.trim().slice(0, 30),
        img: addImg, codeImg: addCodeImg,
      };
      if (!c.name || !c.number) { msg.className = 'form-msg error'; msg.textContent = 'Name und Nummer sind Pflicht.'; return; }
      state.wallet.cards.unshift(c);
    }
    saveWallet();
    closeSheet();
    // Ka-ching! Neues Guthaben in der Wallet
    playSfx('kaching');
    buzz(35);
    moneyFlash('green');
    billRain(7);
    island('In der Wallet gespeichert');
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
      <button class="fav-remove" id="wv-del" aria-label="Löschen">${icon('x', 'icon icon-sm')}</button>
    </div>
    ${v.balance != null ? `<div class="balance-big" style="margin-top:12px"><span id="wv-balance">${euroFmt(v.balance)}</span>
      ${v.amount != null && v.amount !== v.balance ? `<span class="stars-count">von ${euroFmt(v.amount)}</span>` : ''}</div>` : ''}
    <div class="tx-row" style="margin-top:12px">
      <span class="wallet-code" style="flex:1">${esc(v.code)}</span>
      <button class="btn btn-small" data-copy-txt="${esc(v.code)}">Code kopieren</button>
    </div>
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
        <button id="wv-sub" class="btn">− Abbuchen</button>
        <button id="wv-addamt" class="btn btn-ghost">+ Aufladen</button>
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
    </div>` : ''}`;

  $('#sheet-content').querySelectorAll('[data-copy-txt]').forEach(b => b.addEventListener('click', () => copyText(b.dataset.copyTxt)));
  $('#wv-del').addEventListener('click', () => {
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
      msg.textContent = `Nur noch ${euroFmt(v.balance)} drauf – mehr geht nicht.`;
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
      // Ein kurzer, kleiner Ruckler am Inhalt – nicht am Sheet selbst
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
      <button class="fav-remove" id="wc-del" aria-label="Löschen">${icon('x', 'icon icon-sm')}</button>
    </div>
    <div class="tx-row" style="margin-top:12px">
      <span class="wallet-code" style="flex:1">${esc(c.number)}</span>
      <button class="btn btn-small" data-copy-txt="${esc(c.number)}">Kopieren</button>
    </div>
    ${c.codeImg ? `<img class="wallet-code-img" src="${c.codeImg}" alt="Code für die Kasse">`
      : c.img ? `<img class="wallet-img" src="${c.img}" alt="QR/Barcode">`
      : '<p class="muted" style="margin-top:10px; font-size:.82rem">Tipp: Screenshot vom Karten-Barcode anhängen (beim Anlegen), dann kannst du ihn an der Kasse scannen lassen.</p>'}`;
  $('#sheet-content').querySelectorAll('[data-copy-txt]').forEach(b => b.addEventListener('click', () => copyText(b.dataset.copyTxt)));
  $('#wc-del').addEventListener('click', () => {
    state.wallet.cards = state.wallet.cards.filter(x => x.id !== id);
    saveWallet(); closeSheet(); island('Karte gelöscht');
  });
  openSheetShell();
}

function renderWallet() {
  // Wallet nur mit Profil: Gast sieht die Anmelde-Sperre
  const gated = !state.token;
  $('#wallet-gate').classList.toggle('hidden', !gated);
  $('#wallet-content').classList.toggle('hidden', gated);
  if (gated) return;

  const allActive = state.wallet.vouchers.filter(v => v.balance == null || v.balance > 0);
  const used = state.wallet.vouchers.filter(v => v.balance != null && v.balance <= 0);

  // Suche (Shop, Code, PIN, Buchungs-Notizen) + Filter-Chips
  const q = (state.walletQuery || '').trim().toLowerCase();
  const vMatch = v => !q
    || v.vendor.toLowerCase().includes(q)
    || v.code.toLowerCase().includes(q)
    || (v.pin || '').toLowerCase().includes(q)
    || (v.tx || []).some(t => (t.note || '').toLowerCase().includes(q));
  const soon = Date.now() + 30 * 864e5;
  const fMatch = v =>
    state.walletFilter === 'guthaben' ? v.balance != null && v.balance > 0
    : state.walletFilter === 'ablauf' ? v.end && Date.parse(v.end) < soon
    : true;
  const active = allActive.filter(v => vMatch(v) && fMatch(v));

  // Kontostand: Summe ALLER Restguthaben (unabhängig von Suche/Filter) – zählt animiert
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
  const vCard = v => `
    <div class="wallet-card" data-wv="${esc(v.id)}" style="--bc:${brandColor(v.vendor)}">
      <div class="wallet-card-head">
        <span class="brand-chip" style="--bc:rgba(255,255,255,.22)">${esc(brandInitials(v.vendor))}</span>
        <span class="wallet-card-name">${esc(v.vendor)}</span>
        ${v.balance != null ? `<span class="wallet-card-balance">${euroFmt(v.balance)}</span>` : ''}
      </div>
      <div class="wallet-card-sub">
        <span>${esc(v.code)}</span>
        ${v.pin ? '<span class="pill">PIN</span>' : ''}
        ${v.img ? '<span class="pill">QR/Barcode</span>' : ''}
        ${v.end ? `<span class="pill">bis ${new Date(v.end).toLocaleDateString('de-DE')}</span>` : ''}
      </div>
    </div>`;
  // Hinzufügen als Banner direkt in der Liste – fettes Plus statt Logo
  const addBanner = (type, label) => `
    <button class="wallet-card wallet-card-add" data-wadd="${type}">
      <span class="wallet-add-plus">${icon('plus')}</span>
      <span class="wallet-add-label">${label}</span>
    </button>`;

  $('#voucher-list').innerHTML =
    (active.length || !(q || state.walletFilter && state.walletFilter !== 'alle')
      ? active.map(vCard).join('')
      : '<div class="status">Kein Gutschein passt zu Suche/Filter.</div>')
    + addBanner('voucher', 'Gutschein hinzufügen');
  $('#voucher-used').innerHTML = used.map(vCard).join('') || '<div class="status">Nichts aufgebraucht.</div>';
  $('#used-count').textContent = used.length ? `(${used.length})` : '';

  const hasPayback = state.wallet.cards.some(c => /payback/i.test(c.name));
  const cardsShown = state.wallet.cards.filter(c => !q
    || c.name.toLowerCase().includes(q) || c.number.toLowerCase().includes(q));
  $('#cardw-list').innerHTML = cardsShown.map(c => `
    <div class="wallet-card" data-wc="${esc(c.id)}" style="--bc:${brandColor(c.name)}">
      <div class="wallet-card-head">
        <span class="brand-chip" style="--bc:rgba(255,255,255,.22)">${esc(brandInitials(c.name))}</span>
        <span class="wallet-card-name">${esc(c.name)}</span>
        ${c.img ? '<span class="pill">QR/Barcode</span>' : ''}
      </div>
      <div class="wallet-card-sub"><span>${esc(c.number)}</span></div>
    </div>`).join('')
    + addBanner('card', 'Sparkarte hinzufügen')
    + (!hasPayback ? `
    <button class="wallet-card wallet-card-add wallet-card-suggest" data-wadd-prefill="Payback" style="--bc:${brandColor('payback')}">
      <span class="brand-chip" style="--bc:${brandColor('payback')}">PB</span>
      <span class="wallet-add-label">Payback-Karte verbinden</span>
      <span class="wallet-add-plus small">${icon('plus', 'icon icon-sm')}</span>
    </button>` : '');

  $('#view-wallet').querySelectorAll('[data-wv]').forEach(el => el.onclick = () => openVoucherSheet(el.dataset.wv));
  $('#view-wallet').querySelectorAll('[data-wc]').forEach(el => el.onclick = () => openCardSheet(el.dataset.wc));
  $('#view-wallet').querySelectorAll('[data-wadd]').forEach(el => el.onclick = () => openWalletAdd(el.dataset.wadd));
  $('#view-wallet').querySelectorAll('[data-wadd-prefill]').forEach(el => el.onclick = () => openWalletAdd('card', el.dataset.waddPrefill));
}

// Wallet-Suche + Filter-Chips (statisches Markup – einmal verdrahten)
$('#wallet-search')?.addEventListener('input', e => {
  state.walletQuery = e.target.value;
  renderWallet();
});
document.querySelectorAll('[data-wfilter]').forEach(b => b.addEventListener('click', () => {
  state.walletFilter = b.dataset.wfilter;
  document.querySelectorAll('[data-wfilter]').forEach(x => x.classList.toggle('active', x === b));
  renderWallet();
}));

$('#btn-home').addEventListener('click', () => {
  state.activeChip = 'sparen';
  renderChipbar();
  renderFeed();
  if (state.activeView !== 'feed') switchView('feed');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ---------------- Global-Chat (Twitch-artig) ----------------

let chatEmotes = {};
let chatBadges = {};
let chatLastTs = 0;

const CHAT_COLORS = ['#e91e63', '#9c27b0', '#3f51b5', '#03a9f4', '#009688', '#4caf50', '#ff9800', '#f44336', '#8d6e63', '#607d8b'];
function chatColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CHAT_COLORS[h % CHAT_COLORS.length];
}
function emoteHtml(name) {
  return `<img class="emote" src="https://cdn.7tv.app/emote/${chatEmotes[name]}/2x.webp" alt="${esc(name)}" title="${esc(name)}" loading="lazy">`;
}
function chatMsgHtml(m) {
  let text = esc(m.text);
  for (const name of Object.keys(chatEmotes)) {
    text = text.replace(new RegExp(`\\b${name}\\b`, 'g'), emoteHtml(name));
  }
  const badge = m.badge && chatBadges[m.badge]
    ? `<svg class="icon icon-sm chat-badge" aria-label="${esc(chatBadges[m.badge].name)}"><use href="#i-${chatBadges[m.badge].icon}"/></svg>`
    : '';
  return `<div class="chat-msg" data-mid="${esc(m.id)}">
    ${badge}<span class="chat-user" style="color:${chatColor(m.user)}">${esc(m.user)}</span>
    <span class="chat-text">${text}</span>
  </div>`;
}
async function pollChat(force) {
  if (!force && state.activeView !== 'chat') return;
  try {
    const r = await api('/api/chat?since=' + chatLastTs);
    chatEmotes = r.emotes || chatEmotes;
    chatBadges = r.badges || chatBadges;
    if (r.messages.length) {
      const box = $('#chat-box'), list = $('#chat-list');
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
      r.messages.forEach(m => {
        list.insertAdjacentHTML('beforeend', chatMsgHtml(m));
        chatLastTs = Math.max(chatLastTs, m.ts);
      });
      while (list.children.length > 200) list.firstChild.remove();
      if (nearBottom || !box.dataset.scrolled) box.scrollTop = box.scrollHeight;
      box.dataset.scrolled = '1';
    }
  } catch { }
}
async function sendChat() {
  const inp = $('#chat-input');
  const text = inp.value.trim();
  if (!text) return;
  if (!state.token) { switchView('profile'); island('Zum Chatten bitte anmelden'); return; }
  try {
    const r = await api('/api/chat', { method: 'POST', body: JSON.stringify({ text }) });
    inp.value = '';
    $('#chat-list').insertAdjacentHTML('beforeend', chatMsgHtml(r.message));
    chatLastTs = Math.max(chatLastTs, r.message.ts);
    $('#chat-box').scrollTop = $('#chat-box').scrollHeight;
  } catch (e) { island(e.message); }
}
function toggleEmotes() {
  const el = $('#chat-emotes');
  if (el.classList.contains('hidden')) {
    el.innerHTML = Object.keys(chatEmotes).length
      ? Object.keys(chatEmotes).map(n => `<button class="emote-pick" data-emote="${esc(n)}">${emoteHtml(n)}</button>`).join('')
      : '<span class="form-msg">Emotes laden …</span>';
    el.classList.remove('hidden');
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
setInterval(pollChat, 3000);

// ---------------- Start ----------------

// Als Home-Bildschirm-App: Pinch-Zoom (iOS-Geste) komplett blocken –
// Doppeltipp-Zoom verhindert touch-action in style.css
['gesturestart', 'gesturechange', 'gestureend'].forEach(t =>
  document.addEventListener(t, e => e.preventDefault(), { passive: false }));

(async function init() {
  refreshProfileTab();
  renderWallet();
  initTurnstile();
  if (state.token) {
    api('/api/me').then(r => { state.userName = r.user; refreshProfileTab(); pullWallet(); })
      .catch(() => { state.token = ''; localStorage.removeItem('ra.token'); refreshProfileTab(); });
  }
  moveTabPill();
  setTimeout(moveTabPill, 300); // nach Font-Laden nachjustieren
  renderSearch();
  maybeShowOnboarding();
  state.channels = await api('/api/channels');
  renderChipbar();
  loadFeed();
  checkReminders();
  // App ist bereit → der kumulio-Splash darf weg, sobald seine Animation durch ist
  window.KBrandReady?.then(K => K.appReady());
})();
