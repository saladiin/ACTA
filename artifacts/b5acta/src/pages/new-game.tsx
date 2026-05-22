import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useSearchPlayers,
  useListFleets,
  useCreateGame,
  getListGamesQueryKey,
  getGetLobbyQueryKey,
  getSearchPlayersQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserCircle, Swords, ChevronRight } from "lucide-react";

export default function NewGame() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedOpponent, setSelectedOpponent] = useState<{ id: string; username: string } | null>(null);
  const [selectedFleet, setSelectedFleet] = useState<string>("");
  const [pointLimit, setPointLimit] = useState("500");

  const { data: players, isLoading: searchLoading } = useSearchPlayers(
    { q: search },
    { query: { queryKey: getSearchPlayersQueryKey({ q: search }), enabled: search.length >= 2 } }
  );
  const { data: fleets } = useListFleets();
  const createGame = useCreateGame();

  const handleCreate = () => {
    if (!selectedOpponent || !selectedFleet) return;
    createGame.mutate(
      { data: { opponentId: selectedOpponent.id, fleetId: parseInt(selectedFleet), pointLimit: parseInt(pointLimit) } },
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
        {/* Step 1: Choose opponent */}
        <section>
          <h2 className="text-xs font-mono tracking-[0.3em] uppercase text-muted-foreground mb-3 flex items-center gap-2">
            <span className="w-5 h-5 border border-primary text-primary rounded-full flex items-center justify-center text-[10px] font-bold">1</span>
            Select Opposing Commander
          </h2>
          {selectedOpponent ? (
            <div data-testid="selected-opponent" className="flex items-center justify-between border border-primary/30 bg-primary/5 rounded-md px-4 py-3">
              <div className="flex items-center gap-2">
                <UserCircle className="w-4 h-4 text-primary" />
                <span className="font-semibold text-sm">{selectedOpponent.username}</span>
              </div>
              <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setSelectedOpponent(null)}>Change</Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Input
                data-testid="input-search-players"
                placeholder="Search by username..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="bg-background"
              />
              {search.length >= 2 && (
                <div className="border border-border rounded-md overflow-hidden">
                  {searchLoading ? (
                    <div className="p-3"><Skeleton className="h-8 w-full" /></div>
                  ) : players?.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-muted-foreground">No commanders found</div>
                  ) : (
                    players?.map(p => (
                      <button
                        key={p.clerkUserId}
                        data-testid={`button-select-player-${p.clerkUserId}`}
                        className="w-full flex items-center justify-between px-4 py-3 hover:bg-secondary/30 transition-colors text-left"
                        onClick={() => { setSelectedOpponent({ id: p.clerkUserId, username: p.username }); setSearch(""); }}
                      >
                        <div className="flex items-center gap-2">
                          <UserCircle className="w-4 h-4 text-muted-foreground" />
                          <span className="text-sm font-medium">{p.username}</span>
                        </div>
                        <div className="text-xs text-muted-foreground font-mono">{p.wins}W / {p.losses}L</div>
                        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Step 2: Choose fleet */}
        <section>
          <h2 className="text-xs font-mono tracking-[0.3em] uppercase text-muted-foreground mb-3 flex items-center gap-2">
            <span className="w-5 h-5 border border-primary text-primary rounded-full flex items-center justify-center text-[10px] font-bold">2</span>
            Deploy Your Fleet
          </h2>
          <Select value={selectedFleet} onValueChange={setSelectedFleet}>
            <SelectTrigger data-testid="select-fleet" className="bg-background">
              <SelectValue placeholder="Select fleet..." />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              {fleets?.length === 0 && <SelectItem value="none" disabled>No fleets — create one first</SelectItem>}
              {fleets?.map(f => (
                <SelectItem key={f.id} value={String(f.id)}>
                  {f.name} ({f.shipCount} ships, {f.totalPoints} pts)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>

        {/* Step 3: Point limit */}
        <section>
          <h2 className="text-xs font-mono tracking-[0.3em] uppercase text-muted-foreground mb-3 flex items-center gap-2">
            <span className="w-5 h-5 border border-primary text-primary rounded-full flex items-center justify-center text-[10px] font-bold">3</span>
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
          disabled={!selectedOpponent || !selectedFleet || createGame.isPending}
          onClick={handleCreate}
        >
          <Swords className="w-4 h-4" />
          {createGame.isPending ? "Launching Engagement..." : "Launch Engagement"}
        </Button>
      </div>
    </Layout>
  );
}
