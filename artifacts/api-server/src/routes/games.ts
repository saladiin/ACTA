import { Router, type IRouter } from "express";
import { eq, and, or, isNull, sql } from "drizzle-orm";
import { db, gamesTable, gameUnitsTable, turnsTable, fleetsTable, shipsTable, shipModelsTable, playersTable } from "@workspace/db";
import { requireAuth, getUserId } from "../lib/auth";
import {
  CreateGameBody,
  GetGameParams,
  AcceptGameParams,
  DeclineGameParams,
  DeployFleetParams,
  DeployFleetBody,
  ListTurnsParams,
  SubmitTurnParams,
  SubmitTurnBody,
  MoveUnitParams,
  MoveUnitBody,
  ActivateUnitParams,
  EndActivationParams,
  ListGamesResponse,
  GetGameResponse,
  AcceptGameResponse,
  DeclineGameResponse,
  DeployFleetResponse,
  ListTurnsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/games", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const games = await db
    .select()
    .from(gamesTable)
    .where(or(eq(gamesTable.challengerId, userId), eq(gamesTable.opponentId, userId)))
    .orderBy(gamesTable.updatedAt);
  res.json(ListGamesResponse.parse(games));
});

router.post("/games", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const parsed = CreateGameBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [fleet] = await db.select().from(fleetsTable).where(and(eq(fleetsTable.id, parsed.data.fleetId), eq(fleetsTable.ownerId, userId)));
  if (!fleet) {
    res.status(404).json({ error: "Fleet not found" });
    return;
  }
  const [challenger] = await db.select().from(playersTable).where(eq(playersTable.clerkUserId, userId));
  const [opponent] = await db.select().from(playersTable).where(eq(playersTable.clerkUserId, parsed.data.opponentId));
  const [game] = await db.insert(gamesTable).values({
    challengerId: userId,
    opponentId: parsed.data.opponentId,
    challengerName: challenger?.username ?? null,
    opponentName: opponent?.username ?? null,
    challengerFleetId: parsed.data.fleetId,
    pointLimit: parsed.data.pointLimit,
    status: "pending",
  }).returning();
  res.status(201).json(game);
});

router.get("/games/:gameId", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = GetGameParams.safeParse(req.params);
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
  const units = await db.select().from(gameUnitsTable).where(eq(gameUnitsTable.gameId, params.data.gameId));
  const turns = await db.select().from(turnsTable).where(eq(turnsTable.gameId, params.data.gameId)).orderBy(turnsTable.turnNumber);
  res.json(GetGameResponse.parse({ game, units, turns }));
});

router.post("/games/:gameId/accept", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = AcceptGameParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [game] = await db.select().from(gamesTable).where(and(eq(gamesTable.id, params.data.gameId), eq(gamesTable.opponentId, userId)));
  if (!game) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  if (game.status !== "pending") {
    res.status(400).json({ error: "Game is not pending" });
    return;
  }
  const [updated] = await db.update(gamesTable).set({ status: "deploying" }).where(eq(gamesTable.id, params.data.gameId)).returning();
  res.json(AcceptGameResponse.parse(updated));
});

router.post("/games/:gameId/decline", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = DeclineGameParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [game] = await db.select().from(gamesTable).where(and(eq(gamesTable.id, params.data.gameId), eq(gamesTable.opponentId, userId)));
  if (!game) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  const [updated] = await db.update(gamesTable).set({ status: "declined" }).where(eq(gamesTable.id, params.data.gameId)).returning();
  res.json(DeclineGameResponse.parse(updated));
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
      if (unit.hasMovedThisRound) throw Object.assign(new Error("Unit already moved this round"), { status: 400 });

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
      await tx.update(gameUnitsTable)
        .set({ hasMovedThisRound: true })
        .where(and(eq(gameUnitsTable.id, endedUnitId), eq(gameUnitsTable.gameId, gameId)));

      const otherPlayerId = userId === game.challengerId ? game.opponentId : game.challengerId;
      const remainingFor = async (pid: string) => {
        const rows = await tx.select({ id: gameUnitsTable.id }).from(gameUnitsTable).where(and(
          eq(gameUnitsTable.gameId, game.id),
          eq(gameUnitsTable.ownerId, pid),
          eq(gameUnitsTable.isDestroyed, false),
          eq(gameUnitsTable.hasMovedThisRound, false),
        ));
        return rows.length;
      };
      const otherRemaining = await remainingFor(otherPlayerId);
      const selfRemaining = await remainingFor(userId);

      let nextActivePlayerId: string;
      let nextRound = game.currentRound;
      let nextTurn = game.currentTurn;

      if (otherRemaining > 0) {
        nextActivePlayerId = otherPlayerId;
      } else if (selfRemaining > 0) {
        nextActivePlayerId = userId;
      } else {
        // Round complete. Reset has-moved flags for ALL surviving units, then
        // hand initiative to the OTHER player (last activator goes second next round).
        await tx.update(gameUnitsTable)
          .set({ hasMovedThisRound: false })
          .where(and(eq(gameUnitsTable.gameId, game.id), eq(gameUnitsTable.isDestroyed, false)));
        nextRound = game.currentRound + 1;
        nextTurn = game.currentTurn + 1;
        nextActivePlayerId = userId === game.challengerId ? game.opponentId : game.challengerId;
      }

      // Conditional UPDATE guards against any state change we didn't see.
      const result = await tx.update(gamesTable).set({
        activeUnitId: null,
        activePlayerId: nextActivePlayerId,
        lastActivatorId: userId,
        currentRound: nextRound,
        currentTurn: nextTurn,
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
    const [anyFleet] = await db.select().from(fleetsTable).where(eq(fleetsTable.ownerId, game.opponentId));
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
  await autoPlace(opponentFleetId, game.opponentId, 8, 0);

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
  }).where(eq(gamesTable.id, game.id)).returning();

  res.json(updated);
});

export default router;
