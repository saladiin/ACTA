# Current AI Audit

Status: **REFERENCE SNAPSHOT - DO NOT TREAT AS IMPLEMENTATION AUTHORIZATION**

Audit date: 2026-07-26

## Scope

This audit records the state examined during the AI design discussion. Source
line numbers will drift, so references favor stable files and symbols.

Primary implementation:

- `artifacts/api-server/src/lib/ai-opponent.ts`
- `artifacts/api-server/src/routes/games.ts`
- Current ship-model records and `ship_models.ai_profile`
- Existing attack and movement audit logs

## Existing Foundation

The current AI is not empty or purely random. It already provides a useful
foundation:

- Legal movement candidates with board-edge and collision checks.
- Weapon range and arc checks.
- Basic weapon and target threat scoring.
- Exclusion of destroyed targets from normal firing.
- Capital-ship preference over fighters when capital targets are viable.
- Movement and attack audit records for post-match investigation.
- Five coarse movement/firing profiles:
  - `brawler`
  - `jouster`
  - `broadside`
  - `standoff`
  - `apex-predator`
- Special handling for the Shadow Battlecrab through `apex-predator`.
- Emergency All Stop and All Stop/Pivot behavior.

These pieces should be retained or adapted rather than discarded. In
particular, existing rule validation and audit logging are important safety
boundaries for any future planner.

## Profile Distribution

The local roster snapshot reviewed during this discussion contained 43 ship
models:

| Profile | Count |
| --- | ---: |
| `brawler` | 32 |
| `standoff` | 5 |
| `jouster` | 4 |
| `broadside` | 1 |
| `apex-predator` | 1 |

The distribution shows that most ships fall through to `brawler`, including
ships with very different battlefield jobs. The fallback is operationally
safe, but tactically flattening.

## Current Decision Pattern

### Movement

The ordinary path generally approaches the nearest viable enemy. The
`apex-predator` profile has a more strategic prey choice, but most ships do not
select a target based on fleet priority, vulnerability, objective value, or
weapon matchup.

Desired ranges are effectively hard-coded by profile:

| Profile | Approximate desired range |
| --- | ---: |
| `brawler` | 3 inches |
| `broadside` | 10 inches |
| `jouster` | 12 inches |
| `apex-predator` | 12 inches |
| `standoff` | 18 inches |

This is too coarse for ships whose useful range depends on a specific weapon,
reload state, damage state, target defense, or firing arc.

Movement evaluation is primarily one activation deep. It does not preserve a
multi-round approach, formation assignment, escort relationship, or objective
plan.

### Activation order

The AI generally activates the first eligible database unit. It does not rank
ships by tactical urgency, such as:

- A threatened ship that should fire before destruction.
- A scout that should prepare a fleet target.
- A flexible unit that should wait for enemy commitment.
- A damaged ship that must disengage.
- A carrier that should launch or recover fighters.

### Firing

The current AI evaluates eligible attacks, selects a weapon and target, fires,
and can then end the firing activation. This leaves multiweapon capital ships
unable to plan and resolve their full legal firing package intelligently.

Attack value does not comprehensively account for:

- Stealth success probability.
- Interceptor attrition.
- Shields.
- Dodge.
- Adaptive Armour.
- Regeneration and self-repair.
- Slow-Loading and One-Shot opportunity cost.
- Current critical effects and disabled arcs.
- Whether another friendly ship has already reserved enough damage to destroy
  the target.
- The value of crippling a target even when destruction is unlikely.

### Special actions

Special-action planning is largely absent apart from emergency positional
actions. The AI does not deliberately plan around:

- Concentrate All Firepower.
- All Power to Engines.
- Run Silent.
- Close Blast Doors.
- Intensify Defensive Fire.
- Scramble Scramble.
- Scout target coordination and Counter-Stealth.
- Fighter launch and recovery.
- Jump point and jump engine actions.

Some of these systems are incomplete in the game itself. AI should not receive
special-case shortcuts around missing rules.

### Fleet behavior

There is no persistent fleet-level intent for:

- Focus fire.
- Formation and cohesion.
- Screening or escorting.
- Carrier support.
- Fighter superiority versus anti-ship strike missions.
- Coordinated Slow-Loading salvos.
- Objective assignment.
- Protected support units.
- Retreat or disengagement.

Automatic fleet creation also favors the highest-priority affordable model
rather than composing a coherent faction fleet with complementary roles.

## Concrete Profile Mismatches

These examples motivated the doctrine design:

| Ship | Current tendency | Tactical mismatch |
| --- | --- | --- |
| Corvan Scout | `brawler` fallback | A support scout should preserve itself, coordinate attacks, and avoid close combat. |
| Explorer | `brawler` fallback | A mission-critical carrier/support hull should remain behind the battle line. |
| Sharlin | `brawler` fallback | Long-range beams and Stealth favor a controlled gunline, not a 3-inch rush. |
| G'Quan | `brawler` fallback | Long-range ordnance and Energy Mines favor standoff fire and target clustering. |
| Bin'Tak | `brawler` fallback | A heavy ordnance platform should time salvos and preserve useful range. |
| Avenger | `standoff` at about 18 inches | Its useful weapons are much shorter ranged; it should act as a protected carrier anchor. |
| Sagittarius | `standoff` at about 18 inches | Its missiles can exploit a substantially longer range band. |
| White Star | `brawler` fallback | A fragile, agile ship with an 18-inch weapon should flank and disengage rather than sit at 3 inches. |
| Shadow Fighter | `brawler` fallback | Dogfight +0 and strong anti-capital fire favor strike missions over routine dogfights. |
| Orion Space Station | `brawler` fallback | An immobile fortress needs threat-sector and ordnance logic, not movement doctrine. |

## Structural Concerns

Much of the AI flow is embedded in the large games route module. That makes
tactical changes harder to unit test and increases the chance that AI work
affects shared game behavior.

Future work should separate:

1. Tactical snapshot construction.
2. Legal option enumeration.
3. Expected-value calculations.
4. Doctrine scoring.
5. Fleet coordination.
6. Plan execution through existing rules.

The planner should be pure and read-only. Mutation belongs in a small executor
that uses the same validated command paths as a human player.

## Known Edge Risks

- Movement target filters and firing target filters are not perfectly
  identical, so pending wreck or noncombat-effective states need a common
  eligibility definition.
- Incoming-threat estimates omit some defenses and weapon readiness.
- AI can make a locally legal move that is strategically poor one round later.
- Fighter/capital firing segments can create stale active-unit assumptions.
- Multiweapon firing and future Attack Dice splitting greatly expand the
  action space.
- Planning against incomplete boarding, station, objective, terrain, fighter,
  or jump-point rules would encode temporary behavior as doctrine.

## Audit Conclusion

The present AI is adequate as a basic legal opponent and a compatibility
fallback. Its central weakness is not a single arithmetic bug; it is that
ship identity, whole-activation planning, and fleet intent are under-modeled.

The recommended path is an additive, feature-flagged AI V2 built after the
dependency gates are understood. An all-at-once replacement inside the current
route module is specifically not recommended.

