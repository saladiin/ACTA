import type { DeploymentConfig, DeploymentRect } from "./deployment-zones";
import type { LineOfSightObstacle } from "./line-of-sight";

export type TerrainKind = "asteroid-field";

export type TerrainObject = {
  id: string;
  kind: TerrainKind;
  name: string;
  x: number;
  z: number;
  radiusInches: number;
  density: number;
  modelFilename: string;
};

export type TerrainConfig = {
  version: 1;
  objects: TerrainObject[];
};

export type TerrainSelection = "none" | "asteroid-fields";

const BOARD_MIN_X = -24;
const BOARD_MAX_X = 24;
const BOARD_MIN_Z = -36;
const BOARD_MAX_Z = 36;
const BOARD_RECT: DeploymentRect = {
  type: "rect",
  xMin: BOARD_MIN_X,
  xMax: BOARD_MAX_X,
  zMin: BOARD_MIN_Z,
  zMax: BOARD_MAX_Z,
};

export const ASTEROID_FIELD_RADIUS_INCHES = 2;
export const ASTEROID_FIELD_MODEL = "asteroid-light.glb";

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

function terrainForbiddenRects(deploymentConfig: DeploymentConfig): DeploymentRect[] {
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
  if (!circleFullyInsideRect(x, z, radius, BOARD_RECT)) return false;
  if (forbiddenRects.some((rect) => circleIntersectsRect(x, z, radius, rect))) return false;
  return !existing.some((field) => Math.hypot(field.x - x, field.z - z) < field.radiusInches + radius + 1);
}

export function normalizeTerrainSelection(value: unknown): TerrainSelection {
  return value === "asteroid-fields" ? "asteroid-fields" : "none";
}

export function normalizeAsteroidFieldCount(value: unknown): 0 | 3 | 6 | 9 {
  const count = Math.trunc(Number(value));
  return count === 3 || count === 6 || count === 9 ? count : 0;
}

export function generateAsteroidTerrainConfig(
  deploymentConfig: DeploymentConfig,
  count: 0 | 3 | 6 | 9,
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
    const xMin = BOARD_MIN_X + cell.column * cellWidth;
    const xMax = xMin + cellWidth;
    const zMin = BOARD_MIN_Z + cell.row * cellDepth;
    const zMax = zMin + cellDepth;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const x = randomBetween(xMin + ASTEROID_FIELD_RADIUS_INCHES, xMax - ASTEROID_FIELD_RADIUS_INCHES);
      const z = randomBetween(zMin + ASTEROID_FIELD_RADIUS_INCHES, zMax - ASTEROID_FIELD_RADIUS_INCHES);
      if (!pointAllowedForTerrain(x, z, ASTEROID_FIELD_RADIUS_INCHES, forbiddenRects, objects)) continue;
      objects.push({
        id: `asteroid-field-${objects.length + 1}`,
        kind: "asteroid-field",
        name: `Asteroid Field ${objects.length + 1}`,
        x: Number(x.toFixed(3)),
        z: Number(z.toFixed(3)),
        radiusInches: ASTEROID_FIELD_RADIUS_INCHES,
        density: asteroidDensityFromD6(),
        modelFilename: ASTEROID_FIELD_MODEL,
      });
      break;
    }
  }
  return { version: 1, objects };
}

export function normalizeTerrainConfig(raw: unknown): TerrainConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { version: 1, objects: [] };
  const rawObjects = (raw as { objects?: unknown }).objects;
  const objects = Array.isArray(rawObjects)
    ? rawObjects
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
        .map((item, index): TerrainObject | null => {
          if (item.kind !== "asteroid-field") return null;
          const x = Number(item.x);
          const z = Number(item.z);
          if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
          return {
            id: typeof item.id === "string" && item.id ? item.id.slice(0, 80) : `asteroid-field-${index + 1}`,
            kind: "asteroid-field",
            name: typeof item.name === "string" && item.name ? item.name.slice(0, 80) : `Asteroid Field ${index + 1}`,
            x: clamp(x, BOARD_MIN_X, BOARD_MAX_X),
            z: clamp(z, BOARD_MIN_Z, BOARD_MAX_Z),
            radiusInches: clamp(Number(item.radiusInches) || ASTEROID_FIELD_RADIUS_INCHES, 0.5, 8),
            density: clamp(Math.trunc(Number(item.density) || 6), 6, 10),
            modelFilename: typeof item.modelFilename === "string" && item.modelFilename ? item.modelFilename : ASTEROID_FIELD_MODEL,
          };
        })
        .filter((item): item is TerrainObject => item !== null)
        .slice(0, 12)
    : [];
  return { version: 1, objects };
}

export function lineOfSightObstaclesFromTerrainConfig(raw: unknown): LineOfSightObstacle[] {
  return normalizeTerrainConfig(raw).objects.map((field) => ({
    id: field.id,
    name: field.name,
    kind: field.kind,
    effect: "blocked",
    x: field.x,
    z: field.z,
    radiusInches: field.radiusInches,
    active: true,
    blocksFromInside: false,
  }));
}

export function pointInsideAsteroidField(point: { x: number; z: number }, raw: unknown): TerrainObject | null {
  return normalizeTerrainConfig(raw).objects.find((field) =>
    Math.hypot(point.x - field.x, point.z - field.z) <= field.radiusInches + 1e-6,
  ) ?? null;
}
