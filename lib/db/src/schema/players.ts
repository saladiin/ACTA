import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const playersTable = pgTable("players", {
  clerkUserId: text("clerk_user_id").primaryKey(),
  username: text("username").notNull(),
  avatarUrl: text("avatar_url"),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  gamesPlayed: integer("games_played").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertPlayerSchema = createInsertSchema(playersTable).omit({ wins: true, losses: true, gamesPlayed: true, createdAt: true, updatedAt: true });
export type InsertPlayer = z.infer<typeof insertPlayerSchema>;
export type Player = typeof playersTable.$inferSelect;
