import { Suspense, useEffect, useRef, useMemo } from "react";
import { useFrame, useLoader } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { Weapon } from "@workspace/api-client-react";
import { VorlonConvergenceFx } from "@/components/vorlon-convergence-fx";

// ─────────────────────────────────────────────────────────────────────────────
// Weapon firing FX — beam / mesh projectile / missile, with per-hit impact flashes.
//
// All effects are purely visual (server has already resolved the shot). They
// use additive blending so they read as energy in the bloom pass, and disable
// raycasting so they never intercept ship clicks.
// ─────────────────────────────────────────────────────────────────────────────

export type WeaponClass = "beam" | "tracer" | "missile" | "energy-mine";

const FACTION_BEAM_COLOR: Record<string, string> = {
  "Earth Alliance": "#ff2a2a",
  "Minbari": "#8bdcff",
  "Minbari Federation": "#8bdcff",
  "Shadows": "#b85cff",
  "Vorlon Empire": "#35ff67",
};
const MINBARI_BEAM_COLOR = "#8bdcff";
const SHADOW_SLICER_COLOR = "#b85cff";
const DEFAULT_BEAM_COLOR = "#ff2a2a";
const KIRISHIAC_BEAM_MODEL_FILENAME = "kirishiac1.glb";
const KIRISHIAC_BEAM_MODEL_REVISION = "20260725-beam-0100";
const KIRISHIAC_BEAM_TEXTURE_FILENAME = "T_FirePanningCyl45.png";
const KIRISHIAC_ATTACK_TURN_IN_MS = 1000;
const KIRISHIAC_ATTACK_FIRE_MS = 3000;
const KIRISHIAC_ATTACK_TOTAL_MS = 5000;
const VORLON_ATTACK_CHARGE_MS = 1000;
const KIRISHIAC_BEAM_EMITTER_FORWARD_INCHES = 1.35;
const KIRISHIAC_BEAM_TUNING = {
  color: "#facc15",
  secondaryColor: "#fff7ad",
  speed: 0.9,
  size: 0.75,
  fade: 0.82,
  intensity: 1.15,
  arc: 0.32,
  thickness: 1,
  cylinderLength: 1,
  beamCoreDiameter: 0.07,
  beamCoreBrightness: 1.15,
  beamCoreOpacity: 0.82,
  beamCorePulse: 0.6,
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
const CAPITAL_PROJECTILE_TUNING = {
  color: "#f43f5e",
  secondaryColor: "#facc15",
  speed: 0.7,
  size: 1,
  fade: 1.1,
  intensity: 1.2,
  spread: 1,
  count: 6,
  arc: 0.35,
  thickness: 1,
  meshSize: 0.15,
};
const RAILGUN_PROJECTILE_TUNING = {
  color: "#dbeafe",
  secondaryColor: "#60a5fa",
  speed: 1,
  size: 1,
  fade: 0.82,
  intensity: 1.45,
  spread: 1,
  count: 1,
  arc: 0,
  thickness: 1,
  meshSize: 0.15,
};
const RAILGUN_IMPACT_TUNING = {
  color: "#fb923c",
  secondaryColor: "#fef3c7",
  speed: 1.5,
  size: 0.0625,
  fade: 1,
  intensity: 1.5,
  spread: 0.72,
  count: 70,
  arc: 0.35,
  thickness: 0.82,
  randomness: 0.25,
};
const SHADOW_OMEGA_BEAM_COLOR = "rgba(0, 194, 255, 0.9)";
const SHADOW_OMEGA_PHASING_PULSE_TUNING = {
  ...CAPITAL_PROJECTILE_TUNING,
  color: "rgba(0, 0, 255, 0.9)",
  secondaryColor: "rgba(0, 194, 255, 0.9)",
};
const WHITE_STAR_PROJECTILE_TUNING = {
  ...CAPITAL_PROJECTILE_TUNING,
  color: MINBARI_BEAM_COLOR,
  secondaryColor: "#e0f7ff",
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
  flareSize: 0.1,
  sparkCount: 110,
  sparkRandomness: 0.42,
};
const MISSILE_MODEL_FILENAME = "missile1.glb";
const MISSILE_MODEL_REVISION = "20260719-013547";
const MISSILE_FLIGHT_MS = 1500;
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

function seededSparkNoise(seed: number, salt: number): number {
  const x = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
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

function isShadowOmegaAttacker(
  attackerName?: string,
  attackerModelFilename?: string,
): boolean {
  const text = `${attackerName ?? ""} ${attackerModelFilename ?? ""}`.toLowerCase();
  return text.includes("shadow omega") || text.includes("omega-x");
}

function isShadowOmegaCyanBeamWeapon(weapon: Pick<Weapon, "name">): boolean {
  const name = (weapon.name ?? "").toLowerCase();
  return (
    name.includes("molecular slicer") ||
    name.includes("light multiphased cutter")
  );
}

function isShadowOmegaHeavyPhasingPulseWeapon(weapon: Pick<Weapon, "name">): boolean {
  return (weapon.name ?? "").toLowerCase().includes("heavy phasing pulse");
}

function isRailWeapon(weapon: Pick<Weapon, "name" | "traits">): boolean {
  const text = `${weapon.name ?? ""} ${weapon.traits ?? ""}`.toLowerCase();
  return /\brail[- ]?(gun|cannon|weapon)?\b/.test(text);
}

function isWhiteStarAttacker(
  attackerName?: string,
  attackerModelFilename?: string,
): boolean {
  const text = `${attackerName ?? ""} ${attackerModelFilename ?? ""}`.toLowerCase();
  return text.includes("white star") || text.includes("whitestar");
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

// ── Missile volley — direct mesh missiles with staggered launches ──────────
function modelScaleForTargetSize(object: THREE.Object3D, targetInches: number): number {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxHorizontal = Math.max(size.x, size.z);
  return maxHorizontal > 0 ? targetInches / maxHorizontal : 1;
}

type MeshProjectileTuning = typeof FIGHTER_PROJECTILE_TUNING;

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

function isVorlonSuperLightningCannon({
  weapon,
  attackerName,
  attackerModelFilename,
}: {
  weapon: Pick<Weapon, "name">;
  attackerName?: string;
  attackerModelFilename?: string;
}): boolean {
  const attacker =
    `${attackerName ?? ""} ${attackerModelFilename ?? ""}`.toLowerCase();
  return (
    attacker.includes("vorlon") &&
    (weapon.name ?? "").toLowerCase().includes("super lightning cannon")
  );
}

function versionedAssetUrl(kind: "models" | "textures", filename: string, revision: string): string {
  return `${assetUrl(kind, filename)}?v=${encodeURIComponent(revision)}`;
}

function modelScaleForTargetSizeIgnoring(
  object: THREE.Object3D,
  targetInches: number,
  ignoredName: string,
): number {
  const box = new THREE.Box3();
  const scratch = new THREE.Box3();
  const ignored = ignoredName.toLowerCase();
  object.updateMatrixWorld(true);
  object.traverse((child: any) => {
    if (!child.isMesh) return;
    if (String(child.name ?? "").toLowerCase().includes(ignored)) return;
    if (String(child.geometry?.name ?? "").toLowerCase().includes(ignored)) return;
    scratch.setFromObject(child);
    if (!scratch.isEmpty()) box.union(scratch);
  });
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxHorizontal = Math.max(size.x, size.z);
  return maxHorizontal > 0 ? targetInches / maxHorizontal : 1;
}

function isKirishiacAttacker({
  weapon,
  attackerName,
  attackerModelFilename,
}: {
  weapon: Pick<Weapon, "name" | "traits">;
  attackerName?: string;
  attackerModelFilename?: string;
}): boolean {
  const text = `${attackerName ?? ""} ${attackerModelFilename ?? ""} ${weapon.name ?? ""} ${weapon.traits ?? ""}`.toLowerCase();
  return text.includes("kirishiac");
}

function isKirishiacMainForwardBeam(weapon: Pick<Weapon, "name" | "traits"> & { arc?: string }): boolean {
  const name = (weapon.name ?? "").toLowerCase();
  const arc = (weapon.arc ?? "").toLowerCase();
  return name.includes("hyper graviton blaster") && (!arc || arc === "forward");
}

function kirishiacBeamEmitterPoint(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 {
  const direction = new THREE.Vector3(to.x - from.x, 0, to.z - from.z);
  if (direction.lengthSq() < 0.0001) return from.clone();
  direction.normalize();
  return from.clone().add(direction.multiplyScalar(KIRISHIAC_BEAM_EMITTER_FORWARD_INCHES));
}

function KirishiacInnerCombatBeamFx({
  from,
  to,
  startRef,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  startRef: React.MutableRefObject<number>;
}) {
  const planeMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const crossMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const coreMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const haloMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const sourceTexture = useLoader(THREE.TextureLoader, assetUrl("textures", KIRISHIAC_BEAM_TEXTURE_FILENAME));

  const { mid, quat, len } = useMemo(() => {
    const dir = new THREE.Vector3().subVectors(to, from);
    const length = dir.length();
    const midpoint = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    return { mid: midpoint, quat: q, len: length };
  }, [from.x, from.y, from.z, to.x, to.y, to.z]);

  const [mainTexture, crossTexture] = useMemo(() => {
    const configure = (texture: THREE.Texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(1.3, 5.2);
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      return texture;
    };
    return [configure(sourceTexture.clone()), configure(sourceTexture.clone())] as const;
  }, [sourceTexture]);

  useEffect(() => {
    return () => {
      mainTexture.dispose();
      crossTexture.dispose();
    };
  }, [crossTexture, mainTexture]);

  useFrame(() => {
    const totalElapsedMs = performance.now() - startRef.current;
    const fireElapsedMs = totalElapsedMs - KIRISHIAC_ATTACK_TURN_IN_MS;
    const rawT = fireElapsedMs / KIRISHIAC_ATTACK_FIRE_MS;
    const envelopeAlpha = totalElapsedMs <= KIRISHIAC_ATTACK_TOTAL_MS ? envelope(rawT) : 0;
    const elapsed = Math.max(0, fireElapsedMs * 0.001) * KIRISHIAC_BEAM_TUNING.speed;
    const pulse =
      1 +
      Math.sin(elapsed * 6.4) *
        THREE.MathUtils.clamp(KIRISHIAC_BEAM_TUNING.beamCorePulse, 0, 1.5);
    const brightness = THREE.MathUtils.clamp(KIRISHIAC_BEAM_TUNING.beamCoreBrightness, 0, 5);
    const opacity =
      envelopeAlpha *
      THREE.MathUtils.clamp(KIRISHIAC_BEAM_TUNING.beamCoreOpacity, 0, 2);

    mainTexture.offset.y = -elapsed * 0.26;
    mainTexture.offset.x = Math.sin(elapsed * 0.42) * 0.03;
    crossTexture.offset.y = -elapsed * 0.34;
    crossTexture.offset.x = Math.cos(elapsed * 0.36) * 0.04;

    if (planeMatRef.current) {
      planeMatRef.current.color.set(KIRISHIAC_BEAM_TUNING.color);
      planeMatRef.current.opacity = THREE.MathUtils.clamp(0.42 * opacity * brightness * pulse, 0, 1.2);
    }
    if (crossMatRef.current) {
      crossMatRef.current.color.set(KIRISHIAC_BEAM_TUNING.secondaryColor);
      crossMatRef.current.opacity = THREE.MathUtils.clamp(0.26 * opacity * brightness * pulse, 0, 1);
    }
    if (coreMatRef.current) {
      coreMatRef.current.color.set(KIRISHIAC_BEAM_TUNING.secondaryColor);
      coreMatRef.current.opacity = THREE.MathUtils.clamp(0.78 * opacity * brightness * pulse, 0, 1.35);
    }
    if (haloMatRef.current) {
      haloMatRef.current.color.set(KIRISHIAC_BEAM_TUNING.color);
      haloMatRef.current.opacity = THREE.MathUtils.clamp(0.18 * opacity * brightness * pulse, 0, 0.8);
    }
    if (lightRef.current) {
      lightRef.current.color.set(KIRISHIAC_BEAM_TUNING.color);
      lightRef.current.intensity = opacity * brightness * (2.4 + pulse * 2.4);
    }
  });

  const diameter = THREE.MathUtils.clamp(KIRISHIAC_BEAM_TUNING.beamCoreDiameter, 0.02, 2.5);
  return (
    <group position={mid.toArray()} quaternion={quat}>
      <mesh raycast={() => null}>
        <planeGeometry args={[diameter * 4.6, len]} />
        <meshBasicMaterial ref={planeMatRef} map={mainTexture} color={KIRISHIAC_BEAM_TUNING.color} transparent opacity={0} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh rotation={[0, Math.PI / 2, 0]} raycast={() => null}>
        <planeGeometry args={[diameter * 3.2, len]} />
        <meshBasicMaterial ref={crossMatRef} map={crossTexture} color={KIRISHIAC_BEAM_TUNING.secondaryColor} transparent opacity={0} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh raycast={() => null}>
        <cylinderGeometry args={[diameter * 0.5, diameter * 0.5, len, 10, 1]} />
        <meshBasicMaterial ref={coreMatRef} color={KIRISHIAC_BEAM_TUNING.secondaryColor} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh raycast={() => null}>
        <cylinderGeometry args={[diameter * 1.9, diameter * 1.9, len, 18, 1]} />
        <meshBasicMaterial ref={haloMatRef} color={KIRISHIAC_BEAM_TUNING.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <pointLight ref={lightRef} color={KIRISHIAC_BEAM_TUNING.color} intensity={0} distance={12 + diameter * 7} />
    </group>
  );
}

function KirishiacOuterBeamShellFx({
  from,
  to,
  startRef,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  startRef: React.MutableRefObject<number>;
}) {
  const { scene } = useGLTF(versionedAssetUrl("models", KIRISHIAC_BEAM_MODEL_FILENAME, KIRISHIAC_BEAM_MODEL_REVISION));
  const beamTexture = useLoader(THREE.TextureLoader, assetUrl("textures", KIRISHIAC_BEAM_TEXTURE_FILENAME));
  const shellMaterialsRef = useRef<THREE.ShaderMaterial[]>([]);
  const beamMeshesRef = useRef<Array<{ mesh: THREE.Mesh; baseScale: THREE.Vector3 }>>([]);
  const lightRef = useRef<THREE.PointLight>(null);

  useMemo(() => {
    configureProjectileTexture(beamTexture);
    beamTexture.repeat.set(1.4, 2.6);
  }, [beamTexture]);

  const { cloned, scale } = useMemo(() => {
    const c = scene.clone(true);
    const previewScale = modelScaleForTargetSizeIgnoring(c, 4.1 * KIRISHIAC_BEAM_TUNING.size, "kirishiac_beam");
    shellMaterialsRef.current = [];
    beamMeshesRef.current = [];

    const createShellMaterial = () => {
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: beamTexture },
          uTime: { value: 0 },
          uColor: { value: new THREE.Color(KIRISHIAC_BEAM_TUNING.color) },
          uSecondaryColor: { value: new THREE.Color(KIRISHIAC_BEAM_TUNING.secondaryColor) },
          uOpacity: { value: 0 },
          uPulseAmount: { value: KIRISHIAC_BEAM_TUNING.arc },
          uBeamMinY: { value: -0.5 },
          uBeamMaxY: { value: 0.5 },
        },
        vertexShader: `
          varying vec2 vUv;
          varying float vLocalBeamY;
          varying vec3 vWorldNormal;
          varying vec3 vViewDir;
          void main() {
            vUv = uv;
            vLocalBeamY = position.y;
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vWorldNormal = normalize(mat3(modelMatrix) * normal);
            vViewDir = normalize(cameraPosition - worldPosition.xyz);
            gl_Position = projectionMatrix * viewMatrix * worldPosition;
          }
        `,
        fragmentShader: `
          uniform sampler2D uMap;
          uniform float uTime;
          uniform vec3 uColor;
          uniform vec3 uSecondaryColor;
          uniform float uOpacity;
          uniform float uPulseAmount;
          uniform float uBeamMinY;
          uniform float uBeamMaxY;
          varying vec2 vUv;
          varying float vLocalBeamY;
          varying vec3 vWorldNormal;
          varying vec3 vViewDir;
          void main() {
            vec2 uv = vUv * vec2(1.2, 2.2) + vec2(0.0, -0.18 * uTime);
            vec4 tex = texture2D(uMap, uv);
            float beamRange = max(abs(uBeamMaxY - uBeamMinY), 0.0001);
            float alongBeam = clamp((vLocalBeamY - uBeamMinY) / beamRange, 0.0, 1.0);
            float endCapFade = smoothstep(0.0, 0.24, alongBeam) * (1.0 - smoothstep(0.76, 1.0, alongBeam));
            float fresnel = pow(1.0 - clamp(abs(dot(normalize(vWorldNormal), normalize(vViewDir))), 0.0, 1.0), 1.1);
            float pulse = 1.0 + sin(uTime * 5.8) * uPulseAmount;
            vec3 color = mix(uColor * (0.5 + tex.r), uSecondaryColor * (0.45 + tex.g), 0.35);
            color += uSecondaryColor * fresnel * 0.85;
            float alpha = (0.08 + tex.r * 0.42 + fresnel * 0.12) * endCapFade * uOpacity * pulse;
            gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.88));
          }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      shellMaterialsRef.current.push(material);
      return material;
    };

    c.traverse((child: any) => {
      if (!child.isMesh) return;
      child.raycast = () => null;
      const childName = String(child.name ?? "").toLowerCase();
      const isBeamShell =
        childName.includes("kirishiac_beam") ||
        String(child.geometry?.name ?? "").toLowerCase().includes("kirishiac_beam");
      if (!isBeamShell) {
        child.visible = false;
        return;
      }
      child.castShadow = false;
      child.receiveShadow = false;
      const shellMaterial = createShellMaterial();
      child.material = shellMaterial;
      child.geometry.computeBoundingBox();
      const box = child.geometry.boundingBox;
      if (box) {
        shellMaterial.uniforms.uBeamMinY.value = box.min.y;
        shellMaterial.uniforms.uBeamMaxY.value = box.max.y;
      }
      beamMeshesRef.current.push({ mesh: child as THREE.Mesh, baseScale: child.scale.clone() });
    });

    return { cloned: c, scale: previewScale };
  }, [beamTexture, scene]);

  useFrame(() => {
    const totalElapsedMs = performance.now() - startRef.current;
    const fireElapsedMs = totalElapsedMs - KIRISHIAC_ATTACK_TURN_IN_MS;
    const rawT = fireElapsedMs / KIRISHIAC_ATTACK_FIRE_MS;
    const envelopeAlpha = totalElapsedMs <= KIRISHIAC_ATTACK_TOTAL_MS ? envelope(rawT) : 0;
    const elapsed = Math.max(0, fireElapsedMs * 0.001) * KIRISHIAC_BEAM_TUNING.speed;
    const pulse =
      1 +
      Math.sin(elapsed * 5.8) *
        THREE.MathUtils.clamp(KIRISHIAC_BEAM_TUNING.arc, 0, 1.5);
    const opacity =
      envelopeAlpha *
      THREE.MathUtils.clamp(KIRISHIAC_BEAM_TUNING.fade, 0, 3) *
      THREE.MathUtils.clamp(KIRISHIAC_BEAM_TUNING.intensity, 0.1, 4);

    shellMaterialsRef.current.forEach((material) => {
      material.uniforms.uTime.value = elapsed;
      material.uniforms.uColor.value.set(KIRISHIAC_BEAM_TUNING.color);
      material.uniforms.uSecondaryColor.value.set(KIRISHIAC_BEAM_TUNING.secondaryColor);
      material.uniforms.uOpacity.value = opacity;
      material.uniforms.uPulseAmount.value = KIRISHIAC_BEAM_TUNING.arc;
    });
    beamMeshesRef.current.forEach(({ mesh, baseScale }) => {
      mesh.scale.set(
        baseScale.x * KIRISHIAC_BEAM_TUNING.thickness,
        baseScale.y * KIRISHIAC_BEAM_TUNING.cylinderLength,
        baseScale.z * KIRISHIAC_BEAM_TUNING.thickness,
      );
      mesh.visible = opacity > 0.01;
    });
    if (lightRef.current) {
      lightRef.current.color.set(KIRISHIAC_BEAM_TUNING.color);
      lightRef.current.intensity = 5.5 * opacity * (0.75 + pulse * 0.25);
      lightRef.current.distance = 10 + KIRISHIAC_BEAM_TUNING.thickness * 3;
    }
  });

  const dir = useMemo(() => new THREE.Vector3().subVectors(to, from), [from.x, from.y, from.z, to.x, to.y, to.z]);
  const heading = Math.atan2(dir.x, dir.z);

  return (
    <group position={from.toArray()} rotation={[0, heading, 0]}>
      <primitive object={cloned} scale={[scale, scale, scale]} />
      <pointLight ref={lightRef} color={KIRISHIAC_BEAM_TUNING.color} intensity={0} distance={14} position={[0, 1.5, 7.2]} />
    </group>
  );
}

function KirishiacBeamFx({
  from,
  to,
  outerShell = true,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  outerShell?: boolean;
}) {
  const startRef = useRef<number>(performance.now());
  const beamFrom = useMemo(
    () => kirishiacBeamEmitterPoint(from, to),
    [from.x, from.y, from.z, to.x, to.y, to.z],
  );
  return (
    <>
      {outerShell ? <KirishiacOuterBeamShellFx from={from} to={to} startRef={startRef} /> : null}
      <KirishiacInnerCombatBeamFx from={beamFrom} to={to} startRef={startRef} />
    </>
  );
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
  tuning: MeshProjectileTuning;
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
  tuning,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  tuning: MeshProjectileTuning;
}) {
  const startRef = useRef<number>(performance.now());
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

const RAILGUN_FLIGHT_MS = 250;
const RAILGUN_TRAIL_FADE_MS = 550;
const RAILGUN_OVERPENETRATION_INCHES = 4;

function RailgunProjectileFx({
  from,
  to,
  startRef,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  startRef: React.MutableRefObject<number>;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const trailRef = useRef<THREE.Mesh>(null);
  const trailMaterialRef = useRef<THREE.ShaderMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const forward = useMemo(() => new THREE.Vector3(0, 0, -1), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const { scene } = useGLTF(assetUrl("models", FIGHTER_PROJECTILE_MODEL_FILENAME));

  const { cloned, scale } = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({
      color: RAILGUN_PROJECTILE_TUNING.color,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const c = scene.clone(true);
    c.traverse((child: any) => {
      if (!child.isMesh) return;
      child.castShadow = false;
      child.receiveShadow = false;
      child.material = material;
    });
    return {
      cloned: c,
      scale: modelScaleForTargetSize(c, RAILGUN_PROJECTILE_TUNING.meshSize),
    };
  }, [scene]);

  const path = useMemo(() => {
    const direction = new THREE.Vector3().subVectors(to, from).normalize();
    const through = to.clone().add(direction.clone().multiplyScalar(RAILGUN_OVERPENETRATION_INCHES));
    const distance = from.distanceTo(through);
    const targetDistance = from.distanceTo(to);
    const targetT = distance > 0 ? THREE.MathUtils.clamp(targetDistance / distance, 0, 1) : 1;
    const midpoint = new THREE.Vector3().addVectors(from, through).multiplyScalar(0.5);
    const projectileQuaternion = new THREE.Quaternion().setFromUnitVectors(forward, direction);
    const trailQuaternion = new THREE.Quaternion().setFromUnitVectors(up, direction);
    return { through, distance, targetT, midpoint, projectileQuaternion, trailQuaternion };
  }, [forward, from, to, up]);

  useFrame(() => {
    const group = groupRef.current;
    const trail = trailRef.current;
    const trailMaterial = trailMaterialRef.current;
    const light = lightRef.current;
    if (!group || !trail || !trailMaterial || !light) return;

    const elapsed = performance.now() - startRef.current;
    const inFlight = elapsed <= RAILGUN_FLIGHT_MS;
    const t = THREE.MathUtils.clamp(elapsed / RAILGUN_FLIGHT_MS, 0, 1);
    const current = from.clone().lerp(path.through, t);

    group.visible = inFlight;
    group.position.copy(current);
    group.quaternion.copy(path.projectileQuaternion);

    const activeTrailLength = inFlight ? Math.max(0.02, path.distance * t) : path.distance;
    const activeTrailMidpoint = inFlight ? from.clone().lerp(current, 0.5) : path.midpoint;
    const fadeElapsed = Math.max(0, elapsed - RAILGUN_FLIGHT_MS);
    const fadeOut = inFlight ? 1 : THREE.MathUtils.clamp(1 - fadeElapsed / RAILGUN_TRAIL_FADE_MS, 0, 1);
    const trailOpacity = fadeOut * RAILGUN_PROJECTILE_TUNING.fade;

    trail.visible = trailOpacity > 0.01;
    trail.position.copy(activeTrailMidpoint);
    trail.quaternion.copy(path.trailQuaternion);
    trail.scale.set(1, activeTrailLength, 1);
    trailMaterial.uniforms.uColor.value.set(RAILGUN_PROJECTILE_TUNING.secondaryColor);
    trailMaterial.uniforms.uOpacity.value = trailOpacity;
    trailMaterial.uniforms.uIntensity.value = RAILGUN_PROJECTILE_TUNING.intensity;

    light.visible = inFlight;
    light.position.copy(current);
    light.color.set(RAILGUN_PROJECTILE_TUNING.color);
    light.intensity = inFlight ? 2.8 * RAILGUN_PROJECTILE_TUNING.intensity : 0;
  });

  return (
    <>
      <group ref={groupRef} visible={false}>
        <primitive object={cloned} scale={[scale, scale, scale]} />
      </group>
      <mesh ref={trailRef} visible={false} raycast={() => null}>
        <cylinderGeometry args={[0.05, 0.05, 1, 20, 1, true]} />
        <shaderMaterial
          ref={trailMaterialRef}
          uniforms={{
            uColor: { value: new THREE.Color(RAILGUN_PROJECTILE_TUNING.secondaryColor) },
            uOpacity: { value: 0 },
            uIntensity: { value: RAILGUN_PROJECTILE_TUNING.intensity },
          }}
          vertexShader={`
            varying float vAlong;
            void main() {
              vAlong = position.y + 0.5;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `}
          fragmentShader={`
            uniform vec3 uColor;
            uniform float uOpacity;
            uniform float uIntensity;
            varying float vAlong;
            void main() {
              float farFade = 1.0 - smoothstep(0.68, 1.0, vAlong);
              float nearFade = smoothstep(0.0, 0.14, vAlong);
              float core = farFade * nearFade;
              gl_FragColor = vec4(uColor * uIntensity, uOpacity * core);
            }
          `}
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
      <pointLight ref={lightRef} color={RAILGUN_PROJECTILE_TUNING.color} intensity={0} distance={4.5} />
    </>
  );
}

function RailgunImpactSparksFx({
  position,
  direction,
  delayMs,
}: {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  delayMs: number;
}) {
  const startRef = useRef<number>(performance.now());
  const particleCount = Math.max(8, Math.min(RAILGUN_IMPACT_TUNING.count, 160));
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(particleCount * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(particleCount * 3), 3));
    return g;
  }, [particleCount]);
  const axes = useMemo(() => {
    const forwardAxis = direction.clone().normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const sideAxis = new THREE.Vector3().crossVectors(forwardAxis, worldUp).normalize();
    if (sideAxis.lengthSq() < 0.01) sideAxis.set(1, 0, 0);
    const upAxis = new THREE.Vector3().crossVectors(sideAxis, forwardAxis).normalize();
    return { forwardAxis, sideAxis, upAxis };
  }, [direction]);
  const seeds = useMemo(() => {
    const randomness = THREE.MathUtils.clamp(RAILGUN_IMPACT_TUNING.randomness, 0, 1);
    return Array.from({ length: particleCount }, (_, index) => {
      const a = seededSparkNoise(index, 2.17);
      const b = seededSparkNoise(index, 6.31);
      const c = seededSparkNoise(index, 10.89);
      const d = seededSparkNoise(index, 14.27);
      return {
        side: (a - 0.5) * (0.7 + RAILGUN_IMPACT_TUNING.spread * 0.65),
        lift: (b - 0.38) * (0.46 + RAILGUN_IMPACT_TUNING.arc),
        punch: 0.45 + c * (1.35 + randomness),
        speed: 1 + d * 1.4,
        delay: a * 25,
        colorMix: b,
      };
    });
  }, [particleCount]);
  const primary = useMemo(() => new THREE.Color(RAILGUN_IMPACT_TUNING.color), []);
  const secondary = useMemo(() => new THREE.Color(RAILGUN_IMPACT_TUNING.secondaryColor), []);
  const workingColorRef = useRef(new THREE.Color());
  const sparkSize = Math.max(0.01, 0.055 * RAILGUN_IMPACT_TUNING.size * RAILGUN_IMPACT_TUNING.thickness);

  useFrame(() => {
    const ageMs = performance.now() - startRef.current - delayMs;
    const active = ageMs >= 0 && ageMs <= 620;
    const positions = geometry.getAttribute("position").array as Float32Array;
    const colors = geometry.getAttribute("color").array as Float32Array;
    for (let i = 0; i < seeds.length; i += 1) {
      const seed = seeds[i];
      const idx = i * 3;
      if (!active || ageMs < seed.delay) {
        positions[idx] = 0;
        positions[idx + 1] = 0;
        positions[idx + 2] = 0;
        colors[idx] = 0;
        colors[idx + 1] = 0;
        colors[idx + 2] = 0;
        continue;
      }
      const t = THREE.MathUtils.clamp((ageMs - seed.delay) * 0.001 * RAILGUN_IMPACT_TUNING.speed, 0, 1);
      const fade =
        THREE.MathUtils.clamp(1 - t, 0, 1) *
        THREE.MathUtils.clamp(t / 0.08, 0, 1) *
        RAILGUN_IMPACT_TUNING.fade;
      const burst = RAILGUN_IMPACT_TUNING.spread * seed.speed * (1 - Math.pow(1 - t, 2));
      const point = axes.forwardAxis.clone().multiplyScalar(seed.punch * burst)
        .add(axes.sideAxis.clone().multiplyScalar(seed.side * burst))
        .add(axes.upAxis.clone().multiplyScalar(seed.lift * burst));
      positions[idx] = point.x;
      positions[idx + 1] = point.y;
      positions[idx + 2] = point.z;
      const color = workingColorRef.current.copy(primary).lerp(secondary, seed.colorMix * 0.86);
      color.multiplyScalar(fade * RAILGUN_IMPACT_TUNING.intensity);
      colors[idx] = color.r;
      colors[idx + 1] = color.g;
      colors[idx + 2] = color.b;
    }
    geometry.getAttribute("position").needsUpdate = true;
    geometry.getAttribute("color").needsUpdate = true;
  });

  return (
    <points geometry={geometry} position={position.toArray()} raycast={() => null}>
      <pointsMaterial
        size={sparkSize}
        sizeAttenuation
        transparent
        opacity={0.92}
        vertexColors
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        toneMapped={false}
      />
    </points>
  );
}

function RailgunWeaponFx({
  from,
  to,
  hits,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  hits: number;
}) {
  const startRef = useRef<number>(performance.now());
  const direction = useMemo(() => new THREE.Vector3().subVectors(to, from).normalize(), [from, to]);
  const targetDistance = from.distanceTo(to);
  const totalDistance = targetDistance + RAILGUN_OVERPENETRATION_INCHES;
  const targetDelayMs = totalDistance > 0 ? RAILGUN_FLIGHT_MS * THREE.MathUtils.clamp(targetDistance / totalDistance, 0, 1) : RAILGUN_FLIGHT_MS;
  return (
    <>
      <Suspense fallback={null}>
        <RailgunProjectileFx from={from} to={to} startRef={startRef} />
      </Suspense>
      {Array.from({ length: hits }).map((_, i) => (
        <RailgunImpactSparksFx
          key={i}
          position={to}
          direction={direction}
          delayMs={targetDelayMs + i * 45}
        />
      ))}
    </>
  );
}

function MissileEngineGlow() {
  const coreRef = useRef<THREE.MeshBasicMaterial>(null);
  const haloRef = useRef<THREE.MeshBasicMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const flareSize = MISSILE_TUNING.flareSize;

  useFrame(() => {
    const pulse = (Math.sin(performance.now() * 0.018) + 1) / 2;
    if (coreRef.current) coreRef.current.opacity = 0.74 + pulse * 0.2;
    if (haloRef.current) haloRef.current.opacity = (0.18 + pulse * 0.16) * MISSILE_TUNING.intensity;
    if (lightRef.current) lightRef.current.intensity = (0.7 + pulse * 1.3) * MISSILE_TUNING.intensity;
  });

  return (
    <group>
      <mesh raycast={() => null}>
        <sphereGeometry args={[0.014 * flareSize, 14, 14]} />
        <meshBasicMaterial
          ref={coreRef}
          color={MISSILE_TUNING.secondaryColor}
          transparent
          opacity={0.8}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh raycast={() => null}>
        <sphereGeometry args={[0.042 * flareSize, 18, 18]} />
        <meshBasicMaterial
          ref={haloRef}
          color={MISSILE_TUNING.color}
          transparent
          opacity={0.2}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <pointLight
        ref={lightRef}
        color={MISSILE_TUNING.color}
        intensity={0.9}
        distance={0.38 * flareSize}
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
      <MissileEngineGlow />
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
  const sparkParticleCount = MISSILE_TUNING.sparkCount;
  const sparkTrailGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(sparkParticleCount * 3), 3),
    );
    geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(sparkParticleCount * 3), 3),
    );
    return geometry;
  }, [sparkParticleCount]);
  const sparkSeeds = useMemo(
    () =>
      Array.from({ length: sparkParticleCount }, (_, sparkIndex) => {
        const a = seededSparkNoise(index * 197 + sparkIndex, 0.23);
        const b = seededSparkNoise(index * 197 + sparkIndex, 1.91);
        const c = seededSparkNoise(index * 197 + sparkIndex, 5.47);
        const d = seededSparkNoise(index * 197 + sparkIndex, 9.83);
        return {
          lag: 0.018 + (sparkIndex / Math.max(1, sparkParticleCount - 1)) * (0.18 + MISSILE_TUNING.fade * 0.05),
          side: (a - 0.5) * (0.18 + MISSILE_TUNING.spread * 0.22) * (1 + MISSILE_TUNING.sparkRandomness * 0.35),
          lift: (b - 0.35) * (0.05 + MISSILE_TUNING.arc * 0.18),
          drift: (c - 0.5) * (0.08 + MISSILE_TUNING.spread * 0.12),
          phase: d * 8.5,
          colorMix: b,
          brightness: 0.55 + c * 0.55,
        };
      }),
    [index, sparkParticleCount],
  );

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
    return flight.start.clone().lerp(flight.end, t);
  };

  const directionAt = (t: number) => {
    const ahead = pointAt(Math.min(1, t + 0.012));
    const behind = pointAt(Math.max(0, t - 0.012));
    return ahead.sub(behind).normalize();
  };

  useFrame(() => {
    const group = missileRef.current;
    if (!group) return;
    const positions = sparkTrailGeometry.getAttribute("position").array as Float32Array;
    const colors = sparkTrailGeometry.getAttribute("color").array as Float32Array;
    const primary = new THREE.Color(MISSILE_TUNING.color);
    const secondary = new THREE.Color(MISSILE_TUNING.secondaryColor);
    const workingColor = new THREE.Color();

    const durationMs = MISSILE_FLIGHT_MS;
    const delayMs = MISSILE_LAUNCH_DELAYS_MS[index] ?? MISSILE_LAUNCH_DELAYS_MS[MISSILE_LAUNCH_DELAYS_MS.length - 1];
    const elapsed = performance.now() - startRef.current - delayMs;
    if (elapsed < 0) {
      group.visible = false;
      colors.fill(0);
      sparkTrailGeometry.getAttribute("color").needsUpdate = true;
      return;
    }

    const t = Math.min(1, elapsed / durationMs);
    const current = pointAt(t);
    const direction = directionAt(t);
    const visible = t < 1;
    group.visible = visible;
    group.position.copy(current);
    group.quaternion.setFromUnitVectors(forward, direction);

    const side = new THREE.Vector3(-direction.z, 0, direction.x).normalize();
    const isTrailVisible = visible && t > 0.02;
    const timelineSeconds = performance.now() / 1000;
    for (let sparkIndex = 0; sparkIndex < sparkSeeds.length; sparkIndex += 1) {
      const seed = sparkSeeds[sparkIndex];
      const idx = sparkIndex * 3;
      if (!isTrailVisible || t - seed.lag <= 0) {
        positions[idx] = current.x;
        positions[idx + 1] = current.y;
        positions[idx + 2] = current.z;
        colors[idx] = 0;
        colors[idx + 1] = 0;
        colors[idx + 2] = 0;
        continue;
      }
      const lagT = THREE.MathUtils.clamp(t - seed.lag, 0, 1);
      const age = THREE.MathUtils.clamp(seed.lag / Math.max(0.001, 0.18 + MISSILE_TUNING.fade * 0.05), 0, 1);
      const flicker = 0.65 + Math.sin((timelineSeconds + seed.phase) * (6.5 + seed.brightness * 3)) * 0.28;
      const brightness = (1 - age) * seed.brightness * flicker * MISSILE_TUNING.intensity;
      const sparkPoint = pointAt(lagT)
        .add(side.clone().multiplyScalar(seed.side))
        .add(new THREE.Vector3(seed.drift, seed.lift, -seed.drift * 0.35));
      positions[idx] = sparkPoint.x;
      positions[idx + 1] = sparkPoint.y;
      positions[idx + 2] = sparkPoint.z;
      workingColor.copy(primary).lerp(secondary, seed.colorMix * 0.8).multiplyScalar(THREE.MathUtils.clamp(brightness, 0, 2.6));
      colors[idx] = workingColor.r;
      colors[idx + 1] = workingColor.g;
      colors[idx + 2] = workingColor.b;
    }
    sparkTrailGeometry.getAttribute("position").needsUpdate = true;
    sparkTrailGeometry.getAttribute("color").needsUpdate = true;
  });

  return (
    <>
      <group ref={missileRef} visible={false}>
        <Suspense fallback={null}>
          <MissileMeshModel />
        </Suspense>
      </group>
      <points geometry={sparkTrailGeometry} raycast={() => null}>
        <pointsMaterial
          size={Math.max(0.012, 0.055 * MISSILE_TUNING.size * MISSILE_TUNING.thickness)}
          sizeAttenuation
          transparent
          opacity={0.86}
          vertexColors
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </points>
    </>
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
  attackerHeading,
  hits,
  totalDice,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  weapon: Pick<Weapon, "id" | "name" | "traits" | "attackDice" | "arc">;
  attackerFaction: string;
  attackerName?: string;
  attackerModelFilename?: string;
  attackerHeading?: number;
  hits: number;
  totalDice: number;
}) {
  const kind = classifyWeapon(weapon);

  if (kind === "beam") {
    if (
      isVorlonSuperLightningCannon({
        weapon,
        attackerName,
        attackerModelFilename,
      })
    ) {
      return (
        <>
          <Suspense fallback={null}>
            <VorlonConvergenceFx
              from={from}
              to={to}
              headingDegrees={attackerHeading}
            />
          </Suspense>
          {Array.from({ length: hits }).map((_, i) => (
            <TargetImpactFx
              key={i}
              position={to}
              delayMs={VORLON_ATTACK_CHARGE_MS + 250 + i * 70}
              seed={i + 80}
            />
          ))}
        </>
      );
    }
    if (isKirishiacAttacker({ weapon, attackerName, attackerModelFilename })) {
      return (
        <>
          <Suspense fallback={null}>
            <KirishiacBeamFx
              from={from}
              to={to}
              outerShell={isKirishiacMainForwardBeam(weapon)}
            />
          </Suspense>
          {Array.from({ length: hits }).map((_, i) => (
            <TargetImpactFx
              key={i}
              position={to}
              delayMs={KIRISHIAC_ATTACK_TURN_IN_MS + 250 + i * 70}
              seed={i}
            />
          ))}
        </>
      );
    }
    const color =
      isShadowOmegaAttacker(attackerName, attackerModelFilename) &&
      isShadowOmegaCyanBeamWeapon(weapon)
        ? SHADOW_OMEGA_BEAM_COLOR
        : isWhiteStarAttacker(attackerName, attackerModelFilename)
          ? MINBARI_BEAM_COLOR
        : beamColorFor(attackerFaction, weapon);
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

  if (isRailWeapon(weapon)) {
    return <RailgunWeaponFx from={from} to={to} hits={hits} />;
  }

  // Default non-beam, non-missile projectiles (cannons / mass drivers / ion / pulse).
  const fighterProjectile = isFighterAttacker(attackerName, attackerModelFilename);
  const shadowFighterProjectile = isShadowFighterAttacker(
    attackerFaction,
    attackerName,
    attackerModelFilename,
  );
  const shadowOmegaPhasingPulse =
    isShadowOmegaAttacker(attackerName, attackerModelFilename) &&
    isShadowOmegaHeavyPhasingPulseWeapon(weapon);
  const whiteStarProjectile = isWhiteStarAttacker(
    attackerName,
    attackerModelFilename,
  );
  const projectileTuning = shadowOmegaPhasingPulse
    ? SHADOW_OMEGA_PHASING_PULSE_TUNING
    : whiteStarProjectile
      ? WHITE_STAR_PROJECTILE_TUNING
    : fighterProjectile
      ? shadowFighterProjectile
        ? SHADOW_FIGHTER_PROJECTILE_TUNING
        : FIGHTER_PROJECTILE_TUNING
      : CAPITAL_PROJECTILE_TUNING;
  const travelMs =
    FIGHTER_PROJECTILE_FLIGHT_MS /
    THREE.MathUtils.clamp(projectileTuning.speed, 0.25, 3);
  return (
    <>
      <MeshFighterProjectileSalvoFx
        from={from}
        to={to}
        tuning={projectileTuning}
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
