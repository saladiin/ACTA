import { Suspense, useRef, useMemo } from "react";
import { useFrame, useLoader } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { Weapon } from "@workspace/api-client-react";

// ─────────────────────────────────────────────────────────────────────────────
// Weapon firing FX — beam / tracer / missile, with per-hit impact flashes.
//
// All effects are purely visual (server has already resolved the shot). They
// use additive blending so they read as energy in the bloom pass, and disable
// raycasting so they never intercept ship clicks.
// ─────────────────────────────────────────────────────────────────────────────

export type WeaponClass = "beam" | "tracer" | "missile" | "energy-mine";

const FACTION_BEAM_COLOR: Record<string, string> = {
  "Earth Alliance": "#ff2a2a",
  "Minbari Federation": "#22ff66",
  "Shadows": "#b85cff",
};
const SHADOW_SLICER_COLOR = "#b85cff";
const DEFAULT_BEAM_COLOR = "#ff2a2a";
const TRACER_COLOR = "#76bb40";
const TRACER_IMPACT_COLOR = "#96d35f";
const TRACER_TUNING = {
  speed: 1,
  size: 0.3,
  fade: 2.9,
  intensity: 1,
  count: 7,
};
const FIGHTER_PROJECTILE_MODEL_FILENAME = "projectile_mesh.glb";
const FIGHTER_PROJECTILE_TEXTURE_FILENAME = "T_FirePanningCyl45.png";
const FIGHTER_PROJECTILE_SECONDARY_TEXTURE_FILENAME = "T_VFX_WindNoise1.png";
const FIGHTER_PROJECTILE_ALPHA_TEXTURE_FILENAME = "T_Noise_HU85k.png";
const FIGHTER_PROJECTILE_FLIGHT_MS = 950;
const FIGHTER_PROJECTILE_LAUNCH_DELAYS_MS = [0, 200, 400, 300, 500, 700] as const;
const FIGHTER_PROJECTILE_TUNING = {
  color: "#fcfcfd",
  secondaryColor: "#3a13fb",
  speed: 1.15,
  size: 0.5,
  fade: 1.1,
  intensity: 1.2,
  spread: 0.2,
  count: 3,
  arc: 0.35,
  thickness: 0.6,
  meshSize: 0.15,
};
const SHADOW_FIGHTER_PROJECTILE_TUNING = {
  ...FIGHTER_PROJECTILE_TUNING,
  color: "#a655f7",
  secondaryColor: "#c800ff",
  count: 6,
};
const MISSILE_TUNING = {
  color: "#f97316",
  secondaryColor: "#fef08a",
  speed: 1.3,
  size: 1.15,
  fade: 1.1,
  intensity: 1.95,
  spread: 1.2,
  count: 3,
  arc: 2.7,
  thickness: 0.25,
  meshSize: 0.4,
  flareSize: 4,
};
const MISSILE_MODEL_FILENAME = "missile1.glb";
const MISSILE_MODEL_REVISION = "20260719-013547";
const MISSILE_FLARE_TEXTURE_FILENAME = "missileflare.png";
const MISSILE_FLARE_TEXTURE_REVISION = "20260719-011930";
const MISSILE_FLIGHT_MS = 3000;
const MISSILE_LAUNCH_DELAYS_MS = [0, 500, 1200] as const;
const TARGET_IMPACT_TEXTURE_FILENAME = "T_FirePanningCyl45.png";
const TARGET_IMPACT_TEXTURE_REVISION = "20260720-121500";
const TARGET_IMPACT_TUNING = {
  color: "#ef4444",
  secondaryColor: "#f97316",
  speed: 0.75,
  size: 0.31,
  fade: 1,
  intensity: 1.4,
  spread: 0.5,
  count: 4,
  thickness: 1.35,
  expansionCycle: 3.2,
};

function impactFadeEnvelope(t: number): number {
  const clamped = THREE.MathUtils.clamp(t, 0, 1);
  const attack = THREE.MathUtils.clamp(clamped / 0.14, 0, 1);
  const release = THREE.MathUtils.clamp(1 - (clamped - 0.42) / 0.58, 0, 1);
  return attack * release;
}

function impactClusterOffsets(count: number, spread: number, seed = 0): [number, number, number][] {
  const spacing = Math.max(0.625, spread * 1.125);
  const wobble = seed * 0.13;
  const pattern: [number, number, number][] = [
    [-0.56, -0.06, -0.12],
    [0.5, 0.04, 0.08],
    [-0.04, 0.08, -0.58],
    [0.14, -0.02, 0.54],
    [-0.72, 0.05, 0.42],
    [0.7, -0.04, -0.36],
    [-0.2, 0.1, 0.78],
    [0.28, -0.08, -0.76],
  ];
  return Array.from({ length: count }, (_, index) => {
    const base = pattern[index % pattern.length];
    const ring = Math.floor(index / pattern.length);
    const angle = wobble + ring * 0.47;
    const x = base[0] * Math.cos(angle) - base[2] * Math.sin(angle);
    const z = base[0] * Math.sin(angle) + base[2] * Math.cos(angle);
    return [x * spacing, base[1] * spacing, z * spacing];
  });
}
const ENERGY_MINE_TUNING = {
  color: "#f5f5f4",
  secondaryColor: "#6e6ce4",
  speed: 0.9,
  size: 1.1,
  fade: 1,
  intensity: 1,
  arc: 2.5,
  thickness: 1,
};

// Match ACTA-style traits on the `traits` text field. Missiles are detected
// by name because the "Missile" trait isn't reliably present in the dataset.
export function classifyWeapon(weapon: Pick<Weapon, "name" | "traits">): WeaponClass {
  const traits = (weapon.traits ?? "").toLowerCase();
  const name = (weapon.name ?? "").toLowerCase();
  if (name.includes("energy mine") || /\benergy[- ]?mine\b/.test(traits)) return "energy-mine";
  if (name.includes("missile")) return "missile";
  if (name.includes("molecular slicer")) return "beam";
  if (name.includes("laser")) return "beam";
  if (/\bmini[- ]?beam\b/.test(traits) || /\bbeam\b/.test(traits)) return "beam";
  return "tracer";
}

export function beamColorFor(faction: string, weapon?: Pick<Weapon, "name">): string {
  if ((weapon?.name ?? "").toLowerCase().includes("molecular slicer")) return SHADOW_SLICER_COLOR;
  return FACTION_BEAM_COLOR[faction] ?? DEFAULT_BEAM_COLOR;
}

function tracerColorsFor(faction: string, weapon?: Pick<Weapon, "name">): { color: string; impact: string } {
  const name = (weapon?.name ?? "").toLowerCase();
  if (name.includes("matter") || name.includes("particle")) {
    return { color: "#ffa040", impact: "#ffd166" };
  }
  if (/brakiri|league/i.test(faction) || name.includes("pulsar") || name.includes("ion")) {
    return { color: TRACER_COLOR, impact: TRACER_IMPACT_COLOR };
  }
  return { color: TRACER_COLOR, impact: TRACER_IMPACT_COLOR };
}

function isFighterAttacker(attackerName?: string, attackerModelFilename?: string): boolean {
  const text = `${attackerName ?? ""} ${attackerModelFilename ?? ""}`.toLowerCase();
  return /\b(fighter|flight|starfury|nial|flyer|sentri|frazi|spitfire)\b/.test(text);
}

function isShadowFighterAttacker(
  attackerFaction: string,
  attackerName?: string,
  attackerModelFilename?: string,
): boolean {
  if (!isFighterAttacker(attackerName, attackerModelFilename)) return false;
  const text = `${attackerFaction} ${attackerName ?? ""} ${attackerModelFilename ?? ""}`.toLowerCase();
  return text.includes("shadow") || text.includes("spitfire");
}

// Common envelope: short ramp-up, plateau, then fade. Returns 0..1.
function envelope(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 0;
  if (t < 0.12) return t / 0.12;
  if (t < 0.6) return 1;
  return Math.max(0, 1 - (t - 0.6) / 0.4);
}

// ── Sustained energy beam ───────────────────────────────────────────────────
function BeamFx({
  from,
  to,
  color,
  lifeMs = 2600,
  thickness = 0.018,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  color: string;
  lifeMs?: number;
  thickness?: number;
}) {
  const coreRef = useRef<THREE.MeshBasicMaterial>(null);
  const haloRef = useRef<THREE.MeshBasicMaterial>(null);
  const startRef = useRef<number>(performance.now());

  const { mid, quat, len } = useMemo(() => {
    const dir = new THREE.Vector3().subVectors(to, from);
    const length = dir.length();
    const midpoint = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
    // Align cylinder's +Y axis with the from→to direction.
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir.clone().normalize(),
    );
    return { mid: midpoint, quat: q, len: length };
  }, [from.x, from.y, from.z, to.x, to.y, to.z]);

  useFrame(() => {
    const t = (performance.now() - startRef.current) / lifeMs;
    const a = envelope(t);
    if (coreRef.current) coreRef.current.opacity = a;
    if (haloRef.current) haloRef.current.opacity = a * 0.35;
  });

  return (
    <group position={mid.toArray()} quaternion={quat}>
      {/* Bright core */}
      <mesh raycast={() => null}>
        <cylinderGeometry args={[thickness, thickness, len, 8, 1]} />
        <meshBasicMaterial
          ref={coreRef}
          color={color}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      {/* Wider glow halo — picked up by the bloom pass */}
      <mesh raycast={() => null}>
        <cylinderGeometry args={[thickness * 3.5, thickness * 3.5, len, 12, 1]} />
        <meshBasicMaterial
          ref={haloRef}
          color={color}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

// ── Single travelling tracer (used by salvo + missile) ─────────────────────
function TravellingProjectile({
  from,
  to,
  color,
  delayMs,
  travelMs,
  startRef,
  size = 0.16,
  arcHeight = 0,
  fadeMs = 180,
  intensity = 1,
  ribbonTrail = false,
  ribbonLengthT = 0.1,
  ribbonWidth = 0.16,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  color: string;
  delayMs: number;
  travelMs: number;
  startRef: React.MutableRefObject<number>;
  size?: number;
  arcHeight?: number;
  fadeMs?: number;
  intensity?: number;
  ribbonTrail?: boolean;
  ribbonLengthT?: number;
  ribbonWidth?: number;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const ribbonRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const trailRef = useRef<THREE.MeshBasicMaterial>(null);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  const pointAt = (t: number) => {
    const x = from.x + (to.x - from.x) * t;
    const yLinear = from.y + (to.y - from.y) * t;
    const y = yLinear + (arcHeight > 0 ? Math.sin(Math.PI * t) * arcHeight : 0);
    const z = from.z + (to.z - from.z) * t;
    return new THREE.Vector3(x, y, z);
  };

  useFrame(() => {
    const elapsed = performance.now() - startRef.current - delayMs;
    if (!groupRef.current || !matRef.current) return;
    if (elapsed < 0) {
      matRef.current.opacity = 0;
      if (trailRef.current) trailRef.current.opacity = 0;
      if (ribbonRef.current) ribbonRef.current.visible = false;
      return;
    }
    const t = Math.min(1, elapsed / travelMs);
    const current = pointAt(t);
    groupRef.current.position.copy(current);
    if (t < 1) {
      matRef.current.opacity = intensity;
      if (trailRef.current) trailRef.current.opacity = 0.45 * intensity;
    } else {
      const fadeT = (elapsed - travelMs) / fadeMs;
      const a = Math.max(0, 1 - fadeT);
      matRef.current.opacity = a * intensity;
      if (trailRef.current) trailRef.current.opacity = a * 0.45 * intensity;
    }
    if (ribbonTrail && ribbonRef.current && trailRef.current) {
      const tail = pointAt(Math.max(0, t - ribbonLengthT));
      const localTail = tail.sub(current);
      const len = localTail.length();
      ribbonRef.current.visible = len > 0.01 && trailRef.current.opacity > 0.01;
      if (ribbonRef.current.visible) {
        ribbonRef.current.position.copy(localTail).multiplyScalar(0.5);
        ribbonRef.current.quaternion.setFromUnitVectors(up, localTail.clone().normalize());
        ribbonRef.current.scale.set(ribbonWidth, len, 1);
      }
    }
  });

  return (
    <group ref={groupRef}>
      {/* Bright head */}
      <mesh raycast={() => null}>
        <sphereGeometry args={[size, 10, 10]} />
        <meshBasicMaterial
          ref={matRef}
          color={color}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      {ribbonTrail ? (
        <mesh ref={ribbonRef} visible={false} raycast={() => null}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            ref={trailRef}
            color={color}
            transparent
            opacity={0}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
      ) : (
        <mesh raycast={() => null}>
          <sphereGeometry args={[size * 2.5, 10, 10]} />
          <meshBasicMaterial
            ref={trailRef}
            color={color}
            transparent
            opacity={0}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      )}
    </group>
  );
}

// ── Salvo of cannon tracers ─────────────────────────────────────────────────
function TracerSalvoFx({
  from,
  to,
  color,
  count,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  color: string;
  count: number;
}) {
  const startRef = useRef<number>(performance.now());
  // Cap count so very high-AD weapons (e.g. 14D Heavy Pulse) don't spawn a wall.
  const n = Math.max(1, Math.min(count, TRACER_TUNING.count));
  const travelMs = 340 / TRACER_TUNING.speed;
  const fadeMs = 180 * TRACER_TUNING.fade;
  const projectileSize = 0.16 * TRACER_TUNING.size;
  return (
    <>
      {Array.from({ length: n }).map((_, i) => (
        <TravellingProjectile
          key={i}
          from={from}
          to={to}
          color={color}
          delayMs={i * 65}
          travelMs={travelMs}
          startRef={startRef}
          size={projectileSize}
          fadeMs={fadeMs}
          intensity={TRACER_TUNING.intensity}
        />
      ))}
    </>
  );
}

// ── Missile volley — slower, arcing trajectory ─────────────────────────────
function modelScaleForTargetSize(object: THREE.Object3D, targetInches: number): number {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxHorizontal = Math.max(size.x, size.z);
  return maxHorizontal > 0 ? targetInches / maxHorizontal : 1;
}

type FighterProjectileTuning = typeof FIGHTER_PROJECTILE_TUNING;

const FIGHTER_PROJECTILE_SHADER_CONFIG = {
  alphaSource: 2,
  alphaFloor: 0.16,
  alphaStrength: 0.58,
  secondaryMix: 0.45,
  emissiveBoost: 0.95,
  rimBoost: 0.3,
  rimAlpha: 0.09,
  fresnelPower: 1.8,
  threshold: 0.24,
  pulseAmount: 0.26,
  primarySpeed: [0, -0.1] as const,
  secondarySpeed: [0.09, 0.02] as const,
  alphaSpeed: [-0.03, 0.05] as const,
  primaryRepeat: [1, 1] as const,
  secondaryRepeat: [1.3, 1.3] as const,
  alphaRepeat: [1.9, 1.9] as const,
};

function configureProjectileTexture(texture: THREE.Texture, colorSpace: THREE.ColorSpace = THREE.SRGBColorSpace): void {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = colorSpace;
  texture.needsUpdate = true;
}

function assetUrl(kind: "models" | "textures", filename: string): string {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${basePath}/api/${kind}/${filename}`;
}

function MeshFighterProjectileRound({
  from,
  to,
  tuning,
  index,
  startRef,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  tuning: FighterProjectileTuning;
  index: number;
  startRef: React.MutableRefObject<number>;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  const forward = useMemo(() => new THREE.Vector3(0, 0, -1), []);
  const { scene } = useGLTF(assetUrl("models", FIGHTER_PROJECTILE_MODEL_FILENAME));
  const primaryTexture = useLoader(THREE.TextureLoader, assetUrl("textures", FIGHTER_PROJECTILE_TEXTURE_FILENAME));
  const secondaryTexture = useLoader(THREE.TextureLoader, assetUrl("textures", FIGHTER_PROJECTILE_SECONDARY_TEXTURE_FILENAME));
  const alphaTexture = useLoader(THREE.TextureLoader, assetUrl("textures", FIGHTER_PROJECTILE_ALPHA_TEXTURE_FILENAME));

  useMemo(() => {
    configureProjectileTexture(primaryTexture);
    configureProjectileTexture(secondaryTexture);
    configureProjectileTexture(alphaTexture, THREE.NoColorSpace);
  }, [alphaTexture, primaryTexture, secondaryTexture]);

  const uniforms = useMemo(
    () => ({
      uPrimaryMap: { value: primaryTexture },
      uSecondaryMap: { value: secondaryTexture },
      uAlphaMap: { value: alphaTexture },
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(tuning.color) },
      uSecondaryColor: { value: new THREE.Color(tuning.secondaryColor) },
      uIntensity: { value: tuning.intensity },
      uOpacity: { value: 0 },
      uAlphaSource: { value: FIGHTER_PROJECTILE_SHADER_CONFIG.alphaSource },
      uAlphaFloor: { value: FIGHTER_PROJECTILE_SHADER_CONFIG.alphaFloor },
      uAlphaStrength: { value: FIGHTER_PROJECTILE_SHADER_CONFIG.alphaStrength },
      uSecondaryMix: { value: FIGHTER_PROJECTILE_SHADER_CONFIG.secondaryMix },
      uEmissiveBoost: { value: FIGHTER_PROJECTILE_SHADER_CONFIG.emissiveBoost },
      uRimBoost: { value: FIGHTER_PROJECTILE_SHADER_CONFIG.rimBoost },
      uRimAlpha: { value: FIGHTER_PROJECTILE_SHADER_CONFIG.rimAlpha },
      uFresnelPower: { value: FIGHTER_PROJECTILE_SHADER_CONFIG.fresnelPower },
      uThreshold: { value: FIGHTER_PROJECTILE_SHADER_CONFIG.threshold },
      uPulseAmount: { value: FIGHTER_PROJECTILE_SHADER_CONFIG.pulseAmount },
      uPrimarySpeed: { value: new THREE.Vector2(...FIGHTER_PROJECTILE_SHADER_CONFIG.primarySpeed) },
      uSecondarySpeed: { value: new THREE.Vector2(...FIGHTER_PROJECTILE_SHADER_CONFIG.secondarySpeed) },
      uAlphaSpeed: { value: new THREE.Vector2(...FIGHTER_PROJECTILE_SHADER_CONFIG.alphaSpeed) },
      uPrimaryRepeat: { value: new THREE.Vector2(...FIGHTER_PROJECTILE_SHADER_CONFIG.primaryRepeat) },
      uSecondaryRepeat: { value: new THREE.Vector2(...FIGHTER_PROJECTILE_SHADER_CONFIG.secondaryRepeat) },
      uAlphaRepeat: { value: new THREE.Vector2(...FIGHTER_PROJECTILE_SHADER_CONFIG.alphaRepeat) },
    }),
    [alphaTexture, primaryTexture, secondaryTexture, tuning.color, tuning.intensity, tuning.secondaryColor],
  );

  const { cloned, scale } = useMemo(() => {
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vWorldNormal;
        varying vec3 vViewDir;
        void main() {
          vUv = uv;
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          vViewDir = normalize(cameraPosition - worldPosition.xyz);
          gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
      `,
      fragmentShader: `
        uniform sampler2D uPrimaryMap;
        uniform sampler2D uSecondaryMap;
        uniform sampler2D uAlphaMap;
        uniform float uTime;
        uniform vec3 uColor;
        uniform vec3 uSecondaryColor;
        uniform float uIntensity;
        uniform float uOpacity;
        uniform float uAlphaSource;
        uniform float uAlphaFloor;
        uniform float uAlphaStrength;
        uniform float uSecondaryMix;
        uniform float uEmissiveBoost;
        uniform float uRimBoost;
        uniform float uRimAlpha;
        uniform float uFresnelPower;
        uniform float uThreshold;
        uniform float uPulseAmount;
        uniform vec2 uPrimarySpeed;
        uniform vec2 uSecondarySpeed;
        uniform vec2 uAlphaSpeed;
        uniform vec2 uPrimaryRepeat;
        uniform vec2 uSecondaryRepeat;
        uniform vec2 uAlphaRepeat;
        varying vec2 vUv;
        varying vec3 vWorldNormal;
        varying vec3 vViewDir;

        void main() {
          vec4 primary = texture2D(uPrimaryMap, vUv * uPrimaryRepeat + uPrimarySpeed * uTime);
          vec4 secondary = texture2D(uSecondaryMap, vUv * uSecondaryRepeat + uSecondarySpeed * uTime);
          vec4 alphaTex = texture2D(uAlphaMap, vUv * uAlphaRepeat + uAlphaSpeed * uTime);
          float alphaSample = primary.r;
          if (uAlphaSource > 0.5 && uAlphaSource < 1.5) {
            alphaSample = secondary.r;
          } else if (uAlphaSource >= 1.5) {
            alphaSample = alphaTex.r;
          }
          float cut = smoothstep(uThreshold - 0.16, uThreshold + 0.16, alphaSample);
          float fresnel = pow(1.0 - clamp(abs(dot(normalize(vWorldNormal), normalize(vViewDir))), 0.0, 1.0), uFresnelPower);
          float pulse = 1.0 + sin(uTime * 4.2) * uPulseAmount;
          vec3 mappedColor = uColor * (0.38 + primary.rgb * 1.25);
          mappedColor = mix(mappedColor, uSecondaryColor * (0.32 + secondary.rgb * 1.25), uSecondaryMix);
          mappedColor += uSecondaryColor * alphaTex.r * uEmissiveBoost;
          mappedColor += uSecondaryColor * fresnel * uRimBoost;
          float alpha = (uAlphaFloor + cut * uAlphaStrength + fresnel * uRimAlpha) * uIntensity * uOpacity * pulse;
          gl_FragColor = vec4(mappedColor * uIntensity, clamp(alpha, 0.0, 0.92));
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    materialRef.current = material;

    const c = scene.clone(true);
    c.traverse((child: any) => {
      if (!child.isMesh) return;
      child.castShadow = false;
      child.receiveShadow = false;
      child.material = material;
    });

    return {
      cloned: c,
      scale: modelScaleForTargetSize(c, tuning.meshSize),
    };
  }, [scene, tuning.meshSize, uniforms]);

  const flight = useMemo(() => {
    const dir = new THREE.Vector3().subVectors(to, from).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
    const row = index < 3 ? -1 : 1;
    const column = index % 3;
    const sideOffset = ((column - 1) * 0.09 + row * 0.16) * tuning.spread;
    const verticalOffset = row > 0 ? 0.08 : -0.03;
    const start = from.clone().add(side.clone().multiplyScalar(sideOffset));
    const end = to.clone().add(side.clone().multiplyScalar(sideOffset * 0.28));
    start.y += verticalOffset;
    end.y += verticalOffset * 0.5;
    return { start, end };
  }, [from, index, to, tuning.spread]);

  const pointAt = (t: number) => {
    const p = flight.start.clone().lerp(flight.end, t);
    p.y += Math.sin(Math.PI * t) * tuning.arc * 0.25;
    return p;
  };

  const directionAt = (t: number) => {
    const ahead = pointAt(THREE.MathUtils.clamp(t + 0.012, 0, 1));
    const behind = pointAt(THREE.MathUtils.clamp(t - 0.012, 0, 1));
    return ahead.sub(behind).normalize();
  };

  useFrame(() => {
    const group = groupRef.current;
    const material = materialRef.current;
    if (!group || !material) return;

    const durationMs = FIGHTER_PROJECTILE_FLIGHT_MS / THREE.MathUtils.clamp(tuning.speed, 0.25, 3);
    const delayMs = FIGHTER_PROJECTILE_LAUNCH_DELAYS_MS[index] ?? index * 200;
    const elapsed = performance.now() - startRef.current - delayMs;
    if (elapsed < 0 || elapsed > durationMs) {
      group.visible = false;
      material.uniforms.uOpacity.value = 0;
      return;
    }

    const t = THREE.MathUtils.clamp(elapsed / durationMs, 0, 1);
    const current = pointAt(t);
    const direction = directionAt(t);
    const fadeIn = THREE.MathUtils.clamp(t / 0.08, 0, 1);
    const fadeOut = THREE.MathUtils.clamp((1 - t) / 0.12, 0, 1);

    group.visible = true;
    group.position.copy(current);
    group.quaternion.setFromUnitVectors(forward, direction);
    material.uniforms.uTime.value = (performance.now() - startRef.current) * 0.001 * tuning.speed;
    material.uniforms.uOpacity.value = fadeIn * fadeOut * tuning.fade;
    material.uniforms.uColor.value.set(tuning.color);
    material.uniforms.uSecondaryColor.value.set(tuning.secondaryColor);
    material.uniforms.uIntensity.value = tuning.intensity;
  });

  return (
    <group ref={groupRef} visible={false}>
      <primitive object={cloned} scale={[scale, scale, scale]} />
      <pointLight
        color={tuning.secondaryColor}
        intensity={1.7 * tuning.intensity}
        distance={2.4 * tuning.thickness}
      />
    </group>
  );
}

function MeshFighterProjectileSalvoFx({
  from,
  to,
  shadow,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  shadow: boolean;
}) {
  const startRef = useRef<number>(performance.now());
  const tuning = shadow ? SHADOW_FIGHTER_PROJECTILE_TUNING : FIGHTER_PROJECTILE_TUNING;
  const count = Math.max(1, Math.min(tuning.count, 6));
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <Suspense key={i} fallback={null}>
          <MeshFighterProjectileRound
            from={from}
            to={to}
            tuning={tuning}
            index={i}
            startRef={startRef}
          />
        </Suspense>
      ))}
    </>
  );
}

function MissileTextureFlare() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const url = `${basePath}/api/textures/${MISSILE_FLARE_TEXTURE_FILENAME}?v=${encodeURIComponent(MISSILE_FLARE_TEXTURE_REVISION)}`;
  const texture = useLoader(THREE.TextureLoader, url);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const flareSize = MISSILE_TUNING.flareSize;
  const length = 0.34 * flareSize;
  const height = 0.16 * flareSize;

  useMemo(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
  }, [texture]);

  useFrame(() => {
    const pulse = (Math.sin(performance.now() * 0.014) + 1) / 2;
    if (matRef.current) matRef.current.opacity = (0.5 + pulse * 0.22) * MISSILE_TUNING.intensity;
    if (lightRef.current) lightRef.current.intensity = (0.7 + pulse * 1.1) * MISSILE_TUNING.intensity;
  });

  return (
    <group position={[0, 0, -length / 2]} rotation={[0, Math.PI / 2, 0]}>
      <mesh raycast={() => null} renderOrder={5}>
        <planeGeometry args={[length, height]} />
        <meshBasicMaterial
          ref={matRef}
          map={texture}
          color={MISSILE_TUNING.color}
          transparent
          opacity={0.7 * MISSILE_TUNING.intensity}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
      <pointLight
        ref={lightRef}
        color={MISSILE_TUNING.color}
        intensity={1}
        distance={0.4 * flareSize}
      />
    </group>
  );
}

function MissileMeshModel() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const url = `${basePath}/api/models/${MISSILE_MODEL_FILENAME}?v=${encodeURIComponent(MISSILE_MODEL_REVISION)}`;
  const { scene } = useGLTF(url);

  const { cloned, scale } = useMemo(() => {
    const c = scene.clone(true);
    const tintColor = new THREE.Color("#d1d5db");
    c.traverse((child: any) => {
      if (!child.isMesh) return;
      child.castShadow = true;
      child.receiveShadow = true;
      const sourceMaterials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      const materials = sourceMaterials.map((material: THREE.Material | undefined) => {
        const clonedMaterial = material?.clone
          ? material.clone()
          : new THREE.MeshStandardMaterial({ color: "#d1d5db" });
        const adjustable = clonedMaterial as THREE.Material & {
          color?: THREE.Color;
          emissive?: THREE.Color;
          emissiveIntensity?: number;
        };
        if (adjustable.color instanceof THREE.Color) {
          adjustable.color = adjustable.color.clone().lerp(tintColor, 0.08);
        }
        if (adjustable.emissive instanceof THREE.Color) {
          adjustable.emissive = tintColor.clone();
          adjustable.emissiveIntensity = 0.04;
        }
        return clonedMaterial;
      });
      child.material = Array.isArray(child.material) ? materials : materials[0];
    });
    return {
      cloned: c,
      scale: modelScaleForTargetSize(c, MISSILE_TUNING.meshSize),
    };
  }, [scene]);

  return (
    <group>
      <primitive object={cloned} scale={[scale, scale, scale]} />
      <MissileTextureFlare />
    </group>
  );
}

function MeshMissileRound({
  from,
  to,
  index,
  startRef,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  index: number;
  startRef: React.MutableRefObject<number>;
}) {
  const missileRef = useRef<THREE.Group>(null);
  const forward = useMemo(() => new THREE.Vector3(0, 0, 1), []);

  const flight = useMemo(() => {
    const dir = new THREE.Vector3().subVectors(to, from).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
    const offsets = [-0.42, -0.14, 0.14, 0.42, 0];
    const start = from.clone().add(side.multiplyScalar((offsets[index % offsets.length] ?? 0) * MISSILE_TUNING.spread));
    start.y += 0.12 + (index % 2) * 0.08;
    const end = to.clone().add(new THREE.Vector3((index - 2) * 0.12 * MISSILE_TUNING.spread, 0.08, 0));
    return { start, end };
  }, [from, index, to]);

  const pointAt = (t: number) => {
    const p = flight.start.clone().lerp(flight.end, t);
    p.y += Math.sin(Math.PI * t) * MISSILE_TUNING.arc * (1 + (index % 2) * 0.12);
    return p;
  };

  const directionAt = (t: number) => {
    const ahead = pointAt(Math.min(1, t + 0.012));
    const behind = pointAt(Math.max(0, t - 0.012));
    return ahead.sub(behind).normalize();
  };

  useFrame(() => {
    const group = missileRef.current;
    if (!group) return;

    const durationMs = MISSILE_FLIGHT_MS;
    const delayMs = MISSILE_LAUNCH_DELAYS_MS[index] ?? MISSILE_LAUNCH_DELAYS_MS[MISSILE_LAUNCH_DELAYS_MS.length - 1];
    const elapsed = performance.now() - startRef.current - delayMs;
    if (elapsed < 0) {
      group.visible = false;
      return;
    }

    const t = Math.min(1, elapsed / durationMs);
    const current = pointAt(t);
    const direction = directionAt(t);
    const visible = t < 1;
    group.visible = visible;
    group.position.copy(current);
    group.quaternion.setFromUnitVectors(forward, direction);
  });

  return (
    <group ref={missileRef} visible={false}>
      <Suspense fallback={null}>
        <MissileMeshModel />
      </Suspense>
    </group>
  );
}

function MissileVolleyFx({
  from,
  to,
  count,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  count: number;
}) {
  const startRef = useRef<number>(performance.now());
  const n = MISSILE_TUNING.count;
  return (
    <>
      {Array.from({ length: n }).map((_, i) => (
        <MeshMissileRound
          key={i}
          from={from}
          to={to}
          index={i}
          startRef={startRef}
        />
      ))}
    </>
  );
}

// ── Impact flash at the target ─────────────────────────────────────────────
// Energy Mine: one matter-cannon style projectile followed by a violet area ring.
function EnergyMineFx({
  from,
  to,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
}) {
  const startRef = useRef<number>(performance.now());
  const travelMs = 620 / ENERGY_MINE_TUNING.speed;
  return (
    <>
      <TravellingProjectile
        from={from}
        to={to}
        color={ENERGY_MINE_TUNING.color}
        delayMs={0}
        travelMs={travelMs}
        startRef={startRef}
        size={0.16 * ENERGY_MINE_TUNING.size}
        arcHeight={0}
        fadeMs={260 * ENERGY_MINE_TUNING.fade}
        intensity={ENERGY_MINE_TUNING.intensity}
        ribbonTrail
        ribbonLengthT={0.14}
        ribbonWidth={0.2 * ENERGY_MINE_TUNING.size}
      />
      <EnergyMineDetonationRing
        position={to}
        delayMs={travelMs}
        color={ENERGY_MINE_TUNING.secondaryColor}
        coreColor={ENERGY_MINE_TUNING.color}
        size={ENERGY_MINE_TUNING.size}
        thickness={ENERGY_MINE_TUNING.thickness}
        intensity={ENERGY_MINE_TUNING.intensity}
      />
    </>
  );
}

function EnergyMineDetonationRing({
  position,
  delayMs,
  color,
  coreColor,
  size,
  thickness,
  intensity,
}: {
  position: THREE.Vector3;
  delayMs: number;
  color: string;
  coreColor: string;
  size: number;
  thickness: number;
  intensity: number;
}) {
  const ringRef = useRef<THREE.Mesh>(null);
  const coreRef = useRef<THREE.Mesh>(null);
  const ringMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const coreMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const startRef = useRef<number>(performance.now());

  useFrame(() => {
    const elapsed = performance.now() - startRef.current - delayMs;
    if (elapsed < 0) {
      if (ringMatRef.current) ringMatRef.current.opacity = 0;
      if (coreMatRef.current) coreMatRef.current.opacity = 0;
      if (lightRef.current) lightRef.current.intensity = 0;
      return;
    }
    const t = Math.min(1, elapsed / 1150);
    const ringScale = (0.6 + t * 5.0) * size;
    const coreScale = (0.35 + Math.sin(t * Math.PI) * 0.4) * size;
    const ringAlpha = Math.max(0, 1 - t) * 0.85 * intensity;
    const coreAlpha = Math.sin(t * Math.PI) * 0.55 * intensity;
    if (ringRef.current) ringRef.current.scale.setScalar(ringScale);
    if (coreRef.current) coreRef.current.scale.setScalar(coreScale);
    if (ringMatRef.current) ringMatRef.current.opacity = ringAlpha;
    if (coreMatRef.current) coreMatRef.current.opacity = coreAlpha;
    if (lightRef.current) lightRef.current.intensity = (ringAlpha + coreAlpha) * 4.5;
  });

  return (
    <group position={[position.x, 0.45, position.z]}>
      <mesh ref={ringRef} rotation={[Math.PI / 2, 0, 0]} raycast={() => null}>
        <torusGeometry args={[0.55, 0.02 * thickness, 8, 96]} />
        <meshBasicMaterial
          ref={ringMatRef}
          color={color}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh ref={coreRef} raycast={() => null}>
        <sphereGeometry args={[1, 16, 16]} />
        <meshBasicMaterial
          ref={coreMatRef}
          color={coreColor}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <pointLight ref={lightRef} color={color} distance={9} decay={2} intensity={0} />
    </group>
  );
}

function TargetImpactFx({
  position,
  delayMs = 0,
  seed = 0,
}: {
  position: THREE.Vector3;
  delayMs?: number;
  seed?: number;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const coreRef = useRef<THREE.Mesh>(null);
  const coreMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const materialRefs = useRef<Array<THREE.ShaderMaterial | null>>([]);
  const startRef = useRef<number>(performance.now());
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const textureUrl = `${basePath}/api/textures/${TARGET_IMPACT_TEXTURE_FILENAME}?v=${encodeURIComponent(TARGET_IMPACT_TEXTURE_REVISION)}`;
  const texture = useLoader(THREE.TextureLoader, textureUrl);
  const sphereOffsets = useMemo<[number, number, number][]>(
    () => impactClusterOffsets(TARGET_IMPACT_TUNING.count, TARGET_IMPACT_TUNING.spread, seed),
    [seed],
  );

  useMemo(() => {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
  }, [texture]);

  const uniforms = useMemo(
    () => ({
      uMap: { value: texture },
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(TARGET_IMPACT_TUNING.color) },
      uSecondaryColor: {
        value: new THREE.Color(TARGET_IMPACT_TUNING.secondaryColor),
      },
      uAlpha: { value: 0 },
      uIntensity: { value: TARGET_IMPACT_TUNING.intensity },
    }),
    [texture],
  );

  useFrame(() => {
    const elapsed = performance.now() - startRef.current - delayMs;
    const group = groupRef.current;
    if (!group) return;
    if (elapsed < 0) {
      group.visible = false;
      if (lightRef.current) lightRef.current.intensity = 0;
      if (coreMatRef.current) coreMatRef.current.opacity = 0;
      materialRefs.current.forEach(material => {
        if (material) material.uniforms.uAlpha.value = 0;
      });
      return;
    }
    const lifeMs = TARGET_IMPACT_TUNING.expansionCycle * 1000;
    if (elapsed > lifeMs) {
      group.visible = false;
      if (lightRef.current) lightRef.current.intensity = 0;
      if (coreMatRef.current) coreMatRef.current.opacity = 0;
      materialRefs.current.forEach(material => {
        if (material) material.uniforms.uAlpha.value = 0;
      });
      return;
    }
    group.visible = true;
    const t = Math.min(1, elapsed / lifeMs);
    const alpha = impactFadeEnvelope(t) * TARGET_IMPACT_TUNING.fade;
    const pulse = (Math.sin(elapsed * 0.012 * TARGET_IMPACT_TUNING.speed) + 1) / 2;
    const scale =
      (0.55 + t * 1.75 + pulse * 0.12) * TARGET_IMPACT_TUNING.size;
    group.children.forEach((child, index) => {
      child.scale.setScalar(scale * (index === 0 ? 1 : 0.82 + index * 0.08));
    });
    if (coreRef.current) coreRef.current.scale.setScalar(scale * 0.72);
    if (coreMatRef.current) {
      coreMatRef.current.opacity = alpha * 0.2 * TARGET_IMPACT_TUNING.intensity;
    }
    materialRefs.current.forEach(material => {
      if (!material) return;
      material.uniforms.uTime.value = elapsed * 0.001 * TARGET_IMPACT_TUNING.speed;
      material.uniforms.uAlpha.value = alpha * TARGET_IMPACT_TUNING.intensity;
    });
    if (lightRef.current) {
      lightRef.current.intensity = alpha * 4.5 * TARGET_IMPACT_TUNING.intensity;
    }
  });

  return (
    <group ref={groupRef} position={position.toArray()} visible={false}>
      {sphereOffsets.map((offset, index) => (
        <mesh key={index} position={offset} raycast={() => null}>
          <sphereGeometry args={[1.08, 32, 18]} />
          <shaderMaterial
            ref={material => {
              materialRefs.current[index] = material;
            }}
            uniforms={uniforms}
            vertexShader={`
              varying vec2 vUv;
              varying vec3 vWorldNormal;
              varying vec3 vViewDir;
              void main() {
                vUv = uv;
                vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                vWorldNormal = normalize(mat3(modelMatrix) * normal);
                vViewDir = normalize(cameraPosition - worldPosition.xyz);
                gl_Position = projectionMatrix * viewMatrix * worldPosition;
              }
            `}
            fragmentShader={`
              uniform sampler2D uMap;
              uniform float uTime;
              uniform vec3 uColor;
              uniform vec3 uSecondaryColor;
              uniform float uAlpha;
              uniform float uIntensity;
              varying vec2 vUv;
              varying vec3 vWorldNormal;
              varying vec3 vViewDir;
              void main() {
                vec4 fire = texture2D(uMap, vUv * vec2(1.1, 1.1) + vec2(0.0, -0.18) * uTime);
                float fresnel = pow(1.0 - clamp(abs(dot(normalize(vWorldNormal), normalize(vViewDir))), 0.0, 1.0), 1.4);
                float cut = smoothstep(0.02, 0.72, fire.r);
                vec3 mappedColor = uColor * (0.38 + fire.rgb * 1.25);
                mappedColor += uSecondaryColor * fire.r * 0.8;
                mappedColor += uSecondaryColor * fresnel * 0.35;
                float alpha = (0.2 + cut * 0.45 + fresnel * 0.08) * uAlpha;
                gl_FragColor = vec4(mappedColor * uIntensity, clamp(alpha, 0.0, 0.92));
              }
            `}
            transparent
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
      ))}
      <mesh ref={coreRef} raycast={() => null}>
        <sphereGeometry args={[0.72, 24, 16]} />
        <meshBasicMaterial
          ref={coreMatRef}
          color={TARGET_IMPACT_TUNING.secondaryColor}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <pointLight
        ref={lightRef}
        color={TARGET_IMPACT_TUNING.color}
        distance={8 * TARGET_IMPACT_TUNING.thickness}
        decay={2}
        intensity={0}
      />
    </group>
  );
}

// ── Top-level dispatcher ───────────────────────────────────────────────────
// Renders the right FX kind for the weapon, plus one impact flash per HIT
// (timed to land roughly when the projectile/beam arrives).
export function WeaponFx({
  from,
  to,
  weapon,
  attackerFaction,
  attackerName,
  attackerModelFilename,
  hits,
  totalDice,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  weapon: Pick<Weapon, "id" | "name" | "traits" | "attackDice">;
  attackerFaction: string;
  attackerName?: string;
  attackerModelFilename?: string;
  hits: number;
  totalDice: number;
}) {
  const kind = classifyWeapon(weapon);

  if (kind === "beam") {
    const color = beamColorFor(attackerFaction, weapon);
    return (
      <>
        <BeamFx from={from} to={to} color={color} />
        {Array.from({ length: hits }).map((_, i) => (
          <TargetImpactFx
            key={i}
            position={to}
            delayMs={250 + i * 70}
            seed={i}
          />
        ))}
      </>
    );
  }

  if (kind === "missile") {
    const missileImpactCount = Math.max(0, Math.min(hits, MISSILE_TUNING.count));
    return (
      <>
        <MissileVolleyFx from={from} to={to} count={totalDice} />
        {Array.from({ length: missileImpactCount }).map((_, i) => (
          <TargetImpactFx
            key={i}
            position={to}
            delayMs={
              MISSILE_FLIGHT_MS +
              (MISSILE_LAUNCH_DELAYS_MS[i] ??
                MISSILE_LAUNCH_DELAYS_MS[MISSILE_LAUNCH_DELAYS_MS.length - 1])
            }
            seed={i + 20}
          />
        ))}
      </>
    );
  }

  if (kind === "energy-mine") {
    return <EnergyMineFx from={from} to={to} />;
  }

  // Tracer (cannons / mass drivers / ion / pulse).
  const fighterProjectile = isFighterAttacker(attackerName, attackerModelFilename);
  const shadowFighterProjectile = isShadowFighterAttacker(
    attackerFaction,
    attackerName,
    attackerModelFilename,
  );
  if (fighterProjectile) {
    const travelMs =
      FIGHTER_PROJECTILE_FLIGHT_MS /
      THREE.MathUtils.clamp(FIGHTER_PROJECTILE_TUNING.speed, 0.25, 3);
    return (
      <>
        <MeshFighterProjectileSalvoFx
          from={from}
          to={to}
          shadow={shadowFighterProjectile}
        />
        {Array.from({ length: hits }).map((_, i) => (
          <TargetImpactFx
            key={i}
            position={to}
            delayMs={travelMs + i * 70}
            seed={i + 40}
          />
        ))}
      </>
    );
  }

  const tracerColors = tracerColorsFor(attackerFaction, weapon);
  return (
    <>
      <TracerSalvoFx from={from} to={to} color={tracerColors.color} count={totalDice} />
      {Array.from({ length: hits }).map((_, i) => (
        <TargetImpactFx
          key={i}
          position={to}
          delayMs={340 / TRACER_TUNING.speed + i * 70}
          seed={i + 40}
        />
      ))}
    </>
  );
}
