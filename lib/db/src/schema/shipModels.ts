import { pgTable, text, serial, integer, timestamp, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const shipModelsTable = pgTable("ship_models", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  filename: text("filename").notNull(),
  faction: text("faction").notNull(),
  // Immutable rules identity. Race-level rules must never be inferred from
  // free-form trait text because Shadows, Vorlons, and other Ancients have
  // materially different initiative, crew, stealth, and action rules.
  rulesProfile: text("rules_profile").notNull().default("standard"),
  pointCost: integer("point_cost").notNull().default(100),
  priorityLevel: text("priority_level").notNull().default("raid"),
  aiProfile: text("ai_profile").notNull().default("brawler"),
  // ACTA core stats
  shipClass: text("ship_class"),
  hull: integer("hull"),                         // armour dice (1-6)
  troops: integer("troops"),
  damage: integer("damage"),                     // total damage capacity
  damageThreshold: integer("damage_threshold"),
  // Shadow Physical Disruption is not a cripple threshold. It is the amount
  // of damage one Beam weapon attack must inflict to pin the living ship.
  physicalDisruptionThreshold: integer("physical_disruption_threshold")
    .notNull()
    .default(0),
  // B5: ACTA-style "hull" to-hit rating. An attacking die equals-or-exceeds
  // this value to score a hit (beam/mini-beam weapons override to a flat 4+).
  hullRating: integer("hull_rating").notNull().default(4),
  crew: integer("crew"),
  crewThreshold: integer("crew_threshold"),
  speed: integer("speed").notNull().default(3),
  turns: integer("turns"),                       // turns per move activation
  turnAngle: integer("turn_angle"),              // degrees per turn
  crewQuality: text("crew_quality"),             // Regular/Veteran/Elite/N/A
  shield: integer("shield").notNull().default(0),
  shieldMax: integer("shield_max").notNull().default(0),
  shieldRegenRate: integer("shield_regen_rate").notNull().default(0),
  traits: text("traits"),
  smallCraft: text("small_craft"),
  baseRadiusInches: real("base_radius_inches").notNull().default(0.8),
  // Legacy single-weapon summary (kept for backward compat with game_units)
  hullPoints: integer("hull_points").notNull().default(10),
  weaponRange: integer("weapon_range").notNull().default(4),
  weaponDamage: integer("weapon_damage").notNull().default(3),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertShipModelSchema = createInsertSchema(shipModelsTable).omit({ id: true, createdAt: true });
export type InsertShipModel = z.infer<typeof insertShipModelSchema>;
export type ShipModel = typeof shipModelsTable.$inferSelect;
