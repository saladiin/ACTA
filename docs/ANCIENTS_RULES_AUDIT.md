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
- Ancients ignore Stealth from non-Ancient, non-Shadow, non-Vorlon ships (`:33-35`, `:55-59`).
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

Current status after the Ancient rules implementation:
- Trait parsing supports `Ancient`, `Redundant Systems`, `Stealth Penetration`, and `Self Repair`.
- CQ 7 and Ancient priority/FAP conversion are represented.
- Ancient units ignore qualifying Stealth targets, gain +4 initiative while fielded, avoid no-crew adrift transitions, ignore crew-affecting criticals, and auto-clear critical-effect rows in End Phase via Redundant Systems.
- Boarding remains intentionally unimplemented, with this section retained as the future implementation note.
