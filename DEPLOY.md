# Backend hosten – Schritt für Schritt

Der Server ist dependency-frei (`node server.js`), respektiert `PORT` vom
Hoster und legt alle Daten (Nutzer, Posts, Admin-Key) in `RA_DATA_DIR` ab.
Ein `Dockerfile` liegt bei. **Wichtig:** Das Datenverzeichnis muss auf einem
persistenten Volume liegen, sonst sind Nutzer und Posts nach jedem Deploy weg.

## Weg A: Railway (empfohlen, ~5 €/Monat, mit Volume)

1. Repo zu GitHub hochladen (einmalig):
   - github.com → „New repository" → Name `rabattarchiv`, **Private** → erstellen
   - dann hier im Terminal:
     ```
     git remote add origin https://github.com/DEIN-NAME/rabattarchiv.git
     git push -u origin master
     ```
2. railway.com → mit GitHub anmelden → „New Project" → „Deploy from GitHub repo"
   → `rabattarchiv` wählen (Railway erkennt das Dockerfile automatisch)
3. Im Service: **Volume hinzufügen**, Mount-Pfad: `/data`
4. Variables prüfen: `RA_DATA_DIR=/data` (steht schon im Dockerfile)
5. Settings → Networking → „Generate Domain" → du bekommst z. B.
   `rabattarchiv-production.up.railway.app`

## Weg B: Render (Free-Tier zum Testen, Daten aber nur mit bezahltem Disk persistent)

1. Repo zu GitHub (wie oben)
2. render.com → „New Web Service" → Repo wählen → Runtime „Docker"
3. Für persistente Daten: „Disk" hinzufügen, Mount `/data` (bezahlter Plan)

## Weg C: Eigener VPS (z. B. Hetzner CX22, ~4 €/Monat, volle Kontrolle)

```
apt install -y nodejs git
git clone <repo> /opt/rabattarchiv
cd /opt/rabattarchiv
RA_DATA_DIR=/var/lib/rabattarchiv PORT=80 node server.js
```
(Dauerbetrieb über systemd-Unit oder `docker run -v /var/lib/rabattarchiv:/data -p 80:3900 …`)

## Nach dem Deploy (alle Wege gleich)

1. `https://DEINE-URL/admin.html` öffnen — der Admin-Key steht beim ersten
   Start in den Server-Logs des Hosters (oder per Shell: `/data/admin-key.txt`)
2. **Turnstile live schalten**: dash.cloudflare.com → Turnstile → Site anlegen
   (Domain = deine Hosting-Domain) → Sitekey + Secret im Admin-Panel unter
   „Einstellungen" speichern
3. **App auf den Server zeigen**: in `public/index.html`
   `window.RA_API_BASE = 'https://DEINE-URL';` setzen, dann `npx cap sync`
4. Deals posten, Startseite bestücken — fertig ist die gehostete Basis für
   die iOS/Android-Builds
