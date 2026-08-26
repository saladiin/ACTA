import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultWithdrawalPolicy,
  departureConsequenceForEdge,
  firstFootprintBoundaryCrossing,
  footprintInsidePlayArea,
  normalVictoryPoints,
  tacticalWithdrawalVictoryPoints,
  victoryPointsForDeparture,
} from "./play-area-exit-rules";

test("ACTA victory values follow scenario priority differences", () => {
  assert.equal(normalVictoryPoints("raid", "raid"), 10);
  assert.equal(normalVictoryPoints("war", "raid"), 30);
  assert.equal(normalVictoryPoints("patrol", "war"), 1);
  assert.equal(normalVictoryPoints("patrol", "ancient"), 0.5);
  assert.equal(tacticalWithdrawalVictoryPoints(0.5), 1);
  assert.equal(tacticalWithdrawalVictoryPoints(30), 8);
});

test("any part of a base crossing the play area finds the first edge", () => {
  assert.equal(footprintInsidePlayArea({ x: 23, z: 0, baseRadiusInches: 1 }), true);
  assert.equal(footprintInsidePlayArea({ x: 23.1, z: 0, baseRadiusInches: 1 }), false);
  const crossing = firstFootprintBoundaryCrossing({ x: 20, z: 0 }, { x: 25, z: 0 }, 1);
  assert.deepEqual(crossing, { edge: "starboard", t: 0.6, x: 23, z: 0 });
});

test("corner exits use the first boundary intersection", () => {
  const crossing = firstFootprintBoundaryCrossing({ x: 20, z: 30 }, { x: 25, z: 40 }, 1);
  assert.equal(crossing?.edge, "north");
  assert.equal(crossing?.z, 35);
});

test("default short-edge battles distinguish friendly, neutral, and hostile edges", () => {
  const policy = defaultWithdrawalPolicy(["alpha", "beta"]);
  const consequence = departureConsequenceForEdge(policy, "alpha", "north");
  assert.equal(consequence, "tactical-withdrawal");
  assert.equal(victoryPointsForDeparture(20, consequence), 5);
  assert.equal(departureConsequenceForEdge(policy, "alpha", "port"), "tactical-withdrawal");
  assert.equal(departureConsequenceForEdge(policy, "alpha", "south"), "full-victory-points");
  assert.equal(departureConsequenceForEdge(policy, "beta", "south"), "tactical-withdrawal");
});

test("hostile, objective, and forbidden scenario edges remain distinct", () => {
  const policy = defaultWithdrawalPolicy(["alpha", "beta"]);
  policy.neutralEdges = ["port"];
  policy.safeEdgesByOwner.alpha = ["south"];
  policy.safeEdgesByOwner.beta = [];
  policy.objectiveEdgesByOwner.alpha = ["north"];
  policy.forbiddenEdges = ["starboard"];
  assert.equal(departureConsequenceForEdge(policy, "alpha", "south"), "tactical-withdrawal");
  assert.equal(departureConsequenceForEdge(policy, "alpha", "north"), "objective-exit");
  assert.equal(departureConsequenceForEdge(policy, "alpha", "starboard"), "forbidden");
  assert.equal(departureConsequenceForEdge(policy, "alpha", "port"), "tactical-withdrawal");
  assert.equal(departureConsequenceForEdge(policy, "beta", "south"), "full-victory-points");
  policy.forbiddenOwners = ["beta"];
  assert.equal(departureConsequenceForEdge(policy, "beta", "port"), "forbidden");
});
