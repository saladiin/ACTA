---
name: Deploy-path parity (b5acta)
description: The B5:ACTA api-server has two routes that move a game into the active state; they must initialize identical phase/round bookkeeping.
---

# Deploy paths must mirror each other

Two routes transition a B5:ACTA game from `deploying` → `active`:
the canonical `POST /games/:id/deploy` (once both players have placed
their fleets) and the dev-only `POST /games/:id/dev/skip-deploy`.

**Rule:** any new bookkeeping column added to the active-game lifecycle
(phase, initiative rolls, end-phase pass latches, round counters,
shields-current, etc.) **must be initialized in BOTH routes to the same
values**.

**Why:** skip-deploy is the primary path used in dev and E2E. When the
two paths drift, dev/test silently runs against a stale state machine
while real games run against the new one — bugs hide and false
confidence accumulates. This bit us on the Initiative/End phase work:
canonical deploy was updated to `phase: "initiative"` with
`activePlayerId: null`, but `dev/skip-deploy` kept seeding
`phase: "movement"` with the challenger pre-activated, completely
bypassing the initiative roll in dev.

**How to apply:** when touching either route's terminal `update(gamesTable).set({...})`,
diff its set-keys against the other route's set-keys. They should be
identical except for fields whose values are intentionally
path-specific (e.g. `opponentFleetId` comes from the request body in
one and is chosen by the dev tool in the other). Add a short comment
in each route pointing at its sibling so the link is discoverable.
