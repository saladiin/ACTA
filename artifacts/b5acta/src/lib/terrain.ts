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

export const ASTEROID_FIELD_MODEL = "asteroid-light.glb";
export const ASTEROID_FIELD_SOURCE_DIAMETER = 1.78;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
            id: typeof item.id === "string" && item.id ? item.id : `asteroid-field-${index + 1}`,
            kind: "asteroid-field",
            name: typeof item.name === "string" && item.name ? item.name : `Asteroid Field ${index + 1}`,
            x,
            z,
            radiusInches: clamp(Number(item.radiusInches) || 2, 0.5, 8),
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
