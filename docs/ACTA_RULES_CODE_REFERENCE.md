# Babylon 5 ACTA 2E Rules - Code Reference And Implementation Audit

Purpose: concise implementation reference for Codex work on this app. This is a paraphrased, code-oriented summary of the attached 2007 ACTA Second Edition rulebook plus an audit against the current local game implementation.

Source material:
- Local PDF: `C:/Users/Admin/OneDrive/Documents/babylon 5 acta/Babylon_5_-_A_Call_To_Arms_2007.pdf`
- Extracted analysis text: `tmp/rules/acta_2007_core_rules_pages_2_46.txt`
- Current implementation inspected: `artifacts/api-server/src/routes/games.ts`, `artifacts/api-server/src/lib/traits.ts`, `artifacts/api-server/src/lib/critical-table.ts`, `lib/db/src/schema/games.ts`, `lib/db/src/schema/shipModels.ts`, `lib/db/src/schema/weapons.ts`, `artifacts/b5acta/src/pages/game-board.tsx`

Scope: core game mechanics, special actions, ship and weapon traits, fighters, advanced terrain/stations/boarding hooks. Fleet lists, scenarios, campaigns, and full ship data are not copied here; they should remain data-driven.

## Data Model Targets

Ship model fields:
- `faction`, `name`, `class`
- `hullRating`: threshold needed by normal weapons to hit this class.
- `hullPoints` and `crew`: damage tracks.
- `damageThreshold` and `crewThreshold`: crippled/skeleton thresholds if using printed thresholds directly. Current app derives half max instead.
- `speed`, `turns`, `turnAngle`
- `troops`, `craft`
- `shieldMax`, `shieldRegenRate`
- `traits`
- weapons list: `name`, `range`, `arc`, `attackDice`, `traits`

Game unit fields:
- Position and heading in inches/degrees.
- Current hull, crew, shields.
- Phase flags: moved, fired, active unit/player.
- Per-round state: special action, scout action, fired weapon ids, interceptor pool/threshold, stealth support markers.
- Persistent critical effects with repairability, applied round, random forbidden arc/weapon, lost traits.

## Turn Structure

Canonical round phases:
1. Initiative
2. Movement
3. Attack
4. End

Implementation shape:
- Initiative: both players roll 2d6 plus fleet/race modifiers. Ties reroll.
- Movement: initiative winner decides whether to move first or force opponent first. Players alternate ship movement until all eligible ships have moved.
- Attack: initiative winner fires first, then players alternate ship firing until all eligible ships have attacked.
- End: damage control, forced adrift movement, delayed explosions, fighter launch/recovery, shield/interceptor refresh, bookkeeping.

Codeable invariant:
- Each ship normally receives one movement activation and one attack activation per round.
- A player with no eligible activation should be able to pass without deadlocking the phase.
- End phase should not roll over until both players have completed/declined their end-phase work.

## Measurement And Board

Rules:
- Distances are inches.
- Measure ship distances from base stem/center; fighters from base/counter edge.
- Pre-measuring is allowed.
- No altitude layer in normal play.

Implementation:
- Board world units should remain 1 unit = 1 inch.
- Range and movement use world distance.
- Collision/stacking should prevent ships from overlapping except fighters may overlap ship bases.

Current app:
- Uses 48 x 72 board and world inches.
- Allows pre-measure-like range/arc visualization.
- Enforces illegal final-position base overlap server-side.

## Initiative

Rule:
- Each player rolls 2d6 plus fleet initiative modifier. Highest wins; ties reroll.
- Winner chooses whether to move first or second in Movement Phase.
- Winner fires first in Attack Phase.

Current app:
- Rolls raw 2d6.
- No fleet/race initiative modifiers observed.
- Winner chooses the first movement activator.
- Firing phase starts with initiative winner if they have an eligible ship, else opponent, else skip to End.

Audit:
- Missing fleet/race initiative modifiers.
- Possible nuance: rulebook says initiative winner fires first; current "choose first activator" applies to movement only, then firing reverts to initiative winner. That is correct unless scenario/squadron modifiers override it.

## Movement

Core rules:
- Ships move up to current speed.
- Unless a rule says otherwise, a ship must move at least half current speed.
- Movement includes limited turns based on `turns` and `turnAngle`.
- Turns are tied to forward movement; exact turn timing must follow ACTA movement template.
- Ships may not end stacked on other ships.
- Fighters have separate rules.

Crippled:
- A crippled ship has reduced performance and command ability.
- The app derives crippled at hull <= half max; printed sheets may have explicit threshold.

Adrift:
- Adrift ships move involuntarily in End Phase at half current speed in a straight line until they leave the table.
- They may not act normally unless crew/control rules allow limited actions.

Current app:
- Movement is broken into `/move` calls during activation.
- End activation enforces minimum half speed unless All Stop / All Stop and Pivot / adrift-like.
- Adrift ships are not movement-eligible; drift resolves automatically during `/pass-end-phase` after both players pass End Phase.
- `last_adrift_drift_round` prevents a ship from drifting twice if End Phase rollover is retried in the same round.
- Uses integer hex/world coordinates and Euclidean distance.
- Turn limits are partly enforced client-side through movement planner; server inspected here enforces some special-action heading restrictions but not the full turn timing/turn-count movement geometry.
- Engine critical speed penalties affect minimum speed calculation.
- Server rejects illegal final-position base overlap; movement paths are not blocked merely for passing over another base.

Audit:
- Forced adrift movement timing now matches the base rule timing at a coarse level: the server performs the straight-line drift during End Phase.
- Full turn-count/turn-angle server enforcement is unclear or incomplete.
- Final-position ship overlap/stacking is enforced server-side.
- Printed damage/crew thresholds are now used for crippled/skeleton logic, with half-max as a legacy fallback.

## Attack Phase

Canonical attack declaration:
- Select firing ship.
- Select weapon system and target.
- Check range and arc.
- Resolve target defensive gates and hit/damage sequence.
- Each weapon system fires once per Attack Phase unless a rule restricts it.
- A ship may fire multiple weapon systems during its attack activation unless restricted.

Core hit:
- Normal weapon hits on target hull rating or better.
- Beam and Mini-Beam hit on 4+ regardless of hull.
- Attack Dice are rolled per weapon after modifiers.

Current app:
- Server checks active phase/player/unit, ownership, weapon ownership, target enemy, range, and arc.
- Tracks `firedWeaponIds` per activation.
- Lets a ship fire multiple weapon systems before ending activation.
- Blocks firing for destroyed, zero-hull, and zero-crew ships.

Audit:
- Target splitting restrictions for Beam weapons are not modeled beyond one weapon/one target per request.
- Multi-target weapons/station Targets X not implemented.
- Fighter timing before ships not implemented.

Deferred taste/strictness notes:
- Basic target legality is currently server-enforced: firing phase, active player/unit, enemy-only target, non-destroyed target, weapon ownership, weapon not already fired, range, and arc.
- Boresight weapons are intentionally being left as a narrow tolerance cone for now, not a mathematically exact straight line. Rule text describes Boresight/Boresight Aft as straight lines, so revisit if stricter tabletop fidelity is desired.
- Arc-border target assignment is not strict. Rules say a target on the border between two arcs must be assigned to one arc and cannot be attacked from both arcs. Current implementation checks each weapon independently, so exact-border targets may qualify for both adjacent arcs. Left as-is for play feel.
- Firing is not declared simultaneously for all weapons. Current UX resolves one weapon at a time, letting players see one result before choosing the next weapon/target. Rules require nominating targets for every weapon intended to fire before attacks are made. Left as-is for usability.
- Splitting AD from one weapon across multiple targets is not implemented; `/fire-weapon` resolves one weapon against one target. This should be implemented in the future rather than treated as a taste exception, especially for AI and strict attack declarations.

## Combat Resolution Pipeline

Recommended canonical pipeline:
1. Declare attack.
2. Stealth lock check if target has Stealth and weapon does not ignore it.
3. Roll attack dice to hit.
4. Apply Dodge per hit if eligible and not ignored.
5. Apply Interceptors if eligible and not ignored.
6. Apply Shields if eligible and not ignored.
7. Roll Attack Table per surviving hit.
8. Apply GEG and other damage reducers where applicable.
9. Apply critical effects.
10. Apply defensive special actions such as Close Blast Doors if their rule timing says so.
11. Update hull/crew/damage state.
12. Check victory/damage-table outcomes.

Current app:
- Implements roughly this pipeline in `/fire-weapon`.
- App comment says: AD -> Dodge -> Interceptors -> Shields -> Attack Table -> GEG -> Crits -> Blast Doors.
- Implements stealth as separate pre-attack d6.
- Implements raw hits, dodge, interceptors, shields, attack table, GEG, critical effects, adaptive armor, blast doors, damage table, win check.

Audit:
- Verify the exact rulebook order for Adaptive Armour, GEG, criticals, and Blast Doors before tuning. The current code has an explicit order, but some traits may have exceptions.
- Dodge eligibility is incomplete: code comment says adrift / did-not-move restrictions are not modeled.

## Attack Table And Criticals

Attack Table:
- Per surviving hit, roll d6.
- Low result: bulkhead hit, little/no damage.
- Middle result: solid hit, normal damage and crew loss.
- High result: critical hit, normal damage/crew plus critical table roll.
- Precise adds to Attack Table rolls.
- Some weapons convert/prevent criticals.

Critical Table:
- Roll location d6: 1-2 Engines, 3 Reactor, 4 Weapons, 5 Crew, 6 Vital Systems.
- Roll effect d6 within that location.
- Critical damage/crew losses apply in addition to normal hit damage.
- Similar ongoing penalties do not necessarily stack as simple sums; rulebook says similar effects such as speed loss use highest penalty while each critical remains separately repairable.
- Vital Systems criticals cannot be repaired.

Current app:
- Implements a 36-cell critical table.
- Criticals are persisted as rows with repairability and runtime flags.
- Implements engine speed penalties, adrift critical, no special actions, trait loss, weapon AD penalties, hit-on-4 floor, forbidden arcs/weapons, damage-control penalties, and no-damage-control effects.
- Damage control can delete a crit row's ongoing special effect; hull/crew loss remains.

Audit:
- Contradiction: app sums speed reductions from multiple crits; rulebook says similar penalties such as speed loss should use the highest active penalty, while each crit remains separately repairable.
- App applies `allWeaponsAdMod` cumulatively; confirm whether multiple similar weapon AD penalties should stack or highest only.
- Damage Control now repairs special effects only, not lost Damage/Crew points.
- Troop loss from criticals is flagged but not stored/applied.
- Critical trait loss picks simplified trait names; matching to full trait strings may be lossy for multi-word traits.

## Damage States

Crippled:
- Triggered by damage threshold.
- Effects include speed reduction, limited firing, loss/disablement of some traits, and damage-control penalty.

Skeleton Crew:
- Triggered by crew threshold.
- Effects include no Special Actions, limited firing, damage-control penalty, troop reduction, loss of command/fleet-carrier/admiral benefits.

Damage Table / zero damage:
- When reduced to zero damage, roll d6 plus overkill for final state.
- Outcomes include adrift, destroyed, delayed explosion, immediate explosion.

Current app:
- Derives crippled and skeleton from half of max hull/crew.
- Blocks Special Actions for skeleton crew.
- Limits firing through `oneWeaponThisRound` and some special action gates, but general crippled/skeleton "only one weapon/arc/system" handling is partial.
- Implements damage table outcomes.
- Implements delayed catastrophic kill at end-phase rollover.
- Immediate explosion uses simplified area attack with maxHull/2 capped at 15 AD in 4-inch range.

Audit:
- Printed threshold fields exist in CSV (`Damage Threshold`, `Crew Threshold`) but app appears to derive thresholds from half max. This may contradict ship sheets.
- General crippled restrictions are not fully enforced server-side.
- General skeleton firing restriction appears only partly enforced; zero crew cannot fire, skeleton crew should still be able to fire one weapon system unless other rules say no.
- Immediate explosion implementation is simplified; confirm exact explosion AD/range/table from rulebook before treating as canonical.

## Damage Control

Rules:
- End Phase only.
- Select one repairable critical effect and roll d6 + Crew Quality.
- Success on 9+.
- Vital Systems cannot be repaired.
- Damage Control repairs critical effects only, not hull/crew loss.
- Penalties apply from skeleton crew and some critical effects.
- Some actions may improve Damage Control.

Current app:
- End Phase only and active player's repair window only.
- One attempt per unit per round unless All Hands on Deck succeeded.
- Cannot repair same round applied.
- Blocks Vital Systems.
- Engineering permanently blocks damage control.
- Hull Breach blocks in applied round.
- Rolls d6 + CQ - penalties + All Hands bonus.
- On success deletes the critical row/effect only; it does not restore hull or crew.

Audit:
- Earlier builds refunded critical structural damage; current behavior should not.
- "Cannot repair same round applied" should be verified; rulebook says End Phase repair, but exact same-turn critical repair timing needs confirmation.
- All Hands on Deck lifting the one-attempt cap matches current interpretation but should be kept as explicit app rule if verified.

## Special Actions

General:
- Declared instead of normal movement or at specified timing.
- Some require Crew Quality check.
- Usually one Special Action per ship per turn.
- Ships blocked from Special Actions immediately lose associated benefits.
- Failed attempts often still impose restrictions where the action says so.

Current app implements:
- All Power to Engines
- All Stop
- All Stop and Pivot
- Close Blast Doors
- Come About: extra turn variant
- Come About: sharp turn variant
- Intensify Defensive Fire
- Run Silent
- Concentrate All Fire-power
- All Hands on Deck

Current app also implements Scout support as separate firing-phase actions:
- Counter-Stealth
- Scout coordination reroll

Special action audit:
- Boarding action setup/action is not implemented.
- Launch Fighters special action is not implemented.
- Jump Point / hyperspace special actions are not implemented.
- "Stand Down and Prepare to be Boarded" / surrender-type action appears not implemented as a tactical action, though game concede exists.
- Some special actions have effects split between UI and server; server should be treated as authoritative.
- All Power to Engines effect should be verified in movement planner/server speed cap.
- Run Silent restrictions include no fire; verify no-turn and speed cap enforcement in server/client.

## Ship Traits

Rulebook/data traits to model:
- Adaptive Armour / Armor
- Advanced Anti-Fighter
- Advanced Jump Engine
- Agile
- Anti-Fighter
- Atmospheric
- Carrier / Fleet Carrier
- Command
- Dodge X
- Fighter
- Flight Computer
- GEG / Gravitic Energy Grid
- Immobile
- Interceptors X
- Jump Engine
- Lumbering
- Scout
- Self Repair
- Shields
- Space Station
- Stealth X
- Super Maneuverable
- Targets X
- Unique

Current parser implements:
- Stealth
- Interceptors
- Dodge
- GEG
- Adaptive Armour/Armor
- Agile
- Lumbering
- Flight Computer
- Scout

Current app behavior implements or partially implements:
- Stealth with range/fleet-support/scout modifiers.
- Interceptors with persistent degrading pool.
- Dodge per hit, but missing some eligibility restrictions.
- GEG as damage and crew reduction per hit, except Mass Driver bypass.
- Adaptive Armour halving.
- Lumbering restriction on one Come About variant.
- Scout support actions.
- Shields through model fields.

Missing or unclear ship traits:
- Anti-Fighter and Advanced Anti-Fighter.
- Carrier / fighter launch and recovery.
- Jump Engine / Advanced Jump Engine / hyperspace.
- Atmospheric / planetary assault.
- Self Repair.
- Super Maneuverable.
- Command and admiral interactions.
- Fleet Carrier.
- Immobile / Space Station / Targets X.
- Unique fleet-building restriction.
- Flight Computer exact effects.
- Agile exact movement effects.

## Weapon Traits

Rulebook/data traits to model:
- Accurate
- AP / Armor Piercing
- Super AP / Super Armor Piercing
- Beam
- Mini-Beam
- Double Damage
- Triple Damage
- Quad Damage
- Energy Mine
- Mass Driver
- One-Shot
- Precise
- Slow-Loading
- Twin-Linked
- Weak
- Orbital Bomb
- Molecular Slicer Beam

Current parser implements:
- Accurate
- AP
- Super AP
- Weak
- Beam
- Mini Beam
- Twin Linked
- Energy Mine
- Mass Driver
- Double Damage
- Triple Damage
- Quad Damage
- Precise
- Slow Loading
- One Shot
- Orbital Bomb

Current app behavior:
- Accurate ignores Dodge.
- AP/Super AP modifies attack die results by lowering the raw die threshold; it does not add dice.
- Beam/Mini Beam hit on 4+ and bypass Interceptors; Beam chains extra dice.
- Twin Linked rerolls misses.
- Energy Mine bypasses Stealth/Interceptors/Dodge and prevents criticals.
- Mass Driver bypasses Shields/Interceptors/GEG in damage pipeline.
- Damage multipliers affect damage and shield cost.
- Precise is applied to Attack Table rolls as +1, capped at 6; raw and modified rolls are both returned for audit/UI.
- Slow Loading cooldown implemented.
- One Shot parsed but no spent-for-game tracking observed.
- Orbital Bomb parsed but no planetary target handling observed.

Major audit item:
- AP/Super AP corrected: they now affect attack die results rather than AD count.
- Precise corrected: it now modifies Attack Table classification, not AD or to-hit.
- One-Shot is parsed and stealth-fail exception is handled, but normal successful use does not seem to permanently disable the weapon for the rest of the game.
- Mass Driver target prerequisites are noted in code comments but not clearly enforced before firing.
- Molecular Slicer Beam is present in CSV trait names but not parsed/implemented.
- Armor Piercing / Super Armor Piercing naming variants are recognized by the parser.

## Stealth

Rules:
- Stealth target requires a separate lock-on roll.
- >20 inches worsens target by +1.
- <8 inches improves attacker by -1.
- If another non-stricken, non-adrift allied ship has already attacked the target successfully this turn, apply an additional -1.
- Natural 6 always succeeds.
- Slow-Loading and One-Shot weapons do not count as fired if stealth lock fails.

Current app:
- Implements separate stealth check.
- Implements range modifiers.
- Implements binary fleet-support modifier using prior hit markers.
- Implements natural 6.
- Implements Slow-Loading/One-Shot stealth-fail exemption.
- Scout Counter-Stealth stacks per successful scout row.

Audit:
- The app records fleet-support stealth reduction when raw hits > 0 before defense. Rule text says "successfully attacked"; clarify whether that means lock-on succeeded, at least one AD hit, or damage got through.
- Need verify "not Stricken or Running Adrift" mapping to app `isDestroyed`/`damageState`.

## Interceptors

Rules:
- Interceptors defend against incoming hits unless ignored by weapon trait.
- Pool degrades during the turn and refreshes next turn.
- Crippled ships lose Interceptors.
- Some fighters can support Interceptors.

Current app:
- Persistent dice pool and threshold.
- Dice rolling 1 are lost for the turn.
- Threshold ramps to 6+.
- Pool refreshes at round rollover, filtered for lost traits.
- Crippled ships have effective Interceptors 0 during attacks and refresh to 0 at round rollover.
- Beam/Mini Beam/Mass Driver/Energy Mine bypass.

Audit:
- Fighter interceptor support not implemented.

## Dodge

Rules:
- Per hit, Dodge succeeds on d6 >= Dodge score.
- Accurate ignores Dodge.
- Dodge may not be available to adrift or non-moving ships.

Current app:
- Per-hit Dodge implemented.
- Accurate and Energy Mine ignore it.
- Dodge is suppressed when the target is adrift, on delayed-destruction state, crewless/hull-less, did not move this round, or used All Stop / All Stop and Pivot.

Audit:
- Clarify edge cases for "did not move" if future rules add zero-distance movement modes beyond All Stop / All Stop and Pivot.

## Fighters

Rule areas:
- Fighters move separately.
- Anti-Fighter attacks occur in Movement Phase.
- Fighters attack before ships in Attack Phase.
- Fighters can dogfight.
- Fighters can launch/recover in End Phase.
- Fighters may support Interceptors if eligible.

Current app:
- Ship model data has `craft` text but no fighter unit model or fighter phase was observed.
- Anti-Fighter traits are present in CSV but parser/engine does not implement them.

Audit:
- Fighters and Anti-Fighter are not implemented.

## Hyperspace And Jump Points

Rule areas:
- Jump-capable ships may enter/leave hyperspace via jump points.
- Jump point creation restricts movement/turning/launching/Special Actions.
- Advanced Jump Engine has improved behavior.

Current app:
- Jump Engine / Advanced Jump Engine exist in data.
- No hyperspace state, jump point entity, or jump action observed.

Audit:
- Hyperspace and jump rules are not implemented.

## Terrain, Stations, Planets, Boarding

Terrain:
- Asteroids, dust clouds, gravity wells, planets, and other debris apply movement hazards, stealth changes, and attack restrictions.

Stations:
- Immobile, special damage table, Targets X, special Interceptor degradation by damage thresholds, no Special Actions or Damage Control.

Planetary assault:
- Low orbit / atmosphere, orbital bombardment, emplacements, troops, atmospheric craft.

Boarding:
- Requires declared/setup action and movement/attack restrictions.
- Troops fight in End Phase.
- Boarding can cause ship surrender/capture/damage effects.

Current app:
- Board currently appears empty space only.
- No terrain entities/hazards.
- No stations-specific damage/targets behavior.
- Troop values exist on models but are not copied to game units or used in boarding.
- No boarding action route observed.

Audit:
- Advanced rules are essentially unimplemented except traits that overlap core combat.

## Current Implementation Summary

Implemented or substantially implemented:
- Local deployment zones and active game setup.
- Initiative phase with 2d6 and tie reroll.
- Initiative winner chooses first movement activator.
- Alternating movement and firing activations.
- Range and arc checks.
- Multiple weapon systems per firing activation with per-weapon fired ledger.
- Minimum movement gate plus server-authoritative Crippled speed/turn caps.
- Several Special Actions.
- Stealth, Interceptors, Dodge, Shields, GEG, Adaptive Armour, including Crippled Interceptor/Shield shutdown.
- Beam, Mini Beam, Twin Linked, Energy Mine, damage multipliers, Slow-Loading.
- Critical-hit table persistence and many crit effects.
- Damage Control.
- Damage table for zero hull.
- Scout support actions.

Not implemented or partial:
- Fleet/race initiative modifiers.
- Full movement geometry/collision edge cases.
- Ramming/collision damage.
- Fighter regression coverage for deployment, dogfights, launch/recovery, Anti-Fighter, Escort, and Web of Death.
- Hyperspace/jump points.
- Boarding.
- Terrain/stellar debris.
- Space stations.
- Planetary assault.
- Admirals/Command/Fleet Carrier.
- Unique fleet-building checks.
- Several ship/weapon trait details and naming variants.

## Highest Priority Rule Mismatches To Fix

Related focused audits:
- Ancients/First Ones rules gaps: `docs/ANCIENTS_RULES_AUDIT.md`

Corrected rule mismatches:
- AP/Super AP now modify attack die results instead of increasing AD count.
- Damage Control now repairs critical effects only and does not restore hull/crew.
- Similar speed-reduction criticals now apply the highest active speed penalty. Weapon AD-loss criticals remain cumulative because the table note says that effect stacks.
- Crippled/Skeleton enforcement expanded: Crippled speed/turn caps, Crippled one-weapon-per-arc firing, Skeleton one-weapon-system firing, Flight Computer exception for Skeleton penalties, and Crippled Interceptor/Shield shutdown.

Highest remaining rule mismatches:

1. Fleet Carrier/Admiral systems remain incomplete; Command is partially implemented.
   - Current: Command adds the highest eligible live Command score to initiative and drops when the host ship is Crippled, Skeleton Crewed, destroyed, or has lost the trait. Crippled/Skeleton combat, movement, Special Action, scout, Damage Control, Interceptor, and Shield effects are enforced where those systems exist.
   - Expected: Fleet Carrier/Admiral benefits should also drop when their host ship is Crippled or Skeleton Crewed.
   - Risk: remaining fleet-level systems must consume derived rule state rather than raw traits.

2. One-Shot not fully enforced.
   - Current: parsed and stealth-fail exception exists, but successful use does not appear permanently spent.
   - Expected: successful firing consumes it for the game.
   - Scope note: intentionally deferred; the app does not yet model One-Shot weapons as an active gameplay feature.

3. Adrift edge cases.
   - Current: drift resolves automatically in End Phase and is latched once per round.
   - Expected: adrift ships move in End Phase at half current speed in a straight line.
   - Risk: table-edge departure and collision/overlap effects still need a dedicated implementation.

4. Mass Driver prerequisites.
    - Current: bypass effects implemented; target restrictions not clearly enforced.
    - Expected: only allowed under specific target state/timing restrictions.

5. Scout Counter-Stealth stacking needs confirmation.
   - Current: each successful scout row can reduce Stealth.
   - Expected: clarify whether multiple scout support actions stack in the 2007 base rules.

## Clarification Questions For Future Work

- Should this app follow the 2007 Second Edition base rules exactly, or keep current house interpretations where they improve digital play?
- Printed damage/crew thresholds now replace half-max derived crippled/skeleton checks; half-max remains a legacy fallback for incomplete rows.
- Precise currently uses +1 to Attack Table result, capped at 6; confirm if this edition/data source has any natural-1 exception.
- Adrift drift now resolves automatically during `/pass-end-phase`; future UI work may add an End Phase preview, but movement activation should remain unavailable for adrift ships.
- Are fighters in scope soon, or should Anti-Fighter/Carrier traits be hidden/marked inactive until fighter units exist?
- Should advanced rules (terrain, stations, planetary assault, boarding, hyperspace) be implemented as optional modules/scenario flags?
