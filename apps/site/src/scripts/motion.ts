// Smooth scrolling (Lenis) synced to gsap's ScrollTrigger, and scroll reveals. Only used when the
// visitor has not asked for reduced motion; callers check prefersReducedMotion() first.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';

gsap.registerPlugin(ScrollTrigger);

export function initSmoothScroll(): Lenis {
  const lenis = new Lenis({ lerp: 0.11, wheelMultiplier: 1 });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
  document.documentElement.dataset.motion = 'smooth';
  return lenis;
}

/** Fades up every `[data-reveal]` element as it enters the viewport (grouped per batch). */
export function initReveals(root: ParentNode = document): void {
  const items = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'));
  if (items.length === 0) return;
  // Hide only what is below the fold; anything already visible stays put (no flash on load).
  const fold = window.innerHeight * 0.92;
  const below = items.filter((el) => el.getBoundingClientRect().top > fold);
  gsap.set(below, { autoAlpha: 0, y: 28 });
  ScrollTrigger.batch(below, {
    start: 'top 88%',
    once: true,
    onEnter: (batch) =>
      gsap.to(batch, { autoAlpha: 1, y: 0, duration: 0.9, ease: 'power3.out', stagger: 0.08, overwrite: true }),
  });
}

export { gsap, ScrollTrigger };
