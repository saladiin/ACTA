# Boarding Implementation Prep

Status: implementation in progress. Ship-launched boarding has a first live
slice in code; Breaching Pod flights, station boarding, counterattacks, and
full boarding dice modal presentation remain follow-up work.

Primary sources checked:
- 2e core rules extract: `tmp/rules/acta_2007_core_rules_pages_2_46.txt`
- 2e FAQ extract: `tmp/rules/acta_2e_faq_extracted.txt`
- Powers and Principalities extract: `tmp/rules/acta_2e_powers_principalities_extracted.txt`
- Ancients reference/audit: `docs/reference/ACTA_Ancients_extracted.txt`,
  `docs/ANCIENTS_RULES_AUDIT.md`

## Confirmed Rules Shape

Boarding can start by either:
- Using the `Launch Breaching Pods and Shuttles!` special action.
- Moving Breaching Pod flights into base contact with an enemy ship or space
  station.

The special action is automatic, but only valid if the target:
- Is an enemy ship within 4 inches.
- Did not move more than half of its original Speed that turn.
- Is not attacked by any ship in the following Attack Phase.

Troops committed from a ship are deducted from that ship immediately. Surviving
troops do not return to the parent ship because they remain aboard the enemy to
secure it. Breaching Pods each carry one Troop and are removed after they unload.

Boarding combat resolves at the start of the End Phase:
- Defenders normally strike first.
- Surviving attackers strike back.
- This alternates until one side has no Troops remaining.
- Breaching Pod attackers strike before defenders.
- Combined boarding uses this order: Breaching Pod attackers, defenders, ship
  attackers.

If attackers defeat all defending Troops, later End Phases perform sabotage and
capture rolls while attackers remain unopposed.

The 2e FAQ changes the unopposed boarding result table for ships:
- 1: the rolling boarding party is killed.
- 2-5: damage equal to the die result.
- 6: random trait loss check.

Powers and Principalities has a similar but station-specific rule after station
Troops are defeated:
- 1: attacking Troop is lost to station crew/defences.
- 2-5: station takes damage equal to the die result.
- 6: station critical hit on the station critical table.

Captured ships do not become player-controllable warships during the battle.
They run adrift and count for enhanced victory rewards. Re-capturing a friendly
ship denies the enemy's bonus but does not create a new bonus for the original
owner.

Ancients are a hard exception:
- Ancient ships cannot board.
- Ancient ships cannot be boarded.
- Ancient ships have no Crew or Troops score.
- Do not infer this from `crewPoints === 0`; use an explicit rules gate.

## Current Code Baseline

Existing useful pieces:
- `ship_models.troops` exists in `lib/db/src/schema/shipModels.ts`.
- Fleet import/maintenance code carries troop values in
  `artifacts/api-server/src/lib/schema-maintenance.ts`.
- Critical table entries already flag troop losses:
  `artifacts/api-server/src/lib/critical-table.ts`.
- Game units already track crew, skeleton crew, adrift, destroyed, special
  actions, scout actions, carried fighters, and End Phase processing.

Implemented pieces:
- `game_units` has mutable `troopPoints` / `maxTroopPoints` state.
- Troop-loss critical flags reduce `troopPoints`.
- Ship-launched `Launch Breaching Pods and Shuttles!` declarations use the
  normal Special Action route.
- Boarding rows persist in `game_boarding_actions`.
- End Phase resolves ship-launched boarding combat and later unopposed ship
  sabotage/capture.
- Players can choose how many Troops to commit before confirming the action.
- Battle Log receives boarding declaration and resolution summaries through
  special-action audit logs.

Remaining pieces:
- Breaching Pod flights are not yet wired as distinct boarding-capable craft.
- Station boarding uses a later slice; ship-launched boarding against stations
  is still blocked.
- Counterattacks and recapture are not implemented.
- The full boarding dice/result modal is still pending; current visibility is
  Battle Log summary plus server audit payload.
- Board-state badges for `BOARDING`, `UNOPPOSED BOARDERS`, and `CAPTURED` are
  still pending.

## Recommended Data Model

Add mutable troop state to `game_units`:
- `troopPoints`: current onboard Troops.
- `maxTroopPoints`: printed Troops at deployment.

Deployment should copy `ship_models.troops` into both fields.

Add a persistent boarding table instead of overloading `game_state` JSON:
- `game_boarding_actions`
- Suggested fields:
  - `id`
  - `gameId`
  - `round`
  - `targetUnitId`
  - `attackerOwnerId`
  - `sourceUnitId` nullable for Breaching Pod source
  - `sourceFlightUnitId` nullable for pod flights
  - `troopsCommitted`
  - `troopsRemaining`
  - `deliveryType`: `ship`, `breaching-pod`, `counterattack`
  - `status`: `pending`, `fighting`, `unopposed`, `captured`, `failed`,
    `removed`
  - `createdPhase`
  - `resolvedRound`

Add target/capture state to `game_units`:
- `capturedByOwnerId` nullable.
- `surrenderedToOwnerId` nullable, for `Stand Down and Prepare to be Boarded!`
  later.
- `capturedRound` nullable.

Do not change `ownerId` on capture in the first implementation. Keeping original
ownership avoids breaking activation, victory checks, UI perspective, and
historical audit logs. Use explicit capture fields for scoring and display.

## Server Implementation Plan

1. Schema migration
- Add troop columns to `game_units`.
- Add boarding actions table.
- Regenerate DB/API types if required by the project workflow.

2. Deployment initialization
- Copy model Troops to deployed units.
- Ensure legacy units backfill to model troop values where possible.

3. Critical troop loss
- Apply `troopsLost` flags to `troopPoints`.
- Skeleton Crew currently says troops are halved in comments. Implement that
  as an effective value calculation for boarding, not a destructive mutation,
  unless the rules/source text requires permanent troop loss.

4. Special action declaration
- Add `launch-breaching-pods-and-shuttles` to recognized special actions.
- Validate:
  - Active ship owns at least one troop.
  - Target enemy exists, is deployed, is not destroyed, and is within 4 inches.
  - Target did not move more than half original Speed this turn.
  - Target is not Ancient/boarding immune.
  - Acting ship is not Ancient and is allowed to perform special actions.
- Let player choose how many Troops to commit, 1 to current available Troops.
- Deduct committed Troops immediately.
- Insert boarding rows.
- Mark the target as protected from regular attacks by ships for that Attack
  Phase. This can be represented by a per-round `boardingNoFireTargetIds`
  game-state entry or explicit table rows.

5. Breaching Pod support
- Add Breaching Pod as a craft/unit type with `breachingPod` trait.
- Treat it as fighter-like for movement/Anti-Fighter exposure, but not normal
  fighter combat.
- If it reaches base contact with ship/station and survives Anti-Fighter, create
  a boarding row with `deliveryType = breaching-pod`.
- Remove spent pod flights at the end of the End Phase.

6. End Phase resolver
- At the start of End Phase, gather all unresolved boarding actions.
- Resolve each target as a group:
  - Breaching Pod attackers strike first.
  - Defenders strike next.
  - Ship-launched attackers strike after defenders.
  - Repeat until one side reaches zero.
- Persist all dice results in audit logs and show them in the dice modal.
- If defenders win, close all attacker rows as failed/removed.
- If attackers win, mark surviving attacker rows as unopposed.

7. Unopposed sabotage/capture resolver
- On later End Phases, roll once per unopposed attacking Troop.
- Use the FAQ table for ships.
- Use the P&P station table for stations.
- If Crew reaches zero, set `damageState = adrift` and set capture fields.
- Do not let captured ships activate as new player-controlled ships.

8. Counterattack
- Allow friendly ships/Breaching Pods to board a captured/contested friendly
  ship.
- Enemy boarders aboard the ship strike first unless counterattack uses
  Breaching Pods.
- On success, remove enemy boarders and clear capture/contested state as rules
  require.

9. Stand Down later
- Keep this separate from physical boarding.
- It is an opposed Crew Quality special action against Crippled or Skeleton Crew
  targets within 10 inches, with friendly pressure requirements.
- Implement after base boarding is stable.

## Client/UI Plan

Movement/Special Action phase:
- Add a boarding special action button only when an eligible ship is active.
- On selection, highlight legal enemy targets within 4 inches.
- Show a compact modal:
  - target name
  - available Troops
  - committed Troops stepper
  - confirm/cancel
- If no legal targets exist, show a hint explaining why.

Attack Phase:
- If a target is under a no-fire boarding restriction, gray it out for ship
  attacks and show a hint: "Target is under boarding action this turn."

End Phase:
- At boarding resolution, show dice modal:
  - defender rolls
  - Breaching Pod attacker rolls
  - ship attacker rolls
  - losses
  - outcome
- Show board-state badges:
  - `BOARDING`
  - `UNOPPOSED BOARDERS`
  - `CAPTURED`

Battle log:
- Log declaration, troop commitment, target, rolls, losses, unopposed effects,
  capture, counterattack, and pod removal.

Admin/debug:
- Add boarding rows to game diagnostics.
- Include troop state in forced step bug reports.

## AI Plan

Initial safe AI behavior:
- AI does not initiate boarding unless explicitly enabled.
- AI will resolve mandatory boarding dice and counterattacks through the server
  resolver.
- AI should not get stuck if a boarding prompt exists; server auto-resolution
  must cover AI-controlled pending boarding steps.

Later AI behavior:
- Prefer boarding crippled/skeleton crew ships with high VP value.
- Avoid committing all Troops unless expected value is clearly favorable.
- Use Breaching Pods opportunistically against stations or troop-poor ships.

## Tests To Add

Server tests:
- Troops copy from ship model to game unit on deployment.
- Troop-loss critical reduces `troopPoints`.
- Ancient attacker cannot board.
- Ancient target cannot be boarded.
- Ship special action rejects out-of-range targets.
- Ship special action rejects targets that moved too far.
- Committed Troops are deducted immediately.
- End Phase defender-first boarding resolution works.
- Breaching Pod attacker-first resolution works.
- Combined pod/ship attack ordering works.
- FAQ unopposed ship table applies damage/trait-loss/killed-boarder outcomes.
- P&P station table applies station damage/critical/killed-boarder outcomes.
- Captured ship becomes adrift and does not transfer activation ownership.
- Counterattack can clear enemy boarders.

Client tests/manual checks:
- Legal target highlighting.
- Troop commit modal.
- No-fire attack hint.
- End Phase dice modal.
- Captured/boarding badges.
- AI-controlled boarding resolution does not stall.

## Open Decisions Before Coding

These are implementation choices, not rule disputes:
- Whether `Launch Breaching Pods and Shuttles!` should live in the same
  special-action route as movement-phase actions or get a dedicated
  boarding-specific route.
- How to represent no-fire restrictions cleanly for the following Attack Phase.
- Whether skeleton crew's "troops halved" should be rounded down and computed
  dynamically at boarding time.
- How detailed the first UI should be for multiple attackers against one target.
- Whether to implement Breaching Pods before or after ship-launched boarding.

Recommended first slice:
1. Add troop columns and troop critical mutation.
2. Add ship-launched boarding special action only.
3. Resolve boarding combat and unopposed ship sabotage/capture.
4. Add battle log/dice modal.
5. Add Breaching Pods and station-specific table after the ship path is stable.
