import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const schemaPath = path.join(root, "artifacts/api-server/src/lib/schema-maintenance.ts");
const weaponFxPath = path.join(root, "artifacts/b5acta/src/components/weapon-fx.tsx");

const schema = fs.readFileSync(schemaPath, "utf8");
const weaponFx = fs.readFileSync(weaponFxPath, "utf8");

const canonicalFighters = new Map([
  ["aurora starfury", "Aurora Starfury Flight"],
  ["aurora starfury flight", "Aurora Starfury Flight"],
  ["thunderbolt", "Thunderbolt Starfury Flight"],
  ["thunderbolt starfury", "Thunderbolt Starfury Flight"],
  ["thunderbolt starfury flight", "Thunderbolt Starfury Flight"],
  ["nial", "Nial Heavy Fighter Flight"],
  ["nial fighter", "Nial Heavy Fighter Flight"],
  ["nial fighter flight", "Nial Heavy Fighter Flight"],
  ["nial heavy fighter", "Nial Heavy Fighter Flight"],
  ["nial heavy fighter flight", "Nial Heavy Fighter Flight"],
  ["sentri", "Sentri Flight"],
  ["sentri fighter", "Sentri Flight"],
  ["sentri fighter flight", "Sentri Flight"],
  ["sentri flight", "Sentri Flight"],
  ["frazi", "Frazi Flight"],
  ["frazi fighter", "Frazi Flight"],
  ["frazi fighter flight", "Frazi Flight"],
  ["frazi flight", "Frazi Flight"],
  ["flyer", "Flyer Flight"],
  ["flyer flight", "Flyer Flight"],
]);

const implementedShipTraits = [
  "Adaptive Armor",
  "Adaptive Armour",
  "Advanced Anti-Fighter",
  "Advanced Anti Fighter",
  "Agile",
  "Ancient",
  "Anti-Fighter",
  "Anti Fighter",
  "Carrier",
  "Command",
  "Dodge",
  "Dogfight",
  "Dog Fight",
  "Escort",
  "Fighter",
  "Fleet Carrier",
  "Flight Computer",
  "GEG",
  "Gravitic Energy Grid",
  "Guardian Array",
  "Interceptors",
  "Lumbering",
  "Redundant Systems",
  "Scout",
  "Self Repair",
  "Self-Repair",
  "Self-repair",
  "Stealth",
  "Stealth Penetration",
  "Super Maneuverable",
  "Super Manoeuvrable",
];

const knownDeferredShipTraits = [
  "Advanced Jump Engine",
  "Atmospheric",
  "Jump Engine",
  "Shuttles",
];

function normalize(value) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function comparableTrait(value) {
  return value
    .trim()
    .replace(/[+:]?\s*-?\d+d?\d*\+?/gi, "")
    .replace(/\s+\d+\+?$/i, "")
    .replace(/\s*:\s*$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

function csvLine(line) {
  const cells = [];
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
    } else if (ch === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function splitSmallCraft(raw) {
  if (!raw || /^(?:none|n\/a|null|-|—)$/i.test(raw.trim())) return [];
  return raw.split(/[,;]+/)
    .map(part => part.trim().replace(/\s*\(\d+\)\s*$/g, ""))
    .filter(Boolean);
}

function extractCsvShips() {
  const match = schema.match(/const FALLBACK_ACTA_SHIP_CSV = String\.raw`([\s\S]*?)`;/);
  if (!match) return [];
  const ships = [];
  let section = null;
  for (const line of match[1].split(/\r?\n/)) {
    const row = csvLine(line);
    if (row[0] === "Faction" && row[1] === "Name") {
      section = "ships";
      continue;
    }
    if (row[0] === "WEAPONS") {
      section = "weapons";
      continue;
    }
    if (section === "ships" && row.length > 17 && row[1] && row[1] !== "Name") {
      ships.push({ name: row[1], traits: row[16] ?? "", smallCraft: row[17] ?? "" });
    }
  }
  return ships;
}

function extractObjectShips() {
  const ships = [];
  for (const object of [...topLevelArrayObjects("HYPERION_VARIANTS"), ...topLevelArrayObjects("FIGHTER_FLIGHTS")]) {
    const name = object.match(/name:\s*"([^"]+)"/)?.[1];
    const traits = object.match(/traits:\s*"([^"]*)"/)?.[1] ?? "";
    const rawSmallCraft = object.match(/smallCraft:\s*([^,\n]+)/)?.[1]?.trim() ?? "null";
    const smallCraft = rawSmallCraft === "null" ? "" : rawSmallCraft.replace(/^"|"$/g, "");
    if (name) ships.push({ name, traits, smallCraft });
  }
  return ships;
}

function topLevelArrayObjects(arrayName) {
  const start = schema.indexOf(`const ${arrayName}`);
  if (start < 0) return [];
  const open = schema.indexOf("[", start);
  if (open < 0) return [];
  const objects = [];
  let bracketDepth = 1;
  let braceDepth = 0;
  let objectStart = -1;
  let quoted = false;
  for (let i = open + 1; i < schema.length; i++) {
    const ch = schema[i];
    const prev = schema[i - 1];
    if (ch === "\"" && prev !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (ch === "[") bracketDepth++;
    if (ch === "]") {
      bracketDepth--;
      if (bracketDepth === 0) break;
    }
    if (bracketDepth !== 1) continue;
    if (ch === "{") {
      if (braceDepth === 0) objectStart = i;
      braceDepth++;
    } else if (ch === "}") {
      braceDepth--;
      if (braceDepth === 0 && objectStart >= 0) {
        objects.push(schema.slice(objectStart, i + 1));
        objectStart = -1;
      }
    }
  }
  return objects;
}

function extractSqlShips() {
  const ships = [];
  for (const match of schema.matchAll(/name\s*=\s*'((?:''|[^'])+)'[\s\S]{0,1400}?traits\s*=\s*'((?:''|[^'])*)'[\s\S]{0,350}?small_craft\s*=\s*(NULL|'((?:''|[^'])*)')/g)) {
    ships.push({
      name: match[1].replace(/''/g, "'"),
      traits: match[2].replace(/''/g, "'"),
      smallCraft: (match[4] ?? "").replace(/''/g, "'"),
    });
  }
  return ships;
}

const ships = [...extractCsvShips(), ...extractObjectShips(), ...extractSqlShips()];
const shipByName = new Map();
for (const ship of ships) shipByName.set(normalize(ship.name), ship);
const uniqueShips = [...shipByName.values()].sort((a, b) => a.name.localeCompare(b.name));

const fighterModels = new Set(
  uniqueShips
    .filter(ship => /\bFighter\b/i.test(ship.traits) || /fighter flight/i.test(ship.name))
    .map(ship => normalize(ship.name)),
);

const unresolvedSmallCraft = [];
for (const ship of uniqueShips) {
  for (const craft of splitSmallCraft(ship.smallCraft)) {
    const canonical = canonicalFighters.get(normalize(craft)) ?? craft;
    if (!fighterModels.has(normalize(canonical))) {
      unresolvedSmallCraft.push({ carrier: ship.name, craft, expectedModel: canonical });
    }
  }
}

const knownImplemented = new Set(implementedShipTraits.map(comparableTrait));
const knownDeferred = new Set(knownDeferredShipTraits.map(comparableTrait));
const traitRows = [];
for (const ship of uniqueShips) {
  for (const rawTrait of ship.traits.split(/[;,]/).map(t => t.trim()).filter(Boolean)) {
    const key = comparableTrait(rawTrait);
    if (knownImplemented.has(key)) continue;
    traitRows.push({
      ship: ship.name,
      trait: rawTrait,
      status: knownDeferred.has(key) ? "deferred" : "unknown",
    });
  }
}

const weaponRows = [];
for (const match of schema.matchAll(/\{\s*name:\s*"([^"]+)"\s*,\s*arc:\s*"[^"]+"\s*,\s*range:\s*\d+\s*,\s*attackDice:\s*\d+\s*,\s*traits:\s*"([^"]*)"/g)) {
  const name = match[1];
  const traits = match[2];
  const lowerName = name.toLowerCase();
  const lowerTraits = traits.toLowerCase();
  const fx =
    lowerName.includes("energy mine") || /\benergy[- ]?mine\b/.test(lowerTraits) ? "energy-mine" :
    lowerName.includes("missile") ? "missile" :
    lowerName.includes("molecular slicer") || lowerName.includes("laser") || /\bmini[- ]?beam\b/.test(lowerTraits) || /\bbeam\b/.test(lowerTraits) ? "beam" :
    "tracer";
  weaponRows.push({ name, traits, fx });
}

const fxCounts = weaponRows.reduce((acc, row) => {
  acc[row.fx] = (acc[row.fx] ?? 0) + 1;
  return acc;
}, {});

const hasLiveMissileTuning = weaponFx.includes("MISSILE_TUNING") && weaponFx.includes("#ff6600");
const hasTracerColorRouting = weaponFx.includes("tracerColorsFor");

console.log("ACTA rules hardening audit");
console.log("==========================");
console.log(`Ships audited: ${uniqueShips.length}`);
console.log(`Fighter models audited: ${fighterModels.size}`);
console.log("");

console.log("Carried fighter model links");
if (unresolvedSmallCraft.length === 0) {
  console.log("  OK: every small-craft entry resolves to a current fighter model.");
} else {
  for (const row of unresolvedSmallCraft) {
    console.log(`  GAP: ${row.carrier} carries ${row.craft}; expected missing model "${row.expectedModel}".`);
  }
}
console.log("");

console.log("Ship trait parser coverage");
if (traitRows.length === 0) {
  console.log("  OK: all seeded ship traits are implemented or explicitly known.");
} else {
  for (const row of traitRows) {
    console.log(`  ${row.status.toUpperCase()}: ${row.ship} -> ${row.trait}`);
  }
}
console.log("");

console.log("Weapon VFX mapping");
console.log(`  beam: ${fxCounts.beam ?? 0}`);
console.log(`  tracer: ${fxCounts.tracer ?? 0}`);
console.log(`  missile: ${fxCounts.missile ?? 0}`);
console.log(`  energy-mine: ${fxCounts["energy-mine"] ?? 0}`);
console.log(`  missile tuning preset: ${hasLiveMissileTuning ? "OK" : "MISSING"}`);
console.log(`  tracer color routing: ${hasTracerColorRouting ? "OK" : "MISSING"}`);
