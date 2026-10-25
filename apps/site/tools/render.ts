// Dev-only page used by tools/render-assets.mjs: renders the hero pawn in its resting pose (the end
// of the intro animation) into a transparent canvas for the static fallback image and the OG image.
import { createPawnScene } from '../src/scripts/hero/scene';

declare global {
  interface Window {
    __rendered?: boolean;
  }
}

const params = new URLSearchParams(location.search);
const dark = params.get('dark') === '1';
const canvas = document.getElementById('c') as HTMLCanvasElement;
const scene = createPawnScene(canvas, { preserveDrawingBuffer: true, pixelRatio: 1, dark });
scene.resize(800, 1000);
scene.introGroup.rotation.y = 0.5;
scene.render();
window.__rendered = true;
