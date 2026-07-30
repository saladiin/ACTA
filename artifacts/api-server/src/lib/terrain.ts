import type { DeploymentConfig, DeploymentRect } from "./deployment-zones";
import type { BoardPoint, LineOfSightObstacle } from "./line-of-sight";

export type TerrainKind = "asteroid-field" | "gas-cloud";
export type ManualTerrainVariant = "asteroid-light" | "asteroid-medium";
export type TerrainVisualVariant = "ionized-cloud" | "dust-cloud";

export type TerrainObject = {
  id: string;
  kind: TerrainKind;
  name: string;
  x: number;
  z: number;
  radiusInches: number;
  density: number;
  modelFilename: string;
  rotationDeg?: number;
  footprintScaleX?: number;
  footprintScaleZ?: number;
  shapeSeed?: number;
  visualVariant?: TerrainVisualVariant;
};

export type TerrainConfig = {
  version: 1;
  objects: TerrainObject[];
  manualPlacement?: TerrainManualPlacementState;
};

export type TerrainSelection = "none" | "asteroid-fields" | "gas-clouds" | "mixed-terrain";
export type TerrainCount = 0 | 3 | 6 | 9;
export type ManualTerrainCount = 0 | 4 | 6 | 8;
export type TerrainPlacementMode = "automatic" | "manual";

export type TerrainManualPlacementState = {
  enabled: boolean;
  terrainSelection: Exclude<TerrainSelection, "none">;
  totalCount: ManualTerrainCount;
  playerOrder: string[];
  nextPlayerId: string | null;
};

const BOARD_MIN_X = -24;
const BOARD_MAX_X = 24;
const BOARD_MIN_Z = -36;
const BOARD_MAX_Z = 36;
const TERRAIN_PLACEMENT_CLEARANCE_EPSILON = 0.01;
const BOARD_RECT: DeploymentRect = {
  type: "rect",
  xMin: BOARD_MIN_X,
  xMax: BOARD_MAX_X,
  zMin: BOARD_MIN_Z,
  zMax: BOARD_MAX_Z,
};

export const ASTEROID_FIELD_RADIUS_INCHES = 2;
export const ASTEROID_FIELD_MODEL = "asteroid-light.glb";
export const ASTEROID_FIELD_MODEL_MEDIUM = "asteroids_medium.glb";
export const ASTEROID_FIELD_MEDIUM_RADIUS_INCHES = ASTEROID_FIELD_RADIUS_INCHES * 3;
const ASTEROID_FIELD_VARIANTS = [
  { modelFilename: ASTEROID_FIELD_MODEL, radiusInches: ASTEROID_FIELD_RADIUS_INCHES },
  { modelFilename: ASTEROID_FIELD_MODEL_MEDIUM, radiusInches: ASTEROID_FIELD_MEDIUM_RADIUS_INCHES },
] as const;
export const ASTEROID_LIGHT_FOOTPRINT_POINTS: BoardPoint[] = [
  { x: -1.04, z: -0.32 },
  { x: -0.72, z: -0.82 },
  { x: -0.08, z: -1.02 },
  { x: 0.58, z: -0.76 },
  { x: 1.08, z: -0.12 },
  { x: 0.78, z: 0.58 },
  { x: 0.18, z: 0.98 },
  { x: -0.62, z: 0.74 },
  { x: -1.08, z: 0.2 },
];
export const ASTEROID_MEDIUM_FOOTPRINT_POINTS: BoardPoint[] = [
  { x: -1.1, z: -0.34 },
  { x: -0.86, z: -0.82 },
  { x: -0.24, z: -1.02 },
  { x: 0.34, z: -0.86 },
  { x: 0.96, z: -0.52 },
  { x: 1.08, z: 0.18 },
  { x: 0.58, z: 0.74 },
  { x: -0.08, z: 1 },
  { x: -0.78, z: 0.7 },
  { x: -1.02, z: 0.18 },
];
export const GAS_CLOUD_MIN_RADIUS_INCHES = 2.5;
export const GAS_CLOUD_MAX_RADIUS_INCHES = 3.5;
export const GAS_CLOUD_RADIUS_INCHES = 3;
export const GAS_CLOUD_FOOTPRINT_POINTS: BoardPoint[] = [
  { x: -3.05, z: -0.62 },
  { x: -2.42, z: -1.2 },
  { x: -1.1, z: -1.05 },
  { x: -0.18, z: -1.36 },
  { x: 1.06, z: -1.06 },
  { x: 2.66, z: -1.16 },
  { x: 3.22, z: -0.44 },
  { x: 2.88, z: 0.52 },
  { x: 1.38, z: 1.08 },
  { x: 0.02, z: 1.28 },
  { x: -1.44, z: 0.92 },
  { x: -2.72, z: 0.42 },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function isBoardRect(rect: DeploymentRect): boolean {
  return rect.xMin <= BOARD_RECT.xMin + 1e-6
    && rect.xMax >= BOARD_RECT.xMax - 1e-6
    && rect.zMin <= BOARD_RECT.zMin + 1e-6
    && rect.zMax >= BOARD_RECT.zMax - 1e-6;
}

function circleFullyInsideRect(x: number, z: number, radius: number, rect: DeploymentRect): boolean {
  return x - radius >= rect.xMin
    && x + radius <= rect.xMax
    && z - radius >= rect.zMin
    && z + radius <= rect.zMax;
}

function circleIntersectsRect(x: number, z: number, radius: number, rect: DeploymentRect): boolean {
  const closestX = clamp(x, rect.xMin, rect.xMax);
  const closestZ = clamp(z, rect.zMin, rect.zMax);
  return Math.hypot(x - closestX, z - closestZ) <= radius;
}

function asteroidDensityFromD6(): number {
  const roll = 1 + Math.floor(Math.random() * 6);
  if (roll <= 2) return 6;
  if (roll === 3) return 7;
  if (roll === 4) return 8;
  if (roll === 5) return 9;
  return 10;
}

function asteroidFieldVariantFromD6(): (typeof ASTEROID_FIELD_VARIANTS)[number] {
  const index = Math.floor(Math.random() * ASTEROID_FIELD_VARIANTS.length);
  return ASTEROID_FIELD_VARIANTS[index] ?? ASTEROID_FIELD_VARIANTS[0];
}

function randomGasCloudVisualVariant(): TerrainVisualVariant {
  return Math.random() < 0.5 ? "ionized-cloud" : "dust-cloud";
}

function normalizeTerrainVisualVariant(value: unknown): TerrainVisualVariant | undefined {
  return value === "dust-cloud" || value === "ionized-cloud" ? value : undefined;
}

function terrainSeededUnit(seed: number, index: number): number {
  const value = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

export function terrainForbiddenRects(deploymentConfig: DeploymentConfig): DeploymentRect[] {
  if (deploymentConfig.preset === "ambush-center") {
    const centerZones = [
      ...deploymentConfig.challenger.zones,
      ...deploymentConfig.opponent.zones,
    ].filter((zone) => !isBoardRect(zone));
    if (centerZones.length > 0) return centerZones;
    return [
      ...(deploymentConfig.challenger.exclusions ?? []),
      ...(deploymentConfig.opponent.exclusions ?? []),
    ];
  }
  return [
    ...deploymentConfig.challenger.zones,
    ...deploymentConfig.opponent.zones,
  ];
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function terrainCountGrid(count: number): { columns: number; rows: number } {
  if (count <= 3) return { columns: 3, rows: 1 };
  if (count <= 6) return { columns: 3, rows: 2 };
  return { columns: 3, rows: 3 };
}

function pointAllowedForTerrain(
  x: number,
  z: number,
  radius: number,
  forbiddenRects: DeploymentRect[],
  existing: TerrainObject[],
): boolean {
  const validatedRadius = radius + TERRAIN_PLACEMENT_CLEARANCE_EPSILON;
  if (!circleFullyInsideRect(x, z, validatedRadius, BOARD_RECT)) return false;
  if (forbiddenRects.some((rect) => circleIntersectsRect(x, z, validatedRadius, rect))) return false;
  return !existing.some(
    (field) =>
      Math.hypot(field.x - x, field.z - z) <
      field.radiusInches + radius + 1 + TERRAIN_PLACEMENT_CLEARANCE_EPSILON,
  );
}

function findBoardWideTerrainPosition(
  radius: number,
  forbiddenRects: DeploymentRect[],
  existing: TerrainObject[],
): { x: number; z: number } | null {
  let best: { x: number; z: number; clearance: number } | null = null;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const x = randomBetween(BOARD_MIN_X + radius, BOARD_MAX_X - radius);
    const z = randomBetween(BOARD_MIN_Z + radius, BOARD_MAX_Z - radius);
    if (!pointAllowedForTerrain(x, z, radius, forbiddenRects, existing)) continue;
    const clearance = existing.length === 0
      ? Number.POSITIVE_INFINITY
      : Math.min(
          ...existing.map(
            (field) => Math.hypot(field.x - x, field.z - z) - field.radiusInches - radius,
          ),
        );
    if (!best || clearance > best.clearance) best = { x, z, clearance };
  }
  return best ? { x: best.x, z: best.z } : null;
}

function automaticTerrainObject(
  kind: TerrainKind,
  ordinal: number,
  x: number,
  z: number,
  radius: number,
  asteroidVariant: (typeof ASTEROID_FIELD_VARIANTS)[number] | null,
): TerrainObject {
  return {
    id: kind === "gas-cloud" ? `gas-cloud-${ordinal}` : `asteroid-field-${ordinal}`,
    kind,
    name: kind === "gas-cloud" ? `Dust Cloud ${ordinal}` : `Asteroid Field ${ordinal}`,
    x: Number(x.toFixed(3)),
    z: Number(z.toFixed(3)),
    radiusInches: radius,
    density: kind === "gas-cloud" ? 0 : asteroidDensityFromD6(),
    modelFilename: kind === "gas-cloud" ? "" : asteroidVariant?.modelFilename ?? ASTEROID_FIELD_MODEL,
    rotationDeg: Math.floor(randomBetween(0, 360)),
    footprintScaleX: Number(randomBetween(kind === "gas-cloud" ? 0.88 : 0.92, kind === "gas-cloud" ? 1.18 : 1.12).toFixed(3)),
    footprintScaleZ: Number(randomBetween(kind === "gas-cloud" ? 0.88 : 0.92, kind === "gas-cloud" ? 1.18 : 1.12).toFixed(3)),
    shapeSeed: Math.floor(randomBetween(1, 1_000_000)),
    visualVariant: kind === "gas-cloud" ? randomGasCloudVisualVariant() : undefined,
  };
}

export function normalizeTerrainSelection(value: unknown): TerrainSelection {
  return value === "asteroid-fields" || value === "gas-clouds" || value === "mixed-terrain" ? value : "none";
}

export function normalizeTerrainPlacementMode(value: unknown): TerrainPlacementMode {
  return value === "manual" ? "manual" : "automatic";
}

export function normalizeAsteroidFieldCount(value: unknown): TerrainCount {
  const count = Math.trunc(Number(value));
  return count === 3 || count === 6 || count === 9 ? count : 0;
}

export function normalizeTerrainCount(value: unknown): TerrainCount {
  return normalizeAsteroidFieldCount(value);
}

export function normalizeManualTerrainCount(value: unknown): ManualTerrainCount {
  const count = Math.trunc(Number(value));
  return count === 4 || count === 6 || count === 8 ? count : 0;
}

export function generateAsteroidTerrainConfig(
  deploymentConfig: DeploymentConfig,
  count: TerrainCount,
): TerrainConfig {
  return generateTerrainConfig(deploymentConfig, "asteroid-field", count);
}

export function generateTerrainConfig(
  deploymentConfig: DeploymentConfig,
  kind: Exclude<TerrainKind, never>,
  count: TerrainCount,
): TerrainConfig {
  if (count === 0) return { version: 1, objects: [] };
  const { columns, rows } = terrainCountGrid(count);
  const forbiddenRects = terrainForbiddenRects(deploymentConfig);
  const cellWidth = (BOARD_MAX_X - BOARD_MIN_X) / columns;
  const cellDepth = (BOARD_MAX_Z - BOARD_MIN_Z) / rows;
  const cells = shuffle(Array.from({ length: columns * rows }, (_, index) => ({
    column: index % columns,
    row: Math.floor(index / columns),
  })));
  const objects: TerrainObject[] = [];
  for (const cell of cells) {
    if (objects.length >= count) break;
    const asteroidVariant = kind === "asteroid-field" ? asteroidFieldVariantFromD6() : null;
    const radius = kind === "gas-cloud"
      ? Number(randomBetween(GAS_CLOUD_MIN_RADIUS_INCHES, GAS_CLOUD_MAX_RADIUS_INCHES).toFixed(3))
      : asteroidVariant?.radiusInches ?? ASTEROID_FIELD_RADIUS_INCHES;
    const xMin = BOARD_MIN_X + cell.column * cellWidth;
    const xMax = xMin + cellWidth;
    const zMin = BOARD_MIN_Z + cell.row * cellDepth;
    const zMax = zMin + cellDepth;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const x = randomBetween(xMin + radius, xMax - radius);
      const z = randomBetween(zMin + radius, zMax - radius);
      if (!pointAllowedForTerrain(x, z, radius, forbiddenRects, objects)) continue;
      const ordinal = objects.length + 1;
      objects.push(automaticTerrainObject(kind, ordinal, x, z, radius, asteroidVariant));
      break;
    }
  }
  for (let fillAttempt = 0; objects.length < count && fillAttempt < count * 3; fillAttempt += 1) {
    let asteroidVariant = kind === "asteroid-field" ? asteroidFieldVariantFromD6() : null;
    let radius = kind === "gas-cloud"
      ? Number(randomBetween(GAS_CLOUD_MIN_RADIUS_INCHES, GAS_CLOUD_MAX_RADIUS_INCHES).toFixed(3))
      : asteroidVariant?.radiusInches ?? ASTEROID_FIELD_RADIUS_INCHES;
    let position = findBoardWideTerrainPosition(radius, forbiddenRects, objects);
    if (!position && kind === "asteroid-field" && radius > ASTEROID_FIELD_RADIUS_INCHES) {
      asteroidVariant = ASTEROID_FIELD_VARIANTS[0];
      radius = ASTEROID_FIELD_RADIUS_INCHES;
      position = findBoardWideTerrainPosition(radius, forbiddenRects, objects);
    }
    if (!position) continue;
    objects.push(
      automaticTerrainObject(
        kind,
        objects.length + 1,
        position.x,
        position.z,
        radius,
        asteroidVariant,
      ),
    );
  }
  return { version: 1, objects };
}

export function generateTerrainSelectionConfig(
  deploymentConfig: DeploymentConfig,
  selection: TerrainSelection,
  count: TerrainCount,
): TerrainConfig {
  if (selection === "mixed-terrain") {
    if (count === 0) return { version: 1, objects: [] };
    const { columns, rows } = terrainCountGrid(count);
    const forbiddenRects = terrainForbiddenRects(deploymentConfig);
    const cellWidth = (BOARD_MAX_X - BOARD_MIN_X) / columns;
    const cellDepth = (BOARD_MAX_Z - BOARD_MIN_Z) / rows;
    const cells = shuffle(Array.from({ length: columns * rows }, (_, index) => ({
      column: index % columns,
      row: Math.floor(index / columns),
    })));
    const objects: TerrainObject[] = [];
    for (const cell of cells) {
      if (objects.length >= count) break;
      const roll = Math.random();
      const kind: TerrainKind = roll < 0.34 ? "gas-cloud" : "asteroid-field";
      const candidate = terrainObjectForPlacement(
        kind,
        objects.length + 1,
        0,
        0,
        { variant: roll > 0.67 ? "asteroid-medium" : "asteroid-light" },
      );
      const radius = candidate.radiusInches;
      const xMin = BOARD_MIN_X + cell.column * cellWidth;
      const xMax = xMin + cellWidth;
      const zMin = BOARD_MIN_Z + cell.row * cellDepth;
      const zMax = zMin + cellDepth;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const x = randomBetween(xMin + radius, xMax - radius);
        const z = randomBetween(zMin + radius, zMax - radius);
        if (!pointAllowedForTerrain(x, z, radius, forbiddenRects, objects)) continue;
        objects.push({
          ...candidate,
          x: Number(x.toFixed(3)),
          z: Number(z.toFixed(3)),
        });
        break;
      }
    }
    return { version: 1, objects };
  }
  if (selection === "gas-clouds") return generateTerrainConfig(deploymentConfig, "gas-cloud", count);
  if (selection === "asteroid-fields") return generateTerrainConfig(deploymentConfig, "asteroid-field", count);
  return { version: 1, objects: [] };
}

export function createManualTerrainConfig(
  selection: Exclude<TerrainSelection, "none">,
  totalCount: ManualTerrainCount,
  playerOrder: string[] = [],
  nextPlayerId: string | null = null,
): TerrainConfig {
  return {
    version: 1,
    objects: [],
    manualPlacement: {
      enabled: true,
      terrainSelection: selection,
      totalCount,
      playerOrder,
      nextPlayerId,
    },
  };
}

export function terrainObjectForPlacement(
  kind: TerrainKind,
  ordinal: number,
  x: number,
  z: number,
  options: { variant?: ManualTerrainVariant; rotationDeg?: number; visualVariant?: TerrainVisualVariant } = {},
): TerrainObject {
  const variant = options.variant === "asteroid-medium" ? "asteroid-medium" : "asteroid-light";
  const asteroidMedium = kind === "asteroid-field" && variant === "asteroid-medium";
  const radius = kind === "gas-cloud"
    ? GAS_CLOUD_RADIUS_INCHES
    : asteroidMedium
      ? ASTEROID_FIELD_MEDIUM_RADIUS_INCHES
      : ASTEROID_FIELD_RADIUS_INCHES;
  const shapeSeed = ordinal * 1009 + (kind === "gas-cloud" ? 317 : asteroidMedium ? 509 : 113);
  const gasVisualVariant = kind === "gas-cloud"
    ? normalizeTerrainVisualVariant(options.visualVariant)
      ?? (terrainSeededUnit(shapeSeed, 47) < 0.5 ? "ionized-cloud" : "dust-cloud")
    : undefined;
  const rotationDeg = Number.isFinite(Number(options.rotationDeg))
    ? (((Number(options.rotationDeg) % 360) + 360) % 360)
    : Math.floor(terrainSeededUnit(shapeSeed, 37) * 360);
  return {
    id: kind === "gas-cloud" ? `gas-cloud-${ordinal}` : `asteroid-field-${ordinal}`,
    kind,
    name: kind === "gas-cloud"
      ? `Dust Cloud ${ordinal}`
      : asteroidMedium
        ? `Medium Asteroid Field ${ordinal}`
        : `Asteroid Field ${ordinal}`,
    x: Number(x.toFixed(3)),
    z: Number(z.toFixed(3)),
    radiusInches: radius,
    density: kind === "gas-cloud" ? 0 : asteroidDensityFromD6(),
    modelFilename: kind === "gas-cloud"
      ? ""
      : asteroidMedium
        ? ASTEROID_FIELD_MODEL_MEDIUM
        : ASTEROID_FIELD_MODEL,
    rotationDeg,
    footprintScaleX: Number((
      (kind === "gas-cloud" ? 0.88 : 0.92) +
      terrainSeededUnit(shapeSeed, 41) * (kind === "gas-cloud" ? 0.3 : 0.2)
    ).toFixed(3)),
    footprintScaleZ: Number((
      (kind === "gas-cloud" ? 0.88 : 0.92) +
      terrainSeededUnit(shapeSeed, 43) * (kind === "gas-cloud" ? 0.3 : 0.2)
    ).toFixed(3)),
    shapeSeed,
    visualVariant: gasVisualVariant,
  };
}

export function normalizeTerrainConfig(raw: unknown): TerrainConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { version: 1, objects: [] };
  const rawObjects = (raw as { objects?: unknown }).objects;
  const objects = Array.isArray(rawObjects)
    ? rawObjects
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
        .map((item, index): TerrainObject | null => {
          if (item.kind !== "asteroid-field" && item.kind !== "gas-cloud") return null;
          const x = Number(item.x);
          const z = Number(item.z);
          if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
          const kind = item.kind;
          const modelFilename = typeof item.modelFilename === "string" && item.modelFilename ? item.modelFilename : ASTEROID_FIELD_MODEL;
          const fallbackSeed = index + 1;
          const shapeSeed = Number.isFinite(Number(item.shapeSeed)) ? Math.max(0, Math.trunc(Number(item.shapeSeed))) : fallbackSeed;
          const visualVariant = kind === "gas-cloud"
            ? normalizeTerrainVisualVariant(item.visualVariant) ?? "ionized-cloud"
            : undefined;
          const fallbackRotationDeg = Math.floor(terrainSeededUnit(shapeSeed, 37) * 360);
          const defaultRadius = kind === "gas-cloud"
            ? GAS_CLOUD_RADIUS_INCHES
            : modelFilename === ASTEROID_FIELD_MODEL_MEDIUM
              ? ASTEROID_FIELD_MEDIUM_RADIUS_INCHES
              : ASTEROID_FIELD_RADIUS_INCHES;
          return {
            id: typeof item.id === "string" && item.id ? item.id.slice(0, 80) : `${kind}-${index + 1}`,
            kind,
            name: typeof item.name === "string" && item.name ? item.name.slice(0, 80) : kind === "gas-cloud" ? `Dust Cloud ${index + 1}` : `Asteroid Field ${index + 1}`,
            x: clamp(x, BOARD_MIN_X, BOARD_MAX_X),
            z: clamp(z, BOARD_MIN_Z, BOARD_MAX_Z),
            radiusInches: kind === "gas-cloud"
              ? clamp(Number(item.radiusInches) || defaultRadius, GAS_CLOUD_MIN_RADIUS_INCHES, GAS_CLOUD_MAX_RADIUS_INCHES)
              : modelFilename === ASTEROID_FIELD_MODEL_MEDIUM
                ? clamp(Number(item.radiusInches) || defaultRadius, ASTEROID_FIELD_MEDIUM_RADIUS_INCHES, 12)
                : clamp(Number(item.radiusInches) || defaultRadius, 0.5, 8),
            density: kind === "gas-cloud" ? 0 : clamp(Math.trunc(Number(item.density) || 6), 6, 10),
            modelFilename: kind === "gas-cloud" ? "" : modelFilename,
            rotationDeg: Number.isFinite(Number(item.rotationDeg)) ? clamp(Number(item.rotationDeg), 0, 360) : fallbackRotationDeg,
            footprintScaleX: Number.isFinite(Number(item.footprintScaleX)) ? clamp(Number(item.footprintScaleX), 0.65, 1.45) : kind === "gas-cloud" ? 1 : 0.94 + terrainSeededUnit(shapeSeed, 41) * 0.18,
            footprintScaleZ: Number.isFinite(Number(item.footprintScaleZ)) ? clamp(Number(item.footprintScaleZ), 0.65, 1.45) : kind === "gas-cloud" ? 1 : 0.94 + terrainSeededUnit(shapeSeed, 43) * 0.18,
            shapeSeed,
            visualVariant,
          };
        })
        .filter((item): item is TerrainObject => item !== null)
        .slice(0, 12)
    : [];
  const rawManual = (raw as { manualPlacement?: unknown }).manualPlacement;
  let manualPlacement: TerrainManualPlacementState | undefined;
  if (rawManual && typeof rawManual === "object" && !Array.isArray(rawManual)) {
    const manual = rawManual as Record<string, unknown>;
    const selection = normalizeTerrainSelection(manual.terrainSelection);
    const totalCount = normalizeManualTerrainCount(manual.totalCount);
    const playerOrder = Array.isArray(manual.playerOrder)
      ? manual.playerOrder.filter((value): value is string => typeof value === "string" && value.length > 0).slice(0, 2)
      : [];
    const nextPlayerId = typeof manual.nextPlayerId === "string" && manual.nextPlayerId.length > 0
      ? manual.nextPlayerId
      : null;
    if (manual.enabled === true && selection !== "none" && totalCount > 0) {
      manualPlacement = {
        enabled: true,
        terrainSelection: selection,
        totalCount,
        playerOrder,
        nextPlayerId,
      };
    }
  }
  return manualPlacement ? { version: 1, objects, manualPlacement } : { version: 1, objects };
}

export function lineOfSightObstaclesFromTerrainConfig(raw: unknown): LineOfSightObstacle[] {
  return normalizeTerrainConfig(raw).objects.map((field) => {
    const polygon = terrainObjectPolygon(field);
    return {
      id: field.id,
      name: field.name,
      kind: field.kind,
      effect: "blocked" as const,
      x: polygon ? undefined : field.x,
      z: polygon ? undefined : field.z,
      radiusInches: polygon ? undefined : field.radiusInches,
      polygon: polygon ?? undefined,
      active: true,
      blocksFromInside: false,
    };
  });
}

function pointInsidePolygon(point: BoardPoint, polygon: BoardPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const intersects =
      (a.z > point.z) !== (b.z > point.z) &&
      point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z || 1e-6) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function terrainObjectPolygon(field: TerrainObject): BoardPoint[] | null {
  const basePoints = field.kind === "gas-cloud"
    ? GAS_CLOUD_FOOTPRINT_POINTS
    : field.kind === "asteroid-field"
      ? field.modelFilename === ASTEROID_FIELD_MODEL_MEDIUM
        ? ASTEROID_MEDIUM_FOOTPRINT_POINTS
        : ASTEROID_LIGHT_FOOTPRINT_POINTS
      : null;
  if (!basePoints) return null;
  const seed = field.shapeSeed ?? 0;
  const scaleX = field.footprintScaleX ?? 1;
  const scaleZ = field.footprintScaleZ ?? 1;
  const variedPoints = basePoints.map((point, index) => {
    const jitter = field.kind === "gas-cloud"
      ? 0.9 + terrainSeededUnit(seed, index) * 0.2
      : 0.93 + terrainSeededUnit(seed, index) * 0.14;
    return {
      x: point.x * scaleX * jitter,
      z: point.z * scaleZ * jitter,
    };
  });
  const rawRadius = Math.max(...variedPoints.map((point) => Math.hypot(point.x, point.z)));
  const scale = field.radiusInches / rawRadius;
  const rotation = ((field.rotationDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return variedPoints.map((point) => {
    const x = point.x * scale;
    const z = point.z * scale;
    return {
      x: field.x + x * cos - z * sin,
      z: field.z + x * sin + z * cos,
    };
  });
}

export function pointInsideTerrainObject(point: BoardPoint, field: TerrainObject): boolean {
  const polygon = terrainObjectPolygon(field);
  if (polygon) return pointInsidePolygon(point, polygon);
  return Math.hypot(point.x - field.x, point.z - field.z) <= field.radiusInches + 1e-6;
}

export function pointInsideAsteroidField(point: { x: number; z: number }, raw: unknown): TerrainObject | null {
  return normalizeTerrainConfig(raw).objects.find((field) =>
    field.kind === "asteroid-field" &&
    pointInsideTerrainObject(point, field),
  ) ?? null;
}

export function pointInsideGasCloud(point: { x: number; z: number }, raw: unknown): TerrainObject | null {
  return normalizeTerrainConfig(raw).objects.find((field) =>
    field.kind === "gas-cloud" &&
    pointInsideTerrainObject(point, field),
  ) ?? null;
}
