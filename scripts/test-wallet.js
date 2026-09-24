// Tests fuer den Wallet-Kern am Server: Bildablage, Aufraeumen, Vereinigen,
// Verschenken (auch Rabattcodes) — dazu der Burger-King-PDF-Beobachter.
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
// Fuer den Burger-King-Test: eine schon abgelegte (alte) PDF
fs.writeFileSync(path.join(DIR, 'bk-coupons.pdf'), '%PDF-1.4 alt' + ' '.repeat(2000));
fs.writeFileSync(path.join(DIR, 'bk-coupons.json'), JSON.stringify({ gueltigBis: '2026-09-01', groesse: 2012, hash: 'alt', geprueft: 1, seiten: [] }));
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

  // --- Rabattcodes verschenken: bleiben Rabattcode (gesaeubert wie beim
  // Anlegen), nie mit Notiz; eingeloest, abgelaufen oder doppelt nicht
  const rc1 = { id: 'rc1', art: 'rabatt', vendor: 'Lieferando', code: ' SPAR 10 ', pin: '9', rabatt: 10, rabattArt: 'pct', mbw: 15,
    amount: 50, balance: 50, tx: [], added: T, mt: T, notiz: 'PRIVAT R', end: '2099-12-31', eingeloest: 0 };
  S.vereinigeWallet('nora', { vouchers: [rc1], cards: [], deleted: [] });
  a = await api('tokNora', '/api/gift/send', { to: 'otto', id: 'rc1', voucher: rc1, msg: 'Guten Hunger' });
  pruefe('Rabattcode verschenken geht', a.status === 200);
  const rg = S.gifts.otto.find(g => g.giftOrigId === 'rc1');
  pruefe('Geschenk bleibt Rabattcode (Art, Rabatt, Einheit, MBW)', !!rg && rg.art === 'rabatt' && rg.rabatt === 10 && rg.rabattArt === 'pct' && rg.mbw === 15);
  pruefe('Rabattcode-Geschenk: kein Guthaben, keine PIN, Code ohne Leerzeichen, keine Notiz',
    !!rg && rg.amount === null && rg.balance === null && rg.pin === '' && rg.code === 'SPAR10' && !('notiz' in rg));
  pruefe('Rabattcode ist beim Absender weg (mit Loeschmarker)',
    !S.wallets.nora.vouchers.some(v => v.id === 'rc1') && S.wallets.nora.deleted.some(t => t.id === 'rc1'));
  a = await api('tokNora', '/api/gift/send', { to: 'otto', id: 'rc1', voucher: rc1 });
  pruefe('Derselbe Rabattcode geht kein zweites Mal raus', a.status === 404);
  const rc2 = { ...rc1, id: 'rc2', code: 'WEG2', eingeloest: T - 1000, notiz: '' };
  const rc3 = { ...rc1, id: 'rc3', code: 'ALT3', end: '2020-01-01', notiz: '' };
  S.vereinigeWallet('nora', { vouchers: [rc2, rc3], cards: [], deleted: [] });
  a = await api('tokNora', '/api/gift/send', { to: 'otto', id: 'rc2', voucher: rc2 });
  pruefe('Eingeloester Rabattcode wird abgelehnt und bleibt', a.status === 400 && S.wallets.nora.vouchers.some(v => v.id === 'rc2'));
  a = await api('tokNora', '/api/gift/send', { to: 'otto', id: 'rc3', voucher: rc3 });
  pruefe('Abgelaufener Rabattcode wird abgelehnt und bleibt', a.status === 400 && S.wallets.nora.vouchers.some(v => v.id === 'rc3'));
  // Liegt derselbe Code beim Freund schon (hier: als wartendes Geschenk), ginge er nur verloren
  const rc4 = { ...rc1, id: 'rc4', code: 'spar10', notiz: '' };
  S.vereinigeWallet('nora', { vouchers: [rc4], cards: [], deleted: [] });
  a = await api('tokNora', '/api/gift/send', { to: 'otto', id: 'rc4', voucher: rc4 });
  pruefe('Doppelter Code beim Freund wird abgelehnt und bleibt', a.status === 409 && S.wallets.nora.vouchers.some(v => v.id === 'rc4'));
  a = await api('tokOtto', '/api/gift/claim', { ids: [rg.id] });
  const rw = S.wallets.otto.vouchers.find(v => v.giftOrigId === 'rc1');
  pruefe('Ausgepackt: Rabattcode in der Wallet, Geschenk von nora',
    a.status === 200 && !!rw && rw.art === 'rabatt' && rw.giftFrom === 'nora' && rw.rabatt === 10 && rw.balance === null);
  a = await api('tokOtto', '/api/gift/claim', { ids: [rg.id] });
  pruefe('Zweites Auspacken bucht nichts doppelt',
    a.status === 200 && a.j.claimed.length === 0 && S.wallets.otto.vouchers.filter(v => v.giftOrigId === 'rc1').length === 1);

  // --- Burger-King-PDF: Eintrag auf der Seite finden, Datum lesen, Vorschau bauen
  const seite = `<title>Burger King Gutscheine - gültig bis 6. November 2026</title>
    <span class="anchor" id="voucher-57712"></span><div class="voucher-title"><a data-voucher-url="184-57712">King des Monats</a></div>
    <span class="anchor" id="voucher-68222"></span><div class="d-flex"><div class="voucher-title">
    <a class="voucher-modal-link-alternative" data-voucher-url="184-68222" data-id="68222"> ⭐ Aktuell verfügbare Burger King Gutscheine (PDF) ⭐ </a></div>
    <div class="voucer-subtitle"> gültig bis 06.11.2026 --- in allen teilnehmenden Restaurants </div></div>`;
  const e = S.bkSeiteLesen(seite);
  pruefe('BK: PDF-Eintrag gefunden (nicht der erste Gutschein)', !!e && e.ziel === '184-68222' && /PDF/.test(e.titel) && !/⭐/.test(e.titel));
  pruefe('BK: gueltig bis aus dem Untertitel', !!e && e.gueltigBis === '2026-11-06');
  pruefe('BK: ohne PDF-Eintrag kein Treffer', S.bkSeiteLesen('<span class="anchor" id="voucher-1"></span><div class="voucher-title"><a data-voucher-url="1-1">Whopper</a></div>') === null);
  const bezug = new Date('2026-09-25T12:00:00Z');
  pruefe('BK: Datum "6. November" ohne Jahr', S.bkDatumLesen('Burger King Coupons bis 6. November', bezug) === '2026-11-06');
  pruefe('BK: Datum im Januar zaehlt ins naechste Jahr', S.bkDatumLesen('bis 8. Januar', new Date('2026-12-20T12:00:00Z')) === '2027-01-08');
  pruefe('BK: unmoegliches Datum ergibt nichts', S.bkDatumLesen('bis 31.02.2026', bezug) === '');
  // Kleine PDF von Hand: eine Seite, ein 2x2-Bild (Flate mit PNG-Praediktor)
  const zlib = require('zlib');
  const pixel = zlib.deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]));
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
      + '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'
      + '3 0 obj\n<< /Type /Page /MediaBox [0 0 100 100] /Resources << /XObject << /Im1 4 0 R >> >> >>\nendobj\n'
      + `4 0 obj\n<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /Columns 2 >> /Length ${pixel.length} >>\nstream\n`, 'latin1'),
    pixel,
    Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
  ]);
  const bilder = S.pdfSeitenBilder(pdf);
  pruefe('BK: Vorschau aus der PDF (PNG, 2x2)', bilder.length === 1 && bilder[0] && bilder[0].typ === 'image/png'
    && bilder[0].w === 2 && bilder[0].h === 2 && bilder[0].daten.subarray(1, 4).toString() === 'PNG');
  // Sauber schliessen und kurz warten: laeuft beim process.exit noch Arbeit im
  // Hintergrund (Verbindungen, Dateien), stuerzt libuv unter Windows ab
  S.server.closeAllConnections();
  await new Promise(ok => S.server.close(ok));
  await new Promise(ok => setTimeout(ok, 300));

  // --- Burger-King-Beobachter mit nachgebautem Netz: Fehler lassen die alte
  // Datei liegen, eine neue PDF (nur ueber einfach-sparsam) ersetzt sie
  const echtFetch = globalThis.fetch;
  const eintrag = '<span class="anchor" id="voucher-9"></span><div class="voucher-title"><a data-voucher-url="184-9">Burger King Gutscheine (PDF)</a></div>'
    + '<div class="voucer-subtitle">gültig bis 04.12.2026</div>';
  globalThis.fetch = async () => new Response('<title>ohne</title>', { status: 200 });
  pruefe('BK: Seite ohne PDF-Eintrag -> alte Datei bleibt', await S.bkPruefen({ sofort: true }) === false && S.bkOeffentlich().version === 'alt');
  globalThis.fetch = async u => String(u).includes('ausdrucken') ? new Response(eintrag, { status: 200 })
    : new Response('', { status: 302, headers: { location: 'https://anderswo.example/x.pdf' } });
  pruefe('BK: Weiterleitung auf fremde Seite wird nicht geholt', await S.bkPruefen({ sofort: true }) === false && S.bkOeffentlich().version === 'alt');
  pruefe('BK: nach Fehlern nicht gleich wieder faellig', await S.bkPruefen() === false);
  // (aufgefuellt: eine echte PDF ist nie nur ein paar hundert Bytes gross)
  const bkPdf = Buffer.concat([pdf, Buffer.from('%' + '-'.repeat(1200) + '\n', 'latin1')]);
  globalThis.fetch = async u => {
    u = String(u);
    if (u.includes('ausdrucken')) return new Response(eintrag, { status: 200 });
    if (u.includes('gehe-zu-184-9')) return new Response('', { status: 302, headers: { location: '/media/7' } });
    if (u.endsWith('/media/7')) return new Response('', { status: 302, headers: { location: 'https://www.einfach-sparsam.de/storage/media-file/BK bis 4. Dezember.pdf' } });
    if (u.includes('media-file')) return new Response(bkPdf, { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': String(bkPdf.length) } });
    return new Response('', { status: 404 });
  };
  const neuGeladen = await S.bkPruefen({ sofort: true });
  const bk = S.bkOeffentlich();
  pruefe('BK: neue PDF ersetzt die alte (gueltig bis, Vorschau)', neuGeladen === true && bk.da && bk.version !== 'alt'
    && bk.gueltigBis === '2026-12-04' && bk.seiten.length === 1 && fs.readFileSync(path.join(DIR, 'bk-coupons.pdf')).equals(bkPdf));
  globalThis.fetch = echtFetch;

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(fehler ? `\n${fehler} FEHLER` : '\nAlles gruen');
  process.exit(fehler ? 1 : 0);
})();
function hat(v) { return !!(v.codeImg || v.img); }
