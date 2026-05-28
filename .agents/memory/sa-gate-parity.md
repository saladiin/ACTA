---
name: Special Action UI/server gate parity
description: Every UI Special Action button must mirror the full server gate set in `/special-action` or it will appear enabled and 400 on click.
---

Server `/special-action` enforces a long list of gates: game.status, phase, activePlayerId, activeUnitId (movement SAs only), unit ownership, isDestroyed, specialAction-already-set, hasMovedThisRound / hasInitiatedMoveThisActivation (movement SAs), skeleton crew (crewPoints*2 ≤ maxCrewPoints), adrift damageState, and the noSA crit set (`reactor-gas-leak`, `reactor-explosion`, `crew-decompression`, `vital-bridge`). End-phase SAs additionally check `lastDcRound !== currentRound` and the player's `endPhase{Challenger,Opponent}Passed` flag.

**Why:** A button that only checks a subset shows enabled to the player but the click eats a 400. The movement-SA picker already mirrors these; end-phase SAs need the same mirror, with explicit disabled-reason text per gate.

**How to apply:** When adding a new SA button, copy the relevant gate checks from `/special-action` in `artifacts/api-server/src/routes/games.ts` and surface each as a distinct disabled-reason string in the button hint. Keep the noSA crit key set in lockstep with `critical-table.ts` and the existing `NO_SA_CRIT_KEYS` set in the movement panel.
