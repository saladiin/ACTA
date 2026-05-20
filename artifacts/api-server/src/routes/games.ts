import { Router, type IRouter } from "express";
import { eq, and, or } from "drizzle-orm";
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

  // If both deployed, start the game
  if (updated.challengerDeployed && updated.opponentDeployed) {
    [updated] = await db.update(gamesTable).set({ status: "active", currentTurn: 1 }).where(eq(gamesTable.id, params.data.gameId)).returning();
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

  // Determine whose turn it is: challenger on odd, opponent on even
  const isChallenger = game.challengerId === userId;
  const isChallengerTurn = game.currentTurn % 2 === 1;
  if (isChallenger !== isChallengerTurn) {
    res.status(400).json({ error: "Not your turn" });
    return;
  }

  // Apply moves
  for (const move of parsed.data.moves) {
    const raw = Array.isArray(move.unitId) ? move.unitId[0] : move.unitId;
    const unitId = typeof raw === "string" ? parseInt(raw, 10) : raw;
    await db.update(gameUnitsTable)
      .set({ hexQ: move.toHexQ, hexR: move.toHexR, heading: move.newHeading })
      .where(and(eq(gameUnitsTable.id, unitId), eq(gameUnitsTable.ownerId, userId)));
  }

  // Apply attacks
  for (const attack of parsed.data.attacks) {
    const attackerRaw = Array.isArray(attack.attackerUnitId) ? attack.attackerUnitId[0] : attack.attackerUnitId;
    const targetRaw = Array.isArray(attack.targetUnitId) ? attack.targetUnitId[0] : attack.targetUnitId;
    const attackerId = typeof attackerRaw === "string" ? parseInt(attackerRaw, 10) : attackerRaw;
    const targetId = typeof targetRaw === "string" ? parseInt(targetRaw, 10) : targetRaw;

    const [attacker] = await db.select().from(gameUnitsTable).where(and(eq(gameUnitsTable.id, attackerId), eq(gameUnitsTable.ownerId, userId)));
    if (!attacker || attacker.isDestroyed) continue;
    const [target] = await db.select().from(gameUnitsTable).where(eq(gameUnitsTable.id, targetId));
    if (!target || target.isDestroyed || target.ownerId === userId) continue;

    const newHp = Math.max(0, target.hullPoints - attacker.weaponDamage);
    await db.update(gameUnitsTable).set({ hullPoints: newHp, isDestroyed: newHp === 0 }).where(eq(gameUnitsTable.id, targetId));
  }

  // Record the turn
  const [turn] = await db.insert(turnsTable).values({
    gameId: params.data.gameId,
    playerId: userId,
    turnNumber: game.currentTurn,
    moves: parsed.data.moves,
    attacks: parsed.data.attacks,
    resolvedAt: new Date(),
  }).returning();

  // Advance turn
  await db.update(gamesTable).set({ currentTurn: game.currentTurn + 1 }).where(eq(gamesTable.id, params.data.gameId));

  // Check if all opponent units are destroyed
  const opponentId = isChallenger ? game.opponentId : game.challengerId;
  const remainingUnits = await db.select().from(gameUnitsTable).where(
    and(eq(gameUnitsTable.gameId, params.data.gameId), eq(gameUnitsTable.ownerId, opponentId), eq(gameUnitsTable.isDestroyed, false))
  );
  if (remainingUnits.length === 0) {
    await db.update(gamesTable).set({ status: "completed", winnerId: userId }).where(eq(gamesTable.id, params.data.gameId));
    await db.update(playersTable).set({ wins: game.currentTurn }).where(eq(playersTable.clerkUserId, userId));
    await db.update(playersTable).set({ losses: game.currentTurn }).where(eq(playersTable.clerkUserId, opponentId));
  }

  res.status(201).json(turn);
});

export default router;
