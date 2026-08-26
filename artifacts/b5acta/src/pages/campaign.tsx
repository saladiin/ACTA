import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import { useLocation } from "wouter";
import { ArrowRight, ClipboardList, Database, Dice5, Eye, Lock, Map as MapIcon, Play, Plus, RotateCw, Shuffle, Swords, Target, Trash2, Users } from "lucide-react";
import { customFetch, useListShipModels, type ShipModel } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  CAMPAIGN_SCENARIOS,
  CAMPAIGN_SKYBOXES,
  type CampaignRulesSnapshot,
} from "@/lib/campaign-engagement";
import { useDevUserId } from "@/lib/dev-user";
import { normalizePriorityLevel, priorityLabel } from "@/lib/fleet-allocation";
import {
  getTemporaryUserId,
  temporaryUsernameAuthEnabled,
  useTemporaryUsername,
} from "@/lib/temporary-user";

type CampaignPlayer = {
  id: number;
  campaignId: number;
  playerId: string;
  displayName: string | null;
  faction: string | null;
  role: string;
  status: string;
  ready: boolean;
  crewQualitySwapUsed: boolean;
  initiativeModifier: number;
  joinedAt: string;
  updatedAt: string;
};

type CampaignLogEntry = {
  id: number;
  campaignId: number;
  turnNumber: number;
  actorPlayerId: string | null;
  type: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type CampaignRosterEntry = {
  id: number;
  campaignId: number;
  ownerPlayerId: string;
  sourceShipModelId: number;
  name: string;
  status: string;
  hullCurrent: number;
  hullMax: number;
  crewCurrent: number;
  crewMax: number;
  troopsCurrent: number;
  troopsMax: number;
  crewQuality: number;
  crewQualityRoll: number | null;
  crewQualityDice: number[];
  xpDice: number;
  criticalEffects: Array<Record<string, unknown>>;
  unavailableUntilTurn: number;
  crewQualityAttemptedTurn: number;
  crippledRepairPaidTurn: number;
  usedTurn: number;
  destroyed: boolean;
  capturedByPlayerId: string | null;
  createdAt: string;
  updatedAt: string;
  shipModel: ShipModel | null;
};

type CampaignBattleAssignment = {
  id: number;
  campaignBattleId: number;
  campaignShipInstanceId: number;
  tacticalShipId: number | null;
  tacticalGameUnitId: number | null;
  side: "attacker" | "defender";
  preBattleSnapshot: Record<string, unknown>;
  postBattleSnapshot: Record<string, unknown>;
  createdAt: string;
  rosterShip: CampaignRosterEntry | null;
};

type CampaignBattle = {
  id: number;
  campaignId: number;
  campaignTurnId: number | null;
  nominationId: number | null;
  turnNumber: number;
  targetId: number | null;
  attackerPlayerId: string;
  defenderPlayerId: string;
  tacticalGameId: number | null;
  name: string | null;
  scenarioKey: string;
  priorityLevel: string;
  rulesSnapshot: CampaignRulesSnapshot;
  status: string;
  tacticalGameStatus: string | null;
  tacticalWinnerId: string | null;
  resultPayload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  assignments: CampaignBattleAssignment[];
  priorityModifiers: {
    attackerSubmitted: boolean;
    defenderSubmitted: boolean;
    myModifier: number | null;
    revealed: { attacker: number; defender: number } | null;
  };
};

type CampaignSummary = {
  id: number;
  ownerPlayerId: string;
  name: string;
  status: string;
  ruleset: string;
  variant: string;
  visibility: "private" | "public";
  currentTurn: number;
  phase: string;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  playerCount: number;
  players: CampaignPlayer[];
};

type CampaignDetail = CampaignSummary & {
  recentLog: CampaignLogEntry[];
  roster: CampaignRosterEntry[];
  battles: CampaignBattle[];
  strategicTargets: CampaignStrategicTarget[];
  currentTurnState: CampaignCurrentTurnState | null;
  setup: CampaignSetupState;
  resolution: CampaignResolutionState | null;
};

type CampaignTurnPlayerState = {
  id: number;
  campaignTurnId: number;
  turnNumber: number;
  playerId: string;
  experienceComplete: boolean;
  rrIncomeGenerated: boolean;
  repairsComplete: boolean;
};

type CampaignResourceLedgerEntry = {
  id: number;
  turnNumber: number;
  playerId: string;
  campaignShipInstanceId: number | null;
  resource: "rr" | "xp-dice" | string;
  amount: number;
  type: string;
  message: string;
  payload: Record<string, unknown>;
};

type CampaignResolutionState = {
  playerStates: CampaignTurnPlayerState[];
  ledger: CampaignResourceLedgerEntry[];
  ownershipEvents: Array<Record<string, unknown>>;
  rrBalances: Record<string, number>;
  reinforcementFactions: Record<string, string[]>;
};

type CampaignTurn = {
  id: number;
  campaignId: number;
  turnNumber: number;
  status: string;
  initiativeOrder: string[];
  targetSelectionIndex: number;
  createdAt: string;
  updatedAt: string;
};

type CampaignInitiativeRoll = {
  id: number;
  campaignTurnId: number;
  playerId: string;
  dice: number[];
  fleetModifier: number;
  targetPenalty: number;
  initialTotal: number;
  finalTotal: number;
  rerolls: Array<{ dice: number[]; total: number }>;
};

type CampaignTargetNomination = {
  id: number;
  campaignTurnId: number;
  turnNumber: number;
  sequence: number;
  nominatorPlayerId: string;
  targetId: number;
  targetOwnerPlayerId: string | null;
  defenderPlayerId: string | null;
  challengerPlayerId: string | null;
  challengeOrder: string[];
  challengeIndex: number;
  declinedPlayerIds: string[];
  status: string;
  currentChallengerPlayerId: string | null;
};

type CampaignCurrentTurnState = {
  turn: CampaignTurn;
  initiativeRolls: CampaignInitiativeRoll[];
  targetNominations: CampaignTargetNomination[];
};

type CampaignStrategicTarget = {
  id: number;
  campaignId: number;
  sequence: number;
  key: string;
  category: string;
  subtype: string;
  name: string;
  ownerPlayerId: string | null;
  rrValue: number;
  rrFormula: string | null;
  explored: boolean;
  isTradeRoute: boolean;
  categoryRoll: number | null;
  subtypeRoll: number | null;
  unusualFeatures: Array<{ name?: string; key?: string; source?: string }>;
  rulesPayload: Record<string, unknown>;
};

type CampaignSetupPlayerState = {
  playerId: string;
  displayName: string | null;
  ready: boolean;
  crewQualitySwapUsed: boolean;
  initiativeModifier: number;
  rosterCount: number;
  budgetFap: number;
  spentFap: number;
  remainingFap: number;
  allocationLegal: boolean;
  crewQualityReady: boolean;
  legal: boolean;
  issues: string[];
};

type CampaignSetupState = {
  startingAllocationPoints: number;
  startingPriorityLevel: string;
  minimumPlayers: number;
  playerStates: CampaignSetupPlayerState[];
  canStart: boolean;
  issues: string[];
};

type CampaignListResponse = {
  myCampaigns: CampaignSummary[];
  openCampaigns: CampaignSummary[];
};

type CampaignResponse = {
  campaign: CampaignDetail;
};

type CampaignCrewQualityResponse = CampaignResponse & {
  crewQualityRolls: Array<{
    shipInstanceId: number;
    shipName: string;
    dice: [number, number];
    total: number;
    score: number;
    label: string;
  }>;
};

type CampaignImportResponse = CampaignResponse & {
  importSummary: {
    alreadyImported: boolean;
    battleId: number;
    tacticalGameId: number | null;
    winnerId?: string | null;
    shipResults: Array<Record<string, unknown>>;
  };
};

const campaignsQueryKey = ["campaigns"] as const;

function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return fallback;
}

function campaignTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function modelLine(model: ShipModel | null): string {
  if (!model) return "Model unavailable";
  return `${model.faction} / ${priorityLabel(normalizePriorityLevel(model.priorityLevel))}`;
}

function rosterOwnerName(rosterShip: CampaignRosterEntry, players: CampaignPlayer[]): string {
  const owner = players.find((player) => player.playerId === rosterShip.ownerPlayerId);
  return owner?.displayName ?? "Commander";
}

function campaignPlayerName(playerId: string, players: CampaignPlayer[]): string {
  const player = players.find((candidate) => candidate.playerId === playerId);
  return player?.displayName ?? playerId;
}

function formatFap(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function campaignReinforcementRr(model: ShipModel): number {
  const costs: Record<string, number> = {
    patrol: 3,
    skirmish: 6,
    raid: 12,
    battle: 20,
    war: 30,
    armageddon: 50,
  };
  const base = costs[normalizePriorityLevel(model.priorityLevel)] ?? 12;
  const isStation = /\bspace\s+station\b|\bstar\s*base\b/i.test(`${model.name} ${model.shipClass ?? ""} ${model.traits ?? ""}`);
  return isStation ? base * 3 : base;
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    setup: "border-amber-400/45 bg-amber-400/10 text-amber-200",
    active: "border-green-400/45 bg-green-400/10 text-green-200",
    completed: "border-muted bg-muted/20 text-muted-foreground",
    archived: "border-muted bg-muted/20 text-muted-foreground",
  };
  return (
    <span className={`rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] ${variants[status] ?? variants.setup}`}>
      {status}
    </span>
  );
}

function VisibilityBadge({ visibility }: { visibility: CampaignSummary["visibility"] }) {
  const Icon = visibility === "public" ? Eye : Lock;
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border/80 bg-background/45 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
      <Icon className="h-3 w-3" />
      {visibility}
    </span>
  );
}

function CampaignRow({
  campaign,
  actionLabel,
  onAction,
  actionDisabled,
}: {
  campaign: CampaignSummary;
  actionLabel: string;
  onAction: () => void;
  actionDisabled?: boolean;
}) {
  const playerNames = campaign.players
    .map((player) => {
      const name = player.displayName ?? "Commander";
      return player.faction ? `${name} (${player.faction})` : name;
    })
    .join(", ");

  return (
    <article className="rounded border border-border bg-card/65 p-4" data-testid={`campaign-row-${campaign.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-bold uppercase tracking-[0.16em] text-foreground">{campaign.name}</h3>
            <StatusBadge status={campaign.status} />
            <VisibilityBadge visibility={campaign.visibility} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            <span>Turn {campaign.currentTurn}</span>
            <span>{campaign.phase}</span>
            <span>{campaignTime(campaign.updatedAt)}</span>
          </div>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {playerNames || "No commanders assigned"}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="uppercase tracking-widest text-xs"
          onClick={onAction}
          disabled={actionDisabled}
          data-testid={`button-campaign-${actionLabel.toLowerCase()}-${campaign.id}`}
        >
          {actionLabel}
        </Button>
      </div>
    </article>
  );
}

export default function Campaign() {
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const devUserId = useDevUserId();
  useTemporaryUsername();
  const { user } = useUser();
  const myUserId =
    (temporaryUsernameAuthEnabled
      ? getTemporaryUserId()
      : import.meta.env.DEV
        ? devUserId
        : user?.id) ?? "";
  const [name, setName] = useState("");
  const [fleetLabel, setFleetLabel] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [selectedCampaignId, setSelectedCampaignId] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const requested = Number(new URLSearchParams(window.location.search).get("campaign"));
    return Number.isInteger(requested) && requested > 0 ? requested : null;
  });
  const [rosterFactionFilter, setRosterFactionFilter] = useState("__all__");
  const [selectedShipModelId, setSelectedShipModelId] = useState("");
  const [reinforcementModelId, setReinforcementModelId] = useState("");
  const [shipName, setShipName] = useState("");
  const [firstCrewQualityShipId, setFirstCrewQualityShipId] = useState("");
  const [secondCrewQualityShipId, setSecondCrewQualityShipId] = useState("");
  const [initiativeModifierInput, setInitiativeModifierInput] = useState("0");
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [lastCrewQualityRolls, setLastCrewQualityRolls] = useState<CampaignCrewQualityResponse["crewQualityRolls"]>([]);
  const [battleName, setBattleName] = useState("");
  const [battleAttackerId, setBattleAttackerId] = useState("");
  const [battleDefenderId, setBattleDefenderId] = useState("");
  const [battlePriorityLevel, setBattlePriorityLevel] = useState("raid");
  const [battleAllocationPoints, setBattleAllocationPoints] = useState(5);
  const [battleScenarioKey, setBattleScenarioKey] = useState("campaign-engagement");
  const [battleDeploymentPreset, setBattleDeploymentPreset] = useState("standard-short-edge");
  const [battleDeploymentDepth, setBattleDeploymentDepth] = useState(12);
  const [battleAmbushCenterSide, setBattleAmbushCenterSide] = useState<"attacker" | "defender">("defender");
  const [battleTerrain, setBattleTerrain] = useState("none");
  const [battleTerrainCount, setBattleTerrainCount] = useState(3);
  const [battleStations, setBattleStations] = useState("none");
  const [battleSkybox, setBattleSkybox] = useState("bright-nebula");
  const [battleSpecialConditions, setBattleSpecialConditions] = useState("");
  const [selectedBattleShipIds, setSelectedBattleShipIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [error, setError] = useState<string | null>(null);

  const campaignsQuery = useQuery({
    queryKey: campaignsQueryKey,
    queryFn: () =>
      customFetch<CampaignListResponse>("/api/campaigns", {
        responseType: "json",
      }),
  });

  const selectedCampaignQuery = useQuery({
    queryKey: ["campaign", selectedCampaignId],
    queryFn: () =>
      customFetch<CampaignResponse>(`/api/campaigns/${selectedCampaignId}`, {
        responseType: "json",
      }),
    enabled: selectedCampaignId !== null,
    refetchInterval: 4000,
  });

  const shipModelsQuery = useListShipModels();

  const selectedCampaign = selectedCampaignQuery.data?.campaign ?? null;
  const selectedShipModel = useMemo(() => {
    const id = Number(selectedShipModelId);
    return shipModelsQuery.data?.find((model) => model.id === id) ?? null;
  }, [selectedShipModelId, shipModelsQuery.data]);
  const rosterFactions = useMemo(
    () => [...new Set((shipModelsQuery.data ?? []).map((model) => model.faction))].sort(),
    [shipModelsQuery.data],
  );
  const filteredRosterShipModels = useMemo(
    () => (shipModelsQuery.data ?? [])
      .filter((model) => rosterFactionFilter === "__all__" || model.faction === rosterFactionFilter)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [rosterFactionFilter, shipModelsQuery.data],
  );
  const firstCampaignId = campaignsQuery.data?.myCampaigns[0]?.id ?? campaignsQuery.data?.openCampaigns[0]?.id ?? null;

  useEffect(() => {
    if (!selectedCampaign) return;
    setBattleAttackerId((current) =>
      selectedCampaign.players.some((player) => player.playerId === current)
        ? current
        : selectedCampaign.players[0]?.playerId ?? "",
    );
    setBattleDefenderId((current) =>
      selectedCampaign.players.some((player) => player.playerId === current)
        ? current
        : selectedCampaign.players.find((player) => player.playerId !== selectedCampaign.players[0]?.playerId)?.playerId ?? "",
    );
  }, [selectedCampaign]);

  const savedInitiativeModifier = selectedCampaign?.players.find(
    (player) => player.playerId === myUserId,
  )?.initiativeModifier;

  useEffect(() => {
    setInitiativeModifierInput(String(savedInitiativeModifier ?? 0));
  }, [selectedCampaignId, savedInitiativeModifier]);

  useEffect(() => {
    setSelectedBattleShipIds(new Set());
    setFirstCrewQualityShipId("");
    setSecondCrewQualityShipId("");
    setLastCrewQualityRolls([]);
    setSelectedTargetId("");
  }, [selectedCampaignId]);

  const createCampaign = useMutation({
    mutationFn: () =>
      customFetch<CampaignResponse>("/api/campaigns", {
        method: "POST",
        responseType: "json",
        body: JSON.stringify({
          name: name.trim(),
          faction: fleetLabel.trim() || null,
          visibility,
        }),
      }),
    onMutate: () => setError(null),
    onSuccess: async (response) => {
      setName("");
      setFleetLabel("");
      setVisibility("private");
      setSelectedCampaignId(response.campaign.id);
      await qc.invalidateQueries({ queryKey: campaignsQueryKey });
      await qc.invalidateQueries({ queryKey: ["campaign", response.campaign.id] });
    },
    onError: (err) => setError(apiErrorMessage(err, "Campaign creation failed")),
  });

  const joinCampaign = useMutation({
    mutationFn: (campaignId: number) =>
      customFetch<CampaignResponse>(`/api/campaigns/${campaignId}/join`, {
        method: "POST",
        responseType: "json",
        body: JSON.stringify({
          faction: fleetLabel.trim() || null,
        }),
      }),
    onMutate: () => setError(null),
    onSuccess: async (response) => {
      setSelectedCampaignId(response.campaign.id);
      await qc.invalidateQueries({ queryKey: campaignsQueryKey });
      await qc.invalidateQueries({ queryKey: ["campaign", response.campaign.id] });
    },
    onError: (err) => setError(apiErrorMessage(err, "Campaign join failed")),
  });

  const addRosterShip = useMutation({
    mutationFn: () => {
      if (!selectedCampaignId) throw new Error("Open a campaign first");
      const shipModelId = Number(selectedShipModelId);
      if (!Number.isInteger(shipModelId) || shipModelId <= 0) {
        throw new Error("Choose a ship to add");
      }
      return customFetch<CampaignResponse>(`/api/campaigns/${selectedCampaignId}/roster`, {
        method: "POST",
        responseType: "json",
        body: JSON.stringify({
          shipModelId,
          name: shipName.trim() || null,
        }),
      });
    },
    onMutate: () => setError(null),
    onSuccess: async (response) => {
      setShipName("");
      setSelectedCampaignId(response.campaign.id);
      await qc.invalidateQueries({ queryKey: ["campaign", response.campaign.id] });
      await qc.invalidateQueries({ queryKey: campaignsQueryKey });
    },
    onError: (err) => setError(apiErrorMessage(err, "Campaign roster update failed")),
  });

  const removeRosterShip = useMutation({
    mutationFn: ({ campaignId, shipInstanceId }: { campaignId: number; shipInstanceId: number }) =>
      customFetch<CampaignResponse>(`/api/campaigns/${campaignId}/roster/${shipInstanceId}`, {
        method: "DELETE",
        responseType: "json",
      }),
    onMutate: () => setError(null),
    onSuccess: async (response) => {
      await qc.invalidateQueries({ queryKey: ["campaign", response.campaign.id] });
      await qc.invalidateQueries({ queryKey: campaignsQueryKey });
    },
    onError: (err) => setError(apiErrorMessage(err, "Campaign roster removal failed")),
  });

  const rollCrewQuality = useMutation({
    mutationFn: () => {
      if (!selectedCampaignId) throw new Error("Open a campaign first");
      return customFetch<CampaignCrewQualityResponse>(
        `/api/campaigns/${selectedCampaignId}/setup/crew-quality/roll`,
        { method: "POST", responseType: "json" },
      );
    },
    onMutate: () => setError(null),
    onSuccess: async (response) => {
      setLastCrewQualityRolls(response.crewQualityRolls);
      await qc.invalidateQueries({ queryKey: ["campaign", response.campaign.id] });
      await qc.invalidateQueries({ queryKey: campaignsQueryKey });
    },
    onError: (err) => setError(apiErrorMessage(err, "Crew Quality generation failed")),
  });

  const swapCrewQuality = useMutation({
    mutationFn: () => {
      if (!selectedCampaignId) throw new Error("Open a campaign first");
      return customFetch<CampaignResponse>(
        `/api/campaigns/${selectedCampaignId}/setup/crew-quality/swap`,
        {
          method: "POST",
          responseType: "json",
          body: JSON.stringify({
            firstShipInstanceId: Number(firstCrewQualityShipId),
            secondShipInstanceId: Number(secondCrewQualityShipId),
          }),
        },
      );
    },
    onMutate: () => setError(null),
    onSuccess: async (response) => {
      setFirstCrewQualityShipId("");
      setSecondCrewQualityShipId("");
      await qc.invalidateQueries({ queryKey: ["campaign", response.campaign.id] });
      await qc.invalidateQueries({ queryKey: campaignsQueryKey });
    },
    onError: (err) => setError(apiErrorMessage(err, "Crew Quality swap failed")),
  });

  const setInitiativeModifier = useMutation({
    mutationFn: () => {
      if (!selectedCampaignId) throw new Error("Open a campaign first");
      return customFetch<CampaignResponse>(
        `/api/campaigns/${selectedCampaignId}/setup/initiative-modifier`,
        {
          method: "POST",
          responseType: "json",
          body: JSON.stringify({ initiativeModifier: Number(initiativeModifierInput) }),
        },
      );
    },
    onMutate: () => setError(null),
    onSuccess: async (response) => {
      await qc.invalidateQueries({ queryKey: ["campaign", response.campaign.id] });
      await qc.invalidateQueries({ queryKey: campaignsQueryKey });
    },
    onError: (err) => setError(apiErrorMessage(err, "Fleet Initiative update failed")),
  });

  const setCampaignReady = useMutation({
    mutationFn: (ready: boolean) => {
      if (!selectedCampaignId) throw new Error("Open a campaign first");
      return customFetch<CampaignResponse>(`/api/campaigns/${selectedCampaignId}/setup/ready`, {
        method: "POST",
        responseType: "json",
        body: JSON.stringify({ ready }),
      });
    },
    onMutate: () => setError(null),
    onSuccess: async (response) => {
      await qc.invalidateQueries({ queryKey: ["campaign", response.campaign.id] });
      await qc.invalidateQueries({ queryKey: campaignsQueryKey });
    },
    onError: (err) => setError(apiErrorMessage(err, "Campaign readiness update failed")),
  });

  const startCampaign = useMutation({
    mutationFn: () => {
      if (!selectedCampaignId) throw new Error("Open a campaign first");
      return customFetch<CampaignResponse>(`/api/campaigns/${selectedCampaignId}/start`, {
        method: "POST",
        responseType: "json",
      });
    },
    onMutate: () => setError(null),
    onSuccess: async (response) => {
      await qc.invalidateQueries({ queryKey: ["campaign", response.campaign.id] });
      await qc.invalidateQueries({ queryKey: campaignsQueryKey });
    },
    onError: (err) => setError(apiErrorMessage(err, "Campaign could not be started")),
  });

  const rollCampaignInitiative = useMutation({
    mutationFn: () => {
      if (!selectedCampaignId) throw new Error("Open a campaign first");
      return customFetch<CampaignResponse>(
        `/api/campaigns/${selectedCampaignId}/turns/current/initiative-roll`,
        { method: "POST", responseType: "json" },
      );
    },
    onMutate: () => setError(null),
    onSuccess: async (response) => {
      await qc.invalidateQueries({ queryKey: ["campaign", response.campaign.id] });
      await qc.invalidateQueries({ queryKey: campaignsQueryKey });
    },
    onError: (err) => setError(apiErrorMessage(err, "Campaign initiative roll failed")),
  });

  const nominateCampaignTarget = useMutation({
    mutationFn: () => {
      if (!selectedCampaignId) throw new Error("Open a campaign first");
      const targetId = Number(selectedTargetId);
      if (!Number.isInteger(targetId) || targetId <= 0) throw new Error("Choose a Strategic Target");
      return customFetch<CampaignResponse>(
        `/api/campaigns/${selectedCampaignId}/turns/current/targets/nominate`,
        {
          method: "POST",
          responseType: "json",
          body: JSON.stringify({ targetId }),
        },
      );
    },
    onMutate: () => setError(null),
    onSuccess: async (response) => {
      setSelectedTargetId("");
      await qc.invalidateQueries({ queryKey: ["campaign", response.campaign.id] });
      await qc.invalidateQueries({ queryKey: campaignsQueryKey });
    },
    onError: (err) => setError(apiErrorMessage(err, "Strategic Target nomination failed")),
  });

  const respondToCampaignChallenge = useMutation({
    mutationFn: ({ nominationId, challenge }: { nominationId: number; challenge: boolean }) => {
      if (!selectedCampaignId) throw new Error("Open a campaign first");
      return customFetch<CampaignResponse>(
        `/api/campaigns/${selectedCampaignId}/turns/current/targets/${nominationId}/respond`,
        {
          method: "POST",
          responseType: "json",
          body: JSON.stringify({ challenge }),
        },
      );
    },
    onMutate: () => setError(null),
    onSuccess: async (response) => {
      await qc.invalidateQueries({ queryKey: ["campaign", response.campaign.id] });
      await qc.invalidateQueries({ queryKey: campaignsQueryKey });
    },
    onError: (err) => setError(apiErrorMessage(err, "Strategic Target response failed")),
  });

  const prepareCampaignScenarios = useMutation({
    mutationFn: () => {
      if (!selectedCampaignId) throw new Error("Open a campaign first");
      return customFetch<CampaignResponse>(
        `/api/campaigns/${selectedCampaignId}/turns/current/scenarios/prepare`,
        { method: "POST", responseType: "json" },
      );
    },
    onMutate: () => setError(null),
    onSuccess: async (response) => {
      await qc.invalidateQueries({ queryKey: ["campaign", response.campaign.id] });
      await qc.invalidateQueries({ queryKey: campaignsQueryKey });
    },
    onError: (err) => setError(apiErrorMessage(err, "Campaign scenarios could not be prepared")),
  });

  const createCampaignBattle = useMutation({
    mutationFn: () => {
      if (!selectedCampaign) throw new Error("Open a campaign first");
      const attackerShipInstanceIds = selectedCampaign.roster
        .filter((ship) => ship.ownerPlayerId === battleAttackerId && selectedBattleShipIds.has(ship.id))
        .map((ship) => ship.id);
      const defenderShipInstanceIds = selectedCampaign.roster
        .filter((ship) => ship.ownerPlayerId === battleDefenderId && selectedBattleShipIds.has(ship.id))
        .map((ship) => ship.id);
      if (!battleAttackerId || !battleDefenderId || battleAttackerId === battleDefenderId) {
        throw new Error("Choose two different commanders for the battle.");
      }
      if (attackerShipInstanceIds.length === 0 || defenderShipInstanceIds.length === 0) {
        throw new Error("Assign at least one roster ship to each side.");
      }
      return customFetch<CampaignResponse>(`/api/campaigns/${selectedCampaign.id}/battles`, {
        method: "POST",
        responseType: "json",
        body: JSON.stringify({
          attackerPlayerId: battleAttackerId,
          defenderPlayerId: battleDefenderId,
          attackerShipInstanceIds,
          defenderShipInstanceIds,
          name: battleName.trim() || null,
          scenarioKey: battleScenarioKey,
          priorityLevel: battlePriorityLevel,
          allocationPoints: battleAllocationPoints,
          deploymentPreset: battleDeploymentPreset,
          deploymentDepth: battleDeploymentDepth,
          ambushCenterSide: battleAmbushCenterSide,
          terrain: battleTerrain,
          terrainCount: battleTerrain === "none" ? 0 : battleTerrainCount,
          stations: battleStations,
          skybox: battleSkybox,
          specialConditions: battleSpecialConditions,
        }),
      });
    },
    onMutate: () => setError(null),
    onSuccess: async (response) => {
      setBattleName("");
      setSelectedBattleShipIds(new Set());
      setSelectedCampaignId(response.campaign.id);
      await qc.invalidateQueries({ queryKey: ["campaign", response.campaign.id] });
      await qc.invalidateQueries({ queryKey: campaignsQueryKey });
      const createdBattle = response.campaign.battles.reduce<CampaignBattle | null>(
        (latest, battle) => !latest || battle.id > latest.id ? battle : latest,
        null,
      );
      if (createdBattle) {
        setLocation(`/campaign/${response.campaign.id}/battles/${createdBattle.id}`);
      }
    },
    onError: (err) => setError(apiErrorMessage(err, "Campaign battle creation failed")),
  });

  const importCampaignBattle = useMutation({
    mutationFn: (battle: CampaignBattle) => {
      if (!selectedCampaign) throw new Error("Open a campaign first");
      return customFetch<CampaignImportResponse>(
        `/api/campaigns/${selectedCampaign.id}/battles/${battle.id}/import-result`,
        {
          method: "POST",
          responseType: "json",
        },
      );
    },
    onMutate: () => setError(null),
    onSuccess: async (response) => {
      setSelectedCampaignId(response.campaign.id);
      await qc.invalidateQueries({ queryKey: ["campaign", response.campaign.id] });
      await qc.invalidateQueries({ queryKey: campaignsQueryKey });
    },
    onError: (err) => setError(apiErrorMessage(err, "Campaign battle result import failed")),
  });

  const campaignResolutionAction = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: Record<string, unknown> }) => {
      if (!selectedCampaign) throw new Error("Open a campaign first");
      return customFetch<CampaignResponse>(`/api/campaigns/${selectedCampaign.id}${path}`, {
        method: "POST",
        responseType: "json",
        body: body ? JSON.stringify(body) : undefined,
      });
    },
    onMutate: () => setError(null),
    onSuccess: async (response) => {
      setSelectedCampaignId(response.campaign.id);
      await qc.invalidateQueries({ queryKey: ["campaign", response.campaign.id] });
      await qc.invalidateQueries({ queryKey: campaignsQueryKey });
    },
    onError: (err) => setError(apiErrorMessage(err, "Campaign resolution action failed")),
  });

  const openCampaignBattle = (battle: CampaignBattle) => {
    if (!selectedCampaign) return;
    setLocation(`/campaign/${selectedCampaign.id}/battles/${battle.id}`);
  };

  const myCampaigns = campaignsQuery.data?.myCampaigns ?? [];
  const openCampaigns = campaignsQuery.data?.openCampaigns ?? [];
  const totalCampaigns = myCampaigns.length + openCampaigns.length;
  const myCampaignMembership = selectedCampaign?.players.find((player) => player.playerId === myUserId) ?? null;
  const myCampaignSetup = selectedCampaign?.setup.playerStates.find((player) => player.playerId === myUserId) ?? null;
  const campaignTurnState = selectedCampaign?.currentTurnState ?? null;
  const myInitiativeRoll = campaignTurnState?.initiativeRolls.find((roll) => roll.playerId === myUserId) ?? null;
  const pendingTargetChallenge = campaignTurnState?.targetNominations.find(
    (nomination) => nomination.status === "awaiting-challenge",
  ) ?? null;
  const currentTargetNominatorId = campaignTurnState?.turn.initiativeOrder[
    campaignTurnState.turn.targetSelectionIndex
  ] ?? null;
  const nominatedTargetIds = new Set(
    campaignTurnState?.targetNominations.map((nomination) => nomination.targetId) ?? [],
  );
  const eligibleStrategicTargets = selectedCampaign?.strategicTargets.filter(
    (target) => target.ownerPlayerId !== myUserId && !nominatedTargetIds.has(target.id),
  ) ?? [];
  const myCampaignRoster = selectedCampaign?.roster.filter((ship) => ship.ownerPlayerId === myUserId) ?? [];
  const myResolutionState = selectedCampaign?.resolution?.playerStates.find((state) => state.playerId === myUserId) ?? null;
  const myRrBalance = selectedCampaign?.resolution?.rrBalances[myUserId] ?? 0;
  const myResolutionLedger = (selectedCampaign?.resolution?.ledger ?? [])
    .filter((entry) => entry.playerId === myUserId)
    .slice(-6)
    .reverse();
  const reinforcementFactions = selectedCampaign?.resolution?.reinforcementFactions[myUserId] ?? [];
  const reinforcementModels = (shipModelsQuery.data ?? [])
    .filter((model) => reinforcementFactions.length === 0 || reinforcementFactions.includes(model.faction))
    .sort((a, b) => a.name.localeCompare(b.name));
  const swappableCrewQualityShips = myCampaignRoster.filter((ship) => Number.isInteger(ship.crewQualityRoll));
  const canEditRoster = selectedCampaign?.status === "setup" && !myCampaignMembership?.ready;
  const canAddRosterShip =
    canEditRoster &&
    selectedCampaignId !== null &&
    selectedShipModel !== null &&
    !addRosterShip.isPending;
  const battleAttackerRoster = selectedCampaign?.roster.filter(
    (ship) => ship.ownerPlayerId === battleAttackerId && !ship.destroyed && ship.status === "active",
  ) ?? [];
  const generatedTurnBattles = selectedCampaign?.battles.filter(
    (battle) => battle.turnNumber === selectedCampaign.currentTurn && battle.nominationId !== null,
  ) ?? [];
  const battleDefenderRoster = selectedCampaign?.roster.filter(
    (ship) => ship.ownerPlayerId === battleDefenderId && !ship.destroyed && ship.status === "active",
  ) ?? [];
  const attackerSelectedCount = battleAttackerRoster.filter((ship) => selectedBattleShipIds.has(ship.id)).length;
  const defenderSelectedCount = battleDefenderRoster.filter((ship) => selectedBattleShipIds.has(ship.id)).length;
  const canCreateBattle =
    Boolean(selectedCampaign) &&
    selectedCampaign!.status === "active" &&
    selectedCampaign!.players.length >= 2 &&
    battleAttackerId.length > 0 &&
    battleDefenderId.length > 0 &&
    battleAttackerId !== battleDefenderId &&
    attackerSelectedCount > 0 &&
    defenderSelectedCount > 0 &&
    !createCampaignBattle.isPending;
  const canSwapCrewQuality =
    canEditRoster &&
    !myCampaignMembership?.crewQualitySwapUsed &&
    firstCrewQualityShipId.length > 0 &&
    secondCrewQualityShipId.length > 0 &&
    firstCrewQualityShipId !== secondCrewQualityShipId &&
    !swapCrewQuality.isPending;
  const parsedInitiativeModifier = Number(initiativeModifierInput);
  const canSaveInitiativeModifier =
    canEditRoster &&
    Number.isInteger(parsedInitiativeModifier) &&
    parsedInitiativeModifier >= -5 &&
    parsedInitiativeModifier <= 5 &&
    parsedInitiativeModifier !== myCampaignMembership?.initiativeModifier &&
    !setInitiativeModifier.isPending;
  const toggleBattleShip = (shipId: number) => {
    setSelectedBattleShipIds((prev) => {
      const next = new Set(prev);
      if (next.has(shipId)) next.delete(shipId);
      else next.add(shipId);
      return next;
    });
  };

  const nextSlice = useMemo(() => {
    if (myCampaigns.length === 0) return "Create a campaign shell.";
    if (selectedCampaign?.status === "setup") return "Complete rosters, generate CQ, ready commanders, and start Turn 1.";
    if (selectedCampaign?.phase === "initiative") return "Every commander rolls campaign initiative.";
    if (selectedCampaign?.phase === "select-targets") return "Nominate Strategic Targets and resolve challenges.";
    if (selectedCampaign?.phase === "generate-scenarios") return "Commit secret Priority modifiers and resolve generated scenarios.";
    if (selectedCampaign?.phase === "fleet-assignment") return "Each battle commander assigns one legal force for this turn.";
    if (selectedCampaign?.phase === "tactical-battles") return "Fight generated engagements and import their persistent results.";
    if (selectedCampaign?.phase === "ship-experience") return "Spend or save each surviving ship's XP dice, then mark experience complete.";
    if (selectedCampaign?.phase === "repairs-reinforcements") return "Spend or save RR, repair the fleet, and acquire legal reinforcements.";
    return "Continue the campaign turn loop.";
  }, [myCampaigns.length, selectedCampaign?.phase, selectedCampaign?.status]);

  const canCreate = name.trim().length >= 3 && !createCampaign.isPending;

  return (
    <Layout title="Campaign">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 md:p-6">
        <section className="border-b border-border pb-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <MapIcon className="mt-1 h-5 w-5 text-primary" />
              <div>
                <h2 className="text-sm font-bold uppercase tracking-[0.22em] text-primary">
                  Campaign Command
                </h2>
                <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
                  Persistent 2E campaign command. Legal starting rosters, Crew Quality, readiness,
                  strategic-system generation, campaign engagements, persistent battle results, ship experience,
                  target control, repairs, and reinforcements are available.
                </p>
              </div>
            </div>
            <span className="rounded border border-amber-400/40 bg-amber-400/10 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-amber-200">
              Core Loop Active
            </span>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
          <form
            className="rounded border border-border bg-card/65 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canCreate) {
                setError("Campaign name must be at least 3 characters.");
                return;
              }
              createCampaign.mutate();
            }}
          >
            <div className="flex items-center gap-2 text-primary">
              <Plus className="h-4 w-4" />
              <h3 className="text-xs font-bold uppercase tracking-[0.2em]">Create Campaign</h3>
            </div>
            <div className="mt-4 grid gap-3">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Campaign name"
                maxLength={80}
                className="bg-background"
                data-testid="input-campaign-name"
              />
              <Input
                value={fleetLabel}
                onChange={(event) => setFleetLabel(event.target.value)}
                placeholder="Fleet label (optional - unrestricted)"
                maxLength={80}
                className="bg-background"
                data-testid="input-campaign-faction"
              />
              <select
                value={visibility}
                onChange={(event) => setVisibility(event.target.value as "private" | "public")}
                className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                data-testid="select-campaign-visibility"
              >
                <option value="private">Private</option>
                <option value="public">Public setup</option>
              </select>
              <Button type="submit" disabled={!canCreate} className="gap-2 uppercase tracking-widest text-xs">
                <Plus className="h-3.5 w-3.5" />
                {createCampaign.isPending ? "Creating..." : "Create"}
              </Button>
              {error && (
                <div className="rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
                  {error}
                </div>
              )}
            </div>
          </form>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded border border-border bg-card/65 p-4">
              <div className="flex items-center gap-2 text-primary">
                <Users className="h-4 w-4" />
                <h3 className="text-xs font-bold uppercase tracking-[0.2em]">Campaigns</h3>
              </div>
              <p className="mt-4 font-mono text-2xl font-bold text-foreground">{totalCampaigns}</p>
              <p className="mt-1 text-xs uppercase tracking-[0.14em] text-muted-foreground">Visible to you</p>
            </div>
            <div className="rounded border border-border bg-card/65 p-4">
              <div className="flex items-center gap-2 text-primary">
                <RotateCw className="h-4 w-4" />
                <h3 className="text-xs font-bold uppercase tracking-[0.2em]">Turn Loop</h3>
              </div>
              <p className="mt-4 text-sm leading-6 text-muted-foreground">
                Initiative, targets, scenario, battle, XP, RR.
              </p>
            </div>
            <div className="rounded border border-border bg-card/65 p-4">
              <div className="flex items-center gap-2 text-primary">
                <Database className="h-4 w-4" />
                <h3 className="text-xs font-bold uppercase tracking-[0.2em]">Next</h3>
              </div>
              <p className="mt-4 text-sm leading-6 text-muted-foreground">{nextSlice}</p>
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1fr_0.95fr]">
          <div className="grid gap-5">
            <div className="grid gap-3">
              <div className="flex items-center gap-2 text-primary">
                <ClipboardList className="h-4 w-4" />
                <h3 className="text-xs font-bold uppercase tracking-[0.2em]">Your Campaigns</h3>
              </div>
              {campaignsQuery.isLoading ? (
                <div className="grid gap-3">
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-24 w-full" />
                </div>
              ) : myCampaigns.length === 0 ? (
                <div className="rounded border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                  No campaign rosters yet.
                </div>
              ) : (
                <div className="grid gap-3">
                  {myCampaigns.map((campaign) => (
                    <CampaignRow
                      key={campaign.id}
                      campaign={campaign}
                      actionLabel="Open"
                      onAction={() => setSelectedCampaignId(campaign.id)}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-3">
              <div className="flex items-center gap-2 text-primary">
                <Swords className="h-4 w-4" />
                <h3 className="text-xs font-bold uppercase tracking-[0.2em]">Open Public Setups</h3>
              </div>
              {campaignsQuery.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : openCampaigns.length === 0 ? (
                <div className="rounded border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                  No public campaign setups available.
                </div>
              ) : (
                <div className="grid gap-3">
                  {openCampaigns.map((campaign) => (
                    <CampaignRow
                      key={campaign.id}
                      campaign={campaign}
                      actionLabel={joinCampaign.isPending ? "Joining" : "Join"}
                      actionDisabled={joinCampaign.isPending}
                      onAction={() => joinCampaign.mutate(campaign.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          <aside className="rounded border border-border bg-card/65 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-primary">
                <MapIcon className="h-4 w-4" />
                <h3 className="text-xs font-bold uppercase tracking-[0.2em]">Campaign Detail</h3>
              </div>
              {!selectedCampaignId && firstCampaignId ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="uppercase tracking-widest text-xs"
                  onClick={() => setSelectedCampaignId(firstCampaignId)}
                >
                  Load First
                </Button>
              ) : null}
            </div>

            {!selectedCampaignId ? (
              <div className="mt-8 rounded border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                Open a campaign to inspect commanders and log.
              </div>
            ) : selectedCampaignQuery.isLoading ? (
              <div className="mt-4 grid gap-3">
                <Skeleton className="h-10 w-2/3" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-32 w-full" />
              </div>
            ) : selectedCampaignQuery.isError ? (
              <div className="mt-4 rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
                {apiErrorMessage(selectedCampaignQuery.error, "Campaign could not be loaded")}
              </div>
            ) : selectedCampaign ? (
              <div className="mt-4 grid gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-bold uppercase tracking-[0.16em] text-foreground">
                      {selectedCampaign.name}
                    </h4>
                    <StatusBadge status={selectedCampaign.status} />
                    <VisibilityBadge visibility={selectedCampaign.visibility} />
                  </div>
                  <div className="mt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                    {selectedCampaign.ruleset} / {selectedCampaign.variant} / turn {selectedCampaign.currentTurn}
                  </div>
                </div>

                <div className="grid gap-2">
                  <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-primary">Commanders</div>
                  {selectedCampaign.players.map((player) => (
                    <div key={player.id} className="rounded border border-border/70 bg-background/35 px-3 py-2 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-foreground">{player.displayName ?? "Commander"}</span>
                        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                          {player.role} / {player.ready ? "ready" : "setup"}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Fleet label: {player.faction ?? "None"}
                      </div>
                    </div>
                  ))}
                </div>

                {selectedCampaign.status === "setup" && (
                  <div className="grid gap-3 border-y border-border/70 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-primary">
                        <Dice5 className="h-3.5 w-3.5" />
                        Campaign Setup
                      </div>
                      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                        10 FAP / Battle Priority
                      </span>
                    </div>

                    <div className="grid gap-2">
                      {selectedCampaign.setup.playerStates.map((playerSetup) => (
                        <div key={playerSetup.playerId} className="border-l-2 border-border/80 pl-3 text-xs">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-semibold text-foreground">
                              {playerSetup.displayName ?? "Commander"}
                            </span>
                            <span className={playerSetup.ready ? "text-green-300" : playerSetup.legal ? "text-amber-200" : "text-red-300"}>
                              {playerSetup.ready ? "Ready" : playerSetup.legal ? "Legal - not ready" : "Incomplete"}
                            </span>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                            <span>{playerSetup.rosterCount} ship{playerSetup.rosterCount === 1 ? "" : "s"}</span>
                            <span>FAP {formatFap(playerSetup.spentFap)} / {formatFap(playerSetup.budgetFap)}</span>
                            <span>{formatFap(playerSetup.remainingFap)} remaining</span>
                            <span>CQ {playerSetup.crewQualityReady ? "complete" : "pending"}</span>
                            <span>Swap {playerSetup.crewQualitySwapUsed ? "used" : "available"}</span>
                            <span>Initiative {playerSetup.initiativeModifier >= 0 ? "+" : ""}{playerSetup.initiativeModifier}</span>
                          </div>
                          {playerSetup.issues.length > 0 && (
                            <div className="mt-1 text-[11px] leading-5 text-red-200/90">
                              {playerSetup.issues.join(" ")}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    {myCampaignMembership && (
                      <div className="grid gap-2 border-t border-border/60 pt-3">
                        <div className="grid gap-2 sm:grid-cols-[minmax(0,220px)_auto_1fr] sm:items-center">
                          <Input
                            type="number"
                            min={-5}
                            max={5}
                            step={1}
                            value={initiativeModifierInput}
                            onChange={(event) => setInitiativeModifierInput(event.target.value)}
                            disabled={!canEditRoster}
                            aria-label="Fleet Initiative modifier"
                            data-testid="input-campaign-initiative-modifier"
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="uppercase tracking-widest text-[10px]"
                            disabled={!canSaveInitiativeModifier}
                            onClick={() => setInitiativeModifier.mutate()}
                            data-testid="button-campaign-save-initiative-modifier"
                          >
                            {setInitiativeModifier.isPending ? "Saving" : "Save Initiative"}
                          </Button>
                          <span className="text-[11px] leading-5 text-muted-foreground">
                            Enter the fleet's 2E Initiative modifier. The campaign name and fleet label do not infer rules values.
                          </span>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-[auto_1fr_1fr_auto]">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="gap-1 uppercase tracking-widest text-[10px]"
                            disabled={!canEditRoster || myCampaignRoster.length === 0 || myCampaignSetup?.crewQualityReady || rollCrewQuality.isPending}
                            onClick={() => rollCrewQuality.mutate()}
                            data-testid="button-campaign-roll-crew-quality"
                          >
                            <Dice5 className="h-3 w-3" />
                            {rollCrewQuality.isPending ? "Rolling" : myCampaignSetup?.crewQualityReady ? "CQ Generated" : "Generate CQ"}
                          </Button>
                          <select
                            value={firstCrewQualityShipId}
                            onChange={(event) => setFirstCrewQualityShipId(event.target.value)}
                            disabled={!canEditRoster || myCampaignMembership.crewQualitySwapUsed}
                            className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground disabled:opacity-50"
                            aria-label="First Crew Quality swap ship"
                            data-testid="select-campaign-cq-swap-first"
                          >
                            <option value="">First CQ ship</option>
                            {swappableCrewQualityShips.map((ship) => (
                              <option key={ship.id} value={ship.id}>{ship.name} - CQ {ship.crewQuality}</option>
                            ))}
                          </select>
                          <select
                            value={secondCrewQualityShipId}
                            onChange={(event) => setSecondCrewQualityShipId(event.target.value)}
                            disabled={!canEditRoster || myCampaignMembership.crewQualitySwapUsed}
                            className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground disabled:opacity-50"
                            aria-label="Second Crew Quality swap ship"
                            data-testid="select-campaign-cq-swap-second"
                          >
                            <option value="">Second CQ ship</option>
                            {swappableCrewQualityShips.map((ship) => (
                              <option key={ship.id} value={ship.id}>{ship.name} - CQ {ship.crewQuality}</option>
                            ))}
                          </select>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="gap-1 uppercase tracking-widest text-[10px]"
                            disabled={!canSwapCrewQuality}
                            onClick={() => swapCrewQuality.mutate()}
                            data-testid="button-campaign-swap-crew-quality"
                          >
                            <Shuffle className="h-3 w-3" />
                            {myCampaignMembership.crewQualitySwapUsed ? "Swap Used" : "Swap CQ"}
                          </Button>
                        </div>

                        {lastCrewQualityRolls.length > 0 && (
                          <div className="grid gap-1 border-l-2 border-cyan-400/60 pl-3 font-mono text-[10px] uppercase tracking-[0.1em] text-cyan-100">
                            {lastCrewQualityRolls.map((roll) => (
                              <div key={roll.shipInstanceId}>
                                {roll.shipName}: {roll.dice[0]} + {roll.dice[1]} = {roll.total} / CQ {roll.score} {roll.label}
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant={myCampaignMembership.ready ? "outline" : "default"}
                            className="uppercase tracking-widest text-[10px]"
                            disabled={setCampaignReady.isPending || (!myCampaignMembership.ready && !myCampaignSetup?.legal)}
                            onClick={() => setCampaignReady.mutate(!myCampaignMembership.ready)}
                            data-testid="button-campaign-ready"
                          >
                            {setCampaignReady.isPending ? "Updating" : myCampaignMembership.ready ? "Unlock Setup" : "Mark Ready"}
                          </Button>
                          {selectedCampaign.ownerPlayerId === myUserId && (
                            <Button
                              type="button"
                              size="sm"
                              className="gap-1 uppercase tracking-widest text-[10px]"
                              disabled={!selectedCampaign.setup.canStart || startCampaign.isPending}
                              onClick={() => startCampaign.mutate()}
                              data-testid="button-campaign-start"
                            >
                              <Play className="h-3 w-3" />
                              {startCampaign.isPending ? "Starting" : "Start Campaign"}
                            </Button>
                          )}
                        </div>
                        {selectedCampaign.ownerPlayerId === myUserId && !selectedCampaign.setup.canStart && (
                          <div className="text-[11px] leading-5 text-muted-foreground">
                            {selectedCampaign.setup.issues.join(" ")}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {selectedCampaign.status === "active" && campaignTurnState && (
                  <div className="grid gap-4 border-y border-border/70 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-primary">
                        <RotateCw className="h-3.5 w-3.5" />
                        Campaign Turn {campaignTurnState.turn.turnNumber}
                      </div>
                      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200">
                        {campaignTurnState.turn.status.replaceAll("-", " ")}
                      </span>
                    </div>

                    <div className="grid gap-2">
                      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                        Initiative
                      </div>
                      {selectedCampaign.players
                        .filter((player) => player.status === "active")
                        .sort((a, b) => {
                          const aIndex = campaignTurnState.turn.initiativeOrder.indexOf(a.playerId);
                          const bIndex = campaignTurnState.turn.initiativeOrder.indexOf(b.playerId);
                          if (aIndex < 0 && bIndex < 0) return a.id - b.id;
                          if (aIndex < 0) return 1;
                          if (bIndex < 0) return -1;
                          return aIndex - bIndex;
                        })
                        .map((player, index) => {
                          const roll = campaignTurnState.initiativeRolls.find((entry) => entry.playerId === player.playerId);
                          const resolved = campaignTurnState.turn.initiativeOrder.length > 0;
                          return (
                            <div key={player.playerId} className="grid gap-1 border-l-2 border-border/80 pl-3 sm:grid-cols-[1fr_auto] sm:items-center">
                              <div className="text-xs text-foreground">
                                {resolved ? `${index + 1}. ` : ""}{campaignPlayerName(player.playerId, selectedCampaign.players)}
                              </div>
                              <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                                {roll ? (
                                  <>
                                    {roll.dice[0]} + {roll.dice[1]}
                                    {` ${roll.fleetModifier >= 0 ? "+" : "-"} ${Math.abs(roll.fleetModifier)} fleet`}
                                    {roll.targetPenalty !== 0 ? ` - ${Math.abs(roll.targetPenalty)} targets` : ""}
                                    {` = ${roll.finalTotal}`}
                                    {roll.rerolls.length > 0 ? ` / ${roll.rerolls.length} tie reroll${roll.rerolls.length === 1 ? "" : "s"}` : ""}
                                  </>
                                ) : "Awaiting roll"}
                              </div>
                            </div>
                          );
                        })}
                      {selectedCampaign.phase === "initiative" && myCampaignMembership && !myInitiativeRoll && (
                        <div>
                          <Button
                            type="button"
                            size="sm"
                            className="gap-1 uppercase tracking-widest text-[10px]"
                            disabled={rollCampaignInitiative.isPending}
                            onClick={() => rollCampaignInitiative.mutate()}
                            data-testid="button-campaign-roll-initiative"
                          >
                            <Dice5 className="h-3 w-3" />
                            {rollCampaignInitiative.isPending ? "Rolling" : "Roll Initiative"}
                          </Button>
                        </div>
                      )}
                      {selectedCampaign.phase === "initiative" && myInitiativeRoll && (
                        <div className="text-[11px] leading-5 text-muted-foreground">
                          Your roll is recorded. Waiting for the remaining commanders.
                        </div>
                      )}
                    </div>

                    {(selectedCampaign.phase === "select-targets" || campaignTurnState.targetNominations.length > 0) && (
                      <div className="grid gap-3 border-t border-border/60 pt-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                            Select Targets
                          </div>
                          {currentTargetNominatorId && !pendingTargetChallenge && (
                            <span className="text-xs text-amber-200">
                              {campaignPlayerName(currentTargetNominatorId, selectedCampaign.players)} nominates next
                            </span>
                          )}
                        </div>

                        {pendingTargetChallenge && (() => {
                          const target = selectedCampaign.strategicTargets.find(
                            (entry) => entry.id === pendingTargetChallenge.targetId,
                          );
                          return (
                            <div className="grid gap-2 border-l-2 border-cyan-400/70 bg-cyan-400/5 px-3 py-2">
                              <div className="text-sm font-semibold text-foreground">
                                Challenge for {target?.name ?? "Strategic Target"}
                              </div>
                              <div className="text-xs leading-5 text-muted-foreground">
                                {campaignPlayerName(pendingTargetChallenge.nominatorPlayerId, selectedCampaign.players)} nominated this neutral target.
                                {pendingTargetChallenge.currentChallengerPlayerId
                                  ? ` ${campaignPlayerName(pendingTargetChallenge.currentChallengerPlayerId, selectedCampaign.players)} must challenge or decline.`
                                  : " All challenges are resolved."}
                              </div>
                              {pendingTargetChallenge.currentChallengerPlayerId === myUserId && (
                                <div className="flex flex-wrap gap-2">
                                  <Button
                                    type="button"
                                    size="sm"
                                    className="gap-1 uppercase tracking-widest text-[10px]"
                                    disabled={respondToCampaignChallenge.isPending}
                                    onClick={() => respondToCampaignChallenge.mutate({
                                      nominationId: pendingTargetChallenge.id,
                                      challenge: true,
                                    })}
                                    data-testid="button-campaign-challenge-target"
                                  >
                                    <Swords className="h-3 w-3" /> Challenge
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="uppercase tracking-widest text-[10px]"
                                    disabled={respondToCampaignChallenge.isPending}
                                    onClick={() => respondToCampaignChallenge.mutate({
                                      nominationId: pendingTargetChallenge.id,
                                      challenge: false,
                                    })}
                                    data-testid="button-campaign-decline-target"
                                  >
                                    Decline
                                  </Button>
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {!pendingTargetChallenge && currentTargetNominatorId === myUserId && (
                          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                            <select
                              value={selectedTargetId}
                              onChange={(event) => setSelectedTargetId(event.target.value)}
                              className="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                              data-testid="select-campaign-strategic-target"
                            >
                              <option value="">Choose an uncontrolled or enemy target</option>
                              {eligibleStrategicTargets.map((target) => (
                                <option key={target.id} value={target.id}>
                                  {target.name} - {target.ownerPlayerId
                                    ? campaignPlayerName(target.ownerPlayerId, selectedCampaign.players)
                                    : "Neutral"}
                                </option>
                              ))}
                            </select>
                            <Button
                              type="button"
                              size="sm"
                              className="gap-1 uppercase tracking-widest text-[10px]"
                              disabled={!selectedTargetId || nominateCampaignTarget.isPending}
                              onClick={() => nominateCampaignTarget.mutate()}
                              data-testid="button-campaign-nominate-target"
                            >
                              <Target className="h-3 w-3" />
                              {nominateCampaignTarget.isPending ? "Nominating" : "Nominate"}
                            </Button>
                          </div>
                        )}

                        {campaignTurnState.targetNominations.length > 0 && (
                          <div className="divide-y divide-border/60 border-y border-border/70">
                            {campaignTurnState.targetNominations.map((nomination) => {
                              const target = selectedCampaign.strategicTargets.find((entry) => entry.id === nomination.targetId);
                              const defenderId = nomination.defenderPlayerId ?? nomination.challengerPlayerId;
                              return (
                                <div key={nomination.id} className="grid gap-1 py-2 sm:grid-cols-[1fr_auto] sm:items-center">
                                  <div className="text-xs text-foreground">
                                    {nomination.sequence}. {campaignPlayerName(nomination.nominatorPlayerId, selectedCampaign.players)} / {target?.name ?? "Target"}
                                  </div>
                                  <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                                    {nomination.status === "battle-ready" && defenderId
                                      ? `Battle vs ${campaignPlayerName(defenderId, selectedCampaign.players)}`
                                      : nomination.status.replaceAll("-", " ")}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {selectedCampaign.phase === "generate-scenarios" && (
                      <div className="grid gap-2 border-l-2 border-green-400/70 pl-3 text-xs leading-5 text-muted-foreground">
                        <span>Contested targets now resolve through secret Priority modifiers and the 2E scenario table.</span>
                        {generatedTurnBattles.length === 0 && (
                          <Button
                            type="button"
                            size="sm"
                            className="w-fit gap-1 uppercase tracking-widest text-[10px]"
                            disabled={prepareCampaignScenarios.isPending}
                            onClick={() => prepareCampaignScenarios.mutate()}
                            data-testid="button-campaign-prepare-scenarios"
                          >
                            <Dice5 className="h-3 w-3" />
                            {prepareCampaignScenarios.isPending ? "Preparing" : "Prepare Scenarios"}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {selectedCampaign.status === "active" && selectedCampaign.resolution
                  && (selectedCampaign.phase === "ship-experience" || selectedCampaign.phase === "repairs-reinforcements") && (
                  <div className="grid gap-4 border-y border-cyan-300/25 py-4" data-testid="campaign-resolution-panel">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-cyan-200">
                          {selectedCampaign.phase === "ship-experience" ? "Ship Experience" : "Repairs & Reinforcements"}
                        </div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {selectedCampaign.phase === "ship-experience"
                            ? "XP belongs to each surviving ship. Spend it now or save it for a later campaign turn."
                            : `Available Requisition: ${myRrBalance} RR. Unspent RR carries forward.`}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {selectedCampaign.resolution.playerStates.map((state) => (
                          <span key={state.playerId} className="border border-border/70 bg-background/35 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                            {campaignPlayerName(state.playerId, selectedCampaign.players)}: {selectedCampaign.phase === "ship-experience"
                              ? state.experienceComplete ? "ready" : "spending XP"
                              : state.repairsComplete ? "ready" : "allocating RR"}
                          </span>
                        ))}
                      </div>
                    </div>

                    {myResolutionLedger.length > 0 && (
                      <div className="grid gap-1 border-l-2 border-cyan-300/35 pl-3" aria-live="polite">
                        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                          Recent Resolution
                        </div>
                        {myResolutionLedger.map((entry) => (
                          <div key={entry.id} className="flex items-start justify-between gap-3 text-xs leading-5">
                            <span className="text-muted-foreground">{entry.message}</span>
                            <span className={entry.amount >= 0 ? "shrink-0 text-emerald-300" : "shrink-0 text-rose-300"}>
                              {entry.amount >= 0 ? "+" : ""}{entry.amount} {entry.resource === "rr" ? "RR" : "XP"}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {selectedCampaign.phase === "ship-experience" && (
                      <div className="grid gap-2">
                        {myCampaignRoster.filter((ship) => !ship.destroyed && !ship.capturedByPlayerId && ship.status !== "surrendered").map((ship) => {
                          const threshold = ship.shipModel?.damageThreshold ?? 0;
                          const crippled = threshold > 0 && ship.hullCurrent <= threshold;
                          return (
                            <div key={ship.id} className="grid gap-2 border-l-2 border-cyan-300/35 py-2 pl-3 sm:grid-cols-[1fr_auto] sm:items-center">
                              <div className="min-w-0">
                                <div className="truncate text-xs font-semibold text-foreground">{ship.name}</div>
                                <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                                  XP {ship.xpDice} / CQ {ship.crewQuality} / Hull {ship.hullCurrent}/{ship.hullMax}{crippled ? " / Crippled" : ""}
                                </div>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="uppercase tracking-widest text-[10px]"
                                  disabled={campaignResolutionAction.isPending || myResolutionState?.experienceComplete || ship.xpDice < 1 || ship.crewQuality >= 6 || ship.crewQualityAttemptedTurn === selectedCampaign.currentTurn}
                                  onClick={() => campaignResolutionAction.mutate({
                                    path: "/turns/current/experience/crew-quality",
                                    body: { shipInstanceId: ship.id },
                                  })}
                                  data-testid={`button-campaign-cq-${ship.id}`}
                                >
                                  Test CQ
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="uppercase tracking-widest text-[10px]"
                                  disabled={campaignResolutionAction.isPending || myResolutionState?.experienceComplete || ship.xpDice < 1 || ship.hullCurrent >= ship.hullMax || crippled}
                                  onClick={() => campaignResolutionAction.mutate({
                                    path: "/turns/current/experience/repair-hull",
                                    body: { shipInstanceId: ship.id, dice: 1 },
                                  })}
                                  data-testid={`button-campaign-xp-repair-${ship.id}`}
                                >
                                  1 XP Repair
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                        {!myResolutionState?.experienceComplete && (
                          <Button
                            type="button"
                            size="sm"
                            className="w-fit uppercase tracking-widest text-[10px]"
                            disabled={campaignResolutionAction.isPending}
                            onClick={() => campaignResolutionAction.mutate({ path: "/turns/current/experience/complete" })}
                            data-testid="button-campaign-complete-experience"
                          >
                            Save XP & Continue
                          </Button>
                        )}
                        {myResolutionState?.experienceComplete && (
                          <div className="text-xs text-muted-foreground">Your XP choices are locked. Waiting for the other commanders.</div>
                        )}
                      </div>
                    )}

                    {selectedCampaign.phase === "repairs-reinforcements" && (
                      <div className="grid gap-4">
                        <div className="grid gap-2">
                          {myCampaignRoster.filter((ship) =>
                            !ship.destroyed && !ship.capturedByPlayerId && ship.status !== "surrendered" && ship.status !== "high-command-repair"
                            && (ship.hullCurrent < ship.hullMax || ship.crewCurrent < ship.crewMax || ship.troopsCurrent < ship.troopsMax || ship.criticalEffects.length > 0)
                          ).map((ship) => (
                            <div key={ship.id} className="grid gap-2 border-l-2 border-amber-300/35 py-2 pl-3">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                  <div className="text-xs font-semibold text-foreground">{ship.name}</div>
                                  <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                                    Hull {ship.hullCurrent}/{ship.hullMax} / Crew {ship.crewCurrent}/{ship.crewMax} / Troops {ship.troopsCurrent}/{ship.troopsMax} / Crits {ship.criticalEffects.length}
                                  </div>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  {ship.hullCurrent < ship.hullMax && (
                                    <Button type="button" size="sm" variant="outline" className="uppercase tracking-widest text-[10px]" disabled={campaignResolutionAction.isPending || myResolutionState?.repairsComplete} onClick={() => campaignResolutionAction.mutate({ path: "/turns/current/repairs/hull", body: { shipInstanceId: ship.id } })}>Repair Hull</Button>
                                  )}
                                  {ship.crewCurrent < ship.crewMax && (
                                    <Button type="button" size="sm" variant="outline" className="uppercase tracking-widest text-[10px]" disabled={campaignResolutionAction.isPending || myResolutionState?.repairsComplete} onClick={() => campaignResolutionAction.mutate({ path: "/turns/current/repairs/recruit", body: { shipInstanceId: ship.id, track: "crew" } })}>Recruit Crew</Button>
                                  )}
                                  {ship.troopsCurrent < ship.troopsMax && (
                                    <Button type="button" size="sm" variant="outline" className="uppercase tracking-widest text-[10px]" disabled={campaignResolutionAction.isPending || myResolutionState?.repairsComplete} onClick={() => campaignResolutionAction.mutate({ path: "/turns/current/repairs/recruit", body: { shipInstanceId: ship.id, track: "troops" } })}>Recruit Troops</Button>
                                  )}
                                  <Button type="button" size="sm" variant="outline" className="uppercase tracking-widest text-[10px]" disabled={campaignResolutionAction.isPending || myResolutionState?.repairsComplete} onClick={() => campaignResolutionAction.mutate({ path: "/turns/current/repairs/high-command", body: { shipInstanceId: ship.id } })}>High Command</Button>
                                </div>
                              </div>
                              {ship.criticalEffects.length > 0 && (
                                <div className="flex flex-wrap gap-2">
                                  {ship.criticalEffects.map((critical, index) => (
                                    <Button
                                      key={`${ship.id}-critical-${index}`}
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      className="uppercase tracking-widest text-[10px]"
                                      disabled={campaignResolutionAction.isPending || myResolutionState?.repairsComplete}
                                      onClick={() => campaignResolutionAction.mutate({ path: "/turns/current/repairs/critical", body: { shipInstanceId: ship.id, criticalIndex: index } })}
                                    >
                                      Repair {String(critical.name ?? `Critical ${index + 1}`)}
                                    </Button>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>

                        <div className="grid gap-2 border-t border-border/70 pt-3">
                          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Reinforcements</div>
                          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                            <select
                              value={reinforcementModelId}
                              onChange={(event) => setReinforcementModelId(event.target.value)}
                              className="h-10 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                              disabled={myResolutionState?.repairsComplete}
                              data-testid="select-campaign-reinforcement"
                            >
                              <option value="">Choose reinforcement</option>
                              {reinforcementModels.map((model) => (
                                <option key={model.id} value={model.id}>{model.name} / {model.faction} / {campaignReinforcementRr(model)} RR</option>
                              ))}
                            </select>
                            <Button
                              type="button"
                              size="sm"
                              className="uppercase tracking-widest text-[10px]"
                              disabled={campaignResolutionAction.isPending || myResolutionState?.repairsComplete || !reinforcementModelId}
                              onClick={() => campaignResolutionAction.mutate({
                                path: "/turns/current/reinforcements",
                                body: { shipModelId: Number(reinforcementModelId) },
                              })}
                              data-testid="button-campaign-buy-reinforcement"
                            >
                              Acquire
                            </Button>
                          </div>
                        </div>

                        {!myResolutionState?.repairsComplete ? (
                          <Button
                            type="button"
                            size="sm"
                            className="w-fit uppercase tracking-widest text-[10px]"
                            disabled={campaignResolutionAction.isPending}
                            onClick={() => campaignResolutionAction.mutate({ path: "/turns/current/repairs/complete" })}
                            data-testid="button-campaign-complete-repairs"
                          >
                            Save RR & End Turn
                          </Button>
                        ) : (
                          <div className="text-xs text-muted-foreground">Your requisition choices are locked. Waiting for the other commanders.</div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {error && (
                  <div className="rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
                    {error}
                  </div>
                )}

                <div className="grid gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-primary">Roster</div>
                    <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                      {selectedCampaign.roster.length} ship{selectedCampaign.roster.length === 1 ? "" : "s"}
                    </span>
                  </div>

                  {canEditRoster && (
                    <form
                      className="grid gap-2 rounded border border-border/70 bg-background/35 p-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!canAddRosterShip) {
                          setError("Choose a ship to add to the roster.");
                          return;
                        }
                        addRosterShip.mutate();
                      }}
                    >
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Select
                          value={rosterFactionFilter}
                          onValueChange={(value) => {
                            setRosterFactionFilter(value);
                            setSelectedShipModelId("");
                          }}
                        >
                          <SelectTrigger data-testid="select-campaign-roster-faction" className="bg-background">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="border-border bg-card">
                            <SelectItem value="__all__">All factions</SelectItem>
                            {rosterFactions.map((rosterFaction) => (
                              <SelectItem key={rosterFaction} value={rosterFaction}>
                                {rosterFaction}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <select
                          value={selectedShipModelId}
                          onChange={(event) => setSelectedShipModelId(event.target.value)}
                          className="h-10 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                          data-testid="select-campaign-roster-ship"
                        >
                          <option value="">Choose ship model</option>
                          {filteredRosterShipModels.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.name} - {modelLine(model)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                        <Input
                          value={shipName}
                          onChange={(event) => setShipName(event.target.value)}
                          placeholder={selectedShipModel ? `Name (${selectedShipModel.name})` : "Optional ship name"}
                          maxLength={80}
                          className="bg-background"
                          data-testid="input-campaign-ship-name"
                        />
                        <Button
                          type="submit"
                          disabled={!canAddRosterShip}
                          className="gap-2 uppercase tracking-widest text-xs"
                          data-testid="button-campaign-add-roster-ship"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          {addRosterShip.isPending ? "Adding" : "Add"}
                        </Button>
                      </div>
                    </form>
                  )}

                  {selectedCampaign.roster.length === 0 ? (
                    <div className="rounded border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
                      No persistent campaign ships yet.
                    </div>
                  ) : (
                    <div className="grid gap-2">
                      {selectedCampaign.roster.map((ship) => (
                        <div key={ship.id} className="rounded border border-border/70 bg-background/35 px-3 py-2">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-foreground">{ship.name}</div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                {ship.shipModel?.name ?? "Unknown model"} / {modelLine(ship.shipModel)}
                              </div>
                              <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                                <span>Owner {rosterOwnerName(ship, selectedCampaign.players)}</span>
                                <span>Hull {ship.hullCurrent}/{ship.hullMax}</span>
                                <span>Crew {ship.crewCurrent}/{ship.crewMax}</span>
                                <span>Troops {ship.troopsCurrent}/{ship.troopsMax}</span>
                                <span>
                                  CQ {Number.isInteger(ship.crewQualityRoll) ? `${ship.crewQuality} (roll ${ship.crewQualityRoll})` : "pending"}
                                </span>
                                <span>XP {ship.xpDice}</span>
                              </div>
                            </div>
                            {canEditRoster && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="gap-1 uppercase tracking-widest text-[10px]"
                                disabled={removeRosterShip.isPending}
                                onClick={() => removeRosterShip.mutate({
                                  campaignId: selectedCampaign.id,
                                  shipInstanceId: ship.id,
                                })}
                                data-testid={`button-campaign-remove-roster-ship-${ship.id}`}
                              >
                                <Trash2 className="h-3 w-3" />
                                Remove
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {selectedCampaign.strategicTargets.length > 0 && (
                  <div className="grid gap-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-primary">
                        <Target className="h-3.5 w-3.5" />
                        Strategic System
                      </div>
                      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                        {selectedCampaign.strategicTargets.length - 1} targets + Trade Route
                      </span>
                    </div>
                    <div className="divide-y divide-border/60 border-y border-border/70">
                      {selectedCampaign.strategicTargets.map((target) => (
                        <div key={target.id} className="grid gap-1 py-2 sm:grid-cols-[1fr_auto] sm:items-center">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-foreground">{target.name}</div>
                            <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                              {target.category.replaceAll("-", " ")} / {target.ownerPlayerId ? campaignPlayerName(target.ownerPlayerId, selectedCampaign.players) : "Neutral"}
                              {!target.explored ? " / unexplored" : ""}
                            </div>
                            {target.unusualFeatures.length > 0 && (
                              <div className="mt-1 text-[11px] text-cyan-200">
                                {target.unusualFeatures.map((feature) => feature.name ?? feature.key).join(", ")}
                              </div>
                            )}
                          </div>
                          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber-200">
                            {target.rrFormula ?? target.rrValue} RR
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-primary">Campaign Engagements</div>
                    <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                      {selectedCampaign.battles.length} battle{selectedCampaign.battles.length === 1 ? "" : "s"}
                    </span>
                  </div>

                  {selectedCampaign.status !== "active" && (
                    <div className="border-l-2 border-amber-400/60 pl-3 text-xs leading-5 text-muted-foreground">
                      Finish campaign setup and start Turn 1 before creating engagements.
                    </div>
                  )}

                  <form
                    className={`${selectedCampaign.phase === "manual-engagement" ? "grid" : "hidden"} gap-3 rounded border border-border/70 bg-background/35 p-3`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!canCreateBattle) {
                        setError("Choose two commanders and at least one roster ship for each side.");
                        return;
                      }
                      createCampaignBattle.mutate();
                    }}
                  >
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-200">
                      Locked Battle Conditions
                    </div>
                    <Input
                      value={battleName}
                      onChange={(event) => setBattleName(event.target.value)}
                      placeholder="Optional battle name"
                      maxLength={80}
                      className="bg-background"
                      data-testid="input-campaign-battle-name"
                    />
                    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_110px]">
                      <select
                        value={battleScenarioKey}
                        onChange={(event) => {
                          const scenarioKey = event.target.value;
                          setBattleScenarioKey(scenarioKey);
                          if (scenarioKey === "ambush") setBattleDeploymentPreset("ambush-center");
                        }}
                        className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                        aria-label="Campaign scenario"
                        data-testid="select-campaign-battle-scenario"
                      >
                        {CAMPAIGN_SCENARIOS.map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                      <select
                        value={battlePriorityLevel}
                        onChange={(event) => setBattlePriorityLevel(event.target.value)}
                        className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                        aria-label="Campaign battle priority"
                        data-testid="select-campaign-battle-priority"
                      >
                        {["patrol", "skirmish", "raid", "battle", "war"].map((level) => (
                          <option key={level} value={level}>
                            {priorityLabel(normalizePriorityLevel(level))}
                          </option>
                        ))}
                      </select>
                      <Input
                        type="number"
                        min={1}
                        max={99}
                        value={battleAllocationPoints}
                        onChange={(event) =>
                          setBattleAllocationPoints(Math.max(1, Math.min(99, Number(event.target.value) || 1)))
                        }
                        aria-label="Campaign battle fleet allocation points"
                        className="bg-background"
                        data-testid="input-campaign-battle-fap"
                      />
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <select
                        value={battleAttackerId}
                        onChange={(event) => {
                          setBattleAttackerId(event.target.value);
                          setSelectedBattleShipIds(new Set());
                        }}
                        className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                        data-testid="select-campaign-battle-attacker"
                      >
                        <option value="">Attacker</option>
                        {selectedCampaign.players.map((player) => (
                          <option key={player.playerId} value={player.playerId}>
                            {player.displayName ?? player.playerId}
                          </option>
                        ))}
                      </select>
                      <select
                        value={battleDefenderId}
                        onChange={(event) => {
                          setBattleDefenderId(event.target.value);
                          setSelectedBattleShipIds(new Set());
                        }}
                        className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                        data-testid="select-campaign-battle-defender"
                      >
                        <option value="">Defender</option>
                        {selectedCampaign.players.map((player) => (
                          <option key={player.playerId} value={player.playerId}>
                            {player.displayName ?? player.playerId}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <select
                        value={battleDeploymentPreset}
                        onChange={(event) => setBattleDeploymentPreset(event.target.value)}
                        className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                        aria-label="Campaign deployment"
                        data-testid="select-campaign-battle-deployment"
                      >
                        <option value="standard-short-edge">Standard short edges</option>
                        <option value="standard-long-edge">Long edges</option>
                        <option value="ambush-center">Ambush center</option>
                      </select>
                      {battleDeploymentPreset === "ambush-center" ? (
                        <select
                          value={battleAmbushCenterSide}
                          onChange={(event) => setBattleAmbushCenterSide(event.target.value as "attacker" | "defender")}
                          className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                          aria-label="Commander deployed in ambush center"
                          data-testid="select-campaign-ambush-center-side"
                        >
                          <option value="defender">Defender in center</option>
                          <option value="attacker">Attacker in center</option>
                        </select>
                      ) : (
                        <Input
                          type="number"
                          min={4}
                          max={30}
                          value={battleDeploymentDepth}
                          onChange={(event) => setBattleDeploymentDepth(Math.max(4, Math.min(30, Number(event.target.value) || 12)))}
                          aria-label="Deployment depth in inches"
                          className="bg-background"
                          data-testid="input-campaign-deployment-depth"
                        />
                      )}
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      <select
                        value={battleTerrain}
                        onChange={(event) => setBattleTerrain(event.target.value)}
                        className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                        aria-label="Campaign terrain"
                        data-testid="select-campaign-battle-terrain"
                      >
                        <option value="none">No terrain</option>
                        <option value="asteroid-fields">Asteroid fields</option>
                        <option value="gas-clouds">Gas clouds</option>
                        <option value="mixed-terrain">Mixed terrain</option>
                      </select>
                      <select
                        value={String(battleTerrainCount)}
                        onChange={(event) => setBattleTerrainCount(Number(event.target.value))}
                        disabled={battleTerrain === "none"}
                        className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground disabled:opacity-50"
                        aria-label="Campaign terrain count"
                        data-testid="select-campaign-battle-terrain-count"
                      >
                        {[3, 6, 9].map((count) => <option key={count} value={count}>{count} terrain</option>)}
                      </select>
                      <select
                        value={battleStations}
                        onChange={(event) => setBattleStations(event.target.value)}
                        className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                        aria-label="Campaign stations"
                        data-testid="select-campaign-battle-stations"
                      >
                        <option value="none">No stations</option>
                        <option value="enabled">Stations enabled</option>
                      </select>
                      <select
                        value={battleSkybox}
                        onChange={(event) => setBattleSkybox(event.target.value)}
                        className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                        aria-label="Campaign skybox"
                        data-testid="select-campaign-battle-skybox"
                      >
                        {CAMPAIGN_SKYBOXES.map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    </div>
                    <Textarea
                      value={battleSpecialConditions}
                      onChange={(event) => setBattleSpecialConditions(event.target.value)}
                      maxLength={1200}
                      rows={3}
                      placeholder="Campaign or scenario conditions, one per line"
                      className="resize-y bg-background"
                      data-testid="input-campaign-special-conditions"
                    />
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-200">
                      Assigned Campaign Forces
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded border border-border/70 bg-card/35 p-2">
                        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200">
                          Attacker ships ({attackerSelectedCount})
                        </div>
                        <div className="grid max-h-44 gap-1 overflow-y-auto pr-1">
                          {battleAttackerRoster.length === 0 ? (
                            <div className="text-xs text-muted-foreground">No available ships.</div>
                          ) : battleAttackerRoster.map((ship) => (
                            <label key={ship.id} className="flex cursor-pointer items-start gap-2 rounded border border-border/50 bg-background/35 px-2 py-1 text-xs">
                              <input
                                type="checkbox"
                                checked={selectedBattleShipIds.has(ship.id)}
                                onChange={() => toggleBattleShip(ship.id)}
                                className="mt-0.5"
                              />
                              <span className="min-w-0">
                                <span className="block truncate font-semibold text-foreground">{ship.name}</span>
                                <span className="block truncate text-muted-foreground">{ship.shipModel?.name ?? "Unknown model"}</span>
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                      <div className="rounded border border-border/70 bg-card/35 p-2">
                        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-200">
                          Defender ships ({defenderSelectedCount})
                        </div>
                        <div className="grid max-h-44 gap-1 overflow-y-auto pr-1">
                          {battleDefenderRoster.length === 0 ? (
                            <div className="text-xs text-muted-foreground">No available ships.</div>
                          ) : battleDefenderRoster.map((ship) => (
                            <label key={ship.id} className="flex cursor-pointer items-start gap-2 rounded border border-border/50 bg-background/35 px-2 py-1 text-xs">
                              <input
                                type="checkbox"
                                checked={selectedBattleShipIds.has(ship.id)}
                                onChange={() => toggleBattleShip(ship.id)}
                                className="mt-0.5"
                              />
                              <span className="min-w-0">
                                <span className="block truncate font-semibold text-foreground">{ship.name}</span>
                                <span className="block truncate text-muted-foreground">{ship.shipModel?.name ?? "Unknown model"}</span>
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>
                    <Button
                      type="submit"
                      disabled={!canCreateBattle}
                      className="gap-2 uppercase tracking-widest text-xs"
                      data-testid="button-campaign-create-battle"
                    >
                      <Swords className="h-3.5 w-3.5" />
                      {createCampaignBattle.isPending ? "Creating Engagement" : "Create Campaign Engagement"}
                    </Button>
                  </form>

                  {selectedCampaign.battles.length === 0 ? (
                    <div className="rounded border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
                      No campaign engagements yet.
                    </div>
                  ) : (
                    <div className="grid gap-2">
                      {selectedCampaign.battles.map((battle) => {
                        const canImportBattle =
                          selectedCampaign.ownerPlayerId === myUserId &&
                          battle.tacticalGameStatus === "completed" &&
                          battle.status !== "imported" &&
                          !importCampaignBattle.isPending;
                        return (
                          <div key={battle.id} className="rounded border border-border/70 bg-background/35 px-3 py-2">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold text-foreground">
                                  {battle.name ?? `Battle ${battle.id}`}
                                </div>
                                <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                                  Turn {battle.turnNumber} / {battle.rulesSnapshot?.scenario?.label ?? battle.scenarioKey} / {priorityLabel(normalizePriorityLevel(battle.priorityLevel))} / {battle.status.replaceAll("-", " ")} {battle.tacticalGameId ? `/ Game ${battle.tacticalGameId}` : ""}
                                </div>
                                <div className="mt-2 text-xs text-muted-foreground">
                                  {campaignPlayerName(battle.attackerPlayerId, selectedCampaign.players)} vs {campaignPlayerName(battle.defenderPlayerId, selectedCampaign.players)}
                                  {battle.tacticalWinnerId
                                    ? ` / Winner ${campaignPlayerName(battle.tacticalWinnerId, selectedCampaign.players)}`
                                    : ""}
                                </div>
                                {battle.status === "awaiting-priority-modifiers" && (
                                  <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-amber-200">
                                    Modifiers: attacker {battle.priorityModifiers.attackerSubmitted ? "committed" : "waiting"} / defender {battle.priorityModifiers.defenderSubmitted ? "committed" : "waiting"}
                                  </div>
                                )}
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {battle.status === "imported" && (
                                  <span className="rounded border border-green-400/45 bg-green-400/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-green-200">
                                    Imported
                                  </span>
                                )}
                                {battle.tacticalGameStatus === "completed" && battle.status !== "imported" && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="gap-1 uppercase tracking-widest text-[10px]"
                                    disabled={!canImportBattle}
                                    onClick={() => importCampaignBattle.mutate(battle)}
                                    data-testid={`button-campaign-import-battle-${battle.id}`}
                                  >
                                    Import
                                  </Button>
                                )}
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="gap-1 uppercase tracking-widest text-[10px]"
                                  onClick={() => openCampaignBattle(battle)}
                                  data-testid={`button-campaign-open-battle-${battle.id}`}
                                >
                                  <ArrowRight className="h-3 w-3" />
                                  Briefing
                                </Button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="grid gap-2">
                  <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-primary">Recent Log</div>
                  {selectedCampaign.recentLog.length === 0 ? (
                    <div className="rounded border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
                      No campaign log entries yet.
                    </div>
                  ) : (
                    <div className="grid gap-2">
                      {selectedCampaign.recentLog.map((entry) => (
                        <div key={entry.id} className="rounded border border-border/70 bg-background/35 px-3 py-2">
                          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                            Turn {entry.turnNumber} / {campaignTime(entry.createdAt)}
                          </div>
                          <div className="mt-1 text-sm leading-6 text-muted-foreground">{entry.message}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </aside>
        </section>
      </div>
    </Layout>
  );
}
