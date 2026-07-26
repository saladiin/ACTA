import assert from "node:assert/strict";
import test from "node:test";
import {
  additionalAsteroidAttackDice,
  cumulativeAsteroidAttackDice,
  resolveAsteroidAttack,
  type AsteroidAttackInput,
} from "./asteroid-hazards";

const baseInput: AsteroidAttackInput = {
  attackDice: 1,
  hullRating: 6,
  dodgeTarget: 0,
  dodgeActive: false,
  shieldsCurrent: 0,
  geg: 0,
  adaptiveArmour: false,
  blastDoorsActive: false,
  hasCrewTrack: true,
  fighter: false,
  fighterHullPoints: 10,
};

function queuedRolls(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index++];
    assert.ok(value != null, "test exhausted its queued dice");
    return value;
  };
}

test("Super AP lowers Hull 6 asteroid attacks to a 4+ threshold", () => {
  const result = resolveAsteroidAttack(baseInput, queuedRolls([4, 2]));
  assert.equal(result.hitThreshold, 4);
  assert.equal(result.hits, 1);
});

test("Triple Damage applies three hull and crew for a solid hit", () => {
  const result = resolveAsteroidAttack(baseInput, queuedRolls([4, 2]));
  assert.equal(result.damage, 3);
  assert.equal(result.crewLost, 3);
  assert.equal(result.solidHits, 1);
});

test("Triple Damage bulkheads cause one hull and no crew", () => {
  const result = resolveAsteroidAttack(baseInput, queuedRolls([4, 1]));
  assert.equal(result.damage, 1);
  assert.equal(result.crewLost, 0);
  assert.equal(result.bulkheadHits, 1);
});

test("Dodge removes asteroid hits before shields and the attack table", () => {
  const result = resolveAsteroidAttack(
    { ...baseInput, dodgeTarget: 4, dodgeActive: true },
    queuedRolls([6, 4]),
  );
  assert.equal(result.dodgesSuccessful, 1);
  assert.equal(result.remainingHits, 0);
  assert.equal(result.damage, 0);
});

test("Adrift-style resolution disables Dodge through dodgeActive", () => {
  const result = resolveAsteroidAttack(
    { ...baseInput, dodgeTarget: 2, dodgeActive: false },
    queuedRolls([6, 2]),
  );
  assert.equal(result.dodgeRolls.length, 0);
  assert.equal(result.damage, 3);
});

test("Triple Damage hits consume three shield points", () => {
  const result = resolveAsteroidAttack(
    { ...baseInput, shieldsCurrent: 3 },
    queuedRolls([6]),
  );
  assert.equal(result.shieldedHits, 1);
  assert.equal(result.shieldsAfter, 0);
  assert.equal(result.damage, 0);
});

test("cumulative traversal adds dice only when a new inch is reached", () => {
  assert.equal(cumulativeAsteroidAttackDice(0.34), 1);
  assert.equal(additionalAsteroidAttackDice(0.68, 1), 0);
  assert.equal(additionalAsteroidAttackDice(1.02, 1), 1);
});
