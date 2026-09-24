// Tests fuer den Wallet-Kern am Server: Bildablage, Aufraeumen, Vereinigen.
// Laeuft in einem leeren Datenordner, fasst echte Daten nie an:
//   node scripts/test-wallet.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kumulio-test-'));
process.env.RA_DATA_DIR = DIR;
process.env.RA_TEST = '1';
// Fuer den Geschenk-Test: zwei befreundete Konten mit Sitzung, dazu ein
// Alt-Geschenk, das (wie vor Runde 118) noch eine private Notiz traegt
const freund = f => ({ hash: 'x', salt: 'y', ts: 1, profile: { bio: '', publicProfile: true, friends: [f] } });
fs.writeFileSync(path.join(DIR, 'users.json'), JSON.stringify({ nora: freund('otto'), otto: freund('nora') }));
fs.writeFileSync(path.join(DIR, 'sessions.json'), JSON.stringify({ tokNora: 'nora', tokOtto: 'otto' }));
fs.writeFileSync(path.join(DIR, 'gifts.json'), JSON.stringify({ otto: [{ id: 'alt1', vendor: 'dm', amount: 5, balance: 5, tx: [], notiz: 'PRIVAT alt', giftFrom: 'nora', giftTs: 1 }] }));
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

  // --- Verschenken: die private Notiz geht nie mit, egal welche Fassung gewinnt
  pruefe('Alt-Geschenk verliert die Notiz beim Start', S.gifts.otto.length === 1 && !('notiz' in S.gifts.otto[0]));
  await new Promise(ok => S.server.listen(0, '127.0.0.1', ok));
  const basis2 = `http://127.0.0.1:${S.server.address().port}`;
  const api = async (tok, p, body) => {
    const a = await fetch(basis2 + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
    return { status: a.status, j: await a.json().catch(() => null) };
  };
  const T = Date.now();
  const g1 = { id: 'g1', vendor: 'REWE', code: 'R-1', amount: 25, balance: 25, tx: [], added: T - 60000 };
  // Am Konto liegt die Fassung MIT Notiz und neuerem mt (anderes Geraet), das
  // schenkende Geraet kennt die Notiz noch nicht -> die Kontofassung gewinnt
  S.vereinigeWallet('nora', { vouchers: [{ ...g1, mt: T - 1000, notiz: 'PRIVAT 1' }], cards: [], deleted: [] });
  let a = await api('tokNora', '/api/gift/send', { to: 'otto', id: 'g1', voucher: { ...g1, mt: T - 5000 } });
  pruefe('Geschenk mit Notiz nur am Konto geht raus', a.status === 200);
  // Altes Geraet oder direkter API-Aufruf: die Notiz kommt gleich mit
  const g2 = { id: 'g2', vendor: 'Lidl', code: 'L-2', amount: 10, balance: 10, tx: [], added: T, mt: T, notiz: 'PRIVAT 2' };
  S.vereinigeWallet('nora', { vouchers: [g2], cards: [], deleted: [] });
  a = await api('tokNora', '/api/gift/send', { to: 'otto', id: 'g2', voucher: g2 });
  pruefe('Geschenk mit mitgeschickter Notiz geht raus', a.status === 200);
  const neu = S.gifts.otto.filter(g => g.giftOrigId === 'g1' || g.giftOrigId === 'g2');
  pruefe('im Geschenk-Vorrat keine Notiz', neu.length === 2 && neu.every(g => !('notiz' in g)));
  const w = await api('tokOtto', '/api/wallet');
  pruefe('Empfaenger bekommt keine Notiz (GET /api/wallet)', w.j.gifts.length === 3 && w.j.gifts.every(g => !('notiz' in g)));
  // Liegt doch eines mit Notiz im Vorrat: beim Auspacken bleibt sie draussen
  S.gifts.otto.push({ id: 'alt2', vendor: 'dm', amount: 5, balance: 5, tx: [], notiz: 'PRIVAT 3', giftFrom: 'nora', giftTs: T });
  a = await api('tokOtto', '/api/gift/claim', { ids: [...w.j.gifts.map(g => g.id), 'alt2'] });
  pruefe('nach dem Auspacken keine Notiz', a.status === 200 && a.j.vouchers.length === 4
    && a.j.vouchers.every(v => !('notiz' in v)) && S.wallets.otto.vouchers.every(v => !('notiz' in v)));
  // Sauber schliessen und kurz warten: laeuft beim process.exit noch Arbeit im
  // Hintergrund (Verbindungen, Dateien), stuerzt libuv unter Windows ab
  S.server.closeAllConnections();
  await new Promise(ok => S.server.close(ok));
  await new Promise(ok => setTimeout(ok, 300));

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(fehler ? `\n${fehler} FEHLER` : '\nAlles gruen');
  process.exit(fehler ? 1 : 0);
})();
function hat(v) { return !!(v.codeImg || v.img); }
