// RabattArchiv – lokaler Server (keine Abhängigkeiten, Node >= 18)
// Echte Deals per mydealz-RSS, Community-Posts + Kommentare als JSON auf Platte.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Hosting: PORT kommt vom Anbieter (Railway/Render/...), Datenverzeichnis
// per RA_DATA_DIR auf ein persistentes Volume legen
const PORT = Number(process.env.PORT) || 3900;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.RA_DATA_DIR || path.join(ROOT, 'data');

// ---------------------------------------------------------------- Kanäle

// type 'rss'  = automatisch bespielt (niemand postet, Community kommentiert nur)
// type 'community' = Nutzer-Posts erlaubt (Scam-Filter + Warnhinweis)
// rules = "Regeln & Richtlinien", die in der Detail-Ansicht jedes Beitrags stehen
const COMMUNITY_RULES = [
  'Beiträge kommen von Nutzern, nicht von RabattArchiv – alles auf eigene Gefahr.',
  'Nur legale Angebote. Referral-Links müssen als solche erkennbar sein.',
  'Niemals Vorkasse leisten oder per PayPal „Freunde & Familie" an Fremde zahlen.',
  'Scam-Filter und Moderation prüfen jeden Beitrag, ersetzen aber nicht den eigenen Verstand.',
];
// Alle Inhalte werden von der Redaktion gepostet – keine automatischen Feeds mehr
const BUILTIN_CHANNELS = [
  { slug: 'angebote', name: 'Angebote', icon: 'star', type: 'community', desc: 'Rabattcodes, Gratis-Testphasen und öffentliche Aktionen – handverlesen.',
    rules: ['Angebote prüft die Redaktion – Konditionen können sich beim Anbieter ändern.', 'Gratis-Testphasen rechtzeitig kündigen, wenn du nicht verlängern willst.', 'RabattArchiv verkauft nichts – die Aktion läuft direkt beim Anbieter.'] },
  { slug: 'preisfehler', name: 'Preisfehler', icon: 'bolt', type: 'community', desc: 'Vermutete Preisfehler – schnell sein lohnt sich.',
    rules: ['Preisfehler sind nie garantiert – Händler dürfen Bestellungen stornieren.', 'Kein Anspruch auf Lieferung zum Fehlerpreis.', 'Am besten per Gast-Bestellung und ohne Zusatzkäufe bestellen.'] },
  { slug: 'geld-verdienen', name: 'Geld verdienen', icon: 'banknote', type: 'community', desc: 'Referral-Codes und Prämien.', rules: COMMUNITY_RULES },
  { slug: 'methoden', name: 'Methoden', icon: 'bulb', type: 'community', desc: 'Spar-Tricks aus dem Alltag – legal und erklärt.', rules: COMMUNITY_RULES },
];

// ---------------------------------------------------------------- Storage

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); }
  catch { return fallback; }
}
function saveJson(file, obj) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, file), JSON.stringify(obj, null, 2));
}

let comments = loadJson('comments.json', {});   // { dealId: [ {user,text,ts,flags} ] }
let ratings = loadJson('ratings.json', {});     // { dealId: {up, down, clicks} }
let users = loadJson('users.json', {});         // { username: {hash, salt, ts} }
let sessions = loadJson('sessions.json', {});   // { token: username }
let featured = loadJson('featured.json', []);   // Startseiten-Kacheln des Admins

// Admin-Schlüssel: wird beim ersten Start erzeugt und in data/admin-key.txt abgelegt
let ADMIN_KEY;
try { ADMIN_KEY = fs.readFileSync(path.join(DATA, 'admin-key.txt'), 'utf8').trim(); }
catch {
  ADMIN_KEY = crypto.randomBytes(9).toString('base64url');
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'admin-key.txt'), ADMIN_KEY);
}

function hashPass(pass, salt) { return crypto.scryptSync(pass, salt, 32).toString('hex'); }

// Cloudflare Turnstile (etablierter Captcha-Dienst).
// Standard: die offiziellen Turnstile-TEST-Keys (bestehen immer, zeigen das echte Widget).
// Für den Live-Betrieb eigene Keys unter https://dash.cloudflare.com → Turnstile anlegen
// und in data/turnstile.json eintragen: { "sitekey": "...", "secret": "..." }
let TURNSTILE = loadJson('turnstile.json', null);
if (!TURNSTILE) {
  TURNSTILE = { sitekey: '1x00000000000000000000AA', secret: '1x0000000000000000000000000000000AA', testKeys: true };
  saveJson('turnstile.json', TURNSTILE);
}
async function verifyTurnstile(token) {
  if (!token) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${encodeURIComponent(TURNSTILE.secret)}&response=${encodeURIComponent(token)}`,
    });
    const j = await r.json();
    return !!j.success;
  } catch { return false; }
}
function authUser(req) {
  const t = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  return (t && sessions[t]) || null;
}
function isAdmin(req) { return String(req.headers['x-admin-key'] || '') === ADMIN_KEY; }
let compareCache = loadJson('compare.json', {}); // { query: {ts, price, priceNum, url, name} | {ts, miss} }
let posts = loadJson('posts.json', {});         // { channelSlug: [ {id,user,title,text,ts,flags} ] }
let customChannels = loadJson('channels.json', []); // [ {slug,name,emoji,type:'community',desc,createdTs} ]

function allChannels() {
  // Eigene Kanäle bekommen immer das Standard-Icon und die Community-Regeln
  return [...BUILTIN_CHANNELS, ...customChannels.map(c => ({ icon: 'tag', rules: COMMUNITY_RULES, ...c, emoji: undefined }))];
}
function findChannel(slug) { return allChannels().find(c => c.slug === slug); }

// ---------------------------------------------------------------- Scam-Filter / Moderation
// Zweistufig: BLOCK verhindert den Post, WARN markiert ihn sichtbar.
// Hier würde später ein KI-Moderator (Claude-API) einhaken – die Regeln bleiben als schnelle Vorstufe.

const BLOCK_PATTERNS = [
  /vorkasse/i,
  /western\s*union/i, /moneygram/i,
  /paypal\s*(freunde|f\s*&\s*f|family|famil)/i,
  /geld\s*verdoppel/i, /verdopp(le|el)\s*(dein|euer)\s*geld/i,
  /crypto[-\s]?giveaway/i, /gratis\s*bitcoin/i,
  /schick\s*(mir)?\s*(deine)?\s*iban/i,
  /(kaufe|verkaufe)\s*(geschenk)?gutschein(karten)?/i,
  /anydesk|teamviewer.*fernzugriff/i,
];
const WARN_PATTERNS = [
  { re: /t\.me\/|telegram/i, tag: 'Telegram-Link' },
  { re: /wa\.me\/|whatsapp/i, tag: 'WhatsApp-Kontakt' },
  { re: /\bdm\s*(mir|me)\b|schreib\s*mir\s*privat/i, tag: 'Privatkontakt' },
  { re: /https?:\/\//i, tag: 'Externer Link – auf eigene Gefahr' },
  { re: /referral|reflink|werbe.?code|einladungs.?code/i, tag: 'Referral' },
];

function moderate(text) {
  for (const re of BLOCK_PATTERNS) {
    if (re.test(text)) return { blocked: true, reason: 'Der Beitrag wurde vom Scam-Filter blockiert (verdächtiges Muster: Vorkasse/Gutschein-Handel/Geld-Versprechen o. ä.).' };
  }
  const flags = [];
  for (const w of WARN_PATTERNS) if (w.re.test(text)) flags.push(w.tag);
  return { blocked: false, flags: [...new Set(flags)] };
}

// ---------------------------------------------------------------- RSS holen + parsen

const feedCache = {}; // slug -> { ts, deals } | { ts, error }
const CACHE_MS = 5 * 60 * 1000;

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`));
  return m ? decodeEntities(m[1]).trim() : '';
}

function parseRss(xml, channelSlug) {
  const items = xml.split(/<item[\s>]/).slice(1);
  return items.map(raw => {
    let title = tag(raw, 'title');
    const link = (tag(raw, 'link') || tag(raw, 'guid')).split('?')[0];
    const pubDate = tag(raw, 'pubDate');
    const descHtml = tag(raw, 'description');
    // mydealz-Temperatur-Präfix ("103° - …") abschneiden – zeigen wir nicht an
    title = title.replace(/^-?\d+°\s*-\s*/, '');
    // Händler + Preis liefert mydealz sauber als Attribute mit
    const pm = raw.match(/<pepper:merchant\s+name="([^"]*)"(?:\s+price="([^"]*)")?/);
    const merchant = pm ? decodeEntities(pm[1]) : '';
    const price = pm && pm[2] ? decodeEntities(pm[2]) : '';
    const category = tag(raw, 'category');
    // Bilder: media:content + alle <img> aus der Beschreibung (dedupliziert, max. 6)
    const images = [];
    const mm = raw.match(/<media:content[^>]*url="([^"]+)"/);
    if (mm) images.push(decodeEntities(mm[1]));
    for (const im of descHtml.matchAll(/<img[^>]*src="([^"]+)"/g)) {
      const u = decodeEntities(im[1]);
      if (!images.includes(u)) images.push(u);
    }
    images.length = Math.min(images.length, 6);
    const image = images[0] || '';
    // Direkter Deal-Link: erster Link in der Beschreibung, der NICHT zu mydealz führt.
    // Nur wenn es keinen gibt, fällt der CTA auf die mydealz-Seite zurück.
    const hrefs = [...decodeEntities(descHtml).matchAll(/<a[^>]*href="([^"]+)"/g)].map(m => m[1]);
    const dealUrl = hrefs.find(u => /^https?:\/\//.test(u) && !/mydealz\.de|pepper\.com/.test(u)) || '';
    // Beschreibung: "Preis - Händler"-Vorspann raus (steht schon im Badge),
    // Tags raus – mydealz schneidet die Beschreibung teils mitten im Tag ab
    const text = decodeEntities(descHtml)
      .replace(/^<strong>[^<]*<\/strong>/, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/<[^>]*$/, '')
      .replace(/\s+/g, ' ').trim();
    // Ersparnis erkennen: "statt X€" im Titel/Text, explizite Prozente, Gratis-Deals
    const priceNum = price ? parseFloat(price.replace(/\./g, '').replace(',', '.')) : null;
    let discount = null, origPrice = '';
    const orig = (title + ' ' + text).match(/statt\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*€/i);
    if (orig && priceNum) {
      const o = parseFloat(orig[1].replace(',', '.'));
      if (o > priceNum) {
        discount = Math.round((1 - priceNum / o) * 100);
        origPrice = orig[1].replace('.', ',') + '€';
      }
    }
    if (discount === null) {
      const pm2 = title.match(/[-−–]\s?(\d{1,3})\s?%|(\d{1,3})\s?%\s?(?:rabatt|off)/i);
      if (pm2) discount = Number(pm2[1] || pm2[2]);
    }
    if (discount !== null && (discount < 1 || discount > 99)) discount = null;
    const free = priceNum === 0
      || /\bkostenlos|\bgratis|\bfreebie/i.test(title)
      || (channelSlug === 'freebies' && !priceNum);
    // Enddatum, falls der Deal eins nennt ("bis 09.08.", "gültig bis 12.09.26", "nur heute")
    let endTs = null;
    const em = (title + ' ' + text).match(/(?:bis|endet am|gültig bis|läuft bis)\s*(?:zum\s*)?(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?/i);
    if (em) {
      const y = em[3] ? (em[3].length === 2 ? 2000 + Number(em[3]) : Number(em[3])) : new Date().getFullYear();
      const dte = new Date(y, Number(em[2]) - 1, Number(em[1]), 23, 59, 59);
      if (!em[3] && dte.getTime() < Date.now() - 30 * 24 * 3600 * 1000) dte.setFullYear(y + 1);
      if (!isNaN(dte)) endTs = dte.getTime();
    } else if (/nur heute/i.test(title)) {
      const dte = new Date(); dte.setHours(23, 59, 59, 0); endTs = dte.getTime();
    }
    const id = crypto.createHash('md5').update(link || title).digest('hex').slice(0, 12);
    return {
      id, channel: channelSlug, title, image, images, price, merchant, category,
      discount, origPrice, free, endTs,
      dealUrl, sourceUrl: link,
      excerpt: text.slice(0, 500),
      ts: pubDate ? Date.parse(pubDate) : Date.now(),
      source: 'mydealz',
    };
  }).filter(d => d.title && d.sourceUrl);
}

async function getDeals(channel) {
  const cached = feedCache[channel.slug];
  if (cached && Date.now() - cached.ts < CACHE_MS) return cached;
  try {
    const res = await fetch(channel.feed, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) RabattArchiv-Prototyp/0.1', 'Accept': 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const deals = parseRss(xml, channel.slug);
    if (!deals.length) throw new Error('Feed leer / nicht lesbar');
    const entry = { ts: Date.now(), deals };
    feedCache[channel.slug] = entry;
    return entry;
  } catch (e) {
    // Fehler nur kurz cachen, damit ein Retry bald wieder greift
    const entry = { ts: Date.now() - CACHE_MS + 30_000, error: String(e.message || e), deals: cached?.deals || [] };
    feedCache[channel.slug] = entry;
    return entry;
  }
}

// Community-Posts im selben Deal-Format ausgeben; erster Link im Text wird zum CTA
function postsAsDeals(slug) {
  return (posts[slug] || []).map(p => {
    const discount = p.priceNum && p.compareNum && p.compareNum > p.priceNum
      ? Math.round((1 - p.priceNum / p.compareNum) * 100) : null;
    // Marke: explizit gesetzt oder aus dem Link abgeleitet (wolt.com -> Wolt)
    let merchant = p.merchant || '';
    if (!merchant) {
      const u = (p.text.match(/https?:\/\/[^\s"<>]+/) || [''])[0];
      try {
        const parts = new URL(u).hostname.split('.');
        const host = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
        if (host) merchant = host.charAt(0).toUpperCase() + host.slice(1);
      } catch { }
    }
    return {
      id: p.id, channel: slug, title: p.title, image: p.image || '', merchant,
      price: p.priceNum != null ? p.priceNum.toFixed(2).replace('.', ',') + '€' : '',
      origPrice: p.compareNum != null ? p.compareNum.toFixed(2).replace('.', ',') + '€' : '',
      discount, free: p.priceNum === 0, endTs: p.endTs || null,
      compareChecked: !!p.compareChecked,
      earn: slug === 'geld-verdienen',
      newCustomer: !!p.newCustomer,
      pick: true, // von der Redaktion gepostet
      dealUrl: (p.text.match(/https?:\/\/[^\s"<>]+/) || [''])[0], sourceUrl: '',
      excerpt: p.text, ts: p.ts, source: 'community', user: p.user, flags: p.flags || [],
    };
  });
}

// ---------------------------------------------------------------- Preisvergleich (billiger.de)
// idealo/geizhals blocken Server-Anfragen (403); billiger.de liefert die Suche
// serverseitig gerendert aus. Pro Suchbegriff wird der erste plausible Treffer
// (exakte Produktseite + "ab"-Preis) gecacht; Anfragen laufen gedrosselt.

const COMPARE_TTL = 12 * 3600 * 1000;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
let compareLastFetch = 0;

async function politeFetch(url) {
  const wait = Math.max(0, compareLastFetch + 800 - Date.now());
  compareLastFetch = Date.now() + wait;
  if (wait) await new Promise(r => setTimeout(r, wait));
  return fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'de-DE,de;q=0.9',
    },
    redirect: 'follow',
  });
}

function parsePriceNum(s) {
  return parseFloat(s.replace(/\./g, '').replace(',', '.'));
}

// Titel des Produkts direkt von der Händlerseite des Deals holen (og:title) –
// präziser als der Deal-Titel. Viele Shops (Amazon) blocken – dann Fallback.
async function resolveProductTitle(u) {
  const key = 'u:' + u;
  const c = compareCache[key];
  if (c && Date.now() - c.ts < 7 * 24 * 3600 * 1000) return c.title || null;
  let title = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(u, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html', 'Accept-Language': 'de-DE,de;q=0.9' },
      redirect: 'follow', signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.ok) {
      const html = (await res.text()).slice(0, 300000);
      const m = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/)
        || html.match(/<meta[^>]*name="title"[^>]*content="([^"]+)"/)
        || html.match(/<title[^>]*>([^<]+)</);
      if (m) {
        title = decodeEntities(m[1]).trim()
          .replace(/\s*[|–-]\s*(amazon|otto|ebay|mediamarkt|saturn|kaufland|lidl|aldi|thalia|alternate)[\s\S]*$/i, '')
          .slice(0, 120);
        if (title.length < 8) title = null;
      }
    }
  } catch { /* blockiert / Timeout → Fallback auf Deal-Titel */ }
  compareCache[key] = { ts: Date.now(), title };
  saveJson('compare.json', compareCache);
  return title;
}

// Versandkosten einrechnen: billiger.de weist pro Angebot einen expliziten
// "Gesamt"-Preis aus (inkl. Versand; Amazon/Prime steht dort mit 0 € Versand drin).
// Wir nehmen den günstigsten Gesamtpreis der Produktseite.
async function enrichWithShipping(item) {
  if (item.totalNum !== undefined) return;
  item.totalNum = null;
  try {
    const res = await politeFetch(item.url);
    if (res.ok) {
      const html = await res.text();
      let totals = [...html.matchAll(/(\d{1,3}(?:\.\d{3})?,\d{2})\s*€\s*Gesamt/g)].map(m => parsePriceNum(m[1]));
      if (!totals.length) {
        // Fallback: Preis+Versand innerhalb einer Angebotszeile addieren
        totals = [...html.matchAll(/data-offer-row[\s\S]{0,1200}?(\d{1,3}(?:\.\d{3})?,\d{2})\s*€[\s\S]{0,200}?(\d{1,3},\d{2})\s*€\s*Versand/g)]
          .map(m => parsePriceNum(m[1]) + parsePriceNum(m[2]));
      }
      if (totals.length) item.totalNum = Math.round(Math.min(...totals) * 100) / 100;
    }
  } catch { /* bleibt null → Suchpreis ohne Versand */ }
}

function euro(n) { return n.toFixed(2).replace('.', ',') + '€'; }

async function getCompare(query, priceHint) {
  const key = query.toLowerCase();
  let cached = compareCache[key];
  const prev = cached;
  if (!cached || Date.now() - cached.ts >= COMPARE_TTL || !Array.isArray(cached.items)) {
    cached = { ts: Date.now(), items: [] };
    await fillCompareCache(key, query, cached);
    // "Letzter Preis": ist das Produkt gerade nirgends zu finden, den zuletzt bekannten Preis zeigen
    if (!cached.items.length && Array.isArray(prev?.items) && prev.items.length) {
      cached.items = prev.items;
      cached.last = true;
      compareCache[key] = cached;
      saveJson('compare.json', compareCache);
    }
  }
  if (!cached.items.length) return { miss: true };
  // Der Wunsch-Treffer: der Vergleichspreis, der dem Deal-Preis am nächsten liegt
  const chosen = priceHint
    ? [...cached.items].sort((a, b) => Math.abs(a.priceNum - priceHint) - Math.abs(b.priceNum - priceHint))[0]
    : cached.items[0];
  if (!cached.last) {
    await enrichWithShipping(chosen);
    saveJson('compare.json', compareCache);
  }
  const totalNum = chosen.totalNum ?? null;
  return {
    price: totalNum != null ? euro(totalNum) : chosen.price,
    priceNum: totalNum != null ? totalNum : chosen.priceNum,
    url: chosen.url,
    name: chosen.name,
    shippingIncluded: totalNum != null,
    last: !!cached.last,
  };
}

async function fillCompareCache(key, query, cached) {
  try {
    const res = await politeFetch('https://www.billiger.de/search?searchstring=' + encodeURIComponent(query));
    if (res.ok) {
      const html = await res.text();
      // Treffer: Produktlink + nächster Preis dahinter
      const items = [...html.matchAll(/href="(\/(?:products|pricelist)\/([^"?]+))[^"]*"[\s\S]{0,900}?(\d{1,3}(?:\.\d{3})?,\d{2})\s*(?:&nbsp;| |\s)*€/g)];
      // Plausibilität: die wichtigen Wörter der Suche müssen im Produkt-Slug stecken
      const norm = s => s.toLowerCase().replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss');
      const tokens = norm(key).split(/\s+/).filter(t => t.length >= 3);
      const need = tokens.length >= 4 ? 2 : 1;
      for (const m of items.slice(0, 12)) {
        const slug = norm(m[2]);
        if (tokens.filter(t => slug.includes(t)).length < need) continue;
        cached.items.push({
          price: m[3] + '€',
          priceNum: parsePriceNum(m[3]),
          url: 'https://www.billiger.de' + m[1],
          name: m[2].replace(/^\d+-/, '').replace(/-/g, ' '),
        });
        if (cached.items.length >= 6) break;
      }
    }
  } catch { /* Netzfehler → leer cachen, TTL sorgt für Retry */ }
  compareCache[key] = cached;
  saveJson('compare.json', compareCache);
}

// ---------------------------------------------------------------- HTTP

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function send(res, code, body, type = 'application/json') {
  const data = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    // CORS: nötig, damit die iOS/Android-App (capacitor://localhost) die API erreicht
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 50_000) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    // ---- API
    if (p === '/api/channels' && req.method === 'GET') {
      return send(res, 200, allChannels().map(c => ({ ...c, feed: undefined, posts: c.type === 'community' ? (posts[c.slug] || []).length : undefined })));
    }

    if (p === '/api/channels' && req.method === 'POST') {
      const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 40);
      const desc = String(b.desc || '').trim().slice(0, 160);
      if (name.length < 3) return send(res, 400, { error: 'Name zu kurz (min. 3 Zeichen).' });
      const mod = moderate(name + ' ' + desc);
      if (mod.blocked) return send(res, 400, { error: mod.reason });
      const slug = name.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-').replace(/^-|-$/g, '');
      if (findChannel(slug)) return send(res, 409, { error: 'Kanal existiert schon.' });
      const ch = { slug, name, type: 'community', desc, createdTs: Date.now() };
      customChannels.push(ch);
      saveJson('channels.json', customChannels);
      return send(res, 201, { icon: 'tag', rules: COMMUNITY_RULES, ...ch });
    }

    if (p === '/api/deals' && req.method === 'GET') {
      const slugs = (url.searchParams.get('channels') || '').split(',').filter(Boolean);
      const chans = slugs.map(findChannel).filter(Boolean);
      const out = [];
      const errors = {};
      await Promise.all(chans.map(async ch => {
        if (ch.type === 'rss') {
          const r = await getDeals(ch);
          if (r.error) errors[ch.slug] = r.error;
          out.push(...(r.deals || []));
        } else {
          out.push(...postsAsDeals(ch.slug));
        }
      }));
      out.sort((a, b) => b.ts - a.ts);
      // Abgelaufen-Heuristik: echte Ablaufzeiten liefert das RSS nicht.
      // Älter als 36 h fliegt raus; Preisfehler > 12 h bzw. Deals > 24 h gelten als "vermutlich vorbei".
      const now = Date.now();
      const H = 3600 * 1000;
      const withCounts = out
        .filter(d => d.source !== 'mydealz' || now - d.ts < 36 * H)
        .map(d => ({
          ...d,
          stale: (d.source === 'mydealz' && now - d.ts > (d.channel === 'preisfehler' ? 12 : 24) * H)
            || (d.endTs != null && d.endTs < now),
          comments: (comments[d.id] || []).length,
          rating: ratings[d.id]?.count ? ratings[d.id].sum / ratings[d.id].count : null,
          ratingCount: ratings[d.id]?.count || 0,
          clicks: ratings[d.id]?.clicks || 0,
        }));
      return send(res, 200, { deals: withCounts.slice(0, 120), errors });
    }

    if (p === '/api/compare' && req.method === 'GET') {
      let q = (url.searchParams.get('q') || '').trim().slice(0, 90);
      const hint = parseFloat(url.searchParams.get('p') || '') || null;
      // Präziser: Produkt-Titel direkt von der Händlerseite des Deals ziehen
      const u = url.searchParams.get('u') || '';
      if (/^https?:\/\//.test(u)) {
        const resolved = await resolveProductTitle(u);
        if (resolved) q = resolved.slice(0, 90);
      }
      if (q.length < 4) return send(res, 400, { error: 'Suchbegriff zu kurz.' });
      const r = await getCompare(q, hint);
      return send(res, 200, r.miss ? { miss: true } : { ...r, source: 'billiger.de' });
    }

    // ---- Accounts (scrypt-Hash + Session-Token, Turnstile bei Login & Registrierung)
    if (p === '/api/turnstile' && req.method === 'GET') {
      return send(res, 200, { sitekey: TURNSTILE.sitekey, testKeys: !!TURNSTILE.testKeys });
    }

    if (p === '/api/register' && req.method === 'POST') {
      const b = await readBody(req);
      if (!await verifyTurnstile(b.turnstileToken)) return send(res, 400, { error: 'Captcha-Prüfung fehlgeschlagen – bitte erneut bestätigen.' });
      const user = String(b.user || '').trim();
      const email = String(b.email || '').trim().toLowerCase();
      const pass = String(b.pass || '');
      if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(user)) return send(res, 400, { error: 'Name: 3–24 Zeichen, nur Buchstaben/Zahlen/._-' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return send(res, 400, { error: 'Bitte eine gültige E-Mail-Adresse angeben.' });
      if (pass.length < 6) return send(res, 400, { error: 'Passwort: mindestens 6 Zeichen.' });
      if (users[user]) return send(res, 409, { error: 'Name ist schon vergeben.' });
      if (Object.values(users).some(u => u.email === email)) return send(res, 409, { error: 'E-Mail wird schon verwendet.' });
      const salt = crypto.randomBytes(12).toString('hex');
      users[user] = { hash: hashPass(pass, salt), salt, email, newsletter: !!b.newsletter, ts: Date.now() };
      saveJson('users.json', users);
      const token = crypto.randomBytes(18).toString('hex');
      sessions[token] = user;
      saveJson('sessions.json', sessions);
      return send(res, 201, { token, user });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      if (!await verifyTurnstile(b.turnstileToken)) return send(res, 400, { error: 'Captcha-Prüfung fehlgeschlagen – bitte erneut bestätigen.' });
      const user = String(b.user || '').trim();
      const u = users[user];
      if (!u || hashPass(String(b.pass || ''), u.salt) !== u.hash) {
        return send(res, 401, { error: 'Name oder Passwort falsch.' });
      }
      const token = crypto.randomBytes(18).toString('hex');
      sessions[token] = user;
      saveJson('sessions.json', sessions);
      return send(res, 200, { token, user });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const t = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      delete sessions[t];
      saveJson('sessions.json', sessions);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/me' && req.method === 'GET') {
      const user = authUser(req);
      return user ? send(res, 200, { user }) : send(res, 401, { error: 'Nicht angemeldet.' });
    }

    // ---- Startseiten-Kacheln (Admin pflegt sie über /admin.html)
    if (p === '/api/featured' && req.method === 'GET') {
      return send(res, 200, featured);
    }

    if (p === '/api/featured' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      const b = await readBody(req);
      const items = Array.isArray(b.items) ? b.items : [];
      featured = items.slice(0, 8).map(it => ({
        id: String(it.id || crypto.randomBytes(4).toString('hex')),
        title: String(it.title || '').trim().slice(0, 90),
        price: String(it.price || '').trim().slice(0, 20),
        tagline: String(it.tagline || '').trim().slice(0, 80),
        image: /^https?:\/\//.test(it.image || '') ? String(it.image).slice(0, 400) : '',
        link: /^https?:\/\//.test(it.link || '') ? String(it.link).slice(0, 500) : '',
      })).filter(it => it.title);
      saveJson('featured.json', featured);
      return send(res, 200, featured);
    }

    // ---- Deal-Link auslesen: Titel, Bild, Preis, Händler + Vergleichspreis.
    // Der Beschreibungs-Entwurf kommt nur mit Profil (angemeldet).
    if (p === '/api/extract' && req.method === 'GET') {
      const u = url.searchParams.get('url') || '';
      if (!/^https?:\/\//.test(u)) return send(res, 400, { error: 'Bitte einen gültigen Link angeben.' });
      let html = '';
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 7000);
        const r = await fetch(u, {
          headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html', 'Accept-Language': 'de-DE,de;q=0.9' },
          redirect: 'follow', signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        html = (await r.text()).slice(0, 400000);
      } catch (e) {
        return send(res, 502, { error: 'Seite nicht lesbar (' + (e.message || e) + ') – Felder bitte selbst ausfüllen.' });
      }
      const meta = prop => {
        const m = html.match(new RegExp(`<meta[^>]*(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i'))
          || html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'));
        return m ? decodeEntities(m[1]).trim() : '';
      };
      const title = (meta('og:title') || decodeEntities((html.match(/<title[^>]*>([^<]+)</) || [, ''])[1]).trim())
        .replace(/\s*[|–-]\s*(amazon|otto|ebay|mediamarkt|saturn|kaufland|lidl|aldi|thalia|alternate)[\s\S]*$/i, '')
        .slice(0, 90);
      const image = meta('og:image');
      let priceRaw = meta('product:price:amount') || meta('og:price:amount')
        || (html.match(/itemprop=["']price["'][^>]*content=["']([\d.,]+)["']/i) || [, ''])[1]
        || (html.match(/"price"\s*:\s*"?([\d]+(?:[.,]\d{1,2})?)"?/) || [, ''])[1];
      let priceNum = priceRaw ? parseFloat(String(priceRaw).replace(',', '.')) : null;
      if (priceNum != null && (isNaN(priceNum) || priceNum <= 0 || priceNum > 100000)) priceNum = null;
      let merchant = '';
      try {
        merchant = new URL(u).hostname.replace(/^www\./, '').split('.')[0];
        merchant = merchant.charAt(0).toUpperCase() + merchant.slice(1);
      } catch { }
      // Vergleichspreis direkt mittracken
      let compare = null;
      if (title.length >= 8) {
        const r = await getCompare(title.toLowerCase().replace(/[^\wäöüß %-]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 7).join(' '), priceNum);
        if (!r.miss) compare = { price: r.price, priceNum: r.priceNum, url: r.url };
      }
      // Beschreibungs-Entwurf nur für angemeldete Profile (oder die Redaktion)
      let draft = null;
      if ((authUser(req) || isAdmin(req)) && title) {
        const parts = [`${title} gibt es gerade${priceNum != null ? ` für ${priceNum.toFixed(2).replace('.', ',')} €` : ''}${merchant ? ` bei ${merchant}` : ''}.`];
        if (compare && priceNum != null && compare.priceNum > priceNum) {
          parts.push(`Der günstigste Vergleichspreis liegt bei ${compare.price} (billiger.de) – du sparst rund ${Math.round((1 - priceNum / compare.priceNum) * 100)} %.`);
        }
        parts.push('Automatisch erstellter Entwurf – bitte kurz prüfen und ergänzen.');
        draft = parts.join(' ');
      }
      return send(res, 200, { title, image, priceNum, merchant, compare, draft, loginForDraft: !authUser(req) && !isAdmin(req) });
    }

    // ---- Admin: Verwaltung (alles über X-Admin-Key)
    if (p === '/api/admin/users' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      return send(res, 200, Object.entries(users).map(([name, u]) => ({
        user: name, email: u.email || '', newsletter: !!u.newsletter, ts: u.ts,
      })));
    }

    if (p === '/api/admin/newsletter.csv' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      const rows = Object.entries(users).filter(([, u]) => u.newsletter && u.email)
        .map(([name, u]) => `${name};${u.email}`);
      return send(res, 200, 'benutzer;email\n' + rows.join('\n'), 'text/csv; charset=utf-8');
    }

    if (p === '/api/admin/posts' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      const all = [];
      for (const [ch, list] of Object.entries(posts)) {
        for (const post of list) all.push({ channel: ch, id: post.id, title: post.title, ts: post.ts, newCustomer: !!post.newCustomer });
      }
      all.sort((a, b) => b.ts - a.ts);
      return send(res, 200, all);
    }

    if (p === '/api/admin/delete-post' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      const b = await readBody(req);
      const id = String(b.id || '');
      let removed = false;
      for (const ch of Object.keys(posts)) {
        const before = posts[ch].length;
        posts[ch] = posts[ch].filter(x => x.id !== id);
        if (posts[ch].length !== before) removed = true;
        if (!posts[ch].length) delete posts[ch];
      }
      if (removed) saveJson('posts.json', posts);
      return send(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'Post nicht gefunden.' });
    }

    if (p === '/api/admin/turnstile' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      const b = await readBody(req);
      const sitekey = String(b.sitekey || '').trim();
      const secret = String(b.secret || '').trim();
      if (!sitekey || !secret) return send(res, 400, { error: 'Sitekey und Secret angeben.' });
      TURNSTILE = { sitekey, secret, testKeys: /^1x0/.test(sitekey) };
      saveJson('turnstile.json', TURNSTILE);
      return send(res, 200, { ok: true, testKeys: TURNSTILE.testKeys });
    }

    if (p === '/api/click' && req.method === 'POST') {
      const b = await readBody(req);
      const id = String(b.dealId || '');
      if (!id) return send(res, 400, { error: 'dealId fehlt.' });
      const r = ratings[id] = ratings[id] || { up: 0, down: 0 };
      r.clicks = (r.clicks || 0) + 1;
      saveJson('ratings.json', ratings);
      return send(res, 200, { clicks: r.clicks });
    }

    // Sternesystem (1–5), wie bei Studentenrabatt-Apps
    if (p === '/api/rate' && req.method === 'POST') {
      const b = await readBody(req);
      const dealId = String(b.dealId || '');
      if (!dealId) return send(res, 400, { error: 'dealId fehlt.' });
      const stars = Math.min(5, Math.max(1, Math.round(Number(b.stars) || 0)));
      const prev = b.prev ? Math.min(5, Math.max(1, Math.round(Number(b.prev)))) : null;
      if (!stars) return send(res, 400, { error: 'stars (1–5) fehlt.' });
      const r = ratings[dealId] = ratings[dealId] || {};
      r.sum = (r.sum || 0); r.count = (r.count || 0);
      if (prev && r.count > 0) { r.sum -= prev; r.count -= 1; }
      r.sum += stars; r.count += 1;
      saveJson('ratings.json', ratings);
      return send(res, 200, { rating: r.sum / r.count, ratingCount: r.count });
    }

    if (p === '/api/comments' && req.method === 'GET') {
      const dealId = url.searchParams.get('dealId') || '';
      return send(res, 200, comments[dealId] || []);
    }

    if (p === '/api/comments' && req.method === 'POST') {
      const b = await readBody(req);
      const dealId = String(b.dealId || '');
      const user = String(b.user || 'Anonym').trim().slice(0, 24) || 'Anonym';
      const text = String(b.text || '').trim().slice(0, 600);
      if (!dealId || text.length < 2) return send(res, 400, { error: 'Kommentar zu kurz.' });
      const mod = moderate(text);
      if (mod.blocked) return send(res, 400, { error: mod.reason });
      const c = { user, text, ts: Date.now(), flags: mod.flags };
      (comments[dealId] = comments[dealId] || []).push(c);
      saveJson('comments.json', comments);
      return send(res, 201, c);
    }

    if (p === '/api/posts' && req.method === 'POST') {
      // Deals postet nur noch die Redaktion (Admin-Key) – Nutzer kommentieren und bewerten
      if (!isAdmin(req)) return send(res, 403, { error: 'Deals postet aktuell die Redaktion. Du kannst kommentieren und mit Sternen bewerten.' });
      const b = await readBody(req);
      const ch = findChannel(String(b.channel || ''));
      if (!ch) return send(res, 404, { error: 'Kanal nicht gefunden.' });
      if (ch.type !== 'community') return send(res, 403, { error: 'Dieser Kanal wird automatisch bespielt.' });
      const user = String(b.user || 'Anonym').trim().slice(0, 24) || 'Anonym';
      const title = String(b.title || '').trim().slice(0, 90);
      const text = String(b.text || '').trim().slice(0, 1200);
      if (title.length < 4) return send(res, 400, { error: 'Titel zu kurz (min. 4 Zeichen).' });
      const mod = moderate(title + ' ' + text);
      if (mod.blocked) return send(res, 400, { error: mod.reason });
      // Preis + Pflicht-Vergleichspreis (jedes Produkt braucht einen Vergleich)
      const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? null : Math.round(n * 100) / 100; };
      const priceNum = num(b.price);
      const compareNum = num(b.comparePrice);
      if (priceNum != null && compareNum == null) {
        return send(res, 400, { error: 'Bitte gib einen Vergleichspreis an (regulärer Preis des Produkts).' });
      }
      let endTs = null;
      if (b.endDate) { const t = Date.parse(String(b.endDate) + 'T23:59:59'); if (!isNaN(t)) endTs = t; }
      // Neukunden-Deals werden vom Rest getrennt: explizit gesetzt oder am Text erkannt
      const newCustomer = !!b.newCustomer
        || /neukund|erstbestellung|nur für neue|new customer|erste bestellung/i.test(title + ' ' + text);
      const post = {
        id: crypto.randomBytes(6).toString('hex'), user, title, text, ts: Date.now(), flags: mod.flags,
        priceNum, compareNum, endTs, compareChecked: !!b.compareChecked, newCustomer,
        merchant: String(b.merchant || '').trim().slice(0, 30),
        image: /^https?:\/\//.test(b.image || '') ? String(b.image).slice(0, 400) : '',
      };
      (posts[ch.slug] = posts[ch.slug] || []).unshift(post);
      saveJson('posts.json', posts);
      return send(res, 201, post);
    }

    // ---- Statische Dateien
    let file = p === '/' ? '/index.html' : p;
    file = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC)) return send(res, 403, { error: 'Nope' });
    fs.readFile(full, (err, data) => {
      if (err) return send(res, 404, { error: 'Nicht gefunden' });
      send(res, 200, data, MIME[path.extname(full)] || 'application/octet-stream');
    });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`RabattArchiv läuft auf http://localhost:${PORT}`);
  console.log(`Admin-Panel: http://localhost:${PORT}/admin.html  (Key: ${ADMIN_KEY} – liegt in data/admin-key.txt)`);
});
