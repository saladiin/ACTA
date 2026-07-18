import { Link } from "wouter";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import {
  Archive,
  CheckCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
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

type AdminBugReport = {
  id: number;
  gameId: number;
  reporterPlayerId: string;
  round: number;
  phase: string;
  activePlayerId: string | null;
  activeUnitId: number | null;
  message: string;
  rescueRequested: boolean;
  rescueApplied: boolean;
  snapshot: Record<string, unknown>;
  resolvedAt: string | null;
  resolvedByAdminId: string | null;
  createdAt: string;
  challengerName: string | null;
  opponentName: string | null;
  opponentKind: string | null;
  gameStatus: string | null;
  gamePhase: string | null;
  gameRound: number | null;
};

type AdminBugReportsResponse = {
  count: number;
  reports: AdminBugReport[];
};

function snapshotRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function snapshotValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function unitSnapshotLabel(value: unknown): string | null {
  const unit = snapshotRecord(value);
  if (!unit) return null;
  const name = snapshotValue(unit.name) ?? "Unit";
  const id = snapshotValue(unit.id);
  const owner = snapshotValue(unit.ownerId);
  const hull = snapshotValue(unit.hullPoints);
  const maxHull = snapshotValue(unit.maxHullPoints);
  const crew = snapshotValue(unit.crewPoints);
  const maxCrew = snapshotValue(unit.maxCrewPoints);
  const position =
    snapshotValue(unit.hexQ) != null && snapshotValue(unit.hexR) != null
      ? `pos ${snapshotValue(unit.hexQ)}, ${snapshotValue(unit.hexR)}`
      : null;
  const health =
    hull != null && maxHull != null && crew != null && maxCrew != null
      ? `hull ${hull}/${maxHull}, crew ${crew}/${maxCrew}`
      : null;
  return [
    id ? `${name} #${id}` : name,
    owner ? `owner ${owner}` : null,
    health,
    position,
    snapshotValue(unit.heading) != null ? `heading ${snapshotValue(unit.heading)}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
}

function bugSnapshotSummary(snapshot: Record<string, unknown>): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const game = snapshotRecord(snapshot.game);
  const reporter = snapshotRecord(snapshot.reporter);
  const rescue = snapshotRecord(snapshot.rescue);
  const client = snapshotRecord(snapshot.client);
  const activeUnit = unitSnapshotLabel(snapshot.activeUnit);
  const selectedUnit = unitSnapshotLabel(snapshot.selectedUnit);
  const nearbyUnits = Array.isArray(snapshot.nearbyUnits) ? snapshot.nearbyUnits : [];
  const auditTail = snapshotRecord(snapshot.auditTail);
  const movementTail = Array.isArray(auditTail?.movement) ? auditTail.movement : [];
  const attackTail = Array.isArray(auditTail?.attacks) ? auditTail.attacks : [];
  const specialTail = Array.isArray(auditTail?.specialActions) ? auditTail.specialActions : [];

  const add = (label: string, value: unknown) => {
    const rendered = snapshotValue(value);
    if (rendered != null) rows.push({ label, value: rendered });
  };

  if (game) {
    rows.push({
      label: "game",
      value: [
        `round ${snapshotValue(game.round) ?? "?"}`,
        snapshotValue(game.phase) ?? "unknown phase",
        `active ${snapshotValue(game.activePlayerId) ?? "none"}`,
        `unit ${snapshotValue(game.activeUnitId) ?? "none"}`,
      ].join(" | "),
    });
  }
  if (client) {
    rows.push({
      label: "client",
      value: [
        snapshotValue(client.phase) ?? "unknown phase",
        `selected ${snapshotValue(client.selectedUnitId) ?? "none"}`,
        `active ${snapshotValue(client.activeUnitId) ?? "none"}`,
        `input ${snapshotValue(client.inputProfile) ?? "unknown"}`,
      ].join(" | "),
    });
  }
  if (reporter) {
    rows.push({
      label: "reporter",
      value: [
        snapshotValue(reporter.playerId) ?? "unknown",
        `can rescue ${snapshotValue(reporter.canRescue) ?? "?"}`,
      ].join(" | "),
    });
  }
  if (rescue) {
    rows.push({
      label: "rescue",
      value: [
        `requested ${snapshotValue(rescue.requested) ?? "?"}`,
        `applied ${snapshotValue(rescue.applied) ?? "?"}`,
        `eligible ${snapshotValue(rescue.eligiblePhase) ?? "?"}`,
      ].join(" | "),
    });
  }
  if (activeUnit) rows.push({ label: "active unit", value: activeUnit });
  if (selectedUnit) rows.push({ label: "selected unit", value: selectedUnit });
  add("move plan", client?.movePlan ? JSON.stringify(client.movePlan) : null);
  add("gesture", client?.movementGesture ? JSON.stringify(client.movementGesture) : null);
  add("move target", client?.moveTarget ? JSON.stringify(client.moveTarget) : null);
  add("attack target", client?.attackTarget);
  rows.push({
    label: "nearby",
    value: `${nearbyUnits.length} captured${nearbyUnits[0] ? ` | closest ${unitSnapshotLabel(nearbyUnits[0]) ?? "unknown"}` : ""}`,
  });
  rows.push({
    label: "audit tail",
    value: `moves ${movementTail.length} | attacks ${attackTail.length} | special ${specialTail.length}`,
  });

  return rows;
}

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
    <span
      className={`inline-flex rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${variants[status] ?? variants.pending}`}
    >
      {status}
    </span>
  );
}

export default function AdminPage() {
  const qc = useQueryClient();
  const [includeResolvedReports, setIncludeResolvedReports] = useState(false);
  const adminMe = useQuery({
    queryKey: ["admin-me"],
    queryFn: () =>
      customFetch<AdminMeResponse>("/api/admin/me", { responseType: "json" }),
    retry: false,
    staleTime: 60_000,
  });
  const gamesQuery = useQuery({
    queryKey: ["admin-games"],
    queryFn: () =>
      customFetch<AdminGamesResponse>("/api/admin/games", {
        responseType: "json",
      }),
    enabled: adminMe.data?.isAdmin === true,
    retry: false,
  });
  const usersQuery = useQuery({
    queryKey: ["admin-users"],
    queryFn: () =>
      customFetch<AdminUsersResponse>("/api/admin/users", {
        responseType: "json",
      }),
    enabled: adminMe.data?.isAdmin === true,
    retry: false,
  });
  const bugReportsQuery = useQuery({
    queryKey: ["admin-bug-reports", includeResolvedReports],
    queryFn: () =>
      customFetch<AdminBugReportsResponse>(
        `/api/admin/bug-reports?limit=100&includeResolved=${includeResolvedReports ? "true" : "false"}`,
        { responseType: "json" },
      ),
    enabled: adminMe.data?.isAdmin === true,
    retry: false,
  });

  const archiveGame = useMutation({
    mutationFn: (gameId: number) =>
      customFetch(`/api/admin/games/${gameId}/archive`, {
        method: "POST",
        responseType: "json",
        body: JSON.stringify({ days: 14 }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-games"] }),
  });

  const deleteGame = useMutation({
    mutationFn: (gameId: number) =>
      customFetch(`/api/admin/games/${gameId}`, {
        method: "DELETE",
        responseType: "text",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-games"] }),
  });

  const resolveBugReport = useMutation({
    mutationFn: (reportId: number) =>
      customFetch(`/api/admin/bug-reports/${reportId}/resolve`, {
        method: "POST",
        responseType: "json",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-bug-reports"] }),
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
              bugReportsQuery.refetch();
            }}
            disabled={
              !isAdmin ||
              gamesQuery.isFetching ||
              usersQuery.isFetching ||
              bugReportsQuery.isFetching
            }
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
            <div className="font-mono text-sm uppercase tracking-widest text-destructive">
              Admin access required
            </div>
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
            bugReports={bugReportsQuery.data}
            bugReportsLoading={bugReportsQuery.isLoading}
            includeResolvedReports={includeResolvedReports}
            setIncludeResolvedReports={setIncludeResolvedReports}
            resolveBugReportId={(reportId) => resolveBugReport.mutate(reportId)}
            archiveGameId={(gameId) => archiveGame.mutate(gameId)}
            deleteGameId={(gameId) => deleteGame.mutate(gameId)}
            actionsDisabled={
              archiveGame.isPending ||
              deleteGame.isPending ||
              resolveBugReport.isPending
            }
            now={now}
          />
        ) : (
          <AdminContent
            games={gamesQuery.data?.games ?? []}
            gamesLoading={gamesQuery.isLoading}
            users={usersQuery.data}
            usersLoading={usersQuery.isLoading}
            bugReports={bugReportsQuery.data}
            bugReportsLoading={bugReportsQuery.isLoading}
            includeResolvedReports={includeResolvedReports}
            setIncludeResolvedReports={setIncludeResolvedReports}
            resolveBugReportId={(reportId) => resolveBugReport.mutate(reportId)}
            archiveGameId={(gameId) => archiveGame.mutate(gameId)}
            deleteGameId={(gameId) => deleteGame.mutate(gameId)}
            actionsDisabled={
              archiveGame.isPending ||
              deleteGame.isPending ||
              resolveBugReport.isPending
            }
            now={now}
          />
        )}
      </div>
    </Layout>
  );
}

function FlagBadge({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className={`inline-flex rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${
        active
          ? "border-green-500/50 bg-green-500/10 text-green-300"
          : "border-zinc-500/40 bg-zinc-500/10 text-zinc-400"
      }`}
    >
      {label}
    </span>
  );
}

function AdminContent({
  games,
  gamesLoading,
  users,
  usersLoading,
  bugReports,
  bugReportsLoading,
  includeResolvedReports,
  setIncludeResolvedReports,
  resolveBugReportId,
  archiveGameId,
  deleteGameId,
  actionsDisabled,
  now,
}: {
  games: AdminGame[];
  gamesLoading: boolean;
  users?: AdminUsersResponse;
  usersLoading: boolean;
  bugReports?: AdminBugReportsResponse;
  bugReportsLoading: boolean;
  includeResolvedReports: boolean;
  setIncludeResolvedReports: (value: boolean) => void;
  resolveBugReportId: (reportId: number) => void;
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
              <div
                key={user.id}
                className="rounded-md border border-border bg-card px-4 py-3"
                data-testid={`admin-user-${user.id}`}
              >
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold">
                        {user.primaryEmail ?? user.username ?? user.id}
                      </span>
                      <FlagBadge
                        active={user.gameAllowed}
                        label={user.gameAllowed ? "allowed" : "not allowed"}
                      />
                      <FlagBadge active={user.adminAllowed} label="admin" />
                      {user.banned && (
                        <FlagBadge active={false} label="banned" />
                      )}
                      {user.locked && (
                        <FlagBadge active={false} label="locked" />
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono text-muted-foreground">
                      <span>{user.id}</span>
                      {user.username && <span>@{user.username}</span>}
                      {user.name && <span>{user.name}</span>}
                    </div>
                    <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
                      <span>
                        Joined:{" "}
                        <span className="font-mono text-foreground">
                          {formatDateTime(user.createdAt)}
                        </span>
                      </span>
                      <span>
                        Last sign-in:{" "}
                        <span className="font-mono text-foreground">
                          {formatDateTime(user.lastSignInAt)}
                        </span>
                      </span>
                      <span>
                        Email:{" "}
                        <span className="font-mono text-foreground">
                          {user.primaryEmailVerificationStatus ?? "unknown"}
                        </span>
                      </span>
                    </div>
                    {user.emails.length > 1 && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        {user.emails
                          .map(
                            (email) =>
                              `${email.emailAddress} (${email.verificationStatus ?? "unknown"})`,
                          )
                          .join(", ")}
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
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            <CheckCircle className="h-4 w-4" />
            Bug Reports
          </div>
          <label className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            <input
              type="checkbox"
              checked={includeResolvedReports}
              onChange={(event) =>
                setIncludeResolvedReports(event.target.checked)
              }
              data-testid="checkbox-admin-bug-reports-resolved"
            />
            include resolved
          </label>
        </div>
        {bugReportsLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : !bugReports || bugReports.reports.length === 0 ? (
          <div className="rounded-md border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
            {includeResolvedReports
              ? "No bug reports found."
              : "No unresolved bug reports."}
          </div>
        ) : (
          <div className="space-y-2">
            {bugReports.reports.map((report) => {
              const gameTitle = `${report.challengerName ?? "Unknown"} vs ${report.opponentName ?? (report.opponentKind === "ai" ? "AI" : "Open Slot")}`;
              const resolved = Boolean(report.resolvedAt);
              const diagnosticSummary = bugSnapshotSummary(report.snapshot ?? {});
              return (
                <div
                  key={report.id}
                  className={`rounded-md border px-4 py-3 ${
                    resolved
                      ? "border-zinc-600/40 bg-zinc-900/20 opacity-75"
                      : "border-amber-500/35 bg-amber-500/5"
                  }`}
                  data-testid={`admin-bug-report-${report.id}`}
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                          Report {report.id}
                        </span>
                        {resolved ? (
                          <FlagBadge active label="resolved" />
                        ) : (
                          <FlagBadge active={false} label="open" />
                        )}
                        {report.rescueRequested && (
                          <FlagBadge
                            active={report.rescueApplied}
                            label={
                              report.rescueApplied
                                ? "rescue used"
                                : "rescue requested"
                            }
                          />
                        )}
                      </div>
                      <p className="mt-2 whitespace-pre-wrap rounded border border-border/60 bg-black/20 px-3 py-2 text-sm leading-relaxed text-foreground">
                        {report.message}
                      </p>
                      <div className="mt-2 grid gap-1 text-xs text-muted-foreground md:grid-cols-2">
                        <span>
                          Game:{" "}
                          <Link
                            href={`/games/${report.gameId}`}
                            className="font-mono text-primary hover:underline"
                          >
                            {report.gameId} · {gameTitle}
                          </Link>
                        </span>
                        <span>
                          Submitted:{" "}
                          <span className="font-mono text-foreground">
                            {formatDateTime(report.createdAt)}
                          </span>
                        </span>
                        <span>
                          Reported at:{" "}
                          <span className="font-mono text-foreground">
                            Round {report.round} · {report.phase}
                          </span>
                        </span>
                        <span>
                          Current game:{" "}
                          <span className="font-mono text-foreground">
                            Round {report.gameRound ?? "?"} ·{" "}
                            {report.gamePhase ?? "?"} ·{" "}
                            {report.gameStatus ?? "?"}
                          </span>
                        </span>
                        <span>
                          Reporter:{" "}
                          <span className="font-mono text-foreground">
                            {report.reporterPlayerId}
                          </span>
                        </span>
                        <span>
                          Active unit:{" "}
                          <span className="font-mono text-foreground">
                            {report.activeUnitId ?? "none"}
                          </span>
                        </span>
                        {resolved && (
                          <span>
                            Resolved:{" "}
                            <span className="font-mono text-foreground">
                              {formatDateTime(report.resolvedAt)} by{" "}
                              {report.resolvedByAdminId ?? "admin"}
                            </span>
                          </span>
                        )}
                      </div>
                      {diagnosticSummary.length > 0 && (
                        <div className="mt-3 rounded border border-sky-500/20 bg-sky-500/5 p-3">
                          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-sky-200">
                            Diagnostic snapshot
                          </div>
                          <div className="mt-2 grid gap-1 text-[11px] text-muted-foreground">
                            {diagnosticSummary.map((row) => (
                              <div
                                key={row.label}
                                className="grid gap-1 md:grid-cols-[8rem_1fr]"
                              >
                                <span className="font-mono uppercase tracking-wider text-sky-200/80">
                                  {row.label}
                                </span>
                                <span className="break-words font-mono text-zinc-200">
                                  {row.value}
                                </span>
                              </div>
                            ))}
                          </div>
                          <details className="mt-2">
                            <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-widest text-primary">
                              Raw snapshot
                            </summary>
                            <pre className="mt-2 max-h-72 overflow-auto rounded bg-black/45 p-2 text-[10px] leading-4 text-zinc-300">
                              {JSON.stringify(report.snapshot ?? {}, null, 2)}
                            </pre>
                          </details>
                        </div>
                      )}
                    </div>
                    {!resolved && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-2 font-mono text-xs uppercase tracking-widest"
                        disabled={actionsDisabled}
                        onClick={() => resolveBugReportId(report.id)}
                        data-testid={`button-admin-resolve-bug-report-${report.id}`}
                      >
                        <CheckCircle className="h-3.5 w-3.5" />
                        Resolve
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
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
              const archiveUntil = game.archiveExpiresAt
                ? new Date(game.archiveExpiresAt).getTime()
                : 0;
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
                          <span className="truncate text-sm font-semibold">
                            {title}
                          </span>
                        ) : (
                          <Link
                            href={`/games/${game.id}`}
                            className="truncate text-sm font-semibold hover:text-primary"
                          >
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
                        <span>
                          Idle:{" "}
                          <span className="font-mono text-foreground">
                            {formatIdle(game.idleSeconds)}
                          </span>
                        </span>
                        <span>
                          Last activity:{" "}
                          <span className="font-mono text-foreground">
                            {formatDateTime(game.lastActivityAt)}
                          </span>
                        </span>
                        <span>
                          Archive until:{" "}
                          <span className="font-mono text-foreground">
                            {formatDateTime(game.archiveExpiresAt)}
                          </span>
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-2 font-mono text-xs uppercase tracking-widest"
                        disabled={actionsDisabled || isArchived}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Archive game ${game.id} for 14 days? Players will no longer see it in normal game lists.`,
                            )
                          ) {
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
                          if (
                            window.confirm(
                              `Delete game ${game.id} outright? This removes units, turns, logs, chat, bug reports, and the game record.`,
                            )
                          ) {
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
