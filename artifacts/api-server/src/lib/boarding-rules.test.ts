import assert from "node:assert/strict";
import test from "node:test";
import {
  boardingHits,
  boardingImmuneProfile,
  breachingPodTroopsAvailable,
  effectiveBoardingTroopsFromCount,
  resolveBoardingCombat,
  resolveCounterBoardingCombat,
} from "./boarding-rules";

function queuedRoller(rolls: number[]): () => number {
  const queue = [...rolls];
  return () => {
    const roll = queue.shift();
    assert.ok(roll != null, "test exhausted its queued dice rolls");
    return roll;
  };
}

test("boarding hits score on 5+", () => {
  assert.equal(boardingHits([1, 4, 5, 6]), 2);
});

test("skeleton crew halves effective defending troops", () => {
  assert.equal(effectiveBoardingTroopsFromCount(5, false), 5);
  assert.equal(effectiveBoardingTroopsFromCount(5, true), 2);
  assert.equal(effectiveBoardingTroopsFromCount(null, true), 0);
});

test("non-standard rules profiles are immune to boarding", () => {
  assert.equal(boardingImmuneProfile({ rulesProfile: "standard", faction: "Earth Alliance" }), false);
  assert.equal(boardingImmuneProfile({ rulesProfile: "standard", faction: "Shadows" }), true);
  assert.equal(boardingImmuneProfile({ rulesProfile: "ancients", faction: "Kirishiac" }), true);
});

test("breaching pods use the best available troop source", () => {
  assert.equal(
    breachingPodTroopsAvailable(
      { troopPoints: 0, maxTroopPoints: 2 },
      { troops: 1 },
    ),
    2,
  );
  assert.equal(
    breachingPodTroopsAvailable(
      { troopPoints: 3, maxTroopPoints: 1 },
      { troops: 2 },
    ),
    3,
  );
});

test("ship boarders attack after surviving defending troops", () => {
  const combat = resolveBoardingCombat(
    { defenderTroops: 2, shipAttackers: 2, podAttackers: 0 },
    queuedRoller([5, 1, 5, 5]),
  );

  assert.equal(combat.defenderWins, true);
  assert.equal(combat.attackerWins, false);
  assert.equal(combat.defenderTroopsAfter, 1);
  assert.equal(combat.shipAttackerTroopsAfter, 0);
  assert.deepEqual(combat.rounds[0]?.defender.rolls, [5, 1]);
  assert.deepEqual(combat.rounds[0]?.attacker?.rolls, [5]);
});

test("breaching pods strike before defenders respond", () => {
  const combat = resolveBoardingCombat(
    { defenderTroops: 1, shipAttackers: 0, podAttackers: 1 },
    queuedRoller([5]),
  );

  assert.equal(combat.attackerWins, true);
  assert.equal(combat.defenderTroopsAfter, 0);
  assert.equal(combat.podAttackerTroopsAfter, 1);
  assert.deepEqual(combat.rounds[0]?.breachingPod?.rolls, [5]);
  assert.deepEqual(combat.rounds[0]?.defender.rolls, []);
});

test("defenders blunt ship boarders before breaching pod boarders", () => {
  const combat = resolveBoardingCombat(
    { defenderTroops: 2, shipAttackers: 1, podAttackers: 1 },
    queuedRoller([5, 5, 5]),
  );

  assert.equal(combat.attackerWins, true);
  assert.equal(combat.shipAttackerTroopsAfter, 0);
  assert.equal(combat.podAttackerTroopsAfter, 1);
  assert.equal(combat.defenderTroopsAfter, 0);
});

test("counter-boarding enemy boarders strike before counter-boarders", () => {
  const enemyWins = resolveCounterBoardingCombat(
    { enemyTroops: 1, counterTroops: 1 },
    queuedRoller([5]),
  );
  assert.equal(enemyWins.enemyWins, true);
  assert.equal(enemyWins.counterTroopsAfter, 0);
  assert.deepEqual(enemyWins.rounds[0]?.counter.rolls, []);

  const counterWins = resolveCounterBoardingCombat(
    { enemyTroops: 1, counterTroops: 1 },
    queuedRoller([1, 5]),
  );
  assert.equal(counterWins.counterWins, true);
  assert.equal(counterWins.enemyTroopsAfter, 0);
  assert.deepEqual(counterWins.rounds[0]?.enemy.rolls, [1]);
  assert.deepEqual(counterWins.rounds[0]?.counter.rolls, [5]);
});
