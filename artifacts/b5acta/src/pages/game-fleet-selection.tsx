import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useUser } from "@clerk/react";
import {
  getListShipModelsQueryKey,
  getListFleetShipsQueryKey,
  useGetGame,
  useListFleets,
  useListFleetShips,
  useListShipModels,
} from "@workspace/api-client-react";
import type { ShipModel } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useDevUserId } from "@/lib/dev-user";
import {
  getTemporaryUserId,
  temporaryUsernameAuthEnabled,
  useTemporaryUsername,
} from "@/lib/temporary-user";
import {
  calculateAllocation,
  formatAllocationTicks,
  normalizePriorityLevel,
  priorityLabel,
} from "@/lib/fleet-allocation";
import {
  readStoredFleetSelection,
  writeStoredFleetSelection,
} from "@/lib/fleet-selection-storage";
import { ArrowRight, ChevronDown, Minus, Plus, Search } from "lucide-react";

const AI_OPPONENT_ID = "ai:acta-skirmish-v0";

type ArcPreviewDef = {
  centerAngle: number;
  halfAngle: number;
  color: string;
  label: string;
};

const ARC_PREVIEW_DEFS: Record<string, ArcPreviewDef> = {
  Forward: {
    centerAngle: Math.PI / 2,
    halfAngle: Math.PI / 4,
    color: "#ffb000",
    label: "FWD",
  },
  Port: {
    centerAngle: 0,
    halfAngle: Math.PI / 4,
    color: "rgba(0, 255, 222, 1)",
    label: "PORT",
  },
  Starboard: {
    centerAngle: Math.PI,
    halfAngle: Math.PI / 4,
    color: "rgba(0, 255, 222, 1)",
    label: "STBD",
  },
  Aft: {
    centerAngle: -Math.PI / 2,
    halfAngle: Math.PI / 4,
    color: "#ff2f4f",
    label: "AFT",
  },
  "Boresight Forward": {
    centerAngle: Math.PI / 2,
    halfAngle: Math.PI / 24,
    color: "#fff75a",
    label: "BS-F",
  },
  "Boresight Aft": {
    centerAngle: -Math.PI / 2,
    halfAngle: Math.PI / 24,
    color: "#ff7a1a",
    label: "BS-A",
  },
  Turret: {
    centerAngle: Math.PI / 2,
    halfAngle: Math.PI,
    color: "#b86cff",
    label: "TUR",
  },
};

const ARC_PREVIEW_ORDER = [
  "Forward",
  "Port",
  "Starboard",
  "Aft",
  "Boresight Forward",
  "Boresight Aft",
  "Turret",
];

function canonicalFleetArc(arcName: string): string {
  const normalized = arcName.trim().replace(/\s+/g, " ").toLowerCase();
  switch (normalized) {
    case "forward":
    case "front":
    case "fwd":
    case "f":
      return "Forward";
    case "aft":
    case "rear":
    case "r":
      return "Aft";
    case "port":
    case "p":
      return "Port";
    case "starboard":
    case "stbd":
    case "s":
      return "Starboard";
    case "turret":
    case "tur":
    case "t":
      return "Turret";
    case "boresight forward":
    case "boresight fwd":
    case "boresight front":
    case "bs forward":
    case "bs fwd":
      return "Boresight Forward";
    case "boresight aft":
    case "boresight rear":
    case "bs aft":
    case "bs rear":
      return "Boresight Aft";
    default:
      return arcName.trim();
  }
}

function arcPoint(cx: number, cy: number, radius: number, angle: number) {
  return {
    x: cx + Math.cos(angle) * radius,
    y: cy - Math.sin(angle) * radius,
  };
}

function arcSectorPath(def: ArcPreviewDef, radius: number) {
  const cx = 60;
  const cy = 60;
  const start = arcPoint(cx, cy, radius, def.centerAngle - def.halfAngle);
  const end = arcPoint(cx, cy, radius, def.centerAngle + def.halfAngle);
  const largeArc = def.halfAngle * 2 > Math.PI ? 1 : 0;
  return [
    `M ${cx} ${cy}`,
    `L ${start.x.toFixed(2)} ${start.y.toFixed(2)}`,
    `A ${radius} ${radius} 0 ${largeArc} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

function arcLabelPosition(def: ArcPreviewDef, radius: number) {
  return arcPoint(60, 60, radius, def.centerAngle);
}

function countMapToEntries(counts: Record<number, number>) {
  return Object.entries(counts)
    .map(([shipModelId, count]) => ({
      shipModelId: Number(shipModelId),
      count: Math.max(0, Math.trunc(count)),
    }))
    .filter((entry) => entry.shipModelId > 0 && entry.count > 0);
}

function formatTraits(traits?: string | null) {
  return traits
    ?.split(";")
    .map((trait) => trait.trim())
    .filter(Boolean)
    .join(", ") || "None";
}

function groupWeaponsByArc(ship: ShipModel) {
  const grouped = new Map<string, NonNullable<ShipModel["weapons"]>>();
  for (const weapon of ship.weapons ?? []) {
    const arc = weapon.arc?.trim() || "Unspecified";
    const existing = grouped.get(arc) ?? [];
    existing.push(weapon);
    grouped.set(arc, existing);
  }
  return [...grouped.entries()].sort(([a], [b]) => {
    const aTurret = a.toLowerCase().includes("turret");
    const bTurret = b.toLowerCase().includes("turret");
    if (aTurret !== bTurret) return aTurret ? 1 : -1;
    return a.localeCompare(b);
  });
}

function ShipArcPreview({ ship }: { ship: ShipModel }) {
  const arcs = useMemo(() => {
    const unique = new Set<string>();
    for (const weapon of ship.weapons ?? []) {
      const canonical = canonicalFleetArc(weapon.arc ?? "");
      if (ARC_PREVIEW_DEFS[canonical]) unique.add(canonical);
    }
    return ARC_PREVIEW_ORDER.filter((arc) => unique.has(arc));
  }, [ship.weapons]);

  if (arcs.length === 0) {
    return (
      <div className="rounded border border-border/70 bg-background/70 px-2 py-2 text-[10px] text-muted-foreground">
        No weapon arcs listed.
      </div>
    );
  }

  return (
    <div className="rounded border border-border/70 bg-background/70 p-2">
      <div className="flex items-center justify-between gap-2 mb-1">
        <p className="uppercase tracking-wider text-primary/80">
          Arc Preview
        </p>
        <p className="text-[9px] text-muted-foreground">top-down</p>
      </div>
      <svg
        viewBox="0 0 120 120"
        role="img"
        aria-label={`${ship.name} weapon arc preview`}
        className="w-full max-w-[180px] mx-auto block"
      >
        <defs>
          <filter id={`arc-glow-${ship.id}`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="1.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <circle
          cx="60"
          cy="60"
          r="18"
          fill="rgba(15, 23, 42, 0.78)"
          stroke="rgba(255,255,255,0.55)"
          strokeWidth="1.5"
        />
        <path
          d="M 60 34 L 55 45 L 65 45 Z"
          fill="rgba(255,255,255,0.85)"
        />
        <line
          x1="60"
          y1="60"
          x2="60"
          y2="23"
          stroke="rgba(255,255,255,0.18)"
          strokeWidth="1"
          strokeDasharray="2 3"
        />
        {arcs
          .filter((arc) => arc !== "Turret")
          .map((arc) => {
            const def = ARC_PREVIEW_DEFS[arc]!;
            const isBoresight = arc.startsWith("Boresight");
            const radius = isBoresight ? 52 : 44;
            const label = arcLabelPosition(def, isBoresight ? 56 : 49);
            return (
              <g key={arc} filter={`url(#arc-glow-${ship.id})`}>
                <path
                  d={arcSectorPath(def, radius)}
                  fill={def.color}
                  fillOpacity={isBoresight ? 0.22 : 0.16}
                  stroke={def.color}
                  strokeOpacity={0.92}
                  strokeWidth={isBoresight ? 2.2 : 1.8}
                />
                <text
                  x={label.x}
                  y={label.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={def.color}
                  fontSize="6"
                  fontWeight="700"
                  letterSpacing="0.4"
                >
                  {def.label}
                </text>
              </g>
            );
          })}
        {arcs.includes("Turret") && (
          <g filter={`url(#arc-glow-${ship.id})`}>
            <circle
              cx="60"
              cy="60"
              r="31"
              fill="none"
              stroke={ARC_PREVIEW_DEFS.Turret.color}
              strokeWidth="3"
              strokeOpacity="0.9"
              strokeDasharray="4 3"
            />
            <text
              x="60"
              y="64"
              textAnchor="middle"
              dominantBaseline="middle"
              fill={ARC_PREVIEW_DEFS.Turret.color}
              fontSize="7"
              fontWeight="800"
              letterSpacing="0.5"
            >
              TUR
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

export default function GameFleetSelection() {
  const params = useParams<{ id: string }>();
  const gameId = parseInt(params.id ?? "0");
  const [, setLocation] = useLocation();
  const devUserId = useDevUserId();
  useTemporaryUsername();
  const { user } = useUser();
  const rawMyUserId =
    (temporaryUsernameAuthEnabled
      ? getTemporaryUserId()
      : import.meta.env.DEV
        ? devUserId
        : user?.id) ?? "";
  const ownerParam =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("owner");
  const ownerId = ownerParam === "ai" ? AI_OPPONENT_ID : rawMyUserId;
  const selectingAiFleet = ownerId === AI_OPPONENT_ID;

  const { data: gameData, isLoading: gameLoading } = useGetGame(gameId);
  const game = gameData?.game;
  const { data: shipModels } = useListShipModels({
    query: {
      queryKey: getListShipModelsQueryKey(),
      staleTime: 0,
      refetchOnMount: "always",
    },
  });
  const { data: fleets } = useListFleets();
  const [selectedFleetId, setSelectedFleetId] = useState<string>("");
  const { data: selectedFleetShips } = useListFleetShips(
    parseInt(selectedFleetId || "0"),
    {
      query: {
        queryKey: getListFleetShipsQueryKey(parseInt(selectedFleetId || "0")),
        enabled: !!selectedFleetId,
      },
    },
  );
  const [selectedFaction, setSelectedFaction] = useState<string>("__all__");
  const [search, setSearch] = useState("");
  const [shipCounts, setShipCounts] = useState<Record<number, number>>({});
  const [expandedShipIds, setExpandedShipIds] = useState<Set<number>>(
    () => new Set(),
  );
  const loadedStoredKeyRef = useRef<string | null>(null);

  const shipModelById = useMemo(() => {
    const map = new Map<number, ShipModel>();
    for (const ship of shipModels ?? []) map.set(ship.id, ship);
    return map;
  }, [shipModels]);

  useEffect(() => {
    if (!gameId || !ownerId || !shipModels) return;
    const loadKey = `${gameId}:${ownerId}`;
    if (loadedStoredKeyRef.current === loadKey) return;
    loadedStoredKeyRef.current = loadKey;
    const stored = readStoredFleetSelection(gameId, ownerId);
    if (!stored) return;
    const next: Record<number, number> = {};
    for (const entry of stored.entries) {
      if (!shipModelById.has(entry.shipModelId)) continue;
      next[entry.shipModelId] = entry.count;
    }
    setShipCounts(next);
    setSelectedFleetId(stored.savedFleetId ? String(stored.savedFleetId) : "");
  }, [gameId, ownerId, shipModelById, shipModels]);

  useEffect(() => {
    if (!selectedFleetId || !selectedFleetShips) return;
    const next: Record<number, number> = {};
    for (const fleetShip of selectedFleetShips) {
      next[fleetShip.shipModel.id] = (next[fleetShip.shipModel.id] ?? 0) + 1;
    }
    setShipCounts(next);
  }, [selectedFleetId, selectedFleetShips]);

  const factions = useMemo(
    () => [...new Set((shipModels ?? []).map((ship) => ship.faction))].sort(),
    [shipModels],
  );
  const filteredShips = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (shipModels ?? [])
      .filter((ship) =>
        selectedFaction === "__all__" ? true : ship.faction === selectedFaction,
      )
      .filter((ship) =>
        query
          ? `${ship.name} ${ship.faction} ${ship.priorityLevel}`
              .toLowerCase()
              .includes(query)
          : true,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [search, selectedFaction, shipModels]);

  const selectedEntries = useMemo(
    () => countMapToEntries(shipCounts),
    [shipCounts],
  );
  const selectedShips = useMemo(
    () =>
      selectedEntries
        .map((entry) => ({
          ship: shipModelById.get(entry.shipModelId),
          count: entry.count,
        }))
        .filter(
          (entry): entry is { ship: ShipModel; count: number } =>
            !!entry.ship,
        ),
    [selectedEntries, shipModelById],
  );
  const scenarioPriority = normalizePriorityLevel(game?.priorityLevel);
  const allocationPoints =
    game?.allocationPoints ?? Math.max(1, Math.round((game?.pointLimit ?? 500) / 100));
  const allocation = useMemo(
    () =>
      calculateAllocation(
        selectedShips.flatMap(({ ship, count }) =>
          Array.from({ length: count }, () =>
            normalizePriorityLevel(ship.priorityLevel),
          ),
        ),
        scenarioPriority,
        allocationPoints,
      ),
    [allocationPoints, scenarioPriority, selectedShips],
  );

  const setCount = (shipModelId: number, count: number) => {
    setShipCounts((prev) => {
      const next = { ...prev };
      const cleanCount = Math.max(0, Math.trunc(count));
      if (cleanCount <= 0) delete next[shipModelId];
      else next[shipModelId] = cleanCount;
      return next;
    });
    setSelectedFleetId("");
  };
  const toggleDetails = (shipModelId: number) => {
    setExpandedShipIds((prev) => {
      const next = new Set(prev);
      if (next.has(shipModelId)) next.delete(shipModelId);
      else next.add(shipModelId);
      return next;
    });
  };

  const handleContinue = () => {
    if (!game || !ownerId || selectedEntries.length === 0) return;
    writeStoredFleetSelection({
      gameId,
      ownerId,
      savedFleetId: selectedFleetId ? parseInt(selectedFleetId) : null,
      entries: selectedEntries,
      updatedAt: Date.now(),
    });
    setLocation(`/games/${gameId}`);
  };

  const canContinue =
    !!game &&
    !!ownerId &&
    selectedEntries.length > 0 &&
    allocation.legal &&
    ["open", "pending", "deploying"].includes(game.status);

  if (gameLoading) {
    return (
      <Layout title="Fleet Selection">
        <div className="p-6 text-sm font-mono text-muted-foreground">
          Loading engagement...
        </div>
      </Layout>
    );
  }

  if (!game) {
    return (
      <Layout title="Fleet Selection">
        <div className="p-6 text-sm font-mono text-red-400">
          Engagement not found.
        </div>
      </Layout>
    );
  }

  return (
    <Layout title={selectingAiFleet ? "Select AI Fleet" : "Select Fleet"}>
      <div className="p-6 max-w-6xl mx-auto space-y-5">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-primary">
              {selectingAiFleet ? "AI Fleet Selection" : "Fleet Selection"}
            </p>
            <h1 className="text-2xl font-bold tracking-wide">
              {selectingAiFleet ? "Choose ships for the AI" : "Choose your ships"}
            </h1>
            <p className="text-xs font-mono text-muted-foreground mt-1">
              {priorityLabel(scenarioPriority)} {allocationPoints} FAP - selected{" "}
              {formatAllocationTicks(allocation.spentTicks)}
            </p>
          </div>
          <Button
            data-testid="button-continue-to-board"
            disabled={!canContinue}
            onClick={handleContinue}
            className="gap-2 uppercase tracking-widest"
          >
            Continue to Deployment
            <ArrowRight className="w-4 h-4" />
          </Button>
        </div>

        {!["open", "pending", "deploying"].includes(game.status) && (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-mono text-amber-200">
            Fleet selection is only available before the engagement begins.
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="rounded-md border border-border bg-card/50 p-3 space-y-3">
            <div className="grid gap-2 md:grid-cols-3">
              <Select
                value={selectedFleetId || "__none__"}
                onValueChange={(value) =>
                  setSelectedFleetId(value === "__none__" ? "" : value)
                }
              >
                <SelectTrigger data-testid="select-fleet-template" className="bg-background">
                  <SelectValue placeholder="Load saved fleet..." />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="__none__">No saved fleet</SelectItem>
                  {fleets?.map((fleet) => (
                    <SelectItem key={fleet.id} value={String(fleet.id)}>
                      {fleet.name} ({fleet.shipCount})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={selectedFaction} onValueChange={setSelectedFaction}>
                <SelectTrigger data-testid="select-ship-faction" className="bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="__all__">All factions</SelectItem>
                  {factions.map((faction) => (
                    <SelectItem key={faction} value={faction}>
                      {faction}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 w-4 h-4 text-muted-foreground" />
                <Input
                  data-testid="input-ship-search"
                  className="pl-8 bg-background"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search ships..."
                />
              </div>
            </div>

            <div className="sticky top-0 z-10 rounded border border-border bg-background/95 px-3 py-2 text-xs font-mono shadow-sm backdrop-blur">
              <div className="flex items-center justify-between gap-3">
                <span className="uppercase tracking-widest text-muted-foreground">
                  FAP: Budget / Remaining
                </span>
                <span
                  className={
                    allocation.remainingTicks < 0
                      ? "text-red-400"
                      : "text-green-400"
                  }
                >
                  {allocationPoints} / {formatAllocationTicks(allocation.remainingTicks)}
                </span>
              </div>
            </div>

            <div className="max-h-[62vh] overflow-y-auto pr-1 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {filteredShips.map((ship) => {
                const count = shipCounts[ship.id] ?? 0;
                const expanded = expandedShipIds.has(ship.id);
                const arcWeapons = groupWeaponsByArc(ship);
                return (
                  <div
                    key={ship.id}
                    className={`rounded border bg-background p-2 transition-colors ${
                      count > 0 ? "border-primary/60" : "border-border"
                    }`}
                    data-testid={`ship-select-card-${ship.id}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-mono text-foreground leading-tight truncate">
                          {ship.name}
                        </p>
                        <p className="text-[10px] font-mono text-muted-foreground truncate">
                          {ship.faction}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleDetails(ship.id)}
                        className="shrink-0 rounded border border-border px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
                        data-testid={`button-ship-details-${ship.id}`}
                      >
                        <span className="inline-flex items-center gap-1">
                          Details
                          <ChevronDown
                            className={`w-3 h-3 transition-transform ${
                              expanded ? "rotate-180" : ""
                            }`}
                          />
                        </span>
                      </button>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setCount(ship.id, count - 1)}
                        disabled={count <= 0}
                        data-testid={`button-ship-minus-${ship.id}`}
                      >
                        <Minus className="w-4 h-4" />
                      </Button>
                      <div className="h-8 flex-1 rounded border border-border bg-card flex items-center justify-center text-sm font-mono">
                        {count}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setCount(ship.id, count + 1)}
                        data-testid={`button-ship-plus-${ship.id}`}
                      >
                        <Plus className="w-4 h-4" />
                      </Button>
                    </div>
                    {expanded && (
                      <div
                        className="mt-2 rounded border border-border/70 bg-card/60 p-2 text-[10px] font-mono text-muted-foreground space-y-2"
                        data-testid={`ship-details-${ship.id}`}
                      >
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                          <div>
                            Hull:{" "}
                            <span className="text-foreground">
                              {ship.hullRating}
                            </span>
                          </div>
                          <div>
                            Health:{" "}
                            <span className="text-foreground">
                              {ship.hullPoints}
                            </span>
                          </div>
                          <div>
                            Crew:{" "}
                            <span className="text-foreground">
                              {ship.crew ?? "n/a"}
                            </span>
                          </div>
                          <div>
                            Speed:{" "}
                            <span className="text-foreground">
                              {ship.speed}"
                            </span>
                          </div>
                        </div>
                        <ShipArcPreview ship={ship} />
                        <div>
                          <p className="uppercase tracking-wider text-primary/80">
                            Weapons
                          </p>
                          {arcWeapons.length === 0 ? (
                            <p>None listed.</p>
                          ) : (
                            <div className="space-y-1">
                              {arcWeapons.map(([arc, weapons]) => (
                                <div key={arc}>
                                  <span className="text-foreground">
                                    {arc}:
                                  </span>{" "}
                                  {weapons
                                    .map(
                                      (weapon) =>
                                        `${weapon.name} (${weapon.attackDice}AD, ${weapon.range}")`,
                                    )
                                    .join("; ")}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        <div>
                          <p className="uppercase tracking-wider text-primary/80">
                            Traits
                          </p>
                          <p>{formatTraits(ship.traits)}</p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <aside className="rounded-md border border-border bg-card/50 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-mono uppercase tracking-widest text-primary">
                Selected
              </p>
              <button
                type="button"
                className="text-[10px] font-mono text-muted-foreground hover:text-destructive uppercase tracking-wider"
                onClick={() => {
                  setShipCounts({});
                  setSelectedFleetId("");
                }}
              >
                Clear
              </button>
            </div>
            <div className="rounded border border-border bg-background px-2 py-2 text-xs font-mono">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Spent</span>
                <span>{formatAllocationTicks(allocation.spentTicks)}</span>
              </div>
            </div>
            {!allocation.legal && (
              <p className="text-[11px] font-mono text-red-400">
                Fleet exceeds the selected engagement allocation.
              </p>
            )}
            <div className="max-h-[50vh] overflow-y-auto space-y-1">
              {selectedShips.length === 0 ? (
                <p className="text-xs font-mono text-muted-foreground">
                  No ships selected.
                </p>
              ) : (
                selectedShips.map(({ ship, count }) => (
                  <div
                    key={ship.id}
                    className="rounded border border-border bg-background px-2 py-1.5 text-xs font-mono"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate">{ship.name}</span>
                      <span className="text-primary">x{count}</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      {ship.faction} - {priorityLabel(normalizePriorityLevel(ship.priorityLevel))}
                    </p>
                  </div>
                ))
              )}
            </div>
          </aside>
        </div>
      </div>
    </Layout>
  );
}
