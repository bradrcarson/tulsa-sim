import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export interface CityScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  groundPlane: THREE.Mesh;
  flyTo(x: number, z: number, dist?: number): void;
  setNightMode(on: boolean): void;
  playIntro(onDone?: () => void): void;
  render(): void;
  fps: number;
}

/** Palette per mode — night is the cinematic default (see AGENTS.md Phase 2 §4). */
const MODES = {
  night: {
    bg: 0x05070d,
    fogColor: 0x0a0f1c,
    fogDensity: 0.00012,
    hemiSky: 0x2a3d5c,
    hemiGround: 0x0a0c12,
    hemiIntensity: 0.55,
    keyColor: 0xbcd2ff, // moonlight
    keyIntensity: 0.85,
    fillColor: 0x36598c,
    fillIntensity: 0.3,
    ground: 0x0b0f16,
  },
  day: {
    bg: 0x8fb6d9,
    fogColor: 0x9fc3e0,
    fogDensity: 0.00008,
    hemiSky: 0xcfe5ff,
    hemiGround: 0x6a747f,
    hemiIntensity: 0.9,
    keyColor: 0xfff2dd, // afternoon sun
    keyIntensity: 1.6,
    fillColor: 0x88aacc,
    fillIntensity: 0.4,
    ground: 0x39424d,
  },
};

export function createScene(container: HTMLElement): CityScene {
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    1,
    30000,
  );
  camera.position.set(600, 700, 900);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2 - 0.02; // stay above the ground
  controls.minDistance = 60;
  controls.maxDistance = 12000;
  controls.target.set(0, 0, 0);

  // ── lights (retuned per mode) ──────────────────────────────
  const hemi = new THREE.HemisphereLight();
  scene.add(hemi);
  const key = new THREE.DirectionalLight();
  key.position.set(-1200, 1800, 800);
  scene.add(key);
  const fill = new THREE.DirectionalLight();
  fill.position.set(900, 400, -1100);
  scene.add(fill);

  // ── ground ─────────────────────────────────────────────────
  const groundGeo = new THREE.PlaneGeometry(30000, 30000);
  const groundMat = new THREE.MeshLambertMaterial();
  const groundPlane = new THREE.Mesh(groundGeo, groundMat);
  groundPlane.rotation.x = -Math.PI / 2;
  groundPlane.position.y = -0.5;
  groundPlane.name = 'ground';
  scene.add(groundPlane);

  // ── bloom composer (night only; auto-degrades if fps dips) ─
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.55, // strength — sparingly, per spec
    0.6, // radius
    0.82, // threshold: only emissive windows / street glow / beacons bloom
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  let night = true;
  let bloomEnabled = true;

  function setNightMode(on: boolean) {
    night = on;
    const m = on ? MODES.night : MODES.day;
    scene.background = new THREE.Color(m.bg);
    scene.fog = new THREE.FogExp2(m.fogColor, m.fogDensity);
    hemi.color.set(m.hemiSky);
    hemi.groundColor.set(m.hemiGround);
    hemi.intensity = m.hemiIntensity;
    key.color.set(m.keyColor);
    key.intensity = m.keyIntensity;
    fill.color.set(m.fillColor);
    fill.intensity = m.fillIntensity;
    groundMat.color.set(m.ground);
    scene.userData.night = on;
  }
  setNightMode(true);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  });

  // ── fps guard: drop bloom before dropping buildings ────────
  const fpsWindow: number[] = [];
  let lastFrame = performance.now();
  const api: CityScene = {
    scene,
    camera,
    renderer,
    controls,
    groundPlane,
    flyTo,
    setNightMode,
    playIntro,
    render,
    fps: 60,
  };

  function render() {
    const now = performance.now();
    const dt = now - lastFrame;
    lastFrame = now;
    fpsWindow.push(dt);
    if (fpsWindow.length > 60) fpsWindow.shift();
    const avg = fpsWindow.reduce((a, b) => a + b, 0) / fpsWindow.length;
    api.fps = 1000 / avg;
    if (bloomEnabled && fpsWindow.length === 60 && api.fps < 25) {
      bloomEnabled = false;
      console.info('[scene] fps guard: disabling bloom to stay above 25 fps');
    }

    if (night && bloomEnabled) composer.render();
    else renderer.render(scene, camera);
  }

  // ── smooth fly-to ──────────────────────────────────────────
  let flyAnim: number | null = null;
  function flyTo(x: number, z: number, dist = 500) {
    if (flyAnim !== null) cancelAnimationFrame(flyAnim);
    const startTarget = controls.target.clone();
    const startCam = camera.position.clone();
    const endTarget = new THREE.Vector3(x, 0, z);
    const dir = new THREE.Vector3(0.45, 0.8, 0.6).normalize();
    const endCam = endTarget.clone().addScaledVector(dir, dist);
    const t0 = performance.now();
    const dur = 1200;
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const k = ease(t);
      controls.target.lerpVectors(startTarget, endTarget, k);
      camera.position.lerpVectors(startCam, endCam, k);
      if (t < 1) flyAnim = requestAnimationFrame(step);
      else flyAnim = null;
    };
    step();
  }

  // ── intro fly-through: high orbit swooping down to downtown ─
  // Cubic-bezier-ish path over ~3.2 s; any pointer/key input skips it.
  function playIntro(onDone?: () => void) {
    const startCam = new THREE.Vector3(-3800, 4200, 5200);
    const midCam = new THREE.Vector3(-1200, 1800, 2600);
    const endCam = new THREE.Vector3(620, 640, 880);
    const startTarget = new THREE.Vector3(400, 0, -600);
    const endTarget = new THREE.Vector3(0, 60, 0);

    camera.position.copy(startCam);
    controls.target.copy(startTarget);
    controls.enabled = false;

    const t0 = performance.now();
    const dur = 3200;
    let raf = 0;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(raf);
      camera.position.copy(endCam);
      controls.target.set(endTarget.x, 0, endTarget.z);
      controls.enabled = true;
      window.removeEventListener('pointerdown', finish);
      window.removeEventListener('keydown', finish);
      window.removeEventListener('wheel', finish);
      onDone?.();
    };
    window.addEventListener('pointerdown', finish);
    window.addEventListener('keydown', finish);
    window.addEventListener('wheel', finish);

    const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const k = easeInOut(t);
      // quadratic bezier through midCam gives the "swoop" feel
      const a = new THREE.Vector3().lerpVectors(startCam, midCam, k);
      const b = new THREE.Vector3().lerpVectors(midCam, endCam, k);
      camera.position.lerpVectors(a, b, k);
      controls.target.lerpVectors(startTarget, endTarget, k);
      if (t < 1) raf = requestAnimationFrame(step);
      else finish();
    };
    step();
  }

  return api;
}
