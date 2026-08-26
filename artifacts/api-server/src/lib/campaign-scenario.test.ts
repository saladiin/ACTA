import assert from "node:assert/strict";
import test from "node:test";
import {
  campaignPriorityFromTotal,
  campaignScenarioFleetLimits,
  campaignScenarioFromTotal,
  campaignShipWasUsedThisTurn,
  resolveCampaignScenario,
  rollCampaignPriority,
  shipModelHasTwoFlights,
} from "./campaign-scenario";

function randomSequence(dice: number[]): () => number {
  let index = 0;
  return () => {
    const die = dice[index] ?? dice.at(-1) ?? 1;
    index += 1;
    return (die - 0.5) / 6;
  };
}

test("campaign scenario table maps every 2d6 result", () => {
  assert.equal(campaignScenarioFromTotal(2), "assassination");
  assert.equal(campaignScenarioFromTotal(5), "ambush");
  assert.equal(campaignScenarioFromTotal(7), "call-to-arms");
  assert.equal(campaignScenarioFromTotal(10), "carrier-clash");
  assert.equal(campaignScenarioFromTotal(11), "flee-to-jump-gate");
  assert.equal(campaignScenarioFromTotal(12), "supply-ships");
});

test("campaign scenario rerolls an illegal Carrier Clash", () => {
  const result = resolveCampaignScenario({
    target: { category: "settled-world", subtype: "industrial-world", name: "Industrial World" },
    attackerHasCarrier: false,
    defenderHasCarrier: true,
    random: randomSequence([5, 5, 3, 4]),
  });
  assert.equal(result.scenarioKey, "call-to-arms");
  assert.equal(result.rejectedRolls.length, 1);
  assert.equal(result.rejectedRolls[0].total, 10);
});

test("campaign scenario rerolls Flee to the Jump Gate away from a non-gate target", () => {
  const result = resolveCampaignScenario({
    target: { category: "dead-world", subtype: "barren-world", name: "Barren World" },
    attackerHasCarrier: true,
    defenderHasCarrier: true,
    random: randomSequence([5, 6, 6, 6]),
  });
  assert.equal(result.scenarioKey, "supply-ships");
  assert.equal(result.planetaryAssaultEligible, true);
  assert.equal(result.rejectedRolls[0].total, 11);
});

test("campaign priority applies both secret modifiers to the 2d6 roll", () => {
  const result = rollCampaignPriority({
    attackerModifier: 3,
    defenderModifier: -2,
    random: randomSequence([4, 4]),
  });
  assert.deepEqual(result.dice, [4, 4]);
  assert.equal(result.finalTotal, 9);
  assert.equal(result.priorityLevel, "battle");
  assert.equal(campaignPriorityFromTotal(4), "patrol");
  assert.equal(campaignPriorityFromTotal(11), "war");
});

test("campaign scenarios expose their asymmetric fleet limits", () => {
  assert.deepEqual(campaignScenarioFleetLimits("ambush"), { attacker: 3, defender: 5 });
  assert.deepEqual(campaignScenarioFleetLimits("blockade"), { attacker: 5, defender: 2 });
  assert.deepEqual(campaignScenarioFleetLimits("planetary-assault"), { attacker: 7, defender: 5 });
  assert.deepEqual(campaignScenarioFleetLimits("annihilation"), { attacker: 5, defender: 5 });
});

test("carrier and turn-use helpers recognize campaign eligibility", () => {
  assert.equal(shipModelHasTwoFlights("Aurora Starfury Flight (4)"), true);
  assert.equal(shipModelHasTwoFlights("Tiger Starfury Flight (1)"), false);
  assert.equal(shipModelHasTwoFlights(null), false);
  assert.equal(campaignShipWasUsedThisTurn(3, 3), true);
  assert.equal(campaignShipWasUsedThisTurn(2, 3), false);
});
