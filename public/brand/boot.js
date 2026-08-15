// kumulio Boot: Marke initialisieren, Header bestücken, Splash starten.
// app.js greift zur Laufzeit über window.KBrand auf Loader/Erfolg zu.

import * as KBrand from './brand.js';

window.KBrand = KBrand;
window.__kbrandResolve?.(KBrand);

// Header: Wortmarke statisch, ~26 px, Klick geht zur Startseite (aria im Button)
KBrand.mountWordmark(document.getElementById('brand-wordmark'), { height: 26 });

// Onboarding (Erstnutzer): Wortmarke groß, der Punkt fällt dort als Markenmoment
const obLogo = document.getElementById('ob-logo');
if (obLogo) {
  KBrand.mountWordmark(obLogo, { height: 40 });
  if (!localStorage.getItem('ra.tutorialDone') && !KBrand.prefersReducedMotion()) {
    obLogo.classList.add('k-anim-splash');
    sessionStorage.setItem('k.splashShown', '1'); // kein zweiter Splash in dieser Session
  }
}

// Splash nur, wenn kein Onboarding ansteht (das Onboarding hat den Markenmoment)
if (localStorage.getItem('ra.tutorialDone')) {
  KBrand.runSplash();
}
