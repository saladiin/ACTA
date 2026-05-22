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
import { Swords, Globe2, Lock } from "lucide-react";

export default function NewGame() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [password, setPassword] = useState("");
  const [selectedFleet, setSelectedFleet] = useState<string>("");
  const [pointLimit, setPointLimit] = useState("500");

  const { data: fleets } = useListFleets();
  const createGame = useCreateGame();

  const canSubmit =
    !!pointLimit &&
    (visibility === "public" || password.trim().length >= 1) &&
    !createGame.isPending;

  const handleCreate = () => {
    if (!canSubmit) return;
    createGame.mutate(
      {
        data: {
          pointLimit: parseInt(pointLimit),
          visibility,
          password: visibility === "private" ? password : null,
          fleetId: selectedFleet ? parseInt(selectedFleet) : null,
        },
      },
      {
        onSuccess: (game) => {
          qc.invalidateQueries({ queryKey: getListGamesQueryKey() });
          qc.invalidateQueries({ queryKey: getGetLobbyQueryKey() });
          // Game starts in 'open' status; the game-board renders the deployment
          // screen for the challenger as soon as they land on it.
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
        {/* Step 1: Point limit — the only mandatory tactical field. */}
        <section>
          {sectionHeader(1, "Point Limit")}
          <Select value={pointLimit} onValueChange={setPointLimit}>
            <SelectTrigger data-testid="select-point-limit" className="bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value="250">250 pts — Skirmish</SelectItem>
              <SelectItem value="500">500 pts — Standard</SelectItem>
              <SelectItem value="750">750 pts — Campaign</SelectItem>
              <SelectItem value="1000">1000 pts — Grand Fleet</SelectItem>
            </SelectContent>
          </Select>
        </section>

        {/* Step 2: Visibility — public to lobby, or private with password. */}
        <section>
          {sectionHeader(2, "Visibility")}
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
              Listed in the public lobby — any commander may accept.
            </p>
          )}
        </section>

        {/* Step 3: Optional prefab fleet — can also be chosen at deployment. */}
        <section>
          {sectionHeader(3, "Prefab Fleet (optional)")}
          <Select value={selectedFleet} onValueChange={setSelectedFleet}>
            <SelectTrigger data-testid="select-fleet" className="bg-background">
              <SelectValue placeholder="Choose later in the deployment screen…" />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              {fleets?.length === 0 && <SelectItem value="none" disabled>No fleets — create one first</SelectItem>}
              {fleets?.map((f) => (
                <SelectItem key={f.id} value={String(f.id)}>
                  {f.name} ({f.shipCount} ships, {f.totalPoints} pts)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
