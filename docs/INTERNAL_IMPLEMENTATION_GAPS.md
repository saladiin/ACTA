# Internal Implementation Gaps

This is an internal working note for known or suspected gaps between the current web app and Babylon 5 ACTA 2E behavior. It is not player-facing copy.

Use this as a triage list for future implementation, QA, and public-alpha caveats. Some entries need rule confirmation before coding.

## Highest-Impact Gameplay Gaps

### Initiative modifiers

The app rolls initiative, but fleet/race initiative modifiers are not fully modeled.

Impact:
- Round tempo may differ from tabletop expectations.
- Faction/fleet identity is partly flattened.

Likely work:
- Add initiative modifier data to fleet/faction/model records.
- Apply it in initiative roll resolution.
- Show the modifier in the initiative UI and combat log.

### Movement enforcement

Movement exists, but full tabletop movement geometry is not fully server-authoritative.

Known/suspected gaps:
- Full turn-count and turn-angle timing needs stricter server validation.
- Final-position base overlap/stacking is enforced server-side.
- Some special-action movement restrictions may be split between client and server.
- Ramming is not implemented.

Impact:
- Honest players can play normally, but edge cases may permit illegal turn timing or special-action movement.

Likely work:
- Move all movement legality checks to the server as source of truth.
- Add server tests for minimum movement, turn timing, base overlap, fighters vs capital ships, All Stop, All Stop and Pivot, Come About, and adrift drift.

### Fighter system

Fighters are only partially represented.

Known gaps:
- Fighter attack timing before ships is not fully implemented.
- Dogfighting is not implemented.
- Anti-Fighter and Advanced Anti-Fighter are incomplete or not fully rules-faithful.
- Fighter interceptor support is not implemented.
- Carrier/Fleet Carrier interactions are missing.

Impact:
- Fleets that depend heavily on fighters are not yet tabletop-complete.

Likely work:
- Treat fighters as a dedicated unit mode with their own movement, attack timing, overlap, and recovery rules.
- Implement Anti-Fighter allocation/resolution and dogfight flow.
- Add Carrier and Fleet Carrier support.

### Multi-target and split-fire rules

The firing flow resolves one weapon against one target per request.

Known gaps:
- Splitting Attack Dice from one weapon across multiple targets is not implemented.
- Multi-target weapons and station-style Targets X behavior are not implemented.
- Beam target-splitting restrictions are not modeled beyond one weapon/one target.
- Exact arc-border assignment is not strict.
- Full "nominate all targets before rolling" tabletop timing is not implemented.

Impact:
- The app is easier to play, but not strict tournament timing.

Likely work:
- Add an attack declaration/staging step for all weapons and targets before dice resolution.
- Support split dice pools and multi-target weapon records.
- Decide whether strict declaration timing is worth the UX cost for public play.

## Damage And Critical Gaps

### Crippled and skeleton crew restrictions

Current behavior handles several crippled/skeleton effects, but not every general restriction is complete.

Known gaps:
- General crippled firing restrictions may not be fully enforced server-side.
- Skeleton crew firing restrictions may be partial.
- Command/Fleet Carrier/Admiral effects tied to crippled/skeleton states are not implemented.

Likely work:
- Centralize effective unit state calculation.
- Add tests for crippled and skeleton movement, special actions, firing limits, and trait loss.

### Critical stacking and repair nuance

Critical effects are persisted and repairable, but some stacking/timing details need review.

Known gaps:
- Similar critical effects such as speed loss may need highest-penalty handling rather than simple stacking.
- Weapon Attack Dice penalties may need confirmation on stacking vs highest-only behavior.
- Redundant Systems / Shadow-style critical repair timing may clear too early; 2E notes suggest repair after the turn they were inflicted.
- Troop loss from criticals is flagged but not fully stored/applied.
- Trait loss matching may be lossy for multi-word traits.

Likely work:
- Add a critical effect aggregator instead of ad hoc penalty sums.
- Store critical-applied round and timing explicitly.
- Add regression tests for redundant systems, speed loss, weapon penalties, and trait loss.

### Immediate explosion simplification

Immediate explosion exists, but is simplified.

Known gap:
- Current implementation uses a simplified area attack based on max hull, capped at 15 AD in a 4-inch range.

Likely work:
- Confirm exact 2E explosion dice/range/table behavior.
- Add tests around nearby ships, fighters, and terrain once implemented.

## Special Actions Not Yet Implemented

The current app implements a useful core set of Special Actions, but several rules either do not exist in the app yet or are only approximated. Server enforcement should be considered the priority; client UI should only expose legal choices after the server rules exist.

### Boarding action setup and boarding resolution

Status: not implemented.

Missing behavior:
- Declaring boarding intent at the correct timing.
- Movement/contact requirements for boarding.
- Troop combat in the End Phase.
- Surrender, capture, damage, or ongoing contested-boarding states.
- Interaction with skeleton crew, derelict ships, troop losses, and ships that cannot be boarded.

Dependencies:
- Troop state must become first-class runtime data, not just a ship profile value.
- Boarding target validation must account for Ancient/boarding-immune units, stations, civilian/scenario objects, and future terrain.

Implementation shape:
- Add a `boardingState` or boarding table keyed by game/unit.
- Add server routes for declaring boarding and resolving troop combat.
- Add End Phase UI for boarding resolution.
- Add audit log entries because boarding outcomes can be complex and disputed.

Tests:
- Cannot board invalid targets.
- Boarding declaration imposes the correct movement/firing restrictions.
- Troop losses persist.
- Capture/surrender outcomes update ownership or unit status correctly.

### Stand Down and Prepare to be Boarded

Status: not implemented as a tactical action.

Current app note:
- The game has concede/surrender-style game-level behavior, but not a ship-level tactical Stand Down action.

Missing behavior:
- Ship-level declaration.
- Restrictions imposed after declaration.
- Interaction with boarding attempts and surrender/capture outcomes.

Implementation shape:
- Treat this separately from player concede.
- Store on the unit as a special tactical state.
- Validate whether it is declared voluntarily, forced by a rule, or tied to boarding.

### Launch Fighters

Status: not implemented as a Special Action.

Current app note:
- Fighter-like units and Anti-Fighter UI exist in some form, but carrier launch/recovery is not a complete system.

Missing behavior:
- Launching carried craft from ships.
- Recovery timing and restrictions.
- Hangar/craft capacity tracking.
- Whether launched fighters enter as units immediately or as a staged deployment.
- Interaction with damage, crippled/skeleton crew, carrier traits, and jump/hyperspace restrictions.

Implementation shape:
- Add carried-craft inventory to runtime game state.
- Add a launch/recover route.
- Add UI for selecting which flight to launch and where it may be placed.
- Add End Phase recovery handling if required.

Tests:
- Cannot launch more craft than carried.
- Destroyed/crippled/ineligible carriers cannot launch when rules forbid it.
- Recovered fighters are removed from the board and restored to carried inventory if applicable.

### Jump Point / hyperspace actions

Status: not implemented.

Missing behavior:
- Hyperspace state for ships.
- Jump point entities on the board.
- Entry/exit timing.
- Advanced Jump Engine differences.
- Movement, turning, launch, and Special Action restrictions while opening or using jump points.

Dependencies:
- Board entity system beyond normal ships.
- Deployment/reinforcement style UI for ships entering from hyperspace.

Implementation shape:
- Add `hyperspace` or `offBoardState` fields for units.
- Add jump point board objects with owner, position, round, and lifecycle.
- Add special action routes for opening/using jump points.

Risk:
- This is a large subsystem. It should not be added as a one-off button because it affects movement, targeting, deployment, and scenario rules.

### Give Me Ramming Speed

Status: not implemented.

Missing behavior:
- Declaration timing and Crew Quality checks.
- Different eligibility for crippled vs non-crippled ships.
- Opposed Crew Quality check to hit, with exceptions for adrift/immobile targets.
- Super Maneuverable defensive bonus.
- Fighter exclusion.
- Damage resolution for both rammer and target.

Dependencies:
- Server-authoritative movement/contact detection.
- Final-position overlap/contact validation.
- Explosion/damage sequencing clarity.

Implementation shape:
- Build after movement validation is tightened.
- Use a dedicated resolution route rather than overloading normal movement.

### Manoeuvre to Shield Them

Status: not implemented.

Missing behavior:
- A ship declares itself as a shielding/interposing unit.
- Firing-line or near-line checks determine whether it can interfere with shots.
- Attacker may be forced or prompted to resolve against the shielding ship depending on the rule.

Dependencies:
- Reliable line-of-fire geometry.
- Clear UI showing which shots are affected.
- Server validation against base positions and ship sizes.

Implementation shape:
- Add a special-action state to the shielding unit.
- During target validation, check whether the line from attacker to target passes close enough to the shielding unit.
- Return a structured response to the client explaining the forced/proposed target change.

### Track That Target

Status: not implemented.

Missing behavior:
- Pre-selecting a target for Boresight/Boresight Aft weapons.
- Allowing a later shot if the selected target is in the relevant broad arc/timing window.
- Clearing the tracked target at the correct time.

Dependencies:
- Attack declaration/staging improvements.
- Better UI for target locks that are not immediate attacks.

Implementation shape:
- Store `trackedTargetUnitId`, weapon id, arc type, and round on the firing unit.
- Check the stored target during firing-phase weapon legality.
- Add board visualization for tracked target relationship.

### Existing Special Actions needing verification

These are present, but still need explicit server tests and rule confirmation.

All Power to Engines:
- Verify speed bonus calculation.
- Verify turn restrictions and firing restrictions.
- Confirm whether damage states alter eligibility.

All Stop:
- Verify minimum-move exemption.
- Verify firing and Dodge interactions.
- Verify interactions with movement already committed this activation.

All Stop and Pivot:
- Verify pivot amount and timing.
- Verify no normal movement is possible after pivot.
- Verify Dodge/standing-still interactions.

Close Blast Doors:
- Verify exact timing in the damage pipeline.
- Verify interaction with critical damage and damage multipliers.
- Verify whether it applies per attack, per hit, or per activation as intended.

Come About variants:
- Verify client and server apply the same extra-turn/sharp-turn restrictions.
- Verify Lumbering restrictions.
- Verify failures still impose any required consequences.

Run Silent:
- Verify speed cap, no-turn, and no-fire restrictions.
- Verify Stealth interaction and when the benefit expires.
- Verify whether Scouts or specific weapons bypass or alter the effect.

Concentrate All Fire-power:
- Verify target declaration timing.
- Verify all later attacks respect the nominated target.
- Verify whether the app's current one-weapon-at-a-time firing flow creates an advantage not present in tabletop declaration timing.

All Hands on Deck:
- Verify it correctly affects Damage Control and the one-attempt cap.
- Verify restrictions or drawbacks after declaration.

Scout support:
- Implemented as separate Scout actions rather than normal Special Actions.
- Needs range exceptions, especially Delphi unlimited Scout range.
- Needs tests for token consumption, failed checks, and invalid weapon exclusions.

## Ship Trait Gaps

Ship traits need two layers: parsing and behavior. The app currently parses or loosely detects several traits, but some do not have full gameplay behavior.

### Implemented or partially implemented

- Stealth
- Interceptors
- Dodge
- GEG
- Adaptive Armour / Armor
- Agile
- Lumbering
- Flight Computer
- Scout
- Shields
- Self Repair
- Anti-Fighter / Advanced Anti-Fighter

### Anti-Fighter / Advanced Anti-Fighter

Status: partial.

Current app note:
- UI and server hooks exist for Anti-Fighter allocation/results.
- Escort and Minbari Web of Death extend Anti-Fighter target eligibility through nearby protected allies.

Remaining work:
- Confirm Movement Phase timing.
- Confirm eligible attackers and targets.
- Implement Advanced Anti-Fighter differences exactly.
- Add regression coverage for dogfight exclusion, Escort lending, and Web of Death restrictions.
- Verify future fighter interceptor support.

Tests:
- Capital ship with Anti-Fighter can attack eligible fighter targets at the correct time.
- Cannot allocate Anti-Fighter dice to invalid targets.
- Advanced Anti-Fighter behaves differently only where the rule says it should.

### Carrier / Fleet Carrier

Status: partial.

Implemented:
- Launch/recovery support.
- Craft capacity tracking.
- Fleet Carrier pre-battle deployment support.
- Fleet Carrier dogfight and destroyed-flight recovery support.

Missing behavior:
- Fighter repair/replacement if applicable beyond destroyed-flight recovery.
- Loss of carrier benefits when crippled, skeleton-crewed, destroyed, or trait-lost.

Dependencies:
- Regression tests for fighter launch/recovery and Fleet Carrier edge cases.

### Command and Admiral interactions

Status: partially implemented.

Implemented:
- Command initiative bonus uses the highest live, non-crippled, non-skeleton-crewed Command score in the player's deployed fleet.
- Command bonuses respect destroyed ships and critical-effect trait loss.

Missing behavior:
- Fleet admiral assignment and fleet-level effects.
- Loss of Admiral benefits when crippled, skeleton-crewed, trait-lost, or destroyed.

Implementation shape:
- Model command/admiral as fleet-level state, not just a ship trait.
- Add battle setup UI for assigning admirals if required.
- Apply non-initiative Command/Admiral modifiers only after confirming exact 2E scope.

### Jump Engine / Advanced Jump Engine

Status: trait data exists; gameplay not implemented.

Missing behavior:
- Opening jump points.
- Entering/leaving hyperspace.
- Advanced Jump Engine timing/placement advantages.
- Restrictions while using jump actions.

Dependency:
- Hyperspace/jump point subsystem.

### Atmospheric and planetary assault

Status: not implemented.

Missing behavior:
- Atmospheric eligibility.
- Low orbit / planetary context.
- Orbital Bomb target handling.
- Ground emplacements/troops/planetary assault outcomes.

Dependency:
- Scenario/terrain/planet system.

### Self Repair

Status: partial.

Current app note:
- UI for Self Repair exists and dice can be rolled.

Remaining work:
- Confirm exact timing, dice count parsing, and whether it repairs hull, crew, criticals, or specific Ancient/Shadow states depending on source.
- Verify whether Self Repair is blocked by criticals, crippled/skeleton crew, or being destroyed.
- Verify one-use-per-round tracking and persistence.

Tests:
- Self Repair cannot be used outside the correct phase.
- Self Repair amount and target track are correct.
- A ship cannot use Self Repair twice in the same timing window.

### Super Maneuverable

Status: implemented for movement.

Current app note:
- UI and server movement logic recognize Super Maneuverable for turn-distance and minimum-move behavior.
- Fighter flight models are treated as Super Maneuverable for movement even when older/stale model rows are missing the explicit trait string.

Remaining work:
- Confirm exact interaction with ramming defense once ramming exists.
- Confirm restrictions from criticals and special actions.

### Immobile

Status: not implemented as a distinct rules mode.

Missing behavior:
- Cannot move or turn normally.
- May affect ramming, boarding, targeting, deployment, and station-style behavior.
- May interact with Dodge and adrift checks.

### Space Station

Status: not implemented as a distinct rules class.

Missing behavior:
- Station critical table.
- No normal movement.
- No Damage Control/Special Actions if applicable.
- Inoperable instead of destroyed at zero damage.
- Line-of-sight blocking.
- Station-specific interceptor degradation.

### Targets X

Status: not implemented.

Missing behavior:
- Multiple target points or systems.
- Different damage/weapon targeting behavior for stations or large units.
- UI for selecting a target section if required.

### Unique

Status: not enforced.

Missing behavior:
- Fleet builder should prevent illegal duplicate Unique ships.
- Game creation should validate imported/old fleets as a server-side guard.

### Flight Computer

Status: parsed/known, exact behavior unclear.

Remaining work:
- Confirm exact 2E effect.
- Identify which checks or restrictions it modifies.
- Implement only after rule meaning is confirmed.

### Agile

Status: partial.

Current app note:
- UI movement logic accounts for Agile in turn-distance calculations.

Remaining work:
- Confirm server enforcement.
- Confirm all special action and critical interactions.
- Add movement tests for Agile vs normal vs Super Maneuverable ships.

## Weapon Trait Gaps

Weapon traits also need both parsing and behavior. Some traits are parsed correctly but do not yet have complete persistence, target validation, or special-case rules.

### Implemented or partially implemented

- Accurate
- AP / Super AP
- Weak
- Beam / Mini Beam
- Twin Linked
- Energy Mine
- Mass Driver
- Double / Triple / Quad Damage
- Precise
- Slow Loading
- One Shot parsing
- Orbital Bomb parsing

### One-Shot

Status: parsed, incomplete behavior.

Current behavior:
- One-Shot is recognized for stealth-fail exemption, so a failed Stealth lock does not mark the weapon spent.

Gap:
- A successful use does not appear to permanently spend the weapon for the rest of the game.

Implementation shape:
- Add per-unit/per-weapon spent tracking for game-long weapon state.
- Treat One-Shot separately from per-round fired weapon ids.
- Show spent One-Shot weapons as disabled in the firing UI.

Tests:
- Failed Stealth lock does not spend the weapon.
- Successful fire spends it permanently.
- Refresh/round rollover does not restore it.

### Mass Driver

Status: partial.

Current behavior:
- Damage pipeline bypass behavior exists for Shields/Interceptors/GEG.

Gap:
- Target prerequisites and special restrictions are not clearly enforced before firing.

Implementation shape:
- Add explicit `canFireMassDriverAtTarget` validation.
- Return a clear user-facing rejection reason.

Tests:
- Valid targets can be fired on.
- Invalid targets are rejected before dice are rolled.
- Bypass behavior still works only after a legal shot.

### Molecular Slicer Beam

Status: visual/faction handling exists; full bespoke behavior unclear.

Current behavior:
- The frontend classifies the weapon visually as a Shadow beam color path.
- The weapon traits are normal Beam/Precise/Quad-style data.

Gap:
- Any unique Molecular Slicer Beam rules are not separately parsed or represented.

Implementation shape:
- Confirm whether 2E requires behavior beyond current Beam/Precise/Damage multiplier handling.
- If yes, add a specific parser flag and attack pipeline branch.

### Orbital Bomb

Status: parsed only.

Gap:
- No planetary target or ground-attack system exists.

Dependency:
- Planet/terrain/scenario subsystem.

Implementation shape:
- Do not implement as a normal ship-to-ship weapon unless the scenario rules explicitly allow it.
- Add target class validation once planetary objects exist.

### Advanced Missile Rack Slow-Loading exception

Status: not implemented.

Rule gap:
- Some advanced missile racks ignore Slow-Loading unless the firing ship is crippled.

Current behavior:
- Slow-Loading is generic and applies whenever the trait is present.

Implementation shape:
- Represent this as weapon metadata, such as `slowLoadingOnlyWhenCrippled`.
- Update data import/maintenance to tag only the relevant missile racks.
- Keep normal Slow-Loading behavior for ordinary missile racks.

Tests:
- Non-crippled ship can fire the exception rack in consecutive rounds.
- Crippled ship follows normal Slow-Loading cooldown.
- Ordinary Slow-Loading weapons are unaffected.

### Earth missile variants and HARM missile

Status: not implemented.

Missing behavior:
- Missile loadout selection before or during fleet setup.
- Anti-Fighter missile behavior.
- HARM missile sensor/Stealth penalty and CQ resistance.
- Non-cumulative temporary missile effects.

Dependencies:
- Weapon loadout UI.
- Temporary unit status effects.
- Rules for whether loadout is hidden, fixed, or declared.

Implementation shape:
- Add missile variant as per-weapon selected mode.
- Store chosen mode in game setup or fleet data.
- Add dedicated resolution branches for non-damage missile effects.

### Gravitic Shifter

Status: not implemented.

Missing behavior:
- Turning the target in place once per turn.
- Additional shifters beyond the first causing automatic Damage/Crew loss.
- Correct defensive interactions: Adaptive Armour and GEG apply; Dodge, Stealth, and Interceptors do not.

Implementation shape:
- Implement as a special weapon resolution path, not as normal AD damage.
- Store per-target/per-turn shifter hit state.
- Add UI showing the forced rotation choice or result.

### Accurate

Status: implemented for Dodge bypass, but needs regression tests.

Test focus:
- Accurate ignores Dodge.
- Accurate does not also bypass Interceptors, Shields, or other defenses unless another trait says so.

### AP / Super AP / Weak

Status: implemented after prior correction, but needs regression tests.

Test focus:
- These modify attack die success behavior, not Attack Dice count.
- They do not modify the Attack Table unless another trait does.

### Beam / Mini-Beam

Status: implemented, but declaration/timing gaps remain.

Remaining work:
- Beam target splitting restrictions.
- Strict target nomination before dice.
- Confirm Mini-Beam interactions with Interceptors and other defenses.

### Energy Mine

Status: mostly implemented.

Remaining work:
- Mark Stealth targets as seen for follow-up attacks in the same turn.
- Confirm One-Shot spend interaction for successful Energy Mine fire.
- Confirm area/blast behavior if future multi-target Energy Mine resolution is added.

### Slow Loading

Status: implemented generically.

Remaining work:
- Add advanced missile rack exception.
- Confirm failed Stealth lock exemption for Slow-Loading remains correct.

### Precise

Status: implemented as Attack Table modifier.

Remaining work:
- Regression tests for raw vs modified damage die display.
- Confirm cap behavior and interaction with damage multipliers.

## Stealth, Interceptors, And Dodge Gaps

### Stealth

Known gaps:
- Energy Mine should mark Stealth targets as "seen" for follow-up attacks in the same turn; needs test/fix.
- The app's "successfully attacked" marker should be confirmed against 2E wording.
- Need verify mapping of "not Stricken or Running Adrift" to current destroyed/damage-state flags.

### Interceptors

Known gaps:
- Fighter interceptor support is not implemented.
- Guardian Array is parsed but fleet-specific interceptor lending is not implemented; it needs an attack-declaration choice rather than automatic spending.

### Dodge

Known gaps:
- Most current restrictions are implemented, but edge cases should be tested whenever new zero-distance movement modes or special actions are added.
- Dodge interactions with future fighters/dogfights need dedicated rules.

## Hyperspace, Jump Points, Terrain, And Stations

### Hyperspace and jump points

Not implemented.

Needed systems:
- Hyperspace state.
- Jump point entity.
- Enter/exit timing.
- Advanced Jump Engine behavior.
- Restrictions on movement, turning, launching, and special actions.

### Terrain

Not implemented or only represented visually.

Needed systems:
- Asteroids.
- Dust clouds.
- Gravity wells.
- Planets.
- Debris/hazard checks.
- Terrain effects on stealth, line of sight, movement, and attacks.

### Space stations

Not implemented as a distinct rules class.

Needed systems:
- Station-specific critical table.
- No Damage Control / no Special Actions.
- Fixed Crew Quality.
- Inoperable state at zero damage.
- Line-of-sight blocking.
- Station interceptor degradation.
- Targets/attack behavior per 2E station rules.

## Boarding And Troops

Boarding is intentionally unimplemented.

Known gaps:
- Boarding declaration and approach.
- Troop combat in End Phase.
- Capture/surrender/damage outcomes.
- Boarding immunity for Ancients and other special cases.
- Troop loss from criticals.
- Interaction with skeleton crew and derelict ships.

## Fleet Building And Data Gaps

Known gaps:
- Unique restriction is not enforced in fleet building.
- Faction/fleet-specific initiative modifiers are missing.
- Campaign refits are not modeled.
- Missile loadout selection is not modeled.
- Some ship traits are parsed as loose text but not represented structurally.
- Data rows need continued audit against 2E fleet lists and errata.

## AI Gaps

Known gaps:
- AI is a basic test opponent, not a strategic player.
- AI does not understand every special action, trait, future fighter rule, terrain effect, or advanced weapon exception.
- Any strict attack declaration, split-fire, or fighter timing work will need AI updates.

Likely work:
- Keep AI legality server-driven.
- Add AI tests around phase progression and no-deadlock behavior.
- Prefer simple legal decisions over clever but fragile heuristics.

## UI/UX Gaps

Known gaps:
- Need clearer public-alpha onboarding and bug-report affordances.
- Some rules feedback is visible only after an action is blocked.
- Movement and firing preview should continue moving toward "show why" explanations.
- End Phase could use clearer previews for adrift drift, delayed explosions, repairs, and refreshes.
- Strict attack declaration would need a new staging UI if implemented.

## Public Alpha Caveats

Use these as internal notes when explaining the build to testers:

- Core ship movement, weapon firing, damage, criticals, and phase flow are playable.
- The app is not yet a complete rules simulator for fighters, boarding, hyperspace, stations, terrain, or campaign/fleet-command layers.
- Current play favors usability over strict simultaneous declaration timing.
- Rules bugs should be reported with game ID, round, phase, ships, weapon, expected result, and actual result.

## Suggested Short-Term Order

1. Add regression tests around recent public-alpha paths: deployment, movement, firing, damage table, destroyed visuals, and Energy Mine straight-line animation.
2. Confirm and fix Energy Mines marking Stealth targets as seen.
3. Verify Redundant Systems / Shadow critical repair timing.
4. Add One-Shot spent tracking on successful fire.
5. Tighten server movement validation for turn limits and final-position overlap.
6. Add initiative modifiers.
7. Decide whether strict attack declaration is required before broader public testing.
8. Pick one major missing subsystem next: fighters, hyperspace, terrain/stations, or boarding. Fighters likely have the highest gameplay value.
