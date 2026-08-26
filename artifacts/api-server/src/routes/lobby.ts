import { Router, type IRouter } from "express";
import { desc, eq, or, and, ne, isNull } from "drizzle-orm";
import { db, gamesTable, lobbyChatMessagesTable, playersTable } from "@workspace/db";
import { requireAuth, getUserId, isAdminUser } from "../lib/auth";
import { GetLobbyResponse } from "@workspace/api-zod";
import { AI_OPPONENT_ID } from "../lib/ai-opponent";
import { gameAppearsInObserverList } from "../lib/game-observer-access";

// Mirror of artifacts/api-server/src/routes/games.ts:toGameDto — strips the
// server-only passwordHash field and surfaces a boolean hasPassword so the
// lobby UI can render a lock affordance on private engagements without ever
// exposing the hash itself.
function toGameDto<T extends { passwordHash: string | null }>(row: T): Omit<T, "passwordHash"> & { hasPassword: boolean } {
  const { passwordHash, ...rest } = row;
  return { ...rest, hasPassword: passwordHash !== null };
}

type LobbyGameRow = typeof gamesTable.$inferSelect;

function terrainConfigHasObjects(terrainConfig: unknown): boolean {
  if (!terrainConfig || typeof terrainConfig !== "object" || Array.isArray(terrainConfig)) return false;
  const objects = (terrainConfig as { objects?: unknown }).objects;
  return Array.isArray(objects) && objects.length > 0;
}

function stationConfigIsEnabled(stationConfig: unknown): boolean {
  if (!stationConfig || typeof stationConfig !== "object" || Array.isArray(stationConfig)) return false;
  const config = stationConfig as { enabled?: unknown; objects?: unknown };
  return config.enabled === true || (Array.isArray(config.objects) && config.objects.length > 0);
}

function toLobbyGameDto<T extends LobbyGameRow & { passwordHash: string | null }>(row: T) {
  return {
    ...toGameDto(row),
    hasTerrain: terrainConfigHasObjects(row.terrainConfig),
    hasStation: stationConfigIsEnabled(row.stationConfig),
  };
}

const router: IRouter = Router();
const LOBBY_CHAT_LIMIT = 50;
const LOBBY_CHAT_MAX_LENGTH = 500;
const LOBBY_CHAT_MIN_SEND_INTERVAL_MS = 1500;

function isDevBuiltinCommander(userId: string): boolean {
  return process.env.NODE_ENV !== "production" && (userId === "test-user-1" || userId === "test-user-2");
}

function isTemporarilyArchived(game: { archiveExpiresAt: Date | null }): boolean {
  return Boolean(game.archiveExpiresAt && game.archiveExpiresAt > new Date());
}

function parseLobbyChatBody(body: unknown): { success: true; message: string } | { success: false; error: string } {
  if (!body || typeof body !== "object") return { success: false, error: "Message is required" };
  const raw = (body as { message?: unknown }).message;
  if (typeof raw !== "string") return { success: false, error: "Message is required" };
  const message = raw.trim();
  if (!message) return { success: false, error: "Message cannot be empty" };
  if (message.length > LOBBY_CHAT_MAX_LENGTH) {
    return { success: false, error: `Message must be ${LOBBY_CHAT_MAX_LENGTH} characters or fewer` };
  }
  return { success: true, message };
}

router.get("/lobby", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const isAdmin = await isAdminUser(userId);

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
  ].map(toLobbyGameDto);
  const activeGames = myGames
    .filter(g => g.status === "active" || g.status === "deploying")
    .map(toLobbyGameDto);
  const recentlyCompleted = myGames
    .filter(g => g.status === "completed" || g.status === "declined")
    .slice(-5)
    .map(toLobbyGameDto);

  const myGameIds = new Set(myGames.map(game => game.id));
  const observableStatus = or(eq(gamesTable.status, "active"), eq(gamesTable.status, "completed"));
  const observableGames = (await db
    .select()
    .from(gamesTable)
    .where(isAdmin
      ? observableStatus
      : and(eq(gamesTable.allowObservers, true), observableStatus))
    .orderBy(desc(gamesTable.updatedAt)))
    .filter(game => (
      gameAppearsInObserverList(game, isAdmin) &&
      !myGameIds.has(game.id) &&
      !isTemporarilyArchived(game)
    ))
    .slice(0, 20)
    .map(toLobbyGameDto);

  res.json(GetLobbyResponse.parse({ pendingChallenges, activeGames, observableGames, recentlyCompleted }));
});

router.get("/lobby/chat", requireAuth, async (_req, res): Promise<void> => {
  const latest = await db
    .select()
    .from(lobbyChatMessagesTable)
    .where(isNull(lobbyChatMessagesTable.deletedAt))
    .orderBy(desc(lobbyChatMessagesTable.createdAt), desc(lobbyChatMessagesTable.id))
    .limit(LOBBY_CHAT_LIMIT);

  res.json({ messages: latest.reverse() });
});

router.post("/lobby/chat", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const body = parseLobbyChatBody(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error });
    return;
  }

  const [latestFromSender] = await db
    .select({ createdAt: lobbyChatMessagesTable.createdAt })
    .from(lobbyChatMessagesTable)
    .where(eq(lobbyChatMessagesTable.senderPlayerId, userId))
    .orderBy(desc(lobbyChatMessagesTable.createdAt), desc(lobbyChatMessagesTable.id))
    .limit(1);
  if (
    latestFromSender &&
    Date.now() - latestFromSender.createdAt.getTime() < LOBBY_CHAT_MIN_SEND_INTERVAL_MS
  ) {
    res.status(429).json({ error: "Give the channel a heartbeat before sending again." });
    return;
  }

  const [player] = await db
    .select({ username: playersTable.username })
    .from(playersTable)
    .where(eq(playersTable.clerkUserId, userId));
  const [message] = await db
    .insert(lobbyChatMessagesTable)
    .values({
      senderPlayerId: userId,
      senderName: player?.username ?? null,
      message: body.message,
    })
    .returning();

  res.status(201).json({ message });
});

export default router;
