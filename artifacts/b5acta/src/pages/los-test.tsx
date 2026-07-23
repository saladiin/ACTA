import { Suspense, useEffect, useMemo, useState } from "react";
import { Canvas, type ThreeEvent } from "@react-three/fiber";
import { Line, OrbitControls, Text, useGLTF } from "@react-three/drei";
import * as THREE from "three";
// @ts-ignore
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { Check, RotateCcw, X } from "lucide-react";

import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { findBlockingLineOfSightObstacle, type BoardPoint } from "@/lib/line-of-sight";

type SceneObjectId = "tester" | "target" | "asteroid";

type Placement = {
  x: number;
  z: number;
  heading: number;
};

type Placements = Record<SceneObjectId, Placement>;

type TestWeapon = {
  id: string;
  name: string;
  arc: string;
  range: number;
  attackDice: number;
  traits?: string;
};

type ArcDef = {
  centerAngle: number;
  halfAngle: number;
  color: string;
};

const MODEL_REVISION = "los-test-20260721-field-v2";
const ASTEROID_MODEL = "asteroid-light.glb";
const HYPERION_MODEL = "hyperion.glb";
// Exported base footprint is ~1.78 units wide; scale to a 4" terrain footprint.
const ASTEROID_SCALE = 4 / 1.78;
const HYPERION_LENGTH_INCHES = 2.4;

const HYPERION_WEAPONS: TestWeapon[] = [
  { id: "heavy-laser-forward", name: "Heavy Laser Cannon", arc: "Boresight Forward", range: 18, attackDice: 4, traits: "Beam; Double Damage" },
  { id: "medium-pulse-forward", name: "Medium Pulse Cannon", arc: "Forward", range: 10, attackDice: 4 },
  { id: "plasma-forward", name: "Plasma Cannon", arc: "Forward", range: 8, attackDice: 4, traits: "Armor Piercing; Twin-Linked" },
  { id: "medium-pulse-port", name: "Medium Pulse Cannon", arc: "Port", range: 10, attackDice: 8 },
  { id: "medium-pulse-starboard", name: "Medium Pulse Cannon", arc: "Starboard", range: 10, attackDice: 8 },
  { id: "medium-pulse-aft", name: "Medium Pulse Cannon", arc: "Aft", range: 10, attackDice: 2 },
  { id: "heavy-laser-aft", name: "Heavy Laser Cannon", arc: "Boresight Aft", range: 18, attackDice: 2, traits: "Beam; Double Damage" },
];

const ARC_DEFS: Record<string, ArcDef> = {
  Forward: { centerAngle: Math.PI / 2, halfAngle: Math.PI / 4, color: "#f59e0b" },
  Port: { centerAngle: 0, halfAngle: Math.PI / 4, color: "#22d3ee" },
  Starboard: { centerAngle: Math.PI, halfAngle: Math.PI / 4, color: "#38bdf8" },
  Aft: { centerAngle: -Math.PI / 2, halfAngle: Math.PI / 4, color: "#ef4444" },
  "Boresight Forward": { centerAngle: Math.PI / 2, halfAngle: Math.PI / 24, color: "#fef08a" },
  "Boresight Aft": { centerAngle: -Math.PI / 2, halfAngle: Math.PI / 24, color: "#fb923c" },
  Turret: { centerAngle: Math.PI / 2, halfAngle: Math.PI, color: "#c084fc" },
};

const INITIAL_PLACEMENTS: Placements = {
  tester: { x: -8, z: 0, heading: 90 },
  target: { x: 8, z: 0, heading: -90 },
  asteroid: { x: 0, z: 0, heading: 0 },
};

function modelUrl(filename: string): string {
  return `/api/models/${filename}?v=${encodeURIComponent(MODEL_REVISION)}`;
}

function cloneScene(scene: THREE.Object3D): THREE.Object3D {
  return cloneSkeleton(scene);
}

function scaleObjectToLength(object: THREE.Object3D, targetInches: number): number {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  const longest = Math.max(size.x, size.z, 0.001);
  return targetInches / longest;
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function orderedBoundaryFromGeometry(mesh: THREE.Mesh): BoardPoint[] {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  const index = geometry.index;
  if (!position) return [];

  const vertices: THREE.Vector3[] = [];
  for (let i = 0; i < position.count; i++) {
    vertices.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
  }

  const edgeCounts = new Map<string, { count: number; a: number; b: number }>();
  const triangles = index ? index.count / 3 : Math.floor(position.count / 3);
  for (let tri = 0; tri < triangles; tri++) {
    const ia = index ? index.getX(tri * 3) : tri * 3;
    const ib = index ? index.getX(tri * 3 + 1) : tri * 3 + 1;
    const ic = index ? index.getX(tri * 3 + 2) : tri * 3 + 2;
    for (const [a, b] of [[ia, ib], [ib, ic], [ic, ia]] as const) {
      const key = edgeKey(a, b);
      const existing = edgeCounts.get(key);
      edgeCounts.set(key, existing ? { ...existing, count: existing.count + 1 } : { count: 1, a, b });
    }
  }

  const boundaryEdges = [...edgeCounts.values()].filter((edge) => edge.count === 1);
  const adjacency = new Map<number, number[]>();
  for (const edge of boundaryEdges) {
    adjacency.set(edge.a, [...(adjacency.get(edge.a) ?? []), edge.b]);
    adjacency.set(edge.b, [...(adjacency.get(edge.b) ?? []), edge.a]);
  }

  const start = boundaryEdges[0]?.a;
  if (start == null) return angleSortedFallback(vertices);

  const ordered: number[] = [];
  let current = start;
  let previous: number | null = null;
  for (let guard = 0; guard < boundaryEdges.length + 4; guard++) {
    ordered.push(current);
    const next = (adjacency.get(current) ?? []).find((candidate) => candidate !== previous);
    if (next == null || next === start) break;
    previous = current;
    current = next;
  }

  const points = ordered.map((i) => ({ x: vertices[i].x, z: vertices[i].z }));
  return points.length >= 3 ? points : angleSortedFallback(vertices);
}

function angleSortedFallback(vertices: THREE.Vector3[]): BoardPoint[] {
  const unique = new Map<string, BoardPoint>();
  for (const vertex of vertices) {
    unique.set(`${vertex.x.toFixed(4)}:${vertex.z.toFixed(4)}`, { x: vertex.x, z: vertex.z });
  }
  const points = [...unique.values()];
  const center = points.reduce(
    (sum, point) => ({ x: sum.x + point.x / points.length, z: sum.z + point.z / points.length }),
    { x: 0, z: 0 },
  );
  return points.sort((a, b) => Math.atan2(a.z - center.z, a.x - center.x) - Math.atan2(b.z - center.z, b.x - center.x));
}

function transformedFootprint(local: BoardPoint[], placement: Placement): BoardPoint[] {
  const heading = (placement.heading * Math.PI) / 180;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  return local.map((point) => {
    const x = point.x * ASTEROID_SCALE;
    const z = point.z * ASTEROID_SCALE;
    return {
      x: placement.x + x * cos - z * sin,
      z: placement.z + x * sin + z * cos,
    };
  });
}

function pointInPolygon(point: BoardPoint, polygon: BoardPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects =
      (a.z > point.z) !== (b.z > point.z) &&
      point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z || 1e-6) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function angleDeltaRadians(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

function isTargetInArc(attacker: Placement, target: Placement, arcName: string): boolean {
  const arc = ARC_DEFS[arcName];
  if (!arc) return false;
  const dx = target.x - attacker.x;
  const dz = target.z - attacker.z;
  const headingRad = (attacker.heading * Math.PI) / 180;
  const localX = dx * Math.cos(headingRad) - dz * Math.sin(headingRad);
  const localZ = dx * Math.sin(headingRad) + dz * Math.cos(headingRad);
  if (localX === 0 && localZ === 0) return true;
  const bearing = Math.atan2(localZ, localX);
  return Math.abs(angleDeltaRadians(bearing, arc.centerAngle)) <= arc.halfAngle + 1e-6;
}

function centerDistance(a: Placement, b: Placement): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

function ArcProjection({
  placement,
  weapon,
  selected,
}: {
  placement: Placement;
  weapon: TestWeapon;
  selected: boolean;
}) {
  const arc = ARC_DEFS[weapon.arc];
  const geometry = useMemo(() => {
    if (!arc) return null;
    const segments = arc.halfAngle < 0.3 ? 12 : 56;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    for (let i = 0; i <= segments; i++) {
      const angle = arc.centerAngle - arc.halfAngle + (2 * arc.halfAngle * i) / segments;
      shape.lineTo(Math.cos(angle) * weapon.range, Math.sin(angle) * weapon.range);
    }
    shape.lineTo(0, 0);
    return new THREE.ShapeGeometry(shape);
  }, [arc, weapon.range]);

  if (!arc || !geometry) return null;
  return (
    <group position={[placement.x, selected ? 0.055 : 0.035, placement.z]} rotation={[0, (placement.heading * Math.PI) / 180, 0]}>
      <mesh rotation={[Math.PI / 2, 0, 0]} geometry={geometry} renderOrder={selected ? 5 : 4}>
        <meshBasicMaterial
          color={arc.color}
          transparent
          opacity={selected ? 0.18 : 0.055}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

function AsteroidAndBase({
  placement,
  selected,
  onSelect,
}: {
  placement: Placement;
  selected: boolean;
  onSelect: () => void;
}) {
  const { scene } = useGLTF(modelUrl(ASTEROID_MODEL));
  const cloned = useMemo(() => cloneScene(scene), [scene]);

  useEffect(() => {
    cloned.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = false;
      child.receiveShadow = false;
      if (child.name.toLowerCase().includes("circle")) {
        child.visible = false;
      }
    });
  }, [cloned]);

  return (
    <group
      position={[placement.x, 0, placement.z]}
      rotation={[0, (placement.heading * Math.PI) / 180, 0]}
      scale={[ASTEROID_SCALE, ASTEROID_SCALE, ASTEROID_SCALE]}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      <primitive object={cloned} />
    </group>
  );
}

function HyperionMarker({
  id,
  label,
  placement,
  selected,
  color,
  onSelect,
}: {
  id: SceneObjectId;
  label: string;
  placement: Placement;
  selected: boolean;
  color: string;
  onSelect: (id: SceneObjectId) => void;
}) {
  const { scene } = useGLTF(modelUrl(HYPERION_MODEL));
  const cloned = useMemo(() => cloneScene(scene), [scene]);
  const scale = useMemo(() => scaleObjectToLength(cloned, HYPERION_LENGTH_INCHES), [cloned]);

  useEffect(() => {
    cloned.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const material = child.material;
      if (Array.isArray(material)) {
        material.forEach((item) => {
          item.transparent = true;
          item.opacity = selected ? 0.98 : 0.86;
        });
      } else if (material) {
        material.transparent = true;
        material.opacity = selected ? 0.98 : 0.86;
      }
    });
  }, [cloned, selected]);

  return (
    <group
      position={[placement.x, 0.18, placement.z]}
      rotation={[0, (placement.heading * Math.PI) / 180, 0]}
      scale={[scale, scale, scale]}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        onSelect(id);
      }}
    >
      <primitive object={cloned} />
      <mesh position={[0, -0.16, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.05 / scale, 48]} />
        <meshBasicMaterial color={color} transparent opacity={selected ? 0.42 : 0.22} depthWrite={false} />
      </mesh>
      <Text position={[0, 1.3 / scale, 0]} fontSize={0.34 / scale} color="#f8fafc" anchorX="center" anchorY="middle">
        {label}
      </Text>
    </group>
  );
}

function BoardGrid() {
  return (
    <group>
      <gridHelper args={[40, 40, "#1f6b43", "#15331f"]} position={[0, -0.01, 0]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.03, 0]}>
        <planeGeometry args={[42, 42]} />
        <meshBasicMaterial color="#030605" />
      </mesh>
    </group>
  );
}

function LosScene({
  committed,
  staged,
  selected,
  selectedWeapon,
  footprint,
  blocked,
  targetInArc,
  targetInRange,
  dirty,
  setSelected,
  setStagedPlacement,
}: {
  committed: Placements;
  staged: Placements;
  selected: SceneObjectId;
  selectedWeapon: TestWeapon;
  footprint: BoardPoint[];
  blocked: boolean;
  targetInArc: boolean;
  targetInRange: boolean;
  dirty: boolean;
  setSelected: (id: SceneObjectId) => void;
  setStagedPlacement: (id: SceneObjectId, placement: Placement) => void;
}) {
  const activePlacements = staged;
  const legal = targetInRange && targetInArc && !blocked;
  const lineColor = legal ? "#22c55e" : blocked ? "#ef4444" : "#f59e0b";
  const tester = committed.tester;
  const target = committed.target;
  const footprintLine = [...footprint, footprint[0]].filter(Boolean).map((point) => [point.x, 0.08, point.z] as [number, number, number]);

  return (
    <>
      <ambientLight intensity={0.75} />
      <directionalLight position={[8, 12, 6]} intensity={1.8} />
      <BoardGrid />
      <Line
        points={[
          [tester.x, 0.28, tester.z],
          [target.x, 0.28, target.z],
        ]}
        color={lineColor}
        lineWidth={2}
        transparent
        opacity={dirty ? 0.25 : 0.95}
      />
      {HYPERION_WEAPONS.map((weapon) => (
        <ArcProjection
          key={weapon.id}
          placement={activePlacements.tester}
          weapon={weapon}
          selected={weapon.id === selectedWeapon.id}
        />
      ))}
      <Suspense fallback={null}>
        <AsteroidAndBase
          placement={activePlacements.asteroid}
          selected={selected === "asteroid"}
          onSelect={() => setSelected("asteroid")}
        />
        {footprintLine.length > 2 ? (
          <Line
            points={footprintLine}
            color={blocked ? "#ef4444" : selected === "asteroid" ? "#facc15" : "#38bdf8"}
            lineWidth={2}
            transparent
            opacity={0.95}
          />
        ) : null}
        <HyperionMarker
          id="tester"
          label="Tester"
          placement={activePlacements.tester}
          selected={selected === "tester"}
          color="#38bdf8"
          onSelect={setSelected}
        />
        <HyperionMarker
          id="target"
          label="Target"
          placement={activePlacements.target}
          selected={selected === "target"}
          color="#f97316"
          onSelect={setSelected}
        />
      </Suspense>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0, 0]}
        onPointerDown={(event) => {
          setStagedPlacement(selected, {
            ...staged[selected],
            x: event.point.x,
            z: event.point.z,
          });
        }}
        onPointerMove={(event) => {
          if (event.buttons !== 1) return;
          setStagedPlacement(selected, {
            ...staged[selected],
            x: event.point.x,
            z: event.point.z,
          });
        }}
      >
        <planeGeometry args={[42, 42]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <OrbitControls makeDefault enablePan enableRotate enableZoom />
    </>
  );
}

export default function LosTest() {
  const [selected, setSelected] = useState<SceneObjectId>("tester");
  const [selectedWeaponId, setSelectedWeaponId] = useState(HYPERION_WEAPONS[0].id);
  const [committed, setCommitted] = useState<Placements>(INITIAL_PLACEMENTS);
  const [staged, setStaged] = useState<Placements>(INITIAL_PLACEMENTS);
  const [asteroidBoundary, setAsteroidBoundary] = useState<BoardPoint[]>([]);
  const selectedWeapon = HYPERION_WEAPONS.find((weapon) => weapon.id === selectedWeaponId) ?? HYPERION_WEAPONS[0];

  const committedFootprint = useMemo(
    () => transformedFootprint(asteroidBoundary, committed.asteroid),
    [asteroidBoundary, committed.asteroid],
  );
  const stagedFootprint = useMemo(
    () => transformedFootprint(asteroidBoundary, staged.asteroid),
    [asteroidBoundary, staged.asteroid],
  );
  const losBlock = useMemo(
    () =>
      findBlockingLineOfSightObstacle(
        { x: committed.tester.x, z: committed.tester.z },
        { x: committed.target.x, z: committed.target.z },
        [
          {
            id: "asteroid-test",
            name: "Asteroid Base",
            kind: "asteroid-field",
            effect: "blocked",
            polygon: committedFootprint,
          },
        ],
      ),
    [committed, committedFootprint],
  );
  const dirty = JSON.stringify(staged) !== JSON.stringify(committed);
  const blocked = Boolean(losBlock);
  const targetDistance = centerDistance(committed.tester, committed.target);
  const targetInRange = targetDistance <= selectedWeapon.range + 1e-6;
  const targetInArc = isTargetInArc(committed.tester, committed.target, selectedWeapon.arc);
  const targetLegal = targetInRange && targetInArc && !blocked;
  const testerInsideAsteroid = committedFootprint.length >= 3 && pointInPolygon(committed.tester, committedFootprint);
  const targetInsideAsteroid = committedFootprint.length >= 3 && pointInPolygon(committed.target, committedFootprint);
  const asteroidLosCase = testerInsideAsteroid
    ? targetInsideAsteroid
      ? "Both inside field: fire allowed"
      : "Firing out of field: allowed"
    : targetInsideAsteroid
      ? "Firing into field: allowed"
      : blocked
        ? "Opposite sides: LOS blocked"
        : "Outside field: LOS clear";

  const setStagedPlacement = (id: SceneObjectId, placement: Placement) => {
    setStaged((current) => ({ ...current, [id]: placement }));
  };
  const rotateSelected = (delta: number) => {
    setStaged((current) => ({
      ...current,
      [selected]: {
        ...current[selected],
        heading: current[selected].heading + delta,
      },
    }));
  };
  const confirm = () => {
    setCommitted(staged);
  };
  const cancel = () => {
    setStaged(committed);
  };
  const reset = () => {
    setCommitted(INITIAL_PLACEMENTS);
    setStaged(INITIAL_PLACEMENTS);
    setSelected("tester");
  };

  return (
    <Layout title="LOS Test">
      <div className="flex h-full min-h-[calc(100vh-2rem)] flex-col bg-black text-foreground">
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-background/90 px-4 py-3">
          <div className="mr-auto">
            <h1 className="font-mono text-lg font-bold uppercase tracking-[0.18em]">Terrain LOS Test</h1>
            <p className="text-xs text-muted-foreground">
              Asteroid fields may be overlapped. Confirm placement, then compare range, arc, LOS, and inside-field effects.
              Movement density checks are separate and are not resolved in this LOS sandbox.
            </p>
          </div>
          <Badge variant={targetLegal ? "default" : "destructive"}>
            {targetLegal ? "Legal Shot" : "Illegal Shot"}
          </Badge>
          <Badge variant={targetInRange ? "default" : "outline"}>
            Range {targetDistance.toFixed(1)} / {selectedWeapon.range}"
          </Badge>
          <Badge variant={targetInArc ? "default" : "outline"}>
            {targetInArc ? `In ${selectedWeapon.arc}` : `Not in ${selectedWeapon.arc}`}
          </Badge>
          <Badge variant={blocked ? "destructive" : "default"}>
            {blocked ? "LOS Blocked" : "LOS Clear"}
          </Badge>
          <Badge variant={testerInsideAsteroid ? "default" : "outline"}>
            Tester {testerInsideAsteroid ? "inside" : "outside"} field
          </Badge>
          <Badge variant={targetInsideAsteroid ? "default" : "outline"}>
            Target {targetInsideAsteroid ? "inside" : "outside"} field
          </Badge>
          <Badge variant={targetInsideAsteroid ? "default" : "outline"}>
            {targetInsideAsteroid ? "Target gains Stealth 3+" : "No asteroid Stealth"}
          </Badge>
          <Badge variant={blocked ? "destructive" : "outline"}>{asteroidLosCase}</Badge>
          {dirty ? <Badge variant="outline">Unconfirmed placement</Badge> : null}
          <select
            className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground"
            value={selectedWeaponId}
            onChange={(event) => setSelectedWeaponId(event.target.value)}
          >
            {HYPERION_WEAPONS.map((weapon) => (
              <option key={weapon.id} value={weapon.id}>
                {weapon.name} - {weapon.arc} - {weapon.range}" - {weapon.attackDice}AD
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            {(["tester", "target", "asteroid"] as SceneObjectId[]).map((id) => (
              <Button key={id} variant={selected === id ? "default" : "outline"} size="sm" onClick={() => setSelected(id)}>
                {id}
              </Button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => rotateSelected(-15)}>
            -15 deg
          </Button>
          <Button variant="outline" size="sm" onClick={() => rotateSelected(15)}>
            +15 deg
          </Button>
          <Button variant="default" size="sm" onClick={confirm} disabled={!dirty}>
            <Check className="mr-2 h-4 w-4" />
            Confirm
          </Button>
          <Button variant="outline" size="sm" onClick={cancel} disabled={!dirty}>
            <X className="mr-2 h-4 w-4" />
            Cancel
          </Button>
          <Button variant="outline" size="sm" onClick={reset}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <Canvas camera={{ position: [0, 24, 24], fov: 45 }}>
            <Suspense fallback={null}>
              <BoundaryProbe onBoundary={setAsteroidBoundary} />
              <LosScene
                committed={committed}
                staged={staged}
                selected={selected}
                selectedWeapon={selectedWeapon}
                footprint={stagedFootprint}
                blocked={blocked}
                targetInArc={targetInArc}
                targetInRange={targetInRange}
                dirty={dirty}
                setSelected={setSelected}
                setStagedPlacement={setStagedPlacement}
              />
            </Suspense>
          </Canvas>
        </div>
      </div>
    </Layout>
  );
}

function BoundaryProbe({ onBoundary }: { onBoundary: (points: BoardPoint[]) => void }) {
  const { scene } = useGLTF(modelUrl(ASTEROID_MODEL));
  useEffect(() => {
    const cloned = cloneScene(scene);
    cloned.updateMatrixWorld(true);
    cloned.traverse((child) => {
      if (child instanceof THREE.Mesh && child.name.toLowerCase().includes("circle")) {
        onBoundary(orderedBoundaryFromGeometry(child));
      }
    });
  }, [onBoundary, scene]);
  return null;
}

useGLTF.preload(modelUrl(ASTEROID_MODEL));
useGLTF.preload(modelUrl(HYPERION_MODEL));
