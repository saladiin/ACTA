import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveMovementTurnLimit,
  lumberingForwardMovementAllowed,
} from "./movement-rules";

test("Lumbering ships may move before turning but not after", () => {
  assert.equal(lumberingForwardMovementAllowed({ lumbering: true }, 0, 4), true);
  assert.equal(lumberingForwardMovementAllowed({ lumbering: true }, 1, 0), true);
  assert.equal(lumberingForwardMovementAllowed({ lumbering: true }, 1, 0.5), false);
  assert.equal(lumberingForwardMovementAllowed({ lumbering: false }, 1, 0.5), true);
});

test("Lumbering ships are capped at one turn under all modifiers", () => {
  assert.equal(effectiveMovementTurnLimit(1, { lumbering: true }), 1);
  assert.equal(effectiveMovementTurnLimit(2, { lumbering: true }), 1);
  assert.equal(effectiveMovementTurnLimit(3, { lumbering: false }), 3);
});
