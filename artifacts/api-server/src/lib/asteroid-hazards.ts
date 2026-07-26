export type AsteroidAttackInput = {
  attackDice: number;
  hullRating: number;
  dodgeTarget: number;
  dodgeActive: boolean;
  shieldsCurrent: number;
  geg: number;
  adaptiveArmour: boolean;
  blastDoorsActive: boolean;
  hasCrewTrack: boolean;
  fighter: boolean;
  fighterHullPoints: number;
};

export type AsteroidAttackResolution = {
  hitThreshold: number;
  attackRolls: number[];
  hits: number;
  dodgeRolls: number[];
  dodgesSuccessful: number;
  remainingHits: number;
  shieldedHits: number;
  shieldsAfter: number;
  attackTableRolls: number[];
  bulkheadHits: number;
  solidHits: number;
  criticalHits: number;
  damage: number;
  crewLost: number;
};

export function cumulativeAsteroidAttackDice(inchesInside: number): number {
  return inchesInside > 0.01
    ? Math.max(1, Math.ceil(inchesInside - 1e-6))
    : 0;
}

export function additionalAsteroidAttackDice(
  cumulativeInchesInside: number,
  previouslyResolvedDice: number,
): number {
  return Math.max(
    0,
    cumulativeAsteroidAttackDice(cumulativeInchesInside) - Math.max(0, previouslyResolvedDice),
  );
}

export function resolveAsteroidAttack(
  input: AsteroidAttackInput,
  rollD6: () => number = () => 1 + Math.floor(Math.random() * 6),
): AsteroidAttackResolution {
  const hitThreshold = Math.max(1, Math.min(6, Math.trunc(input.hullRating || 4)) - 2);
  const attackRolls: number[] = [];
  let hits = 0;
  for (let i = 0; i < Math.max(0, Math.trunc(input.attackDice)); i++) {
    const roll = rollD6();
    attackRolls.push(roll);
    if (roll >= hitThreshold) hits++;
  }

  const dodgeRolls: number[] = [];
  let dodgesSuccessful = 0;
  if (input.dodgeActive && input.dodgeTarget > 0) {
    for (let i = 0; i < hits; i++) {
      const roll = rollD6();
      dodgeRolls.push(roll);
      if (roll >= input.dodgeTarget) dodgesSuccessful++;
    }
  }

  let remainingHits = Math.max(0, hits - dodgesSuccessful);
  const fighterOneHitDestroyed = input.fighter && remainingHits > 0;
  let shieldsAfter = Math.max(0, Math.trunc(input.shieldsCurrent));
  let shieldedHits = 0;
  if (!fighterOneHitDestroyed && shieldsAfter > 0 && remainingHits > 0) {
    while (remainingHits > 0 && shieldsAfter >= 3) {
      shieldsAfter -= 3;
      shieldedHits++;
      remainingHits--;
    }
    if (remainingHits > 0 && shieldsAfter > 0) shieldsAfter = 0;
  }

  const attackTableRolls: number[] = [];
  let bulkheadHits = 0;
  let solidHits = 0;
  let criticalHits = 0;
  let damage = 0;
  let crewLost = 0;
  if (fighterOneHitDestroyed) {
    damage = Math.max(0, input.fighterHullPoints);
  } else {
    for (let i = 0; i < remainingHits; i++) {
      const roll = rollD6();
      attackTableRolls.push(roll);
      if (roll === 1) {
        bulkheadHits++;
        damage += 1;
      } else {
        if (roll >= 6) criticalHits++;
        else solidHits++;
        damage += 3;
        if (input.hasCrewTrack) crewLost += 3;
      }
    }

    const gegReduction = Math.max(0, Math.trunc(input.geg)) * remainingHits;
    damage = Math.max(0, damage - gegReduction);
    crewLost = Math.max(0, crewLost - gegReduction);
    if (input.adaptiveArmour && (damage > 0 || crewLost > 0)) {
      damage = damage > 0 ? Math.max(1, Math.floor(damage / 2)) : 0;
      crewLost = crewLost > 0 ? Math.max(1, Math.floor(crewLost / 2)) : 0;
    }
    if (input.blastDoorsActive) {
      let damageSaved = 0;
      let crewSaved = 0;
      for (let i = 0; i < damage; i++) if (rollD6() >= 5) damageSaved++;
      for (let i = 0; i < crewLost; i++) if (rollD6() >= 5) crewSaved++;
      damage = Math.max(0, damage - damageSaved);
      crewLost = Math.max(0, crewLost - crewSaved);
    }
  }

  return {
    hitThreshold,
    attackRolls,
    hits,
    dodgeRolls,
    dodgesSuccessful,
    remainingHits,
    shieldedHits,
    shieldsAfter,
    attackTableRolls,
    bulkheadHits,
    solidHits,
    criticalHits,
    damage,
    crewLost,
  };
}
