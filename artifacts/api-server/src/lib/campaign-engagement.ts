export const CAMPAIGN_SCENARIO_LABELS = {
  "campaign-engagement": "Campaign Engagement",
  "call-to-arms": "Call to Arms",
  assassination: "Assassination",
  "recon-run": "Recon Run",
  "convoy-duty": "Convoy Duty",
  ambush: "Ambush",
  "space-superiority": "Space Superiority",
  annihilation: "Annihilation",
  blockade: "Blockade",
  "carrier-clash": "Carrier Clash",
  "flee-to-jump-gate": "Flee to the Jump Gate!",
  "supply-ships": "Supply Ships",
  "planetary-assault": "Planetary Assault",
} as const;

export type CampaignScenarioKey = keyof typeof CAMPAIGN_SCENARIO_LABELS;
export type CampaignPriorityLevel = "patrol" | "skirmish" | "raid" | "battle" | "war";
export type CampaignDeploymentPreset = "standard-short-edge" | "standard-long-edge" | "ambush-center";
export type CampaignTerrainSelection = "none" | "asteroid-fields" | "gas-clouds" | "mixed-terrain";
export type CampaignStationSelection = "none" | "enabled";
export type CampaignSkyboxSelection =
  | "none"
  | "bright-nebula"
  | "dark-forest"
  | "drazi-green-purple"
  | "distant-fields"
  | "zhadum";

export type CampaignEngagementRules = {
  scenarioKey: CampaignScenarioKey;
  scenarioLabel: string;
  priorityLevel: CampaignPriorityLevel;
  allocationPoints: number;
  deploymentPreset: CampaignDeploymentPreset;
  deploymentDepth: number;
  ambushCenterSide: "attacker" | "defender";
  terrain: CampaignTerrainSelection;
  terrainCount: 0 | 3 | 6 | 9;
  stations: CampaignStationSelection;
  skybox: CampaignSkyboxSelection;
  specialConditions: string[];
};

export type CampaignRulesSnapshot = {
  version: 1;
  source: "campaign";
  lockedAt: string;
  scenario: {
    key: CampaignScenarioKey;
    label: string;
    objectiveAutomation: "manual";
  };
  priorityLevel: CampaignPriorityLevel;
  allocationPoints: number;
  deployment: {
    preset: CampaignDeploymentPreset;
    depth: number;
    ambushCenterSide: "attacker" | "defender";
  };
  battlefield: {
    terrain: CampaignTerrainSelection;
    terrainCount: 0 | 3 | 6 | 9;
    terrainPlacement: "automatic";
    stations: CampaignStationSelection;
    skybox: CampaignSkyboxSelection;
  };
  specialConditions: string[];
  enforcedByServer: string[];
};

type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

const CAMPAIGN_PRIORITIES = new Set<CampaignPriorityLevel>([
  "patrol",
  "skirmish",
  "raid",
  "battle",
  "war",
]);
const DEPLOYMENT_PRESETS = new Set<CampaignDeploymentPreset>([
  "standard-short-edge",
  "standard-long-edge",
  "ambush-center",
]);
const TERRAIN_SELECTIONS = new Set<CampaignTerrainSelection>([
  "none",
  "asteroid-fields",
  "gas-clouds",
  "mixed-terrain",
]);
const SKYBOX_SELECTIONS = new Set<CampaignSkyboxSelection>([
  "none",
  "bright-nebula",
  "dark-forest",
  "drazi-green-purple",
  "distant-fields",
  "zhadum",
]);

function enumValue<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === "string" && allowed.has(value as T) ? value as T : fallback;
}

function normalizeSpecialConditions(value: unknown): ParseResult<string[]> {
  if (value === undefined || value === null || value === "") {
    return { success: true, data: [] };
  }
  if (typeof value !== "string") {
    return { success: false, error: "Special conditions must be text" };
  }
  if (value.length > 1200) {
    return { success: false, error: "Special conditions must be 1200 characters or fewer" };
  }
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20);
  return { success: true, data: lines };
}

export function normalizeCampaignEngagementRules(raw: Record<string, unknown>): ParseResult<CampaignEngagementRules> {
  const scenarioKey = enumValue(
    raw.scenarioKey,
    new Set(Object.keys(CAMPAIGN_SCENARIO_LABELS) as CampaignScenarioKey[]),
    "campaign-engagement",
  );
  const priorityLevel = enumValue(raw.priorityLevel, CAMPAIGN_PRIORITIES, "raid");
  const allocationPoints = Math.max(1, Math.min(99, Math.trunc(Number(raw.allocationPoints ?? 5))));
  const deploymentPreset = enumValue(raw.deploymentPreset, DEPLOYMENT_PRESETS, "standard-short-edge");
  const deploymentDepth = Math.max(4, Math.min(30, Math.trunc(Number(raw.deploymentDepth ?? 12))));
  const ambushCenterSide = raw.ambushCenterSide === "attacker" ? "attacker" : "defender";
  const terrain = enumValue(raw.terrain, TERRAIN_SELECTIONS, "none");
  const requestedTerrainCount = Number(raw.terrainCount);
  const terrainCount = terrain === "none"
    ? 0
    : requestedTerrainCount === 6 || requestedTerrainCount === 9
      ? requestedTerrainCount
      : 3;
  const stations = raw.stations === "enabled" ? "enabled" : "none";
  const skybox = enumValue(raw.skybox, SKYBOX_SELECTIONS, "bright-nebula");
  const specialConditions = normalizeSpecialConditions(raw.specialConditions);
  if (!specialConditions.success) return specialConditions;

  return {
    success: true,
    data: {
      scenarioKey,
      scenarioLabel: CAMPAIGN_SCENARIO_LABELS[scenarioKey],
      priorityLevel,
      allocationPoints,
      deploymentPreset,
      deploymentDepth,
      ambushCenterSide,
      terrain,
      terrainCount,
      stations,
      skybox,
      specialConditions: specialConditions.data,
    },
  };
}

export function campaignRulesSnapshot(
  rules: CampaignEngagementRules,
  lockedAt = new Date().toISOString(),
): CampaignRulesSnapshot {
  return {
    version: 1,
    source: "campaign",
    lockedAt,
    scenario: {
      key: rules.scenarioKey,
      label: rules.scenarioLabel,
      objectiveAutomation: "manual",
    },
    priorityLevel: rules.priorityLevel,
    allocationPoints: rules.allocationPoints,
    deployment: {
      preset: rules.deploymentPreset,
      depth: rules.deploymentDepth,
      ambushCenterSide: rules.ambushCenterSide,
    },
    battlefield: {
      terrain: rules.terrain,
      terrainCount: rules.terrainCount,
      terrainPlacement: "automatic",
      stations: rules.stations,
      skybox: rules.skybox,
    },
    specialConditions: rules.specialConditions,
    enforcedByServer: [
      "campaign roster assignments",
      "persistent ship starting condition",
      "priority and fleet allocation",
      "deployment zones",
      "terrain configuration",
      "station configuration",
    ],
  };
}
