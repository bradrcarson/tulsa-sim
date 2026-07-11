import * as THREE from 'three';

/**
 * Facade material: MeshLambertMaterial extended with a procedural,
 * world-scale window grid so every wall has real structure at street level
 * (replaces the Phase 2 additive point scatter).
 *
 * Geometry contract (see layers/buildings.ts):
 *   attribute float aWallDist  — accumulated perimeter distance (m); -1 on roofs
 *   attribute float aFloorY    — world Y of the building base (m)
 *   attribute float aRand      — per-building random seed [0,1)
 *   vertex color               — wall/roof base albedo
 *
 * Window cells are ~3.3 m wide × 3.1 m per floor. At night a seeded subset
 * of panes emits warm/cool light (bloom picks them up); by day panes read
 * as dark glass.
 */
export function createFacadeMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 1,
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = { value: (mat.userData.pendingNight as number | undefined) ?? 1 };
    (mat.userData as { shader?: typeof shader }).shader = shader;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aWallDist;
        attribute float aFloorY;
        attribute float aRand;
        varying float vWallDist;
        varying float vFloorH;
        varying float vRand;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vWallDist = aWallDist;
        vFloorH = position.y - aFloorY;
        vRand = aRand;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uNight;
        varying float vWallDist;
        varying float vFloorH;
        varying float vRand;
        float winHash(vec2 p, float seed) {
          return fract(sin(dot(p, vec2(127.1, 311.7)) + seed * 43758.5) * 43758.5453);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // day mode: pull the stylized night palette toward concrete/limestone
        float lum = dot(diffuseColor.rgb, vec3(0.333));
        vec3 dayAlbedo = mix(vec3(lum) * vec3(1.02, 0.99, 0.94), diffuseColor.rgb, 0.35) * 1.25;
        diffuseColor.rgb = mix(dayAlbedo, diffuseColor.rgb, uNight);
        float winMask = 0.0;
        vec3 winGlow = vec3(0.0);
        if (vWallDist >= 0.0 && vFloorH > 1.0) {
          vec2 cell = vec2(floor(vWallDist / 3.3), floor((vFloorH - 1.0) / 3.1));
          vec2 inCell = vec2(fract(vWallDist / 3.3), fract((vFloorH - 1.0) / 3.1));
          // pane occupies the middle of each cell
          float pane = step(0.31, inCell.x) * step(inCell.x, 0.71)
                     * step(0.30, inCell.y) * step(inCell.y, 0.72);
          winMask = pane;
          float h = winHash(cell, vRand);
          // day: dark blue-gray glass; night: some panes lit
          float litRatio = mix(0.0, 0.42, uNight);
          float lit = step(h, litRatio);
          vec3 glass = diffuse.rgb * mix(vec3(0.52, 0.58, 0.68), vec3(0.22), uNight);
          // warm sodium / cool office, varied brightness
          vec3 warm = vec3(1.0, 0.82, 0.55);
          vec3 cool = vec3(0.72, 0.86, 1.0);
          vec3 litCol = mix(warm, cool, step(0.8, winHash(cell + 31.7, vRand)))
                      * (0.7 + 0.6 * winHash(cell + 7.3, vRand));
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, winMask);
          winGlow = litCol * winMask * lit * uNight;
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += winGlow;`,
      );
  };

  return mat;
}

/** Drive the day/night blend on a compiled facade material. */
export function setFacadeNight(mat: THREE.MeshLambertMaterial, night: boolean) {
  const shader = (mat.userData as { shader?: { uniforms: { uNight: { value: number } } } }).shader;
  if (shader) shader.uniforms.uNight.value = night ? 1 : 0;
  mat.userData.pendingNight = night ? 1 : 0;
}
