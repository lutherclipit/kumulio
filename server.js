// RabattArchiv, lokaler Server (keine Abhängigkeiten, Node >= 18)
// Echte Deals per mydealz-RSS, Community-Posts + Kommentare als JSON auf Platte.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

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
  'Beiträge kommen von Nutzern, nicht von RabattArchiv, alles auf eigene Gefahr.',
  'Nur legale Angebote. Referral-Links müssen als solche erkennbar sein.',
  'Niemals Vorkasse leisten oder per PayPal „Freunde & Familie" an Fremde zahlen.',
  'Scam-Filter und Moderation prüfen jeden Beitrag, ersetzen aber nicht den eigenen Verstand.',
];
// Alle Inhalte werden von der Redaktion gepostet, keine automatischen Feeds mehr
const BUILTIN_CHANNELS = [
  { slug: 'angebote', name: 'Angebote', icon: 'star', type: 'community', desc: 'Rabattcodes, Gratis-Testphasen und öffentliche Aktionen, handverlesen.',
    rules: ['Angebote prüft die Redaktion, Konditionen können sich beim Anbieter ändern.', 'Gratis-Testphasen rechtzeitig kündigen, wenn du nicht verlängern willst.', 'RabattArchiv verkauft nichts, die Aktion läuft direkt beim Anbieter.'] },
  { slug: 'preisfehler', name: 'Preisfehler', icon: 'bolt', type: 'community', desc: 'Vermutete Preisfehler, schnell sein lohnt sich.',
    rules: ['Preisfehler sind nie garantiert, Händler dürfen Bestellungen stornieren.', 'Kein Anspruch auf Lieferung zum Fehlerpreis.', 'Am besten per Gast-Bestellung und ohne Zusatzkäufe bestellen.'] },
  { slug: 'geld-verdienen', name: 'Geld verdienen', icon: 'banknote', type: 'community', desc: 'Referral-Codes und Prämien.', rules: COMMUNITY_RULES },
  { slug: 'methoden', name: 'Methoden', icon: 'bulb', type: 'community', desc: 'Spar-Tricks aus dem Alltag, legal und erklärt.', rules: COMMUNITY_RULES },
];

// ---------------------------------------------------------------- Storage

// Laden: ist die Datei kaputt (halb geschrieben) oder fehlt sie nach einem
// Absturz zwischen zwei Umbenennungen, kommt die Vorgaengerfassung (.bak).
// Frueher ging es still mit {} weiter — und der naechste Speichervorgang
// ueberschrieb ALLE Wallets. Kaputte Dateien werden beiseitegelegt, nie
// ueberschrieben.
function loadJson(file, fallback) {
  const ziel = path.join(DATA, file);
  for (const kandidat of [ziel, ziel + '.bak']) {
    let text;
    try { text = fs.readFileSync(kandidat, 'utf8'); } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw new Error(`[Speicher] ${kandidat} nicht lesbar (${err && err.code}) — Start abgebrochen, damit nichts ueberschrieben wird`);
    }
    try {
      const obj = JSON.parse(text);
      if (kandidat !== ziel) console.error(`[Speicher] ${file} fehlte oder war kaputt — Vorgaengerfassung ${file}.bak geladen`);
      return obj;
    } catch {
      try { fs.copyFileSync(kandidat, `${kandidat}.kaputt-${Date.now()}`); } catch { /* egal */ }
      console.error(`[Speicher] ${kandidat} ist kaputt — beiseitegelegt`);
    }
  }
  return fallback;
}
// Schreiben: erst in eine eigene Zwischendatei (fsync), dann die bisherige
// Fassung zu .bak und die neue an ihren Platz. Ein Absturz mittendrin
// hinterlaesst nie eine halbe Datei.
let tmpZaehler = 0;
function schreibeAtomarSync(file, obj) {
  fs.mkdirSync(path.dirname(path.join(DATA, file)), { recursive: true });
  const ziel = path.join(DATA, file);
  const tmp = `${ziel}.${process.pid}.${++tmpZaehler}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(ziel, ziel + '.bak'); } catch { /* gab noch keine */ }
  fs.renameSync(tmp, ziel);
}
// Zwischendateien eines abgebrochenen Schreibvorgangs (Absturz, voller
// Datentraeger) beim Start wegraeumen — sie belegen sonst nur Platz
for (const ordner of [DATA, path.join(DATA, 'archiv'), path.join(DATA, 'bilder')]) {
  try { for (const f of fs.readdirSync(ordner)) if (f.endsWith('.tmp')) fs.rmSync(path.join(ordner, f), { force: true }); } catch { /* fehlt */ }
}
// Pro Datei hoechstens ein Schreibvorgang gleichzeitig. Kommt waehrenddessen
// ein neuer Stand, wird er direkt danach geschrieben — eine aeltere Fassung
// kann so nie eine neuere ueberholen.
const speicherQueue = {};
function speicherEintrag(name) {
  return speicherQueue[name] || (speicherQueue[name] = { obj: null, timer: null, erstesMal: 0, schreibt: false, nr: 0, geschrieben: 0 });
}
async function schreibeSpaeter(name) {
  const e = speicherEintrag(name);
  clearTimeout(e.timer); e.timer = null;
  if (e.schreibt || !e.obj) return;
  e.schreibt = true; e.erstesMal = 0;
  const obj = e.obj; e.obj = null;
  const meineNr = ++e.nr;
  try {
    const text = JSON.stringify(obj);
    await fs.promises.mkdir(path.dirname(path.join(DATA, name)), { recursive: true });
    const ziel = path.join(DATA, name);
    const tmp = `${ziel}.${process.pid}.${++tmpZaehler}.tmp`;
    const fh = await fs.promises.open(tmp, 'w');
    try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
    // Inzwischen sofort geschrieben (saveJson)? Dann ist diese Fassung aelter.
    // Pruefen und Umbenennen ohne await dazwischen: kein saveJson kann sich
    // dazwischenschieben
    if (e.geschrieben > meineNr) { fs.rmSync(tmp, { force: true }); return; }
    e.geschrieben = meineNr;
    try { fs.renameSync(ziel, ziel + '.bak'); } catch { /* gab noch keine */ }
    fs.renameSync(tmp, ziel);
  } catch (err) {
    // Nicht still verwerfen: in 2 s nochmal (z. B. Volume kurz voll)
    console.error(`[Speicher] ${name} konnte nicht geschrieben werden:`, err.message);
    if (!e.obj) e.obj = obj;
    e.timer = setTimeout(() => schreibeSpaeter(name), 2000);
  } finally {
    e.schreibt = false;
    if (e.obj && !e.timer) schreibeSpaeter(name);
  }
}
// Sofort sichern (Konto, Geschenke). Laeuft fuer die Datei gerade ein
// aufgeschobener Schreibvorgang, wird direkt danach geschrieben.
function saveJson(file, obj) {
  const e = speicherEintrag(file);
  clearTimeout(e.timer); e.timer = null; e.erstesMal = 0;
  e.obj = null;
  e.geschrieben = ++e.nr; // ein gerade laufender, aelterer Schreibvorgang verwirft sich
  try { schreibeAtomarSync(file, obj); return true; }
  catch (err) {
    console.error(`[Speicher] ${file} konnte nicht geschrieben werden:`, err.message);
    e.obj = obj;
    e.timer = setTimeout(() => schreibeSpaeter(file), 2000);
    return false;
  }
}


let comments = loadJson('comments.json', {});   // { dealId: [ {user,text,ts,flags} ] }
let profComments = loadJson('profile-comments.json', {}); // { user: [ {from,text,stars,ts} ] }
// Alt-Kommentare aus fruehen Versionen hatten keine id und liessen sich dadurch
// nie loeschen ("Kommentar nicht gefunden"): einmalig nachruesten und sichern
{
  let commentsFixed = false;
  for (const clist of Object.values(comments)) {
    for (const c of clist) if (c && !c.id) { c.id = crypto.randomBytes(5).toString('hex'); commentsFixed = true; }
  }
  if (commentsFixed) saveJson('comments.json', comments);
}
let ratings = loadJson('ratings.json', {});     // { dealId: {up, down, clicks} }
let users = loadJson('users.json', {});
{
  let weg = 0;
  for (const u of Object.values(users)) {
    const pr = u && u.profile;
    if (pr && pr.avatar && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(pr.avatar)) { pr.avatar = ''; weg++; }
  }
  if (weg) console.log(`[Profil] ${weg} ungueltige Profilbilder entfernt`);
}         // { username: {hash, salt, ts} }
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

// ---------------------------------------------------------------- Konto-Sicherheit
// Drossel: hoechstens max Versuche je Schluessel im Zeitfenster (gegen
// Durchprobieren von Passwoertern, Codes und Massen-Mails)
const drosselTopf = new Map();
function drosselAufraeumen() {
  // Gegen Speicherfluten (viele erfundene Schluessel): Aelteste raus
  if (drosselTopf.size <= 20000) return;
  const jetzt = Date.now();
  for (const [k, l] of drosselTopf) if (!l.length || jetzt - l[l.length - 1] > 3600e3) drosselTopf.delete(k);
  if (drosselTopf.size > 20000) [...drosselTopf.keys()].slice(0, drosselTopf.size - 15000).forEach(k => drosselTopf.delete(k));
}
// Zaehlt jeden Aufruf; false, sobald max im Fenster erreicht ist
function drossel(schluessel, max, fensterMs) {
  const jetzt = Date.now();
  const liste = (drosselTopf.get(schluessel) || []).filter(t => jetzt - t < fensterMs);
  if (liste.length >= max) { drosselTopf.set(schluessel, liste); return false; }
  liste.push(jetzt);
  drosselTopf.set(schluessel, liste);
  drosselAufraeumen();
  return true;
}
// Nur Fehlschlaege zaehlen (Anmeldung, 2FA-Codes): wer sein Passwort kennt,
// wird nie ausgebremst, weil ein anderer sich vertippt
function zuVieleFehler(schluessel, max, fensterMs) {
  const jetzt = Date.now();
  return (drosselTopf.get(schluessel) || []).filter(t => jetzt - t < fensterMs).length >= max;
}
function fehlerMerken(...schluessel) {
  const jetzt = Date.now();
  for (const k of schluessel) {
    const l = (drosselTopf.get(k) || []).filter(t => jetzt - t < 3600e3);
    l.push(jetzt);
    drosselTopf.set(k, l);
  }
  drosselAufraeumen();
}
setInterval(() => {
  const jetzt = Date.now();
  for (const [k, l] of drosselTopf) if (!l.some(t => jetzt - t < 3600e3)) drosselTopf.delete(k);
}, 3600e3).unref?.();
function ipVon(req) {
  return String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();
}
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---- E-Mail: ueber die HTTPS-Schnittstelle von Resend. SMTP geht auf
// Railway (Trial/Hobby) nicht — die Ports sind dort gesperrt. HTTPS auf Port
// 443 funktioniert auf jedem Tarif. Schluessel und Absender kommen aus
// data/mail.json (Admin-Panel) oder aus den Umgebungsvariablen.
let MAIL = loadJson('mail.json', null);
function mailEinstellungen() {
  const m = MAIL || {};
  return {
    resendKey: m.resendKey || process.env.RESEND_API_KEY || '',
    from: m.from || process.env.MAIL_FROM || '',
    basis: (m.basis || process.env.PUBLIC_URL || 'https://kumulio.de').replace(/\/$/, ''),
  };
}
function mailBereit() { const m = mailEinstellungen(); return !!(m.resendKey && m.from); }
async function sendeMail({ to, subject, text, html }) {
  const m = mailEinstellungen();
  if (!m.resendKey || !m.from) throw new Error('E-Mail-Versand ist nicht eingerichtet.');
  if (!drossel('mail-global-stunde', 40, 3600e3) || !drossel('mail-global-tag', 90, 86400e3)) {
    throw new Error('Mail-Grenze fuer heute erreicht.');
  }
  // RESEND_API_URL nur fuer lokale Tests (Mail abfangen statt verschicken)
  const r = await fetch(process.env.RESEND_API_URL || 'https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + m.resendKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: m.from, to: [to], subject, text, html }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Mailversand fehlgeschlagen (${r.status}): ${(await r.text()).slice(0, 300)}`);
}
// Schlichte Mail im kumulio-Ton: Text + einfaches HTML mit einem Knopf
function mailHtml(titel, absaetze, knopf) {
  const e = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:460px;margin:0 auto;padding:24px;color:#1b1f24">
<div style="font-size:22px;font-weight:800;letter-spacing:-.02em;margin-bottom:14px">kumulio</div>
<h1 style="font-size:19px;margin:0 0 12px">${e(titel)}</h1>
${absaetze.map(a => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${e(a)}</p>`).join('')}
${knopf ? `<p style="margin:20px 0"><a href="${e(knopf.url)}" style="background:#12C77E;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:12px;display:inline-block">${e(knopf.text)}</a></p>
<p style="font-size:12px;color:#6b7280;word-break:break-all">Falls der Knopf nicht geht: ${e(knopf.url)}</p>` : ''}
</div>`;
}
// Sicherheits-Hinweis ans Konto (Passwort geaendert, 2FA an/aus). Scheitert
// der Versand, geht der eigentliche Vorgang trotzdem durch.
function sicherheitsMail(user, titel, satz) {
  const u = users[user];
  if (!u || !u.email || !mailBereit()) return;
  sendeMail({
    to: u.email, subject: `kumulio: ${titel}`,
    text: `Hallo @${user},\n\n${satz}\n\nWarst du das nicht? Setz dein Passwort sofort zurück: ${mailEinstellungen().basis}/?passwort-vergessen=1\n\nDein kumulio-Team`,
    html: mailHtml(titel, [`Hallo @${user},`, satz, 'Warst du das nicht? Dann setz dein Passwort sofort zurück.'],
      { text: 'Passwort zurücksetzen', url: `${mailEinstellungen().basis}/?passwort-vergessen=1` }),
  }).catch(e => console.error('[Mail]', e.message));
}

// Bestaetigungslink fuer die E-Mail-Adresse (gilt 7 Tage)
function emailBestaetigungSchicken(user) {
  const u = users[user];
  if (!u || !u.email || u.emailOk || !mailBereit()) return;
  const token = crypto.randomBytes(24).toString('base64url');
  resets[sha256(token)] = { user, zweck: 'email', email: u.email, exp: Date.now() + 7 * 864e5, ts: Date.now() };
  saveJson('resets.json', resets);
  const link = `${mailEinstellungen().basis}/?email-ok=${token}`;
  sendeMail({
    to: u.email, subject: 'kumulio: E-Mail-Adresse bestätigen',
    text: `Hallo @${user},

bitte bestätige deine E-Mail-Adresse:
${link}

Nur bestätigte Adressen bekommen Links, falls du mal dein Passwort vergisst.

Dein kumulio-Team`,
    html: mailHtml('E-Mail-Adresse bestätigen', [`Hallo @${user},`, 'bitte bestätige deine E-Mail-Adresse. Nur bestätigte Adressen bekommen Links, falls du mal dein Passwort vergisst.'],
      { text: 'Adresse bestätigen', url: link }),
  }).catch(e => console.error('[Mail] Bestaetigung:', e.message));
}
// Nur gewoehnliche Adressen: Buchstaben, Ziffern und ._%+- vor dem @, eine
// Domain mit Punkt. Vorher ging alles ohne Leerzeichen durch — auch HTML wie
// <img/src=x/onerror=…>@x.de, das dann im Admin-Panel als Skript lief.
const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,189}\.[a-z]{2,24}$/i;
function emailGueltig(e) {
  const t = String(e || '');
  return t.length <= 254 && EMAIL_RE.test(t) && !t.includes('..') && !/^[.-]|[.-]@|@[.-]|-\./.test(t);
}
// CSV fuer Tabellenprogramme: Zellen, die mit = + - @ beginnen, wuerden dort
// als Formel ausgefuehrt — ein vorangestelltes ' macht sie zu Text
function csvZelle(x) {
  const t = String(x ?? '').replace(/[;\r\n"]/g, ' ');
  return /^[=+\-@\t]/.test(t) ? "'" + t : t;
}
function emailMaske(e) {
  const [n, d] = String(e || '').split('@');
  if (!d) return '';
  return (n.length <= 2 ? n[0] + '*' : n.slice(0, 2) + '*'.repeat(Math.min(6, n.length - 2))) + '@' + d;
}
// ---- Passwort-Links: nur der Hash des Tokens liegt auf dem Server; der
// Link gilt 60 Minuten und nur einmal
let resets = loadJson('resets.json', {});   // { sha256(token): { user, exp, ts } }
function resetsAufraeumen() {
  const jetzt = Date.now();
  let weg = false;
  for (const [k, r] of Object.entries(resets)) if (!r || r.exp < jetzt) { delete resets[k]; weg = true; }
  if (weg) saveJson('resets.json', resets);
}

// ---- Zwei-Faktor (TOTP, RFC 6238): funktioniert mit jeder Authenticator-App
// (Google Authenticator, Microsoft Authenticator, 2FAS, Apple Passwoerter …)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, wert = 0, out = '';
  for (const b of buf) {
    wert = (wert << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(wert >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(wert << (5 - bits)) & 31];
  return out;
}
function base32Lesen(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, wert = 0;
  const out = [];
  for (const c of clean) {
    wert = (wert << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((wert >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpCode(secret, zaehler) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(zaehler));
  const h = crypto.createHmac('sha1', base32Lesen(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
// Prueft einen 6-stelligen Code (±30 s Uhrversatz). Ein schon benutzter
// Zeitschritt zaehlt nicht nochmal (kein Wiederverwenden abgefangener Codes).
function totpPruefen(t, code) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6 || !t || !t.secret) return false;
  const jetzt = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) {
    const z = jetzt + d;
    if (z <= (t.letzter || 0)) continue;
    const soll = totpCode(t.secret, z);
    if (crypto.timingSafeEqual(Buffer.from(soll), Buffer.from(c))) { t.letzter = z; return true; }
  }
  return false;
}
// Ersatzcodes: fuer den Fall, dass das Handy mit der Authenticator-App weg ist
function ersatzcodeEinloesen(t, code) {
  const c = String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (c.length < 8 || !t || !Array.isArray(t.reserve)) return false;
  const i = t.reserve.indexOf(sha256(c));
  if (i < 0) return false;
  t.reserve.splice(i, 1);
  return true;
}
function neueErsatzcodes() {
  const codes = Array.from({ length: 8 }, () => {
    const s = base32(crypto.randomBytes(7)).toLowerCase().slice(0, 10);
    return s.slice(0, 5) + '-' + s.slice(5);
  });
  return { codes, hashes: codes.map(c => sha256(c.replace(/-/g, ''))) };
}
// Anmeldung mit 2FA: nach dem Passwort gibt es erst ein kurzlebiges Ticket,
// die Sitzung erst nach dem Code
const loginTickets = new Map(); // ticket -> { user, exp, versuche }
function ticketsWeg(user) { for (const [k, t] of loginTickets) if (t.user === user) loginTickets.delete(k); }
// Alles beenden, was an einem Konto haengt (ausser optional der eigenen Sitzung):
// Sitzungen, Anmelde-Tickets, Push-Abos (sonst liest ein Angreifer DMs weiter
// mit), offene Echtzeit-Verbindungen
function kontoAbmeldenUeberall(user, ausserToken = '') {
  for (const [t, u] of Object.entries(sessions)) if (u === user && t !== ausserToken) delete sessions[t];
  ticketsWeg(user);
  saveJson('sessions.json', sessions);
  if (!ausserToken) {
    const vorher = pushSubs.length;
    pushSubs = pushSubs.filter(x => x.user !== user);
    if (pushSubs.length !== vorher) saveJson('push-subs.json', pushSubs);
    for (const c of sseClients) if (c.user === user) { try { c.res.end(); } catch { /* weg */ } }
  }
}
function tokenVon(req) { return String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, ''); }
function zweiFaktorAn(user) { const t = users[user] && users[user].totp; return !!(t && t.aktiv); }

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
let wallets = loadJson('wallets.json', {});     // { user: {vouchers:[], cards:[], ts} }, Wallet hängt am Konto
// Geschenke unterwegs: bleiben hier, bis der Empfänger sie sicher in seiner
// Wallet verankert hat (claim) — so kann ein Gutschein beim Übergeben nie verloren gehen
let gifts = loadJson('gifts.json', {});         // { user: [ {…voucher, giftFrom, giftTs} ] }
// Die private Notiz am Gutschein geht nie mit zum Freund. Geschenke, die
// schon vorher mit Notiz unterwegs waren, verlieren sie hier einmalig.
{
  let raus = 0;
  for (const liste of Object.values(gifts)) for (const g of liste || []) if (g && 'notiz' in g) { delete g.notiz; raus++; }
  if (raus) { saveJson('gifts.json', gifts); console.log(`[Geschenke] ${raus} private Notizen entfernt`); }
}

// Wallet-Diät auch serverseitig: Originalfotos fliegen raus, sobald ein
// Kassen-Zuschnitt existiert. Entschlackt Alt-Bestände sofort (weniger RAM,
// schnellere Writes, kleinere Antworten), auch gegen alte Clients.
function slimWallet(w) {
  if (!w) return w;
  [...(w.vouchers || []), ...(w.cards || [])].forEach(it => {
    if (it && it.img && it.codeImg) it.img = '';
  });
  return w;
}
Object.values(wallets).forEach(slimWallet);

// Originalfotos (das nicht zugeschnittene Bild eines Gutscheins) liegen als
// eigene JPEG-Dateien neben der Wallet: data/orig/<Nutzer als Hex>/<id>.jpg.
// Die Wallet traegt nur den Zeitstempel v.orig — so bleibt jeder Sync klein,
// und das Original wird erst geladen, wenn jemand es im Bildbetrachter sehen will.
const ORIG_DIR = path.join(DATA, 'orig');
const ORIG_ID = /^[A-Za-z0-9_-]{1,40}$/;
// Frische Gutschein-ID fuer ein Geschenk. Die alte ID behielt der Gutschein
// frueher bei — lag beim Empfaenger noch ein alter Eintrag oder Loeschmarker
// mit derselben ID (Gutschein ging schon einmal hin und her), verdeckte der
// das Geschenk oder loeschte es.
function neueGutscheinId() {
  return crypto.randomBytes(8).readBigUInt64BE().toString(36).slice(0, 10);
}
function origUmziehen(vonUser, vonId, zuUser, zuId) {
  if (!ORIG_ID.test(vonId) || !ORIG_ID.test(zuId)) return;
  fs.promises.mkdir(origOrdner(zuUser), { recursive: true })
    .then(() => fs.promises.rename(origPfad(vonUser, vonId), origPfad(zuUser, zuId)))
    .catch(() => {});
}
// JPEG oder WebP? (Originalfotos kommen je nach Geraet in beiden Formaten)
function bildTyp(buf) {
  if (buf.length > 12 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}
function origOrdner(user) { return path.join(ORIG_DIR, Buffer.from(String(user)).toString('hex')); }
function origPfad(user, id) { return path.join(origOrdner(user), id + '.jpg'); }
// Rohdaten statt JSON: ein JPEG als base64 im JSON waere ein Drittel groesser
function readRaw(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const teile = [];
    let n = 0, over = false;
    req.on('data', c => {
      if (over) return;
      n += c.length;
      if (n > maxBytes) { over = true; teile.length = 0; return; }
      teile.push(c);
    });
    req.on('end', () => {
      if (over) { const e = new Error('Bild zu groß.'); e.tooLarge = true; return reject(e); }
      resolve(Buffer.concat(teile));
    });
    req.on('error', reject);
  });
}
// ---------------------------------------------------------------- Bildablage
// Gutscheinbilder liegen als eigene Dateien in data/bilder/<sha1>.<endung>,
// in der Wallet steht nur "bild:<name>". Frueher steckten alle Bilder aller
// Nutzer in wallets.json — die Datei wurde bei jeder Abbuchung komplett neu
// geschrieben und taeglich siebenfach gesichert. Jetzt bleibt sie klein, und
// gleiche Bilder (z. B. nach dem Verschenken) liegen nur einmal da.
// Nach aussen (an die App) gehen die Bilder wie immer als data-URL.
const BILD_DIR = path.join(DATA, 'bilder');
const BILD_REF = 'bild:';
const BILD_ENDUNG = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png', 'image/gif': 'gif' };
const ENDUNG_TYP = { jpg: 'image/jpeg', webp: 'image/webp', png: 'image/png', gif: 'image/gif' };
const BILD_NAME = /^[a-f0-9]{40}\.(jpg|webp|png|gif)$/;
// Nur echte Bilddaten: Anfuehrungszeichen o. Ae. koennten sonst aus src="…" ausbrechen
const AVATAR_OK = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
function bildFeldOk(w) {
  const t = String(w || '');
  return /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(t)
    || (t.startsWith('bild:') && BILD_NAME.test(t.slice(5)));
}
// Vorhandene Bilddateien: beim Start einmal eingelesen, danach mitgefuehrt
const bildDateien = new Set();
try { for (const f of fs.readdirSync(BILD_DIR)) if (BILD_NAME.test(f)) bildDateien.add(f); } catch { /* noch keine */ }
// Hat der Eintrag ein Bild, das es auch wirklich gibt? Ein Verweis auf eine
// fehlende Datei zaehlt als kein Bild — so laedt ein Geraet, das es noch hat,
// es wieder hoch, und es heilt von selbst
function bildLebt(w) {
  if (typeof w !== 'string' || !w) return false;
  return !w.startsWith(BILD_REF) || bildDateien.has(w.slice(BILD_REF.length));
}
function hatBild(it) { return !!it && (bildLebt(it.codeImg) || bildLebt(it.img)); }
function bildAblegen(dataUrl) {
  const m = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  const endung = m && BILD_ENDUNG[m[1]];
  if (!endung) return dataUrl; // unbekanntes Format: so lassen, wie es ist
  const buf = Buffer.from(m[2], 'base64');
  const name = crypto.createHash('sha1').update(buf).digest('hex') + '.' + endung;
  const datei = path.join(BILD_DIR, name);
  if (!fs.existsSync(datei)) {
    // Synchron und vollstaendig, BEVOR die Wallet darauf verweist
    fs.mkdirSync(BILD_DIR, { recursive: true });
    const tmp = `${datei}.${process.pid}.${++tmpZaehler}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, datei);
  } else {
    // Wieder benutzt: Zeitstempel auffrischen, damit das Aufraeumen es nicht
    // fuer "lange unbenutzt" haelt
    try { const t = new Date(); fs.utimesSync(datei, t, t); } catch { /* egal */ }
  }
  bildDateien.add(name);
  return BILD_REF + name;
}
function bildHolen(ref) {
  const name = ref.slice(BILD_REF.length);
  if (!BILD_NAME.test(name)) return '';
  try {
    const buf = fs.readFileSync(path.join(BILD_DIR, name));
    return `data:${ENDUNG_TYP[name.split('.')[1]]};base64,${buf.toString('base64')}`;
  } catch {
    console.error('[Bilder] Datei fehlt:', name);
    return '';
  }
}
// Eingehend: Bilder an Ort und Stelle durch Verweise ersetzen
function bilderAblegen(it) {
  if (!it || typeof it !== 'object') return it;
  for (const f of ['codeImg', 'img']) {
    const w = it[f];
    if (typeof w === 'string' && w.length > 1500 && w.startsWith('data:')) {
      try { it[f] = bildAblegen(w); } catch (e) { console.error('[Bilder] Ablegen fehlgeschlagen:', e.message); }
    }
  }
  return it;
}
// Ausgehend: Kopie mit echten Bildern (das Gespeicherte bleibt unangetastet)
function bilderHolen(it) {
  if (!it || typeof it !== 'object') return it;
  let kopie = null;
  for (const f of ['codeImg', 'img']) {
    if (typeof it[f] === 'string' && it[f].startsWith(BILD_REF)) {
      kopie = kopie || { ...it };
      kopie[f] = bildHolen(it[f]);
    }
  }
  return kopie || it;
}
const mitBildern = liste => (liste || []).map(bilderHolen);
// Einmalig beim Start: vorhandene Bilder aus wallets.json/gifts.json auslagern
function bilderAuslagernBestand() {
  let n = 0;
  const zaehle = it => { const vor = JSON.stringify([it && it.codeImg, it && it.img]).length; bilderAblegen(it); if (JSON.stringify([it && it.codeImg, it && it.img]).length !== vor) n++; };
  for (const w of Object.values(wallets)) for (const it of [...(w.vouchers || []), ...(w.cards || [])]) zaehle(it);
  for (const liste of Object.values(gifts)) for (const it of liste || []) zaehle(it);
  if (n) {
    saveJson('wallets.json', wallets);
    saveJson('gifts.json', gifts);
    console.log(`[Bilder] ${n} Eintraege ausgelagert`);
  }
}
// Aufraeumen: Bilder, auf die nichts mehr verweist (auch kein Papierkorb und
// keine Tages-Sicherung), und die aelter als 2 Tage sind
async function bilderAufraeumen() {
  let dateien;
  try { dateien = await fs.promises.readdir(BILD_DIR); } catch { return; }
  const benutzt = new Set();
  const sammle = text => { for (const m of String(text).matchAll(/bild:([a-f0-9]{40}\.(?:jpg|webp|png|gif))/g)) benutzt.add(m[1]); };
  // Alle Dateien in einem Ordner lesen (auch .bak und .kaputt-*). Scheitert
  // etwas anderes als "gibt es nicht", wird NICHTS geloescht
  const liesOrdner = async (ordner, nurNamen) => {
    let namen;
    try { namen = await fs.promises.readdir(ordner); } catch (e) { if (e.code === 'ENOENT') return true; return false; }
    for (const f of namen) {
      if (nurNamen && !nurNamen.some(n => f.startsWith(n))) continue;
      try { sammle(await fs.promises.readFile(path.join(ordner, f), 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT' && e.code !== 'EISDIR') return false; }
    }
    return true;
  };
  if (!await liesOrdner(ARCHIV_DIR)) { console.error('[Bilder] Papierkorb nicht lesbar — kein Aufraeumen'); return; }
  let tage = [];
  try { tage = await fs.promises.readdir(SICHERUNG_DIR); } catch (e) { if (e.code !== 'ENOENT') return; }
  for (const tag of tage) if (!await liesOrdner(path.join(SICHERUNG_DIR, tag), ['wallets.json', 'gifts.json'])) return;
  for (const f of ['wallets.json.bak', 'gifts.json.bak']) {
    try { sammle(await fs.promises.readFile(path.join(DATA, f), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') return; }
  }
  // Kandidaten: nicht benutzt und seit 2 Tagen nicht angefasst
  const kandidaten = [];
  for (const f of dateien) {
    if (!BILD_NAME.test(f) || benutzt.has(f)) continue;
    try {
      const st = await fs.promises.stat(path.join(BILD_DIR, f));
      if (Date.now() - st.mtimeMs > 2 * 86400e3) kandidaten.push(f);
    } catch { /* weg */ }
  }
  // Ab hier ohne await: den aktuellen Stand im Speicher nochmal sammeln und
  // sofort loeschen — dazwischen kann keine Anfrage einen Verweis anlegen
  sammle(JSON.stringify(wallets));
  sammle(JSON.stringify(gifts));
  for (const a of Object.values(archivCache)) sammle(JSON.stringify(a));
  for (const e of Object.values(speicherQueue)) if (e.obj) sammle(JSON.stringify(e.obj));
  let weg = 0;
  for (const f of kandidaten) {
    if (benutzt.has(f)) continue;
    try {
      const st = fs.statSync(path.join(BILD_DIR, f));
      if (Date.now() - st.mtimeMs <= 2 * 86400e3) continue;
      fs.rmSync(path.join(BILD_DIR, f), { force: true });
      bildDateien.delete(f);
      weg++;
    } catch { /* egal */ }
  }
  if (weg) console.log(`[Bilder] ${weg} unbenutzte Bilder entfernt`);
}

// ---------------------------------------------------------------- Wallet-Kern
// Grenzen pro Wallet, mit Ansage: so viele Gutscheine/Karten kann man anlegen
// (die App zeigt "61 von 500"). Gerechnet fuer ein Handy mit vielen Fotos und
// den gemeinsamen Speicher am Server — siehe WALLET_LIMIT in app.js.
// Die Notbremse darueber schneidet nie still ab: was sie trifft, kommt in den
// Papierkorb (frueher fielen bei 300/100 Eintraege einfach weg).
const WALLET_LIMIT_GUTSCHEINE = 500;
const WALLET_LIMIT_KARTEN = 100;
const WALLET_MAX_GUTSCHEINE = 1000;
const WALLET_MAX_KARTEN = 300;
// Loeschmarker halten zwei Jahre (frueher 180 Tage / 500 Stueck — danach
// konnte ein altes Handy Geloeschtes und Verschenktes wiederbeleben)
const LOESCHMARKER_TAGE = 730;
const LOESCHMARKER_MAX = 20000;

// Buchungen, die nur die unterlegene Fassung kennt (zweites Geraet hat
// offline abgebucht), gehen nicht verloren: sie werden nachgetragen. Ebenso
// ein Rueckgaengig, das nur dort passiert ist. Jede Buchung hat eine eigene ID.
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
  tx.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return { ...sieger, tx, balance };
}
// Konflikt bei gleicher ID: zuletzt BEARBEITETE Fassung gewinnt (mt), sonst
// die mit mehr Buchungen. Ein Bild geht dabei nie verloren (ein Handy mit
// vollem Speicher schickt Eintraege ohne Bilder), Buchungen auch nicht.
function waehleFassung(a, o) {
  let s;
  if ((a.mt || 0) !== (o.mt || 0)) s = (a.mt || 0) > (o.mt || 0) ? a : o;
  else s = ((o.tx || []).length > (a.tx || []).length) ? o : a;
  const sieger = s;
  const n = s === a ? o : a;
  // Das juengere Bild gewinnt fuer sich (bildMt) — ein altes Geraet mit
  // spaeterer Abbuchung ueberschreibt ein neues Foto nicht. Aber nur ein
  // Bild, das es auch gibt.
  if ((n.bildMt || 0) > (s.bildMt || 0) && hatBild(n)) {
    s = { ...s, codeImg: n.codeImg || '', img: n.img || '', bildMt: n.bildMt, ...(n.orig ? { orig: n.orig } : {}) };
  }
  s = mischeBuchungen(s, n);
  // Neu Entstandenes (Buchung/Rueckgaengig, neueres Bild) ist juenger als
  // beide Vorlagen — sonst erkennt das Geraet die Aenderung nie. Ein bloss
  // aufgefuelltes Bild (unten) zaehlt nicht: sonst wanderten Bilder endlos hin und her.
  if (s !== sieger) s = { ...s, mt: Math.max(a.mt || 0, o.mt || 0) + 1 };
  // Fehlt der Gewinner-Fassung das Bild (oder zeigt sie auf eine fehlende
  // Datei), kommt es von der anderen
  if (!hatBild(s) && hatBild(n)) s = { ...s, codeImg: n.codeImg || '', img: n.img || '' };
  return s;
}
// Eingehenden Stand (ganz oder nur Geaendertes) mit dem Konto vereinigen.
// Fehlendes gilt nie als geloescht — geloescht wird nur per Loeschmarker.
// Was dabei aus der Wallet faellt, kommt in den Papierkorb.
function vereinigeWallet(user, inc) {
  (inc.vouchers || []).forEach(bilderAblegen);
  (inc.cards || []).forEach(bilderAblegen);
  // Geht die Uhr eines Handys weit vor, gewaenne es sonst jeden Konflikt
  const spaetestens = Date.now() + 10 * 60e3;
  for (const it of [...(inc.vouchers || []), ...(inc.cards || [])]) {
    if (it.mt > spaetestens) it.mt = spaetestens;
    if (it.bildMt > spaetestens) it.bildMt = spaetestens;
    delete it.bildSig; // nur fuer das Geraet gedacht
  }
  const cur = wallets[user] || { vouchers: [], cards: [], deleted: [] };
  const tombs = {};
  for (const t of [...(cur.deleted || []), ...(inc.deleted || [])]) {
    if (t && t.id) tombs[t.id] = Math.max(tombs[t.id] || 0, Number(t.ts) || 0);
  }
  const weg = [];
  const abgelehnt = [];
  const mergeList = (incList, curList, max) => {
    const curBy = new Map((curList || []).filter(x => x && x.id).map(x => [x.id, x]));
    const seen = new Set();
    let out = [];
    for (const it of incList) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.push(curBy.has(it.id) ? waehleFassung(it, curBy.get(it.id)) : it);
    }
    for (const it of curList || []) {
      if (!it || !it.id || seen.has(it.id)) continue;
      seen.add(it.id);
      out.push(it);
    }
    // Gelöscht bleibt gelöscht — außer der Eintrag wurde NACH der Löschung
    // neu angelegt (z. B. derselbe Gutschein zurückgeschenkt)
    const incBy = new Map(incList.map(x => [x.id, x]));
    const istTot = it => tombs[it.id] && tombs[it.id] >= Math.max(it.added || 0, it.wiederbelebt || 0);
    // Vom Aufraeumen entfernt, danach aber noch bearbeitet (aufgeladen,
    // Rueckgaengig)? Dann lebt er wieder auf — die Buchung darf nicht verloren gehen
    out = out.map(it => {
      const auto = (cur.autoWeg || {})[it.id];
      const neu = incBy.get(it.id);
      if (istTot(it) && auto && neu && (neu.mt || 0) > auto) {
        delete cur.autoWeg[it.id];
        // Immer juenger als der Loeschmarker, auch in derselben Millisekunde
        return { ...it, wiederbelebt: Math.max(Date.now(), (tombs[it.id] || 0) + 1) };
      }
      return it;
    });
    out = out.filter(it => {
      const tot = istTot(it);
      const neu = incBy.get(it.id);
      if (tot && curBy.has(it.id)) weg.push({ it: curBy.get(it.id), grund: 'gelöscht' });
      // Eine nach der Loeschung noch geaenderte Fassung kommt in den Papierkorb
      if (tot && neu && !curBy.has(it.id) && (neu.mt || 0) > tombs[it.id]) weg.push({ it: neu, grund: 'nach dem Löschen noch geändert' });
      return !tot;
    });
    if (out.length > max) {
      // Nur NEUE Eintraege ablehnen — was schon am Konto liegt, bleibt
      let platz = max - out.filter(it => curBy.has(it.id)).length;
      out = out.filter(it => {
        if (curBy.has(it.id)) return true;
        if (platz > 0) { platz--; return true; }
        abgelehnt.push(it.id);
        return false;
      });
    }
    return out;
  };
  const vouchers = mergeList(inc.vouchers || [], cur.vouchers, WALLET_MAX_GUTSCHEINE);
  const cards = mergeList(inc.cards || [], cur.cards, WALLET_MAX_KARTEN);
  const deleted = Object.entries(tombs)
    .filter(([, ts]) => Date.now() - ts < LOESCHMARKER_TAGE * 86400e3)
    .sort((x, y) => x[1] - y[1])
    .slice(-LOESCHMARKER_MAX)
    .map(([id, ts]) => ({ id, ts }));
  for (const { it, grund } of weg) archiviere(user, [it], grund);
  wallets[user] = slimWallet({ vouchers, cards, deleted, ts: Date.now(),
    ...(cur.statistik ? { statistik: cur.statistik } : {}),
    ...(cur.autoWeg && Object.keys(cur.autoWeg).length ? { autoWeg: cur.autoWeg } : {}) });
  if (Object.keys(tombs).length) origAufraeumen(user, tombs, wallets[user]);
  return { vouchers: wallets[user].vouchers, cards: wallets[user].cards, deleted, abgelehnt };
}
// Inhaltsverzeichnis: pro Eintrag ID, zuletzt bearbeitet, Zahl der Buchungen,
// Bild ja/nein und angelegt am (gegen Loeschmarker). Daran erkennt ein Geraet,
// was ihm fehlt — ohne Megabytes.
function walletIndex(w) {
  const zeile = x => [x.id, x.mt || 0, (x.tx || []).length, hatBild(x) ? 1 : 0, Math.max(x.added || 0, x.wiederbelebt || 0)];
  return { v: (w.vouchers || []).filter(x => x && x.id).map(zeile), c: (w.cards || []).filter(x => x && x.id).map(zeile) };
}

// ---- Rabattcodes verschenken. Eingeloest oder abgelaufen geht nicht: sonst
// kaeme beim Freund ein toter Code an. Geprueft wird die Fassung, die
// tatsaechlich rausginge (die gewinnende aus Konto und Geraet).
function rabattNichtVerschenkbar(v) {
  if (!v) return 'Rabattcode nicht gefunden.';
  if (v.eingeloest) return 'Eingelöste Rabattcodes kann man nicht verschenken.';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v.end || '')) && v.end < berlinTag(Date.now())) return 'Abgelaufene Rabattcodes kann man nicht verschenken.';
  return '';
}
// Hat der Empfaenger denselben Code derselben Marke schon (Wallet oder
// wartendes Geschenk)? Ohne Code ist nichts doppelt.
function rabattSchonDa(user, v) {
  const code = String(v && v.code || '').replace(/\s+/g, '').toLowerCase();
  if (!code) return false;
  const marke = String(v.vendor || '').trim().toLowerCase();
  const gleich = x => x && x.art === 'rabatt' && !x.eingeloest
    && String(x.code || '').replace(/\s+/g, '').toLowerCase() === code
    && String(x.vendor || '').trim().toLowerCase() === marke;
  return ((wallets[user] && wallets[user].vouchers) || []).some(gleich) || (gifts[user] || []).some(gleich);
}
// Felder eines verschenkten Rabattcodes wie beim Anlegen in der App: Zahlen
// groesser 0 (auf Cent), feste Einheit, Code ohne Leerzeichen, nie Guthaben
function rabattFelderSaeubern(v) {
  const zahl = x => {
    const n = Number(x);
    return x == null || x === '' || !Number.isFinite(n) || n <= 0 ? null : Math.round(Math.min(n, 1e6) * 100) / 100;
  };
  v.art = 'rabatt';
  v.rabatt = zahl(v.rabatt);
  v.rabattArt = v.rabattArt === 'pct' ? 'pct' : 'eur';
  v.mbw = zahl(v.mbw);
  v.code = String(v.code || '').replace(/\s+/g, '').slice(0, 40);
  v.end = /^\d{4}-\d{2}-\d{2}$/.test(String(v.end || '')) ? v.end : '';
  v.eingeloest = 0;
  v.pin = '';
  v.amount = null;
  v.balance = null;
  v.tx = [];
  return v;
}

// ---- Papierkorb: jede Fassung, die aus einer Wallet verschwindet (geloescht,
// verschenkt, abgeschnitten), liegt hier ein Jahr lang und laesst sich
// wiederherstellen. Genau das fehlte, als ein ausgepacktes Geschenk
// verschwand. Eine Datei pro Nutzer, damit nicht bei jeder Loeschung eine
// riesige Datei neu geschrieben wird.
const ARCHIV_DIR = path.join(DATA, 'archiv');
const ARCHIV_TAGE = 365;
const ARCHIV_MAX_BYTES = 60_000_000; // pro Nutzer; darueber fliegt das Aelteste
const archivCache = {};
function archivDatei(user) { return path.join('archiv', Buffer.from(String(user)).toString('hex') + '.json'); }
function archivVon(user) {
  if (!archivCache[user]) archivCache[user] = loadJson(archivDatei(user), {});
  return archivCache[user];
}
function archiviere(user, items, grund) {
  if (!user || !items || !items.length) return;
  fs.mkdirSync(ARCHIV_DIR, { recursive: true });
  const a = archivVon(user);
  const jetzt = Date.now();
  for (const it of items) {
    if (!it || !it.id) continue;
    a[it.id + ':' + jetzt] = { v: it, ts: jetzt, grund, typ: it.vendor !== undefined ? 'gutschein' : 'karte' };
  }
  // Aufraeumen: zu alt raus, dann nach Groesse vom Aeltesten her
  const eintraege = Object.entries(a).filter(([, e]) => jetzt - e.ts < ARCHIV_TAGE * 86400e3).sort((x, y) => y[1].ts - x[1].ts);
  let summe = 0;
  const behalten = {};
  for (const [k, e] of eintraege) {
    summe += JSON.stringify(e).length;
    if (summe > ARCHIV_MAX_BYTES) break;
    behalten[k] = e;
  }
  archivCache[user] = behalten;
  saveJsonSoon(archivDatei(user), behalten, 1000);
}
function archivFlush() {
  for (const [user, a] of Object.entries(archivCache)) {
    try { schreibeAtomarSync(archivDatei(user), a); } catch { /* egal */ }
  }
}
function archivVergessen(user) {
  // Vorgemerkte Schreibvorgaenge fuer diesen Papierkorb verwerfen
  const e = speicherQueue[archivDatei(user)];
  if (e) { clearTimeout(e.timer); e.timer = null; e.obj = null; e.geschrieben = ++e.nr; }
  delete archivCache[user];
}
function archivUmbenennen(alt, neu) {
  const a = archivVon(alt);
  archivCache[neu] = { ...archivVon(neu), ...a };
  archivVergessen(alt);
  fs.mkdirSync(ARCHIV_DIR, { recursive: true });
  saveJson(archivDatei(neu), archivCache[neu]);
  for (const f of [archivDatei(alt), archivDatei(alt) + '.bak']) fs.rmSync(path.join(DATA, f), { force: true });
}
function archivLoeschen(user) {
  archivVergessen(user);
  for (const f of [archivDatei(user), archivDatei(user) + '.bak']) fs.promises.rm(path.join(DATA, f), { force: true }).catch(() => {});
}

// ---- Tages-Schnappschuss: einmal am Tag wallets/gifts/users kopieren, die
// letzten 7 Tage bleiben. Das Netz unter dem Netz.
const SICHERUNG_DIR = path.join(DATA, 'sicherung');
const AUFGEBRAUCHT_TAGE = 30;
// Eingefuehrt am 24.09.2026: davor Aufgebrauchtes zaehlt ab diesem Tag — so
// sieht jeder den Hinweis "wird am … entfernt" 30 Tage vorher und kann es abschalten
const AUFRAEUMEN_AB = Date.parse('2026-09-24T00:00:00Z');
// Update-Log (public/neuigkeiten.json, neueste Fassung zuerst). Gelesen beim
// Start — jedes Update ist ein neuer Deploy und damit ein neuer Start.
function ladeNeuVersionen() {
  try {
    const l = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'neuigkeiten.json'), 'utf8'));
    return Array.isArray(l) ? l.map(e => String((e && e.v) || '')).filter(Boolean) : [];
  } catch { return []; }
}
const NEU_VERSIONEN = ladeNeuVersionen();

// Wallet-PIN des Kontos (gilt auf allen Geraeten). Gespeichert wird nur der
// PBKDF2-Hash, den das Geraet berechnet — genau wie lokal. Entsperrt wird
// weiter auf dem Geraet (auch offline); aendern und entfernen geht nur ueber
// das Konto, mit der bisherigen PIN (bzw. dem Passwort bei "PIN vergessen").
function pinRecordPruefen(r) {
  if (!r || typeof r !== 'object') return null;
  const salt = String(r.salt || ''), hash = String(r.hash || '');
  const iter = Number(r.iter), laenge = Number(r.laenge);
  if (!/^[A-Za-z0-9+/]{22}==$/.test(salt) || !/^[A-Za-z0-9+/]{43}=$/.test(hash)) return null;
  if (!Number.isInteger(iter) || iter < 100000 || iter > 1000000) return null;
  if (!Number.isInteger(laenge) || laenge < 4 || laenge > 6) return null;
  return { salt, hash, iter, laenge };
}
const pbkdf2Async = require('util').promisify(crypto.pbkdf2);
async function kontoPinStimmt(rec, pin) {
  const p = String(pin || '');
  if (!rec || !/^\d{4,6}$/.test(p) || p.length !== rec.laenge) return false;
  // Im Thread-Pool rechnen: 150 000 Runden sollen den Server nicht anhalten
  const ist = await pbkdf2Async(p, Buffer.from(rec.salt, 'base64'), rec.iter, 32, 'sha256');
  const soll = Buffer.from(rec.hash, 'base64');
  return soll.length === ist.length && crypto.timingSafeEqual(soll, ist);
}
function pinFuerGeraet(u) {
  return u && u.walletPin ? { salt: u.walletPin.salt, hash: u.walletPin.hash, iter: u.walletPin.iter, laenge: u.walletPin.laenge, ts: u.walletPin.ts } : null;
}

// Laden-Erkennung: Laeden rund um einen gerundeten Punkt (~100 m Raster) aus
// OpenStreetMap (Overpass). Die Position wird nicht gespeichert und nicht
// protokolliert; nur die Laden-Liste pro Rasterzelle bleibt 24 h im Speicher
// (schont Overpass, dessen Nutzungsregeln sparsame Abfragen verlangen).
const laedenCache = new Map();    // "lat,lon" -> { ts, liste }
const laedenLaeuft = new Map();   // "lat,lon" -> Promise (gleiche Zelle = eine Abfrage)
const laedenFehler = new Map();   // "lat,lon" -> ts (Fehlschlag 60 s merken)
let laedenAktiv = 0, laedenMinute = { t: 0, n: 0 }, laedenEintraege = 0;
function laedenUm(lat, lon) {
  const key = lat.toFixed(3) + ',' + lon.toFixed(3);
  const c = laedenCache.get(key);
  if (c && Date.now() - c.ts < 24 * 3600e3) return Promise.resolve(c.liste);
  if (Date.now() - (laedenFehler.get(key) || 0) < 60e3) return Promise.reject(new Error('eben erst fehlgeschlagen'));
  if (laedenLaeuft.has(key)) return laedenLaeuft.get(key);
  // Fuer alle zusammen: hoechstens 2 gleichzeitig und 30 pro Minute an Overpass
  const jetzt = Date.now();
  if (jetzt - laedenMinute.t > 60e3) laedenMinute = { t: jetzt, n: 0 };
  if (laedenAktiv >= 2 || laedenMinute.n >= 30) return Promise.reject(new Error('Overpass ausgelastet'));
  laedenAktiv++;
  laedenMinute.n++;
  const lauf = laedenHolen(lat, lon, key)
    .catch(e => { laedenFehler.set(key, Date.now()); if (laedenFehler.size > 2000) laedenFehler.clear(); throw e; })
    .finally(() => { laedenAktiv--; laedenLaeuft.delete(key); });
  laedenLaeuft.set(key, lauf);
  return lauf;
}
async function laedenHolen(lat, lon, key) {
  const um = `around:260,${lat},${lon}`;
  const q = `[out:json][timeout:8];(nwr(${um})["shop"];nwr(${um})["amenity"~"^(fast_food|restaurant|cafe|pharmacy|fuel|ice_cream)$"];);out center tags 150;`;
  // Overpass ist oft kurz ueberlastet (429/504, Zeitueberschreitung): ein
  // zweiter Versuch nach kurzer Pause rettet die meisten Abfragen
  let j = null;
  for (let versuch = 0; versuch < 2 && !j; versuch++) {
    if (versuch) await new Promise(r => setTimeout(r, 2500));
    const ctl = new AbortController();
    const uhr = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'kumulio.de Laden-Erkennung' },
        body: 'data=' + encodeURIComponent(q), signal: ctl.signal,
      });
      if (r.ok) j = await r.json();
      // Auch mit 200 kann Overpass abgebrochen haben ("remark: runtime error")
      if (j && j.remark && /error|timed out/i.test(j.remark)) j = null;
      if (!j && versuch) throw new Error('Overpass ' + r.status);
    } catch (e) { if (versuch) throw e; }
    finally { clearTimeout(uhr); }
  }
  const liste = ((j && j.elements) || []).map(e => ({
    n: String((e.tags && e.tags.name) || '').slice(0, 60),
    b: String((e.tags && e.tags.brand) || '').slice(0, 40),
    lat: e.lat ?? (e.center && e.center.lat), lon: e.lon ?? (e.center && e.center.lon),
  })).filter(x => (x.n || x.b) && Number.isFinite(x.lat) && Number.isFinite(x.lon)).slice(0, 150);
  // Speicher begrenzt nach Eintraegen, nicht nach Zellen (volle Innenstaedte sind gross)
  while (laedenCache.size && laedenEintraege + liste.length > 200000) {
    const [altKey, alt] = laedenCache.entries().next().value;
    laedenEintraege -= alt.liste.length;
    laedenCache.delete(altKey);
  }
  laedenCache.set(key, { ts: Date.now(), liste });
  laedenEintraege += liste.length;
  return liste;
}
// Letzte Bewegung eines Gutscheins: juengste Buchung, sonst angelegt am
// (Schleife statt Spread: sehr viele Buchungen sprengten sonst den Stack)
function letzteBewegung(v) {
  let m = Math.max(Number(v.added) || 0, Number(v.wiederbelebt) || 0);
  for (const t of Array.isArray(v.tx) ? v.tx : []) { const ts = Number(t && t.ts) || 0; if (ts > m) m = ts; }
  return m;
}
function aufgebrauchtWeg(v, jetzt = Date.now()) {
  return !!v && v.balance != null && v.balance <= 0
    && Math.max(letzteBewegung(v), AUFRAEUMEN_AB) < jetzt - AUFGEBRAUCHT_TAGE * 86400e3;
}
// Was ein aufgeraeumter Gutschein zur Statistik beigetragen hat, bleibt als
// Monatssumme erhalten (Analyse "Rein und raus")
function statistikMerken(w, v) {
  const st = w.statistik || (w.statistik = {});
  const monat = ts => { const d = new Date(ts); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); };
  const dazu = (ts, rein, raus) => {
    if (!ts) return;
    const k = monat(ts);
    const e = st[k] || (st[k] = { rein: 0, raus: 0 });
    e.rein = Math.round((e.rein + rein) * 100) / 100;
    e.raus = Math.round((e.raus + raus) * 100) / 100;
  };
  if (v.amount != null && Number.isFinite(Number(v.amount))) dazu(v.added, Number(v.amount), 0);
  for (const t of Array.isArray(v.tx) ? v.tx : []) {
    if (!t || t.reverted || !Number.isFinite(Number(t.amt))) continue;
    const a = Number(t.amt);
    dazu(t.ts, a > 0 ? a : 0, a < 0 ? -a : 0);
  }
}
function raeumeAufgebrauchteAuf() {
  let gesamt = 0;
  try {
    for (const [user, w] of Object.entries(wallets)) {
      // Ein kaputter Eintrag bei einem Konto darf das Aufraeumen der anderen nicht stoppen
      try {
        if (!w || !Array.isArray(w.vouchers) || !users[user] || profileOf(user).autoAufraeumen === false) continue;
        const weg = w.vouchers.filter(v => v && v.id && aufgebrauchtWeg(v));
        if (!weg.length) continue;
        archiviere(user, weg, `aufgebraucht, nach ${AUFGEBRAUCHT_TAGE} Tagen entfernt`);
        for (const v of weg) statistikMerken(w, v);
        const ids = new Set(weg.map(v => v.id));
        w.vouchers = w.vouchers.filter(v => v && !ids.has(v.id));
        // Loeschmarker, damit die Geraete ihn auch entfernen; autoWeg merkt, dass
        // es das Aufraeumen war (wird danach noch gebucht, lebt er wieder auf)
        const jetzt = Date.now();
        w.deleted = [...(w.deleted || []), ...weg.map(v => ({ id: v.id, ts: jetzt }))].slice(-LOESCHMARKER_MAX);
        w.autoWeg = { ...(w.autoWeg || {}) };
        for (const v of weg) w.autoWeg[v.id] = jetzt;
        ssePush('gift', user); // offene App holt den neuen Stand
        gesamt += weg.length;
      } catch (e) { console.error('[Wallet] Aufraeumen bei', user, e.message); }
    }
  } finally {
    if (gesamt) { saveJson('wallets.json', wallets); console.log(`[Wallet] ${gesamt} aufgebrauchte Gutscheine nach ${AUFGEBRAUCHT_TAGE} Tagen entfernt`); }
  }
  return gesamt;
}
async function sichereTaeglich() {
  // Aufraeumen erst NACH der Tages-Sicherung (siehe unten)
  const aufraeumen = () => { try { raeumeAufgebrauchteAuf(); } catch (e) { console.error('[Wallet] Aufraeumen:', e.message); } };
  try {
    const tag = new Date().toISOString().slice(0, 10);
    const ordner = path.join(SICHERUNG_DIR, tag);
    if (fs.existsSync(path.join(ordner, 'wallets.json'))) { aufraeumen(); return; }
    await fs.promises.mkdir(ordner, { recursive: true });
    for (const f of ['users.json', 'gifts.json', 'wallets.json']) {
      await fs.promises.copyFile(path.join(DATA, f), path.join(ordner, f)).catch(() => {});
    }
    const tage = (await fs.promises.readdir(SICHERUNG_DIR)).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort();
    for (const alt of tage.slice(0, -7)) await fs.promises.rm(path.join(SICHERUNG_DIR, alt), { recursive: true, force: true });
  } catch (e) { console.error('[Sicherung]', e.message); }
  aufraeumen();
}
bilderAuslagernBestand();
if (!process.env.RA_TEST) {
  setTimeout(sichereTaeglich, 20_000);
  setInterval(sichereTaeglich, 3 * 3600e3);
  setTimeout(() => bilderAufraeumen().catch(() => { }), 60_000);
  setInterval(() => bilderAufraeumen().catch(() => { }), 12 * 3600e3);
}

// Aufraeumen: Originale geloeschter Gutscheine weg. Nur was einen Loeschmarker
// hat, NICHT mehr in der Wallet steht und auch nicht als Geschenk auf den
// Nutzer wartet (zurueckgeschenkte Gutscheine behalten ihre ID).
async function origAufraeumen(user, tombs, wallet) {
  let dateien;
  try { dateien = await fs.promises.readdir(origOrdner(user)); } catch { return; }
  const lebt = new Set([...(wallet.vouchers || []), ...(gifts[user] || [])].map(v => v && v.id));
  for (const f of dateien) {
    const id = f.replace(/\.jpg$/, '');
    // 30 Tage Frist: so lange laesst sich ein Gutschein samt Originalfoto aus dem Papierkorb holen
    if (tombs[id] && !lebt.has(id) && Date.now() - tombs[id] > 30 * 86400e3) fs.promises.rm(path.join(origOrdner(user), f), { force: true }).catch(() => {});
  }
}

// Hochfrequente Dateien (Chat, Quest-Zähler, Wallets) werden gebündelt und
// asynchron geschrieben: writeFileSync bei jeder Nachricht blockierte sonst
// ALLE parallelen Anfragen (spürbar als "der Server ist langsam")
// saveJsonSoon: buendelt haeufige Aenderungen (Wallet-Syncs, Quests), schreibt
// aber spaetestens nach 2 s — auch wenn staendig neue Aenderungen kommen.
// Pro Datei laeuft immer nur ein Schreibvorgang; was waehrenddessen kommt,
// wird danach geschrieben. Siehe schreibeJetzt/schreibeSpaeter oben.
function saveJsonSoon(name, obj, delay = 400) {
  const e = speicherEintrag(name);
  e.obj = obj;
  if (!e.erstesMal) e.erstesMal = Date.now();
  clearTimeout(e.timer);
  const warte = Math.max(0, Math.min(delay, e.erstesMal + 2000 - Date.now()));
  e.timer = setTimeout(() => schreibeSpaeter(name), warte);
}

// ---------------------------------------------------------------- Echtzeit (SSE)
// Chat und DMs kommen per Push statt 3-Sekunden-Poll: der Server schickt nur
// einen Ping, der Client holt sich die Nachrichten über die bewährten Routen
const sseClients = new Set(); // { res, user }
function ssePush(event, targetUser) {
  for (const c of sseClients) {
    if (targetUser && c.user !== targetUser) continue;
    try { c.res.write(`event: ${event}\ndata: 1\n\n`); } catch { }
  }
}

// ---------------------------------------------------------------- Chat
// Nur Angemeldete schreiben. Beleidigungen werden ZENSIERT (nicht gesperrt).
//
// Emotes (Runde 117): nur noch Katzen und Peepo, und JEDER hat alle — kein
// Ziehen, kein Besitz, keine Sperre. Das fruehere 7TV-Global-Set (taeglich
// nachgeladen) ist raus; was damals ein Emote war, bleibt jetzt einfach Text.
// IDs per 7TV-Suche geprueft (exakter Name, meistgenutzte Fassung; peepoHappy
// und peepoSad wie bisher aus dem 7TV-Global-Set). Die Reihenfolge ist die der
// Auswahl im Chat; alle Peepo-Namen beginnen mit "peepo", daran trennt der
// Client die beiden Gruppen.
const CHAT_EMOTES = {
  katzen: {
    catJAM: '01F6MQ33FG000FFJ97ZB8MWV52', catKISS: '01F5VW2TKR0003RCV2Z6JBHCST',
    catNod: '01FNMBRDN8000EJT2EVEY3EM1H', catHug: '01FE41JXAR0005TJYSHSM7H0M0',
    catLove: '01FF96FQX0000BX5VYPPT3DJBN', catSmile: '01GEW2VN9R000CVCCAKC8CXYVZ',
    catLaugh: '01J18BVVJR0006YAS4XFND8Y6J', catWave: '01FZG4KHXG000063WVYFWX9R94',
    PopCat: '01F6NPEJT0000B70V1XA8MNBC9', catStare: '01H68Y2FC80009YCVDSFDE7DMD',
    catSip: '01GNCJDPY8000AWA0BMNWRBG2P', CatSad: '01F9Y0VE80000FYYWK8DDFTGRY',
    catBlush: '01F6ZMGM2G000A63TGZWCPNF0V', meow: '01F6NCKMP000052X5637DW2XDY',
  },
  peepo: {
    peepoHappy: '01GAZ199Z8000FEWHS6AT5QZV0', peepoSad: '01GAZ4SBX80007YCE2RXBT44B2',
    peepoLove: '01F6NPP6YG00013ACMMJP3W06V', peepoHey: '01F6NMMEER00015NVG2J8ZH77N',
    peepoBye: '01F6Q09DJR00015Y8FNQBDEPQK', peepoShy: '01GK4EW2AG0004SH49XX2J74KJ',
    peepoGiggles: '01F6NTA4X80007X1R6PNS21T6E', peepoClap: '01F6NET6G00009JYTB75QDKV1S',
    peepoWow: '01F6NCGF40000E0GG0PF8N52TV', peepoThink: '01F84YS0W80006DA4ATKNFKPV0',
    peepoRich: '01F8N4K8XR0005WVNRT1191P1R', peepoGift: '01GHR5AGZR00058M1GCX0RKE23',
    peepoCry: '01FC93557G000865A5YMK9D4S2', peepoComfy: '01FAJRZBRR0002R979W3KES4A1',
  },
};
// Name → 7TV-ID in Auswahl-Reihenfolge (Katzen, dann Peepo)
const EMOTE_IDS = { ...CHAT_EMOTES.katzen, ...CHAT_EMOTES.peepo };

// Rollen: LUTHER ist fest Admin, weitere Rollen liegen am Nutzer (users[x].role)
const DEFAULT_ADMINS = ['luther'];
function roleOf(user) {
  if (!user) return '';
  if (DEFAULT_ADMINS.includes(user.toLowerCase())) return 'admin';
  return (users[user] && users[user].role) || '';
}
const isModUser = u => ['admin', 'mod'].includes(roleOf(u));

let chat = loadJson('chat.json', { messages: [], mutes: {}, bans: {}, pinned: null });
let dms = loadJson('dms.json', {});      // { "a|b": {msgs:[{id,from,text,ts}], reads:{user:ts}} }
let reports = loadJson('reports.json', []);
const dmKey = (a, b) => [a, b].sort().join('|');
const chatBurst = {}; // user -> [ts, ts, ts] — 3 schnelle Nachrichten frei, dann bremsen
const BAD_WORDS = /hurensohn|hurentochter|fotze|wichser|missgeburt|schlampe|arschloch|spast(i|en)?|behindert(er|e)?|nutte|fick\s*dich|verpiss|fu+ck(er|\s*you)?|bitch|asshole|cunt|nigg\w*|fag(got)?|hitler|nazi/gi;
function censor(text) {
  return text.replace(BAD_WORDS, m => m[0] + '*'.repeat(Math.max(2, m.length - 1)));
}

function profileOf(user) {
  const u = users[user];
  if (!u.profile) u.profile = { bio: '', publicProfile: true };
  return u.profile;
}

// ---------------------------------------------------------------- Profil: Namensfarbe, Login-Serie, Einladungen
//
// Kisten, Funken, Quests, Paints, Rahmen, Badges und der Punkte-Rang sind
// raus (Wunsch des Nutzers, Runde 117). Die alten Felder bleiben in users.json
// liegen (coins, cases, paints …), gelesen werden sie nicht mehr. Die
// Endpunkte dazu antworten mit 410 (siehe GAMI_WEG).

// Namensfarbe: frei waehlbar, gespeichert als #rrggbb. Wer keine gewaehlt
// hat, bekommt im Client die feste Chat-Farbe seines Namens.
const FARBE_OK = /^#[0-9a-f]{6}$/i;
function namensfarbe(user) {
  const f = users[user] && users[user].profile && users[user].profile.nameColor;
  return typeof f === 'string' && FARBE_OK.test(f) ? f.toLowerCase() : null;
}

// Rang-Stufe 1..7 nach dem Wallet-Guthaben — genau wie im Client (RANKS,
// rankFor und rangGuthaben in app.js): Restguthaben aller Gutscheine ohne
// Rabattcodes, auf den Cent gerundet; Stufe N beginnt beim N-ten Betrag (in
// Cent: "ueber 10 €" heisst ab 10,01 €). Nach aussen geht nur diese Zahl
// (Farbe fremder Profile), nie das Guthaben.
const RANG_AB_CENT = [0, 1001, 5001, 15001, 30001, 60001, 100001];
function rangStufe(user) {
  const vs = (wallets[user] && wallets[user].vouchers) || [];
  const aktiv = vs.filter(v => v && v.art !== 'rabatt' && (v.balance == null || v.balance > 0));
  const total = Math.round(aktiv.reduce((s, v) => s + (Number(v.balance) || 0), 0) * 100) / 100;
  const cent = Math.round(total * 100);
  let stufe = 1;
  RANG_AB_CENT.forEach((ab, i) => { if (cent >= ab) stufe = i + 1; });
  return stufe;
}

// Anzeigename: steht vorne, wo andere einen sehen (Chat, Freunde, Kommentare,
// Geschenke). Der @Name bleibt der feste Schluessel des Kontos — ab der
// Registrierung, geaendert wird er nur auf Anfrage vom Team (kontoUmbenennen).
// Leer = es steht der @Name da. Aendern geht alle 7 Tage, das erste Mal sofort.
const ANZEIGENAME_TAGE = 7;
// Lateinische Buchstaben samt Umlauten, ß und Akzenten (auch Tuerkisch,
// Polnisch …), Ziffern, Leerzeichen und ._- — keine Emojis, keine
// Steuerzeichen und keine fremden Schriften, die wie lateinische aussehen
const ANZEIGENAME_OK = /^[A-Za-z0-9\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u017F ._-]{2,24}$/;
// Vergleichsform gegen Verwechslung: klein, ohne Akzente, ohne Leer- und
// Trennzeichen ("Anna B." ~ "anna_b", "Lüther" ~ "luther"). Dazu die Zeichen,
// die in der App-Schrift gleich aussehen: grosses I, kleines l und 1 ("Iuther"
// ~ "luther"), 0 und o, rn und m.
const nameSkelett = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[\s._-]+/g, '').replace(/[il1]/g, 'l').replace(/0/g, 'o').replace(/rn/g, 'm');
// Woerter, die nach dem kumulio-Team klingen, gibt es nur fuer das Team
// (verglichen in der Vergleichsform, also auch "Adm1n" oder "Supp0rt")
const ANZEIGENAME_RESERVIERT = new Set(['admin', 'administrator', 'mod', 'moderator', 'moderation', 'support', 'team', 'offiziell', 'official'].map(nameSkelett));
// Fuer den Wortfilter: Ziffern, die fuer Buchstaben stehen ("H1tler")
const ohneZiffernTrick = s => s.toLowerCase().replace(/[013457]/g, z => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' })[z]);
const anzeigenameVon = user => {
  const a = users[user] && users[user].profile && users[user].profile.anzeigename;
  return typeof a === 'string' ? a : '';
};
// Fuer einzelne Eintraege (Nachricht, Kommentar): nur, wenn einer gesetzt ist
const mitAnzeigename = user => { const a = anzeigenameVon(user); return a ? { anzeigename: a } : {}; };
// Fuer Namenslisten (Freunde, Anfragen, Geschenke): { "@Name": "Anzeigename" },
// ebenfalls nur die gesetzten — das haelt die Antworten klein
function anzeigeNamen(namen) {
  const m = {};
  for (const n of new Set(namen)) { const a = anzeigenameVon(n); if (a) m[n] = a; }
  return m;
}
// Push-Titel und Aehnliches: Anzeigename mit @Name dahinter, sonst der @Name
const nameFuerAndere = user => { const a = anzeigenameVon(user); return a ? `${a} (@${user})` : `@${user}`; };
// Prueft einen neuen Anzeigenamen. Liefert { name } (bereinigt, '' = zurueck
// auf den @Namen) oder { error }.
function anzeigenamePruefen(user, roh) {
  const name = String(roh || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!name) return { name: '' };
  if (!ANZEIGENAME_OK.test(name)) return { error: 'Anzeigename: 2 bis 24 Zeichen, nur Buchstaben, Zahlen, Leerzeichen und ._-' };
  const lesart = ohneZiffernTrick(name);
  if (censor(name) !== name || censor(lesart) !== lesart) return { error: 'Diesen Anzeigenamen können wir leider nicht nehmen.' };
  const sk = nameSkelett(name);
  if (sk.length < 2) return { error: 'Anzeigename: bitte mindestens zwei Buchstaben oder Zahlen.' };
  // Niemand soll wie ein anderes Konto aussehen: der Anzeigename darf keinem
  // fremden @Namen gleichen (der eigene geht)
  if (Object.keys(users).some(k => k !== user && nameSkelett(k) === sk))
    return { error: 'So heißt schon jemand mit @Namen. Bitte wähl einen anderen Anzeigenamen.' };
  if (roleOf(user) !== 'admin' && (sk.includes(nameSkelett('kumulio')) || name.split(/[\s._-]+/).some(w => ANZEIGENAME_RESERVIERT.has(nameSkelett(w)))))
    return { error: 'Namen, die nach dem kumulio-Team klingen, sind reserviert.' };
  return { name };
}
// Ab wann der Anzeigename wieder geaendert werden darf (0 = jetzt)
function anzeigenameAb(prof, jetzt = Date.now()) {
  const ab = (Number(prof.anzeigenameTs) || 0) + ANZEIGENAME_TAGE * 864e5;
  return prof.anzeigenameTs && ab > jetzt ? ab : 0;
}

// Login-Serie: aufeinanderfolgende Kalendertage (Europe/Berlin), an denen man
// angemeldet in der App war. Gezaehlt wird beim Abruf von /api/me und
// /api/profile; es gibt dafuer nichts, sie steht nur im eigenen Profil.
const BERLIN_TAG = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
const berlinTag = ts => BERLIN_TAG.format(new Date(ts)); // "2026-09-24"
function tagDavor(tag) {
  const d = new Date(tag + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
// true = heute neu gezaehlt (dann speichern)
function zaehleLoginTag(prof, jetzt = Date.now()) {
  const heute = berlinTag(jetzt);
  const s = prof.loginStreak && typeof prof.loginStreak === 'object' ? prof.loginStreak : { tage: 0, rekord: 0, letzterTag: '' };
  prof.loginStreak = s;
  if (s.letzterTag === heute) return false;
  s.tage = s.letzterTag === tagDavor(heute) ? (Number(s.tage) || 0) + 1 : 1;
  s.rekord = Math.max(Number(s.rekord) || 0, s.tage);
  s.letzterTag = heute;
  return true;
}
// Was angezeigt wird: eine Serie, die vor gestern endete, ist vorbei
function loginSerie(prof, jetzt = Date.now()) {
  const s = prof.loginStreak || {};
  const heute = berlinTag(jetzt);
  const laeuft = s.letzterTag === heute || s.letzterTag === tagDavor(heute);
  return { tage: laeuft ? Number(s.tage) || 0 : 0, rekord: Number(s.rekord) || 0 };
}
// Geworbene Freunde: vorgemerkt fuer spaetere Belohnungen, heute gibt es nichts.
// refCount stammt aus der Zeit mit Funken-Bonus und zaehlt mit.
const eingeladenZahl = prof => Math.max(Number(prof.refCount) || 0, (prof.geworben || []).length);
// Eintraege aus geworben streichen. Der Zaehler sinkt mit: jeder Eintrag kam
// mit einem refCount + 1 dazu. Alt-Einladungen ohne Eintrag bleiben stehen.
function geworbenEntfernen(prof, raus) {
  const liste = Array.isArray(prof.geworben) ? prof.geworben : [];
  const rest = liste.filter(g => !(g && raus(g)));
  const weg = liste.length - rest.length;
  if (weg) { prof.geworben = rest; prof.refCount = Math.max(0, (Number(prof.refCount) || 0) - weg); }
  return weg;
}
// Einmalig beim Start: Reste aus der Zeit, als das Loeschen eines Kontos die
// Einladungen noch nicht mitnahm. Aus geworben fliegt, wessen Konto weg ist
// oder dessen Name inzwischen einem spaeter angelegten Konto gehoert; je Name
// bleibt nur der juengste Eintrag. invitedBy auf einen geloeschten oder neu
// vergebenen Namen (Werber-Konto juenger als das eigene) faellt weg.
function einladungenAufraeumen() {
  let n = 0;
  for (const u of Object.values(users)) {
    const pr = u && u.profile;
    if (!pr) continue;
    if (Array.isArray(pr.geworben) && pr.geworben.length) {
      const juengster = {};
      for (const g of pr.geworben) if (g && g.user) juengster[String(g.user).toLowerCase()] = g;
      n += geworbenEntfernen(pr, g => {
        const konto = users[g.user];
        return !konto || (konto.ts || 0) > (g.ts || 0) || juengster[String(g.user).toLowerCase()] !== g;
      });
    }
    const werber = pr.invitedBy ? users[pr.invitedBy] : null;
    if (pr.invitedBy && (!werber || (werber.ts || 0) > (u.ts || Infinity))) { delete pr.invitedBy; n++; }
  }
  return n;
}
{
  const n = einladungenAufraeumen();
  if (n) { saveJson('users.json', users); console.log(`[Einladungen] ${n} veraltete Eintraege bereinigt`); }
}
// Das eigene Profil fuer den Client — nur, was er braucht (die Alt-Felder
// von frueher, z. B. tausende gesehene Gutschein-IDs, gehen nicht mehr mit)
function eigenesProfil(user) {
  const prof = profileOf(user);
  return {
    user, bio: prof.bio || '', publicProfile: prof.publicProfile !== false,
    avatar: prof.avatar || '', favs: prof.favs || {},
    friends: prof.friends || [], friendRequests: prof.friendRequests || [],
    nameColor: namensfarbe(user), loginStreak: loginSerie(prof),
    eingeladen: eingeladenZahl(prof),
    // "Kunde seit": Zeitpunkt der Registrierung (fehlt bei ganz alten Konten)
    seit: users[user].ts || null,
    // Anzeigename ('' = der @Name), wann er wieder aenderbar ist (0 = jetzt),
    // und die Anzeigenamen der Freunde und Anfragenden
    anzeigename: anzeigenameVon(user), anzeigenameAb: anzeigenameAb(prof),
    namen: anzeigeNamen([...(prof.friends || []), ...(prof.friendRequests || [])]),
  };
}
// Abgeschaltete Endpunkte (Kisten, Funken, Quests, Shop, Paints, Rahmen):
// 410 statt 404, damit klar ist: das gab es, und es ist bewusst weg
const GAMI_WEG = new Set([
  '/api/daily', '/api/gami', '/api/quests/claim', '/api/case/open', '/api/item/sell',
  '/api/item/sell-many', '/api/sticker/use', '/api/shop/buy', '/api/border', '/api/paint',
]);

const markLegacy = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { ...v, legacy: true }]));
// Nachrichten werden beim AUSLIEFERN mit der aktuellen Namensfarbe ihres
// Autors angereichert (Feld "paint", #rrggbb oder null): ein Farbwechsel wirkt
// damit sofort auf alle alten Nachrichten, gespeichert wird nichts um. Was
// alte Nachrichten noch an Badge, Rang oder Rahmen tragen, geht nicht mit raus
// — Raenge sind privat. Ebenso frisch: der Anzeigename (Feld "anzeigename",
// nur wenn gesetzt), er steht auch ueber geloeschten Nachrichten.
function withLiveLook(msgs, field) {
  return msgs.map(m => {
    const { badge, rank, border, paint, anzeigename, ...rest } = m;
    const name = m[field];
    const lebt = !!(name && users[name]);
    return { ...rest, paint: !m.deleted && lebt ? namensfarbe(name) : null, ...(lebt ? mitAnzeigename(name) : {}) };
  });
}

// Sticker: kuratierter, austauschbarer Pool (7TV-Global-Set, IDs verifiziert).
// Sticker klebt man auf Gutscheine in der Wallet — Position frei, max 4 pro Karte.
const STICKERS = {
  AYAYA: { id: '01GB32XE6R00018VJGJ4A9BNCV', rarity: 'epic' },
  PETPET: { id: '01FE3XY508000AA32JP519W2EW', rarity: 'epic' },
  PartyParrot: { id: '01FKSDK14G0008TM5NY9QEG0QV', rarity: 'rare' },
  AlienDance: { id: '01GB2ZJFBG000DTBJYANG8XYFP', rarity: 'rare' },
  glorp: { id: '01H16FA16G0005EZED5J0EY7KN', rarity: 'rare' },
  gachiGASM: { id: '01F9EM2ETG000E7SC8F953GXCX', rarity: 'rare' },
  peepoPls: { id: '01HM524VE80004SKSHMCZWXH1T', rarity: 'uncommon' },
  RareParrot: { id: '01GB4XE3ZR000DKFRGM9Q1M7VS', rarity: 'uncommon' },
  nanaAYAYA: { id: '01FTEZEE900001E12995B12GR4', rarity: 'uncommon' },
  BibleThump: { id: '01J8NMZ2HG0005G1FWF2H9Y615', rarity: 'uncommon' },
  RebeccaBlack: { id: '01GB5VC57000003DZTMZQNY944', rarity: 'uncommon' },
  BasedGod: { id: '01GB9W2CDG000BFSD141G0MGSA', rarity: 'uncommon' },
  RoxyPotato: { id: '01GB54CZTG0004ZBZEDT30HE2M', rarity: 'uncommon' },
  RainTime: { id: '01FCY771D800007PQ2DF3GDTN6', rarity: 'common' },
  TeaTime: { id: '01HM4P26CR000449DZBT4FVMA5', rarity: 'common' },
  WineTime: { id: '01HM4PGHC80007635TAZG67FT5', rarity: 'common' },
  PianoTime: { id: '01G98V81Q80000BRQD106P0ZEK', rarity: 'common' },
  GuitarTime: { id: '01G98V5RFG0001CD052SPS435F', rarity: 'common' },
  CrayonTime: { id: '01G98TT6BR000A39K5ZSQFTPWR', rarity: 'common' },
  nymnCorn: { id: '01HM6NJ2X000035ZKVAPWBNW26', rarity: 'common' },
  SteerR: { id: '01HM2F7Q1R00022X3E2804NBNQ', rarity: 'common' },
};
// Alt-Sticker bleiben anzeigbar (einige wanderten in den Emote-Pool)
const LEGACY_STICKERS = {
  peepoHappy: { id: '01GAZ199Z8000FEWHS6AT5QZV0', rarity: 'common' },
  peepoSad: { id: '01GAZ4SBX80007YCE2RXBT44B2', rarity: 'common' },
  EZ: { id: '01GB4CK01800090V9B3D8CGEEX', rarity: 'common' },
  ApuApustaja: { id: '01GGCQPCGR000C7MT8JZGP6E89', rarity: 'uncommon' },
  BillyApprove: { id: '01GB2S7H7000018VJGJ4A9BMFS', rarity: 'uncommon' },
  PepePls: { id: '01GAFTZ9K80003DHH026MC7JW0', rarity: 'uncommon' },
  WAYTOODANK: { id: '01G98W833R0000BRQD106P0ZNT', rarity: 'rare' },
};
const STICKERS_ALL = { ...markLegacy(LEGACY_STICKERS), ...STICKERS };

// ---------------------------------------------------------------- Sparkarten-Coupons
// Coupons, die es NUR im Papier-Flyer oder in der Anbieter-App gibt, gepflegt
// von der Redaktion. Sichtbar sind sie erst, wenn jemand die passende Sparkarte
// in seiner Wallet hat — sonst wäre es nur eine weitere Werbeliste.
const CARD_COUPONS_DEFAULT = {
  'burger king': {
    brand: 'Burger King',
    // Offen für alle: die My-BurgerKing-Codes wechseln alle paar Minuten,
    // eine gespeicherte Karte bringt hier niemandem etwas
    open: true,
    img: '/coupons/burger-king',
    validUntil: '2026-09-04',
    note: 'Nummer an der Kasse nennen oder QR im Flyer scannen lassen. Nicht mit anderen Rabatten kombinierbar, nicht im Lieferservice.',
    groups: [
      {
        title: 'Menüs und Kombis',
        items: [
          { code: '968', name: 'Crispy Chicken', extra: '+ große King Pommes + Monster Energy Green', price: '9,99', plu: '33654' },
          { code: '918', name: 'Crispy Chicken', extra: '', price: '3,49', plu: '16129' },
          { code: '929', name: '2 Crispy Chicken', extra: '+ mittlere King Pommes + 0,4 l Coca-Cola', price: '10,99', plu: '34587' },
          { code: '911', name: '2 Whopper Jr.', extra: '+ kleine King Pommes + 0,25 l Coca-Cola', price: '7,99', plu: '30624' },
          { code: '914', name: '2 Chili Cheese Burger', extra: '+ kleine King Pommes + 0,25 l Coca-Cola', price: '7,49', plu: '30630' },
          { code: '747', name: '2 Chicken Nugget Burger', extra: '+ kleine King Pommes + 0,25 l Coca-Cola', price: '6,99', plu: '30639' },
          { code: '912', name: '2 Cheeseburger', extra: '+ kleine King Pommes + 0,25 l Coca-Cola', price: '7,49', plu: '30629' },
          { code: '920', name: 'Long Chicken', extra: '', price: '3,99', plu: '16617' },
          { code: '997', name: 'Chili Cheese Burger + Big King', extra: '+ mittlere King Pommes + 0,4 l Coca-Cola', price: '9,99', plu: '34657' },
          { code: '959', name: 'Chili Cheese Burger + Crispy Chicken', extra: '+ mittlere King Pommes + 0,4 l Coca-Cola', price: '9,99', plu: '34592' },
          { code: '915', name: 'Whopper', extra: '+ mittlere King Pommes + 0,4 l Coca-Cola', price: '8,99', plu: '33523' },
          { code: '924', name: 'Long Chicken + Whopper', extra: '+ mittlere King Pommes + 0,4 l Coca-Cola', price: '12,99', plu: '34591' },
          { code: '996', name: 'X-tra Long Chili Cheese + Crispy Chicken', extra: '+ mittlere King Pommes + 0,4 l Coca-Cola', price: '12,99', plu: '34658' },
          { code: '885', name: 'Crispy Chicken + Big King XXL', extra: '+ mittlere King Pommes + 0,4 l Coca-Cola', price: '14,99', plu: '34659' },
        ],
      },
      {
        title: 'Plant-based',
        items: [
          { code: '919', name: 'Plant-based Double Chili Cheese Burger', extra: '', price: '3,49', plu: '16261' },
          { code: '967', name: '2 Plant-based Long Chicken', extra: '+ mittlere King Pommes + 0,4 l Coca-Cola', price: '11,79', plu: '34669' },
        ],
      },
      {
        title: 'Für den kleinen Hunger',
        items: [
          { code: '917', name: '20 King Nuggets', extra: '+ 3 Dips', price: '7,99', plu: '23277' },
          { code: '909', name: '6 Onion Rings', extra: '', price: '1,99', plu: '23004' },
          { code: '904', name: '6 Chili Cheese Nuggets', extra: '', price: '2,99', plu: '23273' },
          { code: '902', name: 'Fries Chili Cheese Style', extra: '', price: '2,99', plu: '22093' },
          { code: '900', name: '2 mittlere King Pommes', extra: 'zum Preis von einer Portion', price: '50 % sparen', plu: '22064' },
          { code: '980', name: 'King Fusion Oreo', extra: '', price: '2,49', plu: '44415' },
          { code: '984', name: '0,5 l King Shake', extra: 'Schoko, Erdbeer oder Vanille (5,98 €/l)', price: '2,99', plu: '51597' },
          { code: '966', name: 'King Jr. Meal', extra: '4 King Nuggets, kleine King Pommes, Apfel-Bananen-Quetschie, 0,5 l Wasser', price: '4,99', plu: '33144' },
        ],
      },
    ],
  },
  // Der Papier-Coupon aus dem Prospekt: gilt bis zum Ablaufdatum immer wieder,
  // anders als der App-Coupon (den gibt es nur dreimal im Monat). Nur mit
  // verbundener Rossmann-Karte, sonst wuerde der Barcode frei im Netz landen.
  rossmann: {
    brand: 'Rossmann',
    validUntil: '2026-10-31',
    note: 'Barcode an der Kasse zeigen — einmal pro Einkauf, aber bis zum Ablaufdatum immer wieder. Gilt nicht auf Bücher, Tabak, Pfand, Gutscheine und bereits reduzierte Ware. Der 10-%-Coupon in der App ist davon unabhängig und dreimal im Monat verfügbar.',
    groups: [
      {
        title: 'Dauerhaft gültig',
        items: [
          {
            code: '9823219040107',
            name: '10 % auf deinen Einkauf',
            extra: 'einmal pro Einkauf, bis 31.10.2026 immer wieder einlösbar',
            price: '10 % sparen',
            barcode: '/coupons/rossmann/10prozent.png',
          },
        ],
      },
    ],
  },
};
let cardCoupons = loadJson('cardcoupons.json', null);
if (!cardCoupons) { cardCoupons = CARD_COUPONS_DEFAULT; saveJson('cardcoupons.json', cardCoupons); }
// Bestandsdaten nachziehen: Burger King ist offen für alle und hat Produktfotos,
// und der Rossmann-Papiercoupon kommt bei alten Installationen dazu
{
  let dirty = false;
  const bk = cardCoupons['burger king'];
  if (bk && (bk.open !== true || !bk.img)) {
    bk.open = true;
    bk.img = bk.img || '/coupons/burger-king';
    dirty = true;
  }
  if (!cardCoupons.rossmann) { cardCoupons.rossmann = CARD_COUPONS_DEFAULT.rossmann; dirty = true; }
  else if (/beliebig oft/.test(JSON.stringify(cardCoupons.rossmann))) {
    // Erste Fassung sagte "beliebig oft" — richtig ist: einmal pro Einkauf
    cardCoupons.rossmann = CARD_COUPONS_DEFAULT.rossmann;
    dirty = true;
  }
  if (dirty) saveJson('cardcoupons.json', cardCoupons);
}
// ---------------------------------------------------------------- McCheap-Beobachter
// mccheap.tech sammelt McDonald's-Coupons. Uns interessieren nur die Ausreisser:
// gratis oder unter 1,50 €. Einmal pro Stunde, Fehler sind egal — dann gibt es
// eben keinen Hinweis, statt dass die App haengt.
let mccheap = { checked: 0, items: [], ok: false };
async function scanMccheap() {
  if (Date.now() - mccheap.checked < 55 * 60 * 1000) return;
  mccheap.checked = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch('https://mccheap.tech/', {
      headers: { 'user-agent': 'kumulio/1.0 (+https://kumulio.de)' },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!res.ok) return;
    const body = (await res.text()).slice(0, 400000);
    // Die Seite listet jeden Coupon als name/price/validTo — genau die lesen wir,
    // statt im Fließtext nach Preisen zu raten (das fischt nur Werbetexte).
    const roh = /<span class\s*=\s*"name">([\s\S]*?)<\/span>\s*<span class\s*=\s*"price">([\s\S]*?)<\/span>(?:\s*<span class\s*=\s*"validTo">([\s\S]*?)<\/span>)?/gi;
    const sauber = t => String(t || '').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&euro;/g, '€')
      .replace(/\s+/g, ' ').trim();
    const treffer = [];
    let m;
    while ((m = roh.exec(body))) {
      const name = sauber(m[1]);
      const preis = sauber(m[2]);
      if (!name || !preis) continue;
      const gratis = /gratis|kostenlos|geschenkt|0,00/i.test(preis);
      const zahl = preis.match(/(\d{1,2})[,.](\d{2})/);
      const guenstig = zahl && parseFloat(zahl[1] + '.' + zahl[2]) <= 1.5;
      if (!gratis && !guenstig) continue;
      const text = `${name} · ${preis}`.slice(0, 90);
      if (!treffer.some(x => x.text === text)) treffer.push({ text, gratis, bis: sauber(m[3]) });
    }
    mccheap = { checked: Date.now(), items: treffer.slice(0, 6), ok: true };
  } catch {
    // Seite nicht erreichbar oder umgebaut — dann gibt es eben keinen Hinweis
    mccheap.checked = Date.now();
  }
}
scanMccheap();
setInterval(scanMccheap, 60 * 60 * 1000).unref?.();

// ---------------------------------------------------------------- Burger-King-PDF
// einfach-sparsam.de legt die aktuellen Burger-King-Papiercoupons als PDF aus.
// Wir holen die Seite einmal am Tag und gleich nach Ablauf der alten PDF,
// suchen den PDF-Eintrag, folgen den Weiterleitungen bis zur Datei und legen
// sie im Datenordner ab (bk-coupons.pdf, dazu bk-coupons.json). Geht etwas
// schief, bleibt die alte Datei liegen — und der naechste Versuch wartet
// laenger, damit wir die Seite nicht haemmern.
const BK_QUELLE = 'https://www.einfach-sparsam.de/burger-king-coupons-ausdrucken.htm';
const BK_PDF = 'bk-coupons.pdf';
const BK_META = 'bk-coupons.json';
const BK_MAX_BYTES = 15 * 1024 * 1024;
const BK_MONATE = ['januar', 'februar', 'maerz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];
let bkMeta = loadJson(BK_META, null);
const bkLauf = { aktiv: null, versuch: 0, fehler: 0, letzterFehler: '' };

// "06.11.2026", "6. November 2026" oder ohne Jahr ("bis 6. November") ->
// "2026-11-06". Ohne Jahr gilt das naechste solche Datum (hoechstens zwei
// Monate zurueck). Unlesbares ergibt ''.
function bkDatumLesen(text, bezug = new Date()) {
  let t = String(text || '').toLowerCase().replace(/ä/g, 'ae');
  const nachBis = t.split(/\bbis\b/).slice(1).join(' ');
  if (nachBis) t = nachBis;
  let tag, monat, jahr;
  let m = t.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b/);
  if (m) {
    tag = +m[1]; monat = +m[2]; jahr = +m[3] < 100 ? 2000 + +m[3] : +m[3];
  } else {
    m = t.match(/\b(\d{1,2})\.?\s*(januar|februar|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\b(?:\s+(\d{4}))?/);
    if (!m) return '';
    tag = +m[1];
    monat = BK_MONATE.indexOf(m[2]) + 1;
    jahr = m[3] ? +m[3] : bezug.getFullYear();
    if (!m[3] && Date.UTC(jahr, monat - 1, tag) < bezug.getTime() - 60 * 864e5) jahr++;
  }
  if (!(tag >= 1 && tag <= 31 && monat >= 1 && monat <= 12 && jahr >= 2020 && jahr <= 2100)) return '';
  const d = new Date(Date.UTC(jahr, monat - 1, tag));
  if (d.getUTCDate() !== tag) return '';   // 31.02. o. ae.
  return d.toISOString().slice(0, 10);
}

// Den PDF-Eintrag auf der Seite finden: jeder Gutschein steht in einem Block
// ab <span class="anchor" id="voucher-…">, der PDF-Eintrag hat "PDF" im Titel.
function bkSeiteLesen(html) {
  html = String(html || '');
  const sauber = s => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  let e = null;
  for (const b of html.split(/<span[^>]*class="anchor"[^>]*id="voucher-/i).slice(1)) {
    const titel = sauber((b.match(/class="voucher-title"[^>]*>([\s\S]*?)<\/div>/i) || [])[1]);
    const ziel = (b.match(/data-voucher-url="(\d{1,6}-\d{1,9})"/) || [])[1];
    if (!ziel || !/\bpdf\b/i.test(titel)) continue;
    e = {
      ziel,
      titel: titel.replace(/[^\p{L}\p{N}\s().,:–-]+/gu, '').replace(/\s+/g, ' ').trim().slice(0, 120),
      unter: sauber((b.match(/class="vou[a-z]*-subtitle"[^>]*>([\s\S]*?)<\/div>/i) || [])[1]).slice(0, 200),
      ende: sauber((b.match(/class="voucher-end-date"[^>]*>([\s\S]*?)<\/span>\s*<\/div>/i) || [])[1]).slice(0, 60),
    };
    break;
  }
  // Seite umgebaut: der Knopf traegt den Titel auch im aria-label
  if (!e) {
    const m = html.match(/data-voucher-url="(\d{1,6}-\d{1,9})"[^>]*aria-label="[^"]*\bPDF\b[^"]*"/i);
    if (m) e = { ziel: m[1], titel: 'Burger King Gutscheine (PDF)', unter: '', ende: '' };
  }
  if (!e) return null;
  const seitenTitel = sauber((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  e.gueltigBis = bkDatumLesen(e.unter) || bkDatumLesen(e.ende) || bkDatumLesen(seitenTitel);
  return e;
}

// Nur Adressen von einfach-sparsam.de, nur https — eine Weiterleitung
// woandershin holen wir nicht
function bkUrlOk(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)einfach-sparsam\.de$/i.test(x.hostname); } catch { return false; }
}
function bkDatei(name) { return path.join(DATA, name); }
function bkDa() { return !!(bkMeta && bkMeta.groesse) && fs.existsSync(bkDatei(BK_PDF)); }

// Faellig? Taeglich; ist die PDF abgelaufen, alle zwei Stunden, bis die neue
// da ist. Nach Fehlern waechst die Pause (30 min, 1 h, 2 h … hoechstens 12 h),
// zwischen zwei Versuchen liegen immer mindestens 10 Minuten.
function bkFaellig(jetzt = Date.now()) {
  if (bkLauf.aktiv || jetzt - bkLauf.versuch < 10 * 60e3) return false;
  if (bkLauf.fehler && jetzt - bkLauf.versuch < Math.min(12 * 3600e3, 30 * 60e3 * 2 ** (bkLauf.fehler - 1))) return false;
  if (!bkDa() || !bkMeta.geprueft) return true;
  const abgelaufen = !!bkMeta.gueltigBis && bkMeta.gueltigBis < berlinTag(jetzt);
  return jetzt - bkMeta.geprueft > (abgelaufen ? 2 * 3600e3 : 22 * 3600e3);
}
function bkPruefen({ sofort = false } = {}) {
  if (!sofort && !bkFaellig()) return bkLauf.aktiv || Promise.resolve(false);
  if (bkLauf.aktiv) return bkLauf.aktiv;
  bkLauf.versuch = Date.now();
  bkLauf.aktiv = bkHolen()
    .then(neu => { bkLauf.fehler = 0; bkLauf.letzterFehler = ''; return neu; })
    .catch(err => {
      bkLauf.fehler = Math.min(bkLauf.fehler + 1, 10);
      bkLauf.letzterFehler = String(err && err.message || err).slice(0, 200);
      console.error('[BK-PDF]', bkLauf.letzterFehler);
      return false;
    })
    .finally(() => { bkLauf.aktiv = null; });
  return bkLauf.aktiv;
}
async function bkHolen() {
  // Ein Lauf darf hoechstens 90 s dauern (Seite, Weiterleitungen, Download)
  const ctrl = new AbortController();
  const uhr = setTimeout(() => ctrl.abort(), 90e3);
  const kopf = accept => ({ 'User-Agent': BROWSER_UA, 'Accept': accept, 'Accept-Language': 'de-DE,de;q=0.9', 'Referer': BK_QUELLE });
  try {
    const seite = await fetch(BK_QUELLE, { headers: kopf('text/html,application/xhtml+xml'), redirect: 'follow', signal: ctrl.signal });
    if (!seite.ok) throw new Error('Seite antwortet mit ' + seite.status);
    const eintrag = bkSeiteLesen((await seite.text()).slice(0, 1_500_000));
    if (!eintrag) throw new Error('Kein PDF-Eintrag auf der Seite gefunden');

    // Den Weiterleitungen selbst folgen: jede muss bei einfach-sparsam bleiben
    let url = `https://www.einfach-sparsam.de/shop/gehe-zu-${eintrag.ziel}`;
    let res = null;
    for (let schritt = 0; ; schritt++) {
      if (schritt > 5) throw new Error('Zu viele Weiterleitungen');
      if (!bkUrlOk(url)) throw new Error('Weiterleitung auf eine fremde Seite');
      res = await fetch(url, { headers: kopf('application/pdf,*/*;q=0.8'), redirect: 'manual', signal: ctrl.signal });
      if (res.status < 300 || res.status >= 400) break;
      const ziel = res.headers.get('location');
      await res.body?.cancel().catch(() => { });
      if (!ziel) throw new Error('Weiterleitung ohne Ziel');
      url = new URL(ziel, url).href;
    }
    if (!res.ok) throw new Error('PDF antwortet mit ' + res.status);
    const typ = String(res.headers.get('content-type') || '').toLowerCase();
    if (!/application\/(pdf|octet-stream)/.test(typ)) { await res.body?.cancel().catch(() => { }); throw new Error('Keine PDF (' + typ + ')'); }
    const laenge = Number(res.headers.get('content-length')) || 0;
    if (laenge > BK_MAX_BYTES) { await res.body?.cancel().catch(() => { }); throw new Error('PDF zu groß'); }
    const dateiname = (() => { try { return decodeURIComponent(path.basename(new URL(url).pathname)); } catch { return ''; } })().slice(0, 120);
    const gueltigBis = eintrag.gueltigBis || bkDatumLesen(dateiname.replace(/\.pdf$/i, ''));
    const quelleEtag = String(res.headers.get('etag') || '').slice(0, 100);

    // Dieselbe Datei wie beim letzten Mal: nichts laden, nur nachtragen
    if (bkDa() && bkMeta.pdfUrl === url && ((quelleEtag && quelleEtag === bkMeta.quelleEtag) || (laenge && laenge === bkMeta.groesse))) {
      await res.body?.cancel().catch(() => { });
      bkMeta = { ...bkMeta, gueltigBis: gueltigBis || bkMeta.gueltigBis, titel: eintrag.titel, unter: eintrag.unter, geprueft: Date.now() };
      saveJson(BK_META, bkMeta);
      return false;
    }

    const teile = [];
    let n = 0;
    for await (const stueck of res.body) {
      n += stueck.length;
      if (n > BK_MAX_BYTES) { ctrl.abort(); throw new Error('PDF zu groß'); }
      teile.push(stueck);
    }
    const buf = Buffer.concat(teile);
    if (buf.length < 1000 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('Datei ist keine PDF');

    // Erst vollstaendig schreiben, dann umbenennen: nie eine halbe Datei
    await fs.promises.mkdir(DATA, { recursive: true });
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
    const seiten = bkVorschauBauen(buf, hash);
    await fs.promises.writeFile(bkDatei(BK_PDF + '.tmp'), buf);
    await fs.promises.rename(bkDatei(BK_PDF + '.tmp'), bkDatei(BK_PDF));
    const altSeiten = (bkMeta && bkMeta.seiten) || [];
    bkMeta = {
      gueltigBis, titel: eintrag.titel, unter: eintrag.unter, quelle: BK_QUELLE, pdfUrl: url, dateiname,
      quelleEtag, groesse: buf.length, hash, abgerufen: Date.now(), geprueft: Date.now(), seiten,
    };
    saveJson(BK_META, bkMeta);
    // Vorschaubilder der alten PDF wegraeumen
    for (const s of altSeiten) if (!seiten.some(x => x.datei === s.datei)) fs.promises.rm(bkDatei(s.datei), { force: true }).catch(() => { });
    console.log(`[BK-PDF] neue PDF geladen (${Math.round(buf.length / 1024)} KB, gültig bis ${gueltigBis || '?'})`);
    return true;
  } finally {
    clearTimeout(uhr);
  }
}

// ---- Vorschau der Seiten als Bild, ohne Zusatzpaket. Die PDF ist ein Scan:
// jede Seite besteht aus genau einem Bild. Wir lesen die Objekte (auch aus
// komprimierten Objekt-Stroemen), nehmen je Seite das groesste Bild und
// machen daraus ein PNG (Flate) oder reichen das JPEG durch (DCT). Klappt das
// nicht (echte Vektor-PDF, unbekanntes Format), gibt es eben keine Vorschau.
const BK_VORSCHAU_BREITE = 900;
function bkVorschauBauen(buf, hash) {
  const seiten = [];
  try {
    const bilder = pdfSeitenBilder(buf).slice(0, 4);
    bilder.forEach((b, i) => {
      if (!b) return;
      const datei = `bk-coupons-${hash}-${i + 1}.${b.typ === 'image/jpeg' ? 'jpg' : 'png'}`;
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(bkDatei(datei), b.daten);
      seiten.push({ n: i + 1, datei, typ: b.typ, w: b.w, h: b.h, groesse: b.daten.length });
    });
  } catch (err) {
    console.error('[BK-PDF] keine Vorschau:', err.message);
  }
  // Nur zusammenhaengend ab Seite 1 — eine Luecke waere verwirrend
  const bis = seiten.findIndex((s, i) => s.n !== i + 1);
  return bis < 0 ? seiten : seiten.slice(0, bis);
}

// Minimaler PDF-Leser: Objekte mit Woerterbuch und Strom
function pdfObjekte(buf) {
  const s = buf.toString('latin1');
  const objekte = new Map();
  const kopf = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = kopf.exec(s))) {
    const nr = +m[1];
    let i = kopf.lastIndex;
    while (i < s.length && /\s/.test(s[i])) i++;
    let dict = '';
    if (s.startsWith('<<', i)) {
      const ende = pdfKlammerEnde(s, i);
      if (ende < 0) continue;
      dict = s.slice(i, ende);
      i = ende;
    }
    let strom = null;
    const rest = s.slice(i, i + 20);
    const sm = rest.match(/^\s*stream(\r\n|\n|\r)/);
    if (sm) {
      const start = i + sm[0].length;
      const len = pdfZahl(dict, 'Length');
      // /Length stimmt, wenn danach (nach hoechstens etwas Leerraum) endstream folgt
      let ende = len != null && len >= 0 && /^\s*endstream/.test(s.slice(start + len, start + len + 14)) ? start + len : -1;
      if (ende < 0) {
        ende = s.indexOf('endstream', start);
        if (ende < 0) continue;
        // Zeilenende vor "endstream" gehoert nicht zum Strom
        if (s[ende - 1] === '\n') ende--;
        if (s[ende - 1] === '\r') ende--;
      }
      strom = buf.subarray(start, ende);
      kopf.lastIndex = ende;
    } else if (!dict) {
      // Kein Woerterbuch (Zahl, Feld …): bis endobj
      const e = s.indexOf('endobj', i);
      dict = s.slice(i, e < 0 ? i : e).trim();
    }
    if (!objekte.has(nr)) objekte.set(nr, { dict, strom });
  }
  // Komprimierte Objekt-Stroeme (PDF 1.5+) auspacken
  for (const [, o] of [...objekte]) {
    if (!o.strom || !/\/Type\s*\/ObjStm\b/.test(o.dict)) continue;
    let daten;
    try { daten = pdfStromDaten(o, objekte).toString('latin1'); } catch { continue; }
    const n = pdfZahl(o.dict, 'N') || 0, erste = pdfZahl(o.dict, 'First') || 0;
    const zahlen = daten.slice(0, erste).trim().split(/\s+/).map(Number);
    for (let k = 0; k < n; k++) {
      const nr = zahlen[2 * k], ab = erste + zahlen[2 * k + 1];
      const bis = k + 1 < n ? erste + zahlen[2 * k + 3] : daten.length;
      if (!Number.isFinite(nr) || objekte.has(nr)) continue;
      objekte.set(nr, { dict: daten.slice(ab, bis).trim(), strom: null });
    }
  }
  return objekte;
}
// Ende eines << … >>-Woerterbuchs (verschachtelt), -1 wenn keins
function pdfKlammerEnde(s, i) {
  let tiefe = 0;
  for (let k = i; k < s.length - 1; k++) {
    if (s[k] === '<' && s[k + 1] === '<') { tiefe++; k++; }
    else if (s[k] === '>' && s[k + 1] === '>') { tiefe--; k++; if (!tiefe) return k + 1; }
    else if (s[k] === '(') {           // Text in Klammern ueberspringen
      let t = 1;
      for (k++; k < s.length && t; k++) { if (s[k] === '\\') k++; else if (s[k] === '(') t++; else if (s[k] === ')') t--; }
      k--;
    }
  }
  return -1;
}
// Wert eines Schluessels im Woerterbuch (oberste Ebene reicht hier)
function pdfWert(dict, key) {
  const re = new RegExp('/' + key + '(?![A-Za-z0-9])\\s*', 'g');
  const m = re.exec(dict);
  if (!m) return null;
  const i = re.lastIndex;
  if (dict.startsWith('<<', i)) { const e = pdfKlammerEnde(dict, i); return e < 0 ? null : dict.slice(i, e); }
  if (dict[i] === '[') { const e = dict.indexOf(']', i); return e < 0 ? null : dict.slice(i, e + 1); }
  const r = dict.slice(i).match(/^(\d+\s+\d+\s+R|\/[^\s/<>\[\]()]+|[-\d.]+)/);
  return r ? r[1] : null;
}
function pdfZahl(dict, key) { const v = pdfWert(dict, key); return v != null && /^[-\d.]+$/.test(v) ? Number(v) : null; }
// Verweis "12 0 R" aufloesen (sonst der Wert selbst)
function pdfAuf(wert, objekte) {
  const m = String(wert || '').match(/^(\d+)\s+\d+\s+R$/);
  return m ? (objekte.get(+m[1]) || null) : (wert != null ? { dict: String(wert), strom: null } : null);
}
function pdfStromDaten(o, objekte) {
  const filter = String(pdfWert(o.dict, 'Filter') || '');
  if (!filter) return o.strom;
  // Obergrenze gegen aufgeblasene Stroeme (30 MB reichen fuer jede Seite)
  if (/^\/FlateDecode$|^\[\s*\/FlateDecode\s*\]$/.test(filter)) return zlib.inflateSync(o.strom, { maxOutputLength: 30e6 });
  throw new Error('Filter nicht unterstuetzt: ' + filter);
}
// Je Seite das groesste Bild als { typ, daten, w, h } (oder null)
function pdfSeitenBilder(buf) {
  const objekte = pdfObjekte(buf);
  const s = buf.toString('latin1');
  const wurzel = [...s.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)].pop();
  if (!wurzel) throw new Error('Kein Katalog');
  const katalog = objekte.get(+wurzel[1]);
  const seiten = [];
  const sammle = (knoten, tiefe) => {
    if (!knoten || tiefe > 8 || seiten.length >= 6) return;
    if (/\/Type\s*\/Page\b(?!s)/.test(knoten.dict)) { seiten.push(knoten); return; }
    const kinder = String(pdfWert(knoten.dict, 'Kids') || '').match(/\d+\s+\d+\s+R/g) || [];
    for (const k of kinder) sammle(pdfAuf(k, objekte), tiefe + 1);
  };
  sammle(pdfAuf(pdfWert(katalog?.dict || '', 'Pages'), objekte), 0);
  return seiten.map(seite => {
    try {
      const res = pdfAuf(pdfWert(seite.dict, 'Resources'), objekte);
      const xo = res && pdfAuf(pdfWert(res.dict, 'XObject'), objekte);
      if (!xo) return null;
      let bestes = null;
      for (const ref of xo.dict.match(/\d+\s+\d+\s+R/g) || []) {
        const b = pdfAuf(ref, objekte);
        if (!b || !b.strom || !/\/Subtype\s*\/Image\b/.test(b.dict)) continue;
        const w = pdfZahl(b.dict, 'Width') || 0, h = pdfZahl(b.dict, 'Height') || 0;
        if (!bestes || w * h > bestes.w * bestes.h) bestes = { o: b, w, h };
      }
      return bestes ? pdfBildAlsDatei(bestes.o, bestes.w, bestes.h, objekte) : null;
    } catch { return null; }
  });
}
function pdfBildAlsDatei(o, w, h, objekte) {
  const filter = String(pdfWert(o.dict, 'Filter') || '');
  if (/DCTDecode/.test(filter)) {
    if (!/^\/DCTDecode$|^\[\s*\/DCTDecode\s*\]$/.test(filter)) return null;
    return o.strom[0] === 0xFF && o.strom[1] === 0xD8 ? { typ: 'image/jpeg', daten: Buffer.from(o.strom), w, h } : null;
  }
  const px = pdfBildPixel(o, w, h, objekte);
  if (!px) return null;
  // Halbtransparenz (SMask) auf Weiss legen — so saehe die Seite gedruckt aus
  const maske = pdfAuf(pdfWert(o.dict, 'SMask'), objekte);
  if (maske && maske.strom) {
    const a = pdfBildPixel(maske, pdfZahl(maske.dict, 'Width'), pdfZahl(maske.dict, 'Height'), objekte);
    if (a && a.k === 1 && a.w === w && a.h === h) {
      for (let p = 0, q = 0; q < a.daten.length; q++) {
        const al = a.daten[q];
        for (let c = 0; c < px.k; c++, p++) px.daten[p] = (px.daten[p] * al + 255 * (255 - al)) / 255 | 0;
      }
    }
  }
  const klein = pngVerkleinern(px, BK_VORSCHAU_BREITE);
  return { typ: 'image/png', daten: pngBauen(klein), w: klein.w, h: klein.h };
}
// Flate-Bild -> rohe Pixel (8 Bit, Grau oder RGB), PNG-Praediktoren aufgeloest
function pdfBildPixel(o, w, h, objekte) {
  if (!w || !h || w > 3000 || h > 3000) return null;
  if ((pdfZahl(o.dict, 'BitsPerComponent') || 8) !== 8) return null;
  let raum = String(pdfWert(o.dict, 'ColorSpace') || '/DeviceGray');
  if (/^\d+\s+\d+\s+R$/.test(raum)) raum = pdfAuf(raum, objekte)?.dict || '';
  let k = /DeviceRGB/.test(raum) ? 3 : /DeviceGray/.test(raum) ? 1 : 0;
  if (!k && /ICCBased/.test(raum)) {
    const icc = pdfAuf((raum.match(/\d+\s+\d+\s+R/) || [])[0], objekte);
    k = icc ? (pdfZahl(icc.dict, 'N') === 3 ? 3 : pdfZahl(icc.dict, 'N') === 1 ? 1 : 0) : 0;
  }
  if (!k) return null;
  const roh = pdfStromDaten(o, objekte);
  const parm = pdfAuf(pdfWert(o.dict, 'DecodeParms'), objekte);
  const praed = parm ? pdfZahl(parm.dict, 'Predictor') || 1 : 1;
  const zeile = w * k;
  const daten = Buffer.alloc(zeile * h);
  if (praed >= 10) {
    if (roh.length < (zeile + 1) * h) return null;
    pngFilterAuf(roh, daten, w, h, k);
  } else if (praed === 1) {
    if (roh.length < zeile * h) return null;
    roh.copy(daten, 0, 0, zeile * h);
  } else return null;
  return { w, h, k, daten };
}
function pngPaeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
function pngFilterAuf(roh, ziel, w, h, k) {
  const zeile = w * k;
  for (let y = 0; y < h; y++) {
    const f = roh[y * (zeile + 1)], q = y * (zeile + 1) + 1, z = y * zeile;
    for (let x = 0; x < zeile; x++) {
      const a = x >= k ? ziel[z + x - k] : 0, b = y ? ziel[z - zeile + x] : 0, c = x >= k && y ? ziel[z - zeile + x - k] : 0;
      const v = roh[q + x];
      ziel[z + x] = (f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : f === 4 ? v + pngPaeth(a, b, c) : v) & 255;
    }
  }
}
// Flaechenmittel auf hoechstens maxB Pixel Breite
function pngVerkleinern(px, maxB) {
  if (px.w <= maxB) return px;
  const f = px.w / maxB, w = maxB, h = Math.max(1, Math.round(px.h / f)), k = px.k;
  const daten = Buffer.alloc(w * h * k);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * f), y1 = Math.max(y0 + 1, Math.min(px.h, Math.floor((y + 1) * f)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * f), x1 = Math.max(x0 + 1, Math.min(px.w, Math.floor((x + 1) * f)));
      for (let c = 0; c < k; c++) {
        let sum = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += px.daten[(yy * px.w + xx) * k + c];
        daten[(y * w + x) * k + c] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
      }
    }
  }
  return { w, h, k, daten };
}
const CRC_TAFEL = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_TAFEL[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function pngStueck(typ, daten) {
  const td = Buffer.concat([Buffer.from(typ, 'latin1'), daten]);
  const len = Buffer.alloc(4); len.writeUInt32BE(daten.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// PNG mit Paeth-Filter je Zeile (fuer Fotos meist am kleinsten)
function pngBauen({ w, h, k, daten }) {
  const zeile = w * k;
  const roh = Buffer.alloc((zeile + 1) * h);
  for (let y = 0; y < h; y++) {
    const z = y * zeile, q = y * (zeile + 1);
    roh[q] = 4;
    for (let x = 0; x < zeile; x++) {
      const a = x >= k ? daten[z + x - k] : 0, b = y ? daten[z - zeile + x] : 0, c = x >= k && y ? daten[z - zeile + x - k] : 0;
      roh[q + 1 + x] = (daten[z + x] - pngPaeth(a, b, c)) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = k === 3 ? 2 : 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngStueck('IHDR', ihdr), pngStueck('IDAT', zlib.deflateSync(roh, { level: 9 })), pngStueck('IEND', Buffer.alloc(0)),
  ]);
}
// Fuer die App: was liegt vor, bis wann gilt es? (ohne interne Pfade)
function bkOeffentlich() {
  const da = bkDa();
  const m = bkMeta || {};
  return {
    da,
    gueltigBis: da ? m.gueltigBis || '' : '',
    abgelaufen: da && !!m.gueltigBis && m.gueltigBis < berlinTag(Date.now()),
    titel: da ? m.titel || '' : '',
    abgerufen: da ? m.abgerufen || 0 : 0,
    geprueft: m.geprueft || 0,
    groesse: da ? m.groesse || 0 : 0,
    version: da ? m.hash || '' : '',
    seiten: da ? (m.seiten || []).filter(s => fs.existsSync(bkDatei(s.datei))).map(s => ({ n: s.n, w: s.w, h: s.h })) : [],
    quelle: 'einfach-sparsam.de',
    quelleUrl: BK_QUELLE,
  };
}
if (!process.env.RA_TEST) {
  // Nicht sofort beim Start (dann ist noch nicht alles geladen), danach
  // alle 15 Minuten nachsehen, ob etwas faellig ist
  setTimeout(() => bkPruefen(), 20e3).unref?.();
  setInterval(() => bkPruefen(), 15 * 60e3).unref?.();
}

// ---------------------------------------------------------------- Netto-Wochencoupons
// Die Rabatt-Barcodes von Netto folgen einem Muster, das sich aus der
// Kalenderwoche ergibt (so macht es auch nettsoviel.com, wo das Muster
// oeffentlich dokumentiert ist). Wir rechnen selbst statt zu scrapen: dadurch
// ist die Liste jede Woche von allein aktuell und haengt an keiner fremden Seite.
//
// Wichtig: es sind Haendler-Coupons, keine persoenlichen. Der Hinweis "nur
// einloesen, wenn man berechtigt ist" gehoert dazu und steht in der note.
function ean13(zwoelf) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += parseInt(zwoelf[i], 10) * (i % 2 === 0 ? 1 : 3);
  return zwoelf + ((10 - sum % 10) % 10);
}
// Wochenzaehler wie auf der Quellseite — bewusst NICHT ISO-8601, sondern
// "Tage seit dem 1. Januar plus dessen Wochentag, aufgerundet durch 7"
function nettoKw(d = new Date()) {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const tage = (d - jan1) / 86400000;
  const kw = Math.ceil((tage + jan1.getDay()) / 7);
  return kw < 10 ? '0' + kw : String(kw);
}
function nettoCoupons() {
  const kw = nettoKw();
  const wechsel = ['88', '97', '68', '83'][parseInt(kw, 10) % 4];
  const basis = '98319';
  const pre = basis + wechsel;
  const c = (rest, name, extra, prozent) => ({
    code: ean13(pre + rest), name, extra: extra || '',
    price: prozent, ean: true,
  });
  // Coupons mit eigenem Praefix (gelten nur fuer eine Warengruppe)
  const g = (praefix, rest, name, extra, prozent) => ({
    code: ean13(praefix + rest), name, extra: extra || '',
    price: prozent, ean: true,
  });
  const getraenk = 'Ausgenommen sind Pfand, gekühlte Getränke, Milch und milchhaltige Trinkprodukte, alkoholhaltige Getränke exkl. Bier';
  const fleisch = 'Ausgenommen sind Fleisch- und Wurstartikel in Konserven und aus der Tiefkühlung';
  const molkerei = 'Ausgenommen sind SB-Fleisch- und Wurstartikel';
  const obst = 'Ausgenommen sind Obst- und Gemüseartikel in Konserven und Tiefkühlung, Blumen und Pflanzen';

  // Bis wann gilt dieser Satz? Nicht raten, sondern die Formel befragen: der
  // letzte Tag, an dem sie noch dieselbe Woche liefert. An welchem Wochentag
  // der Zaehler springt, haengt vom Jahr ab (vom Wochentag des 1. Januar).
  // Mittags pruefen, nicht um Mitternacht: die Formel rechnet mit Bruchteilen
  // von Tagen und springt exakt um 00:00, dieser Zeitpunkt zaehlt noch zur
  // alten Woche. Mit 12 Uhr trifft man, was am Tag tatsaechlich gilt.
  const heute = new Date();
  const ende = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate());
  for (let i = 1; i <= 7; i++) {
    const test = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate() + i, 12);
    if (nettoKw(test) !== kw) break;
    ende.setDate(ende.getDate() + 1);
  }
  // Datum lokal zusammensetzen — toISOString() wuerde in unserer Zeitzone
  // einen Tag zu frueh anzeigen
  const zz = n => String(n).padStart(2, '0');
  const iso = `${ende.getFullYear()}-${zz(ende.getMonth() + 1)}-${zz(ende.getDate())}`;

  return {
    brand: 'Netto',
    open: true,          // keine Sparkarte nötig, die Codes gelten für alle
    validUntil: iso,
    note: 'Barcode an der Kasse zeigen. Die Codes wechseln jede Woche und werden hier automatisch neu berechnet (KW ' + kw + '). '
      + 'Angaben ohne Gewähr — bitte nur einlösen, wenn du dazu berechtigt bist. An SB-Kassen werden sie oft nicht mehr angenommen.',
    groups: [
      {
        title: 'Auf den ganzen Einkauf',
        items: [
          c('02015', '2 × 15 % Rabatt', 'zweimal einlösbar', '15 %'),
          c('01015', '1 × 15 % Rabatt', '', '15 %'),
          c('03010', '3 × 10 % Rabatt', 'dreimal einlösbar', '10 %'),
          c('02010', '2 × 10 % Rabatt', 'zweimal einlösbar', '10 %'),
          c('01010', '1 × 10 % Rabatt', '', '10 %'),
          c('05005', '5 × 5 % Rabatt', 'fünfmal einlösbar', '5 %'),
          c('02005', '2 × 5 % Rabatt', 'zweimal einlösbar', '5 %'),
          c('01005', '1 × 5 % Rabatt', '', '5 %'),
        ],
      },
      {
        title: 'Nur für eine Warengruppe',
        items: [
          g(basis, '2702015', '2 × 15 % auf Getränke', 'nicht in jeder Filiale. ' + getraenk, '15 %'),
          g('98323' + wechsel, '02010', '2 × 10 % auf Getränke', getraenk, '10 %'),
          g('98323' + wechsel, '01010', '1 × 10 % auf Getränke', getraenk, '10 %'),
          g(basis, '6602015', '2 × 15 % auf Fleisch und Wurst', 'nicht in jeder Filiale. ' + fleisch, '15 %'),
          g('98322' + wechsel, '02010', '2 × 10 % auf Fleisch und Wurst', fleisch, '10 %'),
          g('98322' + wechsel, '01010', '1 × 10 % auf Fleisch und Wurst', fleisch, '10 %'),
          g(basis, '6802015', '2 × 15 % auf Molkereiartikel', 'nicht in jeder Filiale. ' + molkerei, '15 %'),
          g('98321' + wechsel, '02010', '2 × 10 % auf Molkereiartikel', molkerei, '10 %'),
          g('98321' + wechsel, '01010', '1 × 10 % auf Molkereiartikel', molkerei, '10 %'),
          g(basis, '7302015', '2 × 15 % auf Obst und Gemüse', 'nicht in jeder Filiale. ' + obst, '15 %'),
          g('98320' + wechsel, '02010', '2 × 10 % auf Obst und Gemüse', obst, '10 %'),
          g('98320' + wechsel, '01010', '1 × 10 % auf Obst und Gemüse', obst, '10 %'),
        ],
      },
    ],
  };
}
// Netto liegt nie in der Datei — der Satz wird bei jedem Abruf frisch gerechnet
function couponSatz(key) {
  return key === 'netto' ? nettoCoupons() : cardCoupons[key];
}

// Hat jemand diese Sparkarte in der Wallet? Nur dann gibt es die Coupons.
function hasCard(user, key) {
  const w = wallets[user];
  if (!w) return false;
  return (w.cards || []).some(c => String(c.name || '').trim().toLowerCase() === key);
}

// ---------------------------------------------------------------- Web-Push (RFC 8291/8292, ohne Abhängigkeiten)
// Preisfehler-Alarm: Browser abonnieren per VAPID, der Server verschlüsselt
// jede Nachricht einzeln (aes128gcm), alles mit Node-Bordmitteln.
let pushSubs = loadJson('push-subs.json', []); // [{endpoint, keys:{p256dh,auth}}]
const b64u = buf => Buffer.from(buf).toString('base64url');
function getVapid() {
  let v = loadJson('vapid.json', null);
  if (!v || !v.publicKey) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    v = { publicKey: b64u(pub), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
    saveJson('vapid.json', v);
  }
  return v;
}
function vapidJwt(aud) {
  const v = getVapid();
  const enc = o => b64u(JSON.stringify(o));
  const input = enc({ typ: 'JWT', alg: 'ES256' }) + '.' +
    enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:kontakt@kumulio.de' });
  const sig = crypto.sign('sha256', Buffer.from(input), { key: v.privateKeyPem, dsaEncoding: 'ieee-p1363' });
  return input + '.' + b64u(sig);
}
function encryptPush(payload, sub) {
  const uaPub = Buffer.from(sub.keys.p256dh, 'base64url');
  const uaAuth = Buffer.from(sub.keys.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  const asPub = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPub);
  const hkdf = (key, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', key, salt, info, len));
  const salt = crypto.randomBytes(16);
  const ikm = hkdf(shared, uaAuth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const padded = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02 = letzter Record
  const ct = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.concat([salt, Buffer.from([0, 0, 16, 0]), Buffer.from([asPub.length]), asPub]);
  return Buffer.concat([header, ct]);
}
async function sendPush(sub, dataObj) {
  const body = encryptPush(JSON.stringify(dataObj), sub);
  const jwt = vapidJwt(new URL(sub.endpoint).origin);
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'TTL': '86400', 'Urgency': 'high',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Authorization': `vapid t=${jwt}, k=${getVapid().publicKey}`,
    },
    body,
  });
  return r.status;
}
async function pushToAll(dataObj) {
  const dead = [];
  for (const sub of pushSubs) {
    try {
      const st = await sendPush(sub, dataObj);
      if (st === 404 || st === 410) dead.push(sub.endpoint); // Abo existiert nicht mehr
    } catch { }
  }
  if (dead.length) {
    pushSubs = pushSubs.filter(s => !dead.includes(s.endpoint));
    saveJson('push-subs.json', pushSubs);
  }
}
// Gezielter Push an einen Nutzer (DMs, Erwähnungen): nur Abos mit user-Bindung
function pushToUser(name, dataObj) {
  const mine = pushSubs.filter(s => s.user === name);
  if (!mine.length) return;
  (async () => {
    const dead = [];
    for (const sub of mine) {
      try {
        const st = await sendPush(sub, dataObj);
        if (st === 404 || st === 410) dead.push(sub.endpoint);
      } catch { }
    }
    if (dead.length) {
      pushSubs = pushSubs.filter(s => !dead.includes(s.endpoint));
      saveJson('push-subs.json', pushSubs);
    }
  })();
}

function allChannels() {
  // Eigene Kanäle bekommen immer das Standard-Icon und die Community-Regeln
  return [...BUILTIN_CHANNELS, ...customChannels.map(c => ({ icon: 'tag', rules: COMMUNITY_RULES, ...c, emoji: undefined }))];
}
function findChannel(slug) { return allChannels().find(c => c.slug === slug); }

// ---------------------------------------------------------------- Scam-Filter / Moderation
// Zweistufig: BLOCK verhindert den Post, WARN markiert ihn sichtbar.
// Hier würde später ein KI-Moderator (Claude-API) einhaken, die Regeln bleiben als schnelle Vorstufe.

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
  { re: /https?:\/\//i, tag: 'Externer Link, auf eigene Gefahr' },
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
    // mydealz-Temperatur-Präfix ("103° - …") abschneiden, zeigen wir nicht an
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
    // Tags raus, mydealz schneidet die Beschreibung teils mitten im Tag ab
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

// Bekannte Marken, um den Händler notfalls aus dem Deal-Titel zu erkennen
const KNOWN_BRANDS = ['Wolt', 'Lieferando', 'Uber Eats', 'REWE', 'Amazon', 'Zalando', 'IKEA', 'Rossmann', 'Lidl', 'EDEKA', 'Netto', 'dm', 'Müller', 'MediaMarkt', 'Saturn', 'H&M', 'Douglas', 'Nike', 'Adidas', 'Spotify', 'Disney', 'Netflix', 'McDonalds', 'Burger King', 'Subway', 'Payback', 'Otto', 'eBay', 'Temu', 'Shein', 'Zara'];

// Community-Posts im selben Deal-Format ausgeben; erster Link im Text wird zum CTA
function postsAsDeals(slug) {
  return (posts[slug] || []).map(p => {
    const discount = p.priceNum && p.compareNum && p.compareNum > p.priceNum
      ? Math.round((1 - p.priceNum / p.compareNum) * 100) : null;
    // Marke: explizit gesetzt, aus dem Link abgeleitet oder im Titel erkannt
    let merchant = p.merchant || '';
    if (!merchant) {
      const u = (p.text.match(/https?:\/\/[^\s"<>]+/) || [''])[0];
      try {
        const parts = new URL(u).hostname.split('.');
        const host = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
        if (host && !['www', 'shop'].includes(host)) merchant = host.charAt(0).toUpperCase() + host.slice(1);
      } catch { }
    }
    if (!merchant) {
      const hit = KNOWN_BRANDS.find(b => new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(p.title));
      if (hit) merchant = hit;
    }
    return {
      id: p.id, channel: slug, title: p.title, image: p.image || '', merchant,
      price: p.priceNum != null ? p.priceNum.toFixed(2).replace('.', ',') + '€' : '',
      origPrice: p.compareNum != null ? p.compareNum.toFixed(2).replace('.', ',') + '€' : '',
      discount, free: p.priceNum === 0, endTs: p.endTs || null,
      compareChecked: !!p.compareChecked, kind: p.kind || 'rabatt',
      priceNum: p.priceNum, compareNum: p.compareNum, rawText: p.text,
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
// präziser als der Deal-Titel. Viele Shops (Amazon) blocken, dann Fallback.
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
  // Fertige Dateien (Buffer) NIE durch JSON.stringify schicken — sonst kommt
  // beim Browser {"type":"Buffer","data":[…]} an statt der Datei. Das betraf
  // jede statische .json, allen voran das PWA-Manifest.
  const data = type.startsWith('application/json') && !Buffer.isBuffer(body)
    ? JSON.stringify(body)
    : body;
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

function readBody(req, maxBytes = 50_000) {
  return new Promise((resolve, reject) => {
    // Stuecke als Buffer sammeln und erst am Ende als UTF-8 lesen: per
    // String-Verkettung zerfielen Umlaute und Emojis an Stueckgrenzen.
    const teile = [];
    let n = 0;
    let over = false;
    // Kein req.destroy() bei Überlänge: das kappt die Verbindung hart und der
    // Client sieht nur "Server nicht erreichbar". Stattdessen Rest verwerfen
    // und sauber mit Fehler antworten, damit eine echte Fehlermeldung ankommt.
    req.on('data', c => {
      if (over) return;
      n += c.length;
      if (n > maxBytes) { over = true; teile.length = 0; return; }
      teile.push(c);
    });
    req.on('end', () => {
      if (over) { const e = new Error('Anfrage zu groß.'); e.tooLarge = true; return reject(e); }
      const text = Buffer.concat(teile).toString('utf8');
      try { resolve(text ? JSON.parse(text) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
    req.on('error', reject);
  });
}

// @Name eines Kontos aendern — nur noch auf Anfrage, vom Team ueber
// /api/admin/rename (frueher konnte das jeder selbst einmal im Monat).
// Liefert eine Fehlermeldung oder '' bei Erfolg. Zieht ueberall mit um:
// Konto, Sessions, Wallet, Geschenke, Chats, DMs, Freunde, Kommentare,
// Profil-Bewertungen, Deal-Bewertungen und Meldungen.
function kontoUmbenennen(me, neu) {
  if (!users[me]) return 'Nutzer nicht gefunden.';
  if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(neu)) return 'Name: 3 bis 24 Zeichen, nur Buchstaben, Zahlen und ._-';
  if (neu === me) return 'So heißt das Konto schon.';
  if (Object.keys(users).some(k => k !== me && k.toLowerCase() === neu.toLowerCase())) return 'Name ist schon vergeben.';
  // Auch kein @Name, der wie der Anzeigename eines anderen aussieht
  if (Object.keys(users).some(k => k !== me && anzeigenameVon(k) && nameSkelett(anzeigenameVon(k)) === nameSkelett(neu)))
    return 'Den Namen trägt schon jemand als Anzeigenamen.';
  const wasAdmin = roleOf(me) === 'admin';
  users[neu] = users[me]; delete users[me];
  if (wasAdmin && !DEFAULT_ADMINS.includes(neu.toLowerCase())) users[neu].role = 'admin';
  profileOf(neu).lastRename = Date.now();
  for (const [t, u] of Object.entries(sessions)) if (u === me) sessions[t] = neu;
  for (const r of Object.values(resets)) if (r.user === me) r.user = neu;
  for (const t of loginTickets.values()) if (t.user === me) t.user = neu;
  // Push-Abos ziehen mit um (sonst bekaeme ein spaeterer Traeger des alten
  // Namens die DMs aufs Geraet)
  for (const x of pushSubs) if (x.user === me) x.user = neu;
  saveJson('push-subs.json', pushSubs);
  for (const c of sseClients) if (c.user === me) c.user = neu;
  saveJson('resets.json', resets);
  if (wallets[me]) { wallets[neu] = wallets[me]; delete wallets[me]; }
  // Wartende Geschenke, Originalfotos und Papierkorb ziehen mit um — sonst
  // waeren sie unter dem neuen Namen unsichtbar (und ein spaeterer
  // Nutzer des alten Namens erbte sie)
  if (gifts[me]) { gifts[neu] = [...(gifts[neu] || []), ...gifts[me]]; delete gifts[me]; }
  for (const liste of Object.values(gifts)) for (const g of liste || []) if (g && g.giftFrom === me) g.giftFrom = neu;
  saveJson('gifts.json', gifts);
  try { if (fs.existsSync(origOrdner(me))) fs.renameSync(origOrdner(me), origOrdner(neu)); } catch (e) { console.error('Originalfotos umziehen:', e.message); }
  archivUmbenennen(me, neu);
  chat.messages.forEach(m => { if (m.user === me) m.user = neu; });
  if (chat.pinned && chat.pinned.user === me) chat.pinned.user = neu;
  if (chat.bans[me]) { chat.bans[neu] = true; delete chat.bans[me]; }
  if (chat.mutes[me]) { chat.mutes[neu] = chat.mutes[me]; delete chat.mutes[me]; }
  const newDms = {};
  for (const [key, convo] of Object.entries(dms)) {
    const parts = key.split('|').map(x => x === me ? neu : x);
    convo.msgs.forEach(m => { if (m.from === me) m.from = neu; });
    if (convo.reads && convo.reads[me] != null) { convo.reads[neu] = convo.reads[me]; delete convo.reads[me]; }
    newDms[parts.sort().join('|')] = convo;
  }
  dms = newDms;
  for (const u of Object.values(users)) {
    const pr = u.profile;
    if (!pr) continue;
    if (pr.friends) pr.friends = pr.friends.map(f => f === me ? neu : f);
    if (pr.friendRequests) pr.friendRequests = pr.friendRequests.map(f => f === me ? neu : f);
    // Vorgemerkte Einladungen ziehen mit
    if (pr.invitedBy === me) pr.invitedBy = neu;
    for (const g of pr.geworben || []) if (g && g.user === me) g.user = neu;
  }
  for (const list of Object.values(comments)) {
    list.forEach(c => {
      if (c.user === me) c.user = neu;
      for (const arr of Object.values(c.reactions || {})) {
        const i = arr.indexOf(me); if (i >= 0) arr[i] = neu;
      }
    });
  }
  // Profil-Bewertungen: die ueber das Konto und die, die es geschrieben hat
  if (profComments[me]) { profComments[neu] = profComments[me]; delete profComments[me]; }
  for (const list of Object.values(profComments)) for (const c of list || []) if (c && c.from === me) c.from = neu;
  // Sterne an Deals (je Nutzer eine) und Meldungen
  for (const r of Object.values(ratings)) {
    if (r && r.by && Object.hasOwn(r.by, me)) { r.by[neu] = r.by[me]; delete r.by[me]; }
  }
  for (const r of reports) { if (r.user === me) r.user = neu; if (r.by === me) r.by = neu; }
  // Eigene Beitraege in den Community-Kanaelen
  for (const liste of Object.values(posts)) for (const x of liste || []) if (x && x.user === me) x.user = neu;
  saveJson('users.json', users); saveJson('sessions.json', sessions);
  saveJson('wallets.json', wallets); saveJson('chat.json', chat);
  saveJson('dms.json', dms); saveJson('comments.json', comments);
  saveJson('profile-comments.json', profComments); saveJson('ratings.json', ratings);
  saveJson('reports.json', reports); saveJson('posts.json', posts);
  return '';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');
  // Teilen-Ziel: normalerweise faengt der Service Worker das ab. Ist er noch
  // nicht aktiv, landet der POST hier — dann einfach zur App
  if (p === '/teilen') { res.writeHead(303, { Location: req.method === 'POST' ? '/?teilen=fehler' : '/' }); return res.end(); }

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
      const dealsViewer = authUser(req); // fuer die eigene Bewertung am Deal
      const withCounts = out
        .filter(d => d.source !== 'mydealz' || now - d.ts < 36 * H)
        .map(d => ({
          ...d,
          stale: (d.source === 'mydealz' && now - d.ts > (d.channel === 'preisfehler' ? 12 : 24) * H)
            || (d.endTs != null && d.endTs < now),
          comments: (comments[d.id] || []).filter(c => !c.deleted).length,
          rating: ratings[d.id]?.count ? ratings[d.id].sum / ratings[d.id].count : null,
          ratingCount: ratings[d.id]?.count || 0,
          myRating: dealsViewer ? (ratings[d.id]?.by || {})[dealsViewer] || 0 : 0,
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
      if (!await verifyTurnstile(b.turnstileToken)) return send(res, 400, { error: 'Captcha-Prüfung fehlgeschlagen, bitte erneut bestätigen.' });
      const user = String(b.user || '').trim();
      const email = String(b.email || '').trim().toLowerCase();
      const pass = String(b.pass || '');
      if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(user)) return send(res, 400, { error: 'Name: 3–24 Zeichen, nur Buchstaben/Zahlen/._-' });
      if (!emailGueltig(email)) return send(res, 400, { error: 'Bitte eine gültige E-Mail-Adresse angeben.' });
      if (pass.length < 6) return send(res, 400, { error: 'Passwort: mindestens 6 Zeichen.' });
      // Namen sind ohne Groß/Klein-Unterscheidung eindeutig ("Luther" = "luther")
      if (Object.keys(users).some(k => k.toLowerCase() === user.toLowerCase()))
        return send(res, 409, { error: 'Name ist schon vergeben.' });
      // … auch als Anzeigename eines anderen (sonst saehe der wie dieses Konto aus)
      if (Object.keys(users).some(k => anzeigenameVon(k) && nameSkelett(anzeigenameVon(k)) === nameSkelett(user)))
        return send(res, 409, { error: 'Name ist schon vergeben.' });
      if (Object.values(users).some(u => u.email === email)) return send(res, 409, { error: 'E-Mail wird schon verwendet.' });
      const salt = crypto.randomBytes(12).toString('hex');
      users[user] = { hash: hashPass(pass, salt), salt, email, newsletter: !!b.newsletter, ts: Date.now() };
      // Neue Konten sehen erst das naechste Update im Update-Log, nicht die alten
      if (NEU_VERSIONEN[0]) profileOf(user).neuGesehen = NEU_VERSIONEN[0];
      setTimeout(() => emailBestaetigungSchicken(user), 0);
      // Freunde werben Freunde: kam die Registrierung ueber einen Einladungslink,
      // wird sie beim Werber vorgemerkt. Eine Belohnung gibt es (noch) nicht —
      // sobald es Einloesemoeglichkeiten gibt, zaehlen die gemerkten mit.
      const ref = String(b.ref || '').trim();
      const refUser = ref && Object.keys(users).find(k => k.toLowerCase() === ref.toLowerCase());
      if (refUser && refUser !== user) {
        const rp = profileOf(refUser);
        // Je Name nur ein Eintrag: ein alter mit demselben Namen wird ersetzt,
        // Registrieren, Loeschen, neu Registrieren blaeht den Zaehler nicht auf
        geworbenEntfernen(rp, g => String(g.user || '').toLowerCase() === user.toLowerCase());
        rp.refCount = (Number(rp.refCount) || 0) + 1;
        rp.geworben = [...(rp.geworben || []), { user, ts: Date.now() }].slice(-1000);
        profileOf(user).invitedBy = refUser;
        pushToUser(refUser, { title: 'Freund eingeladen', body: `@${user} ist über deinen Link dabei.`, url: '/?tab=profile', tag: 'ref-' + user, kind: 'info', from: user });
      }
      saveJson('users.json', users);
      const token = crypto.randomBytes(18).toString('hex');
      sessions[token] = user;
      saveJson('sessions.json', sessions);
      return send(res, 201, { token, user });
    }

    // ---- Passwort vergessen: Link per E-Mail (gilt 60 Minuten, einmal)
    if (p === '/api/password/forgot' && req.method === 'POST') {
      const b = await readBody(req);
      if (!mailBereit()) {
        return send(res, 503, { error: 'Passwort per E-Mail zurücksetzen ist gerade noch nicht eingerichtet. Bitte melde dich beim kumulio-Team.' });
      }
      if (!await verifyTurnstile(b.turnstileToken)) return send(res, 400, { error: 'Captcha-Prüfung fehlgeschlagen, bitte erneut bestätigen.' });
      if (!drossel('forgot-ip:' + ipVon(req), 5, 3600e3)) return send(res, 429, { error: 'Zu viele Versuche. Bitte in einer Stunde nochmal.' });
      const eingabe = String(b.login || '').trim().toLowerCase();
      const user = Object.keys(users).find(k => k.toLowerCase() === eingabe || (users[k].email || '') === eingabe);
      // Immer dieselbe Antwort — sonst liesse sich abfragen, wer ein Konto hat
      const antwort = { ok: true, text: 'Wenn es ein Konto mit diesen Angaben gibt, ist jetzt eine E-Mail unterwegs. Der Link gilt 60 Minuten.' };
      // Nur an bestaetigte Adressen — sonst wuerde ein Tippfehler bei der
      // Registrierung zum Weg in das Konto
      if (!user || !users[user].email || !users[user].emailOk || !drossel('forgot-user:' + user, 3, 3600e3)) return send(res, 200, antwort);
      resetsAufraeumen();
      const token = crypto.randomBytes(24).toString('base64url');
      resets[sha256(token)] = { user, zweck: 'passwort', exp: Date.now() + 3600e3, ts: Date.now() };
      saveJson('resets.json', resets);
      const link = `${mailEinstellungen().basis}/?reset=${token}`;
      // Ohne Warten verschicken: die Antwort kommt gleich schnell, ob es das
      // Konto gibt oder nicht
      (async () => {
        await sendeMail({
          to: users[user].email,
          subject: 'kumulio: Passwort zurücksetzen',
          text: `Hallo @${user},\n\nüber diesen Link legst du ein neues Passwort fest (gilt 60 Minuten):\n${link}\n\nDu hast das nicht angefordert? Dann ignorier diese Mail einfach, dein Passwort bleibt, wie es ist.\n\nDein kumulio-Team`,
          html: mailHtml('Neues Passwort festlegen', [`Hallo @${user},`, 'über den Knopf legst du ein neues Passwort fest. Der Link gilt 60 Minuten.',
            'Du hast das nicht angefordert? Dann ignorier diese Mail einfach, dein Passwort bleibt, wie es ist.'], { text: 'Neues Passwort festlegen', url: link }),
        });
      })().catch(e => console.error('[Mail] Passwort-Link:', e.message));
      return send(res, 200, antwort);
    }
    if (p === '/api/password/reset' && req.method === 'POST') {
      const b = await readBody(req);
      if (!drossel('reset-ip:' + ipVon(req), 20, 3600e3)) return send(res, 429, { error: 'Zu viele Versuche. Bitte später nochmal.' });
      resetsAufraeumen();
      const eintrag = resets[sha256(String(b.token || ''))];
      if (!eintrag || (eintrag.zweck || 'passwort') !== 'passwort' || !users[eintrag.user]) return send(res, 400, { error: 'Der Link ist abgelaufen oder wurde schon benutzt. Fordere einfach einen neuen an.' });
      const pass = String(b.pass || '');
      if (pass.length < 6) return send(res, 400, { error: 'Passwort: mindestens 6 Zeichen.' });
      if (pass.length > 64) return send(res, 400, { error: 'Passwort: höchstens 64 Zeichen.' });
      const user = eintrag.user;
      const salt = crypto.randomBytes(16).toString('hex');
      users[user].salt = salt;
      users[user].hash = hashPass(pass, salt);
      // Alle Links dieses Kontos verfallen; alle Sitzungen, Anmelde-Tickets und
      // Push-Abos enden (auch die eines Angreifers, falls das Passwort geklaut war)
      for (const [k, r] of Object.entries(resets)) if (r.user === user && (r.zweck || 'passwort') === 'passwort') delete resets[k];
      saveJson('users.json', users);
      saveJson('resets.json', resets);
      kontoAbmeldenUeberall(user);
      sicherheitsMail(user, 'Passwort geändert', 'Dein kumulio-Passwort wurde gerade über den Link aus der E-Mail neu festgelegt.');
      // Kein automatisches Anmelden: ein fremder Reset-Link koennte sonst dem
      // Opfer das Konto des Angreifers unterschieben. Die App zeigt den Namen
      // und meldet mit dem neuen Passwort normal an.
      return send(res, 200, { ok: true, user, zweiFaktor: zweiFaktorAn(user) });
    }
    // Fuer den Dialog: zu welchem Konto gehoert der Link? (verraet nur dem, der
    // den Link hat, den Namen)
    if (p === '/api/password/reset-info' && req.method === 'POST') {
      if (!drossel('reset-info:' + ipVon(req), 30, 3600e3)) return send(res, 429, { error: 'Zu viele Versuche.' });
      const b = await readBody(req);
      resetsAufraeumen();
      const e = resets[sha256(String(b.token || ''))];
      if (!e || (e.zweck || 'passwort') !== 'passwort' || !users[e.user]) return send(res, 400, { error: 'Der Link ist abgelaufen oder wurde schon benutzt. Fordere einfach einen neuen an.' });
      return send(res, 200, { user: e.user });
    }

    // ---- E-Mail bestaetigen: nur bestaetigte Adressen bekommen Passwort-Links
    if (p === '/api/email/senden' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      if (!mailBereit()) return send(res, 503, { error: 'E-Mail-Versand ist noch nicht eingerichtet.' });
      if (!users[user].email) return send(res, 400, { error: 'Für dein Konto ist keine E-Mail-Adresse hinterlegt.' });
      if (users[user].emailOk) return send(res, 200, { ok: true, schonBestaetigt: true });
      if (!drossel('email-senden:' + user, 3, 3600e3)) return send(res, 429, { error: 'Schon unterwegs. Schau in dein Postfach (auch in den Spam-Ordner).' });
      emailBestaetigungSchicken(user);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/email/bestaetigen' && req.method === 'POST') {
      if (!drossel('email-ok:' + ipVon(req), 30, 3600e3)) return send(res, 429, { error: 'Zu viele Versuche.' });
      const b = await readBody(req);
      resetsAufraeumen();
      const k = sha256(String(b.token || ''));
      const e = resets[k];
      if (!e || e.zweck !== 'email' || !users[e.user] || users[e.user].email !== e.email) {
        return send(res, 400, { error: 'Der Bestätigungslink ist abgelaufen. Schick dir in den Einstellungen einfach einen neuen.' });
      }
      users[e.user].emailOk = Date.now();
      delete resets[k];
      saveJson('users.json', users);
      saveJson('resets.json', resets);
      return send(res, 200, { ok: true, user: e.user });
    }

    // ---- Papierkorb fuer Nutzer: was aus der Wallet verschwunden ist (geloescht,
    // aufgeraeumt, verschenkt), ein Jahr lang sehen und zurueckholen
    if (p === '/api/papierkorb' && req.method === 'GET') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      const liste = Object.entries(archivVon(user)).sort((x, y) => y[1].ts - x[1].ts).slice(0, 200).map(([key, e]) => ({
        key, ts: e.ts, grund: e.grund, typ: e.typ, art: e.v.art || '', vendor: e.v.vendor || e.v.name || '',
        amount: e.v.amount ?? null, balance: e.v.balance ?? null, bild: !!(e.v.codeImg || e.v.img),
        verschenkt: /^verschenkt/.test(e.grund || ''),
      }));
      return send(res, 200, { liste });
    }
    if (p === '/api/papierkorb/zurueck' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      const b = await readBody(req);
      const a = archivVon(user);
      const e = a[String(b.key || '')];
      if (!e) return send(res, 404, { error: 'Eintrag nicht gefunden.' });
      // Verschenkte Gutscheine gehoeren jetzt dem Freund — nicht zurueckholbar
      if (/^verschenkt/.test(e.grund || '')) return send(res, 409, { error: 'Den hast du verschenkt, er gehört jetzt deinem Freund.' });
      const w = wallets[user] || (wallets[user] = { vouchers: [], cards: [], deleted: [] });
      const karte = e.typ === 'karte';
      const liste = karte ? (w.cards = w.cards || []) : (w.vouchers = w.vouchers || []);
      if (liste.length >= (karte ? WALLET_LIMIT_KARTEN : WALLET_LIMIT_GUTSCHEINE)) return send(res, 409, { error: 'Deine Wallet ist voll. Lösch erst etwas.' });
      const zurueck = bilderAblegen({ ...e.v, id: neueGutscheinId(), added: Date.now(), mt: Date.now(), wiederhergestellt: Date.now() });
      if (e.v.orig) { try { fs.renameSync(origPfad(user, e.v.id), origPfad(user, zurueck.id)); } catch { delete zurueck.orig; } }
      liste.unshift(zurueck);
      delete a[String(b.key)];
      saveJsonSoon(archivDatei(user), a, 200);
      saveJson('wallets.json', wallets);
      ssePush('gift', user);
      return send(res, 200, { ok: true, id: zurueck.id });
    }

    // ---- Passwort pruefen (z. B. um eine vergessene Wallet-PIN zu loeschen)
    if (p === '/api/konto/passwort-pruefen' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      if (!drossel('pw-pruefen:' + user, 5, 15 * 60e3)) return send(res, 429, { error: 'Zu viele Versuche. Bitte in 15 Minuten nochmal.' });
      const b = await readBody(req);
      const u = users[user];
      if (!u || hashPass(String(b.pass || ''), u.salt) !== u.hash) return send(res, 403, { error: 'Das Passwort stimmt nicht.' });
      return send(res, 200, { ok: true });
    }

    // ---- Einstellungen am Konto (gelten auf allen Geraeten)
    if (p === '/api/einstellungen' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      const b = await readBody(req);
      const prof = profileOf(user);
      if (typeof b.autoAufraeumen === 'boolean') prof.autoAufraeumen = b.autoAufraeumen;
      saveJson('users.json', users);
      return send(res, 200, { ok: true, autoAufraeumen: prof.autoAufraeumen !== false });
    }

    // ---- Zwei-Faktor einrichten / ausschalten
    if (p === '/api/2fa/start' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      if (zweiFaktorAn(user)) return send(res, 409, { error: 'Zwei-Faktor ist schon eingeschaltet.' });
      const secret = base32(crypto.randomBytes(20));
      users[user].totpNeu = { secret, ts: Date.now() };
      saveJson('users.json', users);
      const uri = `otpauth://totp/kumulio:${encodeURIComponent(user)}?secret=${secret}&issuer=kumulio&digits=6&period=30`;
      return send(res, 200, { secret, uri });
    }
    if (p === '/api/2fa/aktivieren' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      if (!drossel('2fa-akt:' + user, 10, 15 * 60e3)) return send(res, 429, { error: 'Zu viele Versuche. Bitte in 15 Minuten nochmal.' });
      const b = await readBody(req);
      const neu = users[user].totpNeu;
      if (!neu || Date.now() - neu.ts > 30 * 60e3) return send(res, 400, { error: 'Die Einrichtung ist abgelaufen. Bitte neu starten.' });
      const t = { secret: neu.secret, aktiv: true, seit: Date.now(), letzter: 0 };
      if (!totpPruefen(t, b.code)) return send(res, 400, { error: 'Der Code stimmt nicht. Schau, ob die Uhr am Handy richtig geht.' });
      const { codes, hashes } = neueErsatzcodes();
      t.reserve = hashes;
      users[user].totp = t;
      delete users[user].totpNeu;
      saveJson('users.json', users);
      // Alle anderen Sitzungen enden: ab jetzt gibt es nur noch Sitzungen, die
      // mit zweitem Faktor entstanden sind (deshalb reicht zum Ausschalten das Passwort)
      kontoAbmeldenUeberall(user, tokenVon(req));
      sicherheitsMail(user, 'Zwei-Faktor eingeschaltet', 'Für dein kumulio-Konto ist jetzt die Anmeldung mit zweitem Faktor (Authenticator-App) eingeschaltet.');
      return send(res, 200, { ok: true, ersatzcodes: codes });
    }
    if (p === '/api/2fa/aus' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      if (!drossel('2fa-aus:' + user, 5, 15 * 60e3)) return send(res, 429, { error: 'Zu viele Versuche. Bitte in 15 Minuten nochmal.' });
      const b = await readBody(req);
      const u = users[user];
      // Nur das Passwort: einen 2FA-Code gibt es ausschliesslich bei der Anmeldung
      // (die Sitzung selbst ist ja schon mit zweitem Faktor entstanden)
      if (hashPass(String(b.pass || ''), u.salt) !== u.hash) return send(res, 403, { error: 'Das Passwort stimmt nicht.' });
      delete u.totp;
      ticketsWeg(user);
      saveJson('users.json', users);
      sicherheitsMail(user, 'Zwei-Faktor ausgeschaltet', 'Für dein kumulio-Konto ist die Anmeldung mit zweitem Faktor jetzt ausgeschaltet.');
      return send(res, 200, { ok: true });
    }
    // Anmeldung, zweiter Schritt: Code aus der App (oder ein Ersatzcode)
    if (p === '/api/login/2fa' && req.method === 'POST') {
      const b = await readBody(req);
      const ticket = String(b.ticket || '');
      const t = loginTickets.get(ticket);
      if (!t || t.exp < Date.now()) return send(res, 400, { error: 'Die Anmeldung ist abgelaufen. Bitte nochmal mit Passwort anmelden.' });
      // Kontoweit: hoechstens 10 falsche Codes pro Stunde — sonst liesse sich
      // der Code mit bekanntem Passwort ueber Wochen durchprobieren
      if (zuVieleFehler('2fa-fehl:' + t.user, 10, 3600e3)) {
        loginTickets.delete(ticket);
        return send(res, 429, { error: 'Zu viele falsche Codes. Bitte in einer Stunde nochmal.' });
      }
      if (++t.versuche > 5) { loginTickets.delete(ticket); return send(res, 429, { error: 'Zu viele falsche Codes. Bitte nochmal mit Passwort anmelden.' }); }
      const u = users[t.user];
      const ok = u && (totpPruefen(u.totp, b.code) || ersatzcodeEinloesen(u.totp, b.code));
      if (!ok) {
        fehlerMerken('2fa-fehl:' + t.user);
        if (zuVieleFehler('2fa-fehl:' + t.user, 10, 3600e3)) sicherheitsMail(t.user, 'Viele falsche Anmeldecodes', 'Bei deinem kumulio-Konto wurde mehrfach ein falscher Bestätigungscode eingegeben — jemand kennt vielleicht dein Passwort. Ändere es am besten.');
        return send(res, 401, { error: 'Der Code stimmt nicht.' });
      }
      loginTickets.delete(ticket);
      saveJson('users.json', users); // letzter Zeitschritt bzw. verbrauchter Ersatzcode
      const token = crypto.randomBytes(18).toString('hex');
      sessions[token] = t.user;
      saveJson('sessions.json', sessions);
      return send(res, 200, { token, user: t.user, restErsatzcodes: (u.totp.reserve || []).length });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      if (!await verifyTurnstile(b.turnstileToken)) return send(res, 400, { error: 'Captcha-Prüfung fehlgeschlagen, bitte erneut bestätigen.' });
      const typed = String(b.user || '').trim();
      // Groß/Klein egal: Nutzer findet sich auch als "luther", wenn er "Luther" heißt
      const user = Object.keys(users).find(k => k.toLowerCase() === typed.toLowerCase());
      const u = user ? users[user] : null;
      // Gegen Durchprobieren: nur FEHLVERSUCHE zaehlen — 10 je Konto und Netz,
      // 100 je Konto insgesamt, 30 je Netz in 15 Minuten
      const ip = ipVon(req);
      if (zuVieleFehler('login-ip:' + ip, 30, 15 * 60e3)
        || (user && (zuVieleFehler('login-user:' + user + ':' + ip, 10, 15 * 60e3) || zuVieleFehler('login-user:' + user, 100, 15 * 60e3)))) {
        return send(res, 429, { error: 'Zu viele Anmeldeversuche. Bitte in 15 Minuten nochmal — oder Passwort zurücksetzen.' });
      }
      if (!u || hashPass(String(b.pass || ''), u.salt) !== u.hash) {
        fehlerMerken('login-ip:' + ip, ...(user ? ['login-user:' + user + ':' + ip, 'login-user:' + user] : []));
        return send(res, 401, { error: 'Name oder Passwort falsch.' });
      }
      // Zwei-Faktor an: erst der Code, dann die Sitzung
      if (zweiFaktorAn(user)) {
        for (const [k, t] of loginTickets) if (t.exp < Date.now()) loginTickets.delete(k);
        const ticket = crypto.randomBytes(18).toString('hex');
        loginTickets.set(ticket, { user, exp: Date.now() + 5 * 60e3, versuche: 0 });
        return send(res, 200, { zweiFaktor: true, ticket, user });
      }
      const token = crypto.randomBytes(18).toString('hex');
      sessions[token] = user;
      saveJson('sessions.json', sessions);
      return send(res, 200, { token, user });
    }

    // ---- Metadaten fuer Chats und Profile (der Global-Chat ist entfernt)
    // Emotes und Wallet-Grenzen. Frueher kamen die huckepack mit dem
    // Global-Chat — den gibt es nicht mehr, gebraucht werden sie aber weiter:
    // in den Fluesterchats, auf Profilen und beim Verschenken.
    if (p === '/api/meta' && req.method === 'GET') {
      const allEmotes = EMOTE_IDS; // nur Katzen und Peepo, fuer alle frei
      return send(res, 200, { emotes: allEmotes,
        walletLimit: { gutscheine: WALLET_LIMIT_GUTSCHEINE, karten: WALLET_LIMIT_KARTEN } });
    }
    // Den Global-Chat gibt es nicht mehr. Wer die App noch von vorher offen hat,
    // bekommt hier weiter die Metadaten, aber keine Nachrichten mehr. Die alten
    // Nachrichten bleiben in chat.json liegen und werden nicht ausgeliefert.
    if (p === '/api/chat' && req.method === 'GET') {
      const allEmotes = EMOTE_IDS; // nur Katzen und Peepo, fuer alle frei
      return send(res, 200, {
        messages: [], updates: [], pinned: null,
        emotes: allEmotes,
      });
    }
    // Global-Chat entfernt: Schreiben, Moderieren und Loeschen dort gehen
    // nicht mehr. Der Admin-Befehl !funken ist in die Fluesterchats umgezogen
    // (siehe /api/dm/send). 410 statt 404, damit klar ist: das gab es, und es
    // ist bewusst weg.
    if (req.method === 'POST' && (p === '/api/chat' || p === '/api/chat/mod' || p === '/api/chat/delete')) {
      return send(res, 410, { error: 'Den Global-Chat gibt es nicht mehr. Schreib deinen Freunden direkt.' });
    }

    // Nutzer melden
    if (p === '/api/chat/report' && req.method === 'POST') {
      const me = authUser(req);
      if (!me) return send(res, 401, { error: 'Bitte anmelden.' });
      const b = await readBody(req);
      reports.push({ id: crypto.randomBytes(5).toString('hex'), user: String(b.user || '').slice(0, 24), msgId: String(b.id || ''), by: me, ts: Date.now() });
      if (reports.length > 500) reports = reports.slice(-500);
      saveJson('reports.json', reports);
      return send(res, 200, { ok: true });
    }
    // Admin-Panel: die Moderation des Global-Chats ist mit ihm entfallen
    if (p === '/api/admin/chat' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      return send(res, 410, { error: 'Den Global-Chat gibt es nicht mehr.' });
    }

    // ---- Flüstern (private 1:1-Chats, WhatsApp-artige Liste)
    if (p === '/api/dm/list' && req.method === 'GET') {
      const me = authUser(req);
      if (!me) return send(res, 401, { error: 'Bitte anmelden.' });
      const list = [];
      for (const [key, convo] of Object.entries(dms)) {
        const [a, b] = key.split('|');
        if (a !== me && b !== me) continue;
        const partner = a === me ? b : a;
        const lastMsg = convo.msgs[convo.msgs.length - 1];
        if (!lastMsg) continue;
        const readTs = (convo.reads || {})[me] || 0;
        list.push({
          partner, lastText: lastMsg.text.slice(0, 60), lastTs: lastMsg.ts,
          lastMine: lastMsg.from === me, // fuer das "Du:" in der Vorschau
          unread: convo.msgs.filter(m => m.from !== me && m.ts > readTs).length,
        });
      }
      list.sort((x, y) => y.lastTs - x.lastTs);
      list.forEach(l => {
        const lp = users[l.partner] ? profileOf(l.partner) : null;
        l.avatar = lp ? lp.avatar || '' : '';
        l.paint = namensfarbe(l.partner);
        if (lp && lp.anzeigename) l.anzeigename = anzeigenameVon(l.partner);
      });
      // Freunde ohne bisherigen Chat mit anbieten
      const friends = (profileOf(me).friends || [])
        .filter(f => !list.some(l => l.partner === f))
        .map(f => {
          const fp = users[f] ? profileOf(f) : null;
          return { name: f, avatar: fp ? fp.avatar || '' : '', paint: namensfarbe(f), ...mitAnzeigename(f) };
        });
      return send(res, 200, { list, friends });
    }
    // Avatare für Listen (Freunde, Anfragen), nur kleine Profilbilder
    if (p === '/api/avatars' && req.method === 'GET') {
      const names = String(url.searchParams.get('names') || '').split(',').filter(Boolean).slice(0, 50);
      const map = {};
      for (const n of names) if (users[n]) map[n] = profileOf(n).avatar || '';
      return send(res, 200, map);
    }
    if (p === '/api/dm/with' && req.method === 'GET') {
      const me = authUser(req);
      if (!me) return send(res, 401, { error: 'Bitte anmelden.' });
      const partner = String(url.searchParams.get('user') || '');
      const since = Number(url.searchParams.get('since') || 0);
      const convo = dms[dmKey(me, partner)] || { msgs: [], reads: {} };
      convo.reads = convo.reads || {};
      convo.reads[me] = Date.now();
      if (dms[dmKey(me, partner)]) saveJson('dms.json', dms);
      const updates = convo.msgs.filter(m => m.delTs && m.delTs > since && m.ts <= since).map(m => m.id);
      return send(res, 200, { messages: withLiveLook(convo.msgs.filter(m => m.ts > since).slice(-60), 'from'), updates });
    }
    // Eigene Flüster-Nachricht löschen
    if (p === '/api/dm/delete' && req.method === 'POST') {
      const me = authUser(req);
      if (!me) return send(res, 401, { error: 'Bitte anmelden.' });
      const b = await readBody(req);
      const convo = dms[dmKey(me, String(b.user || ''))];
      const m = convo && convo.msgs.find(x => x.id === String(b.id || ''));
      if (!m) return send(res, 404, { error: 'Nachricht nicht gefunden.' });
      if (m.from !== me) return send(res, 403, { error: 'Nur eigene Nachrichten.' });
      m.deleted = true; m.text = ''; m.delTs = Date.now();
      saveJson('dms.json', dms);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/dm/send' && req.method === 'POST') {
      const me = authUser(req);
      if (!me) return send(res, 401, { error: 'Zum Flüstern bitte anmelden.' });
      const b = await readBody(req);
      const to = String(b.to || '');
      if (!users[to]) return send(res, 404, { error: 'Nutzer nicht gefunden.' });
      if (to === me) return send(res, 400, { error: 'Mit dir selbst flüstern? Sadge.' });
      const text = String(b.text || '').trim().slice(0, 220);
      if (!text) return send(res, 400, { error: 'Leere Nachricht.' });
      // Auch beim Flüstern: 3 schnelle Nachrichten frei, erst dann bremsen
      chatBurst['dm:' + me] = (chatBurst['dm:' + me] || []).filter(t => Date.now() - t < 5000);
      if (chatBurst['dm:' + me].length >= 3) return send(res, 429, { error: 'Langsam, kurz warten.' });
      chatBurst['dm:' + me].push(Date.now());
      const key = dmKey(me, to);
      dms[key] = dms[key] || { msgs: [], reads: {} };
      // Gespeichert wird nur die Rolle; die Namensfarbe kommt beim Ausliefern
      // frisch dazu (withLiveLook), Raenge gehen nie mit raus
      const msg = {
        id: crypto.randomBytes(5).toString('hex'), from: me, text: censor(text), ts: Date.now(),
        role: roleOf(me),
      };
      dms[key].msgs.push(msg);
      if (dms[key].msgs.length > 200) dms[key].msgs = dms[key].msgs.slice(-200);
      dms[key].reads[me] = Date.now();
      saveJsonSoon('dms.json', dms);
      ssePush('dm', to); // Empfänger sieht die Nachricht sofort
      // Aufs Handy, auch wenn die App zu ist; der Client blendet es im offenen Chat selbst aus
      // Geteilte Deals und Coupons ohne ihr [deal:…]/[coupon:…]-Kuerzel
      const pushText = msg.text.replace(/^\[(?:deal|coupon):[^\]]{1,80}\]\s*/i, '') || msg.text;
      pushToUser(to, { title: nameFuerAndere(me), body: pushText.slice(0, 120), url: '/?chat=dm&user=' + encodeURIComponent(me), tag: 'dm-' + me, kind: 'dm', from: me });
      return send(res, 201, { ok: true, message: { ...msg, paint: namensfarbe(me), ...mitAnzeigename(me) } });
    }
    // Freunde: Anfrage senden, annehmen, ablehnen, entfernen (beidseitig)
    if (p === '/api/friend' && req.method === 'POST') {
      const me = authUser(req);
      if (!me) return send(res, 401, { error: 'Bitte anmelden.' });
      const b = await readBody(req);
      const target = String(b.user || '');
      if (!users[target]) return send(res, 404, { error: 'Nutzer nicht gefunden.' });
      if (target === me) return send(res, 400, { error: 'Das bist du selbst.' });
      const my = profileOf(me), their = profileOf(target);
      my.friends = my.friends || []; my.friendRequests = my.friendRequests || [];
      their.friends = their.friends || []; their.friendRequests = their.friendRequests || [];
      if (b.action === 'remove') {
        my.friends = my.friends.filter(f => f !== target);
        their.friends = their.friends.filter(f => f !== me);
      } else if (b.action === 'accept') {
        if (!my.friendRequests.includes(target)) return send(res, 404, { error: 'Keine Anfrage von diesem Nutzer.' });
        my.friendRequests = my.friendRequests.filter(f => f !== target);
        if (!my.friends.includes(target)) my.friends.push(target);
        if (!their.friends.includes(me)) their.friends.push(me);
      } else if (b.action === 'decline') {
        my.friendRequests = my.friendRequests.filter(f => f !== target);
      } else { // Anfrage senden
        if (my.friends.includes(target)) return send(res, 409, { error: 'Ihr seid schon Freunde.' });
        if (their.friendRequests.includes(me)) return send(res, 409, { error: 'Anfrage läuft schon.' });
        if (my.friendRequests.includes(target)) {
          // Gegenseite hat schon angefragt: direkt Freunde
          my.friendRequests = my.friendRequests.filter(f => f !== target);
          my.friends.push(target); their.friends.push(me);
        } else {
          their.friendRequests.push(me);
        }
      }
      saveJson('users.json', users);
      return send(res, 200, { ok: true, friends: my.friends, friendRequests: my.friendRequests, namen: anzeigeNamen([...my.friends, ...my.friendRequests]) });
    }
    // Öffentliches Profil eines Nutzers ansehen (Mods sehen zusätzlich den Moderations-Status)
    if (p === '/api/user' && req.method === 'GET') {
      const name = String(url.searchParams.get('name') || '');
      if (!users[name]) return send(res, 404, { error: 'Nutzer nicht gefunden.' });
      const prof = profileOf(name);
      const wer = authUser(req);
      const modInfo = isModUser(wer) ? {
        banned: !!chat.bans[name],
        mutedUntil: (chat.mutes[name] || 0) > Date.now() ? chat.mutes[name] : 0,
      } : {};
      // Namensfarbe und Anzeigename stehen ohnehin an jeder Nachricht, sie sind
      // nicht privat.
      // Vom Rang geht nur die Stufe (1..7) raus, damit das Profil in der
      // Rang-Farbe erscheint (Wunsch des Nutzers, Runde 122) — nie Guthaben,
      // Betrag oder Abstand, bei privaten Profilen gar nichts und nur an
      // Angemeldete (sonst liesse sich ohne Konto die Stufe aller abfragen).
      if (prof.publicProfile === false) {
        return send(res, 200, { user: name, private: true, role: roleOf(name), activePaint: namensfarbe(name), anzeigename: anzeigenameVon(name), ...modInfo });
      }
      return send(res, 200, {
        user: name, role: roleOf(name), bio: prof.bio || '', avatar: prof.avatar || '',
        favs: prof.favs || {}, activePaint: namensfarbe(name), anzeigename: anzeigenameVon(name), ...(wer ? { stufe: rangStufe(name) } : {}), ...modInfo,
      });
    }

    // Der @Name ist ab der Registrierung fest: selbst aendern geht nicht mehr,
    // nur auf Anfrage ueber das Team (/api/admin/rename). Frei aenderbar ist
    // der Anzeigename (POST /api/profile, Feld "anzeigename").
    if (p === '/api/handle' && req.method === 'POST') {
      return send(res, 403, { error: 'Dein @Name ist seit der Registrierung fest. Ändern können wir ihn nur auf Anfrage, schreib uns dafür (Kontakt im Impressum). Deinen Anzeigenamen kannst du selbst ändern.' });
    }

    // Konto löschen (aus den Einstellungen, mit Bestätigung im Client)
    if (p === '/api/account/delete' && req.method === 'POST') {
      const me = authUser(req);
      if (!me) return send(res, 401, { error: 'Bitte anmelden.' });
      // Endgueltig loeschen nur mit Passwort — wer bloss das Handy in der Hand
      // hat, darf das nicht
      const bd = await readBody(req);
      if (!drossel('delete-pw:' + me, 5, 15 * 60e3)) return send(res, 429, { error: 'Zu viele Versuche. Bitte in 15 Minuten nochmal.' });
      if (!users[me] || hashPass(String(bd.pass || ''), users[me].salt) !== users[me].hash) return send(res, 403, { error: 'Das Passwort stimmt nicht.' });
      pushSubs = pushSubs.filter(x => x.user !== me);
      saveJson('push-subs.json', pushSubs);
      delete users[me];
      for (const [t, u] of Object.entries(sessions)) if (u === me) delete sessions[t];
      for (const [k, r] of Object.entries(resets)) if (r.user === me) delete resets[k];
      ticketsWeg(me);
      saveJson('resets.json', resets);
      // Noch nicht ausgepackte Geschenke gehen an die Absender zurueck, statt
      // mit dem Konto zu verschwinden (oder an jemanden, der spaeter den
      // Namen registriert)
      for (const g of gifts[me] || []) {
        const von = g && g.giftFrom;
        if (!von || !users[von]) continue;
        const wv = wallets[von] || (wallets[von] = { vouchers: [], cards: [], deleted: [] });
        wv.vouchers = wv.vouchers || [];
        const { giftFrom, giftTs, giftMsg, giftSeen, ...rest } = g;
        const zurueckId = neueGutscheinId();
        // Originalfoto sofort (synchron) umziehen — gleich danach wird der
        // Ordner des geloeschten Kontos entfernt
        if (rest.orig) {
          try { fs.mkdirSync(origOrdner(von), { recursive: true }); fs.renameSync(origPfad(me, g.id), origPfad(von, zurueckId)); } catch { delete rest.orig; }
        }
        wv.vouchers.unshift({ ...rest, id: zurueckId, added: Date.now(), mt: Date.now() });
        ssePush('gift', von);
      }
      delete gifts[me];
      delete wallets[me];
      // Erst die Wallets (zurueckgegebene Geschenke), dann der Vorrat
      saveJson('wallets.json', wallets);
      saveJson('gifts.json', gifts);
      fs.promises.rm(origOrdner(me), { recursive: true, force: true }).catch(() => {});
      archivLoeschen(me);
      for (const key of Object.keys(dms)) if (key.split('|').includes(me)) delete dms[key];
      chat.messages.forEach(m => { if (m.user === me) { m.user = 'Gelöschter Nutzer'; m.deleted = true; m.text = ''; } });
      for (const u of Object.values(users)) {
        const pr = u.profile;
        if (!pr) continue;
        if (pr.friends) pr.friends = pr.friends.filter(f => f !== me);
        if (pr.friendRequests) pr.friendRequests = pr.friendRequests.filter(f => f !== me);
        // Einladungen: das geloeschte Konto zaehlt beim Werber nicht mehr mit
        // (Name und Zeit fliegen raus), und wen es geworben hat, der zeigt
        // nicht mehr auf den Namen — sonst erbte ihn, wer ihn neu registriert
        if (pr.invitedBy === me) delete pr.invitedBy;
        geworbenEntfernen(pr, g => g.user === me);
      }
      saveJson('users.json', users); saveJson('sessions.json', sessions);
      saveJson('wallets.json', wallets); saveJson('chat.json', chat); saveJson('dms.json', dms);
      return send(res, 200, { ok: true });
    }

    // ---- Echtzeit-Stream: der Server pingt bei neuen Chat-/DM-Nachrichten,
    // der Client lädt dann sofort nach (EventSource kann keine Header → Token als Query)
    if (p === '/api/stream' && req.method === 'GET') {
      const user = sessions[String(url.searchParams.get('token') || '')] || null;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\nevent: hello\ndata: 1\n\n');
      const client = { res, user };
      sseClients.add(client);
      // Heartbeat hält Proxies (Cloudflare) bei Laune
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { } }, 25000);
      req.on('close', () => { clearInterval(hb); sseClients.delete(client); });
      return;
    }

    // ---- Web-Push: abonnieren / abmelden
    if (p === '/api/push/key' && req.method === 'GET') {
      return send(res, 200, { key: getVapid().publicKey });
    }
    if (p === '/api/push/subscribe' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.endpoint || !b.keys?.p256dh || !b.keys?.auth) return send(res, 400, { error: 'Ungültiges Abo.' });
      const subUser = authUser(req);
      const existing = pushSubs.find(s => s.endpoint === b.endpoint);
      if (existing) {
        // Abo an den (jetzt) angemeldeten Nutzer binden, damit DMs/Erwähnungen ankommen
        if (subUser && existing.user !== subUser) { existing.user = subUser; saveJson('push-subs.json', pushSubs); }
      } else {
        pushSubs.push({ endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth }, user: subUser || '' });
        if (pushSubs.length > 5000) pushSubs = pushSubs.slice(-5000);
        saveJson('push-subs.json', pushSubs);
      }
      return send(res, 201, { ok: true });
    }
    if (p === '/api/push/unsubscribe' && req.method === 'POST') {
      const b = await readBody(req);
      pushSubs = pushSubs.filter(s => s.endpoint !== b.endpoint);
      saveJson('push-subs.json', pushSubs);
      return send(res, 200, { ok: true });
    }

    // ---- Profil: Bio, Bild, Lieblingsmarken, Namensfarbe, Login-Serie
    // Kisten, Funken, Quests, Shop, Paints und Rahmen gibt es nicht mehr
    if (GAMI_WEG.has(p)) return send(res, 410, { error: 'Diese Funktion gibt es nicht mehr.' });
    if (p === '/api/profile' && req.method === 'GET') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      if (zaehleLoginTag(profileOf(user))) saveJsonSoon('users.json', users);
      return send(res, 200, eigenesProfil(user));
    }
    if (p === '/api/profile' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      const b = await readBody(req, 300_000); // Platz fürs (komprimierte) Profilbild
      // Erst alles pruefen, dann schreiben: sonst stuende bei einer 400 die
      // halbe Aenderung (Bio, Sichtbarkeit, Bild) schon im Konto
      if (typeof b.nameColor === 'string' && b.nameColor !== '' && !FARBE_OK.test(b.nameColor))
        return send(res, 400, { error: 'Bitte eine Farbe im Format #RRGGBB wählen.' });
      const prof = profileOf(user);
      // Anzeigename: nur pruefen, wenn er sich wirklich aendert (ein inzwischen
      // strengerer Filter blockiert so nicht jedes Speichern mit dem alten).
      // Das erste Mal geht sofort, danach alle 7 Tage — auch das Zuruecksetzen
      // auf den @Namen zaehlt als Aenderung.
      let neuerAnzeigename = null;
      if (typeof b.anzeigename === 'string' && b.anzeigename.normalize('NFC').replace(/\s+/g, ' ').trim() !== anzeigenameVon(user)) {
        const ab = anzeigenameAb(prof);
        if (ab) {
          const tage = Math.ceil((ab - Date.now()) / 864e5);
          return send(res, 409, { error: `Du kannst deinen Anzeigenamen erst in ${tage} ${tage === 1 ? 'Tag' : 'Tagen'} wieder ändern.` });
        }
        const pr = anzeigenamePruefen(user, b.anzeigename);
        if (pr.error) return send(res, 400, { error: pr.error });
        neuerAnzeigename = pr.name;
      }
      if (typeof b.bio === 'string') prof.bio = censor(b.bio.trim().slice(0, 160));
      if (typeof b.publicProfile === 'boolean') prof.publicProfile = b.publicProfile;
      // Profilbild: kleines dataURL-Bild (Client verkleinert auf 96px)
      // Ganz pruefen, nicht nur den Anfang: das Bild landet bei allen in src="…"
      if (typeof b.avatar === 'string' && (b.avatar === '' || (AVATAR_OK.test(b.avatar) && b.avatar.length < 60_000)))
        prof.avatar = b.avatar;
      // Namensfarbe: #rrggbb oder leer (= automatisch, die feste Chat-Farbe)
      if (b.nameColor === '' || b.nameColor === null) delete prof.nameColor;
      else if (typeof b.nameColor === 'string') prof.nameColor = b.nameColor.toLowerCase(); // oben geprueft
      if (neuerAnzeigename !== null) {
        if (neuerAnzeigename) prof.anzeigename = neuerAnzeigename; else delete prof.anzeigename;
        prof.anzeigenameTs = Date.now();
      }
      // Lieblings-Kleinigkeiten fürs Profil, alles durch den Filter
      if (b.favs && typeof b.favs === 'object') {
        prof.favs = prof.favs || {};
        for (const k of ['discounter', 'supermarkt', 'essen', 'onlineshop', 'mode']) {
          if (typeof b.favs[k] === 'string') prof.favs[k] = censor(b.favs[k].trim().slice(0, 30));
        }
      }
      saveJson('users.json', users);
      return send(res, 200, { ok: true, ...eigenesProfil(user) });
    }
    // Profil einmalig bewerten und kommentieren (ein Eintrag pro Besucher, Upsert)
    if (p === '/api/profile/comments' && req.method === 'GET') {
      const target = String(url.searchParams.get('user') || '');
      if (!users[target]) return send(res, 404, { error: 'Nutzer nicht gefunden.' });
      const me = authUser(req);
      const list = (profComments[target] || []).map(c => {
        const cp = users[c.from] ? profileOf(c.from) : null;
        return { ...c, avatar: cp ? cp.avatar || '' : '', paint: cp ? namensfarbe(c.from) : null, ...(cp ? mitAnzeigename(c.from) : {}) };
      }).sort((a, z) => z.ts - a.ts);
      const stars = list.map(c => c.stars).filter(Boolean);
      const avg = stars.length ? Math.round(stars.reduce((a, x) => a + x, 0) / stars.length * 10) / 10 : 0;
      return send(res, 200, { list, avg, count: stars.length, mine: me ? (profComments[target] || []).find(c => c.from === me) || null : null });
    }
    if (p === '/api/profile/comment' && req.method === 'POST') {
      const me = authUser(req);
      if (!me) return send(res, 401, { error: 'Bitte anmelden.' });
      const b = await readBody(req);
      const target = String(b.user || '');
      if (!users[target]) return send(res, 404, { error: 'Nutzer nicht gefunden.' });
      if (target === me) return send(res, 400, { error: 'Das eigene Profil bewertet man nicht selbst.' });
      const text = String(b.text || '').trim().slice(0, 140);
      const stars = Math.min(5, Math.max(1, Math.round(Number(b.stars) || 0)));
      profComments[target] = (profComments[target] || []).filter(c => c.from !== me);
      if (text || b.stars) {
        const mod = moderate(text);
        if (mod.blocked) return send(res, 400, { error: mod.reason });
        profComments[target].push({ from: me, text: censor(text), stars, ts: Date.now() });
      }
      saveJson('profile-comments.json', profComments);
      return send(res, 200, { ok: true });
    }

    // ---- Originalfoto eines Gutscheins: hochladen, abholen, loeschen
    if (p === '/api/wallet/orig') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      const id = String(url.searchParams.get('id') || '');
      if (!ORIG_ID.test(id)) return send(res, 400, { error: 'Ungültige ID.' });
      const datei = origPfad(user, id);
      if (req.method === 'GET') {
        let buf;
        try { buf = await fs.promises.readFile(datei); } catch { return send(res, 404, { error: 'Kein Original gespeichert.' }); }
        return send(res, 200, buf, bildTyp(buf) || 'image/jpeg');
      }
      if (req.method === 'POST') {
        let buf;
        try { buf = await readRaw(req, 2_500_000); } catch (e) {
          return send(res, e.tooLarge ? 413 : 400, { error: e.tooLarge ? 'Das Foto ist zu groß.' : 'Upload abgebrochen.' });
        }
        // Der Client schickt JPEG oder WebP aus dem Canvas — alles andere ist Unfug
        if (buf.length < 200 || !bildTyp(buf)) {
          return send(res, 400, { error: 'Nur JPEG- oder WebP-Fotos.' });
        }
        await fs.promises.mkdir(origOrdner(user), { recursive: true });
        // Deckel passend zur Wallet-Notbremse, mit Luft fuer Papierkorb und
        // Geschenke. "Voll" (507) versucht das Geraet spaeter nochmal.
        if (!fs.existsSync(datei) && (await fs.promises.readdir(origOrdner(user))).filter(f => f.endsWith('.jpg')).length >= WALLET_MAX_GUTSCHEINE + 200) {
          return send(res, 507, { error: 'Zu viele Originalfotos gespeichert.', voll: true });
        }
        // Erst vollstaendig schreiben, dann umbenennen: ein abgebrochener Upload
        // hinterlaesst nie ein halbes Bild
        await fs.promises.writeFile(datei + '.tmp', buf);
        await fs.promises.rename(datei + '.tmp', datei);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        await fs.promises.rm(datei, { force: true });
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: 'Methode nicht erlaubt.' });
    }

    // ---- Wallet am Konto: überlebt Gerätewechsel und App-Neuinstallation
    if (p === '/api/wallet' && req.method === 'GET') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      // Wartende Geschenke fahren huckepack mit; gelöscht werden sie erst,
      // wenn der Empfänger sie bestätigt hat (claim)
      // Alt-Geschenke mit einer ID, die hier schon belegt ist (Gutschein ging
      // schon einmal hin und her), bekommen eine eigene — die App blendete sie
      // sonst aus, weil sie "schon in der Wallet" schienen.
      {
        const w = wallets[user] || {};
        const belegt = new Set([...(w.vouchers || []).map(v => v && v.id), ...(w.deleted || []).map(t => t && t.id)]);
        let umbenannt = false;
        for (const g of (gifts[user] || [])) {
          if (g && belegt.has(g.id)) { g.giftOrigId = g.giftOrigId || g.id; g.id = neueGutscheinId(); umbenannt = true; }
        }
        if (umbenannt) saveJson('gifts.json', gifts);
      }
      // Anzeigenamen aller, von denen hier ein Geschenk liegt ("Geschenk von …")
      const schenkerNamen = w => anzeigeNamen([...(w.vouchers || []), ...(gifts[user] || [])].map(v => v && v.giftFrom).filter(Boolean));
      if (url.searchParams.get('nur') === 'index') {
        const w = wallets[user] || { vouchers: [], cards: [], deleted: [] };
        return send(res, 200, { index: walletIndex(w), deleted: w.deleted || [], gifts: mitBildern(gifts[user]), ts: w.ts || 0, statistik: w.statistik || {}, namen: schenkerNamen(w) });
      }
      const w = wallets[user] || { vouchers: [], cards: [] };
      return send(res, 200, { ...w, vouchers: mitBildern(w.vouchers), cards: mitBildern(w.cards), gifts: mitBildern(gifts[user]), namen: schenkerNamen(w) });
    }
    // Gezielt einzelne Eintraege holen (nach einem Blick ins Inhaltsverzeichnis)
    if (p === '/api/wallet/items' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      const b = await readBody(req, 500_000);
      const ids = new Set(Array.isArray(b.ids) ? b.ids.map(String) : []);
      const w = wallets[user] || { vouchers: [], cards: [] };
      return send(res, 200, {
        vouchers: mitBildern((w.vouchers || []).filter(v => ids.has(v.id))),
        cards: mitBildern((w.cards || []).filter(c => ids.has(c.id))),
      });
    }

    // ---- Gutschein verschenken: wandert aus der eigenen Wallet zum Freund
    if (p === '/api/gift/send' && req.method === 'POST') {
      const me = authUser(req);
      if (!me) return send(res, 401, { error: 'Bitte anmelden.' });
      // Mit Gutschein samt Bild im Gepaeck: groesseres Limit
      const b = await readBody(req, 20_000_000);
      if (authUser(req) !== me) return send(res, 409, { error: 'Dein Konto hat sich gerade geändert.' });
      const to = String(b.to || '');
      if (!users[to]) return send(res, 404, { error: 'Nutzer nicht gefunden.' });
      if (to === me) return send(res, 400, { error: 'An dich selbst? Das hast du schon.' });
      // Nur an Freunde: verhindert Geschenk-Spam an Fremde
      if (!(profileOf(me).friends || []).includes(to)) return send(res, 403, { error: 'Verschenken geht nur an Freunde.' });
      // Tageslimit: 10 Geschenke pro Absender — Freitext ohne Limit wäre ein
      // Belästigungs- und Betrugsanbahnungs-Vektor
      const profMe = profileOf(me);
      const today = new Date().toISOString().slice(0, 10);
      if (!profMe.giftDay || profMe.giftDay.day !== today) profMe.giftDay = { day: today, count: 0 };
      if (profMe.giftDay.count >= 10) return send(res, 429, { error: 'Für heute reicht es: maximal 10 Geschenke pro Tag.' });
      const w = wallets[me] || (wallets[me] = { vouchers: [], cards: [], deleted: [] });
      w.vouchers = w.vouchers || [];
      const gid = String(b.id || '');
      // Das Geraet schickt seine aktuelle Fassung mit: sonst ginge eine noch
      // nicht gesicherte Aenderung (Abbuchung, neues Bild) beim Verschenken
      // verloren — und ein noch gar nicht gesicherter Gutschein waere "nicht gefunden"
      const vomGeraet = b.voucher && typeof b.voucher === 'object' && b.voucher.id === gid ? bilderAblegen(b.voucher) : null;
      // Volle Wallet beim Freund: lieber gleich sagen, als dass das Geschenk
      // unausgepackt liegen bleibt
      if (((wallets[to] && wallets[to].vouchers) || []).length + (gifts[to] || []).length >= WALLET_LIMIT_GUTSCHEINE) {
        return send(res, 409, { error: `Die Wallet von ${nameFuerAndere(to)} ist voll (${WALLET_LIMIT_GUTSCHEINE} Gutscheine).` });
      }
      const idx = w.vouchers.findIndex(v => v.id === gid);
      const tot = (w.deleted || []).some(t => t && t.id === gid);
      if (idx < 0 && (!vomGeraet || tot)) return send(res, 404, { error: 'Gutschein nicht gefunden. Kurz warten, bis die Wallet gesichert ist, und nochmal versuchen.' });
      // Erst pruefen, dann aus der Wallet nehmen: gewinnen kann beim Vereinigen
      // die Fassung vom Geraet (waehleFassung veraendert keine der beiden)
      const kontoV = idx >= 0 ? w.vouchers[idx] : null;
      const kandidat = kontoV && vomGeraet ? waehleFassung(vomGeraet, kontoV) : (kontoV || vomGeraet);
      // Rabattcode ist, was in einer der beiden Fassungen einer ist
      const rabatt = kontoV?.art === 'rabatt' || vomGeraet?.art === 'rabatt';
      if (rabatt) {
        const grund = rabattNichtVerschenkbar(kandidat);
        if (grund) return send(res, 400, { error: grund });
        // Hat der Freund genau diesen Code schon, ginge er hier nur verloren
        if (rabattSchonDa(to, kandidat)) return send(res, 409, { error: `${nameFuerAndere(to)} hat diesen Rabattcode schon.` });
      }
      let v;
      if (idx >= 0) [v] = w.vouchers.splice(idx, 1);
      v = kandidat || v;
      // Was bei jemand anderem landet: Bildfelder nur als Bild und nie die
      // private Notiz — egal, welche Fassung (Geraet oder Konto) gewonnen hat.
      // Ein Gutschein verliert alle Rabattcode-Felder; ein Rabattcode behaelt
      // sie, geprueft und gekuerzt wie beim Anlegen in der App.
      for (const f of ['img', 'codeImg']) if (v[f] && !bildFeldOk(v[f])) v[f] = '';
      delete v.notiz;
      if (rabatt) rabattFelderSaeubern(v);
      else { delete v.art; delete v.rabatt; delete v.rabattArt; delete v.mbw; delete v.eingeloest; }
      v.vendor = String(v.vendor || '').slice(0, 30);
      v.code = String(v.code || '').slice(0, 40);
      v.pin = String(v.pin || '').slice(0, 16);
      archiviere(me, [v], 'verschenkt an @' + to);
      w.deleted = [...(w.deleted || []), { id: v.id, ts: Date.now() }].slice(-LOESCHMARKER_MAX);
      // Optionale Nachricht: max 140 Zeichen, wird beim Rendern IMMER escaped
      const giftMsg = String(b.msg || '').trim().slice(0, 140);
      profMe.giftDay.count++;
      gifts[to] = gifts[to] || [];
      const geschenkId = neueGutscheinId();
      gifts[to].push({ ...v, id: geschenkId, giftOrigId: v.id, giftFrom: me, giftTs: Date.now(), giftMsg });
      // Das Originalfoto zieht mit um. Fehlt es (noch nicht hochgeladen), zeigt
      // der Betrachter beim Freund eben nur den Zuschnitt.
      if (v.orig) origUmziehen(me, v.id, to, geschenkId);
      // Erst das Geschenk sichern, dann die Absender-Wallet: stuerzt der Server
      // dazwischen ab, liegt der Gutschein eher doppelt als gar nicht
      saveJson('gifts.json', gifts);
      saveJson('wallets.json', wallets);
      saveJson('users.json', users); // Tageszähler
      ssePush('gift', to);
      pushToUser(to, {
        title: `Geschenk von ${nameFuerAndere(me)}!`,
        body: rabatt
          ? `Ein ${v.vendor}-Rabattcode${v.rabatt != null ? ` über ${String(v.rabatt).replace('.', ',')} ${v.rabattArt === 'pct' ? '%' : '€'}` : ''} wartet auf dich.`
          : `Ein ${v.vendor}-Gutschein${v.amount != null ? ` über ${String(v.amount).replace('.', ',')} €` : ''} wartet in deiner Wallet.`,
        url: '/?tab=wallet', tag: 'gift-' + me, kind: 'gift', from: me,
      });
      return send(res, 200, { ok: true });
    }
    // Empfänger bestätigt: Geschenke sind sicher in seiner Wallet angekommen
    if (p === '/api/gift/claim' && req.method === 'POST') {
      const me = authUser(req);
      if (!me) return send(res, 401, { error: 'Bitte anmelden.' });
      const b = await readBody(req);
      if (authUser(req) !== me) return send(res, 409, { error: 'Dein Konto hat sich gerade geändert.' });
      const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
      // Der Server bucht das Geschenk SELBST in die Wallet am Konto ein. Frueher
      // strich er es nur aus dem Vorrat und verliess sich darauf, dass das Handy
      // es speichert und hochlaedt — scheiterte das (voller Handyspeicher, App
      // zu), war der Gutschein weg.
      const w = wallets[me] || (wallets[me] = { vouchers: [], cards: [], deleted: [] });
      w.vouchers = w.vouchers || [];
      if (w.vouchers.length >= WALLET_LIMIT_GUTSCHEINE) {
        return send(res, 409, { error: `Deine Wallet ist voll (${WALLET_LIMIT_GUTSCHEINE} Gutscheine). Lösch aufgebrauchte Gutscheine, dann kannst du das Geschenk auspacken — es wartet so lange.` });
      }
      const tote = new Set((w.deleted || []).map(t => t && t.id));
      const claimed = [], eingebucht = [];
      for (const g of (gifts[me] || []).filter(x => ids.includes(x.id))) {
        claimed.push(g.id);
        // Die Notiz des Absenders bleibt draussen (auch bei Alt-Geschenken)
        const { notiz, ...ohneNotiz } = g;
        let v = { ...ohneNotiz, added: Date.now(), giftSeen: true };
        if (w.vouchers.some(x => x.id === v.id) || tote.has(v.id)) {
          const neu = neueGutscheinId();
          if (v.orig) origUmziehen(me, v.id, me, neu);
          v = { ...v, id: neu };
        }
        w.vouchers.unshift(v);
        eingebucht.push(v);
      }
      gifts[me] = (gifts[me] || []).filter(g => !claimed.includes(g.id));
      // Erst die Wallet, dann der Vorrat: stuerzt der Server dazwischen ab,
      // liegt das Geschenk eher doppelt als gar nicht
      if (eingebucht.length) saveJson('wallets.json', wallets);
      saveJson('gifts.json', gifts);
      return send(res, 200, { ok: true, claimed, vouchers: mitBildern(eingebucht) });
    }
    if (p === '/api/wallet' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      // Bilder (Barcode-Fotos als dataURL) brauchen ein größeres Body-Limit
      let b;
      try {
        // Grosszuegig: ein alter Client schickt die ganze Wallet mit allen
        // Bildern. Neue Clients schicken nur Geaendertes (delta).
        b = await readBody(req, 80_000_000);
      } catch (e) {
        return send(res, e.tooLarge ? 413 : 400, {
          error: e.tooLarge
            ? 'Die Wallet ist zu groß für einen Upload am Stück. Bitte die App neu laden — sie sichert dann in kleinen Teilen.'
            : 'Ungültige Daten.',
        });
      }
      // Mehrere Geräte: NIE blind überschreiben. Ein Handy mit älterem Stand
      // würde sonst die Neuzugänge des PCs verwerfen und Gelöschtes wiederbeleben.
      // Stattdessen: pro Eintrag vereinigen (vereinigeWallet), Löschungen über
      // Löschmarker. Ein Teil-Abgleich (delta) schickt nur Geaendertes — die
      // Vereinigung ist dieselbe, weil Fehlendes nie als geloescht gilt.
      if (authUser(req) !== user) return send(res, 409, { error: 'Dein Konto hat sich gerade geändert. Bitte die App neu laden.' });
      const incoming = {
        vouchers: Array.isArray(b.vouchers) ? b.vouchers.filter(x => x && x.id) : [],
        cards: Array.isArray(b.cards) ? b.cards.filter(x => x && x.id) : [],
        deleted: Array.isArray(b.deleted) ? b.deleted : [],
      };
      const { vouchers, cards, deleted, abgelehnt } = vereinigeWallet(user, incoming);
      // Der Client muss den Stand nur übernehmen, wenn der Server etwas beigesteuert hat
      const serverAddedSomething = vouchers.length !== incoming.vouchers.length
        || cards.length !== incoming.cards.length
        || vouchers.some((v, i) => v !== incoming.vouchers[i])
        || cards.some((c, i) => c !== incoming.cards[i]);
      // Erst schreiben, dann bestaetigen: die Datei ist ohne Bilder klein, und
      // ein Absturz direkt nach dem "ok" verliert so nichts mehr
      // Nicht geschrieben (z. B. Datentraeger voll): KEIN "ok" — das Geraet
      // haelt den Stand dann fuer ungesichert und versucht es wieder
      if (!saveJson('wallets.json', wallets)) return send(res, 507, { error: 'Speichern am Server gerade nicht möglich. Wird automatisch wiederholt.' });
      // Teil-Abgleich: statt der ganzen Wallet nur ein Inhaltsverzeichnis
      // zurueck — der Client holt sich gezielt, was ihm fehlt
      if (b.delta) return send(res, 200, { ok: true, delta: true, deleted, index: walletIndex(wallets[user]), statistik: wallets[user].statistik || {}, ...(abgelehnt.length ? { abgelehnt } : {}) });
      return send(res, 200, serverAddedSomething
        ? { ok: true, merged: true, vouchers: mitBildern(wallets[user].vouchers), cards: mitBildern(wallets[user].cards), deleted }
        : { ok: true, deleted });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const t = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      delete sessions[t];
      saveJson('sessions.json', sessions);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/me' && req.method === 'GET') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Nicht angemeldet.' });
      const u = users[user] || {};
      // Login-Serie: der angemeldete Start der App zaehlt den heutigen Tag
      if (zaehleLoginTag(profileOf(user))) saveJsonSoon('users.json', users);
      return send(res, 200, {
        user, role: roleOf(user),
        loginStreak: loginSerie(profileOf(user)),
        zweiFaktor: zweiFaktorAn(user),
        ersatzcodes: zweiFaktorAn(user) ? (u.totp.reserve || []).length : 0,
        hatEmail: !!u.email,
        emailOk: !!u.emailOk,
        emailMaske: emailMaske(u.email),
        mailBereit: mailBereit(),
        autoAufraeumen: profileOf(user).autoAufraeumen !== false,
        neuGesehen: profileOf(user).neuGesehen || '',
        // PIN des Kontos: das Geraet uebernimmt sie; pinStand > 0 heisst "es gab
        // schon eine" (ohne walletPin = im Konto entfernt)
        walletPin: pinFuerGeraet(u),
        pinStand: u.pinStand || 0,
      });
    }
    if (p === '/api/pin' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      if (!drossel('pin:' + user, 30, 3600e3)) return send(res, 429, { error: 'Zu viele Versuche. Bitte später nochmal.' });
      const b = await readBody(req);
      const u = users[user];
      const rec = pinRecordPruefen(b.record);
      if (!rec) return send(res, 400, { error: 'Ungültige PIN-Daten.' });
      const hatte = !!u.walletPin;
      if (hatte) {
        if (zuVieleFehler('pin-fehl:' + user, 10, 3600e3)) return send(res, 429, { error: 'Zu viele falsche Versuche. Bitte in einer Stunde nochmal.' });
        if (!await kontoPinStimmt(u.walletPin, b.alt)) {
          fehlerMerken('pin-fehl:' + user);
          return send(res, 403, { error: 'Die bisherige PIN stimmt nicht.' });
        }
      }
      u.walletPin = { ...rec, ts: Date.now() };
      u.pinStand = u.walletPin.ts;
      saveJson('users.json', users);
      ssePush('pin', user); // die anderen Geraete uebernehmen sie sofort
      if (hatte) sicherheitsMail(user, 'Wallet-PIN geändert', 'Die PIN deiner kumulio-Wallet wurde geändert. Sie gilt jetzt auf allen deinen Geräten.');
      return send(res, 200, { ok: true, walletPin: pinFuerGeraet(u), pinStand: u.pinStand });
    }
    if (p === '/api/pin/entfernen' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      const b = await readBody(req);
      const u = users[user];
      if (!u.walletPin) return send(res, 200, { ok: true, pinStand: u.pinStand || 0 });
      const perPasswort = typeof b.pass === 'string' && b.pass.length > 0;
      if (perPasswort && !drossel('pw-pruefen:' + user, 5, 15 * 60e3)) return send(res, 429, { error: 'Zu viele Versuche. Bitte in 15 Minuten nochmal.' });
      if (zuVieleFehler('pin-fehl:' + user, 10, 3600e3)) return send(res, 429, { error: 'Zu viele falsche Versuche. Bitte in einer Stunde nochmal.' });
      const ok = perPasswort ? hashPass(b.pass, u.salt) === u.hash : await kontoPinStimmt(u.walletPin, b.alt);
      if (!ok) {
        fehlerMerken('pin-fehl:' + user);
        return send(res, 403, { error: perPasswort ? 'Das Passwort stimmt nicht.' : 'Die PIN stimmt nicht.' });
      }
      delete u.walletPin;
      u.pinStand = Date.now();
      saveJson('users.json', users);
      ssePush('pin', user);
      sicherheitsMail(user, 'Wallet-PIN entfernt', 'Die PIN deiner kumulio-Wallet wurde entfernt, auf allen deinen Geräten. Warst du das nicht? Ändere dein Passwort und leg eine neue PIN fest.');
      return send(res, 200, { ok: true, pinStand: u.pinStand });
    }
    // Update-Log gesehen: nur bekannte Fassungen, damit hier nichts Beliebiges landet
    if (p === '/api/neuigkeiten/gesehen' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      const b = await readBody(req);
      const v = String(b.v || '');
      if (!NEU_VERSIONEN.includes(v)) return send(res, 400, { error: 'Unbekannte Fassung.' });
      const prof = profileOf(user);
      if (prof.neuGesehen !== v) { prof.neuGesehen = v; saveJson('users.json', users); }
      return send(res, 200, { ok: true, v });
    }

    // ---- Startseiten-Kacheln (Admin pflegt sie über /admin.html)
    // Laden-Erkennung (nur angemeldet, gedrosselt; Position kommt gerundet)
    if (p === '/api/laeden' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      if (!drossel('laeden:' + user, 40, 3600e3)) return send(res, 429, { error: 'Zu viele Anfragen.' });
      const b = await readBody(req);
      const lat = Math.round(Number(b.lat) * 1000) / 1000, lon = Math.round(Number(b.lon) * 1000) / 1000;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return send(res, 400, { error: 'Ungültige Position.' });
      }
      try { return send(res, 200, { laeden: await laedenUm(lat, lon) }); }
      catch { return send(res, 503, { error: 'Läden gerade nicht abrufbar.' }); }
    }
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
        return send(res, 502, { error: 'Seite nicht lesbar (' + (e.message || e) + '), Felder bitte selbst ausfüllen.' });
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
          parts.push(`Der günstigste Vergleichspreis liegt bei ${compare.price} (billiger.de), du sparst rund ${Math.round((1 - priceNum / compare.priceNum) * 100)} %.`);
        }
        parts.push('Automatisch erstellter Entwurf, bitte kurz prüfen und ergänzen.');
        draft = parts.join(' ');
      }
      return send(res, 200, { title, image, priceNum, merchant, compare, draft, loginForDraft: !authUser(req) && !isAdmin(req) });
    }

    // ---- Admin: Verwaltung (alles über X-Admin-Key)
    // ---- Wallet-Diagnose (Admin): was liegt fuer einen Nutzer wo? Fuer die
    // Suche nach verschwundenen Gutscheinen — Wallet, Loeschmarker, wartende
    // Geschenke, Originalfotos (auch solche ohne Gutschein dazu).
    if (p === '/api/admin/wallet-diag' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      // ?find=ID: wo taucht diese Gutschein-ID ueberhaupt noch auf?
      const such = String(url.searchParams.get('find') || '');
      if (such) {
        const orte = [];
        for (const [n, ww] of Object.entries(wallets)) {
          for (const v of [...(ww.vouchers || []), ...(ww.cards || [])]) if (v && v.id === such) orte.push({ wo: 'wallet', user: n, v: { ...v, codeImg: (v.codeImg || '').length, img: (v.img || '').length } });
          for (const t of (ww.deleted || [])) if (t && t.id === such) orte.push({ wo: 'loeschmarker', user: n, ts: t.ts });
        }
        for (const [n, gl] of Object.entries(gifts)) for (const g of (gl || [])) if (g && g.id === such) orte.push({ wo: 'geschenk', user: n, v: { ...g, codeImg: (g.codeImg || '').length, img: (g.img || '').length } });
        for (const n of Object.keys(users)) if (fs.existsSync(origPfad(n, such))) orte.push({ wo: 'originalfoto', user: n });
        return send(res, 200, { such, orte });
      }
      const q = String(url.searchParams.get('user') || '').toLowerCase();
      const treffer = Object.keys(users).filter(n => n.toLowerCase().includes(q));
      if (!q || treffer.length !== 1) return send(res, 200, { treffer });
      const user = treffer[0];
      const w = wallets[user] || { vouchers: [], cards: [], deleted: [] };
      const groesse = x => Buffer.byteLength(JSON.stringify(x || ''));
      const kurz = v => ({
        id: v.id, vendor: v.vendor, amount: v.amount, balance: v.balance,
        added: v.added, mt: v.mt, giftFrom: v.giftFrom, giftTs: v.giftTs, orig: v.orig,
        code: !!v.code, pin: !!v.pin, codeImg: (v.codeImg || '').length, img: (v.img || '').length, bytes: groesse(v),
      });
      let origDateien = [];
      try {
        const lebt = new Set((w.vouchers || []).map(v => v.id));
        origDateien = (await fs.promises.readdir(origOrdner(user))).map(f => {
          const st = fs.statSync(path.join(origOrdner(user), f));
          return { id: f.replace(/\.jpg$/, ''), bytes: st.size, mtime: st.mtimeMs, imWallet: lebt.has(f.replace(/\.jpg$/, '')) };
        });
      } catch { /* kein Ordner */ }
      // Wer hat diesem Nutzer etwas geschenkt / von ihm bekommen? (Loeschmarker
      // beim Absender + giftFrom beim Empfaenger)
      const geschenkSpuren = [];
      for (const [name, ww] of Object.entries(wallets)) {
        for (const v of (ww.vouchers || [])) if (v.giftFrom === user) geschenkSpuren.push({ bei: name, ...kurz(v) });
      }
      return send(res, 200, {
        user, walletBytes: groesse(w), ts: w.ts,
        vouchers: (w.vouchers || []).map(kurz), cards: (w.cards || []).map(kurz),
        deleted: (w.deleted || []).slice(-80),
        giftsPending: (gifts[user] || []).map(kurz),
        origDateien, geschenkSpuren, giftDay: profileOf(user).giftDay || null,
      });
    }
    // Papierkorb eines Nutzers (Admin): was ist wann warum verschwunden?
    if (p === '/api/admin/archiv' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      const user = String(url.searchParams.get('user') || '');
      if (!users[user]) return send(res, 404, { error: 'Nutzer nicht gefunden.' });
      const liste = Object.entries(archivVon(user)).sort((x, y) => y[1].ts - x[1].ts).map(([key, e]) => ({
        key, ts: e.ts, grund: e.grund, typ: e.typ, id: e.v.id, vendor: e.v.vendor || e.v.name,
        amount: e.v.amount, balance: e.v.balance, code: !!e.v.code, pin: !!e.v.pin, bild: !!(e.v.codeImg || e.v.img),
      }));
      return send(res, 200, { user, liste });
    }
    // Wiederherstellen: als neuer Eintrag (frische ID), damit kein alter
    // Loeschmarker ihn gleich wieder erwischt. Das Handy holt ihn sofort.
    if (p === '/api/admin/archiv-restore' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      const b = await readBody(req);
      const user = String(b.user || '');
      const e = users[user] && archivVon(user)[String(b.key || '')];
      if (!e) return send(res, 404, { error: 'Eintrag nicht gefunden.' });
      const w = wallets[user] || (wallets[user] = { vouchers: [], cards: [], deleted: [] });
      const zurueck = bilderAblegen({ ...e.v, id: neueGutscheinId(), added: Date.now(), mt: Date.now(), wiederhergestellt: Date.now() });
      // Originalfoto mitnehmen, falls es noch da ist
      if (e.v.orig) {
        try { fs.renameSync(origPfad(user, e.v.id), origPfad(user, zurueck.id)); } catch { delete zurueck.orig; }
      }
      if (e.typ === 'karte') (w.cards = w.cards || []).unshift(zurueck);
      else (w.vouchers = w.vouchers || []).unshift(zurueck);
      saveJson('wallets.json', wallets);
      ssePush('gift', user); // Handy holt den Stand sofort
      return send(res, 200, { ok: true, id: zurueck.id });
    }
    // Originalfoto eines beliebigen Nutzers abholen (Admin) — zur Rettung
    if (p === '/api/admin/wallet-orig' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      const user = String(url.searchParams.get('user') || '');
      const id = String(url.searchParams.get('id') || '');
      if (!users[user] || !ORIG_ID.test(id)) return send(res, 400, { error: 'user/id ungültig.' });
      try { const buf = await fs.promises.readFile(origPfad(user, id)); return send(res, 200, buf, bildTyp(buf) || 'image/jpeg'); }
      catch { return send(res, 404, { error: 'Keine Datei.' }); }
    }

    if (p === '/api/admin/users' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      return send(res, 200, Object.entries(users).map(([name, u]) => ({
        user: name, email: u.email || '', newsletter: !!u.newsletter, ts: u.ts,
        anzeigename: anzeigenameVon(name), lastRename: (u.profile && u.profile.lastRename) || 0,
      })));
    }
    // Support: @Name eines Kontos aendern (der Nutzer hat darum gebeten)
    if (p === '/api/admin/rename' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      const b = await readBody(req);
      const von = String(b.from || ''), zu = String(b.to || '').trim();
      const fehler = kontoUmbenennen(von, zu);
      if (fehler) return send(res, fehler === 'Nutzer nicht gefunden.' ? 404 : /vergeben|trägt schon/.test(fehler) ? 409 : 400, { error: fehler });
      return send(res, 200, { ok: true, user: zu });
    }

    if (p === '/api/admin/newsletter.csv' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      const rows = Object.entries(users).filter(([, u]) => u.newsletter && u.email)
        .map(([name, u]) => `${csvZelle(name)};${csvZelle(u.email)}`);
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
      if (!isAdmin(req) && roleOf(authUser(req)) !== 'admin') return send(res, 403, { error: 'Admin-Key falsch.' });
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

    // Support: 2FA fuer ein Konto ausschalten (Handy weg, keine Ersatzcodes)
    if (p === '/api/admin/2fa-aus' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      const b = await readBody(req);
      const u = users[String(b.user || '')];
      if (!u) return send(res, 404, { error: 'Nutzer nicht gefunden.' });
      delete u.totp; delete u.totpNeu;
      ticketsWeg(String(b.user));
      saveJson('users.json', users);
      sicherheitsMail(String(b.user), 'Zwei-Faktor ausgeschaltet', 'Das kumulio-Team hat auf deine Bitte die Anmeldung mit zweitem Faktor ausgeschaltet.');
      return send(res, 200, { ok: true });
    }
    // Support: Passwort-Link fuer ein Konto erzeugen (z. B. ohne bestaetigte
    // E-Mail) — der Admin gibt ihn nach Pruefung der Person weiter
    if (p === '/api/admin/reset-link' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      const b = await readBody(req);
      const user = String(b.user || '');
      if (!users[user]) return send(res, 404, { error: 'Nutzer nicht gefunden.' });
      const token = crypto.randomBytes(24).toString('base64url');
      resets[sha256(token)] = { user, zweck: 'passwort', exp: Date.now() + 3600e3, ts: Date.now(), vomAdmin: true };
      saveJson('resets.json', resets);
      return send(res, 200, { link: `${mailEinstellungen().basis}/?reset=${token}`, gilt: '60 Minuten' });
    }

    // E-Mail-Versand (Resend) einrichten: Schluessel, Absender, Link-Basis
    if (p === '/api/admin/mail' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      const m = mailEinstellungen();
      return send(res, 200, { bereit: mailBereit(), from: m.from, basis: m.basis, key: m.resendKey ? '…' + m.resendKey.slice(-4) : '' });
    }
    if (p === '/api/admin/mail' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      const b = await readBody(req);
      const alt = MAIL || {};
      MAIL = {
        resendKey: String(b.resendKey || '').trim() || alt.resendKey || '',
        from: String(b.from || '').trim() || alt.from || '',
        basis: String(b.basis || '').trim() || alt.basis || '',
      };
      saveJson('mail.json', MAIL);
      return send(res, 200, { ok: true, bereit: mailBereit() });
    }
    if (p === '/api/admin/mail-test' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Key falsch.' });
      const b = await readBody(req);
      const to = String(b.to || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return send(res, 400, { error: 'Bitte eine gültige Adresse.' });
      try {
        await sendeMail({ to, subject: 'kumulio: Test-Mail', text: 'Der E-Mail-Versand von kumulio funktioniert.',
          html: mailHtml('Test-Mail', ['Der E-Mail-Versand von kumulio funktioniert.']) });
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 502, { error: e.message }); }
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
      const rater = authUser(req);
      r.by = r.by || {};
      // Angemeldet zaehlt die Konto-Historie, nicht der Client: eine zweite
      // Bewertung ERSETZT die erste statt den Schnitt doppelt zu fuellen
      const prevEff = rater ? (r.by[rater] || null) : prev;
      if (rater) r.by[rater] = stars;
      if (prevEff && r.count > 0) { r.sum -= prevEff; r.count -= 1; }
      r.sum += stars; r.count += 1;
      saveJson('ratings.json', ratings);
      return send(res, 200, { rating: r.sum / r.count, ratingCount: r.count });
    }

    // Welche Sparkarten haben gepflegte Coupons? (nur Übersicht, ohne Inhalte)
    if (p === '/api/cardcoupons/list' && req.method === 'GET') {
      const user = authUser(req);
      const alle = { ...cardCoupons, netto: nettoCoupons() };
      const list = Object.entries(alle).map(([key, v]) => ({
        key, brand: v.brand || key, validUntil: v.validUntil || '',
        count: (v.groups || []).reduce((s, g) => s + (g.items || []).length, 0),
        open: !!v.open,
        owned: !!v.open || (user ? hasCard(user, key) : false),
      }));
      return send(res, 200, { list });
    }
    // Was gibt es gerade bei McCheap? Nur Ausreisser (gratis / unter 1,50 €)
    if (p === '/api/mccheap' && req.method === 'GET') {
      scanMccheap();
      return send(res, 200, { ok: mccheap.ok, checked: mccheap.checked, items: mccheap.items });
    }
    // Burger-King-Coupons zum Ausdrucken (PDF von einfach-sparsam.de): was
    // liegt vor, bis wann gilt es? Holt nur nach, wenn es faellig ist.
    if (p === '/api/bk-coupons' && req.method === 'GET') {
      bkPruefen();
      return send(res, 200, bkOeffentlich());
    }
    // Die Datei selbst und die Vorschau ihrer Seiten. Offen fuer alle (die
    // Quelle ist oeffentlich) und ohne Anmeldung, weil ein neuer Tab kein
    // Token mitschickt.
    if ((p === '/bk-coupons.pdf' || /^\/bk-coupons\/seite-[1-9]$/.test(p)) && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!bkDa()) return send(res, 404, { error: 'Gerade liegt keine Burger-King-PDF vor.' });
      let datei = BK_PDF, typ = 'application/pdf';
      if (p !== '/bk-coupons.pdf') {
        const s = (bkMeta.seiten || []).find(x => x.n === Number(p.slice(-1)));
        if (!s) return send(res, 404, { error: 'Keine Vorschau für diese Seite.' });
        datei = s.datei; typ = s.typ;
      }
      let st;
      try { st = await fs.promises.stat(bkDatei(datei)); } catch { return send(res, 404, { error: 'Nicht gefunden' }); }
      const etag = `"${bkMeta.hash || st.size}-${datei === BK_PDF ? 'pdf' : p.slice(-1)}"`;
      const kopf = {
        'Content-Type': typ, 'ETag': etag, 'Cache-Control': 'public, max-age=600',
        'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff',
        ...(datei === BK_PDF ? { 'Content-Disposition': 'inline; filename="burger-king-coupons.pdf"' } : {}),
      };
      if (String(req.headers['if-none-match'] || '') === etag) { res.writeHead(304, kopf); return res.end(); }
      res.writeHead(200, { ...kopf, 'Content-Length': st.size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(bkDatei(datei)).on('error', () => res.destroy()).pipe(res);
      return;
    }
    // Die Coupons selbst: nur mit passender Sparkarte in der Wallet
    if (p === '/api/cardcoupons' && req.method === 'GET') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      const key = String(url.searchParams.get('card') || '').trim().toLowerCase();
      const data = couponSatz(key);
      if (!data) return send(res, 404, { error: 'Für diese Karte gibt es noch keine Coupons.' });
      if (!data.open && !hasCard(user, key) && roleOf(user) !== 'admin') {
        return send(res, 403, { error: 'Füge die Sparkarte zu deiner Wallet hinzu, dann erscheinen die Coupons hier.' });
      }
      return send(res, 200, { key, ...data });
    }
    // Redaktion pflegt die Coupons (Rolle admin ODER Admin-Key)
    if (p === '/api/admin/cardcoupons' && req.method === 'POST') {
      const me = authUser(req);
      if (roleOf(me) !== 'admin' && !isAdmin(req)) return send(res, 403, { error: 'Nur für Admins.' });
      const b = await readBody(req, 400_000);
      const key = String(b.card || '').trim().toLowerCase();
      if (!key) return send(res, 400, { error: 'Karte fehlt.' });
      if (key === 'netto') return send(res, 400, { error: 'Netto wird automatisch aus der Kalenderwoche berechnet.' });
      if (b.remove) {
        delete cardCoupons[key];
        saveJson('cardcoupons.json', cardCoupons);
        return send(res, 200, { ok: true, removed: key });
      }
      const groups = (Array.isArray(b.groups) ? b.groups : []).slice(0, 20).map(g => ({
        title: String(g.title || '').slice(0, 60),
        items: (Array.isArray(g.items) ? g.items : []).slice(0, 100).map(it => ({
          code: String(it.code || '').slice(0, 12),
          name: String(it.name || '').slice(0, 120),
          extra: String(it.extra || '').slice(0, 160),
          price: String(it.price || '').slice(0, 24),
          plu: String(it.plu || '').slice(0, 12),
          barcode: String(it.barcode || '').slice(0, 160),
          ean: !!it.ean,
        })).filter(it => it.name),
      })).filter(g => g.items.length);
      if (!groups.length) return send(res, 400, { error: 'Keine gültigen Coupons dabei.' });
      const alt = cardCoupons[key] || {};
      cardCoupons[key] = {
        brand: String(b.brand || key).slice(0, 40),
        validUntil: String(b.validUntil || '').slice(0, 10),
        note: String(b.note || '').slice(0, 300),
        open: b.open != null ? !!b.open : !!alt.open,
        img: String(b.img != null ? b.img : (alt.img || '')).slice(0, 120),
        updated: Date.now(),
        groups,
      };
      saveJson('cardcoupons.json', cardCoupons);
      return send(res, 200, { ok: true, key, count: groups.reduce((s, g) => s + g.items.length, 0) });
    }
    if (p === '/api/comments' && req.method === 'GET') {
      const dealId = url.searchParams.get('dealId') || '';
      // Jeder Kommentar traegt den AKTUELLEN Look seines Autors (Avatar und
      // Namensfarbe): Aenderungen wirken rueckwirkend. Alte Abzeichen am
      // Kommentar gehen nicht mehr mit raus.
      // Alt-Platzhalter ohne lebende Antworten fliegen gleich mit raus
      const all = comments[dealId] || [];
      const list = all.filter(c => !c.deleted || all.some(x => x.parent === c.id && !x.deleted)).map(c => {
        const { badge, ...rest } = c;
        if (c.deleted || !users[c.user]) return rest;
        return { ...rest, avatar: profileOf(c.user).avatar || '', paint: namensfarbe(c.user), ...mitAnzeigename(c.user) };
      });
      return send(res, 200, list);
    }

    if (p === '/api/comments' && req.method === 'POST') {
      // Kommentare nur noch mit Profil, der Name kommt vom Konto
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Zum Kommentieren bitte anmelden.' });
      const b = await readBody(req);
      const dealId = String(b.dealId || '');
      const text = String(b.text || '').trim().slice(0, 600);
      if (!dealId || text.length < 2) return send(res, 400, { error: 'Kommentar zu kurz.' });
      const mod = moderate(text);
      if (mod.blocked) return send(res, 400, { error: mod.reason });
      const c = {
        id: crypto.randomBytes(5).toString('hex'), user, text: censor(text), ts: Date.now(), flags: mod.flags,
        role: roleOf(user),
        parent: String(b.parent || '') || null, // Antwort auf einen anderen Kommentar
        reactions: {}, // { art: [nutzer] }, Arten: like, helpful oder Emote-Namen
      };
      (comments[dealId] = comments[dealId] || []).push(c);
      saveJson('comments.json', comments);
      return send(res, 201, { ...c, avatar: profileOf(user).avatar || '', paint: namensfarbe(user), ...mitAnzeigename(user) });
    }

    // Kommentar-Reaktionen: like, helpful oder ein Emote-Name (Toggle)
    if (p === '/api/comments/react' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      const b = await readBody(req);
      const list = comments[String(b.dealId || '')] || [];
      const c = list.find(x => x.id === String(b.id || ''));
      if (!c) return send(res, 404, { error: 'Kommentar nicht gefunden.' });
      const kindR = String(b.kind || '');
      c.reactions = c.reactions || {};
      // Eine alte Reaktion mit einem Emote, das es nicht mehr gibt, darf man
      // noch zuruecknehmen, aber nicht neu setzen. Object.hasOwn statt
      // Nachschlagen: sonst gaelten auch "constructor" & Co. als Emote.
      const hatSchon = Object.hasOwn(c.reactions, kindR) && Array.isArray(c.reactions[kindR]) && c.reactions[kindR].includes(user);
      if (kindR !== 'like' && kindR !== 'helpful' && !Object.hasOwn(EMOTE_IDS, kindR) && !hatSchon)
        return send(res, 400, { error: 'Unbekannte Reaktion.' });
      const arr = c.reactions[kindR] = c.reactions[kindR] || [];
      const i = arr.indexOf(user);
      if (i >= 0) arr.splice(i, 1); else arr.push(user);
      if (!arr.length) delete c.reactions[kindR];
      saveJson('comments.json', comments);
      return send(res, 200, { ok: true, reactions: c.reactions });
    }

    // Kommentar löschen: eigener oder als Mod
    if (p === '/api/comments/delete' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return send(res, 401, { error: 'Bitte anmelden.' });
      const b = await readBody(req);
      const dealId = String(b.dealId || '');
      const list = comments[dealId] || []; // Rohliste: delete darf auch Platzhalter-Eltern sehen
      const c = list.find(x => x.id === String(b.id || ''));
      if (!c) return send(res, 404, { error: 'Kommentar nicht gefunden.' });
      if (c.user !== user && !isModUser(user)) return send(res, 403, { error: 'Nur eigene Kommentare.' });
      // Ohne Antworten verschwindet der Kommentar komplett; nur wenn Antworten
      // dranhaengen, bleibt ein Platzhalter (sonst haengen die Antworten in der Luft)
      const hasReplies = list.some(x => x.parent === c.id && !x.deleted);
      if (hasReplies) { c.deleted = true; c.text = ''; c.reactions = {}; }
      else comments[dealId] = list.filter(x => x.id !== c.id);
      saveJson('comments.json', comments);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/posts' && req.method === 'POST') {
      // Deals postet die Redaktion: per Admin-Key ODER direkt in der App mit Admin-Rolle
      if (!isAdmin(req) && roleOf(authUser(req)) !== 'admin')
        return send(res, 403, { error: 'Deals postet aktuell die Redaktion. Du kannst kommentieren und mit Sternen bewerten.' });
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
        kind: String(b.kind || 'rabatt').slice(0, 20),
        priceNum, compareNum, endTs, compareChecked: !!b.compareChecked, newCustomer,
        merchant: String(b.merchant || '').trim().slice(0, 30),
        image: /^https?:\/\//.test(b.image || '') ? String(b.image).slice(0, 400) : '',
      };
      (posts[ch.slug] = posts[ch.slug] || []).unshift(post);
      saveJson('posts.json', posts);
      // Preisfehler-Alarm: alle Push-Abos benachrichtigen (bewusst nur dieser Kanal –
      // Preisfehler sind zeitkritisch, alles andere wäre Spam)
      if (ch.slug === 'preisfehler') {
        pushToAll({ title: 'Preisfehler entdeckt!', body: title, url: '/?tab=feed' }).catch(() => { });
      }
      return send(res, 201, post);
    }

    // ---- Deal bearbeiten (Admin-Key oder Admin-Rolle in der App)
    if (p === '/api/admin/edit-post' && req.method === 'POST') {
      if (!isAdmin(req) && roleOf(authUser(req)) !== 'admin') return send(res, 403, { error: 'Nur für die Redaktion.' });
      const b = await readBody(req);
      const id = String(b.id || '');
      let found = null, fromCh = null;
      for (const ch of Object.keys(posts)) {
        const x = posts[ch].find(pp => pp.id === id);
        if (x) { found = x; fromCh = ch; break; }
      }
      if (!found) return send(res, 404, { error: 'Deal nicht gefunden.' });
      const num2 = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? null : Math.round(n * 100) / 100; };
      if (typeof b.title === 'string' && b.title.trim().length >= 4) found.title = b.title.trim().slice(0, 90);
      if (typeof b.text === 'string') found.text = b.text.trim().slice(0, 1200);
      found.priceNum = num2(b.price);
      found.compareNum = num2(b.comparePrice);
      found.endTs = b.endDate ? (Date.parse(String(b.endDate) + 'T23:59:59') || null) : null;
      found.newCustomer = !!b.newCustomer;
      if (typeof b.kind === 'string') found.kind = b.kind.slice(0, 20);
      if (/^https?:\/\//.test(b.image || '')) found.image = String(b.image).slice(0, 400);
      const target = String(b.channel || fromCh);
      if (target !== fromCh && findChannel(target) && findChannel(target).type === 'community') {
        posts[fromCh] = posts[fromCh].filter(pp => pp.id !== id);
        (posts[target] = posts[target] || []).unshift(found);
      }
      saveJson('posts.json', posts);
      return send(res, 200, { ok: true });
    }

    // ---- Beschreibung generieren (aus Titel, Preisen und Typ, ohne Link)
    if (p === '/api/generate-desc' && req.method === 'POST') {
      if (!authUser(req) && !isAdmin(req)) return send(res, 401, { error: 'Bitte anmelden.' });
      const b = await readBody(req);
      const title = String(b.title || '').trim().slice(0, 90);
      if (title.length < 4) return send(res, 400, { error: 'Bitte zuerst einen Titel eingeben.' });
      const num2 = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? null : n; };
      const price = num2(b.price), comp = num2(b.comparePrice);
      const merchant = String(b.merchant || '').trim().slice(0, 30);
      const parts = [];
      if (String(b.kind) === 'gutschein') {
        parts.push(`${title}${merchant ? ` bei ${merchant}` : ''}: Code beim Bezahlen eingeben und direkt sparen.`);
        parts.push('Die Aktion gilt, solange der Anbieter sie anbietet. Details stehen auf der Aktionsseite.');
      } else {
        parts.push(`${title} gibt es gerade${price != null ? ` für ${price.toFixed(2).replace('.', ',')} €` : ' zum Aktionspreis'}${merchant ? ` bei ${merchant}` : ''}.`);
        if (price != null && comp != null && comp > price) {
          parts.push(`Regulär kostet das ${comp.toFixed(2).replace('.', ',')} €, du sparst also rund ${Math.round((1 - price / comp) * 100)} %.`);
        }
        parts.push('Schnell zugreifen lohnt sich, solche Preise halten selten lange.');
      }
      return send(res, 200, { draft: parts.join(' ') });
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

// Beim Herunterfahren (Deploy/Neustart) ausstehende gebündelte Writes sichern
function flushPendingSaves() {
  // Alles Aufgeschobene jetzt synchron schreiben (Deploy/Neustart)
  for (const [name, e] of Object.entries(speicherQueue)) {
    clearTimeout(e.timer);
    if (e.obj) { try { schreibeAtomarSync(name, e.obj); } catch (err) { console.error('Flush fehlgeschlagen:', name, err.message); } e.obj = null; }
  }
  for (const [name, obj] of [['chat.json', chat], ['users.json', users], ['wallets.json', wallets], ['dms.json', dms], ['gifts.json', gifts]]) {
    try { schreibeAtomarSync(name, obj); } catch (err) { console.error('Flush fehlgeschlagen:', name, err.message); }
  }
  archivFlush();
}
process.on('SIGTERM', () => { flushPendingSaves(); process.exit(0); });
process.on('SIGINT', () => { flushPendingSaves(); process.exit(0); });

// RA_TEST: für scripts/test-*.js, damit die Tests importieren können ohne den Server zu starten
if (process.env.RA_TEST) {
  module.exports = {
  profileOf, users, STICKERS, GAMI_WEG, zaehleLoginTag, loginSerie, berlinTag, namensfarbe, eingeladenZahl, eigenesProfil,
    // Endpunkte im Test ansprechen: server.listen(0) im Testskript
    server, geworbenEntfernen, einladungenAufraeumen,
    // fuer scripts/test-wallet.js
    bilderAufraeumen, bildDateien, bildAblegen, vereinigeWallet, archiviere, archivFlush, wallets, gifts, walletIndex, waehleFassung,
    totpCode, totpPruefen, base32, base32Lesen, ersatzcodeEinloesen, neueErsatzcodes, aufgebrauchtWeg, raeumeAufgebrauchteAuf, drossel,
    zuVieleFehler, fehlerMerken, statistikMerken, AUFRAEUMEN_AB,
    // Burger-King-PDF (scripts/test-wallet.js)
    bkSeiteLesen, bkDatumLesen, pdfSeitenBilder, bkPruefen, bkOeffentlich };
} else {
  server.listen(PORT, () => {
    console.log(`kumulio läuft auf http://localhost:${PORT}`);
    console.log(`Admin-Panel: http://localhost:${PORT}/admin.html  (Key: ${ADMIN_KEY}, liegt in data/admin-key.txt)`);
  });
}
