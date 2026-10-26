// Hero orchestration (home page only, loaded lazily): creates the three.js scene in the hero
// container, runs the gsap intro, the idle float, pointer parallax and the ScrollTrigger-driven
// rotation, and renders only while the hero is on screen and the tab is visible.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { effectiveTheme, watchTheme } from '../theme';
import { DAISY_SCALE, createPawnScene, type PawnScene } from './scene';

gsap.registerPlugin(ScrollTrigger);

export interface HeroHandle {
  scene: PawnScene;
  destroy(): void;
}

export function mountHero(container: HTMLElement, trigger: HTMLElement): HeroHandle {
  const canvas = document.createElement('canvas');
  canvas.className = 'hero-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.setAttribute('role', 'presentation');
  container.appendChild(canvas);

  const scene = createPawnScene(canvas, { dark: effectiveTheme() === 'dark' });
  // Follows the visitor's choice (data-theme) and the system preference, live.
  const stopTheme = watchTheme((theme) => {
    scene.setDark(theme === 'dark');
    requestRender();
  });

  // --- render loop: only while visible --------------------------------------------------------
  let onScreen = true;
  let ticking = false;
  const tick = () => scene.render();
  const updateLoop = () => {
    const want = onScreen && document.visibilityState === 'visible';
    if (want && !ticking) {
      gsap.ticker.add(tick);
      ticking = true;
    } else if (!want && ticking) {
      gsap.ticker.remove(tick);
      ticking = false;
    }
    container.dataset.rendering = ticking ? 'on' : 'off';
  };
  const requestRender = () => {
    if (!ticking) scene.render();
  };
  const io = new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
    updateLoop();
  });
  io.observe(container);
  const onVisibility = () => updateLoop();
  document.addEventListener('visibilitychange', onVisibility);

  const ro = new ResizeObserver(() => {
    const { width, height } = container.getBoundingClientRect();
    scene.resize(width, height);
    requestRender();
  });
  ro.observe(container);
  const rect = container.getBoundingClientRect();
  scene.resize(rect.width, rect.height);
  scene.render();

  const lost = (e: Event) => {
    e.preventDefault();
    document.documentElement.dataset.hero = 'fallback';
    container.classList.remove('is-3d');
  };
  canvas.addEventListener('webglcontextlost', lost);

  // --- animations ------------------------------------------------------------------------------
  const { introGroup, floatGroup, pointerGroup, scrollGroup, daisy } = scene;
  const intro = gsap.timeline({ defaults: { ease: 'expo.out' } });
  intro
    .fromTo(introGroup.rotation, { y: -Math.PI * 1.15 }, { y: 0.5, duration: 2.4 }, 0)
    .fromTo(
      introGroup.position,
      { y: introGroup.position.y - 0.55 },
      { y: introGroup.position.y, duration: 2 },
      0,
    )
    .fromTo(introGroup.scale, { x: 0.82, y: 0.82, z: 0.82 }, { x: 1, y: 1, z: 1, duration: 2 }, 0)
    .fromTo(daisy.rotation, { y: -Math.PI }, { y: 0, duration: 2.6, ease: 'power3.out' }, 0.25)
    .fromTo(
      daisy.scale,
      { x: 0.2, y: 0.2, z: 0.2 },
      { x: DAISY_SCALE, y: DAISY_SCALE, z: DAISY_SCALE, duration: 1.6, ease: 'back.out(2)' },
      0.5,
    );
  container.classList.add('is-3d');
  document.documentElement.dataset.hero = '3d';

  const float = gsap.to(floatGroup.position, {
    y: 0.07,
    duration: 2.8,
    ease: 'sine.inOut',
    yoyo: true,
    repeat: -1,
  });
  const sway = gsap.to(floatGroup.rotation, {
    z: 0.035,
    duration: 3.6,
    ease: 'sine.inOut',
    yoyo: true,
    repeat: -1,
  });
  const spin = gsap.to(daisy.rotation, {
    y: '+=' + Math.PI * 2,
    duration: 40,
    ease: 'none',
    repeat: -1,
    delay: 2.8,
  });

  // Pointer parallax on fine pointers only.
  const finePointer = window.matchMedia('(pointer: fine)').matches;
  const toX = gsap.quickTo(pointerGroup.rotation, 'x', { duration: 1.2, ease: 'power3.out' });
  const toY = gsap.quickTo(pointerGroup.rotation, 'y', { duration: 1.2, ease: 'power3.out' });
  const onPointer = (e: PointerEvent) => {
    const nx = e.clientX / window.innerWidth - 0.5;
    const ny = e.clientY / window.innerHeight - 0.5;
    toY(nx * 0.5);
    toX(ny * 0.18);
  };
  if (finePointer) window.addEventListener('pointermove', onPointer, { passive: true });

  // Scroll: turn and tilt the pawn while the hero scrolls away.
  const scroll = gsap.timeline({
    scrollTrigger: { trigger, start: 'top top', end: 'bottom top', scrub: 0.9 },
    defaults: { ease: 'none' },
  });
  scroll
    .to(scrollGroup.rotation, { y: Math.PI * 1.25, x: 0.42 }, 0)
    .to(scrollGroup.position, { y: 0.35 }, 0)
    .to(container, { yPercent: 18, autoAlpha: 0.25 }, 0);

  return {
    scene,
    destroy() {
      intro.kill();
      float.kill();
      sway.kill();
      spin.kill();
      scroll.scrollTrigger?.kill();
      scroll.kill();
      if (ticking) gsap.ticker.remove(tick);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      stopTheme();
      window.removeEventListener('pointermove', onPointer);
      scene.dispose();
      canvas.remove();
    },
  };
}
