# AI V2 Implementation Plan

Status: **DEFERRED - DO NOT START UNTIL DEPENDENCY REVIEW**

Review date: 2026-07-26

## Goal

Build an inspectable tactical AI that uses each ship's strengths, mitigates its
weaknesses, coordinates a fleet, and executes only through the same legal game
rules available to human players.

This plan is intentionally additive. It does not call for rewriting the shared
rules engine or replacing the current AI in one release.

## Non-Goals

- Do not give the AI hidden rules exceptions, altered dice, or stat bonuses.
- Do not change human-versus-human behavior as part of AI tuning.
- Do not encode unfinished game systems as permanent tactical assumptions.
- Do not use a machine-learning model for core legality or deterministic
  tactical execution.
- Do not require perfect play. The first target is coherent, explainable play.

## Proposed Module Boundaries

Create a dedicated server-side AI package:

```text
ai/
  doctrine.ts
  tactical-snapshot.ts
  expected-value.ts
  target-planner.ts
  movement-planner.ts
  firing-planner.ts
  action-planner.ts
  fleet-brain.ts
  executor.ts
```

### `doctrine.ts`

- Parse and validate `ai_doctrine`.
- Resolve canonical ship aliases.
- Derive secondary tags from structured traits and weapons.
- Fall back to the current `ai_profile` only when explicitly permitted.
- Emit a warning and audit event for unassigned playable models.

### `tactical-snapshot.ts`

Build an immutable view of the information legally available to the AI:

- Game, round, phase, initiative, and active segment.
- Friendly and enemy units with current state.
- Legal movement constraints and remaining movement.
- Weapon readiness, arcs, ranges, and traits.
- Current criticals, damage, crew, shields, and defensive effects.
- Objectives, deployment zones, terrain, and jump points when implemented.
- Fighter missions, carrier capacity, and dogfights when implemented.
- Fleet-level intent from `games.ai_state`.

The snapshot must not mutate database records or advance the game.

### `expected-value.ts`

Provide pure calculations for:

- Chance to hit.
- Stealth gate probability.
- Interceptor attrition.
- Dodge and defensive rerolls.
- Shields and damage mitigation.
- Adaptive Armour.
- Double Damage, Triple Damage, Precise, AP, and Super AP.
- Expected hull and crew damage.
- Critical, cripple, skeleton-crew, and destruction probability.
- Slow-Loading and One-Shot opportunity cost.
- Regeneration or repair value.
- Projected incoming damage at a candidate position.

These functions should use the shared combat rules or shared pure helpers. They
must not create a second, divergent interpretation of the rules.

### `target-planner.ts`

- Rank strategic targets for the ship and fleet.
- Exclude destroyed, exploding, removed, or otherwise invalid targets through
  one shared eligibility function.
- Consider objective value, support role, vulnerability, threat, and existing
  damage reservations.
- De-prioritize fighters for capital-ship attacks when viable capital targets
  exist, except where fighter removal has greater tactical value.
- Keep strategic target choice distinct from weapon-by-weapon allocation.

### `movement-planner.ts`

- Enumerate server-legal maneuver candidates.
- Score final range, firing arcs, incoming arcs, board-edge risk, collisions,
  cohesion, objective value, and next-round geometry.
- Support multiple movement segments and turn timing.
- Plan at least one round ahead for boresight and ordnance ships.
- Reuse current collision and board-edge validation.
- Never apply movement to the live game while scoring candidates.

### `firing-planner.ts`

- Plan the complete legal firing package before the first attack is submitted.
- Allocate every usable weapon or deliberately record why it is held.
- Support multiple targets and Attack Dice splitting when the game rules layer
  supports them.
- Respect target nomination timing.
- Coordinate scout effects and target reservations.
- Replan after unexpected destruction, critical effects, or a stale target.

### `action-planner.ts`

- Compare legal special actions with ordinary movement and firing.
- Apply doctrine-specific action priorities.
- Treat All Stop and Pivot as strategic options, not merely emergency fallback.
- Refuse to consider actions whose underlying game mechanics are incomplete.

### `fleet-brain.ts`

- Set round-level intent.
- Assign focus targets, protected units, screens, fighter missions, objective
  jobs, and ordnance timing.
- Rank activation urgency.
- Coordinate without prescribing illegal unit-level actions.

### `executor.ts`

- Accept an immutable plan.
- Revalidate every command immediately before execution.
- Submit commands through existing server rule functions.
- Replan or safely end when the game state has changed.
- Write plan, result, and rejection details to the AI audit log.
- Never contain tactical scoring.

## Activation Plan

The planner should return one inspectable object:

```ts
type AiActivationPlan = {
  unitId: number;
  doctrine: ResolvedShipAiDoctrine;
  strategicTargetId?: number;
  specialAction?: SpecialActionId;
  maneuverSteps: PlannedManeuver[];
  weaponAllocations: PlannedWeaponAllocation[];
  fighterOrders: PlannedFighterOrder[];
  expectedOutcome: ExpectedOutcome;
  score: number;
  alternatives: ScoredAlternative[];
  rejectedReasons: RejectedOption[];
};
```

The plan should record whether a legal weapon was intentionally held, whether
an Attack Dice pool was split, and what state change would force replanning.

## Tactical Scoring

A candidate action can use a weighted utility model:

```text
score =
  expected damage
  + kill probability value
  + cripple probability value
  + objective progress
  + support contribution
  + future firing-arc value
  + formation value
  - expected incoming damage
  - exposure
  - board-edge risk
  - collision or congestion cost
  - special-action opportunity cost
  - ammunition and reload opportunity cost
```

Weights come from doctrine and difficulty, but every component should have a
named value in logs. Avoid a single opaque score that cannot be debugged.

## Fleet-Level State

Store small, serializable AI intent in a nullable `games.ai_state` object:

```ts
type FleetAiState = {
  posture: "setup" | "approach" | "engage" | "disengage" | "recover";
  focusTargetId?: number;
  protectedUnitIds: number[];
  anchorUnitId?: number;
  fighterMissions: FighterMission[];
  objectiveAssignments: ObjectiveAssignment[];
  committedOrdnance: DamageReservation[];
  targetReservations: DamageReservation[];
  lastPlannedRound: number;
};
```

This state is guidance, not a reservation lock. It must be rebuilt when units
are destroyed, objectives change, or a plan becomes impossible.

## Activation Ordering

Proposed movement priorities:

1. Units in immediate danger of losing a legal escape or firing lane.
2. Scouts or screens whose positioning enables the rest of the fleet.
3. Rigid or lumbering units that need predictable space.
4. Anchors and line ships.
5. Flexible flankers that benefit from seeing enemy commitment.

Proposed firing priorities:

1. A threatened friendly ship likely to be destroyed before it can fire.
2. Scout setup and Counter-Stealth needed for a planned salvo.
3. High-confidence cripple or kill conversion.
4. Slow-Loading or One-Shot salvo whose timing is important.
5. Flexible attacks that can safely wait.

These are utility inputs, not unconditional rules.

## Complete Firing Packages

The future firing planner should:

1. Enumerate every legal weapon and Attack Dice allocation.
2. Estimate defensive interactions for each target.
3. Build candidate packages with target reservations.
4. Compare concentrated damage, cripple conversion, split fire, and held
   ordnance.
5. Nominate all targets when strict rules timing requires it.
6. Execute one allocation at a time through existing attack commands.
7. Replan the remaining package if an early attack destroys or disables a
   target.

This is the highest-risk tactical feature because it combines multiple weapons,
Attack Dice splitting, Slow-Loading, One-Shot, target declaration, critical
effects, and mid-activation state changes.

## Difficulty Model

All levels use identical rules and legal-action enumeration.

| Difficulty lever | Easier | Harder |
| --- | --- | --- |
| Lookahead | Current activation | One or more future rounds |
| Candidate count | Sampled | Broad enumeration |
| Coordination | Loose | Fleet focus and reservations |
| Decision noise | Higher | Lower |
| Information memory | Short | Persistent legal knowledge |
| Time budget | Lower | Higher |

Do not alter dice, stats, hidden information, or legality.

## Delivery Sequence

No phase below begins until Phase 0 is approved.

### Phase 0: dependency and rules review

- Review every gate in
  [Dependencies And Deferred Backlog](DEPENDENCIES_AND_DEFERRED_BACKLOG.md).
- Freeze a shared legality contract for movement, attacks, traits, fighters,
  stations, boarding, terrain, objectives, and jump points.
- Identify which incomplete systems are excluded from the first AI V2 release.
- Approve feature flags, shadow mode, rollback, and performance budgets.

Deliverable: an implementation authorization record. No AI behavior change.

### Phase 1: doctrine data only

- Add typed doctrine definitions and nullable storage.
- Seed all live playable models.
- Validate aliases and roster completeness.
- Keep the current AI as the only acting implementation.

Deliverable: data and validation with zero tactical behavior change.

### Phase 2: tactical snapshot and expected value

- Extract immutable snapshots.
- Add pure defensive and attack-value calculations.
- Compare estimates against existing attack audit logs.
- Run in observation mode only.

Deliverable: deterministic calculations with no action execution.

### Phase 3: complete firing planner

- Plan all weapons and targets.
- Add target reservations.
- Integrate Attack Dice splitting after its human rules flow is complete.
- Execute behind an independent firing feature flag.

Deliverable: AI V2 firing while movement remains current AI.

### Phase 4: doctrine movement

- Add role-based range and arc scoring.
- Add future-geometry lookahead.
- Preserve existing legal movement and collision validation.
- Execute behind an independent movement feature flag.

Deliverable: AI V2 movement with one-setting fallback.

### Phase 5: special actions

- Add action comparison and tactical states.
- Enable only rules-complete actions.
- Record rejected actions and expected value.

Deliverable: deliberate, explainable special-action selection.

### Phase 6: fleet brain

- Add activation order, focus fire, screening, formations, and retreat.
- Persist minimal round intent.
- Add stale-plan and reservation recovery.

Deliverable: coordinated capital-ship play.

### Phase 7: scouts, carriers, and fighters

- Add scout sequencing.
- Add fighter launch, recovery, escort, dogfight, and strike missions.
- Integrate carrier capacity and fighter attack timing.

Deliverable: coordinated small-craft operations.

### Phase 8: fleet construction, deployment, and objectives

- Build faction-valid, role-balanced fleets.
- Deploy by role and scenario.
- Assign and revise objective jobs.

Deliverable: full-match strategic behavior.

### Phase 9: tuning and release

- Run seeded AI-versus-AI batches.
- Compare doctrine performance without tuning to a single matchup.
- Run human tester sessions.
- Promote flags gradually and retain the old AI for rollback.

Deliverable: an evidence-backed release recommendation.

## Test Strategy

### Pure unit tests

- Doctrine parsing and fallback.
- Roster completeness and alias uniqueness.
- Expected damage against every defensive trait.
- Target eligibility.
- Utility component calculations.
- Deterministic tie-breaking.

### Scenario tests

- Boresight ship avoids overshoot and retains a next-round lane.
- Broadside ship presents the stronger side.
- Scout acts before the salvo it enables.
- Carrier remains protected and does not chase.
- Ordnance ship does useful work during reload.
- Fighter striker avoids a bad dogfight.
- Station never enters ordinary movement planning.
- AI does not attack destroyed ships.
- Capital ships prefer viable capital targets over fighters except when fighter
  removal has greater tactical value.
- Mid-package destruction causes safe replanning.

### Regression simulations

- Fixed seeds and serialized starting states.
- Mirror matches for every faction and archetype.
- Unequal-force and damaged-start scenarios.
- Board-edge, congestion, and deployment-corner cases.
- Hundreds of AI-versus-AI matches before a default flag changes.

## Performance Budget

Initial target:

- Ordinary unit activation plan: 150 ms or less.
- Fleet-level replan: 500 ms or less.
- Hard timeout returns a legal conservative fallback, never a partial mutation.

Candidate generation should be bounded and measurable. Performance tuning must
not bypass legality checks.

## Observability

Each AI activation audit should include:

- Resolved doctrine and dynamic state.
- Fleet intent.
- Chosen strategic target.
- Special-action candidates and rejection reasons.
- Movement candidates with score components.
- Weapon allocation package and defensive assumptions.
- Selected plan, alternatives, and execution result.
- Replan reason when state changed.
- Planner duration and candidate count.
- Random seed and difficulty noise.

The log is essential for distinguishing a poor preference weight from a rules
bug or stale-state defect.

