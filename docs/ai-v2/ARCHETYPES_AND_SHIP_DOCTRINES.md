# Archetypes And Ship Doctrines

Status: **PROPOSED DESIGN - DEFERRED**

Review date: 2026-07-26

## Objective

The AI should understand what a ship is trying to accomplish, not merely
whether it is a brawler or standoff unit. A doctrine combines a primary
archetype with secondary tags, preferred geometry, target priorities, risk
tolerance, and special-action policy.

Doctrine is a preference layer. It does not override ship stats, damaged
systems, weapon readiness, objectives, or rules legality.

## Proposed Data Shape

The existing `ship_models.ai_profile` should remain during migration as a
compatibility fallback. Add a nullable, typed `ai_doctrine` JSONB field:

```ts
type ShipAiDoctrine = {
  primaryRole: AiArchetype;
  secondaryTags: AiTag[];
  preferredRange: [number, number];
  preferredArcs: WeaponArc[];
  aggression: number;
  riskTolerance: number;
  cohesion: number;
  retreatHullRatio: number;
  targetWeights: TargetWeights;
  actionPriorities: SpecialActionPolicy;
};
```

Recommended normalized ranges for numeric temperament values are `0..1`.
Doctrine defaults must be explicit and validated at startup. An unknown model
may fall back to the old profile, but validation should make that visible in
logs and tests rather than silently assigning `brawler`.

## Secondary Tags

Tags describe tactical capabilities that can overlap primary roles:

- `boresight`
- `broadside`
- `ordnance`
- `slow-loading`
- `one-shot`
- `scout`
- `carrier`
- `command`
- `escort`
- `interceptor-screen`
- `anti-fighter`
- `anti-capital`
- `stealth`
- `regenerating`
- `agile`
- `lumbering`
- `boarding`
- `objective-holder`
- `mission-critical`
- `immobile`
- `ancient`

Tags should come from structured model and weapon data where possible. A ship
override should exist only when the tactical meaning cannot be derived cleanly.

## Archetype Rules

### 1. Apex Hunter

Purpose: destroy the enemy's highest-value combat threat while denying
concentrated retaliation.

Behavior:

- Choose prey by threat, vulnerability, and strategic value rather than pure
  distance.
- Favor attack geometry that preserves regeneration and escape options.
- Avoid crossing multiple hostile high-value arcs for a marginal attack.
- Continue pressure on crippled prey when the kill is efficient.
- Retreat or disengage later than ordinary ships, but not suicidally.

Assignments:

| Ship | Preferred range | Temperament | Notes |
| --- | --- | --- | --- |
| Shadow Battlecrab | 12-20 inches | Predatory | Hunt beam, command, and major ordnance threats; value regeneration windows. |
| Kirishiac Lordship | 14-20 inches | Relentless | Preserve powerful firing geometry; avoid unnecessary concentrated return fire. |

### 2. Boresight Lancer

Purpose: create and preserve high-value nose or boresight attacks.

Behavior:

- Plan heading one round ahead and avoid overshooting.
- Prefer moves that preserve a follow-up firing lane.
- Use Concentrate All Firepower when already aligned against a valuable target.
- Value activation timing that lets enemy movement reveal a lane.
- Treat turning room and board-edge risk as strategic resources.

Assignments:

| Ship | Preferred range | Temperament | Notes |
| --- | --- | --- | --- |
| Hyperion Heavy Cruiser | 10-18 inches | Balanced | Blend boresight beam pressure with secondary arcs. |
| Hyperion Command Cruiser | 10-18 inches | Protective | Preserve command utility while establishing beam lanes. |
| Hyperion Rail Cruiser | 8-12 inches | Aggressive | Close enough for railgun effectiveness without throwing away its approach. |
| Omega Destroyer | 18-26 inches | Deliberate | Long setup, powerful lane control, and high cost of a poor heading. |
| Orestes Battleship | 12-22 inches | Deliberate | Keep the heavy hull relevant while maximizing forward fire. |
| Thentus-class Frigate | 8-15 inches | Opportunistic | Use smaller footprint and flexibility to exploit available lanes. |

### 3. Broadside Line Ship

Purpose: keep the strongest side battery bearing while maintaining fleet
cohesion.

Behavior:

- Establish a parallel or crossing track instead of charging directly.
- Compare port and starboard future exposure before committing.
- Rotate a damaged or disabled side away from the enemy.
- Avoid turning both strong arcs out of the fight.
- Hold a line when doing so protects support ships.

Assignments:

| Ship | Preferred range | Temperament | Notes |
| --- | --- | --- | --- |
| Primus Battle Cruiser | 10-14 inches | Disciplined | Present strong side fire while retaining forward options. |
| Nova Dreadnought | 8-12 inches | Steadfast | Maximize dense broadside batteries and absorb pressure for the line. |

### 4. Close Assault Bruiser

Purpose: enter a favorable close engagement, overwhelm a weak arc, and finish
damaged targets.

Behavior:

- Approach through the target's weakest expected return-fire sector.
- Prefer cripple and kill conversions over spreading light damage.
- Use Close Blast Doors when focused and offense is unlikely to compensate for
  projected damage.
- Do not close inside useful range merely because movement remains.
- Distinguish durable bruisers from expendable patrol craft.

Assignments:

| Ship | Preferred range | Temperament | Notes |
| --- | --- | --- | --- |
| Hyperion Assault Cruiser | 6-10 inches | Aggressive | Commit after identifying a survivable approach. |
| Hyperion Pulse Cruiser | 8-12 inches | Assertive | Maintain dense pulse coverage without unnecessary contact range. |
| Tigara Attack Cruiser | 4-10 inches | Aggressive | Exploit speed and close fire; avoid unsupported frontal attrition. |
| Rongoth-class Destroyer | 6-10 inches | Tenacious | Pressure lighter targets and support the main line. |
| T'Loth Assault Cruiser | 8-12 inches | Boarding-minded | Preserve future boarding position when that system is implemented. |
| Tethys-class Cutter | 4-8 inches | Opportunistic | Trade only for worthwhile targets; use speed and low value deliberately. |

### 5. Ordnance Artillery

Purpose: convert range and reload cycles into coordinated high-value salvos.

Behavior:

- Prefer the longest effective range that maintains useful accuracy and arc.
- Coordinate Slow-Loading weapons so salvos create cripples or kills.
- Reposition, protect, or change targets during reload turns.
- Conserve One-Shot weapons for high-value or time-critical attacks.
- Favor clustered targets when using Energy Mines or similar area effects.

Assignments:

| Ship | Preferred range | Temperament | Notes |
| --- | --- | --- | --- |
| Hyperion Missile Cruiser | 18-30 inches | Cautious | Preserve missile range and avoid early close engagement. |
| Sagittarius Missile Cruiser | 22-30 inches | Cautious | Exploit full missile reach rather than using the generic 18-inch standoff point. |
| Olympus Corvette | 12-24 inches | Flexible | Support larger salvos while retaining room to screen or finish targets. |
| Bin'Tak-class Dreadnought | 18-25 inches | Methodical | Coordinate heavy fire and exploit durable staying power. |
| G'Quan Heavy Cruiser | 18-30 inches | Methodical | Use Energy Mines against valuable clusters and avoid wasteful rushes. |
| Var'Nic Long Range Destroyer | 18-30 inches | Mobile | Maintain long-range pressure while using mobility to protect firing lanes. |

### 6. Carrier And Command Anchor

Purpose: preserve fleet-enabling assets while keeping them close enough to
support the battle.

Behavior:

- Operate behind the main line or inside a protected formation pocket.
- Maintain relevant command, carrier, or support radii.
- Launch and recover fighters according to a fleet mission plan.
- Avoid chasing damaged enemies.
- Prioritize survival more highly than personal damage output.

Assignments:

| Ship | Preferred range | Temperament | Notes |
| --- | --- | --- | --- |
| Avenger Heavy Carrier | 8-12 inches | Protective | Its short weapons do not justify an arbitrary 18-inch standoff point; fighters are its primary contribution. |
| Explorer | 10-14 inches | Mission-critical | Stay behind escorts, preserve fighter and support capacity, and avoid close combat. |
| Psi Corps Mothership | 12-20 inches | Stealth-defensive | Use defensive positioning and Stealth while supporting Black Omega operations. |

### 7. Scout Controller

Purpose: multiply fleet damage and information while denying the enemy an easy
support kill.

Behavior:

- Coordinate the fleet's focus target before major salvos.
- Use Counter-Stealth when the expected fleet gain exceeds other scout work.
- Run Silent or disengage when exposed and no high-value scout action exists.
- Avoid occupying the same attack lane needed by heavier ships.
- Prefer survival over low-value personal attacks.

Assignments:

| Ship | Preferred range | Temperament | Notes |
| --- | --- | --- | --- |
| Corvan Scout | 10-16 inches | Cautious | Stay near enough to support but outside routine brawler range. |
| Oracle Scout Cruiser | 12-20 inches | Evasive | Coordinate attacks and use mobility to remain difficult to pin. |

### 8. Evasive Flanker

Purpose: attack weak arcs, create crossfire, and leave before attrition removes
the mobility advantage.

Behavior:

- Value flank access and low return-fire exposure over shortest distance.
- Use agility and speed to preserve future arcs.
- Disengage from unfavorable close fights.
- Threaten damaged support ships without abandoning the main battle entirely.

Assignments:

| Ship | Preferred range | Temperament | Notes |
| --- | --- | --- | --- |
| Vorchan Warship | 8-12 inches | Aggressive | Use Agile movement to create favorable attack geometry. |
| White Star | 10-18 inches | Daring | Exploit agility and weapon reach; do not default to a fragile 3-inch brawl. |

### 9. Generalist Line Ship

Purpose: maintain a coherent battle line and use the best combined weapon arcs
available in the current state.

Behavior:

- Stay close enough for mutual support without creating collisions.
- Rebalance preferred range from current weapon readiness.
- Shift damaged ships behind healthier line units.
- Accept objective duty when a specialist would be wasted on it.

Assignments:

| Ship | Preferred range | Temperament | Notes |
| --- | --- | --- | --- |
| Altarian-class Destroyer | 10-14 inches | Disciplined | Use balanced matter-cannon coverage and line support. |
| Sharlin War Cruiser | 18-30 inches | Stealthy | Preserve Stealth and long-range beam advantage; close only for a decisive reason. |
| Tinashi Warship | 15-22 inches | Mobile | Use mobility and range to reinforce weak sectors. |
| Avioki Heavy Cruiser | 12-18 inches | Stubborn | Hold useful combined arcs and absorb pressure without blind pursuit. |

### 10. Fortress

Purpose: control sectors and objectives without movement assumptions.

Behavior:

- Rank targets by immediate danger, objective pressure, and Slow-Loading
  opportunity.
- Reserve defenses and special actions for the most dangerous incoming attack.
- Avoid all movement-scoring concepts for an Immobile unit.
- Track threat by arc or sector even when weapons are Turret.

Assignment:

| Ship | Preferred range | Temperament | Notes |
| --- | --- | --- | --- |
| Orion Space Station | 15-45 inches | Methodical | Use missile reach and station defenses; implementation depends on station rules completion. |

### 11. Fighter Superiority And Screen

Purpose: win favorable dogfights, protect carriers and strike flights, and
intercept threats to capital ships.

Behavior:

- Enter dogfights only when modified odds and mission value justify it.
- Screen carriers, scouts, and anti-ship strike flights.
- Avoid wasting elite fighters on low-impact engagements.
- Recover or regroup when the carrier system and scenario permit it.

Assignments:

| Ship | Temperament | Notes |
| --- | --- | --- |
| Aurora Starfury Flight | Protective-aggressive | General fighter-superiority and escort duty. |
| Nial Heavy Fighter Flight | Predatory | Exploit strong dogfight capability and choose high-value enemy flights. |
| Black Omega Starfury Flight | Elite predator | Protect Psi Corps assets and eliminate dangerous enemy fighters. |
| Sentri Flight | Escort | Screen Centauri ships and tie down threatening flights. |
| Flyer Flight | Evasive escort | Protect Minbari assets while avoiding inefficient attrition. |
| Frazi Flight | Tenacious escort | Stay engaged when doing so protects Narn capital ships. |
| Tiger Starfury Flight | Defensive escort | Prioritize local protection and interception. |

### 12. Anti-Ship Strike Fighter

Purpose: avoid unfavorable fighter combat and deliver concentrated attacks
against capital ships.

Behavior:

- Use screens and approach vectors to avoid fighter-superiority units.
- Attack vulnerable or already-pressured capital targets.
- Coordinate with scout and fleet focus targets.
- Withdraw toward support after the strike when recovery exists.

Assignments:

| Ship | Preferred range | Temperament | Notes |
| --- | --- | --- | --- |
| Thunderbolt Starfury Flight | 2-4 inches | Aggressive | Deliver anti-ship attacks while avoiding needless dogfights. |
| Shadow Fighter | 1-2 inches | Assassin | Dogfight +0 makes routine fighter combat unattractive; exploit strong anti-capital attack. |

## Roster Completeness

This design snapshot assigns exactly 43 reviewed models:

- 2 Apex Hunters
- 6 Boresight Lancers
- 2 Broadside Line Ships
- 6 Close Assault Bruisers
- 6 Ordnance Artillery ships
- 3 Carrier/Command Anchors
- 2 Scout Controllers
- 2 Evasive Flankers
- 4 Generalist Line Ships
- 1 Fortress
- 7 Fighter Superiority/Screen flights
- 2 Anti-Ship Strike Fighter flights

Before implementation, compare this list against the live playable roster.
Aliases such as `-class` names must resolve to one canonical model rather than
creating duplicate doctrine rows. Any ship added after this audit requires an
explicit assignment and tests; it must not silently become a brawler.

## Special-Action Policies

Special actions should be selected by expected tactical value, subject to all
normal restrictions:

| Action | Proposed policy |
| --- | --- |
| Concentrate All Firepower | Use when a valuable target is already aligned and the offensive gain exceeds lost movement or targeting flexibility. |
| All Power to Engines | Use when no useful attack exists and the movement materially improves next-round range, arc, objective, or survival. |
| Close Blast Doors | Use when projected incoming damage threatens crippling or destruction and outgoing fire is unlikely to compensate. |
| Intensify Defensive Fire | Use under fighter or short-range saturation when its expected prevention exceeds offensive alternatives. |
| Run Silent | Use for an exposed scout, carrier, or support ship with no sufficiently valuable attack. |
| Scout coordination | Prepare the current fleet focus target before high-value salvos. |
| Counter-Stealth | Use before a planned salvo against a high-Stealth target when fleet-wide gain is meaningful. |
| Scramble Scramble | Launch when the fighter mission is defined and the carrier can do so without unacceptable risk. |
| All Stop / Pivot | Use as a deliberate positional or board-edge tool, not only as emergency fallback behavior. |

## Dynamic Overrides

Doctrine must yield to live state:

- A crippled lancer may become a survival or objective unit.
- A standoff ship with only short-range weapons remaining must recompute its
  useful range.
- A carrier with no available fighters may act as a support combatant.
- A scout that has lost scout capability should no longer be protected at the
  expense of a healthy combat ship.
- A regenerating Ancient at low hull may value temporary disengagement more
  than immediate damage.
- A station must never inherit ordinary movement behavior from a fallback.

These are state transitions, not new permanent archetypes.

