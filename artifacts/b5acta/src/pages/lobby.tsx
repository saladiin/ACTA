import { Link } from "wouter";
import { useGetLobby, useGetMyProfile } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Swords, Clock, Trophy, Plus, ChevronRight, Target } from "lucide-react";

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
              <div>
                <div data-testid="text-username" className="font-bold tracking-wide text-sm">{profile.username}</div>
                <div className="text-xs text-muted-foreground font-mono">{profile.gamesPlayed} engagements &mdash; {profile.wins}W / {profile.losses}L</div>
              </div>
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
                        <div className="text-xs text-muted-foreground font-mono">{game.pointLimit} pts</div>
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
                        <div className="text-xs text-muted-foreground font-mono">Turn {game.currentTurn} &mdash; {game.pointLimit} pts</div>
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
