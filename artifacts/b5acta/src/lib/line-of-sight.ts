export type BoardPoint = {
  x: number;
  z: number;
};

export type LineOfSightObstacleKind =
  | "asteroid-field"
  | "nebula"
  | "gas-cloud"
  | "debris-field"
  | "station"
  | "terrain";

export type LineOfSightEffect = "blocked" | "obscured";

export type LineOfSightObstacle = {
  id: string;
  name: string;
  kind: LineOfSightObstacleKind;
  effect: LineOfSightEffect;
  x?: number;
  z?: number;
  radiusInches?: number;
  polygon?: BoardPoint[];
  active?: boolean;
  blocksFromInside?: boolean;
};

export type LineOfSightBlock = {
  obstacle: LineOfSightObstacle;
  distanceFromSource: number;
};

const EPSILON = 1e-6;

function distance(a: BoardPoint, b: BoardPoint): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function pointInCircle(point: BoardPoint, center: BoardPoint, radius: number): boolean {
  return distance(point, center) <= radius + EPSILON;
}

function segmentCircleHitDistance(
  source: BoardPoint,
  target: BoardPoint,
  center: BoardPoint,
  radius: number,
): number | null {
  const dx = target.x - source.x;
  const dz = target.z - source.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq <= EPSILON) return null;

  const fx = source.x - center.x;
  const fz = source.z - center.z;
  const a = lengthSq;
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - radius * radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;

  const sqrt = Math.sqrt(discriminant);
  const t1 = (-b - sqrt) / (2 * a);
  const t2 = (-b + sqrt) / (2 * a);
  const t = [t1, t2].filter((value) => value >= -EPSILON && value <= 1 + EPSILON).sort((aT, bT) => aT - bT)[0];
  return t == null ? null : Math.max(0, t) * Math.sqrt(lengthSq);
}

function segmentSegmentHitDistance(
  source: BoardPoint,
  target: BoardPoint,
  a: BoardPoint,
  b: BoardPoint,
): number | null {
  const r = { x: target.x - source.x, z: target.z - source.z };
  const s = { x: b.x - a.x, z: b.z - a.z };
  const denominator = r.x * s.z - r.z * s.x;
  if (Math.abs(denominator) <= EPSILON) return null;

  const uNumerator = (a.x - source.x) * r.z - (a.z - source.z) * r.x;
  const tNumerator = (a.x - source.x) * s.z - (a.z - source.z) * s.x;
  const t = tNumerator / denominator;
  const u = uNumerator / denominator;
  if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) return null;
  return Math.max(0, t) * Math.hypot(r.x, r.z);
}

function pointInPolygon(point: BoardPoint, polygon: BoardPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects =
      (a.z > point.z) !== (b.z > point.z) &&
      point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z || EPSILON) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function segmentPolygonHitDistance(
  source: BoardPoint,
  target: BoardPoint,
  polygon: BoardPoint[],
): number | null {
  if (polygon.length < 3) return null;
  const hits: number[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const hit = segmentSegmentHitDistance(source, target, a, b);
    if (hit != null) hits.push(hit);
  }
  if (hits.length === 0) return null;
  return Math.min(...hits);
}

function obstacleHitDistance(
  source: BoardPoint,
  target: BoardPoint,
  obstacle: LineOfSightObstacle,
): number | null {
  if (obstacle.active === false || obstacle.effect !== "blocked") return null;

  if (
    obstacle.radiusInches != null &&
    obstacle.radiusInches > 0 &&
    obstacle.x != null &&
    obstacle.z != null
  ) {
    const center = { x: obstacle.x, z: obstacle.z };
    const sourceInside = pointInCircle(source, center, obstacle.radiusInches);
    const targetInside = pointInCircle(target, center, obstacle.radiusInches);
    if (!obstacle.blocksFromInside && (sourceInside || targetInside)) return null;
    return segmentCircleHitDistance(source, target, center, obstacle.radiusInches);
  }

  if (obstacle.polygon && obstacle.polygon.length >= 3) {
    const sourceInside = pointInPolygon(source, obstacle.polygon);
    const targetInside = pointInPolygon(target, obstacle.polygon);
    if (!obstacle.blocksFromInside && (sourceInside || targetInside)) return null;
    return segmentPolygonHitDistance(source, target, obstacle.polygon);
  }

  return null;
}

export function findBlockingLineOfSightObstacle(
  source: BoardPoint,
  target: BoardPoint,
  obstacles: LineOfSightObstacle[],
): LineOfSightBlock | null {
  let closest: LineOfSightBlock | null = null;
  for (const obstacle of obstacles) {
    const hit = obstacleHitDistance(source, target, obstacle);
    if (hit == null) continue;
    if (!closest || hit < closest.distanceFromSource) {
      closest = { obstacle, distanceFromSource: hit };
    }
  }
  return closest;
}
