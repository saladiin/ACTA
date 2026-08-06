import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import {
  customFetch,
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
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Swords, Clock, Trophy, Plus, ChevronRight, Target, Pencil, Check, X, MessageSquare, Send, ChevronDown, ChevronUp } from "lucide-react";
import { normalizePriorityLevel, priorityLabel } from "@/lib/fleet-allocation";
import { setDevUserId, useDevUserId } from "@/lib/dev-user";
import { getTemporaryUserId, temporaryUsernameAuthEnabled, useTemporaryUsername } from "@/lib/temporary-user";

type LobbyChatMessage = {
  id: number;
  senderPlayerId: string;
  senderName: string | null;
  message: string;
  createdAt: string;
};

type LobbyChatResponse = {
  messages: LobbyChatMessage[];
};

function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return fallback;
}

function chatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

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

function LobbyChatPanel({ myUserId }: { myUserId: string }) {
  const qc = useQueryClient();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const queryKey = ["lobby-chat"] as const;
  const chatQuery = useQuery({
    queryKey,
    queryFn: () =>
      customFetch<LobbyChatResponse>("/api/lobby/chat", {
        responseType: "json",
      }),
    refetchInterval: open ? 5000 : 10000,
  });
  const messages = chatQuery.data?.messages ?? [];
  const latest = messages.length > 0 ? messages[messages.length - 1] : null;
  const sendMessage = useMutation({
    mutationFn: (message: string) =>
      customFetch<{ message: LobbyChatMessage }>("/api/lobby/chat", {
        method: "POST",
        responseType: "json",
        body: JSON.stringify({ message }),
      }),
    onMutate: () => {
      setError(null);
    },
    onSuccess: async (response) => {
      setDraft("");
      setError(null);
      setOpen(true);
      qc.setQueryData<LobbyChatResponse>(queryKey, (current) => {
        const currentMessages = current?.messages ?? [];
        return {
          messages: [...currentMessages, response.message].slice(-50),
        };
      });
      await qc.invalidateQueries({ queryKey });
    },
    onError: (err) => {
      setError(apiErrorMessage(err, "Lobby chat send failed"));
    },
  });
  const trimmed = draft.trim();
  const canSend = trimmed.length > 0 && trimmed.length <= 500 && !sendMessage.isPending;

  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, open]);

  const submit = () => {
    if (!trimmed) {
      setError("Type a message first.");
      return;
    }
    if (trimmed.length > 500) {
      setError("Message must be 500 characters or fewer.");
      return;
    }
    if (sendMessage.isPending) return;
    sendMessage.mutate(trimmed);
  };

  return (
    <aside
      className={
        open
          ? "fixed inset-x-0 bottom-0 z-50 border-t border-amber-500/30 bg-background/95 shadow-2xl shadow-black/60 backdrop-blur"
          : "fixed bottom-8 right-5 z-50 rounded-t-md border border-amber-500/60 bg-black/90 shadow-2xl shadow-black/60 backdrop-blur"
      }
      data-testid="lobby-chat-panel"
    >
      <button
        type="button"
        className={
          open
            ? "flex w-full items-center justify-between gap-3 border-b border-border/70 px-4 py-2 text-left"
            : "flex items-center justify-center gap-2 px-4 py-2"
        }
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        data-testid="button-toggle-lobby-chat"
      >
        <span className="flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-[0.18em] text-amber-300">
          {open ? <MessageSquare className="h-4 w-4" /> : <ChevronUp className="h-3.5 w-3.5" />}
          {open ? "Lobby Chat" : "Chat"}
          {messages.length > 0 && (
            <span className="rounded border border-amber-400/40 px-1.5 py-0.5 text-[10px] text-amber-200">
              {messages.length}
            </span>
          )}
        </span>
        {open && (
          <span className="flex min-w-0 items-center gap-3">
            {latest ? (
              <span className="hidden truncate text-xs text-muted-foreground sm:block">
                {latest.senderName ?? "Commander"}: {latest.message}
              </span>
            ) : null}
            <ChevronDown className="h-4 w-4" />
          </span>
        )}
      </button>
      {open && (
        <div className="grid gap-3 p-3">
          <div
            ref={scrollRef}
            className="max-h-56 overflow-y-auto rounded border border-border/70 bg-black/30 p-2"
            data-testid="lobby-chat-messages"
          >
            {messages.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                {chatQuery.isError
                  ? apiErrorMessage(chatQuery.error, "Lobby chat could not load.")
                  : "Lobby channel is quiet."}
              </div>
            ) : (
              <div className="space-y-2">
                {messages.map((message) => {
                  const mine = message.senderPlayerId === myUserId;
                  const sender = message.senderName ?? "Commander";
                  return (
                    <div
                      key={message.id}
                      className={`rounded border px-2 py-1.5 text-xs ${
                        mine
                          ? "ml-auto max-w-[88%] border-amber-400/30 bg-amber-400/10"
                          : "mr-auto max-w-[88%] border-border/80 bg-card/70"
                      }`}
                      data-testid={`lobby-chat-message-${message.id}`}
                    >
                      <div className="flex items-center justify-end gap-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                        <span>{chatTime(message.createdAt)}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed text-foreground">
                        <span className={mine ? "font-semibold text-amber-200" : "font-semibold text-zinc-200"}>
                          [{sender}]:
                        </span>{" "}
                        {message.message}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <div>
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value.slice(0, 500))}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder="Message the lobby..."
                className="min-h-16 resize-none bg-black/30 font-mono text-xs"
                maxLength={500}
                data-testid="textarea-lobby-chat"
              />
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] text-muted-foreground">
                  {draft.length}/500
                </span>
                {error && (
                  <span className="text-right font-mono text-[10px] text-red-400" data-testid="text-lobby-chat-error">
                    {error}
                  </span>
                )}
              </div>
            </div>
            <Button
              className="h-16 gap-2 self-start font-mono text-xs uppercase tracking-widest"
              disabled={!canSend}
              onClick={submit}
              data-testid="button-send-lobby-chat"
            >
              <Send className="h-3.5 w-3.5" />
              {sendMessage.isPending ? "Sending" : "Send"}
            </Button>
          </div>
        </div>
      )}
    </aside>
  );
}

export default function Lobby() {
  const { data: lobby, isLoading } = useGetLobby();
  const { data: profile } = useGetMyProfile();
  const user = temporaryUsernameAuthEnabled ? null : useUser().user;
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
      <div className="p-6 pb-80 max-w-5xl mx-auto space-y-8">
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
      <LobbyChatPanel myUserId={myUserId} />
    </Layout>
  );
}
