import {
  CAMPAIGN_SCENARIO_LABELS,
  normalizeCampaignEngagementRules,
  type CampaignEngagementRules,
  type CampaignPriorityLevel,
  type CampaignScenarioKey,
} from "./campaign-engagement";
import { rollCampaignDie } from "./campaign-setup";

type RandomSource = () => number;

export type CampaignScenarioTarget = {
  category: string;
  subtype: string;
  name: string;
};

export type CampaignScenarioRollAttempt = {
  dice: [number, number];
  total: number;
  rejectedReason: string;
};

export type CampaignScenarioRollResult = {
  dice: [number, number];
  total: number;
  scenarioKey: CampaignScenarioKey;
  scenarioLabel: string;
  rejectedRolls: CampaignScenarioRollAttempt[];
  planetaryAssaultEligible: boolean;
};

export type CampaignPriorityRollResult = {
  dice: [number, number];
  diceTotal: number;
  attackerModifier: number;
  defenderModifier: number;
  finalTotal: number;
  priorityLevel: CampaignPriorityLevel;
};

export type CampaignSideAllocationPoints = {
  attacker: number;
  defender: number;
};

const SCENARIO_BY_TOTAL: Record<number, CampaignScenarioKey> = {
  2: "assassination",
  3: "recon-run",
  4: "convoy-duty",
  5: "ambush",
  6: "space-superiority",
  7: "call-to-arms",
  8: "annihilation",
  9: "blockade",
  10: "carrier-clash",
  11: "flee-to-jump-gate",
  12: "supply-ships",
};

export function campaignScenarioFromTotal(total: number): CampaignScenarioKey {
  const normalized = Math.max(2, Math.min(12, Math.trunc(total)));
  return SCENARIO_BY_TOTAL[normalized];
}

export function campaignPriorityFromTotal(total: number): CampaignPriorityLevel {
  if (total <= 4) return "patrol";
  if (total <= 6) return "skirmish";
  if (total <= 8) return "raid";
  if (total <= 10) return "battle";
  return "war";
}

export function campaignTargetAllowsPlanetaryAssault(target: CampaignScenarioTarget): boolean {
  return target.subtype === "mining-outpost"
    || target.category === "dead-world"
    || target.category === "settled-world";
}

export function resolveCampaignScenario(args: {
  target: CampaignScenarioTarget;
  attackerHasCarrier: boolean;
  defenderHasCarrier: boolean;
  random?: RandomSource;
}): CampaignScenarioRollResult {
  const random = args.random ?? Math.random;
  const rejectedRolls: CampaignScenarioRollAttempt[] = [];

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const dice: [number, number] = [rollCampaignDie(6, random), rollCampaignDie(6, random)];
    const total = dice[0] + dice[1];
    const scenarioKey = campaignScenarioFromTotal(total);
    let rejectedReason: string | null = null;
    if (scenarioKey === "carrier-clash" && (!args.attackerHasCarrier || !args.defenderHasCarrier)) {
      rejectedReason = "Carrier Clash requires both campaign fleets to have a carrier-capable ship";
    } else if (scenarioKey === "flee-to-jump-gate" && args.target.category !== "jump-gate") {
      rejectedReason = "Flee to the Jump Gate requires a Jump Gate Strategic Target";
    }

    if (rejectedReason) {
      rejectedRolls.push({ dice, total, rejectedReason });
      continue;
    }

    return {
      dice,
      total,
      scenarioKey,
      scenarioLabel: CAMPAIGN_SCENARIO_LABELS[scenarioKey],
      rejectedRolls,
      planetaryAssaultEligible:
        scenarioKey === "supply-ships" && campaignTargetAllowsPlanetaryAssault(args.target),
    };
  }

  throw new Error("Campaign scenario did not resolve after 100 legal rerolls");
}

export function rollCampaignPriority(args: {
  attackerModifier: number;
  defenderModifier: number;
  random?: RandomSource;
}): CampaignPriorityRollResult {
  const random = args.random ?? Math.random;
  const dice: [number, number] = [rollCampaignDie(6, random), rollCampaignDie(6, random)];
  const diceTotal = dice[0] + dice[1];
  const finalTotal = diceTotal + args.attackerModifier + args.defenderModifier;
  return {
    dice,
    diceTotal,
    attackerModifier: args.attackerModifier,
    defenderModifier: args.defenderModifier,
    finalTotal,
    priorityLevel: campaignPriorityFromTotal(finalTotal),
  };
}

export function campaignScenarioFleetLimits(
  scenarioKey: CampaignScenarioKey,
): CampaignSideAllocationPoints {
  switch (scenarioKey) {
    case "ambush":
    case "convoy-duty":
    case "recon-run":
      return { attacker: 3, defender: 5 };
    case "blockade":
      return { attacker: 5, defender: 2 };
    case "flee-to-jump-gate":
      return { attacker: 5, defender: 3 };
    case "planetary-assault":
      return { attacker: 7, defender: 5 };
    default:
      return { attacker: 5, defender: 5 };
  }
}

export function campaignGeneratedEngagementRules(args: {
  scenarioKey: CampaignScenarioKey;
  priorityLevel: CampaignPriorityLevel;
  targetName: string;
}): CampaignEngagementRules {
  const sideAllocationPoints = campaignScenarioFleetLimits(args.scenarioKey);
  const normalized = normalizeCampaignEngagementRules({
    scenarioKey: args.scenarioKey,
    priorityLevel: args.priorityLevel,
    allocationPoints: Math.max(sideAllocationPoints.attacker, sideAllocationPoints.defender),
    deploymentPreset: args.scenarioKey === "ambush" ? "ambush-center" : "standard-short-edge",
    deploymentDepth: 12,
    ambushCenterSide: "defender",
    terrain: "none",
    terrainCount: 0,
    stations: "none",
    skybox: "bright-nebula",
    specialConditions: `${args.targetName} is the contested Strategic Target.`,
  });
  if (!normalized.success) throw new Error(normalized.error);
  return normalized.data;
}

export function shipModelHasTwoFlights(smallCraft: string | null | undefined): boolean {
  if (!smallCraft) return false;
  const flightCounts = Array.from(smallCraft.matchAll(/\((\d+)\)/g), (match) => Number(match[1]));
  return flightCounts.some((count) => count >= 2);
}

export function campaignShipWasUsedThisTurn(usedTurn: number, turnNumber: number): boolean {
  return turnNumber > 0 && usedTurn === turnNumber;
}
