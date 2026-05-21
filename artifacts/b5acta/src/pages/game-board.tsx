import React, { useState, useRef, Suspense, useMemo, useEffect, useCallback } from "react";
import { useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Canvas, useLoader, useThree } from "@react-three/fiber";
import { OrbitControls, Text, useGLTF } from "@react-three/drei";
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
  useListFleets,
  useListFleetShips,
  useListShipModels,
  getGetGameQueryKey,
  getListTurnsQueryKey,
  getListFleetShipsQueryKey,
} from "@workspace/api-client-react";
import type { ShipModel, Weapon } from "@workspace/api-client-react";
import { useUser } from "@clerk/react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Swords, Shield, Target, CheckCircle, XCircle, Crosshair, Move, Zap } from "lucide-react";

function hexToWorld(q: number, r: number): [number, number, number] {
  return [q * 2.25, 0, r * 2.6 + q * 1.3];
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

// GLB: keep original embedded textures; apply a gentle emissive tint for team color
// Models that need a 180° Y-flip to face forward correctly
const FLIP_MODELS = new Set(["oracle.glb", "hyperion.glb"]);

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

function GameUnit3D({ unit, isSelected, onClick, myUserId, weapons }: {
  unit: { id: number; hexQ: number; hexR: number; heading: number; name: string; modelFilename: string; ownerId: string; hullPoints: number; maxHullPoints: number; isDestroyed: boolean; faction: string };
  isSelected: boolean;
  onClick: () => void;
  myUserId: string;
  weapons: Pick<Weapon, "arc">[];
}) {
  const [x, , z] = hexToWorld(unit.hexQ, unit.hexR);
  const isMine = unit.ownerId === myUserId;
  const color = unit.isDestroyed ? "#4b5563" : isMine ? "#f59e0b" : "#ef4444";
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
      {/* Heading arrow */}
      <mesh
        position={[Math.sin(headingRad) * 1.0, 0.06, Math.cos(headingRad) * 1.0]}
        rotation={[Math.PI / 2, headingRad, 0]}
      >
        <coneGeometry args={[0.14, 0.36, 6]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
      </mesh>
      {/* Ship model floating 2" above the base, rotated to heading */}
      <group position={[0, 2, 0]} rotation={[0, headingRad, 0]}>
        <ModelErrorBoundary color={color}>
          <Suspense fallback={<ShipModelFallback color={color} />}>
            <ShipModel3D filename={unit.modelFilename} tint={color} />
          </Suspense>
        </ModelErrorBoundary>
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

// ── Arc visualization ─────────────────────────────────────────────────────────
// Coordinate mapping: arc mesh uses rotation [+π/2, 0, 0] so shape +Y = world +Z = forward.
// All angles are in shape-space radians (counterclockwise from shape +X).
//   Forward   = shape +Y direction = 90° (π/2)
//   Starboard = shape +X direction = 0°
//   Aft       = shape -Y direction = 270° (-π/2)
//   Port      = shape -X direction = 180° (π)
const ARC_DEFS: Record<string, { centerAngle: number; halfAngle: number; color: string; opacity: number; radius?: number }> = {
  "Forward":           { centerAngle: Math.PI / 2,  halfAngle: Math.PI / 4,  color: "#f59e0b", opacity: 0.30 },
  "Starboard":         { centerAngle: 0,             halfAngle: Math.PI / 4,  color: "#06b6d4", opacity: 0.24 },
  "Port":              { centerAngle: Math.PI,       halfAngle: Math.PI / 4,  color: "#06b6d4", opacity: 0.24 },
  "Aft":               { centerAngle: -Math.PI / 2, halfAngle: Math.PI / 4,  color: "#ef4444", opacity: 0.22 },
  "Boresight Forward": { centerAngle: Math.PI / 2,  halfAngle: Math.PI / 24, color: "#fef08a", opacity: 0.85, radius: 1.65 },
  "Boresight Aft":     { centerAngle: -Math.PI / 2, halfAngle: Math.PI / 24, color: "#fb923c", opacity: 0.75, radius: 1.65 },
};

// Label positions in the heading-group's local XZ space (local +Z = world forward)
const ARC_LABELS: Record<string, { pos: [number, number, number]; label: string }> = {
  "Forward":           { pos: [0,    0.07,  1.35], label: "FWD"  },
  "Starboard":         { pos: [1.35, 0.07,  0],    label: "STBD" },
  "Port":              { pos: [-1.35,0.07,  0],    label: "PORT" },
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

// Arcs whose centre is on the fore/aft axis — their centerAngle and label Z must be
// negated for ships whose model is flipped 180° inside the heading group.
const AXIAL_ARCS = new Set(["Forward", "Aft", "Boresight Forward", "Boresight Aft"]);

function WeaponArcDisplay({ weapons, flip = false }: { weapons: Pick<Weapon, "arc">[]; flip?: boolean }) {
  const uniqueArcs = useMemo(() => [...new Set(weapons.map(w => w.arc))], [weapons]);
  return (
    <>
      {uniqueArcs.map(arc => {
        const def = ARC_DEFS[arc];
        if (!def) return null;
        const centerAngle = (flip && AXIAL_ARCS.has(arc)) ? -def.centerAngle : def.centerAngle;
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
        const pos: [number, number, number] = (flip && AXIAL_ARCS.has(arc))
          ? [lbl.pos[0], lbl.pos[1], -lbl.pos[2]]
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

// ── Staged (drag-placed) units ────────────────────────────────────────────────
interface StagedUnitData {
  id: string;
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
}

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
      {/* Heading arrow — points in the direction the ship is facing */}
      <mesh
        position={[Math.sin(headingRad) * 1.0, 0.06, Math.cos(headingRad) * 1.0]}
        rotation={[Math.PI / 2, headingRad, 0]}
      >
        <coneGeometry args={[0.18, 0.45, 6]} />
        <meshStandardMaterial color={baseColor} emissive={baseColor} emissiveIntensity={0.5} />
      </mesh>
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
  const myUserId = user?.id ?? "";
  const qc = useQueryClient();

  const { data: gameData, isLoading } = useGetGame(gameId, { query: { queryKey: getGetGameQueryKey(gameId) } });
  const { data: fleets } = useListFleets();
  const { data: shipModels } = useListShipModels();
  const acceptGame = useAcceptGame();
  const declineGame = useDeclineGame();
  const deployFleet = useDeployFleet();
  const submitTurn = useSubmitTurn();

  // Staging / fleet yards
  const threeRef = useRef<{ camera: THREE.Camera; gl: THREE.WebGLRenderer } | null>(null);
  const draggedShipRef = useRef<ShipModel | null>(null);
  const [stagedUnits, setStagedUnits] = useState<StagedUnitData[]>([]);
  const [selectedStagedId, setSelectedStagedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [selectedFaction, setSelectedFaction] = useState<string>("");
  const [isDragOver, setIsDragOver] = useState(false);

  // Keyboard handler for placement phase
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedStagedId) return;
      if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        setStagedUnits(prev => prev.map(u => u.id === selectedStagedId ? { ...u, locked: !u.locked } : u));
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
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
  const [turnMoves, setTurnMoves] = useState<Array<{ unitId: number; toHexQ: number; toHexR: number; newHeading: number }>>([]);
  const [turnAttacks, setTurnAttacks] = useState<Array<{ attackerUnitId: number; targetUnitId: number }>>([]);

  // Fleet Yards: which fleet the player is deploying from
  const [yardsFleetId, setYardsFleetId] = useState<string>("");
  const { data: yardsFleetShips } = useListFleetShips(parseInt(yardsFleetId || "0"), {
    query: { queryKey: getListFleetShipsQueryKey(parseInt(yardsFleetId || "0")), enabled: !!yardsFleetId }
  });

  const game = gameData?.game;
  const units = gameData?.units ?? [];
  const turns = gameData?.turns ?? [];

  const isChallenger = game?.challengerId === myUserId;
  const isOpponent = game?.opponentId === myUserId;
  const isMyTurn = game?.status === "active" && (
    (isChallenger && (game.currentTurn % 2 === 1)) ||
    (isOpponent && (game.currentTurn % 2 === 0))
  );

  const selectedUnitData = units.find(u => u.id === selectedUnit);

  const handleUnitClick = (unitId: number) => {
    const unit = units.find(u => u.id === unitId);
    if (!unit || unit.isDestroyed) return;

    if (selectedUnit && selectedUnit !== unitId && unit.ownerId !== myUserId) {
      // Attack
      const attacker = units.find(u => u.id === selectedUnit);
      if (attacker && attacker.ownerId === myUserId) {
        setTurnAttacks(prev => [...prev.filter(a => a.attackerUnitId !== selectedUnit), { attackerUnitId: selectedUnit, targetUnitId: unitId }]);
        setAttackTarget(unitId);
      }
      return;
    }

    if (unit.ownerId === myUserId) {
      setSelectedUnit(unitId === selectedUnit ? null : unitId);
      setMoveTarget(null);
      setAttackTarget(null);
    }
  };

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
    if (!yardsFleetId || !yardsFleetShips || stagedUnits.length === 0) return;
    // Match each staged unit to an available fleet ship by model filename
    const available = [...yardsFleetShips];
    const placements: Array<{ shipId: number; hexQ: number; hexR: number; heading: number }> = [];
    for (const staged of stagedUnits) {
      const idx = available.findIndex(s => s.shipModel.filename === staged.modelFilename);
      if (idx === -1) continue;
      const ship = available.splice(idx, 1)[0];
      // Convert world coords (inches) to integer grid positions stored in hexQ/hexR
      placements.push({ shipId: ship.id, hexQ: Math.round(staged.x), hexR: Math.round(staged.z), heading: 0 });
    }
    if (placements.length === 0) return;
    deployFleet.mutate(
      { gameId, data: { fleetId: parseInt(yardsFleetId), placements } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
          setStagedUnits([]);
          setSelectedStagedId(null);
        }
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
            if (!draggingId) return;
            const pos = screenToBoard(e.clientX, e.clientY, threeRef);
            if (!pos) return;
            const [x, z] = pos;
            setStagedUnits(prev => prev.map(u => u.id === draggingId ? { ...u, x, z } : u));
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
            const [x, z] = pos;
            const newId = `staged-${Date.now()}`;
            setStagedUnits(prev => [...prev, {
              id: newId,
              name: ship.name,
              modelFilename: ship.filename,
              faction: ship.faction,
              hullPoints: ship.hullPoints,
              speed: ship.speed,
              weaponRange: ship.weaponRange,
              weaponDamage: ship.weaponDamage,
              weapons: ship.weapons ?? [],
              x, z,
              heading: 0,
              locked: false,
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
            {units.map(unit => (
              <GameUnit3D
                key={unit.id}
                unit={unit}
                isSelected={selectedUnit === unit.id}
                onClick={() => handleUnitClick(unit.id)}
                myUserId={myUserId}
                weapons={weaponsByFilename[unit.modelFilename] ?? []}
              />
            ))}
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
          </Canvas>
          {/* Status overlay */}
          <div className="absolute top-3 left-3 flex flex-col gap-1.5 pointer-events-none">
            <div className={`px-2 py-1 rounded text-xs font-mono tracking-widest uppercase border ${
              game.status === "active" ? "bg-green-500/10 border-green-500/30 text-green-400" :
              game.status === "pending" ? "bg-amber-500/10 border-amber-500/30 text-amber-400" :
              game.status === "deploying" ? "bg-blue-500/10 border-blue-500/30 text-blue-400" :
              "bg-muted/10 border-muted/30 text-muted-foreground"
            }`}>
              {game.status} {game.status === "active" && `— Turn ${game.currentTurn}`}
            </div>
            {isMyTurn && (
              <div className="px-2 py-1 rounded text-xs font-mono tracking-widest uppercase border border-primary/40 bg-primary/10 text-primary animate-pulse">
                Your Turn
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

          {/* ── FLEET YARDS (deploy phase only) ── */}
          {game.status === "deploying" && (
            <div className="p-3 border-b border-border space-y-2 flex flex-col">
              <p className="text-xs font-mono text-primary uppercase tracking-widest">Fleet Yards</p>

              {/* Fleet selector */}
              <Select
                value={yardsFleetId}
                onValueChange={val => { setYardsFleetId(val); setStagedUnits([]); setSelectedStagedId(null); }}
              >
                <SelectTrigger data-testid="select-yards-fleet" className="bg-background text-xs h-8">
                  <SelectValue placeholder="Select your fleet…" />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
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
                  {stagedUnits.map(u => (
                    <div
                      key={u.id}
                      onClick={() => setSelectedStagedId(u.id)}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-mono cursor-pointer transition-colors ${
                        selectedStagedId === u.id
                          ? "bg-primary/10 border border-primary/40 text-foreground"
                          : "bg-background border border-border text-muted-foreground hover:border-border/80"
                      }`}
                    >
                      <span className="flex-1 truncate">{u.locked ? "🔒 " : ""}{u.name}</span>
                      {!u.locked && selectedStagedId === u.id && (
                        <button
                          className="text-muted-foreground hover:text-destructive ml-1"
                          onClick={e => { e.stopPropagation(); setStagedUnits(prev => prev.filter(s => s.id !== u.id)); setSelectedStagedId(null); }}
                        >✕</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {/* Confirm deployment */}
              <Button
                data-testid="button-confirm-deployment"
                className="w-full mt-2 uppercase tracking-widest text-xs gap-2"
                disabled={
                  !yardsFleetId ||
                  stagedUnits.length === 0 ||
                  stagedUnits.some(u => !u.locked) ||
                  deployFleet.isPending
                }
                onClick={handleYardsDeploy}
              >
                {deployFleet.isPending
                  ? "Deploying…"
                  : !yardsFleetId
                  ? "Select a fleet above"
                  : stagedUnits.length === 0
                  ? "Drag ships onto the board"
                  : stagedUnits.some(u => !u.locked)
                  ? `Lock all ships first (${stagedUnits.filter(u => !u.locked).length} unlocked)`
                  : "End Deployment"}
              </Button>
              <p className="text-[9px] text-muted-foreground font-mono text-center -mt-1">
                Select a ship · L to lock · Del to remove
              </p>
            </div>
          )}

          {/* Pending challenge actions */}
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
                <p className="text-xs text-muted-foreground">Hex: {selectedUnitData.hexQ},{selectedUnitData.hexR}</p>
              </div>
            </div>
          )}

          {/* Turn actions */}
          {game.status === "active" && isMyTurn && (
            <div className="p-4 border-b border-border space-y-3">
              <p className="text-xs font-mono text-primary uppercase tracking-wider">Turn {game.currentTurn} — Your Move</p>
              <div className="space-y-1 text-xs text-muted-foreground font-mono">
                <p className="flex items-center gap-1"><Move className="w-3 h-3" /> {turnMoves.length} moves queued</p>
                <p className="flex items-center gap-1"><Target className="w-3 h-3" /> {turnAttacks.length} attacks queued</p>
              </div>
              {selectedUnitData && selectedUnitData.ownerId === myUserId && (
                <p className="text-xs text-muted-foreground">Click an empty hex to plan a move, or click an enemy ship to attack</p>
              )}
              <Button
                size="sm"
                data-testid="button-submit-turn"
                className="w-full gap-1.5 uppercase tracking-widest text-xs font-bold"
                onClick={handleSubmitTurn}
                disabled={submitTurn.isPending || (turnMoves.length === 0 && turnAttacks.length === 0)}
              >
                <Swords className="w-3.5 h-3.5" />
                {submitTurn.isPending ? "Submitting..." : "Commit Orders"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="w-full text-xs text-muted-foreground uppercase tracking-wider"
                onClick={() => { setTurnMoves([]); setTurnAttacks([]); setSelectedUnit(null); }}
              >
                Clear Orders
              </Button>
            </div>
          )}

          {/* Move history */}
          <div className="flex-1 overflow-hidden flex flex-col">
            <div className="px-4 pt-3 pb-2 border-b border-border">
              <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Combat Log</p>
            </div>
            <ScrollArea className="flex-1 px-4 py-2">
              {turns.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">No turns yet</p>
              ) : (
                <div className="space-y-1.5">
                  {turns.map(turn => (
                    <div key={turn.id} data-testid={`turn-${turn.id}`} className="text-xs border border-border rounded px-2 py-1.5 bg-background/40">
                      <div className="font-mono text-muted-foreground">T{turn.turnNumber} &mdash; {turn.playerId === myUserId ? "You" : (isChallenger ? game.opponentName : game.challengerName)}</div>
                      <div className="text-foreground">
                        {Array.isArray(turn.moves) ? (turn.moves as Array<{ unitId: number }>).length : 0} moves,{" "}
                        {Array.isArray(turn.attacks) ? (turn.attacks as Array<{ attackerUnitId: number }>).length : 0} attacks
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* Unit roster */}
          <div className="border-t border-border">
            <div className="px-4 pt-3 pb-2">
              <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Fleet Status</p>
            </div>
            <ScrollArea className="h-32 px-4 pb-3">
              <div className="space-y-1">
                {units.map(unit => (
                  <div
                    key={unit.id}
                    data-testid={`unit-${unit.id}`}
                    className={`flex items-center justify-between text-xs rounded px-2 py-1 cursor-pointer transition-colors ${unit.ownerId === myUserId ? "border border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10" : "border border-red-500/20 bg-red-500/5 hover:bg-red-500/10"} ${unit.isDestroyed ? "opacity-40 line-through" : ""}`}
                    onClick={() => handleUnitClick(unit.id)}
                  >
                    <span className="font-mono truncate max-w-[110px]">{unit.name}</span>
                    <span className="font-mono text-muted-foreground shrink-0">{unit.hullPoints}/{unit.maxHullPoints}</span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>
      </div>
    </Layout>
  );
}
