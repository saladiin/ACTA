import assert from "node:assert/strict";
import test from "node:test";
import { forcedMovementEndpointBeforeOverlap } from "./forced-movement";

const moving = { id: 1, x: 0, z: 0, baseRadiusInches: 1 };

test("compulsory movement stops at base contact instead of ending in an overlap", () => {
  const result = forcedMovementEndpointBeforeOverlap({
    moving,
    desired: { x: 5, z: 0 },
    blockers: [{ id: 2, x: 5, z: 0, baseRadiusInches: 1 }],
  });

  assert.equal(result.shortened, true);
  assert.deepEqual(result.blockedByUnitIds, [2]);
  assert.ok(Math.abs(result.x - 3) < 1e-6);
  assert.equal(result.z, 0);
});

test("compulsory movement may pass over a base when its endpoint is clear", () => {
  const result = forcedMovementEndpointBeforeOverlap({
    moving,
    desired: { x: 10, z: 0 },
    blockers: [{ id: 2, x: 5, z: 0, baseRadiusInches: 1 }],
  });

  assert.equal(result.shortened, false);
  assert.deepEqual(result.blockedByUnitIds, []);
  assert.equal(result.x, 10);
  assert.equal(result.z, 0);
});

test("an endpoint already at base contact remains unchanged", () => {
  const result = forcedMovementEndpointBeforeOverlap({
    moving,
    desired: { x: 3, z: 0 },
    blockers: [{ id: 2, x: 5, z: 0, baseRadiusInches: 1 }],
  });

  assert.equal(result.shortened, false);
  assert.equal(result.x, 3);
});
