import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const campaignsTable = pgTable("campaigns", {
  id: serial("id").primaryKey(),
  ownerPlayerId: text("owner_player_id").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("setup"),
  ruleset: text("ruleset").notNull().default("acta-2e"),
  variant: text("variant").notNull().default("core"),
  visibility: text("visibility").notNull().default("private"),
  currentTurn: integer("current_turn").notNull().default(0),
  phase: text("phase").notNull().default("setup"),
  settings: jsonb("settings")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const campaignPlayersTable = pgTable("campaign_players", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  playerId: text("player_id").notNull(),
  displayName: text("display_name"),
  faction: text("faction"),
  role: text("role").notNull().default("member"),
  status: text("status").notNull().default("active"),
  ready: boolean("ready").notNull().default(false),
  crewQualitySwapUsed: boolean("crew_quality_swap_used").notNull().default(false),
  initiativeModifier: integer("initiative_modifier").notNull().default(0),
  joinedAt: timestamp("joined_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const campaignLogEntriesTable = pgTable("campaign_log_entries", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  turnNumber: integer("turn_number").notNull().default(0),
  actorPlayerId: text("actor_player_id"),
  type: text("type").notNull(),
  message: text("message").notNull(),
  payload: jsonb("payload")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const campaignTurnsTable = pgTable("campaign_turns", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  turnNumber: integer("turn_number").notNull(),
  status: text("status").notNull().default("planning"),
  initiativeOrder: jsonb("initiative_order")
    .$type<string[]>()
    .notNull()
    .default([]),
  targetSelectionIndex: integer("target_selection_index").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const campaignStrategicTargetsTable = pgTable("campaign_strategic_targets", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  sequence: integer("sequence").notNull(),
  key: text("key").notNull(),
  category: text("category").notNull(),
  subtype: text("subtype").notNull(),
  name: text("name").notNull(),
  ownerPlayerId: text("owner_player_id"),
  rrValue: integer("rr_value").notNull().default(0),
  rrFormula: text("rr_formula"),
  explored: boolean("explored").notNull().default(true),
  isTradeRoute: boolean("is_trade_route").notNull().default(false),
  categoryRoll: integer("category_roll"),
  subtypeRoll: integer("subtype_roll"),
  unusualFeatures: jsonb("unusual_features")
    .$type<Array<Record<string, unknown>>>()
    .notNull()
    .default([]),
  rulesPayload: jsonb("rules_payload")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const campaignInitiativeRollsTable = pgTable("campaign_initiative_rolls", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  campaignTurnId: integer("campaign_turn_id").notNull(),
  playerId: text("player_id").notNull(),
  dice: jsonb("dice").$type<number[]>().notNull().default([]),
  fleetModifier: integer("fleet_modifier").notNull().default(0),
  targetPenalty: integer("target_penalty").notNull().default(0),
  initialTotal: integer("initial_total").notNull(),
  finalTotal: integer("final_total").notNull(),
  rerolls: jsonb("rerolls")
    .$type<Array<{ dice: number[]; total: number }>>()
    .notNull()
    .default([]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const campaignTargetNominationsTable = pgTable("campaign_target_nominations", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  campaignTurnId: integer("campaign_turn_id").notNull(),
  turnNumber: integer("turn_number").notNull(),
  sequence: integer("sequence").notNull(),
  nominatorPlayerId: text("nominator_player_id").notNull(),
  targetId: integer("target_id").notNull(),
  targetOwnerPlayerId: text("target_owner_player_id"),
  defenderPlayerId: text("defender_player_id"),
  challengerPlayerId: text("challenger_player_id"),
  challengeOrder: jsonb("challenge_order").$type<string[]>().notNull().default([]),
  challengeIndex: integer("challenge_index").notNull().default(0),
  declinedPlayerIds: jsonb("declined_player_ids").$type<string[]>().notNull().default([]),
  status: text("status").notNull().default("awaiting-challenge"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const campaignBattlesTable = pgTable("campaign_battles", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  campaignTurnId: integer("campaign_turn_id"),
  nominationId: integer("nomination_id"),
  turnNumber: integer("turn_number").notNull().default(0),
  targetId: integer("target_id"),
  attackerPlayerId: text("attacker_player_id").notNull(),
  defenderPlayerId: text("defender_player_id").notNull(),
  tacticalGameId: integer("tactical_game_id"),
  name: text("name"),
  scenarioKey: text("scenario_key").notNull().default("campaign-linked-battle"),
  priorityLevel: text("priority_level").notNull().default("raid"),
  rulesSnapshot: jsonb("rules_snapshot")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  status: text("status").notNull().default("deployment"),
  resultPayload: jsonb("result_payload")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const campaignBattleShipAssignmentsTable = pgTable("campaign_battle_ship_assignments", {
  id: serial("id").primaryKey(),
  campaignBattleId: integer("campaign_battle_id").notNull(),
  campaignShipInstanceId: integer("campaign_ship_instance_id").notNull(),
  tacticalShipId: integer("tactical_ship_id"),
  tacticalGameUnitId: integer("tactical_game_unit_id"),
  side: text("side").notNull(),
  preBattleSnapshot: jsonb("pre_battle_snapshot")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  postBattleSnapshot: jsonb("post_battle_snapshot")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const campaignShipInstancesTable = pgTable("campaign_ship_instances", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  ownerPlayerId: text("owner_player_id").notNull(),
  sourceShipModelId: integer("source_ship_model_id").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  hullCurrent: integer("hull_current").notNull(),
  hullMax: integer("hull_max").notNull(),
  crewCurrent: integer("crew_current").notNull().default(0),
  crewMax: integer("crew_max").notNull().default(0),
  troopsCurrent: integer("troops_current").notNull().default(0),
  troopsMax: integer("troops_max").notNull().default(0),
  crewQuality: integer("crew_quality").notNull().default(4),
  crewQualityRoll: integer("crew_quality_roll"),
  crewQualityDice: jsonb("crew_quality_dice")
    .$type<number[]>()
    .notNull()
    .default([]),
  xpDice: integer("xp_dice").notNull().default(0),
  refits: jsonb("refits")
    .$type<Array<Record<string, unknown>>>()
    .notNull()
    .default([]),
  duties: jsonb("duties")
    .$type<Array<Record<string, unknown>>>()
    .notNull()
    .default([]),
  carriedFighters: jsonb("carried_fighters")
    .$type<Array<Record<string, unknown>>>()
    .notNull()
    .default([]),
  criticalEffects: jsonb("critical_effects")
    .$type<Array<Record<string, unknown>>>()
    .notNull()
    .default([]),
  unavailableUntilTurn: integer("unavailable_until_turn").notNull().default(0),
  crewQualityAttemptedTurn: integer("crew_quality_attempted_turn").notNull().default(0),
  crippledRepairPaidTurn: integer("crippled_repair_paid_turn").notNull().default(0),
  usedTurn: integer("used_turn").notNull().default(0),
  destroyed: boolean("destroyed").notNull().default(false),
  capturedByPlayerId: text("captured_by_player_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertCampaignSchema = createInsertSchema(campaignsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type Campaign = typeof campaignsTable.$inferSelect;

export const insertCampaignPlayerSchema = createInsertSchema(campaignPlayersTable).omit({
  id: true,
  joinedAt: true,
  updatedAt: true,
});
export type InsertCampaignPlayer = z.infer<typeof insertCampaignPlayerSchema>;
export type CampaignPlayer = typeof campaignPlayersTable.$inferSelect;

export const insertCampaignLogEntrySchema = createInsertSchema(campaignLogEntriesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCampaignLogEntry = z.infer<typeof insertCampaignLogEntrySchema>;
export type CampaignLogEntry = typeof campaignLogEntriesTable.$inferSelect;

export const insertCampaignTurnSchema = createInsertSchema(campaignTurnsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCampaignTurn = z.infer<typeof insertCampaignTurnSchema>;
export type CampaignTurn = typeof campaignTurnsTable.$inferSelect;

export const insertCampaignInitiativeRollSchema = createInsertSchema(campaignInitiativeRollsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const campaignTurnPlayerStatesTable = pgTable("campaign_turn_player_states", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  campaignTurnId: integer("campaign_turn_id").notNull(),
  turnNumber: integer("turn_number").notNull(),
  playerId: text("player_id").notNull(),
  experienceComplete: boolean("experience_complete").notNull().default(false),
  rrIncomeGenerated: boolean("rr_income_generated").notNull().default(false),
  repairsComplete: boolean("repairs_complete").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const campaignResourceLedgerTable = pgTable("campaign_resource_ledger", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  campaignTurnId: integer("campaign_turn_id"),
  turnNumber: integer("turn_number").notNull(),
  playerId: text("player_id").notNull(),
  campaignShipInstanceId: integer("campaign_ship_instance_id"),
  resource: text("resource").notNull(),
  amount: integer("amount").notNull(),
  eventKey: text("event_key").notNull(),
  type: text("type").notNull(),
  message: text("message").notNull(),
  payload: jsonb("payload")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const campaignTargetOwnershipEventsTable = pgTable("campaign_target_ownership_events", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  campaignTurnId: integer("campaign_turn_id").notNull(),
  turnNumber: integer("turn_number").notNull(),
  targetId: integer("target_id").notNull(),
  previousOwnerPlayerId: text("previous_owner_player_id"),
  newOwnerPlayerId: text("new_owner_player_id"),
  campaignBattleId: integer("campaign_battle_id"),
  nominationId: integer("nomination_id"),
  eventKey: text("event_key").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const campaignBattlePriorityChoicesTable = pgTable("campaign_battle_priority_choices", {
  id: serial("id").primaryKey(),
  campaignBattleId: integer("campaign_battle_id").notNull(),
  playerId: text("player_id").notNull(),
  modifier: integer("modifier").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export type InsertCampaignInitiativeRoll = z.infer<typeof insertCampaignInitiativeRollSchema>;
export type CampaignInitiativeRoll = typeof campaignInitiativeRollsTable.$inferSelect;

export const insertCampaignTargetNominationSchema = createInsertSchema(campaignTargetNominationsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCampaignTargetNomination = z.infer<typeof insertCampaignTargetNominationSchema>;
export type CampaignTargetNomination = typeof campaignTargetNominationsTable.$inferSelect;

export const insertCampaignStrategicTargetSchema = createInsertSchema(campaignStrategicTargetsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCampaignStrategicTarget = z.infer<typeof insertCampaignStrategicTargetSchema>;
export type CampaignStrategicTarget = typeof campaignStrategicTargetsTable.$inferSelect;

export const insertCampaignBattleSchema = createInsertSchema(campaignBattlesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCampaignBattle = z.infer<typeof insertCampaignBattleSchema>;
export type CampaignBattle = typeof campaignBattlesTable.$inferSelect;

export const insertCampaignBattlePriorityChoiceSchema = createInsertSchema(campaignBattlePriorityChoicesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCampaignBattlePriorityChoice = z.infer<typeof insertCampaignBattlePriorityChoiceSchema>;
export type CampaignBattlePriorityChoice = typeof campaignBattlePriorityChoicesTable.$inferSelect;

export const insertCampaignBattleShipAssignmentSchema = createInsertSchema(campaignBattleShipAssignmentsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCampaignBattleShipAssignment = z.infer<typeof insertCampaignBattleShipAssignmentSchema>;
export type CampaignBattleShipAssignment = typeof campaignBattleShipAssignmentsTable.$inferSelect;

export const insertCampaignShipInstanceSchema = createInsertSchema(campaignShipInstancesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCampaignShipInstance = z.infer<typeof insertCampaignShipInstanceSchema>;
export type CampaignShipInstance = typeof campaignShipInstancesTable.$inferSelect;

export const insertCampaignTurnPlayerStateSchema = createInsertSchema(campaignTurnPlayerStatesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCampaignTurnPlayerState = z.infer<typeof insertCampaignTurnPlayerStateSchema>;
export type CampaignTurnPlayerState = typeof campaignTurnPlayerStatesTable.$inferSelect;

export const insertCampaignResourceLedgerSchema = createInsertSchema(campaignResourceLedgerTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCampaignResourceLedger = z.infer<typeof insertCampaignResourceLedgerSchema>;
export type CampaignResourceLedgerEntry = typeof campaignResourceLedgerTable.$inferSelect;

export const insertCampaignTargetOwnershipEventSchema = createInsertSchema(campaignTargetOwnershipEventsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCampaignTargetOwnershipEvent = z.infer<typeof insertCampaignTargetOwnershipEventSchema>;
export type CampaignTargetOwnershipEvent = typeof campaignTargetOwnershipEventsTable.$inferSelect;
