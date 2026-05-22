import { pgTable, text, serial, integer, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const gamesTable = pgTable("games", {
  id: serial("id").primaryKey(),
  challengerId: text("challenger_id").notNull(),
  opponentId: text("opponent_id").notNull(),
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
  pointLimit: integer("point_limit").notNull().default(500),
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
  isDestroyed: boolean("is_destroyed").notNull().default(false),
  hasMovedThisRound: boolean("has_moved_this_round").notNull().default(false),
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
