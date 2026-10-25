// Entry for the home page. The motion stack (gsap, ScrollTrigger, Lenis) and three.js are loaded
// lazily and only when the visitor allows motion; three.js additionally only when WebGL works.
// Otherwise the pre-rendered pawn image in the HTML stays (data-hero = "static" / "fallback").
import '../styles/site.css';
import { hasWebGL, prefersReducedMotion } from './env';
import { initSite } from './site';

initSite();

const root = document.documentElement;
const container = document.querySelector<HTMLElement>('[data-hero-visual]');
const trigger = document.querySelector<HTMLElement>('[data-hero]');

if (prefersReducedMotion()) {
  root.dataset.motion = 'reduced';
  root.dataset.hero = 'static';
} else {
  void import('./motion').then(async ({ initSmoothScroll, initReveals }) => {
    initSmoothScroll();
    initReveals();
    if (!container || !trigger) return;
    if (!hasWebGL()) {
      root.dataset.hero = 'fallback';
      return;
    }
    try {
      const { mountHero } = await import('./hero/hero');
      mountHero(container, trigger);
    } catch (err) {
      console.warn('3D hero unavailable, showing the image instead', err);
      root.dataset.hero = 'fallback';
    }
  });
}
