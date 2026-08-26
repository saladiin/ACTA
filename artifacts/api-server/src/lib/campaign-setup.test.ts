import assert from "node:assert/strict";
import test from "node:test";
import {
  campaignCrewQualityFromTotal,
  generateCampaignSystem,
  rollStartingCrewQuality,
  validateCampaignStartingRoster,
} from "./campaign-setup";

function sequenceRandom(values: number[]) {
  let index = 0;
  return () => values[index++] ?? 0;
}

test("2E campaign Crew Quality table maps every 2d6 band", () => {
  assert.deepEqual(campaignCrewQualityFromTotal(2), { score: 2, label: "Civilian" });
  assert.deepEqual(campaignCrewQualityFromTotal(4), { score: 3, label: "Green" });
  assert.deepEqual(campaignCrewQualityFromTotal(8), { score: 4, label: "Military-Grade" });
  assert.deepEqual(campaignCrewQualityFromTotal(10), { score: 5, label: "Veteran" });
  assert.deepEqual(campaignCrewQualityFromTotal(12), { score: 6, label: "Elite" });
});

test("starting Crew Quality preserves both dice for audit", () => {
  const result = rollStartingCrewQuality(sequenceRandom([0, 0.999]));
  assert.deepEqual(result, {
    dice: [1, 6],
    total: 7,
    score: 4,
    label: "Military-Grade",
  });
});

test("starting roster enforces Battle-priority 10 FAP and completed CQ rolls", () => {
  const legal = validateCampaignStartingRoster([
    { id: 1, priorityLevel: "battle", crewQualityRoll: 7 },
    { id: 2, priorityLevel: "raid", crewQualityRoll: 9 },
  ]);
  assert.equal(legal.legal, true);
  assert.equal(legal.spentFap, 1.5);
  assert.equal(legal.remainingFap, 8.5);

  const overBudget = validateCampaignStartingRoster(
    Array.from({ length: 11 }, (_, index) => ({
      id: index + 1,
      priorityLevel: "battle",
      crewQualityRoll: index === 0 ? null : 7,
    })),
  );
  assert.equal(overBudget.legal, false);
  assert.match(overBudget.issues.join(" "), /exceeds 10 FAP/i);
  assert.match(overBudget.issues.join(" "), /Crew Quality/i);
});

test("campaign system generation follows target count, first-world, and Trade Route rules", () => {
  const generated = generateCampaignSystem(3, () => 0);
  assert.deepEqual(generated.targetCountDice, [1, 1]);
  assert.equal(generated.baseTargetCount, 6);
  assert.equal(generated.playerBonusTargets, 1);
  assert.equal(generated.strategicTargetCount, 7);
  assert.equal(generated.targets.length, 8);
  assert.equal(generated.targets[0].category, "settled-world");
  assert.equal(generated.targets[0].name, "Leisure World");
  assert.equal(generated.targets.at(-1)?.name, "Trade Route");
  assert.equal(generated.targets.at(-1)?.isTradeRoute, true);
});

test("ancient jump gates receive their mandatory extra unusual feature", () => {
  const values = [
    0, 0, // target count 2 -> six targets
    0, 0, // first Settled World subtype 2
    0.7, 0.7, // category 10 -> Outpost
    0, // Mining Outpost
    0.7, 0.5, // category 9 -> Jump Gate
    0.7, // Ancient Jump Gate
    0, 0, // mandatory unusual feature -> Space-Time Anomaly
  ];
  const generated = generateCampaignSystem(2, sequenceRandom(values));
  const ancientGate = generated.targets.find((target) => target.subtype === "ancient-jump-gate");
  assert.ok(ancientGate);
  assert.equal(ancientGate.unusualFeatures.length, 1);
  assert.equal(ancientGate.unusualFeatures[0].source, "ancient-jump-gate");
});
