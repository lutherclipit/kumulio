// Sicherheitsnetz: Kisten sind AUSSCHLIESSLICH erspielbar.
// Dieser Test schlägt fehl, sobald jemand eine Kauf-Quelle einbaut oder
// grantCase eine unbekannte Quelle akzeptiert.
// Ausführen:  RA_TEST=1 node scripts/test-cases.js
process.env.RA_TEST = '1';
process.env.RA_DATA_DIR = require('path').join(__dirname, '..', 'data');
const assert = require('assert');
const { CaseSource, grantCase, users } = require('../server.js');

// 1. Es gibt keine Kauf-Quelle
assert.ok(!('PURCHASE' in CaseSource), 'CaseSource darf keinen PURCHASE-Eintrag haben');
assert.ok(!Object.values(CaseSource).some(v => /buy|purchase|coin|kauf/i.test(v)),
  'Keine CaseSource darf nach Kauf aussehen');

// 2. grantCase wirft bei jeder unbekannten Quelle
users['__testuser__'] = {};
assert.throws(() => grantCase('__testuser__', 'standard', 'PURCHASE'), /Quelle unbekannt/);
assert.throws(() => grantCase('__testuser__', 'standard', 'COINS'), /Quelle unbekannt/);

// 3. Verdiente Quellen funktionieren
grantCase('__testuser__', 'standard', CaseSource.RANK_UP);
assert.strictEqual(users['__testuser__'].profile.cases.length, 1);
delete users['__testuser__'];

console.log('OK: Kisten sind nur erspielbar, keine Kauf-Quelle vorhanden.');
process.exit(0); // server.js hält sonst mit seinen Intervallen den Prozess offen
