import { Link } from "wouter";
import { useUser } from "@clerk/react";
import { useListGames } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Plus, ChevronRight, Target } from "lucide-react";
import { normalizePriorityLevel, priorityLabel } from "@/lib/fleet-allocation";
import { useDevUserId } from "@/lib/dev-user";
import { getTemporaryUserId, temporaryUsernameAuthEnabled, useTemporaryUsername } from "@/lib/temporary-user";

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

type TurnSummaryGame = {
  activePlayerId?: string | null;
  challengerId: string;
  challengerName?: string | null;
  opponentId?: string | null;
  opponentName?: string | null;
  status?: string;
};

function turnSummaryFor(game: TurnSummaryGame, myUserId: string): { label: string; mine: boolean } {
  if (!game.activePlayerId) return { label: "Turn pending", mine: false };
  if (game.activePlayerId === myUserId) return { label: "Your turn", mine: true };
  if (game.activePlayerId === game.challengerId) {
    return { label: `${game.challengerName ?? "Opponent"}'s turn`, mine: false };
  }
  if (game.activePlayerId === game.opponentId) {
    return { label: `${game.opponentName ?? "Opponent"}'s turn`, mine: false };
  }
  return { label: "Opponent's turn", mine: false };
}

function TurnBadge({ game, myUserId }: { game: TurnSummaryGame; myUserId: string }) {
  if (game.status !== "active" && game.status !== "deploying") return null;
  if (!game.activePlayerId) return null;
  const summary = turnSummaryFor(game, myUserId);
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono tracking-widest uppercase border ${
        summary.mine
          ? "border-green-400/60 bg-green-400/15 text-green-300"
          : "border-amber-400/40 bg-amber-400/10 text-amber-300"
      }`}
      data-testid={`badge-turn-${summary.mine ? "mine" : "opponent"}-${game.activePlayerId ?? "pending"}`}
    >
      {summary.label}
    </span>
  );
}

export default function GamesList() {
  const { data: games, isLoading } = useListGames();
  const { user } = useUser();
  const devUserId = useDevUserId();
  const temporaryUsername = useTemporaryUsername();
  void temporaryUsername;
  const myUserId = temporaryUsernameAuthEnabled
    ? getTemporaryUserId() ?? ""
    : import.meta.env.DEV ? devUserId : (user?.id ?? "");

  return (
    <Layout title="Active Operations">
      <div className="p-6 max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <p className="text-xs text-muted-foreground font-mono tracking-wider">
            {games?.length ?? 0} engagement{games?.length !== 1 ? "s" : ""} on record
          </p>
          <Link href="/games/new">
            <Button size="sm" data-testid="button-new-game" className="gap-2 uppercase tracking-widest text-xs font-bold">
              <Plus className="w-3 h-3" /> New Engagement
            </Button>
          </Link>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : games?.length === 0 ? (
          <div className="border border-dashed border-border rounded-md py-16 text-center space-y-3">
            <Target className="w-10 h-10 text-muted-foreground mx-auto opacity-30" />
            <p className="text-sm text-muted-foreground">No engagements found.</p>
            <Link href="/games/new">
              <Button size="sm" variant="outline" className="uppercase tracking-widest text-xs">
                <Plus className="w-3 h-3 mr-1" /> Launch Engagement
              </Button>
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {games?.map(game => (
              <Link key={game.id} href={`/games/${game.id}`}>
                <div data-testid={`card-game-${game.id}`} className="flex items-center justify-between border border-border bg-card hover:bg-secondary/20 rounded-md px-4 py-3 cursor-pointer transition-colors">
                  <div>
                    <div className="text-sm font-semibold">{game.challengerName ?? "Unknown"} vs {game.opponentName ?? "Unknown"}</div>
                    {game.matchName ? <div className="text-sm text-foreground/90">{game.matchName}</div> : null}
                    <div className="text-xs text-muted-foreground font-mono">
                      Turn {game.currentTurn} - {priorityLabel(normalizePriorityLevel(game.priorityLevel))} {game.allocationPoints} FAP
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusBadge status={game.status} />
                    <TurnBadge game={game} myUserId={myUserId} />
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
