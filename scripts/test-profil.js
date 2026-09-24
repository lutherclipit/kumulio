// Tests fuers Profil nach Runde 117: Kisten, Funken, Quests, Shop, Paints und
// Rahmen sind abgeschaltet, dafuer gibt es die Login-Serie (Kalendertage in
// Europe/Berlin), eine frei waehlbare Namensfarbe und vorgemerkte Einladungen.
// Dazu das alte Sicherheitsnetz: kein Echtgeld-Pfad im Server.
// Leerer Datenordner:  node scripts/test-profil.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kumulio-profil-'));
process.env.RA_DATA_DIR = DIR;
process.env.RA_TEST = '1';
delete process.env.RESEND_API_KEY; // nie echte Mails aus dem Test
// Einladungen mit Resten aus der Zeit vor Runde 118 (Loeschen nahm sie nicht
// mit): wera hat 2 Alt-Einladungen (nur refCount) und 4 Eintraege in geworben,
// davon einer geloescht und hans doppelt (erst geloescht, dann neu registriert)
const HASH = require('crypto').scryptSync('geheim123', 'salz', 32).toString('hex');
const konto = (name, ts, profil = {}) => [name, { hash: HASH, salt: 'salz', email: name + '@example.invalid', ts, profile: { bio: '', publicProfile: true, ...profil } }];
fs.writeFileSync(path.join(DIR, 'users.json'), JSON.stringify(Object.fromEntries([
  konto('wera', 1000, { refCount: 6, geworben: [{ user: 'gina', ts: 5000 }, { user: 'geloescht', ts: 5100 }, { user: 'hans', ts: 5200 }, { user: 'hans', ts: 6000 }] }),
  konto('gina', 5000, { invitedBy: 'wera' }),
  konto('hans', 6000, { invitedBy: 'wera' }),
  konto('kai', 2000, { invitedBy: 'wera' }),   // Alt-Einladung ohne Eintrag in geworben
  konto('ida', 3000, { invitedBy: 'vera' }),   // vera hat sich geloescht, der Name gehoert jetzt jemand Neuem
  konto('jan', 3000, { invitedBy: 'niemand' }),
  konto('vera', 7000),
])));
fs.writeFileSync(path.join(DIR, 'sessions.json'), JSON.stringify({ tokWera: 'wera', tokGina: 'gina', tokHans: 'hans' }));
const S = require('../server.js');

let fehler = 0;
const pruefe = (name, ok) => { console.log((ok ? 'OK   ' : 'FEHL ') + name); if (!ok) fehler++; };

// --- Abgeschaltete Endpunkte
for (const p of ['/api/daily', '/api/gami', '/api/quests/claim', '/api/case/open', '/api/item/sell',
  '/api/item/sell-many', '/api/sticker/use', '/api/shop/buy', '/api/border', '/api/paint']) {
  pruefe('abgeschaltet: ' + p, S.GAMI_WEG.has(p));
}

// --- Kalendertag in Berlin, auch um Mitternacht und bei der Zeitumstellung
pruefe('23:30 Uhr Berlin (Sommerzeit) ist noch derselbe Tag', S.berlinTag(Date.UTC(2026, 8, 24, 21, 30)) === '2026-09-24');
pruefe('00:30 Uhr Berlin (Sommerzeit) ist schon der naechste', S.berlinTag(Date.UTC(2026, 8, 24, 22, 30)) === '2026-09-25');
pruefe('Winterzeit: 00:30 Uhr Berlin', S.berlinTag(Date.UTC(2026, 11, 31, 23, 30)) === '2027-01-01');

// --- Login-Serie
const prof = {};
const tag = (y, m, d, h = 12) => Date.UTC(y, m - 1, d, h - 2); // Mittag Berlin (Sommerzeit)
pruefe('erster Tag zaehlt', S.zaehleLoginTag(prof, tag(2026, 10, 20)) && prof.loginStreak.tage === 1);
pruefe('am selben Tag nichts Neues', !S.zaehleLoginTag(prof, tag(2026, 10, 20, 22)) && prof.loginStreak.tage === 1);
S.zaehleLoginTag(prof, tag(2026, 10, 21));
S.zaehleLoginTag(prof, tag(2026, 10, 22));
pruefe('drei Tage in Folge', prof.loginStreak.tage === 3 && prof.loginStreak.rekord === 3);
// Ueber die Zeitumstellung (25.10.2026, der Tag hat 25 Stunden) laeuft die Serie weiter
S.zaehleLoginTag(prof, tag(2026, 10, 23));
S.zaehleLoginTag(prof, tag(2026, 10, 24));
S.zaehleLoginTag(prof, Date.UTC(2026, 9, 25, 11));
S.zaehleLoginTag(prof, Date.UTC(2026, 9, 26, 11));
pruefe('Serie haelt ueber die Zeitumstellung', prof.loginStreak.tage === 7 && prof.loginStreak.letzterTag === '2026-10-26');
pruefe('gestern zuletzt: Serie laeuft noch', S.loginSerie(prof, Date.UTC(2026, 9, 27, 11)).tage === 7);
pruefe('vorgestern zuletzt: Serie ist vorbei, Rekord bleibt', (() => {
  const s = S.loginSerie(prof, Date.UTC(2026, 9, 28, 11));
  return s.tage === 0 && s.rekord === 7;
})());
S.zaehleLoginTag(prof, Date.UTC(2026, 9, 29, 11));
pruefe('nach einer Luecke beginnt sie bei 1', prof.loginStreak.tage === 1 && prof.loginStreak.rekord === 7);

// --- Namensfarbe
S.users.nina = { hash: 'x', salt: 'y', ts: 1, profile: { nameColor: '#E5484D' } };
S.users.olaf = { hash: 'x', salt: 'y', ts: 1, profile: { nameColor: 'red; background:url(x)' } };
S.users.paul = { hash: 'x', salt: 'y', ts: 1, profile: {} };
pruefe('gueltige Farbe kommt klein geschrieben', S.namensfarbe('nina') === '#e5484d');
pruefe('ungueltige Farbe kommt nie raus', S.namensfarbe('olaf') === null);
pruefe('ohne Farbe: null', S.namensfarbe('paul') === null);

// --- Einladungen: vorgemerkt, alte Zaehler zaehlen mit
pruefe('Einladungen: Liste', S.eingeladenZahl({ geworben: [{ user: 'a', ts: 1 }, { user: 'b', ts: 2 }] }) === 2);
pruefe('Einladungen: alter Zaehler', S.eingeladenZahl({ refCount: 3, geworben: [{ user: 'a', ts: 1 }] }) === 3);

// --- Eigenes Profil: keine Alt-Felder (Funken, Kisten, Raenge) mehr
S.users.rita = { hash: 'x', salt: 'y', ts: 1, profile: { bio: 'hi', coins: 500, cases: [{ id: 'x' }], rankTier: 4, seenV: ['a'], nameColor: '#30a46c' } };
const ep = S.eigenesProfil('rita');
pruefe('eigenes Profil ohne Alt-Felder', !('coins' in ep) && !('cases' in ep) && !('rankTier' in ep) && !('seenV' in ep));
pruefe('eigenes Profil mit Farbe und Serie', ep.nameColor === '#30a46c' && ep.loginStreak && ep.loginStreak.tage === 0);
pruefe('Alt-Daten bleiben im Konto liegen', S.users.rita.profile.coins === 500);

// --- Kein Echtgeld: kein Payment-Endpoint, kein Zahlungs-SDK
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
pruefe('kein Payment-Endpoint', !/api\/(payment|checkout|purchase|billing)/i.test(src));
pruefe('kein Zahlungs-SDK', !/require\(['"](stripe|paypal|@paypal|braintree)/i.test(src));

// --- Einladungen: Reste beim Start aufgeraeumt, Alt-Zaehler bleibt
const gew = n => (S.users[n].profile.geworben || []).map(g => g.user).join(',');
pruefe('Start: geloeschte und doppelte Eintraege raus', gew('wera') === 'gina,hans' && S.users.wera.profile.geworben[1].ts === 6000);
pruefe('Start: Zaehler sinkt mit, Alt-Einladungen bleiben (2 + 2)', S.users.wera.profile.refCount === 4 && S.eingeladenZahl(S.users.wera.profile) === 4);
pruefe('Start: invitedBy auf neu vergebenen/fehlenden Namen weg', !('invitedBy' in S.users.ida.profile) && !('invitedBy' in S.users.jan.profile));
pruefe('Start: echte und Alt-Einladungen behalten invitedBy', ['gina', 'hans', 'kai'].every(n => S.users[n].profile.invitedBy === 'wera'));
pruefe('Start: zweiter Lauf aendert nichts', S.einladungenAufraeumen() === 0);

(async () => {
  // Turnstile beim Registrieren: im Test ohne Netz immer bestanden
  const echtesFetch = global.fetch;
  global.fetch = (u, o) => /^http:\/\/127\.0\.0\.1:/.test(String(u)) ? echtesFetch(u, o)
    : /challenges\.cloudflare\.com/.test(String(u)) ? Promise.resolve({ json: async () => ({ success: true }) })
      : Promise.reject(new Error('kein Netz im Test'));
  await new Promise(ok => S.server.listen(0, '127.0.0.1', ok));
  const basis = `http://127.0.0.1:${S.server.address().port}`;
  const api = async (tok, p, body) => {
    const a = await global.fetch(basis + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: a.status, j: await a.json().catch(() => null) };
  };
  const eingeladen = async () => (await api('tokWera', '/api/profile')).j.eingeladen;
  const registriere = async (user, ref) => (await api(null, '/api/register', { user, email: user.toLowerCase() + '@example.invalid', pass: 'geheim123', turnstileToken: 'x', ref })).j.token;
  const loesche = tok => api(tok, '/api/account/delete', { pass: 'geheim123' });

  pruefe('eingeladen: 4', await eingeladen() === 4);
  pruefe('Geworbene loescht ihr Konto', (await loesche('tokGina')).status === 200);
  pruefe('... Eintrag beim Werber weg, Zaehler 3', gew('wera') === 'hans' && await eingeladen() === 3);
  // Registrieren, Loeschen, neu Registrieren ueber denselben Link: zaehlt einmal
  let tok = await registriere('gina', 'WERA');
  pruefe('neu ueber den Link: 4', await eingeladen() === 4 && S.users.gina.profile.invitedBy === 'wera');
  await loesche(tok);
  tok = await registriere('gina', 'wera');
  await loesche(tok);
  tok = await registriere('gina', 'wera');
  pruefe('zweimal geloescht und neu: bleibt 4, gina nur einmal', await eingeladen() === 4 && gew('wera') === 'hans,gina');
  // Ein Rest mit demselben Namen (andere Schreibweise) wird ersetzt, nicht doppelt gezaehlt
  S.users.wera.profile.geworben.push({ user: 'Lena', ts: 1 }); S.users.wera.profile.refCount++;
  await registriere('lena', 'wera');
  pruefe('Name je Werber nur einmal', gew('wera') === 'hans,gina,lena' && await eingeladen() === 5);
  // Werber loescht sein Konto: niemand zeigt mehr auf den Namen
  pruefe('Werber loescht sein Konto', (await loesche('tokWera')).status === 200);
  pruefe('... invitedBy bei allen Geworbenen weg', ['gina', 'hans', 'kai', 'lena'].every(n => !('invitedBy' in S.users[n].profile)));
  await registriere('wera');
  pruefe('... und ein neues Konto mit dem Namen erbt nichts', !!S.users.wera && S.eingeladenZahl(S.profileOf('wera')) === 0);

  // --- Profil speichern: erst pruefen, dann schreiben
  let a = await api('tokHans', '/api/profile', { bio: 'NEUE BIO', publicProfile: false, nameColor: 'red' });
  pruefe('ungueltige Farbe: 400', a.status === 400);
  pruefe('... und nichts gespeichert', S.users.hans.profile.bio === '' && S.users.hans.profile.publicProfile === true);
  a = await api('tokHans', '/api/profile', { bio: 'ok', nameColor: '#AABBCC' });
  pruefe('gueltige Farbe: gespeichert, klein geschrieben', a.status === 200 && a.j.bio === 'ok' && a.j.nameColor === '#aabbcc');
  a = await api('tokHans', '/api/profile', { nameColor: '' });
  pruefe('leere Farbe: automatisch', a.status === 200 && a.j.nameColor === null);

  S.server.closeAllConnections();
  await new Promise(ok => S.server.close(ok));
  await new Promise(ok => setTimeout(ok, 300)); // Hintergrundarbeit auslaufen lassen (libuv unter Windows)
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(fehler ? `\n${fehler} Fehler` : '\nAlles gruen.');
  process.exit(fehler ? 1 : 0); // server.js haelt sonst mit seinen Intervallen den Prozess offen
})();
