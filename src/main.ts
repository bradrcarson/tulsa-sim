import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// Minimal Vite + TypeScript + Three.js scaffold. This is the dev-environment
// "hello world" that verifies the toolchain renders a scene end-to-end.
// Phase 1 (see AGENTS.md) replaces this with the real Tulsa city layers.

const container = document.getElementById("app")!;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0e14);
scene.fog = new THREE.Fog(0x0a0e14, 40, 120);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
);
camera.position.set(18, 16, 22);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0x6688aa, 0.6));
const key = new THREE.DirectionalLight(0xffffff, 1.2);
key.position.set(20, 40, 10);
scene.add(key);

// Glowing ground grid, evoking the target sci-fi city dashboard.
const grid = new THREE.GridHelper(80, 40, 0x2f6f9f, 0x18324a);
scene.add(grid);

// A small cluster of "buildings" as a stand-in for extruded footprints.
const buildings = new THREE.Group();
const geo = new THREE.BoxGeometry(1, 1, 1);
for (let i = 0; i < 60; i++) {
  const h = 2 + Math.random() * 12;
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(0.55 + Math.random() * 0.1, 0.5, 0.4 + h / 40),
    emissive: 0x0a1a2a,
    roughness: 0.7,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(1.5 + Math.random() * 2, h, 1.5 + Math.random() * 2);
  mesh.position.set(
    (Math.random() - 0.5) * 60,
    h / 2,
    (Math.random() - 0.5) * 60,
  );
  buildings.add(mesh);
}
scene.add(buildings);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  buildings.rotation.y += 0.0015;
  controls.update();
  renderer.render(scene, camera);
}
animate();
