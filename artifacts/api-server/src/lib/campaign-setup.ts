import {
  ALLOCATION_TICKS_PER_FAP,
  calculateAllocation,
  normalizePriorityLevel,
} from "./fleet-allocation";

export const CAMPAIGN_STARTING_FAP = 10;
export const CAMPAIGN_STARTING_PRIORITY = "battle" as const;

export type CampaignSetupRosterShip = {
  id: number;
  priorityLevel: unknown;
  crewQualityRoll: number | null;
};

export type CampaignRosterValidation = {
  rosterCount: number;
  budgetTicks: number;
  spentTicks: number;
  remainingTicks: number;
  budgetFap: number;
  spentFap: number;
  remainingFap: number;
  allocationLegal: boolean;
  crewQualityReady: boolean;
  legal: boolean;
  issues: string[];
};

export type StartingCrewQualityRoll = {
  dice: [number, number];
  total: number;
  score: number;
  label: "Civilian" | "Green" | "Military-Grade" | "Veteran" | "Elite";
};

export type CampaignUnusualFeatureSeed = {
  roll: number;
  key: string;
  name: string;
  source: "system-roll" | "ancient-jump-gate";
};

export type CampaignStrategicTargetSeed = {
  sequence: number;
  key: string;
  category: string;
  subtype: string;
  name: string;
  rrValue: number;
  rrFormula: string | null;
  explored: boolean;
  isTradeRoute: boolean;
  categoryRoll: number | null;
  subtypeRoll: number | null;
  unusualFeatures: CampaignUnusualFeatureSeed[];
  rulesPayload: Record<string, unknown>;
};

export type CampaignSystemSeed = {
  targetCountDice: [number, number];
  baseTargetCount: number;
  playerBonusTargets: number;
  strategicTargetCount: number;
  unusualFeatureDie: number;
  unusualFeatureCount: number;
  targets: CampaignStrategicTargetSeed[];
};

type TargetDefinition = {
  category: string;
  subtype: string;
  name: string;
  rrValue: number;
  rrFormula?: string;
  explored?: boolean;
  special?: string;
};

type RandomSource = () => number;

function finiteRandom(random: RandomSource): number {
  const value = random();
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0.999999999, value));
}

export function rollCampaignDie(sides: number, random: RandomSource = Math.random): number {
  const normalizedSides = Math.max(1, Math.trunc(sides));
  return Math.floor(finiteRandom(random) * normalizedSides) + 1;
}

export function campaignCrewQualityFromTotal(total: number): Omit<StartingCrewQualityRoll, "dice" | "total"> {
  const normalized = Math.max(2, Math.min(12, Math.trunc(total)));
  if (normalized === 2) return { score: 2, label: "Civilian" };
  if (normalized <= 4) return { score: 3, label: "Green" };
  if (normalized <= 8) return { score: 4, label: "Military-Grade" };
  if (normalized <= 10) return { score: 5, label: "Veteran" };
  return { score: 6, label: "Elite" };
}

export function rollStartingCrewQuality(random: RandomSource = Math.random): StartingCrewQualityRoll {
  const dice: [number, number] = [rollCampaignDie(6, random), rollCampaignDie(6, random)];
  const total = dice[0] + dice[1];
  return { dice, total, ...campaignCrewQualityFromTotal(total) };
}

export function validateCampaignStartingRoster(
  ships: CampaignSetupRosterShip[],
): CampaignRosterValidation {
  const allocation = calculateAllocation(
    ships.map((ship) => normalizePriorityLevel(ship.priorityLevel, CAMPAIGN_STARTING_PRIORITY)),
    CAMPAIGN_STARTING_PRIORITY,
    CAMPAIGN_STARTING_FAP,
  );
  const rosterCount = ships.length;
  const crewQualityReady = ships.every((ship) => Number.isInteger(ship.crewQualityRoll));
  const issues: string[] = [];
  if (rosterCount === 0) issues.push("Add at least one ship to the campaign roster.");
  if (!allocation.legal) issues.push("Roster exceeds 10 FAP at Battle Priority.");
  if (rosterCount > 0 && !crewQualityReady) {
    issues.push("Generate starting Crew Quality for every roster ship.");
  }
  return {
    rosterCount,
    ...allocation,
    budgetFap: allocation.budgetTicks / ALLOCATION_TICKS_PER_FAP,
    spentFap: allocation.spentTicks / ALLOCATION_TICKS_PER_FAP,
    remainingFap: allocation.remainingTicks / ALLOCATION_TICKS_PER_FAP,
    allocationLegal: allocation.legal,
    crewQualityReady,
    legal: issues.length === 0,
    issues,
  };
}

function strategicTargetCategory(total: number): string {
  if (total <= 3) return "space-installation";
  if (total === 4) return "space-debris";
  if (total === 5) return "gas-giant";
  if (total === 6) return "settled-world";
  if (total === 7) return "dead-world";
  if (total === 8) return "uninhabited-world";
  if (total === 9) return "jump-gate";
  if (total === 10) return "outpost";
  return "inner-system-comet";
}

function targetDefinition(category: string, roll: number): TargetDefinition {
  switch (category) {
    case "space-installation":
      return [
        { category, subtype: "construction-yard", name: "Construction Yard", rrValue: 3 },
        { category, subtype: "diplomatic-station", name: "Diplomatic Station", rrValue: 1 },
        { category, subtype: "military-installation", name: "Military Installation", rrValue: 1 },
        { category, subtype: "scrap-yard", name: "Scrap Yard", rrValue: 1 },
        { category, subtype: "space-docks", name: "Space Docks", rrValue: 1 },
        { category, subtype: "trade-station", name: "Trade Station", rrValue: 3 },
      ][Math.max(1, Math.min(6, roll)) - 1] as TargetDefinition;
    case "space-debris":
      if (roll <= 3) return { category, subtype: "asteroid-belt", name: "Asteroid Belt", rrValue: 0 };
      if (roll === 4) return { category, subtype: "planetary-ring", name: "Planetary Ring", rrValue: 0 };
      if (roll === 5) return { category, subtype: "rich-dust-cloud", name: "Rich Dust Cloud", rrValue: 3 };
      return { category, subtype: "ship-graveyard", name: "Ship Graveyard", rrValue: 0, rrFormula: "1d6" };
    case "gas-giant":
      if (roll <= 3) return { category, subtype: "medium-yield-gas-giant", name: "Medium-Yield Gas Giant", rrValue: 3 };
      if (roll === 4) return { category, subtype: "low-yield-gas-giant", name: "Low-Yield Gas Giant", rrValue: 1 };
      if (roll === 5) return { category, subtype: "high-yield-gas-giant", name: "High-Yield Gas Giant", rrValue: 5 };
      return { category, subtype: "hidden-outpost", name: "Hidden Outpost", rrValue: 1 };
    case "settled-world":
      if (roll <= 3) return { category, subtype: "leisure-world", name: "Leisure World", rrValue: 3 };
      if (roll <= 5) return { category, subtype: "primitive-world", name: "Primitive World", rrValue: 2 };
      if (roll <= 8) return { category, subtype: "industrial-world", name: "Industrial World", rrValue: 10 };
      if (roll <= 10) return { category, subtype: "agrarian-world", name: "Agrarian World", rrValue: 5 };
      return { category, subtype: "commerce-world", name: "Commerce World", rrValue: 6 };
    case "uninhabited-world":
      if (roll <= 2) return { category, subtype: "temperate-planet", name: "Temperate Planet", rrValue: 1, explored: false };
      if (roll <= 4) return { category, subtype: "verdant-planet", name: "Verdant Planet", rrValue: 2, explored: false };
      return { category, subtype: "water-world", name: "Water World", rrValue: 1, explored: false };
    case "dead-world":
      if (roll <= 2) return { category, subtype: "barren-world", name: "Barren World", rrValue: 0, explored: false };
      if (roll <= 4) return { category, subtype: "ice-world", name: "Ice World", rrValue: 0, explored: false };
      if (roll === 5) return { category, subtype: "molten-world", name: "Molten World", rrValue: 1, explored: false };
      return { category, subtype: "toxic-world", name: "Toxic World", rrValue: 0, explored: false };
    case "jump-gate":
      if (roll <= 4) return { category, subtype: "jump-gate", name: "Jump Gate", rrValue: 5 };
      if (roll === 5) return { category, subtype: "ancient-jump-gate", name: "Ancient Jump Gate", rrValue: 5, special: "ancient-jump-gate" };
      return { category, subtype: "faulty-jump-gate", name: "Faulty Jump Gate", rrValue: 2 };
    case "outpost":
      if (roll <= 3) return { category, subtype: "mining-outpost", name: "Mining Outpost", rrValue: 10 };
      if (roll === 4) return { category, subtype: "observation-outpost", name: "Observation Outpost", rrValue: 1 };
      if (roll === 5) return { category, subtype: "religious-outpost", name: "Religious Outpost", rrValue: 1 };
      return { category, subtype: "scientific-outpost", name: "Scientific Outpost", rrValue: 3 };
    default:
      if (roll <= 4) return { category: "inner-system-comet", subtype: "ice-rock-composite-comet", name: "Ice-Rock Composite Comet", rrValue: 0 };
      return { category: "inner-system-comet", subtype: "mineral-rich-comet", name: "Mineral-Rich Comet", rrValue: 1 };
  }
}

function unusualFeature(total: number, source: CampaignUnusualFeatureSeed["source"] = "system-roll"): CampaignUnusualFeatureSeed {
  if (total === 2) return { roll: total, key: "space-time-anomaly", name: "Space-Time Anomaly", source };
  if (total <= 5) return { roll: total, key: "heavy-dust-clouds", name: "Heavy Dust Clouds", source };
  if (total <= 7) return { roll: total, key: "electromagnetic-distortion", name: "Electromagnetic Distortion", source };
  if (total <= 9) return { roll: total, key: "minefield", name: "Minefield", source };
  if (total <= 11) return { roll: total, key: "heavy-asteroid-density", name: "Heavy Asteroid Density", source };
  return { roll: total, key: "power-drain", name: "Power Drain", source };
}

function rollTarget(category: string, sequence: number, random: RandomSource): CampaignStrategicTargetSeed {
  const subtypeRoll = category === "settled-world"
    ? rollCampaignDie(6, random) + rollCampaignDie(6, random)
    : rollCampaignDie(6, random);
  const definition = targetDefinition(category, subtypeRoll);
  const ancientFeature = definition.special === "ancient-jump-gate"
    ? [unusualFeature(rollCampaignDie(6, random) + rollCampaignDie(6, random), "ancient-jump-gate")]
    : [];
  return {
    sequence,
    key: `target-${sequence}`,
    category,
    subtype: definition.subtype,
    name: definition.name,
    rrValue: definition.rrValue,
    rrFormula: definition.rrFormula ?? null,
    explored: definition.explored ?? true,
    isTradeRoute: false,
    categoryRoll: null,
    subtypeRoll,
    unusualFeatures: ancientFeature,
    rulesPayload: definition.special ? { special: definition.special } : {},
  };
}

export function generateCampaignSystem(
  playerCount: number,
  random: RandomSource = Math.random,
): CampaignSystemSeed {
  const normalizedPlayerCount = Math.max(2, Math.trunc(playerCount));
  const targetCountDice: [number, number] = [rollCampaignDie(6, random), rollCampaignDie(6, random)];
  const targetCountTotal = targetCountDice[0] + targetCountDice[1];
  const baseTargetCount = targetCountTotal <= 4 ? 6 : targetCountTotal <= 8 ? 7 : 8;
  const playerBonusTargets = normalizedPlayerCount - 2;
  const strategicTargetCount = baseTargetCount + playerBonusTargets;
  const targets: CampaignStrategicTargetSeed[] = [];

  const first = rollTarget("settled-world", 1, random);
  first.rulesPayload = { ...first.rulesPayload, firstTargetByRule: true };
  targets.push(first);

  for (let sequence = 2; sequence <= strategicTargetCount; sequence += 1) {
    const categoryRoll = rollCampaignDie(6, random) + rollCampaignDie(6, random);
    const target = rollTarget(strategicTargetCategory(categoryRoll), sequence, random);
    target.categoryRoll = categoryRoll;
    targets.push(target);
  }

  const unusualFeatureDie = rollCampaignDie(6, random);
  const unusualFeatureCount = unusualFeatureDie <= 3 ? 0 : unusualFeatureDie <= 5 ? 1 : 2;
  for (let index = 0; index < unusualFeatureCount; index += 1) {
    const featureRoll = rollCampaignDie(6, random) + rollCampaignDie(6, random);
    const targetIndex = rollCampaignDie(targets.length, random) - 1;
    targets[targetIndex].unusualFeatures.push(unusualFeature(featureRoll));
  }

  targets.push({
    sequence: strategicTargetCount + 1,
    key: "trade-route",
    category: "trade-route",
    subtype: "trade-route",
    name: "Trade Route",
    rrValue: 5,
    rrFormula: null,
    explored: true,
    isTradeRoute: true,
    categoryRoll: null,
    subtypeRoll: null,
    unusualFeatures: [],
    rulesPayload: { returnsToNeutralAtEndOfTurn: true },
  });

  return {
    targetCountDice,
    baseTargetCount,
    playerBonusTargets,
    strategicTargetCount,
    unusualFeatureDie,
    unusualFeatureCount,
    targets,
  };
}
