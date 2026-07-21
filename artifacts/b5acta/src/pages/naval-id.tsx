import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";
import { getListShipModelsQueryKey, useListShipModels, type ShipModel } from "@workspace/api-client-react";
import * as THREE from "three";
// @ts-ignore
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { Search, Ship, Loader2, AlertTriangle } from "lucide-react";

import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { APP_BUILD_SHA } from "@/lib/build-version";
import { normalizePriorityLevel, priorityLabel } from "@/lib/fleet-allocation";

const LARGE_MODEL_BYTES = 20 * 1024 * 1024;
const OMEGA_ROTATING_MODEL_FILENAME = "omega2.glb";
const EXPLORER_ROTATING_MODEL_FILENAME = "explorer.glb";
const PSI_CORPS_MOTHERSHIP_MODEL_FILENAME = "psicorpmother.glb";
const ORION_SPACE_STATION_MODEL_FILENAME = "orion-space-station.glb";
const DEFAULT_VISUAL_MODEL_FILENAMES: Record<string, string> = {
  "omega.glb": OMEGA_ROTATING_MODEL_FILENAME,
};
const ROTATING_MODEL_PARTS: Record<
  string,
  { nodeName: string; axis: "x" | "y" | "z"; secondsPerRotation: number }
> = {
  [OMEGA_ROTATING_MODEL_FILENAME]: {
    nodeName: "omg_rotator",
    axis: "z",
    secondsPerRotation: 30,
  },
  [EXPLORER_ROTATING_MODEL_FILENAME]: {
    nodeName: "explorerRotate",
    // Blender Y is exported as this bone's local Z in glTF/Three.js.
    axis: "z",
    secondsPerRotation: 30,
  },
  [PSI_CORPS_MOTHERSHIP_MODEL_FILENAME]: {
    nodeName: "rotate_psihull",
    // This armature uses the same Blender Y -> glTF local Z export as Explorer.
    axis: "z",
    secondsPerRotation: 30,
  },
  [ORION_SPACE_STATION_MODEL_FILENAME]: {
    nodeName: "orion_rotate",
    // Blender Y is exported as this bone's local Z in glTF/Three.js.
    axis: "z",
    secondsPerRotation: 30,
  },
};
const VISUAL_ROTATE_180_MODELS = new Set([
  EXPLORER_ROTATING_MODEL_FILENAME,
  PSI_CORPS_MOTHERSHIP_MODEL_FILENAME,
  "black-omega.glb",
  "command-hyperion.glb",
  "aurora.glb",
  "thunderbolt.glb",
  "tiger.glb",
  "nial.glb",
  "flyer.glb",
  "battlecrab.glb",
  "dead-battlecrab.glb",
  "primus.glb",
  "whitestar.glb",
  "avenger.glb",
  "tloth.glb",
  "frazi.glb",
]);
const MODEL_ASSET_REVISIONS: Record<string, string> = {
  "avioki.glb": "20260719-154941",
  "black-omega.glb": "20260721-183649",
  "command-hyperion.glb": "20260719-211631",
  "dead-hyperion.glb": "20260718-163044",
  "dead-nova.glb": "20260718-233153",
  "dead-omega.glb": "20260718-231918",
  [EXPLORER_ROTATING_MODEL_FILENAME]: "20260720-160843",
  "missile-hyperion.glb": "20260719-005010",
  "missile1.glb": "20260719-013547",
  [OMEGA_ROTATING_MODEL_FILENAME]: "20260720-174853",
  [ORION_SPACE_STATION_MODEL_FILENAME]: "20260721-190419",
  [PSI_CORPS_MOTHERSHIP_MODEL_FILENAME]: "20260721-183649",
};

type ModelProbe = {
  exists: boolean;
  bytes: number | null;
};

const probeCache = new Map<string, ModelProbe>();

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [delayMs, value]);
  return debounced;
}

function visualFilename(filename: string): string {
  return DEFAULT_VISUAL_MODEL_FILENAMES[filename.toLowerCase()] ?? filename;
}

function assetUrlFor(filename: string): string {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const revision = MODEL_ASSET_REVISIONS[filename.toLowerCase()] ?? APP_BUILD_SHA;
  return `${basePath}/api/models/${filename}?v=${encodeURIComponent(revision)}`;
}

function isGlb(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith(".glb") || lower.endsWith(".gltf");
}

function useModelProbe(url: string | null): ModelProbe | null {
  const [probe, setProbe] = useState<ModelProbe | null>(() =>
    url && probeCache.has(url) ? probeCache.get(url)! : null,
  );

  useEffect(() => {
    if (!url) {
      setProbe(null);
      return;
    }
    const cached = probeCache.get(url);
    if (cached) {
      setProbe(cached);
      return;
    }
    let cancelled = false;
    setProbe(null);
    fetch(url, { method: "HEAD" })
      .then((res) => {
        const next = {
          exists: res.ok,
          bytes: Number(res.headers.get("content-length")) || null,
        };
        probeCache.set(url, next);
        if (!cancelled) setProbe(next);
      })
      .catch(() => {
        const next = { exists: false, bytes: null };
        probeCache.set(url, next);
        if (!cancelled) setProbe(next);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return probe;
}

function readEulerAxis(rotation: THREE.Euler, axis: "x" | "y" | "z"): number {
  if (axis === "x") return rotation.x;
  if (axis === "y") return rotation.y;
  return rotation.z;
}

function writeEulerAxis(rotation: THREE.Euler, axis: "x" | "y" | "z", value: number) {
  if (axis === "x") rotation.x = value;
  else if (axis === "y") rotation.y = value;
  else rotation.z = value;
}

function ModelFallback() {
  return (
    <mesh>
      <boxGeometry args={[1.2, 0.35, 2.4]} />
      <meshStandardMaterial color="#64748b" roughness={0.7} metalness={0.15} />
    </mesh>
  );
}

function NavalModel({ url, filename }: { url: string; filename: string }) {
  const { scene } = useGLTF(url);
  const filenameKey = filename.toLowerCase();
  const rotatingPartConfig = ROTATING_MODEL_PARTS[filenameKey];
  const rotatingPartRef = useRef<THREE.Object3D | null>(null);
  const rotatingPartInitialRotationRef = useRef(0);

  const { cloned, scale, center } = useMemo(() => {
    rotatingPartRef.current = null;
    rotatingPartInitialRotationRef.current = 0;
    const c = rotatingPartConfig ? cloneSkeleton(scene) : scene.clone(true);
    c.traverse((child: any) => {
      const childName = String(child.name ?? "").toLowerCase();
      if (rotatingPartConfig && childName === rotatingPartConfig.nodeName.toLowerCase()) {
        rotatingPartRef.current = child;
        rotatingPartInitialRotationRef.current = readEulerAxis(child.rotation, rotatingPartConfig.axis);
      }
      if (!child.isMesh) return;
      child.castShadow = true;
      child.receiveShadow = true;
      const materials = (Array.isArray(child.material) ? child.material : [child.material]).map(
        (material: THREE.Material | undefined) => {
          const clonedMaterial = material?.clone
            ? material.clone()
            : new THREE.MeshStandardMaterial({ color: "#d1d5db" });
          if ("emissive" in clonedMaterial) {
            (clonedMaterial as THREE.MeshStandardMaterial).emissive = new THREE.Color("#273548");
            (clonedMaterial as THREE.MeshStandardMaterial).emissiveIntensity = 0.05;
          }
          return clonedMaterial;
        },
      );
      child.material = Array.isArray(child.material) ? materials : materials[0];
    });
    c.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(c);
    const size = new THREE.Vector3();
    const modelCenter = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(modelCenter);
    const longest = Math.max(size.x, size.y, size.z);
    return {
      cloned: c,
      scale: longest > 0 ? 5.4 / longest : 1,
      center: modelCenter,
    };
  }, [rotatingPartConfig, scene]);

  useFrame(({ clock }) => {
    if (!rotatingPartConfig || !rotatingPartRef.current) return;
    const cycleSeconds = Math.max(0.1, rotatingPartConfig.secondsPerRotation);
    const progress = (clock.getElapsedTime() % cycleSeconds) / cycleSeconds;
    writeEulerAxis(
      rotatingPartRef.current.rotation,
      rotatingPartConfig.axis,
      rotatingPartInitialRotationRef.current + progress * Math.PI * 2,
    );
    rotatingPartRef.current.updateMatrixWorld();
  });

  const visualFlip = VISUAL_ROTATE_180_MODELS.has(filenameKey);
  return (
    <group scale={[scale, scale, scale]} rotation={[0, visualFlip ? Math.PI : 0, 0]}>
      <primitive object={cloned} position={[-center.x, -center.y, -center.z]} />
    </group>
  );
}

function NavalViewer({
  filename,
  url,
  ready,
}: {
  filename: string | null;
  url: string | null;
  ready: boolean;
}) {
  return (
    <Canvas camera={{ position: [0, 3.4, 8.5], fov: 42 }} shadows dpr={[1, 1.5]}>
      <color attach="background" args={["#000000"]} />
      <ambientLight intensity={0.62} />
      <directionalLight position={[7, 8, 7]} intensity={1.55} castShadow />
      <directionalLight position={[-7, 3, -5]} intensity={0.42} />
      {ready && filename && url && isGlb(filename) ? (
        <Suspense fallback={<ModelFallback />}>
          <NavalModel key={url} url={url} filename={filename} />
        </Suspense>
      ) : (
        <ModelFallback />
      )}
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={2.5}
        maxDistance={16}
        target={[0, 0, 0]}
      />
    </Canvas>
  );
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "unknown";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 10 ? 1 : 2)} MB`;
}

function splitTraits(traits?: string | null): string[] {
  return (traits ?? "")
    .split(/[;,]/g)
    .map((trait) => trait.trim())
    .filter(Boolean);
}

function StatCell({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="border border-border bg-background/50 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold text-foreground">{value ?? "N/A"}</div>
    </div>
  );
}

function ShipStats({ ship, probe }: { ship: ShipModel; probe: ModelProbe | null }) {
  const traits = splitTraits(ship.traits);
  const weapons = ship.weapons ?? [];
  return (
    <section className="border-t border-border bg-card/70">
      <div className="grid gap-4 p-4 xl:grid-cols-[1fr_1.15fr]">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold tracking-widest text-primary uppercase">{ship.name}</h2>
            <Badge variant="outline">{ship.faction}</Badge>
            <Badge variant="secondary">{priorityLabel(normalizePriorityLevel(ship.priorityLevel))}</Badge>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{ship.description ?? "No registry note."}</p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            <StatCell label="Speed" value={`${ship.speed}\"`} />
            <StatCell label="Damage" value={ship.hullPoints} />
            <StatCell label="Hull" value={`${ship.hullRating}+`} />
            <StatCell label="Base" value={`${ship.baseRadiusInches}\"`} />
            <StatCell label="Points" value={ship.pointCost} />
            <StatCell label="Craft" value={ship.smallCraft ?? "None"} />
            <StatCell label="Mesh" value={visualFilename(ship.filename)} />
            <StatCell label="Asset" value={formatBytes(probe?.bytes ?? null)} />
          </div>
          {traits.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {traits.map((trait) => (
                <Badge key={trait} variant="outline" className="font-mono text-[10px] uppercase tracking-wider">
                  {trait}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
        <div className="min-w-0">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Weapons</div>
          <div className="max-h-52 overflow-y-auto border border-border">
            {weapons.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground">No weapons listed.</div>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-card text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="px-3 py-2 font-mono uppercase tracking-widest">Weapon</th>
                    <th className="px-3 py-2 font-mono uppercase tracking-widest">Arc</th>
                    <th className="px-3 py-2 font-mono uppercase tracking-widest">Range</th>
                    <th className="px-3 py-2 font-mono uppercase tracking-widest">AD</th>
                    <th className="px-3 py-2 font-mono uppercase tracking-widest">Traits</th>
                  </tr>
                </thead>
                <tbody>
                  {weapons.map((weapon) => (
                    <tr key={weapon.id} className="border-b border-border/70 last:border-b-0">
                      <td className="px-3 py-2 font-medium text-foreground">{weapon.name}</td>
                      <td className="px-3 py-2 text-muted-foreground">{weapon.arc}</td>
                      <td className="px-3 py-2 text-muted-foreground">{weapon.range}\"</td>
                      <td className="px-3 py-2 text-muted-foreground">{weapon.attackDice}</td>
                      <td className="px-3 py-2 text-muted-foreground">{weapon.traits ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export default function NavalId() {
  const { data: ships, isLoading } = useListShipModels({
    query: {
      queryKey: getListShipModelsQueryKey(),
      staleTime: 10 * 60_000,
      gcTime: 30 * 60_000,
      refetchOnWindowFocus: false,
    },
  });
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [largeLoadApprovedUrl, setLargeLoadApprovedUrl] = useState<string | null>(null);

  const sortedShips = useMemo(
    () => [...(ships ?? [])].sort((a, b) => a.faction.localeCompare(b.faction) || a.name.localeCompare(b.name)),
    [ships],
  );
  const filteredShips = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return sortedShips;
    return sortedShips.filter((ship) =>
      [ship.name, ship.faction, ship.priorityLevel, ship.traits ?? ""].some((value) =>
        value.toLowerCase().includes(needle),
      ),
    );
  }, [search, sortedShips]);

  useEffect(() => {
    if (selectedId || sortedShips.length === 0) return;
    setSelectedId(sortedShips[0]?.id ?? null);
  }, [selectedId, sortedShips]);

  const selectedShip = sortedShips.find((ship) => ship.id === selectedId) ?? filteredShips[0] ?? sortedShips[0] ?? null;
  const debouncedShip = useDebouncedValue(selectedShip, 350);
  const viewedFilename = debouncedShip ? visualFilename(debouncedShip.filename) : null;
  const viewedUrl = viewedFilename ? assetUrlFor(viewedFilename) : null;
  const probe = useModelProbe(viewedUrl);
  const isLargeModel = Boolean(probe?.bytes && probe.bytes > LARGE_MODEL_BYTES);
  const canLoadModel = Boolean(
    viewedUrl &&
    probe?.exists &&
    isGlb(viewedFilename ?? "") &&
    (!isLargeModel || largeLoadApprovedUrl === viewedUrl),
  );

  useEffect(() => {
    setLargeLoadApprovedUrl(null);
  }, [viewedUrl]);

  return (
    <Layout title="Naval ID">
      <div className="grid min-h-[calc(100dvh-4rem)] grid-cols-1 lg:grid-cols-[1fr_23rem]">
        <div className="flex min-h-0 flex-col bg-black">
          <div className="relative min-h-[28rem] flex-1">
            <NavalViewer filename={viewedFilename} url={viewedUrl} ready={canLoadModel} />
            <div className="pointer-events-none absolute left-4 top-4 flex flex-wrap gap-2">
              {debouncedShip ? (
                <>
                  <Badge className="bg-black/70 text-primary hover:bg-black/70">{debouncedShip.faction}</Badge>
                  <Badge variant="outline" className="border-border bg-black/70 text-foreground">
                    {debouncedShip.name}
                  </Badge>
                </>
              ) : null}
            </div>
            <div className="absolute bottom-4 left-4 right-4">
              {!probe && viewedUrl ? (
                <div className="inline-flex items-center gap-2 border border-border bg-black/75 px-3 py-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Checking asset
                </div>
              ) : null}
              {probe && !probe.exists ? (
                <div className="inline-flex items-center gap-2 border border-destructive/50 bg-black/75 px-3 py-2 text-xs text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Mesh file not found
                </div>
              ) : null}
              {viewedFilename && !isGlb(viewedFilename) ? (
                <div className="inline-flex items-center gap-2 border border-amber-400/50 bg-black/75 px-3 py-2 text-xs text-amber-200">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  GLB viewer unavailable for this file type
                </div>
              ) : null}
              {isLargeModel && viewedUrl && largeLoadApprovedUrl !== viewedUrl ? (
                <div className="flex max-w-md items-center justify-between gap-3 border border-amber-400/50 bg-black/80 px-3 py-2">
                  <div className="text-xs text-amber-100">Large mesh: {formatBytes(probe?.bytes ?? null)}</div>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 text-[10px] uppercase tracking-widest"
                    onClick={() => setLargeLoadApprovedUrl(viewedUrl)}
                  >
                    Load Mesh
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
          {debouncedShip ? <ShipStats ship={debouncedShip} probe={probe} /> : null}
        </div>

        <aside className="min-h-0 border-l border-border bg-card/80">
          <div className="border-b border-border p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Ship className="h-4 w-4 text-primary" />
                <span className="font-mono text-xs font-bold uppercase tracking-widest">Live Roster</span>
              </div>
              <Badge variant="outline">{filteredShips.length}</Badge>
            </div>
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search ships..."
                className="pl-9"
              />
            </label>
          </div>
          <div className="h-[calc(100dvh-11rem)] overflow-y-auto p-2">
            {isLoading ? (
              <div className="space-y-2 p-2">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            ) : (
              <div className="space-y-1">
                {filteredShips.map((ship) => {
                  const active = ship.id === selectedShip?.id;
                  return (
                    <button
                      key={ship.id}
                      type="button"
                      className={`w-full border px-3 py-2 text-left transition-colors ${
                        active
                          ? "border-primary bg-primary/10"
                          : "border-border bg-background/50 hover:border-primary/50 hover:bg-secondary/50"
                      }`}
                      onClick={() => setSelectedId(ship.id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-semibold text-foreground">{ship.name}</span>
                        <span className="shrink-0 font-mono text-[10px] uppercase tracking-widest text-primary">
                          {priorityLabel(normalizePriorityLevel(ship.priorityLevel))}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{ship.faction}</span>
                        <span className="shrink-0 font-mono">Hull {ship.hullRating}+ · Dmg {ship.hullPoints}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>
      </div>
    </Layout>
  );
}
