import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import {
  setExtraHeaders,
  useAcceptGame,
  useGetLobby,
  useGetMyProfile,
  useUpdateMyProfile,
  getGetMyProfileQueryKey,
  getGetLobbyQueryKey,
  getListGamesQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Swords, Clock, Trophy, Plus, ChevronRight, Target, Pencil, Check, X } from "lucide-react";
import { normalizePriorityLevel, priorityLabel } from "@/lib/fleet-allocation";
import { setDevUserId, useDevUserId } from "@/lib/dev-user";
import { getTemporaryUserId, temporaryUsernameAuthEnabled, useTemporaryUsername } from "@/lib/temporary-user";

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    open: "border-amber-500/50 text-amber-400 bg-amber-500/10",
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

function FeatureBadge({ label }: { label: "Terrain" | "Station" }) {
  const className = label === "Terrain"
    ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-300"
    : "border-cyan-400/50 bg-cyan-400/10 text-cyan-300";

  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-widest ${className}`}>
      {label}
    </span>
  );
}

function ChallengeFeatureBadges({ game }: { game: { hasTerrain?: boolean; hasStation?: boolean } }) {
  if (!game.hasTerrain && !game.hasStation) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {game.hasTerrain ? <FeatureBadge label="Terrain" /> : null}
      {game.hasStation ? <FeatureBadge label="Station" /> : null}
    </div>
  );
}

export default function Lobby() {
  const { data: lobby, isLoading } = useGetLobby();
  const { data: profile } = useGetMyProfile();
  const { user } = useUser();
  const devUserId = useDevUserId();
  const temporaryUsername = useTemporaryUsername();
  void temporaryUsername;
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const updateProfile = useUpdateMyProfile();
  const acceptGame = useAcceptGame();
  const myUserId = temporaryUsernameAuthEnabled
    ? getTemporaryUserId() ?? ""
    : import.meta.env.DEV ? devUserId : (user?.id ?? "");

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

  const acceptFromLobby = (gameId: number, options?: { switchToDevUserId?: string; password?: string }) => {
    if (options?.switchToDevUserId && import.meta.env.DEV) {
      setExtraHeaders({ "x-dev-user-id": options.switchToDevUserId });
      setDevUserId(options.switchToDevUserId);
    }

    acceptGame.mutate(
      {
        gameId,
        data: options?.password ? { password: options.password } : {},
      },
      {
        onSuccess: (game) => {
          qc.invalidateQueries({ queryKey: getGetLobbyQueryKey() });
          qc.invalidateQueries({ queryKey: getListGamesQueryKey() });
          setLocation(`/games/${game.id}`);
        },
      },
    );
  };

  const otherDevUserId = devUserId === "test-user-1" ? "test-user-2" : "test-user-1";
  const otherDevLabel = otherDevUserId === "test-user-1" ? "P1" : "P2";

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

        {/* Open / pending challenges */}
        <section>
          <h2 className="flex items-center gap-2 text-xs font-mono tracking-[0.3em] uppercase text-muted-foreground mb-3">
            <Clock className="w-3.5 h-3.5 text-amber-400" /> Open Challenges
          </h2>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : lobby?.pendingChallenges?.length === 0 ? (
            <div className="border border-dashed border-border rounded-md py-8 text-center text-muted-foreground text-sm">
              No open challenges
            </div>
          ) : (
            <div className="space-y-2">
              {lobby?.pendingChallenges?.map(game => {
                const isChallenger = game.challengerId === myUserId;
                const canJoinFromLobby = game.status === "open" && !game.hasPassword && !isChallenger;
                const canDevJoinOwnOpenChallenge = import.meta.env.DEV && game.status === "open" && !game.hasPassword && isChallenger;
                const joinLabel = canDevJoinOwnOpenChallenge ? `Join as ${otherDevLabel}` : game.hasPassword ? "Enter Password" : "Join";
                return (
                  <div
                    key={game.id}
                    data-testid={`card-challenge-${game.id}`}
                    className="flex items-center justify-between gap-3 border border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10 rounded-md px-4 py-3 cursor-pointer transition-colors"
                    onClick={() => setLocation(`/games/${game.id}`)}
                  >
                    <div className="flex items-center gap-3">
                      <Swords className="w-4 h-4 text-amber-400" />
                      <div>
                        <div className="text-sm font-semibold">{game.challengerName ?? "Unknown Commander"}</div>
                        <div className="text-sm text-foreground/90">
                          {game.matchName || "Open engagement"}
                        </div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {priorityLabel(normalizePriorityLevel(game.priorityLevel))} {game.allocationPoints} FAP
                          {isChallenger && game.status === "open" ? " - awaiting opponent" : ""}
                        </div>
                        <ChallengeFeatureBadges game={game} />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={game.status} />
                      {(canJoinFromLobby || canDevJoinOwnOpenChallenge || game.hasPassword) && (
                        <Button
                          size="sm"
                          variant={game.hasPassword ? "outline" : "default"}
                          className="h-8 px-3 text-[10px] uppercase tracking-widest"
                          disabled={acceptGame.isPending}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (game.hasPassword) {
                              setLocation(`/games/${game.id}`);
                              return;
                            }
                            acceptFromLobby(
                              game.id,
                              canDevJoinOwnOpenChallenge ? { switchToDevUserId: otherDevUserId } : undefined,
                            );
                          }}
                          data-testid={`button-join-challenge-${game.id}`}
                        >
                          {joinLabel}
                        </Button>
                      )}
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {acceptGame.isError && (
            <p className="mt-2 text-[11px] text-red-400 font-mono" data-testid="text-lobby-accept-error">
              {(acceptGame.error as Error).message}
            </p>
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
                        {game.matchName ? <div className="text-sm text-foreground/90">{game.matchName}</div> : null}
                        <div className="text-xs text-muted-foreground font-mono">
                          Turn {game.currentTurn} - {priorityLabel(normalizePriorityLevel(game.priorityLevel))} {game.allocationPoints} FAP
                        </div>
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
                    <div>
                      <div className="text-sm">{game.challengerName} vs {game.opponentName}</div>
                      {game.matchName ? <div className="text-xs text-muted-foreground">{game.matchName}</div> : null}
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
      </div>
    </Layout>
  );
}
