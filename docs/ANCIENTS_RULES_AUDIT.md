# Ancients Rules Audit

Source material:
- Original PDF: `docs/reference/ACTA_Ancients.pdf`
- Extracted text: `docs/reference/ACTA_Ancients_extracted.txt`
- Working extraction: `tmp/rules/acta_ancients_extracted.txt`

Scope: one-page Ancients reference uploaded on 2026-07-08. The OCR extraction has layout noise, so page/line citations below refer to the extracted text markers and should be checked against the PDF when exact wording matters.

## Rules Extracted

From extracted page 1:
- Ancients Initiative is +4 (`tmp/rules/acta_ancients_extracted.txt:20`, `:42`).
- Priority Level Ancient exists for fleet construction. Conversion shown: Ancient 1, Armageddon 2, War 4, Battle 8, Raid 12, Skirmish 18, Patrol 30 (`:24-30`).
- All Ancients have Crew Quality 7 (`:32`, `:51`).
- Ancients ignore the Stealth of any target (`:33-35`, `:55-59`).
- Ancients cannot be boarded, cannot initiate boarding, are immune to crew-affecting critical hits, and have no Crew or Troops score (`:11-13`).
- Redundant Systems: Ancients take damage normally, but critical hits are automatically repaired in the End Phase of the turn after they are inflicted, including Vital Systems criticals (`:36-41`, `:60-62`).
- The sample stat block uses Ancient-specific/less common weapon terminology including Mini-Beam, Super AP, and "X2/X3 Damage" notation (`:51-65`).

## Pre-Implementation Gaps

The following was the audit state before the Ancient rules implementation started. See "Current status after the Ancient rules implementation" near the end of this file for the updated state.

1. Ancient priority level is unsupported.
   - Current priority enum stops at `armageddon` in `artifacts/b5acta/src/lib/fleet-allocation.ts` and `artifacts/api-server/src/lib/fleet-allocation.ts`.
   - Unknown priorities normalize to a fallback, so `Ancient` would not price correctly.
   - Fleet construction cannot represent the uploaded conversion table or `Ancient X2` style entries.

2. Race initiative modifiers are unsupported.
   - Initiative is currently raw 2d6 in `artifacts/api-server/src/routes/games.ts`.
   - No fleet/race initiative modifier is stored on games, fleets, factions, or deployed units.
   - Ancients +4 would not apply.

3. Crew Quality 7 is unsupported.
   - Standard games force CQ 4.
   - Custom deployment clamps CQ to 1..6.
   - API schema descriptions and UI labels currently assume 1..6.
   - Ancient CQ 7 cannot be represented or used for Special Actions, Damage Control, or Scout-like checks.

4. No-crew Ancient handling is unsafe.
   - Battlecrab data currently has crew 0, which is directionally consistent with "no Crew score".
   - Combat resolution still applies `finalCrewLost` and then marks a target adrift when `targetCrewAfter === 0`, even if `maxCrewPoints === 0`.
   - Result: a no-crew Ancient can be pushed into adrift state by crew-loss logic that should not apply.

5. Crew-affecting critical immunity is not implemented.
   - Current critical resolution rolls and inserts normal critical effects for all targets.
   - There is no `ancient` trait/faction gate to suppress crew-affecting criticals.
   - Crew-location criticals, crew loss attached to other criticals, troop-loss flags, no-SA crew effects, and similar critical side effects can still apply.

6. Redundant Systems automatic critical repair is not implemented.
   - End-phase rollover handles drift, delayed destruction, shield regeneration, and interceptor refresh.
   - Critical repair is currently manual Damage Control through `/damage-control`.
   - Vital Systems are explicitly non-repairable by Damage Control, but Ancients should auto-repair even Vital Systems at the specified timing.

7. Stealth Penetration is not implemented.
   - Current stealth bypass is weapon/trait-specific, mainly Energy Mine, not attacker-race-specific.
   - No logic says "Ancient attacker ignores Stealth except against Ancient, Shadow, or Vorlon targets."
   - Current code does not have a normalized broad race category for Ancient/Shadow/Vorlon exceptions.

8. Boarding immunity is not modeled.
   - Boarding is not implemented globally, so this does not currently produce an in-game contradiction.
   - When boarding is added, Ancients need explicit rules: cannot board and cannot be boarded.

9. Weapon trait parser does not cover all uploaded notation.
   - `Mini-Beam`, `Super AP`, `Beam`, and normal `Double Damage`/`Triple Damage` concepts are present in current parsing.
   - The uploaded sheet uses `X2 Damage` and likely `X3 Damage` notation. Current parser does not recognize `X2 Damage` as Double Damage or `X3 Damage` as Triple Damage.
   - Direct import from this PDF would therefore under-apply damage multipliers unless data is normalized.

10. Current Shadow Battlecrab data is only partially Ancient-ready.
   - Current seed has `Shadow Battlecrab`, `crew = 0`, `crew_quality = 'N/A'`, shields, `Super Maneuverable`, and `Self Repair:3d6`.
   - `Self Repair:3d6` is not parsed or implemented.
   - The Battlecrab is set to `armageddon`, not a true `ancient` priority. That may be correct for the Shadow unit source, but it is not equivalent to the uploaded Ancients fleet list's `Ancient` priority level.
   - The uploaded PDF appears to show First One/Ancients rules and a Kirishiac Conqueror-style stat block, not a clean Shadow Battlecrab rules block. Do not blindly overwrite Battlecrab data from this PDF.

## Implementation Recommendations

Add an explicit Ancient rules layer rather than encoding every exception into faction strings:
- Add `ancient: boolean` or a broader `raceRulesProfile` field derived from traits/faction.
- Add `stealthPenetration: boolean`.
- Add `redundantSystems: boolean`.
- Add `noCrewTrack: boolean` or treat `maxCrewPoints === 0` as immune to crew-loss state transitions.
- Add `boardingImmune: boolean` once boarding exists.

Concrete code areas to update when implementing:
- Priority/FAP: `artifacts/*/src/lib/fleet-allocation.ts`, OpenAPI/Zod enums, UI labels, fleet bar.
- Initiative: `/roll-initiative` and AI initiative roll path in `artifacts/api-server/src/routes/games.ts`.
- Deploy/CQ: deployment validation, API schema max, UI CQ picker, standard CQ override.
- Combat: stealth check, crew-loss application, critical insertion, critical side effects, damage table adrift-from-crew logic.
- End Phase: automatic Ancient critical cleanup after the correct delay, including Vital Systems.
- Trait parsing: parse `Self Repair`, `Redundant Systems`, `Stealth Penetration`, `X2 Damage`, `X3 Damage`.

Minimum safe implementation order:
1. Add parser/data flags for Ancient rules.
2. Fix no-crew combat state handling.
3. Add Redundant Systems auto-critical repair.
4. Add Stealth Penetration attacker bypass.
5. Expand priority/CQ support.
6. Normalize imported weapon notation.

## Internal Boarding Note

When boarding is implemented, keep Ancient boarding rules explicit rather than relying on `crew = 0` as an indirect blocker.

Required Ancient boarding behavior from the uploaded reference:
- Ancient ships cannot be boarded.
- Ancient ships cannot initiate boarding actions.
- Ancient ships have no Crew or Troops score.
- Crew-affecting critical hits do not apply to Ancients.

Recommended implementation shape:
- Add an explicit `boardingImmune` or `ancient` gate in every future boarding target validator.
- Add an explicit `canInitiateBoarding === false` gate for Ancient attackers.
- Keep this separate from normal no-crew/skeleton-crew logic so non-Ancient derelicts, stations, civilian craft, or future scenario objects can be handled independently.
- Boarding resolution should not create crew-loss, troop-loss, capture, or prize-state side effects on Ancient units.

## 2026-07-28 Ancient Rules Implementation

The implementation was deliberately divided into eight stages. Stages 1-6 are
implemented. Stages 7-8 are explicitly deferred because they depend on larger
board-state systems and should not be approximated with isolated buttons.

### Stage 1 - Explicit rules profiles (implemented)

- `ship_models.rules_profile` stores `standard`, `ancients`, `shadows`, or
  `vorlons`.
- `artifacts/api-server/src/lib/ancient-rules.ts` is the authoritative profile
  helper. Faction-name matching remains only as a migration fallback.
- Initiative, Crew Quality, Stealth handling, crew-critical immunity, and
  Special Action availability read this profile rather than inferring Ancient
  identity from a loose trait string.

### Stage 2 - Separate thresholds (implemented)

- `damage_threshold` remains the normal cripple threshold.
- `physical_disruption_threshold` stores the parenthesized Shadow Damage value.
- Shadow and Vorlon ships have no normal cripple threshold unless a future
  specific unit says otherwise.
- Shadow thresholds are populated as the printed quarter-Damage value
  (`ceil(original Damage / 4)`), while Shadow fighters have no Physical
  Disruption threshold.
- Once a normal ship becomes Crippled, `permanently_crippled` keeps that state
  latched even if Damage is later repaired.

### Stage 3 - Shared combat corrections (implemented)

- Player and AI attacks use the same multiplied-hit Shield absorption rule. A
  partially depleted Shield still stops the complete hit that removes its last
  point.
- Player and AI critical-table damage and crew values inherit
  Double/Triple/Quad Damage multipliers.
- Player and AI suppress crew-affecting critical entries for Ancient, Shadow,
  and Vorlon profiles.
- Beam AD splitting is legal. The second Beam target must be within 4 inches of
  the first target.
- Shadow fighter Shields absorb the first otherwise-successful Anti-Fighter
  result or dogfight defeat.

### Stage 4 - Persistent damage and disruption state (implemented)

- Redundant Systems repairs critical effects in the End Phase after the vessel
  has lived with them for a complete turn, including Vital Systems.
- Physical Disruption triggers only when one Beam attack inflicts at least the
  vessel's printed threshold. It prevents further action in the current and
  following turn, and releases early if the source attacker is destroyed. A
  disrupted vessel is excluded from movement and firing activation eligibility,
  allowing its commander to pass the phase when no other eligible units remain;
  it is never required to satisfy minimum movement before being skipped.
- Telepathic Disruption uses the attacker's Psychic Crew score in the opposed
  roll. Only one ship may attempt to jam a given Shadow vessel per turn. A
  failed telepath is exhausted for the rest of the battle.
- Disruption effects are structured records in
  `game_units.ancient_status_effects`, not overloaded damage states.

### Stage 5 - Race Special Actions (implemented)

- Ancient, Shadow, and Vorlon action whitelists are enforced by the server.
- Shadow vessels currently expose Run Silent; Initiate Jump Point remains
  unavailable until Stage 7.
- Vorlon vessels also expose `Regenerate!` (CQ 9). A successful declaration
  makes the ship Adrift, prevents attacks, and doubles that turn's Self Repair.
- Vorlon/Ancient Jump actions remain hidden until the common jump subsystem is
  complete.

### Stage 6 - Shadow and Vorlon race abilities (implemented)

- Shadow Molecular Slicer Beams can be converted before movement into point
  defence for the round: half Range, remove Beam/Precise/damage multipliers,
  gain Accurate, Mini-Beam, and Turret. This is a Shadow system choice, not a
  Special Action: it has no Crew Quality check and does not consume the ship's
  Special Action.
- Shadow Ships and Scouts can select normal Super-Manoeuvrability or the
  opening 90-degree turn followed by straight movement up to twice Speed.
- Mind Scream checks every movement segment, excludes Shadow fighters, and
  uses the correct vessel value: Scout 1 Crew, Stalker 2 Crew, Young Ship 1d6,
  Ancient Ship/Battlecrab 2d6.
- Fighter Dispersal Tube launches 1-6 carried Shadow Fighter flights in the
  tube's printed Forward arc and within 30 inches. The source sheet says the
  flights deploy "3 inches within each other"; the game intentionally replaces
  that awkward pairwise rule with a house rule: Flight 1 is the lead flight and
  every later flight must be within 4 inches of Flight 1.
  The launched flights are marked moved/fired so they cannot act that turn.
  Selecting a flight count now opens an explicit sequential placement preview:
  the player positions and confirms every flight before the launch is
  submitted. The client previews group cohesion, range, board bounds, and base
  overlap while the server remains authoritative for every placement. The
  board displays the true Forward-arc range sector rather than a 360-degree
  launch circle. Once Flight 1 is confirmed, the board displays one stable
  4-inch wing area around it. An illegal preview identifies the exact failed
  constraint and measured distance. Client and server both use a 0.01-inch
  tolerance to prevent thousandth-inch coordinate rounding from changing
  legality at a visible range boundary.
- Ships with Fighter Dispersal Tubes receive their full Shadow Fighter
  complement and may deploy the full complement before battle.

### Stage 7 - Hyperspace and Jump Point Disruptor (deferred)

Do not implement this as a direct-fire weapon shortcut. It requires:

- off-board/hyperspace unit state;
- Shadow Hyperspace Mastery entry and exit timing;
- jump-point board entities, ownership, arcs, and lifecycle;
- normal and Advanced Jump Engine behavior;
- targeting and closing a jump point with the Jump Point Disruptor;
- damage to ships that used or occupy the disrupted point;
- scenario, deployment, withdrawal, VFX, and AI support.

The data and Special Action whitelists preserve the future action names, but no
unit may currently select them.

### Stage 8 - Shadow Merging (deferred)

Do not represent merged ships by simply hiding one unit. The subsystem must
preserve:

- two same-type Shadow vessels in base contact at the end of Movement;
- combined Shields and shared incoming Damage;
- half of the faster vessel's Speed;
- no attacks and no Dodge while merged;
- one Self Repair beneficiary in each End Phase;
- combined starting Damage for Physical Disruption;
- hyperspace interaction;
- later separation, remaining-Shield division, and the Stealth restriction
  while separating;
- audit logs, destruction, victory, selection, rendering, and AI behavior for
  both underlying units.

### Verification

- `ancient-rules.test.ts` covers profile identity, initiative/CQ/Stealth
  constants, Special Action whitelists, multiplied Shield absorption,
  persistent Crippled state, and disruption duration/source release.
- Server and client TypeScript checks are required before release.
- Boarding remains intentionally unimplemented. The Internal Boarding Note
  above is still authoritative and must use `rules_profile`, not zero Crew, as
  its future legality gate.
