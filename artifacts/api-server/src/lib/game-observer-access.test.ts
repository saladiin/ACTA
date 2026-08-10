import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveGameViewerRole,
  observerSeatAvailable,
  viewerRoleHasFullGameState,
} from "./game-observer-access";

const activeGame = {
  challengerId: "challenger",
  opponentId: "opponent",
  status: "active",
  allowObservers: true,
};

test("participants keep their player roles", () => {
  assert.equal(resolveGameViewerRole(activeGame, "challenger", {
    isAdmin: false,
    isObserverMember: false,
  }), "challenger");
  assert.equal(resolveGameViewerRole(activeGame, "opponent", {
    isAdmin: false,
    isObserverMember: false,
  }), "opponent");
});

test("observer membership grants full read-only state", () => {
  const role = resolveGameViewerRole(activeGame, "viewer", {
    isAdmin: false,
    isObserverMember: true,
  });
  assert.equal(role, "observer");
  assert.equal(viewerRoleHasFullGameState(role!), true);
});

test("eligible viewers get metadata until they explicitly observe", () => {
  const role = resolveGameViewerRole(activeGame, "viewer", {
    isAdmin: false,
    isObserverMember: false,
  });
  assert.equal(role, "eligible-observer");
  assert.equal(viewerRoleHasFullGameState(role!), false);
});

test("disabled observation denies non-participants", () => {
  assert.equal(resolveGameViewerRole(
    { ...activeGame, allowObservers: false },
    "viewer",
    { isAdmin: false, isObserverMember: true },
  ), null);
});

test("admin and development AI control remain distinct", () => {
  assert.equal(resolveGameViewerRole(activeGame, "admin", {
    isAdmin: true,
    isObserverMember: false,
  }), "admin-observer");
  assert.equal(resolveGameViewerRole(activeGame, "dev", {
    isAdmin: false,
    isObserverMember: false,
    controlsAiOpponent: true,
  }), "opponent");
});

test("observer seats are idempotent and capped at two", () => {
  assert.equal(observerSeatAvailable(0, false), true);
  assert.equal(observerSeatAvailable(1, false), true);
  assert.equal(observerSeatAvailable(2, false), false);
  assert.equal(observerSeatAvailable(2, true), true);
});
