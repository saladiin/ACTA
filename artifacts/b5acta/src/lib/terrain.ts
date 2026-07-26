import type { LineOfSightObstacle } from "./line-of-sight";

export type TerrainKind = "asteroid-field" | "gas-cloud";

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
};

export type TerrainConfig = {
  version: 1;
  objects: TerrainObject[];
};

export const ASTEROID_FIELD_MODEL = "asteroid-light.glb";
export const ASTEROID_FIELD_MODEL_MEDIUM = "asteroids_medium.glb";
export const ASTEROID_FIELD_SOURCE_DIAMETER = 1.78;
export const ASTEROID_FIELD_MEDIUM_RADIUS_INCHES = 6;
export const ASTEROID_LIGHT_FOOTPRINT_POINTS: Array<[number, number]> = [
  [-1.04, -0.32],
  [-0.72, -0.82],
  [-0.08, -1.02],
  [0.58, -0.76],
  [1.08, -0.12],
  [0.78, 0.58],
  [0.18, 0.98],
  [-0.62, 0.74],
  [-1.08, 0.2],
];
export const ASTEROID_MEDIUM_FOOTPRINT_POINTS: Array<[number, number]> = [
  [-1.1, -0.34],
  [-0.86, -0.82],
  [-0.24, -1.02],
  [0.34, -0.86],
  [0.96, -0.52],
  [1.08, 0.18],
  [0.58, 0.74],
  [-0.08, 1],
  [-0.78, 0.7],
  [-1.02, 0.18],
];
export const GAS_CLOUD_RADIUS_INCHES = 3;
export const GAS_CLOUD_MIN_RADIUS_INCHES = 2.5;
export const GAS_CLOUD_MAX_RADIUS_INCHES = 3.5;
export const GAS_CLOUD_FOOTPRINT_POINTS: Array<[number, number]> = [
  [-3.05, -0.62],
  [-2.42, -1.2],
  [-1.1, -1.05],
  [-0.18, -1.36],
  [1.06, -1.06],
  [2.66, -1.16],
  [3.22, -0.44],
  [2.88, 0.52],
  [1.38, 1.08],
  [0.02, 1.28],
  [-1.44, 0.92],
  [-2.72, 0.42],
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function terrainSeededUnit(seed: number, index: number): number {
  const value = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return value - Math.floor(value);
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
          const fallbackRotationDeg = Math.floor(terrainSeededUnit(shapeSeed, 37) * 360);
          const defaultRadius = kind === "gas-cloud"
            ? GAS_CLOUD_RADIUS_INCHES
            : modelFilename === ASTEROID_FIELD_MODEL_MEDIUM
              ? ASTEROID_FIELD_MEDIUM_RADIUS_INCHES
              : 2;
          return {
            id: typeof item.id === "string" && item.id ? item.id : `${kind}-${index + 1}`,
            kind,
            name: typeof item.name === "string" && item.name ? item.name : kind === "gas-cloud" ? `Dust Cloud ${index + 1}` : `Asteroid Field ${index + 1}`,
            x,
            z,
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
          };
        })
        .filter((item): item is TerrainObject => item !== null)
        .slice(0, 12)
    : [];
  return { version: 1, objects };
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

export function terrainObjectPolygon(field: TerrainObject): LineOfSightObstacle["polygon"] | null {
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
  const variedPoints = basePoints.map(([x, z], index) => {
    const jitter = field.kind === "gas-cloud"
      ? 0.9 + terrainSeededUnit(seed, index) * 0.2
      : 0.93 + terrainSeededUnit(seed, index) * 0.14;
    return [x * scaleX * jitter, z * scaleZ * jitter] as const;
  });
  const rawRadius = Math.max(
    ...variedPoints.map(([x, z]) => Math.hypot(x, z)),
  );
  const scale = field.radiusInches / rawRadius;
  const rotation = ((field.rotationDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return variedPoints.map(([pointX, pointZ]) => {
    const x = pointX * scale;
    const z = pointZ * scale;
    return {
      x: field.x + x * cos - z * sin,
      z: field.z + x * sin + z * cos,
    };
  });
}

function pointInsidePolygon(point: { x: number; z: number }, polygon: Array<{ x: number; z: number }>): boolean {
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

export function pointInsideTerrainObject(
  point: { x: number; z: number },
  field: TerrainObject,
): boolean {
  const polygon = terrainObjectPolygon(field);
  if (polygon && polygon.length >= 3) return pointInsidePolygon(point, polygon);
  return Math.hypot(point.x - field.x, point.z - field.z) <= field.radiusInches + 1e-6;
}
