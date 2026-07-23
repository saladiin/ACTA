import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListFleets,
  useCreateGame,
  getListGamesQueryKey,
  getGetLobbyQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Swords, Globe2, Lock, UserRound, Cpu } from "lucide-react";
import { PRIORITY_LEVELS, type PriorityLevel, priorityLabel } from "@/lib/fleet-allocation";
import type { DeploymentPreset, DeploymentSide } from "@/lib/deployment-zones";

export default function NewGame() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [opponentKind, setOpponentKind] = useState<"human" | "ai">("human");
  const [password, setPassword] = useState("");
  const [selectedFleet, setSelectedFleet] = useState<string>("");
  const [priorityLevel, setPriorityLevel] = useState<PriorityLevel>("raid");
  const [allocationPoints, setAllocationPoints] = useState("5");
  const [deploymentDepth, setDeploymentDepth] = useState<number>(12);
  const [deploymentPreset, setDeploymentPreset] =
    useState<DeploymentPreset>("standard-short-edge");
  const [ambushPlayer, setAmbushPlayer] =
    useState<DeploymentSide>("challenger");
  const [ambushBoxWidth, setAmbushBoxWidth] = useState<number>(16);
  const [ambushBoxDepth, setAmbushBoxDepth] = useState<number>(16);
  const [terrain, setTerrain] = useState<"none" | "asteroid-fields">("none");
  const [asteroidFieldCount, setAsteroidFieldCount] = useState<3 | 6 | 9>(3);
  const [stations, setStations] = useState<"none" | "enabled">("none");
  const [crewQualityMode, setCrewQualityMode] = useState<"standard" | "custom">("standard");
  const [matchName, setMatchName] = useState("");

  const { data: fleets } = useListFleets();
  const createGame = useCreateGame();

  const canSubmit =
    !!allocationPoints &&
    parseInt(allocationPoints) > 0 &&
    (visibility === "public" || password.trim().length >= 1) &&
    !createGame.isPending;

  const handleCreate = () => {
    if (!canSubmit) return;
    const fap = parseInt(allocationPoints);
    createGame.mutate(
      {
        data: {
          pointLimit: fap * 100,
          priorityLevel,
          allocationPoints: fap,
          visibility,
          opponentKind,
          matchName: matchName.trim() || null,
          password: visibility === "private" ? password : null,
          fleetId: selectedFleet ? parseInt(selectedFleet) : null,
          deploymentDepth,
          deploymentPreset,
          ambushPlayer:
            deploymentPreset === "ambush-center" ? ambushPlayer : undefined,
          ambushBoxWidth:
            deploymentPreset === "ambush-center" ? ambushBoxWidth : undefined,
          ambushBoxDepth:
            deploymentPreset === "ambush-center" ? ambushBoxDepth : undefined,
          terrain,
          asteroidFieldCount:
            terrain === "asteroid-fields" ? asteroidFieldCount : undefined,
          stations,
          crewQualityMode,
        },
      },
      {
        onSuccess: (game) => {
          qc.invalidateQueries({ queryKey: getListGamesQueryKey() });
          qc.invalidateQueries({ queryKey: getGetLobbyQueryKey() });
          setLocation(`/games/${game.id}`);
        },
      },
    );
  };

  const sectionHeader = (n: number, label: string) => (
    <h2 className="text-xs font-mono tracking-[0.3em] uppercase text-muted-foreground mb-3 flex items-center gap-2">
      <span className="w-5 h-5 border border-primary text-primary rounded-full flex items-center justify-center text-[10px] font-bold">{n}</span>
      {label}
    </h2>
  );

  return (
    <Layout title="Launch Engagement">
      <div className="p-6 max-w-xl mx-auto space-y-8">
        <section>
          {sectionHeader(1, "Match Name")}
          <Input
            data-testid="input-match-name"
            value={matchName}
            onChange={(event) => setMatchName(event.target.value)}
            maxLength={80}
            placeholder="e.g. 5 FAP pickup - no Ancients"
            className="bg-background"
          />
          <p className="mt-1 text-[11px] text-muted-foreground font-mono">
            Optional title or desired conditions displayed to commanders in the lobby.
          </p>
        </section>

        <section>
          {sectionHeader(2, "Priority Level")}
          <Select value={priorityLevel} onValueChange={(value) => setPriorityLevel(value as PriorityLevel)}>
            <SelectTrigger data-testid="select-priority-level" className="bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              {PRIORITY_LEVELS.map(level => (
                <SelectItem key={level} value={level}>{priorityLabel(level)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-[11px] text-muted-foreground font-mono">
            Ship costs are calculated relative to this scenario level.
          </p>
        </section>

        <section>
          {sectionHeader(3, "Fleet Allocation Points")}
          <Select value={allocationPoints} onValueChange={setAllocationPoints}>
            <SelectTrigger data-testid="select-allocation-points" className="bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value="3">3 FAP</SelectItem>
              <SelectItem value="5">5 FAP</SelectItem>
              <SelectItem value="7">7 FAP</SelectItem>
              <SelectItem value="10">10 FAP</SelectItem>
            </SelectContent>
          </Select>
          <p className="mt-1 text-[11px] text-muted-foreground font-mono">
            Standard pickup size is usually 5 FAP.
          </p>
        </section>

        <section>
          {sectionHeader(4, "Visibility")}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              data-testid="button-visibility-public"
              onClick={() => setVisibility("public")}
              className={`flex items-center gap-2 px-4 py-3 rounded-md border text-sm font-mono uppercase tracking-wider transition-colors ${
                visibility === "public"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40"
              }`}
            >
              <Globe2 className="w-4 h-4" /> Public
            </button>
            <button
              type="button"
              data-testid="button-visibility-private"
              onClick={() => setVisibility("private")}
              className={`flex items-center gap-2 px-4 py-3 rounded-md border text-sm font-mono uppercase tracking-wider transition-colors ${
                visibility === "private"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40"
              }`}
            >
              <Lock className="w-4 h-4" /> Private
            </button>
          </div>
          {visibility === "private" && (
            <div className="mt-3">
              <Input
                data-testid="input-engagement-password"
                type="password"
                autoComplete="new-password"
                placeholder="Engagement password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="bg-background"
              />
              <p className="mt-1 text-[11px] text-muted-foreground font-mono">
                Anyone with this password can join. Share it on your own channel.
              </p>
            </div>
          )}
          {visibility === "public" && (
            <p className="mt-2 text-[11px] text-muted-foreground font-mono">
              Listed in the public lobby; any commander may accept.
            </p>
          )}
        </section>

        <section>
          {sectionHeader(5, "Opponent")}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              data-testid="button-opponent-human"
              onClick={() => setOpponentKind("human")}
              className={`flex items-center gap-2 px-4 py-3 rounded-md border text-sm font-mono uppercase tracking-wider transition-colors ${
                opponentKind === "human"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40"
              }`}
            >
              <UserRound className="w-4 h-4" /> Human
            </button>
            <button
              type="button"
              data-testid="button-opponent-ai"
              onClick={() => setOpponentKind("ai")}
              className={`flex items-center gap-2 px-4 py-3 rounded-md border text-sm font-mono uppercase tracking-wider transition-colors ${
                opponentKind === "ai"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40"
              }`}
            >
              <Cpu className="w-4 h-4" /> AI
            </button>
          </div>
          {opponentKind === "ai" && (
            <p className="mt-2 text-[11px] text-amber-400 font-mono">
              Deploy your fleet first, then place the AI fleet on the opponent side before play begins.
            </p>
          )}
        </section>

        <section>
          {sectionHeader(6, "Deployment Zones")}
          <Select
            value={deploymentPreset}
            onValueChange={(value) =>
              setDeploymentPreset(value as DeploymentPreset)
            }
          >
            <SelectTrigger data-testid="select-deployment-preset" className="bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value="standard-short-edge">Standard short edges</SelectItem>
              <SelectItem value="standard-long-edge">Long edges</SelectItem>
              <SelectItem value="ambush-center">Ambush center</SelectItem>
            </SelectContent>
          </Select>

          {deploymentPreset !== "ambush-center" && (
            <div className="mt-4">
              <div className="mb-2 text-[11px] text-muted-foreground font-mono uppercase tracking-wider">
                Zone depth - {deploymentDepth}"
              </div>
              <input
                type="range"
                min={4}
                max={30}
                step={1}
                value={deploymentDepth}
                onChange={(e) => setDeploymentDepth(parseInt(e.target.value))}
                data-testid="input-deployment-depth"
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-[10px] font-mono text-muted-foreground tracking-wider mt-1">
                <span>4"</span>
                <span>
                  {deploymentPreset === "standard-long-edge"
                    ? "Each commander deploys along a long board edge."
                    : "Each commander deploys along a short board edge."}
                </span>
                <span>30"</span>
              </div>
            </div>
          )}

          {deploymentPreset === "ambush-center" && (
            <div className="mt-4 space-y-4">
              <div>
                <div className="mb-2 text-[11px] text-muted-foreground font-mono uppercase tracking-wider">
                  Center player
                </div>
                <Select
                  value={ambushPlayer}
                  onValueChange={(value) =>
                    setAmbushPlayer(value as DeploymentSide)
                  }
                >
                  <SelectTrigger data-testid="select-ambush-player" className="bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-border">
                    <SelectItem value="challenger">Host in center</SelectItem>
                    <SelectItem value="opponent">Opponent in center</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <div className="mb-2 text-[11px] text-muted-foreground font-mono uppercase tracking-wider">
                  Center box width - {ambushBoxWidth}"
                </div>
                <input
                  type="range"
                  min={6}
                  max={40}
                  step={1}
                  value={ambushBoxWidth}
                  onChange={(e) => setAmbushBoxWidth(parseInt(e.target.value))}
                  data-testid="input-ambush-box-width"
                  className="w-full accent-primary"
                />
              </div>

              <div>
                <div className="mb-2 text-[11px] text-muted-foreground font-mono uppercase tracking-wider">
                  Center box depth - {ambushBoxDepth}"
                </div>
                <input
                  type="range"
                  min={6}
                  max={56}
                  step={1}
                  value={ambushBoxDepth}
                  onChange={(e) => setAmbushBoxDepth(parseInt(e.target.value))}
                  data-testid="input-ambush-box-depth"
                  className="w-full accent-primary"
                />
              </div>
            </div>
          )}

          <p className="mt-2 text-[11px] text-muted-foreground font-mono">
            The server validates the whole base inside the selected zone. Red
            deployment exclusions are blocked even if a ship center appears
            legal.
          </p>
        </section>

        <section>
          {sectionHeader(7, "Terrain")}
          <Select
            value={terrain}
            onValueChange={(value) =>
              setTerrain(value as "none" | "asteroid-fields")
            }
          >
            <SelectTrigger data-testid="select-terrain" className="bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="asteroid-fields">Asteroid fields</SelectItem>
            </SelectContent>
          </Select>

          {terrain === "asteroid-fields" && (
            <div className="mt-3">
              <div className="mb-2 text-[11px] text-muted-foreground font-mono uppercase tracking-wider">
                Asteroid fields
              </div>
              <Select
                value={String(asteroidFieldCount)}
                onValueChange={(value) =>
                  setAsteroidFieldCount(Number(value) as 3 | 6 | 9)
                }
              >
                <SelectTrigger data-testid="select-asteroid-field-count" className="bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="3">3 fields</SelectItem>
                  <SelectItem value="6">6 fields</SelectItem>
                  <SelectItem value="9">9 fields</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <p className="mt-2 text-[11px] text-muted-foreground font-mono">
            Asteroid fields are placed by the server before deployment. Standard
            setups exclude deployment zones; ambush setups exclude the center box.
          </p>
        </section>

        <section>
          {sectionHeader(8, "Stations")}
          <Select
            value={stations}
            onValueChange={(value) =>
              setStations(value as "none" | "enabled")
            }
          >
            <SelectTrigger data-testid="select-stations" className="bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="enabled">Stations enabled</SelectItem>
            </SelectContent>
          </Select>
          <p className="mt-2 text-[11px] text-muted-foreground font-mono">
            Station-enabled games are flagged in the lobby before a commander joins.
          </p>
        </section>

        <section>
          {sectionHeader(9, "Crew Quality")}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              data-testid="button-cq-standard"
              onClick={() => setCrewQualityMode("standard")}
              className={`flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-md border text-left transition-colors ${
                crewQualityMode === "standard"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40"
              }`}
            >
              <span className="text-sm font-mono uppercase tracking-wider">Standard</span>
              <span className="text-[10px] font-mono opacity-80">All ships CQ 4 (Veteran)</span>
            </button>
            <button
              type="button"
              data-testid="button-cq-custom"
              onClick={() => setCrewQualityMode("custom")}
              className={`flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-md border text-left transition-colors ${
                crewQualityMode === "custom"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40"
              }`}
            >
              <span className="text-sm font-mono uppercase tracking-wider">Custom</span>
              <span className="text-[10px] font-mono opacity-80">Assign CQ 1-7 per ship at deploy</span>
            </button>
          </div>
        </section>

        <section>
          {sectionHeader(10, "Your Starting Fleet (optional)")}
          <Select value={selectedFleet} onValueChange={setSelectedFleet}>
            <SelectTrigger data-testid="select-fleet" className="bg-background">
              <SelectValue placeholder="Choose your fleet now, or place ships later..." />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              {fleets?.length === 0 && <SelectItem value="none" disabled>No fleets; create one first</SelectItem>}
              {fleets?.map((f) => (
                <SelectItem key={f.id} value={String(f.id)}>
                  {f.name} ({f.shipCount} ships)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-[11px] text-muted-foreground font-mono">
            This selection is for your fleet. {opponentKind === "ai" ? "The AI fleet is assembled separately on the deployment screen." : "Your opponent chooses their own fleet when they join."}
          </p>
          {selectedFleet && (
            <button
              type="button"
              className="mt-2 text-[11px] text-muted-foreground font-mono uppercase tracking-wider hover:text-foreground"
              onClick={() => setSelectedFleet("")}
              data-testid="button-clear-fleet"
            >
              Clear selection
            </button>
          )}
        </section>

        {createGame.isError && (
          <p className="text-xs text-red-400 font-mono" data-testid="text-create-error">
            {(createGame.error as Error).message}
          </p>
        )}

        <Button
          data-testid="button-launch-engagement"
          className="w-full gap-2 uppercase tracking-widest font-bold"
          disabled={!canSubmit}
          onClick={handleCreate}
        >
          <Swords className="w-4 h-4" />
          {createGame.isPending ? "Launching Engagement..." : "Launch Engagement"}
        </Button>
      </div>
    </Layout>
  );
}
