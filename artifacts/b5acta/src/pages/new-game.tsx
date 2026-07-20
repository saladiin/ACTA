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
  const [crewQualityMode, setCrewQualityMode] = useState<"standard" | "custom">("standard");

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
          password: visibility === "private" ? password : null,
          fleetId: selectedFleet ? parseInt(selectedFleet) : null,
          deploymentDepth,
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
          {sectionHeader(1, "Priority Level")}
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
          {sectionHeader(2, "Fleet Allocation Points")}
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
          {sectionHeader(3, "Visibility")}
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
          {sectionHeader(4, "Opponent")}
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
          {sectionHeader(5, `Deployment Zone Depth - ${deploymentDepth}"`)}
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
            <span>Each commander deploys within this depth of their short edge.</span>
            <span>30"</span>
          </div>
        </section>

        <section>
          {sectionHeader(6, "Crew Quality")}
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
          {sectionHeader(7, "Your Starting Fleet (optional)")}
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
