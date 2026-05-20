import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const shipModelsTable = pgTable("ship_models", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  filename: text("filename").notNull(),
  faction: text("faction").notNull(),
  pointCost: integer("point_cost").notNull().default(100),
  hullPoints: integer("hull_points").notNull().default(10),
  speed: integer("speed").notNull().default(3),
  weaponRange: integer("weapon_range").notNull().default(4),
  weaponDamage: integer("weapon_damage").notNull().default(3),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertShipModelSchema = createInsertSchema(shipModelsTable).omit({ id: true, createdAt: true });
export type InsertShipModel = z.infer<typeof insertShipModelSchema>;
export type ShipModel = typeof shipModelsTable.$inferSelect;
