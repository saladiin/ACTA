# Campaign System Implementation Prep

Status: campaign setup, persistent roster, strategic-system generation, and campaign-engagement prep started.
The app now has a Campaign menu/page, basic campaign create/list/read/join API
support, setup-phase campaign ship instances, and campaign-linked tactical
battle creation that seeds assigned roster ships into normal deployment. A
first-pass owner-controlled post-battle importer now persists tactical roster
state after a completed linked battle.
Campaign setup now validates the 2E 10 FAP Battle-priority roster budget,
generates auditable starting Crew Quality rolls, permits one CQ swap per
commander, tracks readiness, locks setup, creates Campaign Turn 1, and
generates the initial Strategic Targets plus Trade Route. Target nomination,
initiative resolution, target ownership, XP, and RR remain unimplemented.

The campaign menu now owns engagement creation. It records a locked rules
snapshot, applies priority/FAP, deployment, terrain, station, skybox, and
persistent roster conditions to the tactical game, and presents a campaign
battle briefing before participants enter deployment. Scenario-specific
objective adjudication remains manual until each scenario is automated.

Primary rules sources reviewed:

- `rules 2nd edition/Babylon_5_-_A_Call_To_Arms_2007_2nd_edition.pdf`, campaign chapter, extracted pages 78-99.
- `rules 2nd edition/A Call To Arms - Fleet Lists 2E.pdf`, faction campaign refits and other duties tables.
- `rules 2nd edition/A Call To Arms - Powers & Principalities.pdf`, Fleet Command, station campaign options, and Campaign of Terror variant.
- `rules 2nd edition/ACTA FAQ.pdf` and `rules 2nd edition/Powers and Principalities errata.pdf`, checked for campaign-related hits; no direct campaign-system override found in the searched text.

Do not use first-edition material for campaign automation unless a second-edition rule is missing or unclear and the user explicitly approves the interpretation.

## 1. Campaign Shape From 2E

The 2E campaign system is a persistent strategic layer around ordinary ACTA battles. It is not just a matchmaking list. A campaign tracks players, strategic targets, persistent fleets, ship damage, crew quality, XP dice, repairs, reinforcements, refits, other duties, RR income, and final victory.

Core campaign turn sequence:

1. Initiative.
2. Select strategic targets.
3. Generate scenario and priority level.
4. Fight the linked tactical battle.
5. Ship experience.
6. Repairs and reinforcements.

The campaign ends when a player controls all available strategic targets, or when a player has no ships left on their fleet roster. Variants such as Campaign of Terror alter this flow and should be implemented as optional campaign rule modules, not as the default.

## 2. Rule Domains To Model

Campaign setup:

- Campaign name, visibility, owner/admins, invited players, optional AI seats.
- Era/rules scope. The current ship roster already separates era-specific factions; campaign creation should lock a player to one fleet list/faction scope.
- Initial fleet construction: 10 FAP at Battle priority by default.
- Crew quality generation: roll per ship, allow one swap between two ships, and copy parent CQ to carried flights.
- Campaign map generation: 6-8 strategic targets for two players, +1 per extra player, plus the Trade Route.
- First strategic target is always a Settled World.
- Strategic targets and unusual features are generated from 2E tables.

Strategic target model:

- Category and subtype.
- Owner, explored flag, RR value, special rules payload.
- Optional unusual feature attached to a strategic target.
- Battle modifiers produced by the target or unusual feature.
- Trade Route is special: it is contested each turn and returns to neutral afterward.

Campaign turn model:

- Initiative order with penalty based on current strategic target count.
- Target nomination and challenge/intercept flow.
- Automatic capture when an unowned target is not challenged.
- One ship may participate in only one battle per campaign turn.
- Scenario and priority are generated per target contest.
- Players choose ships from their persistent roster for each tactical battle.

Post-battle import:

- Battle winner determines target retention/capture.
- Destroyed ships are removed from the campaign roster.
- Surviving ships keep hull damage, crew loss, troop loss, carried fighter state, and unresolved critical effects.
- Surrendered/captured ships are removed from the original roster in the core campaign rules. Raiders Campaign handling is different and should remain behind that module.
- Draws leave the target with its prior owner or neutral if it was unowned.

Experience:

- Ships earn XP dice from kill/cripple/skeleton/win/loss outcomes.
- Fighters do not earn XP dice and do not award XP dice.
- XP dice are ship-local and cannot be spent on another ship.
- XP spending buckets: crew quality improvement, makeshift repair, tactical rerolls in later battles, refit rolls, and other duties rolls.
- Exact XP awards should be implemented from a private data table keyed by priority-level delta and outcome event, not hardcoded in UI.

Repairs and reinforcements:

- Each player receives base RR each campaign turn plus/minus event modifiers and strategic target income.
- RR may be saved.
- RR repairs lost damage, critical effects, vital systems, crew, troops, and purchases reinforcements.
- Crippled ships have an additional repair surcharge before hull repair.
- Ships may be sent away for complete repairs and are unavailable for a fixed campaign-turn duration.
- Self-Repairing ships recover hull before the next battle, but do not automatically recover crew or critical effects.
- Carrier ships replenish a limited number of lost flights for free during this phase; fighter transfer between eligible carriers is allowed.
- Reinforcement costs scale by priority level; stations multiply cost.

Optional 2E/Powers & Principalities modules:

- Faction refits and other duties from Fleet Lists 2E.
- Fleet Command upgrades from Powers & Principalities.
- Campaign of Terror two-player asymmetric raider campaign.
- Station modules and station upkeep/campaign costs.
- Strategic target effects that inject terrain or environmental rules into tactical games.

## 3. Existing Game Data To Reuse

Do not duplicate tactical resolution in the campaign layer. Use the existing tactical game tables as the source for battle outcomes.

Useful current tables:

- `players`: commander identity.
- `ship_models`: printed ship stat source.
- `fleets` and `ships`: current player fleet list model, useful as the starting point for campaign rosters but not sufficient by itself.
- `games`: tactical battle identity, scenario priority, deployment settings, terrain/station config, skybox, and winner.
- `game_units`: deployed tactical ship instances, current hull/crew/troops, life state, capture/surrender state, carried fighter inventory.
- `unit_critical_effects`: persistent critical effects during a battle.
- `game_attack_audit_logs`: best source for kill/cripple/skeleton attribution for XP.
- `game_movement_audit_logs` and `game_special_action_audit_logs`: useful for campaign logs and unusual-feature verification.

Immediate gap:

- Tactical games do not currently know which campaign ship instance spawned a `game_unit`. Add a nullable campaign link before campaign battles are allowed.

## 4. Proposed Database Tables

Add a new schema module such as `lib/db/src/schema/campaigns.ts`.

Core tables:

- `campaigns`
  - id, owner player id, name, status, ruleset, variant, turn number, phase, visibility, settings json, created/updated timestamps.
- `campaign_players`
  - campaign id, player id, display name, faction key, initiative modifier snapshot, status, joined timestamp.
- `campaign_strategic_targets`
  - campaign id, generated index, category, subtype, owner player id, rr value, explored flag, unusual feature id, rules payload json.
- `campaign_unusual_features`
  - campaign id, target id, feature type, rules payload json.
- `campaign_ship_instances`
  - campaign id, owner player id, source ship model id, name, status, hull current/max, crew current/max, troops current/max, crew quality, xp dice, refits json, duties json, carried fighters json, critical effects json, unavailable until turn, destroyed/captured flags.
- `campaign_turns`
  - campaign id, turn number, initiative order json, status, started/completed timestamps.
- `campaign_target_nominations`
  - campaign turn id, acting player, target id, challenger/interceptor id, status.
- `campaign_battles`
  - campaign id, campaign turn id, target id, attacker id, defender id, tactical game id, scenario key, priority level, status, result payload json.
- `campaign_battle_ship_assignments`
  - campaign battle id, campaign ship instance id, tactical game unit id, side, pre-battle snapshot, post-battle snapshot.
- `campaign_xp_events`
  - campaign ship instance id, battle id, event type, source payload, xp dice awarded.
- `campaign_rr_ledger`
  - campaign id, player id, turn number, source type, amount, payload, created timestamp.
- `campaign_log_entries`
  - campaign id, turn number, actor player id, type, message, payload, created timestamp.

Rules data tables or static registries:

- `campaign_strategic_target_definitions`
- `campaign_unusual_feature_definitions`
- `campaign_refit_definitions`
- `campaign_other_duty_definitions`
- `campaign_scenario_roll_definitions`
- `campaign_reinforcement_cost_definitions`

Prefer static TypeScript registries first. Move to DB only when admin editing becomes necessary.

## 5. API Surface

Initial read/write routes:

- `GET /api/campaigns`
- `POST /api/campaigns`
- `GET /api/campaigns/:campaignId`
- `POST /api/campaigns/:campaignId/join`
- `POST /api/campaigns/:campaignId/players/:playerId/roster`
- `POST /api/campaigns/:campaignId/start`
- `POST /api/campaigns/:campaignId/turns/:turnId/initiative`
- `POST /api/campaigns/:campaignId/turns/:turnId/target-nominations`
- `POST /api/campaigns/:campaignId/battles`
- `POST /api/campaigns/:campaignId/battles/:battleId/assign-ships`
- `POST /api/campaigns/:campaignId/battles/:battleId/create-game`
- `POST /api/campaigns/:campaignId/battles/:battleId/import-result`
- `POST /api/campaigns/:campaignId/ships/:shipInstanceId/spend-xp`
- `POST /api/campaigns/:campaignId/rr/spend`
- `POST /api/campaigns/:campaignId/advance-phase`

Safety rule:

- Only campaign owner/admins should be allowed to force phase advancement, edit RR, edit targets, or correct ship state.

## 6. Frontend Pages

Add a top-level `Campaign` menu item.

Suggested page flow:

- Campaign Lobby: list active campaigns, create campaign, join campaign.
- Create Campaign: players, factions, rules variant, visibility, map generation options.
- Campaign Dashboard: turn status, player standings, target control, RR balances.
- Strategic Targets: node/card map with target details, owner, RR value, unusual features.
- Roster: persistent campaign ships, damage, crew, troops, CQ, XP, refits, carried fighters, repair status.
- Target Selection: initiative order and contested targets.
- Battle Queue: generated battles and links to tactical games.
- Post-Battle Review: import tactical result, show XP/RR/target changes before applying.
- Repairs and Reinforcements: spend RR, recruit crew/troops, repair criticals, buy ships, transfer fighters.
- Campaign Log: audit trail for all campaign state changes.

## 7. Tactical Game Integration

Add campaign-specific fields to tactical game creation:

- `campaignId`
- `campaignBattleId`
- `campaignTurnId`
- `campaignTargetId`
- `campaignScenarioKey`

Add campaign-specific fields to tactical units:

- `campaignShipInstanceId`
- `campaignPreBattleSnapshot`

Game creation must instantiate tactical units from campaign roster state, not from fresh printed stats, when the battle is campaign-linked.

Result import should be a deterministic reducer:

1. Load campaign battle and linked tactical game.
2. Verify the game is complete or admin-forced complete.
3. Snapshot every participating unit.
4. Apply destroyed/captured/surrendered roster consequences.
5. Persist surviving hull, crew, troops, carried fighters, critical effects, CQ changes, and life state.
6. Compute XP events from audit logs.
7. Apply strategic target ownership result.
8. Write RR ledger events due immediately.
9. Mark every assigned ship as used this campaign turn.
10. Append campaign log entries.

Do not silently mutate campaign state from live tactical play. Use explicit import/apply so players can inspect outcomes and admins can recover from bugs.

## 8. Implementation Slices

Slice 0 - current prep:

- Add this document.
- Add a Campaign menu/page scaffold.
- No schema migration yet.

Slice 1 - campaign shell:

- Add `campaigns`, `campaign_players`, and `campaign_log_entries`.
- Add list/create/join/read routes.
- Add Campaign Lobby and Create Campaign UI.
- Status: local implementation started.

Slice 2 - map generation:

- Add strategic target and unusual feature registries.
- Generate a campaign map from 2E rules.
- Show ownership, RR value, explored state, and unusual features.
- Status: initial local implementation generates the rolled target count,
  mandatory first Settled World, rolled subtypes and RR values, Unusual
  Features, Ancient Jump Gate feature, and Trade Route when setup is started.
  Battle and unopposed-capture ownership resolution is automated. Exploration
  rolls and the Hidden Outpost payment choice remain pending.

Slice 3 - persistent rosters:

- Add campaign ship instances.
- Build initial roster from existing ship model/fleet selection.
- Generate campaign CQ values and one allowed CQ swap.
- Status: local implementation supports setup-phase roster add/list/remove
  from live ship models, server-side 2d6 CQ generation with stored dice,
  one audited CQ swap, per-player readiness, and owner-controlled setup lock.

Slice 4 - battle creation:

- Add target nomination/challenge flow.
- Generate scenario and priority.
- Assign campaign roster ships to a tactical game.
- Lock ships to one battle per campaign turn.
- Status: local implementation now covers initiative, target nomination and
  challenge resolution, generated battle shells, secret -3 to +3 Priority
  commitments, stored 2d6 scenario/Priority rolls, rule-required scenario
  rerolls, the Supply Ships/Planetary Assault choice, asymmetric scenario FAP
  limits, campaign-roster fleet assignment, private tactical game creation,
  and deployment handoff that preserves campaign ship instance IDs. Ship
  commitments are transactionally limited to one battle per campaign turn.
  Scenario objectives still use the tactical game's current/manual adjudication
  where their bespoke victory rules have not yet been automated.

Slice 5 - post-battle importer:

- Import winner, destroyed/surrendered/captured state, persistent damage, crew, troops, criticals, fighter losses, and XP events.
- Provide review before applying.
- Status: local prep started with explicit owner-only import after tactical
  completion. It persists hull, crew, troops, carried fighter inventory,
  unresolved criticals, life state, capture/surrender state, and used-turn
  locks. Import now derives ship-local participation, cripple, skeleton,
  destruction, and forced-surrender XP from tactical audit logs; applies target
  ownership and immediate RR events idempotently; and advances the campaign once
  all current-turn battles have been imported. A richer pre-apply comparison
  screen remains pending.

Slice 6 - repairs, XP, and RR:

- Add RR ledger.
- Implement repair/recruit/reinforcement spending.
- Implement XP spending.
- Implement refit and other duty registries.
- Status: the append-only RR/XP ledger, core turn income, XP Crew Quality tests,
  XP makeshift hull repair, RR hull/critical/crew/troop repair, High Command
  repair, reinforcement purchase, carrier replenishment, Self-Repair, saved RR,
  and next-turn advancement are implemented locally. XP tactical rerolls and
  the Refit/Other Duties result tables remain pending.

Slice 7 - optional modules:

- Campaign of Terror.
- Fleet Command.
- Station module economics.
- Automated unusual-feature tactical modifiers.
- AI campaign seat support.

## 9. Required Tests

Unit tests:

- Campaign map generation produces legal target counts and exactly one Trade Route.
- Strategic target ownership and explored flags update correctly.
- Initiative applies strategic-target penalty.
- Initiative rerolls all tied commanders, including new ties created by a reroll.
- Neutral-target challenges begin with the next commander and wrap through initiative order.
- A campaign ship cannot be assigned to two battles in one campaign turn.
- Tactical result importer preserves surviving hull, crew, troops, fighters, and criticals.
- Destroyed ships leave the active roster.
- Captured/surrendered handling follows selected campaign variant.
- XP events are derived from audit logs and are ship-local.
- RR ledger is append-only and balances from ledger events.
- Self-Repairing campaign ships recover hull only.

API tests:

- Non-members cannot read private campaigns.
- Non-admins cannot force phase changes or edit RR.
- Importing the same battle result twice is idempotent.
- Campaign-linked tactical games require campaign ship assignments.

UI tests:

- Campaign route renders.
- Create campaign form validates player/faction/rules choices.
- Roster page clearly shows damaged, crippled, skeleton, destroyed, unavailable, and repaired states.
- Post-battle review shows all campaign state changes before apply.

## 10. Open Decisions Before Automation

- Should public-alpha campaigns be invite-only by default?
- Should initial campaign map generation be random-only, seeded, or admin-editable?
- Should campaign battles use only currently implemented scenarios until the remaining rulebook scenarios are automated?
- Should the first playable campaign version use admin adjudication for scenario generation and post-battle corrections?
- Should refit and other duty table results be fully automated immediately, or initially stored as named modifiers with admin review?
- How strict should Campaign of Terror be prioritized compared with the core multi-player campaign?

## 11. Recommended First Build

The first real implementation should be a campaign shell plus persistent roster, not a strategic map UI. The minimum useful campaign needs:

1. Campaign create/join.
2. Campaign roster creation from existing ship models.
3. Campaign ship instance IDs.
4. Tactical game creation from selected campaign ship instances.
5. Post-battle importer with review/apply.

Once that loop is stable, add strategic target generation and RR economy. This order avoids building a campaign map before the app can safely preserve ship state across battles.
