export type DeploymentSide = "challenger" | "opponent";

export type DeploymentPreset =
  | "standard-short-edge"
  | "standard-long-edge"
  | "ambush-center";

export type DeploymentRect = {
  type: "rect";
  xMin: number;
  xMax: number;
  zMin: number;
  zMax: number;
};

export type DeploymentSideConfig = {
  zones: DeploymentRect[];
  exclusions?: DeploymentRect[];
  defaultHeading: number;
};

export type DeploymentConfig = {
  version: 1;
  preset: DeploymentPreset;
  challenger: DeploymentSideConfig;
  opponent: DeploymentSideConfig;
};

export const DEPLOYMENT_BOARD_WIDTH = 48;
export const DEPLOYMENT_BOARD_DEPTH = 72;

const BOARD_RECT: DeploymentRect = {
  type: "rect",
  xMin: -DEPLOYMENT_BOARD_WIDTH / 2,
  xMax: DEPLOYMENT_BOARD_WIDTH / 2,
  zMin: -DEPLOYMENT_BOARD_DEPTH / 2,
  zMax: DEPLOYMENT_BOARD_DEPTH / 2,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampDeploymentDepth(depth: number): number {
  return clamp(Math.trunc(Number.isFinite(depth) ? depth : 12), 4, 30);
}

function clampBoxSize(value: number, fallback: number, max: number): number {
  return clamp(Math.trunc(Number.isFinite(value) ? value : fallback), 6, max);
}

function normalizeRect(rect: DeploymentRect): DeploymentRect {
  const xMin = clamp(Math.min(rect.xMin, rect.xMax), BOARD_RECT.xMin, BOARD_RECT.xMax);
  const xMax = clamp(Math.max(rect.xMin, rect.xMax), BOARD_RECT.xMin, BOARD_RECT.xMax);
  const zMin = clamp(Math.min(rect.zMin, rect.zMax), BOARD_RECT.zMin, BOARD_RECT.zMax);
  const zMax = clamp(Math.max(rect.zMin, rect.zMax), BOARD_RECT.zMin, BOARD_RECT.zMax);
  return { type: "rect", xMin, xMax, zMin, zMax };
}

function rectCenter(rect: DeploymentRect): [number, number] {
  return [(rect.xMin + rect.xMax) / 2, (rect.zMin + rect.zMax) / 2];
}

function circleFullyInsideRect(x: number, z: number, radius: number, rect: DeploymentRect): boolean {
  return x - radius >= rect.xMin && x + radius <= rect.xMax && z - radius >= rect.zMin && z + radius <= rect.zMax;
}

function circleIntersectsRect(x: number, z: number, radius: number, rect: DeploymentRect): boolean {
  const closestX = clamp(x, rect.xMin, rect.xMax);
  const closestZ = clamp(z, rect.zMin, rect.zMax);
  return Math.hypot(x - closestX, z - closestZ) <= radius;
}

export function createDeploymentConfig(input?: {
  preset?: string | null;
  deploymentDepth?: number | null;
  ambushPlayer?: DeploymentSide | null;
  ambushBoxWidth?: number | null;
  ambushBoxDepth?: number | null;
}): DeploymentConfig {
  const depth = clampDeploymentDepth(input?.deploymentDepth ?? 12);
  const preset = input?.preset === "standard-long-edge" || input?.preset === "ambush-center"
    ? input.preset
    : "standard-short-edge";

  if (preset === "standard-long-edge") {
    return {
      version: 1,
      preset,
      challenger: {
        zones: [{ type: "rect", xMin: BOARD_RECT.xMin, xMax: BOARD_RECT.xMin + depth, zMin: BOARD_RECT.zMin, zMax: BOARD_RECT.zMax }],
        defaultHeading: 90,
      },
      opponent: {
        zones: [{ type: "rect", xMin: BOARD_RECT.xMax - depth, xMax: BOARD_RECT.xMax, zMin: BOARD_RECT.zMin, zMax: BOARD_RECT.zMax }],
        defaultHeading: 270,
      },
    };
  }

  if (preset === "ambush-center") {
    const width = clampBoxSize(input?.ambushBoxWidth ?? 16, 16, 40);
    const boxDepth = clampBoxSize(input?.ambushBoxDepth ?? 16, 16, 56);
    const centerBox: DeploymentRect = {
      type: "rect",
      xMin: -width / 2,
      xMax: width / 2,
      zMin: -boxDepth / 2,
      zMax: boxDepth / 2,
    };
    const ambusher: DeploymentSide = input?.ambushPlayer === "opponent" ? "opponent" : "challenger";
    const outside: DeploymentSide = ambusher === "challenger" ? "opponent" : "challenger";
    const config: DeploymentConfig = {
      version: 1,
      preset,
      challenger: { zones: [BOARD_RECT], exclusions: [centerBox], defaultHeading: 0 },
      opponent: { zones: [BOARD_RECT], exclusions: [centerBox], defaultHeading: 180 },
    };
    config[ambusher] = {
      zones: [centerBox],
      exclusions: [],
      defaultHeading: ambusher === "challenger" ? 0 : 180,
    };
    config[outside] = {
      zones: [BOARD_RECT],
      exclusions: [centerBox],
      defaultHeading: outside === "challenger" ? 0 : 180,
    };
    return config;
  }

  return {
    version: 1,
    preset: "standard-short-edge",
    challenger: {
      zones: [{ type: "rect", xMin: BOARD_RECT.xMin, xMax: BOARD_RECT.xMax, zMin: BOARD_RECT.zMax - depth, zMax: BOARD_RECT.zMax }],
      defaultHeading: 180,
    },
    opponent: {
      zones: [{ type: "rect", xMin: BOARD_RECT.xMin, xMax: BOARD_RECT.xMax, zMin: BOARD_RECT.zMin, zMax: BOARD_RECT.zMin + depth }],
      defaultHeading: 0,
    },
  };
}

export function normalizeDeploymentConfig(raw: unknown, deploymentDepth = 12): DeploymentConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createDeploymentConfig({ deploymentDepth });
  }
  const candidate = raw as Partial<DeploymentConfig>;
  const normalizeSide = (side: unknown, fallback: DeploymentSideConfig): DeploymentSideConfig => {
    if (!side || typeof side !== "object" || Array.isArray(side)) return fallback;
    const data = side as Partial<DeploymentSideConfig>;
    const zones = Array.isArray(data.zones)
      ? data.zones
          .filter((zone): zone is DeploymentRect => Boolean(zone && typeof zone === "object" && (zone as DeploymentRect).type === "rect"))
          .map(normalizeRect)
          .filter((zone) => zone.xMax - zone.xMin > 0.5 && zone.zMax - zone.zMin > 0.5)
      : [];
    const exclusions = Array.isArray(data.exclusions)
      ? data.exclusions
          .filter((zone): zone is DeploymentRect => Boolean(zone && typeof zone === "object" && (zone as DeploymentRect).type === "rect"))
          .map(normalizeRect)
          .filter((zone) => zone.xMax - zone.xMin > 0.5 && zone.zMax - zone.zMin > 0.5)
      : [];
    return {
      zones: zones.length > 0 ? zones.slice(0, 4) : fallback.zones,
      exclusions: exclusions.slice(0, 4),
      defaultHeading: Number.isFinite(data.defaultHeading) ? data.defaultHeading! : fallback.defaultHeading,
    };
  };
  const fallback = createDeploymentConfig({ preset: candidate.preset, deploymentDepth });
  return {
    version: 1,
    preset: fallback.preset,
    challenger: normalizeSide(candidate.challenger, fallback.challenger),
    opponent: normalizeSide(candidate.opponent, fallback.opponent),
  };
}

export function deploymentSideConfig(config: DeploymentConfig, side: DeploymentSide): DeploymentSideConfig {
  return side === "challenger" ? config.challenger : config.opponent;
}

export function isPointInDeploymentZone(
  x: number,
  z: number,
  side: DeploymentSide,
  config: DeploymentConfig,
  baseRadius = 0,
): boolean {
  const deployment = deploymentSideConfig(config, side);
  const radius = Math.max(0, baseRadius);
  const inAllowedZone = deployment.zones.some((zone) => circleFullyInsideRect(x, z, radius, zone));
  if (!inAllowedZone) return false;
  return !(deployment.exclusions ?? []).some((zone) => circleIntersectsRect(x, z, radius, zone));
}

function pushOutsideExclusions(x: number, z: number, radius: number, exclusions: DeploymentRect[]): [number, number] {
  let nextX = x;
  let nextZ = z;
  for (const exclusion of exclusions) {
    if (!circleIntersectsRect(nextX, nextZ, radius, exclusion)) continue;
    const left = Math.abs(nextX - (exclusion.xMin - radius));
    const right = Math.abs(nextX - (exclusion.xMax + radius));
    const bottom = Math.abs(nextZ - (exclusion.zMin - radius));
    const top = Math.abs(nextZ - (exclusion.zMax + radius));
    const min = Math.min(left, right, bottom, top);
    if (min === left) nextX = exclusion.xMin - radius;
    else if (min === right) nextX = exclusion.xMax + radius;
    else if (min === bottom) nextZ = exclusion.zMin - radius;
    else nextZ = exclusion.zMax + radius;
  }
  return [nextX, nextZ];
}

export function clampPointToDeploymentZone(
  x: number,
  z: number,
  side: DeploymentSide,
  config: DeploymentConfig,
  baseRadius = 0,
): [number, number] {
  const deployment = deploymentSideConfig(config, side);
  const radius = Math.max(0, baseRadius);
  const candidates: [number, number][] = [];
  for (const zone of deployment.zones) {
    const zx = clamp(x, zone.xMin + radius, zone.xMax - radius);
    const zz = clamp(z, zone.zMin + radius, zone.zMax - radius);
    candidates.push(pushOutsideExclusions(zx, zz, radius, deployment.exclusions ?? []));
  }
  candidates.sort((a, b) => Math.hypot(a[0] - x, a[1] - z) - Math.hypot(b[0] - x, b[1] - z));
  const legal = candidates.find(([cx, cz]) => isPointInDeploymentZone(cx, cz, side, config, radius));
  if (legal) return legal;
  const [cx, cz] = rectCenter(deployment.zones[0] ?? BOARD_RECT);
  return [cx, cz];
}

export function defaultDeploymentPoint(
  side: DeploymentSide,
  config: DeploymentConfig,
  index: number,
  total: number,
  baseRadius = 0,
): [number, number] {
  const deployment = deploymentSideConfig(config, side);
  const zone = deployment.zones[0] ?? BOARD_RECT;
  const columns = Math.min(3, Math.max(1, total));
  const row = Math.floor(index / columns);
  const col = index % columns;
  const rowCount = Math.ceil(total / columns);
  const rowColumns = row === rowCount - 1 ? total - row * columns || columns : columns;
  const [centerX, centerZ] = rectCenter(zone);
  const rawX = centerX + (col - (rowColumns - 1) / 2) * 5;
  const rawZ = centerZ + (row - (rowCount - 1) / 2) * 4;
  return clampPointToDeploymentZone(rawX, rawZ, side, config, baseRadius);
}
