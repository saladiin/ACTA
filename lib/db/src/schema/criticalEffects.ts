import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";

// Critical-hit rows for slice B. One row per unrepaired effect on a unit.
// Created by the fire-weapon route when an Attack Table 6 is rolled; the
// row's structural damage/crew has ALREADY been applied to the parent
// game_units row at creation time. Damage-control success removes the row
// AND reverses those deltas (heals hull / crew).
export const unitCriticalEffectsTable = pgTable("unit_critical_effects", {
  id: serial("id").primaryKey(),
  gameUnitId: integer("game_unit_id").notNull(),
  // Stable effect-table key from `critical-table.ts` (e.g. "engines-thrusters").
  effectKey: text("effect_key").notNull(),
  // Schema location 1=Engines, 3=Reactor, 4=Weapons, 5=Crew, 6=Vital.
  location: integer("location").notNull(),
  // Display name copied from the table at roll time (so reads don't need to
  // join against the const table; allows the const to be hot-fixed without
  // rewriting history).
  name: text("name").notNull(),
  // The dmg/crew penalties applied when this row was created. -Nd6 entries
  // store the rolled total so damage-control reverses it exactly.
  damageApplied: integer("damage_applied").notNull().default(0),
  crewApplied: integer("crew_applied").notNull().default(0),
  // Per-roll random choices captured at creation. Null when the effect
  // doesn't have a random arc / weapon component.
  randomArc: text("random_arc"),                  // "fore"|"aft"|"port"|"starboard"|"turret"
  randomWeaponId: integer("random_weapon_id"),    // a weapons.id when ArcOneWeapon
  // Trait names dropped at creation time ("Lose 1 random trait"). The actual
  // trait removal is applied at runtime by filtering parseShipTraits via
  // deriveCritEffects().lostTraitNames.
  lostTraits: text("lost_traits").array().notNull().default([]),
  // Round it was applied — used to enforce "may not be repaired the round
  // it was suffered" and to suppress damage-control on the apply round when
  // the effect carries noDamageControlThisRound (Hull Breach).
  appliedRound: integer("applied_round").notNull(),
  // Slice B leaves rows soft-only on success (deleted) — no separate
  // repaired flag. Vital Systems rows have repairable=false; the route
  // refuses to act on them, so they're permanent until the unit is killed.
  repairable: boolean("repairable").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
