# ACTA 2E Supplement Rules Audit

Scope: newly added second edition reference material scanned on 2026-07-10.

Primary sources used:
- `rules 2nd edition/ACTA FAQ.pdf`
- `rules 2nd edition/A Call To Arms - Powers & Principalities.pdf`
- `rules 2nd edition/Powers and Principalities errata.pdf`
- `rules 2nd edition/A Call To Arms - Fleet Lists 2E.pdf`

Working extracted text:
- `tmp/rules/acta_2e_faq_extracted.txt`
- `tmp/rules/acta_2e_powers_principalities_extracted.txt`
- `tmp/rules/acta_2e_powers_principalities_errata_extracted.txt`
- `tmp/rules/acta_2e_fleet_lists_extracted.txt`

Policy note: 2E documents remain the primary sources. If a rule is absent or unclear in 2E and a 1E clarification exists, raise it for discussion only. Do not implement 1E-derived behavior unilaterally.

## High-confidence implementation candidates

These are 2E clarifications or rules that touch systems already represented in the app.

### Energy Mines should mark Stealth targets as "seen"

2E source:
- FAQ says Energy Mines count as breaking Stealth (`tmp/rules/acta_2e_faq_extracted.txt:75`).
- Powers & Principalities repeats that a Stealth ship caught in an Energy Mine blast grants other vessels the normal +1 Stealth bonus (`tmp/rules/acta_2e_powers_principalities_extracted.txt:371`).

Current app:
- Energy Mines bypass Stealth for the attack itself.
- Fleet-support Stealth reduction is driven by `hitByUnitIdsThisRound` (`artifacts/api-server/src/routes/games.ts:5474`, `:6121`).
- Hits are recorded only when `hits > 0` after attack dice are rolled (`artifacts/api-server/src/routes/games.ts:6116`).

Potential tweak:
- Ensure an Energy Mine that catches a Stealth target in its blast records the firing unit as a successful prior attacker for the rest of the round, even though Energy Mine attacks bypass the normal Stealth roll.

Suggested test:
- Fire an Energy Mine at or catching a Stealth target, then have a different allied ship attack the same target that round. Confirm the second attacker gets the binary fleet-support Stealth modifier.

### Redundant Systems / Shadow critical repair timing may be too early

2E source:
- FAQ clarifies Shadow criticals repair in the End Phase after the turn they were inflicted (`tmp/rules/acta_2e_faq_extracted.txt:123`).
- Fleet Lists gives the same timing for Shadow vessels (`tmp/rules/acta_2e_fleet_lists_extracted.txt:6161`).
- Ancients audit uses the same "turn after" timing in the uploaded Ancients reference.

Current app:
- `autoRepairRedundantSystemCriticals` deletes all critical rows for Ancient/Redundant Systems units at end-phase rollover (`artifacts/api-server/src/routes/games.ts:3115`, `:3222`, `:7039`).
- The helper does not currently inspect the critical's `appliedRound`.

Potential tweak:
- Preserve Redundant Systems criticals until they have lasted one full turn. Only auto-repair rows with `appliedRound < currentRound`, or equivalent timing after confirming how end phase round rollover is modeled.

Suggested test:
- Inflict an Engines Disabled or weapons critical on a Redundant Systems unit during round N. Confirm it remains active through round N's End Phase and clears at the correct later End Phase.

### Delphi Scout has no Scout range limit

2E source:
- Fleet Lists gives the Delphi an unlimited Scout trait range instead of the normal 36 inches (`tmp/rules/acta_2e_fleet_lists_extracted.txt:1341`).

Current app:
- Scout support hard-codes `SCOUT_RANGE_INCHES = 36` (`artifacts/api-server/src/routes/games.ts:6550`, `:6625`).

Potential tweak:
- Add a model/trait-level override for Scout range, such as `Scout Unlimited` or a structured `scoutRangeOverride`.
- Apply it only to ships whose 2E source explicitly grants the exception.

Suggested test:
- Delphi can declare Scout support beyond 36 inches; normal Scout ships still cannot.

### Advanced Missile Rack Slow-Loading exception

2E source:
- Multiple Fleet Lists entries mark Advanced Missile Rack as Slow-Loading with a note that it ignores Slow-Loading unless the ship is Crippled (`tmp/rules/acta_2e_fleet_lists_extracted.txt:1073`, `:1258`, `:6836`).

Current app:
- Slow-Loading cooldown is generic and always applies when the parsed weapon trait includes Slow-Loading (`artifacts/api-server/src/routes/games.ts:5391`, `:6103`).

Potential tweak:
- Represent this as a weapon-level exception, not a global Slow-Loading change. For example: `slowLoadingOnlyWhenCrippled`.
- Data import should preserve the source note for relevant advanced missile systems.

Suggested test:
- Non-crippled Nemesis/advanced missile platform can fire the advanced missile rack in consecutive rounds; once Crippled, the normal Slow-Loading cooldown applies.

### "Move as though adrift" critical disables Dodge

2E source:
- FAQ says a ship suffering this critical cannot use Dodge (`tmp/rules/acta_2e_faq_extracted.txt:72`).

Current app:
- The critical table maps the effect to an `adrift` flag (`artifacts/api-server/src/lib/critical-table.ts:65`).
- `effectiveDamageState` overlays crit-derived adrift state (`artifacts/api-server/src/lib/critical-table.ts:197`).
- Dodge is blocked when target effective state is adrift (`artifacts/api-server/src/routes/games.ts:5671`).

Status:
- Likely already covered. Keep a regression test so it stays covered.

### Damage multipliers apply to critical additional damage and Crew

2E source:
- FAQ confirms Double/Treble/Quad affect Crew loss and additional critical damage (`tmp/rules/acta_2e_faq_extracted.txt:62`).

Current app:
- Audit docs say damage multipliers affect damage and shield cost, and the attack pipeline applies multipliers broadly. This should be verified specifically for additional critical Damage/Crew.

Potential tweak:
- If tests show critical extra Damage/Crew are not multiplied, adjust the critical application pipeline.

Suggested test:
- Force a Double Damage weapon to score a critical with additional Damage/Crew. Confirm both base and critical additional amounts are doubled.

## Medium-term feature candidates

These are valid 2E rules but require systems that are partial or not yet active.

### Gravitic Shifter

2E source:
- Core rules define the weapon; FAQ confirms Lumbering ships can be affected (`tmp/rules/acta_2e_faq_extracted.txt:106`).
- Powers & Principalities adds multiple-shifter damage and defense interaction rules (`tmp/rules/acta_2e_powers_principalities_extracted.txt:185`).

Needed behavior:
- Gravitic Shifter can turn the target in place once per turn.
- Additional shifters beyond the first against the same ship in the same turn inflict automatic Damage/Crew loss.
- Adaptive Armour and GEG apply; Dodge, Stealth, and Interceptors do not.

Implementation note:
- This should be a special weapon resolution path, not a normal AD attack.

### Manoeuvre to Shield Them! and Track That Target!

2E source:
- Powers & Principalities adds these as general Special Actions (`tmp/rules/acta_2e_powers_principalities_extracted.txt:951`, `:962`).

Needed behavior:
- Manoeuvre to Shield Them! introduces an intercept/forced-targeting check when line of fire passes close to the shielding ship.
- Track That Target! lets Boresight/Boresight Aft weapons pre-select a target and fire if it is in the relevant broad arc next attack phase.

Implementation note:
- These require UI targeting affordances and firing-line checks, so they are not quick data-only changes.

### Give Me Ramming Speed! update

2E source:
- Powers & Principalities modifies ramming eligibility and checks (`tmp/rules/acta_2e_powers_principalities_extracted.txt:908`).

Needed behavior:
- Crippled ships no longer need the initial CQ check.
- Non-Crippled ships may attempt it if they pass CQ.
- Opposed CQ is still needed to hit unless target is Adrift or Immobile.
- Super-Manoeuvrable targets get a defensive bonus.
- Fighters cannot ram or be rammed.

Implementation note:
- Defer until ramming is part of the movement/action system.

### Space stations

2E source:
- Powers & Principalities space station rules start around `tmp/rules/acta_2e_powers_principalities_extracted.txt:2433`.

Needed behavior:
- Stations no longer have Targets trait and attack as ships.
- Criticals use a station-specific critical table and auto-repair on delayed timing.
- Crew Quality fixed at 4.
- No Damage Control or Special Actions.
- At 0 damage, station becomes inoperable rather than destroyed.
- Stations block line of sight.
- Interceptors are a per-turn pool, halved after thresholds.

Implementation note:
- Add a `Space Station` unit profile rather than overloading normal ship behavior.

### Fighters, Anti-Fighter, Escort, Guardian Array, and Web of Death

2E sources:
- FAQ: Escort can give Anti-Fighter dice to fighters (`tmp/rules/acta_2e_faq_extracted.txt:53`).
- FAQ: Guardian Array can grant Interceptor dice to fighters (`tmp/rules/acta_2e_faq_extracted.txt:100`).
- Powers & Principalities: Minbari Web of Death grants restricted Escort behavior (`tmp/rules/acta_2e_powers_principalities_extracted.txt:379`).

Implementation note:
- Defer until fighter and Anti-Fighter systems are active.

### Earth missile variants and HARM missile

2E source:
- Fleet Lists missile variants begin around `tmp/rules/acta_2e_fleet_lists_extracted.txt:631`.
- HARM missile behavior is at `tmp/rules/acta_2e_fleet_lists_extracted.txt:678`.

Needed behavior:
- Missile rack loadout selection per rack.
- Anti-Fighter missile destroys a fighter flight on a successful attack with no Dodge.
- HARM deals no damage and imposes a temporary sensor/Stealth penalty on the hit ship if it fails CQ.
- Multiple HARM effects are not cumulative.

Implementation note:
- This needs a pre-battle or fleet-builder loadout UI, plus temporary status effects.

## Fleet/faction-specific rules to avoid applying globally

These are official 2E rules, but they are tied to specific fleets, ships, campaigns, or optional fleet-command layers.

- Centauri Hunting Packs are corrected by the P&P errata; use the errata text over the base P&P text (`tmp/rules/acta_2e_powers_principalities_errata_extracted.txt:7`).
- Drakh Critical Systems Defence is a pre-battle choice and replaces normal GEG damage reduction for selected ships (`tmp/rules/acta_2e_powers_principalities_extracted.txt:260`).
- Narn large ships get an enhanced Close Blast Doors interaction (`tmp/rules/acta_2e_powers_principalities_extracted.txt:394`).
- Shadow merge / beam-to-point-defense / fighter shield rules are Shadow-specific and should not be represented as generic Ancient behavior (`tmp/rules/acta_2e_powers_principalities_extracted.txt:550`).
- Campaign refits such as Advanced Sensor Arrays, Quick Loading Missiles, Enhanced Interceptor Network, and New Captain are campaign-layer effects, not baseline ship rules (`tmp/rules/acta_2e_fleet_lists_extracted.txt:696`).

## Recommended short-term order

1. Add tests and, if needed, a small fix for Energy Mines marking Stealth targets as seen.
2. Fix Redundant Systems / Shadow-style auto-critical repair timing if tests confirm same-turn clearing.
3. Add a Scout range override and data tag for the Delphi.
4. Add a weapon data exception for Advanced Missile Rack Slow-Loading only while Crippled.
5. Add regression tests for Dodge blocked by crit-derived adrift and critical additional Damage/Crew multiplier behavior.

Do not use 1E references to implement any of the above. If a 2E rule is ambiguous during implementation, pause and raise the ambiguity for discussion.
