export type ForcedMovementFootprint = {
  id: number;
  x: number;
  z: number;
  baseRadiusInches: number;
};

export type ForcedMovementEndpoint = {
  x: number;
  z: number;
  blockedByUnitIds: number[];
  shortened: boolean;
};

const POSITION_EPSILON = 1e-6;

function distance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function pointAlongSegment(
  start: { x: number; z: number },
  desired: { x: number; z: number },
  t: number,
): { x: number; z: number } {
  return {
    x: start.x + (desired.x - start.x) * t,
    z: start.z + (desired.z - start.z) * t,
  };
}

/**
 * Keeps compulsory movement on its original straight path while preventing an
 * illegal final-position overlap. Clear endpoints are returned unchanged, so
 * passing over another base remains legal.
 */
export function forcedMovementEndpointBeforeOverlap(args: {
  moving: ForcedMovementFootprint;
  desired: { x: number; z: number };
  blockers: ForcedMovementFootprint[];
  overlapEpsilon?: number;
}): ForcedMovementEndpoint {
  const { moving, desired, blockers } = args;
  const overlapEpsilon = Math.max(0, args.overlapEpsilon ?? 0.01);
  const dx = desired.x - moving.x;
  const dz = desired.z - moving.z;
  const segmentLength = Math.hypot(dx, dz);
  if (segmentLength <= POSITION_EPSILON) {
    return { x: desired.x, z: desired.z, blockedByUnitIds: [], shortened: false };
  }

  let t = 1;
  const blockedByUnitIds = new Set<number>();
  for (let pass = 0; pass <= blockers.length; pass += 1) {
    const candidate = pointAlongSegment(moving, desired, t);
    const overlapping = blockers.filter((blocker) => {
      if (blocker.id === moving.id) return false;
      const combinedRadius = moving.baseRadiusInches + blocker.baseRadiusInches;
      return distance(candidate, blocker) < combinedRadius - overlapEpsilon;
    });
    if (overlapping.length === 0) {
      return {
        x: candidate.x,
        z: candidate.z,
        blockedByUnitIds: [...blockedByUnitIds],
        shortened: t < 1 - POSITION_EPSILON,
      };
    }

    let nextT = t;
    for (const blocker of overlapping) {
      blockedByUnitIds.add(blocker.id);
      const combinedRadius = moving.baseRadiusInches + blocker.baseRadiusInches;
      const relativeX = moving.x - blocker.x;
      const relativeZ = moving.z - blocker.z;
      const a = dx * dx + dz * dz;
      const b = 2 * (relativeX * dx + relativeZ * dz);
      const c = relativeX * relativeX + relativeZ * relativeZ - combinedRadius * combinedRadius;
      const discriminant = b * b - 4 * a * c;
      if (discriminant < 0) {
        nextT = 0;
        continue;
      }
      const entryT = (-b - Math.sqrt(discriminant)) / (2 * a);
      nextT = Math.min(nextT, Math.max(0, entryT));
    }

    if (nextT >= t - POSITION_EPSILON) nextT = Math.max(0, t - overlapEpsilon / segmentLength);
    t = nextT;
  }

  const fallback = pointAlongSegment(moving, desired, t);
  return {
    x: fallback.x,
    z: fallback.z,
    blockedByUnitIds: [...blockedByUnitIds],
    shortened: t < 1 - POSITION_EPSILON,
  };
}
