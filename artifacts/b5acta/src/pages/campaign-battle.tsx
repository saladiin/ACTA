import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import { ArrowLeft, ArrowRight, Crosshair, Dice5, MapPin, Shield, Swords } from "lucide-react";
import { useLocation, useParams } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import {
  campaignDeploymentLabel,
  campaignScenarioLabel,
  campaignSkyboxLabel,
  campaignTerrainLabel,
  type CampaignRulesSnapshot,
} from "@/lib/campaign-engagement";
import { useDevUserId } from "@/lib/dev-user";
import {
  calculateAllocation,
  formatAllocationTicks,
  priorityLabel,
  normalizePriorityLevel,
} from "@/lib/fleet-allocation";
import { writeStoredFleetSelection, type StoredFleetSelectionEntry } from "@/lib/fleet-selection-storage";
import {
  getTemporaryUserId,
  temporaryUsernameAuthEnabled,
  useTemporaryUsername,
} from "@/lib/temporary-user";

type BriefingPlayer = {
  playerId: string;
  displayName: string | null;
};

type BriefingShip = {
  id: number;
  ownerPlayerId: string;
  sourceShipModelId: number;
  name: string;
  hullCurrent: number;
  hullMax: number;
  crewCurrent: number;
  crewMax: number;
  troopsCurrent: number;
  troopsMax: number;
  crewQuality: number;
  status: string;
  unavailableUntilTurn: number;
  usedTurn: number;
  destroyed: boolean;
  capturedByPlayerId: string | null;
  shipModel: {
    name: string;
    faction: string;
    priorityLevel: string;
  } | null;
};

type BriefingAssignment = {
  id: number;
  side: "attacker" | "defender";
  rosterShip: BriefingShip | null;
};

type BriefingBattle = {
  id: number;
  name: string | null;
  turnNumber: number;
  attackerPlayerId: string;
  defenderPlayerId: string;
  tacticalGameId: number | null;
  tacticalGameStatus: string | null;
  scenarioKey: string;
  priorityLevel: string;
  status: string;
  rulesSnapshot: CampaignRulesSnapshot;
  assignments: BriefingAssignment[];
  priorityModifiers: {
    attackerSubmitted: boolean;
    defenderSubmitted: boolean;
    myModifier: number | null;
    revealed: { attacker: number; defender: number } | null;
  };
};

type BriefingResponse = {
  campaign: {
    id: number;
    name: string;
    currentTurn: number;
    players: BriefingPlayer[];
    roster: BriefingShip[];
    battles: BriefingBattle[];
  };
};

type CampaignMutationResponse = BriefingResponse;

function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return fallback;
}

function commanderName(playerId: string, players: BriefingPlayer[]): string {
  return players.find((player) => player.playerId === playerId)?.displayName ?? playerId;
}

function forceEntries(assignments: BriefingAssignment[]): StoredFleetSelectionEntry[] {
  const byModel = new Map<number, StoredFleetSelectionEntry>();
  for (const assignment of assignments) {
    const ship = assignment.rosterShip;
    if (!ship) continue;
    const entry = byModel.get(ship.sourceShipModelId) ?? {
      shipModelId: ship.sourceShipModelId,
      count: 0,
      campaignShips: [],
    };
    entry.count += 1;
    entry.campaignShips ??= [];
    entry.campaignShips.push({
      campaignShipInstanceId: ship.id,
      name: ship.name,
      crewQuality: ship.crewQuality,
    });
    byModel.set(ship.sourceShipModelId, entry);
  }
  return Array.from(byModel.values());
}

function ForceList({
  label,
  commander,
  assignments,
  accent,
}: {
  label: string;
  commander: string;
  assignments: BriefingAssignment[];
  accent: string;
}) {
  return (
    <section className="min-w-0 border-t border-border/80 pt-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <div className={`font-mono text-[10px] uppercase tracking-[0.2em] ${accent}`}>{label}</div>
          <h2 className="mt-1 truncate text-base font-semibold text-foreground" title={commander}>{commander}</h2>
        </div>
        <span className="font-mono text-xs text-muted-foreground">{assignments.length} units</span>
      </div>
      <div className="divide-y divide-border/60 border-y border-border/60">
        {assignments.length === 0 && (
          <div className="px-1 py-4 text-sm text-muted-foreground">Awaiting fleet commitment.</div>
        )}
        {assignments.map((assignment) => {
          const ship = assignment.rosterShip;
          if (!ship) return null;
          return (
            <div key={assignment.id} className="grid gap-1 px-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-foreground" title={ship.name}>{ship.name}</div>
                <div className="truncate text-xs text-muted-foreground" title={ship.shipModel?.name ?? "Unknown model"}>
                  {ship.shipModel?.name ?? "Unknown model"} / {ship.shipModel?.faction ?? "Unknown faction"}
                </div>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                <span>Hull {ship.hullCurrent}/{ship.hullMax}</span>
                <span>Crew {ship.crewCurrent}/{ship.crewMax}</span>
                <span>Troops {ship.troopsCurrent}/{ship.troopsMax}</span>
                <span>CQ {ship.crewQuality}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function CampaignBattle() {
  const params = useParams<{ campaignId: string; battleId: string }>();
  const campaignId = Number(params.campaignId);
  const battleId = Number(params.battleId);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const devUserId = useDevUserId();
  useTemporaryUsername();
  const { user } = useUser();
  const myUserId =
    (temporaryUsernameAuthEnabled
      ? getTemporaryUserId()
      : import.meta.env.DEV
        ? devUserId
        : user?.id) ?? "";
  const [priorityModifier, setPriorityModifier] = useState(0);
  const [selectedShipIds, setSelectedShipIds] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  const briefingQuery = useQuery({
    queryKey: ["campaign", campaignId],
    queryFn: () => customFetch<BriefingResponse>(`/api/campaigns/${campaignId}`, { responseType: "json" }),
    enabled: Number.isInteger(campaignId) && campaignId > 0,
    refetchInterval: 4000,
  });
  const campaign = briefingQuery.data?.campaign ?? null;
  const battle = campaign?.battles.find((candidate) => candidate.id === battleId) ?? null;
  const myAssignments = useMemo(
    () => battle?.assignments.filter((assignment) => assignment.rosterShip?.ownerPlayerId === myUserId) ?? [],
    [battle, myUserId],
  );

  const refreshBriefing = async (response: CampaignMutationResponse) => {
    queryClient.setQueryData(["campaign", campaignId], response);
    await queryClient.invalidateQueries({ queryKey: ["campaign", campaignId] });
  };

  const submitPriorityModifier = useMutation({
    mutationFn: () => customFetch<CampaignMutationResponse>(
      `/api/campaigns/${campaignId}/battles/${battleId}/priority-modifier`,
      {
        method: "POST",
        responseType: "json",
        body: JSON.stringify({ modifier: priorityModifier }),
      },
    ),
    onMutate: () => setError(null),
    onSuccess: refreshBriefing,
    onError: (err) => setError(apiErrorMessage(err, "Priority modifier submission failed")),
  });

  const chooseScenario = useMutation({
    mutationFn: (scenarioKey: "supply-ships" | "planetary-assault") => customFetch<CampaignMutationResponse>(
      `/api/campaigns/${campaignId}/battles/${battleId}/scenario-choice`,
      {
        method: "POST",
        responseType: "json",
        body: JSON.stringify({ scenarioKey }),
      },
    ),
    onMutate: () => setError(null),
    onSuccess: refreshBriefing,
    onError: (err) => setError(apiErrorMessage(err, "Scenario choice failed")),
  });

  const assignFleet = useMutation({
    mutationFn: () => customFetch<CampaignMutationResponse>(
      `/api/campaigns/${campaignId}/battles/${battleId}/assign-fleet`,
      {
        method: "POST",
        responseType: "json",
        body: JSON.stringify({ shipInstanceIds: Array.from(selectedShipIds) }),
      },
    ),
    onMutate: () => setError(null),
    onSuccess: async (response) => {
      setSelectedShipIds(new Set());
      await refreshBriefing(response);
    },
    onError: (err) => setError(apiErrorMessage(err, "Fleet assignment failed")),
  });

  if (briefingQuery.isLoading) {
    return <Layout title="Campaign Briefing"><div className="p-6 font-mono text-sm text-muted-foreground">Loading briefing...</div></Layout>;
  }

  if (!campaign || !battle) {
    return (
      <Layout title="Campaign Briefing">
        <div className="mx-auto max-w-3xl p-6">
          <p className="font-mono text-sm text-red-300">Campaign engagement not found.</p>
          <Button className="mt-4 gap-2" variant="outline" onClick={() => setLocation("/campaign")}>
            <ArrowLeft className="h-4 w-4" /> Campaign
          </Button>
        </div>
      </Layout>
    );
  }

  const snapshot = battle.rulesSnapshot ?? {};
  const scenarioLabel = snapshot.scenario?.label ?? campaignScenarioLabel(battle.scenarioKey);
  const priority = snapshot.priorityLevel ?? battle.priorityLevel;
  const allocationPoints = snapshot.allocationPoints ?? 5;
  const attackerAssignments = battle.assignments.filter((assignment) => assignment.side === "attacker");
  const defenderAssignments = battle.assignments.filter((assignment) => assignment.side === "defender");
  const mySide = myUserId === battle.attackerPlayerId
    ? "attacker"
    : myUserId === battle.defenderPlayerId
      ? "defender"
      : null;
  const myAllocationPoints = mySide
    ? Number(snapshot.sideAllocationPoints?.[mySide] ?? allocationPoints)
    : allocationPoints;
  const availableRoster = campaign.roster.filter((ship) => (
    ship.ownerPlayerId === myUserId
    && ship.status === "active"
    && !ship.destroyed
    && !ship.capturedByPlayerId
    && ship.unavailableUntilTurn <= battle.turnNumber
    && ship.usedTurn !== battle.turnNumber
    && ship.shipModel
  ));
  const selectedShips = availableRoster.filter((ship) => selectedShipIds.has(ship.id));
  const selectedAllocation = calculateAllocation(
    selectedShips.map((ship) => normalizePriorityLevel(ship.shipModel?.priorityLevel)),
    normalizePriorityLevel(priority),
    myAllocationPoints,
  );
  const canSubmitModifier = Boolean(
    mySide
    && battle.status === "awaiting-priority-modifiers"
    && battle.priorityModifiers.myModifier === null
    && !submitPriorityModifier.isPending,
  );
  const canAssignFleet = Boolean(
    mySide
    && battle.status === "awaiting-fleet-assignments"
    && myAssignments.length === 0
    && selectedShips.length > 0
    && selectedAllocation.legal
    && !assignFleet.isPending,
  );
  const canEnter = Boolean(battle.tacticalGameId && myAssignments.length > 0);
  const enterLabel = battle.tacticalGameStatus === "completed"
    ? "Review Engagement"
    : battle.tacticalGameStatus === "deploying"
      ? "Enter Deployment"
      : "Resume Engagement";

  const enterEngagement = () => {
    if (!battle.tacticalGameId || !myUserId || myAssignments.length === 0) return;
    writeStoredFleetSelection({
      gameId: battle.tacticalGameId,
      ownerId: myUserId,
      entries: forceEntries(myAssignments),
      updatedAt: Date.now(),
    });
    setLocation(`/games/${battle.tacticalGameId}`);
  };

  const toggleShip = (shipId: number) => {
    setSelectedShipIds((current) => {
      const next = new Set(current);
      if (next.has(shipId)) next.delete(shipId);
      else next.add(shipId);
      return next;
    });
  };

  return (
    <Layout title="Campaign Briefing">
      <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
          <div className="min-w-0">
            <button
              type="button"
              onClick={() => setLocation(`/campaign?campaign=${campaign.id}`)}
              className="mb-3 inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-primary"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> {campaign.name}
            </button>
            <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-primary">Campaign Engagement / Turn {battle.turnNumber}</div>
            <h1 className="mt-2 text-2xl font-bold text-foreground">{battle.name ?? `Battle ${battle.id}`}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {commanderName(battle.attackerPlayerId, campaign.players)} vs {commanderName(battle.defenderPlayerId, campaign.players)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="rounded border border-primary/40 bg-primary/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-primary">{scenarioLabel}</span>
            <span className="rounded border border-border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              {priorityLabel(normalizePriorityLevel(priority))} / A {snapshot.sideAllocationPoints?.attacker ?? allocationPoints} FAP / D {snapshot.sideAllocationPoints?.defender ?? allocationPoints} FAP
            </span>
          </div>
        </div>

        {error && (
          <div className="border-b border-red-400/40 bg-red-400/5 px-3 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {battle.status === "awaiting-priority-modifiers" && (
          <section className="grid gap-4 border-b border-border py-5 sm:grid-cols-[1fr_auto] sm:items-end">
            <div>
              <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-amber-200">
                <Dice5 className="h-3.5 w-3.5" /> Secret Priority Modifier
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Attacker {battle.priorityModifiers.attackerSubmitted ? "committed" : "waiting"} / defender {battle.priorityModifiers.defenderSubmitted ? "committed" : "waiting"}
              </p>
              {battle.priorityModifiers.myModifier !== null && (
                <p className="mt-1 font-mono text-xs text-foreground">
                  Your committed modifier: {battle.priorityModifiers.myModifier >= 0 ? "+" : ""}{battle.priorityModifiers.myModifier}
                </p>
              )}
            </div>
            {mySide && battle.priorityModifiers.myModifier === null && (
              <div className="flex items-center gap-2">
                <select
                  value={priorityModifier}
                  onChange={(event) => setPriorityModifier(Number(event.target.value))}
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  aria-label="Secret campaign Priority modifier"
                  data-testid="select-campaign-priority-modifier"
                >
                  {[-3, -2, -1, 0, 1, 2, 3].map((modifier) => (
                    <option key={modifier} value={modifier}>{modifier >= 0 ? "+" : ""}{modifier}</option>
                  ))}
                </select>
                <Button
                  type="button"
                  disabled={!canSubmitModifier}
                  onClick={() => submitPriorityModifier.mutate()}
                  className="uppercase tracking-widest text-xs"
                  data-testid="button-campaign-submit-priority-modifier"
                >
                  Commit
                </Button>
              </div>
            )}
          </section>
        )}

        {battle.priorityModifiers.revealed && snapshot.generation?.priorityRoll && (
          <section className="grid gap-2 border-b border-border py-4 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground sm:grid-cols-2">
            <span>
              Priority roll {snapshot.generation.priorityRoll.dice?.join(" + ")} / modifiers {battle.priorityModifiers.revealed.attacker >= 0 ? "+" : ""}{battle.priorityModifiers.revealed.attacker} and {battle.priorityModifiers.revealed.defender >= 0 ? "+" : ""}{battle.priorityModifiers.revealed.defender}
            </span>
            <span className="sm:text-right">
              Final {snapshot.generation.priorityRoll.finalTotal} / {priorityLabel(normalizePriorityLevel(priority))}
            </span>
          </section>
        )}

        {battle.status === "awaiting-scenario-choice" && (
          <section className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-5">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-200">Attacker Scenario Choice</div>
              <p className="mt-2 text-sm text-muted-foreground">This target permits Supply Ships or Planetary Assault.</p>
            </div>
            {mySide === "attacker" ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={chooseScenario.isPending}
                  onClick={() => chooseScenario.mutate("supply-ships")}
                >
                  Supply Ships
                </Button>
                <Button
                  type="button"
                  disabled={chooseScenario.isPending}
                  onClick={() => chooseScenario.mutate("planetary-assault")}
                >
                  Planetary Assault
                </Button>
              </div>
            ) : (
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Awaiting attacker</span>
            )}
          </section>
        )}

        {battle.status === "awaiting-fleet-assignments" && mySide && myAssignments.length === 0 && (
          <section className="grid gap-4 border-b border-border py-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-200">Commit {mySide} Fleet</div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {priorityLabel(normalizePriorityLevel(priority))} Priority / maximum {myAllocationPoints} FAP
                </p>
              </div>
              <div className={`font-mono text-xs ${selectedAllocation.legal ? "text-foreground" : "text-red-300"}`}>
                {formatAllocationTicks(selectedAllocation.spentTicks)} / {formatAllocationTicks(selectedAllocation.budgetTicks)}
              </div>
            </div>
            <div className="grid max-h-72 gap-1 overflow-y-auto border-y border-border/70 py-2">
              {availableRoster.length === 0 ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">No unused campaign ships are available.</div>
              ) : availableRoster.map((ship) => (
                <label key={ship.id} className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-2 py-2 hover:bg-muted/20">
                  <input
                    type="checkbox"
                    checked={selectedShipIds.has(ship.id)}
                    onChange={() => toggleShip(ship.id)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-foreground" title={ship.name}>{ship.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{ship.shipModel?.name ?? "Unknown model"}</span>
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    {priorityLabel(normalizePriorityLevel(ship.shipModel?.priorityLevel))}
                  </span>
                </label>
              ))}
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                disabled={!canAssignFleet}
                onClick={() => assignFleet.mutate()}
                className="gap-2 uppercase tracking-widest text-xs"
                data-testid="button-campaign-assign-fleet"
              >
                <Swords className="h-3.5 w-3.5" />
                {assignFleet.isPending ? "Committing" : "Commit Fleet"}
              </Button>
            </div>
          </section>
        )}

        <section className="grid gap-x-8 gap-y-5 border-b border-border py-5 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"><Crosshair className="h-3.5 w-3.5" /> Scenario</div>
            <div className="mt-2 text-sm font-semibold text-foreground">{scenarioLabel}</div>
          </div>
          <div>
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"><MapPin className="h-3.5 w-3.5" /> Deployment</div>
            <div className="mt-2 text-sm font-semibold text-foreground">{campaignDeploymentLabel(snapshot.deployment?.preset)}</div>
            {snapshot.deployment?.preset === "ambush-center" ? (
              <div className="mt-1 text-xs text-muted-foreground">{snapshot.deployment.ambushCenterSide === "attacker" ? "Attacker" : "Defender"} in center</div>
            ) : (
              <div className="mt-1 text-xs text-muted-foreground">{snapshot.deployment?.depth ?? 12}&quot; depth</div>
            )}
          </div>
          <div>
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"><Swords className="h-3.5 w-3.5" /> Battlefield</div>
            <div className="mt-2 text-sm font-semibold text-foreground">{campaignTerrainLabel(snapshot.battlefield?.terrain, snapshot.battlefield?.terrainCount)}</div>
            <div className="mt-1 text-xs text-muted-foreground">{campaignSkyboxLabel(snapshot.battlefield?.skybox)}</div>
          </div>
          <div>
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"><Shield className="h-3.5 w-3.5" /> Stations</div>
            <div className="mt-2 text-sm font-semibold text-foreground">{snapshot.battlefield?.stations === "enabled" ? "Enabled" : "None"}</div>
          </div>
        </section>

        {snapshot.specialConditions && snapshot.specialConditions.length > 0 && (
          <section className="border-b border-border py-5">
            <h2 className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-200">Special Conditions</h2>
            <ul className="mt-3 space-y-2 text-sm text-foreground">
              {snapshot.specialConditions.map((condition, index) => <li key={`${condition}-${index}`}>{condition}</li>)}
            </ul>
          </section>
        )}

        {snapshot.scenario?.objectiveAutomation === "manual" && battle.scenarioKey !== "campaign-engagement" && (
          <div className="border-b border-amber-400/35 bg-amber-400/5 px-3 py-3 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-200">
            Scenario objective adjudication is manual; locked setup and roster conditions remain server-enforced.
          </div>
        )}

        <div className="grid gap-7 py-5 lg:grid-cols-2">
          <ForceList
            label="Attacker"
            commander={commanderName(battle.attackerPlayerId, campaign.players)}
            assignments={attackerAssignments}
            accent="text-amber-200"
          />
          <ForceList
            label="Defender"
            commander={commanderName(battle.defenderPlayerId, campaign.players)}
            assignments={defenderAssignments}
            accent="text-cyan-200"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            {myAssignments.length > 0 ? `${myAssignments.length} assigned units / conditions locked` : "Briefing access / no assigned force"}
          </div>
          <Button
            type="button"
            disabled={!canEnter}
            onClick={enterEngagement}
            className="gap-2 uppercase tracking-widest"
            data-testid="button-enter-campaign-engagement"
          >
            {enterLabel} <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </main>
    </Layout>
  );
}
