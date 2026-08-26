import assert from "node:assert/strict";
import test from "node:test";
import {
  standDownContributorEligible,
  standDownOpposedCheck,
  standDownPressureSufficient,
  standDownPressureTotal,
  standDownRecoverySucceeds,
  type StandDownUnit,
} from "./stand-down-rules";

function unit(overrides: Partial<StandDownUnit> = {}): StandDownUnit {
  return {
    id: 1,
    ownerId: "alpha",
    hullPoints: 12,
    maxHullPoints: 20,
    x: 0,
    z: 0,
    baseRadiusInches: 0.5,
    ...overrides,
  };
}

test("Stand Down counts only explicitly selected current Damage", () => {
  const contributors = [unit({ hullPoints: 8 }), unit({ id: 2, hullPoints: 5 })];
  assert.equal(standDownPressureTotal(contributors), 13);
  assert.equal(standDownPressureSufficient(contributors, 12), true);
  assert.equal(standDownPressureSufficient(contributors, 13), false);
});

test("Stand Down contributors must be friendly operational ships within 10 inches", () => {
  const target = unit({ id: 9, ownerId: "beta", x: 11, baseRadiusInches: 0.5 });
  assert.equal(standDownContributorEligible(unit(), target, "alpha"), true);
  assert.equal(standDownContributorEligible(unit({ isFighter: true }), target, "alpha"), false);
  assert.equal(standDownContributorEligible(unit({ ownerId: "beta" }), target, "alpha"), false);
  assert.equal(standDownContributorEligible(unit({ x: -1 }), target, "alpha"), false);
  assert.equal(standDownContributorEligible(unit({ surrenderedToOwnerId: "beta" }), target, "alpha"), false);
  assert.equal(standDownContributorEligible(unit({ boardState: "hyperspace" }), target, "alpha"), false);
  assert.equal(standDownContributorEligible(unit({ damageState: "adrift" }), target, "alpha"), false);
  assert.equal(standDownContributorEligible(unit({ crewPoints: 0, maxCrewPoints: 10 }), target, "alpha"), false);
});

test("Stand Down opposed check requires the attacker to beat, not tie, the defender", () => {
  assert.equal(standDownOpposedCheck(3, 4, 0, 2, 5, 0).success, false);
  assert.equal(standDownOpposedCheck(4, 4, 0, 2, 5, 0).success, true);
  assert.equal(standDownOpposedCheck(3, 4, 1, 2, 5, 0).success, true);
});

test("Stand Down recovery needs a total of 10 or more", () => {
  assert.equal(standDownRecoverySucceeds(5, 5), true);
  assert.equal(standDownRecoverySucceeds(4, 5), false);
});
