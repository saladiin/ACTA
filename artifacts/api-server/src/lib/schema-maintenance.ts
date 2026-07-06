import { pool } from "@workspace/db";
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
  { name: "Hyperion Cruiser", priority: "raid" },
  { name: "Hyperion Heavy Cruiser", priority: "raid" },
  { name: "Nova Dreadnought", priority: "raid" },
  { name: "White Star", priority: "raid" },
  { name: "Olympus Corvette", priority: "skirmish" },
  { name: "Oracle Cruiser", priority: "skirmish" },
  { name: "Oracle Scout Cruiser", priority: "skirmish" },
  { name: "Sagittarius", priority: "skirmish" },
  { name: "Sagittarius Missile Cruiser", priority: "skirmish" },
  { name: "Nial Fighter Flight", priority: "patrol" },
];

const CAPITAL_BASE_RADIUS_INCHES = 1.2;
const FIGHTER_BASE_RADIUS_INCHES = 0.5;

const SAGITTARIUS_WEAPONS = [
  { name: "Missile Rack", arc: "Forward", range: 30, attackDice: 2, traits: "Precise; Slow Loading; Super Armor Piercing" },
  { name: "Missile Rack", arc: "Aft", range: 30, attackDice: 2, traits: "Precise; Slow Loading; Super Armor Piercing" },
  { name: "Missile Rack", arc: "Port", range: 30, attackDice: 6, traits: "Precise; Slow Loading; Super Armor Piercing" },
  { name: "Missile Rack", arc: "Starboard", range: 30, attackDice: 6, traits: "Precise; Slow Loading; Super Armor Piercing" },
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

const FIGHTER_FLIGHTS = [
  {
    name: "Aurora Starfury Flight",
    filename: "aurora.glb",
    faction: "Earth Alliance",
    pointCost: 25,
    shipClass: "Fighter Flight",
    hull: 5,
    speed: 14,
    traits: "Dodge 2+; Fighter; Super Maneuverable",
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
    traits: "Atmospheric; Dodge 3+; Fighter; Super Maneuverable",
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
    name: "Nial Heavy Fighter Flight",
    filename: "nial.glb",
    faction: "Minbari Federation",
    pointCost: 25,
    shipClass: "Fighter Flight",
    hull: 4,
    speed: 15,
    traits: "Atmospheric; Dodge 2+; Fighter; Stealth +5; Super Maneuverable",
    weaponRange: 2,
    weaponDamage: 3,
    description: "Minbari Nial heavy fighter flight",
    aliases: ["Nial Heavy Fighter Flight", "Nial Fighter Flight", "Nial Flight", "Nial Wing"],
    weapons: [
      { name: "Light Fusion Cannon", arc: "Turret", range: 2, attackDice: 3, traits: "Mini Beam" },
    ],
  },
];

export async function ensureActaAllocationSchema(): Promise<void> {
  try {
    await pool.query(`
      ALTER TABLE ship_models
      ADD COLUMN IF NOT EXISTS priority_level text NOT NULL DEFAULT 'raid'
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
      ALTER TABLE game_units
      ADD COLUMN IF NOT EXISTS distance_since_last_turn_this_activation integer NOT NULL DEFAULT 0
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
        WHERE traits ILIKE '%fighter%'
           OR ship_class ILIKE '%fighter%'
           OR name ILIKE '%fighter flight%'
      `,
      [FIGHTER_BASE_RADIUS_INCHES],
    );
    await pool.query(
      `
        UPDATE game_units gu
        SET base_radius_inches = sm.base_radius_inches
        FROM ships s
        JOIN ship_models sm ON sm.id = s.ship_model_id
        WHERE gu.ship_id = s.id
          AND (gu.base_radius_inches IS NULL OR gu.base_radius_inches <= 0 OR sm.base_radius_inches <> gu.base_radius_inches)
      `,
    );

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
        await pool.query("DELETE FROM weapons WHERE ship_model_id = $1", [fighterId]);
        for (const weapon of fighter.weapons) {
          await pool.query(
            `
              INSERT INTO weapons (ship_model_id, name, arc, range, attack_dice, traits)
              VALUES ($1, $2, $3, $4, $5, $6)
            `,
            [fighterId, weapon.name, weapon.arc, weapon.range, weapon.attackDice, weapon.traits],
          );
        }
      }
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
      await pool.query("DELETE FROM weapons WHERE ship_model_id = $1", [sagittariusId]);
      for (const weapon of SAGITTARIUS_WEAPONS) {
        await pool.query(
          `
            INSERT INTO weapons (ship_model_id, name, arc, range, attack_dice, traits)
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [sagittariusId, weapon.name, weapon.arc, weapon.range, weapon.attackDice, weapon.traits],
        );
      }
    }

    const battlecrab = await pool.query<{ id: number }>(
      `
        UPDATE ship_models
        SET
          name = 'Shadow Battlecrab',
          filename = 'battlecrab.glb',
          faction = 'Shadows',
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
          crew_quality = 'N/A',
          shield = 20,
          shield_max = 20,
          shield_regen_rate = 10,
          traits = 'Super Maneuverable; Self Repair:3d6',
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
      await pool.query("DELETE FROM weapons WHERE ship_model_id = $1", [battlecrabId]);
      for (const weapon of BATTLECRAB_WEAPONS) {
        await pool.query(
          `
            INSERT INTO weapons (ship_model_id, name, arc, range, attack_dice, traits)
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [battlecrabId, weapon.name, weapon.arc, weapon.range, weapon.attackDice, weapon.traits],
        );
      }
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
      await pool.query("DELETE FROM weapons WHERE ship_model_id = $1", [aviokiId]);
      for (const weapon of AVIOKI_WEAPONS) {
        await pool.query(
          `
            INSERT INTO weapons (ship_model_id, name, arc, range, attack_dice, traits)
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [aviokiId, weapon.name, weapon.arc, weapon.range, weapon.attackDice, weapon.traits],
        );
      }
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
      await pool.query("DELETE FROM weapons WHERE ship_model_id = $1", [tigaraId]);
      for (const weapon of TIGARA_WEAPONS) {
        await pool.query(
          `
            INSERT INTO weapons (ship_model_id, name, arc, range, attack_dice, traits)
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [tigaraId, weapon.name, weapon.arc, weapon.range, weapon.attackDice, weapon.traits],
        );
      }
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
      await pool.query("DELETE FROM weapons WHERE ship_model_id = $1", [tinashiId]);
      for (const weapon of TINASHI_WEAPONS) {
        await pool.query(
          `
            INSERT INTO weapons (ship_model_id, name, arc, range, attack_dice, traits)
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [tinashiId, weapon.name, weapon.arc, weapon.range, weapon.attackDice, weapon.traits],
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, "ACTA allocation schema maintenance failed");
  }
}
