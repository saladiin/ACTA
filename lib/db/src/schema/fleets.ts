import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const fleetsTable = pgTable("fleets", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const shipsTable = pgTable("ships", {
  id: serial("id").primaryKey(),
  fleetId: integer("fleet_id").notNull(),
  shipModelId: integer("ship_model_id").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertFleetSchema = createInsertSchema(fleetsTable).omit({ id: true, createdAt: true });
export type InsertFleet = z.infer<typeof insertFleetSchema>;
export type Fleet = typeof fleetsTable.$inferSelect;

export const insertShipSchema = createInsertSchema(shipsTable).omit({ id: true, createdAt: true });
export type InsertShip = z.infer<typeof insertShipSchema>;
export type Ship = typeof shipsTable.$inferSelect;
