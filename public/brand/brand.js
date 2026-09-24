// kumulio Logo-System – eine Quelle für Wortmarke, Icon, Splash, Loader, Erfolg.
// Wortmarke: Buchstaben springen ein, Münzen fallen, Funken blitzen; im Ruhezustand
// funkeln nur die Funken. Animiert wird ausschließlich transform/opacity.
// Beim Port nach Native wird nur dieses Modul neu implementiert – Aufrufstellen bleiben.

import { brand, applyBrandVars } from './tokens.js';

applyBrandVars();

// ---- Geometrie der Wortmarke (Entwurf 24.09.2026) ----
// Runde Striche statt Font: jeder Buchstabe ein eigener Pfad (einzeln animierbar),
// dazu zwei Muenzen und zwei Funken. Statische Fassung: /brand/kumulio-logo.svg
const VIEWBOX = '110 118 1810 450';
const STRICH = 94;
const BUCHSTABEN = [
  'M168 226V500M318 338L204 420L318 500',                                    // k
  'M418 347V428.5A74.5 74.5 0 0 0 567 428.5V347M567 428V503',                // u
  'M667 347V503M667 415A72.5 72.5 0 0 1 812 415V503M812 415A72.5 72.5 0 0 1 957 415V503', // m
  'M1062 347V423A80 80 0 0 0 1222 423V347M1222 423V503',                     // u
  'M1331 229V503',                                                           // l
  'M1446 347V503',                                                           // i
];
const FUNKE = 'M0-1Q.13-.13 1 0Q.13 .13 0 1Q-.13 .13-1 0Q-.13-.13 0-1Z';
// Muenze: Rand (dunkler) + Flaeche + Innenring; gekippt ueber rotate
function muenzeSvg(x, y, grad, rx, ry, dicke, glanz) {
  return `<g transform="translate(${x} ${y}) rotate(${grad})">
      <ellipse cy="${dicke}" rx="${rx}" ry="${ry}" fill="#F29A00"/>
      <rect x="${-rx}" width="${rx * 2}" height="${dicke}" fill="#F29A00"/>
      <ellipse rx="${rx}" ry="${ry}" fill="#FFC21F"/>
      <ellipse rx="${Math.round(rx * .72)}" ry="${Math.round(ry * .68)}" fill="#FFCD3C" stroke="#F7AC00" stroke-width="${Math.round(rx / 10)}"/>
      ${glanz ? `<path d="M${-Math.round(rx * .55)} ${-Math.round(ry * .38)}A${Math.round(rx * .72)} ${Math.round(ry * .68)} 0 0 1 ${Math.round(rx * .25)} ${-Math.round(ry * .65)}" fill="none" stroke="#FFE58A" stroke-width="8" stroke-linecap="round"/>` : ''}
    </g>`;
}

export function prefersReducedMotion() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---- Wortmarke als Inline-SVG ----
// Buchstaben folgen currentColor (Markenblau per CSS, Weiss auf farbigem Grund);
// Muenzen und Funken bleiben immer gold. Klassen fuer die Animation:
// .k-l (Buchstabe, --i = Reihenfolge), .k-mz1/.k-mz2 (Muenzen), .k-fk1/.k-fk2 (Funken)
// withDot bleibt als Schalter: false = nur Buchstaben (sehr kleine Groessen)
export function wordmarkHTML({ height = 26, withDot = true, withRipple = false } = {}) {
  const width = Math.round(height * brand.logo.aspect);
  const gold = width < brand.logo.minWidthPx ? false : withDot;
  return `<svg class="k-wordmark" role="img" aria-label="kumulio" viewBox="${VIEWBOX}"
      width="${width}" height="${height}" fill="none">
    <g class="k-letters" aria-hidden="true">
      <g fill="none" stroke="currentColor" stroke-width="${STRICH}" stroke-linecap="round" stroke-linejoin="round">
        ${BUCHSTABEN.map((d, i) => `<path class="k-l" style="--i:${i}" d="${d}"/>`).join('')}
        <circle class="k-l" style="--i:6" cx="1645" cy="424" r="91"/>
      </g>
      <circle class="k-l k-ipunkt" style="--i:5" cx="1446" cy="231" r="51" fill="currentColor"/>
    </g>
    ${gold ? `<g class="k-gold" aria-hidden="true">
      ${withRipple ? `<circle class="k-ripple" cx="1775" cy="222" r="84" fill="none" stroke="#FFC400" stroke-width="22"/>` : ''}
      <g class="k-mz k-mz1">${muenzeSvg(1775, 217, -40, 80, 57, 16, true)}</g>
      <g class="k-mz k-mz2">${muenzeSvg(1845, 366, 40, 62, 45, 14, false)}</g>
      <path class="k-strich" d="M1846 283L1880 263" stroke="#FFC400" stroke-width="22" stroke-linecap="round"/>
      <g class="k-fk k-fk1"><path transform="translate(1641 206) scale(62 66)" d="${FUNKE}" fill="#FFC400" stroke="#FFC400" stroke-width=".14" stroke-linejoin="round"/></g>
      <g class="k-fk k-fk2"><path transform="translate(1832 492) scale(52 56)" d="${FUNKE}" fill="#FFC400" stroke="#FFC400" stroke-width=".14" stroke-linejoin="round"/></g>
    </g>` : ''}
  </svg>`;
}

export function mountWordmark(el, opts = {}) {
  if (!el) return;
  el.innerHTML = wordmarkHTML(opts);
  return el.firstElementChild;
}

// ---- App-Icon „k." (eigener, breiterer k-Schnitt als in der Wortmarke) ----
const ICON_K_PATH = 'M139.00 0.00H352.00V-520.00L804.00 0.00H1088.00L594.00 -540.00L1042.00 -1080.00H776.00L352.00 -560.00V-1440.00H140.00Z';

export function iconHTML({ size = 60 } = {}) {
  return `<svg role="img" aria-label="kumulio" viewBox="0 0 512 512" width="${size}" height="${size}">
    <rect width="512" height="512" rx="122.9" ry="122.9" fill="var(--k-ink)"/>
    <g transform="translate(112.99,396.80) scale(0.19556)" fill="var(--k-paper)" aria-hidden="true">
      <path d="${ICON_K_PATH}"/>
    </g>
    <circle cx="358.4" cy="325.1" r="36.9" fill="var(--k-accent)" aria-hidden="true"/>
  </svg>`;
}

// ---- Splash: Buchstaben springen ein, die Münzen fallen – bei jedem App-Start ----
let appReadyResolve = null;
const appReadyPromise = new Promise(r => { appReadyResolve = r; });
export function appReady() { appReadyResolve?.(); }

export function runSplash() {
  const el = document.createElement('div');
  el.className = 'k-splash';
  el.setAttribute('role', 'presentation');
  el.innerHTML = `<div class="k-splash-mark">${wordmarkHTML({ height: 44 })}</div>`;
  document.body.appendChild(el);

  const m = brand.motion;
  const reduced = prefersReducedMotion();
  const hide = () => {
    el.classList.add('k-out');
    setTimeout(() => el.remove(), m.splashOut + 60);
  };

  if (reduced) {
    // Pflicht: keine Animationen – fertige Wortmarke zeigen, nach 400 ms weg
    setTimeout(hide, 400);
    return;
  }

  el.classList.add('k-anim-splash');
  const animDone = new Promise(r =>
    setTimeout(r, m.splashDotDelay + m.splashDotFall + m.splashHold));
  // App lädt im Hintergrund: weg, sobald Animation durch UND App bereit –
  // hart gedeckelt bei splashMax
  const cap = new Promise(r => setTimeout(r, m.splashMax));
  Promise.race([Promise.all([animDone, appReadyPromise]), cap]).then(hide);
}

// ---- Ladezustand: der Punkt ersetzt den Spinner ----
// createLoader() zeigt erst nach loadingDelay (200 ms) – schnelle Loads blitzen nicht.
export function createLoader(host, { mode = 'inline' } = {}) {
  if (!host) return { done() { } };
  const el = document.createElement('div');
  el.className = mode === 'fullscreen' ? 'k-loader k-loader-full' : 'k-loader k-loader-inline';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  const reduced = prefersReducedMotion();
  if (mode === 'fullscreen') {
    // Drei Punkte – kumulieren: sich ansammeln
    el.innerHTML = `
      ${[0, 1, 2].map(i => `<span class="k-dot-solo ${reduced ? 'k-static' : 'k-pulse'}"
        style="animation-delay:${Math.round(i * brand.motion.loadingCycle / 3)}ms"></span>`).join('')}
      <span class="k-sr">Lädt</span>`;
  } else {
    el.innerHTML = `${wordmarkHTML({ height: 22 })}<span class="k-sr">Lädt</span>`;
    el.querySelector('.k-wordmark')?.classList.add(reduced ? 'k-static' : 'k-laedt');
  }
  let shown = false;
  const t = setTimeout(() => { shown = true; host.appendChild(el); }, brand.motion.loadingDelay);
  return {
    done() {
      clearTimeout(t);
      if (shown) el.remove();
    },
  };
}

// ---- Erfolgs-Moment: der Punkt quittiert (einmal, kein Konfetti) ----
export function successMarkHTML() {
  const r = 9;
  const stroke = (r * 0.28).toFixed(1);
  return `<span class="k-success" aria-hidden="true">
    <svg viewBox="0 0 48 48" width="22" height="22">
      <circle class="k-ripple" cx="24" cy="24" r="${r}" fill="none"
        stroke="var(--k-accent)" stroke-width="${stroke}"/>
      <circle class="k-dot" cx="24" cy="24" r="${r}" fill="var(--k-accent)"/>
    </svg>
  </span>`;
}

export function playSuccess(scopeEl) {
  const el = scopeEl?.querySelector?.('.k-success') || scopeEl;
  if (!el) return;
  if (prefersReducedMotion()) return; // Erfolg trägt der Text – Pflicht
  el.classList.remove('k-go');
  void el.offsetWidth; // Animation neu starten
  el.classList.add('k-go');
}

export { brand };
