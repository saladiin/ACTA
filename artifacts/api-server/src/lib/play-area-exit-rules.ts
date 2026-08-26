export const PLAY_AREA_BOUNDS = {
  minX: -24,
  maxX: 24,
  minZ: -36,
  maxZ: 36,
} as const;

export type PlayAreaEdge = "port" | "starboard" | "north" | "south";
export type DepartureConsequence = "tactical-withdrawal" | "full-victory-points" | "objective-exit" | "forbidden";

export type WithdrawalPolicy = {
  enabled: boolean;
  forbiddenOwners: string[];
  safeEdgesByOwner: Record<string, PlayAreaEdge[]>;
  neutralEdges: PlayAreaEdge[];
  forbiddenEdges: PlayAreaEdge[];
  objectiveEdgesByOwner: Record<string, PlayAreaEdge[]>;
  jumpConsequence: Exclude<DepartureConsequence, "forbidden">;
  holdingGround: boolean;
};

export type BoundaryCrossing = {
  edge: PlayAreaEdge;
  t: number;
  x: number;
  z: number;
};

const PRIORITY_ORDER = [
  "patrol",
  "skirmish",
  "raid",
  "battle",
  "war",
  "armageddon",
  "ancient",
] as const;

function priorityIndex(value: string | null | undefined): number {
  const normalized = String(value ?? "raid").trim().toLowerCase();
  const index = PRIORITY_ORDER.indexOf(normalized as (typeof PRIORITY_ORDER)[number]);
  return index >= 0 ? index : PRIORITY_ORDER.indexOf("raid");
}

export function normalVictoryPoints(
  shipPriority: string | null | undefined,
  scenarioPriority: string | null | undefined,
): number {
  const difference = priorityIndex(shipPriority) - priorityIndex(scenarioPriority);
  if (difference >= 0) return 10 + Math.min(5, difference) * 10;
  return [5, 3, 2, 1, 0.5][Math.min(4, Math.abs(difference) - 1)] ?? 0.5;
}

export function tacticalWithdrawalVictoryPoints(normalValue: number): number {
  return Math.ceil(Math.max(0, normalValue) / 4);
}

export function footprintInsidePlayArea(
  point: { x: number; z: number; baseRadiusInches?: number | null },
  bounds = PLAY_AREA_BOUNDS,
): boolean {
  const radius = Math.max(0, Number(point.baseRadiusInches) || 0);
  return point.x >= bounds.minX + radius
    && point.x <= bounds.maxX - radius
    && point.z >= bounds.minZ + radius
    && point.z <= bounds.maxZ - radius;
}

export function firstFootprintBoundaryCrossing(
  start: { x: number; z: number },
  end: { x: number; z: number },
  baseRadiusInches: number,
  bounds = PLAY_AREA_BOUNDS,
): BoundaryCrossing | null {
  const radius = Math.max(0, Number(baseRadiusInches) || 0);
  const limits: Array<{ edge: PlayAreaEdge; axis: "x" | "z"; value: number }> = [
    { edge: "port", axis: "x", value: bounds.minX + radius },
    { edge: "starboard", axis: "x", value: bounds.maxX - radius },
    { edge: "south", axis: "z", value: bounds.minZ + radius },
    { edge: "north", axis: "z", value: bounds.maxZ - radius },
  ];
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const candidates: BoundaryCrossing[] = [];

  for (const limit of limits) {
    const delta = limit.axis === "x" ? dx : dz;
    if (Math.abs(delta) < 1e-9) continue;
    const startValue = limit.axis === "x" ? start.x : start.z;
    const endValue = limit.axis === "x" ? end.x : end.z;
    const exitsThroughLimit = limit.value < startValue
      ? endValue < limit.value - 1e-9
      : endValue > limit.value + 1e-9;
    if (!exitsThroughLimit) continue;
    const t = (limit.value - startValue) / delta;
    if (t < -1e-9 || t > 1 + 1e-9) continue;
    const x = start.x + dx * t;
    const z = start.z + dz * t;
    if (
      x < bounds.minX + radius - 1e-6
      || x > bounds.maxX - radius + 1e-6
      || z < bounds.minZ + radius - 1e-6
      || z > bounds.maxZ - radius + 1e-6
    ) continue;
    candidates.push({ edge: limit.edge, t, x, z });
  }

  candidates.sort((a, b) => a.t - b.t || a.edge.localeCompare(b.edge));
  return candidates[0] ?? null;
}

export function defaultWithdrawalPolicy(playerIds: string[]): WithdrawalPolicy {
  const [challengerId, opponentId] = playerIds;
  return {
    enabled: true,
    forbiddenOwners: [],
    safeEdgesByOwner: Object.fromEntries(playerIds.map(id => [
      id,
      id === challengerId ? ["north"] : id === opponentId ? ["south"] : [],
    ])),
    neutralEdges: ["port", "starboard"],
    forbiddenEdges: [],
    objectiveEdgesByOwner: Object.fromEntries(playerIds.map(id => [id, []])),
    jumpConsequence: "tactical-withdrawal",
    holdingGround: true,
  };
}

export function departureConsequenceForEdge(
  policy: WithdrawalPolicy,
  ownerId: string,
  edge: PlayAreaEdge,
): DepartureConsequence {
  if (
    !policy.enabled
    || policy.forbiddenOwners.includes(ownerId)
    || policy.forbiddenEdges.includes(edge)
  ) return "forbidden";
  if ((policy.objectiveEdgesByOwner[ownerId] ?? []).includes(edge)) return "objective-exit";
  if (
    policy.neutralEdges.includes(edge)
    || (policy.safeEdgesByOwner[ownerId] ?? []).includes(edge)
  ) return "tactical-withdrawal";
  return "full-victory-points";
}

export function victoryPointsForDeparture(
  normalValue: number,
  consequence: DepartureConsequence,
): number {
  if (consequence === "objective-exit" || consequence === "forbidden") return 0;
  if (consequence === "full-victory-points") return normalValue;
  return tacticalWithdrawalVictoryPoints(normalValue);
}
