import { Router, type IRouter } from "express";
import { clerkClient } from "@clerk/express";
import { asc, desc, eq, isNull, or } from "drizzle-orm";
import {
  db,
  gamesTable,
  gameUnitsTable,
  turnsTable,
  unitCriticalEffectsTable,
  gameAttackAuditLogsTable,
  gameMovementAuditLogsTable,
  gameSpecialActionAuditLogsTable,
  bugReportsTable,
  gameChatMessagesTable,
} from "@workspace/db";
import { getUserId, isAdminUser, requireAdmin, requireAuth } from "../lib/auth";

const router: IRouter = Router();
const DEFAULT_ARCHIVE_DAYS = 14;
const ADMIN_USER_LIST_LIMIT = 100;

function parseIdentityList(raw: string): Set<string> {
  return new Set(
    raw
      .split(/[\s,;]+/g)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function userIdentityValues(user: {
  id: string;
  username: string | null;
  emailAddresses: Array<{ emailAddress: string }>;
}): string[] {
  return [
    user.id,
    user.username,
    ...user.emailAddresses.map((email) => email.emailAddress),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
}

function matchesIdentityList(
  identities: string[],
  list: Set<string>,
  emptyMeansAllowed: boolean,
): boolean {
  if (list.size === 0) return emptyMeansAllowed;
  return identities.some((identity) => list.has(identity));
}

function clerkTimestampToIso(value: number | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

function emailVerificationStatus(email: {
  verification: { status?: string | null } | null;
}): string | null {
  return email.verification?.status ?? null;
}

function clampArchiveDays(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_ARCHIVE_DAYS;
  return Math.max(1, Math.min(90, Math.trunc(numeric)));
}

async function deleteGameCascade(gameId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(gameAttackAuditLogsTable)
      .where(eq(gameAttackAuditLogsTable.gameId, gameId));
    await tx
      .delete(gameMovementAuditLogsTable)
      .where(eq(gameMovementAuditLogsTable.gameId, gameId));
    await tx
      .delete(gameSpecialActionAuditLogsTable)
      .where(eq(gameSpecialActionAuditLogsTable.gameId, gameId));
    await tx.delete(bugReportsTable).where(eq(bugReportsTable.gameId, gameId));
    await tx
      .delete(gameChatMessagesTable)
      .where(eq(gameChatMessagesTable.gameId, gameId));
    await tx.delete(turnsTable).where(eq(turnsTable.gameId, gameId));

    const unitRows = await tx
      .select({ id: gameUnitsTable.id })
      .from(gameUnitsTable)
      .where(eq(gameUnitsTable.gameId, gameId));
    if (unitRows.length > 0) {
      await tx
        .delete(unitCriticalEffectsTable)
        .where(
          or(
            ...unitRows.map((unit) =>
              eq(unitCriticalEffectsTable.gameUnitId, unit.id),
            ),
          ),
        );
    }
    await tx.delete(gameUnitsTable).where(eq(gameUnitsTable.gameId, gameId));
    await tx.delete(gamesTable).where(eq(gamesTable.id, gameId));
  });
}

router.get("/admin/me", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  res.json({ isAdmin: await isAdminUser(userId) });
});

router.get("/admin/games", requireAdmin, async (_req, res): Promise<void> => {
  const now = Date.now();
  const games = await db
    .select({
      id: gamesTable.id,
      challengerName: gamesTable.challengerName,
      opponentName: gamesTable.opponentName,
      challengerId: gamesTable.challengerId,
      opponentId: gamesTable.opponentId,
      opponentKind: gamesTable.opponentKind,
      status: gamesTable.status,
      currentRound: gamesTable.currentRound,
      currentTurn: gamesTable.currentTurn,
      phase: gamesTable.phase,
      createdAt: gamesTable.createdAt,
      updatedAt: gamesTable.updatedAt,
      archivedAt: gamesTable.archivedAt,
      archiveExpiresAt: gamesTable.archiveExpiresAt,
    })
    .from(gamesTable)
    .orderBy(asc(gamesTable.updatedAt));

  res.json({
    games: games.map((game) => {
      const lastActivityAt = game.updatedAt ?? game.createdAt;
      return {
        ...game,
        lastActivityAt,
        idleSeconds: Math.max(
          0,
          Math.floor((now - lastActivityAt.getTime()) / 1000),
        ),
      };
    }),
  });
});

router.get("/admin/users", requireAdmin, async (_req, res): Promise<void> => {
  const allowedUsers = parseIdentityList(
    process.env.B5_ALLOWED_USERS ?? process.env.B5_ACCESS_ALLOWLIST ?? "",
  );
  const adminUsers = parseIdentityList(
    process.env.B5_ADMIN_USERS ?? process.env.B5_ADMIN_EMAILS ?? "",
  );
  const result = await clerkClient.users.getUserList({
    limit: ADMIN_USER_LIST_LIMIT,
    offset: 0,
    orderBy: "-created_at",
  });

  res.json({
    totalCount: result.totalCount,
    limit: ADMIN_USER_LIST_LIMIT,
    users: result.data.map((user) => {
      const identities = userIdentityValues(user);
      const primaryEmail =
        user.emailAddresses.find(
          (email) => email.id === user.primaryEmailAddressId,
        ) ??
        user.emailAddresses[0] ??
        null;

      return {
        id: user.id,
        username: user.username,
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
        primaryEmail: primaryEmail?.emailAddress ?? null,
        primaryEmailVerificationStatus: primaryEmail
          ? emailVerificationStatus(primaryEmail)
          : null,
        emails: user.emailAddresses.map((email) => ({
          emailAddress: email.emailAddress,
          verificationStatus: emailVerificationStatus(email),
        })),
        createdAt: clerkTimestampToIso(user.createdAt),
        lastSignInAt: clerkTimestampToIso(user.lastSignInAt),
        lastActiveAt: clerkTimestampToIso(user.lastActiveAt),
        banned: user.banned,
        locked: user.locked,
        gameAllowed: matchesIdentityList(identities, allowedUsers, true),
        adminAllowed: matchesIdentityList(identities, adminUsers, false),
      };
    }),
  });
});

router.get(
  "/admin/bug-reports",
  requireAdmin,
  async (req, res): Promise<void> => {
    const rawLimit = Number(req.query["limit"] ?? 100);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(250, Math.trunc(rawLimit)))
      : 100;
    const includeResolved = req.query["includeResolved"] === "true";

    const fields = {
      id: bugReportsTable.id,
      gameId: bugReportsTable.gameId,
      reporterPlayerId: bugReportsTable.reporterPlayerId,
      round: bugReportsTable.round,
      phase: bugReportsTable.phase,
      activePlayerId: bugReportsTable.activePlayerId,
      activeUnitId: bugReportsTable.activeUnitId,
      message: bugReportsTable.message,
      rescueRequested: bugReportsTable.rescueRequested,
      rescueApplied: bugReportsTable.rescueApplied,
      snapshot: bugReportsTable.snapshot,
      resolvedAt: bugReportsTable.resolvedAt,
      resolvedByAdminId: bugReportsTable.resolvedByAdminId,
      createdAt: bugReportsTable.createdAt,
      challengerName: gamesTable.challengerName,
      opponentName: gamesTable.opponentName,
      opponentKind: gamesTable.opponentKind,
      gameStatus: gamesTable.status,
      gamePhase: gamesTable.phase,
      gameRound: gamesTable.currentRound,
    };
    const rows = includeResolved
      ? await db
          .select(fields)
          .from(bugReportsTable)
          .leftJoin(gamesTable, eq(gamesTable.id, bugReportsTable.gameId))
          .orderBy(desc(bugReportsTable.createdAt), desc(bugReportsTable.id))
          .limit(limit)
      : await db
          .select(fields)
          .from(bugReportsTable)
          .leftJoin(gamesTable, eq(gamesTable.id, bugReportsTable.gameId))
          .where(isNull(bugReportsTable.resolvedAt))
          .orderBy(desc(bugReportsTable.createdAt), desc(bugReportsTable.id))
          .limit(limit);

    res.json({
      count: rows.length,
      reports: rows.map((report) => ({
        ...report,
        createdAt: report.createdAt.toISOString(),
        resolvedAt: report.resolvedAt?.toISOString() ?? null,
      })),
    });
  },
);

router.post(
  "/admin/bug-reports/:reportId/resolve",
  requireAdmin,
  async (req, res): Promise<void> => {
    const adminId = getUserId(req);
    const reportId = Number(req.params.reportId);
    if (!Number.isInteger(reportId) || reportId <= 0) {
      res.status(400).json({ error: "Invalid report id" });
      return;
    }

    const [report] = await db
      .update(bugReportsTable)
      .set({
        resolvedAt: new Date(),
        resolvedByAdminId: adminId,
      })
      .where(eq(bugReportsTable.id, reportId))
      .returning();

    if (!report) {
      res.status(404).json({ error: "Bug report not found" });
      return;
    }
    res.json({
      ...report,
      createdAt: report.createdAt.toISOString(),
      resolvedAt: report.resolvedAt?.toISOString() ?? null,
    });
  },
);

router.post(
  "/admin/games/:gameId/archive",
  requireAdmin,
  async (req, res): Promise<void> => {
    const gameId = Number(req.params.gameId);
    if (!Number.isInteger(gameId) || gameId <= 0) {
      res.status(400).json({ error: "Invalid game id" });
      return;
    }

    const days = clampArchiveDays(
      (req.body as { days?: unknown } | undefined)?.days,
    );
    const now = new Date();
    const archiveExpiresAt = new Date(
      now.getTime() + days * 24 * 60 * 60 * 1000,
    );
    const [game] = await db
      .update(gamesTable)
      .set({
        archivedAt: now,
        archiveExpiresAt,
      })
      .where(eq(gamesTable.id, gameId))
      .returning();

    if (!game) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    res.json({
      gameId: game.id,
      archivedAt: game.archivedAt,
      archiveExpiresAt: game.archiveExpiresAt,
    });
  },
);

router.delete(
  "/admin/games/:gameId",
  requireAdmin,
  async (req, res): Promise<void> => {
    const gameId = Number(req.params.gameId);
    if (!Number.isInteger(gameId) || gameId <= 0) {
      res.status(400).json({ error: "Invalid game id" });
      return;
    }

    const [game] = await db
      .select({ id: gamesTable.id })
      .from(gamesTable)
      .where(eq(gamesTable.id, gameId));
    if (!game) {
      res.status(404).json({ error: "Game not found" });
      return;
    }

    await deleteGameCascade(gameId);
    res.status(204).end();
  },
);

export default router;
