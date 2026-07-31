import assert from "node:assert/strict";
import test from "node:test";
import {
  activeAncientStatusEffects,
  fixedCrewQualityForProfile,
  initiativeBonusForProfile,
  isProfileCrippled,
  profileStealthModifier,
  rulesProfileForModel,
  shadowMindScreamProfile,
  shadowTelepathicDisruptionBonus,
  shieldAbsorption,
  specialActionAllowedForProfile,
  unitIsPinned,
} from "./ancient-rules";

test("rules profiles use stored identity with a legacy faction fallback", () => {
  assert.equal(
    rulesProfileForModel({ rulesProfile: "shadows", faction: "Other" }),
    "shadows",
  );
  assert.equal(
    rulesProfileForModel({ rulesProfile: "standard", faction: "Vorlon Empire" }),
    "vorlons",
  );
  assert.equal(
    rulesProfileForModel({ rulesProfile: "standard", faction: "Kirishiac" }),
    "ancients",
  );
});

test("Ancient profile constants remain distinct by race", () => {
  assert.equal(initiativeBonusForProfile("shadows"), 6);
  assert.equal(initiativeBonusForProfile("vorlons"), 4);
  assert.equal(fixedCrewQualityForProfile("ancients"), 7);
  assert.equal(profileStealthModifier("ancients"), "ignore");
  assert.equal(profileStealthModifier("shadows"), "plus-one");
});

test("race Special Action whitelists reject standard-only actions", () => {
  assert.equal(specialActionAllowedForProfile("shadows", "run-silent"), true);
  assert.equal(specialActionAllowedForProfile("shadows", "track-that-target"), true);
  assert.equal(specialActionAllowedForProfile("shadows", "blast-doors"), false);
  assert.equal(specialActionAllowedForProfile("vorlons", "regenerate"), true);
  assert.equal(specialActionAllowedForProfile("vorlons", "track-that-target"), true);
  assert.equal(specialActionAllowedForProfile("ancients", "regenerate"), false);
  assert.equal(specialActionAllowedForProfile("ancients", "track-that-target"), true);
});

test("Shadow Mind Scream and telepathic bonuses follow vessel type", () => {
  assert.deepEqual(
    shadowMindScreamProfile("Shadow Scout"),
    { fixedCrewLoss: 1, dice: 0 },
  );
  assert.deepEqual(
    shadowMindScreamProfile("Shadow Stalker"),
    { fixedCrewLoss: 2, dice: 0 },
  );
  assert.deepEqual(
    shadowMindScreamProfile("Shadow Ship (Young)"),
    { fixedCrewLoss: 0, dice: 1 },
  );
  assert.deepEqual(
    shadowMindScreamProfile("Shadow Battlecrab"),
    { fixedCrewLoss: 0, dice: 2 },
  );
  assert.equal(shadowMindScreamProfile("Shadow Fighter Flight"), null);
  assert.equal(shadowTelepathicDisruptionBonus("Shadow Battlecrab"), 2);
  assert.equal(shadowTelepathicDisruptionBonus("Shadow Scout"), 0);
});

test("one shield point absorbs an entire multiplied hit", () => {
  assert.deepEqual(
    shieldAbsorption({
      remainingHits: 1,
      shieldsCurrent: 1,
      damageMultiplier: 4,
      bypassesShields: false,
    }),
    { remainingHits: 0, shieldsAfter: 0, shieldedHits: 1 },
  );
  assert.deepEqual(
    shieldAbsorption({
      remainingHits: 2,
      shieldsCurrent: 1,
      damageMultiplier: 3,
      bypassesShields: false,
    }),
    { remainingHits: 1, shieldsAfter: 0, shieldedHits: 1 },
  );
});

test("crippling remains latched after later hull repair", () => {
  const base = {
    maxHullPoints: 40,
    damageThreshold: 10,
    permanentlyCrippled: false,
    isDestroyed: false,
  };
  assert.equal(isProfileCrippled({ ...base, hullPoints: 10 }), true);
  assert.equal(
    isProfileCrippled({
      ...base,
      hullPoints: 35,
      permanentlyCrippled: true,
    }),
    true,
  );
  assert.equal(isProfileCrippled({ ...base, hullPoints: 35 }), false);
});

test("disruption persists through its expiry round and releases with its source", () => {
  const effects = [{
    kind: "physical-disruption" as const,
    sourceUnitId: 7,
    appliedRound: 2,
    expiresAfterRound: 3,
    releaseWhenSourceDestroyed: true,
  }];
  assert.equal(unitIsPinned(effects, 3), true);
  assert.equal(unitIsPinned(effects, 4), false);
  assert.equal(unitIsPinned(effects, 3, new Set([7])), false);
  assert.deepEqual(activeAncientStatusEffects(effects, 3), effects);
});
