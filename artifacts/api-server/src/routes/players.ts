import { Router, type IRouter } from "express";
import { eq, ilike, ne, and } from "drizzle-orm";
import { db, playersTable } from "@workspace/db";
import { requireAuth, getUserId } from "../lib/auth";
import { GetMyProfileResponse, SearchPlayersResponse, SearchPlayersQueryParams } from "@workspace/api-zod";
import { clerkClient } from "@clerk/express";

const router: IRouter = Router();

async function ensurePlayer(userId: string): Promise<void> {
  const existing = await db.select().from(playersTable).where(eq(playersTable.clerkUserId, userId));
  if (existing.length === 0) {
    let username = userId.slice(0, 12);
    let avatarUrl: string | null = null;
    try {
      const clerkUser = await clerkClient.users.getUser(userId);
      username = clerkUser.username || clerkUser.firstName || clerkUser.emailAddresses[0]?.emailAddress?.split("@")[0] || username;
      avatarUrl = clerkUser.imageUrl || null;
    } catch {}
    await db.insert(playersTable).values({ clerkUserId: userId, username, avatarUrl }).onConflictDoNothing();
  }
}

router.get("/players/me", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  await ensurePlayer(userId);
  const [player] = await db.select().from(playersTable).where(eq(playersTable.clerkUserId, userId));
  if (!player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  res.json(GetMyProfileResponse.parse(player));
});

router.get("/players/search", requireAuth, async (req, res): Promise<void> => {
  const parsed = SearchPlayersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const userId = getUserId(req);
  const players = await db
    .select()
    .from(playersTable)
    .where(and(ilike(playersTable.username, `%${parsed.data.q}%`), ne(playersTable.clerkUserId, userId)))
    .limit(10);
  res.json(SearchPlayersResponse.parse(players));
});

export { ensurePlayer };
export default router;
