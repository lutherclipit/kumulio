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
  sheetMode: null, // 'deal' | 'channels' | 'favs'
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
function setzeLeistenfarbe() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const st = getComputedStyle(document.documentElement);
  // Auch die Sperre traegt den Rang-Verlauf
  const inWallet = document.body.classList.contains('wallet-farbe') || document.body.classList.contains('wallet-zu');
  const markenfarbe = document.body.classList.contains('marken-modus') && !document.body.classList.contains('wallet-zu')
    ? st.getPropertyValue('--marke-k1').trim() : '';
  const farbe = inWallet
    ? (markenfarbe || st.getPropertyValue('--kopf-k1').trim() || '#0E9C64')
    : (getComputedStyle(document.body).backgroundColor || '#EEF1F5');
  if (meta.content !== farbe) meta.content = farbe;
}
applyTheme(localStorage.getItem('ra.theme')
  || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

// Weichwährung: Funken. Bewusst KEINE Euro-Optik — eigenes Icon, deutsche
// Tausenderpunkte, nie Nachkommastellen. Sie dürfen nie wie Guthaben aussehen.
// (Serverfeld heißt intern weiter "coins", damit users.json nicht migriert werden muss.)
const CUR = { name: 'Funken', one: 'Funke', icon: '/gamification/currency-funke.svg' };
const fmtFunken = n => (Math.round(Number(n)) || 0).toLocaleString('de-DE');
const funkeIcon = (small = false) =>
  `<img class="px-icon${small ? ' px-16' : ''}" src="${small ? '/gamification/currency-funke-16.svg' : CUR.icon}" alt="${CUR.name}">`;

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
  'about you': '#1f1f1f', temu: '#fb7701', shein: '#222222', nike: '#111111',
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

// Profilbilder und Bilder aus Geschenken kommen von anderen Konten: nur
// echte Bild-Daten (data:image/…;base64) durchlassen
function sichereBildUrl(u) {
  const t = String(u || '');
  return /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(t) ? t : '';
}
// Auch Anfuehrungszeichen: esc() landet oft in Attributen (src, data-*,
// aria-label) — dort half das bisherige Escaping (nur & < >) nicht
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ESC_MAP[c]);
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

// Die schwarze Pille gleitet zum aktiven Tab (Feder-Physik über CSS-Transition)
// Menueleiste: welcher Reiter gehoert zur Ansicht? Unterseiten des Profils
// (Einstellungen, Freunde, Inventar …) lassen "Profil" aktiv
const HAUPT_TABS = ['feed', 'wallet', 'chat', 'profile'];
function tabFuer(v) {
  if (HAUPT_TABS.includes(v)) return v;
  if (['settings', 'friends', 'inventory', 'shop', 'gifts', 'invite', 'editprofile', 'user'].includes(v)) return 'profile';
  return null;
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
  b.classList.remove('weg');
  const ziel = `translate3d(${x}px, 0, 0)`;
  b.getAnimations?.().forEach(a => a.cancel());
  b.style.transform = ziel;
  if (sofort || war === null || war === x || reducedMotion() || document.body.classList.contains('sparsam') || !b.animate) return;
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

  markiereTab(next);

  oldView.classList.add('hidden');
  window.scrollTo(0, 0);
  newView.classList.remove('hidden');
  newView.classList.add(animClass || (weich ? 'enter-fade' : dir === 1 ? 'enter-right' : 'enter-left'));
  // Login-Captcha erst rendern, wenn die Profil-Seite sichtbar ist
  if (next === 'profile' && !state.token) renderTurnstile('login');
  if (next === 'profile' && state.token) { refreshGami(); refreshGamiSystem(); }
  if (next === 'chat') {
    // Der Chat besteht nur noch aus den Gespraechen mit Freunden. Er oeffnet
    // die Liste — wer gezielt in einen Einzelchat will (Benachrichtigung,
    // Freundesliste, Profil), ruft direkt danach setChatMode('dm', …) auf.
    if (chatMode !== 'dmlist') setChatMode('dmlist');
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
  if (next === 'inventory') renderInventoryPage();
  if (next === 'shop') renderShopPage();
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
$('#btn-settings-back').addEventListener('click', () => switchView('profile', 'enter-drop'));
$('#btn-friends-back').addEventListener('click', () => switchView('profile', 'enter-drop'));
$('#btn-user-back').addEventListener('click', () => switchView(userPageReturn, 'enter-drop'));
$('#btn-inv-back').addEventListener('click', () => switchView('profile', 'enter-drop'));
$('#btn-shop-back').addEventListener('click', () => switchView('profile', 'enter-drop'));
$('#btn-gifts-back').addEventListener('click', () => switchView('profile', 'enter-drop'));
$('#btn-invite-back')?.addEventListener('click', () => switchView('profile', 'enter-drop'));
$('#btn-edit-back').addEventListener('click', () => switchView('profile', 'enter-drop'));

// ---- Freunde-Bereich: Liste mit Profilbild, Profil ansehen oder schreiben
async function renderFriendsView() {
  const host = $('#friends-list');
  host.innerHTML = '<div class="status">Lade …</div>';
  try {
    const r = await api('/api/dm/list');
    const friends = myProfile?.friends || [];
    const meta = {};
    r.list.forEach(l => { meta[l.partner] = { avatar: l.avatar, border: l.border, ts: l.lastTs }; });
    (r.friends || []).forEach(f => { meta[f.name] = meta[f.name] || { avatar: f.avatar, border: f.border, ts: 0 }; });
    const sorted = [...friends].sort((a, b) => (meta[b]?.ts || 0) - (meta[a]?.ts || 0));
    host.innerHTML = sorted.length ? sorted.map(f => `
      <div class="friend-row">
        ${meta[f]?.avatar ? `<img class="avatar-big${meta[f]?.border ? ' pfb-' + esc(meta[f].border) : ''}" src="${sichereBildUrl(meta[f].avatar)}" alt="">`
        : `<span class="avatar-big${meta[f]?.border ? ' pfb-' + esc(meta[f].border) : ''}" style="background:${chatColor(f)}">${esc(f[0].toUpperCase())}</span>`}
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
// Oben ein Banner-Karussell (hervorgehobene Angebote), darunter die Filter,
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
      <span class="dk-ersatz" aria-hidden="true">${brandChipHtml(marke)}</span>
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
  const hell = brandHelligkeit(farbe) > 0.62;
  const pille = d ? rabattPill(d) : (f.price ? `<span class="dk-pill">${esc(f.price)}</span>` : '');
  // Deal-Folien: die ganze Folie oeffnet den Deal (onOfferClick ueber data-deal)
  const cta = d
    ? `<button class="fh-cta" type="button">Zum Deal ${icon('arrow-right', 'icon icon-sm')}</button>`
    : (f.link ? `<a class="fh-cta" href="${esc(f.link)}" target="_blank" rel="noopener noreferrer">Zum Deal ${icon('arrow-right', 'icon icon-sm')}</a>` : '');
  return `
    <div class="fh-slide${hell ? ' hell' : ''}" style="--bc:${farbe}"${d ? ` data-deal="${esc(d.id)}"` : ''} role="group" aria-roledescription="Folie" aria-label="${i + 1}">
      <div class="fh-text">
        ${marke ? `<span class="fh-marke">${esc(marke)}</span>` : ''}
        ${pille}
        <b class="fh-titel">${esc(titel)}</b>
        ${sub && sub !== titel ? `<span class="fh-sub">${esc(sub)}</span>` : ''}
        ${cta}
      </div>
      <span class="fh-bild${bild ? ' foto' : ' logo'}" aria-hidden="true">
        ${bild
          ? `<img src="${esc(bild)}" alt="" loading="${i ? 'lazy' : 'eager'}" decoding="async" referrerpolicy="no-referrer" onerror="this.parentNode.className='fh-bild logo';this.replaceWith(document.createRange().createContextualFragment(this.dataset.ersatz))" data-ersatz="${esc(brandChipHtml(marke || titel))}">`
          : brandChipHtml(marke || titel)}
      </span>
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
  const dots = [...host.querySelectorAll('.fh-dots i')];
  let raf = 0;
  if (dots.length) track.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      dots.forEach((el, j) => el.classList.toggle('on', j === i));
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
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `<div class="modal modal-left">
    <h2 class="card-h">An wen schicken?</h2>
    <div class="wallet-filters" style="margin-top:8px">${friends.map(f => `<button class="chip" data-send-to="${esc(f)}">@${esc(f)}</button>`).join('')}</div>
  </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener('click', async e => {
    const b = e.target.closest('[data-send-to]');
    if (!b && e.target !== wrap) return;
    if (b) {
      try {
        await api('/api/dm/send', { method: 'POST', body: JSON.stringify({ to: b.dataset.sendTo, text: `[deal:${d.id}] ${d.title.slice(0, 90)}` }) });
        island(`An @${b.dataset.sendTo} geschickt`); playSfx('plop');
      } catch (err) { island(err.message); }
    }
    wrap.remove();
  });
}
// Nachrichtentext: der [deal:id]-Marker wird zur antippbaren Deal-Karte
function chatBodyHtml(text) {
  const dl = String(text).match(/^\[deal:([a-z0-9]+)\]\s*(.*)$/i);
  if (dl) {
    return `<button class="deal-chip" data-open-deal="${esc(dl[1])}">${icon('tag', 'icon icon-sm')} <span>${esc(dl[2] || 'Deal ansehen')}</span> ${icon('arrow-right', 'icon icon-sm')}</button>`;
  }
  return withEmotes(esc(text));
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-open-deal]');
  if (!b) return;
  const d = state.deals.find(x => x.id === b.dataset.openDeal);
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
  const bildGross = () => {
    const bild = $('#wv-bild');
    if (!bild) return;
    zeigeBildGross({
      vonEl: bild, src: bild.src,
      // Umschalter nur, wenn es neben dem Zuschnitt wirklich ein Original gibt
      ladeOriginal: v.orig && v.codeImg ? () => origLaden(v) : null,
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
    openImgCrop(url, (out, info) => {
      if (info.ganz || !ganzesFoto) origEntfernen(v); // sonst zeigte "Original" noch das alte Foto
      else origSichern(v, ganzesFoto);
      v.codeImg = out; v.img = ''; v.bildMt = Math.max(Date.now(), (v.bildMt || 0) + 1); saveWallet(); openVoucherSheet(v.id);
    });
  });
  $('#wv-img-crop')?.addEventListener('click', async () => {
    // Vom Original aus zuschneiden: so laesst sich der Ausschnitt auch wieder
    // groesser ziehen, nicht nur immer kleiner
    const vomOriginal = v.orig ? await origLaden(v) : null;
    openImgCrop(vomOriginal || v.codeImg || v.img, (out, info) => {
      if (info.ganz) origEntfernen(v);          // jetzt IST das Bild das Original
      else if (!v.orig && v.img) origSichern(v, v.img); // bisher unbeschnitten: das wird das Original
      v.codeImg = out; v.img = ''; v.bildMt = Math.max(Date.now(), (v.bildMt || 0) + 1); saveWallet(); openVoucherSheet(v.id);
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

function renderCompareBtn(d) {
  if (d.free || !d.compare?.url) return '';
  return `<a class="btn btn-block btn-compare" href="${esc(d.compare.url)}" target="_blank" rel="noopener noreferrer">
    ${icon('chart', 'icon icon-sm')} Preisvergleich: ab ${esc(d.compare.price)} · billiger.de</a>`;
}

function patchCompare(d) {
  document.querySelectorAll(`[data-deal="${CSS.escape(d.id)}"] .compare-slot`).forEach(slot => { slot.innerHTML = renderComparePrice(d); });
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
      <button class="btn-share" id="btn-sheet-send" aria-label="An Freund schicken">${icon('send')}</button>
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
      <button class="votebtn${isFav ? ' on' : ''}" id="btn-sheet-fav">${icon(isFav ? 'heart-f' : 'heart')} ${isFav ? 'Gemerkt, entfernen' : 'Merken'}</button>
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
  $('#btn-sheet-send')?.addEventListener('click', () => sendDealToFriend(d));
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
    return `<div class="comment comment-tomb"><div class="comment-text chat-deleted">${icon('x', 'icon icon-sm')} Kommentar entfernt</div>
      ${replies.map(r => commentHtml(r, [])).join('')}</div>`;
  }
  const badge = c.badge && chatBadges[c.badge]
    ? `<svg class="icon icon-sm chat-badge"><use href="#i-${chatBadges[c.badge].icon}"/></svg>` : '';
  const role = c.role === 'admin' ? `<svg class="icon icon-sm chat-badge role-admin"><use href="#i-crown"/></svg>` : '';
  const rx = c.reactions || {};
  const mine = k => (rx[k] || []).includes(state.userName);
  const emoteRx = Object.keys(rx).filter(k => k !== 'like' && k !== 'helpful');
  const canDelete = state.userName === c.user || ['admin', 'mod'].includes(state.role);
  // Jeder Kommentar traegt den Look seines Autors: Avatar mit Rahmen, Paint-Name,
  // Badge — der Server liefert den jeweils AKTUELLEN Stand mit
  const ns = nameStyleOf(c.user, c.paint);
  const ava = c.avatar
    ? `<img class="avatar-mini avatar-img c-ava pfb-${esc(c.border || 'none')}" src="${sichereBildUrl(c.avatar)}" alt="">`
    : `<span class="avatar-mini c-ava pfb-${esc(c.border || 'none')}" style="background:${chatColor(c.user)}">${esc(c.user[0].toUpperCase())}</span>`;
  return `
    <div class="comment" data-cid="${esc(c.id)}">
      <div class="comment-head">
        ${ava}
        <span class="comment-user${ns.cls}" style="${ns.style}">@${esc(c.user)}</span>
        ${badge || role}
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

// ---------------- Profil: Registrieren / Anmelden ----------------

function refreshProfileTab() {
  // Oben links: "Anmelden"-Button (Gast) bzw. Avatar mit Initiale (angemeldet)
  const btn = $('#btn-profile-top');
  if (!state.token) schliesseTopMenu({ fokus: false });
  if (state.token && state.userName) {
    btn.className = 'iconbtn';
    btn.innerHTML = `<span class="avatar-mini">${esc(state.userName[0].toUpperCase())}</span>`;
    btn.setAttribute('aria-label', 'Profil: ' + state.userName);
    updateGiftBadges(); // innerHTML-Tausch wirft den Geschenk-Punkt sonst raus
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
    renderMyName();
    refreshGami();
  }
  renderWallet(); // Wallet-Sperre folgt dem Login-Status
  updateChatGate();
}

// ---------------- Gamification: Funken, Container, Badges ----------------

let myProfile = null;
function badgeChip(id, def, active) {
  return `<button class="badge-chip rar-${def.rar === 'häufig' ? 'common' : def.rar === 'selten' ? 'rare' : 'epic'} ${active ? 'on' : ''}" data-badge="${esc(id)}" title="${esc(def.rar)}">
    <svg class="icon icon-sm"><use href="#i-${def.icon}"/></svg><span>${esc(def.name)}</span>
  </button>`;
}
let profSeq = 0;
async function refreshGami() {
  if (!state.token) return;
  const pseq = ++profSeq;
  let freshProf;
  try { freshProf = await api('/api/profile'); } catch { return; }
  if (pseq !== profSeq) return; // veraltet: eine lokale Änderung kam dazwischen
  myProfile = freshProf;
  const oldCoins = Number($('#g-coins').textContent.replace(/\./g, '')) || 0;
  animateInt($('#g-coins'), oldCoins, myProfile.coins || 0);
  $('#g-bio').value = myProfile.bio || '';
  $('#g-public').checked = myProfile.publicProfile !== false;
  // Profilbild + Lieblings-Kleinigkeiten
  const av = $('#g-avatar-preview');
  if (myProfile.avatar) av.outerHTML = `<img class="avatar-big" id="g-avatar-preview" src="${sichereBildUrl(myProfile.avatar)}" alt="">`;
  else av.outerHTML = `<span class="avatar-big" id="g-avatar-preview" style="background:${chatColor(state.userName || '?')}">${esc((state.userName || '?')[0].toUpperCase())}</span>`;
  $('#g-avatar-del').classList.toggle('hidden', !myProfile.avatar);
  // Profil so zeigen, wie Besucher es sehen
  const rank = rankFor(renderWallet.lastTotal || 0);
  $('#g-rank-row').innerHTML = `<span class="rank-chip">${esc(rank.name)}</span>`;
  const myBorder = gami?.activeBorder ? ` pfb-${gami.activeBorder}` : '';
  $('#me-avatar').innerHTML = myProfile.avatar
    ? `<img class="avatar-big${myBorder}" src="${sichereBildUrl(myProfile.avatar)}" alt="">`
    : `<span class="avatar-big${myBorder}" style="background:${chatColor(state.userName || '?')}">${esc((state.userName || '?')[0].toUpperCase())}</span>`;
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
  if (myProfile.avatar && state.token) {
    $('#btn-profile-top').innerHTML = `<img class="avatar-mini avatar-img" src="${sichereBildUrl(myProfile.avatar)}" alt="">`;
    updateGiftBadges(); // der Avatar-Tausch wirft den Geschenk-Punkt sonst raus
  }
  updateReqDot();
  refreshGamiSystem();
}
// Ganze Zahlen animiert zählen (Funken)
function animateInt(el, from, to, ms = 600) {
  if (!el) return;
  if (reducedMotion() || from === to) { el.textContent = fmtFunken(to); return; }
  const t0 = performance.now();
  const safety = setTimeout(() => { el.textContent = fmtFunken(to); }, ms + 100);
  const tick = now => {
    const p = Math.min(1, (now - t0) / ms);
    el.textContent = fmtFunken(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(tick); else clearTimeout(safety);
  };
  requestAnimationFrame(tick);
}
$('#g-daily').addEventListener('click', async () => {
  if ($('#g-daily').disabled) return;
  const m = $('#g-msg');
  setBtnLoading($('#g-daily'), true);
  try {
    const r = await api('/api/daily', { method: 'POST', body: '{}' });
    playSfx('coin'); buzz(30); moneyFlash('green');
    animateInt($('#g-coins'), r.coins - r.gained, r.coins);
    m.className = 'form-msg ok';
    m.textContent = `+${fmtFunken(r.gained)} Funken! Serie: ${r.streak} Tag${r.streak > 1 ? 'e' : ''}.${r.caseWon ? ' Und ein Container!' : ''}`;
    myProfile && (myProfile.coins = r.coins);
    if (gami) gami.dailyNextTs = Date.now() + 24 * 3600e3;
    refreshGamiSystem();
  } catch (e) { m.className = 'form-msg error'; m.textContent = e.message; }
  finally { setBtnLoading($('#g-daily'), false); renderDailyTimer(); }
});
// Solange der naechste Tagesbonus in der Zukunft liegt, ist der Knopf gar nicht
// erst antippbar und zeigt einen laufenden Countdown statt einer Fehlermeldung
let dailyTimerInt = null;
function renderDailyTimer() {
  const btn = $('#g-daily');
  if (!btn) return;
  const next = gami?.dailyNextTs || 0;
  const left = next - Date.now();
  if (left <= 0) {
    btn.disabled = false;
    btn.classList.remove('daily-wait');
    btn.textContent = 'Daily abholen';
    clearInterval(dailyTimerInt); dailyTimerInt = null;
    return;
  }
  btn.disabled = true;
  btn.classList.add('daily-wait');
  const h = Math.floor(left / 3600e3);
  const mn = Math.floor(left % 3600e3 / 60e3);
  const sc = Math.floor(left % 60e3 / 1e3);
  btn.textContent = `${String(h).padStart(2, '0')}:${String(mn).padStart(2, '0')}:${String(sc).padStart(2, '0')}`;
  if (!dailyTimerInt) dailyTimerInt = setInterval(renderDailyTimer, 1000);
}
// ---------------- Ränge, Kisten (nur erspielbar) und Paints ----------------

let gami = null;
const CONTAINER_IMGS = {
  'emote-capsule': 'container-emote-capsule',
  'sticker-capsule': 'container-sticker-capsule',
  'paint-capsule': 'container-paint-capsule',
  'border-capsule': 'container-border-capsule',
  'emote-case': 'container-emote-case',
  // Alt-Typen (falls ein alter Stand sie noch nennt): weich auf die neuen Icons
  standard: 'container-emote-capsule', silber: 'container-emote-capsule',
  gold: 'container-emote-case', prisma: 'container-emote-case',
};
const containerName = type => gami?.containers?.[type]?.name || type;
const rankFile = r => `/gamification/rank-${String(r.tier).padStart(2, '0')}-${r.id}.svg`;
const paintById = id => (gami?.paintsAll || chatPaints || []).find(x => x.id === id);
// Animierte Paints (shimmer/holo/sweep) + Glow: die Felder stehen seit jeher in
// paints.json, wurden aber nie gerendert — diese zwei Helfer sind die einzige
// Wahrheit dafuer und haengen an JEDER Paint-Darstellung
function paintDecor(pnt) {
  if (!pnt) return { cls: '', style: '' };
  return {
    cls: (pnt.anim ? ' pn-anim' : '') + (pnt.glow ? ' pn-glow' : ''),
    style: (pnt.glow ? `--glow:${pnt.glow};` : ''),
  };
}

// Item-Helfer: Anzeige, Float, Shiny, Wert
const isShinyF = f => {
  const s = String(f ?? 0).padStart(3, '0');
  return (s[0] === s[1] && s[1] === s[2]) || (+s[1] === +s[0] + 1 && +s[2] === +s[1] + 1);
};
function itemVisual(kind, id) {
  if (kind === 'paint') {
    const pnt = paintById(id);
    const dec = paintDecor(pnt);
    return `<span class="reel-paint${dec.cls}" style="background-image:${pnt?.css || 'none'};${dec.style}"></span>`;
  }
  if (kind === 'badge') return `<svg class="icon"><use href="#i-${(gami?.badgesAll || {})[id]?.icon || 'star'}"/></svg>`;
  if (kind === 'sticker') return `<img class="emote" style="height:26px" src="https://cdn.7tv.app/emote/${(gami?.stickersAll || {})[id]?.id}/2x.webp" alt="">`;
  if (kind === 'border') return `<span class="avatar-mini border-demo pfb-${esc(id)}">${esc((state.userName || 'du')[0].toUpperCase())}</span>`;
  return `<img class="emote" style="height:26px" src="https://cdn.7tv.app/emote/${(gami?.emotesAll || {})[id]?.id}/2x.webp" alt="">`;
}
function itemRarity(kind, id) {
  if (kind === 'paint') return paintById(id)?.rarity || 'common';
  if (kind === 'badge') return ({ 'häufig': 'common', 'selten': 'rare', 'episch': 'epic' })[(gami?.badgesAll || {})[id]?.rar] || 'common';
  if (kind === 'sticker') return (gami?.stickersAll || {})[id]?.rarity || 'common';
  if (kind === 'border') return (gami?.bordersAll || {})[id]?.rarity || 'common';
  return (gami?.emotesAll || {})[id]?.rarity || 'common';
}
function itemName(kind, id) {
  if (kind === 'paint') return paintById(id)?.name || id;
  if (kind === 'border') return (gami?.bordersAll || {})[id]?.name || id;
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
  // Mehrfachbesitz: die x-te Kopie eines Items traegt ihren Float unter kind:id#x
  const counts = {};
  return [
    ...gami.paints.map(id => ({ kind: 'paint', id })),
    ...(gami.badgesOwned || myProfile?.badges || []).map(id => ({ kind: 'badge', id })),
    ...(gami.emotes || []).map(id => ({ kind: 'emote', id })),
    ...(gami.stickers || []).map(id => ({ kind: 'sticker', id })),
    ...(gami.borders || []).map(id => ({ kind: 'border', id })),
  ].map(it => {
    const key = `${it.kind}:${it.id}`;
    const copy = counts[key] = (counts[key] ?? -1) + 1;
    const fkey = copy > 0 ? `${key}#${copy}` : key;
    return { ...it, copy, float: (gami.floats || {})[fkey] ?? 0, rarity: itemRarity(it.kind, it.id) };
  });
}

let gamiSeq = 0;
async function refreshGamiSystem() {
  if (!state.token) return;
  const seq = ++gamiSeq;
  const firstLoad = !gami;
  let freshGami;
  try { freshGami = await api('/api/gami'); } catch { return; }
  if (seq !== gamiSeq) return; // veraltet: eine lokale Änderung kam dazwischen
  gami = freshGami;
  if (firstLoad) renderWallet(); // Sticker auf den Karten brauchen den Sticker-Katalog
  animateInt($('#g-coins'), Number($('#g-coins').textContent.replace(/\./g, '')) || 0, gami.coins || 0);
  renderDailyTimer();
  applyMyBorder(); // der eigene Rahmen sitzt auf Profil-Avatar + Kopfzeilen-Knopf
  renderMyName();
  // Rank-Up feiern: einmalige Vollbild-Celebration
  const lastTier = Number(localStorage.getItem('ra.tier') || 0);
  if (lastTier && gami.rank.tier > lastTier) rankUpFx(gami.rank);
  lsSetzen('ra.tier', gami.rank.tier);
  // Quests: gebündelt, kompakt, Funken per "Abholen"
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
          ${claim ? `<button class="btn btn-small" data-qclaim="${esc(claim.tag)}">Abholen +${fmtFunken(claim.coins)} ${funkeIcon(true)}</button>`
            : `<small>${done ? 'komplett' : `+${fmtFunken(nextMs[1])} ${funkeIcon(true)} Funken`}</small>`}
        </div>
        <div class="rank-progress"><div class="rank-progress-fill" style="width:${Math.min(100, Math.round(q.progress / target * 100))}%"></div></div>
      </div>`;
    }).join('')}</div>`).join('');
  $('#gm-quests').querySelectorAll('[data-qclaim]').forEach(b => b.onclick = async () => {
    try {
      const r = await api('/api/quests/claim', { method: 'POST', body: JSON.stringify({ tag: b.dataset.qclaim }) });
      achvToast(`Quest geschafft: ${r.quest}`, `+${fmtFunken(r.gained)} Funken`);
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
        <span class="paint${paintDecor(pnt).cls}" style="--paint:${pnt.css}; color:${pnt.fallbackColor}; ${paintDecor(pnt).style}">${esc(pnt.name)}</span>
      </button>`;
    }).join('')
    : '<span class="form-msg">Paints kommen aus Containern und färben deinen Namen im Chat.</span>';
  if (state.activeView === 'inventory') renderInventoryPage(); // Ziehung/Verkauf sofort sichtbar
  $('#gm-paints').querySelectorAll('[data-paint]').forEach(b => b.onclick = () => {
    const next = gami.activePaint === b.dataset.paint ? '' : b.dataset.paint;
    // Optimistisch: sofort markieren und melden, der Server folgt im Hintergrund
    gami.activePaint = next;
    gamiSeq++; profSeq++; // laufende Ladevorgänge dürfen das nicht zurückrollen
    if (myProfile) myProfile.activePaint = next;
    renderMyName();
    $('#gm-paints').querySelectorAll('[data-paint]').forEach(x => x.classList.toggle('on', x.dataset.paint === next));
    island(next ? 'Paint angelegt' : 'Paint abgelegt');
    api('/api/paint', { method: 'POST', body: JSON.stringify({ id: next }) })
      .then(() => refreshGamiSystem())
      .catch(e => { island(e.message); refreshGamiSystem(); });
  });
}

// Info: Wie sammelt man Aktivitätspunkte?
$('#gm-rank-info').addEventListener('click', () => askConfirm(
  'So sammelst du Aktivitätspunkte: 2 je Abbuchung, 5 je gesammeltem Gutschein, 1 je aktivem Tag (Tagesbonus) und 8 je aufgebrauchtem Gutschein. Einmal Verdientes bleibt: Gutscheine löschen kostet keine Punkte. Es zählt dein Sparverhalten, nie die Betragshöhe.',
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
      const equipped = (it.kind === 'paint' && gami.activePaint === it.id) || (it.kind === 'badge' && myProfile?.activeBadge === it.id) || (it.kind === 'border' && gami.activeBorder === it.id);
      const selKey = `${it.kind}:${it.id}:${it.copy}`;
      return `
      <div class="inv-item ${shiny ? 'shiny' : ''} ${invSelect ? 'sel-mode' : ''} ${invSelected.has(selKey) ? 'selected' : ''}" style="--rc:${col}" ${invSelect ? `data-sel="${esc(selKey)}" data-sel-val="${val}"` : ''}>
        ${invSelect ? `<span class="sel-check">${icon('check', 'icon icon-sm')}</span>` : ''}
        <div class="inv-visual">${itemVisual(it.kind, it.id)}</div>
        <b>${esc(itemName(it.kind, it.id))}</b>
        <span class="inv-float">#${String(it.float).padStart(3, '0')}${shiny ? ' ✦' : ''}</span>
        <span style="color:${col}; font-size:.68rem">${esc((gami.rarity || {})[it.rarity]?.label || it.rarity)}</span>
        <div class="inv-actions" ${invSelect ? 'style="display:none"' : ''}>
          ${it.kind === 'sticker' ? `<button class="c-act" data-inv-stick="${esc(it.id)}">Aufkleben</button>`
          : it.kind !== 'emote' ? `<button class="c-act ${equipped ? 'on' : ''}" data-inv-equip="${it.kind}:${esc(it.id)}">${equipped ? 'Angelegt' : 'Anlegen'}</button>` : ''}
          <button class="c-act ${inShowcase ? 'on' : ''}" data-inv-show="${it.kind}:${esc(it.id)}">Profil</button>
          <button class="c-act" data-inv-sell="${it.kind}:${esc(it.id)}:${it.copy}">Verkaufen (${val})</button>
        </div>
      </div>`;
    }).join('')}</div>` : '<div class="status">Noch keine Items. Öffne Container!</div>'}`;
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
    const [kind, id, copy] = b.dataset.invSell.split(':');
    if (!await askConfirm(`${esc(itemName(kind, id))} wirklich verkaufen?`, { okLabel: 'Verkaufen' })) return;
    try {
      const r = await api('/api/item/sell', { method: 'POST', body: JSON.stringify({ kind, id, copy: Number(copy) || 0 }) });
      playSfx('coin'); island(`Verkauft für ${fmtFunken(r.value)} Funken`);
      await refreshGamiSystem(); await refreshGami();
      openInventory();
    } catch (e) { island(e.message); }
  });
  openSheetShell();
}
$('#gm-inv-btn')?.addEventListener('click', () => switchView('inventory', 'enter-drop'));

// ---- Inventar als eigene Seite: Items UND Kisten, filterbar
let invFilter = 'alle';
let invSortRar = false;
let invSelect = false;
const invSelected = new Set(); // "kind:id:copy"
const RAR_RANK = { legendary: 5, epic: 4, rare: 3, uncommon: 2, common: 1 };
async function renderInventoryPage() {
  if (!gami) await refreshGamiSystem();
  const host = $('#inv-page');
  if (!gami) { host.innerHTML = '<div class="status">Bitte anmelden.</div>'; return; }
  const items = myItems();
  const showCases = !invSelect && (invFilter === 'alle' || invFilter === 'case');
  let list = invFilter === 'alle' ? items : items.filter(it => it.kind === invFilter);
  if (invSortRar) list = [...list].sort((a, z) => (RAR_RANK[z.rarity] || 0) - (RAR_RANK[a.rarity] || 0) || z.float - a.float);
  $('#inv-sort')?.classList.toggle('active', invSortRar);
  $('#inv-select') && ($('#inv-select').textContent = invSelect ? 'Fertig' : 'Auswählen');
  renderInvSellbar();
  host.innerHTML = `
    ${showCases && gami.cases.length ? `<h3 class="gm-h" style="margin-top:0">Container</h3>
    <div class="gm-cases">${gami.cases.map(c => `
      <button class="gm-case" data-case-open="${esc(c.id)}">
        <img class="px-icon big" src="/gamification/${CONTAINER_IMGS[c.type] || CONTAINER_IMGS['emote-capsule']}.svg" alt="">
        <span>${esc(containerName(c.type))}</span>
      </button>`).join('')}</div>` : ''}
    ${invFilter !== 'case' ? `${showCases && gami.cases.length ? '<h3 class="gm-h">Items</h3>' : ''}
    <div class="inv-grid">${list.map(it => {
      const col = (gami.rarity || {})[it.rarity]?.color || '#888';
      const shiny = isShinyF(it.float);
      const val = ((gami.sellValues || {})[it.rarity] || 20) * (shiny ? 5 : 1);
      const inShowcase = (gami.showcase || []).includes(`${it.kind}:${it.id}`);
      const equipped = (it.kind === 'paint' && gami.activePaint === it.id) || (it.kind === 'badge' && myProfile?.activeBadge === it.id) || (it.kind === 'border' && gami.activeBorder === it.id);
      const selKey = `${it.kind}:${it.id}:${it.copy}`;
      return `
      <div class="inv-item ${shiny ? 'shiny' : ''} ${invSelect ? 'sel-mode' : ''} ${invSelected.has(selKey) ? 'selected' : ''}" style="--rc:${col}" ${invSelect ? `data-sel="${esc(selKey)}" data-sel-val="${val}"` : ''}>
        ${invSelect ? `<span class="sel-check">${icon('check', 'icon icon-sm')}</span>` : ''}
        <div class="inv-visual">${itemVisual(it.kind, it.id)}</div>
        <b>${esc(itemName(it.kind, it.id))}</b>
        <span class="inv-float">#${String(it.float).padStart(3, '0')}${shiny ? ' ✦' : ''}</span>
        <span style="color:${col}; font-size:.68rem">${esc((gami.rarity || {})[it.rarity]?.label || it.rarity)}</span>
        <div class="inv-actions" ${invSelect ? 'style="display:none"' : ''}>
          ${it.kind === 'sticker' ? `<button class="c-act" data-inv-stick="${esc(it.id)}">Aufkleben</button>`
          : it.kind !== 'emote' ? `<button class="c-act ${equipped ? 'on' : ''}" data-inv-equip="${it.kind}:${esc(it.id)}">${equipped ? 'Angelegt' : 'Anlegen'}</button>` : ''}
          <button class="c-act ${inShowcase ? 'on' : ''}" data-inv-show="${it.kind}:${esc(it.id)}">Profil</button>
          <button class="c-act" data-inv-sell="${it.kind}:${esc(it.id)}:${it.copy}">Verkaufen (${val})</button>
        </div>
      </div>`;
    }).join('') || '<div class="status">Nichts in dieser Kategorie. Öffne Container!</div>'}</div>` : ''}`;
  host.querySelectorAll('[data-case-open]').forEach(b => b.onclick = () =>
    openCaseModal(gami.cases.find(c => c.id === b.dataset.caseOpen)));
  host.querySelectorAll('[data-inv-stick]').forEach(b => b.onclick = () => openStickerApply(b.dataset.invStick));
  host.querySelectorAll('[data-sel]').forEach(el => el.onclick = () => {
    const k = el.dataset.sel;
    if (invSelected.has(k)) invSelected.delete(k); else invSelected.add(k);
    el.classList.toggle('selected', invSelected.has(k));
    buzz(10);
    renderInvSellbar();
  });
  // Antippen des Item-Bilds = groß inspecten
  host.querySelectorAll('.inv-item').forEach(el => {
    const vis = el.querySelector('.inv-visual');
    if (!vis) return;
    const sellBtn = el.querySelector('[data-inv-sell]');
    if (!sellBtn) return;
    const [kind, id] = sellBtn.dataset.invSell.split(':');
    if (invSelect) { vis.style.cursor = ''; vis.onclick = null; return; }
    vis.style.cursor = 'zoom-in';
    vis.onclick = () => openInspect(kind, id, (gami.floats || {})[`${kind}:${id}`] ?? 0, itemRarity(kind, id));
  });
  host.querySelectorAll('[data-inv-equip]').forEach(b => b.onclick = () => {
    const [kind, id] = b.dataset.invEquip.split(':');
    // Optimistisch: lokal sofort umschalten und rendern, Server im Hintergrund
    let call;
    gamiSeq++; profSeq++; // laufende Ladevorgänge dürfen das nicht zurückrollen
    if (kind === 'border') {
      const next = gami.activeBorder === id ? '' : id;
      gami.activeBorder = next;
      call = api('/api/border', { method: 'POST', body: JSON.stringify({ id: next }) });
    } else if (kind === 'paint') {
      const next = gami.activePaint === id ? '' : id;
      gami.activePaint = next;
      if (myProfile) myProfile.activePaint = next;
      call = api('/api/paint', { method: 'POST', body: JSON.stringify({ id: next }) });
    } else {
      const next = myProfile.activeBadge === id ? '' : id;
      myProfile.activeBadge = next;
      call = api('/api/profile', { method: 'POST', body: JSON.stringify({ activeBadge: next }) });
    }
    renderInventoryPage();
    applyMyBorder();
    renderMyName();
    call.then(() => { refreshGami(); refreshGamiSystem(); })
      .catch(e => { island(e.message); refreshGami(); refreshGamiSystem(); });
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
    const [kind, id, copy] = b.dataset.invSell.split(':');
    if (!await askConfirm(`${esc(itemName(kind, id))} wirklich verkaufen?`, { okLabel: 'Verkaufen' })) return;
    try {
      const r = await api('/api/item/sell', { method: 'POST', body: JSON.stringify({ kind, id, copy: Number(copy) || 0 }) });
      playSfx('coin'); island(`Verkauft für ${fmtFunken(r.value)} Funken`);
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
// Sammelverkauf: Leiste zeigt Anzahl und Gesamtwert der markierten Items
function renderInvSellbar() {
  const bar = $('#inv-sellbar');
  if (!bar) return;
  bar.classList.toggle('hidden', !invSelect);
  if (!invSelect) return;
  let total = 0;
  document.querySelectorAll('#inv-page [data-sel]').forEach(el => {
    if (invSelected.has(el.dataset.sel)) total += Number(el.dataset.selVal) || 0;
  });
  $('#inv-selcount').textContent = `${invSelected.size} ausgewählt`;
  const btn = $('#inv-sell-selected');
  btn.disabled = !invSelected.size;
  btn.innerHTML = `Verkaufen ${invSelected.size ? `(${fmtFunken(total)} ${funkeIcon(true)})` : ''}`;
}
$('#inv-sort')?.addEventListener('click', () => { invSortRar = !invSortRar; renderInventoryPage(); });
$('#inv-select')?.addEventListener('click', () => {
  invSelect = !invSelect;
  invSelected.clear();
  renderInventoryPage();
});
$('#inv-sel-cancel')?.addEventListener('click', () => { invSelect = false; invSelected.clear(); renderInventoryPage(); });
$('#inv-sell-selected')?.addEventListener('click', async () => {
  if (!invSelected.size) return;
  const items = [...invSelected].map(k => { const [kind, id, copy] = k.split(':'); return { kind, id, copy: Number(copy) || 0 }; });
  if (!await askConfirm(`${items.length} Item${items.length > 1 ? 's' : ''} wirklich verkaufen?`, { okLabel: 'Verkaufen' })) return;
  try {
    const r = await api('/api/item/sell-many', { method: 'POST', body: JSON.stringify({ items }) });
    playSfx('coin'); buzz([30, 30]);
    island(`${r.sold} verkauft für ${fmtFunken(r.total)} Funken`);
    invSelect = false; invSelected.clear();
    await refreshGamiSystem(); refreshGami();
    renderInventoryPage();
  } catch (e) { island(e.message); }
});

// ---- Sticker auf Gutscheine kleben (wie CS-Sticker auf der Waffe) ----
// Position in Prozent der Kartenfläche, damit sie auf jedem Display sitzt
function voucherStickerHtml(st) {
  const sid = (gami?.stickersAll || {})[st.id]?.id;
  if (!sid) return '';
  return `<img class="v-sticker" src="https://cdn.7tv.app/emote/${sid}/2x.webp" alt="${esc(st.id)}"
    style="left:${Number(st.x) || 0}%; top:${Number(st.y) || 0}%; transform:translate(-50%,-50%) rotate(${Number(st.rot) || 0}deg)">`;
}
function openStickerApply(id) {
  const targets = state.wallet.vouchers.filter(v => !istRabatt(v) && (v.stickers || []).length < 4);
  if (!targets.length) { island('Kein Gutschein mit freiem Platz (maximal 4 Sticker pro Karte)'); return; }
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  let target = null;
  let pos = null;
  const render = () => {
    wrap.innerHTML = `
      <div class="modal modal-left sticker-apply">
        <button class="fav-remove" id="sa-close" aria-label="Schließen">${icon('x', 'icon icon-sm')}</button>
        <h2 class="card-h">${esc(id)} aufkleben</h2>
        ${!target ? `
        <p class="muted" style="font-size:.84rem">Auf welchen Gutschein soll der Sticker?</p>
        <div class="sa-targets">${targets.map(v => `
          <button class="btn btn-small btn-ghost" data-sa-t="${esc(v.id)}">${esc(v.vendor)}${v.balance != null ? ` · ${euroFmt(v.balance)}` : ''}</button>`).join('')}
        </div>` : `
        <p class="muted" style="font-size:.84rem">Tippe auf die Karte, wo der Sticker sitzen soll. Nochmal tippen versetzt ihn.</p>
        <div class="wallet-card sa-card" id="sa-card" style="--bc:${brandColor(target.vendor)}">
          <div class="wallet-card-head">
            ${brandChipHtml(target.vendor)}
            <span class="wallet-card-name">${esc(target.vendor)}</span>
            ${target.balance != null ? `<span class="wallet-card-balance">${euroFmt(target.balance)}</span>` : ''}
          </div>
          ${(target.stickers || []).map(voucherStickerHtml).join('')}
          ${pos ? voucherStickerHtml({ id, ...pos }) : ''}
        </div>
        <div class="form-row" style="margin-top:12px">
          <button class="btn" id="sa-apply" ${pos ? '' : 'disabled'}>Festkleben</button>
          <button class="btn btn-small btn-ghost" id="sa-back">Anderer Gutschein</button>
        </div>`}
      </div>`;
    wrap.querySelector('#sa-close').onclick = () => wrap.remove();
    wrap.querySelectorAll('[data-sa-t]').forEach(b => b.onclick = () => {
      target = targets.find(v => v.id === b.dataset.saT);
      pos = null;
      render();
    });
    const card = wrap.querySelector('#sa-card');
    if (card) card.onclick = e => {
      const r = card.getBoundingClientRect();
      pos = {
        x: Math.min(96, Math.max(4, Math.round((e.clientX - r.left) / r.width * 100))),
        y: Math.min(92, Math.max(8, Math.round((e.clientY - r.top) / r.height * 100))),
        rot: Math.round(Math.random() * 24 - 12),
      };
      render();
    };
    wrap.querySelector('#sa-back')?.addEventListener('click', () => { target = null; pos = null; render(); });
    wrap.querySelector('#sa-apply')?.addEventListener('click', async () => {
      if (!pos || !target) return;
      if (!await askConfirm(`${esc(id)} auf den ${esc(target.vendor)}-Gutschein kleben? Der Sticker wird dabei verbraucht und kann nicht wieder abgelöst werden.`, { okLabel: 'Festkleben' })) return;
      try {
        // Erst verbraucht der Server das Inventar-Item, dann klebt der Client
        await api('/api/sticker/use', { method: 'POST', body: JSON.stringify({ id }) });
        target.stickers = target.stickers || [];
        target.stickers.push({ id, ...pos });
        saveWallet();
        const i = (gami.stickers || []).indexOf(id);
        if (i >= 0) gami.stickers.splice(i, 1);
        wrap.remove();
        playSfx('kaching'); buzz(30);
        island('Sticker aufgeklebt');
        renderInventoryPage();
      } catch (e) { island(e.message); }
    });
  };
  render();
  document.body.appendChild(wrap);
}

// ---- Container-Shop als eigene Seite: erst ansehen (Inhalt + Chancen), dann kaufen
const SHOP_DESC = {
  'emote-capsule': 'Chat-Emotes aus dem 7TV-Global-Set',
  'sticker-capsule': 'Sticker zum Aufkleben auf deine Gutscheine',
  'paint-capsule': 'Namens-Paints für den Chat, auch animierte',
  'border-capsule': 'Rahmen für dein Profilbild',
  'emote-case': 'Emotes, Paints und Badges, mit Legendary-Chance',
};
async function renderShopPage() {
  if (!gami) await refreshGamiSystem();
  $('#shop-coins').textContent = fmtFunken(gami?.coins ?? 0);
  const entries = Object.entries(gami?.containers || {});
  const capsules = entries.filter(([, c]) => Object.keys(c.odds).length === 4);
  const cases = entries.filter(([, c]) => Object.keys(c.odds).length > 4);
  const card = ([type, c]) => `
    <button class="shop-card" data-shop-view="${esc(type)}">
      <img class="px-icon big" src="/gamification/${c.img}.svg" alt="">
      <span class="shop-card-name">${esc(c.name)}</span>
      <span class="shop-card-desc">${esc(SHOP_DESC[type] || '')}</span>
      <span class="shop-card-meta">${casePool(type).length} Items</span>
      <span class="shop-price">${funkeIcon(true)} ${fmtFunken(c.price)}</span>
    </button>`;
  $('#shop-page').innerHTML = `
    <div class="shop-hero">
      <div class="shop-hero-text">
        <b>Funken einlösen</b>
        <span>Antippen zeigt den Inhalt mit allen Chancen, gekauft wird erst danach.</span>
      </div>
      <span class="coin-chip shop-hero-coins">${funkeIcon()} <b>${fmtFunken(gami?.coins ?? 0)}</b>&nbsp;Funken</span>
    </div>
    <h3 class="gm-h">Kapseln</h3>
    <div class="shop-grid">${capsules.map(card).join('')}</div>
    ${cases.length ? `<h3 class="gm-h">Cases</h3>
    <div class="shop-grid">${cases.map(card).join('')}</div>` : ''}
    <p class="muted" style="font-size:.78rem">Funken gibt es nur fürs Mitmachen, niemals für Echtgeld.</p>`;
  $('#shop-page').querySelectorAll('[data-shop-view]').forEach(b => b.onclick = () =>
    openCaseModal({ type: b.dataset.shopView, shop: true }));
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
    ...Object.entries(gami?.stickersAll || {}).map(([id, v]) => ({ kind: 'sticker', id, rarity: v.rarity })),
    ...Object.entries(gami?.bordersAll || {}).map(([id, v]) => ({ kind: 'border', id, rarity: v.rarity })),
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
    <h3 class="gm-h">Die Container</h3>
    <div class="gm-cases">${Object.entries(gami?.containers || {}).map(([type, c]) => `
      <div class="gm-case" style="cursor:default">
        <img class="px-icon big" src="/gamification/${c.img}.svg" alt="">
        <span>${esc(c.name)}</span>
      </div>`).join('')}</div>
    <p class="muted" style="font-size:.78rem">Kapseln enthalten nur Emotes bzw. Sticker, das Case zusätzlich Paints und Badges. Die genauen Prozente stehen beim Öffnen unter „Chancen anzeigen".</p>`;
  openSheetShell();
}

// Container-Shop: Kauf ausschließlich mit erspielten Funken
$('#gm-shop-btn')?.addEventListener('click', () => switchView('shop', 'enter-drop'));

// ---- Kisten-Öffnung: Ergebnis kommt VOR der Animation vom Server, die Walze ist Show
let caseCtx = null;
function openCaseModal(box) {
  if (!box) return;
  caseCtx = { box, phase: 0, result: null, timers: [] };
  $('#case-img').src = `/gamification/${CONTAINER_IMGS[box.type] || CONTAINER_IMGS['emote-capsule']}.svg`;
  $('#case-img').classList.remove('hidden', 'case-shake', 'case-burst');
  $('#case-img').removeAttribute('style');
  $('#case-img').classList.add('case-idle');
  $('#case-title').textContent = containerName(box.type);
  $('#reel-wrap').classList.add('hidden');
  $('#case-result').classList.add('hidden');
  $('#case-open-btn').classList.remove('hidden');
  caseCtx.qty = 1;
  const unitPrice = gami?.containers?.[box.type]?.price || 0;
  if (box.shop) {
    $('#case-open-btn').innerHTML = `Kaufen für <b id="case-buy-price">${fmtFunken(unitPrice)}</b>&nbsp;Funken`;
    $('#case-qty').classList.remove('hidden');
    $('#qty-n').textContent = '1';
    const setQty = d => {
      const alt = caseCtx.qty * unitPrice;
      caseCtx.qty = Math.max(1, Math.min(25, caseCtx.qty + d));
      $('#qty-n').textContent = caseCtx.qty;
      animateInt($('#case-buy-price'), alt, caseCtx.qty * unitPrice);
      buzz(12);
    };
    $('#qty-minus').onclick = () => setQty(-1);
    $('#qty-plus').onclick = () => setQty(1);
  } else {
    $('#case-open-btn').textContent = 'Öffnen';
    $('#case-qty').classList.add('hidden');
  }
  $('#case-skip').classList.add('hidden');
  $('#case-backdrop').classList.remove('case-dark', 'case-darker');
  const wrapReset = $('#case-img-wrap');
  if (wrapReset) { wrapReset.style.transform = ''; wrapReset.style.top = ''; wrapReset.style.transition = ''; }
  // Chancen kommen 1:1 aus der Server-Tabelle des Container-Typs — die Anzeige
  // kann von der echten Ziehung nicht mehr abweichen
  const odds = gami?.containers?.[box.type]?.odds || {};
  $('#case-odds-panel').innerHTML = Object.entries(odds).map(([k, x]) =>
    `<div class="odds-row"><span style="color:${(gami?.rarity || {})[k]?.color || '#888'}">${esc((gami?.rarity || {})[k]?.label || k)}</span><b>${String(x).replace('.', ',')} %</b></div>`).join('');
  // Vorschau wie bei CS: was ist drin, gruppiert nach Stufe, mit Prozent
  const pool = casePool(box.type);
  const order = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  const previewStufen = order.filter(rar => odds[rar]);
  const previewTop = previewStufen[previewStufen.length - 1];
  $('#case-preview').innerHTML = previewStufen.map(rar => {
    const items = pool.filter(x => x.rarity === rar);
    if (!items.length) return '';
    const col = (gami?.rarity || {})[rar]?.color || '#888';
    // Die beste Stufe bleibt ein Geheimnis: ein goldenes ? wie bei CS
    const tiles = rar === previewTop
      ? `<span class="cp-item cp-mystery" title="Bleibt geheim, bis du es ziehst">?</span>`
      : items.map(it => `
        <span class="cp-item" style="--rc:${col}" title="${esc(itemName(it.kind, it.id))}">${itemVisual(it.kind, it.id)}</span>`).join('');
    return `
    <div class="cp-group">
      <div class="cp-head"><span style="color:${col}">${esc((gami?.rarity || {})[rar]?.label || rar)}</span><b>${String(odds[rar]).replace('.', ',')} %</b></div>
      <div class="cp-items">${tiles}</div>
    </div>`;
  }).join('');
  $('#case-preview').classList.remove('hidden');
  $('#case-backdrop').classList.remove('hidden');
}
// Was kann DIESER Container ziehen? Kinds vom Server, Legacy-Eintraege und
// Stufen ausserhalb der Odds fliegen raus — Walze und Vorschau luegen nie
function casePool(type) {
  const c = gami?.containers?.[type] || { kinds: ['emote'], odds: {} };
  const stufen = new Set(Object.keys(c.odds));
  const kinds = c.kinds || [];
  const badgeRar = { 'häufig': 'common', 'selten': 'rare', 'episch': 'epic' };
  return [
    ...(kinds.includes('paint') ? (gami?.paintsAll || []).map(x => ({ kind: 'paint', id: x.id, rarity: x.rarity })) : []),
    ...(kinds.includes('badge') ? Object.entries(gami?.badgesAll || {}).map(([k, v]) => ({ kind: 'badge', id: k, rarity: badgeRar[v.rar] || 'common' })) : []),
    ...(kinds.includes('emote') ? Object.entries(gami?.emotesAll || {}).filter(([, v]) => !v.legacy).map(([k, v]) => ({ kind: 'emote', id: k, rarity: v.rarity })) : []),
    ...(kinds.includes('sticker') ? Object.entries(gami?.stickersAll || {}).filter(([, v]) => !v.legacy).map(([k, v]) => ({ kind: 'sticker', id: k, rarity: v.rarity })) : []),
    ...(kinds.includes('border') ? Object.entries(gami?.bordersAll || {}).map(([k, v]) => ({ kind: 'border', id: k, rarity: v.rarity })) : []),
  ].filter(x => stufen.has(x.rarity));
}
// Der Gewinn zeigt sich direkt im Einsatz: Emote als eigene Chat-Nachricht,
// Paint am eigenen Namen, Rahmen am eigenen Profilbild, Sticker auf einer
// Mini-Gutscheinkarte, Badge neben dem Namen
function winPreviewHtml(kind, id) {
  const name = state.userName || 'du';
  if (kind === 'emote') {
    return `<div class="win-ctx chat-demo"><span class="chat-user" style="color:${chatColor(name)}">${esc(name)}</span><span class="chat-text">${emoteHtml(id)}</span></div>`;
  }
  if (kind === 'sticker') {
    const sid = (gami?.stickersAll || {})[id]?.id;
    return `<div class="win-ctx"><div class="wallet-card ob-mini win-card-demo" style="--bc:#295BB0">
      <div class="wallet-card-head"><span class="brand-chip" style="--bc:rgba(255,255,255,.22)">GS</span><span class="wallet-card-name">Gutschein</span><span class="wallet-card-balance">25,00 €</span></div>
      <img class="v-sticker" style="left:72%; top:56%; transform:translate(-50%,-50%) rotate(-6deg)" src="https://cdn.7tv.app/emote/${sid}/2x.webp" alt="">
    </div></div>`;
  }
  if (kind === 'paint') {
    const ns = nameStyleOf(name, id);
    return `<div class="win-ctx"><span class="win-big-name${ns.cls}" style="${ns.style}">${esc(name)}</span></div>`;
  }
  if (kind === 'border') {
    return `<div class="win-ctx">${myProfile?.avatar
      ? `<img class="avatar-big pfb-${esc(id)}" src="${sichereBildUrl(myProfile.avatar)}" alt="">`
      : `<span class="avatar-big pfb-${esc(id)}" style="background:${chatColor(name)}">${esc(name[0].toUpperCase())}</span>`}</div>`;
  }
  if (kind === 'badge') {
    const bd = (gami?.badgesAll || {})[id];
    return `<div class="win-ctx chat-demo"><svg class="icon icon-sm chat-badge"><use href="#i-${bd?.icon || 'star'}"/></svg><span class="chat-user" style="color:${chatColor(name)}">${esc(name)}</span><span class="chat-text">Moin!</span></div>`;
  }
  return itemVisual(kind, id);
}
function caseItemHtml(it) {
  const col = (gami?.rarity || {})[it.rarity]?.color || '#888';
  return `<div class="reel-item" style="--rc:${col}">
    ${it.kind === 'badge'
      ? `<svg class="icon"><use href="#i-${(myProfile?.badgesAll || {})[it.id]?.icon || 'star'}"/></svg>`
      : `<span class="reel-paint${paintDecor(paintById(it.id)).cls}" style="background-image:${paintById(it.id)?.css || 'none'};${paintDecor(paintById(it.id)).style}"></span>`}
  </div>`;
}
async function startCaseOpen() {
  const { box } = caseCtx;
  if (box.shop) {
    // Shop-Modus: dieses Fenster ist die Detail-Ansicht, der Knopf kauft
    try {
      const n = caseCtx.qty || 1;
      const rb = await api('/api/shop/buy', { method: 'POST', body: JSON.stringify({ type: box.type, count: n }) });
      playSfx('kaching'); buzz(30);
      gami.coins = rb.coins; gami.cases = rb.cases;
      $('#case-open-btn').classList.add('hidden');
      $('#case-qty').classList.add('hidden');
      $('#case-preview').classList.add('hidden');
      $('#case-odds-panel').classList.add('hidden');
      $('#case-result').classList.remove('hidden');
      $('#case-result').innerHTML = `
        <div class="case-win" style="--rc:#12C77E">
          <b>Gekauft!</b>
          <span>${n === 1 ? `Die ${esc(containerName(box.type))} liegt` : `${n}× ${esc(containerName(box.type))} liegen`} in deinem Inventar.</span>
          <div class="form-row" style="justify-content:center; margin-top:12px">
            <button class="btn btn-small" id="cbuy-inv">Zum Inventar</button>
            <button class="btn btn-small btn-ghost" id="cbuy-more">Weiter stöbern</button>
          </div>
        </div>`;
      $('#cbuy-inv').onclick = () => { hideOverlay($('#case-backdrop')); switchView('inventory', 'enter-drop'); };
      $('#cbuy-more').onclick = () => { hideOverlay($('#case-backdrop')); renderShopPage(); };
      renderShopPage();
      refreshGamiSystem();
    } catch (e) { island(e.message); }
    return;
  }
  let r;
  try { r = await api('/api/case/open', { method: 'POST', body: JSON.stringify({ id: box.id }) }); }
  catch (e) { island(e.message); return; }
  caseCtx.result = r;
  $('#case-open-btn').classList.add('hidden');
  $('#case-preview').classList.add('hidden');
  $('#case-odds-panel').classList.add('hidden');
  $('#case-backdrop').classList.add('case-dark'); // Buehne frei: weich abdunkeln
  $('#case-qty').classList.add('hidden');
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
        <div class="case-win-visual win-ctx-wrap">${winPreviewHtml(r.win.kind, r.win.id)}</div>
        <b>${esc(r.win.name)}</b>
        <span class="inv-float">#${String(r.win.float).padStart(3, '0')}${r.win.shiny ? ' ✦ SHINY' : ''}</span>
        <span style="color:${col}; font-weight:800">${esc(label)} · Wert: ${funkeIcon(true)} ${fmtFunken(r.win.value)} Funken</span>
        ${r.dupe ? '<span class="stars-count">Schon vorhanden: +40 Funken gutgeschrieben</span>' : `
        <div class="form-row" style="justify-content:center; margin-top:10px">
          <button class="btn btn-small" id="cw-keep">Behalten</button>
          <button class="btn btn-small btn-ghost" id="cw-sell">Verkaufen für ${fmtFunken(r.win.value)} Funken</button>
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
    playSfx(r.dupe ? 'coin' : (r.win.rarity === 'epic' || r.win.rarity === 'legendary') ? 'wow' : 'kaching');
    $('#cw-keep')?.addEventListener('click', () => { hideOverlay($('#case-backdrop')); island('Ab ins Inventar!'); });
    // Item groß anschauen (inspecten)
    $('#case-result').querySelector('.case-win-visual')?.addEventListener('click', () =>
      openInspect(r.win.kind, r.win.id, r.win.float, r.win.rarity));
    $('#cw-sell')?.addEventListener('click', async () => {
      try {
        const copies = myItems().filter(x => x.kind === r.win.kind && x.id === r.win.id).length;
        const sold = await api('/api/item/sell', { method: 'POST', body: JSON.stringify({ kind: r.win.kind, id: r.win.id, copy: Math.max(0, copies - 1) }) });
        playSfx('coin');
        hideOverlay($('#case-backdrop'));
        island(`Verkauft für ${fmtFunken(sold.value)} Funken`);
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
  // Die Kiste gleitet weich in die Buehnenmitte; Schuetteln, Aufplatzen und
  // Walze passieren dann dort
  const stage = document.querySelector('#case-backdrop .case-modal').getBoundingClientRect();
  const rahmen = $('#case-img-wrap') || img;
  const ib = img.getBoundingClientRect();
  const dy = (stage.top + stage.height / 2) - (ib.top + ib.height / 2);
  // Der Rahmen traegt Weg und Zoom, das Bild darin schuettelt und platzt —
  // sonst wuerden sich beide um dieselbe transform-Eigenschaft streiten
  rahmen.style.position = 'relative';
  rahmen.style.transition = 'top .8s cubic-bezier(.3, 1, .4, 1), transform 1.9s cubic-bezier(.4, 0, .3, 1)';
  rahmen.style.top = dy + 'px';
  requestAnimationFrame(() => { rahmen.style.transform = 'scale(1.35)'; });
  $('#case-skip').classList.remove('hidden');
  caseCtx.timers.push(setTimeout(() => {
    img.classList.add('case-shake');
    // Sound startet mit dem Schütteln, so sitzt das Finale auf dem Reveal
    caseCtx.snd = playSfx('case');
    caseCtx.timers.push(setTimeout(() => {
      img.classList.remove('case-shake');
      img.classList.add('case-burst');
      // Das Licht bricht dort auf, wo die Kiste steht — vorher klebte es oben
      const flash = document.createElement('div');
      flash.className = 'case-flash';
      flash.style.setProperty('--rc', col);
      const eltern = rahmen.parentElement;
      const kb = img.getBoundingClientRect();
      const eb = eltern.getBoundingClientRect();
      flash.style.top = (kb.top + kb.height / 2 - eb.top) + 'px';
      eltern.insertBefore(flash, rahmen);
      // Im Moment des Aufplatzens wird der Raum noch dunkler
      $('#case-backdrop').classList.add('case-darker');
      setTimeout(() => flash.remove(), 800);
      // Jetzt die Walze: Gewinn liegt fest auf Index 60, alles andere ist Show
      caseCtx.timers.push(setTimeout(() => {
        img.classList.add('hidden');
        rahmen.style.transform = '';
        const stufen = Object.keys(gami?.containers?.[box.type]?.odds || {});
        const topRar = stufen[stufen.length - 1];
        // Fueller enthalten die Top-Stufe NIE: das goldene ? taucht nur auf,
        // wenn es wirklich gewonnen wurde — oder ganz selten als Bait (2 %),
        // der dann knapp vor dem Marker vorbeizieht
        const pool = casePool(box.type).filter(x => x.rarity !== topRar);
        const baitIdx = Math.random() < 0.02 ? 55 + Math.floor(Math.random() * 4) : -1;
        const items = Array.from({ length: 64 }, (_, i) =>
          i === 60 ? { kind: r.win.kind, id: r.win.id, rarity: r.win.rarity }
            : i === baitIdx ? { mystery: true, rarity: topRar }
            : pool[Math.floor(Math.random() * pool.length)]);
        $('#reel').innerHTML = items.map(it => {
          if (it.mystery || it.rarity === topRar) return `<div class="reel-item reel-mystery">?</div>`;
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
      }, 200));
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
        : `<span class="reel-paint big${paintDecor(paintById(r.win.id)).cls}" style="background-image:${paintById(r.win.id)?.css || 'none'};${paintDecor(paintById(r.win.id)).style}"></span>`}
        <b>${esc(r.win.name)}</b>
        <span style="color:${col}">${esc(label)}${r.dupe ? ' · schon vorhanden, +40 Funken' : ''}</span>
      </div>`;
    buzz(18);
    playSfx((r.win.rarity === 'epic' || r.win.rarity === 'legendary') ? 'wow' : 'kaching');
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
      <span style="color:${col}">${esc(label)}${r.dupe ? ' · schon vorhanden, +40 Funken' : ''}</span>
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
    walletBesitzer = r.user; // gleiche Wallet, neuer Name — kein Kontowechsel
    speichereWallet(true);
    lsSetzen('ra.user', r.user);
    $('#g-handle').value = '';
    island(`Du heißt jetzt @${r.user}`);
    refreshProfileTab();
  } catch (e) { island(e.message); }
});

// Overlays raus aus den Views auf Body-Ebene, sonst versteckt .view.hidden sie mit
// (Kisten-Popup erschien z. B. erst nach dem Zurückgehen ins Profil)
document.body.appendChild($('#case-backdrop'));

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

// Oben links: Gäste landen direkt beim Anmelden, Angemeldete bekommen die
// Seitenleiste, die von links hereingleitet
$('#btn-profile-top').addEventListener('click', () => {
  if (!state.token) { if (state.activeView !== 'profile') switchView('profile'); return; }
  toggleTopMenu();
});
// Profil-Seite: Inventar und Shop (hingen frueher am Menue und gingen erst,
// nachdem es einmal offen war)
$('#gm-inv-open') && ($('#gm-inv-open').onclick = () => switchView('inventory', 'enter-drop'));
$('#gm-shop-open') && ($('#gm-shop-open').onclick = () => switchView('shop', 'enter-drop'));

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
function oeffneTopMenu() {
  const menu = $('#top-menu');
  const bd = $('#top-menu-backdrop');
  const host = $('#tm-scroll');
  clearTimeout(tmZuUhr);
  bd.classList.remove('hidden');
  const reqs = myProfile?.friendRequests || [];
  const rank = rankFor(renderWallet.lastTotal || 0);
  host.innerHTML = `
    <button class="tm-head" type="button" aria-label="Zum Profil">
      ${(() => {
        const tb = gami?.activeBorder ? ' pfb-' + gami.activeBorder : '';
        return myProfile?.avatar ? `<img class="avatar-big${tb}" src="${sichereBildUrl(myProfile.avatar)}" alt="">`
          : `<span class="avatar-big${tb}" style="background:${chatColor(state.userName || '?')}">${esc((state.userName || '?')[0].toUpperCase())}</span>`;
      })()}
      <div style="flex:1">
        <div class="tm-name">${(() => {
          const ns = nameStyleOf(state.userName || '?', gami?.activePaint || '');
          return `<span class="${ns.cls.trim()}" style="${ns.style}">${esc(state.userName)}</span>`;
        })()} ${state.role === 'admin' ? icon('crown', 'icon icon-sm role-admin') : ''}</div>
        <div class="tm-sub">
          ${gami?.rank ? `<img class="px-icon" src="${rankFile(gami.rank)}" alt="" style="vertical-align:-4px"> ${esc(gami.rank.name)}` : esc(rank.name)}
          · ${funkeIcon(true)} ${fmtFunken(gami?.coins ?? myProfile?.coins ?? 0)} Funken
        </div>
      </div>
      <svg class="icon icon-sm" style="opacity:.5"><use href="#i-chevron"/></svg>
    </button>
    ${reqs.length ? `<div class="tm-section">Freundschaftsanfragen</div>
    ${reqs.map(u => `<div class="tm-req">
      <span class="avatar-mini" style="background:${chatColor(u)}">${esc(u[0].toUpperCase())}</span>
      <span style="flex:1; font-weight:700">${esc(u)}</span>
      <button class="btn btn-small" data-freq-ok="${esc(u)}">Annehmen</button>
      <button class="btn btn-small btn-ghost" data-freq-no="${esc(u)}">Ablehnen</button>
    </div>`).join('')}` : ''}
    <div class="tm-section tm-section-row">Freunde <button class="tm-mini-link" id="tm-all-friends">alle ansehen</button></div>
    <div id="tm-friends"><div class="tm-sub" style="padding:4px 0">Lade …</div></div>
    <button class="tm-item" id="tm-inv">${icon('gift', 'icon icon-sm')} Inventar</button>
    <button class="tm-item" id="tm-shop">${icon('banknote', 'icon icon-sm')} Container-Shop</button>
    <button class="tm-item" id="tm-catalog">${icon('list', 'icon icon-sm')} Sammlung</button>
    <button class="tm-item" id="tm-quests">${icon('trophy', 'icon icon-sm')} Quests ${(gami?.claimable || []).length ? `<span class="dm-unread-pill">${gami.claimable.length}</span>` : ''}</button>
    <button class="tm-item" id="tm-invite">${icon('share', 'icon icon-sm')} Freunde einladen <span class="tm-sub-hint">+1.000 ${funkeIcon(true)}</span></button>
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
  // Der Profil-Banner selbst führt zum Profil
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
  $('#tm-invite').onclick = () => { done(); switchView('invite', 'enter-drop'); };
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
    const rows = [
      ...r.list.map(l => ({ name: l.partner, avatar: l.avatar, ts: l.lastTs })),
      ...(r.friends || []).map(f => ({ name: f.name, avatar: f.avatar, ts: 0 })),
    ].filter(x => (myProfile?.friends || []).includes(x.name)).slice(0, 3);
    $('#tm-friends').innerHTML = rows.length ? rows.map(f => `
      <div class="tm-req">
        <span class="tm-friend-open" data-tm-user="${esc(f.name)}" style="display:flex; align-items:center; gap:8px; flex:1; cursor:pointer">
          ${f.avatar ? `<img class="avatar-mini avatar-img${f.border ? ' pfb-' + esc(f.border) : ''}" src="${sichereBildUrl(f.avatar)}" alt="">`
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
    if (ref) note.innerHTML = `${icon('gift', 'icon icon-sm')} <span><b>@${esc(ref)}</b> hat dich eingeladen: <b>500 Funken</b> Startguthaben, sobald dein Konto steht.</span>`;
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
    const hatteRef = localStorage.getItem('ra.ref');
    localStorage.removeItem('ra.ref');
    if (hatteRef && r.refBonus) {
      setTimeout(() => achvToast(`Willkommensgeschenk von @${hatteRef}`, `+${fmtFunken(r.refBonus)} Funken sind auf deinem Konto`), 900);
    }
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
// Mitteilungs-Schalter: Banner/Sounds pro Kategorie an- und abschaltbar
[['msgs', '#sw-n-msgs'], ['reminder', '#sw-n-reminder']].forEach(([key, sel]) => {
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
    title: 'Töne & Mitteilungen', text: 'Schalte gleich alles scharf: Soundeffekte beim Öffnen von Containern und Geschenken, und Push-Nachrichten für Preisfehler und Freunde.', cta: 'Weiter',
    visual: () => `
      <div class="ob-toggles">
        <label class="ob-toggle"><input type="checkbox" id="ob-sound" ${soundOn() ? 'checked' : ''}><span class="switch-slider"></span> Soundeffekte</label>
        <label class="ob-toggle"><input type="checkbox" id="ob-push"><span class="switch-slider"></span> Mitteilungen aufs Handy</label>
      </div>`,
    wire: () => {
      $('#ob-sound')?.addEventListener('change', e => {
        lsSetzen('ra.sound', e.target.checked ? '1' : '0');
        const sw = $('#sw-sound'); if (sw) sw.checked = e.target.checked;
        if (e.target.checked) { initSfx(); playSfx('plop'); }
      });
      $('#ob-push')?.addEventListener('change', async e => {
        if (!e.target.checked) return;
        try { await enablePushNow(); } catch (err) { e.target.checked = false; island(err.message); }
      });
    },
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
  s.wire?.();
  $('#ob-continue')?.addEventListener('click', () => finishOnboarding(false));
  $('#ob-login')?.addEventListener('click', () => { finishOnboarding(false); switchView('profile'); });
  $('#ob-skip').classList.toggle('hidden', !!s.final);
}

function finishOnboarding(openRegister) {
  lsSetzen('ra.tutorialDone', '1');
  $('#onboard').classList.add('done');
  setTimeout(() => $('#onboard').classList.add('hidden'), 520);
  if (openRegister && !state.token) $('#btn-register-open').click();
}

function maybeShowOnboarding() {
  if (localStorage.getItem('ra.tutorialDone')) return;
  // Markenmoment: Logo faellt, rutscht hoch, dann die Begruessung auf dem
  // Splash-Hintergrund. "Jetzt loslegen" wischt alles nach oben weg zur Tour.
  $('#onboard').classList.remove('hidden');
  setTimeout(() => {
    $('#onboard').classList.add('step');
    $('#ob-step').innerHTML = `
      <div class="ob-step">
        <h2>Schön, dass du da bist.</h2>
        <p>kumulio ist deine Spar-App: kuratierte Deals und Preisfehler, deine Gutschein-Wallet und deine Leute, alles an einem Ort.</p>
      </div>`;
    $('#ob-dots').innerHTML = '';
    $('#ob-extra').innerHTML = '';
    const next = $('#ob-next');
    next.textContent = 'Jetzt loslegen';
    next.onclick = () => {
      const ob = $('#onboard');
      ob.classList.add('swipe');
      setTimeout(() => { ob.classList.add('hidden'); ob.classList.remove('swipe', 'step'); startTour(); }, 640);
    };
    $('#ob-content').classList.remove('hidden');
    $('#ob-skip').classList.remove('hidden');
  }, 1600);
}

// Finale der Tour: der Start-Hintergrund kommt von unten zurueck, das Logo
// blendet animiert ein, Konto erstellen / einloggen liegt auf einem Slider
function showTourFinale() {
  const ob = $('#onboard');
  // Wie beim Start: Logo erst GROSS in der Mitte, dann gleitet es hoch,
  // erst danach faedeln sich Text und Konto-Slider animiert ein
  ob.classList.remove('hidden', 'done', 'swipe', 'step');
  ob.classList.add('finale');
  $('#ob-content').classList.add('hidden');
  const logo = ob.querySelector('.ob-logo');
  logo.style.animation = 'none';
  void logo.offsetWidth;
  logo.style.animation = '';
  $('#ob-step').innerHTML = `
    <div class="ob-step">
      <h2>Bereit?</h2>
      <p>Mit Konto sind Wallet, Funken und Fortschritt sicher, auf jedem Gerät.</p>
    </div>`;
  $('#ob-dots').innerHTML = '';
  const next = $('#ob-next');
  next.classList.add('hidden');
  $('#ob-extra').innerHTML = `
    <div class="ob-slider">
      <button class="ob-slider-opt primary" id="obf-register">Konto erstellen</button>
      <button class="ob-slider-opt" id="obf-login">Einloggen</button>
    </div>
    <button class="ob-alt" id="obf-guest">Ohne Konto weiter</button>`;
  const closeOb = () => {
    lsSetzen('ra.tutorialDone', '1');
    ob.classList.add('done');
    setTimeout(() => { ob.classList.add('hidden'); ob.classList.remove('done', 'step', 'finale'); next.classList.remove('hidden'); }, 520);
  };
  $('#obf-register').onclick = () => { closeOb(); switchView('profile'); setTimeout(() => $('#btn-register-open')?.click(), 400); };
  $('#obf-login').onclick = () => { closeOb(); switchView('profile'); };
  $('#obf-guest').onclick = () => closeOb();
  $('#ob-skip').classList.add('hidden');
  // Der Logo-Moment darf atmen, dann rutscht es hoch und der Inhalt kommt
  setTimeout(() => {
    ob.classList.add('step');
    setTimeout(() => $('#ob-content').classList.remove('hidden'), 380);
  }, 950);
}

// ---- Interaktive Tour: Spotlight wandert ueber die echte App, Hinweise in
// Kreis-Bubbles, alles andere ist abgedunkelt. Kein Karten-Gespamme mehr.
function startTour() {
  // Prototypen mit dem ECHTEN App-Markup: so sieht es nachher wirklich aus
  const walletDemo = `<div class="tour-visual">
    <div class="tour-proto">
      <div class="wallet-card" style="--bc:${brandColor('rewe')}">
        <div class="wallet-card-head">
          ${brandChipHtml('REWE')}
          <span class="wallet-card-name">REWE</span>
          <span class="wallet-card-balance">25,00 €</span>
        </div>
        <div class="wallet-card-sub"><span>2094 4258 9452</span><span class="pill">PIN 3374</span></div>
        <span class="wallet-card-date">16.08.26</span>
      </div>
    </div>
    <span class="tour-mini-note">Foto vom Gutschein reicht, die Felder füllen sich selbst. Sparkarten und Coupons wohnen hier auch.</span>
  </div>`;
  const feedDemo = `<div class="tour-visual">
    <div class="tour-proto">
      <article class="deal offer deal-pf" style="display:block">
        <div class="offer-head">
          ${brandChipHtml('MediaMarkt')}
          <div class="offer-brand">
            <div class="offer-merchant">MediaMarkt</div>
            <div class="offer-cat">Preisfehler · gerade eben</div>
          </div>
        </div>
        <div class="deal-title" style="margin-top:8px">4K-Fernseher 55 Zoll für 111 €</div>
        <div class="deal-sub">
          <span class="price">111 €</span>
          <span class="badge badge-pf"><span class="pf-glitch" data-text="PREISFEHLER">PREISFEHLER</span></span>
          <span class="badge badge-hot">${icon('flame')} −86 %</span>
          <span class="pf-timer" data-pf-ts="${Date.now() - 2 * 60000}">${icon('clock')} <span>${pfElapsed(Date.now() - 2 * 60000)}</span></span>
        </div>
      </article>
    </div>
    <span class="tour-mini-note">Dazu Neukunden-Deals und Wege, nebenbei etwas zu verdienen.</span>
  </div>`;
  const chatDemo = `<div class="tour-visual"><div class="win-ctx chat-demo" style="margin:0; padding:8px 14px">
    <svg class="icon icon-sm chat-badge"><use href="#i-flame"/></svg>
    <span class="chat-user paint pn-anim" style="--paint:linear-gradient(90deg,#8A5A00 0%,#E8A317 30%,#FFF3C4 50%,#E8A317 70%,#8A5A00 100%); color:#c28f00">Milena</span>
    <span class="chat-text"><img class="emote" src="https://cdn.7tv.app/emote/01GAZ199Z8000FEWHS6AT5QZV0/2x.webp" alt=""></span>
  </div></div>`;
  const lookDemo = `<div class="tour-visual" style="flex-direction:row; gap:12px; align-items:center">
    <span class="avatar-mini pfb-goldring" style="background:#3f51b5">M</span>
    <span class="chat-user paint pn-anim" style="--paint:linear-gradient(90deg,#12C77E,#3B82F6,#8B5CF6,#EC4899,#F5B301,#12C77E); color:#7c6bd8; font-size:1.05rem">Milena</span>
    <img class="emote" style="height:28px" src="https://cdn.7tv.app/emote/01FE3XY508000AA32JP519W2EW/2x.webp" alt="">
  </div>`;
  const steps = [
    { view: 'feed', sel: '.tabbtn[data-view="feed"] .tab-ico', title: 'Deals, die sich lohnen', text: 'Preisfehler als Alarm aufs Handy, Neukunden-Deals und Wege, nebenbei etwas zu verdienen.', visual: feedDemo },
    { view: 'wallet', sel: '.tabbtn[data-view="wallet"] .tab-ico', title: 'Deine Wallet', text: 'Gutschein fotografieren, fertig: Guthaben, PIN und Barcode griffbereit, Restsummen immer im Blick.', visual: walletDemo },
    { view: 'chat', sel: '.tabbtn[data-view="chat"] .tab-ico', title: 'Chat und Freunde', text: 'Mit Freunden schreiben: Deals direkt weiterschicken und zusammen zuschlagen.', visual: chatDemo },
    { center: true, title: 'Dein Look', text: 'Mit Spar-Aktivität erspielst du Container: Emotes, Namens-Paints, Sticker und Profilrahmen. Nie für Geld.', visual: lookDemo },
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
    <div class="tour-bubble">
      <span class="tour-num">1</span>
      <h3></h3><p></p>
      <div class="tour-media"></div>
      <div class="tour-btns"></div>
      <button class="tour-alt tour-skip-inline">Tour überspringen</button>
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
  };
  const show = () => {
    const s = steps[i];
    // Ein wackelnder View-Wechsel (geraetespezifisch) darf die Tour nicht killen
    try { if (s.view && state.activeView !== s.view) switchView(s.view); } catch (e) { console.warn('Tour: View-Wechsel', e); }
    tour.querySelector('.tour-num').textContent = i + 1;
    tour.querySelector('h3').textContent = s.title;
    tour.querySelector('p').textContent = s.text;
    try { tour.querySelector('.tour-media').innerHTML = s.visual || ''; }
    catch (e) { tour.querySelector('.tour-media').innerHTML = ''; console.warn('Tour: Demo', e); }
    const btns = tour.querySelector('.tour-btns');
    btns.innerHTML = `<button class="btn btn-big" data-t="next">${s.cta || 'Weiter'}</button>`;
    btns.querySelector('[data-t]').onclick = () => {
      i++;
      if (i < steps.length) showSmooth();
      else { end(); showTourFinale(); }
    };
    // Erst rendern, dann MESSEN und ordentlich platzieren: die Bubble sitzt
    // mittig im freien Raum, klebt nie am Rand oder am Kreis
    requestAnimationFrame(() => { try {
      const M = 18;
      const safeTop = 64;
      const bh = bubble.offsetHeight;
      const el = s.sel && document.querySelector(s.sel);
      if (el && !s.center) {
        const rct = el.getBoundingClientRect();
        const r = Math.max(rct.width, rct.height) / 2 + 16;
        const cx = rct.left + rct.width / 2, cy = rct.top + rct.height / 2;
        spot.style.left = (cx - r) + 'px';
        spot.style.top = (cy - r) + 'px';
        spot.style.width = spot.style.height = (r * 2) + 'px';
        const spotTop = cy - r;
        const spotBottom = cy + r;
        const roomAbove = spotTop - safeTop;
        if (roomAbove >= bh + M) {
          // mittig im Raum zwischen Kopfzeile und Kreis
          bubble.style.top = (safeTop + (roomAbove - bh) / 2) + 'px';
          bubble.style.transformOrigin = 'center bottom';
        } else {
          bubble.style.top = Math.min(innerHeight - bh - M, spotBottom + M) + 'px';
          bubble.style.transformOrigin = 'center top';
        }
      } else {
        spot.style.left = '50%'; spot.style.top = '42%';
        spot.style.width = spot.style.height = '0px';
        bubble.style.top = Math.max(safeTop, (innerHeight - bh) / 2 - 24) + 'px';
        bubble.style.transformOrigin = 'center center';
      }
      bubble.style.bottom = '';
      bubble.classList.remove('pop');
      void bubble.offsetWidth;
      bubble.classList.add('pop');
    } catch (e) {
      // Notnagel: Bubble mittig zeigen statt gar nichts
      console.warn('Tour: Platzierung', e);
      spot.style.width = spot.style.height = '0px';
      bubble.style.top = '30%'; bubble.style.bottom = '';
      bubble.classList.add('pop');
    } });
  };
  // Zwischen den Steps taucht die Bubble kurz ab und kommt federnd wieder
  const showSmooth = () => {
    bubble.classList.add('leave');
    setTimeout(() => { bubble.classList.remove('leave'); show(); }, 170);
  };
  show();
}

// (Der Karten-Stepper ist Geschichte: Begrüßung + Tour übernehmen)
$('#ob-skip').addEventListener('click', () => finishOnboarding(false));
$('#btn-wallet-login').addEventListener('click', () => switchView('profile'));

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
// Der eigene Name mit Paint im Profil-Kopf: gami (bei Equips sofort aktuell)
// schlägt myProfile — dadurch wirkt Anlegen/Ablegen ohne Reload
function renderMyName() {
  const me = $('#me-name');
  if (!me || !state.userName) return;
  me.textContent = state.userName;
  const paintId = gami ? (gami.activePaint || '') : (myProfile?.activePaint || '');
  if (paintId) {
    const ns = nameStyleOf(state.userName, paintId);
    me.className = ns.cls.trim();
    me.setAttribute('style', ns.style);
  } else {
    me.className = '';
    me.removeAttribute('style');
  }
}
// Der eigene Profilbild-Rahmen: eine Stelle, die ihn überall nachträgt —
// die Avatar-Renderer laufen teils, bevor gami geladen ist
function applyMyBorder() {
  const id = gami?.activeBorder || '';
  for (const el of [document.querySelector('#me-avatar .avatar-big'), document.querySelector('#btn-profile-top .avatar-mini')]) {
    if (!el) continue;
    el.className = el.className.replace(/\s*pfb-[\w-]+/g, '');
    if (id) el.classList.add('pfb-' + id);
  }
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
    if (remote.index) await gleicheMitIndexAb(remote.index, remote.deleted, konto);
    else mischeWallet(remote, true); // alter Server: volle Wallet
    if (state.token !== konto) return;
    ensureWalletDates(); // auch vom Konto gezogene Alt-Gutscheine kriegen ein Datum
    save('wallet', state.wallet, true);
    renderWallet();
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
        title: fresh.length === 1 ? `Geschenk von @${g.giftFrom}!` : `${fresh.length} neue Geschenke!`,
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
function renderGiftsPage() {
  const host = $('#gifts-page');
  if (!host) return;
  if (!pendingGifts.length) {
    host.innerHTML = `<div class="status">Gerade wartet hier kein Geschenk. Schau später wieder vorbei!</div>`;
    return;
  }
  host.innerHTML = pendingGifts.map(g => `
    <button class="gift-row" data-gift-open="${esc(g.id)}">
      <img class="px-icon gift-row-img" src="/gamification/gift.svg" alt="">
      <span class="gift-row-info">
        <b>Von @${esc(g.giftFrom)}</b>
        <span class="muted">${g.giftTs ? new Date(g.giftTs).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ', ' + new Date(g.giftTs).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : ''}</span>
      </span>
      <span class="btn btn-small">Auspacken</span>
    </button>`).join('');
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
      <img class="gift-box${reducedMotion() ? '' : ' wiggling'}" src="/gamification/gift.svg" width="110" height="110" alt="Geschenk von @${esc(gift.giftFrom)}">
      <div class="gift-flash" aria-hidden="true"></div>
      <p class="gift-hint">Ein Geschenk von <b>@${esc(gift.giftFrom)}</b>. Antippen zum Auspacken!</p>
      <div class="gift-result hidden">
        <div class="offer-cat">Geschenk von @${esc(gift.giftFrom)}</div>
        <div class="schenk-karte auspack-karte" id="auspack-karte">${voucherCardHtml(gift)}</div>
        ${gift.giftMsg ? `<div class="gift-bubble">${withEmotes(esc(gift.giftMsg))}<span class="gift-by">— @${esc(gift.giftFrom)}</span></div>` : ''}
        <button class="btn btn-big" id="gr-done" style="margin-top:14px">In die Wallet</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  let opened = false;
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
        renderWallet();
        return;
      }
      state.wallet.vouchers.unshift({ ...gift, added: Date.now(), giftSeen: true });
      ensureWalletDates();
      saveWallet();
      syncWalletNow();
    })();
  });
  wrap.addEventListener('click', e => {
    if (e.target.id === 'gr-done') {
      wrap.remove();
      if (state.activeView === 'gifts') renderGiftsPage(); // das nächste wartet in der Liste
    }
  });
}
function euroFmt(n) { return n == null ? '' : n.toFixed(2).replace('.', ',') + ' €'; }

// ---- Spielgefühl: Sounds, Vibration, Aufleuchten, Geldscheine, Zähl-Animation ----

const SFX = { kaching: '/sounds/kaching.mp3', pay: '/sounds/pay.mp3', case: '/sounds/case.mp3', plop: '/sounds/plop.mp3', coin: '/sounds/coin.mp3', error: '/sounds/error.mp3', wow: '/sounds/wow.mp3', wowShort: '/sounds/wow-short.mp3' };
// Ton ist Opt-in: alle Effekte bleiben stumm, bis der Schalter in den Einstellungen an ist
// (function statt const: wird auch weiter oben im Skript schon beim Laden gebraucht)
function soundOn() { return localStorage.getItem('ra.sound') === '1'; }
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
function playSfx(name, vol) {
  if (!soundOn()) return { stop() { } };
  const b = sfxBuffers[name];
  if (sfxCtx && b) {
    try {
      if (sfxCtx.state === 'suspended') sfxCtx.resume();
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
  return [...state.wallet.vouchers, ...extra].find(x => x && x !== v && x.id !== v.id && istRabatt(x) === istRabatt(v) && (
    (x.pin && v.pin && String(v.pin).length >= 4 && x.pin === v.pin && shop(x.vendor) === shop(v.vendor))
    || (v.code && x.code && x.code === v.code && (shop(x.vendor) === shop(v.vendor) || String(v.code).length >= 12))));
}
// Ein gerade gespeicherter oder ausgepackter Gutschein darf nicht hinter einem
// gespeicherten Filter verschwinden — sonst wirkt er "weg"
function zeigeNeuenGutschein(v) {
  if (!v || istRabatt(v)) return;
  const f = state.walletFilter;
  if ((f && f !== 'alle' && f.toLowerCase() !== String(v.vendor || '').toLowerCase()) || state.walletVal) {
    state.walletFilter = '';
    state.walletVal = 0;
    saveWalletFilter();
  }
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
  if (state.sheetMode !== 'wallet-add' || !$('#wa-preview')) { waFixQueue.unshift(fix); return; }
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
  // Gesperrt (z. B. waehrend des Sicherns im Hintergrund): die Warteschlange
  // bleibt stehen und geht nach dem Entsperren ueber "Hinzufuegen" weiter
  if (walletGesperrt()) return false;
  // Weitere geteilte Bilder: das naechste ins Formular
  if (!waFixQueue.length && geteiltSchlange.length) {
    const f = geteiltSchlange.shift();
    openWalletAdd('voucher');
    if (state.sheetMode === 'wallet-add' && waHandleImage) waHandleImage(f);
    return true;
  }
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
  deutschlandcard: 'deutschlandcard.de', 'lidl plus': 'lidl.de', 'ikea family': 'ikea.com',
  aldi: 'aldi-sued.de', penny: 'penny.de', norma: 'norma-online.de', kaufland: 'kaufland.de',
  globus: 'globus.de', tegut: 'tegut.com', otto: 'otto.de', ebay: 'ebay.de', temu: 'temu.com',
  adidas: 'adidas.de', zara: 'zara.com', shein: 'shein.com', saturn: 'saturn.de',
  mcdonalds: 'mcdonalds.com', 'burger king': 'burgerking.de', subway: 'subway.com',
  netflix: 'netflix.com', disney: 'disneyplus.com', 'uber eats': 'ubereats.com',
  "mcdonald's": 'mcdonalds.com', "domino's": 'dominos.de', 'about you': 'aboutyou.de',
};
function brandChipHtml(name) {
  const domain = BRAND_DOMAINS[String(name || '').toLowerCase()];
  const logo = domain
    ? `<img class="brand-logo" src="https://www.google.com/s2/favicons?domain=${domain}&sz=64" alt=""
         loading="lazy" decoding="async" fetchpriority="low" width="64" height="64" onerror="this.remove()">`
    : '';
  // Mit Logo traegt der Chip Weiss statt Markenfarbe — sonst blitzt an den
  // Rundungen ein farbiger Rand um das Bild
  return `<span class="brand-chip${logo ? ' hat-logo' : ''}" style="--bc:${brandColor(name)}">${logo}${esc(brandInitials(name))}</span>`;
}

// bearbeiteId: dann wird eine vorhandene Sparkarte geaendert statt eine neue
// angelegt. Alles andere am Formular bleibt gleich — nur der Titel, die
// Vorbelegung und das Speichern unterscheiden sich.
function openWalletAdd(type, prefillName, bearbeiteId, opts = {}) {
  if (!state.token) { switchView('profile'); island('Für die Wallet bitte anmelden'); return; }
  if (walletGesperrt()) { aktualisiereSperre(); return; } // gesperrte Wallet: nichts zeigen
  waSaving = false;
  addType = type || 'voucher';
  addPrefill = prefillName || '';
  state.sheetMode = 'wallet-add';
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
  // Der Schieber startet dort, wo man herkam, und gleitet dann zum neuen Ziel
  const modusVon = opts.von || addType;
  $('#sheet-content').innerHTML = `
    <div class="sheet-title">${addEditId ? (isRabatt ? 'Rabattcode ändern' : 'Sparkarte ändern')
      : isCard ? 'Sparkarte hinzufügen' : isRabatt ? 'Rabattcode hinzufügen' : 'Gutschein hinzufügen'}</div>
    ${!isCard && !addEditId ? `
    <div class="wa-modus${modusVon === 'rabatt' ? ' rechts' : ''}" id="wa-modus" role="tablist" aria-label="Was fügst du hinzu?">
      <span class="wa-modus-flaeche" aria-hidden="true"></span>
      <button class="wa-modus-knopf${modusVon !== 'rabatt' ? ' an' : ''}" type="button" role="tab" data-wa-modus="voucher" aria-selected="${!isRabatt}">Gutschein</button>
      <button class="wa-modus-knopf${modusVon === 'rabatt' ? ' an' : ''}" type="button" role="tab" data-wa-modus="rabatt" aria-selected="${isRabatt}">Rabattcode</button>
    </div>` : ''}
    <div class="wa-form${opts.von ? ' wa-form-neu' : ''}">
    ${addEditId ? '' : (() => {
      const art = isCard ? 'karten' : 'gutscheine';
      const p = walletPlatz(art);
      const was = isCard ? 'Sparkarten' : 'Gutscheine und Rabattcodes';
      return `<p class="wa-platz ${p.voll ? 'voll' : p.fast ? 'fast' : ''}">${p.voll
        ? walletVollText(art)
        : `${p.n}${p.g ? ` + ${p.g} wartende Geschenke` : ''} von maximal ${p.max} ${was} in deiner Wallet · noch ${p.frei} frei`}</p>`;
    })()}

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
        <label class="btn btn-small btn-ghost" style="cursor:pointer">${isCard || isRabatt ? 'Bild' : 'Bilder'} hochladen
          <input id="wa-img" type="file" accept="image/*" ${isCard || isRabatt ? '' : 'multiple'} style="display:none"></label>
        <label class="btn btn-small btn-ghost" style="cursor:pointer">Foto aufnehmen
          <input id="wa-cam" type="file" accept="image/*" capture="environment" style="display:none"></label>
      </div>
      ${isCard ? '' : isRabatt ? '<p class="muted" style="font-size:.72rem; text-align:center; margin-top:4px">Screenshot vom Code? Dann liest die App Code, Rabatt und Mindestbestellwert selbst aus.</p>' : '<p class="muted" style="font-size:.72rem; text-align:center; margin-top:4px">Tipp: mehrere Bilder auswählen, dann landen alle erkannten Gutscheine auf einmal in der Wallet.</p>'}
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
    <label class="f-label">Kartennummer <span class="opt">(optional)</span></label>
    <input id="wa-cnumber" class="input" maxlength="30" placeholder="Falls die Karte eine hat"
      value="${esc(bearbeitet?.number || '')}">
    <p class="muted" style="font-size:.74rem; margin:4px 0 0">Manche Karten haben gar keine Nummer —
      dann reicht ein Foto vom Barcode, oder du legst sie einfach ohne an.</p>
    ` : isRabatt ? rabattFormHtml(bearbeitet) : `
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
        <label class="f-label" for="wa-pin">PIN <span class="opt">(optional)</span></label>
        <input id="wa-pin" class="input" maxlength="16" placeholder="z. B. 0689">
      </div>
    </div>
    <label class="f-label" for="wa-code">Code / Kartennummer <span class="opt">(optional)</span></label>
    <input id="wa-code" class="input" maxlength="40" placeholder="Falls vorhanden: der Code für die Kasse">
    <label class="f-label" for="wa-end">Gültig bis <span class="opt">(optional)</span></label>
    <input id="wa-end" class="input" type="date">
    `}
    <div class="form-row" style="margin-top:14px">
      <button id="wa-save" class="btn">${addEditId ? 'Änderungen speichern' : 'Speichern'}</button>
      <span id="wa-msg" class="form-msg"></span>
    </div>
    </div>`;

  // Shop-Kacheln: Antippen wählt aus, "Anderer Gutschein" öffnet das Freitextfeld
  let pickedVendor = '';
  $('#wa-vendor-showmore')?.addEventListener('click', () => {
    $('#sheet-content').querySelectorAll('.vendor-more').forEach(x => x.classList.remove('hidden'));
    $('#wa-vendor-showmore').remove();
  });
  $('#sheet-content').querySelectorAll('[data-vg]').forEach(b => b.addEventListener('click', () => {
    $('#sheet-content').querySelectorAll('.vendor-tile').forEach(x => x.classList.toggle('on', x === b));
    if (ANDERE_SHOPS.has(b.dataset.vg)) {
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

  // Gutschein oder Rabattcode: der Schieber oben wechselt das Formular
  const modus = $('#wa-modus');
  if (modus) {
    if (opts.von && opts.von !== addType) requestAnimationFrame(() => {
      modus.classList.toggle('rechts', isRabatt);
      modus.querySelectorAll('[data-wa-modus]').forEach(k => k.classList.toggle('an', k.dataset.waModus === addType));
    });
    modus.querySelectorAll('[data-wa-modus]').forEach(k => k.addEventListener('click', () => {
      if (k.dataset.waModus === addType || waSaving) return;
      buzz(8);
      openWalletAdd(k.dataset.waModus, '', '', { von: addType });
    }));
  }
  // Rabatt in Euro oder Prozent
  let waEinheit = bearbeitet?.rabattArt === 'pct' ? 'pct' : 'eur';
  const setzeEinheit = e => {
    waEinheit = e;
    const box = $('#wa-einheit');
    if (!box) return;
    box.classList.toggle('rechts', e === 'pct');
    box.querySelectorAll('[data-einheit]').forEach(x => {
      x.classList.toggle('an', x.dataset.einheit === e);
      x.setAttribute('aria-pressed', String(x.dataset.einheit === e));
    });
  };
  $('#wa-einheit')?.querySelectorAll('[data-einheit]').forEach(k => k.addEventListener('click', () => setzeEinheit(k.dataset.einheit)));
  // Mindestbestellwert: Schalter blendet das Betragsfeld ein
  const mbwText = () => {
    const t = $('#wa-mbw-text');
    if (!t) return;
    const n = parseFloat(String($('#wa-mbw')?.value || '').replace(',', '.'));
    t.textContent = $('#wa-mbw-an').checked ? (n > 0 ? 'ab ' + euroFmt(n) : 'Betrag eintragen') : 'ohne MBW';
  };
  $('#wa-mbw-an')?.addEventListener('change', e => {
    $('#wa-mbw-feld').classList.toggle('hidden', !e.target.checked);
    mbwText();
    if (e.target.checked) setTimeout(() => $('#wa-mbw')?.focus(), 60);
  });
  $('#wa-mbw')?.addEventListener('input', mbwText);
  // Beim Aendern (oder aus einem Marken-Blatt) den Shop vorwaehlen
  if (isRabatt && (bearbeitet?.vendor || addPrefill)) {
    const name = bearbeitet?.vendor || addPrefill;
    const tile = [...document.querySelectorAll('#wa-vendor-grid [data-vg]')]
      .find(t => !ANDERE_SHOPS.has(t.dataset.vg) && t.dataset.vg.toLowerCase() === name.toLowerCase());
    if (tile) {
      if (tile.classList.contains('vendor-more')) $('#wa-vendor-showmore')?.click();
      tile.click();
    } else {
      document.querySelectorAll('#wa-vendor-grid .vendor-tile').forEach(x => x.classList.toggle('on', x.dataset.vg === 'Anderer Shop'));
      $('#wa-vendor').classList.remove('hidden');
      $('#wa-vendor').value = name;
    }
  }

  // Beim Aendern das schon hinterlegte Bild gleich zeigen — sonst sieht es aus,
  // als waere es weg, und man laedt es unnoetig neu hoch.
  if (bearbeitet && (addCodeImg || addImg)) {
    $('#wa-preview').src = addCodeImg || addImg;
    $('#wa-preview').classList.remove('hidden');
    $('#wa-drop-empty').classList.add('hidden');
  }

  // Scan-Fortschritt: erst der Code-Scan (bis 20 %), dann die Text-Erkennung
  // Null-sicher: wird waehrenddessen ein anderes Blatt geoeffnet, fehlen die Elemente
  const scanProgress = p => {
    const f = $('#wa-progress-fill'), t = $('#wa-progress-txt');
    if (f) f.style.width = p + '%';
    if (t) t.textContent = Math.round(p) + ' %';
  };
  const handleImageFile = async f => {
    const m = $('#wa-ai-msg');
    if (!f) return;
    const lauf = ++waScanLauf;
    const veraltet = () => lauf !== waScanLauf;
    try {
      for (const [sel, wert] of Object.entries(waAutoWerte)) {
        if (sel === '__shop') { if (currentVendor() === wert) { pickedVendor = ''; document.querySelectorAll('.vendor-tile').forEach(x => x.classList.remove('on')); if ($('#wa-vendor')?.value === wert) $('#wa-vendor').value = ''; } continue; }
        const el = $(sel); if (el && el.value === wert) el.value = '';
      }
      waAutoWerte = {};
      addCodeImg = '';
      addOrig = '';
      addImg = ''; // scheitert das neue Bild, darf nicht das alte mitgespeichert werden
      const vorschau = await readImageFile(f, 900, 0.82, 'vorschau');
      if (veraltet()) return;
      addImg = vorschau;
      const ganz = await readImageFile(f, 1600, 0.82, 'foto').catch(() => '');
      if (veraltet()) return;
      addOrig = ganz;
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
      if (veraltet()) return;
      scanProgress(12);
      const r = await analyzeWalletImage(hiRes, p => {
        if (veraltet()) return;
        scanProgress(20 + p * 0.78);
        m.textContent = 'Lese den Text im Bild … (kann beim ersten Mal etwas dauern)';
      });
      // Inzwischen kam ein anderes Bild: dieses Ergebnis gehoert nicht mehr hierher
      if (veraltet()) return;
      if (r.codeImg) { addCodeImg = r.codeImg; $('#wa-preview').src = r.codeImg; }
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
            const hit = [...VENDOR_GRID.map(v => v.toLowerCase()), ...Object.keys(BRAND_COLORS)].find(k => low.includes(k));
            if (hit) {
              const tile = [...document.querySelectorAll('[data-vg]')].find(t => t.dataset.vg.toLowerCase() === hit);
              if (tile) tile.click();
              else { $('#wa-vendor').classList.remove('hidden'); $('#wa-vendor').value = hit.charAt(0).toUpperCase() + hit.slice(1); }
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
            const tile = [...document.querySelectorAll('#wa-vendor-grid [data-vg]')].find(t => t.dataset.vg.toLowerCase() === hit);
            if (tile) { if (tile.classList.contains('vendor-more')) $('#wa-vendor-showmore')?.click(); tile.click(); }
            else { $('#wa-vendor').classList.remove('hidden'); $('#wa-vendor').value = hit.charAt(0).toUpperCase() + hit.slice(1); }
            waAutoWerte.__shop = currentVendor();
            filled.push('Shop');
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
      for (const sel of felder) { const w = $(sel)?.value || ''; if (w && w !== vorher[sel]) waAutoWerte[sel] = w; }
      if (r.codeImg) filled.push('Kassen-Code ausgeschnitten');
      // Scan fertig: Balken voll, Laserlinie aus, Ergebnis ordentlich untereinander
      scanProgress(100);
      $('#wa-progress').classList.add('done');
      $('#wa-scanline').classList.add('hidden');
      setTimeout(() => $('#wa-progress')?.classList.add('hidden'), 1400);
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
        m.textContent = 'Nichts sicher erkannt, bitte die Felder ausfüllen. Gespeichert wird mit „Speichern“.';
      }
    } catch {
      if (veraltet()) return;
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
        small = await readImageFile(files[i], 900, 0.82, 'vorschau');
        if ($('#wa-preview')) $('#wa-preview').src = small;
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
    // Wurde waehrenddessen ein anderes Blatt geoeffnet, fehlen diese Elemente —
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
        m.className = 'form-msg';
        m.textContent = 'Sichere am Konto …';
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
    // Anderes Blatt offen: Ergebnis nur als Meldung, das Blatt nicht kapern
    if (state.sheetMode !== 'wallet-add') {
      if (fresh.length) island(`${fresh.length} Gutschein${fresh.length > 1 ? 'e' : ''} gespeichert`);
      return;
    }
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
    $('#wa-batch-done').onclick = async () => {
      if (fixes.length && !await askConfirm(`${fixes.length} Gutschein${fixes.length > 1 ? 'e sind' : ' ist'} noch unvollständig und ${fixes.length > 1 ? 'werden' : 'wird'} nicht gespeichert. Trotzdem fertig?`, { okLabel: 'Ja, verwerfen' })) return;
      closeSheet();
    };
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
    // Waehrend des Sicherns kann das Formular wechseln — danach zaehlt, was
    // beim Tippen auf "Speichern" galt
    const typ = addType, editId = addEditId;
    // Ohne Netz wird trotzdem gespeichert: die Wallet liegt dauerhaft auf dem
    // Geraet (IndexedDB) und geht hoch, sobald wieder Netz da ist
    let savedItem = null, savedList = null;
    // Wallet voll: ehrlich sagen statt still zu scheitern (Bearbeiten geht immer)
    const platzArt = addType === 'card' ? 'karten' : 'gutscheine';
    if (!addEditId && walletPlatz(platzArt).voll) {
      msg.className = 'form-msg error';
      msg.textContent = walletVollText(platzArt);
      return;
    }
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
      // Pflicht: Shop und Wert (PIN und Code sind optional, nicht jeder Gutschein hat welche)
      $('#wa-amount').classList.toggle('err', v.amount == null);
      $('#wa-pin').classList.remove('err');
      $('#wa-vendor-grid')?.classList.toggle('err', !v.vendor);
      if (!v.vendor || v.amount == null) {
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
      zeigeNeuenGutschein(v);
      // Gibt es einen Kassen-Zuschnitt, bleibt das ganze Foto als Original
      // erhalten — ausserhalb der Wallet
      if (addCodeImg && (addOrig || addImg)) origSichern(v, addOrig || addImg);
      savedItem = v; savedList = state.wallet.vouchers;
    } else if (addType === 'rabatt') {
      const alt = addEditId ? state.wallet.vouchers.find(x => x.id === addEditId && istRabatt(x)) : null;
      const zahl = sel => {
        const n = parseFloat(String($(sel)?.value || '').replace(',', '.'));
        return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
      };
      // amount/balance immer ausdruecklich null: sonst machte normalisiereWallet
      // (oder ein altes Geraet) aus dem Code Guthaben
      const rc = {
        ...(alt || {}),
        id: alt ? alt.id : Math.random().toString(36).slice(2, 9),
        art: 'rabatt',
        vendor: currentVendor().slice(0, 30),
        code: $('#wa-rcode').value.replace(/\s+/g, '').slice(0, 40),
        rabatt: zahl('#wa-rwert'),
        rabattArt: waEinheit,
        mbw: $('#wa-mbw-an').checked ? zahl('#wa-mbw') : null,
        end: $('#wa-end').value || '',
        notiz: $('#wa-notiz').value.trim().slice(0, 80),
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
      const zuViel = rc.rabattArt === 'pct' && rc.rabatt > 100;
      $('#wa-vendor-grid')?.classList.toggle('err', !rc.vendor);
      $('#wa-rcode').classList.remove('err');
      $('#wa-rwert').classList.toggle('err', zuViel);
      if (!rc.vendor || zuViel) {
        msg.className = 'form-msg error';
        msg.textContent = !rc.vendor ? 'Bitte einen Shop auswählen.' : 'Mehr als 100 % Rabatt gibt es nicht.';
        return;
      }
      const dupe = findDupe(rc);
      if (dupe && alt) {
        $('#wa-rcode').classList.add('err');
        msg.className = 'form-msg error';
        msg.textContent = `Diesen Code hast du schon (${dupe.vendor}). Bitte einen anderen eintragen.`;
        return;
      }
      if (dupe) {
        dupeReject(`Diesen Rabattcode hast du schon (${esc(dupe.vendor)}).`);
        return;
      }
      if (alt) state.wallet.vouchers[state.wallet.vouchers.indexOf(alt)] = rc;
      else state.wallet.vouchers.unshift(rc);
      if (addCodeImg && (addOrig || addImg) && (!alt || alt.codeImg !== addCodeImg)) origSichern(rc, addOrig || addImg);
      savedItem = rc; savedList = state.wallet.vouchers;
    } else {
      const alt = addEditId ? state.wallet.cards.find(x => x.id === addEditId) : null;
      const c = {
        id: alt ? alt.id : Math.random().toString(36).slice(2, 9),
        name: currentCard().slice(0, 30),
        number: $('#wa-cnumber').value.trim().slice(0, 30),
        img: addCodeImg ? '' : addImg, codeImg: addCodeImg,
        added: alt ? alt.added : Date.now(),
        // mt = zuletzt bearbeitet. Der Server entscheidet Konflikte danach —
        // ohne das koennte ein zweites Geraet die Aenderung ueberschreiben.
        ...(alt ? { mt: Date.now() } : {}),
      };
      // Nur die Marke ist Pflicht — REWE etwa hat gar keine Kartennummer
      $('#wa-card-grid')?.classList.toggle('err', !c.name);
      if (!c.name) { msg.className = 'form-msg error'; msg.textContent = 'Bitte eine Karte auswählen.'; return; }
      if (alt) {
        state.wallet.cards[state.wallet.cards.indexOf(alt)] = c;
      } else {
        state.wallet.cards.unshift(c);
      }
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
        // Das Konto hat abgelehnt: der Gutschein BLEIBT auf dem Geraet —
        // wegwerfen waere das Schlimmste. Blatt zu (ein zweiter Klick legte
        // ihn sonst doppelt an) und ehrlich sagen, was los ist.
        closeSheet();
        showToast({
          title: 'Auf dem Gerät gespeichert',
          text: 'Das Konto hat das Sichern abgelehnt (' + (walletSyncError || 'unbekannt') + '). Bitte neu anmelden, dann wird nachgesichert.',
          iconName: 'warning',
        }, 9000);
        return;
      }
      if (!ok) {
        // Netzwackler/Timeout: Gutschein BLEIBT auf dem Gerät, der Hintergrund-Sync
        // holt das Sichern nach — nichts wird still weggeworfen
        closeSheet();
        playSfx('kaching'); buzz(35);
        showToast({
          title: 'Gespeichert, Sicherung folgt',
          text: `Der Server war gerade nicht erreichbar. ${typ === 'rabatt' ? 'Der Rabattcode' : typ === 'card' ? 'Die Karte' : 'Der Gutschein'} bleibt auf dem Gerät und wird automatisch nachgesichert.`,
          iconName: 'warning',
        }, 8000);
        if (typ === 'rabatt') zeigeRabattcodes(savedItem.id);
        return;
      }
    }
    closeSheet();
    // Rabattcodes sind kein Guthaben: kein Geldregen, dafuer gleich zeigen, wo er liegt
    if (typ === 'rabatt') {
      playSfx('coin'); buzz(20);
      island(editId ? 'Rabattcode geändert' : 'Rabattcode gespeichert');
      zeigeRabattcodes(savedItem.id);
      return;
    }
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
    .filter(v => !istRabatt(v))
    .filter(v => String(v.vendor || '').trim().toLowerCase() === k)
    .filter(v => v.balance == null || v.balance > 0)
    .sort((a, b) => (a.balance ?? Infinity) - (b.balance ?? Infinity))
    .slice(0, max);
}

// Die Sparkarte sieht ueberall gleich aus: eine Bankkarte im Markenton.
// Vorderseite Logo und Nummer, Rueckseite der Code fuer die Kasse.
function sparkarteHtml(c, klein) {
  const marke = brandColor(c.name);
  const nummer = c.number ? String(c.number) : '';
  const gruppiert = nummer.replace(/(.{4})/g, '$1 ').trim();
  return `
    <div class="debitkarte ${klein ? 'mini' : ''}" style="--bc:${marke}" data-karte="${esc(c.id)}">
      <div class="dk-flaeche dk-vorne">
        <div class="dk-oben">
          ${brandChipHtml(c.name)}
          <span class="dk-marke">${esc(c.name)}</span>
        </div>
        <div class="dk-chip" aria-hidden="true"></div>
        <div class="dk-nummer">${esc(gruppiert || 'Sparkarte')}</div>
        <div class="dk-unten">
          <span>Sparkarte</span>
          ${!klein ? `<span class="dk-dreh">${icon('arrow-out', 'icon icon-sm')} antippen</span>` : ''}
        </div>
      </div>
      <div class="dk-flaeche dk-hinten">
        <div class="dk-streifen" aria-hidden="true"></div>
        ${c.codeImg || c.img
          ? `<img class="dk-code" src="${esc(c.codeImg || c.img)}" alt="Code für die Kasse">`
          : nummer
            ? `<div class="dk-code-ersatz">${ean13Svg(nummer) || `<span>${esc(gruppiert)}</span>`}</div>`
            : `<p class="dk-hinweis">Häng ein Foto vom Barcode an, dann kannst du ihn hier scannen lassen.</p>`}
        <span class="dk-hinten-marke">${esc(c.name)}</span>
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
  const freunde = myProfile?.friends || [];
  let anWen = '', suche = '', nachricht = '';

  const freundeHtml = () => {
    const gefiltert = suche ? freunde.filter(f => f.toLowerCase().includes(suche.toLowerCase())) : freunde;
    return gefiltert.map(f => `
      <button class="gp-freund${anWen === f ? ' gewaehlt' : ''}" type="button" data-gp-an="${esc(f)}" aria-pressed="${anWen === f}">
        <span class="gp-ava" style="--fc:${chatColor(f)}">${esc(f.slice(0, 1).toUpperCase())}</span>
        <span class="gp-name">@${esc(f)}</span>
        <span class="gp-haken">${icon('check', 'icon icon-sm')}</span>
      </button>`).join('') || '<p class="gp-leer">Niemand gefunden.</p>';
  };

  const seite = wseiteOeffnen({
    art: 'schenken', id: v.id, titel: 'Verschenken', klasse: 'gp',
    baue: s => {
      s.el.querySelector('.wseite-inhalt').innerHTML = `
        <div class="schenk-karte" id="schenk-karte">${voucherCardHtml(v)}</div>
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
          Der Gutschein wechselt endgültig den Besitzer — zurückholen geht nicht.
          kumulio verwahrt keine Gutscheine und haftet nicht für Wert, Gültigkeit
          oder Einlösbarkeit. Verschenke nur an Leute, die du kennst.
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
    if (senden) { senden.disabled = false; senden.textContent = `An @${anWen} verschenken`; }
    buzz(8);
  });
  verdrahteFreunde();
  const suchfeld = host.querySelector('.gp-suche');
  if (suchfeld) suchfeld.oninput = e => { suche = e.target.value; liste.innerHTML = freundeHtml(); verdrahteFreunde(); };
  const text = host.querySelector('.gp-text');
  if (text) text.oninput = e => { nachricht = e.target.value; };

  // Emotes wie im Chat: Namen in Doppelpunkten, beim Anzeigen werden Bilder daraus
  const emoteBtn = host.querySelector('.gp-emote-btn');
  const emoteBox = host.querySelector('.gp-emotes');
  if (emoteBtn && emoteBox) emoteBtn.onclick = () => {
    const auf = emoteBox.classList.contains('hidden');
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
    emoteBox.classList.toggle('hidden', !auf);
    emoteBtn.setAttribute('aria-expanded', String(auf));
  };

  if (senden) senden.onclick = async () => {
    if (!anWen || senden.disabled) return;
    senden.disabled = true;
    senden.textContent = 'Wird verpackt …';
    const aktuell = state.wallet.vouchers.find(x => x.id === v.id) || v;
    try {
      // Liegt das Originalfoto noch nur auf dem Geraet, erst hoch damit —
      // der Server gibt es beim Verschenken an den Freund weiter
      if (aktuell.orig && (origWartend().includes(aktuell.id) || origUploadLaeuft)) await origHochladen().catch(() => { });
      // Die eigene Notiz bleibt hier: ohne sie und etwas juenger als der Stand
      // am Konto, damit beim Vereinigen diese Fassung gewinnt
      const { notiz: _notiz, ...ohneNotiz } = aktuell;
      await api('/api/gift/send', { method: 'POST', body: JSON.stringify({
        to: anWen, id: aktuell.id, msg: (nachricht || '').trim(),
        // Die Fassung hier zaehlt (samt noch nicht gesicherter Abbuchung)
        voucher: _notiz ? { ...ohneNotiz, mt: Math.max(Date.now(), (aktuell.mt || 0) + 1) } : aktuell,
      }) });
    } catch (err) {
      senden.disabled = false;
      senden.textContent = `An @${anWen} verschenken`;
      island(err.message || 'Hat nicht geklappt');
      return;
    }
    // Erst wenn der Server den Gutschein wirklich uebergeben hat, verschwindet
    // er hier — sonst waere er bei einem Fehler in beiden Wallets weg.
    seite.sendet = true;
    tombstone(aktuell.id);
    state.wallet.vouchers = state.wallet.vouchers.filter(x => x.id !== aktuell.id);
    saveWallet();
    // Erst raeumt sich die Seite ab, dann faehrt die Karte in die Schachtel
    await seiteAufDieKarte(host);
    await packAnimation($('#schenk-karte'), 'ein');
    wseitenZu({ sanft: true });
    renderWallet();
    island(`An @${anWen} verschenkt`); playSfx('plop'); buzz([12, 40, 18]);
  };
}

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
  const drehbar = !!karteObj;

  const fahren = (auf) => {
    if (!von || !karte.animate) return null;
    const s = von.width / nach.width;
    const dx = (von.left + von.width / 2) - (nach.left + nach.width / 2);
    const dy = (von.top + von.height / 2) - (nach.top + nach.height / 2);
    const klein = `translate(${dx}px, ${dy}px) scale(${s})`;
    // Beim Herausfahren dreht die Karte auf dem Weg mit — das ist der
    // "smoothe Uebergang", nicht ein Dreh NACH dem Zoom.
    const gross = drehbar ? 'translate(0, 0) scale(1) rotateY(180deg)' : 'translate(0, 0) scale(1)';
    return karte.animate(
      auf ? [{ transform: klein }, { transform: gross }]
          : [{ transform: gross }, { transform: klein }],
      { duration: auf ? 460 : 320, easing: auf ? 'cubic-bezier(.22, 1, .32, 1)' : 'cubic-bezier(.4, 0, .7, .3)',
        fill: 'forwards' });
  };

  // Am Ende der Zoomfahrt uebernimmt die Klasse den gedrehten Zustand. Dabei
  // muss der CSS-Uebergang der Karte kurz aus sein: sonst faehrt er von "keine
  // Drehung" nochmal auf 180 Grad und die Karte flippt ein zweites Mal.
  const haltenOhneUebergang = () => {
    karte.style.transition = 'none';
    karte.classList.add('gedreht');
    void karte.offsetHeight;
    karte.style.transition = '';
  };

  requestAnimationFrame(() => {
    lupe.classList.add('an');
    const a = fahren(true);
    if (a) a.onfinish = () => { if (drehbar) haltenOhneUebergang(); a.cancel(); };
    else if (drehbar) haltenOhneUebergang();
  });

  const zu = () => {
    if (lupeOffen !== lupe) return;
    lupeOffen = null;
    lupe.classList.remove('an');
    knoepfe.style.opacity = '0';
    // Beim Zurueckfahren macht die Animation die Drehung mit — die Klasse darf
    // nicht gleichzeitig ihren eigenen Uebergang fahren.
    karte.style.transition = 'none';
    karte.classList.remove('gedreht');
    const a = fahren(false);
    const weg = () => lupe.remove();
    if (a) { a.onfinish = weg; setTimeout(weg, 420); } else setTimeout(weg, 260);
  };

  lupe.querySelector('.lupe-grund').onclick = zu;
  const drehen = () => { karte.style.transition = ''; karte.classList.toggle('gedreht'); buzz(8); };
  if (drehbar) karte.onclick = drehen;
  aktionen.forEach((a, i) => {
    lupe.querySelector(`[data-lupe="${i}"]`).onclick = () => {
      if (a.drehen) return drehen();
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

// Aus dem Marken-Raster: Karte plus die zwei Wege, die von dort weitergehen
function oeffneKartenLupe(key, kachel) {
  if (walletGesperrt()) { aktualisiereSperre(); return; } // gesperrte Wallet: nichts zeigen
  const b = walletBrands().find(x => x.key === key);
  if (!b) return;
  const gesperrt = b.coupons && !ccBesitzt(b.coupons);
  zeigeKarteGross({
    karteObj: b.card, name: b.name, vonEl: kachel,
    leerHtml: `<div class="debitkarte leer" style="--bc:${brandColor(b.name)}; --tc:${brandTextColor(b.name)}">
        <div class="dk-flaeche dk-vorne">
          <div class="dk-oben">${brandChipHtml(b.name)}<span class="dk-marke">${esc(b.name)}</span></div>
          <div class="dk-chip" aria-hidden="true"></div>
          <div class="dk-nummer">Keine Karte hinterlegt</div>
          <div class="dk-unten"><span>${esc(brandUntertitel(b))}</span></div>
        </div>
      </div>`,
    aktionen: [
      { text: 'Coupons & App', icon: 'tag', fn: () => openBrandSheet(key) },
      b.card
        ? { text: 'Umdrehen', icon: 'arrow-out', leise: true, drehen: true }
        : { text: 'Sparkarte hinzufügen', icon: 'plus', leise: true, fn: () => openWalletAdd('card', b.name) },
      // Verwalten steht direkt unter der Karte, in einer leisen zweiten Zeile —
      // dort sucht man es, wenn die Karte gerade vor einem liegt.
      ...(b.card ? [
        { text: 'Ändern', verwalten: true, fn: () => openWalletAdd('card', b.card.name, b.card.id) },
        { text: 'Löschen', verwalten: true, gefahr: true, bleibt: true, fn: () => karteLoeschen(b.card) },
      ] : []),
    ],
    hinweis: gesperrt ? 'Für diese Coupons brauchst du die Sparkarte.' : '',
  });
}


// showKarteBig ist entfallen: beide Wege zur grossen Karte laufen jetzt ueber
// zeigeKarteGross (Zoom aus der Kachel, Rest unscharf, dreht auf dem Weg).

// =============================================================================
// Wallet-Seiten (Runde 117): Gutschein, Verschenken und Analyse sind eigene
// Seiten statt Blaetter von unten. Sie gleiten von rechts ueber die ganze App
// (Kopfzeile und Menue eingeschlossen) und stapeln sich: Gutschein ->
// Verschenken. Zurueck per Pfeil oben links, Wisch nach rechts oder Esc.
// Bewegt wird nur transform und opacity.
// Der Zustand haengt an der Funktion statt an einem let hier oben: renderWallet
// laeuft schon beim Start, lange bevor diese Zeilen erreicht sind (TDZ).
// =============================================================================
function wseiten() { return wseiten.stapel || (wseiten.stapel = []); }
function wseiteOben() { const s = wseiten(); return s[s.length - 1] || null; }
function wseiteBewegt() { return !reducedMotion() && !document.body.classList.contains('sparsam'); }
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
  el.querySelector('.wseite-zurueck').onclick = () => { if (wseiteOben() === seite) wseiteZurueck(); };
  const inhalt = el.querySelector('.wseite-inhalt');
  inhalt.addEventListener('scroll', () => el.classList.toggle('gescrollt', inhalt.scrollTop > 2), { passive: true });
  wischZurueck(seite);
  baue(seite);
  dimm.getAnimations?.().forEach(a => a.cancel());
  dimm.style.opacity = '';
  if (!sofort && wseiteBewegt() && el.animate) {
    el.animate([{ transform: 'translate3d(100%, 0, 0)' }, { transform: 'translate3d(0, 0, 0)' }],
      { duration: 380, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    dimm.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 380, easing: 'ease-out' });
  }
  // Die Seite darunter muss nicht mehr gezeichnet werden, sobald sie bedeckt ist
  if (vorige) setTimeout(() => { if (wseiteOben() === seite) vorige.el.classList.add('verdeckt'); }, sofort ? 0 : 400);
  requestAnimationFrame(() => el.focus({ preventScroll: true }));
  return seite;
}

// Eine Seite zurueck. vonP: wie weit der Finger sie schon weggeschoben hat (0..1)
function wseiteZurueck({ vonP = 0, sofort = false } = {}) {
  const s = wseiten();
  const seite = s.pop();
  if (!seite) return;
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
  if (sofort || !wseiteBewegt() || !seite.el.animate) return weg();
  const dauer = Math.max(150, Math.round(300 * (1 - vonP)));
  const a = seite.el.animate(
    [{ transform: `translate3d(${(vonP * 100).toFixed(2)}%, 0, 0)` }, { transform: 'translate3d(100%, 0, 0)' }],
    { duration: dauer, easing: 'cubic-bezier(.32, .72, .4, 1)', fill: 'forwards' });
  dimm.getAnimations?.().forEach(x => x.cancel());
  dimm.animate([{ opacity: 1 - vonP }, { opacity: 0 }], { duration: dauer, easing: 'ease-out', fill: 'forwards' });
  a.onfinish = weg;
  setTimeout(weg, dauer + 80);   // falls onfinish ausbleibt (Tab im Hintergrund)
}

// Alle Seiten zu. sanft: die oberste blendet aus (nach Verschenken/Loeschen),
// sonst ist alles sofort weg (Sperre: keine Codes im Baum lassen).
function wseitenZu({ sanft = false } = {}) {
  const s = wseiten();
  if (!s.length) return;
  const oben = s[s.length - 1];
  while (s.length) {
    const x = s.pop();
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

// Wisch nach rechts = zurueck. Nur Finger (am Rechner gibt es den Pfeil), und
// nur waagerecht: senkrecht scrollt die Seite wie gewohnt. Die Seite folgt dem
// Finger; losgelassen faehrt sie ganz raus oder federt zurueck.
function wischZurueck(seite) {
  const el = seite.el;
  let w = null;
  el.addEventListener('pointerdown', e => {
    if (w && w.lauf) return;             // ein zweiter Finger stoert den laufenden Wisch nicht
    w = null;
    if (e.pointerType === 'mouse' || wseiteOben() !== seite || el.classList.contains('panel-offen')) return;
    if (e.target.closest('input, textarea, select, [data-kein-wisch]')) return;
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
    if (e.type !== 'pointercancel' && (p > .36 || (war.v > .45 && p > .05))) wseiteZurueck({ vonP: p });
    else wseiteFedern(seite, p);
  };
  el.addEventListener('pointerup', ende);
  el.addEventListener('pointercancel', ende);
  el.addEventListener('lostpointercapture', ende);
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
  seite.el.style.transform = `translate3d(${(p * 100).toFixed(2)}%, 0, 0)`;
  if (dimm) dimm.style.opacity = String(1 - p);
}
function wseiteFedern(seite, p) {
  const el = seite.el;
  const dimm = $('#wseiten .wseiten-dimm');
  const fertig = () => {
    el.style.transform = '';
    if (dimm) dimm.style.opacity = '';
    const s = wseiten();
    const darunter = s[s.indexOf(seite) - 1];
    if (darunter && wseiteOben() === seite) darunter.el.classList.add('verdeckt');
  };
  if (!el.animate || !wseiteBewegt()) return fertig();
  const a = el.animate([{ transform: `translate3d(${(p * 100).toFixed(2)}%, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
    { duration: 260, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  dimm?.animate([{ opacity: 1 - p }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
  el.style.transform = '';
  if (dimm) dimm.style.opacity = '';
  a.onfinish = fertig;
}
// Esc: erst das Aufgeklappte der obersten Seite, dann die Seite selbst
addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !wseiten().length) return;
  if (document.querySelector('.overlay:not(.hidden), .karten-lupe, .bild-lupe, .vk-menue, .pack-buehne')) return;
  if (document.body.classList.contains('blatt-ueber-seite')) return;   // das Blatt schliesst sich selbst
  e.stopPropagation();
  e.preventDefault();
  const oben = wseiteOben();
  if (oben.el.classList.contains('panel-offen')) return gdPanelZu(oben);
  if (oben.el.querySelector('.gd-leiste.auf')) return gdOptionen(oben, false);
  wseiteZurueck();
}, true);

// Ein Blatt aus einer Seite heraus (Sparkarte hinzufuegen oder aendern) muss
// ueber der Seite liegen. Die Klasse faellt weg, sobald das Blatt zu ist.
function blattUeberSeite(fn) {
  const blatt = $('#sheet');
  const warOffen = !!blatt?.classList.contains('open');
  document.body.classList.add('blatt-ueber-seite');
  fn();
  if (blatt) blatt.inert = false;
  // Lag das Blatt schon offen unter der Seite (Marken-Blatt), kommt es jetzt
  // sichtbar von unten hoch, statt ploetzlich ueber der Seite zu stehen
  if (warOffen && blatt?.animate && wseiteBewegt()) {
    blatt.animate([{ transform: 'translate(-50%, 100%)' }, { transform: 'translate(-50%, 0)' }],
      { duration: 380, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  }
}
// Geht ein Blatt auf, waehrend eine Seite offen ist (auch von anderswo, etwa
// "Karte zeigen" aus dem Laden-Hinweis), gehoert es nach oben
if ($('#sheet') && 'MutationObserver' in window) {
  new MutationObserver(() => {
    const blatt = $('#sheet');
    const offen = blatt.classList.contains('open');
    if (offen && !blattUeberSeite.offen) {
      blattUeberSeite.offen = true;
      if (wseiten().length) { document.body.classList.add('blatt-ueber-seite'); blatt.inert = false; }
    } else if (!offen && blattUeberSeite.offen) {
      blattUeberSeite.offen = false;
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
  if (walletGesperrt() || !state.token) { wseitenZu(); return; }
  if (s.some(x => x.sendet)) return;          // Verschenken laeuft gerade
  for (let i = 0; i < s.length; i++) {
    const seite = s[i];
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
  if (istRabatt(v)) return openRabattSheet(id);
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
  const domain = BRAND_DOMAINS[String(v.vendor || '').toLowerCase()];
  return domain
    ? `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128" alt="" loading="lazy" decoding="async" onerror="this.remove()">`
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

  // Sparkarte: an der Kasse gehoert sie zum Gutschein dazu
  const sparkarte = karte ? `
    <button class="gd-block gd-zeile" type="button" id="wv-karte">
      <span class="gd-zeile-bild">${sparkarteHtml(karte, true)}</span>
      <span class="gd-zeile-text"><b>${esc(v.vendor)}-Sparkarte</b><small>Erst die Karte zeigen, dann mit dem Gutschein zahlen</small></span>
      ${icon('chevron', 'icon gd-pfeil')}
    </button>`
    : cardApp(v.vendor)?.ohneKarte ? '' : `
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
      <div class="gd-tx${t.reverted ? ' zurueck' : ''}">
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
        <span class="gd-tx-text"><b>${v.giftFrom ? `Geschenk von @${esc(v.giftFrom)}` : 'Hinzugefügt'}</b><small>${zeit(v.added)}</small></span>
        <span class="gd-tx-betrag">${v.amount != null ? euroFmt(v.amount) : ''}</span>
        <span class="gd-tx-platz"></span>
      </div>` : '';

  return `
    <div class="gd-karte${brandHelligkeit(farbe) > 0.62 ? ' hell' : ''}" id="gd-karte"
      style="--bc:${farbe}; --tc:${brandTextColor(v.vendor)}">
      <span class="vk-motiv gd-motiv" aria-hidden="true">${vkMotivHtml(v)}</span>
      <div class="gd-karte-kopf">
        <span class="vk-logo">${brandChipHtml(v.vendor)}</span>
        <span class="gd-karte-namen"><b>${esc(v.vendor)}</b><span>${v.giftFrom ? `Geschenk von @${esc(v.giftFrom)}` : 'Gutschein'}</span></span>
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
  inhalt.innerHTML = gutscheinSeiteHtml(v, karte);
  el.querySelectorAll('.gd-leiste, .gd-dimm, .gd-panel').forEach(x => x.remove());
  el.classList.remove('panel-offen');
  el.insertAdjacentHTML('beforeend', gdLeisteHtml(v)
    + '<div class="gd-dimm" aria-hidden="true"></div><div class="gd-panel" role="dialog" aria-modal="true"></div>');
  inhalt.scrollTop = scroll;
  gdLeisteMessen(seite);
  verdrahteGutscheinSeite(seite, v, karte);
  if (animFrom != null && v.balance != null && animFrom !== v.balance) {
    animateNumber(el.querySelector('#gd-guthaben'), animFrom, v.balance);
  }
}

// Zugeklappt ragen nur die beiden Knoepfe und der Pfeil hervor: die Leiste
// wird um die Hoehe der Aktionen nach unten geschoben, der Inhalt bekommt
// unten genau so viel Luft, wie von der Leiste zu sehen ist
function gdLeisteMessen(seite) {
  const leiste = seite.el.querySelector('.gd-leiste');
  const opt = leiste?.querySelector('.gd-optionen');
  if (!opt) return;
  const optH = opt.offsetHeight;
  leiste.style.setProperty('--gd-opt-h', optH + 'px');
  seite.el.style.setProperty('--gd-leiste-h', Math.max(0, leiste.offsetHeight - optH) + 'px');
}
addEventListener('resize', () => wseiten().forEach(s => { if (s.art === 'gutschein') gdLeisteMessen(s); }), { passive: true });

function verdrahteGutscheinSeite(seite, v, karte) {
  const el = seite.el;
  el.querySelectorAll('[data-copy-txt]').forEach(b => b.onclick = () => { copyText(b.dataset.copyTxt); buzz(10); });
  // Die Sparkarte zoomt in die Mitte und dreht sich dabei um (wie im Raster)
  el.querySelector('#wv-karte')?.addEventListener('click', e => zeigeKarteGross({
    karteObj: karte, name: v.vendor, vonEl: e.currentTarget.querySelector('.debitkarte') || e.currentTarget,
    aktionen: [
      { text: 'Umdrehen', icon: 'arrow-out', leise: true, drehen: true },
      ...(karte.number
        ? [{ text: 'Nummer kopieren', icon: 'check', leise: true, bleibt: true, fn: () => copyText(karte.number) }]
        : []),
      { text: 'Ändern', verwalten: true, fn: () => blattUeberSeite(() => openWalletAdd('card', karte.name, karte.id)) },
      { text: 'Löschen', verwalten: true, gefahr: true, bleibt: true, fn: () => karteLoeschen(karte) },
    ],
  }));
  el.querySelector('#wv-addkarte')?.addEventListener('click', () => blattUeberSeite(() => openWalletAdd('card', v.vendor)));
  wireVoucherImage(v); // Bild tauschen / zuschneiden / vergroessern
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
  // Geld raus = Apple-Pay-Klang, rotes Aufleuchten, kurzer Ruckler an der
  // Karte; Geld rein = Ka-ching, gruenes Aufleuchten, Geldscheine
  if (sign < 0) {
    playSfx('pay'); buzz([45, 40, 45]); moneyFlash('red');
    if (!reducedMotion()) neuStarten(seite.el.querySelector('#gd-karte'), 'shake-once');
  } else {
    playSfx('kaching'); buzz(35); moneyFlash('green'); billRain(5);
  }
  showToast({
    title: sign < 0 ? 'Abbuchung gespeichert' : 'Aufladung gespeichert',
    text: `Restguthaben: ${euroFmt(v.balance)}`,
    success: true,
  }, 3500);
  return '';
}
async function gdRueckgaengig(seite, txId) {
  const v = state.wallet.vouchers.find(x => x.id === seite.id);
  const t = v?.tx?.find(x => x.id === txId);
  if (!t || t.reverted) return;
  const neu = Math.round((v.balance - t.amt) * 100) / 100;
  if (neu < -0.001) {
    island('Erst die spätere Abbuchung rückgängig machen, sonst wäre das Guthaben im Minus', 3600);
    return;
  }
  if (!await askConfirm(`${t.amt < 0 ? 'Abbuchung' : 'Aufladung'} über ${euroFmt(Math.abs(t.amt))} rückgängig machen?`,
    { okLabel: 'Rückgängig machen' })) return;
  if (walletGesperrt() || t.reverted) return;
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
  if (it) showCouponBig({ ...it, imgBase: ccCtx.d.img || '' }, ccCtx.d.brand || ccCtx.brand, ccCtx.d.validUntil);
}
function showCouponBig(it, brand, validUntil) {
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `<div class="modal cc-big ${it.barcode || it.ean ? 'cc-big-bc' : ''}">
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
  </div>`;
  document.body.appendChild(wrap);
  buzz(12);
  wrap.addEventListener('click', e => {
    if (e.target === wrap || e.target.closest('#ccb-close')) {
      wrap.classList.add('closing');
      setTimeout(() => wrap.remove(), 280);
    }
  });
}
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

// Ein Blatt je Marke: oben die Sparkarte (Nummer und Barcode fuer die Kasse),
// darunter der Sprung in die App, darunter die Coupons dieser Marke. Alles, was
// man beim Einkauf braucht, in einer Reihenfolge.
function openBrandSheet(key, richtung) {
  if (walletGesperrt()) { aktualisiereSperre(); return; } // gesperrte Wallet: nichts zeigen
  const b = walletBrands().find(x => x.key === key);
  if (!b) return;
  const c = b.card;
  // Passende Gutscheine: kleinster Rest zuerst, damit man die Reste aufbraucht
  const gutscheine = gutscheineZuMarke(b.name);
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
    ${c ? `
      <div class="karte-buehne" style="margin-top:14px">${sparkarteHtml(c)}</div>
      <p class="muted" style="font-size:.76rem; text-align:center; margin-top:8px">Antippen dreht die Karte zum Code</p>
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
  $('#sheet-content').querySelectorAll('.karte-buehne .debitkarte').forEach(k =>
    k.addEventListener('click', () => { k.classList.toggle('gedreht'); buzz(10); }));
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
  // Die Coupons dieser Marke direkt darunter — kein zweites Blatt mehr
  if (b.coupons) ladeCouponsIn(b.coupons.key, b.coupons.brand, $('#cc-slot'), !ccBesitzt(b.coupons));
  openSheetShell(richtung);
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
        <span class="vk-art">${v.giftFrom ? `Geschenk von @${esc(v.giftFrom)}` : 'Gutschein'}</span>
        <span class="vk-code">${esc(v.code || 'Ohne Code')}</span>
        ${v.pin ? `<span class="vk-pin">PIN ${esc(v.pin)}</span>` : ''}
      </div>
      <div class="vk-rechts">
        ${v.balance != null ? `<span class="wallet-card-balance">${euroFmt(v.balance)}</span>` : ''}
        ${mehr ? `<button class="vk-mehr" type="button" data-wv-mehr="${esc(v.id)}" aria-label="Aktionen für ${esc(v.vendor)}">${icon('mehr', 'icon')}</button>` : ''}
      </div>
      <div class="vk-fuss">${entferntAmHtml(v)}${fuss ? `<span>${fuss}</span>` : ''}</div>
      ${(v.stickers || []).map(voucherStickerHtml).join('')}
      ${v.giftFrom ? `<span class="gift-corner${v.giftSeen ? '' : ' unopened'}" role="img" aria-label="Geschenk von @${esc(v.giftFrom)}"><img src="/gamification/gift-tag.svg" alt=""></span>` : ''}
    </div>`;
}
// Maskottchen in der Wallet-Karte. Je Rang kommt spaeter ein eigenes Modell;
// bis dahin traegt jeder Rang das universelle (Daumen hoch). Eintrag = Dateiname
// ohne Breite, es gibt je eine -480.webp und -960.webp.
const WALLET_MASKOTTCHEN = { standard: '/brand/kumulio-maskottchen-wallet' };
function setzeWalletMaskottchen(tier) {
  const img = $('.wk-sprite');
  if (!img) return;
  const basis = WALLET_MASKOTTCHEN['rang-' + tier] || WALLET_MASKOTTCHEN.standard;
  if (img.dataset.basis === basis) return;
  img.dataset.basis = basis;
  img.srcset = `${basis}-480.webp 480w, ${basis}-960.webp 960w`;
  img.src = `${basis}-480.webp`;
}

// "…" an der Karte: Code/PIN kopieren, Abbuchen, Verschenken, Details — der
// schnelle Weg, ohne erst die Seite zu lesen
function schliesseVkMenue() { document.querySelectorAll('.vk-menue').forEach(m => m.remove()); }
function oeffneVkMenue(id, knopf) {
  const offen = document.querySelector('.vk-menue');
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
// Gesamtguthaben, nicht in der Statistik, nicht beim Verschenken.
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
  return d ? `https://www.${d}` : '';
}
function rabattCardHtml(v) {
  const aus = !!v.eingeloest || rabattAbgelaufen(v);
  const wert = rabattWertText(v);
  const status = v.eingeloest ? 'eingelöst'
    : v.end ? (rabattAbgelaufen(v) ? 'abgelaufen' : 'bis ' + new Date(v.end).toLocaleDateString('de-DE')) : '';
  return `
    <div class="wallet-card rc-card${aus ? ' rc-aus' : ''}${brandHelligkeit(brandColor(v.vendor)) > 0.62 ? ' hell' : ''}"
      data-rc="${esc(v.id)}" role="button" tabindex="0" aria-label="${esc(v.vendor)}-Rabattcode öffnen"
      style="--bc:${brandColor(v.vendor)}; --tc:${brandTextColor(v.vendor)}">
      <div class="wallet-card-head">
        ${brandChipHtml(v.vendor)}
        <span class="wallet-card-name">${esc(v.vendor)}</span>
        ${wert ? `<span class="wallet-card-balance">−${wert}</span>` : ''}
      </div>
      <div class="wallet-card-sub">
        ${v.code ? `<span class="rc-code">${esc(v.code)}</span>` : ''}
        <span class="pill">${rabattMbwText(v)}</span>
        ${status ? `<span class="pill">${status}</span>` : ''}
        ${v.code ? `<button class="rc-kopieren" type="button" data-rc-copy="${esc(v.id)}" aria-label="Code ${esc(v.code)} kopieren">Kopieren</button>` : ''}
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
function openRabattSheet(id, richtung) {
  if (walletGesperrt()) { aktualisiereSperre(); return; } // gesperrte Wallet: nichts zeigen
  const v = state.wallet.vouchers.find(x => x.id === id && istRabatt(x));
  if (!v) return;
  state.sheetMode = 'rabatt-detail';
  const abgelaufen = rabattAbgelaufen(v);
  const wert = rabattWertText(v);
  const shop = rabattShopUrl(v.vendor);
  $('#sheet-content').innerHTML = `
    <div class="offer-head">
      ${brandChipHtml(v.vendor)}
      <div class="offer-brand">
        <div class="offer-merchant">${esc(v.vendor)}</div>
        <div class="offer-cat">Rabattcode · ${v.eingeloest ? 'eingelöst'
          : v.end ? (abgelaufen ? 'abgelaufen' : 'gültig bis ' + new Date(v.end).toLocaleDateString('de-DE')) : 'ohne Ablaufdatum'}</div>
      </div>
    </div>
    <div class="rc-gross${v.eingeloest || abgelaufen ? ' rc-aus' : ''}" style="--bc:${brandColor(v.vendor)}; --tc:${brandTextColor(v.vendor)}">
      <div class="rc-gross-wert">${wert ? '−' + wert : 'Rabatt'}</div>
      <div class="rc-gross-mbw">${rabattZahl(v.mbw) ? `ab ${esc(euroFmt(rabattZahl(v.mbw)))} Bestellwert` : 'ohne Mindestbestellwert'}</div>
    </div>
    ${v.code ? `<div class="rc-codefeld">
      <span class="wallet-code rc-codetext">${esc(v.code)}</span>
      <button class="btn btn-small" data-copy-txt="${esc(v.code)}" type="button">Code kopieren</button>
    </div>` : ''}
    <p class="rc-info">${icon('bulb', 'icon icon-sm')}
      <span>${v.code ? 'Zählt nicht zum Wallet-Guthaben: den Code gibst du beim Bestellen ein.'
        : 'Zählt nicht zum Wallet-Guthaben. Ohne Code gilt der Rabatt meist direkt im Shop oder in der App.'}</span></p>
    ${v.notiz ? `<p class="rc-info">${icon('list', 'icon icon-sm')}<span>${esc(v.notiz)}</span></p>` : ''}
    ${v.codeImg ? `<img class="wallet-code-img" id="wv-bild" src="${esc(v.codeImg)}" alt="Bild zum Rabattcode"
        role="button" tabindex="0" aria-label="Bild vergrößern">`
      : v.img ? `<img class="wallet-img" id="wv-bild" src="${esc(v.img)}" alt="Bild zum Rabattcode"
        role="button" tabindex="0" aria-label="Bild vergrößern">` : ''}
    <div class="bild-aktionen">
      <label class="bild-btn">
        ${icon(v.codeImg || v.img ? 'wand' : 'plus', 'icon')}
        <span>${v.codeImg || v.img ? 'Bild tauschen' : 'Bild hinzufügen'}</span>
        <input type="file" id="wv-img-file" accept="image/*" style="display:none">
      </label>
      ${v.codeImg || v.img ? `<button class="bild-btn" id="wv-img-crop">
        ${icon('sliders', 'icon')}<span>Zuschneiden</span></button>
        <button class="bild-btn bild-btn-rund" id="wv-img-zoom" aria-label="Bild vergrößern" title="Vergrößern">
        ${icon('search', 'icon')}</button>` : ''}
    </div>
    ${shop ? `<a class="app-jump" href="${shop}" target="_blank" rel="noopener noreferrer" style="--bc:${brandColor(v.vendor)}">
      ${brandChipHtml(v.vendor)}
      <span class="app-jump-txt"><b>Zu ${esc(v.vendor)}</b><small>${v.code ? 'Code kopieren, dort bestellen und einlösen' : 'Dort bestellen und den Rabatt nutzen'}</small></span>
      ${icon('arrow-right', 'icon icon-sm')}
    </a>` : ''}
    <div class="form-row rc-aktionen">
      <button class="btn btn-small" id="rc-eingeloest" type="button">${v.eingeloest ? 'Wieder aktiv' : 'Als eingelöst markieren'}</button>
      <button class="btn btn-small btn-ghost" id="rc-aendern" type="button">Ändern</button>
    </div>
    ${v.added ? `<p class="added-line">Hinzugefügt am ${new Date(v.added).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}</p>` : ''}
    <button class="btn btn-danger" id="rc-del" type="button" style="margin-top:14px">Rabattcode löschen</button>`;
  $('#sheet-content').querySelectorAll('[data-copy-txt]').forEach(b => b.addEventListener('click', () => copyText(b.dataset.copyTxt)));
  wireVoucherImage(v); // Bild tauschen / zuschneiden / nachtraeglich hochladen
  $('#rc-eingeloest').addEventListener('click', () => {
    v.eingeloest = v.eingeloest ? 0 : Date.now();
    saveWallet();
    buzz(12);
    island(v.eingeloest ? 'Als eingelöst markiert' : 'Wieder aktiv');
    openRabattSheet(v.id);
  });
  $('#rc-aendern').addEventListener('click', () => openWalletAdd('rabatt', v.vendor, v.id));
  $('#rc-del').addEventListener('click', async () => {
    if (!await askConfirm(`Den ${esc(v.vendor)}-Rabattcode löschen?`, { okLabel: 'Löschen' }) || walletGesperrt()) return;
    tombstone(v.id);
    state.wallet.vouchers = state.wallet.vouchers.filter(x => x.id !== v.id);
    saveWallet(); closeSheet(); island('Rabattcode gelöscht');
  });
  openSheetShell(richtung);
}
// Formularteil fuer Rabattcodes (im Blatt "Hinzufuegen")
function rabattFormHtml(v) {
  const pct = v?.rabattArt === 'pct';
  return `
    <label class="f-label">Shop <span class="req">*</span></label>
    <div class="vendor-grid" id="wa-vendor-grid">
      ${RABATT_GRID.map((n, i) => `<button class="vendor-tile ${i >= 6 ? 'hidden vendor-more' : ''}" data-vg="${esc(n)}" type="button">
        ${brandChipHtml(n)}
        <span>${esc(n)}</span>
      </button>`).join('')}
      <button class="vendor-tile" id="wa-vendor-showmore" type="button">
        <span class="brand-chip" style="--bc:rgba(127,127,127,.4)">…</span>
        <span>Weitere</span>
      </button>
    </div>
    <input id="wa-vendor" class="input hidden" maxlength="30" placeholder="Shop-Name eintippen">
    <label class="f-label" for="wa-rcode">Rabattcode <span class="opt">(optional)</span></label>
    <input id="wa-rcode" class="input rc-eingabe" maxlength="40" placeholder="z. B. SPAR5, falls es einen gibt"
      autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" value="${esc(v?.code || '')}">
    <label class="f-label" for="wa-rwert">Rabatt <span class="opt">(optional)</span></label>
    <div class="rc-wertzeile">
      <input id="wa-rwert" class="input" inputmode="decimal" placeholder="z. B. 5"
        value="${v?.rabatt != null ? esc(String(v.rabatt).replace('.', ',')) : ''}">
      <div class="wa-modus klein${pct ? ' rechts' : ''}" id="wa-einheit" role="group" aria-label="Rabatt in Euro oder Prozent">
        <span class="wa-modus-flaeche" aria-hidden="true"></span>
        <button class="wa-modus-knopf${pct ? '' : ' an'}" type="button" data-einheit="eur" aria-pressed="${!pct}">€</button>
        <button class="wa-modus-knopf${pct ? ' an' : ''}" type="button" data-einheit="pct" aria-pressed="${pct}">%</button>
      </div>
    </div>
    <div class="rc-mbw-zeile">
      <span class="rc-mbw-txt"><b>Mindestbestellwert</b><small id="wa-mbw-text">${v?.mbw ? 'ab ' + euroFmt(v.mbw) : 'ohne MBW'}</small></span>
      <label class="switch"><input type="checkbox" id="wa-mbw-an" ${v?.mbw ? 'checked' : ''}><span class="switch-slider"></span></label>
    </div>
    <div id="wa-mbw-feld" class="${v?.mbw ? '' : 'hidden'}">
      <input id="wa-mbw" class="input" inputmode="decimal" placeholder="Ab welchem Bestellwert? z. B. 15"
        value="${v?.mbw ? esc(String(v.mbw).replace('.', ',')) : ''}">
    </div>
    <div class="form-grid">
      <div>
        <label class="f-label" for="wa-end">Gültig bis <span class="opt">(optional)</span></label>
        <input id="wa-end" class="input" type="date" value="${esc(v?.end || '')}">
      </div>
      <div>
        <label class="f-label" for="wa-notiz">Notiz <span class="opt">(optional)</span></label>
        <input id="wa-notiz" class="input" maxlength="80" placeholder="z. B. nur Neukunden" value="${esc(v?.notiz || '')}">
      </div>
    </div>`;
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
  const domain = BRAND_DOMAINS[String(name).toLowerCase()];
  const inhalt = domain
    ? `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64" alt="" decoding="async" onerror="this.remove()">`
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
  const v = state.wallet.vouchers.find(x => !istRabatt(x) && (x.balance == null || x.balance > 0)
    && String(x.vendor || '').toLowerCase() === f);
  return v ? v.vendor : '';
}

// Zwei Wallet-Bereiche: Gutscheine | Karten & Coupons
let walletTab = 'gutscheine';
// Der Wechsel blendet ueber: der alte Bereich (und beim Weg zu den Coupons der
// Guthaben-Block) blendet aus, dann wird in EINEM Schritt umgeschaltet, der
// Schieber gleitet an seine neue Stelle und der neue Bereich blendet ein.
// Karten & Coupons sind universell — dort gelten immer die Rang-Farben, nie
// die der gewaehlten Marke.
function updateWalletTab(anim) {
  const coupons = walletTab === 'coupons' || walletTab === 'karten';
  const gated = !state.token && !coupons;
  document.body.classList.toggle('wallet-farbe', state.activeView === 'wallet' && !!state.token);
  $('#wallet-modes')?.classList.toggle('rechts', coupons);
  document.querySelectorAll('[data-wtab]').forEach(b =>
    b.setAttribute('aria-selected', b.classList.contains('active') ? 'true' : 'false'));
  setzeMarkenModus(coupons || gated ? '' : walletMarkeName());
  if (!walletTab.startsWith('gutscheine')) $('#wallet-mini')?.classList.remove('show');

  const wc = $('#wallet-content'), cc = $('#coupons-content'), geld = $('#wallet-kopf-geld');
  const setzen = (neuZeichnen = true) => {
    $('#wallet-gate').classList.toggle('hidden', !gated);
    wc.classList.toggle('hidden', gated || coupons);
    cc.classList.toggle('hidden', !coupons);
    if (coupons && neuZeichnen) renderCoupons(cc);
  };
  const altHost = !cc.classList.contains('hidden') ? cc : !wc.classList.contains('hidden') ? wc : null;
  const neuHost = coupons ? cc : gated ? null : wc;
  const lauf = (updateWalletTab.lauf || 0) + 1;
  updateWalletTab.lauf = lauf;
  // Ein laufender Wechsel ist mit diesem erledigt: seine Blenden loesen
  for (const el of [wc, cc, geld]) el?.getAnimations?.().forEach(a => { if (a.id === 'wtab') a.cancel(); });

  const bewegt = anim && altHost !== neuHost && !reducedMotion()
    && !document.body.classList.contains('sparsam') && !!wc.animate;
  if (!bewegt) {
    setzen();
    kopfUmschalten(coupons || gated, false, kopfZielUnten(coupons || gated));
    return;
  }
  // Die Coupons schon jetzt aufbauen, solange sie noch versteckt sind (kostet
  // dann kein Layout) — sonst faellt die Arbeit genau in den Moment, in dem der
  // Schieber losgleiten soll
  if (coupons) renderCoupons(cc);
  pruefeBildrate();   // das Geraet misst sich selbst, siehe unten
  // Fuer die Dauer der Umschaltung ruhen die teuren Weichzeichner (siehe CSS)
  document.body.classList.add('wallet-wechsel');
  clearTimeout(updateWalletTab.ruheTimer);
  updateWalletTab.ruheTimer = setTimeout(() => document.body.classList.remove('wallet-wechsel'), 700);
  const zuKlappen = (coupons || gated) && !geld.classList.contains('zu');
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
    const aufKlappen = !(coupons || gated) && geld.classList.contains('zu');
    const kopfZiel = kopfZielUnten(coupons || gated);
    setzen(false);
    kopfUmschalten(coupons || gated, true, kopfZiel);
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

  const allActive = state.wallet.vouchers.filter(v => !istRabatt(v) && (v.balance == null || v.balance > 0));
  const used = state.wallet.vouchers.filter(v => !istRabatt(v) && v.balance != null && v.balance <= 0);

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
    setzeWalletMaskottchen(rank.tier);
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
        <div class="deck" data-deck="${esc(key)}" style="--bc:${brandColor(vn)}" role="button" aria-label="${esc(titel)}-Stapel öffnen">
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
      teile.push(`
        <div class="deck-head">
          <span class="deck-head-name">${brandChipHtml(vn)} <b>${esc(titel)}</b> <small>(${list.length})</small></span>
          <button class="chip" data-deck-close="${esc(key)}">Stapeln</button>
        </div>
        ${list.slice(0, shown).map(vCard).join('')}`);
    }
    voucherHtml = teile.join('') + (rest > 0 ? moreBtn('__sicht', rest) : '');
  }
  const liste = $('#voucher-list');
  const vorher = renderWallet.letzteListe || '';
  const knopfAb = vorher.lastIndexOf('<button class="deck-more"');
  const vorherOhneKnopf = knopfAb >= 0 ? vorher.slice(0, knopfAb) : vorher;
  if (vorher && liste.firstElementChild && vorherOhneKnopf && voucherHtml.startsWith(vorherOhneKnopf)) {
    // Nur nachgewachsen: den alten Knopf wegnehmen und den Rest anhaengen.
    // So bleiben die schon gezeichneten Karten stehen, die Seite springt nicht,
    // und man verliert beim Nachladen nicht die Stelle, an der man war.
    liste.querySelectorAll('[data-deck-more]').forEach(b => b.remove());
    liste.insertAdjacentHTML('beforeend', voucherHtml.slice(vorherOhneKnopf.length));
  } else {
    liste.innerHTML = voucherHtml;
  }
  renderWallet.letzteListe = voucherHtml;
  // Aufgebrauchte: nur die ersten 12 rendern, Rest auf Wunsch
  const usedLim = walletDeckShown.__used || SICHT_SCHRITT;
  $('#voucher-used').innerHTML = (used.slice(0, usedLim).map(vCard).join('')
    + (used.length > usedLim ? moreBtn('__used', used.length - usedLim) : ''))
    || '<div class="status">Nichts aufgebraucht.</div>';
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

  // Suchergebnisse gleiten gestaffelt herein
  document.querySelectorAll('#voucher-list .wallet-card').forEach((el, i) => {
    el.classList.add('anim-item');
    el.style.animationDelay = Math.min(i * 45, 300) + 'ms';
  });
  $('#view-wallet').querySelectorAll('[data-wv]').forEach(el => el.onclick = () => openVoucherSheet(el.dataset.wv));
  $('#view-wallet').querySelectorAll('[data-wv-mehr]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    if (walletGesperrt()) { aktualisiereSperre(); return; }
    oeffneVkMenue(b.dataset.wvMehr, b);
  });
  // Deck auf/zu + portionsweise nachladen (auch automatisch beim Scrollen)
  $('#view-wallet').querySelectorAll('[data-deck]').forEach(el => el.onclick = () => {
    walletDeckOpen.add(el.dataset.deck);
    buzz(12);
    el.classList.add('deck-pop');   // Stapel federt kurz auf, dann kommt die Liste
    setTimeout(renderWallet, 110);
  });
  $('#view-wallet').querySelectorAll('[data-deck-close]').forEach(el => el.onclick = e => {
    e.stopPropagation();
    walletDeckOpen.delete(el.dataset.deckClose);
    delete walletDeckShown[el.dataset.deckClose];
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
}

// Zuletzt verwendet: der Gutschein der letzten Abbuchung (nicht rueckgaengig
// gemacht), solange er noch Guthaben hat. Nicht waehrend einer Suche; mit
// Markenfilter nur, wenn er zu dieser Marke gehoert.
function zuletztVerwendet() {
  let best = null, bestTs = 0;
  for (const v of state.wallet.vouchers) {
    if (istRabatt(v) || !(v.balance > 0)) continue;
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
  host.classList.toggle('hidden', !passt);
  if (!passt) { host.innerHTML = ''; delete host.dataset.stand; return; }
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
  if (!menu || menu.classList.contains('hidden')) return;
  menu.classList.add('hidden');
  $('#wallet-marke')?.setAttribute('aria-expanded', 'false');
}
function oeffneMarkenMenue() {
  const menu = $('#wallet-marken-menue'), knopf = $('#wallet-marke');
  if (!menu || !knopf) return;
  if (!menu.classList.contains('hidden')) return schliesseMarkenMenue();
  const aktiv = state.wallet.vouchers.filter(v => !istRabatt(v) && (v.balance == null || v.balance > 0));
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
    if (istRabatt(v)) return;
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
    if (istRabatt(v)) return;
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
  const aktiv = state.wallet.vouchers.filter(v => !istRabatt(v) && v.balance != null && v.balance > 0);
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
function zeichneAnalyse(seite, { nurWennNeu = false } = {}) {
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
  inhalt.innerHTML = `
    <div class="ana-zeitraum" role="tablist" aria-label="Zeitraum" data-kein-wisch style="--i:${idx}">
      <span class="ana-flaeche" aria-hidden="true"></span>
      ${ANA_BEREICHE.map(([k, t]) => `<button class="ana-tab${k === bereich ? ' an' : ''}" type="button" role="tab"
        aria-selected="${k === bereich}" data-bereich="${k}">${t}</button>`).join('')}
    </div>
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
  // Beim Zeitraumwechsel zaehlen die Summen vom alten Stand aus
  if (vorher && !nurWennNeu) {
    animateNumber(inhalt.querySelector('#ana-rein'), vorher.added, s.added, 500);
    animateNumber(inhalt.querySelector('#ana-raus'), vorher.spent, s.spent, 500);
  }
  inhalt.querySelectorAll('[data-bereich]').forEach(b => b.onclick = () => {
    if (b.dataset.bereich === (zeichneAnalyse.bereich || 'monat')) return;
    zeichneAnalyse.bereich = b.dataset.bereich;
    seite.gewaehlt = null;
    buzz(6);
    // Erst die Flaeche gleiten lassen, dann neu zeichnen — sonst springt sie
    const leiste = inhalt.querySelector('.ana-zeitraum');
    leiste.style.setProperty('--i', ANA_BEREICHE.findIndex(([k]) => k === b.dataset.bereich));
    leiste.querySelectorAll('.ana-tab').forEach(x => x.classList.toggle('an', x === b));
    clearTimeout(zeichneAnalyse.uhr);
    zeichneAnalyse.uhr = setTimeout(() => { if (wseiten().includes(seite)) zeichneAnalyse(seite); }, wseiteBewegt() ? 200 : 0);
  });
  inhalt.querySelectorAll('[data-monat]').forEach(b => b.onclick = () => {
    seite.gewaehlt = Number(b.dataset.monat);
    inhalt.querySelectorAll('.ana-monat').forEach(x => {
      const an = x === b;
      x.classList.toggle('an', an);
      x.setAttribute('aria-pressed', String(an));
    });
    const aus = inhalt.querySelector('.ana-auswahl');
    if (aus) aus.innerHTML = anaAuswahlHtml(felder[seite.gewaehlt]);
    buzz(4);
  });
}

// Alle Stufen auf einen Blick — als Liste, wie man sie aus Banking-Apps kennt
$('#wallet-rank')?.addEventListener('click', e => { e.stopPropagation(); zeigeRang(); });
function zeigeRang() {
  const total = renderWallet.lastTotal || 0;
  const jetzt = rankFor(total);
  state.sheetMode = 'rang';
  $('#sheet-content').innerHTML = `
    <div class="sheet-title">Spar-Rang</div>
    <p class="muted" style="font-size:.84rem; margin-bottom:14px">
      Dein Rang richtet sich nach dem Guthaben, das in deiner Wallet liegt.
      Er ist reine Spielerei — auf Gutscheine und Coupons hat er keinen Einfluss.</p>
    <div class="rang-liste">${RANKS.map(r => {
      const erreicht = total >= r.min;
      const aktuell = r.name === jetzt.name;
      return `
      <div class="rang-stufe ${erreicht ? 'erreicht' : ''} ${aktuell ? 'aktuell' : ''}">
        <span class="rang-punkt tier-${r.tier}"></span>
        <span class="rang-text"><b>${esc(r.name)}</b><small>ab ${euroFmt(r.min) || '0 €'}</small></span>
        ${aktuell ? '<span class="rang-jetzt">jetzt</span>'
          : erreicht ? icon('check', 'icon icon-sm') : ''}
      </div>`;
    }).join('')}</div>`;
  openSheetShell();
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
  document.body.classList.toggle('kopf-weg',
    state.activeView === 'wallet' && (!inWallet || verdeckt));
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
//   --ff-hoehe   Gesamthoehe, also --ff-kopf plus 300 px Auslauf
//   --ff-versatz wie weit die Flaeche gerade nach oben gefahren ist
// Die ersten beiden aendern sich nur bei einem Groessenwechsel, deshalb bleibt
// der 26-stufige Verlauf waehrend der Ueberblendung derselbe und muss nicht in
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
const SPARSAM = 'ra.sparsam';
let fpsProben = 0;
let letzteFps = null;
try { letzteFps = JSON.parse(localStorage.getItem('ra.fps') || 'null'); } catch { /* egal */ }
if (localStorage.getItem(SPARSAM) === '1') document.body.classList.add('sparsam');

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
  if (document.body.classList.contains('sparsam') || fpsProben >= 3) return;
  fpsProben++;
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
    try { lsSetzen('ra.fps', JSON.stringify(letzteFps)); } catch { /* egal */ }
    zeigeFpsAnzeige();
    if (lang >= 4) {
      try { lsSetzen(SPARSAM, '1'); } catch { /* egal */ }
      document.body.classList.add('sparsam');
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
      try { localStorage.removeItem(SPARSAM); localStorage.removeItem('ra.fps'); } catch { /* egal */ }
      document.body.classList.remove('sparsam');
      fpsProben = 0; letzteFps = null;
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
function zeichneSchenkAuswahl(seite) {
  if (walletGesperrt()) { aktualisiereSperre(); return; } // gesperrte Wallet: nichts zeigen
  const alle = state.wallet.vouchers.filter(v => !istRabatt(v) && (v.balance == null || v.balance > 0));
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
      <div class="schenk-gruppe">
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

  const host = seite.el.querySelector('.wseite-inhalt');
  host.innerHTML = `
    <p class="gw-frage">Welchen Gutschein möchtest du verschenken?</p>
    ${marken.length > 1 ? `<div class="gw-marken" data-kein-wisch role="toolbar" aria-label="Nach Marke filtern">
      <button class="gw-chip${!schenkFilter ? ' an' : ''}" type="button" data-sf="">Alle</button>
      ${marken.map(m => `<button class="gw-chip${schenkFilter === m ? ' an' : ''}" type="button" data-sf="${esc(m)}">
        ${brandChipHtml(m)}<span>${esc(m)}</span></button>`).join('')}
    </div>` : ''}
    <div class="gw-sortierung" role="tablist" aria-label="Sortieren" style="--i:${schenkSort === 'hoch' ? 1 : 0}">
      <span class="gw-flaeche" aria-hidden="true"></span>
      <button class="gw-sort${schenkSort === 'niedrig' ? ' an' : ''}" type="button" role="tab" aria-selected="${schenkSort === 'niedrig'}" data-ss="niedrig">Kleinster Rest</button>
      <button class="gw-sort${schenkSort === 'hoch' ? ' an' : ''}" type="button" role="tab" aria-selected="${schenkSort === 'hoch'}" data-ss="hoch">Größter Rest</button>
    </div>
    <div class="wallet-list gw-liste">${inhalt || '<p class="gp-leer">Kein Gutschein mit Guthaben.</p>'}</div>`;

  host.querySelectorAll('[data-sf]').forEach(b => b.onclick = () => { schenkFilter = b.dataset.sf; schenkSicht = 12; buzz(6); zeichneSchenkAuswahl(seite); });
  host.querySelectorAll('[data-ss]').forEach(b => b.onclick = () => {
    if (schenkSort === b.dataset.ss) return;
    schenkSort = b.dataset.ss; schenkSicht = 12; buzz(6);
    // Erst die Flaeche gleiten lassen, dann neu sortieren
    host.querySelector('.gw-sortierung').style.setProperty('--i', schenkSort === 'hoch' ? 1 : 0);
    host.querySelectorAll('.gw-sort').forEach(x => x.classList.toggle('an', x === b));
    setTimeout(() => { if (wseiten().includes(seite)) zeichneSchenkAuswahl(seite); }, wseiteBewegt() ? 180 : 0);
  });
  host.querySelectorAll('[data-schenk-marke]').forEach(b => b.onclick = () => { schenkFilter = b.dataset.schenkMarke; schenkSicht = 12; zeichneSchenkAuswahl(seite); });
  host.querySelector('[data-schenk-mehr]')?.addEventListener('click', () => { schenkSicht += 12; zeichneSchenkAuswahl(seite); });
  host.querySelectorAll('[data-wv]').forEach(el => el.onclick = () => {
    const v = state.wallet.vouchers.find(x => x.id === el.dataset.wv);
    if (v) zeigeSchenkSchritt(v);
  });
  // Die gewaehlte Marke ins Bild holen, falls die Reihe weiter reicht
  host.querySelector('.gw-chip.an')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}
$('#wa-schenken')?.addEventListener('click', () => {
  if (walletGesperrt()) { aktualisiereSperre(); return; }
  if (!state.token) { island('Zum Verschenken bitte anmelden'); return; }
  const offen = state.wallet.vouchers.filter(v => !istRabatt(v) && (v.balance == null || v.balance > 0));
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
    saveWalletFilter();
    menu.classList.add('hidden');
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
}

// ---------------- Chat: Fluestern mit Freunden ----------------

let chatEmotes = {};
let chatBadges = {};
let chatPaints = [];
let chatRanks = [];

const CHAT_COLORS = ['#e91e63', '#9c27b0', '#3f51b5', '#03a9f4', '#009688', '#4caf50', '#ff9800', '#f44336', '#8d6e63', '#607d8b'];
function chatColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CHAT_COLORS[h % CHAT_COLORS.length];
}
// Namens-Paint überall gleich: liefert Klasse+Style für einen gemalten Namen,
// Fallback ist die stabile Chat-Farbe
function nameStyleOf(name, paintId) {
  const pnt = paintId ? (paintById(paintId) || chatPaints.find(x => x.id === paintId)) : null;
  if (!pnt) return { cls: '', style: `color:${chatColor(name)}` };
  const dec = paintDecor(pnt);
  return { cls: ' paint' + dec.cls, style: `--paint:${pnt.css}; color:${pnt.fallbackColor}; ${dec.style}` };
}
// Alle bekannten Emote-Quellen in einer Map: Chat-Basisset + ziehbare Emotes
// + Sticker (Sticker SIND Emotes und im Chat nutzbar, wenn gezogen)
function allEmoteIds() {
  const map = { ...chatEmotes };
  for (const [n, v] of Object.entries(gami?.emotesAll || {})) map[n] = v.id;
  for (const [n, v] of Object.entries(gami?.stickersAll || {})) map[n] = v.id;
  return map;
}
function emoteOwned(name) {
  const drawable = (gami?.emotesAll || {})[name] || (gami?.stickersAll || {})[name];
  if (!drawable) return true; // Basisset ohne Ziehung
  return (gami?.emotes || []).includes(name) || (gami?.stickers || []).includes(name);
}
function emoteHtml(name) {
  const id = allEmoteIds()[name] || chatEmotes[name];
  return `<img class="emote" src="https://cdn.7tv.app/emote/${id}/2x.webp" alt="${esc(name)}" title="${esc(name)}" loading="lazy">`;
}
function withEmotes(escapedText) {
  let t = escapedText;
  for (const name of Object.keys(allEmoteIds())) {
    t = t.replace(new RegExp(`\\b${name}\\b`, 'g'), emoteHtml(name));
  }
  return t;
}
// "…" zum Löschen eigener Nachrichten (Web: beim Drüberfahren, Handy: gedrückt halten)
function msgMenuHtml(own, id) {
  return own ? `<button class="msg-menu" data-msg-del="${esc(id)}" aria-label="Nachricht löschen">…</button>` : '';
}
// Chat-Modi: Liste der Gespraeche oder ein einzelner Fluesterchat
let chatMode = 'dmlist';
let dmPartner = '';
let dmLastTs = 0;

function setChatMode(mode, partner) {
  const vorherMode = chatMode;
  chatMode = mode;
  dmPartner = partner || '';
  dmLastTs = 0;
  $('#chat-list').innerHTML = '';
  // Die Liste schiebt in die Richtung herein, in die man geht: in einen Chat
  // hinein von rechts, zurueck zur Liste von links.
  const rang = { dmlist: 1, dm: 2 };
  if (vorherMode && vorherMode !== mode) {
    const box = $('#chat-box');
    box.classList.remove('kommt-links', 'kommt-rechts');
    void box.offsetWidth;
    box.classList.add(rang[mode] > rang[vorherMode] ? 'kommt-rechts' : 'kommt-links');
  }
  $('#dm-head').classList.toggle('hidden', mode !== 'dm');
  $('#chat-titel')?.classList.toggle('hidden', mode === 'dm');
  $('#chat-input-row').style.display = mode === 'dmlist' ? 'none' : 'flex';
  if (mode === 'dm') {
    $('#dm-partner-name').textContent = dmPartner;
    // Profilbild + Namens-Paint der Person im Chat-Kopf
    $('#dm-partner-ava').innerHTML = `<span class="avatar-mini" style="background:${chatColor(dmPartner)}">${esc(dmPartner[0].toUpperCase())}</span>`;
    api('/api/user?name=' + encodeURIComponent(dmPartner)).then(u => {
      const pb = u.activeBorder ? ` pfb-${u.activeBorder}` : '';
      if (u.avatar) $('#dm-partner-ava').innerHTML = `<img class="avatar-mini avatar-img${pb}" src="${sichereBildUrl(u.avatar)}" alt="">`;
      else if (pb) $('#dm-partner-ava').querySelector('.avatar-mini')?.classList.add('pfb-' + u.activeBorder);
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

function dmMsgHtml(m) {
  const own = m.from === state.userName;
  // Absender und Zeit stehen am Element: chatGruppieren() fasst danach
  // aufeinanderfolgende Nachrichten derselben Person zusammen
  const daten = `data-mid="${esc(m.id)}" data-from="${esc(m.from)}" data-ts="${Number(m.ts) || 0}"`;
  if (m.deleted) {
    const dns = nameStyleOf(m.from, m.paint);
    return `<div class="chat-msg dm-${own ? 'me' : 'them'}" ${daten}>
      <span class="chat-kopf"><span class="chat-user${dns.cls}" style="${dns.style}">${esc(m.from)}</span></span>
      <span class="chat-text chat-deleted">Nachricht gelöscht</span>
    </div>`;
  }
  // Rang-Icon, Badge/Rolle und Namens-Paint stehen auch im Privatchat
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
  return `<div class="chat-msg dm-${own ? 'me' : 'them'} ${own ? 'own' : ''}" ${daten}>
    <span class="chat-kopf">
      ${rankImg}${badge || role}<span class="chat-user${ns.cls}" style="${ns.style}">${esc(m.from)}</span>
    </span>
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

async function pollChat(force) {
  // Ausserhalb des Chats wird nur noch die Zahl ungelesener Nachrichten
  // nachgesehen. Frueher lief hier alle vier Sekunden der ganze Global-Chat
  // mit — auch wenn man ihn gar nicht offen hatte.
  if (!force && state.activeView !== 'chat') { refreshDmBadge(); return; }
  try {
    if (chatMode === 'dmlist') {
      if (!state.token) { $('#chat-list').innerHTML = '<div class="status">Zum Flüstern bitte anmelden.</div>'; return; }
      const r = await api('/api/dm/list');
      // Profilbild mit dem gewaehlten Rahmen (pfb-…), sonst der Anfangsbuchstabe
      const ava = (name, avatar, border) => {
        const pb = border ? ` pfb-${esc(border)}` : '';
        return avatar
          ? `<img class="avatar-mini avatar-img${pb}" src="${sichereBildUrl(avatar)}" alt="">`
          : `<span class="avatar-mini${pb}" style="background:${chatColor(name)}">${esc(name[0].toUpperCase())}</span>`;
      };
      // Letzte Nachricht als Vorschau: ein geteilter Deal ohne das [deal:…]-Kuerzel
      const vorschau = t => {
        const dl = String(t || '').match(/^\[deal:[a-z0-9]+\]\s*(.*)$/i);
        if (dl) return `${icon('tag', 'icon dm-row-ico')}${esc(dl[1] || 'Deal')}`;
        return t ? esc(t) : '<i>Nachricht gelöscht</i>';
      };
      const rows = r.list.map(c => `
        <button class="dm-row${c.unread ? ' ungelesen' : ''}" data-dm-open="${esc(c.partner)}">
          ${ava(c.partner, c.avatar, c.border)}
          <span class="dm-row-main">
            <span class="dm-row-name">${esc(c.partner)}</span>
            <span class="dm-row-last">${vorschau(c.lastText)}</span>
          </span>
          <span class="dm-row-seite">
            ${c.lastTs ? `<span class="dm-row-zeit">${esc(timeAgo(c.lastTs))}</span>` : ''}
            ${c.unread ? `<span class="dm-unread-pill">${c.unread}</span>` : ''}
          </span>
        </button>`).join('');
      const friendRows = (r.friends || []).map(f => `
        <button class="dm-row" data-dm-open="${esc(f.name)}">
          ${ava(f.name, f.avatar, f.border)}
          <span class="dm-row-main"><span class="dm-row-name">${esc(f.name)}</span>
          <span class="dm-row-last">Freund, noch kein Chat</span></span>
          ${icon('chevron', 'icon dm-row-pfeil')}
        </button>`).join('');
      // Laufende Gespraeche zuerst, darunter abgesetzt die Freunde, mit denen
      // man noch nicht geschrieben hat. Jede Gruppe ist eine weisse Karte.
      $('#chat-list').innerHTML = (rows || friendRows)
        ? (rows ? `<div class="dm-gruppe">${rows}</div>` : '')
          + (friendRows ? `<div class="dm-trenner">Freunde</div><div class="dm-gruppe">${friendRows}</div>` : '')
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
        showNoteBanner(`<b>@${esc(conv.partner)}</b>: ${esc(conv.lastText)}`, () => {
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
  try {
    const r = await api('/api/dm/send', { method: 'POST', body: JSON.stringify({ to: dmPartner, text }) });
    inp.value = '';
    // Admin-Befehl (!funken): wird nicht verschickt, nur bestaetigt
    if (r.admin) { island(r.admin); refreshGami(); refreshGamiSystem(); return; }
    if (!$('#chat-list').querySelector(`[data-mid="${r.message.id}"]`)) {
      $('#chat-list').insertAdjacentHTML('beforeend', dmMsgHtml(r.message));
      $('#chat-list').lastElementChild?.classList.add('msg-sent');
      chatGruppieren();
    }
    dmLastTs = Math.max(dmLastTs, r.message.ts);
    chatToBottom(true);
  } catch (e) { island(e.message); }
}

// ---- Nutzer-Profil: eigene Seite (ersetzt das alte Popup)
let userPageReturn = 'feed';
async function openUserPop(user, msgId) {
  if (user === state.userName) { switchView('profile'); return; }
  if (state.activeView !== 'user') userPageReturn = state.activeView;
  const pop = $('#user-page');
  pop.innerHTML = '<div class="status">Lade Profil …</div>';
  switchView('user', 'enter-drop');
  let u = { user };
  try { u = await api('/api/user?name=' + encodeURIComponent(user)); } catch { }
  const isFriend = (myProfile?.friends || []).includes(user);
  const favLogo = v => BRAND_DOMAINS[String(v || '').toLowerCase()]
    ? `<span class="fav-logo">${brandChipHtml(v)}<small>${esc(v)}</small></span>`
    : `<span class="pill">${esc(v)}</span>`;
  const ns = nameStyleOf(user, u.activePaint);
  pop.innerHTML = `
    <div class="up-hero">
      ${u.avatar ? `<img class="avatar-big up-ava${u.activeBorder ? ' pfb-' + esc(u.activeBorder) : ''}" src="${sichereBildUrl(u.avatar)}" alt="">`
        : `<span class="avatar-big up-ava${u.activeBorder ? ' pfb-' + esc(u.activeBorder) : ''}" style="background:${chatColor(user)}">${esc(user[0].toUpperCase())}</span>`}
      <div class="up-name"><span class="${ns.cls.trim()}" style="${ns.style}">${esc(user)}</span> ${u.role === 'admin' ? icon('crown', 'icon icon-sm role-admin') : u.role === 'mod' ? icon('check', 'icon icon-sm role-mod') : ''}</div>
      <div class="up-bio">${u.private ? 'Profil ist privat' : esc(u.bio || 'Keine Bio')}</div>
    </div>
    ${!u.private && u.favs && Object.values(u.favs).some(Boolean) ? `
    <div class="favs-view up-center">
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
    <div class="form-row up-actions" style="margin-top:14px; flex-wrap:wrap; justify-content:center">
      <button class="btn btn-small" id="up-whisper">Flüstern</button>
      <button class="btn btn-small btn-ghost" id="up-friend">${isFriend ? 'Freund entfernen' : 'Freundschaftsanfrage'}</button>
      <button class="btn btn-small btn-ghost" id="up-report">Melden</button>
    </div>
    <div id="up-ratings"></div>`;
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
    return `
    <div class="up-rate-row">
      ${c.avatar ? `<img class="avatar-mini avatar-img${c.border ? ' pfb-' + esc(c.border) : ''}" src="${sichereBildUrl(c.avatar)}" alt="">`
      : `<span class="avatar-mini${c.border ? ' pfb-' + esc(c.border) : ''}" style="background:${chatColor(c.from)}">${esc(c.from[0].toUpperCase())}</span>`}
      <div class="up-rate-body">
        <div><span class="chat-user${cns.cls}" style="${cns.style}">${esc(c.from)}</span> ${starRow(c.stars, false)} <span class="comment-time">${esc(timeAgo(c.ts))}</span></div>
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
function toggleEmotes() {
  const el = $('#chat-emotes');
  // Box macht Platz, damit die letzten Nachrichten sichtbar bleiben
  const opening = el.classList.contains('hidden');
  $('#view-chat').classList.toggle('emotes-open', opening);
  if (opening) {
    // ALLE Emotes zeigen: Gezogene normal, der Rest grau mit Schloss.
    // Antippen eines gesperrten Emotes gibt eine kleine Fehler-Animation.
    const names = Object.keys(allEmoteIds());
    const sorted = [...names.filter(n => emoteOwned(n)), ...names.filter(n => !emoteOwned(n))];
    el.innerHTML = sorted.length
      ? sorted.map(n => {
        const owned = emoteOwned(n);
        return `<button class="emote-pick ${owned ? '' : 'emote-locked'}" data-emote="${esc(n)}" data-owned="${owned ? 1 : 0}" aria-label="${esc(n)}${owned ? '' : ' (noch nicht gezogen)'}">
          ${emoteHtml(n)}${owned ? '' : `<span class="emote-lock">${icon('lock', 'icon')}</span>`}
        </button>`;
      }).join('')
      : '<span class="form-msg">Emotes laden …</span>';
    el.classList.remove('hidden');
    // Nachrichten nachziehen: die letzten bleiben beim Schreiben sichtbar
    setTimeout(() => { const box = $('#chat-box'); box.scrollTop = box.scrollHeight; }, 320);
    el.querySelectorAll('[data-emote]').forEach(b => b.onclick = () => {
      if (b.dataset.owned !== '1') {
        b.classList.remove('shake');
        void b.offsetWidth; // Animation neu anstossen
        b.classList.add('shake');
        buzz([25, 30, 25]);
        island('Du hast dieses Emote noch nicht');
        return;
      }
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
  es.addEventListener('gift', () => pullWallet()); // Geschenk kommt sofort an
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
  const text = 'Komm zu kumulio: Deals, Preisfehler-Alarm und deine Gutschein-Wallet in einer App. Über meinen Link bekommst du 500 Funken zum Start.';
  if (navigator.share) { navigator.share({ title: 'kumulio', text, url }).catch(() => { }); return; }
  copyInvite();
}
function copyInvite() {
  navigator.clipboard.writeText(inviteUrl())
    .then(() => { island('Einladungslink kopiert'); playSfx('plop'); })
    .catch(() => island(inviteUrl()));
}
// Eigene Seite: erklaert das Programm, zeigt den Link und die eigene Bilanz
async function renderInvitePage() {
  const host = $('#invite-page');
  if (!host) return;
  if (!state.token) {
    host.innerHTML = '<div class="status">Zum Einladen bitte anmelden.</div>';
    return;
  }
  await refreshGami(); // frischer Werbe-Zaehler
  const n = myProfile?.refCount || 0;
  const verdient = n * 1000;
  host.innerHTML = `
    <div class="inv-hero">
      <div class="inv-hero-icons">
        <span class="inv-chip">${funkeIcon()}</span>
        <span class="inv-plus">+</span>
        <span class="inv-chip">${icon('user', 'icon')}</span>
      </div>
      <b>Bring deine Leute mit</b>
      <span>Für jeden Freund, der sich über deinen Link anmeldet, bekommst du 1.000 Funken.
        Dein Freund startet mit 500 Funken. So oft du magst, ohne Limit.</span>
    </div>

    <div class="inv-stats">
      <div class="inv-stat">
        <b>${n}</b>
        <span>${n === 1 ? 'Freund geworben' : 'Freunde geworben'}</span>
      </div>
      <div class="inv-stat">
        <b>${funkeIcon(true)} ${fmtFunken(verdient)}</b>
        <span>dadurch verdient</span>
      </div>
    </div>

    <h3 class="gm-h">Dein Einladungslink</h3>
    <div class="inv-link" id="inv-link-box" role="button" aria-label="Link kopieren">
      <span class="inv-link-text">${esc(inviteUrl())}</span>
      ${icon('list', 'icon icon-sm')}
    </div>
    <div class="form-row" style="margin-top:10px">
      <button class="btn btn-big" id="inv-share">${icon('share', 'icon icon-sm')} Link teilen</button>
      <button class="btn btn-small btn-ghost" id="inv-copy">Kopieren</button>
    </div>

    <h3 class="gm-h">So läuft es</h3>
    <div class="inv-steps">
      <div class="inv-step"><b>1</b><span>Link teilen, per WhatsApp, Story oder wie du magst.</span></div>
      <div class="inv-step"><b>2</b><span>Dein Freund öffnet ihn und legt ein kostenloses Konto an.</span></div>
      <div class="inv-step"><b>3</b><span>Sofort danach: 1.000 Funken für dich, 500 für deinen Freund.</span></div>
    </div>

    <div class="inv-note">
      ${icon('bulb', 'icon icon-sm')}
      <span>Funken gibt es nur fürs Mitmachen, nie für Echtgeld. Mit ihnen holst du dir Container
        mit Emotes, Paints, Stickern und Profilrahmen. Mehrfach-Konten zählen nicht.</span>
    </div>`;
  $('#inv-share').onclick = shareInvite;
  $('#inv-copy').onclick = copyInvite;
  $('#inv-link-box').onclick = copyInvite;
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
function bioAn() { return !!lsJson(bioSchluessel(), null); }
async function bioEinrichten() {
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
  } catch { island('Face ID / Fingerabdruck ließ sich nicht einrichten'); return false; }
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
  // Nicht nur ein Vorhang: darunter ist nichts bedien- oder per Tastatur erreichbar
  for (const sel of ['#wallet-kopf', '#wallet-content', '#coupons-content', '#wallet-gate', '#wallet-mini', '#wallet-modes']) {
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
  // Gutschein-, Verschenken- und Analyse-Seiten: sofort weg, samt Inhalt
  wseitenZu();
  if (state.sheetMode) closeSheet();
  // Das zugeklappte Blatt behaelt sonst Code, PIN und Knoepfe im Baum
  const inhalt = $('#sheet-content');
  if (inhalt) inhalt.innerHTML = '';
  document.querySelector('.karten-lupe .lupe-grund')?.click();
  if (bildOffen) bildOffen.querySelector('.bl-zu')?.click();
  document.querySelectorAll('.gift-overlay').forEach(x => x.remove());
  document.querySelectorAll('.cc-big').forEach(x => (x.closest('.overlay') || x).remove());
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
  if (ok) { sperrBeschaeftigt = false; return entsperreWallet(); }
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
function entsperreWallet() {
  walletEntsperrt = true;
  sperrEingabe = '';
  sperrBeschaeftigt = false;
  lsSetzen(PIN_FEHL_KEY, JSON.stringify({ n: 0, bis: 0 }));
  const el = $('#wallet-sperre');
  const sichtbar = el && !el.classList.contains('hidden') && !el.classList.contains('geht');
  setTimeout(() => pruefeNeuigkeiten(), 1000); // Update-Log wartete auf das Entsperren
  setTimeout(verarbeiteGeteiltes, 700);          // geteiltes Bild wartete auch
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
  playSfx('plop', .4);
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
  const coupons = walletTab === 'coupons';
  const teile = [
    $('.balance-flip-btn'),
    $('.wk-sprite'),
    ...document.querySelectorAll('.wallet-aktionen .wa-btn'),
    $('#wallet-modes'),
    ...(coupons
      ? [...$('#coupons-content').children].slice(0, 6)
      : [$('#pin-empfehlung:not(.hidden)'), $('.wallet-tools'), $('#zuletzt-verwendet:not(.hidden)'),
        $('#wallet-content .bereich-zeile'), ...[...$('#voucher-list').children].slice(0, 6)]),
  ].filter(Boolean);
  teile.forEach((el, i) => {
    el.style.setProperty('--ad', Math.min(i * 45, 460) + 'ms');
    neuStarten(el, 'auftritt');
  });
  setTimeout(() => teile.forEach(el => { el.classList.remove('auftritt'); el.style.removeProperty('--ad'); }), 1300);
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
$('#ws-tasten')?.addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.z != null) sperrTaste(b.dataset.z);
  else if (b.dataset.weg) sperrZurueck();
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
  wrap.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) { if (e.target === wrap) zu(); return; }
    if (b.closest('.pin-schritt.raus')) return;
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
  const bioOk = pinGesetzt() && await bioVerfuegbar();
  const pin = pinGesetzt();
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
    ${bioOk ? `<div class="settings-row">
      <div class="settings-label"><b>Face ID / Fingerabdruck</b><span>Wallet ohne PIN-Eingabe entsperren</span></div>
      <label class="switch"><input type="checkbox" id="si-bio" ${bioAn() ? 'checked' : ''}><span class="switch-slider"></span></label>
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
      if (pin === null || !await bioEinrichten()) e.target.checked = false;
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
        <span>${e.typ === 'karte' ? 'Sparkarte' : e.art === 'rabatt' ? 'Rabattcode' : (e.amount != null ? euroFmt(e.amount) : 'Gutschein')}${e.balance != null && e.typ !== 'karte' ? ' · Rest ' + euroFmt(e.balance) : ''}
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
    if (!v || istRabatt(v) || !(v.balance == null || v.balance > 0)) continue;
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
    if (state.sheetMode === 'wallet-add' && waHandleImage) {
      waHandleImage(dateien[0]);
      if (geteiltSchlange.length) island(`Bild 1 von ${dateien.length}: prüfen und speichern, dann kommt das nächste`, 4200);
    }
    return;
  }
  // Nur Text: als Rabattcode vorschlagen
  openWalletAdd('rabatt');
  if (state.sheetMode !== 'wallet-add') return;
  const code = detectCode(text);
  if (code && $('#wa-rcode')) $('#wa-rcode').value = code.slice(0, 40);
  const low = text.toLowerCase();
  const tile = [...document.querySelectorAll('#wa-vendor-grid [data-vg]')]
    .find(t => !ANDERE_SHOPS.has(t.dataset.vg) && low.includes(t.dataset.vg.toLowerCase()));
  if (tile) { if (tile.classList.contains('vendor-more')) $('#wa-vendor-showmore')?.click(); tile.click(); }
  if ($('#wa-notiz')) $('#wa-notiz').value = text.replace(/\s+/g, ' ').trim().slice(0, 80);
  const m = $('#wa-ai-msg');
  if (m) { m.className = 'form-msg ok'; m.textContent = code ? 'Code aus dem geteilten Text übernommen, bitte kurz prüfen.' : 'Kein Code erkannt, bitte selbst eintragen.'; }
}

// ---------------- Neu in kumulio (Update-Log) ----------------
// Nach jedem Update sieht jedes Konto EINMAL, was neu ist. Gemerkt wird das am
// Konto (neuGesehen), damit es auf dem zweiten Geraet nicht nochmal kommt —
// dazu lokal als Rueckfallebene, falls das Melden ans Konto gerade nicht klappt.
// Neue Konten starten beim aktuellen Stand und sehen erst das naechste Update.
// Inhalt: public/neuigkeiten.json (bei jedem Update oben einen Eintrag ergaenzen).
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
            <span class="neu-txt"><b>${esc(pt.titel || '')}</b><span>${esc(pt.text || '')}</span></span>
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
  // Emotes, Badges, Paints und Ränge früh laden, damit Profile und Chats sie kennen
  api('/api/meta').then(r => {
    chatEmotes = r.emotes || {};
    chatBadges = r.badges || {};
    chatPaints = r.paints || chatPaints;
    chatRanks = r.ranks || chatRanks;
    if (r.walletLimit) { Object.assign(WALLET_LIMIT, r.walletLimit); if (state.activeView === 'wallet') renderWallet(); }
  }).catch(() => { });
  if (state.token) {
    pullWallet(); // parallel statt hinter /api/me: Guthaben ist schneller aktuell
    api('/api/me').then(r => { kontoInfo = r; state.userName = r.user; state.role = r.role || ''; refreshProfileTab(); refreshAdminUi(); pinKontoUebernehmen(r); renderWallet(); pruefeNeuigkeiten(); })
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
