import assert from "node:assert/strict";
import test from "node:test";
import {
  clearSitePresenceForTests,
  listSitePresence,
  markSitePresence,
  SITE_PRESENCE_TIMEOUT_MS,
} from "./site-presence";

test.beforeEach(() => clearSitePresenceForTests());

test("site presence lists active players alphabetically without duplicating heartbeats", () => {
  markSitePresence("beta", "Zeta", 1_000);
  markSitePresence("alpha", "Aurora", 1_100);
  markSitePresence("beta", "Zeta Prime", 1_200);

  assert.deepEqual(listSitePresence(1_250), [
    { userId: "alpha", username: "Aurora", lastSeenAt: 1_100 },
    { userId: "beta", username: "Zeta Prime", lastSeenAt: 1_200 },
  ]);
});

test("site presence removes players after the activity window", () => {
  markSitePresence("active", "Active", 10_000);
  markSitePresence("stale", "Stale", 9_999);

  assert.deepEqual(
    listSitePresence(10_000 + SITE_PRESENCE_TIMEOUT_MS).map((entry) => entry.userId),
    ["active"],
  );
});
