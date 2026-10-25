// The hero scene: an ivory Staunton pawn (LatheGeometry from profile.ts) crowned with a daisy, lit
// with a soft room environment, a warm key light and a daisy-yellow rim light. No animation in
// here: callers move the exposed groups (gsap) and call render().
import {
  NeutralToneMapping,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HEAD, PAWN_HEIGHT, pawnProfile, profileMaxRadius } from './profile';

export const BRAND = {
  ivory: '#ece3d0',
  petal: '#ffffff',
  petalEdge: '#b8c0ca',
  centre: '#f5c518',
  centreRing: '#d9a000',
} as const;

/** Resting scale of the daisy (the intro animates towards it). */
export const DAISY_SCALE = 1.3;

export interface PawnScene {
  renderer: WebGLRenderer;
  /** Outermost group: scroll-driven rotation/tilt. */
  scrollGroup: Group;
  /** Pointer parallax. */
  pointerGroup: Group;
  /** Idle float. */
  floatGroup: Group;
  /** Intro animation. */
  introGroup: Group;
  /** The daisy on the head (spins a little on its own). */
  daisy: Group;
  resize(width: number, height: number): void;
  setDark(dark: boolean): void;
  render(): void;
  dispose(): void;
}

export interface PawnSceneOptions {
  /** Keep the drawing buffer (asset rendering only). */
  preserveDrawingBuffer?: boolean;
  /** Pixel ratio cap; defaults to min(devicePixelRatio, 2). */
  pixelRatio?: number;
  dark?: boolean;
}

function shadowTexture(): CanvasTexture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.45, 'rgba(0,0,0,0.25)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function buildDaisy(): Group {
  const daisy = new Group();
  const petalGeo = new SphereGeometry(1, 24, 12);
  const petalMat = new MeshPhysicalMaterial({
    color: BRAND.petal,
    roughness: 0.55,
    sheen: 0.6,
    sheenColor: new Color('#fff6dc'),
    sheenRoughness: 0.5,
  });
  const count = 14;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const holder = new Group();
    holder.rotation.y = a;
    const petal = new Mesh(petalGeo, petalMat);
    petal.scale.set(0.05, 0.018, 0.15);
    petal.position.z = 0.17;
    // Petals rise slightly towards their tips: a shallow cup.
    petal.rotation.x = -0.3;
    holder.add(petal);
    daisy.add(holder);
  }
  const centre = new Mesh(
    new SphereGeometry(0.095, 32, 16),
    new MeshPhysicalMaterial({ color: BRAND.centre, roughness: 0.65 }),
  );
  centre.scale.y = 0.6;
  centre.position.y = 0.016;
  const ring = new Mesh(
    new SphereGeometry(0.104, 32, 8),
    new MeshPhysicalMaterial({ color: BRAND.centreRing, roughness: 0.7 }),
  );
  ring.scale.y = 0.3;
  daisy.add(ring, centre);
  return daisy;
}

export function createPawnScene(canvas: HTMLCanvasElement, opts: PawnSceneOptions = {}): PawnScene {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'low-power',
    preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
  });
  renderer.setPixelRatio(opts.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envRT = pmrem.fromScene(room, 0.04);
  scene.environment = envRT.texture;
  room.dispose?.();
  pmrem.dispose();

  const camera = new PerspectiveCamera(26, 1, 0.1, 50);
  camera.position.set(0, 1.55, 6.2);
  camera.lookAt(0, 0.88, 0);

  scene.add(new HemisphereLight(0xfff8ec, 0x2a241c, 0.25));
  const key = new DirectionalLight(0xfff6ea, 2.1);
  key.position.set(-4, 4.5, 2.2);
  const fill = new DirectionalLight(0xe8eefc, 0.25);
  fill.position.set(3, 1, 4);
  // Daisy-yellow rims from behind on both sides: they paint the silhouette.
  const rim = new DirectionalLight(new Color(BRAND.centre), 4.5);
  rim.position.set(3.6, 1.8, -4.2);
  const rim2 = new DirectionalLight(new Color('#ffe9a8'), 1.6);
  rim2.position.set(-3.8, 1.4, -4.0);
  scene.add(key, fill, rim, rim2);

  const scrollGroup = new Group();
  const pointerGroup = new Group();
  const floatGroup = new Group();
  const introGroup = new Group();
  scene.add(scrollGroup);
  scrollGroup.add(pointerGroup);
  pointerGroup.add(floatGroup);
  floatGroup.add(introGroup);

  const profile = pawnProfile(8, 40).map((p) => new Vector2(p.x, p.y));
  const pawnGeo = new LatheGeometry(profile, 96);
  const pawnMat = new MeshPhysicalMaterial({
    color: BRAND.ivory,
    roughness: 0.34,
    metalness: 0,
    clearcoat: 0.55,
    clearcoatRoughness: 0.28,
    sheen: 0.25,
    sheenColor: new Color('#fff1c4'),
    envMapIntensity: 0.3,
  });
  const pawn = new Mesh(pawnGeo, pawnMat);
  // Rotate around the visual centre so tilts look natural.
  const pivotY = PAWN_HEIGHT * 0.45;
  pawn.position.y = -pivotY;
  introGroup.position.y = pivotY;
  introGroup.add(pawn);

  const daisy = buildDaisy();
  // Tucked onto the front of the crown, tilted towards the viewer.
  daisy.position.set(0, HEAD.y + HEAD.r * 0.84 - pivotY, 0.1);
  daisy.rotation.x = 0.55;
  daisy.scale.setScalar(DAISY_SCALE);
  introGroup.add(daisy);

  const shadowMat = new MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.45 });
  const r = profileMaxRadius(profile);
  const shadow = new Mesh(new PlaneGeometry(r * 3.4, r * 3.4), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -0.002;
  scene.add(shadow);

  const setDark = (dark: boolean) => {
    shadowMat.opacity = dark ? 0.75 : 0.42;
    renderer.toneMappingExposure = dark ? 0.95 : 0.9;
    rim.intensity = dark ? 6 : 4.5;
    rim2.intensity = dark ? 2.2 : 1.6;
  };
  setDark(opts.dark ?? false);

  return {
    renderer,
    scrollGroup,
    pointerGroup,
    floatGroup,
    introGroup,
    daisy,
    resize(width, height) {
      if (width <= 0 || height <= 0) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      // Keep the pawn the same size relative to the canvas height on narrow screens.
      camera.fov = camera.aspect < 0.75 ? 30 : 26;
      camera.updateProjectionMatrix();
    },
    setDark,
    render() {
      renderer.render(scene, camera);
    },
    dispose() {
      scene.traverse((o) => {
        if (o instanceof Mesh) {
          o.geometry.dispose();
          const m = o.material as MeshBasicMaterial | MeshPhysicalMaterial;
          m.map?.dispose();
          m.dispose();
        }
      });
      envRT.dispose();
      renderer.dispose();
    },
  };
}
