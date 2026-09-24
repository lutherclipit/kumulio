// Tests fuers Profil nach Runde 117: Kisten, Funken, Quests, Shop, Paints und
// Rahmen sind abgeschaltet, dafuer gibt es die Login-Serie (Kalendertage in
// Europe/Berlin), eine frei waehlbare Namensfarbe und vorgemerkte Einladungen.
// Dazu das alte Sicherheitsnetz: kein Echtgeld-Pfad im Server.
// Leerer Datenordner:  node scripts/test-profil.js
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kumulio-profil-'));
process.env.RA_TEST = '1';
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

console.log(fehler ? `\n${fehler} Fehler` : '\nAlles gruen.');
process.exit(fehler ? 1 : 0); // server.js haelt sonst mit seinen Intervallen den Prozess offen
