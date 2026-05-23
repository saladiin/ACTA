import { Router, type IRouter } from "express";
import { eq, and, or, isNull, sql } from "drizzle-orm";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, gamesTable, gameUnitsTable, turnsTable, fleetsTable, shipsTable, shipModelsTable, playersTable, weaponsTable, unitCriticalEffectsTable } from "@workspace/db";
import { requireAuth, getUserId } from "../lib/auth";
import {
  parseShipTraits,
  parseWeaponTraits,
  stealthFloor,
  effectiveAttackDice,
  damageMultiplier,
} from "../lib/traits";
import {
  CRITICAL_TABLE,
  locationFromRoll,
  findEntry,
  rollDice,
  deriveCritEffects,
  isDice,
  CANONICAL_ARCS,
} from "../lib/critical-table";
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
  ChooseSpecialActionParams,
  ChooseSpecialActionBody,
  DamageControlParams,
  DamageControlBody,
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

// Render-time orientation patch for legacy/misauthored models. Empty by
// design: new models must follow the orientation spec in replit.md
// (nose along local +Z). KEEP IN SYNC with the FLIP_MODELS set in
// artifacts/b5acta/src/pages/game-board.tsx.
const FLIP_MODELS: Set<string> = new Set();

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

  // Clamp belt-and-braces; the Zod schema already enforces 4..30 but the DB
  // would otherwise accept anything an attacker could sneak past the spec.
  const deploymentDepth = Math.max(4, Math.min(30, Math.trunc(parsed.data.deploymentDepth)));
  // crewQualityMode: belt-and-braces validation. Zod schema already restricts
  // to the enum, but if a future codegen drift relaxes the type we still want
  // to reject anything outside the two known modes rather than silently
  // letting it through as a typo (e.g. "Custom" with capital C).
  const crewQualityMode = parsed.data.crewQualityMode === "custom" ? "custom" : "standard";

  const [game] = await db.insert(gamesTable).values({
    challengerId: userId,
    opponentId: null,
    challengerName: challenger?.username ?? null,
    opponentName: null,
    challengerFleetId: fleetId,
    pointLimit: parsed.data.pointLimit,
    visibility,
    passwordHash,
    deploymentDepth,
    crewQualityMode,
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
  // Attach live critical-hit rows to each unit so the UI can render the
  // crit panel and DC button without a second query.
  const unitIds = units.map(u => u.id);
  const critRows = unitIds.length === 0 ? [] : await db.select().from(unitCriticalEffectsTable)
    .where(or(...unitIds.map(id => eq(unitCriticalEffectsTable.gameUnitId, id))));
  const critsByUnit = new Map<number, typeof critRows>();
  for (const r of critRows) {
    const list = critsByUnit.get(r.gameUnitId) ?? [];
    list.push(r);
    critsByUnit.set(r.gameUnitId, list);
  }
  const unitsWithCrits = units.map(u => ({
    ...u,
    criticals: critsByUnit.get(u.id) ?? [],
    // Slice C derived flags — surfaced to the client so badges can render
    // without re-deriving the rule.
    isCrippled: u.maxHullPoints > 0 && u.hullPoints * 2 <= u.maxHullPoints && !u.isDestroyed,
    isSkeletonCrew: u.maxCrewPoints > 0 && u.crewPoints * 2 <= u.maxCrewPoints && !u.isDestroyed,
  }));
  res.json(GetGameResponse.parse({ game: toGameDto(game), units: unitsWithCrits, turns }));
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

  // Zone validation: challenger deploys from +Z short edge, opponent from -Z.
  // hexQ/hexR are stored as world inches (see game-board.tsx handleYardsDeploy).
  // Board is 48"×72"; placements must stay inside the player's deployment zone.
  const D = game.deploymentDepth;
  const zoneMinR = isChallenger ? 36 - D : -36;
  const zoneMaxR = isChallenger ? 36 : -36 + D;
  for (const placement of parsed.data.placements) {
    if (placement.hexQ < -24 || placement.hexQ > 24 || placement.hexR < zoneMinR || placement.hexR > zoneMaxR) {
      res.status(400).json({
        error: `Placement (${placement.hexQ}, ${placement.hexR}) is outside your ${D}\" deployment zone.`,
      });
      return;
    }
  }

  // Crew Quality assignment: in "standard" games the server forces every ship
  // to CQ 4 regardless of what the client sent (cheap defense against a hand-
  // crafted request bumping CQ in a fixed-quality match). In "custom" games
  // we honor the per-ship value, defaulting to 4 if omitted, clamped to 1..6.
  const isStandardCQ = game.crewQualityMode !== "custom";

  for (const placement of parsed.data.placements) {
    const ship = ships.find(s => s.id === placement.shipId);
    if (!ship) continue;
    const [model] = await db.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
    if (!model) continue;
    const requestedCQ = placement.crewQuality ?? 4;
    const crewQuality = isStandardCQ
      ? 4
      : Math.max(1, Math.min(6, Math.trunc(requestedCQ)));
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
      crewQuality,
      // Shields start full per the sheet ("Shields X/Y", regenerates Y per turn).
      shieldsCurrent: model.shieldMax ?? 0,
      // Crew defaults from the ship_model record. Used by Skeleton-Crew /
      // damage-table logic in Slice C.
      crewPoints: model.crew ?? 0,
      maxCrewPoints: model.crew ?? 0,
      damageState: "normal",
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
  // Slice C: adrift ships do not take voluntary movement (they drift
  // compulsorily in the end phase). Crippled / skeleton movement caps
  // (½ speed, 45°/1 turn) are advisory at the route layer — the client
  // surfaces them via isCrippled / isSkeletonCrew flags — but adrift is
  // an absolute block on player-driven movement.
  if (unit.damageState === "adrift") {
    res.status(400).json({ error: "Adrift ship cannot be moved by its commander" }); return;
  }

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
          .set({
            hasMovedThisRound: false,
            hasFiredThisRound: false,
            firedWeaponIds: [],
            // Special Actions are one-per-round; wipe at round rollover so
            // every ship is free to declare again next round.
            specialAction: null,
            specialActionTargetId: null,
          })
          .where(and(eq(gameUnitsTable.gameId, game.id), eq(gameUnitsTable.isDestroyed, false)));
        // Slice C: resolve delayed catastrophic kills. Any ship marked
        // "exploding-end-of-next" at the previous round's damage table
        // detonates now and is removed. (Round-precision is approximated:
        // we destroy at the first end-of-round after the marker is set.
        // Tightening to "end of NEXT round" would require an extra
        // damageStateRound column; deferred until proven necessary.)
        await tx.update(gameUnitsTable).set({
          damageState: "destroyed",
          isDestroyed: true,
        }).where(and(
          eq(gameUnitsTable.gameId, game.id),
          eq(gameUnitsTable.damageState, "exploding-end-of-next"),
        ));
        // Re-evaluate win condition after delayed kills.
        const postExplosion = await tx.select().from(gameUnitsTable)
          .where(eq(gameUnitsTable.gameId, game.id));
        let cAlive = 0, oAlive = 0;
        for (const u of postExplosion) {
          if (u.isDestroyed) continue;
          if (u.ownerId === game.challengerId) cAlive++;
          else if (u.ownerId === game.opponentId) oAlive++;
        }
        if (game.opponentId && cAlive === 0 && oAlive > 0) {
          await tx.update(gamesTable).set({ status: "completed", winnerId: game.opponentId })
            .where(eq(gamesTable.id, game.id));
        } else if (game.opponentId && oAlive === 0 && cAlive > 0) {
          await tx.update(gamesTable).set({ status: "completed", winnerId: game.challengerId })
            .where(eq(gamesTable.id, game.id));
        } else if (game.opponentId && cAlive === 0 && oAlive === 0) {
          // Double-KO via delayed explosions → draw (winnerId stays null).
          await tx.update(gamesTable).set({ status: "completed", winnerId: null })
            .where(eq(gamesTable.id, game.id));
        }
        // Shield regen — each surviving ship recovers `shieldRegenRate` toward
        // its `shieldMax`. Done per-row because the cap is row-specific.
        const survivors = await tx.select().from(gameUnitsTable).where(and(
          eq(gameUnitsTable.gameId, game.id), eq(gameUnitsTable.isDestroyed, false),
        ));
        for (const u of survivors) {
          // game_units.shipId → ships.id → ship_models.id
          const [ship] = await tx.select().from(shipsTable).where(eq(shipsTable.id, u.shipId));
          if (!ship) continue;
          const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
          const max = model?.shieldMax ?? 0;
          const regen = model?.shieldRegenRate ?? 0;
          if (max <= 0 || regen <= 0) continue;
          const next = Math.min(max, u.shieldsCurrent + regen);
          if (next !== u.shieldsCurrent) {
            await tx.update(gameUnitsTable).set({ shieldsCurrent: next }).where(eq(gameUnitsTable.id, u.id));
          }
        }
        nextRound = game.currentRound + 1;
        nextTurn = game.currentTurn + 1;
        nextPhase = "movement";
        nextInitiativeWinnerId =
          game.initiativeWinnerId === game.challengerId ? opponentId : game.challengerId;
        nextActivePlayerId = nextInitiativeWinnerId;
      }

      // If a delayed catastrophic explosion just ended the game (status
      // flipped to 'completed' inside this same transaction), short-circuit
      // the round-advance: don't reset phase/round, just clear the
      // activation pointers. The conditional WHERE below would otherwise
      // fail (status no longer 'active'), rolling the win back.
      const [postGame] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (postGame?.status === "completed") {
        // Game ended via delayed-kill processing this turn. Clear
        // activation pointers and return the updated games row so the
        // response shape continues to match EndActivationResponse
        // (a Game). No status='active' guard here — the row is now
        // terminal and won't be raced by another writer.
        const [completed] = await tx.update(gamesTable)
          .set({ activeUnitId: null, activePlayerId: null, lastActivatorId: userId })
          .where(eq(gamesTable.id, gameId))
          .returning();
        return completed;
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

      // ── Special Action gating ──────────────────────────────────────────────
      // Restrictions apply whether the CQ check succeeded or failed, so we
      // strip the "-failed" suffix to evaluate the always-on penalty side.
      const rawAction = attacker.specialAction ?? "";
      const baseAction = rawAction.replace(/-failed$/, "");
      // Run Silent: cannot fire at all this turn (always-on penalty side).
      if (baseAction === "run-silent") {
        throw Object.assign(new Error("Cannot fire while Running Silent"), { status: 400 });
      }
      // Close Blast Doors & All Stop and Pivot: only 1 weapon system per turn.
      // Failed CQ shouldn't apply here (these are automatic actions), but the
      // strip handles them uniformly anyway.
      if ((baseAction === "blast-doors" || baseAction === "all-stop-pivot") && alreadyFired.length >= 1) {
        throw Object.assign(new Error(`${baseAction === "blast-doors" ? "Close Blast Doors" : "All Stop and Pivot"} limits firing to 1 weapon system`), { status: 400 });
      }
      // Concentrate All Fire-power: only the nominated target may be attacked.
      // Only the successful version locks the target — the failed flavour just
      // wastes the action with no benefit and no penalty.
      const concentrateActive = attacker.specialAction === "concentrate-fire";
      if (concentrateActive && attacker.specialActionTargetId !== null && attacker.specialActionTargetId !== targetUnitId) {
        throw Object.assign(new Error("Concentrate All Fire-power locks you to the nominated target"), { status: 400 });
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

      // ── Attacker's live critical-hit effects ─────────────────────────────
      // Loaded once and used to gate weapon eligibility (forbidden arc /
      // forbidden weapon), adjust AD, and bump to-hit floor.
      const attackerCritRows = await tx.select().from(unitCriticalEffectsTable)
        .where(eq(unitCriticalEffectsTable.gameUnitId, attacker.id));
      const attackerCrits = deriveCritEffects(attackerCritRows.map(r => ({
        effectKey: r.effectKey,
        randomArc: r.randomArc,
        randomWeaponId: r.randomWeaponId,
        lostTraits: r.lostTraits ?? [],
      })));
      if (attackerCrits.forbiddenWeaponIds.has(weaponId)) {
        throw Object.assign(new Error("This weapon is offline (critical hit)"), { status: 400 });
      }
      if (attackerCrits.forbiddenArcs.has(weapon.arc)) {
        throw Object.assign(new Error(`Weapons in the ${weapon.arc} arc are offline (critical hit)`), { status: 400 });
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

      // Resolve attacker/target ship classes (needed for traits + hit threshold).
      const [targetShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, target.shipId));
      if (!targetShip) throw Object.assign(new Error("Target ship record missing"), { status: 500 });
      const [targetModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, targetShip.shipModelId));
      if (!targetModel) throw Object.assign(new Error("Target ship model missing"), { status: 500 });

      // ── Target's live critical-hit effects ───────────────────────────────
      const targetCritRows = await tx.select().from(unitCriticalEffectsTable)
        .where(eq(unitCriticalEffectsTable.gameUnitId, target.id));
      const targetCrits = deriveCritEffects(targetCritRows.map(r => ({
        effectKey: r.effectKey,
        randomArc: r.randomArc,
        randomWeaponId: r.randomWeaponId,
        lostTraits: r.lostTraits ?? [],
      })));

      // ── Trait parse ──────────────────────────────────────────────────────
      // Filter the target's ship traits by any crit-lost trait names so
      // Adaptive Armour / Stealth / Interceptors / etc. drop out when a
      // power-feedback/implosion/etc. crit nuked them.
      const wt = parseWeaponTraits(weapon.traits);
      const lostLc = new Set(Array.from(targetCrits.lostTraitNames).map(n => n.toLowerCase()));
      const filterTraits = (raw: string | null | undefined): string => {
        if (!raw) return "";
        return raw.split(/[;,]/).map(t => t.trim()).filter(Boolean)
          .filter(t => !lostLc.has(t.toLowerCase().split(/\s+/)[0]))
          .join("; ");
      };
      const targetTraits = parseShipTraits(filterTraits(targetModel.traits));

      // ── Effective AD count ───────────────────────────────────────────────
      // Order: weapon AD modifiers (AP/Super AP/Weak) first, then Intensify
      // Defensive Fire halve (min 1). Intensify is on the *attacker*, applied
      // last so it caps even a buffed weapon. Attacker crits apply a flat
      // negative AD modifier (Capacitors / Targeting) before halving.
      const intensifyActive = baseAction === "intensify-defense";
      const weaponAd = effectiveAttackDice(weapon.attackDice, wt);
      const adAfterCrits = Math.max(1, weaponAd + attackerCrits.allWeaponsAdMod);
      const finalAttackDice = intensifyActive ? Math.max(1, Math.floor(adAfterCrits / 2)) : adAfterCrits;

      // ── To-hit threshold ─────────────────────────────────────────────────
      // Beam family hits on 4+. Otherwise the target class's hullRating.
      // Stealth raises the floor (skipped by Energy Mine). Attacker crit
      // `weaponsHitOn4` (Sensors etc.) bumps the floor to a minimum of 4.
      const baseThreshold = (wt.beam || wt.miniBeam) ? 4 : targetModel.hullRating;
      const stealthMin = wt.energyMine ? 0 : stealthFloor(targetTraits.stealth, dist, false);
      const critFloor = attackerCrits.weaponsHitOn4 ? 4 : 0;
      const hitThreshold = Math.max(baseThreshold, stealthMin, critFloor);

      // ── Roll AD → raw hits ───────────────────────────────────────────────
      // Beam: every to-hit die showing 4+ "explodes" and rolls one additional
      // die (also checked for hit + further explosion). Cap per-die at 100
      // chained rolls as a runaway-loop guard.
      // Twin Linked: missed AD may be re-rolled once.
      // Concentrate Fire: missed AD against the locked target may be re-rolled
      // once (skipped by Beam, Energy Mine, Twin Linked per rulebook).
      // A single die may be re-rolled by at most ONE of these two effects.
      const EXPLODE_ON = 4;
      const EXPLODE_CAP_PER_DIE = 100;
      const concentrateRerollEligible =
        concentrateActive && !wt.beam && !wt.miniBeam && !wt.twinLinked && !wt.energyMine;
      const attackRolls: number[] = [];
      let hits = 0;
      let beamExplosions = 0;
      let twinRerolls = 0;
      let concentrateRerolls = 0;
      for (let i = 0; i < finalAttackDice; i++) {
        let r = rollD6();
        attackRolls.push(r);
        let hitFlag = r >= hitThreshold;
        if (!hitFlag && wt.twinLinked) {
          const r2 = rollD6();
          attackRolls.push(r2);
          twinRerolls++;
          if (r2 >= hitThreshold) { hitFlag = true; r = r2; }
        } else if (!hitFlag && concentrateRerollEligible) {
          const r2 = rollD6();
          attackRolls.push(r2);
          concentrateRerolls++;
          if (r2 >= hitThreshold) { hitFlag = true; r = r2; }
        }
        if (hitFlag) hits++;
        if (wt.beam) {
          let chain = 0;
          while (r >= EXPLODE_ON && chain < EXPLODE_CAP_PER_DIE) {
            r = rollD6();
            attackRolls.push(r);
            beamExplosions++;
            if (r >= hitThreshold) hits++;
            chain++;
          }
        }
      }

      // ── Damage multiplier (Double / Triple / Quad) ───────────────────────
      const { mult, bulkheadFloor } = damageMultiplier(wt);

      // ── Defender pipeline: Dodge → Interceptors → Shields ────────────────
      // Per the sheet: AD → Dodges → Interceptors → Shields → Attack Table → GEG → Crits → Blast Doors.
      let remainingHits = hits;
      const dodgeRolls: number[] = [];
      let dodgesSuccessful = 0;
      // Dodge: per-hit defender d6 ≥ dodge → miss. Lost if Accurate / Energy
      // Mine. (Sheet also says "Lost if Adrift or not moved" — Adrift state
      // arrives in Slice C; this pre-condition is currently not modelled, so
      // any ship with a Dodge rating may dodge.)
      const dodgeActive = targetTraits.dodge > 0 && !wt.accurate && !wt.energyMine;
      if (dodgeActive) {
        for (let i = 0; i < remainingHits; i++) {
          const d = rollD6();
          dodgeRolls.push(d);
          if (d >= targetTraits.dodge) dodgesSuccessful++;
        }
        remainingHits = Math.max(0, remainingHits - dodgesSuccessful);
      }

      // Interceptors: defender absorbs up to X hits per firing activation.
      // Skipped by Beam, Mini Beam, Mass Driver, Energy Mine.
      let interceptedHits = 0;
      const interceptorsAvailable = targetTraits.interceptors;
      const interceptorsBypassed = wt.beam || wt.miniBeam || wt.massDriver || wt.energyMine;
      if (!interceptorsBypassed && interceptorsAvailable > 0 && remainingHits > 0) {
        interceptedHits = Math.min(remainingHits, interceptorsAvailable);
        remainingHits -= interceptedHits;
      }

      // Shields: each hit costs `mult` shield points (Double Damage hits count
      // double, etc.). Partial absorption: a hit hitting a partly-full shield
      // pool drains the pool to 0 and still gets through. Mass Driver and
      // Energy Mine bypass shields.
      let shieldsBefore = target.shieldsCurrent;
      let shieldsCurrent = shieldsBefore;
      let shieldedHits = 0;
      if (!wt.massDriver && !wt.energyMine && shieldsCurrent > 0 && remainingHits > 0) {
        while (remainingHits > 0 && shieldsCurrent >= mult) {
          shieldsCurrent -= mult;
          shieldedHits++;
          remainingHits--;
        }
        // Final partial-absorption hit (drains remaining pool, passes through).
        if (remainingHits > 0 && shieldsCurrent > 0) {
          shieldsCurrent = 0;
          // Note: hit still gets through; we don't decrement remainingHits.
        }
      }

      // ── Attack Table per surviving hit ──────────────────────────────────
      // 1 = Bulkhead (no dmg, no crew unless multiplier floor),
      // 2-5 = Solid (-1 dmg, -1 crew, * mult),
      // 6 = Crit (Solid + roll on Critical Hit table — Slice B will apply
      //          structural effects; for now we just log the rolls).
      const attackTableRolls: number[] = [];
      const criticalRolls: number[] = [];
      // Pending crits: each gets a location/effect roll after the loop so
      // we can resolve dice penalties + persist rows in one batch.
      type PendingCrit = { locationRoll: number; effectRoll: number };
      const pendingCrits: PendingCrit[] = [];
      let bulkheadHits = 0;
      let solidHits = 0;
      let criticalHits = 0;
      let totalDamage = 0;
      let totalCrewLost = 0;
      for (let i = 0; i < remainingHits; i++) {
        const d = rollD6();
        attackTableRolls.push(d);
        if (d === 1) {
          bulkheadHits++;
          totalDamage += bulkheadFloor;
        } else if (d <= 5) {
          solidHits++;
          totalDamage += 1 * mult;
          totalCrewLost += 1 * mult;
        } else {
          if (wt.energyMine) {
            // Energy Mine: no criticals; counts as Solid.
            solidHits++;
          } else {
            criticalHits++;
            const locRoll = rollD6();
            const effRoll = rollD6();
            pendingCrits.push({ locationRoll: locRoll, effectRoll: effRoll });
            criticalRolls.push(effRoll);
          }
          totalDamage += 1 * mult;
          totalCrewLost += 1 * mult;
        }
      }

      // ── GEG: reduce structural damage AND crew per surviving hit ────────
      // Critical-table effects are applied AFTER GEG (sheet: "criticals not
      // affected"). Mass Driver bypasses GEG.
      const gegReduction = wt.massDriver ? 0 : targetTraits.geg * remainingHits;
      let damageAfterGeg = Math.max(0, totalDamage - gegReduction);
      let crewAfterGeg = Math.max(0, totalCrewLost - gegReduction);

      // ── Resolve critical-hit table rolls ─────────────────────────────────
      // For each pending crit: pick location (1d6→bucket), look up entry,
      // resolve dice penalties, sample random arc / weapon / trait, and add
      // structural dmg+crew on top of the GEG-reduced totals.
      const criticalsApplied: Array<{
        id: number; gameUnitId: number;
        location: number; effectKey: string; name: string;
        damageApplied: number; crewApplied: number;
        randomArc: string | null; randomWeaponId: number | null;
        lostTraits: string[];
        appliedRound: number; repairable: boolean;
      }> = [];
      // Cache target's weapon list (grouped by arc) for random-arc picks.
      const targetWeapons = await tx.select().from(weaponsTable)
        .where(eq(weaponsTable.shipModelId, targetModel.id));
      const weaponsByArc = new Map<string, typeof targetWeapons>();
      for (const w of targetWeapons) {
        const list = weaponsByArc.get(w.arc) ?? [];
        list.push(w);
        weaponsByArc.set(w.arc, list);
      }
      const targetTraitNames = (targetModel.traits ?? "")
        .split(/[;,]/).map(t => t.trim()).filter(Boolean)
        .filter(t => !lostLc.has(t.toLowerCase().split(/\s+/)[0]))
        .map(t => t.split(/\s+/)[0]);
      const currentRound = game.currentRound;
      // Track gross crit damage so we can later scale the per-crit
      // `damageApplied` to the net amount that actually reached hull
      // (after Adaptive Armour + Blast Doors). DC refunds the *net* delta.
      const critGrossSoFar = totalDamage;  // structural-only at this point
      const damagePreCrits = damageAfterGeg;
      let critDmgGross = 0;
      const insertedIds: number[] = [];
      const insertedGrossDmg: number[] = [];
      for (const pc of pendingCrits) {
        const loc = locationFromRoll(pc.locationRoll);
        const entry = findEntry(loc, pc.effectRoll);
        if (!entry) continue;
        const dmgApplied = isDice(entry.dmg) ? rollDice(entry.dmg.dice) : entry.dmg;
        const crewApplied = isDice(entry.crew) ? rollDice(entry.crew.dice) : entry.crew;
        let randomArc: string | null = null;
        let randomWeaponId: number | null = null;
        const lostTraits: string[] = [];
        // Random-arc effects roll from the canonical arc set, not just
        // occupied arcs (sheet intent: arc is rolled before checking what
        // lives there).
        if (entry.flags.randomArcNoFire) {
          randomArc = CANONICAL_ARCS[Math.floor(Math.random() * CANONICAL_ARCS.length)];
        }
        // Random-arc-then-one-weapon: roll arc first, then pick a weapon
        // within that arc (if any). If the rolled arc is empty, the effect
        // is wasted (no weapon blocked) — matches sheet randomness.
        if (entry.flags.randomArcOneWeaponNoFire) {
          randomArc = CANONICAL_ARCS[Math.floor(Math.random() * CANONICAL_ARCS.length)];
          const arcWeapons = weaponsByArc.get(randomArc) ?? [];
          if (arcWeapons.length > 0) {
            const w = arcWeapons[Math.floor(Math.random() * arcWeapons.length)];
            randomWeaponId = w.id;
          }
        }
        if (entry.flags.loseTraits && targetTraitNames.length > 0) {
          const pool = [...targetTraitNames];
          for (let k = 0; k < entry.flags.loseTraits && pool.length > 0; k++) {
            const idx = Math.floor(Math.random() * pool.length);
            lostTraits.push(pool.splice(idx, 1)[0]);
          }
        }
        const [inserted] = await tx.insert(unitCriticalEffectsTable).values({
          gameUnitId: target.id,
          effectKey: entry.effectKey,
          location: loc,
          name: entry.name,
          damageApplied: dmgApplied,
          crewApplied,
          randomArc,
          randomWeaponId,
          lostTraits,
          appliedRound: currentRound,
          repairable: entry.repairable,
        }).returning();
        damageAfterGeg += dmgApplied;
        crewAfterGeg += crewApplied;
        critDmgGross += dmgApplied;
        insertedIds.push(inserted.id);
        insertedGrossDmg.push(dmgApplied);
        criticalsApplied.push({
          id: inserted.id, gameUnitId: inserted.gameUnitId,
          location: loc, effectKey: entry.effectKey, name: entry.name,
          damageApplied: dmgApplied, crewApplied,
          randomArc, randomWeaponId, lostTraits,
          appliedRound: currentRound, repairable: entry.repairable,
        });
      }
      // Silence "declared but unused" — kept for clarity in the calculation.
      void critGrossSoFar; void damagePreCrits;

      // ── Adaptive Armour: halve dmg & crew, min 1 (if any) ────────────────
      let adaptiveHalved = false;
      if (targetTraits.adaptiveArmour && (damageAfterGeg > 0 || crewAfterGeg > 0)) {
        adaptiveHalved = true;
        damageAfterGeg = damageAfterGeg > 0 ? Math.max(1, Math.floor(damageAfterGeg / 2)) : 0;
        crewAfterGeg = crewAfterGeg > 0 ? Math.max(1, Math.floor(crewAfterGeg / 2)) : 0;
      }

      // ── Close Blast Doors: 5+ save per point of damage AND per crew ──────
      // Declared by the *target* (the defender), not the attacker. Only the
      // successful version grants saves (failed declaration is just a wasted
      // SA with no benefit but the always-on 1-weapon penalty).
      const blastDoorsActive = target.specialAction === "blast-doors";
      const blastDoorsDamageRolls: number[] = [];
      const blastDoorsCrewRolls: number[] = [];
      let blastDoorsDamageSaved = 0;
      let blastDoorsCrewSaved = 0;
      if (blastDoorsActive) {
        for (let i = 0; i < damageAfterGeg; i++) {
          const r = rollD6();
          blastDoorsDamageRolls.push(r);
          if (r >= 5) blastDoorsDamageSaved++;
        }
        for (let i = 0; i < crewAfterGeg; i++) {
          const r = rollD6();
          blastDoorsCrewRolls.push(r);
          if (r >= 5) blastDoorsCrewSaved++;
        }
      }
      const finalDamage = Math.max(0, damageAfterGeg - blastDoorsDamageSaved);
      const finalCrewLost = Math.max(0, crewAfterGeg - blastDoorsCrewSaved);

      // ── Scale per-crit damageApplied to the NET hull damage actually
      //    landed by each crit, so Damage-Control refunds the right amount.
      //    `damageAfterGeg` includes both structural + crit gross damage.
      //    The combined pool is then reduced by Adaptive Armour + Blast
      //    Doors; we attribute the resulting reduction proportionally so
      //    structural and crit damage shrink by the same ratio.
      if (critDmgGross > 0 && insertedIds.length > 0) {
        const ratio = damageAfterGeg > 0 ? finalDamage / damageAfterGeg : 0;
        for (let k = 0; k < insertedIds.length; k++) {
          const netDmg = Math.floor(insertedGrossDmg[k] * ratio);
          if (netDmg !== insertedGrossDmg[k]) {
            await tx.update(unitCriticalEffectsTable)
              .set({ damageApplied: netDmg })
              .where(eq(unitCriticalEffectsTable.id, insertedIds[k]));
            // Mirror to the response payload so client-side panel matches DB.
            const c = criticalsApplied.find(x => x.id === insertedIds[k]);
            if (c) c.damageApplied = netDmg;
          }
        }
      }

      // ── Apply to hull + crew ─────────────────────────────────────────────
      const targetHullBefore = target.hullPoints;
      const targetHullAfter = Math.max(0, targetHullBefore - finalDamage);
      const targetCrewBefore = target.crewPoints;
      const targetCrewAfter = Math.max(0, targetCrewBefore - finalCrewLost);

      // ── Damage table (Slice C) ───────────────────────────────────────────
      // Fired when this attack drops hull to 0 from a still-living state.
      // Sheet: roll 1d6 + abs(overkill) → 1-6 adrift, 7-11 destroyed,
      // 12-17 exploding-end-of-next, 18+ explodes now (AOE).
      let damageTable: {
        overkill: number; roll: number; total: number;
        outcome: "adrift" | "destroyed" | "exploding-end-of-next" | "explodes-now";
      } | null = null;
      let nextDamageState: string = target.damageState;
      let targetDestroyed: boolean = target.isDestroyed;
      const explosionVictims: Array<{
        unitId: number; hitsTaken: number; finalDamage: number;
        finalCrewLost: number; hullAfter: number; destroyed: boolean;
      }> = [];

      if (targetHullAfter === 0 && target.damageState === "normal" && !target.isDestroyed) {
        const overkill = Math.max(0, finalDamage - targetHullBefore);
        const dtRoll = rollD6();
        const dtTotal = dtRoll + overkill;
        let outcome: "adrift" | "destroyed" | "exploding-end-of-next" | "explodes-now";
        if (dtTotal <= 6) outcome = "adrift";
        else if (dtTotal <= 11) outcome = "destroyed";
        else if (dtTotal <= 17) outcome = "exploding-end-of-next";
        else outcome = "explodes-now";
        damageTable = { overkill, roll: dtRoll, total: dtTotal, outcome };

        if (outcome === "adrift") {
          nextDamageState = "adrift";
        } else if (outcome === "destroyed") {
          nextDamageState = "destroyed";
          targetDestroyed = true;
        } else if (outcome === "exploding-end-of-next") {
          // Delayed kill — handled at end-phase rollover; for now mark and
          // leave the row in place so it can still be shot.
          nextDamageState = "exploding-end-of-next";
        } else {
          // explodes-now: AOE attack within 4" hexes. min(15, floor(max/2))
          // AD per nearby unit, resolved through a lightweight attack-table
          // pass (no shields/interceptors — direct hull damage per the
          // simplified Slice C model).
          nextDamageState = "destroyed";
          targetDestroyed = true;
          const aoeAD = Math.min(15, Math.floor(target.maxHullPoints / 2));
          const nearby = await tx.select().from(gameUnitsTable).where(and(
            eq(gameUnitsTable.gameId, game.id), eq(gameUnitsTable.isDestroyed, false),
          ));
          for (const v of nearby) {
            if (v.id === target.id) continue;
            // Cube-distance on offset hex coords (q,r).
            const dq = v.hexQ - target.hexQ;
            const dr = v.hexR - target.hexR;
            const dist = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
            if (dist > 4) continue;
            let hitsTaken = 0, vDmg = 0, vCrew = 0;
            for (let a = 0; a < aoeAD; a++) {
              if (rollD6() >= 4) hitsTaken++;
            }
            for (let h = 0; h < hitsTaken; h++) {
              const r = rollD6();
              if (r >= 2 && r <= 5) { vDmg += 1; vCrew += 1; }
              else if (r === 6) { vDmg += 1; vCrew += 1; }
            }
            const vHullAfter = Math.max(0, v.hullPoints - vDmg);
            const vCrewAfter = Math.max(0, v.crewPoints - vCrew);
            const vDestroyed = vHullAfter === 0;
            // Crew-to-zero on a still-living "normal" victim sets adrift,
            // matching the main-target rule.
            const vNextState = vDestroyed
              ? "destroyed"
              : (vCrewAfter === 0 && v.damageState === "normal" ? "adrift" : v.damageState);
            await tx.update(gameUnitsTable).set({
              hullPoints: vHullAfter,
              crewPoints: vCrewAfter,
              isDestroyed: vDestroyed,
              damageState: vNextState,
            }).where(eq(gameUnitsTable.id, v.id));
            explosionVictims.push({
              unitId: v.id, hitsTaken, finalDamage: vDmg,
              finalCrewLost: vCrew, hullAfter: vHullAfter, destroyed: vDestroyed,
            });
          }
        }
      }

      // Out-of-crew → adrift (only if still alive and not already adrift/worse).
      if (targetCrewAfter === 0 && nextDamageState === "normal" && !targetDestroyed) {
        nextDamageState = "adrift";
      }

      await tx.update(gameUnitsTable).set({
        hullPoints: targetHullAfter,
        crewPoints: targetCrewAfter,
        shieldsCurrent,
        damageState: nextDamageState,
        isDestroyed: targetDestroyed,
      }).where(eq(gameUnitsTable.id, target.id));

      // Record that this weapon has fired this activation.
      await tx.update(gameUnitsTable)
        .set({ firedWeaponIds: [...alreadyFired, weaponId] })
        .where(eq(gameUnitsTable.id, attacker.id));

      // ── Win condition (Slice C) ──────────────────────────────────────────
      // After any damage application, if all of one player's units are
      // destroyed, end the game and award to the other player.
      let winnerId: string | null = null;
      const allUnits = await tx.select().from(gameUnitsTable)
        .where(eq(gameUnitsTable.gameId, game.id));
      const aliveByOwner = new Map<string, number>();
      for (const u of allUnits) {
        if (!u.isDestroyed) {
          aliveByOwner.set(u.ownerId, (aliveByOwner.get(u.ownerId) ?? 0) + 1);
        }
      }
      const challengerAlive = aliveByOwner.get(game.challengerId) ?? 0;
      const opponentAlive = game.opponentId ? (aliveByOwner.get(game.opponentId) ?? 0) : 0;
      let gameCompleted = false;
      if (game.opponentId && challengerAlive === 0 && opponentAlive > 0) {
        winnerId = game.opponentId; gameCompleted = true;
      } else if (game.opponentId && opponentAlive === 0 && challengerAlive > 0) {
        winnerId = game.challengerId; gameCompleted = true;
      } else if (game.opponentId && challengerAlive === 0 && opponentAlive === 0) {
        // Double-KO (mutual annihilation via simultaneous catastrophic
        // explosion/AOE). End the game as a draw — winnerId stays null.
        gameCompleted = true;
      }
      if (gameCompleted) {
        await tx.update(gamesTable)
          .set({ status: "completed", winnerId })
          .where(eq(gamesTable.id, game.id));
      }

      // damageRolls retained for back-compat with existing combat log UI:
      // map (bulkhead=1, solid=3, crit=6) so the legacy "1=miss, 2-5=hit,
      // 6=crit" rendering keeps showing meaningful pips. Slice A's richer
      // surface is in attackTableRolls + the new aggregate counts.
      const damageRolls = attackTableRolls.map(r => r);

      return {
        weaponId,
        targetUnitId,
        hitThreshold,
        attackRolls,
        hits,
        // Defender pipeline
        dodgeRolls,
        dodgesSuccessful,
        interceptedHits,
        shieldedHits,
        targetShieldsBefore: shieldsBefore,
        targetShieldsAfter: shieldsCurrent,
        // Attack Table
        attackTableRolls,
        bulkheadHits,
        solidHits,
        criticalHits,
        // Post-table modifiers
        gegReduction,
        adaptiveHalved,
        blastDoorsDamageSaved,
        blastDoorsCrewSaved,
        blastDoorsDamageRolls,
        blastDoorsCrewRolls,
        // Aggregates
        damageRolls,
        totalDamage: finalDamage,
        crewLost: finalCrewLost,
        criticalRolls,
        criticalsApplied,
        // Reroll metadata (cosmetic combat-log fields).
        beamExplosions,
        twinRerolls,
        concentrateRerolls,
        targetHullBefore,
        targetHullAfter,
        targetCrewBefore,
        targetCrewAfter,
        targetDestroyed,
        damageTable,
        winnerId,
        explosionVictims,
      };
    });
    res.json(result);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

// ── Special Actions ──────────────────────────────────────────────────────────
// Declared once per ship per round during the movement phase. CQ-checked
// actions roll 1d6 + crewQuality vs the action's threshold; a miss still
// records the attempt (suffixed "-failed") so always-on restrictions still
// apply (e.g. Run Silent's no-fire/no-turn). Cleared at round rollover.
router.post("/games/:gameId/units/:unitId/special-action", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = ChooseSpecialActionParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = ChooseSpecialActionBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const { gameId, unitId } = params.data;
  const { action, targetUnitId } = body.data;

  // CQ thresholds. null = automatic (always succeeds).
  const cqRequiredByAction: Record<string, number | null> = {
    "all-power-engines": null,
    "all-stop": null,
    "all-stop-pivot": null,
    "blast-doors": null,
    "come-about": 9,
    "intensify-defense": 8,
    "run-silent": 8,
    "concentrate-fire": 8,
  };

  try {
    const out = await db.transaction(async (tx) => {
      const lockedRows = await tx.execute(sql`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`);
      if (lockedRows.rows.length === 0) throw Object.assign(new Error("Game not found"), { status: 404 });

      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (game.status !== "active") throw Object.assign(new Error("Game is not active"), { status: 400 });
      if (game.phase !== "movement") throw Object.assign(new Error("Special Actions are declared in the movement phase"), { status: 400 });
      if (game.activePlayerId !== userId) throw Object.assign(new Error("Not your activation"), { status: 409 });
      if (game.activeUnitId !== unitId) throw Object.assign(new Error("This unit is not the one you activated"), { status: 409 });

      const [unit] = await tx.select().from(gameUnitsTable).where(and(
        eq(gameUnitsTable.id, unitId), eq(gameUnitsTable.gameId, gameId),
      ));
      if (!unit) throw Object.assign(new Error("Unit not found"), { status: 404 });
      if (unit.ownerId !== userId) throw Object.assign(new Error("Not your ship"), { status: 403 });
      if (unit.isDestroyed) throw Object.assign(new Error("Ship destroyed"), { status: 400 });
      if (unit.specialAction) throw Object.assign(new Error("Already used a Special Action this round"), { status: 400 });
      if (unit.hasMovedThisRound) throw Object.assign(new Error("Cannot declare a Special Action after the activation has ended"), { status: 400 });
      // Slice C: Skeleton Crew (crewPoints ≤ ½ max) and Adrift ships
      // cannot declare Special Actions.
      if (unit.maxCrewPoints > 0 && unit.crewPoints * 2 <= unit.maxCrewPoints) {
        throw Object.assign(new Error("Skeleton crew cannot declare Special Actions"), { status: 400 });
      }
      if (unit.damageState === "adrift") {
        throw Object.assign(new Error("Adrift ship cannot declare Special Actions"), { status: 400 });
      }

      // Critical-effect gate: Reactor 5/6, Bridge, Decompression all set
      // noSA. Block the action entirely (no -failed bookkeeping — the rule
      // is "cannot declare", not "declare and roll").
      const saCritRows = await tx.select().from(unitCriticalEffectsTable)
        .where(eq(unitCriticalEffectsTable.gameUnitId, unit.id));
      const saCrits = deriveCritEffects(saCritRows.map(r => ({
        effectKey: r.effectKey,
        randomArc: r.randomArc,
        randomWeaponId: r.randomWeaponId,
        lostTraits: r.lostTraits ?? [],
      })));
      if (saCrits.noSA) {
        throw Object.assign(new Error("Cannot declare Special Actions — Bridge / Reactor crit active"), { status: 400 });
      }

      // Per-action prereqs.
      let storedTarget: number | null = null;
      if (action === "concentrate-fire") {
        if (targetUnitId == null) throw Object.assign(new Error("Concentrate All Fire-power requires a target"), { status: 400 });
        const [tgt] = await tx.select().from(gameUnitsTable).where(and(
          eq(gameUnitsTable.id, targetUnitId), eq(gameUnitsTable.gameId, gameId),
        ));
        if (!tgt) throw Object.assign(new Error("Target not found"), { status: 404 });
        if (tgt.ownerId === userId) throw Object.assign(new Error("Cannot target your own ship"), { status: 400 });
        if (tgt.isDestroyed) throw Object.assign(new Error("Target already destroyed"), { status: 400 });
        storedTarget = targetUnitId;
      }
      if (action === "blast-doors") {
        // Rule: "Ships with only 1 weapon system cannot fire" under blast
        // doors — there's no point declaring it on a single-system hull, so
        // we reject it up front rather than silently neutering the ship.
        const [ship] = await tx.select().from(shipsTable).where(eq(shipsTable.id, unit.shipId));
        if (ship) {
          const ws = await tx.select().from(weaponsTable).where(eq(weaponsTable.shipModelId, ship.shipModelId));
          if (ws.length < 2) throw Object.assign(new Error("Close Blast Doors requires a ship with more than 1 weapon system"), { status: 400 });
        }
      }

      // CQ check.
      const cqRequired = cqRequiredByAction[action] ?? null;
      let cqRoll: number | null = null;
      let cqTotal: number | null = null;
      let success = true;
      if (cqRequired !== null) {
        cqRoll = rollD6();
        cqTotal = cqRoll + unit.crewQuality;
        success = cqTotal >= cqRequired;
      }

      // Persist. Failed attempts still record (suffix -failed) so the
      // always-on penalty side of Run Silent / etc. is enforced.
      const stored = success ? action : `${action}-failed`;
      const [updated] = await tx.update(gameUnitsTable).set({
        specialAction: stored,
        specialActionTargetId: success ? storedTarget : null,
      }).where(eq(gameUnitsTable.id, unit.id)).returning();

      return {
        action,
        success,
        requiresCq: cqRequired !== null,
        cqRequired,
        cqRoll,
        cqTotal,
        unit: updated,
      };
    });
    res.json(out);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

// ── Damage Control ──────────────────────────────────────────────────────────
// Attempt to repair one critical-effect row. Once per ship per round; cannot
// target Vital Systems (location 6); cannot repair the round the crit was
// applied; cannot repair while an Engineering crit is active (permanently
// disables DC for the ship). Success removes the row and refunds the
// structural damage it dealt; failure still consumes the per-round attempt.
router.post("/games/:gameId/units/:unitId/damage-control", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = DamageControlParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = DamageControlBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const { gameId, unitId } = params.data;
  const { effectId } = body.data;

  try {
    const out = await db.transaction(async (tx) => {
      const lockedRows = await tx.execute(sql`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`);
      if (lockedRows.rows.length === 0) throw Object.assign(new Error("Game not found"), { status: 404 });
      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (game.status !== "active") throw Object.assign(new Error("Game is not active"), { status: 400 });

      const [unit] = await tx.select().from(gameUnitsTable).where(and(
        eq(gameUnitsTable.id, unitId), eq(gameUnitsTable.gameId, gameId),
      ));
      if (!unit) throw Object.assign(new Error("Unit not found"), { status: 404 });
      if (unit.ownerId !== userId) throw Object.assign(new Error("Not your ship"), { status: 403 });
      if (unit.isDestroyed) throw Object.assign(new Error("Ship destroyed"), { status: 400 });
      if (unit.lastDcRound === game.currentRound) {
        throw Object.assign(new Error("Damage control already attempted this round"), { status: 400 });
      }
      // End-phase modelling is pending (Slice C). For now, gate DC to the
      // firing phase — the only phase where damage exists and the closest
      // available approximation of "end of round". Movement-phase DC would
      // let the active player repair before the opponent has fired.
      if (game.phase !== "firing") {
        throw Object.assign(new Error("Damage control may only be attempted in the firing/end phase"), { status: 400 });
      }

      const [effect] = await tx.select().from(unitCriticalEffectsTable)
        .where(and(eq(unitCriticalEffectsTable.id, effectId), eq(unitCriticalEffectsTable.gameUnitId, unitId)));
      if (!effect) throw Object.assign(new Error("Critical effect not found"), { status: 404 });
      if (!effect.repairable) throw Object.assign(new Error("Vital Systems cannot be repaired"), { status: 400 });
      if (effect.appliedRound === game.currentRound) {
        throw Object.assign(new Error("Cannot repair a critical the round it was applied"), { status: 400 });
      }

      // Derive cumulative DC penalty + lockout gates (Engineering = ever,
      // Hull Breach = this round).
      const allRows = await tx.select().from(unitCriticalEffectsTable)
        .where(eq(unitCriticalEffectsTable.gameUnitId, unitId));
      const crits = deriveCritEffects(allRows.map(r => ({
        effectKey: r.effectKey,
        randomArc: r.randomArc,
        randomWeaponId: r.randomWeaponId,
        lostTraits: r.lostTraits ?? [],
        appliedRound: r.appliedRound,
      })), game.currentRound);
      if (crits.noDamageControlEver) {
        throw Object.assign(new Error("Engineering crit prevents damage control"), { status: 400 });
      }
      if (crits.noDamageControlThisRound) {
        throw Object.assign(new Error("Hull Breach prevents damage control this round"), { status: 400 });
      }

      const dcRoll = rollD6();
      // Slice C: Skeleton Crew levies an additional -2 to damage control.
      const skeletonPenalty = (unit.maxCrewPoints > 0 && unit.crewPoints * 2 <= unit.maxCrewPoints) ? 2 : 0;
      const dcPenalty = crits.damageControlPenalty + skeletonPenalty;
      const dcTotal = dcRoll + unit.crewQuality - dcPenalty;
      const dcThreshold = 9;
      const success = dcTotal >= dcThreshold;

      // Record the attempt regardless of outcome.
      await tx.update(gameUnitsTable)
        .set({ lastDcRound: game.currentRound })
        .where(eq(gameUnitsTable.id, unit.id));

      if (success) {
        await tx.delete(unitCriticalEffectsTable).where(eq(unitCriticalEffectsTable.id, effect.id));
        // Refund the structural damage (cap at maxHullPoints).
        const restored = Math.min(unit.maxHullPoints, unit.hullPoints + (effect.damageApplied ?? 0));
        await tx.update(gameUnitsTable)
          .set({ hullPoints: restored, isDestroyed: false })
          .where(eq(gameUnitsTable.id, unit.id));
      }
      const [updated] = await tx.select().from(gameUnitsTable).where(eq(gameUnitsTable.id, unit.id));
      // Attach live criticals so the response satisfies the GameUnit
      // contract and the client can refresh the panel without a roundtrip.
      const liveCrits = await tx.select().from(unitCriticalEffectsTable)
        .where(eq(unitCriticalEffectsTable.gameUnitId, unit.id));
      return {
        success, dcRoll, dcTotal, dcThreshold, dcPenalty, effectId,
        unit: { ...updated, criticals: liveCrits },
      };
    });
    res.json(out);
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
        shieldsCurrent: model.shieldMax ?? 0,
        crewPoints: model.crew ?? 0,
        maxCrewPoints: model.crew ?? 0,
        damageState: "normal",
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
