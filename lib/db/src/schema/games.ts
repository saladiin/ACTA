import {
  pgTable,
  text,
  serial,
  integer,
  real,
  timestamp,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type CarriedFighterInventoryItem = {
  name: string;
  shipModelId: number | null;
  total: number;
  available: number;
  launched: number;
  recovered: number;
  destroyed: number;
};

export type AncientStatusEffect = {
  kind: "physical-disruption" | "telepathic-disruption";
  sourceUnitId: number;
  appliedRound: number;
  expiresAfterRound: number;
  releaseWhenSourceDestroyed: boolean;
};

export type JumpPointVfxPreset = {
  stationId: string;
  label: string;
  source: string;
  effect: string;
  tuning: Record<string, unknown>;
};

export const JUMP_POINT_VFX_PRESET: JumpPointVfxPreset = {
  stationId: "new-hyperspace-point-mesh",
  label: "New Hyperspace Portal",
  source: "vfx-showcase-preview-only",
  effect: "godot-jump-point-mesh",
  tuning: {
    color: "#38e8ff",
    secondaryColor: "#014cff",
    speed: 1.35,
    size: 1.15,
    fade: 1.15,
    intensity: 1.6,
    spread: 1.25,
    count: 8,
    arc: 1.1,
    thickness: 1,
    portalOffset: -5,
    rotationX: 90,
    rotationY: 180,
  },
};

export const gamesTable = pgTable("games", {
  id: serial("id").primaryKey(),
  challengerId: text("challenger_id").notNull(),
  opponentId: text("opponent_id"),
  opponentKind: text("opponent_kind").notNull().default("human"),
  challengerName: text("challenger_name"),
  opponentName: text("opponent_name"),
  matchName: text("match_name"),
  status: text("status").notNull().default("pending"),
  winnerId: text("winner_id"),
  currentTurn: integer("current_turn").notNull().default(0),
  currentRound: integer("current_round").notNull().default(1),
  // Ship-by-ship alternating activation state. activePlayerId is the player
  // whose turn it is to activate a ship right now; activeUnitId is the ship
  // they have currently picked up (null = they still need to pick one).
  // lastActivatorId is whoever ran the most recent activation, used to decide
  // initiative for the next round (last-mover-goes-second-next-round).
  activePlayerId: text("active_player_id"),
  activeUnitId: integer("active_unit_id"),
  lastActivatorId: text("last_activator_id"),
  // Each round is split into FOUR sub-phases:
  //   initiative — both players roll 2d6; high roll wins (ties re-roll).
  //                Winner activates first in movement, firing, and end.
  //   movement   — ships activate alternately to move/turn.
  //   firing     — ships activate alternately to shoot.
  //   end        — damage-control window. Initiative winner repairs first,
  //                then opponent, then round advances.
  phase: text("phase").notNull().default("initiative"),
  initiativeWinnerId: text("initiative_winner_id"),
  // Per-round initiative dice. Null = that player has not yet rolled this
  // round. Both filled & unequal → winner picked, rolls cleared on phase
  // transition out of "initiative". Both filled & equal → tie; rolls
  // cleared so players re-roll.
  initiativeChallengerRoll: integer("initiative_challenger_roll"),
  initiativeOpponentRoll: integer("initiative_opponent_roll"),
  // Per-player "I've passed the end phase" latches. Cleared at the start
  // of every end phase. When both are true, the round advances.
  endPhaseChallengerPassed: boolean("end_phase_challenger_passed")
    .notNull()
    .default(false),
  endPhaseOpponentPassed: boolean("end_phase_opponent_passed")
    .notNull()
    .default(false),
  pointLimit: integer("point_limit").notNull().default(500),
  priorityLevel: text("priority_level").notNull().default("raid"),
  allocationPoints: integer("allocation_points").notNull().default(5),
  // Engagement-specific visual backdrop, shared by both commanders.
  skybox: text("skybox").notNull().default("bright-nebula"),
  // "public" — anyone in the lobby can join. "private" — must supply the
  // matching password (stored as scrypt hash in passwordHash).
  visibility: text("visibility").notNull().default("public"),
  passwordHash: text("password_hash"),
  allowObservers: boolean("allow_observers").notNull().default(false),
  // Depth of each player's deployment zone in inches, measured inward from
  // their short edge of the 48"×72" board. Constrained to 4..30 (creation
  // is validated server-side). Dev mode bypasses this on the client.
  deploymentDepth: integer("deployment_depth").notNull().default(12),
  // Optional structured deployment regions. Old games with null config fall
  // back to the depth-only short-edge strips above.
  deploymentConfig: jsonb("deployment_config")
    .$type<Record<string, unknown> | null>()
    .default(null),
  // Persisted terrain/scenery setup generated at engagement creation. Terrain
  // is rules-authoritative only through server-normalized footprints, not
  // through render meshes.
  terrainConfig: jsonb("terrain_config")
    .$type<Record<string, unknown> | null>()
    .default(null),
  // Persisted station/scenery setup selected at engagement creation. This
  // currently flags station-enabled scenarios and leaves object placement for
  // dedicated station deployment/rules flows.
  stationConfig: jsonb("station_config")
    .$type<Record<string, unknown> | null>()
    .default(null),
  withdrawalConfig: jsonb("withdrawal_config")
    .$type<Record<string, unknown> | null>()
    .default(null),
  challengerVictoryPoints: real("challenger_victory_points").notNull().default(0),
  opponentVictoryPoints: real("opponent_victory_points").notNull().default(0),
  campaignId: integer("campaign_id"),
  campaignTurnId: integer("campaign_turn_id"),
  campaignBattleId: integer("campaign_battle_id"),
  campaignTargetId: integer("campaign_target_id"),
  campaignScenarioKey: text("campaign_scenario_key"),
  // Crew Quality assignment policy for this engagement.
  // "standard" → every ship is locked to CQ 4 (Veteran) and the deploy UI
  // hides the per-ship picker. "custom" → each ship's CQ is chosen during
  // deploy (1=Rookie … 6=Special Ops); the value is stored on each gameUnit.
  crewQualityMode: text("crew_quality_mode").notNull().default("standard"),
  aiProfile: text("ai_profile"),
  aiState: jsonb("ai_state")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  challengerFleetId: integer("challenger_fleet_id"),
  opponentFleetId: integer("opponent_fleet_id"),
  challengerDeployed: boolean("challenger_deployed").notNull().default(false),
  opponentDeployed: boolean("opponent_deployed").notNull().default(false),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archiveExpiresAt: timestamp("archive_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const gameUnitsTable = pgTable("game_units", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id").notNull(),
  ownerId: text("owner_id").notNull(),
  shipId: integer("ship_id").notNull(),
  campaignShipInstanceId: integer("campaign_ship_instance_id"),
  campaignPreBattleSnapshot: jsonb("campaign_pre_battle_snapshot")
    .$type<Record<string, unknown> | null>()
    .default(null),
  name: text("name").notNull(),
  modelFilename: text("model_filename").notNull(),
  faction: text("faction").notNull(),
  baseRadiusInches: real("base_radius_inches").notNull().default(0.8),
  // "deployed" units exist in realspace on the board. "hyperspace" units
  // are reserve units held off-table until a jump point brings them in.
  boardState: text("board_state").notNull().default("deployed"),
  departureReason: text("departure_reason"),
  departureEdge: text("departure_edge"),
  departureRound: integer("departure_round"),
  departureConsequence: text("departure_consequence"),
  hullPoints: integer("hull_points").notNull(),
  maxHullPoints: integer("max_hull_points").notNull(),
  // Printed Damage threshold from the ship sheet. When current hullPoints is
  // at or below this value, the ship is Crippled. 0 means the profile has no
  // normal cripple threshold.
  damageThreshold: integer("damage_threshold").notNull().default(0),
  physicalDisruptionThreshold: integer("physical_disruption_threshold")
    .notNull()
    .default(0),
  // Self Repair may raise hull above the printed threshold, but an Ancient
  // that has ever become Crippled remains Crippled for the battle.
  permanentlyCrippled: boolean("permanently_crippled")
    .notNull()
    .default(false),
  ancientStatusEffects: jsonb("ancient_status_effects")
    .$type<AncientStatusEffect[]>()
    .notNull()
    .default([]),
  // Shadow-specific round state. These are ordinary profile abilities, not
  // Special Actions, and therefore cannot share specialAction.
  shadowPointDefenseRound: integer("shadow_point_defense_round")
    .notNull()
    .default(0),
  shadowManeuverMode: text("shadow_maneuver_mode"),
  mindScreamTargetIdsThisRound: jsonb("mind_scream_target_ids_this_round")
    .$type<number[]>()
    .notNull()
    .default([]),
  telepathicTargetsAttemptedThisRound: jsonb(
    "telepathic_targets_attempted_this_round",
  )
    .$type<number[]>()
    .notNull()
    .default([]),
  telepathicDisruptionExhausted: boolean("telepathic_disruption_exhausted")
    .notNull()
    .default(false),
  // Current shield pool (Shields X). Refilled toward shieldMax at the end of
  // each round per shieldRegenRate. Initialized to ship_model.shieldMax at
  // deploy. Absorbs incoming hits in the damage pipeline before the Attack
  // Table is rolled, scaled by the attacker's damage multiplier (Double /
  // Triple / Quad). Mass Driver and Energy Mine bypass shields.
  shieldsCurrent: integer("shields_current").notNull().default(0),
  // Per-turn Interceptor state. Per the sheet, a ship has Interceptors X
  // dice each turn rolling at a degrading threshold: start at 2+ with all
  // X dice; any die that rolls a 1 during an interception attempt is
  // permanently lost for the rest of the turn, and the threshold ramps
  // (2+ → 3+ → 4+ → 5+ → 6+) as dice are burned. The final remaining die
  // always intercepts on 6+. Both fields persist across attacks within a
  // turn and are refreshed at end-of-round (max dice, threshold 2).
  interceptorDiceRemaining: integer("interceptor_dice_remaining")
    .notNull()
    .default(0),
  interceptorThresholdCurrent: integer("interceptor_threshold_current")
    .notNull()
    .default(2),
  // Last round in which this unit attempted Damage Control (Slice B). Used
  // to enforce the once-per-end-phase-per-unit cap. 0 means never.
  lastDcRound: integer("last_dc_round").notNull().default(0),
  // Last round in which this unit resolved a Self Repair trait roll. This is
  // separate from Damage Control: Self Repair restores hull points, while DC
  // removes critical-effect rows.
  lastSelfRepairRound: integer("last_self_repair_round").notNull().default(0),
  // Crew aboard the ship. Reduced by attack-table crew rolls, certain
  // critical effects, and boarding actions. When ≤ ½ maxCrewPoints the
  // ship is treated as "Skeleton Crew" (no SA, only 1 weapon system fires,
  // -2 DC, troops halved, lose Command/Fleet Carrier/Admiral). When
  // crewPoints hits 0 the ship is adrift.
  crewPoints: integer("crew_points").notNull().default(0),
  maxCrewPoints: integer("max_crew_points").notNull().default(0),
  // Boarding Troops aboard the ship. Printed model Troops are copied here at
  // deployment, then reduced by troop-loss criticals and boarding commitments.
  troopPoints: integer("troop_points").notNull().default(0),
  maxTroopPoints: integer("max_troop_points").notNull().default(0),
  // Capture/surrender state is tracked separately from ownerId so activation,
  // perspective, and historical audit logs remain stable.
  capturedByOwnerId: text("captured_by_owner_id"),
  capturedRound: integer("captured_round"),
  surrenderedToOwnerId: text("surrendered_to_owner_id"),
  surrenderedRound: integer("surrendered_round"),
  // Printed Crew threshold from the ship sheet. When current crewPoints is at
  // or below this value, the ship has Skeleton Crew. 0 means "use fallback" or
  // "ship has no crew track".
  crewThreshold: integer("crew_threshold").notNull().default(0),
  // Authoritative life-state of the ship for damage-table resolution.
  //   "normal"               — undamaged or merely scarred; default.
  //   "adrift"               — failed damage-table or out of crew; halved
  //                            speed, compulsory end-phase drift.
  //   "exploding-end-of-next"— delayed catastrophic kill; explodes at the
  //                            end of the following round.
  //   "destroyed"            — gone (also mirrored by `isDestroyed`).
  damageState: text("damage_state").notNull().default("normal"),
  // Fighter flights carried by this unit, parsed from ship_models.small_craft
  // at deployment. This is the authoritative carrier bay inventory for future
  // launch/recovery rules; independently deployed fighters simply have [].
  carriedFighters: jsonb("carried_fighters")
    .$type<CarriedFighterInventoryItem[]>()
    .notNull()
    .default([]),
  launchedFromUnitId: integer("launched_from_unit_id"),
  fighterBayOperationsRound: integer("fighter_bay_operations_round")
    .notNull()
    .default(0),
  fighterBayOperationsUsed: integer("fighter_bay_operations_used")
    .notNull()
    .default(0),
  hexQ: real("hex_q").notNull().default(0),
  hexR: real("hex_r").notNull().default(0),
  heading: integer("heading").notNull().default(0),
  speed: integer("speed").notNull(),
  turnAngle: integer("turn_angle").notNull().default(45),
  turns: integer("turns").notNull().default(1),
  weaponRange: integer("weapon_range").notNull(),
  weaponDamage: integer("weapon_damage").notNull(),
  // Crew Quality (1..6). Set at deploy time. In "standard" games this is
  // always 4 (Veteran); in "custom" games each ship may be assigned
  // individually. Affects to-hit thresholds in combat resolution.
  crewQuality: integer("crew_quality").notNull().default(4),
  // Special Action chosen by this ship for the current round. Null until the
  // owner spends one in the movement phase. Cleared at round rollover.
  // Recognized values (others rejected at the route layer):
  //   "all-power-engines", "all-stop", "all-stop-pivot",
  //   "come-about-extra-turn", "come-about-sharp-turn",
  //   "blast-doors", "intensify-defense", "run-silent", "concentrate-fire".
  // A failed CQ attempt is recorded by appending "-failed" (e.g.
  // "run-silent-failed") so the client can show the attempt while still
  // applying the always-on restrictions that come with trying.
  specialAction: text("special_action"),
  // For "concentrate-fire": the nominated target unit id. Read by the
  // fire-weapon route to gate the re-roll bonus.
  specialActionTargetId: integer("special_action_target_id"),
  // Scout-trait support action declared this round. One per round per
  // ship. Cleared at round rollover alongside specialAction.
  // Recognized values (others rejected at the route layer):
  //   "counter-stealth", "counter-stealth-failed",
  //   "coord", "coord-failed".
  // Coordination is consumed when an allied weapon spends the re-roll
  // (scoutCoordConsumed flips true); counter-stealth is "always-on"
  // for the round once successful.
  scoutAction: text("scout_action"),
  scoutActionTargetId: integer("scout_action_target_id"),
  // True after a successful 'coord' has been spent on one weapon
  // system this round. Cleared at round rollover.
  scoutCoordConsumed: boolean("scout_coord_consumed").notNull().default(false),
  // "All Stop and Pivot" prerequisite latch. Set true when a ship
  // successfully declares "all-stop". Persists across round rollover (the
  // pivot is granted to ships that spent the prior round at All Stop).
  // Cleared when (a) the ship moves via /move, or (b) it declares
  // "all-stop-pivot" (consumed). Declaring "all-stop-pivot" requires this
  // flag to be true.
  allStopReady: boolean("all_stop_ready").notNull().default(false),
  isDestroyed: boolean("is_destroyed").notNull().default(false),
  hasMovedThisRound: boolean("has_moved_this_round").notNull().default(false),
  // Per-activation movement guard (NOT hasMovedThisRound — that latches
  // only at end-activation). Reset to false on /activate-unit, set true
  // on any successful /move. Read by /special-action to refuse SA
  // declarations after a ship has already committed any movement this
  // activation — closes the bypass where /move could be called first to
  // change heading, then /special-action all-stop could arm allStopReady.
  hasInitiatedMoveThisActivation: boolean("has_initiated_move_this_activation")
    .notNull()
    .default(false),
  // Total inches travelled in the CURRENT movement activation (sum of
  // each /move step's hex-distance). Reset to 0 on /activate-unit. Read
  // by /end-activation to enforce the ACTA minimum-speed rule (a ship
  // must move at least ceil(effectiveMaxSpeed/2) inches each round
  // unless it declares All Stop / All Stop and Pivot, or is adrift).
  inchesMovedThisActivation: real("inches_moved_this_activation")
    .notNull()
    .default(0),
  // Number of heading-change turns committed in the current movement
  // activation. Reset on /activate-unit. This lets the server enforce the
  // printed Turns value, including the Crippled one-fewer-turn penalty.
  turnsMadeThisActivation: integer("turns_made_this_activation")
    .notNull()
    .default(0),
  // Distance moved in a straight line since the most recent committed turn
  // in the current movement activation. Reset on /activate-unit and after
  // each turn. Used to enforce ACTA's "2 inches after turning" rule.
  distanceSinceLastTurnThisActivation: real(
    "distance_since_last_turn_this_activation",
  )
    .notNull()
    .default(0),
  // Last round in which the server applied automatic End Phase adrift drift.
  // Prevents double-drift if End Phase bookkeeping is retried or a ship was
  // already marked adrift before the current round.
  lastAdriftDriftRound: integer("last_adrift_drift_round").notNull().default(0),
  hasFiredThisRound: boolean("has_fired_this_round").notNull().default(false),
  // "All Hands on Deck" cost: when set, this ship may only fire ONE weapon
  // system this round (per ACTA rule). Set at round rollover for any ship
  // whose previous-round specialAction was "all-hands-on-deck" (success).
  // Cleared at the next round rollover (one-round latch).
  oneWeaponThisRound: boolean("one_weapon_this_round").notNull().default(false),
  // Weapons this ship has already discharged DURING the current firing
  // activation. Reset to [] each time the ship is picked up for activation so
  // the server can authoritatively enforce one-shot-per-weapon. (Per the
  // rules, each weapon can fire at one target per firing activation.)
  firedWeaponIds: jsonb("fired_weapon_ids")
    .$type<number[]>()
    .notNull()
    .default([]),
  // One-Shot weapons are spent for the rest of the battle after a successful
  // firing attempt. Store stable weapon keys rather than raw weapon ids so
  // seed maintenance can renumber weapons without re-enabling spent ordnance.
  spentOneShotWeaponKeys: jsonb("spent_one_shot_weapon_keys")
    .$type<string[]>()
    .notNull()
    .default([]),
  splitFireFirstTargetByWeapon: jsonb("split_fire_first_target_by_weapon")
    .$type<Record<string, number>>()
    .notNull()
    .default({}),
  // Slow-Loading weapon cooldowns, keyed by weapons.id. Value is the first
  // round in which that weapon may fire again. Example: fired in round 2 →
  // blocked in round 3 → usable again in round 4.
  slowLoadingWeaponCooldowns: jsonb("slow_loading_weapon_cooldowns")
    .$type<Record<string, number>>()
    .notNull()
    .default({}),
  // Allied attacker unit IDs that have landed at least one to-hit on THIS
  // unit during the current round. Used to apply the Stealth "fleet support"
  // -1 modifier per the sheet: if another fleet member (still on the table,
  // not adrift or destroyed) has already successfully attacked this target
  // this round, every subsequent attacker drops the target's Stealth by an
  // additional -1. Cleared at round rollover.
  hitByUnitIdsThisRound: jsonb("hit_by_unit_ids_this_round")
    .$type<number[]>()
    .notNull()
    .default([]),
});

export const gameJumpPointsTable = pgTable("game_jump_points", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id").notNull(),
  ownerId: text("owner_id").notNull(),
  creatorUnitId: integer("creator_unit_id").notNull(),
  direction: text("direction").notNull().default("to-hyperspace"),
  hexQ: real("hex_q").notNull(),
  hexR: real("hex_r").notNull(),
  baseRadiusInches: real("base_radius_inches").notNull().default(1.5),
  heading: integer("heading").notNull().default(0),
  createdRound: integer("created_round").notNull(),
  expiresAfterRound: integer("expires_after_round").notNull(),
  status: text("status").notNull().default("open"),
  shockWaveArmed: boolean("shock_wave_armed").notNull().default(false),
  shockWaveResolved: boolean("shock_wave_resolved").notNull().default(false),
  vfxPreset: jsonb("vfx_preset")
    .$type<JumpPointVfxPreset>()
    .notNull()
    .default(JUMP_POINT_VFX_PRESET),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const gameBoardingActionsTable = pgTable("game_boarding_actions", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id").notNull(),
  round: integer("round").notNull(),
  targetUnitId: integer("target_unit_id").notNull(),
  attackerOwnerId: text("attacker_owner_id").notNull(),
  sourceUnitId: integer("source_unit_id"),
  sourceFlightUnitId: integer("source_flight_unit_id"),
  troopsCommitted: integer("troops_committed").notNull().default(0),
  troopsRemaining: integer("troops_remaining").notNull().default(0),
  deliveryType: text("delivery_type").notNull().default("ship"),
  status: text("status").notNull().default("pending"),
  createdPhase: text("created_phase").notNull().default("movement"),
  resolvedRound: integer("resolved_round"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const turnsTable = pgTable("turns", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id").notNull(),
  playerId: text("player_id").notNull(),
  turnNumber: integer("turn_number").notNull(),
  moves: jsonb("moves").notNull().default([]),
  attacks: jsonb("attacks").notNull().default([]),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export const gameAttackAuditLogsTable = pgTable("game_attack_audit_logs", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id").notNull(),
  round: integer("round").notNull(),
  phase: text("phase").notNull(),
  actorKind: text("actor_kind").notNull().default("player"),
  actorPlayerId: text("actor_player_id"),
  attackerUnitId: integer("attacker_unit_id").notNull(),
  targetUnitId: integer("target_unit_id").notNull(),
  weaponId: integer("weapon_id").notNull(),
  summary: text("summary").notNull(),
  payload: jsonb("payload")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const gameMovementAuditLogsTable = pgTable("game_movement_audit_logs", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id").notNull(),
  round: integer("round").notNull(),
  phase: text("phase").notNull(),
  actorKind: text("actor_kind").notNull().default("player"),
  actorPlayerId: text("actor_player_id"),
  unitId: integer("unit_id").notNull(),
  movementKind: text("movement_kind").notNull().default("move"),
  summary: text("summary").notNull(),
  payload: jsonb("payload")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const gameSpecialActionAuditLogsTable = pgTable(
  "game_special_action_audit_logs",
  {
    id: serial("id").primaryKey(),
    gameId: integer("game_id").notNull(),
    round: integer("round").notNull(),
    phase: text("phase").notNull(),
    actorKind: text("actor_kind").notNull().default("player"),
    actorPlayerId: text("actor_player_id"),
    unitId: integer("unit_id").notNull(),
    action: text("action").notNull(),
    success: boolean("success").notNull(),
    cqRequired: integer("cq_required"),
    cqRoll: integer("cq_roll"),
    cqTotal: integer("cq_total"),
    targetUnitId: integer("target_unit_id"),
    summary: text("summary").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const bugReportsTable = pgTable("bug_reports", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id").notNull(),
  reporterPlayerId: text("reporter_player_id").notNull(),
  round: integer("round").notNull(),
  phase: text("phase").notNull(),
  activePlayerId: text("active_player_id"),
  activeUnitId: integer("active_unit_id"),
  message: text("message").notNull(),
  rescueRequested: boolean("rescue_requested").notNull().default(false),
  rescueApplied: boolean("rescue_applied").notNull().default(false),
  snapshot: jsonb("snapshot")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedByAdminId: text("resolved_by_admin_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const gameChatMessagesTable = pgTable("game_chat_messages", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id").notNull(),
  senderPlayerId: text("sender_player_id").notNull(),
  senderName: text("sender_name"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const gameObserversTable = pgTable("game_observers", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id").notNull(),
  userId: text("user_id").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const lobbyChatMessagesTable = pgTable("lobby_chat_messages", {
  id: serial("id").primaryKey(),
  senderPlayerId: text("sender_player_id").notNull(),
  senderName: text("sender_name"),
  message: text("message").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedByAdminId: text("deleted_by_admin_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertGameSchema = createInsertSchema(gamesTable).omit({
  id: true,
  status: true,
  winnerId: true,
  currentTurn: true,
  challengerDeployed: true,
  opponentDeployed: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertGame = z.infer<typeof insertGameSchema>;
export type Game = typeof gamesTable.$inferSelect;

export const insertGameUnitSchema = createInsertSchema(gameUnitsTable).omit({
  id: true,
});
export type InsertGameUnit = z.infer<typeof insertGameUnitSchema>;
export type GameUnit = typeof gameUnitsTable.$inferSelect;

export const insertTurnSchema = createInsertSchema(turnsTable).omit({
  id: true,
  resolvedAt: true,
});
export type InsertTurn = z.infer<typeof insertTurnSchema>;
export type Turn = typeof turnsTable.$inferSelect;

export type GameAttackAuditLog = typeof gameAttackAuditLogsTable.$inferSelect;
export type GameMovementAuditLog =
  typeof gameMovementAuditLogsTable.$inferSelect;
export type GameSpecialActionAuditLog =
  typeof gameSpecialActionAuditLogsTable.$inferSelect;
export type GameBoardingAction =
  typeof gameBoardingActionsTable.$inferSelect;
export type BugReport = typeof bugReportsTable.$inferSelect;
export type GameChatMessage = typeof gameChatMessagesTable.$inferSelect;
export type LobbyChatMessage = typeof lobbyChatMessagesTable.$inferSelect;
