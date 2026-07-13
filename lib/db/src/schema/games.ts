import { pgTable, text, serial, integer, real, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
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

export const gamesTable = pgTable("games", {
  id: serial("id").primaryKey(),
  challengerId: text("challenger_id").notNull(),
  opponentId: text("opponent_id"),
  opponentKind: text("opponent_kind").notNull().default("human"),
  challengerName: text("challenger_name"),
  opponentName: text("opponent_name"),
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
  endPhaseChallengerPassed: boolean("end_phase_challenger_passed").notNull().default(false),
  endPhaseOpponentPassed: boolean("end_phase_opponent_passed").notNull().default(false),
  pointLimit: integer("point_limit").notNull().default(500),
  priorityLevel: text("priority_level").notNull().default("raid"),
  allocationPoints: integer("allocation_points").notNull().default(5),
  // "public" — anyone in the lobby can join. "private" — must supply the
  // matching password (stored as scrypt hash in passwordHash).
  visibility: text("visibility").notNull().default("public"),
  passwordHash: text("password_hash"),
  // Depth of each player's deployment zone in inches, measured inward from
  // their short edge of the 48"×72" board. Constrained to 4..30 (creation
  // is validated server-side). Dev mode bypasses this on the client.
  deploymentDepth: integer("deployment_depth").notNull().default(12),
  // Crew Quality assignment policy for this engagement.
  // "standard" → every ship is locked to CQ 4 (Veteran) and the deploy UI
  // hides the per-ship picker. "custom" → each ship's CQ is chosen during
  // deploy (1=Rookie … 6=Special Ops); the value is stored on each gameUnit.
  crewQualityMode: text("crew_quality_mode").notNull().default("standard"),
  aiProfile: text("ai_profile"),
  aiState: jsonb("ai_state").$type<Record<string, unknown>>().notNull().default({}),
  challengerFleetId: integer("challenger_fleet_id"),
  opponentFleetId: integer("opponent_fleet_id"),
  challengerDeployed: boolean("challenger_deployed").notNull().default(false),
  opponentDeployed: boolean("opponent_deployed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const gameUnitsTable = pgTable("game_units", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id").notNull(),
  ownerId: text("owner_id").notNull(),
  shipId: integer("ship_id").notNull(),
  name: text("name").notNull(),
  modelFilename: text("model_filename").notNull(),
  faction: text("faction").notNull(),
  baseRadiusInches: real("base_radius_inches").notNull().default(0.8),
  hullPoints: integer("hull_points").notNull(),
  maxHullPoints: integer("max_hull_points").notNull(),
  // Printed Damage threshold from the ship sheet. When current hullPoints is
  // at or below this value, the ship is Crippled. Older rows may carry 0 and
  // fall back to half max hull in the route layer.
  damageThreshold: integer("damage_threshold").notNull().default(0),
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
  interceptorDiceRemaining: integer("interceptor_dice_remaining").notNull().default(0),
  interceptorThresholdCurrent: integer("interceptor_threshold_current").notNull().default(2),
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
  carriedFighters: jsonb("carried_fighters").$type<CarriedFighterInventoryItem[]>().notNull().default([]),
  launchedFromUnitId: integer("launched_from_unit_id"),
  fighterBayOperationsRound: integer("fighter_bay_operations_round").notNull().default(0),
  fighterBayOperationsUsed: integer("fighter_bay_operations_used").notNull().default(0),
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
  hasInitiatedMoveThisActivation: boolean("has_initiated_move_this_activation").notNull().default(false),
  // Total inches travelled in the CURRENT movement activation (sum of
  // each /move step's hex-distance). Reset to 0 on /activate-unit. Read
  // by /end-activation to enforce the ACTA minimum-speed rule (a ship
  // must move at least ceil(effectiveMaxSpeed/2) inches each round
  // unless it declares All Stop / All Stop and Pivot, or is adrift).
  inchesMovedThisActivation: real("inches_moved_this_activation").notNull().default(0),
  // Number of heading-change turns committed in the current movement
  // activation. Reset on /activate-unit. This lets the server enforce the
  // printed Turns value, including the Crippled one-fewer-turn penalty.
  turnsMadeThisActivation: integer("turns_made_this_activation").notNull().default(0),
  // Distance moved in a straight line since the most recent committed turn
  // in the current movement activation. Reset on /activate-unit and after
  // each turn. Used to enforce ACTA's "2 inches after turning" rule.
  distanceSinceLastTurnThisActivation: real("distance_since_last_turn_this_activation").notNull().default(0),
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
  firedWeaponIds: jsonb("fired_weapon_ids").$type<number[]>().notNull().default([]),
  // Slow-Loading weapon cooldowns, keyed by weapons.id. Value is the first
  // round in which that weapon may fire again. Example: fired in round 2 →
  // blocked in round 3 → usable again in round 4.
  slowLoadingWeaponCooldowns: jsonb("slow_loading_weapon_cooldowns").$type<Record<string, number>>().notNull().default({}),
  // Allied attacker unit IDs that have landed at least one to-hit on THIS
  // unit during the current round. Used to apply the Stealth "fleet support"
  // -1 modifier per the sheet: if another fleet member (still on the table,
  // not adrift or destroyed) has already successfully attacked this target
  // this round, every subsequent attacker drops the target's Stealth by an
  // additional -1. Cleared at round rollover.
  hitByUnitIdsThisRound: jsonb("hit_by_unit_ids_this_round").$type<number[]>().notNull().default([]),
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
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gameSpecialActionAuditLogsTable = pgTable("game_special_action_audit_logs", {
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
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gameChatMessagesTable = pgTable("game_chat_messages", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id").notNull(),
  senderPlayerId: text("sender_player_id").notNull(),
  senderName: text("sender_name"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertGameSchema = createInsertSchema(gamesTable).omit({ id: true, status: true, winnerId: true, currentTurn: true, challengerDeployed: true, opponentDeployed: true, createdAt: true, updatedAt: true });
export type InsertGame = z.infer<typeof insertGameSchema>;
export type Game = typeof gamesTable.$inferSelect;

export const insertGameUnitSchema = createInsertSchema(gameUnitsTable).omit({ id: true });
export type InsertGameUnit = z.infer<typeof insertGameUnitSchema>;
export type GameUnit = typeof gameUnitsTable.$inferSelect;

export const insertTurnSchema = createInsertSchema(turnsTable).omit({ id: true, resolvedAt: true });
export type InsertTurn = z.infer<typeof insertTurnSchema>;
export type Turn = typeof turnsTable.$inferSelect;

export type GameAttackAuditLog = typeof gameAttackAuditLogsTable.$inferSelect;
export type GameMovementAuditLog = typeof gameMovementAuditLogsTable.$inferSelect;
export type GameSpecialActionAuditLog = typeof gameSpecialActionAuditLogsTable.$inferSelect;
export type BugReport = typeof bugReportsTable.$inferSelect;
export type GameChatMessage = typeof gameChatMessagesTable.$inferSelect;
