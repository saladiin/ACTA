import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
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
const MISSILE_BODY_COLOR = "#ff6600";
const MISSILE_IMPACT_COLOR = "#ff0000";
const MISSILE_TUNING = {
  speed: 1.15,
  size: 0.4,
  fade: 1,
  intensity: 0.15,
  spread: 1.3,
  count: 8,
  arc: 1.45,
  thickness: 2.05,
};
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
function MissileVolleyFx({
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
  const n = Math.max(1, Math.min(count, MISSILE_TUNING.count));
  // Pop missiles into a small arc so they look like a salvo, not a single line.
  return (
    <>
      {Array.from({ length: n }).map((_, i) => (
        <TravellingProjectile
          key={i}
          from={from}
          to={to}
          color={color}
          delayMs={i * 130}
          travelMs={1000 / MISSILE_TUNING.speed}
          startRef={startRef}
          size={0.066 * MISSILE_TUNING.size}
          arcHeight={MISSILE_TUNING.arc * MISSILE_TUNING.spread * (1 + (i % 2) * 0.25)}
          fadeMs={300 * MISSILE_TUNING.fade}
          intensity={MISSILE_TUNING.intensity}
          ribbonTrail
          ribbonLengthT={0.12}
          ribbonWidth={0.18 * MISSILE_TUNING.thickness}
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

function ImpactFlash({
  position,
  color,
  delayMs = 0,
  lifeMs = 380,
  size = 0.8,
}: {
  position: THREE.Vector3;
  color: string;
  delayMs?: number;
  lifeMs?: number;
  size?: number;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const startRef = useRef<number>(performance.now());

  useFrame(() => {
    const elapsed = performance.now() - startRef.current - delayMs;
    if (!meshRef.current || !matRef.current) return;
    if (elapsed < 0) {
      meshRef.current.scale.setScalar(0.001);
      matRef.current.opacity = 0;
      if (lightRef.current) lightRef.current.intensity = 0;
      return;
    }
    const t = Math.min(1, elapsed / lifeMs);
    // Quick expansion + alpha falloff.
    const scale = size * (0.25 + t * 1.8);
    const alpha = 1 - t;
    meshRef.current.scale.setScalar(scale);
    matRef.current.opacity = alpha;
    if (lightRef.current) lightRef.current.intensity = alpha * 5;
  });

  return (
    <group position={position.toArray()}>
      <mesh ref={meshRef} raycast={() => null}>
        <sphereGeometry args={[1, 12, 12]} />
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
      <pointLight ref={lightRef} color={color} distance={8} decay={2} intensity={0} />
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
  hits,
  totalDice,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  weapon: Pick<Weapon, "id" | "name" | "traits" | "attackDice">;
  attackerFaction: string;
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
          <ImpactFlash
            key={i}
            position={to}
            color={color}
            delayMs={250 + i * 70}
            size={0.7}
          />
        ))}
      </>
    );
  }

  if (kind === "missile") {
    // One missile per attack die looks busy on big racks; clamp inside the FX.
    return (
      <>
        <MissileVolleyFx from={from} to={to} color={MISSILE_BODY_COLOR} count={totalDice} />
        {Array.from({ length: hits }).map((_, i) => (
          <ImpactFlash
            key={i}
            position={to}
            color={MISSILE_IMPACT_COLOR}
            delayMs={1050 + i * 90}
            size={1.3}
          />
        ))}
      </>
    );
  }

  if (kind === "energy-mine") {
    return <EnergyMineFx from={from} to={to} />;
  }

  // Tracer (cannons / mass drivers / ion / pulse).
  const tracerColors = tracerColorsFor(attackerFaction, weapon);
  return (
    <>
      <TracerSalvoFx from={from} to={to} color={tracerColors.color} count={totalDice} />
      {Array.from({ length: hits }).map((_, i) => (
        <ImpactFlash
          key={i}
          position={to}
          color={tracerColors.impact}
          delayMs={380 + i * 70}
          size={0.5}
        />
      ))}
    </>
  );
}
