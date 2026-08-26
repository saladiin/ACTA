import assert from "node:assert/strict";
import test from "node:test";
import {
  campaignRulesSnapshot,
  normalizeCampaignEngagementRules,
} from "./campaign-engagement";

test("campaign engagement rules normalize and clamp server-owned setup", () => {
  const result = normalizeCampaignEngagementRules({
    scenarioKey: "ambush",
    priorityLevel: "war",
    allocationPoints: 500,
    deploymentPreset: "ambush-center",
    deploymentDepth: 99,
    ambushCenterSide: "attacker",
    terrain: "gas-clouds",
    terrainCount: 6,
    stations: "enabled",
    skybox: "zhadum",
    specialConditions: "Defender must protect the convoy.\nNo reinforcements.",
  });

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.allocationPoints, 99);
  assert.equal(result.data.deploymentDepth, 30);
  assert.equal(result.data.terrainCount, 6);
  assert.deepEqual(result.data.specialConditions, [
    "Defender must protect the convoy.",
    "No reinforcements.",
  ]);
});

test("campaign engagement rules reject oversized briefing notes", () => {
  const result = normalizeCampaignEngagementRules({ specialConditions: "x".repeat(1201) });
  assert.deepEqual(result, {
    success: false,
    error: "Special conditions must be 1200 characters or fewer",
  });
});

test("campaign rules snapshot records locked setup and server enforcement boundary", () => {
  const normalized = normalizeCampaignEngagementRules({
    scenarioKey: "call-to-arms",
    priorityLevel: "raid",
    allocationPoints: 5,
  });
  assert.equal(normalized.success, true);
  if (!normalized.success) return;

  const snapshot = campaignRulesSnapshot(normalized.data, "2026-08-14T12:00:00.000Z");
  assert.equal(snapshot.scenario.label, "Call to Arms");
  assert.equal(snapshot.lockedAt, "2026-08-14T12:00:00.000Z");
  assert.equal(snapshot.battlefield.terrainPlacement, "automatic");
  assert.ok(snapshot.enforcedByServer.includes("campaign roster assignments"));
});
