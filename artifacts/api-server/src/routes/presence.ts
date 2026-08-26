import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, playersTable } from "@workspace/db";
import { getUserId, requireAuth } from "../lib/auth";
import {
  listSitePresence,
  markSitePresence,
  SITE_PRESENCE_TIMEOUT_MS,
} from "../lib/site-presence";
import { ensurePlayer } from "./players";

const router: IRouter = Router();

async function recordCurrentPlayer(userId: string): Promise<void> {
  await ensurePlayer(userId);
  const [player] = await db
    .select({ username: playersTable.username })
    .from(playersTable)
    .where(eq(playersTable.clerkUserId, userId));
  if (player) markSitePresence(userId, player.username);
}

router.post("/presence/heartbeat", requireAuth, async (req, res): Promise<void> => {
  await recordCurrentPlayer(getUserId(req));
  res.status(204).end();
});

router.get("/presence", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  await recordCurrentPlayer(userId);
  res.json({
    activeWithinSeconds: SITE_PRESENCE_TIMEOUT_MS / 1_000,
    players: listSitePresence().map((player) => ({
      username: player.username,
      isCurrentUser: player.userId === userId,
    })),
  });
});

export default router;
