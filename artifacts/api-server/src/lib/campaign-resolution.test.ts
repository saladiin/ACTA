import assert from "node:assert/strict";
import test from "node:test";
import {
  campaignCrewRepairCost,
  campaignCriticalRepairCost,
  campaignDestroyXpDice,
  campaignHullRepairCost,
  campaignPartialDamageXpDice,
  campaignReinforcementCost,
  campaignRrIncome,
} from "./campaign-resolution";

test("campaign XP scales with relative Priority and halves for crippling or skeletoning", () => {
  assert.equal(campaignDestroyXpDice("battle", "raid"), 1);
  assert.equal(campaignDestroyXpDice("raid", "raid"), 2);
  assert.equal(campaignDestroyXpDice("patrol", "armageddon"), 7);
  assert.equal(campaignPartialDamageXpDice(5), 2);
});

test("campaign RR income applies the complete core turn formula", () => {
  assert.deepEqual(campaignRrIncome({
    heldTargetValues: [1, 3, 5],
    battlesWon: 2,
    targetsCaptured: 1,
    targetsLost: 1,
    stationCount: 1,
  }), {
    base: 10,
    heldTargets: 9,
    victories: 10,
    captures: 10,
    losses: -15,
    stations: -5,
    total: 19,
  });
});

test("campaign repairs charge per started hull and crew block", () => {
  assert.deepEqual(campaignHullRepairCost({
    missingHull: 11,
    crippled: true,
    crippledPremiumPaid: false,
    hasSpaceDocks: false,
  }), { hullRr: 3, crippledPremium: 5, total: 8 });
  assert.equal(campaignCrewRepairCost(9), 2);
  assert.equal(campaignCriticalRepairCost(6), 2);
  assert.equal(campaignCriticalRepairCost(4), 1);
});

test("campaign reinforcement costs follow Priority and triple for stations", () => {
  assert.equal(campaignReinforcementCost("skirmish", false), 6);
  assert.equal(campaignReinforcementCost("war", true), 90);
});
