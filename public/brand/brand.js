// kumulio Logo-System – eine Quelle für Wortmarke, Icon, Splash, Loader, Erfolg.
// Es bewegt sich immer nur der Punkt. Animiert wird ausschließlich transform/opacity.
// Beim Port nach Native wird nur dieses Modul neu implementiert – Aufrufstellen bleiben.

import { brand, applyBrandVars } from './tokens.js';

applyBrandVars();

// ---- Geometrie der Wortmarke (Pfade konvertiert, kein Font) ----
const VIEWBOX = '49.00 -1560.00 7086.00 1680.00';
const DOT = { cx: 5715.0, cy: -1267.5, r: 159.38 };
const LETTER_PATHS = [
  'M139.00 0.00H320.00V-520.00L811.00 0.00H1060.00L527.00 -540.00L1004.00 -1080.00H773.00L320.00 -560.00V-1440.00H140.00Z',
  'M1530.00 28.00Q1766.00 28.00 1890.00 -139.00V0.00H2049.00V-1080.00H1870.00V-511.00Q1870.00 -324.00 1788.50 -232.50Q1707.00 -141.00 1573.00 -141.00Q1459.00 -141.00 1395.50 -198.00Q1332.00 -255.00 1306.00 -346.50Q1280.00 -438.00 1280.00 -539.00V-1080.00H1100.00V-483.00Q1100.00 -406.00 1118.50 -317.50Q1137.00 -229.00 1184.50 -150.50Q1232.00 -72.00 1316.00 -22.00Q1400.00 28.00 1530.00 28.00Z',
  'M2288.00 0.00H2467.00V-686.00Q2467.00 -805.00 2531.50 -877.00Q2596.00 -949.00 2702.00 -949.00Q2808.00 -949.00 2872.00 -878.00Q2936.00 -807.00 2936.00 -684.00L2935.00 0.00H3112.00L3113.00 -686.00Q3113.00 -777.00 3147.00 -835.00Q3181.00 -893.00 3235.00 -921.00Q3289.00 -949.00 3349.00 -949.00Q3451.00 -949.00 3516.00 -880.50Q3581.00 -812.00 3581.00 -691.00L3580.00 0.00H3758.00L3759.00 -730.00Q3759.00 -903.00 3662.00 -1005.50Q3565.00 -1108.00 3396.00 -1108.00Q3289.00 -1108.00 3203.00 -1060.50Q3117.00 -1013.00 3069.00 -930.00Q3025.00 -1015.00 2944.00 -1061.50Q2863.00 -1108.00 2754.00 -1108.00Q2657.00 -1108.00 2577.50 -1069.50Q2498.00 -1031.00 2447.00 -965.00V-1080.00H2288.00Z',
  'M4389.00 28.00Q4625.00 28.00 4749.00 -139.00V0.00H4908.00V-1080.00H4729.00V-511.00Q4729.00 -324.00 4647.50 -232.50Q4566.00 -141.00 4432.00 -141.00Q4318.00 -141.00 4254.50 -198.00Q4191.00 -255.00 4165.00 -346.50Q4139.00 -438.00 4139.00 -539.00V-1080.00H3959.00V-483.00Q3959.00 -406.00 3977.50 -317.50Q3996.00 -229.00 4043.50 -150.50Q4091.00 -72.00 4175.00 -22.00Q4259.00 28.00 4389.00 28.00Z',
  'M5168.00 0.00H5346.00V-1470.00H5168.00Z',
  'M5626.00 0.00H5804.00V-1080.00H5626.00Z',
  'M6524.00 30.00Q6685.00 30.00 6801.50 -42.00Q6918.00 -114.00 6981.50 -243.00Q7045.00 -372.00 7045.00 -541.00Q7045.00 -708.00 6982.50 -836.50Q6920.00 -965.00 6803.00 -1037.50Q6686.00 -1110.00 6524.00 -1110.00Q6366.00 -1110.00 6249.00 -1038.50Q6132.00 -967.00 6068.00 -839.00Q6004.00 -711.00 6004.00 -541.00Q6004.00 -374.00 6066.50 -245.00Q6129.00 -116.00 6246.00 -43.00Q6363.00 30.00 6524.00 30.00ZM6524.00 -139.00Q6361.00 -139.00 6277.00 -248.50Q6193.00 -358.00 6193.00 -541.00Q6193.00 -718.00 6274.00 -829.50Q6355.00 -941.00 6524.00 -941.00Q6690.00 -941.00 6773.00 -832.00Q6856.00 -723.00 6856.00 -541.00Q6856.00 -363.00 6773.50 -251.00Q6691.00 -139.00 6524.00 -139.00Z',
];

export function prefersReducedMotion() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---- Wortmarke als Inline-SVG (Punkt = eigenes Element, per Klasse ansprechbar) ----
// tone 'auto': Buchstaben folgen currentColor (Ink hell / Weiß im Darkmode via CSS)
export function wordmarkHTML({ height = 26, withDot = true, withRipple = false } = {}) {
  const width = Math.round(height * brand.logo.aspect);
  // unter minWidthPx automatisch mono (ohne Akzentpunkt)
  const dot = width < brand.logo.minWidthPx ? false : withDot;
  const rippleStroke = (DOT.r * 0.28).toFixed(1);
  return `<svg class="k-wordmark" role="img" aria-label="kumulio" viewBox="${VIEWBOX}"
      width="${width}" height="${height}" fill="none">
    <g class="k-letters" fill="currentColor" aria-hidden="true">
      ${LETTER_PATHS.map(d => `<path d="${d}"/>`).join('')}
    </g>
    ${withRipple ? `<circle class="k-ripple" cx="${DOT.cx}" cy="${DOT.cy}" r="${DOT.r}"
      fill="none" stroke="var(--k-accent)" stroke-width="${rippleStroke}" aria-hidden="true"/>` : ''}
    ${dot ? `<circle class="k-dot" cx="${DOT.cx}" cy="${DOT.cy}" r="${DOT.r}" fill="var(--k-accent)" aria-hidden="true"/>` : ''}
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

// ---- Splash: der Punkt fällt wie eine Münze – einmal pro Session ----
let appReadyResolve = null;
const appReadyPromise = new Promise(r => { appReadyResolve = r; });
export function appReady() { appReadyResolve?.(); }

export function runSplash() {
  if (sessionStorage.getItem('k.splashShown')) return;
  sessionStorage.setItem('k.splashShown', '1');

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
    if (!reduced) el.querySelector('.k-dot')?.classList.add('k-pulse');
    else el.querySelector('.k-dot')?.classList.add('k-static');
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
