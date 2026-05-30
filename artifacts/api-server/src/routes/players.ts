import { Router, type IRouter } from "express";
import { eq, ilike, ne, and } from "drizzle-orm";
import { db, playersTable } from "@workspace/db";
import { requireAuth, getUserId } from "../lib/auth";
import { GetMyProfileResponse, SearchPlayersResponse, SearchPlayersQueryParams, UpdateMyProfileBody } from "@workspace/api-zod";
import { clerkClient } from "@clerk/express";

const router: IRouter = Router();

// Single source of truth for callsign rules — mirrors the OpenAPI
// `UpdateProfileInput` constraints (2..24 chars; letters, numbers, spaces,
// hyphen, underscore). Used by both provisioning and PATCH so a Clerk-supplied
// username can never bypass the validation the edit UI enforces.
const CALLSIGN_RE = /^[A-Za-z0-9 _-]{2,24}$/;
function sanitizeCallsign(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return CALLSIGN_RE.test(trimmed) ? trimmed : null;
}

async function ensurePlayer(userId: string): Promise<void> {
  const existing = await db.select().from(playersTable).where(eq(playersTable.clerkUserId, userId));
  if (existing.length === 0) {
    // Generate a neutral default callsign. We NEVER derive the public display
    // name from the player's email — keeping email and callsign decoupled means
    // a commander's email identity is never exposed to other players. The user
    // can change this anytime via PATCH /players/me.
    let username = `Commander-${Math.floor(1000 + Math.random() * 9000)}`;
    let avatarUrl: string | null = null;
    try {
      const clerkUser = await clerkClient.users.getUser(userId);
      // Honour an explicit, valid Clerk username if the player chose one, but
      // fall back to the generated callsign — never to anything email-derived,
      // and never to a value that would fail the edit-time validation rules.
      const explicit = sanitizeCallsign(clerkUser.username);
      if (explicit) username = explicit;
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

router.patch("/players/me", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpdateMyProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const userId = getUserId(req);
  await ensurePlayer(userId);
  const username = sanitizeCallsign(parsed.data.username);
  if (!username) {
    res.status(400).json({ error: "Callsign must be 2–24 characters: letters, numbers, spaces, - or _." });
    return;
  }
  const [updated] = await db
    .update(playersTable)
    .set({ username })
    .where(eq(playersTable.clerkUserId, userId))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  res.json(GetMyProfileResponse.parse(updated));
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
