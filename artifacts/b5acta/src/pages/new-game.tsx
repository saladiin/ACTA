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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Swords } from "lucide-react";

const NO_FLEET = "__none__";

export default function NewGame() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const [selectedFleet, setSelectedFleet] = useState<string>(NO_FLEET);
  const [pointLimit, setPointLimit] = useState("500");

  const { data: fleets } = useListFleets();
  const createGame = useCreateGame();

  const handleCreate = () => {
    const fleetId = selectedFleet === NO_FLEET ? null : parseInt(selectedFleet);
    createGame.mutate(
      { data: { fleetId, pointLimit: parseInt(pointLimit) } },
      {
        onSuccess: (game) => {
          qc.invalidateQueries({ queryKey: getListGamesQueryKey() });
          qc.invalidateQueries({ queryKey: getGetLobbyQueryKey() });
          setLocation(`/games/${game.id}`);
        },
      }
    );
  };

  return (
    <Layout title="Launch Engagement">
      <div className="p-6 max-w-xl mx-auto space-y-8">
        <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
          Open Challenge — any commander on station may accept.
        </p>

        {/* Step 1: Prefab fleet (optional) */}
        <section>
          <h2 className="text-xs font-mono tracking-[0.3em] uppercase text-muted-foreground mb-3 flex items-center gap-2">
            <span className="w-5 h-5 border border-primary text-primary rounded-full flex items-center justify-center text-[10px] font-bold">1</span>
            Deploy Prefab Fleet <span className="text-[10px] text-muted-foreground/60 tracking-normal normal-case">(optional)</span>
          </h2>
          <Select value={selectedFleet} onValueChange={setSelectedFleet}>
            <SelectTrigger data-testid="select-fleet" className="bg-background">
              <SelectValue placeholder="Choose later during deployment..." />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value={NO_FLEET}>Decide at deploy time</SelectItem>
              {fleets?.map(f => (
                <SelectItem key={f.id} value={String(f.id)}>
                  {f.name} ({f.shipCount} ships, {f.totalPoints} pts)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>

        {/* Step 2: Point limit */}
        <section>
          <h2 className="text-xs font-mono tracking-[0.3em] uppercase text-muted-foreground mb-3 flex items-center gap-2">
            <span className="w-5 h-5 border border-primary text-primary rounded-full flex items-center justify-center text-[10px] font-bold">2</span>
            Point Limit
          </h2>
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

        <Button
          data-testid="button-launch-engagement"
          className="w-full gap-2 uppercase tracking-widest font-bold"
          disabled={createGame.isPending}
          onClick={handleCreate}
        >
          <Swords className="w-4 h-4" />
          {createGame.isPending ? "Launching Engagement..." : "Launch Engagement"}
        </Button>
      </div>
    </Layout>
  );
}
