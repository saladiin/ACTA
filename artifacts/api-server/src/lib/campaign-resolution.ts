import { normalizePriorityLevel, PRIORITY_LEVELS } from "./fleet-allocation";

export type CampaignRrIncomeInput = {
  heldTargetValues: number[];
  battlesWon: number;
  targetsCaptured: number;
  targetsLost: number;
  stationCount: number;
};

export type CampaignRrIncomeBreakdown = {
  base: number;
  heldTargets: number;
  victories: number;
  captures: number;
  losses: number;
  stations: number;
  total: number;
};

export const CAMPAIGN_REINFORCEMENT_COSTS: Record<string, number> = {
  patrol: 3,
  skirmish: 6,
  raid: 12,
  battle: 20,
  war: 30,
  armageddon: 50,
};

export function campaignDestroyXpDice(attackerPriority: unknown, targetPriority: unknown): number {
  const attackerIndex = PRIORITY_LEVELS.indexOf(normalizePriorityLevel(attackerPriority, "raid"));
  const targetIndex = PRIORITY_LEVELS.indexOf(normalizePriorityLevel(targetPriority, "raid"));
  if (targetIndex < attackerIndex) return 1;
  return Math.min(7, 2 + Math.max(0, targetIndex - attackerIndex));
}

export function campaignPartialDamageXpDice(destroyXpDice: number): number {
  return Math.floor(Math.max(0, destroyXpDice) / 2);
}

export function campaignRrIncome(input: CampaignRrIncomeInput): CampaignRrIncomeBreakdown {
  const result = {
    base: 10,
    heldTargets: input.heldTargetValues.reduce((sum, value) => sum + Math.max(0, Math.trunc(value)), 0),
    victories: Math.max(0, Math.trunc(input.battlesWon)) * 5,
    captures: Math.max(0, Math.trunc(input.targetsCaptured)) * 10,
    losses: Math.max(0, Math.trunc(input.targetsLost)) * -15,
    stations: Math.max(0, Math.trunc(input.stationCount)) * -5,
  };
  return { ...result, total: Object.values(result).reduce((sum, value) => sum + value, 0) };
}

export function campaignHullRepairCost(args: {
  missingHull: number;
  crippled: boolean;
  crippledPremiumPaid: boolean;
  hasSpaceDocks: boolean;
}): { hullRr: number; crippledPremium: number; total: number } {
  const hullRr = Math.ceil(Math.max(0, Math.trunc(args.missingHull)) / 5);
  const crippledPremium = args.crippled && !args.crippledPremiumPaid && !args.hasSpaceDocks ? 5 : 0;
  return { hullRr, crippledPremium, total: hullRr + crippledPremium };
}

export function campaignCrewRepairCost(missing: number): number {
  return Math.ceil(Math.max(0, Math.trunc(missing)) / 8);
}

export function campaignCriticalRepairCost(location: unknown): number {
  return Number(location) === 6 || (typeof location === "string" && /vital/i.test(location)) ? 2 : 1;
}

export function campaignReinforcementCost(priorityLevel: unknown, isSpaceStation: boolean): number {
  const priority = normalizePriorityLevel(priorityLevel, "raid");
  const base = CAMPAIGN_REINFORCEMENT_COSTS[priority] ?? CAMPAIGN_REINFORCEMENT_COSTS.raid;
  return isSpaceStation ? base * 3 : base;
}

export function rollCampaignDice(count: number, random: () => number = Math.random): number[] {
  return Array.from({ length: Math.max(0, Math.trunc(count)) }, () => {
    const rolled = random();
    const value = Number.isFinite(rolled) ? rolled : 0;
    return 1 + Math.floor(Math.max(0, Math.min(0.999999999, value)) * 6);
  });
}
