import { Link } from "wouter";
import { useListGames } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Plus, ChevronRight, Target } from "lucide-react";

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

export default function GamesList() {
  const { data: games, isLoading } = useListGames();

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
                    <div className="text-xs text-muted-foreground font-mono">Turn {game.currentTurn} &mdash; {game.pointLimit} pts</div>
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
      </div>
    </Layout>
  );
}
