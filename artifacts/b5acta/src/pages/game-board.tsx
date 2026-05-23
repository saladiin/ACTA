import React, { useState, useRef, Suspense, useMemo, useEffect, useCallback } from "react";
import { useParams, Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Canvas, useLoader, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Text, useGLTF, Line } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { WeaponFx } from "@/components/weapon-fx";
// @ts-ignore
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
// @ts-ignore
import * as THREE from "three";
import {
  useGetGame,
  useAcceptGame,
  useDeclineGame,
  useDeployFleet,
  useSubmitTurn,
  useMoveUnit,
  useDevMoveUnit,
  useActivateUnit,
  useEndActivation,
  useFireWeapon,
  useDamageControl,
  useSurrenderGame,
  useChooseSpecialAction,
  useListFleets,
  useListFleetShips,
  useListShipModels,
  getGetGameQueryKey,
  getListTurnsQueryKey,
  getListFleetShipsQueryKey,
} from "@workspace/api-client-react";
import type { ShipModel, Weapon, FireWeaponResult } from "@workspace/api-client-react";
import { useUser } from "@clerk/react";
import { useDevUserId } from "../lib/dev-user";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Swords, Shield, Target, CheckCircle, XCircle, Crosshair, Move, Zap, Wrench, RotateCw, RotateCcw, ArrowUp, ArrowDown, ArrowLeft, ArrowRight } from "lucide-react";
import { Switch } from "@/components/ui/switch";

// Storage convention: `hexQ` / `hexR` columns hold WORLD INCHES (the field
// names are historical). Render coordinates are 1:1 with storage, so this
// is an identity mapping kept as a single function so we can audit every
// callsite in one place.
function hexToWorld(q: number, r: number): [number, number, number] {
  return [q, 0, r];
}

// Board is 48" wide × 72" deep, 1 world unit = 1 inch
const BOARD_W = 48;
const BOARD_D = 72;

function SpaceGrid() {
  return (
    <>
      {/* Fine 1" grid */}
      <gridHelper args={[72, 72, "#0d1a0d", "#0a140a"]} position={[0, -0.01, 0]} />
      {/* Bold 6" grid overlay */}
      <gridHelper args={[72, 12, "#172617", "#172617"]} position={[0, -0.005, 0]} />
    </>
  );
}

// Translucent floor quads marking each player's deployment zone. The
// challenger's zone hugs the +Z short edge; the opponent's hugs -Z. Depth (in
// inches) is configured at game creation (4..30) and enforced server-side.
function DeploymentZones({ depth, mySide }: { depth: number; mySide: "challenger" | "opponent" | null }) {
  const hd = BOARD_D / 2; // 36
  const w = BOARD_W;
  // Player zones: centred at z = ±(36 - depth/2), depth tall, full board wide.
  const challengerZ = hd - depth / 2;
  const opponentZ = -hd + depth / 2;
  return (
    <>
      <mesh position={[0, 0.001, challengerZ]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
        <planeGeometry args={[w, depth]} />
        <meshBasicMaterial color={mySide === "challenger" ? "#f59e0b" : "#7c2d12"} transparent opacity={mySide === "challenger" ? 0.12 : 0.06} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.001, opponentZ]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
        <planeGeometry args={[w, depth]} />
        <meshBasicMaterial color={mySide === "opponent" ? "#f59e0b" : "#7c2d12"} transparent opacity={mySide === "opponent" ? 0.12 : 0.06} depthWrite={false} />
      </mesh>
    </>
  );
}

function BoardBoundary() {
  const geo = useMemo(() => {
    const hw = BOARD_W / 2; // 24
    const hd = BOARD_D / 2; // 36
    const pts = [
      new THREE.Vector3(-hw, 0, -hd),
      new THREE.Vector3( hw, 0, -hd),
      new THREE.Vector3( hw, 0,  hd),
      new THREE.Vector3(-hw, 0,  hd),
      new THREE.Vector3(-hw, 0, -hd),
    ];
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, []);

  return (
    // @ts-ignore – R3F line primitive
    <line geometry={geo}>
      <lineBasicMaterial color="#f59e0b" />
    </line>
  );
}

// Compute a uniform scale so the model's longest horizontal dimension = targetInches world units
function shipScale(object: THREE.Object3D, targetInches = 2): number {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxH = Math.max(size.x, size.z);
  return maxH > 0 ? targetInches / maxH : 1;
}

// OBJ: geometry-only load (no MTL — we apply tint via MeshStandardMaterial)
function ObjModel({ url, tint }: { url: string; tint: string }) {
  const obj = useLoader(OBJLoader, url) as THREE.Group;
  const { cloned, s } = useMemo(() => {
    const c = obj.clone(true);
    c.traverse((child: any) => {
      if (!child.isMesh) return;
      // material may be a single material or an array — normalise to array
      const mats: any[] = Array.isArray(child.material) ? child.material : [child.material];
      const tinted = mats.map((m: any) => {
        if (!m) return new THREE.MeshStandardMaterial({ color: tint, metalness: 0.3, roughness: 0.6 });
        if (m.map) {
          const clonedMat = m.clone();
          clonedMat.emissive = new THREE.Color(tint);
          clonedMat.emissiveIntensity = 0.12;
          return clonedMat;
        }
        return new THREE.MeshStandardMaterial({ color: tint, metalness: 0.3, roughness: 0.6 });
      });
      child.material = Array.isArray(child.material) ? tinted : tinted[0];
    });
    return { cloned: c, s: shipScale(c) };
  }, [obj, tint]);
  return <primitive object={cloned} scale={[s, s, s]} />;
}

// GLB: keep original embedded textures; apply a gentle emissive tint for team color.
// Models must be exported nose-along-local-+Z per the Model orientation spec
// in replit.md. FLIP_MODELS is kept as an (empty) set so the render-time and
// arc-math fallbacks below remain available for any one-off legacy upload, but
// the canonical fix is to re-export the model with correct orientation.
const FLIP_MODELS: Set<string> = new Set();
function GlbModel({ url, tint, filename }: { url: string; tint: string; filename: string }) {
  const { scene } = useGLTF(url);
  const cloned = useMemo(() => {
    const c = scene.clone(true);
    c.traverse((child: any) => {
      if (child.isMesh) {
        child.material = child.material.clone();
        child.material.emissive = new THREE.Color(tint);
        child.material.emissiveIntensity = 0.18;
      }
    });
    return c;
  }, [scene, tint]);
  const s = useMemo(() => shipScale(cloned), [cloned]);
  const flip = FLIP_MODELS.has(filename);
  return <primitive object={cloned} scale={[s, s, s]} rotation={[0, flip ? Math.PI : 0, 0]} />;
}

class ModelErrorBoundary extends React.Component<
  { color: string; children: React.ReactNode },
  { error: boolean }
> {
  constructor(props: { color: string; children: React.ReactNode }) {
    super(props);
    this.state = { error: false };
  }
  static getDerivedStateFromError() { return { error: true }; }
  render() {
    if (this.state.error) return <ShipModelFallback color={this.props.color} />;
    return this.props.children;
  }
}

function ShipModelFallback({ color }: { color: string }) {
  return (
    <mesh>
      <boxGeometry args={[0.6, 0.2, 1.2]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

// Cache HEAD-check results so each URL is only fetched once per session
const modelExistsCache = new Map<string, boolean>();

function useModelExists(url: string): boolean | null {
  const [exists, setExists] = useState<boolean | null>(
    modelExistsCache.has(url) ? modelExistsCache.get(url)! : null
  );
  useEffect(() => {
    if (modelExistsCache.has(url)) { setExists(modelExistsCache.get(url)!); return; }
    fetch(url, { method: "HEAD" })
      .then(r => { modelExistsCache.set(url, r.ok); setExists(r.ok); })
      .catch(() => { modelExistsCache.set(url, false); setExists(false); });
  }, [url]);
  return exists;
}

function ShipModel3D({ filename, tint }: { filename: string; tint: string }) {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const url = `${basePath}/api/models/${filename}`;
  const isGlb = filename.toLowerCase().endsWith(".glb") || filename.toLowerCase().endsWith(".gltf");
  const exists = useModelExists(url);
  // null = check in-flight; false = file missing — both show fallback box
  if (!exists) return <ShipModelFallback color={tint} />;
  if (isGlb) return <GlbModel url={url} tint={tint} filename={filename} />;
  return <ObjModel url={url} tint={tint} />;
}

function GameUnit3D({ unit, isSelected, onClick, myUserId, weapons, dragOffset, dimmed, firingArc }: {
  unit: { id: number; hexQ: number; hexR: number; heading: number; name: string; modelFilename: string; ownerId: string; hullPoints: number; maxHullPoints: number; isDestroyed: boolean; faction: string; speed: number; turnAngle: number };
  isSelected: boolean;
  onClick: () => void;
  myUserId: string;
  weapons: Pick<Weapon, "arc">[];
  dragOffset?: { x: number; z: number } | null;
  dimmed?: boolean;
  // When set, draws a translucent "weapon coverage" sector at full range for
  // the currently-selected firing weapon so the player can see eligible
  // targets. Only rendered for the active firing ship.
  firingArc?: { arc: string; range: number } | null;
}) {
  const [bx, , bz] = hexToWorld(unit.hexQ, unit.hexR);
  const x = bx + (dragOffset?.x ?? 0);
  const z = bz + (dragOffset?.z ?? 0);
  const isMine = unit.ownerId === myUserId;
  // mine = green, enemy = red; selected mine = blue, selected enemy = yellow.
  // Dimmed = activated already this round.
  const color = unit.isDestroyed
    ? "#4b5563"
    : dimmed
      ? (isMine ? "#166534" : "#7f1d1d")
      : isSelected
        ? (isMine ? "#3b82f6" : "#eab308")
        : (isMine ? "#22c55e" : "#ef4444");
  const hpPct = unit.hullPoints / unit.maxHullPoints;
  const headingRad = (unit.heading * Math.PI) / 180;

  return (
    <group position={[x, 0, z]} onClick={onClick}>
      {/* Translucent circular base at grid level */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <circleGeometry args={[1.2, 48]} />
        <meshStandardMaterial color={color} transparent opacity={0.15} depthWrite={false} />
      </mesh>
      {/* Base ring edge */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <ringGeometry args={[1.15, 1.2, 48]} />
        <meshStandardMaterial color={color} transparent opacity={isSelected ? 0.9 : 0.45} emissive={color} emissiveIntensity={isSelected ? 0.6 : 0.15} />
      </mesh>
      {/* Selection pulse ring */}
      {isSelected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
          <ringGeometry args={[1.3, 1.45, 48]} />
          <meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={0.8} transparent opacity={0.7} />
        </mesh>
      )}
      {/* Weapon arcs — rotate with heading */}
      {isSelected && weapons.length > 0 && (
        <group rotation={[0, headingRad, 0]}>
          <WeaponArcDisplay weapons={weapons} flip={FLIP_MODELS.has(unit.modelFilename)} />
        </group>
      )}
      {/* Firing coverage — long-range arc showing eligible-target area */}
      {firingArc && (
        <group rotation={[0, headingRad, 0]}>
          <RangeArcOverlay
            arc={firingArc.arc}
            range={firingArc.range}
            flip={FLIP_MODELS.has(unit.modelFilename)}
          />
        </group>
      )}
      {/* Ship model floating 2" above the base, rotated to heading */}
      <group position={[0, 2, 0]} rotation={[0, headingRad, 0]}>
        <ModelErrorBoundary color={color}>
          <Suspense fallback={<ShipModelFallback color={color} />}>
            <ShipModel3D filename={unit.modelFilename} tint={color} />
          </Suspense>
        </ModelErrorBoundary>
        {unit.isDestroyed && <DestroyedSmoke />}
      </group>
      {/* HP bar above ship */}
      <group position={[0, 3.2, 0]}>
        <mesh>
          <planeGeometry args={[2, 0.18]} />
          <meshBasicMaterial color="#1f2937" transparent opacity={0.9} />
        </mesh>
        <mesh position={[-1 * (1 - hpPct), 0, 0.001]} scale={[hpPct, 1, 1]}>
          <planeGeometry args={[2, 0.15]} />
          <meshBasicMaterial color={hpPct > 0.5 ? "#22c55e" : hpPct > 0.25 ? "#f59e0b" : "#ef4444"} />
        </mesh>
      </group>
      <Text position={[0, 3.7, 0]} fontSize={0.4} color="white" anchorX="center" anchorY="middle" outlineWidth={0.04} outlineColor="black">
        {unit.name.slice(0, 14)}
      </Text>
    </group>
  );
}

// ── Destroyed-ship smoke puffs ────────────────────────────────────────────────
// Tiny animated smoke effect for destroyed hulls. Each puff is a billboarded
// soft sprite that rises slowly and fades. Total horizontal travel is capped
// at 0.5" from the ship's mesh center per the spec; puffs respawn at the
// origin when their lifetime expires.
const SMOKE_PUFF_COUNT = 5;
const SMOKE_MAX_RADIUS = 0.5;       // inches from mesh center (horizontal cap)
const SMOKE_MAX_RISE = 0.5;         // inches above mesh center (vertical cap)
const SMOKE_LIFETIME = 2.2;         // seconds per puff
function DestroyedSmoke() {
  const groupRef = useRef<THREE.Group>(null);
  // Per-puff state: random horizontal drift direction + phase offset so puffs
  // don't all bloom in lockstep. Allocated once.
  const puffs = useMemo(() => {
    return Array.from({ length: SMOKE_PUFF_COUNT }, (_, i) => ({
      angle: Math.random() * Math.PI * 2,
      driftRadius: 0.15 + Math.random() * 0.25, // ≤ 0.4" horizontal drift target
      phase: (i / SMOKE_PUFF_COUNT) * SMOKE_LIFETIME + Math.random() * 0.3,
      scale: 0.18 + Math.random() * 0.12,
    }));
  }, []);
  useFrame(({ clock }) => {
    const g = groupRef.current;
    if (!g) return;
    const t = clock.getElapsedTime();
    for (let i = 0; i < puffs.length; i++) {
      const p = puffs[i]!;
      const local = ((t + p.phase) % SMOKE_LIFETIME) / SMOKE_LIFETIME; // 0..1
      const child = g.children[i] as THREE.Mesh | undefined;
      if (!child) continue;
      // Horizontal drift eases out; rise is linear; opacity fades quadratically.
      const drift = Math.min(p.driftRadius * local, SMOKE_MAX_RADIUS);
      child.position.x = Math.cos(p.angle) * drift;
      child.position.z = Math.sin(p.angle) * drift;
      child.position.y = local * SMOKE_MAX_RISE;
      const s = p.scale * (0.6 + local * 0.8);
      child.scale.set(s, s, s);
      const mat = child.material as THREE.MeshBasicMaterial;
      mat.opacity = (1 - local) * (1 - local) * 0.55;
    }
  });
  return (
    <group ref={groupRef}>
      {puffs.map((_, i) => (
        <mesh key={i} renderOrder={10}>
          <sphereGeometry args={[1, 8, 8]} />
          <meshBasicMaterial color="#1f2937" transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

// ── Arc visualization ─────────────────────────────────────────────────────────
// Coordinate mapping: arc mesh uses rotation [+π/2, 0, 0] so shape +Y = world +Z = forward.
// All angles are in shape-space radians (counterclockwise from shape +X).
// In a right-handed frame (Y up, +Z forward), anatomical right = forward × up
// = +Z × +Y = -X, so STARBOARD is shape -X (π) and PORT is shape +X (0).
//   Forward   = shape +Y direction = 90° (π/2)
//   Port      = shape +X direction = 0°
//   Aft       = shape -Y direction = 270° (-π/2)
//   Starboard = shape -X direction = 180° (π)
const ARC_DEFS: Record<string, { centerAngle: number; halfAngle: number; color: string; opacity: number; radius?: number }> = {
  "Forward":           { centerAngle: Math.PI / 2,  halfAngle: Math.PI / 4,  color: "#f59e0b", opacity: 0.30 },
  "Port":              { centerAngle: 0,             halfAngle: Math.PI / 4,  color: "#06b6d4", opacity: 0.24 },
  "Starboard":         { centerAngle: Math.PI,       halfAngle: Math.PI / 4,  color: "#06b6d4", opacity: 0.24 },
  "Aft":               { centerAngle: -Math.PI / 2, halfAngle: Math.PI / 4,  color: "#ef4444", opacity: 0.22 },
  "Boresight Forward": { centerAngle: Math.PI / 2,  halfAngle: Math.PI / 24, color: "#fef08a", opacity: 0.85, radius: 1.65 },
  "Boresight Aft":     { centerAngle: -Math.PI / 2, halfAngle: Math.PI / 24, color: "#fb923c", opacity: 0.75, radius: 1.65 },
  // Turrets fire in any direction → full 360° sector. centerAngle is arbitrary
  // since halfAngle = π covers the entire circle.
  "Turret":            { centerAngle: Math.PI / 2,  halfAngle: Math.PI,      color: "#a78bfa", opacity: 0.22 },
};

// Label positions in the heading-group's local XZ space (local +Z = world forward)
const ARC_LABELS: Record<string, { pos: [number, number, number]; label: string }> = {
  "Forward":           { pos: [0,    0.07,  1.35], label: "FWD"  },
  "Port":              { pos: [1.35, 0.07,  0],    label: "PORT" },
  "Starboard":         { pos: [-1.35,0.07,  0],    label: "STBD" },
  "Aft":               { pos: [0,    0.07, -1.35], label: "AFT"  },
  "Boresight Forward": { pos: [0,    0.07,  1.72], label: "BS-F" },
  "Boresight Aft":     { pos: [0,    0.07, -1.72], label: "BS-A" },
};

function ArcSector({ centerAngle, halfAngle, radius, color, opacity }: {
  centerAngle: number;
  halfAngle: number;
  radius: number;
  color: string;
  opacity: number;
}) {
  const geo = useMemo(() => {
    const segments = halfAngle < 0.3 ? 8 : 36;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    for (let i = 0; i <= segments; i++) {
      const a = centerAngle - halfAngle + (2 * halfAngle * i) / segments;
      shape.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
    }
    shape.lineTo(0, 0);
    return new THREE.ShapeGeometry(shape);
  }, [centerAngle, halfAngle, radius]);
  return (
    <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.022, 0]} geometry={geo}>
      <meshBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

// Long-range coverage arc for the FIRING PHASE — drawn at the weapon's actual
// range (in world inches) so the player can see where its eligible targets lie.
// Uses the same ARC_DEFS angles as the base arcs so the visual and server's
// `isInArc` adjudication line up; flip handling matches WeaponArcDisplay.
function RangeArcOverlay({ arc, range, flip }: { arc: string; range: number; flip: boolean }) {
  const def = ARC_DEFS[arc];
  const geo = useMemo(() => {
    if (!def) return null;
    const segments = def.halfAngle < 0.3 ? 16 : 64;
    const centerAngle = flip ? def.centerAngle + Math.PI : def.centerAngle;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    for (let i = 0; i <= segments; i++) {
      const a = centerAngle - def.halfAngle + (2 * def.halfAngle * i) / segments;
      shape.lineTo(Math.cos(a) * range, Math.sin(a) * range);
    }
    shape.lineTo(0, 0);
    return new THREE.ShapeGeometry(shape);
  }, [def, range, flip]);

  // Outline polyline: origin → arc → origin (rotated into XZ plane so it
  // sits on the board, matching the fill mesh's rotation).
  const edgePoints = useMemo<[number, number, number][] | null>(() => {
    if (!def) return null;
    const segments = def.halfAngle < 0.3 ? 16 : 64;
    const centerAngle = flip ? def.centerAngle + Math.PI : def.centerAngle;
    const pts: [number, number, number][] = [[0, 0, 0]];
    for (let i = 0; i <= segments; i++) {
      const a = centerAngle - def.halfAngle + (2 * def.halfAngle * i) / segments;
      // Shape's local (X, Y) → world (X, Z) because we rotate the fill by +π/2 on X.
      pts.push([Math.cos(a) * range, 0, Math.sin(a) * range]);
    }
    pts.push([0, 0, 0]);
    return pts;
  }, [def, range, flip]);

  if (!def || !geo || !edgePoints) return null;
  return (
    <>
      {/* Translucent fill */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.018, 0]} geometry={geo}>
        <meshBasicMaterial
          color={def.color}
          transparent
          opacity={0.10}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Outline along the arc + radial edges so the boundary reads clearly */}
      <Line points={edgePoints} color={def.color} lineWidth={1.5} transparent opacity={0.85} position={[0, 0.05, 0]} />
    </>
  );
}

// For ships whose OBJ is flipped 180° inside the heading group, the entire arc
// frame must be rotated 180° so the visual arcs match the server's adjudication
// (server uses `effHeading = heading + 180` for FLIP_MODELS — see games.ts).
// Rotating by +π handles both axial arcs (Forward/Aft/Boresight) AND lateral
// arcs (Port/Starboard) correctly, where the older "negate axial-only" trick
// silently mirrored port/starboard onto the wrong side of the hull.
function WeaponArcDisplay({ weapons, flip = false }: { weapons: Pick<Weapon, "arc">[]; flip?: boolean }) {
  const uniqueArcs = useMemo(() => [...new Set(weapons.map(w => w.arc))], [weapons]);
  return (
    <>
      {uniqueArcs.map(arc => {
        const def = ARC_DEFS[arc];
        if (!def) return null;
        const centerAngle = flip ? def.centerAngle + Math.PI : def.centerAngle;
        return (
          <ArcSector
            key={arc}
            centerAngle={centerAngle}
            halfAngle={def.halfAngle}
            radius={def.radius ?? 1.2}
            color={def.color}
            opacity={def.opacity}
          />
        );
      })}
      {uniqueArcs.map(arc => {
        const lbl = ARC_LABELS[arc];
        const def = ARC_DEFS[arc];
        if (!lbl || !def) return null;
        const pos: [number, number, number] = flip
          ? [-lbl.pos[0], lbl.pos[1], -lbl.pos[2]]
          : lbl.pos;
        return (
          <Text
            key={`lbl-${arc}`}
            position={pos}
            fontSize={0.17}
            color={def.color}
            anchorX="center"
            anchorY="middle"
            outlineWidth={0.03}
            outlineColor="black"
          >
            {lbl.label}
          </Text>
        );
      })}
      {/* Turret: inner circle on the base + centred label */}
      {uniqueArcs.includes("Turret") && (
        <>
          <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.026, 0]}>
            <ringGeometry args={[0.46, 0.54, 48]} />
            <meshBasicMaterial color="#a855f7" transparent opacity={0.75} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
          <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}>
            <circleGeometry args={[0.46, 48]} />
            <meshBasicMaterial color="#a855f7" transparent opacity={0.18} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
          <Text
            position={[0, 0.09, 0]}
            fontSize={0.17}
            color="#a855f7"
            anchorX="center"
            anchorY="middle"
            outlineWidth={0.03}
            outlineColor="black"
          >
            TUR
          </Text>
        </>
      )}
    </>
  );
}

// ── Movement planning (forward / turn previews, keyboard + mouse-drag) ───────
// turn.deltaDeg is signed: positive = clockwise (R), negative = counter-clockwise (Shift+R).
// forward.distance is in inches (world units), 0..remaining-speed, controlled by mouse drag.
// Dice-modal staging. The reveal is gated behind explicit confirm buttons:
//   pending        → server roll in flight (no result yet)
//   attack-ready   → result cached; press "Roll to Hit" to reveal attack dice
//   attack-rolling → attack dice shuffle animation (~700ms)
//   attack-shown   → attack dice revealed. If hits>0 prompt damage; else close.
//   damage-ready   → press "Roll Damage" to reveal damage/crit dice
//   damage-rolling → damage dice shuffle animation
//   damage-shown   → full result + summary; press "Close"
//   error          → server rejected the shot (e.g. out of arc / range)
// `confirmingClose` overlays a Yes/Cancel prompt so the player can't dismiss
// the modal by accident and lose track of what just happened.
type DiceModalPhase =
  | "pending"
  | "attack-ready"
  | "attack-rolling"
  | "attack-shown"
  | "damage-ready"
  | "damage-rolling"
  | "damage-shown"
  // Per-crit reveal: the server already rolled the location + effect dice
  // atomically, but the player wants to feel each crit being rolled. We
  // walk the criticalsApplied array one entry at a time via critIndex.
  | "crit-ready"
  | "crit-rolling"
  | "crit-shown"
  | "error";
type DiceModalState = {
  weapon: Weapon;
  // The attacker is captured at fire-time (rather than read live from
  // activeUnitId) so the weapon-fx beam/tracer/missile renders from the right
  // origin even if the player ends activation or selects another ship while
  // the dice modal is still open.
  attackerUnitId: number;
  targetName: string;
  targetId: number;
  attackDice: number;
  phase: DiceModalPhase;
  result?: FireWeaponResult;
  error?: string;
  confirmingClose?: boolean;
  // Index into result.criticalsApplied for the per-crit reveal walk. Only
  // meaningful in phases crit-ready / crit-rolling / crit-shown.
  critIndex?: number;
};

type MovePlan =
  | { kind: "forward"; distance: number }
  | { kind: "turn"; deltaDeg: number }
  | null;

// Heading → unit world-space forward vector (accounting for FLIP_MODELS which
// render their visual nose along local -Z).
function headingForwardVec(unit: { heading: number; modelFilename: string }): { x: number; z: number } {
  const flip = FLIP_MODELS.has(unit.modelFilename);
  const sign = flip ? -1 : 1;
  const hRad = (unit.heading * Math.PI) / 180;
  return { x: sign * Math.sin(hRad), z: sign * Math.cos(hRad) };
}

// Annular sector mesh — used for the turn-arc preview that hugs the ship base.
// Shape-space coords (mesh has +π/2 X rotation): shape +Y = world +Z (forward),
// shape +X = world +X (starboard). Forward = angle π/2, starboard = 0, port = π.
function AnnularSector({ rInner, rOuter, startAngle, endAngle, color, opacity }: {
  rInner: number; rOuter: number; startAngle: number; endAngle: number;
  color: string; opacity: number;
}) {
  const geo = useMemo(() => {
    const segments = 40;
    const shape = new THREE.Shape();
    for (let i = 0; i <= segments; i++) {
      const a = startAngle + (endAngle - startAngle) * (i / segments);
      const x = Math.cos(a) * rOuter, y = Math.sin(a) * rOuter;
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    }
    for (let i = segments; i >= 0; i--) {
      const a = startAngle + (endAngle - startAngle) * (i / segments);
      shape.lineTo(Math.cos(a) * rInner, Math.sin(a) * rInner);
    }
    shape.closePath();
    return new THREE.ShapeGeometry(shape);
  }, [rInner, rOuter, startAngle, endAngle]);
  return (
    <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.04, 0]} geometry={geo}>
      <meshBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

function ForwardPreview({ distance, maxDistance }: { distance: number; maxDistance: number }) {
  return (
    <group>
      {/* Faint max-range rail showing how far this ship can still go this phase */}
      {maxDistance > 0 && (
        <mesh position={[0, 0.05, 1.2 + maxDistance / 2]}>
          <boxGeometry args={[0.06, 0.02, maxDistance]} />
          <meshBasicMaterial color="#0891b2" transparent opacity={0.35} />
        </mesh>
      )}
      {/* Active distance arrow */}
      {distance > 0 && (
        <>
          <mesh position={[0, 0.06, 1.2 + distance / 2]}>
            <boxGeometry args={[0.1, 0.04, distance]} />
            <meshBasicMaterial color="#22d3ee" transparent opacity={0.9} />
          </mesh>
          <mesh position={[0, 0.06, 1.2 + distance]} rotation={[Math.PI / 2, 0, 0]}>
            <coneGeometry args={[0.28, 0.55, 14]} />
            <meshBasicMaterial color="#22d3ee" transparent opacity={0.95} />
          </mesh>
          <Text
            position={[0.55, 0.1, 1.2 + distance / 2]}
            fontSize={0.34}
            color="#67e8f9"
            anchorX="left"
            anchorY="middle"
            outlineWidth={0.04}
            outlineColor="black"
          >{`${distance.toFixed(1)}"`}</Text>
        </>
      )}
    </group>
  );
}

function TurnArcPreview({ deltaDeg }: { deltaDeg: number }) {
  if (deltaDeg === 0) return null;
  const absDeg = Math.abs(deltaDeg);
  const angleRad = (absDeg * Math.PI) / 180;
  // Forward = shape angle π/2. Positive delta (CW from above) sweeps toward starboard
  // (decreasing shape angle); negative delta sweeps toward port (increasing shape angle).
  const start = Math.PI / 2;
  const end = deltaDeg > 0 ? start - angleRad : start + angleRad;
  const midAngle = (start + end) / 2;
  const labelR = 2.6;
  const labelX = Math.cos(midAngle) * labelR;
  const labelZ = Math.sin(midAngle) * labelR;
  return (
    <group>
      <AnnularSector
        rInner={1.2}
        rOuter={3.2}
        startAngle={Math.min(start, end)}
        endAngle={Math.max(start, end)}
        color="#22d3ee"
        opacity={0.35}
      />
      <Text
        position={[labelX, 0.12, labelZ]}
        fontSize={0.36}
        color="#67e8f9"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.04}
        outlineColor="black"
      >{`${deltaDeg > 0 ? "+" : "−"}${absDeg}°`}</Text>
    </group>
  );
}

function MovementPlanner({ unit, plan, flip, remainingMove }: {
  unit: { hexQ: number; hexR: number; heading: number; speed: number };
  plan: MovePlan;
  flip: boolean;
  remainingMove: number;
}) {
  if (!plan) return null;
  const [x, , z] = hexToWorld(unit.hexQ, unit.hexR);
  const headingRad = (unit.heading * Math.PI) / 180;
  // FLIP_MODELS only swap fore↔aft (same convention used by WeaponArcDisplay's
  // axial-arc handling). A Z-mirror flips the forward arrow to point out the
  // visual nose while keeping port/starboard on the correct visual side — which
  // a 180° Y-rotation would NOT do (it mirrors both axes).
  return (
    <group position={[x, 0, z]}>
      <group rotation={[0, headingRad, 0]}>
        <group scale={flip ? [1, 1, -1] : [1, 1, 1]}>
          {plan.kind === "forward" && <ForwardPreview distance={plan.distance} maxDistance={remainingMove} />}
          {plan.kind === "turn" && <TurnArcPreview deltaDeg={plan.deltaDeg} />}
        </group>
      </group>
    </group>
  );
}

// ── Staged (drag-placed) units ────────────────────────────────────────────────
interface StagedUnitData {
  id: string;
  shipModelId: number;
  name: string;
  modelFilename: string;
  faction: string;
  hullPoints: number;
  speed: number;
  weaponRange: number;
  weaponDamage: number;
  weapons: Pick<Weapon, "arc">[];
  x: number;
  z: number;
  heading: number; // degrees, 0 = +Z axis, clockwise
  locked: boolean;
  // Crew Quality 1..6. Always 4 in "standard" games; chosen per ship in
  // "custom" games via the expandable card in the staged-units list.
  crewQuality: number;
}

// Crew Quality labels (1=Rookie … 6=Special Ops). Kept here next to the staged
// unit type so the deploy UI and any future combat overlays render the same
// names without hardcoding strings throughout the file.
const CREW_QUALITY_LABELS: Record<number, string> = {
  1: "Rookie",
  2: "Green",
  3: "Competent",
  4: "Veteran",
  5: "Elite",
  6: "Special Ops",
};

function StagedUnit3D({
  unit, isSelected, onClick, onPointerDown,
}: {
  unit: StagedUnitData;
  isSelected: boolean;
  onClick: (e: any) => void;
  onPointerDown?: (e: any) => void;
}) {
  const baseColor = unit.locked ? "#22c55e" : "#f59e0b";
  const ringOpacity = isSelected ? 0.8 : unit.locked ? 0.55 : 0.45;
  const fillOpacity = isSelected ? 0.28 : 0.15;
  const headingRad = (unit.heading * Math.PI) / 180;

  return (
    <group position={[unit.x, 0, unit.z]} onClick={onClick} onPointerDown={onPointerDown}>
      {/* Selection pulse ring */}
      {isSelected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
          <ringGeometry args={[1.3, 1.5, 48]} />
          <meshStandardMaterial color="white" transparent opacity={0.35} emissive="white" emissiveIntensity={0.4} depthWrite={false} />
        </mesh>
      )}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <circleGeometry args={[1.2, 48]} />
        <meshStandardMaterial color={baseColor} transparent opacity={fillOpacity} depthWrite={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <ringGeometry args={[1.15, 1.2, 48]} />
        <meshStandardMaterial color={baseColor} transparent opacity={ringOpacity} emissive={baseColor} emissiveIntensity={0.25} />
      </mesh>
      {/* Weapon arcs — rendered in heading-rotated group so they turn with the ship */}
      {isSelected && unit.weapons.length > 0 && (
        <group rotation={[0, headingRad, 0]}>
          <WeaponArcDisplay weapons={unit.weapons} flip={FLIP_MODELS.has(unit.modelFilename)} />
        </group>
      )}
      {/* Ship model, rotated to match heading */}
      <group position={[0, 2, 0]} rotation={[0, headingRad, 0]}>
        <ModelErrorBoundary color={baseColor}>
          <Suspense fallback={<ShipModelFallback color={baseColor} />}>
            <ShipModel3D filename={unit.modelFilename} tint={baseColor} />
          </Suspense>
        </ModelErrorBoundary>
      </group>
      <Text
        position={[0, 3.9, 0]}
        fontSize={0.38}
        color={unit.locked ? "#86efac" : "white"}
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.04}
        outlineColor="black"
      >
        {unit.locked ? `🔒 ${unit.name.slice(0, 11)}` : unit.name.slice(0, 14)}
      </Text>
      {/* Heading degrees label when selected and unlocked */}
      {isSelected && !unit.locked && (
        <Text
          position={[0, 3.4, 0]}
          fontSize={0.28}
          color="#94a3b8"
          anchorX="center"
          anchorY="middle"
        >
          {`${Math.round(unit.heading)}°  R / ⇧R`}
        </Text>
      )}
    </group>
  );
}

// Captures camera + renderer refs from inside the Canvas for raycasting
function CameraCapture({ refs }: { refs: React.MutableRefObject<{ camera: THREE.Camera; gl: THREE.WebGLRenderer } | null> }) {
  const { camera, gl } = useThree();
  refs.current = { camera, gl: gl as unknown as THREE.WebGLRenderer };
  return null;
}

function screenToBoard(
  clientX: number,
  clientY: number,
  refs: React.MutableRefObject<{ camera: THREE.Camera; gl: THREE.WebGLRenderer } | null>
): [number, number] | null {
  if (!refs.current) return null;
  const { camera, gl } = refs.current;
  const canvas = (gl as any).domElement as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(plane, hit)) return null;
  return [
    Math.max(-BOARD_W / 2, Math.min(BOARD_W / 2, hit.x)),
    Math.max(-BOARD_D / 2, Math.min(BOARD_D / 2, hit.z)),
  ];
}

export default function GameBoard() {
  const params = useParams<{ id: string }>();
  const gameId = parseInt(params.id ?? "0");
  const { user } = useUser();
  const devUserId = useDevUserId();
  const myUserId = import.meta.env.DEV ? devUserId : (user?.id ?? "");
  const qc = useQueryClient();

  const { data: gameData, isLoading } = useGetGame(gameId, { query: { queryKey: getGetGameQueryKey(gameId) } });
  const { data: fleets } = useListFleets();
  const { data: shipModels } = useListShipModels();
  const acceptGame = useAcceptGame();
  const declineGame = useDeclineGame();
  const deployFleet = useDeployFleet();
  const submitTurn = useSubmitTurn();
  const moveUnit = useMoveUnit();
  const devMoveUnit = useDevMoveUnit();
  // ── DEV MODE ────────────────────────────────────────────────────────────────
  // Free-form "god mode" for setting up test scenarios: click any ship of any
  // side and shove it around with nudge / rotate buttons. Bypasses all
  // turn / phase / ownership / activation checks on both the client and the
  // server (see POST /games/:id/units/:id/dev-move). Persisted to
  // localStorage so a reload keeps the toggle state.
  const [devMode, setDevMode] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("b5acta-dev-mode") === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("b5acta-dev-mode", devMode ? "1" : "0");
  }, [devMode]);
  const activateUnit = useActivateUnit();
  const endActivation = useEndActivation();
  const fireWeapon = useFireWeapon();
  const damageControl = useDamageControl();
  const surrenderGame = useSurrenderGame();
  const [, setLocation] = useLocation();
  const [confirmingSurrender, setConfirmingSurrender] = useState(false);
  const chooseSpecialAction = useChooseSpecialAction();
  // Transient feedback for the most recent special-action attempt
  // (success/fail + dice roll). Cleared when activation ends.
  const [specialActionFeedback, setSpecialActionFeedback] = useState<
    { action: string; success: boolean; cqRoll: number | null; cqTotal: number | null; cqRequired: number | null } | null
  >(null);
  // For "Concentrate All Fire-power" we need a target picker before sending.
  const [concentratePicking, setConcentratePicking] = useState(false);

  // Staging / fleet yards
  const threeRef = useRef<{ camera: THREE.Camera; gl: THREE.WebGLRenderer } | null>(null);
  const draggedShipRef = useRef<ShipModel | null>(null);
  const [stagedUnits, setStagedUnits] = useState<StagedUnitData[]>([]);
  const [selectedStagedId, setSelectedStagedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [selectedFaction, setSelectedFaction] = useState<string>("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [devSkipping, setDevSkipping] = useState(false);
  // Password an accepter types to join a private engagement (only shown when
  // the open challenge has hasPassword=true).
  const [joinPassword, setJoinPassword] = useState("");

  const handleDevSkipDeploy = useCallback(async () => {
    setDevSkipping(true);
    try {
      await fetch(`/api/games/${gameId}/dev/skip-deploy`, { method: "POST" });
      qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
    } finally {
      setDevSkipping(false);
    }
  }, [gameId, qc]);

  // Keyboard handler for placement phase
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedStagedId) return;
      if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        setStagedUnits(prev => prev.map(u => u.id === selectedStagedId ? { ...u, locked: !u.locked } : u));
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        // R = clockwise, Shift+R = counter-clockwise (15° per press)
        const delta = e.shiftKey ? -15 : 15;
        setStagedUnits(prev => prev.map(u => {
          if (u.id !== selectedStagedId || u.locked) return u;
          return { ...u, heading: ((u.heading + delta) % 360 + 360) % 360 };
        }));
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        setStagedUnits(prev => {
          const target = prev.find(u => u.id === selectedStagedId);
          if (target?.locked) return prev;
          return prev.filter(u => u.id !== selectedStagedId);
        });
        setSelectedStagedId(null);
      } else if (e.key === "Escape") {
        setSelectedStagedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedStagedId]);

  const factions = useMemo(() => [...new Set((shipModels ?? []).map(m => m.faction))].sort(), [shipModels]);
  const filteredModels = useMemo(
    () => (selectedFaction && selectedFaction !== "__all__" ? (shipModels ?? []).filter(m => m.faction === selectedFaction) : (shipModels ?? [])),
    [shipModels, selectedFaction]
  );
  // filename → weapon arcs lookup for GameUnit3D
  const weaponsByFilename = useMemo(() => {
    const map: Record<string, Pick<Weapon, "arc">[]> = {};
    for (const m of shipModels ?? []) {
      map[m.filename] = m.weapons ?? [];
    }
    return map;
  }, [shipModels]);

  const [selectedUnit, setSelectedUnit] = useState<number | null>(null);
  const [moveTarget, setMoveTarget] = useState<{ q: number; r: number } | null>(null);
  const [attackTarget, setAttackTarget] = useState<number | null>(null);

  // ── Firing-phase state ──
  // The weapon (id) the player has selected and is about to assign to a target.
  // While set, clicking an enemy ship resolves into a fire-weapon call.
  const [firingWeaponPicking, setFiringWeaponPicking] = useState<number | null>(null);
  // Optimistic fired-weapon ids, scoped to a specific (unitId, phase) so a
  // late /fire-weapon onSuccess from a previous activation can't pollute the
  // next ship's button state. Merged with the server's authoritative
  // `activeUnit.firedWeaponIds` (which survives reload) for display.
  const [pendingFired, setPendingFired] = useState<{ unitId: number; ids: Set<number> } | null>(null);
  // Synchronous re-entry guard for the firing-phase target click. A single
  // user click on an enemy ship produces multiple R3F onClick events (one per
  // intersected child mesh inside the ship's <group>), so React state updates
  // in onSuccess come too late to stop duplicate fire-weapon requests. The
  // ref flips synchronously the moment we kick off a mutate() and is cleared
  // when the request settles, so the 2nd–Nth events in the same gesture bail.
  const firingInFlightRef = useRef(false);
  // Dice-roll modal payload. The reveal is staged behind explicit player
  // confirmations: pending (waiting for server) → attack-ready (press to
  // roll attack) → attack-rolling (shuffle anim) → attack-shown → if hits,
  // damage-ready → damage-rolling → damage-shown → close (confirmed). The
  // server returns the full result in one shot; the staging is purely UX.
  const [diceModal, setDiceModal] = useState<DiceModalState | null>(null);
  const [turnMoves, setTurnMoves] = useState<Array<{ unitId: number; toHexQ: number; toHexR: number; newHeading: number }>>([]);
  const [turnAttacks, setTurnAttacks] = useState<Array<{ attackerUnitId: number; targetUnitId: number }>>([]);
  const [movePlan, setMovePlan] = useState<MovePlan>(null);
  useEffect(() => { setMovePlan(null); }, [selectedUnit]);

  // Per-unit movement-phase ledger. Each ship gets ONE activation per round
  // with `speed` inches and `turns` rotations to spend; the ledger is wiped
  // when the round rolls over.
  const [phaseLedger, setPhaseLedger] = useState<Record<number, { distance: number; turns: number }>>({});
  const currentRoundNumber = gameData?.game?.currentRound ?? 1;
  useEffect(() => { setPhaseLedger({}); }, [currentRoundNumber]);
  const getLedger = useCallback((uid: number) => phaseLedger[uid] ?? { distance: 0, turns: 0 }, [phaseLedger]);

  // Fleet Yards: optional pre-built fleet to deploy from. Empty string =
  // direct drop-in mode (no fleet — server materializes an ephemeral one
  // from the staged ships' shipModelIds). We do NOT auto-pick; the
  // player gets to choose between "Quick-load a saved fleet" and
  // "Just drag what I want onto the board."
  const [yardsFleetId, setYardsFleetId] = useState<string>("");
  const { data: yardsFleetShips } = useListFleetShips(parseInt(yardsFleetId || "0"), {
    query: { queryKey: getListFleetShipsQueryKey(parseInt(yardsFleetId || "0")), enabled: !!yardsFleetId }
  });

  const game = gameData?.game;
  const units = gameData?.units ?? [];
  const turns = gameData?.turns ?? [];

  const isChallenger = game?.challengerId === myUserId;
  // Surrender eligibility: every one of MY ships is at ≤0 hull OR ≤0 crew
  // (or destroyed). A ship with maxCrewPoints=0 (legacy unit without a crew
  // pool) shouldn't gate surrender on its non-existent crew, so we only
  // count crew when the ship has a crew pool to begin with.
  const myUnits = units.filter(u => u.ownerId === myUserId);
  const allMyShipsCombatInert =
    myUnits.length > 0 &&
    myUnits.every(u =>
      u.isDestroyed ||
      u.hullPoints <= 0 ||
      ((u.maxCrewPoints ?? 0) > 0 && (u.crewPoints ?? 0) <= 0),
    );

  // Deployment-zone clamp for staged ship placement during the deploy phase.
  // Challenger deploys from the +Z short edge, opponent from -Z. The clamp
  // applies in BOTH normal and dev mode — the server enforces the same
  // zone rules, and silently snapping drops to the legal strip is much
  // friendlier than letting the user stage ships that will fail on commit.
  const deploymentDepth = game?.deploymentDepth ?? 12;
  const clampToDeployZone = useCallback((x: number, z: number): [number, number] => {
    const cx = Math.max(-BOARD_W / 2, Math.min(BOARD_W / 2, x));
    if (!game) return [cx, Math.max(-BOARD_D / 2, Math.min(BOARD_D / 2, z))];
    // NOTE: devMode controls *who you are*, not *where you may deploy*.
    // Even in devMode, deployment must respect your side's zone — the
    // server enforces it. If you need to seed both sides for a test,
    // use the `/dev/skip-deploy` endpoint instead.
    const mine: "challenger" | "opponent" | null =
      myUserId === game.challengerId ? "challenger"
      : myUserId === game.opponentId ? "opponent"
      : null;
    if (mine === "challenger") {
      return [cx, Math.max(36 - deploymentDepth, Math.min(36, z))];
    }
    if (mine === "opponent") {
      return [cx, Math.max(-36, Math.min(-36 + deploymentDepth, z))];
    }
    return [cx, Math.max(-BOARD_D / 2, Math.min(BOARD_D / 2, z))];
  }, [game, myUserId, deploymentDepth]);
  const mySide: "challenger" | "opponent" | null = !game
    ? null
    : myUserId === game.challengerId ? "challenger"
    : myUserId === game.opponentId ? "opponent"
    : null;
  const isOpponent = game?.opponentId === myUserId;
  // New activation model: it's "my turn" if the server says I'm the
  // active player for the round's next ship activation.
  const isMyActivation = game?.status === "active" && game.activePlayerId === myUserId;
  const activeUnitId = game?.activeUnitId ?? null;
  const hasActiveUnit = activeUnitId !== null;
  const selectedUnitData = units.find(u => u.id === selectedUnit);
  // The selected ship is only "controllable" if it's the one the server
  // currently has activated for THIS player.
  const isSelectedUnitActive = !!selectedUnitData && selectedUnitData.id === activeUnitId && isMyActivation;

  const confirmMovePlan = useCallback(() => {
    const u = units.find(x => x.id === selectedUnit);
    if (!u || !movePlan) return;
    // Recompute SA-adjusted caps here (don't read selectedSaCaps — this
    // callback's deps would otherwise need it, and we want the authoritative
    // commit path to be self-contained).
    const baseAction = (u.specialAction ?? "").replace(/-failed$/, "");
    const isAllStop = baseAction === "all-stop";
    const isAllStopPivot = baseAction === "all-stop-pivot";
    const isAllPower = baseAction === "all-power-engines";
    const isRunSilent = baseAction === "run-silent";
    const isComeAbout = u.specialAction === "come-about";
    const speedCap =
      isAllStopPivot ? 0 :
      isAllStop || isRunSilent ? Math.floor(u.speed / 2) :
      isAllPower ? Math.floor(u.speed * 1.5) :
      u.speed;
    const maxTurns = (u.turns ?? 1) + (isComeAbout ? 1 : 0);
    const turnsForbidden = isAllPower || isRunSilent;
    const led = getLedger(u.id);
    let toHexQ = u.hexQ, toHexR = u.hexR, newHeading = u.heading;
    let distanceCommitted = 0;
    if (movePlan.kind === "forward") {
      if (movePlan.distance <= 0) { setMovePlan(null); return; }
      // SA cap re-check: a stale forward plan could otherwise commit a value
      // larger than the current allowance (e.g. if a Run Silent declaration
      // happened while a forward plan was open).
      if (led.distance + movePlan.distance > speedCap + 1e-6) { setMovePlan(null); return; }
      // FLIP_MODELS render their nose along local -Z, so movement direction must
      // mirror the visual nose, not the abstract heading vector.
      const v = headingForwardVec(u);
      const dx = v.x * movePlan.distance;
      const dz = v.z * movePlan.distance;
      // hexQ/hexR are stored as world inches (see hexToWorld above), so the
      // delta in world space IS the delta in storage units.
      toHexQ = Math.round(u.hexQ + dx);
      toHexR = Math.round(u.hexR + dz);
      distanceCommitted = movePlan.distance;
    } else if (movePlan.kind === "turn") {
      // SA cap re-check on turns: forbidden under All Power / Run Silent;
      // capped at maxTurns (Come About adds +1).
      if (turnsForbidden) { setMovePlan(null); return; }
      if (led.turns >= maxTurns) { setMovePlan(null); return; }
      // Three.js right-handed Y-up: a positive Y rotation takes +Z → +X, which
      // appears CLOCKWISE looking down -Y. That matches the arc preview's
      // "positive deltaDeg sweeps to starboard" convention for unflipped models.
      // FLIP_MODELS render with an extra 180° Y-rotation: rotating their stored
      // heading by +Δ moves the visible nose by -Δ in world space, so the arc
      // (which is mirrored to track the visible nose via the [1,1,-1] z-scale
      // in MovementPlanner) appears on the visually-correct side, but a naive
      // heading + Δ commit turns the ship the OTHER way. Negate for flipped.
      const flip = FLIP_MODELS.has(u.modelFilename);
      const headingDelta = flip ? -movePlan.deltaDeg : movePlan.deltaDeg;
      newHeading = ((u.heading + headingDelta) % 360 + 360) % 360;
    }
    const planKind = movePlan.kind;
    const unitId = u.id;
    // Optimistically charge the phase ledger BEFORE the mutate resolves —
    // otherwise rapid R/F presses (or another commit) read stale allowances
    // between confirm and onSuccess, bypassing the per-phase limits.
    const ledgerDelta = planKind === "forward"
      ? { distance: distanceCommitted, turns: 0 }
      : { distance: 0, turns: 1 };
    setPhaseLedger(prev => {
      const cur = prev[unitId] ?? { distance: 0, turns: 0 };
      return { ...prev, [unitId]: { distance: cur.distance + ledgerDelta.distance, turns: cur.turns + ledgerDelta.turns } };
    });
    // Apply the move immediately (real-time, single-ship). Does NOT end the turn.
    moveUnit.mutate(
      { gameId, unitId, data: { toHexQ, toHexR, newHeading } },
      {
        onSuccess: () => { qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) }); },
        // Roll back the optimistic ledger charge on server rejection.
        onError: () => {
          setPhaseLedger(prev => {
            const cur = prev[unitId];
            if (!cur) return prev;
            return { ...prev, [unitId]: { distance: Math.max(0, cur.distance - ledgerDelta.distance), turns: Math.max(0, cur.turns - ledgerDelta.turns) } };
          });
        },
      }
    );
    setMovePlan(null);
  }, [units, selectedUnit, movePlan, moveUnit, gameId, qc]);

  const cancelMovePlan = useCallback(() => {
    setMovePlan(null);
  }, []);

  // Keyboard controls for movement planning:
  //   R          → enter/extend turn plan by +5° clockwise (capped at +turnAngle)
  //   Shift+R    → enter/extend turn plan by −5° counter-clockwise (capped at −turnAngle)
  //   F          → forward-move plan
  //   Enter      → confirm current plan (queue it)
  //   Esc        → cancel current plan, or if none, discard the queued move for this ship
  useEffect(() => {
    if (game?.status !== "active" || !isSelectedUnitActive) return;
    if (!selectedUnitData || selectedUnitData.ownerId !== myUserId || selectedUnitData.isDestroyed) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // While a move is in flight the server hasn't yet updated the unit's
      // position/heading; queueing another commit would compute from stale state.
      if (moveUnit.isPending) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        if (endActivation.isPending) return;
        endActivation.mutate({ gameId }, {
          onSuccess: () => {
            qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
            setSelectedUnit(null);
            setMovePlan(null);
          }
        });
        return;
      }
      const u = selectedUnitData;
      const max = u.turnAngle;
      const led = getLedger(u.id);
      // Special Action modifiers (read the base name; the "-failed" suffix
      // still applies the penalty side of always-on actions like Run Silent).
      const baseAction = (u.specialAction ?? "").replace(/-failed$/, "");
      const isAllStop = baseAction === "all-stop";
      const isAllStopPivot = baseAction === "all-stop-pivot";
      const isAllPower = baseAction === "all-power-engines";
      const isRunSilent = baseAction === "run-silent";
      const isComeAbout = u.specialAction === "come-about"; // success-only
      // Come About: +1 extra turn this activation.
      const maxTurns = (u.turns ?? 1) + (isComeAbout ? 1 : 0);
      // No turns allowed under All Power to Engines or Run Silent.
      // All Stop and Pivot doubles turn rate but allows turns.
      const turnsForbidden = isAllPower || isRunSilent;
      const canTurn = !turnsForbidden && led.turns < maxTurns && (led.turns === 0 || led.distance >= u.speed / 2);
      // Effective speed cap per action.
      // All Power: +50% (Afterburner not modeled yet).
      // All Stop / Run Silent: half speed.
      // All Stop and Pivot: no movement.
      const speedCap =
        isAllStopPivot ? 0 :
        isAllStop || isRunSilent ? Math.floor(u.speed / 2) :
        isAllPower ? Math.floor(u.speed * 1.5) :
        u.speed;
      const remainingMove = Math.max(0, speedCap - led.distance);
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        // Allow refining an in-progress turn plan even if `canTurn` is false,
        // since the plan hasn't been committed yet.
        if (!canTurn && (!movePlan || movePlan.kind !== "turn")) return;
        // R = clockwise (+), Shift+R = counter-clockwise (−). Mirrors the
        // placement-phase R/Shift+R convention.
        const step = e.shiftKey ? 5 : -5;
        // All Stop and Pivot doubles the per-turn cap (any direction).
        const cap = isAllStopPivot ? max * 2 : max;
        setMovePlan(prev => {
          const current = prev && prev.kind === "turn" ? prev.deltaDeg : 0;
          const next = Math.max(-cap, Math.min(cap, current + step));
          return { kind: "turn", deltaDeg: next };
        });
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        if (remainingMove <= 0) return;
        setMovePlan({ kind: "forward", distance: 0 });
      } else if (e.key === "Enter" || e.key === " " || e.code === "Space") {
        e.preventDefault();
        confirmMovePlan();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelMovePlan();
      }
    };
    // Capture on document so we get the keydown regardless of which element has focus.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [game?.status, isSelectedUnitActive, selectedUnitData, myUserId, confirmMovePlan, cancelMovePlan, getLedger, movePlan, moveUnit.isPending, endActivation, gameId, qc]);

  // Special-Action-adjusted caps for the selected unit. Single source of truth
  // shared by keyboard gating, drag clamp, confirmMovePlan re-validation, and
  // the Special Actions panel (so declarations can't be made after a move that
  // would violate the declared action's constraints).
  const selectedSaCaps = useMemo(() => {
    if (!selectedUnitData) return null;
    const u = selectedUnitData;
    const baseAction = (u.specialAction ?? "").replace(/-failed$/, "");
    const isAllStop = baseAction === "all-stop";
    const isAllStopPivot = baseAction === "all-stop-pivot";
    const isAllPower = baseAction === "all-power-engines";
    const isRunSilent = baseAction === "run-silent";
    const isComeAbout = u.specialAction === "come-about";
    const maxTurns = (u.turns ?? 1) + (isComeAbout ? 1 : 0);
    const turnsForbidden = isAllPower || isRunSilent;
    const speedCap =
      isAllStopPivot ? 0 :
      isAllStop || isRunSilent ? Math.floor(u.speed / 2) :
      isAllPower ? Math.floor(u.speed * 1.5) :
      u.speed;
    return { speedCap, maxTurns, turnsForbidden, isAllStopPivot };
  }, [selectedUnitData]);

  // Selected-ship remaining inches this phase + drag offset for the forward
  // preview / ship slide-along-axis. Uses SA-adjusted speed cap so the drag
  // clamp can't bypass Run Silent / All Stop / All Power restrictions.
  const selectedRemainingMove = selectedUnitData && selectedSaCaps
    ? Math.max(0, selectedSaCaps.speedCap - getLedger(selectedUnitData.id).distance)
    : 0;
  const selectedDragOffset = useMemo(() => {
    if (!selectedUnitData || !movePlan || movePlan.kind !== "forward") return null;
    const v = headingForwardVec(selectedUnitData);
    return { x: v.x * movePlan.distance, z: v.z * movePlan.distance };
  }, [selectedUnitData, movePlan]);

  const currentPhase: "movement" | "firing" = (game?.phase as "movement" | "firing") ?? "movement";

  // Eligible-to-activate count for the current player in the current phase.
  // Mirrors the server's `remainingFor` filter so the UI can offer a "Pass
  // Phase" affordance when the player is active but has no legal moves —
  // otherwise they'd be stuck staring at "Pick a Ship" forever (e.g. every
  // remaining ship is destroyed, already activated this phase, or inert from
  // 0-hull / 0-crew in the firing phase).
  const myEligibleActivations = useMemo(() => {
    if (!isMyActivation || !myUserId) return 0;
    return units.filter(u => {
      if (u.ownerId !== myUserId) return false;
      if (u.isDestroyed) return false;
      const phaseDone = currentPhase === "firing" ? u.hasFiredThisRound : u.hasMovedThisRound;
      if (phaseDone) return false;
      if (currentPhase === "firing") {
        if (u.hullPoints <= 0) return false;
        const maxCrew = u.maxCrewPoints ?? 0;
        const crew = u.crewPoints ?? 0;
        if (maxCrew > 0 && crew <= 0) return false;
      }
      return true;
    }).length;
  }, [units, isMyActivation, myUserId, currentPhase]);
  const canPassPhase = isMyActivation && !hasActiveUnit && myEligibleActivations === 0;

  // Reset per-activation firing state whenever the active unit changes (new
  // ship picked up, or the previous activation ended). Server clears its own
  // ledger on /activate-unit; we just clear the optimistic overlay + picker.
  useEffect(() => {
    setPendingFired(null);
    setFiringWeaponPicking(null);
    // Also drop the in-flight guard so a stale latch from a previous
    // activation (e.g. a request that never settled, or the player ended
    // activation mid-roll) can't permanently block firing on the next ship.
    firingInFlightRef.current = false;
  }, [activeUnitId, currentPhase]);

  // Wipe per-activation Special Action UI state when the active unit changes
  // (handoff, end-activation, or round rollover). The server still owns the
  // committed action on the unit row; these are purely transient affordances.
  useEffect(() => {
    setSpecialActionFeedback(null);
    setConcentratePicking(false);
  }, [activeUnitId]);

  // ── Adrift auto-drift ───────────────────────────────────────────────────────
  // When the player activates a ship whose damageState is `adrift` or
  // `exploding-end-of-next`, the engine auto-drifts it floor(speed/2) inches
  // straight ahead and ends the activation. No player input — the player
  // has no meaningful movement choice for a derelict ship anyway, so we
  // skip the planner UI entirely. The dispatch ref guards against React
  // strict-mode double-invokes and against re-firing while the server
  // call is in flight.
  const autoDriftDispatchedRef = useRef<number | null>(null);
  useEffect(() => {
    if (game?.status !== "active") return;
    if (currentPhase !== "movement") return;
    if (!isMyActivation || activeUnitId == null) return;
    const u = units.find(x => x.id === activeUnitId);
    if (!u || u.ownerId !== myUserId || u.isDestroyed) return;
    const isAdriftLike =
      u.damageState === "adrift" || u.damageState === "exploding-end-of-next";
    if (!isAdriftLike) return;
    if (u.hasMovedThisRound) return;
    if (autoDriftDispatchedRef.current === u.id) return;
    if (moveUnit.isPending || endActivation.isPending) return;
    autoDriftDispatchedRef.current = u.id;
    const driftDistance = Math.floor(u.speed / 2);
    const v = headingForwardVec(u);
    const toHexQ = Math.round(u.hexQ + v.x * driftDistance);
    const toHexR = Math.round(u.hexR + v.z * driftDistance);
    moveUnit.mutate(
      { gameId, unitId: u.id, data: { toHexQ, toHexR, newHeading: u.heading } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
          endActivation.mutate({ gameId }, {
            onSuccess: () => {
              qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
              setSelectedUnit(null);
            },
          });
        },
        onError: () => {
          // Let the player retry by re-activating; clear the latch.
          autoDriftDispatchedRef.current = null;
        },
      },
    );
  }, [activeUnitId, isMyActivation, currentPhase, game?.status, units, myUserId, moveUnit, endActivation, gameId, qc]);
  // Clear the auto-drift latch whenever the active unit changes so the next
  // adrift ship's activation also auto-drifts.
  useEffect(() => {
    autoDriftDispatchedRef.current = null;
  }, [activeUnitId]);

  const handleUnitClick = (unitId: number) => {
    const unit = units.find(u => u.id === unitId);
    if (!unit || unit.isDestroyed) return;

    // ── DEV MODE: hard short-circuit ──
    // Must run BEFORE firing-target / attack-queue / activation branches so
    // that clicking an enemy ship in dev mode selects it for repositioning
    // instead of (e.g.) firing the currently-picked weapon at it.
    if (devMode) {
      setSelectedUnit(unitId === selectedUnit ? null : unitId);
      setMoveTarget(null);
      setAttackTarget(null);
      return;
    }

    // ── MOVEMENT-PHASE: Concentrate All Fire-power target picker ──
    // Clicking an enemy ship while picking a target submits the action.
    if (
      game?.status === "active" &&
      isMyActivation &&
      currentPhase === "movement" &&
      concentratePicking &&
      hasActiveUnit &&
      unit.ownerId !== myUserId
    ) {
      const attackerUnitId = activeUnitId!;
      const targetId = unit.id;
      setConcentratePicking(false);
      chooseSpecialAction.mutate(
        { gameId, unitId: attackerUnitId, data: { action: "concentrate-fire", targetUnitId: targetId } },
        {
          onSuccess: (res) => {
            setSpecialActionFeedback({
              action: res.action,
              success: res.success,
              cqRoll: res.cqRoll ?? null,
              cqTotal: res.cqTotal ?? null,
              cqRequired: res.cqRequired ?? null,
            });
            qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
          },
          onError: (err: any) => {
            setSpecialActionFeedback({ action: "concentrate-fire", success: false, cqRoll: null, cqTotal: null, cqRequired: null });
            // eslint-disable-next-line no-console
            console.warn("Concentrate failed:", err?.message);
          },
        },
      );
      return;
    }

    // ── FIRING-PHASE target click ──
    // While picking a target for a weapon, clicking an enemy ship resolves
    // the shot immediately via the server.
    if (
      game?.status === "active" &&
      isMyActivation &&
      currentPhase === "firing" &&
      firingWeaponPicking !== null &&
      hasActiveUnit &&
      unit.ownerId !== myUserId
    ) {
      // Re-entry guard: a single user click on a ship produces multiple R3F
      // onClick events (one per intersected child mesh in the unit group).
      // Bail synchronously on the 2nd..Nth duplicates so we don't fire the
      // same weapon multiple times and turn the first (successful) shot
      // into a confusing "already fired" error in the dice modal.
      if (firingInFlightRef.current) return;
      const attacker = units.find(u => u.id === activeUnitId);
      const weapon = (weaponsByFilename[attacker?.modelFilename ?? ""] as Weapon[] | undefined)
        ?.find(w => w.id === firingWeaponPicking);
      if (!attacker || !weapon) return;
      // Optimistically mark this weapon as fired BEFORE the network call so
      // the weapon-list button disables immediately, the picker clears, and
      // any duplicate target clicks fall through the firingWeaponPicking
      // gate above on the next render.
      const firedWeaponId = weapon.id;
      const firingUnitId = attacker.id;
      firingInFlightRef.current = true;
      setPendingFired(prev => {
        if (prev && prev.unitId !== firingUnitId) {
          return { unitId: firingUnitId, ids: new Set([firedWeaponId]) };
        }
        const next = new Set(prev?.ids ?? []);
        next.add(firedWeaponId);
        return { unitId: firingUnitId, ids: next };
      });
      setFiringWeaponPicking(null);
      // Open the modal in "pending" while the server resolves the shot. We
      // do NOT advance to attack-ready until the result lands, so the player
      // is never asked to roll dice we haven't received yet.
      setDiceModal({
        weapon,
        attackerUnitId: firingUnitId,
        targetName: unit.name,
        targetId: unit.id,
        attackDice: weapon.attackDice,
        phase: "pending",
      });
      fireWeapon.mutate(
        { gameId, unitId: firingUnitId, data: { weaponId: firedWeaponId, targetUnitId: unit.id } },
        {
          onSuccess: (res) => {
            firingInFlightRef.current = false;
            // Do NOT invalidate the game query here — that would refresh the
            // board (target HP, shields, destroyed flag) BEFORE the player
            // has even rolled to hit, leaking the outcome. We defer the
            // invalidation until the player closes the dice modal (see
            // DiceRollModal.confirmClose). Local state still updates from
            // the server's authoritative result.
            setDiceModal(m => (m ? { ...m, phase: "attack-ready", result: res } : null));
          },
          onError: (err: any) => {
            firingInFlightRef.current = false;
            // Roll back the optimistic fired-marker so the player can retry.
            setPendingFired(prev => {
              if (!prev || prev.unitId !== firingUnitId) return prev;
              const next = new Set(prev.ids);
              next.delete(firedWeaponId);
              return next.size === 0 ? null : { unitId: firingUnitId, ids: next };
            });
            setDiceModal(m => (m ? { ...m, phase: "error", error: err?.message ?? "Shot failed" } : null));
          },
        },
      );
      return;
    }

    // Legacy attack-queue path (movement phase / legacy submitTurn flow).
    if (
      currentPhase === "movement" &&
      selectedUnit && selectedUnit !== unitId && unit.ownerId !== myUserId
    ) {
      const attacker = units.find(u => u.id === selectedUnit);
      if (attacker && attacker.ownerId === myUserId) {
        setTurnAttacks(prev => [...prev.filter(a => a.attackerUnitId !== selectedUnit), { attackerUnitId: selectedUnit, targetUnitId: unitId }]);
        setAttackTarget(unitId);
      }
      return;
    }

    if (unit.ownerId !== myUserId) return;

    // Activation model: clicking an own ship picks the next activation. The
    // server enforces this — UI only fires when it's actually our turn AND
    // the ship hasn't done THIS phase's activation yet AND nothing else is
    // currently activated.
    if (game?.status === "active" && isMyActivation) {
      const isCurrentlyActive = activeUnitId === unitId;
      const phaseDone = currentPhase === "firing" ? unit.hasFiredThisRound : unit.hasMovedThisRound;
      // Firing-phase eligibility: a ship at 0 hull or 0 crew (when it has
      // a crew complement at all) can no longer fire — mirrors the server
      // check in /activate. Clicking such a ship in the firing phase is a
      // no-op so the player doesn't waste a server round-trip on a 400.
      const firingIneligible =
        currentPhase === "firing" &&
        (unit.hullPoints <= 0 ||
          ((unit.maxCrewPoints ?? 0) > 0 && (unit.crewPoints ?? 0) <= 0));
      if (firingIneligible) return;
      if (!hasActiveUnit && !phaseDone) {
        // Pick this ship up for its activation.
        if (activateUnit.isPending) return;
        setSelectedUnit(unitId);
        setMoveTarget(null);
        setAttackTarget(null);
        activateUnit.mutate({ gameId, unitId }, {
          onSuccess: () => qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) }),
        });
        return;
      }
      if (isCurrentlyActive) {
        setSelectedUnit(unitId === selectedUnit ? null : unitId);
        setMoveTarget(null);
        setAttackTarget(null);
        return;
      }
      // hasActiveUnit && different ship: ignore — must End Activation first.
      return;
    }

    // Inactive game or not our activation: still allow selecting own ships
    // for inspection.
    setSelectedUnit(unitId === selectedUnit ? null : unitId);
    setMoveTarget(null);
    setAttackTarget(null);
  };

  const handleEndActivation = useCallback(() => {
    // Either ending a real activation OR passing the phase when zero
    // eligible ships remain. Pass authorisation is enforced server-side.
    if ((!hasActiveUnit && !canPassPhase) || endActivation.isPending) return;
    endActivation.mutate({ gameId }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
        setSelectedUnit(null);
        setMovePlan(null);
      }
    });
  }, [hasActiveUnit, canPassPhase, endActivation, gameId, qc]);

  const handleSubmitTurn = () => {
    submitTurn.mutate(
      { gameId, data: { moves: turnMoves, attacks: turnAttacks } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
          qc.invalidateQueries({ queryKey: getListTurnsQueryKey(gameId) });
          setTurnMoves([]);
          setTurnAttacks([]);
          setSelectedUnit(null);
        }
      }
    );
  };

  const handleYardsDeploy = useCallback(() => {
    if (stagedUnits.length === 0) return;
    // Two paths, mirroring the API's two deploy modes:
    //   1. A saved fleet is selected → match each staged ship to a fleet
    //      Ship row by model filename and send `shipId`.
    //   2. No fleet selected → direct drop-in: send `shipModelId` per
    //      placement and let the server materialize an ephemeral fleet.
    let placements: Array<{ shipId?: number; shipModelId?: number; hexQ: number; hexR: number; heading: number; crewQuality?: number }>;
    let fleetIdToSend: number | undefined;

    if (yardsFleetId && yardsFleetShips) {
      const available = [...yardsFleetShips];
      placements = [];
      for (const staged of stagedUnits) {
        const idx = available.findIndex(s => s.shipModel.filename === staged.modelFilename);
        if (idx === -1) {
          // Staged a ship that isn't in the selected fleet — fall back
          // to direct drop-in for THIS unit so nothing silently disappears.
          placements.push({ shipModelId: staged.shipModelId, hexQ: Math.round(staged.x), hexR: Math.round(staged.z), heading: staged.heading, crewQuality: staged.crewQuality });
          continue;
        }
        const ship = available.splice(idx, 1)[0];
        placements.push({ shipId: ship.id, hexQ: Math.round(staged.x), hexR: Math.round(staged.z), heading: staged.heading, crewQuality: staged.crewQuality });
      }
      // Mixed fleet+drop-in payload is not supported by the API. If ANY
      // placement lacks shipId, drop the fleetId entirely and let the
      // server treat it as a pure direct-deploy.
      const allHaveShipId = placements.every(p => p.shipId !== undefined);
      fleetIdToSend = allHaveShipId ? parseInt(yardsFleetId) : undefined;
      if (!allHaveShipId) placements = placements.map(p => ({ shipModelId: p.shipModelId ?? stagedUnits.find(s => Math.round(s.x) === p.hexQ && Math.round(s.z) === p.hexR)?.shipModelId, hexQ: p.hexQ, hexR: p.hexR, heading: p.heading, crewQuality: p.crewQuality }));
    } else {
      // Pure direct drop-in.
      placements = stagedUnits.map(s => ({
        shipModelId: s.shipModelId,
        hexQ: Math.round(s.x),
        hexR: Math.round(s.z),
        heading: s.heading,
        crewQuality: s.crewQuality,
      }));
      fleetIdToSend = undefined;
    }
    deployFleet.mutate(
      { gameId, data: { fleetId: fleetIdToSend ?? null, placements } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
          setStagedUnits([]);
          setSelectedStagedId(null);
        },
        onError: (err) => {
          // Surface the server's actual error message instead of the
          // mutation silently failing. The customFetch ApiError includes
          // the response body's `error` field in its message.
          console.error("[deploy] failed", err, { fleetId: fleetIdToSend ?? null, placements });
        },
      }
    );
  }, [yardsFleetId, yardsFleetShips, stagedUnits, deployFleet, gameId, qc]);

  if (isLoading) {
    return (
      <Layout title="Loading...">
        <div className="p-6 space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-[400px] w-full" />
        </div>
      </Layout>
    );
  }

  if (!game) {
    return <Layout title="Not Found"><div className="p-6 text-muted-foreground">Game not found.</div></Layout>;
  }

  return (
    <Layout title={`${game.challengerName ?? "?"} vs ${game.opponentName ?? "?"}`}>
      <div className="flex flex-col lg:flex-row h-full min-h-[calc(100dvh-4rem)]">
        {/* 3D Board */}
        <div
          className="flex-1 relative min-h-[400px] lg:min-h-0 bg-black"
          onPointerMove={e => {
            // Staged unit drag (deploy phase)
            if (draggingId) {
              const pos = screenToBoard(e.clientX, e.clientY, threeRef);
              if (!pos) return;
              const [rx, rz] = pos;
              const [x, z] = clampToDeployZone(rx, rz);
              setStagedUnits(prev => prev.map(u => u.id === draggingId ? { ...u, x, z } : u));
              return;
            }
            // Forward-move drag: project cursor onto heading axis from ship origin.
            if (movePlan?.kind === "forward" && selectedUnitData && selectedUnitData.ownerId === myUserId) {
              const pos = screenToBoard(e.clientX, e.clientY, threeRef);
              if (!pos) return;
              const [px, pz] = pos;
              const [sx, , sz] = hexToWorld(selectedUnitData.hexQ, selectedUnitData.hexR);
              const v = headingForwardVec(selectedUnitData);
              const proj = (px - sx) * v.x + (pz - sz) * v.z;
              const distance = Math.max(0, Math.min(selectedRemainingMove, proj));
              setMovePlan(prev => (prev && prev.kind === "forward" ? { kind: "forward", distance } : prev));
            }
          }}
          onPointerUp={() => setDraggingId(null)}
          onPointerLeave={() => setDraggingId(null)}
          onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setIsDragOver(true); }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={e => {
            e.preventDefault();
            setIsDragOver(false);
            const ship = draggedShipRef.current;
            if (!ship) return;
            const pos = screenToBoard(e.clientX, e.clientY, threeRef);
            if (!pos) return;
            const [rx, rz] = pos;
            const [x, z] = clampToDeployZone(rx, rz);
            const newId = `staged-${Date.now()}`;
            setStagedUnits(prev => [...prev, {
              id: newId,
              shipModelId: ship.id,
              name: ship.name,
              modelFilename: ship.filename,
              faction: ship.faction,
              hullPoints: ship.hullPoints,
              speed: ship.speed,
              weaponRange: ship.weaponRange,
              weaponDamage: ship.weaponDamage,
              weapons: ship.weapons ?? [],
              x, z,
              // Default facing: nose toward the opposing player's edge so a
              // freshly-dropped ship is already pointed at the enemy.
              // Challenger deploys from +Z → faces -Z (heading 180°);
              // Opponent deploys from -Z → faces +Z (heading 0°).
              heading: mySide === "challenger" ? 180 : 0,
              locked: false,
              // Default CQ is Veteran (4). In "standard" games this is also
              // the only legal value; in "custom" games the player can pick
              // 1..6 via the expandable card in the staged-units list.
              crewQuality: 4,
            }]);
            setSelectedStagedId(newId);
            draggedShipRef.current = null;
          }}
        >
          {isDragOver && (
            <div className="absolute inset-0 border-2 border-primary/60 pointer-events-none z-10 rounded-sm" />
          )}
          <Canvas camera={{ position: [0, 40, 50], fov: 45 }} shadows>
            <CameraCapture refs={threeRef} />
            <ambientLight intensity={0.4} />
            <directionalLight position={[10, 20, 10]} intensity={1} castShadow />
            <pointLight position={[0, 10, 0]} intensity={0.5} color="#f59e0b" />
            <fog attach="fog" args={["#050505", 60, 110]} />
            <SpaceGrid />
            <BoardBoundary />
            {game.status === "deploying" && (
              <DeploymentZones depth={deploymentDepth} mySide={mySide} />
            )}
            {units.map(unit => {
              const dimmed = currentPhase === "firing"
                ? unit.hasFiredThisRound && !unit.isDestroyed
                : unit.hasMovedThisRound && !unit.isDestroyed;
              // Show the weapon's full-range coverage sector ONLY for the
              // active firing ship while a weapon is selected for targeting.
              let firingArc: { arc: string; range: number } | null = null;
              if (
                currentPhase === "firing" &&
                firingWeaponPicking !== null &&
                unit.id === activeUnitId
              ) {
                const w = (weaponsByFilename[unit.modelFilename] as Weapon[] | undefined)
                  ?.find(x => x.id === firingWeaponPicking);
                if (w) firingArc = { arc: w.arc, range: w.range };
              }
              return (
                <GameUnit3D
                  key={unit.id}
                  unit={unit}
                  isSelected={selectedUnit === unit.id}
                  onClick={() => handleUnitClick(unit.id)}
                  myUserId={myUserId}
                  weapons={weaponsByFilename[unit.modelFilename] ?? []}
                  dragOffset={unit.id === selectedUnit ? selectedDragOffset : null}
                  dimmed={dimmed}
                  firingArc={firingArc}
                />
              );
            })}
            {game.status === "active" && isSelectedUnitActive && selectedUnitData && !selectedUnitData.isDestroyed && (
              <MovementPlanner
                unit={selectedUnitData}
                plan={movePlan}
                flip={FLIP_MODELS.has(selectedUnitData.modelFilename)}
                remainingMove={selectedRemainingMove}
              />
            )}
            {stagedUnits.map(unit => (
              <StagedUnit3D
                key={unit.id}
                unit={unit}
                isSelected={selectedStagedId === unit.id}
                onClick={(e) => { e.stopPropagation(); setSelectedStagedId(unit.id); }}
                onPointerDown={unit.locked ? undefined : (e) => {
                  e.stopPropagation();
                  setSelectedStagedId(unit.id);
                  setDraggingId(unit.id);
                }}
              />
            ))}
            <OrbitControls
              enablePan={!draggingId}
              enableZoom={true}
              enableRotate={!draggingId}
              minDistance={8}
              maxDistance={90}
            />
            {/* Weapon firing FX — mounts when a shot starts rolling and stays
                mounted for the rest of the dice modal lifetime. Internal
                animations handle their own fade. */}
            {(() => {
              if (!diceModal) return null;
              const fxPhases = new Set<DiceModalPhase>([
                "attack-rolling",
                "attack-shown",
                "damage-ready",
                "damage-rolling",
                "damage-shown",
              ]);
              if (!fxPhases.has(diceModal.phase)) return null;
              const attacker = units.find(u => u.id === diceModal.attackerUnitId);
              const target = units.find(u => u.id === diceModal.targetId);
              if (!attacker || !target) return null;
              const [ax, , az] = hexToWorld(attacker.hexQ, attacker.hexR);
              const [tx, , tz] = hexToWorld(target.hexQ, target.hexR);
              // Ship models sit at y≈2; aim the beam at hull-center.
              const from = new THREE.Vector3(ax, 2, az);
              const to = new THREE.Vector3(tx, 2, tz);
              const hits = diceModal.result?.hits ?? 0;
              return (
                <WeaponFx
                  key={`${diceModal.attackerUnitId}-${diceModal.weapon.id}-${diceModal.targetId}`}
                  from={from}
                  to={to}
                  weapon={diceModal.weapon}
                  attackerFaction={attacker.faction}
                  hits={hits}
                  totalDice={diceModal.attackDice}
                />
              );
            })()}
            <EffectComposer>
              <Bloom
                intensity={0.9}
                luminanceThreshold={0.55}
                luminanceSmoothing={0.2}
                mipmapBlur
              />
            </EffectComposer>
          </Canvas>
          {/* Status overlay */}
          <div className="absolute top-3 left-3 flex flex-col gap-1.5 pointer-events-none">
            <div className={`px-2 py-1 rounded text-xs font-mono tracking-widest uppercase border ${
              game.status === "active" ? "bg-green-500/10 border-green-500/30 text-green-400" :
              game.status === "pending" ? "bg-amber-500/10 border-amber-500/30 text-amber-400" :
              game.status === "deploying" ? "bg-blue-500/10 border-blue-500/30 text-blue-400" :
              "bg-muted/10 border-muted/30 text-muted-foreground"
            }`}>
              {game.status} {game.status === "active" && `— Round ${game.currentRound}`}
            </div>
            {game.status === "active" && isMyActivation && !hasActiveUnit && (
              <div className="px-2 py-1 rounded text-xs font-mono tracking-widest uppercase border border-primary/40 bg-primary/10 text-primary animate-pulse" data-testid="hud-pick-ship">
                Pick a Ship
              </div>
            )}
            {game.status === "active" && isMyActivation && hasActiveUnit && (
              <div className="px-2 py-1 rounded text-xs font-mono tracking-widest uppercase border border-cyan-500/40 bg-cyan-500/10 text-cyan-300" data-testid="hud-activating">
                Activating · {units.find(u => u.id === activeUnitId)?.name ?? "—"}
              </div>
            )}
            {game.status === "active" && !isMyActivation && (
              <div className="px-2 py-1 rounded text-xs font-mono tracking-widest uppercase border border-muted/40 bg-muted/10 text-muted-foreground" data-testid="hud-waiting">
                Waiting · Opponent {hasActiveUnit ? "activating" : "to pick"}
              </div>
            )}
            {game.winnerId && (
              <div className="px-2 py-1 rounded text-xs font-mono tracking-widest uppercase border border-yellow-500/40 bg-yellow-500/10 text-yellow-400">
                {game.winnerId === myUserId ? "Victory" : "Defeated"}
              </div>
            )}
          </div>
          {/* Camera / key hints */}
          <div className="absolute bottom-3 left-3 flex flex-col items-start gap-1 pointer-events-none">
            <div className="text-xs text-gray-500 font-mono">
              Drag to rotate &bull; Scroll to zoom &bull; Right-drag to pan
            </div>
            {game.status === "deploying" && (
              <div className="text-[10px] text-gray-600 font-mono">
                {selectedStagedId
                  ? "L — lock/unlock · Del — remove · Esc — deselect"
                  : "Click a placed ship to select it"}
              </div>
            )}
          </div>
        </div>

        {/* Sidebar panel */}
        <div className="w-full lg:w-72 border-t lg:border-t-0 lg:border-l border-border bg-card flex flex-col">

          {/* ── DEV MODE ── */}
          {(() => {
            const devUnit = devMode ? units.find(u => u.id === selectedUnit) : null;
            const applyDev = (dq: number, dr: number, dh: number) => {
              if (!devUnit || devMoveUnit.isPending) return;
              const hexQ = devUnit.hexQ + dq;
              const hexR = devUnit.hexR + dr;
              const heading = devUnit.heading + dh;
              devMoveUnit.mutate(
                { gameId, unitId: devUnit.id, data: { hexQ, hexR, heading } },
                { onSuccess: () => qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) }) },
              );
            };
            return (
              <div className="p-3 border-b border-border space-y-2" data-testid="dev-mode-panel">
                <label className="flex items-center justify-between gap-2 cursor-pointer">
                  <span className="text-xs font-mono uppercase tracking-widest flex items-center gap-1.5 text-fuchsia-400">
                    <Wrench className="w-3 h-3" /> Dev Mode
                  </span>
                  <Switch
                    checked={devMode}
                    onCheckedChange={setDevMode}
                    data-testid="switch-dev-mode"
                  />
                </label>
                {devMode && (
                  <>
                    <p className="text-[10px] font-mono text-fuchsia-300/70 leading-snug">
                      Click any ship · bypass all turn/phase/ownership rules.
                    </p>
                    {devUnit ? (
                      <div className="space-y-1.5 rounded border border-fuchsia-500/40 bg-fuchsia-500/5 p-2">
                        <div className="flex items-center justify-between font-mono text-[11px]">
                          <span className="text-fuchsia-200 font-bold truncate">{devUnit.name}</span>
                          <span className="text-fuchsia-300/70">
                            q{devUnit.hexQ} r{devUnit.hexR} · {((devUnit.heading % 360) + 360) % 360}°
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-1">
                          <div />
                          <Button
                            variant="outline" size="sm"
                            className="h-7 px-0 border-fuchsia-500/40 text-fuchsia-200 hover:bg-fuchsia-500/20"
                            disabled={devMoveUnit.isPending}
                            onClick={() => applyDev(0, -1, 0)}
                            data-testid="dev-r-minus"
                          ><ArrowUp className="w-3 h-3" /></Button>
                          <div />
                          <Button
                            variant="outline" size="sm"
                            className="h-7 px-0 border-fuchsia-500/40 text-fuchsia-200 hover:bg-fuchsia-500/20"
                            disabled={devMoveUnit.isPending}
                            onClick={() => applyDev(-1, 0, 0)}
                            data-testid="dev-q-minus"
                          ><ArrowLeft className="w-3 h-3" /></Button>
                          <div className="text-center text-[9px] font-mono text-fuchsia-300/60 self-center">HEX</div>
                          <Button
                            variant="outline" size="sm"
                            className="h-7 px-0 border-fuchsia-500/40 text-fuchsia-200 hover:bg-fuchsia-500/20"
                            disabled={devMoveUnit.isPending}
                            onClick={() => applyDev(1, 0, 0)}
                            data-testid="dev-q-plus"
                          ><ArrowRight className="w-3 h-3" /></Button>
                          <div />
                          <Button
                            variant="outline" size="sm"
                            className="h-7 px-0 border-fuchsia-500/40 text-fuchsia-200 hover:bg-fuchsia-500/20"
                            disabled={devMoveUnit.isPending}
                            onClick={() => applyDev(0, 1, 0)}
                            data-testid="dev-r-plus"
                          ><ArrowDown className="w-3 h-3" /></Button>
                          <div />
                        </div>
                        <div className="grid grid-cols-2 gap-1 pt-0.5">
                          <Button
                            variant="outline" size="sm"
                            className="h-7 gap-1 border-fuchsia-500/40 text-fuchsia-200 hover:bg-fuchsia-500/20 font-mono text-[10px]"
                            disabled={devMoveUnit.isPending}
                            onClick={() => applyDev(0, 0, -15)}
                            data-testid="dev-rot-ccw"
                          ><RotateCcw className="w-3 h-3" />−15°</Button>
                          <Button
                            variant="outline" size="sm"
                            className="h-7 gap-1 border-fuchsia-500/40 text-fuchsia-200 hover:bg-fuchsia-500/20 font-mono text-[10px]"
                            disabled={devMoveUnit.isPending}
                            onClick={() => applyDev(0, 0, 15)}
                            data-testid="dev-rot-cw"
                          ><RotateCw className="w-3 h-3" />+15°</Button>
                        </div>
                        {devMoveUnit.isError && (
                          <p className="text-[10px] font-mono text-red-400">
                            {(devMoveUnit.error as { message?: string } | undefined)?.message ?? "dev-move failed"}
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="text-[10px] font-mono text-muted-foreground italic">
                        Click any ship to nudge / rotate it.
                      </p>
                    )}
                  </>
                )}
              </div>
            );
          })()}

          {/* ── DEPLOYED — WAITING FOR OPPONENT ── */}
          {game.status === "deploying" && ((mySide === "challenger" && game.challengerDeployed) || (mySide === "opponent" && game.opponentDeployed)) && (
            <div className="p-4 border-b border-border space-y-2" data-testid="panel-awaiting-opponent">
              <p className="text-xs font-mono text-green-400 uppercase tracking-widest flex items-center gap-1.5">
                <CheckCircle className="w-3.5 h-3.5" /> Fleet Deployed
              </p>
              <p className="text-xs font-mono text-muted-foreground">
                Standing by for {mySide === "challenger" ? (game.opponentName ?? "opponent") : (game.challengerName ?? "challenger")} to commit their fleet. The engagement will begin automatically.
              </p>
              {import.meta.env.DEV && (
                <button
                  data-testid="button-dev-skip-deploy"
                  onClick={handleDevSkipDeploy}
                  disabled={devSkipping}
                  className="w-full mt-1 px-2 py-1 rounded border border-amber-500/40 bg-amber-500/5 hover:bg-amber-500/15 text-amber-400 text-[10px] font-mono uppercase tracking-widest transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {devSkipping ? "Skipping…" : "⚡ Dev: Force-Deploy Opponent & Start"}
                </button>
              )}
            </div>
          )}

          {/* ── FLEET YARDS (deploy phase, current player not yet deployed) ── */}
          {game.status === "deploying" && !((mySide === "challenger" && game.challengerDeployed) || (mySide === "opponent" && game.opponentDeployed)) && (
            <div className="p-3 border-b border-border space-y-2 flex flex-col">
              <p className="text-xs font-mono text-primary uppercase tracking-widest">Fleet Yards</p>
              {((mySide === "challenger" && game.opponentDeployed) || (mySide === "opponent" && game.challengerDeployed)) && (
                <p className="text-[10px] font-mono text-green-400/80" data-testid="text-opponent-ready">
                  ⚡ Opponent has deployed — they're waiting on you.
                </p>
              )}
              <p className="text-[10px] font-mono text-muted-foreground leading-snug" data-testid="text-deploy-hint">
                Drag ships from the roster below straight onto the board, or quick-load a saved fleet.
                {fleets && fleets.length === 0 && (
                  <> No fleets yet? <Link to="/fleets" data-testid="link-build-fleet" className="text-primary hover:underline">Build one →</Link></>
                )}
              </p>

              {/* Fleet selector */}
              <Select
                value={yardsFleetId || "__none__"}
                onValueChange={val => {
                  const next = val === "__none__" ? "" : val;
                  setYardsFleetId(next);
                  setStagedUnits([]);
                  setSelectedStagedId(null);
                }}
              >
                <SelectTrigger data-testid="select-yards-fleet" className="bg-background text-xs h-8">
                  <SelectValue placeholder="Quick-load a saved fleet (optional)" />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="__none__">— None (direct drop) —</SelectItem>
                  {fleets?.map(f => (
                    <SelectItem key={f.id} value={String(f.id)}>{f.name} ({f.shipCount} ships)</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={selectedFaction} onValueChange={setSelectedFaction}>
                <SelectTrigger className="bg-background text-xs h-8">
                  <SelectValue placeholder="All factions…" />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="__all__">All factions</SelectItem>
                  {factions.map(f => (
                    <SelectItem key={f} value={f}>{f}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="space-y-1 max-h-44 overflow-y-auto pr-0.5">
                {filteredModels.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-2">No ships</p>
                )}
                {filteredModels.map(ship => (
                  <div
                    key={ship.id}
                    draggable
                    data-testid={`ship-card-${ship.id}`}
                    onDragStart={e => {
                      draggedShipRef.current = ship;
                      e.dataTransfer.effectAllowed = "copy";
                      e.dataTransfer.setData("text/plain", ship.name);
                    }}
                    onDragEnd={() => { draggedShipRef.current = null; }}
                    className="flex items-center justify-between px-2 py-1.5 rounded border border-border bg-background hover:border-primary/40 hover:bg-primary/5 cursor-grab active:cursor-grabbing select-none transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-mono text-foreground truncate">{ship.name}</p>
                      <p className="text-[10px] text-muted-foreground font-mono">{ship.faction}</p>
                    </div>
                    <div className="flex gap-1.5 text-[10px] font-mono text-muted-foreground shrink-0 ml-2">
                      <span title="Hull">{ship.hullPoints}hp</span>
                      <span title="Speed">{ship.speed}"</span>
                      <span title="Points" className="text-amber-500/80">{ship.pointCost}pt</span>
                    </div>
                  </div>
                ))}
              </div>
              {/* Staged unit list */}
              {stagedUnits.length > 0 && (
                <div className="space-y-0.5 pt-1 border-t border-border/50">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">{stagedUnits.length} placed</p>
                    <button
                      className="text-[10px] text-muted-foreground hover:text-destructive font-mono"
                      onClick={() => { setStagedUnits([]); setSelectedStagedId(null); }}
                    >clear all</button>
                  </div>
                  {stagedUnits.map(u => {
                    const isExpanded = selectedStagedId === u.id;
                    // CQ picker only appears in "custom" games. In "standard"
                    // games crew quality is fixed at 4 (Veteran) by the
                    // server, so we don't render the picker at all to keep
                    // the deploy UI uncluttered.
                    const showCQ = isExpanded && game?.crewQualityMode === "custom";
                    return (
                      <div
                        key={u.id}
                        onClick={() => setSelectedStagedId(u.id)}
                        className={`rounded text-[10px] font-mono cursor-pointer transition-colors ${
                          isExpanded
                            ? "bg-primary/10 border border-primary/40 text-foreground"
                            : "bg-background border border-border text-muted-foreground hover:border-border/80"
                        }`}
                        data-testid={`staged-card-${u.id}`}
                      >
                        <div className="flex items-center gap-1.5 px-2 py-1">
                          <span className="flex-1 truncate">{u.locked ? "🔒 " : ""}{u.name}</span>
                          {game?.crewQualityMode === "custom" && (
                            <span className="text-[9px] text-amber-400/80 shrink-0" title="Crew Quality">
                              CQ{u.crewQuality}
                            </span>
                          )}
                          {!u.locked && isExpanded && (
                            <button
                              className="text-muted-foreground hover:text-destructive ml-1"
                              data-testid={`staged-remove-${u.id}`}
                              onClick={e => { e.stopPropagation(); setStagedUnits(prev => prev.filter(s => s.id !== u.id)); setSelectedStagedId(null); }}
                            >✕</button>
                          )}
                        </div>
                        {showCQ && (
                          <div className="px-2 pb-1.5 pt-0.5 border-t border-primary/20">
                            <p className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">
                              Crew Quality — {CREW_QUALITY_LABELS[u.crewQuality]}
                            </p>
                            <div className="grid grid-cols-6 gap-1">
                              {[1, 2, 3, 4, 5, 6].map(cq => (
                                <button
                                  key={cq}
                                  data-testid={`staged-cq-${u.id}-${cq}`}
                                  onClick={e => {
                                    e.stopPropagation();
                                    setStagedUnits(prev => prev.map(s => s.id === u.id ? { ...s, crewQuality: cq } : s));
                                  }}
                                  title={CREW_QUALITY_LABELS[cq]}
                                  className={`h-6 rounded border text-[10px] font-bold transition-colors ${
                                    u.crewQuality === cq
                                      ? "border-amber-400 bg-amber-400/20 text-amber-300"
                                      : "border-border bg-background text-muted-foreground hover:border-amber-400/40 hover:text-foreground"
                                  }`}
                                >
                                  {cq}
                                </button>
                              ))}
                            </div>
                            <p className="text-[9px] text-muted-foreground/70 mt-1 text-center">
                              1 Rookie · 2 Green · 3 Comp · 4 Vet · 5 Elite · 6 Spec Ops
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {/* Deploy — commit the staged fleet. No per-ship lock required;
                  hitting this is the "I'm ready" gesture. */}
              {deployFleet.error && (
                <p data-testid="text-deploy-error" className="text-[10px] font-mono text-red-400 leading-snug px-1">
                  ⚠ {(deployFleet.error as Error).message}
                </p>
              )}
              <Button
                data-testid="button-confirm-deployment"
                className="w-full mt-2 uppercase tracking-widest text-xs gap-2"
                disabled={stagedUnits.length === 0 || deployFleet.isPending}
                onClick={handleYardsDeploy}
              >
                <Swords className="w-3.5 h-3.5" />
                {deployFleet.isPending
                  ? "Deploying…"
                  : stagedUnits.length === 0
                  ? "Drag ships onto the board"
                  : `Commit & Engage (${stagedUnits.length} ship${stagedUnits.length === 1 ? "" : "s"})`}
              </Button>
              <p className="text-[9px] text-muted-foreground font-mono text-center -mt-1 leading-snug">
                Locking a ship (<kbd>L</kbd>) is optional — it just freezes
                position. Hit <span className="text-primary">Commit &amp;
                Engage</span> when ready; the battle starts once both
                commanders commit.
              </p>
              {import.meta.env.DEV && (
                <button
                  data-testid="button-dev-skip-deploy"
                  onClick={handleDevSkipDeploy}
                  disabled={devSkipping}
                  className="w-full mt-1 px-2 py-1 rounded border border-amber-500/40 bg-amber-500/5 hover:bg-amber-500/15 text-amber-400 text-[10px] font-mono uppercase tracking-widest transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {devSkipping ? "Skipping…" : "⚡ Dev: Skip to Movement"}
                </button>
              )}
            </div>
          )}

          {/* Targeted pending challenge — opponent can accept or decline. */}
          {game.status === "pending" && isOpponent && (
            <div className="p-4 border-b border-border space-y-2">
              <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider">Challenge from {game.challengerName}</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  data-testid="button-accept-game"
                  className="flex-1 gap-1.5 uppercase tracking-wider text-xs"
                  onClick={() => acceptGame.mutate({ gameId }, { onSuccess: () => qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) }) })}
                  disabled={acceptGame.isPending}
                >
                  <CheckCircle className="w-3.5 h-3.5" /> Accept
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  data-testid="button-decline-game"
                  className="flex-1 gap-1.5 uppercase tracking-wider text-xs"
                  onClick={() => declineGame.mutate({ gameId }, { onSuccess: () => qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) }) })}
                  disabled={declineGame.isPending}
                >
                  <XCircle className="w-3.5 h-3.5" /> Decline
                </Button>
              </div>
            </div>
          )}

          {/* Open challenge — any non-challenger can claim it; challenger can withdraw it. */}
          {game.status === "open" && !isChallenger && (
            <div className="p-4 border-b border-border space-y-2">
              <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
                {game.visibility === "private" ? "Private engagement" : "Open challenge"} from {game.challengerName}
              </p>
              {game.hasPassword && (
                <Input
                  data-testid="input-accept-password"
                  type="password"
                  autoComplete="off"
                  placeholder="Engagement password"
                  value={joinPassword}
                  onChange={(e) => setJoinPassword(e.target.value)}
                  className="bg-background h-8 text-xs"
                />
              )}
              <Button
                size="sm"
                data-testid="button-accept-open-game"
                className="w-full gap-1.5 uppercase tracking-wider text-xs"
                onClick={() => acceptGame.mutate(
                  { gameId, data: game.hasPassword ? { password: joinPassword } : {} },
                  { onSuccess: () => qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) }) },
                )}
                disabled={acceptGame.isPending || (game.hasPassword && joinPassword.length === 0)}
              >
                <CheckCircle className="w-3.5 h-3.5" /> Accept {game.visibility === "private" ? "Private Engagement" : "Open Challenge"}
              </Button>
              {acceptGame.isError && (
                <p className="text-[11px] text-red-400 font-mono" data-testid="text-accept-error">
                  {(acceptGame.error as Error).message}
                </p>
              )}
            </div>
          )}
          {game.status === "open" && isChallenger && (
            <div className="p-4 border-b border-border space-y-2">
              <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider">Open challenge — awaiting a commander to accept</p>
              <Button
                size="sm"
                variant="destructive"
                data-testid="button-withdraw-game"
                className="w-full gap-1.5 uppercase tracking-wider text-xs"
                onClick={() => declineGame.mutate({ gameId }, { onSuccess: () => qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) }) })}
                disabled={declineGame.isPending}
              >
                <XCircle className="w-3.5 h-3.5" /> Withdraw Challenge
              </Button>
            </div>
          )}

          {/* Surrender. Appears only when every one of MY ships is at 0 hp,
              0 crew, or both — i.e. there's no realistic recovery left.
              Per product spec, surrender ends AND deletes the game (server
              cascade-deletes units/turns/crits), so we redirect to /lobby on
              success. The "Are you sure?" inline confirm prevents misclicks
              from nuking a still-recoverable engagement. */}
          {(game.status === "active" || game.status === "deploying") &&
            (isChallenger || isOpponent) && allMyShipsCombatInert && (
            <div className="p-4 border-b border-border space-y-2" data-testid="surrender-panel">
              <p className="text-xs text-red-400/90 font-mono uppercase tracking-wider">
                All ships disabled — no combat-effective units remain
              </p>
              {confirmingSurrender ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    data-testid="button-confirm-surrender"
                    className="flex-1 gap-1.5 uppercase tracking-wider text-xs"
                    onClick={() => surrenderGame.mutate({ gameId }, {
                      onSuccess: () => {
                        qc.invalidateQueries({ queryKey: ["getLobby"] });
                        qc.invalidateQueries({ queryKey: ["listGames"] });
                        setLocation("/lobby");
                      },
                    })}
                    disabled={surrenderGame.isPending}
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    {surrenderGame.isPending ? "Surrendering…" : "Confirm Surrender"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="button-cancel-surrender"
                    className="gap-1.5 uppercase tracking-wider text-xs"
                    onClick={() => setConfirmingSurrender(false)}
                    disabled={surrenderGame.isPending}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="destructive"
                  data-testid="button-surrender"
                  className="w-full gap-1.5 uppercase tracking-wider text-xs"
                  onClick={() => setConfirmingSurrender(true)}
                >
                  <XCircle className="w-3.5 h-3.5" /> Surrender Engagement
                </Button>
              )}
              {surrenderGame.isError && (
                <p className="text-[11px] text-red-400 font-mono" data-testid="text-surrender-error">
                  {(surrenderGame.error as Error).message}
                </p>
              )}
            </div>
          )}


          {/* Selected unit info */}
          {selectedUnitData && (
            <div data-testid="selected-unit-panel" className="p-4 border-b border-border">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Selected Unit</span>
                <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setSelectedUnit(null)}>clear</button>
              </div>
              <div className="space-y-1">
                <p className="font-bold text-sm text-primary">{selectedUnitData.name}</p>
                <p className="text-xs text-muted-foreground font-mono">{selectedUnitData.faction}</p>
                <div className="flex gap-3 text-xs font-mono mt-1">
                  <span className="flex items-center gap-1"><Shield className="w-3 h-3 text-green-400" />{selectedUnitData.hullPoints}/{selectedUnitData.maxHullPoints}</span>
                  <span className="flex items-center gap-1"><Zap className="w-3 h-3 text-amber-400" />{selectedUnitData.weaponDamage} dmg</span>
                  <span className="flex items-center gap-1"><Crosshair className="w-3 h-3 text-blue-400" />r{selectedUnitData.weaponRange}</span>
                </div>
                {/* Slice C: crew + damage-state badges. Crippled/Skeleton are
                    server-derived; damageState exposes adrift / delayed-boom. */}
                <div className="flex gap-1.5 text-[10px] font-mono mt-1 flex-wrap">
                  {(selectedUnitData.maxCrewPoints ?? 0) > 0 && (
                    <span
                      data-testid="badge-crew"
                      className={`px-1.5 py-0.5 rounded border ${
                        selectedUnitData.isSkeletonCrew
                          ? "border-red-500/60 text-red-300 bg-red-500/10"
                          : "border-border text-muted-foreground"
                      }`}
                      title="Crew"
                    >
                      CREW {selectedUnitData.crewPoints}/{selectedUnitData.maxCrewPoints}
                    </span>
                  )}
                  {selectedUnitData.isCrippled && (
                    <span data-testid="badge-crippled" className="px-1.5 py-0.5 rounded border border-red-500/60 text-red-300 bg-red-500/10 uppercase tracking-wider">
                      Crippled
                    </span>
                  )}
                  {selectedUnitData.isSkeletonCrew && (
                    <span data-testid="badge-skeleton" className="px-1.5 py-0.5 rounded border border-orange-500/60 text-orange-300 bg-orange-500/10 uppercase tracking-wider">
                      Skeleton
                    </span>
                  )}
                  {selectedUnitData.damageState === "adrift" && (
                    <span data-testid="badge-adrift" className="px-1.5 py-0.5 rounded border border-yellow-500/60 text-yellow-300 bg-yellow-500/10 uppercase tracking-wider">
                      Adrift
                    </span>
                  )}
                  {selectedUnitData.damageState === "exploding-end-of-next" && (
                    <span data-testid="badge-exploding" className="px-1.5 py-0.5 rounded border border-red-500/80 text-red-200 bg-red-500/20 uppercase tracking-wider animate-pulse">
                      Detonating
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">Hex: {selectedUnitData.hexQ},{selectedUnitData.hexR}</p>
              </div>
            </div>
          )}

          {/* Turn actions */}
          {game.status === "active" && isMyActivation && (
            <div className="p-4 border-b border-border space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-xs font-mono text-primary uppercase tracking-wider">
                  Round {game.currentRound}
                </p>
                <Badge
                  data-testid="badge-phase"
                  variant="outline"
                  className={`text-[10px] font-mono uppercase tracking-widest ${
                    currentPhase === "firing"
                      ? "border-red-500/60 text-red-300 bg-red-500/10"
                      : "border-cyan-500/60 text-cyan-300 bg-cyan-500/10"
                  }`}
                >
                  {currentPhase === "firing" ? "Firing" : "Movement"}
                </Badge>
              </div>
              <p className="text-xs font-mono text-muted-foreground">
                {hasActiveUnit
                  ? `Activating ${units.find(u => u.id === activeUnitId)?.name ?? "—"}`
                  : canPassPhase
                    ? "No eligible ships — pass the phase"
                    : "Pick a Ship"}
              </p>
              <Button
                size="sm"
                data-testid="button-end-activation"
                className="w-full gap-1.5 uppercase tracking-widest text-xs font-bold"
                onClick={handleEndActivation}
                disabled={(!hasActiveUnit && !canPassPhase) || endActivation.isPending}
              >
                {endActivation.isPending
                  ? "Ending…"
                  : canPassPhase
                    ? "Pass Phase (N)"
                    : "End Activation (N)"}
              </Button>
              <div className="space-y-1 text-xs text-muted-foreground font-mono">
                <p className="flex items-center gap-1"><Move className="w-3 h-3" /> {turnMoves.length} moves queued</p>
                <p className="flex items-center gap-1"><Target className="w-3 h-3" /> {turnAttacks.length} attacks queued</p>
              </div>
              {selectedUnitData && selectedUnitData.ownerId === myUserId && !selectedUnitData.isDestroyed && currentPhase === "movement" && isSelectedUnitActive && (() => {
                const SPECIAL_ACTIONS: { id: "all-power-engines" | "all-stop" | "all-stop-pivot" | "come-about" | "blast-doors" | "intensify-defense" | "run-silent" | "concentrate-fire"; label: string; cq: number | null; hint: string }[] = [
                  { id: "all-power-engines", label: "All Power to Engines!", cq: null, hint: "Speed +50%; no turns" },
                  { id: "all-stop",          label: "All Stop!",             cq: null, hint: "0..½ speed; no turns" },
                  { id: "all-stop-pivot",    label: "All Stop & Pivot!",     cq: null, hint: "No move; 1 weapon; 2× turn rate" },
                  { id: "come-about",        label: "Come About!",           cq: 9,    hint: "+1 turn this activation" },
                  { id: "blast-doors",       label: "Close Blast Doors!",    cq: null, hint: "1 weapon; 5+ saves vs damage" },
                  { id: "intensify-defense", label: "Intensify Defensive Fire!", cq: 8, hint: "½ AD on all weapons" },
                  { id: "run-silent",        label: "Run Silent!",           cq: 8,    hint: "Stealth; no fire/turn; ≤½ speed" },
                  { id: "concentrate-fire",  label: "Concentrate All Fire!", cq: 8,    hint: "Re-roll missed AD vs picked target" },
                ];
                const rawAction = selectedUnitData.specialAction ?? null;
                const baseAction = rawAction ? rawAction.replace(/-failed$/, "") : null;
                const actionFailed = !!rawAction && rawAction.endsWith("-failed");
                const actionLocked = !!rawAction;
                const activeLabel = baseAction ? SPECIAL_ACTIONS.find(a => a.id === baseAction)?.label ?? baseAction : null;
                const panelLed = getLedger(selectedUnitData.id);
                const movedAlready = panelLed.distance > 0 || panelLed.turns > 0;
                // Pre-compute the server's noSA gates so the buttons can be
                // disabled with an explanatory banner instead of letting the
                // user click and eat a 400. Keep keys in sync with
                // artifacts/api-server/src/lib/critical-table.ts and the
                // skeleton-crew / adrift rules in /special-action.
                const NO_SA_CRIT_KEYS = new Set([
                  "reactor-gas-leak",
                  "reactor-explosion",
                  "crew-decompression",
                  "vital-bridge",
                ]);
                const noSACrit = (selectedUnitData.criticals ?? []).find(c => NO_SA_CRIT_KEYS.has(c.effectKey));
                const isAdrift = selectedUnitData.damageState === "adrift";
                const maxCrewSA = selectedUnitData.maxCrewPoints ?? 0;
                const crewSA = selectedUnitData.crewPoints ?? 0;
                const isSkeletonSA = maxCrewSA > 0 && crewSA * 2 <= maxCrewSA;
                const noSAReason = noSACrit
                  ? `Cannot declare — ${noSACrit.name} active`
                  : isAdrift
                    ? "Cannot declare — ship is adrift"
                    : isSkeletonSA
                      ? "Cannot declare — skeleton crew"
                      : null;
                return (
                  <div className="space-y-1.5" data-testid="special-actions-panel">
                    <div className="text-[10px] uppercase tracking-wider text-amber-400/80 font-mono flex items-center justify-between">
                      <span>Special Action · CQ {selectedUnitData.crewQuality}</span>
                      {actionLocked && (
                        <Badge
                          variant="outline"
                          className={`text-[9px] font-mono ${actionFailed ? "border-red-500/60 text-red-300 bg-red-500/10" : "border-green-500/60 text-green-300 bg-green-500/10"}`}
                          data-testid="badge-active-special-action"
                        >
                          {actionFailed ? "✗" : "✓"} {activeLabel}
                        </Badge>
                      )}
                    </div>
                    {!actionLocked && movedAlready && (
                      <div className="text-[9px] font-mono text-red-300/80 border border-red-500/40 bg-red-500/10 rounded px-2 py-1" data-testid="special-action-locked-by-movement">
                        ✗ Cannot declare — movement already begun this activation
                      </div>
                    )}
                    {!actionLocked && noSAReason && (
                      <div className="text-[9px] font-mono text-red-300/80 border border-red-500/40 bg-red-500/10 rounded px-2 py-1" data-testid="special-action-locked-by-crit">
                        ✗ {noSAReason}
                      </div>
                    )}
                    {!actionLocked && (
                      <div className="grid grid-cols-1 gap-1">
                        {SPECIAL_ACTIONS.map(a => {
                          const needsTarget = a.id === "concentrate-fire";
                          const picking = needsTarget && concentratePicking;
                          const enemyAlive = units.some(x => x.ownerId !== myUserId && !x.isDestroyed);
                          // Block declarations once any movement/turn has been committed in
                          // this activation — declared actions exist to constrain the
                          // activation that follows, so declaring after the fact would let
                          // a ship bypass speed/turn caps (e.g. move full speed then claim
                          // Run Silent's stealth without paying its ½-speed cost).
                          const ledAct = getLedger(selectedUnitData.id);
                          const alreadyMoved = ledAct.distance > 0 || ledAct.turns > 0;
                          const disabled = chooseSpecialAction.isPending || (needsTarget && !enemyAlive) || alreadyMoved || !!noSAReason;
                          return (
                            <button
                              key={a.id}
                              data-testid={`special-action-${a.id}`}
                              disabled={disabled}
                              onClick={() => {
                                if (needsTarget) {
                                  setConcentratePicking(p => !p);
                                  return;
                                }
                                chooseSpecialAction.mutate(
                                  { gameId, unitId: selectedUnitData.id, data: { action: a.id } },
                                  {
                                    onSuccess: (res) => {
                                      setSpecialActionFeedback({
                                        action: res.action,
                                        success: res.success,
                                        cqRoll: res.cqRoll ?? null,
                                        cqTotal: res.cqTotal ?? null,
                                        cqRequired: res.cqRequired ?? null,
                                      });
                                      qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
                                    },
                                    onError: (err: any) => {
                                      setSpecialActionFeedback({ action: a.id, success: false, cqRoll: null, cqTotal: null, cqRequired: a.cq });
                                      // eslint-disable-next-line no-console
                                      console.warn("Special action failed:", err?.message);
                                    },
                                  },
                                );
                              }}
                              className={`text-left rounded border px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                                picking
                                  ? "border-amber-400/80 bg-amber-400/15 text-amber-200"
                                  : "border-amber-500/30 bg-black/40 text-amber-300/90 hover:bg-amber-500/10"
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <span className="font-bold">{a.label}</span>
                                <span className="text-[9px] opacity-70">{a.cq === null ? "AUTO" : `CQ ${a.cq}+`}</span>
                              </div>
                              <div className="text-[9px] opacity-70">
                                {picking ? "▸ Click an enemy ship to nominate" : a.hint}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {specialActionFeedback && (
                      <div
                        className={`rounded border px-2 py-1 text-[10px] font-mono ${
                          specialActionFeedback.success
                            ? "border-green-500/50 bg-green-500/10 text-green-300"
                            : "border-red-500/50 bg-red-500/10 text-red-300"
                        }`}
                        data-testid="special-action-feedback"
                      >
                        {specialActionFeedback.cqRoll !== null && specialActionFeedback.cqTotal !== null && specialActionFeedback.cqRequired !== null
                          ? `Rolled ${specialActionFeedback.cqRoll} + CQ ${selectedUnitData.crewQuality} = ${specialActionFeedback.cqTotal} vs ${specialActionFeedback.cqRequired}+ → ${specialActionFeedback.success ? "SUCCESS" : "FAIL"}`
                          : `${specialActionFeedback.success ? "✓ ENGAGED" : "✗ FAILED"}`}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Critical-damage panel: persistent list of active crits on the
                  selected own-ship, with damage-control buttons. */}
              {selectedUnitData && selectedUnitData.ownerId === myUserId && !selectedUnitData.isDestroyed && (selectedUnitData.criticals?.length ?? 0) > 0 && (() => {
                const crits = selectedUnitData.criticals ?? [];
                const currentRound = game?.currentRound ?? 0;
                const dcAttemptedThisRound = (selectedUnitData.lastDcRound ?? 0) === currentRound;
                return (
                  <div className="space-y-1.5" data-testid="crit-panel">
                    <div className="text-[10px] uppercase tracking-wider text-red-400/80 font-mono flex items-center justify-between">
                      <span>Critical Damage · {crits.length}</span>
                      {dcAttemptedThisRound && (
                        <span className="text-[9px] text-red-300/60">DC used this round</span>
                      )}
                    </div>
                    {crits.map((c) => {
                      const isSameRound = c.appliedRound === currentRound;
                      const canRepair = c.repairable && !isSameRound && !dcAttemptedThisRound && !damageControl.isPending;
                      return (
                        <div key={c.id} className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 font-mono text-[11px] text-red-200" data-testid={`crit-row-${c.id}`}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-bold uppercase">{c.name}</span>
                            <span className="text-[9px] opacity-70">
                              {c.damageApplied > 0 && `−${c.damageApplied}H `}
                              {c.crewApplied > 0 && `−${c.crewApplied}C`}
                            </span>
                          </div>
                          {(c.randomArc || (c.lostTraits?.length ?? 0) > 0) && (
                            <div className="text-[9px] opacity-70 mt-0.5">
                              {c.randomArc && <>arc: {c.randomArc} </>}
                              {(c.lostTraits?.length ?? 0) > 0 && <>lost: {c.lostTraits.join(", ")}</>}
                            </div>
                          )}
                          <button
                            data-testid={`damage-control-${c.id}`}
                            disabled={!canRepair}
                            onClick={() => {
                              damageControl.mutate(
                                { gameId, unitId: selectedUnitData.id, data: { effectId: c.id } },
                                { onSettled: () => qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) }) },
                              );
                            }}
                            className="mt-1 w-full rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-300 hover:bg-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {!c.repairable
                              ? "Unrepairable"
                              : isSameRound
                              ? "Wait until next round"
                              : dcAttemptedThisRound
                              ? "DC locked this round"
                              : `Damage Control (1d6+CQ${selectedUnitData.crewQuality}≥9)`}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {selectedUnitData && selectedUnitData.ownerId === myUserId && !selectedUnitData.isDestroyed && currentPhase === "movement" && (
                <div className="space-y-1.5">
                  <div
                    className={`rounded border px-2 py-1.5 font-mono text-xs ${
                      movePlan
                        ? "border-cyan-500/60 bg-cyan-500/10 text-cyan-300"
                        : turnMoves.some(m => m.unitId === selectedUnitData.id)
                        ? "border-green-500/50 bg-green-500/10 text-green-400"
                        : "border-amber-500/30 bg-black/40 text-amber-400/70"
                    }`}
                    data-testid="move-plan-hud"
                  >
                    <div className="text-[10px] uppercase tracking-wider opacity-70 mb-0.5">
                      Plan · {selectedUnitData.name}
                    </div>
                    <div className="text-sm font-bold">
                      {movePlan?.kind === "forward" && `FORWARD ${movePlan.distance.toFixed(1)}" / ${selectedRemainingMove.toFixed(1)}" left`}
                      {movePlan?.kind === "turn" && `TURN ${movePlan.deltaDeg > 0 ? "+" : "−"}${Math.abs(movePlan.deltaDeg)}° / ±${selectedUnitData.turnAngle}°`}
                      {!movePlan && turnMoves.some(m => m.unitId === selectedUnitData.id) && "QUEUED"}
                      {!movePlan && !turnMoves.some(m => m.unitId === selectedUnitData.id) && "— idle —"}
                    </div>
                    <div className="text-[10px] uppercase tracking-wider opacity-70 mt-1">
                      Phase: {getLedger(selectedUnitData.id).distance.toFixed(1)}"/{selectedUnitData.speed}" moved · {getLedger(selectedUnitData.id).turns}/{selectedUnitData.turns ?? 1} turns
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground font-mono leading-relaxed">
                    <span className="text-amber-400">F</span> fwd (drag mouse) · <span className="text-amber-400">R</span> turn CW · <span className="text-amber-400">⇧R</span> turn CCW · <span className="text-amber-400">␣</span>/<span className="text-amber-400">↵</span> commit · <span className="text-amber-400">Esc</span> cancel
                  </p>
                </div>
              )}

              {/* ── FIRING PHASE: weapon list for the active ship ── */}
              {currentPhase === "firing" && hasActiveUnit && (() => {
                const attacker = units.find(u => u.id === activeUnitId);
                if (!attacker || attacker.ownerId !== myUserId) return null;
                const weapons = (weaponsByFilename[attacker.modelFilename] as Weapon[] | undefined) ?? [];
                // Authoritative fired-set = server's ledger ∪ optimistic local
                // adds (covers the brief window before query invalidation lands).
                const serverFired = new Set((attacker.firedWeaponIds ?? []) as number[]);
                const pendingForThisUnit =
                  pendingFired && pendingFired.unitId === attacker.id ? pendingFired.ids : null;
                const firedSet = new Set<number>([
                  ...serverFired,
                  ...(pendingForThisUnit ?? []),
                ]);
                return (
                  <div className="space-y-1.5" data-testid="firing-panel">
                    <div className="text-[10px] uppercase tracking-wider text-red-300/80 font-mono">
                      Weapons · {attacker.name}
                    </div>
                    {weapons.length === 0 && (
                      <p className="text-xs text-muted-foreground font-mono italic">No weapons.</p>
                    )}
                    {weapons.map(w => {
                      const fired = firedSet.has(w.id);
                      const picking = firingWeaponPicking === w.id;
                      return (
                        <button
                          key={w.id}
                          data-testid={`weapon-${w.id}`}
                          disabled={fired || fireWeapon.isPending}
                          onClick={() => setFiringWeaponPicking(picking ? null : w.id)}
                          className={`w-full text-left rounded border px-2 py-1.5 font-mono text-xs transition-colors ${
                            fired
                              ? "border-red-500/30 bg-red-500/5 text-red-300/60 line-through cursor-not-allowed"
                              : picking
                              ? "border-amber-400/80 bg-amber-400/15 text-amber-200"
                              : "border-green-500/40 bg-green-500/5 text-green-300 hover:bg-green-500/10"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-bold">{w.name || w.arc}</span>
                            <span className="text-[10px] opacity-70">{w.attackDice}AD · r{w.range}"</span>
                          </div>
                          <div className="text-[10px] opacity-70 mt-0.5">
                            {w.arc}{w.traits ? ` · ${w.traits}` : ""}
                          </div>
                          {picking && (
                            <div className="text-[10px] text-amber-200 mt-1 uppercase tracking-wider">
                              ▸ Click an enemy ship to fire
                            </div>
                          )}
                        </button>
                      );
                    })}
                    <p className="text-[10px] text-muted-foreground font-mono">
                      Pick weapons → target → End Activation when done.
                    </p>
                  </div>
                );
              })()}
            </div>
          )}

          {/* Enemy fleet roster (top) */}
          <div className="flex-1 overflow-hidden flex flex-col border-b border-border">
            <div className="px-4 pt-3 pb-2 border-b border-border flex items-center justify-between">
              <p className="text-xs font-mono text-red-400 uppercase tracking-wider">Enemy Fleet</p>
              <span className="text-[10px] font-mono text-muted-foreground">{units.filter(u => u.ownerId !== myUserId && !u.isDestroyed).length}/{units.filter(u => u.ownerId !== myUserId).length}</span>
            </div>
            <ScrollArea className="flex-1 px-4 py-2">
              {units.filter(u => u.ownerId !== myUserId).length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">No enemy contacts</p>
              ) : (
                <div className="space-y-1">
                  {units.filter(u => u.ownerId !== myUserId).map(unit => {
                    const selected = selectedUnit === unit.id;
                    return (
                      <div
                        key={unit.id}
                        data-testid={`unit-${unit.id}`}
                        className={`flex items-center justify-between text-xs rounded px-2 py-1 cursor-pointer transition-colors ${selected ? "border border-yellow-400/60 bg-yellow-400/10" : "border border-red-500/30 bg-red-500/5 hover:bg-red-500/10"} ${unit.isDestroyed ? "opacity-40 line-through" : ""}`}
                        onClick={() => handleUnitClick(unit.id)}
                      >
                        <span className={`font-mono truncate max-w-[110px] ${selected ? "text-yellow-300" : "text-red-300"}`}>{unit.name}</span>
                        <span className="font-mono text-muted-foreground shrink-0">{unit.hullPoints}/{unit.maxHullPoints}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* My fleet roster (bottom) */}
          <div>
            <div className="px-4 pt-3 pb-2 flex items-center justify-between">
              <p className="text-xs font-mono text-green-400 uppercase tracking-wider">My Fleet</p>
              <span className="text-[10px] font-mono text-muted-foreground">{units.filter(u => u.ownerId === myUserId && !u.isDestroyed).length}/{units.filter(u => u.ownerId === myUserId).length}</span>
            </div>
            <ScrollArea className="h-32 px-4 pb-3">
              <div className="space-y-1">
                {units.filter(u => u.ownerId === myUserId).length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2 text-center">No units deployed</p>
                ) : (
                  units.filter(u => u.ownerId === myUserId).map(unit => {
                    const selected = selectedUnit === unit.id;
                    // Firing-phase derelict: hull or crew gone. Cannot be
                    // activated to fire. Greyed out + "INERT" badge so the
                    // player understands why clicking does nothing.
                    const firingInert =
                      currentPhase === "firing" && !unit.isDestroyed && (
                        unit.hullPoints <= 0 ||
                        ((unit.maxCrewPoints ?? 0) > 0 && (unit.crewPoints ?? 0) <= 0)
                      );
                    return (
                      <div
                        key={unit.id}
                        data-testid={`unit-${unit.id}`}
                        className={`flex items-center justify-between text-xs rounded px-2 py-1 transition-colors ${selected ? "border border-blue-400/60 bg-blue-400/10" : "border border-green-500/30 bg-green-500/5 hover:bg-green-500/10"} ${unit.isDestroyed ? "opacity-40 line-through cursor-not-allowed" : firingInert ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                        onClick={() => handleUnitClick(unit.id)}
                        title={firingInert ? (unit.hullPoints <= 0 ? "Hull breached — cannot fire" : "No surviving crew — cannot fire") : undefined}
                      >
                        <span className={`font-mono truncate max-w-[110px] ${selected ? "text-blue-300" : "text-green-300"}`}>{unit.name}</span>
                        <div className="flex items-center gap-1 shrink-0">
                          {firingInert && (
                            <span
                              data-testid={`unit-${unit.id}-inert-badge`}
                              className="font-mono text-[9px] uppercase tracking-wider px-1 py-px rounded bg-red-500/20 text-red-300 border border-red-500/40"
                            >
                              Inert
                            </span>
                          )}
                          <span className="font-mono text-muted-foreground">{unit.hullPoints}/{unit.maxHullPoints}</span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      </div>

      {/* ── DICE ROLL MODAL ── */}
      {diceModal && (
        <DiceRollModal
          modal={diceModal}
          setModal={setDiceModal}
          onClose={() => {
            // The shot was already applied authoritatively on the server,
            // but we deliberately deferred the cache invalidation so the
            // board didn't reveal the outcome before the player rolled.
            // Refresh now that the dice modal is dismissed.
            qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
            setDiceModal(null);
          }}
        />
      )}
    </Layout>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Dice roll modal — plays a brief shuffle animation, then reveals the server's
// authoritative attack rolls / hits / damage / crits.
// ─────────────────────────────────────────────────────────────────────────────
function DiceFace({ value, rolling }: { value: number; rolling: boolean }) {
  const [display, setDisplay] = useState<number>(value);
  useEffect(() => {
    if (!rolling) { setDisplay(value); return; }
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last > 80) {
        setDisplay(1 + Math.floor(Math.random() * 6));
        last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [rolling, value]);
  return (
    <span className="inline-flex items-center justify-center w-9 h-9 rounded border border-amber-500/60 bg-black/60 text-amber-300 font-mono text-lg font-bold tabular-nums">
      {display}
    </span>
  );
}

function DiceRollModal({
  modal,
  setModal,
  onClose,
}: {
  modal: DiceModalState;
  setModal: React.Dispatch<React.SetStateAction<DiceModalState | null>>;
  onClose: () => void;
}) {
  const { weapon, targetName, attackDice, phase, result, error, confirmingClose, critIndex } = modal;
  const attackRolling = phase === "attack-rolling";
  const damageRolling = phase === "damage-rolling";
  const critRolling = phase === "crit-rolling";
  // Show attack dice once we've started rolling them; before that they're hidden.
  const attackVisible = phase !== "pending" && phase !== "attack-ready" && phase !== "error";
  // Show damage dice once we've started rolling them. They persist through the
  // per-crit reveal so the player keeps the context of where each crit came from.
  const damageVisible =
    phase === "damage-rolling" || phase === "damage-shown" ||
    phase === "crit-ready" || phase === "crit-rolling" || phase === "crit-shown";
  // Crit reveal panel: only after the first crit roll has started.
  const critVisible = phase === "crit-rolling" || phase === "crit-shown";
  const crits = result?.criticalsApplied ?? [];
  const hasCrits = crits.length > 0;
  // Final summary only after the entire reveal is done (last crit shown,
  // or damage-shown with no crits, or attack-shown with no hits).
  const summaryVisible =
    (phase === "crit-shown" && critIndex !== undefined && critIndex >= crits.length - 1) ||
    (phase === "damage-shown" && !hasCrits) ||
    (phase === "attack-shown" && result !== undefined && result.hits === 0);

  const rolls = result?.attackRolls ?? Array.from({ length: attackDice }, () => 0);
  const rollKinds = result?.attackRollKinds ?? [];
  const hitThreshold = result?.hitThreshold;

  // ── Stage transitions ──
  // Roll-to-hit: attack-ready → attack-rolling (animate ~700ms) → attack-shown.
  const handleRollAttack = () => {
    setModal(m => (m ? { ...m, phase: "attack-rolling" } : null));
    setTimeout(() => {
      setModal(m => (m && m.phase === "attack-rolling" ? { ...m, phase: "attack-shown" } : m));
    }, 700);
  };
  // Roll-damage: damage-ready → damage-rolling → damage-shown.
  const handleRollDamage = () => {
    setModal(m => (m ? { ...m, phase: "damage-rolling" } : null));
    setTimeout(() => {
      setModal(m => (m && m.phase === "damage-rolling" ? { ...m, phase: "damage-shown" } : m));
    }, 700);
  };
  // Attack-shown → if any hits queue damage-ready, otherwise this is terminal
  // and the close button takes over (no damage to roll).
  const handleProceedToDamage = () => {
    setModal(m => (m ? { ...m, phase: "damage-ready" } : null));
  };
  // Damage-shown → if any crits queue per-crit reveal, otherwise terminal.
  const handleProceedToCrits = () => {
    setModal(m => (m ? { ...m, phase: "crit-ready", critIndex: 0 } : null));
  };
  // Crit-ready (or crit-shown for non-last) → start rolling the next crit.
  const handleRollCrit = () => {
    setModal(m => {
      if (!m) return null;
      // If we're advancing from a previously-shown crit, bump the index.
      const nextIdx = m.phase === "crit-shown" ? (m.critIndex ?? 0) + 1 : (m.critIndex ?? 0);
      return { ...m, phase: "crit-rolling", critIndex: nextIdx };
    });
    setTimeout(() => {
      setModal(m => (m && m.phase === "crit-rolling" ? { ...m, phase: "crit-shown" } : m));
    }, 700);
  };
  // Close flow always passes through a confirm step so the player can't lose
  // the result by misclicking the backdrop or the corner X. Final confirm
  // delegates to the parent so it can invalidate the game query (deferred
  // until close so the board doesn't reveal damage before the dice roll).
  const requestClose = () => setModal(m => (m ? { ...m, confirmingClose: true } : null));
  const cancelClose = () => setModal(m => (m ? { ...m, confirmingClose: false } : null));
  const confirmClose = () => onClose();

  // The footer button is contextual based on phase. Disabled while shuffles play.
  const footer = (() => {
    if (phase === "error") {
      return { label: "Close", onClick: requestClose, testid: "button-close-dice-modal", disabled: false };
    }
    if (phase === "pending") {
      return { label: "Resolving…", onClick: () => {}, testid: "button-pending", disabled: true };
    }
    if (phase === "attack-ready") {
      return { label: `Roll to Hit · ${attackDice}D`, onClick: handleRollAttack, testid: "button-roll-attack", disabled: false };
    }
    if (phase === "attack-rolling") {
      return { label: "Rolling…", onClick: () => {}, testid: "button-rolling-attack", disabled: true };
    }
    if (phase === "attack-shown") {
      if (result && result.hits > 0) {
        return { label: `Roll Damage · ${result.hits}D`, onClick: handleProceedToDamage, testid: "button-proceed-damage", disabled: false };
      }
      return { label: "Close", onClick: requestClose, testid: "button-close-dice-modal", disabled: false };
    }
    if (phase === "damage-ready") {
      return { label: `Roll Damage · ${result?.hits ?? 0}D`, onClick: handleRollDamage, testid: "button-roll-damage", disabled: false };
    }
    if (phase === "damage-rolling") {
      return { label: "Rolling…", onClick: () => {}, testid: "button-rolling-damage", disabled: true };
    }
    if (phase === "damage-shown") {
      if (hasCrits) {
        return { label: `Roll Crits · ${crits.length}`, onClick: handleProceedToCrits, testid: "button-proceed-crits", disabled: false };
      }
      return { label: "Close", onClick: requestClose, testid: "button-close-dice-modal", disabled: false };
    }
    if (phase === "crit-ready") {
      const idx = (critIndex ?? 0) + 1;
      return { label: `Roll Crit ${idx} of ${crits.length}`, onClick: handleRollCrit, testid: "button-roll-crit", disabled: false };
    }
    if (phase === "crit-rolling") {
      return { label: "Rolling…", onClick: () => {}, testid: "button-rolling-crit", disabled: true };
    }
    if (phase === "crit-shown") {
      const cur = (critIndex ?? 0);
      if (cur < crits.length - 1) {
        return { label: `Roll Crit ${cur + 2} of ${crits.length}`, onClick: handleRollCrit, testid: "button-roll-next-crit", disabled: false };
      }
      return { label: "Close", onClick: requestClose, testid: "button-close-dice-modal", disabled: false };
    }
    // Fallback (unreachable in normal flow): treat as terminal.
    return { label: "Close", onClick: requestClose, testid: "button-close-dice-modal", disabled: false };
  })();

  // ── Free-floating, draggable panel ──
  // No backdrop — the battlefield underneath stays visible AND clickable so
  // the player can watch a fresh shot fly while the previous dice result is
  // still on screen. The header bar is the drag handle; position is clamped
  // to the viewport on every move and on window resize so the panel can't
  // get marooned offscreen.
  const PANEL_W = 448;            // ~max-w-md
  const PANEL_H_ESTIMATE = 360;   // generous; only used for initial clamp
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    if (typeof window === "undefined") return { x: 100, y: 80 };
    return { x: Math.max(16, window.innerWidth - PANEL_W - 24), y: 80 };
  });
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const clamp = useCallback((x: number, y: number) => {
    if (typeof window === "undefined") return { x, y };
    const h = panelRef.current?.offsetHeight ?? PANEL_H_ESTIMATE;
    const w = panelRef.current?.offsetWidth ?? PANEL_W;
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - h);
    return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
  }, []);

  useEffect(() => {
    const onResize = () => setPos(p => clamp(p.x, p.y));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Ignore drags initiated on interactive controls inside the header (X button, etc.).
    if ((e.target as HTMLElement).closest("button")) return;
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    setPos(clamp(e.clientX - dragRef.current.dx, e.clientY - dragRef.current.dy));
  };
  const onHeaderPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
  };

  return (
    <div
      ref={panelRef}
      className="fixed z-50 w-full max-w-md bg-card border border-amber-500/40 rounded-md p-5 shadow-2xl"
      style={{ left: pos.x, top: pos.y }}
      data-testid="dice-modal"
      onClick={e => e.stopPropagation()}
    >
        {/* Corner X — routes through confirm-close. */}
        <button
          type="button"
          data-testid="button-x-dice-modal"
          aria-label="Close"
          className="absolute top-2 right-2 text-amber-400/60 hover:text-amber-300 font-mono text-sm w-7 h-7 flex items-center justify-center z-10"
          onClick={requestClose}
        >
          ✕
        </button>

        {/* Header doubles as drag handle. */}
        <div
          className="flex items-center justify-between mb-3 pr-7 cursor-move select-none touch-none"
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={onHeaderPointerUp}
          onPointerCancel={onHeaderPointerUp}
          data-testid="dice-modal-drag-handle"
          title="Drag to move"
        >
          <div>
            <p className="text-[10px] uppercase tracking-widest text-amber-400/70 font-mono flex items-center gap-1.5">
              <span className="inline-block w-3 text-amber-400/50">⋮⋮</span> Firing
            </p>
            <p className="text-sm font-mono font-bold text-amber-300">
              {weapon.name || weapon.arc} → {targetName}
            </p>
          </div>
          <p className="text-[10px] font-mono text-muted-foreground">
            {attackDice}AD · r{weapon.range}" · {weapon.arc}
          </p>
        </div>

        {phase === "error" && (
          <div className="text-sm font-mono text-red-400 py-4 text-center" data-testid="dice-error">
            ✕ {error}
          </div>
        )}

        {phase === "pending" && (
          <div className="text-sm font-mono text-amber-300/70 py-6 text-center" data-testid="dice-pending">
            Resolving shot on the server…
          </div>
        )}

        {phase === "attack-ready" && (
          <div className="text-sm font-mono text-muted-foreground py-4 text-center" data-testid="dice-prompt-attack">
            Ready to roll <span className="text-amber-300 font-bold">{attackDice}</span> attack
            dice{hitThreshold ? <> · need <span className="text-amber-300 font-bold">{hitThreshold}+</span> to hit</> : null}.
            {result?.stealthCheckTarget != null && (
              <div className="mt-2 text-[11px] text-cyan-300/80" data-testid="stealth-prompt">
                Target is stealthed — single 1d6 must hit{" "}
                <span className="font-bold">{result.stealthCheckTarget}+</span> or the attack misses.
              </div>
            )}
          </div>
        )}

        {/* Stealth check (per-attack 1d6, defender's Stealth trait). Shows
            during/after the attack roll. PASS → continues to AD; FAIL →
            attack misses entirely (server returns 0 AD rolled). */}
        {attackVisible && result?.stealthCheckTarget != null && result?.stealthCheckRoll != null && (
          <div className="space-y-1" data-testid="stealth-panel">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
              Stealth Check · need {result.stealthCheckTarget}+
              {!attackRolling && (
                result.stealthCheckPassed
                  ? <span className="ml-2 text-green-400" data-testid="stealth-result-pass">PASS</span>
                  : <span className="ml-2 text-red-400 animate-pulse" data-testid="stealth-result-fail">MISS — STEALTH</span>
              )}
            </p>
            <div className="flex items-center gap-2">
              <div
                className={`relative rounded ${
                  !attackRolling && !result.stealthCheckPassed
                    ? "ring-2 ring-red-500 ring-offset-2 ring-offset-background shadow-[0_0_8px_rgba(248,113,113,0.7)]"
                    : !attackRolling
                    ? "ring-1 ring-cyan-400/60 ring-offset-1 ring-offset-background"
                    : ""
                }`}
                data-testid="stealth-die"
              >
                <DiceFace value={result.stealthCheckRoll} rolling={attackRolling} />
              </div>
              {!attackRolling && !result.stealthCheckPassed && (
                <span className="text-[11px] font-mono text-red-400/90">
                  Attack does not get through.
                </span>
              )}
            </div>
          </div>
        )}

        {/* Attack dice (revealed during/after rolling). Beam-trait dice that
            "exploded" (rolled 4+ and spawned another die) get a glowing
            orange ring + EXPL tag so the player can spot Beam chains at a
            glance. Twin-Linked / Concentrate Fire re-rolls get a subtler
            cyan tag. */}
        {attackVisible && (
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
              Attack {hitThreshold ? `· need ${hitThreshold}+` : ""}
              {!attackRolling && (result?.beamExplosions ?? 0) > 0 && (
                <span className="ml-2 text-orange-400 animate-pulse" data-testid="badge-beam-chain">
                  ⚡ {result?.beamExplosions} beam explosion{(result?.beamExplosions ?? 0) === 1 ? "" : "s"}
                </span>
              )}
            </p>
            <div className="flex flex-wrap gap-2" data-testid="attack-dice">
              {rolls.map((r, i) => {
                const kind = rollKinds[i] ?? "normal";
                const exploded = kind === "explosion";
                const reroll = kind === "twin-reroll" || kind === "concentrate-reroll";
                const hit = !attackRolling && hitThreshold !== undefined && r >= hitThreshold;
                // Broader orange ring (ring-2 + offset) + soft glow for
                // exploded dice. Cyan ring for re-rolls so all three flavours
                // of "extra" die are visually distinct from regular AD.
                const ringCls = exploded
                  ? "ring-2 ring-orange-400 ring-offset-2 ring-offset-background shadow-[0_0_8px_rgba(251,146,60,0.7)] rounded"
                  : reroll
                  ? "ring-1 ring-cyan-400/70 ring-offset-1 ring-offset-background rounded"
                  : "";
                return (
                  <div
                    key={i}
                    className={`relative ${ringCls} ${hit ? "" : !attackRolling ? "opacity-60" : ""}`}
                    data-testid={`attack-die-${i}`}
                    data-kind={kind}
                  >
                    <DiceFace value={r} rolling={attackRolling} />
                    {hit && (
                      <span className="absolute -bottom-1 -right-1 text-[8px] font-mono text-green-400 bg-black/80 px-1 rounded">HIT</span>
                    )}
                    {!attackRolling && exploded && (
                      <span className="absolute -top-1 -left-1 text-[8px] font-mono text-orange-300 bg-black/80 px-1 rounded">EXPL</span>
                    )}
                    {!attackRolling && reroll && (
                      <span className="absolute -top-1 -left-1 text-[8px] font-mono text-cyan-300 bg-black/80 px-1 rounded">RR</span>
                    )}
                  </div>
                );
              })}
            </div>
            {phase === "attack-shown" && result && (
              <p className="text-[11px] font-mono text-amber-300/80 pt-1">
                {result.hits} hit{result.hits === 1 ? "" : "s"} of {attackDice}.
              </p>
            )}
          </div>
        )}

        {/* Damage prompt */}
        {phase === "damage-ready" && result && (
          <div className="mt-4 text-sm font-mono text-muted-foreground text-center" data-testid="dice-prompt-damage">
            Ready to roll <span className="text-amber-300 font-bold">{result.hits}</span> damage
            dice (6 = crit).
          </div>
        )}

        {/* Damage dice (during/after damage roll) */}
        {damageVisible && result && result.hits > 0 && (
          <div className="mt-3 space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
              Damage · {result.hits} hit{result.hits === 1 ? "" : "s"}
            </p>
            <div className="flex flex-wrap gap-1.5" data-testid="damage-dice">
              {result.damageRolls.map((d, i) => {
                const dmg = d === 1 ? 0 : d <= 5 ? 1 : 2;
                return (
                  <div key={i} className="flex flex-col items-center">
                    <DiceFace value={d} rolling={damageRolling} />
                    {!damageRolling && (
                      <span className={`text-[10px] font-mono mt-0.5 ${d === 6 ? "text-red-400 font-bold" : d === 1 ? "text-muted-foreground" : "text-amber-300"}`}>
                        {dmg}{d === 6 ? "+crit" : ""}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Per-crit reveal — only after the player has clicked "Roll Crits".
            Walks one crit at a time; each gets a location-d6 + effect-d6
            shuffle animation, then the entry is revealed and the player
            either rolls the next one or closes. The "Roll Crits" prompt
            sits between Damage and the first crit so the reveal is
            explicitly player-driven, not automatic. */}
        {phase === "damage-shown" && hasCrits && (
          <div className="mt-3 text-sm font-mono text-red-300/90 text-center py-2 border-t border-red-500/30 pt-3" data-testid="crit-prompt">
            <span className="font-bold">{crits.length}</span> critical hit{crits.length === 1 ? "" : "s"} pending —
            press <span className="text-amber-300 font-bold">Roll Crits</span> to resolve.
          </div>
        )}
        {phase === "crit-ready" && (
          <div className="mt-3 text-sm font-mono text-red-300/90 text-center py-2 border-t border-red-500/30 pt-3" data-testid="crit-ready-prompt">
            Ready to roll crit <span className="text-amber-300 font-bold">{(critIndex ?? 0) + 1}</span> of {crits.length}.
            <p className="text-[10px] text-muted-foreground mt-1">1d6 location, then 1d6 effect.</p>
          </div>
        )}
        {critVisible && (
          <div className="mt-3 space-y-2" data-testid="criticals-applied">
            <p className="text-[10px] uppercase tracking-wider text-red-300/80 font-mono">
              Criticals · {(critIndex ?? 0) + (phase === "crit-shown" ? 1 : 1)} of {crits.length}
            </p>
            <div className="space-y-2">
              {crits.map((c, i) => {
                const cur = critIndex ?? 0;
                if (i > cur) return null;            // not yet rolled
                const isCurrent = i === cur;
                const rolling = isCurrent && critRolling;
                return (
                  <div
                    key={c.id}
                    className={`rounded px-2 py-1.5 text-[10px] font-mono ${
                      isCurrent
                        ? "border-2 border-red-400 bg-red-500/20 text-red-100 shadow-[0_0_8px_rgba(248,113,113,0.5)]"
                        : "border border-red-500/40 bg-red-500/10 text-red-200"
                    }`}
                    data-testid={`crit-${c.effectKey}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[9px] uppercase text-muted-foreground">Loc</span>
                      <DiceFace value={c.locationRoll ?? 0} rolling={rolling} />
                      <span className="text-[9px] uppercase text-muted-foreground">Eff</span>
                      <DiceFace value={c.effectRoll ?? 0} rolling={rolling} />
                      {!rolling && (
                        <span className="ml-auto opacity-70 text-[10px]">
                          {c.damageApplied > 0 && `−${c.damageApplied}H `}
                          {c.crewApplied > 0 && `−${c.crewApplied}C`}
                        </span>
                      )}
                    </div>
                    {!rolling && (
                      <>
                        <div className="font-bold uppercase">{c.name}</div>
                        {(c.randomArc || c.lostTraits.length > 0) && (
                          <div className="opacity-70 mt-0.5">
                            {c.randomArc && <>arc: {c.randomArc} </>}
                            {c.lostTraits.length > 0 && <>lost: {c.lostTraits.join(", ")}</>}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* "All misses" sits in place of the damage section when applicable. */}
        {phase === "attack-shown" && result && result.hits === 0 && (
          <div className="mt-3 text-sm font-mono text-muted-foreground text-center py-2">
            All misses — no damage to roll.
          </div>
        )}

        {/* Final summary (only after the player has actually seen all dice). */}
        {summaryVisible && result && (
          <div className="mt-4 border-t border-border pt-3 space-y-1 font-mono text-sm" data-testid="dice-summary">
            {/* Defender pipeline — only show rows that actually fired. */}
            {result.dodgesSuccessful > 0 && (
              <div className="flex justify-between" data-testid="row-dodges">
                <span className="text-muted-foreground">Dodged</span>
                <span className="text-cyan-300">−{result.dodgesSuccessful} hit{result.dodgesSuccessful === 1 ? "" : "s"}</span>
              </div>
            )}
            {result.interceptedHits > 0 && (
              <div className="flex justify-between" data-testid="row-intercepted">
                <span className="text-muted-foreground">Interceptors</span>
                <span className="text-cyan-300">−{result.interceptedHits} hit{result.interceptedHits === 1 ? "" : "s"}</span>
              </div>
            )}
            {(result.shieldedHits > 0 || result.targetShieldsBefore !== result.targetShieldsAfter) && (
              <div className="flex justify-between" data-testid="row-shields">
                <span className="text-muted-foreground">Shields {result.shieldedHits > 0 ? `· −${result.shieldedHits} hit${result.shieldedHits === 1 ? "" : "s"}` : ""}</span>
                <span className="text-blue-300">{result.targetShieldsBefore} → {result.targetShieldsAfter}</span>
              </div>
            )}
            {(result.bulkheadHits + result.solidHits + result.criticalHits) > 0 && (
              <div className="flex justify-between" data-testid="row-attack-table">
                <span className="text-muted-foreground">Attack table</span>
                <span className="text-foreground">
                  {result.bulkheadHits > 0 && <>{result.bulkheadHits}B </>}
                  {result.solidHits > 0 && <>{result.solidHits}S </>}
                  {result.criticalHits > 0 && <span className="text-red-400">{result.criticalHits}C</span>}
                </span>
              </div>
            )}
            {result.gegReduction > 0 && (
              <div className="flex justify-between" data-testid="row-geg">
                <span className="text-muted-foreground">GEG reduction</span>
                <span className="text-emerald-300">−{result.gegReduction}</span>
              </div>
            )}
            {result.adaptiveHalved && (
              <div className="flex justify-between" data-testid="row-adaptive">
                <span className="text-muted-foreground">Adaptive armour</span>
                <span className="text-emerald-300">halved</span>
              </div>
            )}
            {(result.blastDoorsDamageSaved > 0 || result.blastDoorsCrewSaved > 0) && (
              <div className="flex justify-between" data-testid="row-blast-doors">
                <span className="text-muted-foreground">Blast doors</span>
                <span className="text-emerald-300">
                  −{result.blastDoorsDamageSaved} dmg
                  {result.blastDoorsCrewSaved > 0 && <> · −{result.blastDoorsCrewSaved} crew</>}
                </span>
              </div>
            )}
            <div className="flex justify-between pt-1 border-t border-border/50">
              <span className="text-muted-foreground">Total damage</span>
              <span className="text-amber-300 font-bold">{result.totalDamage}</span>
            </div>
            {result.crewLost > 0 && (
              <div className="flex justify-between" data-testid="row-crew-lost">
                <span className="text-muted-foreground">Crew lost</span>
                <span className="text-amber-300/80">{result.crewLost}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">{targetName} hull</span>
              <span className={result.targetDestroyed ? "text-red-400 font-bold" : "text-foreground"}>
                {result.targetHullBefore} → {result.targetHullAfter}
                {result.targetDestroyed && " · DESTROYED"}
              </span>
            </div>
          </div>
        )}

        <Button
          data-testid={footer.testid}
          className="w-full mt-4 uppercase tracking-widest text-xs"
          disabled={footer.disabled}
          onClick={footer.onClick}
        >
          {footer.label}
        </Button>

        {/* Confirm-close overlay — small inline prompt above the modal body. */}
        {confirmingClose && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-black/85 rounded-md"
            data-testid="confirm-close-overlay"
          >
            <div className="text-center space-y-3 px-6">
              <p className="font-mono text-sm text-amber-300 uppercase tracking-wider">
                Close window?
              </p>
              <p className="font-mono text-[11px] text-muted-foreground">
                {phase === "damage-shown" || (phase === "attack-shown" && result?.hits === 0) || phase === "error"
                  ? "The shot is already resolved on the server."
                  : "The shot is resolved on the server — you'll lose the dice reveal but the result stands."}
              </p>
              <div className="flex gap-2 justify-center pt-1">
                <Button
                  data-testid="button-confirm-close-yes"
                  className="uppercase tracking-widest text-xs"
                  onClick={confirmClose}
                >
                  Close
                </Button>
                <Button
                  data-testid="button-confirm-close-cancel"
                  variant="outline"
                  className="uppercase tracking-widest text-xs"
                  onClick={cancelClose}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}
