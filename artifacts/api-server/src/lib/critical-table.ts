// Critical Hit Table (Ref Sheet p.10). 36 cells = 6 locations × 1d6 effect.
// Roll location first (1d6 mapped to one of 6 location buckets), then a
// second d6 against the per-location effect range. Some cells reduce dmg/crew
// by a fixed integer; others reduce by Nd6 (rolled at apply time and stored
// on the row so damage-control can reverse it exactly). Every cell also
// declares zero or more *runtime flags* which the fire-weapon and SA routes
// re-derive from the live list of unrepaired crits on a ship.

export type DicePenalty = { dice: number };   // -Nd6 (rolled at apply time)
export type IntPenalty = number;              // -X flat
export type Penalty = IntPenalty | DicePenalty;
export const isDice = (p: Penalty): p is DicePenalty =>
  typeof p === "object" && p !== null && "dice" in p;

// Runtime flags. Each unrepaired crit contributes one or more of these to
// the *derived* CritEffects shape consumed by fire-weapon and SA routes.
export interface CritFlags {
  speedReduce?: number;     // subtract from base speed (cumulative across crits)
  adrift?: boolean;         // ship moves as adrift (Engines 6 / Damage Table)
  noSA?: boolean;           // ship may not declare Special Actions
  loseTraits?: number;      // roll-time: how many random ship traits to drop
  allWeaponsAdMod?: number; // additive (negative) to AD on every weapon arc — cumulative
  weaponsHitOn4?: boolean;  // every weapon's to-hit floor is bumped to 4+
  randomArcOneWeaponNoFire?: boolean;  // roll-time: pick 1 weapon in 1 arc → blocked
  randomArcNoFire?: boolean;           // roll-time: pick an arc → all its weapons blocked
  damageControlPenalty?: number;       // -X to subsequent DC d6+CQ totals (cumulative)
  noDamageControlThisRound?: boolean;  // suppresses DC entirely on the round APPLIED
  troopsLost?: number;                 // troops are a Slice C concern; logged for now
}

export interface CritEntry {
  effectKey: string;
  location: 1 | 2 | 3 | 4 | 5 | 6;
  locationName: string;
  rollMin: number; // inclusive — the effect-d6 lower bound
  rollMax: number; // inclusive — upper bound
  name: string;
  dmg: Penalty;
  crew: Penalty;
  effectText: string;
  repairable: boolean; // false for location-6 Vital Systems (per sheet)
  flags: CritFlags;
}

// Location 1-2 collapses two d6 buckets onto the "Engines" row per the
// sheet ("1-2 - Engines"). At roll time we map locationD6 ∈ {1,2}→Engines
// (location=1 in our schema), 3→Reactor (3), 4→Weapons (4), 5→Crew (5),
// 6→Vital (6). We store location 1 (not 2) for Engines as the canonical id.
export const CRITICAL_TABLE: ReadonlyArray<CritEntry> = [
  // ─── Engines (location 1) ──────────────────────────────────────────────
  { effectKey: "engines-power-relays", location: 1, locationName: "Engines",
    rollMin: 1, rollMax: 2, name: "Power Relays Destroyed",
    dmg: 0, crew: 0, effectText: "-1 Speed", repairable: true,
    flags: { speedReduce: 1 } },
  { effectKey: "engines-thrusters", location: 1, locationName: "Engines",
    rollMin: 3, rollMax: 4, name: "Thrusters Damaged",
    dmg: 1, crew: 0, effectText: "-2 Speed", repairable: true,
    flags: { speedReduce: 2 } },
  { effectKey: "engines-fuel", location: 1, locationName: "Engines",
    rollMin: 5, rollMax: 5, name: "Fuel Systems Ruptured",
    dmg: 2, crew: 1, effectText: "-4 Speed", repairable: true,
    flags: { speedReduce: 4 } },
  { effectKey: "engines-disabled", location: 1, locationName: "Engines",
    rollMin: 6, rollMax: 6, name: "Engines Disabled",
    dmg: 3, crew: 1, effectText: "Ship moves as though adrift", repairable: true,
    flags: { adrift: true } },

  // ─── Reactor (location 3) ──────────────────────────────────────────────
  { effectKey: "reactor-capacitors", location: 3, locationName: "Reactor",
    rollMin: 1, rollMax: 2, name: "Capacitors Damaged",
    dmg: 0, crew: 1, effectText: "-2 Speed, all weapons -1 AD*", repairable: true,
    flags: { speedReduce: 2, allWeaponsAdMod: -1 } },
  { effectKey: "reactor-power-feedback", location: 3, locationName: "Reactor",
    rollMin: 3, rollMax: 4, name: "Power Feedback",
    dmg: 1, crew: 1, effectText: "Lose 1 random trait", repairable: true,
    flags: { loseTraits: 1 } },
  { effectKey: "reactor-gas-leak", location: 3, locationName: "Reactor",
    rollMin: 5, rollMax: 5, name: "Reactor Gas Leak",
    dmg: 0, crew: 3, effectText: "No Special Actions", repairable: true,
    flags: { noSA: true } },
  { effectKey: "reactor-explosion", location: 3, locationName: "Reactor",
    rollMin: 6, rollMax: 6, name: "Reactor Explosion",
    dmg: 3, crew: 4, effectText: "No SA, lose 1 random trait", repairable: true,
    flags: { noSA: true, loseTraits: 1 } },

  // ─── Weapons (location 4) ──────────────────────────────────────────────
  { effectKey: "weapons-targeting", location: 4, locationName: "Weapons",
    rollMin: 1, rollMax: 3, name: "Targeting System Damaged",
    dmg: 0, crew: 1, effectText: "All weapons -1 AD*", repairable: true,
    flags: { allWeaponsAdMod: -1 } },
  { effectKey: "weapons-fluctuations", location: 4, locationName: "Weapons",
    rollMin: 4, rollMax: 4, name: "Power Fluctuations",
    dmg: 0, crew: 0, effectText: "Each weapon fires only on 4+", repairable: true,
    flags: { weaponsHitOn4: true } },
  { effectKey: "weapons-offline", location: 4, locationName: "Weapons",
    rollMin: 5, rollMax: 5, name: "Weapons Offline",
    dmg: 2, crew: 2, effectText: "Random arc, 1 weapon may not fire", repairable: true,
    flags: { randomArcOneWeaponNoFire: true } },
  { effectKey: "weapons-catastrophic", location: 4, locationName: "Weapons",
    rollMin: 6, rollMax: 6, name: "Catastrophic Ammunition Explosion",
    dmg: 3, crew: 4, effectText: "Random arc, no weapons can fire", repairable: true,
    flags: { randomArcNoFire: true } },

  // ─── Crew (location 5) ─────────────────────────────────────────────────
  { effectKey: "crew-fire", location: 5, locationName: "Crew",
    rollMin: 1, rollMax: 2, name: "Fire",
    dmg: 0, crew: 2, effectText: "—", repairable: true, flags: {} },
  { effectKey: "crew-multi-fires", location: 5, locationName: "Crew",
    rollMin: 3, rollMax: 4, name: "Multiple Fires",
    dmg: 0, crew: 3, effectText: "Damage control, -1 penalty", repairable: true,
    flags: { damageControlPenalty: 1 } },
  { effectKey: "crew-decompression", location: 5, locationName: "Crew",
    rollMin: 5, rollMax: 5, name: "Localised Decompression",
    dmg: 1, crew: 3, effectText: "-1 troops, no SA", repairable: true,
    flags: { noSA: true, troopsLost: 1 } },
  { effectKey: "crew-hull-breach", location: 5, locationName: "Crew",
    rollMin: 6, rollMax: 6, name: "Hull Breach",
    dmg: 2, crew: 4, effectText: "-2 troops, no damage control this turn", repairable: true,
    flags: { troopsLost: 2, noDamageControlThisRound: true } },

  // ─── Vital Systems (location 6) — NOT repairable by Damage Control ────
  { effectKey: "vital-bridge", location: 6, locationName: "Vital Systems",
    rollMin: 1, rollMax: 1, name: "Bridge Hit",
    dmg: 0, crew: 1, effectText: "No Special Actions", repairable: false,
    flags: { noSA: true } },
  { effectKey: "vital-secondary", location: 6, locationName: "Vital Systems",
    rollMin: 2, rollMax: 2, name: "Secondary Explosion",
    dmg: { dice: 1 }, crew: { dice: 1 }, effectText: "—", repairable: false, flags: {} },
  { effectKey: "vital-engineering", location: 6, locationName: "Vital Systems",
    rollMin: 3, rollMax: 3, name: "Engineering",
    dmg: 4, crew: 3, effectText: "No Damage Control permitted", repairable: false,
    flags: { noDamageControlThisRound: true /* and going forward — derived */ } },
  { effectKey: "vital-weapons-control", location: 6, locationName: "Vital Systems",
    rollMin: 4, rollMax: 4, name: "Weapons Control",
    dmg: 4, crew: 4, effectText: "No firing out of 1 random arc", repairable: false,
    flags: { randomArcNoFire: true } },
  { effectKey: "vital-implosion", location: 6, locationName: "Vital Systems",
    rollMin: 5, rollMax: 5, name: "Reactor Implosion",
    dmg: { dice: 2 }, crew: { dice: 4 }, effectText: "Lose 1 random trait", repairable: false,
    flags: { loseTraits: 1 } },
  { effectKey: "vital-catastrophic", location: 6, locationName: "Vital Systems",
    rollMin: 6, rollMax: 6, name: "Catastrophic Explosion",
    dmg: { dice: 4 }, crew: { dice: 2 }, effectText: "Lose 2 random traits", repairable: false,
    flags: { loseTraits: 2 } },
];

// Map the 1d6 location roll → schema location code. The sheet collapses
// rolls 1 and 2 onto Engines; the table only contains entries with
// location ∈ {1,3,4,5,6}.
export function locationFromRoll(d6: number): 1 | 3 | 4 | 5 | 6 {
  if (d6 <= 2) return 1;
  if (d6 === 3) return 3;
  if (d6 === 4) return 4;
  if (d6 === 5) return 5;
  return 6;
}

export function findEntry(location: number, effectRoll: number): CritEntry | undefined {
  return CRITICAL_TABLE.find(e => e.location === location && effectRoll >= e.rollMin && effectRoll <= e.rollMax);
}

// Roll an Nd6 penalty and return the total.
export function rollDice(n: number, rng: () => number = Math.random): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += 1 + Math.floor(rng() * 6);
  return sum;
}

// Reduce a list of (still-active, unrepaired) crit rows into a flat set of
// derived effects the rest of the game logic consumes. The persistence
// layer stores each row as a (effectKey, flags-resolved-fields) so this
// function can stay pure.
export interface DerivedCritEffects {
  speedReduce: number;
  adrift: boolean;
  noSA: boolean;
  allWeaponsAdMod: number;        // sum of negatives (already ≤ 0)
  weaponsHitOn4: boolean;
  // Sets of forbidden arcs / weaponIds derived from random rolls stored on
  // the rows. Empty when no such crit is active.
  forbiddenArcs: Set<string>;
  forbiddenWeaponIds: Set<number>;
  damageControlPenalty: number;
  noDamageControlEver: boolean;   // true when Engineering crit is live
  noDamageControlThisRound: boolean; // true when Hull Breach / etc. applied this round
  lostTraitNames: Set<string>;
}

// Single canonical projection used by every read/mutation path that returns
// a gameUnit row. The DB `damageState` column tracks the hull-zero kill
// table; an Engines-Disabled-style crit ("flags.adrift") is an orthogonal
// source of "adrift" that we MUST overlay here, otherwise different routes
// would disagree about whether the ship is adrift (e.g. GET reports adrift,
// /move's response still says "normal"). Returns the raw state unchanged
// when it's already a hull-table state (adrift / exploding / destroyed) so
// the kill-table semantics aren't downgraded by a parallel crit.
export function effectiveDamageState(
  rawDamageState: string,
  critRows: ReadonlyArray<{
    effectKey: string;
    randomArc: string | null;
    randomWeaponId: number | null;
    lostTraits: ReadonlyArray<string>;
  }>,
): string {
  if (rawDamageState !== "normal") return rawDamageState;
  const d = deriveCritEffects(critRows.map(r => ({
    effectKey: r.effectKey,
    randomArc: r.randomArc,
    randomWeaponId: r.randomWeaponId,
    lostTraits: r.lostTraits ?? [],
  })));
  return d.adrift ? "adrift" : rawDamageState;
}

export function deriveCritEffects(rows: ReadonlyArray<{
  effectKey: string;
  randomArc: string | null;
  randomWeaponId: number | null;
  lostTraits: ReadonlyArray<string>;
  appliedRound?: number;
}>, currentRound?: number): DerivedCritEffects {
  const out: DerivedCritEffects = {
    speedReduce: 0, adrift: false, noSA: false, allWeaponsAdMod: 0,
    weaponsHitOn4: false, forbiddenArcs: new Set(), forbiddenWeaponIds: new Set(),
    damageControlPenalty: 0, noDamageControlEver: false,
    noDamageControlThisRound: false, lostTraitNames: new Set(),
  };
  for (const row of rows) {
    const entry = CRITICAL_TABLE.find(e => e.effectKey === row.effectKey);
    if (!entry) continue;
    const f = entry.flags;
    if (f.speedReduce) out.speedReduce += f.speedReduce;
    if (f.adrift) out.adrift = true;
    if (f.noSA) out.noSA = true;
    if (f.allWeaponsAdMod) out.allWeaponsAdMod += f.allWeaponsAdMod;
    if (f.weaponsHitOn4) out.weaponsHitOn4 = true;
    if (f.damageControlPenalty) out.damageControlPenalty += f.damageControlPenalty;
    // Engineering (vital-engineering) permanently disables damage control.
    if (entry.effectKey === "vital-engineering") out.noDamageControlEver = true;
    // Hull Breach / etc.: block DC on the round the crit was applied.
    if (f.noDamageControlThisRound && currentRound !== undefined && row.appliedRound === currentRound) {
      out.noDamageControlThisRound = true;
    }
    if (f.randomArcOneWeaponNoFire && row.randomWeaponId != null) {
      out.forbiddenWeaponIds.add(row.randomWeaponId);
    }
    if (f.randomArcNoFire && row.randomArc) {
      out.forbiddenArcs.add(row.randomArc);
    }
    for (const t of row.lostTraits) out.lostTraitNames.add(t);
  }
  return out;
}

// Canonical weapon arcs on a ship. Used for random-arc crits so the
// probability distribution doesn't bias toward arcs the target happens
// to have populated (per sheet: "roll an Arc", not "roll an occupied arc").
// Values MUST match the long-form strings stored in `weapons.arc`
// ("Forward" | "Port" | "Starboard" | "Aft"); otherwise the fire-weapon
// gate (`forbiddenArcs.has(weapon.arc)`) silently misses every match.
export const CANONICAL_ARCS: ReadonlyArray<string> = ["Forward", "Aft", "Port", "Starboard"];
