// Tests fuer Lio (Waehrung) und den Gutschein-Shop: Tages-Lio einmal am Tag,
// Wochen-/Monats-Bonus bei Serie 7/30 zum Abholen (einmal), Einladungen nur
// mit bestaetigter Adresse und 3 Login-Tagen (einmal, auch nach Loeschen und
// neu Registrieren nicht nochmal), Shop ausverkauft, Kauf mit Lio, kein Code
// im Katalog, Echtgeld 501.
// Leerer Datenordner:  node scripts/test-lio.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kumulio-lio-'));
process.env.RA_DATA_DIR = DIR;
process.env.RA_TEST = '1';
delete process.env.RESEND_API_KEY;
const HASH = require('crypto').scryptSync('geheim123', 'salz', 32).toString('hex');
const konto = (name, ts, extra = {}, profil = {}) => [name, { hash: HASH, salt: 'salz', email: name + '@example.invalid', ts, ...extra, profile: { bio: '', publicProfile: true, ...profil } }];
fs.writeFileSync(path.join(DIR, 'users.json'), JSON.stringify(Object.fromEntries([
  konto('anna', 1000),
  // vorgemerkte Einladungen von vor dem Lio-Start
  konto('wera', 1000, {}, { refCount: 3, geworben: [{ user: 'gina', ts: 5000 }, { user: 'hans', ts: 6000 }] }),
  konto('gina', 5000, { emailOk: 1 }, { invitedBy: 'wera', loginStreak: { tage: 1, rekord: 4, letzterTag: '2026-09-01' } }), // erfuellt schon alles
  konto('hans', 6000, {}, { invitedBy: 'wera', loginStreak: { tage: 5, rekord: 5, letzterTag: '2026-09-01' } }),               // Adresse fehlt
  konto('kai', 2000, { emailOk: 1 }, { invitedBy: 'wera', loginStreak: { tage: 9, rekord: 9, letzterTag: '2026-09-01' } }),    // Alt-Einladung ohne Eintrag
  konto('olga', 1000, { emailOk: 1 }),
])));
fs.writeFileSync(path.join(DIR, 'sessions.json'), JSON.stringify({ tokAnna: 'anna', tokWera: 'wera', tokHans: 'hans', tokOlga: 'olga' }));
fs.writeFileSync(path.join(DIR, 'admin-key.txt'), 'adminkey');
const S = require('../server.js');

let fehler = 0;
const pruefe = (name, ok) => { console.log((ok ? 'OK   ' : 'FEHL ') + name); if (!ok) fehler++; };
const P = n => S.users[n].profile;
const tag = (m, d) => Date.UTC(2026, m - 1, d, 10); // Mittag Berlin

// --- Start: vorgemerkte Einladung, die schon alles erfuellt, ist gutgeschrieben
pruefe('Start: gina (Adresse ok, Rekord 4) bringt wera 10 Lios', S.lioStand(P('wera')) === 10 && P('wera').geworben[0].lio > 0);
pruefe('Start: hans (Adresse fehlt) bringt nichts', !P('wera').geworben[1].lio);
pruefe('Start: Alt-Einladung kai (nur refCount) bringt nichts', S.lioStand(P('wera')) === 10);
pruefe('Start: Stern fuer wera vorgemerkt', (P('wera').lioNeu || []).length === 1 && P('wera').lioNeu[0].menge === 10);

// --- Tages-Lio und Serie
pruefe('erster Login-Tag: +1', S.loginTagZaehlen('anna', tag(10, 1)) && S.lioStand(P('anna')) === 1);
pruefe('am selben Tag nichts mehr', !S.loginTagZaehlen('anna', tag(10, 1) + 3600e3) && S.lioStand(P('anna')) === 1);
for (let d = 2; d <= 6; d++) S.loginTagZaehlen('anna', tag(10, d));
pruefe('6 Tage: 6 Lios, noch kein Bonus', S.lioStand(P('anna')) === 6 && !(P('anna').lioBoni || []).length);
pruefe('Serie: noch 1 Tag bis zur Woche', S.lioSerie(P('anna'), tag(10, 6)).bisWoche === 1);
S.loginTagZaehlen('anna', tag(10, 7));
pruefe('Tag 7: Wochen-Bonus offen, nicht gutgeschrieben', S.lioStand(P('anna')) === 7 && P('anna').lioBoni.length === 1 && P('anna').lioBoni[0].art === 'woche' && P('anna').lioBoni[0].menge === 3);
pruefe('Serie: an Tag 7 wieder 7 bis zur naechsten Woche', S.lioSerie(P('anna'), tag(10, 7)).bisWoche === 7);
const bid = P('anna').lioBoni[0].id;
pruefe('abholen: +3', S.lioBonusAbholen('anna', bid) && S.lioStand(P('anna')) === 10);
pruefe('zweimal abholen geht nicht', !S.lioBonusAbholen('anna', bid) && S.lioStand(P('anna')) === 10);
for (let d = 8; d <= 30; d++) S.loginTagZaehlen('anna', tag(10, d));
const boni = P('anna').lioBoni.map(b => b.art + b.tag).join(',');
pruefe('bis Tag 30: Wochen 14/21/28 und Monat 30 offen', boni === 'woche14,woche21,woche28,monat30');
pruefe('bis Tag 30: 30 Tages-Lios + 3 abgeholt', S.lioStand(P('anna')) === 33);
pruefe('Login-Tage gezaehlt', S.loginTageZahl(P('anna')) === 30);
// Luecke: Serie beginnt neu, offene Boni bleiben abholbar
S.loginTagZaehlen('anna', tag(11, 5));
pruefe('nach einer Luecke: Serie 1, Boni bleiben', P('anna').loginStreak.tage === 1 && P('anna').lioBoni.length === 4);

// --- Einladungen: erst bestaetigte Adresse UND 3 Login-Tage, dann einmal +10
S.users.neo = { hash: HASH, salt: 'salz', email: 'neo@example.invalid', ts: 9000, profile: { invitedBy: 'olga' } };
P('olga').geworben = [{ user: 'neo', ts: 9000 }]; P('olga').refCount = 1;
S.loginTagZaehlen('neo', tag(10, 1)); S.loginTagZaehlen('neo', tag(10, 3)); S.loginTagZaehlen('neo', tag(10, 5));
pruefe('3 Tage, Adresse unbestaetigt: nichts', S.lioStand(P('olga')) === 0);
S.users.neo.emailOk = 1;
pruefe('Adresse bestaetigt: +10', S.lioWerbungPruefen('neo') && S.lioStand(P('olga')) === 10);
pruefe('nochmal pruefen: nichts', !S.lioWerbungPruefen('neo') && S.lioStand(P('olga')) === 10);
S.loginTagZaehlen('neo', tag(10, 6));
pruefe('weiterer Login-Tag: nichts', S.lioStand(P('olga')) === 10);
S.users.max = { hash: HASH, salt: 'salz', email: 'max@example.invalid', ts: 9100, emailOk: 1, profile: { invitedBy: 'olga' } };
P('olga').geworben.push({ user: 'max', ts: 9100 });
S.loginTagZaehlen('max', tag(10, 1)); S.loginTagZaehlen('max', tag(10, 2));
pruefe('bestaetigt, erst 2 Tage: nichts', S.lioStand(P('olga')) === 10);
S.loginTagZaehlen('max', tag(10, 9));
pruefe('dritter Tag (nicht in Folge): +10', S.lioStand(P('olga')) === 20 && P('olga').lioFreunde === 2);

(async () => {
  await new Promise(ok => S.server.listen(0, '127.0.0.1', ok));
  const basis = `http://127.0.0.1:${S.server.address().port}`;
  const api = async (tok, p, body, extra = {}) => {
    const a = await fetch(basis + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    return { status: a.status, j: await a.json().catch(() => null) };
  };
  const admin = (p, body) => api(null, p, body, { 'X-Admin-Key': 'adminkey' });

  // --- Profil: alles fuers Seitenmenue
  let a = await api('tokAnna', '/api/profile');
  pruefe('Profil: lio, lioBoni, lioSerie, lioFreunde', a.j.lio >= 33 && a.j.lioBoni.length === 4 && a.j.lioBoni[0].text === 'Wochen-Bonus (14 Tage in Folge)' && a.j.lioSerie.woche === 3 && a.j.lioFreunde.proFreund === 10);
  pruefe('Profil: lioNeu mit Tages-Lios', Array.isArray(a.j.lioNeu) && a.j.lioNeu.length > 0 && a.j.lioNeu.every(n => n.id && n.menge > 0));
  a = await api('tokAnna', '/api/lio/gesehen', { ids: a.j.lioNeu.slice(0, 2).map(n => n.id) });
  pruefe('gesehen: zwei weniger', a.status === 200 && a.j.lioNeu.length === (P('anna').lioNeu || []).length);
  a = await api('tokAnna', '/api/lio/gesehen', { alle: true });
  pruefe('gesehen: alle', a.j.lioNeu.length === 0);
  const vor = S.lioStand(P('anna'));
  a = await api('tokAnna', '/api/lio/bonus', { alle: true });
  pruefe('alle Boni abholen: 3+3+3+10', a.status === 200 && a.j.menge === 19 && a.j.lio === vor + 19 && a.j.lioBoni.length === 0);
  a = await api('tokAnna', '/api/lio/bonus', { id: 'woche-2026-10-14' });
  pruefe('abgeholter Bonus: 404', a.status === 404);
  a = await api('tokAnna', '/api/lio');
  pruefe('Buchungen: neueste zuerst', a.j.log[0].grund === 'monat' && a.j.log.length <= S.LIO.logMax);

  // --- Shop
  a = await api(null, '/api/shop');
  const amz = a.j.produkte[0];
  pruefe('Shop: Amazon 5 €, 500 Lios, ausverkauft', amz.id === 'amazon-5' && amz.wert === 5 && amz.preisLio === 500 && amz.ausverkauft === true && a.j.echtgeld === false);
  a = await api('tokAnna', '/api/shop/kaufen', { produkt: 'amazon-5', zahlung: 'lio' });
  pruefe('Kauf ausverkauft: 409', a.status === 409 && a.j.ausverkauft === true);
  a = await api('tokAnna', '/api/shop/kaufen', { produkt: 'amazon-5', zahlung: 'euro' });
  pruefe('Echtgeld: 501', a.status === 501 && a.j.error === 'Bezahlen mit Echtgeld kommt bald.');
  a = await api(null, '/api/admin/shop/codes', { produkt: 'amazon-5', codes: 'AAAA-BBBBBB-CCCC\nx\n' });
  pruefe('Admin ohne Key: 403', a.status === 403);
  a = await admin('/api/admin/shop/codes', { produkt: 'amazon-5', codes: 'AAAA-BBBBBB-CCCC\nDDDD-EEEEEE-FFFF\naaaabbbbbbcccc\n<script>\n' });
  pruefe('Admin: 2 Codes rein, 1 doppelt, 1 ungueltig', a.status === 200 && a.j.hinzu === 2 && a.j.doppelt === 1 && a.j.ungueltig === 1 && a.j.bestand === 2);
  a = await api(null, '/api/shop');
  pruefe('Shop: jetzt verfuegbar, kein Code im Katalog', a.j.produkte[0].verfuegbar === true && !JSON.stringify(a.j).includes('AAAA'));
  a = await api('tokAnna', '/api/shop/kaufen', { produkt: 'amazon-5', zahlung: 'lio' });
  pruefe('anna: Adresse unbestaetigt: 403', a.status === 403 && a.j.emailNoetig === true);
  S.users.anna.emailOk = 1;
  const stand = S.lioStand(P('anna'));
  a = await api('tokAnna', '/api/shop/kaufen', { produkt: 'amazon-5', zahlung: 'lio' });
  pruefe(`zu wenig Lios (${stand}): 409 mit Fehlbetrag`, a.status === 409 && a.j.fehlen === 500 - stand && a.j.error === `Dir fehlen noch ${500 - stand} Lios.`);
  P('anna').lio = 1000;
  // Zwei Kaeufe gleichzeitig: jeder bekommt einen eigenen Code
  const [k1, k2, k3] = await Promise.all([1, 2, 3].map(() => api('tokAnna', '/api/shop/kaufen', { produkt: 'amazon-5', zahlung: 'lio' })));
  const ok = [k1, k2, k3].filter(x => x.status === 200);
  pruefe('drei gleichzeitig mit 1000 Lios und 2 Codes: 2 Kaeufe', ok.length === 2 && S.lioStand(P('anna')) === 0);
  pruefe('... verschiedene Codes', ok[0].j.gutschein.code !== ok[1].j.gutschein.code);
  pruefe('... dritter: ausverkauft', [k1, k2, k3].some(x => x.status === 409 && x.j.ausverkauft));
  const w = await api('tokAnna', '/api/wallet');
  pruefe('Gutscheine liegen in der Wallet (Amazon, 5 €, Code)', w.j.vouchers.filter(v => v.herkunft === 'shop' && v.vendor === 'Amazon' && v.balance === 5 && v.code).length === 2);
  a = await admin('/api/admin/shop');
  pruefe('Admin: Bestand 0, 2 verkauft, Codes maskiert', a.j.produkte[0].bestand === 0 && a.j.produkte[0].verkauft === 2 && !JSON.stringify(a.j).includes('BBBBBB'));
  a = await admin('/api/admin/shop/codes', { produkt: 'amazon-5', codes: 'AAAA BBBBBB CCCC' });
  pruefe('Admin: verkaufter Code kommt nicht wieder rein', a.j.hinzu === 0 && a.j.doppelt === 1);
  a = await admin('/api/admin/shop/produkt', { produkt: 'amazon-5', cashbackLio: 25 });
  pruefe('Admin: Cashback 25', a.status === 200 && a.j.produkt.cashbackLio === 25);
  await admin('/api/admin/shop/codes', { produkt: 'amazon-5', codes: 'GGGG-HHHHHH-IIII' });
  P('anna').lio = 500;
  a = await api('tokAnna', '/api/shop/kaufen', { produkt: 'amazon-5', zahlung: 'lio' });
  pruefe('Kauf mit Cashback: 500 - 500 + 25', a.status === 200 && a.j.lio === 25 && a.j.cashback === 25);
  a = await admin('/api/admin/shop/produkt', { produkt: 'amazon-5', aktiv: false });
  pruefe('Admin: deaktiviert, Shop leer', (await api(null, '/api/shop')).j.produkte.length === 0);
  await admin('/api/admin/shop/produkt', { produkt: 'amazon-5', aktiv: true, cashbackLio: 0 });
  a = await admin('/api/admin/lio', { user: 'anna', delta: -26 });
  pruefe('Admin: nicht unter 0', a.status === 409);
  a = await admin('/api/admin/lio', { user: 'anna', delta: 12, grund: 'Erstattung <b>' });
  pruefe('Admin: +12 mit Stern', a.j.lio === 37 && P('anna').lioNeu.slice(-1)[0].text === 'Erstattung b');

  // --- Einladung ueber die Registrierung, Konto loeschen und neu: einmal
  const echtesFetch = global.fetch;
  global.fetch = (u, o) => /^http:\/\/127\.0\.0\.1:/.test(String(u)) ? echtesFetch(u, o)
    : /challenges\.cloudflare\.com/.test(String(u)) ? Promise.resolve({ json: async () => ({ success: true }) })
      : Promise.reject(new Error('kein Netz im Test'));
  const neuKonto = async () => {
    const t = (await api(null, '/api/register', { user: 'zoe', email: 'zoe@example.invalid', pass: 'geheim123', turnstileToken: 'x', ref: 'anna' })).j.token;
    S.users.zoe.emailOk = 1;
    S.loginTagZaehlen('zoe', tag(10, 1)); S.loginTagZaehlen('zoe', tag(10, 2)); S.loginTagZaehlen('zoe', tag(10, 3));
    return t;
  };
  const vorZoe = S.lioStand(P('anna'));
  let t = await neuKonto();
  pruefe('zoe ueber annas Link, bestaetigt, 3 Tage: +10', S.lioStand(P('anna')) === vorZoe + 10);
  await api(t, '/api/account/delete', { pass: 'geheim123' });
  t = await neuKonto();
  pruefe('zoe geloescht und mit derselben Adresse neu: nichts', S.lioStand(P('anna')) === vorZoe + 10 && P('anna').geworben.find(g => g.user === 'zoe').lioKein > 0);
  pruefe('Freunde-Info: 1 gutgeschrieben, 0 wartend', (await api('tokAnna', '/api/profile')).j.lioFreunde.gutgeschrieben === 1);

  // --- Kein Echtgeld-Pfad
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  pruefe('kein Zahlungs-SDK', !/require\(['"](stripe|paypal|@paypal|braintree)/i.test(src));

  S.server.closeAllConnections();
  await new Promise(ok => S.server.close(ok));
  await new Promise(ok => setTimeout(ok, 300));
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(fehler ? `\n${fehler} Fehler` : '\nAlles gruen.');
  process.exit(fehler ? 1 : 0);
})();
