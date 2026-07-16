import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Archive, RefreshCw, ShieldCheck, Trash2, Users } from "lucide-react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type AdminGame = {
  id: number;
  challengerName: string | null;
  opponentName: string | null;
  challengerId: string;
  opponentId: string | null;
  opponentKind: string;
  status: string;
  currentRound: number;
  currentTurn: number;
  phase: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  archiveExpiresAt: string | null;
  lastActivityAt: string;
  idleSeconds: number;
};

type AdminGamesResponse = {
  games: AdminGame[];
};

type AdminAccount = {
  id: string;
  username: string | null;
  name: string | null;
  primaryEmail: string | null;
  primaryEmailVerificationStatus: string | null;
  emails: Array<{
    emailAddress: string;
    verificationStatus: string | null;
  }>;
  createdAt: string | null;
  lastSignInAt: string | null;
  lastActiveAt: string | null;
  banned: boolean;
  locked: boolean;
  gameAllowed: boolean;
  adminAllowed: boolean;
};

type AdminUsersResponse = {
  totalCount: number;
  limit: number;
  users: AdminAccount[];
};

type AdminMeResponse = {
  isAdmin: boolean;
};

function formatIdle(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

function formatDateTime(value: string | null): string {
  if (!value) return "none";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    open: "border-amber-500/50 bg-amber-500/10 text-amber-300",
    pending: "border-amber-500/50 bg-amber-500/10 text-amber-300",
    deploying: "border-blue-500/50 bg-blue-500/10 text-blue-300",
    active: "border-green-500/50 bg-green-500/10 text-green-300",
    completed: "border-muted bg-muted/20 text-muted-foreground",
    declined: "border-red-500/50 bg-red-500/10 text-red-300",
  };
  return (
    <span className={`inline-flex rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${variants[status] ?? variants.pending}`}>
      {status}
    </span>
  );
}

export default function AdminPage() {
  const qc = useQueryClient();
  const adminMe = useQuery({
    queryKey: ["admin-me"],
    queryFn: () => customFetch<AdminMeResponse>("/api/admin/me", { responseType: "json" }),
    retry: false,
    staleTime: 60_000,
  });
  const gamesQuery = useQuery({
    queryKey: ["admin-games"],
    queryFn: () => customFetch<AdminGamesResponse>("/api/admin/games", { responseType: "json" }),
    enabled: adminMe.data?.isAdmin === true,
    retry: false,
  });
  const usersQuery = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => customFetch<AdminUsersResponse>("/api/admin/users", { responseType: "json" }),
    enabled: adminMe.data?.isAdmin === true,
    retry: false,
  });

  const archiveGame = useMutation({
    mutationFn: (gameId: number) => customFetch(`/api/admin/games/${gameId}/archive`, {
      method: "POST",
      responseType: "json",
      body: JSON.stringify({ days: 14 }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-games"] }),
  });

  const deleteGame = useMutation({
    mutationFn: (gameId: number) => customFetch(`/api/admin/games/${gameId}`, {
      method: "DELETE",
      responseType: "text",
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-games"] }),
  });

  const isAdmin = adminMe.data?.isAdmin === true;
  const now = Date.now();

  return (
    <Layout title="Admin">
      <div className="mx-auto max-w-5xl p-4 md:p-6">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-primary">
              <ShieldCheck className="h-4 w-4" />
              Operations Control
            </div>
            <p className="mt-1 text-xs font-mono text-muted-foreground">
              Accounts, idle games, archive window, and destructive cleanup.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="gap-2 font-mono text-xs uppercase tracking-widest"
            onClick={() => {
              usersQuery.refetch();
              gamesQuery.refetch();
            }}
            disabled={!isAdmin || gamesQuery.isFetching || usersQuery.isFetching}
            data-testid="button-admin-refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>

        {adminMe.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : !isAdmin ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-5">
            <div className="font-mono text-sm uppercase tracking-widest text-destructive">Admin access required</div>
            <p className="mt-2 text-sm text-muted-foreground">
              This account is not included in the server-side admin allowlist.
            </p>
          </div>
        ) : gamesQuery.data?.games.length === 0 ? (
          <AdminContent
            games={[]}
            gamesLoading={gamesQuery.isLoading}
            users={usersQuery.data}
            usersLoading={usersQuery.isLoading}
            archiveGameId={(gameId) => archiveGame.mutate(gameId)}
            deleteGameId={(gameId) => deleteGame.mutate(gameId)}
            actionsDisabled={archiveGame.isPending || deleteGame.isPending}
            now={now}
          />
        ) : (
          <AdminContent
            games={gamesQuery.data?.games ?? []}
            gamesLoading={gamesQuery.isLoading}
            users={usersQuery.data}
            usersLoading={usersQuery.isLoading}
            archiveGameId={(gameId) => archiveGame.mutate(gameId)}
            deleteGameId={(gameId) => deleteGame.mutate(gameId)}
            actionsDisabled={archiveGame.isPending || deleteGame.isPending}
            now={now}
          />
        )}
      </div>
    </Layout>
  );
}

function FlagBadge({ active, label }: { active: boolean; label: string }) {
  return (
    <span className={`inline-flex rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${
      active
        ? "border-green-500/50 bg-green-500/10 text-green-300"
        : "border-zinc-500/40 bg-zinc-500/10 text-zinc-400"
    }`}>
      {label}
    </span>
  );
}

function AdminContent({
  games,
  gamesLoading,
  users,
  usersLoading,
  archiveGameId,
  deleteGameId,
  actionsDisabled,
  now,
}: {
  games: AdminGame[];
  gamesLoading: boolean;
  users?: AdminUsersResponse;
  usersLoading: boolean;
  archiveGameId: (gameId: number) => void;
  deleteGameId: (gameId: number) => void;
  actionsDisabled: boolean;
  now: number;
}) {
  return (
    <div className="space-y-6">
      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            <Users className="h-4 w-4" />
            Signed-Up Accounts
          </div>
          {users && (
            <div className="font-mono text-[11px] text-muted-foreground">
              showing {users.users.length} of {users.totalCount}
            </div>
          )}
        </div>
        {usersLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : !users || users.users.length === 0 ? (
          <div className="rounded-md border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
            No Clerk accounts found.
          </div>
        ) : (
          <div className="space-y-2">
            {users.users.map((user) => (
              <div key={user.id} className="rounded-md border border-border bg-card px-4 py-3" data-testid={`admin-user-${user.id}`}>
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold">{user.primaryEmail ?? user.username ?? user.id}</span>
                      <FlagBadge active={user.gameAllowed} label={user.gameAllowed ? "allowed" : "not allowed"} />
                      <FlagBadge active={user.adminAllowed} label="admin" />
                      {user.banned && <FlagBadge active={false} label="banned" />}
                      {user.locked && <FlagBadge active={false} label="locked" />}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono text-muted-foreground">
                      <span>{user.id}</span>
                      {user.username && <span>@{user.username}</span>}
                      {user.name && <span>{user.name}</span>}
                    </div>
                    <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
                      <span>Joined: <span className="font-mono text-foreground">{formatDateTime(user.createdAt)}</span></span>
                      <span>Last sign-in: <span className="font-mono text-foreground">{formatDateTime(user.lastSignInAt)}</span></span>
                      <span>Email: <span className="font-mono text-foreground">{user.primaryEmailVerificationStatus ?? "unknown"}</span></span>
                    </div>
                    {user.emails.length > 1 && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        {user.emails.map((email) => `${email.emailAddress} (${email.verificationStatus ?? "unknown"})`).join(", ")}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          <ShieldCheck className="h-4 w-4" />
          Games
        </div>
        {gamesLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : games.length === 0 ? (
          <div className="rounded-md border border-dashed border-border py-14 text-center text-sm text-muted-foreground">
            No games found.
          </div>
        ) : (
          <div className="space-y-2">
            {games.map((game) => {
              const title = `${game.challengerName ?? "Unknown"} vs ${game.opponentName ?? (game.opponentKind === "ai" ? "AI" : "Open Slot")}`;
              const archiveUntil = game.archiveExpiresAt ? new Date(game.archiveExpiresAt).getTime() : 0;
              const isArchived = archiveUntil > now;
              return (
                <div
                  key={game.id}
                  className="rounded-md border border-border bg-card px-4 py-3"
                  data-testid={`admin-game-${game.id}`}
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {isArchived ? (
                          <span className="truncate text-sm font-semibold">{title}</span>
                        ) : (
                          <Link href={`/games/${game.id}`} className="truncate text-sm font-semibold hover:text-primary">
                            {title}
                          </Link>
                        )}
                        <StatusBadge status={game.status} />
                        {isArchived && (
                          <span className="inline-flex rounded border border-zinc-500/50 bg-zinc-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-zinc-300">
                            archived
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono text-muted-foreground">
                        <span>Game {game.id}</span>
                        <span>Round {game.currentRound}</span>
                        <span>Turn {game.currentTurn}</span>
                        <span>{game.phase}</span>
                      </div>
                      <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
                        <span>Idle: <span className="font-mono text-foreground">{formatIdle(game.idleSeconds)}</span></span>
                        <span>Last activity: <span className="font-mono text-foreground">{formatDateTime(game.lastActivityAt)}</span></span>
                        <span>Archive until: <span className="font-mono text-foreground">{formatDateTime(game.archiveExpiresAt)}</span></span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-2 font-mono text-xs uppercase tracking-widest"
                        disabled={actionsDisabled || isArchived}
                        onClick={() => {
                          if (window.confirm(`Archive game ${game.id} for 14 days? Players will no longer see it in normal game lists.`)) {
                            archiveGameId(game.id);
                          }
                        }}
                        data-testid={`button-admin-archive-${game.id}`}
                      >
                        <Archive className="h-3.5 w-3.5" />
                        Archive 14d
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="gap-2 font-mono text-xs uppercase tracking-widest"
                        disabled={actionsDisabled}
                        onClick={() => {
                          if (window.confirm(`Delete game ${game.id} outright? This removes units, turns, logs, chat, bug reports, and the game record.`)) {
                            deleteGameId(game.id);
                          }
                        }}
                        data-testid={`button-admin-delete-${game.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
