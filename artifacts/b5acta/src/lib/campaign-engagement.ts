export const CAMPAIGN_SCENARIOS = [
  ["campaign-engagement", "Campaign Engagement"],
  ["call-to-arms", "Call to Arms"],
  ["assassination", "Assassination"],
  ["recon-run", "Recon Run"],
  ["convoy-duty", "Convoy Duty"],
  ["ambush", "Ambush"],
  ["space-superiority", "Space Superiority"],
  ["annihilation", "Annihilation"],
  ["blockade", "Blockade"],
  ["carrier-clash", "Carrier Clash"],
  ["flee-to-jump-gate", "Flee to the Jump Gate!"],
  ["supply-ships", "Supply Ships"],
  ["planetary-assault", "Planetary Assault"],
] as const;

export const CAMPAIGN_SKYBOXES = [
  ["none", "None"],
  ["bright-nebula", "Bright Nebula"],
  ["dark-forest", "Deep Starfield"],
  ["drazi-green-purple", "Drazi Green and Purple"],
  ["distant-fields", "Distant Fields"],
  ["zhadum", "Z'ha'dum"],
] as const;

export type CampaignRulesSnapshot = {
  version?: number;
  source?: string;
  lockedAt?: string;
  scenario?: {
    key?: string;
    label?: string;
    objectiveAutomation?: "manual" | string;
  };
  priorityLevel?: string;
  allocationPoints?: number;
  deployment?: {
    preset?: string;
    depth?: number;
    ambushCenterSide?: "attacker" | "defender" | string;
  };
  battlefield?: {
    terrain?: string;
    terrainCount?: number;
    terrainPlacement?: string;
    stations?: string;
    skybox?: string;
  };
  specialConditions?: string[];
  enforcedByServer?: string[];
  nominationId?: number;
  target?: {
    id?: number;
    name?: string;
    category?: string;
    subtype?: string;
  };
  generation?: {
    state?: string;
    scenarioRoll?: {
      dice?: number[];
      total?: number;
      scenarioKey?: string;
      scenarioLabel?: string;
      rejectedRolls?: Array<{
        dice?: number[];
        total?: number;
        rejectedReason?: string;
      }>;
      planetaryAssaultEligible?: boolean;
    } | null;
    priorityRoll?: {
      dice?: number[];
      diceTotal?: number;
      attackerModifier?: number;
      defenderModifier?: number;
      finalTotal?: number;
      priorityLevel?: string;
    } | null;
    scenarioChoiceRequired?: boolean;
  };
  sideAllocationPoints?: {
    attacker?: number;
    defender?: number;
  };
};

export function campaignScenarioLabel(key: string): string {
  return CAMPAIGN_SCENARIOS.find(([value]) => value === key)?.[1]
    ?? key.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function campaignDeploymentLabel(value: string | undefined): string {
  if (value === "standard-long-edge") return "Long-edge deployment";
  if (value === "ambush-center") return "Ambush center deployment";
  return "Standard short-edge deployment";
}

export function campaignTerrainLabel(value: string | undefined, count = 0): string {
  if (!value || value === "none") return "No terrain";
  const label = value === "asteroid-fields"
    ? "Asteroid fields"
    : value === "gas-clouds"
      ? "Gas clouds"
      : "Mixed terrain";
  return `${label}${count > 0 ? ` (${count})` : ""}`;
}

export function campaignSkyboxLabel(value: string | undefined): string {
  return CAMPAIGN_SKYBOXES.find(([key]) => key === value)?.[1] ?? "Bright Nebula";
}
