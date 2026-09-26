// kumulio, Frontend-Logik (Vanilla JS, kein Framework)

const $ = sel => document.querySelector(sel);

// API-Basis: im Web leer (gleiche Origin). In der iOS/Android-App (Capacitor)
// zeigt sie auf den gehosteten Server, in index.html RA_API_BASE setzen.
const API_BASE = (window.RA_API_BASE || localStorage.getItem('ra.apiBase') || '').replace(/\/$/, '');
// localStorage kann voll oder gesperrt sein (privates Fenster): Schreiben darf
// dann nie einen ganzen Ablauf abbrechen, Lesen nie den Start
function lsSetzen(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } }
function lsJson(k, fallback) {
  try { const t = localStorage.getItem(k); return t ? JSON.parse(t) : fallback; } catch { return fallback; }
}
const state = {
  channels: [],
  follows: JSON.parse(localStorage.getItem('ra.follows') || 'null'), // null = Onboarding nötig
  stars: JSON.parse(localStorage.getItem('ra.stars') || '{}'),       // { dealId: 1..5 }
  wallet: { vouchers: [], cards: [], deleted: [], ...lsJson('ra.wallet', {}) },
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
  sheetMode: null, // offenes Blatt, z. B. 'brand' | 'admin-post' (Deals sind seit Runde 120 eine eigene Seite)
  userName: localStorage.getItem('ra.user') || '',
  token: localStorage.getItem('ra.token') || '',
  featured: [],
  notif: JSON.parse(localStorage.getItem('ra.notif') || '{"msgs":true,"reminder":true}'),
  // Wallet-Filter bleiben eingestellt, bis man sie selbst wieder aendert
  ...JSON.parse(localStorage.getItem('ra.walletFilter') || '{"walletFilter":"","walletSort":"","walletVal":0}'),
};
function saveWalletFilter() {
  lsSetzen('ra.walletFilter', JSON.stringify({
    walletFilter: state.walletFilter || '',
    walletSort: state.walletSort || '',
    walletVal: state.walletVal || 0,
  }));
}

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
  lsSetzen('ra.theme', t);
  const sw = document.getElementById('sw-theme');
  if (sw) sw.checked = t === 'dark';
  setzeLeistenfarbe();
}

// Die Statusleiste der installierten App traegt die Farbe aus <meta theme-color>.
// Die stand fest auf Gruen — bei einer anderen Wallet-Stufe (Gold, Violett)
// klebte darueber ein gruener Streifen, der aussah wie eine zweite Kopfzeile.
// Jetzt traegt sie dieselbe Farbe wie der obere Rand des Kopfes, und ausserhalb
// der Wallet den Seitengrund.
// Runde 126: auch in der Wallet den Seitengrund, sobald der Kopf weggescrollt
// ist — die Farbe laeuft unter dem Kopf aus, die Kopfzeile ist dann Milchglas
// auf hellem (bzw. dunklem) Grund, und darueber stuende sonst ein Farbstreifen.
function setzeLeistenfarbe() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const st = getComputedStyle(document.documentElement);
  // Auch die Sperre traegt den Rang-Verlauf
  const inWallet = document.body.classList.contains('wallet-zu')
    || (document.body.classList.contains('wallet-farbe') && !document.body.classList.contains('kopf-weg'));
  const markenfarbe = document.body.classList.contains('marken-modus') && !document.body.classList.contains('wallet-zu')
    ? st.getPropertyValue('--marke-k1').trim() : '';
  const farbe = inWallet
    ? (markenfarbe || st.getPropertyValue('--kopf-k1').trim() || '#405A7C')
    : (getComputedStyle(document.body).backgroundColor || '#EEF1F5');
  if (meta.content !== farbe) meta.content = farbe;
}
// Der Seitengrund blendet beim Verlassen der Wallet .35 s lang aus der
// Rangfarbe ueber (look.css, body transition) — beim Umschalten steht darum
// noch die Wallet-Farbe im Grund. Am Ende des Uebergangs nachziehen, sonst
// bliebe die Leiste im Feed/Profil in der Rangfarbe stehen.
document.addEventListener('transitionend', e => {
  if (e.target === document.body && e.propertyName === 'background-color') setzeLeistenfarbe();
});
applyTheme(localStorage.getItem('ra.theme')
  || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

const VIEW_ORDER = ['feed', 'wallet', 'chat', 'profile', 'search', 'settings', 'friends', 'user', 'inventory', 'shop', 'gifts', 'invite', 'editprofile'];
const FEED_LIMIT = 40;

// Menüpunkte oben: Sparen / Verdienen / Neukunden / Coupons.
// "Gespeichert" läuft nur noch über den Gold-Stern oben rechts.
const SEGMENTS = [
  { slug: 'fuer-dich', name: 'Für dich', icon: 'star' },
  { slug: 'sparen', name: 'Sparen', icon: 'gift' },
  { slug: 'verdienen', name: 'Verdienen', icon: 'banknote' },
  { slug: 'neukunden', name: 'Neukunden', icon: 'sparkle' },
];

// Händler-Apps: android/ios führen in die installierte App, url ist der Rückweg
// über die Webseite. rotierend = der Code wechselt ständig (dann bringt
// "Coupons aktivieren" nichts), woche = wöchentliche Belohnung in der App.
// Händler-Apps. `android` ist der Play-Store-Paketname (damit startet intent://
// die App zuverlässig). Auf iPhones gibt es keine dokumentierten URL-Schemas für
// diese Apps — dort greifen nur Universal Links, und die funktionieren
// ausschliesslich fuer die Pfade, die der Haendler in seiner
// apple-app-site-association listet. `iosUrl` ist deshalb, wo noetig, eine
// andere Adresse als der Web-Rueckweg `url` — nachgeschlagen, nicht geraten.
// Wo kein passender Pfad gelistet ist, oeffnet sich auf dem iPhone die Webseite;
// das laesst sich ohne Schema-Raterei nicht aendern.
// rotierend = der Code wechselt staendig, "Coupons aktivieren" bringt nichts.
// woche = woechentliche Belohnung in der App, an die wir erinnern.
const CARD_APPS = {
  rossmann: {
    url: 'https://www.rossmann.de/de/coupons',
    iosUrl: 'https://www.rossmann.de/einkaufsportal/angebote.html',   // in der AASA gelistet
    android: 'de.rossmann.app.android', iosId: '1034309353',
    hinweis: 'Der App-Coupon (10 %) ist dreimal im Monat verfügbar.',
  },
  payback: {
    url: 'https://www.payback.de/coupons',
    // www.payback.de listet nur /oauth*, m.payback.de dagegen /j/* — dort
    // greift der Universal Link, und ohne App landet man bei PAYBACK selbst
    iosUrl: 'https://m.payback.de/j/',
    android: 'de.payback.client.android', iosId: '363126964',
  },
  dm: { url: 'https://www.dm.de/', android: 'de.dm.meindm.android', iosId: '1186271926', keinUniLink: true },   // AASA nur /applink/*
  rewe: {
    url: 'https://www.rewe.de/angebote/',
    iosUrl: 'https://www.rewe.de/shop',                               // in der AASA gelistet
    android: 'de.rewe.app.mobile', iosId: '714121079',
  },
  edeka: { url: 'https://www.edeka.de/', android: 'de.edeka.genuss', iosId: '1272688648' },
  penny: {
    url: 'https://www.penny.de/angebote/',                            // steht so in der AASA
    android: 'de.penny.app', iosId: '1096204041',
  },
  kaufland: { url: 'https://www.kaufland.de/kaufland-card/', android: 'com.kaufland.Kaufland', iosId: '1087780386' },
  // Netto und Burger King: der Code in der App wechselt staendig, hier bringt
  // "Coupons aktivieren" nichts — nur der Sprung in die App hilft
  netto: {
    url: 'https://www.netto-online.de/',
    // www.netto-online.de laesst die AASA gar nicht erst abrufen, app.netto-online.de
    // gibt dagegen die ganze Domain fuer die Netto-App frei
    iosUrl: 'https://app.netto-online.de/',
    android: 'com.valuephone.vpnetto', iosId: '379404334',
    rotierend: true, ohneKarte: true,
  },
  'netto marken-discount': {
    url: 'https://www.netto-online.de/',
    iosUrl: 'https://app.netto-online.de/',
    android: 'com.valuephone.vpnetto', iosId: '379404334',
    rotierend: true, ohneKarte: true,
  },
  'burger king': {
    url: 'https://www.burgerking.de/', android: 'de.burgerking.kingfinder',
    iosId: '471268068', rotierend: true, ohneKarte: true,             // AASA deckt die ganze Domain
  },
  mcdonalds: {
    url: 'https://www.mcdonalds.com/de/de-de.html',
    // Die AASA von mcdonalds.com nennt nur die US-App (com.mcdonalds.gma) und
    // nur /deals* und /full-menu* — die deutsche App steht dort nicht drin.
    // Ein Universal Link ist damit unmoeglich, deshalb gleich ein eigener Tab.
    keinUniLink: true, ohneKarte: true,
    android: 'de.mcdonalds.mcdonaldsinfoapp', iosId: '524943492',
    alt: { url: 'https://mccheap.tech/', name: 'McCheap.tech' },
  },
  "mcdonald's": {
    url: 'https://www.mcdonalds.com/de/de-de.html',
    // Die AASA von mcdonalds.com nennt nur die US-App (com.mcdonalds.gma) und
    // nur /deals* und /full-menu* — die deutsche App steht dort nicht drin.
    // Ein Universal Link ist damit unmoeglich, deshalb gleich ein eigener Tab.
    keinUniLink: true, ohneKarte: true,
    android: 'de.mcdonalds.mcdonaldsinfoapp', iosId: '524943492',
    alt: { url: 'https://mccheap.tech/', name: 'McCheap.tech' },
  },
  subway: { url: 'https://www.subway.com/de-DE', android: 'com.subway.mobile.emea.germany', iosId: '6479694657' },
  'müller': { url: 'https://www.mueller.de/', android: 'at.helloagain.muellerde', iosId: '1516484066', keinUniLink: true },   // leeres applinks
  mueller: { url: 'https://www.mueller.de/', android: 'at.helloagain.muellerde', iosId: '1516484066', keinUniLink: true },
  // app.lidlplus.com ist Lidls alte Firebase-Domain — die Weiterleitung landet
  // inzwischen auf einer Web-Seite mit "zur App"-Knopf statt in der App.
  // lidl.de selbst listet /c/*/s10068374 (der aktuelle Prospekt) in seiner AASA.
  lidl: {
    url: 'https://www.lidl.de/c/lidl-plus/s10007306',
    iosUrl: 'https://www.lidl.de/c/lidl-plus/s10068374',
    android: 'com.lidl.eci.lidlplus', iosId: '1238611143',
  },
  'lidl plus': {
    url: 'https://www.lidl.de/c/lidl-plus/s10007306',
    iosUrl: 'https://www.lidl.de/c/lidl-plus/s10068374',
    android: 'com.lidl.eci.lidlplus', iosId: '1238611143',
  },
  ikea: {
    url: 'https://www.ikea.com/de/de/ikea-family/',
    // IKEAs AASA listet 27 Laender, "de" ist NICHT dabei — ueber ikea.com kann
    // die App in Deutschland keinen Universal Link faengen. ikea.de leitet nur
    // um und hat keine eigene AASA. Also gleich sauber im eigenen Tab.
    keinUniLink: true,
    android: 'com.ingka.ikea.app', iosId: '1452164827',
    woche: 'Einmal pro Woche in der IKEA-App einloggen bringt Punkte für Gutscheine.',
  },
};
const cardApp = name => CARD_APPS[String(name || '').trim().toLowerCase()];

// Coupon-Quellen: offizielle Apps/Seiten der Anbieter, ordentlich unterteilt
const COUPON_SOURCES = [
  { cat: 'Drogerie', items: [
    { name: 'Rossmann', url: 'https://www.rossmann.de/de/coupons', desc: 'Coupons in der Rossmann-App & im Coupon-Center' },
    { name: 'Müller', url: 'https://www.mueller.de/', desc: 'Vorteile & Coupons über „Mein Müller"' },
  ]},
  { cat: 'Supermärkte', items: [
    { name: 'REWE', url: 'https://www.rewe.de/angebote/', desc: 'App-Coupons & Payback-Punkte bei REWE' },
    { name: 'EDEKA', url: 'https://www.edeka.de/', desc: 'Coupons & Aktionen in der EDEKA-App' },
    { name: 'Netto', url: 'https://www.netto-online.de/', desc: 'Rabatt-Coupons in der Netto-App, oft ohne Mindestwert' },
  ]},
  { cat: 'Fast Food', items: [
    { name: 'McDonalds', url: 'https://www.mcdonalds.com/de/de-de.html', desc: 'App-Coupons & McDonald’s-Methode-Basics' },
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
  'uber eats': '#06c167', "mcdonald's": '#ffbc0d', "domino's": '#006491', dominos: '#006491',
  'about you': '#1f1f1f', temu: '#fb7701', shein: '#222222', nike: '#111111', 'peter pane': '#ffd400',
  peepoplush: '#1f3d14',
};
function brandColor(name) {
  const key = (name || '').toLowerCase().trim();
  if (BRAND_COLORS[key]) return BRAND_COLORS[key];
  for (const [k, v] of Object.entries(BRAND_COLORS)) if (key.includes(k)) return v;
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h}, 45%, 42%)`;
}
// Wie hell ist eine Markenfarbe? Danach richtet sich, ob heller oder dunkler
// Text darauf lesbar ist (EDEKA-Gelb und McDonald's-Gelb tragen kein Weiss).
function brandHelligkeit(farbe) {
  const c = String(farbe || '').trim();
  let r = 0, g = 0, b = 0;
  if (c.startsWith('#')) {
    const h = c.length === 4
      ? c.slice(1).split('').map(x => x + x).join('')
      : c.slice(1);
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
  } else {
    const m = c.match(/hsl\(\s*(\d+)[,\s]+(\d+)%[,\s]+(\d+)%/i);
    if (m) return Number(m[3]) / 100;      // Helligkeit steht direkt drin
    return 0.4;
  }
  // Wahrgenommene Helligkeit, Gruen zaehlt am staerksten
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
// Textfarbe fuer eine Markenflaeche: dunkles Anthrazit auf hellen Toenen
function brandTextColor(name) {
  return brandHelligkeit(brandColor(name)) > 0.62 ? '#14171B' : '#FFFFFF';
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

// Auch Anfuehrungszeichen: esc() landet oft in Attributen (src, data-*,
// aria-label) — dort half das bisherige Escaping (nur & < >) nicht
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ESC_MAP[c]);
}

// Anzeigenamen: vorne steht, wie jemand heissen will; der @Name bleibt intern
// der Schluessel fuer alles (Links, Chats, Freunde, Suche). Der Server schickt
// die Namen mit (Feld "anzeigename" am Eintrag oder eine Liste "namen"), hier
// liegen sie fuer alle Stellen bereit. Kein Eintrag = es steht der @Name da.
const anzeigeNamen = new Map();
// true, wenn sich etwas geaendert hat (dann lohnt neu Zeichnen)
function merkeAnzeigename(handle, name) {
  if (!handle || anzeigeNamen.get(handle) === (name || undefined)) return false;
  if (name) anzeigeNamen.set(handle, name); else anzeigeNamen.delete(handle);
  return true;
}
// Eine Liste { "@Name": "Anzeigename" } nennt nur die gesetzten; fuer die
// uebrigen Namen, die sie abdeckt (handles), gilt dann wieder der @Name
function merkeNamen(liste, handles = []) {
  const map = liste && typeof liste === 'object' ? liste : {};
  let neu = false;
  for (const h of new Set([...handles, ...Object.keys(map)])) {
    if (merkeAnzeigename(h, typeof map[h] === 'string' ? map[h] : '')) neu = true;
  }
  return neu;
}
function anzeigeName(handle) { return anzeigeNamen.get(handle) || handle || ''; }
// Zweite Zeile, wo Platz ist: der @Name — nur, wenn vorne etwas anderes steht
function hatAnzeigename(handle) { return anzeigeNamen.has(handle); }
// Wo sonst "@Name" stand (Geschenke): der Anzeigename, sonst wie bisher "@Name"
function anzeigeOderAt(handle) { return hatAnzeigename(handle) ? anzeigeName(handle) : '@' + (handle || ''); }
// Name in Listen (Freunde, Anfragen): Anzeigename, darunter klein der @Name.
// Ohne Anzeigename steht nur der Name da, wie bisher (mit "@", wo es schon so war).
function nameMitHandleHtml(handle, cls, { at = true } = {}) {
  return hatAnzeigename(handle)
    ? `<span class="${cls} name-doppelt"><b>${esc(anzeigeName(handle))}</b><small>@${esc(handle)}</small></span>`
    : `<span class="${cls}">${at ? '@' : ''}${esc(handle)}</span>`;
}
// Knopf "An <Name> verschenken/schicken" bleibt einzeilig (Anzeigenamen sind
// oft laenger als @Namen): passt es nicht, kuerzt sich nur der Name von
// hinten, das Verb bleibt stehen
function knopfAnName(btn, name, verb) {
  const zeichen = [...name];
  btn.textContent = `An ${name} ${verb}`;
  // Platz innen (ohne Polster) gegen die Breite des Textes
  const cs = getComputedStyle(btn);
  const platz = btn.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const bereich = document.createRange();
  const zuBreit = () => { bereich.selectNodeContents(btn); return bereich.getBoundingClientRect().width > platz + .5; };
  for (let n = zeichen.length - 1; n > 1 && platz > 0 && zuBreit(); n--) {
    btn.textContent = `An ${zeichen.slice(0, n).join('').trimEnd()}… ${verb}`;
  }
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
    err.data = data; // weitere Angaben des Servers (z. B. fehlende Lios)
    throw err;
  }
  return data;
}

function channelBySlug(slug) { return state.channels.find(c => c.slug === slug); }
// Der Speicher, den ein Browser einer Webseite gibt, ist klein (rund 5 MB).
// Mit vielen Gutscheinfotos war er voll: setItem warf, und alles danach —
// Anzeigen, Sichern am Konto — fiel still aus. So gingen Gutscheine verloren.
// Die Wallet liegt deshalb jetzt in IndexedDB (siehe "Wallet-Speicher"), und
// save() wirft nie. vomServer = true: der Stand kam vom Konto, ist dort also
// schon gesichert und muss nicht wieder hoch.
let walletRev = 0;        // zaehlt jede Aenderung an der Wallet auf diesem Geraet
let walletRevOben = -1;   // bis zu welcher Aenderung der Server alles hat
let walletStand = Number(state.wallet.stand) || 0;  // Zeitpunkt der letzten Speicherung
let walletBesitzer = state.wallet.user || state.userName || '';
let walletIdbOk = true;       // false: kein IndexedDB — dann alles im localStorage
let walletIstBereit = false;  // erst wenn die Bilder aus IndexedDB da sind, wird hochgeladen
let walletBereit = Promise.resolve();
let walletOben = lsJson('ra.walletOben', {});
// Wallet-Sperre (PIN / Face ID), siehe "Wallet-Sperre" weiter unten. Hier oben,
// weil renderWallet und switchView sie schon beim Start brauchen.
// PIN und Face ID gehoeren zum Konto, dessen Wallet auf dem Geraet liegt —
// ein Kontowechsel loescht sie nicht, sie gelten wieder, wenn man zurueckwechselt
const pinSchluessel = () => 'ra.walletPin:' + (walletBesitzer || state.userName || 'gast');
const bioSchluessel = () => 'ra.walletBio:' + (walletBesitzer || state.userName || 'gast');
const PIN_FEHL_KEY = 'ra.pinFehl';
const PIN_HINWEIS_KEY = 'ra.pinHinweis';
const SPERRE_NACH_MS = 60e3; // so lange darf die App im Hintergrund sein, ohne dass die Wallet sich sperrt
let walletEntsperrt = false;
let versteckSeit = 0;
let kontoInfo = null; // aus /api/me: zweiFaktor, ersatzcodes, autoAufraeumen, mailBereit
const FACE_SVG = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 15.5c1.4 1.2 3.6 1.2 5 0"/></svg>';
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
let sperrEingabe = '';
let sperrUhr = 0;
let sperrBeschaeftigt = false;   // PIN wird gerade geprueft bzw. die Punkte wackeln
let sperreGehtUhr = 0, sperreKommtUhr = 0;
let startAuftrittOffen = true;   // bis der Start-Splash geht, wartet jeder Auftritt
let bioLaeuft = false;           // Face ID fragt gerade (nie zwei Abfragen gleichzeitig)
let neuGeprueft = false;         // Update-Log: pro Sitzung und Konto hoechstens einmal pruefen
let neuListe = null;             // public/neuigkeiten.json, neueste Fassung zuerst
let markenModusName = '';        // Marken-Ansicht im Wallet-Kopf (siehe setzeMarkenModus)
let markenEbene = 0, markenEbeneUhr = 0;
let ladenLetzt = 0, ladenLaeuft = false; // Laden-Erkennung (siehe pruefeLaden)
let geteiltWartet = null;        // aus anderen Apps geteilte Bilder/Text (siehe pruefeGeteiltes)
let geteiltSchlange = [];        // weitere geteilte Bilder: eins nach dem anderen ins Formular
let markeWartet = null;          // "Karte zeigen" aus dem Laden-Banner wartet aufs Entsperren
let bioBrauchtTippen = false;    // Browser liess Face ID nicht ohne Antippen starten
// So viel passt in eine Wallet. Gerechnet: ein Gutschein mit Kassen-Code und
// Originalfoto braucht komprimiert rund 50-130 KB. 500 Stueck sind dann auf
// dem Handy rund 25-65 MB (dafuer reicht IndexedDB locker, und die App bleibt
// flott), und am Server teilen sich alle Nutzer einen Speicher. Der Server
// meldet seine Werte ueber /api/meta — die hier gelten, bis er geantwortet hat.
const WALLET_LIMIT = { gutscheine: 500, karten: 100 };
// Rabattcodes liegen bei den Gutscheinen, haben aber kein Guthaben
function istRabatt(v) { return !!v && v.art === 'rabatt'; }
// Pfandbons auch: ihr Wert steht in amount, balance bleibt null. Sie zaehlen
// nicht zum Wallet-Guthaben und nicht zum Rang (der Pfand-Reiter zeigt eine
// eigene Summe) und gelten nur in der Filiale, in der man sie bekommen hat.
function istPfand(v) { return !!v && v.art === 'pfand'; }
function ohneGuthaben(v) { return istRabatt(v) || istPfand(v); }
function walletArt(v) { return istRabatt(v) ? 'rabatt' : istPfand(v) ? 'pfand' : 'gutschein'; }
function walletPlatz(art = 'gutscheine') {
  const n = (art === 'karten' ? state.wallet.cards : state.wallet.vouchers).length;
  // Wartende Geschenke belegen schon Platz (der Server zaehlt sie genauso)
  let g = 0;
  // pendingGifts steht weiter unten im Skript — vor dessen Zeile waere schon
  // der Zugriff ein Fehler, deshalb abgesichert
  try { if (art === 'gutscheine') g = pendingGifts.length; } catch { /* noch nicht da */ }
  const max = WALLET_LIMIT[art];
  const belegt = n + g;
  return { n, g, max, belegt, frei: Math.max(0, max - belegt), voll: belegt >= max, fast: belegt >= max * 0.9 };
}
function walletVollText(art = 'gutscheine') {
  if (art === 'karten') return `Deine Wallet ist voll: maximal ${WALLET_LIMIT.karten} Sparkarten. Lösch eine Karte, die du nicht mehr brauchst.`;
  const p = walletPlatz('gutscheine');
  const aufgebraucht = state.wallet.vouchers.some(v => v.balance != null && v.balance <= 0);
  return `Deine Wallet ist voll: maximal ${p.max} Gutscheine${p.g ? ` (${p.g} wartende Geschenke zählen mit)` : ''}. `
    + (aufgebraucht ? 'Lösch aufgebrauchte Gutscheine, dann ist wieder Platz.' : 'Lösch einen Gutschein, den du nicht mehr brauchst, dann ist wieder Platz.');
}
function save(key, val, vomServer = false) {
  if (key === 'wallet') return speichereWallet(vomServer);
  return lsSetzen('ra.' + key, JSON.stringify(val));
}

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
    ${text ? `<div class="toast-text">${withEmotes(esc(text))}</div>` : ''}
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

// Menueleiste: welcher Reiter gehoert zur Ansicht? Nur Feed, Wallet und Chat
// haben einen. Profil und seine Unterseiten (Einstellungen, Freunde …) oeffnen
// ueber das Profilbild oben links — dann ist kein Reiter markiert, und die
// Woelbung blendet aus.
const HAUPT_TABS = ['feed', 'wallet', 'chat'];
function tabFuer(v) {
  return HAUPT_TABS.includes(v) ? v : null;
}
function markiereTab(v) {
  const t = tabFuer(v);
  document.querySelectorAll('.tabbtn').forEach(b => {
    const an = b.dataset.view === t;
    b.classList.toggle('active', an);
    if (an) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  setzeBuckel();
}
// Die Woelbung der Leiste folgt dem aktiven Reiter. Beim Wechsel gleitet sie
// hinueber, dehnt sich unterwegs etwas in die Breite und federt am Ziel nach —
// als wuerde die Leiste physisch mitgezogen. Nur transform, also billig.
let buckelX = null;
function setzeBuckel(sofort = false) {
  const b = $('#tab-buckel');
  const aktiv = document.querySelector('.tabbtn.active');
  if (!b) return;
  if (!aktiv) { b.classList.add('weg'); return; }
  // SVG hat kein offsetWidth — clientWidth liefert die CSS-Breite
  const x = Math.round(aktiv.offsetLeft + aktiv.offsetWidth / 2 - (b.clientWidth || 88) / 2);
  const war = buckelX;
  buckelX = x;
  // War sie ausgeblendet (Profil offen), erscheint sie gleich am Ziel und
  // blendet nur ein — sonst glitte sie unsichtbar vom alten Platz herueber
  const warWeg = b.classList.contains('weg');
  b.classList.remove('weg');
  const ziel = `translate3d(${x}px, 0, 0)`;
  b.getAnimations?.().forEach(a => a.cancel());
  b.style.transform = ziel;
  if (sofort || warWeg || war === null || war === x || reducedMotion() || !b.animate) return;
  const mitte = Math.round(war + (x - war) * .55);
  b.animate([
    { transform: `translate3d(${war}px, 0, 0) scale(1, 1)` },
    { transform: `translate3d(${mitte}px, 0, 0) scale(1.32, .72)`, offset: .45 },
    { transform: `translate3d(${x}px, 0, 0) scale(.92, 1.12)`, offset: .78 },
    { transform: `${ziel} scale(1, 1)` },
  ], { duration: 540, easing: 'cubic-bezier(.3, .75, .35, 1)' });
}
addEventListener('resize', () => setzeBuckel(true), { passive: true });
// Frueher glitt eine Pille zum aktiven Reiter; jetzt markiert der Reiter sich selbst
function moveTabPill() { markiereTab(state.activeView); }

let viewCleanupTimer = null;

// Laufende Übergänge sofort sauber beenden, verhindert, dass bei schnellem
// Tab-Wechsel ein alter Timer die inzwischen aktive View versteckt/verschiebt
function settleViews() {
  clearTimeout(viewCleanupTimer);
  document.querySelectorAll('.view').forEach(v => {
    v.classList.remove('enter-right', 'enter-left', 'enter-drop', 'enter-fade');
    v.classList.toggle('hidden', v.id !== 'view-' + state.activeView);
  });
}

// Wechsel ohne Überlappung: alte View sofort weg, nur die neue animiert herein.
// So kann bei schnellem Durchschalten nichts springen oder doppelt erscheinen.
function switchView(next, animClass) {
  schliesseTopMenu({ fokus: false });
  schliesseMarkenMenue();
  if (next === state.activeView) return;
  settleViews();
  const oldView = $('#view-' + state.activeView);
  const newView = $('#view-' + next);
  const dir = VIEW_ORDER.indexOf(next) > VIEW_ORDER.indexOf(state.activeView) ? 1 : -1;
  // Zwischen den Reitern unten: ruhiges Ueberblenden statt Gleiten
  const hauptreiter = HAUPT_TABS;
  const weich = hauptreiter.includes(next) && hauptreiter.includes(state.activeView);
  state.activeView = next;
  // Die Suche oben rechts gehoert nur zum Feed (look.css blendet sie sonst aus)
  document.body.dataset.ansicht = next;
  // In der Wallet zeigt der Shop-Knopf oben rechts kurz den Lio-Stand
  if (next === 'wallet' && !lioWartetNoch()) lioFahneZeigen({ spaeter: 520 });

  markiereTab(next);

  oldView.classList.add('hidden');
  window.scrollTo(0, 0);
  newView.classList.remove('hidden');
  newView.classList.add(animClass || (weich ? 'enter-fade' : dir === 1 ? 'enter-right' : 'enter-left'));
  // Login-Captcha erst rendern, wenn die Profil-Seite sichtbar ist
  if (next === 'profile' && !state.token) renderTurnstile('login');
  if (next === 'profile' && state.token) ladeProfil();
  // Profil und Unterseiten haben keinen Reiter: "Zurueck" fuehrt dorthin,
  // woher man kam. Der Rueckweg aus einer Unterseite aendert das nicht.
  // Fremdes Profil und Suche haben einen eigenen Rueckweg: fuehrt der gerade
  // hierher zurueck, bleibt der alte Eintrag — sonst liefe Zurueck im Kreis
  const vorher = oldView.id.slice(5);
  const heimweg = (vorher === 'user' && userPageReturn === next) || (vorher === 'search' && searchReturnView === next);
  if (HAUPT_TABS.includes(next)) state.letzterReiter = next;
  if (PROFIL_BEREICH.includes(next) && !heimweg) {
    // Fremdes Profil und Suche haben selbst einen Rueckweg, der oft wieder in
    // den Profil-Bereich fuehrt — als Ziel eingetragen liefe Zurueck im Kreis.
    // Dann geht es zum zuletzt benutzten Reiter.
    const ziel = (vorher === 'user' || vorher === 'search') ? (state.letzterReiter || 'wallet') : vorher;
    if (!PROFIL_BEREICH.includes(vorher) || (vorher === 'profile' && next !== 'profile')) state.zurueck[next] = ziel;
  }
  if (next === 'chat') {
    // Der Chat besteht nur noch aus den Gespraechen mit Freunden. Er oeffnet
    // die Liste — wer gezielt in einen Einzelchat will (Benachrichtigung,
    // Freundesliste, Profil), ruft direkt danach setChatMode('dm', …) auf.
    // Zurueck vom Profil, das man aus einem Einzelchat angesehen hat: wieder
    // in genau dieses Gespraech (Verlauf, Entwurf und Stelle bleiben stehen)
    const insGespraech = heimweg && openUserPop.gespraech && chatMode === 'dm' && dmPartner === openUserPop.gespraech;
    if (!insGespraech && chatMode !== 'dmlist') setChatMode('dmlist');
    updateChatGate();
    pollChat(true);
  }
  // Wallet immer aufgeräumt betreten: alle Stapel wieder zusammengelegt.
  // Offene Wallet-Seiten (Gutschein, Analyse) gehoeren zur alten Ansicht.
  wseitenZu();
  if (next === 'wallet') { restack(); renderWallet(); }
  aktualisiereSperre(); // gesperrte Wallet: Sperrbildschirm (nur auf der Wallet-Seite)
  if (next === 'settings') { renderSicherheit(); if ($('#sw-laden')) $('#sw-laden').checked = ladenErkennungAn(); }
  // Solange die Wallet offen ist, traegt die Kopfzeile ihre Farbe mit —
  // sonst steht oben eine harte Kante zwischen Leiste und farbigem Kopf
  document.body.classList.toggle('wallet-farbe', next === 'wallet' && !!state.token);
  passeFarbfeldAn();          // sofort, damit das Farbfeld nicht stehenbleibt
  setzeLeistenfarbe();
  requestAnimationFrame(() => { messeKopfzeile(); pruefeKopfzeile(); });
  if (next === 'friends') renderFriendsView();
  if (next === 'gifts') renderGiftsPage();
  if (next === 'invite') renderInvitePage();
  if (next !== 'wallet') $('#wallet-mini')?.classList.remove('show');
  document.body.classList.toggle('chat-locked', next === 'chat');
  if (next !== 'chat') document.body.style.transform = ''; // Tastatur-Versatz zurücksetzen
  refreshAdminUi();
  viewCleanupTimer = setTimeout(settleViews, 520);
}

// Suche: fällt mit Feder-Bounce von oben ein (Lupe oben rechts), Zurück-Button führt heim
let searchReturnView = 'feed';
$('#btn-search-top').addEventListener('click', () => {
  if (state.activeView === 'search') return;
  searchReturnView = state.activeView;
  switchView('search', 'enter-drop');
  setTimeout(() => $('#search').focus(), 420);
});
$('#btn-search-back').addEventListener('click', () => switchView(searchReturnView, 'enter-drop'));
// Seiten, die ueber das Profil oder die Seitenleiste aufgehen; ihr Rueckweg
// steht in state.zurueck (siehe switchView)
const PROFIL_BEREICH = ['profile', 'settings', 'friends', 'gifts', 'invite', 'editprofile'];
state.zurueck = {};
const zurueckVon = v => switchView(state.zurueck[v] || (v === 'profile' ? 'feed' : 'profile'), 'enter-drop');
$('#btn-profile-back').addEventListener('click', () => zurueckVon('profile'));
$('#btn-settings-back').addEventListener('click', () => zurueckVon('settings'));
$('#btn-friends-back').addEventListener('click', () => zurueckVon('friends'));
$('#btn-user-back').addEventListener('click', () => switchView(userPageReturn, 'enter-drop'));
$('#btn-gifts-back').addEventListener('click', () => zurueckVon('gifts'));
$('#btn-invite-back')?.addEventListener('click', () => zurueckVon('invite'));
$('#btn-edit-back').addEventListener('click', () => switchView('profile', 'enter-drop'));

// ---- Freunde-Bereich: Liste mit Profilbild, Profil ansehen oder schreiben
async function renderFriendsView() {
  const host = $('#friends-list');
  host.innerHTML = '<div class="status">Lade …</div>';
  try {
    const r = await api('/api/dm/list');
    dmListeNamenMerken(r);
    const friends = myProfile?.friends || [];
    const meta = {};
    r.list.forEach(l => { meta[l.partner] = { ts: l.lastTs }; });
    (r.friends || []).forEach(f => { meta[f.name] = meta[f.name] || { ts: 0 }; });
    const sorted = [...friends].sort((a, b) => (meta[b]?.ts || 0) - (meta[a]?.ts || 0));
    host.innerHTML = sorted.length ? sorted.map(f => `
      <div class="friend-row">
        <button class="friend-open" type="button" data-fr-profile="${esc(f)}" aria-label="Profil von ${esc(anzeigeName(f))} (@${esc(f)})">
          ${avatarHtml(f, undefined, 'avatar-big')}
          ${nameMitHandleHtml(f, 'friend-name')}
        </button>
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
      profilNamenMerken(r);
      island(r.friends.includes(name) ? 'Ihr seid jetzt Freunde!' : 'Anfrage gesendet');
      $('#fr-add-name').value = '';
      renderFriendsView();
    }).catch(e => island(e.message));
});

// Konto löschen: doppelte Rückfrage, dann endgültig
$('#btn-account-delete').addEventListener('click', async () => {
  if (!await askConfirm('Willst du dein Konto wirklich löschen? Profil, Wallet und Chats sind dann weg.', { okLabel: 'Ja, weiter' })) return;
  if (!await askConfirm('Letzte Frage: endgültig löschen? Das lässt sich nicht rückgängig machen.', { okLabel: 'Endgültig löschen' })) return;
  // Nur mit Passwort — wer bloss das Handy in der Hand hat, darf das nicht
  const pass = await passwortDialog('Konto löschen', 'Zur Sicherheit: dein Passwort.', { mitVergessen: false });
  if (!pass) return;
  try {
    await api('/api/account/delete', { method: 'POST', body: JSON.stringify({ pass }) });
    state.token = ''; state.userName = ''; state.role = '';
    localStorage.removeItem('ra.token'); localStorage.removeItem('ra.user');
    walletZuruecksetzen();
    localStorage.removeItem('ra.wallet');
    walletIdbTx('del').catch(() => { });
    myProfile = null;
    kontoInfo = null;
    pinEntfernen(); // die PIN gehoerte zum geloeschten Konto
    refreshProfileTab();
    switchView('wallet');
    island('Konto gelöscht. Mach es gut!');
  } catch (e) { island(e.message); }
});

$('#tabbar').addEventListener('click', e => {
  const btn = e.target.closest('.tabbtn');
  if (!btn) return;
  // Nochmal auf den aktiven Tab tippen = smooth nach ganz oben
  if (btn.dataset.view === state.activeView) {
    if (btn.dataset.view === 'feed' && state.feedAlle) { state.feedAlle = false; renderFeed(true); }
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  buzz(6);
  switchView(btn.dataset.view);
});

// ---------------- Chipbar + Feed ----------------

// Feed-Filter als schlichte Pillen in einer Reihe (seitwaerts wischbar). Der
// aktive traegt die Rang-Farbe. "Gemerkt" erscheint, sobald etwas gemerkt ist.
function feedSegmente() {
  return Object.keys(state.favs).length
    ? [...SEGMENTS, { slug: 'saved', name: 'Gemerkt', icon: 'heart' }]
    : SEGMENTS;
}
function renderChipbar() {
  if (state.activeChip === 'saved' && !Object.keys(state.favs).length) state.activeChip = 'fuer-dich';
  $('#chipbar').innerHTML = feedSegmente().map(c =>
    `<button class="chip feed-chip" type="button" data-slug="${esc(c.slug)}" aria-pressed="false">${icon(c.icon, 'icon icon-sm')}<span>${esc(c.name)}</span></button>`).join('');
  layoutChipCarousel();
}
// Name bleibt (wird an mehreren Stellen gerufen): markiert nur noch den aktiven Chip
function layoutChipCarousel() {
  document.querySelectorAll('#chipbar .feed-chip').forEach(ch => {
    const an = ch.dataset.slug === state.activeChip;
    ch.classList.toggle('active', an);
    ch.setAttribute('aria-pressed', String(an));
  });
}

$('#chipbar').addEventListener('click', e => {
  const chip = e.target.closest('.feed-chip');
  if (!chip || chip.dataset.slug === state.activeChip) return;
  state.activeChip = chip.dataset.slug;
  state.feedAlle = false;
  layoutChipCarousel();
  buzz(6);
  renderFeed(true);
  // Den gewaehlten Chip ganz in den sichtbaren Bereich holen
  const bar = $('#chipbar');
  const links = chip.offsetLeft - 16, rechts = chip.offsetLeft + chip.offsetWidth + 16 - bar.clientWidth;
  if (bar.scrollLeft > links) bar.scrollTo({ left: links, behavior: 'smooth' });
  else if (bar.scrollLeft < rechts) bar.scrollTo({ left: rechts, behavior: 'smooth' });
});

// Hervorgehobene Angebote (Admin-Panel) fuer das Banner oben im Feed
async function loadFeatured() {
  try {
    const r = await api('/api/featured');
    state.featured = Array.isArray(r) ? r : (r.items || r.featured || []);
  } catch { state.featured = []; }
  renderFeedHero();
}

async function loadFeed() {
  // Ladezustand: der kumulio-Punkt ersetzt den Spinner (zeigt sich erst nach 200 ms)
  const loader = window.KBrand
    ? window.KBrand.createLoader($('#feed'), { mode: 'inline' })
    : { done() { } };
  try {
    const data = await api('/api/deals?channels=' + state.channels.map(c => c.slug).join(','));
    state.deals = data.deals;
    let starsSynced = false;
    state.deals.forEach(d => { if (d.myRating && state.stars[d.id] !== d.myRating) { state.stars[d.id] = d.myRating; starsSynced = true; } });
    if (starsSynced) save('stars', state.stars);
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
  dealSeitenAbgleichen(); // offene Deal-Seiten (bearbeitet) und ?deal= vom Start
}

// Suche als eigener Tab: durchsucht alle Angebote (Titel, Marke, Text)
function renderSearch() {
  const s = $('#search').value.trim().toLowerCase();
  const box = $('#search-results');
  if (s.length < 2) { box.innerHTML = '<div class="status">Tippe mindestens 2 Zeichen.</div>'; return; }
  const hits = state.deals.filter(d =>
    (d.title + ' ' + (d.merchant || '') + ' ' + (d.excerpt || '')).toLowerCase().includes(s));
  box.innerHTML = hits.length
    ? `<div class="dgrid">${hits.slice(0, FEED_LIMIT).map(d => dealKachelHtml(d)).join('')}</div>`
    : `<div class="status">Nichts gefunden für „${esc(s)}".</div>`;
}
$('#search').addEventListener('input', renderSearch);

function quality(d) {
  return d.ratingCount ? (d.rating || 0) / 5 : null;
}

// Sterne-Anzeige: ★★★★☆ 4.2 (12) — die eigene Bewertung faerbt golden
function renderStars(d) {
  const avg = d.rating || 0;
  const mine = state.stars[d.id] || 0;
  const full = mine || Math.round(avg);
  return `
    <span class="stars ${mine ? 'rated' : ''}" title="${mine ? 'Deine Bewertung: ' + mine + ' von 5' : ''}">
      ${[1, 2, 3, 4, 5].map(i => icon('star', 'icon' + (i <= full && (mine || d.ratingCount) ? ' on' : ''))).join('')}
      ${d.ratingCount ? `<span class="stars-value">${avg.toFixed(1)}</span> <span class="stars-count">(${d.ratingCount})</span>` : ''}
    </span>`;
}

// Einen Deal mit 1-5 Sternen bewerten (Sternereihe auf der Deal-Seite)
async function dealBewerten(id, val, x, y) {
  const d = state.deals.find(z => z.id === id) || state.favs[id]?.deal;
  if (!d || !(val >= 1 && val <= 5)) return;
  const prev = state.stars[id] || null;
  state.stars[id] = val;
  save('stars', state.stars);
  if (val >= 4) bumpAff(d, 2);
  buzz(8);
  // Feedback: Stern schwebt hoch
  if (!reducedMotion()) {
    const fl = document.createElement('div');
    fl.className = 'vote-float up';
    fl.textContent = '★'.repeat(val);
    fl.style.left = (x - 20) + 'px';
    fl.style.top = (y - 26) + 'px';
    document.body.appendChild(fl);
    setTimeout(() => fl.remove(), 750);
  }
  dealSeitenSterne(id);          // eigene Wahl sofort zeigen, der Schnitt kommt gleich
  try {
    const r = await api('/api/rate', { method: 'POST', body: JSON.stringify({ dealId: id, stars: val, prev }) });
    d.rating = r.rating; d.ratingCount = r.ratingCount;
  } catch { /* offline */ }
  renderFeed();
  dealSeitenSterne(id);
}

// Spar-Badges: Rabatt / Gratis / Verdienst / Preisfehler, auf einen Blick
// Hinweise im Deal-Blatt, in normaler Schreibweise wie auf den Kacheln (die
// Zeit steht als eigene Pille daneben, auch der Preisfehler-Zaehler)
function renderBadges(d) {
  const out = [];
  if (d.channel === 'preisfehler') out.push(`<span class="badge badge-pf">Preisfehler</span>`);
  if (d.free) {
    out.push(`<span class="badge badge-free">Gratis</span>`);
  } else if (d.discount != null) {
    out.push(d.discount >= 50
      ? `<span class="badge badge-hot">${icon('flame')} −${d.discount} %</span>`
      : `<span class="badge badge-discount">−${d.discount} %</span>`);
  }
  if (d.earn) out.push(`<span class="badge badge-earn">+ Verdienst</span>`);
  if (d.newCustomer) out.push(`<span class="badge badge-neu">Nur Neukunden</span>`);
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
  // "Top Deals für dich": nach eigenem Verhalten (forYouScore), ohne Abgelaufenes
  state.topIds = state.deals.filter(d => !d.stale)
    .map(d => ({ id: d.id, s: forYouScore(d) }))
    .sort((a, b) => b.s - a.s)
    .map(x => x.id);
}

// Karten & Coupons: ein Raster mit allen Marken. Hinter jeder Kachel liegt
// alles zu diesem Händler — die Sparkarte, der Sprung in seine App und seine
// Coupons. Darunter die Geld-zurück-Garantien.
function renderCoupons(host) {
  host = host || $('#coupons-content');
  const gzg = state.deals.filter(d => /geld.?zur(ü|ue)ck|gzg\b/i.test(d.title + ' ' + (d.excerpt || '')));
  const q = (state.couponQuery || '').trim().toLowerCase();
  const marken = walletBrands().filter(b => !q
    || b.name.toLowerCase().includes(q)
    || (b.quelle?.cat || '').toLowerCase().includes(q)
    || (b.card?.number || '').toLowerCase().includes(q));

  // Oben, was man ohne Sparkarte sofort einlösen kann (Burger King, Netto,
  // McDonald's): breite Zeilen untereinander — da muss man nicht seitwärts
  // scrollen und sieht auf einen Blick, was drinsteckt.
  const sofort = marken.filter(b => (b.coupons && b.coupons.open) || /mcdonald/i.test(b.name));
  const rest = marken.filter(b => !sofort.includes(b));

  const bau = `
    ${rabattSektionHtml()}
    <h2 class="bereich-titel">Sofort einlösbar</h2>
    <div class="cc-cards">${sofort.map(b => {
      const gratis = /mcdonald/i.test(b.name) && (mccheapDaten?.items || []).some(x => x.gratis);
      const n = b.coupons ? b.coupons.count : 0;
      return `
      <button class="cc-card ${brandHelligkeit(brandColor(b.name)) > 0.62 ? 'hell' : ''}"
        data-brand="${esc(b.key)}" style="--bc:${brandColor(b.name)}; --tc:${brandTextColor(b.name)}">
        ${brandChipHtml(b.name)}
        <span class="cc-card-main">
          <b>${esc(b.name)}</b>
          <small>${n ? `${n} Coupon${n === 1 ? '' : 's'}${b.coupons.validUntil ? ' · bis ' + dateShort(b.coupons.validUntil) : ''}`
            : 'App-Coupons und McCheap-Funde'}</small>
        </span>
        ${gratis ? '<span class="cc-card-flag">gratis!</span>' : ''}
        ${icon('arrow-right', 'icon icon-sm')}
      </button>`;
    }).join('') || '<div class="status">Gerade nichts ohne Karte verfügbar.</div>'}</div>
    <h2 class="bereich-titel">Deine Karten</h2>
    <div class="app-grid" id="coupon-grid">
      ${rest.map(b => {
        const gesperrt = b.coupons && !ccBesitzt(b.coupons);
        const gratis = /mcdonald/i.test(b.name) && (mccheapDaten?.items || []).some(x => x.gratis);
        return `
      <button class="mk-kachel ${b.card ? 'hat-karte' : ''} ${brandHelligkeit(brandColor(b.name)) > 0.62 ? 'hell' : ''}"
        data-marke="${esc(b.key)}" style="--bc:${brandColor(b.name)}; --tc:${brandTextColor(b.name)}"
        aria-label="${esc(b.name)}">
        ${brandChipHtml(b.name)}
        <span class="mk-name">${esc(b.name)}</span>
        ${b.card ? '<span class="mk-punkt" aria-hidden="true"></span>' : ''}
        ${gesperrt ? `<span class="mk-schloss">${icon('lock', 'icon icon-sm')}</span>` : ''}
        ${gratis ? '<span class="mk-flagge">gratis!</span>' : ''}
      </button>`;
      }).join('')}
      <button class="mk-kachel mk-add" data-wadd="card">
        <span class="app-add-plus">${icon('plus')}</span>
        <span class="mk-name">Karte</span>
      </button>
    </div>
    <h2 class="bereich-titel">Geld zurück</h2>
    ${gzg.length
      ? `<div class="dgrid">${gzg.map(d => dealKachelHtml(d)).join('')}</div>`
      : '<div class="status">Aktuelle GzG-Aktionen postet die Redaktion über das Admin-Panel, sie erscheinen dann hier.</div>'}`;

  // Beim Wechsel auf "Karten & Coupons" wurde bisher JEDES Mal die ganze Liste
  // neu in den Baum geschrieben — mit allen Logos, Verlaeufen und Schatten.
  // Das lag genau auf dem ersten Bild der Einblend-Animation und war der Ruck,
  // den man gesehen hat. Wenn sich nichts geaendert hat, bleibt der Baum jetzt
  // einfach stehen; nur der Text wird verglichen, nicht neu gebaut.
  if (renderCoupons.letzterBau === bau && host.firstElementChild) { ladeCouponListe(); return; }
  host.innerHTML = bau;
  renderCoupons.letzterBau = bau;   // im Speicher, nicht als Attribut im Baum

  ladeCouponListe();
  // Die breiten Zeilen oben fuehren direkt ins Marken-Blatt
  host.querySelectorAll('[data-brand]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    openBrandSheet(b.dataset.brand);
  });
  // Eine Kachel antippen holt die Karte gross in die Mitte
  host.querySelectorAll('.mk-kachel[data-marke]').forEach(el =>
    el.onclick = () => oeffneKartenLupe(el.dataset.marke, el));
  host.querySelectorAll('[data-wadd]').forEach(el => el.onclick = () => openWalletAdd(el.dataset.wadd));
  rabattKartenVerdrahten(host);
  // Einmal nachsehen, ob McCheap gerade etwas Gratis hat — danach steht es im Speicher
  if (!mccheapDaten) ladeMccheap().then(d => {
    if ((d.items || []).some(x => x.gratis) && walletTab === 'coupons') renderCoupons(host);
  });
  makeGridSortable(host.querySelector('#coupon-grid'), '#coupon-grid > [data-marke]', newOrder => {
    if ((state.couponQuery || '').trim()) return;
    // Gespeichert werden Namen, nicht Schlüssel — die Reihenfolge gilt markenweit
    const namen = newOrder.map(k => (walletBrands().find(b => b.key === k) || {}).name).filter(Boolean);
    lsSetzen('ra.couponOrder', JSON.stringify(namen));
  }, el => el.dataset.marke);
}

// McDonald's hat zwei Wege: die eigene App und McCheap.tech, wo Leute die
// Coupon-Codes sammeln. Dort tauchen ab und zu Gratis-Sachen auf — die holt
// der Server einmal pro Stunde, damit man es nicht verpasst.
let mccheapDaten = null;
async function ladeMccheap() {
  if (mccheapDaten) return mccheapDaten;
  try { mccheapDaten = await api('/api/mccheap'); } catch { mccheapDaten = { items: [] }; }
  return mccheapDaten;
}
// McDonald's hat zwei Wege: die eigene App und McCheap.tech. Beides steht im
// Marken-Blatt untereinander, dazu die Ausreisser, die der Server dort findet.
function mccheapBlockHtml() {
  const treffer = mccheapDaten?.items || [];
  return `
    <a class="app-jump" href="https://mccheap.tech/" target="_blank" rel="noopener noreferrer" style="--bc:#12C77E">
      <span class="brand-chip" style="--bc:#12C77E">MC</span>
      <span class="app-jump-txt"><b>McCheap.tech</b><small>Gesammelte Codes, oft günstiger als die App</small></span>
      ${icon('arrow-right', 'icon icon-sm')}
    </a>
    ${treffer.length ? `
      <h3 class="gm-h" style="margin-top:16px">${icon('bolt', 'icon icon-sm')} Gerade auffällig günstig</h3>
      <div class="mcd-hits">${treffer.map(t => `
        <div class="mcd-hit ${t.gratis ? 'gratis' : ''}">
          ${t.gratis ? '<b>GRATIS</b> ' : ''}${esc(t.text)}
          ${t.bis ? `<small>${esc(t.bis)}</small>` : ''}
        </div>`).join('')}</div>
      <p class="muted" style="font-size:.72rem; margin-top:8px">Automatisch von McCheap.tech gelesen — ohne Gewähr, prüf den Preis im Laden.</p>`
      : '<p class="muted" style="font-size:.76rem; margin-top:10px">Aktuell nichts Auffälliges bei McCheap gefunden.</p>'}`;
}

// ---------------- Feed nach dem Entwurf des Nutzers ----------------
// Oben ein Banner-Karussell (hervorgehobene Angebote, jede Folie ein Fenster
// mit Maskottchen oder 3D-Kachel der Marke), darunter die Filter,
// "Top Deals für dich" als seitwaerts wischbare Reihe und "Weitere starke
// Angebote" als zweispaltiges Raster. Alles aus echten Daten: kein Bild =
// Markenfarbe mit Logo, keine Laufzeit = "vor 2 Std.", kein Rabatt = keine Pille.
const FEED_SEITE = 20;        // so viele Kacheln laedt das Raster auf einmal nach
const TOP_ANZAHL = 10;        // Karten in "Top Deals für dich"

function dealBild(d) {
  const u = d.image || (Array.isArray(d.images) && d.images[0]) || '';
  return /^https?:\/\//.test(u) ? u : '';
}
// "12,99€" -> "12,99 €"
function preisFmt(s) {
  return String(s || '').trim().replace(/\s*€$/, ' €');
}
// Ehrliche Zeitangabe: Laufzeit nur, wenn der Deal ein Ende hat
function dealZeitChip(d) {
  if (d.channel === 'preisfehler' && !d.stale) {
    return { ico: 'clock', html: `<span class="pf-timer" data-pf-ts="${d.ts}">seit <span>${pfElapsed(d.ts)}</span></span>` };
  }
  if (d.stale) return { ico: 'clock', html: 'abgelaufen' };
  if (d.endTs) {
    const rest = d.endTs - Date.now();
    if (rest <= 0) return { ico: 'clock', html: 'abgelaufen' };
    if (rest < 3600e3) return { ico: 'clock', html: `${Math.max(1, Math.round(rest / 60e3))} Min. übrig` };
    if (rest < 86400e3) return { ico: 'clock', html: `${Math.round(rest / 3600e3)} Std. übrig` };
    const t = Math.floor(rest / 86400e3);
    return { ico: 'clock', html: `${t} ${t === 1 ? 'Tag' : 'Tage'} übrig` };
  }
  return { ico: 'clock', html: esc(timeAgo(d.ts)) };
}
// Gelbe Pille oben links — nur mit echtem Rabatt
function rabattPill(d) {
  if (d.channel === 'preisfehler') return '<span class="dk-pill pf">Preisfehler</span>';
  if (d.free) return '<span class="dk-pill">Gratis</span>';
  if (d.discount != null && d.discount > 0) return `<span class="dk-pill">-${Math.round(d.discount)} %</span>`;
  return '';
}
function herzKnopf(id) {
  const an = !!state.favs[id];
  return `<button class="dk-herz${an ? ' on' : ''}" type="button" data-bm="${esc(id)}" aria-pressed="${an}"
    aria-label="${an ? 'Nicht mehr merken' : 'Merken'}">${icon('heart', 'icon dk-h-o')}${icon('heart-f', 'icon dk-h-f')}</button>`;
}
// Eine Deal-Kachel. art 'reihe' = schmale Karte in "Top Deals", 'raster' = Raster
function dealKachelHtml(d, { art = 'raster', i = 0, anim = false } = {}) {
  const c = channelBySlug(d.channel);
  const marke = d.merchant || c?.name || 'Deal';
  const bild = dealBild(d);
  const zeit = dealZeitChip(d);
  const orig = d.free ? '' : (d.origPrice || '');
  const hinweis = d.newCustomer ? 'Nur Neukunden' : d.earn ? 'Verdienen' : '';
  return `
  <article class="dk dk-${art}${d.stale ? ' alt' : ''}${anim ? ' anim' : ''}" data-deal="${esc(d.id)}"
    style="--bc:${brandColor(marke)}${anim ? `; animation-delay:${Math.min(i, 8) * 40}ms` : ''}">
    <div class="dk-bild${bild ? '' : ' ohne'}">
      ${bild ? `<img src="${esc(bild)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('ohne');this.remove()">` : ''}
      <span class="dk-ersatz" aria-hidden="true">${brandChipHtml(marke, true)}</span>
      ${rabattPill(d)}
      ${herzKnopf(d.id)}
      ${hinweis ? `<span class="dk-hinweis">${hinweis}</span>` : ''}
    </div>
    <div class="dk-info">
      <div class="dk-kopf">
        <span class="dk-logo">${brandChipHtml(marke)}</span>
        <span class="dk-namen"><b class="dk-titel">${esc(d.title)}</b><span class="dk-marke">${esc(marke)}</span></span>
      </div>
      ${d.price || orig ? `<div class="dk-preise">${d.price ? `<span class="dk-preis">${esc(preisFmt(d.price))}</span>` : ''}${orig ? `<s>${esc(preisFmt(orig))}</s>` : ''}</div>` : ''}
      <span class="dk-zeit">${icon(zeit.ico, 'icon')}<span>${zeit.html}</span></span>
    </div>
  </article>`;
}

// ---- Banner oben: hervorgehobene Angebote, aufgefuellt mit den besten Deals
let heroSchluessel = '';
function heroEintraege() {
  const aus = [];
  const genutzt = new Set();
  for (const f of state.featured || []) {
    const d = f.dealId && state.deals.find(x => x.id === f.dealId);
    if (d) { genutzt.add(d.id); aus.push({ deal: d }); }
    else if (f.title) aus.push({ featured: f });
  }
  if (aus.length < 3) {
    const kandidaten = state.deals.filter(d => !d.stale && !genutzt.has(d.id))
      .map(d => ({ d, s: forYouScore(d) + (dealBild(d) ? 1.5 : 0) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 3 - aus.length);
    kandidaten.forEach(k => aus.push({ deal: k.d }));
  }
  return aus.slice(0, 5);
}
function heroSlideHtml(e, i) {
  const d = e.deal, f = e.featured;
  const marke = d ? (d.merchant || channelBySlug(d.channel)?.name || 'Deal') : '';
  const titel = d ? d.title : f.title;
  const sub = d ? (d.excerpt || '').replace(/\s+/g, ' ').slice(0, 110) : (f.tagline || '');
  const bild = d ? dealBild(d) : (/^https?:\/\//.test(f.image || '') ? f.image : '');
  const farbe = brandColor(d ? marke : f.title);
  const helligkeit = brandHelligkeit(farbe);
  const hell = helligkeit > 0.62;
  // Mittlere Toene (Wolt-Tuerkis, Lieferando-Orange) tragen weisse Schrift nur
  // knapp: dafuer wird das Fenster etwas tiefer eingefaerbt (0 bis 26 % Schwarz)
  const tiefe = hell ? 0 : Math.round(Math.min(26, Math.max(0, (helligkeit - 0.36) * 110)));
  const pille = d ? rabattPill(d) : (f.price ? `<span class="dk-pill">${esc(f.price)}</span>` : '');
  // Deal-Folien: die ganze Folie oeffnet den Deal (onOfferClick ueber data-deal)
  const cta = d
    ? `<button class="fh-cta" type="button">Zum Deal ${icon('arrow-right', 'icon icon-sm')}</button>`
    : (f.link ? `<a class="fh-cta" href="${esc(f.link)}" target="_blank" rel="noopener noreferrer">Zum Deal ${icon('arrow-right', 'icon icon-sm')}</a>` : '');
  // Rechts: das Maskottchen der Marke ragt oben aus dem Fenster wie Kumulio in
  // der Wallet. Ohne Maskottchen steht dort eine dicke, schraeg gestellte
  // Kachel mit dem Foto des Deals oder dem Logo, ebenfalls ueber die Kante.
  // Das Maskottchen laedt sofort: "lazy" holt es in der seitwaerts wischbaren
  // Spur erst beim Wischen, dann ploppt es sichtbar auf
  const figur = markenMaskottchen(marke || titel);
  const ersatz = brandChipHtml(marke || titel, true);
  const rechts = figur
    ? `<span class="fh-rahmen" aria-hidden="true"><img class="fh-figur" src="${figur.basis}-480.webp"
        srcset="${figur.basis}-480.webp 480w, ${figur.basis}-960.webp 960w" sizes="176px" alt=""
        decoding="async" draggable="false"${i ? ' fetchpriority="low"' : ''}></span>`
    : `<span class="fh-kachel${bild ? ' foto' : ''}" aria-hidden="true">${bild
      ? `<img src="${esc(bild)}" alt="" loading="${i ? 'lazy' : 'eager'}" decoding="async" referrerpolicy="no-referrer" onerror="this.closest('.fh-slide').classList.remove('mit-foto');this.parentNode.classList.remove('foto');this.replaceWith(document.createRange().createContextualFragment(this.dataset.ersatz))" data-ersatz="${esc(ersatz)}">`
      : ersatz}</span>`;
  const stil = `--bc:${farbe}; --tiefe:${tiefe}%` + (tiefe ? `; --tiefe-oben:${28 + tiefe}%` : '') + (figur
    ? `; --fig-ar:${figur.ar}; --fig-oben:${figur.oben}; --licht-x:${figur.licht[0]}; --licht-y:${figur.licht[1]}` : '');
  return `
    <div class="fh-slide${hell ? ' hell' : ''}${figur ? ' mit-figur' : bild ? ' mit-foto' : ''}${i ? '' : ' aktiv'}" style="${stil}"${d ? ` data-deal="${esc(d.id)}"` : ''} role="group" aria-roledescription="Folie" aria-label="${i + 1}">
      <span class="fh-licht" aria-hidden="true"></span>
      ${rechts}
      <div class="fh-text">
        ${marke ? `<span class="fh-marke">${esc(marke)}</span>` : ''}
        ${pille}
        <b class="fh-titel">${esc(titel)}</b>
        ${sub && sub !== titel ? `<span class="fh-sub">${esc(sub)}</span>` : ''}
        ${cta}
      </div>
    </div>`;
}
function renderFeedHero() {
  const host = $('#feed-hero');
  if (!host) return;
  const eintraege = heroEintraege();
  const schluessel = eintraege.map(e => e.deal ? 'd' + e.deal.id + ':' + e.deal.title : 'f' + e.featured.id + ':' + e.featured.title).join('|');
  if (schluessel === heroSchluessel && host.firstElementChild) return;
  heroSchluessel = schluessel;
  if (!eintraege.length) { host.innerHTML = ''; return; }
  host.innerHTML = `
    <div class="fh">
      <div class="fh-track" tabindex="0" aria-label="Hervorgehobene Angebote">${eintraege.map(heroSlideHtml).join('')}</div>
      ${eintraege.length > 1 ? `<div class="fh-dots" aria-hidden="true">${eintraege.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : ''}
    </div>`;
  const track = host.querySelector('.fh-track');
  const folien = [...track.children];
  const dots = [...host.querySelectorAll('.fh-dots i')];
  let raf = 0;
  // Die Spur laeuft bis an den Bildschirmrand: eine Folie weiter = Folienbreite
  // plus Abstand. Nur die sichtbare Folie dreht ihre Strahlen (.aktiv)
  if (folien.length > 1) track.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const schritt = folien[1].offsetLeft - folien[0].offsetLeft || track.clientWidth;
      const i = Math.round(track.scrollLeft / Math.max(1, schritt));
      dots.forEach((el, j) => el.classList.toggle('on', j === i));
      folien.forEach((el, j) => el.classList.toggle('aktiv', j === i));
    });
  }, { passive: true });
}

// ---- Listen darunter
function feedSektionKopf(titel, alle) {
  return `<div class="fsek-kopf"><h2 class="bereich-titel">${esc(titel)}</h2>${alle
    ? `<button class="fsek-alle" type="button" data-feed-alle>Alle anzeigen ${icon('chevron', 'icon icon-sm')}</button>` : ''}</div>`;
}
let feedRasterRest = [];
let feedBeobachter = null;
function feedRasterNachladen() {
  const raster = $('#feed-raster');
  if (!raster || !feedRasterRest.length) { $('#feed-mehr')?.remove(); return; }
  const teil = feedRasterRest.splice(0, FEED_SEITE);
  raster.insertAdjacentHTML('beforeend', teil.map(d => dealKachelHtml(d)).join(''));
  if (!feedRasterRest.length) $('#feed-mehr')?.remove();
}
function beobachteFeedEnde() {
  feedBeobachter?.disconnect();
  const mehr = $('#feed-mehr');
  if (!mehr) return;
  if (!('IntersectionObserver' in window)) { while (feedRasterRest.length) feedRasterNachladen(); return; }
  feedBeobachter = new IntersectionObserver(es => {
    if (es.some(x => x.isIntersecting)) feedRasterNachladen();
  }, { rootMargin: '600px 0px' });
  feedBeobachter.observe(mehr);
}

function renderFeed(reorder = false) {
  // Sortierung nur bei Chip-Wechsel/Neuladen neu berechnen, ein Vote soll den
  // Feed nicht sofort umwürfeln, das pendelt sich beim nächsten Laden ein
  if (reorder || !state.orderIds || state.orderKey !== state.activeChip) computeOrder();
  renderFeedHero();
  const finde = id => state.deals.find(d => d.id === id) || state.favs[id]?.deal;
  const deals = state.orderIds.map(finde).filter(Boolean);
  const feed = $('#feed');
  feedBeobachter?.disconnect();

  if (!deals.length) {
    feed.innerHTML = `<div class="status">${state.activeChip === 'saved'
      ? 'Noch nichts gemerkt, tippe auf das Herz eines Angebots.'
      : state.activeChip === 'neukunden'
        ? 'Aktuell keine Neukunden-Aktionen, neue kommen über das Admin-Panel.'
        : 'Noch keine Angebote in diesem Bereich, neue kommen über das Admin-Panel.'}</div>`;
    return;
  }
  const kachel = art => (d, i) => dealKachelHtml(d, { art, i, anim: reorder });

  let html = '';
  let raster = deals;
  if (state.activeChip === 'fuer-dich' && state.feedAlle) {
    // "Alle anzeigen": die ganze Top-Liste als Raster, mit Weg zurueck
    raster = state.topIds.map(finde).filter(Boolean);
    html += `<button class="fsek-zurueck" type="button" data-feed-zurueck>${icon('arrow-back', 'icon icon-sm')} Top Deals für dich</button>`;
  } else if (state.activeChip === 'fuer-dich') {
    const top = state.topIds.map(finde).filter(Boolean);
    // Bei wenigen Deals teilt sich die Liste, damit beide Bereiche etwas zeigen
    const n = top.length >= TOP_ANZAHL * 2 ? TOP_ANZAHL : Math.min(TOP_ANZAHL, Math.max(3, Math.ceil(top.length / 2)));
    const zeigen = top.slice(0, n);
    if (zeigen.length) {
      html += feedSektionKopf('Top Deals für dich', top.length > zeigen.length)
        + `<div class="drow" role="list">${zeigen.map(kachel('reihe')).join('')}</div>`;
    }
    // Bei wenigen Deals doppelt nichts: das Raster zeigt nur, was oben fehlt.
    // Sind es sehr wenige, reicht die Reihe allein.
    const oben = new Set(zeigen.map(d => d.id));
    raster = deals.filter(d => !oben.has(d.id));
    if (raster.length) html += feedSektionKopf('Weitere starke Angebote', false);
  } else {
    const seg = feedSegmente().find(s => s.slug === state.activeChip);
    html += feedSektionKopf(seg ? seg.name : 'Angebote', false);
  }
  const erste = raster.slice(0, FEED_SEITE);
  feedRasterRest = raster.slice(FEED_SEITE);
  if (erste.length) {
    html += `<div class="dgrid" id="feed-raster">${erste.map(kachel('raster')).join('')}</div>`
      + (feedRasterRest.length ? '<div id="feed-mehr" class="feed-mehr" aria-hidden="true"></div>' : '');
  }
  feed.innerHTML = html;
  beobachteFeedEnde();
}
$('#feed').addEventListener('click', e => {
  if (e.target.closest('[data-feed-alle]')) {
    state.feedAlle = true; renderFeed(true);
    $('#chipbar')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  } else if (e.target.closest('[data-feed-zurueck]')) {
    state.feedAlle = false; renderFeed(true);
  }
});

// Nach dem Merken nur die Herzen umschalten — kein Neuaufbau des Feeds
function aktualisiereHerzen(id) {
  const an = !!state.favs[id];
  document.querySelectorAll(`[data-bm="${CSS.escape(id)}"]`).forEach(b => {
    b.classList.toggle('on', an);
    b.setAttribute('aria-pressed', String(an));
    if (b.classList.contains('dk-herz')) b.setAttribute('aria-label', an ? 'Nicht mehr merken' : 'Merken');
  });
  const hatteChip = !!$('#chipbar [data-slug="saved"]');
  if (hatteChip !== !!Object.keys(state.favs).length) renderChipbar();
  if (state.activeChip === 'saved') renderFeed();
}

let suppressClickUntil = 0;

// Deal als Fluesternachricht an einen Freund: kompakte Karte im Chat,
// antippen oeffnet den Deal
function sendDealToFriend(d) {
  if (!state.token) { island('Zum Schicken bitte anmelden'); return; }
  const friends = myProfile?.friends || [];
  if (!friends.length) { island('Noch keine Freunde zum Schicken'); return; }
  // Auswahl im neuen Look: Freunde als Zeilen mit Bild und Namen (ohne @)
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `<div class="modal modal-left dl-schicken" role="dialog" aria-modal="true" aria-label="Deal an Freund schicken">
    <div class="dl-schicken-kopf">
      <h2 class="card-h">An wen schicken?</h2>
      <button class="dl-schicken-zu" type="button" data-zu aria-label="Schließen">${icon('x', 'icon')}</button>
    </div>
    <p class="dl-schicken-deal">${esc(d.title)}</p>
    <div class="dl-schicken-liste">${friends.map(f => `
      <button class="dl-schicken-freund" type="button" data-send-to="${esc(f)}" title="@${esc(f)}">
        ${avatarHtml(f, undefined, 'avatar-mini dl-schicken-ava')}<span>${esc(anzeigeName(f))}</span>${icon('send', 'icon')}
      </button>`).join('')}</div>
  </div>`;
  document.body.appendChild(wrap);
  const zu = () => { wrap.remove(); removeEventListener('keydown', taste, true); };
  const taste = e => { if (e.key === 'Escape') { e.stopPropagation(); zu(); } };
  addEventListener('keydown', taste, true);
  wrap.querySelector('.dl-schicken-freund')?.focus({ preventScroll: true });
  wrap.addEventListener('click', async e => {
    const b = e.target.closest('[data-send-to]');
    if (!b) { if (e.target === wrap || e.target.closest('[data-zu]')) zu(); return; }
    zu();
    try {
      await api('/api/dm/send', { method: 'POST', body: JSON.stringify({ to: b.dataset.sendTo, text: `[deal:${d.id}] ${d.title.slice(0, 90)}` }) });
      island(`An ${anzeigeName(b.dataset.sendTo)} geschickt`); playSfx('plop');
    } catch (err) { island(err.message); }
  });
}
// Nachrichtentext: der [deal:id]-Marker wird zur antippbaren Deal-Karte
function chatBodyHtml(text) {
  const dl = String(text).match(/^\[deal:([a-z0-9]+)\]\s*(.*)$/i);
  if (dl) {
    return `<button class="deal-chip" data-open-deal="${esc(dl[1])}">${icon('tag', 'icon icon-sm')} <span>${esc(dl[2] || 'Deal ansehen')}</span> ${icon('arrow-right', 'icon icon-sm')}</button>`;
  }
  // Geteilter Coupon: [coupon:<satz>:<code>] wird zur Coupon-Karte
  const cp = String(text).match(/^\[coupon:([^\]:]{1,40}):([\w.-]{1,24})\]\s*([\s\S]*)$/);
  if (cp) return couponChatHtml(cp[1], cp[2], cp[3]);
  return withEmotes(esc(text));
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-open-deal]');
  if (!b) return;
  const d = dealVonId(b.dataset.openDeal);
  if (d) openDealSheet(d);
  else island('Dieser Deal ist nicht mehr im Feed');
});
// ---------------- Originalfotos: eigener Speicher neben der Wallet ----------------
// Das nicht zugeschnittene Foto eines Gutscheins faehrt NICHT in der Wallet
// mit: die geht bei jedem Sync komplett zum Server und liegt im localStorage
// (rund 5 MB). Mit Originalfotos darin liefen Syncs ins Timeout und Gutscheine
// gingen verloren (Payload-Diaet, 966becb). Deshalb liegt das Original hier in
// IndexedDB und am Konto als eigene Datei; die Wallet merkt sich nur den
// Zeitstempel v.orig. Geladen wird es erst, wenn jemand es sehen will.
let origDbP = null;
function origDb() {
  if (!origDbP) {
    origDbP = new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('IndexedDB fehlt'));
      const r = indexedDB.open('kumulio-bilder', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('orig');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    origDbP.catch(() => { origDbP = null; });
  }
  return origDbP;
}
async function origIdb(art, id, wert) {
  try {
    const db = await origDb();
    return await new Promise((res, rej) => {
      const st = db.transaction('orig', art === 'get' ? 'readonly' : 'readwrite').objectStore('orig');
      const r = art === 'get' ? st.get(id) : art === 'put' ? st.put(wert, id) : st.delete(id);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  } catch { return undefined; }
}
function dataUrlZuBlob(url) {
  const [kopf, daten] = String(url).split(',');
  const bin = atob(daten || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: (kopf.match(/^data:([^;,]+)/) || [])[1] || 'image/jpeg' });
}
// v.orig wird sofort gesetzt, damit es mit dem naechsten Wallet-Sync mitgeht;
// das Bild selbst folgt ueber die Warteschlange.
function origSichern(v, dataUrl) {
  if (!v || !dataUrl) return Promise.resolve();
  const ts = Date.now();
  v.orig = ts;
  return origIdb('put', v.id, { ts, blob: dataUrlZuBlob(dataUrl) }).then(() => origHochladen(v.id));
}
function origEntfernen(v) {
  if (!v || !v.orig) return;
  delete v.orig;
  origIdb('del', v.id);
  origWartendSetzen(origWartend().filter(x => x !== v.id));
  if (state.token) {
    fetch(API_BASE + '/api/wallet/orig?id=' + encodeURIComponent(v.id), {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + state.token },
    }).catch(() => {});
  }
}
function origWartend() {
  try { return JSON.parse(localStorage.getItem('ra.origWartend') || '[]'); } catch { return []; }
}
function origWartendSetzen(liste) {
  try { lsSetzen('ra.origWartend', JSON.stringify(liste.slice(-300))); } catch { /* voll */ }
}
// Warteschlange: offline oder abgemeldet gemachte Fotos gehen beim naechsten
// geglueckten Wallet-Sync nach oben
let origUploadLaeuft = false;
let origUploadP = null;
async function origHochladen(id) {
  if (id && !origWartend().includes(id)) origWartendSetzen([...origWartend(), id]);
  // Laeuft schon ein Durchgang: auf ihn warten (Verschenken braucht das Foto oben)
  if (origUploadLaeuft) { await origUploadP?.catch(() => { }); if (!origWartend().length) return; }
  if (!state.token || origUploadLaeuft) return;
  let fertig;
  origUploadP = new Promise(r => { fertig = r; });
  origUploadLaeuft = true;
  let hakt = false;
  try {
    for (const vid of origWartend()) {
      const e = await origIdb('get', vid);
      if (e && e.blob) {
        const r = await fetch(API_BASE + '/api/wallet/orig?id=' + encodeURIComponent(vid), {
          method: 'POST', body: e.blob,
          headers: { 'Content-Type': e.blob.type || 'image/jpeg', Authorization: 'Bearer ' + state.token },
        });
        // Netz oder Server gerade weg: spaeter nochmal. Abgelehnt (zu gross,
        // kein JPEG): nicht endlos wiederholen.
        if (!r.ok && r.status !== 400 && r.status !== 413) { hakt = true; break; }
      }
      origWartendSetzen(origWartend().filter(x => x !== vid));
    }
  } catch { hakt = true; }
  finally { origUploadLaeuft = false; fertig(); }
  // Waehrenddessen dazugekommen? Gleich hinterher.
  if (!hakt && origWartend().length) origHochladen();
}
// Original zum Anzeigen holen: erst vom Geraet, sonst vom Konto
async function origLaden(v) {
  if (!v || !v.orig) return null;
  const e = await origIdb('get', v.id);
  const lokal = e && e.blob ? URL.createObjectURL(e.blob) : null;
  if (lokal && e.ts === v.orig) return lokal;
  if (!state.token) return lokal;
  try {
    const r = await fetch(API_BASE + '/api/wallet/orig?id=' + encodeURIComponent(v.id), {
      headers: { Authorization: 'Bearer ' + state.token },
    });
    if (!r.ok) return lokal;
    const blob = await r.blob();
    origIdb('put', v.id, { ts: v.orig, blob });
    if (lokal) URL.revokeObjectURL(lokal);
    return URL.createObjectURL(blob);
  } catch { return lokal; }
}

// ---------------- Bildbetrachter ----------------
// Gutscheinbild antippen: es hebt sich aus dem Blatt in die Mitte — derselbe
// Weg wie bei der Kartenlupe, nur ohne Drehung — und der Rest wird unscharf.
// Zwei Finger, Doppeltipp oder Mausrad zoomen, ein Finger schiebt. Raus geht
// es auf jedem naheliegenden Weg: daneben tippen, einmal aufs Bild tippen,
// runterwischen, zusammenkneifen, X oder Esc.
let bildOffen = null;
function zeigeBildGross({ vonEl, src, ladeOriginal = null }) {
  if (bildOffen || !vonEl || walletGesperrt()) return;
  const von = vonEl.getBoundingClientRect();
  if (!von.width) return;
  // Der Rahmen uebernimmt Rand, Ecken und Grund des Bildes im Blatt. Dann ist
  // der Weg dorthin ein reines Skalieren, und nichts springt beim Landen.
  const cs = getComputedStyle(vonEl);
  const rand = parseFloat(cs.paddingLeft) || 0;
  const ecke = parseFloat(cs.borderTopLeftRadius) || 0;
  const grundFarbe = cs.backgroundColor;
  buzz(10);

  const el = document.createElement('div');
  el.className = 'bild-lupe';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Bild');
  el.innerHTML = `
    <div class="lupe-grund"></div>
    <div class="bl-flaeche"><div class="bl-rahmen"><img alt="" draggable="false"></div></div>
    <button class="bl-zu" aria-label="Schließen">${icon('x')}</button>
    ${ladeOriginal ? `<div class="bl-wahl" role="tablist" aria-label="Bildfassung">
        <span class="bl-wahl-flaeche" aria-hidden="true"></span>
        <button class="bl-wahl-knopf an" data-bl="zu" role="tab" aria-selected="true">Zugeschnitten</button>
        <button class="bl-wahl-knopf" data-bl="orig" role="tab" aria-selected="false">Original</button>
      </div>` : ''}`;
  document.body.appendChild(el);
  bildOffen = el;
  const flaeche = el.querySelector('.bl-flaeche');
  const rahmen = el.querySelector('.bl-rahmen');
  const img = rahmen.querySelector('img');
  const hinten = el.querySelector('.lupe-grund');
  const wahl = el.querySelector('.bl-wahl');
  img.src = src;
  const leise = reducedMotion();
  const weich = 'cubic-bezier(.22, 1, .32, 1)';
  const urls = [];

  // ---- Groesse: so viel Bildschirm wie moeglich, oben das X, unten der Umschalter
  let modus = 'zu';
  let orig = null;          // { url, w, h }
  let B = null;             // Lage des Rahmens bei Zoom 1
  const passeAn = () => {
    const W = el.clientWidth, H = el.clientHeight;
    const maxW = W - 16, maxH = H - (wahl ? 150 : 112);
    let w, h;
    if (modus === 'zu') {
      // Nicht beliebig aufblasen: hoechstens anderthalbmal so gross, wie das
      // Bild Pixel hat — kleiner als im Blatt wird es aber nie (ausser es passt nicht)
      const innen = Math.max(1, von.width - 2 * rand);
      const k = Math.min(maxW / von.width, maxH / von.height,
        Math.max(1, ((vonEl.naturalWidth || innen) * 1.5) / innen));
      w = von.width * k; h = von.height * k;
      rahmen.style.padding = rand * k + 'px';
      rahmen.style.borderRadius = ecke * k + 'px';
      rahmen.style.background = grundFarbe;
    } else {
      const k = Math.min(maxW / orig.w, maxH / orig.h, 1.5);
      w = orig.w * k; h = orig.h * k;
      rahmen.style.padding = '0';
      rahmen.style.borderRadius = '14px';
      rahmen.style.background = 'transparent';
    }
    rahmen.style.width = w + 'px';
    rahmen.style.height = h + 'px';
    const r = rahmen.getBoundingClientRect();
    B = { left: r.left, top: r.top, width: r.width, height: r.height };
  };

  // ---- Zoom-Zustand: z und Verschiebung der ganzen Flaeche (Ursprung oben links)
  let z = 1, tx = 0, ty = 0;
  const trafo = () => `translate(${tx}px, ${ty}px) scale(${z})`;
  const setze = () => { flaeche.style.transform = trafo(); };
  // Gezoomt darf man bis an die Bildkante schieben, nicht weiter. Passt das
  // Bild in einer Richtung ganz aufs Display, bleibt es dort mittig.
  const begrenzt = (zz, x, y) => {
    const achse = (lo, gr, t, platz) => {
      const g = gr * zz;
      if (g <= platz) return (platz - g) / 2 - lo * zz;
      return Math.min(-lo * zz, Math.max(platz - (lo + gr) * zz, t));
    };
    return [achse(B.left, B.width, x, el.clientWidth), achse(B.top, B.height, y, el.clientHeight)];
  };
  // Der Punkt unter dem Finger bleibt unter dem Finger
  const zoomUm = (nz, px, py) => [nz, px - ((px - tx) / z) * nz, py - ((py - ty) / z) * nz];
  const gleite = (nz, nx, ny, ms = 320) => {
    let alt = getComputedStyle(flaeche).transform;
    if (!alt || alt === 'none') alt = 'matrix(1, 0, 0, 1, 0, 0)';
    flaeche.getAnimations().forEach(a => a.cancel());
    z = nz; tx = nx; ty = ny; setze();
    if (!leise) flaeche.animate([{ transform: alt }, { transform: trafo() }], { duration: ms, easing: weich });
  };
  // Mitten in einer Gleitfahrt anfassen: dort weitermachen, wo sie gerade ist
  const halte = () => {
    const laufend = flaeche.getAnimations();
    if (!laufend.length) return;
    const m = new DOMMatrixReadOnly(getComputedStyle(flaeche).transform);
    laufend.forEach(a => a.cancel());
    z = m.a; tx = m.e; ty = m.f; setze();
  };
  // Hintergrund und Knoepfe blassen mit, je weiter man zieht
  const daempfe = f => {
    hinten.style.opacity = String(1 - f * .85);
    el.style.setProperty('--bl-knopf', String(Math.max(0, 1 - f * 1.6)));
  };
  const entdaempfe = () => { hinten.style.opacity = ''; el.style.removeProperty('--bl-knopf'); };

  // ---- Hinein: aus dem Bild im Blatt heraus
  const abbild = (r, b) => `translate(${r.left + r.width / 2 - (b.left + b.width / 2)}px, `
    + `${r.top + r.height / 2 - (b.top + b.height / 2)}px) scale(${r.width / b.width})`;
  passeAn();
  void el.offsetWidth;
  el.classList.add('an');
  vonEl.style.visibility = 'hidden';
  if (!leise) rahmen.animate([{ transform: abbild(von, B) }, { transform: 'none' }], { duration: 420, easing: weich });

  // ---- Hinaus: von da, wo das Bild gerade ist, zurueck an seinen Platz
  let tippUhr = 0;
  const zu = () => {
    if (bildOffen !== el) return;
    bildOffen = null;
    removeEventListener('keydown', taste, true);
    removeEventListener('resize', neuLayout);
    clearTimeout(tippUhr);
    const jetzt = rahmen.getBoundingClientRect();
    flaeche.getAnimations().forEach(a => a.cancel());
    rahmen.getAnimations().forEach(a => a.cancel());
    z = 1; tx = 0; ty = 0; flaeche.style.transform = '';
    entdaempfe();
    el.classList.remove('an', 'zieht');
    el.classList.add('geht');
    const ziel = vonEl.isConnected ? vonEl.getBoundingClientRect() : null;
    const fertig = () => {
      if (!el.isConnected) return;
      el.remove();
      vonEl.style.visibility = '';
      urls.forEach(u => URL.revokeObjectURL(u));
    };
    if (leise) return fertig();
    let a;
    if (modus === 'zu' && ziel && ziel.width) {
      a = rahmen.animate([{ transform: abbild(jetzt, B) }, { transform: abbild(ziel, B) }],
        { duration: 320, easing: 'cubic-bezier(.32, .72, 0, 1)', fill: 'forwards' });
    } else {
      // Das Original hat ein anderes Format als das Bild im Blatt — dorthin
      // zu schrumpfen saehe schief aus. Also: sanft ausblenden.
      vonEl.style.visibility = '';
      a = rahmen.animate([
        { transform: abbild(jetzt, B), opacity: 1 },
        { transform: abbild(jetzt, B) + ' scale(.92)', opacity: 0 },
      ], { duration: 200, easing: 'ease-out', fill: 'forwards' });
    }
    a.onfinish = fertig;
    setTimeout(fertig, 520);
  };

  // ---- Gesten
  const finger = new Map();
  let geste = null, letzterTipp = null;
  const zweiFinger = () => {
    const [p, q] = [...finger.values()];
    return { d: Math.hypot(p.x - q.x, p.y - q.y) || 1, mx: (p.x + q.x) / 2, my: (p.y + q.y) / 2 };
  };
  el.addEventListener('pointerdown', e => {
    if (bildOffen !== el || e.target.closest('.bl-zu, .bl-wahl')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    halte();
    finger.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { el.setPointerCapture(e.pointerId); } catch { /* zweiter Finger */ }
    if (finger.size === 1) {
      geste = { art: 'eins', sx: e.clientX, sy: e.clientY, tx0: tx, ty0: ty, bewegt: false,
        aufBild: !!e.target.closest('.bl-rahmen'), spur: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }] };
    } else if (finger.size === 2) {
      const f = zweiFinger();
      geste = { art: 'zwei', d0: f.d, z0: z, cx: (f.mx - tx) / z, cy: (f.my - ty) / z };
      el.classList.add('zieht');
      clearTimeout(tippUhr); letzterTipp = null;
    }
  });
  el.addEventListener('pointermove', e => {
    if (!finger.has(e.pointerId) || !geste) return;
    finger.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (geste.art === 'zwei') {
      if (finger.size < 2) return;
      const f = zweiFinger();
      let nz = geste.z0 * f.d / geste.d0;
      // Ueber 6-fach nur noch zaeh, unter halb gar nicht
      if (nz > 6) nz = 6 + (nz - 6) * .3;
      nz = Math.max(.5, nz);
      z = nz; tx = f.mx - geste.cx * z; ty = f.my - geste.cy * z; setze();
      if (z < 1) daempfe(Math.min(1, (1 - z) * 2.2)); else entdaempfe();
      return;
    }
    const dx = e.clientX - geste.sx, dy = e.clientY - geste.sy;
    if (!geste.bewegt) {
      if (Math.hypot(dx, dy) < 8) return;
      geste.bewegt = true;
      geste.art = z > 1.02 || Math.abs(dx) > Math.abs(dy) ? 'schieben' : 'wisch';
      if (geste.art === 'wisch') el.classList.add('zieht');
    }
    geste.spur.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    if (geste.spur.length > 8) geste.spur.shift();
    if (geste.art === 'schieben') {
      // Ueber den Rand hinaus nur mit Widerstand
      const wx = geste.tx0 + dx, wy = geste.ty0 + dy;
      const [bx, by] = begrenzt(z, wx, wy);
      tx = bx + (wx - bx) * .35; ty = by + (wy - by) * .35; setze();
    } else {
      // Runterwischen: das Bild folgt dem Finger, wird etwas kleiner, der
      // Hintergrund klart auf
      const s = 1 - Math.min(.22, Math.abs(dy) / 1400);
      const mx = B.left + B.width / 2, my = B.top + B.height / 2;
      z = s; tx = mx * (1 - s) + dx * .5; ty = my * (1 - s) + dy; setze();
      daempfe(Math.min(1, Math.abs(dy) / 320));
    }
  });
  // Nach dem Loslassen: in gueltige Grenzen zurueck
  const landen = () => {
    el.classList.remove('zieht');
    if (z < .85) return zu(); // zusammengekniffen: raus
    entdaempfe();
    let nz = Math.min(6, Math.max(1, z)), nx = tx, ny = ty;
    if (nz !== z) [nz, nx, ny] = zoomUm(nz, el.clientWidth / 2, el.clientHeight / 2);
    [nx, ny] = begrenzt(nz, nx, ny);
    if (Math.abs(nz - z) > .001 || Math.abs(nx - tx) > .5 || Math.abs(ny - ty) > .5) gleite(nz, nx, ny);
  };
  const tempo = (g, t) => {
    const b = g.spur[g.spur.length - 1];
    if (!b) return { x: 0, y: 0 };
    const a = g.spur.find(p => p.t >= b.t - 100) || g.spur[0];
    if (b.t - a.t < 8 || t - b.t > 90) return { x: 0, y: 0 };
    return { x: (b.x - a.x) / (b.t - a.t), y: (b.y - a.y) / (b.t - a.t) };
  };
  const tippen = (e, g) => {
    const jetzt = e.timeStamp;
    if (letzterTipp && jetzt - letzterTipp.t < 300
        && Math.hypot(e.clientX - letzterTipp.x, e.clientY - letzterTipp.y) < 40) {
      // Doppeltipp: rein an genau diese Stelle — oder wieder ganz raus
      clearTimeout(tippUhr); letzterTipp = null;
      buzz(6);
      if (z > 1.02) return gleite(1, 0, 0);
      const [nz, nx, ny] = zoomUm(2.6, e.clientX, e.clientY);
      const [bx, by] = begrenzt(nz, nx, ny);
      return gleite(nz, bx, by);
    }
    if (!g.aufBild) return zu(); // daneben getippt: sofort raus
    letzterTipp = { t: jetzt, x: e.clientX, y: e.clientY };
    // Einmal aufs Bild: auch raus — aber erst, wenn kein zweiter Tipp folgt
    clearTimeout(tippUhr);
    tippUhr = setTimeout(() => { letzterTipp = null; if (z <= 1.02) zu(); }, 300);
  };
  const los = e => {
    if (!finger.has(e.pointerId)) return;
    finger.delete(e.pointerId);
    if (!geste) return;
    if (geste.art === 'zwei') {
      if (finger.size === 1) {
        // Ein Finger bleibt liegen: nahtlos weiterschieben
        const [f] = [...finger.values()];
        geste = { art: 'schieben', sx: f.x, sy: f.y, tx0: tx, ty0: ty, bewegt: true, spur: [] };
      } else if (!finger.size) { geste = null; landen(); }
      return;
    }
    if (finger.size) return;
    const g = geste; geste = null;
    if (e.type === 'pointercancel') return landen();
    if (!g.bewegt) return tippen(e, g);
    if (g.art === 'wisch') {
      el.classList.remove('zieht');
      const v = tempo(g, e.timeStamp);
      if (Math.abs(e.clientY - g.sy) > 110 || Math.abs(v.y) > .55) return zu();
      entdaempfe();
      return gleite(1, 0, 0, 300);
    }
    // Schwung mitnehmen: das Bild gleitet nach dem Loslassen noch ein Stueck
    const v = tempo(g, e.timeStamp);
    if (Math.hypot(v.x, v.y) > .15 && z > 1.02) {
      const [nx, ny] = begrenzt(z, tx + v.x * 240, ty + v.y * 240);
      return gleite(z, nx, ny, 560);
    }
    landen();
  };
  el.addEventListener('pointerup', los);
  el.addEventListener('pointercancel', los);
  // Mausrad und Trackpad (Pinch am Trackpad kommt als Strg+Rad)
  el.addEventListener('wheel', e => {
    e.preventDefault();
    if (bildOffen !== el) return;
    halte();
    const dy = e.deltaY * (e.deltaMode === 1 ? 33 : 1);
    const f = Math.exp(-dy * (e.ctrlKey ? .012 : .0025));
    let [nz, nx, ny] = zoomUm(Math.min(6, Math.max(1, z * f)), e.clientX, e.clientY);
    [nx, ny] = begrenzt(nz, nx, ny);
    z = nz; tx = nx; ty = ny; setze();
  }, { passive: false });

  // ---- Zugeschnitten / Original
  let wechselt = false;
  const setzeWahl = m => {
    if (!wahl) return;
    wahl.classList.toggle('rechts', m === 'orig');
    wahl.querySelectorAll('[data-bl]').forEach(k => {
      k.classList.toggle('an', k.dataset.bl === m);
      k.setAttribute('aria-selected', String(k.dataset.bl === m));
    });
  };
  const wechsle = async ziel => {
    if (ziel === modus || wechselt) return;
    wechselt = true;
    try { await wechsleJetzt(ziel); } finally { wechselt = false; }
  };
  const wechsleJetzt = async ziel => {
    buzz(6);
    setzeWahl(ziel);
    let quelle = src;
    if (ziel === 'orig') {
      if (!orig) {
        el.classList.add('laedt');
        const url = await ladeOriginal().catch(() => null);
        el.classList.remove('laedt');
        if (url) {
          urls.push(url);
          const probe = new Image();
          probe.src = url;
          try { await probe.decode(); } catch { /* unten geprueft */ }
          if (probe.naturalWidth) orig = { url, w: probe.naturalWidth, h: probe.naturalHeight };
        }
      }
      if (bildOffen !== el) return;
      if (!orig) { setzeWahl(modus); island('Das Original ist gerade nicht abrufbar'); return; }
      quelle = orig.url;
    }
    const raus = leise ? null : rahmen.animate(
      [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }],
      { duration: 130, easing: 'ease-in', fill: 'forwards' });
    if (raus) await raus.finished.catch(() => {});
    if (bildOffen !== el) return;
    flaeche.getAnimations().forEach(a => a.cancel());
    z = 1; tx = 0; ty = 0; setze();
    modus = ziel;
    img.src = quelle;
    raus?.cancel();
    passeAn();
    if (!leise) rahmen.animate([{ opacity: 0, transform: 'scale(.97)' }, { opacity: 1, transform: 'none' }],
      { duration: 260, easing: weich });
  };
  wahl?.querySelectorAll('[data-bl]').forEach(k => { k.onclick = () => wechsle(k.dataset.bl); });

  el.querySelector('.bl-zu').onclick = zu;
  // Esc schliesst nur den Betrachter, nicht auch noch das Blatt dahinter
  const taste = e => { if (e.key === 'Escape') { e.stopPropagation(); zu(); } };
  addEventListener('keydown', taste, true);
  // Handy gedreht: neu einpassen, Zoom zuruecksetzen
  const neuLayout = () => {
    if (bildOffen !== el) return;
    flaeche.getAnimations().forEach(a => a.cancel());
    z = 1; tx = 0; ty = 0; setze();
    passeAn();
  };
  addEventListener('resize', neuLayout);
  return { zu };
}

// Bild eines Gutscheins pflegen: antippen zum Vergroessern, neu hochladen (mit
// direktem Zuschnitt) oder selbst zuschneiden. Fester Rahmen, Bild wird
// verschoben und gezoomt — das ist auf dem Handy am treffsichersten.
function wireVoucherImage(v) {
  // Immer den Eintrag nehmen, der gerade in der Wallet liegt: nach "Ändern"
  // oder einem Abgleich ist das ein neues Objekt, das alte ist tot
  const id = v.id;
  const aktuell = () => state.wallet.vouchers.find(x => x.id === id) || null;
  const bildGross = () => {
    const bild = $('#wv-bild');
    const x = aktuell();
    if (!bild || !x) return;
    zeigeBildGross({
      vonEl: bild, src: bild.src,
      // Umschalter nur, wenn es neben dem Zuschnitt wirklich ein Original gibt
      ladeOriginal: x.orig && x.codeImg ? () => origLaden(x) : null,
    });
  };
  $('#wv-bild')?.addEventListener('click', bildGross);
  $('#wv-bild')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bildGross(); }
  });
  $('#wv-img-zoom')?.addEventListener('click', bildGross);

  $('#wv-img-file')?.addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    const url = await new Promise((res, rej) => {
      const rd = new FileReader();
      rd.onload = () => res(rd.result); rd.onerror = rej; rd.readAsDataURL(f);
    });
    // Das ganze Foto bleibt als Original erhalten (verkleinert, ausserhalb der Wallet)
    const ganzesFoto = await readImageFile(f, 1600, 0.82, 'foto').catch(() => '');
    if (walletGesperrt() || !aktuell()) return;  // inzwischen gesperrt oder weg
    openImgCrop(url, (out, info) => {
      const x = aktuell();
      if (walletGesperrt() || !x || schenktGerade(x.id)) return;
      if (info.ganz || !ganzesFoto) origEntfernen(x); // sonst zeigte "Original" noch das alte Foto
      else origSichern(x, ganzesFoto);
      x.codeImg = out; x.img = ''; x.bildMt = Math.max(Date.now(), (x.bildMt || 0) + 1); saveWallet(); openVoucherSheet(x.id);
    });
  });
  $('#wv-img-crop')?.addEventListener('click', async () => {
    // Vom Original aus zuschneiden: so laesst sich der Ausschnitt auch wieder
    // groesser ziehen, nicht nur immer kleiner
    const start = aktuell();
    if (!start) return;
    const vomOriginal = start.orig ? await origLaden(start) : null;
    const x0 = aktuell();
    if (walletGesperrt() || !x0) return;
    openImgCrop(vomOriginal || x0.codeImg || x0.img, (out, info) => {
      const x = aktuell();
      if (walletGesperrt() || !x || schenktGerade(x.id)) return;
      if (info.ganz) origEntfernen(x);          // jetzt IST das Bild das Original
      else if (!x.orig && x.img) origSichern(x, x.img); // bisher unbeschnitten: das wird das Original
      x.codeImg = out; x.img = ''; x.bildMt = Math.max(Date.now(), (x.bildMt || 0) + 1); saveWallet(); openVoucherSheet(x.id);
    });
  });
}
function openImgCrop(src, onDone) {
  const wrap = document.createElement('div');
  wrap.className = 'overlay crop-overlay';
  wrap.innerHTML = `<div class="modal crop-modal">
    <h2 class="card-h">Zuschneiden</h2>
    <p class="muted" style="font-size:.78rem">Ziehen zum Verschieben, zwei Finger zum Zoomen.
      Was im Rahmen liegt, wird gespeichert.</p>
    <div class="crop-stage" id="crop-stage">
      <img id="crop-src" src="${src}" alt="" draggable="false">
      <div class="crop-gitter" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
      <div class="crop-ecken" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    </div>
    <div class="crop-zoomrow">
      ${icon('search', 'icon icon-sm')}
      <input type="range" id="crop-zoom" min="100" max="400" value="100" aria-label="Zoom">
    </div>
    <div class="crop-actions">
      <button class="btn btn-small btn-ghost" id="crop-cancel">Abbrechen</button>
      <button class="btn btn-small btn-ghost" id="crop-full">Ganzes Bild</button>
      <button class="btn crop-ok" id="crop-ok">Fertig</button>
    </div>
  </div>`;
  document.body.appendChild(wrap);
  const stage = wrap.querySelector('#crop-stage');
  const img = wrap.querySelector('#crop-src');
  const regler = wrap.querySelector('#crop-zoom');
  let zoom = 1, offX = 0, offY = 0, baseScale = 1;
  const applyT = () => { img.style.transform = `translate(${offX}px, ${offY}px) scale(${zoom})`; };
  const setzeZoom = (nz, cx, cy) => {
    nz = Math.max(1, Math.min(4, nz));
    offX = cx - (cx - offX) * (nz / zoom);
    offY = cy - (cy - offY) * (nz / zoom);
    zoom = nz;
    regler.value = Math.round(zoom * 100);
    applyT();
  };
  const grundstellung = () => {
    baseScale = stage.clientWidth / img.naturalWidth;
    img.style.width = stage.clientWidth + 'px';
    zoom = 1; offX = 0;
    offY = (stage.clientHeight - img.naturalHeight * baseScale) / 2;
    regler.value = 100;
    applyT();
  };
  img.onload = grundstellung;
  if (img.complete && img.naturalWidth) grundstellung();

  // Ein Finger schiebt, zwei Finger zoomen — wie in der Foto-App
  const finger = new Map();
  let start = null;
  stage.addEventListener('pointerdown', e => {
    finger.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Der zweite Finger laesst sich nicht immer einfangen — das darf den
    // Rest des Handlers nicht abbrechen
    try { stage.setPointerCapture(e.pointerId); } catch { /* egal */ }
    if (finger.size === 1) start = { x: e.clientX - offX, y: e.clientY - offY };
    if (finger.size === 2) {
      const [a, b] = [...finger.values()];
      start = { abstand: Math.hypot(a.x - b.x, a.y - b.y), zoom,
                mx: (a.x + b.x) / 2 - stage.getBoundingClientRect().left,
                my: (a.y + b.y) / 2 - stage.getBoundingClientRect().top };
    }
  });
  stage.addEventListener('pointermove', e => {
    if (!finger.has(e.pointerId)) return;
    finger.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (finger.size === 1 && start) {
      offX = e.clientX - start.x; offY = e.clientY - start.y; applyT();
    } else if (finger.size === 2 && start?.abstand) {
      const [a, b] = [...finger.values()];
      const jetzt = Math.hypot(a.x - b.x, a.y - b.y);
      setzeZoom(start.zoom * (jetzt / start.abstand), start.mx, start.my);
    }
  });
  const fingerWeg = e => {
    finger.delete(e.pointerId);
    start = finger.size === 1
      ? { x: [...finger.values()][0].x - offX, y: [...finger.values()][0].y - offY }
      : null;
  };
  stage.addEventListener('pointerup', fingerWeg);
  stage.addEventListener('pointercancel', fingerWeg);
  // Doppeltippen setzt zurück
  let letzterTipp = 0;
  stage.addEventListener('pointerup', () => {
    const jetzt = Date.now();
    if (jetzt - letzterTipp < 320) grundstellung();
    letzterTipp = jetzt;
  });
  regler.addEventListener('input', e =>
    setzeZoom(Number(e.target.value) / 100, stage.clientWidth / 2, stage.clientHeight / 2));

  const finish = (out, info) => {
    wrap.classList.add('closing');
    setTimeout(() => wrap.remove(), 240);
    if (out) onDone(out, info || {});
  };
  wrap.querySelector('#crop-cancel').onclick = () => finish(null);
  wrap.addEventListener('click', e => { if (e.target === wrap) finish(null); });
  wrap.querySelector('#crop-full').onclick = () => {
    // Ganzes Foto uebernehmen — kompakt, aber Kleingedrucktes bleibt lesbar
    finish(kodiereBild(img, 'foto'), { ganz: true });
  };
  wrap.querySelector('#crop-ok').onclick = () => {
    const k = baseScale * zoom;
    let sx = -offX / k, sy = -offY / k;
    let sw = stage.clientWidth / k, sh = stage.clientHeight / k;
    sx = Math.max(0, Math.min(img.naturalWidth - 10, sx));
    sy = Math.max(0, Math.min(img.naturalHeight - 10, sy));
    sw = Math.min(img.naturalWidth - sx, sw);
    sh = Math.min(img.naturalHeight - sy, sh);
    // Ausschnitt in voller Aufloesung, das Verkleinern uebernimmt kodiereBild
    const c = document.createElement('canvas');
    const outW = Math.min(2000, Math.round(sw));
    c.width = outW; c.height = Math.max(1, Math.round(outW * (sh / sw)));
    c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    finish(kodiereBild(c, 'code'));
  };
}
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
  const wrap = e.target.closest('[data-deal]');
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
$('#feed-hero').addEventListener('click', onOfferClick);
$('#search-results').addEventListener('click', onOfferClick);
$('#coupons-content').addEventListener('click', onOfferClick);

// ---------------- Favoriten + Erinnerungen ----------------

function toggleFav(dealId) {
  const d = state.deals.find(x => x.id === dealId) || state.favs[dealId]?.deal;
  if (!d) return;
  if (state.favs[dealId]) {
    delete state.favs[dealId];
    save('favs', state.favs);
    aktualisiereHerzen(dealId);
    showToast({ title: 'Aus der Merkliste entfernt', iconName: 'x', text: d.title.slice(0, 60) }, 3000);
    return;
  }
  state.favs[dealId] = { deal: d, ts: Date.now(), remindAt: null, notified: false };
  bumpAff(d, 2);
  save('favs', state.favs);
  aktualisiereHerzen(dealId);
  buzz(10);
  showToast({
    title: 'Deal gemerkt',
    text: 'Wann sollen wir dich erinnern, damit er nicht untergeht?',
    iconName: 'heart',
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

function openSheetShell(richtung) {
  schliesseMarkenMenue();
  // Formulare (Hinzufügen) kompakt statt Vollbild, kein leerer Swipe-Raum
  $('#sheet').classList.toggle('compact', state.sheetMode === 'wallet-add');
  const schonOffen = $('#sheet').classList.contains('open');
  $('#sheet').inert = false;
  $('#sheet-backdrop').classList.remove('hidden');
  requestAnimationFrame(() => {
    $('#sheet-backdrop').classList.add('show');
    $('#sheet').classList.add('open');
  });
  const inhalt = $('#sheet-content');
  inhalt.scrollTop = 0;
  // Nur beim Wechsel im schon offenen Blatt gleiten — beim ersten Öffnen
  // animiert ohnehin das Blatt selbst von unten herein
  if (schonOffen && richtung && !reducedMotion()) {
    inhalt.classList.remove('blatt-vor', 'blatt-zurueck');
    void inhalt.offsetWidth;
    inhalt.classList.add(richtung === 'zurueck' ? 'blatt-zurueck' : 'blatt-vor');
    inhalt.addEventListener('animationend',
      () => inhalt.classList.remove('blatt-vor', 'blatt-zurueck'), { once: true });
  }
}

// Haelt die Animation, mit der das Blatt beim Verschenken kleiner faehrt.
// Steht hier oben, weil closeSheet sie loesen muss (siehe dort).
let blattSchrumpf = null;
function closeSheet() {
  waScanLauf++; // laufende Scans duerfen nichts mehr eintragen
  // Falls die Verschenk-Animation das Blatt kleiner gefahren hat: loesen, sonst
  // haelt ihr fill:'forwards' das Blatt an Ort und Stelle fest und es liesse
  // sich nicht mehr wegschieben.
  if (blattSchrumpf) { blattSchrumpf.cancel(); blattSchrumpf = null; }
  // Die Wisch- und Klick-Handler der Coupon-Liste gelten nur fuer dieses Blatt
  if (state.sheetMode === 'card-coupons' || state.sheetMode === 'brand') {
    const sh = $('#sheet-content');
    sh.onpointerdown = sh.onpointermove = sh.onpointerup = sh.onpointercancel = sh.onclick = null;
    ccCtx = null;
  }
  $('#sheet').classList.remove('open');
  // Zu ist zu: auch per Tastatur oder Vorlese-Funktion nicht mehr erreichbar
  $('#sheet').inert = true;
  $('#sheet-backdrop').classList.remove('show');
  setTimeout(() => $('#sheet-backdrop').classList.add('hidden'), 300);
  state.currentDeal = null;
  state.sheetMode = null;
}
$('#sheet-backdrop').addEventListener('click', closeSheet);
$('#sheet-handle').addEventListener('click', () => { if (!sheetDrag.moved) closeSheet(); });
$('#sheet-fab').addEventListener('click', closeSheet);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (topMenuOffen()) { schliesseTopMenu(); return; }
  closeSheet(); hideToast();
});

// Sheet mit Runterwischen schließen: immer über die Greifzone oben,
// im Inhalt nur, wenn er ganz nach oben gescrollt ist
const sheetDrag = { startY: 0, dy: 0, active: false, tracking: false, moved: false };
const sheetEl = $('#sheet');

sheetEl.addEventListener('pointerdown', e => {
  const content = $('#sheet-content');
  if (e.target.closest('.sheet-fab')) return;
  if (content.scrollTop > 0 && content.contains(e.target)) return;
  // Auf etwas Bedienbarem wird gar nicht erst aufs Ziehen gelauert. Vorher
  // schon: ein Finger wandert beim Tippen fast immer ein paar Pixel, dann
  // schnappte setPointerCapture zu und aus dem Tipp wurde NIE ein Klick — der
  // Knopf mit der Sparkarte oben rechts tat deshalb auf dem Handy nichts.
  // Gezogen wird weiterhin ueberall sonst: Griff, Freiflaeche, Text, Bilder.
  if (e.target.closest('button, a, input, textarea, select, label, [role="button"], .votebtn')) return;
  // Textauswahl und Native-Drag unterbinden
  e.preventDefault();
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
    // 8 px waren zu wenig fuer einen Finger; 14 px trennt Tippen und Ziehen
    if (dy < 14) return;
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

function patchCompare(d) {
  document.querySelectorAll(`[data-deal="${CSS.escape(d.id)}"] .compare-slot`).forEach(slot => { slot.innerHTML = renderComparePrice(d); });
  // Offene Deal-Seite: nur Preiszeile und Preisvergleich nachziehen — Text,
  // Kommentare und ein angefangener Kommentar bleiben stehen
  dealSeiten(d.id).forEach(s => { s.deal = d; dealSeitePreise(s); });
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

// =============================================================================
// Deal als eigene Seite (Runde 120), gebaut wie die Gutschein-Seite: gleitet
// von rechts herein, der Pfeil oben links und ein Wisch nach rechts fuehren
// zurueck. Oben das Bild (ohne Bild das Logo gross auf der Markenfarbe wie auf
// der Kachel), darunter Titel, Preis, Hinweise und Bewertung, dann
// Preisvergleich, Beschreibung, Regeln und Kommentare. Unten fest: "Zum Deal"
// und Merken, unter "Mehr" Teilen, an einen Freund schicken und (Redaktion)
// bearbeiten. Das alte Deal-Blatt gibt es nicht mehr.
// =============================================================================
function dealVonId(id) { return state.deals.find(x => x.id === id) || state.favs[id]?.deal || null; }
function dealSeiten(id) { return wseiten().filter(s => s.art === 'deal' && (id == null || s.id === id)); }
function dealMarke(d) { return d.merchant || channelBySlug(d.channel)?.name || 'Deal'; }
// Wohin der grosse Knopf fuehrt: Deal-Link, sonst die Quelle, sonst der Shop
// der Marke (nur bei bekannter Domain) — dann heisst der Knopf auch so
function dealZiel(d) {
  const url = [d.dealUrl, d.sourceUrl].find(u => /^https?:\/\//.test(u || ''));
  if (url) return { url, text: 'Zum Deal' };
  const shop = rabattShopUrl(d.merchant);
  return shop ? { url: shop, text: `Zu ${d.merchant}` } : null;
}

// Alle Aufrufer (Kacheln, Banner, Suche, Geld zurueck, Merkliste, Chat,
// Erinnerung, ?deal=) landen hier — immer mit dem frischesten Stand des Deals
function openDealSheet(deal) {
  if (!deal) return;
  oeffneDealSeite(dealVonId(deal.id) || deal);
}
function oeffneDealSeite(d) {
  // Eine offene Tastatur (Chat) erst zu, sonst stuende die Seite verschoben
  const fokus = document.activeElement;
  if (fokus?.matches?.('input, textarea') && !fokus.closest('.wseite')) fokus.blur();
  // Derselbe Deal liegt schon oben: nur auffrischen
  const oben = wseiteOben();
  if (oben && oben.art === 'deal' && oben.id === d.id) { oben.deal = d; dealSeitePreise(oben); dealSeitenSterne(d.id); return; }
  // Liegt ein Blatt ueber einer Seite, kaeme die neue Seite darunter: Blatt zu
  if (document.body.classList.contains('blatt-ueber-seite') && state.sheetMode) closeSheet();
  // Vibrieren nur nach einem Tipp (per ?deal= beim Start blockt der Browser es)
  if (navigator.userActivation?.hasBeenActive !== false) buzz(8);
  requestCompare(d); // Marktpreis nachladen, falls noch nicht da
  const seite = wseiteOeffnen({
    art: 'deal', id: d.id, titel: dealMarke(d), klasse: 'gd dl',
    baue: s => { s.deal = d; zeichneDealSeite(s); },
  });
  if (!seite) return;
  seite.el.addEventListener('click', e => dealSeiteKlick(seite, e));
  refreshComments(seite);
}

// Bild oben: Fotos zum Durchwischen, ohne Foto das Logo auf der Markenfarbe
function dealBildHtml(d) {
  const marke = dealMarke(d);
  const bilder = [...new Set(d.images && d.images.length ? d.images : [d.image])].filter(u => /^https?:\/\//.test(u || ''));
  const logo = `<span class="dl-logo" aria-hidden="true">${brandChipHtml(marke, true)}</span>`;
  if (!bilder.length) return `<div class="dl-bild ohne" style="--bc:${brandColor(marke)}">${logo}${rabattPill(d)}</div>`;
  return `
    <div class="dl-bild" style="--bc:${brandColor(marke)}">
      <div class="dl-bilder"${bilder.length > 1 ? ' data-kein-wisch' : ''}>
        ${bilder.map((u, i) => `<img src="${esc(u)}" alt="${i ? '' : esc(d.title)}" draggable="false" decoding="async" referrerpolicy="no-referrer"${i ? ' loading="lazy"' : ''}>`).join('')}
      </div>
      ${logo}
      ${rabattPill(d)}
      ${bilder.length > 1 ? `<div class="dl-punkte" aria-hidden="true">${bilder.map((_, i) => `<i class="${i ? '' : 'an'}"></i>`).join('')}</div>` : ''}
    </div>`;
}

// Preis rot, daneben der Streichpreis und (falls da) der Marktpreis
function dealPreiseHtml(d) {
  const teile = [];
  if (d.free) teile.push('<b class="dl-preis">Gratis</b>');
  else if (d.price) teile.push(`<b class="dl-preis">${esc(preisFmt(d.price))}</b>`);
  if (!d.free && d.origPrice) teile.push(`<s>${esc(preisFmt(d.origPrice))}</s>`);
  if (!d.free && d.compare?.price) {
    teile.push(`<span class="dl-markt">${d.compare.last ? 'zuletzt' : 'Markt ab'} ${esc(preisFmt(d.compare.price))}</span>`);
  }
  return teile.join('');
}

// Hinweise als kleine Pillen: Neukunden, Zeit mit Uhr, Kanal, Warnungen
function dealPillenHtml(d) {
  const c = channelBySlug(d.channel);
  const zeit = d.stale ? { ico: 'clock', html: esc(timeAgo(d.ts)) } : dealZeitChip(d);
  const p = [];
  // Rabatt und "Preisfehler" stehen schon gelb bzw. rot oben auf dem Bild
  if (d.stale) p.push('<span class="dl-pille alt">Vermutlich vorbei</span>');
  if (d.newCustomer) p.push(`<span class="dl-pille neu">${icon('user', 'icon')}Nur Neukunden</span>`);
  if (d.earn) p.push(`<span class="dl-pille verdienst">${icon('banknote', 'icon')}Verdienst</span>`);
  if (d.compareChecked) p.push(`<span class="dl-pille ok" title="Vergleichspreis mit billiger.de geprüft">${icon('check', 'icon')}Preis geprüft</span>`);
  p.push(`<span class="dl-pille zeit">${icon(zeit.ico, 'icon')}<span>${zeit.html}</span></span>`);
  if (c && c.slug !== 'preisfehler') p.push(`<span class="dl-pille">${icon(c.icon || 'tag', 'icon')}${esc(c.name)}</span>`);
  (d.flags || []).forEach(f => p.push(`<span class="dl-pille warn">${icon('warning', 'icon')}${esc(f)}</span>`));
  return `<div class="dl-pillen">${p.join('')}</div>`;
}

// Bewertung: Schnitt links, rechts fuenf Sterne zum Antippen
function dealSterneHtml(d) {
  const mein = state.stars[d.id] || 0;
  const schnitt = d.rating || 0;
  const n = d.ratingCount || 0;
  const zeigen = mein || Math.round(schnitt);
  const unten = [n ? `${n} ${n === 1 ? 'Bewertung' : 'Bewertungen'}` : (mein ? '' : 'Noch keine Bewertung'), mein ? `deine: ${mein}` : '']
    .filter(Boolean).join(' · ');
  return `
    <div class="gd-block dl-bewertung">
      <span class="dl-bew-text"><b>${n ? `${schnitt.toFixed(1).replace('.', ',')} von 5` : 'Bewerten'}</b><small>${unten}</small></span>
      <span class="dl-sterne" role="group" aria-label="Deal bewerten">${[1, 2, 3, 4, 5].map(i => `
        <button class="dl-stern${i <= zeigen ? ' an' : ''}" type="button" data-stern="${i}"
          aria-label="Mit ${i} ${i === 1 ? 'Stern' : 'Sternen'} bewerten"${mein === i ? ' aria-pressed="true"' : ''}>${icon('star', 'icon')}</button>`).join('')}
      </span>
    </div>`;
}

// Preisvergleich: vorher / Markt / Deal als Balken (nur transform), darunter
// der Sprung zu billiger.de, falls der Marktpreis von dort kommt
function dealVergleichHtml(d) {
  if (d.free) return '';
  const jetzt = parsePriceNum(d.price);
  const vorher = parsePriceNum(d.origPrice);
  const markt = d.compare?.priceNum || null;
  const link = /^https?:\/\//.test(d.compare?.url || '') ? d.compare.url : '';
  const balken = jetzt && (vorher || markt);
  if (!balken && !link) return '';
  const max = Math.max(jetzt || 0, vorher || 0, markt || 0) || 1;
  const zeile = (label, wert, text, cls = '') => `
      <div class="dl-v-zeile${cls}">
        <span class="dl-v-label">${label}</span>
        <span class="dl-v-spur"><i style="transform:scaleX(${Math.max(0.06, wert / max).toFixed(4)})"></i></span>
        <b>${text}</b>
      </div>`;
  return `
    <h3 class="gd-h">Preisvergleich</h3>
    <div class="gd-block dl-vergleich">
      ${balken ? `
      ${vorher ? zeile('vorher', vorher, esc(preisFmt(d.origPrice))) : ''}
      ${markt ? zeile(d.compare.last ? 'Markt zuletzt' : 'Markt ab', markt, esc(preisFmt(d.compare.price))) : ''}
      ${zeile('Deal', jetzt, `${esc(preisFmt(d.price))}${d.discount != null && d.discount > 0 ? ` <small>−${Math.round(d.discount)} %</small>` : ''}`, ' jetzt')}
      <p class="dl-v-quelle">${markt
        ? `Marktpreis von billiger.de, ${d.compare.last ? 'zuletzt bekannt' : 'günstigstes Angebot'}${d.compare.shippingIncluded ? ' inkl. Versand' : ''}`
        : 'Vergleichspreis aus den Deal-Angaben'}</p>` : ''}
      ${link ? `
      <a class="dl-v-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer">
        <span><b>Bei billiger.de ansehen</b>${d.compare.price ? `<small>ab ${esc(preisFmt(d.compare.price))}</small>` : ''}</span>
        ${icon('arrow-out', 'icon')}
      </a>` : ''}
    </div>`;
}

// Beschreibung: die Texte bringen teils Markdown mit (## Ueberschrift, **fett**,
// * Liste). Einfache Umsetzung: jeder Textteil wird escaped, erst danach werden
// die bekannten Zeichen zu Tags. Links werden antippbar (neuer Tab).
function dealTextHtml(text) {
  const zeilen = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const aus = [];
  let absatz = [];
  let liste = null;
  const absatzZu = () => { if (absatz.length) { aus.push(`<p>${absatz.map(mdZeile).join('<br>')}</p>`); absatz = []; } };
  const listeZu = () => {
    if (!liste) return;
    aus.push(`<${liste.art}>${liste.punkte.map(p => `<li>${mdZeile(p)}</li>`).join('')}</${liste.art}>`);
    liste = null;
  };
  const inListe = (art, punkt) => {
    absatzZu();
    if (liste?.art !== art) { listeZu(); liste = { art, punkte: [] }; }
    liste.punkte.push(punkt);
  };
  for (const roh of zeilen) {
    const z = roh.trim();
    let m;
    if (!z) { absatzZu(); listeZu(); }
    else if ((m = z.match(/^(#{1,6})\s+(.+)$/))) {
      absatzZu(); listeZu();
      aus.push(`<h4 class="dl-md-h${m[1].length <= 2 ? ' gross' : ''}">${mdZeile(m[2].replace(/\s+#+$/, ''))}</h4>`);
    }
    else if (/^([-*_])(\s*\1){2,}$/.test(z)) { absatzZu(); listeZu(); aus.push('<hr>'); }
    else if ((m = z.match(/^[*\-•+]\s+(.+)$/))) inListe('ul', m[1]);
    else if ((m = z.match(/^\d{1,2}[.)]\s+(.+)$/))) inListe('ol', m[1]);
    else { listeZu(); absatz.push(z.replace(/^>\s?/, '')); }
  }
  absatzZu(); listeZu();
  return aus.join('');
}
// Eine Zeile: Links ([Text](url) oder nackte URL) herausloesen, der Rest
// bekommt fett/kursiv/durchgestrichen/Code
function mdZeile(roh) {
  const s = String(roh || '');
  const re = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"'\])]+)/g;
  let aus = '', pos = 0, m;
  while ((m = re.exec(s))) {
    aus += mdBetonung(s.slice(pos, m.index));
    let url = m[2] || m[3], text = m[1] || '', rest = '';
    if (!text) {
      const satz = url.match(/[.,;:!?]+$/);        // Satzzeichen am Ende gehoeren nicht zum Link
      if (satz) { rest = satz[0]; url = url.slice(0, -rest.length); }
      text = url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
      if (text.length > 40) text = text.slice(0, 38) + '…';
    }
    aus += `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${mdBetonung(text)}</a>${esc(rest)}`;
    pos = re.lastIndex;
  }
  return aus + mdBetonung(s.slice(pos));
}
function mdBetonung(roh) {
  return esc(roh)
    .replace(/\*\*(?=\S)(.*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)(.*?\S)__/g, '<strong>$1</strong>')
    .replace(/~~(?=\S)(.*?\S)~~/g, '<s>$1</s>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(^|[\s(])\*(?=\S)([^*]*?\S)\*(?=$|[\s).,!?:;])/g, '$1<em>$2</em>')
    .replace(/\*\*/g, '');                           // uebrig gebliebene Sternchen-Paare
}

// Unten: Kommentar schreiben (angemeldet) bzw. der Weg zum Anmelden
function dealSchreibenHtml() {
  if (!state.token) return `
    <div class="gd-block dl-schreiben gast">
      <span>Zum Kommentieren bitte anmelden.</span>
      <button class="dl-anmelden" type="button" data-dl="anmelden">Anmelden</button>
    </div>`;
  return `
    <div class="gd-block dl-schreiben">
      <div class="dl-antwort" hidden><span></span>
        <button type="button" data-dl="antwort-weg" aria-label="Antwort abbrechen">${icon('x', 'icon')}</button></div>
      <div class="dl-eingabe">
        <textarea class="dl-feld" maxlength="600" rows="1" placeholder="Kommentar schreiben …" aria-label="Kommentar schreiben"></textarea>
        <button class="dl-senden" type="button" data-dl="kommentar" disabled aria-label="Kommentar senden">${icon('send', 'icon')}</button>
      </div>
      <p class="dl-meldung" role="alert"></p>
    </div>`;
}

// Feste Leiste unten: "Zum Deal" und Merken, darunter "Mehr"
function dealLeisteHtml(d) {
  const ziel = dealZiel(d);
  const an = !!state.favs[d.id];
  const opts = [
    ['teilen', icon('share'), 'Teilen', 'Link teilen oder kopieren'],
    ['freund', icon('send'), 'An Freund schicken', 'Als Nachricht im Chat'],
    state.role === 'admin' && d.source === 'community' && ['bearbeiten', wIcon('stift'), 'Deal bearbeiten', 'Nur für die Redaktion'],
  ].filter(Boolean);
  return `
    <div class="wseite-leiste gd-leiste dl-leiste">
      <div class="dl-knoepfe${ziel ? '' : ' ohne-ziel'}">
        ${ziel ? `<a class="gd-knopf gd-ab dl-los" href="${esc(ziel.url)}" target="_blank" rel="noopener noreferrer" data-dl="los">
          <span>${esc(ziel.text)}</span>${icon('arrow-out', 'icon')}</a>` : ''}
        <button class="gd-knopf dl-herz${an ? ' on' : ''}" type="button" data-dl="merken" data-bm="${esc(d.id)}"
          aria-pressed="${an}" aria-label="${an ? 'Nicht mehr merken' : 'Merken'}">
          <span class="dl-herz-bild">${icon('heart', 'icon dl-h-o')}${icon('heart-f', 'icon dl-h-f')}</span>${ziel ? '' : `<span class="dl-herz-text">${an ? 'Gemerkt' : 'Merken'}</span>`}
        </button>
      </div>
      <button class="gd-mehr" type="button" aria-expanded="false" aria-controls="dl-opt-${esc(d.id)}">
        <span>Mehr</span>${icon('chevron-down', 'icon gd-mehr-pfeil')}</button>
      <div class="gd-optionen" id="dl-opt-${esc(d.id)}" role="menu" aria-label="Weitere Aktionen">
        ${opts.map(([k, bild, t, sub]) => `
        <button class="gd-option" type="button" role="menuitem" data-dl="${k}" tabindex="-1">
          <span class="gd-option-bild">${bild}</span>
          <span class="gd-option-text"><b>${t}</b><small>${sub}</small></span>
        </button>`).join('')}
      </div>
      <div class="gd-fuss" aria-hidden="true"></div>
    </div>`;
}

function zeichneDealSeite(seite) {
  const d = seite.deal;
  const el = seite.el;
  const inhalt = el.querySelector('.wseite-inhalt');
  const rules = channelBySlug(d.channel)?.rules || [];
  el.querySelector('.wseite-titel').textContent = dealMarke(d);
  el.setAttribute('aria-label', `Deal: ${d.title}`);
  const tag = new Date(d.ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const vergleich = dealVergleichHtml(d);
  inhalt.innerHTML = `
    ${dealBildHtml(d)}
    <h1 class="dl-titel">${esc(d.title)}</h1>
    <div class="dl-preise" data-dl-preise>${dealPreiseHtml(d)}</div>
    ${dealPillenHtml(d)}
    <div data-dl-sterne>${dealSterneHtml(d)}</div>
    <div data-dl-vergleich>${vergleich}</div>
    ${d.excerpt ? `
    <h3 class="gd-h">Beschreibung</h3>
    <div class="gd-block dl-text zu">${dealTextHtml(d.excerpt)}</div>
    <button class="dl-mehr-text" type="button" data-dl="mehr-text" aria-expanded="false" hidden>
      <span>Mehr anzeigen</span>${icon('chevron-down', 'icon')}</button>` : ''}
    ${rules.length ? `
    <details class="gd-block dl-regeln">
      <summary>${icon('list', 'icon')}<span>Regeln &amp; Richtlinien</span>${icon('chevron-down', 'icon dl-regeln-pfeil')}</summary>
      <ul class="dl-regeln-liste">${rules.map(r => `<li>${icon('check', 'icon')}<span>${esc(r)}</span></li>`).join('')}</ul>
    </details>` : ''}
    <h3 class="gd-h">Kommentare <small class="dl-k-zahl"></small></h3>
    <div class="dl-kommentare sheet-comments"><p class="dl-leise">Lade …</p></div>
    ${dealSchreibenHtml()}
    <p class="dl-fuss">${d.source === 'mydealz' ? 'Automatisch gefunden' : 'Eingestellt von der Redaktion'} · ${tag}</p>`;
  inhalt.scrollTop = 0;
  inhalt.querySelector('[data-dl-vergleich]')._quelle = vergleich;
  gdLeisteSetzen(seite, dealLeisteHtml(d));
  gdLeisteMessen(seite);
  dealSeiteVerdrahten(seite);
}

// Nur die Preiszeile und den Preisvergleich neu (Marktpreis kam nach)
function dealSeitePreise(seite) {
  const d = seite.deal;
  const preise = seite.el.querySelector('[data-dl-preise]');
  if (preise) preise.innerHTML = dealPreiseHtml(d);
  const v = seite.el.querySelector('[data-dl-vergleich]');
  if (v) {
    const neu = dealVergleichHtml(d);
    if (v._quelle !== neu) { v._quelle = neu; v.innerHTML = neu; if (neu) reinGleiten([...v.children], { versatz: 8 }); }
  }
}
// Sterne auf allen offenen Seiten dieses Deals
function dealSeitenSterne(id) {
  dealSeiten(id).forEach(s => {
    const slot = s.el.querySelector('[data-dl-sterne]');
    if (slot) slot.innerHTML = dealSterneHtml(dealVonId(id) || s.deal);
  });
}
function dealHerzAuffrischen(seite) {
  const b = seite.el.querySelector('.dl-herz');
  if (!b) return;
  const an = !!state.favs[seite.id];
  b.classList.toggle('on', an);
  b.setAttribute('aria-pressed', String(an));
  b.setAttribute('aria-label', an ? 'Nicht mehr merken' : 'Merken');
  const t = b.querySelector('.dl-herz-text');
  if (t) t.textContent = an ? 'Gemerkt' : 'Merken';
}

// Nach jedem Zeichnen: Bilder, Text-Laenge, Kommentarfeld
function dealSeiteVerdrahten(seite) {
  const el = seite.el;
  // Bilder: kaputte fallen weg; bleibt keins, steht das Logo auf der Markenfarbe
  const bild = el.querySelector('.dl-bild:not(.ohne)');
  if (bild) {
    const leiste = bild.querySelector('.dl-bilder');
    const punkte = bild.querySelector('.dl-punkte');
    const weg = img => {
      const i = [...leiste.children].indexOf(img);
      img.remove();
      if (punkte && i >= 0) punkte.children[i]?.remove();
      if (!leiste.children.length) { bild.classList.add('ohne'); leiste.remove(); punkte?.remove(); }
      else if (leiste.children.length < 2) { punkte?.remove(); leiste.removeAttribute('data-kein-wisch'); }
    };
    leiste.querySelectorAll('img').forEach(img => {
      if (img.complete && !img.naturalWidth) weg(img);
      else img.addEventListener('error', () => weg(img), { once: true });
    });
    if (punkte) leiste.addEventListener('scroll', () => {
      const i = Math.round(leiste.scrollLeft / Math.max(1, leiste.clientWidth));
      [...punkte.children].forEach((p, j) => p.classList.toggle('an', j === i));
    }, { passive: true });
  }
  // "Mehr anzeigen" nur, wenn der Text wirklich laenger ist
  const text = el.querySelector('.dl-text');
  const mehr = el.querySelector('.dl-mehr-text');
  if (text && mehr) {
    if (text.scrollHeight > text.clientHeight + 16) mehr.hidden = false;
    else text.classList.remove('zu');
  }
  // Kommentarfeld waechst mit (bis etwa sechs Zeilen), Senden erst ab 2 Zeichen
  const feld = el.querySelector('.dl-feld');
  if (feld) {
    const senden = el.querySelector('.dl-senden');
    feld.addEventListener('input', () => {
      feld.style.height = 'auto';
      feld.style.height = Math.min(feld.scrollHeight, 150) + 'px';
      senden.disabled = feld.value.trim().length < 2;
      el.querySelector('.dl-meldung').textContent = '';
    });
    feld.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendComment(seite); }
    });
  }
}

// Ein Element im Inhalt der Seite sichtbar machen — nur der Inhalt scrollt.
// (scrollIntoView verschoebe auch den Rahmen #wseiten und damit die Leiste.)
// Unten zaehlt nur, was nicht hinter der festen Leiste liegt.
function dealHinScrollen(seite, ziel) {
  const inhalt = seite.el.querySelector('.wseite-inhalt');
  if (!inhalt || !ziel) return;
  const r = ziel.getBoundingClientRect();
  const ri = inhalt.getBoundingClientRect();
  const unten = ri.bottom - (parseFloat(getComputedStyle(seite.el).getPropertyValue('--gd-leiste-h')) || 0);
  const d = r.top < ri.top + 12 ? r.top - ri.top - 12 : r.bottom > unten - 12 ? Math.min(r.bottom - unten + 12, r.top - ri.top - 12) : 0;
  if (d) inhalt.scrollBy({ top: d, behavior: reducedMotion() ? 'auto' : 'smooth' });
}
// Der Rahmen um die Seiten scrollt nie selbst (overflow: hidden). Ein Fokus
// oder Sprung koennte ihn sonst verschieben — dann stuende die Leiste mitten
// im Bild. Sofort zurueck an den Anfang.
$('#wseiten')?.addEventListener('scroll', e => {
  const h = e.currentTarget;
  if (h.scrollTop || h.scrollLeft) h.scrollTo(0, 0);
}, { passive: true });

// Ein Klick-Verteiler je Seite (Leiste, Sterne, Kommentare, Text)
function dealSeiteKlick(seite, e) {
  const d = seite.deal;
  // Eine offene Emote-Auswahl geht bei jedem Klick daneben wieder zu
  if (!e.target.closest('.comment-emote-pick, [data-cemote]')) {
    seite.el.querySelectorAll('.comment-emote-pick').forEach(p => p.remove());
  }
  const stern = e.target.closest('[data-stern]');
  if (stern) { dealBewerten(d.id, Number(stern.dataset.stern), e.clientX, e.clientY); return; }
  if (e.target.closest('.gd-mehr')) { gdOptionen(seite); return; }
  if (e.target.closest('.gd-dimm')) { gdOptionen(seite, false); return; }
  const cm = e.target.closest('.comment[data-cid]');
  if (cm && dealKommentarKlick(seite, e, cm)) return;
  const b = e.target.closest('[data-dl]');
  if (!b) return;
  const k = b.dataset.dl;
  if (k === 'los') trackClick(d);                    // der Link oeffnet sich selbst
  else if (k === 'merken') { toggleFav(d.id); dealHerzAuffrischen(seite); }
  else if (k === 'teilen') { gdOptionen(seite, false); shareDeal(d); }
  else if (k === 'freund') { gdOptionen(seite, false); sendDealToFriend(d); }
  else if (k === 'bearbeiten') { gdOptionen(seite, false); openAdminPost(d); }
  else if (k === 'mehr-text') {
    const text = seite.el.querySelector('.dl-text');
    const zu = text.classList.toggle('zu');
    b.setAttribute('aria-expanded', String(!zu));
    b.querySelector('span').textContent = zu ? 'Mehr anzeigen' : 'Weniger anzeigen';
    if (zu) dealHinScrollen(seite, text);
  }
  else if (k === 'kommentar') sendComment(seite);
  else if (k === 'antwort-weg') dealAntwortWeg(seite);
  else if (k === 'anmelden') switchView('profile');
}

// Ein Kommentar mit Reaktionen (Like/Hilfreich/Emote), Antworten und Löschen.
// Namen ohne @ — wie ueberall im neuen Look nur der Name in seiner Farbe.
function commentHtml(c, replies) {
  if (c.deleted) {
    return `<div class="comment comment-tomb" data-cid="${esc(c.id)}"><div class="comment-text chat-deleted">${icon('x', 'icon icon-sm')} Kommentar entfernt</div>
      ${replies.map(r => commentHtml(r, [])).join('')}</div>`;
  }
  const role = c.role === 'admin' ? `<svg class="icon icon-sm chat-badge role-admin" aria-label="Redaktion"><use href="#i-crown"/></svg>` : '';
  const rx = c.reactions || {};
  const mine = k => (rx[k] || []).includes(state.userName);
  // Reaktionen mit Emotes, die es nicht mehr gibt, fallen weg
  const emoteRx = Object.keys(rx).filter(k => k !== 'like' && k !== 'helpful' && emoteOwned(k));
  const canDelete = state.userName === c.user || ['admin', 'mod'].includes(state.role);
  // Jeder Kommentar traegt Profilbild, Namensfarbe und Anzeigenamen seines
  // Autors — der Server liefert den jeweils AKTUELLEN Stand mit
  const ns = nameStyleOf(c.user, c.paint);
  merkeAnzeigename(c.user, c.anzeigename || '');
  merkeAvatar(c.user, c.avatar);
  const ava = avatarHtml(c.user, undefined, 'avatar-mini c-ava');
  return `
    <div class="comment" data-cid="${esc(c.id)}">
      <div class="comment-head">
        ${ava}
        <span class="comment-user${ns.cls}" style="${ns.style}" title="@${esc(c.user)}">${esc(anzeigeName(c.user))}</span>
        ${role}
        <span class="comment-time">${esc(timeAgo(c.ts))}</span>
        ${(c.flags || []).map(f => `<span class="pill pill-warn">${icon('warning', 'icon icon-sm')} ${esc(f)}</span>`).join('')}
      </div>
      <div class="comment-text">${withEmotes(esc(c.text))}</div>
      <div class="comment-actions">
        <button class="c-act ${mine('like') ? 'on' : ''}" type="button" data-creact="like" aria-label="Gefällt mir">${icon('thumb-up', 'icon icon-sm')} ${(rx.like || []).length || ''}</button>
        <button class="c-act ${mine('helpful') ? 'on' : ''}" type="button" data-creact="helpful">${icon('check', 'icon icon-sm')} Hilfreich ${(rx.helpful || []).length || ''}</button>
        <button class="c-act" type="button" data-cemote="1" aria-label="Mit Emote reagieren">${icon('smile', 'icon icon-sm')}</button>
        <button class="c-act" type="button" data-creply="${esc(c.user)}">Antworten</button>
        ${canDelete ? `<button class="c-act c-weg" type="button" data-cdel="1" aria-label="Kommentar löschen" title="Löschen">${wIcon('muell', 'icon icon-sm')}</button>` : ''}
        ${emoteRx.map(k => `<button class="c-act emote-rx ${mine(k) ? 'on' : ''}" type="button" data-creact="${esc(k)}">${emoteHtml(k)} ${rx[k].length}</button>`).join('')}
      </div>
      ${replies.map(r => commentHtml(r, [])).join('')}
    </div>`;
}

// Kommentare laden und angleichen (gleiche bleiben stehen, neue blenden ein)
async function refreshComments(seite) {
  seite = seite || dealSeiten().pop();
  if (!seite?.el.isConnected) return;
  const lauf = seite.kLauf = (seite.kLauf || 0) + 1;
  let list = null;
  try { list = await api('/api/comments?dealId=' + encodeURIComponent(seite.id)); } catch { list = null; }
  const box = seite.el.querySelector('.dl-kommentare');
  if (!box || !seite.el.isConnected || lauf !== seite.kLauf) return;
  if (!Array.isArray(list)) {
    if (!box.querySelector('.comment')) box.innerHTML = '<p class="dl-leise">Kommentare gerade nicht erreichbar.</p>';
    return;
  }
  const tops = list.filter(c => !c.parent);
  const repliesOf = id => list.filter(c => c.parent === id);
  const zahl = list.filter(c => !c.deleted).length;
  const z = seite.el.querySelector('.dl-k-zahl');
  if (z) z.textContent = zahl ? String(zahl) : '';
  box.querySelector('.comment-emote-pick')?.remove();
  inhaltAngleichen(box, tops.length
    ? tops.map(c => commentHtml(c, repliesOf(c.id))).join('')
    : '<p class="dl-leise">Noch keine Kommentare. Schreib den ersten.</p>');
}

// Klicks in einem Kommentar: Reaktion, Emote, Antworten, Loeschen.
// Liefert true, wenn der Klick hier erledigt wurde.
function dealKommentarKlick(seite, e, cm) {
  // Innerster Kommentar zaehlt (Antworten liegen im Eltern-Kommentar)
  const cid = cm.dataset.cid;
  const dealId = seite.id;
  const react = kind => api('/api/comments/react', {
    method: 'POST', body: JSON.stringify({ dealId, id: cid, kind }),
  }).then(() => refreshComments(seite)).catch(err => island(err.message));
  const emote = e.target.closest('.comment-emote-pick [data-e]');
  if (emote) { emote.closest('.comment-emote-pick').remove(); react(emote.dataset.e); return true; }
  const b = e.target.closest('[data-creact], [data-cemote], [data-creply], [data-cdel]');
  if (!b || b.closest('.comment') !== cm) return false;
  if (b.dataset.creact) { buzz(6); react(b.dataset.creact); return true; }
  if (b.dataset.cemote) {
    // Kleine Emote-Auswahl direkt unterm Kommentar
    const offen = cm.querySelector(':scope > .comment-emote-pick');
    seite.el.querySelectorAll('.comment-emote-pick').forEach(p => p.remove());
    if (offen) return true;
    const eg = emoteGruppen();
    const names = [...eg.katzen.slice(0, 6), ...eg.peepo.slice(0, 6)];
    if (!names.length) return true;
    const pick = document.createElement('div');
    pick.className = 'comment-emote-pick';
    pick.innerHTML = names.map(n => `<button type="button" data-e="${esc(n)}" aria-label="${esc(n)}">${emoteHtml(n)}</button>`).join('');
    b.closest('.comment-actions').after(pick);
    reinGleiten([pick], { versatz: 6 });
    return true;
  }
  if (b.dataset.creply) {
    if (!state.token) { island('Zum Antworten bitte anmelden'); return true; }
    // Antworten haengen immer am obersten Kommentar — eine Antwort auf eine
    // Antwort wuerde sonst nirgends angezeigt
    seite.antwortAuf = cm.parentElement?.closest('.comment[data-cid]')?.dataset.cid || cid;
    const hint = seite.el.querySelector('.dl-antwort');
    if (hint) { hint.hidden = false; hint.querySelector('span').textContent = `Antwort an ${anzeigeName(b.dataset.creply)}`; }
    const feld = seite.el.querySelector('.dl-feld');
    feld?.focus({ preventScroll: true });
    dealHinScrollen(seite, feld?.closest('.dl-schreiben'));
    return true;
  }
  if (b.dataset.cdel) {
    askConfirm('Diesen Kommentar löschen?', { okLabel: 'Löschen' }).then(ja => {
      if (!ja) return;
      api('/api/comments/delete', { method: 'POST', body: JSON.stringify({ dealId, id: cid }) })
        .then(() => refreshComments(seite)).catch(err => island(err.message));
    });
    return true;
  }
  return false;
}
function dealAntwortWeg(seite) {
  seite.antwortAuf = '';
  const hint = seite.el.querySelector('.dl-antwort');
  if (hint) hint.hidden = true;
}

async function sendComment(seite) {
  seite = seite || dealSeiten().pop();
  const el = seite?.el;
  const feld = el?.querySelector('.dl-feld');
  if (!feld) return;
  const knopf = el.querySelector('.dl-senden');
  const meldung = el.querySelector('.dl-meldung');
  const text = feld.value.trim();
  if (text.length < 2 || knopf.dataset.laeuft) return;
  knopf.dataset.laeuft = '1';
  knopf.disabled = true;
  try {
    await api('/api/comments', {
      method: 'POST',
      body: JSON.stringify({ dealId: seite.id, text, parent: seite.antwortAuf || '' }),
    });
    feld.value = '';
    feld.style.height = '';
    dealAntwortWeg(seite);
    meldung.textContent = '';
    const d = dealVonId(seite.id);
    if (d) d.comments = (d.comments || 0) + 1;
    buzz(10);
    await refreshComments(seite);
  } catch (e) {
    meldung.textContent = e.message;
    knopf.disabled = false;
  } finally {
    delete knopf.dataset.laeuft;
  }
}

// Nach dem Laden des Feeds (Start, Deal bearbeitet): offene Deal-Seiten auf
// den neuen Stand bringen und ein per ?deal= angefragter Deal geht auf
let dealNachLaden = '';
function dealStand(d) {
  return JSON.stringify([d.title, d.excerpt, d.price, d.origPrice, d.image, d.images, d.flags, d.endTs,
    d.newCustomer, d.stale, d.dealUrl, d.sourceUrl, d.merchant, d.channel]);
}
function dealSeitenAbgleichen() {
  for (const s of dealSeiten()) {
    const frisch = state.deals.find(x => x.id === s.id);
    if (!frisch || frisch === s.deal) continue;
    const anders = dealStand(frisch) !== dealStand(s.deal);
    s.deal = frisch;
    if (anders) { zeichneDealSeite(s); refreshComments(s); }
    else { dealSeitePreise(s); dealSeitenSterne(s.id); }
  }
  if (dealNachLaden) {
    const id = dealNachLaden;
    dealNachLaden = '';
    const d = dealVonId(id);
    if (d) oeffneDealSeite(d);
    else island('Dieser Deal ist nicht mehr im Feed');
  }
}

// ---------------- Profil: Anmelden, eigenes Profil, Seitenleiste ----------------
// Kisten, Inventar, Shop, Funken, Quests, Paints und Rahmen sind raus
// (Runde 117). Geblieben: Profilbild, Bio, Namensfarbe, Lieblingsmarken,
// Freunde, Einladungen; dazu privat der Rang (nach Wallet-Guthaben) und die
// Login-Serie.

let myProfile = null;
let profSeq = 0;
let peFarbe = '';        // Namensfarbe, wie sie auf "Profil bearbeiten" gerade gewaehlt ist

function refreshProfileTab() {
  // Oben links: "Anmelden"-Button (Gast) bzw. Avatar mit Initiale (angemeldet)
  const btn = $('#btn-profile-top');
  if (!state.token) schliesseTopMenu({ fokus: false });
  if (state.token && state.userName) {
    btn.className = 'iconbtn';
    renderKopfAvatar();
    btn.setAttribute('aria-label', 'Profil: ' + state.userName);
  } else {
    delete btn.dataset.ava;
    btn.className = 'btn-auth';
    btn.textContent = 'Anmelden';
    btn.setAttribute('aria-label', 'Anmelden / Registrieren');
  }
  $('#auth-card').classList.toggle('hidden', !!state.token);
  $('#pf-seite').classList.toggle('hidden', !state.token);
  $('#btn-logout').classList.toggle('hidden', !state.token);
  $('#danger-card').classList.toggle('hidden', !state.token);
  if (state.token) {
    renderMyName();
    ladeProfil();
  }
  renderWallet(); // Wallet-Sperre folgt dem Login-Status
  updateChatGate();
  lioKnopfZeigen(); // Shop-Knopf mit Lio-Stand in der Wallet: erst mit dem Profil dieses Kontos
}

// ---- Profilbilder: die sechs Kumulios (Runde 123) ----
// Eigene Uploads sind raus (es gibt noch keinen Bildfilter). Waehlbar sind
// sechs Posen von Kumulio; gespeichert wird nur die ID ('kumulio-1' …), ohne
// Wahl steht der Anfangsbuchstabe da. Alte hochgeladene Bilder (data-URLs)
// liefert der Server nicht mehr aus, und hier werden sie auch nie gezeichnet.
//
// Die Figuren "ploppen" aus dem Rahmen: unten schneidet der Kreis sie ab, oben
// und an den Seiten duerfen Kamm, Hand, Daumen, Schleife oder Liane
// herausragen. Technik (look-avatare.css): der Rahmen (.ava-k) hat die Groesse
// des bisherigen Avatars, ::before ist der runde Grund. Die Figur liegt in
// .ava-k-fig, einem Kasten, der links und rechts je einen halben Rahmen, oben
// 0,6 und unten 0,2 Rahmen uebersteht. Dessen Maske = Kreis ∪ Freiflaechen
// der Figur (SVG, hier aus der Tabelle erzeugt).
//
// Tabelle: je Figur die Bildgroesse (Pixel des zugeschnittenen Bilds) und zwei
// Stufen — "gross" fuer grosse Rahmen (Profil-Kopf, fremde Profile, Auswahl,
// ab etwa 56 px) mit der ganzen Pose, "klein" fuer alles darunter (Kopfzeile,
// Seitenleiste, Chat, Listen): naeher am Gesicht, nur der Kamm ragt heraus,
// damit nichts an Nachbarn stoesst.
//   w, x, y = Breite und linke obere Ecke der Figur in Rahmen-Einheiten
//             (Rahmen = 1 × 1, Kreis-Mitte 0,5 / 0,5)
//   frei    = Vielecke in Bild-Pixeln, die aus dem Kreis ragen duerfen
//             (alles andere schneidet der Kreis ab). Die Kanten laufen durch
//             Luecken der Figur oder an Umrissen entlang (Arm vor Bein, Schleife
//             vor Zacke), damit nie ein Koerperteil gerade abgeschnitten ist.
//   kachel  = nur in der Auswahl: Rahmen seitlich versetzt (Rahmen-Einheiten),
//             damit Posen, die weit nach einer Seite ragen, mittig wirken
const AVATAR_BASIS = '/brand/avatare/';
const KUMULIO_AVATARE = {
  // Liegt auf dem unteren Rand wie auf einer Fensterbank: die rechte Pfote
  // haengt ueber den Ring, der Schwanz verschwindet hinter dem Rahmen
  'kumulio-1': {
    name: 'Entspannt', bild: [745, 749],
    gross: { w: 1.2, x: -0.03, y: -0.14, frei: [[[-20, -20], [700, -20], [700, 250], [560, 380], [548, 560], [543, 600], [550, 620], [555, 640], [559, 660], [563, 680], [567, 700], [571, 712], [575, 780], [-20, 780]]] },
    klein: { w: 1.4, x: -0.12, y: -0.1, frei: [[[138, -20], [520, -20], [520, 150], [180, 150], [175, 119], [160, 111], [145, 106], [140, 100]]] },
  },
  // Klettert: die obere Hand greift ueber den linken Rand
  'kumulio-2': {
    name: 'Klettert', bild: [513, 757],
    gross: { w: 1.05, x: -0.105, y: -0.177, frei: [[[-20, -20], [533, -20], [533, 330], [-20, 330]]] },
    klein: { w: 1.34, x: -0.364, y: -0.17, frei: [[[200, -20], [533, -20], [533, 120], [200, 120]]] },
  },
  // Daumen hoch: Daumen und Arm ragen links heraus
  'kumulio-3': {
    name: 'Daumen hoch', bild: [735, 765], kachel: 0.07,
    gross: { w: 1.12, x: -0.15, y: -0.15, frei: [[[-20, -20], [755, -20], [755, 480], [300, 540], [140, 568], [100, 540], [55, 508], [-20, 508]]] },
    klein: { w: 1.33, x: -0.35, y: -0.12, frei: [[[300, -20], [755, -20], [755, 150], [300, 150]]] },
  },
  // Mit Schleife: liegt unten im Rahmen, Kamm und Schleife ragen heraus
  'kumulio-4': {
    name: 'Mit Schleife', bild: [934, 757], kachel: -0.04,
    gross: { w: 1.45, x: 0.05, y: -0.12, frei: [[[-20, -20], [680, -20], [680, 405], [612, 405], [540, 420], [-20, 420]]] },
    klein: { w: 1.58, x: 0.024, y: -0.12, frei: [[[250, -20], [680, -20], [680, 300], [655, 300], [640, 317], [627, 329], [616, 339], [604, 345], [590, 350], [576, 355], [540, 360], [400, 100], [250, 100]]] },
  },
  // An der Liane: die Liane laeuft ueber den Rahmen (ihre Enden laufen im
  // Bild weich aus), der Schwanz ist um sie gewickelt
  'kumulio-5': {
    name: 'An der Liane', bild: [953, 761], kachel: 0.1,
    gross: { w: 1.24, x: -0.33, y: -0.075, frei: [[[-20, -20], [800, -20], [700, 130], [500, 165], [420, 170], [360, 215], [345, 380], [150, 420], [-20, 300]]] },
    klein: { w: 1.6, x: -0.71, y: -0.185, frei: [] },
  },
  // Winkt: die Hand winkt ueber den Rand, die Fuesse sitzen auf dem Ring
  'kumulio-6': {
    name: 'Winkt', bild: [703, 731],
    gross: { w: 1.2, x: -0.24, y: -0.13, frei: [[[-20, -20], [723, -20], [723, 340], [-20, 340]], [[270, 600], [610, 600], [640, 760], [270, 760]]] },
    klein: { w: 1.71, x: -0.647, y: -0.18, frei: [[[372, -20], [700, -20], [700, 100], [580, 100], [575, 110], [400, 110], [385, 100], [372, 70]]] },
  },
};
// Nur bekannte IDs; alles andere (auch alte data-URLs aus einem Zwischenspeicher) = kein Bild
function avatarId(v) { return typeof v === 'string' && Object.hasOwn(KUMULIO_AVATARE, v) ? v : ''; }
// Die Maske einer Stufe als SVG: Kreis plus Freiflaechen, in Rahmen-Einheiten
// × 100 auf den Kasten von .ava-k-fig (x -50…150, y -60…120)
function kumulioMaske(e, p) {
  const k = v => Math.round(v * 1000) / 10;
  const bw = e.bild[0];
  const flaechen = (p.frei || []).map(f => `<polygon points='${f.map(([px, py]) => `${k(p.x + px / bw * p.w)},${k(p.y + py / bw * p.w)}`).join(' ')}'/>`).join('');
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='-50 -60 200 180' preserveAspectRatio='none'><circle cx='50' cy='50' r='50'/>${flaechen}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
// Lage und Maske je Figur und Stufe als CSS-Variablen, einmal beim Start
(function kumulioStil() {
  const regeln = [];
  for (const [id, e] of Object.entries(KUMULIO_AVATARE)) {
    for (const [stufe, sel] of [['klein', '.ava-k'], ['gross', '.ava-k.ava-gross']]) {
      const p = e[stufe];
      regeln.push(`${sel}[data-ava="${id}"]{--ava-w:${p.w};--ava-x:${p.x};--ava-y:${p.y};--ava-maske:${kumulioMaske(e, p)}}`);
    }
  }
  const st = document.createElement('style');
  st.id = 'ava-k-stil';
  st.textContent = regeln.join('\n');
  document.head.appendChild(st);
})();
// Die Figur selbst. sizes grob nach Stufe: klein bis ~44 px Rahmen, gross bis ~96 px
function kumulioFigurHtml(id, gross) {
  const b = AVATAR_BASIS + id;
  return `<span class="ava-k-fig" aria-hidden="true"><img src="${b}-256.webp" srcset="${b}-128.webp 128w, ${b}-256.webp 256w, ${b}-512.webp 512w" sizes="${gross ? 140 : 72}px" alt="" decoding="async" draggable="false"></span>`;
}

// Profilbilder anderer, wie sie der Server zuletzt mitgeschickt hat (Chat-Liste,
// Freunde, Anfragen, Kommentare …): so haben auch Stellen ohne eigene Abfrage
// (Anfragen, Verschenken, Deal schicken) das Bild. Nur gueltige IDs.
const avatarMerk = new Map();
function merkeAvatar(handle, v) {
  if (!handle || v === undefined) return;
  const a = avatarId(v);
  if (a) avatarMerk.set(handle, a); else avatarMerk.delete(handle);
}
function merkeAvatare(karte, handles = []) {
  if (!karte || typeof karte !== 'object') return;
  for (const h of handles) merkeAvatar(h, karte[h] || '');
}

// Profilbild (Kumulio) oder Anfangsbuchstabe auf der festen Farbe des Namens.
// Die Farbe haengt am @Name, der Buchstabe ist der des Anzeigenamens (so
// steht er daneben). bild = die ID vom Server; undefined = die gemerkte.
// gross: die ganze Pose (nur fuer grosse Rahmen, siehe KUMULIO_AVATARE).
function avatarHtml(name, bild, cls, id = '', { gross = false } = {}) {
  const n = name || '?';
  const idAttr = id ? ` id="${id}"` : '';
  const a = avatarId(bild === undefined ? avatarMerk.get(n) : bild);
  return a
    ? `<span class="${cls} ava-k${gross ? ' ava-gross' : ''}"${idAttr} data-ava="${a}">${kumulioFigurHtml(a, gross)}</span>`
    : `<span class="${cls}"${idAttr} style="background:${chatColor(n)}">${esc(anfangsBuchstabe(n))}</span>`;
}
function anfangsBuchstabe(handle) { return ([...anzeigeName(handle || '?')][0] || '?').toUpperCase(); }

// Anzeigenamen aus dem eigenen Profil (auch aus der Antwort von /api/friend):
// der eigene und die der Freunde und Anfragenden
function profilNamenMerken(p) {
  if (!p) return false;
  const eigen = 'anzeigename' in p && merkeAnzeigename(state.userName, p.anzeigename || '');
  const andere = merkeNamen(p.namen, [...(p.friends || []), ...(p.friendRequests || [])]);
  // Profilbilder der Freunde und Anfragenden (nur IDs, darum immer dabei)
  merkeAvatare(p.avatare, [...(p.friends || []), ...(p.friendRequests || [])]);
  if ('avatar' in p) merkeAvatar(state.userName, p.avatar);
  return eigen || andere;
}

// Eigenes Profil vom Server holen und alles zeichnen, was daran haengt
async function ladeProfil() {
  if (!state.token) return;
  const pseq = ++profSeq;
  let frisch;
  try { frisch = await api('/api/profile'); } catch { return; }
  if (pseq !== profSeq) return; // veraltet: eine lokale Änderung kam dazwischen
  myProfile = frisch;
  profilNamenMerken(frisch);
  // Namensfelder frisch halten — nicht, waehrend jemand darin tippt
  if (state.activeView !== 'editprofile') renderNamensFelder();
  renderProfil();
  // Kopfzeilen-Knopf: Kumulio oder der Anfangsbuchstabe des Anzeigenamens (jetzt bekannt)
  renderKopfAvatar();
  updateReqDot();
  lioNachProfil();
}

// Oben links: das eigene Profilbild (Kumulio) oder der Anfangsbuchstabe.
// Nur neu zeichnen, wenn sich etwas geaendert hat (sonst laedt das Bild bei
// jedem Profil-Abruf neu); der Geschenk-Punkt haengt danach wieder dran.
function renderKopfAvatar() {
  const btn = $('#btn-profile-top');
  if (!btn || !state.token || !state.userName) return;
  const a = avatarId(myProfile?.avatar);
  const schluessel = (a || '-') + '|' + anfangsBuchstabe(state.userName) + '|' + state.userName;
  if (btn.dataset.ava !== schluessel || !btn.querySelector('.avatar-mini')) {
    btn.innerHTML = avatarHtml(state.userName, a, 'avatar-mini');
    btn.dataset.ava = schluessel;
  }
  updateGiftBadges(); // innerHTML-Tausch wirft den Geschenk-Punkt sonst raus
}

// Der eigene Name in der eigenen Namensfarbe (Profil-Kopf)
function renderMyName() {
  const me = $('#me-name');
  if (!me || !state.userName) return;
  me.textContent = myProfile?.anzeigename || state.userName;   // '' = der @Name
  const ns = nameStyleOf(state.userName, myProfile?.nameColor);
  me.className = 'pf-name' + ns.cls;
  me.setAttribute('style', ns.style);
}

// Lieblingsmarke als kleine Kachel: Logo, wo wir es kennen, sonst nur der Name
function favChipHtml(v) {
  return BRAND_DOMAINS[String(v || '').toLowerCase()]
    ? `<span class="pf-marke">${brandChipHtml(v)}<span>${esc(v)}</span></span>`
    : `<span class="pf-marke ohne-logo"><span>${esc(v)}</span></span>`;
}

// Profil-Kopf: nur die Laeden und Marken als Logos (ohne Lieblingsessen),
// doppelte einmal. Die ganze Liste mit Namen steht in der Karte darunter.
const KOPF_FAVS = ['discounter', 'supermarkt', 'onlineshop', 'mode'];
function kopfMarkenHtml(favs) {
  const gesehen = new Set();
  const marken = KOPF_FAVS.map(k => String(favs?.[k] || '').trim()).filter(n => {
    const key = n.toLowerCase();
    if (!n || gesehen.has(key)) return false;
    gesehen.add(key);
    return true;
  });
  return { marken, html: marken.map(n => brandChipHtml(n)).join('') };
}
// "Kunde seit September 2026" aus dem Registrierungszeitpunkt; ungueltig = leer
function kundeSeitText(ts) {
  const d = new Date(Number(ts) || NaN);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }) : '';
}

// Profil-Seite: Kopf, Rang, Login-Serie, Lieblingsmarken, Freunde
function renderProfil() {
  if (!state.token || !myProfile) return;
  $('#me-avatar').innerHTML = avatarHtml(state.userName, myProfile.avatar || '', 'avatar-big', '', { gross: true });
  renderMyName();
  $('#me-handle').textContent = '@' + (state.userName || '');
  const bio = $('#me-bio');
  bio.textContent = myProfile.bio || 'Noch keine Bio. Erzähl kurz, wer du bist.';
  bio.classList.toggle('leer', !myProfile.bio);
  // Rechts im Kopf: Lieblingsmarken als Logos unter dem @Namen, darunter
  // klein, seit wann man dabei ist (unten rechts ist seit Runde 126 Platz fuer
  // den Kopf des Rang-Maskottchens). Fehlt etwas, bleibt es weg.
  const km = kopfMarkenHtml(myProfile.favs);
  const kmEl = $('#me-kopf-marken');
  kmEl.innerHTML = km.html;
  kmEl.classList.toggle('hidden', !km.marken.length);
  kmEl.setAttribute('aria-label', 'Lieblingsmarken: ' + km.marken.join(', '));
  const seit = kundeSeitText(myProfile.seit);
  const seitEl = $('#me-seit');
  seitEl.innerHTML = seit ? `Kunde seit <b>${esc(seit)}</b>` : '';
  seitEl.classList.toggle('hidden', !seit);
  renderRangKarte();
  renderSerie();
  const mf = myProfile.favs || {};
  const marken = Object.keys(FAV_OPTIONS).map(k => mf[k]).filter(Boolean);
  $('#me-favs').innerHTML = marken.length
    ? marken.map(favChipHtml).join('')
    : `<p class="pf-leer">Noch keine gewählt. <button class="link-knopf" type="button" data-pf-bearbeiten>Jetzt auswählen</button></p>`;
  $('#me-favs').querySelector('[data-pf-bearbeiten]')?.addEventListener('click', oeffneProfilBearbeiten);
  const freunde = (myProfile.friends || []).length;
  const eingeladen = myProfile.eingeladen || 0;
  $('#pf-gruppe').innerHTML = `
    <button class="pf-zeile" type="button" data-pf-ziel="friends">
      ${icon('user', 'icon')}
      <span class="pf-zeile-text"><b>Freunde</b><small>${freunde ? `${freunde} ${freunde === 1 ? 'Freund' : 'Freunde'}` : 'Noch keine'}</small></span>
    </button>
    <button class="pf-zeile" type="button" data-pf-ziel="invite">
      ${icon('share', 'icon')}
      <span class="pf-zeile-text"><b>Freunde einladen</b><small>${eingeladen ? `${eingeladen} eingeladen` : 'Link teilen'}</small></span>
    </button>`;
  $('#pf-gruppe').querySelectorAll('[data-pf-ziel]').forEach(b =>
    b.onclick = () => switchView(b.dataset.pfZiel, 'enter-drop'));
}

// Guthaben, nach dem sich der Rang richtet: alle Restguthaben (wie der
// Wallet-Kopf), Rabattcodes und Pfandbons zaehlen nicht
function rangGuthaben() {
  const aktiv = state.wallet.vouchers.filter(v => !ohneGuthaben(v) && (v.balance == null || v.balance > 0));
  return Math.round(aktiv.reduce((s, v) => s + (v.balance || 0), 0) * 100) / 100;
}
const rangAnteil = (r, total) => r.next ? Math.max(0, Math.min(1, (total - r.min) / (r.next.min - r.min))) : 1;
const rangAbstand = (r, total) => r.next ? `Noch ${euroFmt(r.next.min - total)} bis ${esc(r.next.name)}` : 'Höchste Stufe erreicht';

// Rang-Fenster: Karte in der Rang-Farbe wie das Fenster "Deine Wallet". Rechts
// ragt das Maskottchen des Rangs oben heraus — dasselbe Bild und dieselbe Lage
// wie in der Wallet (WALLET_MASKOTTCHEN, Geometrie in look-profil.css .rf-*).
// Steht im Profil (mehr: Pfeil, die ganze Karte ist der Knopf) und oben auf der
// Rang-Seite. zu = gesperrte Wallet: die Figur ja, aber weder Rang noch Balken
// noch Betrag — aus Stufe und "Noch X €" liesse sich das Guthaben sonst auf den
// Cent zurueckrechnen. Dann steht das universelle Maskottchen da.
// eigen = der eigene Rang (nur auf der Rang-Seite): ist r eine andere Stufe,
// ist die Karte eine Vorschau — Farbe, Maskottchen und Name dieser Stufe,
// oben "Vorschau" statt "Dein Rang", statt "Stufe N von 7" ihre Spanne. Der
// Balken zeigt, wie weit das jetzige Guthaben schon dorthin reicht, darunter
// der ehrliche Abstand (erreichte Stufen: voll, "Schon erreicht"). Kurz
// ("Noch 965,01 €"), damit er auch bei 360 px in einer Zeile bleibt — sonst
// wuerde die Karte beim Blaettern hoeher und die Liste darunter springen.
// Goldene Funken (.wk-f aus look.css) in einer Huelle mit eigener Lage
const funkenHtml = (cls, anzahl = 3) => `<span class="${cls}" aria-hidden="true">` + [1, 2, 3].slice(0, anzahl).map(n =>
  `<svg class="wk-f wk-f${n}" viewBox="-1.2 -1.2 2.4 2.4"><path d="M0-1Q.13-.13 1 0Q.13 .13 0 1Q-.13 .13-1 0Q-.13-.13 0-1Z"/></svg>`).join('') + '</span>';
const RF_FUNKEN = funkenHtml('rf-funken');
function rangFensterHtml({ r = null, total = 0, zu = false, mehr = false, eigen = null } = {}) {
  const m = (!zu && WALLET_MASKOTTCHEN[r.slug]) || WALLET_MASKOTTCHEN.standard;
  const vorschau = !zu && !!eigen && eigen.tier !== r.tier;
  const figur = `
    <span class="rf-licht" aria-hidden="true"></span>
    <span class="rf-rahmen" aria-hidden="true"><img class="rf-sprite" src="${m.basis}-480.webp"
      srcset="${m.basis}-480.webp 480w, ${m.basis}-960.webp 960w" sizes="312px" width="295" height="298"
      alt="" decoding="async" draggable="false">${RF_FUNKEN}</span>`;
  const titel = `<span class="rf-titel">${vorschau ? 'Vorschau' : 'Dein Rang'}${mehr ? icon('chevron', 'icon') : ''}</span>`;
  const stil = `--licht-x:${m.licht[0]}; --licht-y:${m.licht[1]}`;
  if (zu) return `
    <span class="rf zu" data-stufe="0" style="${stil}">${figur}
      <span class="rf-text">${titel}
        <b class="rf-name">Gesperrt</b>
        <span class="rf-abstand">Zum Ansehen die Wallet entsperren</span>
        <span class="rf-knopf">${icon('lock', 'icon')}Entsperren</span>
      </span>
    </span>`;
  if (vorschau) {
    const erreicht = r.tier < eigen.tier;
    const weg = erreicht ? 1 : Math.max(0, Math.min(1, total / r.min));
    return `
    <span class="rf vorschau" data-stufe="${r.tier}" style="${stil}">${figur}
      <span class="rf-text">${titel}
        <b class="rf-name">${esc(r.name)}</b>
        <span class="rf-stufe">${rangSpanne(r)}</span>
        <span class="rf-balken" role="img" aria-label="${erreicht ? 'Schon erreicht' : `${Math.round(weg * 100)} Prozent bis ${esc(r.name)}`}"><span style="transform:translateX(${((weg - 1) * 100).toFixed(1)}%)"></span></span>
        <span class="rf-abstand">${erreicht ? 'Schon erreicht' : `Noch ${euroFmt(r.min - total)}`}</span>
      </span>
    </span>`;
  }
  const anteil = rangAnteil(r, total);
  return `
    <span class="rf" data-stufe="${r.tier}" style="${stil}">${figur}
      <span class="rf-text">${titel}
        <b class="rf-name">${esc(r.name)}</b>
        <span class="rf-stufe">Stufe ${r.tier} von ${RANKS.length}</span>
        <span class="rf-balken" role="img" aria-label="${Math.round(anteil * 100)} Prozent bis zur nächsten Stufe"><span style="transform:translateX(${((anteil - 1) * 100).toFixed(1)}%)"></span></span>
        <span class="rf-abstand">${rangAbstand(r, total)}</span>
      </span>
    </span>`;
}

// Rang-Karte im Profil: nur hier und in der Wallet, nie bei anderen. Seit
// Runde 126 der untere Teil der Profil-Karte (#pf-rang liegt in #pf-kopf):
// zwei gleichfarbige Karten mit je einem Kumulio untereinander wirkten doppelt
function renderRangKarte() {
  aktualisiereTmKopf(); // der Kopf der Seitenleiste traegt den Rang auch
  const el = $('#pf-rang');
  if (!el) return;
  const zu = walletGesperrt();
  const total = zu ? 0 : rangGuthaben();
  const r = zu ? null : rankFor(total);
  // Der Profil-Kopf traegt dieselbe Rang-Farbe; gesperrt wie die gesperrte
  // Rang-Karte die aktuelle App-Farbe (Stufe 0), ohne Rang-Name und Stufe
  $('#pf-kopf')?.setAttribute('data-stufe', zu ? 0 : r.tier);
  // Nur bei Aenderung neu zeichnen (laeuft auch bei jedem Sperren/Entsperren)
  const stand = zu ? 'zu' : `${r.tier}|${total}`;
  if (el.dataset.stand === stand) return;
  el.dataset.stand = stand;
  el.innerHTML = rangFensterHtml({ r, total, zu, mehr: true });
  el.classList.toggle('gesperrt', zu);
  el.setAttribute('aria-label', zu ? 'Dein Rang: Wallet gesperrt. Zum Entsperren tippen' : `Dein Rang: ${r.name}, Stufe ${r.tier} von ${RANKS.length}. Alle Ränge ansehen`);
}
$('#pf-rang').addEventListener('click', () => zeigeRang());

// Login-Serie: Tage in Folge, dazu die letzten sieben Tage als Balken
const WOCHENTAGE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
function renderSerie() {
  const el = $('#pf-serie');
  const s = myProfile?.loginStreak;
  // Der Abruf des Profils zaehlt heute schon mit, 0 heisst: noch nichts zu zeigen
  const tage = s?.tage || 0;
  if (!el) return;
  el.classList.toggle('hidden', !tage);
  if (!tage) return;
  const heute = new Date();
  const zellen = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate() - (6 - i));
    return `<span class="pf-tag${6 - i < tage ? ' an' : ''}${i === 6 ? ' heute' : ''}"><i></i><small>${WOCHENTAGE[d.getDay()]}</small></span>`;
  }).join('');
  const unter = (s.rekord || 0) > tage ? `Dein Rekord: ${s.rekord} Tage`
    : tage > 1 ? 'Deine längste Serie bisher' : 'Schau morgen wieder rein';
  el.innerHTML = `
    <div class="pf-serie-kopf">
      <span class="pf-serie-flamme">${icon('flame', 'icon')}</span>
      <span class="pf-serie-text"><b>${tage} ${tage === 1 ? 'Tag' : 'Tage'} in Folge</b><small>${unter}</small></span>
    </div>
    <div class="pf-woche" aria-hidden="true">${zellen}</div>
    <button class="pf-lio" type="button" data-pf-lio>
      ${lioSternImg(30)}
      <span class="pf-lio-text"><b data-lio-stand>${lioText(lioAnzeige())}</b><small>Im Gutschein-Shop einlösen</small></span>
      ${icon('chevron', 'icon icon-sm')}
    </button>`;
  el.querySelector('[data-pf-lio]').onclick = () => oeffneLioShop();
}

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

// Namensfarbe: zehn Vorschlaege, eine eigene Farbe (Farbwaehler) oder
// automatisch (die feste Chat-Farbe des Namens). Die Vorschau zeigt, wie der
// Name wirklich aussieht — auch mit der Lesbarkeits-Anpassung.
const NAMENSFARBEN = ['#e5484d', '#f76b15', '#d6a100', '#30a46c', '#0e95a3', '#2d6bdb', '#6b4cd9', '#d6409f', '#8d6e63', '#5b6b7c'];
function renderFarbwahl() {
  const host = $('#pe-farben');
  if (!host) return;
  const f = (peFarbe || '').toLowerCase();
  const eigen = !!f && !NAMENSFARBEN.includes(f);
  const auto = chatColor(state.userName || '?');
  host.innerHTML = `
    <button type="button" class="pe-farbe pe-auto${f ? '' : ' an'}" role="radio" aria-checked="${!f}" data-farbe="" style="--f:${auto}" aria-label="Automatisch">A</button>
    ${NAMENSFARBEN.map(c => `<button type="button" class="pe-farbe${f === c ? ' an' : ''}" role="radio" aria-checked="${f === c}" data-farbe="${c}" style="--f:${c}" aria-label="Farbe ${c}">${f === c ? icon('check', 'icon') : ''}</button>`).join('')}
    <label class="pe-farbe pe-eigen${eigen ? ' an' : ''}" style="--f:${eigen ? f : 'transparent'}" title="Eigene Farbe">
      <input type="color" id="pe-farbe-eigen" value="${eigen ? f : '#2d6bdb'}" aria-label="Eigene Farbe wählen">
      ${icon(eigen ? 'check' : 'plus', 'icon').replace('<svg ', `<svg data-art="${eigen ? 'check' : 'plus'}" `)}
    </label>`;
  host.querySelectorAll('[data-farbe]').forEach(b => b.onclick = () => { peFarbe = b.dataset.farbe; farbwahlZustand(); buzz(6); });
  const eingabe = $('#pe-farbe-eigen');
  // Der Farbwaehler des Handys haengt an genau diesem <input>. Wird es
  // ersetzt, klappt der Waehler sofort zu — und das iPhone meldet "change"
  // schon beim Antippen einer Farbe (Meldung: "man fliegt immer raus").
  // Darum hier nie neu zeichnen, nur Zustand und Vorschau nachziehen.
  const nimm = () => { peFarbe = eingabe.value.toLowerCase(); farbwahlZustand(); };
  eingabe.addEventListener('input', nimm);
  eingabe.addEventListener('change', nimm);
  farbwahlZustand();
}
// Markierung, Kreis der eigenen Farbe, Satz darunter und Vorschau — ohne das
// Farbfeld anzufassen
function farbwahlZustand() {
  const host = $('#pe-farben');
  if (!host) return;
  const f = (peFarbe || '').toLowerCase();
  const eigen = !!f && !NAMENSFARBEN.includes(f);
  host.querySelectorAll('[data-farbe]').forEach(b => {
    const an = (b.dataset.farbe || '') === f;
    b.classList.toggle('an', an);
    b.setAttribute('aria-checked', String(an));
    if (b.dataset.farbe) b.innerHTML = an ? icon('check', 'icon') : '';
  });
  const lab = host.querySelector('.pe-eigen');
  if (lab) {
    lab.classList.toggle('an', eigen);
    lab.style.setProperty('--f', eigen ? f : 'transparent');
    const alt = lab.querySelector('svg.icon');
    const soll = eigen ? 'check' : 'plus';
    if (alt && alt.dataset.art !== soll) {
      alt.insertAdjacentHTML('afterend', icon(soll, 'icon'));
      alt.nextElementSibling.dataset.art = soll;
      alt.remove();
    }
  }
  // Unter den Farben steht in Worten, was gewaehlt ist
  $('#pe-farbe-text').textContent = !f ? 'Automatisch: die feste Farbe deines Namens.'
    : eigen ? `Eigene Farbe ${f.toUpperCase()}. Zu helle oder zu dunkle Farben gleichen wir an, damit dein Name lesbar bleibt.`
    : 'Zu helle oder zu dunkle Farben gleichen wir an, damit dein Name lesbar bleibt.';
  zeigeFarbVorschau();
}
function zeigeFarbVorschau() {
  const el = $('#pe-farbe-name');
  if (!el) return;
  // Vorschau mit dem Anzeigenamen, wie er gerade im Feld steht
  el.textContent = $('#g-anzeigename')?.value.replace(/\s+/g, ' ').trim() || state.userName || 'Dein Name';
  const ns = nameStyleOf(state.userName, peFarbe);
  el.className = ns.cls.trim();
  el.setAttribute('style', ns.style);
}

// "Profil bearbeiten": eigene Seite. Beim Oeffnen stehen alle Felder auf dem
// gespeicherten Stand, nach dem Speichern geht es automatisch zurueck.
function oeffneProfilBearbeiten() {
  if (!state.token) return;
  renderNamensFelder();
  $('#g-bio').value = myProfile?.bio || '';
  $('#g-public').checked = myProfile?.publicProfile !== false;
  $('#g-bio-msg').textContent = '';
  for (const k of Object.keys(favPick)) delete favPick[k];
  peFarbe = myProfile?.nameColor || '';
  peAvatar = avatarId(myProfile?.avatar);
  renderFavPickers();
  renderFarbwahl();
  renderAvatarWahl();
  switchView('editprofile', 'enter-drop');
}
$('#btn-edit-profile').addEventListener('click', oeffneProfilBearbeiten);

$('#g-bio-save').addEventListener('click', async () => {
  const m = $('#g-bio-msg');
  m.className = 'form-msg'; m.textContent = '';
  // Der Anzeigename geht nur mit, wenn er sich aendert (und aenderbar ist).
  // Vorher fragen: danach ist er 7 Tage fest.
  const feld = $('#g-anzeigename');
  const bisher = myProfile?.anzeigename || '';
  const name = !myProfile || feld.disabled ? bisher : feld.value.replace(/\s+/g, ' ').trim();
  const nameNeu = name !== bisher;
  if (nameNeu) {
    const frage = name
      ? `Anzeigename „${esc(name)}“ speichern? Ändern geht danach erst wieder in 7 Tagen.`
      : `Anzeigenamen entfernen? Dann steht dort dein @Name, und ändern geht erst wieder in 7 Tagen.`;
    if (!await askConfirm(frage, { okLabel: 'Speichern' })) return;
  }
  // Profilbild nur, wenn anders gewaehlt (ein altes Upload-Bild bleibt sonst
  // unangetastet im Konto liegen)
  const bildNeu = peAvatar !== avatarId(myProfile?.avatar);
  setBtnLoading($('#g-bio-save'), true);
  try {
    const r = await api('/api/profile', {
      method: 'POST',
      body: JSON.stringify({
        bio: $('#g-bio').value, publicProfile: $('#g-public').checked,
        favs: { ...favPick }, nameColor: peFarbe || '',
        ...(nameNeu ? { anzeigename: name } : {}),
        ...(bildNeu ? { avatar: peAvatar } : {}),
      }),
    });
    profSeq++; // ein laufender Ladevorgang darf den neuen Stand nicht zurueckrollen
    myProfile = { ...myProfile, ...r };
    profilNamenMerken(r);
    $('#g-bio').value = r.bio; // Server-Fassung (ggf. zensiert) zurückspiegeln
    renderNamensFelder();
    island('Profil gespeichert');
    renderProfil();
    renderKopfAvatar();
    switchView('profile', 'enter-drop'); // direkt zurück
  } catch (e) {
    m.className = 'form-msg error'; m.textContent = e.message;
    // Ging es um den Anzeigenamen (das Einzige, was der Server hier ablehnt),
    // steht es auch direkt unter dem Feld
    if (nameNeu) namensHinweis(e.message);
  }
  finally { setBtnLoading($('#g-bio-save'), false); }
});

// Name: der Anzeigename ist alle 7 Tage aenderbar (das erste Mal sofort),
// der @Name steht nur zum Ansehen da — er ist ab der Registrierung fest und
// laesst sich nicht aendern. Wann der Anzeigename wieder geht, sagt der Server
// (anzeigenameAb, 0 = jetzt).
function renderNamensFelder() {
  const feld = $('#g-anzeigename');
  if (!feld) return;
  feld.value = myProfile?.anzeigename || '';
  feld.placeholder = state.userName || '';
  feld.disabled = !!namensHinweis();
  $('#g-handle-fest').value = '@' + (state.userName || '');
}
// Unter dem Feld: wann es wieder geht, oder die Ablehnung vom Server (rot,
// das Feld dazu mit rotem Rand, bis man darin tippt). Liefert die Resttage.
function namensHinweis(fehler = '') {
  const hinweis = $('#g-anzeigename-hinweis');
  const ab = Number(myProfile?.anzeigenameAb) || 0;
  const tage = ab > Date.now() ? Math.ceil((ab - Date.now()) / 864e5) : 0;
  $('#g-anzeigename')?.classList.toggle('err', !!fehler);
  if (hinweis) {
    hinweis.classList.toggle('fehler', !!fehler);
    hinweis.textContent = fehler || (tage ? `Wieder änderbar in ${tage} ${tage === 1 ? 'Tag' : 'Tagen'}` : 'Alle 7 Tage änderbar');
  }
  return tage;
}
$('#g-anzeigename').addEventListener('input', e => {
  // Neu getippt: die Ablehnung unter dem Feld und unter "Speichern" ist erledigt
  if (e.target.classList.contains('err')) { namensHinweis(); $('#g-bio-msg').textContent = ''; }
  zeigeFarbVorschau();
});

// Profilbild waehlen: sechs Kumulios in Kacheln (die ganze Pose), darunter
// "Kein Bild" mit dem Anfangsbuchstaben. Eigene Bilder hochladen gibt es
// vorerst nicht (noch kein Bildfilter). Gespeichert wird mit "Speichern".
let peAvatar = '';
function renderAvatarWahl() {
  const host = $('#pe-avatare');
  if (!host) return;
  const n = state.userName || '?';
  const kachel = (id, inhalt, cls, label) => `
    <button type="button" class="pe-ava-wahl${cls}${peAvatar === id ? ' an' : ''}" role="radio" aria-checked="${peAvatar === id}" data-ava-wahl="${id}" aria-label="${esc(label)}">
      ${inhalt}<span class="pe-ava-haken" aria-hidden="true">${icon('check', 'icon')}</span>
    </button>`;
  host.innerHTML = Object.entries(KUMULIO_AVATARE).map(([id, e], i) =>
    kachel(id, avatarHtml(n, id, 'avatar-big pe-ava', '', { gross: true }).replace('<span ', `<span style="--kachel:${e.kachel || 0}" `), '', `Kumulio ${i + 1}: ${e.name}`)).join('')
    + kachel('', `${avatarHtml(n, '', 'avatar-big')}<span class="pe-ava-ohne-txt"><b>Kein Bild</b><span>Nur dein Anfangsbuchstabe</span></span>`, ' pe-ava-ohne', 'Kein Bild');
  host.querySelectorAll('[data-ava-wahl]').forEach(b => b.onclick = () => {
    if (peAvatar === b.dataset.avaWahl) return;
    peAvatar = b.dataset.avaWahl;
    // Nur Zustand umschalten (kein Neuzeichnen: die Bilder bleiben stehen)
    host.querySelectorAll('[data-ava-wahl]').forEach(x => {
      const an = x === b;
      x.classList.toggle('an', an);
      x.setAttribute('aria-checked', String(an));
      x.classList.remove('pop');
    });
    if (weich()) { void b.offsetWidth; b.classList.add('pop'); }
    buzz(6);
  });
}

// Oben links: Gäste landen direkt beim Anmelden, Angemeldete bekommen die
// Seitenleiste, die von links hereingleitet
$('#btn-profile-top').addEventListener('click', () => {
  if (!state.token) { if (state.activeView !== 'profile') switchView('profile'); return; }
  toggleTopMenu();
});
let tmZuUhr = 0;
function topMenuOffen() { return !!$('#top-menu')?.classList.contains('open'); }
function toggleTopMenu() { if (topMenuOffen()) schliesseTopMenu(); else oeffneTopMenu(); }
function schliesseTopMenu({ fokus = true } = {}) {
  const menu = $('#top-menu'), bd = $('#top-menu-backdrop');
  if (!menu || !menu.classList.contains('open')) return;
  menu.classList.remove('open', 'dragging');
  menu.style.transform = '';
  bd.classList.remove('show', 'dragging');
  bd.style.opacity = '';
  $('#btn-profile-top')?.setAttribute('aria-expanded', 'false');
  for (const sel of ['main', '.topbar', '#tabbar', '#wallet-mini']) { const n = $(sel); if (n) n.inert = false; }
  aktualisiereSperre(); // setzt die Sperr-Traegheit wieder, falls die Wallet gesperrt ist
  clearTimeout(tmZuUhr);
  tmZuUhr = setTimeout(() => { menu.inert = true; bd.classList.add('hidden'); }, sperrRuhig() ? 0 : 440);
  if (fokus) $('#btn-profile-top')?.focus({ preventScroll: true });
}
// Kopf der Seitenleiste: das eigene Profil als Karte in der Rang-Farbe, im
// Stil des Rang-Fensters (.rf) — links Bild, Name, Rang und Stufe, rechts
// schaut das Maskottchen des Rangs oben aus der Karte. Gesperrte Wallet: die
// App-Farbe (Stufe 0) und das universelle Maskottchen, weder Rang noch Stufe
// (aus der Stufe liesse sich das Guthaben eingrenzen, siehe rangFensterHtml).
function tmKopfHtml() {
  const zu = walletGesperrt();
  const r = zu ? null : rankFor(rangGuthaben());
  const m = (!zu && WALLET_MASKOTTCHEN[r.slug]) || WALLET_MASKOTTCHEN.standard;
  const name = state.userName || '?';
  // Der Name steht weiss auf dem Verlauf (wie im Profil-Kopf): die freie
  // Namensfarbe waere darauf oft nicht lesbar. Die Admin-Krone sitzt als
  // Plakette am Bild — neben dem Namen fehlte ihr in der schmalen Leiste der Platz
  return `
    <button class="tm-head tm-rang${zu ? ' zu' : ''}" type="button" data-stufe="${zu ? 0 : r.tier}"
      style="--licht-x:${m.licht[0]}; --licht-y:${m.licht[1]}"
      aria-label="${zu ? 'Profil ansehen. Wallet gesperrt' : `Profil ansehen. Rang ${esc(r.name)}, Stufe ${r.tier} von ${RANKS.length}`}">
      <span class="tm-rang-licht" aria-hidden="true"></span>
      <span class="tm-rang-rahmen" aria-hidden="true"><img class="tm-rang-sprite" src="${m.basis}-480.webp"
        srcset="${m.basis}-480.webp 480w, ${m.basis}-960.webp 960w" sizes="230px" width="230" height="232"
        alt="" decoding="async" draggable="false">${funkenHtml('tm-rang-funken')}</span>
      <span class="tm-rang-text">
        <span class="tm-rang-ich">
          <span class="tm-rang-ava">${avatarHtml(name, myProfile?.avatar || '', 'avatar-big')}${state.role === 'admin' ? `<span class="tm-rang-krone">${icon('crown', 'icon')}</span>` : ''}</span>
          <span class="tm-rang-wer">
            <span class="tm-name">${esc(myProfile?.anzeigename || anzeigeName(name))}</span>
            <span class="tm-rang-profil">Profil ansehen${icon('chevron', 'icon')}</span>
          </span>
        </span>
        <b class="tm-rang-name">${zu ? 'Gesperrt' : esc(r.name)}</b>
        <span class="tm-rang-stufe">${zu ? `${icon('lock', 'icon')}Rang verborgen` : `Stufe ${r.tier} von ${RANKS.length}`}</span>
      </span>
    </button>`;
}
// Sperrt oder entsperrt sich die Wallet, waehrend die Leiste offen ist (zurueck
// aus dem Hintergrund), zieht der Kopf mit — ein Rang bleibt nie stehen
function aktualisiereTmKopf() {
  const alt = $('#tm-scroll > .tm-head');
  if (!alt || !topMenuOffen()) return;
  const zu = walletGesperrt();
  if (alt.classList.contains('zu') === zu && (zu || alt.dataset.stufe === String(rankFor(rangGuthaben()).tier))) return;
  const vorlage = document.createElement('template');
  vorlage.innerHTML = tmKopfHtml().trim();
  const neu = vorlage.content.firstElementChild;
  neu.style.setProperty('--i', 0);
  neu.style.animation = 'none'; // nicht noch einmal hereingleiten
  neu.onclick = alt.onclick;
  alt.replaceWith(neu);
}
function oeffneTopMenu() {
  const menu = $('#top-menu');
  const bd = $('#top-menu-backdrop');
  const host = $('#tm-scroll');
  clearTimeout(tmZuUhr);
  bd.classList.remove('hidden');
  const reqs = myProfile?.friendRequests || [];
  // Oben das Profil als klarer erster Eintrag, darunter Anfragen, Freunde,
  // Einladen/Geschenke/Favoriten und die Einstellungen
  host.innerHTML = `
    ${tmKopfHtml()}
    <div class="tm-lio" id="tm-lio">${tmLioHtml()}</div>
    ${reqs.length ? `<div class="tm-section">Freundschaftsanfragen</div>
    ${reqs.map(u => `<div class="tm-req">
      ${avatarHtml(u, undefined, 'avatar-mini')}
      ${nameMitHandleHtml(u, 'tm-req-name', { at: false })}
      <button class="btn btn-small" data-freq-ok="${esc(u)}">Annehmen</button>
      <button class="btn btn-small btn-ghost" data-freq-no="${esc(u)}">Ablehnen</button>
    </div>`).join('')}` : ''}
    <div class="tm-section tm-section-row">Freunde <button class="tm-mini-link" id="tm-all-friends">alle ansehen</button></div>
    <div id="tm-friends"><div class="tm-sub" style="padding:4px 0">Lade …</div></div>
    <button class="tm-item" id="tm-invite">${icon('share', 'icon icon-sm')} Freunde einladen${myProfile?.lioFreunde?.proFreund ? `<span class="tm-lio-pille" aria-label="${myProfile.lioFreunde.proFreund} Lios pro Freund">+${myProfile.lioFreunde.proFreund}${lioSternImg(14)}</span>` : ''}</button>
    <button class="tm-item" id="tm-gifts">${icon('gift', 'icon icon-sm')} Geschenke ${pendingGifts.length ? `<span class="dm-unread-pill">${pendingGifts.length}</span>` : ''}</button>
    <button class="tm-item" id="tm-favs">${icon('star', 'icon icon-sm')} Favoriten</button>
    <button class="tm-item" id="tm-settings">${icon('sliders', 'icon icon-sm')} Einstellungen</button>`;
  // Eintraege gleiten gestaffelt mit herein
  [...host.children].forEach((el, i) => el.style.setProperty('--i', Math.min(i, 14)));
  menu.inert = false;
  requestAnimationFrame(() => { bd.classList.add('show'); menu.classList.add('open'); });
  $('#btn-profile-top').setAttribute('aria-expanded', 'true');
  // Dahinter ist nichts erreichbar, solange die Leiste offen ist
  for (const sel of ['main', '.topbar', '#tabbar', '#wallet-mini']) { const n = $(sel); if (n) n.inert = true; }
  host.scrollTop = 0;
  setTimeout(() => menu.focus({ preventScroll: true }), 80); // die Leiste, kein Eintrag (sonst Fokus-Ring)
  const done = () => schliesseTopMenu({ fokus: false });
  // Der Profil-Eintrag oben führt zum Profil
  menu.querySelector('.tm-head').onclick = () => { done(); switchView('profile'); };
  $('#tm-invite').onclick = () => { done(); switchView('invite', 'enter-drop'); };
  renderTmLio(); // der Lio-Stand fuehrt in den Gutschein-Shop (eigener Eintrag entfaellt)
  $('#tm-gifts').onclick = () => { done(); switchView('gifts', 'enter-drop'); };
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
    dmListeNamenMerken(r);
    const rows = [
      ...r.list.map(l => ({ name: l.partner, ts: l.lastTs })),
      ...(r.friends || []).map(f => ({ name: f.name, ts: 0 })),
    ].filter(x => (myProfile?.friends || []).includes(x.name)).slice(0, 3);
    $('#tm-friends').innerHTML = rows.length ? rows.map(f => `
      <div class="tm-req">
        <span class="tm-friend-open" data-tm-user="${esc(f.name)}" style="display:flex; align-items:center; gap:8px; flex:1; cursor:pointer">
          ${avatarHtml(f.name, undefined, 'avatar-mini')}
          <span style="font-weight:700" title="@${esc(f.name)}">${esc(anzeigeName(f.name))}</span>
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
    if (r && myProfile) { myProfile.friends = r.friends; myProfile.friendRequests = r.friendRequests; profilNamenMerken(r); }
    island('Ihr seid jetzt Freunde!');
    done(); updateReqDot(); renderProfil();
  });
  menu.querySelectorAll('[data-freq-no]').forEach(b => b.onclick = async () => {
    const r = await api('/api/friend', { method: 'POST', body: JSON.stringify({ user: b.dataset.freqNo, action: 'decline' }) }).catch(() => { });
    if (r && myProfile) myProfile.friendRequests = r.friendRequests;
    done(); updateReqDot();
  });
}
// Roter Punkt am Avatar, wenn Anfragen warten
function updateReqDot() {
  // … und fuer Wochen-/Monats-Boni, die im Menue zum Abholen warten
  $('#btn-profile-top').classList.toggle('has-dot', !!(myProfile?.friendRequests || []).length || !!(myProfile?.lioBoni || []).length);
}
$('#top-menu-backdrop').addEventListener('click', () => schliesseTopMenu());
$('#tm-zu').addEventListener('click', () => schliesseTopMenu());
// Wischen nach links schliesst die Leiste — sie folgt dabei dem Finger.
// Senkrecht wird gescrollt (touch-action: pan-y auf der Scrollflaeche).
(() => {
  const menu = $('#top-menu'), bd = $('#top-menu-backdrop');
  let sx = 0, sy = 0, t0 = 0, dx = 0, pid = null, aktiv = false, aus = false, klickSperreBis = 0;
  menu.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    sx = e.clientX; sy = e.clientY; t0 = performance.now(); dx = 0; pid = e.pointerId; aktiv = false; aus = false;
  });
  menu.addEventListener('pointermove', e => {
    if (e.pointerId !== pid || aus) return;
    const x = e.clientX - sx, y = e.clientY - sy;
    if (!aktiv) {
      if (Math.abs(y) > 12 && Math.abs(y) > Math.abs(x)) { aus = true; return; }
      if (!(x < -10 && Math.abs(x) > Math.abs(y))) return;
      aktiv = true;
      menu.classList.add('dragging');
      bd.classList.add('dragging');
      try { menu.setPointerCapture(e.pointerId); } catch { }
    }
    dx = Math.min(0, x);
    menu.style.transform = `translate3d(${dx}px,0,0)`;
    bd.style.opacity = String(Math.max(0, 1 + dx / menu.offsetWidth));
  });
  const ende = e => {
    if (e.pointerId !== pid) return;
    pid = null;
    if (!aktiv) return;
    aktiv = false;
    klickSperreBis = Date.now() + 350;
    const tempo = dx / Math.max(1, performance.now() - t0);
    menu.classList.remove('dragging');
    bd.classList.remove('dragging');
    menu.style.transform = '';
    bd.style.opacity = '';
    if (dx < -menu.offsetWidth * 0.3 || tempo < -0.5) schliesseTopMenu();
  };
  menu.addEventListener('pointerup', ende);
  menu.addEventListener('pointercancel', ende);
  // Ein Wisch, der auf einem Eintrag anfing, loest ihn nicht aus
  menu.addEventListener('click', e => { if (Date.now() < klickSperreBis) { e.stopPropagation(); e.preventDefault(); } }, true);
})();

// ---- Benachrichtigungen: Nachrichten-Banner oben

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
    ${avatarHtml(user, undefined, 'avatar-mini')}
    <span style="flex:1">${hatAnzeigename(user) ? `<b>${esc(anzeigeName(user))}</b> (@${esc(user)})` : `<b>@${esc(user)}</b>`} möchte dein Freund sein</span>
    <button class="btn btn-small" id="rt-ok">Annehmen</button>
    <button class="btn btn-small btn-ghost" id="rt-no">Ablehnen</button>`;
  t.classList.remove('hidden');
  t.classList.add('show');
  const hide = () => { t.classList.remove('show'); setTimeout(() => t.classList.add('hidden'), 350); };
  $('#rt-ok').onclick = async () => {
    const r = await api('/api/friend', { method: 'POST', body: JSON.stringify({ user, action: 'accept' }) }).catch(() => null);
    if (r && myProfile) { myProfile.friends = r.friends; myProfile.friendRequests = r.friendRequests; profilNamenMerken(r); }
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
    profilNamenMerken(p); // Anzeigenamen fuer das Anfrage-Popup
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
const tsWidgets = { login: null, reg: null, forgot: null };
let tsSitekey = null;
const tsTries = { login: 0, reg: 0, forgot: 0 };
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
    wrap.className = 'overlay rueckfrage';
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

// Der Server meldet einen anderen @Namen (derzeit gibt es keinen Weg dazu —
// frueher ueber /api/admin/rename, das Aendern ist erstmal raus): gleiches
// Konto — die Sitzung zog mit um —, gleiche Wallet, kein Kontowechsel. Was auf
// dem Geraet am alten Namen hing (PIN, Face ID, Update-Log …), zieht mit.
function neuerKontoname(neu) {
  const alt = state.userName;
  // Nur, wenn die Wallet hier wirklich dem alten Namen gehoert
  if (!neu || !alt || alt === neu || (walletBesitzer && walletBesitzer !== alt)) return;
  for (const k of ['ra.walletPin:', 'ra.walletBio:', 'ra.bioAngebot:', 'ra.ladenErkennung:', 'ra.neuGesehen:']) {
    try {
      const v = localStorage.getItem(k + alt);
      if (v != null && localStorage.getItem(k + neu) == null) { localStorage.setItem(k + neu, v); localStorage.removeItem(k + alt); }
    } catch { }
  }
  state.userName = neu;
  walletBesitzer = neu;
  speichereWallet(true);
  lsSetzen('ra.user', neu);
}

function authOk(r, { welcome = false } = {}) {
  state.token = r.token;
  state.userName = r.user;
  // Lag hier die Wallet eines ANDEREN Kontos, gehoert sie nicht in dieses —
  // frueher wurde sie hineingemischt (samt Loeschmarkern, die dann echte
  // Gutscheine des neuen Kontos toeteten)
  if (walletBesitzer && walletBesitzer !== r.user) {
    walletZuruecksetzen();
    state.walletFilter = ''; state.walletVal = 0; saveWalletFilter();
  }
  walletEntsperrt = true; // gerade mit Passwort angemeldet
  kontoInfo = null;
  // Lag fuer dieses Konto noch Ungesichertes beiseite (frueherer Kontowechsel),
  // kommt es jetzt zurueck und geht hoch
  walletBereit.then(() => walletIdbTx('get', undefined, 'beiseite:' + r.user)).then(rec => {
    if (!rec || !rec.wallet || state.userName !== r.user) return;
    mischeWallet(rec.wallet);
    saveWallet();
    walletIdbTx('del', undefined, 'beiseite:' + r.user).catch(() => { });
  }).catch(() => { });
  lsSetzen('ra.token', r.token);
  lsSetzen('ra.user', r.user);
  refreshProfileTab();
  pullWallet(); // Wallet vom Konto holen (Gerätewechsel/Neuinstallation)
  connectStream(); // Echtzeit-Stream mit dem frischen Token neu verbinden
  neuGeprueft = false; // anderes Konto: eigener Stand beim Update-Log
  setTimeout(verarbeiteGeteiltes, 400); // geteiltes Bild wartete auf die Anmeldung
  api('/api/me').then(x => { kontoInfo = x; state.role = x.role || ''; refreshAdminUi(); pinKontoUebernehmen(x); renderWallet(); pruefeNeuigkeiten(); }).catch(() => { });
  playSfx('anmelden', 1);   // derselbe Ton wie nach der PIN
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

$('#btn-pw-vergessen')?.addEventListener('click', () => passwortVergessenDialog($('#auth-user').value.trim()));
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
    if (r.zweiFaktor) {
      // Zweiter Faktor: nur hier, bei der Anmeldung
      const fertig = await zweiFaktorAnmeldung(r.ticket);
      if (fertig && fertig.token) authOk(fertig);
      else renderTurnstile('login');
      return;
    }
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
  // Über einen Einladungslink gekommen? Dann sagen wir sofort, was es bringt
  const ref = localStorage.getItem('ra.ref');
  const note = $('#reg-ref-note');
  if (note) {
    note.classList.toggle('hidden', !ref);
    if (ref) note.innerHTML = `${icon('user', 'icon icon-sm')} <span><b>@${esc(ref)}</b> hat dich zu kumulio eingeladen.</span>`;
  }
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
        ref: localStorage.getItem('ra.ref') || '',
        turnstileToken: tsToken('reg'),
      }),
    });
    hideOverlay($('#register-backdrop'));
    localStorage.removeItem('ra.ref');
    $('#reg-pass').value = '';
    authOk(r, { welcome: true });
    if (state.activeView !== 'profile') switchView('profile');
    // Direkt nach dem Konto: Mitteilungen anbieten (Preisfehler-Alarm, Nachrichten)
    setTimeout(async () => {
      if (await askConfirm('Sollen Preisfehler-Alarm und Nachrichten von Freunden als Mitteilung aufs Handy kommen?', { okLabel: 'Mitteilungen erlauben' })) {
        try { await enablePushNow(); island('Mitteilungen sind aktiv!'); } catch (e2) { island(e2.message); }
      }
    }, 700);
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
  state.walletFilter = ''; state.walletVal = 0; saveWalletFilter();
  // Die Wallet bleibt auf dem Geraet — also wieder sperren
  walletEntsperrt = false;
  kontoInfo = null;
  aktualisiereSperre();
  refreshProfileTab();
  island('Abgemeldet');
});

// Dark Mode als On/Off-Schalter in den Einstellungen
const swTheme = $('#sw-theme');
if (swTheme) {
  swTheme.checked = document.documentElement.dataset.theme === 'dark';
  swTheme.addEventListener('change', () => applyTheme(swTheme.checked ? 'dark' : 'light', true));
}
// Soundeffekte als Opt-in-Schalter (Default aus)
const swSound = $('#sw-sound');
if (swSound) {
  swSound.checked = soundOn();
  swSound.addEventListener('change', () => {
    lsSetzen('ra.sound', swSound.checked ? '1' : '0');
    if (swSound.checked) { initSfx(); playSfx('plop'); }
  });
}
// Animationen: an (Standard) oder aus. Hat das Handy "Bewegung reduzieren"
// an, bleiben sie ohnehin aus — das sagt die Zeile dann auch.
const swAnim = $('#sw-anim');
function zeigeAnimZeile() {
  if (!swAnim) return;
  const system = matchMedia('(prefers-reduced-motion: reduce)').matches;
  swAnim.checked = animWahl() !== 'aus' && !system;
  swAnim.disabled = system;
  const t = $('#anim-hinweis');
  if (t) t.textContent = system
    ? 'Dein Handy hat „Bewegung reduzieren“ an, deshalb bleiben sie aus.'
    : 'Übergänge, Menüleiste und Effekte';
}
if (swAnim) {
  zeigeAnimZeile();
  swAnim.addEventListener('change', () => {
    try {
      localStorage.setItem(ANIM_WAHL, swAnim.checked ? 'an' : 'aus');
      if (swAnim.checked) localStorage.removeItem(SPARSAM);
    } catch { /* egal */ }
    setzeAnimKlassen();
    buzz(8);
  });
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', zeigeAnimZeile);
}
// Mitteilungs-Schalter: Banner/Sounds pro Kategorie an- und abschaltbar
[['msgs', '#sw-n-msgs'], ['reminder', '#sw-n-reminder']].forEach(([key, sel]) => {
  const el = $(sel);
  if (!el) return;
  el.checked = state.notif[key] !== false;
  el.addEventListener('change', () => { state.notif[key] = el.checked; save('notif', state.notif); });
});

// ---------------- Einfuehrung beim ersten Start ----------------
// Ein Fluss: das Logo faellt, rutscht nach oben, darunter begruesst Kumulio
// (Fenster in der Rang-Farbe wie in der Wallet) und zaehlt auf, was die App
// kann. "Jetzt loslegen" wischt alles weg zur Tour ueber die echten Reiter;
// am Ende kommt der Startgrund mit Konto erstellen / Einloggen zurueck.

// Läuft die App schon als Home-Bildschirm-App? Sonst zeigt die Tour die Anleitung.
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const uaIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const uaAndroid = /android/i.test(navigator.userAgent);

// Fenster in der Rang-Farbe; rechts schaut Kumulio heraus (Oberkoerper, der
// Kopf ragt oben ueber den Rand) — derselbe Auftritt wie die Wallet-Karte
function introFensterHtml(titel, text) {
  return `
    <div class="intro-fenster">
      <div class="intro-fenster-text"><h2>${esc(titel)}</h2><p>${esc(text)}</p></div>
      <span class="intro-figur" aria-hidden="true"><img src="/brand/kumulio-maskottchen-wallet-480.webp"
        srcset="/brand/kumulio-maskottchen-wallet-480.webp 480w, /brand/kumulio-maskottchen-wallet-960.webp 960w"
        sizes="200px" width="200" height="211" alt="" decoding="async" draggable="false"></span>
    </div>`;
}
// Was die App kann: Symbol im Rang-Ton, fett die Sache, darunter ein Satz
function introPunkteHtml(punkte) {
  return `<ul class="intro-punkte">${punkte.map(([ico, titel, text]) => `
    <li><span class="intro-punkt-ico">${icon(ico)}</span>
      <span class="intro-punkt-text"><b>${esc(titel)}</b><span>${esc(text)}</span></span></li>`).join('')}
  </ul>`;
}

function finishOnboarding() {
  lsSetzen('ra.tutorialDone', '1');
  const ob = $('#onboard');
  ob.classList.add('done');
  setTimeout(() => { ob.classList.add('hidden'); ob.classList.remove('done', 'step', 'finale'); }, 520);
}

function maybeShowOnboarding() {
  if (localStorage.getItem('ra.tutorialDone')) return;
  // Markenmoment: das Logo faellt in der Mitte ein und gleitet nach oben,
  // dann baut sich die Begruessung darunter auf
  const ob = $('#onboard');
  ob.classList.remove('hidden');
  setTimeout(() => {
    ob.classList.add('step');
    $('#ob-step').innerHTML = introFensterHtml('Schön, dass du da bist.', 'Das kann kumulio:')
      + introPunkteHtml([
        ['deals', 'Deals, die sich lohnen', 'Handverlesene Angebote und Preisfehler, ohne Deal-Spam.'],
        ['wallet', 'Alle Gutscheine in einer Wallet', 'Code und PIN immer griffbereit, abbuchen mit einem Tipp.'],
        ['gift', 'Verschenken an Freunde', 'Gutscheine weitergeben, Coupons merken und teilen.'],
        ['star', 'Lios und Cashback', 'Jeden Tag Lios sammeln und im Shop gegen Gutscheine tauschen.'],
      ]);
    $('#ob-extra').innerHTML = '';
    const next = $('#ob-next');
    next.textContent = 'Jetzt loslegen';
    next.classList.remove('hidden');
    next.onclick = () => {
      ob.classList.add('swipe');
      setTimeout(() => { ob.classList.add('hidden'); ob.classList.remove('swipe', 'step'); startTour(); }, 640);
    };
    $('#ob-content').classList.remove('hidden');
    $('#ob-skip').classList.remove('hidden');
  }, 1600);
}

// Finale der Tour: der Startgrund kommt von unten zurueck, das Logo faellt
// wieder ein, darunter Konto erstellen, Einloggen oder ohne Konto weiter
function showTourFinale() {
  // Schon angemeldet (neues Geraet): kein Konto-Angebot, direkt in den Feed
  if (state.token) {
    lsSetzen('ra.tutorialDone', '1');
    if (state.activeView !== 'feed') switchView('feed');
    return;
  }
  const ob = $('#onboard');
  ob.classList.remove('hidden', 'done', 'swipe', 'step');
  ob.classList.add('finale');
  ob.scrollTop = 0;
  $('#ob-content').classList.add('hidden');
  const logo = ob.querySelector('.ob-logo');
  logo.style.animation = 'none';
  void logo.offsetWidth;
  logo.style.animation = '';
  $('#ob-step').innerHTML = introFensterHtml('Bereit zum Sparen?', 'Mit Konto ist deine Wallet gesichert und auf jedem Gerät dabei.')
    + introPunkteHtml([
      ['wallet', 'Wallet auf jedem Gerät', 'Gutscheine und Karten liegen sicher in deinem Konto.'],
      ['message', 'Mit Freunden schreiben', 'Chatten und Deals teilen geht mit Konto.'],
      ['thumb-up', 'Mitreden', 'Deals bewerten und kommentieren.'],
    ]);
  const next = $('#ob-next');
  next.classList.add('hidden');
  $('#ob-extra').innerHTML = `
    <div class="intro-knoepfe">
      <button class="btn btn-big" id="obf-register" type="button">Konto erstellen</button>
      <button class="btn btn-big btn-ghost" id="obf-login" type="button">Einloggen</button>
    </div>
    <button class="intro-link" id="obf-guest" type="button">Ohne Konto weiter</button>`;
  const closeOb = () => {
    finishOnboarding();
    setTimeout(() => next.classList.remove('hidden'), 520);
  };
  // Registrieren geht als Fenster ueber dem Feed; Einloggen hat seine Seite
  $('#obf-register').onclick = () => { closeOb(); switchView('feed'); setTimeout(() => $('#btn-register-open')?.click(), 400); };
  $('#obf-login').onclick = () => { closeOb(); switchView('profile'); };
  $('#obf-guest').onclick = () => { closeOb(); switchView('feed'); };
  $('#ob-skip').classList.add('hidden');
  // Der Logo-Moment darf atmen, dann rutscht es hoch und der Inhalt kommt
  setTimeout(() => {
    ob.classList.add('step');
    setTimeout(() => $('#ob-content').classList.remove('hidden'), 380);
  }, 950);
}

// ---- Tour: ein Lichtfeld wandert ueber die echten Reiter, daneben eine
// weisse Karte mit Vorschau aus den echten Bausteinen der App. Das Feld
// bewegt sich nur per transform.
function startTour() {
  // Feed: zwei echte Deal-Kacheln (am liebsten mit Foto)
  const offen = state.deals.filter(d => !d.stale);
  const mitBild = offen.filter(d => dealBild(d));
  const deals = (mitBild.length >= 2 ? mitBild : offen).slice(0, 2);
  const feedDemo = deals.length
    ? `<div class="tour-deals${deals.length === 1 ? ' einzeln' : ''}">${deals.map(d => dealKachelHtml(d, { art: 'reihe' })).join('')}</div>`
    : '';
  // Wallet: eine Gutschein-Karte, genau wie in der Wallet (Beispielwerte)
  const walletDemo = `<div class="tour-karte">${voucherCardHtml({ id: 'tour-beispiel', vendor: 'REWE', amount: 25, balance: 25, code: '2094 4258 9452', pin: '3374' })}</div>
    <span class="tour-notiz">So sieht ein Gutschein in deiner Wallet aus.</span>`;
  // Chat: ein geteilter Deal und die Antwort darauf
  const geteilt = offen[0];
  const chatDemo = `<div class="tour-chat">
      <div class="tc-zeile"><span class="tc-ava" style="background:${chatColor('Milena')}">M</span>
        <span class="tc-blase">${geteilt ? `<span class="tc-deal">${icon('deals', 'icon')}<span>${esc(geteilt.title)}</span></span>` : ''}Schau mal, lohnt sich!</span></div>
      <div class="tc-zeile ich"><span class="tc-blase">Danke, gleich gemerkt.</span></div>
    </div>`;
  const steps = [
    { view: 'feed', tab: 'feed', title: 'Deals, die sich lohnen', text: 'Oben die Highlights, darunter die Top Deals für dich. Preisfehler meldet kumulio auf Wunsch sofort aufs Handy.', visual: feedDemo },
    { view: 'wallet', tab: 'wallet', title: 'Deine Wallet', text: 'Gutschein abfotografieren, den Rest füllt kumulio aus. Karten & Coupons deiner Läden liegen gleich daneben.', visual: walletDemo },
    // Lios: mit Konto zeigt das Lichtfeld auf den runden Shop-Knopf oben rechts in der
    // Wallet, ohne Konto (den Knopf gibt es dann nicht) steht die Karte mittig
    { view: 'wallet', sel: '#btn-lio-top', nurWenn: lioKnopfSichtbar, title: 'Lios sammeln', text: (state.token
      ? 'Für jeden Tag in kumulio gibt es Lios. Oben rechts in der Wallet geht es in den Shop: Dort tauschst du sie gegen Gutscheine.'
      : 'Mit Konto gibt es für jeden Tag in kumulio Lios. Oben rechts in der Wallet geht es in den Shop: Dort tauschst du sie gegen Gutscheine.'),
      visual: lioTourHtml() },
    { view: 'chat', tab: 'chat', title: 'Mit Freunden', text: 'Schick Deals direkt an Freunde und schreibt zusammen.', visual: chatDemo },
    { sel: '#btn-profile-top', title: 'Dein Profil', text: state.token
      ? 'Oben links über dein Profilbild: Profil, Freunde und Einstellungen.'
      : 'Oben links meldest du dich an. Danach findest du dort dein Profil, Freunde und Einstellungen.' },
    ...(!isStandalone && (uaIOS || uaAndroid) ? [{
      center: true, title: 'Als App auf den Home-Bildschirm', text: uaIOS
        ? 'Tipp unten auf Teilen und wähle „Zum Home-Bildschirm“: Vollbild, schneller Start und der Preisfehler-Alarm funktioniert.'
        : 'Öffne das Browser-Menü und tippe auf „App installieren“: Vollbild und schneller Start.',
      cta: 'Mach ich gleich',
    }] : []),
  ];
  let i = 0;
  const tour = document.createElement('div');
  tour.id = 'tour';
  tour.innerHTML = `
    <div class="tour-spot"></div>
    <div class="tour-bubble leave" role="dialog" aria-modal="true" aria-labelledby="tour-titel">
      <div class="tour-kopf"><span class="tour-num">1</span><h3 id="tour-titel"></h3></div>
      <p></p>
      <div class="tour-media" aria-hidden="true"></div>
      <div class="tour-btns"></div>
      <button class="tour-alt tour-skip-inline" type="button">Tour überspringen</button>
    </div>`;
  document.body.appendChild(tour);
  const spot = tour.querySelector('.tour-spot');
  const bubble = tour.querySelector('.tour-bubble');
  const end = () => {
    tour.classList.add('closing');
    setTimeout(() => tour.remove(), 400);
  };
  tour.querySelector('.tour-skip-inline').onclick = () => {
    lsSetzen('ra.tutorialDone', '1');
    end();
    if (state.activeView !== 'feed') switchView('feed');
  };
  // Das Lichtfeld: Groesse direkt, Lage per transform (gleitet weich hinueber)
  let spotDa = false;
  const setzeSpot = (x, y, b, h) => {
    spot.style.width = Math.round(b) + 'px';
    spot.style.height = Math.round(h) + 'px';
    spot.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    if (!spotDa) { spotDa = true; void spot.offsetWidth; spot.classList.add('gleitet'); }
  };
  // Lichtfeld: beim Reiter Symbol und Beschriftung zusammen — gemessen am
  // Knopf, nicht am Symbol (das waechst gerade noch). Alle Reiter ergeben so
  // dieselbe Groesse, das Feld gleitet nur. Sonst das Element mit etwas Luft.
  const zielRect = s => {
    if (s.tab) {
      const btn = document.querySelector(`.tabbtn[data-view="${s.tab}"]`);
      const k = btn?.getBoundingClientRect(), t = btn?.querySelector('.tab-txt')?.getBoundingClientRect();
      if (!k || !t) return null;
      const mitte = k.left + k.width / 2, breite = Math.min(k.width - 16, 92);
      return { x: mitte - breite / 2, y: k.top - 12, b: breite, h: t.bottom + 7 - (k.top - 12) };
    }
    if (s.nurWenn && !s.nurWenn()) return null;
    const r = s.sel && document.querySelector(s.sel)?.getBoundingClientRect();
    return r ? { x: r.left - 6, y: r.top - 6, b: r.width + 12, h: r.height + 12 } : null;
  };
  const show = () => {
    const s = steps[i];
    // Ein wackelnder View-Wechsel (geraetespezifisch) darf die Tour nicht killen.
    // Gesperrte Wallet: nicht hinwechseln — die Sperre laege ueber allem (auch
    // ueber dem Reiter) und Face ID sprang mitten in der Tour auf. Das Lichtfeld
    // zeigt dann nur auf den Reiter, die Ansicht bleibt.
    const bleiben = s.view === 'wallet' && walletGesperrt();
    try { if (s.view && !bleiben && state.activeView !== s.view) switchView(s.view); } catch (e) { console.warn('Tour: View-Wechsel', e); }
    tour.querySelector('.tour-num').textContent = i + 1;
    tour.querySelector('h3').textContent = s.title;
    tour.querySelector('p').textContent = s.text;
    try { tour.querySelector('.tour-media').innerHTML = s.visual || ''; }
    catch (e) { tour.querySelector('.tour-media').innerHTML = ''; console.warn('Tour: Vorschau', e); }
    const btns = tour.querySelector('.tour-btns');
    btns.innerHTML = `<button class="btn btn-big" data-t="next" type="button">${esc(s.cta || (i === steps.length - 1 ? 'Fertig' : 'Weiter'))}</button>`;
    btns.querySelector('[data-t]').onclick = () => {
      i++;
      if (i < steps.length) showSmooth();
      else { end(); showTourFinale(); }
    };
    // Erst rendern (nach einem View-Wechsel kurz setzen lassen), dann MESSEN
    // und die Karte mittig in den freien Raum setzen — nie an den Rand oder
    // aufs Feld. Bis dahin bleibt sie abgetaucht (kein Aufblitzen am alten Platz).
    setTimeout(() => requestAnimationFrame(() => { try {
      const M = 16;
      const safeTop = 64;
      const bh = bubble.offsetHeight;
      const r = !s.center && zielRect(s);
      if (r) {
        const { x, y, b, h } = r;
        setzeSpot(x, y, b, h);
        spot.classList.remove('weg');
        spot.classList.toggle('rund', !s.tab && Math.abs(b - h) < 4);
        const roomAbove = y - safeTop;
        if (roomAbove >= bh + M) {
          bubble.style.top = (safeTop + (roomAbove - bh) / 2) + 'px';
          bubble.style.transformOrigin = 'center bottom';
        } else {
          bubble.style.top = Math.min(innerHeight - bh - M, y + h + M) + 'px';
          bubble.style.transformOrigin = 'center top';
        }
      } else {
        // Kein Ziel: das Feld schliesst sich, alles bleibt gedimmt
        setzeSpot(innerWidth / 2, innerHeight * .45, 0, 0);
        spot.classList.add('weg');
        bubble.style.top = Math.max(safeTop, (innerHeight - bh) / 2 - 24) + 'px';
        bubble.style.transformOrigin = 'center center';
      }
      bubble.classList.remove('pop', 'leave');
      void bubble.offsetWidth;
      bubble.classList.add('pop');
    } catch (e) {
      // Notnagel: Karte mittig zeigen statt gar nichts
      console.warn('Tour: Platzierung', e);
      setzeSpot(innerWidth / 2, innerHeight * .45, 0, 0);
      spot.classList.add('weg');
      bubble.style.top = '30%';
      bubble.classList.remove('leave');
      bubble.classList.add('pop');
    } }), s.view ? 60 : 0);
  };
  // Zwischen den Schritten taucht die Karte kurz ab und kommt federnd wieder
  const showSmooth = () => {
    bubble.classList.add('leave');
    setTimeout(show, 170);
  };
  show();
}

// Ueberspringen: ohne Tour direkt in die App
$('#ob-skip').addEventListener('click', () => finishOnboarding());
// Wallet ohne Konto: Anmelden fuehrt zur Anmeldung, "Konto erstellen" oeffnet
// die Registrierung gleich hier
$('#btn-wallet-login').addEventListener('click', () => switchView('profile'));
$('#btn-wallet-register')?.addEventListener('click', () => $('#btn-register-open')?.click());

// ---------------- Wallet 2.0: Gutscheine mit Guthaben + Sparkarten ----------------

// Migration alter Einträge: value-String -> Guthaben, neue Felder ergänzen.
// An Ort und Stelle (gleiche Objekte) und beliebig oft aufrufbar: beim Start
// und nochmal, wenn die volle Wallet aus IndexedDB da ist.
function normalisiereWallet() {
  const w = state.wallet;
  w.vouchers = (Array.isArray(w.vouchers) ? w.vouchers : []).filter(Boolean);
  w.cards = (Array.isArray(w.cards) ? w.cards : []).filter(Boolean);
  w.deleted = Array.isArray(w.deleted) ? w.deleted : [];
  const neueId = () => Math.random().toString(36).slice(2, 9);
  for (const v of w.vouchers) {
    const wert = parseFloat(String(v.value || '').replace(',', '.')) || null;
    // Uralte Eintraege ohne ID: bekommen eine, statt beim Abgleich zu verschwinden
    if (!v.id) v.id = neueId();
    if (!('pin' in v)) v.pin = '';
    if (!('img' in v)) v.img = '';
    if (!('codeImg' in v)) v.codeImg = '';
    if (!('tx' in v)) v.tx = [];
    if (!('balance' in v) || v.balance === undefined) v.balance = wert;
    if (!('amount' in v) || v.amount === undefined) v.amount = wert;
    // Ein Rabattcode hat nie Guthaben (auch wenn ein altes Geraet eins eingetragen
    // hat), und seine Felder sind Zahlen bzw. eine feste Einheit — nichts anderes
    if (istRabatt(v)) {
      v.amount = null; v.balance = null;
      const zahl = x => (x == null || x === '' || !Number.isFinite(Number(x)) || Number(x) <= 0 ? null : Math.round(Number(x) * 100) / 100);
      v.rabatt = zahl(v.rabatt);
      v.mbw = zahl(v.mbw);
      v.rabattArt = v.rabattArt === 'pct' ? 'pct' : 'eur';
      v.code = String(v.code || '');
      v.vendor = String(v.vendor || '');
    }
    // Pfandbon: der Wert steht in amount, nie Guthaben; die Filiale ist ein
    // Objekt mit Text-Feldern (ein altes Geraet kennt sie nicht)
    if (istPfand(v)) {
      const n = Number(v.amount);
      v.amount = v.amount != null && v.amount !== '' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
      v.balance = null;
      v.code = String(v.code || '');
      v.vendor = String(v.vendor || '');
      v.eingeloest = Number(v.eingeloest) > 0 ? Number(v.eingeloest) : 0;
      const f = v.filiale && typeof v.filiale === 'object' ? v.filiale : {};
      v.filiale = { ...f, name: String(f.name || ''), strasse: String(f.strasse || ''), plz: String(f.plz || ''), ort: String(f.ort || '') };
    }
  }
  for (const c of w.cards) {
    if (!c.id) c.id = neueId();
    if (!('img' in c)) c.img = '';
    if (!('codeImg' in c)) c.codeImg = '';
  }
  ensureWalletDates();
  slimWalletImages();
}
// Bestandsdaten ohne Datum reparieren (sehr alte Einträge haben weder added
// noch Buchungs-Zeitstempel) – sonst ignoriert die Statistik sie stumm
function ensureWalletDates() {
  // Hat ein datumloser Alt-Eintrag einen Loeschmarker, bekommt er nicht
  // "jetzt" — sonst waere er juenger als der Marker und lebte wieder auf
  const tot = new Set((state.wallet.deleted || []).map(t => t && t.id));
  state.wallet.vouchers.forEach(v => {
    const stamps = (v.tx || []).map(t => t.ts).filter(Boolean);
    if (!v.added) v.added = stamps.length ? Math.min(...stamps) : (tot.has(v.id) ? 1 : Date.now());
    (v.tx || []).forEach(t => { if (!t.ts) t.ts = v.added; });
  });
}
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
normalisiereWallet();
// Bestand nachkomprimieren: alte Bilder (JPEG in fester Qualitaet, frueher
// sogar PNG mit mehreren MB) werden im Hintergrund neu kodiert — aber nur,
// wenn es mindestens ein Viertel spart. Sonst bleibt das Bild, wie es ist:
// jedes Neukodieren kostet ein wenig Schaerfe, das lohnt nur bei echtem Gewinn.
async function verkleinereBestand() {
  const alle = [...state.wallet.vouchers, ...state.wallet.cards].filter(x => x && x.id);
  // Nur Merker fuer Eintraege behalten, die es noch gibt
  const lebt = new Set(alle.map(x => x.id));
  const geprueft = Object.fromEntries(Object.entries(lsJson('ra.bilderGeprueft', {})).filter(([k]) => lebt.has(k.split(':')[0])));
  let geaendert = 0;
  for (const item of alle) {
    for (const feld of ['codeImg', 'img']) {
      const alt = item && item[feld];
      if (!alt || alt.length < 40_000) continue;
      const sig = item.id + ':' + feld + ':' + alt.length;
      if (geprueft[sig]) continue;
      geprueft[sig] = 1;
      try {
        const bild = new Image();
        await new Promise((res, rej) => { bild.onload = res; bild.onerror = rej; bild.src = alt; });
        const neu = kodiereBild(bild, 'bestand');
        // Nur uebernehmen, wenn das Bild sich inzwischen nicht geaendert hat.
        // Das ist KEINE Bearbeitung: mt steigt nur minimal (damit die kleinere
        // Fassung hochgeht), nie auf "jetzt" — sonst schluege ein Geraet mit
        // altem Stand echte Aenderungen anderer Geraete
        if (neu && neu.length <= alt.length * 0.75 && item[feld] === alt) {
          item[feld] = neu;
          item.mt = (item.mt || 0) + 1;
          walletHashes[item.id] = itemHash(item);
          geaendert++;
        }
      } catch { /* kaputtes Bild: so lassen */ }
      // Dem Handy Luft lassen: ein Bild pro Durchgang
      await new Promise(r => setTimeout(r, 30));
    }
  }
  lsSetzen('ra.bilderGeprueft', JSON.stringify(geprueft));
  if (geaendert) saveWallet();
}

// Wallet: lokal speichern + (angemeldet) ans Konto syncen, Gutscheine überleben
// so App-Neuinstallation und Gerätewechsel
let walletSyncTimer = null;
// Solange etwas nicht beim Server angekommen ist, bleibt die Dirty-Marke stehen
// und der Sync wird wiederholt; so kann "gespeichert" nie mehr heimlich verloren gehen
let walletSyncError = '';
let walletSyncFatal = false; // true = der Server hat abgelehnt (Retry zwecklos)
let walletSyncInFlight = null; // Single-Flight: parallele Syncs teilen sich EINEN Upload
// Löschmarker: Gelöschtes wird dem Konto GEMELDET statt nur weggelassen —
// sonst belebt das Zweitgerät (altes Handy) den Gutschein beim nächsten Sync wieder
const LOESCHMARKER_MAX = 20000;
function tombstone(id) {
  state.wallet.deleted = [...(state.wallet.deleted || []), { id, ts: Date.now() }].slice(-LOESCHMARKER_MAX);
  origIdb('del', id); // Originalfoto auf dem Geraet; am Konto raeumt der Server auf
}
// Änderungs-Zeitstempel je Eintrag: bei Konflikten zwischen zwei Geräten gewinnt,
// wer zuletzt WIRKLICH etwas geändert hat — nicht, wer zufällig zuletzt syncte.
// Erkennung über einen Inhalts-Hash je Eintrag (mt selbst zählt nicht mit).
// Bewusst NUR in diesem Tab: der Vergleichsstand darf nicht geteilt werden,
// sonst haelt ein zweiter Tab seinen veralteten Stand faelschlich fuer neu
// und ueberschreibt damit die Aenderung des ersten.
const walletHashes = {};
(function hashesAusStand() {
  for (const it of [...(state.wallet.vouchers || []), ...(state.wallet.cards || [])]) {
    if (it && it.id) walletHashes[it.id] = itemHash(it);
  }
})();
function itemHash(it) {
  const str = JSON.stringify(it, (k, v) => (k === 'mt' || k === 'bildSig' ? undefined
    : (k === 'codeImg' || k === 'img') && typeof v === 'string' && v.length > 200
      ? 'b:' + v.length + ':' + v.slice(40, 90) + v.slice(-60)
      : v));
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h + ':' + str.length;
}
function markWalletChanges() {
  let changed = false;
  const alive = new Set();
  for (const it of [...state.wallet.vouchers, ...state.wallet.cards]) {
    if (!it || !it.id) continue;
    alive.add(it.id);
    const h = itemHash(it);
    if (walletHashes[it.id] !== h) { it.mt = Math.max(Date.now(), (it.mt || 0) + 1); walletHashes[it.id] = h; changed = true; }
  }
  for (const id of Object.keys(walletHashes)) {
    if (!alive.has(id)) { delete walletHashes[id]; changed = true; }
  }
  return changed;
}

// ---------------- Wallet-Speicher: Platz ohne 5-MB-Deckel ----------------
// Die Wallet liegt vollstaendig (mit allen Bildern) in IndexedDB — dort ist
// Platz fuer so viel, wie das Handy frei hat. localStorage haelt nur noch einen
// kleinen Spiegel ohne Bilder: damit steht die Wallet beim Start sofort da, die
// Bilder kommen Millisekunden spaeter dazu (walletBereit).
// Frueher lag alles im localStorage (rund 5 MB). Ab etwa 50 Gutscheinen mit
// Foto war der voll, Speichern scheiterte still — so gingen Gutscheine verloren.
let walletIdbP = null;
function walletIdb() {
  if (!walletIdbP) {
    walletIdbP = new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('kein IndexedDB'));
      const r = indexedDB.open('kumulio-wallet', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('stand');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('IndexedDB blockiert'));
    });
    walletIdbP.catch(() => { walletIdbP = null; });
  }
  return walletIdbP;
}
function walletIdbTx(art, wert, schluessel = 'wallet') {
  return walletIdb().then(db => new Promise((res, rej) => {
    const tx = db.transaction('stand', art === 'get' ? 'readonly' : 'readwrite');
    const st = tx.objectStore('stand');
    const r = art === 'get' ? st.get(schluessel) : art === 'put' ? st.put(wert, schluessel) : st.delete(schluessel);
    // Erst melden, wenn es wirklich festgeschrieben ist
    tx.oncomplete = () => res(r.result);
    tx.onerror = () => rej(tx.error || r.error);
    tx.onabort = () => rej(tx.error || new Error('abgebrochen'));
  }));
}
// Kurzer Fingerabdruck der Bilder: daran erkennt der Start, ob das Bild aus
// IndexedDB zu diesem Eintrag gehoert (und nicht zu einer aelteren Fassung)
function bildSig(it) {
  const a = (it && it.codeImg) || '', b = (it && it.img) || '';
  if (!a && !b) return '';
  const probe = s => s.length + '.' + s.slice(40, 72) + s.slice(-32);
  return probe(a) + '|' + probe(b);
}
function schreibeSpiegel() {
  const leicht = it => {
    // Ohne (lesbares) IndexedDB: Bilder im Spiegel lassen, so gut es passt —
    // nicht hydrierte Eintraege behalten ihren Fingerabdruck fuer den naechsten Start
    if (!it || !walletIdbOk || idbGesperrt) return it;
    const sig = bildSig(it);
    return sig ? { ...it, codeImg: '', img: '', bildSig: sig } : it;
  };
  const spiegel = {
    stand: walletStand, user: walletBesitzer, bilderInIdb: walletIdbOk,
    vouchers: (state.wallet.vouchers || []).map(leicht),
    cards: (state.wallet.cards || []).map(leicht),
    deleted: state.wallet.deleted || [],
    statistik: state.wallet.statistik || {},
  };
  if (lsSetzen('ra.wallet', JSON.stringify(spiegel))) return true;
  // Ohne IndexedDB und voller localStorage: wenigstens alles ausser den
  // Bildern (die liegen beim Konto und kommen beim Abgleich zurueck)
  const ohne = it => (it && (it.codeImg || it.img) ? { ...it, codeImg: '', img: '', bildSig: bildSig(it) } : it);
  return lsSetzen('ra.wallet', JSON.stringify({ ...spiegel, bilderInIdb: false,
    vouchers: spiegel.vouchers.map(ohne), cards: spiegel.cards.map(ohne) }));
}
// IndexedDB-Schreiben gebuendelt: laeuft eins, folgt danach genau noch eins
// mit dem neuesten Stand
let idbSchreibt = null, idbNochmal = false, idbFehler = 0;
function walletIdbMerken() {
  if (idbGesperrt) return Promise.resolve();
  if (idbSchreibt) { idbNochmal = true; return idbSchreibt; }
  idbSchreibt = (async () => {
    // Vor dem Start-Abgleich stuende hier die Fassung ohne Bilder — die darf
    // IndexedDB nie ueberschreiben
    await walletBereit;
    do {
      // Kann waehrend des Wartens gesperrt worden sein (Start fand IndexedDB nicht)
      if (idbGesperrt) return;
      idbNochmal = false;
      try {
        await walletIdbTx('put', { stand: walletStand, user: walletBesitzer, wallet: state.wallet });
        idbFehler = 0;
        if (!walletIdbOk) { walletIdbOk = true; schreibeSpiegel(); }
      } catch {
        // Einmal haken kann IndexedDB schon (Speicherdruck, Hintergrund):
        // nochmal versuchen, erst nach drei Fehlschlaegen alles in den localStorage
        walletIdbP = null; // Verbindung neu aufbauen
        if (++idbFehler < 3) { await new Promise(r => setTimeout(r, 700)); idbNochmal = true; continue; }
        if (walletIdbOk) { walletIdbOk = false; schreibeSpiegel(); }
        break;
      }
    } while (idbNochmal);
  })().finally(() => { idbSchreibt = null; });
  return idbSchreibt;
}
function speichereWallet(vomServer) {
  if (!vomServer) {
    walletRev++;
    // Bearbeitet-Zeitpunkt (mt) sofort setzen, nicht erst beim Hochladen:
    // sonst gewinnt bei zwei Geraeten die falsche Fassung
    try { markWalletChanges(); } catch { /* beim Start noch nicht bereit */ }
  }
  if (state.userName) walletBesitzer = state.userName;
  walletStand = Math.max(Date.now(), walletStand + 1);
  const ok = schreibeSpiegel();
  if (walletIdbOk) walletIdbMerken();
  return ok;
}
// Eintrag an Ort und Stelle aktualisieren statt ihn zu ersetzen: ein offenes
// Gutschein-Blatt haelt sein Objekt fest — bucht man dort ab, muss die Buchung
// im selben Objekt landen, das auch gespeichert wird
function ersetzeInhalt(ziel, quelle) {
  if (ziel === quelle) return ziel;
  for (const k of Object.keys(ziel)) if (!(k in quelle)) delete ziel[k];
  Object.assign(ziel, quelle);
  return ziel;
}
function ersetzeListeInPlace(key, neuListe) {
  const alt = new Map((state.wallet[key] || []).filter(Boolean).map(x => [x.id, x]));
  state.wallet[key] = (neuListe || []).filter(Boolean).map(n => { const a = alt.get(n.id); return a ? ersetzeInhalt(a, n) : n; });
}
function walletHashesNeu() {
  Object.keys(walletHashes).forEach(k => delete walletHashes[k]);
  for (const it of [...state.wallet.vouchers, ...state.wallet.cards]) if (it && it.id) walletHashes[it.id] = itemHash(it);
}
// Start: Bilder aus IndexedDB zum Spiegel holen
// IndexedDB war beim Start nicht lesbar (gibt es aber): in dieser Sitzung
// NICHT hineinschreiben — sonst ueberschriebe die bildlose Fassung die Bilder
// dort. Der Spiegel behaelt seine Fingerabdruecke, der naechste Start holt sie.
let idbGesperrt = false;
function hydriereWallet() {
  const spiegel = state.wallet;
  // Alte Version (vor IndexedDB): der localStorage hatte die ganze Wallet,
  // ohne "stand". Nur das ist Altbestand — nie ein Spiegel dieser Version.
  const altbestand = !('stand' in spiegel);
  walletBereit = (async () => {
    let rec = null, gelesen = false;
    for (let versuch = 0; versuch < 3 && !gelesen; versuch++) {
      try {
        // Haengt IndexedDB, darf die App nicht die ganze Sitzung warten
        rec = await Promise.race([walletIdbTx('get'), new Promise((_, rej) => setTimeout(() => rej(new Error('IndexedDB haengt')), 6000))]);
        gelesen = true;
      } catch {
        if (!window.indexedDB) break;
        walletIdbP = null; // tote Verbindung verwerfen, neu oeffnen
        await new Promise(r => setTimeout(r, 800));
      }
    }
    if (!gelesen) {
      if (!window.indexedDB) walletIdbOk = false; // gibt es nicht: localStorage ist der Speicher
      else idbGesperrt = true;
      return;
    }
    const fremd = rec && rec.user && walletBesitzer && rec.user !== walletBesitzer;
    if (rec && rec.wallet && !fremd) {
      const byId = new Map([...(rec.wallet.vouchers || []), ...(rec.wallet.cards || [])].filter(Boolean).map(x => [x.id, x]));
      const nichtAelter = (rec.stand || 0) >= (Number(spiegel.stand) || 0);
      if (!altbestand && nichtAelter && walletRev === 0) {
        // IndexedDB ist mindestens so neu wie der Spiegel: ganz uebernehmen
        ersetzeListeInPlace('vouchers', rec.wallet.vouchers);
        ersetzeListeInPlace('cards', rec.wallet.cards);
        state.wallet.deleted = rec.wallet.deleted || state.wallet.deleted || [];
        if (rec.wallet.statistik) state.wallet.statistik = rec.wallet.statistik;
      } else {
        // Sonst die Daten von hier behalten (Spiegel neuer, oder schon waehrend
        // des Starts etwas geaendert) und Bilder aus IndexedDB holen: mit
        // Fingerabdruck nur, wenn es sicher dasselbe Bild ist; ohne nur, wenn
        // hier gar keins da ist und IndexedDB nicht aelter ist
        for (const it of [...spiegel.vouchers, ...spiegel.cards]) {
          if (!it || it.codeImg || it.img) continue;
          const q = byId.get(it.id);
          if (!q || !(q.codeImg || q.img)) continue;
          if (it.bildSig ? bildSig(q) === it.bildSig : nichtAelter) { it.codeImg = q.codeImg || ''; it.img = q.img || ''; }
        }
        // Was nur IndexedDB kennt (Spiegel konnte nicht geschrieben werden), dazu
        if ((rec.stand || 0) > (Number(spiegel.stand) || 0)) {
          const tot = new Set((state.wallet.deleted || []).map(t => t && t.id));
          const hier = new Set([...spiegel.vouchers, ...spiegel.cards].map(x => x && x.id));
          for (const q of rec.wallet.vouchers || []) if (q && !hier.has(q.id) && !tot.has(q.id)) state.wallet.vouchers.push(q);
          for (const q of rec.wallet.cards || []) if (q && !hier.has(q.id) && !tot.has(q.id)) state.wallet.cards.push(q);
        }
      }
    }
    // Umstieg von der alten Version: erst die volle Wallet sicher in
    // IndexedDB, DANN wird der localStorage zum bildlosen Spiegel — sonst
    // gaebe es kurz keine vollstaendige Kopie mit Bildern
    if (altbestand) {
      try { await walletIdbTx('put', { stand: Date.now(), user: walletBesitzer, wallet: state.wallet }); }
      catch { idbGesperrt = true; }
    }
  })().catch(() => { }).then(() => {
    // Fehlende Bilder holt der naechste Abgleich vom Konto. Nur wenn IndexedDB
    // gesperrt ist, bleiben die Fingerabdruecke stehen (fuer den naechsten Start).
    if (!idbGesperrt) for (const it of [...state.wallet.vouchers, ...state.wallet.cards]) if (it && 'bildSig' in it) delete it.bildSig;
    delete state.wallet.stand; delete state.wallet.user; delete state.wallet.bilderInIdb;
    normalisiereWallet();
    walletHashesNeu();
    walletIstBereit = true;
    speichereWallet(true);
    renderWallet();
    // Alte, grosse Bilder nachkomprimieren — erst nach einem geglueckten
    // Abgleich mit dem Konto (siehe pullWallet), nie auf veraltetem Stand
  });
  return walletBereit;
}
// Das Geraet soll den Speicher nicht bei Platzmangel still leeren duerfen
try { navigator.storage?.persist?.().catch?.(() => { }); } catch { /* egal */ }

// Wallet eines anderen Kontos gehoert nicht in dieses — bei Kontowechsel leeren
function walletZuruecksetzen() {
  // Noch nicht Gesichertes des vorigen Kontos nicht wegwerfen: beiseitelegen
  const alt = walletBesitzer;
  if (alt && (state.wallet.vouchers.length || state.wallet.cards.length) && walletBrauchtUpload()) {
    walletIdbTx('put', { stand: Date.now(), wallet: JSON.parse(JSON.stringify(state.wallet)) }, 'beiseite:' + alt).catch(() => { });
  }
  lsSetzen('ra.origWartend', '[]');
  state.wallet.vouchers = [];
  state.wallet.cards = [];
  state.wallet.deleted = [];
  walletOben = {};
  speichereWalletOben();
  walletHashesNeu();
  try { localStorage.removeItem('ra.walletDirty'); } catch { }
  walletRevOben = walletRev;
  walletBesitzer = state.userName || '';
  speichereWallet(true);
  renderWallet();
}

// ---- Abgleich in kleinen Stuecken ----
// walletOben: pro Eintrag der Stand, den das Konto nachweislich hat. Hochgeladen
// wird nur, was davon abweicht — statt bei jeder Abbuchung die ganze Wallet
// (bei 50 Gutscheinen mit Foto ueber 5 MB) ueber Mobilfunk zu schieben.
function speichereWalletOben() { lsSetzen('ra.walletOben', JSON.stringify(walletOben)); }
function obenHash(it) { return itemHash(it) + '|' + ((it && it.mt) || 0); }
let walletAbgelehnt = new Set(); // vom Konto wegen der Notbremse abgelehnt
function walletBrauchtUpload() {
  if (walletRev > walletRevOben) return true;
  return [...state.wallet.vouchers, ...state.wallet.cards].some(it => it && it.id && !walletAbgelehnt.has(it.id) && walletOben[it.id] !== obenHash(it));
}
// Inhaltsverzeichnis vom Konto: holen, was hier fehlt oder dort neuer ist
async function gleicheMitIndexAb(index, deleted, konto = state.token) {
  // Wurde inzwischen das Konto gewechselt, gehoert diese Antwort nicht hierher
  if (!index || state.token !== konto) return;
  mischeWallet({ vouchers: [], cards: [], deleted: deleted || [] });
  const dirty = !!localStorage.getItem('ra.walletDirty');
  const lokal = new Map([...state.wallet.vouchers, ...state.wallet.cards].filter(Boolean).map(x => [x.id, x]));
  const tombs = {};
  for (const t of state.wallet.deleted || []) if (t && t.id) tombs[t.id] = Math.max(tombs[t.id] || 0, t.ts || 0);
  const brauche = [];
  const aufServer = new Set();
  for (const [id, mt, txn, bild, added] of [...(index.v || []), ...(index.c || [])]) {
    aufServer.add(id);
    const l = lokal.get(id);
    if (!l) { if (!(tombs[id] && tombs[id] >= (added || 0))) brauche.push(id); continue; }
    const lmt = l.mt || 0, ltx = (l.tx || []).length, lbild = !!(l.codeImg || l.img);
    if ((mt || 0) > lmt || ((mt || 0) === lmt && txn > ltx) || (bild && !lbild)) brauche.push(id);
    else if ((mt || 0) < lmt || txn < ltx || (!bild && lbild)) delete walletOben[id]; // dort fehlt etwas: nochmal hoch
    // Erster Abgleich nach dem Update: was offensichtlich gleich ist, muss
    // nicht nochmal hoch (nur wenn hier nichts Ungesichertes wartet)
    else if (!walletOben[id] && !dirty && (mt || 0) === lmt && txn === ltx && !!bild === lbild) walletOben[id] = obenHash(l);
  }
  // Was das Konto nicht (mehr) hat, gilt nicht als gesichert
  for (const id of Object.keys(walletOben)) if (!aufServer.has(id)) delete walletOben[id];
  for (let i = 0; i < brauche.length; i += 25) {
    const r = await api('/api/wallet/items', { method: 'POST', body: JSON.stringify({ ids: brauche.slice(i, i + 25) }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined });
    if (state.token !== konto) return;
    mischeWallet({ vouchers: r.vouchers || [], cards: r.cards || [] }, true);
  }
  speichereWalletOben();
  ensureWalletDates();
  save('wallet', state.wallet, true);
  renderWallet();
}

hydriereWallet();

// Ein anderer Tab hat die Wallet angefasst: Stand uebernehmen, statt mit einer
// veralteten Fassung weiterzuarbeiten und sie spaeter hochzuladen
addEventListener('storage', e => {
  if (e.key === 'ra.walletOben') { walletOben = lsJson('ra.walletOben', {}); return; }
  if (e.key !== 'ra.wallet' || !e.newValue) return;
  let neu;
  try { neu = JSON.parse(e.newValue); } catch { return; }
  if (!neu || !Array.isArray(neu.vouchers) || (Number(neu.stand) || 0) <= walletStand) return;
  // Hat sich der andere Tab mit einem anderen Konto angemeldet, passt hier
  // nichts mehr zusammen — neu laden statt Wallets zu vermischen
  if (neu.user && walletBesitzer && neu.user !== walletBesitzer) { location.reload(); return; }
  const vorher = walletBereit;
  walletBereit = vorher.then(() => uebernimmSpiegel(neu)).catch(() => { });
});
async function uebernimmSpiegel(neu) {
  // Bilder: aus dem eigenen Stand, wenn es dasselbe Bild ist, sonst aus
  // IndexedDB (der andere Tab schreibt dort kurz nach dem Spiegel)
  const bisher = new Map([...state.wallet.vouchers, ...state.wallet.cards].filter(Boolean).map(x => [x.id, x]));
  const alle = [...neu.vouchers, ...(neu.cards || [])].filter(Boolean);
  for (const it of alle) {
    if (!it.bildSig) continue;
    const b = bisher.get(it.id);
    if (b && bildSig(b) === it.bildSig) { it.codeImg = b.codeImg || ''; it.img = b.img || ''; delete it.bildSig; }
  }
  for (let i = 0; i < 20 && alle.some(x => x.bildSig); i++) {
    const rec = await walletIdbTx('get').catch(() => null);
    if (rec && rec.wallet && (rec.stand || 0) >= (Number(neu.stand) || 0)) {
      const byId = new Map([...(rec.wallet.vouchers || []), ...(rec.wallet.cards || [])].filter(Boolean).map(x => [x.id, x]));
      for (const it of alle) {
        const q = it.bildSig && byId.get(it.id);
        if (q && bildSig(q) === it.bildSig) { it.codeImg = q.codeImg || ''; it.img = q.img || ''; delete it.bildSig; }
      }
      break;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  alle.forEach(it => { delete it.bildSig; }); // Rest holt der naechste Abgleich vom Konto
  // An Ort und Stelle uebernehmen: ein offenes Blatt bucht weiter aufs richtige Objekt
  ersetzeListeInPlace('vouchers', neu.vouchers);
  ersetzeListeInPlace('cards', neu.cards || []);
  state.wallet.deleted = neu.deleted || [];
  walletStand = Math.max(walletStand, Number(neu.stand) || 0);
  if (neu.user) walletBesitzer = neu.user;
  walletOben = lsJson('ra.walletOben', {});
  walletHashesNeu();
  if (state.activeView === 'wallet') renderWallet();
}
let folgeSyncs = 0;
async function syncWalletNow() {
  if (!state.token) return true;
  // Laeuft schon ein Upload, wartet man auf ihn. Enthielt er die eigene
  // Aenderung noch nicht, folgt ein eigener Durchgang.
  if (walletSyncInFlight) {
    const meineRev = walletRev;
    try { await walletSyncInFlight; } catch { /* unten entschieden */ }
    if (walletRevOben >= meineRev) return true;
    return syncWalletNow();
  }
  walletSyncInFlight = (async () => {
    renderSyncBadge();
    try {
      // Erst wenn die Bilder aus IndexedDB da sind — sonst ginge die Fassung
      // ohne Bilder hoch
      await walletBereit;
      const konto = state.token;
      const revBeimStart = walletRev;
      markWalletChanges();
      // Nur, was das Konto noch nicht genau so hat
      const offen = [
        ...state.wallet.vouchers.filter(it => it && it.id && !walletAbgelehnt.has(it.id) && walletOben[it.id] !== obenHash(it)).map(it => ['v', it]),
        ...state.wallet.cards.filter(it => it && it.id && !walletAbgelehnt.has(it.id) && walletOben[it.id] !== obenHash(it)).map(it => ['c', it]),
      ];
      // In Paketen bis ~1,5 MB: reisst die Verbindung ab, bleibt Geschafftes geschafft
      const pakete = [];
      let akt = [], groesse = 0;
      for (const [typ, it] of offen) {
        const laenge = JSON.stringify(it).length;
        if (akt.length && groesse + laenge > 1_500_000) { pakete.push(akt); akt = []; groesse = 0; }
        akt.push({ typ, it, hash: obenHash(it), laenge });
        groesse += laenge;
      }
      pakete.push(akt); // auch leer: Loeschmarker und Inhaltsverzeichnis
      let antwort = null;
      for (const paket of pakete) {
        const bytes = paket.reduce((n, p) => n + p.laenge, 0);
        // Grosszuegig, aber nie endlos: ~15 KB/s im schlechtesten Mobilfunk
        const ms = Math.max(45000, Math.round(bytes / 15));
        const signal = AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
        // bildSig ist nur fuer dieses Geraet — nie mitschicken
        const ohneSig = it => ('bildSig' in it ? (({ bildSig, ...rest }) => rest)(it) : it);
        const body = {
          delta: true,
          vouchers: paket.filter(p => p.typ === 'v').map(p => ohneSig(p.it)),
          cards: paket.filter(p => p.typ === 'c').map(p => ohneSig(p.it)),
          deleted: state.wallet.deleted || [],
        };
        antwort = await api('/api/wallet', { method: 'POST', body: JSON.stringify(body), signal });
        // Kontowechsel unterwegs: nichts mehr von diesem Durchgang uebernehmen
        if (state.token !== konto) return true;
        for (const p of paket) walletOben[p.it.id] = p.hash;
        // Ueber der Notbremse abgelehnt: bleibt auf dem Geraet, wird aber nicht
        // in einer Schleife immer wieder hochgeladen
        if (antwort && Array.isArray(antwort.abgelehnt) && antwort.abgelehnt.length) {
          walletAbgelehnt = new Set([...walletAbgelehnt, ...antwort.abgelehnt]);
          island(`${antwort.abgelehnt.length} Einträge passen nicht mehr ans Konto — bitte aufräumen`);
        }
        speichereWalletOben();
      }
      if (antwort && antwort.statistik) state.wallet.statistik = antwort.statistik;
      if (antwort && antwort.delta) await gleicheMitIndexAb(antwort.index, antwort.deleted, konto);
      else if (antwort && antwort.merged) {
        mischeWallet(antwort, true);
        ensureWalletDates();
        save('wallet', state.wallet, true);
        renderWallet();
      } else if (antwort && antwort.deleted) {
        mischeLoeschmarker(antwort.deleted);
        save('wallet', state.wallet, true);
      }
      walletRevOben = Math.max(walletRevOben, revBeimStart);
      walletSyncError = '';
      walletSyncFatal = false;
      walletRetryDelay = 1500; // Backoff zurücksetzen
      clearTimeout(walletRetryTimer);
      if (walletRev !== revBeimStart) {
        setTimeout(syncWalletNow, 0); // Waehrenddessen Geaendertes gleich hinterher
      } else if (walletBrauchtUpload()) {
        // Unterschiede nur durch den Abgleich: ein paar Mal nachfassen, nie endlos
        lsSetzen('ra.walletDirty', '1');
        if (folgeSyncs++ < 3) setTimeout(syncWalletNow, 1500);
      } else {
        folgeSyncs = 0;
        try { localStorage.removeItem('ra.walletDirty'); } catch { }
      }
      if (origWartend().length) origHochladen();
      return true;
    } catch (e) {
      walletSyncError = e.name === 'TimeoutError' || e.name === 'AbortError'
        ? 'Das Sichern dauert zu lange (Verbindung zu langsam?).'
        : (e.message || '');
      walletSyncFatal = e.status >= 400 && e.status < 500;
      lsSetzen('ra.walletDirty', '1');
      // Schnell nachfassen statt aufs 30s-Intervall zu warten: die PWA hat nach
      // dem Aufwachen oft 1-2s kein Netz, der erste Versuch scheitert dann leise
      if (!walletSyncFatal) {
        walletRetryDelay = Math.min(24000, walletRetryDelay * 2);
        clearTimeout(walletRetryTimer);
        walletRetryTimer = setTimeout(() => {
          if (state.token && (localStorage.getItem('ra.walletDirty') || walletRev > walletRevOben)) syncWalletNow();
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
    lsSetzen('ra.walletDirty', '1'); // klappt es nicht, zaehlt walletRev trotzdem
    clearTimeout(walletSyncTimer);
    walletSyncTimer = setTimeout(syncWalletNow, 800);
  }
}
// Nachzügler-Sync: sobald wieder Netz da ist, die App aufwacht/in den Vordergrund
// kommt (PWA!) oder regelmäßig im Hintergrund
function syncIfDirty() {
  if (state.token && (localStorage.getItem('ra.walletDirty') || walletRev > walletRevOben)) syncWalletNow();
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
// Sichern laeuft still: ein kleiner Punkt neben der Gutschein-Zahl dreht sich,
// wird zum Haken und verblasst. Ein Banner braucht dafuer niemand.
function renderSyncBadge() {
  const el = $('#sync-punkt');
  if (!el) return;
  if (!state.token) { el.className = 'sync-punkt'; return; }
  if (walletSyncInFlight) {
    el.className = 'sync-punkt laeuft';
    el.title = 'Sichere am Konto …';
  } else if (localStorage.getItem('ra.walletDirty')) {
    el.className = 'sync-punkt offen';
    el.title = 'Noch nicht gesichert';
  } else if (el.classList.contains('laeuft')) {
    // Nur direkt nach einem Sicherungslauf den Haken zeigen, dann ausblenden
    el.className = 'sync-punkt fertig';
    el.title = 'Gesichert';
    setTimeout(() => { if (el.classList.contains('fertig')) el.className = 'sync-punkt'; }, 1800);
  } else {
    el.className = 'sync-punkt';
    el.title = '';
  }
}
// Stand vom Konto mit dem Stand hier vereinigen — pro ID, nie blind ersetzen.
// Konflikt: zuletzt bearbeitete Fassung gewinnt, sonst die mit mehr Buchungen.
// Ein Bild geht dabei nie verloren: fehlt es der Gewinner-Fassung, kommt es
// von der anderen (die Fassung ohne Bilder aus dem vollen Handyspeicher darf
// die Bilder am Konto nicht ueberschreiben). Gibt zurueck, ob dieses Geraet
// etwas hat, das dem Konto noch fehlt.
function mischeLoeschmarker(fremde) {
  const tombs = {};
  for (const t of [...(state.wallet.deleted || []), ...(fremde || [])]) {
    if (t && t.id) tombs[t.id] = Math.max(tombs[t.id] || 0, t.ts || 0);
  }
  state.wallet.deleted = Object.entries(tombs).sort((x, y) => x[1] - y[1])
    .slice(-LOESCHMARKER_MAX).map(([id, ts]) => ({ id, ts }));
  return tombs;
}
// Buchungen, die nur die andere Fassung kennt (zweites Geraet hat offline
// abgebucht), gehen nicht verloren: sie werden nachgetragen. Ebenso ein
// Rueckgaengig, das nur dort passiert ist. Gleiche Regel wie auf dem Server.
function mischeBuchungen(sieger, anderer) {
  const st = Array.isArray(sieger.tx) ? sieger.tx : [];
  const at = Array.isArray(anderer.tx) ? anderer.tx : [];
  if (!at.length) return sieger;
  const byId = new Map(st.filter(t => t && t.id).map(t => [t.id, t]));
  let tx = st.slice();
  let balance = sieger.balance;
  let geaendert = false;
  for (const t of at) {
    if (!t || !t.id || typeof t.amt !== 'number') continue;
    const s = byId.get(t.id);
    if (!s) {
      tx.push({ ...t });
      geaendert = true;
      if (!t.reverted && typeof balance === 'number') balance = Math.round((balance + t.amt) * 100) / 100;
    } else if (t.reverted && !s.reverted) {
      tx = tx.map(x => (x === s ? { ...s, reverted: true } : x));
      geaendert = true;
      if (typeof balance === 'number') balance = Math.round((balance - s.amt) * 100) / 100;
    }
  }
  if (!geaendert) return sieger;
  tx.sort((x, y) => (y.ts || 0) - (x.ts || 0));
  return { ...sieger, tx, balance };
}
// Bild der Fassung mit dem juengeren Bild-Zeitstempel (bildMt) — unabhaengig
// davon, welche Fassung sonst gewinnt
function neuesBild(sieger, anderer) {
  // Nur eine Fassung, die wirklich ein Bild hat, setzt es durch
  if ((anderer.bildMt || 0) <= (sieger.bildMt || 0) || !(anderer.codeImg || anderer.img)) return sieger;
  return { ...sieger, codeImg: anderer.codeImg || '', img: anderer.img || '', bildMt: anderer.bildMt,
    ...(anderer.orig ? { orig: anderer.orig } : {}) };
}
// vomKonto = true: remote ist nachweislich der Stand am Konto (dann wird
// gemerkt, welche Eintraege dort genau so liegen und nicht wieder hoch muessen)
function mischeWallet(remote, vomKonto = false) {
  const tombs = mischeLoeschmarker(remote.deleted);
  const mitBild = (sieger, anderer) => (sieger && anderer && !sieger.codeImg && !sieger.img && (anderer.codeImg || anderer.img))
    ? { ...sieger, codeImg: anderer.codeImg || '', img: anderer.img || '' } : sieger;
  const mergeById = (local = [], srv = []) => {
    const srvBy = new Map(srv.filter(x => x && x.id).map(x => [x.id, x]));
    const out = local.filter(Boolean).map(l => {
      const sv = srvBy.get(l.id);
      if (!sv) return l;
      srvBy.delete(l.id);
      let sieger;
      if ((sv.mt || 0) !== (l.mt || 0)) sieger = (sv.mt || 0) > (l.mt || 0) ? sv : l;
      else sieger = ((sv.tx || []).length > (l.tx || []).length) ? sv : l;
      const anderer = sieger === sv ? l : sv;
      const mb = mischeBuchungen(neuesBild(sieger, anderer), anderer);
      let r = mitBild(mb, anderer);
      if (mb !== sieger) r = { ...r, mt: Math.max(l.mt || 0, sv.mt || 0) + 1 };
      if (r !== l) ersetzeInhalt(l, r === sv ? { ...sv } : r);
      walletHashes[l.id] = itemHash(l);
      if (vomKonto && obenHash(l) === obenHash(sv)) walletOben[l.id] = obenHash(l);
      return l;
    });
    for (const sv of srvBy.values()) {
      walletHashes[sv.id] = itemHash(sv);
      if (vomKonto) walletOben[sv.id] = obenHash(sv);
      out.push(sv);
    }
    return out.filter(it => !(tombs[it.id] && tombs[it.id] >= Math.max(it.added || 0, it.wiederbelebt || 0)));
  };
  const dedupeById = list => { const seen = new Set(); return list.filter(x => x && x.id && !seen.has(x.id) && seen.add(x.id)); };
  state.wallet.vouchers = dedupeById(mergeById(state.wallet.vouchers, remote.vouchers || []));
  state.wallet.cards = dedupeById(mergeById(state.wallet.cards, remote.cards || []));
}
async function pullWallet() {
  if (!state.token) return;
  try {
    await walletBereit;
    const konto = state.token;
    // Nur das Inhaltsverzeichnis: geholt wird, was hier fehlt oder dort neuer ist
    const remote = await api('/api/wallet?nur=index');
    if (state.token !== konto) return; // Kontowechsel unterwegs
    if (remote.statistik) state.wallet.statistik = remote.statistik;
    // Anzeigenamen der Schenkenden ("Geschenk von …"); aendert sich einer,
    // wird die Wallet unten neu gezeichnet
    const schenker = [...state.wallet.vouchers, ...(remote.gifts || [])].map(v => v && v.giftFrom).filter(Boolean);
    const namenNeu = merkeNamen(remote.namen, schenker);
    // Der Abgleich per Inhaltsverzeichnis speichert und zeichnet selbst — hier
    // nicht noch einmal (vorher lief renderWallet dafuer zweimal direkt hintereinander)
    if (remote.index) await gleicheMitIndexAb(remote.index, remote.deleted, konto);
    else mischeWallet(remote, true); // alter Server: volle Wallet
    if (state.token !== konto) return;
    if (!remote.index) {
      ensureWalletDates(); // auch vom Konto gezogene Alt-Gutscheine kriegen ein Datum
      save('wallet', state.wallet, true);
      renderWallet();
    } else if (namenNeu) renderWallet();
    // Nur hochladen, wenn dieses Geraet etwas beisteuert
    if (walletBrauchtUpload()) syncWalletNow();
    // Jetzt ist der Stand frisch: einmal pro Sitzung alte Bilder nachkomprimieren
    if (!pullWallet.bestandLief && !idbGesperrt) {
      pullWallet.bestandLief = true;
      setTimeout(() => verkleinereBestand().catch(() => { }), 4000);
    }
    // Geschenke werden NICHT still eingebucht: sie warten auf der Geschenkseite,
    // bis der Empfänger sie dort auspackt. Erst die Öffnungs-Zeremonie bucht den
    // Gutschein ein und hakt ihn beim Server ab — bis dahin bleibt er serverseitig.
    const serverGifts = (remote.gifts || []).filter(g => !state.wallet.vouchers.some(v => v.id === g.id));
    const fresh = serverGifts.filter(g => !pendingGifts.some(p => p.id === g.id));
    pendingGifts = serverGifts;
    updateGiftBadges();
    if (state.activeView === 'gifts') renderGiftsPage();
    if (fresh.length) {
      playSfx('plop'); buzz([30, 30]);
      const g = fresh[0];
      showToast({
        title: fresh.length === 1 ? `Geschenk von ${anzeigeOderAt(g.giftFrom)}!` : `${fresh.length} neue Geschenke!`,
        text: 'Es wartet auf der Geschenkseite auf dich.',
        iconName: 'gift', success: true,
        actions: [{ label: 'Auspacken', fn: () => switchView('gifts', 'enter-drop') }],
      }, 9000);
    }
  } catch { }
}

// ---- Geschenke warten auf einer eigenen Seite (Dropdown: "Geschenke"), bis man
// sie auspackt. Zähler-Pill im Menü + Punkt am Profil-Knopf zeigen den Vorrat.
let pendingGifts = [];
function updateGiftBadges() {
  const btn = $('#btn-profile-top');
  if (!btn) return;
  let dot = btn.querySelector('.gift-dot');
  if (pendingGifts.length) {
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'gift-dot';
      btn.appendChild(dot);
    }
    dot.textContent = pendingGifts.length;
  } else if (dot) dot.remove();
}
// Leer: mittig eine ganze Figur, grau und blass als Platzhalter (Sammler, mit
// Gutscheinen in der Hand), darunter ein kurzer Satz. Sonst weisse Karten.
function renderGiftsPage() {
  const host = $('#gifts-page');
  if (!host) return;
  if (!pendingGifts.length) {
    if (host.querySelector('.gifts-leer')) return; // steht schon, nicht neu einblenden
    host.innerHTML = `
      <div class="gifts-leer">
        <img class="gifts-leer-bild" src="/brand/kumulio-rang-scout-480.webp" width="200" height="200" alt="" decoding="async" draggable="false">
        <b>Gerade wartet hier kein Geschenk</b>
        <p>Schenkt dir ein Freund einen Gutschein, liegt er hier, bis du ihn auspackst.</p>
      </div>`;
    return;
  }
  const wann = ts => {
    if (!ts) return '';
    const d = new Date(ts), heute = new Date();
    const gestern = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate() - 1);
    const uhr = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === heute.toDateString()) return `Heute, ${uhr}`;
    if (d.toDateString() === gestern.toDateString()) return `Gestern, ${uhr}`;
    return `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })}, ${uhr}`;
  };
  host.innerHTML = `
    <p class="gifts-intro">Hier warten Geschenke von Freunden, bis du sie auspackst.</p>
    ${pendingGifts.map(g => `
    <button class="gift-row" type="button" data-gift-open="${esc(g.id)}">
      <span class="gift-row-bild" aria-hidden="true">${icon('gift', 'icon')}</span>
      <span class="gift-row-info">
        <b>Von ${esc(anzeigeOderAt(g.giftFrom))}</b>
        <span class="muted">${wann(g.giftTs)}</span>
      </span>
      <span class="btn btn-small">Auspacken</span>
    </button>`).join('')}`;
  host.querySelectorAll('[data-gift-open]').forEach(b => b.onclick = () => {
    const gift = pendingGifts.find(g => g.id === b.dataset.giftOpen);
    if (gift) openGiftReveal(gift);
  });
}
function openGiftReveal(gift) {
  // Beim Auspacken stehen Code und PIN offen da — mit gesperrter Wallet erst
  // die PIN (bzw. Face ID)
  if (walletGesperrt()) { walletFreigeben().then(ok => { if (ok) openGiftReveal(gift); }); return; }
  const wrap = document.createElement('div');
  wrap.className = 'overlay gift-overlay';
  wrap.innerHTML = `
    <div class="modal case-modal gift-stage">
      <button class="fav-remove" id="gr-close" aria-label="Später auspacken">${icon('x', 'icon icon-sm')}</button>
      <img class="gift-box${reducedMotion() ? '' : ' wiggling'}" src="/gamification/gift.svg" width="110" height="110" alt="Geschenk von ${esc(anzeigeOderAt(gift.giftFrom))}">
      <div class="gift-flash" aria-hidden="true"></div>
      <p class="gift-hint">Ein Geschenk von <b>${esc(anzeigeOderAt(gift.giftFrom))}</b>. Antippen zum Auspacken!</p>
      <div class="gift-result hidden">
        <div class="offer-cat">Geschenk von ${esc(anzeigeOderAt(gift.giftFrom))}</div>
        <div class="schenk-karte auspack-karte" id="auspack-karte">${istRabatt(gift) ? rabattCardHtml(gift, { schau: true }) : voucherCardHtml(gift)}</div>
        ${gift.giftMsg ? `<div class="gift-bubble">${withEmotes(esc(gift.giftMsg))}<span class="gift-by">— ${esc(anzeigeOderAt(gift.giftFrom))}</span></div>` : ''}
        <button class="btn btn-big" id="gr-done" style="margin-top:14px">In die Wallet</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  let opened = false;
  // Ein Rabattcode landet unter "Karten & Coupons" — dorthin geht es danach
  let eingebuchtId = '';
  const abort = () => {
    // Nach dem Auspacken ist das Geschenk schon eingebucht: einfach schließen.
    // Vor dem Auspacken abgebrochen: es bleibt serverseitig und auf der
    // Geschenkseite liegen und kann jederzeit wieder angetippt werden.
    wrap.remove();
  };
  wrap.querySelector('#gr-close').onclick = abort;
  wrap.addEventListener('click', e => { if (e.target === wrap) abort(); });
  const box = wrap.querySelector('.gift-box');
  box.style.cursor = 'pointer';
  box.addEventListener('click', () => {
    if (opened) return;
    // Alter Tab, altes Popup: Wenn das Geschenk laengst eingebucht ist (oder
    // nicht mehr im Server-Vorrat wartet), gibt es KEINE zweite Gutschrift
    if (state.wallet.vouchers.some(v => v.id === gift.id) || !pendingGifts.some(g => g.id === gift.id)) {
      wrap.remove();
      pendingGifts = pendingGifts.filter(g => g.id !== gift.id);
      updateGiftBadges();
      if (state.activeView === 'gifts') renderGiftsPage();
      island('Dieses Geschenk ist schon in deiner Wallet');
      return;
    }
    opened = true;
    playSfx('wow', 0.3); // der volle WOW-Moment, aber gedaempft
    buzz(30);
    if (!reducedMotion()) {
      box.classList.remove('wiggling');
      box.classList.add('opening');
      wrap.querySelector('.gift-flash').classList.add('go');
    } else {
      box.classList.add('hidden');
    }
    setTimeout(() => {
      box.classList.add('hidden');
      wrap.querySelector('.gift-hint').classList.add('hidden');
      const res = wrap.querySelector('.gift-result');
      res.classList.remove('hidden');
      if (!reducedMotion()) {
        res.classList.add('fade-up');
        // Die Karte kommt aus der Schachtel heraus — dieselbe Bewegung wie
        // beim Einpacken, nur andersherum.
        packAnimation(wrap.querySelector('#auspack-karte'), 'aus');
      }
    }, reducedMotion() ? 0 : 430);
    // ERST beim Server abholen, dann gutschreiben. Der Server gibt nur einmal
    // frei — ein zweiter offener Tab kann dasselbe Geschenk nicht nochmal holen.
    pendingGifts = pendingGifts.filter(g => g.id !== gift.id);
    updateGiftBadges();
    (async () => {
      let frei = true;
      let vomServer = null;
      const konto = state.token;
      try {
        const r = await api('/api/gift/claim', { method: 'POST', body: JSON.stringify({ ids: [gift.id] }) });
        // Konto unterwegs gewechselt: der Gutschein liegt schon in der Wallet
        // am richtigen Konto — nicht in die jetzt offene uebernehmen
        if (state.token !== konto) { wrap.remove(); return; }
        frei = Array.isArray(r.claimed) ? r.claimed.includes(String(gift.id)) : true;
        vomServer = Array.isArray(r.vouchers) ? r.vouchers : null;
      } catch (e) {
        // Kein Netz oder Wallet voll: das Geschenk liegt weiter sicher auf dem
        // Server und wartet. Hier NICHT einbuchen — sonst gaebe es es spaeter doppelt.
        pendingGifts = [gift, ...pendingGifts.filter(g => g.id !== gift.id)];
        updateGiftBadges();
        wrap.remove();
        if (e && e.status) showToast({ title: 'Geschenk wartet', text: e.message, iconName: 'warning' }, 9000);
        else {
          island('Keine Verbindung. Das Geschenk wartet sicher, versuch es gleich nochmal.');
          // Kam nur die Antwort nicht an, liegt es schon am Konto: beim naechsten
          // Netz nachsehen
          setTimeout(() => pullWallet(), 4000);
        }
        return;
      }
      if (!frei) {
        island('Dieses Geschenk hast du schon geöffnet');
        renderGiftsPage?.();
        pullWallet(); // liegt schon am Konto — gleich hier anzeigen
        return;
      }
      if (vomServer) {
        // Der Server hat das Geschenk schon in die Wallet am Konto gelegt —
        // es kann also nicht mehr verloren gehen. Hier nur uebernehmen.
        mischeWallet({ vouchers: vomServer }, true);
        ensureWalletDates();
        save('wallet', state.wallet, true);
        vomServer.forEach(zeigeNeuenGutschein);
        eingebuchtId = vomServer[0]?.id || gift.id;
        renderWallet();
        return;
      }
      eingebuchtId = gift.id;
      state.wallet.vouchers.unshift({ ...gift, added: Date.now(), giftSeen: true });
      ensureWalletDates();
      saveWallet();
      syncWalletNow();
    })();
  });
  wrap.addEventListener('click', e => {
    if (e.target.id === 'gr-done') {
      wrap.remove();
      if (istRabatt(gift) && eingebuchtId) { zeigeRabattcodes(eingebuchtId); return; }
      if (state.activeView === 'gifts') renderGiftsPage(); // das nächste wartet in der Liste
    }
  });
}
// Mit Tausenderpunkt: ab 1000 € (Rang Majestät) sonst "1215,00 €"
function euroFmt(n) { return n == null ? '' : n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' €'; }

// ---- Spielgefühl: Sounds, Vibration, Aufleuchten, Geldscheine, Zähl-Animation ----

const SFX = { kaching: '/sounds/kaching.mp3', plop: '/sounds/plop.mp3', coin: '/sounds/coin.mp3', error: '/sounds/error.mp3', wow: '/sounds/wow.mp3', wowShort: '/sounds/wow-short.mp3', anmelden: '/sounds/anmelden.mp3', abbuchen: '/sounds/abbuchen.mp3' };
// Ton ist Opt-in: alle Effekte bleiben stumm, bis der Schalter in den Einstellungen an ist
// (function statt const: wird auch weiter oben im Skript schon beim Laden gebraucht)
function soundOn() { return localStorage.getItem('ra.sound') === '1'; }
// WebAudio: Sounds vorgeladen und ohne Anlauf-Stille, spielen sofort beim Tipp.
//
// Runde 121 — warum der Anmeldeton nicht bei jedem Start kam: der Ton-Motor
// wurde erst beim ersten Antippen gebaut, und zwar im pointerdown. Am iPhone
// zaehlt ein Finger-pointerdown aber nicht als "Nutzer hat getippt", der Motor
// blieb stumm (suspended); die Dateien wurden ausserdem erst dann geladen.
// Nach vier schnellen PIN-Tipps war der Anmeldeton oft noch nicht da, und der
// Ersatzweg (Audio-Element) lief nach der PIN-Pruefung schon ausserhalb des
// Tipps und wurde geblockt. Jetzt: Dateien gleich beim Start laden (nur die
// Bytes, ohne Motor), Motor beim ersten echten Tipp (pointerup/touchend/
// keydown/click) bauen und bei jedem weiteren Tipp wecken, falls er schlaeft.
let sfxCtx = null;
const sfxBuffers = {};
const sfxRoh = {};
function sfxVorladen() {
  if (sfxVorladen.laeuft) return;
  sfxVorladen.laeuft = true;
  // Der Anmeldeton zuerst: er kommt schon nach der ersten PIN
  const reihe = Object.entries(SFX).sort(([a], [b]) => (b === 'anmelden') - (a === 'anmelden'));
  for (const [k, url] of reihe) {
    sfxRoh[k] = fetch(url).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null);
  }
}
function sfxDekodieren(k) {
  if (!sfxCtx || sfxBuffers[k] || !sfxRoh[k]) return;
  sfxRoh[k].then(raw => raw && sfxCtx.decodeAudioData(raw.slice(0))).then(audio => {
    if (!audio || sfxBuffers[k]) return;
    const d = audio.getChannelData(0);
    let i = 0; while (i < d.length && Math.abs(d[i]) < 0.02) i++;
    sfxBuffers[k] = { audio, offset: i / audio.sampleRate };
  }).catch(() => { });
}
function initSfx() {
  sfxVorladen();
  if (sfxCtx) return;
  try { sfxCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
  Object.keys(SFX).forEach(sfxDekodieren);
}
// Bei jedem echten Tipp: Motor bauen bzw. aufwecken. Ein stiller Mini-Klang
// entsperrt aeltere iPhones endgueltig.
function sfxWecken() {
  if (!soundOn()) return;
  initSfx();
  if (!sfxCtx || sfxCtx.state === 'running') return;
  try {
    sfxCtx.resume().catch(() => { });
    const leer = sfxCtx.createBufferSource();
    leer.buffer = sfxCtx.createBuffer(1, 1, 22050);
    leer.connect(sfxCtx.destination);
    leer.start(0);
  } catch { }
}
for (const t of ['pointerup', 'touchend', 'keydown', 'click']) document.addEventListener(t, sfxWecken, { capture: true, passive: true });
if (soundOn()) sfxVorladen();
function playSfx(name, vol) {
  if (!soundOn()) return { stop() { } };
  const b = sfxBuffers[name];
  if (sfxCtx && sfxCtx.state === 'suspended') sfxCtx.resume().catch(() => { });
  if (sfxCtx && b && sfxCtx.state === 'running') {
    try {
      const src = sfxCtx.createBufferSource();
      src.buffer = b.audio;
      const gain = sfxCtx.createGain();
      gain.gain.value = vol ?? 0.6;
      src.connect(gain); gain.connect(sfxCtx.destination);
      src.start(0, b.offset);
      return { stop() { try { src.stop(); } catch { } } };
    } catch { }
  }
  try {
    const a = new Audio(SFX[name]); a.volume = Math.min(1, vol ?? 0.55); a.play().catch(() => { });
    return { stop() { try { a.pause(); } catch { } } };
  } catch { }
  return { stop() { } };
}
function buzz(pattern) { try { navigator.vibrate && navigator.vibrate(pattern); } catch { } }

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.classList.contains('ohne-anim');

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

// ---- Ränge nach dem Guthaben in der Wallet, wie beim Chamäleon ----
// Privat: Rang-Name, Stufe und Abstand stehen nur in der eigenen Wallet, im
// eigenen Profil und in der Seitenleiste. Andere sehen oeffentliche Profile
// nur in der Farbe der Stufe (server.js rangStufe — dort dieselben Grenzen).
// bis = Obergrenze in Euro (inklusive), min = erster Cent-Betrag der Stufe
// ("über 10 €" heisst ab 10,01 €). slug ist der Schluessel fuer Farben
// (.wallet-kopf.tier-N in style.css) und die Maskottchen-Modelle je Rang.
// Runde 119: neue Namen vom Nutzer, dazu Stufe 7 ab 1000 € (Gold).
// Runde 125: Farben nach den CS-Skin-Seltenheiten (Consumer … Contraband).
const RANKS = [
  { tier: 1, slug: 'scout', name: 'Scout', min: 0, bis: 10 },
  { tier: 2, slug: 'sammler', name: 'Sammler', min: 10.01, bis: 50 },
  { tier: 3, slug: 'profi', name: 'Profi', min: 50.01, bis: 150 },
  { tier: 4, slug: 'champion', name: 'Champion', min: 150.01, bis: 300 },
  { tier: 5, slug: 'meister', name: 'Meister', min: 300.01, bis: 600 },
  { tier: 6, slug: 'legende', name: 'Legende', min: 600.01, bis: 1000 },
  { tier: 7, slug: 'mythos', name: 'Majestät', min: 1000.01, bis: Infinity },
];
function rankFor(total) {
  // In Cent vergleichen: 10,01 ist als Kommazahl nicht exakt
  const cent = Math.round((Number(total) || 0) * 100);
  let cur = RANKS[0];
  for (const r of RANKS) if (cent >= Math.round(r.min * 100)) cur = r;
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

// ---------------- Bilder klein, aber scharf ----------------
// Gutscheinbilder so klein wie moeglich speichern, ohne dass man es sieht:
// WebP, wo das Geraet es erzeugen kann (bei gleicher Qualitaet rund ein
// Drittel kleiner als JPEG), sonst JPEG. Dazu ein Groessenziel je Bildart:
// wird es gerissen, sinkt erst die Qualitaet in kleinen Schritten, dann die
// Aufloesung — Kassen-Codes behalten dabei immer genug Pixel zum Scannen.
// ziel = Laenge der data-URL in Zeichen (~ 3/4 davon sind echte Bytes).
const BILD_PROFILE = {
  code: { maxSeite: 1200, q: 0.85, qMin: 0.75, ziel: 70_000, minSeite: 900 },       // Barcode/QR fuer die Kasse
  foto: { maxSeite: 1600, q: 0.8, qMin: 0.66, ziel: 190_000, minSeite: 1200 },      // ganzes Foto (Kleingedrucktes lesbar)
  vorschau: { maxSeite: 900, q: 0.8, qMin: 0.7, ziel: 80_000, minSeite: 800 },      // Bild ohne Zuschnitt
  // Bestand nachkomprimieren: gleiche Aufloesung, nur anderes Format bzw.
  // Qualitaet — ein Bild wird dabei nie kleiner in Pixeln
  bestand: { maxSeite: 1600, q: 0.85, qMin: 0.85, ziel: Infinity, minSeite: 1600 },
};
let webpGeht = null;
function kannWebp() {
  if (webpGeht === null) {
    // iPhones (Safari/WebKit) liefern statt WebP stillschweigend PNG — das waere
    // riesig. Deshalb pruefen, was wirklich herauskommt.
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 4;
      webpGeht = c.toDataURL('image/webp', 0.8).startsWith('data:image/webp');
    } catch { webpGeht = false; }
  }
  return webpGeht;
}
// quelle: Bild oder Canvas. Liefert eine data-URL (WebP oder JPEG).
function kodiereBild(quelle, profil = 'code', maxSeite = 0) {
  const p = BILD_PROFILE[profil] || BILD_PROFILE.code;
  const qw = quelle.naturalWidth || quelle.width, qh = quelle.naturalHeight || quelle.height;
  if (!qw || !qh) throw new Error('Bild leer');
  const typ = kannWebp() ? 'image/webp' : 'image/jpeg';
  let seite = Math.min(maxSeite || p.maxSeite, p.maxSeite, Math.max(qw, qh));
  let beste = '';
  for (let runde = 0; runde < 4; runde++) {
    const s = seite / Math.max(qw, qh);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(qw * s));
    c.height = Math.max(1, Math.round(qh * s));
    const g = c.getContext('2d');
    // Weisser Grund: Transparenz wuerde sonst schwarz, und Scanner lesen
    // dunkle Codes auf weiss am besten
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(quelle, 0, 0, c.width, c.height);
    for (let q = p.q; q >= p.qMin - 1e-9; q -= 0.05) {
      const url = c.toDataURL(typ, q);
      if (!url || url.length < 100) throw new Error('Bild zu groß'); // Canvas-Grenze (iPhone)
      if (!beste || url.length < beste.length) beste = url;
      if (url.length <= p.ziel) return url;
    }
    if (seite <= p.minSeite) break;
    seite = Math.max(p.minSeite, Math.round(seite * 0.8));
  }
  return beste;
}

// Screenshot (QR/Barcode) einlesen und verkleinern. Mit profil: fuers
// Speichern (klein und scharf), ohne: fuer die Texterkennung (hohe Qualitaet)
function readImageFile(file, max = 900, quality = 0.82, profil = '') {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        if (profil) { resolve(kodiereBild(img, profil, max)); return; }
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * scale);
        cv.height = Math.round(img.height * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        const out = cv.toDataURL('image/jpeg', quality);
        // Zu grosses Canvas (iPhone-Grenze) liefert ein leeres Bild statt eines Fehlers
        if (!out || out.length < 100) throw new Error('Bild zu groß');
        resolve(out);
      } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
    };
    img.onerror = e => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); island('Kopiert'); }
  catch { island('Kopieren nicht möglich'); }
}

// ---- Hinzufügen (großes Plus -> Sheet)
let addImg = '';
// Das ganze Foto in besserer Aufloesung (fuers Original im Bildbetrachter).
// Faehrt nicht in der Wallet mit, siehe origSichern.
let addOrig = '';
let waAutoWerte = {}; // Felder, die der letzte Scan ausgefuellt hat: { selektor: wert }
let waScanLauf = 0;   // nur der juengste Scan darf das Formular fuellen
let addType = 'voucher';
let addPrefill = '';
let addCodeImg = ''; // ausgeschnittener Kassen-Code (falls der Scanner ihn findet)
let addEditId = '';  // gesetzt, wenn eine vorhandene Sparkarte geaendert wird

// Doppelte Gutscheine: gleiche PIN beim gleichen Shop oder gleicher Code
// Duplikat nur, wenn es wirklich derselbe ist: gleicher Shop UND gleiche PIN,
// oder gleiche Kartennummer beim selben Shop (bzw. eine lange, eindeutige
// Nummer). Frueher reichte ein kurzer Code quer ueber alle Shops — echte
// Gutscheine wurden als Duplikat abgewiesen.
function findDupe(v, extra = []) {
  const shop = s => String(s || '').trim().toLowerCase();
  return [...state.wallet.vouchers, ...extra].find(x => x && x !== v && x.id !== v.id && walletArt(x) === walletArt(v) && (
    (x.pin && v.pin && String(v.pin).length >= 4 && x.pin === v.pin && shop(x.vendor) === shop(v.vendor))
    || (v.code && x.code && x.code === v.code && (shop(x.vendor) === shop(v.vendor) || String(v.code).length >= 12))));
}
// Ein gerade gespeicherter oder ausgepackter Gutschein darf nicht hinter einem
// gespeicherten Filter verschwinden — sonst wirkt er "weg"
function zeigeNeuenGutschein(v) {
  if (!v || ohneGuthaben(v)) return;
  const f = state.walletFilter;
  if ((f && f !== 'alle' && f.toLowerCase() !== String(v.vendor || '').toLowerCase()) || state.walletVal) {
    state.walletFilter = '';
    state.walletVal = 0;
    saveWalletFilter();
  }
}
// Schon vorhanden: XP-Error-Sound, Wackeln, rotes Aufleuchten und das Formular
// wird KOMPLETT zurückgesetzt (frisch gefuellte Seite mit Hinweis oben)
function dupeReject(text) {
  playSfx('error');
  buzz([60, 50, 60]);
  moneyFlash('red');
  // Kam der doppelte Gutschein selbst aus der Warteschlange (Ergänzen, geteilte
  // Bilder), geht es mit dem nächsten weiter — sonst frisches Formular derselben Art
  const ausSchlange = !!waApi?.ausSchlange;
  if (!(ausSchlange && nextFixOrDone())) openWalletAdd(addType, addPrefill);
  const c = waInhalt();
  if (!c || !waApi) return;
  waApi.hinweis('dupe', `${text} Alles wurde zurückgesetzt.`);
  if (!reducedMotion()) {
    neuStarten(c, 'shake-once');
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
  // Ein Pfandbon aus dem Mehrfach-Upload: ins Pfand-Formular, dort gescannt
  if (fix && fix.art === 'pfand') {
    openWalletAdd('pfand', '', '', { datei: fix.datei });
    if (!waOffen() || !waApi) { waFixQueue.unshift(fix); return; }
    waApi.ausSchlange = true;
    waApi.hinweis('fix', `<b>Bild ${pos} von ${total}:</b> ein Pfandbon. Bitte prüfen und speichern.`);
    return;
  }
  openWalletAdd('voucher');
  if (!waOffen() || !waApi || !$('#wa-preview')) { waFixQueue.unshift(fix); return; }
  addImg = fix.img || '';
  addCodeImg = fix.codeImg || '';
  if (addCodeImg || addImg) waApi.bild(addCodeImg || addImg);
  if (fix.vendor) waApi.shop(fix.vendor);
  if (fix.amount != null) $('#wa-amount').value = String(fix.amount).replace('.', ',');
  if (fix.pin) $('#wa-pin').value = fix.pin;
  if (fix.code) $('#wa-code').value = fix.code;
  waApi.ausSchlange = true;
  waApi.aktualisieren();
  const fehlt = [!fix.vendor && 'Shop', fix.amount == null && 'Wert', !fix.pin && 'PIN'].filter(Boolean).join(', ');
  waApi.hinweis('fix', `<b>Gutschein ${pos} von ${total}:</b> alles Erkannte ist schon eingetragen, bitte noch ${esc(fehlt || 'die Felder prüfen')} ergänzen und speichern.`);
}
function nextFixOrDone() {
  // Gesperrt (z. B. waehrend des Sicherns im Hintergrund): die Warteschlange
  // bleibt stehen und geht nach dem Entsperren ueber "Hinzufuegen" weiter
  if (walletGesperrt()) return false;
  // Weitere geteilte Bilder: das naechste ins Formular
  if (!waFixQueue.length && geteiltSchlange.length) {
    const f = geteiltSchlange.shift();
    openWalletAdd('voucher');
    if (waApi) waApi.ausSchlange = true;
    if (waOffen() && waHandleImage) waHandleImage(f);
    return true;
  }
  if (!waFixQueue.length) return false;
  openFixForm(waFixQueue.shift(), waFixTotal - waFixQueue.length, waFixTotal);
  return true;
}

// Bild aus der Zwischenablage (Strg+V) direkt in die offene Hinzufügen-Seite
let waHandleImage = null;
document.addEventListener('paste', e => {
  if (!waOffen() || !waHandleImage) return;
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
  // Der Scanner prueft den Zuschnitt danach selbst nochmal — auch komprimiert
  // muss der Code also lesbar bleiben
  return kodiereBild(c, 'code');
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

// =============================================================================
// Pfandbons erkennen: Code (Barcode/Aztec/QR), Betrag, Kette, Filiale,
// Datum und Bon-Nr. — alles lokal im Geraet (ZXing, Tesseract), nichts geht
// an fremde Dienste. Was nicht sicher gelesen wurde, bleibt leer oder wird
// als "bitte pruefen" markiert. Nie raten.
// =============================================================================

// Ketten, die Pfand annehmen. name = so, wie die Wallet sie schreibt (Logo,
// Farbe), re = woran man sie auf dem Bon erkennt.
const PFAND_KETTEN = [
  ['Kaufland', /kaufland/i],
  ['Marktkauf', /marktkauf/i],
  ['EDEKA', /\bedeka\b|\be\s?d\s?e\s?k\s?a\b|\be-?center\b/i],
  ['REWE', /\brewe\b/i],
  ['Lidl', /\blid[l1!|](?![a-zäöü])/i],
  ['ALDI', /\baldi\b/i],
  ['Netto', /\bnetto\b/i],
  ['PENNY', /\bpenny\b/i],
  ['NORMA', /\bnorma\b/i],
  ['Globus', /\bglobus\b/i],
  ['tegut', /\btegut\b/i],
  ['famila', /\bfamila\b/i],
  ['Nahkauf', /\bnahkauf\b/i],
  ['Rossmann', /\brossmann\b/i],
  ['dm', /\bdm[- ]?drogerie/i],
  ['Trinkgut', /\btrinkgut\b/i],
  ['Getränke Hoffmann', /getr[aä]nke\s*hoffmann/i],
  ['Fristo', /\bfristo\b/i],
  ['real', /\breal\s*,-/i],
];
// Fuer die Auswahl beim Anlegen: die ueblichen zuerst
const PFAND_GRID = ['EDEKA', 'REWE', 'Lidl', 'ALDI', 'Kaufland', 'Netto', 'PENNY', 'NORMA', 'Globus', 'Marktkauf',
  'tegut', 'famila', 'Nahkauf', 'Rossmann', 'dm', 'Trinkgut', 'Getränke Hoffmann', 'Fristo'];

// Woran man einen Pfandbon erkennt (Leergutautomat, Mehrweg/Einweg …):
// je Merkmal ein Treffer
function pfandWortTreffer(text) {
  const t = String(text || '');
  let n = 0;
  for (const re of [/l[e3][e3]?rg[uv]t/i, /pfandbon|pfandartikel|bepfandet/i, /mehrweg/i, /einweg/i, /tomra|sivario/i,
    /nur\s+in\s+dieser\s+filiale/i, /flasche/i, /\bpfand\b/i]) if (re.test(t)) n++;
  return n;
}

// Tomra-Codes wie bei Lidl: 19 Ziffern, "2…", die Bon-Nr. steht an Stelle
// 9–13, der Betrag in Cent in den letzten sechs Ziffern
// ("2015593271335000975" = Bon 71335, 9,75 €)
function pfandCodeZerlegen(code) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^2\d{18}$/.test(c)) return null;
  const cent = parseInt(c.slice(13), 10);
  if (!(cent > 0) || cent > 99999) return null;
  return { betrag: cent / 100, bon: c.slice(8, 13) };
}

// ---- Flaechen im Foto: senkrechte Striche (Barcode) und dichte Kanten in
// beide Richtungen bei halb dunkler, quadratischer Flaeche (Aztec/QR)
function findeCodeFlaechen(img) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!iw || !ih) return [];
  const W = Math.min(560, iw), s = W / iw, H = Math.max(40, Math.round(ih * s));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  let d;
  try { d = ctx.getImageData(0, 0, W, H).data; } catch { return []; }
  const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const strich = new Float32Array(W * H), kante = new Float32Array(W * H), dunkel = new Float32Array(W * H);
  // Papierhell = oberes Zehntel; dunkel heisst deutlich darunter
  let hell = 255;
  {
    const hist = new Uint32Array(256);
    for (let i = 0; i < W * H; i++) hist[g[i] | 0]++;
    for (let v = 0, acc = 0; v < 256; v++) { acc += hist[v]; if (acc > W * H * 0.9) { hell = v || 255; break; } }
  }
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const gx = Math.abs(g[i + 1] - g[i - 1]), gy = Math.abs(g[i + W] - g[i - W]);
    strich[i] = Math.max(0, gx - gy);
    kante[i] = Math.min(gx, gy) + (gx + gy) / 4;
    dunkel[i] = g[i] < hell * 0.62 ? 1 : 0;
  }
  const k = W / 360;   // Radien wachsen mit der Aufloesung
  const blur = (src, rx, ry) => {
    const S = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) { let z = 0; for (let x = 0; x < W; x++) { z += src[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + z; } }
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - rx), x1 = Math.min(W, x + rx + 1), y0 = Math.max(0, y - ry), y1 = Math.min(H, y + ry + 1);
      out[y * W + x] = (S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
    return out;
  };
  const schwelle = (arr, faktor, min) => {
    let z = 0, q = 0;
    for (let i = 0; i < arr.length; i++) { z += arr[i]; q += arr[i] * arr[i]; }
    const m = z / arr.length, sd = Math.sqrt(Math.max(0, q / arr.length - m * m));
    return Math.max(min, m + faktor * sd);
  };
  const komponenten = (mask, minFlaeche) => {
    const lab = new Int32Array(W * H);
    const boxen = [];
    const stapel = [];
    let n = 0;
    for (let i = 0; i < W * H; i++) {
      if (!mask[i] || lab[i]) continue;
      n++;
      let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0, wert = 0;
      stapel.push(i); lab[i] = n;
      while (stapel.length) {
        const j = stapel.pop();
        const x = j % W, y = (j - x) / W;
        area++; wert += mask[j];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && mask[j - 1] && !lab[j - 1]) { lab[j - 1] = n; stapel.push(j - 1); }
        if (x < W - 1 && mask[j + 1] && !lab[j + 1]) { lab[j + 1] = n; stapel.push(j + 1); }
        if (y > 0 && mask[j - W] && !lab[j - W]) { lab[j - W] = n; stapel.push(j - W); }
        if (y < H - 1 && mask[j + W] && !lab[j + W]) { lab[j + W] = n; stapel.push(j + W); }
      }
      if (area >= minFlaeche) boxen.push({ x0, y0, x1, y1, area, wert: wert / area });
    }
    return boxen;
  };
  // Breite Balken zerreissen einen Barcode in Stuecke: nebeneinander liegende
  // Stuecke mit fast gleicher Hoehe gehoeren zusammen
  const verbinde = boxen => {
    for (let weiter = true; weiter;) {
      weiter = false;
      for (let i = 0; i < boxen.length && !weiter; i++) for (let j = i + 1; j < boxen.length && !weiter; j++) {
        const a = boxen[i], b = boxen[j];
        const ueber = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
        const kleiner = Math.min(a.y1 - a.y0, b.y1 - b.y0) + 1;
        const luecke = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
        const groesser = Math.max(a.y1 - a.y0, b.y1 - b.y0) + 1;
        // dicht daneben, oder ein ganzes Stueck weiter, aber genau auf derselben Hoehe
        // (feine Striche in der Mitte eines Codes gehen im Foto oft unter)
        if ((ueber >= kleiner * 0.6 && luecke <= 26 * k)
          || (ueber >= groesser * 0.8 && luecke <= Math.max(a.x1 - a.x0, b.x1 - b.x0) + 1)) {
          const area = a.area + b.area;
          boxen[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), area, wert: (a.wert * a.area + b.wert * b.area) / area };
          boxen.splice(j, 1);
          weiter = true;
        }
      }
    }
    return boxen;
  };
  const anteil = (arr, b) => {
    let z = 0;
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) z += arr[y * W + x];
    return z / ((b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1));
  };
  const sb = blur(strich, Math.round(7 * k), Math.round(3 * k));
  const T1 = schwelle(sb, 2, 14);
  const m1 = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) m1[i] = sb[i] > T1 ? sb[i] : 0;
  const eins = verbinde(komponenten(m1, 60 * k * k))
    .map(b => ({ ...b, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 }))
    // Ein Barcode ist breiter als hoch-schmal, dicht und halb dunkel
    .filter(b => b.w >= 30 * k && b.h >= 8 * k && b.area / (b.w * b.h) > 0.35)
    .map(b => ({ ...b, dunkel: anteil(dunkel, b) }))
    .filter(b => b.dunkel > 0.08 && b.dunkel < 0.85)
    .map(b => ({ typ: '1d', x: b.x0 / s, y: b.y0 / s, width: b.w / s, height: b.h / s, score: b.area * b.wert / (k * k) }));
  const kb = blur(kante, Math.round(5 * k), Math.round(5 * k));
  const T2 = schwelle(kb, 1.6, 30);
  const m2 = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) m2[i] = kb[i] > T2 ? kb[i] : 0;
  const zwei = komponenten(m2, 150 * k * k)
    .map(b => ({ ...b, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 }))
    .filter(b => b.w >= 22 * k && b.h >= 22 * k && b.w / b.h > 0.7 && b.w / b.h < 1.45 && b.area / (b.w * b.h) > 0.55)
    .map(b => ({ ...b, dunkel: anteil(dunkel, b) }))
    .filter(b => b.dunkel > 0.28 && b.dunkel < 0.66)
    .map(b => ({ typ: '2d', x: b.x0 / s, y: b.y0 / s, width: b.w / s, height: b.h / s, score: b.area * b.wert / (k * k) }));
  return [...eins.sort((a, b) => b.score - a.score).slice(0, 3), ...zwei.sort((a, b) => b.score - a.score).slice(0, 2)];
}

// Ausschnitt einer Code-Flaeche auf weissem Grund (Ruhezone), hochskaliert
function codeAusschnitt(img, f, { rand = 0.04, ziel = 1200, unten = 0 } = {}) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const px = f.width * rand + 2, py = f.height * rand * 2 + 2;
  const x = Math.max(0, f.x - px), y = Math.max(0, f.y - py);
  const w = Math.min(iw - x, f.width + 2 * px), h = Math.min(ih - y, f.height + 2 * py + f.height * unten);
  const s = Math.max(0.2, Math.min(4, ziel / w));
  const mx = Math.round(w * s * 0.08) + 12, my = Math.round(h * s * 0.12) + 12;
  const c = document.createElement('canvas');
  c.width = Math.round(w * s) + 2 * mx; c.height = Math.round(h * s) + 2 * my;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x, y, w, h, mx, my, Math.round(w * s), Math.round(h * s));
  return c;
}

// ZXing-Formatnamen und die des eingebauten Detektors auf eine Schreibweise
function codeFormatName(f) {
  return String(f || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20);
}
// formate: nur diese Code-Arten suchen (ZXing-Namen). Auf einem Strichcode-
// Ausschnitt sparen die Strichcode-Formate allein die teure Suche nach
// QR/Aztec/PDF417, die ZXing sonst zuerst probiert.
function zxingLies(canvas, binarizer, formate = null) {
  if (!window.ZXing) return null;
  try {
    const src = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
    const bin = binarizer === 'global' ? new ZXing.GlobalHistogramBinarizer(src) : new ZXing.HybridBinarizer(src);
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    if (formate) hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formate.map(f => ZXing.BarcodeFormat[f]));
    const r = new ZXing.MultiFormatReader().decode(new ZXing.BinaryBitmap(bin), hints);
    const punkte = (r.getResultPoints() || []).filter(Boolean).map(p => [p.getX(), p.getY()]);
    return { text: r.getText(), format: codeFormatName(ZXing.BarcodeFormat[r.getBarcodeFormat()]), punkte };
  } catch { return null; }
}
const PFAND_STRICHCODES = ['CODE_128', 'EAN_13', 'EAN_8', 'ITF', 'CODE_39', 'CODE_93', 'UPC_A', 'CODABAR'];

// ZXing im Hintergrund: auf grossen Ausschnitten braucht ein Leseversuch auf
// dem Handy leicht eine Sekunde, auf dem Hauptfaden stuende solange die ganze
// Oberflaeche (Fortschritt, Tippen). Im Worker nicht. Klappt der Worker nicht,
// liest ZXing wie bisher vorne, mit Pausen zwischen den Versuchen.
let zxingHinten = null;
function zxingWorker() {
  if (zxingHinten) return zxingHinten;
  zxingHinten = new Promise(res => {
    try {
      const quelle = `importScripts(${JSON.stringify(location.origin + '/vendor/zxing.min.js')});
self.onmessage = e => {
  const { id, lum, w, h, bin, formate } = e.data;
  let aus = null;
  try {
    const src = new ZXing.RGBLuminanceSource(lum, w, h);
    const b = bin === 'global' ? new ZXing.GlobalHistogramBinarizer(src) : new ZXing.HybridBinarizer(src);
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    if (formate) hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formate.map(f => ZXing.BarcodeFormat[f]));
    const r = new ZXing.MultiFormatReader().decode(new ZXing.BinaryBitmap(b), hints);
    aus = { text: r.getText(), format: ZXing.BarcodeFormat[r.getBarcodeFormat()], punkte: (r.getResultPoints() || []).filter(Boolean).map(p => [p.getX(), p.getY()]) };
  } catch (err) { }
  self.postMessage({ id, aus });
};
self.postMessage({ bereit: !!self.ZXing });`;
      const url = URL.createObjectURL(new Blob([quelle], { type: 'text/javascript' }));
      const w = new Worker(url);
      const offen = new Map();
      let nr = 0, fertig = false;
      const aus = ok => {
        if (fertig) return;
        fertig = true;
        URL.revokeObjectURL(url);
        if (!ok) try { w.terminate(); } catch { }
        res(ok ? api : null);
      };
      const api = {
        lies(canvas, bin, formate) {
          const W = canvas.width, H = canvas.height;
          const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
          const lum = new Uint8ClampedArray(W * H);
          for (let i = 0; i < W * H; i++) lum[i] = (306 * d[i * 4] + 601 * d[i * 4 + 1] + 117 * d[i * 4 + 2] + 0x200) >> 10;
          return new Promise(r => { const id = ++nr; offen.set(id, r); w.postMessage({ id, lum, w: W, h: H, bin, formate }, [lum.buffer]); });
        },
      };
      w.onmessage = e => {
        if ('bereit' in e.data) { aus(e.data.bereit); return; }
        const r = offen.get(e.data.id);
        offen.delete(e.data.id);
        const a = e.data.aus;
        r?.(a ? { text: a.text, format: codeFormatName(a.format), punkte: a.punkte } : null);
      };
      w.onerror = () => { aus(false); for (const r of offen.values()) r(null); offen.clear(); };
      setTimeout(() => aus(false), 8000);
    } catch { res(null); }
  }).then(api => { if (!api) zxingHinten = Promise.resolve(null); return api; });
  return zxingHinten;
}
async function zxingLiesLeise(canvas, bin, formate = null) {
  const w = await zxingWorker();
  if (w) return w.lies(canvas, bin, formate);
  const r = zxingLies(canvas, bin, formate);
  await new Promise(x => setTimeout(x, 0));   // Oberflaeche atmen lassen
  return r;
}
// Leserichtung eines Strichcodes aus ZXing-Punkten (Anfang → Ende):
// 0 = normal, 90 = Bild steht im Uhrzeigersinn gedreht, 180 = auf dem Kopf …
function codeRichtung(punkte) {
  if (!punkte || punkte.length < 2) return 0;
  const [a, b] = [punkte[0], punkte[punkte.length - 1]];
  const w = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
  return ((Math.round(w / 90) * 90) % 360 + 360) % 360;
}

// Code lesen: mehrere Ausschnitte und Groessen, dann abstimmen. Ein einzelner
// Treffer, dem ein anderer widerspricht, gilt als unsicher (ZXing hat bei
// einem Bon schon einmal zwei Ziffern vertauscht und trotzdem "gueltig" gemeldet).
async function pfandCodeLesen(img, flaechen, fortschritt = () => { }) {
  if (!window.ZXing) await zxingDetect(document.createElement('canvas')).catch(() => null);
  const stimmen = new Map();
  // param: mit welchem Ausschnitt es geklappt hat (daraus wird das Kassen-Bild),
  // richtung: Leserichtung des Strichcodes (steht der Bon auf dem Kopf?)
  const zaehle = (text, format, f, param = null, punkte = null) => {
    text = String(text || '').trim();
    // Nur, was nach einem Kassen-Code aussieht (ZXing liefert aus Rauschen
    // selten, aber doch mal Zeichensalat wie "4, JZ:H7^µ")
    if (!/^[0-9A-Za-z+\-.\/:]{6,80}$/.test(text)) return;
    const e = stimmen.get(text) || { text, format: codeFormatName(format), n: 0, flaeche: f };
    e.n++;
    if (!e.flaeche && f) e.flaeche = f;
    if (!e.param && param) e.param = param;
    if (e.richtung == null && punkte && !/qr|aztec|matrix|pdf|maxi/.test(e.format)) e.richtung = codeRichtung(punkte);
    stimmen.set(text, e);
  };
  const nativ = 'BarcodeDetector' in window ? new BarcodeDetector() : null;
  if (nativ) {
    try {
      for (const code of await nativ.detect(img)) {
        const b = code.boundingBox;
        zaehle(code.rawValue, code.format, b ? { typ: /qr|aztec|data_matrix|pdf/.test(code.format) ? '2d' : '1d', x: b.x, y: b.y, width: b.width, height: b.height } : null);
      }
    } catch { /* weiter mit ZXing */ }
  }
  const kandidaten = [...flaechen.filter(f => f.typ === '1d').slice(0, 2), ...flaechen.filter(f => f.typ === '2d').slice(0, 1)];
  const versucheFuer = f => f.typ === '1d' ? [[0.015, 1000], [0.015, 1500], [0.04, 800], [0.04, 1200]] : [[0.03, 520], [0.03, 800], [0.06, 1100]];
  const gesamt = kandidaten.reduce((n, f) => n + versucheFuer(f).length, 0) || 1;
  let schritt = 0;
  for (const f of kandidaten) {
    // Wenig Rand: daneben liegen oft Hand oder Tischdecke, deren Muster
    // ZXing fuer den Anfang eines Codes haelt
    const versuche = versucheFuer(f);
    // Eine breite Strich-Flaeche ist ein Strichcode; eine fast quadratische
    // kann auch ein Aztec-/QR-Code sein, den der Sucher als Striche sah
    const formate = f.typ === '1d' && f.width > f.height * 1.6 ? PFAND_STRICHCODES : null;
    let hier = 0;
    for (const [rand, ziel] of versuche) {
      fortschritt(++schritt / gesamt);
      const c = codeAusschnitt(img, f, { rand, ziel });
      if (nativ) { try { for (const code of await nativ.detect(c)) { zaehle(code.rawValue, code.format, f, { rand, ziel }); hier++; } } catch { } }
      for (const bin of ['hybrid', 'global']) {
        const r = await zxingLiesLeise(c, bin, formate);
        if (r) { zaehle(r.text, r.format, f, { rand, ziel }, r.punkte); hier++; }
      }
      // Zwei uebereinstimmende Lesungen reichen
      if ([...stimmen.values()].some(e => e.n >= 2 && e.flaeche === f)) break;
    }
  }
  fortschritt(1);
  const liste = [...stimmen.values()].sort((a, b) => b.n - a.n);
  if (!liste.length) return null;
  const best = liste[0];
  const widerspruch = liste.some(e => e !== best && e.flaeche === best.flaeche);
  return { text: best.text, format: best.format, flaeche: best.flaeche, param: best.param || null, richtung: best.richtung || 0, sicher: best.n >= 2 && !widerspruch };
}

// Kassen-Bild pruefen: liest ZXing aus dem gespeicherten (komprimierten) Bild
// wieder denselben Code? Nur dann ist sicher, dass die Kasse ihn auch liest.
async function codeBildLiest(url, text) {
  try {
    const i = new Image();
    await new Promise((res, rej) => { i.onload = res; i.onerror = rej; i.src = url; });
    const c = document.createElement('canvas');
    c.width = i.naturalWidth; c.height = i.naturalHeight;
    c.getContext('2d').drawImage(i, 0, 0);
    for (const bin of ['hybrid', 'global']) {
      const r = await zxingLiesLeise(c, bin);
      if (r && r.text === text) return true;
    }
  } catch { }
  return false;
}

// Bild um 90/180/270 Grad (oder einen kleinen Winkel zum Geraderuecken) drehen
function pfandDrehen(img, grad) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const r = grad * Math.PI / 180;
  const cos = Math.abs(Math.cos(r)), sin = Math.abs(Math.sin(r));
  const c = document.createElement('canvas');
  c.width = Math.round(w * cos + h * sin); c.height = Math.round(w * sin + h * cos);
  const g = c.getContext('2d');
  // Die Ecken, die beim Drehen entstehen, in der mittleren Farbe des Bildes:
  // reines Weiss waere heller als das Papier und verschoebe alle Schwellen,
  // die sich am hellsten Teil des Bildes ausrichten (Code-Sucher, Balken)
  if (grad % 90) {
    const m = document.createElement('canvas'); m.width = m.height = 16;
    const mg = m.getContext('2d', { willReadFrequently: true });
    mg.drawImage(img, 0, 0, 16, 16);
    let rot = 0, gruen = 0, blau = 0;
    try { const d = mg.getImageData(0, 0, 16, 16).data; for (let i = 0; i < d.length; i += 4) { rot += d[i]; gruen += d[i + 1]; blau += d[i + 2]; } } catch { rot = gruen = blau = 255 * 256; }
    g.fillStyle = `rgb(${Math.round(rot / 256)},${Math.round(gruen / 256)},${Math.round(blau / 256)})`;
  } else g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingQuality = 'high';
  g.translate(c.width / 2, c.height / 2);
  g.rotate(r);
  g.drawImage(img, -w / 2, -h / 2);
  return c;
}

// Wie schraeg steht ein Strichcode? Strukturtensor ueber der Code-Flaeche:
// die Kanten der Striche zeigen alle in dieselbe Richtung. Grad (+ = das Bild
// ist im Uhrzeigersinn verdreht), klar: 0..1, wie einig sich die Kanten sind.
function pfandStrichWinkel(img, f) {
  const s = Math.min(1, 420 / f.width);
  const W = Math.max(8, Math.round(f.width * s)), H = Math.max(8, Math.round(f.height * s));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, f.x, f.y, f.width, f.height, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  let xx = 0, yy = 0, xy = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const gx = L[i + 1] - L[i - 1], gy = L[i + W] - L[i - W];
    xx += gx * gx; yy += gy * gy; xy += gx * gy;
  }
  const summe = xx + yy;
  if (!summe) return { grad: 0, klar: 0 };
  return { grad: 0.5 * Math.atan2(2 * xy, xx - yy) * 180 / Math.PI, klar: Math.sqrt((xx - yy) ** 2 + 4 * xy * xy) / summe };
}
// Ohne Strichcode: wie schraeg stehen die Schriftzeilen? Dunkle Punkte auf
// hellem Grund (Schrift auf Papier) in mehreren Winkeln auf Zeilen verteilen;
// wo die Zeilen am schaerfsten getrennt sind, liegt der Winkel. 0 = gerade
// oder nicht sicher genug, null = zu wenig Schrift, um es zu sagen.
function pfandTextWinkel(img) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = Math.min(1, 640 / Math.max(iw, ih));
  const W = Math.max(8, Math.round(iw * s)), H = Math.max(8, Math.round(ih * s));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  let d;
  try { d = ctx.getImageData(0, 0, W, H).data; } catch { return null; }
  const L = new Float32Array(W * H), hist = new Uint32Array(256);
  for (let i = 0; i < W * H; i++) { const v = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; L[i] = v; hist[v | 0]++; }
  let acc = 0, hell = 255;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > W * H * 0.1) { hell = v; break; } }
  const S = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let z = 0; for (let x = 0; x < W; x++) { z += L[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + z; } }
  const r = Math.max(4, Math.round(W / 80));
  const px = [], py = [];
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      const m = (S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
      if (m > hell * 0.72 && L[y * W + x] < m - 28) { px.push(x); py.push(y); }
    }
  }
  const n = px.length;
  if (n < 400) return null;
  const bins = new Float64Array(Math.ceil(Math.hypot(W, H)) * 2 + 4);
  const schaerfe = grad => {
    const a = grad * Math.PI / 180, sin = Math.sin(a), cos = Math.cos(a), off = bins.length / 2;
    bins.fill(0);
    for (let i = 0; i < n; i++) bins[Math.round(py[i] * cos - px[i] * sin + off)]++;
    let q = 0;
    for (let i = 0; i < bins.length; i++) q += bins[i] * bins[i];
    return q / n;
  };
  let best = 0, bestWert = schaerfe(0);
  const null0 = bestWert, alle = [];
  for (let g = -20; g <= 20; g += 1) { const w = g ? schaerfe(g) : null0; alle.push(w); if (w > bestWert) { best = g; bestWert = w; } }
  for (let g = best - 0.75; g <= best + 0.75; g += 0.25) { const w = schaerfe(g); if (w > bestWert) { best = g; bestWert = w; } }
  // klar: wie sehr die beste Lage herausragt (liegen die Zeilen quer, ist
  // keine Lage zwischen -20 und 20 Grad besonders scharf)
  const mitte = alle.sort((a, b) => a - b)[alle.length >> 1] || 1;
  return { grad: bestWert > null0 * 1.15 ? best : 0, klar: bestWert / mitte };
}

// ---- Vorlage fuer die Texterkennung: Graustufen, Kontrast gestreckt, die
// Codes weiss uebermalt (ihre Striche bringen die Zeilenerkennung durcheinander)
// bereich: der Streifen um den Code (Bons sind schmale Streifen) — so wird
// die Schrift gross genug, und Hand, Boden und Tisch fallen weg
function pfandOcrBereich(img, f) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!f) return { x: 0, y: 0, width: iw, height: ih };
  const rand = f.typ === '1d' ? 0.35 : 0.62;
  const x0 = Math.max(0, f.x - f.width * rand), x1 = Math.min(iw, f.x + f.width * (1 + rand));
  const hoch = (x1 - x0) * 3.2;
  const y0 = Math.max(0, f.y - hoch * 0.75), y1 = Math.min(ih, f.y + f.height + hoch * 0.45);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
function pfandOcrVorlage(img, flaechen, { binaer = false, zielBreite = 1500, bereich = null } = {}) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const b = bereich || { x: 0, y: 0, width: iw, height: ih };
  // Obergrenze in Pixeln: die Summenbilder fuer Schwarz-Weiss brauchen je
  // Pixel 16 Byte — auf dem Handy soll das unter ~50 MB bleiben
  const maxPixel = binaer ? 3.2e6 : 5e6;
  const s = Math.min(3, zielBreite / b.width, 4200 / b.height, Math.sqrt(maxPixel / (b.width * b.height)));
  const W = Math.round(b.width * s), H = Math.round(b.height * s);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, b.x, b.y, b.width, b.height, 0, 0, W, H);
  const im = ctx.getImageData(0, 0, W, H);
  const d = im.data;
  const L = new Float32Array(W * H);
  const hist = new Uint32Array(256);
  for (let i = 0; i < W * H; i++) { const v = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; L[i] = v; hist[v | 0]++; }
  const weiss = new Uint8Array(W * H);
  for (const f of flaechen) {
    const x0 = Math.max(0, Math.floor((f.x - b.x) * s - 3)), y0 = Math.max(0, Math.floor((f.y - b.y) * s - 3));
    const x1 = Math.min(W, Math.ceil((f.x - b.x + f.width) * s + 3)), y1 = Math.min(H, Math.ceil((f.y - b.y + f.height) * s + 3));
    if (x1 <= x0 || y1 <= y0) continue;
    for (let y = y0; y < y1; y++) weiss.fill(1, y * W + x0, y * W + x1);
  }
  if (!binaer) {
    let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > W * H * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > W * H * 0.2) { hi = v; break; } }
    const sp = Math.max(40, hi - lo);
    for (let i = 0; i < W * H; i++) {
      const v = weiss[i] ? 255 : Math.max(0, Math.min(255, (L[i] - lo) * 255 / sp));
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    }
  } else {
    // Sauvola: jede Stelle gegen ihre Umgebung — Schatten und Knicke im
    // Papier verschwinden, die Schrift bleibt
    const S = new Float64Array((W + 1) * (H + 1)), Q = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let z = 0, q = 0;
      for (let x = 0; x < W; x++) {
        const v = L[y * W + x]; z += v; q += v * v;
        S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + z;
        Q[(y + 1) * (W + 1) + x + 1] = Q[y * (W + 1) + x + 1] + q;
      }
    }
    const r = Math.max(8, Math.round(Math.max(W, H) / 40));
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (weiss[i]) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255; continue; }
        const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
        const n = (x1 - x0) * (y1 - y0);
        const a = y1 * (W + 1), b = y0 * (W + 1);
        const sum = S[a + x1] - S[b + x1] - S[a + x0] + S[b + x0];
        const sq = Q[a + x1] - Q[b + x1] - Q[a + x0] + Q[b + x0];
        const m = sum / n, sd = Math.sqrt(Math.max(0, sq / n - m * m));
        const v = L[i] < m * (1 + 0.2 * (sd / 128 - 1)) ? 0 : 255;
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
      }
    }
  }
  ctx.putImageData(im, 0, 0);
  return { canvas: c, s };
}

// Der schwarze Balken mit dem Betrag (weisse Schrift) sitzt bei Tomra-,
// Lidl- und Kaufland-Bons direkt ueber dem Code. Gesucht wird er genau dort:
// Zeilen, die ueber die Breite des Codes fast ganz dunkel sind.
function pfandBalkenFinden(img, f) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const hoch = f.typ === '1d' ? f.height * 1.1 : f.height * 0.5;
  const seite = f.typ === '1d' ? 0.15 : 0.6;
  const x = Math.max(0, f.x - f.width * seite), w = Math.min(iw - x, f.width * (1 + 2 * seite));
  const y = Math.max(0, f.y - hoch), h = f.y - y;
  if (w < 20 || h < 8) return null;
  const s = Math.min(1, 400 / w);
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, x, y, w, h, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  // Papierhelligkeit dieses Ausschnitts
  const sortiert = [...L].sort((a, b) => a - b);
  const papier = sortiert[Math.floor(sortiert.length * 0.95)];
  const grenze = papier * 0.45;
  const zeileDunkel = [];
  for (let yy = 0; yy < H; yy++) {
    let n = 0;
    for (let xx = 0; xx < W; xx++) if (L[yy * W + xx] < grenze) n++;
    zeileDunkel.push(n / W);
  }
  // Von unten (am Code) nach oben: der erste Lauf dunkler Zeilen
  let y1 = -1, y0 = -1;
  for (let yy = H - 1; yy >= 0; yy--) {
    if (zeileDunkel[yy] > 0.3) { if (y1 < 0) y1 = yy; y0 = yy; }
    else if (y1 >= 0 && y1 - yy > 2) break;
  }
  if (y1 < 0 || y1 - y0 + 1 < Math.max(4, H * 0.08)) return null;
  // Spalten: wo der Balken wirklich dunkel ist
  let x0 = W, x1 = -1;
  for (let xx = 0; xx < W; xx++) {
    let n = 0;
    for (let yy = y0; yy <= y1; yy++) if (L[yy * W + xx] < grenze) n++;
    if (n / (y1 - y0 + 1) > 0.35) { if (xx < x0) x0 = xx; x1 = xx; }
  }
  if (x1 - x0 < W * 0.2) return null;
  return { x: x + x0 / s, y: y + y0 / s, width: (x1 - x0 + 1) / s, height: (y1 - y0 + 1) / s };
}
// Einen Bildausschnitt fuer die Texterkennung vorbereiten: hochskalieren,
// optional umkehren (weisse Schrift auf Schwarz), hart schwarz-weiss (Otsu)
// und alles Dunkle, das den Rand beruehrt, weg — angeschnittene Striche,
// Schatten und Papierraender stoeren die Zeilenerkennung
function zeilenVorlage(img, b, { umkehren = false, zielHoehe = 72, maxBreite = 2400, hochBehalten = false } = {}) {
  const s = Math.max(0.5, Math.min(5, zielHoehe / b.height, maxBreite / b.width));
  const W = Math.max(1, Math.round(b.width * s)), H = Math.max(1, Math.round(b.height * s));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, b.x, b.y, b.width, b.height, 0, 0, W, H);
  const im = ctx.getImageData(0, 0, W, H);
  const d = im.data;
  const L = new Uint8Array(W * H);
  const hist = new Uint32Array(256);
  for (let i = 0; i < L.length; i++) {
    let v = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
    if (umkehren) v = 255 - v;
    L[i] = v; hist[v]++;
  }
  // Otsu-Schwelle
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sB = 0, wB = 0, best = 0, t = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v]; if (!wB) continue;
    const wF = L.length - wB; if (!wF) break;
    sB += v * hist[v];
    const mB = sB / wB, mF = (sum - sB) / wF;
    const zw = wB * wF * (mB - mF) * (mB - mF);
    if (zw > best) { best = zw; t = v; }
  }
  const schwarz = new Uint8Array(W * H);
  for (let i = 0; i < L.length; i++) schwarz[i] = L[i] <= t ? 1 : 0;
  // Grosse dunkle Flaechen am Rand weg (Papier um einen umgekehrten Balken,
  // Schatten, angeschnittene Striche). Kleine Flecken am Rand bleiben: das
  // sind oft Ziffern, die bis an die Kante reichen.
  const lab = new Int32Array(W * H);
  let nr = 0;
  const st = [];
  for (let start = 0; start < W * H; start++) {
    if (!schwarz[start] || lab[start]) continue;
    nr++;
    let x0 = W, x1 = 0, y0 = H, y1 = 0, n = 0;
    const teil = [];
    st.push(start); lab[start] = nr;
    while (st.length) {
      const i = st.pop(), x = i % W, y = (i - x) / W;
      teil.push(i); n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && schwarz[i - 1] && !lab[i - 1]) { lab[i - 1] = nr; st.push(i - 1); }
      if (x < W - 1 && schwarz[i + 1] && !lab[i + 1]) { lab[i + 1] = nr; st.push(i + 1); }
      if (y > 0 && schwarz[i - W] && !lab[i - W]) { lab[i - W] = nr; st.push(i - W); }
      if (y < H - 1 && schwarz[i + W] && !lab[i + W]) { lab[i + W] = nr; st.push(i + W); }
    }
    const amRand = x0 === 0 || y0 === 0 || x1 === W - 1 || y1 === H - 1;
    if (amRand && (x1 - x0 + 1 > W * 0.45 || (!hochBehalten && y1 - y0 + 1 > H * 0.92) || n > W * H * 0.12)) for (const i of teil) schwarz[i] = 0;
  }
  // Weisser Rand drumherum: Tesseract mag Luft um die Schrift
  const rand = Math.round(Math.min(zielHoehe, H) * 0.3) + 10;
  const out = document.createElement('canvas');
  out.width = W + 2 * rand; out.height = H + 2 * rand;
  const o = out.getContext('2d');
  o.fillStyle = '#fff';
  o.fillRect(0, 0, out.width, out.height);
  for (let i = 0; i < L.length; i++) { const v = schwarz[i] ? 0 : 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  o.putImageData(im, rand, rand);
  return out;
}
// Die Ziffernzeile unter dem Code genau finden: erst kommen Zeilen voller
// Kanten (der Code), dann eine Luecke, dann die Ziffern bis zur naechsten Luecke
function pfandZiffernZeile(img, f) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const x = Math.max(0, f.x - f.width * 0.05), w = Math.min(iw - x, f.width * 1.1);
  const y = Math.max(0, f.y + f.height * 0.5), h = Math.min(ih - y, f.height * (f.typ === '1d' ? 1.05 : 0.85));
  if (w < 20 || h < 10) return null;
  const s = Math.min(1, 500 / w);
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, x, y, w, h, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const hell = [...L].sort((a, b) => a - b)[Math.floor(W * H * 0.92)] || 255;
  const grenze = hell * 0.6;
  const wechsel = [], dunkel = [];
  for (let yy = 0; yy < H; yy++) {
    let n = 0, z = 0;
    for (let xx = 1; xx < W; xx++) {
      const a = L[yy * W + xx - 1] < grenze, b = L[yy * W + xx] < grenze;
      if (a !== b) n++;
      if (b) z++;
    }
    wechsel.push(n); dunkel.push(z / W);
  }
  const codeWechsel = [...wechsel.slice(0, Math.max(1, Math.round(H * 0.2)))].sort((a, b) => a - b)[Math.floor(H * 0.1)] || 0;
  let yy = 0;
  while (yy < H && wechsel[yy] >= codeWechsel * 0.55 && codeWechsel > 6) yy++;    // noch im Code
  while (yy < H && dunkel[yy] < 0.012) yy++;                                        // Luecke
  const ya = yy;
  while (yy < H && dunkel[yy] >= 0.012) yy++;                                       // Ziffern
  const yb = yy;
  if (yb - ya < 3 || yb - ya > H * 0.5) return null;
  const pad = (yb - ya) * 0.35;
  return { x, y: y + Math.max(0, ya - pad) / s, width: w, height: (yb - ya + 2 * pad) / s };
}
// Eine Zeile lesen (Seitenmodus 7), optional nur bestimmte Zeichen
async function ocrZeile(canvas, erlaubt = '') {
  const worker = await getOcrWorker();
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: erlaubt });
    const { data } = await worker.recognize(canvas);
    return { text: (data.text || '').trim(), conf: data.confidence || 0 };
  } catch { return { text: '', conf: 0 }; }
  finally { try { await worker.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' }); } catch { } }
}
async function ocrSeite(canvas, psm = '4') {
  const worker = await getOcrWorker();
  try {
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await worker.recognize(canvas);
    return { text: data.text || '', words: data.words || [], lines: data.lines || [], breite: canvas.width };
  } catch { return { text: '', words: [], lines: [] }; }
  finally { try { await worker.setParameters({ tessedit_pageseg_mode: '6' }); } catch { } }
}

// ---- Aus den gelesenen Texten die Felder ziehen
const PFAND_MONATE = [
  [1, /^(JAN|3AN)/], [2, /^FEB/], [3, /^(M[AÄ]R|MRZ)/], [4, /^APR/], [5, /^(MA[I1lY|])/], [6, /^J[UV]N/], [7, /^J[UV][L1I|]/],
  [8, /^A[UV]G/], [9, /^SEP/], [10, /^[O0](K|C)[T7]/], [11, /^N[O0]V/], [12, /^[D0O]E[Z2C]/],
];
function pfandZahl(x) { const n = parseFloat(String(x).replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; }
function pfandDatumAus(text) {
  const heute = new Date();
  const treffer = [];
  const pruefe = (t, m, j, quelle) => {
    if (j < 100) j += 2000;
    if (j < 2000 || m < 1 || m > 12 || t < 1 || t > 31) return;
    const dt = new Date(j, m - 1, t, 12);
    if (dt.getMonth() !== m - 1 || dt > new Date(heute.getTime() + 864e5)) return;
    treffer.push({ iso: `${j}-${String(m).padStart(2, '0')}-${String(t).padStart(2, '0')}`, quelle });
  };
  const T = String(text || '');
  for (const m of T.matchAll(/\b(\d{1,2})\s?[.\/]\s?(\d{1,2})\s?[.\/]\s?(\d{4}|\d{2})\b/g)) pruefe(+m[1], +m[2], +m[3], 'zahl');
  for (const m of T.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) pruefe(+m[3], +m[2], +m[1], 'iso');
  for (const m of T.matchAll(/\b([0-3O]?[0-9O])\s?[-.\s]\s?([A-Z0-9ÄÖÜ|]{3})[A-Z]*\s?[-.\s]\s?((?:19|20)\d{2}|\d{2})\b/gi)) {
    const mon = PFAND_MONATE.find(([, re]) => re.test(m[2].toUpperCase()));
    if (mon) pruefe(+m[1].replace(/O/g, '0'), mon[0], +m[3], 'monat');
  }
  return treffer;
}
function pfandBetraegeAus(text) {
  const T = pfandZiffernText(text);
  const out = [];
  // "Summe: 57,29 EUR" — die groesste Summe ist die Gesamtsumme ("5umme": S als 5 gelesen)
  // ("Sunmg: 57, 29": das e als g gelesen)
  for (const m of T.matchAll(/\b[s5]\s?[uv]\s?[mn]{1,2}\s?[a-z0-9@]?\s?[:;.,]?\W{0,3}\s*(\d{1,3})\s?[.,]\s?(\d{2})(?!\d)/gi)) out.push({ wert: pfandZahl(m[1] + '.' + m[2]), quelle: 'summe' });
  // "€13.47", "€ 9.75" (Tomra); das €-Zeichen wird auch mal zu "£"
  for (const m of T.matchAll(/(?:€|£|EUR)\s?(\d{1,3})\s?[.,]\s?(\d{2})(?!\d)/gi)) out.push({ wert: pfandZahl(m[1] + '.' + m[2]), quelle: 'euro' });
  // "0,24 EUR" — Posten und Zwischensummen, zur Not die groesste
  for (const m of T.matchAll(/(\d{1,3})\s?[.,]\s?(\d{2})\s?(?:EUR|EU[RF!]?|€|[EFTÜ][UÜu]?[RT])\b/gi)) out.push({ wert: pfandZahl(m[1] + '.' + m[2]), quelle: 'posten' });
  return out.filter(b => b.wert != null && b.wert > 0 && b.wert < 1000);
}
function pfandBonNrAus(text) {
  // Bon-Nummern haben mindestens drei Stellen ("Bon 076") — zwei gelesene
  // Ziffern sind fast immer ein angeschnittenes Stueck davon
  const m = String(text || '').match(/\bB\s?[o0aı]\s?[nmr]{1,2}\w?\s*[-.]?\s*(?:[NHKM][rt]\.?)?\s*[:.]?\s*([0-9OoSB]{3,8})\b/);
  if (!m) return '';
  const nr = m[1].replace(/[Oo]/g, '0').replace(/S/g, '5').replace(/B/g, '8');
  return /^\d{3,8}$/.test(nr) ? nr : '';
}
function pfandKetteAus(text) {
  const T = String(text || '');
  for (const [name, re] of PFAND_KETTEN) if (re.test(T)) return { name, sicher: true };
  // Leicht verlesen ("EDERA", "Kaufiand"): hoechstens ein Zeichen daneben,
  // nur bei laengeren Namen — und dann als "bitte pruefen"
  const woerter = T.split(/[^A-Za-zÄÖÜäöüß]+/).filter(w => w.length >= 5);
  for (const [name] of PFAND_KETTEN) {
    const n = name.toLowerCase();
    if (n.length < 5) continue;
    if (woerter.some(w => levenshtein(w.toLowerCase(), n) <= 1)) return { name, sicher: false };
  }
  return null;
}
function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const v = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = v[0]; v[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = v[j];
      v[j] = Math.min(v[j] + 1, v[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return v[b.length];
}
// Anschrift: "12169 Berlin-Steglitz-Zehl", darueber "Steglitzer Damm 95"
const STRASSEN_ENDE = /(str(?:a(?:ss|ß)e)?\.?|straße|strasse|weg|allee|platz|damm|ring|gasse|chaussee|ufer|markt|steig|pfad|hof|berg|feld|park|landstr\.?|stieg|twiete|kamp|wall|graben|brücke|bruecke|tor)\b/i;
function pfandAnschriftAus(text) {
  const zeilen = String(text || '').split('\n').map(z => z.replace(/[|\\{}\[\]“”"'`´‘’»«~_]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  let plz = '', ort = '', strasse = '', zeileNr = -1, ortGanz = true;
  for (let i = 0; i < zeilen.length; i++) {
    const m = zeilen[i].match(/(?:^|\s)(?:D-?)?([0-9]{5})\s+([A-ZÄÖÜ][a-zäöüß]{2,}[A-Za-zÄÖÜäöüß.\-]*(?:[ -][A-ZÄÖÜa-zäöüß][A-Za-zÄÖÜäöüß.\-]*){0,3})/);
    if (!m) continue;
    const n = +m[1];
    if (n < 1001 || n > 99998) continue;
    plz = m[1];
    // "Ber lin-Steglitz" → "Berlin-Steglitz": die OCR zerreisst Woerter gern
    ort = m[2].replace(/\b([A-ZÄÖÜ][a-zäöüß]{1,3}) ([a-zäöüß][A-Za-zÄÖÜäöüß\-]{2,})/g, '$1$2')
      .split(' ').filter(w => /^[A-ZÄÖÜ]/.test(w) || /^(a|am|an|im|in|ob|bei|vor|der|dem|den)$/.test(w)).join(' ')
      .replace(/[.\-]+$/, '').slice(0, 40);
    // Endet der Treffer mitten im Wort (ein Zeichen, das die Suche nicht
    // kennt), ist der Ort vielleicht abgeschnitten
    ortGanz = !/^[^\s,.;:]/.test(zeilen[i].slice(m.index + m[0].length));
    zeileNr = i;
    break;
  }
  const strassenZeile = z => {
    const m = z.match(/([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\- ]{2,40}?)\s*[,.]?\s*(\d{1,4}\s?[a-zA-Z]?(?:\s?[-/]\s?\d{1,4})?)\s*$/);
    if (!m || /\d{5}/.test(z) || /bon|summe|pfand|tomra|flasche|eur\b/i.test(z)) return '';
    let name = m[1].trim().replace(/\s+/g, ' ');
    // Typische Lesefehler: "Harleshäuserstr, 64" / "…erste, 64" → "…str. 64",
    // "Steglitzer Danm" → "Damm"
    name = name.replace(/([a-zäöüß]{5,})st[re][,.]?$/i, '$1str.').replace(/str[,.]?$/i, 'str.').replace(/\bDan[nm]\b/g, 'Damm');
    return `${name} ${m[2].replace(/\s+/g, '')}`;
  };
  if (zeileNr > 0) {
    for (let k = zeileNr - 1; k >= Math.max(0, zeileNr - 2) && !strasse; k--) strasse = strassenZeile(zeilen[k]);
  }
  if (!strasse) {
    const z = zeilen.find(x => STRASSEN_ENDE.test(x) && strassenZeile(x));
    if (z) strasse = strassenZeile(z);
  }
  return { strasse: strasse.slice(0, 60), plz, ort, ortGanz };
}
// Name der Filiale: bei EDEKA steht der Kaufmann oben ("Prandzioch"), bei
// Kaufland die Stadt im Namen ("Kaufland Leipzig")
function pfandFilialNameAus(text, kette, anschrift) {
  const zeilen = String(text || '').split('\n').map(z => z.replace(/[^A-Za-zÄÖÜäöüß0-9 .&'-]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const stop = /leergut|pfand|lohnt|filiale|einl[oö]sen|bon|summe|mehrweg|einweg|tomra|sivario|flasche|kisten|willkommen|danke|anz|bezeichnung|zeit|datum/i;
  // Nur Zeilen UEBER der Anschrift (ohne gefundene Anschrift: nur bei Ketten,
  // die ihre Stadt im Namen tragen, die ersten Zeilen)
  const merkmal = anschrift.strasse ? anschrift.strasse.split(' ')[0].slice(0, 6) : anschrift.plz;
  let grenze = merkmal ? zeilen.findIndex(z => z.includes(merkmal)) : -1;
  if (grenze < 0) grenze = anschrift.strasse || anschrift.plz ? 0 : 4;
  const oben = zeilen.slice(0, Math.min(grenze, 6));
  for (const z of oben) {
    if (stop.test(z) || /\d{3,}/.test(z) || /\s\d{1,4}\s?[a-z]?$/i.test(z)) continue;
    let rest = z;
    const k = kette ? PFAND_KETTEN.find(([n]) => n === kette) : null;
    if (k && k[1].test(z)) rest = z.replace(k[1], ' ').trim();
    const w = rest.split(' ').filter(x => /^[A-ZÄÖÜ][a-zäöüß]{2,}$/.test(x));
    if (w.length >= 1 && w.length <= 3 && rest.length <= 30) return w.join(' ');
  }
  return '';
}

// Alles zusammen: ein Foto rein, Felder mit "sicher ja/nein" raus.
// status(p, text): Fortschritt 0..100
async function pfandBildQuelle(datei) {
  // Das Original, nicht neu komprimiert: jede JPEG-Runde kostet einem
  // zerknitterten Barcode die letzten lesbaren Kanten
  const url = URL.createObjectURL(datei);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const w = img.naturalWidth, h = img.naturalHeight;
    const s = Math.min(1, 2400 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}
// opts.drehen: false = nur so lesen, wie das Bild kommt (kein Drehen, kein
// zweiter Anlauf) — fuer den schnellen Blick aus dem Gutschein-Formular
async function pfandScannen(datei, status = () => { }, opts = {}) {
  status(3, 'Lade das Bild …');
  const img = await pfandBildQuelle(datei);
  let e = await pfandScannenBild(img, status, opts);
  // Nichts Brauchbares gelesen? Vielleicht liegt der Bon quer oder auf dem
  // Kopf (ohne lesbaren Strichcode verraet das nur die Schrift)
  if (opts.drehen !== false && !e.istPfand && e.betrag.wert == null) {
    const grad = await pfandLageRaten(img, (p, t) => status(96, t));
    if (grad && grad !== e.gedreht) {
      // Zweiter Anlauf: der Fortschritt laeuft nicht zurueck, er kriecht von 96 bis 99
      const e2 = await pfandScannenBild(pfandDrehen(img, grad), (p, t) => status(96 + p * 0.03, t), { ...opts, lageFest: true });
      if (e2.istPfand || e2.betrag.wert != null) e = { ...e2, gedreht: grad };
    }
  }
  status(100, '');
  return e;
}

// Wie liegt der Bon? Schnelle Texterkennung auf dem ganzen Bild in allen
// vier Lagen; gewinnt eine Lage deutlich (Pfand-Woerter, Kette, Betraege,
// sicher gelesene Woerter), wird gedreht. Sonst 0: lieber nicht drehen.
async function pfandLageRaten(img, status = () => { }) {
  const bewerte = async grad => {
    const q = grad ? pfandDrehen(img, grad) : img;
    // Schwarz-Weiss nach Umgebung: dunkler Hintergrund und Hand stoeren so am wenigsten
    const t = await ocrSeite(pfandOcrVorlage(q, [], { zielBreite: 1100, binaer: true }).canvas, '4');
    const woerter = (t.words || []).filter(w => (w.confidence || 0) >= 70 && /[A-Za-zÄÖÜäöüß]{4,}|\d[.,]\d{2}/.test(w.text || '')).length;
    return pfandWortTreffer(t.text) * 4 + (pfandKetteAus(t.text)?.sicher ? 3 : 0) + Math.min(4, pfandBetraegeAus(t.text).length) + woerter / 4;
  };
  status(90, 'Prüfe, wie der Bon liegt …');
  const basis = await bewerte(0);
  let beste = 0, besterWert = basis;
  for (const g of [180, 90, 270]) {
    const w = await bewerte(g);
    if (w > besterWert) { beste = g; besterWert = w; }
    if (besterWert >= 12) break;   // eindeutig: Pfand-Woerter, Kette und Betrag gelesen
  }
  return besterWert >= Math.max(5, basis * 1.5 + 2) ? beste : 0;
}

async function pfandScannenBild(img, status, opts = {}) {
  // Zwischen den grossen Rechenschritten kurz Luft holen: Fortschritt und
  // Tippen bleiben auch auf langsamen Handys fluessig
  const atmen = () => new Promise(r => setTimeout(r, 0));
  status(8, 'Suche den Code …');
  await atmen();
  let flaechen = findeCodeFlaechen(img);
  let gedreht = 0;
  await atmen();
  const strichcodes = fl => fl.filter(x => x.typ === '1d' && x.width > x.height * 1.6).sort((a, b) => b.score - a.score);
  const staerke = fl => strichcodes(fl)[0]?.score || 0;
  // Schriftzeilen waagrecht (bis 20 Grad schief)? Dann liegt der Bon nicht quer
  const zeilenWaagrecht = t => !!t && t.klar >= 1.42;
  if (opts.drehen !== false && !opts.lageFest && !zeilenWaagrecht(pfandTextWinkel(img))) {
    // Quer liegende Zeilen oder quer liegende Striche (und kein klarer
    // Strichcode in dieser Lage): dann liegt der Bon quer. Ob links- oder
    // rechtsherum, klaeren danach Code-Leserichtung oder Texterkennung.
    const quer = pfandDrehen(img, 90);
    await atmen();
    const fq = findeCodeFlaechen(quer);
    await atmen();
    if (zeilenWaagrecht(pfandTextWinkel(quer)) || (staerke(flaechen) < 30000 && staerke(fq) > Math.max(30000, staerke(flaechen) * 2))) {
      img = quer; flaechen = fq; gedreht = 90;
    }
  }
  // Den Code zuerst im Bild lesen, wie es ist: jedes Drehen kostet Schaerfe
  let code = await pfandCodeLesen(img, flaechen, p => status(8 + p * 15, 'Suche den Code …'));
  // Rueckwaerts oder senkrecht gelesen: der Bon liegt auf dem Kopf oder quer.
  // Gedreht wird nur, wenn der Code danach wieder genauso gelesen wird.
  if (code && code.richtung && opts.drehen !== false && !opts.lageFest) {
    const img2 = pfandDrehen(img, -code.richtung);
    await atmen();
    const fl2 = findeCodeFlaechen(img2);
    const code2 = await pfandCodeLesen(img2, fl2);
    if (code2 && code2.text === code.text && !code2.richtung) {
      img = img2; flaechen = fl2; gedreht = (gedreht + 360 - code.richtung) % 360;
      code = { ...code2, sicher: code.sicher || code2.sicher };
    }
  }
  // Aus diesem Bild kommt der Code-Ausschnitt fuer die Kasse
  let codeBild = img;
  if (opts.drehen !== false) {
    // Schraeg fotografiert: geraderuecken, sonst zerfallen die Zeilen fuer
    // die Texterkennung. Den Winkel verraten die Schriftzeilen (genauer: die
    // Flaeche eines schraegen Strichcodes enthaelt viel Drumherum); sind die
    // nicht eindeutig, die Striche eines klaren Strichcodes.
    const haupt = strichcodes(flaechen)[0];
    const sw = haupt ? pfandStrichWinkel(img, haupt) : null;
    const tw = pfandTextWinkel(img);
    const grad = zeilenWaagrecht(tw) ? tw.grad : sw && sw.klar > 0.8 ? sw.grad : 0;
    if (Math.abs(grad) > 1.5 && Math.abs(grad) < 25) {
      img = pfandDrehen(img, -grad);
      await atmen();
      flaechen = findeCodeFlaechen(img);
      await atmen();
      // Schraeg nicht lesbar? Gerade vielleicht schon
      if (!code && Math.abs(grad) > 3) {
        code = await pfandCodeLesen(img, flaechen, p => status(16 + p * 7, 'Suche den Code …'));
        if (code) codeBild = img;
      }
    }
  }
  const iw = img.width, ih = img.height;
  // Die Code-Flaeche im (geraden) Bild fuer die Texterkennung; der Ausschnitt
  // fuer die Kasse kommt aus dem Bild, in dem der Code gelesen wurde
  const f = (code && codeBild === img ? code.flaeche : null)
    || flaechen.find(x => x.typ === '1d' && x.score > 30000) || flaechen.find(x => x.typ === '2d') || null;
  const fCode = code ? code.flaeche : f;
  status(24, 'Lese den Text … (kann beim ersten Mal etwas dauern)');
  // Nur echte Codes uebermalen — kurze Schriftzeilen sehen fuer den Sucher
  // manchmal auch wie Striche aus ("Lidl lohnt sich.")
  const zuMaskieren = f ? flaechen.filter(x => x === f || (x.height >= f.height * 0.4 && x.score >= f.score * 0.3)) : [];
  const bereich = pfandOcrBereich(img, f);
  const graus = await ocrSeite(pfandOcrVorlage(img, zuMaskieren, { bereich }).canvas, '4');
  status(46, 'Lese den Text …');
  const binaer = await ocrSeite(pfandOcrVorlage(img, zuMaskieren, { binaer: true, bereich }).canvas, '4');
  status(66, 'Lese Betrag und Code …');
  const balkenTexte = [];
  let bonZeile = '', ziffern = '', ziffern2 = '', fuss = '', fuss2 = '';
  if (f) {
    // Betrag im schwarzen Balken ueber dem Code, die Bon-Nr. direkt darueber
    const balken = pfandBalkenFinden(img, f);
    if (balken) {
      // Vier Lesungen in leicht verschiedenen Groessen, die Mehrheit zaehlt.
      // Um 40 px Zeilenhoehe liest Tesseract am sichersten: groesser
      // hochgezogen wird aus der Punktschrift eines kleinen Fotos gern eine
      // falsche Ziffer (Kaufland "6,53" → "6,93"). Ziffern fuellen den Balken
      // oft bis an die Kante: nichts Hohes wegwerfen.
      for (const zielHoehe of [36, 40, 44, 48]) {
        balkenTexte.push((await ocrZeile(zeilenVorlage(img, balken, { umkehren: true, hochBehalten: true, zielHoehe }), '')).text);
      }
      // Nicht umgekehrt: der Balken selbst faellt als grosse Flaeche weg, die
      // Bon-Nr. darueber (oder daneben, wenn der Balken eine Stufe hat) bleibt
      const oben = Math.max(0, balken.y - balken.height * 0.9);
      const rund = { x: balken.x, y: oben, width: balken.width, height: balken.y + balken.height - oben };
      bonZeile = (await ocrSeite(zeilenVorlage(img, rund, { zielHoehe: 170 }), '6')).text;
    }
    status(78, 'Lese die Ziffern unter dem Code …');
    // Ziffern unter dem Code: Ersatz, wenn der Code selbst nicht lesbar war,
    // sonst Gegenprobe
    const zeile = pfandZiffernZeile(img, f) || {
      x: Math.max(0, f.x - f.width * 0.05), y: Math.min(ih - 2, f.y + f.height * 0.97),
      width: Math.min(f.width * 1.1, iw - Math.max(0, f.x - f.width * 0.05)), height: Math.min(f.height * (f.typ === '1d' ? 0.22 : 0.16), ih - Math.min(ih - 2, f.y + f.height * 0.97)),
    };
    if (zeile.height > 5) {
      ziffern = (await ocrZeile(zeilenVorlage(img, zeile, { zielHoehe: 56 }), '0123456789')).text.replace(/\D/g, '');
      if (!code && ziffern.length >= 10) ziffern2 = (await ocrZeile(zeilenVorlage(img, zeile, { zielHoehe: 84 }), '0123456789')).text.replace(/\D/g, '');
    }
    status(88, 'Lese Datum und Automat …');
    // Unter dem Code stehen Automat, Datum und bei manchen Bons die Summe
    // (direkt unter dem Code: bei EDEKA steht dort gleich die Summe)
    const fy = f.y + f.height * (f.typ === '1d' ? 1.05 : 1.12);
    const fh = Math.min(ih - fy, f.height * (f.typ === '1d' ? 2.4 : 0.6));
    const fx = Math.max(0, f.x - f.width * 0.15), fw = Math.min(iw - fx, f.width * 1.3);
    if (fh > 12 && fw > 40) {
      const c = zeilenVorlage(img, { x: fx, y: fy, width: fw, height: fh }, { zielHoehe: Math.min(1000, fh * Math.max(1, 1300 / fw)) });
      fuss = (await ocrSeite(c, '6')).text;
      // Zweite Lesung in Graustufen und enger (nur das Papier): die duenne
      // Punktschrift von Automat und Datum zerfaellt im harten Schwarz-Weiss,
      // wenn daneben eine Hand im Bild ist (EDEKA "09:52:49 08-JUL-2023")
      const ex = Math.max(0, f.x - f.width * (f.typ === '1d' ? 0.03 : 0.3));
      const eb = { x: ex, y: fy, width: Math.min(iw - ex, f.width * (f.typ === '1d' ? 1.06 : 1.6)), height: fh };
      fuss2 = (await ocrSeite(pfandOcrVorlage(img, [], { bereich: eb, zielBreite: 1300 }).canvas, '6')).text;
    }
  }
  status(96, 'Fast fertig …');
  const e = pfandAuswerten({ graus, binaer, balkenTexte, bonZeile, ziffern, ziffern2, fuss, fuss2, code });
  // Kassen-Code: der Code samt Ziffern darunter, auf weissem Grund. Wurde der
  // Code gelesen, muss ihn ZXing auch aus dem fertigen (komprimierten) Bild
  // wieder lesen — sonst liest ihn die Kasse womoeglich auch nicht. Zu viel
  // Rand (Hand, Tischdecke) stoert dabei am meisten.
  let codeImg = '', codeBildGeprueft = false;
  if (fCode) {
    const unten = fCode.typ === '1d' ? 0.2 : 0.16;
    const versuche = [{ rand: 0.03, ziel: 1100, unten }];
    if (code) {
      const p = code.param || { rand: 0.015, ziel: 1000 };
      versuche.unshift({ ...p, unten }, { ...p, unten: 0 });
      versuche.push(...(fCode.typ === '1d' ? [[0.015, 1000], [0.015, 1500], [0.04, 1200]] : [[0.03, 800], [0.06, 1100]])
        .map(([rand, ziel]) => ({ rand, ziel, unten: 0 })));
    }
    const quelle = code ? codeBild : img;
    let erstes = '';
    for (const v of versuche) {
      let url = '';
      try { url = kodiereBild(codeAusschnitt(quelle, fCode, v), 'code'); } catch { continue; }
      if (!erstes) erstes = url;
      if (!code) break;
      if (await codeBildLiest(url, code.text)) { codeImg = url; codeBildGeprueft = true; break; }
    }
    codeImg = codeImg || erstes;
  }
  return { ...e, codeImg, codeBildGeprueft, gedreht, rohtext: [graus.text, binaer.text, balkenTexte.join(' | '), bonZeile, ziffern, fuss, fuss2].join('\n') };
}

// Betrag aus einer Balken-Lesung ("€13.47", "€ 9.75", "Summe: 6,53 EUR")
function pfandBalkenBetrag(t) {
  const m = pfandZiffernText(t).match(/(\d{1,3})\s?[.,]\s?(\d{2})(?!\d)/);
  return m ? pfandZahl(m[1] + '.' + m[2]) : null;
}
// Typische Verwechsler der Texterkennung in Betraegen: O/o → 0, l/I/| → 1,
// S/s → 5, B → 8, Z → 2 — nur innerhalb von Zahlen wie "13.4O" oder "S7,29"
// (mindestens zwei echte Ziffern), Woerter bleiben unangetastet
function pfandZiffernText(t) {
  return String(t || '').replace(/(^|[^A-Za-zÄÖÜäöüß])([0-9OoIl|SsBZ]{1,3})(\s?[.,]\s?)([0-9OoIl|SsBZ]{2})(?![A-DF-Za-zÄÖÜäöüß0-9])/g, (m, vor, a, sep, b) => {
    if ((a + b).replace(/\D/g, '').length < 2) return m;
    const z = x => x.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/[Ss]/g, '5').replace(/B/g, '8').replace(/Z/g, '2');
    return vor + z(a) + sep + z(b);
  });
}
// Summenprobe: ist ziel die Summe von mindestens zwei anderen gelesenen
// Betraegen (Posten, Zwischensummen)? "0,48 + 0,30 + 5,75 = 6,53" bestaetigt
// die Summe unabhaengig von ihrer eigenen Lesung. Rechnet nur nach, erfindet nichts.
function pfandSummenprobe(ziel, werte) {
  const cent = Math.round(ziel * 100);
  const w = [...new Set(werte.map(x => Math.round(x * 100)))].filter(x => x > 0 && x < cent).slice(0, 16);
  const erreicht = new Map([[0, 0]]);   // Summe → groesste Zahl an Posten
  for (const x of w) {
    for (const [s, n] of [...erreicht]) {
      const t = s + x;
      if (t <= cent && (erreicht.get(t) ?? -1) < n + 1) erreicht.set(t, n + 1);
    }
  }
  return (erreicht.get(cent) || 0) >= 2;
}

// Felder aus allen Lesungen. Jedes Feld: { wert, sicher, hinweis }
function pfandAuswerten({ graus, binaer, balkenTexte = [], balkenText = '', balkenText2 = '', bonZeile = '', ziffern = '', ziffern2 = '', fuss = '', fuss2 = '', code = null }) {
  // Zeichen, die die Texterkennung gern einsetzt: "Steglıtz" (punktloses i)
  // schnitte den Ort sonst mitten im Wort ab, "6‚25" (tiefes Anfuehrungszeichen)
  const glatt = t => String(t || '').replace(/ı/g, 'i').replace(/ſ/g, 's').replace(/[‚„]/g, ',');
  graus = { ...graus, text: glatt(graus.text) };
  binaer = { ...binaer, text: glatt(binaer.text) };
  fuss = glatt(fuss); fuss2 = glatt(fuss2); bonZeile = glatt(bonZeile);
  balkenTexte = [...balkenTexte, balkenText, balkenText2].filter(Boolean).map(glatt);
  const texte = [graus.text || '', binaer.text || '', fuss || '', fuss2 || ''];
  const alles = [...texte, ...balkenTexte, bonZeile].join('\n');
  const aus = {};
  // Code: gelesen (abgestimmt) > Ziffern darunter
  const zerlegt = pfandCodeZerlegen(code?.text);
  const zerlegtZiffern = ziffern === ziffern2 ? pfandCodeZerlegen(ziffern) : null;
  // Ziffern ohne lesbaren Code zaehlen nur, wenn zwei Lesungen gleich sind
  // (sonst bleibt das Feld leer — das Bild vom Code reicht an der Kasse)
  const zifferOk = ziffern.length >= 10 && ziffern === ziffern2;
  if (code) aus.code = { wert: code.text, format: code.format, sicher: code.sicher || code.text === ziffern };
  else if (zifferOk) aus.code = { wert: ziffern, format: '', sicher: false, hinweis: 'aus den Ziffern unter dem Code gelesen' };
  else aus.code = { wert: '', format: '', sicher: false };
  const tomra = zerlegt || zerlegtZiffern;
  // Betrag: Code > Balken > Summe > €-Zeichen > groesster Posten.
  // lesung = aus welcher Lesung ein Kandidat stammt: "Summe" und "groesster
  // Posten" aus DERSELBEN Texterkennung sind keine zwei Belege.
  const kandidaten = [];
  if (zerlegt) kandidaten.push({ wert: zerlegt.betrag, quelle: 'code', lesung: 'code', gewicht: code.sicher ? 5 : 3, stark: true });
  else if (zerlegtZiffern) kandidaten.push({ wert: zerlegtZiffern.betrag, quelle: 'ziffern', lesung: 'ziffern', gewicht: 1 });
  // Im Balken steht der Betrag allein ("€13.47"); das €-Zeichen verliert die
  // OCR oft. Mehrere Lesungen desselben Balkens: die Mehrheit zaehlt, und nur
  // wenn alle (mindestens drei) dasselbe sagen, ist der Balken allein ein Beleg
  const balkenWerte = balkenTexte.map(pfandBalkenBetrag).filter(x => x != null && x > 0 && x < 1000);
  const proBalken = new Map();
  balkenWerte.forEach(w => proBalken.set(w.toFixed(2), (proBalken.get(w.toFixed(2)) || 0) + 1));
  const balkenEinig = balkenWerte.length >= 3 && proBalken.size === 1 ? balkenWerte[0].toFixed(2) : '';
  for (const [k, n] of proBalken) {
    const mehrheit = n * 2 > balkenWerte.length;
    kandidaten.push({ wert: +k, quelle: 'balken', lesung: 'balken', gewicht: 0.7 * n, stark: mehrheit && n >= 2, beleg: mehrheit && n >= 2 });
  }
  // Auf einem Pfandbon ist die Gesamtsumme der groesste Betrag: Posten und
  // Zwischensummen (Mehrweg, Einweg) sind Teile davon
  const alleBetraege = [];
  texte.forEach((t, i) => {
    const b = pfandBetraegeAus(t);
    alleBetraege.push(...b.map(x => x.wert));
    const q = ['text0', 'text1', 'fuss', 'fuss2'][i];
    const summen = b.filter(x => x.quelle === 'summe');
    if (summen.length) kandidaten.push({ wert: Math.max(...summen.map(x => x.wert)), quelle: q, lesung: q, gewicht: 1.5, stark: true });
    b.filter(x => x.quelle === 'euro').forEach(x => kandidaten.push({ wert: x.wert, quelle: q, lesung: q, gewicht: 1.2, stark: true }));
    if (b.length) kandidaten.push({ wert: Math.max(...b.map(x => x.wert)), quelle: q + '-max', lesung: q, gewicht: 0.6 });
  });
  const proWert = new Map();
  for (const k of kandidaten) {
    if (k.wert == null) continue;
    const key = k.wert.toFixed(2);
    const e = proWert.get(key) || { wert: k.wert, gewicht: 0, quellen: new Set(), lesungen: new Set(), stark: 0 };
    e.gewicht += k.gewicht; e.quellen.add(k.quelle);
    // Eine einzelne Balken-Lesung ist kein eigener Beleg (nur die Mehrheit)
    if (k.lesung !== 'balken' || k.beleg) e.lesungen.add(k.lesung);
    if (k.stark) e.stark++;
    proWert.set(key, e);
  }
  // Mehr als 250 € Pfand auf einem Bon (1000 Flaschen) ist ein Lesefehler
  // ("56,50" → "556,5"): zaehlt kaum und nie als groesster Betrag
  const plausibel = x => x > 0 && x <= 250;
  const lesbar = alleBetraege.filter(plausibel);
  const hoechster = lesbar.length ? Math.max(...lesbar) : 0;
  for (const e of proWert.values()) {
    // Summenprobe: passen die gelesenen Posten zusammen genau zu einem
    // Kandidaten, ist das ein eigener, unabhaengiger Beleg
    if (pfandSummenprobe(e.wert, lesbar.filter(x => Math.abs(x - e.wert) > 0.001))) {
      e.gewicht += 2; e.quellen.add('summenprobe'); e.lesungen.add('summenprobe');
    }
    if (e.quellen.has('code')) continue;
    if (!plausibel(e.wert)) e.gewicht *= 0.3;
    // Kleiner als ein anderer gelesener Posten: kann nicht die Gesamtsumme sein
    // (eher die Mehrweg-Zwischensumme oder ein Posten)
    else if (e.wert < hoechster - 0.001) e.gewicht *= 0.5;
  }
  const betraege = [...proWert.values()].sort((a, b) => b.gewicht - a.gewicht || b.wert - a.wert);
  const bester = betraege[0];
  // Die Gesamtsumme ist der groesste Betrag auf dem Bon: steht irgendwo ein
  // groesserer, ist der gewaehlte vielleicht nur eine Zwischensumme
  // ("Mehrweg: Summe 0,79") — dann nie "sicher", ausser der Code sagt es
  const groesserGelesen = bester && lesbar.some(x => x > bester.wert + 0.001);
  aus.betrag = bester
    ? {
      wert: bester.wert,
      // sicher: aus einem sauber gelesenen Code, alle Balken-Lesungen einig, oder
      // zwei unabhaengige Lesungen sagen dasselbe (der groesste Betrag allein reicht nie)
      sicher: (bester.quellen.has('code') && !!code?.sicher) || (!groesserGelesen && (
        (balkenEinig === bester.wert.toFixed(2) && !betraege.slice(1).some(x => x.stark >= 1 && x.gewicht >= 1.5))
        || (bester.stark >= 1 && bester.lesungen.size >= 2))),
      quellen: [...bester.quellen],
      andere: betraege.slice(1, 3).map(x => x.wert),
    }
    : { wert: null, sicher: false };
  // Bon-Nr.: Text (Zeile ueber dem Balken zuerst), gegengeprueft mit dem Tomra-Code
  const nrListe = [pfandBonNrAus(bonZeile), pfandBonNrAus(graus.text), pfandBonNrAus(binaer.text)].filter(Boolean);
  const nrText = nrListe[0] || '';
  if (tomra && (zerlegt ? code.sicher : nrListe.includes(tomra.bon))) aus.bonNr = { wert: tomra.bon, sicher: true };
  else if (nrText) aus.bonNr = { wert: nrText, sicher: nrListe.filter(x => x === nrText).length >= 2 };
  else aus.bonNr = { wert: '', sicher: false };
  // Die Ziffern unter dem Code passen zu Bon-Nr. UND Betrag? Dann stimmen sie
  if (!code && zerlegtZiffern && aus.bonNr.wert === zerlegtZiffern.bon && aus.betrag.wert === zerlegtZiffern.betrag) {
    aus.code.sicher = true;
    aus.code.hinweis = 'passt zu Bon-Nr. und Betrag';
    aus.betrag.sicher = true;
  }
  if (aus.betrag.wert != null && tomra && (zerlegt || aus.code.sicher) && Math.abs(tomra.betrag - aus.betrag.wert) > 0.001) aus.betrag.sicher = false;
  // Kette
  const kette = pfandKetteAus(alles);
  aus.kette = kette ? { wert: kette.name, sicher: kette.sicher } : { wert: '', sicher: false };
  // Anschrift: beide Lesungen, die vollstaendigere gewinnt; weichen sie ab: pruefen
  const a1 = pfandAnschriftAus(graus.text), a2 = pfandAnschriftAus(binaer.text);
  // Gleich vollstaendig? Dann die Lesung, bei der sich die OCR sicherer war
  const sicherheit = (words, teile) => {
    const w = teile.join(' ').split(/\s+/).filter(x => x.length >= 2)
      .map(t => (words || []).find(x => (x.text || '').includes(t))?.confidence ?? 0);
    return w.length ? w.reduce((x, y) => x + y, 0) / w.length : 0;
  };
  // Feld fuer Feld: die Lesung, bei der sich die OCR sicherer war
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
  // Ziffern (Hausnummer, PLZ): beide Lesungen stammen aus denselben Pixeln und
  // irren gern gemeinsam ("Damm 95" → zweimal "90"). Sicher nur, wenn die OCR
  // sich bei den Ziffern in beiden Lesungen auch selbst sicher war.
  const zifferSicherheit = (words, wert) => {
    const z = String(wert || '').match(/\d+/g);
    if (!z) return 100;
    return Math.min(...z.map(t => (words || []).find(w => (w.text || '').includes(t))?.confidence ?? 0));
  };
  // Beruehrt das Wort den Rand des Lese-Ausschnitts, ist es vielleicht
  // abgeschnitten ("Berlin-Stegl"): dann nie sicher, auch wenn beide Lesungen
  // es gleich abschneiden
  const amRand = (lesung, wert) => {
    const b = lesung.breite, t = String(wert || '').split(/\s+/).filter(Boolean);
    if (!b || !t.length) return false;
    const finde = x => (lesung.words || []).find(w => w.bbox && (w.text || '').includes(x));
    const a = finde(t[0]), z = finde(t[t.length - 1]);
    return (!!a && a.bbox.x0 < b * 0.015) || (!!z && z.bbox.x1 > b * 0.985);
  };
  const waehle = (feld, bonus = () => 0) => {
    const x1 = a1[feld], x2 = a2[feld];
    if (!x1 || !x2) return { wert: x1 || x2 || '', sicher: false };
    if (norm(x1) === norm(x2)) {
      return {
        wert: x1,
        sicher: zifferSicherheit(graus.words, x1) >= 90 && zifferSicherheit(binaer.words, x2) >= 90 && !amRand(graus, x1) && !amRand(binaer, x2),
      };
    }
    const s1 = sicherheit(graus.words, [x1]) + bonus(x1), s2 = sicherheit(binaer.words, [x2]) + bonus(x2);
    return { wert: s1 >= s2 ? x1 : x2, sicher: false };
  };
  // Eine Strasse mit Endung ("…str.", "Damm") schlaegt eine ohne; die laengere
  // schlaegt die kuerzere (die OCR verliert eher Buchstaben, als dass sie welche erfindet)
  aus.strasse = waehle('strasse', x => (STRASSEN_ENDE.test(x) ? 20 : 0) + Math.min(20, x.length));
  aus.plz = waehle('plz');
  aus.ort = waehle('ort');
  if (aus.ort.sicher && (!a1.ortGanz || !a2.ortGanz)) aus.ort.sicher = false;
  const a = { strasse: aus.strasse.wert, plz: aus.plz.wert, ort: aus.ort.wert };
  // Filialname; bei "Kaufland Leipzig" ohne Anschrift wird die Stadt zum Ort
  // Nur mit Anschrift: ohne sie ist "die Zeile ueber der Anschrift" geraten
  const mitAnschrift = !!(a.plz || a.strasse) || ['Kaufland', 'Globus', 'Marktkauf', 'real'].includes(kette?.name);
  const name = mitAnschrift ? (pfandFilialNameAus(graus.text, kette?.name, a) || pfandFilialNameAus(binaer.text, kette?.name, a)) : '';
  aus.filialName = { wert: name, sicher: !!name && pfandFilialNameAus(graus.text, kette?.name, a) === pfandFilialNameAus(binaer.text, kette?.name, a) };
  if (!aus.ort.wert && name && kette && ['Kaufland', 'Globus', 'Marktkauf', 'real'].includes(kette.name)) {
    aus.ort = { wert: name, sicher: false, hinweis: 'aus dem Namen der Filiale' };
    aus.filialName = { wert: '', sicher: false };
  }
  // Datum: stimmen zwei Lesungen ueberein, gilt es als sicher
  // Datum: stimmen zwei Lesungen ueberein, gilt es als sicher — ausser in der
  // Punktschrift der Automaten ("21-DEZ-2019"), da wird aus 9 gern eine 5
  const zaehl = new Map(), punkt = new Set();
  texte.forEach(t => {
    const d = pfandDatumAus(t);
    d.forEach(x => { if (x.quelle === 'monat') punkt.add(x.iso); });
    new Set(d.map(x => x.iso)).forEach(iso => zaehl.set(iso, (zaehl.get(iso) || 0) + 1));
  });
  const daten = [...zaehl.entries()].sort((x, y) => y[1] - x[1]);
  const datum = daten[0];
  // Zwei Lesungen, zwei verschiedene Daten, keins haeufiger: das waere
  // geraten ("08-JUL" als 05 und 06 gelesen) — dann lieber leer lassen
  // Punktschrift der Automaten ("08-JUL-2023") aus nur einer Lesung: 8, 5 und
  // 6 sehen dort gleich aus — auch dann leer statt geraten
  aus.datum = datum && !(daten[1] && daten[1][1] === datum[1]) && !(punkt.has(datum[0]) && datum[1] < 2)
    ? { wert: datum[0], sicher: datum[1] >= 2 && zaehl.size === 1 && !punkt.has(datum[0]) }
    : { wert: '', sicher: false };
  aus.istPfand = pfandIstBon(alles, code?.text);
  return aus;
}

// Ist das ein Pfandbon? Starke Merkmale reichen allein (Leergutbon, Pfandbon,
// Pfandartikel, Tomra/SiVario). Auf einem Gutschein steht dagegen gern "nicht
// einlösbar für Pfand, Leergut und Flaschen" — mit Gutschein-Woertern zaehlen
// die schwachen Merkmale nicht, und ein 19-stelliger Code mit "2" vorn allein
// auch nicht (Geschenkkarten-Nummern sehen manchmal genauso aus).
const PFAND_STARK = /l[e3]{2}rg[uv]t\s?-?\s?b[o0]n|pfand\s?-?\s?b[o0]n|pfandartikel|bepfandet|tomra|sivario|leergutautomat/i;
const GUTSCHEIN_WORTE = /gutschein|geschenk|guthaben|\bpin\b|karten\s?-?\s?n(?:r|ummer)|g[uü]ltig\s+bis|aufladen|wertkarte|gift\s?card/i;
function pfandIstBon(text, codeText = '') {
  const t = String(text || '');
  if (PFAND_STARK.test(t)) return true;
  if (GUTSCHEIN_WORTE.test(t)) return false;
  return /l[e3]{2}rg[uv]t/i.test(t) || pfandWortTreffer(t) >= 2 || !!pfandCodeZerlegen(codeText);
}

// Schneller Verdacht aus dem normalen Gutschein-Scan: Leergut-Woerter oder ein
// Tomra-Code. Reicht das nicht, entscheidet pfandScannen (istPfand).
function pfandVermutet(r) {
  return pfandIstBon(r?.text, r?.barcode);
}

// Große, interaktive Shop-Auswahl beim Hinzufügen (erst 6, Rest hinter "Weitere")
const VENDOR_GRID = ['REWE', 'Amazon', 'Wunschgutschein', 'Zalando', 'IKEA', 'Rossmann', 'Lidl', 'EDEKA', 'Netto', 'dm', 'Müller', 'MediaMarkt', 'H&M', 'Douglas', 'Nike', 'Anderer Gutschein'];
// Rabattcodes: vor allem Lieferdienste und Online-Shops
const RABATT_GRID = ['Lieferando', 'Uber Eats', 'Wolt', 'Subway', "McDonald's", 'Burger King', "Domino's", 'Zalando', 'About You', 'Amazon', 'Otto', 'Shein', 'Temu', 'Nike', 'Anderer Shop'];
const ANDERE_SHOPS = new Set(['Anderer Gutschein', 'Anderer Shop']);
const CARD_GRID = ['Payback', 'DeutschlandCard', 'Lidl Plus', 'IKEA Family', 'Rossmann', 'REWE', 'dm', 'Andere Karte'];

// Marken-Logos über den Favicon-Dienst, Initialen bleiben als Fallback darunter
const BRAND_DOMAINS = {
  rewe: 'rewe.de', amazon: 'amazon.de', wunschgutschein: 'wunschgutschein.de',
  zalando: 'zalando.de', ikea: 'ikea.com', rossmann: 'rossmann.de', lidl: 'lidl.de',
  edeka: 'edeka.de', netto: 'netto-online.de', dm: 'dm.de', 'müller': 'mueller.de',
  mediamarkt: 'mediamarkt.de', 'h&m': 'hm.com', douglas: 'douglas.de', nike: 'nike.com',
  payback: 'payback.de', wolt: 'wolt.com', lieferando: 'lieferando.de', spotify: 'spotify.com',
  // DeutschlandCard nur mit www.: ohne liefert der Logo-Dienst einen 404 (Konsolenfehler)
  deutschlandcard: 'www.deutschlandcard.de', 'lidl plus': 'lidl.de', 'ikea family': 'ikea.com',
  aldi: 'aldi-sued.de', penny: 'penny.de', norma: 'norma-online.de', kaufland: 'kaufland.de',
  globus: 'globus.de', tegut: 'tegut.com', otto: 'otto.de', ebay: 'ebay.de', temu: 'temu.com',
  adidas: 'adidas.de', zara: 'zara.com', shein: 'shein.com', saturn: 'saturn.de',
  mcdonalds: 'mcdonalds.com', 'burger king': 'burgerking.de', subway: 'subway.com',
  netflix: 'netflix.com', disney: 'disneyplus.com', 'uber eats': 'ubereats.com',
  "mcdonald's": 'mcdonalds.com', "domino's": 'dominos.de', 'about you': 'aboutyou.de', 'peter pane': 'peterpane.de',
};
// Logos in hoher Aufloesung vom Nutzer (public/brand/logos, 384 px, quadratisch
// mit durchsichtigem Rand). Fuer alle anderen Marken bleibt der Favicon-Dienst.
const MARKEN_LOGOS = {
  rossmann: 'rossmann', ikea: 'ikea', 'ikea family': 'ikea', subway: 'subway', lieferando: 'lieferando',
  kaufland: 'kaufland', mcdonalds: 'mcdonalds', "mcdonald's": 'mcdonalds', 'burger king': 'burger-king',
  netto: 'netto', edeka: 'edeka', dm: 'dm', lidl: 'lidl', 'lidl plus': 'lidl', 'müller': 'mueller',
  mueller: 'mueller', wolt: 'wolt', 'peter pane': 'peter-pane', amazon: 'amazon', 'amazon.de': 'amazon',
  peepoplush: 'peepoplush',
};
// Maskottchen der Marken fuer das Feed-Banner: ragt oben aus dem Fenster wie
// Kumulio in der Wallet. Schluessel wie die Dateinamen in MARKEN_LOGOS
// (Aliasse wie 'lidl plus' laufen dort mit). Bild: public/brand/marken/
// <name>-480.webp und -960.webp, auf den Inhalt zugeschnitten, durchsichtig.
// ar = Breite / Hoehe des Bildes, oben = Anteil der Bildhoehe ueber der
// Fensterkante (hoechstens 46 px, --fh-luft in look.css — sonst wird der Kopf
// oben abgeschnitten), licht = Mitte der Strahlen hinter dem Kopf (Anteile des
// Bildes). Neue Marken einfach dazuschreiben.
const MARKEN_MASKOTTCHEN = {
  wolt: { basis: '/brand/marken/wolt-maskottchen', ar: 0.7136, oben: 0.2, licht: [0.44, 0.36] },  // Yuho
};
function markenMaskottchen(name) {
  const key = String(name || '').toLowerCase().trim();
  const datei = Object.hasOwn(MARKEN_LOGOS, key) ? MARKEN_LOGOS[key] : key;
  return Object.hasOwn(MARKEN_MASKOTTCHEN, datei) ? MARKEN_MASKOTTCHEN[datei] : null;
}
function markenLogoUrl(name, px = 64) {
  const key = String(name || '').toLowerCase().trim();
  if (MARKEN_LOGOS[key]) return `/brand/logos/${MARKEN_LOGOS[key]}.webp`;
  const domain = BRAND_DOMAINS[key];
  return domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${px}` : '';
}
// gross = true holt das Logo in 128 px (fuer grosse Flaechen wie im Feed-Banner).
// Laedt es nicht, nimmt der Chip auch "hat-logo" weg — sonst blieben die
// Initialen darunter unsichtbar (transparente Schrift) und der Chip leer.
function brandChipHtml(name, gross = false) {
  const px = gross ? 128 : 64;
  const url = markenLogoUrl(name, px);
  const logo = url
    ? `<img class="brand-logo" src="${esc(url)}" alt=""
         loading="lazy" decoding="async" fetchpriority="low" width="${px}" height="${px}" onerror="this.parentNode?.classList.remove('hat-logo');this.remove()">`
    : '';
  // Mit Logo traegt der Chip Weiss statt Markenfarbe — sonst blitzt an den
  // Rundungen ein farbiger Rand um das Bild
  return `<span class="brand-chip${logo ? ' hat-logo' : ''}" style="--bc:${brandColor(name)}">${logo}${esc(brandInitials(name))}</span>`;
}

// =============================================================================
// Hinzufuegen als eigene Seite (Runde 118). Gleitet von rechts herein wie
// Gutschein, Verschenken und Analyse (wseiteOeffnen): oben der Umschalter
// Gutschein | Rabattcode, darunter die Karte, wie sie gleich in der Wallet
// liegt — sie waechst beim Ausfuellen mit —, dann Foto oder Screenshot, der
// Shop und die Felder. Gespeichert wird fest unten in der Leiste.
// =============================================================================
function waSeiteOben() { const o = wseiteOben(); return o && o.art === 'hinzufuegen' ? o : null; }
function waOffen() { return !!waSeiteOben(); }
function waInhalt() { return waSeiteOben()?.el.querySelector('.wseite-inhalt') || null; }
// Was die offene Seite nach aussen anbietet (Ergaenzen-Warteschlange, Teilen):
// { seite, bild(src), shop(name), aktualisieren(), hinweis(art, html) } —
// ausSchlange: das Formular kam aus der Ergaenzen- oder Teilen-Warteschlange
let waApi = null;

// Bekannte Marken fuer die Suche hinter "Weitere". Nur Vorschlaege —
// eintippen laesst sich jeder Name.
const WA_SHOPS_EXTRA = ['ALDI', 'PENNY', 'Kaufland', 'Globus', 'tegut', 'NORMA', 'Saturn', 'Otto', 'eBay',
  'Adidas', 'Zara', 'Shein', 'Temu', 'Spotify', 'Netflix', 'Steam', 'Nintendo eShop', 'Deutsche Bahn', 'Peter Pane'];
function waShopListe(art) {
  const basis = art === 'card' ? CARD_GRID : art === 'rabatt' ? RABATT_GRID : art === 'pfand' ? PFAND_GRID : VENDOR_GRID;
  const weitere = art === 'card'
    ? [...(cardCouponList || []).map(c => c && c.brand), ...VENDOR_GRID]
    : art === 'rabatt' ? [...VENDOR_GRID, ...WA_SHOPS_EXTRA]
    : art === 'pfand' ? [...WA_SHOPS_EXTRA, ...VENDOR_GRID] : [...WA_SHOPS_EXTRA, ...RABATT_GRID];
  const gesehen = new Set();
  return [...basis, ...weitere].filter(n => {
    if (!n || ANDERE_SHOPS.has(n) || n === 'Andere Karte') return false;
    const k = n.toLowerCase();
    if (gesehen.has(k)) return false;
    gesehen.add(k);
    return true;
  });
}
// Lange Namen brechen in der Kachel an einer sinnvollen Stelle um
function waKachelName(n) {
  return esc(n).replace('Wunschgutschein', 'Wunsch&shy;gutschein').replace('DeutschlandCard', 'Deutschland&shy;Card');
}

// Vorschau: dieselbe Karte wie in der Wallet. Leere Felder zeigen Platzhalter
// (grau, "Shop", "0,00 €") statt geratener Werte.
const WA_LEER_FARBE = '#7B8794';
const waLeerChip = () => `<span class="brand-chip wa-chip-leer">${icon('tag')}</span>`;
function waTag(iso) {
  const d = iso ? new Date(iso + 'T12:00:00') : null;
  return d && !isNaN(d) ? d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
}
function waGutscheinKarteHtml(d) {
  const leer = !d.vendor;
  const farbe = leer ? WA_LEER_FARBE : brandColor(d.vendor);
  const tag = waTag(d.end);
  const fuss = tag
    ? (Date.parse(d.end + 'T23:59:59') < Date.now() ? `abgelaufen am ${tag}` : `Gültig bis ${tag}`)
    : `hinzugefügt ${waTag(new Date().toISOString().slice(0, 10))}`;
  return `
    <div class="wallet-card vk has-fill${leer ? ' wa-leer' : brandHelligkeit(farbe) > 0.62 ? ' hell' : ''}"
      style="--bc:${farbe}; --tc:${leer ? '#fff' : brandTextColor(d.vendor)}; --fill:100%">
      <span class="vk-motiv" aria-hidden="true">${leer ? '' : vkMotivHtml({ vendor: d.vendor })}</span>
      <span class="vk-logo">${leer ? waLeerChip() : brandChipHtml(d.vendor)}</span>
      <div class="vk-text">
        <b class="wallet-card-name${leer ? ' wa-platzhalter' : ''}">${esc(d.vendor || 'Shop')}</b>
        <span class="vk-art">Gutschein</span>
        ${d.pin ? `<span class="vk-pin">PIN ${esc(d.pin)}</span>` : ''}
      </div>
      <div class="vk-rechts"><span class="wallet-card-balance${d.amount == null ? ' wa-platzhalter' : ''}">${euroFmt(d.amount ?? 0)}</span></div>
      <div class="vk-fuss"><span>${fuss}</span></div>
    </div>`;
}
function waRabattKarteHtml(d) {
  const leer = !d.vendor;
  const farbe = leer ? WA_LEER_FARBE : brandColor(d.vendor);
  const n = rabattZahl(d.rabatt);
  const wert = n == null ? (d.rabattArt === 'pct' ? '0 %' : '0,00 €')
    : d.rabattArt === 'pct' ? `−${String(n).replace('.', ',')} %` : `−${euroFmt(n)}`;
  const status = d.end ? (rabattAbgelaufen(d) ? 'abgelaufen' : 'bis ' + new Date(d.end).toLocaleDateString('de-DE')) : '';
  return `
    <div class="wallet-card rc-card${leer ? ' wa-leer' : brandHelligkeit(farbe) > 0.62 ? ' hell' : ''}"
      style="--bc:${farbe}; --tc:${leer ? '#fff' : brandTextColor(d.vendor)}">
      <div class="wallet-card-head">
        ${leer ? waLeerChip() : brandChipHtml(d.vendor)}
        <span class="wallet-card-name${leer ? ' wa-platzhalter' : ''}">${esc(d.vendor || 'Shop')}</span>
        <span class="wallet-card-balance${n == null ? ' wa-platzhalter' : ''}">${esc(wert)}</span>
      </div>
      <div class="wallet-card-sub">
        <span class="rc-code${d.code ? '' : ' wa-platzhalter'}">${esc(d.code || 'Ohne Code')}</span>
        <span class="pill">${rabattMbwText(d)}</span>
        ${status ? `<span class="pill">${status}</span>` : ''}
      </div>
    </div>`;
}
function waSparkarteHtml(d) {
  const html = sparkarteHtml({ id: 'wa-vorschau', name: d.name || 'Karte', number: d.number, codeImg: d.codeImg, img: d.img });
  return d.name ? html : html.replace('class="debitkarte ', 'class="debitkarte wa-leer ');
}

// bearbeiteId: dann wird eine vorhandene Sparkarte (oder ein Rabattcode)
// geaendert statt neu angelegt. Alles andere bleibt gleich — nur der Titel,
// die Vorbelegung und das Speichern unterscheiden sich.
function openWalletAdd(type, prefillName, bearbeiteId, opts = {}) {
  // Pfandbons haben ein eigenes Formular (Filiale, Standort, Bon-Angaben)
  if (type === 'pfand') return openPfandAdd(prefillName, bearbeiteId, opts);
  if (!state.token) { switchView('profile'); island('Für die Wallet bitte anmelden'); return; }
  if (walletGesperrt()) { aktualisiereSperre(); return; } // gesperrte Wallet: nichts zeigen
  waSaving = false;
  addType = type === 'card' || type === 'rabatt' ? type : 'voucher';
  addPrefill = prefillName || '';
  addEditId = bearbeiteId || '';
  const bearbeitet = !addEditId ? null
    : addType === 'card' ? state.wallet.cards.find(x => x.id === addEditId)
    : addType === 'rabatt' ? state.wallet.vouchers.find(x => x.id === addEditId && istRabatt(x)) : null;
  if (!bearbeitet) addEditId = '';
  waScanLauf++; // ein noch laufender Scan gehoert nicht in dieses Formular
  addImg = bearbeitet?.img || '';
  addOrig = '';
  waAutoWerte = {};
  addCodeImg = bearbeitet?.codeImg || '';
  const isCard = addType === 'card';
  const isRabatt = addType === 'rabatt';
  const titel = addEditId ? (isRabatt ? 'Rabattcode ändern' : 'Sparkarte ändern')
    : isCard ? 'Sparkarte hinzufügen' : isRabatt ? 'Rabattcode hinzufügen' : 'Gutschein hinzufügen';

  // Liegt die Seite schon oben (Umschalter, Duplikat, naechstes Bild), wird sie
  // nur neu gefuellt — sonst gleitet eine neue herein
  const geholt = waSeiteHolen(titel, opts);
  if (!geholt) return;
  const { seite, neuGefuellt } = geholt;
  const el = seite.el;
  const inhalt = el.querySelector('.wseite-inhalt');
  const q = sel => el.querySelector(sel);

  const art = isCard ? 'karten' : 'gutscheine';
  const platz = walletPlatz(art);
  const voll = !addEditId && platz.voll;
  const platzText = platz.voll ? walletVollText(art)
    : `${platz.n}${platz.g ? ` + ${platz.g} wartende Geschenke` : ''} von maximal ${platz.max} ${isCard ? 'Sparkarten' : 'Gutscheinen, Rabattcodes und Pfandbons'} in deiner Wallet, noch ${platz.frei} frei.`;
  const modusVon = opts.von || addType;
  const shopListe = waShopListe(addType);
  const mehrere = addType === 'voucher';
  let maus = false;
  try { maus = matchMedia('(hover: hover) and (pointer: fine)').matches; } catch { /* alt */ }
  const einfuegen = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘+V' : 'Strg+V';
  const tipp = [mehrere && 'Mehrere Bilder auf einmal gehen auch.',
    maus && `Oder mit ${einfuegen} einfügen oder hierher ziehen.`].filter(Boolean).join(' ');
  const mehrInhalt = `<span class="wa-shop-mehr-bild">${icon('search', 'icon')}</span><span class="wa-shop-name">Weitere</span>`;
  const wer = isCard ? 'Karte' : 'Shop';

  const alterSchalter = opts.richtung ? q('#wa-modus') : null;
  inhalt.innerHTML = `
    ${!isCard && !addEditId ? waSchalterHtml(modusVon, addType) : ''}
    ${!addEditId && (platz.voll || platz.fast) ? `
    <div class="wa-hinweis ${platz.voll ? 'voll' : 'fast'}">${icon('warning', 'icon')}<span>${esc(platzText)}</span></div>` : ''}
    <div class="wa-form${opts.von && !opts.richtung ? ' wa-form-neu' : ''}">
      <div class="wa-vorschau" id="wa-vorschau" aria-hidden="true"></div>

      <section class="gd-block wa-scan" id="wa-drop" aria-label="Foto oder Screenshot">
        <div class="wa-scan-kopf">
          <span class="wa-scan-symbol">${wIcon('scan')}</span>
          <span class="wa-scan-text"><b>Foto oder Screenshot</b>
            <small>${isCard ? 'Barcode und Kartennummer liest kumulio selbst aus.'
              : isRabatt ? 'Code, Rabatt und Mindestbestellwert liest kumulio selbst aus.'
              : 'Code, PIN und Wert liest kumulio selbst aus.'}</small></span>
        </div>
        <div class="wa-scan-bild hidden" id="wa-scan-frame">
          <img id="wa-preview" alt="Dein Bild">
          <div class="scan-line hidden" id="wa-scanline"></div>
        </div>
        <div class="scan-progress hidden" id="wa-progress">
          <div class="scan-progress-track"><div class="scan-progress-fill" id="wa-progress-fill"></div></div>
          <span id="wa-progress-txt">0 %</span>
        </div>
        <div id="wa-result" class="wa-scan-ergebnis hidden"></div>
        <p id="wa-ai-msg" class="form-msg wa-scan-meldung" role="status"></p>
        <div class="wa-scan-knoepfe">
          <label class="wa-scan-knopf">${wIcon('kamera')}<span data-mit-bild="Neues Foto">Foto aufnehmen</span>
            <input id="wa-cam" type="file" accept="image/*" capture="environment" hidden></label>
          <label class="wa-scan-knopf">${wIcon('bild')}<span data-mit-bild="${mehrere ? 'Andere Bilder' : 'Anderes Bild'}">${mehrere ? 'Bilder' : 'Bild'} hochladen</span>
            <input id="wa-img" type="file" accept="image/*" ${mehrere ? 'multiple' : ''} hidden></label>
          <button class="wa-scan-knopf wa-scan-crop" id="wa-crop" type="button" aria-label="Bild zuschneiden" title="Zuschneiden">${wIcon('zuschnitt')}</button>
        </div>
        ${tipp ? `<p class="wa-scan-tipp">${esc(tipp)}</p>` : ''}
      </section>

      <h3 class="gd-h">${wer}</h3>
      <div class="wa-shops" id="wa-vendor-grid" role="group" aria-label="${wer} wählen">
        ${shopListe.slice(0, 7).map(n => `<button class="wa-shop" type="button" data-vg="${esc(n)}" aria-pressed="false">
          ${brandChipHtml(n)}<span class="wa-shop-name">${waKachelName(n)}</span></button>`).join('')}
        <button class="wa-shop wa-shop-mehr" type="button" id="wa-vendor-showmore" aria-expanded="false" aria-controls="wa-suche"
          aria-label="Weitere ${isCard ? 'Karten' : 'Shops'}">${mehrInhalt}</button>
      </div>
      <div class="gd-block wa-suche hidden" id="wa-suche">
        <label class="wa-suche-zeile">${icon('search', 'icon')}
          <input id="wa-vendor" type="search" maxlength="30" autocomplete="off" autocorrect="off" spellcheck="false"
            enterkeyhint="done" placeholder="${wer} suchen oder eintippen" aria-label="${wer} suchen oder eintippen"></label>
        <div class="wa-suche-liste" id="wa-suche-liste"></div>
      </div>

      ${isCard ? `
      <h3 class="gd-h">Kartennummer <small>optional</small></h3>
      <input id="wa-cnumber" class="gd-feld wa-feld" maxlength="30" autocomplete="off" autocorrect="off" spellcheck="false"
        placeholder="Falls die Karte eine hat" value="${esc(bearbeitet?.number || '')}" aria-label="Kartennummer">
      <p class="wa-fussnote">Manche Karten haben gar keine Nummer. Dann reicht ein Foto vom Barcode, oder du legst sie einfach ohne an.</p>`
      : isRabatt ? rabattFormHtml(bearbeitet) : `
      <h3 class="gd-h">Wert</h3>
      <label class="gd-block wa-betrag" id="wa-betrag">
        <input id="wa-amount" inputmode="decimal" autocomplete="off" placeholder="0,00" aria-label="Wert in Euro">
        <span class="wa-betrag-einheit" aria-hidden="true">€</span>
      </label>
      <h3 class="gd-h">Details <small>optional</small></h3>
      <div class="gd-block wa-gruppe">
        <label class="wa-zeile"><span class="wa-zeile-label">Code oder Kartennummer</span>
          <input id="wa-code" class="wa-code-feld" maxlength="40" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Für die Kasse, falls vorhanden"></label>
        <label class="wa-zeile"><span class="wa-zeile-label">PIN</span>
          <input id="wa-pin" class="wa-code-feld" maxlength="16" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Falls vorhanden"></label>
        <label class="wa-zeile"><span class="wa-zeile-label">Gültig bis</span>
          <input id="wa-end" type="date"></label>
      </div>`}
      ${!addEditId && !(platz.voll || platz.fast) ? `<p class="wa-fussnote">${esc(platzText)}</p>` : ''}
    </div>`;

  // Die feste Leiste unten: Meldung (falls es eine gibt) und Speichern
  el.querySelectorAll('.wa-leiste').forEach(x => x.remove());
  el.insertAdjacentHTML('beforeend', `
    <div class="wseite-leiste wa-leiste">
      <p class="wa-meldung" id="wa-msg" role="alert"></p>
      <button class="gd-los wa-speichern aus" id="wa-save" type="button" aria-disabled="true">${addEditId ? 'Änderungen speichern' : 'Speichern'}</button>
    </div>`);
  // Der Inhalt bekommt unten genau so viel Luft, wie die Leiste hoch ist
  seite.waRo?.disconnect();
  if ('ResizeObserver' in window) {
    seite.waRo = new ResizeObserver(() => {
      const l = q('.wa-leiste');
      if (l) el.style.setProperty('--wa-leiste-h', l.offsetHeight + 'px');
    });
    seite.waRo.observe(q('.wa-leiste'));
  }
  inhalt.scrollTop = 0;
  // Neu gefuellt (Umschalter, naechstes Bild): der Fokus bleibt auf der Seite
  if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
  const meldung = (text, art = '') => {
    const m = q('#wa-msg');
    if (!m) return;
    m.className = 'wa-meldung' + (art ? ' ' + art : '');
    m.textContent = text || '';
  };

  // ---- Shop bzw. Karte: sieben Kacheln und "Weitere" mit Suche. Ein Name,
  // der in keiner Kachel steht, erscheint in der achten Kachel.
  let gewaehlt = '';
  const kacheln = () => [...el.querySelectorAll('#wa-vendor-grid [data-vg]')];
  const setzeShop = name => {
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    const bekannt = shopListe.find(n => n.toLowerCase() === name.toLowerCase());
    if (bekannt) name = bekannt;
    gewaehlt = name;
    const kachel = kacheln().find(t => t.dataset.vg.toLowerCase() === name.toLowerCase()) || null;
    kacheln().forEach(t => { t.classList.toggle('on', t === kachel); t.setAttribute('aria-pressed', String(t === kachel)); });
    const mehr = q('#wa-vendor-showmore');
    if (mehr) {
      const fremd = name && !kachel ? name : '';
      if ((mehr.dataset.zeigt || '') !== fremd) {
        mehr.dataset.zeigt = fremd;
        mehr.innerHTML = fremd ? `${brandChipHtml(fremd)}<span class="wa-shop-name">${esc(fremd)}</span>` : mehrInhalt;
      }
      mehr.classList.toggle('on', !!fremd);
      mehr.setAttribute('aria-label', fremd ? `${fremd}, ${isCard ? 'andere Karte' : 'anderen Shop'} suchen` : `Weitere ${isCard ? 'Karten' : 'Shops'}`);
    }
    if (q('#wa-vendor')) q('#wa-vendor').value = '';
    aktualisieren();
  };
  const currentVendor = () => gewaehlt;
  const currentCard = () => gewaehlt;
  const sucheOffen = () => offenWeich(q('#wa-suche'));
  const sucheZeichnen = () => {
    const liste = q('#wa-suche-liste'), feld = q('#wa-vendor');
    if (!liste || !feld) return;
    const text = feld.value.replace(/\s+/g, ' ').trim();
    const low = text.toLowerCase();
    const treffer = (low ? shopListe.filter(n => n.toLowerCase().includes(low)) : shopListe.slice(7)).slice(0, 12);
    const exakt = shopListe.some(n => n.toLowerCase() === low);
    // Echte Treffer zuerst, der eigene Name danach: Enter nimmt den obersten
    liste.innerHTML = treffer.map(n => `
      <button class="wa-treffer${n === gewaehlt ? ' an' : ''}" type="button" data-wahl="${esc(n)}">
        ${brandChipHtml(n)}<span>${esc(n)}</span></button>`).join('')
      + (text && !exakt ? `
      <button class="wa-treffer wa-treffer-frei" type="button" data-wahl="${esc(text)}">
        <span class="wa-treffer-plus">${icon('plus', 'icon')}</span><span>„${esc(text.slice(0, 30))}“ übernehmen</span></button>` : '');
    liste.querySelectorAll('[data-wahl]').forEach(b => b.onclick = () => {
      setzeShop(b.dataset.wahl);
      sucheAuf(false);
      buzz(6);
    });
  };
  const sucheAuf = auf => {
    const box = q('#wa-suche');
    if (!box) return;
    // Klappt weich auf und zu; was darunter steht, gleitet mit
    zeigeWeich(box, auf);
    q('#wa-vendor-showmore')?.setAttribute('aria-expanded', String(auf));
    if (auf) {
      sucheZeichnen();
      if (maus) q('#wa-vendor')?.focus({ preventScroll: true });
    }
  };
  kacheln().forEach(b => b.addEventListener('click', () => { setzeShop(b.dataset.vg); sucheAuf(false); buzz(6); }));
  q('#wa-vendor-showmore')?.addEventListener('click', () => { sucheAuf(!sucheOffen()); buzz(6); });
  // Tippen filtert nur die Liste — uebernommen wird erst ein Eintrag (Antippen
  // oder Enter). Sonst war jedes Bruchstueck ("ede") schon der gewaehlte Shop.
  q('#wa-vendor')?.addEventListener('input', sucheZeichnen);
  q('#wa-vendor')?.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = e.target.value.replace(/\s+/g, ' ').trim().toLowerCase();
    const eintraege = [...el.querySelectorAll('#wa-suche-liste [data-wahl]')];
    // Genau dieser Name, sonst der erste echte Treffer, sonst der eigene Name
    const ziel = eintraege.find(b => !b.classList.contains('wa-treffer-frei') && b.dataset.wahl.toLowerCase() === text) || eintraege[0];
    if (ziel && text) ziel.click(); else sucheAuf(false);
  });

  // ---- Gutschein, Rabattcode oder Pfandbon: der Schieber oben wechselt das Formular
  waSchalterVerdrahten(seite, q, addType, opts, alterSchalter);
  // Neu gefuellt (naechstes Bild, Duplikat): das neue Formular blendet sanft
  // ein, statt hart an die Stelle des alten zu springen
  if (neuGefuellt && weich()) {
    q('.wa-form')?.animate?.([{ opacity: 0, transform: 'translate3d(0, 10px, 0)' }, { opacity: 1, transform: 'none' }],
      { duration: 280, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  }
  if (opts.richtung && weich()) {
    const form = q('.wa-form');
    form?.animate?.([{ opacity: 0, transform: `translate3d(${opts.richtung * 28}px, 0, 0)` }, { opacity: 1, transform: 'none' }],
      { duration: 300, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  }

  // ---- Rabatt in Euro oder Prozent, Mindestbestellwert per Schalter
  let waEinheit = bearbeitet?.rabattArt === 'pct' ? 'pct' : 'eur';
  const setzeEinheit = e => {
    waEinheit = e;
    const box = q('#wa-einheit');
    if (!box) return;
    box.classList.toggle('rechts', e === 'pct');
    box.querySelectorAll('[data-einheit]').forEach(x => {
      x.classList.toggle('an', x.dataset.einheit === e);
      x.setAttribute('aria-pressed', String(x.dataset.einheit === e));
    });
    aktualisieren();
  };
  q('#wa-einheit')?.querySelectorAll('[data-einheit]').forEach(k => k.addEventListener('click', () => { setzeEinheit(k.dataset.einheit); buzz(6); }));
  // Die ganze Rabatt-Flaeche fuehrt ins Feld (ausser auf dem Schalter)
  q('.wa-rabatt')?.addEventListener('click', e => { if (!e.target.closest('button, input')) q('#wa-rwert')?.focus(); });
  const mbwText = () => {
    const t = q('#wa-mbw-text');
    if (!t) return;
    const n = parseFloat(String(q('#wa-mbw')?.value || '').replace(',', '.'));
    t.textContent = q('#wa-mbw-an').checked ? (n > 0 ? 'ab ' + euroFmt(n) : 'Betrag eintragen') : 'ohne MBW';
  };
  q('#wa-mbw-an')?.addEventListener('change', e => {
    zeigeWeich(q('#wa-mbw-feld'), e.target.checked);
    mbwText();
    aktualisieren();
    if (e.target.checked) setTimeout(() => q('#wa-mbw')?.focus(), 60);
  });
  q('#wa-mbw')?.addEventListener('input', mbwText);

  // ---- Vorschau: aendert sich beim Ausfuellen mit. Bleibt die Marke gleich,
  // werden nur die Texte getauscht — das Logo bleibt stehen (kein Flackern)
  const zahlAus = sel => {
    const n = parseFloat(String(q(sel)?.value || '').replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  const vorschauTeile = isCard ? ['.dk-nummer', '.dk-code-feld'] : isRabatt
    ? ['.wallet-card-name', '.wallet-card-balance', '.wallet-card-sub'] : ['.vk-text', '.vk-rechts', '.vk-fuss'];
  let vorschauMarke = null;
  const vorschauQuelle = {};
  const vorschauZeichnen = () => {
    const box = q('#wa-vorschau');
    if (!box) return;
    const a = zahlAus('#wa-amount');
    const html = isCard
      ? waSparkarteHtml({ name: gewaehlt, number: q('#wa-cnumber')?.value.trim() || '', codeImg: addCodeImg, img: addCodeImg ? '' : addImg })
      : isRabatt
        ? waRabattKarteHtml({ vendor: gewaehlt, code: (q('#wa-rcode')?.value || '').replace(/\s+/g, ''), rabatt: zahlAus('#wa-rwert'),
            rabattArt: waEinheit, mbw: q('#wa-mbw-an')?.checked ? zahlAus('#wa-mbw') : null, end: q('#wa-end')?.value || '' })
        : waGutscheinKarteHtml({ vendor: gewaehlt, amount: a != null && a >= 0 ? a : null,
            code: (q('#wa-code')?.value || '').trim(), pin: (q('#wa-pin')?.value || '').trim(), end: q('#wa-end')?.value || '' });
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    const neu = tpl.content.firstElementChild;
    const alt = box.firstElementChild;
    // Sparkarte: kommt ein Code dazu oder faellt weg, aendert sich die Aufteilung
    // der Karte (Code-Feld rechts) — dann einmal ganz neu statt Teile tauschen
    if (!alt || vorschauMarke !== gewaehlt.toLowerCase() || (isCard && alt.className !== neu.className)) {
      vorschauMarke = gewaehlt.toLowerCase();
      for (const sel of vorschauTeile) vorschauQuelle[sel] = neu.querySelector(sel)?.outerHTML;
      box.replaceChildren(neu);
      return;
    }
    for (const sel of vorschauTeile) {
      const n = neu.querySelector(sel), o = alt.querySelector(sel);
      const quelle = n?.outerHTML;
      if (n && o && quelle !== vorschauQuelle[sel]) { vorschauQuelle[sel] = quelle; o.replaceWith(n); }
    }
  };
  // (Die Sparkarte zeigt Code und Nummer vorn — sie dreht sich nicht mehr um)

  // ---- Was fehlt noch? Speichern ist erst aktiv, wenn alles Noetige da ist.
  // Tippt man trotzdem, sagt die Leiste, was fehlt.
  const pruefen = () => {
    if (voll) return { fehlt: [], text: walletVollText(art) };
    if (isCard) return gewaehlt ? null : { fehlt: ['shop'], text: 'Bitte eine Karte auswählen.' };
    if (isRabatt) {
      if (!gewaehlt) return { fehlt: ['shop'], text: 'Bitte einen Shop auswählen.' };
      const n = zahlAus('#wa-rwert');
      if (waEinheit === 'pct' && n > 100) return { fehlt: ['betrag'], text: 'Mehr als 100 % Rabatt gibt es nicht.' };
      return null;
    }
    const a = zahlAus('#wa-amount');
    const ohneWert = a == null || a < 0;
    if (!gewaehlt && ohneWert) return { fehlt: ['shop', 'betrag'], text: 'Bitte noch Shop und Wert angeben.' };
    if (!gewaehlt) return { fehlt: ['shop'], text: 'Bitte einen Shop auswählen.' };
    if (ohneWert) return { fehlt: ['betrag'], text: 'Bitte den Wert eintragen.' };
    return null;
  };
  const aktualisieren = () => {
    vorschauZeichnen();
    // Leeres Datum grau wie ein Platzhalter, nicht wie eine Eingabe
    const ende = q('#wa-end');
    if (ende) ende.classList.toggle('leer', !ende.value);
    const f = pruefen();
    const knopf = q('#wa-save');
    if (knopf && !waSaving) {
      knopf.classList.toggle('aus', !!f);
      knopf.setAttribute('aria-disabled', String(!!f));
    }
    const fehlt = f ? f.fehlt : [];
    if (!fehlt.includes('shop')) q('#wa-vendor-grid')?.classList.remove('err');
    if (!fehlt.includes('betrag')) q('#wa-betrag')?.classList.remove('err');
    const m = q('#wa-msg');
    if (m && m.classList.contains('error') && !f) {
      meldung('');
      el.querySelectorAll('.wa-zeile.err').forEach(z => z.classList.remove('err'));
    }
  };
  const fehlerZeigen = f => {
    meldung(f.text, 'error');
    q('#wa-vendor-grid')?.classList.toggle('err', f.fehlt.includes('shop'));
    q('#wa-betrag')?.classList.toggle('err', f.fehlt.includes('betrag'));
    buzz([40, 30, 40]);
    if (!reducedMotion()) neuStarten(q('#wa-msg'), 'shake-once');
    // Zum ersten fehlenden Feld; beim Wert gleich hinein
    const ziel = f.fehlt.includes('shop') ? q('#wa-vendor-grid') : f.fehlt.includes('betrag') ? q('#wa-betrag') : null;
    ziel?.scrollIntoView({ behavior: sperrRuhig() ? 'auto' : 'smooth', block: 'center' });
    if (!f.fehlt.includes('shop') && f.fehlt.includes('betrag')) (q('#wa-amount') || q('#wa-rwert'))?.focus({ preventScroll: true });
  };
  ['#wa-amount', '#wa-code', '#wa-pin', '#wa-end', '#wa-rcode', '#wa-rwert', '#wa-mbw', '#wa-cnumber']
    .forEach(sel => q(sel)?.addEventListener('input', aktualisieren));
  q('#wa-end')?.addEventListener('change', aktualisieren);
  // Enter springt ins naechste Feld, im letzten schliesst es die Tastatur
  const felder = () => [...el.querySelectorAll('.wa-form input:not([type="file"]):not([type="checkbox"]):not([type="search"])')]
    .filter(x => !x.closest('.hidden'));
  el.querySelector('.wa-form').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.target.type === 'search' || !e.target.matches('input')) return;
    e.preventDefault();
    const liste = felder();
    const naechstes = liste[liste.indexOf(e.target) + 1];
    if (naechstes) naechstes.focus(); else e.target.blur();
  });

  // Vorbelegung: beim Aendern der alte Name, sonst der mitgegebene (Marken-Blatt)
  setzeShop(bearbeitet ? (isCard ? bearbeitet.name : bearbeitet.vendor) : addPrefill);

  // ---- Bild: Vorschau im Scan-Feld, Zuschneiden, Scan
  const bildZeigen = src => {
    const img = q('#wa-preview');
    if (!img) return;
    if (src) img.src = src;
    zeigeWeich(q('#wa-scan-frame'), !!src);
    // Mit Bild: die Knoepfe heissen "Neues Foto" / "Anderes Bild", daneben Zuschneiden
    const drop = q('#wa-drop');
    if (!drop || drop.classList.contains('hat-bild') === !!src) return;
    drop.classList.toggle('hat-bild', !!src);
    drop.querySelectorAll('[data-mit-bild]').forEach(t => {
      const alt = t.textContent;
      t.textContent = t.dataset.mitBild;
      t.dataset.mitBild = alt;
    });
  };
  const scanMeldung = (text, art = '') => {
    const m = q('#wa-ai-msg');
    if (!m) return;
    m.className = 'form-msg wa-scan-meldung' + (art ? ' ' + art : '');
    m.textContent = text || '';
  };
  // Beim Aendern das schon hinterlegte Bild gleich zeigen — sonst sieht es aus,
  // als waere es weg, und man laedt es unnoetig neu hoch.
  if (bearbeitet && (addCodeImg || addImg)) bildZeigen(addCodeImg || addImg);
  // Zuschneiden: vom ganzen Foto aus, damit der Ausschnitt auch wieder
  // groesser werden kann. "Ganzes Bild" nimmt das Foto ohne Zuschnitt.
  q('#wa-crop')?.addEventListener('click', () => {
    const quelle = addOrig || addImg || addCodeImg;
    if (!quelle) return;
    openImgCrop(quelle, (out, info) => {
      if (walletGesperrt() || waSeiteOben() !== seite || q('#wa-preview') == null) return;
      if (info.ganz) { addImg = out; addCodeImg = ''; }
      else { if (!addOrig && addImg) addOrig = addImg; addCodeImg = out; }
      bildZeigen(addCodeImg || addImg);
      aktualisieren();
      buzz(8);
    });
  });

  // Scan-Fortschritt: erst der Code-Scan (bis 20 %), dann die Text-Erkennung
  // Null-sicher: wird waehrenddessen die Seite geschlossen, fehlen die Elemente
  const scanProgress = p => {
    const f = $('#wa-progress-fill'), t = $('#wa-progress-txt');
    if (f) f.style.transform = `scaleX(${Math.max(0, Math.min(100, p)) / 100})`;
    if (t) t.textContent = Math.round(p) + ' %';
  };
  const handleImageFile = async f => {
    if (!f) return;
    const lauf = ++waScanLauf;
    const veraltet = () => lauf !== waScanLauf;
    try {
      for (const [sel, wert] of Object.entries(waAutoWerte)) {
        if (sel === '__shop') { if (currentVendor() === wert) setzeShop(''); continue; }
        if (sel === '__mbwAn') continue;
        const feld = $(sel); if (feld && feld.value === wert) feld.value = '';
      }
      // Hatte der letzte Scan den MBW-Schalter eingeschaltet und steht kein
      // eigener Betrag drin, geht er mit aus — sonst stuende "ab 15,00 €" da,
      // waehrend Vorschau und Gespeichertes "ohne MBW" sagen
      if (waAutoWerte.__mbwAn && q('#wa-mbw-an')?.checked && !q('#wa-mbw')?.value) {
        q('#wa-mbw-an').checked = false;
        q('#wa-mbw-feld')?.classList.add('hidden');
      }
      if (q('#wa-mbw-an')) mbwText();
      waAutoWerte = {};
      aktualisieren();
      addCodeImg = '';
      addOrig = '';
      addImg = ''; // scheitert das neue Bild, darf nicht das alte mitgespeichert werden
      const vorschau = await readImageFile(f, 900, 0.82, 'vorschau');
      if (veraltet()) return;
      addImg = vorschau;
      const ganz = await readImageFile(f, 1600, 0.82, 'foto').catch(() => '');
      if (veraltet()) return;
      addOrig = ganz;
      bildZeigen(addImg);
      zeigeWeich($('#wa-result'), false);
      // Scan-Optik: Laserlinie über dem Bild + ruhiger Prozent-Balken
      $('#wa-scanline')?.classList.remove('hidden');
      $('#wa-progress')?.classList.remove('done');
      zeigeWeich($('#wa-progress'), true);
      scanProgress(4);
      scanMeldung('Scanne das Bild …');
      // Analyse auf hochauflösender Fassung: kleine Schrift bleibt für die OCR lesbar
      const hiRes = await readImageFile(f, 2200, 0.9);
      if (veraltet()) return;
      scanProgress(12);
      const r = await analyzeWalletImage(hiRes, p => {
        if (veraltet()) return;
        scanProgress(20 + p * 0.78);
        scanMeldung('Lese den Text im Bild … (kann beim ersten Mal etwas dauern)');
      });
      // Inzwischen kam ein anderes Bild: dieses Ergebnis gehoert nicht mehr hierher
      if (veraltet()) return;
      // Ein Pfandbon? Der gehoert unter Pfand: das Formular wechselt und liest
      // das Bild dort gezielt (Betrag im Balken, Filiale, Code). Hat der
      // Gutschein-Scan gar nichts gefunden, schaut der Pfand-Scan nach —
      // Kassenbons liest er besser.
      if (!addEditId && addType !== 'card') {
        let pfand = pfandVermutet(r) ? { vermutet: true } : null;
        if (!pfand && !r.barcode && !r.amount && !r.pin) {
          scanMeldung('Lese weiter …');
          const e = await pfandScannen(f, p => { if (!veraltet()) scanProgress(Math.max(60, p)); }, { drehen: false }).catch(() => null);
          if (veraltet()) return;
          if (e && e.istPfand) pfand = { ergebnis: e };
        }
        if (pfand) {
          const ausSchlange = !!waApi?.ausSchlange;
          openWalletAdd('pfand', '', '', { von: addType, richtung: 1, datei: f, ergebnis: pfand.ergebnis || null });
          if (waApi) {
            waApi.ausSchlange = ausSchlange;
            waApi.hinweis('fix', '<b>Das ist ein Pfandbon.</b> Er kommt unter Pfand, zusammen mit der Filiale, in der er gilt.');
          }
          return;
        }
      }
      if (r.codeImg) { addCodeImg = r.codeImg; bildZeigen(r.codeImg); }
      const felder = ['#wa-code', '#wa-pin', '#wa-amount', '#wa-cnumber', '#wa-rcode', '#wa-rwert', '#wa-mbw'];
      const vorher = Object.fromEntries(felder.map(sel => [sel, $(sel)?.value || '']));
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
            const hit = [...VENDOR_GRID.filter(v => !ANDERE_SHOPS.has(v)).map(v => v.toLowerCase()), ...Object.keys(BRAND_COLORS)].find(k => low.includes(k));
            if (hit) {
              setzeShop(hit.charAt(0).toUpperCase() + hit.slice(1));
              waAutoWerte.__shop = currentVendor();
              filled.push('Shop');
            }
          }
        }
      } else if (addType === 'rabatt') {
        const text = r.text || '';
        const code = (r.barcode && r.barcode.length <= 40 ? r.barcode : '') || (text ? detectCode(text) : '');
        if (code && !$('#wa-rcode').value) { $('#wa-rcode').value = code.slice(0, 40); filled.push('Code'); }
        const betrag = x => parseFloat(String(x).replace(',', '.'));
        const mbw = text.match(/(?:mindestbestellwert|mindestbestellung|mbw|bestellwert|einkaufswert)\D{0,20}?(\d{1,3}(?:[.,]\d{1,2})?)\s?(?:€|eur)/i)
          || text.match(/\bab\s+(\d{1,3}(?:[.,]\d{1,2})?)\s?(?:€|eur)/i);
        if (mbw && !$('#wa-mbw').value) {
          if (!$('#wa-mbw-an').checked) waAutoWerte.__mbwAn = true;   // beim naechsten Bild wieder aus
          $('#wa-mbw-an').checked = true;
          $('#wa-mbw-feld').classList.remove('hidden');
          $('#wa-mbw').value = mbw[1];
          mbwText();
          filled.push('Mindestbestellwert');
        }
        if (!$('#wa-rwert').value) {
          const pct = text.match(/(\d{1,2})\s?%/);
          const euros = [...text.matchAll(/(\d{1,3}(?:[.,]\d{1,2})?)\s?(?:€|eur\b)/gi)].map(m => m[1])
            .filter(x => !mbw || betrag(x) !== betrag(mbw[1]));
          if (pct) { $('#wa-rwert').value = pct[1]; setzeEinheit('pct'); filled.push('Rabatt'); }
          else if (euros.length) { $('#wa-rwert').value = euros[0]; setzeEinheit('eur'); filled.push('Rabatt'); }
        }
        if (!currentVendor() && text) {
          const low = text.toLowerCase();
          const hit = [...RABATT_GRID.filter(x => !ANDERE_SHOPS.has(x)).map(x => x.toLowerCase()), ...Object.keys(BRAND_COLORS)]
            .find(k => k.length > 2 && low.includes(k));
          if (hit) {
            setzeShop(hit.charAt(0).toUpperCase() + hit.slice(1));
            waAutoWerte.__shop = currentVendor();
            filled.push('Shop');
          }
        }
      } else {
        if (r.barcode && kartennummerLesbar(r.barcode) && !$('#wa-cnumber').value) {
          $('#wa-cnumber').value = kartennummerLesbar(r.barcode).replace(/\s+/g, '').slice(0, 30); filled.push('Kartennummer (aus Barcode)');
        }
        else if (r.text && !$('#wa-cnumber').value) {
          const kn = r.text.match(/karten\s*-?\s*(?:nr\.?|nummer)\D{0,30}?(\d[\d ]{6,28}\d)/i);
          const num = kn ? kn[1] : (r.text.match(/\d[\d ]{8,24}\d/g) || []).sort((a, b) => b.length - a.length)[0];
          if (num) { $('#wa-cnumber').value = num.replace(/\s+/g, '').slice(0, 30); filled.push('Kartennummer'); }
        }
      }
      for (const sel of felder) { const w = $(sel)?.value || ''; if (w && w !== vorher[sel]) waAutoWerte[sel] = w; }
      if (r.codeImg) filled.push('Kassen-Code ausgeschnitten');
      // Scan fertig: Balken voll, Laserlinie aus, Ergebnis ordentlich untereinander
      scanProgress(100);
      $('#wa-progress')?.classList.add('done');
      $('#wa-scanline')?.classList.add('hidden');
      setTimeout(() => zeigeWeich($('#wa-progress'), false), 1400);
      const resRow = (label, val) => val
        ? `<div class="scan-row"><span>${label}</span><b>${esc(val)}</b></div>` : '';
      const resCode = addType === 'voucher' ? $('#wa-code').value : addType === 'rabatt' ? $('#wa-rcode').value : $('#wa-cnumber').value;
      const resRows = addType === 'voucher'
        ? resRow('Code', r.barcode && r.barcode !== resCode ? r.barcode : '')
          + resRow('Kartennummer', resCode)
          + resRow('PIN', $('#wa-pin').value)
        : addType === 'rabatt'
          ? resRow('Code', resCode)
            + resRow('Rabatt', $('#wa-rwert').value ? $('#wa-rwert').value + (waEinheit === 'pct' ? ' %' : ' €') : '')
            + resRow('Mindestbestellwert', $('#wa-mbw-an').checked && $('#wa-mbw').value ? 'ab ' + $('#wa-mbw').value + ' €' : '')
          : resRow('Kartennummer', resCode);
      if (resRows) {
        $('#wa-result').innerHTML = resRows;
        zeigeWeich($('#wa-result'), true);
      }
      aktualisieren();
      // Lieber ehrlich als geraten: sagen, was fehlt und selbst geprüft werden muss
      const pinFehlt = addType === 'voucher' && !$('#wa-pin').value;
      if (filled.length) {
        scanMeldung(`Gescannt und ausgefüllt: ${filled.join(', ')}, bitte kurz prüfen.`
          + (pinFehlt ? ' Der PIN war nicht sicher lesbar, bitte selbst eintragen.' : ''), 'ok');
      } else {
        scanMeldung('Nichts sicher erkannt, bitte die Felder ausfüllen. Gespeichert wird mit „Speichern“.');
      }
    } catch {
      if (veraltet()) return;
      $('#wa-scanline')?.classList.add('hidden');
      $('#wa-progress')?.classList.add('hidden');
      scanMeldung('Bild konnte nicht gelesen werden.', 'error');
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
    waScanLauf++; // ein laufender Einzel-Scan traegt nichts mehr ein
    seite.stapelLaeuft = true;                  // Zurueck fragt solange nach (siehe zurueckFrage)
    zeigeWeich($('#wa-result'), false);
    $('#wa-progress')?.classList.remove('done');
    zeigeWeich($('#wa-progress'), true);
    $('#wa-scanline')?.classList.remove('hidden');
    const results = [];
    const fresh = [];
    for (let i = 0; i < files.length; i++) {
      scanMeldung(`Scanne Gutschein ${i + 1} von ${files.length} …`);
      scanProgress((i / files.length) * 100);
      let small = '';
      try {
        small = await readImageFile(files[i], 900, 0.82, 'vorschau');
        bildZeigen(small);
        const hiRes = await readImageFile(files[i], 2200, 0.9);
        const r = await analyzeWalletImage(hiRes, p => scanProgress(((i + p / 100) / files.length) * 100));
        // Pfandbons gehoeren nicht zu den Gutscheinen: einzeln unter Pfand nachreichen
        if (pfandVermutet(r)) {
          results.push({ ok: false, name: 'Pfandbon', warum: 'Pfandbon erkannt, kommt unter Pfand', fix: { art: 'pfand', datei: files[i] } });
          continue;
        }
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
        if (r.codeImg) origSichern(v, await readImageFile(files[i], 1600, 0.82, 'foto').catch(() => small));
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
    // Wurde waehrenddessen die Seite geschlossen, fehlen diese Elemente —
    // gespeichert wird trotzdem
    $('#wa-progress')?.classList.add('done');
    $('#wa-scanline')?.classList.add('hidden');
    // Speichern mit derselben Ehrlichkeit wie beim Einzel-Gutschein
    if (fresh.length) {
      // Inzwischen schon drin (zweiter Lauf mit denselben Bildern)? Dann nicht doppelt
      for (let k = fresh.length - 1; k >= 0; k--) {
        if (findDupe(fresh[k], fresh.slice(0, k))) {
          const res = results.find(x => x.v === fresh[k]);
          if (res) { res.ok = false; res.name = fresh[k].vendor; res.warum = 'schon in der Wallet, übersprungen'; }
          origEntfernen(fresh[k]);
          fresh.splice(k, 1);
        }
      }
      // Nur so viele, wie noch Platz ist — der Rest wird ehrlich gemeldet
      const ueber = fresh.splice(walletPlatz('gutscheine').frei);
      for (const v of ueber) {
        const res = results.find(x => x.v === v);
        if (res) { res.ok = false; res.name = v.vendor; res.warum = `Wallet voll (maximal ${WALLET_LIMIT.gutscheine} Gutscheine), nicht gespeichert`; }
        origEntfernen(v);
      }
      state.wallet.vouchers.unshift(...fresh);
      save('wallet', state.wallet);
      renderWallet();
      if (state.token) {
        scanMeldung('Sichere am Konto …');
        const ok = await syncWalletNow();
        if (!ok && walletSyncFatal) {
          // Das Konto hat abgelehnt: die Gutscheine BLEIBEN auf dem Geraet
          showToast({
            title: 'Auf dem Gerät gespeichert',
            text: 'Das Konto hat das Sichern abgelehnt (' + (walletSyncError || 'unbekannt') + '). Bitte neu anmelden, dann wird nachgesichert.',
            iconName: 'warning',
          }, 9000);
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
    fresh.forEach(zeigeNeuenGutschein);
    seite.stapelLaeuft = false;
    // Seite inzwischen zu (oder eine andere oben): Ergebnis nur als Meldung —
    // samt der unvollstaendigen, die dabei ungespeichert wegfallen
    if (waSeiteOben() !== seite) {
      const teile = [fresh.length && `${fresh.length} Gutschein${fresh.length > 1 ? 'e' : ''} gespeichert`,
        fixes.length && `${fixes.length} unvollständig und nicht gespeichert`].filter(Boolean);
      if (teile.length) island(teile.join(', '), fixes.length ? 5000 : undefined);
      return;
    }
    // Zurueck (Pfeil, Wisch, Esc) fragt wie "Fertig", solange noch welche fehlen
    const fertigFrage = () => `${fixes.length} Gutschein${fixes.length > 1 ? 'e sind' : ' ist'} noch unvollständig und ${fixes.length > 1 ? 'werden' : 'wird'} nicht gespeichert. Trotzdem fertig?`;
    seite.zurueckFrage = () => fixes.length ? fertigFrage() : '';
    el.querySelector('.wseite-titel').textContent = 'Gutscheine gescannt';
    el.setAttribute('aria-label', 'Gutscheine gescannt');
    inhalt.innerHTML = `
      <p class="wa-stapel-summe"><b>${fresh.length} von ${files.length}</b> ${files.length === 1 ? 'Gutschein ist' : 'Gutscheinen sind'} neu in der Wallet.</p>
      <div class="gd-block wa-stapel">
        ${results.map(res => res.ok ? `
        <div class="wa-stapel-zeile ok">
          <span class="wa-stapel-zeichen">${icon('check', 'icon')}</span>
          <span class="wa-stapel-text"><b>${esc(res.v.vendor)}</b><small>${euroFmt(res.v.amount)} · PIN ${esc(res.v.pin)}</small></span>
        </div>` : `
        <div class="wa-stapel-zeile bad">
          <span class="wa-stapel-zeichen">${icon('warning', 'icon')}</span>
          <span class="wa-stapel-text"><b>${esc(res.name || 'Bild')}</b><small>${esc(res.warum)}</small></span>
        </div>`).join('')}
      </div>`;
    inhalt.scrollTop = 0;
    waHandleImage = null; // hier gibt es kein Formular mehr, das ein Bild aufnimmt
    el.querySelectorAll('.wa-leiste').forEach(x => x.remove());
    el.insertAdjacentHTML('beforeend', `
      <div class="wseite-leiste wa-leiste">
        ${fixes.length ? `<button class="gd-los" id="wa-batch-fix" type="button">Fehlende ergänzen (${fixes.length})</button>` : ''}
        <div class="wa-leiste-zwei">
          <button class="gd-los leise" id="wa-batch-more" type="button">Weitere Bilder</button>
          <button class="gd-los${fixes.length ? ' leise' : ''}" id="wa-batch-done" type="button">Fertig</button>
        </div>
      </div>`);
    seite.waRo?.disconnect();
    seite.waRo?.observe(q('.wa-leiste'));
    q('#wa-batch-done').onclick = async () => {
      if (fixes.length && !await askConfirm(fertigFrage(), { okLabel: 'Ja, verwerfen' })) return;
      if (waSeiteOben() === seite) wseiteZurueck();
    };
    q('#wa-batch-more').onclick = () => openWalletAdd('voucher');
    q('#wa-batch-fix')?.addEventListener('click', () => {
      waFixQueue = fixes;
      waFixTotal = fixes.length;
      nextFixOrDone();
    });
    if (fresh.length) {
      playSfx('kaching'); buzz(35); moneyFlash('green'); billRain(Math.min(9, 4 + fresh.length));
      island(`${fresh.length} Gutschein${fresh.length > 1 ? 'e' : ''} gespeichert`);
    } else {
      playSfx('error'); buzz([60, 50, 60]); moneyFlash('red');
      if (!reducedMotion()) neuStarten(inhalt, 'shake-once');
    }
  };

  const pickFiles = files => {
    const list = [...files].filter(f => f && f.type.startsWith('image/'));
    if (!list.length) return;
    if (addType === 'voucher' && list.length > 1) handleImageBatch(list);
    else handleImageFile(list[0]);
  };
  // Dieselbe Datei nochmal waehlen muss wieder ausloesen: danach leeren
  q('#wa-img').addEventListener('change', e => { pickFiles(e.target.files); e.target.value = ''; });
  q('#wa-cam').addEventListener('change', e => { handleImageFile(e.target.files[0]); e.target.value = ''; });
  // Strg+V: der globale Paste-Listener reicht das Bild hierher durch
  waHandleImage = handleImageFile;
  // Drag & Drop (Web): Bilder irgendwo aufs Formular ziehen (auch mehrere)
  const form = el.querySelector('.wa-form');
  const drop = q('#wa-drop');
  ['dragover', 'dragenter'].forEach(t => form.addEventListener(t, e => { e.preventDefault(); drop.classList.add('drag'); }));
  form.addEventListener('dragleave', e => { if (!form.contains(e.relatedTarget)) drop.classList.remove('drag'); });
  form.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); pickFiles(e.dataTransfer.files); });

  // Nach dem Speichern einer Karte aus dem Marken-Blatt heraus: das Blatt
  // darunter zeigt gleich die neue Karte
  const blattAuffrischen = () => {
    if (!isCard || state.sheetMode !== 'brand' || !openBrandSheet.key) return;
    if (walletBrands().some(b => b.key === openBrandSheet.key)) openBrandSheet(openBrandSheet.key);
    else closeSheet();
  };
  const zu = () => { if (waSeiteOben() === seite) wseiteZurueck(); };

  q('#wa-save').addEventListener('click', async () => {
    const knopf = q('#wa-save');
    // Doppelklick-Schutz: solange gespeichert wird, ist der Button tabu, sonst
    // meldet der zweite Klick den EIGENEN Gutschein als Duplikat
    if (waSaving) return;
    // Was fehlt, sagt die Leiste — gespeichert wird erst, wenn alles da ist
    const fehler = pruefen();
    if (fehler) { fehlerZeigen(fehler); return; }
    // Waehrend des Sicherns kann das Formular wechseln — danach zaehlt, was
    // beim Tippen auf "Speichern" galt
    const typ = addType, editId = addEditId;
    // Ohne Netz wird trotzdem gespeichert: die Wallet liegt dauerhaft auf dem
    // Geraet (IndexedDB) und geht hoch, sobald wieder Netz da ist
    let savedItem = null;
    if (addType === 'voucher') {
      const amount = zahlAus('#wa-amount');
      const v = {
        id: Math.random().toString(36).slice(2, 9),
        vendor: currentVendor().slice(0, 30),
        code: q('#wa-code').value.trim().slice(0, 40),
        pin: q('#wa-pin').value.trim().slice(0, 16),
        end: q('#wa-end').value || '',
        amount, balance: amount,
        // Originalfoto nur behalten, wenn es keinen Kassen-Zuschnitt gibt (Payload-Diät)
        img: addCodeImg ? '' : addImg, codeImg: addCodeImg, tx: [], added: Date.now(),
      };
      // Doppelte Gutscheine abfangen: gleiche PIN beim gleichen Shop oder gleicher Code
      const dupe = findDupe(v);
      if (dupe) {
        dupeReject(`Diesen Gutschein hast du schon in der Wallet (${esc(dupe.vendor)}, gleiche ${dupe.code === v.code && v.code ? 'Kartennummer' : 'PIN'}).`);
        return;
      }
      state.wallet.vouchers.unshift(v);
      zeigeNeuenGutschein(v);
      // Gibt es einen Kassen-Zuschnitt, bleibt das ganze Foto als Original
      // erhalten — ausserhalb der Wallet
      if (addCodeImg && (addOrig || addImg)) origSichern(v, addOrig || addImg);
      savedItem = v;
    } else if (addType === 'rabatt') {
      const alt = addEditId ? state.wallet.vouchers.find(x => x.id === addEditId && istRabatt(x)) : null;
      const zahl = sel => {
        const n = zahlAus(sel);
        return n != null && n > 0 ? Math.round(n * 100) / 100 : null;
      };
      // amount/balance immer ausdruecklich null: sonst machte normalisiereWallet
      // (oder ein altes Geraet) aus dem Code Guthaben
      const rc = {
        ...(alt || {}),
        id: alt ? alt.id : Math.random().toString(36).slice(2, 9),
        art: 'rabatt',
        vendor: currentVendor().slice(0, 30),
        code: q('#wa-rcode').value.replace(/\s+/g, '').slice(0, 40),
        rabatt: zahl('#wa-rwert'),
        rabattArt: waEinheit,
        mbw: q('#wa-mbw-an').checked ? zahl('#wa-mbw') : null,
        end: q('#wa-end').value || '',
        notiz: q('#wa-notiz').value.trim().slice(0, 80),
        pin: '', amount: null, balance: null,
        tx: alt ? (alt.tx || []) : [],
        img: addCodeImg ? '' : addImg, codeImg: addCodeImg,
        added: alt ? alt.added : Date.now(),
        eingeloest: alt ? (alt.eingeloest || 0) : 0,
        ...(alt ? { mt: Date.now() } : {}),
      };
      if (alt && (rc.img !== alt.img || rc.codeImg !== alt.codeImg)) {
        rc.bildMt = Math.max(Date.now(), (alt.bildMt || 0) + 1);
        if (rc.orig && !addCodeImg) origEntfernen(rc);
      }
      const dupe = findDupe(rc);
      if (dupe && alt) {
        q('#wa-rcode').closest('.wa-zeile')?.classList.add('err');
        fehlerZeigen({ fehlt: [], text: `Diesen Code hast du schon (${dupe.vendor}). Bitte einen anderen eintragen.` });
        return;
      }
      if (dupe) {
        dupeReject(`Diesen Rabattcode hast du schon (${esc(dupe.vendor)}).`);
        return;
      }
      if (alt) state.wallet.vouchers[state.wallet.vouchers.indexOf(alt)] = rc;
      else state.wallet.vouchers.unshift(rc);
      if (addCodeImg && (addOrig || addImg) && (!alt || alt.codeImg !== addCodeImg)) origSichern(rc, addOrig || addImg);
      savedItem = rc;
    } else {
      const alt = addEditId ? state.wallet.cards.find(x => x.id === addEditId) : null;
      const c = {
        id: alt ? alt.id : Math.random().toString(36).slice(2, 9),
        name: currentCard().slice(0, 30),
        number: q('#wa-cnumber').value.replace(/\s+/g, '').slice(0, 30),   // wie beim Scan: ohne Leerzeichen
        img: addCodeImg ? '' : addImg, codeImg: addCodeImg,
        added: alt ? alt.added : Date.now(),
        // mt = zuletzt bearbeitet. Der Server entscheidet Konflikte danach —
        // ohne das koennte ein zweites Geraet die Aenderung ueberschreiben.
        ...(alt ? { mt: Date.now() } : {}),
      };
      if (alt) state.wallet.cards[state.wallet.cards.indexOf(alt)] = c;
      else state.wallet.cards.unshift(c);
      savedItem = c;
    }
    meldung('');
    save('wallet', state.wallet);
    renderWallet();
    // Erst wenn der Server es hat, gilt es als voll gesichert; unterwegs immer
    // sichtbar machen, dass gerade gespeichert wird
    if (state.token) {
      waSaving = true;
      knopf.classList.remove('aus');
      setBtnLoading(knopf, true);
      meldung('Speichere und sichere am Konto …');
      const ok = await syncWalletNow();
      waSaving = false;
      setBtnLoading(knopf, false);
      if (!ok && walletSyncFatal) {
        // Das Konto hat abgelehnt: der Gutschein BLEIBT auf dem Geraet —
        // wegwerfen waere das Schlimmste. Seite zu (ein zweiter Klick legte
        // ihn sonst doppelt an) und ehrlich sagen, was los ist.
        zu();
        blattAuffrischen();
        showToast({
          title: 'Auf dem Gerät gespeichert',
          text: 'Das Konto hat das Sichern abgelehnt (' + (walletSyncError || 'unbekannt') + '). Bitte neu anmelden, dann wird nachgesichert.',
          iconName: 'warning',
        }, 9000);
        return;
      }
      if (!ok) {
        // Netzwackler/Timeout: Gutschein BLEIBT auf dem Gerät, der Hintergrund-Sync
        // holt das Sichern nach — nichts wird still weggeworfen. Warten noch
        // weitere (Ergaenzen, geteilte Bilder), geht es mit dem naechsten weiter.
        if (typ !== 'voucher' || !(waFixQueue.length || geteiltSchlange.length) || !nextFixOrDone()) {
          zu();
          blattAuffrischen();
        }
        playSfx('kaching'); buzz(35);
        showToast({
          title: 'Gespeichert, Sicherung folgt',
          text: `Der Server war gerade nicht erreichbar. ${typ === 'rabatt' ? 'Der Rabattcode' : typ === 'card' ? 'Die Karte' : 'Der Gutschein'} bleibt auf dem Gerät und wird automatisch nachgesichert.`,
          iconName: 'warning',
        }, 8000);
        if (typ === 'rabatt' && !editId) zeigeRabattcodes(savedItem.id);
        return;
      }
    }
    // Rabattcodes sind kein Guthaben: kein Geldregen, dafuer gleich zeigen, wo er liegt
    // (beim Aendern liegt die Rabattcode-Seite darunter und zeigt den neuen Stand)
    if (typ === 'rabatt') {
      zu();
      playSfx('coin'); buzz(20);
      island(editId ? 'Rabattcode geändert' : 'Rabattcode gespeichert');
      if (!editId) zeigeRabattcodes(savedItem.id);
      return;
    }
    // Ka-ching! Neues Guthaben in der Wallet
    playSfx('kaching');
    buzz(35);
    moneyFlash('green');
    billRain(7);
    island('In der Wallet gespeichert');
    // Warten noch unvollständige Gutscheine aus dem Mehrfach-Upload (oder
    // weitere geteilte Bilder)? Dann bleibt die Seite offen und fuellt sich neu
    if (typ !== 'voucher' || !(waFixQueue.length || geteiltSchlange.length) || !nextFixOrDone()) {
      zu();
      blattAuffrischen();
    }
  });

  // Zurueck per Pfeil, Wisch oder Esc: Eingaben, Bild und Scan waeren weg.
  // Verglichen wird mit dem Stand direkt nach dem Fuellen (Vorbelegung zaehlt
  // nicht); Warteschlange und laufender Stapel fragen immer.
  const formStand = () => JSON.stringify([gewaehlt, addImg, addCodeImg, waEinheit,
    ...[...el.querySelectorAll('.wa-form input:not([type="file"]):not([type="search"]), .wa-form textarea')]
      .map(x => x.type === 'checkbox' ? x.checked : x.value)]);
  const anfang = formStand();
  seite.zurueckFrage = () => {
    if (waSaving) return '';                    // liegt schon in der Wallet, Sichern laeuft
    if (seite.stapelLaeuft) return 'Die Bilder werden noch gescannt. Vollständig erkannte Gutscheine kommen trotzdem in die Wallet, unvollständige nicht. Trotzdem schließen?';
    const rest = waFixQueue.length + geteiltSchlange.length;
    const geaendert = formStand() !== anfang;
    if (!geaendert && !rest) return '';
    const teile = geaendert ? ['Deine Eingaben sind noch nicht gespeichert.'] : [];
    if (rest) teile.push(geaendert
      ? `Auch ${rest === 1 ? 'das übrige Bild wird' : `die übrigen ${rest} Bilder werden`} nicht gespeichert.`
      : `${rest === 1 ? 'Ein weiteres Bild wartet' : `${rest} weitere Bilder warten`} noch und ${rest === 1 ? 'wird' : 'werden'} dann nicht gespeichert.`);
    return teile.join(' ') + ' Verwerfen?';
  };

  // Nach aussen: Warteschlange und Teilen fuellen die Seite ueber diese Griffe
  waApi = {
    seite,
    bild: src => bildZeigen(src),
    shop: name => setzeShop(name),
    aktualisieren,
    hinweis: (art, html) => {
      inhalt.querySelectorAll('.wa-hinweis.' + art).forEach(x => x.remove());
      const b = document.createElement('div');
      b.className = 'wa-hinweis ' + art;
      b.innerHTML = `${icon(art === 'dupe' ? 'warning' : 'bulb', 'icon')}<span>${html}</span>`;
      inhalt.prepend(b);
      inhalt.scrollTop = 0;
      return b;
    },
  };
}

// ---- Detail: Guthaben, Abbuchen/Aufladen mit Notiz, Verlauf mit Revert
// An der Kasse gehoeren Sparkarte und Gutschein zusammen: erst die Karte
// scannen lassen, dann mit dem Gutschein zahlen. Diese beiden Helfer
// verknuepfen die Wallet quer — vom Gutschein zur Karte und zurueck.
function karteZuMarke(vendor) {
  const k = String(vendor || '').trim().toLowerCase();
  return state.wallet.cards.find(c => String(c.name || '').trim().toLowerCase() === k) || null;
}
// Gutscheine derselben Marke mit Restguthaben — kleinster zuerst, damit man
// erst die Reste aufbraucht statt einen vollen Gutschein anzubrechen
function gutscheineZuMarke(name, max = 3) {
  const k = String(name || '').trim().toLowerCase();
  return state.wallet.vouchers
    .filter(v => !ohneGuthaben(v))
    .filter(v => String(v.vendor || '').trim().toLowerCase() === k)
    .filter(v => v.balance == null || v.balance > 0)
    .sort((a, b) => (a.balance ?? Infinity) - (b.balance ?? Infinity))
    .slice(0, max);
}

// Die Sparkarte sieht ueberall gleich aus: eine Bankkarte im Markenton, nur
// Vorderseite. Links Logo, Chip, Nummer und Art, rechts auf weissem Grund der
// Code fuer die Kasse — nichts muss umgedreht werden. Ohne Barcode-Daten steht
// ehrlich nur die Nummer da (kein erfundener Strichcode).
// Alle Masse haengen an der Kartenbreite (cqw): die Miniatur im Seitenkopf ist
// dieselbe Karte in klein, die Lupe zoomt aus ihr heraus.
// (Die Einzahl-Tabelle steht in der Funktion: renderWallet laeuft schon beim
// Start, bevor ein const hier oben erreicht waere.)
function sparkarteArt(name) {
  const einzahl = { 'Supermärkte': 'Supermarkt' };
  const k = String(name || '').trim().toLowerCase();
  for (const sec of COUPON_SOURCES) {
    if (sec.items.some(it => it.name.toLowerCase() === k)) return einzahl[sec.cat] || sec.cat;
  }
  return 'Sparkarte';
}
// Was die Kasse scannen kann: ein Foto vom Code oder ein EAN-13 aus der Nummer
function sparkarteCode(c) {
  const src = c.codeImg || c.img;
  if (src) return `<img class="dk-code" src="${esc(src)}" alt="Code für die Kasse">`;
  const nummer = kartennummerLesbar(c.number).replace(/\s+/g, '');
  // Hoehere Balken fuellen das Code-Feld besser und sind leichter zu treffen
  return nummer ? ean13Svg(nummer, 140) : '';
}
// Kartennummer nur, wenn sie wie eine aussieht (Ziffern, 5 bis 40 — Pfandbon-
// Codes haben bis zu 33 Stellen). Ein
// gescannter QR-Code liefert oft Text ("DTP#privileges:loyalty-pro …") —
// der ist fuer die Kasse im Bild da, aber keine Nummer zum Anzeigen.
function kartennummerLesbar(n) {
  const t = String(n || '').replace(/[\s-]+/g, '');
  return /^\d{5,40}$/.test(t) ? t.replace(/(.{4})/g, '$1 ').trim() : '';
}
// Auf der Karte steht nur die Marke (Wunsch des Nutzers); Nummer und Code
// zeigt die grosse Ansicht. Leere Karte: nur der Hinweis.
function sparkarteHtml(c, klein, { leer = false, leerText = 'Keine Karte hinterlegt', zeile = '' } = {}) {
  const marke = brandColor(c.name);
  const nummer = kartennummerLesbar(c.number);
  const code = leer ? '' : sparkarteCode(c);
  const text = leer ? leerText : '';
  return `
    <div class="debitkarte${klein ? ' mini' : ''}${code ? ' mit-code' : ''}${leer ? ' leer' : ''}${!leer && !nummer ? ' ohne-nummer' : ''}"
      style="--bc:${marke}; --tc:${brandTextColor(c.name)}" data-karte="${esc(c.id || '')}">
      <div class="dk-flaeche dk-vorne">
        <div class="dk-links">
          <div class="dk-oben">
            ${brandChipHtml(c.name)}
            <span class="dk-marke">${esc(c.name)}</span>
          </div>
          <div class="dk-chip" aria-hidden="true"></div>
          ${text ? `<div class="dk-nummer">${esc(text)}</div>` : ''}
          ${leer && zeile ? `<div class="dk-unten"><span>${esc(zeile)}</span></div>` : ''}
        </div>
        ${code ? `<div class="dk-code-feld">${code}</div>` : ''}
      </div>
    </div>`;
}

// ---- Verschenken als eigene Seite: oben der Gutschein, darunter an wen und
// eine Nachricht, unten fest der Knopf. Kam man vom Gutschein, fuehrt der
// Pfeil dorthin zurueck; aus der Auswahl zurueck in die Auswahl.
function zeigeSchenkSchritt(v) {
  if (!v) return;
  if (walletGesperrt()) { aktualisiereSperre(); return; } // gesperrte Wallet: nichts zeigen
  if (!state.token) { island('Zum Verschenken bitte anmelden'); return; }
  if (schenktGerade(v.id)) { island('Wird gerade verschenkt …'); return; }
  // Pfandbons gelten nur in ihrer Filiale (und das Papier bleibt bei dir)
  if (istPfand(v)) { island('Pfandbons kann man nicht verschenken'); return; }
  // Rabattcodes gehen genauso weg — aber nur, solange sie noch gelten
  const rabatt = istRabatt(v);
  if (rabatt && !rabattVerschenkbar(v)) {
    island(v.eingeloest ? 'Eingelöste Rabattcodes kann man nicht verschenken' : 'Abgelaufene Rabattcodes kann man nicht verschenken');
    return;
  }
  const freunde = myProfile?.friends || [];
  let anWen = '', suche = '', nachricht = '';

  const freundeHtml = () => {
    // Gesucht wird im Anzeigenamen und im @Namen
    const s = suche.toLowerCase();
    const gefiltert = s ? freunde.filter(f => f.toLowerCase().includes(s) || anzeigeName(f).toLowerCase().includes(s)) : freunde;
    return gefiltert.map(f => `
      <button class="gp-freund${anWen === f ? ' gewaehlt' : ''}" type="button" data-gp-an="${esc(f)}" aria-pressed="${anWen === f}">
        ${avatarHtml(f, undefined, 'gp-ava')}
        ${nameMitHandleHtml(f, 'gp-name')}
        <span class="gp-haken">${icon('check', 'icon icon-sm')}</span>
      </button>`).join('') || '<p class="gp-leer">Niemand gefunden.</p>';
  };

  const seite = wseiteOeffnen({
    art: 'schenken', id: v.id, titel: 'Verschenken', klasse: 'gp',
    baue: s => {
      s.el.querySelector('.wseite-inhalt').innerHTML = `
        <div class="schenk-karte" id="schenk-karte">${rabatt ? rabattCardHtml(v, { schau: true }) : voucherCardHtml(v)}</div>
        ${freunde.length ? `
        <div class="gp-block">
          <h3 class="gd-h">An wen?</h3>
          ${freunde.length > 6 ? `<input class="gd-feld gp-suche" type="search" placeholder="Freund suchen …" autocomplete="off" aria-label="Freund suchen">` : ''}
          <div class="gd-block gp-freunde">${freundeHtml()}</div>
        </div>
        <div class="gp-block">
          <h3 class="gd-h">Nachricht <small>freiwillig, max. 140 Zeichen</small></h3>
          <div class="gp-eingabe">
            <input class="gd-feld gp-text" maxlength="140" placeholder="Viel Spaß damit!" autocomplete="off" aria-label="Nachricht">
            <button class="gp-emote-btn" type="button" aria-label="Emotes" aria-expanded="false">${icon('smile')}</button>
          </div>
          <div class="gp-emotes hidden"></div>
        </div>
        <p class="gp-haftung">
          ${rabatt
            ? `Der Rabattcode wechselt endgültig den Besitzer — zurückholen geht nicht.
          Manche Codes gelten nur einmal pro Konto oder nur für Neukunden; kumulio
          haftet nicht dafür, ob er beim Freund funktioniert.`
            : `Der Gutschein wechselt endgültig den Besitzer — zurückholen geht nicht.
          kumulio verwahrt keine Gutscheine und haftet nicht für Wert, Gültigkeit
          oder Einlösbarkeit.`} Verschenke nur an Leute, die du kennst.
          <a href="/agb.html#verschenken" target="_blank" rel="noopener">AGB, Abschnitt 7</a>
        </p>` : `
        <div class="gd-block gp-keine">
          <p>Verschenken geht nur an Freunde — und du hast noch keine.</p>
          <button class="gd-los" type="button" data-gs="freunde">Freunde finden</button>
        </div>`}`;
      if (freunde.length) {
        s.el.insertAdjacentHTML('beforeend', `
          <div class="wseite-leiste gp-leiste">
            <button class="gd-los gp-senden" type="button" disabled>Freund auswählen</button>
          </div>`);
      }
    },
  });
  if (!seite) return;
  const host = seite.el;

  host.querySelector('[data-gs="freunde"]')?.addEventListener('click', () => {
    wseitenZu();
    switchView('friends', 'enter-drop');
  });
  const senden = host.querySelector('.gp-senden');
  const liste = host.querySelector('.gp-freunde');
  const verdrahteFreunde = () => liste?.querySelectorAll('[data-gp-an]').forEach(b => b.onclick = () => {
    anWen = b.dataset.gpAn;
    // Nur die Auswahl umhaengen statt neu zu zeichnen (Fokus bleibt im Feld)
    liste.querySelectorAll('.gp-freund').forEach(x => {
      const an = x.dataset.gpAn === anWen;
      x.classList.toggle('gewaehlt', an);
      x.setAttribute('aria-pressed', String(an));
    });
    if (senden) { senden.disabled = false; knopfAnName(senden, anzeigeOderAt(anWen), 'verschenken'); }
    buzz(8);
  });
  verdrahteFreunde();
  const suchfeld = host.querySelector('.gp-suche');
  // Filtern gleicht die Liste an: bleibende Freunde gleiten nach oben, neue blenden ein
  if (suchfeld) suchfeld.oninput = e => { suche = e.target.value; inhaltAngleichen(liste, freundeHtml()); verdrahteFreunde(); };
  const text = host.querySelector('.gp-text');
  if (text) text.oninput = e => { nachricht = e.target.value; };

  // Emotes wie im Chat: Namen in Doppelpunkten, beim Anzeigen werden Bilder daraus
  const emoteBtn = host.querySelector('.gp-emote-btn');
  const emoteBox = host.querySelector('.gp-emotes');
  if (emoteBtn && emoteBox) emoteBtn.onclick = () => {
    const auf = !offenWeich(emoteBox);
    if (auf && !emoteBox.dataset.gebaut) {
      const namen = Object.keys(allEmoteIds()).filter(emoteOwned);
      emoteBox.innerHTML = namen.length
        ? namen.map(n => `<button class="emote-pick" type="button" data-gp-emote="${esc(n)}">${emoteHtml(n)}</button>`).join('')
        : '<span class="gp-leer">Noch keine Emotes da.</span>';
      emoteBox.dataset.gebaut = '1';
      emoteBox.querySelectorAll('[data-gp-emote]').forEach(e => e.onclick = () => {
        if (!text) return;
        nachricht = (text.value + (text.value ? ' ' : '') + ':' + e.dataset.gpEmote + ':').slice(0, 140);
        text.value = nachricht;
        text.focus();
      });
    }
    // Klappt weich auf und zu, der Hinweis darunter gleitet mit
    zeigeWeich(emoteBox, auf);
    emoteBtn.setAttribute('aria-expanded', String(auf));
    buzz(6);
  };

  const pfeil = host.querySelector('.wseite-zurueck');
  if (senden) senden.onclick = async () => {
    if (!anWen || senden.disabled || walletGesperrt()) return;
    senden.disabled = true;
    senden.textContent = 'Wird verpackt …';
    const aktuell = state.wallet.vouchers.find(x => x.id === v.id) || v;
    // Bis der Server antwortet, bleibt die Seite stehen (kein Zurueck, kein
    // Wisch, kein Esc) und der Gutschein laesst sich nirgends buchen — der
    // Stand hier ist schon unterwegs, eine Abbuchung jetzt ginge verloren
    seite.fest = true;
    seite.sendet = true;
    if (pfeil) pfeil.disabled = true;
    schenktGerade.ids.add(aktuell.id);
    try {
      // Liegt das Originalfoto noch nur auf dem Geraet, erst hoch damit —
      // der Server gibt es beim Verschenken an den Freund weiter
      if (aktuell.orig && (origWartend().includes(aktuell.id) || origUploadLaeuft)) {
        await Promise.race([origHochladen().catch(() => { }), new Promise(ok => setTimeout(ok, 20000))]);
      }
      // Die eigene Notiz bleibt hier: ohne sie und etwas juenger als der Stand
      // am Konto, damit beim Vereinigen diese Fassung gewinnt
      const { notiz: _notiz, ...ohneNotiz } = aktuell;
      const antwort = api('/api/gift/send', { method: 'POST', body: JSON.stringify({
        to: anWen, id: aktuell.id, msg: (nachricht || '').trim(),
        // Die Fassung hier zaehlt (samt noch nicht gesicherter Abbuchung)
        voucher: _notiz ? { ...ohneNotiz, mt: Math.max(Date.now(), (aktuell.mt || 0) + 1) } : aktuell,
      }) });
      antwort.catch(() => { });
      // Antwortet der Server nicht, gibt die Seite nach 45 s frei. Ob das
      // Geschenk trotzdem rausging, klaert der Abgleich mit dem Konto: dort
      // steht dann ein Loeschmarker, und ein zweiter Versuch wird abgelehnt.
      await Promise.race([antwort, new Promise((_, nein) => setTimeout(() => {
        const f = new Error('Keine Antwort vom Server. Wir gleichen deine Wallet ab, ob das Geschenk rausging.');
        f.zeitUm = true;
        nein(f);
      }, 45000))]);
    } catch (err) {
      if (err && err.zeitUm) pullWallet().catch(() => { });
      schenktGerade.ids.delete(aktuell.id);
      seite.fest = false;
      seite.sendet = false;
      if (pfeil) pfeil.disabled = false;
      senden.disabled = false;
      knopfAnName(senden, anzeigeOderAt(anWen), 'verschenken');
      island(err.message || 'Hat nicht geklappt');
      wseitenAbgleichen();
      return;
    }
    // Erst wenn der Server den Gutschein wirklich uebergeben hat, verschwindet
    // er hier — sonst waere er bei einem Fehler in beiden Wallets weg.
    tombstone(aktuell.id);
    state.wallet.vouchers = state.wallet.vouchers.filter(x => x.id !== aktuell.id);
    schenktGerade.ids.delete(aktuell.id);
    saveWallet();
    // Inzwischen gesperrt (Seiten sind dann schon zu): nur noch Bescheid geben
    if (!wseiten().includes(seite)) {
      renderWallet();
      island(`An ${anzeigeOderAt(anWen)} verschenkt`);
      return;
    }
    // Erst raeumt sich die Seite ab, dann faehrt die Karte in die Schachtel
    await seiteAufDieKarte(host);
    await packAnimation($('#schenk-karte'), 'ein');
    if (wseiten().includes(seite)) wseitenZu({ sanft: true });
    renderWallet();
    island(`An ${anzeigeOderAt(anWen)} verschenkt`); playSfx('plop'); buzz([12, 40, 18]);
  };
}
// Gutscheine, die gerade verschenkt werden: bis zur Antwort des Servers tabu
function schenktGerade(id) { return !!schenktGerade.ids?.has(id); }
schenktGerade.ids = new Set();

// Vor dem Einpacken raeumt sich die Seite ab: Freunde, Nachricht, Hinweis und
// Knopf blenden gestaffelt aus, nur die Karte bleibt stehen. Erst danach faehrt
// sie in die Schachtel — sonst passiert beides gleichzeitig.
function seiteAufDieKarte(host) {
  return new Promise(fertig => {
    if (reducedMotion() || !host.animate) return fertig();
    const weg = [...host.querySelectorAll('.wseite-kopf, .gp-block, .gp-haftung, .gp-leiste')];
    weg.forEach((el, i) => {
      el.style.pointerEvents = 'none';
      el.animate(
        [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(14px)' }],
        { duration: 240, delay: i * 55, easing: 'cubic-bezier(.4,0,.8,.4)', fill: 'forwards' });
    });
    setTimeout(fertig, 240 + Math.max(0, weg.length - 1) * 55 + 80);
  });
}

// Einpacken und Auspacken sind dieselbe Bewegung, nur rueckwaerts: die Karte
// faehrt in die Schachtel (oder aus ihr heraus), die Schachtel federt dabei
// gegen. Beides laeuft ueber transform und opacity, damit es auch auf einem
// aelteren Handy nicht ruckelt.
function packAnimation(kartenEl, richtung = 'ein') {
  return new Promise(fertig => {
    if (!kartenEl || reducedMotion() || !kartenEl.animate) return fertig();
    const r = kartenEl.getBoundingClientRect();
    const buehne = document.createElement('div');
    buehne.className = 'pack-buehne';
    buehne.innerHTML = `
      <div class="pack-karte" style="left:${r.left}px; top:${r.top}px; width:${r.width}px; height:${r.height}px">
        ${kartenEl.innerHTML}
      </div>
      <img class="pack-box" src="/gamification/gift.svg" alt="" width="120" height="120">
      <span class="pack-blitz" aria-hidden="true"></span>`;
    document.body.appendChild(buehne);

    const karte = buehne.querySelector('.pack-karte');
    const box = buehne.querySelector('.pack-box');
    const blitz = buehne.querySelector('.pack-blitz');
    // Wohin schrumpft die Karte? Genau in die Mitte der Schachtel.
    const br = box.getBoundingClientRect();
    const dx = (br.left + br.width / 2) - (r.left + r.width / 2);
    const dy = (br.top + br.height / 2) - (r.top + r.height / 2);

    const gross = { transform: 'translate(0px, 0px) scale(1) rotate(0deg)', opacity: 1 };
    const klein = { transform: `translate(${dx}px, ${dy}px) scale(.16) rotate(-14deg)`, opacity: 0 };
    const ein = richtung === 'ein';

    kartenEl.style.visibility = 'hidden';
    const aK = karte.animate(ein ? [gross, klein] : [klein, gross], {
      // Langsamer als zuerst gebaut: bei 520 ms war die Karte in der
      // Schachtel, bevor man ueberhaupt hingesehen hatte.
      duration: ein ? 780 : 820,
      easing: ein ? 'cubic-bezier(.5, 0, .75, .2)' : 'cubic-bezier(.18, 1.1, .35, 1)',
      fill: 'forwards', delay: ein ? 120 : 260,
    });
    box.animate(
      ein
        ? [{ transform: 'scale(.2)', opacity: 0, offset: 0 },
           { transform: 'scale(.85)', opacity: 1, offset: .55 },
           { transform: 'scale(1.16)', opacity: 1, offset: .78 },
           { transform: 'scale(1)', opacity: 1, offset: 1 }]
        : [{ transform: 'scale(1)', opacity: 1, offset: 0 },
           { transform: 'scale(1.18)', opacity: 1, offset: .22 },
           { transform: 'scale(.4)', opacity: 0, offset: 1 }],
      { duration: ein ? 940 : 620, delay: ein ? 120 : 0,
        easing: 'cubic-bezier(.3, 1.2, .45, 1)', fill: 'forwards' });
    blitz.animate(
      [{ transform: 'scale(.3)', opacity: 0 },
       { transform: 'scale(1)', opacity: .85, offset: .5 },
       { transform: 'scale(1.7)', opacity: 0 }],
      { duration: 640, delay: ein ? 700 : 90, easing: 'ease-out', fill: 'forwards' });

    const raus = () => {
      if (!buehne.isConnected) return;
      buehne.remove();
      kartenEl.style.visibility = '';
      fertig();
    };
    aK.onfinish = () => setTimeout(raus, ein ? 520 : 80);
    setTimeout(raus, 2000);   // Sicherheitsnetz, falls onfinish ausbleibt
  });
}


// Hoechstens eine Lupe ist offen — hier steht die, die gerade laeuft.
// (Diese Zeile ist beim Umbau in Runde 99 verlorengegangen. Ohne sie warf
// gleich die erste Zeile von zeigeKarteGross einen ReferenceError, die
// Funktion brach ab, bevor ueberhaupt ein Element entstand — deshalb passierte
// beim Tippen auf die Sparkarte gar nichts.)
let lupeOffen = null;

// Der Kern: eine Karte gross in die Mitte holen, den Rest unscharf, und den
// Weg dorthin aus der Kachel heraus rechnen statt zu raten. Beide Wege in die
// Lupe (Marken-Raster und Gutschein-Blatt) benutzen dieselbe Funktion — sonst
// laufen die beiden Ansichten frueher oder spaeter auseinander.
function zeigeKarteGross({ karteObj, name, leerHtml, vonEl, aktionen = [], hinweis = '' }) {
  if (lupeOffen) return;
  buzz(12);
  const lupe = document.createElement('div');
  lupe.className = 'karten-lupe';
  lupe.innerHTML = `
    <div class="lupe-grund"></div>
    <div class="lupe-mitte">
      <div class="lupe-buehne">${karteObj ? sparkarteHtml(karteObj) : leerHtml}</div>
      ${karteObj && kartennummerLesbar(karteObj.number) ? `<div class="lupe-nummer">${esc(kartennummerLesbar(karteObj.number))}</div>` : ''}
      ${karteObj && sparkarteCode(karteObj) ? `<p class="lupe-zoomhinweis">${icon('search', 'icon icon-sm')} Code antippen zum Vergrößern</p>` : ''}
      <div class="lupe-knoepfe">
        ${aktionen.filter(a => !a.verwalten).map((a) => `<button class="btn btn-small ${a.leise ? 'btn-ghost' : ''}"
          data-lupe="${aktionen.indexOf(a)}">${a.icon ? icon(a.icon, 'icon icon-sm') : ''} ${esc(a.text)}</button>`).join('')}
      </div>
      ${aktionen.some(a => a.verwalten) ? `
        <div class="lupe-verwalten">
          ${aktionen.filter(a => a.verwalten).map((a) => `<button class="lupe-link ${a.gefahr ? 'gefahr' : ''}"
            data-lupe="${aktionen.indexOf(a)}">${esc(a.text)}</button>`).join('<span class="lupe-trenner">·</span>')}
        </div>` : ''}
      ${hinweis ? `<p class="lupe-hinweis">${esc(hinweis)}</p>` : ''}
    </div>`;
  document.body.appendChild(lupe);
  lupeOffen = lupe;

  const karte = lupe.querySelector('.debitkarte');
  const knoepfe = lupe.querySelector('.lupe-knoepfe');
  const von = vonEl?.getBoundingClientRect();
  const nach = karte.getBoundingClientRect();
  // Kommt die Karte aus ihrer eigenen Miniatur (Seitenkopf), hebt sie sich
  // dort heraus: die Miniatur ist so lange leer, bis sie zurueckgefahren ist.
  const ausMiniatur = vonEl?.classList?.contains('debitkarte') ? vonEl : null;

  // Code und Nummer stehen vorn — die Karte zoomt nur noch heraus, sie dreht
  // sich nicht mehr. Nur transform (die Karte bleibt ein eigenes Ebenenbild).
  const fahren = (auf) => {
    if (!von || !von.width || !karte.animate || reducedMotion()) return null;
    const s = von.width / nach.width;
    const dx = (von.left + von.width / 2) - (nach.left + nach.width / 2);
    const dy = (von.top + von.height / 2) - (nach.top + nach.height / 2);
    const klein = `translate3d(${dx}px, ${dy}px, 0) scale(${s})`;
    const gross = 'translate3d(0, 0, 0) scale(1)';
    return karte.animate(
      auf ? [{ transform: klein }, { transform: gross }]
          : [{ transform: gross }, { transform: klein }],
      { duration: auf ? 460 : 320, easing: auf ? 'cubic-bezier(.22, 1, .32, 1)' : 'cubic-bezier(.4, 0, .7, .3)',
        fill: 'forwards' });
  };

  requestAnimationFrame(() => {
    lupe.classList.add('an');
    const a = fahren(true);
    if (ausMiniatur && a) ausMiniatur.style.visibility = 'hidden';
    if (a) a.onfinish = () => a.cancel();
  });

  const zu = () => {
    if (lupeOffen !== lupe) return;
    lupeOffen = null;
    lupe.classList.remove('an');
    knoepfe.style.opacity = '0';
    const a = fahren(false);
    const weg = () => {
      if (!lupe.isConnected) return;
      if (ausMiniatur) ausMiniatur.style.visibility = '';
      lupe.remove();
    };
    if (a) { a.onfinish = weg; setTimeout(weg, 420); } else setTimeout(weg, 260);
  };

  lupe.querySelector('.lupe-grund').onclick = zu;
  const codeFeld = karte.querySelector('.dk-code-feld');
  if (codeFeld && karteObj) {
    codeFeld.setAttribute('role', 'button');
    codeFeld.setAttribute('aria-label', 'Code vergrößern');
    codeFeld.tabIndex = 0;
    codeFeld.onclick = e => { e.stopPropagation(); zeigeCodeGross(karteObj, codeFeld); };
  }
  aktionen.forEach((a, i) => {
    lupe.querySelector(`[data-lupe="${i}"]`).onclick = () => {
      if (a.bleibt) return a.fn?.();
      zu(); a.fn?.();
    };
  });
  const escTaste = e => { if (e.key === 'Escape') { zu(); removeEventListener('keydown', escTaste); } };
  addEventListener('keydown', escTaste);
  return { zu, karte };
}

// Loeschen an einer Stelle, nicht an dreien. Fragt immer nach — eine Sparkarte
// mit abfotografiertem Barcode ist nicht in zwei Sekunden wiederhergestellt.
async function karteLoeschen(c) {
  if (!c) return;
  if (!await askConfirm(`Bist du sicher, dass du die ${esc(c.name)}-Karte löschen willst?`)) return;
  tombstone(c.id);
  state.wallet.cards = state.wallet.cards.filter(x => x.id !== c.id);
  saveWallet();
  document.querySelector('.karten-lupe .lupe-grund')?.click();   // Lupe zu
  if (state.sheetMode === 'brand') closeSheet();
  island('Karte gelöscht');
}

// Steht kein scanbarer Code auf der Karte, sagt die Lupe ehrlich, was geht
// Code gross zum Scannen: weisser Grund, Code so breit wie moeglich, darunter
// die Nummer. Waechst aus dem Code-Feld der Karte heraus; Tippen schliesst.
function zeigeCodeGross(c, vonEl) {
  const code = sparkarteCode(c);
  if (!code || document.querySelector('.code-gross')) return;
  buzz(10);
  const nr = kartennummerLesbar(c.number);
  const el = document.createElement('div');
  el.className = 'code-gross';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', `${c.name}-Code`);
  el.innerHTML = `
    <div class="cg-kopf">${brandChipHtml(c.name)}<b>${esc(c.name)}</b></div>
    <div class="cg-code">${code}</div>
    ${nr ? `<div class="cg-nummer">${esc(nr)}</div>` : ''}
    <p class="cg-hinweis">Bildschirm heller stellen hilft beim Scannen · Tippen schließt</p>`;
  document.body.appendChild(el);
  const ziel = el.querySelector('.cg-code');
  const von = vonEl?.getBoundingClientRect();
  const nach = ziel.getBoundingClientRect();
  requestAnimationFrame(() => el.classList.add('an'));
  if (von && von.width && ziel.animate && !reducedMotion()) {
    const s = Math.min(von.width / nach.width, von.height / nach.height);
    const dx = (von.left + von.width / 2) - (nach.left + nach.width / 2);
    const dy = (von.top + von.height / 2) - (nach.top + nach.height / 2);
    ziel.animate([{ transform: `translate3d(${dx}px, ${dy}px, 0) scale(${s})` }, { transform: 'none' }],
      { duration: 380, easing: 'cubic-bezier(.22, 1, .32, 1)' });
  }
  const zu = () => {
    el.classList.remove('an');
    removeEventListener('keydown', taste);
    setTimeout(() => el.remove(), reducedMotion() ? 0 : 220);
  };
  const taste = e => { if (e.key === 'Escape') zu(); };
  addEventListener('keydown', taste);
  el.onclick = zu;
}
function sparkarteHinweis(c) {
  if (!c || sparkarteCode(c)) return '';
  return kartennummerLesbar(c.number)
    ? 'Kein Barcode gespeichert: an der Kasse die Nummer nennen oder unter „Ändern“ ein Foto vom Code anhängen.'
    : 'Häng unter „Ändern“ ein Foto vom Barcode an, dann kannst du ihn hier scannen lassen.';
}

// Aus dem Marken-Raster: Karte plus die zwei Wege, die von dort weitergehen
function oeffneKartenLupe(key, kachel) {
  if (walletGesperrt()) { aktualisiereSperre(); return; } // gesperrte Wallet: nichts zeigen
  const b = walletBrands().find(x => x.key === key);
  if (!b) return;
  const gesperrt = b.coupons && !ccBesitzt(b.coupons);
  zeigeKarteGross({
    karteObj: b.card, name: b.name, vonEl: kachel,
    leerHtml: sparkarteHtml({ name: b.name }, false, { leer: true, zeile: brandUntertitel(b) }),
    aktionen: [
      { text: 'Coupons & App', icon: 'tag', fn: () => openBrandSheet(key) },
      b.card
        ? (kartennummerLesbar(b.card.number) ? { text: 'Nummer kopieren', icon: 'check', leise: true, bleibt: true, fn: () => copyText(kartennummerLesbar(b.card.number).replace(/\s+/g, '')) } : null)
        : { text: 'Sparkarte hinzufügen', icon: 'plus', leise: true, fn: () => openWalletAdd('card', b.name) },
      // Verwalten steht direkt unter der Karte, in einer leisen zweiten Zeile —
      // dort sucht man es, wenn die Karte gerade vor einem liegt.
      ...(b.card ? [
        { text: 'Ändern', verwalten: true, fn: () => openWalletAdd('card', b.card.name, b.card.id) },
        { text: 'Löschen', verwalten: true, gefahr: true, bleibt: true, fn: () => karteLoeschen(b.card) },
      ] : []),
    ].filter(Boolean),
    hinweis: b.card ? sparkarteHinweis(b.card) : gesperrt ? 'Für diese Coupons brauchst du die Sparkarte.' : '',
  });
}


// showKarteBig ist entfallen: beide Wege zur grossen Karte laufen jetzt ueber
// zeigeKarteGross (Zoom aus der Kachel, Rest unscharf; seit Runde 118 ohne
// Umdrehen — der Code steht rechts auf der Vorderseite).

// =============================================================================
// Wallet-Seiten (Runde 117): Gutschein, Verschenken und Analyse sind eigene
// Seiten statt Blaetter von unten. Sie gleiten von rechts ueber die ganze App
// (Kopfzeile und Menue eingeschlossen) und stapeln sich: Gutschein ->
// Verschenken. Zurueck per Pfeil oben links, Wisch nach rechts oder Esc.
// Bewegt wird nur transform und opacity.
// Der Zustand haengt an der Funktion statt an einem let hier oben: renderWallet
// laeuft schon beim Start, lange bevor diese Zeilen erreicht sind (TDZ).
// =============================================================================

// -----------------------------------------------------------------------------
// Weiche Wechsel (Runde 118): was sich auf den Seiten und in der Wallet-Liste
// aendert, gleitet und blendet, statt hart ausgetauscht zu werden. Bleibende
// Elemente gleiten an ihren neuen Platz (FLIP), neue blenden ein, wegfallende
// blenden als Abbild aus. Bewegt wird nur transform und opacity; ohne Bewegung
// (System oder Einstellung "Animationen aus") passiert alles sofort.
// Keine let/const hier oben (siehe TDZ-Hinweis darueber) — nur Funktionen.
// -----------------------------------------------------------------------------
// (reducedMotion ist ein const weiter oben — laeuft renderWallet schon beim
// Einlesen des Skripts, gibt es ihn noch nicht: dann eben ohne Bewegung)
function weich() { try { return !reducedMotion(); } catch { return false; } }
function imBild(r, rand = 60) { return !!(r && (r.width || r.height) && r.bottom > -rand && r.top < innerHeight + rand); }
// Sichtbare Lage merken (samt laufender Bewegung — von dort geht es weiter)
function lagenMerken(els) {
  const m = new Map();
  for (const el of els) if (el && el.isConnected) m.set(el, el.getBoundingClientRect());
  return m;
}
// ... und nach dem Umbau von dort an den neuen Platz gleiten. Liegt auch das
// Elternteil in der Liste, zaehlt nur der eigene Anteil der Verschiebung.
function lagenGleiten(lagen, { dauer = 340, kurve = 'cubic-bezier(.22, 1, .36, 1)', max = 48 } = {}) {
  if (!lagen || !lagen.size || !weich()) return;
  const els = [...lagen.keys()].filter(el => el.isConnected);
  els.forEach(el => el.getAnimations?.().forEach(a => { if (a.id === 'gleiten') a.cancel(); }));
  const delta = new Map();
  for (const el of els) {
    const alt = lagen.get(el), neu = el.getBoundingClientRect();
    if (!neu.width && !neu.height) continue;
    delta.set(el, [alt.left - neu.left, alt.top - neu.top, imBild(alt) || imBild(neu)]);
  }
  let n = 0;
  for (const [el, [dx0, dy0, sichtbar]] of delta) {
    const eltern = delta.get(el.parentElement);
    const dx = dx0 - (eltern ? eltern[0] : 0), dy = dy0 - (eltern ? eltern[1] : 0);
    if (!sichtbar || (Math.abs(dx) < 1 && Math.abs(dy) < 1) || !el.animate) continue;
    if (++n > max) break;
    const a = el.animate([{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
      { duration: dauer, easing: kurve });
    a.id = 'gleiten';
  }
}
// Alles, was im Fluss hinter el steht (auch hinter seinen Eltern) — bis zum Rahmen
function folgeElemente(el, bis) {
  const out = [];
  for (let x = el; x && x !== bis && x.parentElement && out.length < 40; x = x.parentElement) {
    for (let s = x.nextElementSibling; s && out.length < 40; s = s.nextElementSibling) {
      if (!s.classList.contains('hidden') && !s.classList.contains('wl-geist')) out.push(s);
    }
    if (x.parentElement === bis) break;
  }
  return out;
}
// Ein- und Ausklappen (Suche, Emotes, Scan-Ergebnis ...): das Element blendet
// ein bzw. aus, was darunter steht, gleitet mit statt zu springen
function zeigeWeich(el, an, { bis = null, dauer = 260 } = {}) {
  if (!el) return;
  const lauf = (el._zwLauf || 0) + 1;
  el._zwLauf = lauf;
  const offen = !el.classList.contains('hidden') && !el._zwWeg;
  el.getAnimations?.().forEach(a => { if (a.id === 'zeigen') a.cancel(); });
  if (!weich() || !el.isConnected || !el.animate) { el._zwWeg = false; el.classList.toggle('hidden', !an); return; }
  if (an === offen) { if (!an) el.classList.add('hidden'); return; }
  const rahmen = bis || el.closest('.wseite-inhalt') || el.closest('.wseite') || document.body;
  const folgende = folgeElemente(el, rahmen);
  if (an) {
    el._zwWeg = false;
    const lagen = lagenMerken(folgende);
    el.classList.remove('hidden');
    const a = el.animate([{ opacity: 0, transform: 'translate3d(0, -6px, 0) scale(.985)' }, { opacity: 1, transform: 'none' }],
      { duration: dauer, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    a.id = 'zeigen';
    lagenGleiten(lagen, { dauer: dauer + 60 });
    return;
  }
  el._zwWeg = true;
  const a = el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translate3d(0, -6px, 0) scale(.985)' }],
    { duration: 150, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
  a.id = 'zeigen';
  let getan = false;
  const fertig = () => {
    if (getan || el._zwLauf !== lauf) return;
    getan = true;
    el._zwWeg = false;
    const lagen = lagenMerken(folgende);
    el.classList.add('hidden');
    a.cancel();
    lagenGleiten(lagen);
  };
  a.onfinish = fertig;
  setTimeout(fertig, 400);   // falls onfinish ausbleibt (Tab im Hintergrund)
}
// Ist el sichtbar (und nicht gerade beim Ausblenden)?
function offenWeich(el) { return !!el && !el.classList.contains('hidden') && !el._zwWeg; }
// Ganzen Inhalt tauschen (Zeitraum, Filter, Formular): der alte blendet kurz
// aus, der neue gleitet aus der Richtung herein (-1 links, 1 rechts, 0 unten)
function tauscheWeich(host, fuellen, { richtung = 0, bis = null } = {}) {
  if (!host) return;
  const lauf = (host._twLauf || 0) + 1;
  host._twLauf = lauf;
  host.getAnimations?.().forEach(a => { if (a.id === 'tauschen') a.cancel(); });
  const rahmen = bis || host.closest('.wseite-inhalt') || host.parentElement;
  const umbauen = () => {
    const lagen = lagenMerken(folgeElemente(host, rahmen));
    fuellen();
    lagenGleiten(lagen);
  };
  if (!weich() || !host.isConnected || !host.getClientRects().length || !host.animate) { fuellen(); return; }
  const dx = richtung * 22, dy = richtung ? 0 : 10;
  const raus = host.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translate3d(${-dx}px, 0, 0)` }],
    { duration: 110, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
  raus.id = 'tauschen';
  let getan = false;
  const weiter = () => {
    if (getan || host._twLauf !== lauf) return;
    getan = true;
    umbauen();
    raus.cancel();
    const rein = host.animate([{ opacity: 0, transform: `translate3d(${dx}px, ${dy}px, 0)` }, { opacity: 1, transform: 'none' }],
      { duration: 280, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    rein.id = 'tauschen';
  };
  raus.onfinish = weiter;
  setTimeout(weiter, 260);
}
// Neue Elemente gleiten gestaffelt herein (nur die, die man sieht)
function reinGleiten(els, { versatz = 12, dauer = 320, stufe = 34, bisStufe = 8, id = 'rein', von = null } = {}) {
  if (!weich()) return;
  let i = 0;
  for (const el of els) {
    if (!el || !el.isConnected || !el.animate) continue;
    const r = el.getBoundingClientRect();
    if (!imBild(r, 0)) continue;
    // von: Ort, aus dem das Element kommt (aufgefaecherter Stapel)
    const start = von
      ? `translate3d(${von.left - r.left}px, ${von.top - r.top}px, 0) scale(.96)`
      : `translate3d(0, ${versatz}px, 0) scale(.985)`;
    el.getAnimations().forEach(a => { if (a.id === id) a.cancel(); });
    const a = el.animate([{ opacity: 0, transform: start }, { opacity: 1, transform: 'none' }],
      { duration: dauer, delay: Math.min(i, bisStufe) * stufe, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'backwards' });
    a.id = id;
    i++;
  }
}
// Abbild eines wegfallenden Elements: liegt kurz an der alten Stelle und blendet
// aus (optional in Richtung ziel, etwa in den Stapel zurueck)
function geistAusblenden(el, rect, host, ziel = null, stehend = false) {
  if (!weich() || !host || !rect || !imBild(rect, 0)) return;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const g = el.cloneNode(true);
  g.classList.add('wl-geist');
  g.removeAttribute('id');
  g.querySelectorAll('[id]').forEach(x => x.removeAttribute('id'));
  for (const x of [g, ...g.querySelectorAll('*')]) {
    for (const a of [...x.attributes]) if (a.name.startsWith('data-') || a.name === 'role' || a.name === 'tabindex') x.removeAttribute(a.name);
  }
  g.setAttribute('aria-hidden', 'true');
  g.inert = true;
  const h = host.getBoundingClientRect();
  Object.assign(g.style, {
    position: 'absolute', left: (rect.left - h.left) + 'px', top: (rect.top - h.top) + 'px',
    width: rect.width + 'px', height: rect.height + 'px', margin: '0', pointerEvents: 'none',
  });
  // Ein ueberblendetes Abbild liegt ueber der neuen Fassung; ein wegfahrendes
  // unter allem, was gerade an seinen Platz gleitet
  if (stehend) host.appendChild(g);
  else host.insertBefore(g, host.firstChild);
  // stehend: an derselben Stelle steht schon die neue Fassung — nur ueberblenden
  const nach = ziel
    ? `translate3d(${ziel.left - rect.left}px, ${ziel.top - rect.top}px, 0) scale(.96)`
    : stehend ? 'none' : 'translate3d(0, -4px, 0) scale(.97)';
  const a = g.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: nach }],
    { duration: ziel ? 300 : stehend ? 260 : 190, easing: stehend ? 'ease-out' : 'cubic-bezier(.4, 0, .6, 1)', fill: 'forwards' });
  const weg = () => g.remove();
  a.onfinish = weg;
  setTimeout(weg, 600);
}

// Liste abgleichen statt neu zu schreiben: Kinder mit gleichem Schluessel und
// gleichem Quelltext bleiben stehen (keine Auftritts-Animation, kein Flackern),
// geaenderte werden an Ort und Stelle ersetzt, neue blenden ein, wegfallende
// als Abbild aus. Was bleibt oder denselben Schluessel wieder hat, gleitet an
// seinen neuen Platz (auch ueber Ebenen: Karte im Stapel -> Karte in der Liste).
//   schluessel(el): Schluessel eines Elements ('' = keiner)
//   bewegt: false = nur abgleichen, nichts animieren (unsichtbar, erster Aufbau)
//   herkunft(el): Ort, aus dem ein neues Element kommt (Stapel auffaechern)
//   ziel(el): Ort, in den ein wegfallendes Element faehrt (Stapel schliessen)
function listeSchluessel(el) {
  if (!el || el.nodeType !== 1) return '';
  const d = el.dataset;
  return d.key || (d.wv && 'v:' + d.wv) || (d.deckTop && 'v:' + d.deckTop) || (d.deck && 'deck:' + d.deck)
    || (d.deckMore && 'mehr:' + d.deckMore) || '';
}
function listeAngleichen(host, html, { bewegt = true, herkunft = null, ziel = null, bis = null } = {}) {
  if (!host) return { neu: [] };
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const neuKinder = [...tpl.content.children];
  bewegt = bewegt && weich() && host.isConnected && host.getClientRects().length > 0;
  // Vorher: Lage aller Elemente mit Schluessel (auch verschachtelt) und dessen, was folgt
  const altLage = new Map();
  if (bewegt) {
    host.querySelectorAll('*').forEach(e => {
      if (e.classList.contains('wl-geist') || e.closest('.wl-geist')) return;
      const s = listeSchluessel(e);
      if (s && !altLage.has(s)) altLage.set(s, e.getBoundingClientRect());
    });
  }
  const folgende = bewegt ? lagenMerken(folgeElemente(host, bis || host.parentElement)) : null;
  // Oberste Ebene: ohne Schluessel zaehlt Art + Reihenfolge
  const topSchluessel = (e, z) => {
    const s = listeSchluessel(e) || (e.tagName + '.' + ((e.getAttribute('class') || '').split(' ')[0]));
    z[s] = (z[s] || 0) + 1;
    return s + '#' + z[s];
  };
  const altTop = new Map();
  const za = {};
  [...host.children].forEach(e => { if (!e.classList.contains('wl-geist')) altTop.set(topSchluessel(e, za), e); });
  const zn = {};
  const reihe = [], frisch = [], ersetzt = new Set();
  for (const n of neuKinder) {
    const k = topSchluessel(n, zn);
    const quelle = n.outerHTML;
    const a = altTop.get(k);
    if (a && a._quelle === quelle) { reihe.push(a); altTop.delete(k); continue; }
    n._quelle = quelle;
    // Geaendert (etwa neuer Betrag): das alte Bild blendet ueber dem neuen aus
    if (a) ersetzt.add(a);
    // Ersetzt: laeuft am alten noch der Auftritt, laeuft er am neuen weiter
    if (a && bewegt) {
      a.getAnimations().forEach(x => {
        if ((x.id !== 'auftritt' && x.id !== 'rein') || x.playState === 'finished') return;
        const c = n.animate(x.effect.getKeyframes(), x.effect.getTiming());
        c.id = x.id;
        c.currentTime = x.currentTime;
      });
    }
    reihe.push(n);
    if (!a) frisch.push(n);
  }
  // Wegfallende: vor dem Entfernen die Lage fuer das Abbild merken
  const weg = [...altTop.values()];
  const geister = bewegt ? weg.map(e => [e, e.getBoundingClientRect()]).filter(([, r]) => imBild(r, 0)) : [];
  weg.forEach(e => e.remove());
  let ref = host.firstElementChild;
  for (const n of reihe) {
    while (ref && ref.classList.contains('wl-geist')) ref = ref.nextElementSibling;
    if (ref === n) { ref = ref.nextElementSibling; continue; }
    host.insertBefore(n, ref);
  }
  if (!bewegt) return { neu: frisch };
  geister.forEach(([e, r]) => geistAusblenden(e, r, host, ziel ? ziel(e) : null, ersetzt.has(e)));
  // Gleiten: alles mit Schluessel, das es vorher schon gab (bleibend oder neu gebaut)
  const lagen = new Map();
  host.querySelectorAll('*').forEach(e => {
    if (e.classList.contains('wl-geist') || e.closest('.wl-geist')) return;
    const s = listeSchluessel(e);
    // data-auch: gab es das Element unter diesem Schluessel nicht, dann unter
    // jenem (der Stapel kommt von der Stelle seiner obersten Karte)
    const k = s && altLage.has(s) ? s : (e.dataset.auch && altLage.has(e.dataset.auch) ? e.dataset.auch : '');
    if (k && !lagen.has(e)) lagen.set(e, altLage.get(k));
  });
  // Ein Element, dessen Vorfahre schon gleitet, bewegt sich mit ihm
  for (const e of [...lagen.keys()]) {
    for (let p = e.parentElement; p && p !== host; p = p.parentElement) if (lagen.has(p)) { lagen.delete(e); break; }
  }
  lagenGleiten(lagen);
  // Neue Einheiten ohne Vorgaenger blenden ein; Karten aus einem Stapel
  // kommen aus dessen Richtung
  const einheiten = [];
  for (const n of frisch) {
    if (lagen.has(n)) continue;
    const drin = [...n.querySelectorAll('*')].some(e => lagen.has(e));
    if (drin) { [...n.children].forEach(c => { if (![...lagen.keys()].some(l => c === l || c.contains(l))) einheiten.push(c); }); }
    else einheiten.push(n);
  }
  const vonStapel = herkunft ? einheiten.filter(e => herkunft(e)) : [];
  reinGleiten(einheiten.filter(e => !vonStapel.includes(e)));
  if (vonStapel.length) reinGleiten(vonStapel, { von: herkunft(vonStapel[0]), dauer: 380, stufe: 40 });
  lagenGleiten(folgende);
  return { neu: frisch };
}

// Inhalt einer Seite angleichen statt neu zu schreiben (Gutschein, Rabattcode):
// gleiche Bausteine bleiben stehen und bekommen nur geaenderte Attribute und
// Texte — so laufen CSS-Uebergaenge (Balken) weiter, nichts flackert. Neue
// Bausteine blenden ein, was folgt, gleitet mit.
function knotenSchluessel(n) {
  if (!n || n.nodeType !== 1) return '';
  return n.id ? '#' + n.id : n.dataset.tx ? 'tx:' + n.dataset.tx : n.dataset.gpAn ? 'an:' + n.dataset.gpAn : '';
}
// Art eines Knotens ohne Schluessel: Tag und die ersten beiden Klassen
// ("gd-block gd-codes" ist etwas anderes als "gd-block gd-bild")
function knotenArt(n) {
  return n.nodeType === 1 ? n.nodeName + '.' + (n.getAttribute('class') || '').trim().split(/\s+/).slice(0, 2).join('.') : '#' + n.nodeType;
}
function morpheKnoten(alt, neu, neuListe) {
  if (alt.nodeType !== neu.nodeType || alt.nodeName !== neu.nodeName) { alt.replaceWith(neu); if (neu.nodeType === 1) neuListe.push(neu); return neu; }
  if (alt.nodeType !== 1) { if (alt.nodeValue !== neu.nodeValue) alt.nodeValue = neu.nodeValue; return alt; }
  for (const a of [...alt.attributes]) if (!neu.hasAttribute(a.name)) alt.removeAttribute(a.name);
  for (const a of [...neu.attributes]) if (alt.getAttribute(a.name) !== a.value) alt.setAttribute(a.name, a.value);
  kinderMorphen(alt, neu, neuListe);
  return alt;
}
function kinderMorphen(host, quelle, neuListe) {
  const altK = [...host.childNodes].filter(k => !(k.nodeType === 1 && k.classList.contains('wl-geist')));
  const benutzt = new Set();
  const mitS = new Map();
  altK.forEach(k => { const s = knotenSchluessel(k); if (s) mitS.set(s, k); });
  const reihe = [];
  for (const n of [...quelle.childNodes]) {
    const s = knotenSchluessel(n);
    let a = s ? mitS.get(s) : null;
    if (!s) { const art = knotenArt(n); a = altK.find(k => !benutzt.has(k) && !knotenSchluessel(k) && knotenArt(k) === art) || null; }
    if (a && !benutzt.has(a)) { benutzt.add(a); reihe.push(morpheKnoten(a, n, neuListe)); }
    else { reihe.push(n); if (n.nodeType === 1) neuListe.push(n); }
  }
  altK.forEach(k => { if (!benutzt.has(k)) k.remove(); });
  let ref = host.firstChild;
  for (const n of reihe) {
    if (ref === n) { ref = ref.nextSibling; continue; }
    host.insertBefore(n, ref);
  }
}
function inhaltAngleichen(host, html) {
  if (!host) return;
  if (!host.firstElementChild) { host.innerHTML = html; return; }
  const bewegt = weich() && host.getClientRects().length > 0;
  // Lagen: Bausteine und ihre direkten Kinder (Verlaufszeilen, Code-Zeilen)
  const vorher = bewegt ? lagenMerken([...host.children].flatMap(c => [c, ...c.children])) : null;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const neu = [];
  kinderMorphen(host, tpl.content, neu);
  if (!bewegt) return;
  const neuSet = new Set(neu);
  const lagen = new Map([...vorher].filter(([e]) => e.isConnected && !neuSet.has(e)));
  lagenGleiten(lagen);
  // Nur die obersten neuen Elemente blenden ein (nicht jedes Kind einzeln)
  reinGleiten(neu.filter(e => e.isConnected && !neu.some(o => o !== e && o.contains(e))), { versatz: 8, stufe: 0 });
}

function wseiten() { return wseiten.stapel || (wseiten.stapel = []); }
function wseiteOben() { const s = wseiten(); return s[s.length - 1] || null; }
function wseiteBewegt() { return !reducedMotion(); }
// Symbole, die es im Sprite nicht gibt — gleiche Strichstaerke wie dort
function wIcon(name, cls = 'icon') {
  const pfade = {
    links: '<path d="M19.5 12H5"/><path d="M11 5.5 4.5 12l6.5 6.5"/>',
    minus: '<path d="M5.5 12h13"/>',
    kopie: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.4"/><path d="M15.5 8.5V6.4a1.9 1.9 0 0 0-1.9-1.9H6.4a1.9 1.9 0 0 0-1.9 1.9v7.2a1.9 1.9 0 0 0 1.9 1.9h2.1"/>',
    stift: '<path d="M4.5 19.5l1-4.2L15.8 5a2 2 0 0 1 2.9 0l.3.3a2 2 0 0 1 0 2.9L8.7 18.5z"/><path d="M13.8 7l3.2 3.2"/>',
    notiz: '<path d="M6.5 4.5h8l3 3v12h-11z"/><path d="M14.5 4.5v3h3M9 12h6M9 15.5h4"/>',
    muell: '<path d="M4.5 7h15M9.5 7V5.2a.7.7 0 0 1 .7-.7h3.6a.7.7 0 0 1 .7.7V7M6.5 7l.9 11.6a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/><path d="M10.3 11v5.5M13.7 11v5.5"/>',
    rueck: '<path d="M9 5.5 4.5 10 9 14.5"/><path d="M4.5 10h9.5a5 5 0 0 1 0 10H11"/>',
    bild: '<rect x="4" y="5" width="16" height="14" rx="2.4"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17l4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5"/>',
    zuschnitt: '<path d="M7 3.5V17h13.5"/><path d="M3.5 7H17v13.5"/>',
    kamera: '<path d="M4.5 8.7a2 2 0 0 1 2-2h1.9l1.5-2.2h4.2l1.5 2.2h1.9a2 2 0 0 1 2 2v8.8a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.9" r="3.3"/>',
    scan: '<path d="M4.5 8.5v-2a2 2 0 0 1 2-2h2M15.5 4.5h2a2 2 0 0 1 2 2v2M19.5 15.5v2a2 2 0 0 1-2 2h-2M8.5 19.5h-2a2 2 0 0 1-2-2v-2"/><path d="M8 12h8"/>',
    // Pfandflasche (Reiter "Pfand"), Ort (Filiale) und Standort (Fadenkreuz)
    ort: '<path d="M12 20.5s-6.3-5.4-6.3-10.7a6.3 6.3 0 0 1 12.6 0c0 5.3-6.3 10.7-6.3 10.7z"/><circle cx="12" cy="9.8" r="2.3"/>',
    flasche: '<path d="M10 3.5h4M10.5 3.5v3.2c0 1-2.5 2.2-2.5 5V19a1.5 1.5 0 0 0 1.5 1.5h5A1.5 1.5 0 0 0 16 19v-7.3c0-2.8-2.5-4-2.5-5V3.5"/><path d="M8 13h8"/>',
    standort: '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
  };
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${pfade[name] || ''}</svg>`;
}

// Der Rahmen um alle Seiten: sichtbar, sobald eine offen ist. Darunter ist
// dann nichts bedienbar (inert) — auch nicht per Tastatur.
function wseitenRahmen(offen) {
  const host = $('#wseiten');
  if (!host) return;
  host.classList.toggle('offen', offen);
  host.setAttribute('aria-hidden', offen ? 'false' : 'true');
  document.body.classList.toggle('wseite-offen', offen);
  const main = document.querySelector('main');
  if (main) main.inert = offen;
  const gesperrt = document.body.classList.contains('wallet-zu');
  for (const sel of ['.topbar', '#tabbar', '#note-banner']) {
    const n = $(sel);
    if (n) n.inert = offen || gesperrt;
  }
  const blatt = $('#sheet');
  if (blatt) blatt.inert = offen ? !document.body.classList.contains('blatt-ueber-seite') : !blatt.classList.contains('open');
  $('#wallet-mini')?.classList.remove('show');
  if (offen) wseitenViewport();
  else { host.style.top = ''; host.style.height = ''; }
}
// Tastatur auf dem Handy: die Seiten nehmen nur den sichtbaren Teil ein, damit
// die Leiste unten (Abbuchen, Betrag) ueber der Tastatur steht
function wseitenViewport() {
  const host = $('#wseiten'), vv = window.visualViewport;
  if (!host || !vv || !wseiten().length || !(vv.height > 0)) return;
  host.style.top = Math.round(vv.offsetTop) + 'px';
  host.style.height = Math.round(vv.height) + 'px';
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', wseitenViewport);
  window.visualViewport.addEventListener('scroll', wseitenViewport);
}

// Neue Seite oben auf den Stapel. baue(seite) fuellt den Inhalt.
function wseiteOeffnen({ art, id = '', titel = '', klasse = '', baue, sofort = false }) {
  const host = $('#wseiten');
  if (!host) return null;
  schliesseVkMenue();
  schliesseMarkenMenue();
  const vorige = wseiteOben();
  const el = document.createElement('section');
  el.className = 'wseite' + (klasse ? ' ' + klasse : '');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', titel);
  el.tabIndex = -1;
  el.innerHTML = `
    <header class="wseite-kopf">
      <button class="wseite-zurueck" type="button" aria-label="Zurück">${wIcon('links')}</button>
      <h2 class="wseite-titel">${esc(titel)}</h2>
      <span class="wseite-rechts" aria-hidden="true"></span>
    </header>
    <div class="wseite-inhalt"></div>`;
  const seite = { el, art, id, fokusVorher: document.activeElement };
  wseiten().push(seite);
  const dimm = host.querySelector('.wseiten-dimm');
  host.appendChild(el);
  host.insertBefore(dimm, el);           // Abdunklung liegt direkt unter der obersten Seite
  wseitenRahmen(true);
  el.querySelector('.wseite-zurueck').onclick = () => wseiteVerlassen(seite);
  const inhalt = el.querySelector('.wseite-inhalt');
  inhalt.addEventListener('scroll', () => el.classList.toggle('gescrollt', inhalt.scrollTop > 2), { passive: true });
  wischZurueck(seite);
  baue(seite);
  dimm.getAnimations?.().forEach(a => a.cancel());
  dimm.style.opacity = '';
  if (!sofort && wseiteBewegt() && el.animate) {
    // In Pixeln statt Prozent: so laeuft die Bewegung sicher auf dem Compositor
    const b = wseiteBreite();
    el.animate([{ transform: `translate3d(${b}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
      { duration: 380, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    dimm.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 380, easing: 'ease-out' });
    // Wie ein Schieber: die Seite darunter weicht ein Stueck nach links aus
    if (vorige) {
      vorige.el.getAnimations().forEach(a => { if (a.id === 'unten') a.cancel(); });
      const u = vorige.el.animate([{ transform: 'translate3d(0, 0, 0)' }, { transform: `translate3d(${-wseiteVersatz()}px, 0, 0)` }],
        { duration: 380, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'forwards' });
      u.id = 'unten';
    }
  }
  // Die Seite darunter muss nicht mehr gezeichnet werden, sobald sie bedeckt ist
  if (vorige) setTimeout(() => {
    if (wseiteOben() !== seite) return;
    vorige.el.classList.add('verdeckt');
    vorige.el.getAnimations().forEach(a => { if (a.id === 'unten') a.cancel(); });
  }, sofort ? 0 : 400);
  requestAnimationFrame(() => el.focus({ preventScroll: true }));
  return seite;
}
function wseiteBreite() { return $('#wseiten')?.clientWidth || innerWidth; }
// So weit weicht die Seite darunter aus (wie bei einem Schieber)
function wseiteVersatz() { return Math.round(wseiteBreite() * .28); }
// Die Seite darunter kommt zurueck an ihren Platz (Zurueck, Wisch)
function wseiteUntenZurueck(darunter, vonP, dauer) {
  if (!darunter?.el.animate) return;
  // Laeuft das Ausweichen noch (schnell wieder zurueck), geht es von dort aus weiter
  let start = -wseiteVersatz() * (1 - vonP);
  const laeuft = darunter.el.getAnimations().filter(a => a.id === 'unten' && a.playState !== 'idle');
  if (laeuft.length && !vonP) {
    try { start = new DOMMatrixReadOnly(getComputedStyle(darunter.el).transform).m41 || 0; } catch { /* alter Browser */ }
  }
  laeuft.forEach(a => a.cancel());
  darunter.el.style.transform = '';
  if (!wseiteBewegt()) return;
  const u = darunter.el.animate([{ transform: `translate3d(${Math.round(start)}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
    { duration: dauer, easing: 'cubic-bezier(.32, .72, .4, 1)' });
  u.id = 'unten';
}

// Eine Seite zurueck. vonP: wie weit der Finger sie schon weggeschoben hat (0..1)
function wseiteZurueck({ vonP = 0, sofort = false } = {}) {
  const s = wseiten();
  const seite = s.pop();
  if (!seite) return;
  try { seite.beimSchliessen?.(); } catch { /* darf das Zurueck nicht aufhalten */ }
  const host = $('#wseiten');
  const dimm = host.querySelector('.wseiten-dimm');
  const darunter = s[s.length - 1];
  darunter?.el.classList.remove('verdeckt');
  seite.el.inert = true;
  let fertig = false;
  const weg = () => {
    if (fertig) return;
    fertig = true;
    seite.el.remove();
    // Ging inzwischen schon die naechste Seite auf, gehoert ihr die Abdunklung
    const oben = wseiteOben();
    if (oben && oben !== darunter) return;
    dimm.getAnimations?.().forEach(a => a.cancel());
    dimm.style.opacity = '';
    if (oben) host.insertBefore(dimm, oben.el);
    else wseitenRahmen(false);
    const ziel = oben ? oben.el : seite.fokusVorher;
    if (ziel?.isConnected) ziel.focus?.({ preventScroll: true });
  };
  if (sofort || !wseiteBewegt() || !seite.el.animate) { if (darunter) darunter.el.style.transform = ''; return weg(); }
  const dauer = Math.max(150, Math.round(300 * (1 - vonP)));
  const b = wseiteBreite();
  seite.el.getAnimations().forEach(x => x.cancel());
  seite.el.style.transform = '';
  const a = seite.el.animate(
    [{ transform: `translate3d(${Math.round(vonP * b)}px, 0, 0)` }, { transform: `translate3d(${b}px, 0, 0)` }],
    { duration: dauer, easing: 'cubic-bezier(.32, .72, .4, 1)', fill: 'forwards' });
  wseiteUntenZurueck(darunter, vonP, dauer);
  dimm.getAnimations?.().forEach(x => x.cancel());
  dimm.animate([{ opacity: 1 - vonP }, { opacity: 0 }], { duration: dauer, easing: 'ease-out', fill: 'forwards' });
  a.onfinish = weg;
  setTimeout(weg, dauer + 80);   // falls onfinish ausbleibt (Tab im Hintergrund)
}
// Zurueck durch den Nutzer (Pfeil, Wisch, Esc). Eine festgehaltene Seite
// (seite.fest: Verschenken laeuft) bleibt stehen. Liefert seite.zurueckFrage()
// einen Text, gibt es erst eine Rueckfrage — beim Wisch federt die Seite dafuer
// zurueck. vonP: so weit hat der Finger sie schon weggeschoben.
function wseiteVerlassen(seite, { vonP = 0 } = {}) {
  if (!seite || wseiteOben() !== seite) return;
  let frage = '';
  if (!seite.fest) { try { frage = seite.zurueckFrage?.() || ''; } catch { frage = ''; } }
  if (!seite.fest && !frage) { wseiteZurueck({ vonP }); return; }
  if (vonP) wseiteFedern(seite, vonP);
  if (seite.fest) { buzz([20, 40, 20]); return; }
  askConfirm(frage, { okLabel: 'Verwerfen' }).then(ja => {
    if (ja && wseiteOben() === seite && !seite.fest) wseiteZurueck();
  });
}

// Alle Seiten zu. sanft: die oberste blendet aus (nach Verschenken/Loeschen),
// sonst ist alles sofort weg (Sperre: keine Codes im Baum lassen).
function wseitenZu({ sanft = false } = {}) {
  const s = wseiten();
  if (!s.length) return;
  const oben = s[s.length - 1];
  while (s.length) {
    const x = s.pop();
    try { x.beimSchliessen?.(); } catch { /* weiter zumachen */ }
    if (x !== oben || !sanft || !wseiteBewegt()) x.el.remove();
  }
  const host = $('#wseiten');
  const dimm = host?.querySelector('.wseiten-dimm');
  if (!oben.el.isConnected) { dimm?.getAnimations?.().forEach(a => a.cancel()); wseitenRahmen(false); return; }
  oben.el.inert = true;
  oben.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-out', fill: 'forwards' });
  dimm?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-out', fill: 'forwards' });
  setTimeout(() => {
    oben.el.remove();
    if (wseiten().length) return;       // schon wieder eine neue Seite offen
    dimm?.getAnimations?.().forEach(a => a.cancel());
    wseitenRahmen(false);
  }, 230);
}

// Breite des linken Rands, an dem der Wisch zurueck immer greift (px)
const WISCH_RAND = 28;
// Wisch nach rechts = zurueck. Nur Finger (am Rechner gibt es den Pfeil), und
// nur waagerecht: senkrecht scrollt die Seite wie gewohnt. Die Seite folgt dem
// Finger; losgelassen faehrt sie ganz raus oder federt zurueck.
function wischZurueck(seite) {
  const el = seite.el;
  let w = null;
  el.addEventListener('pointerdown', e => {
    if (w && w.lauf) return;             // ein zweiter Finger stoert den laufenden Wisch nicht
    w = null;
    if (e.pointerType === 'mouse' || wseiteOben() !== seite || seite.fest || el.classList.contains('panel-offen')) return;
    // data-kein-wisch="rand": die Flaeche hat einen eigenen Wisch (Rang-Karte),
    // nur ganz am linken Rand bleibt es der Wisch zurueck
    const kein = e.target.closest('input, textarea, select, [data-kein-wisch]');
    if (kein && !(kein.dataset.keinWisch === 'rand' && e.clientX - el.getBoundingClientRect().left < WISCH_RAND)) return;
    w = { x: e.clientX, y: e.clientY, id: e.pointerId, lauf: false, dx: 0, b: 1, v: 0, lx: e.clientX, lt: e.timeStamp };
  }, { passive: true });
  el.addEventListener('pointermove', e => {
    if (!w || e.pointerId !== w.id) return;
    const dx = e.clientX - w.x, dy = e.clientY - w.y;
    if (!w.lauf) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { w = null; return; }
      if (dx < 14 || dx < Math.abs(dy) * 1.3) return;
      w.lauf = true;
      w.b = el.offsetWidth || innerWidth;
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetische Pointer */ }
      wseiteZiehen(seite, 0);
    }
    const dt = e.timeStamp - w.lt;
    if (dt > 0) { w.v = (e.clientX - w.lx) / dt; w.lx = e.clientX; w.lt = e.timeStamp; }
    w.dx = Math.max(0, dx);
    wseiteZiehen(seite, w.dx / w.b);
  });
  const ende = e => {
    if (!w || e.pointerId !== w.id) return;
    const war = w;
    w = null;
    if (!war.lauf) return;
    // Der Klick nach dem Wisch gehoert nicht dem Knopf unter dem Finger
    el.dataset.gewischt = '1';
    setTimeout(() => delete el.dataset.gewischt, 80);
    const p = war.dx / war.b;
    if (e.type !== 'pointercancel' && (p > .36 || (war.v > .45 && p > .05))) wseiteVerlassen(seite, { vonP: p });
    else wseiteFedern(seite, p);
  };
  el.addEventListener('pointerup', ende);
  el.addEventListener('pointercancel', ende);
  // Nur die eigene Capture zaehlt: am Handy haelt das angetippte Kind die
  // implizite Touch-Capture, deren Verlust hochblubbert und den Wisch sonst
  // gleich nach der ersten Bewegung beendete
  el.addEventListener('lostpointercapture', e => { if (e.target === el) ende(e); });
  el.addEventListener('click', e => {
    if (el.dataset.gewischt) { e.stopPropagation(); e.preventDefault(); }
  }, true);
}
function wseiteZiehen(seite, p) {
  const s = wseiten();
  const darunter = s[s.indexOf(seite) - 1];
  darunter?.el.classList.remove('verdeckt');
  seite.el.getAnimations?.().forEach(a => a.cancel());
  const dimm = $('#wseiten .wseiten-dimm');
  dimm?.getAnimations?.().forEach(a => a.cancel());
  seite.el.style.transform = `translate3d(${Math.round(p * wseiteBreite())}px, 0, 0)`;
  if (dimm) dimm.style.opacity = String(1 - p);
  // Die Seite darunter folgt dem Finger ein Stueck (wie beim Hineinschieben)
  if (darunter && wseiteBewegt()) {
    darunter.el.getAnimations().forEach(a => a.cancel());
    darunter.el.style.transform = `translate3d(${Math.round(-wseiteVersatz() * (1 - p))}px, 0, 0)`;
  }
}
function wseiteFedern(seite, p) {
  const el = seite.el;
  const dimm = $('#wseiten .wseiten-dimm');
  const s = wseiten();
  const darunter = s[s.indexOf(seite) - 1];
  const fertig = () => {
    el.style.transform = '';
    if (dimm) dimm.style.opacity = '';
    if (darunter) {
      darunter.el.getAnimations().forEach(a => { if (a.id === 'unten') a.cancel(); });
      darunter.el.style.transform = '';
      if (wseiteOben() === seite) darunter.el.classList.add('verdeckt');
    }
  };
  if (!el.animate || !wseiteBewegt()) return fertig();
  const a = el.animate([{ transform: `translate3d(${Math.round(p * wseiteBreite())}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
    { duration: 260, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  dimm?.animate([{ opacity: 1 - p }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
  if (darunter) {
    darunter.el.style.transform = '';
    const u = darunter.el.animate([{ transform: `translate3d(${Math.round(-wseiteVersatz() * (1 - p))}px, 0, 0)` },
      { transform: `translate3d(${-wseiteVersatz()}px, 0, 0)` }], { duration: 260, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'forwards' });
    u.id = 'unten';
  }
  el.style.transform = '';
  if (dimm) dimm.style.opacity = '';
  a.onfinish = fertig;
}
// Esc: erst das Aufgeklappte der obersten Seite, dann die Seite selbst
addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !wseiten().length) return;
  if (document.querySelector('.overlay:not(.hidden), .karten-lupe, .bild-lupe, .vk-menue:not(.zu), .pack-buehne')) return;
  if (document.body.classList.contains('blatt-ueber-seite')) return;   // das Blatt schliesst sich selbst
  e.stopPropagation();
  e.preventDefault();
  const oben = wseiteOben();
  if (oben.el.classList.contains('panel-offen')) return gdPanelZu(oben);
  if (oben.el.querySelector('.gd-leiste.auf')) return gdOptionen(oben, false);
  // Hinzufuegen: erst die aufgeklappte Shop-Suche zu
  if (offenWeich(oben.el.querySelector('.wa-suche'))) return oben.el.querySelector('#wa-vendor-showmore')?.click();
  // Im Eingabefeld verlaesst Esc nur das Feld, nicht gleich die ganze Seite
  const feld = document.activeElement;
  if (feld && oben.el.contains(feld) && feld.matches('input, textarea, select')) { feld.blur(); oben.el.focus({ preventScroll: true }); return; }
  wseiteVerlassen(oben);
}, true);

// Geht ein Blatt auf, waehrend eine Seite offen ist (etwa "Karte zeigen" aus
// dem Laden-Hinweis), gehoert es nach oben. Die Klasse faellt weg, sobald das
// Blatt zu ist. (Sparkarte hinzufuegen und aendern sind seit Runde 118 selbst
// Seiten und legen sich einfach obendrauf — dafuer braucht es kein Blatt mehr.)
if ($('#sheet') && 'MutationObserver' in window) {
  let blattWarOffen = false;
  new MutationObserver(() => {
    const blatt = $('#sheet');
    const offen = blatt.classList.contains('open');
    if (offen && !blattWarOffen) {
      blattWarOffen = true;
      if (wseiten().length) { document.body.classList.add('blatt-ueber-seite'); blatt.inert = false; }
    } else if (!offen && blattWarOffen) {
      blattWarOffen = false;
      document.body.classList.remove('blatt-ueber-seite');
      if (wseiten().length) blatt.inert = true;
    }
  }).observe($('#sheet'), { attributes: true, attributeFilter: ['class'] });
}

// Nach jedem renderWallet: offene Seiten an den neuen Stand anpassen. Ist ihr
// Gutschein weg (anderes Geraet, verschenkt), gehen sie zu.
function wseitenAbgleichen() {
  const s = wseiten();
  if (!s.length) return;
  // Deal-Seiten zeigen nichts aus der Wallet: sie bleiben bei Sperre und fuer Gaeste offen
  if (walletGesperrt() || !state.token) { if (s.some(x => x.art !== 'deal' && (!state.token || !istLioSeite(x)))) wseitenZu(); return; }
  if (s.some(x => x.sendet)) return;          // Verschenken laeuft gerade
  for (let i = 0; i < s.length; i++) {
    const seite = s[i];
    if (seite.art === 'rabatt') {
      const r = state.wallet.vouchers.find(x => x.id === seite.id && istRabatt(x));
      if (!r) {
        while (s.length > i + 1) wseiteZurueck({ sofort: true });
        wseiteZurueck();
        return;
      }
      if (seite.stand !== rpStand(r) && !seite.el.querySelector('.gd-leiste.auf')) zeichneRabattSeite(seite);
      continue;
    }
    if (seite.art === 'pfand') {
      const pv = state.wallet.vouchers.find(x => x.id === seite.id && istPfand(x));
      if (!pv) {
        while (s.length > i + 1) wseiteZurueck({ sofort: true });
        wseiteZurueck();
        return;
      }
      if (seite.stand !== pdStand(pv) && !seite.el.querySelector('.gd-leiste.auf')) zeichnePfandSeite(seite);
      continue;
    }
    if (seite.art === 'rang') {
      if (seite.stand !== rangSeitenStand()) zeichneRangSeite(seite);
      continue;
    }
    if (seite.art !== 'gutschein' && seite.art !== 'schenken') continue;
    const v = state.wallet.vouchers.find(x => x.id === seite.id);
    if (!v) {
      while (s.length > i + 1) wseiteZurueck({ sofort: true });
      wseiteZurueck();
      return;
    }
    if (seite.art === 'gutschein' && seite.stand !== gdStand(v) && !seite.el.classList.contains('panel-offen')) {
      zeichneGutscheinSeite(seite);
    }
  }
  const oben = wseiteOben();
  if (oben?.art === 'analyse') zeichneAnalyse(oben, { nurWennNeu: true });
}

// =============================================================================
// Gutschein-Seite: grosse Karte, Code und PIN zum Kopieren, Bild, Sparkarte,
// Notiz und Verlauf. Unten fest: Abbuchen und Aufladen, darunter der Pfeil zu
// den weiteren Aktionen (Verschenken, Anmerken, Bearbeiten, Loeschen).
// =============================================================================
function gdStand(v) {
  const k = karteZuMarke(v.vendor);
  return [itemHash(v), k ? k.id + ':' + itemHash(k) : '', state.token ? 1 : 0,
    walletPlatz('gutscheine').voll ? 1 : 0].join('|');
}
function gdAbgelaufen(v) { return !!v.end && Date.parse(v.end + 'T23:59:59') < Date.now(); }
function gdLoeschbar(v) {
  return v.balance == null || v.balance <= 0 || gdAbgelaufen(v) || walletPlatz('gutscheine').voll;
}

// Alte Aufrufe (Marken-Blatt, Bild tauschen) landen auf der neuen Seite
function openVoucherSheet(id, animFrom) { oeffneGutscheinSeite(id, { animFrom }); }
function oeffneGutscheinSeite(id, { animFrom = null, buchen = 0 } = {}) {
  if (walletGesperrt()) { aktualisiereSperre(); return; } // gesperrte Wallet: nichts zeigen
  const v = state.wallet.vouchers.find(x => x.id === id);
  if (!v) return;
  if (schenktGerade(id)) { island('Wird gerade verschenkt …'); return; }
  if (istRabatt(v)) return openRabattSheet(id);
  if (istPfand(v)) return oeffnePfandSeite(id);
  if (v.giftFrom && !v.giftSeen) { v.giftSeen = true; saveWallet(); }
  // Dieselbe Seite liegt schon oben (Bild getauscht): nur neu zeichnen
  const oben = wseiteOben();
  if (oben && oben.art === 'gutschein' && oben.id === id) {
    zeichneGutscheinSeite(oben, { animFrom });
    if (buchen) gdBuchenOeffnen(oben, buchen);
    return;
  }
  buzz(8);
  const seite = wseiteOeffnen({
    art: 'gutschein', id, titel: v.vendor, klasse: 'gd',
    baue: s => zeichneGutscheinSeite(s, { animFrom }),
  });
  if (seite && buchen) setTimeout(() => { if (wseiteOben() === seite) gdBuchenOeffnen(seite, buchen); }, wseiteBewegt() ? 300 : 0);
}

// Motiv hinten auf der Karte: das Marken-Logo gross und blass
function vkMotivHtml(v) {
  const url = markenLogoUrl(v.vendor, 128);
  return url
    ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`
    : `<i>${esc(brandInitials(v.vendor))}</i>`;
}

function gutscheinSeiteHtml(v, karte) {
  const farbe = brandColor(v.vendor);
  const tag = d => d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const zeit = ts => new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  const ende = v.end ? new Date(v.end + 'T12:00:00') : null;
  const hatBetrag = v.balance != null;
  const pct = hatBetrag && v.amount ? Math.max(0, Math.min(1, (v.balance || 0) / v.amount)) : 1;
  const fuss = ende && !isNaN(ende)
    ? (gdAbgelaufen(v) ? `abgelaufen am ${tag(ende)}` : `Gültig bis ${tag(ende)}`)
    : 'ohne Ablaufdatum';

  const codeZeile = (label, wert) => `
    <div class="gd-code-zeile">
      <span class="gd-code-text"><small>${label}</small><b>${esc(wert)}</b></span>
      <button class="gd-kopier" type="button" data-copy-txt="${esc(wert)}" aria-label="${label} kopieren" title="${label} kopieren">${wIcon('kopie')}</button>
    </div>`;
  const codes = v.code || v.pin
    ? `<div class="gd-block gd-codes">${v.code ? codeZeile('Code', v.code) : ''}${v.pin ? codeZeile('PIN', v.pin) : ''}</div>`
    : `<button class="gd-block gd-leer" type="button" data-gd="bearbeiten">${wIcon('stift')}<span>Code oder PIN ergänzen</span></button>`;

  const bildSrc = v.codeImg || v.img;
  const bild = bildSrc ? `
    <div class="gd-block gd-bild">
      <img class="${v.codeImg ? 'wallet-code-img' : 'wallet-img'}" id="wv-bild" src="${esc(bildSrc)}"
        alt="${v.codeImg ? 'Code für die Kasse' : 'QR/Barcode'}" role="button" tabindex="0" aria-label="Bild vergrößern">
      <div class="gd-bild-knoepfe">
        <label class="gd-bild-knopf">${wIcon('bild')}<span>Tauschen</span>
          <input type="file" id="wv-img-file" accept="image/*" style="display:none"></label>
        <button class="gd-bild-knopf" id="wv-img-crop" type="button">${wIcon('zuschnitt')}<span>Zuschneiden</span></button>
        <button class="gd-bild-knopf gd-bild-lupe" id="wv-img-zoom" type="button" aria-label="Bild vergrößern" title="Vergrößern">${icon('search')}</button>
      </div>
    </div>` : `
    <label class="gd-block gd-leer">${wIcon('bild')}<span>Bild vom Code hinzufügen</span>
      <input type="file" id="wv-img-file" accept="image/*" style="display:none"></label>`;

  // Sparkarte: an der Kasse gehoert sie zum Gutschein dazu. Liegt sie in der
  // Wallet, sitzt sie oben rechts im Seitenkopf (gutscheinSeiteKopf) — ohne
  // Scrollen griffbereit. Hier unten steht nur noch "hinzufuegen".
  const sparkarte = karte || cardApp(v.vendor)?.ohneKarte ? '' : `
    <button class="gd-block gd-zeile" type="button" id="wv-addkarte">
      <span class="gd-zeile-plus">${brandChipHtml(v.vendor)}<i>${icon('plus')}</i></span>
      <span class="gd-zeile-text"><b>Sparkarte hinzufügen</b><small>Dann hast du die ${esc(v.vendor)}-Karte an der Kasse gleich dabei</small></span>
      ${icon('chevron', 'icon gd-pfeil')}
    </button>`;

  const notiz = v.notiz ? `
    <button class="gd-block gd-notiz" type="button" data-gd="notiz" aria-label="Notiz ändern">
      <span class="gd-notiz-kopf">${wIcon('notiz')}<small>Notiz</small>${wIcon('stift', 'icon gd-notiz-stift')}</span>
      <span class="gd-notiz-text">${esc(v.notiz)}</span>
    </button>` : '';

  // Verlauf: neueste Buchung oben, ganz unten der Anfang (hinzugefuegt/geschenkt)
  const buchungen = (v.tx || []).map(t => {
    const minus = t.amt < 0;
    return `
      <div class="gd-tx${t.reverted ? ' zurueck' : ''}" data-tx="${esc(t.id)}">
        <span class="gd-tx-zeichen ${minus ? 'minus' : 'plus'}">${minus ? wIcon('minus') : icon('plus')}</span>
        <span class="gd-tx-text"><b>${esc(t.note || (minus ? 'Abbuchung' : 'Aufladung'))}</b>
          <small>${zeit(t.ts)}${t.reverted ? ' · rückgängig gemacht' : ''}</small></span>
        <span class="gd-tx-betrag ${minus ? 'minus' : 'plus'}">${minus ? '−' : '+'}${euroFmt(Math.abs(t.amt))}</span>
        ${t.reverted ? '<span class="gd-tx-platz"></span>'
          : `<button class="gd-tx-rueck" type="button" data-revert="${esc(t.id)}" aria-label="Buchung rückgängig machen" title="Rückgängig">${wIcon('rueck')}</button>`}
      </div>`;
  }).join('');
  const anfang = v.added ? `
      <div class="gd-tx anfang">
        <span class="gd-tx-zeichen anfang">${icon(v.giftFrom ? 'gift' : 'wallet')}</span>
        <span class="gd-tx-text"><b>${v.giftFrom ? `Geschenk von ${esc(anzeigeOderAt(v.giftFrom))}` : 'Hinzugefügt'}</b><small>${zeit(v.added)}</small></span>
        <span class="gd-tx-betrag">${v.amount != null ? euroFmt(v.amount) : ''}</span>
        <span class="gd-tx-platz"></span>
      </div>` : '';

  return `
    <div class="gd-karte${brandHelligkeit(farbe) > 0.62 ? ' hell' : ''}" id="gd-karte"
      style="--bc:${farbe}; --tc:${brandTextColor(v.vendor)}">
      <span class="vk-motiv gd-motiv" aria-hidden="true">${vkMotivHtml(v)}</span>
      <div class="gd-karte-kopf">
        <span class="vk-logo">${brandChipHtml(v.vendor)}</span>
        <span class="gd-karte-namen"><b>${esc(v.vendor)}</b><span>${v.giftFrom ? `Geschenk von ${esc(anzeigeOderAt(v.giftFrom))}` : 'Gutschein'}</span></span>
      </div>
      ${hatBetrag ? `
      <div class="gd-guthaben"><b id="gd-guthaben">${euroFmt(v.balance)}</b>
        ${v.amount != null && v.amount !== v.balance ? `<span>von ${euroFmt(v.amount)}</span>` : ''}</div>
      ${v.amount ? `<div class="gd-balken" role="img" aria-label="${Math.round(pct * 100)} Prozent übrig"><i style="transform:scaleX(${pct.toFixed(4)})"></i></div>` : ''}` : ''}
      <div class="gd-karte-fuss">${entferntAmHtml(v)}<span>${fuss}</span></div>
    </div>
    ${codes}
    ${bild}
    ${sparkarte}
    ${notiz}
    ${buchungen || anfang ? `<h3 class="gd-h">Verlauf</h3><div class="gd-block gd-verlauf">${buchungen}${anfang}</div>` : ''}`;
}

// Die feste Leiste unten. Die weiteren Aktionen liegen unter dem Pfeil: die
// Leiste ist so hoch wie alles zusammen, zugeklappt aber um die Aktionen nach
// unten verschoben (nur transform) — aufklappen schiebt sie hoch.
function gdLeisteHtml(v) {
  const hatBetrag = v.balance != null;
  const rest = hatBetrag && v.balance > 0;
  const opts = [
    rest && state.token && ['schenken', 'Verschenken', 'An Freunde weitergeben'],
    ['notiz', v.notiz ? 'Notiz ändern' : 'Anmerken', 'Eine Notiz nur für dich'],
    ['bearbeiten', 'Bearbeiten', 'Code, PIN und Gültigkeit'],
    gdLoeschbar(v) && ['loeschen', 'Gutschein löschen', ''],
  ].filter(Boolean);
  const bild = { schenken: icon('gift'), notiz: wIcon('notiz'), bearbeiten: wIcon('stift'), loeschen: wIcon('muell') };
  return `
    <div class="wseite-leiste gd-leiste">
      ${hatBetrag ? `<div class="gd-knoepfe">
        <button class="gd-knopf gd-ab" type="button" data-buchen="-1"${rest ? '' : ' disabled'}>${wIcon('minus')}<span>Abbuchen</span></button>
        <button class="gd-knopf gd-auf" type="button" data-buchen="1">${icon('plus')}<span>Aufladen</span></button>
      </div>` : ''}
      <button class="gd-mehr" type="button" aria-expanded="false" aria-controls="gd-optionen">
        <span>Mehr</span>${icon('chevron-down', 'icon gd-mehr-pfeil')}</button>
      <div class="gd-optionen" id="gd-optionen" role="menu" aria-label="Weitere Aktionen">
        ${opts.map(([k, t, sub]) => `
        <button class="gd-option${k === 'loeschen' ? ' gefahr' : ''}" type="button" role="menuitem" data-gd="${k}" tabindex="-1">
          <span class="gd-option-bild">${bild[k]}</span>
          <span class="gd-option-text"><b>${t}</b>${sub ? `<small>${sub}</small>` : ''}</span>
        </button>`).join('')}
      </div>
      <div class="gd-fuss" aria-hidden="true"></div>
    </div>`;
}

function zeichneGutscheinSeite(seite, { animFrom = null } = {}) {
  const v = state.wallet.vouchers.find(x => x.id === seite.id);
  if (!v) return;
  const el = seite.el;
  const inhalt = el.querySelector('.wseite-inhalt');
  const scroll = inhalt.scrollTop;
  const karte = karteZuMarke(v.vendor);
  seite.stand = gdStand(v);
  el.querySelector('.wseite-titel').textContent = v.vendor;
  el.setAttribute('aria-label', `${v.vendor}-Gutschein`);
  gutscheinSeiteKopf(el, v, karte);
  // Angleichen statt neu schreiben: nach dem Buchen bleibt stehen, was gleich
  // ist, der Balken gleitet, die neue Buchung blendet ein
  inhaltAngleichen(inhalt, gutscheinSeiteHtml(v, karte));
  gdLeisteSetzen(seite, gdLeisteHtml(v));
  inhalt.scrollTop = scroll;
  gdLeisteMessen(seite);
  verdrahteGutscheinSeite(seite, v, karte);
  if (animFrom != null && v.balance != null && animFrom !== v.balance) {
    animateNumber(el.querySelector('#gd-guthaben'), animFrom, v.balance);
  }
}

// Leiste unten, Abdunklung und Feld bleiben beim Neuzeichnen stehen: ein Feld,
// das nach dem Buchen gerade zugleitet, gleitet so zu Ende, statt mitten in der
// Bewegung zu verschwinden. Die Leiste wird nur getauscht, wenn sich an ihr
// etwas aendert — und dann im selben Zustand (auf/zu, gleiche Verschiebung).
function gdLeisteSetzen(seite, html) {
  const el = seite.el;
  const alt = el.querySelector('.gd-leiste');
  if (!alt || alt._quelle !== html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    const neu = tpl.content.firstElementChild;
    neu._quelle = html;
    if (alt) {
      const h = alt.style.getPropertyValue('--gd-opt-h');
      if (h) neu.style.setProperty('--gd-opt-h', h);
      if (alt.classList.contains('auf')) {
        neu.classList.add('auf');
        neu.querySelector('.gd-mehr')?.setAttribute('aria-expanded', 'true');
        neu.querySelectorAll('.gd-option').forEach(o => { o.tabIndex = 0; });
      }
      alt.replaceWith(neu);
    } else el.appendChild(neu);
  }
  if (!el.querySelector('.gd-dimm')) el.insertAdjacentHTML('beforeend', '<div class="gd-dimm" aria-hidden="true"></div>');
  if (seite.art === 'gutschein' && !el.querySelector('.gd-panel')) {
    el.insertAdjacentHTML('beforeend', '<div class="gd-panel" role="dialog" aria-modal="true"></div>');
  }
}

// Oben rechts im Seitenkopf: die passende Sparkarte als Miniatur. Antippen
// holt sie gross in die Mitte (zum Scannen). Gleiche Karte wie vorher: nichts
// neu zeichnen, damit die Miniatur beim Buchen nicht flackert.
function gutscheinSeiteKopf(el, v, karte) {
  const kopf = el.querySelector('.wseite-kopf');
  const platz = kopf?.querySelector('.wseite-rechts');
  if (!platz) return;
  const stand = karte ? JSON.stringify([karte.id, karte.name, karte.number, karte.codeImg, karte.img]) : '';
  if (platz.dataset.karte === stand) return;
  platz.dataset.karte = stand;
  kopf.classList.toggle('mit-karte', !!karte);
  if (!karte) {
    platz.innerHTML = '';
    platz.setAttribute('aria-hidden', 'true');
    return;
  }
  platz.removeAttribute('aria-hidden');
  platz.innerHTML = `
    <button class="wseite-karte" type="button" aria-label="${esc(v.vendor)}-Sparkarte zeigen" title="${esc(v.vendor)}-Sparkarte zeigen">
      ${sparkarteHtml(karte, true)}
    </button>`;
}

// Zugeklappt ragen nur die beiden Knoepfe und der Pfeil hervor: die Leiste
// wird um die Hoehe der Aktionen nach unten geschoben, der Inhalt bekommt
// unten genau so viel Luft, wie von der Leiste zu sehen ist
function gdLeisteMessen(seite) {
  const leiste = seite.el.querySelector('.gd-leiste');
  const opt = leiste?.querySelector('.gd-optionen');
  if (!opt) return;
  const optH = opt.offsetHeight;
  const wert = optH + 'px';
  if (leiste.style.getPropertyValue('--gd-opt-h') !== wert) {
    // Beim ersten Messen steht die Leiste sofort richtig — sonst glitte sie
    // beim Oeffnen der Seite sichtbar von "aufgeklappt" nach unten
    const erstes = !leiste.style.getPropertyValue('--gd-opt-h');
    if (erstes) leiste.style.transition = 'none';
    leiste.style.setProperty('--gd-opt-h', wert);
    if (erstes) { void leiste.offsetHeight; leiste.style.transition = ''; }
  }
  seite.el.style.setProperty('--gd-leiste-h', Math.max(0, leiste.offsetHeight - optH) + 'px');
}
addEventListener('resize', () => wseiten().forEach(s => { if (s.art === 'gutschein' || s.art === 'rabatt' || s.art === 'pfand' || s.art === 'deal') gdLeisteMessen(s); }), { passive: true });

function verdrahteGutscheinSeite(seite, v, karte) {
  const el = seite.el;
  el.querySelectorAll('[data-copy-txt]').forEach(b => b.onclick = () => { copyText(b.dataset.copyTxt); buzz(10); });
  // Die Sparkarte oben rechts zoomt aus ihrer Miniatur in die Mitte (wie im
  // Raster) — Code und Nummer stehen vorn, umdrehen muss man nichts.
  const kartenKnopf = el.querySelector('.wseite-karte');
  if (kartenKnopf) kartenKnopf.onclick = () => zeigeKarteGross({
    karteObj: karte, name: v.vendor, vonEl: kartenKnopf.querySelector('.debitkarte') || kartenKnopf,
    aktionen: [
      ...(kartennummerLesbar(karte.number)
        ? [{ text: 'Nummer kopieren', icon: 'check', leise: true, bleibt: true, fn: () => copyText(kartennummerLesbar(karte.number).replace(/\s+/g, '')) }]
        : []),
      // Hinzufuegen und Aendern sind eigene Seiten: sie legen sich auf diese
      { text: 'Ändern', verwalten: true, fn: () => openWalletAdd('card', karte.name, karte.id) },
      { text: 'Löschen', verwalten: true, gefahr: true, bleibt: true, fn: () => karteLoeschen(karte) },
    ],
    hinweis: sparkarteHinweis(karte) || 'Erst die Karte scannen lassen, dann mit dem Gutschein zahlen.',
  });
  const wvAdd = el.querySelector('#wv-addkarte');
  if (wvAdd) wvAdd.onclick = () => openWalletAdd('card', v.vendor);
  // Bild tauschen / zuschneiden / vergroessern — nur neu gebaute Knoepfe verdrahten
  const bildDatei = el.querySelector('#wv-img-file');
  if (!bildDatei || !bildDatei._verdrahtet) { if (bildDatei) bildDatei._verdrahtet = true; wireVoucherImage(v); }
  el.querySelectorAll('[data-revert]').forEach(b => b.onclick = () => gdRueckgaengig(seite, b.dataset.revert));
  el.querySelectorAll('[data-buchen]').forEach(b => b.onclick = () => gdBuchenOeffnen(seite, Number(b.dataset.buchen)));
  el.querySelector('.gd-mehr').onclick = () => gdOptionen(seite);
  el.querySelector('.gd-dimm').onclick = () => { gdPanelZu(seite); gdOptionen(seite, false); };
  el.querySelectorAll('[data-gd]').forEach(b => b.onclick = () => {
    const k = b.dataset.gd;
    const x = state.wallet.vouchers.find(y => y.id === seite.id);
    if (!x) return;
    if (k === 'schenken') { gdOptionen(seite, false); zeigeSchenkSchritt(x); }
    else if (k === 'notiz') gdNotizOeffnen(seite);
    else if (k === 'bearbeiten') gdBearbeitenOeffnen(seite);
    else if (k === 'loeschen') { gdOptionen(seite, false); gutscheinLoeschen(x); }
  });
}

// Weitere Aktionen unter dem Pfeil auf- und zuklappen
function gdOptionen(seite, auf) {
  const l = seite?.el.querySelector('.gd-leiste');
  if (!l) return;
  const jetzt = l.classList.contains('auf');
  if (auf === undefined) auf = !jetzt;
  if (auf === jetzt) return;
  l.classList.toggle('auf', auf);
  l.querySelector('.gd-mehr').setAttribute('aria-expanded', String(auf));
  l.querySelectorAll('.gd-option').forEach(o => { o.tabIndex = auf ? 0 : -1; });
  seite.el.querySelector('.gd-dimm')?.classList.toggle('an', auf);
  buzz(6);
}

// Ein Feld von unten (Buchen, Notiz, Bearbeiten): gleitet ueber die Leiste
function gdPanelOeffnen(seite, { titel, html, verdrahten }) {
  gdOptionen(seite, false);
  const p = seite.el.querySelector('.gd-panel');
  if (!p) return;
  p.innerHTML = `
    <div class="gd-panel-kopf"><b>${esc(titel)}</b>
      <button class="gd-panel-zu" type="button" aria-label="Schließen">${icon('x')}</button></div>
    <div class="gd-panel-inhalt">${html}</div>`;
  p.setAttribute('aria-label', titel);
  p.querySelector('.gd-panel-zu').onclick = () => gdPanelZu(seite);
  seite.el.classList.add('panel-offen');
  seite.el.querySelector('.gd-dimm')?.classList.add('an');
  p.classList.add('auf');
  verdrahten?.(p);
}
function gdPanelZu(seite) {
  const p = seite?.el.querySelector('.gd-panel.auf');
  if (!p) return;
  if (p.contains(document.activeElement)) document.activeElement.blur();
  p.classList.remove('auf');
  seite.el.classList.remove('panel-offen');
  seite.el.querySelector('.gd-dimm')?.classList.remove('an');
}

// Abbuchen / Aufladen: Betrag, Schnellbetraege (2/5/10 € und alles), Notiz
function gdBuchenOeffnen(seite, sign) {
  const v = state.wallet.vouchers.find(x => x.id === seite.id);
  if (!v || v.balance == null || walletGesperrt()) return;
  if (schenktGerade(v.id)) { island('Wird gerade verschenkt …'); return; }
  const ab = sign < 0;
  if (ab && !(v.balance > 0)) return;
  const betragText = n => n.toFixed(2).replace('.', ',');
  const vorschlaege = [[2, '2 €'], [5, '5 €'], [10, '10 €']];
  if (ab) vorschlaege.push([v.balance, `Alles · ${euroFmt(v.balance)}`]);
  else if (v.amount != null && v.amount > v.balance) {
    vorschlaege.push([Math.round((v.amount - v.balance) * 100) / 100, `Auf ${euroFmt(v.amount)}`]);
  }
  gdPanelOeffnen(seite, {
    titel: ab ? 'Abbuchen' : 'Aufladen',
    html: `
      <p class="gd-panel-info">${ab ? 'Noch' : 'Gerade'} <b>${euroFmt(v.balance)}</b> auf dem Gutschein</p>
      <label class="gd-betrag">
        <input id="gd-betrag" inputmode="decimal" enterkeyhint="done" autocomplete="off" placeholder="0,00" aria-label="Betrag in Euro">
        <span aria-hidden="true">€</span>
      </label>
      <div class="gd-vorschlaege">${vorschlaege.map(([n, t]) =>
        `<button class="gd-vorschlag" type="button" data-betrag="${n}">${esc(t)}</button>`).join('')}</div>
      <input id="gd-wofuer" class="gd-feld" maxlength="60" autocomplete="off" placeholder="Wofür? (optional)">
      <p class="gd-meldung" role="alert"></p>
      <button class="gd-los ${ab ? 'ab' : 'auf'}" type="button">${ab ? 'Abbuchen' : 'Aufladen'}</button>`,
    verdrahten: p => {
      const feld = p.querySelector('#gd-betrag');
      const los = p.querySelector('.gd-los');
      const meldung = p.querySelector('.gd-meldung');
      const zahl = () => parseFloat(String(feld.value).replace(/\s/g, '').replace(',', '.'));
      const beschriften = () => {
        const n = zahl();
        los.textContent = n > 0 ? `${euroFmt(Math.round(n * 100) / 100)} ${ab ? 'abbuchen' : 'aufladen'}` : (ab ? 'Abbuchen' : 'Aufladen');
        meldung.textContent = '';
      };
      feld.oninput = () => { p.querySelectorAll('.gd-vorschlag.an').forEach(x => x.classList.remove('an')); beschriften(); };
      p.querySelectorAll('[data-betrag]').forEach(b => b.onclick = () => {
        feld.value = betragText(Number(b.dataset.betrag));
        p.querySelectorAll('.gd-vorschlag').forEach(x => x.classList.toggle('an', x === b));
        beschriften();
        buzz(6);
      });
      const senden = () => {
        const fehler = gutscheinBuchen(seite, sign, zahl(), p.querySelector('#gd-wofuer').value);
        if (!fehler) return;
        meldung.textContent = fehler;
        if (!reducedMotion()) neuStarten(meldung, 'shake-once');
      };
      los.onclick = senden;
      feld.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); senden(); } };
      p.querySelector('#gd-wofuer').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); senden(); } };
    },
  });
}
// Gibt einen Fehlertext zurueck oder '' (gebucht)
function gutscheinBuchen(seite, sign, amt, note) {
  const v = state.wallet.vouchers.find(x => x.id === seite.id);
  if (!v || v.balance == null) return 'Diesen Gutschein gibt es nicht mehr.';
  if (walletGesperrt()) { aktualisiereSperre(); return 'Die Wallet ist gesperrt.'; }
  if (schenktGerade(v.id)) return 'Der Gutschein wird gerade verschenkt.';
  if (isNaN(amt) || amt <= 0) return 'Betrag angeben.';
  amt = Math.round(amt * 100) / 100;
  // Nie ins Minus: mehr als das Restguthaben laesst sich nicht abbuchen
  if (sign < 0 && amt > v.balance + 0.001) return `Nur noch ${euroFmt(v.balance)} drauf, mehr geht nicht.`;
  const before = v.balance;
  v.tx = v.tx || [];
  v.tx.unshift({ id: Math.random().toString(36).slice(2, 9), amt: sign * amt, note: String(note || '').trim().slice(0, 60), ts: Date.now() });
  v.balance = Math.round((v.balance + sign * amt) * 100) / 100;
  gdPanelZu(seite);
  // Erst zeichnen, dann speichern: der Abgleich nach renderWallet sieht dann
  // schon den neuen Stand und zeichnet nicht ein zweites Mal
  zeichneGutscheinSeite(seite, { animFrom: before });
  saveWallet();
  // Geld raus = Abbuchungston (vom Nutzer), rotes Aufleuchten, kurzer Ruckler
  // an der Karte; Geld rein = Ka-ching, gruenes Aufleuchten, Geldscheine
  if (sign < 0) {
    playSfx('abbuchen', .5); buzz([45, 40, 45]); moneyFlash('red');
    if (!reducedMotion()) neuStarten(seite.el.querySelector('#gd-karte'), 'shake-once');
  } else {
    playSfx('kaching'); buzz(35); moneyFlash('green'); billRain(5);
  }
  showToast({
    title: sign < 0 ? 'Abbuchung gespeichert' : 'Aufladung gespeichert',
    text: `Noch drauf: ${euroFmt(v.balance)}`,
    success: true,
  }, 3500);
  return '';
}
async function gdRueckgaengig(seite, txId) {
  // Gutschein und Buchung jedes Mal frisch holen: waehrend der Rueckfrage kann
  // ein Abgleich beide durch neue Objekte ersetzt haben
  const hole = () => {
    const v = state.wallet.vouchers.find(x => x.id === seite.id);
    return { v, t: v?.tx?.find(x => x.id === txId) };
  };
  const imMinus = ({ v, t }) => Math.round((v.balance - t.amt) * 100) / 100 < -0.001;
  const minusText = 'Erst die spätere Abbuchung rückgängig machen, sonst wäre das Guthaben im Minus';
  const vorab = hole();
  if (!vorab.t || vorab.t.reverted || schenktGerade(seite.id)) return;
  if (imMinus(vorab)) { island(minusText, 3600); return; }
  if (!await askConfirm(`${vorab.t.amt < 0 ? 'Abbuchung' : 'Aufladung'} über ${euroFmt(Math.abs(vorab.t.amt))} rückgängig machen?`,
    { okLabel: 'Rückgängig machen' })) return;
  if (walletGesperrt() || schenktGerade(seite.id)) return;
  // Nach der Rueckfrage mit dem Stand von jetzt rechnen, nicht mit dem von vorhin
  const { v, t } = hole();
  if (!t || t.reverted || v.balance == null) return;
  if (imMinus({ v, t })) { island(minusText, 3600); return; }
  const neu = Math.round((v.balance - t.amt) * 100) / 100;
  const before = v.balance;
  t.reverted = true;
  v.balance = Math.max(0, neu);
  zeichneGutscheinSeite(seite, { animFrom: before });
  saveWallet();
  island('Buchung rückgängig gemacht');
}

// Anmerken: eine Notiz nur fuer einen selbst (die Wallet-Suche findet sie)
function gdNotizOeffnen(seite) {
  const v = state.wallet.vouchers.find(x => x.id === seite.id);
  if (!v) return;
  gdPanelOeffnen(seite, {
    titel: v.notiz ? 'Notiz ändern' : 'Anmerken',
    html: `
      <textarea id="gd-notiz-feld" class="gd-feld gd-textfeld" maxlength="200" rows="3"
        placeholder="z. B. nur in der Filiale einlösbar">${esc(v.notiz || '')}</textarea>
      <p class="gd-panel-info klein">Die Wallet-Suche findet auch deine Notizen. Beim Verschenken bleibt sie bei dir.</p>
      <div class="gd-panel-knoepfe">
        ${v.notiz ? '<button class="gd-los leise" type="button" data-notiz="weg">Entfernen</button>' : ''}
        <button class="gd-los" type="button" data-notiz="ok">Speichern</button>
      </div>`,
    verdrahten: p => {
      const feld = p.querySelector('#gd-notiz-feld');
      const speichern = text => {
        const x = state.wallet.vouchers.find(y => y.id === seite.id);
        if (!x || walletGesperrt()) return;
        const neu = String(text || '').trim().slice(0, 200);
        if (neu) x.notiz = neu; else delete x.notiz;
        gdPanelZu(seite);
        zeichneGutscheinSeite(seite);
        saveWallet();
        island(neu ? 'Notiz gespeichert' : 'Notiz entfernt');
      };
      p.querySelector('[data-notiz="ok"]').onclick = () => speichern(feld.value);
      p.querySelector('[data-notiz="weg"]')?.addEventListener('click', () => speichern(''));
    },
  });
}

// Bearbeiten: Code, PIN und Gueltigkeit nachtragen oder korrigieren
function gdBearbeitenOeffnen(seite) {
  const v = state.wallet.vouchers.find(x => x.id === seite.id);
  if (!v) return;
  gdPanelOeffnen(seite, {
    titel: 'Bearbeiten',
    html: `
      <label class="gd-label" for="gd-code">Code / Kartennummer</label>
      <input id="gd-code" class="gd-feld" maxlength="40" autocomplete="off" spellcheck="false"
        placeholder="Falls vorhanden" value="${esc(v.code || '')}">
      <div class="gd-zwei">
        <div><label class="gd-label" for="gd-pin">PIN</label>
          <input id="gd-pin" class="gd-feld" maxlength="16" autocomplete="off" spellcheck="false" placeholder="optional" value="${esc(v.pin || '')}"></div>
        <div><label class="gd-label" for="gd-ende">Gültig bis</label>
          <input id="gd-ende" class="gd-feld" type="date" value="${esc(v.end || '')}"></div>
      </div>
      <button class="gd-los" type="button" data-bearb="ok">Speichern</button>`,
    verdrahten: p => {
      p.querySelector('[data-bearb="ok"]').onclick = () => {
        const x = state.wallet.vouchers.find(y => y.id === seite.id);
        if (!x || walletGesperrt()) return;
        x.code = p.querySelector('#gd-code').value.trim().slice(0, 40);
        x.pin = p.querySelector('#gd-pin').value.trim().slice(0, 16);
        const ende = p.querySelector('#gd-ende').value;
        x.end = /^\d{4}-\d{2}-\d{2}$/.test(ende) ? ende : '';
        gdPanelZu(seite);
        zeichneGutscheinSeite(seite);
        saveWallet();
        island('Gespeichert');
      };
    },
  });
}

// Loeschen gibt es nur bei aufgebrauchten oder abgelaufenen Gutscheinen (und
// wenn die Wallet voll ist), immer mit Rueckfrage
async function gutscheinLoeschen(v) {
  if (!v || !gdLoeschbar(v)) return;
  const rest = v.balance != null && v.balance > 0;
  if (!await askConfirm(rest
    ? `Auf diesem ${esc(v.vendor)}-Gutschein sind noch ${euroFmt(v.balance)}. Trotzdem löschen?`
    : `Bist du sicher, dass du den ${esc(v.vendor)}-Gutschein löschen willst?`, rest ? { okLabel: 'Trotzdem löschen' } : undefined)) return;
  if (walletGesperrt()) return;
  tombstone(v.id);
  state.wallet.vouchers = state.wallet.vouchers.filter(x => x.id !== v.id);
  wseitenZu({ sanft: true });
  saveWallet();
  island('Gutschein gelöscht');
}

// EAN-13 als SVG zeichnen. Muss sein, weil die Netto-Codes jede Woche wechseln —
// fertige Bilddateien waeren spaetestens Montag falsch. Scharf auf jedem Display
// und winzig im Vergleich zu einem PNG.
const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011',
               '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101',
               '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN_R = EAN_L.map(x => [...x].map(b => (b === '0' ? '1' : '0')).join(''));
const EAN_PAR = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
                 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

function ean13Svg(code, hoehe = 90) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 13) return '';
  const z = [...c].map(Number);
  let muster = '101';
  for (let i = 0; i < 6; i++) muster += (EAN_PAR[z[0]][i] === 'L' ? EAN_L : EAN_G)[z[i + 1]];
  muster += '01010';
  for (let i = 7; i < 13; i++) muster += EAN_R[z[i]];
  muster += '101';

  const M = 2;                       // Breite eines Moduls
  const rand = 11 * M;               // Ruhezone links und rechts
  const w = rand * 2 + muster.length * M;
  const txt = 15;
  // Start-, Mittel- und Endbalken laufen etwas tiefer, wie beim Original
  const lang = i => (i < 3) || (i >= 45 && i < 50) || (i >= 92);
  let balken = '';
  for (let i = 0; i < muster.length; i++) {
    if (muster[i] !== '1') continue;
    balken += `<rect x="${rand + i * M}" y="0" width="${M}" height="${hoehe + (lang(i) ? 6 : 0)}"/>`;
  }
  const mitte = (a, b) => rand + (a + b) / 2 * M;
  return `<svg class="ean" viewBox="0 0 ${w} ${hoehe + txt + 6}" width="${w}" height="${hoehe + txt + 6}"
      xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Barcode ${esc(c)}">
    <rect width="${w}" height="${hoehe + txt + 6}" fill="#fff"/>
    <g fill="#000">${balken}</g>
    <g fill="#000" font-family="ui-monospace, monospace" font-size="${txt}" text-anchor="middle">
      <text x="${rand / 2}" y="${hoehe + txt}">${c[0]}</text>
      <text x="${mitte(3, 45)}" y="${hoehe + txt}">${c.slice(1, 7)}</text>
      <text x="${mitte(50, 92)}" y="${hoehe + txt}">${c.slice(7)}</text>
    </g>
  </svg>`;
}

// Eine Marke buendelt alles, was zu einem Haendler gehoert: die Sparkarte in der
// Wallet, die gepflegten Coupons und den Sprung in die App. Vorher lag das in
// zwei Tabs verstreut, und dieselbe Marke tauchte doppelt auf.
function walletBrands() {
  const map = new Map();
  const hol = name => {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    if (!map.has(key)) map.set(key, { key, name: String(name).trim() });
    return map.get(key);
  };
  state.wallet.cards.forEach(c => { const b = hol(c.name); if (b) { b.card = c; b.name = c.name; } });
  (cardCouponList || []).forEach(c => {
    const b = hol(c.brand);
    if (b) { b.coupons = c; b.name = c.brand; }
  });
  COUPON_SOURCES.forEach(sec => sec.items.forEach(it => {
    const b = hol(it.name);
    if (b) { b.quelle = { ...it, cat: sec.cat }; }
  }));
  const order = JSON.parse(localStorage.getItem('ra.couponOrder') || '[]');
  const pos = n => { const i = order.indexOf(n); return i < 0 ? 999 : i; };
  // Eigene Karten zuerst, dann Marken mit Coupons, dann der Rest
  const rang = b => (b.card ? 0 : b.coupons ? 1 : 2);
  return [...map.values()].sort((a, b) =>
    rang(a) - rang(b) || pos(a.name) - pos(b.name) || a.name.localeCompare(b.name, 'de'));
}

// Was steht klein unter dem Markennamen?
function brandUntertitel(b) {
  const n = b.coupons && ccBesitzt(b.coupons) ? b.coupons.count : 0;
  const wort = `${n} Coupon${n === 1 ? '' : 's'}`;
  if (b.card && n) return `Karte · ${wort}`;
  if (b.card) return 'Sparkarte';
  if (n) return wort;
  if (b.coupons) return 'Karte nötig';
  if (/mcdonald/i.test(b.name)) return 'App oder McCheap';
  return b.quelle?.cat || 'In der App';
}

// ---- Coupons zu Sparkarten: gepflegt von der Redaktion, sichtbar nur mit
// passender Karte in der Wallet. Geladen wird erst beim Öffnen (nie auf Vorrat).
// Die Marken-Reihe ist sofort da: sie kommt aus dem Speicher des Geraets und
// wird pro Sitzung genau einmal beim Server nachgezogen. "Besitze ich die Karte?"
// rechnet die App selbst aus der Wallet aus — das braucht keinen Server.
let cardCouponList = JSON.parse(localStorage.getItem('ra.ccList') || 'null');
let ccListGeladen = false;
const ccBesitzt = c => !!c.open
  || state.wallet.cards.some(x => String(x.name || '').trim().toLowerCase() === c.key);

// Welche Marken haben gepflegte Coupons? Einmal pro Sitzung beim Server holen,
// danach steht die Liste im Speicher des Geraets — das Raster ist sofort da.
async function ladeCouponListe() {
  if (ccListGeladen || !state.token) return;   // Coupon-Sätze brauchen ein Konto
  ccListGeladen = true;
  try {
    const list = (await api('/api/cardcoupons/list')).list || [];
    const alt = JSON.stringify(cardCouponList);
    cardCouponList = list;
    lsSetzen('ra.ccList', JSON.stringify(list));
    // Nur neu zeichnen, wenn sich wirklich etwas geaendert hat — sonst flackert es
    if (JSON.stringify(list) !== alt && walletTab !== 'gutscheine') renderCoupons();
  } catch {
    ccListGeladen = false;                       // beim naechsten Mal neu versuchen
  }
}
function dateShort(iso) {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
// Die Coupon-Liste einer Karte: Gruppen mit Überschrift, Nummer groß, Preis rechts
// Favoriten und Sortierung merkt sich das Gerät (reine Ansichtssache)
let ccFavs = JSON.parse(localStorage.getItem('ra.couponFavs') || '{}');
let ccSort = localStorage.getItem('ra.couponSort') || 'gruppen';
const ccIsFav = (key, code) => (ccFavs[key] || []).includes(code);
function ccToggleFav(key, code) {
  const list = ccFavs[key] || [];
  ccFavs[key] = list.includes(code) ? list.filter(x => x !== code) : [...list, code];
  lsSetzen('ra.couponFavs', JSON.stringify(ccFavs));
}
// "9,99" -> 9.99; "50 % sparen" hat keinen Preis und wandert ans Ende
function ccPreis(p) {
  const m = String(p || '').replace(',', '.').match(/\d+(\.\d+)?/);
  return m && /[\d.,]/.test(String(p).trim()[0]) ? parseFloat(m[0]) : NaN;
}
// Einmal geladene Coupon-Saetze bleiben im Speicher des Geraets: beim naechsten
// Oeffnen steht die Liste sofort, der Server wird nur noch still nachgefragt.
const ccCache = JSON.parse(localStorage.getItem('ra.ccData') || '{}');
// Die Coupons einer Marke in einen Bereich des Marken-Blatts laden. Aus dem
// Speicher stehen sie sofort da, der Server wird nur still nachgefragt.
async function ladeCouponsIn(key, brand, host, gesperrt) {
  if (!host) return;
  if (gesperrt) {
    host.innerHTML = `<div class="cc-locked">${icon('lock', 'icon icon-sm')}
      Füge die ${esc(brand)}-Karte hinzu, dann erscheinen die Coupons hier.</div>`;
    return;
  }
  const gecacht = ccCache[key];
  if (gecacht) renderCardCoupons(key, brand, gecacht, host);
  else host.innerHTML = `<h3 class="gm-h">Coupons</h3>
    <div class="cc-list">${[0, 1, 2, 3].map(() => '<div class="cc-row-skel"></div>').join('')}</div>`;
  let d;
  try { d = await api('/api/cardcoupons?card=' + encodeURIComponent(key)); }
  catch (e) {
    if (!gecacht) host.innerHTML = `<div class="status">${esc(e.message)}</div>`;
    return;
  }
  ccCache[key] = d;
  try { lsSetzen('ra.ccData', JSON.stringify(ccCache)); } catch { /* Speicher voll */ }
  // Nur neu aufbauen, wenn sich etwas geaendert hat — sonst bleibt die Liste ruhig
  if (!gecacht || JSON.stringify(gecacht) !== JSON.stringify(d)) renderCardCoupons(key, brand, d, host);
}
// Alte Aufrufe: eigenes Blatt nur noch als Umleitung auf das Marken-Blatt
function openCardCoupons(key, brand) { openBrandSheet(key); }

// Der gerade offene Coupon-Satz. Favorisieren aendert nur die betroffenen
// Zeilen, nie die ganze Liste — sonst reisst es einem den Wisch unter der Hand weg.
let ccCtx = null;
function renderCardCoupons(key, brand, d, host) {
  host = host || $('#cc-slot') || $('#sheet-content');
  ccCtx = { key, brand, d, flat: (d.groups || []).flatMap(g => g.items.map(it => ({ ...it, gruppe: g.title }))) };
  const abgelaufen = d.validUntil && new Date(d.validUntil) < new Date(new Date().toDateString());
  host.innerHTML = `
    <h3 class="gm-h" style="margin-top:16px">${icon('tag', 'icon icon-sm')} Coupons der Redaktion</h3>
    ${d.validUntil ? `<div class="cc-valid ${abgelaufen ? 'over' : ''}">${icon('clock', 'icon icon-sm')}
      ${abgelaufen ? 'Abgelaufen seit' : 'Gültig bis'} ${dateShort(d.validUntil)}</div>` : ''}
    <div class="wallet-filters cc-filters" id="cc-filters"></div>
    <div id="cc-body"></div>
    ${d.note ? `<p class="cc-note">${icon('bulb', 'icon icon-sm')} ${esc(d.note)}</p>` : ''}
    ${state.role === 'admin' ? `<button class="btn btn-small btn-ghost" id="cc-edit" style="margin-top:14px">Coupons pflegen</button>` : ''}`;
  $('#cc-edit') && ($('#cc-edit').onclick = () => openCardCouponEditor(key, d));
  ccFilterChips();
  ccBody();
  ccWireSheet();
}

function ccZeile(it) {
  const { key, d } = ccCtx;
  const fav = ccIsFav(key, it.code);
  const bild = it.ean ? `<span class="cc-ean-mini">${ean13Svg(it.code, 34)}</span>`
    : it.barcode
    ? `<img class="cc-img cc-img-code" src="${esc(it.barcode)}" alt="" loading="lazy" decoding="async">`
    : d.img ? `<img class="cc-img" src="${esc(d.img)}/${esc(it.code)}.jpg" alt="" loading="lazy" decoding="async"
        onerror="this.closest('.cc-media')?.classList.add('no-img')">` : '';
  return `
    <div class="cc-wrap" data-cc-wrap="${esc(it.code)}">
      <span class="fav-hint">${icon('star', 'icon')}</span>
      <div class="cc-item ${fav ? 'fav' : ''}" data-cc-item="${esc(it.code)}">
        <span class="cc-media">
          ${bild}
          <span class="cc-code">${esc(it.barcode || it.ean ? 'Barcode zeigen' : it.code)}</span>
        </span>
        <span class="cc-text">
          <b>${esc(it.name)}</b>
          ${it.extra ? `<small>${esc(it.extra)}</small>` : ''}
          ${it.plu ? `<small class="cc-plu">PLU ${esc(it.plu)}</small>` : ''}
        </span>
        <span class="cc-right">
          <span class="cc-price">${esc(it.price)}${/^[\d.,]+$/.test(it.price) ? ' €' : ''}</span>
        </span>
        <button class="cc-fav ${fav ? 'on' : ''}" data-cc-fav="${esc(it.code)}"
          aria-label="${fav ? 'Aus Favoriten entfernen' : 'Zu Favoriten'}"
          aria-pressed="${fav ? 'true' : 'false'}">${icon('star', 'icon')}</button>
      </div>
    </div>`;
}

function ccFavListe() {
  return ccCtx.flat.filter(it => ccIsFav(ccCtx.key, it.code));
}

// Welche Ansicht gilt gerade? Kleine Coupon-Sätze zeigen immer die Flyer-
// Reihenfolge — sie haben ja keine Filterzeile, mit der man zurückschalten könnte.
function ccAnsicht() {
  return ccCtx.flat.length < 5 ? 'gruppen' : ccSort;
}
function ccFilterChips() {
  // Bei einer Handvoll Coupons sieht man ohnehin alles — dann keine Filterzeile
  if (ccCtx.flat.length < 5) { $('#cc-filters').innerHTML = ''; return; }
  const n = ccFavListe().length;
  $('#cc-filters').innerHTML = [
    ['gruppen', 'Flyer-Reihenfolge'],
    ['preisAuf', 'Preis aufsteigend'],
    ['preisAb', 'Preis absteigend'],
    ['favs', `${icon('star', 'icon icon-sm')} Favoriten${n ? ` (${n})` : ''}`],
  ].map(([k, label]) =>
    `<button class="chip ${ccSort === k ? 'active' : ''}" data-ccsort="${k}">${label}</button>`).join('');
}

function ccBody() {
  const { d } = ccCtx;
  const host = $('#cc-body');
  const sicht = ccAnsicht();
  if (sicht === 'preisAuf' || sicht === 'preisAb') {
    const sorted = [...ccCtx.flat].sort((a, b) => {
      const pa = ccPreis(a.price), pb = ccPreis(b.price);
      if (isNaN(pa) && isNaN(pb)) return 0;
      if (isNaN(pa)) return 1;
      if (isNaN(pb)) return -1;
      return sicht === 'preisAuf' ? pa - pb : pb - pa;
    });
    host.innerHTML = `<div class="cc-list">${sorted.map(ccZeile).join('')}</div>`;
  } else if (sicht === 'favs') {
    const favs = ccFavListe();
    host.innerHTML = favs.length
      ? `<div class="cc-list">${favs.map(ccZeile).join('')}</div>`
      : '<div class="status">Noch keine Favoriten. Tippe auf den Stern oder wisch die Zeile nach links.</div>';
  } else {
    host.innerHTML = (d.groups || []).map(g => `
      <h3 class="gm-h">${esc(g.title)}</h3>
      <div class="cc-list">${g.items.map(ccZeile).join('')}</div>`).join('');
  }
}

// Favorisieren verschiebt nichts: der Coupon bleibt an seinem Platz, nur der
// Stern wechselt die Farbe und poppt kurz. Zum Nachschlagen gibt es den Filter.
function ccFavGeaendert(code) {
  const an = ccIsFav(ccCtx.key, code);
  document.querySelectorAll(`#sheet-content [data-cc-wrap="${CSS.escape(code)}"]`).forEach(w => {
    w.querySelector('.cc-item')?.classList.toggle('fav', an);
    const b = w.querySelector('.cc-fav');
    if (!b) return;
    b.classList.toggle('on', an);
    b.setAttribute('aria-pressed', an ? 'true' : 'false');
    b.setAttribute('aria-label', an ? 'Aus Favoriten entfernen' : 'Zu Favoriten');
    b.classList.remove('pop');
    void b.offsetWidth;
    if (an) b.classList.add('pop');
  });
  ccFilterChips();
  // Nur in der Favoriten-Ansicht muss die Liste selbst nachziehen
  if (ccAnsicht() === 'favs') ccBody();
}

// Ein einziger Satz Handler fuer das ganze Blatt — ueberlebt jedes Nachzeichnen.
// Wichtig: Antippen wird hier SELBST erkannt. Sobald der Finger auch nur ein paar
// Pixel wandert, faengt der Browser den Klick ab (Pointer-Capture) — dann kam
// vorher weder die grosse Ansicht noch der Stern durch.
let ccSwipeSperre = 0;
function ccWireSheet() {
  const sheet = $('#sheet-content');
  let wrap = null, card = null, sx = 0, sy = 0, dx = 0, aktiv = false, start = 0;

  const aufraeumen = () => {
    if (card) card.style.transform = '';
    wrap?.classList.remove('dragging');
    document.body.classList.remove('no-select');
    wrap = card = null; aktiv = false; dx = 0;
  };

  sheet.onpointerdown = e => {
    // Chips und Stern sind Knoepfe — die laufen ueber ihren eigenen Klick,
    // sonst reisst der Browser bei der kleinsten Seitwaertsbewegung den
    // Pointer ab (touch-action) und das Antippen verpufft
    if (wrap) aufraeumen();     // falls ein Wisch ohne pointerup verendet ist
    if (e.target.closest('[data-ccsort]') || e.target.closest('.cc-fav')) return;
    const w = e.target.closest('.cc-wrap');
    if (!w) return;
    wrap = w; card = w.querySelector('.cc-item');
    sx = e.clientX; sy = e.clientY; dx = 0; aktiv = false; start = Date.now();
  };
  sheet.onpointermove = e => {
    if (!wrap) return;
    const x = e.clientX - sx, y = e.clientY - sy;
    if (!aktiv) {
      if (Math.abs(y) > 12) { aufraeumen(); return; }   // das war Scrollen
      if (x > -12) return;
      aktiv = true;
      wrap.classList.add('dragging');
      document.body.classList.add('no-select');
      try { sheet.setPointerCapture(e.pointerId); } catch { /* synthetische Pointer */ }
    }
    // Ueber 110 px wird es zaeh — man spuert, dass die Grenze erreicht ist
    const roh = Math.min(0, x);
    dx = roh < -110 ? -110 + (roh + 110) * 0.35 : roh;
    card.style.transform = `translate3d(${dx}px,0,0)`;
  };
  const ende = e => {
    if (!wrap) return;
    const w = wrap, code = w.dataset.ccWrap;
    const kurz = Date.now() - start < 700;
    const stillGehalten = e && Math.abs(e.clientX - sx) < 10 && Math.abs(e.clientY - sy) < 10;
    const gezogen = aktiv;                    // vor dem Aufräumen sichern
    const gewischt = gezogen && dx < -80;
    aufraeumen();
    if (gewischt) {
      ccSwipeSperre = Date.now() + 400;
      ccToggleFav(ccCtx.key, code);
      buzz(14);
      ccFavGeaendert(code);
      return;
    }
    if (gezogen) { ccSwipeSperre = Date.now() + 400; return; }  // Wisch ohne Auslösen
    if (!kurz || !stillGehalten) return;
    // Sauberes Antippen: hier selbst auslösen, der Klick danach wird gesperrt
    ccSwipeSperre = Date.now() + 400;
    ccOeffneGross(code);
  };
  sheet.onpointerup = ende;
  sheet.onpointercancel = () => aufraeumen();

  sheet.onclick = e => {
    const chip = e.target.closest('[data-ccsort]');
    if (chip) {
      ccSort = chip.dataset.ccsort;
      lsSetzen('ra.couponSort', ccSort);
      ccFilterChips(); ccBody();
      const body = $('#cc-body');
      body?.classList.remove('cc-fade');
      void body?.offsetWidth;
      body?.classList.add('cc-fade');
      return;
    }
    // Der Stern ist ein Knopf und laeuft ueber seinen eigenen Klick — zuverlaessig
    // auch dann, wenn der Finger beim Tippen ein wenig wandert
    const stern = e.target.closest('.cc-fav');
    if (stern) {
      ccToggleFav(ccCtx.key, stern.dataset.ccFav);
      buzz(12);
      ccFavGeaendert(stern.dataset.ccFav);
      return;
    }
    // Die Zeile selbst kommt ueber die Pointer-Erkennung; der Klick greift nur
    // bei Tastaturbedienung (dann ist die Wisch-Sperre laengst abgelaufen)
    if (Date.now() < ccSwipeSperre) return;
    const zeile = e.target.closest('[data-cc-item]');
    if (zeile) ccOeffneGross(zeile.dataset.ccItem);
  };
}

function ccOeffneGross(code) {
  const it = ccCtx?.flat.find(x => x.code === code);
  if (it) showCouponBig({ ...it, imgBase: ccCtx.d.img || '' }, ccCtx.d.brand || ccCtx.brand, ccCtx.d.validUntil,
    { key: ccCtx.key, offen: !!ccCtx.d.open });
}
// key: aus welchem Coupon-Satz (dann laesst er sich an Freunde schicken),
// offen: Satz ohne Sparkarte sichtbar (dann darf der Code in den Nachrichtentext)
function showCouponBig(it, brand, validUntil, { key = '', offen = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `<div class="modal cc-big ${it.barcode || it.ean ? 'cc-big-bc' : ''}">
    <div class="ccb-vorne">
    <button class="fav-remove" id="ccb-close" aria-label="Schließen">${icon('x', 'icon icon-sm')}</button>
    <div class="cc-big-brand">${esc(brand)}</div>
    ${it.ean ? `<div class="cc-big-ean">${ean13Svg(it.code, 110)}</div>`
      : it.barcode
      ? `<img class="cc-big-barcode" src="${esc(it.barcode)}" alt="Barcode ${esc(it.code)}">`
      : it.imgBase ? `<img class="cc-big-img" src="${esc(it.imgBase)}/${esc(it.code)}.jpg" alt="" onerror="this.remove()">` : ''}
    ${it.ean ? '' : `<div class="cc-big-code ${it.barcode ? 'small' : ''}">${esc(it.code)}</div>`}
    <div class="cc-big-name">${esc(it.name)}</div>
    ${it.extra ? `<div class="cc-big-extra">${esc(it.extra)}</div>` : ''}
    <div class="cc-big-price">${esc(it.price)}${/^[\d.,]+$/.test(it.price) ? ' €' : ''}</div>
    ${it.plu ? `<div class="cc-big-plu">PLU ${esc(it.plu)}</div>` : ''}
    ${validUntil ? `<div class="cc-big-valid">gültig bis ${dateShort(validUntil)}</div>` : ''}
    ${state.token && couponTeilbar(key, it.code) && !(validUntil && new Date(validUntil) < new Date(new Date().toDateString()))
      ? `<button class="gd-los leise ccb-schicken" type="button">${icon('send', 'icon icon-sm')}An Freund schicken</button>` : ''}
    </div>
  </div>`;
  document.body.appendChild(wrap);
  buzz(12);
  wrap.addEventListener('click', e => {
    if (e.target === wrap || e.target.closest('#ccb-close')) {
      if (wrap.dataset.sendet) return;   // Nachricht ist unterwegs
      wrap.classList.add('closing');
      setTimeout(() => wrap.remove(), 280);
    }
  });
  const schicken = wrap.querySelector('.ccb-schicken');
  if (schicken) schicken.onclick = () => couponSchickenSchritt(wrap, it, brand, key, offen);
}

// ---- Coupon an einen Freund schicken: im grossen Coupon klappt die Auswahl
// auf (wie beim Verschenken: Freund antippen, dann senden). Es geht eine
// Fluesternachricht mit [coupon:<satz>:<code>] raus — im Chat wird daraus
// eine Karte, die beim Freund dieselbe grosse Ansicht oeffnet.
// Nur was sauber ins Kuerzel passt (Satz ohne ":" und "]", Code aus Ziffern/Buchstaben)
function couponTeilbar(key, code) { return /^[^\]:]{1,40}$/.test(String(key || '')) && /^[\w.-]{1,24}$/.test(String(code || '')); }
function couponNachricht(key, it, brand, offen) {
  const preis = String(it.price || '').trim() + (/^[\d.,]+$/.test(String(it.price || '').trim()) ? ' €' : '');
  // Den Code nur mitschreiben, wenn der Satz ohnehin offen ist — sonst kaeme
  // ein Coupon, den es nur mit Sparkarte gibt, frei in den Chat
  const code = offen && !it.ean && !it.barcode ? `Code ${it.code}` : '';
  const text = [`${brand}-Coupon: ${String(it.name || '').slice(0, 80)}`, preis, code].filter(Boolean).join(' · ');
  return `[coupon:${key}:${it.code}] ${text}`.slice(0, 220);
}
function couponSchickenSchritt(wrap, it, brand, key, offen) {
  const modal = wrap.querySelector('.cc-big');
  const vorne = modal.querySelector('.ccb-vorne');
  if (!modal || !vorne || modal.querySelector('.ccs')) return;
  const freunde = myProfile?.friends || [];
  let anWen = '';
  const preis = String(it.price || '').trim() + (/^[\d.,]+$/.test(String(it.price || '').trim()) ? ' €' : '');
  modal.insertAdjacentHTML('beforeend', `
    <div class="ccs" role="group" aria-label="Coupon an einen Freund schicken">
      <div class="ccs-kopf">
        <button class="ccs-zurueck" type="button" aria-label="Zurück zum Coupon">${icon('arrow-back')}</button>
        <b>An wen schicken?</b>
      </div>
      <div class="ccs-coupon" style="--bc:${brandColor(brand)}">
        ${brandChipHtml(brand)}
        <span class="ccs-coupon-text"><small>${esc(brand)} · Coupon</small><b>${esc(it.name)}</b></span>
        ${preis ? `<span class="ccs-coupon-preis">${esc(preis)}</span>` : ''}
      </div>
      ${freunde.length ? `
        <div class="ccs-freunde">${freunde.map(f => `
          <button class="gp-freund" type="button" data-ccs-an="${esc(f)}" aria-pressed="false">
            ${avatarHtml(f, undefined, 'gp-ava')}
            ${nameMitHandleHtml(f, 'gp-name', { at: false })}
            <span class="gp-haken">${icon('check', 'icon icon-sm')}</span>
          </button>`).join('')}</div>
        <p class="ccs-hinweis">Kommt als Nachricht im Chat an.${offen ? '' : ` Sehen kann den Coupon nur, wer die ${esc(brand)}-Karte in der Wallet hat.`}</p>
        <button class="gd-los ccs-senden" type="button" disabled>Freund auswählen</button>`
      : `
        <p class="ccs-hinweis">Schicken geht an Freunde — und du hast noch keine.</p>
        <button class="gd-los" type="button" data-ccs-freunde>Freunde finden</button>`}
    </div>`);
  const schritt = modal.querySelector('.ccs');
  const senden = schritt.querySelector('.ccs-senden');
  const wechsel = (weg, hin, zurueck) => {
    if (reducedMotion() || !hin.animate) { weg.hidden = true; hin.hidden = false; return; }
    const d = zurueck ? -1 : 1;
    weg.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translate3d(${-18 * d}px,0,0)` }],
      { duration: 160, easing: 'cubic-bezier(.4,0,1,1)' }).onfinish = () => {
      weg.hidden = true;
      hin.hidden = false;
      hin.animate([{ opacity: 0, transform: `translate3d(${18 * d}px,0,0)` }, { opacity: 1, transform: 'none' }],
        { duration: 240, easing: 'cubic-bezier(.22,1,.32,1)' });
    };
  };
  schritt.hidden = true;
  wechsel(vorne, schritt, false);
  buzz(8);
  const zurueck = () => {
    if (wrap.dataset.sendet) return;
    wechsel(schritt, vorne, true);
    setTimeout(() => schritt.remove(), reducedMotion() ? 0 : 420);
  };
  schritt.querySelector('.ccs-zurueck').onclick = zurueck;
  schritt.querySelector('[data-ccs-freunde]')?.addEventListener('click', () => {
    wrap.remove();
    closeSheet();
    switchView('friends', 'enter-drop');
  });
  schritt.querySelectorAll('[data-ccs-an]').forEach(b => b.onclick = () => {
    if (wrap.dataset.sendet) return;
    anWen = b.dataset.ccsAn;
    schritt.querySelectorAll('[data-ccs-an]').forEach(x => {
      const an = x === b;
      x.classList.toggle('gewaehlt', an);
      x.setAttribute('aria-pressed', String(an));
    });
    senden.disabled = false;
    knopfAnName(senden, anzeigeName(anWen), 'schicken');
    buzz(8);
  });
  if (senden) senden.onclick = async () => {
    if (!anWen || wrap.dataset.sendet) return;
    wrap.dataset.sendet = '1';
    senden.disabled = true;
    senden.textContent = 'Wird geschickt …';
    try {
      await api('/api/dm/send', { method: 'POST', body: JSON.stringify({ to: anWen, text: couponNachricht(key, it, brand, offen) }) });
    } catch (err) {
      delete wrap.dataset.sendet;
      senden.disabled = false;
      knopfAnName(senden, anzeigeName(anWen), 'schicken');
      island(err.message || 'Hat nicht geklappt');
      return;
    }
    delete wrap.dataset.sendet;
    island(`An ${anzeigeName(anWen)} geschickt`); playSfx('plop'); buzz([10, 30, 14]);
    zurueck();
  };
}
// Im Chat: die Karte zum geteilten Coupon. Der Text hinter dem Kuerzel ist
// "Marke-Coupon: Name · Preis · Code …" (so lesen ihn auch alte Fassungen)
function couponChatHtml(key, code, rest) {
  const teile = String(rest || '').split(' · ');
  const kopf = teile.shift() || '';
  const m = kopf.match(/^(.*?)-Coupon:\s*(.*)$/);
  const marke = (m && m[1]) || key;
  const name = m ? m[2] : kopf;
  const preis = teile.find(t => !/^Code /.test(t)) || '';
  const codeText = (teile.find(t => /^Code /.test(t)) || '').slice(5);
  return `<button class="coupon-chip" type="button" data-open-coupon="${esc(key)}" data-coupon-code="${esc(code)}"
      aria-label="${esc(marke)}-Coupon ansehen: ${esc(name)}">
    ${brandChipHtml(marke)}
    <span class="coupon-chip-text"><small>${esc(marke)} · Coupon</small><b>${esc(name || 'Coupon ansehen')}</b>
      ${preis || codeText ? `<span class="coupon-chip-fuss">${preis ? `<span class="coupon-chip-preis">${esc(preis)}</span>` : ''}${codeText ? `<span class="coupon-chip-code">${esc(codeText)}</span>` : ''}</span>` : ''}
    </span>
    ${icon('arrow-right', 'icon icon-sm')}
  </button>`;
}
// Beim Freund: den Coupon aus seinem Satz holen und gross zeigen. Ohne die
// Sparkarte (bei Saetzen, die eine brauchen) sagt die App das ehrlich.
async function oeffneGeteiltenCoupon(key, code) {
  if (!state.token) { island('Zum Ansehen bitte anmelden'); return; }
  const finde = d => (d?.groups || []).flatMap(g => g.items || []).find(x => x.code === code);
  const zeige = d => showCouponBig({ ...finde(d), imgBase: d.img || '' }, d.brand || key, d.validUntil, { key, offen: !!d.open });
  const gecacht = ccCache[key];
  if (gecacht && finde(gecacht)) { zeige(gecacht); return; }
  let d;
  try {
    d = await api('/api/cardcoupons?card=' + encodeURIComponent(key));
  } catch (e) {
    const marke = cardCouponList?.find(x => x.key === key)?.brand || key;
    island(e.status === 403 ? `Den Coupon siehst du, sobald die ${marke}-Karte in deiner Wallet liegt`
      : e.status === 404 ? 'Diese Coupons gibt es nicht mehr' : (e.message || 'Hat nicht geklappt'));
    return;
  }
  ccCache[key] = d;
  try { lsSetzen('ra.ccData', JSON.stringify(ccCache)); } catch { /* Speicher voll */ }
  if (!finde(d)) { island('Diesen Coupon gibt es nicht mehr — die Liste ist inzwischen neu'); return; }
  zeige(d);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-open-coupon]');
  if (b) oeffneGeteiltenCoupon(b.dataset.openCoupon, b.dataset.couponCode);
});
// Redaktions-Editor: Zeilenformat statt Formular-Wüste, monatlich schnell gepflegt
function openCardCouponEditor(key, data) {
  const txt = (data.groups || []).map(g =>
    `# ${g.title}\n` + g.items.map(it =>
      [it.code, it.name, it.extra, it.price, it.plu, it.barcode].join(' | ').replace(/(\s*\|)+$/, '')).join('\n')
  ).join('\n\n');
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `<div class="modal modal-left cc-editor">
    <h2 class="card-h">Coupons pflegen: ${esc(data.brand || key)}</h2>
    <label class="f-label">Marke</label>
    <input class="input" id="cce-brand" maxlength="40" value="${esc(data.brand || key)}">
    <label class="f-label">Gültig bis</label>
    <input class="input" id="cce-valid" type="date" value="${esc(data.validUntil || '')}">
    <label class="f-label">Hinweis (optional)</label>
    <input class="input" id="cce-note" maxlength="300" value="${esc(data.note || '')}">
    <label class="f-label">Bilder-Ordner (optional, z. B. /coupons/burger-king)</label>
    <input class="input" id="cce-img" maxlength="120" value="${esc(data.img || '')}">
    <label class="check-row" style="margin-top:8px">
      <input type="checkbox" id="cce-open" ${data.open ? 'checked' : ''}>
      <span>Ohne Sparkarte für alle sichtbar (z. B. wenn die Karte wechselnde Codes hat)</span>
    </label>
    <label class="f-label">Coupons</label>
    <p class="muted" style="font-size:.76rem">Eine Zeile je Coupon:
      <b>Nummer | Name | Zusatz | Preis | PLU | Barcodebild</b>. Zeilen mit <b>#</b> sind Überschriften.
      Das Barcodebild ist optional (Pfad wie <code>/coupons/rossmann/10prozent.png</code>) und ersetzt die Nummer.</p>
    <textarea class="input cc-area" id="cce-text" rows="14">${esc(txt)}</textarea>
    <div class="form-row" style="margin-top:10px">
      <button class="btn btn-small" id="cce-save">Speichern</button>
      <button class="btn btn-small btn-ghost" id="cce-cancel">Abbrechen</button>
      <span class="form-msg" id="cce-msg"></span>
    </div>
  </div>`;
  document.body.appendChild(wrap);
  $('#cce-cancel').onclick = () => wrap.remove();
  $('#cce-save').onclick = async () => {
    const groups = [];
    let cur = { title: 'Coupons', items: [] };
    $('#cce-text').value.split('\n').forEach(line => {
      const l = line.trim();
      if (!l) return;
      if (l.startsWith('#')) {
        if (cur.items.length) groups.push(cur);
        cur = { title: l.replace(/^#+\s*/, '').slice(0, 60), items: [] };
        return;
      }
      const [code, name, extra, price, plu, barcode] = l.split('|').map(x => (x || '').trim());
      if (name) cur.items.push({ code, name, extra, price, plu, barcode });
    });
    if (cur.items.length) groups.push(cur);
    try {
      const r = await api('/api/admin/cardcoupons', {
        method: 'POST',
        body: JSON.stringify({
          card: key, brand: $('#cce-brand').value, validUntil: $('#cce-valid').value,
          note: $('#cce-note').value, img: $('#cce-img').value,
          open: $('#cce-open').checked, groups,
        }),
      });
      wrap.remove();
      island(`${r.count} Coupons gespeichert`);
      delete ccCache[key];
      openBrandSheet(key);
    } catch (e) {
      const m = $('#cce-msg'); m.className = 'form-msg error'; m.textContent = e.message;
    }
  };
}
// Der Sprung in eine Händler-App ist immer ein ECHTER Link, nie eine
// programmatische Navigation. Das ist der wichtige Punkt: setzt man
// location.href, wandert das Fenster von kumulio selbst auf die fremde Seite —
// in der Homescreen-App gibt es dann keine Adresszeile und kein Zurück, man
// sitzt fest. Ein angetippter <a>-Link auf eine fremde Domain öffnet dagegen
// entweder die App (Universal Link) oder ein Safari-Fenster mit "Fertig".
//
// Android: intent:// mit dem Paketnamen — startet die App, sonst schickt der
//   Browser selbst auf browser_fallback_url.
// iOS: URL-Schemas (rossmann:// …) dokumentiert keiner dieser Händler, geraten
//   wird nichts. Es bleiben Universal Links, und die greifen nur bei einem
//   echten Klick ohne target="_blank" und nur für die Pfade aus der
//   apple-app-site-association des Händlers (siehe iosUrl im Katalog).
function istHandyIOS() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/i.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
// Wohin die Reise geht — als fertige Link-Angaben, damit es prüfbar bleibt
function appZiel(name) {
  const a = cardApp(name);
  if (!a) return null;
  if (/Android/i.test(navigator.userAgent || '') && a.android) {
    return {
      art: 'intent',
      url: `intent://#Intent;package=${a.android};S.browser_fallback_url=${encodeURIComponent(a.url)};end`,
      neuerTab: false,
    };
  }
  // Handy: gleicher Tab, sonst verschluckt Safari den Universal Link.
  // iOS öffnet fremde Domains aus einer Homescreen-App von sich aus in Safari,
  // mit "Fertig" zum Zurückkommen. Wo gar kein Universal Link existieren kann,
  // sparen wir uns den Versuch und gehen gleich sauber in einen eigenen Tab.
  if (istHandyIOS()) {
    return a.keinUniLink
      ? { art: 'web', url: a.url, neuerTab: true }
      : { art: 'universal', url: a.iosUrl || a.url, neuerTab: false };
  }
  return { art: 'tab', url: a.url, neuerTab: true };
}
// Fertige Attribute für ein <a> — so wird jeder Sprung ein normaler Link
function appLinkAttrs(name) {
  const z = appZiel(name);
  if (!z) return '';
  return `href="${esc(z.url)}" ${z.neuerTab ? 'target="_blank" rel="noopener noreferrer"' : 'rel="noopener"'}`;
}

// Direkt in den App-Store, falls die App gar nicht installiert ist
function appStoreLink(name) {
  const a = cardApp(name);
  if (!a) return '';
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return a.android ? `https://play.google.com/store/apps/details?id=${a.android}` : '';
  const istIOS = /iPad|iPhone|iPod/i.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return istIOS && a.iosId ? `https://apps.apple.com/de/app/id${a.iosId}` : '';
}


// Wochen-Erinnerungen ("Quests") liegen nur auf dem Gerät — es geht ja nur darum,
// dass man das Antippen in der fremden App nicht vergisst.
const appQuests = JSON.parse(localStorage.getItem('ra.appQuests') || '{}');
const WOCHE = 7 * 24 * 3600 * 1000;
function questRest(key) {
  const t = appQuests[String(key).toLowerCase()];
  return t ? Math.max(0, t + WOCHE - Date.now()) : 0;
}
function questErledigt(key) {
  appQuests[String(key).toLowerCase()] = Date.now();
  lsSetzen('ra.appQuests', JSON.stringify(appQuests));
}
function restText(ms) {
  const tage = Math.ceil(ms / (24 * 3600 * 1000));
  if (tage >= 1) return `wieder in ${tage} Tag${tage > 1 ? 'en' : ''}`;
  const std = Math.max(1, Math.round(ms / 3600000));
  return `wieder in ${std} Std.`;
}

// Der Block unter dem Barcode: Sprung in die App, Hinweise, Wochen-Erinnerung.
// Wo der Händler auf dem iPhone gar keinen App-Sprung zulässt, versprechen wir
// keinen — dann steht dort, dass man die App selbst öffnen muss.
function cardAppBlockHtml(name) {
  const a = cardApp(name);
  if (!a) return '';
  const ziel = appZiel(name);
  const nurWeb = ziel && ziel.art === 'web';       // iPhone ohne Universal Link
  const rest = a.woche ? questRest(name) : 0;
  const label = a.rotierend
    ? `${esc(name)}-App öffnen`
    : `Coupons in der ${esc(name)}-App aktivieren`;

  const sprung = nurWeb ? `
    <div class="app-hinweis">
      ${icon('bulb', 'icon icon-sm')}
      <span><b>${esc(name)} lässt sich von hier nicht direkt öffnen.</b>
        ${esc(name)} erlaubt das auf dem iPhone nicht — tipp die ${esc(name)}-App
        auf deinem Startbildschirm an. Der Link hier führt nur auf die Webseite.</span>
    </div>
    <a class="app-store-link" ${appLinkAttrs(name)}>Trotzdem die Webseite öffnen</a>`
  : `
    <a class="app-jump" ${appLinkAttrs(name)} style="--bc:${brandColor(name)}">
      ${brandChipHtml(name)}
      <span class="app-jump-txt"><b>${label}</b>
        <small>${a.rotierend
          ? 'Der Code wechselt ständig — hol ihn dir direkt in der App.'
          : 'Coupons einmal antippen, dann gelten sie an der Kasse.'}</small></span>
      ${icon('arrow-right', 'icon icon-sm')}
    </a>
    ${appStoreLink(name) ? `<a class="app-store-link" href="${esc(appStoreLink(name))}"
      target="_blank" rel="noopener noreferrer">App noch nicht drauf? Hier laden</a>` : ''}`;

  // Die Erinnerung bleibt auch ohne App-Sprung — sie ist ja der eigentliche Sinn.
  // Ohne Sprung wird sie zum reinen Abhaken statt zu einem Link, der nichts hält.
  const quest = !a.woche ? '' : nurWeb ? `
      <button class="app-quest ${rest ? 'done' : ''}" data-quest="${esc(name)}">
        <span class="app-quest-check">${icon(rest ? 'check' : 'clock', 'icon icon-sm')}</span>
        <span class="app-quest-txt"><b>Wöchentlich einloggen</b>
          <small>${rest ? restText(rest) : 'Öffne die ' + esc(name) + '-App und tipp hier auf Erledigt — wir erinnern dich in 7 Tagen wieder.'}</small></span>
      </button>`
  : `
      <a class="app-quest ${rest ? 'done' : ''}" data-quest="${esc(name)}" ${appLinkAttrs(name)}>
        <span class="app-quest-check">${icon(rest ? 'check' : 'clock', 'icon icon-sm')}</span>
        <span class="app-quest-txt"><b>Wöchentlich einloggen</b>
          <small>${rest ? restText(rest) : 'Antippen öffnet die App — wir erinnern dich in 7 Tagen wieder.'}</small></span>
        ${icon('arrow-right', 'icon icon-sm')}
      </a>`;

  return `${sprung}
    ${a.hinweis ? `<p class="cc-note">${icon('bulb', 'icon icon-sm')} ${esc(a.hinweis)}</p>` : ''}
    ${quest}`;
}

// ---- Burger King: die Papiercoupons als PDF. Der Server holt sie taeglich
// (und gleich nach Ablauf) bei einfach-sparsam.de und legt sie ab. Oben im
// Marken-Blatt: bis wann sie gelten, die Seiten als Vorschau, der Knopf zur
// PDF und die Quelle. Abgelaufen oder keine da: ein ehrlicher Satz statt PDF.
let bkDaten = lsJson('ra.bkPdf', null);
let bkLaden = null;
function istBurgerKing(name) { return /^burger\s*king$/i.test(String(name || '').trim()); }
function bkDatum(iso) {
  const d = new Date(String(iso) + 'T12:00:00');
  return isNaN(d) ? '' : `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}
function bkPdfBlockHtml(d = bkDaten) {
  const v = d?.version ? '?v=' + encodeURIComponent(d.version) : '';
  const pdf = `${API_BASE}/bk-coupons.pdf${v}`;
  const symbol = `<span class="bk-pdf-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M7 3.5h7l4 4v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M14 3.5v4h4"/><path d="M9 12.5h6M9 16h4"/></svg></span>`;
  const kopf = zeile => `
    <div class="bk-pdf-kopf">${symbol}
      <span class="bk-pdf-titel"><b>Coupons zum Ausdrucken und Vorzeigen</b><small>${zeile}</small></span>
    </div>`;
  const quelle = `<p class="bk-pdf-quelle">Quelle: <a href="https://www.einfach-sparsam.de/burger-king-coupons-ausdrucken.htm" target="_blank" rel="noopener noreferrer">einfach-sparsam.de</a>${d?.da && !d.abgelaufen && d.groesse ? ` · PDF, ${String(Math.max(0.1, Math.round(d.groesse / 1e5) / 10)).replace('.', ',')} MB` : ''}</p>`;
  if (!d) {
    return `<section class="bk-pdf laedt" aria-label="Burger-King-Coupons zum Ausdrucken" aria-busy="true">
      ${kopf(bkLaden === false ? 'Konnte gerade nicht geladen werden' : 'Wird geladen …')}</section>`;
  }
  if (!d.da || d.abgelaufen) {
    return `<section class="bk-pdf leer" aria-label="Burger-King-Coupons zum Ausdrucken">
      ${kopf(d.da ? `galt bis ${bkDatum(d.gueltigBis)}` : 'gerade keine PDF da')}
      <p class="bk-pdf-hinweis">${d.da
        ? 'Die letzten Papiercoupons gelten nicht mehr. Sobald es neue gibt, stehen sie hier — wir sehen jeden Tag nach.'
        : 'Gerade liegen keine Papiercoupons vor. Wir sehen jeden Tag nach, ob es neue gibt.'}</p>
      ${quelle}</section>`;
  }
  const seiten = (d.seiten || []).slice(0, 4);
  // Die Seiten oeffnen in der App gross (zoombar, mit X) — nie die PDF selbst:
  // in der installierten App (iPhone) oeffnete ein Link auf die PDF sie IN der
  // App, ohne Schliessen-Knopf, und Zurueckwischen lud die App neu (Meldung
  // eines Nutzers). Die PDF gibt es daneben zum Sichern oder Drucken: in der
  // App ueber Teilen, im Browser in einem neuen Tab.
  return `<section class="bk-pdf" aria-label="Burger-King-Coupons zum Ausdrucken">
    ${kopf(d.gueltigBis ? `gültig bis ${bkDatum(d.gueltigBis)}` : 'aktuelle Ausgabe')}
    ${seiten.length ? `
    <div class="bk-pdf-seiten${seiten.length > 1 ? ' mehrere' : ''}">
      ${seiten.map(s => `<button class="bk-pdf-seite" type="button" data-bk-seite aria-label="Seite ${s.n} der Coupons groß ansehen"><img src="${API_BASE}/bk-coupons/seite-${s.n}${v}" width="${s.w}" height="${s.h}" alt=""
        loading="lazy" decoding="async" style="aspect-ratio:${s.w} / ${s.h}"></button>`).join('')}
    </div>
    <button class="gd-los bk-pdf-knopf" type="button" data-bk-gross>Coupons groß ansehen</button>` : ''}
    <p class="bk-pdf-tipp">Nummer an der Kasse nennen oder den QR-Code scannen lassen.</p>
    <p class="bk-pdf-quelle">${isStandalone
      ? `<button class="bk-pdf-teilen" type="button" data-bk-teilen data-pdf="${esc(pdf)}">PDF sichern oder drucken</button>`
      : `<a class="bk-pdf-teilen" href="${esc(pdf)}" target="_blank" rel="noopener">PDF öffnen</a>`}
      · Quelle: <a href="https://www.einfach-sparsam.de/burger-king-coupons-ausdrucken.htm" target="_blank" rel="noopener noreferrer">einfach-sparsam.de</a>${d.groesse ? ` · ${String(Math.max(0.1, Math.round(d.groesse / 1e5) / 10)).replace('.', ',')} MB` : ''}</p>
    </section>`;
}
// Seite gross: der Bildbetrachter der App (zwei Finger zoomen, X schliesst)
document.addEventListener('click', e => {
  const seite = e.target.closest?.('[data-bk-seite]');
  const gross = !seite && e.target.closest?.('[data-bk-gross]');
  if (!seite && !gross) return;
  const img = (seite || gross.closest('.bk-pdf'))?.querySelector('img');
  if (!img) return;
  zeigeBildGross({ vonEl: img, src: img.currentSrc || img.src });
});
// PDF sichern oder drucken (installierte App): ueber das Teilen-Menue des
// Handys. Teilen muss direkt auf den Tipp folgen — ist die PDF noch nicht
// geladen, laedt sie erst, dann reicht ein zweiter Tipp.
let bkPdfDatei = null;
document.addEventListener('click', async e => {
  const k = e.target.closest?.('[data-bk-teilen]');
  if (!k || k.dataset.laedt) return;
  const teilen = async datei => {
    try {
      if (navigator.canShare?.({ files: [datei] })) { await navigator.share({ files: [datei], title: 'Burger-King-Coupons' }); return true; }
    } catch (err) { if (err?.name === 'AbortError') return true; if (err?.name !== 'NotAllowedError') island('Teilen hat nicht geklappt'); return err?.name !== 'NotAllowedError'; }
    island('Dein Gerät kann die PDF hier nicht teilen. Die Coupons kannst du oben groß ansehen.');
    return true;
  };
  if (bkPdfDatei) { teilen(bkPdfDatei); return; }
  k.dataset.laedt = '1';
  const text = k.textContent;
  k.textContent = 'PDF wird geladen …';
  try {
    const r = await fetch(k.dataset.pdf);
    if (!r.ok) throw new Error();
    bkPdfDatei = new File([await r.blob()], 'Burger-King-Coupons.pdf', { type: 'application/pdf' });
    k.textContent = text;
    delete k.dataset.laedt;
    if (!await teilen(bkPdfDatei)) k.textContent = 'PDF bereit: nochmal tippen';
  } catch {
    k.textContent = text;
    delete k.dataset.laedt;
    island('PDF konnte nicht geladen werden');
  }
});

// Metadaten holen (hoechstens einmal pro Minute); true, wenn sich etwas geaendert hat
async function ladeBkPdf() {
  if (bkLaden === true && Date.now() - (ladeBkPdf.zuletzt || 0) < 60e3) return false;
  try {
    const d = await api('/api/bk-coupons');
    const neu = JSON.stringify(d) !== JSON.stringify(bkDaten);
    bkDaten = d;
    bkLaden = true;
    ladeBkPdf.zuletzt = Date.now();
    lsSetzen('ra.bkPdf', JSON.stringify(d));
    return neu;
  } catch {
    bkLaden = false;
    return !bkDaten;   // nur der Lade-Hinweis muss sich aendern
  }
}

// Ein Blatt je Marke: oben die Sparkarte (Nummer und Barcode fuer die Kasse),
// darunter der Sprung in die App, darunter die Coupons dieser Marke. Alles, was
// man beim Einkauf braucht, in einer Reihenfolge.
function openBrandSheet(key, richtung) {
  if (walletGesperrt()) { aktualisiereSperre(); return; } // gesperrte Wallet: nichts zeigen
  const b = walletBrands().find(x => x.key === key);
  if (!b) return;
  // Gemerkt fuer das Auffrischen, wenn darueber eine Karte gespeichert wurde
  openBrandSheet.key = key;
  const c = b.card;
  // Passende Gutscheine: kleinster Rest zuerst, damit man die Reste aufbraucht
  const gutscheine = gutscheineZuMarke(b.name);
  openBrandSheet.stand = markenBlattStand(b);
  state.sheetMode = 'brand';
  $('#sheet-content').innerHTML = `
    <div class="offer-head">
      <span class="brand-chip" style="--bc:${brandColor(b.name)}">${esc(brandInitials(b.name))}</span>
      <div class="offer-brand">
        <div class="offer-merchant">${esc(b.name)}</div>
        <div class="offer-cat">${esc(brandUntertitel(b))}</div>
      </div>
      <button class="fav-remove" id="wc-close" aria-label="Schließen">${icon('x', 'icon icon-sm')}</button>
    </div>
    ${istBurgerKing(b.name) ? `<div id="bk-pdf-slot">${bkPdfBlockHtml()}</div>` : ''}
    ${c ? `
      <div class="karte-buehne" style="margin-top:14px">${sparkarteHtml(c)}</div>
      ${sparkarteHinweis(c) ? `<p class="muted" style="font-size:.76rem; text-align:center; margin-top:8px">${esc(sparkarteHinweis(c))}</p>` : ''}
      ${c.number ? `<div class="tx-row" style="margin-top:10px">
        <span class="wallet-code" style="flex:1">${esc(c.number)}</span>
        <button class="btn btn-small" data-copy-txt="${esc(c.number)}">Kopieren</button>
      </div>` : ''}`
    : cardApp(b.name)?.ohneKarte ? ''
    : `<div class="karte-fehlt">
        ${icon('bulb', 'icon icon-sm')}
        <span>Du hast noch keine ${esc(b.name)}-Sparkarte hinterlegt. Mit Karte hast du sie an der Kasse immer dabei.</span>
      </div>
      <button class="btn btn-block btn-ghost" id="wc-addcard" style="margin-top:8px">
        ${icon('plus', 'icon icon-sm')} ${esc(b.name)}-Karte hinzufügen</button>`}
    ${gutscheine.length ? `
      <h3 class="gm-h" style="margin-top:16px">${icon('tag', 'icon icon-sm')} Damit kannst du hier zahlen</h3>
      <div class="gs-vorschlag">${gutscheine.map(voucherCardHtml).join('')}</div>
      <p class="muted" style="font-size:.74rem; margin-top:6px">Kleinster Rest zuerst — so bleiben keine Cent-Beträge liegen.</p>`
    : ''}
    <div id="wc-app-slot">${cardAppBlockHtml(b.name)}</div>
    ${/mcdonald/i.test(b.name) ? `<div id="mcd-slot">${mccheapBlockHtml()}</div>` : ''}
    <div id="cc-slot"></div>
    ${c ? `<div class="form-row" style="margin-top:18px">
      <button class="btn btn-ghost" id="wc-edit">${icon('sliders', 'icon icon-sm')} Karte ändern</button>
      <button class="btn btn-danger" id="wc-del">Karte löschen</button>
    </div>` : ''}`;

  $('#wc-close').addEventListener('click', closeSheet);
  $('#sheet-content').querySelectorAll('[data-copy-txt]').forEach(x =>
    x.addEventListener('click', () => copyText(x.dataset.copyTxt)));
  $('#wc-addcard')?.addEventListener('click', () => openWalletAdd('card', b.name));
  $('#sheet-content').querySelectorAll('.gs-vorschlag [data-wv]').forEach(x =>
    x.addEventListener('click', () => openVoucherSheet(x.dataset.wv, null, key, 'vor')));

  // Wochen-Erinnerung abhaken (IKEA & Co.): danach laeuft der 7-Tage-Timer
  // Antippen oeffnet die App (der Link laeuft normal weiter) und hakt nebenbei ab
  const wireQuest = () => $('#wc-app-slot').querySelectorAll('[data-quest]').forEach(q => q.onclick = () => {
    if (questRest(q.dataset.quest)) return;
    questErledigt(q.dataset.quest);
    playSfx('coin'); buzz(18);
    island('In 7 Tagen erinnern wir dich wieder');
    // Erst nach dem Sprung neu zeichnen, damit der Link nicht unter dem Finger verschwindet
    setTimeout(() => {
      const slot = $('#wc-app-slot');
      if (!slot || state.sheetMode !== 'brand') return;
      slot.innerHTML = cardAppBlockHtml(b.name);
      slot.querySelector('.app-quest')?.classList.add('app-quest-pop');
      wireQuest();
    }, 600);
  });
  wireQuest();

  if (c) {
    $('#wc-edit').addEventListener('click', () => openWalletAdd('card', c.name, c.id));
    $('#wc-del').addEventListener('click', () => karteLoeschen(c));
  }
  // McCheap erst beim Öffnen holen, danach steht es im Speicher
  if (/mcdonald/i.test(b.name) && !mccheapDaten) ladeMccheap().then(() => {
    const slot = $('#mcd-slot');
    if (slot && state.sheetMode === 'brand') slot.innerHTML = mccheapBlockHtml();
  });
  // Burger King: die Papiercoupons (PDF) oben; aus dem Speicher sofort da,
  // beim Server still nachgefragt
  if (istBurgerKing(b.name)) ladeBkPdf().then(neu => {
    const slot = $('#bk-pdf-slot');
    if (neu && slot && state.sheetMode === 'brand' && openBrandSheet.key === key) slot.innerHTML = bkPdfBlockHtml();
  });
  // Die Coupons dieser Marke direkt darunter — kein zweites Blatt mehr
  if (b.coupons) ladeCouponsIn(b.coupons.key, b.coupons.brand, $('#cc-slot'), !ccBesitzt(b.coupons));
  openSheetShell(richtung);
}
// Was das Marken-Blatt aus der Wallet zeigt: Karte und zahlbare Gutscheine
function markenBlattStand(b) {
  return b ? [b.card ? itemHash(b.card) : '', gutscheineZuMarke(b.name).map(itemHash).join(',')].join('|') : '';
}
// Nach renderWallet: hat sich fuer das offene Marken-Blatt etwas geaendert,
// wird es neu gezeichnet (die Stelle, an der man war, bleibt)
function markenBlattAbgleichen() {
  const key = openBrandSheet.key;
  if (state.sheetMode !== 'brand' || !key || walletGesperrt() || !state.token) return;
  const b = walletBrands().find(x => x.key === key);
  if (!b) { closeSheet(); return; }
  if (markenBlattStand(b) === openBrandSheet.stand) return;
  const inhalt = $('#sheet-content');
  const scroll = inhalt.scrollTop;
  openBrandSheet(key);
  inhalt.scrollTop = scroll;
  // Liegt noch eine Seite darueber, bleibt das Blatt darunter unbedienbar
  if (wseiten().length && !document.body.classList.contains('blatt-ueber-seite')) $('#sheet').inert = true;
}
// Alte Aufrufe (z. B. aus der Wallet-Liste) landen im selben Blatt
function openCardSheet(id) {
  const c = state.wallet.cards.find(x => x.id === id);
  if (c) openBrandSheet(String(c.name).trim().toLowerCase());
}

// Die Gutscheinkarte, wie man sie aus der Wallet kennt — auch das Marken-Blatt
// zeigt genau diese, damit ein Gutschein ueberall gleich aussieht.
// Aufgebrauchte verschwinden 30 Tage nach der letzten Buchung (Server raeumt
// auf, siehe raeumeAufgebrauchteAuf) — die Karte sagt vorher, wann
function entferntAmHtml(v) {
  if (v.balance == null || v.balance > 0 || !state.token || (kontoInfo && kontoInfo.autoAufraeumen === false)) return '';
  let letzte = Math.max(Number(v.added) || 0, Number(v.wiederbelebt) || 0);
  for (const t of v.tx || []) { const ts = Number(t && t.ts) || 0; if (ts > letzte) letzte = ts; }
  // Eingefuehrt am 24.09.2026: Aelteres zaehlt ab diesem Tag (wie am Server)
  const am = Math.max(letzte, Date.parse('2026-09-24T00:00:00Z')) + 30 * 864e5;
  return `<span class="pill pill-verfall">${am <= Date.now() ? 'wird bald entfernt'
    : 'wird am ' + new Date(am).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' entfernt'}</span>`;
}
// Gutschein-Karte (Entwurf des Nutzers): weisses Logo-Feld links, Name,
// "Gutschein", Code und PIN; rechts der Betrag und "…"; unten "Gültig bis".
// Hinten liegt das Marken-Logo gross und blass als Motiv.
function voucherCardHtml(v, { mehr = false } = {}) {
  const pct = v.amount ? Math.max(0, Math.min(100, Math.round(((v.balance || 0) / v.amount) * 100))) : 100;
  const farbe = brandColor(v.vendor);
  const motiv = vkMotivHtml(v);
  const tag = d => d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  // Mittags parsen: "2026-09-23" als UTC-Mitternacht rutschte sonst einen Tag
  const ende = v.end ? new Date(v.end + 'T12:00:00') : null;
  const fuss = ende && !isNaN(ende)
    ? (Date.parse(v.end + 'T23:59:59') < Date.now() ? `abgelaufen am ${tag(ende)}` : `Gültig bis ${tag(ende)}`)
    : v.added ? `hinzugefügt ${tag(new Date(v.added))}` : '';
  return `
    <div class="wallet-card vk has-fill${pct < 18 ? ' fast-leer' : ''}${brandHelligkeit(farbe) > 0.62 ? ' hell' : ''}" data-wv="${esc(v.id)}"
      style="--bc:${farbe}; --tc:${brandTextColor(v.vendor)}; --fill:${pct}%">
      <span class="vk-motiv" aria-hidden="true">${motiv}</span>
      <span class="vk-logo">${brandChipHtml(v.vendor)}</span>
      <div class="vk-text">
        <b class="wallet-card-name">${esc(v.vendor)}</b>
        <span class="vk-art">${v.giftFrom ? `Geschenk von ${esc(anzeigeOderAt(v.giftFrom))}` : 'Gutschein'}</span>
        ${v.pin ? `<span class="vk-pin">PIN ${esc(v.pin)}</span>` : ''}
      </div>
      <div class="vk-rechts">
        ${v.balance != null ? `<span class="wallet-card-balance">${euroFmt(v.balance)}</span>` : ''}
        ${mehr ? `<button class="vk-mehr" type="button" data-wv-mehr="${esc(v.id)}" aria-label="Aktionen für ${esc(v.vendor)}">${icon('mehr', 'icon')}</button>` : ''}
      </div>
      <div class="vk-fuss">${entferntAmHtml(v)}${fuss ? `<span>${fuss}</span>` : ''}</div>
      ${v.giftFrom ? `<span class="gift-corner${v.giftSeen ? '' : ' unopened'}" role="img" aria-label="Geschenk von ${esc(anzeigeOderAt(v.giftFrom))}"><img src="/gamification/gift-tag.svg" alt=""></span>` : ''}
    </div>`;
}
// Maskottchen in der Wallet-Karte. Je Rang kommt ein eigenes Modell,
// Schluessel ist der Rang-Slug aus RANKS; bis eins da ist, traegt der Rang
// das universelle (Daumen hoch). Eintrag = Dateiname ohne Breite, es gibt je
// eine -480.webp und -960.webp. Neue Modelle einfach dazuschreiben, z. B.:
//   scout: '/brand/kumulio-maskottchen-scout',
//   sammler: '/brand/kumulio-maskottchen-sammler',
//   (profi, champion, meister, legende, mythos)
const WALLET_MASKOTTCHEN = {
  standard: { basis: '/brand/kumulio-maskottchen-standard', licht: [.268, .369] },
  // Modelle des Nutzers je Rang. Lage und Groesse stecken im Bild (1389 x 1404,
  // siehe look.css .wk-sprite); licht = Mitte der Strahlen hinter dem Kopf
  scout: { basis: '/brand/kumulio-maskottchen-scout', licht: [0.2836, 0.3775] },
  sammler: { basis: '/brand/kumulio-maskottchen-sammler', licht: [0.2915, 0.3775] },
  profi: { basis: '/brand/kumulio-maskottchen-profi', licht: [0.2959, 0.3775] },
  champion: { basis: '/brand/kumulio-maskottchen-champion', licht: [0.2248, 0.3775] },
  meister: { basis: '/brand/kumulio-maskottchen-meister', licht: [0.353, 0.3775] },
  legende: { basis: '/brand/kumulio-maskottchen-legende', licht: [0.2186, 0.3775] },
  mythos: { basis: '/brand/kumulio-maskottchen-mythos', licht: [0.3117, 0.3775] },
};
function setzeWalletMaskottchen(slug) {
  const img = $('.wk-sprite');
  if (!img) return;
  const e = WALLET_MASKOTTCHEN[slug] || WALLET_MASKOTTCHEN.standard;
  const glas = img.closest('.wk-glas');
  glas?.style.setProperty('--licht-x', e.licht[0]);
  glas?.style.setProperty('--licht-y', e.licht[1]);
  if (img.dataset.basis === e.basis) return;
  img.dataset.basis = e.basis;
  img.srcset = `${e.basis}-480.webp 480w, ${e.basis}-960.webp 960w`;
  img.src = `${e.basis}-480.webp`;
}

// "…" an der Karte: Code/PIN kopieren, Abbuchen, Verschenken, Details — der
// schnelle Weg, ohne erst die Seite zu lesen
function schliesseVkMenue() {
  document.querySelectorAll('.vk-menue:not(.zu)').forEach(m => {
    m.classList.add('zu');
    m.inert = true;
    if (!weich() || !m.animate) return m.remove();
    const a = m.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.94)' }],
      { duration: 140, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
    a.onfinish = () => m.remove();
    setTimeout(() => m.remove(), 300);
  });
}
function oeffneVkMenue(id, knopf) {
  const offen = document.querySelector('.vk-menue:not(.zu)');
  schliesseVkMenue();
  if (offen && offen.dataset.id === id) return;
  const v = state.wallet.vouchers.find(x => x.id === id);
  if (!v || walletGesperrt()) return;
  const rest = v.balance != null && v.balance > 0;
  const eintraege = [
    v.code && ['code', 'Code kopieren', wIcon('kopie', 'icon icon-sm')],
    v.pin && ['pin', 'PIN kopieren', icon('lock', 'icon icon-sm')],
    rest && ['abbuchen', 'Abbuchen', wIcon('minus', 'icon icon-sm')],
    rest && state.token && ['schenken', 'Verschenken', icon('gift', 'icon icon-sm')],
    ['details', 'Details und Verlauf', icon('arrow-right', 'icon icon-sm')],
  ].filter(Boolean);
  const m = document.createElement('div');
  m.className = 'vk-menue';
  m.dataset.id = id;
  m.setAttribute('role', 'menu');
  m.innerHTML = eintraege.map(([k, t, bild]) =>
    `<button class="vk-menue-zeile" type="button" role="menuitem" data-vk="${k}">${bild}<span>${t}</span></button>`).join('');
  document.body.appendChild(m);
  const r = knopf.getBoundingClientRect();
  const h = m.offsetHeight;
  const unten = innerHeight - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--leiste-h')) || 64) - 12;
  m.style.top = (r.bottom + 6 + h > unten ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
  m.style.right = Math.max(8, innerWidth - r.right) + 'px';
  m.querySelectorAll('[data-vk]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    schliesseVkMenue();
    const k = b.dataset.vk;
    if (k === 'code') { copyText(v.code); buzz(10); }
    else if (k === 'pin') { copyText(v.pin); buzz(10); }
    else if (k === 'abbuchen') oeffneGutscheinSeite(v.id, { buchen: -1 });
    else if (k === 'schenken') zeigeSchenkSchritt(v);
    else oeffneGutscheinSeite(v.id);
  });
}
document.addEventListener('pointerdown', e => {
  if (!e.target.closest?.('.vk-menue') && !e.target.closest?.('[data-wv-mehr]')) schliesseVkMenue();
}, { capture: true, passive: true });
addEventListener('scroll', schliesseVkMenue, { passive: true });

// ---------------- Rabattcodes ----------------
// Liegen in der Wallet neben den Gutscheinen (art: 'rabatt'), damit Sichern,
// Abgleich, Papierkorb und Loeschmarker genauso greifen. Sie haben aber KEIN
// Guthaben (amount/balance bleiben null) und zaehlen nirgends mit: nicht im
// Gesamtguthaben, nicht in der Statistik. Verschenken geht wie beim
// Gutschein (Seite "Mehr"), solange der Code nicht eingeloest oder abgelaufen
// ist — beim Freund landet er wieder als Rabattcode.
// Angezeigt werden sie im Bereich "Karten & Coupons", ganz oben.
function rabattZahl(x) { const n = Number(x); return x != null && x !== '' && Number.isFinite(n) && n > 0 ? n : null; }
function rabattWertText(v) {
  const n = rabattZahl(v && v.rabatt);
  if (n == null) return '';
  return esc(v.rabattArt === 'pct' ? `${String(n).replace('.', ',')} %` : euroFmt(n));
}
function rabattMbwText(v) { const n = rabattZahl(v && v.mbw); return n ? `ab ${esc(euroFmt(n))} MBW` : 'ohne MBW'; }
function rabattAbgelaufen(v) { return !!(v && v.end) && Date.parse(v.end + 'T23:59:59') < Date.now(); }
function rabattShopUrl(name) {
  const d = BRAND_DOMAINS[String(name || '').trim().toLowerCase()];
  return d ? `https://www.${d.replace(/^www\./, '')}` : '';
}
// schau: nur ansehen (Verschenken, Auspacken) — ohne Knopf und ohne Sprung
function rabattCardHtml(v, { schau = false } = {}) {
  const aus = !!v.eingeloest || rabattAbgelaufen(v);
  const wert = rabattWertText(v);
  const status = v.eingeloest ? 'eingelöst'
    : v.end ? (rabattAbgelaufen(v) ? 'abgelaufen' : 'bis ' + new Date(v.end).toLocaleDateString('de-DE')) : '';
  return `
    <div class="wallet-card rc-card${aus ? ' rc-aus' : ''}${brandHelligkeit(brandColor(v.vendor)) > 0.62 ? ' hell' : ''}"
      ${schau ? '' : `data-rc="${esc(v.id)}" role="button" tabindex="0" aria-label="${esc(v.vendor)}-Rabattcode öffnen"`}
      style="--bc:${brandColor(v.vendor)}; --tc:${brandTextColor(v.vendor)}">
      <div class="wallet-card-head">
        ${brandChipHtml(v.vendor)}
        ${v.giftFrom ? `<span class="rc-namen"><span class="wallet-card-name">${esc(v.vendor)}</span>
          <span class="rc-von">Geschenk von ${esc(anzeigeOderAt(v.giftFrom))}</span></span>`
          : `<span class="wallet-card-name">${esc(v.vendor)}</span>`}
        ${wert ? `<span class="wallet-card-balance">−${wert}</span>` : ''}
      </div>
      <div class="wallet-card-sub">
        ${v.code ? `<span class="rc-code">${esc(v.code)}</span>` : ''}
        <span class="pill">${rabattMbwText(v)}</span>
        ${status ? `<span class="pill">${status}</span>` : ''}
        ${v.code && !schau ? `<button class="rc-kopieren" type="button" data-rc-copy="${esc(v.id)}" aria-label="Code ${esc(v.code)} kopieren">Kopieren</button>` : ''}
      </div>
    </div>`;
}
function rabattSektionHtml() {
  if (!state.token) return '';
  const alle = state.wallet.vouchers.filter(istRabatt);
  const aktiv = alle.filter(v => !v.eingeloest && !rabattAbgelaufen(v))
    .sort((a, b) => (a.end || '9999').localeCompare(b.end || '9999') || (b.added || 0) - (a.added || 0));
  const aus = alle.filter(v => v.eingeloest || rabattAbgelaufen(v))
    .sort((a, b) => (b.eingeloest || b.added || 0) - (a.eingeloest || a.added || 0));
  return `
    <div class="bereich-zeile rc-kopf">
      <h2 class="bereich-titel" style="margin:0">Deine Rabattcodes</h2>
      ${alle.length ? `<button class="chip rc-neu-chip" type="button" data-wadd="rabatt">${icon('plus', 'icon icon-sm')} Rabattcode</button>` : ''}
    </div>
    <p class="rc-hinweis">Zählen nicht zum Wallet-Guthaben.</p>
    <div class="rc-liste">
      ${aktiv.map(rabattCardHtml).join('')}
      ${!aktiv.length ? `<button class="wallet-card-add" type="button" data-wadd="rabatt">
        <span class="wallet-add-plus small">${icon('plus')}</span>
        <span>Rabattcode hinzufügen, z. B. Lieferando oder Subway</span></button>` : ''}
    </div>
    ${aus.length ? `<details class="rules-fold rc-aus-fold">
      <summary>${icon('list', 'icon icon-sm')} Eingelöst &amp; abgelaufen <span class="stars-count">(${aus.length})</span>
        ${icon('chevron', 'icon icon-sm chev')}</summary>
      <div class="rc-liste rc-liste-aus">${aus.map(rabattCardHtml).join('')}</div>
    </details>` : ''}`;
}
// Karten im Coupons-Bereich verdrahten (nach jedem Neuaufbau)
function rabattKartenVerdrahten(host) {
  host.querySelectorAll('[data-rc]').forEach(el => {
    el.onclick = () => openRabattSheet(el.dataset.rc);
    el.onkeydown = e => {
      if (e.target !== el) return; // Knopf in der Karte (Kopieren) handelt selbst
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRabattSheet(el.dataset.rc); }
    };
  });
  host.querySelectorAll('[data-rc-copy]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const v = state.wallet.vouchers.find(x => x.id === b.dataset.rcCopy);
    if (!v) return;
    copyText(v.code);
    buzz(10);
    b.textContent = 'Kopiert';
    neuStarten(b, 'kopiert');
    setTimeout(() => { b.textContent = 'Kopieren'; b.classList.remove('kopiert'); }, 1400);
  });
}
// Nach dem Speichern: in den Coupons-Bereich und den Code kurz hervorheben
function zeigeRabattcodes(id) {
  if (state.activeView !== 'wallet') switchView('wallet');
  if (walletTab !== 'coupons') document.querySelector('[data-wtab="coupons"]')?.click();
  else renderCoupons();
  setTimeout(() => {
    const el = id && document.querySelector(`#coupons-content [data-rc="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: sperrRuhig() ? 'auto' : 'smooth', block: 'center' });
    if (!sperrRuhig()) neuStarten(el, 'rc-neu');
  }, 380);
}
// ---- Rabattcode als eigene Seite, gebaut wie die Gutschein-Seite: oben die
// Karte mit Rabatt und Mindestbestellwert, darunter der Code zum Kopieren,
// der Sprung in den Shop, Notiz und Bild. Unten fest: eingeloest und
// aendern, unter "Mehr" das Loeschen.
function rpStand(v) { return [itemHash(v), state.token ? 1 : 0].join('|'); }
function openRabattSheet(id) {
  if (walletGesperrt()) { aktualisiereSperre(); return; } // gesperrte Wallet: nichts zeigen
  const v = state.wallet.vouchers.find(x => x.id === id && istRabatt(x));
  if (!v) return;
  // Dieselbe Seite liegt schon oben (Bild getauscht): nur neu zeichnen
  const oben = wseiteOben();
  if (oben && oben.art === 'rabatt' && oben.id === id) { zeichneRabattSeite(oben); return; }
  buzz(8);
  wseiteOeffnen({ art: 'rabatt', id, titel: v.vendor, klasse: 'gd rp', baue: s => zeichneRabattSeite(s) });
}
function rabattSeiteHtml(v) {
  const farbe = brandColor(v.vendor);
  const abgelaufen = rabattAbgelaufen(v);
  const wert = rabattWertText(v);
  const mbw = rabattZahl(v.mbw);
  const tag = ts => new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const status = v.eingeloest ? `eingelöst am ${tag(v.eingeloest)}`
    : v.end ? `${abgelaufen ? 'abgelaufen am' : 'Gültig bis'} ${waTag(v.end)}` : 'ohne Ablaufdatum';
  const shop = rabattShopUrl(v.vendor);
  const bildSrc = v.codeImg || v.img;
  return `
    <div class="gd-karte rp-karte${v.eingeloest || abgelaufen ? ' rp-aus' : ''}${brandHelligkeit(farbe) > 0.62 ? ' hell' : ''}" id="gd-karte"
      style="--bc:${farbe}; --tc:${brandTextColor(v.vendor)}">
      <span class="vk-motiv gd-motiv" aria-hidden="true">${vkMotivHtml(v)}</span>
      <div class="gd-karte-kopf">
        <span class="vk-logo">${brandChipHtml(v.vendor)}</span>
        <span class="gd-karte-namen"><b>${esc(v.vendor)}</b><span>${v.giftFrom ? `Geschenk von ${esc(anzeigeOderAt(v.giftFrom))}` : 'Rabattcode'}</span></span>
      </div>
      <div class="gd-guthaben"><b>${wert ? '−' + wert : 'Rabatt'}</b>
        <span>${mbw ? `ab ${esc(euroFmt(mbw))} Bestellwert` : 'ohne Mindestbestellwert'}</span></div>
      <div class="gd-karte-fuss"><span>${status}</span></div>
    </div>
    ${v.code ? `
    <div class="gd-block gd-codes">
      <div class="gd-code-zeile">
        <span class="gd-code-text"><small>Rabattcode</small><b>${esc(v.code)}</b></span>
        <button class="gd-kopier" type="button" data-copy-txt="${esc(v.code)}" aria-label="Rabattcode kopieren" title="Rabattcode kopieren">${wIcon('kopie')}</button>
      </div>
    </div>` : `
    <button class="gd-block gd-leer" type="button" data-rp="aendern">${wIcon('stift')}<span>Code ergänzen</span></button>`}
    <p class="rp-info">${v.code ? 'Zählt nicht zum Wallet-Guthaben: den Code gibst du beim Bestellen ein.'
      : 'Zählt nicht zum Wallet-Guthaben. Ohne Code gilt der Rabatt meist direkt im Shop oder in der App.'}</p>
    ${shop ? `
    <a class="gd-block gd-zeile" href="${shop}" target="_blank" rel="noopener noreferrer">
      <span class="gd-zeile-plus">${brandChipHtml(v.vendor)}</span>
      <span class="gd-zeile-text"><b>Zu ${esc(v.vendor)}</b><small>${v.code ? 'Code kopieren, dort bestellen und einlösen' : 'Dort bestellen und den Rabatt nutzen'}</small></span>
      ${icon('arrow-right', 'icon gd-pfeil')}
    </a>` : ''}
    ${v.notiz ? `
    <button class="gd-block gd-notiz" type="button" data-rp="aendern" aria-label="Notiz ändern">
      <span class="gd-notiz-kopf">${wIcon('notiz')}<small>Notiz</small>${wIcon('stift', 'icon gd-notiz-stift')}</span>
      <span class="gd-notiz-text">${esc(v.notiz)}</span>
    </button>` : ''}
    ${bildSrc ? `
    <div class="gd-block gd-bild">
      <img class="${v.codeImg ? 'wallet-code-img' : 'wallet-img'}" id="wv-bild" src="${esc(bildSrc)}"
        alt="Bild zum Rabattcode" role="button" tabindex="0" aria-label="Bild vergrößern">
      <div class="gd-bild-knoepfe">
        <label class="gd-bild-knopf">${wIcon('bild')}<span>Tauschen</span>
          <input type="file" id="wv-img-file" accept="image/*" style="display:none"></label>
        <button class="gd-bild-knopf" id="wv-img-crop" type="button">${wIcon('zuschnitt')}<span>Zuschneiden</span></button>
        <button class="gd-bild-knopf gd-bild-lupe" id="wv-img-zoom" type="button" aria-label="Bild vergrößern" title="Vergrößern">${icon('search')}</button>
      </div>
    </div>` : `
    <label class="gd-block gd-leer">${wIcon('bild')}<span>Bild zum Rabattcode hinzufügen</span>
      <input type="file" id="wv-img-file" accept="image/*" style="display:none"></label>`}
    ${v.added ? `<p class="rp-fuss">${v.giftFrom ? `Geschenk von ${esc(anzeigeOderAt(v.giftFrom))}, angekommen am` : 'Hinzugefügt am'} ${tag(v.added)}</p>` : ''}`;
}
// Verschenken geht nur, solange der Code noch etwas wert ist
function rabattVerschenkbar(v) { return !!state.token && istRabatt(v) && !v.eingeloest && !rabattAbgelaufen(v); }
function rpLeisteHtml(v) {
  return `
    <div class="wseite-leiste gd-leiste">
      <div class="gd-knoepfe">
        <button class="gd-knopf gd-ab" type="button" data-rp="eingeloest">${v.eingeloest ? wIcon('rueck') : icon('check')}<span>${v.eingeloest ? 'Wieder aktiv' : 'Eingelöst'}</span></button>
        <button class="gd-knopf gd-auf" type="button" data-rp="aendern">${wIcon('stift')}<span>Ändern</span></button>
      </div>
      <button class="gd-mehr" type="button" aria-expanded="false" aria-controls="gd-optionen">
        <span>Mehr</span>${icon('chevron-down', 'icon gd-mehr-pfeil')}</button>
      <div class="gd-optionen" id="gd-optionen" role="menu" aria-label="Weitere Aktionen">
        ${rabattVerschenkbar(v) ? `
        <button class="gd-option" type="button" role="menuitem" data-rp="schenken" tabindex="-1">
          <span class="gd-option-bild">${icon('gift')}</span>
          <span class="gd-option-text"><b>Verschenken</b><small>An Freunde weitergeben</small></span>
        </button>` : ''}
        <button class="gd-option gefahr" type="button" role="menuitem" data-rp="loeschen" tabindex="-1">
          <span class="gd-option-bild">${wIcon('muell')}</span>
          <span class="gd-option-text"><b>Rabattcode löschen</b></span>
        </button>
      </div>
      <div class="gd-fuss" aria-hidden="true"></div>
    </div>`;
}
function zeichneRabattSeite(seite) {
  const v = state.wallet.vouchers.find(x => x.id === seite.id && istRabatt(x));
  if (!v) return;
  const el = seite.el;
  const inhalt = el.querySelector('.wseite-inhalt');
  const scroll = inhalt.scrollTop;
  seite.stand = rpStand(v);
  el.querySelector('.wseite-titel').textContent = v.vendor;
  el.setAttribute('aria-label', `${v.vendor}-Rabattcode`);
  // Wie die Gutschein-Seite: angleichen statt neu schreiben, Leiste bleibt stehen
  inhaltAngleichen(inhalt, rabattSeiteHtml(v));
  gdLeisteSetzen(seite, rpLeisteHtml(v));
  inhalt.scrollTop = scroll;
  gdLeisteMessen(seite);
  el.querySelectorAll('[data-copy-txt]').forEach(b => b.onclick = () => { copyText(b.dataset.copyTxt); buzz(10); });
  // Bild tauschen / zuschneiden / vergroessern — nur neu gebaute Knoepfe verdrahten
  const bildDatei = el.querySelector('#wv-img-file');
  if (!bildDatei || !bildDatei._verdrahtet) { if (bildDatei) bildDatei._verdrahtet = true; wireVoucherImage(v); }
  el.querySelector('.gd-mehr').onclick = () => gdOptionen(seite);
  el.querySelector('.gd-dimm').onclick = () => gdOptionen(seite, false);
  el.querySelectorAll('[data-rp]').forEach(b => b.onclick = () => {
    const x = state.wallet.vouchers.find(y => y.id === seite.id && istRabatt(y));
    if (!x || walletGesperrt()) return;
    const k = b.dataset.rp;
    if (k === 'aendern') { gdOptionen(seite, false); openWalletAdd('rabatt', x.vendor, x.id); }
    else if (k === 'schenken') { gdOptionen(seite, false); zeigeSchenkSchritt(x); }
    else if (k === 'loeschen') { gdOptionen(seite, false); rabattLoeschen(x); }
    else if (k === 'eingeloest') {
      x.eingeloest = x.eingeloest ? 0 : Date.now();
      zeichneRabattSeite(seite);
      saveWallet();
      buzz(12);
      island(x.eingeloest ? 'Als eingelöst markiert' : 'Wieder aktiv');
    }
  });
}
async function rabattLoeschen(v) {
  if (!await askConfirm(`Den ${esc(v.vendor)}-Rabattcode löschen?`, { okLabel: 'Löschen' }) || walletGesperrt()) return;
  tombstone(v.id);
  state.wallet.vouchers = state.wallet.vouchers.filter(x => x.id !== v.id);
  // Erst die Seite vom Stapel, dann speichern: der Abgleich danach sucht sie nicht mehr
  const oben = wseiteOben();
  if (oben && oben.art === 'rabatt' && oben.id === v.id) wseiteZurueck();
  saveWallet();
  island('Rabattcode gelöscht');
}
// Formularteil fuer Rabattcodes (auf der Seite "Hinzufuegen")
function rabattFormHtml(v) {
  const pct = v?.rabattArt === 'pct';
  const mbw = rabattZahl(v?.mbw);
  return `
      <h3 class="gd-h">Rabatt <small>optional</small></h3>
      <div class="gd-block wa-betrag wa-rabatt" id="wa-betrag">
        <input id="wa-rwert" inputmode="decimal" autocomplete="off" placeholder="0" aria-label="Rabatt"
          value="${v?.rabatt != null ? esc(String(v.rabatt).replace('.', ',')) : ''}">
        <div class="wa-einheit${pct ? ' rechts' : ''}" id="wa-einheit" role="group" aria-label="Rabatt in Euro oder Prozent">
          <span class="wa-einheit-flaeche" aria-hidden="true"></span>
          <button class="wa-einheit-knopf${pct ? '' : ' an'}" type="button" data-einheit="eur" aria-pressed="${!pct}">€</button>
          <button class="wa-einheit-knopf${pct ? ' an' : ''}" type="button" data-einheit="pct" aria-pressed="${pct}">%</button>
        </div>
      </div>
      <h3 class="gd-h">Details <small>optional</small></h3>
      <div class="gd-block wa-gruppe">
        <label class="wa-zeile"><span class="wa-zeile-label">Rabattcode</span>
          <input id="wa-rcode" class="wa-code-feld" maxlength="40" placeholder="Falls es einen gibt"
            autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" value="${esc(v?.code || '')}"></label>
        <div class="wa-zeile wa-zeile-schalter">
          <span class="wa-zeile-text"><span class="wa-zeile-label">Mindestbestellwert</span>
            <span class="wa-zeile-wert" id="wa-mbw-text">${mbw ? 'ab ' + euroFmt(mbw) : 'ohne MBW'}</span></span>
          <label class="switch"><input type="checkbox" id="wa-mbw-an" aria-label="Mindestbestellwert"${mbw ? ' checked' : ''}><span class="switch-slider"></span></label>
        </div>
        <label class="wa-zeile${mbw ? '' : ' hidden'}" id="wa-mbw-feld"><span class="wa-zeile-label">Ab welchem Bestellwert? (€)</span>
          <input id="wa-mbw" inputmode="decimal" autocomplete="off" placeholder="z. B. 15" value="${mbw ? esc(String(mbw).replace('.', ',')) : ''}"></label>
        <label class="wa-zeile"><span class="wa-zeile-label">Gültig bis</span>
          <input id="wa-end" type="date" value="${esc(v?.end || '')}"></label>
        <label class="wa-zeile"><span class="wa-zeile-label">Notiz</span>
          <input id="wa-notiz" maxlength="80" autocomplete="off" placeholder="z. B. nur für Neukunden" value="${esc(v?.notiz || '')}"></label>
      </div>`;
}

// =============================================================================
// Pfand: Pfandbons in der Wallet (art: 'pfand'), eigener Reiter "Pfand".
// Sie liegen bei den Gutscheinen (Sichern, Abgleich, Papierkorb und
// Loeschmarker greifen genauso), haben aber kein Guthaben: der Wert steht in
// amount, balance bleibt null — so zaehlen sie weder zum Wallet-Guthaben noch
// zum Rang (Server: rangStufe). Der Reiter zeigt eine eigene Pfand-Summe.
// Ein Pfandbon gilt nur in der Filiale, in der man ihn bekommen hat: die
// steht deshalb auf jeder Karte und oben auf seiner Seite.
//   { id, art: 'pfand', vendor (Kette), amount, balance: null, code, codeFormat,
//     bonNr, bonDatum ('JJJJ-MM-TT'), filiale: { name, strasse, plz, ort, lat,
//     lng, genau }, eingeloest (Zeitstempel oder 0), img, codeImg, added, mt }
// =============================================================================
function pfandFiliale(v) { return v && v.filiale && typeof v.filiale === 'object' ? v.filiale : {}; }
function pfandHatStandort(f) { return Number.isFinite(Number(f?.lat)) && Number.isFinite(Number(f?.lng)) && f.lat !== '' && f.lat != null && f.lng != null; }
function pfandHatFiliale(v) {
  const f = pfandFiliale(v);
  return !!(f.strasse || f.ort || f.plz || pfandHatStandort(f));
}
// "EDEKA Prandzioch" und "Harleshäuserstr. 64, 34130 Kassel"
function pfandFilialName(v) { return [v.vendor, pfandFiliale(v).name].filter(Boolean).join(' '); }
function pfandAnschrift(v, { kurz = false } = {}) {
  const f = pfandFiliale(v);
  const ort = kurz ? f.ort : [f.plz, f.ort].filter(Boolean).join(' ');
  return [f.strasse, ort].filter(Boolean).join(', ');
}
function pfandSumme(liste) { return Math.round(liste.reduce((s, v) => s + (Number(v.amount) || 0), 0) * 100) / 100; }
function pfandTag(ts) { return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
// Karten-Link: Koordinaten, sonst die Anschrift. Nur ein Link — geoeffnet
// wird er erst, wenn man ihn antippt (kein Dienst wird von hier aus gefragt)
function pfandKartenUrl(v) {
  const f = pfandFiliale(v);
  const ziel = pfandHatStandort(f) ? `${f.lat},${f.lng}` : [pfandFilialName(v), f.strasse, f.plz, f.ort].filter(Boolean).join(', ');
  if (!pfandHatStandort(f) && !(f.strasse && (f.ort || f.plz))) return '';
  return /iPhone|iPad|Mac/.test(navigator.platform || '') ? `https://maps.apple.com/?q=${encodeURIComponent(ziel)}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ziel)}`;
}

// Pfand-Karte in der Liste: wie eine Gutschein-Karte, darunter die Filiale
function pfandKarteHtml(v, { vorschau = false } = {}) {
  const leer = !v.vendor;
  const farbe = leer ? WA_LEER_FARBE : brandColor(v.vendor);
  const aus = !!v.eingeloest;
  const anschrift = pfandAnschrift(v, { kurz: true });
  const f = pfandFiliale(v);
  const zweite = anschrift || (pfandHatStandort(f) ? 'Standort gespeichert' : '');
  // Eingeloest: das Einloese-Datum unten rechts (wie "Bon vom"), links bleibt
  // "Pfandbon" — oben neben dem Betrag brach "eingeloest am …" in zwei Zeilen
  const fuss = aus ? `eingelöst am ${pfandTag(v.eingeloest)}`
    : v.bonDatum ? `Bon vom ${waTag(v.bonDatum)}` : v.added ? `hinzugefügt ${pfandTag(v.added)}` : '';
  // Eingeloest ohne Filiale: kein "fehlt" mehr — da gibt es nichts zu ergaenzen
  const filiale = leer ? '' : zweite || f.name
    ? `<b>Nur bei ${esc(pfandFilialName(v))}</b>${zweite ? `<span>${esc(zweite)}</span>` : ''}`
    : aus ? '' : `<b>Filiale fehlt</b><span>${vorschau ? 'Unten eintragen' : 'Antippen und ergänzen'}</span>`;
  return `
    <div class="wallet-card vk pk${aus ? ' pk-aus' : ''}${leer ? ' wa-leer' : brandHelligkeit(farbe) > 0.62 ? ' hell' : ''}"
      ${vorschau ? '' : `data-pf="${esc(v.id)}" role="button" tabindex="0" aria-label="${esc(v.vendor)}-Pfandbon über ${euroFmt(v.amount ?? 0)} öffnen"`}
      style="--bc:${farbe}; --tc:${leer ? '#fff' : brandTextColor(v.vendor)}">
      <span class="vk-motiv" aria-hidden="true">${leer ? '' : vkMotivHtml(v)}</span>
      <span class="vk-logo">${leer ? waLeerChip() : brandChipHtml(v.vendor)}</span>
      <div class="vk-text">
        <b class="wallet-card-name${leer ? ' wa-platzhalter' : ''}">${esc(v.vendor || 'Laden')}</b>
        <span class="vk-art">Pfandbon</span>
      </div>
      <div class="vk-rechts"><span class="wallet-card-balance${v.amount == null ? ' wa-platzhalter' : ''}">${euroFmt(v.amount ?? 0)}</span></div>
      <div class="vk-fuss">${fuss ? `<span>${esc(fuss)}</span>` : ''}</div>
      ${filiale ? `<div class="pk-filiale">${wIcon('ort')}<span class="pk-filiale-text">${filiale}</span></div>` : ''}
    </div>`;
}

// ---- Reiter "Pfand": Summe und Scannen oben, darunter die offenen Bons,
// eingeloeste zugeklappt am Ende. Ohne Bons: kurze Erklaerung und Scannen.
function renderPfand(host) {
  host = host || $('#pfand-content');
  if (!host || !state.token) return;
  const alle = state.wallet.vouchers.filter(istPfand);
  const offen = alle.filter(v => !v.eingeloest).sort((a, b) => (b.added || 0) - (a.added || 0));
  const aus = alle.filter(v => v.eingeloest).sort((a, b) => (b.eingeloest || 0) - (a.eingeloest || 0));
  const summe = pfandSumme(offen);
  const kamera = `
    <label class="gd-los pf-scannen">${wIcon('kamera')}<span>Pfandbon scannen</span>
      <input type="file" accept="image/*" capture="environment" data-pf-kamera hidden></label>`;
  const aufraeumen = kontoInfo && kontoInfo.autoAufraeumen === false
    ? 'Eingelöste bleiben, bis du sie löschst.'
    : 'Eingelöste verschwinden 30 Tage nach dem Einlösen von selbst.';
  const bau = !alle.length ? `
    <div class="pf-leer">
      <span class="pf-leer-bild" aria-hidden="true">${pfandBildSvg()}</span>
      <h2>Noch kein Pfand</h2>
      <p>Fotografier den Bon vom Leergutautomaten. kumulio liest Betrag, Laden und Code und merkt sich, in welcher Filiale er gilt.</p>
      ${kamera}
      <button class="pf-leer-link" type="button" data-pf-neu>Ohne Foto eintragen</button>
    </div>` : `
    <div class="bereich-zeile rc-kopf pf-kopf">
      <h2 class="bereich-titel" style="margin:0">Dein Pfand</h2>
      <button class="chip rc-neu-chip" type="button" data-pf-neu>${icon('plus', 'icon icon-sm')} Pfandbon</button>
    </div>
    <div class="gd-block pf-summe">
      <div class="pf-summe-zeile">
        <span class="pf-summe-bild" aria-hidden="true">${wIcon('flasche')}</span>
        <span class="pf-summe-text"><b>${euroFmt(summe)}</b>
          <small>${offen.length ? `in ${offen.length === 1 ? 'einem Bon' : `${offen.length} Bons`} · zählt nicht zum Wallet-Guthaben` : 'Alles eingelöst'}</small></span>
      </div>
      ${kamera}
    </div>
    <div class="pf-liste">${offen.map(v => pfandKarteHtml(v)).join('')
      || '<div class="status">Gerade kein offener Pfandbon.</div>'}</div>
    ${aus.length ? `<details class="rules-fold pf-aus-fold"${renderPfand.ausOffen ? ' open' : ''}>
      <summary>${icon('list', 'icon icon-sm')} Eingelöst <span class="stars-count">(${aus.length})</span>
        ${icon('chevron', 'icon icon-sm chev')}</summary>
      <p class="used-hinweis">${aufraeumen}</p>
      <div class="pf-liste pf-liste-aus">${aus.map(v => pfandKarteHtml(v)).join('')}</div>
    </details>` : ''}`;
  if (renderPfand.letzterBau === bau && host.firstElementChild) return;
  // Neu gebaut wird nur, wenn sich etwas geaendert hat (Abgleich, Einloesen)
  host.innerHTML = bau;
  renderPfand.letzterBau = bau;
  host.querySelectorAll('[data-pf]').forEach(el => {
    el.onclick = () => oeffnePfandSeite(el.dataset.pf);
    el.onkeydown = e => { if (e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); oeffnePfandSeite(el.dataset.pf); } };
  });
  host.querySelectorAll('[data-pf-neu]').forEach(b => b.onclick = () => openWalletAdd('pfand'));
  host.querySelectorAll('[data-pf-kamera]').forEach(inp => inp.onchange = e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) openWalletAdd('pfand', '', '', { datei: f });
  });
  const fold = host.querySelector('.pf-aus-fold');
  if (fold) fold.ontoggle = () => { renderPfand.ausOffen = fold.open; };
}
// Leerer Reiter: ein Bon mit Barcode und eine Flasche, in Akzentfarbe
function pfandBildSvg() {
  return `<svg viewBox="0 0 120 120" aria-hidden="true">
    <rect x="22" y="18" width="52" height="80" rx="7" class="pf-bon"/>
    <path d="M22 88v6a7 7 0 0 0 7 7h38a7 7 0 0 0 7-7v-6" class="pf-bon-fuss"/>
    <path d="M31 32h26M31 40h18" class="pf-linie"/>
    <path d="M31 56v18M35 56v18M38 56v18M43 56v18M46 56v18M50 56v18M55 56v18M58 56v18M62 56v18M65 56v18" class="pf-strich"/>
    <path d="M86 42h10v8c0 3 6 6 6 13v36a5 5 0 0 1-5 5H85a5 5 0 0 1-5-5V63c0-7 6-10 6-13z" class="pf-flasche"/>
    <path d="M85 36h12" class="pf-deckel"/>
    <path d="M80 76h22" class="pf-etikett"/>
  </svg>`;
}
// Nach dem Speichern: in den Pfand-Reiter und den Bon kurz hervorheben
function zeigePfand(id) {
  if (state.activeView !== 'wallet') switchView('wallet');
  if (walletTab !== 'pfand') document.querySelector('[data-wtab="pfand"]')?.click();
  else renderPfand();
  setTimeout(() => {
    const el = id && document.querySelector(`#pfand-content [data-pf="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: sperrRuhig() ? 'auto' : 'smooth', block: 'center' });
    if (!sperrRuhig()) neuStarten(el, 'rc-neu');
  }, 380);
}

// ---- Pfandbon als eigene Seite: Karte mit Betrag, darunter gross die
// Filiale (nur dort einloesbar), der Code fuer die Kasse und die Angaben vom
// Bon. Unten fest: eingeloest und aendern, unter "Mehr" das Loeschen.
function pdStand(v) { return [itemHash(v), state.token ? 1 : 0].join('|'); }
function oeffnePfandSeite(id) {
  if (walletGesperrt()) { aktualisiereSperre(); return; }
  const v = state.wallet.vouchers.find(x => x.id === id && istPfand(x));
  if (!v) return;
  const oben = wseiteOben();
  if (oben && oben.art === 'pfand' && oben.id === id) { zeichnePfandSeite(oben); return; }
  buzz(8);
  wseiteOeffnen({ art: 'pfand', id, titel: v.vendor || 'Pfandbon', klasse: 'gd rp pd', baue: s => zeichnePfandSeite(s) });
}
function pfandSeiteHtml(v) {
  const farbe = brandColor(v.vendor);
  const f = pfandFiliale(v);
  const status = v.eingeloest ? `eingelöst am ${pfandTag(v.eingeloest)}`
    : v.bonDatum ? `Bon vom ${waTag(v.bonDatum)}` : v.added ? `hinzugefügt am ${pfandTag(v.added)}` : '';
  const ortZeile = [f.plz, f.ort].filter(Boolean).join(' ');
  const karten = pfandKartenUrl(v);
  const bildSrc = v.codeImg || v.img;
  const zeile = (label, wert) => `<div class="pd-zeile"><small>${label}</small><b>${esc(wert)}</b></div>`;
  const angaben = [v.bonNr && zeile('Bon-Nr.', v.bonNr), v.bonDatum && zeile('Datum vom Bon', waTag(v.bonDatum))].filter(Boolean).join('');
  return `
    <div class="gd-karte rp-karte pd-karte${v.eingeloest ? ' rp-aus' : ''}${brandHelligkeit(farbe) > 0.62 ? ' hell' : ''}" id="gd-karte"
      style="--bc:${farbe}; --tc:${brandTextColor(v.vendor)}">
      <span class="vk-motiv gd-motiv" aria-hidden="true">${vkMotivHtml(v)}</span>
      <div class="gd-karte-kopf">
        <span class="vk-logo">${brandChipHtml(v.vendor)}</span>
        <span class="gd-karte-namen"><b>${esc(v.vendor)}</b><span>Pfandbon</span></span>
      </div>
      <div class="gd-guthaben"><b>${v.amount != null ? euroFmt(v.amount) : 'Betrag fehlt'}</b></div>
      <div class="gd-karte-fuss"><span>${esc(status)}</span></div>
    </div>
    ${pfandHatFiliale(v) || f.name ? `
    <div class="gd-block pd-filiale">
      <span class="pd-filiale-bild">${wIcon('ort')}</span>
      <span class="pd-filiale-text">
        <b>${esc(pfandFilialName(v))}</b>
        ${f.strasse ? `<span>${esc(f.strasse)}</span>` : ''}
        ${ortZeile ? `<span>${esc(ortZeile)}</span>` : ''}
        ${pfandHatStandort(f) ? `<span class="pd-standort" id="pd-standort">Standort gespeichert</span>` : ''}
        <small>Nur in dieser Filiale einlösbar</small>
      </span>
    </div>
    ${karten ? `
    <a class="gd-block gd-zeile pd-karten" href="${esc(karten)}" target="_blank" rel="noopener noreferrer">
      <span class="gd-zeile-plus pd-karten-bild">${icon('arrow-out', 'icon')}</span>
      <span class="gd-zeile-text"><b>In Karten öffnen</b><small>Weg zur Filiale</small></span>
      ${icon('chevron', 'icon gd-pfeil')}
    </a>` : ''}` : `
    <button class="gd-block gd-leer pd-leer-filiale" type="button" data-pd="aendern">${wIcon('ort')}<span>Filiale ergänzen</span></button>`}
    ${bildSrc ? `
    <div class="gd-block gd-bild pd-bild">
      <img class="${v.codeImg ? 'wallet-code-img' : 'wallet-img'}" id="pd-code" src="${esc(bildSrc)}"
        alt="Code für die Kasse" role="button" tabindex="0" aria-label="Code groß zeigen">
      <div class="gd-bild-knoepfe">
        <label class="gd-bild-knopf">${wIcon('bild')}<span>Tauschen</span>
          <input type="file" id="wv-img-file" accept="image/*" style="display:none"></label>
        <button class="gd-bild-knopf" id="wv-img-crop" type="button">${wIcon('zuschnitt')}<span>Zuschneiden</span></button>
        <button class="gd-bild-knopf gd-bild-lupe" id="pd-gross" type="button" aria-label="Code groß zeigen" title="Groß zeigen">${icon('search')}</button>
      </div>
    </div>` : `
    <label class="gd-block gd-leer">${wIcon('bild')}<span>Bild vom Code hinzufügen</span>
      <input type="file" id="wv-img-file" accept="image/*" style="display:none"></label>`}
    ${v.code ? `
    <div class="gd-block gd-codes">
      <div class="gd-code-zeile">
        <span class="gd-code-text"><small>Code</small><b>${esc(v.code)}</b></span>
        <button class="gd-kopier" type="button" data-copy-txt="${esc(v.code)}" aria-label="Code kopieren" title="Code kopieren">${wIcon('kopie')}</button>
      </div>
    </div>` : ''}
    ${angaben ? `<div class="gd-block pd-angaben">${angaben}</div>` : ''}
    <p class="rp-info">Zählt nicht zum Wallet-Guthaben. An der Kasse den Code zeigen oder den Bon abgeben.</p>
    ${v.added ? `<p class="rp-fuss">Hinzugefügt am ${pfandTag(v.added)}</p>` : ''}`;
}
function pdLeisteHtml(v) {
  return `
    <div class="wseite-leiste gd-leiste">
      <div class="gd-knoepfe">
        <button class="gd-knopf ${v.eingeloest ? 'pd-leise' : 'gd-auf'}" type="button" data-pd="eingeloest">${v.eingeloest ? wIcon('rueck') : icon('check')}<span>${v.eingeloest ? 'Wieder offen' : 'Eingelöst'}</span></button>
        <button class="gd-knopf pd-aendern" type="button" data-pd="aendern">${wIcon('stift')}<span>Ändern</span></button>
      </div>
      <button class="gd-mehr" type="button" aria-expanded="false" aria-controls="gd-optionen">
        <span>Mehr</span>${icon('chevron-down', 'icon gd-mehr-pfeil')}</button>
      <div class="gd-optionen" id="gd-optionen" role="menu" aria-label="Weitere Aktionen">
        <button class="gd-option gefahr" type="button" role="menuitem" data-pd="loeschen" tabindex="-1">
          <span class="gd-option-bild">${wIcon('muell')}</span>
          <span class="gd-option-text"><b>Pfandbon löschen</b></span>
        </button>
      </div>
      <div class="gd-fuss" aria-hidden="true"></div>
    </div>`;
}
function zeichnePfandSeite(seite) {
  const v = state.wallet.vouchers.find(x => x.id === seite.id && istPfand(x));
  if (!v) return;
  const el = seite.el;
  const inhalt = el.querySelector('.wseite-inhalt');
  const scroll = inhalt.scrollTop;
  seite.stand = pdStand(v);
  el.querySelector('.wseite-titel').textContent = v.vendor || 'Pfandbon';
  el.setAttribute('aria-label', `${v.vendor}-Pfandbon`);
  inhaltAngleichen(inhalt, pfandSeiteHtml(v));
  gdLeisteSetzen(seite, pdLeisteHtml(v));
  inhalt.scrollTop = scroll;
  gdLeisteMessen(seite);
  el.querySelectorAll('[data-copy-txt]').forEach(b => b.onclick = () => { copyText(b.dataset.copyTxt); buzz(10); });
  // Der Code gross fuer die Kasse (wie bei den Sparkarten)
  const gross = () => {
    const x = state.wallet.vouchers.find(y => y.id === seite.id);
    const bild = el.querySelector('#pd-code');
    if (x && bild) zeigeCodeGross({ name: x.vendor, codeImg: x.codeImg || x.img, number: x.code }, bild);
  };
  const bild = el.querySelector('#pd-code');
  if (bild) {
    bild.onclick = gross;
    bild.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); gross(); } };
  }
  const lupe = el.querySelector('#pd-gross');
  if (lupe) lupe.onclick = gross;
  // Bild tauschen und zuschneiden wie beim Gutschein — nur neu gebaute Knoepfe verdrahten
  const bildDatei = el.querySelector('#wv-img-file');
  if (!bildDatei || !bildDatei._verdrahtet) { if (bildDatei) bildDatei._verdrahtet = true; wireVoucherImage(v); }
  el.querySelector('.gd-mehr').onclick = () => gdOptionen(seite);
  el.querySelector('.gd-dimm').onclick = () => gdOptionen(seite, false);
  el.querySelectorAll('[data-pd]').forEach(b => b.onclick = () => {
    const x = state.wallet.vouchers.find(y => y.id === seite.id && istPfand(y));
    if (!x || walletGesperrt()) return;
    const k = b.dataset.pd;
    if (k === 'aendern') { gdOptionen(seite, false); openWalletAdd('pfand', x.vendor, x.id); }
    else if (k === 'loeschen') { gdOptionen(seite, false); pfandLoeschen(x); }
    else if (k === 'eingeloest') pfandEinloesen(x, !x.eingeloest);
  });
  pfandEntfernung(seite, v);
}
// Eingeloest (oder wieder offen). Rueckgaengig geht hier und in der Meldung.
function pfandEinloesen(x, an) {
  x.eingeloest = an ? Date.now() : 0;
  x.mt = Date.now();
  saveWallet();
  buzz(12);
  const oben = wseiteOben();
  if (oben && oben.art === 'pfand' && oben.id === x.id) zeichnePfandSeite(oben);
  if (an) {
    playSfx('coin');
    showToast({
      title: 'Als eingelöst markiert',
      text: `${x.vendor}-Pfandbon über ${euroFmt(x.amount ?? 0)}`,
      iconName: 'check',
      actions: [{ label: 'Rückgängig', ghost: true, fn: () => {
        const y = state.wallet.vouchers.find(z => z.id === x.id && istPfand(z));
        if (y && y.eingeloest && !walletGesperrt()) pfandEinloesen(y, false);
      } }],
    }, 6000);
  } else island('Wieder offen');
}
async function pfandLoeschen(v) {
  if (!await askConfirm(`Den ${esc(v.vendor)}-Pfandbon über ${esc(euroFmt(v.amount ?? 0))} löschen?`, { okLabel: 'Löschen' }) || walletGesperrt()) return;
  tombstone(v.id);
  origEntfernen(v);
  state.wallet.vouchers = state.wallet.vouchers.filter(x => x.id !== v.id);
  const oben = wseiteOben();
  if (oben && oben.art === 'pfand' && oben.id === v.id) wseiteZurueck();
  saveWallet();
  island('Pfandbon gelöscht');
}
// "ca. 350 m von dir": nur, wenn der Standort schon freigegeben ist — hier
// wird nie gefragt. Luftlinie aus den gespeicherten Koordinaten, kein Dienst.
async function pfandEntfernung(seite, v) {
  const f = pfandFiliale(v);
  if (!pfandHatStandort(f) || !navigator.geolocation || !navigator.permissions) return;
  try {
    const p = await navigator.permissions.query({ name: 'geolocation' });
    if (p.state !== 'granted') return;
  } catch { return; }
  navigator.geolocation.getCurrentPosition(pos => {
    const ziel = seite.el.querySelector('#pd-standort');
    if (!ziel || wseiteOben() !== seite) return;
    const m = pfandMeter(pos.coords.latitude, pos.coords.longitude, Number(f.lat), Number(f.lng));
    ziel.textContent = m < 150 ? 'Du bist gerade dort' : `ca. ${m < 1000 ? Math.round(m / 10) * 10 + ' m' : String(Math.round(m / 100) / 10).replace('.', ',') + ' km'} von dir`;
  }, () => { }, { maximumAge: 300000, timeout: 6000 });
}
function pfandMeter(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180, R = 6371000;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lng2 - lng1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---- Pfandbon hinzufuegen oder aendern: dieselbe Seite wie Gutschein und
// Rabattcode (Umschalter oben). Foto → pfandScannen → Felder vorbelegt,
// Unsicheres gelb markiert ("bitte pruefen"). Nichts wird erfunden: was nicht
// sicher gelesen wurde, bleibt leer. Gespeichert wird erst mit "Speichern".
function openPfandAdd(prefillName = '', bearbeiteId = '', opts = {}) {
  if (!state.token) { switchView('profile'); island('Für die Wallet bitte anmelden'); return; }
  if (walletGesperrt()) { aktualisiereSperre(); return; }
  waSaving = false;
  addType = 'pfand';
  addPrefill = prefillName || '';
  addEditId = bearbeiteId || '';
  const bearbeitet = addEditId ? state.wallet.vouchers.find(x => x.id === addEditId && istPfand(x)) : null;
  if (!bearbeitet) addEditId = '';
  waScanLauf++;
  addImg = bearbeitet?.img || '';
  addOrig = '';
  waAutoWerte = {};
  addCodeImg = bearbeitet?.codeImg || '';
  const titel = addEditId ? 'Pfandbon ändern' : 'Pfandbon hinzufügen';
  const geholt = waSeiteHolen(titel, opts);
  if (!geholt) return;
  const { seite, neuGefuellt } = geholt;
  const el = seite.el;
  const inhalt = el.querySelector('.wseite-inhalt');
  const q = sel => el.querySelector(sel);
  const platz = walletPlatz('gutscheine');
  const voll = !addEditId && platz.voll;
  const platzText = platz.voll ? walletVollText('gutscheine')
    : `${platz.n}${platz.g ? ` + ${platz.g} wartende Geschenke` : ''} von maximal ${platz.max} Gutscheinen, Rabattcodes und Pfandbons in deiner Wallet, noch ${platz.frei} frei.`;
  const f0 = bearbeitet ? pfandFiliale(bearbeitet) : {};
  const shopListe = waShopListe('pfand');
  let maus = false;
  try { maus = matchMedia('(hover: hover) and (pointer: fine)').matches; } catch { /* alt */ }
  const einfuegen = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘+V' : 'Strg+V';
  const mehrInhalt = `<span class="wa-shop-mehr-bild">${icon('search', 'icon')}</span><span class="wa-shop-name">Weitere</span>`;
  const alterSchalter = opts.richtung ? q('#wa-modus') : null;
  const wert = x => esc(x == null ? '' : String(x));
  inhalt.innerHTML = `
    ${!addEditId ? waSchalterHtml(opts.von || 'pfand', 'pfand') : ''}
    ${!addEditId && (platz.voll || platz.fast) ? `
    <div class="wa-hinweis ${platz.voll ? 'voll' : 'fast'}">${icon('warning', 'icon')}<span>${esc(platzText)}</span></div>` : ''}
    <div class="wa-form${opts.von && !opts.richtung ? ' wa-form-neu' : ''}">
      <div class="wa-vorschau" id="wa-vorschau" aria-hidden="true"></div>

      <section class="gd-block wa-scan" id="wa-drop" aria-label="Foto vom Pfandbon">
        <div class="wa-scan-kopf">
          <span class="wa-scan-symbol">${wIcon('scan')}</span>
          <span class="wa-scan-text"><b>Foto vom Pfandbon</b>
            <small>Betrag, Code, Laden und Filiale liest kumulio selbst aus.</small></span>
        </div>
        <div class="wa-scan-bild hidden" id="wa-scan-frame">
          <img id="wa-preview" alt="Dein Bild">
          <div class="scan-line hidden" id="wa-scanline"></div>
        </div>
        <div class="scan-progress hidden" id="wa-progress">
          <div class="scan-progress-track"><div class="scan-progress-fill" id="wa-progress-fill"></div></div>
          <span id="wa-progress-txt">0 %</span>
        </div>
        <p id="wa-ai-msg" class="form-msg wa-scan-meldung" role="status"></p>
        <div class="wa-scan-knoepfe">
          <label class="wa-scan-knopf">${wIcon('kamera')}<span data-mit-bild="Neues Foto">Foto aufnehmen</span>
            <input id="wa-cam" type="file" accept="image/*" capture="environment" hidden></label>
          <label class="wa-scan-knopf">${wIcon('bild')}<span data-mit-bild="Anderes Bild">Bild hochladen</span>
            <input id="wa-img" type="file" accept="image/*" hidden></label>
          <button class="wa-scan-knopf wa-scan-crop" id="wa-crop" type="button" aria-label="Bild zuschneiden" title="Zuschneiden">${wIcon('zuschnitt')}</button>
        </div>
        ${maus ? `<p class="wa-scan-tipp">Oder mit ${einfuegen} einfügen oder hierher ziehen.</p>` : ''}
      </section>

      <h3 class="gd-h">Laden</h3>
      <div class="wa-shops" id="wa-vendor-grid" role="group" aria-label="Laden wählen">
        ${shopListe.slice(0, 7).map(n => `<button class="wa-shop" type="button" data-vg="${esc(n)}" aria-pressed="false">
          ${brandChipHtml(n)}<span class="wa-shop-name">${waKachelName(n)}</span></button>`).join('')}
        <button class="wa-shop wa-shop-mehr" type="button" id="wa-vendor-showmore" aria-expanded="false" aria-controls="wa-suche"
          aria-label="Weitere Läden">${mehrInhalt}</button>
      </div>
      <p class="pf-pruefen-text hidden" id="pf-laden-pruefen">Laden bitte prüfen</p>
      <div class="gd-block wa-suche hidden" id="wa-suche">
        <label class="wa-suche-zeile">${icon('search', 'icon')}
          <input id="wa-vendor" type="search" maxlength="30" autocomplete="off" autocorrect="off" spellcheck="false"
            enterkeyhint="done" placeholder="Laden suchen oder eintippen" aria-label="Laden suchen oder eintippen"></label>
        <div class="wa-suche-liste" id="wa-suche-liste"></div>
      </div>

      <h3 class="gd-h">Filiale <small>nur dort einlösbar</small></h3>
      <div class="gd-block wa-gruppe pf-filiale" id="pf-filiale">
        <label class="wa-zeile"><span class="wa-zeile-label">Name der Filiale <i class="pf-opt">optional</i></span>
          <input id="pf-name" maxlength="40" autocomplete="off" placeholder="z. B. der Name des Kaufmanns" value="${wert(f0.name)}"></label>
        <label class="wa-zeile"><span class="wa-zeile-label">Straße und Hausnummer</span>
          <input id="pf-strasse" maxlength="60" autocomplete="off" placeholder="z. B. Hauptstraße 12" value="${wert(f0.strasse)}"></label>
        <div class="pf-zeile-zwei">
          <label class="wa-zeile"><span class="wa-zeile-label">PLZ</span>
            <input id="pf-plz" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="12345" value="${wert(f0.plz)}"></label>
          <label class="wa-zeile"><span class="wa-zeile-label">Ort</span>
            <input id="pf-ort" maxlength="40" autocomplete="off" placeholder="z. B. Kassel" value="${wert(f0.ort)}"></label>
        </div>
        <div class="wa-zeile pf-standort" id="pf-standort"></div>
      </div>
      <p class="wa-fussnote">Pfandbons gelten nur in der Filiale, in der du sie bekommen hast. Mit Anschrift oder Standort weißt du später, wo.</p>

      <h3 class="gd-h">Betrag</h3>
      <label class="gd-block wa-betrag" id="wa-betrag">
        <input id="wa-amount" inputmode="decimal" autocomplete="off" placeholder="0,00" aria-label="Betrag in Euro"
          value="${bearbeitet?.amount != null ? esc(bearbeitet.amount.toFixed(2).replace('.', ',')) : ''}">
        <span class="wa-betrag-einheit" aria-hidden="true">€</span>
      </label>
      <p class="pf-pruefen-text hidden" id="pf-betrag-pruefen">Betrag bitte prüfen</p>

      <h3 class="gd-h">Details <small>optional</small></h3>
      <div class="gd-block wa-gruppe">
        <label class="wa-zeile"><span class="wa-zeile-label">Code für die Kasse</span>
          <input id="wa-code" class="wa-code-feld" maxlength="80" autocomplete="off" autocorrect="off" spellcheck="false"
            placeholder="Die Ziffern unter dem Barcode" value="${wert(bearbeitet?.code)}"></label>
        <label class="wa-zeile"><span class="wa-zeile-label">Bon-Nr.</span>
          <input id="pf-bon" maxlength="12" inputmode="numeric" autocomplete="off" placeholder="Falls aufgedruckt" value="${wert(bearbeitet?.bonNr)}"></label>
        <label class="wa-zeile"><span class="wa-zeile-label">Datum vom Bon</span>
          <input id="pf-datum" type="date" max="${new Date().toISOString().slice(0, 10)}" value="${wert(bearbeitet?.bonDatum)}"></label>
      </div>
      ${!addEditId && !(platz.voll || platz.fast) ? `<p class="wa-fussnote">${esc(platzText)}</p>` : ''}
    </div>`;

  el.querySelectorAll('.wa-leiste').forEach(x => x.remove());
  el.insertAdjacentHTML('beforeend', `
    <div class="wseite-leiste wa-leiste">
      <p class="wa-meldung" id="wa-msg" role="alert"></p>
      <button class="gd-los wa-speichern aus" id="wa-save" type="button" aria-disabled="true">${addEditId ? 'Änderungen speichern' : 'Speichern'}</button>
    </div>`);
  seite.waRo?.disconnect();
  if ('ResizeObserver' in window) {
    seite.waRo = new ResizeObserver(() => {
      const l = q('.wa-leiste');
      if (l) el.style.setProperty('--wa-leiste-h', l.offsetHeight + 'px');
    });
    seite.waRo.observe(q('.wa-leiste'));
  }
  inhalt.scrollTop = 0;
  if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
  const meldung = (text, art = '') => {
    const m = q('#wa-msg');
    if (!m) return;
    m.className = 'wa-meldung' + (art ? ' ' + art : '');
    m.textContent = text || '';
  };

  // ---- Laden: sieben Kacheln und "Weitere" mit Suche (wie beim Gutschein)
  let gewaehlt = '';
  const kacheln = () => [...el.querySelectorAll('#wa-vendor-grid [data-vg]')];
  const setzeShop = name => {
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    const bekannt = shopListe.find(n => n.toLowerCase() === name.toLowerCase());
    if (bekannt) name = bekannt;
    gewaehlt = name;
    const kachel = kacheln().find(t => t.dataset.vg.toLowerCase() === name.toLowerCase()) || null;
    kacheln().forEach(t => { t.classList.toggle('on', t === kachel); t.setAttribute('aria-pressed', String(t === kachel)); });
    const mehr = q('#wa-vendor-showmore');
    if (mehr) {
      const fremd = name && !kachel ? name : '';
      if ((mehr.dataset.zeigt || '') !== fremd) {
        mehr.dataset.zeigt = fremd;
        mehr.innerHTML = fremd ? `${brandChipHtml(fremd)}<span class="wa-shop-name">${esc(fremd)}</span>` : mehrInhalt;
      }
      mehr.classList.toggle('on', !!fremd);
      mehr.setAttribute('aria-label', fremd ? `${fremd}, anderen Laden suchen` : 'Weitere Läden');
    }
    if (q('#wa-vendor')) q('#wa-vendor').value = '';
    pruefenAus('laden');
    aktualisieren();
  };
  const sucheZeichnen = () => {
    const liste = q('#wa-suche-liste'), feld = q('#wa-vendor');
    if (!liste || !feld) return;
    const text = feld.value.replace(/\s+/g, ' ').trim();
    const low = text.toLowerCase();
    const treffer = (low ? shopListe.filter(n => n.toLowerCase().includes(low)) : shopListe.slice(7)).slice(0, 12);
    const exakt = shopListe.some(n => n.toLowerCase() === low);
    liste.innerHTML = treffer.map(n => `
      <button class="wa-treffer${n === gewaehlt ? ' an' : ''}" type="button" data-wahl="${esc(n)}">
        ${brandChipHtml(n)}<span>${esc(n)}</span></button>`).join('')
      + (text && !exakt ? `
      <button class="wa-treffer wa-treffer-frei" type="button" data-wahl="${esc(text)}">
        <span class="wa-treffer-plus">${icon('plus', 'icon')}</span><span>„${esc(text.slice(0, 30))}“ übernehmen</span></button>` : '');
    liste.querySelectorAll('[data-wahl]').forEach(b => b.onclick = () => { setzeShop(b.dataset.wahl); sucheAuf(false); buzz(6); });
  };
  const sucheAuf = auf => {
    const box = q('#wa-suche');
    if (!box) return;
    zeigeWeich(box, auf);
    q('#wa-vendor-showmore')?.setAttribute('aria-expanded', String(auf));
    if (auf) { sucheZeichnen(); if (maus) q('#wa-vendor')?.focus({ preventScroll: true }); }
  };
  kacheln().forEach(b => b.addEventListener('click', () => { setzeShop(b.dataset.vg); sucheAuf(false); buzz(6); }));
  q('#wa-vendor-showmore')?.addEventListener('click', () => { sucheAuf(!offenWeich(q('#wa-suche'))); buzz(6); });
  q('#wa-vendor')?.addEventListener('input', sucheZeichnen);
  q('#wa-vendor')?.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = e.target.value.replace(/\s+/g, ' ').trim().toLowerCase();
    const eintraege = [...el.querySelectorAll('#wa-suche-liste [data-wahl]')];
    const ziel = eintraege.find(b => !b.classList.contains('wa-treffer-frei') && b.dataset.wahl.toLowerCase() === text) || eintraege[0];
    if (ziel && text) ziel.click(); else sucheAuf(false);
  });

  waSchalterVerdrahten(seite, q, 'pfand', opts, alterSchalter);
  if (neuGefuellt && weich()) {
    q('.wa-form')?.animate?.([{ opacity: 0, transform: 'translate3d(0, 10px, 0)' }, { opacity: 1, transform: 'none' }],
      { duration: 280, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  }
  if (opts.richtung && weich()) {
    q('.wa-form')?.animate?.([{ opacity: 0, transform: `translate3d(${opts.richtung * 28}px, 0, 0)` }, { opacity: 1, transform: 'none' }],
      { duration: 300, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  }

  // ---- "Bitte pruefen": vom Scan unsicher gelesene Felder sind gelb
  // markiert, bis man sie anfasst
  const PRUEF_ZIEL = {
    betrag: () => q('#wa-betrag'), laden: () => q('#wa-vendor-grid'),
    '#pf-name': () => q('#pf-name')?.closest('.wa-zeile'), '#pf-strasse': () => q('#pf-strasse')?.closest('.wa-zeile'),
    '#pf-plz': () => q('#pf-plz')?.closest('.wa-zeile'), '#pf-ort': () => q('#pf-ort')?.closest('.wa-zeile'),
    '#wa-code': () => q('#wa-code')?.closest('.wa-zeile'), '#pf-bon': () => q('#pf-bon')?.closest('.wa-zeile'),
    '#pf-datum': () => q('#pf-datum')?.closest('.wa-zeile'),
  };
  const pruefenAn = key => {
    const z = PRUEF_ZIEL[key]?.();
    if (!z) return;
    z.classList.add('pruefen');
    if (key === 'betrag') zeigeWeich(q('#pf-betrag-pruefen'), true);
    else if (key === 'laden') zeigeWeich(q('#pf-laden-pruefen'), true);
    else {
      const label = z.querySelector('.wa-zeile-label');
      if (label && !label.querySelector('.pf-pruefen')) label.insertAdjacentHTML('beforeend', '<span class="pf-pruefen"> · prüfen</span>');
    }
  };
  const pruefenAus = key => {
    const z = PRUEF_ZIEL[key]?.();
    if (!z || !z.classList.contains('pruefen')) return;
    z.classList.remove('pruefen');
    z.querySelector('.pf-pruefen')?.remove();
    if (key === 'betrag') zeigeWeich(q('#pf-betrag-pruefen'), false);
    if (key === 'laden') zeigeWeich(q('#pf-laden-pruefen'), false);
  };
  const allePruefenAus = () => Object.keys(PRUEF_ZIEL).forEach(pruefenAus);

  // ---- Standort: nur auf Knopfdruck, mit Rueckfrage des Browsers. Gespeichert
  // werden nur die Koordinaten (kein Kartendienst, keine Adresse von aussen)
  let standort = pfandHatStandort(f0) ? { lat: Number(f0.lat), lng: Number(f0.lng), genau: f0.genau } : null;
  let standortLaeuft = false;
  const standortZeichnen = (fehler = '') => {
    const box = q('#pf-standort');
    if (!box) return;
    box.innerHTML = standort ? `
      <span class="pf-standort-bild an">${wIcon('ort')}</span>
      <span class="pf-standort-text"><b>Standort gespeichert</b><small>${standort.genau ? `auf etwa ${Math.max(5, Math.round(standort.genau / 5) * 5)} m genau` : 'wo du den Bon eingetragen hast'}</small></span>
      <button class="pf-standort-weg" type="button" id="pf-standort-weg">Entfernen</button>` : `
      <button class="pf-standort-knopf" type="button" id="pf-standort-los"${standortLaeuft ? ' disabled' : ''}>
        <span class="pf-standort-bild">${wIcon('standort')}</span>
        <span class="pf-standort-text"><b>${standortLaeuft ? 'Standort wird bestimmt …' : 'Standort verwenden'}</b>
          <small>${esc(fehler || 'Merkt sich, wo die Filiale liegt.')}</small></span>
      </button>`;
    q('#pf-standort-weg')?.addEventListener('click', () => { standort = null; standortZeichnen(); aktualisieren(); buzz(6); });
    q('#pf-standort-los')?.addEventListener('click', () => {
      if (!navigator.geolocation) { standortZeichnen('Dieses Gerät kann seinen Standort nicht bestimmen.'); return; }
      standortLaeuft = true;
      standortZeichnen();
      navigator.geolocation.getCurrentPosition(pos => {
        standortLaeuft = false;
        if (waSeiteOben() !== seite) return;
        standort = {
          lat: Math.round(pos.coords.latitude * 1e5) / 1e5, lng: Math.round(pos.coords.longitude * 1e5) / 1e5,
          genau: Math.round(pos.coords.accuracy || 0) || undefined,
        };
        standortZeichnen();
        aktualisieren();
        buzz(10);
      }, err => {
        standortLaeuft = false;
        standortZeichnen(err && err.code === 1 ? 'Standort nicht freigegeben. Trag die Filiale einfach oben ein.' : 'Standort gerade nicht bestimmbar. Versuch es gleich nochmal.');
      }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
    });
  };
  standortZeichnen();

  // ---- Vorschau und Pruefung
  const zahlAus = sel => {
    const n = parseFloat(String(q(sel)?.value || '').replace(/\s/g, '').replace('€', '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  const leseFiliale = () => {
    const t = sel => String(q(sel)?.value || '').replace(/\s+/g, ' ').trim();
    const plz = t('#pf-plz').replace(/\D/g, '').slice(0, 5);
    return {
      name: t('#pf-name').slice(0, 40), strasse: t('#pf-strasse').slice(0, 60), plz: plz.length === 5 ? plz : '', ort: t('#pf-ort').slice(0, 40),
      ...(standort ? { lat: standort.lat, lng: standort.lng, ...(standort.genau ? { genau: standort.genau } : {}) } : {}),
    };
  };
  const entwurf = () => ({
    vendor: gewaehlt, amount: zahlAus('#wa-amount'), bonDatum: q('#pf-datum')?.value || '',
    filiale: leseFiliale(), added: bearbeitet?.added || Date.now(), eingeloest: 0,
  });
  let vorschauMarke = null;
  const vorschauZeichnen = () => {
    const box = q('#wa-vorschau');
    if (!box) return;
    const d = entwurf();
    if (d.amount != null && d.amount < 0) d.amount = null;
    const tpl = document.createElement('template');
    tpl.innerHTML = pfandKarteHtml(d, { vorschau: true }).trim();
    const neu = tpl.content.firstElementChild;
    const alt = box.firstElementChild;
    // Gleiche Marke: nur die Texte tauschen, das Logo bleibt stehen (kein Flackern)
    if (!alt || vorschauMarke !== gewaehlt.toLowerCase()) { vorschauMarke = gewaehlt.toLowerCase(); box.replaceChildren(neu); return; }
    for (const sel of ['.vk-text', '.vk-rechts', '.vk-fuss', '.pk-filiale']) {
      const n = neu.querySelector(sel), o = alt.querySelector(sel);
      if (n && o && n.outerHTML !== o.outerHTML) o.replaceWith(n);
    }
  };
  const pruefen = () => {
    if (voll) return { fehlt: [], text: walletVollText('gutscheine') };
    const a = zahlAus('#wa-amount');
    const ohneWert = a == null || a <= 0;
    if (!gewaehlt && ohneWert) return { fehlt: ['shop', 'betrag'], text: 'Bitte noch Laden und Betrag angeben.' };
    if (!gewaehlt) return { fehlt: ['shop'], text: 'Bitte den Laden auswählen.' };
    if (ohneWert) return { fehlt: ['betrag'], text: 'Bitte den Betrag eintragen.' };
    if (a > 1000) return { fehlt: ['betrag'], text: 'So viel Pfand passt auf keinen Bon. Bitte den Betrag prüfen.' };
    return null;
  };
  const aktualisieren = () => {
    vorschauZeichnen();
    const datum = q('#pf-datum');
    if (datum) datum.classList.toggle('leer', !datum.value);
    const fe = pruefen();
    const knopf = q('#wa-save');
    if (knopf && !waSaving) { knopf.classList.toggle('aus', !!fe); knopf.setAttribute('aria-disabled', String(!!fe)); }
    const fehlt = fe ? fe.fehlt : [];
    if (!fehlt.includes('shop')) q('#wa-vendor-grid')?.classList.remove('err');
    if (!fehlt.includes('betrag')) q('#wa-betrag')?.classList.remove('err');
    const m = q('#wa-msg');
    if (m && m.classList.contains('error') && !fe) meldung('');
  };
  const fehlerZeigen = fe => {
    meldung(fe.text, 'error');
    q('#wa-vendor-grid')?.classList.toggle('err', fe.fehlt.includes('shop'));
    q('#wa-betrag')?.classList.toggle('err', fe.fehlt.includes('betrag'));
    buzz([40, 30, 40]);
    if (!reducedMotion()) neuStarten(q('#wa-msg'), 'shake-once');
    const ziel = fe.fehlt.includes('shop') ? q('#wa-vendor-grid') : fe.fehlt.includes('betrag') ? q('#wa-betrag') : null;
    ziel?.scrollIntoView({ behavior: sperrRuhig() ? 'auto' : 'smooth', block: 'center' });
    if (!fe.fehlt.includes('shop') && fe.fehlt.includes('betrag')) q('#wa-amount')?.focus({ preventScroll: true });
  };
  const feldPruefKey = { '#wa-amount': 'betrag' };
  ['#wa-amount', '#wa-code', '#pf-name', '#pf-strasse', '#pf-plz', '#pf-ort', '#pf-bon', '#pf-datum'].forEach(sel => {
    const feld = q(sel);
    if (!feld) return;
    const neu = () => { pruefenAus(feldPruefKey[sel] || sel); aktualisieren(); };
    feld.addEventListener('input', neu);
    feld.addEventListener('change', neu);
  });
  // Enter springt ins naechste Feld, im letzten schliesst es die Tastatur
  el.querySelector('.wa-form').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.target.type === 'search' || !e.target.matches('input')) return;
    e.preventDefault();
    const liste = [...el.querySelectorAll('.wa-form input:not([type="file"]):not([type="search"])')].filter(x => !x.closest('.hidden'));
    const naechstes = liste[liste.indexOf(e.target) + 1];
    if (naechstes) naechstes.focus(); else e.target.blur();
  });
  setzeShop(bearbeitet ? bearbeitet.vendor : addPrefill);

  // ---- Bild: Vorschau, Zuschneiden, Scan
  const bildZeigen = src => {
    const img = q('#wa-preview');
    if (!img) return;
    if (src) img.src = src;
    zeigeWeich(q('#wa-scan-frame'), !!src);
    const drop = q('#wa-drop');
    if (!drop || drop.classList.contains('hat-bild') === !!src) return;
    drop.classList.toggle('hat-bild', !!src);
    drop.querySelectorAll('[data-mit-bild]').forEach(t => { const alt = t.textContent; t.textContent = t.dataset.mitBild; t.dataset.mitBild = alt; });
  };
  const scanMeldung = (text, art = '') => {
    const m = q('#wa-ai-msg');
    if (!m) return;
    m.className = 'form-msg wa-scan-meldung' + (art ? ' ' + art : '');
    m.textContent = text || '';
  };
  const scanProgress = p => {
    const fl = q('#wa-progress-fill'), t = q('#wa-progress-txt');
    if (fl) fl.style.transform = `scaleX(${Math.max(0, Math.min(100, p)) / 100})`;
    if (t) t.textContent = Math.round(p) + ' %';
  };
  if (bearbeitet && (addCodeImg || addImg)) bildZeigen(addCodeImg || addImg);
  q('#wa-crop')?.addEventListener('click', () => {
    const quelle = addOrig || addImg || addCodeImg;
    if (!quelle) return;
    openImgCrop(quelle, (out, info) => {
      if (walletGesperrt() || waSeiteOben() !== seite || q('#wa-preview') == null) return;
      if (info.ganz) { addImg = out; addCodeImg = ''; }
      else { if (!addOrig && addImg) addOrig = addImg; addCodeImg = out; }
      bildZeigen(addCodeImg || addImg);
      aktualisieren();
      buzz(8);
    });
  });
  let scanFormat = bearbeitet?.codeFormat || '', scanCode = bearbeitet?.code || '';
  const handleImageFile = async (datei, fertig = null) => {
    if (!datei) return;
    const lauf = ++waScanLauf;
    const veraltet = () => lauf !== waScanLauf || waSeiteOben() !== seite;
    try {
      // Was der letzte Scan eingetragen hat und niemand angefasst hat, geht wieder raus
      for (const [sel, w] of Object.entries(waAutoWerte)) {
        if (sel === '__shop') { if (gewaehlt === w) setzeShop(''); continue; }
        const feld = q(sel); if (feld && feld.value === w) feld.value = '';
      }
      waAutoWerte = {};
      allePruefenAus();
      scanFormat = ''; scanCode = '';
      addCodeImg = ''; addOrig = ''; addImg = '';
      aktualisieren();
      const vorschau = await readImageFile(datei, 900, 0.82, 'vorschau');
      if (veraltet()) return;
      addImg = vorschau;
      const ganz = await readImageFile(datei, 1600, 0.82, 'foto').catch(() => '');
      if (veraltet()) return;
      addOrig = ganz;
      bildZeigen(addImg);
      q('#wa-scanline')?.classList.remove('hidden');
      q('#wa-progress')?.classList.remove('done');
      zeigeWeich(q('#wa-progress'), true);
      scanProgress(4);
      scanMeldung('Scanne den Pfandbon …');
      const r = fertig || await pfandScannen(datei, (p, text) => {
        if (veraltet()) return;
        scanProgress(p);
        if (text) scanMeldung(text);
      });
      if (veraltet()) return;
      if (r.codeImg) { addCodeImg = r.codeImg; bildZeigen(r.codeImg); }
      const erkannt = [], pruefenListe = [];
      // Nur leere Felder fuellen: was man schon selbst eingetragen hat, bleibt
      const fuelle = (sel, feld, name, key = sel) => {
        const w = feld && feld.wert != null ? String(feld.wert) : '';
        const input = q(sel);
        if (!w || !input || input.value) return;
        input.value = w;
        waAutoWerte[sel] = w;
        erkannt.push(name);
        if (!feld.sicher) { pruefenAn(key); pruefenListe.push(name); }
      };
      fuelle('#wa-amount', r.betrag?.wert != null ? { ...r.betrag, wert: r.betrag.wert.toFixed(2).replace('.', ',') } : null, 'Betrag', 'betrag');
      if (r.kette?.wert && !gewaehlt) {
        setzeShop(r.kette.wert);
        waAutoWerte.__shop = gewaehlt;
        erkannt.push('Laden');
        if (!r.kette.sicher) { pruefenAn('laden'); pruefenListe.push('Laden'); }
      }
      fuelle('#pf-name', r.filialName, 'Name der Filiale');
      fuelle('#pf-strasse', r.strasse, 'Straße');
      fuelle('#pf-plz', r.plz, 'PLZ');
      fuelle('#pf-ort', r.ort, 'Ort');
      fuelle('#wa-code', r.code, 'Code');
      fuelle('#pf-bon', r.bonNr, 'Bon-Nr.');
      fuelle('#pf-datum', r.datum, 'Datum');
      if (r.code?.wert && q('#wa-code')?.value === r.code.wert) { scanFormat = r.code.format || ''; scanCode = r.code.wert; }
      if (r.codeImg) erkannt.push('Code-Bild für die Kasse');
      scanProgress(100);
      q('#wa-progress')?.classList.add('done');
      q('#wa-scanline')?.classList.add('hidden');
      setTimeout(() => zeigeWeich(q('#wa-progress'), false), 1400);
      aktualisieren();
      const liste = xs => xs.length > 1 ? `${xs.slice(0, -1).join(', ')} und ${xs[xs.length - 1]}` : xs[0];
      if (!r.istPfand && erkannt.length < 2) {
        scanMeldung('Das sieht nicht nach einem Pfandbon aus. Du kannst die Felder trotzdem selbst ausfüllen.', 'error');
      } else if (erkannt.length) {
        scanMeldung(`Erkannt: ${liste(erkannt)}.${pruefenListe.length ? ` Gelb markiert heißt: bitte kurz prüfen (${liste(pruefenListe)}).` : ' Bitte kurz prüfen.'}`
          + (!q('#pf-strasse').value && !q('#pf-ort').value ? ' Die Filiale stand nicht lesbar auf dem Bon, bitte eintragen.' : ''), 'ok');
      } else scanMeldung('Nichts sicher erkannt, bitte die Felder ausfüllen.');
    } catch {
      if (veraltet()) return;
      q('#wa-scanline')?.classList.add('hidden');
      q('#wa-progress')?.classList.add('hidden');
      scanMeldung('Bild konnte nicht gelesen werden.', 'error');
    }
  };
  q('#wa-img').addEventListener('change', e => { handleImageFile(e.target.files[0]); e.target.value = ''; });
  q('#wa-cam').addEventListener('change', e => { handleImageFile(e.target.files[0]); e.target.value = ''; });
  waHandleImage = f => handleImageFile(f);
  const form = el.querySelector('.wa-form'), drop = q('#wa-drop');
  ['dragover', 'dragenter'].forEach(t => form.addEventListener(t, e => { e.preventDefault(); drop.classList.add('drag'); }));
  form.addEventListener('dragleave', e => { if (!form.contains(e.relatedTarget)) drop.classList.remove('drag'); });
  form.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('drag');
    const f = [...(e.dataTransfer.files || [])].find(x => x && x.type.startsWith('image/'));
    if (f) handleImageFile(f);
  });
  const zu = () => { if (waSeiteOben() === seite) wseiteZurueck(); };

  q('#wa-save').addEventListener('click', async () => {
    const knopf = q('#wa-save');
    if (waSaving) return;
    const fehler = pruefen();
    if (fehler) { fehlerZeigen(fehler); return; }
    const filiale = leseFiliale();
    // Ohne Filiale geht es, aber nur mit Ansage: der Bon gilt nur dort
    if (!(filiale.strasse || filiale.ort || filiale.plz || pfandHatStandort(filiale))) {
      const weiter = await askConfirm('<b>Ohne Filiale speichern?</b><br>Pfandbons gelten nur in der Filiale, in der du sie bekommen hast. Mit Straße, Ort oder Standort weißt du später, wo du ihn einlöst.', { okLabel: 'Ohne Filiale speichern' });
      if (!weiter || waSeiteOben() !== seite || walletGesperrt()) {
        if (waSeiteOben() === seite) { q('#pf-filiale')?.scrollIntoView({ behavior: sperrRuhig() ? 'auto' : 'smooth', block: 'center' }); }
        return;
      }
    }
    const editId = addEditId;
    const alt = editId ? state.wallet.vouchers.find(x => x.id === editId && istPfand(x)) : null;
    const code = String(q('#wa-code').value || '').replace(/\s+/g, '').slice(0, 80);
    const betrag = Math.round(zahlAus('#wa-amount') * 100) / 100;
    const pf = {
      ...(alt || {}),
      id: alt ? alt.id : Math.random().toString(36).slice(2, 9),
      art: 'pfand',
      vendor: gewaehlt.slice(0, 30),
      amount: betrag, balance: null, pin: '', end: '',
      code,
      // Format nur, solange der Code der gescannte ist
      codeFormat: code && code === scanCode.replace(/\s+/g, '') ? scanFormat : (alt && code === alt.code ? alt.codeFormat || '' : ''),
      bonNr: String(q('#pf-bon').value || '').trim().slice(0, 12),
      bonDatum: q('#pf-datum').value || '',
      filiale,
      notiz: String(alt?.notiz || '').slice(0, 80),
      eingeloest: alt ? (alt.eingeloest || 0) : 0,
      tx: [],
      img: addCodeImg ? '' : addImg, codeImg: addCodeImg,
      added: alt ? alt.added : Date.now(),
      ...(alt ? { mt: Date.now() } : {}),
    };
    if (alt && (pf.img !== alt.img || pf.codeImg !== alt.codeImg)) {
      pf.bildMt = Math.max(Date.now(), (alt.bildMt || 0) + 1);
      if (pf.orig && !addCodeImg) origEntfernen(pf);
    }
    const dupe = findDupe(pf);
    if (dupe && alt) {
      q('#wa-code').closest('.wa-zeile')?.classList.add('err');
      fehlerZeigen({ fehlt: [], text: `Diesen Code hast du schon bei einem anderen Pfandbon (${dupe.vendor}).` });
      return;
    }
    if (dupe) { dupeReject(`Diesen Pfandbon hast du schon in der Wallet (${esc(dupe.vendor)}, gleicher Code).`); return; }
    if (alt) state.wallet.vouchers[state.wallet.vouchers.indexOf(alt)] = pf;
    else state.wallet.vouchers.unshift(pf);
    if (addCodeImg && (addOrig || addImg) && (!alt || alt.codeImg !== addCodeImg)) origSichern(pf, addOrig || addImg);
    meldung('');
    save('wallet', state.wallet);
    renderWallet();
    const weiterInSchlange = () => !editId && (waFixQueue.length || geteiltSchlange.length) && nextFixOrDone();
    if (state.token) {
      waSaving = true;
      knopf.classList.remove('aus');
      setBtnLoading(knopf, true);
      meldung('Speichere und sichere am Konto …');
      const ok = await syncWalletNow();
      waSaving = false;
      setBtnLoading(knopf, false);
      if (!ok) {
        if (!weiterInSchlange()) zu();
        showToast(walletSyncFatal ? {
          title: 'Auf dem Gerät gespeichert',
          text: 'Das Konto hat das Sichern abgelehnt (' + (walletSyncError || 'unbekannt') + '). Bitte neu anmelden, dann wird nachgesichert.',
          iconName: 'warning',
        } : {
          title: 'Gespeichert, Sicherung folgt',
          text: 'Der Server war gerade nicht erreichbar. Der Pfandbon bleibt auf dem Gerät und wird automatisch nachgesichert.',
          iconName: 'warning',
        }, 8000);
        if (!editId) zeigePfand(pf.id);
        return;
      }
    }
    playSfx('coin'); buzz(20);
    island(editId ? 'Pfandbon geändert' : 'Pfandbon gespeichert');
    if (weiterInSchlange()) return;
    zu();
    if (!editId) zeigePfand(pf.id);
  });

  const formStand = () => JSON.stringify([gewaehlt, addImg, addCodeImg, standort,
    ...[...el.querySelectorAll('.wa-form input:not([type="file"]):not([type="search"])')].map(x => x.value)]);
  const anfang = formStand();
  seite.zurueckFrage = () => {
    if (waSaving) return '';
    const rest = waFixQueue.length + geteiltSchlange.length;
    const geaendert = formStand() !== anfang;
    if (!geaendert && !rest) return '';
    const teile = geaendert ? ['Deine Eingaben sind noch nicht gespeichert.'] : [];
    if (rest) teile.push(`${rest === 1 ? 'Ein weiteres Bild wartet' : `${rest} weitere Bilder warten`} noch und ${rest === 1 ? 'wird' : 'werden'} dann nicht gespeichert.`);
    return teile.join(' ') + ' Verwerfen?';
  };
  waApi = {
    seite,
    bild: src => bildZeigen(src),
    shop: name => setzeShop(name),
    aktualisieren,
    hinweis: (art, html) => {
      inhalt.querySelectorAll('.wa-hinweis.' + art).forEach(x => x.remove());
      const b = document.createElement('div');
      b.className = 'wa-hinweis ' + art;
      b.innerHTML = `${icon(art === 'dupe' ? 'warning' : 'bulb', 'icon')}<span>${html}</span>`;
      inhalt.prepend(b);
      inhalt.scrollTop = 0;
      return b;
    },
  };
  aktualisieren();
  // Kam ein Bild mit (Kamera im Pfand-Reiter, erkannt im Gutschein-Formular,
  // Warteschlange): gleich scannen — bzw. das fertige Ergebnis eintragen
  if (opts.datei) handleImageFile(opts.datei, opts.ergebnis || null);
}

// Umschalter oben auf der Hinzufuegen-Seite: Gutschein | Rabattcode | Pfandbon.
// von: wo die Flaeche startet (sie gleitet dann zu aktiv)
const WA_MODI = [['voucher', 'Gutschein'], ['rabatt', 'Rabattcode'], ['pfand', 'Pfandbon']];
function waSchalterHtml(von, aktiv) {
  const i = Math.max(0, WA_MODI.findIndex(([k]) => k === von));
  return `
    <div class="wa-schalter" id="wa-modus" role="tablist" aria-label="Was fügst du hinzu?" style="--i:${i}">
      <span class="wa-schalter-flaeche" aria-hidden="true"></span>
      ${WA_MODI.map(([k, t]) => `<button class="wa-schalter-knopf${k === von ? ' an' : ''}" type="button" role="tab" data-wa-modus="${k}" aria-selected="${k === aktiv}">${t}</button>`).join('')}
    </div>`;
}
function waSchalterVerdrahten(seite, q, typ, opts, alterSchalter) {
  // Der alte Schalter bleibt stehen: seine Flaeche gleitet gerade und soll
  // nicht mitten im Weg neu anfangen
  if (alterSchalter && q('#wa-modus')) q('#wa-modus').replaceWith(alterSchalter);
  const modus = q('#wa-modus');
  if (!modus) return;
  const index = k => Math.max(0, WA_MODI.findIndex(([x]) => x === k));
  const setzeModus = k => {
    modus.style.setProperty('--i', index(k));
    modus.querySelectorAll('[data-wa-modus]').forEach(b => {
      b.classList.toggle('an', b.dataset.waModus === k);
      b.setAttribute('aria-selected', String(b.dataset.waModus === k));
    });
  };
  if (opts.von && opts.von !== typ) requestAnimationFrame(() => { void modus.offsetWidth; setzeModus(typ); });
  // onclick statt addEventListener: der Schalter bleibt ueber den Wechsel
  // hinweg stehen und darf den Handler nicht doppelt tragen
  modus.querySelectorAll('[data-wa-modus]').forEach(k => k.onclick = () => {
    if (k.dataset.waModus === typ || waSaving || modus._wechselt) return;
    buzz(8);
    const ziel = k.dataset.waModus;
    const richtung = index(ziel) > index(typ) ? 1 : -1;
    setzeModus(ziel);
    const form = q('.wa-form');
    const weiter = () => {
      modus._wechselt = false;
      if (wseiteOben() !== seite || walletGesperrt()) return;
      openWalletAdd(ziel, '', '', { von: typ, richtung });
    };
    if (!weich() || !form?.animate) return weiter();
    modus._wechselt = true;
    const raus = form.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translate3d(${-richtung * 24}px, 0, 0)` }],
      { duration: 120, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
    let getan = false;
    const einmal = () => { if (!getan) { getan = true; weiter(); } };
    raus.onfinish = einmal;
    setTimeout(einmal, 260);
  });
}
// Die Hinzufuegen-Seite holen: liegt sie schon oben (Umschalter, naechstes
// Bild), wird sie nur neu gefuellt — sonst gleitet eine neue herein
function waSeiteHolen(titel, opts = {}) {
  let seite = waSeiteOben();
  const neuGefuellt = !!seite && !opts.richtung && !opts.von;
  if (seite) {
    seite.el.querySelector('.wseite-titel').textContent = titel;
    seite.el.setAttribute('aria-label', titel);
    return { seite, neuGefuellt };
  }
  buzz(8);
  // Liegt gerade ein Blatt ueber einer Seite (Marken-Blatt aus dem
  // Laden-Hinweis), kaeme die neue Seite darunter zu liegen: Blatt erst zu
  if (document.body.classList.contains('blatt-ueber-seite') && state.sheetMode) closeSheet();
  seite = wseiteOeffnen({ art: 'hinzufuegen', titel, klasse: 'wa', baue: () => { } });
  if (!seite) return null;
  const neu = seite;
  neu.beimSchliessen = () => {
    waScanLauf++;                              // laufende Scans tragen nichts mehr ein
    neu.waRo?.disconnect();
    if (waApi?.seite === neu) { waApi = null; waHandleImage = null; }
    // Wer die Seite verlaesst, bricht auch den Rest ab (Ergaenzen, weitere
    // geteilte Bilder) — sonst tauchte er beim naechsten Speichern ungefragt
    // wieder auf. Nur die Sperre haelt ihn fest: danach geht es weiter.
    if (!walletGesperrt()) { waFixQueue = []; waFixTotal = 0; geteiltSchlange = []; }
  };
  return { seite, neuGefuellt: false };
}

// ---- Marken-Ansicht: Farben und schwebende Logos im Kopf
// Zwei Farb-Ebenen im Farbfeld wechseln sich ab, damit REWE -> dm weich
// ueberblendet (Verlaeufe selbst lassen sich nicht animieren, Deckkraft schon).
function farbeRgb(c) {
  const el = document.createElement('i');
  el.style.color = c;
  el.style.display = 'none';
  document.body.appendChild(el);
  const m = getComputedStyle(el).color.match(/[\d.]+/g);
  el.remove();
  return m ? m.slice(0, 3).map(Number) : [18, 199, 126];
}
function farbMix(a, b, t) { return a.map((x, i) => Math.round(x + (b[i] - x) * t)); }
function farbHex(rgb) { return '#' + rgb.map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join(''); }
// Drei Toene wie beim Rang: dunkel (Text auf Weiss), Hauptton, hell
function markenFarben(name) {
  const basis = farbeRgb(brandColor(name));
  const hell = (0.299 * basis[0] + 0.587 * basis[1] + 0.114 * basis[2]) / 255;
  const schwarz = [0, 0, 0], weiss = [255, 255, 255];
  // Helle Markentoene (Netto-Gelb) dunkler: im Kopf steht weisse Schrift
  const k2 = hell > 0.6 ? farbMix(basis, schwarz, 0.32) : hell < 0.16 ? farbMix(basis, weiss, 0.14) : basis;
  return [farbHex(farbMix(k2, schwarz, 0.3)), farbHex(k2), farbHex(farbMix(k2, weiss, hell > 0.6 ? 0.1 : 0.22))];
}
function setzeMarkenModus(name) {
  if (name === markenModusName) return;
  markenModusName = name;
  document.body.classList.toggle('marken-modus', !!name);
  const feld = $('#wallet-farbfeld');
  if (!feld) return;
  let ebenen = feld.querySelectorAll('.ff-marke');
  if (ebenen.length < 2) {
    feld.insertAdjacentHTML('beforeend', '<div class="ff-marke"></div><div class="ff-marke"></div><div class="ff-logos"></div>');
    ebenen = feld.querySelectorAll('.ff-marke');
  }
  clearTimeout(markenEbeneUhr);
  if (!name) {
    ebenen.forEach(e => e.classList.remove('an', 'oben'));
  } else {
    const [k1, k2, k3] = markenFarben(name);
    const alt = ebenen[markenEbene];
    markenEbene = 1 - markenEbene;
    const neu = ebenen[markenEbene];
    neu.style.setProperty('--m1', k1);
    neu.style.setProperty('--m2', k2);
    neu.style.setProperty('--m3', k3);
    alt.classList.remove('oben');
    void neu.offsetWidth;
    neu.classList.add('an', 'oben');
    // Die alte Marke bleibt darunter stehen, bis die neue ganz da ist
    markenEbeneUhr = setTimeout(() => alt.classList.remove('an'), 650);
    const root = document.documentElement.style;
    root.setProperty('--marke-k1', k1);
    root.setProperty('--marke-k2', k2);
    root.setProperty('--marke-k3', k3);
  }
  zeigeMarkenLogos(name);
  setzeLeistenfarbe();
}
// Ein paar Logos der Marke schweben leise im Kopf (nur transform/opacity)
function zeigeMarkenLogos(name) {
  const box = $('#wallet-farbfeld .ff-logos');
  if (!box) return;
  box.querySelectorAll('.ff-logo').forEach(l => { l.classList.add('weg'); setTimeout(() => l.remove(), 450); });
  if (!name || sperrRuhig() || document.body.classList.contains('sparsam')) return;
  const url = markenLogoUrl(name, 64);
  const inhalt = url
    ? `<img src="${esc(url)}" alt="" decoding="async" onerror="this.remove()">`
    : `<i>${esc(brandInitials(name))}</i>`;
  // Feste, gut verteilte Plaetze: x %, y % der Kopfhoehe, Groesse px, Dauer s
  const plaetze = [[5, 16, 34, 9], [20, 62, 26, 11], [38, 6, 22, 13], [62, 60, 36, 10], [80, 18, 28, 12], [91, 64, 22, 14], [50, 38, 18, 15]];
  box.insertAdjacentHTML('beforeend', plaetze.map(([x, y, g, d], i) => `
    <span class="ff-logo" style="--x:${x}%; --y:${y}%; --g:${g}px; --d:${d}s; --v:${120 + i * 80}ms; --r:${(i % 2 ? 1 : -1) * (6 + i * 3)}deg">
      <span class="ff-chip">${inhalt}</span>
    </span>`).join(''));
}

// Welche Marke traegt der Kopf? Nur mit Markenfilter und nur, solange es von
// ihr noch Gutscheine mit Guthaben gibt (sonst wieder das Gesamtguthaben).
function walletMarkeName() {
  const f = state.walletFilter && state.walletFilter !== 'alle' ? String(state.walletFilter).toLowerCase() : '';
  if (!f) return '';
  const v = state.wallet.vouchers.find(x => !ohneGuthaben(x) && (x.balance == null || x.balance > 0)
    && String(x.vendor || '').toLowerCase() === f);
  return v ? v.vendor : '';
}

// Drei Wallet-Bereiche: Gutscheine | Karten & Coupons | Pfand
let walletTab = 'gutscheine';
// Die Flaeche hinter dem aktiven Titel. Die Titel sind verschieden breit —
// eine Flaeche, die breiter oder schmaler wird, liesse sich nur ueber width
// animieren (Layout in jedem Bild). Deshalb drei Teile: zwei runde Kappen,
// die nur verschoben werden, und ein Mittelstueck, das verschoben und in der
// Breite skaliert wird (ohne Ecken, also ohne Verzerrung). Nur transform.
function setzeWmFlaeche(anim = true) {
  const modes = $('#wallet-modes');
  const aktiv = modes?.querySelector('.wm-titel.active');
  if (!modes || !aktiv || !aktiv.offsetWidth) return;
  const flaeche = modes.querySelector('.wm-flaeche');
  const x = aktiv.offsetLeft - flaeche.offsetLeft, w = aktiv.offsetWidth;
  const R = 10;
  modes.classList.toggle('wm-still', !anim || reducedMotion());
  modes.style.setProperty('--wm-x', x + 'px');
  modes.style.setProperty('--wm-w', w + 'px');
  modes.style.setProperty('--wm-s', String(Math.max(0, (w - 2 * R) / 100)));
  if (!anim) { void flaeche.offsetWidth; requestAnimationFrame(() => modes.classList.remove('wm-still')); }
  modes.classList.add('wm-bereit');
}
addEventListener('resize', () => setzeWmFlaeche(false));
document.fonts?.ready?.then(() => setzeWmFlaeche(false));
// Wird die Wallet sichtbar (vorher display:none), stimmen die Masse erst dann
if ('ResizeObserver' in window) {
  const modes = document.querySelector('#wallet-modes');
  if (modes) new ResizeObserver(() => setzeWmFlaeche(false)).observe(modes);
}
// Der Wechsel blendet ueber: der alte Bereich (und beim Weg zu den Coupons der
// Guthaben-Block) blendet aus, dann wird in EINEM Schritt umgeschaltet, der
// Schieber gleitet an seine neue Stelle und der neue Bereich blendet ein.
// Karten & Coupons sind universell — dort gelten immer die Rang-Farben, nie
// die der gewaehlten Marke.
function updateWalletTab(anim) {
  const coupons = walletTab === 'coupons' || walletTab === 'karten';
  const pfand = walletTab === 'pfand';
  const gated = !state.token && !coupons;
  // Ohne Guthaben-Block oben: Karten & Coupons, Pfand und die Anmelde-Sperre
  const ohneGeld = coupons || pfand || gated;
  document.body.classList.toggle('wallet-farbe', state.activeView === 'wallet' && !!state.token);
  document.querySelectorAll('[data-wtab]').forEach(b =>
    b.setAttribute('aria-selected', b.classList.contains('active') ? 'true' : 'false'));
  setzeWmFlaeche(anim);
  setzeMarkenModus(ohneGeld ? '' : walletMarkeName());
  if (!walletTab.startsWith('gutscheine')) $('#wallet-mini')?.classList.remove('show');

  const wc = $('#wallet-content'), cc = $('#coupons-content'), pc = $('#pfand-content'), geld = $('#wallet-kopf-geld');
  const setzen = (neuZeichnen = true) => {
    $('#wallet-gate').classList.toggle('hidden', !gated);
    wc.classList.toggle('hidden', gated || coupons || pfand);
    cc.classList.toggle('hidden', !coupons);
    pc.classList.toggle('hidden', !pfand || gated);
    if (coupons && neuZeichnen) renderCoupons(cc);
    if (pfand && !gated && neuZeichnen) renderPfand(pc);
  };
  const altHost = [cc, pc, wc].find(h => !h.classList.contains('hidden')) || null;
  const neuHost = coupons ? cc : gated ? null : pfand ? pc : wc;
  const lauf = (updateWalletTab.lauf || 0) + 1;
  updateWalletTab.lauf = lauf;
  // Ein laufender Wechsel ist mit diesem erledigt: seine Blenden loesen
  for (const el of [wc, cc, pc, geld]) el?.getAnimations?.().forEach(a => { if (a.id === 'wtab') a.cancel(); });

  const bewegt = anim && altHost !== neuHost && !reducedMotion() && !!wc.animate;
  if (!bewegt) {
    setzen();
    kopfUmschalten(ohneGeld, false, kopfZielUnten(ohneGeld));
    return;
  }
  // Die Coupons (bzw. das Pfand) schon jetzt aufbauen, solange sie noch
  // versteckt sind (kostet dann kein Layout) — sonst faellt die Arbeit genau in
  // den Moment, in dem der Schieber losgleiten soll
  if (coupons) renderCoupons(cc);
  if (pfand && !gated) renderPfand(pc);
  pruefeBildrate();   // das Geraet misst sich selbst, siehe unten
  // Fuer die Dauer der Umschaltung ruhen die teuren Weichzeichner (siehe CSS)
  document.body.classList.add('wallet-wechsel');
  clearTimeout(updateWalletTab.ruheTimer);
  updateWalletTab.ruheTimer = setTimeout(() => document.body.classList.remove('wallet-wechsel'), 700);
  const zuKlappen = ohneGeld && !geld.classList.contains('zu');
  const raus = [altHost, zuKlappen && geld].filter(Boolean);
  const blende = (el, von, nach, dauer, verz = 0) => {
    const a = el.animate([{ opacity: von }, { opacity: nach }],
      { duration: dauer, delay: verz, easing: nach ? 'cubic-bezier(.22, 1, .36, 1)' : 'cubic-bezier(.4, 0, 1, 1)', fill: 'both' });
    a.id = 'wtab';
    return a;
  };
  raus.forEach(el => blende(el, 1, 0, 130));
  let getan = false;
  const weiter = () => {
    if (getan || updateWalletTab.lauf !== lauf) return;
    getan = true;
    const aufKlappen = !ohneGeld && geld.classList.contains('zu');
    const kopfZiel = kopfZielUnten(ohneGeld);
    setzen(false);
    kopfUmschalten(ohneGeld, true, kopfZiel);
    raus.forEach(el => el.getAnimations().forEach(a => { if (a.id === 'wtab') a.cancel(); }));
    const rein = [neuHost, aufKlappen && geld].filter(Boolean);
    rein.forEach(el => {
      const a = blende(el, 0, 1, 240, 30);
      a.onfinish = () => a.cancel();
    });
  };
  setTimeout(weiter, 140);   // nicht auf onfinish warten: gedrosselte Tabs melden es spaet
}

const walletDeckOpen = new Set();
const walletDeckShown = {};
let walletFlatShown = 10;
// Wie viele Gutscheinkarten hoechstens gleichzeitig im Baum stehen duerfen.
// Zehn am Anfang, zehn pro Schritt — nachgeladen wird nur auf Tastendruck.
const SICHT_SCHRITT = 10;
let walletSicht = SICHT_SCHRITT;
// Alles wieder einklappen — beim Betreten der Wallet, bei Filter- und Sortierwechsel.
// So sieht man immer erst die aufgeraeumten Stapel, nie eine Wand aus Karten.
function restack() {
  walletDeckOpen.clear();
  Object.keys(walletDeckShown).forEach(k => delete walletDeckShown[k]);
  walletFlatShown = SICHT_SCHRITT;
  walletSicht = SICHT_SCHRITT;
}
// Die Pille hinter dem aktiven Filter. Sie liegt in der Leiste und wird nur
// verschoben und in der Groesse gesetzt — kein Neuaufbau, deshalb gleitet der
// Wechsel weich, auch wenn die Chips ueber mehrere Zeilen umbrechen.
function setzeFilterPille(host) {
  const pille = host.querySelector('.filter-pille');
  const aktiv = host.querySelector('.chip.active');
  if (!pille) return;
  if (!aktiv) { pille.style.opacity = '0'; return; }
  const hr = host.getBoundingClientRect(), ar = aktiv.getBoundingClientRect();
  pille.style.width = ar.width + 'px';
  pille.style.height = ar.height + 'px';
  pille.style.transform =
    `translate(${Math.round(ar.left - hr.left)}px, ${Math.round(ar.top - hr.top)}px)`;
  pille.style.opacity = '1';
}
addEventListener('resize', () => {
  document.querySelectorAll('.wallet-filters').forEach(setzeFilterPille);
});

function renderWallet() {
  // Wallet nur mit Profil: Gast sieht die Anmelde-Sperre (Coupons bleiben offen)
  updateWalletTab(false);
  if (!state.token) return;
  zeigePinEmpfehlung();
  const uh = $('#used-hinweis');
  if (uh) uh.textContent = kontoInfo && kontoInfo.autoAufraeumen === false
    ? 'Aufgebrauchte bleiben, bis du sie löschst (automatisches Aufräumen ist in den Einstellungen aus).'
    : 'Aufgebrauchte Gutscheine werden 30 Tage nach der letzten Buchung automatisch entfernt. Abschalten kannst du das in den Einstellungen.';

  const allActive = state.wallet.vouchers.filter(v => !ohneGuthaben(v) && (v.balance == null || v.balance > 0));
  const used = state.wallet.vouchers.filter(v => !ohneGuthaben(v) && v.balance != null && v.balance <= 0);

  // Suche (Shop, Code, PIN, eigene Notiz, Buchungs-Notizen) + Filter-Chips
  const q = (state.walletQuery || '').trim().toLowerCase();
  const vMatch = v => !q
    || String(v.vendor || '').toLowerCase().includes(q)
    || String(v.code || '').toLowerCase().includes(q)
    || String(v.pin || '').toLowerCase().includes(q)
    || String(v.notiz || '').toLowerCase().includes(q)
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
      saveWalletFilter();
      restack();
      renderWallet();
    });
  }
  if (marketOn && state.walletVal) {
    active = active.filter(v => (v.amount ?? v.balance ?? 0) === state.walletVal);
  }
  // Marke: ein Knopf mit Auswahlliste statt einer Reihe Chips
  const vendors = [...new Set(allActive.map(v => v.vendor))];
  const markeKnopf = $('#wallet-marke');
  if (markeKnopf) {
    const f = state.walletFilter && state.walletFilter !== 'alle' ? state.walletFilter : '';
    const gewaehlt = f ? (vendors.find(vn => vn.toLowerCase() === f.toLowerCase()) || f) : '';
    const inhalt = $('#wallet-marke-inhalt');
    if (inhalt.dataset.w !== gewaehlt) {
      inhalt.dataset.w = gewaehlt;
      inhalt.innerHTML = gewaehlt ? `${brandChipHtml(gewaehlt)}<span>${esc(gewaehlt)}</span>` : '<span>Alle Marken</span>';
      if (!sperrRuhig()) neuStarten(markeKnopf, 'gewechselt');
    }
    markeKnopf.classList.toggle('gewaehlt', !!gewaehlt);
    markeKnopf.setAttribute('aria-label', gewaehlt ? `Marke: ${gewaehlt}. Ändern` : 'Nach Marke filtern');
    // Mit nur einer Marke gibt es nichts zu waehlen — ausser man muss zurueck
    markeKnopf.classList.toggle('hidden', vendors.length < 2 && !gewaehlt);
  }

  // Kontostand: Summe ALLER Restguthaben (unabhängig von Suche/Filter), zählt animiert
  const total = Math.round(allActive.reduce((s, v) => s + (v.balance || 0), 0) * 100) / 100;
  // Marken-Ansicht: ist oben eine Marke gewaehlt, zeigt der Kopf nur IHR
  // Guthaben und traegt ihre Farben. Der Rang bleibt am Gesamtguthaben.
  const fMarke = state.walletFilter && state.walletFilter !== 'alle' ? String(state.walletFilter).toLowerCase() : '';
  const markenTreffer = fMarke ? allActive.filter(v => String(v.vendor || '').toLowerCase() === fMarke) : [];
  // Aufgebraucht oder anderes Konto: dann wieder das Gesamtguthaben (der Filter bleibt stehen)
  const markenGs = markenTreffer.length ? markenTreffer : null;
  const markeName = markenGs ? markenGs[0].vendor : '';
  const anzeige = markenGs ? Math.round(markenGs.reduce((x, v) => x + (v.balance || 0), 0) * 100) / 100 : total;
  // Lange Betraege etwas kleiner, damit sie links neben dem Maskottchen bleiben
  const betragLaenge = euroFmt(anzeige).length;
  $('#wallet-total').dataset.laenge = betragLaenge >= 11 ? 'xl' : betragLaenge >= 10 ? 'l' : betragLaenge >= 8 ? 'm' : '';
  animateNumber($('#wallet-total'), renderWallet.lastAnzeige ?? renderWallet.lastTotal, anzeige);
  renderWallet.lastTotal = total;
  renderWallet.lastAnzeige = anzeige;
  const anzahlKopf = markenGs ? markenGs.length : allActive.length;
  $('#wallet-total-sub').textContent = markenGs
    ? `${markeName} · ${anzahlKopf} Gutschein${anzahlKopf === 1 ? '' : 'e'}`
    : allActive.length
      ? `über ${allActive.length} Gutschein${allActive.length > 1 ? 'e' : ''}`
      : 'noch keine Gutscheine mit Guthaben';
  // Die Markenfarben setzt updateWalletTab (oben) — nur bei den Gutscheinen
  renderZuletztVerwendet(q, fMarke);
  // Platz in der Wallet: alle Gutscheine zaehlen, auch aufgebrauchte
  const platzEl = $('#wallet-platz');
  if (platzEl) {
    const p = walletPlatz('gutscheine');
    const zahl = p.g ? `${p.n} + ${p.g} Geschenk${p.g > 1 ? 'e' : ''}` : `${p.n}`;
    platzEl.textContent = p.voll ? `voll · ${zahl} von ${p.max}` : `${zahl} von max. ${p.max}`;
    platzEl.className = 'wallet-platz' + (p.voll ? ' voll' : p.fast ? ' fast' : '');
    platzEl.title = `Maximal ${p.max} Gutscheine pro Wallet. Aufgebrauchte zählen mit — löschen schafft Platz.`;
  }

  // Spar-Rang: je mehr Guthaben, desto edler die Karte + Fortschritt zur nächsten Stufe
  const rank = rankFor(total);
  const card = $('#wallet-kopf');
  if (card) {
    card.className = 'wallet-kopf tier-' + rank.tier;
    // Die Kopfzeile zeigt den oberen Ausschnitt DESSELBEN Verlaufs — dafuer
    // braucht sie alle drei Toene und die eigene Hoehe als Versatz
    const st = getComputedStyle(card);
    ['k1', 'k2', 'k3'].forEach(n => {
      const wert = st.getPropertyValue('--' + n).trim();
      if (wert) document.documentElement.style.setProperty('--kopf-' + n, wert);
    });
    setzeLeistenfarbe();   // Statusleiste traegt die Stufenfarbe mit
    setzeWalletMaskottchen(rank.slug);
    renderRangKarte();     // Profil-Kopf und Rang-Karte ziehen mit (Kontowechsel, Abgleich)
    messeKopfzeile();
    // Der Rang steht klein neben der Gutschein-Zahl, mehr braucht es nicht
    const rangEl = $('#wallet-rank');
    if (rangEl) {
      rangEl.textContent = rank.name;
      rangEl.title = rank.next
        ? `Noch ${euroFmt(rank.next.min - total)} bis ${rank.next.name}`
        : 'Höchste Stufe erreicht';
    }
  }
  // Gutschein-Karte: der Hintergrund füllt sich nach Restguthaben (rechts wird
  // durchsichtig, was schon ausgegeben ist), PIN steht unter der Kartennummer
  const vCard = v => voucherCardHtml(v, { mehr: true });

  // Kartendeck pro Haendler: viele Gutscheine desselben Shops stapeln sich zu
  // EINER Karte (nur die oberste wird wirklich gerendert). Antippen faechert
  // auf, und auch dann kommen die Karten portionsweise — die Wallet bleibt
  // leicht, egal wie viele REWE-Gutscheine man hortet.
  const DECK_MIN = 3;
  const moreBtn = (key, n) => `<button class="deck-more" data-deck-more="${esc(key)}">
      Weitere anzeigen<small>noch ${n}</small></button>`;
  // Nur die Volltextsuche zeigt eine flache Liste — da sucht man ja gezielt.
  // Filter und Sortierung behalten Stapel, nur die Gruppierung wechselt:
  // ohne Markenfilter nach Händler, sonst nach Wert (REWE 25 €, REWE 50 € …).
  const nachWert = marketOn || ['hoch', 'niedrig'].includes(state.walletSort || '');
  const wertVon = v => Math.round((v.amount ?? v.balance ?? 0) * 100) / 100;
  let voucherHtml = '';
  if (!active.length) {
    voucherHtml = `<div class="status">${q || marketOn || state.walletVal
      ? 'Kein Gutschein passt zu Suche/Filter.'
      : 'Noch keine Gutscheine, leg oben den ersten an.'}</div>`;
  } else if (q) {
    const lim = walletFlatShown;
    voucherHtml = active.slice(0, lim).map(vCard).join('')
      + (active.length > lim ? moreBtn('__flat', active.length - lim) : '');
  } else {
    const order = [];
    const gruppen = new Map();
    active.forEach(v => {
      const key = nachWert ? `${v.vendor}|${wertVon(v)}` : v.vendor;
      if (!gruppen.has(key)) { gruppen.set(key, []); order.push(key); }
      gruppen.get(key).push(v);
    });
    // Ein Budget ueber ALLE Gruppen. Vorher hatte nur der geoeffnete Stapel eine
    // Grenze — bei gesetztem Markenfilter wird aber nach Wert gruppiert, und
    // Gruppen unter drei Karten wurden komplett gemalt. Mit 51 Gutscheinen
    // standen dann auf einen Schlag Dutzende Karten im Baum, jede mit Verlauf,
    // Fuellstand und Schatten. Jetzt gilt eine Obergrenze fuer die ganze Liste;
    // der Rest kommt beim Weiterscrollen nach (der Knopf laedt sich selbst).
    let budget = walletSicht;
    let rest = 0;
    const teile = [];
    for (const key of order) {
      const list = gruppen.get(key);
      const vn = list[0].vendor;
      const titel = nachWert ? `${vn} · ${euroFmt(wertVon(list[0]))}` : vn;
      const zu = !walletDeckOpen.has(key);
      if (budget <= 0) { rest += (zu && list.length >= DECK_MIN) ? 1 : list.length; continue; }

      if (list.length < DECK_MIN) {
        const zeig = list.slice(0, budget);
        budget -= zeig.length;
        rest += list.length - zeig.length;
        teile.push(zeig.map(vCard).join(''));
        continue;
      }
      if (zu) {
        // Ein zusammengelegter Stapel kostet genau eine gemalte Karte
        const sum = Math.round(list.reduce((acc, v) => acc + (v.balance || 0), 0) * 100) / 100;
        budget -= 1;
        teile.push(`
        <div class="deck" data-deck="${esc(key)}" data-auch="v:${esc(list[0].id)}" style="--bc:${brandColor(vn)}" role="button" aria-label="${esc(titel)}-Stapel öffnen">
          ${vCard(list[0]).replace('data-wv=', 'data-deck-top=')}
          <span class="deck-count">${list.length} Gutscheine · ${euroFmt(sum)}</span>
        </div>`);
        continue;
      }
      // Nur EINE Grenze: das Gesamtbudget. Vorher hatte der Stapel zusaetzlich
      // seine eigene (DECK_CHUNK), die der Nachlade-Knopf nicht angehoben hat —
      // ab dem zweiten Druck passierte deshalb nichts mehr.
      const shown = Math.min(list.length, budget);
      budget -= shown;
      rest += list.length - shown;
      // data-stapel: diese Karten fächern aus dem Stapel auf bzw. fahren beim
      // Stapeln in ihn zurueck
      teile.push(`
        <div class="deck-head" data-key="kopf:${esc(key)}">
          <span class="deck-head-name">${brandChipHtml(vn)} <b>${esc(titel)}</b> <small>(${list.length})</small></span>
          <button class="chip" data-deck-close="${esc(key)}">Stapeln</button>
        </div>
        ${list.slice(0, shown).map(v => vCard(v).replace('data-wv=', `data-stapel="${esc(key)}" data-wv=`)).join('')}`);
    }
    voucherHtml = teile.join('') + (rest > 0 ? moreBtn('__sicht', rest) : '');
  }
  // Runde 118: die Liste wird ABGEGLICHEN statt neu geschrieben. Vorher bekam
  // bei jeder Aenderung (Abgleich mit dem Konto, Buchung, Suche) jede Karte ein
  // neues Element — und damit ihren Auftritt noch einmal: alle Karten blendeten
  // aus und glitten wieder herein ("die Gutscheine springen rum"). Jetzt bleibt
  // stehen, was gleich ist; Geaendertes wird still ersetzt, Neues blendet ein,
  // Wegfallendes aus, und was seinen Platz wechselt, gleitet dorthin.
  const liste = $('#voucher-list');
  const ansicht = $('#view-wallet');
  const faechert = renderWallet.faechert, stapelt = renderWallet.stapelt;
  renderWallet.faechert = renderWallet.stapelt = null;
  if (renderWallet.letzteListe !== voucherHtml || !liste.firstElementChild) {
    listeAngleichen(liste, voucherHtml, {
      // Nur, wenn man die Liste gerade sieht — nicht hinter der Sperre, nicht
      // waehrend die Ansicht selbst hereinkommt, nicht beim allerersten Aufbau
      bewegt: !!renderWallet.letzteListe && state.activeView === 'wallet' && walletTab === 'gutscheine'
        && !walletGesperrt() && document.visibilityState === 'visible' && !/\benter-/.test(ansicht?.className || '')
        && !wseiten().length,   // unter einer offenen Seite sieht es niemand
      herkunft: faechert ? (e => (e.dataset.stapel === faechert.key ? faechert.rect : null)) : null,
      ziel: stapelt ? (e => (e.dataset.stapel === stapelt ? liste.querySelector(`[data-deck="${CSS.escape(stapelt)}"]`)?.getBoundingClientRect() || null : null)) : null,
    });
    renderWallet.letzteListe = voucherHtml;
  }
  // Aufgebrauchte: nur die ersten 12 rendern, Rest auf Wunsch (nur bei Aenderung)
  const usedLim = walletDeckShown.__used || SICHT_SCHRITT;
  const usedHtml = (used.slice(0, usedLim).map(vCard).join('')
    + (used.length > usedLim ? moreBtn('__used', used.length - usedLim) : ''))
    || '<div class="status">Nichts aufgebraucht.</div>';
  if (renderWallet.letzteUsed !== usedHtml) { $('#voucher-used').innerHTML = usedHtml; renderWallet.letzteUsed = usedHtml; }
  $('#used-count').textContent = used.length ? `(${used.length})` : '';

  // Die Sparkarten selbst leben jetzt im Tab "Karten & Coupons" — dort steht
  // pro Marke Karte, App-Sprung und Coupon-Liste beieinander.

  passeFarbfeldAn();
  // Mini-Guthaben unten aktualisieren
  const mini = $('#wallet-mini-total');
  if (mini) mini.textContent = euroFmt(anzeige) || '0,00 €';
  // Die kleine Anzeige unten traegt dieselbe Rangfarbe wie der Kopf
  $('#wallet-mini')?.classList.add('rangfarbe');
  renderSyncBadge();

  // (Frueher bekam hier jede Karte bei jedem Aufruf eine CSS-Auftrittsanimation.
  // Die lief bei jedem Neuaufbau und jedem Reiterwechsel neu an — sichtbar als
  // Springen. Neue Karten blenden jetzt ueber listeAngleichen ein.)
  $('#view-wallet').querySelectorAll('[data-wv]').forEach(el => el.onclick = () => openVoucherSheet(el.dataset.wv));
  $('#view-wallet').querySelectorAll('[data-wv-mehr]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    if (walletGesperrt()) { aktualisiereSperre(); return; }
    oeffneVkMenue(b.dataset.wvMehr, b);
  });
  // Deck auf/zu + portionsweise nachladen (auch automatisch beim Scrollen)
  // Aufgefaechert wird sofort: die oberste Karte gleitet an ihren Platz, die
  // anderen kommen unter ihr aus dem Stapel hervor. Stapeln geht rueckwaerts.
  $('#view-wallet').querySelectorAll('[data-deck]').forEach(el => el.onclick = () => {
    walletDeckOpen.add(el.dataset.deck);
    buzz(12);
    renderWallet.faechert = { key: el.dataset.deck, rect: el.getBoundingClientRect() };
    renderWallet();
    // Die oberste Karte bleibt beim Auffaechern obenauf, die anderen kommen unter ihr hervor
    const oben = el.dataset.auch && $('#voucher-list').querySelector(`[data-wv="${CSS.escape(el.dataset.auch.slice(2))}"]`);
    if (oben && weich()) { oben.style.zIndex = '2'; setTimeout(() => { oben.style.zIndex = ''; }, 500); }
  });
  $('#view-wallet').querySelectorAll('[data-deck-close]').forEach(el => el.onclick = e => {
    e.stopPropagation();
    walletDeckOpen.delete(el.dataset.deckClose);
    delete walletDeckShown[el.dataset.deckClose];
    buzz(8);
    renderWallet.stapelt = el.dataset.deckClose;
    renderWallet();
  });
  $('#view-wallet').querySelectorAll('[data-deck-more]').forEach(el => {
    const key = el.dataset.deckMore;
    el.onclick = () => {
      if (key === '__flat') walletFlatShown += SICHT_SCHRITT;
      else if (key === '__used') walletDeckShown.__used = (walletDeckShown.__used || SICHT_SCHRITT) + SICHT_SCHRITT;
      else walletSicht += SICHT_SCHRITT;   // '__sicht' und alles andere
      renderWallet();
    };
    // Frueher hat der Knopf sich beim Runterscrollen selbst gedrueckt. Das war
    // gleich doppelt schlecht: die Liste wurde beim Scrollen staendig neu
    // aufgebaut (die Karten "verschwanden" kurz), und antippen liess er sich
    // gar nicht mehr — er hatte sich schon selbst ausgeloest und war ersetzt,
    // bevor der Finger ankam. Jetzt passiert nur etwas, wenn man ihn drueckt.
  });
  $('#view-wallet').querySelectorAll('[data-wc]').forEach(el => el.onclick = () => openCardSheet(el.dataset.wc));
  $('#view-wallet').querySelectorAll('[data-wadd]').forEach(el => el.onclick = () => openWalletAdd(el.dataset.wadd));
  $('#view-wallet').querySelectorAll('[data-wadd-prefill]').forEach(el => el.onclick = () => openWalletAdd('card', el.dataset.waddPrefill));
  // Offene Gutschein- und Analyse-Seiten ziehen mit
  wseitenAbgleichen();
  // ... und ein offenes Marken-Blatt (auf der Gutschein-Seite darueber gebucht,
  // verschenkt oder geloescht, oder ein anderes Geraet hat abgeglichen)
  markenBlattAbgleichen();
}

// Zuletzt verwendet: der Gutschein der letzten Abbuchung (nicht rueckgaengig
// gemacht), solange er noch Guthaben hat. Nicht waehrend einer Suche; mit
// Markenfilter nur, wenn er zu dieser Marke gehoert.
function zuletztVerwendet() {
  let best = null, bestTs = 0;
  for (const v of state.wallet.vouchers) {
    if (ohneGuthaben(v) || !(v.balance > 0)) continue;
    for (const t of v.tx || []) {
      const ts = Number(t && t.ts) || 0;
      if (t && t.amt < 0 && !t.reverted && ts > bestTs) { best = v; bestTs = ts; }
    }
  }
  return best ? { v: best, ts: bestTs } : null;
}
function renderZuletztVerwendet(q, fMarke) {
  const host = $('#zuletzt-verwendet');
  if (!host) return;
  const z = !q ? zuletztVerwendet() : null;
  const passt = z && (!fMarke || String(z.v.vendor || '').toLowerCase() === fMarke);
  // Kommt die Zeile dazu oder geht sie, waehrend man die Wallet sieht (erste
  // Abbuchung, Abgleich, Suche), blendet sie weich ein bzw. aus und die Liste
  // darunter gleitet mit — vorher sprang alles darunter um eine Zeile
  const sanft = !!renderWallet.letzteListe && state.activeView === 'wallet' && walletTab === 'gutscheine'
    && !walletGesperrt() && !wseiten().length;
  const zeigen = an => (sanft ? zeigeWeich(host, an, { bis: $('#wallet-content') }) : host.classList.toggle('hidden', !an));
  if (!passt) { zeigen(false); delete host.dataset.stand; return; }
  const { v, ts } = z;
  const tage = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 864e5);
  const wann = tage <= 0 ? 'heute' : tage === 1 ? 'gestern' : tage < 7 ? `vor ${tage} Tagen`
    : new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  const stand = [v.id, v.balance, wann].join('|');
  if (host.dataset.stand === stand) return;
  host.dataset.stand = stand;
  host.innerHTML = `
    <button class="zv-zeile" type="button" data-zv="${esc(v.id)}" aria-label="Zuletzt verwendet: ${esc(v.vendor)}, ${euroFmt(v.balance)} übrig. Öffnen">
      ${brandChipHtml(v.vendor)}
      <span class="zv-text"><small>Zuletzt verwendet · ${wann}</small><b>${esc(v.vendor)}</b></span>
      <span class="zv-betrag">${euroFmt(v.balance)}</span>
      ${icon('chevron', 'icon zv-pfeil')}
    </button>`;
  host.querySelector('[data-zv]').onclick = e => oeffneGutscheinSeite(e.currentTarget.dataset.zv);
  zeigen(true);
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

// Marken-Liste: jede Marke mit Anzahl und Restguthaben, "Alle Marken" oben
function schliesseMarkenMenue() {
  const menu = $('#wallet-marken-menue');
  if (!menu || menu.classList.contains('hidden') || menu._zu) return;
  $('#wallet-marke')?.setAttribute('aria-expanded', 'false');
  // Klappt weich zu (dieselbe Bewegung wie beim Aufgehen, rueckwaerts)
  if (!weich() || !menu.animate || state.activeView !== 'wallet') { menu.classList.add('hidden'); return; }
  menu._zu = true;
  const a = menu.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translate3d(0, -6px, 0) scale(.96)' }],
    { duration: 150, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
  const fertig = () => { if (!menu._zu) return; menu._zu = false; menu.classList.add('hidden'); a.cancel(); };
  a.onfinish = fertig;
  setTimeout(fertig, 320);
}
function oeffneMarkenMenue() {
  const menu = $('#wallet-marken-menue'), knopf = $('#wallet-marke');
  if (!menu || !knopf) return;
  if (!menu.classList.contains('hidden') && !menu._zu) return schliesseMarkenMenue();
  // Ging es gerade zu: das Zuklappen abbrechen und wieder aufmachen
  if (menu._zu) { menu._zu = false; menu.getAnimations().forEach(a => a.cancel()); menu.classList.add('hidden'); }
  const aktiv = state.wallet.vouchers.filter(v => !ohneGuthaben(v) && (v.balance == null || v.balance > 0));
  const proMarke = new Map();
  for (const v of aktiv) {
    const e = proMarke.get(v.vendor) || { n: 0, summe: 0 };
    e.n++; e.summe += v.balance || 0;
    proMarke.set(v.vendor, e);
  }
  const marken = [...proMarke.entries()].sort((x, y) => y[1].summe - x[1].summe || x[0].localeCompare(y[0], 'de'));
  const f = (state.walletFilter && state.walletFilter !== 'alle' ? state.walletFilter : '').toLowerCase();
  const gesamt = Math.round(aktiv.reduce((x, v) => x + (v.balance || 0), 0) * 100) / 100;
  menu.innerHTML = `
    <button class="mm-zeile${!f ? ' an' : ''}" type="button" role="option" aria-selected="${!f}" data-marke="">
      <span class="mm-alle">${icon('list', 'icon icon-sm')}</span>
      <span class="mm-name">Alle Marken</span>
      <small>${aktiv.length} · ${euroFmt(gesamt)}</small>
      ${icon('check', 'icon icon-sm mm-haken')}
    </button>
    ${marken.map(([name, e], i) => `
    <button class="mm-zeile${f === name.toLowerCase() ? ' an' : ''}" type="button" role="option" aria-selected="${f === name.toLowerCase()}"
      data-marke="${esc(name)}" style="--i:${Math.min(i + 1, 12)}">
      ${brandChipHtml(name)}
      <span class="mm-name">${esc(name)}</span>
      <small>${e.n} · ${euroFmt(Math.round(e.summe * 100) / 100)}</small>
      ${icon('check', 'icon icon-sm mm-haken')}
    </button>`).join('')}`;
  menu.classList.remove('hidden');
  knopf.setAttribute('aria-expanded', 'true');
  menu.scrollTop = 0;
  menu.querySelectorAll('[data-marke]').forEach(b => b.onclick = () => {
    state.walletFilter = b.dataset.marke;
    state.walletVal = 0;
    saveWalletFilter();
    restack();          // anderer Filter = frischer Blick, alles wieder gestapelt
    schliesseMarkenMenue();
    buzz(8);
    renderWallet();
  });
}
$('#wallet-marke')?.addEventListener('click', e => { e.stopPropagation(); oeffneMarkenMenue(); });
// Antippen daneben schliesst — pointerdown in der Capture-Phase, damit weder
// stopPropagation anderer Knoepfe noch iOS (kein click auf Flaechen) es schlucken
document.addEventListener('pointerdown', e => {
  if (!e.target.closest?.('#wallet-marken-menue') && !e.target.closest?.('#wallet-marke')) schliesseMarkenMenue();
}, { capture: true, passive: true });
addEventListener('keydown', e => {
  if (e.key !== 'Escape' || $('#wallet-marken-menue')?.classList.contains('hidden') !== false) return;
  if (state.sheetMode || document.querySelector('.overlay:not(.hidden)')) { schliesseMarkenMenue(); return; }
  e.stopPropagation();
  schliesseMarkenMenue();
  $('#wallet-marke')?.focus({ preventScroll: true });
}, true);

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
  restack();
  document.querySelectorAll('[data-wtab]').forEach(x => x.classList.toggle('active', x === b));
  updateWalletTab(true);
}));
// Hinzufügen ganz oben, ohne Scrollen
$('#wallet-add-top')?.addEventListener('click', () => openWalletAdd('voucher'));

// ---- Zahlen fuer die Analyse: rein und raus je Zeitraum (Monat/Jahr/Gesamt)
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
  const zahl = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
  state.wallet.vouchers.forEach(v => {
    if (ohneGuthaben(v)) return;
    if (v.amount != null && inRange(v.added)) added += zahl(v.amount);
    (v.tx || []).forEach(t => {
      if (t.reverted || !inRange(t.ts)) return;
      const a = zahl(t.amt);
      if (a > 0) added += a; else spent += -a;
    });
  });
  // Aufgeraeumte Gutscheine: ihre Summen hat das Konto pro Monat aufbewahrt
  for (const [monat, e] of Object.entries(state.wallet.statistik || {})) {
    const [j, m] = monat.split('-').map(Number);
    if (!j || !m || !inRange(new Date(j, m - 1, 15).getTime())) continue;
    added += zahl(e.rein); spent += zahl(e.raus);
  }
  return { added: Math.round(added * 100) / 100, spent: Math.round(spent * 100) / 100 };
}
// Monatsverlauf: was kam rein, was ging raus. Reine Zahlen aus der Wallet,
// nichts geschaetzt — Monate ohne Bewegung bleiben leer.
function walletVerlauf(monate = 6) {
  const jetzt = new Date();
  const felder = [];
  for (let i = monate - 1; i >= 0; i--) {
    const d = new Date(jetzt.getFullYear(), jetzt.getMonth() - i, 1);
    felder.push({ jahr: d.getFullYear(), monat: d.getMonth(), rein: 0, raus: 0,
      label: d.toLocaleDateString('de-DE', { month: 'short' }) });
  }
  const treffer = ts => {
    if (!ts) return null;
    const d = new Date(ts);
    return felder.find(f => f.jahr === d.getFullYear() && f.monat === d.getMonth()) || null;
  };
  const zahl = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
  state.wallet.vouchers.forEach(v => {
    if (ohneGuthaben(v)) return;
    if (v.amount != null) { const f = treffer(v.added); if (f) f.rein += zahl(v.amount); }
    (v.tx || []).forEach(t => {
      if (t.reverted) return;
      const f = treffer(t.ts);
      if (!f) return;
      const a = zahl(t.amt);
      if (a > 0) f.rein += a; else f.raus += -a;
    });
  });
  for (const [monat, e] of Object.entries(state.wallet.statistik || {})) {
    const [j, m] = monat.split('-').map(Number);
    const f = felder.find(x => x.jahr === j && x.monat === m - 1);
    if (f) { f.rein += zahl(e.rein); f.raus += zahl(e.raus); }
  }
  return felder;
}

// ---- Analyse als eigene Seite (frueher drehte sich dafuer die Karte im Kopf,
// das ruckelte). Oben der Zeitraum, darunter rein und raus, der Verlauf der
// Monate und das Guthaben nach Marke. Alles reine Zahlen aus der Wallet.
function oeffneAnalyse() {
  if (walletGesperrt()) { aktualisiereSperre(); return; } // gesperrte Wallet: nichts zeigen
  if (!state.token) return;
  buzz(10);
  wseiteOeffnen({ art: 'analyse', titel: 'Analyse', klasse: 'ana', baue: s => zeichneAnalyse(s) });
}
const ANA_BEREICHE = [['monat', 'Monat'], ['jahr', 'Jahr'], ['gesamt', 'Gesamt']];
// Wie viele Monate zeigt der Verlauf? Monat: das letzte halbe Jahr, Jahr: das
// laufende Jahr bis heute, Gesamt: die letzten zwoelf Monate
function anaMonate(bereich) {
  return bereich === 'jahr' ? new Date().getMonth() + 1 : bereich === 'gesamt' ? 12 : 6;
}
function anaPeriode(bereich) {
  const jetzt = new Date();
  if (bereich === 'monat') return jetzt.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  if (bereich === 'jahr') return `Seit Januar ${jetzt.getFullYear()}`;
  return 'Seit du kumulio nutzt';
}
function anaMonatText(f) {
  return new Date(f.jahr, f.monat, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
}
function anaDiagrammHtml(felder, gewaehlt, bereich) {
  const max = Math.max(1, ...felder.map(f => Math.max(f.rein, f.raus)));
  const jetzt = new Date();
  const hoehe = x => (x > 0 ? Math.max(3, Math.round((x / max) * 100)) : 0);
  return `<div class="ana-balken" style="--n:${felder.length}">${felder.map((f, i) => {
    const imZeitraum = bereich === 'monat' ? f.jahr === jetzt.getFullYear() && f.monat === jetzt.getMonth() : true;
    return `
    <button class="ana-monat${i === gewaehlt ? ' an' : ''}${imZeitraum ? '' : ' blass'}" type="button" data-monat="${i}"
      aria-pressed="${i === gewaehlt}" aria-label="${esc(anaMonatText(f))}: ${euroFmt(f.rein) || '0,00 €'} rein, ${euroFmt(f.raus) || '0,00 €'} raus">
      <span class="ana-paar">
        <i class="rein" style="height:${hoehe(f.rein)}%"></i><i class="raus" style="height:${hoehe(f.raus)}%"></i>
      </span>
      <small>${esc(f.label.replace('.', ''))}</small>
    </button>`;
  }).join('')}</div>`;
}
function anaAuswahlHtml(f) {
  if (!f) return '';
  return f.rein || f.raus
    ? `<b>${esc(anaMonatText(f))}</b><span class="ana-plus">+${euroFmt(f.rein) || '0,00 €'}</span><span class="ana-minus">−${euroFmt(f.raus) || '0,00 €'}</span>`
    : `<b>${esc(anaMonatText(f))}</b><span>keine Bewegung</span>`;
}
function anaMarkenHtml() {
  const aktiv = state.wallet.vouchers.filter(v => !ohneGuthaben(v) && v.balance != null && v.balance > 0);
  if (!aktiv.length) return '';
  const pro = new Map();
  for (const v of aktiv) {
    const e = pro.get(v.vendor) || { n: 0, summe: 0 };
    e.n++; e.summe += v.balance;
    pro.set(v.vendor, e);
  }
  const marken = [...pro.entries()].sort((a, b) => b[1].summe - a[1].summe || a[0].localeCompare(b[0], 'de'));
  const gesamt = Math.round(aktiv.reduce((x, v) => x + v.balance, 0) * 100) / 100;
  const max = marken[0][1].summe || 1;
  const zeig = marken.slice(0, 6);
  const rest = marken.slice(6);
  return `
    <section class="ana-karte">
      <div class="ana-karte-kopf"><h3>Guthaben nach Marke</h3><span class="ana-summe">${euroFmt(gesamt)}</span></div>
      <div class="ana-marken">${zeig.map(([name, e]) => `
        <div class="ana-marke">
          ${brandChipHtml(name)}
          <span class="ana-marke-text"><b>${esc(name)}</b><small>${e.n} Gutschein${e.n === 1 ? '' : 'e'}</small></span>
          <b class="ana-marke-betrag">${euroFmt(Math.round(e.summe * 100) / 100)}</b>
          <span class="ana-marke-balken" aria-hidden="true"><i style="--bc:${brandColor(name)}; transform:scaleX(${(e.summe / max).toFixed(4)})"></i></span>
        </div>`).join('')}
      </div>
      ${rest.length ? `<p class="ana-fussnote">Dazu ${rest.length} weitere Marke${rest.length === 1 ? '' : 'n'} mit zusammen ${euroFmt(Math.round(rest.reduce((x, [, e]) => x + e.summe, 0) * 100) / 100)}.</p>` : ''}
    </section>`;
}
function zeichneAnalyse(seite, { nurWennNeu = false, richtung = null } = {}) {
  const bereich = zeichneAnalyse.bereich || 'monat';
  const s = walletStats(bereich);
  const felder = walletVerlauf(anaMonate(bereich));
  const marken = anaMarkenHtml();
  const hatAufgeraeumt = Object.keys(state.wallet.statistik || {}).length > 0;
  const stand = JSON.stringify([bereich, s, felder.map(f => [f.rein, f.raus]), marken]);
  if (nurWennNeu && seite.stand === stand) return;
  const vorher = seite.zahlen;
  seite.stand = stand;
  seite.zahlen = s;
  if (seite.gewaehlt == null || seite.gewaehlt >= felder.length) seite.gewaehlt = felder.length - 1;
  const idx = ANA_BEREICHE.findIndex(([k]) => k === bereich);
  const inhalt = seite.el.querySelector('.wseite-inhalt');
  // Der Zeitraum-Schalter bleibt stehen (Runde 118): vorher wurde 200 ms nach
  // dem Antippen die ganze Seite neu geschrieben — samt Schalter, dessen Flaeche
  // dabei mitten im Gleiten an ihr Ziel sprang. Jetzt gleitet sie durch, und nur
  // der Teil darunter wechselt: er blendet aus und gleitet aus der Richtung des
  // neuen Zeitraums herein.
  let koerper = inhalt.querySelector('.ana-koerper');
  if (!koerper) {
    inhalt.innerHTML = `
    <div class="ana-zeitraum" role="tablist" aria-label="Zeitraum" data-kein-wisch>
      <span class="ana-flaeche" aria-hidden="true"></span>
      ${ANA_BEREICHE.map(([k, t]) => `<button class="ana-tab" type="button" role="tab" data-bereich="${k}">${t}</button>`).join('')}
    </div>
    <div class="ana-koerper"></div>`;
    koerper = inhalt.querySelector('.ana-koerper');
    inhalt.querySelectorAll('[data-bereich]').forEach(b => b.onclick = () => {
      const alt = zeichneAnalyse.bereich || 'monat';
      if (b.dataset.bereich === alt) return;
      zeichneAnalyse.bereich = b.dataset.bereich;
      seite.gewaehlt = null;
      buzz(6);
      const von = ANA_BEREICHE.findIndex(([k]) => k === alt), nach = ANA_BEREICHE.findIndex(([k]) => k === b.dataset.bereich);
      zeichneAnalyse(seite, { richtung: Math.sign(nach - von) });
    });
  }
  const schalter = inhalt.querySelector('.ana-zeitraum');
  schalter.style.setProperty('--i', idx);
  schalter.querySelectorAll('.ana-tab').forEach(b => {
    const an = b.dataset.bereich === bereich;
    b.classList.toggle('an', an);
    b.setAttribute('aria-selected', String(an));
  });
  const html = `
    <p class="ana-periode">${esc(anaPeriode(bereich))}</p>
    <div class="ana-kacheln">
      <div class="ana-kachel"><span class="ana-kachel-kopf"><i class="ana-punkt rein"></i>Aufgeladen</span>
        <b id="ana-rein">${euroFmt(s.added) || '0,00 €'}</b></div>
      <div class="ana-kachel"><span class="ana-kachel-kopf"><i class="ana-punkt raus"></i>Ausgegeben</span>
        <b id="ana-raus">${euroFmt(s.spent) || '0,00 €'}</b></div>
    </div>
    <section class="ana-karte">
      <div class="ana-karte-kopf"><h3>Verlauf</h3>
        <span class="ana-legende"><i class="ana-punkt rein"></i>rein<i class="ana-punkt raus"></i>raus</span></div>
      ${felder.some(f => f.rein || f.raus)
        ? `<div class="ana-diagramm">${anaDiagrammHtml(felder, seite.gewaehlt, bereich)}</div>
           <p class="ana-auswahl">${anaAuswahlHtml(felder[seite.gewaehlt])}</p>`
        : '<p class="ana-leer">Noch keine Bewegungen — buch etwas ab, dann füllt sich der Verlauf.</p>'}
    </section>
    ${marken}
    ${hatAufgeraeumt ? '<p class="ana-fussnote">Aufgeräumte Gutscheine zählen mit ihren Buchungen weiter mit.</p>' : ''}`;
  const fuellen = () => {
    // Im Hintergrund (Abgleich) nur angleichen: nichts blinkt, Balken bleiben stehen
    if (nurWennNeu) inhaltAngleichen(koerper, html);
    else koerper.innerHTML = html;
    // Beim Zeitraumwechsel zaehlen die Summen vom alten Stand aus
    if (vorher && !nurWennNeu) {
      animateNumber(koerper.querySelector('#ana-rein'), vorher.added, s.added, 500);
      animateNumber(koerper.querySelector('#ana-raus'), vorher.spent, s.spent, 500);
    }
    koerper.querySelectorAll('[data-monat]').forEach(b => b.onclick = () => {
      const war = seite.gewaehlt;
      seite.gewaehlt = Number(b.dataset.monat);
      if (war === seite.gewaehlt) return;
      koerper.querySelectorAll('.ana-monat').forEach(x => {
        const an = x === b;
        x.classList.toggle('an', an);
        x.setAttribute('aria-pressed', String(an));
      });
      // Die Zeile darunter gleitet aus der Richtung des gewaehlten Monats
      const aus = koerper.querySelector('.ana-auswahl');
      const f = felder[seite.gewaehlt];
      if (aus) tauscheWeich(aus, () => { aus.innerHTML = anaAuswahlHtml(f); }, { richtung: Math.sign(seite.gewaehlt - war) });
      buzz(4);
    });
  };
  if (richtung != null) tauscheWeich(koerper, fuellen, { richtung });
  else fuellen();
}

// Alle Stufen auf einen Blick — als eigene Seite (Pfeil oder Wisch zurueck)
$('#wallet-rank')?.addEventListener('click', e => { e.stopPropagation(); zeigeRang(); });
// Spanne einer Stufe in ganzen Euro, so wie man sie sagt: "über 10 bis 50 €"
function rangSpanne(r) {
  const davor = RANKS[r.tier - 2];
  if (!davor) return `0 bis ${r.bis} €`;
  return r.bis === Infinity ? `über ${davor.bis} €` : `über ${davor.bis} bis ${r.bis} €`;
}
function zeigeRang() {
  if (!state.token) return;
  // Gesperrt: der Rang verraet das Guthaben — erst entsperren (Face ID oder
  // PIN), dann geht die Seite auf
  if (walletGesperrt()) { walletFreigeben().then(ok => { if (ok) zeigeRang(); }); return; }
  if (wseiteOben()?.art === 'rang') return;
  buzz(8);
  wseiteOeffnen({ art: 'rang', titel: 'Ränge', klasse: 'rs', baue: s => zeichneRangSeite(s) });
}
// Rang-Seite: oben das Rang-Fenster mit dem Maskottchen, darunter alle sieben
// Stufen mit ihrer ganzen Figur in der Stufenfarbe. Erreichte stehen normal da,
// die eigene traegt "Du", die noch offenen sind blass und grau — mit dem
// ehrlichen Abstand vom jetzigen Guthaben.
// Jede Stufe laesst sich antippen: oben steht sie dann als Vorschau (Farbe,
// Maskottchen, Name, Abstand), ihre Zeile traegt den Ring. Zurueck zum eigenen
// Rang: die gezeigte Zeile nochmal, die eigene Zeile oder "Zurück zu deinem
// Rang". Auf der Karte blaettert ein Wisch nach links/rechts durch die Stufen.
// seite.zeigt = die Stufe, die oben steht (bleibt beim Abgleich erhalten)
function rangSeitenStand() { const t = rangGuthaben(); return `${rankFor(t).tier}|${t}`; }
function zeichneRangSeite(seite) {
  if (walletGesperrt()) return;
  const total = rangGuthaben();
  const jetzt = rankFor(total);
  seite.stand = rangSeitenStand();
  // Die eigene Stufe immer aus rankFor (nur sie kennt die naechste Stufe)
  const zeigt = (seite.zeigt !== jetzt.tier && RANKS.find(r => r.tier === seite.zeigt)) || jetzt;
  seite.zeigt = zeigt.tier;
  const bild = r => `/brand/kumulio-rang-${r.slug}`;
  const zeilen = RANKS.map(r => {
    const art = r.tier < jetzt.tier ? 'erreicht' : r.tier === jetzt.tier ? 'aktuell' : 'offen';
    const rechts = art === 'aktuell' ? '<span class="rs-du">Du</span>'
      : art === 'erreicht' ? `<span class="rs-haken" role="img" aria-label="erreicht">${icon('check', 'icon')}</span>`
      : `<span class="rs-noch">noch ${euroFmt(r.min - total)}</span>`;
    const an = r.tier === zeigt.tier;
    return `
      <li><button class="rs-stufe ${art}${an ? ' gewaehlt' : ''}" type="button" data-stufe="${r.tier}" aria-pressed="${an}"${art === 'aktuell' ? ' aria-current="true"' : ''}>
        <span class="rs-bild"><img src="${bild(r)}-240.webp" srcset="${bild(r)}-240.webp 240w, ${bild(r)}-480.webp 480w"
          sizes="72px" width="72" height="72" alt="" loading="lazy" decoding="async" draggable="false"></span>
        <span class="rs-text"><b>${esc(r.name)}</b><small>${rangSpanne(r)}</small></span>
        ${rechts}
      </button></li>`;
  }).join('');
  const eigene = zeigt === jetzt;
  const inhalt = seite.el.querySelector('.wseite-inhalt');
  // Beim Neuzeichnen (Abgleich) kommt das Maskottchen nicht noch einmal herein
  inhalt.innerHTML = `
    <div class="rs-oben${seite.gebaut ? ' ruhig' : ''}" data-kein-wisch="rand" aria-live="polite">${rangFensterHtml({ r: zeigt, total, eigen: jetzt })}</div>
    <div class="rs-h-zeile">
      <h3 class="gd-h rs-h">Alle Ränge</h3>
      <button class="rs-zurueck${eigene ? '' : ' an'}" type="button" data-stufe="${jetzt.tier}"${eigene ? ' inert' : ''}>${icon('arrow-back', 'icon')}Zurück zu deinem Rang</button>
    </div>
    <ol class="rs-liste" aria-label="Alle Ränge">${zeilen}</ol>
    <p class="rang-hinweis rs-hinweis">${icon('lock', 'icon icon-sm')}<span>Nur du siehst deinen Rang. Er richtet sich nach dem Guthaben in deiner Wallet und ändert nichts an Gutscheinen oder Coupons.</span></p>`;
  seite.gebaut = true;
  const eigenerRang = () => rankFor(rangGuthaben()).tier;
  inhalt.querySelector('.rs-liste').addEventListener('click', e => {
    const b = e.target.closest('.rs-stufe');
    if (!b) return;
    const t = +b.dataset.stufe;
    // Die gezeigte Vorschau nochmal antippen: zurueck zum eigenen Rang
    rangVorschau(seite, t === seite.zeigt ? eigenerRang() : t, { hinsehen: true });
  });
  inhalt.querySelector('.rs-zurueck').addEventListener('click', () => rangVorschau(seite, eigenerRang()));
  rfHoeheAngleichen(inhalt.querySelector('.rs-oben'));
  rangKarteWisch(seite, inhalt.querySelector('.rs-oben'));
  rangBilderVorladen();
}
// Alle sieben Karten gleich hoch (--rf-h, look-blaetter.css): die eigene hat
// den laengeren Abstand ("Noch 200,01 € bis Legende") und bricht schon bei
// 390 px um — ohne Angleich waere sie hoeher als die Vorschauen, und die
// Liste darunter spraenge beim Blaettern. Gemessen an unsichtbaren Abzuegen
// ohne Bild (die Figur liegt absolut und zaehlt nicht zur Hoehe).
function rfHoeheAngleichen(host) {
  if (!host?.isConnected || !host.clientWidth) return;
  host._rfB = host.clientWidth;
  const probe = document.createElement('div');
  probe.className = 'rs-mass';
  probe.setAttribute('aria-hidden', 'true');
  probe.innerHTML = RANKS.map(r => rangFensterFuer(r.tier).replace(/<img[^>]*>/g, '')).join('');
  host.appendChild(probe);
  const h = Math.max(...[...probe.children].map(k => k.offsetHeight));
  probe.remove();
  if (h > 0) host.style.setProperty('--rf-h', h + 'px');
}
// Handy gedreht (neue Breite): neu messen
addEventListener('resize', () => {
  const host = wseiten().find(s => s.art === 'rang')?.el.querySelector('.rs-oben');
  if (host && host._rfB !== host.clientWidth) rfHoeheAngleichen(host);
});

// Eine Stufe oben zeigen (Vorschau, oder wieder die eigene). richtung: aus
// welcher Seite die neue Karte kommt (1 von rechts, -1 von links). karte:
// false, wenn der Wisch die Karte schon selbst hereinzieht (nur Liste/Pille)
function rangVorschau(seite, tier, { richtung = null, hinsehen = false, karte = true } = {}) {
  if (walletGesperrt() || !seite?.el.isConnected) return false;
  const inhalt = seite.el.querySelector('.wseite-inhalt');
  const oben = inhalt?.querySelector('.rs-oben');
  const total = rangGuthaben();
  const jetzt = rankFor(total);
  // Die eigene Stufe aus rankFor: nur sie kennt die naechste (Balken, Abstand)
  const r = tier === jetzt.tier ? jetzt : RANKS.find(x => x.tier === tier);
  if (!oben || !r || r.tier === seite.zeigt) return false;
  const dir = richtung ?? Math.sign(r.tier - seite.zeigt);
  seite.zeigt = r.tier;
  let ziel = null;
  inhalt.querySelectorAll('.rs-stufe').forEach(b => {
    const an = +b.dataset.stufe === r.tier;
    b.classList.toggle('gewaehlt', an);
    b.setAttribute('aria-pressed', String(an));
    if (+b.dataset.stufe === jetzt.tier) ziel = b;
  });
  const zurueck = inhalt.querySelector('.rs-zurueck');
  if (zurueck) {
    const an = r.tier !== jetzt.tier;
    // Hatte der Knopf den Fokus, geht er an die eigene Zeile (nicht ins Leere)
    if (!an && document.activeElement === zurueck) ziel?.focus({ preventScroll: true });
    zurueck.classList.toggle('an', an);
    zurueck.inert = !an;
  }
  if (karte) rfTauschen(oben, rangFensterHtml({ r, total, eigen: jetzt }), dir);
  buzz(4);
  // Weit unten angetippt: die Karte kommt ins Bild, sonst sieht man nichts
  if (hinsehen) {
    const k = oben.querySelector('.rf')?.getBoundingClientRect(), f = inhalt.getBoundingClientRect();
    if (k && k.top < f.top) inhalt.scrollTo({ top: 0, behavior: weich() ? 'smooth' : 'auto' });
  }
  return true;
}

// Rang-Fenster wechseln wie ein Karussell: die Karten liegen nebeneinander
// (Abstand = Seitenrand), die alte gleitet hinaus, die neue herein — beide
// voll deckend, bewegt wird nur transform. (Ueberblenden mischte die Farben,
// etwa Blau und Orange, kurz zu einem trueben Grau.) Die Seite schneidet
// waagerecht am Bildschirmrand ab (.rs .wseite-inhalt, overflow-x: hidden).
const RF_LUECKE = 16;
function rfKarte(html) {
  const box = document.createElement('div');
  box.innerHTML = html.trim();
  return box.firstElementChild;
}
// Rang-Fenster fuer eine Stufe (die eigene aus rankFor: nur sie kennt die naechste)
function rangFensterFuer(tier) {
  const total = rangGuthaben();
  const jetzt = rankFor(total);
  return rangFensterHtml({ r: tier === jetzt.tier ? jetzt : RANKS[tier - 1], total, eigen: jetzt });
}
const rfJetzt = host => host.querySelector('.rf:not(.rf-neben)');
function rfSchritt(host) { return (rfJetzt(host)?.offsetWidth || host.clientWidth) + RF_LUECKE; }
// Karte deckungsgleich neben die jetzige legen (absolut), um x verschoben.
// still: noch nicht vorlesen (Nachbar beim Ziehen, vielleicht kommt er nicht)
function rfDaneben(host, neu, x, still = false) {
  const alt = rfJetzt(host);
  neu.classList.add('rf-neben');
  neu.style.top = alt.offsetTop + 'px';
  neu.style.left = alt.offsetLeft + 'px';
  neu.style.width = alt.offsetWidth + 'px';
  neu.style.transform = `translate3d(${x}px, 0, 0)`;
  if (still) neu.setAttribute('aria-hidden', 'true');
  host.appendChild(neu);
  return neu;
}
// Waagerechte Lage einer Karte, wie sie gerade gezeichnet wird (samt Bewegung)
function rfLage(el) {
  try { return new DOMMatrixReadOnly(getComputedStyle(el).transform).m41 || 0; } catch { return 0; }  // alter Browser
}
// Laufenden Wechsel sofort abschliessen; liefert, wo die neue Karte gerade
// stand — von dort geht der naechste Wechsel weiter (schnelle Tipps). Federt
// die Karte nach einem zu kurzen Wisch noch zurueck, wird auch das beendet:
// sonst liefe die Feder weiter, waehrend der Finger schon wieder zieht, und
// Karte und Nachbar liefen auseinander.
function rfFertig(host) {
  let x = 0;
  if (host._rfEnde) {
    const neu = host.querySelector('.rf.rf-neben');
    x = neu ? rfLage(neu) : 0;
    host._rfEnde();
  }
  const karte = rfJetzt(host), feder = karte?.getAnimations?.() || [];
  if (feder.length) {
    x += rfLage(karte);
    feder.forEach(a => a.cancel());
  }
  return x;
}
// alt gleitet von altX aus hinaus, neu (liegt schon daneben) folgt im festen
// Abstand an ihren Platz. Danach ist neu die Karte im Fluss, alt ist weg.
function rfGleiten(host, alt, neu, dir, altX, dauer) {
  const b = rfSchritt(host);
  const kurve = 'cubic-bezier(.22, 1, .36, 1)';
  alt.style.transform = '';
  neu.style.transform = '';
  neu.removeAttribute('aria-hidden');
  alt.setAttribute('aria-hidden', 'true');
  alt.animate([{ transform: `translate3d(${altX}px, 0, 0)` }, { transform: `translate3d(${altX - dir * b}px, 0, 0)` }],
    { duration: dauer, easing: kurve, fill: 'forwards' });
  const rein = neu.animate([{ transform: `translate3d(${altX + dir * b}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
    { duration: dauer, easing: kurve, fill: 'forwards' });
  let fertig = false;
  const ende = () => {
    if (fertig) return;
    fertig = true;
    if (host._rfEnde === ende) host._rfEnde = null;
    alt.remove();
    rein.cancel();
    neu.classList.remove('rf-neben');
    ['top', 'left', 'width', 'transform'].forEach(p => neu.style.removeProperty(p));
  };
  host._rfEnde = ende;
  rein.onfinish = ende;
  setTimeout(ende, dauer + 120);   // falls onfinish ausbleibt (Tab im Hintergrund)
}
// Nach Antippen (Liste, Pille): erst das Bild dekodieren (die sieben sind beim
// Oeffnen vorgeladen) — so gleitet keine leere Karte herein
function rfTauschen(host, html, dir) {
  const lauf = (host._rfLauf || 0) + 1;
  host._rfLauf = lauf;
  host._rfWartet = true;
  const neu = rfKarte(html);
  const bild = neu.querySelector('.rf-sprite');
  const los = () => {
    if (host._rfLauf !== lauf || !host.isConnected) return;
    host._rfWartet = false;
    host.classList.add('ruhig');   // kein erneuter Auftritt per CSS
    const x = rfFertig(host);
    host.querySelectorAll('.rf.rf-neben').forEach(n => n.remove());
    const alt = rfJetzt(host);
    if (!alt) { host.appendChild(neu); return; }
    if (!weich() || !alt.animate) { alt.replaceWith(neu); return; }
    rfDaneben(host, neu, x + dir * rfSchritt(host));
    rfGleiten(host, alt, neu, dir, x, 460);
  };
  if (!bild?.decode) return los();
  // Hoechstens kurz warten: lieber ein spaetes Bild als ein haengender Tipp
  Promise.race([bild.decode().catch(() => {}), new Promise(r => setTimeout(r, 260))]).then(los);
}

// Wisch auf der Karte: nach links die naechste Stufe, nach rechts die vorige.
// Die Karte folgt dem Finger, die naechste schaut von der Seite herein; am
// Ende der Liste gibt es keine, dann zieht sie zaeh und federt zurueck. Nur
// waagerecht — senkrecht scrollt die Seite; am linken Rand bleibt der Wisch
// zurueck der Seite (data-kein-wisch="rand", siehe wischZurueck).
function rangKarteWisch(seite, oben) {
  if (!oben) return;
  let w = null;
  const gibtEs = t => t >= 1 && t <= RANKS.length;
  const federn = 'cubic-bezier(.3, 1.25, .5, 1)';
  oben.addEventListener('pointerdown', e => {
    if (w && w.lauf) return;
    w = null;
    if (e.pointerType === 'mouse' || wseiteOben() !== seite || walletGesperrt() || oben._rfWartet) return;
    if (e.clientX - seite.el.getBoundingClientRect().left < WISCH_RAND) return;
    w = { x: e.clientX, y: e.clientY, id: e.pointerId, lauf: false, dx: 0, zx: 0, v: 0, lx: e.clientX, lt: e.timeStamp, nachbar: null };
  }, { passive: true });
  oben.addEventListener('pointermove', e => {
    if (!w || e.pointerId !== w.id) return;
    const dx = e.clientX - w.x, dy = e.clientY - w.y;
    if (!w.lauf) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { w = null; return; }
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
      w.lauf = true;
      try { oben.setPointerCapture(e.pointerId); } catch { /* synthetische Pointer */ }
      // Ein laufender Wechsel wird fertig, der Finger greift die neue Karte
      w.x0 = rfFertig(oben);
      oben.querySelectorAll('.rf.rf-neben').forEach(n => n.remove());
      oben.classList.add('ruhig');
    }
    const dt = e.timeStamp - w.lt;
    if (dt > 0) { w.v = (e.clientX - w.lx) / dt; w.lx = e.clientX; w.lt = e.timeStamp; }
    w.dx = dx;
    if (!weich()) return;
    const s = Math.sign(dx), ziel = seite.zeigt - s;
    // Nachbar in Zugrichtung: einmal gebaut, bei Richtungswechsel getauscht
    if (s && gibtEs(ziel)) {
      if (w.nachbar?.stufe !== ziel) {
        w.nachbar?.el.remove();
        w.nachbar = { stufe: ziel, el: rfDaneben(oben, rfKarte(rangFensterFuer(ziel)), -s * rfSchritt(oben), true) };
      }
    } else if (w.nachbar) { w.nachbar.el.remove(); w.nachbar = null; }
    const x = (w.x0 || 0) + (w.nachbar ? dx : s * Math.min(Math.abs(dx) * .22, 44));
    w.zx = x;
    const karte = rfJetzt(oben);
    if (karte) karte.style.transform = `translate3d(${x.toFixed(1)}px, 0, 0)`;
    if (w.nachbar) w.nachbar.el.style.transform = `translate3d(${(x - s * rfSchritt(oben)).toFixed(1)}px, 0, 0)`;
  });
  const ende = e => {
    if (!w || e.pointerId !== w.id) return;
    const war = w;
    w = null;
    if (!war.lauf) return;
    const s = Math.sign(war.dx), ziel = seite.zeigt - s;
    const weit = Math.abs(war.dx) > 64 || (Math.abs(war.dx) > 18 && Math.abs(war.v) > .4 && Math.sign(war.v) === s);
    const karte = rfJetzt(oben);
    if (e.type !== 'pointercancel' && weit && gibtEs(ziel)) {
      const n = war.nachbar?.el;
      rangVorschau(seite, ziel, { richtung: -s, karte: !n });
      if (n && karte) rfGleiten(oben, karte, n, -s, war.zx, 340);
      return;
    }
    // Zu kurz, abgebrochen oder keine Stufe mehr: federt zurueck
    const x = war.zx || 0;
    if (karte) {
      karte.style.transform = '';
      if (x && weich() && karte.animate) karte.animate([{ transform: `translate3d(${x}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
        { duration: 380, easing: federn });
    }
    const n = war.nachbar?.el;
    if (n) {
      const b = rfSchritt(oben);
      n.style.transform = '';
      const a = n.animate([{ transform: `translate3d(${x - s * b}px, 0, 0)` }, { transform: `translate3d(${-s * b}px, 0, 0)` }],
        { duration: 380, easing: federn, fill: 'forwards' });
      a.onfinish = () => n.remove();
      setTimeout(() => n.remove(), 500);
    }
    if (weit && !gibtEs(ziel)) buzz(6);
  };
  oben.addEventListener('pointerup', ende);
  oben.addEventListener('pointercancel', ende);
  oben.addEventListener('lostpointercapture', e => { if (e.target === oben) ende(e); });
}

// Die sieben Maskottchen vorladen und dekodieren, sobald die Rang-Seite
// aufgeht — erst nach dem Hereinschieben, damit die Bewegung frei bleibt.
// Gleiche srcset/sizes wie im Rang-Fenster, damit der Browser dieselbe Datei
// waehlt. Die Bilder bleiben gemerkt (dekodiert im Speicher).
function rangBilderVorladen() {
  if (rangBilderVorladen.bilder) return;
  rangBilderVorladen.bilder = [];
  setTimeout(() => RANKS.forEach(r => {
    const m = WALLET_MASKOTTCHEN[r.slug];
    if (!m) return;
    const i = new Image();
    i.decoding = 'async';
    i.sizes = '312px';
    i.srcset = `${m.basis}-480.webp 480w, ${m.basis}-960.webp 960w`;
    i.src = `${m.basis}-480.webp`;
    i.decode?.().catch(() => { /* naechster Versuch beim Tausch */ });
    rangBilderVorladen.bilder.push(i);
  }), 420);
}

// Farbige Kopfzeile nur, solange der Kopf darunter noch steht. Sonst haengt
// oben ein Farbblock ohne Anschluss.
function pruefeKopfzeile() {
  const oben = window.scrollY < 90;
  // Frueher stand hier dieselbe 90 auch fuer die Kopfzeilenfarbe. Der Kopf
  // reicht aber rund 262 px weit — dazwischen lag die Leiste als Milchglas-
  // bzw. dunkles Rechteck ueber der vollen Farbe und endete mit einer harten
  // Linie. Das war der Balken, den man auf dem Handy oben immer sah.
  // Jetzt wird gemessen: die Leiste wird erst wieder Glas, wenn der Kopf
  // wirklich hinter ihr verschwunden ist. Die Kopfhoehe haengt an der
  // Safe-Area, am Tab und am Kartendreh — raten geht da nicht.
  const kopf = $('#wallet-kopf'), tb = document.querySelector('.topbar');
  const inWallet = state.activeView === 'wallet' && !!state.token;
  const kr = kopf?.getBoundingClientRect(), lr = tb?.getBoundingClientRect();
  const verdeckt = kr && lr ? kr.bottom <= lr.bottom + 1 : !oben;
  if (kr && lr) {
    // Wo endet die Leiste, vom oberen Rand des Kopfes aus gerechnet? Genau da
    // muss der Kopfinhalt verschwunden sein. Sobald der Kopf ganz hinter der
    // Leiste liegt, braucht es das nicht mehr — und genau dann wird lange
    // gescrollt, da soll nichts unnoetig neu gezeichnet werden.
    if (!verdeckt) kopf.style.setProperty('--kopf-maske', Math.round(lr.bottom - kr.top) + 'px');
    // Die Leiste wird beim Scrollen flacher. Wer das nicht nachmisst, rechnet
    // den Kopf mit der alten Hoehe — dann sitzt oben ein Streifen daneben.
    const h = Math.round(lr.height);
    if (h && h !== messeKopfzeile.zuletzt) {
      messeKopfzeile.zuletzt = h;
      document.documentElement.style.setProperty('--kopfzeile-h', h + 'px');
    }
  }
  const warWeg = document.body.classList.contains('kopf-weg');
  const istWeg = document.body.classList.toggle('kopf-weg',
    state.activeView === 'wallet' && (!inWallet || verdeckt));
  // Nur beim Wechsel, nicht bei jedem Scroll-Ereignis
  if (istWeg !== warWeg) setzeLeistenfarbe();
  // Das Mini-Guthaben erscheint im selben Moment: der grosse Betrag ist weg,
  // also braucht es unten einen Ersatz. Frueher entschied das ein
  // IntersectionObserver mit fester Schwelle — der meldete sich nicht mehr,
  // sobald der Kopf zwischendurch seine Hoehe geaendert hatte.
  $('#wallet-mini')?.classList.toggle('show',
    inWallet && walletTab === 'gutscheine' && verdeckt);
  // Gilt fuer jeden Tab: beim Scrollen ruecken Leiste und Logo zusammen
  document.body.classList.toggle('gescrollt', !oben);
}
addEventListener('scroll', pruefeKopfzeile, { passive: true });

// Die Kopfzeile ueberdeckt den oberen Teil des Verlaufs. Ihre echte Hoehe
// (inklusive Safe-Area) bestimmt, wo der Kopf den Verlauf fortsetzt.
function messeKopfzeile() {
  const tb = document.querySelector('.topbar');
  if (!tb) return;
  const h = Math.round(tb.getBoundingClientRect().height);
  messeKopfzeile.zuletzt = h;
  document.documentElement.style.setProperty('--kopfzeile-h', h + 'px');
  passeFarbfeldAn();
  // Setzt auch --kopf-maske, damit der Kopfinhalt von Anfang an weiss, wo die
  // Leiste endet — sonst greift die Aufloesung erst beim ersten Scrollen.
  pruefeKopfzeile();
}
// Das Farbfeld wird nicht mehr neu gezeichnet, sondern nur noch verschoben.
//
// Drei Werte steuern es (siehe style.css):
//   --ff-kopf    wo die weiche Kante anfaengt, gemessen am AUFGEKLAPPTEN Kopf
//   --ff-hoehe   Gesamthoehe, also --ff-kopf plus 300 px (die Maske ist nach
//                220 px leer, der Rest haelt nur den Farbverlauf gleich)
//   --ff-versatz wie weit die Flaeche gerade nach oben gefahren ist
// Die ersten beiden aendern sich nur bei einem Groessenwechsel, deshalb bleibt
// der 27-stufige Verlauf waehrend der Ueberblendung derselbe und muss nicht in
// jedem Bild neu erzeugt werden. Bewegt wird nur --ff-versatz, und das ist eine
// reine Verschiebung auf der Grafikkarte.
//
// Davor: Hoehe UND Maske hingen an einer animierten Laenge. Gemessen waren das
// rund 1,8 Millionen Geraetepixel Verlauf pro Bild auf einem Handy — der Grund
// fuer die niedrige Bildrate beim Umschalten.
let ffKopfMax = 0;
function passeFarbfeldAn(zielUnten, sofort = zielUnten === undefined) {
  const feld = $('#wallet-farbfeld');
  const kopf = $('#wallet-kopf');
  if (!feld || !kopf) return;
  if (state.activeView !== 'wallet' || !state.token) {
    feld.style.setProperty('--ff-versatz', '0px');
    return;
  }
  const unten = zielUnten ?? (kopf.getBoundingClientRect().bottom + window.scrollY);
  // Der aufgeklappte Kopf ist der Bezugspunkt. Er wird einmal gemessen und nur
  // dann neu, wenn er sich wirklich geaendert hat (Drehung, Groessenwechsel).
  // Wichtig: gleich beim ersten Mal den AUFGEKLAPPTEN Wert nehmen, auch wenn
  // man in der Coupon-Ansicht einsteigt — sonst waechst der Bezugspunkt beim
  // ersten Wechsel nach oben und die Flaeche springt einmal.
  if (!ffKopfMax) ffKopfMax = Math.round(kopfZielUnten(false));
  const max = Math.max(ffKopfMax, Math.round(unten));
  // Auch schreiben, wenn der Wert gleich bleibt, aber noch nie gesetzt wurde —
  // sonst rechnet das Feld mit der Vorgabe 0 und bleibt unsichtbar.
  if (max !== ffKopfMax || !feld.style.getPropertyValue('--ff-kopf')) {
    ffKopfMax = max;
    feld.style.setProperty('--ff-kopf', max + 'px');
    feld.style.setProperty('--ff-hoehe', (max + 300) + 'px');
  }
  const versatz = Math.max(0, ffKopfMax - Math.round(unten)) + 'px';
  // Nur beim Tabwechsel soll die Farbe fahren. Beim Betreten der Wallet, beim
  // Seitenwechsel oder nach einem Groessenwechsel soll sie einfach sitzen.
  if (sofort) {
    document.body.classList.add('misst');
    feld.style.setProperty('--ff-versatz', versatz);
    void feld.offsetHeight;
    document.body.classList.remove('misst');
  } else {
    feld.style.setProperty('--ff-versatz', versatz);
  }
}

// Wenn der Kopf hoeher wird (Analyse-Seite, Groessenwechsel), muss der
// Bezugspunkt neu gesetzt werden — sonst fiele der Auslauf mitten in den Kopf.
function setzeFarbfeldNeu() {
  ffKopfMax = 0;
  passeFarbfeldAn();
}
addEventListener('orientationchange', () => setTimeout(setzeFarbfeldNeu, 300));

// ---- Bildraten-Wache -------------------------------------------------------
// Ich kann kein fremdes Handy ausmessen — also misst es sich selbst. Bei den
// ersten Umschaltvorgaengen einer Sitzung werden die Bildabstaende
// aufgezeichnet. Sind zu viele Bilder zu lang, schaltet das Geraet dauerhaft in
// den sparsamen Modus: dann bewegt sich beim Umschalten gar nichts mehr, die
// Menueleiste verzichtet auf ihren Weichzeichner und die belebten Profilrahmen
// stehen still. Die Entscheidung faellt auf dem Geraet, nicht nach Gefuehl.
//
// Die Messung laesst sich ansehen: /?fps zeigt sie als kleine Anzeige.
// Runde 118: Frueher reichte EINE Messung mit vier etwas laengeren Bildern —
// auf vielen Handys fiel die Entscheidung so schon beim schweren Glas-Design
// und galt fuer immer. Jetzt: neuer Schluessel (alte Entscheidungen verfallen),
// die erste Messung nach dem Start zaehlt nicht, und es braucht zwei klar
// schlechte Messungen. "sparsam" stellt ausserdem nur noch die Dauer-Effekte
// ab (Strahlen, Funken, schwebende Logos) — Uebergaenge laufen weiter.
// Wer selbst entscheidet (Einstellungen → Animationen), ueberstimmt die Messung.
const SPARSAM = 'ra.sparsam2';
const ANIM_WAHL = 'ra.animationen';      // 'an' | 'aus' | fehlt = automatisch
let fpsProben = 0, fpsSchlecht = 0;
let letzteFps = null;
try {
  localStorage.removeItem('ra.sparsam'); localStorage.removeItem('ra.fps');
  letzteFps = JSON.parse(localStorage.getItem('ra.fps2') || 'null');
} catch { /* egal */ }
// Liest den Schluessel direkt: wird schon beim Aufbau der Einstellungen gebraucht,
// bevor ANIM_WAHL weiter unten steht
function animWahl() { try { return localStorage.getItem('ra.animationen') || ''; } catch { return ''; } }
function setzeAnimKlassen() {
  const wahl = animWahl();
  let sparsam = false;
  try { sparsam = localStorage.getItem(SPARSAM) === '1'; } catch { /* egal */ }
  document.body.classList.toggle('ohne-anim', wahl === 'aus');
  document.body.classList.toggle('sparsam', wahl === 'aus' || (wahl !== 'an' && sparsam));
}
setzeAnimKlassen();

function messeBildabstaende(dauer = 450) {
  return new Promise(fertig => {
    if (!window.requestAnimationFrame) return fertig(null);
    const t = [];
    let vor = performance.now();
    const bis = vor + dauer;
    const tick = () => {
      const jetzt = performance.now();
      t.push(jetzt - vor); vor = jetzt;
      if (jetzt < bis) requestAnimationFrame(tick); else fertig(t);
    };
    requestAnimationFrame(tick);
  });
}

function pruefeBildrate() {
  if (animWahl() || document.body.classList.contains('sparsam') || fpsProben >= 4) return;
  fpsProben++;
  // Der erste Wechsel nach dem Start baut Ansichten und dekodiert Bilder zum
  // ersten Mal — der sagt nichts ueber das Geraet
  if (fpsProben === 1) return;
  messeBildabstaende().then(t => {
    if (!t || t.length < 6) return;
    const sortiert = [...t].sort((a, b) => a - b);
    const median = sortiert[Math.floor(sortiert.length / 2)];
    const schnellstes = sortiert[0];
    // Als "lang" zaehlt ein Bild, das mehr als das Doppelte des schnellsten
    // Bildes gebraucht hat — so ist die Messung unabhaengig davon, ob der
    // Bildschirm mit 60, 90 oder 120 Hz laeuft.
    const lang = t.filter(x => x > Math.max(24, schnellstes * 2.2)).length;
    letzteFps = { median: +median.toFixed(1), schnellstes: +schnellstes.toFixed(1),
                  lang, bilder: t.length, zeit: Date.now() };
    try { lsSetzen('ra.fps2', JSON.stringify(letzteFps)); } catch { /* egal */ }
    zeigeFpsAnzeige();
    // Schlecht heisst: gut ein Drittel der Bilder deutlich zu lang
    if (lang >= Math.max(8, Math.ceil(t.length * .35))) fpsSchlecht++;
    if (fpsSchlecht >= 2 && !animWahl()) {
      try { lsSetzen(SPARSAM, '1'); } catch { /* egal */ }
      setzeAnimKlassen();
    }
  });
}

// Kleine Anzeige, nur mit /?fps in der Adresse — damit man die Messung des
// eigenen Geraets ablesen kann, statt sie zu erraten.
function zeigeFpsAnzeige() {
  if (!/[?&]fps\b/.test(location.search)) return;
  let el = $('#fps-anzeige');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fps-anzeige';
    document.body.appendChild(el);
    el.onclick = () => {
      try { localStorage.removeItem(SPARSAM); localStorage.removeItem('ra.fps2'); } catch { /* egal */ }
      setzeAnimKlassen();
      fpsProben = 0; fpsSchlecht = 0; letzteFps = null;
      el.textContent = 'zurueckgesetzt — nochmal umschalten';
    };
  }
  el.textContent = letzteFps
    ? `Umschalten: ${letzteFps.median} ms im Mittel, ${letzteFps.lang} lange Bilder von ${letzteFps.bilder}`
      + (document.body.classList.contains('sparsam') ? ' · sparsam an' : ' · normal')
    : 'einmal umschalten zum Messen';
}
addEventListener('load', () => setTimeout(zeigeFpsAnzeige, 800));

// Den Kopf auf- oder zuklappen — ohne Hoehenanimation.
//
// Die Hoehe faellt in EINEM Schritt (ein Layout statt eines pro Bild). Die
// Blenden macht updateWalletTab; hier gleitet nur der Schieber von seiner alten
// an die neue Stelle (FLIP, reine Verschiebung) und das Farbfeld faehrt mit.
function kopfUmschalten(zu, anim, kopfZiel) {
  const geld = $('#wallet-kopf-geld'), kopf = $('#wallet-kopf'), modes = $('#wallet-modes');
  if (!geld || !kopf) return;
  const warZu = geld.classList.contains('zu');
  const vorher = anim && warZu !== zu && modes?.animate ? modes.getBoundingClientRect().top : null;
  kopf.classList.toggle('nur-tabs', zu);
  geld.classList.toggle('zu', zu);
  passeFarbfeldAn(kopfZiel, vorher === null);
  if (vorher === null) return;
  const dy = Math.round(vorher - modes.getBoundingClientRect().top);
  if (!dy) return;
  const a = modes.animate([{ transform: `translate3d(0, ${dy}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
    { duration: 320, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  // Sicherheitsnetz: haelt die Umgebung Animationen an, bliebe er verschoben stehen
  setTimeout(() => a.cancel(), 420);
}

// Wo endet der Kopf, NACHDEM er auf- oder zugeklappt ist? Wir schalten kurz um,
// messen und schalten zurueck — alles innerhalb eines Bildes und mit
// abgeschalteten Uebergaengen, damit der Zwischenzustand nie gemalt wird.
// Zwei erzwungene Vermessungen pro Tabwechsel statt vierunddreissig.
function kopfZielUnten(zu) {
  const kopf = $('#wallet-kopf');
  const geld = $('#wallet-kopf-geld');
  if (!kopf) return 0;
  const warTabs = kopf.classList.contains('nur-tabs');
  const warZu = geld?.classList.contains('zu');
  document.body.classList.add('misst');
  kopf.classList.toggle('nur-tabs', zu);
  geld?.classList.toggle('zu', zu);
  const unten = kopf.getBoundingClientRect().bottom + window.scrollY;
  kopf.classList.toggle('nur-tabs', warTabs);
  geld?.classList.toggle('zu', !!warZu);
  kopf.getBoundingClientRect();          // Layout wirklich zurueckdrehen
  document.body.classList.remove('misst');
  return unten;
}
addEventListener('resize', () => { ffKopfMax = 0; messeKopfzeile(); });
addEventListener('orientationchange', () => setTimeout(messeKopfzeile, 250));
// Sofort messen: der Kopf richtet sein Polster danach aus, und die Safe-Area
// eines iPhones macht die Kopfzeile deutlich hoeher als der Vorgabewert
messeKopfzeile();
addEventListener('load', messeKopfzeile);

// Antippen des Guthabens zeigt die Rang-Uebersicht, "Analyse" oeffnet ihre Seite
$('#balance-flip')?.addEventListener('click', () => zeigeRang());
// ... und das Maskottchen daneben auch (unsichtbare Flaeche ueber seinem
// Koerper, siehe look.css .wk-figur — Druck-Feedback dort per CSS)
$('#wk-figur')?.addEventListener('click', () => zeigeRang());
$('#wa-statistik')?.addEventListener('click', () => oeffneAnalyse());
// Verschenken: erst waehlen, welcher Gutschein — auf einer eigenen Seite, nach
// Marke gebuendelt, mit Filter und Sortierung. Danach schiebt der Schritt
// "An wen?" herein, zurueck fuehrt wieder in die Auswahl.
let schenkFilter = '', schenkSort = 'niedrig';
// Wie viele Gutscheine die Auswahl hoechstens gleichzeitig zeigt
let schenkSicht = 12;
function renderSchenkAuswahl() {
  const seite = wseiten().find(x => x.art === 'schenk-wahl');
  if (seite) zeichneSchenkAuswahl(seite);
}
function zeichneSchenkAuswahl(seite, { sanft = false } = {}) {
  if (walletGesperrt()) { aktualisiereSperre(); return; } // gesperrte Wallet: nichts zeigen
  const alle = state.wallet.vouchers.filter(v => !ohneGuthaben(v) && (v.balance == null || v.balance > 0));
  const marken = [...new Set(alle.map(v => v.vendor))];
  if (schenkFilter && !marken.includes(schenkFilter)) schenkFilter = '';
  let liste = schenkFilter ? alle.filter(v => v.vendor === schenkFilter) : alle;
  liste = [...liste].sort((a, b) => schenkSort === 'niedrig'
    ? (a.balance ?? Infinity) - (b.balance ?? Infinity)
    : (b.balance ?? 0) - (a.balance ?? 0));

  // Ohne Markenfilter zeigt jede Marke nur ihren passendsten Gutschein
  let inhalt;
  if (!schenkFilter) {
    const proMarke = new Map();
    liste.forEach(v => {
      if (!proMarke.has(v.vendor)) proMarke.set(v.vendor, []);
      proMarke.get(v.vendor).push(v);
    });
    inhalt = [...proMarke.entries()].map(([marke, vs]) => `
      <div class="schenk-gruppe" data-key="gruppe:${esc(marke)}">
        ${voucherCardHtml(vs[0])}
        ${vs.length > 1 ? `<button class="schenk-mehr" type="button" data-schenk-marke="${esc(marke)}">
          ${vs.length - 1} weitere von ${esc(marke)}${icon('chevron', 'icon icon-sm')}</button>` : ''}
      </div>`).join('');
  } else {
    // Auch hier eine Obergrenze: mit einer Marke im Filter standen sonst alle
    // Gutscheine dieser Marke auf einen Schlag im Baum
    const zeig = liste.slice(0, schenkSicht);
    inhalt = zeig.map(v => voucherCardHtml(v)).join('')
      + (liste.length > zeig.length
        ? `<button class="deck-more" type="button" data-schenk-mehr="1">${liste.length - zeig.length} weitere anzeigen</button>`
        : '');
  }

  // Frage, Marken und Sortierung bleiben stehen (Runde 118): vorher wurde bei
  // jedem Antippen die ganze Seite neu geschrieben — die Marken-Reihe sprang an
  // den Anfang zurueck und die Liste tauschte hart. Jetzt wechseln nur die
  // Markierungen, und die Liste gleicht sich an: bleibende Karten gleiten an
  // ihren neuen Platz, neue blenden ein, wegfallende aus.
  const host = seite.el.querySelector('.wseite-inhalt');
  const markenStand = marken.join('|');
  let listeEl = host.querySelector('.gw-liste');
  if (!listeEl || seite.gwMarken !== markenStand) {
    seite.gwMarken = markenStand;
    sanft = false;
    host.innerHTML = `
    <p class="gw-frage">Welchen Gutschein möchtest du verschenken?</p>
    ${marken.length > 1 ? `<div class="gw-marken" data-kein-wisch role="toolbar" aria-label="Nach Marke filtern">
      <button class="gw-chip" type="button" data-sf="">Alle</button>
      ${marken.map(m => `<button class="gw-chip" type="button" data-sf="${esc(m)}">
        ${brandChipHtml(m)}<span>${esc(m)}</span></button>`).join('')}
    </div>` : ''}
    <div class="gw-sortierung" role="tablist" aria-label="Sortieren">
      <span class="gw-flaeche" aria-hidden="true"></span>
      <button class="gw-sort" type="button" role="tab" data-ss="niedrig">Kleinster Rest</button>
      <button class="gw-sort" type="button" role="tab" data-ss="hoch">Größter Rest</button>
    </div>
    <div class="wallet-list gw-liste"></div>`;
    listeEl = host.querySelector('.gw-liste');
    host.querySelectorAll('[data-sf]').forEach(b => b.onclick = () => {
      if (schenkFilter === b.dataset.sf) return;
      schenkFilter = b.dataset.sf; schenkSicht = 12; buzz(6);
      zeichneSchenkAuswahl(seite, { sanft: true });
    });
    host.querySelectorAll('[data-ss]').forEach(b => b.onclick = () => {
      if (schenkSort === b.dataset.ss) return;
      schenkSort = b.dataset.ss; schenkSicht = 12; buzz(6);
      zeichneSchenkAuswahl(seite, { sanft: true });
    });
  }
  // Markierungen: die Flaeche der Sortierung gleitet, der Chip faerbt um
  host.querySelectorAll('.gw-chip').forEach(c => {
    const an = c.dataset.sf === schenkFilter;
    c.classList.toggle('an', an);
    c.setAttribute('aria-pressed', String(an));
  });
  host.querySelector('.gw-sortierung')?.style.setProperty('--i', schenkSort === 'hoch' ? 1 : 0);
  host.querySelectorAll('.gw-sort').forEach(x => {
    const an = x.dataset.ss === schenkSort;
    x.classList.toggle('an', an);
    x.setAttribute('aria-selected', String(an));
  });
  listeAngleichen(listeEl, inhalt || '<p class="gp-leer">Kein Gutschein mit Guthaben.</p>', { bewegt: sanft, bis: host });

  listeEl.querySelectorAll('[data-schenk-marke]').forEach(b => b.onclick = () => {
    schenkFilter = b.dataset.schenkMarke; schenkSicht = 12; buzz(6);
    zeichneSchenkAuswahl(seite, { sanft: true });
  });
  const mehr = listeEl.querySelector('[data-schenk-mehr]');
  if (mehr) mehr.onclick = () => { schenkSicht += 12; zeichneSchenkAuswahl(seite, { sanft: true }); };
  listeEl.querySelectorAll('[data-wv]').forEach(el => el.onclick = () => {
    const v = state.wallet.vouchers.find(x => x.id === el.dataset.wv);
    if (v) zeigeSchenkSchritt(v);
  });
  // Die gewaehlte Marke ins Bild holen, falls die Reihe weiter reicht
  const chip = host.querySelector('.gw-chip.an');
  const reihe = chip?.parentElement;
  if (chip && reihe && reihe.scrollWidth > reihe.clientWidth) {
    const r = chip.getBoundingClientRect(), rr = reihe.getBoundingClientRect();
    if (r.left < rr.left + 8 || r.right > rr.right - 8) {
      reihe.scrollTo({ left: reihe.scrollLeft + (r.left - rr.left) - (rr.width - r.width) / 2, behavior: sanft && weich() ? 'smooth' : 'auto' });
    }
  }
}
$('#wa-schenken')?.addEventListener('click', () => {
  if (walletGesperrt()) { aktualisiereSperre(); return; }
  if (!state.token) { island('Zum Verschenken bitte anmelden'); return; }
  const offen = state.wallet.vouchers.filter(v => !ohneGuthaben(v) && (v.balance == null || v.balance > 0));
  if (!offen.length) { island('Du hast gerade keinen Gutschein mit Guthaben'); return; }
  buzz(12);
  schenkFilter = '';
  schenkSicht = 12;
  wseiteOeffnen({ art: 'schenk-wahl', titel: 'Verschenken', klasse: 'gw', baue: s => zeichneSchenkAuswahl(s) });
});

// ---- Mini-Guthaben: erscheint über dem Menü, sobald die große Karte aus dem Bild ist
if ('IntersectionObserver' in window && $('#wallet-kopf')) {
  // Zählt schon als "aus dem Bild", wenn nur noch ein Rest der Karte zu sehen ist
  // Der Beobachter entscheidet nichts mehr selbst — er stoesst nur die eine
  // Pruefung an. Manche Browser melden beim programmgesteuerten Scrollen kein
  // scroll-Ereignis; dafuer ist er noch da.
  new IntersectionObserver(() => {
    if (state.activeView === 'wallet') pruefeKopfzeile();
  }, { threshold: [0, 0.25, 0.5, 1] }).observe($('#wallet-kopf'));
}
$('#wallet-mini')?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
$('#wallet-sort-btn')?.addEventListener('click', () => {
  const menu = $('#wallet-sort-menu');
  const rahmen = $('#wallet-content');
  // Klappt weich auf und zu, die Liste darunter gleitet mit statt zu springen
  if (offenWeich(menu)) { zeigeWeich(menu, false, { bis: rahmen }); return; }
  const OPTIONS = [
    ['', 'Neueste zuerst'], ['aelteste', 'Älteste zuerst'],
    ['hoch', 'Guthaben: hoch zu niedrig'], ['niedrig', 'Guthaben: niedrig zu hoch'],
    ['bis10', 'Bis 10 €'], ['ab25', 'Ab 25 €'], ['ab50', 'Ab 50 €'],
  ];
  menu.innerHTML = OPTIONS.map(([v, l]) =>
    `<button class="cmd-row ${(state.walletSort || '') === v ? 'on' : ''}" data-wsort="${v}"><span>${l}</span></button>`).join('');
  zeigeWeich(menu, true, { bis: rahmen });
  menu.querySelectorAll('[data-wsort]').forEach(x => x.onclick = () => {
    state.walletSort = x.dataset.wsort;
    saveWalletFilter();
    zeigeWeich(menu, false, { bis: rahmen });
    renderWallet();
  });
});

// Das Logo fuehrt nach Hause — und zu Hause ist jetzt die Wallet
$('#btn-home').addEventListener('click', () => {
  if (state.activeView !== 'wallet') switchView('wallet');
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
async function enablePushNow() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Dieser Browser kann keine Push-Nachrichten. iPhone: kumulio erst zum Home-Bildschirm hinzufügen und dort öffnen.');
  }
  const reg = await navigator.serviceWorker.ready;
  if (await reg.pushManager.getSubscription()) return;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Benachrichtigungen wurden nicht erlaubt.');
  const { key } = await api('/api/push/key');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
  await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub) });
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
  } else if (p.get('chat')) {
    // Alte Links (?chat=global, z. B. aus einer frueheren Benachrichtigung)
    // fuehren jetzt in die Freundesliste — den Global-Chat gibt es nicht mehr
    if (state.activeView !== 'chat') switchView('chat');
  } else if (p.get('tab')) {
    const t = p.get('tab');
    if (['wallet', 'feed', 'profile', 'gifts', 'chat', 'settings'].includes(t) && $('#view-' + t) && state.activeView !== t) switchView(t);
  }
  // ?deal=<id>: die Deal-Seite geht auf — beim Start erst, wenn der Feed da ist
  const dealId = p.get('deal');
  if (dealId && /^[a-z0-9]{4,40}$/i.test(dealId)) {
    const d = state.deals.length ? dealVonId(dealId) : null;
    if (d) openDealSheet(d);
    else if (state.deals.length) island('Dieser Deal ist nicht mehr im Feed');
    else dealNachLaden = dealId;
  }
}

// ---------------- Chat: Fluestern mit Freunden ----------------

let chatEmotes = {};

const CHAT_COLORS = ['#e91e63', '#9c27b0', '#3f51b5', '#03a9f4', '#009688', '#4caf50', '#ff9800', '#f44336', '#8d6e63', '#607d8b'];
function chatColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CHAT_COLORS[h % CHAT_COLORS.length];
}
// Namensfarbe überall gleich: liefert Klasse+Style für einen Namen. Der zweite
// Wert ist die gewählte Farbe (#rrggbb vom Server, Feld "paint"/"activePaint")
// oder leer, dann gilt die stabile Chat-Farbe des Namens. Lesbar bleibt sie
// immer: color gilt auf hellem Grund, --nf-d im Dunkelmodus (Klasse .nf).
function nameStyleOf(name, farbe) {
  const basis = /^#[0-9a-f]{6}$/i.test(farbe || '') ? farbe : chatColor(name || '?');
  return { cls: ' nf', style: `color:${lesbareFarbe(basis, false)}; --nf-d:${lesbareFarbe(basis, true)}` };
}
// Zu helle Farben auf Weiss dunkeln wir nach, zu dunkle auf der dunklen Karte
// (#171C22) hellen wir auf — bis der Kontrast mindestens 4 : 1 ist
function lesbareFarbe(hex, dunkel) {
  const cache = lesbareFarbe.cache || (lesbareFarbe.cache = new Map());
  const key = hex.toLowerCase() + (dunkel ? 'd' : 'h');
  if (cache.has(key)) return cache.get(key);
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const hell = c => {
    const [r, g, b] = c.map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
    return .2126 * r + .7152 * g + .0722 * b;
  };
  const grund = dunkel ? .0113 : 1;
  const reicht = c => { const l = hell(c); return (Math.max(l, grund) + .05) / (Math.min(l, grund) + .05) >= 4; };
  let c = rgb;
  for (let t = .06; !reicht(c) && t <= 1; t += .06) {
    c = rgb.map(x => Math.round(dunkel ? x + (255 - x) * t : x * (1 - t)));
  }
  const out = '#' + c.map(x => x.toString(16).padStart(2, '0')).join('');
  cache.set(key, out);
  return out;
}
// Emotes: nur Katzen und Peepo, und jeder hat alle (kein Ziehen, keine
// Sperre). Die Liste kommt vom Server (/api/meta) in Auswahl-Reihenfolge.
// Was frueher ein Emote war, steht in alten Nachrichten einfach als Text.
function allEmoteIds() { return chatEmotes; }
// Gibt es das Emote (noch)? Besitz gibt es nicht mehr, alle sind frei.
// Name bleibt, weil das Verschenken ihn noch fragt.
function emoteOwned(name) { return Object.hasOwn(chatEmotes, name); }
// Die zwei Gruppen der Auswahl; Peepo-Namen beginnen immer mit "peepo"
function emoteGruppen() {
  const namen = Object.keys(chatEmotes);
  const peepo = namen.filter(n => /^peepo/i.test(n));
  return { katzen: namen.filter(n => !peepo.includes(n)), peepo };
}
function emoteHtml(name) {
  const id = Object.hasOwn(chatEmotes, name) ? chatEmotes[name] : '';
  if (!id) return esc(name); // unbekannt (z. B. entferntes Emote): als Text
  return `<img class="emote" src="https://cdn.7tv.app/emote/${id}/2x.webp" alt="${esc(name)}" title="${esc(name)}" loading="lazy">`;
}
// Ein Ausdruck fuer alle Namen statt einer Schleife je Emote; neu gebaut nur,
// wenn die Liste wechselt
let emoteMuster = null, emoteMusterQuelle = null;
function withEmotes(escapedText) {
  if (emoteMusterQuelle !== chatEmotes) {
    emoteMusterQuelle = chatEmotes;
    const namen = Object.keys(chatEmotes).filter(n => /^[A-Za-z0-9]+$/.test(n));
    emoteMuster = namen.length ? new RegExp(`\\b(${namen.join('|')})\\b`, 'g') : null;
  }
  return emoteMuster ? escapedText.replace(emoteMuster, n => emoteHtml(n)) : escapedText;
}
// "…" zum Löschen eigener Nachrichten (Web: beim Drüberfahren, Handy: gedrückt halten)
function msgMenuHtml(own, id) {
  return own ? `<button class="msg-menu" data-msg-del="${esc(id)}" aria-label="Nachricht löschen">…</button>` : '';
}
// Chat-Modi: Liste der Gespraeche oder ein einzelner Fluesterchat
let chatMode = 'dmlist';
let dmPartner = '';
let dmLastTs = 0;
// Zaehlt jeden Wechsel (Liste <-> Einzelchat, anderer Partner). Eine Antwort,
// die zu einem frueheren Stand gehoert, schreibt nichts mehr in #chat-list.
let chatLauf = 0;
// Angefangene Nachrichten je Gespraech: ein Entwurf fuer A landet nie bei B
const chatEntwuerfe = new Map();

function setChatMode(mode, partner) {
  const vorherMode = chatMode;
  const inp = $('#chat-input');
  if (vorherMode === 'dm' && dmPartner) chatEntwuerfe.set(dmPartner, inp.value);
  chatLauf++;
  chatMode = mode;
  dmPartner = partner || '';
  dmLastTs = 0;
  inp.value = mode === 'dm' ? chatEntwuerfe.get(dmPartner) || '' : '';
  $('#chat-list').innerHTML = '';
  // Die Emote-Auswahl gehoert zum einzelnen Chat: beim Wechsel schliesst sie
  if (!$('#chat-emotes').classList.contains('hidden')) toggleEmotes();
  // Die Liste schiebt in die Richtung herein, in die man geht: in einen Chat
  // hinein von rechts, zurueck zur Liste von links.
  const rang = { dmlist: 1, dm: 2 };
  if (vorherMode && vorherMode !== mode) {
    const box = $('#chat-box');
    box.classList.remove('kommt-links', 'kommt-rechts');
    void box.offsetWidth;
    box.classList.add(rang[mode] > rang[vorherMode] ? 'kommt-rechts' : 'kommt-links');
  }
  $('#view-chat').classList.toggle('im-dm', mode === 'dm');
  $('#dm-head').classList.toggle('hidden', mode !== 'dm');
  $('#chat-titel')?.classList.toggle('hidden', mode === 'dm');
  $('#chat-input-row').style.display = mode === 'dmlist' ? 'none' : 'flex';
  if (mode === 'dm') {
    // Kopf: Profilbild, Anzeigename in seiner Namensfarbe, bei Admin/Mod das
    // Zeichen. Darunter der @Name, sobald vorne ein Anzeigename steht — so
    // sieht man immer, wer es wirklich ist.
    const el = $('#dm-partner-name');
    el.className = '';
    el.removeAttribute('style');
    $('#dm-partner-rolle').innerHTML = '';
    const nameZeigen = () => {
      el.textContent = anzeigeName(dmPartner);
      $('#dm-partner-hinweis').textContent = hatAnzeigename(dmPartner) ? '@' + dmPartner : 'Profil ansehen';
    };
    nameZeigen();
    const avaZeigen = () => { $('#dm-partner-ava').innerHTML = avatarHtml(dmPartner, undefined, 'avatar-mini'); };
    avaZeigen();
    const fuer = dmPartner;
    api('/api/user?name=' + encodeURIComponent(dmPartner)).then(u => {
      if (fuer !== dmPartner) return; // inzwischen ein anderer Chat offen
      if ('anzeigename' in u && merkeAnzeigename(dmPartner, u.anzeigename)) nameZeigen();
      // Private Profile schicken kein Bild mit: dann bleibt das gemerkte stehen
      if ('avatar' in u && avatarId(u.avatar) !== (avatarMerk.get(dmPartner) || '')) { merkeAvatar(dmPartner, u.avatar); avaZeigen(); }
      const ns = nameStyleOf(dmPartner, u.activePaint);
      el.className = ns.cls.trim();
      el.setAttribute('style', ns.style);
      const rolle = $('#dm-partner-rolle');
      rolle.innerHTML = u.role === 'admin' ? icon('crown', 'icon role-admin')
        : u.role === 'mod' ? icon('check', 'icon role-mod') : '';
      rolle.title = u.role === 'admin' ? 'Admin' : u.role === 'mod' ? 'Moderation' : '';
    }).catch(() => { });
  } else {
    $('#dm-partner-ava').innerHTML = '';
  }
  chatEingabeStand();
  // Moduswechsel gleitet weich
  const cl = $('#chat-list');
  cl.classList.add('enter-drop');
  setTimeout(() => cl.classList.remove('enter-drop'), 500);
  delete $('#chat-box').dataset.scrolled;
  pollChat(true);
}

// Eine Blase. Ueber der ersten einer Folge steht der Name der anderen Person
// in ihrer Namensfarbe; Rang, Abzeichen und Rollen-Zeichen stehen im Chat
// nicht mehr (Raenge sind privat).
function dmMsgHtml(m) {
  const own = m.from === state.userName;
  // Absender und Zeit stehen am Element: chatGruppieren() fasst danach
  // aufeinanderfolgende Nachrichten derselben Person zusammen
  const daten = `data-mid="${esc(m.id)}" data-from="${esc(m.from)}" data-ts="${Number(m.ts) || 0}"`;
  const ns = nameStyleOf(m.from, m.paint);
  // Ueber der Blase der Anzeigename (der Server schickt ihn an jeder Nachricht mit)
  merkeAnzeigename(m.from, m.anzeigename || '');
  const kopf = `<span class="chat-kopf"><span class="chat-user${ns.cls}" style="${ns.style}" title="@${esc(m.from)}">${esc(anzeigeName(m.from))}</span></span>`;
  if (m.deleted) {
    return `<div class="chat-msg dm-${own ? 'me' : 'them'}" ${daten}>
      ${kopf}
      <span class="chat-text chat-deleted">Nachricht gelöscht</span>
    </div>`;
  }
  return `<div class="chat-msg dm-${own ? 'me' : 'them'} ${own ? 'own' : ''}" ${daten}>
    ${kopf}
    <span class="chat-text">${chatBodyHtml(m.text)}</span>
    ${msgMenuHtml(own, m.id)}
  </div>`;
}

// Blasen derselben Person, die kurz nacheinander kommen, bilden eine Folge:
// der Name steht nur ueber der ersten, die Uhrzeit (aus m.ts) unter der
// letzten. Beim Tageswechsel steht ein Datum dazwischen. Zeit und Datum sind
// eigene Zeilen in der Liste, nicht Teil der Blase.
function chatGruppieren() {
  const list = $('#chat-list');
  if (!list || chatMode !== 'dm') return;
  const msgs = [...list.querySelectorAll('.chat-msg[data-ts]')];
  const tag = ts => new Date(ts).toDateString();
  const folgt = (a, b) => a && b && a.dataset.from === b.dataset.from
    && b.dataset.ts - a.dataset.ts < 5 * 60e3 && tag(+a.dataset.ts) === tag(+b.dataset.ts);
  const heute = new Date(), gestern = new Date(Date.now() - 864e5);
  const tagName = d => d.toDateString() === heute.toDateString() ? 'Heute'
    : d.toDateString() === gestern.toDateString() ? 'Gestern'
    : d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== heute.getFullYear() ? { year: 'numeric' } : {}) });
  msgs.forEach((el, i) => {
    const vor = msgs[i - 1], nach = msgs[i + 1];
    const ts = +el.dataset.ts;
    el.classList.toggle('folge', !!folgt(vor, el));
    el.classList.toggle('ende', !folgt(el, nach));
    // Datum ueber der ersten Nachricht eines Tages
    const vorEl = el.previousElementSibling;
    const neuerTag = ts && (!vor || tag(+vor.dataset.ts) !== tag(ts));
    if (neuerTag) {
      let d = vorEl?.classList.contains('chat-tag') ? vorEl : null;
      if (!d) { d = document.createElement('div'); d.className = 'chat-tag'; el.before(d); }
      d.textContent = tagName(new Date(ts));
    } else if (vorEl?.classList.contains('chat-tag')) vorEl.remove();
    // Uhrzeit unter der letzten Blase einer Folge
    const nachEl = el.nextElementSibling;
    const hatZeit = nachEl?.classList.contains('chat-zeit');
    if (el.classList.contains('ende') && ts) {
      const z = hatZeit ? nachEl : document.createElement('div');
      z.className = 'chat-zeit' + (el.classList.contains('dm-me') ? ' ich' : '');
      z.textContent = new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      if (!hatZeit) el.after(z);
    } else if (hatZeit) nachEl.remove();
  });
}

// Zeit in der Gespraechsliste wie in Messengern: heute die Uhrzeit, dann
// "Gestern", in der letzten Woche der Wochentag, sonst das Datum
function chatListenZeit(ts) {
  const d = new Date(ts), jetzt = new Date();
  const tage = Math.round((new Date(jetzt.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (tage <= 0) return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (tage === 1) return 'Gestern';
  if (tage < 7) return d.toLocaleDateString('de-DE', { weekday: 'long' });
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', ...(d.getFullYear() !== jetzt.getFullYear() ? { year: '2-digit' } : {}) });
}

// /api/dm/list: Anzeigenamen der Gespraechspartner und der Freunde ohne Chat
function dmListeNamenMerken(r) {
  (r?.list || []).forEach(c => { merkeAnzeigename(c.partner, c.anzeigename || ''); merkeAvatar(c.partner, c.avatar || ''); });
  (r?.friends || []).forEach(f => { merkeAnzeigename(f.name, f.anzeigename || ''); merkeAvatar(f.name, f.avatar || ''); });
}

async function pollChat(force) {
  // Ausserhalb des Chats wird nur noch die Zahl ungelesener Nachrichten
  // nachgesehen. Frueher lief hier alle vier Sekunden der ganze Global-Chat
  // mit — auch wenn man ihn gar nicht offen hatte.
  if (!force && state.activeView !== 'chat') { refreshDmBadge(); return; }
  // Stand vor dem Warten merken: wechselt inzwischen der Chat (etwa "Schreiben"
  // direkt nach switchView('chat')), gehoert die Antwort nicht mehr hierher
  const lauf = chatLauf, modus = chatMode, fuer = dmPartner;
  const veraltet = () => lauf !== chatLauf || modus !== chatMode || fuer !== dmPartner;
  try {
    if (chatMode === 'dmlist') {
      if (!state.token) { $('#chat-list').innerHTML = '<div class="status">Zum Flüstern bitte anmelden.</div>'; return; }
      const r = await api('/api/dm/list');
      if (veraltet()) return;
      dmListeNamenMerken(r);
      // Profilbild (Kumulio), sonst der Anfangsbuchstabe auf der Chat-Farbe
      const ava = (name, avatar) => avatarHtml(name, avatar || '', 'avatar-mini');
      // Letzte Nachricht als Vorschau: Emotes als kleine Bilder, ein geteilter
      // Deal ohne das [deal:…]-Kuerzel, eigene mit "Du:" davor
      const vorschau = c => {
        const t = String(c.lastText || '');
        const du = c.lastMine && t ? '<span class="dm-row-du">Du:</span> ' : '';
        const dl = t.match(/^\[deal:[a-z0-9]+\]\s*(.*)$/i);
        if (dl) return `${du}${icon('tag', 'icon dm-row-ico')}${esc(dl[1] || 'Deal')}`;
        const cp = t.match(/^\[coupon:[^\]]*\]\s*(.*)$/i);
        if (cp) return `${du}${icon('tag', 'icon dm-row-ico')}${esc(cp[1].replace(/ · Code .*$/, '') || 'Coupon')}`;
        return t ? du + withEmotes(esc(t)) : '<i>Nachricht gelöscht</i>';
      };
      const rows = r.list.map(c => `
        <button class="dm-row${c.unread ? ' ungelesen' : ''}" data-dm-open="${esc(c.partner)}">
          ${ava(c.partner, c.avatar)}
          <span class="dm-row-main">
            <span class="dm-row-oben">
              <span class="dm-row-name" title="@${esc(c.partner)}">${esc(anzeigeName(c.partner))}</span>
              ${c.lastTs ? `<span class="dm-row-zeit">${esc(chatListenZeit(c.lastTs))}</span>` : ''}
            </span>
            <span class="dm-row-unten">
              <span class="dm-row-last">${vorschau(c)}</span>
              ${c.unread ? `<span class="dm-unread-pill" aria-label="${c.unread} ungelesen">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
            </span>
          </span>
        </button>`).join('');
      const friendRows = (r.friends || []).map(f => `
        <button class="dm-row" data-dm-open="${esc(f.name)}">
          ${ava(f.name, f.avatar)}
          <span class="dm-row-main">
            <span class="dm-row-oben"><span class="dm-row-name" title="@${esc(f.name)}">${esc(anzeigeName(f.name))}</span></span>
            <span class="dm-row-unten"><span class="dm-row-last">Noch keine Nachrichten</span></span>
          </span>
          ${icon('chevron', 'icon dm-row-pfeil')}
        </button>`).join('');
      // Laufende Gespraeche zuerst, darunter die Freunde, mit denen man noch
      // nicht geschrieben hat. Alles liegt direkt auf der Seite, keine Kaesten.
      $('#chat-list').innerHTML = (rows || friendRows)
        ? (rows ? `<div class="dm-gruppe">${rows}</div>` : '')
          + (friendRows ? `<h3 class="dm-trenner">${rows ? 'Freunde' : 'Deine Freunde'}</h3><div class="dm-gruppe">${friendRows}</div>` : '')
        : `<div class="chat-leer">
            <span class="chat-leer-bild">${icon('message', 'icon')}</span>
            <p>Hier schreibst du mit deinen Freunden.</p>
            <p class="muted">Sobald du jemanden hinzugefügt hast, steht er hier.</p>
            <button class="btn" id="chat-freunde-finden">${icon('user', 'icon icon-sm')} Freunde finden</button>
          </div>`;
      $('#chat-list').querySelectorAll('[data-dm-open]').forEach(b => b.onclick = () => setChatMode('dm', b.dataset.dmOpen));
      $('#chat-freunde-finden')?.addEventListener('click', () => switchView('friends', 'enter-drop'));
    } else if (chatMode === 'dm') {
      const r = await api(`/api/dm/with?user=${encodeURIComponent(dmPartner)}&since=${dmLastTs}`);
      if (veraltet()) return;           // anderer Chat offen: nichts anhaengen, dmLastTs bleibt
      (r.updates || []).forEach(id => {
        const el = $('#chat-list').querySelector(`[data-mid="${id}"] .chat-text`);
        if (el) { el.className = 'chat-text chat-deleted'; el.textContent = 'Nachricht gelöscht'; }
      });
      if (r.messages.length) {
        const list = $('#chat-list');
        r.messages.forEach(m => {
          if (!list.querySelector(`[data-mid="${m.id}"]`)) list.insertAdjacentHTML('beforeend', dmMsgHtml(m));
          dmLastTs = Math.max(dmLastTs, m.ts);
        });
        chatGruppieren();
        // Mit Nachzueglern: Blasen ausserhalb des Bildes haben per
        // content-visibility erst eine geschaetzte Hoehe, ein einziger Sprung
        // landete deshalb mitten im Verlauf statt ganz unten
        chatToBottom(false);
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
    dmListeNamenMerken(r);
    const unread = r.list.reduce((s, c) => s + c.unread, 0);
    const pill = $('#dm-unread');
    pill.textContent = unread;
    pill.classList.toggle('hidden', !unread);
    // Neue Flüsternachricht: Plop + Banner (außer man liest den Chat gerade oder hat es abgeschaltet)
    // Wer gerade im Chat ist, sieht die Nachricht ohnehin — dann kein Banner,
    // kein Plop. Nur die Zahl am Flüster-Tab zählt still weiter hoch.
    if (dmUnreadKnown !== null && unread > dmUnreadKnown
        && state.notif.msgs !== false && state.activeView !== 'chat') {
      const conv = r.list.find(c => c.unread > 0);
      if (conv) {
        playSfx('plop'); buzz(25);
        // Geteilte Deals und Coupons ohne ihr [deal:…]/[coupon:…]-Kuerzel
        showNoteBanner(`<b>${esc(anzeigeOderAt(conv.partner))}</b>: ${esc(String(conv.lastText || '').replace(/^\[(?:deal|coupon):[^\]]*\]\s*/i, ''))}`, () => {
          if (state.activeView !== 'chat') switchView('chat');
          setChatMode('dm', conv.partner);
        });
      }
    }
    dmUnreadKnown = unread;
  } catch { }
}

// Ans Ende scrollen. Die Tastatur schiebt in mehreren Schueben, deshalb ein
// paar Nachzuegler — sonst steht man nach dem Antippen mitten im Verlauf.
function chatToBottom(weich) {
  const box = $('#chat-box');
  if (!box) return;
  const ziel = () => { box.scrollTop = box.scrollHeight; };
  if (weich && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  } else ziel();
  [60, 180, 360].forEach(ms => setTimeout(ziel, ms));
}
$('#chat-input').addEventListener('focus', () => chatToBottom(false));

async function sendChat() {
  const inp = $('#chat-input');
  const text = inp.value.trim();
  if (!text || chatMode !== 'dm' || !dmPartner) return;
  // Emote-Fenster schließt beim Absenden, die Nachricht ist ja raus
  if (!$('#chat-emotes').classList.contains('hidden')) toggleEmotes();
  if (!state.token) { switchView('profile'); island('Zum Schreiben bitte anmelden'); return; }
  const lauf = chatLauf, an = dmPartner;
  try {
    const r = await api('/api/dm/send', { method: 'POST', body: JSON.stringify({ to: an, text }) });
    // Inzwischen ein anderer Chat offen: die Nachricht ist raus, gehoert aber
    // nicht in diese Liste — nur ihren Entwurf beim alten Gespraech leeren
    if (lauf !== chatLauf) {
      if ((chatEntwuerfe.get(an) || '').trim() === text) chatEntwuerfe.delete(an);
      if (chatMode === 'dm' && dmPartner === an && inp.value.trim() === text) { inp.value = ''; chatEingabeStand(); }   // derselbe Chat neu geoeffnet
      return;
    }
    inp.value = '';
    if (!$('#chat-list').querySelector(`[data-mid="${r.message.id}"]`)) {
      $('#chat-list').insertAdjacentHTML('beforeend', dmMsgHtml(r.message));
      $('#chat-list').lastElementChild?.classList.add('msg-sent');
      chatGruppieren();
    }
    dmLastTs = Math.max(dmLastTs, r.message.ts);
    chatToBottom(true);
    chatEingabeStand(); // Feld ist leer, Senden wird wieder leise
  } catch (e) { island(e.message); }
}

// ---- Nutzer-Profil: eigene Seite (ersetzt das alte Popup)
let userPageReturn = 'feed';
async function openUserPop(user, msgId) {
  if (user === state.userName) { switchView('profile'); return; }
  if (state.activeView !== 'user') {
    userPageReturn = state.activeView;
    // Aus einem Einzelchat: Zurueck fuehrt wieder in dieses Gespraech (siehe switchView)
    openUserPop.gespraech = state.activeView === 'chat' && chatMode === 'dm' ? dmPartner : '';
  }
  const pop = $('#user-page');
  pop.innerHTML = '<div class="status">Lade Profil …</div>';
  switchView('user', 'enter-drop');
  let u = { user };
  try { u = await api('/api/user?name=' + encodeURIComponent(user)); } catch { }
  if ('anzeigename' in u) merkeAnzeigename(user, u.anzeigename || '');
  if ('avatar' in u) merkeAvatar(user, u.avatar);
  const isFriend = (myProfile?.friends || []).includes(user);
  const ns = nameStyleOf(user, u.activePaint);
  // Wie das eigene Profil, nur ohne Privates: keine Serie. Vom Rang kommt nur
  // die Stufe (oeffentliche Profile), und die zeigt sich nur als Farbe der
  // Karte — Rang-Name, Stufe und Maskottchen bleiben dem Nutzer selbst.
  // Privat oder ohne Stufe: die ruhige weisse Karte.
  const stufe = !u.private && Number.isInteger(u.stufe) && u.stufe >= 1 && u.stufe <= RANKS.length ? u.stufe : 0;
  const marken = !u.private && u.favs ? Object.keys(FAV_OPTIONS).map(k => u.favs[k]).filter(Boolean) : [];
  pop.innerHTML = `
    <div class="up-kopf"${stufe ? ` data-stufe="${stufe}"` : ''}>
      <div class="up-hero">
        <span class="up-ava-rahmen">
          ${avatarHtml(user, u.private ? '' : u.avatar || '', 'avatar-big up-ava', '', { gross: true })}
          ${stufe ? funkenHtml('up-funken', 2) : ''}
        </span>
        <div class="up-name"><span class="${ns.cls.trim()}" style="${ns.style}">${esc(anzeigeName(user))}</span> ${u.role === 'admin' ? icon('crown', 'icon icon-sm role-admin') : u.role === 'mod' ? icon('check', 'icon icon-sm role-mod') : ''}</div>
        <div class="up-handle">@${esc(user)}</div>
        <div class="up-bio${u.private || !u.bio ? ' leer' : ''}">${u.private ? 'Dieses Profil ist privat.' : esc(u.bio || 'Noch keine Bio.')}</div>
      </div>
      ${marken.length ? `<div class="up-marken">${marken.map(favChipHtml).join('')}</div>` : ''}
      <div class="up-actions">
        <button class="btn" id="up-whisper" type="button">${icon('message', 'icon icon-sm')} Schreiben</button>
        <button class="btn btn-ghost" id="up-friend" type="button">${isFriend ? 'Freund entfernen' : 'Als Freund anfragen'}</button>
      </div>
    </div>
    <div class="up-karte">
      <div id="up-ratings"></div>
      <button class="link-knopf up-melden" id="up-report" type="button">Profil melden</button>
    </div>`;
  renderProfileRatings(user);
  // Bewusst KEINE Mod-Buttons hier: die Profilseite zeigt das Profil, wie es der
  // Nutzer gestaltet hat. Wer etwas sieht, meldet es ueber "Melden".
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
// Profil-Bewertungen: jeder Besucher hat EINEN Eintrag (Sterne + kurzer Text),
// der jederzeit ueberschrieben oder entfernt werden kann
function starRow(n, interactive) {
  return `<span class="star-row${interactive ? ' star-pick' : ''}">${[1, 2, 3, 4, 5].map(i =>
    `<svg class="icon icon-sm star ${i <= n ? 'on' : ''}" ${interactive ? `data-star="${i}"` : ''}><use href="#i-star"/></svg>`).join('')}</span>`;
}
async function renderProfileRatings(user) {
  const host = $('#up-ratings');
  if (!host) return;
  let r;
  try { r = await api('/api/profile/comments?user=' + encodeURIComponent(user)); } catch { return; }
  let pickedStars = r.mine?.stars || 0;
  host.innerHTML = `
    <h3 class="gm-h up-center-h">Profil-Bewertungen ${r.count ? `<span class="stars-count">${String(r.avg).replace('.', ',')} von 5 · ${r.count}</span>` : ''}</h3>
    ${state.token ? `
    <div class="up-rate-line">
      ${r.mine ? `<span class="up-mine">${starRow(r.mine.stars, false)}</span>` : ''}
      <button class="chip" id="up-rate-open">${r.mine ? 'Bewertung bearbeiten' : 'Bewertung schreiben'}</button>
    </div>
    <div class="up-rate-form collapsed" id="up-rate-form">
      ${starRow(pickedStars, true)}
      <div class="form-row" style="margin-top:8px">
        <input class="input" id="up-rate-text" maxlength="140" placeholder="Kurzer Kommentar (optional)" value="${esc(r.mine?.text || '')}">
        <button class="btn btn-small" id="up-rate-send">${r.mine ? 'Aktualisieren' : 'Bewerten'}</button>
        ${r.mine ? '<button class="btn btn-small btn-ghost" id="up-rate-del">Entfernen</button>' : ''}
      </div>
    </div>` : ''}
    ${r.list.length ? r.list.map(c => {
    const cns = nameStyleOf(c.from, c.paint);
    merkeAnzeigename(c.from, c.anzeigename || '');
    merkeAvatar(c.from, c.avatar);
    return `
    <div class="up-rate-row">
      ${avatarHtml(c.from, undefined, 'avatar-mini')}
      <div class="up-rate-body">
        <div><span class="chat-user${cns.cls}" style="${cns.style}" title="@${esc(c.from)}">${esc(anzeigeName(c.from))}</span> ${starRow(c.stars, false)} <span class="comment-time">${esc(timeAgo(c.ts))}</span></div>
        ${c.text ? `<div class="up-rate-text">${withEmotes(esc(c.text))}</div>` : ''}
      </div>
    </div>`;
  }).join('') : '<div class="status">Noch keine Bewertungen. Sei die erste Stimme!</div>'}`;
  $('#up-rate-open')?.addEventListener('click', () => {
    $('#up-rate-form').classList.toggle('collapsed');
    if (!$('#up-rate-form').classList.contains('collapsed')) $('#up-rate-text')?.focus();
  });
  host.querySelectorAll('[data-star]').forEach(st => st.onclick = () => {
    pickedStars = Number(st.dataset.star);
    host.querySelectorAll('.star-pick .star').forEach((s, i) => s.classList.toggle('on', i < pickedStars));
  });
  $('#up-rate-send')?.addEventListener('click', async () => {
    if (!pickedStars) { island('Erst Sterne antippen'); return; }
    try {
      await api('/api/profile/comment', { method: 'POST', body: JSON.stringify({ user, stars: pickedStars, text: $('#up-rate-text').value }) });
      island('Danke für deine Bewertung!'); playSfx('plop');
      renderProfileRatings(user);
    } catch (e) { island(e.message); }
  });
  $('#up-rate-del')?.addEventListener('click', async () => {
    try {
      await api('/api/profile/comment', { method: 'POST', body: JSON.stringify({ user, stars: 0, text: '' }) });
      island('Bewertung entfernt');
      renderProfileRatings(user);
    } catch (e) { island(e.message); }
  });
}
// Eigene Nachricht löschen, wird zum Platzhalter
async function deleteOwnMsg(id) {
  if (chatMode !== 'dm') return;
  if (!await askConfirm('Diese Nachricht löschen?', { okLabel: 'Löschen' })) return;
  try {
    await api('/api/dm/delete', { method: 'POST', body: JSON.stringify({ user: dmPartner, id }) });
    const el = $('#chat-list').querySelector(`[data-mid="${id}"]`);
    if (el) {
      const t = el.querySelector('.chat-text');
      if (t) { t.className = 'chat-text chat-deleted'; t.textContent = 'Nachricht gelöscht'; }
      el.querySelector('.msg-menu')?.remove();
    }
  } catch (e) { island(e.message); }
}
// Im Chat: kompaktes Popup mit Schnellaktionen, "Zum Profil" führt zur Seite
$('#chat-list').addEventListener('click', e => {
  const del = e.target.closest('[data-msg-del]');
  if (del) { deleteOwnMsg(del.dataset.msgDel); return; }
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
// Senden leuchtet erst, wenn etwas im Feld steht
function chatEingabeStand() {
  $('#chat-input-row').classList.toggle('hat-text', !!$('#chat-input').value.trim());
}
$('#chat-input').addEventListener('input', chatEingabeStand);
// Emote-Auswahl: alle Emotes fuer alle, Katzen und Peepo als zwei Bloecke im
// selben Raster, getrennt durch eine feine Linie
function toggleEmotes() {
  const el = $('#chat-emotes');
  const opening = el.classList.contains('hidden');
  $('#view-chat').classList.toggle('emotes-open', opening);
  $('#chat-emote-btn').setAttribute('aria-expanded', String(opening));
  if (opening) {
    const g = emoteGruppen();
    const knopf = n => `<button class="emote-pick" data-emote="${esc(n)}" aria-label="${esc(n)}">${emoteHtml(n)}</button>`;
    el.innerHTML = g.katzen.length || g.peepo.length
      ? g.katzen.map(knopf).join('')
        + (g.katzen.length && g.peepo.length ? '<span class="emote-trenner" aria-hidden="true"></span>' : '')
        + g.peepo.map(knopf).join('')
      : '<span class="form-msg">Emotes laden …</span>';
    el.classList.remove('hidden');
    // Nachrichten nachziehen: die letzten bleiben beim Schreiben sichtbar
    setTimeout(() => { const box = $('#chat-box'); box.scrollTop = box.scrollHeight; }, 320);
    el.querySelectorAll('[data-emote]').forEach(b => b.onclick = () => {
      const i = $('#chat-input');
      i.value = (i.value + ' ' + b.dataset.emote + ' ').replace(/\s{2,}/g, ' ').trimStart();
      chatEingabeStand();
      // Am Handy bleibt die Tastatur zu, sonst schiebt sie die Auswahl weg
      if (matchMedia('(hover: hover)').matches) i.focus();
    });
  } else el.classList.add('hidden');
}
// Antippen des Verlaufs schliesst die Auswahl wieder
$('#chat-box').addEventListener('click', () => {
  if (!$('#chat-emotes').classList.contains('hidden')) toggleEmotes();
});
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
  es.addEventListener('gift', () => pullWallet()); // Geschenk kommt sofort an
  // Lios: Gutschrift (Freund, Admin), Bonus oder Kauf — Profil neu, der Stern fliegt
  es.addEventListener('lio', () => ladeProfil());
  // PIN auf einem anderen Geraet festgelegt, geaendert oder entfernt: sofort mitziehen
  es.addEventListener('pin', () => api('/api/me').then(r => { kontoInfo = r; pinKontoUebernehmen(r); }).catch(() => { }));
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

// Einladungslink: ?ref=NAME wird gemerkt und zaehlt bei der Registrierung
{
  const rp = new URLSearchParams(location.search).get('ref');
  if (rp) lsSetzen('ra.ref', rp.slice(0, 24));
}
function inviteUrl() { return 'https://kumulio.de/?ref=' + encodeURIComponent(state.userName || ''); }
// Teilen bzw. kopieren, je nachdem was das Geraet kann
function shareInvite() {
  if (!state.userName) { island('Zum Einladen bitte anmelden'); return; }
  const url = inviteUrl();
  const text = 'Komm zu kumulio: alle Gutscheine in einer Wallet, Cashback in Lios, Verschenken an Freunde und Coupons zum Merken.';
  if (navigator.share) { navigator.share({ title: 'kumulio', text, url }).catch(() => { }); return; }
  copyInvite();
}
function copyInvite() {
  navigator.clipboard.writeText(inviteUrl())
    .then(() => { island('Einladungslink kopiert'); playSfx('plop'); })
    .catch(() => island(inviteUrl()));
}
// Eigene Seite: der Link, wie viele schon dabei sind, und ehrlich: eine
// Belohnung gibt es noch nicht, die Einladungen werden aber vorgemerkt
async function renderInvitePage() {
  const host = $('#invite-page');
  if (!host) return;
  if (!state.token) {
    host.innerHTML = '<div class="status">Zum Einladen bitte anmelden.</div>';
    return;
  }
  await ladeProfil(); // frischer Zaehler
  const n = myProfile?.eingeladen || 0;
  const lf = myProfile?.lioFreunde || {};
  const proFreund = Number(lf.proFreund) || 0, tage = Number(lf.tageNoetig) || 3;
  const bekommen = (Number(lf.gutgeschrieben) || 0) * proFreund, wartend = Number(lf.wartend) || 0;
  const stand = [bekommen ? `${lioText(bekommen)} bekommen` : '', wartend ? `${wartend} ${wartend === 1 ? 'wartet' : 'warten'} noch` : ''].filter(Boolean).join(' · ');
  host.innerHTML = `
    <div class="card inv-kopf">
      <span class="inv-kopf-ico">${icon('user', 'icon')}</span>
      <span class="inv-kopf-text">
        <b>${n ? `${n} ${n === 1 ? 'Freund' : 'Freunde'} eingeladen` : 'Noch niemand eingeladen'}</b>
        <small>${stand || 'Wer sich über deinen Link anmeldet, zählt hier.'}</small>
      </span>
    </div>
    ${proFreund ? `<p class="inv-vorgemerkt inv-lio">${lioSternImg(26)}<span>${proFreund} Lios für jeden Freund, sobald er seine E-Mail-Adresse bestätigt und ${tage} Tage in Folge reingeschaut hat.</span></p>`
    : `<p class="inv-vorgemerkt">${icon('gift', 'icon icon-sm')}<span>Deine Einladungen sind vorgemerkt.</span></p>`}

    <h3 class="inv-h">Dein Einladungslink</h3>
    <button class="inv-link" id="inv-link-box" type="button" aria-label="Link kopieren">
      <span class="inv-link-text">${esc(inviteUrl())}</span>
    </button>
    <div class="form-row inv-knoepfe">
      <button class="btn" id="inv-share" type="button">${icon('share', 'icon icon-sm')} Link teilen</button>
      <button class="btn btn-ghost" id="inv-copy" type="button">Kopieren</button>
    </div>

    <h3 class="inv-h">So läuft es</h3>
    <div class="inv-steps">
      <div class="inv-step"><b>1</b><span>Link teilen, per WhatsApp, Story oder wie du magst.</span></div>
      <div class="inv-step"><b>2</b><span>Dein Freund öffnet ihn und legt ein kostenloses Konto an.</span></div>
      <div class="inv-step"><b>3</b><span>${proFreund ? `Bestätigt er seine E-Mail-Adresse und schaut ${tage} Tage in Folge rein, bekommst du ${proFreund} Lios.` : 'Die Einladung wird bei dir vorgemerkt.'}</span></div>
    </div>`;
  $('#inv-share').onclick = shareInvite;
  $('#inv-copy').onclick = copyInvite;
  $('#inv-link-box').onclick = copyInvite;
}


// =============================================================================
// Lio: die Waehrung von kumulio (1 Lio = 1 Cent)
//
// Den Stand fuehrt nur der Server (myProfile.lio, dazu lioNeu, lioBoni,
// lioSerie und lioFreunde aus /api/profile). Hier wird er nur gezeigt: oben
// rechts in der Wallet (Knopf in den Shop), im Seitenmenue (eigene Karte:
// Stand fuehrt in den Shop, Wochen- und Monats-Bonus zum Abholen), unter der
// Login-Serie im Profil, im Gutschein-Shop und als Schritt der Tour. Jede neue
// Gutschrift fliegt als Stern ins Profilbild oben links bzw. in der Wallet in
// den Lio-Knopf (lioSternFlug) und wird danach quittiert (/api/lio/gesehen),
// damit sie genau einmal fliegt.
// =============================================================================
function lioStand() { return Math.max(0, Math.floor(Number(myProfile?.lio) || 0)); }
function lioWort(n) { return Math.abs(Number(n)) === 1 ? 'Lio' : 'Lios'; }
function lioText(n) { return `${Number(n || 0).toLocaleString('de-DE')} ${lioWort(n)}`; }
// Der Stern als Bild (nie ein Emoji). px = Anzeigegroesse; geladen wird die
// Datei, die auf 2x-Displays scharf bleibt
function lioSternImg(px = 24, cls = 'lio-stern') {
  const datei = px <= 24 ? 48 : px <= 48 ? 96 : 192;
  return `<img class="${cls}" src="/brand/lio-stern-${datei}.webp" width="${px}" height="${px}" alt="" draggable="false" decoding="async">`;
}
// Die Shop-Seiten zeigen nichts aus der Wallet: sie bleiben offen, wenn die
// Wallet sich sperrt (wie die Deal-Seiten)
function istLioSeite(s) { return !!s && (s.art === 'lio-shop' || s.art === 'lio-produkt'); }

let lioGehalten = null;         // solange ein Stern fliegt: der alte Stand (die Zahl springt erst bei der Ankunft)
const lioGeflogen = new Set();  // Gutschriften, die hier schon geflogen sind — auch wenn das Quittieren scheitert
let lioFliegt = false;
let lioShopDaten = null;        // letzter Stand von /api/shop
let lioVerlauf = null;          // letzte Buchungen aus /api/lio

function lioAnzeige() { return lioGehalten ?? lioStand(); }
// data-lio-stand="zahl": nur die Zahl (der Knopf oben in der Wallet), sonst "12 Lios"
// In der Fahne am Shop-Knopf ist wenig Platz bis zum Logo: ab 1.000 kurz
// ("1,2k"). Die genaue Zahl steht im Shop und im aria-label des Knopfs.
function lioKurz(n) {
  if (n < 1000) return Number(n || 0).toLocaleString('de-DE');
  return (Math.floor(n / 100) / 10).toLocaleString('de-DE', { maximumFractionDigits: n >= 100000 ? 0 : 1 }) + 'k';
}
const lioStandText = (el, n) => el.dataset.lioStand === 'zahl' ? lioKurz(n) : lioText(n);
// Alle sichtbaren Staende nachziehen. von: der Wert davor, dann zaehlt die Zahl hoch
function lioStandZeigen({ von = null } = {}) {
  const ziel = lioAnzeige();
  document.querySelectorAll('[data-lio-stand]').forEach(el => {
    if (von == null || von === ziel || reducedMotion()) { el.textContent = lioStandText(el, ziel); return; }
    const t0 = performance.now(), ms = 520;
    const schritt = jetzt => {
      if (!el.isConnected) return;
      const p = Math.min(1, (jetzt - t0) / ms);
      el.textContent = lioStandText(el, Math.round(von + (ziel - von) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(schritt);
    };
    requestAnimationFrame(schritt);
    // Endwert auch dann, wenn rAF pausiert (App im Hintergrund)
    setTimeout(() => { if (el.isConnected) el.textContent = lioStandText(el, lioAnzeige()); }, ms + 120);
    el.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.1)', offset: .35 }, { transform: 'scale(1)' }],
      { duration: 440, easing: 'ease-out' });
  });
  document.querySelectorAll('[data-lio-euro]').forEach(el => { el.textContent = euroFmt(ziel / 100); });
  // Knoepfe, die in den Shop fuehren, sagen den Stand mit (der Screenreader
  // liest sonst nur die nackte Zahl)
  document.querySelectorAll('[data-lio-aria]').forEach(el => {
    el.setAttribute('aria-label', `Gutschein-Shop öffnen. Du hast ${lioText(ziel)}`);
  });
  // Mit mehr Stellen wird der Knopf oben breiter: dann faellt die Tasche weg
  // (look-lio.css; ab drei Stellen bei 360 px, ab vier immer), sonst kaeme er
  // dem Logo zu nahe
}

// ---- Oben rechts in der Wallet: Stern und Stand, fuehrt in den Shop. Nur
// angemeldet und erst, wenn das Profil dieses Kontos da ist (sonst stuende
// dort kurz eine 0 oder der Stand des vorigen Kontos). Ob er zu sehen ist,
// entscheidet look-lio.css (nur in der Wallet, body.wallet-farbe).
let lioProfilVon = '';          // zu welchem Konto myProfile gehoert
function lioKnopfZeigen() {
  const k = $('#btn-lio-top'), ecke = $('#lio-ecke');
  if (!k || !ecke) return;
  const bereit = !!(state.token && myProfile && lioProfilVon && lioProfilVon === state.userName);
  const vorher = ecke.classList.contains('bereit');
  k.classList.toggle('bereit', bereit);
  ecke.classList.toggle('bereit', bereit);
  k.tabIndex = bereit ? 0 : -1;
  // Erscheint der Knopf in der offenen Wallet, zeigt er einmal den Stand
  if (bereit && !vorher && state.activeView === 'wallet') lioFahneZeigen({ spaeter: 450 });
}
$('#btn-lio-top')?.addEventListener('click', () => oeffneLioShop());
$('[data-lio-fahne]')?.addEventListener('click', () => oeffneLioShop());
// Die Fahne mit dem Lio-Stand gleitet links aus dem runden Shop-Knopf heraus
// und nach halten ms wieder hinein (nur transform). Beim Oeffnen der Wallet
// und wenn neue Lios ankommen. Ruhige Darstellung: sie bleibt drin.
let lioFahneUhr = 0, lioFahneStart = 0;
function lioFahneZeigen({ halten = 2400, spaeter = 0, versuch = 0 } = {}) {
  const ecke = $('#lio-ecke');
  if (!ecke || reducedMotion() || document.body.classList.contains('sparsam')) return;
  clearTimeout(lioFahneStart);
  lioFahneStart = setTimeout(() => {
    // Liegt noch etwas darueber (Sperre, Face-ID-Angebot, Update-Log), kurz
    // warten — sonst liefe die Fahne unsichtbar dahinter ab
    if (!lioBuehneFrei() && versuch < 40) { lioFahneZeigen({ halten, spaeter: 500, versuch: versuch + 1 }); return; }
    // Wartet noch ein Stern, oeffnet der die Fahne bei seiner Ankunft
    if (!lioKnopfSichtbar() || lioWartetNoch()) return;
    ecke.classList.add('offen');
    clearTimeout(lioFahneUhr);
    lioFahneUhr = setTimeout(() => ecke.classList.remove('offen'), halten);
  }, spaeter);
}
// Gibt es Gutschriften, die noch nicht geflogen sind? (Dann oeffnet der
// ankommende Stern die Fahne, ein eigenes Ausfahren waere doppelt)
function lioWartetNoch() {
  return (Array.isArray(myProfile?.lioNeu) ? myProfile.lioNeu : []).some(x => x && x.id && !lioGeflogen.has(x.id));
}
// Ist der Knopf gerade zu sehen? (Wallet, angemeldet, nicht gesperrt, keine
// Seite darueber)
function lioKnopfSichtbar() {
  const k = $('#lio-ecke');
  return !!k && k.classList.contains('bereit') && document.body.classList.contains('wallet-farbe')
    && !document.body.classList.contains('wallet-zu')
    && state.activeView === 'wallet' && !wseiteOben() && !topMenuOffen();
}

// Nach jedem Laden des Profils: Menue, Shop-Seiten und neue Gutschriften
let lioProfilTag = '';          // Kalendertag (Berlin) des letzten Profil-Abrufs
function lioBerlinTag() { try { return new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' }); } catch { return new Date().toDateString(); } }
function lioNachProfil() {
  if (!myProfile) return;
  lioProfilTag = lioBerlinTag();
  lioProfilVon = state.userName || '';
  lioZeitMerken(myProfile.lioSerie);
  lioKnopfZeigen();
  if (lioGehalten == null) { renderTmLio(); lioStandZeigen(); }
  for (const s of wseiten()) {
    if (s.art === 'lio-produkt') zeichneLioProdukt(s, { nurWennNeu: true });
    if (s.art === 'lio-shop') lioWegeZeigen(s);
  }
  lioNeuPruefen();
}

// Zurueck in der App an einem neuen Tag (die App war seit gestern offen): das
// Profil zaehlt den Login-Tag — Serie und taeglicher Lio kommen dann auch so
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.token || !myProfile) return;
  if (lioProfilTag && lioProfilTag !== lioBerlinTag()) ladeProfil();
  else lioNeuPruefen();
});

// ---- Seitenmenue: eigene Karte im Lio-Verlauf. Oben der Stand, darunter
// klein sein Wert in Euro ("Wert 0,41 €", wie im Shop-Kopf; zieht ueber
// data-lio-euro mit) — die ganze Zeile fuehrt in den Shop (rechts die
// Glas-Pille "Shop"). Die Regel "1 Lio = 1 Cent" erklaert nur die Tour.
// Darunter Wochen- und Monats-Bonus: offene mit "Abholen", sonst wie viele
// Login-Tage es noch sind (echte Serie vom Server; heute ist schon mitgezaehlt).
function tmLioHtml() {
  if (!myProfile) return '';
  const s = myProfile.lioSerie || {};
  const boni = Array.isArray(myProfile.lioBoni) ? myProfile.lioBoni : [];
  const zeile = (art, name, alle, menge) => {
    const offen = boni.filter(b => b && b.art === art);
    if (offen.length) {
      const summe = offen.reduce((x, b) => x + (Number(b.menge) || 0), 0);
      const tag = Math.round(Number(offen[0].tag) || 0);
      const unter = offen.length === 1 && tag ? `${tag} Tage in Folge geschafft` : `${offen.length}-mal geschafft`;
      return `
        <div class="tm-lio-zeile offen">
          <span class="tm-lio-text"><b>${name}</b><small>${unter}</small></span>
          <button class="tm-lio-abholen" type="button" data-lio-abholen="${art}" aria-label="${name}: ${lioText(summe)} abholen">+${summe} abholen</button>
        </div>`;
    }
    const bis = Math.round(Number(art === 'woche' ? s.bisWoche : s.bisMonat) || 0);
    if (!(bis > 0 && bis <= alle) || !(Number(menge) > 0)) return '';
    const geschafft = alle - bis;
    const balken = art === 'woche'
      ? `<span class="tm-lio-balken woche" aria-hidden="true">${Array.from({ length: alle }, (_, i) => `<i${i < geschafft ? ' class="an"' : ''}></i>`).join('')}</span>`
      : `<span class="tm-lio-balken monat" aria-hidden="true"><i style="transform:scaleX(${(geschafft / alle).toFixed(3)})"></i></span>`;
    return `
      <div class="tm-lio-zeile">
        <span class="tm-lio-text"><b>${name}</b><small>${bis === 1 ? 'morgen' : `noch ${bis} Tage`}</small></span>
        <span class="tm-lio-plus">+${menge}${lioSternImg(16)}</span>
        ${balken}
      </div>`;
  };
  const zeilen = zeile('woche', 'Wochen-Bonus', 7, s.woche) + zeile('monat', 'Monats-Bonus', 30, s.monat);
  return `
    <span class="tm-lio-glanz" aria-hidden="true"></span>
    <button class="tm-lio-kopf" type="button" data-lio-shop data-lio-aria aria-label="Gutschein-Shop öffnen. Du hast ${lioText(lioAnzeige())}">
      <span class="tm-lio-stern">${lioSternImg(44)}</span>
      <span class="tm-lio-stand"><b data-lio-stand>${lioText(lioAnzeige())}</b><small>Wert <span data-lio-euro>${euroFmt(lioAnzeige() / 100)}</span></small></span>
      <span class="tm-lio-shop">${icon('shop', 'icon')}Shop</span>
    </button>
    ${zeilen.trim() ? `<div class="tm-lio-zeilen">${zeilen}</div>` : ''}`;
}
function renderTmLio() {
  const host = $('#tm-lio');
  if (!host) return;
  host.classList.toggle('hidden', !myProfile);
  host.innerHTML = tmLioHtml();
  host.querySelectorAll('[data-lio-abholen]').forEach(b => { b.onclick = () => lioBonusHolen(b.dataset.lioAbholen, b); });
  // Stand antippen: in den Shop (das Menue geht dabei zu)
  const shop = host.querySelector('[data-lio-shop]');
  if (shop) shop.onclick = () => { schliesseTopMenu({ fokus: false }); oeffneLioShop(); };
}

// ---- Tour fuer neue Nutzer: die Lio-Karte im selben Verlauf wie im Menue,
// oben der Stern mit "1 Lio = 1 Cent" (hier bleibt die Regel stehen: wer neu
// ist, hat noch keinen Stand, dessen Wert man zeigen koennte — und die Tour
// soll ja erklaeren, was ein Lio wert ist), darunter die Wege zu Lios. Die Werte
// kommen mit Profil vom Server; ohne Konto (Tour vor der Anmeldung) gelten
// die Regeln, wie sie in server.js stehen (LIO).
const LIO_REGELN = { tag: 1, woche: 3, monat: 10, freund: 10, freundTage: 3 };
function lioTourHtml() {
  const s = myProfile?.lioSerie || {}, f = myProfile?.lioFreunde || {};
  const wert = (x, d) => (Number(x) > 0 ? Math.round(Number(x)) : d);
  const weg = (titel, unter, menge) => `
    <li><span class="tour-lio-text"><b>${titel}</b><small>${unter}</small></span>
      <span class="tour-lio-plus">+${menge}${lioSternImg(16)}</span></li>`;
  return `
    <div class="tour-lio">
      <span class="tm-lio-glanz"></span>
      <div class="tour-lio-kopf">
        <span class="tm-lio-stern">${lioSternImg(44)}</span>
        <span class="tour-lio-titel"><b>1 Lio = 1 Cent</b><small>So sammelst du Lios</small></span>
      </div>
      <ul class="tour-lio-wege">
        ${weg('Jeden Tag reinschauen', 'einmal pro Tag, von selbst', wert(s.proTag, LIO_REGELN.tag))}
        ${weg('7 Tage in Folge', 'im Menü abholen', wert(s.woche, LIO_REGELN.woche))}
        ${weg('30 Tage in Folge', 'im Menü abholen', wert(s.monat, LIO_REGELN.monat))}
        ${weg('Freund einladen', `sobald er seine E-Mail bestätigt und ${wert(f.tageNoetig, LIO_REGELN.freundTage)}&nbsp;Tage in Folge reinschaut`, wert(f.proFreund, LIO_REGELN.freund))}
      </ul>
    </div>`;
}

// Bonus abholen: der Server schreibt gut, der Stern fliegt vom Knopf ins Profil
async function lioBonusHolen(art, knopf) {
  if (!state.token || !myProfile || knopf.disabled) return;
  const ids = (myProfile.lioBoni || []).filter(b => b && b.art === art).map(b => b.id);
  if (!ids.length) return;
  knopf.disabled = true;
  const start = knopf.getBoundingClientRect();
  const vorher = lioAnzeige();
  let menge = 0, letzte = null, fehler = null;
  for (const id of ids) {
    try {
      letzte = await api('/api/lio/bonus', { method: 'POST', body: JSON.stringify({ id }) });
      menge += Number(letzte.menge) || 0;
    } catch (e) {
      fehler = e;
      const d = e.data || {};
      if (Array.isArray(d.lioBoni)) myProfile.lioBoni = d.lioBoni;
      if (Number.isFinite(d.lio)) myProfile.lio = d.lio;
      break;
    }
  }
  if (letzte) { myProfile.lio = letzte.lio; myProfile.lioBoni = letzte.lioBoni; }
  updateReqDot();
  if (!menge) {
    island(fehler?.message || 'Das hat gerade nicht geklappt.');
    if (lioGehalten == null) renderTmLio();
    return;
  }
  knopf.classList.add('fertig');
  knopf.innerHTML = `${icon('check', 'icon icon-sm')}abgeholt`;
  lioGehalten = vorher;
  const name = art === 'monat' ? 'Monats-Bonus' : 'Wochen-Bonus';
  lioSternFlug(menge, {
    von: start, text: `${name}: +${lioText(menge)}`,
    beiAnkunft: () => { lioGehalten = null; renderTmLio(); lioStandZeigen({ von: vorher }); },
  });
}

// ---- Neue Gutschriften (taeglicher Login, eingeladene Freunde, Korrekturen):
// der Stern fliegt, sobald nichts anderes davor liegt, dann wird quittiert
function lioBuehneFrei() {
  if (document.visibilityState !== 'visible' || startAuftrittOffen) return false;
  if (!$('#wallet-sperre')?.classList.contains('hidden')) return false;
  if (state.sheetMode || document.querySelector('.k-splash, #tour, .overlay:not(.hidden)')) return false;
  if ($('#onboard') && !$('#onboard').classList.contains('hidden')) return false;
  // Eine offene Seite verdeckt das Profilbild: nur die Shop-Seiten haben ein eigenes Ziel
  const oben = wseiteOben();
  if (oben && !oben.el.querySelector('[data-lio-ziel]')) return false;
  return true;
}
function lioNeuPruefen(versuch = 0) {
  clearTimeout(lioNeuPruefen.uhr);
  if (!state.token || !myProfile || lioFliegt) return;
  const neu = (Array.isArray(myProfile.lioNeu) ? myProfile.lioNeu : []).filter(x => x && x.id && !lioGeflogen.has(x.id));
  if (!neu.length) return;
  // Das Update-Log darf zuerst (es kommt kurz nach dem Start), danach der Stern
  if (!lioBuehneFrei() || (!neuGeprueft && versuch < 6)) {
    // So lange etwas wartet, weiter schauen (Sperre, Dialoge koennen dauern);
    // nach zwei Minuten nur noch alle paar Sekunden
    lioNeuPruefen.uhr = setTimeout(() => lioNeuPruefen(versuch + 1), versuch < 120 ? 1000 : 4000);
    return;
  }
  // Kurz Luft, damit die Seite erst steht
  if (!lioNeuPruefen.bereit) {
    lioNeuPruefen.bereit = true;
    lioNeuPruefen.uhr = setTimeout(() => lioNeuPruefen(versuch + 1), 650);
    return;
  }
  neu.forEach(x => lioGeflogen.add(x.id));
  const menge = neu.reduce((a, x) => a + Math.max(0, Math.round(Number(x.menge) || 0)), 0);
  const text = neu.length === 1 ? `${neu[0].text || 'Gutschrift'}: +${lioText(menge)}` : `+${lioText(menge)} bekommen`;
  const vorher = Math.max(0, lioStand() - menge);
  lioGehalten = vorher;
  lioStandZeigen();
  lioFliegt = true;
  // Quittiert wird, sobald der Stern angekommen ist (nicht erst am Ende der
  // Animation: wer die App dann schliesst, hat ihn schon gesehen)
  let quittiert = false;
  const quittieren = () => {
    if (quittiert) return;
    quittiert = true;
    api('/api/lio/gesehen', { method: 'POST', body: JSON.stringify({ ids: neu.map(x => x.id) }) })
      .then(r => { if (myProfile && Array.isArray(r.lioNeu)) myProfile.lioNeu = r.lioNeu; })
      .catch(() => { /* hier fliegt er nicht nochmal (lioGeflogen) */ });
  };
  lioSternFlug(menge, {
    text,
    beiAnkunft: () => { lioGehalten = null; renderTmLio(); lioStandZeigen({ von: vorher }); quittieren(); },
  }).finally(() => {
    lioFliegt = false;
    quittieren();
    // Wartet ein Bonus im Menue? Einmal pro Sitzung ein kurzer Hinweis
    const boni = (myProfile?.lioBoni || []).filter(b => b && b.id);
    if (boni.length && !lioNeuPruefen.hinweis) {
      lioNeuPruefen.hinweis = true;
      const wer = boni.length > 1 ? 'Deine Boni warten' : `Dein ${boni[0].art === 'monat' ? 'Monats' : 'Wochen'}-Bonus wartet`;
      setTimeout(() => { if (!topMenuOffen()) island(`${wer} im Menü`); }, 2800);
    }
    lioNeuPruefen();
  });
}

// ---- Der Stern: erscheint (Bildschirmmitte oder am Knopf), dreht sich schnell
// um die eigene Achse und fliegt im Bogen ins Profilbild oben links (in der
// Wallet: in den Stern des Lio-Knopfs oben rechts, bei offenem Menue: ins
// Profilbild im Menue, auf einer Shop-Seite: in deren Stern). Dort federt
// das Ziel kurz und "+N" blendet ein. Mehrere Lios: bis zu fuenf Sterne
// leicht versetzt. Nur transform und opacity (Web Animations),
// alles zu Beginn angelegt — keine Messung waehrend des Flugs. Weniger
// Bewegung, "sparsam" oder Animationen aus: kein Flug, nur "+N" blendet ein.
function lioZiel() {
  const sichtbar = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth ? r : null;
  };
  const nimm = el => { const r = sichtbar(el); return r ? { el, r } : null; };
  if (topMenuOffen()) {
    const m = $('#top-menu');
    return nimm(m.querySelector('.tm-head .avatar-big') || m.querySelector('.tm-head img') || m.querySelector('.tm-head'));
  }
  const oben = wseiteOben();
  if (oben) return nimm(oben.el.querySelector('[data-lio-ziel]'));
  // In der Wallet: in den runden Shop-Knopf oben rechts; bei der Ankunft
  // gleitet die Fahne mit dem Stand heraus (ecke). "+N" steht unter dem Knopf.
  if (lioKnopfSichtbar()) {
    const k = $('#btn-lio-top');
    const z = nimm(k);
    if (z) return { ...z, unter: k.getBoundingClientRect(), ecke: true };
  }
  return nimm($('#btn-profile-top'));
}
function lioFlugEbene() {
  let e = $('#lio-flug');
  if (!e) {
    e = document.createElement('div');
    e.id = 'lio-flug';
    e.setAttribute('aria-hidden', 'true');
    document.body.appendChild(e);
  }
  return e;
}
function lioSternFlug(menge, { von = null, text = '', beiAnkunft = null } = {}) {
  menge = Math.max(0, Math.round(Number(menge) || 0));
  let angekommen = false;
  const ankunft = () => {
    if (angekommen) return;
    angekommen = true;
    try { beiAnkunft?.(); } catch { /* die Anzeige darf den Flug nicht aufhalten */ }
  };
  if (!menge) { ankunft(); return Promise.resolve(); }
  const ziel = lioZiel();
  // Ziel ist der Shop-Knopf der Wallet: dort zeigt die Fahne den neuen Stand
  if (ziel && ziel.ecke) { const vorher = beiAnkunft; beiAnkunft = () => { vorher?.(); lioFahneZeigen({ halten: 2600 }); }; }
  const ruhig = reducedMotion() || document.body.classList.contains('sparsam') || !document.body.animate;
  if (!ziel) { ankunft(); if (text) island(text); return Promise.resolve(); }
  const ebene = lioFlugEbene();
  const zr = ziel.r;
  // "+N" sitzt unten rechts am Ziel, wie ein kleines Abzeichen
  const plus = document.createElement('div');
  plus.className = 'lio-plus';
  plus.textContent = '+' + menge.toLocaleString('de-DE');
  ebene.appendChild(plus);
  // Am Lio-Knopf rechtsbuendig darunter (die Zahl zaehlt dort sichtbar hoch):
  // buendig mit dem weissen Ring (2 px, box-shadow) und von rechts aus
  // skaliert, damit "+N" beim Federn nicht ueber die Kante hinaus waechst
  const ku = ziel.unter;
  // Am grossen Stern im Shop-Kopf bleibt es in dessen Feld (rechtsbuendig,
  // der Ring schliesst mit der Kante ab): gleich rechts daneben steht
  // "Wert 0,41 €", weiter aussen deckte "+N" dessen erste Buchstaben zu
  const imFeld = !ku && ziel.el.hasAttribute('data-lsh-stern');
  if (ku || imFeld) plus.style.transformOrigin = 'right center';
  const lx = ku ? ku.right - 2 - plus.offsetWidth
    : imFeld ? zr.right - 2 - plus.offsetWidth
      : Math.min(innerWidth - 60, zr.right - 14);
  const ly = ku ? ku.bottom + 6 : zr.bottom - 20;
  const lt = (dy, s) => `translate3d(${lx.toFixed(1)}px, ${(ly + dy).toFixed(1)}px, 0) scale(${s})`;
  const weg = [plus];
  const anims = [];
  const ende = (dauer) => Promise.race([
    Promise.all(anims.map(a => a.finished.catch(() => { }))),
    new Promise(r => setTimeout(r, dauer)),
  ]).then(() => {
    anims.forEach(a => { try { a.cancel(); } catch { } });
    weg.forEach(el => el.remove());
  });

  if (ruhig) {
    plus.style.transform = lt(0, 1);
    if (plus.animate) anims.push(plus.animate([{ opacity: 0 }, { opacity: 1, offset: .15 }, { opacity: 1, offset: .75 }, { opacity: 0 }], { duration: 1500, easing: 'ease-out' }));
    ankunft();
    if (text) island(text);
    playSfx('coin', .45);
    return ende(1700);
  }

  const n = Math.min(5, menge);
  const T_AUF = von ? 380 : 600;     // erscheinen, dann schnell drehen
  const T_FLUG = 700;                // Bogen ins Profil
  const VERSATZ = 110;               // zwischen den Sternen
  const D = T_AUF + T_FLUG;
  const aufAnteil = T_AUF / D;
  const S0 = von
    ? { x: von.left + von.width / 2, y: von.top + von.height / 2 }
    : { x: innerWidth / 2, y: innerHeight * .44 };
  const E = { x: zr.left + zr.width / 2, y: zr.top + zr.height / 2 };
  const tr = (p, s) => `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) scale(${s.toFixed(3)})`;

  // Ein weicher Schein, wo der Stern auftaucht
  const glanz = document.createElement('div');
  glanz.className = 'lio-glanz';
  ebene.appendChild(glanz);
  weg.push(glanz);
  anims.push(glanz.animate([
    { transform: tr(S0, .3), opacity: 0 },
    { transform: tr(S0, 1), opacity: .95, offset: .3 },
    { transform: tr(S0, 1.6), opacity: 0 },
  ], { duration: T_AUF + 260, easing: 'ease-out', fill: 'both' }));

  for (let i = 0; i < n; i++) {
    const w = (-90 + i * 360 / n) * Math.PI / 180;
    const rad = n > 1 ? (von ? 12 : 30) : 0;
    const S = { x: S0.x + Math.cos(w) * rad, y: S0.y + Math.sin(w) * rad };
    const dx = E.x - S.x, dy = E.y - S.y, len = Math.hypot(dx, dy) || 1;
    // Bogen: der Kontrollpunkt liegt seitlich der Geraden, auf der oberen Seite
    let px = -dy / len, py = dx / len;
    if (py > 0) { px = -px; py = -py; }
    const bogen = len * (.24 + .05 * (i % 3));
    const C = { x: (S.x + E.x) / 2 + px * bogen, y: (S.y + E.y) / 2 + py * bogen };
    const punkt = t => ({
      x: (1 - t) * (1 - t) * S.x + 2 * (1 - t) * t * C.x + t * t * E.x,
      y: (1 - t) * (1 - t) * S.y + 2 * (1 - t) * t * C.y + t * t * E.y,
    });
    const kf = [
      { offset: 0, transform: tr(S, .2), opacity: 0 },
      { offset: aufAnteil * .4, transform: tr(S, 1.22), opacity: 1 },
      { offset: aufAnteil, transform: tr(S, 1), opacity: 1 },
    ];
    const SCHRITTE = 16;
    for (let k = 1; k <= SCHRITTE; k++) {
      const u = k / SCHRITTE;
      const e = u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      const s = u < .2 ? 1 + .14 * (u / .2) : 1.14 - .82 * ((u - .2) / .8);
      kf.push({ offset: aufAnteil + (1 - aufAnteil) * u, transform: tr(punkt(e), s), opacity: u < .8 ? 1 : Math.max(0, 1 - (u - .8) / .2) });
    }
    const el = document.createElement('div');
    el.className = 'lio-flieger';
    el.innerHTML = '<img src="/brand/lio-stern-192.webp" alt="" draggable="false">';
    ebene.appendChild(el);
    weg.push(el);
    const delay = i * VERSATZ;
    anims.push(el.animate(kf, { duration: D, delay, easing: 'linear', fill: 'both' }));
    // Die Drehung: erst von vorn auftauchen, dann schnell um die eigene Achse
    // (wie eine Muenze), im Flug ruhiger mit etwas Schraeglage
    const seite = i % 2 ? 1 : -1;
    anims.push(el.firstChild.animate([
      { transform: 'rotateY(0deg) rotate(0deg)' },
      { transform: 'rotateY(0deg) rotate(0deg)', offset: aufAnteil * .3, easing: 'cubic-bezier(.45, 0, .55, 1)' },
      { transform: 'rotateY(1080deg) rotate(0deg)', offset: aufAnteil },
      { transform: `rotateY(1440deg) rotate(${24 * seite}deg)` },
    ], { duration: D, delay, fill: 'both' }));
  }

  // Ankunft: das Ziel federt, "+N" blendet ein, Zahl zaehlt hoch
  const an = D - 30;
  const nach = (n - 1) * VERSATZ;
  const popDauer = 440 + nach;
  const popKf = n > 1
    ? [{ transform: 'scale(1)' }, { transform: 'scale(1.16)', offset: 110 / popDauer }, { transform: 'scale(1.1)', offset: (nach + 110) / popDauer }, { transform: 'scale(1)' }]
    : [{ transform: 'scale(1)' }, { transform: 'scale(1.16)', offset: .25 }, { transform: 'scale(1)' }];
  try { anims.push(ziel.el.animate(popKf, { duration: popDauer, delay: an, easing: 'ease-out', composite: 'add' })); } catch { /* ohne Federn */ }
  anims.push(plus.animate([
    { transform: lt(6, .6), opacity: 0 },
    { transform: lt(0, 1.1), opacity: 1, offset: .12 },
    { transform: lt(-2, 1), opacity: 1, offset: .62 },
    { transform: lt(-14, 1), opacity: 0 },
  ], { duration: 1400 + nach, delay: an, easing: 'ease-out', fill: 'both' }));
  setTimeout(() => {
    ankunft();
    playSfx('coin', .45);
    buzz(12);
    if (text) setTimeout(() => island(text), 120);
  }, an);
  return ende(an + 1400 + nach + 400);
}

// ---- Gutschein-Shop: eigene Seite im Seitenstapel (wie Raenge und Analyse).
// Oben der Lio-Stand, darunter die Gutscheine (ausverkaufte grau, aber
// ansehbar), wie man Lios sammelt und die letzten Buchungen.
function oeffneLioShop() {
  if (!state.token) { island('Zum Gutschein-Shop bitte anmelden'); return; }
  if (wseiteOben()?.art === 'lio-shop') return;
  buzz(8);
  wseiteOeffnen({
    art: 'lio-shop', titel: 'Gutschein-Shop', klasse: 'lsh',
    baue: s => {
      zeichneLioShop(s);
      lioShopLaden();
      lioUhrStart(s);
      s.beimSchliessen = () => lioUhrStopp(s);
    },
  });
}
async function lioShopLaden() {
  const [shop, lio, me] = await Promise.allSettled([api('/api/shop'), api('/api/lio'), api('/api/me')]);
  if (shop.status === 'fulfilled') lioShopDaten = shop.value;
  lioShopLaden.fehler = shop.status !== 'fulfilled' && !lioShopDaten;
  if (lio.status === 'fulfilled') {
    lioVerlauf = Array.isArray(lio.value.log) ? lio.value.log : [];
    if (myProfile && Number.isFinite(lio.value.lio)) myProfile.lio = lio.value.lio;
    // Serie und offene Boni frisch fuer "So sammelst du Lios"
    if (myProfile && lio.value.lioSerie) { myProfile.lioSerie = lio.value.lioSerie; lioZeitMerken(lio.value.lioSerie); }
    if (myProfile && Array.isArray(lio.value.lioBoni)) myProfile.lioBoni = lio.value.lioBoni;
  }
  // Ob die E-Mail inzwischen bestaetigt ist, entscheidet ueber den Kauf
  if (me.status === 'fulfilled') kontoInfo = { ...(kontoInfo || {}), ...me.value };
  for (const s of wseiten()) {
    if (s.art === 'lio-shop') zeichneLioShop(s);
    if (s.art === 'lio-produkt') zeichneLioProdukt(s, { nurWennNeu: true });
  }
  if (lioGehalten == null) lioStandZeigen();
}
function lioProdukt(id) { return (lioShopDaten?.produkte || []).find(x => x && x.id === id) || null; }
function lioAusverkauft(p) { return !!p && (p.ausverkauft || !p.verfuegbar); }
// Das blasse Logo hinten auf der Karte nur mit eigener Logo-Datei — ein
// Favicon (Amazon) waere gross nur ein helles Quadrat
function lioMotivHtml(p, cls) {
  return MARKEN_LOGOS[String(p.marke || '').toLowerCase().trim()]
    ? `<span class="vk-motiv ${cls}" aria-hidden="true">${vkMotivHtml({ vendor: p.marke })}</span>` : '';
}

// Das echte Kartenbild des Gutscheins (vom Nutzer), sonst ''
function lioKartenBildHtml(p, cls, breite) {
  const b = /^[a-z0-9-]{1,40}$/.test(p?.bild || '') ? '/brand/shop/' + p.bild : '';
  return b ? `<img class="${cls}" src="${b}-320.webp" srcset="${b}-320.webp 320w, ${b}-640.webp 640w" sizes="${breite}px"
    alt="" decoding="async" draggable="false">` : '';
}
// "Dein Gutschein" / "Deine Geschenkkarte"
const lioArtikel = name => /karte$/i.test(String(name || '').trim()) ? 'Deine' : 'Dein';

// In der Liste: das Kartenbild (sonst die kleine Karte im Markenton wie in
// der Wallet), daneben Name und Wert, darunter der Preis
function lioProduktKarteHtml(p) {
  const aus = lioAusverkauft(p);
  const farbe = brandColor(p.marke);
  const bild = lioKartenBildHtml(p, 'lsh-bild', 112);
  return `
    <button class="gd-block lsh-produkt${aus ? ' aus' : ''}" type="button" data-lsh-produkt="${esc(p.id)}"
      aria-label="${esc(p.name)}, ${euroFmt(p.wert)}, ${lioText(p.preisLio)}${aus ? ', ausverkauft' : ''}">
      ${bild ? `<span class="lsh-karte mit-bild">
        <span class="lsh-bild-rahmen">${bild}</span>
        <span class="lsh-karte-namen"><b>${esc(p.marke)}</b><small>${esc(p.name)}</small></span>
        <b class="lsh-karte-wert">${euroFmt(p.wert)}</b>
      </span>` : `<span class="lsh-karte${brandHelligkeit(farbe) > 0.62 ? ' hell' : ''}" style="--bc:${farbe}; --tc:${brandTextColor(p.marke)}">
        ${lioMotivHtml(p, 'lsh-motiv')}
        <span class="vk-logo">${brandChipHtml(p.marke)}</span>
        <span class="lsh-karte-namen"><b>${esc(p.marke)}</b><small>Gutschein</small></span>
        <b class="lsh-karte-wert">${euroFmt(p.wert)}</b>
      </span>`}
      <span class="lsh-fuss">
        <span class="lsh-preis">${lioSternImg(22)}<b>${lioText(p.preisLio)}</b>${p.preisEuro ? `<small>oder ${euroFmt(p.preisEuro)}</small>` : ''}</span>
        ${aus ? '<span class="lsh-status">Ausverkauft</span>' : ''}
        ${icon('chevron', 'icon icon-sm lsh-pfeil')}
      </span>
    </button>`;
}
// ---- So sammelst du Lios (Shop). Links so viele Sterne, wie es gibt (1, 3,
// ab 5 ein Haufen aus zehn mit der Zahl daran), rechts der echte Stand statt
// "+N": heute abgeholt und die Zeit bis zum naechsten (00:00 in Berlin), die
// Serie bis zur Woche/zum Monat, ein wartender Bonus. Erklaerung nur noch bei
// "Freund einladen".
//
// Zeit: der taegliche Lio kommt je Kalendertag in Europe/Berlin — der naechste
// also um 00:00 dort, auch ueber die Zeitumstellung (Intl). Gezaehlt wird mit
// der Serverzeit (lioSerie.jetzt), damit eine falsch gehende Handy-Uhr den
// Wechsel nicht verschiebt; unter 3 s Abweichung zaehlt die eigene Uhr (sonst
// sprangen die Sekunden bei jedem Abruf).
let lioZeitVersatz = 0;
function lioZeitMerken(serie) {
  const v = Number(serie?.jetzt) - Date.now();
  if (Number.isFinite(v)) lioZeitVersatz = Math.abs(v) > 3000 ? v : 0;
}
const lioJetzt = () => Date.now() + lioZeitVersatz;
const LIO_BERLIN = (() => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return null; }
})();
function lioBerlinTeile(ts) {
  const d = new Date(ts);
  if (!LIO_BERLIN) return { j: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
  const t = {};
  for (const p of LIO_BERLIN.formatToParts(d)) t[p.type] = p.value;
  return { j: +t.year, m: +t.month, d: +t.day, h: (+t.hour) % 24, mi: +t.minute, s: +t.second };
}
// "2026-09-25" — wie berlinTag() am Server
function lioBerlinIso(ts) {
  const t = lioBerlinTeile(ts);
  return `${t.j}-${String(t.m).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`;
}
// Der naechste 00:00-Zeitpunkt in Berlin nach ts. Der Abstand Berlin/UTC wird
// am Ziel nachgemessen: am Tag der Zeitumstellung hat der Tag 23 oder 25 Stunden
function lioNaechsteMitternacht(ts) {
  const abstand = x => { const t = lioBerlinTeile(x); return Date.UTC(t.j, t.m - 1, t.d, t.h, t.mi, t.s) - Math.floor(x / 1000) * 1000; };
  const t = lioBerlinTeile(ts);
  const wand = Date.UTC(t.j, t.m - 1, t.d + 1);
  return wand - abstand(wand - abstand(ts));
}
// "05:12:33"
function lioUhrText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const zz = n => String(n).padStart(2, '0');
  return `${zz(Math.floor(s / 3600))}:${zz(Math.floor(s / 60) % 60)}:${zz(s % 60)}`;
}
// Jede Ziffer in einer festen Zelle (1ch): nicht jede Schrift kennt
// tabular-nums (Segoe UI Variable am Windows-Rechner), sonst wackelt die
// Zeile jede Sekunde ein Stueck hin und her
function lioUhrHtml(txt) { return String(txt).replace(/\d/g, d => `<i>${d}</i>`); }
// Der taegliche Lio heute: gebucht (laut Server, fuer den heutigen Berliner
// Tag)? rest = ms bis zum naechsten
function lioTagStand() {
  const s = myProfile?.lioSerie || {};
  const jetzt = lioJetzt();
  const heute = lioBerlinIso(jetzt);
  const abgeholt = 'lioHeute' in s ? !!s.lioHeute && s.tag === heute : !!s.heute && lioProfilTag === lioBerlinTag();
  return { abgeholt, heute, rest: lioNaechsteMitternacht(jetzt) - jetzt };
}
// Noch nicht gebucht (die App war ueber Mitternacht offen): das Profil neu
// holen — der Server bucht den Lio beim Abruf, der Stern fliegt dann in den
// Kopf des Shops. Bis zu drei Versuche je Tag, ab dem zweiten mit 2,5 s
// Abstand: geht die Handy-Uhr ein, zwei Sekunden vor (unter der Schwelle von
// lioZeitMerken), ist beim Server um Mitternacht noch gestern. Klappt es gar
// nicht, kommt er beim naechsten Oeffnen.
function lioTagNachholen(heute) {
  if (!state.token || lioTagNachholen.laeuft) return;
  if (lioTagNachholen.tag !== heute) { lioTagNachholen.tag = heute; lioTagNachholen.versuche = 0; }
  if (lioTagNachholen.versuche >= 3) return;
  const pause = lioTagNachholen.versuche++ ? 2500 : 0;
  lioTagNachholen.laeuft = true;
  new Promise(r => setTimeout(r, pause)).then(() => ladeProfil()).catch(() => { }).finally(() => {
    lioTagNachholen.laeuft = false;
    for (const s of wseiten()) if (s.art === 'lio-shop') lioWegeZeigen(s);
  });
}

// Die Sterne links: 1 gross, 2-4 im Faecher, ab 5 ein Haufen aus zehn (4-3-2-1)
// mit der Zahl als Abzeichen oben rechts
function lioWegSterneHtml(menge) {
  const n = Math.max(1, Math.round(Number(menge) || 0));
  if (n === 1) return `<span class="lsh-weg-ico eins">${lioSternImg(28)}</span>`;
  if (n <= 4) {
    // Faecher: der mittlere oben, die anderen tiefer und schraeg daneben
    const plaetze = n === 2 ? [[-1, 0], [1, 0]] : n === 3 ? [[-1, 0], [1, 0], [0, 1]] : [[-1.5, 0], [1.5, 0], [-.5, 1], [.5, 1]];
    return `<span class="lsh-weg-ico faecher n${n}">${plaetze.map(([x, oben]) =>
      `<i${oben ? ' class="oben"' : ''} style="--x:${x}">${lioSternImg(oben ? 20 : 16)}</i>`).join('')}</span>`;
  }
  let haufen = '';
  [4, 3, 2, 1].forEach((k, reihe) => {
    for (let i = 0; i < k; i++) haufen += `<i style="--x:${(i - (k - 1) / 2).toFixed(1)}; --y:${reihe}">${lioSternImg(11)}</i>`;
  });
  return `<span class="lsh-weg-ico haufen">${haufen}<b class="lsh-weg-zahl">${n.toLocaleString('de-DE')}</b></span>`;
}
// Rechts: Serie als "4/7" mit Balken (Woche in sieben Stuecken wie im Menue),
// ein wartender Bonus als "+3 bereit" (abgeholt wird im Menue)
function lioWegSerieHtml(art, alle, s, boni) {
  const offen = boni.filter(b => b && b.art === art);
  if (offen.length) {
    const summe = offen.reduce((x, b) => x + (Number(b.menge) || 0), 0);
    // Kurz: "im Menü abholen" drueckte bei 360 px "30 Tage in Folge" in zwei Zeilen
    return `<span class="lsh-weg-stand"><span class="lsh-bereit">+${summe.toLocaleString('de-DE')} bereit</span><small>im Menü</small></span>`;
  }
  const tage = Math.max(0, Math.round(Number(s.tage) || 0));
  // Am Tag, an dem die Woche voll wird, steht sie voll da (morgen geht es mit 1 weiter)
  const geschafft = tage > 0 && tage % alle === 0 ? alle : tage % alle;
  const balken = alle <= 7
    ? `<span class="lsh-balken woche" aria-hidden="true">${Array.from({ length: alle }, (_, i) => `<i${i < geschafft ? ' class="an"' : ''}></i>`).join('')}</span>`
    : `<span class="lsh-balken monat" aria-hidden="true"><i style="transform:scaleX(${(geschafft / alle).toFixed(3)})"></i></span>`;
  return `<span class="lsh-weg-stand"><b class="lsh-weg-tage${geschafft === alle ? ' voll' : ''}">${geschafft}/${alle}<span class="lsh-vh"> Tage</span></b>${balken}</span>`;
}
function lioWegTagHtml() {
  const t = lioTagStand();
  if (t.abgeholt) return `
    <span class="lsh-weg-stand tag">
      <span class="lsh-abgeholt">${icon('check', 'icon')}Abgeholt</span>
      <small>Nächster in <b data-lio-uhr>${lioUhrHtml(lioUhrText(t.rest))}</b></small>
    </span>`;
  return `
    <span class="lsh-weg-stand tag">
      <span class="lsh-offen">${lioTagNachholen.laeuft ? 'Kommt gleich' : 'Noch offen'}</span>
      <small>${lioTagNachholen.laeuft ? 'wird gebucht …' : 'beim nächsten Öffnen'}</small>
    </span>`;
}
function lioWegeHtml() {
  const s = myProfile?.lioSerie || {};
  const f = myProfile?.lioFreunde || {};
  const boni = Array.isArray(myProfile?.lioBoni) ? myProfile.lioBoni : [];
  const weg = ({ menge, titel, unter = '', rechts = '', attr = '', pfeil = false }) => {
    menge = Math.round(Number(menge) || 0);
    if (!(menge > 0)) return '';
    const tag = attr ? 'button type="button"' : 'div';
    return `
    <${tag} class="lsh-weg"${attr}>
      <span aria-hidden="true">${lioWegSterneHtml(menge)}</span>
      <span class="lsh-weg-text"><b>${titel}</b>${unter ? `<small>${unter}</small>` : ''}<span class="lsh-vh">: ${lioText(menge)}</span></span>
      ${rechts}
      ${pfeil ? icon('chevron', 'icon icon-sm lsh-pfeil') : ''}
    </${attr ? 'button' : 'div'}>`;
  };
  const bereit = art => boni.some(b => b && b.art === art);
  return [
    weg({ menge: s.proTag, titel: 'Jeden Tag reinschauen', rechts: lioWegTagHtml() }),
    weg({ menge: s.woche, titel: '7 Tage in Folge', rechts: lioWegSerieHtml('woche', 7, s, boni), ...(bereit('woche') ? { attr: ' data-lsh-menue', pfeil: true } : {}) }),
    weg({ menge: s.monat, titel: '30 Tage in Folge', rechts: lioWegSerieHtml('monat', 30, s, boni), ...(bereit('monat') ? { attr: ' data-lsh-menue', pfeil: true } : {}) }),
    weg({ menge: f.proFreund, titel: 'Freund einladen', unter: `sobald er seine E-Mail bestätigt und ${Number(f.tageNoetig) || 3} Tage in Folge reinschaut`, attr: ' data-lsh-einladen', pfeil: true }),
  ].join('');
}
// Nur neu zeichnen, wenn sich etwas geaendert hat (der Countdown selbst
// tickt in lioUhrStart nur als Text)
function lioWegeZeigen(seite) {
  const host = seite?.el.querySelector('.lsh-wege');
  if (!host) return;
  let t = lioTagStand();
  if (!t.abgeholt && !lioTagNachholen.laeuft) { lioTagNachholen(t.heute); t = lioTagStand(); }
  const s = myProfile?.lioSerie || {};
  const schluessel = JSON.stringify([t.abgeholt, t.heute, !!lioTagNachholen.laeuft, s.tage, s.proTag, s.woche, s.monat,
    (myProfile?.lioBoni || []).map(b => b && b.id), myProfile?.lioFreunde]);
  if (host.dataset.stand !== schluessel) {
    host.dataset.stand = schluessel;
    host.innerHTML = lioWegeHtml();
    host.querySelector('[data-lsh-einladen]')?.addEventListener('click', () => { wseitenZu(); switchView('invite', 'enter-drop'); });
    host.querySelectorAll('[data-lsh-menue]').forEach(b => b.addEventListener('click', () => { wseitenZu(); oeffneTopMenu(); }));
  }
}
// Der Countdown: jede volle Sekunde, nur solange die Shop-Seite offen und die
// App sichtbar ist (verdeckt eine Seite darueber den Shop, bleibt der Text stehen)
function lioUhrStart(seite) {
  lioUhrStopp(seite);
  const tick = () => {
    seite.uhr = 0;
    if (!seite.el.isConnected || document.visibilityState !== 'visible') return;
    if (!seite.el.classList.contains('verdeckt')) {
      const t = lioTagStand();
      const el = seite.el.querySelector('[data-lio-uhr]');
      if (el && t.abgeholt) { const txt = lioUhrText(t.rest); if (el.textContent !== txt) el.innerHTML = lioUhrHtml(txt); }
      else lioWegeZeigen(seite);
    }
    seite.uhr = setTimeout(tick, 1000 - (lioJetzt() % 1000) + 20);
  };
  tick();
}
function lioUhrStopp(seite) { if (seite?.uhr) clearTimeout(seite.uhr); if (seite) seite.uhr = 0; }
document.addEventListener('visibilitychange', () => {
  for (const s of wseiten()) {
    if (s.art !== 'lio-shop') continue;
    if (document.visibilityState === 'visible') lioUhrStart(s); else lioUhrStopp(s);
  }
});

// ---- Der grosse Stern im Shop-Kopf: antippen, dann dreht er sich wie eine
// Muenze um die senkrechte Achse (schnell los, weich auslaufend, am Ende ein
// kleines Nachwippen), huepft ein Stueck und sprueht ein paar Funken. Tippt
// man waehrend der Drehung nochmal, geht es von der aktuellen Stellung aus
// mit neuem Schwung weiter — ohne Ruck. Drei Ebenen, damit sich nichts in die
// Quere kommt: der Knopf federt bei der Ankunft eines Lio-Sterns, darin huepft
// .lsh-huepf, darin dreht sich das Bild. Nur transform und opacity.
// Weniger Bewegung / Animationen aus: nur ein kurzes Pulsieren.
function lioSternDrehen(knopf) {
  const huepf = knopf.querySelector('.lsh-huepf');
  const stern = huepf?.querySelector('.lio-stern');
  if (!stern || !stern.animate) return;
  buzz(6);
  if (reducedMotion()) {
    huepf.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.07)', offset: .4 }, { transform: 'scale(1)' }],
      { duration: 360, easing: 'ease-out' });
    return;
  }
  // Wo steht er gerade? (rotateY: m11 = cos, m13 = -sin)
  let von = 0;
  const laeuft = knopf._dreh && knopf._dreh.playState === 'running';
  if (laeuft) {
    try {
      const m = new DOMMatrixReadOnly(getComputedStyle(stern).transform);
      von = (Math.atan2(-m.m13, m.m11) * 180 / Math.PI + 360) % 360;
    } catch { von = 0; }
  }
  // Zwei Umdrehungen, beim Nachtippen von der aktuellen Stellung aus
  // mindestens zwei weitere — immer bis wieder vorn. Hoechstens gut 30 Grad
  // je Bild (60 Hz) am Anfang: schneller sah es nach Flackern statt Drehen aus
  const bis = Math.ceil((von + 720) / 360) * 360;
  knopf._dreh?.cancel();
  knopf._dreh = stern.animate([
    { transform: `rotateY(${von}deg)`, easing: 'cubic-bezier(.24, .76, .3, 1)' },
    { transform: `rotateY(${bis + 14}deg)`, offset: .84, easing: 'cubic-bezier(.45, 0, .55, 1)' },
    { transform: `rotateY(${bis - 5}deg)`, offset: .93, easing: 'ease-in-out' },
    { transform: `rotateY(${bis}deg)` },
  ], { duration: laeuft ? 1600 : 1550 });
  // Huepfer: addiert sich zu einem laufenden (zweimal tippen = etwas hoeher)
  const hoch = laeuft ? 4 : 7;
  huepf.animate([
    { transform: 'translateY(0) scale(1)', easing: 'cubic-bezier(.2, .8, .3, 1)' },
    { transform: `translateY(${-hoch}px) scale(${laeuft ? 1.03 : 1.09})`, offset: .3, easing: 'cubic-bezier(.5, 0, .7, .4)' },
    { transform: 'translateY(0) scale(1)', offset: .72, easing: 'ease-out' },
    { transform: 'translateY(0) scale(1)' },
  ], { duration: 900, composite: 'add' });
  if (document.body.classList.contains('sparsam')) return;
  // Schein hinter dem Stern und Funken nach aussen
  const ebene = knopf.querySelector('.lsh-funken');
  if (!ebene) return;
  const schein = document.createElement('span');
  schein.className = 'lsh-schein';
  ebene.appendChild(schein);
  schein.animate([
    { transform: 'scale(.5)', opacity: 0 },
    { transform: 'scale(1)', opacity: .9, offset: .25 },
    { transform: 'scale(1.35)', opacity: 0 },
  ], { duration: 760, easing: 'ease-out' }).finished.catch(() => { }).finally(() => schein.remove());
  // Nicht mehr als drei Wellen gleichzeitig im Baum
  const alte = ebene.querySelectorAll('.lsh-funke');
  if (alte.length > 14) [...alte].slice(0, alte.length - 14).forEach(x => x.remove());
  const n = 7, dreh = Math.random() * 360;
  for (let i = 0; i < n; i++) {
    const w = (dreh + i * 360 / n + (Math.random() - .5) * 24) * Math.PI / 180;
    const weit = 42 + Math.random() * 18;
    const gr = .65 + Math.random() * .5;
    const x = Math.cos(w) * weit, y = Math.sin(w) * weit * .9;
    const f = document.createElement('i');
    f.className = 'lsh-funke';
    f.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 0C12.9 7.2 16.8 11.1 24 12 16.8 12.9 12.9 16.8 12 24 11.1 16.8 7.2 12.9 0 12 7.2 11.1 11.1 7.2 12 0Z"/></svg>';
    ebene.appendChild(f);
    f.animate([
      { transform: `translate(0, 0) scale(.2) rotate(0deg)`, opacity: 0 },
      { transform: `translate(${(x * .55).toFixed(1)}px, ${(y * .55).toFixed(1)}px) scale(${gr.toFixed(2)}) rotate(45deg)`, opacity: 1, offset: .35 },
      { transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${(gr * .4).toFixed(2)}) rotate(110deg)`, opacity: 0 },
    ], { duration: 640 + Math.random() * 260, delay: 60 + i * 12, easing: 'cubic-bezier(.2, .7, .3, 1)', fill: 'backwards' })
      .finished.catch(() => { }).finally(() => f.remove());
  }
}
function zeichneLioShop(seite) {
  const inhalt = seite.el.querySelector('.wseite-inhalt');
  if (!inhalt) return;
  const d = lioShopDaten;
  const stand = lioAnzeige();
  const produkte = d ? (d.produkte || []).filter(Boolean) : null;
  const liste = produkte == null
    ? (lioShopLaden.fehler
      ? `<div class="gd-block lsh-leer"><p>Der Shop lädt gerade nicht.</p><button class="gd-los leise" type="button" data-lsh-neu>Nochmal versuchen</button></div>`
      : `<div class="gd-block lsh-leer"><p>Lade Gutscheine …</p></div>`)
    : produkte.length ? produkte.map(lioProduktKarteHtml).join('')
      : '<div class="gd-block lsh-leer"><p>Gerade gibt es hier keine Gutscheine.</p></div>';
  // So kommen Lios dazu (die Werte kommen vom Server, gezeichnet von lioWegeZeigen)
  const wege = !!lioWegeHtml().trim();
  const zeit = ts => new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const verlauf = (lioVerlauf || []).slice(0, 5).map(e => {
    const plus = Number(e.delta) > 0;
    return `
      <div class="gd-tx lsh-tx">
        <span class="gd-tx-zeichen ${plus ? 'plus lio' : 'minus'}">${plus ? lioSternImg(20) : icon('shop', 'icon')}</span>
        <span class="gd-tx-text"><b>${esc(e.text || (plus ? 'Gutschrift' : 'Einkauf'))}</b><small>${zeit(e.ts)}</small></span>
        <span class="gd-tx-betrag ${plus ? 'plus' : 'minus'}">${plus ? '+' : '−'}${Math.abs(Number(e.delta) || 0).toLocaleString('de-DE')}</span>
      </div>`;
  }).join('');
  const rest = `
    <h3 class="gd-h">Gutscheine</h3>
    <div class="lsh-liste">${liste}</div>
    ${wege ? '<h3 class="gd-h">So sammelst du Lios</h3><div class="gd-block lsh-wege"></div>' : ''}
    ${verlauf ? `<h3 class="gd-h">Zuletzt</h3><div class="gd-block gd-verlauf lsh-verlauf">${verlauf}</div>` : ''}`;
  // Steht der Kopf schon, bleibt er stehen und bekommt nur Stand und Wert neu:
  // die Daten kommen kurz nach dem Oeffnen, ein Neuzeichnen braeche eine
  // laufende Drehung des Sterns (oder sein Federn bei der Ankunft eines
  // Lio-Sterns) mittendrin ab
  const alterKopf = inhalt.querySelector(':scope > .lsh-kopf');
  if (alterKopf) {
    while (alterKopf.nextSibling) alterKopf.nextSibling.remove();
    alterKopf.insertAdjacentHTML('afterend', rest);
    const zahl = alterKopf.querySelector('[data-lio-stand]');
    if (zahl) zahl.textContent = lioText(stand);
    const euro = alterKopf.querySelector('[data-lio-euro]');
    if (euro) euro.textContent = euroFmt(stand / 100);
  } else {
    inhalt.innerHTML = `
    <div class="lsh-kopf">
      <button class="lsh-kopf-stern" type="button" data-lio-ziel data-lsh-stern aria-label="Stern drehen">
        <span class="lsh-funken" aria-hidden="true"></span>
        <span class="lsh-huepf" aria-hidden="true">${lioSternImg(72)}</span>
      </button>
      <span class="lsh-kopf-text">
        <small>Deine Lios</small>
        <b data-lio-stand>${lioText(stand)}</b>
        <span class="lsh-wert">Wert <span data-lio-euro>${euroFmt(stand / 100)}</span></span>
      </span>
    </div>${rest}`;
    inhalt.querySelector('[data-lsh-stern]').onclick = e => lioSternDrehen(e.currentTarget);
  }
  inhalt.querySelectorAll('[data-lsh-produkt]').forEach(b => { b.onclick = () => oeffneLioProdukt(b.dataset.lshProdukt); });
  inhalt.querySelector('[data-lsh-neu]')?.addEventListener('click', () => { lioShopLaden.fehler = false; zeichneLioShop(seite); lioShopLaden(); });
  lioWegeZeigen(seite);
}

// ---- Ein Gutschein im Detail: was man bekommt und wie man bezahlt
function oeffneLioProdukt(id) {
  const p = lioProdukt(id);
  if (!p || wseiteOben()?.art === 'lio-produkt') return;
  buzz(8);
  wseiteOeffnen({ art: 'lio-produkt', id, titel: p.name, klasse: 'lsh lsh-detail', baue: s => zeichneLioProdukt(s) });
}
// Kann man gerade mit Lios kaufen? Sonst der ehrliche Grund
function lioKaufStand(p) {
  const stand = lioStand();
  const fehlen = Math.max(0, (Number(p.preisLio) || 0) - stand);
  const fehlt = fehlen ? `dir fehlen noch ${lioText(fehlen)}` : '';
  if (lioAusverkauft(p)) return { ok: false, text: 'Gerade ausverkauft' + (fehlt ? ' · ' + fehlt : '') };
  if (kontoInfo && kontoInfo.emailOk === false) return { ok: false, email: true, text: 'Bestätige zuerst deine E-Mail-Adresse' };
  if (fehlen) return { ok: false, text: fehlt[0].toUpperCase() + fehlt.slice(1) };
  return { ok: true, text: `Du hast ${lioText(stand)}, danach noch ${lioText(stand - p.preisLio)}` };
}
function lioGrosseKarteHtml(p, { gekauft = false } = {}) {
  const farbe = brandColor(p.marke);
  const aus = !gekauft && lioAusverkauft(p);
  const status = gekauft ? 'In deiner Wallet' : aus ? 'Ausverkauft' : 'Sofort verfügbar';
  // Mit Kartenbild: die Karte selbst, darunter Wert und Stand
  const bild = lioKartenBildHtml(p, 'lsh-gross-img', 340);
  if (bild) return `
    <div class="lsh-gross-bild${aus ? ' aus' : ''}">
      <span class="lsh-gross-rahmen">${bild}</span>
      <div class="lsh-gross-zeile"><b>${euroFmt(p.wert)}</b><span>Guthaben</span><span class="pill">${status}</span></div>
    </div>`;
  return `
    <div class="gd-karte lsh-gross${brandHelligkeit(farbe) > 0.62 ? ' hell' : ''}${aus ? ' aus' : ''}" style="--bc:${farbe}; --tc:${brandTextColor(p.marke)}">
      ${lioMotivHtml(p, 'gd-motiv')}
      <div class="gd-karte-kopf">
        <span class="vk-logo">${brandChipHtml(p.marke)}</span>
        <span class="gd-karte-namen"><b>${esc(p.marke)}</b><span>${esc(p.name)}</span></span>
      </div>
      <div class="gd-guthaben"><b>${euroFmt(p.wert)}</b><span>Guthaben</span></div>
      <div class="gd-karte-fuss"><span class="pill">${status}</span></div>
    </div>`;
}
function zeichneLioProdukt(seite, { nurWennNeu = false } = {}) {
  const inhalt = seite.el.querySelector('.wseite-inhalt');
  if (!inhalt || seite.kauft || seite.fragt) return;
  const p = lioProdukt(seite.id);
  if (seite.gekauft) {
    if (nurWennNeu) return;
    inhalt.innerHTML = lioErfolgHtml(seite.gekauft, p || seite.gekauft.produkt);
    inhalt.querySelector('[data-lsh-ansehen]').onclick = () => lioGekauftAnsehen(seite.gekauft);
    inhalt.querySelector('[data-lsh-zurueck]').onclick = () => wseiteVerlassen(seite);
    return;
  }
  if (!p) {
    inhalt.innerHTML = '<div class="gd-block lsh-leer"><p>Diesen Gutschein gibt es gerade nicht.</p></div>';
    return;
  }
  const k = lioKaufStand(p);
  const stand = [JSON.stringify(p), k.ok, k.text, seite.fehlerText || ''].join('|');
  if (nurWennNeu && stand === seite.stand) return;
  seite.stand = stand;
  inhalt.innerHTML = `
    ${lioGrosseKarteHtml(p)}
    <h3 class="gd-h">Das bekommst du</h3>
    <div class="gd-block lsh-info">
      <div class="lsh-info-zeile"><span class="lsh-info-ico">${icon('gift', 'icon')}</span>
        <span class="lsh-info-text"><b>${esc(p.name)} über ${euroFmt(p.wert)}</b>${p.hinweis ? `<small>${esc(p.hinweis)}</small>` : ''}</span></div>
      <div class="lsh-info-zeile"><span class="lsh-info-ico">${icon('wallet', 'icon')}</span>
        <span class="lsh-info-text"><b>Landet direkt in deiner Wallet</b><small>Mit Code, gleich nach dem Kauf und auf all deinen Geräten</small></span></div>
    </div>
    <h3 class="gd-h">Bezahlen</h3>
    ${seite.fehlerText ? `<p class="lsh-fehler" role="alert">${icon('warning', 'icon icon-sm')}<span>${esc(seite.fehlerText)}</span></p>` : ''}
    <button class="gd-block lsh-zahl${k.ok ? ' bereit' : ''}" type="button" data-lsh-zahl="lio"${k.ok ? '' : ' disabled'}>
      <span class="lsh-zahl-ico lio" data-lio-ziel>${lioSternImg(30)}</span>
      <span class="lsh-zahl-text"><b>Mit Lios bezahlen</b><small>${esc(k.text)}</small></span>
      <span class="lsh-zahl-preis">${lioText(p.preisLio)}</span>
    </button>
    ${k.email ? '<button class="lsh-email" type="button" data-lsh-email>Zur E-Mail-Adresse in den Einstellungen</button>' : ''}
    <button class="gd-block lsh-zahl euro" type="button" disabled>
      <span class="lsh-zahl-ico euro">${icon('banknote', 'icon')}</span>
      <span class="lsh-zahl-text"><b>Mit Echtgeld bezahlen</b><small><span class="lsh-bald">Bald verfügbar</span>${p.cashbackLio > 0
        ? `<span class="lsh-cashback">${lioSternImg(16)}+${lioText(p.cashbackLio)} Cashback (${String(p.cashbackProzent).replace('.', ',')} %)</span>` : ''}</small></span>
      <span class="lsh-zahl-preis">${euroFmt(p.preisEuro)}</span>
    </button>`;
  inhalt.querySelector('[data-lsh-zahl="lio"]').onclick = () => lioKaufFragen(seite, p);
  inhalt.querySelector('[data-lsh-email]')?.addEventListener('click', () => { wseitenZu(); switchView('settings', 'enter-drop'); });
}

// Bestaetigen: eine Leiste schiebt sich von unten herein. Die Wallet muss dafuer
// entsperrt sein — der Kauf gibt Lios aus und legt einen Code in die Wallet.
async function lioKaufFragen(seite, p) {
  if (seite.kauft || seite.fragt || !lioKaufStand(p).ok) return;
  if (walletGesperrt()) {
    const ok = await walletFreigeben();
    if (!ok || wseiteOben() !== seite) return;
  }
  seite.fragt = true;
  if (!seite.kaufSchluessel) seite.kaufSchluessel = 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  const stand = lioStand();
  const leiste = document.createElement('div');
  leiste.className = 'wseite-leiste lsh-leiste';
  leiste.setAttribute('role', 'group');
  leiste.setAttribute('aria-label', 'Kauf bestätigen');
  leiste.innerHTML = `
    <div class="lsh-leiste-text"><b>${esc(p.name)} für ${lioText(p.preisLio)} kaufen?</b>
      <small>Danach hast du noch ${lioText(stand - p.preisLio)}. Landet sofort in deiner Wallet.</small></div>
    <div class="gd-knoepfe">
      <button class="gd-knopf lsh-nein" type="button">Abbrechen</button>
      <button class="gd-knopf lsh-ja" type="button">Jetzt kaufen</button>
    </div>`;
  seite.el.appendChild(leiste);
  seite.el.classList.add('lsh-fragt');
  if (!reducedMotion() && leiste.animate) {
    leiste.animate([{ transform: 'translate3d(0, 100%, 0)' }, { transform: 'translate3d(0, 0, 0)' }], { duration: 340, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  }
  const zu = () => {
    seite.fragt = false;
    seite.el.classList.remove('lsh-fragt');
    if (reducedMotion() || !leiste.animate) { leiste.remove(); return; }
    const a = leiste.animate([{ transform: 'translate3d(0, 0, 0)' }, { transform: 'translate3d(0, 100%, 0)' }], { duration: 240, easing: 'ease-in', fill: 'forwards' });
    a.onfinish = () => leiste.remove();
    setTimeout(() => leiste.remove(), 400);
  };
  seite.leisteZu = zu;
  leiste.querySelector('.lsh-nein').onclick = zu;
  leiste.querySelector('.lsh-ja').onclick = () => lioKaufen(seite, p, leiste);
  setTimeout(() => leiste.querySelector('.lsh-ja')?.focus({ preventScroll: true }), 60);
}
async function lioKaufen(seite, p, leiste) {
  if (seite.kauft) return;
  seite.kauft = true;
  seite.fest = true;                 // Zurueck wartet, bis der Kauf durch ist
  const ja = leiste.querySelector('.lsh-ja');
  setBtnLoading(ja, true);
  leiste.querySelector('.lsh-nein').disabled = true;
  let r = null, fehler = null;
  try {
    r = await api('/api/shop/kaufen', { method: 'POST', body: JSON.stringify({ produkt: p.id, zahlung: 'lio', schluessel: seite.kaufSchluessel }) });
  } catch (e) { fehler = e; }
  // Der Server hat geantwortet (Erfolg oder klare Absage): der naechste Kauf
  // bekommt einen neuen Schluessel. Ohne Antwort bleibt er fuer den neuen Versuch.
  if (r || fehler?.data) seite.kaufSchluessel = '';
  seite.kauft = false;
  seite.fest = false;
  seite.fragt = false;
  seite.el.classList.remove('lsh-fragt');
  leiste.remove();
  if (fehler) {
    const d = fehler.data || {};
    if (myProfile && Number.isFinite(d.lio)) myProfile.lio = d.lio;
    if (d.ausverkauft) Object.assign(p, { ausverkauft: true, verfuegbar: false });
    if (d.emailNoetig) kontoInfo = { ...(kontoInfo || {}), emailOk: false };
    seite.fehlerText = fehler.message || 'Der Kauf hat nicht geklappt.';
    playSfx('error');
    buzz([20, 40, 20]);
    if (wseiten().includes(seite)) zeichneLioProdukt(seite);
    lioShopLaden();
    return;
  }
  seite.fehlerText = '';
  if (myProfile && Number.isFinite(r.lio)) myProfile.lio = r.lio;
  if (r.produkt && lioShopDaten?.produkte) {
    lioShopDaten.produkte = lioShopDaten.produkte.map(x => x && x.id === r.produkt.id ? r.produkt : x);
  }
  seite.gekauft = r;
  playSfx('kaching');
  buzz([30, 30]);
  // Der Gutschein liegt am Server schon in der Wallet: gleich holen
  pullWallet();
  if (wseiten().includes(seite)) {
    zeichneLioProdukt(seite);
    seite.el.querySelector('.wseite-inhalt')?.scrollTo({ top: 0 });
  }
  const cashback = Math.max(0, Number(r.cashback) || 0);
  if (cashback) {
    const vorher = Math.max(0, lioStand() - cashback);
    lioGehalten = vorher;
    lioStandZeigen();
    lioSternFlug(cashback, {
      text: `Cashback: +${lioText(cashback)}`,
      beiAnkunft: () => { lioGehalten = null; lioStandZeigen({ von: vorher }); },
    });
  } else lioStandZeigen();
  lioShopLaden();
}
function lioErfolgHtml(r, p) {
  const name = p?.name || 'Gutschein';
  return `
    ${p ? lioGrosseKarteHtml(p, { gekauft: true }) : ''}
    <div class="lsh-erfolg">
      <span class="lsh-haken">${icon('check', 'icon')}</span>
      <h3>Gekauft!</h3>
      <p>${lioArtikel(name)} ${esc(name)}${p ? ` über ${euroFmt(p.wert)}` : ''} liegt jetzt in deiner Wallet.</p>
      <p class="lsh-erfolg-stand"><span class="lsh-erfolg-stern" data-lio-ziel>${lioSternImg(22)}</span><span>Du hast noch <b data-lio-stand>${lioText(lioAnzeige())}</b></span></p>
    </div>
    <button class="gd-los" type="button" data-lsh-ansehen>Gutschein ansehen</button>
    <button class="gd-los leise" type="button" data-lsh-zurueck>Zurück zum Shop</button>`;
}
async function lioGekauftAnsehen(r) {
  const id = r?.gutschein?.id;
  if (!id) return;
  if (!state.wallet.vouchers.some(v => v.id === id)) await pullWallet();
  if (!state.wallet.vouchers.some(v => v.id === id)) { island('Der Gutschein kommt gleich in deiner Wallet an'); return; }
  oeffneGutscheinSeite(id);
}

// ---------------- Wallet-Sperre: PIN, Face ID / Fingerabdruck ----------------
// Die PIN schuetzt die Wallet auf DIESEM Geraet: wer das entsperrte Handy in
// die Hand bekommt, sieht ohne sie keine Codes und PINs. Gespeichert wird nur
// ein PBKDF2-Hash (150 000 Runden) im localStorage, nie die PIN selbst.
// Face ID / Fingerabdruck laufen ueber WebAuthn (Passkey des Geraets) — nur
// als Abkuerzung zur PIN, die PIN bleibt immer der Weg zurueck.
// (Schluessel und Zustand der Sperre stehen oben bei save())

function pinDaten() { return lsJson(pinSchluessel(), null); }
function pinGesetzt() { const p = pinDaten(); return !!(p && p.hash && p.salt); }
function pinMoeglich() { return !!(window.crypto && crypto.subtle && window.TextEncoder); }
async function pinHash(pin, saltB64, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unb64(saltB64), iterations: iter, hash: 'SHA-256' }, key, 256);
  return b64(bits);
}
// Die PIN gehoert zum Konto: erst dort ablegen (mit der bisherigen PIN als
// Nachweis), dann hier. Wirft bei Fehlern (kein Netz, falsche bisherige PIN).
async function pinSpeichern(pin, alt = '') {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const iter = 150000;
  const hash = await pinHash(pin, salt, iter);
  const record = { salt, hash, iter, laenge: pin.length, v: 1 };
  if (!state.token) throw new Error('Bitte zuerst anmelden');
  const r = await api('/api/pin', { method: 'POST', body: JSON.stringify({ record, alt }) });
  if (r && r.walletPin) record.ts = r.walletPin.ts;
  if (!lsSetzen(pinSchluessel(), JSON.stringify(record))) throw new Error('Die PIN ließ sich auf diesem Gerät nicht speichern');
  lsSetzen(PIN_FEHL_KEY, JSON.stringify({ n: 0, bis: 0 }));
  return true;
}
// Stand des Kontos auf dieses Geraet holen: neue/geaenderte PIN uebernehmen,
// im Konto entfernte hier auch entfernen. Hatte das Geraet schon eine PIN und
// das Konto noch nie eine, wird sie zur PIN des Kontos (Umstellung).
function pinKontoUebernehmen(me) {
  if (!me || !state.token || me.user !== state.userName || !pinMoeglich()) return;
  const server = me.walletPin || null;
  const lokal = pinDaten();
  if (server) {
    if (lokal && lokal.hash === server.hash && lokal.salt === server.salt) return;
    lsSetzen(pinSchluessel(), JSON.stringify({ salt: server.salt, hash: server.hash, iter: server.iter, laenge: server.laenge, v: 1, ts: server.ts }));
    lsSetzen(PIN_FEHL_KEY, JSON.stringify({ n: 0, bis: 0 }));
  } else if (lokal && me.pinStand) {
    pinEntfernen();                 // auf einem anderen Geraet entfernt
    walletEntsperrt = true;
  } else if (lokal) {
    api('/api/pin', { method: 'POST', body: JSON.stringify({ record: lokal }) })
      .then(r => { if (r && r.walletPin) lsSetzen(pinSchluessel(), JSON.stringify({ ...r.walletPin, v: 1 })); })
      .catch(() => { });
    return;
  } else return;
  aktualisiereSperre();
  zeigePinEmpfehlung();
  if (state.activeView === 'settings') renderSicherheit();
}
async function pinPruefen(pin) {
  const p = pinDaten();
  if (!p) return false;
  return (await pinHash(pin, p.salt, p.iter || 150000)) === p.hash;
}
function pinEntfernen() {
  for (const k of [pinSchluessel(), bioSchluessel(), PIN_FEHL_KEY]) { try { localStorage.removeItem(k); } catch { } }
}
// Gesperrt, solange eine PIN gilt und nicht entsperrt wurde — auch abgemeldet:
// sonst waere die Wallet nach "Abmelden" als Gast wieder einsehbar
function walletGesperrt() { return pinGesetzt() && !walletEntsperrt; }
// Zu viele falsche PINs: kurz warten (30 s, dann doppelt so lang, max. 15 min)
function pinWarteBis() { return (lsJson(PIN_FEHL_KEY, { n: 0, bis: 0 }).bis || 0); }
function pinFehlversuch() {
  const f = lsJson(PIN_FEHL_KEY, { n: 0, bis: 0 });
  f.n = (f.n || 0) + 1;
  if (f.n >= 5) { f.dauer = Math.min(15 * 60e3, 30e3 * 2 ** (f.n - 5)); f.bis = Date.now() + f.dauer; }
  lsSetzen(PIN_FEHL_KEY, JSON.stringify(f));
}

// ---- Face ID / Fingerabdruck (WebAuthn, Plattform-Authentifikator)
async function bioVerfuegbar() {
  try { return !!window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
  catch { return false; }
}
// Kann der Browser es grundsaetzlich (WebAuthn auf sicherer Seite)? Die
// Vorab-Abfrage oben liegt manchmal falsch (aeltere Android-Chrome, iPhone
// ohne iCloud-Schluesselbund, manche Browser) — dann darf man es in den
// Einstellungen trotzdem versuchen und bekommt bei einem Fehler den Grund.
function bioGrundsaetzlich() { return !!window.PublicKeyCredential && window.isSecureContext !== false; }
// Eingebaute Browser anderer Apps (Instagram, TikTok, Facebook, Snapchat,
// Android-WebView) geben Face ID / Fingerabdruck fast nie frei
const bioInAppBrowser = () => /FBAN|FBAV|Instagram|TikTok|musical_ly|Snapchat|Line\/|; wv\)/i.test(navigator.userAgent || '');
// Warum das Einrichten scheiterte, in Worten mit einem Weg heraus
function bioFehlerText(err) {
  const n = err && err.name;
  if (bioInAppBrowser()) return 'Im Browser dieser App geht es nicht. Öffne kumulio in Safari oder Chrome (bzw. über das Symbol auf deinem Home-Bildschirm).';
  if (n === 'NotAllowedError') return uaIOS
    ? 'Abgebrochen oder vom iPhone nicht erlaubt. Face ID braucht den iCloud-Schlüsselbund: Einstellungen → dein Name → iCloud → Passwörter (und Schlüsselbund) einschalten, dann nochmal versuchen.'
    : 'Abgebrochen oder vom Gerät nicht erlaubt. Auf Android braucht es eine Displaysperre mit Fingerabdruck und aktuelle Google-Play-Dienste; dann nochmal versuchen.';
  if (n === 'NotSupportedError') return 'Dieses Gerät oder dieser Browser unterstützt Face ID / Fingerabdruck für Webseiten nicht. Versuch es in Safari (iPhone) oder Chrome (Android).';
  if (n === 'SecurityError') return 'Nur auf der sicheren Seite https://kumulio.de möglich. Öffne kumulio direkt dort.';
  if (n === 'InvalidStateError') return 'Auf diesem Gerät ist schon ein Zugang gespeichert. Schalte es aus und wieder ein.';
  return 'Face ID / Fingerabdruck ließ sich nicht einrichten' + (n ? ` (${String(n).replace(/[^A-Za-z]/g, '')})` : '') + '. Versuch es in Safari (iPhone) oder Chrome (Android).';
}
function bioAn() { return !!lsJson(bioSchluessel(), null); }
let bioLetzterFehler = '';
async function bioEinrichten() {
  bioLetzterFehler = '';
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'kumulio' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: state.userName || 'kumulio', displayName: 'kumulio-Wallet' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60000, attestation: 'none',
    } });
    lsSetzen(bioSchluessel(), JSON.stringify({ id: b64(cred.rawId) }));
    return true;
  } catch (err) {
    bioLetzterFehler = bioFehlerText(err);
    island('Face ID / Fingerabdruck ließ sich nicht einrichten');
    return false;
  }
}
// Face ID / Fingerabdruck: startet von selbst, sobald die Sperre erscheint —
// kein extra Antippen. Manche Browser (v. a. Safari) lassen die Abfrage nur
// nach einer Beruehrung zu; dann reicht ein Tippen irgendwo auf die Sperre.
// Bricht man ab, fragt die App nicht erneut — dann gilt die PIN (oder die Taste).
async function bioVersuch({ auto = false } = {}) {
  if (bioLaeuft || !bioAn() || !walletGesperrt()) return;
  bioLaeuft = true;
  const t0 = Date.now();
  let ok = false;
  try { ok = await bioPruefen(); } finally { bioLaeuft = false; }
  if (ok) { bioBrauchtTippen = false; if (walletGesperrt()) entsperreWallet(); return; }
  // Sofort abgelehnt (ohne dass jemand etwas sehen konnte) = Browser verlangt ein Antippen
  bioBrauchtTippen = auto && Date.now() - t0 < 700;
  if (bioBrauchtTippen) setzeSperrText('Tippe auf den Bildschirm für Face ID oder gib deine PIN ein', false);
}
function bioAutomatisch() {
  if (!bioAn() || document.visibilityState !== 'visible') return;
  const el = $('#wallet-sperre');
  if (!el || el.classList.contains('hidden') || el.classList.contains('geht')) return;
  bioVersuch({ auto: true });
}
async function bioPruefen() {
  const bio = lsJson(bioSchluessel(), null);
  if (!bio) return false;
  try {
    const a = await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: unb64(bio.id), transports: ['internal'] }],
      userVerification: 'required', timeout: 60000,
    } });
    return !!a;
  } catch { return false; }
}

// ---- Ziffernblock: derselbe fuer Sperre und Dialoge
// --i steuert die gestaffelte Einblendung der Tasten
function ziffernblockHtml(mitBio) {
  return [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n, i) => `<button class="ws-taste" type="button" data-z="${n}" style="--i:${i}">${n}</button>`).join('')
    + (mitBio ? `<button class="ws-taste ws-neben" type="button" data-bio="1" style="--i:9" aria-label="Mit Face ID oder Fingerabdruck entsperren">${FACE_SVG}</button>`
      : '<span class="ws-taste leer" aria-hidden="true"></span>')
    + '<button class="ws-taste" type="button" data-z="0" style="--i:10">0</button>'
    + `<button class="ws-taste ws-neben" type="button" data-weg="1" style="--i:11" aria-label="Letzte Ziffer löschen">${icon('arrow-back')}</button>`;
}
// Die Punkte bleiben stehen und wechseln nur ihren Zustand. Frueher wurden sie
// bei jeder Ziffer neu gebaut — dann gab es nichts, was sich fuellen konnte.
// Ab "optionalAb" sind Plaetze nur angedeutet (PIN mit 5 oder 6 Ziffern).
function setzePunkte(box, anzahl, voll, optionalAb = anzahl) {
  if (!box) return;
  if (box.children.length !== anzahl) {
    box.innerHTML = Array.from({ length: anzahl }, (_, i) => `<span class="ws-punkt" style="--i:${i}"></span>`).join('');
  }
  [...box.children].forEach((p, i) => {
    p.classList.toggle('voll', i < voll);
    p.classList.toggle('optional', i >= optionalAb && i >= voll);
  });
}
// Punkte von hinten nach vorn leeren (Verzoegerung pro Punkt ueber --d)
function rueckwaerts(box, leeren) {
  if (!box) return leeren();
  const n = box.children.length;
  [...box.children].forEach((p, i) => p.style.setProperty('--d', ((n - 1 - i) * 35) + 'ms'));
  leeren();
  setTimeout(() => [...box.children].forEach(p => p.style.removeProperty('--d')), 420);
}
function neuStarten(el, klasse) {
  if (!el) return;
  el.classList.remove(klasse);
  void el.offsetWidth;
  el.classList.add(klasse);
}
function sperrRuhig() { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } }
function sperrWarteText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min` : `${s} s`;
}
// Tastendruck sichtbar machen: kurz einfedern, dazu eine Welle. :active allein
// reicht nicht — iOS zeigt es ohne eigenen Touch-Handler oft gar nicht.
document.addEventListener('pointerdown', e => {
  const t = e.target.closest?.('.ws-taste');
  if (!t || t.classList.contains('leer')) return;
  neuStarten(t, 'tipp');
  t.addEventListener('animationend', () => t.classList.remove('tipp'), { once: true });
}, { passive: true, capture: true });
// Ziffern und Loeschen zaehlen schon beim Beruehren (pointerdown), nicht erst
// beim click. Tippt man schnell mit zwei Daumen und der naechste Finger ist
// schon auf dem Glas, bevor der vorige losgelassen hat, verwerfen iOS und
// manche Android-Browser den click — die Taste leuchtete auf, die Ziffer fehlte
// (Meldung eines Nutzers). click bleibt fuer Tastatur und Bildschirmleser;
// liefert: schonGezaehlt(b) — true, wenn dieser click zum eben gezaehlten
// Beruehren gehoert und darum nichts mehr tun darf.
function tastenBeimBeruehren(host, aktion, { erlaubt = () => true } = {}) {
  let zuletzt = null, zuletztT = 0;
  host.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const b = e.target.closest?.('.ws-taste');
    if (!b || !host.contains(b) || b.disabled || b.classList.contains('leer')) return;
    // Nur Ziffern und Loeschen — die Face-ID-Taste braucht einen echten click
    if (b.dataset.z == null && !b.dataset.weg) return;
    if (!erlaubt(b)) return;
    zuletzt = b; zuletztT = performance.now();
    aktion(b);
  });
  return b => {
    if (b !== zuletzt || performance.now() - zuletztT > 1500) return false;
    zuletzt = null;
    return true;
  };
}

// ---- Sperrbildschirm der Wallet
// Liegt ueber der GANZEN App (Kopfzeile und Menue unten eingeschlossen),
// solange die Wallet-Seite offen und die Wallet gesperrt ist.
function sperrText() { return bioAn() ? 'PIN eingeben oder Face ID / Fingerabdruck nutzen' : 'Gib deine PIN ein'; }
// Begruessung nach Tageszeit, mit dem Namen des Kontos, dem die Wallet gehoert
function sperrGruss() {
  const h = new Date().getHours();
  const zeit = h >= 5 && h < 11 ? 'Guten Morgen' : h >= 11 && h < 18 ? 'Guten Tag' : 'Guten Abend';
  const name = walletBesitzer || state.userName || '';
  return name ? `${zeit}, ${name}` : zeit;
}
// Jedes Wort ein eigenes Element: so gleiten sie beim Auftritt nacheinander herein
function setzeGruss() {
  const el = $('#ws-gruss');
  if (!el) return;
  const t = sperrGruss();
  if (el.dataset.t === t) return;
  el.dataset.t = t;
  el.innerHTML = t.split(' ').map((w, i) => `<span class="ws-wort" style="--w:${i}">${esc(w)}</span>`).join(' ');
}
// Die Wortmarke kommt aus dem Marken-Modul (laedt nach app.js)
function sperrLogo() {
  const el = $('#ws-logo');
  if (!el || el.firstElementChild) return;
  const setze = K => { if (K?.wordmarkHTML && !el.firstElementChild) el.innerHTML = K.wordmarkHTML({ height: 34, withRipple: true }); };
  if (window.KBrand) setze(window.KBrand);
  else (window.KBrandReady || Promise.resolve()).then(setze);
}
function setzeSperrText(t, fehler = false) {
  const el = $('#ws-text');
  if (!el) return;
  if (el.textContent === t && el.classList.contains('fehler') === fehler) return;
  el.textContent = t;
  el.classList.toggle('fehler', fehler);
  if (!sperrRuhig()) neuStarten(el, 'neu');
}
function aktualisiereSperre() {
  const el = $('#wallet-sperre');
  if (!el) return;
  const zu = walletGesperrt() && state.activeView === 'wallet';
  const geht = el.classList.contains('offen') || el.classList.contains('geht');
  const warSichtbar = !el.classList.contains('hidden') && !geht;
  document.body.classList.toggle('wallet-zu', zu);
  setzeLeistenfarbe();
  renderRangKarte();   // Rang im Profil: gesperrt ohne Betrag, entsperrt wieder mit
  // Nicht nur ein Vorhang: darunter ist nichts bedien- oder per Tastatur erreichbar
  for (const sel of ['#wallet-kopf', '#wallet-content', '#coupons-content', '#pfand-content', '#wallet-gate', '#wallet-mini', '#wallet-modes']) {
    const n = $(sel);
    if (n) n.inert = walletGesperrt();
  }
  for (const sel of ['#tabbar', '.topbar', '#note-banner']) {
    const n = $(sel);
    if (n) n.inert = zu;
  }
  if (zu) {
    clearTimeout(sperreGehtUhr);
    el.classList.remove('hidden', 'offen', 'geht');
    $('#ws-punkte')?.classList.remove('richtig', 'falsch');
    if (!warSichtbar) {
      sperrEingabe = '';
      sperrBeschaeftigt = false;
      schliesseWalletAnsichten();
      sperreAuftritt(el);
      bioBrauchtTippen = false;
      if (!startAuftrittOffen) setTimeout(bioAutomatisch, sperrRuhig() ? 0 : 380);
    }
    baueSperre();
    // Fokus auf die Sperre selbst, nicht auf eine Taste: sonst zeichnet das
    // Handy einen Fokus-Ring um die 1. Ziffern per Tastatur gehen trotzdem.
    setTimeout(() => $('#wallet-sperre')?.focus({ preventScroll: true }), 0);
  } else {
    clearInterval(sperrUhr);
    // Beim Entsperren blendet sich die Sperre selbst aus (siehe entsperreWallet)
    if (!geht) { el.classList.add('hidden'); el.classList.remove('kommt', 'vorstart', 'wartet'); }
  }
}
// Auftritt: Schloss faellt ein, Text und Tasten folgen gestaffelt. Beim
// App-Start erst, wenn der Splash geht — sonst liefe er unsichtbar dahinter.
function sperreAuftritt(el) {
  el.classList.remove('kommt', 'vorstart');
  sperrLogo();
  setzeGruss();
  $('#ws-logo')?.classList.remove('k-go');
  if (sperrRuhig()) return;
  if (startAuftrittOffen) { el.classList.add('vorstart'); return; }
  void el.offsetWidth;
  el.classList.add('kommt');
  // Das Logo faellt ein wie beim App-Start: Buchstaben, dann der Punkt als Muenze
  neuStarten($('#ws-logo'), 'k-anim-splash');
  clearTimeout(sperreKommtUhr);
  sperreKommtUhr = setTimeout(() => el.classList.remove('kommt'), 1100);
}
// Alles zu, was Codes oder PINs zeigen kann: Blaetter, Lupen, Bildbetrachter,
// Auspacken
function schliesseWalletAnsichten() {
  schliesseMarkenMenue();
  schliesseVkMenue();
  // Gutschein-, Verschenken- und Analyse-Seiten: sofort weg, samt Inhalt.
  // Eine offene Deal-Seite allein zeigt nichts aus der Wallet und bleibt.
  if (wseiten().some(x => x.art !== 'deal' && !istLioSeite(x))) wseitenZu();
  if (state.sheetMode) closeSheet();
  // Das zugeklappte Blatt behaelt sonst Code, PIN und Knoepfe im Baum
  const inhalt = $('#sheet-content');
  if (inhalt) inhalt.innerHTML = '';
  document.querySelector('.karten-lupe .lupe-grund')?.click();
  if (bildOffen) bildOffen.querySelector('.bl-zu')?.click();
  document.querySelectorAll('.gift-overlay').forEach(x => x.remove());
  document.querySelectorAll('.cc-big').forEach(x => (x.closest('.overlay') || x).remove());
  // Zuschneiden zeigt das ganze Gutscheinbild und liegt ueber der Sperre:
  // sofort weg, ohne Uebernahme (die Rueckrufe pruefen die Sperre zusaetzlich)
  document.querySelectorAll('.crop-overlay').forEach(x => x.remove());
  // Offene Rueckfragen ("Loeschen?") gelten als abgebrochen — sonst laegen sie
  // ueber der Sperre und liessen sich weiter bestaetigen
  document.querySelectorAll('.overlay.rueckfrage').forEach(x => x.click());
}
function sperrPunkte() { setzePunkte($('#ws-punkte'), (pinDaten() || {}).laenge || 4, sperrEingabe.length); }
function baueSperre() {
  const el = $('#wallet-sperre');
  const tasten = $('#ws-tasten');
  sperrLogo();
  setzeGruss();
  if (tasten.dataset.bio !== String(bioAn())) {
    tasten.dataset.bio = String(bioAn());
    tasten.innerHTML = ziffernblockHtml(bioAn());
  }
  sperrPunkte();
  const warte = pinWarteBis() - Date.now();
  const text = $('#ws-text');
  clearInterval(sperrUhr);
  el.classList.toggle('wartet', warte > 0);
  if (warte > 0) {
    // Wartezeit: Tasten treten zurueck, ein Balken laeuft die Zeit herunter
    const f = lsJson(PIN_FEHL_KEY, { n: 0, bis: 0 });
    const dauer = f.dauer || Math.min(15 * 60e3, 30e3 * 2 ** Math.max(0, (f.n || 5) - 5));
    const balken = $('#ws-warte i');
    if (balken) {
      balken.style.transition = 'none';
      balken.style.transform = `scaleX(${Math.min(1, warte / dauer)})`;
      void balken.offsetWidth;
      balken.style.transition = `transform ${warte}ms linear`;
      balken.style.transform = 'scaleX(0)';
    }
    const zeige = () => { text.innerHTML = `Zu viele falsche Versuche. Noch <b>${sperrWarteText(pinWarteBis() - Date.now())}</b>`; };
    text.classList.add('fehler');
    zeige();
    sperrUhr = setInterval(() => {
      if (pinWarteBis() > Date.now()) return zeige();
      clearInterval(sperrUhr);
      text.classList.remove('fehler');
      text.textContent = '';
      baueSperre();
      if (!sperrRuhig()) neuStarten($('#ws-logo'), 'stups');
    }, 1000);
  } else if (!text.classList.contains('fehler')) {
    setzeSperrText(sperrText(), false);
  }
}
async function sperrTaste(z) {
  if (sperrBeschaeftigt || walletEntsperrt || pinWarteBis() > Date.now()) return;
  const laenge = (pinDaten() || {}).laenge || 4;
  if (sperrEingabe.length >= laenge) return;
  $('#wallet-sperre')?.classList.remove('kommt');
  sperrEingabe += z;
  buzz(6);
  if ($('#ws-text').classList.contains('fehler')) setzeSperrText(sperrText(), false);
  sperrPunkte();
  if (sperrEingabe.length < laenge) return;
  sperrBeschaeftigt = true;
  const ok = await pinPruefen(sperrEingabe);
  if (ok) { sperrBeschaeftigt = false; entsperreWallet(); bioAngebotNachPin(); return; }
  pinFehlversuch();
  sperrFalsch();
}
// Falsche PIN: Punkte werden rot und schuetteln den Kopf, dann leeren sie sich
function sperrFalsch() {
  const box = $('#ws-punkte');
  box.classList.add('falsch');
  buzz([40, 40, 40]);
  playSfx('error', .45);
  setzeSperrText('Falsche PIN', true);
  setTimeout(() => {
    sperrEingabe = '';
    rueckwaerts(box, sperrPunkte);
    box.classList.remove('falsch');
    sperrBeschaeftigt = false;
    baueSperre();
  }, 520);
}
function sperrZurueck() {
  if (sperrBeschaeftigt || !sperrEingabe) return;
  sperrEingabe = sperrEingabe.slice(0, -1);
  sperrPunkte();
}
// Nach dem Entsperren per PIN einmal anbieten, Face ID / Fingerabdruck
// einzurichten — auch wenn die PIN auf einem anderen Geraet festgelegt wurde
// und hier nie danach gefragt wurde. Je Geraet und Konto nur einmal.
const bioAngebotSchluessel = () => 'ra.bioAngebot:' + (walletBesitzer || state.userName || 'gast');
async function bioAngebotNachPin() {
  try { if (bioAn() || localStorage.getItem(bioAngebotSchluessel())) return; } catch { return; }
  if (!await bioVerfuegbar()) return;
  setTimeout(async () => {
    // Nicht ueber das Update-Log oder einen anderen Dialog legen
    if (walletGesperrt() || bioAn() || document.querySelector('.overlay:not(.hidden)')) return;
    lsSetzen(bioAngebotSchluessel(), String(Date.now()));
    if (await askConfirm('Nächstes Mal mit Face ID oder Fingerabdruck entsperren?', { okLabel: 'Ja, einrichten' })
      && await bioEinrichten()) island('Face ID / Fingerabdruck ist eingerichtet');
  }, 1400);
}
function entsperreWallet() {
  walletEntsperrt = true;
  sperrEingabe = '';
  sperrBeschaeftigt = false;
  lsSetzen(PIN_FEHL_KEY, JSON.stringify({ n: 0, bis: 0 }));
  const el = $('#wallet-sperre');
  const sichtbar = el && !el.classList.contains('hidden') && !el.classList.contains('geht');
  setTimeout(() => pruefeNeuigkeiten(), 1000); // Update-Log wartete auf das Entsperren
  // Lios: wartende Gutschriften fliegen jetzt (der Stern oeffnet die Fahne),
  // sonst zeigt der Shop-Knopf einmal den Stand — wie beim Oeffnen der Wallet
  setTimeout(() => {
    if (state.activeView !== 'wallet') return;
    if (lioWartetNoch()) lioNeuPruefen(); else lioFahneZeigen();
  }, 900);
  setTimeout(verarbeiteGeteiltes, 700);          // geteiltes Bild wartete auch
  playSfx('anmelden', 1);   // Anmeldeton (vom Nutzer, in der Datei leiser), auch nach Face ID
  setTimeout(() => {                               // "Karte zeigen" aus dem Laden-Banner
    if (!markeWartet || walletGesperrt()) return;
    const k = markeWartet;
    markeWartet = null;
    openBrandSheet(k);
  }, 800);
  if (!sichtbar || sperrRuhig()) {
    if (el) { el.classList.remove('offen', 'geht'); $('#ws-text')?.classList.remove('fehler'); }
    aktualisiereSperre();
    renderWallet();
    return;
  }
  // Entsperrt: Punkte gruen, der Punkt im Logo quittiert — dann gibt die
  // Sperre die Wallet frei, die darunter hereingleitet
  clearInterval(sperrUhr);
  clearTimeout(sperreKommtUhr);
  el.classList.remove('kommt', 'vorstart', 'wartet');
  const laenge = (pinDaten() || {}).laenge || 4;
  setzePunkte($('#ws-punkte'), laenge, laenge);
  $('#ws-punkte').classList.add('richtig');
  el.classList.add('offen');
  const logo = $('#ws-logo');
  logo?.classList.remove('k-anim-splash');
  neuStarten(logo, 'k-go');
  setzeSperrText('Entsperrt', false);
  buzz(15);
  clearTimeout(sperreGehtUhr);
  sperreGehtUhr = setTimeout(() => {
    el.classList.add('geht');
    aktualisiereSperre();   // Wallet darunter wird sichtbar und bedienbar
    renderWallet();
    walletAuftritt({ menue: true });
    sperreGehtUhr = setTimeout(sperreFertigZu, 440);
  }, 320);
}
function sperreFertigZu() {
  const el = $('#wallet-sperre');
  if (!el || !el.classList.contains('geht')) return;
  el.classList.add('hidden');
  el.classList.remove('geht', 'offen', 'kommt', 'wartet');
  $('#ws-logo')?.classList.remove('k-go', 'k-anim-splash');
  $('#ws-punkte')?.classList.remove('richtig', 'falsch');
  $('#ws-text')?.classList.remove('fehler');
}
// Die Wallet gleitet herein: Guthaben zaehlt hoch, Handgriffe und Karten
// folgen gestaffelt. Beim Start (nach dem Splash) und nach dem Entsperren.
function walletAuftritt({ menue = false } = {}) {
  if (sperrRuhig() || state.activeView !== 'wallet' || walletGesperrt()) return;
  // Genau einmal: zwei Aufrufe kurz hintereinander (Start und Abgleich) liessen
  // die Karten sonst zweimal hereinkommen
  const jetzt = performance.now();
  if (walletAuftritt.zuletzt && jetzt - walletAuftritt.zuletzt < 1500) return;
  walletAuftritt.zuletzt = jetzt;
  const coupons = walletTab === 'coupons';
  const teile = [
    $('.balance-flip-btn'),
    $('.wk-sprite'),
    ...document.querySelectorAll('.wallet-aktionen .wa-btn'),
    $('#wallet-modes'),
    ...(coupons || walletTab === 'pfand'
      ? [...$(coupons ? '#coupons-content' : '#pfand-content').children].slice(0, 6)
      : [$('#pin-empfehlung:not(.hidden)'), $('.wallet-tools'), $('#zuletzt-verwendet:not(.hidden)'),
        $('#wallet-content .bereich-zeile'),
        ...[...$('#voucher-list').children].filter(e => !e.classList.contains('wl-geist')).slice(0, 6)]),
  ].filter(el => el && imBild(el.getBoundingClientRect(), 0));
  // Runde 118: Web-Animationen statt der Klasse .auftritt. Die Klasse lief bei
  // Karten nicht an (sie trugen schon dieselbe Animation) — Kopf und Werkzeuge
  // kamen herein, die Karten standen still. Und eine Web-Animation laeuft beim
  // Umschalten der Reiter nicht noch einmal los.
  teile.forEach((el, i) => {
    el.getAnimations().forEach(a => { if (a.id === 'auftritt' || a.id === 'rein') a.cancel(); });
    const figur = el.classList.contains('wk-sprite');
    const a = el.animate(figur
      ? [{ opacity: 0, transform: 'translate3d(0, 30px, 0) scale(.92)' }, { opacity: 1, transform: 'none' }]
      : [{ opacity: 0, transform: 'translate3d(0, 14px, 0) scale(.985)' }, { opacity: 1, transform: 'none' }],
    { duration: figur ? 700 : 550, delay: Math.min(i * 45, 460), easing: 'cubic-bezier(.32, .72, 0, 1)', fill: 'backwards' });
    a.id = 'auftritt';
  });
  const t = $('#wallet-total');
  const bis = renderWallet.lastAnzeige ?? renderWallet.lastTotal ?? 0;
  if (t && state.token && bis > 0) animateNumber(t, 0, bis, 850);
  if (menue) {
    neuStarten(document.body, 'menue-rein');
    setTimeout(() => document.body.classList.remove('menue-rein'), 700);
  }
}
// Einmal beim Start: warten, bis der Splash geht, dann den Auftritt spielen
function nachStartSplash(fn) {
  let fertig = false;
  const los = () => { if (!fertig) { fertig = true; fn(); } };
  setTimeout(los, 3000); // Sicherheitsnetz
  (window.KBrandReady || Promise.resolve()).then(() => {
    const pruefe = () => {
      if (fertig) return;
      const sp = document.querySelector('.k-splash');
      if ((!sp || sp.classList.contains('k-out')) && !document.getElementById('boot-cover')) los();
      else setTimeout(pruefe, 50);
    };
    pruefe();
  });
}
const sperrTasteAus = b => { if (b.dataset.z != null) sperrTaste(b.dataset.z); else if (b.dataset.weg) sperrZurueck(); };
const sperrSchonGezaehlt = $('#ws-tasten') ? tastenBeimBeruehren($('#ws-tasten'), sperrTasteAus) : () => false;
$('#ws-tasten')?.addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.z != null || b.dataset.weg) { if (!sperrSchonGezaehlt(b)) sperrTasteAus(b); }
  else if (b.dataset.bio && !sperrBeschaeftigt) bioVersuch();
});
$('#ws-vergessen')?.addEventListener('click', () => pinVergessen());
$('#wallet-sperre')?.addEventListener('click', e => {
  if (!bioBrauchtTippen || e.target.closest('button') || sperrBeschaeftigt) return;
  bioBrauchtTippen = false;
  setzeSperrText(sperrText(), false);
  bioVersuch();
});
// Raus aus der Wallet, ohne sie zu entsperren (die Sperre deckt das Menue ab)
$('#ws-weg')?.addEventListener('click', () => switchView('feed'));
addEventListener('keydown', e => {
  const el = $('#wallet-sperre');
  if (!el || el.classList.contains('hidden') || el.classList.contains('geht') || state.sheetMode || document.querySelector('.overlay:not(.hidden)')) return;
  if (/^\d$/.test(e.key)) sperrTaste(e.key);
  else if (e.key === 'Backspace') sperrZurueck();
});
// Im Hintergrund laenger als eine Minute: wieder sperren (und offene
// Gutschein-Blaetter schliessen, damit dort nichts stehen bleibt)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { versteckSeit = Date.now(); return; }
  if (versteckSeit && Date.now() - versteckSeit > SPERRE_NACH_MS && pinGesetzt() && walletEntsperrt) {
    walletEntsperrt = false;
    schliesseWalletAnsichten();
    aktualisiereSperre();
  }
  // Zurueck in der App: kurz beim Konto nachsehen (Aufraeumen, anderes Geraet)
  if (versteckSeit && Date.now() - versteckSeit > 30e3 && state.token) pullWallet();
  versteckSeit = 0;
});

// ---- Dialoge: PIN eingeben (fest oder 4-6 Stellen), Passwort eingeben
// Ein Fenster fuer mehrere Schritte (aktuelle PIN, neue PIN, wiederholen):
// die Schritte gleiten darin weiter, statt dass Fenster zu- und aufgehen.
// Eine falsche Eingabe laesst die Punkte wackeln, das Fenster bleibt offen.
// frage() liefert die Eingabe, null (abgebrochen) oder 'zurueck'.
function pinModal() {
  const wrap = document.createElement('div');
  wrap.className = 'overlay pin-overlay';
  wrap.innerHTML = '<div class="modal pin-modal"><div class="pin-schritte"></div></div>';
  document.body.appendChild(wrap);
  const buehne = wrap.querySelector('.pin-schritte');
  let s = null;          // der gerade offene Schritt
  let offen = true;
  const zu = () => {
    if (!offen) return;
    offen = false;
    removeEventListener('keydown', taste, true);
    wrap.classList.add('closing');
    setTimeout(() => wrap.remove(), 300);
    if (s) { clearTimeout(s.auto); const r = s.resolve; s = null; r(null); }
  };
  const punkte = () => s && setzePunkte(s.box, s.slots, s.eingabe.length, s.fest ? s.slots : s.min);
  const hinweis = () => {
    if (!s || s.fest) return;
    const n = s.eingabe.length;
    if (s.laengeEl) {
      s.laengeEl.textContent = n < s.min ? `${s.min} bis ${s.max} Ziffern`
        : n < s.max ? `Passt. Weiter, oder bis zu ${s.max} Ziffern` : `${s.max} Ziffern`;
    }
    if (s.weiter) {
      const an = n >= s.min;
      if (an && s.weiter.disabled && !sperrRuhig()) neuStarten(s.weiter, 'knopf-pop');
      s.weiter.disabled = !an;
    }
  };
  const text = (t, fehler) => {
    if (!s) return;
    s.textEl.textContent = t;
    s.textEl.classList.toggle('fehler', !!fehler);
    if (!sperrRuhig()) neuStarten(s.textEl, 'neu');
  };
  const falsch = t => {
    if (!s) return;
    const schritt = s;
    schritt.busy = true;
    schritt.box.classList.add('falsch');
    buzz([40, 40, 40]);
    playSfx('error', .45);
    text(t, true);
    setTimeout(() => {
      if (s !== schritt) return;
      schritt.eingabe = '';
      rueckwaerts(schritt.box, punkte);
      schritt.box.classList.remove('falsch');
      schritt.busy = false;
      hinweis();
    }, 520);
  };
  const abschicken = async () => {
    if (!s || s.busy) return;
    const schritt = s, wert = s.eingabe;
    clearTimeout(schritt.auto);
    schritt.busy = true;
    if (schritt.pruefe) {
      let r;
      try { r = await schritt.pruefe(wert); } catch { r = 'Das hat nicht geklappt'; }
      if (s !== schritt) return;
      if (r !== true) {
        if (r && typeof r === 'object') { zu(); if (r.text) island(r.text); return; }
        schritt.busy = false;
        return falsch(r || 'Das stimmt nicht');
      }
    }
    if (schritt.fest && schritt.pruefe) {
      schritt.box.classList.add('richtig');
      await new Promise(r => setTimeout(r, sperrRuhig() ? 0 : 220));
    }
    if (s !== schritt) return;
    s = null;
    schritt.resolve(wert);
  };
  const tippe = z => {
    if (!s || s.busy) return;
    if (s.eingabe.length >= s.slots) {
      if (!sperrRuhig()) neuStarten(s.box, 'stups');
      buzz(20);
      return;
    }
    s.eingabe += z;
    buzz(6);
    if (s.textEl.classList.contains('fehler')) text(s.text, false);
    punkte();
    hinweis();
    // Volle Laenge: gleich weiter (bei freier Laenge ist 6 das Maximum). Der
    // Zeitgeber gehoert zu DIESEM Schritt und DIESER Eingabe — Loeschen oder ein
    // schnelles "Weiter" dazwischen setzt ihn ausser Kraft
    if (s.eingabe.length === s.slots) {
      const schritt = s;
      clearTimeout(schritt.auto);
      schritt.auto = setTimeout(() => {
        if (s === schritt && !schritt.busy && schritt.eingabe.length === schritt.slots) abschicken();
      }, s.fest ? 120 : 240);
    }
  };
  const loesche = () => {
    if (!s || s.busy || !s.eingabe) return;
    clearTimeout(s.auto);
    s.eingabe = s.eingabe.slice(0, -1);
    punkte();
    hinweis();
  };
  // Ziffern beim Beruehren zaehlen (siehe tastenBeimBeruehren)
  const schonGezaehlt = tastenBeimBeruehren(wrap,
    b => { if (b.dataset.z != null) tippe(b.dataset.z); else loesche(); },
    { erlaubt: b => !b.closest('.pin-schritt.raus') });
  wrap.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) { if (e.target === wrap) zu(); return; }
    if (b.closest('.pin-schritt.raus')) return;
    if ((b.dataset.z != null || b.dataset.weg) && schonGezaehlt(b)) return;
    if (b.dataset.z != null) tippe(b.dataset.z);
    else if (b.dataset.weg) loesche();
    else if (b.dataset.abbrechen != null) zu();
    else if (b.dataset.zurueck != null && s) { clearTimeout(s.auto); const r = s.resolve; s = null; r('zurueck'); }
    else if (b.dataset.weiter != null && s && s.eingabe.length >= s.min) abschicken();
  });
  const taste = e => {
    if (!offen) return;
    if (/^\d$/.test(e.key)) { e.stopPropagation(); tippe(e.key); }
    else if (e.key === 'Backspace') { e.stopPropagation(); loesche(); }
    else if (e.key === 'Enter' && s && !s.fest && s.eingabe.length >= s.min) { e.stopPropagation(); abschicken(); }
    else if (e.key === 'Escape') { e.stopPropagation(); zu(); }
  };
  addEventListener('keydown', taste, true);
  const frage = ({ titel, text: t = '', fest = 0, min = 4, max = 6, pruefe = null, schritt = 0, von = 0, zurueck = false }) =>
    new Promise(resolve => {
      if (!offen) return resolve(null);
      const alt = buehne.lastElementChild;
      const el = document.createElement('div');
      el.className = 'pin-schritt';
      el.innerHTML = `
        ${von ? `<div class="pin-fortschritt" aria-label="Schritt ${schritt} von ${von}">${Array.from({ length: von }, (_, i) =>
          `<i class="${i < schritt ? 'an' : ''}"></i>`).join('')}</div>` : ''}
        <h2 class="card-h">${esc(titel)}</h2>
        <p class="muted pin-text" data-text>${esc(t)}</p>
        <div class="ws-punkte" data-punkte></div>
        ${fest ? '' : '<p class="pin-laenge" data-laenge aria-live="polite"></p>'}
        <div class="ws-tasten klein">${ziffernblockHtml(false)}</div>
        <div class="form-row">
          <button class="btn btn-small btn-ghost" ${zurueck ? 'data-zurueck' : 'data-abbrechen'} type="button">${zurueck ? 'Zurück' : 'Abbrechen'}</button>
          ${fest ? '' : '<button class="btn btn-small" data-weiter type="button" disabled>Weiter</button>'}
        </div>`;
      buehne.appendChild(el);
      if (alt) {
        alt.inert = true;
        alt.classList.add('raus');
        el.classList.add('rein');
        setTimeout(() => alt.remove(), sperrRuhig() ? 0 : 320);
      }
      s = {
        resolve, fest, min, max, pruefe, text: t, slots: fest || max, eingabe: '', busy: false,
        box: el.querySelector('[data-punkte]'), textEl: el.querySelector('[data-text]'),
        laengeEl: el.querySelector('[data-laenge]'), weiter: el.querySelector('[data-weiter]'),
      };
      punkte();
      hinweis();
    });
  return { frage, zu };
}
function pinDialog(opts) {
  const m = pinModal();
  return m.frage(opts).then(wert => { m.zu(); return wert === 'zurueck' ? null : wert; });
}
// PIN im Dialog pruefen — mit Wartezeit und Zaehlung, an JEDER Stelle, die
// eine PIN annimmt (sonst liesse sich ueber "PIN aendern" unbegrenzt raten).
// Liefert true, eine Meldung (Fenster bleibt offen und wackelt) oder
// { text } (Wartezeit — Fenster zu, Meldung oben).
async function pinPruefeDialog(pin) {
  const warte = pinWarteBis() - Date.now();
  if (warte > 0) return { text: `Zu viele falsche Versuche. Warte noch ${sperrWarteText(warte)}.` };
  if (await pinPruefen(pin)) { lsSetzen(PIN_FEHL_KEY, JSON.stringify({ n: 0, bis: 0 })); return true; }
  pinFehlversuch();
  const danach = pinWarteBis() - Date.now();
  if (danach > 0) return { text: `Zu viele falsche Versuche. Warte ${sperrWarteText(danach)}.` };
  return 'Falsche PIN';
}
function passwortDialog(titel, text, { mitVergessen = true } = {}) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'overlay';
    wrap.innerHTML = `<div class="modal modal-left">
      <h2 class="card-h">${esc(titel)}</h2>
      <p class="muted" style="font-size:.84rem">${esc(text)}</p>
      <input class="input" type="password" maxlength="64" placeholder="Passwort" autocomplete="current-password" data-pass>
      <div class="form-row">
        <button class="btn btn-small btn-ghost" data-abbrechen type="button">Abbrechen</button>
        <button class="btn btn-small" data-ok type="button">Weiter</button>
      </div>
      ${mitVergessen ? '<button class="link-knopf" data-vergessen type="button">Passwort auch vergessen?</button>' : ''}
    </div>`;
    document.body.appendChild(wrap);
    const feld = wrap.querySelector('[data-pass]');
    const fertig = wert => { wrap.classList.add('closing'); setTimeout(() => wrap.remove(), 220); resolve(wert); };
    wrap.querySelector('[data-abbrechen]').onclick = () => fertig(null);
    wrap.querySelector('[data-ok]').onclick = () => feld.value && fertig(feld.value);
    feld.addEventListener('keydown', e => { if (e.key === 'Enter' && feld.value) fertig(feld.value); });
    wrap.querySelector('[data-vergessen]')?.addEventListener('click', () => { fertig(null); passwortVergessenDialog(); });
    wrap.addEventListener('click', e => { if (e.target === wrap) fertig(null); });
    setTimeout(() => feld.focus(), 60);
  });
}

// ---- PIN einrichten, aendern, entfernen, vergessen
async function pinEinrichten() {
  if (!pinMoeglich()) return island('Dieses Gerät kann keine PIN sicher speichern');
  if (!state.token) return island('Die PIN gehört zu deinem Konto, bitte zuerst anmelden');
  const m = pinModal();
  const hatte = pinGesetzt();
  let altPin = '';
  if (hatte) {
    const alt = await m.frage({ titel: 'Aktuelle PIN', text: 'Erst die bisherige PIN, dann die neue', fest: pinDaten().laenge || 4, pruefe: pinPruefeDialog });
    if (alt === null) return m.zu();
    altPin = alt;
  }
  let neu = null;
  for (;;) {
    neu = await m.frage({ titel: hatte ? 'Neue PIN' : 'PIN festlegen', text: 'Gilt für dein Konto, auf all deinen Geräten.', schritt: 1, von: 2 });
    if (neu === null || neu === 'zurueck') return m.zu();
    const wdh = await m.frage({ titel: 'PIN wiederholen', text: 'Zur Sicherheit noch einmal dieselbe PIN', schritt: 2, von: 2,
      fest: neu.length, zurueck: true, pruefe: w => w === neu || 'Stimmt nicht überein, nochmal' });
    if (wdh === null) return m.zu();
    if (wdh !== 'zurueck') break;
  }
  m.zu();
  try { await pinSpeichern(neu, altPin); }
  catch (e) { return island(/fetch|netz|network/i.test(String(e.message)) ? 'Zum Festlegen der PIN brauchst du Internet' : e.message); }
  walletEntsperrt = true;
  lsSetzen(PIN_HINWEIS_KEY, String(Date.now()));
  playSfx('coin'); buzz(20);
  island('PIN gespeichert, sie gilt auf all deinen Geräten');
  if (!bioAn() && await bioVerfuegbar()
    && await askConfirm('Auch mit Face ID oder Fingerabdruck entsperren?', { okLabel: 'Ja, einrichten' })) {
    await bioEinrichten();
  }
  renderWallet();
  renderSicherheit();
}
async function pinAusschalten() {
  const alt = await pinDialog({ titel: 'PIN eingeben', text: 'Zum Entfernen der Sperre (auf all deinen Geräten)', fest: pinDaten().laenge || 4, pruefe: pinPruefeDialog });
  if (alt === null) return;
  try { await api('/api/pin/entfernen', { method: 'POST', body: JSON.stringify({ alt }) }); }
  catch (e) { return island(/fetch|netz|network/i.test(String(e.message)) ? 'Zum Entfernen der PIN brauchst du Internet' : e.message); }
  pinEntfernen();
  walletEntsperrt = true;
  island('PIN entfernt, auf all deinen Geräten');
  renderWallet();
  renderSicherheit();
}
async function pinVergessen() {
  if (!state.token) {
    // Abgemeldet: Anmelden entsperrt die Wallet (das Passwort beweist es)
    island('Melde dich an, dann ist die Wallet entsperrt');
    switchView('profile');
    return;
  }
  const pass = await passwortDialog('PIN vergessen?',
    'Gib dein kumulio-Passwort ein. Danach ist die PIN gelöscht, auf all deinen Geräten, und du kannst eine neue festlegen.');
  if (!pass) return;
  try {
    await api('/api/pin/entfernen', { method: 'POST', body: JSON.stringify({ pass }) });
  } catch (e) { island(e.message); return; }
  pinEntfernen();
  entsperreWallet();
  if (await askConfirm('PIN gelöscht. Gleich eine neue festlegen?', { okLabel: 'Neue PIN' })) pinEinrichten();
}

// Wallet entsperren ausserhalb des Sperrbildschirms (z. B. vor dem Auspacken
// eines Geschenks): Face ID, falls eingerichtet, sonst die PIN
async function walletFreigeben() {
  if (!walletGesperrt()) return true;
  if (pinWarteBis() > Date.now()) { island('Zu viele falsche Versuche, bitte kurz warten'); return false; }
  if (bioAn() && !bioLaeuft && await bioPruefen()) { entsperreWallet(); return true; }
  const pin = await pinDialog({ titel: 'Wallet entsperren', text: 'Gib deine PIN ein', fest: (pinDaten() || {}).laenge || 4, pruefe: pinPruefeDialog });
  if (pin === null) return false;
  entsperreWallet();
  return true;
}
// Empfehlung in der Wallet: wer noch keine PIN hat, bekommt sie angeboten
function zeigePinEmpfehlung() {
  const el = $('#pin-empfehlung');
  if (!el) return;
  const spaeter = Number(localStorage.getItem(PIN_HINWEIS_KEY) || 0);
  el.classList.toggle('hidden', !(state.token && pinMoeglich() && !pinGesetzt() && Date.now() - spaeter > 7 * 864e5));
}
$('#pe-ja')?.addEventListener('click', () => pinEinrichten());
$('#pe-spaeter')?.addEventListener('click', () => { lsSetzen(PIN_HINWEIS_KEY, String(Date.now())); zeigePinEmpfehlung(); });

// ---- Einstellungen: Sicherheit
async function renderSicherheit() {
  const card = $('#sicherheit-card');
  if (!card) return;
  card.classList.toggle('hidden', !state.token);
  if (!state.token) return;
  const pin = pinGesetzt();
  const bioGemeldet = pin && await bioVerfuegbar();
  // Bedienbar, sobald der Browser es grundsaetzlich kann — auch wenn die
  // Vorab-Abfrage nein sagt (die irrt sich manchmal)
  const bioOk = pin && (bioGemeldet || (bioGrundsaetzlich() && !bioInAppBrowser()));
  // Warum es hier nicht geht, statt die Zeile still wegzulassen
  const bioGrund = !window.PublicKeyCredential || bioInAppBrowser()
    ? 'Dieser Browser kann es nicht, etwa der eingebaute Browser von Instagram oder TikTok. Öffne kumulio in Safari oder Chrome.'
    : 'Auf diesem Gerät ist keine Face ID und kein Fingerabdruck eingerichtet, oder der Browser gibt sie nicht frei. In den Handy-Einstellungen einrichten und kumulio neu öffnen.';
  const bioText = bioLetzterFehler
    || (bioGemeldet ? 'Wallet ohne PIN-Eingabe entsperren, auf diesem Gerät'
      : bioOk ? 'Dein Browser meldet es nicht sicher. Probier es einfach aus: Klappt es nicht, steht hier der Grund.'
        : bioGrund);
  const k = kontoInfo || {};
  card.innerHTML = `
    <h2 class="card-h">Sicherheit</h2>
    <div class="settings-row">
      <div class="settings-label"><b>Wallet-PIN</b>
        <span>${pin ? 'Deine Wallet ist mit einer PIN gesperrt, auf all deinen Geräten.' : 'Sperrt deine Wallet auf all deinen Geräten, damit niemand deine Codes sieht. Empfohlen.'}</span></div>
      <div class="sr-knoepfe">${pin
        ? '<button class="btn btn-small btn-ghost" id="si-pin-aendern" type="button">Ändern</button><button class="btn btn-small btn-ghost" id="si-pin-weg" type="button">Entfernen</button>'
        : `<button class="btn btn-small" id="si-pin-an" type="button" ${pinMoeglich() ? '' : 'disabled'}>Festlegen</button>`}</div>
    </div>
    ${pin ? `<div class="settings-row">
      <div class="settings-label"><b>Face ID / Fingerabdruck</b><span id="si-bio-text"${bioLetzterFehler ? ' class="si-fehler"' : ''}>${esc(bioText)}</span></div>
      <label class="switch"><input type="checkbox" id="si-bio" ${bioOk && bioAn() ? 'checked' : ''} ${bioOk ? '' : 'disabled'}><span class="switch-slider"></span></label>
    </div>` : ''}
    <div class="settings-row">
      <div class="settings-label"><b>Zwei-Faktor-Anmeldung</b>
        <span>${k.zweiFaktor
          ? `An: bei jeder Anmeldung braucht es zusätzlich den Code aus deiner Authenticator-App. Noch ${k.ersatzcodes || 0} Ersatzcodes.`
          : 'Bei der Anmeldung zusätzlich ein Code aus einer Authenticator-App. Schützt dein Konto, falls jemand dein Passwort kennt.'}</span></div>
      <button class="btn btn-small ${k.zweiFaktor ? 'btn-ghost' : ''}" id="si-2fa" type="button">${k.zweiFaktor ? 'Ausschalten' : 'Einrichten'}</button>
    </div>
    <div class="settings-row">
      <div class="settings-label"><b>E-Mail-Adresse</b>
        <span>${k.hatEmail ? `${esc(k.emailMaske || '')} · ${k.emailOk ? 'bestätigt' : 'noch nicht bestätigt: ohne Bestätigung gibt es keinen Link, falls du dein Passwort vergisst'}` : 'Keine hinterlegt.'}</span></div>
      ${k.hatEmail && !k.emailOk ? `<button class="btn btn-small" id="si-email" type="button" ${k.mailBereit ? '' : 'disabled'}>Bestätigen</button>` : ''}
    </div>
    <div class="settings-row">
      <div class="settings-label"><b>Aufgebrauchte aufräumen</b>
        <span>Aufgebrauchte Gutscheine 30 Tage nach der letzten Buchung automatisch entfernen. Ein Jahr lang holst du sie im Papierkorb zurück, die Statistik bleibt.</span></div>
      <label class="switch"><input type="checkbox" id="si-aufraeumen" ${k.autoAufraeumen !== false ? 'checked' : ''}><span class="switch-slider"></span></label>
    </div>
    <div class="settings-row">
      <div class="settings-label"><b>Papierkorb</b><span>Gelöschte und aufgeräumte Gutscheine und Karten, ein Jahr lang</span></div>
      <button class="btn btn-small btn-ghost" id="si-korb" type="button">Öffnen</button>
    </div>`;
  $('#si-email')?.addEventListener('click', async e => {
    try {
      const r = await api('/api/email/senden', { method: 'POST', body: '{}' });
      island(r.schonBestaetigt ? 'Schon bestätigt' : 'Bestätigungslink ist unterwegs — schau in dein Postfach');
      e.target.disabled = true;
    } catch (err) { island(err.message); }
  });
  $('#si-korb')?.addEventListener('click', papierkorbZeigen);
  $('#si-pin-an')?.addEventListener('click', pinEinrichten);
  $('#si-pin-aendern')?.addEventListener('click', pinEinrichten);
  $('#si-pin-weg')?.addEventListener('click', pinAusschalten);
  $('#si-bio')?.addEventListener('change', async e => {
    if (e.target.checked) {
      // Face ID oeffnet die Wallet ohne PIN — einschalten also nur mit der PIN
      const pin = await pinDialog({ titel: 'PIN eingeben', text: 'Zum Einschalten von Face ID / Fingerabdruck', fest: (pinDaten() || {}).laenge || 4, pruefe: pinPruefeDialog });
      if (pin === null) e.target.checked = false;
      else if (!await bioEinrichten()) {
        e.target.checked = false;
        // Der Grund bleibt in der Zeile stehen, bis es klappt
        const t = $('#si-bio-text');
        if (t && bioLetzterFehler) { t.textContent = bioLetzterFehler; t.classList.add('si-fehler'); }
      } else {
        bioLetzterFehler = '';
        const t = $('#si-bio-text');
        if (t) { t.textContent = 'Wallet ohne PIN-Eingabe entsperren, auf diesem Gerät'; t.classList.remove('si-fehler'); }
      }
    }
    else { try { localStorage.removeItem(bioSchluessel()); } catch { } }
  });
  $('#si-2fa')?.addEventListener('click', () => (k.zweiFaktor ? zweiFaktorAusschalten() : zweiFaktorEinrichten()));
  $('#si-aufraeumen')?.addEventListener('change', async e => {
    try {
      const r = await api('/api/einstellungen', { method: 'POST', body: JSON.stringify({ autoAufraeumen: e.target.checked }) });
      kontoInfo = { ...(kontoInfo || {}), autoAufraeumen: r.autoAufraeumen };
      renderWallet();
    } catch (err) { e.target.checked = !e.target.checked; island(err.message); }
  });
}
async function ladeKontoInfo() {
  if (!state.token) { kontoInfo = null; return null; }
  try { kontoInfo = await api('/api/me'); } catch { /* offline */ }
  return kontoInfo;
}

// ---- Papierkorb: ein Jahr lang zurueckholen, was aus der Wallet verschwand
async function papierkorbZeigen() {
  if (walletGesperrt() && !await walletFreigeben()) return;
  let liste;
  try { liste = (await api('/api/papierkorb')).liste; } catch (e) { return island(e.message); }
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  const zeile = e => `<div class="korb-zeile">
      <div class="korb-info"><b>${esc(e.vendor || 'Eintrag')}</b>
        <span>${e.typ === 'karte' ? 'Sparkarte' : e.art === 'rabatt' ? 'Rabattcode' : e.art === 'pfand' ? 'Pfandbon' + (e.amount != null ? ' ' + euroFmt(e.amount) : '') : (e.amount != null ? euroFmt(e.amount) : 'Gutschein')}${e.balance != null && e.typ !== 'karte' ? ' · Rest ' + euroFmt(e.balance) : ''}
          · ${esc(e.grund || '')} · ${new Date(e.ts).toLocaleDateString('de-DE')}</span></div>
      ${e.verschenkt ? '<span class="pill">verschenkt</span>' : `<button class="btn btn-small btn-ghost" data-zurueck="${esc(e.key)}" type="button">Zurückholen</button>`}
    </div>`;
  wrap.innerHTML = `<div class="modal modal-left korb-modal">
    <h2 class="card-h">Papierkorb</h2>
    <p class="muted" style="font-size:.82rem">Was aus deiner Wallet verschwunden ist, liegt hier ein Jahr lang.</p>
    <div class="korb-liste">${liste.length ? liste.map(zeile).join('') : '<div class="status">Leer.</div>'}</div>
    <div class="form-row"><button class="btn btn-small" data-zu type="button">Schließen</button></div>
  </div>`;
  document.body.appendChild(wrap);
  const zu = () => { wrap.classList.add('closing'); setTimeout(() => wrap.remove(), 220); };
  wrap.querySelector('[data-zu]').onclick = zu;
  wrap.addEventListener('click', async ev => {
    if (ev.target === wrap) return zu();
    const b = ev.target.closest('[data-zurueck]');
    if (!b) return;
    b.disabled = true;
    try {
      await api('/api/papierkorb/zurueck', { method: 'POST', body: JSON.stringify({ key: b.dataset.zurueck }) });
      b.closest('.korb-zeile').remove();
      island('Zurück in der Wallet');
      pullWallet();
    } catch (e) { b.disabled = false; island(e.message); }
  });
}

// ---- Zwei-Faktor: einrichten (QR fuer die Authenticator-App) und ausschalten
async function ladeZxingSkript() {
  if (window.ZXing) return true;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = '/vendor/zxing.min.js'; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  }).catch(() => { });
  return !!window.ZXing;
}
async function zweiFaktorEinrichten() {
  let r;
  try { r = await api('/api/2fa/start', { method: 'POST', body: '{}' }); } catch (e) { return island(e.message); }
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `<div class="modal modal-left zf-modal">
    <h2 class="card-h">Zwei-Faktor einrichten</h2>
    <ol class="zf-schritte">
      <li>Öffne eine Authenticator-App (z. B. Google Authenticator, Microsoft Authenticator, 2FAS oder Apple Passwörter).</li>
      <li>Scanne den QR-Code oder gib den Schlüssel von Hand ein.</li>
      <li>Tipp den 6-stelligen Code ein, den die App anzeigt.</li>
    </ol>
    <div class="zf-qr" data-qr>QR-Code lädt …</div>
    <div class="zf-schluessel"><code>${esc(r.secret.replace(/(.{4})/g, '$1 ').trim())}</code>
      <button class="btn btn-small btn-ghost" data-kopieren type="button">Kopieren</button></div>
    <a class="link-knopf" href="${esc(r.uri)}">Direkt in der Authenticator-App öffnen</a>
    <input class="input" data-code inputmode="numeric" maxlength="6" placeholder="6-stelliger Code" autocomplete="one-time-code">
    <div class="form-msg" data-msg></div>
    <div class="form-row">
      <button class="btn btn-small btn-ghost" data-abbrechen type="button">Abbrechen</button>
      <button class="btn btn-small" data-an type="button">Einschalten</button>
    </div>
  </div>`;
  document.body.appendChild(wrap);
  const zu = () => { wrap.classList.add('closing'); setTimeout(() => wrap.remove(), 220); };
  wrap.querySelector('[data-abbrechen]').onclick = zu;
  wrap.querySelector('[data-kopieren]').onclick = () => copyText(r.secret);
  if (await ladeZxingSkript() && window.ZXing.BrowserQRCodeSvgWriter) {
    try {
      const svg = new ZXing.BrowserQRCodeSvgWriter().write(r.uri, 208, 208);
      const qr = wrap.querySelector('[data-qr]');
      qr.textContent = '';
      qr.appendChild(svg);
    } catch { wrap.querySelector('[data-qr]').textContent = 'QR-Code geht gerade nicht — nimm den Schlüssel darunter.'; }
  } else wrap.querySelector('[data-qr]').textContent = 'QR-Code geht gerade nicht — nimm den Schlüssel darunter.';
  const msg = wrap.querySelector('[data-msg]');
  const code = wrap.querySelector('[data-code]');
  const an = async () => {
    msg.className = 'form-msg'; msg.textContent = '';
    try {
      const x = await api('/api/2fa/aktivieren', { method: 'POST', body: JSON.stringify({ code: code.value }) });
      zu();
      zeigeErsatzcodes(x.ersatzcodes);
      await ladeKontoInfo();
      renderSicherheit();
    } catch (e) { msg.className = 'form-msg error'; msg.textContent = e.message; }
  };
  wrap.querySelector('[data-an]').onclick = an;
  code.addEventListener('keydown', e => { if (e.key === 'Enter') an(); });
}
function zeigeErsatzcodes(codes) {
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `<div class="modal modal-left">
    <h2 class="card-h">Zwei-Faktor ist an</h2>
    <p class="muted" style="font-size:.84rem">Heb diese Ersatzcodes sicher auf (z. B. im Passwort-Manager). Jeder gilt einmal — für den Fall,
      dass du dein Handy mit der Authenticator-App nicht zur Hand hast.</p>
    <div class="zf-ersatz">${codes.map(c => `<code>${esc(c)}</code>`).join('')}</div>
    <div class="form-row">
      <button class="btn btn-small btn-ghost" data-kopieren type="button">Alle kopieren</button>
      <button class="btn btn-small" data-ok type="button">Gesichert</button>
    </div>
  </div>`;
  document.body.appendChild(wrap);
  wrap.querySelector('[data-kopieren]').onclick = () => copyText(codes.join('\n'));
  wrap.querySelector('[data-ok]').onclick = () => { wrap.classList.add('closing'); setTimeout(() => wrap.remove(), 220); };
}
async function zweiFaktorAusschalten() {
  const pass = await passwortDialog('Zwei-Faktor ausschalten', 'Zur Sicherheit: dein Passwort.', { mitVergessen: false });
  if (!pass) return;
  try {
    await api('/api/2fa/aus', { method: 'POST', body: JSON.stringify({ pass }) });
    island('Zwei-Faktor ist aus');
    await ladeKontoInfo();
    renderSicherheit();
  } catch (e) { island(e.message); }
}
// Anmeldung, zweiter Schritt: nur hier fragt kumulio nach dem Code
function zweiFaktorAnmeldung(ticket) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'overlay';
    wrap.innerHTML = `<div class="modal modal-left">
      <h2 class="card-h">Bestätigungscode</h2>
      <p class="muted" style="font-size:.84rem">Gib den 6-stelligen Code aus deiner Authenticator-App ein.</p>
      <input class="input" data-code inputmode="numeric" maxlength="11" placeholder="123456" autocomplete="one-time-code">
      <div class="form-msg" data-msg></div>
      <div class="form-row">
        <button class="btn btn-small btn-ghost" data-abbrechen type="button">Abbrechen</button>
        <button class="btn btn-small" data-ok type="button">Anmelden</button>
      </div>
      <button class="link-knopf" data-ersatz type="button">Handy nicht zur Hand? Ersatzcode verwenden</button>
    </div>`;
    document.body.appendChild(wrap);
    const code = wrap.querySelector('[data-code]');
    const msg = wrap.querySelector('[data-msg]');
    const fertig = wert => { wrap.classList.add('closing'); setTimeout(() => wrap.remove(), 220); resolve(wert); };
    const senden = async () => {
      msg.className = 'form-msg'; msg.textContent = '';
      try {
        const r = await api('/api/login/2fa', { method: 'POST', body: JSON.stringify({ ticket, code: code.value }) });
        if (r.restErsatzcodes != null && r.restErsatzcodes <= 2 && !/^\d{6}$/.test(code.value.trim())) {
          setTimeout(() => island(`Nur noch ${r.restErsatzcodes} Ersatzcodes. Neue gibt es, wenn du Zwei-Faktor neu einrichtest.`, 5000), 2500);
        }
        fertig(r);
      } catch (e) {
        msg.className = 'form-msg error'; msg.textContent = e.message;
        if (e.status === 429 || e.status === 400) setTimeout(() => fertig(null), 1800);
      }
    };
    wrap.querySelector('[data-ok]').onclick = senden;
    wrap.querySelector('[data-abbrechen]').onclick = () => fertig(null);
    wrap.querySelector('[data-ersatz]').onclick = () => {
      code.setAttribute('inputmode', 'text'); code.placeholder = 'abcde-fghij'; code.value = ''; code.focus();
    };
    code.addEventListener('keydown', e => { if (e.key === 'Enter') senden(); });
    setTimeout(() => code.focus(), 60);
  });
}

// ---- Passwort vergessen: Link per E-Mail
function passwortVergessenDialog(vorbelegt = '') {
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `<div class="modal modal-left">
    <h2 class="card-h">Passwort vergessen?</h2>
    <p class="muted" style="font-size:.84rem">Gib deinen Benutzernamen oder deine E-Mail-Adresse ein. Wir schicken dir einen Link,
      mit dem du ein neues Passwort festlegst — an die bestätigte E-Mail-Adresse deines Kontos.</p>
    <input class="input" data-login maxlength="80" placeholder="Benutzername oder E-Mail" autocomplete="username" value="${esc(vorbelegt)}">
    <div id="ts-forgot" class="ts-widget"></div>
    <div class="form-msg" data-msg></div>
    <div class="form-row">
      <button class="btn btn-small btn-ghost" data-abbrechen type="button">Schließen</button>
      <button class="btn btn-small" data-senden type="button">Link schicken</button>
    </div>
  </div>`;
  document.body.appendChild(wrap);
  tsWidgets.forgot = null; tsTries.forgot = 0;
  renderTurnstile('forgot');
  const msg = wrap.querySelector('[data-msg]');
  const zu = () => {
    try { if (tsWidgets.forgot !== null) turnstile.remove(tsWidgets.forgot); } catch { }
    tsWidgets.forgot = null;
    wrap.classList.add('closing'); setTimeout(() => wrap.remove(), 220);
  };
  wrap.querySelector('[data-abbrechen]').onclick = zu;
  const senden = async () => {
    const login = wrap.querySelector('[data-login]').value.trim();
    if (!login) return;
    const knopf = wrap.querySelector('[data-senden]');
    setBtnLoading(knopf, true);
    msg.className = 'form-msg'; msg.textContent = '';
    try {
      const r = await api('/api/password/forgot', { method: 'POST', body: JSON.stringify({ login, turnstileToken: tsToken('forgot') }) });
      msg.className = 'form-msg ok'; msg.textContent = r.text;
      knopf.classList.add('hidden');
    } catch (e) {
      msg.className = 'form-msg error'; msg.textContent = e.message;
      renderTurnstile('forgot');
    } finally { setBtnLoading(knopf, false); }
  };
  wrap.querySelector('[data-senden]').onclick = senden;
}
// Link aus der Mail: neues Passwort festlegen
async function neuesPasswortDialog(token) {
  // Zu welchem Konto gehoert der Link? Steht gross oben — ein fremder Link
  // (Konto eines anderen) faellt so sofort auf
  let fuer = '';
  try { fuer = (await api('/api/password/reset-info', { method: 'POST', body: JSON.stringify({ token }) })).user; }
  catch (e) { await askConfirm(e.message, { alertOnly: true }); return; }
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `<div class="modal modal-left">
    <h2 class="card-h">Neues Passwort für @${esc(fuer)}</h2>
    <p class="muted" style="font-size:.84rem">Mindestens 6 Zeichen. Danach bist du überall abgemeldet und meldest dich mit dem neuen Passwort an.
      Nicht dein Konto? Dann schließ dieses Fenster.</p>
    <input class="input" type="password" data-p1 maxlength="64" placeholder="Neues Passwort" autocomplete="new-password">
    <input class="input" type="password" data-p2 maxlength="64" placeholder="Nochmal zur Sicherheit" autocomplete="new-password">
    <div class="form-msg" data-msg></div>
    <div class="form-row">
      <button class="btn btn-small btn-ghost" data-abbrechen type="button">Abbrechen</button>
      <button class="btn btn-small" data-ok type="button">Speichern</button>
    </div>
  </div>`;
  document.body.appendChild(wrap);
  const msg = wrap.querySelector('[data-msg]');
  const zu = () => { wrap.classList.add('closing'); setTimeout(() => wrap.remove(), 220); };
  wrap.querySelector('[data-abbrechen]').onclick = zu;
  wrap.querySelector('[data-ok]').onclick = async () => {
    const p1 = wrap.querySelector('[data-p1]').value, p2 = wrap.querySelector('[data-p2]').value;
    msg.className = 'form-msg error';
    if (p1.length < 6) { msg.textContent = 'Mindestens 6 Zeichen.'; return; }
    if (p1 !== p2) { msg.textContent = 'Die Passwörter stimmen nicht überein.'; return; }
    try {
      const r = await api('/api/password/reset', { method: 'POST', body: JSON.stringify({ token, pass: p1 }) });
      zu();
      await askConfirm(`Passwort für @${r.user} geändert. Melde dich jetzt mit dem neuen Passwort an${r.zweiFaktor ? ' (und deinem Bestätigungscode)' : ''}.`, { alertOnly: true });
      if (state.token && state.userName === r.user) { state.token = ''; localStorage.removeItem('ra.token'); walletEntsperrt = false; refreshProfileTab(); }
      switchView('profile');
      if (r.user) $('#auth-user').value = r.user;
      $('#auth-pass')?.focus();
    } catch (e) { msg.textContent = e.message; }
  };
}
// Einstiege ueber Links (Mail): ?reset=… bzw. ?passwort-vergessen=1
function pruefeKontoLinks() {
  const q = new URLSearchParams(location.search);
  const token = q.get('reset');
  const vergessen = q.get('passwort-vergessen');
  const emailOk = q.get('email-ok');
  if (!token && !vergessen && !emailOk) return;
  q.delete('reset'); q.delete('passwort-vergessen'); q.delete('email-ok');
  const rest = q.toString();
  history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
  if (token) neuesPasswortDialog(token);
  else if (emailOk) {
    api('/api/email/bestaetigen', { method: 'POST', body: JSON.stringify({ token: emailOk }) })
      .then(r => { island(`E-Mail bestätigt${r.user ? ' für @' + r.user : ''}`); ladeKontoInfo().then(renderSicherheit); })
      .catch(e => askConfirm(e.message, { alertOnly: true }));
  } else passwortVergessenDialog();
}

// ---------------- Laden-Erkennung (Standort, nur mit Erlaubnis) ----------------
// Wie bei Payback: steht man in einem Laden, fuer den etwas in der Wallet liegt,
// kommt von oben die Frage, ob die Wallet auf diese Marke umstellen soll.
// Eine Web-App bekommt den Standort nur, solange sie offen ist — im Hintergrund
// ginge das erst mit der nativen App. Ans Konto geht nur ein auf ~100 m
// gerundeter Punkt (fuer die Laden-Liste aus OpenStreetMap). Ob man IN einem
// Laden steht, rechnet das Geraet selbst mit der genauen Position aus.
function ladenSchluessel() { return 'ra.ladenErkennung:' + (state.userName || ''); }
function ladenErkennungAn() { try { return !!state.userName && localStorage.getItem(ladenSchluessel()) === '1'; } catch { return false; } }
function holePosition(timeout = 12000) {
  return new Promise(r => {
    if (!navigator.geolocation) return r({ fehler: 'keins' });
    navigator.geolocation.getCurrentPosition(p => r({ p }), e => r({ fehler: e && e.code === 1 ? 'verboten' : 'weg' }),
      { enableHighAccuracy: true, timeout, maximumAge: 60000 });
  });
}
function distanzM(a1, o1, a2, o2) {
  const rad = x => x * Math.PI / 180;
  const h = Math.sin(rad(a2 - a1) / 2) ** 2 + Math.cos(rad(a1)) * Math.cos(rad(a2)) * Math.sin(rad(o2 - o1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
// Marken, fuer die man etwas dabei hat: Gutscheine mit Guthaben, dazu Sparkarten
function markenImGepaeck() {
  const m = new Map();
  const eintrag = name => {
    const k = String(name || '').trim().toLowerCase();
    if (k.length < 2) return null;
    if (!m.has(k)) m.set(k, { name: String(name).trim(), n: 0, summe: 0, karte: false });
    return m.get(k);
  };
  for (const v of state.wallet.vouchers) {
    if (!v || ohneGuthaben(v) || !(v.balance == null || v.balance > 0)) continue;
    const e = eintrag(v.vendor);
    if (e) { e.n++; e.summe += v.balance || 0; }
  }
  for (const c of state.wallet.cards) { const e = c && eintrag(c.name); if (e) e.karte = true; }
  return [...m.values()];
}
// Karten heissen oft anders als der Laden ("Lidl Plus" -> Lidl, "IKEA Family" -> IKEA)
function ladenMarke(name) {
  return String(name || '').toLowerCase().replace(/\s+(plus|family|card|karte|app)$/, '').trim();
}
// "dm" soll nicht in "Admiral" stecken: nur als eigenes Wort. Traegt der Laden
// eine Marke (OSM brand), zaehlt nur die; sonst muss der Name damit ANFANGEN
// ("Bäckerei Müller" ist kein Müller-Drogeriemarkt)
function ladenPasst(laden, name) {
  const n = ladenMarke(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (n.length < 2) return false;
  const wort = `${n}($|[^a-z0-9äöüß])`;
  if (laden.b) return new RegExp(`(^|[^a-z0-9äöüß])${wort}`).test(String(laden.b).toLowerCase());
  return new RegExp(`^${wort}`).test(String(laden.n || '').toLowerCase().trim());
}
function ladenPause() { return lsJson('ra.ladenPause', {}); }
function setzeLadenPause(name, ms) {
  const p = ladenPause(), jetzt = Date.now();
  for (const k of Object.keys(p)) if (p[k] < jetzt) delete p[k];
  p[name.toLowerCase()] = jetzt + ms;
  lsSetzen('ra.ladenPause', JSON.stringify(p));
}
async function pruefeLaden({ sofort = false } = {}) {
  if (!ladenErkennungAn() || !state.token || ladenLaeuft || document.visibilityState !== 'visible') return;
  if (!sofort && Date.now() - ladenLetzt < 150e3) return;
  const marken = markenImGepaeck();
  if (!marken.length) return;
  ladenLaeuft = true;
  ladenLetzt = Date.now();
  try {
    const { p } = await holePosition();
    if (!p || !(p.coords.accuracy <= 150)) return; // zu ungenau fuer "im Laden"
    const { latitude: lat, longitude: lon, accuracy } = p.coords;
    const r = await api('/api/laeden', { method: 'POST',
      body: JSON.stringify({ lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 }) }).catch(() => null);
    if (!r || !Array.isArray(r.laeden)) return;
    const grenze = Math.max(45, Math.min(90, accuracy + 25));
    let treffer = null;
    for (const l of r.laeden) {
      const d = distanzM(lat, lon, Number(l.lat), Number(l.lon));
      if (!(d <= grenze)) continue;
      const m = marken.find(mk => ladenPasst(l, mk.name));
      if (m && (!treffer || d < treffer.d)) treffer = { ...m, d };
    }
    if (treffer) zeigeLadenBanner(treffer);
  } finally { ladenLaeuft = false; }
}
// Von oben herein: "Du bist bei REWE" — Umstellen, Nein danke, oder nach oben wischen
function zeigeLadenBanner(m) {
  const k = m.name.toLowerCase();
  if ((ladenPause()[k] || 0) > Date.now() || document.querySelector('.laden-banner') || state.sheetMode) return;
  if (state.activeView === 'wallet' && String(state.walletFilter || '').toLowerCase() === k) return;
  const nurKarte = !m.n;
  // Gesperrt: weder Marke noch Betraege — die Sperre verbirgt, was in der Wallet liegt
  const zu = walletGesperrt();
  const unter = zu ? 'Entsperre die Wallet, dann steht sie auf dem passenden Laden.'
    : nurKarte ? `Deine ${m.name}-Karte liegt bereit.`
    : `${m.n} Gutschein${m.n === 1 ? '' : 'e'} · ${euroFmt(Math.round(m.summe * 100) / 100)}. Wallet auf ${m.name} umstellen?`;
  const el = document.createElement('div');
  el.className = 'laden-banner';
  el.setAttribute('role', 'status');
  el.innerHTML = `${zu ? `<span class="lb-icon">${icon('pin', 'icon')}</span>` : brandChipHtml(m.name)}
    <div class="lb-text"><b>${zu ? 'Passender Laden in der Nähe' : `Du bist bei ${esc(m.name)}`}</b><small>${esc(unter)}</small></div>
    <button class="btn btn-small lb-ja" type="button">${zu ? 'Öffnen' : nurKarte ? 'Karte zeigen' : 'Umstellen'}</button>
    <button class="lb-nein" type="button" aria-label="Nein danke">${icon('x', 'icon icon-sm')}</button>`;
  document.body.appendChild(el);
  buzz(12);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('da')));
  let uhr = 0;
  const weg = () => {
    clearTimeout(uhr);
    el.classList.remove('da');
    setTimeout(() => el.remove(), 480);
  };
  uhr = setTimeout(() => { setzeLadenPause(m.name, 45 * 60e3); weg(); }, 15000);
  el.querySelector('.lb-nein').onclick = () => { setzeLadenPause(m.name, 8 * 3600e3); weg(); };
  el.querySelector('.lb-ja').onclick = () => { setzeLadenPause(m.name, 3 * 3600e3); weg(); walletAufMarke(m.name, nurKarte); };
  // Nach oben wischen schliesst (wie eine Mitteilung)
  let sy = null;
  el.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    sy = e.clientY;
    el.style.transition = 'none';
    try { el.setPointerCapture(e.pointerId); } catch { }
  });
  el.addEventListener('pointermove', e => {
    if (sy == null) return;
    el.style.transform = `translate3d(-50%, ${Math.min(0, e.clientY - sy)}px, 0)`;
  });
  const los = e => {
    if (sy == null) return;
    const dy = e.clientY - sy;
    sy = null;
    el.style.transition = '';
    el.style.transform = '';
    if (dy < -30) { setzeLadenPause(m.name, 8 * 3600e3); weg(); }
  };
  el.addEventListener('pointerup', los);
  el.addEventListener('pointercancel', los);
}
// Wallet auf eine Marke stellen (Filter + Marken-Ansicht); nur Karte: Karten-Blatt
function walletAufMarke(name, nurKarte = false) {
  if (state.activeView !== 'wallet') switchView('wallet');
  if (nurKarte) {
    if (walletTab !== 'coupons') document.querySelector('[data-wtab="coupons"]')?.click();
    const b = walletBrands().find(x => x.key === name.trim().toLowerCase());
    if (b && walletGesperrt()) markeWartet = b.key;
    else if (b) setTimeout(() => openBrandSheet(b.key), 350);
    return;
  }
  state.walletFilter = name;
  state.walletVal = 0;
  state.walletQuery = '';
  if ($('#wallet-search')) $('#wallet-search').value = '';
  saveWalletFilter();
  restack();
  if (walletTab !== 'gutscheine') document.querySelector('[data-wtab="gutscheine"]')?.click();
  renderWallet();
  window.scrollTo({ top: 0, behavior: sperrRuhig() ? 'auto' : 'smooth' });
}
// Einstellungen: Schalter fragt beim Einschalten nach dem Standort
{
  const sw = $('#sw-laden');
  if (sw) {
    sw.checked = ladenErkennungAn();
    if (!navigator.geolocation) sw.disabled = true;
    sw.addEventListener('change', async () => {
      const msg = $('#laden-msg');
      if (!sw.checked) { lsSetzen(ladenSchluessel(), '0'); msg.textContent = ''; return; }
      if (!state.token) { sw.checked = false; msg.className = 'form-msg error'; msg.textContent = 'Bitte zuerst anmelden.'; return; }
      msg.className = 'form-msg';
      msg.textContent = 'Frage nach dem Standort …';
      const { p, fehler } = await holePosition(15000);
      if (!p) {
        sw.checked = false;
        lsSetzen(ladenSchluessel(), '0');
        msg.className = 'form-msg error';
        msg.textContent = fehler === 'verboten'
          ? 'Der Standort ist für kumulio gesperrt. Erlaube ihn in den Einstellungen des Handys bzw. Browsers und schalte dann nochmal ein.'
          : 'Der Standort ist gerade nicht verfügbar. Versuch es draußen nochmal.';
        return;
      }
      lsSetzen(ladenSchluessel(), '1');
      msg.className = 'form-msg ok';
      msg.textContent = 'An. Stehst du in einem Laden, für den du etwas dabei hast, fragt kumulio nach.';
      ladenLetzt = 0;
      pruefeLaden({ sofort: true });
    });
  }
}
// Beim Zurueckkommen in die App und alle paar Minuten, solange sie offen ist
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(() => pruefeLaden(), 1200); });
setInterval(() => pruefeLaden(), 60e3);

// ---------------- Teilen aus anderen Apps (Screenshot -> kumulio) ----------------
// Android (installierte Web-App): kumulio steht im Teilen-Menue. Der Service
// Worker nimmt die Bilder an (manifest share_target), legt sie kurz im Cache ab
// und oeffnet die App mit ?teilen=<id>&n=<anzahl>. Hier landen sie direkt im
// Hinzufuegen-Blatt — genau wie "Bild hochladen", inklusive Scan.
// Geteilter Text (z. B. ein Rabattcode aus einer Mail) oeffnet das
// Rabattcode-Formular mit erkanntem Code.
async function pruefeGeteiltes() {
  const q = new URLSearchParams(location.search);
  const id = q.get('teilen');
  if (!id) return;
  const n = Math.min(10, Number(q.get('n')) || 0);
  q.delete('teilen'); q.delete('n');
  const rest = q.toString();
  history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
  if (id === 'fehler' || !/^[a-z0-9]{1,20}$/.test(id)) { island('Das Teilen hat nicht geklappt, bitte nochmal'); return; }
  // Echtes Teilen startet die installierte App. Im normalen Browser-Tab kaeme
  // ?teilen nur von einem fremden Formular — das wird ignoriert.
  let installiert = false;
  try { installiert = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch { }
  if (!installiert) { try { for (const k of await (await caches.open('kumulio-teilen')).keys()) await (await caches.open('kumulio-teilen')).delete(k); } catch { } return; }
  let cache = null;
  try { cache = await caches.open('kumulio-teilen'); } catch { }
  if (!cache) return;
  const dateien = [];
  for (let i = 0; i < n; i++) {
    const r = await cache.match(`/teilen-datei/${id}/${i}`);
    if (!r) continue;
    const blob = await r.blob();
    if (!/^image\//.test(blob.type || '')) continue;
    dateien.push(new File([blob], `geteilt-${i}.${(blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}`, { type: blob.type }));
  }
  const tr = await cache.match(`/teilen-datei/${id}/text`);
  const text = tr ? (await tr.text()).slice(0, 2000) : '';
  try { for (const k of await cache.keys()) await cache.delete(k); } catch { }
  if (!dateien.length && !text) return;
  geteiltWartet = { dateien, text };
  verarbeiteGeteiltes();
}
// Wartet auf Anmeldung bzw. Entsperren, dann ab ins Hinzufuegen-Blatt
function verarbeiteGeteiltes() {
  if (!geteiltWartet) return;
  if (!state.token) {
    if (state.activeView !== 'profile') switchView('profile');
    island('Melde dich an, dann kommt dein Bild in die Wallet');
    return;
  }
  if (state.activeView !== 'wallet') switchView('wallet');
  if (walletGesperrt()) return; // entsperreWallet ruft wieder
  const { dateien, text } = geteiltWartet;
  geteiltWartet = null;
  if (dateien.length) {
    // Nie automatisch speichern: jedes Bild einzeln ins Formular (mit Scan),
    // gespeichert wird erst mit "Speichern" — danach kommt das naechste
    geteiltSchlange = dateien.slice(1);
    openWalletAdd('voucher');
    if (waApi) waApi.ausSchlange = true;
    if (waOffen() && waHandleImage) {
      waHandleImage(dateien[0]);
      if (geteiltSchlange.length) island(`Bild 1 von ${dateien.length}: prüfen und speichern, dann kommt das nächste`, 4200);
    }
    return;
  }
  // Nur Text: als Rabattcode vorschlagen
  openWalletAdd('rabatt');
  if (!waOffen() || !waApi) return;
  const code = detectCode(text);
  if (code && $('#wa-rcode')) $('#wa-rcode').value = code.slice(0, 40);
  const low = text.toLowerCase();
  const shop = RABATT_GRID.find(n => !ANDERE_SHOPS.has(n) && low.includes(n.toLowerCase()));
  if (shop) waApi.shop(shop);
  if ($('#wa-notiz')) $('#wa-notiz').value = text.replace(/\s+/g, ' ').trim().slice(0, 80);
  waApi.aktualisieren();
  const m = $('#wa-ai-msg');
  if (m) { m.className = 'form-msg wa-scan-meldung' + (code ? ' ok' : ''); m.textContent = code ? 'Code aus dem geteilten Text übernommen, bitte kurz prüfen.' : 'Kein Code erkannt, bitte selbst eintragen.'; }
}

// ---------------- Neu in kumulio (Update-Log) ----------------
// Nach jedem Update sieht jedes Konto EINMAL, was neu ist. Gemerkt wird das am
// Konto (neuGesehen), damit es auf dem zweiten Geraet nicht nochmal kommt —
// dazu lokal als Rueckfallebene, falls das Melden ans Konto gerade nicht klappt.
// Neue Konten starten beim aktuellen Stand und sehen erst das naechste Update.
// Inhalt: public/neuigkeiten.json (bei jedem Update oben einen Eintrag ergaenzen).
// Ein Punkt darf ein Bild tragen: "bild" (Pfad unter /brand/), optional
// "bildDunkel" (Fassung fuer den Dunkelmodus), "bildAlt" und "bildGroesse"
// [Breite, Hoehe] in Pixeln, damit beim Laden nichts springt.
async function ladeNeuigkeiten() {
  if (neuListe) return neuListe;
  try {
    const r = await fetch('/neuigkeiten.json?x=' + Date.now(), { cache: 'no-store' });
    const l = await r.json();
    neuListe = Array.isArray(l) ? l.filter(e => e && e.v && Array.isArray(e.punkte) && e.punkte.length) : [];
  } catch { neuListe = []; }
  return neuListe;
}
async function pruefeNeuigkeiten(versuch = 0) {
  if (neuGeprueft || !state.token || !kontoInfo || !state.userName) return;
  // Nie ueber etwas anderes legen: gesperrte Wallet (kommt nach dem Entsperren),
  // Start-Splash, Einfuehrung, offene Blaetter und Dialoge
  if (!$('#wallet-sperre')?.classList.contains('hidden')) return;
  const belegt = startAuftrittOffen || state.sheetMode || document.querySelector('.k-splash, #tour, .overlay:not(.hidden)')
    || !$('#onboard')?.classList.contains('hidden') || topMenuOffen();
  if (belegt) {
    if (versuch < 40) setTimeout(() => pruefeNeuigkeiten(versuch + 1), 1500);
    return;
  }
  const liste = await ladeNeuigkeiten();
  if (!liste.length || neuGeprueft || !state.token || !kontoInfo) return;
  const user = state.userName;
  let lokal = '';
  try { lokal = localStorage.getItem('ra.neuGesehen:' + user) || ''; } catch { }
  // Der neuere der beiden Staende gilt (Konto oder dieses Geraet)
  const stellen = [kontoInfo.neuGesehen, lokal].filter(Boolean).map(v => liste.findIndex(e => e.v === v)).filter(i => i >= 0);
  const bis = stellen.length ? Math.min(...stellen) : -1;
  // Nie gesehen (Bestandskonto vor dem ersten Log): die zwei neuesten Updates
  const neue = bis === -1 ? liste.slice(0, 2) : liste.slice(0, bis);
  neuGeprueft = true;
  if (!neue.length) return;
  zeigeNeuigkeiten(neue.slice(0, 3));
  const v = liste[0].v;
  kontoInfo.neuGesehen = v;
  lsSetzen('ra.neuGesehen:' + user, v);
  api('/api/neuigkeiten/gesehen', { method: 'POST', body: JSON.stringify({ v }) }).catch(() => { });
}
function zeigeNeuigkeiten(eintraege) {
  const iconName = n => (/^[a-z-]{2,20}$/.test(n || '') ? n : 'sparkle');
  // Nur eigene Bilder (unter /brand/), im Dunkelmodus die dunkle Fassung
  const bildPfad = u => (/^\/brand\/[a-z0-9/_-]+\.(webp|png|jpg|svg)$/i.test(u || '') ? u : '');
  const dunkel = document.documentElement.dataset.theme === 'dark';
  const bildHtml = pt => {
    const src = bildPfad(dunkel && pt.bildDunkel ? pt.bildDunkel : pt.bild);
    if (!src) return '';
    const [w, h] = Array.isArray(pt.bildGroesse) ? pt.bildGroesse.map(Number) : [];
    const mass = w > 0 && h > 0 ? ` width="${Math.round(w)}" height="${Math.round(h)}"` : '';
    return `<span class="neu-bild"><img src="${esc(src)}"${mass} alt="${esc(pt.bildAlt || '')}" decoding="async"></span>`;
  };
  let i = 0;
  const wrap = document.createElement('div');
  wrap.className = 'overlay neu-overlay';
  wrap.innerHTML = `<div class="modal neu-modal" role="dialog" aria-modal="true" aria-labelledby="neu-titel" tabindex="-1">
    <div class="neu-kopf">
      <div class="neu-logo" aria-hidden="true">${window.KBrand?.wordmarkHTML ? window.KBrand.wordmarkHTML({ height: 26 }) : ''}</div>
      <h2 id="neu-titel">Neu in kumulio</h2>
      <p>${esc(eintraege[0].titel || 'Das hat sich getan')}</p>
    </div>
    <div class="neu-inhalt">
      ${eintraege.map(e => `
        <div class="neu-datum">${esc(e.datum || e.v)}</div>
        <ul class="neu-liste">${e.punkte.map(pt => `
          <li style="--i:${i++}">
            <span class="neu-icon">${icon(iconName(pt.icon), 'icon')}</span>
            <span class="neu-txt"><b>${esc(pt.titel || '')}</b><span>${esc(pt.text || '')}</span>${bildHtml(pt)}</span>
          </li>`).join('')}</ul>`).join('')}
    </div>
    <button class="btn btn-big neu-ok" type="button" data-neu-ok>Alles klar</button>
  </div>`;
  document.body.appendChild(wrap);
  const taste = e => { if (e.key === 'Escape') { e.stopPropagation(); zu(); } };
  const zu = () => {
    removeEventListener('keydown', taste, true);
    wrap.classList.add('closing');
    setTimeout(() => wrap.remove(), 280);
  };
  addEventListener('keydown', taste, true);
  wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-neu-ok]')) zu(); });
  // Fokus auf das Fenster selbst (auf einem Knopf zeichnet das Handy einen Ring)
  setTimeout(() => wrap.querySelector('.neu-modal')?.focus({ preventScroll: true }), 60);
}

// ---------------- Start ----------------

// Tastatur auf dem Handy: die sichtbare Höhe als CSS-Variable, damit der Chat
// kompakt bleibt und nichts unkontrolliert hochgeschoben wird
if (window.visualViewport) {
  let vvBaseH = 0;
  const applyVV = () => {
    const vv = window.visualViewport;
    // Beim ersten Lauf meldet visualViewport gelegentlich die Hoehe 0. Wird die
    // uebernommen, rechnet der Chat mit min(0px, 100dvh) = 0 und faellt auf
    // seine Mindesthoehe zurueck — der Verlauf war dann zehn Pixel hoch. Ein
    // einziger Nullwert legt so den ganzen Chat lahm; deshalb wird er verworfen.
    if (!(vv.height > 0)) return;
    document.documentElement.style.setProperty('--vvh', vv.height + 'px');
    // Tastatur offen? Referenz ist die groesste je gesehene Hoehe — dann darf
    // der Chat-Puffer schrumpfen (die Tabbar-Zone liegt eh unter der Tastatur)
    vvBaseH = Math.max(vvBaseH, vv.height);
    const auf = vv.height < vvBaseH - 120;
    const warVorher = document.body.classList.contains('kb-open');
    document.body.classList.toggle('kb-open', auf);
    // Beim Aufgehen der Tastatur ans Ende springen: sonst steht man mitten im
    // Verlauf und sieht ausgerechnet die letzten Nachrichten nicht.
    if (auf && !warVorher && document.body.classList.contains('chat-locked')) {
      requestAnimationFrame(() => {
        const box = document.getElementById('chat-box');
        if (box) box.scrollTop = box.scrollHeight;
      });
    }
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

// Liegt die App im Hintergrund, braucht keine Dauer-Animation zu laufen.
// Der Browser drosselt zwar, haelt aber nicht alles an — und auf dem Handy
// zaehlt jedes gesparte Bild.
document.addEventListener('visibilitychange', () =>
  document.body.classList.toggle('versteckt', document.hidden));

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
  el.querySelector('.k-wordmark')?.classList.add('k-laedt');
  $('#conn-retry')?.addEventListener('click', () => location.reload());
}
function hideConnScreen() { $('#conn-screen')?.remove(); }
window.addEventListener('online', () => { if ($('#conn-screen')) location.reload(); });

(async function init() {
  // Fallback: sollte das Brand-Modul je nicht laden, darf der Boot-Deckel
  // die App trotzdem nicht dauerhaft verdecken
  setTimeout(() => document.getElementById('boot-cover')?.remove(), 3200);
  refreshProfileTab();
  // Die Wallet ist die Startseite — ausser ein Link will woanders hin
  {
    const q = new URLSearchParams(location.search);
    const woanders = q.get('chat') || (q.get('tab') && q.get('tab') !== 'wallet');
    if (!woanders && state.activeView !== 'wallet') switchView('wallet', 'start-ohne-anim');
    markiereTab(state.activeView);
  }
  renderWallet();
  aktualisiereSperre();
  pruefeGeteiltes();
  nachStartSplash(() => {
    setTimeout(() => pruefeLaden({ sofort: true }), 2500);
    startAuftrittOffen = false;
    const sp = $('#wallet-sperre');
    if (sp?.classList.contains('vorstart')) { sperreAuftritt(sp); setTimeout(bioAutomatisch, sperrRuhig() ? 0 : 420); }
    else walletAuftritt();
  });
  pruefeKontoLinks();
  initTurnstile();
  // Emotes und Wallet-Grenzen früh laden, damit Profile und Chats sie kennen
  api('/api/meta').then(r => {
    chatEmotes = r.emotes || {};
    if (r.walletLimit) { Object.assign(WALLET_LIMIT, r.walletLimit); if (state.activeView === 'wallet') renderWallet(); }
  }).catch(() => { });
  if (state.token) {
    pullWallet(); // parallel statt hinter /api/me: Guthaben ist schneller aktuell
    api('/api/me').then(r => { kontoInfo = r; neuerKontoname(r.user); state.userName = r.user; state.role = r.role || ''; refreshProfileTab(); refreshAdminUi(); pinKontoUebernehmen(r); renderWallet(); pruefeNeuigkeiten(); })
      .catch(e => {
        // Nur bei ECHTEM 401 abmelden; ist der Server kurz weg, bleibt der Login stehen
        if (/401|anmelden/i.test(String(e.message))) {
          state.token = ''; localStorage.removeItem('ra.token'); walletEntsperrt = false; aktualisiereSperre(); refreshProfileTab();
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
  loadFeatured();
  checkReminders();
  handleOpenParams(location.search);
  // App ist bereit → der kumulio-Splash darf weg, sobald seine Animation durch ist
  window.KBrandReady?.then(K => K.appReady());
})();
