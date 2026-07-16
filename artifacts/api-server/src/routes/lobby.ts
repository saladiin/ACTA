import { Router, type IRouter } from "express";
import { eq, or, and, ne } from "drizzle-orm";
import { db, gamesTable } from "@workspace/db";
import { requireAuth, getUserId } from "../lib/auth";
import { GetLobbyResponse } from "@workspace/api-zod";
import { AI_OPPONENT_ID } from "../lib/ai-opponent";

// Mirror of artifacts/api-server/src/routes/games.ts:toGameDto — strips the
// server-only passwordHash field and surfaces a boolean hasPassword so the
// lobby UI can render a lock affordance on private engagements without ever
// exposing the hash itself.
function toGameDto<T extends { passwordHash: string | null }>(row: T): Omit<T, "passwordHash"> & { hasPassword: boolean } {
  const { passwordHash, ...rest } = row;
  return { ...rest, hasPassword: passwordHash !== null };
}

const router: IRouter = Router();

function isDevBuiltinCommander(userId: string): boolean {
  return process.env.NODE_ENV !== "production" && (userId === "test-user-1" || userId === "test-user-2");
}

function isTemporarilyArchived(game: { archiveExpiresAt: Date | null }): boolean {
  return Boolean(game.archiveExpiresAt && game.archiveExpiresAt > new Date());
}

router.get("/lobby", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);

  const myGames = (await db
    .select()
    .from(gamesTable)
    .where(or(
      eq(gamesTable.challengerId, userId),
      eq(gamesTable.opponentId, userId),
      ...(isDevBuiltinCommander(userId)
        ? [and(eq(gamesTable.opponentId, AI_OPPONENT_ID), ne(gamesTable.challengerId, userId))]
        : []),
    ))
    .orderBy(gamesTable.updatedAt))
    .filter((game) => !isTemporarilyArchived(game));

  // Open challenges from other commanders are directly joinable. The current
  // user's own open challenges are also returned below so DEV testers can
  // switch commander and claim them from the lobby without visiting the board.
  const openChallenges = (await db
    .select()
    .from(gamesTable)
    .where(and(eq(gamesTable.status, "open"), ne(gamesTable.challengerId, userId)))
    .orderBy(gamesTable.updatedAt))
    .filter((game) => !isTemporarilyArchived(game));

  const pendingChallenges = [
    ...myGames.filter(g => g.status === "pending" || g.status === "open"),
    ...openChallenges,
  ].map(toGameDto);
  const activeGames = myGames
    .filter(g => g.status === "active" || g.status === "deploying")
    .map(toGameDto);
  const recentlyCompleted = myGames
    .filter(g => g.status === "completed" || g.status === "declined")
    .slice(-5)
    .map(toGameDto);

  res.json(GetLobbyResponse.parse({ pendingChallenges, activeGames, recentlyCompleted }));
});

export default router;
