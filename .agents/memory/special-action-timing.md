---
name: Special Action timing convention
description: When/where Special Actions are declared in the B5:ACTA combat engine
---

# Special Action declaration timing

All Special Actions — **including All Hands on Deck** — are declared in the **Movement Phase**, during a ship's activation (must be the active unit, before any /move commits). There are no End-Phase-declared Special Actions.

**Why:** User's ACTA rule, confirmed explicitly: "all special actions are only selected in the movement phase." Originally All Hands on Deck was an End-Phase action; this was wrong and confusing (the user looked for it in the movement Special Actions list).

**How to apply:**
- `POST /special-action` (games.ts) gates every SA on `game.phase === "movement"` + active-unit + not-yet-moved. Do not reintroduce an `endPhaseActions` branch.
- An SA's *effect* may still be deferred to a later phase. All Hands on Deck: declared in movement, but its +2 DC bonus / lifted once-per-round DC cap resolve in the End Phase (read from `unit.specialAction === "all-hands-on-deck"` in `/damage-control`), and its cost (`oneWeaponThisRound`) bites the firing phase that follows.
- Frontend: SAs live in the movement `SPECIAL_ACTIONS` button list (game-board.tsx). The End-Phase crit panel only shows a read-only All Hands status chip, not a declaration button.
