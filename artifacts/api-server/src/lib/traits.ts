// Parsers for the semicolon-separated `traits` strings stored on ship_models
// and weapons. Matches the canonical CSV format used in seeding (e.g.
// "Interceptors 2; Stealth +5; Dodge +4; Self-repair 1"). Values absent → 0
// (or false for booleans). Parsing is case-insensitive and tolerant of
// extra whitespace, +/- prefixes, and hyphenated vs spaced trait names
// ("twin-linked" vs "twin linked", "mini-beam" vs "mini beam").

const split = (s: string | null | undefined): string[] =>
  !s ? [] : s.split(/[;,]/).map(t => t.trim()).filter(Boolean);

const norm = (t: string): string => t.toLowerCase().replace(/[\s_]+/g, "-");

// Find the first trait whose name matches the given prefix and return its
// numeric tail (e.g. "Stealth +5" → 5, "Interceptors 2" → 2). Returns 0
// when the trait is absent OR present without a number.
function numericTrait(traits: string[], names: string[]): number {
  for (const raw of traits) {
    const n = norm(raw);
    for (const name of names) {
      const key = norm(name);
      if (n === key) return 0;
      if (n.startsWith(key + "-") || n.startsWith(key + " ")) {
        const tail = raw.slice(name.length).trim().replace(/^[+:]/, "").trim();
        const m = tail.match(/^-?\d+/);
        if (m) return parseInt(m[0], 10);
      }
      if (n.startsWith(key)) {
        const tail = raw.slice(name.length).trim().replace(/^[+:]/, "").trim();
        const m = tail.match(/^-?\d+/);
        if (m) return parseInt(m[0], 10);
      }
    }
  }
  return 0;
}

function hasTrait(traits: string[], names: string[]): boolean {
  for (const raw of traits) {
    const n = norm(raw);
    for (const name of names) {
      const key = norm(name);
      if (n === key) return true;
      if (n.startsWith(key + "-") || n.startsWith(key + " ") || n.startsWith(key)) return true;
    }
  }
  return false;
}

export interface ShipTraits {
  stealth: number;        // X (to-hit floor when attacked)
  interceptors: number;   // X hits absorbed per firing activation
  dodge: number;          // +X (defender rolls per hit, ≥X = miss)
  geg: number;            // X damage AND crew reduction per hit
  adaptiveArmour: boolean;// halve dmg & crew, min 1
  ancient: boolean;
  redundantSystems: boolean;
  stealthPenetration: boolean;
  selfRepairDice: number;  // Self Repair Xd6; 0 when absent
  agile: boolean;
  superManeuverable: boolean;
  lumbering: boolean;
  flightComputer: boolean;
  scout: boolean;
  fighter: boolean;
  escort: boolean;
  guardianArray: boolean;
  carrier: number;
  fleetCarrier: boolean;
  command: number;
  dogfight: number;
  antiFighter: number;
  advancedAntiFighter: number;
}

export function parseShipTraits(s: string | null | undefined): ShipTraits {
  const t = split(s);
  return {
    stealth: numericTrait(t, ["Stealth"]),
    interceptors: numericTrait(t, ["Interceptors"]),
    dodge: numericTrait(t, ["Dodge"]),
    geg: numericTrait(t, ["GEG", "Gravitic Energy Grid"]),
    adaptiveArmour: hasTrait(t, ["Adaptive Armour", "Adaptive Armor"]),
    ancient: hasTrait(t, ["Ancient"]),
    redundantSystems: hasTrait(t, ["Redundant Systems"]),
    stealthPenetration: hasTrait(t, ["Stealth Penetration"]),
    selfRepairDice: numericTrait(t, ["Self Repair", "Self-Repair", "Self Repair:", "Self-repair"]),
    agile: hasTrait(t, ["Agile"]),
    superManeuverable: hasTrait(t, ["Super Maneuverable", "Super Manoeuvrable"]),
    lumbering: hasTrait(t, ["Lumbering"]),
    flightComputer: hasTrait(t, ["Flight Computer"]),
    scout: hasTrait(t, ["Scout"]),
    fighter: hasTrait(t, ["Fighter"]),
    escort: hasTrait(t, ["Escort"]),
    guardianArray: hasTrait(t, ["Guardian Array"]),
    carrier: numericTrait(t, ["Carrier"]),
    fleetCarrier: hasTrait(t, ["Fleet Carrier"]),
    command: numericTrait(t, ["Command"]),
    dogfight: numericTrait(t, ["Dogfight", "Dog Fight"]),
    antiFighter: numericTrait(t, ["Anti-Fighter", "Anti Fighter"]),
    advancedAntiFighter: numericTrait(t, ["Advanced Anti-Fighter", "Advanced Anti Fighter"]),
  };
}

export interface WeaponTraits {
  // To-hit modifiers
  accurate: boolean;      // ignores Dodge
  ap: boolean;            // +1 to attack die results
  superAp: boolean;       // +2 to attack die results
  // AD modifiers
  weak: boolean;          // -1 AD
  // Per-hit behaviour
  beam: boolean;          // ignores Interceptors; hits on 4+, re-roll until miss
  miniBeam: boolean;      // hits on 4+, ignores Interceptors (no re-roll chain)
  twinLinked: boolean;    // re-roll missed AD
  energyMine: boolean;    // AoE, ignores Stealth/Interceptors/Dodge, no crits
  massDriver: boolean;    // ignores Shields/Interceptors/GEG; target must be adrift/not moved
  // Damage multipliers
  doubleDamage: boolean;  // ×2; min 1 dmg even on Bulkhead
  tripleDamage: boolean;  // ×3; min 1 dmg even on Bulkhead
  quadDamage: boolean;    // ×4; 2 dmg on Bulkhead
  // Misc
  precise: boolean;       // +1 on Attack Table
  slowLoading: boolean;
  oneShot: boolean;
  orbitalBomb: boolean;
}

export function parseWeaponTraits(s: string | null | undefined): WeaponTraits {
  const t = split(s);
  // Order matters: check Super AP before AP (Super AP starts with "Super").
  return {
    accurate: hasTrait(t, ["Accurate"]),
    superAp: hasTrait(t, ["Super AP", "Super-AP", "Super Armor Piercing", "Super Armour Piercing"]),
    ap: hasTrait(t, ["AP", "Armor Piercing", "Armour Piercing"])
      && !hasTrait(t, ["Super AP", "Super-AP", "Super Armor Piercing", "Super Armour Piercing"]),
    weak: hasTrait(t, ["Weak"]),
    miniBeam: hasTrait(t, ["Mini Beam", "Mini-Beam"]),
    beam: hasTrait(t, ["Beam"]) && !hasTrait(t, ["Mini Beam", "Mini-Beam"]),
    twinLinked: hasTrait(t, ["Twin Linked", "Twin-Linked"]),
    energyMine: hasTrait(t, ["Energy Mine", "Energy-Mine"]),
    massDriver: hasTrait(t, ["Mass Driver", "Mass-Driver"]),
    doubleDamage: hasTrait(t, ["Double Damage", "Double-Damage", "X2 Damage", "x2 Damage"]),
    tripleDamage: hasTrait(t, ["Triple Damage", "Triple-Damage", "X3 Damage", "x3 Damage"]),
    quadDamage: hasTrait(t, ["Quad Damage", "Quad-Damage", "X4 Damage", "x4 Damage"]),
    precise: hasTrait(t, ["Precise"]),
    slowLoading: hasTrait(t, ["Slow Loading", "Slow-Loading"]),
    oneShot: hasTrait(t, ["One-shot", "One Shot", "Oneshot"]),
    orbitalBomb: hasTrait(t, ["Orbital Bomb", "Orbital-Bomb"]),
  };
}

// Stealth-adjusted to-hit threshold per the sheet:
//   "After an Attack has been declared only hits on X, if distance > 20"
//    add 1 to X, if < 8" minus 1."
// Returns the *minimum* threshold (so callers can `Math.max(baseHitThreshold, stealthFloor)`).
// The "target already been hit -1" sheet rule is now handled separately at
// the route layer as `fleetSupportStealthReduction` (subtracted from the
// stealth value BEFORE this floor is computed), so it is intentionally
// absent here to avoid double-dipping.
// Energy Mine ignores Stealth → callers should skip this.
export function stealthFloor(
  stealth: number,
  distanceInches: number,
): number {
  if (stealth <= 0) return 0;
  let x = stealth;
  if (distanceInches > 20) x += 1;
  if (distanceInches < 8) x -= 1;
  return Math.max(2, Math.min(6, x));
}

// Effective AD count for a weapon after weapon-trait modifiers AND
// Intensify Defensive Fire (caller passes the post-Intensify base).
// AP / Super AP modify attack die results, not the number of dice.
export function effectiveAttackDice(baseAd: number, wt: WeaponTraits): number {
  let ad = baseAd;
  if (wt.weak) ad -= 1;
  return Math.max(1, ad);
}

export function attackRollModifier(wt: WeaponTraits): number {
  if (wt.superAp) return 2;
  if (wt.ap) return 1;
  return 0;
}

// Damage multiplier (1/2/3/4) and bulkhead-floor (0/1/1/2).
export function damageMultiplier(wt: WeaponTraits): { mult: number; bulkheadFloor: number } {
  if (wt.quadDamage) return { mult: 4, bulkheadFloor: 2 };
  if (wt.tripleDamage) return { mult: 3, bulkheadFloor: 1 };
  if (wt.doubleDamage) return { mult: 2, bulkheadFloor: 1 };
  return { mult: 1, bulkheadFloor: 0 };
}
