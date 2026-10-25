// Entry for the features and community pages: smooth scroll and reveals unless reduced motion.
import '../styles/site.css';
import { prefersReducedMotion } from './env';
import { initSite } from './site';

initSite();
if (!prefersReducedMotion()) {
  void import('./motion').then(({ initSmoothScroll, initReveals }) => {
    initSmoothScroll();
    initReveals();
  });
} else {
  document.documentElement.dataset.motion = 'reduced';
}
