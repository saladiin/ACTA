import assert from "node:assert/strict";
import test from "node:test";
import {
  campaignChallengeOrder,
  campaignInitiativeTotal,
  resolveCampaignInitiative,
} from "./campaign-turn";

function sequenceRandom(values: number[]) {
  let index = 0;
  return () => values[index++] ?? 0;
}

test("campaign initiative applies fleet modifier and held-target penalty", () => {
  assert.equal(campaignInitiativeTotal({
    playerId: "alpha",
    dice: [5, 4],
    fleetModifier: 2,
    targetPenalty: -3,
  }), 8);
});

test("campaign initiative rerolls every tied commander until totals are unique", () => {
  const result = resolveCampaignInitiative([
    { playerId: "alpha", dice: [3, 3], fleetModifier: 0, targetPenalty: 0 },
    { playerId: "bravo", dice: [4, 2], fleetModifier: 0, targetPenalty: 0 },
    { playerId: "charlie", dice: [5, 3], fleetModifier: 0, targetPenalty: 0 },
  ], sequenceRandom([
    0.999, 0.999, // alpha rerolls 12
    0, 0, // bravo rerolls 2
  ]));

  assert.deepEqual(result.map((entry) => [entry.playerId, entry.finalTotal]), [
    ["alpha", 12],
    ["charlie", 8],
    ["bravo", 2],
  ]);
  assert.deepEqual(result.find((entry) => entry.playerId === "alpha")?.rerolls, [
    { dice: [6, 6], total: 12 },
  ]);
});

test("campaign initiative rerolls a new tie created against a previously untied commander", () => {
  const result = resolveCampaignInitiative([
    { playerId: "alpha", dice: [3, 3], fleetModifier: 0, targetPenalty: 0 },
    { playerId: "bravo", dice: [4, 2], fleetModifier: 0, targetPenalty: 0 },
    { playerId: "charlie", dice: [5, 3], fleetModifier: 0, targetPenalty: 0 },
  ], sequenceRandom([
    0.5, 0.5, // alpha rerolls 8
    0, 0, // bravo rerolls 2
    0.999, 0.999, // alpha rerolls new tie to 12
    0.3, 0.3, // charlie rerolls new tie to 4
  ]));

  assert.deepEqual(result.map((entry) => [entry.playerId, entry.finalTotal]), [
    ["alpha", 12],
    ["charlie", 4],
    ["bravo", 2],
  ]);
  assert.equal(result.find((entry) => entry.playerId === "charlie")?.rerolls.length, 1);
});

test("neutral target challenges proceed from the next commander and wrap", () => {
  assert.deepEqual(
    campaignChallengeOrder(["alpha", "bravo", "charlie", "delta"], "charlie"),
    ["delta", "alpha", "bravo"],
  );
});
