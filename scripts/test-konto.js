// Tests fuer Konto-Sicherheit und Aufraeumen: 2FA (RFC 6238), Ersatzcodes,
// Drossel, 30-Tage-Regel fuer Aufgebrauchte. Leerer Datenordner:
//   node scripts/test-konto.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kumulio-konto-'));
process.env.RA_DATA_DIR = DIR;
process.env.RA_TEST = '1';
const S = require('../server.js');

let fehler = 0;
const pruefe = (name, ok) => { console.log((ok ? 'OK   ' : 'FEHL ') + name); if (!ok) fehler++; };

// --- TOTP: Testwerte aus RFC 6238 (SHA-1, 8-stellig -> hier die letzten 6)
const secret = S.base32(Buffer.from('12345678901234567890'));
pruefe('Base32 wie im RFC', secret === 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
pruefe('Base32 hin und zurueck', S.base32Lesen(secret).toString() === '12345678901234567890');
pruefe('TOTP T=59 -> 287082', S.totpCode(secret, Math.floor(59 / 30)) === '287082');
pruefe('TOTP T=1111111109 -> 081804', S.totpCode(secret, Math.floor(1111111109 / 30)) === '081804');
pruefe('TOTP T=2000000000 -> 279037', S.totpCode(secret, Math.floor(2000000000 / 30)) === '279037');

const t = { secret, letzter: 0 };
const jetzt = S.totpCode(secret, Math.floor(Date.now() / 30000));
pruefe('aktueller Code gilt', S.totpPruefen(t, jetzt));
pruefe('derselbe Code gilt nicht zweimal', !S.totpPruefen(t, jetzt));
pruefe('falscher Code gilt nicht', !S.totpPruefen({ secret, letzter: 0 }, '000000') || jetzt === '000000');

// --- Ersatzcodes: jeder genau einmal, mit oder ohne Bindestrich
const { codes, hashes } = S.neueErsatzcodes();
const t2 = { secret, reserve: hashes.slice() };
pruefe('8 Ersatzcodes', codes.length === 8 && new Set(codes).size === 8);
pruefe('Ersatzcode mit Bindestrich', S.ersatzcodeEinloesen(t2, codes[0]));
pruefe('Ersatzcode nur einmal', !S.ersatzcodeEinloesen(t2, codes[0]));
pruefe('Ersatzcode ohne Bindestrich, gross geschrieben', S.ersatzcodeEinloesen(t2, codes[1].replace('-', '').toUpperCase()));
pruefe('Rest: 6', t2.reserve.length === 6);

// --- Drossel
pruefe('Drossel laesst 3 durch', [1, 2, 3].every(() => S.drossel('test', 3, 60e3)));
pruefe('Drossel stoppt den 4.', !S.drossel('test', 3, 60e3));

// --- 30-Tage-Regel (mit Uebergangsfrist ab Einfuehrung am 24.09.2026)
const tag = 864e5;
pruefe('Frist: vor dem 24.10.2026 wird nichts entfernt', !S.aufgebrauchtWeg({ balance: 0, added: 1, tx: [{ ts: 1 }] }, S.AUFRAEUMEN_AB + 29 * tag));
const n = S.AUFRAEUMEN_AB + 90 * tag; // "heute" liegt fuer die folgenden Tests nach der Frist
pruefe('aufgebraucht, letzte Buchung vor 31 Tagen -> weg', S.aufgebrauchtWeg({ balance: 0, added: n - 90 * tag, tx: [{ ts: n - 31 * tag }] }, n));
pruefe('aufgebraucht, letzte Buchung vor 29 Tagen -> bleibt', !S.aufgebrauchtWeg({ balance: 0, added: n - 90 * tag, tx: [{ ts: n - 29 * tag }] }, n));
pruefe('Restguthaben -> bleibt immer', !S.aufgebrauchtWeg({ balance: 0.01, added: n - 900 * tag, tx: [] }, n));
pruefe('ohne Betrag (null) -> bleibt immer', !S.aufgebrauchtWeg({ balance: null, added: n - 900 * tag, tx: [] }, n));
pruefe('200.000 Buchungen -> kein Absturz', (() => { try { S.aufgebrauchtWeg({ balance: 0, added: 1, tx: Array.from({ length: 200000 }, () => ({ ts: 1 })) }, n); return true; } catch { return false; } })());

const echtesJetzt = Date.now;
Date.now = () => n;
S.users.tina = { hash: 'x', salt: 'y', email: 'tina@example.com', ts: n };
S.users.otto = { hash: 'x', salt: 'y', email: 'otto@example.com', ts: n, profile: { autoAufraeumen: false } };
S.wallets.tina = { vouchers: [
  null, // kaputter Altbestand darf nichts stoppen
  { id: 'alt', vendor: 'REWE', amount: 10, balance: 0, added: n - 60 * tag, tx: [{ id: 'a', amt: -10, ts: n - 40 * tag }] },
  { id: 'frisch', vendor: 'REWE', amount: 10, balance: 0, added: n - 60 * tag, tx: [{ id: 'b', amt: -10, ts: n - 3 * tag }] },
  { id: 'voll', vendor: 'dm', amount: 10, balance: 10, added: n - 300 * tag, tx: [] },
  // Rabattcode ohne Guthaben: wird nie "aufgebraucht" aufgeraeumt
  { id: 'rc', art: 'rabatt', vendor: 'Subway', code: 'SUB2', amount: null, balance: null, added: n - 900 * tag, tx: [] },
], cards: [], deleted: [] };
S.wallets.otto = { vouchers: [{ id: 'o1', vendor: 'REWE', amount: 5, balance: 0, added: n - 90 * tag, tx: [{ id: 'c', amt: -5, ts: n - 80 * tag }] }], cards: [], deleted: [] };
const weg = S.raeumeAufgebrauchteAuf();
pruefe('genau einer entfernt', weg === 1);
pruefe('alter aufgebrauchter ist weg, mit Loeschmarker', !S.wallets.tina.vouchers.some(v => v && v.id === 'alt') && S.wallets.tina.deleted.some(d => d.id === 'alt'));
pruefe('frisch aufgebrauchter und voller bleiben', ['frisch', 'voll'].every(id => S.wallets.tina.vouchers.some(v => v && v.id === id)));
pruefe('Rabattcode bleibt beim Aufraeumen', S.wallets.tina.vouchers.some(v => v && v.id === 'rc'));
pruefe('abgeschaltet (otto): nichts entfernt', S.wallets.otto.vouchers.length === 1);
const st = S.wallets.tina.statistik || {};
const summe = Object.values(st).reduce((x, e) => ({ rein: x.rein + e.rein, raus: x.raus + e.raus }), { rein: 0, raus: 0 });
pruefe('Statistik bleibt: 10 rein, 10 raus', summe.rein === 10 && summe.raus === 10);
S.archivFlush();
const korb = fs.readdirSync(path.join(DIR, 'archiv')).map(f => fs.readFileSync(path.join(DIR, 'archiv', f), 'utf8')).join('');
pruefe('entfernter liegt im Papierkorb', korb.includes('"alt"') && korb.includes('nach 30 Tagen'));
// Nach dem Aufraeumen noch aufgeladen (anderes Geraet hatte ihn noch): lebt wieder auf
S.vereinigeWallet('tina', { vouchers: [{ id: 'alt', vendor: 'REWE', amount: 10, balance: 25, added: n - 60 * tag, mt: n + 1000,
  tx: [{ id: 'auf', amt: 25, ts: n + 1000 }, { id: 'a', amt: -10, ts: n - 40 * tag }] }], cards: [], deleted: [] });
const wieder = S.wallets.tina.vouchers.find(v => v && v.id === 'alt');
pruefe('nach dem Aufraeumen aufgeladen -> wieder da (25 EUR)', !!wieder && wieder.balance === 25 && wieder.wiederbelebt > 0);
pruefe('Index meldet ihn mit neuem Anlegedatum', S.walletIndex(S.wallets.tina).v.find(r => r[0] === 'alt')[4] >= n);
// Pfandbons: eingeloeste nach 30 Tagen weg, im Papierkorb als "eingeloest"
// (nicht "aufgebraucht"), offene bleiben
S.users.pia = { hash: 'x', salt: 'y', email: 'pia@example.com', ts: n };
S.wallets.pia = { vouchers: [
  { id: 'pfalt', art: 'pfand', vendor: 'Lidl', amount: 6.25, balance: null, eingeloest: n - 40 * tag, added: n - 60 * tag, mt: n - 40 * tag, tx: [], filiale: {} },
  { id: 'pfoffen', art: 'pfand', vendor: 'EDEKA', amount: 13.47, balance: null, eingeloest: 0, added: n - 400 * tag, mt: n - 400 * tag, tx: [], filiale: {} },
], cards: [], deleted: [] };
pruefe('eingeloester Pfandbon aufgeraeumt', S.raeumeAufgebrauchteAuf() === 1 && S.wallets.pia.vouchers.map(v => v.id).join() === 'pfoffen');
S.archivFlush();
const korbPia = fs.readdirSync(path.join(DIR, 'archiv')).map(f => fs.readFileSync(path.join(DIR, 'archiv', f), 'utf8')).join('');
pruefe('Papierkorb: Pfandbon "eingelöst, nach 30 Tagen entfernt"', korbPia.includes('"pfalt"') && korbPia.includes('eingelöst, nach 30 Tagen entfernt'));
Date.now = echtesJetzt;

fs.rmSync(DIR, { recursive: true, force: true });
console.log(fehler ? `\n${fehler} FEHLER` : '\nAlles gruen');
process.exit(fehler ? 1 : 0);
