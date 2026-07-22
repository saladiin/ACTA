export const AI_OPPONENT_ID = "ai:acta-skirmish-v0";
export const AI_OPPONENT_NAME = "AI Tactical Officer";
export const DEFAULT_AI_PROFILE = "acta-skirmish-v0";

export const SHIP_AI_PROFILES = ["brawler", "jouster", "broadside", "standoff", "apex-predator"] as const;
export type ShipAiProfile = typeof SHIP_AI_PROFILES[number];

export const SHIP_AI_PROFILE_SEEDS: Array<{ name: string; aiProfile: ShipAiProfile }> = [
  { name: "Hyperion Cruiser", aiProfile: "jouster" },
  { name: "Hyperion Heavy Cruiser", aiProfile: "jouster" },
  { name: "Hyperion Assault Cruiser", aiProfile: "brawler" },
  { name: "Hyperion Command Cruiser", aiProfile: "jouster" },
  { name: "Hyperion Missile Cruiser", aiProfile: "standoff" },
  { name: "Hyperion Pulse Cruiser", aiProfile: "brawler" },
  { name: "Hyperion Rail Cruiser", aiProfile: "jouster" },
  { name: "Avenger Heavy Carrier", aiProfile: "standoff" },
  { name: "Avenger-class Heavy Carrier", aiProfile: "standoff" },
  { name: "Olympus Corvette", aiProfile: "standoff" },
  { name: "Oracle Cruiser", aiProfile: "standoff" },
  { name: "Oracle Scout Cruiser", aiProfile: "standoff" },
  { name: "Omega Destroyer", aiProfile: "jouster" },
  { name: "Omega Class Destroyer", aiProfile: "jouster" },
  { name: "Nova Dreadnought", aiProfile: "broadside" },
  { name: "Sagittarius", aiProfile: "standoff" },
  { name: "Sagittarius Missile Cruiser", aiProfile: "standoff" },
  { name: "Aurora Starfury Flight", aiProfile: "brawler" },
  { name: "Black Omega Starfury Flight", aiProfile: "brawler" },
  { name: "Thunderbolt Starfury Flight", aiProfile: "brawler" },
  { name: "Shadow Battlecrab", aiProfile: "apex-predator" },
  { name: "Battlecrab", aiProfile: "apex-predator" },
  { name: "Shadow Cruiser", aiProfile: "apex-predator" },
  { name: "Shadow Cruiser (Ancient)", aiProfile: "apex-predator" },
];

export const EARTH_ALLIANCE_SHIP_AI_PROFILE_SEEDS = SHIP_AI_PROFILE_SEEDS.filter(seed => seed.aiProfile !== "apex-predator");

const SHIP_AI_PROFILE_BY_NAME = new Map(
  SHIP_AI_PROFILE_SEEDS.map(seed => [seed.name.toLowerCase(), seed.aiProfile]),
);

export function isAiOpponentId(userId: string | null | undefined): boolean {
  return userId === AI_OPPONENT_ID;
}

export function normalizeOpponentKind(raw: unknown): "human" | "ai" {
  return raw === "ai" ? "ai" : "human";
}

export function normalizeShipAiProfile(raw: unknown): ShipAiProfile | null {
  return SHIP_AI_PROFILES.includes(raw as ShipAiProfile) ? raw as ShipAiProfile : null;
}

export function fallbackShipAiProfileByName(name: string | null | undefined): ShipAiProfile {
  return SHIP_AI_PROFILE_BY_NAME.get((name ?? "").toLowerCase()) ?? "brawler";
}
