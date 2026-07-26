# Dependencies And Deferred Backlog

Status: **BLOCKING DESIGN CHECKLIST**

Review date: 2026-07-26

## Why AI V2 Is Deferred

Several large systems are still being added or hardened. AI built before those
rules settle would learn tactics around temporary omissions, require duplicate
special cases, and make it harder to tell whether a failure belongs to the AI
or the game engine.

This document does not claim every item is wholly absent. Status must be
verified against the current build before AI V2 begins.

## Dependency Gates

| System | Current planning status | Required evidence before AI integration |
| --- | --- | --- |
| Core movement rules | Verify and harden | Server-authoritative legal-action API; cumulative movement, turns, overlap, adrift, Agile, Super Maneuverable, and special actions covered by tests. |
| Complete firing declaration | Incomplete/verify | Multiweapon activation, legal target declaration, multiple targets, and Attack Dice splitting stable for human play. |
| Weapon and defense traits | Verify completeness | Shared expected-value helpers or test vectors for Stealth, Interceptors, Shields, Dodge, Adaptive Armour, AP/Super AP, Precise, reloads, and damage multipliers. |
| Special actions | Verify completeness | Each AI-supported action has server validation, effects, timing, and tests. Unsupported actions are explicitly excluded. |
| Boarding | Planned major system | Legal approach, troops, opposed resolution, Ancient exceptions, stations, and post-boarding state defined. |
| Space stations | Planned major system | Immobile activation, damage thresholds, modules, criticals, attacks, LOS blocking, boarding, and destruction complete. |
| Fighters and carriers | Partial/verify | Attack timing, dogfights, Anti-Fighter, interceptor support, launch, recovery, carrier capacity, and Fleet Carrier complete. |
| Jump points and jump engines | Planned/verify | Entry, exit, placement, timing, movement, VFX state, and legal ship interactions complete. |
| Scenarios and objectives | Planned/verify | Structured objectives, scoring, deployment constraints, and match-end conditions exposed to the planner. |
| Terrain and line of sight | In progress/verify | Authoritative obstruction, terrain effects, legal pathing, and threat calculations available. |
| Fleet construction | Partial/verify | Faction legality, priority allocation, composition limits, stations, fighters, and templates stable. |
| Deployment | Partial/verify | Role-aware but rules-authoritative legal placement API, deployment zones, collision, and station exceptions. |
| Damage and critical state | Verify completeness | Crippled, skeleton crew, destroyed, exploding, adrift, repairs, arc loss, and speed effects represented consistently. |
| Deterministic RNG | Required infrastructure | Seeded simulations reproduce plans and combat outcomes where intended. |
| Attack and movement audits | Present, expand | Complete records for legal inputs, rolls, modifiers, state changes, AI plan IDs, and rejection reasons. |

## Gate Review Method

For each dependency:

1. Identify the authoritative server function.
2. List supported rules and explicit exclusions.
3. Add or locate deterministic tests.
4. Confirm the client cannot create a different legality result.
5. Expose a pure legal-option or evaluation interface to the AI.
6. Mark the system supported, excluded, or blocking for the first AI V2 scope.

An incomplete system may be excluded from the first AI V2 release if doing so
does not produce illegal or misleading behavior. For example, station doctrine
can remain on V1 while capital-ship firing V2 is tested.

## Integration Consequences

### Boarding

Boarding will affect:

- Target value and vulnerability.
- T'Loth and troop-heavy ship doctrine.
- Range and facing preferences.
- Carrier or shuttle support.
- Ancient-specific boarding restrictions.
- Station capture and defense.

Do not tune boarding-minded ships until the rules flow exists. Preserve
boarding traits in doctrine as future intent only.

### Stations

Stations require a separate activation model. Ordinary movement scoring must
never be used as a fallback. Station AI needs:

- Threat-sector analysis.
- Multiple target handling.
- Slow-Loading salvo timing.
- Special defensive thresholds and criticals.
- Module and core state.
- Objective and boarding pressure.

### Fighters and carriers

Carrier doctrine is incomplete without fighter missions. The fleet brain must
eventually distinguish:

- Fighter superiority.
- Escort and screen.
- Anti-ship strike.
- Interception.
- Launch, recovery, and replenishment.

Capital targeting policy must still keep fighters at lowest priority when
viable capital targets exist unless the fighter threat creates a documented
override.

### Jump points

Jump behavior changes deployment, reinforcement timing, escape, and board-edge
assumptions. AI requires legal placement candidates and an understanding of
entry versus exit orientation before it can value jump actions.

### Objectives and scenarios

Without structured objectives, damage dominates utility and every doctrine
drifts toward annihilation play. Objective state must be available in the
tactical snapshot before claiming strategic AI.

### Terrain and line of sight

Movement and attack scoring must use the same terrain and LOS rules as the
server. Approximate client geometry is not sufficient for AI planning.

### Attack Dice splitting

The user has explicitly chosen to implement Attack Dice splitting while
leaving some broader target and arc limitations as current taste decisions.
The future firing planner must consume the implemented declaration model; it
must not invent its own split-fire flow.

## Deferred AI Backlog

The following work remains design-only:

- Typed per-ship doctrines.
- Tactical snapshots.
- Defensive expected-value calculations.
- Complete multiweapon firing packages.
- Attack Dice split planning.
- Role-based movement and one-round lookahead.
- Deliberate special actions.
- Fleet focus and activation order.
- Scout coordination.
- Carrier and fighter missions.
- Formation, screen, and escort behavior.
- Objective assignments.
- Faction-valid fleet construction.
- Role-aware deployment.
- AI difficulty settings.
- Shadow mode and plan comparison.
- Seeded simulation harness.

## Resume Checklist

AI V2 planning may be reopened when:

- The intended first-release rules scope is written down.
- Blocking systems above are complete or explicitly excluded.
- Human movement and firing audits show stable authoritative behavior.
- Attack Dice splitting is stable in human play.
- Feature flags and one-setting rollback are approved.
- A seeded scenario harness exists.
- The live roster has a canonical model list and alias map.
- Performance budgets are accepted.
- Someone is assigned to review tactical logs rather than only win/loss rates.

Passing this checklist authorizes implementation planning, not automatic
deployment.

## Related Working Documents

- `docs/INTERNAL_IMPLEMENTATION_GAPS.md`
- `docs/SPACE_STATIONS_IMPLEMENTATION_PLAN.md`
- `docs/TERRAIN_LOS_IMPLEMENTATION_PREP.md`
- `docs/ANCIENTS_RULES_AUDIT.md`
- `docs/ACTA_RULES_CODE_REFERENCE.md`

Those documents remain authoritative for their systems. This AI package should
link to them rather than duplicating detailed rule interpretations.

