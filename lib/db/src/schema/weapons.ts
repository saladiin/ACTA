import { pgTable, text, serial, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Arcs are 45° wide, centered on cardinal/intercardinal directions.
// Boresight Forward/Aft are narrow straight-line arcs (no angular width).
// Turret covers all arcs.
export const weaponsTable = pgTable("weapons", {
  id: serial("id").primaryKey(),
  shipModelId: integer("ship_model_id").notNull(),
  name: text("name").notNull().default(""),
  arc: text("arc").notNull(),        // Forward | Port | Starboard | Aft | Boresight Forward | Boresight Aft | Turret
  range: integer("range").notNull(), // inches
  attackDice: integer("attack_dice").notNull(),
  traits: text("traits"),
});

export const insertWeaponSchema = createInsertSchema(weaponsTable).omit({ id: true });
export type InsertWeapon = z.infer<typeof insertWeaponSchema>;
export type Weapon = typeof weaponsTable.$inferSelect;
