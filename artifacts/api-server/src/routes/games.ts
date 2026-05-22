import { Router, type IRouter } from "express";
import { eq, and, or, isNull, sql } from "drizzle-orm";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, gamesTable, gameUnitsTable, turnsTable, fleetsTable, shipsTable, shipModelsTable, playersTable, weaponsTable } from "@workspace/db";
import { requireAuth, getUserId } from "../lib/auth";
import {
  CreateGameBody,
  GetGameParams,
  AcceptGameParams,
  AcceptGameBody,
  DeclineGameParams,
  DeployFleetParams,
  DeployFleetBody,
  ListTurnsParams,
  SubmitTurnParams,
  SubmitTurnBody,
  MoveUnitParams,
  MoveUnitBody,
  DevMoveUnitParams,
  DevMoveUnitBody,
  ActivateUnitParams,
  EndActivationParams,
  FireWeaponParams,
  FireWeaponBody,
  ListGamesResponse,
  GetGameResponse,
  AcceptGameResponse,
  DeclineGameResponse,
  DeployFleetResponse,
  ListTurnsResponse,
} from "@workspace/api-zod";

// ── Combat helpers ───────────────────────────────────────────────────────────
// World units = inches (see game-board.tsx: "1 world unit = 1 inch").
// hexToWorld must mirror the frontend exactly so that arc/range UI agrees
// with server-side validation.
function hexToWorld(q: number, r: number): { x: number; z: number } {
  return { x: q * 2.25, z: r * 2.6 + q * 1.3 };
}
function rollD6(): number { return 1 + Math.floor(Math.random() * 6); }

// ── Password hashing (scrypt) ────────────────────────────────────────────────
// Stored as "<saltHex>:<hashHex>" so we can rotate parameters later without a
// migration. The password itself never leaves the server; clients see only
// `hasPassword: boolean` on the Game DTO.
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}
function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Strip server-only fields from a DB row before returning to clients. The
// Game schema requires `hasPassword` (boolean) and forbids `passwordHash`.
function toGameDto<T extends { passwordHash: string | null }>(row: T): Omit<T, "passwordHash"> & { hasPassword: boolean } {
  const { passwordHash, ...rest } = row;
  return { ...rest, hasPassword: passwordHash !== null };
}

// Arc center angles match game-board.tsx (local +Z = forward when heading=0).
// halfAngle of -1 means "no arc" (boresight = strict equality on center bearing
// within a tiny tolerance); 2π means "all-arcs" (turret).
const ARCS: Record<string, { center: number; half: number } | null> = {
  "Forward":           { center: Math.PI / 2,  half: Math.PI / 4 },
  "Port":              { center: 0,            half: Math.PI / 4 },
  "Starboard":         { center: Math.PI,      half: Math.PI / 4 },
  "Aft":               { center: -Math.PI / 2, half: Math.PI / 4 },
  "Boresight Forward": { center: Math.PI / 2,  half: Math.PI / 24 },
  "Boresight Aft":     { center: -Math.PI / 2, half: Math.PI / 24 },
  "Turret":            { center: 0,            half: Math.PI }, // 360°
};

function angleDelta(a: number, b: number): number {
  // shortest signed difference in (-π, π]
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

function isInArc(
  attacker: { x: number; z: number; headingDeg: number; flipped: boolean },
  target:   { x: number; z: number },
  arcName: string,
): boolean {
  const arc = ARCS[arcName];
  if (!arc) return false; // unknown arc → reject
  const dx = target.x - attacker.x;
  const dz = target.z - attacker.z;
  // Flipped models render rotated 180° around Y, so the player-facing "forward"
  // is the opposite of the raw heading value. Match the frontend convention.
  const effHeading = attacker.headingDeg + (attacker.flipped ? 180 : 0);
  const headingRad = (effHeading * Math.PI) / 180;
  // World → ship-local: rotate world delta by -headingRad around Y.
  const localX = dx * Math.cos(headingRad) - dz * Math.sin(headingRad);
  const localZ = dx * Math.sin(headingRad) + dz * Math.cos(headingRad);
  if (localX === 0 && localZ === 0) return true; // same hex (shouldn't happen)
  const bearing = Math.atan2(localZ, localX); // +π/2 = forward, 0 = port, π = starboard, -π/2 = aft.
  return Math.abs(angleDelta(bearing, arc.center)) <= arc.half + 1e-6;
}

// Some OBJ models are authored nose-pointing-aft, so the frontend renders them
// with an extra 180° Y-rotation inside the heading group. The player-facing
// "forward" is therefore the opposite of the stored heading. KEEP IN SYNC with
// the FLIP_MODELS set in artifacts/b5acta/src/pages/game-board.tsx.
const FLIP_MODELS = new Set(["oracle.glb", "hyperion.glb", "sagittarius.glb", "sharlin.glb"]);

const router: IRouter = Router();

router.get("/games", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const games = await db
    .select()
    .from(gamesTable)
    .where(or(eq(gamesTable.challengerId, userId), eq(gamesTable.opponentId, userId)))
    .orderBy(gamesTable.updatedAt);
  res.json(ListGamesResponse.parse(games.map(toGameDto)));
});

router.post("/games", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const parsed = CreateGameBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Fleet is optional at creation time — challenger can pick one later during
  // the deploy phase. If supplied, it must belong to the challenger.
  const fleetId = parsed.data.fleetId ?? null;
  if (fleetId !== null) {
    const [fleet] = await db.select().from(fleetsTable).where(and(eq(fleetsTable.id, fleetId), eq(fleetsTable.ownerId, userId)));
    if (!fleet) { res.status(404).json({ error: "Fleet not found" }); return; }
  }

  const [challenger] = await db.select().from(playersTable).where(eq(playersTable.clerkUserId, userId));

  // Engagements no longer target a specific opponent. They are listed as
  // "open" so any other commander can join — either freely (public) or by
  // supplying the matching password (private).
  const visibility = parsed.data.visibility;
  if (visibility === "private") {
    if (!parsed.data.password || parsed.data.password.length < 1) {
      res.status(400).json({ error: "Password required for a private engagement." });
      return;
    }
  }
  const passwordHash = visibility === "private" && parsed.data.password
    ? hashPassword(parsed.data.password)
    : null;

  const [game] = await db.insert(gamesTable).values({
    challengerId: userId,
    opponentId: null,
    challengerName: challenger?.username ?? null,
    opponentName: null,
    challengerFleetId: fleetId,
    pointLimit: parsed.data.pointLimit,
    visibility,
    passwordHash,
    status: "open",
  }).returning();
  res.status(201).json(toGameDto(game));
});

router.get("/games/:gameId", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = GetGameParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  // Anyone can view an open challenge so they can decide to accept it from a
  // direct link; members of a non-open game see it as before.
  const [game] = await db
    .select()
    .from(gamesTable)
    .where(and(
      eq(gamesTable.id, params.data.gameId),
      or(
        eq(gamesTable.status, "open"),
        eq(gamesTable.challengerId, userId),
        eq(gamesTable.opponentId, userId),
      ),
    ));
  if (!game) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  const units = await db.select().from(gameUnitsTable).where(eq(gameUnitsTable.gameId, params.data.gameId));
  const turns = await db.select().from(turnsTable).where(eq(turnsTable.gameId, params.data.gameId)).orderBy(turnsTable.turnNumber);
  res.json(GetGameResponse.parse({ game: toGameDto(game), units, turns }));
});

router.post("/games/:gameId/accept", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = AcceptGameParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  // Body is optional (public engagements need nothing); when present it may
  // carry the password for a private engagement.
  const body = AcceptGameBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const submittedPassword = body.data.password ?? null;

  try {
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM games WHERE id = ${params.data.gameId} FOR UPDATE`);
      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, params.data.gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });

      if (game.status === "open") {
        // Open challenge: anyone except the challenger may claim it. We bind
        // the opponent atomically here so two simultaneous accepts can't both
        // win — the conditional UPDATE only fires while status is still open.
        if (game.challengerId === userId) {
          throw Object.assign(new Error("Cannot accept your own challenge"), { status: 400 });
        }
        if (game.visibility === "private") {
          if (!game.passwordHash || !submittedPassword || !verifyPassword(submittedPassword, game.passwordHash)) {
            throw Object.assign(new Error("Incorrect password for this engagement."), { status: 403 });
          }
        }
        const [me] = await tx.select().from(playersTable).where(eq(playersTable.clerkUserId, userId));
        const result = await tx.update(gamesTable)
          .set({ status: "deploying", opponentId: userId, opponentName: me?.username ?? null })
          .where(and(eq(gamesTable.id, params.data.gameId), eq(gamesTable.status, "open")))
          .returning();
        if (result.length === 0) throw Object.assign(new Error("Already claimed"), { status: 409 });
        return result[0];
      }

      if (game.status === "pending") {
        if (game.opponentId !== userId) throw Object.assign(new Error("Game not found"), { status: 404 });
        const result = await tx.update(gamesTable)
          .set({ status: "deploying" })
          .where(and(eq(gamesTable.id, params.data.gameId), eq(gamesTable.status, "pending")))
          .returning();
        if (result.length === 0) throw Object.assign(new Error("Already changed"), { status: 409 });
        return result[0];
      }

      throw Object.assign(new Error("Game is not acceptable"), { status: 400 });
    });
    res.json(AcceptGameResponse.parse(toGameDto(updated)));
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

router.post("/games/:gameId/decline", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = DeclineGameParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  // Decline semantics:
  // - status='pending': only the targeted opponent may decline.
  // - status='open':    only the challenger may withdraw the open challenge.
  // Anything past pending/open (deploying/active/completed/declined) is
  // immutable here — prevents a malicious or stale client from regressing a
  // game's lifecycle, and prevents a decline/accept race from overwriting a
  // just-accepted game.
  try {
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM games WHERE id = ${params.data.gameId} FOR UPDATE`);
      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, params.data.gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });

      if (game.status === "pending") {
        if (game.opponentId !== userId) throw Object.assign(new Error("Game not found"), { status: 404 });
        const result = await tx.update(gamesTable)
          .set({ status: "declined" })
          .where(and(eq(gamesTable.id, params.data.gameId), eq(gamesTable.status, "pending")))
          .returning();
        if (result.length === 0) throw Object.assign(new Error("Already changed"), { status: 409 });
        return result[0];
      }

      if (game.status === "open") {
        if (game.challengerId !== userId) throw Object.assign(new Error("Only the challenger can withdraw an open challenge"), { status: 403 });
        const result = await tx.update(gamesTable)
          .set({ status: "declined" })
          .where(and(eq(gamesTable.id, params.data.gameId), eq(gamesTable.status, "open")))
          .returning();
        if (result.length === 0) throw Object.assign(new Error("Already changed"), { status: 409 });
        return result[0];
      }

      throw Object.assign(new Error(`Cannot decline from status '${game.status}'`), { status: 400 });
    });
    res.json(DeclineGameResponse.parse(toGameDto(updated)));
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

router.post("/games/:gameId/deploy", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = DeployFleetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = DeployFleetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [game] = await db
    .select()
    .from(gamesTable)
    .where(and(
      eq(gamesTable.id, params.data.gameId),
      or(eq(gamesTable.challengerId, userId), eq(gamesTable.opponentId, userId))
    ));
  if (!game) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  if (game.status !== "deploying") {
    res.status(400).json({ error: "Game is not in deploying phase" });
    return;
  }

  const isChallenger = game.challengerId === userId;
  const fleetId = parsed.data.fleetId;

  const [fleet] = await db.select().from(fleetsTable).where(and(eq(fleetsTable.id, fleetId), eq(fleetsTable.ownerId, userId)));
  if (!fleet) {
    res.status(404).json({ error: "Fleet not found" });
    return;
  }

  const ships = await db.select().from(shipsTable).where(eq(shipsTable.fleetId, fleetId));

  for (const placement of parsed.data.placements) {
    const ship = ships.find(s => s.id === placement.shipId);
    if (!ship) continue;
    const [model] = await db.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
    if (!model) continue;
    await db.insert(gameUnitsTable).values({
      gameId: params.data.gameId,
      ownerId: userId,
      shipId: ship.id,
      name: ship.name,
      modelFilename: model.filename,
      faction: model.faction,
      hullPoints: model.hullPoints,
      maxHullPoints: model.hullPoints,
      hexQ: placement.hexQ,
      hexR: placement.hexR,
      heading: placement.heading,
      speed: model.speed,
      turnAngle: model.turnAngle ?? 45,
      turns: model.turns ?? 1,
      weaponRange: model.weaponRange,
      weaponDamage: model.weaponDamage,
      isDestroyed: false,
    });
  }

  const updateData = isChallenger
    ? { challengerDeployed: true, challengerFleetId: fleetId }
    : { opponentDeployed: true, opponentFleetId: fleetId };
  let updated: typeof game;
  [updated] = await db.update(gamesTable).set(updateData).where(eq(gamesTable.id, params.data.gameId)).returning();

  // If both deployed, start the game. First round: challenger has initiative
  // by default (real initiative system is a future feature).
  if (updated.challengerDeployed && updated.opponentDeployed) {
    [updated] = await db.update(gamesTable).set({
      status: "active",
      currentTurn: 1,
      currentRound: 1,
      activePlayerId: updated.challengerId,
      activeUnitId: null,
      lastActivatorId: null,
      phase: "movement",
      initiativeWinnerId: updated.challengerId,
    }).where(eq(gamesTable.id, params.data.gameId)).returning();
  }

  res.json(DeployFleetResponse.parse(updated));
});

router.get("/games/:gameId/turns", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = ListTurnsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [game] = await db
    .select()
    .from(gamesTable)
    .where(and(
      eq(gamesTable.id, params.data.gameId),
      or(eq(gamesTable.challengerId, userId), eq(gamesTable.opponentId, userId))
    ));
  if (!game) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  const turns = await db.select().from(turnsTable).where(eq(turnsTable.gameId, params.data.gameId)).orderBy(turnsTable.turnNumber);
  res.json(ListTurnsResponse.parse(turns));
});

router.post("/games/:gameId/turns", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = SubmitTurnParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = SubmitTurnBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [game] = await db
    .select()
    .from(gamesTable)
    .where(and(
      eq(gamesTable.id, params.data.gameId),
      or(eq(gamesTable.challengerId, userId), eq(gamesTable.opponentId, userId))
    ));
  if (!game) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  if (game.status !== "active") {
    res.status(400).json({ error: "Game is not active" });
    return;
  }

  // The batched submitTurn endpoint is legacy. The live game now uses the
  // ship-by-ship activation flow (POST /activate + /end-activation), which is
  // the only path that respects activePlayerId/activeUnitId/hasMovedThisRound
  // and the round-advance/initiative rules. Allowing this path in active games
  // would bypass all of those invariants, so reject it outright.
  void parsed; // body shape was validated; we just refuse the action.
  res.status(410).json({ error: "submitTurn is deprecated; use /activate and /end-activation" });
});

// ── Instant single-ship move (real-time movement, does NOT end the turn) ─────
router.post("/games/:gameId/units/:unitId/move", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = MoveUnitParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = MoveUnitBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const [game] = await db.select().from(gamesTable).where(eq(gamesTable.id, params.data.gameId));
  if (!game) { res.status(404).json({ error: "Game not found" }); return; }
  if (game.status !== "active") { res.status(400).json({ error: "Game is not active" }); return; }

  if (game.activePlayerId !== userId) { res.status(400).json({ error: "Not your activation" }); return; }
  if (game.activeUnitId !== params.data.unitId) { res.status(400).json({ error: "This unit is not the one you activated" }); return; }

  const [unit] = await db.select().from(gameUnitsTable).where(
    and(eq(gameUnitsTable.id, params.data.unitId), eq(gameUnitsTable.ownerId, userId), eq(gameUnitsTable.gameId, params.data.gameId))
  );
  if (!unit) { res.status(404).json({ error: "Unit not found" }); return; }
  if (unit.isDestroyed) { res.status(400).json({ error: "Unit is destroyed" }); return; }
  if (unit.hasMovedThisRound) { res.status(400).json({ error: "Unit has already moved this round" }); return; }

  const [updated] = await db.update(gameUnitsTable)
    .set({ hexQ: body.data.toHexQ, hexR: body.data.toHexR, heading: body.data.newHeading })
    .where(eq(gameUnitsTable.id, params.data.unitId))
    .returning();

  res.json(updated);
});

// ── DEV ONLY: free-form ship reposition ─────────────────────────────────────
// Used by the in-app developer mode to set up test scenarios. Bypasses all
// ownership / phase / activation / hasMovedThisRound checks; the only
// invariants are that the game exists, the unit belongs to that game, and the
// unit isn't destroyed. Heading is wrapped to [0, 360).
router.post("/games/:gameId/units/:unitId/dev-move", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = DevMoveUnitParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = DevMoveUnitBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const [game] = await db.select().from(gamesTable).where(eq(gamesTable.id, params.data.gameId));
  if (!game) { res.status(404).json({ error: "Game not found" }); return; }
  // Participant gate: dev-move bypasses turn/phase/ownership rules but must
  // still be confined to a game the caller is actually in. Without this, any
  // authenticated user could reach in and shove ships around in arbitrary
  // strangers' games.
  if (game.challengerId !== userId && game.opponentId !== userId) {
    res.status(403).json({ error: "Not a participant in this game" });
    return;
  }

  const [unit] = await db.select().from(gameUnitsTable).where(
    and(eq(gameUnitsTable.id, params.data.unitId), eq(gameUnitsTable.gameId, params.data.gameId))
  );
  if (!unit) { res.status(404).json({ error: "Unit not found" }); return; }
  if (unit.isDestroyed) { res.status(400).json({ error: "Unit is destroyed" }); return; }

  const heading = ((body.data.heading % 360) + 360) % 360;
  const [updated] = await db.update(gameUnitsTable)
    .set({ hexQ: body.data.hexQ, hexR: body.data.hexR, heading })
    .where(eq(gameUnitsTable.id, params.data.unitId))
    .returning();

  req.log.warn({ unitId: params.data.unitId, gameId: params.data.gameId, hexQ: body.data.hexQ, hexR: body.data.hexR, heading }, "dev-move applied");
  res.json(updated);
});

// ── Pick up a ship for its activation this round ─────────────────────────────
router.post("/games/:gameId/units/:unitId/activate", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = ActivateUnitParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const { gameId, unitId } = params.data;

  try {
    const updated = await db.transaction(async (tx) => {
      // Lock the game row to serialize concurrent activate/end-activation calls
      // — without this, two simultaneous activates from the same player could
      // both pass preconditions and one would silently win.
      const lockedRows = await tx.execute(sql`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`);
      if (lockedRows.rows.length === 0) throw Object.assign(new Error("Game not found"), { status: 404 });

      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (game.status !== "active") throw Object.assign(new Error("Game is not active"), { status: 400 });
      if (game.activePlayerId !== userId) throw Object.assign(new Error("Not your activation"), { status: 400 });
      if (game.activeUnitId && game.activeUnitId !== unitId) {
        throw Object.assign(new Error("End your current activation first"), { status: 400 });
      }

      const [unit] = await tx.select().from(gameUnitsTable).where(
        and(eq(gameUnitsTable.id, unitId), eq(gameUnitsTable.gameId, gameId))
      );
      if (!unit) throw Object.assign(new Error("Unit not found"), { status: 404 });
      if (unit.ownerId !== userId) throw Object.assign(new Error("Not your ship"), { status: 403 });
      if (unit.isDestroyed) throw Object.assign(new Error("Unit is destroyed"), { status: 400 });
      // Each phase tracks its own per-round done-flag. A ship that finished its
      // movement activation is still eligible to be picked up again for its
      // firing activation, and vice-versa.
      if (game.phase === "firing") {
        if (unit.hasFiredThisRound) throw Object.assign(new Error("Unit already fired this round"), { status: 400 });
      } else {
        if (unit.hasMovedThisRound) throw Object.assign(new Error("Unit already moved this round"), { status: 400 });
      }

      // Conditional UPDATE: succeeds only if state still matches what we saw.
      const result = await tx.update(gamesTable)
        .set({ activeUnitId: unitId })
        .where(and(
          eq(gamesTable.id, gameId),
          eq(gamesTable.activePlayerId, userId),
          eq(gamesTable.status, "active"),
          or(isNull(gamesTable.activeUnitId), eq(gamesTable.activeUnitId, unitId)),
        ))
        .returning();
      if (result.length === 0) throw Object.assign(new Error("Activation conflict, retry"), { status: 409 });
      // Fresh activation → wipe the per-activation fired-weapon ledger so
      // each weapon gets exactly one shot this firing activation. (Harmless
      // for movement-phase activations; firing-phase code reads this.)
      await tx.update(gameUnitsTable)
        .set({ firedWeaponIds: [] })
        .where(and(eq(gameUnitsTable.id, unitId), eq(gameUnitsTable.gameId, gameId)));
      return result[0];
    });
    res.json(updated);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

// ── End the current ship's activation; hand off or advance the round ─────────
router.post("/games/:gameId/end-activation", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = EndActivationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const { gameId } = params.data;

  try {
    const updated = await db.transaction(async (tx) => {
      // Lock the game row so two end-activation calls can't both fire and
      // double-advance the round.
      const lockedRows = await tx.execute(sql`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`);
      if (lockedRows.rows.length === 0) throw Object.assign(new Error("Game not found"), { status: 404 });

      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (game.status !== "active") throw Object.assign(new Error("Game is not active"), { status: 400 });
      if (game.activePlayerId !== userId) throw Object.assign(new Error("Not your activation"), { status: 400 });
      if (!game.activeUnitId) throw Object.assign(new Error("No active unit to end"), { status: 400 });

      const endedUnitId = game.activeUnitId;
      const isFiring = game.phase === "firing";
      // Mark the just-ended activation as done for THIS phase only.
      await tx.update(gameUnitsTable)
        .set(isFiring ? { hasFiredThisRound: true } : { hasMovedThisRound: true })
        .where(and(eq(gameUnitsTable.id, endedUnitId), eq(gameUnitsTable.gameId, gameId)));

      // In active games the opponent is always bound; the status check above
      // (game.status === "active") implies an accepted/claimed challenge.
      if (!game.opponentId) throw Object.assign(new Error("Game has no opponent"), { status: 500 });
      const opponentId = game.opponentId;
      const otherPlayerId = userId === game.challengerId ? opponentId : game.challengerId;
      const doneCol = isFiring ? gameUnitsTable.hasFiredThisRound : gameUnitsTable.hasMovedThisRound;
      const remainingFor = async (pid: string) => {
        const rows = await tx.select({ id: gameUnitsTable.id }).from(gameUnitsTable).where(and(
          eq(gameUnitsTable.gameId, game.id),
          eq(gameUnitsTable.ownerId, pid),
          eq(gameUnitsTable.isDestroyed, false),
          eq(doneCol, false),
        ));
        return rows.length;
      };
      const otherRemaining = await remainingFor(otherPlayerId);
      const selfRemaining = await remainingFor(userId);

      let nextActivePlayerId: string;
      let nextRound = game.currentRound;
      let nextTurn = game.currentTurn;
      let nextPhase: "movement" | "firing" = isFiring ? "firing" : "movement";
      let nextInitiativeWinnerId = game.initiativeWinnerId;

      if (otherRemaining > 0) {
        nextActivePlayerId = otherPlayerId;
      } else if (selfRemaining > 0) {
        nextActivePlayerId = userId;
      } else if (!isFiring) {
        // Movement sub-phase complete → transition to firing. Same initiative
        // winner activates first in the firing phase; round/turn don't advance.
        nextPhase = "firing";
        nextActivePlayerId = game.initiativeWinnerId ?? game.challengerId;
      } else {
        // Firing sub-phase complete → end of round. Reset BOTH per-phase flags
        // on all surviving units; new initiative winner is whoever did NOT
        // have it this round (last-activator-goes-second-next-round).
        await tx.update(gameUnitsTable)
          .set({ hasMovedThisRound: false, hasFiredThisRound: false, firedWeaponIds: [] })
          .where(and(eq(gameUnitsTable.gameId, game.id), eq(gameUnitsTable.isDestroyed, false)));
        nextRound = game.currentRound + 1;
        nextTurn = game.currentTurn + 1;
        nextPhase = "movement";
        nextInitiativeWinnerId =
          game.initiativeWinnerId === game.challengerId ? opponentId : game.challengerId;
        nextActivePlayerId = nextInitiativeWinnerId;
      }

      // Conditional UPDATE guards against any state change we didn't see.
      const result = await tx.update(gamesTable).set({
        activeUnitId: null,
        activePlayerId: nextActivePlayerId,
        lastActivatorId: userId,
        currentRound: nextRound,
        currentTurn: nextTurn,
        phase: nextPhase,
        initiativeWinnerId: nextInitiativeWinnerId,
      }).where(and(
        eq(gamesTable.id, gameId),
        eq(gamesTable.activePlayerId, userId),
        eq(gamesTable.activeUnitId, endedUnitId),
        eq(gamesTable.status, "active"),
      )).returning();
      if (result.length === 0) throw Object.assign(new Error("Activation conflict, retry"), { status: 409 });
      return result[0];
    });
    res.json(updated);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

// ── Fire a single weapon from the active ship at a target ────────────────────
// Rolls dice server-side and applies damage. The activation does NOT end here
// — the player calls /end-activation when they're done firing (potentially
// after multiple weapons). One target per weapon per activation; the server
// enforces "this weapon has not fired yet this activation" via
// gameUnits.firedWeaponIds (reset on activate + on round transition).
router.post("/games/:gameId/units/:unitId/fire-weapon", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = FireWeaponParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = FireWeaponBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const { gameId, unitId } = params.data;
  const { weaponId, targetUnitId } = body.data;

  try {
    const result = await db.transaction(async (tx) => {
      const lockedRows = await tx.execute(sql`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`);
      if (lockedRows.rows.length === 0) throw Object.assign(new Error("Game not found"), { status: 404 });

      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (game.status !== "active") throw Object.assign(new Error("Game is not active"), { status: 400 });
      if (game.phase !== "firing") throw Object.assign(new Error("Not in firing phase"), { status: 400 });
      if (game.activePlayerId !== userId) throw Object.assign(new Error("Not your activation"), { status: 400 });
      if (game.activeUnitId !== unitId) throw Object.assign(new Error("This unit is not the one you activated"), { status: 400 });

      const [attacker] = await tx.select().from(gameUnitsTable).where(and(
        eq(gameUnitsTable.id, unitId), eq(gameUnitsTable.gameId, gameId),
      ));
      if (!attacker) throw Object.assign(new Error("Attacker not found"), { status: 404 });
      if (attacker.ownerId !== userId) throw Object.assign(new Error("Not your ship"), { status: 403 });
      if (attacker.isDestroyed) throw Object.assign(new Error("Attacker is destroyed"), { status: 400 });
      // Server-authoritative one-shot-per-weapon-per-activation guard.
      const alreadyFired = (attacker.firedWeaponIds ?? []) as number[];
      if (alreadyFired.includes(weaponId)) {
        throw Object.assign(new Error("Weapon has already fired this activation"), { status: 400 });
      }

      const [target] = await tx.select().from(gameUnitsTable).where(and(
        eq(gameUnitsTable.id, targetUnitId), eq(gameUnitsTable.gameId, gameId),
      ));
      if (!target) throw Object.assign(new Error("Target not found"), { status: 404 });
      if (target.ownerId === userId) throw Object.assign(new Error("Cannot target your own ship"), { status: 400 });
      if (target.isDestroyed) throw Object.assign(new Error("Target already destroyed"), { status: 400 });

      // Weapon must belong to the attacker's ship class.
      const [attackerShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, attacker.shipId));
      if (!attackerShip) throw Object.assign(new Error("Attacker ship record missing"), { status: 500 });
      const [weapon] = await tx.select().from(weaponsTable).where(eq(weaponsTable.id, weaponId));
      if (!weapon) throw Object.assign(new Error("Weapon not found"), { status: 404 });
      if (weapon.shipModelId !== attackerShip.shipModelId) {
        throw Object.assign(new Error("Weapon does not belong to attacker"), { status: 400 });
      }

      // Range check (world units = inches; the OpenAPI spec stores weapon.range
      // in inches and the board is laid out at 1 unit = 1 inch).
      const aPos = hexToWorld(attacker.hexQ, attacker.hexR);
      const tPos = hexToWorld(target.hexQ, target.hexR);
      const dist = Math.hypot(tPos.x - aPos.x, tPos.z - aPos.z);
      if (dist > weapon.range) {
        throw Object.assign(new Error(`Target out of range (${dist.toFixed(1)}\" > ${weapon.range}\")`), { status: 400 });
      }

      // Arc check.
      const flipped = FLIP_MODELS.has(attacker.modelFilename);
      if (!isInArc({ x: aPos.x, z: aPos.z, headingDeg: attacker.heading, flipped }, tPos, weapon.arc)) {
        throw Object.assign(new Error(`Target not in ${weapon.arc} arc`), { status: 400 });
      }

      // To-hit threshold: target's ship-class hullRating, overridden to flat 4+
      // by beam-family weapons.
      const [targetShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, target.shipId));
      if (!targetShip) throw Object.assign(new Error("Target ship record missing"), { status: 500 });
      const [targetModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, targetShip.shipModelId));
      if (!targetModel) throw Object.assign(new Error("Target ship model missing"), { status: 500 });
      const traits = (weapon.traits ?? "").toLowerCase();
      const isBeam = traits.includes("beam") || traits.includes("mini-beam") || traits.includes("mini beam");
      const hitThreshold = isBeam ? 4 : targetModel.hullRating;

      // Roll attack dice → hits.
      const attackRolls: number[] = [];
      for (let i = 0; i < weapon.attackDice; i++) attackRolls.push(rollD6());
      const hits = attackRolls.filter(r => r >= hitThreshold).length;

      // Roll damage dice per hit. 1=0, 2-5=1, 6=2 + cosmetic critical roll.
      const damageRolls: number[] = [];
      const criticalRolls: number[] = [];
      let totalDamage = 0;
      for (let i = 0; i < hits; i++) {
        const d = rollD6();
        damageRolls.push(d);
        if (d === 1) totalDamage += 0;
        else if (d <= 5) totalDamage += 1;
        else { totalDamage += 2; criticalRolls.push(rollD6()); }
      }

      const targetHullBefore = target.hullPoints;
      const targetHullAfter = Math.max(0, targetHullBefore - totalDamage);
      const targetDestroyed = targetHullAfter === 0;

      await tx.update(gameUnitsTable).set({
        hullPoints: targetHullAfter,
        isDestroyed: targetDestroyed,
      }).where(eq(gameUnitsTable.id, target.id));

      // Record that this weapon has fired this activation.
      await tx.update(gameUnitsTable)
        .set({ firedWeaponIds: [...alreadyFired, weaponId] })
        .where(eq(gameUnitsTable.id, attacker.id));

      return {
        weaponId,
        targetUnitId,
        hitThreshold,
        attackRolls,
        hits,
        damageRolls,
        totalDamage,
        criticalRolls,
        targetHullBefore,
        targetHullAfter,
        targetDestroyed,
      };
    });
    res.json(result);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

// ── DEV-ONLY: auto-deploy both fleets and start the game ──────────────────────
router.post("/games/:gameId/dev/skip-deploy", async (req, res): Promise<void> => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const params = GetGameParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  let [game] = await db.select().from(gamesTable).where(eq(gamesTable.id, params.data.gameId));
  if (!game) { res.status(404).json({ error: "Game not found" }); return; }

  // Allow from pending (auto-accept) or deploying
  if (game.status === "pending") {
    [game] = await db.update(gamesTable).set({ status: "deploying" }).where(eq(gamesTable.id, game.id)).returning();
  }
  if (game.status !== "deploying") {
    res.status(400).json({ error: `Cannot skip deploy from status '${game.status}'` });
    return;
  }
  // skip-deploy only makes sense once both sides exist; open challenges have
  // no opponent until someone accepts them.
  const opponentId = game.opponentId;
  if (!opponentId) {
    res.status(400).json({ error: "No opponent has accepted this challenge yet" });
    return;
  }

  // Find challenger fleet — prefer the one stored on the game, else pick any fleet they own
  let challengerFleetId = game.challengerFleetId;
  if (!challengerFleetId) {
    const [anyFleet] = await db.select().from(fleetsTable).where(eq(fleetsTable.ownerId, game.challengerId));
    if (!anyFleet) { res.status(400).json({ error: "Challenger has no fleet" }); return; }
    challengerFleetId = anyFleet.id;
  }
  // Find opponent fleet — prefer stored, else pick any they own, else reuse challenger's
  let opponentFleetId = game.opponentFleetId;
  if (!opponentFleetId) {
    const [anyFleet] = await db.select().from(fleetsTable).where(eq(fleetsTable.ownerId, opponentId));
    opponentFleetId = anyFleet?.id ?? challengerFleetId;
  }

  // Clear any units from a previous partial deployment
  await db.delete(gameUnitsTable).where(eq(gameUnitsTable.gameId, game.id));

  const autoPlace = async (fleetId: number, ownerId: string, hexR: number, heading: number) => {
    const ships = await db.select().from(shipsTable).where(eq(shipsTable.fleetId, fleetId));
    const startQ = -Math.floor(ships.length / 2);
    for (let i = 0; i < ships.length; i++) {
      const ship = ships[i];
      const [model] = await db.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
      if (!model) continue;
      await db.insert(gameUnitsTable).values({
        gameId: game.id,
        ownerId,
        shipId: ship.id,
        name: ship.name,
        modelFilename: model.filename,
        faction: model.faction,
        hullPoints: model.hullPoints,
        maxHullPoints: model.hullPoints,
        hexQ: startQ + i * 2,
        hexR,
        heading,
        speed: model.speed,
        turnAngle: model.turnAngle ?? 45,
        weaponRange: model.weaponRange,
        weaponDamage: model.weaponDamage,
        isDestroyed: false,
      });
    }
  };

  // Challenger near top (negative hexR, facing down); opponent near bottom (facing up)
  await autoPlace(challengerFleetId, game.challengerId, -8, 180);
  await autoPlace(opponentFleetId, opponentId, 8, 0);

  const [updated] = await db.update(gamesTable).set({
    challengerDeployed: true,
    opponentDeployed: true,
    opponentFleetId,
    status: "active",
    currentTurn: 1,
    currentRound: 1,
    activePlayerId: game.challengerId,
    activeUnitId: null,
    lastActivatorId: null,
    phase: "movement",
    initiativeWinnerId: game.challengerId,
  }).where(eq(gamesTable.id, game.id)).returning();

  res.json(updated);
});

export default router;
