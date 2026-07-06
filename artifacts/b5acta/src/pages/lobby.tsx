import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetLobby,
  useGetMyProfile,
  useUpdateMyProfile,
  getGetMyProfileQueryKey,
  getGetLobbyQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Swords, Clock, Trophy, Plus, ChevronRight, Target, Pencil, Check, X } from "lucide-react";
import { normalizePriorityLevel, priorityLabel } from "@/lib/fleet-allocation";

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    pending: "border-amber-500/50 text-amber-400 bg-amber-500/10",
    deploying: "border-blue-500/50 text-blue-400 bg-blue-500/10",
    active: "border-green-500/50 text-green-400 bg-green-500/10",
    completed: "border-muted text-muted-foreground bg-muted/20",
    declined: "border-red-500/50 text-red-400 bg-red-500/10",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono tracking-widest uppercase border ${variants[status] ?? variants.pending}`}>
      {status}
    </span>
  );
}

export default function Lobby() {
  const { data: lobby, isLoading } = useGetLobby();
  const { data: profile } = useGetMyProfile();
  const qc = useQueryClient();
  const updateProfile = useUpdateMyProfile();

  const [editing, setEditing] = useState(false);
  const [callsign, setCallsign] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const startEdit = () => {
    setCallsign(profile?.username ?? "");
    setEditError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditError(null);
  };

  const saveCallsign = () => {
    const trimmed = callsign.trim();
    if (trimmed.length < 2 || trimmed.length > 24) {
      setEditError("Callsign must be 2–24 characters.");
      return;
    }
    if (!/^[A-Za-z0-9 _-]+$/.test(trimmed)) {
      setEditError("Use letters, numbers, spaces, - or _ only.");
      return;
    }
    updateProfile.mutate(
      { data: { username: trimmed } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetMyProfileQueryKey() });
          qc.invalidateQueries({ queryKey: getGetLobbyQueryKey() });
          setEditing(false);
        },
        onError: (err) => setEditError((err as Error).message || "Could not update callsign."),
      },
    );
  };

  return (
    <Layout title="Command Lobby">
      <div className="p-6 max-w-5xl mx-auto space-y-8">
        {/* Profile bar */}
        {profile && (
          <div data-testid="profile-bar" className="flex items-center justify-between border border-border bg-card rounded-md px-5 py-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center text-primary font-bold text-sm">
                {profile.username?.slice(0, 1).toUpperCase()}
              </div>
              {editing ? (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <Input
                      data-testid="input-callsign"
                      value={callsign}
                      onChange={(e) => setCallsign(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveCallsign();
                        if (e.key === "Escape") cancelEdit();
                      }}
                      maxLength={24}
                      autoFocus
                      placeholder="Your callsign"
                      className="h-8 w-48 bg-background font-bold tracking-wide text-sm"
                    />
                    <Button
                      size="sm"
                      data-testid="button-save-callsign"
                      className="h-8 w-8 p-0"
                      disabled={updateProfile.isPending}
                      onClick={saveCallsign}
                    >
                      <Check className="w-4 h-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="button-cancel-callsign"
                      className="h-8 w-8 p-0"
                      disabled={updateProfile.isPending}
                      onClick={cancelEdit}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                  {editError && (
                    <span data-testid="text-callsign-error" className="text-[11px] text-red-400 font-mono">{editError}</span>
                  )}
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-2">
                    <span data-testid="text-username" className="font-bold tracking-wide text-sm">{profile.username}</span>
                    <button
                      type="button"
                      data-testid="button-edit-callsign"
                      onClick={startEdit}
                      className="text-muted-foreground hover:text-primary transition-colors"
                      title="Edit callsign"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="text-xs text-muted-foreground font-mono">{profile.gamesPlayed} engagements &mdash; {profile.wins}W / {profile.losses}L</div>
                </div>
              )}
            </div>
            <Link href="/games/new">
              <Button size="sm" data-testid="button-new-game" className="gap-2 uppercase tracking-widest text-xs font-bold">
                <Plus className="w-3 h-3" /> New Engagement
              </Button>
            </Link>
          </div>
        )}

        {/* Pending challenges */}
        <section>
          <h2 className="flex items-center gap-2 text-xs font-mono tracking-[0.3em] uppercase text-muted-foreground mb-3">
            <Clock className="w-3.5 h-3.5 text-amber-400" /> Incoming Challenges
          </h2>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : lobby?.pendingChallenges?.length === 0 ? (
            <div className="border border-dashed border-border rounded-md py-8 text-center text-muted-foreground text-sm">
              No pending challenges
            </div>
          ) : (
            <div className="space-y-2">
              {lobby?.pendingChallenges?.map(game => (
                <Link key={game.id} href={`/games/${game.id}`}>
                  <div data-testid={`card-challenge-${game.id}`} className="flex items-center justify-between border border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10 rounded-md px-4 py-3 cursor-pointer transition-colors">
                    <div className="flex items-center gap-3">
                      <Swords className="w-4 h-4 text-amber-400" />
                      <div>
                        <div className="text-sm font-semibold">{game.challengerName ?? "Unknown Commander"}</div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {priorityLabel(normalizePriorityLevel(game.priorityLevel))} {game.allocationPoints} FAP
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge status={game.status} />
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* Active games */}
        <section>
          <h2 className="flex items-center gap-2 text-xs font-mono tracking-[0.3em] uppercase text-muted-foreground mb-3">
            <Target className="w-3.5 h-3.5 text-green-400" /> Active Operations
          </h2>
          {isLoading ? (
            <div className="space-y-2"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
          ) : lobby?.activeGames?.length === 0 ? (
            <div className="border border-dashed border-border rounded-md py-8 text-center text-muted-foreground text-sm">
              No active operations &mdash; <Link href="/games/new" className="text-primary hover:underline">launch one</Link>
            </div>
          ) : (
            <div className="space-y-2">
              {lobby?.activeGames?.map(game => (
                <Link key={game.id} href={`/games/${game.id}`}>
                  <div data-testid={`card-active-${game.id}`} className="flex items-center justify-between border border-green-500/20 bg-green-500/5 hover:bg-green-500/10 rounded-md px-4 py-3 cursor-pointer transition-colors">
                    <div className="flex items-center gap-3">
                      <Target className="w-4 h-4 text-green-400" />
                      <div>
                        <div className="text-sm font-semibold">
                          {game.challengerName} vs {game.opponentName}
                        </div>
                        <div className="text-xs text-muted-foreground font-mono">
                          Turn {game.currentTurn} - {priorityLabel(normalizePriorityLevel(game.priorityLevel))} {game.allocationPoints} FAP
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge status={game.status} />
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* Recently completed */}
        <section>
          <h2 className="flex items-center gap-2 text-xs font-mono tracking-[0.3em] uppercase text-muted-foreground mb-3">
            <Trophy className="w-3.5 h-3.5 text-muted-foreground" /> Recent Engagements
          </h2>
          {isLoading ? (
            <Skeleton className="h-14 w-full" />
          ) : lobby?.recentlyCompleted?.length === 0 ? (
            <div className="border border-dashed border-border rounded-md py-6 text-center text-muted-foreground text-sm">
              No completed games yet
            </div>
          ) : (
            <div className="space-y-2">
              {lobby?.recentlyCompleted?.map(game => (
                <Link key={game.id} href={`/games/${game.id}`}>
                  <div data-testid={`card-completed-${game.id}`} className="flex items-center justify-between border border-border bg-card/50 hover:bg-card rounded-md px-4 py-3 cursor-pointer transition-colors opacity-70 hover:opacity-100">
                    <div className="text-sm">{game.challengerName} vs {game.opponentName}</div>
                    <div className="flex items-center gap-3">
                      <StatusBadge status={game.status} />
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </Layout>
  );
}
