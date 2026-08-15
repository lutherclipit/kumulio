// kumulio Design-Tokens – die EINZIGE Quelle für Markenfarben, Dauern und Easings.
// Beim Port nach Native wird genau diese Datei übernommen. Nichts hardcoden.

export const brand = {
  color: {
    ink: '#14151A',
    accent: '#12C77E',
    surface: '#F6F7F8',
    paper: '#FFFFFF',
  },
  motion: {
    // Dauer in ms
    splashWordmark: 420,
    splashDotFall: 460,
    splashDotDelay: 220,
    splashHold: 320,
    splashOut: 260,
    splashMax: 1400,
    loadingCycle: 1100,
    loadingDelay: 200,
    successRipple: 620,
    hoverDot: 180,
    // Easings
    easeOut: 'cubic-bezier(0.22, 1, 0.36, 1)',    // Standard-Auftritt
    easeSettle: 'cubic-bezier(0.34, 1.42, 0.44, 1)', // leichter Overshoot, nur für den Punkt
    easeInOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
  },
  logo: {
    minWidthPx: 72, // darunter: mono-Variante verwenden
    aspect: 4.22,
  },
};

// Tokens als CSS-Variablen bereitstellen – brand.css nutzt ausschließlich diese
export function applyBrandVars(root = document.documentElement) {
  const s = root.style;
  s.setProperty('--k-ink', brand.color.ink);
  s.setProperty('--k-accent', brand.color.accent);
  s.setProperty('--k-surface', brand.color.surface);
  s.setProperty('--k-paper', brand.color.paper);
  s.setProperty('--k-splash-wordmark', brand.motion.splashWordmark + 'ms');
  s.setProperty('--k-splash-dot-fall', brand.motion.splashDotFall + 'ms');
  s.setProperty('--k-splash-dot-delay', brand.motion.splashDotDelay + 'ms');
  s.setProperty('--k-splash-out', brand.motion.splashOut + 'ms');
  s.setProperty('--k-loading-cycle', brand.motion.loadingCycle + 'ms');
  s.setProperty('--k-success-ripple', brand.motion.successRipple + 'ms');
  s.setProperty('--k-hover-dot', brand.motion.hoverDot + 'ms');
  s.setProperty('--k-ease-out', brand.motion.easeOut);
  s.setProperty('--k-ease-settle', brand.motion.easeSettle);
  s.setProperty('--k-ease-inout', brand.motion.easeInOut);
}
