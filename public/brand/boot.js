// kumulio Boot: Marke initialisieren, Header bestücken, Splash starten.
// app.js greift zur Laufzeit über window.KBrand auf Loader/Erfolg zu.

import * as KBrand from './brand.js';

window.KBrand = KBrand;
window.__kbrandResolve?.(KBrand);

// Header: Wortmarke ~26 px, Klick geht zur Startseite (aria im Button).
// Im Ruhezustand funkeln die Funken; Antippen laesst die Muenzen einmal drehen.
const kopfLogo = KBrand.mountWordmark(document.getElementById('brand-wordmark'), { height: 26 });
if (kopfLogo && !KBrand.prefersReducedMotion()) {
  kopfLogo.classList.add('k-lebt');
  kopfLogo.closest('button, a, .brand')?.addEventListener('pointerdown', () => {
    kopfLogo.classList.remove('k-klick');
    void kopfLogo.getBoundingClientRect(); // Animation neu starten
    kopfLogo.classList.add('k-klick');
  }, { passive: true });
  kopfLogo.addEventListener('animationend', e => {
    if (e.animationName === 'k-dreh' && e.target.closest?.('.k-mz2')) kopfLogo.classList.remove('k-klick');
  });
}

// Onboarding (Erstnutzer): Wortmarke groß, der Punkt fällt dort als Markenmoment
const obLogo = document.getElementById('ob-logo');
if (obLogo) {
  KBrand.mountWordmark(obLogo, { height: 40 });
  if (!localStorage.getItem('ra.tutorialDone') && !KBrand.prefersReducedMotion()) {
    obLogo.classList.add('k-anim-splash');
  }
}

// Splash nur, wenn kein Onboarding ansteht (das Onboarding hat den Markenmoment).
// Der Boot-Deckel (index.html) verhindert, dass der Feed vor dem Splash durchblitzt –
// er fällt erst, wenn Splash bzw. Onboarding übernommen haben.
const bootCover = document.getElementById('boot-cover');
const dropCover = () => bootCover?.remove();
if (localStorage.getItem('ra.tutorialDone')) {
  KBrand.runSplash();
  requestAnimationFrame(dropCover);
} else {
  dropCover();
}
setTimeout(dropCover, 2600); // Sicherheitsnetz, falls oben etwas schiefgeht
