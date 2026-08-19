import assert from "node:assert/strict";
import test from "node:test";
import { mastersOfDestructionCriticalMultiplier } from "./dilgar-rules";

test("Dilgar bolter criticals use the complete Triple Damage multiplier", () => {
  assert.equal(
    mastersOfDestructionCriticalMultiplier({
      attackerFaction: "Dilgar Imperium",
      weaponName: "Heavy Bolters",
      defaultMultiplier: 2,
    }),
    3,
  );
});

test("Dilgar pulsar criticals use the complete Double Damage multiplier", () => {
  assert.equal(
    mastersOfDestructionCriticalMultiplier({
      attackerFaction: "Dilgar Imperium",
      weaponName: "Light Pulsars",
      defaultMultiplier: 1,
    }),
    2,
  );
});

test("Masters of Destruction does not affect missiles or other factions", () => {
  assert.equal(
    mastersOfDestructionCriticalMultiplier({
      attackerFaction: "Dilgar Imperium",
      weaponName: "Anti-Ship Missiles",
      defaultMultiplier: 2,
    }),
    2,
  );
  assert.equal(
    mastersOfDestructionCriticalMultiplier({
      attackerFaction: "Narn Regime",
      weaponName: "Heavy Bolters",
      defaultMultiplier: 2,
    }),
    2,
  );
});
