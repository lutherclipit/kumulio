# RabattArchiv

## iOS & Android (Capacitor)

Die Web-App ist in native Shells verpackt (`android/` und `ios/` liegen im
Repo, `npx cap sync` kopiert die Web-Assets hinein).

**Android bauen (auf diesem Windows-PC möglich):**
1. Android Studio installieren (bringt SDK + Gradle mit)
2. `npx cap open android` → in Android Studio „Run" (Gerät/Emulator) oder
   Build → APK/AAB für den Play Store
3. Vorher in `public/index.html` die Zeile `window.RA_API_BASE = ''` auf die
   URL des gehosteten Servers setzen (z. B. `https://api.rabattarchiv.de`)
   und `npx cap sync` ausführen

**iOS bauen (braucht einen Mac oder Cloud-Build):**
- Auf einem Mac: `npx cap open ios` → Xcode → Signing mit Apple-Developer-
  Account (99 €/Jahr) → Run/Archive für den App Store
- Ohne Mac: Cloud-Build-Dienst (z. B. Codemagic oder Ionic Appflow) mit
  diesem Repo verbinden — die bauen und signieren iOS in der Cloud

**Backend hosten (Voraussetzung für die Apps):**
Der Server ist dependency-frei (`node server.js`) und läuft überall, wo Node
läuft (Railway, Render, Hetzner-VPS …). CORS ist bereits offen, die App
spricht den Server über `RA_API_BASE` an. Vorher: echte Turnstile-Keys
(im Admin-Panel eintragbar) und HTTPS.

Prototyp der Spar-Community-App: Deals landen automatisch wie in einem
WhatsApp-Kanal im Feed — aber nur aus Kanälen, denen man folgt. Die Community
kommentiert; posten kann sie nur in Community-Kanälen (mit Scam-Filter und
„Auf eigene Gefahr"-Hinweis).

## Starten

Doppelklick auf `start.bat` — öffnet http://localhost:3900 (Node muss
installiert sein, keine weiteren Abhängigkeiten).

## Was drin ist

- **Design**: iOS-Glass-Look — echtes Milchglas (backdrop-blur) über farbigem
  Verlaufs-Untergrund, SVG-Symbole statt Emojis, schwebende Glas-Tabbar unten
  (Shorts | Feed | Chats), Dynamic-Island-artige Statuskapsel oben,
  Apple-Federkurven; Tab-Wechsel gleiten seitlich rüber statt zu springen.
  Feed auf 40 Karten begrenzt, damit das Glas flüssig bleibt.
- **Menü**: Feed links, Chats in der Mitte, Shorts rechts; die schwarze
  Pille gleitet mit Feder-Physik zum aktiven Tab. Kanäle & Filter sitzen oben
  rechts (Slider-Symbol), die Merkliste daneben (goldener Stern).
- **Ersparnis auf einen Blick**: Badges auf jeder Karte — „−X %" (aus
  „statt X €" oder „X % Rabatt" geparst, ab 50 % mit Flammen + Funken-Burst
  beim Antippen), „GRATIS", „+ VERDIENST", durchgestrichener Vorher-Preis.
  Preisfehler bekommen ein Glitch-Badge, einen roten Live-Zähler (wie lange
  es den Deal schon gibt) und eine rote Kante. Das Deal-Sheet ist fast
  Vollbild (Safe-Area der Dynamic Island beachtet) und lässt sich mit
  Runterwischen schließen.
- **Abgelaufen-Logik**: echte Ablaufzeiten liefert das RSS nicht, deshalb
  Heuristik — älter als 36 h fliegt aus dem Feed, Preisfehler > 12 h bzw.
  Deals > 24 h werden ausgegraut als „VERMUTLICH VORBEI" markiert und
  rutschen in „Beliebt" ans Ende.
- **Feed-Menüs (Chips)**: Beliebt (sortiert nach Like-Saldo) – dann die vom
  Nutzer **angehefteten** Kanäle (Standard: Preisfehler, Freebies, Deals) –
  Rest hinter „Mehr" ausklappbar (inkl. „Neu" = chronologisch). Anheften läuft
  über das Pin-Symbol im Kanäle-Sheet.
- **Deal-Sheet**: Bilder-Galerie zum Durchswipen (Scroll-Snap, mehrere Bilder
  aus dem Feed geparst), „zum Deal →"-Button (auch direkt auf jeder Karte),
  Vorher/Jetzt-Balken aus dem „statt"-Preis, prominente Beschreibung,
  Regeln & Richtlinien ausklappbar vor den Kommentaren. Schließen: Runterziehen
  an der Greifzone oben (touch-action: none, funktioniert auch in Chrome
  mobil) **oder** der schwarze Button unten rechts auf Daumenhöhe.
- **Kartenlayout**: Preis + durchgestrichener Vergleichspreis (der
  nächstliegende bekannte Preis aus den Deal-Angaben) oben, Händler unten
  links, „zum Deal" unten rechts.
- **Echter Marktpreisvergleich (billiger.de)**: idealo und geizhals blocken
  Server-Anfragen (403); billiger.de liefert die Suche serverseitig gerendert.
  `/api/compare?q=&p=&u=` — `u` ist der **direkte Produktlink des Deals**:
  der Server holt dort das og:title und identifiziert das Produkt präziser als
  über den Deal-Titel (Amazon & Co. blocken teils → Fallback Titel). Gewählt
  wird der Vergleichspreis, der **dem Deal-Preis am nächsten liegt** (richtige
  Variante statt Combo/Zubehör), dann wird die Produktseite nachgeladen und
  das **billigste Gesamtangebot inkl. Versandkosten** berechnet
  (`shippingIncluded`). Findet die Suche nichts mehr, wird der **zuletzt
  bekannte Preis** gezeigt („zuletzt X"). 12 h-Cache, 800 ms-Drossel, nur
  echte Produkte, Plausibilitätsfenster 0,5×–5×. Banner: durchgestrichener
  Marktpreis neben dem Deal-Preis; Sheet: Balken + exakte Vergleichsseite.
- **Vergleichspreis-Pflicht bei eigenen Posts**: Wer im Community-Kanal einen
  Preis angibt, muss auch einen Vergleichspreis angeben (Server erzwingt das).
  Im Composer gibt es „mit billiger.de prüfen" — bestätigt die Angabe (±20 %)
  und vergibt das „geprüft"-Badge; optional Enddatum fürs Ablaufen.
- **mydealz-artige Banner**: linke Spalte mit Vote-Pille (±Saldo, farbig),
  Bild, Kommentar-Zahl + Merken-Stern; rechts Zeit-Pill, roter
  **Live-Countdown** („Läuft ab in 1t 4h 45m 13s", geparst aus „bis DD.MM."/
  „nur heute" bzw. vom Ersteller gesetzt), Teilen-Button (Web Share API,
  Fallback Zwischenablage), Titel, Preis + Vergleichspreis + Badges,
  „Verfügbar bei Händler", Voll-CTA „zum Deal".
- **Feeds wie bei mydealz**: Für dich (lernt lokal aus Klicks/Likes/Merken je
  Kanal & Händler), Beliebt (Likes+Klicks+Kommentare), Trending
  (Interaktionen pro Stunde), Alles (chronologisch) + angeheftete Kanäle.
  Klicks zählt `POST /api/click`.
- **Tabbar**: Anmelden/Profil (unten links, Platzhalter mit Gast-Profil) |
  Feed | Chats | grüner „+"-Button (öffnet den Composer mit Kanalwahl).
  Shorts vorerst raus. Logo (flaches %-Zeichen: Ordner + €-Münze, ohne
  Hintergrund) klickt zurück zum „Für dich"-Feed; daneben die Suchleiste
  (Live-Filter über Titel + Händler).
- **Chips oben**: nur „Für dich", „Gratis", „Preisfehler" + Menü-Chip.
  Im Menü lassen sich Feeds (Beliebt/Trending/Alles) und Kanäle beliebig
  anheften. Gleitende Pille wie in der Tabbar; Karten staggern beim Wechsel.
- **Voting**: Votes groß unter dem Bild, ±1-Animation beim Klick; die
  Sortierung bleibt eingefroren, bis der Feed neu lädt (ein Dislike versenkt
  nichts sofort und zählt nur einfach). Favoriten färben die Karte golden.
- **Vergleichspreis**: expliziter „Gesamt"-Preis (inkl. Versand) von der
  billiger.de-Produktseite — Amazon/Prime-Angebote stehen dort mit 0 € Versand
  automatisch richtig drin. Gratis-Deals bekommen keinen Marktvergleich.
- **Like & Dislike statt Hot/Cold**: jede Karte hat Daumen hoch/runter
  (`data/ratings.json`, ein Vote pro Gerät, umstimmbar). Die Deal-Qualität
  füllt die Glas-Karte wie ein Glas: viel Zustimmung = grün voll, überwiegend
  Dislikes = rötlich niedrig.
- **Swipe & Merken**: Karte nach links ziehen = Deal merken. Dabei ploppt eine
  Glas-Notification auf, über die man einen Erinnerungs-Timer stellt (1 Std.,
  3 Std., morgen 9 Uhr). Erinnerungen kommen als In-App-Toast + Island, auf
  Wunsch zusätzlich als Browser-Notification. Merkliste über den Stern oben.
- **Deal-Detail wie in Cashback-Apps**: Tippen auf eine Karte öffnet ein
  Bottom-Sheet mit Beschreibung → Regeln & Richtlinien (pro Kanal) → großem
  „Zum Deal"-Button. Der Button nutzt den **direkten Händler-Link** aus der
  Deal-Beschreibung; nur wenn keiner existiert, fällt er auf die Quelle
  zurück (ehrlich beschriftet). Keine Temperaturen, kein mydealz-Look.
- **Automatische Kanäle** (niemand postet, alle kommentieren): Top-Deals,
  Preisfehler, Freebies, Cashback — echte Deals live per mydealz-RSS
  (5 Min. Cache). Fällt ein Feed aus, zeigt die App das ehrlich an statt
  Fake-Daten.
- **Community-Kanäle**: „Geld verdienen" (Referral-Codes, z. B. ShopBack) und
  „Methoden" (Spar-Tricks à la McDonald's-Methode). Nutzer können posten;
  eigene Kanäle lassen sich unter „Kanäle" erstellen.
- **Scam-Filter** (`server.js`, `moderate()`): blockiert Vorkasse,
  PayPal-Freunde, Gutschein-Handel, Geld-Verdoppler usw.; markiert
  Telegram/WhatsApp-Kontakte, externe Links und Referrals sichtbar.
  Hier würde später der KI-Moderator (Claude-API) einhaken.
- **Onboarding**: beim ersten Besuch Kanäle wählen; Follows und Nutzername
  liegen im localStorage, Kommentare/Posts/Kanäle in `data/*.json`.
- **Shorts-Tab**: Platzhalter im 9:16-Rahmen für die eigenen Spar-Videos
  (geplant).
- **Logo**: `public/logo.svg` — Explorer-Ordner mit herausragenden
  Geldscheinen und %-Badge.

## Nur noch kuratierte Inhalte (kein mydealz mehr)

- Die mydealz-RSS-Kanäle sind **komplett entfernt** — alle Inhalte postet die
  Redaktion über `/admin.html`. Kanäle: Angebote, Preisfehler, Geld verdienen,
  Methoden.
- Als Startbestand liegen **klar beschriftete Platzhalter** in „Angebote"
  (Amazon Prime Student, Spotify-Probezeit, YouTube Premium Test, Wolt- und
  Lieferando-Codes) — echte öffentliche Aktionsseiten verlinkt, keine
  erfundenen Codes/Preise; die Redaktion ersetzt die Platzhalter-Texte.
- Die Marke einer Karte wird automatisch aus dem Link abgeleitet
  (wolt.com → Wolt) oder per `merchant`-Feld gesetzt.
- Die „Top-Deals"-Kacheln (Hero) sind aus der App entfernt; der
  Kachel-Editor im Admin-Panel ist damit ohne Funktion in der App.
- Wallet: Hinzufügen läuft über **Add-Banner direkt in den Listen**
  (gestricheltes Banner mit fettem Plus statt Logo) — kein separater
  Plus-Button mehr. Bei den Sparkarten gibt es zusätzlich den Vorschlag
  „Payback-Karte verbinden" (öffnet das Formular vorausgefüllt), solange
  keine Payback-Karte angelegt ist.
- **Feed-Tabs**: **Sparen** (gratis & günstiger) · **Verdienen** (KWK-Deals,
  Referrals) · **Neukunden** (nur Aktionen für neue Kunden — getrennt vom
  Rest) · Gespeichert. „Für dich" ist entfernt.
- **Neukunden-Backend**: Posts haben ein `newCustomer`-Flag — im Admin-Panel
  per Checkbox setzbar, sonst automatische Erkennung („Neukunde",
  „Erstbestellung" … im Titel/Text). Neukunden-Deals tragen das blaue
  „NUR NEUKUNDEN"-Badge und erscheinen ausschließlich im Neukunden-Tab.
- **Navigation**: Tabbar unten = Wallet (links) · Feed (Mitte) · **Suche**
  (rechts, eigener Tab mit großem Suchfeld über alle Angebote). Chats sind
  vorerst raus. **Anmelden/Profil sitzt oben rechts** — als User-Icon,
  nach dem Login als grüner Avatar mit Initiale.
- **Fullscreen-Onboarding**: Beim ersten Start sind Splash und Tutorial ein
  Fluss — das animierte Logo (Ordner + Geldscheine) spielt, rutscht nach oben
  und begrüßt den Nutzer Schritt für Schritt (5 Steps, Punkte-Indikator).
  „Überspringen" steht bewusst dezent ganz unten; der letzte Schritt führt
  mit großem CTA zur Registrierung („Ohne Konto fortfahren" als leiser
  Zweitweg). Einmal gesehen, nie wieder (`ra.tutorialDone`).
- **Rechtliches & Newsletter**: `agb.html` und `datenschutz.html` liegen als
  klar markierte **Entwürfe** bei (vor Launch anwaltlich prüfen, Platzhalter
  füllen) und sind im Register-Popup, Onboarding-Finale und Profil verlinkt.
  Die Registrierung hat ein optionales **Newsletter-Opt-in** („keine Deals
  verpassen"), das der Server am Konto speichert (`newsletter: true`).
- **Header**: Nightmode links · Logo mittig (Klick = Home) · rechts
  Gold-Stern + Profil. Gäste sehen statt Avatar einen grünen
  **„Anmelden"-Button**; nach dem Login den Avatar mit Initiale.
- **Wallet nur mit Profil**: Gäste sehen eine Anmelde-Sperre
  („Deine Wallet braucht ein Profil"), alle Wallet-Funktionen inkl.
  Hinzufügen erfordern Login.
- **Gespeichert** ist aus dem Hauptmenü raus — nur über den Gold-Stern oben
  rechts erreichbar. Dafür gibt es den **Coupons-Tab**: Verzeichnis der
  offiziellen Coupon-Quellen, sauber unterteilt (Payback · Drogerie:
  Rossmann/Müller · Supermärkte: Lidl Plus/REWE/EDEKA/Netto · Fast Food:
  McDonald's/Burger King/Subway · IKEA · GzG). GzG zeigt passende
  Redaktions-Posts; alles andere verlinkt die offiziellen Apps/Portale.
- **Payback**: Es gibt **keine öffentliche/freie Payback-API** (nur
  geschlossene Partner-Integrationen) — die Karte bleibt daher manuell in
  der Wallet; nach dem Verbinden zeigt der Coupons-Tab den Direktlink ins
  offizielle Payback-Coupon-Center.
- **Wallet-Kontostand**: Summe aller Restguthaben oben in der Wallet,
  aktualisiert sich mit jeder Buchung.
- **Gutschein hinzufügen, Bild zuerst**: Dropzone ganz oben — Bild hochladen
  oder **Foto aufnehmen** (Kamera via `capture`). Automatische Auslese über
  Browser-Erkennung: QR/Barcode (`BarcodeDetector`) füllt Code bzw.
  Kartennummer, Texterkennung (`TextDetector`, wo verfügbar) füllt PIN, Wert
  und Shop; sonst Shop-Schnellauswahl (REWE, Amazon, Wunschgutschein …) und
  manuelle Felder. Volle KI-Auslese (Claude Vision) kommt mit dem Backend.

## Studentenrabatt-Stil & Wallet 2.0 (aktueller Stand)

- **3 Menüpunkte oben**: Für dich · Luthers Picks (Redaktions-Posts + große
  Kacheln) · Gespeichert (Merkliste als Feed, auch über den Gold-Stern oben).
- **Karten markengeführt** wie bei Studentenrabatt-Apps: farbiger Marken-Chip
  (REWE, Amazon, Wolt, Spotify … via `BRAND_COLORS`), Sterne, Titel, Badges,
  „zum Deal"-Button — kein mydealz-Layout mehr.
- **Wallet 2.0** (wie die GutscheinWallet-App): großes Plus → Sheet
  (Gutschein: Anbieter, Wert, Code + automatische Erkennung, **PIN**,
  Ablauf, **QR/Barcode-Screenshot** (komprimiert im localStorage);
  Sparkarte: Name, Nummer, Screenshot). Gutschein-Detail: Restguthaben,
  **Abbuchen/Aufladen mit Notiz**, Verlauf mit **Rückgängig**, Code/PIN
  kopieren. Aufgebrauchte Gutscheine einklappbar und revertierbar.
- **Splash-Animation** beim Öffnen: Manila-Ordner, Geldscheine steigen auf,
  %-Badge ploppt (respektiert `prefers-reduced-motion`).
- **Captcha = Cloudflare Turnstile** (echter Dienst): Widget im Login und im
  Register-Popup, Server verifiziert über `siteverify`. Standard sind die
  offiziellen **Test-Keys** (bestehen immer); für live eigene Keys unter
  dash.cloudflare.com → Turnstile anlegen und in `data/turnstile.json`
  eintragen.
- Logo: nur noch das Icon (größer), Ordner in Manila-Gelb.

## Kuratiertes Modell (statt mydealz-Forum)

- **Nur die Redaktion postet Deals** (über `/admin.html`, inkl. Link-Auslesen
  mit Auto-Preis/Vergleichspreis/Bild/Beschreibungs-Entwurf). Nutzer
  kommentieren und bewerten mit einem **Sternesystem** (1–5, wie bei
  Studentenrabatt-Apps) — Sterne füllen die Glas-Karte.
- Karten-Button „zum Deal", im Deal-Sheet „zum Produkt".
- **„Gratis einkaufen"**-Feed sammelt alles von kostenlos bis
  Geld-zurück-Garantie (ersetzt den Cashback-Chip).
- **Wallet-Tab**: Gutscheine speichern (Text einfügen → Code wird automatisch
  erkannt, regelbasiert; Kopieren-Button) und Sparkarten (Payback, Lidl Plus,
  IKEA Family …; Nummer + Kopieren, scannbarer Barcode folgt). Liegt lokal
  im Gerät (localStorage).
- **Registrierung als eigenes Popup** mit E-Mail-Pflicht; Login und
  Registrierung verlangen ein **Rechen-Captcha** (`/api/captcha`, einmalig
  gültig; echter Captcha-Dienst kommt mit dem Live-Backend).

## Backend & Admin (Prototyp-Stand)

- **Accounts**: `/api/register`, `/api/login`, `/api/logout`, `/api/me` —
  scrypt-Hash + Session-Token, Daten in `data/users.json`/`sessions.json`.
  Login/Registrieren im Profil-Tab. Nur lokal — keine echten Passwörter nutzen.
- **Link-Posten**: Im Composer Link einfügen → „Auslesen" füllt Titel, Preis,
  Bild, Händler und den Vergleichspreis (billiger.de) automatisch
  (`/api/extract`). Der Beschreibungs-Entwurf kommt nur mit Profil
  (aktuell regelbasiert erstellt; echte KI-Texte via Claude-API später).
- **Startseite**: große Redaktions-Kacheln über dem Feed (nur bei „Für dich",
  erste Kachel groß). Gepflegt über **`/admin.html`** mit dem Admin-Key aus
  `data/admin-key.txt` (steht auch in der Server-Konsole). Später soll die
  Kuration automatisiert werden (KI lernt aus den manuellen Picks).
- **Dark Mode**: Mond/Sonne-Button oben; folgt sonst der Systemeinstellung.
- **mydealz-Ausstieg**: RSS bleibt vorerst als Platzhalter-Content; der Weg
  raus ist gelegt — eigene Posts per Link + Redaktions-Startseite. Sobald
  genug eigene Kuration da ist, RSS-Kanäle abschalten.

## Offen / nächste Schritte (Roadmap)

1. **Backend & Accounts**: Registrierung, Profile, Follows/Favoriten
   serverseitig statt localStorage.
2. **Chats & Teilen**: Freunde hinzufügen, Deals mit einem Tipp in den Chat
   schicken, Nachrichten nach Dringlichkeit kategorisieren.
3. **Benachrichtigungen mit eigenem Sound pro Typ**: Als native iOS/Android-App
   machbar — iOS: pro Notification-Kategorie ein eigener Sound
   (`UNNotificationSound`, mitgelieferte Audiodatei); Android: Notification
   Channels, jeder Channel mit eigenem Sound/Vibration/Priorität. So klingt
   ein Preisfehler-Alarm anders als eine Chat-Nachricht. Im Web nur begrenzt
   möglich (Push API ohne garantierten Custom-Sound).
4. **Feed-Algorithmus**: aus Likes/Dislikes und Klicks lernen, was der Nutzer
   sehen will (die Like-Daten dafür werden schon gesammelt).
5. **User-Ranking** für die besten Deal-Scouts.
6. **Admin-Backend**: eigene Deals einpflegen statt mydealz-Platzhalter;
   später eine KI, die aus den eigenen Kurationen lernt und selbst kuratiert.
7. **Shorts-Feed** mit den eigenen Spar-Videos.
8. Rechtliches: mydealz-RSS ist Platzhalter für den Privatgebrauch; für einen
   öffentlichen Launch eigene Quellen/Kuration verwenden (siehe 6).
