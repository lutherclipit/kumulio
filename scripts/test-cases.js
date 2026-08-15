// Sicherheitsnetz: In kumulio gibt es KEIN Echtgeld.
// Kisten kommen aus Spar-Aktivität oder dem Coin-Shop, und Coins selbst sind
// ausschließlich erspielbar (Quests, Tagesbonus, Verkäufe). Dieser Test schlägt
// fehl, sobald jemand einen Echtgeld- oder Payment-Pfad einbaut.
// Ausführen:  RA_TEST=1 node scripts/test-cases.js
process.env.RA_TEST = '1';
process.env.RA_DATA_DIR = require('path').join(__dirname, '..', 'data');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { CaseSource, grantCase, users } = require('../server.js');

// 1. Keine Echtgeld-Quelle im Enum
assert.ok(!Object.keys(CaseSource).some(k => /purchase|payment|money|echtgeld|iap/i.test(k)),
  'CaseSource darf keine Echtgeld-Quelle enthalten');

// 2. grantCase wirft bei jeder unbekannten Quelle
users['__testuser__'] = {};
assert.throws(() => grantCase('__testuser__', 'standard', 'PURCHASE'), /Quelle unbekannt/);
assert.throws(() => grantCase('__testuser__', 'standard', 'REAL_MONEY'), /Quelle unbekannt/);

// 3. Verdiente Quellen funktionieren (inkl. Shop mit erspielten Coins)
grantCase('__testuser__', 'standard', CaseSource.RANK_UP);
grantCase('__testuser__', 'gold', CaseSource.SHOP);
assert.strictEqual(users['__testuser__'].profile.cases.length, 2);
delete users['__testuser__'];

// 4. Kein Payment-Endpoint und keine Echtgeld-Begriffe im Server-Code
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.ok(!/api\/(payment|checkout|purchase|billing)/i.test(src), 'Kein Payment-Endpoint erlaubt');
// Keine eingebundenen Zahlungs-SDKs (Erwähnungen im Scam-Filter-Text sind ok)
assert.ok(!/require\(['"](stripe|paypal|@paypal|braintree)/i.test(src), 'Kein Zahlungs-SDK im Server');

console.log('OK: Keine Echtgeld-Pfade. Kisten und Coins sind nur erspielbar.');
process.exit(0); // server.js hält sonst mit seinen Intervallen den Prozess offen
