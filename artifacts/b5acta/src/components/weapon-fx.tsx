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

export type WeaponClass = "beam" | "tracer" | "missile";

const FACTION_BEAM_COLOR: Record<string, string> = {
  "Earth Alliance": "#ff2a2a",
  "Minbari Federation": "#22ff66",
  "Shadows": "#b85cff",
};
const DEFAULT_BEAM_COLOR = "#ff2a2a";
const TRACER_COLOR = "#ffa040";
const MISSILE_BODY_COLOR = "#ffd089";
const MISSILE_IMPACT_COLOR = "#ff7733";

// Match ACTA-style traits on the `traits` text field. Missiles are detected
// by name because the "Missile" trait isn't reliably present in the dataset.
export function classifyWeapon(weapon: Pick<Weapon, "name" | "traits">): WeaponClass {
  const traits = (weapon.traits ?? "").toLowerCase();
  const name = (weapon.name ?? "").toLowerCase();
  if (name.includes("missile")) return "missile";
  if (/\bmini[- ]?beam\b/.test(traits) || /\bbeam\b/.test(traits)) return "beam";
  return "tracer";
}

export function beamColorFor(faction: string): string {
  return FACTION_BEAM_COLOR[faction] ?? DEFAULT_BEAM_COLOR;
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
  lifeMs = 650,
  thickness = 0.09,
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
}) {
  const groupRef = useRef<THREE.Group>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const trailRef = useRef<THREE.MeshBasicMaterial>(null);

  useFrame(() => {
    const elapsed = performance.now() - startRef.current - delayMs;
    if (!groupRef.current || !matRef.current) return;
    if (elapsed < 0) {
      matRef.current.opacity = 0;
      if (trailRef.current) trailRef.current.opacity = 0;
      return;
    }
    const t = Math.min(1, elapsed / travelMs);
    const x = from.x + (to.x - from.x) * t;
    const yLinear = from.y + (to.y - from.y) * t;
    const y = yLinear + (arcHeight > 0 ? Math.sin(Math.PI * t) * arcHeight : 0);
    const z = from.z + (to.z - from.z) * t;
    groupRef.current.position.set(x, y, z);
    if (t < 1) {
      matRef.current.opacity = 1;
      if (trailRef.current) trailRef.current.opacity = 0.45;
    } else {
      const fadeT = (elapsed - travelMs) / fadeMs;
      const a = Math.max(0, 1 - fadeT);
      matRef.current.opacity = a;
      if (trailRef.current) trailRef.current.opacity = a * 0.45;
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
      {/* Soft trail blob */}
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
  const n = Math.max(1, Math.min(count, 8));
  return (
    <>
      {Array.from({ length: n }).map((_, i) => (
        <TravellingProjectile
          key={i}
          from={from}
          to={to}
          color={color}
          delayMs={i * 65}
          travelMs={340}
          startRef={startRef}
          size={0.16}
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
  const n = Math.max(1, Math.min(count, 5));
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
          travelMs={1000}
          startRef={startRef}
          size={0.22}
          arcHeight={2.5 + (i % 2) * 1.5}
          fadeMs={300}
        />
      ))}
    </>
  );
}

// ── Impact flash at the target ─────────────────────────────────────────────
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
    const color = beamColorFor(attackerFaction);
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

  // Tracer (cannons / mass drivers / ion / pulse).
  return (
    <>
      <TracerSalvoFx from={from} to={to} color={TRACER_COLOR} count={totalDice} />
      {Array.from({ length: hits }).map((_, i) => (
        <ImpactFlash
          key={i}
          position={to}
          color={TRACER_COLOR}
          delayMs={380 + i * 70}
          size={0.5}
        />
      ))}
    </>
  );
}
