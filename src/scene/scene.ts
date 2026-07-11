import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface CityScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  groundPlane: THREE.Mesh;
  flyTo(x: number, z: number, dist?: number): void;
}

export function createScene(container: HTMLElement): CityScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0e14);
  scene.fog = new THREE.Fog(0x0a0e14, 3500, 9000);

  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    1,
    20000,
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
  controls.maxDistance = 7000;
  controls.target.set(0, 0, 0);

  // Lighting: cool ambient + warm key, night-city look
  scene.add(new THREE.AmbientLight(0x8899bb, 0.75));
  const sun = new THREE.DirectionalLight(0xffeedd, 1.4);
  sun.position.set(-1200, 1800, 800);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x4488cc, 0.35);
  fill.position.set(900, 400, -1100);
  scene.add(fill);

  // Ground plane — receives the basemap / 1943 aerial texture
  const groundGeo = new THREE.PlaneGeometry(12000, 12000);
  const groundMat = new THREE.MeshLambertMaterial({ color: 0x10151d });
  const groundPlane = new THREE.Mesh(groundGeo, groundMat);
  groundPlane.rotation.x = -Math.PI / 2;
  groundPlane.position.y = -0.5;
  groundPlane.name = 'ground';
  scene.add(groundPlane);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Smooth fly-to animation
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

  return { scene, camera, renderer, controls, groundPlane, flyTo };
}
