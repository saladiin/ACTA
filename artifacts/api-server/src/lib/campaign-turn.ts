import { rollCampaignDie } from "./campaign-setup";

type RandomSource = () => number;

export type CampaignInitiativeEntry = {
  playerId: string;
  dice: [number, number];
  fleetModifier: number;
  targetPenalty: number;
  rerolls?: CampaignInitiativeReroll[];
};

export type CampaignInitiativeReroll = {
  dice: [number, number];
  total: number;
};

export type ResolvedCampaignInitiative = CampaignInitiativeEntry & {
  initialTotal: number;
  finalTotal: number;
  rerolls: CampaignInitiativeReroll[];
};

function initiativeTotal(
  dice: [number, number],
  fleetModifier: number,
  targetPenalty: number,
): number {
  return dice[0] + dice[1] + fleetModifier + targetPenalty;
}

export function rollCampaignInitiativeDice(random: RandomSource = Math.random): [number, number] {
  return [rollCampaignDie(6, random), rollCampaignDie(6, random)];
}

export function campaignInitiativeTotal(entry: CampaignInitiativeEntry): number {
  return initiativeTotal(entry.dice, entry.fleetModifier, entry.targetPenalty);
}

export function resolveCampaignInitiative(
  entries: CampaignInitiativeEntry[],
  random: RandomSource = Math.random,
): ResolvedCampaignInitiative[] {
  const playerIds = new Set(entries.map((entry) => entry.playerId));
  if (playerIds.size !== entries.length) {
    throw new Error("Campaign initiative entries must contain unique commanders");
  }

  const resolved = entries.map((entry) => {
    const rerolls = [...(entry.rerolls ?? [])];
    const initialTotal = campaignInitiativeTotal(entry);
    return {
      ...entry,
      rerolls,
      initialTotal,
      finalTotal: rerolls.at(-1)?.total ?? initialTotal,
    };
  });

  for (let round = 0; round < 100; round += 1) {
    const totalCounts = new Map<number, number>();
    for (const entry of resolved) {
      totalCounts.set(entry.finalTotal, (totalCounts.get(entry.finalTotal) ?? 0) + 1);
    }
    const tied = resolved.filter((entry) => (totalCounts.get(entry.finalTotal) ?? 0) > 1);
    if (tied.length === 0) {
      return [...resolved].sort((a, b) => b.finalTotal - a.finalTotal);
    }
    for (const entry of tied) {
      const dice = rollCampaignInitiativeDice(random);
      const total = initiativeTotal(dice, entry.fleetModifier, entry.targetPenalty);
      entry.rerolls.push({ dice, total });
      entry.finalTotal = total;
    }
  }

  throw new Error("Campaign initiative ties did not resolve after 100 rerolls");
}

export function campaignChallengeOrder(
  initiativeOrder: string[],
  nominatorPlayerId: string,
): string[] {
  const nominatorIndex = initiativeOrder.indexOf(nominatorPlayerId);
  if (nominatorIndex < 0) {
    throw new Error("Nominating commander is not present in campaign initiative order");
  }
  return Array.from({ length: Math.max(0, initiativeOrder.length - 1) }, (_, offset) => (
    initiativeOrder[(nominatorIndex + offset + 1) % initiativeOrder.length]
  ));
}
