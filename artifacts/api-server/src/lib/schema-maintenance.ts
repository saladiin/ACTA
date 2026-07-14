import { pool } from "@workspace/db";
import fs from "node:fs";
import path from "node:path";
import { SHIP_AI_PROFILE_SEEDS } from "./ai-opponent";
import { logger } from "./logger";

const SHIP_PRIORITY_SEEDS: Array<{ name: string; priority: string }> = [
  { name: "Shadow Cruiser (Ancient)", priority: "armageddon" },
  { name: "Shadow Cruiser", priority: "armageddon" },
  { name: "Sharlin War Cruiser", priority: "war" },
  { name: "Tigara Attack Cruiser", priority: "raid" },
  { name: "Tigara-class Attack Cruiser", priority: "raid" },
  { name: "Tinashi", priority: "battle" },
  { name: "Tinashi Warship", priority: "battle" },
  { name: "Avioki", priority: "battle" },
  { name: "Avioki Heavy Cruiser", priority: "battle" },
  { name: "G'Quan Cruiser", priority: "battle" },
  { name: "G'Quan Heavy Cruiser", priority: "battle" },
  { name: "Omega Destroyer", priority: "battle" },
  { name: "Omega Class Destroyer", priority: "battle" },
  { name: "Primus Battle Cruiser", priority: "battle" },
  { name: "Corvan Scout", priority: "skirmish" },
  { name: "Corvan-class Scout", priority: "skirmish" },
  { name: "Covran Scout", priority: "skirmish" },
  { name: "Covran-class Scout", priority: "skirmish" },
  { name: "Altarian Destroyer", priority: "raid" },
  { name: "Altarian-class Destroyer", priority: "raid" },
  { name: "Vorchan Warship", priority: "skirmish" },
  { name: "Vorchan-class Warship", priority: "skirmish" },
  { name: "Avenger Heavy Carrier", priority: "raid" },
  { name: "Avenger-class Heavy Carrier", priority: "raid" },
  { name: "Hyperion Cruiser", priority: "raid" },
  { name: "Hyperion Heavy Cruiser", priority: "raid" },
  { name: "Hyperion Assault Cruiser", priority: "skirmish" },
  { name: "Hyperion Command Cruiser", priority: "raid" },
  { name: "Hyperion Missile Cruiser", priority: "raid" },
  { name: "Hyperion Pulse Cruiser", priority: "raid" },
  { name: "Hyperion Rail Cruiser", priority: "skirmish" },
  { name: "Nova Dreadnought", priority: "raid" },
  { name: "White Star", priority: "raid" },
  { name: "Tethys Cutter", priority: "patrol" },
  { name: "Tethys-class Cutter", priority: "patrol" },
  { name: "Olympus Corvette", priority: "skirmish" },
  { name: "Oracle Cruiser", priority: "skirmish" },
  { name: "Oracle Scout Cruiser", priority: "skirmish" },
  { name: "Sagittarius", priority: "skirmish" },
  { name: "Sagittarius Missile Cruiser", priority: "skirmish" },
  { name: "Nial Fighter Flight", priority: "patrol" },
  { name: "Sentri Flight", priority: "patrol" },
  { name: "Tiger Starfury Flight", priority: "patrol" },
  { name: "Flyer Flight", priority: "patrol" },
];

const CAPITAL_BASE_RADIUS_INCHES = 0.8;
const FIGHTER_BASE_RADIUS_INCHES = CAPITAL_BASE_RADIUS_INCHES;

const SHIP_PRIORITY_BY_NAME = new Map(
  SHIP_PRIORITY_SEEDS.map(seed => [seed.name.toLowerCase(), seed.priority]),
);

const POINT_COST_BY_PRIORITY: Record<string, number> = {
  patrol: 25,
  skirmish: 150,
  raid: 200,
  battle: 225,
  war: 400,
  armageddon: 600,
  ancient: 600,
};

const CSV_MODEL_FILENAMES: Record<string, string> = {
  "shadow cruiser (ancient)": "battlecrab.glb",
  "hyperion cruiser": "hyperion.glb",
  "sharlin war cruiser": "sharlin.glb",
  "olympus corvette": "olympus.glb",
  tinashi: "tinashi.glb",
  "oracle cruiser": "oracle.glb",
  "omega destroyer": "omega.glb",
  "nova dreadnought": "nova.glb",
  "g'quan cruiser": "gquan.glb",
  "white star": "whitestar.glb",
  avioki: "avioki.glb",
};

const FALLBACK_ACTA_SHIP_CSV = String.raw`SHIP STATS,,,,,,,,,,,,,,,,,
Faction,Name,Class,Hull,Troops,Damage,Damage Threshold,Crew,Crew Threshold,Speed,Turns,Turn Angle (deg),Crew Quality,Shield,Shield Max,Shield Regen Rate,Ship Traits,Small craft
Shadows,Shadow Cruiser (Ancient),Dreadnought,6,0,150,38,0,0,8,0,0,N/A,20,20,10,Super Maneuverable; Self Repair:3d6,
Earth Alliance,Hyperion Cruiser,Heavy Cruiser,5,3,28,6,32,6,8,2,45,Veteran,0,0,0,Anti-Fighter 2; Interceptors 2; Jump Engine,Aurora Starfury (1)
Minbari,Sharlin War Cruiser,Warcruiser,5,5,60,20,66,22,8,1,45,Elite,0,0,0,Advanced Anti-Fighter 5; Advanced Jump Engine; Flight Computer; Lumbering; Stealth +5,"Nial (4), Flyer (1)"
Earth Alliance,Olympus Corvette,Corvette,5,1,18,4,20,4,8,2,45,Regular,0,0,0,Interceptors 1,
Minbari,Tinashi,Warship,5,4,38,12,42,14,10,2,45,Regular,0,0,0,Advanced Anti-Fighter 4; Advanced Jump Engine; Flight Computer; Stealth +5,
Earth Alliance,Oracle Cruiser,Scout Cruiser,4,0,16,5,22,6,12,2,45,Regular,0,0,0,Interceptors 2; Anti-Fighter 4; Jump Engine; Scout; Stealth +3,
Earth Alliance,Omega Destroyer,Heavy Destroyer,6,4,48,10,62,14,7,1,45,Regular,0,0,0,Interceptors 3; Anti-Fighter 6; Jump Engine; Lumbering,Aurora Starfury (4)
Earth Alliance,Nova Dreadnought,Dreadnought,5,2,36,9,45,12,6,1,45,Regular,0,0,0,Interceptors 2; Jump Engine; Lumbering,Aurora Starfury (4)
Narn,G'Quan Cruiser,Heavy Cruiser,6,8,55,13,70,19,6,1,45,Regular,0,0,0,Anti-Fighter 2; Jump Engine; Lumbering,Frazi (2)
Interstellar Alliance,White Star,Advanced Frigate,5,1,10,3,12,3,15,2,90,Elite,0,0,0,Adaptive Armor; Advanced Jump Engine; Agile; Atmospheric; Dodge +4; Flight Computer; Scout; Self-repair 1,
League of Nonaligned Worlds,Avioki,Heavy Cruiser,6,4,64,10,68,10,6,1,45,Regular,0,0,0,Anti-Fighter 2; Jump Engine; Lumbering,
WEAPONS,,,,,,,,,,,,,,,,,
Faction,Ship Name,Ship Class,Weapon Name,Arc,Range,Attack Dice,Weapon Traits,,,,,,,,,,
Shadows,Shadow Cruiser (Ancient),Dreadnought,Molecular Slicer Beam,Forward,24,6,Beam; Precise; Quad Damage,,,,,,,,,,
Earth Alliance,Hyperion Cruiser,Heavy Cruiser,Heavy Laser Cannon,Boresight Forward,18,4,Beam; Double Damage,,,,,,,,,,
Earth Alliance,Hyperion Cruiser,Heavy Cruiser,Medium Pulse Cannon,Forward,10,4,,,,,,,,,,,
Earth Alliance,Hyperion Cruiser,Heavy Cruiser,Plasma Cannon,Forward,8,4,Armor Piercing; Twin-Linked,,,,,,,,,,
Earth Alliance,Hyperion Cruiser,Heavy Cruiser,Medium Pulse Cannon,Port,10,8,,,,,,,,,,,
Earth Alliance,Hyperion Cruiser,Heavy Cruiser,Medium Pulse Cannon,Starboard,10,8,,,,,,,,,,,
Earth Alliance,Hyperion Cruiser,Heavy Cruiser,Medium Pulse Cannon,Aft,10,2,,,,,,,,,,,
Earth Alliance,Hyperion Cruiser,Heavy Cruiser,Heavy Laser Cannon,Boresight Aft,18,2,Beam; Double Damage,,,,,,,,,,
Minbari,Sharlin War Cruiser,Warcruiser,Neutron Laser,Forward,30,8,Beam; Double Damage; Precise,,,,,,,,,,
Minbari,Sharlin War Cruiser,Warcruiser,Fusion Cannon,Forward,18,8,Mini Beam,,,,,,,,,,
Minbari,Sharlin War Cruiser,Warcruiser,Fusion Cannon,Port,18,8,Mini Beam,,,,,,,,,,
Minbari,Sharlin War Cruiser,Warcruiser,Fusion Cannon,Starboard,18,8,Mini Beam,,,,,,,,,,
Minbari,Sharlin War Cruiser,Warcruiser,Neutron Laser,Aft,30,6,Beam; Double Damage; Precise,,,,,,,,,,
Minbari,Sharlin War Cruiser,Warcruiser,Fusion Cannon,Aft,18,8,Mini Beam,,,,,,,,,,
Earth Alliance,Olympus Corvette,Corvette,Medium Pulse Cannon,Forward,10,6,Twin-Linked,,,,,,,,,,
Earth Alliance,Olympus Corvette,Corvette,Medium Pulse Cannon,Port,10,4,Twin-Linked,,,,,,,,,,
Earth Alliance,Olympus Corvette,Corvette,Missile Rack,Turret,30,2,Precise; Slow Loading; Super Armor Piercing,,,,,,,,,,
Earth Alliance,Olympus Corvette,Corvette,Railguns,Turret,12,4,Armor Piercing; Double Damage,,,,,,,,,,
Earth Alliance,Olympus Corvette,Corvette,Medium Pulse Cannon,Starboard,10,4,Twin-Linked,,,,,,,,,,
Minbari,Tinashi,Warship,Neutron Laser,Forward,25,4,Beam; Double Damage; Precise,,,,,,,,,,
Minbari,Tinashi,Warship,Fusion Cannon,Forward,18,8,Mini-beam; Twin-linked,,,,,,,,,,
Minbari,Tinashi,Warship,Fusion Cannon,Port,18,6,Mini-beam; Twin-linked,,,,,,,,,,
Minbari,Tinashi,Warship,Fusion Cannon,Starboard,18,6,Mini-beam; Twin-linked,,,,,,,,,,
Minbari,Tinashi,Warship,Fusion Cannon,Rear,18,6,Mini-beam; Twin-linked,,,,,,,,,,
Earth Alliance,Oracle Cruiser,Scout Cruiser,Medium Laser Cannon,Boresight forward,15,2,Beam,,,,,,,,,,
Earth Alliance,Oracle Cruiser,Scout Cruiser,Missile Rack,Turret,30,1,Precise; Slow Loading; Super Armor Piercing,,,,,,,,,,
Earth Alliance,Oracle Cruiser,Scout Cruiser,Light Pulse Cannon,Forward,8,2,Twin-Linked,,,,,,,,,,
Earth Alliance,Oracle Cruiser,Scout Cruiser,Light Pulse Cannon,Port,8,2,Twin-Linked,,,,,,,,,,
Earth Alliance,Oracle Cruiser,Scout Cruiser,Light Pulse Cannon,Starboard,8,2,Twin-Linked,,,,,,,,,,
Earth Alliance,Omega Destroyer,Heavy Destroyer,Heavy Laser Cannon,Boresight Forward,30,6,Beam; Double Damage,,,,,,,,,,
Earth Alliance,Omega Destroyer,Heavy Destroyer,Heavy Laser Cannon,Boresight Aft,30,4,Beam; Double Damage,,,,,,,,,,
Earth Alliance,Omega Destroyer,Heavy Destroyer,Heavy Pulse Cannon,Forward,12,4,Twin-Linked,,,,,,,,,,
Earth Alliance,Omega Destroyer,Heavy Destroyer,Light Laser Cannon,Port,15,4,Mini-beam; Slow Loading,,,,,,,,,,
Earth Alliance,Omega Destroyer,Heavy Destroyer,Light Laser Cannon,Starboard,15,4,Mini-beam; Slow Loading,,,,,,,,,,
Earth Alliance,Omega Destroyer,Heavy Destroyer,Medium Pulse Cannon,Aft,10,4,Twin-Linked,,,,,,,,,,
Earth Alliance,Omega Destroyer,Heavy Destroyer,Medium Pulse Cannon,Port,10,8,Twin-Linked,,,,,,,,,,
Earth Alliance,Omega Destroyer,Heavy Destroyer,Medium Pulse Cannon,Starboard,10,8,Twin-Linked,,,,,,,,,,
Earth Alliance,Nova Dreadnought,Dreadnought,Heavy Pulse Cannon,Forward,12,8,Twin-Linked,,,,,,,,,,
Earth Alliance,Nova Dreadnought,Dreadnought,Heavy Pulse Cannon,Aft,12,4,Twin-Linked,,,,,,,,,,
Earth Alliance,Nova Dreadnought,Dreadnought,Heavy Pulse Cannon,Port,12,14,Twin-Linked,,,,,,,,,,
Earth Alliance,Nova Dreadnought,Dreadnought,Heavy Pulse Cannon,Starboard,12,14,Twin-Linked,,,,,,,,,,
Narn,G'Quan Cruiser,Heavy Cruiser,Heavy Laser Cannon,Boresight Forward,30,4,Beam; Double Damage,,,,,,,,,,
Narn,G'Quan Cruiser,Heavy Cruiser,Energy Mine,Forward,30,6,Armor Piercing; Energy Mine; One-Shot; Triple Damage,,,,,,,,,,
Narn,G'Quan Cruiser,Heavy Cruiser,Light Ion Cannon,Forward,8,10,Twin-Linked,,,,,,,,,,
Narn,G'Quan Cruiser,Heavy Cruiser,Light Ion Cannon,Aft,8,10,Twin-Linked,,,,,,,,,,
Narn,G'Quan Cruiser,Heavy Cruiser,Light Ion Cannon,Port,8,10,Twin-Linked,,,,,,,,,,
Narn,G'Quan Cruiser,Heavy Cruiser,Light Ion Cannon,Starboard,8,10,Twin-Linked,,,,,,,,,,
Narn,G'Quan Cruiser,Heavy Cruiser,Light Pulse Cannon,Forward,8,6,,,,,,,,,,,
Narn,G'Quan Cruiser,Heavy Cruiser,Light Pulse Cannon,Aft,8,6,,,,,,,,,,,
Narn,G'Quan Cruiser,Heavy Cruiser,Light Pulse Cannon,Port,8,6,,,,,,,,,,,
Narn,G'Quan Cruiser,Heavy Cruiser,Light Pulse Cannon,Starboard,8,6,,,,,,,,,,,
Interstellar Alliance,White Star,Advanced Frigate,Improved Neutron Laser,Forward,18,2,Beam; Precise; Triple Damage,,,,,,,,,,
Interstellar Alliance,White Star,Advanced Frigate,Molecular Pulsar,Forward,10,4,Accurate; Armor Piercing; Double Damage,,,,,,,,,,
League of Nonaligned Worlds,Avioki,Heavy Cruiser,Particle Beam,Forward,18,8,Beam; Double Damage; Slow Loading,,,,,,,,,,
League of Nonaligned Worlds,Avioki,Heavy Cruiser,Ion Cannon,Forward,12,10,Armor Piercing,,,,,,,,,,
League of Nonaligned Worlds,Avioki,Heavy Cruiser,Ion Cannon,Aft,12,4,Armor Piercing,,,,,,,,,,
League of Nonaligned Worlds,Avioki,Heavy Cruiser,Ion Cannon,Port,12,8,Armor Piercing,,,,,,,,,,
League of Nonaligned Worlds,Avioki,Heavy Cruiser,Ion Cannon,Starboard,12,8,Armor Piercing,,,,,,,,,,`;

const SAGITTARIUS_WEAPONS = [
  { name: "Missile Rack", arc: "Forward", range: 30, attackDice: 2, traits: "Precise; Slow Loading; Super Armor Piercing" },
  { name: "Missile Rack", arc: "Aft", range: 30, attackDice: 2, traits: "Precise; Slow Loading; Super Armor Piercing" },
  { name: "Missile Rack", arc: "Port", range: 30, attackDice: 6, traits: "Precise; Slow Loading; Super Armor Piercing" },
  { name: "Missile Rack", arc: "Starboard", range: 30, attackDice: 6, traits: "Precise; Slow Loading; Super Armor Piercing" },
];

const TETHYS_WEAPONS = [
  { name: "Plasma Cannon", arc: "Forward", range: 8, attackDice: 4, traits: "Armor Piercing" },
  { name: "Light Plasma Cannon", arc: "Forward", range: 6, attackDice: 2, traits: "Armor Piercing" },
  { name: "Light Plasma Cannon", arc: "Port", range: 6, attackDice: 1, traits: "Armor Piercing" },
  { name: "Light Plasma Cannon", arc: "Starboard", range: 6, attackDice: 1, traits: "Armor Piercing" },
];

const BATTLECRAB_WEAPONS = [
  { name: "Molecular Slicer Beam", arc: "Forward", range: 24, attackDice: 6, traits: "Beam; Precise; Quad Damage" },
];

const AVIOKI_WEAPONS = [
  { name: "Particle Beam", arc: "Forward", range: 18, attackDice: 8, traits: "Beam; Double Damage; Slow Loading" },
  { name: "Ion Cannon", arc: "Forward", range: 12, attackDice: 10, traits: "Armor Piercing" },
  { name: "Ion Cannon", arc: "Aft", range: 12, attackDice: 4, traits: "Armor Piercing" },
  { name: "Ion Cannon", arc: "Port", range: 12, attackDice: 8, traits: "Armor Piercing" },
  { name: "Ion Cannon", arc: "Starboard", range: 12, attackDice: 8, traits: "Armor Piercing" },
];

const GQUAN_WEAPONS = [
  { name: "Heavy Laser Cannon", arc: "Boresight Forward", range: 30, attackDice: 4, traits: "Beam; Double Damage" },
  { name: "Energy Mine", arc: "Forward", range: 30, attackDice: 6, traits: "Armor Piercing; Energy Mine; One-Shot; Triple Damage" },
  { name: "Light Ion Cannon", arc: "Forward", range: 8, attackDice: 10, traits: "Twin-Linked" },
  { name: "Light Ion Cannon", arc: "Aft", range: 8, attackDice: 10, traits: "Twin-Linked" },
  { name: "Light Ion Cannon", arc: "Port", range: 8, attackDice: 10, traits: "Twin-Linked" },
  { name: "Light Ion Cannon", arc: "Starboard", range: 8, attackDice: 10, traits: "Twin-Linked" },
  { name: "Light Pulse Cannon", arc: "Forward", range: 8, attackDice: 6, traits: "" },
  { name: "Light Pulse Cannon", arc: "Aft", range: 8, attackDice: 6, traits: "" },
  { name: "Light Pulse Cannon", arc: "Port", range: 8, attackDice: 6, traits: "" },
  { name: "Light Pulse Cannon", arc: "Starboard", range: 8, attackDice: 6, traits: "" },
];

const AVENGER_WEAPONS = [
  { name: "Plasma Cannon", arc: "Forward", range: 8, attackDice: 6, traits: "Armor Piercing" },
  { name: "Light Pulse Cannon", arc: "Forward", range: 8, attackDice: 4, traits: "" },
  { name: "Light Pulse Cannon", arc: "Aft", range: 8, attackDice: 4, traits: "" },
  { name: "Light Pulse Cannon", arc: "Port", range: 8, attackDice: 4, traits: "" },
  { name: "Light Pulse Cannon", arc: "Starboard", range: 8, attackDice: 4, traits: "" },
];

const PRIMUS_WEAPONS = [
  { name: "Battle Laser", arc: "Forward", range: 18, attackDice: 6, traits: "Beam; Precise" },
  { name: "Ion Cannon", arc: "Forward", range: 12, attackDice: 12, traits: "Double Damage; Twin Linked" },
  { name: "Ion Cannon", arc: "Aft", range: 12, attackDice: 6, traits: "Double Damage; Twin Linked" },
  { name: "Ion Cannon", arc: "Port", range: 12, attackDice: 10, traits: "Double Damage; Twin Linked" },
  { name: "Ion Cannon", arc: "Starboard", range: 12, attackDice: 10, traits: "Double Damage; Twin Linked" },
];

const ALTARIAN_WEAPONS = [
  { name: "Matter Cannon", arc: "Forward", range: 15, attackDice: 6, traits: "Armor Piercing; Double Damage" },
  { name: "Ion Cannon", arc: "Forward", range: 12, attackDice: 8, traits: "Double Damage; Twin-Linked" },
  { name: "Ion Cannon", arc: "Aft", range: 12, attackDice: 4, traits: "Double Damage; Twin-Linked" },
  { name: "Ion Cannon", arc: "Port", range: 12, attackDice: 4, traits: "Double Damage; Twin-Linked" },
  { name: "Ion Cannon", arc: "Starboard", range: 12, attackDice: 4, traits: "Double Damage; Twin-Linked" },
];

const VORCHAN_WEAPONS = [
  { name: "Plasma Accelerator", arc: "Forward", range: 12, attackDice: 4, traits: "Double Damage; Super Armor Piercing" },
  { name: "Ion Cannon", arc: "Forward", range: 12, attackDice: 8, traits: "Double Damage; Twin Linked" },
];

const CORVAN_WEAPONS = [
  { name: "Battle Laser", arc: "Forward", range: 12, attackDice: 2, traits: "Beam; Precise" },
];

const WHITE_STAR_WEAPONS = [
  { name: "Improved Neutron Laser", arc: "Forward", range: 18, attackDice: 2, traits: "Beam; Precise; Triple Damage" },
  { name: "Molecular Pulsar", arc: "Forward", range: 10, attackDice: 4, traits: "Accurate; Armor Piercing; Double Damage" },
];

const TIGARA_WEAPONS = [
  { name: "Molecular Disruptor", arc: "Forward", range: 8, attackDice: 6, traits: "Armor Piercing; Double Damage; Precise" },
  { name: "Molecular Disruptor", arc: "Aft", range: 8, attackDice: 4, traits: "Armor Piercing; Double Damage; Precise" },
  { name: "Molecular Disruptor", arc: "Port", range: 8, attackDice: 4, traits: "Armor Piercing; Double Damage; Precise" },
  { name: "Molecular Disruptor", arc: "Starboard", range: 8, attackDice: 4, traits: "Armor Piercing; Double Damage; Precise" },
  { name: "Antimatter Converter", arc: "Forward", range: 4, attackDice: 6, traits: "Double Damage; Super Armor Piercing" },
  { name: "Fusion Cannon", arc: "Forward", range: 18, attackDice: 4, traits: "Mini Beam" },
  { name: "Fusion Cannon", arc: "Aft", range: 18, attackDice: 4, traits: "Mini Beam" },
  { name: "Fusion Cannon", arc: "Port", range: 18, attackDice: 4, traits: "Mini Beam" },
  { name: "Fusion Cannon", arc: "Starboard", range: 18, attackDice: 4, traits: "Mini Beam" },
];

const TINASHI_WEAPONS = [
  { name: "Neutron Laser", arc: "Forward", range: 25, attackDice: 4, traits: "Beam; Double Damage; Precise" },
  { name: "Fusion Cannon", arc: "Forward", range: 18, attackDice: 8, traits: "Mini Beam; Twin Linked" },
  { name: "Fusion Cannon", arc: "Aft", range: 18, attackDice: 6, traits: "Mini Beam; Twin Linked" },
  { name: "Fusion Cannon", arc: "Port", range: 18, attackDice: 6, traits: "Mini Beam; Twin Linked" },
  { name: "Fusion Cannon", arc: "Starboard", range: 18, attackDice: 6, traits: "Mini Beam; Twin Linked" },
];

type ShipMaintenanceSeed = {
  name: string;
  aliases: string[];
  filename: string;
  faction: string;
  pointCost: number;
  priorityLevel: string;
  shipClass: string;
  hull: number;
  troops: number;
  damage: number;
  damageThreshold: number;
  hullRating: number;
  crew: number;
  crewThreshold: number;
  speed: number;
  turns: number;
  turnAngle: number;
  crewQuality: string;
  traits: string;
  smallCraft: string | null;
  weaponRange: number;
  weaponDamage: number;
  description: string;
  weapons: WeaponMaintenanceSeed[];
};

type WeaponMaintenanceSeed = {
  name: string;
  arc: string;
  range: number;
  attackDice: number;
  traits: string;
};

function weaponSeedKey(weapon: Pick<WeaponMaintenanceSeed, "name" | "arc">): string {
  return `${weapon.name.trim().toLowerCase()}|${weapon.arc.trim().toLowerCase()}`;
}

async function syncWeaponsForShipModel(shipModelId: number, seeds: WeaponMaintenanceSeed[]): Promise<number> {
  const existing = await pool.query<{
    id: number;
    name: string;
    arc: string;
  }>(
    `
      SELECT id, name, arc
      FROM weapons
      WHERE ship_model_id = $1
      ORDER BY id
    `,
    [shipModelId],
  );
  const existingByKey = new Map<string, Array<{ id: number }>>();
  for (const row of existing.rows) {
    const key = weaponSeedKey(row);
    existingByKey.set(key, [...(existingByKey.get(key) ?? []), { id: row.id }]);
  }

  const seenSeedKeys = new Map<string, number>();
  const retainedIds: number[] = [];
  let synced = 0;

  // Routine maintenance must preserve matching weapon IDs. Live games and
  // browser state can legitimately hold those IDs during deploys.
  for (const seed of seeds) {
    const key = weaponSeedKey(seed);
    const occurrence = seenSeedKeys.get(key) ?? 0;
    seenSeedKeys.set(key, occurrence + 1);
    const existingId = existingByKey.get(key)?.[occurrence]?.id ?? null;

    if (existingId !== null) {
      await pool.query(
        `
          UPDATE weapons
          SET name = $2, arc = $3, range = $4, attack_dice = $5, traits = $6
          WHERE id = $1
        `,
        [existingId, seed.name, seed.arc, seed.range, seed.attackDice, seed.traits],
      );
      retainedIds.push(existingId);
    } else {
      const inserted = await pool.query<{ id: number }>(
        `
          INSERT INTO weapons (ship_model_id, name, arc, range, attack_dice, traits)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id
        `,
        [shipModelId, seed.name, seed.arc, seed.range, seed.attackDice, seed.traits],
      );
      const insertedId = inserted.rows[0]?.id;
      if (insertedId) retainedIds.push(insertedId);
    }
    synced++;
  }

  if (retainedIds.length > 0) {
    await pool.query(
      `
        DELETE FROM weapons
        WHERE ship_model_id = $1
          AND NOT (id = ANY($2::int[]))
      `,
      [shipModelId, retainedIds],
    );
  } else {
    await pool.query("DELETE FROM weapons WHERE ship_model_id = $1", [shipModelId]);
  }

  return synced;
}

const HYPERION_VARIANTS: ShipMaintenanceSeed[] = [
  {
    name: "Hyperion Heavy Cruiser",
    aliases: ["Hyperion Cruiser", "Hyperion Heavy Cruiser", "Hyperion-class Cruiser", "Hyperion-class Heavy Cruiser"],
    filename: "hyperion.glb",
    faction: "Earth Alliance",
    pointCost: 200,
    priorityLevel: "raid",
    shipClass: "Heavy Cruiser",
    hull: 5,
    troops: 3,
    damage: 28,
    damageThreshold: 6,
    hullRating: 5,
    crew: 32,
    crewThreshold: 6,
    speed: 8,
    turns: 2,
    turnAngle: 45,
    crewQuality: "Veteran",
    traits: "Anti-Fighter 2; Interceptors 2; Jump Engine",
    smallCraft: "Aurora Starfury Flight (1)",
    weaponRange: 18,
    weaponDamage: 4,
    description: "Earth Alliance Hyperion-class heavy cruiser, baseline Raid-level laser and pulse platform",
    weapons: [
      { name: "Heavy Laser Cannon", arc: "Boresight Forward", range: 18, attackDice: 4, traits: "Beam; Double Damage" },
      { name: "Heavy Laser Cannon", arc: "Boresight Aft", range: 18, attackDice: 2, traits: "Beam; Double Damage" },
      { name: "Medium Pulse Cannon", arc: "Forward", range: 10, attackDice: 4, traits: "" },
      { name: "Medium Pulse Cannon", arc: "Aft", range: 10, attackDice: 2, traits: "" },
      { name: "Medium Pulse Cannon", arc: "Port", range: 10, attackDice: 8, traits: "" },
      { name: "Medium Pulse Cannon", arc: "Starboard", range: 10, attackDice: 8, traits: "" },
      { name: "Plasma Cannon", arc: "Forward", range: 8, attackDice: 4, traits: "Armor Piercing; Twin Linked" },
    ],
  },
  {
    name: "Hyperion Assault Cruiser",
    aliases: ["Hyperion Assault Cruiser", "Hyperion-class Assault Cruiser"],
    filename: "hyperion.glb",
    faction: "Earth Alliance",
    pointCost: 150,
    priorityLevel: "skirmish",
    shipClass: "Assault Cruiser",
    hull: 5,
    troops: 6,
    damage: 28,
    damageThreshold: 6,
    hullRating: 5,
    crew: 32,
    crewThreshold: 6,
    speed: 8,
    turns: 2,
    turnAngle: 45,
    crewQuality: "Veteran",
    traits: "Anti-Fighter 2; Interceptors 2; Jump Engine; Shuttles 2",
    smallCraft: null,
    weaponRange: 10,
    weaponDamage: 8,
    description: "Earth Alliance Hyperion assault variant with troop capacity and close-range pulse/plasma batteries",
    weapons: [
      { name: "Medium Pulse Cannon", arc: "Forward", range: 10, attackDice: 4, traits: "" },
      { name: "Medium Pulse Cannon", arc: "Aft", range: 10, attackDice: 2, traits: "" },
      { name: "Medium Pulse Cannon", arc: "Port", range: 10, attackDice: 8, traits: "" },
      { name: "Medium Pulse Cannon", arc: "Starboard", range: 10, attackDice: 8, traits: "" },
      { name: "Plasma Cannon", arc: "Forward", range: 8, attackDice: 6, traits: "Armor Piercing; Twin Linked" },
    ],
  },
  {
    name: "Hyperion Command Cruiser",
    aliases: ["Hyperion Command Cruiser", "Hyperion-class Command Cruiser"],
    filename: "hyperion.glb",
    faction: "Earth Alliance",
    pointCost: 225,
    priorityLevel: "raid",
    shipClass: "Command Cruiser",
    hull: 5,
    troops: 4,
    damage: 28,
    damageThreshold: 6,
    hullRating: 5,
    crew: 36,
    crewThreshold: 6,
    speed: 8,
    turns: 2,
    turnAngle: 45,
    crewQuality: "Veteran",
    traits: "Anti-Fighter 4; Command +2; Interceptors 3; Jump Engine",
    smallCraft: "Aurora Starfury Flight (1)",
    weaponRange: 18,
    weaponDamage: 4,
    description: "Earth Alliance Hyperion command variant with improved command arrays and defensive systems",
    weapons: [
      { name: "Heavy Laser Cannon", arc: "Boresight Forward", range: 18, attackDice: 4, traits: "Beam; Double Damage" },
      { name: "Medium Pulse Cannon", arc: "Forward", range: 10, attackDice: 4, traits: "" },
      { name: "Medium Pulse Cannon", arc: "Aft", range: 10, attackDice: 2, traits: "" },
      { name: "Medium Pulse Cannon", arc: "Port", range: 10, attackDice: 8, traits: "" },
      { name: "Medium Pulse Cannon", arc: "Starboard", range: 10, attackDice: 8, traits: "" },
    ],
  },
  {
    name: "Hyperion Missile Cruiser",
    aliases: ["Hyperion Missile Cruiser", "Hyperion-class Missile Cruiser"],
    filename: "hyperion.glb",
    faction: "Earth Alliance",
    pointCost: 200,
    priorityLevel: "raid",
    shipClass: "Missile Cruiser",
    hull: 5,
    troops: 1,
    damage: 28,
    damageThreshold: 6,
    hullRating: 5,
    crew: 32,
    crewThreshold: 6,
    speed: 8,
    turns: 2,
    turnAngle: 45,
    crewQuality: "Veteran",
    traits: "Anti-Fighter 2; Interceptors 2; Jump Engine",
    smallCraft: null,
    weaponRange: 30,
    weaponDamage: 4,
    description: "Earth Alliance Hyperion missile variant with long-range slow-loading missile racks",
    weapons: [
      { name: "Laser Cannon", arc: "Boresight Forward", range: 12, attackDice: 4, traits: "Beam; Double Damage" },
      { name: "Missile Racks", arc: "Forward", range: 30, attackDice: 2, traits: "Precise; Slow Loading; Super Armor Piercing" },
      { name: "Missile Racks", arc: "Port", range: 30, attackDice: 4, traits: "Precise; Slow Loading; Super Armor Piercing" },
      { name: "Missile Racks", arc: "Starboard", range: 30, attackDice: 4, traits: "Precise; Slow Loading; Super Armor Piercing" },
      { name: "Plasma Cannon", arc: "Port", range: 8, attackDice: 6, traits: "Armor Piercing" },
      { name: "Plasma Cannon", arc: "Starboard", range: 8, attackDice: 6, traits: "Armor Piercing" },
    ],
  },
  {
    name: "Hyperion Pulse Cruiser",
    aliases: ["Hyperion Pulse Cruiser", "Hyperion-class Pulse Cruiser"],
    filename: "hyperion.glb",
    faction: "Earth Alliance",
    pointCost: 200,
    priorityLevel: "raid",
    shipClass: "Pulse Cruiser",
    hull: 5,
    troops: 3,
    damage: 28,
    damageThreshold: 6,
    hullRating: 5,
    crew: 32,
    crewThreshold: 6,
    speed: 8,
    turns: 2,
    turnAngle: 45,
    crewQuality: "Veteran",
    traits: "Anti-Fighter 2; Interceptors 2; Jump Engine",
    smallCraft: "Aurora Starfury Flight (1)",
    weaponRange: 12,
    weaponDamage: 10,
    description: "Earth Alliance Hyperion pulse variant focused on sustained pulse firepower",
    weapons: [
      { name: "Heavy Pulse Cannon", arc: "Forward", range: 12, attackDice: 10, traits: "Twin Linked" },
      { name: "Heavy Pulse Cannon", arc: "Aft", range: 12, attackDice: 6, traits: "Twin Linked" },
      { name: "Medium Pulse Cannon", arc: "Forward", range: 10, attackDice: 4, traits: "" },
      { name: "Medium Pulse Cannon", arc: "Aft", range: 10, attackDice: 2, traits: "" },
      { name: "Medium Pulse Cannon", arc: "Port", range: 10, attackDice: 8, traits: "" },
      { name: "Medium Pulse Cannon", arc: "Starboard", range: 10, attackDice: 8, traits: "" },
      { name: "Plasma Cannon", arc: "Forward", range: 8, attackDice: 4, traits: "Armor Piercing; Twin Linked" },
    ],
  },
  {
    name: "Hyperion Rail Cruiser",
    aliases: ["Hyperion Rail Cruiser", "Hyperion-class Rail Cruiser"],
    filename: "hyperion.glb",
    faction: "Earth Alliance",
    pointCost: 150,
    priorityLevel: "skirmish",
    shipClass: "Rail Cruiser",
    hull: 5,
    troops: 3,
    damage: 28,
    damageThreshold: 6,
    hullRating: 5,
    crew: 32,
    crewThreshold: 6,
    speed: 8,
    turns: 2,
    turnAngle: 45,
    crewQuality: "Veteran",
    traits: "Anti-Fighter 2; Interceptors 2; Jump Engine",
    smallCraft: "Aurora Starfury Flight (1)",
    weaponRange: 12,
    weaponDamage: 6,
    description: "Earth Alliance Hyperion rail variant built around armor-piercing railguns",
    weapons: [
      { name: "Railguns", arc: "Forward", range: 12, attackDice: 6, traits: "Armor Piercing; Double Damage" },
      { name: "Railguns", arc: "Aft", range: 12, attackDice: 4, traits: "Armor Piercing; Double Damage" },
      { name: "Plasma Cannon", arc: "Port", range: 8, attackDice: 6, traits: "Armor Piercing" },
      { name: "Plasma Cannon", arc: "Starboard", range: 8, attackDice: 6, traits: "Armor Piercing" },
    ],
  },
];

const FIGHTER_FLIGHTS = [
  {
    name: "Aurora Starfury Flight",
    filename: "aurora.glb",
    faction: "Earth Alliance",
    pointCost: 25,
    shipClass: "Fighter Flight",
    hull: 5,
    speed: 14,
    traits: "Dodge 2+; Dogfight +2; Fighter; Super Maneuverable",
    weaponRange: 2,
    weaponDamage: 2,
    description: "Earth Alliance Aurora Starfury fighter flight",
    aliases: ["Aurora Starfury Flight", "Aurora Starfury Wing", "Starfury Flight"],
    weapons: [
      { name: "Uni-Pulse Cannon", arc: "Turret", range: 2, attackDice: 2, traits: "Twin Linked" },
    ],
  },
  {
    name: "Thunderbolt Starfury Flight",
    filename: "thunderbolt.glb",
    faction: "Earth Alliance",
    pointCost: 25,
    shipClass: "Fighter Flight",
    hull: 5,
    speed: 12,
    traits: "Atmospheric; Dodge 3+; Dogfight +1; Fighter; Super Maneuverable",
    weaponRange: 4,
    weaponDamage: 2,
    description: "Earth Alliance Thunderbolt Starfury fighter flight",
    aliases: ["Thunderbolt Starfury Flight", "Thunderbolt Starfury Wing", "Thunderbolt Flight"],
    weapons: [
      { name: "Gatling Pulse Cannon", arc: "Turret", range: 2, attackDice: 2, traits: "" },
      { name: "Missile Rack", arc: "Turret", range: 4, attackDice: 2, traits: "Armor Piercing" },
    ],
  },
  {
    name: "Tiger Starfury Flight",
    filename: "tiger.glb",
    faction: "Earth Alliance",
    pointCost: 25,
    shipClass: "Fighter Flight",
    hull: 5,
    speed: 8,
    traits: "Dodge 3+; Dogfight +1; Fighter; Super Maneuverable",
    weaponRange: 4,
    weaponDamage: 2,
    description: "Earth Alliance early-years Tiger Starfury fighter flight",
    aliases: ["Tiger Starfury Flight", "Tiger Starfury Wing", "Tiger Flight"],
    weapons: [
      { name: "Burst Plasma Cannon", arc: "Turret", range: 2, attackDice: 1, traits: "Weak" },
      { name: "Missile Rack", arc: "Turret", range: 4, attackDice: 1, traits: "Armor Piercing" },
    ],
  },
  {
    name: "Nial Heavy Fighter Flight",
    filename: "nial.glb",
    faction: "Minbari Federation",
    pointCost: 25,
    shipClass: "Fighter Flight",
    hull: 4,
    speed: 15,
    traits: "Atmospheric; Dodge 2+; Dogfight +3; Fighter; Stealth +5; Super Maneuverable",
    weaponRange: 2,
    weaponDamage: 3,
    description: "Minbari Nial heavy fighter flight",
    aliases: ["Nial Heavy Fighter Flight", "Nial Fighter Flight", "Nial Flight", "Nial Wing"],
    weapons: [
      { name: "Light Fusion Cannon", arc: "Turret", range: 2, attackDice: 3, traits: "Mini Beam" },
    ],
  },
  {
    name: "Flyer Flight",
    filename: "flyer.glb",
    faction: "Minbari Federation",
    pointCost: 25,
    shipClass: "Fighter Flight",
    hull: 4,
    speed: 12,
    traits: "Atmospheric; Dodge 4+; Dogfight +1; Fighter; Stealth +5; Super Maneuverable",
    weaponRange: 2,
    weaponDamage: 2,
    description: "Minbari Flyer light fighter flight",
    aliases: ["Flyer Flight", "Minbari Flyer Flight", "Flyer Wing", "Minbari Flyer Wing"],
    weapons: [
      { name: "Light Fusion Cannon", arc: "Turret", range: 2, attackDice: 2, traits: "Mini Beam" },
    ],
  },
  {
    name: "Sentri Flight",
    filename: "sentri.glb",
    faction: "Centauri Republic",
    pointCost: 25,
    shipClass: "Fighter Flight",
    hull: 4,
    speed: 12,
    traits: "Dodge 3+; Dogfight +1; Fighter; Super Maneuverable",
    weaponRange: 2,
    weaponDamage: 2,
    description: "Centauri Republic Sentri fighter flight",
    aliases: ["Sentri Flight", "Sentri Fighter Flight", "Sentri Wing"],
    weapons: [
      { name: "Twin Particle Array", arc: "Turret", range: 2, attackDice: 2, traits: "Twin Linked" },
    ],
  },
];

type CsvShipSeed = {
  faction: string;
  name: string;
  shipClass: string;
  hull: number;
  troops: number;
  damage: number | null;
  damageThreshold: number | null;
  crew: number | null;
  crewThreshold: number | null;
  speed: number;
  turns: number;
  turnAngle: number;
  crewQuality: string;
  shield: number;
  shieldMax: number;
  shieldRegenRate: number;
  traits: string;
  smallCraft: string | null;
};

type CsvWeaponSeed = {
  shipName: string;
  name: string;
  arc: string;
  range: number;
  attackDice: number;
  traits: string;
};

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\"") {
      if (quoted && line[i + 1] === "\"") {
        current += "\"";
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === "," && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }

  cells.push(current.trim());
  return cells;
}

function intCell(value: string | undefined, fallback = 0): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableIntCell(value: string | undefined): number | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed.toUpperCase() === "N/A") return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveActaShipCsv(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "attached_assets", "acta_ships_12APR26_1779321905109.csv"),
    path.resolve(process.cwd(), "..", "..", "attached_assets", "acta_ships_12APR26_1779321905109.csv"),
    path.resolve(process.cwd(), "..", "attached_assets", "acta_ships_12APR26_1779321905109.csv"),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}

function readActaShipCsv(): { ships: CsvShipSeed[]; weaponsByShip: Map<string, CsvWeaponSeed[]>; source: string } {
  const csvPath = resolveActaShipCsv();
  const csvText = csvPath ? fs.readFileSync(csvPath, "utf8") : FALLBACK_ACTA_SHIP_CSV;
  const source = csvPath ?? "embedded-fallback";

  const ships: CsvShipSeed[] = [];
  const weaponsByShip = new Map<string, CsvWeaponSeed[]>();
  let section: "ships" | "weapons" | null = null;

  const lines = csvText.split(/\r?\n/g);
  for (const line of lines) {
    const cells = parseCsvLine(line);
    const first = cells[0]?.trim();
    const second = cells[1]?.trim();

    if (!first && !second) continue;
    if (first === "SHIP STATS" || first === "WEAPONS") continue;
    if (first === "Faction" && second === "Name") {
      section = "ships";
      continue;
    }
    if (first === "Faction" && second === "Ship Name") {
      section = "weapons";
      continue;
    }

    if (section === "ships" && first && second) {
      ships.push({
        faction: first,
        name: second,
        shipClass: cells[2] ?? "",
        hull: intCell(cells[3], 4),
        troops: intCell(cells[4], 0),
        damage: nullableIntCell(cells[5]),
        damageThreshold: nullableIntCell(cells[6]),
        crew: nullableIntCell(cells[7]),
        crewThreshold: nullableIntCell(cells[8]),
        speed: intCell(cells[9], 0),
        turns: intCell(cells[10], 0),
        turnAngle: intCell(cells[11], 45),
        crewQuality: cells[12] || "Regular",
        shield: intCell(cells[13], 0),
        shieldMax: intCell(cells[14], 0),
        shieldRegenRate: intCell(cells[15], 0),
        traits: cells[16] ?? "",
        smallCraft: cells[17] || null,
      });
      continue;
    }

    if (section === "weapons" && second) {
      const weapon: CsvWeaponSeed = {
        shipName: second,
        name: cells[3] || "Weapon",
        arc: cells[4] || "Forward",
        range: intCell(cells[5], 0),
        attackDice: intCell(cells[6], 0),
        traits: cells[7] ?? "",
      };
      const key = weapon.shipName.toLowerCase();
      weaponsByShip.set(key, [...(weaponsByShip.get(key) ?? []), weapon]);
    }
  }

  return { ships, weaponsByShip, source };
}

async function seedActaCsvShips(): Promise<void> {
  const csv = readActaShipCsv();
  let seededShips = 0;
  let seededWeapons = 0;

  for (const ship of csv.ships) {
    const key = ship.name.toLowerCase();
    const priority = SHIP_PRIORITY_BY_NAME.get(key) ?? "raid";
    const pointCost = POINT_COST_BY_PRIORITY[priority] ?? 100;
    const filename = CSV_MODEL_FILENAMES[key] ?? `${key.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.glb`;
    const primaryWeapon = csv.weaponsByShip.get(key)?.[0];
    const shipResult = await pool.query<{ id: number }>(
      `
        WITH updated AS (
          UPDATE ship_models
          SET
            name = $1,
            filename = $2,
            faction = $3,
            point_cost = $4,
            priority_level = $5,
            ship_class = $6,
            hull = $7,
            troops = $8,
            damage = $9,
            damage_threshold = $10,
            hull_rating = $7,
            crew = $11,
            crew_threshold = $12,
            speed = $13,
            turns = $14,
            turn_angle = $15,
            crew_quality = $16,
            shield = $17,
            shield_max = $18,
            shield_regen_rate = $19,
            traits = $20,
            small_craft = $21,
            base_radius_inches = $22,
            hull_points = COALESCE($9, 1),
            weapon_range = $23,
            weapon_damage = $24,
            description = $25
          WHERE lower(name) = lower($1)
          RETURNING id
        ),
        inserted AS (
          INSERT INTO ship_models (
            name, filename, faction, point_cost, priority_level, ship_class,
            hull, troops, damage, damage_threshold, hull_rating, crew,
            crew_threshold, speed, turns, turn_angle, crew_quality, shield,
            shield_max, shield_regen_rate, traits, small_craft, hull_points,
            base_radius_inches, weapon_range, weapon_damage, description
          )
          SELECT
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $7, $11,
            $12, $13, $14, $15, $16, $17,
            $18, $19, $20, $21, COALESCE($9, 1),
            $22, $23, $24, $25
          WHERE NOT EXISTS (SELECT 1 FROM updated)
          RETURNING id
        )
        SELECT id FROM updated
        UNION ALL
        SELECT id FROM inserted
        LIMIT 1
      `,
      [
        ship.name,
        filename,
        ship.faction,
        pointCost,
        priority,
        ship.shipClass,
        ship.hull,
        ship.troops,
        ship.damage,
        ship.damageThreshold,
        ship.crew,
        ship.crewThreshold,
        ship.speed,
        ship.turns,
        ship.turnAngle,
        ship.crewQuality,
        ship.shield,
        ship.shieldMax,
        ship.shieldRegenRate,
        ship.traits,
        ship.smallCraft,
        CAPITAL_BASE_RADIUS_INCHES,
        primaryWeapon?.range ?? 0,
        primaryWeapon?.attackDice ?? 0,
        `${ship.faction} ${ship.name} from the checked-in ACTA ship reference sheet`,
      ],
    );

    const shipId = shipResult.rows[0]?.id;
    if (!shipId) continue;
    seededShips++;

    const weapons = csv.weaponsByShip.get(key) ?? [];
    if (weapons.length === 0) continue;
    seededWeapons += await syncWeaponsForShipModel(shipId, weapons);
  }

  logger.info(
    { source: csv.source, seededShips, seededWeapons },
    "Seeded ACTA base ship roster",
  );
}

async function removeStaleHyperionBaseRows(): Promise<void> {
  const result = await pool.query<{ deleted_count: number }>(
    `
      WITH canonical AS (
        SELECT id
        FROM ship_models
        WHERE lower(name) = lower('Hyperion Heavy Cruiser')
        ORDER BY id
        LIMIT 1
      ),
      stale AS (
        SELECT id
        FROM ship_models
        WHERE lower(name) = lower('Hyperion Cruiser')
          AND EXISTS (SELECT 1 FROM canonical)
      ),
      reassigned_ships AS (
        UPDATE ships
        SET ship_model_id = (SELECT id FROM canonical)
        WHERE ship_model_id IN (SELECT id FROM stale)
        RETURNING id
      ),
      deleted_weapons AS (
        DELETE FROM weapons
        WHERE ship_model_id IN (SELECT id FROM stale)
        RETURNING id
      ),
      deleted_models AS (
        DELETE FROM ship_models
        WHERE id IN (SELECT id FROM stale)
        RETURNING id
      )
      SELECT count(*)::int AS deleted_count FROM deleted_models
    `,
  );

  const deletedCount = result.rows[0]?.deleted_count ?? 0;
  if (deletedCount > 0) {
    logger.info({ deletedCount }, "Removed stale duplicate Hyperion Cruiser ship-model rows");
  }
}

async function removeDuplicateCanonicalShipRows(): Promise<void> {
  const duplicateProneShipNames = [
    "Avioki Heavy Cruiser",
    "G'Quan Heavy Cruiser",
    "Shadow Battlecrab",
    "Tinashi Warship",
  ];

  const result = await pool.query<{ name: string; deleted_count: number }>(
    `
      WITH target_names(name) AS (
        SELECT unnest($1::text[])
      ),
      ranked AS (
        SELECT
          sm.id,
          sm.name,
          lower(sm.name) AS name_key,
          row_number() OVER (
            PARTITION BY lower(sm.name)
            ORDER BY
              count(w.id) FILTER (
                WHERE trim(coalesce(w.name, '')) <> ''
                  AND lower(trim(coalesce(w.name, ''))) <> 'weapon'
              ) DESC,
              sm.id ASC
          ) AS rank
        FROM ship_models sm
        INNER JOIN target_names tn ON lower(sm.name) = lower(tn.name)
        LEFT JOIN weapons w ON w.ship_model_id = sm.id
        GROUP BY sm.id, sm.name
      ),
      canonical AS (
        SELECT name_key, id
        FROM ranked
        WHERE rank = 1
      ),
      duplicates AS (
        SELECT r.id, r.name, c.id AS canonical_id
        FROM ranked r
        INNER JOIN canonical c ON c.name_key = r.name_key
        WHERE r.rank > 1
      ),
      reassigned_ships AS (
        UPDATE ships s
        SET ship_model_id = d.canonical_id
        FROM duplicates d
        WHERE s.ship_model_id = d.id
        RETURNING s.id
      ),
      deleted_weapons AS (
        DELETE FROM weapons
        WHERE ship_model_id IN (SELECT id FROM duplicates)
        RETURNING id
      ),
      deleted_models AS (
        DELETE FROM ship_models
        WHERE id IN (SELECT id FROM duplicates)
        RETURNING name
      )
      SELECT name, count(*)::int AS deleted_count
      FROM deleted_models
      GROUP BY name
      ORDER BY name
    `,
    [duplicateProneShipNames],
  );

  if (result.rows.length > 0) {
    logger.info({ removedShipModelDuplicates: result.rows }, "Removed duplicate canonical ship-model rows");
  }
}

export async function ensureActaAllocationSchema(): Promise<void> {
  try {
    await pool.query(`
      ALTER TABLE ship_models
      ADD COLUMN IF NOT EXISTS priority_level text NOT NULL DEFAULT 'raid'
    `);
    await pool.query(`
      ALTER TABLE ship_models
      ADD COLUMN IF NOT EXISTS ai_profile text NOT NULL DEFAULT 'brawler'
    `);
    await pool.query(`
      ALTER TABLE ship_models
      ADD COLUMN IF NOT EXISTS base_radius_inches real NOT NULL DEFAULT ${CAPITAL_BASE_RADIUS_INCHES}
    `);
    await pool.query(`
      ALTER TABLE game_units
      ADD COLUMN IF NOT EXISTS base_radius_inches real NOT NULL DEFAULT ${CAPITAL_BASE_RADIUS_INCHES}
    `);
    await pool.query(`
      ALTER TABLE game_units
      ALTER COLUMN hex_q TYPE real USING hex_q::real,
      ALTER COLUMN hex_r TYPE real USING hex_r::real
    `);
    await pool.query(`
      ALTER TABLE games
      ADD COLUMN IF NOT EXISTS priority_level text NOT NULL DEFAULT 'raid'
    `);
    await pool.query(`
      ALTER TABLE games
      ADD COLUMN IF NOT EXISTS allocation_points integer NOT NULL DEFAULT 5
    `);
    await pool.query(`
      ALTER TABLE games
      ADD COLUMN IF NOT EXISTS opponent_kind text NOT NULL DEFAULT 'human'
    `);
    await pool.query(`
      ALTER TABLE games
      ADD COLUMN IF NOT EXISTS ai_profile text
    `);
    await pool.query(`
      ALTER TABLE games
      ADD COLUMN IF NOT EXISTS ai_state jsonb NOT NULL DEFAULT '{}'::jsonb
    `);
    await pool.query(`
      ALTER TABLE game_units
      ADD COLUMN IF NOT EXISTS distance_since_last_turn_this_activation integer NOT NULL DEFAULT 0
    `);
    await pool.query(`
      ALTER TABLE game_units
      ADD COLUMN IF NOT EXISTS last_self_repair_round integer NOT NULL DEFAULT 0
    `);
    await pool.query(`
      ALTER TABLE game_units
      ADD COLUMN IF NOT EXISTS carried_fighters jsonb NOT NULL DEFAULT '[]'::jsonb
    `);
    await pool.query(`
      ALTER TABLE game_units
      ADD COLUMN IF NOT EXISTS launched_from_unit_id integer
    `);
    await pool.query(`
      ALTER TABLE game_units
      ADD COLUMN IF NOT EXISTS fighter_bay_operations_round integer NOT NULL DEFAULT 0
    `);
    await pool.query(`
      ALTER TABLE game_units
      ADD COLUMN IF NOT EXISTS fighter_bay_operations_used integer NOT NULL DEFAULT 0
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_attack_audit_logs (
        id serial PRIMARY KEY,
        game_id integer NOT NULL,
        round integer NOT NULL,
        phase text NOT NULL,
        actor_kind text NOT NULL DEFAULT 'player',
        actor_player_id text,
        attacker_unit_id integer NOT NULL,
        target_unit_id integer NOT NULL,
        weapon_id integer NOT NULL,
        summary text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS game_attack_audit_logs_game_created_idx
      ON game_attack_audit_logs (game_id, created_at, id)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_movement_audit_logs (
        id serial PRIMARY KEY,
        game_id integer NOT NULL,
        round integer NOT NULL,
        phase text NOT NULL,
        actor_kind text NOT NULL DEFAULT 'player',
        actor_player_id text,
        unit_id integer NOT NULL,
        movement_kind text NOT NULL DEFAULT 'move',
        summary text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS game_movement_audit_logs_game_created_idx
      ON game_movement_audit_logs (game_id, created_at, id)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_special_action_audit_logs (
        id serial PRIMARY KEY,
        game_id integer NOT NULL,
        round integer NOT NULL,
        phase text NOT NULL,
        actor_kind text NOT NULL DEFAULT 'player',
        actor_player_id text,
        unit_id integer NOT NULL,
        action text NOT NULL,
        success boolean NOT NULL,
        cq_required integer,
        cq_roll integer,
        cq_total integer,
        target_unit_id integer,
        summary text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS game_special_action_audit_logs_game_created_idx
      ON game_special_action_audit_logs (game_id, created_at, id)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bug_reports (
        id serial PRIMARY KEY,
        game_id integer NOT NULL,
        reporter_player_id text NOT NULL,
        round integer NOT NULL,
        phase text NOT NULL,
        active_player_id text,
        active_unit_id integer,
        message text NOT NULL,
        rescue_requested boolean NOT NULL DEFAULT false,
        rescue_applied boolean NOT NULL DEFAULT false,
        snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS bug_reports_game_created_idx
      ON bug_reports (game_id, created_at, id)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_chat_messages (
        id serial PRIMARY KEY,
        game_id integer NOT NULL,
        sender_player_id text NOT NULL,
        sender_name text,
        message text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS game_chat_messages_game_created_idx
      ON game_chat_messages (game_id, created_at, id)
    `);
    await pool.query(`
      UPDATE games
      SET opponent_kind = 'human'
      WHERE opponent_kind IS NULL OR opponent_kind NOT IN ('human', 'ai')
    `);
    await pool.query(`
      UPDATE games
      SET allocation_points = GREATEST(1, point_limit / 100)
      WHERE allocation_points = 5
        AND point_limit IS NOT NULL
        AND point_limit <> 500
    `);
    await pool.query(
      `
        UPDATE ship_models
        SET base_radius_inches = $1
        WHERE base_radius_inches IS NULL OR base_radius_inches <= 0
      `,
      [CAPITAL_BASE_RADIUS_INCHES],
    );
    await pool.query(
      `
        UPDATE ship_models
        SET base_radius_inches = $1
        WHERE base_radius_inches <> $1
      `,
      [CAPITAL_BASE_RADIUS_INCHES],
    );
    await pool.query(
      `
        UPDATE game_units
        SET base_radius_inches = $1
        WHERE base_radius_inches <> $1
      `,
      [CAPITAL_BASE_RADIUS_INCHES],
    );

    await seedActaCsvShips();

    for (const seed of SHIP_PRIORITY_SEEDS) {
      await pool.query(
        `
          UPDATE ship_models
          SET priority_level = $2
          WHERE lower(name) = lower($1)
        `,
        [seed.name, seed.priority],
      );
    }

    for (const ship of HYPERION_VARIANTS) {
      const shipResult = await pool.query<{ id: number }>(
        `
          WITH target AS (
            SELECT id
            FROM ship_models
            WHERE lower(name) = ANY($24::text[])
            ORDER BY
              CASE WHEN lower(name) = lower($1) THEN 0 ELSE 1 END,
              id
            LIMIT 1
          ),
          updated AS (
            UPDATE ship_models
            SET
              name = $1,
              filename = $2,
              faction = $3,
              point_cost = $4,
              priority_level = $5,
              ship_class = $6,
              hull = $7,
              troops = $8,
              damage = $9,
              damage_threshold = $10,
              hull_rating = $11,
              crew = $12,
              crew_threshold = $13,
              speed = $14,
              turns = $15,
              turn_angle = $16,
              crew_quality = $17,
              shield = 0,
              shield_max = 0,
              shield_regen_rate = 0,
              traits = $18,
              small_craft = $19,
              base_radius_inches = $20,
              hull_points = $9,
              weapon_range = $21,
              weapon_damage = $22,
              description = $23
            WHERE id IN (SELECT id FROM target)
            RETURNING id
          ),
          inserted AS (
            INSERT INTO ship_models (
              name, filename, faction, point_cost, priority_level, ship_class,
              hull, troops, damage, damage_threshold, hull_rating, crew,
              crew_threshold, speed, turns, turn_angle, crew_quality, shield,
              shield_max, shield_regen_rate, traits, small_craft, hull_points,
              base_radius_inches, weapon_range, weapon_damage, description
            )
            SELECT
              $1, $2, $3, $4, $5, $6,
              $7, $8, $9, $10, $11, $12,
              $13, $14, $15, $16, $17, 0,
              0, 0, $18, $19, $9,
              $20, $21, $22, $23
            WHERE NOT EXISTS (SELECT 1 FROM updated)
            RETURNING id
          )
          SELECT id FROM updated
          UNION ALL
          SELECT id FROM inserted
          LIMIT 1
        `,
        [
          ship.name,
          ship.filename,
          ship.faction,
          ship.pointCost,
          ship.priorityLevel,
          ship.shipClass,
          ship.hull,
          ship.troops,
          ship.damage,
          ship.damageThreshold,
          ship.hullRating,
          ship.crew,
          ship.crewThreshold,
          ship.speed,
          ship.turns,
          ship.turnAngle,
          ship.crewQuality,
          ship.traits,
          ship.smallCraft,
          CAPITAL_BASE_RADIUS_INCHES,
          ship.weaponRange,
          ship.weaponDamage,
          ship.description,
          ship.aliases.map(alias => alias.toLowerCase()),
        ],
      );

      const shipId = shipResult.rows[0]?.id;
      if (shipId) {
        await syncWeaponsForShipModel(shipId, ship.weapons);
      }
    }

    await removeStaleHyperionBaseRows();

    for (const fighter of FIGHTER_FLIGHTS) {
      const fighterResult = await pool.query<{ id: number }>(
        `
          WITH updated AS (
            UPDATE ship_models
            SET
              name = $1,
              filename = $2,
              faction = $3,
              point_cost = $4,
              priority_level = 'patrol',
              ship_class = $5,
              hull = $6,
              troops = 0,
              damage = NULL,
              damage_threshold = NULL,
              hull_rating = $6,
              crew = NULL,
              crew_threshold = NULL,
              speed = $7,
              turns = 0,
              turn_angle = 360,
              crew_quality = 'N/A',
              shield = 0,
              shield_max = 0,
              shield_regen_rate = 0,
              traits = $8,
              small_craft = NULL,
              base_radius_inches = $13,
              hull_points = 1,
              weapon_range = $9,
              weapon_damage = $10,
              description = $11
            WHERE lower(filename) = lower($2)
              OR lower(name) = ANY($12::text[])
            RETURNING id
          ),
          inserted AS (
            INSERT INTO ship_models (
              name, filename, faction, point_cost, priority_level, ship_class,
              hull, troops, damage, damage_threshold, hull_rating, crew,
              crew_threshold, speed, turns, turn_angle, crew_quality, shield,
              shield_max, shield_regen_rate, traits, small_craft, hull_points,
              base_radius_inches, weapon_range, weapon_damage, description
            )
            SELECT
              $1, $2, $3, $4, 'patrol', $5,
              $6, 0, NULL, NULL, $6, NULL,
              NULL, $7, 0, 360, 'N/A', 0,
              0, 0, $8, NULL, 1, $13,
              $9, $10, $11
            WHERE NOT EXISTS (SELECT 1 FROM updated)
            RETURNING id
          )
          SELECT id FROM updated
          UNION ALL
          SELECT id FROM inserted
          LIMIT 1
        `,
        [
          fighter.name,
          fighter.filename,
          fighter.faction,
          fighter.pointCost,
          fighter.shipClass,
          fighter.hull,
          fighter.speed,
          fighter.traits,
          fighter.weaponRange,
          fighter.weaponDamage,
          fighter.description,
          fighter.aliases.map(alias => alias.toLowerCase()),
          FIGHTER_BASE_RADIUS_INCHES,
        ],
      );

      const fighterId = fighterResult.rows[0]?.id;
      if (fighterId) {
        await syncWeaponsForShipModel(fighterId, fighter.weapons);
      }
    }

    const tethys = await pool.query<{ id: number }>(
      `
        WITH updated AS (
          UPDATE ship_models
          SET
            name = 'Tethys-class Cutter',
            filename = 'tethys.glb',
            faction = 'Earth Alliance',
            point_cost = 25,
            priority_level = 'patrol',
            ship_class = 'Cutter',
            hull = 4,
            troops = 0,
            damage = 6,
            damage_threshold = 2,
            hull_rating = 4,
            crew = 8,
            crew_threshold = 2,
            speed = 10,
            turns = 2,
            turn_angle = 45,
            crew_quality = 'Regular',
            shield = 0,
            shield_max = 0,
            shield_regen_rate = 0,
            traits = 'Interceptors 1',
            small_craft = NULL,
            base_radius_inches = $1,
            hull_points = 6,
            weapon_range = 8,
            weapon_damage = 4,
            description = 'Earth Alliance Tethys-class cutter, a small patrol vessel fielded two per Patrol slot'
          WHERE lower(filename) IN ('tethys.glb', 'tethys.obj')
            OR lower(name) IN ('tethys', 'tethys cutter', 'tethys-class cutter', 'tethys-class cutter patrol')
          RETURNING id
        ),
        inserted AS (
          INSERT INTO ship_models (
            name, filename, faction, point_cost, priority_level, ship_class,
            hull, troops, damage, damage_threshold, hull_rating, crew,
            crew_threshold, speed, turns, turn_angle, crew_quality, shield,
            shield_max, shield_regen_rate, traits, small_craft, hull_points,
            base_radius_inches, weapon_range, weapon_damage, description
          )
          SELECT
            'Tethys-class Cutter', 'tethys.glb', 'Earth Alliance', 25,
            'patrol', 'Cutter', 4, 0, 6, 2, 4, 8, 2, 10, 2, 45,
            'Regular', 0, 0, 0,
            'Interceptors 1',
            NULL, 6,
            $1, 8, 4,
            'Earth Alliance Tethys-class cutter, a small patrol vessel fielded two per Patrol slot'
          WHERE NOT EXISTS (SELECT 1 FROM updated)
          RETURNING id
        )
        SELECT id FROM updated
        UNION ALL
        SELECT id FROM inserted
        LIMIT 1
      `,
      [CAPITAL_BASE_RADIUS_INCHES],
    );

    const tethysId = tethys.rows[0]?.id;
    if (tethysId) {
      await syncWeaponsForShipModel(tethysId, TETHYS_WEAPONS);
    }

    const sagittarius = await pool.query<{ id: number }>(
      `
        UPDATE ship_models
        SET
          name = 'Sagittarius Missile Cruiser',
          filename = 'sagittarius.glb',
          faction = 'Earth Alliance',
          point_cost = 175,
          priority_level = 'skirmish',
          ship_class = 'Cruiser',
          hull = 4,
          troops = 1,
          damage = 23,
          damage_threshold = 6,
          hull_rating = 4,
          crew = 24,
          crew_threshold = 6,
          speed = 6,
          turns = 1,
          turn_angle = 45,
          crew_quality = 'Regular',
          shield = 0,
          shield_max = 0,
          shield_regen_rate = 0,
          traits = 'Anti-Fighter 1; Interceptors 2',
          small_craft = NULL,
          hull_points = 23,
          weapon_range = 30,
          weapon_damage = 6,
          description = 'Early Earth Alliance mobile missile artillery platform'
        WHERE lower(name) IN ('sagittarius', 'sagittarius missile cruiser')
        RETURNING id
      `,
    );

    const sagittariusId = sagittarius.rows[0]?.id;
    if (sagittariusId) {
      await syncWeaponsForShipModel(sagittariusId, SAGITTARIUS_WEAPONS);
    }

    const battlecrab = await pool.query<{ id: number }>(
      `
        UPDATE ship_models
        SET
          name = 'Shadow Battlecrab',
          filename = 'battlecrab.glb',
          faction = 'Shadows',
          ai_profile = 'apex-predator',
          point_cost = 500,
          priority_level = 'armageddon',
          ship_class = 'Ancient Dreadnought',
          hull = 6,
          troops = 0,
          damage = 150,
          damage_threshold = 38,
          hull_rating = 6,
          crew = 0,
          crew_threshold = 0,
          speed = 8,
          turns = 0,
          turn_angle = 0,
          crew_quality = 'Ancient',
          shield = 20,
          shield_max = 20,
          shield_regen_rate = 10,
          traits = 'Ancient; Super Maneuverable; Stealth Penetration; Redundant Systems; Self Repair:3d6',
          small_craft = NULL,
          hull_points = 150,
          weapon_range = 24,
          weapon_damage = 6,
          description = 'Ancient Shadow battlecrab with a molecular slicer beam'
        WHERE lower(name) IN ('shadow cruiser', 'shadow cruiser (ancient)', 'shadow battlecrab', 'battlecrab')
        RETURNING id
      `,
    );

    const battlecrabId = battlecrab.rows[0]?.id;
    if (battlecrabId) {
      await syncWeaponsForShipModel(battlecrabId, BATTLECRAB_WEAPONS);
    }

    const avioki = await pool.query<{ id: number }>(
      `
        UPDATE ship_models
        SET
          name = 'Avioki Heavy Cruiser',
          filename = 'avioki.glb',
          faction = 'League of Nonaligned Worlds',
          point_cost = 225,
          priority_level = 'battle',
          ship_class = 'Heavy Cruiser',
          hull = 6,
          troops = 4,
          damage = 64,
          damage_threshold = 10,
          hull_rating = 6,
          crew = 68,
          crew_threshold = 10,
          speed = 6,
          turns = 1,
          turn_angle = 45,
          crew_quality = 'Regular',
          shield = 0,
          shield_max = 0,
          shield_regen_rate = 0,
          traits = 'Anti-Fighter 2; Jump Engine; Lumbering',
          small_craft = NULL,
          hull_points = 64,
          weapon_range = 18,
          weapon_damage = 8,
          description = 'Brakiri Avioki heavy cruiser serving with the League of Non-Aligned Worlds'
        WHERE lower(name) IN ('avioki', 'avioki heavy cruiser')
        RETURNING id
      `,
    );

    const aviokiId = avioki.rows[0]?.id;
    if (aviokiId) {
      await syncWeaponsForShipModel(aviokiId, AVIOKI_WEAPONS);
    }

    const gquan = await pool.query<{ id: number }>(
      `
        WITH updated AS (
          UPDATE ship_models
          SET
            name = 'G''Quan Heavy Cruiser',
            filename = 'gquan.glb',
            faction = 'Narn Regime',
            point_cost = 225,
            priority_level = 'battle',
            ship_class = 'Heavy Cruiser',
            hull = 6,
            troops = 8,
            damage = 55,
            damage_threshold = 13,
            hull_rating = 6,
            crew = 70,
            crew_threshold = 19,
            speed = 6,
            turns = 1,
            turn_angle = 45,
            crew_quality = 'Regular',
            shield = 0,
            shield_max = 0,
            shield_regen_rate = 0,
            traits = 'Anti-Fighter 2; Jump Engine; Lumbering',
            small_craft = 'Frazi (2)',
            base_radius_inches = $1,
            hull_points = 55,
            weapon_range = 30,
            weapon_damage = 4,
            description = 'Narn Regime G''Quan heavy cruiser with heavy lasers, energy mines, and broadside batteries'
          WHERE lower(filename) IN ('gquan.obj', 'gquan.glb')
            OR lower(name) IN ('g''quan cruiser', 'g''quan heavy cruiser', 'gquan cruiser', 'gquan heavy cruiser')
          RETURNING id
        ),
        inserted AS (
          INSERT INTO ship_models (
            name, filename, faction, point_cost, priority_level, ship_class,
            hull, troops, damage, damage_threshold, hull_rating, crew,
            crew_threshold, speed, turns, turn_angle, crew_quality, shield,
            shield_max, shield_regen_rate, traits, small_craft, hull_points,
            base_radius_inches, weapon_range, weapon_damage, description
          )
          SELECT
            'G''Quan Heavy Cruiser', 'gquan.glb', 'Narn Regime', 225,
            'battle', 'Heavy Cruiser', 6, 8, 55, 13, 6, 70, 19, 6, 1, 45,
            'Regular', 0, 0, 0,
            'Anti-Fighter 2; Jump Engine; Lumbering',
            'Frazi (2)', 55,
            $1, 30, 4,
            'Narn Regime G''Quan heavy cruiser with heavy lasers, energy mines, and broadside batteries'
          WHERE NOT EXISTS (SELECT 1 FROM updated)
          RETURNING id
        )
        SELECT id FROM updated
        UNION ALL
        SELECT id FROM inserted
        LIMIT 1
      `,
      [CAPITAL_BASE_RADIUS_INCHES],
    );

    const gquanId = gquan.rows[0]?.id;
    if (gquanId) {
      await syncWeaponsForShipModel(gquanId, GQUAN_WEAPONS);
    }

    const avenger = await pool.query<{ id: number }>(
      `
        WITH updated AS (
          UPDATE ship_models
          SET
            name = 'Avenger Heavy Carrier',
            filename = 'avenger.glb',
            faction = 'Earth Alliance',
            point_cost = 200,
            priority_level = 'raid',
            ship_class = 'Heavy Carrier',
            hull = 5,
            troops = 6,
            damage = 40,
            damage_threshold = 10,
            hull_rating = 5,
            crew = 50,
            crew_threshold = 12,
            speed = 7,
            turns = 1,
            turn_angle = 45,
            crew_quality = 'Regular',
            shield = 0,
            shield_max = 0,
            shield_regen_rate = 0,
            traits = 'Carrier 4; Command +1; Fleet Carrier; Interceptors 2; Jump Engine; Lumbering; Shuttles 2',
            small_craft = 'Aurora Starfury Flight (8)',
            base_radius_inches = $1,
            hull_points = 40,
            weapon_range = 8,
            weapon_damage = 6,
            description = 'Earth Alliance Avenger-class heavy carrier with extensive Starfury launch capacity'
          WHERE lower(filename) = 'avenger.glb'
            OR lower(name) IN ('avenger', 'avenger heavy carrier', 'avenger-class heavy carrier')
          RETURNING id
        ),
        inserted AS (
          INSERT INTO ship_models (
            name, filename, faction, point_cost, priority_level, ship_class,
            hull, troops, damage, damage_threshold, hull_rating, crew,
            crew_threshold, speed, turns, turn_angle, crew_quality, shield,
            shield_max, shield_regen_rate, traits, small_craft, hull_points,
            base_radius_inches, weapon_range, weapon_damage, description
          )
          SELECT
            'Avenger Heavy Carrier', 'avenger.glb', 'Earth Alliance', 200,
            'raid', 'Heavy Carrier', 5, 6, 40, 10, 5, 50, 12, 7, 1, 45,
            'Regular', 0, 0, 0,
            'Carrier 4; Command +1; Fleet Carrier; Interceptors 2; Jump Engine; Lumbering; Shuttles 2',
            'Aurora Starfury Flight (8)', 40,
            $1, 8, 6,
            'Earth Alliance Avenger-class heavy carrier with extensive Starfury launch capacity'
          WHERE NOT EXISTS (SELECT 1 FROM updated)
          RETURNING id
        )
        SELECT id FROM updated
        UNION ALL
        SELECT id FROM inserted
        LIMIT 1
      `,
      [CAPITAL_BASE_RADIUS_INCHES],
    );

    const avengerId = avenger.rows[0]?.id;
    if (avengerId) {
      await syncWeaponsForShipModel(avengerId, AVENGER_WEAPONS);
    }

    const primus = await pool.query<{ id: number }>(
      `
        WITH updated AS (
          UPDATE ship_models
          SET
            name = 'Primus Battlecruiser',
            filename = 'primus.glb',
            faction = 'Centauri Republic',
            point_cost = 250,
            priority_level = 'battle',
            ship_class = 'Battlecruiser',
            hull = 6,
            troops = 5,
            damage = 52,
            damage_threshold = 12,
            hull_rating = 6,
            crew = 65,
            crew_threshold = 15,
            speed = 8,
            turns = 1,
            turn_angle = 45,
            crew_quality = 'Regular',
            shield = 0,
            shield_max = 0,
            shield_regen_rate = 0,
            traits = 'Anti-Fighter 2; Jump Engine; Lumbering',
            small_craft = 'Sentri Flight (2)',
            base_radius_inches = $1,
            hull_points = 52,
            weapon_range = 18,
            weapon_damage = 6,
            description = 'Centauri Republic Primus-class battlecruiser, a heavy fleet-line warship'
          WHERE lower(filename) = 'primus.glb'
            OR lower(name) IN ('primus', 'primus battle cruiser', 'primus battlecruiser', 'primus-class battlecruiser')
          RETURNING id
        ),
        inserted AS (
          INSERT INTO ship_models (
            name, filename, faction, point_cost, priority_level, ship_class,
            hull, troops, damage, damage_threshold, hull_rating, crew,
            crew_threshold, speed, turns, turn_angle, crew_quality, shield,
            shield_max, shield_regen_rate, traits, small_craft, hull_points,
            base_radius_inches, weapon_range, weapon_damage, description
          )
          SELECT
            'Primus Battlecruiser', 'primus.glb', 'Centauri Republic', 250,
            'battle', 'Battlecruiser', 6, 5, 52, 12, 6, 65, 15, 8, 1, 45,
            'Regular', 0, 0, 0,
            'Anti-Fighter 2; Jump Engine; Lumbering',
            'Sentri Flight (2)', 52,
            $1, 18, 6,
            'Centauri Republic Primus-class battlecruiser, a heavy fleet-line warship'
          WHERE NOT EXISTS (SELECT 1 FROM updated)
          RETURNING id
        )
        SELECT id FROM updated
        UNION ALL
        SELECT id FROM inserted
        LIMIT 1
      `,
      [CAPITAL_BASE_RADIUS_INCHES],
    );

    const primusId = primus.rows[0]?.id;
    if (primusId) {
      await syncWeaponsForShipModel(primusId, PRIMUS_WEAPONS);
    }

    const altarian = await pool.query<{ id: number }>(
      `
        WITH updated AS (
          UPDATE ship_models
          SET
            name = 'Altarian-class Destroyer',
            filename = 'altarian.glb',
            faction = 'Centauri Republic',
            point_cost = 200,
            priority_level = 'raid',
            ship_class = 'Destroyer',
            hull = 6,
            troops = 3,
            damage = 29,
            damage_threshold = 6,
            hull_rating = 6,
            crew = 32,
            crew_threshold = 7,
            speed = 8,
            turns = 1,
            turn_angle = 45,
            crew_quality = 'Regular',
            shield = 0,
            shield_max = 0,
            shield_regen_rate = 0,
            traits = 'Anti-Fighter 2; Jump Engine',
            small_craft = NULL,
            base_radius_inches = $1,
            hull_points = 29,
            weapon_range = 15,
            weapon_damage = 6,
            description = 'Centauri Republic Altarian-class destroyer built around matter cannon batteries'
          WHERE lower(filename) IN ('altarian.glb', 'altarian.obj')
            OR lower(name) IN ('altarian', 'altarian destroyer', 'altarian-class destroyer')
          RETURNING id
        ),
        inserted AS (
          INSERT INTO ship_models (
            name, filename, faction, point_cost, priority_level, ship_class,
            hull, troops, damage, damage_threshold, hull_rating, crew,
            crew_threshold, speed, turns, turn_angle, crew_quality, shield,
            shield_max, shield_regen_rate, traits, small_craft, hull_points,
            base_radius_inches, weapon_range, weapon_damage, description
          )
          SELECT
            'Altarian-class Destroyer', 'altarian.glb', 'Centauri Republic', 200,
            'raid', 'Destroyer', 6, 3, 29, 6, 6, 32, 7, 8, 1, 45,
            'Regular', 0, 0, 0,
            'Anti-Fighter 2; Jump Engine',
            NULL, 29,
            $1, 15, 6,
            'Centauri Republic Altarian-class destroyer built around matter cannon batteries'
          WHERE NOT EXISTS (SELECT 1 FROM updated)
          RETURNING id
        )
        SELECT id FROM updated
        UNION ALL
        SELECT id FROM inserted
        LIMIT 1
      `,
      [CAPITAL_BASE_RADIUS_INCHES],
    );

    const altarianId = altarian.rows[0]?.id;
    if (altarianId) {
      await syncWeaponsForShipModel(altarianId, ALTARIAN_WEAPONS);
    }

    const corvan = await pool.query<{ id: number }>(
      `
        WITH updated AS (
          UPDATE ship_models
          SET
            name = 'Corvan-class Scout',
            filename = 'covran.glb',
            faction = 'Centauri Republic',
            point_cost = 150,
            priority_level = 'skirmish',
            ship_class = 'Scout',
            hull = 4,
            troops = 1,
            damage = 16,
            damage_threshold = 4,
            hull_rating = 4,
            crew = 18,
            crew_threshold = 4,
            speed = 12,
            turns = 2,
            turn_angle = 45,
            crew_quality = 'Regular',
            shield = 0,
            shield_max = 0,
            shield_regen_rate = 0,
            traits = 'Agile; Anti-Fighter 1; Interceptors 1; Jump Engine; Scout; Stealth +4',
            small_craft = NULL,
            base_radius_inches = $1,
            hull_points = 16,
            weapon_range = 12,
            weapon_damage = 2,
            description = 'Centauri Republic Corvan-class scout with stealth systems and a forward battle laser'
          WHERE lower(filename) IN ('covran.glb', 'corvan.glb')
            OR lower(name) IN ('corvan', 'corvan scout', 'corvan-class scout', 'covran', 'covran scout', 'covran-class scout')
          RETURNING id
        ),
        inserted AS (
          INSERT INTO ship_models (
            name, filename, faction, point_cost, priority_level, ship_class,
            hull, troops, damage, damage_threshold, hull_rating, crew,
            crew_threshold, speed, turns, turn_angle, crew_quality, shield,
            shield_max, shield_regen_rate, traits, small_craft, hull_points,
            base_radius_inches, weapon_range, weapon_damage, description
          )
          SELECT
            'Corvan-class Scout', 'covran.glb', 'Centauri Republic', 150,
            'skirmish', 'Scout', 4, 1, 16, 4, 4, 18, 4, 12, 2, 45,
            'Regular', 0, 0, 0,
            'Agile; Anti-Fighter 1; Interceptors 1; Jump Engine; Scout; Stealth +4',
            NULL, 16,
            $1, 12, 2,
            'Centauri Republic Corvan-class scout with stealth systems and a forward battle laser'
          WHERE NOT EXISTS (SELECT 1 FROM updated)
          RETURNING id
        )
        SELECT id FROM updated
        UNION ALL
        SELECT id FROM inserted
        LIMIT 1
      `,
      [CAPITAL_BASE_RADIUS_INCHES],
    );

    const corvanId = corvan.rows[0]?.id;
    if (corvanId) {
      await syncWeaponsForShipModel(corvanId, CORVAN_WEAPONS);
    }

    const vorchan = await pool.query<{ id: number }>(
      `
        WITH updated AS (
          UPDATE ship_models
          SET
            name = 'Vorchan Warship',
            filename = 'vorchan.glb',
            faction = 'Centauri Republic',
            point_cost = 150,
            priority_level = 'skirmish',
            ship_class = 'Warship',
            hull = 5,
            troops = 1,
            damage = 19,
            damage_threshold = 5,
            hull_rating = 5,
            crew = 24,
            crew_threshold = 6,
            speed = 14,
            turns = 2,
            turn_angle = 45,
            crew_quality = 'Regular',
            shield = 0,
            shield_max = 0,
            shield_regen_rate = 0,
            traits = 'Agile; Atmospheric; Jump Engine',
            small_craft = NULL,
            base_radius_inches = $1,
            hull_points = 19,
            weapon_range = 12,
            weapon_damage = 8,
            description = 'Centauri Republic Vorchan-class warship, a fast flanking attack ship'
          WHERE lower(filename) = 'vorchan.glb'
            OR lower(name) IN ('vorchan', 'vorchan warship', 'vorchan-class warship')
          RETURNING id
        ),
        inserted AS (
          INSERT INTO ship_models (
            name, filename, faction, point_cost, priority_level, ship_class,
            hull, troops, damage, damage_threshold, hull_rating, crew,
            crew_threshold, speed, turns, turn_angle, crew_quality, shield,
            shield_max, shield_regen_rate, traits, small_craft, hull_points,
            base_radius_inches, weapon_range, weapon_damage, description
          )
          SELECT
            'Vorchan Warship', 'vorchan.glb', 'Centauri Republic', 150,
            'skirmish', 'Warship', 5, 1, 19, 5, 5, 24, 6, 14, 2, 45,
            'Regular', 0, 0, 0,
            'Agile; Atmospheric; Jump Engine',
            NULL, 19,
            $1, 12, 8,
            'Centauri Republic Vorchan-class warship, a fast flanking attack ship'
          WHERE NOT EXISTS (SELECT 1 FROM updated)
          RETURNING id
        )
        SELECT id FROM updated
        UNION ALL
        SELECT id FROM inserted
        LIMIT 1
      `,
      [CAPITAL_BASE_RADIUS_INCHES],
    );

    const vorchanId = vorchan.rows[0]?.id;
    if (vorchanId) {
      await syncWeaponsForShipModel(vorchanId, VORCHAN_WEAPONS);
    }

    const whiteStar = await pool.query<{ id: number }>(
      `
        WITH updated AS (
          UPDATE ship_models
          SET
            name = 'White Star',
            filename = 'whitestar.glb',
            faction = 'Interstellar Alliance',
            point_cost = 175,
            priority_level = 'raid',
            ship_class = 'Attack Ship',
            speed = 15,
            traits = 'Adaptive Armor; Advanced Jump Engine; Agile; Atmospheric; Dodge +4; Flight Computer; Scout; Self-repair 1',
            hull_points = 10,
            weapon_range = 18,
            weapon_damage = 2
          WHERE lower(filename) IN ('whitestar.obj', 'whitestar.glb')
            OR lower(name) IN ('white star', 'whitestar')
          RETURNING id
        ),
        inserted AS (
          INSERT INTO ship_models (
            name, filename, faction, point_cost, priority_level, ship_class,
            speed, traits, hull_points, weapon_range, weapon_damage, description
          )
          SELECT
            'White Star', 'whitestar.glb', 'Interstellar Alliance', 175,
            'raid', 'Attack Ship', 15,
            'Adaptive Armor; Advanced Jump Engine; Agile; Atmospheric; Dodge +4; Flight Computer; Scout; Self-repair 1',
            10, 18, 2,
            'Interstellar Alliance White Star attack ship'
          WHERE NOT EXISTS (SELECT 1 FROM updated)
          RETURNING id
        )
        SELECT id FROM updated
        UNION ALL
        SELECT id FROM inserted
        LIMIT 1
      `,
    );

    const whiteStarId = whiteStar.rows[0]?.id;
    if (whiteStarId) {
      await syncWeaponsForShipModel(whiteStarId, WHITE_STAR_WEAPONS);
    }

    const tigara = await pool.query<{ id: number }>(
      `
        WITH updated AS (
          UPDATE ship_models
          SET
            name = 'Tigara Attack Cruiser',
            filename = 'tigara.glb',
            faction = 'Minbari Federation',
            point_cost = 200,
            priority_level = 'raid',
            ship_class = 'Attack Cruiser',
            hull = 5,
            troops = 3,
            damage = 24,
            damage_threshold = 8,
            hull_rating = 5,
            crew = 36,
            crew_threshold = 12,
            speed = 12,
            turns = 2,
            turn_angle = 45,
            crew_quality = 'Regular',
            shield = 0,
            shield_max = 0,
            shield_regen_rate = 0,
            traits = 'Advanced Anti-Fighter 2; Advanced Jump Engine; Agile; Flight Computer; Stealth +5',
            small_craft = 'Nial Fighter Flight (1)',
            hull_points = 24,
            weapon_range = 18,
            weapon_damage = 6,
            description = 'Minbari Tigara-class attack cruiser focused on space superiority'
          WHERE lower(name) IN ('tigara', 'tigara attack cruiser', 'tigara-class attack cruiser')
          RETURNING id
        ),
        inserted AS (
          INSERT INTO ship_models (
            name, filename, faction, point_cost, priority_level, ship_class,
            hull, troops, damage, damage_threshold, hull_rating, crew,
            crew_threshold, speed, turns, turn_angle, crew_quality, shield,
            shield_max, shield_regen_rate, traits, small_craft, hull_points,
            weapon_range, weapon_damage, description
          )
          SELECT
            'Tigara Attack Cruiser', 'tigara.glb', 'Minbari Federation', 200,
            'raid', 'Attack Cruiser', 5, 3, 24, 8, 5, 36, 12, 12, 2, 45,
            'Regular', 0, 0, 0,
            'Advanced Anti-Fighter 2; Advanced Jump Engine; Agile; Flight Computer; Stealth +5',
            'Nial Fighter Flight (1)', 24, 18, 6,
            'Minbari Tigara-class attack cruiser focused on space superiority'
          WHERE NOT EXISTS (SELECT 1 FROM updated)
          RETURNING id
        )
        SELECT id FROM updated
        UNION ALL
        SELECT id FROM inserted
        LIMIT 1
      `,
    );

    const tigaraId = tigara.rows[0]?.id;
    if (tigaraId) {
      await syncWeaponsForShipModel(tigaraId, TIGARA_WEAPONS);
    }

    const tinashi = await pool.query<{ id: number }>(
      `
        UPDATE ship_models
        SET
          name = 'Tinashi Warship',
          filename = 'tinashi.glb',
          faction = 'Minbari Federation',
          point_cost = 175,
          priority_level = 'battle',
          ship_class = 'Warship',
          hull = 5,
          troops = 4,
          damage = 38,
          damage_threshold = 12,
          hull_rating = 5,
          crew = 42,
          crew_threshold = 14,
          speed = 10,
          turns = 2,
          turn_angle = 45,
          crew_quality = 'Regular',
          shield = 0,
          shield_max = 0,
          shield_regen_rate = 0,
          traits = 'Advanced Anti-Fighter 4; Advanced Jump Engine; Flight Computer; Stealth +5',
          small_craft = NULL,
          hull_points = 38,
          weapon_range = 25,
          weapon_damage = 4,
          description = 'Minbari Tinashi-class warship, forerunner of the Sharlin'
        WHERE lower(name) IN ('tinashi', 'tinashi warship', 'tinashi-class warship')
        RETURNING id
      `,
    );

    const tinashiId = tinashi.rows[0]?.id;
    if (tinashiId) {
      await syncWeaponsForShipModel(tinashiId, TINASHI_WEAPONS);
    }

    await removeDuplicateCanonicalShipRows();

    for (const seed of SHIP_AI_PROFILE_SEEDS) {
      await pool.query(
        `
          UPDATE ship_models
          SET ai_profile = $2
          WHERE lower(name) = lower($1)
        `,
        [seed.name, seed.aiProfile],
      );
    }
  } catch (err) {
    logger.warn({ err }, "ACTA allocation schema maintenance failed");
  }
}
