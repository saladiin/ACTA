import { Router, type IRouter } from "express";
import { eq, or, and, ne } from "drizzle-orm";
import { db, gamesTable } from "@workspace/db";
import { requireAuth, getUserId } from "../lib/auth";
import { GetLobbyResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/lobby", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);

  const myGames = await db
    .select()
    .from(gamesTable)
    .where(or(eq(gamesTable.challengerId, userId), eq(gamesTable.opponentId, userId)))
    .orderBy(gamesTable.updatedAt);

  // Open challenges issued by other commanders that anyone (including this
  // user) may pick up. Surfacing these in pendingChallenges lets the existing
  // accept UI handle them without a new section.
  const openChallenges = await db
    .select()
    .from(gamesTable)
    .where(and(eq(gamesTable.status, "open"), ne(gamesTable.challengerId, userId)))
    .orderBy(gamesTable.updatedAt);

  const pendingChallenges = [
    ...myGames.filter(g => g.status === "pending"),
    ...openChallenges,
  ];
  const activeGames = myGames.filter(g => g.status === "active" || g.status === "deploying");
  const recentlyCompleted = myGames.filter(g => g.status === "completed" || g.status === "declined").slice(-5);

  res.json(GetLobbyResponse.parse({ pendingChallenges, activeGames, recentlyCompleted }));
});

export default router;
