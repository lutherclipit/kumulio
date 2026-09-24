// Tests fuer den Wallet-Kern am Server: Bildablage, Aufraeumen, Vereinigen.
// Laeuft in einem leeren Datenordner, fasst echte Daten nie an:
//   node scripts/test-wallet.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kumulio-test-'));
process.env.RA_DATA_DIR = DIR;
process.env.RA_TEST = '1';
const S = require('../server.js');

let fehler = 0;
const pruefe = (name, ok) => { console.log((ok ? 'OK   ' : 'FEHL ') + name); if (!ok) fehler++; };
const bild = (farbe) => 'data:image/jpeg;base64,' + Buffer.from('JPEG-' + farbe + '-'.repeat(2000)).toString('base64');
const alt = datei => { const t = new Date(Date.now() - 5 * 86400e3); fs.utimesSync(datei, t, t); };

(async () => {
  // --- Bildablage: Eingang wird Verweis, Ausgang wieder data-URL
  S.vereinigeWallet('tina', { vouchers: [{ id: 'a1', vendor: 'REWE', amount: 5, balance: 5, tx: [], added: 1, codeImg: bild('rot') }], cards: [], deleted: [] });
  const ref = S.wallets.tina.vouchers[0].codeImg;
  pruefe('Bild wird als Verweis gespeichert', ref.startsWith('bild:'));
  pruefe('Bilddatei existiert', fs.existsSync(path.join(DIR, 'bilder', ref.slice(5))));
  pruefe('Index meldet Bild', S.walletIndex(S.wallets.tina).v[0][3] === 1);

  // --- Aufraeumen: benutzt bleibt, unbenutzt+alt geht, Papierkorb schuetzt
  const benutzt = path.join(DIR, 'bilder', ref.slice(5));
  const weg = S.bildAblegen(bild('blau')).slice(5);            // nirgends referenziert
  const imKorb = S.bildAblegen(bild('gruen'));                 // nur im Papierkorb
  S.archiviere('tina', [{ id: 'k1', vendor: 'dm', codeImg: imKorb }], 'gelöscht');
  S.archivFlush();
  const neuUnbenutzt = S.bildAblegen(bild('gelb')).slice(5);   // unbenutzt, aber frisch
  for (const f of [benutzt, path.join(DIR, 'bilder', weg), path.join(DIR, 'bilder', imKorb.slice(5))]) alt(f);
  await S.bilderAufraeumen();
  pruefe('benutztes Bild bleibt', fs.existsSync(benutzt));
  pruefe('unbenutztes altes Bild wird entfernt', !fs.existsSync(path.join(DIR, 'bilder', weg)));
  pruefe('Bild im Papierkorb bleibt', fs.existsSync(path.join(DIR, 'bilder', imKorb.slice(5))));
  pruefe('frisches unbenutztes Bild bleibt (2-Tage-Frist)', fs.existsSync(path.join(DIR, 'bilder', neuUnbenutzt)));

  // --- Aufraeumen bricht ab, wenn der Papierkorb nicht lesbar ist (nie raten)
  const noch = S.bildAblegen(bild('lila')).slice(5);
  alt(path.join(DIR, 'bilder', noch));
  const korb = path.join(DIR, 'archiv');
  fs.renameSync(korb, korb + '-weg');
  fs.writeFileSync(korb, 'kein Ordner'); // readdir -> ENOTDIR
  await S.bilderAufraeumen();
  pruefe('unlesbarer Papierkorb: nichts geloescht', fs.existsSync(path.join(DIR, 'bilder', noch)));
  fs.rmSync(korb); fs.renameSync(korb + '-weg', korb);

  // --- Totes Bild: Datei fehlt -> Index meldet kein Bild, Geraet laedt neu hoch
  fs.rmSync(benutzt);
  S.bildDateien.delete(ref.slice(5));
  pruefe('fehlende Datei: Index meldet kein Bild', S.walletIndex(S.wallets.tina).v[0][3] === 0);
  S.vereinigeWallet('tina', { vouchers: [{ ...S.wallets.tina.vouchers[0], codeImg: bild('rot') }], cards: [], deleted: [] });
  pruefe('erneuter Upload heilt die Datei', fs.existsSync(benutzt) && S.walletIndex(S.wallets.tina).v[0][3] === 1);

  // --- Vereinigen: Buchungen beider Geraete, Rueckgaengig, mt+1
  const basis = { id: 'b1', vendor: 'REWE', amount: 20, balance: 20, tx: [], added: 1, mt: 100 };
  S.vereinigeWallet('tina', { vouchers: [basis], cards: [], deleted: [] });
  S.vereinigeWallet('tina', { vouchers: [{ ...basis, balance: 15, tx: [{ id: 't1', amt: -5, ts: 1 }], mt: 100 }], cards: [], deleted: [] });
  S.vereinigeWallet('tina', { vouchers: [{ ...basis, balance: 17, tx: [{ id: 't2', amt: -3, ts: 2 }], mt: 100 }], cards: [], deleted: [] });
  const b1 = S.wallets.tina.vouchers.find(v => v.id === 'b1');
  pruefe('Buchungen zweier Geraete: 20 - 5 - 3 = 12', b1.balance === 12 && b1.tx.length === 2);
  pruefe('Vereinigtes ist juenger als beide Vorlagen', b1.mt > 100);
  const rv = { ...b1, tx: b1.tx.map(t => t.id === 't1' ? { ...t, reverted: true } : t), balance: 17, mt: b1.mt };
  S.vereinigeWallet('tina', { vouchers: [rv], cards: [], deleted: [] });
  pruefe('Rueckgaengig: 12 + 5 = 17', S.wallets.tina.vouchers.find(v => v.id === 'b1').balance === 17);

  // --- Bild aufgefuellt zaehlt NICHT als neu (kein Hin und Her)
  const c1 = { id: 'c1', vendor: 'dm', amount: 5, balance: 5, tx: [], added: 1, mt: 500, codeImg: bild('orange') };
  S.vereinigeWallet('tina', { vouchers: [c1], cards: [], deleted: [] });
  S.vereinigeWallet('tina', { vouchers: [{ ...c1, codeImg: '' }], cards: [], deleted: [] });
  const c1s = S.wallets.tina.vouchers.find(v => v.id === 'c1');
  pruefe('Bild bleibt bei bildloser Fassung', hat(c1s));
  pruefe('mt bleibt, wenn nur das Bild aufgefuellt wurde', c1s.mt === 500);

  // --- Rabattcodes (art: 'rabatt'): Felder ueberleben Abgleich, kein Guthaben
  const rc = { id: 'r1', art: 'rabatt', vendor: 'Lieferando', code: 'SPAR5', pin: '', rabatt: 5, rabattArt: 'eur', mbw: 15,
    amount: null, balance: null, tx: [], added: 1, mt: 10 };
  S.vereinigeWallet('tina', { vouchers: [rc], cards: [], deleted: [] });
  const r1 = () => S.wallets.tina.vouchers.find(v => v.id === 'r1');
  pruefe('Rabattcode: art, Rabatt und MBW bleiben', r1().art === 'rabatt' && r1().mbw === 15 && r1().rabatt === 5 && r1().balance === null);
  S.vereinigeWallet('tina', { vouchers: [{ ...rc, mt: 5, code: 'ALT' }], cards: [], deleted: [] });
  pruefe('Rabattcode: aeltere Fassung verliert', r1().code === 'SPAR5' && r1().art === 'rabatt');
  S.vereinigeWallet('tina', { vouchers: [{ ...rc, mt: 20, eingeloest: 123 }], cards: [], deleted: [] });
  pruefe('Rabattcode: "eingeloest" kommt an', r1().eingeloest === 123 && r1().art === 'rabatt');
  pruefe('Rabattcode steht im Index', S.walletIndex(S.wallets.tina).v.some(z => z[0] === 'r1'));
  S.vereinigeWallet('tina', { vouchers: [], cards: [], deleted: [{ id: 'r1', ts: Date.now() }] });
  pruefe('Loeschmarker entfernt den Rabattcode', !r1());

  // --- Notbremse: Vorhandenes bleibt, Neues darueber wird abgelehnt
  const viele = Array.from({ length: 1005 }, (_, i) => ({ id: 'n' + i, vendor: 'X', amount: 1, balance: 1, tx: [], added: 1 }));
  const r = S.vereinigeWallet('tina', { vouchers: viele, cards: [], deleted: [] });
  pruefe('Notbremse: vorhandene bleiben alle da', ['a1', 'b1', 'c1'].every(id => S.wallets.tina.vouchers.some(v => v.id === id)));
  pruefe('Notbremse: Rest abgelehnt und gemeldet', S.wallets.tina.vouchers.length === 1000 && r.abgelehnt.length === 8);

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(fehler ? `\n${fehler} FEHLER` : '\nAlles gruen');
  process.exit(fehler ? 1 : 0);
})();
function hat(v) { return !!(v.codeImg || v.img); }
