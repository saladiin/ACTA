import { pgTable, text, serial, integer, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const gamesTable = pgTable("games", {
  id: serial("id").primaryKey(),
  challengerId: text("challenger_id").notNull(),
  opponentId: text("opponent_id"),
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
  // Each round is split into two sub-phases: movement (all ships activate
  // alternately to move/turn) → firing (all ships activate alternately to
  // shoot). The same initiative winner fires first within each round.
  phase: text("phase").notNull().default("movement"), // "movement" | "firing"
  initiativeWinnerId: text("initiative_winner_id"),
  pointLimit: integer("point_limit").notNull().default(500),
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
  hullPoints: integer("hull_points").notNull(),
  maxHullPoints: integer("max_hull_points").notNull(),
  hexQ: integer("hex_q").notNull().default(0),
  hexR: integer("hex_r").notNull().default(0),
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
  //   "all-power-engines", "all-stop", "all-stop-pivot", "come-about",
  //   "blast-doors", "intensify-defense", "run-silent", "concentrate-fire".
  // A failed CQ attempt is recorded by appending "-failed" (e.g.
  // "run-silent-failed") so the client can show the attempt while still
  // applying the always-on restrictions that come with trying.
  specialAction: text("special_action"),
  // For "concentrate-fire": the nominated target unit id. Read by the
  // fire-weapon route to gate the re-roll bonus.
  specialActionTargetId: integer("special_action_target_id"),
  isDestroyed: boolean("is_destroyed").notNull().default(false),
  hasMovedThisRound: boolean("has_moved_this_round").notNull().default(false),
  hasFiredThisRound: boolean("has_fired_this_round").notNull().default(false),
  // Weapons this ship has already discharged DURING the current firing
  // activation. Reset to [] each time the ship is picked up for activation so
  // the server can authoritatively enforce one-shot-per-weapon. (Per the
  // rules, each weapon can fire at one target per firing activation.)
  firedWeaponIds: jsonb("fired_weapon_ids").$type<number[]>().notNull().default([]),
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

export const insertGameSchema = createInsertSchema(gamesTable).omit({ id: true, status: true, winnerId: true, currentTurn: true, challengerDeployed: true, opponentDeployed: true, createdAt: true, updatedAt: true });
export type InsertGame = z.infer<typeof insertGameSchema>;
export type Game = typeof gamesTable.$inferSelect;

export const insertGameUnitSchema = createInsertSchema(gameUnitsTable).omit({ id: true });
export type InsertGameUnit = z.infer<typeof insertGameUnitSchema>;
export type GameUnit = typeof gameUnitsTable.$inferSelect;

export const insertTurnSchema = createInsertSchema(turnsTable).omit({ id: true, resolvedAt: true });
export type InsertTurn = z.infer<typeof insertTurnSchema>;
export type Turn = typeof turnsTable.$inferSelect;
