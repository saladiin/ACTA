import { Router, type IRouter } from "express";
import { eq, or, and } from "drizzle-orm";
import { db, gamesTable } from "@workspace/db";
import { requireAuth, getUserId } from "../lib/auth";
import { GetLobbyResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/lobby", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);

  const allGames = await db
    .select()
    .from(gamesTable)
    .where(or(eq(gamesTable.challengerId, userId), eq(gamesTable.opponentId, userId)))
    .orderBy(gamesTable.updatedAt);

  const pendingChallenges = allGames.filter(g => g.status === "pending");
  const activeGames = allGames.filter(g => g.status === "active" || g.status === "deploying");
  const recentlyCompleted = allGames.filter(g => g.status === "completed" || g.status === "declined").slice(-5);

  res.json(GetLobbyResponse.parse({ pendingChallenges, activeGames, recentlyCompleted }));
});

export default router;
