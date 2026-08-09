import { rulesProfileForModel } from "./ancient-rules";

export type BoardingRollGroup = {
  label: string;
  rolls: number[];
  kills: number;
};

export type BoardingCombatRound = {
  breachingPod?: BoardingRollGroup;
  defender: BoardingRollGroup;
  attacker?: BoardingRollGroup;
};

export type CounterBoardingRound = {
  enemy: BoardingRollGroup;
  counter: BoardingRollGroup;
};

export type BoardingRoller = () => number;

export const ACTIVE_BOARDING_STATUSES = ["pending", "fighting", "unopposed", "captured"] as const;
export const COUNTER_BOARDING_TARGET_STATUSES = ["fighting", "unopposed", "captured"] as const;

export function boardingHits(rolls: number[]): number {
  return rolls.filter(roll => roll >= 5).length;
}

export function effectiveBoardingTroopsFromCount(
  troops: number | null | undefined,
  skeletonPenalty: boolean,
): number {
  const available = Math.max(0, troops ?? 0);
  if (available <= 0) return 0;
  return skeletonPenalty ? Math.floor(available / 2) : available;
}

export function boardingImmuneProfile(
  model: { rulesProfile: string; faction: string },
): boolean {
  return rulesProfileForModel(model) !== "standard";
}

export function breachingPodTroopsAvailable(
  pod: { troopPoints: number | null; maxTroopPoints: number | null },
  podModel: { troops: number | null },
): number {
  return Math.max(0, pod.troopPoints ?? 0, pod.maxTroopPoints ?? 0, podModel.troops ?? 0);
}

export function resolveBoardingCombat(
  input: {
    defenderTroops: number;
    shipAttackers: number;
    podAttackers: number;
  },
  rollD6: BoardingRoller,
): {
  defenderTroopsBefore: number;
  defenderTroopsAfter: number;
  defenderTroopsLost: number;
  attackerTroopsBefore: number;
  attackerTroopsAfter: number;
  podAttackerTroopsBefore: number;
  podAttackerTroopsAfter: number;
  shipAttackerTroopsBefore: number;
  shipAttackerTroopsAfter: number;
  defenderWins: boolean;
  attackerWins: boolean;
  rounds: BoardingCombatRound[];
} {
  let defenders = Math.max(0, input.defenderTroops);
  let podAttackers = Math.max(0, input.podAttackers);
  let shipAttackers = Math.max(0, input.shipAttackers);
  const defenderTroopsBefore = defenders;
  const podAttackerTroopsBefore = podAttackers;
  const shipAttackerTroopsBefore = shipAttackers;
  const attackerTroopsBefore = podAttackers + shipAttackers;
  const rounds: BoardingCombatRound[] = [];
  const totalAttackers = () => podAttackers + shipAttackers;

  while (defenders > 0 && totalAttackers() > 0) {
    const breachingPodRolls = podAttackers > 0
      ? Array.from({ length: podAttackers }, () => rollD6())
      : [];
    const breachingPodKills = Math.min(defenders, boardingHits(breachingPodRolls));
    defenders -= breachingPodKills;

    const defenderRolls = defenders > 0 && totalAttackers() > 0
      ? Array.from({ length: defenders }, () => rollD6())
      : [];
    const defenderKills = Math.min(totalAttackers(), boardingHits(defenderRolls));
    let remainingDefenderKills = defenderKills;
    const shipLosses = Math.min(shipAttackers, remainingDefenderKills);
    shipAttackers -= shipLosses;
    remainingDefenderKills -= shipLosses;
    const podLosses = Math.min(podAttackers, remainingDefenderKills);
    podAttackers -= podLosses;

    const attackerRolls = shipAttackers > 0 && defenders > 0
      ? Array.from({ length: shipAttackers }, () => rollD6())
      : [];
    const attackerKills = Math.min(defenders, boardingHits(attackerRolls));
    defenders -= attackerKills;

    rounds.push({
      ...(breachingPodRolls.length > 0
        ? {
            breachingPod: {
              label: "breaching pod attackers",
              rolls: breachingPodRolls,
              kills: breachingPodKills,
            },
          }
        : {}),
      defender: { label: "defenders", rolls: defenderRolls, kills: defenderKills },
      ...(attackerRolls.length > 0 || shipAttackerTroopsBefore > 0
        ? {
            attacker: {
              label: "ship boarders",
              rolls: attackerRolls,
              kills: attackerKills,
            },
          }
        : {}),
    });
  }

  const attackerTroopsAfter = totalAttackers();
  return {
    defenderTroopsBefore,
    defenderTroopsAfter: defenders,
    defenderTroopsLost: Math.max(0, defenderTroopsBefore - defenders),
    attackerTroopsBefore,
    attackerTroopsAfter,
    podAttackerTroopsBefore,
    podAttackerTroopsAfter: podAttackers,
    shipAttackerTroopsBefore,
    shipAttackerTroopsAfter: shipAttackers,
    defenderWins: defenders > 0 && attackerTroopsAfter <= 0,
    attackerWins: attackerTroopsAfter > 0 && defenders <= 0,
    rounds,
  };
}

export function resolveCounterBoardingCombat(
  input: {
    counterTroops: number;
    enemyTroops: number;
  },
  rollD6: BoardingRoller,
): {
  counterTroopsBefore: number;
  counterTroopsAfter: number;
  enemyTroopsBefore: number;
  enemyTroopsAfter: number;
  counterWins: boolean;
  enemyWins: boolean;
  rounds: CounterBoardingRound[];
} {
  let counterTroops = Math.max(0, input.counterTroops);
  let enemyTroops = Math.max(0, input.enemyTroops);
  const counterTroopsBefore = counterTroops;
  const enemyTroopsBefore = enemyTroops;
  const rounds: CounterBoardingRound[] = [];

  while (counterTroops > 0 && enemyTroops > 0) {
    const enemyRolls = Array.from({ length: enemyTroops }, () => rollD6());
    const enemyKills = Math.min(counterTroops, boardingHits(enemyRolls));
    counterTroops -= enemyKills;
    const counterRolls = counterTroops > 0
      ? Array.from({ length: counterTroops }, () => rollD6())
      : [];
    const counterKills = Math.min(enemyTroops, boardingHits(counterRolls));
    enemyTroops -= counterKills;
    rounds.push({
      enemy: { label: "enemy boarders", rolls: enemyRolls, kills: enemyKills },
      counter: { label: "counter-boarders", rolls: counterRolls, kills: counterKills },
    });
  }

  return {
    counterTroopsBefore,
    counterTroopsAfter: counterTroops,
    enemyTroopsBefore,
    enemyTroopsAfter: enemyTroops,
    counterWins: counterTroops > 0 && enemyTroops <= 0,
    enemyWins: enemyTroops > 0 && counterTroops <= 0,
    rounds,
  };
}
