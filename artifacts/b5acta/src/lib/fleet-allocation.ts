export const PRIORITY_LEVELS = [
  "patrol",
  "skirmish",
  "raid",
  "battle",
  "war",
  "armageddon",
] as const;

export type PriorityLevel = typeof PRIORITY_LEVELS[number];

export const ALLOCATION_TICKS_PER_FAP = 72;

const COST_BY_DELTA: Record<number, number> = {
  "-5": 4,
  "-4": 6,
  "-3": 9,
  "-2": 18,
  "-1": 36,
  0: 72,
  1: 144,
  2: 288,
  3: 576,
  4: 864,
  5: 1296,
};

export function normalizePriorityLevel(value: unknown, fallback: PriorityLevel = "raid"): PriorityLevel {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return PRIORITY_LEVELS.includes(normalized as PriorityLevel)
    ? normalized as PriorityLevel
    : fallback;
}

export function priorityLabel(level: PriorityLevel): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export function allocationTicksForShip(
  shipPriority: PriorityLevel,
  scenarioPriority: PriorityLevel,
): number {
  const delta = PRIORITY_LEVELS.indexOf(shipPriority) - PRIORITY_LEVELS.indexOf(scenarioPriority);
  return COST_BY_DELTA[delta] ?? ALLOCATION_TICKS_PER_FAP;
}

export function calculateAllocation(
  shipPriorities: PriorityLevel[],
  scenarioPriority: PriorityLevel,
  allocationPoints: number,
) {
  const budgetTicks = Math.max(0, Math.trunc(allocationPoints)) * ALLOCATION_TICKS_PER_FAP;
  const spentTicks = shipPriorities.reduce(
    (sum, level) => sum + allocationTicksForShip(level, scenarioPriority),
    0,
  );
  const remainingTicks = budgetTicks - spentTicks;
  return {
    budgetTicks,
    spentTicks,
    remainingTicks,
    legal: spentTicks <= budgetTicks,
  };
}

export function formatAllocationTicks(ticks: number): string {
  if (ticks % ALLOCATION_TICKS_PER_FAP === 0) {
    return `${ticks / ALLOCATION_TICKS_PER_FAP} FAP`;
  }
  const asDecimal = ticks / ALLOCATION_TICKS_PER_FAP;
  return `${asDecimal.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")} FAP`;
}

