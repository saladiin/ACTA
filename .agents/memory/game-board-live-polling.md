---
name: Game board live polling (opponent sync)
description: How the game board live-syncs opponent moves, and the React Query pause gotcha around the dice modal
---

The game board is async/turn-based but live-syncs an opponent's actions via React Query polling on the `useGetGame` query (`refetchInterval`), not WebSockets/SSE. Polling only runs while `game.status` is `pending`/`deploying`/`active` and is paused during the staged dice-roll modal.

**Why polling, not push:** chosen as the cheap 80/20 for a turn-based wargame; SSE (with Postgres LISTEN/NOTIFY for multi-instance fan-out) is the documented next step if instant updates are ever needed.

**Gotcha — pausing `refetchInterval` is NOT enough to freeze state during a modal.** Returning `false` from `refetchInterval` only stops *scheduling future* polls; a fetch already in flight when the modal opens will still resolve and overwrite the cache mid dice-reveal. To truly freeze, on modal-open you must also `qc.cancelQueries({ queryKey })` to abort the outstanding fetch. The dice flow already defers its own mutation invalidation until the modal closes, so cancel-on-open + interval-pause together cover it.

**How to apply:** any time you add background refetch/polling to a screen that has a staged, multi-step reveal or other state the user is stepping through, gate BOTH the interval (pause flag) AND cancel in-flight queries on entry. Also reset transient local UI (e.g. `movePlan` move preview) when authoritative context changes (e.g. `isMyActivation` flips false) so a poll-driven turn advance can't leave a stale ghost preview.
