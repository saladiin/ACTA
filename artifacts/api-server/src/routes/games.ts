import { Router, type IRouter } from "express";
import { eq, and, or, isNull, sql, inArray, desc } from "drizzle-orm";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, gamesTable, gameUnitsTable, turnsTable, fleetsTable, shipsTable, shipModelsTable, playersTable, weaponsTable, unitCriticalEffectsTable, gameAttackAuditLogsTable, gameMovementAuditLogsTable, gameSpecialActionAuditLogsTable, bugReportsTable, gameChatMessagesTable, type CarriedFighterInventoryItem } from "@workspace/db";
import { requireAuth, getUserId } from "../lib/auth";
import {
  parseShipTraits,
  parseWeaponTraits,
  stealthFloor,
  effectiveAttackDice,
  attackRollModifier,
  damageMultiplier,
} from "../lib/traits";
import {
  CRITICAL_TABLE,
  effectiveDamageState,
  locationFromRoll,
  findEntry,
  rollDice,
  deriveCritEffects,
  isDice,
  CANONICAL_ARCS,
} from "../lib/critical-table";
import {
  ALLOCATION_TICKS_PER_FAP,
  allocationTicksForShip,
  calculateAllocation,
  formatAllocationTicks,
  normalizePriorityLevel,
  priorityLabel,
} from "../lib/fleet-allocation";
import {
  AI_OPPONENT_ID,
  AI_OPPONENT_NAME,
  DEFAULT_AI_PROFILE,
  ShipAiProfile,
  fallbackShipAiProfileByName,
  normalizeOpponentKind,
  normalizeShipAiProfile,
} from "../lib/ai-opponent";
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
  ActivateUnitParams,
  EndActivationParams,
  FireWeaponParams,
  FireWeaponBody,
  ChooseSpecialActionParams,
  ChooseSpecialActionBody,
  ChooseScoutActionParams,
  ChooseScoutActionBody,
  DamageControlParams,
  DamageControlBody,
  ListGamesResponse,
  GetGameResponse,
  AcceptGameResponse,
  DeclineGameResponse,
  DeployFleetResponse,
  ListTurnsResponse,
} from "@workspace/api-zod";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth-limit]";
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 60).map(item => sanitizeDiagnosticValue(item, depth + 1));
  }
  if (!isPlainRecord(value)) return String(value);
  const entries = Object.entries(value).slice(0, 80);
  return Object.fromEntries(entries.map(([key, item]) => [key.slice(0, 80), sanitizeDiagnosticValue(item, depth + 1)]));
}

function parseReportBugBody(raw: unknown): { success: true; data: { message: string; rescueRequested: boolean; clientSnapshot: Record<string, unknown> | null } } | { success: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { success: false, error: "Bug report body must be an object" };
  }
  const body = raw as Record<string, unknown>;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length < 4) return { success: false, error: "Bug report must be at least 4 characters" };
  if (message.length > 800) return { success: false, error: "Bug report must be 800 characters or less" };
  if (body.rescueRequested !== undefined && typeof body.rescueRequested !== "boolean") {
    return { success: false, error: "rescueRequested must be a boolean" };
  }
  if (body.clientSnapshot !== undefined && !isPlainRecord(body.clientSnapshot)) {
    return { success: false, error: "clientSnapshot must be an object" };
  }
  return {
    success: true,
    data: {
      message,
      rescueRequested: body.rescueRequested === true,
      clientSnapshot: body.clientSnapshot ? sanitizeDiagnosticValue(body.clientSnapshot) as Record<string, unknown> : null,
    },
  };
}

function parseGameChatBody(raw: unknown): { success: true; data: { message: string } } | { success: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { success: false, error: "Chat message body must be an object" };
  }
  const body = raw as Record<string, unknown>;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length < 1) return { success: false, error: "Message cannot be empty" };
  if (message.length > 500) return { success: false, error: "Message must be 500 characters or less" };
  return { success: true, data: { message } };
}

// ── Combat helpers ───────────────────────────────────────────────────────────
// World units = inches (see game-board.tsx: "1 world unit = 1 inch").
// Storage convention: `hexQ` / `hexR` columns hold WORLD INCHES, not axial
// hex coordinates. The column names are historical — they predate the move
// to free-form world-inch placement. This identity mapping keeps the server
// and the frontend renderer in sync.
function hexToWorld(q: number, r: number): { x: number; z: number } {
  return { x: q, z: r };
}
function rollD6(): number { return 1 + Math.floor(Math.random() * 6); }

function unitAuditState(unit: typeof gameUnitsTable.$inferSelect): Record<string, unknown> {
  return {
    id: unit.id,
    name: unit.name,
    ownerId: unit.ownerId,
    hullPoints: unit.hullPoints,
    maxHullPoints: unit.maxHullPoints,
    crewPoints: unit.crewPoints,
    maxCrewPoints: unit.maxCrewPoints,
    shieldsCurrent: unit.shieldsCurrent,
    interceptorDiceRemaining: unit.interceptorDiceRemaining,
    interceptorThresholdCurrent: unit.interceptorThresholdCurrent,
    damageState: unit.damageState,
    isDestroyed: unit.isDestroyed,
    hexQ: unit.hexQ,
    hexR: unit.hexR,
    heading: unit.heading,
    speed: unit.speed,
    turns: unit.turns,
    turnAngle: unit.turnAngle,
    specialAction: unit.specialAction,
    hasMovedThisRound: unit.hasMovedThisRound,
    hasFiredThisRound: unit.hasFiredThisRound,
    firedWeaponIds: unit.firedWeaponIds,
    slowLoadingWeaponCooldowns: unit.slowLoadingWeaponCooldowns,
    baseRadiusInches: unit.baseRadiusInches,
    modelFilename: unit.modelFilename,
  };
}

async function recordAttackAuditLog(
  tx: any,
  args: {
    game: typeof gamesTable.$inferSelect;
    actorKind: "player" | "ai";
    actorPlayerId: string | null;
    attacker: typeof gameUnitsTable.$inferSelect;
    targetBefore: typeof gameUnitsTable.$inferSelect;
    targetAfter: typeof gameUnitsTable.$inferSelect;
    weapon: typeof weaponsTable.$inferSelect;
    summary: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(gameAttackAuditLogsTable).values({
    gameId: args.game.id,
    round: args.game.currentRound,
    phase: args.game.phase,
    actorKind: args.actorKind,
    actorPlayerId: args.actorPlayerId,
    attackerUnitId: args.attacker.id,
    targetUnitId: args.targetBefore.id,
    weaponId: args.weapon.id,
    summary: args.summary,
    payload: {
      attacker: unitAuditState(args.attacker),
      targetBefore: unitAuditState(args.targetBefore),
      targetAfter: unitAuditState(args.targetAfter),
      weapon: {
        id: args.weapon.id,
        name: args.weapon.name,
        arc: args.weapon.arc,
        range: args.weapon.range,
        attackDice: args.weapon.attackDice,
        traits: args.weapon.traits,
      },
      ...args.payload,
    },
  });
}

async function recordMovementAuditLog(
  tx: any,
  args: {
    game: typeof gamesTable.$inferSelect;
    actorKind: "player" | "ai" | "system";
    actorPlayerId: string | null;
    unitBefore: typeof gameUnitsTable.$inferSelect;
    unitAfter: typeof gameUnitsTable.$inferSelect;
    movementKind: "move" | "turn" | "move-and-turn" | "all-stop" | "adrift-drift" | "fighter-launch" | "fighter-recovery" | "forced-hold";
    summary: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(gameMovementAuditLogsTable).values({
    gameId: args.game.id,
    round: args.game.currentRound,
    phase: args.game.phase,
    actorKind: args.actorKind,
    actorPlayerId: args.actorPlayerId,
    unitId: args.unitBefore.id,
    movementKind: args.movementKind,
    summary: args.summary,
    payload: {
      unitBefore: unitAuditState(args.unitBefore),
      unitAfter: unitAuditState(args.unitAfter),
      delta: {
        x: Number((args.unitAfter.hexQ - args.unitBefore.hexQ).toFixed(3)),
        z: Number((args.unitAfter.hexR - args.unitBefore.hexR).toFixed(3)),
        heading: headingDeltaDegrees(args.unitBefore.heading, args.unitAfter.heading),
      },
      ...args.payload,
    },
  });
}

async function recordSpecialActionAuditLog(
  tx: any,
  args: {
    game: typeof gamesTable.$inferSelect;
    actorKind: "player" | "ai";
    actorPlayerId: string | null;
    unitBefore: typeof gameUnitsTable.$inferSelect;
    unitAfter: typeof gameUnitsTable.$inferSelect;
    action: string;
    storedAction: string;
    success: boolean;
    cqRequired: number | null;
    cqRoll: number | null;
    cqTotal: number | null;
    targetUnitId: number | null;
    targetUnit?: typeof gameUnitsTable.$inferSelect | null;
    summary: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(gameSpecialActionAuditLogsTable).values({
    gameId: args.game.id,
    round: args.game.currentRound,
    phase: args.game.phase,
    actorKind: args.actorKind,
    actorPlayerId: args.actorPlayerId,
    unitId: args.unitBefore.id,
    action: args.action,
    success: args.success,
    cqRequired: args.cqRequired,
    cqRoll: args.cqRoll,
    cqTotal: args.cqTotal,
    targetUnitId: args.targetUnitId,
    summary: args.summary,
    payload: {
      unitBefore: unitAuditState(args.unitBefore),
      unitAfter: unitAuditState(args.unitAfter),
      target: args.targetUnit ? unitAuditState(args.targetUnit) : null,
      storedAction: args.storedAction,
      ...args.payload,
    },
  });
}

async function recordAntiFighterAuditLog(
  tx: any,
  args: {
    game: typeof gamesTable.$inferSelect;
    actorKind: "player" | "ai" | "system";
    actorPlayerId: string | null;
    context: string;
    attacks: AntiFighterAttackLog[];
    destroyedUnitIds: number[];
    fighterRecoveries?: DestroyedFighterRecoveryResult[];
    playerId?: string | null;
    summary?: string;
  },
): Promise<void> {
  if (args.attacks.length === 0) return;
  const firstAttack = args.attacks[0];
  const firstRoll = firstAttack?.rolls[0];
  const rollCount = args.attacks.reduce(
    (sum, attack) => sum + attack.rolls.length,
    0,
  );
  const attackerNames = args.attacks
    .map((attack) => attack.attackerName)
    .slice(0, 2)
    .join(", ");
  const extraAttackers =
    args.attacks.length > 2 ? ` +${args.attacks.length - 2} more` : "";
  const summary =
    args.summary ??
    `${attackerNames}${extraAttackers} resolved Anti-Fighter: ${rollCount} dice, ${args.destroyedUnitIds.length} fighter flight(s) destroyed.`;

  await tx.insert(gameSpecialActionAuditLogsTable).values({
    gameId: args.game.id,
    round: args.game.currentRound,
    phase: args.game.phase,
    actorKind: args.actorKind,
    actorPlayerId: args.actorPlayerId,
    unitId: firstAttack.attackerId,
    action: "anti-fighter",
    success: true,
    cqRequired: null,
    cqRoll: null,
    cqTotal: null,
    targetUnitId: firstRoll?.targetId ?? null,
    summary,
    payload: {
      storedAction: "anti-fighter",
      context: args.context,
      playerId: args.playerId ?? args.actorPlayerId,
      rollCount,
      destroyedUnitIds: args.destroyedUnitIds,
      fighterRecoveries: args.fighterRecoveries ?? [],
      attacks: args.attacks,
    },
  });
}

type SlowLoadingCooldowns = Record<string, number>;

type ParsedShipTraits = ReturnType<typeof parseShipTraits>;

function targetIsShadowOrVorlon(model: { faction?: string | null }): boolean {
  return /\b(?:shadow|vorlon)\b/i.test(model.faction ?? "");
}

function stealthPenetrationIgnoresTarget(
  attackerTraits: ParsedShipTraits,
  targetTraits: ParsedShipTraits,
  targetModel: { faction?: string | null },
): boolean {
  return attackerTraits.stealthPenetration
    && !targetTraits.ancient
    && !targetIsShadowOrVorlon(targetModel);
}

function criticalAffectsCrew(entry: NonNullable<ReturnType<typeof findEntry>>): boolean {
  const crewValue = entry.crew;
  const hasCrewValue = isDice(crewValue) || (typeof crewValue === "number" && crewValue > 0);
  const troopsLost = typeof entry.flags.troopsLost === "number" && entry.flags.troopsLost > 0;
  return entry.location === 5
    || hasCrewValue
    || troopsLost
    || /\bcrew\b/i.test(entry.effectKey)
    || /\btroops?\b/i.test(entry.effectKey);
}

function normalizeSlowLoadingCooldowns(raw: unknown, currentRound: number): SlowLoadingCooldowns {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: SlowLoadingCooldowns = {};
  for (const [weaponId, readyRound] of Object.entries(raw)) {
    const round = Number(readyRound);
    if (Number.isFinite(round) && round > currentRound) {
      out[weaponId] = Math.trunc(round);
    }
  }
  return out;
}

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

function printedDamageThreshold(unit: { damageThreshold?: number | null; maxHullPoints: number }): number {
  return unit.damageThreshold && unit.damageThreshold > 0
    ? unit.damageThreshold
    : Math.ceil(unit.maxHullPoints / 2);
}

function printedCrewThreshold(unit: { crewThreshold?: number | null; maxCrewPoints: number }): number {
  if (unit.maxCrewPoints <= 0) return 0;
  return unit.crewThreshold && unit.crewThreshold > 0
    ? unit.crewThreshold
    : Math.ceil(unit.maxCrewPoints / 2);
}

function isCrippledUnit(unit: {
  hullPoints: number;
  maxHullPoints: number;
  damageThreshold?: number | null;
  isDestroyed?: boolean;
}): boolean {
  return !unit.isDestroyed && unit.maxHullPoints > 0 && unit.hullPoints <= printedDamageThreshold(unit);
}

function isSkeletonCrewUnit(unit: {
  crewPoints: number;
  maxCrewPoints: number;
  crewThreshold?: number | null;
  isDestroyed?: boolean;
}): boolean {
  const threshold = printedCrewThreshold(unit);
  return !unit.isDestroyed && threshold > 0 && unit.crewPoints <= threshold;
}

function unitCountsForVictory(unit: {
  hullPoints: number;
  crewPoints: number;
  maxCrewPoints: number;
  isDestroyed?: boolean;
}): boolean {
  return !unit.isDestroyed
    && unit.hullPoints > 0
    && (unit.maxCrewPoints <= 0 || unit.crewPoints > 0);
}

function comparableTraitName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s*[+-]?\d+.*$/, "")
    .trim()
    .replace(/[\s_]+/g, "-");
}

function filterLostTraits(raw: string | null | undefined, lostTraitNames: Iterable<string>): string {
  const lost = new Set(Array.from(lostTraitNames).map(comparableTraitName));
  if (!raw) return "";
  return raw.split(/[;,]/).map(t => t.trim()).filter(Boolean)
    .filter(t => !lost.has(comparableTraitName(t)))
    .join("; ");
}

function unitHasFiredAWeapon(unit: {
  hasFiredThisRound?: boolean | null;
  firedWeaponIds?: unknown;
}): boolean {
  return unit.hasFiredThisRound === true
    || (Array.isArray(unit.firedWeaponIds) && unit.firedWeaponIds.length > 0);
}

function skeletonPenaltiesApply(unit: {
  crewPoints: number;
  maxCrewPoints: number;
  crewThreshold?: number | null;
  isDestroyed?: boolean;
}, traits: { flightComputer: boolean }): boolean {
  return isSkeletonCrewUnit(unit) && !traits.flightComputer;
}

function effectiveBaseSpeed(unit: {
  speed: number;
  hullPoints: number;
  maxHullPoints: number;
  damageThreshold?: number | null;
  isDestroyed?: boolean;
}, crits: { speedReduce: number }, options: { ignoreCrippled?: boolean } = {}): number {
  const crippledSpeed = !options.ignoreCrippled && isCrippledUnit(unit) ? Math.floor(unit.speed / 2) : unit.speed;
  return Math.max(0, crippledSpeed - crits.speedReduce);
}

function movementSpeedCap(unit: {
  speed: number;
  hullPoints: number;
  maxHullPoints: number;
  damageThreshold?: number | null;
  isDestroyed?: boolean;
  specialAction: string | null;
}, crits: { speedReduce: number }, options: { ignoreCrippled?: boolean } = {}): number {
  const baseAction = (unit.specialAction ?? "").replace(/-failed$/, "");
  const baseSpeed = effectiveBaseSpeed(unit, crits, options);
  if (baseAction === "all-stop-pivot") return 0;
  if (baseAction === "all-stop" || baseAction === "run-silent") return Math.floor(baseSpeed / 2);
  if (baseAction === "all-power-engines") return Math.floor(baseSpeed * 1.5);
  return baseSpeed;
}

function effectiveTurnProfile(unit: {
  turns: number;
  turnAngle: number;
  hullPoints: number;
  maxHullPoints: number;
  damageThreshold?: number | null;
  isDestroyed?: boolean;
  specialAction: string | null;
}, traits?: { superManeuverable?: boolean }, options: { ignoreCrippled?: boolean } = {}): { maxTurns: number; turnAngle: number; turnsForbidden: boolean } {
  const baseAction = (unit.specialAction ?? "").replace(/-failed$/, "");
  const crippled = !options.ignoreCrippled && isCrippledUnit(unit);
  const baseTurns = traits?.superManeuverable && !crippled
    ? 999
    : traits?.superManeuverable && crippled
      ? 2
      : crippled ? Math.max(1, unit.turns - 1) : unit.turns;
  const isComeAboutExtra = unit.specialAction === "come-about-extra-turn";
  const isComeAboutSharp = unit.specialAction === "come-about-sharp-turn";
  const baseTurnAngle = traits?.superManeuverable && !crippled
    ? 360
    : traits?.superManeuverable && crippled
      ? 45
      : crippled ? Math.min(45, unit.turnAngle) : unit.turnAngle;
  const sharpBonus = isComeAboutSharp ? 45 : 0;
  const pivotMultiplier = baseAction === "all-stop-pivot" ? 2 : 1;
  return {
    maxTurns: baseTurns + (isComeAboutExtra ? 1 : 0),
    turnAngle: (baseTurnAngle + sharpBonus) * pivotMultiplier,
    turnsForbidden: baseAction === "all-power-engines" || baseAction === "run-silent" || baseAction === "all-stop",
  };
}

function turnDistanceRequirement(
  unit: {
    speed: number;
    hullPoints: number;
    maxHullPoints: number;
    damageThreshold?: number | null;
    isDestroyed?: boolean;
    specialAction: string | null;
  },
  crits: { speedReduce: number },
  traits: { agile?: boolean; superManeuverable?: boolean },
  turnsMadeThisActivation: number,
): number {
  if (traits.superManeuverable) return 0;
  const baseAction = (unit.specialAction ?? "").replace(/-failed$/, "");
  if (baseAction === "all-stop-pivot") return 0;
  if (turnsMadeThisActivation === 0) {
    const speed = effectiveBaseSpeed(unit, crits);
    return traits.agile ? speed / 4 : speed / 2;
  }
  return traits.agile ? 1 : 2;
}

function headingDeltaDegrees(from: number, to: number): number {
  let d = ((to - from) % 360 + 360) % 360;
  if (d > 180) d = 360 - d;
  return Math.abs(d);
}

function signedHeadingDeltaDegrees(from: number, to: number): number {
  let d = ((to - from) % 360 + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

function normalizeHeadingDegrees(heading: number): number {
  return ((Math.round(heading) % 360) + 360) % 360;
}

function limitHeadingToward(from: number, to: number, maxDelta: number): number {
  const delta = signedHeadingDeltaDegrees(from, to);
  const limited = Math.max(-maxDelta, Math.min(maxDelta, delta));
  return normalizeHeadingDegrees(from + limited);
}

function snapHalfInch(value: number): number {
  return Math.round(value * 2) / 2;
}

function snapBoardCoord(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const BOARD_MIN_X = -24;
const BOARD_MAX_X = 24;
const BOARD_MIN_Z = -36;
const BOARD_MAX_Z = 36;
const AI_EDGE_RECOVERY_BUFFER_INCHES = 6;

function boardEdgeClearance(point: { x: number; z: number }): number {
  return Math.min(
    point.x - BOARD_MIN_X,
    BOARD_MAX_X - point.x,
    point.z - BOARD_MIN_Z,
    BOARD_MAX_Z - point.z,
  );
}

function isPointInsideBoard(point: { x: number; z: number }): boolean {
  return point.x >= BOARD_MIN_X
    && point.x <= BOARD_MAX_X
    && point.z >= BOARD_MIN_Z
    && point.z <= BOARD_MAX_Z;
}

function shouldAddEdgeRecoveryHeading(unit: { hexQ: number; hexR: number; heading: number; modelFilename: string }, speedCap: number, minMove: number): boolean {
  const current = { x: unit.hexQ, z: unit.hexR };
  if (boardEdgeClearance(current) <= AI_EDGE_RECOVERY_BUFFER_INCHES) return true;
  const forward = headingForwardVec(unit);
  const projectedDistance = Math.max(minMove, Math.min(speedCap, AI_EDGE_RECOVERY_BUFFER_INCHES));
  const projected = {
    x: current.x + forward.x * projectedDistance,
    z: current.z + forward.z * projectedDistance,
  };
  return !isPointInsideBoard(projected);
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

function headingForwardVec(unit: { heading: number; modelFilename: string }): { x: number; z: number } {
  const flip = FLIP_MODELS.has(unit.modelFilename);
  const sign = flip ? -1 : 1;
  const hRad = (unit.heading * Math.PI) / 180;
  return { x: sign * Math.sin(hRad), z: sign * Math.cos(hRad) };
}

function shipModelIsFighter(model: {
  name?: string | null;
  filename?: string | null;
  shipClass?: string | null;
  traits?: string | null;
}): boolean {
  const identity = [model.name, model.filename, model.shipClass]
    .filter(Boolean)
    .join(" ");
  return parseShipTraits(model.traits ?? "").fighter
    || /\bfighter\b/i.test(model.shipClass ?? "")
    || /fighter flight/i.test(model.name ?? "")
    || /\b(?:aurora|thunderbolt|tiger|nial|sentri|frazi|flyer)\b/i.test(identity);
}

function movementTraitsForModel(
  model: Pick<typeof shipModelsTable.$inferSelect, "name" | "filename" | "traits" | "shipClass">,
  crits: { lostTraitNames: Set<string> },
): ReturnType<typeof parseShipTraits> {
  const traits = parseShipTraits(filterLostTraits(model.traits, crits.lostTraitNames));
  return {
    ...traits,
    superManeuverable: traits.superManeuverable || shipModelIsFighter(model),
  };
}

type FighterInventoryModel = Pick<typeof shipModelsTable.$inferSelect, "id" | "name">;

const SMALL_CRAFT_CANONICAL_NAMES: Record<string, string> = {
  "aurora starfury": "Aurora Starfury Flight",
  "aurora starfury flight": "Aurora Starfury Flight",
  "thunderbolt": "Thunderbolt Starfury Flight",
  "thunderbolt starfury": "Thunderbolt Starfury Flight",
  "thunderbolt starfury flight": "Thunderbolt Starfury Flight",
  tiger: "Tiger Starfury Flight",
  "tiger starfury": "Tiger Starfury Flight",
  "tiger starfury flight": "Tiger Starfury Flight",
  nial: "Nial Heavy Fighter Flight",
  "nial fighter": "Nial Heavy Fighter Flight",
  "nial fighter flight": "Nial Heavy Fighter Flight",
  "nial heavy fighter": "Nial Heavy Fighter Flight",
  "nial heavy fighter flight": "Nial Heavy Fighter Flight",
  sentri: "Sentri Flight",
  "sentri fighter": "Sentri Flight",
  "sentri fighter flight": "Sentri Flight",
  "sentri flight": "Sentri Flight",
  frazi: "Frazi Flight",
  "frazi fighter": "Frazi Flight",
  "frazi fighter flight": "Frazi Flight",
  "frazi flight": "Frazi Flight",
  flyer: "Flyer Flight",
  "flyer flight": "Flyer Flight",
  "minbari flyer": "Flyer Flight",
  "minbari flyer flight": "Flyer Flight",
};

function normalizeSmallCraftKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function resolveFighterModel(
  name: string,
  models: FighterInventoryModel[],
): FighterInventoryModel | null {
  const byName = new Map(models.map((model) => [normalizeSmallCraftKey(model.name), model]));
  const candidates = [
    name,
    SMALL_CRAFT_CANONICAL_NAMES[normalizeSmallCraftKey(name)] ?? name,
    /\bflight\b/i.test(name) ? name : `${name} Flight`,
    name.replace(/\bfighter\b/gi, "").replace(/\s+/g, " ").trim(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const canonical = SMALL_CRAFT_CANONICAL_NAMES[normalizeSmallCraftKey(candidate)] ?? candidate;
    const model = byName.get(normalizeSmallCraftKey(canonical));
    if (model) return model;
  }
  return null;
}

function carriedFightersFromSmallCraft(
  smallCraft: string | null | undefined,
  models: FighterInventoryModel[],
): CarriedFighterInventoryItem[] {
  if (!smallCraft || /^(?:none|n\/a|-|\u2014)$/i.test(smallCraft.trim())) return [];
  return smallCraft
    .split(/[,;]+/)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const entry = raw.match(/^(.*?)\s*(?:\((\d+)\)|x\s*(\d+)|(\d+)\s*x)?$/i);
      const rawName = (entry?.[1] ?? raw).trim();
      const total = Math.max(1, Number(entry?.[2] ?? entry?.[3] ?? entry?.[4] ?? 1));
      const canonicalName = SMALL_CRAFT_CANONICAL_NAMES[normalizeSmallCraftKey(rawName)] ?? rawName;
      const model = resolveFighterModel(canonicalName, models);
      const name = model?.name ?? canonicalName;
      return {
        name,
        shipModelId: model?.id ?? null,
        total,
        available: total,
        launched: 0,
        recovered: 0,
        destroyed: 0,
      };
    });
}

function fighterBayOperationsUsedThisRound(
  unit: Pick<typeof gameUnitsTable.$inferSelect, "fighterBayOperationsRound" | "fighterBayOperationsUsed">,
  round: number,
): number {
  return unit.fighterBayOperationsRound === round ? unit.fighterBayOperationsUsed : 0;
}

function fighterBayOperationLimit(
  unit: Pick<typeof gameUnitsTable.$inferSelect, "carriedFighters" | "specialAction">,
  model: Pick<typeof shipModelsTable.$inferSelect, "traits">,
  mode: "launch" | "recover" = "launch",
): number {
  if (!Array.isArray(unit.carriedFighters) || unit.carriedFighters.length === 0) return 0;
  const traits = parseShipTraits(model.traits);
  const base = Math.max(1, traits.carrier || 0);
  return mode === "launch" && unit.specialAction === "scramble"
    ? (traits.carrier ? traits.carrier + 2 : 2)
    : base;
}

function prebattleFighterDeploymentLimit(
  inventory: CarriedFighterInventoryItem[],
  carrierModel: Pick<typeof shipModelsTable.$inferSelect, "traits">,
): number {
  const totalFlights = inventory.reduce((sum, item) => sum + Math.max(0, item.total), 0);
  if (totalFlights <= 0) return 0;
  const traits = parseShipTraits(carrierModel.traits);
  return traits.fleetCarrier ? Math.max(1, Math.floor(totalFlights / 2)) : 1;
}

function normalizeHeadingInput(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return normalizeHeadingDegrees(fallback);
  return normalizeHeadingDegrees(n);
}

function assertEndPhaseFighterBayWindow(
  game: typeof gamesTable.$inferSelect,
  userId: string,
): void {
  if (game.status !== "active") throw Object.assign(new Error("Game is not active"), { status: 400 });
  if (game.phase !== "end") throw Object.assign(new Error("Fighters launch and recover in the End Phase"), { status: 400 });
  if (game.activePlayerId !== userId) throw Object.assign(new Error("Not your End Phase fighter window"), { status: 400 });
  const alreadyPassed = userId === game.challengerId
    ? game.endPhaseChallengerPassed
    : userId === game.opponentId
    ? game.endPhaseOpponentPassed
    : true;
  if (alreadyPassed) throw Object.assign(new Error("You've already passed the End Phase this round"), { status: 400 });
}

function requireNoSpecialActionForFighterBay(
  unit: Pick<typeof gameUnitsTable.$inferSelect, "specialAction">,
  mode: "launch" | "recover",
): void {
  if (unit.specialAction && !(mode === "launch" && unit.specialAction === "scramble")) {
    throw Object.assign(new Error("Ships that performed a Special Action cannot launch or recover fighters"), { status: 400 });
  }
}

function updateFighterInventoryItem(
  inventory: CarriedFighterInventoryItem[],
  index: number,
  update: (item: CarriedFighterInventoryItem) => CarriedFighterInventoryItem,
): CarriedFighterInventoryItem[] {
  return inventory.map((item, i) => i === index ? update(item) : item);
}

type DestroyedFighterRecoveryContext =
  | "weapon"
  | "anti-fighter"
  | "dogfight"
  | "explosion"
  | "end-phase";

type DestroyedFighterRecoveryResult = {
  fighterUnitId: number;
  fighterName: string;
  context: DestroyedFighterRecoveryContext;
  attempted: boolean;
  recovered: boolean;
  roll: number | null;
  modifier: number;
  target: number;
  carrierUnitId: number | null;
  carrierName: string | null;
  fleetCarrierUnitId: number | null;
  fleetCarrierName: string | null;
  reason?: string;
};

function inventoryIndexForFighterModel(
  inventory: CarriedFighterInventoryItem[],
  fighterModel: Pick<typeof shipModelsTable.$inferSelect, "id" | "name">,
): number {
  return inventory.findIndex(item =>
    item.shipModelId === fighterModel.id
    || normalizeSmallCraftKey(item.name) === normalizeSmallCraftKey(fighterModel.name)
  );
}

async function eligibleFleetCarrierSupportNearPoint(
  tx: any,
  gameId: number,
  ownerId: string,
  point: { x: number; z: number },
  rangeInches: number,
): Promise<typeof gameUnitsTable.$inferSelect | null> {
  const rows = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, gameId),
    eq(gameUnitsTable.ownerId, ownerId),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  for (const unit of rows as Array<typeof gameUnitsTable.$inferSelect>) {
    if (isCrippledUnit(unit) || isSkeletonCrewUnit(unit)) continue;
    if (centerDistance({ x: unit.hexQ, z: unit.hexR }, point) > rangeInches + 1e-6) continue;
    const model = await getShipModelForUnit(tx, unit);
    if (!model || shipModelIsFighter(model)) continue;
    const critRows = await tx.select().from(unitCriticalEffectsTable)
      .where(eq(unitCriticalEffectsTable.gameUnitId, unit.id));
    const crits = deriveCritEffects((critRows as Array<typeof unitCriticalEffectsTable.$inferSelect>).map(r => ({
      effectKey: r.effectKey,
      randomArc: r.randomArc,
      randomWeaponId: r.randomWeaponId,
      lostTraits: r.lostTraits ?? [],
    })));
    const traits = parseShipTraits(filterLostTraits(model.traits, crits.lostTraitNames));
    if (traits.fleetCarrier) return unit;
  }
  return null;
}

async function resolveDestroyedFighterRecovery(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  fighter: typeof gameUnitsTable.$inferSelect,
  context: DestroyedFighterRecoveryContext,
): Promise<DestroyedFighterRecoveryResult | null> {
  const fighterModel = await getShipModelForUnit(tx, fighter);
  if (!fighterModel || !shipModelIsFighter(fighterModel)) return null;
  if (!fighter.launchedFromUnitId) {
    return {
      fighterUnitId: fighter.id,
      fighterName: fighter.name,
      context,
      attempted: false,
      recovered: false,
      roll: null,
      modifier: 0,
      target: 5,
      carrierUnitId: null,
      carrierName: null,
      fleetCarrierUnitId: null,
      fleetCarrierName: null,
      reason: "fighter-not-launched-from-carrier",
    };
  }

  const [originCarrier] = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.id, fighter.launchedFromUnitId),
    eq(gameUnitsTable.gameId, game.id),
  ));
  const originInventory = originCarrier && Array.isArray(originCarrier.carriedFighters)
    ? originCarrier.carriedFighters as CarriedFighterInventoryItem[]
    : [];
  const originIndex = inventoryIndexForFighterModel(originInventory, fighterModel);

  const candidateRows = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.ownerId, fighter.ownerId),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  const sortedCandidates = [...candidateRows as Array<typeof gameUnitsTable.$inferSelect>].sort((a, b) => {
    if (a.id === fighter.launchedFromUnitId) return -1;
    if (b.id === fighter.launchedFromUnitId) return 1;
    return centerDistance({ x: a.hexQ, z: a.hexR }, { x: fighter.hexQ, z: fighter.hexR })
      - centerDistance({ x: b.hexQ, z: b.hexR }, { x: fighter.hexQ, z: fighter.hexR });
  });

  let recoveryCarrier: typeof gameUnitsTable.$inferSelect | null = null;
  let recoveryInventory: CarriedFighterInventoryItem[] = [];
  let recoveryIndex = -1;
  for (const candidate of sortedCandidates) {
    if (candidate.id === fighter.id) continue;
    if (candidate.damageState === "adrift" || candidate.damageState === "exploding-end-of-next") continue;
    const candidateModel = await getShipModelForUnit(tx, candidate);
    if (!candidateModel || shipModelIsFighter(candidateModel)) continue;
    const inventory = Array.isArray(candidate.carriedFighters)
      ? candidate.carriedFighters as CarriedFighterInventoryItem[]
      : [];
    const index = inventoryIndexForFighterModel(inventory, fighterModel);
    if (index < 0) continue;
    const item = inventory[index]!;
    if (item.available >= item.total) continue;
    recoveryCarrier = candidate;
    recoveryInventory = inventory;
    recoveryIndex = index;
    break;
  }

  const fleetCarrier = await eligibleFleetCarrierSupportNearPoint(
    tx,
    game.id,
    fighter.ownerId,
    { x: fighter.hexQ, z: fighter.hexR },
    10,
  );
  const modifier = fleetCarrier ? 1 : 0;

  if (!recoveryCarrier) {
    if (originCarrier && originIndex >= 0) {
      const nextOriginInventory = updateFighterInventoryItem(originInventory, originIndex, item => ({
        ...item,
        launched: Math.max(0, item.launched - 1),
        destroyed: item.destroyed + 1,
      }));
      await tx.update(gameUnitsTable)
        .set({ carriedFighters: nextOriginInventory })
        .where(eq(gameUnitsTable.id, originCarrier.id));
    }
    return {
      fighterUnitId: fighter.id,
      fighterName: fighter.name,
      context,
      attempted: false,
      recovered: false,
      roll: null,
      modifier,
      target: 5,
      carrierUnitId: null,
      carrierName: null,
      fleetCarrierUnitId: fleetCarrier?.id ?? null,
      fleetCarrierName: fleetCarrier?.name ?? null,
      reason: "no-empty-compatible-carrier-bay",
    };
  }

  const roll = rollD6();
  const recovered = roll + modifier >= 5;
  if (recovered) {
    if (originCarrier && originIndex >= 0 && originCarrier.id !== recoveryCarrier.id) {
      const nextOriginInventory = updateFighterInventoryItem(originInventory, originIndex, item => ({
        ...item,
        launched: Math.max(0, item.launched - 1),
      }));
      await tx.update(gameUnitsTable)
        .set({ carriedFighters: nextOriginInventory })
        .where(eq(gameUnitsTable.id, originCarrier.id));
    }
    const inventoryForRecoveryCarrier = originCarrier?.id === recoveryCarrier.id && originIndex >= 0
      ? updateFighterInventoryItem(recoveryInventory, originIndex, item => ({
        ...item,
        launched: Math.max(0, item.launched - 1),
      }))
      : recoveryInventory;
    const nextRecoveryInventory = updateFighterInventoryItem(inventoryForRecoveryCarrier, recoveryIndex, item => ({
      ...item,
      available: Math.min(item.total, item.available + 1),
      recovered: item.recovered + 1,
    }));
    await tx.update(gameUnitsTable)
      .set({ carriedFighters: nextRecoveryInventory })
      .where(eq(gameUnitsTable.id, recoveryCarrier.id));
    await tx.delete(gameUnitsTable).where(eq(gameUnitsTable.id, fighter.id));
  } else if (originCarrier && originIndex >= 0) {
    const nextOriginInventory = updateFighterInventoryItem(originInventory, originIndex, item => ({
      ...item,
      launched: Math.max(0, item.launched - 1),
      destroyed: item.destroyed + 1,
    }));
    await tx.update(gameUnitsTable)
      .set({ carriedFighters: nextOriginInventory })
      .where(eq(gameUnitsTable.id, originCarrier.id));
  }

  return {
    fighterUnitId: fighter.id,
    fighterName: fighter.name,
    context,
    attempted: true,
    recovered,
    roll,
    modifier,
    target: 5,
    carrierUnitId: recoveryCarrier.id,
    carrierName: recoveryCarrier.name,
    fleetCarrierUnitId: fleetCarrier?.id ?? null,
    fleetCarrierName: fleetCarrier?.name ?? null,
  };
}

const STANDARD_BASE_RADIUS_INCHES = 0.8;
const BASE_CONTACT_EPSILON = 0.05;
const DOGFIGHT_SUPPORT_RANGE_INCHES = 0.25;

type UnitFootprint = {
  id: number;
  ownerId: string;
  x: number;
  z: number;
  baseRadiusInches: number;
  isFighter: boolean;
};

function rulesBaseRadius(_unit?: { baseRadiusInches?: number | null }): number {
  return STANDARD_BASE_RADIUS_INCHES;
}

function centerDistance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

function edgeDistance(
  a: { x: number; z: number; baseRadiusInches?: number | null },
  b: { x: number; z: number; baseRadiusInches?: number | null },
): number {
  return Math.max(0, centerDistance(a, b) - rulesBaseRadius(a) - rulesBaseRadius(b));
}

function weaponThreatValue(weapon: Pick<typeof weaponsTable.$inferSelect, "attackDice" | "traits">): number {
  const traits = parseWeaponTraits(weapon.traits);
  const { mult } = damageMultiplier(traits);
  const beamFactor = traits.beam ? 1.35 : 1;
  const slowLoadingFactor = traits.slowLoading ? 0.75 : 1;
  return effectiveAttackDice(weapon.attackDice, traits) * mult * beamFactor * slowLoadingFactor;
}

const AI_PRIORITY_THREAT_WEIGHT: Record<string, number> = {
  patrol: 4,
  skirmish: 10,
  raid: 20,
  battle: 38,
  war: 58,
  armageddon: 82,
  ancient: 100,
};

function priorityThreatWeight(priorityLevel: string | null | undefined): number {
  return AI_PRIORITY_THREAT_WEIGHT[normalizePriorityLevel(priorityLevel)] ?? AI_PRIORITY_THREAT_WEIGHT.raid;
}

function strategicWeaponThreat(weapons: Array<Pick<typeof weaponsTable.$inferSelect, "arc" | "range" | "attackDice" | "traits">>): {
  total: number;
  forward: number;
  beam: number;
  heavyForward: number;
} {
  let total = 0;
  let forward = 0;
  let beam = 0;
  let heavyForward = 0;
  for (const weapon of weapons) {
    const traits = parseWeaponTraits(weapon.traits);
    const value = weaponThreatValue(weapon);
    const forwardArc = /forward/i.test(weapon.arc) || /boresight forward/i.test(weapon.arc);
    total += value;
    if (forwardArc) forward += value;
    if (traits.beam || traits.miniBeam) beam += value;
    if (forwardArc && (traits.beam || traits.miniBeam || traits.tripleDamage || traits.quadDamage || value >= 12)) {
      heavyForward += value;
    }
  }
  return { total, forward, beam, heavyForward };
}

function strategicTargetValue(model: {
  pointCost?: number | null;
  priorityLevel?: string | null;
  damage?: number | null;
  shieldMax?: number | null;
  shieldRegenRate?: number | null;
}): number {
  return priorityThreatWeight(model.priorityLevel)
    + Math.max(0, model.pointCost ?? 0) * 0.08
    + Math.max(0, model.damage ?? 0) * 0.08
    + Math.max(0, model.shieldMax ?? 0) * 0.7
    + Math.max(0, model.shieldRegenRate ?? 0) * 1.1;
}

function apexPredatorTargetScore(args: {
  target: typeof gameUnitsTable.$inferSelect;
  targetModel: typeof shipModelsTable.$inferSelect;
  targetWeapons: Array<Pick<typeof weaponsTable.$inferSelect, "arc" | "range" | "attackDice" | "traits">>;
  currentThreatToApex?: number;
  expectedDamage?: number;
  killBonus?: number;
  crippleBonus?: number;
}): { score: number; breakdown: Record<string, number> } {
  const weaponThreat = strategicWeaponThreat(args.targetWeapons);
  const strategicValue = strategicTargetValue(args.targetModel);
  const currentThreat = args.currentThreatToApex ?? 0;
  const damageTaken = Math.max(0, args.target.maxHullPoints - args.target.hullPoints);
  const woundedOpportunity = damageTaken * 0.18;
  const killOpportunity = (args.killBonus ?? 0) * 0.45;
  const crippleOpportunity = (args.crippleBonus ?? 0) * 0.5;
  const expectedDamagePressure = Math.max(0, args.expectedDamage ?? 0) * 1.6;
  const lowStrategicValuePenalty = strategicValue < 36 && weaponThreat.total < 7 ? 30 : 0;
  const score =
    strategicValue * 1.15
    + weaponThreat.total * 4.5
    + weaponThreat.forward * 2.5
    + weaponThreat.beam * 4.8
    + weaponThreat.heavyForward * 6.5
    + currentThreat * 7
    + expectedDamagePressure
    + woundedOpportunity
    + killOpportunity
    + crippleOpportunity
    - lowStrategicValuePenalty;

  return {
    score,
    breakdown: {
      strategicValue: Number(strategicValue.toFixed(2)),
      targetWeaponThreat: Number(weaponThreat.total.toFixed(2)),
      targetForwardThreat: Number(weaponThreat.forward.toFixed(2)),
      targetBeamThreat: Number(weaponThreat.beam.toFixed(2)),
      targetHeavyForwardThreat: Number(weaponThreat.heavyForward.toFixed(2)),
      currentThreatToApex: Number(currentThreat.toFixed(2)),
      expectedDamagePressure: Number(expectedDamagePressure.toFixed(2)),
      woundedOpportunity: Number(woundedOpportunity.toFixed(2)),
      killOpportunity: Number(killOpportunity.toFixed(2)),
      crippleOpportunity: Number(crippleOpportunity.toFixed(2)),
      lowStrategicValuePenalty,
      apexPredatorBonus: Number(score.toFixed(2)),
    },
  };
}

function isSideArc(arc: string): boolean {
  return arc === "Port" || arc === "Starboard";
}

function isNovaDreadnought(model: { name?: string | null; filename?: string | null }, unit?: { name?: string | null; modelFilename?: string | null }): boolean {
  return /nova/i.test(model.name ?? "")
    || /nova/i.test(model.filename ?? "")
    || /nova/i.test(unit?.name ?? "")
    || /nova/i.test(unit?.modelFilename ?? "");
}

function lowHullRatio(unit: { hullPoints: number; maxHullPoints: number }): number {
  return unit.maxHullPoints > 0 ? unit.hullPoints / unit.maxHullPoints : 1;
}

function shipAiProfileForModel(model: { name?: string | null; aiProfile?: string | null } | null | undefined): ShipAiProfile {
  const nameProfile = fallbackShipAiProfileByName(model?.name);
  if (nameProfile === "apex-predator") return nameProfile;
  return normalizeShipAiProfile(model?.aiProfile) ?? nameProfile;
}

function canBasesOverlap(a: Pick<UnitFootprint, "isFighter">, b: Pick<UnitFootprint, "isFighter">): boolean {
  void a;
  void b;
  return false;
}

function basesOverlap(a: UnitFootprint, b: UnitFootprint): boolean {
  return centerDistance(a, b) < rulesBaseRadius(a) + rulesBaseRadius(b) - BASE_CONTACT_EPSILON;
}

function basesInContact(a: UnitFootprint, b: UnitFootprint): boolean {
  return centerDistance(a, b) <= rulesBaseRadius(a) + rulesBaseRadius(b) + BASE_CONTACT_EPSILON;
}

function enemyFighterContacts(fighter: UnitFootprint, others: UnitFootprint[]): UnitFootprint[] {
  if (!fighter.isFighter) return [];
  return others.filter(other =>
    other.id !== fighter.id
    && other.isFighter
    && other.ownerId !== fighter.ownerId
    && basesInContact(fighter, other)
  );
}

function findIllegalBaseOverlap(candidate: UnitFootprint, others: UnitFootprint[]): UnitFootprint | null {
  for (const other of others) {
    if (candidate.id === other.id) continue;
    if (canBasesOverlap(candidate, other)) continue;
    if (basesOverlap(candidate, other)) return other;
  }
  return null;
}

type MovementDebtClearanceResult = {
  hasLegalRestingSpot: boolean;
  checkedDistances: number[];
  checkedHeadings: number[];
  firstLegal?: { distance: number; heading: number; x: number; z: number };
  remainingMinimum: number;
  remainingMaximum: number;
};

function candidateMovementDebtHeadings(
  unit: typeof gameUnitsTable.$inferSelect,
  crits: ReturnType<typeof deriveCritEffects>,
  traits: ReturnType<typeof movementTraitsForModel>,
  turnProfile: ReturnType<typeof effectiveTurnProfile>,
): number[] {
  const headings = new Set<number>([normalizeHeadingDegrees(unit.heading)]);
  if (turnProfile.turnsForbidden) return [...headings];
  if (unit.turnsMadeThisActivation >= turnProfile.maxTurns) return [...headings];
  const requiredStraight = turnDistanceRequirement(
    unit,
    crits,
    traits,
    unit.turnsMadeThisActivation,
  );
  if (unit.distanceSinceLastTurnThisActivation + 1e-6 < requiredStraight) {
    return [...headings];
  }
  const step = Math.max(1, Math.min(45, turnProfile.turnAngle));
  for (let delta = step; delta <= turnProfile.turnAngle + 1e-6; delta += step) {
    headings.add(normalizeHeadingDegrees(unit.heading + delta));
    headings.add(normalizeHeadingDegrees(unit.heading - delta));
  }
  return [...headings];
}

async function scanLegalMovementDebtRestingSpots(
  tx: any,
  gameId: number,
  unit: typeof gameUnitsTable.$inferSelect,
  args: {
    minRequired: number;
    speedCap: number;
    crits: ReturnType<typeof deriveCritEffects>;
    traits: ReturnType<typeof movementTraitsForModel>;
    turnProfile: ReturnType<typeof effectiveTurnProfile>;
  },
): Promise<MovementDebtClearanceResult> {
  const remainingMinimum = Math.max(
    0,
    args.minRequired - unit.inchesMovedThisActivation,
  );
  const remainingMaximum = Math.max(
    0,
    args.speedCap - unit.inchesMovedThisActivation,
  );
  const result: MovementDebtClearanceResult = {
    hasLegalRestingSpot: false,
    checkedDistances: [],
    checkedHeadings: [],
    remainingMinimum,
    remainingMaximum,
  };
  if (remainingMinimum <= 1e-6) {
    return {
      ...result,
      hasLegalRestingSpot: true,
      firstLegal: {
        distance: 0,
        heading: normalizeHeadingDegrees(unit.heading),
        x: unit.hexQ,
        z: unit.hexR,
      },
    };
  }
  if (remainingMaximum + 1e-6 < remainingMinimum) return result;

  const allUnits = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, gameId),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  const otherFootprints: UnitFootprint[] = [];
  for (const other of allUnits as Array<typeof gameUnitsTable.$inferSelect>) {
    if (other.id === unit.id) continue;
    const model = await getShipModelForUnit(tx, other);
    otherFootprints.push({
      id: other.id,
      ownerId: other.ownerId,
      x: other.hexQ,
      z: other.hexR,
      baseRadiusInches: rulesBaseRadius(other),
      isFighter: model ? shipModelIsFighter(model) : false,
    });
  }

  const headings = candidateMovementDebtHeadings(
    unit,
    args.crits,
    args.traits,
    args.turnProfile,
  );
  result.checkedHeadings = headings;
  const startDistance = Math.ceil(remainingMinimum * 2) / 2;
  for (
    let distance = startDistance;
    distance <= remainingMaximum + 1e-6;
    distance = snapHalfInch(distance + 0.5)
  ) {
    const snappedDistance = snapHalfInch(distance);
    if (!result.checkedDistances.some(d => Math.abs(d - snappedDistance) < 1e-6)) {
      result.checkedDistances.push(snappedDistance);
    }
    for (const heading of headings) {
      const forward = headingForwardVec({ ...unit, heading });
      const candidate: UnitFootprint = {
        id: unit.id,
        ownerId: unit.ownerId,
        x: snapBoardCoord(unit.hexQ + forward.x * snappedDistance),
        z: snapBoardCoord(unit.hexR + forward.z * snappedDistance),
        baseRadiusInches: rulesBaseRadius(unit),
        isFighter: false,
      };
      if (!findIllegalBaseOverlap(candidate, otherFootprints)) {
        return {
          ...result,
          hasLegalRestingSpot: true,
          firstLegal: {
            distance: snappedDistance,
            heading,
            x: candidate.x,
            z: candidate.z,
          },
        };
      }
    }
  }
  return result;
}

type AiMovementHeadingCandidate = {
  heading: number;
  label: string;
};

type AiEnemyThreat = UnitFootprint & {
  heading: number;
  flipped: boolean;
  weapons: Array<Pick<typeof weaponsTable.$inferSelect, "arc" | "range" | "attackDice" | "traits">>;
};

function arcThreatAtPoint(
  enemy: AiEnemyThreat,
  point: { x: number; z: number; baseRadiusInches?: number | null },
): number {
  let threat = 0;
  for (const weapon of enemy.weapons) {
    const distance = centerDistance(enemy, point);
    if (distance > weapon.range + rulesBaseRadius(point)) continue;
    if (!isInArc({ x: enemy.x, z: enemy.z, headingDeg: enemy.heading, flipped: enemy.flipped }, point, weapon.arc)) continue;
    threat += weaponThreatValue(weapon);
  }
  return threat;
}

function ownArcThreatAgainstTarget(
  shooter: UnitFootprint,
  heading: number,
  flipped: boolean,
  weapons: Array<Pick<typeof weaponsTable.$inferSelect, "arc" | "range" | "attackDice" | "traits">>,
  target: UnitFootprint | null,
): { threat: number; sideArcThreat: number; forwardArcThreat: number } {
  if (!target) return { threat: 0, sideArcThreat: 0, forwardArcThreat: 0 };
  let threat = 0;
  let sideArcThreat = 0;
  let forwardArcThreat = 0;
  for (const weapon of weapons) {
    const distance = centerDistance(shooter, target);
    if (distance > weapon.range + rulesBaseRadius(shooter)) continue;
    if (!isInArc({ x: shooter.x, z: shooter.z, headingDeg: heading, flipped }, target, weapon.arc)) continue;
    const value = weaponThreatValue(weapon);
    threat += value;
    if (isSideArc(weapon.arc)) sideArcThreat += value;
    if (/forward/i.test(weapon.arc) || /boresight forward/i.test(weapon.arc)) forwardArcThreat += value;
  }
  return { threat, sideArcThreat, forwardArcThreat };
}

function findBestAiMovementEndpoint(
  start: { x: number; z: number },
  maxDistance: number,
  minDistance: number,
  moving: UnitFootprint,
  blockers: UnitFootprint[],
  target: UnitFootprint | null,
  headingCandidates: AiMovementHeadingCandidate[],
  ownWeapons: Array<Pick<typeof weaponsTable.$inferSelect, "arc" | "range" | "attackDice" | "traits">>,
  ownFlipped: boolean,
  enemyThreats: AiEnemyThreat[],
  lowHealth: boolean,
  novaBroadsideBias: boolean,
  aiProfile: ShipAiProfile,
): { x: number; z: number; moved: number; heading: number; headingLabel: string; incomingThreat: number; ownThreat: number; sideArcThreat: number; forwardArcThreat: number } | null {
  const max = Math.max(0, snapHalfInch(maxDistance));
  const min = Math.max(0, snapHalfInch(minDistance));
  let best: {
    x: number;
    z: number;
    moved: number;
    heading: number;
    headingLabel: string;
    incomingThreat: number;
    ownThreat: number;
    sideArcThreat: number;
    forwardArcThreat: number;
    score: number;
  } | null = null;

  for (const headingCandidate of headingCandidates) {
    const headingRad = (headingCandidate.heading * Math.PI) / 180;
    const direction = { x: Math.sin(headingRad), z: Math.cos(headingRad) };

    for (let distance = 0; distance <= max + 1e-6; distance += 0.5) {
      const moved = snapHalfInch(distance);
      if (moved < min) continue;

      const x = snapBoardCoord(start.x + direction.x * moved);
      const z = snapBoardCoord(start.z + direction.z * moved);
      if (!isPointInsideBoard({ x, z })) continue;

      const candidate: UnitFootprint = {
        ...moving,
        x,
        z,
      };
      if (findIllegalBaseOverlap(candidate, blockers)) continue;

      const incomingThreat = enemyThreats.reduce((sum, enemy) => sum + arcThreatAtPoint(enemy, candidate), 0);
      const ownArc = ownArcThreatAgainstTarget(candidate, headingCandidate.heading, ownFlipped, ownWeapons, target);
      const targetEdgeDistance = target ? edgeDistance(candidate, target) : 0;
      const nearestEnemyDistance = enemyThreats.length > 0
        ? Math.min(...enemyThreats.map(enemy => edgeDistance(candidate, enemy)))
        : 0;
      const broadsideBonus = (aiProfile === "broadside" ? ownArc.sideArcThreat * 5 : 0)
        + (novaBroadsideBias ? ownArc.sideArcThreat * 8 : 0);
      const jousterBonus = aiProfile === "jouster" ? ownArc.forwardArcThreat * 4 : 0;
      const apexArcBonus = aiProfile === "apex-predator" ? ownArc.forwardArcThreat * 6 + ownArc.threat * 2 : 0;
      const attackScore = ownArc.threat * 5 + broadsideBonus + jousterBonus + apexArcBonus;
      const desiredRange = aiProfile === "standoff"
        ? 18
        : aiProfile === "broadside"
          ? 10
          : aiProfile === "jouster"
            ? 12
            : aiProfile === "apex-predator"
              ? 12
              : 3;
      const rangeScore = target
        ? aiProfile === "apex-predator"
          ? -Math.abs(targetEdgeDistance - desiredRange) * 1.25 - (targetEdgeDistance < 4 ? (4 - targetEdgeDistance) * 5 : 0)
          : aiProfile === "brawler"
          ? -targetEdgeDistance * 1.4
          : -Math.abs(targetEdgeDistance - desiredRange)
        : moved;
      const profileMoveBias = aiProfile === "standoff"
        ? nearestEnemyDistance * 0.75
        : aiProfile === "brawler"
          ? moved * 0.12
          : aiProfile === "apex-predator"
            ? (target && targetEdgeDistance > 18 ? moved * 0.2 : 0)
          : 0;
      const survivalScore = lowHealth
        ? nearestEnemyDistance * 1.2 - incomingThreat * 18
        : aiProfile === "apex-predator"
          ? -incomingThreat * 0.75
          : -incomingThreat * 1.5;
      const score = attackScore + rangeScore + profileMoveBias + survivalScore + moved * 0.02;

      if (!best || score > best.score) {
        best = {
          x,
          z,
          moved,
          heading: headingCandidate.heading,
          headingLabel: headingCandidate.label,
          incomingThreat,
          ownThreat: ownArc.threat,
          sideArcThreat: ownArc.sideArcThreat,
          forwardArcThreat: ownArc.forwardArcThreat,
          score,
        };
      }
    }
  }

  return best ? {
    x: best.x,
    z: best.z,
    moved: best.moved,
    heading: best.heading,
    headingLabel: best.headingLabel,
    incomingThreat: best.incomingThreat,
    ownThreat: best.ownThreat,
    sideArcThreat: best.sideArcThreat,
    forwardArcThreat: best.forwardArcThreat,
  } : null;
}

type AiManeuverStep =
  | {
      kind: "forward";
      distance: number;
      from: { x: number; z: number };
      to: { x: number; z: number };
      heading: number;
    }
  | {
      kind: "turn";
      delta: number;
      fromHeading: number;
      toHeading: number;
      afterMoved: number;
    };

type AiLegalMovementPlan = {
  x: number;
  z: number;
  heading: number;
  moved: number;
  turns: number;
  distanceSinceLastTurn: number;
  headingLabel: string;
  incomingThreat: number;
  ownThreat: number;
  sideArcThreat: number;
  forwardArcThreat: number;
  score: number;
  steps: AiManeuverStep[];
};

function enumerateHalfInchTuples(
  count: number,
  maxTotal: number,
  mins: number[],
): number[][] {
  const results: number[][] = [];
  const current: number[] = [];
  const maxTicks = Math.max(0, Math.round(maxTotal * 2));
  const minTicks = mins.map(min => Math.max(0, Math.ceil(min * 2)));
  const walk = (index: number, usedTicks: number) => {
    if (index === count) {
      results.push([...current]);
      return;
    }
    const remainingMinTicks = minTicks.slice(index + 1).reduce((sum, value) => sum + value, 0);
    const min = minTicks[index] ?? 0;
    const max = maxTicks - usedTicks - remainingMinTicks;
    for (let ticks = min; ticks <= max; ticks++) {
      current[index] = ticks / 2;
      walk(index + 1, usedTicks + ticks);
    }
  };
  walk(0, 0);
  return results;
}

function splitHeadingDeltaIntoLegalTurns(
  fromHeading: number,
  targetHeading: number,
  turnCount: number,
  turnAngle: number,
): number[] | null {
  if (turnCount <= 0) return headingDeltaDegrees(fromHeading, targetHeading) <= 1e-6 ? [] : null;
  const remaining = signedHeadingDeltaDegrees(fromHeading, targetHeading);
  if (Math.abs(remaining) <= 1e-6) return null;
  if (Math.abs(remaining) > turnCount * turnAngle + 1e-6) return null;
  const sign = remaining >= 0 ? 1 : -1;
  let left = Math.abs(remaining);
  const deltas: number[] = [];
  for (let index = 0; index < turnCount; index++) {
    const turnsLeft = turnCount - index - 1;
    const minNow = Math.max(0, left - turnsLeft * turnAngle);
    const delta = Math.min(turnAngle, Math.max(minNow, Math.min(turnAngle, left)));
    deltas.push(sign * delta);
    left = Math.max(0, left - delta);
  }
  return left <= 1e-6 ? deltas : null;
}

function scoreAiMovementEndpoint(
  candidate: UnitFootprint,
  heading: number,
  target: UnitFootprint | null,
  ownWeapons: Array<Pick<typeof weaponsTable.$inferSelect, "arc" | "range" | "attackDice" | "traits">>,
  ownFlipped: boolean,
  enemyThreats: AiEnemyThreat[],
  lowHealth: boolean,
  novaBroadsideBias: boolean,
  aiProfile: ShipAiProfile,
  moved: number,
): {
  score: number;
  incomingThreat: number;
  ownThreat: number;
  sideArcThreat: number;
  forwardArcThreat: number;
} {
  const incomingThreat = enemyThreats.reduce((sum, enemy) => sum + arcThreatAtPoint(enemy, candidate), 0);
  const ownArc = ownArcThreatAgainstTarget(candidate, heading, ownFlipped, ownWeapons, target);
  const targetEdgeDistance = target ? edgeDistance(candidate, target) : 0;
  const nearestEnemyDistance = enemyThreats.length > 0
    ? Math.min(...enemyThreats.map(enemy => edgeDistance(candidate, enemy)))
    : 0;
  const broadsideBonus = (aiProfile === "broadside" ? ownArc.sideArcThreat * 5 : 0)
    + (novaBroadsideBias ? ownArc.sideArcThreat * 8 : 0);
  const jousterBonus = aiProfile === "jouster" ? ownArc.forwardArcThreat * 4 : 0;
  const apexArcBonus = aiProfile === "apex-predator" ? ownArc.forwardArcThreat * 6 + ownArc.threat * 2 : 0;
  const attackScore = ownArc.threat * 5 + broadsideBonus + jousterBonus + apexArcBonus;
  const desiredRange = aiProfile === "standoff"
    ? 18
    : aiProfile === "broadside"
      ? 10
      : aiProfile === "jouster"
        ? 12
        : aiProfile === "apex-predator"
          ? 12
          : 3;
  const rangeScore = target
    ? aiProfile === "apex-predator"
      ? -Math.abs(targetEdgeDistance - desiredRange) * 1.25 - (targetEdgeDistance < 4 ? (4 - targetEdgeDistance) * 5 : 0)
      : aiProfile === "brawler"
      ? -targetEdgeDistance * 1.4
      : -Math.abs(targetEdgeDistance - desiredRange)
    : moved;
  const profileMoveBias = aiProfile === "standoff"
    ? nearestEnemyDistance * 0.75
    : aiProfile === "brawler"
      ? moved * 0.12
      : aiProfile === "apex-predator"
        ? (target && targetEdgeDistance > 18 ? moved * 0.2 : 0)
      : 0;
  const survivalScore = lowHealth
    ? nearestEnemyDistance * 1.2 - incomingThreat * 18
    : aiProfile === "apex-predator"
      ? -incomingThreat * 0.75
      : -incomingThreat * 1.5;
  const edgeClearance = boardEdgeClearance(candidate);
  const edgeRecoveryScore = edgeClearance < AI_EDGE_RECOVERY_BUFFER_INCHES
    ? -(AI_EDGE_RECOVERY_BUFFER_INCHES - edgeClearance) * 7
    : 0;
  const score = attackScore + rangeScore + profileMoveBias + survivalScore + edgeRecoveryScore + moved * 0.02;
  return {
    score,
    incomingThreat,
    ownThreat: ownArc.threat,
    sideArcThreat: ownArc.sideArcThreat,
    forwardArcThreat: ownArc.forwardArcThreat,
  };
}

function buildLegalAiMovementPlans(
  unit: typeof gameUnitsTable.$inferSelect,
  crits: { speedReduce: number },
  traits: { agile?: boolean; superManeuverable?: boolean },
  speedCap: number,
  minMove: number,
  turnProfile: { maxTurns: number; turnAngle: number; turnsForbidden: boolean },
  moving: UnitFootprint,
  blockers: UnitFootprint[],
  target: UnitFootprint | null,
  headingCandidates: AiMovementHeadingCandidate[],
  ownWeapons: Array<Pick<typeof weaponsTable.$inferSelect, "arc" | "range" | "attackDice" | "traits">>,
  ownFlipped: boolean,
  enemyThreats: AiEnemyThreat[],
  lowHealth: boolean,
  novaBroadsideBias: boolean,
  aiProfile: ShipAiProfile,
): AiLegalMovementPlan[] {
  const plans: AiLegalMovementPlan[] = [];
  const maxTurnsToSearch = turnProfile.turnsForbidden ? 0 : Math.min(turnProfile.maxTurns, traits.superManeuverable ? 1 : 3);
  const maxDistance = Math.max(0, snapHalfInch(speedCap));
  const start = { x: unit.hexQ, z: unit.hexR, heading: normalizeHeadingDegrees(unit.heading) };
  const headingOptions = Array.from(
    new Map([
      ...headingCandidates,
      { heading: start.heading, label: "current-heading" },
    ].map(candidate => [normalizeHeadingDegrees(candidate.heading), {
      heading: normalizeHeadingDegrees(candidate.heading),
      label: candidate.label,
    }])).values(),
  );

  for (const headingOption of headingOptions) {
    for (let turnCount = 0; turnCount <= maxTurnsToSearch; turnCount++) {
      const turnDeltas = splitHeadingDeltaIntoLegalTurns(start.heading, headingOption.heading, turnCount, turnProfile.turnAngle);
      if (!turnDeltas) continue;
      const mins: number[] = [];
      for (let turnIndex = 0; turnIndex < turnCount; turnIndex++) {
        mins.push(turnDistanceRequirement(unit, crits, traits, turnIndex));
      }
      mins.push(0);
      for (const distances of enumerateHalfInchTuples(turnCount + 1, maxDistance, mins)) {
        const totalDistance = snapHalfInch(distances.reduce((sum, value) => sum + value, 0));
        if (totalDistance + 1e-6 < minMove) continue;

        let x = start.x;
        let z = start.z;
        let heading = start.heading;
        let moved = 0;
        let distanceSinceLastTurn = 0;
        let valid = true;
        const steps: AiManeuverStep[] = [];

        for (let index = 0; index < distances.length; index++) {
          const distance = distances[index] ?? 0;
          if (distance > 0) {
            const headingRad = (heading * Math.PI) / 180;
            const from = { x, z };
            x = snapBoardCoord(x + Math.sin(headingRad) * distance);
            z = snapBoardCoord(z + Math.cos(headingRad) * distance);
            moved = snapHalfInch(moved + distance);
            distanceSinceLastTurn = snapHalfInch(distanceSinceLastTurn + distance);
            steps.push({ kind: "forward", distance, from, to: { x, z }, heading });
            if (!isPointInsideBoard({ x, z })) {
              valid = false;
              break;
            }
            const footprint = { ...moving, x, z };
            if (findIllegalBaseOverlap(footprint, blockers)) {
              valid = false;
              break;
            }
          }

          const turnDelta = turnDeltas[index];
          if (turnDelta !== undefined && Math.abs(turnDelta) > 1e-6) {
            const requiredStraight = turnDistanceRequirement(unit, crits, traits, index);
            if (distanceSinceLastTurn + 1e-6 < requiredStraight) {
              valid = false;
              break;
            }
            const fromHeading = heading;
            heading = normalizeHeadingDegrees(heading + turnDelta);
            distanceSinceLastTurn = 0;
            steps.push({ kind: "turn", delta: turnDelta, fromHeading, toHeading: heading, afterMoved: moved });
          }
        }
        if (!valid) continue;

        const candidateFootprint = { ...moving, x, z };
        if (findIllegalBaseOverlap(candidateFootprint, blockers)) continue;
        const scored = scoreAiMovementEndpoint(
          candidateFootprint,
          heading,
          target,
          ownWeapons,
          ownFlipped,
          enemyThreats,
          lowHealth,
          novaBroadsideBias,
          aiProfile,
          moved,
        );
        plans.push({
          x,
          z,
          heading,
          moved,
          turns: turnCount,
          distanceSinceLastTurn,
          headingLabel: headingOption.label,
          ...scored,
          steps,
        });
      }
    }
  }

  plans.sort((a, b) =>
    b.score - a.score
    || b.ownThreat - a.ownThreat
    || a.incomingThreat - b.incomingThreat
    || b.moved - a.moved,
  );
  return plans;
}

function fighterWeaponRangeDistance(
  attacker: UnitFootprint,
  target: { x: number; z: number; baseRadiusInches?: number | null; isFighter?: boolean },
): number {
  let dist = centerDistance(attacker, target);
  if (attacker.isFighter) dist -= rulesBaseRadius(attacker);
  if (target.isFighter) dist -= rulesBaseRadius(target);
  return Math.max(0, dist);
}

function antiFighterRangeDistance(attacker: UnitFootprint, target: UnitFootprint): number {
  let dist = centerDistance(attacker, target);
  if (attacker.isFighter) dist -= rulesBaseRadius(attacker);
  if (target.isFighter) dist -= rulesBaseRadius(target);
  return Math.max(0, dist);
}

type AiStatePatch = {
  status: "idle" | "thinking" | "deployed" | "acted" | "error";
  lastStep: string;
  lastActionAt: string;
  profile: string;
  message?: string;
  fleetId?: number;
  unitIds?: number[];
  decisionLog?: AiDecisionEntry[];
  lastAntiFighter?: Record<string, unknown>;
  lastDogfight?: Record<string, unknown>;
  lastInitiativeTieRoll?: number;
  lastInitiativeTieRound?: number;
  lastError?: {
    message: string;
    code: string;
    at: string;
  };
};

type AiDecisionEntry = {
  at: string;
  step: string;
  phase: "initiative" | "movement" | "firing" | "end" | "setup";
  unitId?: number;
  unitName?: string;
  summary: string;
  details?: Record<string, unknown>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function aiState(status: AiStatePatch["status"], lastStep: string, patch: Partial<AiStatePatch> = {}): AiStatePatch {
  return {
    status,
    lastStep,
    lastActionAt: nowIso(),
    profile: DEFAULT_AI_PROFILE,
    ...patch,
  };
}

function aiErrorState(lastStep: string, err: unknown): AiStatePatch {
  const message = err instanceof Error ? err.message : "Unknown AI setup error";
  return aiState("error", lastStep, {
    message: "AI setup failed.",
    lastError: {
      message,
      code: "AI_SETUP_FAILED",
      at: nowIso(),
    },
  });
}

function mergeAiState(raw: unknown, patch: AiStatePatch): Record<string, unknown> {
  return {
    ...(raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {}),
    ...patch,
  };
}

function aiDecision(
  step: string,
  phase: AiDecisionEntry["phase"],
  summary: string,
  details: Record<string, unknown> = {},
  unit?: Pick<typeof gameUnitsTable.$inferSelect, "id" | "name">,
): AiDecisionEntry {
  return {
    at: nowIso(),
    step,
    phase,
    unitId: unit?.id,
    unitName: unit?.name,
    summary,
    details,
  };
}

function withAiDecisionLog(
  raw: unknown,
  patch: AiStatePatch,
  entry: AiDecisionEntry,
): AiStatePatch {
  const base = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const existing = Array.isArray(base.decisionLog)
    ? base.decisionLog.filter((item): item is AiDecisionEntry => Boolean(item && typeof item === "object"))
    : [];
  return {
    ...patch,
    decisionLog: [...existing.slice(-19), entry],
  };
}

function chooseAiDeploymentModel(
  models: Array<typeof shipModelsTable.$inferSelect>,
  scenarioPriority: ReturnType<typeof normalizePriorityLevel>,
  allocationPoints: number,
): typeof shipModelsTable.$inferSelect | null {
  const budgetTicks = Math.max(1, Math.trunc(allocationPoints)) * ALLOCATION_TICKS_PER_FAP;
  const affordable = models
    .filter(model => model.hullPoints > 0)
    .map(model => ({
      model,
      ticks: allocationTicksForShip(normalizePriorityLevel(model.priorityLevel), scenarioPriority),
      fighter: shipModelIsFighter(model),
    }))
    .filter(candidate => candidate.ticks <= budgetTicks);

  const candidates = affordable.some(candidate => !candidate.fighter)
    ? affordable.filter(candidate => !candidate.fighter)
    : affordable;

  candidates.sort((a, b) => {
    if (b.ticks !== a.ticks) return b.ticks - a.ticks;
    return (b.model.pointCost ?? 0) - (a.model.pointCost ?? 0);
  });
  return candidates[0]?.model ?? null;
}

async function autoDeployAiOpponent(gameId: number): Promise<typeof gamesTable.$inferSelect> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`);
    const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
    if (!game) throw new Error("Game not found for AI deployment");
    if (game.opponentKind !== "ai" || game.opponentId !== AI_OPPONENT_ID) {
      throw new Error("Game is not configured for the reserved AI opponent");
    }
    if (game.opponentDeployed) return game;

    const scenarioPriority = normalizePriorityLevel(game.priorityLevel);
    const models = await tx.select().from(shipModelsTable);
    const model = chooseAiDeploymentModel(models, scenarioPriority, game.allocationPoints);
    if (!model) {
      throw new Error(`No affordable AI ship model found for ${priorityLabel(scenarioPriority)} ${game.allocationPoints} FAP`);
    }
    const modelTraits = parseShipTraits(model.traits);

    const [fleet] = await tx.insert(fleetsTable).values({
      ownerId: AI_OPPONENT_ID,
      name: `AI ${priorityLabel(scenarioPriority)} Fleet - Game #${game.id}`,
    }).returning();
    const [ship] = await tx.insert(shipsTable).values({
      fleetId: fleet.id,
      shipModelId: model.id,
      name: model.name,
    }).returning();

    const deploymentDepth = Math.max(4, Math.min(30, game.deploymentDepth));
    const inset = Math.max(2, Math.min(deploymentDepth - 1, Math.ceil(deploymentDepth / 2)));
    const [unit] = await tx.insert(gameUnitsTable).values({
      gameId: game.id,
      ownerId: AI_OPPONENT_ID,
      shipId: ship.id,
      name: ship.name,
      modelFilename: model.filename,
      faction: model.faction,
      baseRadiusInches: model.baseRadiusInches,
      hullPoints: model.hullPoints,
      maxHullPoints: model.hullPoints,
      damageThreshold: model.damageThreshold ?? Math.ceil(model.hullPoints / 2),
      hexQ: 0,
      hexR: -36 + inset,
      heading: 0,
      speed: model.speed,
      turnAngle: model.turnAngle ?? 45,
      turns: model.turns ?? 1,
      weaponRange: model.weaponRange,
      weaponDamage: model.weaponDamage,
      crewQuality: modelTraits.ancient ? 7 : 4,
      shieldsCurrent: model.shieldMax ?? 0,
      interceptorDiceRemaining: modelTraits.interceptors,
      interceptorThresholdCurrent: 2,
      crewPoints: model.crew ?? 0,
      maxCrewPoints: model.crew ?? 0,
      crewThreshold: model.crewThreshold ?? (model.crew ? Math.ceil(model.crew / 2) : 0),
      damageState: "normal",
      carriedFighters: carriedFightersFromSmallCraft(model.smallCraft, models),
      isDestroyed: false,
    }).returning();

    const [row] = await tx.update(gamesTable).set({
      opponentFleetId: fleet.id,
      opponentDeployed: true,
      aiProfile: DEFAULT_AI_PROFILE,
      aiState: aiState("deployed", "setup.auto-deploy", {
        message: `Auto-deployed ${model.name}.`,
        fleetId: fleet.id,
        unitIds: [unit.id],
      }),
    }).where(eq(gamesTable.id, game.id)).returning();
    return row;
  });
}

async function applyInitiativeRoll(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  rollerId: string,
  myRoll: number,
  aiStatePatch?: AiStatePatch,
): Promise<typeof gamesTable.$inferSelect> {
  const isChallenger = rollerId === game.challengerId;
  const isOpponent = rollerId === game.opponentId;
  if (!isChallenger && !isOpponent) throw Object.assign(new Error("Not a participant"), { status: 403 });

  const alreadyRolled = isChallenger
    ? game.initiativeChallengerRoll !== null
    : game.initiativeOpponentRoll !== null;
  if (alreadyRolled) throw Object.assign(new Error("Already rolled this round"), { status: 400 });

  const cRoll = isChallenger ? myRoll : game.initiativeChallengerRoll;
  const oRoll = isOpponent ? myRoll : game.initiativeOpponentRoll;
  const baseUpdate = aiStatePatch ? { aiState: mergeAiState(game.aiState, aiStatePatch) } : {};

  if (cRoll === null || oRoll === null) {
    const [row] = await tx.update(gamesTable).set({
      ...baseUpdate,
      initiativeChallengerRoll: cRoll,
      initiativeOpponentRoll: oRoll,
    }).where(eq(gamesTable.id, game.id)).returning();
    return row;
  }

  if (cRoll === oRoll) {
    const tiePatch = aiState("idle", "initiative.tie", {
      message: `Initiative tied at ${cRoll}; both commanders must re-roll.`,
      lastInitiativeTieRoll: cRoll,
      lastInitiativeTieRound: game.currentRound,
    });
    const [row] = await tx.update(gamesTable).set({
      ...baseUpdate,
      aiState: mergeAiState(baseUpdate.aiState ?? game.aiState, tiePatch),
      initiativeChallengerRoll: null,
      initiativeOpponentRoll: null,
    }).where(eq(gamesTable.id, game.id)).returning();
    return row;
  }

  const winnerId = cRoll > oRoll ? game.challengerId : game.opponentId;
  const [row] = await tx.update(gamesTable).set({
    ...baseUpdate,
    initiativeChallengerRoll: cRoll,
    initiativeOpponentRoll: oRoll,
    initiativeWinnerId: winnerId,
    activePlayerId: null,
    activeUnitId: null,
  }).where(eq(gamesTable.id, game.id)).returning();
  return row;
}

async function initiativeModifierForPlayer(tx: any, gameId: number, playerId: string | null): Promise<number> {
  if (!playerId) return 0;
  const units = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, gameId),
    eq(gameUnitsTable.ownerId, playerId),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  let ancientBonus = 0;
  let commandBonus = 0;
  for (const u of units) {
    const [ship] = await tx.select().from(shipsTable).where(eq(shipsTable.id, u.shipId));
    if (!ship) continue;
    const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
    if (!model) continue;
    const critRows = await tx.select().from(unitCriticalEffectsTable)
      .where(eq(unitCriticalEffectsTable.gameUnitId, u.id));
    const crits = deriveCritEffects((critRows as Array<typeof unitCriticalEffectsTable.$inferSelect>).map(r => ({
      effectKey: r.effectKey,
      randomArc: r.randomArc,
      randomWeaponId: r.randomWeaponId,
      lostTraits: r.lostTraits ?? [],
    })));
    const traits = parseShipTraits(filterLostTraits(model.traits, crits.lostTraitNames));
    if (traits.ancient) ancientBonus = Math.max(ancientBonus, 4);
    if (!isCrippledUnit(u) && !isSkeletonCrewUnit(u)) {
      commandBonus = Math.max(commandBonus, traits.command);
    }
  }
  return ancientBonus + commandBonus;
}

async function chooseHumanFirstAfterAiInitiative(
  tx: any,
  game: typeof gamesTable.$inferSelect,
): Promise<typeof gamesTable.$inferSelect> {
  if (
    game.status !== "active" ||
    game.phase !== "initiative" ||
    game.initiativeWinnerId !== AI_OPPONENT_ID ||
    game.initiativeChallengerRoll === null ||
    game.initiativeOpponentRoll === null
  ) {
    return game;
  }

  const preferredPlayerId = game.challengerId;
  const fallbackPlayerId = game.opponentId ?? AI_OPPONENT_ID;
  const activePlayerId =
    await firstEligiblePlayerForAiPhase(tx, game, "movement", [preferredPlayerId, fallbackPlayerId])
    ?? preferredPlayerId;
  const [row] = await tx.update(gamesTable).set({
    phase: "movement",
    activePlayerId,
    activeUnitId: null,
    aiState: mergeAiState(game.aiState, aiState("acted", "initiative.choose-first-activator", {
      message: activePlayerId === preferredPlayerId
        ? "AI won initiative and chose the human commander to activate first."
        : "AI won initiative, but the human commander has no eligible opening activation.",
    })),
  }).where(eq(gamesTable.id, game.id)).returning();
  return row;
}

function headingToPoint(from: { x: number; z: number }, to: { x: number; z: number }): number {
  const deg = Math.atan2(to.x - from.x, to.z - from.z) * 180 / Math.PI;
  return ((Math.round(deg) % 360) + 360) % 360;
}

async function getShipModelForUnit(tx: any, unit: typeof gameUnitsTable.$inferSelect): Promise<typeof shipModelsTable.$inferSelect | null> {
  const [ship] = await tx.select().from(shipsTable).where(eq(shipsTable.id, unit.shipId));
  if (!ship) return null;
  const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
  return model ?? null;
}

type ActivationSegment = "capital" | "fighter";

async function gameUnitIsFighter(tx: any, unit: typeof gameUnitsTable.$inferSelect): Promise<boolean> {
  const model = await getShipModelForUnit(tx, unit);
  return model ? shipModelIsFighter(model) : false;
}

async function fighterDogfightContacts(
  tx: any,
  gameId: number,
  unit: typeof gameUnitsTable.$inferSelect,
): Promise<UnitFootprint[]> {
  if (!(await gameUnitIsFighter(tx, unit))) return [];
  const fighterFootprint: UnitFootprint = {
    id: unit.id,
    ownerId: unit.ownerId,
    x: unit.hexQ,
    z: unit.hexR,
    baseRadiusInches: rulesBaseRadius(unit),
    isFighter: true,
  };
  const others = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, gameId),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  const enemyFighters: UnitFootprint[] = [];
  for (const other of others as Array<typeof gameUnitsTable.$inferSelect>) {
    if (other.id === unit.id || other.ownerId === unit.ownerId) continue;
    if (!(await gameUnitIsFighter(tx, other))) continue;
    enemyFighters.push({
      id: other.id,
      ownerId: other.ownerId,
      x: other.hexQ,
      z: other.hexR,
      baseRadiusInches: rulesBaseRadius(other),
      isFighter: true,
    });
  }
  return enemyFighterContacts(fighterFootprint, enemyFighters);
}

async function fighterIsLockedInDogfight(
  tx: any,
  gameId: number,
  unit: typeof gameUnitsTable.$inferSelect,
): Promise<boolean> {
  return (await fighterDogfightContacts(tx, gameId, unit)).length > 0;
}

async function movementActivationEligible(tx: any, unit: typeof gameUnitsTable.$inferSelect): Promise<boolean> {
  if (unit.isDestroyed || unit.hasMovedThisRound) return false;
  const critRows = await tx.select().from(unitCriticalEffectsTable)
    .where(eq(unitCriticalEffectsTable.gameUnitId, unit.id));
  const state = effectiveDamageState(unit.damageState, critRows);
  if (state === "adrift" || state === "exploding-end-of-next") return false;
  if (await fighterIsLockedInDogfight(tx, unit.gameId, unit)) return false;
  return true;
}

function firingActivationEligible(unit: typeof gameUnitsTable.$inferSelect): boolean {
  return !unit.isDestroyed
    && !unit.hasFiredThisRound
    && unit.hullPoints > 0
    && (unit.maxCrewPoints === 0 || unit.crewPoints > 0);
}

async function activationEligibleRowsForGame(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  phase: "movement" | "firing",
  ownerId: string | null = null,
  segment: ActivationSegment | null = null,
): Promise<Array<typeof gameUnitsTable.$inferSelect>> {
  const rows = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.isDestroyed, false),
    eq(phase === "movement" ? gameUnitsTable.hasMovedThisRound : gameUnitsTable.hasFiredThisRound, false),
  ));
  const eligible: Array<typeof gameUnitsTable.$inferSelect> = [];
  for (const row of rows) {
    if (ownerId !== null && row.ownerId !== ownerId) continue;
    if (phase === "movement" && !(await movementActivationEligible(tx, row))) continue;
    if (phase === "firing" && !firingActivationEligible(row)) continue;
    if (segment) {
      const fighter = await gameUnitIsFighter(tx, row);
      if (segment === "fighter" && !fighter) continue;
      if (segment === "capital" && fighter) continue;
    }
    eligible.push(row);
  }
  return eligible;
}

async function activationSegmentForGame(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  phase: "movement" | "firing",
): Promise<ActivationSegment | null> {
  const rows = await activationEligibleRowsForGame(tx, game, phase);
  let hasCapital = false;
  let hasFighter = false;
  for (const row of rows) {
    if (await gameUnitIsFighter(tx, row)) hasFighter = true;
    else hasCapital = true;
  }
  return phase === "movement"
    ? hasCapital ? "capital" : hasFighter ? "fighter" : null
    : hasFighter ? "fighter" : hasCapital ? "capital" : null;
}

async function fleetCarrierDogfightBonus(
  tx: any,
  gameId: number,
  ownerId: string,
): Promise<number> {
  const rows = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, gameId),
    eq(gameUnitsTable.ownerId, ownerId),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  for (const unit of rows as Array<typeof gameUnitsTable.$inferSelect>) {
    if (isCrippledUnit(unit) || isSkeletonCrewUnit(unit)) continue;
    const model = await getShipModelForUnit(tx, unit);
    if (!model || shipModelIsFighter(model)) continue;
    const critRows = await tx.select().from(unitCriticalEffectsTable)
      .where(eq(unitCriticalEffectsTable.gameUnitId, unit.id));
    const crits = deriveCritEffects((critRows as Array<typeof unitCriticalEffectsTable.$inferSelect>).map(r => ({
      effectKey: r.effectKey,
      randomArc: r.randomArc,
      randomWeaponId: r.randomWeaponId,
      lostTraits: r.lostTraits ?? [],
    })));
    const traits = parseShipTraits(filterLostTraits(model.traits, crits.lostTraitNames));
    if (traits.fleetCarrier) return 1;
  }
  return 0;
}

type DogfightResolutionLog = {
  kind: "dogfight";
  round: number;
  attackerUnitId: number;
  attackerName: string;
  attackerRoll: number;
  attackerDogfight: number;
  attackerFleetCarrierBonus: number;
  attackerSupportBonus: number;
  attackerSupporters: Array<{ id: number; name: string }>;
  attackerScore: number;
  targetUnitId: number;
  targetName: string;
  targetRoll: number;
  targetDogfight: number;
  targetFleetCarrierBonus: number;
  targetSupportBonus: number;
  targetSupporters: Array<{ id: number; name: string }>;
  targetScore: number;
  destroyedUnitId: number | null;
  fighterRecovery: DestroyedFighterRecoveryResult | null;
  tied: boolean;
  gameCompleted: boolean;
  winnerId: string | null;
};

async function resolveDogfightBetweenUnits(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  attacker: typeof gameUnitsTable.$inferSelect,
  target: typeof gameUnitsTable.$inferSelect,
): Promise<DogfightResolutionLog> {
  if (attacker.isDestroyed) throw Object.assign(new Error("Attacking fighter is destroyed"), { status: 400 });
  if (attacker.hasFiredThisRound) throw Object.assign(new Error("Fighter has already attacked this firing phase"), { status: 400 });
  if (target.ownerId === attacker.ownerId) throw Object.assign(new Error("Dogfight target must be an enemy fighter"), { status: 400 });
  if (target.isDestroyed) throw Object.assign(new Error("Target fighter already destroyed"), { status: 400 });

  const [attackerShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, attacker.shipId));
  const [targetShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, target.shipId));
  if (!attackerShip || !targetShip) throw Object.assign(new Error("Fighter ship record missing"), { status: 500 });
  const [attackerModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, attackerShip.shipModelId));
  const [targetModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, targetShip.shipModelId));
  if (!attackerModel || !targetModel) throw Object.assign(new Error("Fighter model missing"), { status: 500 });
  const attackerTraits = parseShipTraits(attackerModel.traits);
  const targetTraits = parseShipTraits(targetModel.traits);
  if (!shipModelIsFighter(attackerModel) || !shipModelIsFighter(targetModel)) {
    throw Object.assign(new Error("Dogfights can only be resolved between fighter flights"), { status: 400 });
  }

  const attackerFootprint: UnitFootprint = {
    id: attacker.id,
    ownerId: attacker.ownerId,
    x: attacker.hexQ,
    z: attacker.hexR,
    baseRadiusInches: rulesBaseRadius(attacker),
    isFighter: true,
  };
  const targetFootprint: UnitFootprint = {
    id: target.id,
    ownerId: target.ownerId,
    x: target.hexQ,
    z: target.hexR,
    baseRadiusInches: rulesBaseRadius(target),
    isFighter: true,
  };
  if (enemyFighterContacts(attackerFootprint, [targetFootprint]).length === 0) {
    throw Object.assign(new Error("Fighter flights must be in base contact to dogfight"), { status: 400 });
  }

  const liveRows = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  const attackerSupporters: Array<{ id: number; name: string }> = [];
  const targetSupporters: Array<{ id: number; name: string }> = [];
  for (const row of liveRows as Array<typeof gameUnitsTable.$inferSelect>) {
    if (row.id === attacker.id || row.id === target.id) continue;
    const rowModel = await getShipModelForUnit(tx, row);
    if (!rowModel || !shipModelIsFighter(rowModel)) continue;
    const footprint: UnitFootprint = {
      id: row.id,
      ownerId: row.ownerId,
      x: row.hexQ,
      z: row.hexR,
      baseRadiusInches: rulesBaseRadius(row),
      isFighter: true,
    };
    if (row.ownerId === attacker.ownerId && basesInContact(footprint, targetFootprint)) {
      attackerSupporters.push({ id: row.id, name: row.name });
    } else if (row.ownerId === target.ownerId && basesInContact(footprint, attackerFootprint)) {
      targetSupporters.push({ id: row.id, name: row.name });
    }
  }

  const attackerSupportBonus = attackerSupporters.length;
  const targetSupportBonus = targetSupporters.length;
  const attackerRoll = rollD6();
  const targetRoll = rollD6();
  const attackerFleetCarrierBonus = await fleetCarrierDogfightBonus(tx, game.id, attacker.ownerId);
  const targetFleetCarrierBonus = await fleetCarrierDogfightBonus(tx, game.id, target.ownerId);
  const attackerScore = attackerRoll + attackerTraits.dogfight + attackerFleetCarrierBonus + attackerSupportBonus;
  const targetScore = targetRoll + targetTraits.dogfight + targetFleetCarrierBonus + targetSupportBonus;
  const destroyedUnitId =
    attackerScore > targetScore ? target.id :
    targetScore > attackerScore ? attacker.id :
    null;
  const destroyedFighterBeforeRecovery =
    destroyedUnitId === target.id ? target :
    destroyedUnitId === attacker.id ? attacker :
    null;

  await tx.update(gameUnitsTable)
    .set({ hasFiredThisRound: true })
    .where(eq(gameUnitsTable.id, attacker.id));

  let fighterRecovery: DestroyedFighterRecoveryResult | null = null;
  if (destroyedUnitId !== null) {
    await tx.update(gameUnitsTable).set({
      hullPoints: 0,
      crewPoints: 0,
      shieldsCurrent: 0,
      interceptorDiceRemaining: 0,
      damageState: "destroyed",
      isDestroyed: true,
      hasFiredThisRound: true,
    }).where(eq(gameUnitsTable.id, destroyedUnitId));
    if (destroyedFighterBeforeRecovery) {
      fighterRecovery = await resolveDestroyedFighterRecovery(tx, game, {
        ...destroyedFighterBeforeRecovery,
        hullPoints: 0,
        crewPoints: 0,
        shieldsCurrent: 0,
        interceptorDiceRemaining: 0,
        damageState: "destroyed",
        isDestroyed: true,
        hasFiredThisRound: true,
      }, "dogfight");
    }
  }

  const allUnits = await tx.select().from(gameUnitsTable).where(eq(gameUnitsTable.gameId, game.id));
  const aliveByOwner = new Map<string, number>();
  for (const row of allUnits) {
    const destroyed = row.id === destroyedUnitId ? true : row.isDestroyed;
    if (unitCountsForVictory({ ...row, isDestroyed: destroyed })) {
      aliveByOwner.set(row.ownerId, (aliveByOwner.get(row.ownerId) ?? 0) + 1);
    }
  }
  const challengerAlive = aliveByOwner.get(game.challengerId) ?? 0;
  const opponentAlive = game.opponentId ? (aliveByOwner.get(game.opponentId) ?? 0) : 0;
  let winnerId: string | null = null;
  let gameCompleted = false;
  if (game.opponentId && challengerAlive === 0 && opponentAlive > 0) {
    winnerId = game.opponentId;
    gameCompleted = true;
  } else if (game.opponentId && opponentAlive === 0 && challengerAlive > 0) {
    winnerId = game.challengerId;
    gameCompleted = true;
  } else if (game.opponentId && challengerAlive === 0 && opponentAlive === 0) {
    gameCompleted = true;
  }
  if (gameCompleted) {
    await tx.update(gamesTable)
      .set({ status: "completed", winnerId, activePlayerId: null, activeUnitId: null })
      .where(eq(gamesTable.id, game.id));
  }

  const log: DogfightResolutionLog = {
    kind: "dogfight",
    round: game.currentRound,
    attackerUnitId: attacker.id,
    attackerName: attacker.name,
    attackerRoll,
    attackerDogfight: attackerTraits.dogfight,
    attackerFleetCarrierBonus,
    attackerSupportBonus,
    attackerSupporters,
    attackerScore,
    targetUnitId: target.id,
    targetName: target.name,
    targetRoll,
    targetDogfight: targetTraits.dogfight,
    targetFleetCarrierBonus,
    targetSupportBonus,
    targetSupporters,
    targetScore,
    destroyedUnitId,
    fighterRecovery,
    tied: destroyedUnitId === null,
    gameCompleted,
    winnerId,
  };
  await tx.update(gamesTable).set({
    aiState: mergeAiState(game.aiState, aiState("acted", "rules.dogfight", {
      message: destroyedUnitId === null
        ? "Dogfight tied; fighters remain locked."
        : `Dogfight destroyed fighter unit ${destroyedUnitId}.`,
      lastDogfight: log,
    })),
  }).where(eq(gamesTable.id, game.id));

  return log;
}

async function aiMovementEligible(tx: any, unit: typeof gameUnitsTable.$inferSelect): Promise<boolean> {
  return movementActivationEligible(tx, unit);
}

function aiFiringEligible(unit: typeof gameUnitsTable.$inferSelect): boolean {
  return firingActivationEligible(unit);
}

async function firstAiEligibleUnit(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  phase: "movement" | "firing",
): Promise<typeof gameUnitsTable.$inferSelect | null> {
  const segment = await activationSegmentForGame(tx, game, phase);
  if (!segment) return null;
  const rows = await activationEligibleRowsForGame(tx, game, phase, AI_OPPONENT_ID, segment);
  for (const row of rows) {
    if (phase === "movement" && await aiMovementEligible(tx, row)) return row;
    if (phase === "firing" && aiFiringEligible(row)) return row;
  }
  return null;
}

async function countEligibleForAiStep(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  ownerId: string,
  phase: "movement" | "firing",
  segment: ActivationSegment | null = null,
): Promise<number> {
  const rows = await activationEligibleRowsForGame(tx, game, phase, ownerId, segment);
  let count = 0;
  for (const row of rows) {
    if (phase === "movement" && await aiMovementEligible(tx, row)) count++;
    if (phase === "firing" && aiFiringEligible(row)) count++;
  }
  return count;
}

async function firstEligiblePlayerForAiPhase(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  phase: "movement" | "firing",
  preferredOrder: string[],
): Promise<string | null> {
  const segment = await activationSegmentForGame(tx, game, phase);
  if (!segment) return null;
  const seen = new Set<string>();
  for (const playerId of preferredOrder) {
    if (!playerId || seen.has(playerId)) continue;
    seen.add(playerId);
    if (await countEligibleForAiStep(tx, game, playerId, phase, segment) > 0) {
      return playerId;
    }
  }
  return null;
}

async function finishAiActivation(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  unit: typeof gameUnitsTable.$inferSelect,
  phase: "movement" | "firing",
  statePatch: AiStatePatch,
): Promise<typeof gamesTable.$inferSelect> {
  await tx.update(gameUnitsTable)
    .set(phase === "movement" ? { hasMovedThisRound: true } : { hasFiredThisRound: true })
    .where(and(eq(gameUnitsTable.id, unit.id), eq(gameUnitsTable.gameId, game.id)));

  const humanId = game.challengerId;
  const segment = await activationSegmentForGame(tx, game, phase);
  const humanRemaining = segment ? await countEligibleForAiStep(tx, game, humanId, phase, segment) : 0;
  const aiRemaining = segment ? await countEligibleForAiStep(tx, game, AI_OPPONENT_ID, phase, segment) : 0;
  let nextPhase: "initiative" | "movement" | "firing" | "end" = phase;
  let nextActivePlayerId: string | null = null;

  if (humanRemaining > 0) {
    nextActivePlayerId = humanId;
  } else if (aiRemaining > 0) {
    nextActivePlayerId = AI_OPPONENT_ID;
  } else if (phase === "movement") {
    nextPhase = "firing";
    const first = game.initiativeWinnerId === AI_OPPONENT_ID ? AI_OPPONENT_ID : humanId;
    const second = first === humanId ? AI_OPPONENT_ID : humanId;
    nextActivePlayerId = await countEligibleForAiStep(tx, game, first, "firing") > 0
      ? first
      : await countEligibleForAiStep(tx, game, second, "firing") > 0
        ? second
        : (game.initiativeWinnerId ?? humanId);
    if (
      await countEligibleForAiStep(tx, game, humanId, "firing") === 0
      && await countEligibleForAiStep(tx, game, AI_OPPONENT_ID, "firing") === 0
    ) {
      nextPhase = "end";
      nextActivePlayerId = game.initiativeWinnerId ?? humanId;
    }
  } else {
    nextPhase = "end";
    nextActivePlayerId = game.initiativeWinnerId ?? humanId;
  }

  const [row] = await tx.update(gamesTable).set({
    phase: nextPhase,
    activePlayerId: nextActivePlayerId,
    activeUnitId: null,
    lastActivatorId: AI_OPPONENT_ID,
    aiState: mergeAiState(game.aiState, statePatch),
  }).where(eq(gamesTable.id, game.id)).returning();
  return row;
}

async function activateAiUnitForPhase(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  phase: "movement" | "firing",
): Promise<typeof gamesTable.$inferSelect> {
  const segment = await activationSegmentForGame(tx, game, phase);
  const unit = await firstAiEligibleUnit(tx, game, phase);
  if (!unit) {
    if (segment && game.challengerId && await countEligibleForAiStep(tx, game, game.challengerId, phase, segment) > 0) {
      const [row] = await tx.update(gamesTable).set({
        activePlayerId: game.challengerId,
        activeUnitId: null,
        lastActivatorId: AI_OPPONENT_ID,
        aiState: mergeAiState(game.aiState, aiState("acted", `${phase}.pass-no-eligible-${segment}`, {
          message: `AI has no eligible ${segment} ${phase} activations; handing control to the human commander.`,
        })),
      }).where(eq(gamesTable.id, game.id)).returning();
      return row;
    }
    const [row] = await tx.update(gamesTable).set({
      aiState: mergeAiState(game.aiState, aiState("idle", `${phase}.no-eligible-unit`, {
        message: segment
          ? `AI has no eligible ${segment} ${phase} activations.`
          : `AI has no eligible ${phase} activations.`,
      })),
    }).where(eq(gamesTable.id, game.id)).returning();
    return row;
  }

  if (phase === "movement") {
    await tx.update(gameUnitsTable).set({
      hasInitiatedMoveThisActivation: false,
      inchesMovedThisActivation: 0,
      turnsMadeThisActivation: 0,
      distanceSinceLastTurnThisActivation: 0,
    }).where(and(eq(gameUnitsTable.id, unit.id), eq(gameUnitsTable.gameId, game.id)));
  } else {
    await tx.update(gameUnitsTable).set({ firedWeaponIds: [] })
      .where(and(eq(gameUnitsTable.id, unit.id), eq(gameUnitsTable.gameId, game.id)));
  }

  const [row] = await tx.update(gamesTable).set({
    activeUnitId: unit.id,
    aiState: mergeAiState(game.aiState, aiState("acted", `${phase}.activate-unit`, {
      message: `AI activated ${unit.name} for ${phase}.`,
      unitIds: [unit.id],
    })),
  }).where(eq(gamesTable.id, game.id)).returning();
  return row;
}

async function moveActiveAiUnit(tx: any, game: typeof gamesTable.$inferSelect): Promise<typeof gamesTable.$inferSelect> {
  if (!game.activeUnitId) return activateAiUnitForPhase(tx, game, "movement");
  const [unit] = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.id, game.activeUnitId),
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.ownerId, AI_OPPONENT_ID),
  ));
  if (!unit) throw new Error("AI active movement unit not found");

  const critRows = await tx.select().from(unitCriticalEffectsTable)
    .where(eq(unitCriticalEffectsTable.gameUnitId, unit.id));
  const crits = deriveCritEffects((critRows as Array<typeof unitCriticalEffectsTable.$inferSelect>).map(r => ({
    effectKey: r.effectKey,
    randomArc: r.randomArc,
    randomWeaponId: r.randomWeaponId,
    lostTraits: r.lostTraits ?? [],
  })));
  const model = await getShipModelForUnit(tx, unit);
  const traits = model
    ? movementTraitsForModel(model, crits)
    : parseShipTraits("");
  const speedCap = movementSpeedCap(unit, crits);
  const turnProfile = effectiveTurnProfile(unit, traits);
  const minMove = traits.superManeuverable ? 0 : speedCap > 0 ? Math.max(1, Math.ceil(effectiveBaseSpeed(unit, crits) / 2)) : 0;
  const novaBroadsideBias = model ? isNovaDreadnought(model, unit) : false;
  const shipAiProfile = shipAiProfileForModel(model);
  const lowHealth = lowHullRatio(unit) < (shipAiProfile === "apex-predator" ? 0.2 : 0.3);
  const enemies = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.ownerId, game.challengerId),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  const nearestByDistance = (enemies as Array<typeof gameUnitsTable.$inferSelect>)
    .map((enemy: typeof gameUnitsTable.$inferSelect) => ({ enemy, distance: centerDistance({ x: unit.hexQ, z: unit.hexR }, { x: enemy.hexQ, z: enemy.hexR }) }))
    .sort((a: { distance: number }, b: { distance: number }) => a.distance - b.distance)[0]?.enemy ?? null;
  let apexPrey: typeof gameUnitsTable.$inferSelect | null = null;
  let apexPreyBreakdown: Record<string, unknown> | null = null;
  if (shipAiProfile === "apex-predator") {
    const apexFootprint: UnitFootprint = {
      id: unit.id,
      ownerId: unit.ownerId,
      x: unit.hexQ,
      z: unit.hexR,
      baseRadiusInches: rulesBaseRadius(unit),
      isFighter: model ? shipModelIsFighter(model) : false,
    };
    let bestPrey: { enemy: typeof gameUnitsTable.$inferSelect; score: number; breakdown: Record<string, unknown> } | null = null;
    for (const enemy of enemies as Array<typeof gameUnitsTable.$inferSelect>) {
      const enemyModel = await getShipModelForUnit(tx, enemy);
      if (!enemyModel) continue;
      const enemyWeapons = await tx.select().from(weaponsTable).where(eq(weaponsTable.shipModelId, enemyModel.id));
      const enemyFootprint: UnitFootprint = {
        id: enemy.id,
        ownerId: enemy.ownerId,
        x: enemy.hexQ,
        z: enemy.hexR,
        baseRadiusInches: rulesBaseRadius(enemy),
        isFighter: shipModelIsFighter(enemyModel),
      };
      const currentThreatToApex = arcThreatAtPoint({
        ...enemyFootprint,
        heading: enemy.heading,
        flipped: FLIP_MODELS.has(enemy.modelFilename),
        weapons: enemyWeapons,
      }, apexFootprint);
      const scored = apexPredatorTargetScore({
        target: enemy,
        targetModel: enemyModel,
        targetWeapons: enemyWeapons,
        currentThreatToApex,
      });
      const distance = edgeDistance(apexFootprint, enemyFootprint);
      const distancePressure = distance > 30 ? -((distance - 30) * 1.1) : 0;
      const score = scored.score + distancePressure;
      const breakdown = {
        ...scored.breakdown,
        distance: Number(distance.toFixed(2)),
        distancePressure: Number(distancePressure.toFixed(2)),
        finalPreyScore: Number(score.toFixed(2)),
      };
      if (!bestPrey || score > bestPrey.score) {
        bestPrey = { enemy, score, breakdown };
      }
    }
    apexPrey = bestPrey?.enemy ?? null;
    apexPreyBreakdown = bestPrey?.breakdown ?? null;
  }
  const nearest = apexPrey ?? nearestByDistance;
  const targetPoint = nearest ? { x: nearest.hexQ, z: nearest.hexR } : {
    x: unit.hexQ + headingForwardVec(unit).x * Math.max(1, speedCap),
    z: unit.hexR + headingForwardVec(unit).z * Math.max(1, speedCap),
  };
  const newHeading = headingToPoint({ x: unit.hexQ, z: unit.hexR }, targetPoint);
  const headingRad = (newHeading * Math.PI) / 180;
  const movementDirection = { x: Math.sin(headingRad), z: Math.cos(headingRad) };
  const headingCandidates: AiMovementHeadingCandidate[] = [{ heading: normalizeHeadingDegrees(newHeading), label: shipAiProfile === "apex-predator" ? "apex-prey-approach" : "approach" }];
  if (nearest && (shipAiProfile === "broadside" || novaBroadsideBias)) {
    headingCandidates.push(
      { heading: normalizeHeadingDegrees(newHeading - 90), label: novaBroadsideBias ? "nova-port-broadside" : "profile-port-broadside" },
      { heading: normalizeHeadingDegrees(newHeading + 90), label: novaBroadsideBias ? "nova-starboard-broadside" : "profile-starboard-broadside" },
    );
  }
  if (nearest && shipAiProfile === "brawler") {
    headingCandidates.push(
      { heading: normalizeHeadingDegrees(newHeading - 30), label: "profile-close-port" },
      { heading: normalizeHeadingDegrees(newHeading + 30), label: "profile-close-starboard" },
    );
  }
  if (nearest && shipAiProfile === "apex-predator") {
    const escapeHeading = headingToPoint({ x: nearest.hexQ, z: nearest.hexR }, { x: unit.hexQ, z: unit.hexR });
    headingCandidates.push(
      { heading: normalizeHeadingDegrees(newHeading - 45), label: "apex-slice-port" },
      { heading: normalizeHeadingDegrees(newHeading + 45), label: "apex-slice-starboard" },
      { heading: normalizeHeadingDegrees(newHeading - 90), label: "apex-lateral-port" },
      { heading: normalizeHeadingDegrees(newHeading + 90), label: "apex-lateral-starboard" },
      { heading: normalizeHeadingDegrees(escapeHeading - 35), label: "apex-shield-rhythm-port" },
      { heading: normalizeHeadingDegrees(escapeHeading + 35), label: "apex-shield-rhythm-starboard" },
    );
  }
  if (nearest && shipAiProfile === "jouster") {
    headingCandidates.push(
      { heading: normalizeHeadingDegrees(unit.heading), label: "profile-hold-line" },
      { heading: normalizeHeadingDegrees(newHeading - 15), label: "profile-joust-port" },
      { heading: normalizeHeadingDegrees(newHeading + 15), label: "profile-joust-starboard" },
    );
  }
  if (nearest && shipAiProfile === "standoff") {
    const escapeHeading = headingToPoint({ x: nearest.hexQ, z: nearest.hexR }, { x: unit.hexQ, z: unit.hexR });
    headingCandidates.push(
      { heading: normalizeHeadingDegrees(escapeHeading), label: "profile-kite" },
      { heading: normalizeHeadingDegrees(escapeHeading - 45), label: "profile-kite-port" },
      { heading: normalizeHeadingDegrees(escapeHeading + 45), label: "profile-kite-starboard" },
      { heading: normalizeHeadingDegrees(newHeading - 90), label: "profile-standoff-port" },
      { heading: normalizeHeadingDegrees(newHeading + 90), label: "profile-standoff-starboard" },
    );
  }
  if (nearest && lowHealth) {
    const escapeHeading = headingToPoint({ x: nearest.hexQ, z: nearest.hexR }, { x: unit.hexQ, z: unit.hexR });
    headingCandidates.push(
      { heading: normalizeHeadingDegrees(escapeHeading), label: "low-health-retreat" },
      { heading: normalizeHeadingDegrees(escapeHeading - 45), label: "low-health-retreat-port" },
      { heading: normalizeHeadingDegrees(escapeHeading + 45), label: "low-health-retreat-starboard" },
    );
  }
  const edgeRecoveryNeeded = shouldAddEdgeRecoveryHeading(unit, speedCap, minMove);
  if (edgeRecoveryNeeded) {
    const centerHeading = headingToPoint({ x: unit.hexQ, z: unit.hexR }, { x: 0, z: 0 });
    headingCandidates.push(
      { heading: normalizeHeadingDegrees(centerHeading), label: "edge-recovery-center" },
      { heading: normalizeHeadingDegrees(centerHeading - 45), label: "edge-recovery-port" },
      { heading: normalizeHeadingDegrees(centerHeading + 45), label: "edge-recovery-starboard" },
    );
  }
  headingCandidates.push({ heading: normalizeHeadingDegrees(unit.heading), label: "current-heading" });
  const dedupedHeadingCandidates = Array.from(
    new Map(headingCandidates.map(candidate => [candidate.heading, candidate])).values(),
  );
  const availableDistance = nearest
    ? Math.max(0, centerDistance({ x: unit.hexQ, z: unit.hexR }, targetPoint) - rulesBaseRadius(unit) - rulesBaseRadius(nearest) - 1)
    : speedCap;
  const desiredDistance = Math.min(speedCap, Math.max(minMove, availableDistance));
  const idealRequested = {
    x: Math.max(BOARD_MIN_X, Math.min(BOARD_MAX_X, unit.hexQ + movementDirection.x * desiredDistance)),
    z: Math.max(BOARD_MIN_Z, Math.min(BOARD_MAX_Z, unit.hexR + movementDirection.z * desiredDistance)),
  };

  const blockers = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  const blockerFootprints: UnitFootprint[] = [];
  const enemyThreats: AiEnemyThreat[] = [];
  for (const other of blockers) {
    if (other.id === unit.id) continue;
    const otherModel = await getShipModelForUnit(tx, other);
    const footprint: UnitFootprint = {
      id: other.id,
      ownerId: other.ownerId,
      x: other.hexQ,
      z: other.hexR,
      baseRadiusInches: rulesBaseRadius(other),
      isFighter: otherModel ? shipModelIsFighter(otherModel) : false,
    };
    blockerFootprints.push(footprint);
    if (other.ownerId === game.challengerId && otherModel) {
      const enemyWeapons = await tx.select().from(weaponsTable).where(eq(weaponsTable.shipModelId, otherModel.id));
      enemyThreats.push({
        ...footprint,
        heading: other.heading,
        flipped: FLIP_MODELS.has(other.modelFilename),
        weapons: enemyWeapons,
      });
    }
  }
  const movingFootprint: UnitFootprint = {
    id: unit.id,
    ownerId: unit.ownerId,
    x: unit.hexQ,
    z: unit.hexR,
    isFighter: model ? shipModelIsFighter(model) : false,
    baseRadiusInches: rulesBaseRadius(unit),
  };
  const nearestFootprint = nearest
    ? blockerFootprints.find(blocker => blocker.id === nearest.id) ?? null
    : null;
  const ownWeapons = model ? await tx.select().from(weaponsTable).where(eq(weaponsTable.shipModelId, model.id)) : [];
  const legalPlans = buildLegalAiMovementPlans(
    unit,
    crits,
    traits,
    speedCap,
    minMove,
    turnProfile,
    movingFootprint,
    blockerFootprints,
    nearestFootprint,
    dedupedHeadingCandidates,
    ownWeapons,
    FLIP_MODELS.has(unit.modelFilename),
    enemyThreats,
    lowHealth,
    novaBroadsideBias,
    shipAiProfile,
  );
  const selectedPlan = legalPlans[0] ?? null;
  const finalX = selectedPlan?.x ?? snapBoardCoord(unit.hexQ);
  const finalZ = selectedPlan?.z ?? snapBoardCoord(unit.hexR);
  const moved = selectedPlan?.moved ?? 0;
  const finalHeading = selectedPlan?.heading ?? normalizeHeadingDegrees(unit.heading);
  const movementDetails = {
    unit: { id: unit.id, name: unit.name, from: { x: unit.hexQ, z: unit.hexR }, heading: unit.heading },
    nearestEnemy: nearest ? { id: nearest.id, name: nearest.name, x: nearest.hexQ, z: nearest.hexR } : null,
    nearestByDistance: nearestByDistance ? { id: nearestByDistance.id, name: nearestByDistance.name, x: nearestByDistance.hexQ, z: nearestByDistance.hexR } : null,
    apexPrey: apexPrey ? { id: apexPrey.id, name: apexPrey.name, x: apexPrey.hexQ, z: apexPrey.hexR, breakdown: apexPreyBreakdown } : null,
    lowHealth,
    shipAiProfile,
    novaBroadsideBias,
    speedCap,
    minMove,
    turnProfile,
    maxAiHeadingDelta: turnProfile.turnsForbidden ? 0 : turnProfile.maxTurns * turnProfile.turnAngle,
    headingDeltaApplied: headingDeltaDegrees(unit.heading, finalHeading),
    availableDistance: Number(availableDistance.toFixed(3)),
    desiredDistance: Number(desiredDistance.toFixed(3)),
    idealRequested: { x: Number(idealRequested.x.toFixed(3)), z: Number(idealRequested.z.toFixed(3)), heading: newHeading },
    headingCandidates: dedupedHeadingCandidates,
    generatedLegalPlanCount: legalPlans.length,
    boardEdgeClearance: Number(boardEdgeClearance({ x: unit.hexQ, z: unit.hexR }).toFixed(3)),
    edgeRecoveryNeeded,
    topLegalPlans: legalPlans.slice(0, 5).map(plan => ({
      x: plan.x,
      z: plan.z,
      heading: plan.heading,
      moved: plan.moved,
      turns: plan.turns,
      headingLabel: plan.headingLabel,
      score: Number(plan.score.toFixed(2)),
      incomingThreat: Number(plan.incomingThreat.toFixed(2)),
      ownThreat: Number(plan.ownThreat.toFixed(2)),
      steps: plan.steps,
    })),
    chosenManeuver: selectedPlan ? {
      moved: selectedPlan.moved,
      turns: selectedPlan.turns,
      distanceSinceLastTurn: selectedPlan.distanceSinceLastTurn,
      steps: selectedPlan.steps,
    } : null,
    finalEndpoint: {
      x: finalX,
      z: finalZ,
      moved,
      heading: finalHeading,
      headingLabel: selectedPlan?.headingLabel ?? null,
      passOverAllowed: true,
      scoredAgainstTargetId: nearestFootprint?.id ?? null,
      incomingThreat: Number((selectedPlan?.incomingThreat ?? 0).toFixed(2)),
      ownThreat: Number((selectedPlan?.ownThreat ?? 0).toFixed(2)),
      sideArcThreat: Number((selectedPlan?.sideArcThreat ?? 0).toFixed(2)),
      forwardArcThreat: Number((selectedPlan?.forwardArcThreat ?? 0).toFixed(2)),
    },
  };

  if ((!selectedPlan || (minMove > 0 && moved + 1e-6 < minMove)) && unit.allStopReady && edgeRecoveryNeeded) {
    const pivotUnit = { ...unit, specialAction: "all-stop-pivot" };
    const pivotTurnProfile = effectiveTurnProfile(pivotUnit, traits);
    const pivotPlans = buildLegalAiMovementPlans(
      pivotUnit,
      crits,
      traits,
      0,
      0,
      pivotTurnProfile,
      movingFootprint,
      blockerFootprints,
      nearestFootprint,
      dedupedHeadingCandidates,
      ownWeapons,
      FLIP_MODELS.has(unit.modelFilename),
      enemyThreats,
      lowHealth,
      novaBroadsideBias,
      shipAiProfile,
    ).filter(plan => headingDeltaDegrees(unit.heading, plan.heading) > 1e-6);
    const pivotPlan = pivotPlans[0] ?? null;
    if (pivotPlan) {
      const [pivotedUnit] = await tx.update(gameUnitsTable).set({
        heading: pivotPlan.heading,
        specialAction: "all-stop-pivot",
        allStopReady: false,
        hasInitiatedMoveThisActivation: true,
        inchesMovedThisActivation: 0,
        distanceSinceLastTurnThisActivation: 0,
        turnsMadeThisActivation: pivotPlan.turns,
      }).where(and(eq(gameUnitsTable.id, unit.id), eq(gameUnitsTable.gameId, game.id))).returning();
      const pivotDetails = {
        ...movementDetails,
        generatedPivotPlanCount: pivotPlans.length,
        chosenPivot: {
          heading: pivotPlan.heading,
          headingLabel: pivotPlan.headingLabel,
          turns: pivotPlan.turns,
          score: Number(pivotPlan.score.toFixed(2)),
          steps: pivotPlan.steps,
        },
        chosenAction: "all-stop-pivot",
      };
      await recordMovementAuditLog(tx, {
        game,
        actorKind: "ai",
        actorPlayerId: AI_OPPONENT_ID,
        unitBefore: unit,
        unitAfter: pivotedUnit,
        movementKind: "turn",
        summary: `AI used All Stop and Pivot with ${unit.name} to recover from the board edge.`,
        payload: {
          rulesPath: "ai-movement",
          ...pivotDetails,
        },
      });
      const decision = aiDecision(
        "movement.all-stop-pivot-edge-recovery",
        "movement",
        `AI used All Stop and Pivot with ${unit.name} to recover from the board edge.`,
        pivotDetails,
        unit,
      );
      return finishAiActivation(tx, game, pivotedUnit, "movement", withAiDecisionLog(
        game.aiState,
        aiState("acted", "movement.all-stop-pivot-edge-recovery", {
          message: `AI used All Stop and Pivot with ${unit.name} to recover from the board edge.`,
          unitIds: [unit.id],
        }),
        decision,
      ));
    }
  }

  if (!selectedPlan || (minMove > 0 && moved + 1e-6 < minMove)) {
    const [stoppedUnit] = await tx.update(gameUnitsTable).set({
      specialAction: "all-stop",
      allStopReady: true,
      hasInitiatedMoveThisActivation: true,
      inchesMovedThisActivation: 0,
      distanceSinceLastTurnThisActivation: 0,
      turnsMadeThisActivation: 0,
    }).where(and(eq(gameUnitsTable.id, unit.id), eq(gameUnitsTable.gameId, game.id))).returning();
    await recordMovementAuditLog(tx, {
      game,
      actorKind: "ai",
      actorPlayerId: AI_OPPONENT_ID,
      unitBefore: unit,
      unitAfter: stoppedUnit,
      movementKind: "all-stop",
      summary: `AI declared All Stop with ${unit.name}; no legal movement endpoint was available.`,
      payload: {
        rulesPath: "ai-movement",
        ...movementDetails,
        reason: "no-legal-final-endpoint",
        chosenAction: "all-stop",
      },
    });
    const decision = aiDecision(
      "movement.all-stop-contact",
      "movement",
      `AI declared All Stop with ${unit.name}: no legal final endpoint satisfied the movement constraints.`,
      {
        ...movementDetails,
        reason: "no-legal-final-endpoint",
        chosenAction: "all-stop",
      },
      unit,
    );
    return finishAiActivation(tx, game, stoppedUnit, "movement", withAiDecisionLog(
      game.aiState,
      aiState("acted", "movement.all-stop-contact", {
        message: `AI declared All Stop with ${unit.name}; no legal final movement endpoint was available.`,
        unitIds: [unit.id],
      }),
      decision,
    ));
  }

  const [movedUnit] = await tx.update(gameUnitsTable).set({
    hexQ: finalX,
    hexR: finalZ,
    heading: finalHeading,
    hasInitiatedMoveThisActivation: true,
    inchesMovedThisActivation: moved,
    distanceSinceLastTurnThisActivation: selectedPlan.distanceSinceLastTurn,
    turnsMadeThisActivation: selectedPlan.turns,
    allStopReady: false,
  }).where(and(eq(gameUnitsTable.id, unit.id), eq(gameUnitsTable.gameId, game.id))).returning();
  await recordMovementAuditLog(tx, {
    game,
    actorKind: "ai",
    actorPlayerId: AI_OPPONENT_ID,
    unitBefore: unit,
    unitAfter: movedUnit,
    movementKind: "move",
    summary: `AI moved ${unit.name} ${moved.toFixed(1)}" toward ${nearest?.name ?? "open space"}.`,
    payload: {
      rulesPath: "ai-movement",
      ...movementDetails,
      chosenAction: "move",
    },
  });

  const decision = aiDecision(
    "movement.move-and-end",
    "movement",
    `AI moved ${unit.name} ${moved.toFixed(1)}" toward ${nearest?.name ?? "open space"}.`,
    {
      ...movementDetails,
      chosenAction: "move",
    },
    unit,
  );
  return finishAiActivation(tx, game, movedUnit, "movement", withAiDecisionLog(
    game.aiState,
    aiState("acted", "movement.move-and-end", {
      message: `AI moved ${unit.name} ${moved.toFixed(1)}" toward ${nearest?.name ?? "open space"}.`,
      unitIds: [unit.id],
    }),
    decision,
  ));
}

type AiFirePlan = {
  weapon: typeof weaponsTable.$inferSelect;
  target: typeof gameUnitsTable.$inferSelect;
  distance: number;
  score: number;
  breakdown: Record<string, unknown>;
  topCandidates: AiFireCandidateLog[];
  rejected: AiFireRejectionLog[];
};

type AiFireCandidateLog = {
  weaponId: number;
  weaponName: string;
  targetId: number;
  targetName: string;
  distance: number;
  score: number;
  breakdown: Record<string, unknown>;
};

type AiFireRejectionLog = {
  weaponId?: number;
  weaponName?: string;
  targetId?: number;
  targetName?: string;
  reason: string;
};

function clampProbability(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function estimateHitChance(hitThreshold: number, traits: ReturnType<typeof parseWeaponTraits>): number {
  const base = clampProbability((7 - hitThreshold) / 6);
  if (traits.twinLinked) return 1 - ((1 - base) * (1 - base));
  return base;
}

async function chooseAiFirePlan(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  attacker: typeof gameUnitsTable.$inferSelect,
): Promise<AiFirePlan | null> {
  if (attacker.isDestroyed || attacker.hullPoints <= 0 || (attacker.maxCrewPoints > 0 && attacker.crewPoints <= 0)) return null;
  const rawAction = attacker.specialAction ?? "";
  const baseAction = rawAction.replace(/-failed$/, "");
  if (baseAction === "run-silent") return null;

  const alreadyFired = (attacker.firedWeaponIds ?? []) as number[];
  if ((baseAction === "blast-doors" || baseAction === "all-stop-pivot" || attacker.oneWeaponThisRound) && alreadyFired.length >= 1) {
    return null;
  }

  const [attackerShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, attacker.shipId));
  if (!attackerShip) return null;
  const [attackerModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, attackerShip.shipModelId));
  if (!attackerModel) return null;
  const attackerAiProfile = shipAiProfileForModel(attackerModel);
  const attackerCritRows = await tx.select().from(unitCriticalEffectsTable)
    .where(eq(unitCriticalEffectsTable.gameUnitId, attacker.id));
  const attackerCrits = deriveCritEffects((attackerCritRows as Array<typeof unitCriticalEffectsTable.$inferSelect>).map(r => ({
    effectKey: r.effectKey,
    randomArc: r.randomArc,
    randomWeaponId: r.randomWeaponId,
    lostTraits: r.lostTraits ?? [],
  })));
  const attackerTraits = parseShipTraits(filterLostTraits(attackerModel.traits, attackerCrits.lostTraitNames));
  if (skeletonPenaltiesApply(attacker, attackerTraits) && alreadyFired.length >= 1) return null;
  const priorWeapons = alreadyFired.length > 0
    ? await tx.select().from(weaponsTable).where(inArray(weaponsTable.id, alreadyFired))
    : [];

  const weapons = await tx.select().from(weaponsTable).where(eq(weaponsTable.shipModelId, attackerShip.shipModelId));
  const targets = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.ownerId, game.challengerId),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  const aPos = hexToWorld(attacker.hexQ, attacker.hexR);
  if (shipModelIsFighter(attackerModel)) {
    const attackerFootprint: UnitFootprint = {
      id: attacker.id,
      ownerId: attacker.ownerId,
      x: aPos.x,
      z: aPos.z,
      baseRadiusInches: rulesBaseRadius(attacker),
      isFighter: true,
    };
    const enemyFighterFootprints: UnitFootprint[] = [];
    for (const target of targets as Array<typeof gameUnitsTable.$inferSelect>) {
      const [targetShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, target.shipId));
      if (!targetShip) continue;
      const [targetModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, targetShip.shipModelId));
      if (!targetModel || !shipModelIsFighter(targetModel)) continue;
      enemyFighterFootprints.push({
        id: target.id,
        ownerId: target.ownerId,
        x: target.hexQ,
        z: target.hexR,
        baseRadiusInches: rulesBaseRadius(target),
        isFighter: true,
      });
    }
    if (enemyFighterContacts(attackerFootprint, enemyFighterFootprints).length > 0) return null;
  }
  const flipped = FLIP_MODELS.has(attacker.modelFilename);
  const plans: AiFirePlan[] = [];
  const candidates: AiFireCandidateLog[] = [];
  const rejected: AiFireRejectionLog[] = [];

  for (const weapon of weapons as Array<typeof weaponsTable.$inferSelect>) {
    if (alreadyFired.includes(weapon.id)) {
      rejected.push({ weaponId: weapon.id, weaponName: weapon.name, reason: "weapon-already-fired" });
      continue;
    }
    if (attackerCrits.forbiddenWeaponIds.has(weapon.id)) {
      rejected.push({ weaponId: weapon.id, weaponName: weapon.name, reason: "weapon-disabled-by-critical" });
      continue;
    }
    if (attackerCrits.forbiddenArcs.has(weapon.arc)) {
      rejected.push({ weaponId: weapon.id, weaponName: weapon.name, reason: "arc-disabled-by-critical" });
      continue;
    }
    if (isCrippledUnit(attacker) && priorWeapons.some((w: typeof weaponsTable.$inferSelect) => w.arc === weapon.arc)) {
      rejected.push({ weaponId: weapon.id, weaponName: weapon.name, reason: "crippled-arc-already-fired" });
      continue;
    }
    const wt = parseWeaponTraits(weapon.traits);
    if (wt.slowLoading) {
      const readyRound = normalizeSlowLoadingCooldowns(attacker.slowLoadingWeaponCooldowns, game.currentRound)[String(weapon.id)] ?? 0;
      if (game.currentRound < readyRound) {
        rejected.push({ weaponId: weapon.id, weaponName: weapon.name, reason: `slow-loading-ready-round-${readyRound}` });
        continue;
      }
    }

    for (const target of targets as Array<typeof gameUnitsTable.$inferSelect>) {
      const [targetShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, target.shipId));
      if (!targetShip) {
        rejected.push({ weaponId: weapon.id, weaponName: weapon.name, targetId: target.id, targetName: target.name, reason: "target-ship-record-missing" });
        continue;
      }
      const [targetModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, targetShip.shipModelId));
      if (!targetModel) {
        rejected.push({ weaponId: weapon.id, weaponName: weapon.name, targetId: target.id, targetName: target.name, reason: "target-model-record-missing" });
        continue;
      }
      if (shipModelIsFighter(targetModel) && await fighterIsLockedInDogfight(tx, game.id, target)) {
        rejected.push({ weaponId: weapon.id, weaponName: weapon.name, targetId: target.id, targetName: target.name, reason: "target-locked-in-dogfight" });
        continue;
      }
      const targetWeapons = attackerAiProfile === "apex-predator"
        ? await tx.select().from(weaponsTable).where(eq(weaponsTable.shipModelId, targetModel.id))
        : [];
      const tPos = hexToWorld(target.hexQ, target.hexR);
      const distance = fighterWeaponRangeDistance({
        id: attacker.id,
        ownerId: attacker.ownerId,
        x: aPos.x,
        z: aPos.z,
        baseRadiusInches: rulesBaseRadius(attacker),
        isFighter: shipModelIsFighter(attackerModel),
      }, {
        x: tPos.x,
        z: tPos.z,
        baseRadiusInches: rulesBaseRadius(target),
        isFighter: shipModelIsFighter(targetModel),
      });
      if (distance > weapon.range) {
        rejected.push({ weaponId: weapon.id, weaponName: weapon.name, targetId: target.id, targetName: target.name, reason: `out-of-range-${distance.toFixed(1)}-gt-${weapon.range}` });
        continue;
      }
      if (!isInArc({ x: aPos.x, z: aPos.z, headingDeg: attacker.heading, flipped }, tPos, weapon.arc)) {
        rejected.push({ weaponId: weapon.id, weaponName: weapon.name, targetId: target.id, targetName: target.name, reason: `not-in-${weapon.arc}-arc` });
        continue;
      }
      const { mult } = damageMultiplier(wt);
      const ad = effectiveAttackDice(weapon.attackDice, wt);
      const baseThreshold = (wt.beam || wt.miniBeam) ? 4 : targetModel.hullRating;
      const critFloor = attackerCrits.weaponsHitOn4 ? 4 : 0;
      const hitThreshold = Math.max(1, Math.max(baseThreshold, critFloor) - attackRollModifier(wt));
      const hitChance = estimateHitChance(hitThreshold, wt);
      const beamFactor = wt.beam ? 1.35 : 1;
      const expectedHits = ad * hitChance * beamFactor;
      const expectedDamage = expectedHits * mult;
      const targetDamageTaken = Math.max(0, target.maxHullPoints - target.hullPoints);
      const woundedBonus = targetDamageTaken * 0.45;
      const killBonus = expectedDamage >= target.hullPoints ? 90 : expectedDamage >= target.hullPoints * 0.65 ? 35 : 0;
      const crippleThreshold = printedDamageThreshold(target);
      const crippleBonus = target.hullPoints > crippleThreshold && target.hullPoints - expectedDamage <= crippleThreshold ? 28 : 0;
      const rangePenalty = distance * 0.08;
      const overkillPenalty = Math.max(0, expectedDamage - target.hullPoints) * 0.4;
      const slowLoadingPenalty = wt.slowLoading && killBonus === 0 ? 18 : 0;
      const novaSideArcBonus = isNovaDreadnought(attackerModel, attacker) && isSideArc(weapon.arc)
        ? expectedDamage * 5 + 18
        : 0;
      const profileArcBonus = attackerAiProfile === "broadside" && isSideArc(weapon.arc)
        ? expectedDamage * 2.5 + 8
        : attackerAiProfile === "jouster" && /forward/i.test(weapon.arc)
          ? expectedDamage * 2 + 6
          : attackerAiProfile === "standoff" && weapon.range >= 18
            ? expectedDamage * 1.5 + Math.max(0, distance - 8) * 0.35
            : 0;
      const brawlerRangeBonus = attackerAiProfile === "brawler" && distance <= 8
        ? expectedDamage * 1.2 + 4
        : 0;
      const apexPredator = attackerAiProfile === "apex-predator"
        ? apexPredatorTargetScore({
          target,
          targetModel,
          targetWeapons,
          currentThreatToApex: arcThreatAtPoint({
            id: target.id,
            ownerId: target.ownerId,
            x: target.hexQ,
            z: target.hexR,
            baseRadiusInches: rulesBaseRadius(target),
            isFighter: shipModelIsFighter(targetModel),
            heading: target.heading,
            flipped: FLIP_MODELS.has(target.modelFilename),
            weapons: targetWeapons,
          }, {
            x: attacker.hexQ,
            z: attacker.hexR,
            baseRadiusInches: rulesBaseRadius(attacker),
          }),
          expectedDamage,
          killBonus,
          crippleBonus,
        })
        : null;
      const apexPredatorBonus = apexPredator ? apexPredator.score * 0.75 : 0;
      const score =
        expectedDamage * 14 +
        expectedHits * 4 +
        woundedBonus +
        killBonus +
        novaSideArcBonus +
        profileArcBonus +
        brawlerRangeBonus +
        apexPredatorBonus +
        crippleBonus -
        rangePenalty -
        overkillPenalty -
        slowLoadingPenalty;
      const breakdown = {
        attackDice: ad,
        damageMultiplier: mult,
        hitThreshold,
        hitChance: Number(hitChance.toFixed(3)),
        expectedHits: Number(expectedHits.toFixed(2)),
        expectedDamage: Number(expectedDamage.toFixed(2)),
        targetHull: target.hullPoints,
        targetMaxHull: target.maxHullPoints,
        targetDamageTaken,
        woundedBonus: Number(woundedBonus.toFixed(2)),
        killBonus,
        crippleBonus,
        novaSideArcBonus: Number(novaSideArcBonus.toFixed(2)),
        profileArcBonus: Number(profileArcBonus.toFixed(2)),
        brawlerRangeBonus: Number(brawlerRangeBonus.toFixed(2)),
        apexPredatorBonus: Number(apexPredatorBonus.toFixed(2)),
        apexPredatorBreakdown: apexPredator?.breakdown ?? null,
        attackerAiProfile,
        rangePenalty: Number(rangePenalty.toFixed(2)),
        overkillPenalty: Number(overkillPenalty.toFixed(2)),
        slowLoadingPenalty,
      };
      const candidate = {
        weaponId: weapon.id,
        weaponName: weapon.name,
        targetId: target.id,
        targetName: target.name,
        distance: Number(distance.toFixed(2)),
        score: Number(score.toFixed(2)),
        breakdown,
      };
      candidates.push(candidate);
      plans.push({ weapon, target, distance, score, breakdown, topCandidates: [], rejected: [] });
    }
  }

  plans.sort((a, b) => b.score - a.score || a.target.hullPoints - b.target.hullPoints || a.distance - b.distance);
  candidates.sort((a, b) => b.score - a.score || a.distance - b.distance);
  const selected = plans[0] ?? null;
  if (!selected) return null;
  return {
    ...selected,
    topCandidates: candidates.slice(0, 5),
    rejected: rejected.slice(-12),
  };
}

async function resolveBasicAiWeaponFire(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  attacker: typeof gameUnitsTable.$inferSelect,
  weapon: typeof weaponsTable.$inferSelect,
  target: typeof gameUnitsTable.$inferSelect,
): Promise<{
  target: typeof gameUnitsTable.$inferSelect;
  hits: number;
  remainingHits: number;
  finalDamage: number;
  finalCrewLost: number;
  shieldedHits: number;
  targetDestroyed: boolean;
  fighterRecovery: DestroyedFighterRecoveryResult | null;
  winnerId: string | null;
  gameCompleted: boolean;
}> {
  const [attackerShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, attacker.shipId));
  if (!attackerShip) throw new Error("AI attacker ship record missing");
  const [attackerModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, attackerShip.shipModelId));
  if (!attackerModel) throw new Error("AI attacker ship model missing");
  const [targetShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, target.shipId));
  if (!targetShip) throw new Error("AI target ship record missing");
  const [targetModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, targetShip.shipModelId));
  if (!targetModel) throw new Error("AI target ship model missing");
  if (shipModelIsFighter(targetModel) && await fighterIsLockedInDogfight(tx, game.id, target)) {
    throw new Error("AI target fighter is locked in a dogfight and cannot be attacked by normal weapons");
  }

  const attackerCritRows = await tx.select().from(unitCriticalEffectsTable)
    .where(eq(unitCriticalEffectsTable.gameUnitId, attacker.id));
  const attackerCrits = deriveCritEffects((attackerCritRows as Array<typeof unitCriticalEffectsTable.$inferSelect>).map(r => ({
    effectKey: r.effectKey,
    randomArc: r.randomArc,
    randomWeaponId: r.randomWeaponId,
    lostTraits: r.lostTraits ?? [],
  })));
  const targetCritRows = await tx.select().from(unitCriticalEffectsTable)
    .where(eq(unitCriticalEffectsTable.gameUnitId, target.id));
  const targetCrits = deriveCritEffects((targetCritRows as Array<typeof unitCriticalEffectsTable.$inferSelect>).map(r => ({
    effectKey: r.effectKey,
    randomArc: r.randomArc,
    randomWeaponId: r.randomWeaponId,
    lostTraits: r.lostTraits ?? [],
  })));

  const wt = parseWeaponTraits(weapon.traits);
  const targetTraits = parseShipTraits(filterLostTraits(targetModel.traits, targetCrits.lostTraitNames));
  const targetEffectiveDamageState = effectiveDamageState(target.damageState, targetCritRows);
  const targetCrippled = isCrippledUnit(target);
  const aPos = hexToWorld(attacker.hexQ, attacker.hexR);
  const tPos = hexToWorld(target.hexQ, target.hexR);
  const distance = fighterWeaponRangeDistance({
    id: attacker.id,
    ownerId: attacker.ownerId,
    x: aPos.x,
    z: aPos.z,
    baseRadiusInches: rulesBaseRadius(attacker),
    isFighter: shipModelIsFighter(attackerModel),
  }, {
    x: tPos.x,
    z: tPos.z,
    baseRadiusInches: rulesBaseRadius(target),
    isFighter: shipModelIsFighter(targetModel),
  });
  if (shipModelIsFighter(attackerModel)) {
    const liveEnemies = await tx.select().from(gameUnitsTable).where(and(
      eq(gameUnitsTable.gameId, game.id),
      eq(gameUnitsTable.isDestroyed, false),
    ));
    const attackerFootprint: UnitFootprint = {
      id: attacker.id,
      ownerId: attacker.ownerId,
      x: aPos.x,
      z: aPos.z,
      baseRadiusInches: rulesBaseRadius(attacker),
      isFighter: true,
    };
    const contacts: UnitFootprint[] = [];
    for (const live of liveEnemies) {
      if (live.id === attacker.id || live.ownerId === attacker.ownerId) continue;
      const [liveShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, live.shipId));
      if (!liveShip) continue;
      const [liveModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, liveShip.shipModelId));
      if (!liveModel || !shipModelIsFighter(liveModel)) continue;
      contacts.push({
        id: live.id,
        ownerId: live.ownerId,
        x: live.hexQ,
        z: live.hexR,
        baseRadiusInches: rulesBaseRadius(live),
        isFighter: true,
      });
    }
    if (enemyFighterContacts(attackerFootprint, contacts).length > 0) {
      throw new Error("AI fighter is locked in a dogfight and cannot fire normal weapons");
    }
  }

  const rawAction = attacker.specialAction ?? "";
  const baseAction = rawAction.replace(/-failed$/, "");
  const weaponAd = effectiveAttackDice(weapon.attackDice, wt);
  const adAfterCrits = Math.max(1, weaponAd + attackerCrits.allWeaponsAdMod);
  const finalAttackDice = baseAction === "intensify-defense" ? Math.max(1, Math.floor(adAfterCrits / 2)) : adAfterCrits;
  const baseThreshold = (wt.beam || wt.miniBeam) ? 4 : targetModel.hullRating;
  const critFloor = attackerCrits.weaponsHitOn4 ? 4 : 0;
  const hitThreshold = Math.max(1, Math.max(baseThreshold, critFloor) - attackRollModifier(wt));

  let stealthPassed = true;
  let stealthTarget: number | null = null;
  let stealthRoll: number | null = null;
  if (targetTraits.stealth > 0 && !wt.energyMine) {
    stealthTarget = stealthFloor(targetTraits.stealth, distance);
    stealthRoll = rollD6();
    stealthPassed = stealthRoll >= stealthTarget || stealthRoll === 6;
  }
  const stealthFailWastedSlowLoading = !stealthPassed && (wt.slowLoading || wt.oneShot);

  const interceptorAttempts: { rolls: number[]; threshold: number; success: boolean }[] = [];
  let interceptorRemaining = targetCrippled ? 0 : Math.min(target.interceptorDiceRemaining, targetTraits.interceptors);
  let interceptorThreshold = target.interceptorThresholdCurrent;
  let attackDiceAfterInterceptors = finalAttackDice;
  const interceptorsBypassed = wt.beam || wt.miniBeam || wt.massDriver || wt.energyMine;
  if (stealthPassed && !interceptorsBypassed && interceptorRemaining > 0) {
    const diceToAttempt = attackDiceAfterInterceptors;
    for (let ad = 0; ad < diceToAttempt; ad++) {
      if (interceptorRemaining <= 0 || attackDiceAfterInterceptors <= 0) break;
      const rolls: number[] = [];
      let anySuccess = false;
      let onesRolled = 0;
      for (let i = 0; i < interceptorRemaining; i++) {
        const d = rollD6();
        rolls.push(d);
        if (d >= interceptorThreshold) anySuccess = true;
        if (d === 1) onesRolled++;
      }
      interceptorAttempts.push({ rolls, threshold: interceptorThreshold, success: anySuccess });
      if (anySuccess) attackDiceAfterInterceptors--;
      interceptorRemaining = Math.max(0, interceptorRemaining - onesRolled);
      if (interceptorRemaining > 0) {
        interceptorThreshold = Math.min(6, interceptorThreshold + onesRolled);
        if (interceptorRemaining === 1) interceptorThreshold = 6;
      }
    }
  }

  let hits = 0;
  const attackRolls: number[] = [];
  const attackRollKinds: ("normal" | "twin-reroll" | "explosion")[] = [];
  const EXPLODE_CAP_PER_DIE = 100;
  for (let i = 0; stealthPassed && i < attackDiceAfterInterceptors; i++) {
    let roll = rollD6();
    attackRolls.push(roll);
    attackRollKinds.push("normal");
    let hit = roll >= hitThreshold;
    if (!hit && wt.twinLinked) {
      roll = rollD6();
      attackRolls.push(roll);
      attackRollKinds.push("twin-reroll");
      hit = roll >= hitThreshold;
    }
    if (hit) hits++;
    if (wt.beam) {
      let chain = 0;
      while (roll >= hitThreshold && chain < EXPLODE_CAP_PER_DIE) {
        roll = rollD6();
        attackRolls.push(roll);
        attackRollKinds.push("explosion");
        if (roll >= hitThreshold) hits++;
        chain++;
      }
    }
  }

  let remainingHits = hits;
  const targetAction = (target.specialAction ?? "").replace(/-failed$/, "");
  const targetHeldStation = targetAction === "all-stop" || targetAction === "all-stop-pivot";
  const targetCanManeuver =
    target.hasMovedThisRound
    && !targetHeldStation
    && targetEffectiveDamageState !== "adrift"
    && targetEffectiveDamageState !== "exploding-end-of-next"
    && target.hullPoints > 0
    && (target.maxCrewPoints === 0 || target.crewPoints > 0);
  const dodgeRolls: number[] = [];
  let dodgesSuccessful = 0;
  if (targetTraits.dodge > 0 && !wt.accurate && !wt.energyMine && targetCanManeuver) {
    for (let i = 0; i < remainingHits; i++) {
      const d = rollD6();
      dodgeRolls.push(d);
      if (d >= targetTraits.dodge) dodgesSuccessful++;
    }
    remainingHits = Math.max(0, remainingHits - dodgesSuccessful);
  }

  const targetIsFighter = shipModelIsFighter(targetModel);
  const fighterOneHitDestroyed = targetIsFighter && remainingHits > 0;
  const { mult, bulkheadFloor } = damageMultiplier(wt);
  let shieldsCurrent = targetCrippled ? 0 : target.shieldsCurrent;
  let shieldedHits = 0;
  if (!fighterOneHitDestroyed && !wt.massDriver && !wt.energyMine && shieldsCurrent > 0 && remainingHits > 0) {
    while (remainingHits > 0 && shieldsCurrent >= mult) {
      shieldsCurrent -= mult;
      shieldedHits++;
      remainingHits--;
    }
    if (remainingHits > 0 && shieldsCurrent > 0) shieldsCurrent = 0;
  }

  let totalDamage = 0;
  let totalCrewLost = 0;
  const attackTableRolls: number[] = [];
  const attackTableModifiedRolls: number[] = [];
  let bulkheadHits = 0;
  let solidHits = 0;
  let criticalHits = 0;
  for (let i = 0; !fighterOneHitDestroyed && i < remainingHits; i++) {
    const d = rollD6();
    const tableRoll = Math.min(6, d + (wt.precise ? 1 : 0));
    attackTableRolls.push(d);
    attackTableModifiedRolls.push(tableRoll);
    if (tableRoll === 1) {
      bulkheadHits++;
      totalDamage += bulkheadFloor;
    } else {
      if (tableRoll >= 6) criticalHits++;
      else solidHits++;
      totalDamage += mult;
      totalCrewLost += mult;
    }
  }

  const gegReduction = wt.massDriver ? 0 : targetTraits.geg * remainingHits;
  let damageAfterGeg = Math.max(0, totalDamage - gegReduction);
  let crewAfterGeg = Math.max(0, totalCrewLost - gegReduction);
  if (fighterOneHitDestroyed) {
    damageAfterGeg = Math.max(damageAfterGeg, target.hullPoints);
    crewAfterGeg = 0;
  }
  if (targetTraits.adaptiveArmour && (damageAfterGeg > 0 || crewAfterGeg > 0)) {
    damageAfterGeg = damageAfterGeg > 0 ? Math.max(1, Math.floor(damageAfterGeg / 2)) : 0;
    crewAfterGeg = crewAfterGeg > 0 ? Math.max(1, Math.floor(crewAfterGeg / 2)) : 0;
  }
  let blastDoorsDamageSaved = 0;
  let blastDoorsCrewSaved = 0;
  const blastDoorsDamageRolls: number[] = [];
  const blastDoorsCrewRolls: number[] = [];
  if (target.specialAction === "blast-doors") {
    for (let i = 0; i < damageAfterGeg; i++) {
      const d = rollD6();
      blastDoorsDamageRolls.push(d);
      if (d >= 5) blastDoorsDamageSaved++;
    }
    for (let i = 0; i < crewAfterGeg; i++) {
      const d = rollD6();
      blastDoorsCrewRolls.push(d);
      if (d >= 5) blastDoorsCrewSaved++;
    }
    damageAfterGeg = Math.max(0, damageAfterGeg - blastDoorsDamageSaved);
    crewAfterGeg = Math.max(0, crewAfterGeg - blastDoorsCrewSaved);
  }

  const finalDamage = damageAfterGeg;
  const targetHasCrewTrack = target.maxCrewPoints > 0;
  const finalCrewLost = targetHasCrewTrack ? crewAfterGeg : 0;
  const targetHullAfter = Math.max(0, target.hullPoints - finalDamage);
  const targetCrewAfter = targetHasCrewTrack
    ? Math.max(0, target.crewPoints - finalCrewLost)
    : target.crewPoints;
  let nextDamageState = fighterOneHitDestroyed ? "destroyed" : target.damageState;
  let targetDestroyed = fighterOneHitDestroyed || target.isDestroyed;
  let damageTable: { overkill: number; roll: number; total: number; outcome: "adrift" | "destroyed" | "exploding-end-of-next" } | null = null;
  if (!fighterOneHitDestroyed && targetHullAfter === 0 && target.damageState === "normal" && !target.isDestroyed) {
    const overkill = Math.max(0, finalDamage - target.hullPoints);
    const roll = rollD6();
    const total = roll + overkill;
    if (total <= 6) {
      nextDamageState = "adrift";
      damageTable = { overkill, roll, total, outcome: "adrift" };
    } else if (total <= 11) {
      nextDamageState = "destroyed";
      targetDestroyed = true;
      damageTable = { overkill, roll, total, outcome: "destroyed" };
    } else {
      nextDamageState = "exploding-end-of-next";
      damageTable = { overkill, roll, total, outcome: "exploding-end-of-next" };
    }
  }
  if (targetHasCrewTrack && targetCrewAfter === 0 && nextDamageState === "normal" && !targetDestroyed) {
    nextDamageState = "adrift";
  }

  const targetWillBeCrippled = isCrippledUnit({
    ...target,
    hullPoints: targetHullAfter,
    isDestroyed: targetDestroyed,
  });
  const [updatedTarget] = await tx.update(gameUnitsTable).set({
    hullPoints: targetHullAfter,
    crewPoints: targetCrewAfter,
    shieldsCurrent: targetWillBeCrippled ? 0 : shieldsCurrent,
    interceptorDiceRemaining: targetWillBeCrippled ? 0 : interceptorRemaining,
    interceptorThresholdCurrent: targetWillBeCrippled ? 2 : interceptorThreshold,
    damageState: nextDamageState,
    isDestroyed: targetDestroyed,
  }).where(eq(gameUnitsTable.id, target.id)).returning();
  const fighterRecovery = targetDestroyed
    ? await resolveDestroyedFighterRecovery(tx, game, updatedTarget, "weapon")
    : null;

  const alreadyFired = (attacker.firedWeaponIds ?? []) as number[];
  if (!stealthFailWastedSlowLoading) {
    const nextSlowLoadingCooldowns = wt.slowLoading
      ? {
          ...normalizeSlowLoadingCooldowns(attacker.slowLoadingWeaponCooldowns, game.currentRound),
          [String(weapon.id)]: game.currentRound + 2,
        }
      : attacker.slowLoadingWeaponCooldowns;
    await tx.update(gameUnitsTable).set({
      firedWeaponIds: [...alreadyFired, weapon.id],
      slowLoadingWeaponCooldowns: nextSlowLoadingCooldowns,
    }).where(eq(gameUnitsTable.id, attacker.id));
  }

  if (hits > 0) {
    const prevHitters = (target.hitByUnitIdsThisRound ?? []) as number[];
    if (!prevHitters.includes(attacker.id)) {
      await tx.update(gameUnitsTable)
        .set({ hitByUnitIdsThisRound: [...prevHitters, attacker.id] })
        .where(eq(gameUnitsTable.id, target.id));
    }
  }

  const allUnits = await tx.select().from(gameUnitsTable).where(eq(gameUnitsTable.gameId, game.id));
  let challengerAlive = 0;
  let opponentAlive = 0;
  for (const u of allUnits as Array<typeof gameUnitsTable.$inferSelect>) {
    if (!unitCountsForVictory(u)) continue;
    if (u.ownerId === game.challengerId) challengerAlive++;
    else if (u.ownerId === game.opponentId) opponentAlive++;
  }
  let winnerId: string | null = null;
  let gameCompleted = false;
  if (game.opponentId && challengerAlive === 0 && opponentAlive > 0) {
    winnerId = game.opponentId;
    gameCompleted = true;
  } else if (game.opponentId && opponentAlive === 0 && challengerAlive > 0) {
    winnerId = game.challengerId;
    gameCompleted = true;
  } else if (game.opponentId && challengerAlive === 0 && opponentAlive === 0) {
    gameCompleted = true;
  }
  if (gameCompleted) {
    await tx.update(gamesTable)
      .set({ status: "completed", winnerId, activePlayerId: null, activeUnitId: null })
      .where(eq(gamesTable.id, game.id));
  }

  await recordAttackAuditLog(tx, {
    game,
    actorKind: "ai",
    actorPlayerId: AI_OPPONENT_ID,
    attacker,
    targetBefore: target,
    targetAfter: updatedTarget,
    weapon,
    summary: `AI ${attacker.name} fired ${weapon.name} at ${target.name}: ${hits} hit(s), ${finalDamage} damage, ${finalCrewLost} crew.`,
    payload: {
      rulesPath: "ai-basic",
      attackerModel: {
        id: attackerModel.id,
        name: attackerModel.name,
        traits: attackerModel.traits,
      },
      targetModel: {
        id: targetModel.id,
        name: targetModel.name,
        hullRating: targetModel.hullRating,
        traits: targetModel.traits,
      },
      distance: Number(distance.toFixed(3)),
      weaponTraits: weapon.traits,
      effectiveAttackDice: finalAttackDice,
      attackDiceAfterInterceptors,
      hitThreshold,
      stealthTarget,
      stealthRoll,
      stealthPassed,
      stealthFailWastedSlowLoading,
      attackRolls,
      attackRollKinds,
      interceptorsBypassed,
      interceptorAttempts,
      interceptorDiceBefore: targetCrippled ? 0 : Math.min(target.interceptorDiceRemaining, targetTraits.interceptors),
      interceptorDiceAfter: targetWillBeCrippled ? 0 : interceptorRemaining,
      interceptorThresholdAfter: targetWillBeCrippled ? 2 : interceptorThreshold,
      hits,
      dodgeRolls,
      dodgesSuccessful,
      remainingHits,
      shieldedHits,
      shieldsAfter: targetWillBeCrippled ? 0 : shieldsCurrent,
      attackTableRolls,
      attackTableModifiedRolls,
      bulkheadHits,
      solidHits,
      criticalHits,
      gegReduction,
      blastDoorsActive: target.specialAction === "blast-doors",
      blastDoorsDamageSaved,
      blastDoorsCrewSaved,
      blastDoorsDamageRolls,
      blastDoorsCrewRolls,
      damageMultiplier: mult,
      bulkheadFloor,
      finalDamage,
      finalCrewLost,
      targetHullAfter,
      targetCrewAfter,
      targetDestroyed,
      fighterRecovery,
      damageTable,
      winnerId,
      gameCompleted,
    },
  });

  return {
    target: updatedTarget,
    hits,
    remainingHits,
    finalDamage,
    finalCrewLost,
    shieldedHits,
    targetDestroyed,
    fighterRecovery,
    winnerId,
    gameCompleted,
  };
}

type AntiFighterRollLog = {
  attackerId: number;
  attackerName: string;
  targetId: number;
  targetName: string;
  die: number;
  bonus: number;
  total: number;
  targetHull: number;
  destroyed: boolean;
};

type AntiFighterAttackLog = {
  attackerId: number;
  attackerName: string;
  trait: "Anti-Fighter" | "Advanced Anti-Fighter";
  dice: number;
  bonus: number;
  eligibleTargetIds: number[];
  rolls: AntiFighterRollLog[];
  destroyedTargetIds: number[];
};

type AntiFighterPendingTarget = {
  targetUnitId: number;
  targetName: string;
  distance: number;
  hull: number;
};

type AntiFighterPendingAttacker = {
  attackerUnitId: number;
  attackerName: string;
  ownerId: string;
  trait: "Anti-Fighter" | "Advanced Anti-Fighter";
  dice: number;
  bonus: number;
  eligibleTargets: AntiFighterPendingTarget[];
};

type AntiFighterPendingState = {
  kind: "anti-fighter-allocation";
  round: number;
  currentPlayerId: string;
  pendingPlayerIds: string[];
  completedPlayerIds: string[];
  attackers: AntiFighterPendingAttacker[];
  lastResult?: {
    playerId: string;
    attacks: AntiFighterAttackLog[];
    destroyedUnitIds: number[];
    fighterRecoveries?: DestroyedFighterRecoveryResult[];
  };
};

type AntiFighterEntry = {
  unit: typeof gameUnitsTable.$inferSelect;
  model: typeof shipModelsTable.$inferSelect;
  traits: ParsedShipTraits;
  footprint: UnitFootprint;
};

type FighterAntiFighterInterruptResult = {
  attacks: AntiFighterAttackLog[];
  destroyedUnitIds: number[];
  fighterRecoveries: DestroyedFighterRecoveryResult[];
  movingUnitDestroyed: boolean;
};

async function antiFighterEntryForUnit(
  tx: any,
  unit: typeof gameUnitsTable.$inferSelect,
  footprintOverride?: Partial<UnitFootprint>,
): Promise<AntiFighterEntry | null> {
  const [ship] = await tx.select().from(shipsTable).where(eq(shipsTable.id, unit.shipId));
  if (!ship) return null;
  const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
  if (!model) return null;
  const critRows = await tx.select().from(unitCriticalEffectsTable)
    .where(eq(unitCriticalEffectsTable.gameUnitId, unit.id));
  const crits = deriveCritEffects((critRows as Array<typeof unitCriticalEffectsTable.$inferSelect>).map(r => ({
    effectKey: r.effectKey,
    randomArc: r.randomArc,
    randomWeaponId: r.randomWeaponId,
    lostTraits: r.lostTraits ?? [],
  })));
  return {
    unit,
    model,
    traits: parseShipTraits(filterLostTraits(model.traits, crits.lostTraitNames)),
    footprint: {
      id: unit.id,
      ownerId: unit.ownerId,
      x: unit.hexQ,
      z: unit.hexR,
      baseRadiusInches: rulesBaseRadius(unit),
      isFighter: shipModelIsFighter(model),
      ...footprintOverride,
    },
  };
}

function antiFighterDiceForEntry(entry: AntiFighterEntry): { dice: number; bonus: number; trait: "Anti-Fighter" | "Advanced Anti-Fighter" } | null {
  const advancedDice = Math.max(0, entry.traits.advancedAntiFighter);
  const standardDice = Math.max(0, entry.traits.antiFighter);
  const dice = advancedDice > 0 ? advancedDice : standardDice;
  if (dice <= 0) return null;
  return {
    dice,
    bonus: advancedDice > 0 ? 1 : 0,
    trait: advancedDice > 0 ? "Advanced Anti-Fighter" : "Anti-Fighter",
  };
}

async function resolveFighterAntiFighterDogfightInterrupt(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  movingUnit: typeof gameUnitsTable.$inferSelect,
  finalFootprint: UnitFootprint,
  contactedEnemyIds: number[],
  movingFinal: { hexQ: number; hexR: number; heading: number; actualStepInches: number },
): Promise<FighterAntiFighterInterruptResult | null> {
  const movingEntry = await antiFighterEntryForUnit(tx, movingUnit, finalFootprint);
  if (!movingEntry?.footprint.isFighter || contactedEnemyIds.length === 0) return null;

  const contactedRows = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, game.id),
    inArray(gameUnitsTable.id, contactedEnemyIds),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  const contactedEntries: AntiFighterEntry[] = [];
  for (const row of contactedRows as Array<typeof gameUnitsTable.$inferSelect>) {
    if (row.ownerId === movingUnit.ownerId) continue;
    const entry = await antiFighterEntryForUnit(tx, row);
    if (!entry?.footprint.isFighter) continue;
    if (!basesInContact(finalFootprint, entry.footprint)) continue;
    contactedEntries.push(entry);
  }
  if (contactedEntries.length === 0) return null;

  const attacks: AntiFighterAttackLog[] = [];
  const addAttack = (attackerEntry: AntiFighterEntry, targetEntry: AntiFighterEntry) => {
    const af = antiFighterDiceForEntry(attackerEntry);
    if (!af) return;
    const targetHull = targetEntry.model.hullRating ?? targetEntry.model.hull ?? targetEntry.unit.maxHullPoints;
    const rolls: AntiFighterRollLog[] = [];
    for (let i = 0; i < af.dice; i++) {
      const die = rollD6();
      const total = die + af.bonus;
      rolls.push({
        attackerId: attackerEntry.unit.id,
        attackerName: attackerEntry.unit.name,
        targetId: targetEntry.unit.id,
        targetName: targetEntry.unit.name,
        die,
        bonus: af.bonus,
        total,
        targetHull,
        destroyed: total >= targetHull,
      });
    }
    attacks.push({
      attackerId: attackerEntry.unit.id,
      attackerName: attackerEntry.unit.name,
      trait: af.trait,
      dice: af.dice,
      bonus: af.bonus,
      eligibleTargetIds: [targetEntry.unit.id],
      rolls,
      destroyedTargetIds: rolls.some(roll => roll.destroyed) ? [targetEntry.unit.id] : [],
    });
  };

  for (const defenderEntry of contactedEntries) {
    addAttack(defenderEntry, movingEntry);
  }
  const movingTarget = [...contactedEntries].sort((a, b) =>
    (a.model.hullRating ?? a.model.hull ?? a.unit.maxHullPoints) - (b.model.hullRating ?? b.model.hull ?? b.unit.maxHullPoints)
    || a.unit.id - b.unit.id
  )[0];
  if (movingTarget) addAttack(movingEntry, movingTarget);
  if (attacks.length === 0) return null;

  const destroyedUnitIds = [...new Set(attacks.flatMap(attack => attack.destroyedTargetIds))];
  const fighterRecoveries: DestroyedFighterRecoveryResult[] = [];
  for (const targetId of destroyedUnitIds) {
    const targetEntry = targetId === movingUnit.id
      ? movingEntry
      : contactedEntries.find(entry => entry.unit.id === targetId);
    if (!targetEntry) continue;
    const destroyedPatch = targetId === movingUnit.id
      ? {
          hexQ: movingFinal.hexQ,
          hexR: movingFinal.hexR,
          heading: movingFinal.heading,
          hasInitiatedMoveThisActivation: true,
          inchesMovedThisActivation: movingUnit.inchesMovedThisActivation + movingFinal.actualStepInches,
          allStopReady: false,
        }
      : {};
    await tx.update(gameUnitsTable).set({
      ...destroyedPatch,
      hullPoints: 0,
      crewPoints: 0,
      shieldsCurrent: 0,
      interceptorDiceRemaining: 0,
      damageState: "destroyed",
      isDestroyed: true,
    }).where(eq(gameUnitsTable.id, targetId));
    const recovery = await resolveDestroyedFighterRecovery(tx, game, {
      ...targetEntry.unit,
      ...destroyedPatch,
      hullPoints: 0,
      crewPoints: 0,
      shieldsCurrent: 0,
      interceptorDiceRemaining: 0,
      damageState: "destroyed",
      isDestroyed: true,
    }, "anti-fighter");
    if (recovery) fighterRecoveries.push(recovery);
  }

  const result: FighterAntiFighterInterruptResult = {
    attacks,
    destroyedUnitIds,
    fighterRecoveries,
    movingUnitDestroyed: destroyedUnitIds.includes(movingUnit.id),
  };
  await recordAntiFighterAuditLog(tx, {
    game,
    actorKind: "system",
    actorPlayerId: null,
    playerId: movingUnit.ownerId,
    context: "fighter-anti-fighter-interrupt",
    attacks,
    destroyedUnitIds,
    fighterRecoveries,
    summary: `Pre-dogfight Anti-Fighter resolved: ${attacks.reduce((sum, attack) => sum + attack.rolls.length, 0)} dice, ${destroyedUnitIds.length} fighter flight(s) destroyed.`,
  });
  await tx.update(gamesTable).set({
    aiState: mergeAiState(game.aiState, aiState("acted", "rules.fighter-anti-fighter-interrupt", {
      message: `Pre-dogfight fighter Anti-Fighter resolved: ${destroyedUnitIds.length} fighter flight(s) destroyed.`,
      lastAntiFighter: {
        playerId: movingUnit.ownerId,
        attacks,
        destroyedUnitIds,
        fighterRecoveries,
      },
    })),
  }).where(eq(gamesTable.id, game.id));

  return result;
}

function isMinbariEntry(entry: AntiFighterEntry): boolean {
  return /minbari/i.test(entry.model.faction ?? "")
    || /minbari/i.test(entry.unit.faction ?? "");
}

function hasWebOfDeathEscort(entry: AntiFighterEntry, entries: AntiFighterEntry[]): boolean {
  if (entry.footprint.isFighter || !isMinbariEntry(entry)) return false;
  return entries.some(other =>
    other.unit.id !== entry.unit.id
    && !other.footprint.isFighter
    && other.unit.ownerId === entry.unit.ownerId
    && isMinbariEntry(other)
    && antiFighterRangeDistance(entry.footprint, other.footprint) <= 4 + 1e-6
  );
}

function escortProtectedAllies(entry: AntiFighterEntry, entries: AntiFighterEntry[]): AntiFighterEntry[] {
  const protectedAllies: AntiFighterEntry[] = [];
  if (entry.traits.escort) {
    protectedAllies.push(...entries.filter(other =>
      other.unit.id !== entry.unit.id
      && other.unit.ownerId === entry.unit.ownerId
      && antiFighterRangeDistance(entry.footprint, other.footprint) <= 8 + 1e-6
    ));
  }

  if (hasWebOfDeathEscort(entry, entries)) {
    protectedAllies.push(...entries.filter(other =>
      other.unit.id !== entry.unit.id
      && !other.footprint.isFighter
      && other.unit.ownerId === entry.unit.ownerId
      && isMinbariEntry(other)
      && antiFighterRangeDistance(entry.footprint, other.footprint) <= 4 + 1e-6
    ));
  }

  const unique = new Map<number, AntiFighterEntry>();
  for (const ally of protectedAllies) unique.set(ally.unit.id, ally);
  return [...unique.values()];
}

function antiFighterEligibleTargetsFor(
  attackerEntry: AntiFighterEntry,
  entries: AntiFighterEntry[],
  fighterEntries: AntiFighterEntry[],
  dogfightingIds: Set<number>,
  liveIds?: Set<number>,
): Array<{ targetEntry: AntiFighterEntry; distance: number }> {
  const best = new Map<number, { targetEntry: AntiFighterEntry; distance: number }>();
  const consider = (targetEntry: AntiFighterEntry, distance: number) => {
    const previous = best.get(targetEntry.unit.id);
    if (!previous || distance < previous.distance) {
      best.set(targetEntry.unit.id, { targetEntry, distance });
    }
  };

  const protectedAllies = escortProtectedAllies(attackerEntry, entries);
  for (const targetEntry of fighterEntries) {
    if (liveIds && !liveIds.has(targetEntry.unit.id)) continue;
    if (targetEntry.unit.ownerId === attackerEntry.unit.ownerId) continue;
    if (dogfightingIds.has(targetEntry.unit.id)) continue;

    const directDistance = antiFighterRangeDistance(attackerEntry.footprint, targetEntry.footprint);
    if (directDistance <= 2 + 1e-6) consider(targetEntry, directDistance);

    for (const ally of protectedAllies) {
      const protectedDistance = antiFighterRangeDistance(ally.footprint, targetEntry.footprint);
      if (protectedDistance <= 2 + 1e-6) consider(targetEntry, protectedDistance);
    }
  }

  return [...best.values()];
}

function readAntiFighterPending(raw: unknown): AntiFighterPendingState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = raw as Record<string, unknown>;
  const antiFighter = state.antiFighter;
  if (!antiFighter || typeof antiFighter !== "object" || Array.isArray(antiFighter)) return null;
  const pending = antiFighter as Partial<AntiFighterPendingState>;
  if (pending.kind !== "anti-fighter-allocation") return null;
  if (typeof pending.round !== "number" || typeof pending.currentPlayerId !== "string") return null;
  if (!Array.isArray(pending.attackers)) return null;
  return pending as AntiFighterPendingState;
}

async function buildAntiFighterPendingState(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  completedPlayerIds: string[] = [],
  lastResult?: AntiFighterPendingState["lastResult"],
): Promise<AntiFighterPendingState | null> {
  if (!game.opponentId) return null;
  const rows = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  const entries: AntiFighterEntry[] = [];

  for (const unit of rows as Array<typeof gameUnitsTable.$inferSelect>) {
    const [ship] = await tx.select().from(shipsTable).where(eq(shipsTable.id, unit.shipId));
    if (!ship) continue;
    const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
    if (!model) continue;
    const critRows = await tx.select().from(unitCriticalEffectsTable)
      .where(eq(unitCriticalEffectsTable.gameUnitId, unit.id));
    const crits = deriveCritEffects((critRows as Array<typeof unitCriticalEffectsTable.$inferSelect>).map(r => ({
      effectKey: r.effectKey,
      randomArc: r.randomArc,
      randomWeaponId: r.randomWeaponId,
      lostTraits: r.lostTraits ?? [],
    })));
    const traits = parseShipTraits(filterLostTraits(model.traits, crits.lostTraitNames));
    entries.push({
      unit,
      model,
      traits,
      footprint: {
        id: unit.id,
        ownerId: unit.ownerId,
        x: unit.hexQ,
        z: unit.hexR,
        baseRadiusInches: rulesBaseRadius(unit),
        isFighter: shipModelIsFighter(model),
      },
    });
  }

  const fighterEntries = entries.filter(entry => entry.footprint.isFighter);
  const dogfightingIds = new Set<number>();
  for (let i = 0; i < fighterEntries.length; i++) {
    for (let j = i + 1; j < fighterEntries.length; j++) {
      const a = fighterEntries[i]!;
      const b = fighterEntries[j]!;
      if (a.unit.ownerId === b.unit.ownerId) continue;
      const contactDistance = rulesBaseRadius(a.footprint) + rulesBaseRadius(b.footprint) + BASE_CONTACT_EPSILON;
      if (centerDistance(a.footprint, b.footprint) <= contactDistance) {
        dogfightingIds.add(a.unit.id);
        dogfightingIds.add(b.unit.id);
      }
    }
  }

  const attackers: AntiFighterPendingAttacker[] = [];
  for (const attackerEntry of entries) {
    if (attackerEntry.footprint.isFighter) continue;
    const advancedDice = Math.max(0, attackerEntry.traits.advancedAntiFighter);
    const standardDice = Math.max(0, attackerEntry.traits.antiFighter);
    const dice = advancedDice > 0 ? advancedDice : standardDice;
    if (dice <= 0) continue;
    const eligibleTargets = antiFighterEligibleTargetsFor(attackerEntry, entries, fighterEntries, dogfightingIds)
      .map(({ targetEntry, distance }) => ({
        targetUnitId: targetEntry.unit.id,
        targetName: targetEntry.unit.name,
        distance: Number(distance.toFixed(2)),
        hull: targetEntry.model.hullRating ?? targetEntry.model.hull ?? targetEntry.unit.maxHullPoints,
      }))
      .sort((a, b) => a.hull - b.hull || a.distance - b.distance || a.targetUnitId - b.targetUnitId);
    if (eligibleTargets.length === 0) continue;
    attackers.push({
      attackerUnitId: attackerEntry.unit.id,
      attackerName: attackerEntry.unit.name,
      ownerId: attackerEntry.unit.ownerId,
      trait: advancedDice > 0 ? "Advanced Anti-Fighter" : "Anti-Fighter",
      dice,
      bonus: advancedDice > 0 ? 1 : 0,
      eligibleTargets,
    });
  }

  const completed = new Set(completedPlayerIds);
  const initiativeId = game.initiativeWinnerId ?? game.challengerId;
  const playerOrder = [
    initiativeId,
    initiativeId === game.challengerId ? game.opponentId : game.challengerId,
  ].filter((id): id is string => Boolean(id));
  const pendingPlayerIds = playerOrder.filter(playerId =>
    !completed.has(playerId)
    && attackers.some(attacker => attacker.ownerId === playerId)
  );
  const currentPlayerId = pendingPlayerIds[0];
  if (!currentPlayerId) return null;
  return {
    kind: "anti-fighter-allocation",
    round: game.currentRound,
    currentPlayerId,
    pendingPlayerIds,
    completedPlayerIds,
    attackers: attackers.filter(attacker => attacker.ownerId === currentPlayerId),
    lastResult,
  };
}

async function resolveEndOfMovementAntiFighter(
  tx: any,
  game: typeof gamesTable.$inferSelect,
): Promise<{ attacks: AntiFighterAttackLog[]; destroyedUnitIds: number[]; fighterRecoveries: DestroyedFighterRecoveryResult[] }> {
  const rows = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  const byId = new Map<number, AntiFighterEntry>();

  for (const unit of rows as Array<typeof gameUnitsTable.$inferSelect>) {
    const [ship] = await tx.select().from(shipsTable).where(eq(shipsTable.id, unit.shipId));
    if (!ship) continue;
    const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
    if (!model) continue;
    const critRows = await tx.select().from(unitCriticalEffectsTable)
      .where(eq(unitCriticalEffectsTable.gameUnitId, unit.id));
    const crits = deriveCritEffects((critRows as Array<typeof unitCriticalEffectsTable.$inferSelect>).map(r => ({
      effectKey: r.effectKey,
      randomArc: r.randomArc,
      randomWeaponId: r.randomWeaponId,
      lostTraits: r.lostTraits ?? [],
    })));
    const traits = parseShipTraits(filterLostTraits(model.traits, crits.lostTraitNames));
    byId.set(unit.id, {
      unit,
      model,
      traits,
      footprint: {
        id: unit.id,
        ownerId: unit.ownerId,
        x: unit.hexQ,
        z: unit.hexR,
        baseRadiusInches: rulesBaseRadius(unit),
        isFighter: shipModelIsFighter(model),
      },
    });
  }

  const liveIds = new Set(byId.keys());
  const fighterEntries = [...byId.values()].filter(entry => entry.footprint.isFighter);
  const dogfightingIds = new Set<number>();
  for (let i = 0; i < fighterEntries.length; i++) {
    for (let j = i + 1; j < fighterEntries.length; j++) {
      const a = fighterEntries[i]!;
      const b = fighterEntries[j]!;
      if (a.unit.ownerId === b.unit.ownerId) continue;
      const contactDistance = rulesBaseRadius(a.footprint) + rulesBaseRadius(b.footprint) + BASE_CONTACT_EPSILON;
      if (centerDistance(a.footprint, b.footprint) <= contactDistance) {
        dogfightingIds.add(a.unit.id);
        dogfightingIds.add(b.unit.id);
      }
    }
  }

  const attacks: AntiFighterAttackLog[] = [];
  const destroyedUnitIds = new Set<number>();
  const fighterRecoveries: DestroyedFighterRecoveryResult[] = [];

  for (const attackerEntry of byId.values()) {
    if (!liveIds.has(attackerEntry.unit.id)) continue;
    if (attackerEntry.footprint.isFighter) continue;
    const advancedDice = Math.max(0, attackerEntry.traits.advancedAntiFighter);
    const standardDice = Math.max(0, attackerEntry.traits.antiFighter);
    const dice = advancedDice > 0 ? advancedDice : standardDice;
    if (dice <= 0) continue;
    const bonus = advancedDice > 0 ? 1 : 0;
    const trait = advancedDice > 0 ? "Advanced Anti-Fighter" : "Anti-Fighter";
    const eligibleTargets = antiFighterEligibleTargetsFor(
      attackerEntry,
      [...byId.values()],
      fighterEntries,
      dogfightingIds,
      liveIds,
    ).map(({ targetEntry }) => targetEntry)
      .sort((a, b) =>
        (a.model.hullRating ?? 0) - (b.model.hullRating ?? 0)
        || antiFighterRangeDistance(attackerEntry.footprint, a.footprint) - antiFighterRangeDistance(attackerEntry.footprint, b.footprint)
        || a.unit.id - b.unit.id
      );
    if (eligibleTargets.length === 0) continue;

    const rolls: AntiFighterRollLog[] = [];
    const destroyedByThisAttack = new Set<number>();
    for (let i = 0; i < dice; i++) {
      const targetEntry = eligibleTargets[i % eligibleTargets.length]!;
      if (!liveIds.has(targetEntry.unit.id)) continue;
      const die = rollD6();
      const targetHull = targetEntry.model.hullRating ?? targetEntry.model.hull ?? targetEntry.unit.maxHullPoints;
      const total = die + bonus;
      const destroyed = total >= targetHull;
      rolls.push({
        attackerId: attackerEntry.unit.id,
        attackerName: attackerEntry.unit.name,
        targetId: targetEntry.unit.id,
        targetName: targetEntry.unit.name,
        die,
        bonus,
        total,
        targetHull,
        destroyed,
      });
      if (destroyed) destroyedByThisAttack.add(targetEntry.unit.id);
    }

    for (const targetId of destroyedByThisAttack) {
      const targetEntry = byId.get(targetId);
      liveIds.delete(targetId);
      destroyedUnitIds.add(targetId);
      await tx.update(gameUnitsTable).set({
        hullPoints: 0,
        crewPoints: 0,
        damageState: "destroyed",
        isDestroyed: true,
      }).where(eq(gameUnitsTable.id, targetId));
      if (targetEntry) {
        const recovery = await resolveDestroyedFighterRecovery(tx, game, {
          ...targetEntry.unit,
          hullPoints: 0,
          crewPoints: 0,
          damageState: "destroyed",
          isDestroyed: true,
        }, "anti-fighter");
        if (recovery) fighterRecoveries.push(recovery);
      }
    }

    attacks.push({
      attackerId: attackerEntry.unit.id,
      attackerName: attackerEntry.unit.name,
      trait,
      dice,
      bonus,
      eligibleTargetIds: eligibleTargets.map(t => t.unit.id),
      rolls,
      destroyedTargetIds: [...destroyedByThisAttack],
    });
  }

  if (attacks.length > 0) {
    const destroyedArray = [...destroyedUnitIds];
    await recordAntiFighterAuditLog(tx, {
      game,
      actorKind: "system",
      actorPlayerId: null,
      context: "end-of-movement-auto",
      attacks,
      destroyedUnitIds: destroyedArray,
      fighterRecoveries,
      summary: `End-of-Movement Anti-Fighter resolved: ${attacks.reduce((sum, attack) => sum + attack.rolls.length, 0)} dice, ${destroyedArray.length} fighter flight(s) destroyed.`,
    });
    const summary = {
      round: game.currentRound,
      destroyedUnitIds: destroyedArray,
      fighterRecoveries,
      dogfightingUnitIdsSkipped: [...dogfightingIds],
      attacks,
    };
    await tx.update(gamesTable).set({
      aiState: mergeAiState(game.aiState, aiState("acted", "rules.anti-fighter", {
        message: `End-of-Movement Anti-Fighter resolved: ${destroyedUnitIds.size} fighter flight(s) destroyed.`,
        lastAntiFighter: summary,
      })),
    }).where(eq(gamesTable.id, game.id));
  }

  const survivors = await tx.select().from(gameUnitsTable).where(eq(gameUnitsTable.gameId, game.id));
  let challengerAlive = 0;
  let opponentAlive = 0;
  for (const unit of survivors as Array<typeof gameUnitsTable.$inferSelect>) {
    if (!unitCountsForVictory(unit)) continue;
    if (unit.ownerId === game.challengerId) challengerAlive++;
    else if (unit.ownerId === game.opponentId) opponentAlive++;
  }
  if (game.opponentId && challengerAlive === 0 && opponentAlive > 0) {
    await tx.update(gamesTable).set({ status: "completed", winnerId: game.opponentId, activePlayerId: null, activeUnitId: null })
      .where(eq(gamesTable.id, game.id));
  } else if (game.opponentId && opponentAlive === 0 && challengerAlive > 0) {
    await tx.update(gamesTable).set({ status: "completed", winnerId: game.challengerId, activePlayerId: null, activeUnitId: null })
      .where(eq(gamesTable.id, game.id));
  } else if (game.opponentId && challengerAlive === 0 && opponentAlive === 0) {
    await tx.update(gamesTable).set({ status: "completed", winnerId: null, activePlayerId: null, activeUnitId: null })
      .where(eq(gamesTable.id, game.id));
  }

  return { attacks, destroyedUnitIds: [...destroyedUnitIds], fighterRecoveries };
}

async function resolvePlayerAntiFighterAllocations(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  pending: AntiFighterPendingState,
  allocations: Array<{ attackerUnitId: number; targetUnitId: number; dice: number }>,
): Promise<{ playerId: string; attacks: AntiFighterAttackLog[]; destroyedUnitIds: number[]; fighterRecoveries: DestroyedFighterRecoveryResult[] }> {
  const attackerById = new Map(pending.attackers.map(attacker => [attacker.attackerUnitId, attacker]));
  const diceByAttacker = new Map<number, number>();
  const expandedAssignments = new Map<number, number[]>();

  for (const raw of allocations) {
    const attackerUnitId = Math.trunc(Number(raw.attackerUnitId));
    const targetUnitId = Math.trunc(Number(raw.targetUnitId));
    const dice = Math.trunc(Number(raw.dice));
    if (!Number.isFinite(attackerUnitId) || !Number.isFinite(targetUnitId) || !Number.isFinite(dice) || dice < 0) {
      throw Object.assign(new Error("Invalid Anti-Fighter allocation"), { status: 400 });
    }
    if (dice === 0) continue;
    const attacker = attackerById.get(attackerUnitId);
    if (!attacker) throw Object.assign(new Error("Anti-Fighter attacker is not eligible"), { status: 400 });
    if (!attacker.eligibleTargets.some(target => target.targetUnitId === targetUnitId)) {
      throw Object.assign(new Error("Anti-Fighter target is not eligible for that attacker"), { status: 400 });
    }
    const nextDice = (diceByAttacker.get(attackerUnitId) ?? 0) + dice;
    if (nextDice > attacker.dice) {
      throw Object.assign(new Error(`${attacker.attackerName} has only ${attacker.dice} Anti-Fighter dice`), { status: 400 });
    }
    diceByAttacker.set(attackerUnitId, nextDice);
    const assignments = expandedAssignments.get(attackerUnitId) ?? [];
    for (let i = 0; i < dice; i++) assignments.push(targetUnitId);
    expandedAssignments.set(attackerUnitId, assignments);
  }

  const attacks: AntiFighterAttackLog[] = [];
  const destroyedUnitIds = new Set<number>();
  const fighterRecoveries: DestroyedFighterRecoveryResult[] = [];
  for (const attacker of pending.attackers) {
    const assignments = expandedAssignments.get(attacker.attackerUnitId) ?? [];
    if (assignments.length === 0) continue;
    const targetById = new Map(attacker.eligibleTargets.map(target => [target.targetUnitId, target]));
    const rolls: AntiFighterRollLog[] = [];
    const destroyedByThisAttack = new Set<number>();
    for (const targetUnitId of assignments) {
      const target = targetById.get(targetUnitId);
      if (!target) continue;
      const die = rollD6();
      const total = die + attacker.bonus;
      const destroyed = total >= target.hull;
      rolls.push({
        attackerId: attacker.attackerUnitId,
        attackerName: attacker.attackerName,
        targetId: target.targetUnitId,
        targetName: target.targetName,
        die,
        bonus: attacker.bonus,
        total,
        targetHull: target.hull,
        destroyed,
      });
      if (destroyed) destroyedByThisAttack.add(target.targetUnitId);
    }
    for (const targetId of destroyedByThisAttack) destroyedUnitIds.add(targetId);
    attacks.push({
      attackerId: attacker.attackerUnitId,
      attackerName: attacker.attackerName,
      trait: attacker.trait,
      dice: attacker.dice,
      bonus: attacker.bonus,
      eligibleTargetIds: attacker.eligibleTargets.map(target => target.targetUnitId),
      rolls,
      destroyedTargetIds: [...destroyedByThisAttack],
    });
  }

  for (const targetId of destroyedUnitIds) {
    const [targetUnit] = await tx.select().from(gameUnitsTable).where(and(
      eq(gameUnitsTable.id, targetId),
      eq(gameUnitsTable.gameId, game.id),
    ));
    await tx.update(gameUnitsTable).set({
      hullPoints: 0,
      crewPoints: 0,
      damageState: "destroyed",
      isDestroyed: true,
    }).where(and(
      eq(gameUnitsTable.id, targetId),
      eq(gameUnitsTable.gameId, game.id),
    ));
    if (targetUnit) {
      const recovery = await resolveDestroyedFighterRecovery(tx, game, {
        ...targetUnit,
        hullPoints: 0,
        crewPoints: 0,
        damageState: "destroyed",
        isDestroyed: true,
      }, "anti-fighter");
      if (recovery) fighterRecoveries.push(recovery);
    }
  }

  const survivors = await tx.select().from(gameUnitsTable).where(eq(gameUnitsTable.gameId, game.id));
  let challengerAlive = 0;
  let opponentAlive = 0;
  for (const unit of survivors as Array<typeof gameUnitsTable.$inferSelect>) {
    if (!unitCountsForVictory(unit)) continue;
    if (unit.ownerId === game.challengerId) challengerAlive++;
    else if (unit.ownerId === game.opponentId) opponentAlive++;
  }
  if (game.opponentId && challengerAlive === 0 && opponentAlive > 0) {
    await tx.update(gamesTable).set({ status: "completed", winnerId: game.opponentId, activePlayerId: null, activeUnitId: null })
      .where(eq(gamesTable.id, game.id));
  } else if (game.opponentId && opponentAlive === 0 && challengerAlive > 0) {
    await tx.update(gamesTable).set({ status: "completed", winnerId: game.challengerId, activePlayerId: null, activeUnitId: null })
      .where(eq(gamesTable.id, game.id));
  } else if (game.opponentId && challengerAlive === 0 && opponentAlive === 0) {
    await tx.update(gamesTable).set({ status: "completed", winnerId: null, activePlayerId: null, activeUnitId: null })
      .where(eq(gamesTable.id, game.id));
  }

  const destroyedArray = [...destroyedUnitIds];
  await recordAntiFighterAuditLog(tx, {
    game,
    actorKind: pending.currentPlayerId === AI_OPPONENT_ID ? "ai" : "player",
    actorPlayerId: pending.currentPlayerId,
    playerId: pending.currentPlayerId,
    context: "player-allocation",
    attacks,
    destroyedUnitIds: destroyedArray,
    fighterRecoveries,
    summary: `${pending.currentPlayerId === AI_OPPONENT_ID ? "AI " : ""}Anti-Fighter allocation resolved: ${attacks.reduce((sum, attack) => sum + attack.rolls.length, 0)} dice, ${destroyedArray.length} fighter flight(s) destroyed.`,
  });

  return { playerId: pending.currentPlayerId, attacks, destroyedUnitIds: destroyedArray, fighterRecoveries };
}

async function advanceAfterAntiFighter(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  lastResult: AntiFighterPendingState["lastResult"],
): Promise<typeof gamesTable.$inferSelect> {
  const initiativeId = game.initiativeWinnerId ?? game.challengerId;
  const opponentId = game.opponentId;
  const playerOrder = [
    initiativeId,
    initiativeId === game.challengerId ? opponentId : game.challengerId,
  ].filter((id): id is string => Boolean(id));
  const rows = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.isDestroyed, false),
    eq(gameUnitsTable.hasFiredThisRound, false),
    sql`${gameUnitsTable.hullPoints} > 0 AND (${gameUnitsTable.maxCrewPoints} = 0 OR ${gameUnitsTable.crewPoints} > 0)`,
  ));
  const eligible: Array<{ unit: typeof gameUnitsTable.$inferSelect; fighter: boolean }> = [];
  for (const unit of rows as Array<typeof gameUnitsTable.$inferSelect>) {
    const [ship] = await tx.select().from(shipsTable).where(eq(shipsTable.id, unit.shipId));
    if (!ship) continue;
    const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
    eligible.push({ unit, fighter: model ? shipModelIsFighter(model) : false });
  }
  const hasFighter = eligible.some(row => row.fighter);
  const hasCapital = eligible.some(row => !row.fighter);
  const targetFighterSegment = hasFighter;
  const firstPlayer = playerOrder.find(playerId =>
    eligible.some(row => row.unit.ownerId === playerId && row.fighter === targetFighterSegment)
  );
  const baseAiState = game.aiState && typeof game.aiState === "object" && !Array.isArray(game.aiState)
    ? game.aiState as Record<string, unknown>
    : {};
  const nextAiState: Record<string, unknown> = {
    ...baseAiState,
    lastAntiFighter: lastResult,
  };
  delete nextAiState.antiFighter;

  if (firstPlayer && (hasFighter || hasCapital)) {
    const [row] = await tx.update(gamesTable).set({
      aiState: nextAiState,
      phase: "firing",
      activePlayerId: firstPlayer,
      activeUnitId: null,
    }).where(eq(gamesTable.id, game.id)).returning();
    return row;
  }

  const [row] = await tx.update(gamesTable).set({
    aiState: nextAiState,
    phase: "end",
    activePlayerId: initiativeId,
    activeUnitId: null,
    endPhaseChallengerPassed: false,
    endPhaseOpponentPassed: false,
  }).where(eq(gamesTable.id, game.id)).returning();
  return row;
}

function chooseAiAntiFighterAllocations(
  pending: AntiFighterPendingState,
): Array<{ attackerUnitId: number; targetUnitId: number; dice: number }> {
  const allocations: Array<{ attackerUnitId: number; targetUnitId: number; dice: number }> = [];
  for (const attacker of pending.attackers) {
    if (attacker.ownerId !== AI_OPPONENT_ID || attacker.dice <= 0) continue;
    const target = attacker.eligibleTargets[0];
    if (!target) continue;
    allocations.push({
      attackerUnitId: attacker.attackerUnitId,
      targetUnitId: target.targetUnitId,
      dice: attacker.dice,
    });
  }
  return allocations;
}

async function resolvePendingAiAntiFighter(
  tx: any,
  game: typeof gamesTable.$inferSelect,
): Promise<typeof gamesTable.$inferSelect | null> {
  const pending = readAntiFighterPending(game.aiState);
  if (
    !pending
    || pending.round !== game.currentRound
    || pending.currentPlayerId !== AI_OPPONENT_ID
    || game.activePlayerId !== AI_OPPONENT_ID
  ) {
    return null;
  }

  const allocations = chooseAiAntiFighterAllocations(pending);
  const result = await resolvePlayerAntiFighterAllocations(tx, game, pending, allocations);
  const [postResolutionGame] = await tx.select().from(gamesTable).where(eq(gamesTable.id, game.id));
  if (!postResolutionGame) throw Object.assign(new Error("Game not found"), { status: 404 });

  const aiPatch = aiState("acted", "movement.anti-fighter", {
    message: `AI resolved Anti-Fighter allocation: ${result.destroyedUnitIds.length} fighter flight(s) destroyed.`,
    lastAntiFighter: result,
  });

  if (postResolutionGame.status === "completed") {
    const nextAiState = mergeAiState(postResolutionGame.aiState, aiPatch);
    delete nextAiState.antiFighter;
    const [completed] = await tx.update(gamesTable).set({
      aiState: nextAiState,
      activePlayerId: null,
      activeUnitId: null,
    }).where(eq(gamesTable.id, game.id)).returning();
    return completed;
  }

  const completedPlayerIds = [...new Set([...pending.completedPlayerIds, AI_OPPONENT_ID])];
  const nextPending = await buildAntiFighterPendingState(tx, postResolutionGame, completedPlayerIds, result);
  if (nextPending) {
    const [row] = await tx.update(gamesTable).set({
      aiState: {
        ...mergeAiState(postResolutionGame.aiState, aiPatch),
        antiFighter: nextPending,
      },
      activePlayerId: nextPending.currentPlayerId,
      activeUnitId: null,
    }).where(eq(gamesTable.id, game.id)).returning();
    return row;
  }

  return advanceAfterAntiFighter(tx, {
    ...postResolutionGame,
    aiState: mergeAiState(postResolutionGame.aiState, aiPatch),
  }, result);
}

async function finishActiveAiFiringWithoutShot(tx: any, game: typeof gamesTable.$inferSelect): Promise<typeof gamesTable.$inferSelect> {
  if (!game.activeUnitId) return activateAiUnitForPhase(tx, game, "firing");
  const [unit] = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.id, game.activeUnitId),
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.ownerId, AI_OPPONENT_ID),
  ));
  if (!unit) throw new Error("AI active firing unit not found");
  const dogfightContacts = await fighterDogfightContacts(tx, game.id, unit);
  if (dogfightContacts.length > 0) {
    const targetIds = dogfightContacts.map(contact => contact.id);
    const contactedTargets = await tx.select().from(gameUnitsTable).where(and(
      eq(gameUnitsTable.gameId, game.id),
      inArray(gameUnitsTable.id, targetIds),
    ));
    const target = (contactedTargets as Array<typeof gameUnitsTable.$inferSelect>)
      .filter(row => !row.isDestroyed && row.ownerId !== unit.ownerId)
      .sort((a, b) => a.hullPoints - b.hullPoints || a.id - b.id)[0];
    if (target) {
      const result = await resolveDogfightBetweenUnits(tx, game, unit, target);
      const message = result.tied
        ? `AI dogfight ${unit.name} vs ${target.name}: tied; fighters remain locked.`
        : result.destroyedUnitId === target.id
          ? `AI dogfight ${unit.name} destroyed ${target.name}.`
          : `AI dogfight ${unit.name} was destroyed by ${target.name}.`;
      const decision = aiDecision(
        result.gameCompleted ? "firing.dogfight-game-over" : "firing.dogfight",
        "firing",
        `AI resolved ${unit.name}'s dogfight against ${target.name}.`,
        {
          chosenAction: "dogfight",
          targetId: target.id,
          targetName: target.name,
          result: {
            attackerRoll: result.attackerRoll,
            attackerDogfight: result.attackerDogfight,
            attackerFleetCarrierBonus: result.attackerFleetCarrierBonus,
            attackerSupportBonus: result.attackerSupportBonus,
            attackerScore: result.attackerScore,
            targetRoll: result.targetRoll,
            targetDogfight: result.targetDogfight,
            targetFleetCarrierBonus: result.targetFleetCarrierBonus,
            targetSupportBonus: result.targetSupportBonus,
            targetScore: result.targetScore,
            destroyedUnitId: result.destroyedUnitId,
            tied: result.tied,
            gameCompleted: result.gameCompleted,
          },
        },
        unit,
      );
      const patch = withAiDecisionLog(game.aiState, aiState("acted", decision.step, {
        message,
        unitIds: [unit.id, target.id],
        lastDogfight: result,
      }), decision);
      if (result.gameCompleted) {
        const [row] = await tx.update(gamesTable).set({
          aiState: mergeAiState(game.aiState, patch),
        }).where(eq(gamesTable.id, game.id)).returning();
        return row;
      }
      return finishAiActivation(tx, game, unit, "firing", patch);
    }
  }
  const plan = await chooseAiFirePlan(tx, game, unit);
  if (plan) {
    const result = await resolveBasicAiWeaponFire(tx, game, unit, plan.weapon, plan.target);
    const message = `AI fired ${plan.weapon.name} at ${plan.target.name}: ${result.hits} hit(s), ${result.finalDamage} damage, ${result.finalCrewLost} crew.`;
    const decision = aiDecision(
      result.gameCompleted ? "firing.fire-weapon-game-over" : "firing.fire-weapon",
      "firing",
      `AI chose ${plan.weapon.name} into ${plan.target.name} with score ${plan.score.toFixed(1)}.`,
      {
        chosenAction: "fire",
        chosen: {
          weaponId: plan.weapon.id,
          weaponName: plan.weapon.name,
          targetId: plan.target.id,
          targetName: plan.target.name,
          distance: Number(plan.distance.toFixed(2)),
          score: Number(plan.score.toFixed(2)),
          breakdown: plan.breakdown,
        },
        result: {
          hits: result.hits,
          remainingHits: result.remainingHits,
          damage: result.finalDamage,
          crew: result.finalCrewLost,
          targetDestroyed: result.targetDestroyed,
          gameCompleted: result.gameCompleted,
        },
        topCandidates: plan.topCandidates,
        rejected: plan.rejected,
      },
      unit,
    );
    if (result.gameCompleted) {
      const [row] = await tx.update(gamesTable).set({
        aiState: withAiDecisionLog(game.aiState, aiState("acted", "firing.fire-weapon-game-over", {
          message,
          unitIds: [unit.id, plan.target.id],
        }), decision),
      }).where(eq(gamesTable.id, game.id)).returning();
      return row;
    }
    return finishAiActivation(tx, game, unit, "firing", withAiDecisionLog(
      game.aiState,
      aiState("acted", "firing.fire-weapon", {
        message,
        unitIds: [unit.id, plan.target.id],
      }),
      decision,
    ));
  }
  const decision = aiDecision(
    "firing.pass-activation",
    "firing",
    `AI found no legal shot for ${unit.name}.`,
    { chosenAction: "pass", reason: "no-legal-fire-plan" },
    unit,
  );
  return finishAiActivation(tx, game, unit, "firing", withAiDecisionLog(
    game.aiState,
    aiState("acted", "firing.pass-activation", {
      message: `AI completed ${unit.name}'s firing activation without a legal shot.`,
      unitIds: [unit.id],
    }),
    decision,
  ));
}

async function autoRepairRedundantSystemCriticals(tx: any, gameId: number): Promise<void> {
  const survivors = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, gameId),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  for (const u of survivors) {
    const [ship] = await tx.select().from(shipsTable).where(eq(shipsTable.id, u.shipId));
    if (!ship) continue;
    const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
    if (!model) continue;
    const traits = parseShipTraits(model.traits);
    if (!traits.ancient && !traits.redundantSystems) continue;
    await tx.delete(unitCriticalEffectsTable).where(eq(unitCriticalEffectsTable.gameUnitId, u.id));
  }
}

type SelfRepairResult = {
  unitBefore: typeof gameUnitsTable.$inferSelect;
  unitAfter: typeof gameUnitsTable.$inferSelect;
  dice: number;
  rolls: number[];
  total: number;
  repaired: number;
  hullBefore: number;
  hullAfter: number;
};

async function resolveSelfRepairForUnit(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  unit: typeof gameUnitsTable.$inferSelect,
  options: { throwOnUnavailable?: boolean } = {},
): Promise<SelfRepairResult | null> {
  const fail = (message: string, status = 400): null => {
    if (options.throwOnUnavailable) {
      throw Object.assign(new Error(message), { status });
    }
    return null;
  };
  if (unit.isDestroyed) return fail("Ship destroyed");
  if (unit.hullPoints <= 0) return fail("Hulked ships cannot use Self Repair");
  if (unit.maxCrewPoints > 0 && unit.crewPoints <= 0) {
    return fail("Crewless ships cannot use Self Repair");
  }
  if (unit.lastSelfRepairRound === game.currentRound) return fail("Self Repair already resolved this round");
  if (unit.hullPoints >= unit.maxHullPoints) return fail("Hull is already fully repaired");

  const [ship] = await tx.select().from(shipsTable).where(eq(shipsTable.id, unit.shipId));
  if (!ship) return fail("Ship not found", 404);
  const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
  if (!model) return fail("Ship model not found", 404);

  const critRows = await tx.select().from(unitCriticalEffectsTable)
    .where(eq(unitCriticalEffectsTable.gameUnitId, unit.id));
  const crits = deriveCritEffects((critRows as Array<typeof unitCriticalEffectsTable.$inferSelect>).map(r => ({
    effectKey: r.effectKey,
    randomArc: r.randomArc,
    randomWeaponId: r.randomWeaponId,
    lostTraits: r.lostTraits ?? [],
  })));
  const traits = parseShipTraits(filterLostTraits(model.traits ?? "", crits.lostTraitNames));
  const dice = traits.selfRepairDice ?? 0;
  if (dice <= 0) return fail("Ship does not have Self Repair");

  const rolls = Array.from({ length: dice }, () => rollD6());
  const total = rolls.reduce((sum, roll) => sum + roll, 0);
  const hullBefore = unit.hullPoints;
  const hullAfter = Math.min(unit.maxHullPoints, hullBefore + total);
  const repaired = hullAfter - hullBefore;
  const [unitAfter] = await tx.update(gameUnitsTable)
    .set({
      hullPoints: hullAfter,
      lastSelfRepairRound: game.currentRound,
    })
    .where(eq(gameUnitsTable.id, unit.id))
    .returning();
  if (!unitAfter) return fail("Self Repair failed to update ship");
  return {
    unitBefore: unit,
    unitAfter,
    dice,
    rolls,
    total,
    repaired,
    hullBefore,
    hullAfter,
  };
}

async function resolveAutomaticSelfRepairsForPlayer(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  ownerId: string,
): Promise<SelfRepairResult[]> {
  const units = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.ownerId, ownerId),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  const repairs: SelfRepairResult[] = [];
  for (const unit of units) {
    const result = await resolveSelfRepairForUnit(tx, game, unit);
    if (result) repairs.push(result);
  }
  return repairs;
}

function formatSelfRepairSummary(repairs: SelfRepairResult[]): string {
  if (repairs.length === 0) return "";
  return repairs
    .map(r => `${r.unitBefore.name} repaired ${r.repaired} hull (${r.rolls.join("+")}=${r.total}; ${r.hullBefore}->${r.hullAfter})`)
    .join("; ");
}

async function rollOverRoundAfterEndPhase(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  aiStatePatch?: AiStatePatch,
): Promise<typeof gamesTable.$inferSelect> {
  const driftCandidates = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  for (const u of driftCandidates) {
    if (u.lastAdriftDriftRound === game.currentRound) continue;
    const critRows = await tx.select().from(unitCriticalEffectsTable)
      .where(eq(unitCriticalEffectsTable.gameUnitId, u.id));
    const state = effectiveDamageState(u.damageState, critRows);
    if (state !== "adrift" && state !== "exploding-end-of-next") continue;
    const crits = deriveCritEffects((critRows as Array<typeof unitCriticalEffectsTable.$inferSelect>).map(r => ({
      effectKey: r.effectKey,
      randomArc: r.randomArc,
      randomWeaponId: r.randomWeaponId,
      lostTraits: r.lostTraits ?? [],
    })));
    const driftDistance = Math.floor(effectiveBaseSpeed(u, crits) / 2);
    const forward = headingForwardVec(u);
    const driftTo = {
      hexQ: Math.round(u.hexQ + forward.x * driftDistance),
      hexR: Math.round(u.hexR + forward.z * driftDistance),
    };
    const [driftedUnit] = await tx.update(gameUnitsTable)
      .set({
        hexQ: driftTo.hexQ,
        hexR: driftTo.hexR,
        hasMovedThisRound: true,
        hasInitiatedMoveThisActivation: false,
        inchesMovedThisActivation: 0,
        turnsMadeThisActivation: 0,
        distanceSinceLastTurnThisActivation: 0,
        allStopReady: false,
        lastAdriftDriftRound: game.currentRound,
      })
      .where(and(
        eq(gameUnitsTable.id, u.id),
        eq(gameUnitsTable.lastAdriftDriftRound, u.lastAdriftDriftRound),
      ))
      .returning();
    if (driftedUnit) {
      await recordMovementAuditLog(tx, {
        game,
        actorKind: "system",
        actorPlayerId: null,
        unitBefore: u,
        unitAfter: driftedUnit,
        movementKind: "adrift-drift",
        summary: `${u.name} drifted ${driftDistance}" during end-phase adrift movement.`,
        payload: {
          rulesPath: "end-phase-adrift-drift",
          effectiveState: state,
          driftDistance,
          forward,
          driftTo,
          critEffects: (critRows as Array<typeof unitCriticalEffectsTable.$inferSelect>)
            .map(r => ({ id: r.id, effectKey: r.effectKey, name: r.name })),
        },
      });
    }
  }

  await tx.update(gameUnitsTable).set({
    hasMovedThisRound: false,
    hasFiredThisRound: false,
    firedWeaponIds: [],
    hasInitiatedMoveThisActivation: false,
    inchesMovedThisActivation: 0,
    turnsMadeThisActivation: 0,
    distanceSinceLastTurnThisActivation: 0,
    specialAction: null,
    specialActionTargetId: null,
    scoutAction: null,
    scoutActionTargetId: null,
    scoutCoordConsumed: false,
    hitByUnitIdsThisRound: [],
    oneWeaponThisRound: false,
  }).where(and(eq(gameUnitsTable.gameId, game.id), eq(gameUnitsTable.isDestroyed, false)));

  const delayedKills = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.damageState, "exploding-end-of-next"),
  ));
  for (const unit of delayedKills as Array<typeof gameUnitsTable.$inferSelect>) {
    const [destroyedUnit] = await tx.update(gameUnitsTable).set({
      damageState: "destroyed",
      isDestroyed: true,
    }).where(eq(gameUnitsTable.id, unit.id)).returning();
    if (destroyedUnit) {
      await resolveDestroyedFighterRecovery(tx, game, destroyedUnit, "end-phase");
    }
  }

  await autoRepairRedundantSystemCriticals(tx, game.id);

  const gameUpdate = aiStatePatch
    ? { aiState: mergeAiState(game.aiState, aiStatePatch) }
    : {};

  const postExplosion = await tx.select().from(gameUnitsTable)
    .where(eq(gameUnitsTable.gameId, game.id));
  let cAlive = 0, oAlive = 0;
  for (const u of postExplosion) {
    if (!unitCountsForVictory(u)) continue;
    if (u.ownerId === game.challengerId) cAlive++;
    else if (u.ownerId === game.opponentId) oAlive++;
  }
  if (game.opponentId && cAlive === 0 && oAlive > 0) {
    const [row] = await tx.update(gamesTable).set({
      ...gameUpdate,
      status: "completed",
      winnerId: game.opponentId,
      activePlayerId: null,
      activeUnitId: null,
    }).where(eq(gamesTable.id, game.id)).returning();
    return row;
  } else if (game.opponentId && oAlive === 0 && cAlive > 0) {
    const [row] = await tx.update(gamesTable).set({
      ...gameUpdate,
      status: "completed",
      winnerId: game.challengerId,
      activePlayerId: null,
      activeUnitId: null,
    }).where(eq(gamesTable.id, game.id)).returning();
    return row;
  } else if (game.opponentId && cAlive === 0 && oAlive === 0) {
    const [row] = await tx.update(gamesTable).set({
      ...gameUpdate,
      status: "completed",
      winnerId: null,
      activePlayerId: null,
      activeUnitId: null,
    }).where(eq(gamesTable.id, game.id)).returning();
    return row;
  }

  const survivors = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  for (const u of survivors) {
    const [ship] = await tx.select().from(shipsTable).where(eq(shipsTable.id, u.shipId));
    if (!ship) continue;
    const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
    if (isCrippledUnit(u)) {
      if (u.shieldsCurrent !== 0) {
        await tx.update(gameUnitsTable).set({ shieldsCurrent: 0 }).where(eq(gameUnitsTable.id, u.id));
      }
      continue;
    }
    const max = model?.shieldMax ?? 0;
    const regen = model?.shieldRegenRate ?? 0;
    if (max <= 0 || regen <= 0) continue;
    const next = Math.min(max, u.shieldsCurrent + regen);
    if (next !== u.shieldsCurrent) {
      await tx.update(gameUnitsTable).set({ shieldsCurrent: next }).where(eq(gameUnitsTable.id, u.id));
    }
  }

  for (const u of survivors) {
    const [ship] = await tx.select().from(shipsTable).where(eq(shipsTable.id, u.shipId));
    if (!ship) continue;
    const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
    const critRows = await tx.select().from(unitCriticalEffectsTable)
      .where(eq(unitCriticalEffectsTable.gameUnitId, u.id));
    const crits = deriveCritEffects((critRows as Array<typeof unitCriticalEffectsTable.$inferSelect>).map(r => ({
      effectKey: r.effectKey,
      randomArc: r.randomArc,
      randomWeaponId: r.randomWeaponId,
      lostTraits: r.lostTraits ?? [],
    })));
    const fullPool = isCrippledUnit(u)
      ? 0
      : parseShipTraits(filterLostTraits(model?.traits ?? "", crits.lostTraitNames)).interceptors;
    if (u.interceptorDiceRemaining !== fullPool || u.interceptorThresholdCurrent !== 2) {
      await tx.update(gameUnitsTable).set({
        interceptorDiceRemaining: fullPool,
        interceptorThresholdCurrent: 2,
      }).where(eq(gameUnitsTable.id, u.id));
    }
  }

  const [row] = await tx.update(gamesTable).set({
    ...gameUpdate,
    currentRound: game.currentRound + 1,
    currentTurn: game.currentTurn + 1,
    phase: "initiative",
    activePlayerId: null,
    activeUnitId: null,
    initiativeWinnerId: null,
    initiativeChallengerRoll: null,
    initiativeOpponentRoll: null,
    endPhaseChallengerPassed: false,
    endPhaseOpponentPassed: false,
  }).where(eq(gamesTable.id, game.id)).returning();
  return row;
}

async function passAiEndPhase(tx: any, game: typeof gamesTable.$inferSelect): Promise<typeof gamesTable.$inferSelect> {
  if (game.activePlayerId !== AI_OPPONENT_ID) {
    const [row] = await tx.update(gamesTable).set({
      aiState: mergeAiState(game.aiState, aiState("idle", "end.waiting-for-human", {
        message: "No AI step run: waiting for the human commander in the End Phase.",
      })),
    }).where(eq(gamesTable.id, game.id)).returning();
    return row;
  }

  const selfRepairs = await resolveAutomaticSelfRepairsForPlayer(tx, game, AI_OPPONENT_ID);
  const selfRepairSummary = formatSelfRepairSummary(selfRepairs);
  const selfRepairMessage = selfRepairSummary ? ` Self Repair: ${selfRepairSummary}.` : "";

  if (!game.endPhaseChallengerPassed) {
    const [row] = await tx.update(gamesTable).set({
      endPhaseOpponentPassed: true,
      activePlayerId: game.challengerId,
      activeUnitId: null,
      aiState: mergeAiState(game.aiState, aiState("acted", "end.pass", {
        message: `AI passed the End Phase; waiting for the human commander.${selfRepairMessage}`,
        unitIds: selfRepairs.flatMap(r => [r.unitBefore.id]),
      })),
    }).where(eq(gamesTable.id, game.id)).returning();
    return row;
  }

  return rollOverRoundAfterEndPhase(tx, game, aiState("acted", "end.pass-and-rollover", {
    message: `AI passed the End Phase and advanced the game to the next round.${selfRepairMessage}`,
    unitIds: selfRepairs.flatMap(r => [r.unitBefore.id]),
  }));
}

const router: IRouter = Router();

function isDevBuiltinCommander(userId: string): boolean {
  return process.env.NODE_ENV !== "production" && (userId === "test-user-1" || userId === "test-user-2");
}

function isDevAiCommander(game: typeof gamesTable.$inferSelect, userId: string): boolean {
  return isDevBuiltinCommander(userId) && game.opponentKind === "ai" && game.opponentId === AI_OPPONENT_ID && userId !== game.challengerId;
}

function canDeployAiOpponentForAlpha(game: typeof gamesTable.$inferSelect, userId: string): boolean {
  return game.status === "deploying" &&
    game.opponentKind === "ai" &&
    game.opponentId === AI_OPPONENT_ID &&
    game.challengerId === userId &&
    game.challengerDeployed &&
    !game.opponentDeployed;
}

function effectiveGameUserId(game: typeof gamesTable.$inferSelect, userId: string): string {
  return isDevAiCommander(game, userId) || canDeployAiOpponentForAlpha(game, userId) ? AI_OPPONENT_ID : userId;
}

function shouldAutoDeployAiOpponentOnCreate(): boolean {
  return false;
}

router.get("/games", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const games = await db
    .select()
    .from(gamesTable)
    .where(or(eq(gamesTable.challengerId, userId), eq(gamesTable.opponentId, userId)))
    .orderBy(gamesTable.updatedAt);
  const now = new Date();
  res.json(ListGamesResponse.parse(games
    .filter((game) => !game.archiveExpiresAt || game.archiveExpiresAt <= now)
    .map(toGameDto)));
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
  const opponentKind = normalizeOpponentKind(parsed.data.opponentKind);

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
  const priorityLevel = normalizePriorityLevel(parsed.data.priorityLevel);
  const legacyPointLimit = parsed.data.pointLimit ?? 500;
  const allocationPoints = Math.max(
    1,
    Math.min(99, Math.trunc(parsed.data.allocationPoints ?? Math.max(1, Math.round(legacyPointLimit / 100)))),
  );
  const shouldAutoDeployAiOpponent = opponentKind === "ai" && shouldAutoDeployAiOpponentOnCreate();
  const matchName = parsed.data.matchName?.trim() || null;

  const [game] = await db.insert(gamesTable).values({
    challengerId: userId,
    opponentId: opponentKind === "ai" ? AI_OPPONENT_ID : null,
    opponentKind,
    challengerName: challenger?.username ?? null,
    opponentName: opponentKind === "ai" ? AI_OPPONENT_NAME : null,
    matchName,
    challengerFleetId: fleetId,
    pointLimit: allocationPoints * 100,
    priorityLevel,
    allocationPoints,
    visibility,
    passwordHash,
    deploymentDepth,
    crewQualityMode,
    aiProfile: opponentKind === "ai" ? DEFAULT_AI_PROFILE : null,
    aiState: opponentKind === "ai"
      ? aiState(
        shouldAutoDeployAiOpponent ? "thinking" : "idle",
        "setup.create-game",
        {
          message: shouldAutoDeployAiOpponent
            ? "AI opponent game created; preparing deployment."
            : "AI opponent game created; deploy your fleet, then deploy the AI fleet.",
        },
      )
      : {},
    status: opponentKind === "ai" ? "deploying" : "open",
  }).returning();

  if (shouldAutoDeployAiOpponent) {
    try {
      const deployed = await autoDeployAiOpponent(game.id);
      req.log.info({ gameId: game.id, aiProfile: DEFAULT_AI_PROFILE }, "ai setup auto-deployed opponent fleet");
      res.status(201).json(toGameDto(deployed));
      return;
    } catch (err) {
      req.log.error({ err, gameId: game.id, aiProfile: DEFAULT_AI_PROFILE }, "ai setup failed");
      const [failed] = await db.update(gamesTable).set({
        aiState: aiErrorState("setup.auto-deploy", err),
      }).where(eq(gamesTable.id, game.id)).returning();
      res.status(201).json(toGameDto(failed ?? game));
      return;
    }
  }

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
  // direct link; members of a non-open game see it as before. In development,
  // the non-challenger built-in commander may view an AI game as the AI side.
  const [game] = await db
    .select()
    .from(gamesTable)
    .where(eq(gamesTable.id, params.data.gameId));
  if (!game) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  if (game.archiveExpiresAt && game.archiveExpiresAt > new Date()) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  const canView =
    game.status === "open" ||
    game.challengerId === userId ||
    game.opponentId === userId ||
    isDevAiCommander(game, userId);
  if (!canView) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  const units = await db.select().from(gameUnitsTable).where(eq(gameUnitsTable.gameId, params.data.gameId));
  const turns = await db.select().from(turnsTable).where(eq(turnsTable.gameId, params.data.gameId)).orderBy(turnsTable.turnNumber);
  const shipIds = [...new Set(units.map(u => u.shipId))];
  const unitShips = shipIds.length === 0 ? [] : await db.select().from(shipsTable).where(inArray(shipsTable.id, shipIds));
  const shipModelIdByShipId = new Map(unitShips.map(ship => [ship.id, ship.shipModelId]));
  const shipModelIds = [...new Set(unitShips.map(ship => ship.shipModelId))];
  const unitShipModels = shipModelIds.length === 0 ? [] : await db.select().from(shipModelsTable).where(inArray(shipModelsTable.id, shipModelIds));
  const shipModelById = new Map(unitShipModels.map(model => [model.id, model]));
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
  const unitsWithCrits = units.map(u => {
    const rows = critsByUnit.get(u.id) ?? [];
    const model = shipModelById.get(shipModelIdByShipId.get(u.shipId) ?? 0);
    return {
      ...u,
      shipModelId: shipModelIdByShipId.get(u.shipId) ?? 0,
      // Centralized adrift overlay — see `effectiveDamageState` for the
      // why. Used here AND by every mutation route that echoes a unit row,
      // so all consumers see the same canonical state.
      damageState: effectiveDamageState(u.damageState, rows),
      criticals: rows,
      // Slice C derived flags — surfaced to the client so badges can render
      // without re-deriving the rule.
      isCrippled: model && shipModelIsFighter(model) ? false : isCrippledUnit(u),
      isSkeletonCrew: isSkeletonCrewUnit(u),
    };
  });
  res.json(GetGameResponse.parse({ game: toGameDto(game), units: unitsWithCrits, turns }));
});

router.get("/games/:gameId/chat", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = GetGameParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const [game] = await db.select().from(gamesTable).where(eq(gamesTable.id, params.data.gameId));
    if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
    const canChat = game.opponentKind !== "ai" && (game.challengerId === userId || game.opponentId === userId);
    if (!canChat) throw Object.assign(new Error("Game not found"), { status: 404 });

    const latest = await db
      .select()
      .from(gameChatMessagesTable)
      .where(eq(gameChatMessagesTable.gameId, game.id))
      .orderBy(desc(gameChatMessagesTable.createdAt), desc(gameChatMessagesTable.id))
      .limit(50);
    res.json({ messages: latest.reverse() });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

router.post("/games/:gameId/chat", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = GetGameParams.safeParse(req.params);
  const body = parseGameChatBody(req.body ?? {});
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error });
    return;
  }

  try {
    const [game] = await db.select().from(gamesTable).where(eq(gamesTable.id, params.data.gameId));
    if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
    const canChat = game.opponentKind !== "ai" && (game.challengerId === userId || game.opponentId === userId);
    if (!canChat) throw Object.assign(new Error("Game not found"), { status: 404 });

    const senderName =
      userId === game.challengerId ? game.challengerName :
      userId === game.opponentId ? game.opponentName :
      null;
    const [message] = await db.insert(gameChatMessagesTable).values({
      gameId: game.id,
      senderPlayerId: userId,
      senderName,
      message: body.data.message,
    }).returning();
    res.status(201).json({ message });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

router.post("/games/:gameId/bug-report", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = GetGameParams.safeParse(req.params);
  const body = parseReportBugBody(req.body ?? {});
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM games WHERE id = ${params.data.gameId} FOR UPDATE`);
      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, params.data.gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      const canReport =
        game.challengerId === userId ||
        game.opponentId === userId ||
        isDevAiCommander(game, userId);
      if (!canReport) throw Object.assign(new Error("Game not found"), { status: 404 });

      const units = await tx.select().from(gameUnitsTable).where(eq(gameUnitsTable.gameId, game.id));
      const activeUnit = game.activeUnitId ? units.find(u => u.id === game.activeUnitId) ?? null : null;
      const selectedUnitId =
        typeof body.data.clientSnapshot?.selectedUnitId === "number"
          ? body.data.clientSnapshot.selectedUnitId
          : null;
      const selectedUnit = selectedUnitId ? units.find(u => u.id === selectedUnitId) ?? null : null;
      const focusUnit = activeUnit ?? selectedUnit;
      const unitIds = units.map(u => u.id);
      const critRows = unitIds.length > 0
        ? await tx.select().from(unitCriticalEffectsTable).where(inArray(unitCriticalEffectsTable.gameUnitId, unitIds))
        : [];
      const criticalsByUnit = new Map<number, Array<Record<string, unknown>>>();
      for (const crit of critRows) {
        const list = criticalsByUnit.get(crit.gameUnitId) ?? [];
        list.push({
          id: crit.id,
          effectKey: crit.effectKey,
          location: crit.location,
          name: crit.name,
          damageApplied: crit.damageApplied,
          crewApplied: crit.crewApplied,
          randomArc: crit.randomArc,
          randomWeaponId: crit.randomWeaponId,
          lostTraits: crit.lostTraits,
          appliedRound: crit.appliedRound,
          repairable: crit.repairable,
        });
        criticalsByUnit.set(crit.gameUnitId, list);
      }
      const unitStateWithCriticals = (unit: typeof gameUnitsTable.$inferSelect): Record<string, unknown> => ({
        ...unitAuditState(unit),
        criticalEffects: criticalsByUnit.get(unit.id) ?? [],
      });
      const nearbyUnits = focusUnit
        ? units
          .filter(u => u.id !== focusUnit.id)
          .map(u => ({
            ...unitStateWithCriticals(u),
            distanceFromFocus: Number(Math.hypot(u.hexQ - focusUnit.hexQ, u.hexR - focusUnit.hexR).toFixed(3)),
          }))
          .sort((a, b) => Number(a.distanceFromFocus) - Number(b.distanceFromFocus))
          .slice(0, 12)
        : [];
      const [recentMoves, recentAttacks, recentSpecialActions] = await Promise.all([
        tx.select({
          id: gameMovementAuditLogsTable.id,
          round: gameMovementAuditLogsTable.round,
          phase: gameMovementAuditLogsTable.phase,
          actorKind: gameMovementAuditLogsTable.actorKind,
          actorPlayerId: gameMovementAuditLogsTable.actorPlayerId,
          unitId: gameMovementAuditLogsTable.unitId,
          movementKind: gameMovementAuditLogsTable.movementKind,
          summary: gameMovementAuditLogsTable.summary,
          payload: gameMovementAuditLogsTable.payload,
          createdAt: gameMovementAuditLogsTable.createdAt,
        }).from(gameMovementAuditLogsTable)
          .where(eq(gameMovementAuditLogsTable.gameId, game.id))
          .orderBy(desc(gameMovementAuditLogsTable.createdAt), desc(gameMovementAuditLogsTable.id))
          .limit(8),
        tx.select({
          id: gameAttackAuditLogsTable.id,
          round: gameAttackAuditLogsTable.round,
          phase: gameAttackAuditLogsTable.phase,
          actorKind: gameAttackAuditLogsTable.actorKind,
          actorPlayerId: gameAttackAuditLogsTable.actorPlayerId,
          attackerUnitId: gameAttackAuditLogsTable.attackerUnitId,
          targetUnitId: gameAttackAuditLogsTable.targetUnitId,
          weaponId: gameAttackAuditLogsTable.weaponId,
          summary: gameAttackAuditLogsTable.summary,
          payload: gameAttackAuditLogsTable.payload,
          createdAt: gameAttackAuditLogsTable.createdAt,
        }).from(gameAttackAuditLogsTable)
          .where(eq(gameAttackAuditLogsTable.gameId, game.id))
          .orderBy(desc(gameAttackAuditLogsTable.createdAt), desc(gameAttackAuditLogsTable.id))
          .limit(8),
        tx.select({
          id: gameSpecialActionAuditLogsTable.id,
          round: gameSpecialActionAuditLogsTable.round,
          phase: gameSpecialActionAuditLogsTable.phase,
          actorKind: gameSpecialActionAuditLogsTable.actorKind,
          actorPlayerId: gameSpecialActionAuditLogsTable.actorPlayerId,
          unitId: gameSpecialActionAuditLogsTable.unitId,
          action: gameSpecialActionAuditLogsTable.action,
          success: gameSpecialActionAuditLogsTable.success,
          targetUnitId: gameSpecialActionAuditLogsTable.targetUnitId,
          summary: gameSpecialActionAuditLogsTable.summary,
          payload: gameSpecialActionAuditLogsTable.payload,
          createdAt: gameSpecialActionAuditLogsTable.createdAt,
        }).from(gameSpecialActionAuditLogsTable)
          .where(eq(gameSpecialActionAuditLogsTable.gameId, game.id))
          .orderBy(desc(gameSpecialActionAuditLogsTable.createdAt), desc(gameSpecialActionAuditLogsTable.id))
          .limit(8),
      ]);
      const rescuePhase = game.phase === "movement" || game.phase === "firing";
      const reporterCanRescue =
        game.activePlayerId === userId ||
        (game.opponentKind === "ai" && game.activePlayerId === AI_OPPONENT_ID && game.challengerId === userId);
      const rescueApplied = Boolean(body.data.rescueRequested && game.status === "active" && rescuePhase && reporterCanRescue);
      const reportSnapshot = {
        game: {
          id: game.id,
          status: game.status,
          round: game.currentRound,
          turn: game.currentTurn,
          phase: game.phase,
          activePlayerId: game.activePlayerId,
          activeUnitId: game.activeUnitId,
          initiativeWinnerId: game.initiativeWinnerId,
          challengerId: game.challengerId,
          opponentId: game.opponentId,
          opponentKind: game.opponentKind,
        },
        reporter: {
          playerId: userId,
          canRescue: reporterCanRescue,
        },
        rescue: {
          requested: body.data.rescueRequested,
          applied: rescueApplied,
          eligiblePhase: rescuePhase,
        },
        activeUnit: activeUnit ? unitStateWithCriticals(activeUnit) : null,
        selectedUnit: selectedUnit ? unitStateWithCriticals(selectedUnit) : null,
        focusUnitId: focusUnit?.id ?? null,
        nearbyUnits,
        units: units.map(unitStateWithCriticals),
        auditTail: {
          movement: recentMoves.reverse(),
          attacks: recentAttacks.reverse(),
          specialActions: recentSpecialActions.reverse(),
        },
        client: body.data.clientSnapshot,
      };

      const [report] = await tx.insert(bugReportsTable).values({
        gameId: game.id,
        reporterPlayerId: userId,
        round: game.currentRound,
        phase: game.phase,
        activePlayerId: game.activePlayerId,
        activeUnitId: game.activeUnitId,
        message: body.data.message,
        rescueRequested: body.data.rescueRequested,
        rescueApplied,
        snapshot: reportSnapshot,
      }).returning();

      const baseAiState = game.aiState && typeof game.aiState === "object" && !Array.isArray(game.aiState)
        ? game.aiState as Record<string, unknown>
        : {};
      const reporterName =
        userId === game.challengerId ? game.challengerName :
        userId === game.opponentId ? game.opponentName :
        userId === AI_OPPONENT_ID ? AI_OPPONENT_NAME :
        "A player";
      const notification = {
        id: report.id,
        at: nowIso(),
        reporterPlayerId: userId,
        reporterName,
        round: game.currentRound,
        phase: game.phase,
        activePlayerId: game.activePlayerId,
        activeUnitId: game.activeUnitId,
        activeUnitName: activeUnit?.name ?? null,
        message: body.data.message,
        rescueRequested: body.data.rescueRequested,
        rescueApplied,
      };
      const nextAiState = {
        ...baseAiState,
        lastBugRescue: notification,
        bugReports: [
          notification,
          ...(Array.isArray(baseAiState.bugReports) ? baseAiState.bugReports : []),
        ].slice(0, 5),
      };

      if (rescueApplied) {
        const rescueActorId = game.activePlayerId ?? userId;
        const otherPlayerId =
          rescueActorId === game.challengerId
            ? game.opponentId
            : game.challengerId;
        if (game.activeUnitId) {
          await tx.update(gameUnitsTable)
            .set(game.phase === "firing" ? { hasFiredThisRound: true } : { hasMovedThisRound: true })
            .where(and(eq(gameUnitsTable.id, game.activeUnitId), eq(gameUnitsTable.gameId, game.id)));
        }
        const [updated] = await tx.update(gamesTable).set({
          activeUnitId: null,
          activePlayerId: otherPlayerId ?? null,
          lastActivatorId: rescueActorId,
          aiState: nextAiState,
        }).where(eq(gamesTable.id, game.id)).returning();
        return { game: updated, report, rescueApplied };
      }

      const [updated] = await tx.update(gamesTable).set({
        aiState: nextAiState,
      }).where(eq(gamesTable.id, game.id)).returning();
      return { game: updated, report, rescueApplied };
    });

    res.json({
      game: toGameDto(result.game),
      report: result.report,
      rescueApplied: result.rescueApplied,
    });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

router.get("/games/:gameId/attack-audit-log", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = GetGameParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [game] = await db
    .select()
    .from(gamesTable)
    .where(eq(gamesTable.id, params.data.gameId));
  if (!game) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  const canView =
    game.challengerId === userId ||
    game.opponentId === userId ||
    isDevAiCommander(game, userId);
  if (!canView) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  const rawLimit = Number(req.query["limit"] ?? 250);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(1000, Math.trunc(rawLimit))) : 250;
  const rows = await db
    .select()
    .from(gameAttackAuditLogsTable)
    .where(eq(gameAttackAuditLogsTable.gameId, params.data.gameId))
    .orderBy(sql`created_at ASC`, sql`id ASC`)
    .limit(limit);
  res.json({ gameId: params.data.gameId, count: rows.length, logs: rows });
});

router.get("/games/:gameId/movement-audit-log", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = GetGameParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [game] = await db
    .select()
    .from(gamesTable)
    .where(eq(gamesTable.id, params.data.gameId));
  if (!game) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  const canView =
    game.challengerId === userId ||
    game.opponentId === userId ||
    isDevAiCommander(game, userId);
  if (!canView) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  const rawLimit = Number(req.query["limit"] ?? 250);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(1000, Math.trunc(rawLimit))) : 250;
  const rows = await db
    .select()
    .from(gameMovementAuditLogsTable)
    .where(eq(gameMovementAuditLogsTable.gameId, params.data.gameId))
    .orderBy(sql`created_at ASC`, sql`id ASC`)
    .limit(limit);
  res.json({ gameId: params.data.gameId, count: rows.length, logs: rows });
});

router.get("/games/:gameId/special-action-audit-log", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = GetGameParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [game] = await db
    .select()
    .from(gamesTable)
    .where(eq(gamesTable.id, params.data.gameId));
  if (!game) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  const canView =
    game.challengerId === userId ||
    game.opponentId === userId ||
    isDevAiCommander(game, userId);
  if (!canView) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  const rawLimit = Number(req.query["limit"] ?? 250);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(1000, Math.trunc(rawLimit))) : 250;
  const rows = await db
    .select()
    .from(gameSpecialActionAuditLogsTable)
    .where(eq(gameSpecialActionAuditLogsTable.gameId, params.data.gameId))
    .orderBy(sql`created_at ASC`, sql`id ASC`)
    .limit(limit);
  res.json({ gameId: params.data.gameId, count: rows.length, logs: rows });
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
          .set({ status: "deploying", opponentId: userId, opponentKind: "human", opponentName: me?.username ?? null })
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

// Abandon: pre-start exit that never records a battle result. If the challenger
// abandons, the setup is closed as declined. If an opponent abandons a claimed
// open game during deployment, remove their deployment and return the game to
// open so another commander can join.
router.post("/games/:gameId/abandon", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = GetGameParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM games WHERE id = ${params.data.gameId} FOR UPDATE`);
      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, params.data.gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (game.challengerId !== userId && game.opponentId !== userId) {
        throw Object.assign(new Error("Game not found"), { status: 404 });
      }
      if (game.status !== "open" && game.status !== "pending" && game.status !== "deploying") {
        throw Object.assign(new Error(`Cannot abandon from status '${game.status}'`), { status: 400 });
      }

      const unitRows = await tx.select({ id: gameUnitsTable.id }).from(gameUnitsTable).where(and(
        eq(gameUnitsTable.gameId, game.id),
        eq(gameUnitsTable.ownerId, userId),
      ));
      if (unitRows.length > 0) {
        await tx.delete(unitCriticalEffectsTable)
          .where(inArray(unitCriticalEffectsTable.gameUnitId, unitRows.map(u => u.id)));
        await tx.delete(gameUnitsTable).where(and(
          eq(gameUnitsTable.gameId, game.id),
          eq(gameUnitsTable.ownerId, userId),
        ));
      }

      if (userId === game.challengerId) {
        const [row] = await tx.update(gamesTable).set({
          status: "declined",
          activePlayerId: null,
          activeUnitId: null,
          challengerDeployed: false,
        }).where(eq(gamesTable.id, game.id)).returning();
        return row;
      }

      if (game.status === "deploying") {
        const [row] = await tx.update(gamesTable).set({
          status: "open",
          opponentId: null,
          opponentName: null,
          opponentKind: "human",
          opponentFleetId: null,
          opponentDeployed: false,
          activePlayerId: null,
          activeUnitId: null,
        }).where(eq(gamesTable.id, game.id)).returning();
        return row;
      }

      const [row] = await tx.update(gamesTable).set({
        status: "declined",
        opponentDeployed: false,
        activePlayerId: null,
        activeUnitId: null,
      }).where(eq(gamesTable.id, game.id)).returning();
      return row;
    });
    res.json(toGameDto(updated));
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

// Surrender: a player concedes an active game. Per the
// user's product spec, surrender both ends the match AND wipes the record so
// the game vanishes from Active Operations and never shows up in Recent
// Engagements. We delete child rows manually because the schema's FKs aren't
// configured with ON DELETE CASCADE (see lib/db/src/schema/games.ts).
router.post("/games/:gameId/surrender", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = GetGameParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM games WHERE id = ${params.data.gameId} FOR UPDATE`);
      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, params.data.gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (game.challengerId !== userId && game.opponentId !== userId) {
        // 404 (not 403) to avoid leaking the existence of games this user
        // isn't party to.
        throw Object.assign(new Error("Game not found"), { status: 404 });
      }
      if (game.status !== "active") {
        throw Object.assign(new Error(`Cannot surrender from status '${game.status}'`), { status: 400 });
      }

      // Manual cascade: crit effects → units → turns → game. Crit effects
      // reference gameUnitId, so they must go before gameUnits.
      const unitRows = await tx.select({ id: gameUnitsTable.id }).from(gameUnitsTable)
        .where(eq(gameUnitsTable.gameId, params.data.gameId));
      if (unitRows.length > 0) {
        await tx.delete(unitCriticalEffectsTable)
          .where(or(...unitRows.map(u => eq(unitCriticalEffectsTable.gameUnitId, u.id))));
      }
      await tx.delete(gameUnitsTable).where(eq(gameUnitsTable.gameId, params.data.gameId));
      await tx.delete(turnsTable).where(eq(turnsTable.gameId, params.data.gameId));
      await tx.delete(gamesTable).where(eq(gamesTable.id, params.data.gameId));
    });
    res.status(204).end();
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

// Concede: a player throws in the towel and grants victory to their opponent
// while preserving the game record (vs. /surrender, which wipes the record
// entirely). Concession is only valid once the engagement is active; during
// deployment there may be zero units on the board, and allowing concession
// there can accidentally complete a not-yet-started game.
router.post("/games/:gameId/concede", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = GetGameParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM games WHERE id = ${params.data.gameId} FOR UPDATE`);
      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, params.data.gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (game.challengerId !== userId && game.opponentId !== userId) {
        // 404 (not 403) to avoid leaking the existence of games this user
        // isn't party to.
        throw Object.assign(new Error("Game not found"), { status: 404 });
      }
      if (game.status !== "active") {
        throw Object.assign(new Error(`Cannot concede from status '${game.status}'`), { status: 400 });
      }
      // Winner is the OTHER party. If the opponent slot is somehow empty
      // (e.g. solo deploying state), fall back to null winner — the match
      // is just recorded as completed without a victor.
      const winnerId = userId === game.challengerId ? game.opponentId : game.challengerId;
      const [row] = await tx.update(gamesTable)
        .set({ status: "completed", winnerId: winnerId ?? null })
        .where(eq(gamesTable.id, params.data.gameId))
        .returning();
      return row;
    });
    res.json(updated);
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
    req.log.warn({ body: req.body, zod: parsed.error.issues }, "deploy body failed zod");
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.placements.length === 0) {
    res.status(400).json({ error: "You must deploy at least one ship." });
    return;
  }
  req.log.info({ body: parsed.data }, "deploy body parsed");
  // Whole deploy flow is wrapped in a transaction with SELECT FOR UPDATE on
  // the game row. Without the lock, a concurrent POST /surrender could delete
  // the game row between our status check and our gameUnits inserts, leaving
  // orphaned units pointing at a deleted gameId (FKs aren't ON DELETE CASCADE
  // here — see lib/db/src/schema/games.ts). Read-only ship_model / fleet
  // lookups stay outside the lock-critical section since they don't affect
  // game lifecycle.
  let updated: typeof gamesTable.$inferSelect;
  try {
    updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM games WHERE id = ${params.data.gameId} FOR UPDATE`);
      const [game] = await tx
        .select()
        .from(gamesTable)
        .where(eq(gamesTable.id, params.data.gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      const playerUserId = effectiveGameUserId(game, userId);
      if (game.challengerId !== playerUserId && game.opponentId !== playerUserId) {
        throw Object.assign(new Error("Game not found"), { status: 404 });
      }
      const devAiRedeploy = isDevAiCommander(game, userId);
      if (game.status !== "deploying") {
        throw Object.assign(new Error("Game is not in deploying phase"), { status: 400 });
      }

      const isChallenger = game.challengerId === playerUserId;
      if (isChallenger && game.challengerDeployed) {
        throw Object.assign(new Error("Challenger fleet is already deployed"), { status: 400 });
      }
      if (!isChallenger && game.opponentDeployed && !devAiRedeploy) {
        throw Object.assign(new Error("Opponent fleet is already deployed"), { status: 400 });
      }
      let fleetId: number | null = parsed.data.fleetId ?? null;
      let ships: typeof shipsTable.$inferSelect[];

      if (fleetId !== null) {
        // Saved-fleet path: validate ownership, load the fleet's ships.
        const [fleet] = await tx.select().from(fleetsTable).where(and(eq(fleetsTable.id, fleetId), eq(fleetsTable.ownerId, userId)));
        if (!fleet) throw Object.assign(new Error("Fleet not found"), { status: 404 });
        ships = await tx.select().from(shipsTable).where(eq(shipsTable.fleetId, fleetId));
      } else {
        // Direct-drop path: each placement must carry a shipModelId. We
        // materialize an ephemeral fleet + Ship rows so all downstream FKs
        // (gameUnits.shipId → ships → ship_models) keep working without
        // schema churn. Naming is "Direct Deploy — Game #N" to make it
        // obvious in the Fleet Manager that the player can clean it up
        // (or keep it as a starter fleet).
        const missing = parsed.data.placements.find(p => !p.shipModelId);
        if (missing) {
          throw Object.assign(new Error("Each placement requires either a fleetId+shipId pair or a shipModelId."), { status: 400 });
        }
        const modelIds = [...new Set(parsed.data.placements.map(p => p.shipModelId!))];
        const models = await tx.select().from(shipModelsTable).where(inArray(shipModelsTable.id, modelIds));
        const modelById = new Map(models.map(m => [m.id, m]));
        for (const id of modelIds) {
          if (!modelById.has(id)) {
            throw Object.assign(new Error(`Unknown shipModelId ${id}`), { status: 400 });
          }
        }
        const [newFleet] = await tx.insert(fleetsTable).values({
          ownerId: userId,
          name: `Direct Deploy — Game #${game.id}`,
        }).returning();
        fleetId = newFleet.id;
        const shipRows = parsed.data.placements.map(p => ({
          fleetId: newFleet.id,
          shipModelId: p.shipModelId!,
          name: modelById.get(p.shipModelId!)!.name,
        }));
        ships = await tx.insert(shipsTable).values(shipRows).returning();
        // Rewrite each placement's shipId to point at the freshly-inserted
        // ship row (matched 1:1 by index so duplicates of the same model
        // each get their own row).
        parsed.data.placements = parsed.data.placements.map((p, i) => ({
          ...p, shipId: ships[i]!.id,
        }));
      }

      const placedShips = parsed.data.placements.map((placement) => {
        const ship = ships.find(s => s.id === placement.shipId);
        if (!ship) {
          throw Object.assign(new Error("Every deployed placement must reference a ship in your selected fleet."), { status: 400 });
        }
        return ship;
      });
      const placedShipModelIds = [...new Set(placedShips.map(ship => ship.shipModelId))];
      const placedModels = await tx.select().from(shipModelsTable).where(inArray(shipModelsTable.id, placedShipModelIds));
      const placedModelById = new Map(placedModels.map(model => [model.id, model]));
      const placedModelByShipId = new Map<number, typeof shipModelsTable.$inferSelect>();
      for (const ship of placedShips) {
        const model = placedModelById.get(ship.shipModelId);
        if (!model) {
          throw Object.assign(new Error(`Ship model ${ship.shipModelId} was not found.`), { status: 400 });
        }
        placedModelByShipId.set(ship.id, model);
      }
      const fighterInventoryModels = await tx.select({
        id: shipModelsTable.id,
        name: shipModelsTable.name,
      }).from(shipModelsTable);
      const predeployedFighterLinks = new Map<number, number>();
      const predeployedByCarrierIndex = new Map<number, number>();
      const predeployedByCarrierAndModel = new Map<string, number>();
      for (let index = 0; index < parsed.data.placements.length; index += 1) {
        const placement = parsed.data.placements[index]!;
        const carrierIndex = placement.launchedFromPlacementIndex;
        if (carrierIndex == null) continue;
        if (!Number.isInteger(carrierIndex) || carrierIndex < 0 || carrierIndex >= parsed.data.placements.length || carrierIndex === index) {
          throw Object.assign(new Error("Invalid carrier placement link for deployed fighter"), { status: 400 });
        }
        const carrierPlacement = parsed.data.placements[carrierIndex]!;
        if (carrierPlacement.launchedFromPlacementIndex != null) {
          throw Object.assign(new Error("A deployed fighter cannot act as another fighter's carrier"), { status: 400 });
        }
        const fighterShip = placedShips[index];
        const carrierShip = placedShips[carrierIndex];
        const fighterModel = fighterShip ? placedModelByShipId.get(fighterShip.id) : undefined;
        const carrierModel = carrierShip ? placedModelByShipId.get(carrierShip.id) : undefined;
        if (!fighterShip || !carrierShip || !fighterModel || !carrierModel) {
          throw Object.assign(new Error("Invalid fighter deployment carrier link"), { status: 400 });
        }
        if (!shipModelIsFighter(fighterModel)) {
          throw Object.assign(new Error("Only fighter flights can be deployed from a carrier"), { status: 400 });
        }
        if (shipModelIsFighter(carrierModel)) {
          throw Object.assign(new Error("Fighter flights cannot carry deployed fighters"), { status: 400 });
        }
        const distance = edgeDistance(
          { x: placement.hexQ, z: placement.hexR, baseRadiusInches: rulesBaseRadius(fighterModel) },
          { x: carrierPlacement.hexQ, z: carrierPlacement.hexR, baseRadiusInches: rulesBaseRadius(carrierModel) },
        );
        if (distance > 3 + 1e-6) {
          throw Object.assign(new Error("Deployed carried fighters must be placed within 3 inches of their carrier"), { status: 400 });
        }
        const inventory = carriedFightersFromSmallCraft(carrierModel.smallCraft, fighterInventoryModels);
        const item = inventory.find(candidate => candidate.shipModelId === fighterModel.id);
        if (!item) {
          throw Object.assign(new Error(`${carrierModel.name} does not carry ${fighterModel.name}`), { status: 400 });
        }
        const usedByCarrier = predeployedByCarrierIndex.get(carrierIndex) ?? 0;
        const limit = prebattleFighterDeploymentLimit(inventory, carrierModel);
        if (usedByCarrier >= limit) {
          throw Object.assign(new Error(`Pre-battle fighter deployment limit exceeded for ${carrierModel.name}`), { status: 400 });
        }
        const modelKey = `${carrierIndex}:${fighterModel.id}`;
        const usedByModel = predeployedByCarrierAndModel.get(modelKey) ?? 0;
        if (usedByModel >= item.total) {
          throw Object.assign(new Error(`${carrierModel.name} has no remaining ${fighterModel.name} flights to deploy`), { status: 400 });
        }
        predeployedFighterLinks.set(index, carrierIndex);
        predeployedByCarrierIndex.set(carrierIndex, usedByCarrier + 1);
        predeployedByCarrierAndModel.set(modelKey, usedByModel + 1);
      }
      const scenarioPriority = normalizePriorityLevel(game.priorityLevel);
      const allocation = calculateAllocation(
        placedShips
          .filter((_ship, index) => !predeployedFighterLinks.has(index))
          .map(ship => normalizePriorityLevel(placedModelByShipId.get(ship.id)?.priorityLevel)),
        scenarioPriority,
        game.allocationPoints,
      );
      if (!allocation.legal) {
        throw Object.assign(new Error(
          `Fleet exceeds ${priorityLabel(scenarioPriority)} ${game.allocationPoints} FAP: ` +
          `${formatAllocationTicks(allocation.spentTicks)} spent, ` +
          `${formatAllocationTicks(allocation.budgetTicks)} allowed.`,
        ), { status: 400 });
      }

      // Zone validation: challenger deploys from +Z short edge, opponent from -Z.
      // hexQ/hexR are stored as world inches (see game-board.tsx handleYardsDeploy).
      // Board is 48"×72"; placements must stay inside the player's deployment zone.
      const D = game.deploymentDepth;
      const zoneMinR = isChallenger ? 36 - D : -36;
      const zoneMaxR = isChallenger ? 36 : -36 + D;
      for (const placement of parsed.data.placements) {
        if (placement.hexQ < -24 || placement.hexQ > 24 || placement.hexR < zoneMinR || placement.hexR > zoneMaxR) {
          req.log.warn({ placement, isChallenger, zoneMinR, zoneMaxR, D }, "placement outside zone");
          throw Object.assign(new Error(
            `Placement (${placement.hexQ}, ${placement.hexR}) is outside your ${D}\" deployment zone (allowed: hexQ ∈ [-24, 24], hexR ∈ [${zoneMinR}, ${zoneMaxR}]).`,
          ), { status: 400 });
        }
      }

      const existingUnits = await tx.select().from(gameUnitsTable).where(and(
        eq(gameUnitsTable.gameId, params.data.gameId),
        eq(gameUnitsTable.isDestroyed, false),
      ));
      if (devAiRedeploy) {
        await tx.delete(gameUnitsTable).where(and(
          eq(gameUnitsTable.gameId, params.data.gameId),
          eq(gameUnitsTable.ownerId, AI_OPPONENT_ID),
        ));
      }
      const existingFootprints: UnitFootprint[] = [];
      for (const existing of existingUnits) {
        if (devAiRedeploy && existing.ownerId === AI_OPPONENT_ID) continue;
        const [existingShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, existing.shipId));
        if (!existingShip) continue;
        const [existingModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, existingShip.shipModelId));
        existingFootprints.push({
          id: existing.id,
          ownerId: existing.ownerId,
          x: existing.hexQ,
          z: existing.hexR,
          baseRadiusInches: rulesBaseRadius(existing),
          isFighter: existingModel ? shipModelIsFighter(existingModel) : false,
        });
      }
      const pendingFootprints: UnitFootprint[] = [];
      parsed.data.placements.forEach((placement, index) => {
        const ship = placedShips[index];
        const model = ship ? placedModelByShipId.get(ship.id) : undefined;
        if (!ship || !model) return;
        pendingFootprints.push({
          id: -1 - index,
          ownerId: playerUserId,
          x: placement.hexQ,
          z: placement.hexR,
          baseRadiusInches: rulesBaseRadius(model),
          isFighter: shipModelIsFighter(model),
        });
      });
      for (const candidate of pendingFootprints) {
        const illegalExisting = findIllegalBaseOverlap(candidate, existingFootprints);
        if (illegalExisting) {
          throw Object.assign(new Error("Deployment overlaps another base illegally"), { status: 400 });
        }
        const illegalPending = findIllegalBaseOverlap(candidate, pendingFootprints);
        if (illegalPending) {
          throw Object.assign(new Error("Deployment contains overlapping bases"), { status: 400 });
        }
      }

      // Crew Quality assignment: in "standard" games the server forces every ship
      // to CQ 4 regardless of what the client sent (cheap defense against a hand-
      // crafted request bumping CQ in a fixed-quality match). In "custom" games
      // we honor the per-ship value, defaulting to 4 if omitted, clamped to 1..7.
      const isStandardCQ = game.crewQualityMode !== "custom";

      const insertedUnitsByPlacementIndex = new Map<number, typeof gameUnitsTable.$inferSelect>();
      for (let index = 0; index < parsed.data.placements.length; index += 1) {
        const placement = parsed.data.placements[index]!;
        const ship = ships.find(s => s.id === placement.shipId);
        if (!ship) continue;
        const model = placedModelByShipId.get(ship.id);
        if (!model) continue;
        const requestedCQ = placement.crewQuality ?? 4;
        const modelTraits = parseShipTraits(model.traits);
        const crewQuality = modelTraits.ancient
          ? 7
          : isStandardCQ
          ? 4
          : Math.max(1, Math.min(7, Math.trunc(requestedCQ)));
        const [inserted] = await tx.insert(gameUnitsTable).values({
          gameId: params.data.gameId,
          ownerId: playerUserId,
          shipId: ship.id,
          name: ship.name,
          modelFilename: model.filename,
          faction: model.faction,
          baseRadiusInches: model.baseRadiusInches,
          hullPoints: model.hullPoints,
          maxHullPoints: model.hullPoints,
          damageThreshold: model.damageThreshold ?? Math.ceil(model.hullPoints / 2),
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
          // Interceptors start the engagement at full pool, threshold 2+.
          interceptorDiceRemaining: modelTraits.interceptors,
          interceptorThresholdCurrent: 2,
          // Crew defaults from the ship_model record. Used by Skeleton-Crew /
          // damage-table logic in Slice C.
          crewPoints: model.crew ?? 0,
          maxCrewPoints: model.crew ?? 0,
          crewThreshold: model.crewThreshold ?? (model.crew ? Math.ceil(model.crew / 2) : 0),
          damageState: "normal",
          carriedFighters: predeployedFighterLinks.has(index)
            ? []
            : carriedFightersFromSmallCraft(model.smallCraft, fighterInventoryModels),
          launchedFromUnitId: null,
          isDestroyed: false,
        }).returning();
        if (inserted) insertedUnitsByPlacementIndex.set(index, inserted);
      }

      const carrierInventoryByUnitId = new Map<number, CarriedFighterInventoryItem[]>();
      for (const [fighterIndex, carrierIndex] of predeployedFighterLinks.entries()) {
        const fighterUnit = insertedUnitsByPlacementIndex.get(fighterIndex);
        const carrierUnit = insertedUnitsByPlacementIndex.get(carrierIndex);
        if (!fighterUnit || !carrierUnit) {
          throw Object.assign(new Error("Failed to link deployed fighter to carrier"), { status: 500 });
        }
        const fighterShip = placedShips[fighterIndex];
        const fighterModel = fighterShip ? placedModelByShipId.get(fighterShip.id) : undefined;
        if (!fighterModel) throw Object.assign(new Error("Fighter model missing during deploy"), { status: 500 });
        const currentInventory = carrierInventoryByUnitId.get(carrierUnit.id)
          ?? (Array.isArray(carrierUnit.carriedFighters) ? carrierUnit.carriedFighters as CarriedFighterInventoryItem[] : []);
        const itemIndex = currentInventory.findIndex(item => item.shipModelId === fighterModel.id && item.available > 0);
        if (itemIndex === -1) {
          throw Object.assign(new Error(`Carrier inventory exhausted for ${fighterModel.name}`), { status: 400 });
        }
        const nextInventory = updateFighterInventoryItem(currentInventory, itemIndex, item => ({
          ...item,
          available: Math.max(0, item.available - 1),
          launched: item.launched + 1,
        }));
        carrierInventoryByUnitId.set(carrierUnit.id, nextInventory);
        await tx.update(gameUnitsTable)
          .set({ carriedFighters: nextInventory })
          .where(eq(gameUnitsTable.id, carrierUnit.id));
        await tx.update(gameUnitsTable)
          .set({ launchedFromUnitId: carrierUnit.id })
          .where(eq(gameUnitsTable.id, fighterUnit.id));
      }

      const deployedUnitIds = (await tx.select({ id: gameUnitsTable.id }).from(gameUnitsTable).where(and(
        eq(gameUnitsTable.gameId, params.data.gameId),
        eq(gameUnitsTable.ownerId, playerUserId),
      ))).map(row => row.id);
      const updateData = isChallenger
        ? { challengerDeployed: true, challengerFleetId: fleetId! }
        : {
          opponentDeployed: true,
          opponentFleetId: fleetId!,
          ...(playerUserId === AI_OPPONENT_ID
            ? {
              aiProfile: DEFAULT_AI_PROFILE,
              aiState: mergeAiState(game.aiState, aiState("deployed", "setup.dev-manual-deploy", {
                message: `AI-side fleet manually deployed with ${deployedUnitIds.length} ship(s).`,
                fleetId: fleetId!,
                unitIds: deployedUnitIds,
              })),
            }
            : {}),
        };
      let row: typeof game;
      [row] = await tx.update(gamesTable).set(updateData).where(eq(gamesTable.id, params.data.gameId)).returning();

      // If both deployed, start the game in the Initiative phase — both
      // players must roll 2d6 before anyone activates a ship. No active
      // player yet (initiative determines that).
      if (row.challengerDeployed && row.opponentDeployed) {
        const unitCounts = await tx
          .select({
            ownerId: gameUnitsTable.ownerId,
            count: sql<number>`count(*)::int`,
          })
          .from(gameUnitsTable)
          .where(eq(gameUnitsTable.gameId, params.data.gameId))
          .groupBy(gameUnitsTable.ownerId);
        const countByOwner = new Map(unitCounts.map(x => [x.ownerId, Number(x.count)]));
        const challengerUnits = countByOwner.get(row.challengerId) ?? 0;
        const opponentUnits = row.opponentId ? (countByOwner.get(row.opponentId) ?? 0) : 0;
        if (challengerUnits < 1 || opponentUnits < 1) {
          throw Object.assign(new Error("Both commanders must have at least one ship deployed before the engagement can begin."), { status: 400 });
        }
        [row] = await tx.update(gamesTable).set({
          status: "active",
          currentTurn: 1,
          currentRound: 1,
          activePlayerId: null,
          activeUnitId: null,
          lastActivatorId: null,
          phase: "initiative",
          initiativeWinnerId: null,
          initiativeChallengerRoll: null,
          initiativeOpponentRoll: null,
          endPhaseChallengerPassed: false,
          endPhaseOpponentPassed: false,
        }).where(eq(gamesTable.id, params.data.gameId)).returning();
      }
      return row;
    });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
    return;
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
  // "All Stop": ship halts and may not turn this round. Reject any heading
  // change; position changes (½-speed coast) are still allowed because the
  // ledger/UI clamps movement to the SA's speed cap.
  const finalHeading = normalizeHeadingInput(body.data.newHeading, unit.heading);
  {
    const baseAction = (unit.specialAction ?? "").replace(/-failed$/, "");
    if (baseAction === "all-stop" && finalHeading !== unit.heading) {
      res.status(400).json({ error: "All Stop forbids turning this round" }); return;
    }
  }
  // Adrift-style states (`adrift`, `exploding-end-of-next`) get exactly ONE
  // commander-initiated drift per round: forward along the current heading
  // at exactly floor(speed/2) inches, no turning. We enforce all three
  // invariants here and immediately latch hasMovedThisRound so a second
  // call can't double-drift in the same round.
  //
  // Crit-derived adrift (Engines 6 "Engines Disabled") is treated the same
  // as a hull-zero adrift — without this check a Nova carrying an active
  // engines-disabled crit could still declare normal movement.
  const moveCritRows = await db.select().from(unitCriticalEffectsTable)
    .where(eq(unitCriticalEffectsTable.gameUnitId, unit.id));
  const moveCrits = deriveCritEffects(moveCritRows.map(r => ({
    effectKey: r.effectKey,
    randomArc: r.randomArc,
    randomWeaponId: r.randomWeaponId,
    lostTraits: r.lostTraits ?? [],
  })));
  const [moveShip] = await db.select().from(shipsTable).where(eq(shipsTable.id, unit.shipId));
  if (!moveShip) { res.status(500).json({ error: "Ship record missing" }); return; }
  const [moveModel] = await db.select().from(shipModelsTable).where(eq(shipModelsTable.id, moveShip.shipModelId));
  if (!moveModel) { res.status(500).json({ error: "Ship model missing" }); return; }
  const moveTraits = movementTraitsForModel(moveModel, moveCrits);
  const isMovingFighter = shipModelIsFighter(moveModel);
  const currentSpeedCap = movementSpeedCap(unit, moveCrits, { ignoreCrippled: isMovingFighter });
  const turnProfile = effectiveTurnProfile(unit, moveTraits, { ignoreCrippled: isMovingFighter });
  const isAdriftLike =
    unit.damageState === "adrift"
    || unit.damageState === "exploding-end-of-next"
    || moveCrits.adrift;
  if (isAdriftLike) {
    res.status(400).json({ error: "Adrift drift is resolved automatically in the End Phase" });
    return;
  }

  // Accumulate inches moved this activation. Each /move call is a single
  // path segment (the UI sends one per planned step); summing them gives
  // the total travelled distance enforced by /end-activation. We use
  // hex-Euclidean since hexQ/hexR are stored as world inches.
  const finalHexQ = snapBoardCoord(body.data.toHexQ);
  const finalHexR = snapBoardCoord(body.data.toHexR);
  const requestedStepDq = finalHexQ - unit.hexQ;
  const requestedStepDr = finalHexR - unit.hexR;
  const requestedStepInches = isMovingFighter ? Math.hypot(requestedStepDq, requestedStepDr) : snapHalfInch(Math.hypot(requestedStepDq, requestedStepDr));
  const headingDelta = headingDeltaDegrees(unit.heading, finalHeading);
  const isTurn = headingDelta > 0;
  if (requestedStepInches <= 0 && !isTurn) {
    res.status(400).json({ error: "Move did not change position" });
    return;
  }

  const distanceEpsilon = isMovingFighter ? 0.02 : 1e-6;
  if (unit.inchesMovedThisActivation + requestedStepInches > currentSpeedCap + distanceEpsilon) {
    res.status(400).json({
      error: `Ship may move at most ${currentSpeedCap}" this activation (would move ${unit.inchesMovedThisActivation + requestedStepInches}")`,
    });
    return;
  }
  if (isTurn && !isMovingFighter) {
    if (requestedStepInches > 0) {
      res.status(400).json({ error: "Move forward and turn as separate movement steps" });
      return;
    }
    if (turnProfile.turnsForbidden) {
      res.status(400).json({ error: "Current Special Action forbids turning this round" });
      return;
    }
    if (unit.turnsMadeThisActivation >= turnProfile.maxTurns) {
      res.status(400).json({ error: `Ship may make at most ${turnProfile.maxTurns} turn${turnProfile.maxTurns === 1 ? "" : "s"} this activation` });
      return;
    }
    const sharpTurnAlreadySpent = unit.specialAction === "come-about-sharp-turn" && unit.turnsMadeThisActivation > 0;
    const turnAngleCap = sharpTurnAlreadySpent ? Math.max(0, turnProfile.turnAngle - 45) : turnProfile.turnAngle;
    if (headingDelta > turnAngleCap + 1e-6) {
      res.status(400).json({ error: `Ship may turn at most ${turnAngleCap} degrees at once` });
      return;
    }
    const requiredStraight = turnDistanceRequirement(unit, moveCrits, moveTraits, unit.turnsMadeThisActivation);
    const movedStraight = unit.distanceSinceLastTurnThisActivation;
    if (movedStraight + 1e-6 < requiredStraight) {
      const label = unit.turnsMadeThisActivation === 0 ? "before its first turn" : "after its previous turn";
      res.status(400).json({
        error: `Ship must move ${requiredStraight.toFixed(requiredStraight % 1 === 0 ? 0 : 1)}" straight ${label} (moved ${movedStraight}")`,
      });
      return;
    }
  }

  const candidateFootprint: UnitFootprint = {
    id: unit.id,
    ownerId: unit.ownerId,
    x: body.data.toHexQ,
    z: body.data.toHexR,
    baseRadiusInches: rulesBaseRadius(unit),
    isFighter: isMovingFighter,
  };
  const otherUnits = await db.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, params.data.gameId),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  const otherFootprints: UnitFootprint[] = [];
  for (const other of otherUnits) {
    if (other.id === unit.id) continue;
    const [otherShip] = await db.select().from(shipsTable).where(eq(shipsTable.id, other.shipId));
    if (!otherShip) continue;
    const [otherModel] = await db.select().from(shipModelsTable).where(eq(shipModelsTable.id, otherShip.shipModelId));
    otherFootprints.push({
      id: other.id,
      ownerId: other.ownerId,
      x: other.hexQ,
      z: other.hexR,
      baseRadiusInches: rulesBaseRadius(other),
      isFighter: otherModel ? shipModelIsFighter(otherModel) : false,
    });
  }
  if (candidateFootprint.isFighter && await fighterIsLockedInDogfight(db, params.data.gameId, unit)) {
    res.status(400).json({ error: "Fighter is locked in a dogfight and cannot move" });
    return;
  }
  const finalFootprint: UnitFootprint = {
    ...candidateFootprint,
    x: finalHexQ,
    z: finalHexR,
  };
  const finalBaseRadius = rulesBaseRadius(finalFootprint);
  if (
    isMovingFighter &&
    (finalHexQ < BOARD_MIN_X + finalBaseRadius ||
      finalHexQ > BOARD_MAX_X - finalBaseRadius ||
      finalHexR < BOARD_MIN_Z + finalBaseRadius ||
      finalHexR > BOARD_MAX_Z - finalBaseRadius)
  ) {
    res.status(400).json({ error: "Fighter base must remain inside the board" });
    return;
  }
  if (findIllegalBaseOverlap(finalFootprint, otherFootprints)) {
    res.status(400).json({ error: "Move would overlap another base illegally" });
    return;
  }
  const actualStepInches = isMovingFighter ? Math.hypot(finalHexQ - unit.hexQ, finalHexR - unit.hexR) : snapHalfInch(Math.hypot(finalHexQ - unit.hexQ, finalHexR - unit.hexR));
  if (isMovingFighter) {
    const contactedEnemyFighterIds = otherFootprints
      .filter(other => other.isFighter && other.ownerId !== unit.ownerId && basesInContact(finalFootprint, other))
      .map(other => other.id);
    const interrupt = await resolveFighterAntiFighterDogfightInterrupt(db, game, unit, finalFootprint, contactedEnemyFighterIds, {
      hexQ: finalHexQ,
      hexR: finalHexR,
      heading: finalHeading,
      actualStepInches,
    });
    if (interrupt?.movingUnitDestroyed) {
      const [destroyedMover] = await db.select().from(gameUnitsTable).where(eq(gameUnitsTable.id, unit.id));
      if (destroyedMover) {
        res.json(destroyedMover);
        return;
      }
    }
  }

  const nextDistanceSinceLastTurn = isTurn
    ? 0
    : unit.distanceSinceLastTurnThisActivation + actualStepInches;
  const [updated] = await db.update(gameUnitsTable)
    .set({
      hexQ: finalHexQ,
      hexR: finalHexR,
      heading: finalHeading,
      hasInitiatedMoveThisActivation: true,
      inchesMovedThisActivation: unit.inchesMovedThisActivation + actualStepInches,
      turnsMadeThisActivation: unit.turnsMadeThisActivation + (isTurn ? 1 : 0),
      distanceSinceLastTurnThisActivation: nextDistanceSinceLastTurn,
      // Movement consumes the All Stop latch (only ships that held station
      // last round get to pivot this round).
      allStopReady: false,
    })
    .where(eq(gameUnitsTable.id, params.data.unitId))
    .returning();
  try {
    await recordMovementAuditLog(db, {
      game,
      actorKind: "player",
      actorPlayerId: userId,
      unitBefore: unit,
      unitAfter: updated,
      movementKind: actualStepInches > 0.001 && isTurn ? "move-and-turn" : isTurn ? "turn" : "move",
      summary: `${unit.name} ${actualStepInches > 0.001 && isTurn
        ? `moved ${actualStepInches.toFixed(1)}" and turned ${headingDelta.toFixed(1)} degrees`
        : isTurn
          ? `turned ${headingDelta.toFixed(1)} degrees`
          : `moved ${actualStepInches.toFixed(1)}"`}.`,
      payload: {
        rulesPath: "player-move",
        requested: {
          toHexQ: body.data.toHexQ,
          toHexR: body.data.toHexR,
          newHeading: finalHeading,
        },
        final: {
          hexQ: finalHexQ,
          hexR: finalHexR,
          heading: finalHeading,
        },
        requestedStepInches,
        actualStepInches,
        headingDelta,
        isTurn,
        currentSpeedCap,
        turnProfile,
        previousActivationLedger: {
          inchesMovedThisActivation: unit.inchesMovedThisActivation,
          turnsMadeThisActivation: unit.turnsMadeThisActivation,
          distanceSinceLastTurnThisActivation: unit.distanceSinceLastTurnThisActivation,
        },
        nextActivationLedger: {
          inchesMovedThisActivation: updated.inchesMovedThisActivation,
          turnsMadeThisActivation: updated.turnsMadeThisActivation,
          distanceSinceLastTurnThisActivation: updated.distanceSinceLastTurnThisActivation,
        },
        specialAction: unit.specialAction,
        allStopReadyBefore: unit.allStopReady,
      },
    });
  } catch (err) {
    req.log.warn({ err, gameId: game.id, unitId: unit.id }, "movement audit log insert failed");
  }

  req.log.info({
    gameId: game.id,
    round: game.currentRound,
    phase: game.phase,
    activePlayerId: game.activePlayerId,
    activeUnitId: game.activeUnitId,
    userId,
    unitId: unit.id,
    unitName: unit.name,
    shipId: unit.shipId,
    damageState: effectiveDamageState(updated.damageState, moveCritRows),
    specialAction: unit.specialAction,
    from: {
      hexQ: unit.hexQ,
      hexR: unit.hexR,
      heading: unit.heading,
    },
    to: {
      hexQ: updated.hexQ,
      hexR: updated.hexR,
      heading: updated.heading,
    },
    requested: {
      toHexQ: body.data.toHexQ,
      toHexR: body.data.toHexR,
      newHeading: body.data.newHeading,
    },
    movement: {
      requestedStepInches,
      actualStepInches,
      headingDelta,
      isTurn,
      isMovingFighter,
      speedCap: currentSpeedCap,
    },
    ledger: {
      before: {
        inchesMovedThisActivation: unit.inchesMovedThisActivation,
        turnsMadeThisActivation: unit.turnsMadeThisActivation,
        distanceSinceLastTurnThisActivation: unit.distanceSinceLastTurnThisActivation,
      },
      after: {
        inchesMovedThisActivation: updated.inchesMovedThisActivation,
        turnsMadeThisActivation: updated.turnsMadeThisActivation,
        distanceSinceLastTurnThisActivation: updated.distanceSinceLastTurnThisActivation,
      },
    },
  }, "movement step committed");

  res.json({
    ...updated,
    damageState: effectiveDamageState(updated.damageState, moveCritRows),
    criticals: moveCritRows,
    isCrippled: isMovingFighter ? false : isCrippledUnit(updated),
    isSkeletonCrew: isSkeletonCrewUnit(updated),
  });
});

// ── Pick up a ship for its activation this round ─────────────────────────────
router.post("/games/:gameId/units/:unitId/launch-fighter", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = FireWeaponParams.pick({ gameId: true, unitId: true }).safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = (req.body && typeof req.body === "object" && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
  const shipModelId = Number(body.shipModelId);
  const hexQ = Number(body.hexQ);
  const hexR = Number(body.hexR);
  if (!Number.isInteger(shipModelId)) { res.status(400).json({ error: "shipModelId is required" }); return; }
  if (!Number.isFinite(hexQ) || !Number.isFinite(hexR)) { res.status(400).json({ error: "hexQ and hexR are required" }); return; }
  const { gameId, unitId } = params.data;

  try {
    const out = await db.transaction(async (tx) => {
      const lockedRows = await tx.execute(sql`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`);
      if (lockedRows.rows.length === 0) throw Object.assign(new Error("Game not found"), { status: 404 });
      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      assertEndPhaseFighterBayWindow(game, userId);

      const [carrier] = await tx.select().from(gameUnitsTable).where(and(eq(gameUnitsTable.id, unitId), eq(gameUnitsTable.gameId, gameId)));
      if (!carrier) throw Object.assign(new Error("Carrier not found"), { status: 404 });
      if (carrier.ownerId !== userId) throw Object.assign(new Error("Not your carrier"), { status: 403 });
      if (carrier.isDestroyed || carrier.damageState === "adrift" || carrier.damageState === "exploding-end-of-next") {
        throw Object.assign(new Error("This ship cannot launch fighters in its current state"), { status: 400 });
      }
      requireNoSpecialActionForFighterBay(carrier, "launch");
      const carrierModel = await getShipModelForUnit(tx, carrier);
      if (!carrierModel) throw Object.assign(new Error("Carrier ship model missing"), { status: 500 });
      if (shipModelIsFighter(carrierModel)) throw Object.assign(new Error("Fighter flights cannot launch fighters"), { status: 400 });
      const inventory = Array.isArray(carrier.carriedFighters) ? carrier.carriedFighters : [];
      const bayIndex = inventory.findIndex(item => item.shipModelId === shipModelId);
      if (bayIndex < 0) throw Object.assign(new Error("This ship does not carry that fighter type"), { status: 400 });
      const bayItem = inventory[bayIndex]!;
      if (bayItem.available <= 0) throw Object.assign(new Error(`${bayItem.name} is not available to launch`), { status: 400 });
      const bayLimit = fighterBayOperationLimit(carrier, carrierModel, "launch");
      const used = fighterBayOperationsUsedThisRound(carrier, game.currentRound);
      if (used >= bayLimit) throw Object.assign(new Error(`This ship may launch or recover at most ${bayLimit} fighter flight${bayLimit === 1 ? "" : "s"} this turn`), { status: 400 });

      const [fighterModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, shipModelId));
      if (!fighterModel) throw Object.assign(new Error("Fighter ship model not found"), { status: 404 });
      if (!shipModelIsFighter(fighterModel)) throw Object.assign(new Error("Selected ship model is not a fighter flight"), { status: 400 });
      const finalHexQ = snapBoardCoord(hexQ);
      const finalHexR = snapBoardCoord(hexR);
      const launchDistance = edgeDistance(
        { x: carrier.hexQ, z: carrier.hexR, baseRadiusInches: rulesBaseRadius(carrier) },
        { x: finalHexQ, z: finalHexR, baseRadiusInches: rulesBaseRadius(fighterModel) },
      );
      if (launchDistance > 3 + 1e-6) throw Object.assign(new Error("Fighters must launch within 3 inches of the carrier"), { status: 400 });
      if (finalHexQ < -24 || finalHexQ > 24 || finalHexR < -36 || finalHexR > 36) throw Object.assign(new Error("Launch position is outside the board"), { status: 400 });

      const otherUnits = await tx.select().from(gameUnitsTable).where(and(eq(gameUnitsTable.gameId, gameId), eq(gameUnitsTable.isDestroyed, false)));
      const otherFootprints: UnitFootprint[] = [];
      for (const other of otherUnits) {
        const model = other.id === carrier.id ? carrierModel : await getShipModelForUnit(tx, other);
        otherFootprints.push({
          id: other.id,
          ownerId: other.ownerId,
          x: other.hexQ,
          z: other.hexR,
          baseRadiusInches: rulesBaseRadius(other),
          isFighter: model ? shipModelIsFighter(model) : false,
        });
      }
      const launchFootprint: UnitFootprint = {
        id: -1,
        ownerId: userId,
        x: finalHexQ,
        z: finalHexR,
        baseRadiusInches: rulesBaseRadius({ baseRadiusInches: fighterModel.baseRadiusInches }),
        isFighter: true,
      };
      if (findIllegalBaseOverlap(launchFootprint, otherFootprints)) {
        throw Object.assign(new Error("Launch position overlaps another base illegally"), { status: 400 });
      }

      const [carrierShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, carrier.shipId));
      if (!carrierShip) throw Object.assign(new Error("Carrier ship record missing"), { status: 500 });
      const [fighterShip] = await tx.insert(shipsTable).values({
        fleetId: carrierShip.fleetId,
        shipModelId: fighterModel.id,
        name: fighterModel.name,
      }).returning();
      const fighterTraits = parseShipTraits(fighterModel.traits);
      const [fighter] = await tx.insert(gameUnitsTable).values({
        gameId,
        ownerId: userId,
        shipId: fighterShip.id,
        name: fighterModel.name,
        modelFilename: fighterModel.filename,
        faction: fighterModel.faction,
        baseRadiusInches: fighterModel.baseRadiusInches,
        hullPoints: fighterModel.hullPoints,
        maxHullPoints: fighterModel.hullPoints,
        damageThreshold: fighterModel.damageThreshold ?? Math.ceil(fighterModel.hullPoints / 2),
        hexQ: finalHexQ,
        hexR: finalHexR,
        heading: normalizeHeadingInput(body.heading, carrier.heading),
        speed: fighterModel.speed,
        turnAngle: fighterModel.turnAngle ?? 45,
        turns: fighterModel.turns ?? 1,
        weaponRange: fighterModel.weaponRange,
        weaponDamage: fighterModel.weaponDamage,
        crewQuality: carrier.crewQuality,
        shieldsCurrent: fighterModel.shieldMax ?? 0,
        interceptorDiceRemaining: fighterTraits.interceptors,
        interceptorThresholdCurrent: 2,
        crewPoints: fighterModel.crew ?? 0,
        maxCrewPoints: fighterModel.crew ?? 0,
        crewThreshold: fighterModel.crewThreshold ?? (fighterModel.crew ? Math.ceil(fighterModel.crew / 2) : 0),
        damageState: "normal",
        carriedFighters: [],
        launchedFromUnitId: carrier.id,
        hasMovedThisRound: true,
        hasFiredThisRound: true,
        isDestroyed: false,
      }).returning();

      const nextInventory = updateFighterInventoryItem(inventory, bayIndex, item => ({
        ...item,
        available: item.available - 1,
        launched: item.launched + 1,
      }));
      const [updatedCarrier] = await tx.update(gameUnitsTable).set({
        carriedFighters: nextInventory,
        fighterBayOperationsRound: game.currentRound,
        fighterBayOperationsUsed: used + 1,
      }).where(eq(gameUnitsTable.id, carrier.id)).returning();

      try {
        await recordMovementAuditLog(tx, {
          game,
          actorKind: "player",
          actorPlayerId: userId,
          unitBefore: carrier,
          unitAfter: updatedCarrier,
          movementKind: "fighter-launch",
          summary: `${carrier.name} launched ${fighter.name}.`,
          payload: {
            rulesPath: "end-phase-fighter-launch",
            carrier: unitAuditState(updatedCarrier),
            fighter: unitAuditState(fighter),
            fighterModel: {
              id: fighterModel.id,
              name: fighterModel.name,
              faction: fighterModel.faction,
            },
            launchPosition: {
              hexQ: fighter.hexQ,
              hexR: fighter.hexR,
              heading: fighter.heading,
            },
            launchDistance,
            bayLimit,
            bayOperationsUsedBefore: used,
            bayOperationsUsedAfter: used + 1,
            inventoryItemBefore: bayItem,
            inventoryAfter: nextInventory,
          },
        });
      } catch (err) {
        req.log.warn({ err, gameId, unitId: carrier.id, fighterId: fighter.id }, "fighter launch audit log insert failed");
      }

      return { carrier: updatedCarrier, fighter };
    });
    res.json(out);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

router.post("/games/:gameId/units/:unitId/recover-fighter", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = FireWeaponParams.pick({ gameId: true, unitId: true }).safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = (req.body && typeof req.body === "object" && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
  const carrierUnitId = Number(body.carrierUnitId);
  if (!Number.isInteger(carrierUnitId)) { res.status(400).json({ error: "carrierUnitId is required" }); return; }
  const { gameId, unitId } = params.data;

  try {
    const out = await db.transaction(async (tx) => {
      const lockedRows = await tx.execute(sql`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`);
      if (lockedRows.rows.length === 0) throw Object.assign(new Error("Game not found"), { status: 404 });
      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      assertEndPhaseFighterBayWindow(game, userId);

      const [fighter] = await tx.select().from(gameUnitsTable).where(and(eq(gameUnitsTable.id, unitId), eq(gameUnitsTable.gameId, gameId)));
      if (!fighter) throw Object.assign(new Error("Fighter not found"), { status: 404 });
      if (fighter.ownerId !== userId) throw Object.assign(new Error("Not your fighter"), { status: 403 });
      if (fighter.isDestroyed) throw Object.assign(new Error("Fighter is already removed"), { status: 400 });
      if (!fighter.launchedFromUnitId) throw Object.assign(new Error("Only launched fighter flights can be recovered into a carrier bay"), { status: 400 });
      const fighterModel = await getShipModelForUnit(tx, fighter);
      if (!fighterModel || !shipModelIsFighter(fighterModel)) throw Object.assign(new Error("Selected unit is not a fighter flight"), { status: 400 });

      const [carrier] = await tx.select().from(gameUnitsTable).where(and(eq(gameUnitsTable.id, carrierUnitId), eq(gameUnitsTable.gameId, gameId)));
      if (!carrier) throw Object.assign(new Error("Carrier not found"), { status: 404 });
      if (carrier.ownerId !== userId) throw Object.assign(new Error("Not your carrier"), { status: 403 });
      if (carrier.isDestroyed || carrier.damageState === "adrift" || carrier.damageState === "exploding-end-of-next") {
        throw Object.assign(new Error("This ship cannot recover fighters in its current state"), { status: 400 });
      }
      requireNoSpecialActionForFighterBay(carrier, "recover");
      const carrierModel = await getShipModelForUnit(tx, carrier);
      if (!carrierModel) throw Object.assign(new Error("Carrier ship model missing"), { status: 500 });
      const recoveryLimit = fighterBayOperationLimit(carrier, carrierModel, "recover");
      const used = fighterBayOperationsUsedThisRound(carrier, game.currentRound);
      if (used >= recoveryLimit) throw Object.assign(new Error(`This ship may launch or recover at most ${recoveryLimit} fighter flight${recoveryLimit === 1 ? "" : "s"} this turn`), { status: 400 });

      const inventory = Array.isArray(carrier.carriedFighters) ? carrier.carriedFighters : [];
      const bayIndex = inventory.findIndex(item => item.shipModelId === fighterModel.id || normalizeSmallCraftKey(item.name) === normalizeSmallCraftKey(fighterModel.name));
      if (bayIndex < 0) throw Object.assign(new Error("This carrier cannot recover that fighter type"), { status: 400 });
      const bayItem = inventory[bayIndex]!;
      if (bayItem.available >= bayItem.total) throw Object.assign(new Error("This carrier has no empty bay for that fighter type"), { status: 400 });
      if (edgeDistance(
        { x: fighter.hexQ, z: fighter.hexR, baseRadiusInches: rulesBaseRadius(fighter) },
        { x: carrier.hexQ, z: carrier.hexR, baseRadiusInches: rulesBaseRadius(carrier) },
      ) > BASE_CONTACT_EPSILON) {
        throw Object.assign(new Error("Fighter must be in base contact with the recovering carrier"), { status: 400 });
      }

      const [originCarrier] = await tx.select().from(gameUnitsTable).where(and(eq(gameUnitsTable.id, fighter.launchedFromUnitId), eq(gameUnitsTable.gameId, gameId)));
      if (!originCarrier) throw Object.assign(new Error("Original launch carrier not found"), { status: 404 });
      const originInventory = Array.isArray(originCarrier.carriedFighters) ? originCarrier.carriedFighters : [];
      const originIndex = originInventory.findIndex(item => item.shipModelId === fighterModel.id || normalizeSmallCraftKey(item.name) === normalizeSmallCraftKey(fighterModel.name));
      const nextOriginInventory = originIndex >= 0
        ? updateFighterInventoryItem(originInventory, originIndex, item => ({
          ...item,
          launched: Math.max(0, item.launched - 1),
        }))
        : originInventory;
      if (originCarrier.id !== carrier.id) {
        await tx.update(gameUnitsTable).set({ carriedFighters: nextOriginInventory }).where(eq(gameUnitsTable.id, originCarrier.id));
      }

      const nextCarrierInventory = updateFighterInventoryItem(
        originCarrier.id === carrier.id ? nextOriginInventory : inventory,
        bayIndex,
        item => ({
          ...item,
          available: item.available + 1,
          recovered: item.recovered + 1,
        }),
      );
      const [updatedCarrier] = await tx.update(gameUnitsTable).set({
        carriedFighters: nextCarrierInventory,
        fighterBayOperationsRound: game.currentRound,
        fighterBayOperationsUsed: used + 1,
      }).where(eq(gameUnitsTable.id, carrier.id)).returning();
      await tx.delete(gameUnitsTable).where(eq(gameUnitsTable.id, fighter.id));

      try {
        await recordMovementAuditLog(tx, {
          game,
          actorKind: "player",
          actorPlayerId: userId,
          unitBefore: carrier,
          unitAfter: updatedCarrier,
          movementKind: "fighter-recovery",
          summary: `${updatedCarrier.name} recovered ${fighter.name}.`,
          payload: {
            rulesPath: "end-phase-fighter-recovery",
            carrier: unitAuditState(updatedCarrier),
            fighter: unitAuditState(fighter),
            recoveredUnitId: fighter.id,
            recoveryLimit,
            bayOperationsUsedBefore: used,
            bayOperationsUsedAfter: used + 1,
            originCarrierId: originCarrier.id,
            inventoryItemBefore: bayItem,
            inventoryAfter: nextCarrierInventory,
          },
        });
      } catch (err) {
        req.log.warn({ err, gameId, unitId: carrier.id, fighterId: fighter.id }, "fighter recovery audit log insert failed");
      }

      return { carrier: updatedCarrier, recoveredUnitId: fighter.id };
    });
    res.json(out);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

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
      if (game.phase !== "movement" && game.phase !== "firing") {
        throw Object.assign(new Error("Units can only activate during Movement or Firing"), { status: 400 });
      }
      if (game.activePlayerId !== userId) throw Object.assign(new Error("Not your activation"), { status: 400 });
      if (game.activeUnitId && game.activeUnitId !== unitId) {
        // Allow swapping the active unit ONLY if the current pick has made
        // no committal action yet — i.e. the player has changed their mind
        // about which ship to take but hasn't started spending it.
        //   Movement phase: no forward/turn move committed AND no Special
        //     Action declared this activation. Picking an SA or starting
        //     to move locks the activation to that ship.
        //   Firing phase: no weapon has fired yet. Once any shot resolves,
        //     the activation is locked.
        // SA state on the prior unit that was DECLARED IN MOVEMENT and
        // carries into firing phase is not a firing-phase commitment, so
        // we don't gate firing-phase swaps on `specialAction`.
        const [curActive] = await tx.select().from(gameUnitsTable).where(
          and(eq(gameUnitsTable.id, game.activeUnitId), eq(gameUnitsTable.gameId, gameId))
        );
        const canSwap = curActive && (
          game.phase === "firing"
            ? (curActive.firedWeaponIds ?? []).length === 0
            : !curActive.hasInitiatedMoveThisActivation && !curActive.specialAction
        );
        if (!canSwap) {
          throw Object.assign(
            new Error(
              game.phase === "firing"
                ? "Cannot switch ships — already fired this activation"
                : "Cannot switch ships — movement or Special Action already committed"
            ),
            { status: 400 }
          );
        }
      }

      const [unit] = await tx.select().from(gameUnitsTable).where(
        and(eq(gameUnitsTable.id, unitId), eq(gameUnitsTable.gameId, gameId))
      );
      if (!unit) throw Object.assign(new Error("Unit not found"), { status: 404 });
      if (unit.ownerId !== userId) throw Object.assign(new Error("Not your ship"), { status: 403 });
      if (unit.isDestroyed) throw Object.assign(new Error("Unit is destroyed"), { status: 400 });

      const activationPhase: "movement" | "firing" = game.phase === "movement" ? "movement" : "firing";
      const segment = await activationSegmentForGame(tx, game, activationPhase);
      const unitIsFighter = await gameUnitIsFighter(tx, unit);
      if (segment === "capital" && unitIsFighter) {
        throw Object.assign(new Error(
          game.phase === "movement"
            ? "Fighter flights activate after all capital ships in the Movement Phase"
            : "Fighter flights have already completed their Firing Phase attacks",
        ), { status: 400 });
      }
      if (segment === "fighter" && !unitIsFighter) {
        throw Object.assign(new Error(
          game.phase === "movement"
            ? "Capital ships have finished moving — activate fighter flights now"
            : "Fighter flights attack before capital ships in the Firing Phase",
        ), { status: 400 });
      }

      // Each phase tracks its own per-round done-flag. A ship that finished its
      // movement activation is still eligible to be picked up again for its
      // firing activation, and vice-versa.
      if (game.phase === "firing") {
        if (unit.hasFiredThisRound) throw Object.assign(new Error("Unit already fired this round"), { status: 400 });
        // A ship reduced to 0 hull or 0 crew can no longer fire — even if it
        // hasn't taken its activation this round. Adrift / hulk / skeleton
        // crew ships are derelicts: no command, no power. Activating them
        // for the firing phase would be a pointless tap-and-end, so we
        // block the activation entirely.
        if (unit.hullPoints <= 0) {
          throw Object.assign(new Error("Hull is gone — ship cannot fire"), { status: 400 });
        }
        if (unit.maxCrewPoints > 0 && unit.crewPoints <= 0) {
          throw Object.assign(new Error("No surviving crew — ship cannot fire"), { status: 400 });
        }
      } else {
        if (unit.hasMovedThisRound) throw Object.assign(new Error("Unit already moved this round"), { status: 400 });
        const moveCritRows = await tx.select().from(unitCriticalEffectsTable)
          .where(eq(unitCriticalEffectsTable.gameUnitId, unit.id));
        const moveDamageState = effectiveDamageState(unit.damageState, moveCritRows);
        if (moveDamageState === "adrift" || moveDamageState === "exploding-end-of-next") {
          throw Object.assign(new Error("Adrift ships drift automatically in the End Phase"), { status: 400 });
        }
        if (unitIsFighter && await fighterIsLockedInDogfight(tx, gameId, unit)) {
          throw Object.assign(new Error("Fighter is locked in a dogfight and cannot move"), { status: 400 });
        }
      }

      // Conditional UPDATE: the optimistic activeUnitId guard is intentionally
      // dropped — we already held `FOR UPDATE` on the game row above AND we
      // explicitly authorised the swap (or had no current pick) just above.
      // Re-asserting `activeUnitId IS NULL OR = unitId` here would reject the
      // swap path we just allowed.
      const result = await tx.update(gamesTable)
        .set({ activeUnitId: unitId })
        .where(and(
          eq(gamesTable.id, gameId),
          eq(gamesTable.activePlayerId, userId),
          eq(gamesTable.status, "active"),
        ))
        .returning();
      if (result.length === 0) throw Object.assign(new Error("Activation conflict, retry"), { status: 409 });
      // Fresh activation → wipe the per-activation fired-weapon ledger so
      // each weapon gets exactly one shot this firing activation. (Harmless
      // for movement-phase activations; firing-phase code reads this.)
      //
      // CRITICAL: only reset on a TRUE pickup transition (no prior active
      // unit, or an allowed swap to a DIFFERENT unit). Re-calling /activate
      // with the same unitId that's already active must be a no-op — without
      // this guard a custom client could partially move, re-activate the
      // same ship to wipe `inchesMovedThisActivation` /
      // `hasInitiatedMoveThisActivation`, and then declare All Stop (or
      // swap away) in violation of the movement-commitment and
      // minimum-speed rules enforced by /end-activation and /special-action.
      if (game.activeUnitId !== unitId) {
        await tx.update(gameUnitsTable)
          .set({
            firedWeaponIds: [],
            hasInitiatedMoveThisActivation: false,
            inchesMovedThisActivation: 0,
            turnsMadeThisActivation: 0,
            distanceSinceLastTurnThisActivation: 0,
          })
          .where(and(eq(gameUnitsTable.id, unitId), eq(gameUnitsTable.gameId, gameId)));
      }
      req.log.info({
        gameId,
        round: game.currentRound,
        phase: game.phase,
        activePlayerId: game.activePlayerId,
        previousActiveUnitId: game.activeUnitId,
        unitId,
        userId,
        repeatedActivation: game.activeUnitId === unitId,
      }, "unit activation accepted");
      return result[0];
    });
    res.json(updated);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

router.post("/games/:gameId/anti-fighter/commit", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const gameId = Number(req.params.gameId);
  if (!Number.isFinite(gameId)) {
    res.status(400).json({ error: "Invalid game id" });
    return;
  }
  const allocationsRaw = (req.body && typeof req.body === "object" && !Array.isArray(req.body))
    ? (req.body as { allocations?: unknown }).allocations
    : undefined;
  if (!Array.isArray(allocationsRaw)) {
    res.status(400).json({ error: "allocations must be an array" });
    return;
  }

  try {
    const updated = await db.transaction(async (tx) => {
      const lockedRows = await tx.execute(sql`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`);
      if (lockedRows.rows.length === 0) throw Object.assign(new Error("Game not found"), { status: 404 });
      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (game.status !== "active") throw Object.assign(new Error("Game is not active"), { status: 400 });
      if (game.phase !== "movement") throw Object.assign(new Error("Anti-Fighter allocation occurs at the end of Movement"), { status: 400 });
      const pending = readAntiFighterPending(game.aiState);
      if (!pending || pending.round !== game.currentRound) {
        throw Object.assign(new Error("No Anti-Fighter allocation is pending"), { status: 400 });
      }
      if (pending.currentPlayerId !== userId || game.activePlayerId !== userId) {
        throw Object.assign(new Error("Not your Anti-Fighter allocation"), { status: 403 });
      }
      const allocations = allocationsRaw.map(item => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw Object.assign(new Error("Invalid Anti-Fighter allocation"), { status: 400 });
        }
        const row = item as Record<string, unknown>;
        return {
          attackerUnitId: Number(row.attackerUnitId),
          targetUnitId: Number(row.targetUnitId),
          dice: Number(row.dice),
        };
      });
      const result = await resolvePlayerAntiFighterAllocations(tx, game, pending, allocations);

      const [postResolutionGame] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (!postResolutionGame) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (postResolutionGame.status === "completed") {
        const baseAiState = game.aiState && typeof game.aiState === "object" && !Array.isArray(game.aiState)
          ? game.aiState as Record<string, unknown>
          : {};
        const nextAiState: Record<string, unknown> = { ...baseAiState, lastAntiFighter: result };
        delete nextAiState.antiFighter;
        const [completed] = await tx.update(gamesTable).set({
          aiState: nextAiState,
          activePlayerId: null,
          activeUnitId: null,
        }).where(eq(gamesTable.id, gameId)).returning();
        return completed;
      }

      const completedPlayerIds = [...new Set([...pending.completedPlayerIds, userId])];
      const nextPending = await buildAntiFighterPendingState(tx, postResolutionGame, completedPlayerIds, result);
      if (nextPending) {
        const baseAiState = postResolutionGame.aiState && typeof postResolutionGame.aiState === "object" && !Array.isArray(postResolutionGame.aiState)
          ? postResolutionGame.aiState as Record<string, unknown>
          : {};
        const [row] = await tx.update(gamesTable).set({
          aiState: {
            ...baseAiState,
            antiFighter: nextPending,
            lastAntiFighter: result,
          },
          activePlayerId: nextPending.currentPlayerId,
          activeUnitId: null,
        }).where(eq(gamesTable.id, gameId)).returning();
        return row;
      }

      return advanceAfterAntiFighter(tx, postResolutionGame, result);
    });
    res.json(updated);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

// ── End the current ship's activation; hand off or advance the round ─────────
router.post("/games/:gameId/units/:unitId/dogfight", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = FireWeaponParams.pick({ gameId: true, unitId: true }).safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const targetUnitId = Number((req.body as { targetUnitId?: unknown } | undefined)?.targetUnitId);
  if (!Number.isInteger(targetUnitId)) { res.status(400).json({ error: "targetUnitId is required" }); return; }
  const { gameId, unitId } = params.data;

  try {
    const result = await db.transaction(async (tx) => {
      const lockedRows = await tx.execute(sql`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`);
      if (lockedRows.rows.length === 0) throw Object.assign(new Error("Game not found"), { status: 404 });

      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (game.status !== "active") throw Object.assign(new Error("Game is not active"), { status: 400 });
      if (game.phase !== "firing") throw Object.assign(new Error("Dogfights resolve in the firing phase"), { status: 400 });
      if (game.activePlayerId !== userId) throw Object.assign(new Error("Not your activation"), { status: 400 });
      if (game.activeUnitId !== unitId) throw Object.assign(new Error("This fighter is not the active unit"), { status: 400 });

      const [attacker] = await tx.select().from(gameUnitsTable).where(and(eq(gameUnitsTable.id, unitId), eq(gameUnitsTable.gameId, gameId)));
      if (!attacker) throw Object.assign(new Error("Attacking fighter not found"), { status: 404 });
      if (attacker.ownerId !== userId) throw Object.assign(new Error("Not your fighter"), { status: 403 });
      if (attacker.isDestroyed) throw Object.assign(new Error("Attacking fighter is destroyed"), { status: 400 });
      if (attacker.hasFiredThisRound) throw Object.assign(new Error("Fighter has already attacked this firing phase"), { status: 400 });

      const [target] = await tx.select().from(gameUnitsTable).where(and(eq(gameUnitsTable.id, targetUnitId), eq(gameUnitsTable.gameId, gameId)));
      if (!target) throw Object.assign(new Error("Target fighter not found"), { status: 404 });
      if (target.ownerId === userId) throw Object.assign(new Error("Dogfight target must be an enemy fighter"), { status: 400 });
      if (target.isDestroyed) throw Object.assign(new Error("Target fighter already destroyed"), { status: 400 });

      const [attackerShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, attacker.shipId));
      const [targetShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, target.shipId));
      if (!attackerShip || !targetShip) throw Object.assign(new Error("Fighter ship record missing"), { status: 500 });
      const [attackerModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, attackerShip.shipModelId));
      const [targetModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, targetShip.shipModelId));
      if (!attackerModel || !targetModel) throw Object.assign(new Error("Fighter model missing"), { status: 500 });
      const attackerTraits = parseShipTraits(attackerModel.traits);
      const targetTraits = parseShipTraits(targetModel.traits);
      if (!shipModelIsFighter(attackerModel) || !shipModelIsFighter(targetModel)) {
        throw Object.assign(new Error("Dogfights can only be resolved between fighter flights"), { status: 400 });
      }

      const attackerFootprint: UnitFootprint = {
        id: attacker.id,
        ownerId: attacker.ownerId,
        x: attacker.hexQ,
        z: attacker.hexR,
        baseRadiusInches: rulesBaseRadius(attacker),
        isFighter: true,
      };
      const targetFootprint: UnitFootprint = {
        id: target.id,
        ownerId: target.ownerId,
        x: target.hexQ,
        z: target.hexR,
        baseRadiusInches: rulesBaseRadius(target),
        isFighter: true,
      };
      if (enemyFighterContacts(attackerFootprint, [targetFootprint]).length === 0) {
        throw Object.assign(new Error("Fighter flights must be in base contact to dogfight"), { status: 400 });
      }

      const liveRows = await tx.select().from(gameUnitsTable).where(and(
        eq(gameUnitsTable.gameId, game.id),
        eq(gameUnitsTable.isDestroyed, false),
      ));
      const attackerSupporters: Array<{ id: number; name: string }> = [];
      const targetSupporters: Array<{ id: number; name: string }> = [];
      for (const row of liveRows as Array<typeof gameUnitsTable.$inferSelect>) {
        if (row.id === attacker.id || row.id === target.id) continue;
        const rowModel = await getShipModelForUnit(tx, row);
        if (!rowModel || !shipModelIsFighter(rowModel)) continue;
        const footprint: UnitFootprint = {
          id: row.id,
          ownerId: row.ownerId,
          x: row.hexQ,
          z: row.hexR,
          baseRadiusInches: rulesBaseRadius(row),
          isFighter: true,
        };
        if (
          row.ownerId === attacker.ownerId
          && edgeDistance(footprint, targetFootprint) <= DOGFIGHT_SUPPORT_RANGE_INCHES
        ) {
          attackerSupporters.push({ id: row.id, name: row.name });
        } else if (
          row.ownerId === target.ownerId
          && edgeDistance(footprint, attackerFootprint) <= DOGFIGHT_SUPPORT_RANGE_INCHES
        ) {
          targetSupporters.push({ id: row.id, name: row.name });
        }
      }
      const attackerSupportBonus = attackerSupporters.length;
      const targetSupportBonus = targetSupporters.length;
      const attackerRoll = rollD6();
      const targetRoll = rollD6();
      const attackerFleetCarrierBonus = await fleetCarrierDogfightBonus(tx, game.id, attacker.ownerId);
      const targetFleetCarrierBonus = await fleetCarrierDogfightBonus(tx, game.id, target.ownerId);
      const attackerScore = attackerRoll + attackerTraits.dogfight + attackerFleetCarrierBonus + attackerSupportBonus;
      const targetScore = targetRoll + targetTraits.dogfight + targetFleetCarrierBonus + targetSupportBonus;
      const destroyedUnitId =
        attackerScore > targetScore ? target.id :
        targetScore > attackerScore ? attacker.id :
        null;
      const destroyedFighterBeforeRecovery =
        destroyedUnitId === target.id ? target :
        destroyedUnitId === attacker.id ? attacker :
        null;

      await tx.update(gameUnitsTable)
        .set({ hasFiredThisRound: true })
        .where(eq(gameUnitsTable.id, attacker.id));

      let fighterRecovery: DestroyedFighterRecoveryResult | null = null;
      if (destroyedUnitId !== null) {
        await tx.update(gameUnitsTable).set({
          hullPoints: 0,
          crewPoints: 0,
          shieldsCurrent: 0,
          interceptorDiceRemaining: 0,
          damageState: "destroyed",
          isDestroyed: true,
          hasFiredThisRound: true,
        }).where(eq(gameUnitsTable.id, destroyedUnitId));
        if (destroyedFighterBeforeRecovery) {
          fighterRecovery = await resolveDestroyedFighterRecovery(tx, game, {
            ...destroyedFighterBeforeRecovery,
            hullPoints: 0,
            crewPoints: 0,
            shieldsCurrent: 0,
            interceptorDiceRemaining: 0,
            damageState: "destroyed",
            isDestroyed: true,
            hasFiredThisRound: true,
          }, "dogfight");
        }
      }

      const allUnits = await tx.select().from(gameUnitsTable).where(eq(gameUnitsTable.gameId, game.id));
      const aliveByOwner = new Map<string, number>();
      for (const row of allUnits) {
        const destroyed = row.id === destroyedUnitId ? true : row.isDestroyed;
        if (unitCountsForVictory({ ...row, isDestroyed: destroyed })) {
          aliveByOwner.set(row.ownerId, (aliveByOwner.get(row.ownerId) ?? 0) + 1);
        }
      }
      const challengerAlive = aliveByOwner.get(game.challengerId) ?? 0;
      const opponentAlive = game.opponentId ? (aliveByOwner.get(game.opponentId) ?? 0) : 0;
      let winnerId: string | null = null;
      let gameCompleted = false;
      if (game.opponentId && challengerAlive === 0 && opponentAlive > 0) {
        winnerId = game.opponentId;
        gameCompleted = true;
      } else if (game.opponentId && opponentAlive === 0 && challengerAlive > 0) {
        winnerId = game.challengerId;
        gameCompleted = true;
      } else if (game.opponentId && challengerAlive === 0 && opponentAlive === 0) {
        gameCompleted = true;
      }
      if (gameCompleted) {
        await tx.update(gamesTable)
          .set({ status: "completed", winnerId, activePlayerId: null, activeUnitId: null })
          .where(eq(gamesTable.id, game.id));
      }

      const log = {
        kind: "dogfight",
        round: game.currentRound,
        supportRangeInches: DOGFIGHT_SUPPORT_RANGE_INCHES,
        attackerUnitId: attacker.id,
        attackerName: attacker.name,
        attackerRoll,
        attackerDogfight: attackerTraits.dogfight,
        attackerFleetCarrierBonus,
        attackerSupportBonus,
        attackerSupporters,
        attackerScore,
        targetUnitId: target.id,
        targetName: target.name,
        targetRoll,
        targetDogfight: targetTraits.dogfight,
        targetFleetCarrierBonus,
        targetSupportBonus,
        targetSupporters,
        targetScore,
        destroyedUnitId,
        fighterRecovery,
        tied: destroyedUnitId === null,
      };
      await tx.update(gamesTable).set({
        aiState: mergeAiState(game.aiState, aiState("acted", "rules.dogfight", {
          message: destroyedUnitId === null
            ? "Dogfight tied; fighters remain locked."
            : `Dogfight destroyed fighter unit ${destroyedUnitId}.`,
          lastDogfight: log,
        })),
      }).where(eq(gamesTable.id, game.id));

      return { ...log, gameCompleted, winnerId };
    });
    res.json(result);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

router.post("/games/:gameId/pass-firing", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = EndActivationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const { gameId } = params.data;

  try {
    const updated = await db.transaction(async (tx) => {
      const lockedRows = await tx.execute(sql`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`);
      if (lockedRows.rows.length === 0) throw Object.assign(new Error("Game not found"), { status: 404 });

      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (game.status !== "active") throw Object.assign(new Error("Game is not active"), { status: 400 });
      if (game.phase !== "firing") throw Object.assign(new Error("Pass All is only available in the firing phase"), { status: 400 });
      if (game.activePlayerId !== userId) throw Object.assign(new Error("Not your activation"), { status: 400 });
      if (readAntiFighterPending(game.aiState)) {
        throw Object.assign(new Error("Resolve pending Anti-Fighter allocation before passing firing"), { status: 400 });
      }
      if (!game.opponentId) throw Object.assign(new Error("Game has no opponent"), { status: 500 });

      const fighterCache = new Map<number, boolean>();
      const isFighterUnit = async (unitRow: typeof gameUnitsTable.$inferSelect): Promise<boolean> => {
        const cached = fighterCache.get(unitRow.id);
        if (cached !== undefined) return cached;
        const model = await getShipModelForUnit(tx, unitRow);
        const fighter = model ? shipModelIsFighter(model) : false;
        fighterCache.set(unitRow.id, fighter);
        return fighter;
      };
      const firingEligibleRows = async (pid: string | null): Promise<Array<typeof gameUnitsTable.$inferSelect>> => {
        const rows = await tx.select().from(gameUnitsTable).where(and(
          eq(gameUnitsTable.gameId, game.id),
          eq(gameUnitsTable.isDestroyed, false),
          eq(gameUnitsTable.hasFiredThisRound, false),
          sql`${gameUnitsTable.hullPoints} > 0 AND (${gameUnitsTable.maxCrewPoints} = 0 OR ${gameUnitsTable.crewPoints} > 0)`,
        ));
        return pid === null ? rows : rows.filter(row => row.ownerId === pid);
      };
      const activationSegmentForFiring = async (): Promise<"fighter" | "capital" | null> => {
        const rows = await firingEligibleRows(null);
        let hasFighter = false;
        let hasCapital = false;
        for (const row of rows) {
          if (await isFighterUnit(row)) hasFighter = true;
          else hasCapital = true;
        }
        return hasFighter ? "fighter" : hasCapital ? "capital" : null;
      };
      const firstEligibleByInitiative = async (segment: "fighter" | "capital"): Promise<string | undefined> => {
        const initiativeId = game.initiativeWinnerId ?? game.challengerId;
        const otherId = initiativeId === game.challengerId ? game.opponentId! : game.challengerId;
        for (const pid of [initiativeId, otherId]) {
          const rows = await firingEligibleRows(pid);
          for (const row of rows) {
            const fighter = await isFighterUnit(row);
            if (segment === "fighter" && fighter) return pid;
            if (segment === "capital" && !fighter) return pid;
          }
        }
        return undefined;
      };

      const myEligible = await firingEligibleRows(userId);
      const allEligible = await firingEligibleRows(null);
      const enemyFighters = allEligible.filter(row => row.ownerId !== userId);
      const enemyFighterFootprints: UnitFootprint[] = [];
      for (const enemy of enemyFighters) {
        if (!(await isFighterUnit(enemy))) continue;
        enemyFighterFootprints.push({
          id: enemy.id,
          ownerId: enemy.ownerId,
          x: enemy.hexQ,
          z: enemy.hexR,
          baseRadiusInches: rulesBaseRadius(enemy),
          isFighter: true,
        });
      }
      for (const mine of myEligible) {
        if (!(await isFighterUnit(mine))) continue;
        const footprint: UnitFootprint = {
          id: mine.id,
          ownerId: mine.ownerId,
          x: mine.hexQ,
          z: mine.hexR,
          baseRadiusInches: rulesBaseRadius(mine),
          isFighter: true,
        };
        if (enemyFighterContacts(footprint, enemyFighterFootprints).length > 0) {
          throw Object.assign(new Error("Resolve owned dogfighting fighters before passing all firing"), { status: 400 });
        }
      }

      const passedUnitIds = myEligible.map(unit => unit.id);
      if (passedUnitIds.length > 0) {
        const passedRows = await tx.update(gameUnitsTable)
          .set({ hasFiredThisRound: true })
          .where(inArray(gameUnitsTable.id, passedUnitIds))
          .returning();
        const afterById = new Map(passedRows.map(row => [row.id, row]));
        for (const before of myEligible) {
          const after = afterById.get(before.id) ?? before;
          await recordSpecialActionAuditLog(tx, {
            game,
            actorKind: "player",
            actorPlayerId: userId,
            unitBefore: before,
            unitAfter: after,
            action: "pass-all-firing",
            storedAction: "pass-all-firing",
            success: true,
            cqRequired: null,
            cqRoll: null,
            cqTotal: null,
            targetUnitId: null,
            summary: `${before.name} passed its firing chance as part of Pass All.`,
            payload: {
              rulesPath: "pass-all-firing",
              passedUnitIds,
              passedCount: passedUnitIds.length,
              didNotResolveAttacks: true,
              didNotConsumeSlowLoading: true,
              didNotConsumeScoutCoordination: true,
            },
          });
        }
      }

      const nextSegment = await activationSegmentForFiring();
      let nextPhase: "firing" | "end" = "firing";
      let nextActivePlayerId: string | null = null;
      if (nextSegment) {
        nextActivePlayerId = await firstEligibleByInitiative(nextSegment) ?? null;
      }
      if (!nextActivePlayerId) {
        nextPhase = "end";
        nextActivePlayerId = game.initiativeWinnerId ?? game.challengerId;
        await tx.update(gamesTable).set({
          endPhaseChallengerPassed: false,
          endPhaseOpponentPassed: false,
        }).where(eq(gamesTable.id, game.id));
      }

      const baseAiState = game.aiState && typeof game.aiState === "object" && !Array.isArray(game.aiState)
        ? game.aiState as Record<string, unknown>
        : {};
      const result = await tx.update(gamesTable).set({
        phase: nextPhase,
        activeUnitId: null,
        activePlayerId: nextActivePlayerId,
        lastActivatorId: userId,
        aiState: {
          ...baseAiState,
          lastFiringPassAll: {
            playerId: userId,
            round: game.currentRound,
            passedUnitIds,
            passedCount: passedUnitIds.length,
            at: nowIso(),
          },
        },
      }).where(and(
        eq(gamesTable.id, gameId),
        eq(gamesTable.activePlayerId, userId),
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
      if (readAntiFighterPending(game.aiState)) {
        throw Object.assign(new Error("Resolve pending Anti-Fighter allocation first"), { status: 400 });
      }
      if (game.phase !== "movement" && game.phase !== "firing") {
        throw Object.assign(new Error("Ship activations only end during Movement or Firing"), { status: 400 });
      }
      if (game.activePlayerId !== userId) throw Object.assign(new Error("Not your activation"), { status: 400 });
      // end-activation doubles as a "pass" when the active player has no
      // active unit AND no eligible activations remain (every ship of theirs
      // is destroyed / already done this phase / inert from 0-hull/0-crew).
      // Without this escape hatch, a fleet that finishes its phase entirely
      // via derelict-creating shots locks the game forever — there's no
      // activation to end.
      const isFiring = game.phase === "firing";
      const endedUnitId = game.activeUnitId;
      let endedUnitForHandoff: typeof gameUnitsTable.$inferSelect | null = null;
      let forcedHoldAudit:
        | {
          unitBefore: typeof gameUnitsTable.$inferSelect;
          summary: string;
          payload: Record<string, unknown>;
        }
        | null = null;
      if (endedUnitId) {
        const [row] = await tx.select().from(gameUnitsTable).where(and(
          eq(gameUnitsTable.id, endedUnitId), eq(gameUnitsTable.gameId, gameId),
        ));
        endedUnitForHandoff = row ?? null;
      }
      const fighterCache = new Map<number, boolean>();
      const isFighterUnit = async (unitRow: typeof gameUnitsTable.$inferSelect): Promise<boolean> => {
        const cached = fighterCache.get(unitRow.id);
        if (cached !== undefined) return cached;
        const [ship] = await tx.select().from(shipsTable).where(eq(shipsTable.id, unitRow.shipId));
        if (!ship) {
          fighterCache.set(unitRow.id, false);
          return false;
        }
        const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
        const fighter = model ? shipModelIsFighter(model) : false;
        fighterCache.set(unitRow.id, fighter);
        return fighter;
      };
      const isMovementActivationEligible = async (unitRow: typeof gameUnitsTable.$inferSelect): Promise<boolean> => {
        return movementActivationEligible(tx, unitRow);
      };
      const eligibleRowsFor = async (
        pid: string | null,
        firing: boolean,
        segment?: "capital" | "fighter" | null,
      ): Promise<Array<typeof gameUnitsTable.$inferSelect>> => {
        const phaseDone = firing ? gameUnitsTable.hasFiredThisRound : gameUnitsTable.hasMovedThisRound;
        const eligibilityCheck = firing
          ? sql`${gameUnitsTable.hullPoints} > 0 AND (${gameUnitsTable.maxCrewPoints} = 0 OR ${gameUnitsTable.crewPoints} > 0)`
          : sql`TRUE`;
        const rows = await tx.select().from(gameUnitsTable).where(and(
          eq(gameUnitsTable.gameId, game.id),
          eq(gameUnitsTable.isDestroyed, false),
          eq(phaseDone, false),
          eligibilityCheck,
        ));
        const eligible: Array<typeof gameUnitsTable.$inferSelect> = [];
        for (const row of rows) {
          if (pid !== null && row.ownerId !== pid) continue;
          if (!firing && !(await isMovementActivationEligible(row))) continue;
          if (segment) {
            const fighter = await isFighterUnit(row);
            if (segment === "fighter" && !fighter) continue;
            if (segment === "capital" && fighter) continue;
          }
          eligible.push(row);
        }
        return eligible;
      };
      const activationSegmentFor = async (firing: boolean): Promise<"capital" | "fighter" | null> => {
        const rows = await eligibleRowsFor(null, firing);
        let hasCapital = false;
        let hasFighter = false;
        for (const row of rows) {
          if (await isFighterUnit(row)) hasFighter = true;
          else hasCapital = true;
        }
        if (firing) return hasFighter ? "fighter" : hasCapital ? "capital" : null;
        return hasCapital ? "capital" : hasFighter ? "fighter" : null;
      };
      const countEligibleFor = async (
        pid: string,
        firing: boolean,
        segment?: "capital" | "fighter" | null,
      ): Promise<number> => {
        return (await eligibleRowsFor(pid, firing, segment)).length;
      };
      if (!endedUnitId) {
        // Verify the pass is legitimate: caller really has nothing to do.
        const segment = await activationSegmentFor(isFiring);
        const myEligible = segment ? await countEligibleFor(userId, isFiring, segment) : 0;
        if (myEligible > 0) {
          throw Object.assign(new Error("You still have eligible activations — pick a ship"), { status: 400 });
        }
        // Pass is valid. No unit to mark as done; fall through to the
        // handoff/advance logic which uses the same `remainingFor` filter.
      } else {
        // Compulsory-drift gate: an adrift-like ship (hull-table adrift,
        // delayed-explode, OR crit-derived adrift via Engines Disabled)
        // MUST execute its forced drift before its movement activation can
        // end. Without this, a custom client could activate a crippled
        // Nova and call /end-activation directly, skipping the drift
        // entirely. Firing-phase end-activation is unaffected — the drift
        // is a movement-phase obligation.
        if (!isFiring) {
          const endedUnit = endedUnitForHandoff;
          if (endedUnit) {
            const endedCritRows = await tx.select().from(unitCriticalEffectsTable)
              .where(eq(unitCriticalEffectsTable.gameUnitId, endedUnit.id));
            const eff = effectiveDamageState(endedUnit.damageState, endedCritRows);
            const isAdriftLike = eff === "adrift" || eff === "exploding-end-of-next";
            // ACTA minimum-speed rule: a non-adrift ship must either
            // (a) declare All Stop / All Stop and Pivot, or (b) move at
            // least ceil(effectiveMaxSpeed/2) inches this activation
            // (where effectiveMaxSpeed accounts for engine-crit
            // speedReduce). Without this check, the End Activation
            // button would silently let players hold station in
            // violation of the rules.
            if (!isAdriftLike) {
              const baseSA = (endedUnit.specialAction ?? "").replace(/-failed$/, "");
              const allStopDeclared = baseSA === "all-stop" || baseSA === "all-stop-pivot";
              if (!allStopDeclared) {
                // Compute effective max speed: printed speed minus the
                // highest active speedReduce from similar engine/reactor
                // criticals.
                const cap = deriveCritEffects(endedCritRows.map(r => ({
                  effectKey: r.effectKey,
                  randomArc: r.randomArc,
                  randomWeaponId: r.randomWeaponId,
                  lostTraits: r.lostTraits ?? [],
                })));
                const [endedShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, endedUnit.shipId));
                let endedModel: typeof shipModelsTable.$inferSelect | undefined;
                if (endedShip) {
                  [endedModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, endedShip.shipModelId));
                }
                const endedTraits = endedModel
                  ? movementTraitsForModel(endedModel, cap)
                  : parseShipTraits("");
                const effectiveMax = effectiveBaseSpeed(endedUnit, cap);
                const minRequired = endedTraits.superManeuverable
                  ? 0
                  : effectiveMax > 0 ? Math.max(1, effectiveMax / 2) : 0;
                if (minRequired > 0 && endedUnit.inchesMovedThisActivation < minRequired) {
                  const fmt = (value: number): string => value.toFixed(value % 1 === 0 ? 0 : 1);
                  const speedCap = movementSpeedCap(endedUnit, cap);
                  const turnProfile = effectiveTurnProfile(endedUnit, endedTraits);
                  const clearance = await scanLegalMovementDebtRestingSpots(
                    tx,
                    game.id,
                    endedUnit,
                    {
                      minRequired,
                      speedCap,
                      crits: cap,
                      traits: endedTraits,
                      turnProfile,
                    },
                  );
                  if (clearance.hasLegalRestingSpot) {
                    throw Object.assign(
                      new Error(
                        `Ship must move at least ${fmt(minRequired)}" this activation or declare All Stop (moved ${fmt(endedUnit.inchesMovedThisActivation)}")`,
                      ),
                      { status: 400 },
                    );
                  }
                  forcedHoldAudit = {
                    unitBefore: endedUnit,
                    summary: `${endedUnit.name} held position because no legal final resting spot was available to satisfy its ${fmt(minRequired)}" minimum move.`,
                    payload: {
                      rulesPath: "public-alpha-no-legal-minimum-move-clearance",
                      minRequired,
                      movedThisActivation: endedUnit.inchesMovedThisActivation,
                      effectiveMax,
                      speedCap,
                      clearance,
                      damageState: eff,
                      specialAction: endedUnit.specialAction,
                      publicAlphaSafetyValve: true,
                    },
                  };
                }
              }
            }
          }
        }
        // Mark the just-ended activation as done for THIS phase only.
        const [endedAfter] = await tx.update(gameUnitsTable)
          .set(isFiring ? { hasFiredThisRound: true } : { hasMovedThisRound: true })
          .where(and(eq(gameUnitsTable.id, endedUnitId), eq(gameUnitsTable.gameId, gameId)))
          .returning();
        if (forcedHoldAudit && endedAfter) {
          try {
            await recordMovementAuditLog(tx, {
              game,
              actorKind: "system",
              actorPlayerId: userId,
              unitBefore: forcedHoldAudit.unitBefore,
              unitAfter: endedAfter,
              movementKind: "forced-hold",
              summary: forcedHoldAudit.summary,
              payload: forcedHoldAudit.payload,
            });
          } catch (err) {
            req.log.warn({ err, gameId, unitId: endedUnitId }, "forced hold audit log insert failed");
          }
        }
      }

      // In active games the opponent is always bound; the status check above
      // (game.status === "active") implies an accepted/claimed challenge.
      if (!game.opponentId) throw Object.assign(new Error("Game has no opponent"), { status: 500 });
      const opponentId = game.opponentId;
      const otherPlayerId = userId === game.challengerId ? opponentId : game.challengerId;
      // In the firing phase, derelicts (hull ≤ 0, or no surviving crew on a
      // ship that has a crew complement) are barred from activation by the
      // /activate guard. They must therefore be excluded from the "remaining"
      // pool too — otherwise the phase deadlocks: a ship reduced to 0 crew
      // during this very firing phase still has `hasFiredThisRound=false`,
      // so without this filter `remainingFor` would keep returning it
      // forever and the round could never advance.
      const segment = await activationSegmentFor(isFiring);
      const endedWasFighter = endedUnitForHandoff ? await isFighterUnit(endedUnitForHandoff) : false;
      const otherRemaining = segment ? await countEligibleFor(otherPlayerId, isFiring, segment) : 0;
      const selfRemaining = segment ? await countEligibleFor(userId, isFiring, segment) : 0;

      let nextActivePlayerId: string | undefined;
      let nextRound = game.currentRound;
      let nextTurn = game.currentTurn;
      let nextPhase: "initiative" | "movement" | "firing" | "end" = isFiring ? "firing" : "movement";
      let nextInitiativeWinnerId = game.initiativeWinnerId;

      // Helper: count firing-eligible ships for a player (used when we're
      // about to transition movement→firing and need to verify SOMEONE can
      // legally activate first — otherwise the firing phase deadlocks before
      // it even starts).
      const firingEligibleFor = async (pid: string) => {
        const rows = await tx.select({ id: gameUnitsTable.id }).from(gameUnitsTable).where(and(
          eq(gameUnitsTable.gameId, game.id),
          eq(gameUnitsTable.ownerId, pid),
          eq(gameUnitsTable.isDestroyed, false),
          eq(gameUnitsTable.hasFiredThisRound, false),
          sql`${gameUnitsTable.hullPoints} > 0 AND (${gameUnitsTable.maxCrewPoints} = 0 OR ${gameUnitsTable.crewPoints} > 0)`,
        ));
        return rows.length;
      };
      const firstEligibleByInitiative = async (
        firing: boolean,
        targetSegment: "capital" | "fighter",
      ): Promise<string | undefined> => {
        const initiativeId = game.initiativeWinnerId ?? game.challengerId;
        const otherId = initiativeId === game.challengerId ? opponentId : game.challengerId;
        if (await countEligibleFor(initiativeId, firing, targetSegment) > 0) return initiativeId;
        if (await countEligibleFor(otherId, firing, targetSegment) > 0) return otherId;
        return undefined;
      };

      // Helper: transition into the end phase. Initiative winner gets the
      // first damage-control window; opponent follows after they pass.
      // End-pass latches reset on every entry so a fresh round starts clean.
      const enterEndPhase = async () => {
        const initiativeId = game.initiativeWinnerId ?? game.challengerId;
        nextPhase = "end";
        nextActivePlayerId = initiativeId;
        await tx.update(gamesTable).set({
          endPhaseChallengerPassed: false,
          endPhaseOpponentPassed: false,
        }).where(eq(gamesTable.id, game.id));
      };

      if (segment === "fighter" && endedWasFighter && selfRemaining > 0) {
        nextActivePlayerId = userId;
      } else if (segment === "fighter") {
        nextActivePlayerId = await firstEligibleByInitiative(isFiring, "fighter");
        if (!nextActivePlayerId && otherRemaining > 0) nextActivePlayerId = otherPlayerId;
        if (!nextActivePlayerId && selfRemaining > 0) nextActivePlayerId = userId;
      } else if (segment === "capital" && endedWasFighter) {
        nextActivePlayerId = await firstEligibleByInitiative(isFiring, "capital");
      } else if (segment === "capital" && otherRemaining > 0) {
        nextActivePlayerId = otherPlayerId;
      } else if (segment === "capital" && selfRemaining > 0) {
        nextActivePlayerId = userId;
      } else if (!isFiring) {
        // Movement sub-phase complete → transition to firing. Same initiative
        // winner activates first in the firing phase, BUT if they have no
        // firing-eligible ships (all derelicts at 0 hull/crew), hand the
        // start of the firing phase to the opponent. If neither side has
        // ANY firing-eligible ships, skip the firing phase entirely and
        // jump straight to end (the round still gets a repair window).
        await resolveEndOfMovementAntiFighter(tx, game);
        const [postAntiFighterGame] = await tx.select().from(gamesTable).where(eq(gamesTable.id, game.id));
        if (!postAntiFighterGame) throw Object.assign(new Error("Game not found"), { status: 404 });
        if (postAntiFighterGame.status === "completed") {
          const [completed] = await tx.update(gamesTable).set({
            activePlayerId: null,
            activeUnitId: null,
            lastActivatorId: userId,
          }).where(eq(gamesTable.id, game.id)).returning();
          return completed;
        }
        const firingSegment = await activationSegmentFor(true);
        const firstFiringPlayer = firingSegment
          ? await firstEligibleByInitiative(true, firingSegment)
          : undefined;
        if (firstFiringPlayer) {
          nextPhase = "firing";
          nextActivePlayerId = firstFiringPlayer;
        } else {
          await enterEndPhase();
        }
      } else {
        // Firing sub-phase complete → end phase. Actual round rollover
        // (resets, shield regen, delayed-kill resolution) now lives in
        // /pass-end-phase and fires only once both players pass end.
        await enterEndPhase();
      }

      // (Round rollover bookkeeping moved to /pass-end-phase — fires only
      // once both players have passed the End Phase.)

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
        endedUnitId === null ? isNull(gamesTable.activeUnitId) : eq(gamesTable.activeUnitId, endedUnitId),
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
const SPLIT_FIRE_SENTINEL_BASE = 900_000_000;

type SplitFireRequest = {
  index: 0 | 1;
  total: 2;
  attackDice: number;
};

function splitFirePendingSentinel(weaponId: number, allocatedAttackDice: number): number {
  return -(SPLIT_FIRE_SENTINEL_BASE + weaponId * 1000 + allocatedAttackDice);
}

function readSplitFirePending(value: number): { weaponId: number; allocatedAttackDice: number } | null {
  if (value >= 0) return null;
  const encoded = Math.abs(value) - SPLIT_FIRE_SENTINEL_BASE;
  if (encoded <= 0) return null;
  const weaponId = Math.floor(encoded / 1000);
  const allocatedAttackDice = encoded % 1000;
  if (weaponId <= 0 || allocatedAttackDice <= 0) return null;
  return { weaponId, allocatedAttackDice };
}

function parseSplitFireRequest(raw: unknown): SplitFireRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const index = value.index;
  const total = value.total;
  const attackDice = value.attackDice;
  if ((index !== 0 && index !== 1) || total !== 2 || typeof attackDice !== "number") {
    throw Object.assign(new Error("Invalid split fire payload"), { status: 400 });
  }
  if (!Number.isInteger(attackDice) || attackDice <= 0) {
    throw Object.assign(new Error("Split fire attack dice must be a positive integer"), { status: 400 });
  }
  return { index, total, attackDice };
}

function normalizeWeaponFingerprint(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

router.post("/games/:gameId/units/:unitId/fire-weapon", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = FireWeaponParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = FireWeaponBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const { gameId, unitId } = params.data;
  const { weaponId: requestedWeaponId, targetUnitId, useScoutCoordination } = body.data;

  try {
    const splitFire = parseSplitFireRequest((req.body as { splitFire?: unknown })?.splitFire);
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
      // Hull or crew exhausted → ineligible to fire even if activation was
      // somehow obtained (race with damage application from another shot).
      if (attacker.hullPoints <= 0) {
        throw Object.assign(new Error("Hull is gone — ship cannot fire"), { status: 400 });
      }
      if (attacker.maxCrewPoints > 0 && attacker.crewPoints <= 0) {
        throw Object.assign(new Error("No surviving crew — ship cannot fire"), { status: 400 });
      }
      // Weapon IDs can change when seed maintenance deletes/reinserts a
      // ship's weapons during deploys. Accept the browser's numeric ID when
      // current, but recover by stable weapon fingerprint when it is stale.
      const [attackerShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, attacker.shipId));
      if (!attackerShip) throw Object.assign(new Error("Attacker ship record missing"), { status: 500 });
      const [attackerModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, attackerShip.shipModelId));
      if (!attackerModel) throw Object.assign(new Error("Attacker ship model missing"), { status: 500 });
      let weaponId = requestedWeaponId;
      let [weapon] = await tx.select().from(weaponsTable).where(eq(weaponsTable.id, requestedWeaponId));
      const resolveWeaponByFingerprint = async () => {
        const name = normalizeWeaponFingerprint(body.data.weaponName);
        const arc = normalizeWeaponFingerprint(body.data.weaponArc);
        if (!name || !arc) return null;
        const currentWeapons = await tx.select().from(weaponsTable).where(eq(weaponsTable.shipModelId, attackerShip.shipModelId));
        const strictTraits = body.data.weaponTraits === undefined
          ? null
          : normalizeWeaponFingerprint(body.data.weaponTraits);
        const matching = currentWeapons.filter(candidate => {
          if (normalizeWeaponFingerprint(candidate.name) !== name) return false;
          if (normalizeWeaponFingerprint(candidate.arc) !== arc) return false;
          if (typeof body.data.weaponRange === "number" && candidate.range !== body.data.weaponRange) return false;
          if (typeof body.data.weaponAttackDice === "number" && candidate.attackDice !== body.data.weaponAttackDice) return false;
          if (strictTraits !== null && normalizeWeaponFingerprint(candidate.traits) !== strictTraits) return false;
          return true;
        });
        if (matching.length > 0) return matching[0];
        return currentWeapons.find(candidate =>
          normalizeWeaponFingerprint(candidate.name) === name &&
          normalizeWeaponFingerprint(candidate.arc) === arc
        ) ?? null;
      };
      if (!weapon || weapon.shipModelId !== attackerShip.shipModelId) {
        const resolved = await resolveWeaponByFingerprint();
        if (resolved) {
          weapon = resolved;
          weaponId = resolved.id;
        }
      }
      if (!weapon) throw Object.assign(new Error("Weapon not found"), { status: 404 });
      if (weapon.shipModelId !== attackerShip.shipModelId) {
        throw Object.assign(new Error("Selected weapon is not available on this ship. Refresh the page and choose one of the attacker's listed weapons."), { status: 400 });
      }
      // Server-authoritative one-shot-per-weapon-per-activation guard.
      const alreadyFired = (attacker.firedWeaponIds ?? []) as number[];
      const pendingSplitEntries = alreadyFired
        .map(readSplitFirePending)
        .filter((entry): entry is { weaponId: number; allocatedAttackDice: number } => entry !== null);
      const pendingSplitForWeapon = pendingSplitEntries.find(entry => entry.weaponId === weaponId) ?? null;
      const completingPendingSplit = splitFire?.index === 1 && pendingSplitForWeapon !== null;
      const completedFiredWeaponIds = alreadyFired.filter(id => id > 0);
      const firedWeaponSystemCount = completedFiredWeaponIds.length + pendingSplitEntries.length;
      if (alreadyFired.includes(weaponId)) {
        throw Object.assign(new Error("Weapon has already fired this activation"), { status: 400 });
      }
      if (pendingSplitEntries.length > 0) {
        if (!splitFire || splitFire.index !== 1 || !pendingSplitForWeapon) {
          throw Object.assign(new Error("Finish the pending split fire allocation before firing another weapon"), { status: 400 });
        }
      }
      if (splitFire?.index === 1 && !pendingSplitForWeapon) {
        throw Object.assign(new Error("No pending split fire allocation found for this weapon"), { status: 400 });
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
      if ((baseAction === "blast-doors" || baseAction === "all-stop-pivot") && firedWeaponSystemCount >= 1 && !completingPendingSplit) {
        throw Object.assign(new Error(`${baseAction === "blast-doors" ? "Close Blast Doors" : "All Stop and Pivot"} limits firing to 1 weapon system`), { status: 400 });
      }
      // All Hands on Deck (cost): only 1 weapon system may fire this
      // round. Latched on successful declaration in /special-action;
      // cleared at round rollover.
      if (attacker.oneWeaponThisRound && firedWeaponSystemCount >= 1 && !completingPendingSplit) {
        throw Object.assign(new Error("All Hands on Deck limits firing to 1 weapon system this round"), { status: 400 });
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
      const attackerTraits = parseShipTraits(filterLostTraits(attackerModel.traits, attackerCrits.lostTraitNames));
      if (skeletonPenaltiesApply(attacker, attackerTraits) && firedWeaponSystemCount >= 1 && !completingPendingSplit) {
        throw Object.assign(new Error("Skeleton crew may fire only one weapon system this turn"), { status: 400 });
      }
      if (isCrippledUnit(attacker) && completedFiredWeaponIds.length > 0 && !completingPendingSplit) {
        const priorWeapons = await tx.select().from(weaponsTable).where(inArray(weaponsTable.id, completedFiredWeaponIds));
        if (priorWeapons.some(w => w.arc === weapon.arc)) {
          throw Object.assign(new Error(`Crippled ships may fire only one weapon per arc; ${weapon.arc} has already fired`), { status: 400 });
        }
      }

      const aPos = hexToWorld(attacker.hexQ, attacker.hexR);
      const tPos = hexToWorld(target.hexQ, target.hexR);
      const [targetShipForRange] = await tx.select().from(shipsTable).where(eq(shipsTable.id, target.shipId));
      if (!targetShipForRange) throw Object.assign(new Error("Target ship record missing"), { status: 500 });
      const [targetModelForRange] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, targetShipForRange.shipModelId));
      if (!targetModelForRange) throw Object.assign(new Error("Target ship model missing"), { status: 500 });
      if (shipModelIsFighter(targetModelForRange) && await fighterIsLockedInDogfight(tx, gameId, target)) {
        throw Object.assign(new Error("Target fighter is locked in a dogfight and cannot be attacked by normal weapons"), { status: 400 });
      }
      const attackerIsFighter = shipModelIsFighter(attackerModel);
      if (attackerIsFighter) {
        const liveUnits = await tx.select().from(gameUnitsTable).where(and(
          eq(gameUnitsTable.gameId, gameId),
          eq(gameUnitsTable.isDestroyed, false),
        ));
        const contacts: UnitFootprint[] = [];
        const attackerFootprint: UnitFootprint = {
          id: attacker.id,
          ownerId: attacker.ownerId,
          x: aPos.x,
          z: aPos.z,
          baseRadiusInches: rulesBaseRadius(attacker),
          isFighter: true,
        };
        for (const live of liveUnits) {
          if (live.id === attacker.id) continue;
          const [liveShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, live.shipId));
          if (!liveShip) continue;
          const [liveModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, liveShip.shipModelId));
          if (!liveModel || !shipModelIsFighter(liveModel)) continue;
          contacts.push({
            id: live.id,
            ownerId: live.ownerId,
            x: live.hexQ,
            z: live.hexR,
            baseRadiusInches: rulesBaseRadius(live),
            isFighter: true,
          });
        }
        if (enemyFighterContacts(attackerFootprint, contacts).length > 0) {
          throw Object.assign(new Error("Fighter is in a dogfight; resolve the dogfight instead of firing weapons"), { status: 400 });
        }
      }

      // Range check (world units = inches; the OpenAPI spec stores weapon.range
      // in inches and the board is laid out at 1 unit = 1 inch).
      const dist = fighterWeaponRangeDistance({
        id: attacker.id,
        ownerId: attacker.ownerId,
        x: aPos.x,
        z: aPos.z,
        baseRadiusInches: rulesBaseRadius(attacker),
        isFighter: shipModelIsFighter(attackerModel),
      }, {
        x: tPos.x,
        z: tPos.z,
        baseRadiusInches: rulesBaseRadius(target),
        isFighter: shipModelIsFighter(targetModelForRange),
      });
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
      const targetEffectiveDamageState = effectiveDamageState(target.damageState, targetCritRows);
      const targetCrippled = isCrippledUnit(target);
      const targetIsFighter = shipModelIsFighter(targetModel);

      // ── Trait parse ──────────────────────────────────────────────────────
      // Filter the target's ship traits by any crit-lost trait names so
      // Adaptive Armour / Stealth / Interceptors / etc. drop out when a
      // power-feedback/implosion/etc. crit nuked them.
      const wt = parseWeaponTraits(weapon.traits);
      if (splitFire) {
        if (useScoutCoordination) {
          throw Object.assign(new Error("Scout Coordination cannot be used with split fire"), { status: 400 });
        }
        if (wt.beam || wt.miniBeam) {
          throw Object.assign(new Error("Beam and Mini-Beam weapons cannot split fire in this rules adaptation"), { status: 400 });
        }
        if (wt.energyMine) {
          throw Object.assign(new Error("Energy Mine weapons cannot split fire"), { status: 400 });
        }
        if (wt.oneShot) {
          throw Object.assign(new Error("One-Shot weapons cannot split fire"), { status: 400 });
        }
        if (wt.slowLoading) {
          throw Object.assign(new Error("Slow-Loading weapons cannot split fire"), { status: 400 });
        }
      }
      if (wt.slowLoading) {
        const cooldowns = normalizeSlowLoadingCooldowns(attacker.slowLoadingWeaponCooldowns, game.currentRound);
        const readyRound = cooldowns[String(weaponId)] ?? 0;
        if (game.currentRound < readyRound) {
          throw Object.assign(new Error(`Slow-Loading weapon is reloading until round ${readyRound}`), { status: 400 });
        }
      }
      const lostLc = new Set(Array.from(targetCrits.lostTraitNames).map(n => n.toLowerCase()));
      const filterTraits = (raw: string | null | undefined): string => {
        if (!raw) return "";
        return raw.split(/[;,]/).map(t => t.trim()).filter(Boolean)
          .filter(t => !lostLc.has(t.toLowerCase().split(/\s+/)[0]))
          .join("; ");
      };
      const targetTraits = parseShipTraits(filterTraits(targetModel.traits));

      // ── Effective AD count ───────────────────────────────────────────────
      // Order: weapon AD modifiers first, then Intensify Defensive Fire halve
      // (min 1). AP / Super AP do not add dice; they modify each attack die's
      // to-hit result below. Attacker crits apply a flat negative AD modifier
      // (Capacitors / Targeting) before halving.
      const intensifyActive = baseAction === "intensify-defense";
      const weaponAd = effectiveAttackDice(weapon.attackDice, wt);
      const adAfterCrits = Math.max(1, weaponAd + attackerCrits.allWeaponsAdMod);
      const maximumAttackDice = intensifyActive ? Math.max(1, Math.floor(adAfterCrits / 2)) : adAfterCrits;
      if (splitFire) {
        if (maximumAttackDice < 2) {
          throw Object.assign(new Error("Split fire requires at least 2 effective AD"), { status: 400 });
        }
        if (splitFire.index === 0) {
          if (pendingSplitForWeapon) {
            throw Object.assign(new Error("This weapon already has a pending split fire allocation"), { status: 400 });
          }
          if (splitFire.attackDice >= maximumAttackDice) {
            throw Object.assign(new Error("First split fire allocation must leave at least 1 AD for the second target"), { status: 400 });
          }
        } else {
          const previousDice = pendingSplitForWeapon?.allocatedAttackDice ?? 0;
          const remainingDice = maximumAttackDice - previousDice;
          if (remainingDice <= 0 || splitFire.attackDice !== remainingDice) {
            throw Object.assign(new Error(`Second split fire allocation must use the remaining ${Math.max(0, remainingDice)} AD`), { status: 400 });
          }
        }
      }
      const finalAttackDice = splitFire ? splitFire.attackDice : maximumAttackDice;

      // ── To-hit threshold ─────────────────────────────────────────────────
      // Beam family hits on 4+. Otherwise the target class's hullRating.
      // Attacker crit `weaponsHitOn4` (Sensors etc.) bumps the floor to a
      // minimum of 4. Stealth is NOT folded in here — it's a separate
      // pre-attack 1d6 check (below).
      const baseThreshold = (wt.beam || wt.miniBeam) ? 4 : targetModel.hullRating;
      const critFloor = attackerCrits.weaponsHitOn4 ? 4 : 0;
      const attackModifier = attackRollModifier(wt);
      const hitThreshold = Math.max(1, Math.max(baseThreshold, critFloor) - attackModifier);

      // ── Scout support: gather allied scout-action rows targeting defender ─
      // Counter-Stealth (successful): each successful "counter-stealth" by an
      // allied Scout reduces this defender's effective Stealth rating by 1
      // for the rest of the round. Coordination (successful, unconsumed):
      // gives ONE allied weapon system a re-roll-failed-AD token vs this
      // target. The "coord" token is opt-in (body.useScoutCoordination) and
      // is marked consumed at the end of this transaction. Allied = same
      // ownerId as the attacker. Failed scout actions (suffixed "-failed")
      // contribute nothing.
      const alliedScoutRows = await tx.select().from(gameUnitsTable).where(and(
        eq(gameUnitsTable.gameId, gameId),
        eq(gameUnitsTable.ownerId, attacker.ownerId),
        eq(gameUnitsTable.scoutActionTargetId, target.id),
      ));
      const liveScoutRows: typeof alliedScoutRows = [];
      for (const s of alliedScoutRows) {
        if (s.scoutAction !== "counter-stealth" && s.scoutAction !== "coord") continue;
        if (s.isDestroyed || s.hullPoints <= 0) continue;
        if (s.maxCrewPoints > 0 && s.crewPoints <= 0) continue;
        const scoutCritRows = await tx.select().from(unitCriticalEffectsTable)
          .where(eq(unitCriticalEffectsTable.gameUnitId, s.id));
        const scoutCrits = deriveCritEffects(scoutCritRows.map(r => ({
          effectKey: r.effectKey,
          randomArc: r.randomArc,
          randomWeaponId: r.randomWeaponId,
          lostTraits: r.lostTraits ?? [],
        })));
        const scoutEffectiveState = effectiveDamageState(s.damageState, scoutCritRows);
        if (scoutEffectiveState === "adrift" || scoutCrits.noSA) continue;
        const [scoutShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, s.shipId));
        if (!scoutShip) continue;
        const [scoutModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, scoutShip.shipModelId));
        if (!scoutModel) continue;
        const scoutTraits = parseShipTraits(filterLostTraits(scoutModel.traits, scoutCrits.lostTraitNames));
        if (!scoutTraits.scout || skeletonPenaltiesApply(s, scoutTraits)) continue;
        liveScoutRows.push(s);
      }
      const counterStealthRows = liveScoutRows.filter(s => s.scoutAction === "counter-stealth");
      const scoutStealthReduction = counterStealthRows.length;
      const availableCoordScout = liveScoutRows.find(s =>
        s.scoutAction === "coord" && !s.scoutCoordConsumed,
      ) ?? null;

      // ── Fleet-support stealth reduction (sheet rule) ─────────────────────
      // An additional -1 to the target's Stealth if any OTHER ship in the
      // attacker's fleet has already successfully attacked the target this
      // round, AND is still on the table (not destroyed, not adrift). The
      // bonus is binary (-1, not stacking per ally).
      const priorHitterIds = ((target.hitByUnitIdsThisRound ?? []) as number[])
        .filter(id => id !== attacker.id);
      let fleetSupportStealthReduction = 0;
      if (priorHitterIds.length > 0) {
        const priorRows = await tx.select().from(gameUnitsTable).where(and(
          eq(gameUnitsTable.gameId, gameId),
          inArray(gameUnitsTable.id, priorHitterIds),
        ));
        const eligibleAlly = priorRows.some(r =>
          r.ownerId === attacker.ownerId
          && !r.isDestroyed
          && r.damageState !== "adrift",
        );
        if (eligibleAlly) fleetSupportStealthReduction = 1;
      }

      // ── Stealth check (per-attack, single 1d6) ───────────────────────────
      // A Stealth-trait defender forces ONE 1d6 stealth check per attack.
      // Attacker must roll >= the effective Stealth threshold (range/
      // already-hit modifiers, clamped 2..6) or the whole attack misses —
      // no AD rolled, no defender pipeline. A natural 6 ALWAYS passes per
      // the sheet, even if the threshold somehow exceeds 6.
      // Energy Mine ignores Stealth entirely. Scout Counter-Stealth and
      // Fleet Support each reduce the effective Stealth before clamping.
      const effectiveStealth = Math.max(0,
        targetTraits.stealth - scoutStealthReduction - fleetSupportStealthReduction,
      );
      let stealthCheckTarget: number | null = null;
      let stealthCheckRoll: number | null = null;
      let stealthCheckPassed = true;
      let stealthCheckNat6Auto = false;
      const stealthIgnoredByPenetration = stealthPenetrationIgnoresTarget(attackerTraits, targetTraits, targetModel);
      if (effectiveStealth > 0 && !wt.energyMine && !stealthIgnoredByPenetration) {
        stealthCheckTarget = stealthFloor(effectiveStealth, dist);
        stealthCheckRoll = rollD6();
        stealthCheckPassed = stealthCheckRoll >= stealthCheckTarget;
        if (!stealthCheckPassed && stealthCheckRoll === 6) {
          stealthCheckPassed = true;
          stealthCheckNat6Auto = true;
        }
      }
      // Slow-Loading / One-Shot exemption: when stealth check fails, the
      // shot "fizzles" rather than firing — these weapons may try again
      // later this round / game.
      const stealthFailWastedSlowLoading =
        !stealthCheckPassed && (wt.slowLoading || wt.oneShot);

      // ── Validate Scout Coordination opt-in ───────────────────────────────
      // Per the rules, Beam / Energy Mine / Twin Linked weapons
      // cannot benefit from the coord re-roll. We reject the opt-in up
      // front rather than silently dropping it so the client can surface
      // the error to the player.
      const scoutCoordRequested = useScoutCoordination === true;
      const scoutCoordWeaponEligible =
        !wt.beam && !wt.energyMine && !wt.twinLinked;
      if (scoutCoordRequested) {
        if (!availableCoordScout) {
          throw Object.assign(new Error("No unspent Scout coordination token available for this target"), { status: 400 });
        }
        if (!scoutCoordWeaponEligible) {
          throw Object.assign(new Error("Scout coordination cannot re-roll Beam, Energy Mine, or Twin Linked weapons"), { status: 400 });
        }
      }
      const scoutCoordActive = scoutCoordRequested && availableCoordScout != null && scoutCoordWeaponEligible;

      // Interceptors screen incoming AD before to-hit dice are rolled. Each
      // intercepted AD is removed from the attack pool entirely, so it does
      // not generate a later to-hit roll that merely "doesn't count".
      let interceptedHits = 0;
      const interceptorAttempts: { rolls: number[]; threshold: number; success: boolean }[] = [];
      const effectiveTargetInterceptors = targetCrippled ? 0 : targetTraits.interceptors;
      const interceptorDiceBefore = Math.min(target.interceptorDiceRemaining, effectiveTargetInterceptors);
      const interceptorThresholdBefore = target.interceptorThresholdCurrent;
      let interceptorRemaining = interceptorDiceBefore;
      let interceptorThreshold = interceptorThresholdBefore;
      const interceptorsBypassed = wt.beam || wt.miniBeam || wt.massDriver || wt.energyMine;
      let attackDiceAfterInterceptors = finalAttackDice;
      if (
        stealthCheckPassed &&
        !interceptorsBypassed &&
        effectiveTargetInterceptors > 0 &&
        interceptorRemaining > 0 &&
        attackDiceAfterInterceptors > 0
      ) {
        const diceToAttempt = attackDiceAfterInterceptors;
        for (let ad = 0; ad < diceToAttempt; ad++) {
          if (interceptorRemaining <= 0) break;
          const rolls: number[] = [];
          let anySuccess = false;
          let onesRolled = 0;
          for (let i = 0; i < interceptorRemaining; i++) {
            const d = rollD6();
            rolls.push(d);
            if (d >= interceptorThreshold) anySuccess = true;
            if (d === 1) onesRolled++;
          }
          interceptorAttempts.push({ rolls, threshold: interceptorThreshold, success: anySuccess });
          if (anySuccess) {
            interceptedHits++;
            attackDiceAfterInterceptors--;
          }
          interceptorRemaining = Math.max(0, interceptorRemaining - onesRolled);
          if (interceptorRemaining > 0) {
            interceptorThreshold = Math.min(6, interceptorThreshold + onesRolled);
            if (interceptorRemaining === 1) interceptorThreshold = 6;
          }
        }
      }
      const interceptorRolls: number[] = interceptorAttempts.flatMap(a => a.rolls);

      // ── Roll AD → raw hits ───────────────────────────────────────────────
      // Beam: every successful to-hit die "explodes" and rolls one additional
      // die (also checked for hit + further explosion). AP / Super AP are
      // already folded into hitThreshold, so a modified Beam hit chains
      // correctly. Cap per-die at 100 chained rolls as a runaway-loop guard.
      // Twin Linked: missed AD may be re-rolled once.
      // Concentrate Fire: missed AD against the locked target may be re-rolled
      // once (skipped by Beam, Energy Mine, Twin Linked per rulebook).
      // A single die may be re-rolled by at most ONE of these two effects.
      const EXPLODE_CAP_PER_DIE = 100;
      const concentrateRerollEligible =
        concentrateActive && !wt.beam && !wt.miniBeam && !wt.twinLinked && !wt.energyMine;
      const attackRolls: number[] = [];
      const attackRollKinds: ("normal" | "explosion" | "twin-reroll" | "concentrate-reroll" | "scout-coord-reroll")[] = [];
      let hits = 0;
      let beamExplosions = 0;
      let twinRerolls = 0;
      let concentrateRerolls = 0;
      let scoutCoordRerolls = 0;
      // Stealth check failure short-circuits the AD roll entirely — attackRolls
      // stays empty, hits stays 0, and the defender pipeline naturally cascades
      // to no damage.
      for (let i = 0; stealthCheckPassed && i < attackDiceAfterInterceptors; i++) {
        let r = rollD6();
        attackRolls.push(r);
        attackRollKinds.push("normal");
        let hitFlag = r >= hitThreshold;
        // At most ONE re-roll per AD, in this priority: Twin Linked,
        // Concentrate Fire, Scout Coordination. Scout Coord eligibility
        // was already validated above to exclude Beam / Energy Mine /
        // Twin Linked weapons; the priority order
        // effectively reduces to "use coord when twin/concentrate
        // didn't apply".
        if (!hitFlag && wt.twinLinked) {
          const r2 = rollD6();
          attackRolls.push(r2);
          attackRollKinds.push("twin-reroll");
          twinRerolls++;
          if (r2 >= hitThreshold) { hitFlag = true; r = r2; }
        } else if (!hitFlag && concentrateRerollEligible) {
          const r2 = rollD6();
          attackRolls.push(r2);
          attackRollKinds.push("concentrate-reroll");
          concentrateRerolls++;
          if (r2 >= hitThreshold) { hitFlag = true; r = r2; }
        } else if (!hitFlag && scoutCoordActive) {
          const r2 = rollD6();
          attackRolls.push(r2);
          attackRollKinds.push("scout-coord-reroll");
          scoutCoordRerolls++;
          if (r2 >= hitThreshold) { hitFlag = true; r = r2; }
        }
        if (hitFlag) hits++;
        if (wt.beam) {
          let chain = 0;
          while (r >= hitThreshold && chain < EXPLODE_CAP_PER_DIE) {
            r = rollD6();
            attackRolls.push(r);
            attackRollKinds.push("explosion");
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
      const targetAction = (target.specialAction ?? "").replace(/-failed$/, "");
      const targetHeldStation = targetAction === "all-stop" || targetAction === "all-stop-pivot";
      const targetCanManeuver =
        target.hasMovedThisRound
        && !targetHeldStation
        && targetEffectiveDamageState !== "adrift"
        && targetEffectiveDamageState !== "exploding-end-of-next"
        && target.hullPoints > 0
        && (target.maxCrewPoints === 0 || target.crewPoints > 0);
      const dodgeActive = targetTraits.dodge > 0 && !wt.accurate && !wt.energyMine && targetCanManeuver;
      if (dodgeActive) {
        for (let i = 0; i < remainingHits; i++) {
          const d = rollD6();
          dodgeRolls.push(d);
          if (d >= targetTraits.dodge) dodgesSuccessful++;
        }
        remainingHits = Math.max(0, remainingHits - dodgesSuccessful);
      }
      const fighterOneHitDestroyed = targetIsFighter && remainingHits > 0;

      // Interceptors: per the sheet, the defender's Interceptor dice form a
      // persistent per-turn pool with a degrading threshold:
      //   • Each incoming surviving hit is resolved individually: roll ALL
      //     currently-remaining dice at the current threshold; if ≥1 die
      //     meets it, the hit is negated.
      //   • Any die that rolls a 1 during the attempt is permanently lost
      //     for the rest of the turn. After the burn, the threshold ramps:
      //     2+ (full pool) → 3+ → 4+ → 5+ → 6+ as dice are lost; when only
      //     one die remains it always intercepts on 6+ regardless of how
      //     many it lost on the way down.
      //   • Pool + threshold persist across every fire-weapon call in the
      //     turn; both reset at end-of-round (see round-rollover block).
      // Skipped by Beam, Mini Beam, Mass Driver, Energy Mine.
      /*
      let interceptedHits = 0;
      const interceptorAttempts: { rolls: number[]; threshold: number; success: boolean }[] = [];
      // Clamp persisted state by the trait-filtered cap so that a crit which
      // wipes the Interceptors trait (power feedback / implosion / catastrophic)
      // immediately drops the pool to 0 — even if the column was non-zero from
      // an earlier attack this turn before the trait was lost.
      const effectiveTargetInterceptors = targetCrippled ? 0 : targetTraits.interceptors;
      const interceptorDiceBefore = Math.min(target.interceptorDiceRemaining, effectiveTargetInterceptors);
      const interceptorThresholdBefore = target.interceptorThresholdCurrent;
      let interceptorRemaining = interceptorDiceBefore;
      let interceptorThreshold = interceptorThresholdBefore;
      const interceptorsBypassed = wt.beam || wt.miniBeam || wt.massDriver || wt.energyMine;
      if (!interceptorsBypassed && effectiveTargetInterceptors > 0 && interceptorRemaining > 0 && remainingHits > 0) {
        const hitsToAttempt = remainingHits;
        for (let h = 0; h < hitsToAttempt; h++) {
          if (interceptorRemaining <= 0) break;
          const rolls: number[] = [];
          let anySuccess = false;
          let onesRolled = 0;
          for (let i = 0; i < interceptorRemaining; i++) {
            const d = rollD6();
            rolls.push(d);
            if (d >= interceptorThreshold) anySuccess = true;
            if (d === 1) onesRolled++;
          }
          interceptorAttempts.push({ rolls, threshold: interceptorThreshold, success: anySuccess });
          if (anySuccess) {
            interceptedHits++;
            remainingHits--;
          }
          // Burn 1s and re-derive threshold for the next attempt.
          interceptorRemaining = Math.max(0, interceptorRemaining - onesRolled);
          if (interceptorRemaining > 0) {
            interceptorThreshold = Math.min(6, interceptorThreshold + onesRolled);
            if (interceptorRemaining === 1) interceptorThreshold = 6;
          }
        }
      }
      // Flatten dice for back-compat with the existing combat-log dice
      // strip; the new structured field is interceptorAttempts.
      const interceptorRolls: number[] = interceptorAttempts.flatMap(a => a.rolls);
      */

      // Shields: each hit costs `mult` shield points (Double Damage hits count
      // double, etc.). Partial absorption: a hit hitting a partly-full shield
      // pool drains the pool to 0 and still gets through. Mass Driver and
      // Energy Mine bypass shields.
      let shieldsBefore = targetCrippled ? 0 : target.shieldsCurrent;
      let shieldsCurrent = shieldsBefore;
      let shieldedHits = 0;
      if (!fighterOneHitDestroyed && !wt.massDriver && !wt.energyMine && shieldsCurrent > 0 && remainingHits > 0) {
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
      const attackTableModifiedRolls: number[] = [];
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
      for (let i = 0; !fighterOneHitDestroyed && i < remainingHits; i++) {
        const d = rollD6();
        const tableRoll = Math.min(6, d + (wt.precise ? 1 : 0));
        attackTableRolls.push(d);
        attackTableModifiedRolls.push(tableRoll);
        if (tableRoll === 1) {
          bulkheadHits++;
          totalDamage += bulkheadFloor;
        } else if (tableRoll <= 5) {
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
      if (fighterOneHitDestroyed) {
        damageAfterGeg = Math.max(damageAfterGeg, target.hullPoints);
        crewAfterGeg = 0;
      }

      // ── Resolve critical-hit table rolls ─────────────────────────────────
      // For each pending crit: pick location (1d6→bucket), look up entry,
      // resolve dice penalties, sample random arc / weapon / trait, and add
      // structural dmg+crew on top of the GEG-reduced totals.
      const criticalsApplied: Array<{
        id: number; gameUnitId: number;
        location: number; locationRoll: number; effectRoll: number;
        effectKey: string; name: string;
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
      const targetHasCrewTrack = target.maxCrewPoints > 0;
      if (!targetHasCrewTrack) crewAfterGeg = 0;
      // Track gross crit damage so we can later scale the per-crit
      // `damageApplied` to the net amount that actually reached hull
      // (after Adaptive Armour + Blast Doors) for combat-log accuracy.
      const critGrossSoFar = totalDamage;  // structural-only at this point
      const damagePreCrits = damageAfterGeg;
      let critDmgGross = 0;
      const insertedIds: number[] = [];
      const insertedGrossDmg: number[] = [];
      for (const pc of pendingCrits) {
        const loc = locationFromRoll(pc.locationRoll);
        const entry = findEntry(loc, pc.effectRoll);
        if (!entry) continue;
        if (targetTraits.ancient && criticalAffectsCrew(entry)) continue;
        const dmgApplied = isDice(entry.dmg) ? rollDice(entry.dmg.dice) : entry.dmg;
        const crewApplied = targetHasCrewTrack
          ? (isDice(entry.crew) ? rollDice(entry.crew.dice) : entry.crew)
          : 0;
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
          location: loc, locationRoll: pc.locationRoll, effectRoll: pc.effectRoll,
          effectKey: entry.effectKey, name: entry.name,
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
      const finalCrewLost = targetHasCrewTrack
        ? Math.max(0, crewAfterGeg - blastDoorsCrewSaved)
        : 0;

      // ── Scale per-crit damageApplied to the NET hull damage actually
      //    landed by each crit for persisted combat-log accuracy.
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
      const targetCrewAfter = targetHasCrewTrack
        ? Math.max(0, targetCrewBefore - finalCrewLost)
        : targetCrewBefore;

      // ── Damage table (Slice C) ───────────────────────────────────────────
      // Fired when this attack drops hull to 0 from a still-living state.
      // Sheet: roll 1d6 + abs(overkill) → 1-6 adrift, 7-11 destroyed,
      // 12-17 exploding-end-of-next, 18+ explodes now (AOE).
      let damageTable: {
        overkill: number; roll: number; total: number;
        outcome: "adrift" | "destroyed" | "exploding-end-of-next" | "explodes-now";
      } | null = null;
      let nextDamageState: string = fighterOneHitDestroyed ? "destroyed" : target.damageState;
      let targetDestroyed: boolean = fighterOneHitDestroyed || target.isDestroyed;
      const explosionVictims: Array<{
        unitId: number; hitsTaken: number; finalDamage: number;
        finalCrewLost: number; hullAfter: number; destroyed: boolean;
        fighterRecovery?: DestroyedFighterRecoveryResult | null;
      }> = [];

      if (!fighterOneHitDestroyed && targetHullAfter === 0 && target.damageState === "normal" && !target.isDestroyed) {
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
            const vHasCrewTrack = v.maxCrewPoints > 0;
            const vFinalCrewLost = vHasCrewTrack ? vCrew : 0;
            const vHullAfter = Math.max(0, v.hullPoints - vDmg);
            const vCrewAfter = vHasCrewTrack
              ? Math.max(0, v.crewPoints - vFinalCrewLost)
              : v.crewPoints;
            const vDestroyed = vHullAfter === 0;
            // Crew-to-zero on a still-living "normal" victim sets adrift,
            // matching the main-target rule.
            const vNextState = vDestroyed
              ? "destroyed"
              : (vHasCrewTrack && vCrewAfter === 0 && v.damageState === "normal" ? "adrift" : v.damageState);
            await tx.update(gameUnitsTable).set({
              hullPoints: vHullAfter,
              crewPoints: vCrewAfter,
              isDestroyed: vDestroyed,
              damageState: vNextState,
            }).where(eq(gameUnitsTable.id, v.id));
            const victimRecovery = vDestroyed
              ? await resolveDestroyedFighterRecovery(tx, game, {
                ...v,
                hullPoints: vHullAfter,
                crewPoints: vCrewAfter,
                isDestroyed: true,
                damageState: "destroyed",
              }, "explosion")
              : null;
            explosionVictims.push({
              unitId: v.id, hitsTaken, finalDamage: vDmg,
              finalCrewLost: vFinalCrewLost, hullAfter: vHullAfter, destroyed: vDestroyed,
              fighterRecovery: victimRecovery,
            });
          }
        }
      }

      // Out-of-crew → adrift (only if still alive and not already adrift/worse).
      if (targetHasCrewTrack && targetCrewAfter === 0 && nextDamageState === "normal" && !targetDestroyed) {
        nextDamageState = "adrift";
      }
      const targetWillBeCrippled = isCrippledUnit({
        ...target,
        hullPoints: targetHullAfter,
        isDestroyed: targetDestroyed,
      });
      const persistedShieldsCurrent = targetWillBeCrippled ? 0 : shieldsCurrent;
      const persistedInterceptorRemaining = targetWillBeCrippled ? 0 : interceptorRemaining;
      const persistedInterceptorThreshold = targetWillBeCrippled ? 2 : interceptorThreshold;

      const [updatedTarget] = await tx.update(gameUnitsTable).set({
        hullPoints: targetHullAfter,
        crewPoints: targetCrewAfter,
        shieldsCurrent: persistedShieldsCurrent,
        // Persist the post-attack interceptor state so the next attack
        // this turn sees the burned dice / raised threshold.
        interceptorDiceRemaining: persistedInterceptorRemaining,
        interceptorThresholdCurrent: persistedInterceptorThreshold,
        damageState: nextDamageState,
        isDestroyed: targetDestroyed,
      }).where(eq(gameUnitsTable.id, target.id)).returning();
      if (!updatedTarget) throw Object.assign(new Error("Target update failed"), { status: 500 });
      const fighterRecovery = targetDestroyed
        ? await resolveDestroyedFighterRecovery(tx, game, updatedTarget, "weapon")
        : null;

      // Record that this weapon has fired this activation.
      // Sheet exception: if the stealth check failed AND the weapon is
      // Slow-Loading or One-Shot, the shot doesn't count as fired (the
      // power was held, not loosed). All other stealth failures still
      // consume the shot — the gun went off, it just hit nothing.
      if (!stealthFailWastedSlowLoading) {
        const nextSlowLoadingCooldowns = wt.slowLoading
          ? {
              ...normalizeSlowLoadingCooldowns(attacker.slowLoadingWeaponCooldowns, game.currentRound),
              [String(weaponId)]: game.currentRound + 2,
            }
          : attacker.slowLoadingWeaponCooldowns;
        const pendingSentinel = pendingSplitForWeapon
          ? splitFirePendingSentinel(pendingSplitForWeapon.weaponId, pendingSplitForWeapon.allocatedAttackDice)
          : null;
        const nextFiredWeaponIds = splitFire?.index === 0
          ? [...alreadyFired, splitFirePendingSentinel(weaponId, splitFire.attackDice)]
          : splitFire?.index === 1
            ? [...alreadyFired.filter(id => id !== pendingSentinel), weaponId]
            : [...alreadyFired, weaponId];
        await tx.update(gameUnitsTable)
          .set({
            firedWeaponIds: nextFiredWeaponIds,
            slowLoadingWeaponCooldowns: nextSlowLoadingCooldowns,
          })
          .where(eq(gameUnitsTable.id, attacker.id));
      }

      // Record successful hits on the target so subsequent allied attackers
      // get the -1 Fleet Support stealth modifier. We use "hits > 0" (raw
      // to-hits, before interceptors/shields) — the target had to actually
      // be tracked and hit for the rule to apply. Stealth-failed attacks
      // never reach this branch (hits stays 0).
      if (hits > 0) {
        const prevHitters = (target.hitByUnitIdsThisRound ?? []) as number[];
        if (!prevHitters.includes(attacker.id)) {
          await tx.update(gameUnitsTable)
            .set({ hitByUnitIdsThisRound: [...prevHitters, attacker.id] })
            .where(eq(gameUnitsTable.id, target.id));
        }
      }

      // ── Win condition (Slice C) ──────────────────────────────────────────
      // After any damage application, if all of one player's units are
      // destroyed, end the game and award to the other player.
      let winnerId: string | null = null;
      const allUnits = await tx.select().from(gameUnitsTable)
        .where(eq(gameUnitsTable.gameId, game.id));
      const aliveByOwner = new Map<string, number>();
      for (const u of allUnits) {
        if (unitCountsForVictory(u)) {
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
          .set({ status: "completed", winnerId, activePlayerId: null, activeUnitId: null })
          .where(eq(gamesTable.id, game.id));
      }

      // The Scout coordination token is spent when assigned to this weapon
      // system, even if the attack produces no failed AD to reroll.
      const scoutCoordActuallyUsed = scoutCoordActive;
      if (scoutCoordActuallyUsed && availableCoordScout) {
        await tx.update(gameUnitsTable)
          .set({ scoutCoordConsumed: true })
          .where(eq(gameUnitsTable.id, availableCoordScout.id));
      }

      // damageRolls retained for back-compat with existing combat log UI:
      // map (bulkhead=1, solid=3, crit=6) so the legacy "1=miss, 2-5=hit,
      // 6=crit" rendering keeps showing meaningful pips. Slice A's richer
      // surface is in attackTableRolls + the new aggregate counts.
      const damageRolls = attackTableRolls.map(r => r);

      await recordAttackAuditLog(tx, {
        game,
        actorKind: "player",
        actorPlayerId: userId,
        attacker,
        targetBefore: target,
        targetAfter: updatedTarget,
        weapon,
        summary: `${attacker.name} fired ${weapon.name} at ${target.name}: ${hits} hit(s), ${finalDamage} damage, ${finalCrewLost} crew.`,
        payload: {
          rulesPath: "player-fire-weapon",
          attackerModel: {
            id: attackerModel.id,
            name: attackerModel.name,
            traits: attackerModel.traits,
          },
          targetModel: {
            id: targetModel.id,
            name: targetModel.name,
            hullRating: targetModel.hullRating,
            traits: targetModel.traits,
          },
          distance: Number(dist.toFixed(3)),
          specialAction: attacker.specialAction,
          targetSpecialAction: target.specialAction,
          weaponTraits: weapon.traits,
          effectiveAttackDice: finalAttackDice,
          attackDiceAfterInterceptors,
          hitThreshold,
          attackModifier,
          stealthCheckTarget,
          stealthCheckRoll,
          stealthCheckPassed,
          stealthCheckNat6Auto,
          stealthFailWastedSlowLoading,
          attackRolls,
          attackRollKinds,
          hits,
          dodgeTarget: dodgeRolls.length > 0 ? targetTraits.dodge : null,
          dodgeRolls,
          dodgesSuccessful,
          interceptedHits,
          interceptorRolls,
          interceptorAttempts,
          interceptorDiceBefore,
          interceptorDiceAfter: persistedInterceptorRemaining,
          interceptorThresholdBefore,
          interceptorThresholdAfter: persistedInterceptorThreshold,
          interceptorsBypassed,
          shieldedHits,
          targetShieldsBefore: shieldsBefore,
          targetShieldsAfter: persistedShieldsCurrent,
          remainingHits,
          attackTableRolls,
          attackTableModifiedRolls,
          bulkheadHits,
          solidHits,
          criticalHits,
          criticalRolls,
          criticalsApplied,
          gegReduction,
          adaptiveHalved,
          blastDoorsActive,
          blastDoorsDamageSaved,
          blastDoorsCrewSaved,
          blastDoorsDamageRolls,
          blastDoorsCrewRolls,
          damageMultiplier: mult,
          bulkheadFloor,
          finalDamage,
          finalCrewLost,
          targetHullBefore,
          targetHullAfter,
          targetCrewBefore,
          targetCrewAfter,
          targetDestroyed,
          fighterRecovery,
          damageTable,
          explosionVictims,
          beamExplosions,
          twinRerolls,
          concentrateRerolls,
          scoutStealthReduction,
          scoutCoordApplied: scoutCoordActuallyUsed,
          scoutCoordRerolls,
          winnerId,
          gameCompleted,
        },
      });

      return {
        weaponId,
        targetUnitId,
        hitThreshold,
        stealthCheckTarget,
        stealthCheckRoll,
        stealthCheckPassed,
        attackRolls,
        attackRollKinds,
        hits,
        // Defender pipeline
        dodgeTarget: dodgeRolls.length > 0 ? targetTraits.dodge : null,
        dodgeRolls,
        dodgesSuccessful,
        interceptedHits,
        interceptorRolls,
        // Back-compat: 0 when no check was made (bypass / no trait / no
        // surviving hits / empty pool); otherwise the threshold of the
        // first attempt.
        interceptorThreshold: interceptorAttempts.length > 0 ? interceptorThresholdBefore : 0,
        interceptorAttempts,
        interceptorDiceBefore,
        interceptorDiceAfter: persistedInterceptorRemaining,
        interceptorThresholdBefore,
        interceptorThresholdAfter: persistedInterceptorThreshold,
        shieldedHits,
        targetShieldsBefore: shieldsBefore,
        targetShieldsAfter: persistedShieldsCurrent,
        // Attack Table
        attackTableRolls,
        attackTableModifiedRolls,
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
        scoutStealthReduction,
        scoutCoordApplied: scoutCoordActuallyUsed,
        scoutCoordRerolls,
        targetHullBefore,
        targetHullAfter,
        targetCrewBefore,
        targetCrewAfter,
        targetDestroyed,
        fighterRecovery,
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
    "come-about-extra-turn": 9,
    "come-about-sharp-turn": 9,
    "intensify-defense": 8,
    "run-silent": 8,
    "concentrate-fire": 8,
    "all-hands-on-deck": 9,
    "scramble": 7,
  };
  // All Special Actions — including All Hands on Deck — are declared in
  // the Movement Phase during a ship's activation. All Hands on Deck's
  // effect is deferred: on success it adds +2 to that ship's d6+CQ
  // damage-control rolls AND lifts the once-per-round-per-ship DC cap in
  // the End Phase. Its cost — only one weapon system may fire this round
  // — is latched on gameUnits.oneWeaponThisRound at successful
  // declaration (so it bites in the firing phase that follows) and
  // cleared at round rollover.

  try {
    const out = await db.transaction(async (tx) => {
      const lockedRows = await tx.execute(sql`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`);
      if (lockedRows.rows.length === 0) throw Object.assign(new Error("Game not found"), { status: 404 });

      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (game.status !== "active") throw Object.assign(new Error("Game is not active"), { status: 400 });
      if (game.phase !== "movement") throw Object.assign(new Error("Special Actions are declared in the movement phase"), { status: 400 });
      if (game.activePlayerId !== userId) throw Object.assign(new Error("Not your activation"), { status: 409 });
      // All Special Actions are gated to the currently-activated unit.
      if (game.activeUnitId !== unitId) {
        throw Object.assign(new Error("This unit is not the one you activated"), { status: 409 });
      }

      const [unit] = await tx.select().from(gameUnitsTable).where(and(
        eq(gameUnitsTable.id, unitId), eq(gameUnitsTable.gameId, gameId),
      ));
      if (!unit) throw Object.assign(new Error("Unit not found"), { status: 404 });
      if (unit.ownerId !== userId) throw Object.assign(new Error("Not your ship"), { status: 403 });
      if (unit.isDestroyed) throw Object.assign(new Error("Ship destroyed"), { status: 400 });
      if (unit.specialAction) throw Object.assign(new Error("Already used a Special Action this round"), { status: 400 });
      // Special Actions must be declared before the activation's movement
      // is committed.
      if (unit.hasMovedThisRound) throw Object.assign(new Error("Cannot declare a Special Action after the activation has ended"), { status: 400 });
      // Authoritative per-activation guard: even a partial /move (forward
      // step or heading change) commits the ship to its current trajectory
      // and forbids declaring an SA — declarations exist to constrain the
      // activation that follows, not to retroactively re-frame it. Without
      // this check a client could /move (e.g. change heading), then declare
      // all-stop and arm allStopReady, gaining a pivot it never earned.
      if (unit.hasInitiatedMoveThisActivation) throw Object.assign(new Error("Cannot declare a Special Action after movement has started"), { status: 400 });
      // Slice C: Skeleton Crew (crewPoints ≤ ½ max) and Adrift ships
      // cannot declare Special Actions.
      if (unit.damageState === "adrift") {
        throw Object.assign(new Error("Adrift ship cannot declare Special Actions"), { status: 400 });
      }

      // Critical-effect gate: Reactor 5/6, Bridge, Decompression all set
      // noSA. Block the action entirely (no -failed bookkeeping — the rule
      // is "cannot declare", not "declare and roll"). Engines 6 sets
      // crit-adrift which is treated identically to hull-zero adrift for
      // SA purposes (sheet: adrift ships cannot declare SAs).
      const saCritRows = await tx.select().from(unitCriticalEffectsTable)
        .where(eq(unitCriticalEffectsTable.gameUnitId, unit.id));
      const saCrits = deriveCritEffects(saCritRows.map(r => ({
        effectKey: r.effectKey,
        randomArc: r.randomArc,
        randomWeaponId: r.randomWeaponId,
        lostTraits: r.lostTraits ?? [],
      })));
      if (saCrits.adrift) {
        throw Object.assign(new Error("Adrift ship cannot declare Special Actions"), { status: 400 });
      }
      if (saCrits.noSA) {
        throw Object.assign(new Error("Cannot declare Special Actions — Bridge / Reactor crit active"), { status: 400 });
      }

      const [unitShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, unit.shipId));
      const [unitModel] = unitShip
        ? await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, unitShip.shipModelId))
        : [];
      const unitTraits = parseShipTraits(filterLostTraits(unitModel?.traits ?? "", saCrits.lostTraitNames));
      if (unitTraits.fighter || (unitModel ? shipModelIsFighter(unitModel) : false)) {
        throw Object.assign(new Error("Fighter flights cannot declare Special Actions"), { status: 400 });
      }
      if (skeletonPenaltiesApply(unit, unitTraits)) {
        throw Object.assign(new Error("Skeleton crew cannot declare Special Actions"), { status: 400 });
      }

      // Per-action prereqs.
      let storedTarget: number | null = null;
      let nominatedTarget: typeof gameUnitsTable.$inferSelect | null = null;
      if (action === "concentrate-fire") {
        if (targetUnitId == null) throw Object.assign(new Error("Concentrate All Fire-power requires a target"), { status: 400 });
        const [tgt] = await tx.select().from(gameUnitsTable).where(and(
          eq(gameUnitsTable.id, targetUnitId), eq(gameUnitsTable.gameId, gameId),
        ));
        if (!tgt) throw Object.assign(new Error("Target not found"), { status: 404 });
        if (tgt.ownerId === userId) throw Object.assign(new Error("Cannot target your own ship"), { status: 400 });
        if (tgt.isDestroyed) throw Object.assign(new Error("Target already destroyed"), { status: 400 });
        storedTarget = targetUnitId;
        nominatedTarget = tgt;
      }
      if (action === "all-stop-pivot" && !unit.allStopReady) {
        throw Object.assign(new Error("All Stop and Pivot requires that this ship declared All Stop the previous round"), { status: 400 });
      }
      // Come About (extra-turn variant): Lumbering hulls cannot use this
      // variant per sheet — they must use sharp-turn instead. Authoritative
      // server check; the client also hides the button but we don't trust
      // the client across the multiplayer boundary.
      if (action === "come-about-extra-turn") {
        const [ship] = await tx.select().from(shipsTable).where(eq(shipsTable.id, unit.shipId));
        if (ship) {
          const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
          if (model && parseShipTraits(model.traits).lumbering) {
            throw Object.assign(new Error("Lumbering ships cannot use Come About — Extra Turn; use Sharp Turn instead"), { status: 400 });
          }
        }
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
      // All Stop latch transitions:
      //   success "all-stop"        → arm the latch (pivot allowed next round)
      //   success "all-stop-pivot"  → consume the latch (one-shot prerequisite)
      //   anything else             → leave the latch untouched
      let nextAllStopReady = unit.allStopReady;
      if (success && action === "all-stop") nextAllStopReady = true;
      else if (success && action === "all-stop-pivot") nextAllStopReady = false;
      // All Hands on Deck cost: limit firing to 1 weapon system THIS
      // round. Set immediately on success so any further /fire-weapon
      // calls this round are gated. Cleared at the next round rollover.
      const nextOneWeapon = success && action === "all-hands-on-deck"
        ? true
        : unit.oneWeaponThisRound;
      const [updated] = await tx.update(gameUnitsTable).set({
        specialAction: stored,
        specialActionTargetId: success ? storedTarget : null,
        allStopReady: nextAllStopReady,
        oneWeaponThisRound: nextOneWeapon,
      }).where(eq(gameUnitsTable.id, unit.id)).returning();
      await recordSpecialActionAuditLog(tx, {
        game,
        actorKind: "player",
        actorPlayerId: userId,
        unitBefore: unit,
        unitAfter: updated,
        action,
        storedAction: stored,
        success,
        cqRequired,
        cqRoll,
        cqTotal,
        targetUnitId: storedTarget,
        targetUnit: nominatedTarget,
        summary: `${unit.name} ${success ? "passed" : "failed"} ${action}${cqRequired !== null && cqTotal !== null ? ` (${cqTotal} vs ${cqRequired})` : ""}.`,
        payload: {
          rulesPath: "special-action",
          requiresCq: cqRequired !== null,
          allStopReadyBefore: unit.allStopReady,
          allStopReadyAfter: nextAllStopReady,
          oneWeaponBefore: unit.oneWeaponThisRound,
          oneWeaponAfter: nextOneWeapon,
        },
      });

      return {
        action,
        success,
        requiresCq: cqRequired !== null,
        cqRequired,
        cqRoll,
        cqTotal,
        // Apply the canonical adrift overlay so the mutation response
        // matches what GET would return for the same unit.
        unit: { ...updated, damageState: effectiveDamageState(updated.damageState, saCritRows) },
      };
    });
    res.json(out);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

// ── Scout Support Actions ───────────────────────────────────────────────────
// Scout-trait ships may declare one of two support actions per round during
// the Attack Phase, targeting an enemy ship within 36" (world inches).
//   counter-stealth: CQ 8+ → target's Stealth rating drops by 1 for the
//                    rest of the round (target must have Stealth trait).
//   coord:           CQ 8+ → one allied weapon system attacking that target
//                    re-rolls failed AD (consumed at fire time; excludes
//                    Beam / Energy Mine / Twin Linked).
// One scout action per ship per round; cleared at round rollover alongside
// specialAction. Independent of the activation system — either participant
// may declare during the shared pre-fire window at the start of the phase.
router.post("/games/:gameId/units/:unitId/scout-action", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = ChooseScoutActionParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = ChooseScoutActionBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const { gameId, unitId } = params.data;
  const { action, targetUnitId } = body.data;

  const SCOUT_RANGE_INCHES = 36;
  const SCOUT_CQ_REQUIRED = 8;

  try {
    const out = await db.transaction(async (tx) => {
      const lockedRows = await tx.execute(sql`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`);
      if (lockedRows.rows.length === 0) throw Object.assign(new Error("Game not found"), { status: 404 });

      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (game.status !== "active") throw Object.assign(new Error("Game is not active"), { status: 400 });
      if (game.phase !== "firing") throw Object.assign(new Error("Scout support actions are declared during the firing phase"), { status: 400 });
      const isParticipant = userId === game.challengerId || userId === game.opponentId;
      if (!isParticipant) throw Object.assign(new Error("Not a participant in this game"), { status: 403 });
      const gameUnits = await tx.select().from(gameUnitsTable).where(eq(gameUnitsTable.gameId, gameId));
      if (gameUnits.some(unitHasFiredAWeapon)) {
        throw Object.assign(new Error("Scout support must be declared before any weapon fires this phase"), { status: 400 });
      }

      const scout = gameUnits.find(u => u.id === unitId);
      if (!scout) throw Object.assign(new Error("Scout unit not found"), { status: 404 });
      if (scout.ownerId !== userId) throw Object.assign(new Error("Not your ship"), { status: 403 });
      if (scout.isDestroyed) throw Object.assign(new Error("Scout is destroyed"), { status: 400 });
      if (scout.hullPoints <= 0) throw Object.assign(new Error("Scout has no hull — cannot support"), { status: 400 });
      if (scout.maxCrewPoints > 0 && scout.crewPoints <= 0) {
        throw Object.assign(new Error("Scout has no surviving crew — cannot support"), { status: 400 });
      }
      // Skeleton crew (≤½ max) loses Command/Fleet Carrier/Admiral and is
      // already barred from Special Actions — treat scout support the same
      // way (electronic warfare requires a functional crew).
      // Adrift / no-SA crits block scout support too.
      const scoutCritRows = await tx.select().from(unitCriticalEffectsTable)
        .where(eq(unitCriticalEffectsTable.gameUnitId, scout.id));
      const scoutCrits = deriveCritEffects(scoutCritRows.map(r => ({
        effectKey: r.effectKey,
        randomArc: r.randomArc,
        randomWeaponId: r.randomWeaponId,
        lostTraits: r.lostTraits ?? [],
      })));
      if (scoutCrits.adrift) {
        throw Object.assign(new Error("Adrift scout cannot declare support actions"), { status: 400 });
      }
      if (scoutCrits.noSA) {
        throw Object.assign(new Error("Cannot declare scout support — Bridge / Reactor crit active"), { status: 400 });
      }
      if (scout.scoutAction) {
        throw Object.assign(new Error("Scout already used a support action this round"), { status: 400 });
      }

      // Scout trait check — filter out lost traits from crits before parsing
      // so a crit that nuked the Scout trait disables this action.
      const [scoutShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, scout.shipId));
      if (!scoutShip) throw Object.assign(new Error("Scout ship record missing"), { status: 500 });
      const [scoutModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, scoutShip.shipModelId));
      if (!scoutModel) throw Object.assign(new Error("Scout model missing"), { status: 500 });
      const scoutTraits = parseShipTraits(filterLostTraits(scoutModel.traits, scoutCrits.lostTraitNames));
      if (skeletonPenaltiesApply(scout, scoutTraits)) {
        throw Object.assign(new Error("Skeleton crew cannot declare scout support"), { status: 400 });
      }
      if (!scoutTraits.scout) {
        throw Object.assign(new Error("This ship does not have the Scout trait"), { status: 400 });
      }

      // Target validation.
      const [tgt] = await tx.select().from(gameUnitsTable).where(and(
        eq(gameUnitsTable.id, targetUnitId), eq(gameUnitsTable.gameId, gameId),
      ));
      if (!tgt) throw Object.assign(new Error("Target not found"), { status: 404 });
      if (tgt.ownerId === userId) throw Object.assign(new Error("Cannot target your own ship"), { status: 400 });
      if (tgt.isDestroyed) throw Object.assign(new Error("Target already destroyed"), { status: 400 });

      // 36" range — same hex-to-world identity mapping as fire-weapon.
      const sPos = hexToWorld(scout.hexQ, scout.hexR);
      const tPos = hexToWorld(tgt.hexQ, tgt.hexR);
      const dist = Math.hypot(tPos.x - sPos.x, tPos.z - sPos.z);
      if (dist > SCOUT_RANGE_INCHES) {
        throw Object.assign(new Error(`Target out of range (${dist.toFixed(1)}" > ${SCOUT_RANGE_INCHES}")`), { status: 400 });
      }

      // Counter-Stealth requires the target to actually have Stealth.
      // Parse with the same lost-trait filtering used by fire-weapon so a
      // target whose Stealth was crit-stripped can't be counter-stealthed.
      if (action === "counter-stealth") {
        const [tgtShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, tgt.shipId));
        if (!tgtShip) throw Object.assign(new Error("Target ship record missing"), { status: 500 });
        const [tgtModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, tgtShip.shipModelId));
        if (!tgtModel) throw Object.assign(new Error("Target model missing"), { status: 500 });
        const tgtCritRows = await tx.select().from(unitCriticalEffectsTable)
          .where(eq(unitCriticalEffectsTable.gameUnitId, tgt.id));
        const tgtCrits = deriveCritEffects(tgtCritRows.map(r => ({
          effectKey: r.effectKey,
          randomArc: r.randomArc,
          randomWeaponId: r.randomWeaponId,
          lostTraits: r.lostTraits ?? [],
        })));
        const tgtLostLc = new Set(Array.from(tgtCrits.lostTraitNames).map(n => n.toLowerCase()));
        const tgtFiltered = (tgtModel.traits ?? "").split(/[;,]/).map(t => t.trim()).filter(Boolean)
          .filter(t => !tgtLostLc.has(t.toLowerCase().split(/\s+/)[0])).join("; ");
        const tgtTraits = parseShipTraits(tgtFiltered);
        if (tgtTraits.stealth <= 0) {
          throw Object.assign(new Error("Counter-Stealth requires a target with the Stealth trait"), { status: 400 });
        }
      }

      // CQ check: 1d6 + crewQuality ≥ 8.
      const cqRoll = rollD6();
      const cqTotal = cqRoll + scout.crewQuality;
      const success = cqTotal >= SCOUT_CQ_REQUIRED;
      // Failed attempts still occupy the per-round slot (the scout tried
      // and burned its window), so we record a "-failed" suffix mirroring
      // the Special Action convention. Target id is only kept on success
      // since failed attempts have no downstream effect to key on.
      const stored = success ? action : `${action}-failed`;
      const [updated] = await tx.update(gameUnitsTable).set({
        scoutAction: stored,
        scoutActionTargetId: success ? targetUnitId : null,
        scoutCoordConsumed: false,
      }).where(eq(gameUnitsTable.id, scout.id)).returning();

      return {
        action,
        targetUnitId,
        success,
        cqRoll,
        cqTotal,
        cqRequired: SCOUT_CQ_REQUIRED,
        unit: { ...updated, damageState: effectiveDamageState(updated.damageState, scoutCritRows) },
      };
    });
    res.json(out);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

// ── Initiative Roll ─────────────────────────────────────────────────────────
// Each player rolls 2d6 once during the Initiative phase. When both have
// rolled, the higher total wins and the phase transitions to movement with
// that player active. Ties clear both rolls so players re-roll.
router.post("/games/:gameId/roll-initiative", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const gameId = Number(req.params.gameId);
  if (!Number.isFinite(gameId)) { res.status(400).json({ error: "Invalid gameId" }); return; }
  try {
    const updated = await db.transaction(async (tx) => {
      const lockedRows = await tx.execute(sql`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`);
      if (lockedRows.rows.length === 0) throw Object.assign(new Error("Game not found"), { status: 404 });
      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (game.status !== "active") throw Object.assign(new Error("Game is not active"), { status: 400 });
      if (game.phase !== "initiative") throw Object.assign(new Error("Not in Initiative phase"), { status: 400 });
      const myRoll = rollD6() + rollD6() + await initiativeModifierForPlayer(tx, game.id, userId);
      return applyInitiativeRoll(tx, game, userId, myRoll);
    });
    res.json(updated);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

// ── Choose First Activator ──────────────────────────────────────────────────
// After both players have rolled initiative and a winner is determined, the
// initiative winner decides who activates first this round (themself or the
// opponent — sometimes you want to make the other side commit a movement
// first so you can react). This transitions phase → movement.
router.post("/games/:gameId/ai/step", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const gameId = Number(req.params.gameId);
  if (!Number.isFinite(gameId)) { res.status(400).json({ error: "Invalid gameId" }); return; }

  try {
    const updated = await db.transaction(async (tx) => {
      const lockedRows = await tx.execute(sql`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`);
      if (lockedRows.rows.length === 0) throw Object.assign(new Error("Game not found"), { status: 404 });
      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (game.challengerId !== userId) {
        throw Object.assign(new Error("Only the human commander can run the AI debug step"), { status: 403 });
      }
      if (game.opponentKind !== "ai" || game.opponentId !== AI_OPPONENT_ID) {
        throw Object.assign(new Error("Game does not have an AI opponent"), { status: 400 });
      }

      if (game.status !== "active") {
        const [row] = await tx.update(gamesTable).set({
          aiState: mergeAiState(game.aiState, aiState("idle", "step.waiting-for-active-game", {
            message: `No AI step run: game status is ${game.status}.`,
          })),
        }).where(eq(gamesTable.id, game.id)).returning();
        return row;
      }

      if ((game.phase === "movement" || game.phase === "firing") && game.activePlayerId !== AI_OPPONENT_ID) {
        const [row] = await tx.update(gamesTable).set({
          aiState: mergeAiState(game.aiState, aiState("idle", `${game.phase}.waiting-for-human`, {
            message: `No AI step run: waiting for the human commander in ${game.phase}.`,
          })),
        }).where(eq(gamesTable.id, game.id)).returning();
        return row;
      }

      if (game.phase === "movement") {
        const antiFighterRow = await resolvePendingAiAntiFighter(tx, game);
        if (antiFighterRow) {
          req.log.info({
            gameId,
            nextPhase: antiFighterRow.phase,
            nextActivePlayerId: antiFighterRow.activePlayerId,
          }, "ai debug step resolved pending anti-fighter allocation");
          return antiFighterRow;
        }

        const row = game.activeUnitId
          ? await moveActiveAiUnit(tx, game)
          : await activateAiUnitForPhase(tx, game, "movement");
        req.log.info({ gameId, activeUnitId: game.activeUnitId, nextPhase: row.phase, nextActivePlayerId: row.activePlayerId }, "ai debug step handled movement");
        return row;
      }

      if (game.phase === "firing") {
        const row = game.activeUnitId
          ? await finishActiveAiFiringWithoutShot(tx, game)
          : await activateAiUnitForPhase(tx, game, "firing");
        req.log.info({ gameId, activeUnitId: game.activeUnitId, nextPhase: row.phase, nextActivePlayerId: row.activePlayerId }, "ai debug step handled firing");
        return row;
      }

      if (game.phase === "end") {
        const row = await passAiEndPhase(tx, game);
        req.log.info({ gameId, nextActivePlayerId: row.activePlayerId, aiState: row.aiState }, "ai debug step handled end phase");
        return row;
      }

      if (game.phase !== "initiative") {
        const [row] = await tx.update(gamesTable).set({
          aiState: mergeAiState(game.aiState, aiState("idle", `step.${game.phase}.not-implemented`, {
            message: `No AI step implemented for ${game.phase} phase yet.`,
          })),
        }).where(eq(gamesTable.id, game.id)).returning();
        return row;
      }

      if (
        game.initiativeWinnerId === AI_OPPONENT_ID &&
        game.initiativeChallengerRoll !== null &&
        game.initiativeOpponentRoll !== null
      ) {
        const row = await chooseHumanFirstAfterAiInitiative(tx, game);
        req.log.info({ gameId, activePlayerId: row.activePlayerId }, "ai debug step chose first activator");
        return row;
      }

      if (game.initiativeOpponentRoll !== null) {
        const [row] = await tx.update(gamesTable).set({
          aiState: mergeAiState(game.aiState, aiState("idle", "initiative.already-rolled", {
            message: "AI has already rolled initiative this round.",
          })),
        }).where(eq(gamesTable.id, game.id)).returning();
        return row;
      }

      const aiRoll = rollD6() + rollD6() + await initiativeModifierForPlayer(tx, game.id, AI_OPPONENT_ID);
      const rolled = await applyInitiativeRoll(tx, game, AI_OPPONENT_ID, aiRoll, aiState("acted", "initiative.roll", {
        message: `AI rolled initiative: ${aiRoll}.`,
      }));
      const row = await chooseHumanFirstAfterAiInitiative(tx, rolled);
      req.log.info({ gameId, aiRoll, phase: row.phase, initiativeWinnerId: row.initiativeWinnerId }, "ai debug step rolled initiative");
      return row;
    });
    res.json(updated);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    try {
      const [game] = await db.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (game?.opponentKind === "ai" && game.challengerId === userId) {
        await db.update(gamesTable).set({
          aiState: mergeAiState(game.aiState, aiErrorState("step.error", e)),
        }).where(eq(gamesTable.id, gameId));
      }
    } catch (persistErr) {
      req.log.warn({ err: persistErr, gameId }, "failed to persist ai step error state");
    }
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

router.post("/games/:gameId/choose-first-activator", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const gameId = Number(req.params.gameId);
  if (!Number.isFinite(gameId)) { res.status(400).json({ error: "Invalid gameId" }); return; }
  const activatorUserId = String((req.body ?? {}).activatorUserId ?? "");
  if (!activatorUserId) { res.status(400).json({ error: "activatorUserId is required" }); return; }
  try {
    const updated = await db.transaction(async (tx) => {
      const lockedRows = await tx.execute(sql`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`);
      if (lockedRows.rows.length === 0) throw Object.assign(new Error("Game not found"), { status: 404 });
      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (game.status !== "active") throw Object.assign(new Error("Game is not active"), { status: 400 });
      if (game.phase !== "initiative") throw Object.assign(new Error("Not in Initiative phase"), { status: 400 });
      if (!game.initiativeWinnerId) throw Object.assign(new Error("Initiative winner not yet determined"), { status: 400 });
      if (game.initiativeChallengerRoll === null || game.initiativeOpponentRoll === null) {
        throw Object.assign(new Error("Both players must roll first"), { status: 400 });
      }
      if (userId !== game.initiativeWinnerId) {
        throw Object.assign(new Error("Only the initiative winner may choose the first activator"), { status: 403 });
      }
      if (activatorUserId !== game.challengerId && activatorUserId !== game.opponentId) {
        throw Object.assign(new Error("activatorUserId must be a participant in this game"), { status: 400 });
      }
      const otherActivatorId = activatorUserId === game.challengerId ? game.opponentId : game.challengerId;
      const activePlayerId =
        await firstEligiblePlayerForAiPhase(
          tx,
          game,
          "movement",
          [activatorUserId, otherActivatorId ?? ""],
        )
        ?? activatorUserId;
      const [row] = await tx.update(gamesTable).set({
        phase: "movement",
        activePlayerId,
        activeUnitId: null,
      }).where(eq(gamesTable.id, gameId)).returning();
      return row;
    });
    res.json(updated);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

// ── Pass End Phase ──────────────────────────────────────────────────────────
// Initiative winner passes first, control then hands to the opponent. When
// both pass, the round actually rolls over (resets, shield regen, delayed
// catastrophic kills, interceptor refresh, win-check, init rolls cleared,
// phase → initiative for the new round).
router.post("/games/:gameId/pass-end-phase", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const gameId = Number(req.params.gameId);
  if (!Number.isFinite(gameId)) { res.status(400).json({ error: "Invalid gameId" }); return; }
  try {
    const updated = await db.transaction(async (tx) => {
      const lockedRows = await tx.execute(sql`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`);
      if (lockedRows.rows.length === 0) throw Object.assign(new Error("Game not found"), { status: 404 });
      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (game.status !== "active") throw Object.assign(new Error("Game is not active"), { status: 400 });
      if (game.phase !== "end") throw Object.assign(new Error("Not in End Phase"), { status: 400 });
      if (game.activePlayerId !== userId) throw Object.assign(new Error("Not your end-phase window"), { status: 400 });
      const isChallenger = userId === game.challengerId;
      const isOpponent = userId === game.opponentId;
      if (!isChallenger && !isOpponent) throw Object.assign(new Error("Not a participant"), { status: 403 });

      const cPassed = isChallenger ? true : game.endPhaseChallengerPassed;
      const oPassed = isOpponent ? true : game.endPhaseOpponentPassed;

      if (!(cPassed && oPassed)) {
        // First passer — hand off to the other player. (Already-passed is
        // covered by activePlayerId guard above; the OTHER player can never
        // be the active player while still owing a pass.)
        const otherId = isChallenger ? game.opponentId : game.challengerId;
        const [row] = await tx.update(gamesTable).set({
          endPhaseChallengerPassed: cPassed,
          endPhaseOpponentPassed: oPassed,
          activePlayerId: otherId,
          activeUnitId: null,
        }).where(eq(gamesTable.id, gameId)).returning();
        return row;
      }

      // Both passed → run round rollover.
      // 1. Resolve automatic adrift drift once per ship for this round.
      const driftCandidates = await tx.select().from(gameUnitsTable).where(and(
        eq(gameUnitsTable.gameId, game.id),
        eq(gameUnitsTable.isDestroyed, false),
      ));
      for (const u of driftCandidates) {
        if (u.lastAdriftDriftRound === game.currentRound) continue;
        const critRows = await tx.select().from(unitCriticalEffectsTable)
          .where(eq(unitCriticalEffectsTable.gameUnitId, u.id));
        const state = effectiveDamageState(u.damageState, critRows);
        if (state !== "adrift" && state !== "exploding-end-of-next") continue;
        const crits = deriveCritEffects(critRows.map(r => ({
          effectKey: r.effectKey,
          randomArc: r.randomArc,
          randomWeaponId: r.randomWeaponId,
          lostTraits: r.lostTraits ?? [],
        })));
        const driftDistance = Math.floor(effectiveBaseSpeed(u, crits) / 2);
        const forward = headingForwardVec(u);
        const driftTo = {
          hexQ: Math.round(u.hexQ + forward.x * driftDistance),
          hexR: Math.round(u.hexR + forward.z * driftDistance),
        };
        const [driftedUnit] = await tx.update(gameUnitsTable)
          .set({
            hexQ: driftTo.hexQ,
            hexR: driftTo.hexR,
            hasMovedThisRound: true,
            hasInitiatedMoveThisActivation: false,
            inchesMovedThisActivation: 0,
            turnsMadeThisActivation: 0,
            distanceSinceLastTurnThisActivation: 0,
            allStopReady: false,
            lastAdriftDriftRound: game.currentRound,
          })
          .where(and(
            eq(gameUnitsTable.id, u.id),
            eq(gameUnitsTable.lastAdriftDriftRound, u.lastAdriftDriftRound),
          ))
          .returning();
        if (driftedUnit) {
          await recordMovementAuditLog(tx, {
            game,
            actorKind: "system",
            actorPlayerId: null,
            unitBefore: u,
            unitAfter: driftedUnit,
            movementKind: "adrift-drift",
            summary: `${u.name} drifted ${driftDistance}" during end-phase adrift movement.`,
            payload: {
              rulesPath: "end-phase-adrift-drift",
              effectiveState: state,
              driftDistance,
              forward,
              driftTo,
              critEffects: (critRows as Array<typeof unitCriticalEffectsTable.$inferSelect>)
                .map(r => ({ id: r.id, effectKey: r.effectKey, name: r.name })),
            },
          });
        }
      }

      // 2. Reset per-round flags on surviving units. All Hands on Deck's
      // one-weapon-fired restriction applies to the SAME round in which
      // it was declared, so we clear `oneWeaponThisRound` here alongside
      // every other per-round flag.
      await tx.update(gameUnitsTable).set({
        hasMovedThisRound: false,
        hasFiredThisRound: false,
        firedWeaponIds: [],
        hasInitiatedMoveThisActivation: false,
        inchesMovedThisActivation: 0,
        turnsMadeThisActivation: 0,
        distanceSinceLastTurnThisActivation: 0,
        specialAction: null,
        specialActionTargetId: null,
        scoutAction: null,
        scoutActionTargetId: null,
        scoutCoordConsumed: false,
        hitByUnitIdsThisRound: [],
        oneWeaponThisRound: false,
        fighterBayOperationsRound: 0,
        fighterBayOperationsUsed: 0,
      }).where(and(eq(gameUnitsTable.gameId, game.id), eq(gameUnitsTable.isDestroyed, false)));

      // 2. Resolve delayed catastrophic kills.
      const delayedKills = await tx.select().from(gameUnitsTable).where(and(
        eq(gameUnitsTable.gameId, game.id),
        eq(gameUnitsTable.damageState, "exploding-end-of-next"),
      ));
      for (const unit of delayedKills as Array<typeof gameUnitsTable.$inferSelect>) {
        const [destroyedUnit] = await tx.update(gameUnitsTable).set({
          damageState: "destroyed",
          isDestroyed: true,
        }).where(eq(gameUnitsTable.id, unit.id)).returning();
        if (destroyedUnit) {
          await resolveDestroyedFighterRecovery(tx, game, destroyedUnit, "end-phase");
        }
      }

      await autoRepairRedundantSystemCriticals(tx, game.id);

      // 3. Re-evaluate win condition.
      const postExplosion = await tx.select().from(gameUnitsTable)
        .where(eq(gameUnitsTable.gameId, game.id));
      let cAlive = 0, oAlive = 0;
      for (const u of postExplosion) {
        if (!unitCountsForVictory(u)) continue;
        if (u.ownerId === game.challengerId) cAlive++;
        else if (u.ownerId === game.opponentId) oAlive++;
      }
      if (game.opponentId && cAlive === 0 && oAlive > 0) {
        const [row] = await tx.update(gamesTable).set({ status: "completed", winnerId: game.opponentId, activePlayerId: null, activeUnitId: null })
          .where(eq(gamesTable.id, game.id)).returning();
        return row;
      } else if (game.opponentId && oAlive === 0 && cAlive > 0) {
        const [row] = await tx.update(gamesTable).set({ status: "completed", winnerId: game.challengerId, activePlayerId: null, activeUnitId: null })
          .where(eq(gamesTable.id, game.id)).returning();
        return row;
      } else if (game.opponentId && cAlive === 0 && oAlive === 0) {
        const [row] = await tx.update(gamesTable).set({ status: "completed", winnerId: null, activePlayerId: null, activeUnitId: null })
          .where(eq(gamesTable.id, game.id)).returning();
        return row;
      }

      // 4. Shield regen.
      const survivors = await tx.select().from(gameUnitsTable).where(and(
        eq(gameUnitsTable.gameId, game.id), eq(gameUnitsTable.isDestroyed, false),
      ));
      for (const u of survivors) {
        const [ship] = await tx.select().from(shipsTable).where(eq(shipsTable.id, u.shipId));
        if (!ship) continue;
        const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
        if (isCrippledUnit(u)) {
          if (u.shieldsCurrent !== 0) {
            await tx.update(gameUnitsTable).set({ shieldsCurrent: 0 }).where(eq(gameUnitsTable.id, u.id));
          }
          continue;
        }
        const max = model?.shieldMax ?? 0;
        const regen = model?.shieldRegenRate ?? 0;
        if (max <= 0 || regen <= 0) continue;
        const next = Math.min(max, u.shieldsCurrent + regen);
        if (next !== u.shieldsCurrent) {
          await tx.update(gameUnitsTable).set({ shieldsCurrent: next }).where(eq(gameUnitsTable.id, u.id));
        }
      }

      // 5. Interceptor refresh (filtered against permanently-lost traits).
      for (const u of survivors) {
        const [ship] = await tx.select().from(shipsTable).where(eq(shipsTable.id, u.shipId));
        if (!ship) continue;
        const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
        const critRows = await tx.select().from(unitCriticalEffectsTable)
          .where(eq(unitCriticalEffectsTable.gameUnitId, u.id));
        const crits = deriveCritEffects(critRows.map(r => ({
          effectKey: r.effectKey,
          randomArc: r.randomArc,
          randomWeaponId: r.randomWeaponId,
          lostTraits: r.lostTraits ?? [],
        })));
        const fullPool = isCrippledUnit(u)
          ? 0
          : parseShipTraits(filterLostTraits(model?.traits ?? "", crits.lostTraitNames)).interceptors;
        if (u.interceptorDiceRemaining !== fullPool || u.interceptorThresholdCurrent !== 2) {
          await tx.update(gameUnitsTable).set({
            interceptorDiceRemaining: fullPool,
            interceptorThresholdCurrent: 2,
          }).where(eq(gameUnitsTable.id, u.id));
        }
      }

      // 6. Advance round → Initiative phase. Clear init rolls & end-pass
      // latches so both players have to roll fresh.
      const [row] = await tx.update(gamesTable).set({
        currentRound: game.currentRound + 1,
        currentTurn: game.currentTurn + 1,
        phase: "initiative",
        activePlayerId: null,
        activeUnitId: null,
        initiativeWinnerId: null,
        initiativeChallengerRoll: null,
        initiativeOpponentRoll: null,
        endPhaseChallengerPassed: false,
        endPhaseOpponentPassed: false,
      }).where(eq(gamesTable.id, gameId)).returning();
      return row;
    });
    res.json(updated);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

// ── Self Repair ────────────────────────────────────────────────────────────
// Restores hull from traits such as "Self Repair:3d6" during the controlling
// player's End Phase window. It is separate from Damage Control: it does not
// remove critical-effect rows or undo crew loss.
router.post("/games/:gameId/units/:unitId/self-repair", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = DamageControlParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const { gameId, unitId } = params.data;

  try {
    const out = await db.transaction(async (tx) => {
      const lockedRows = await tx.execute(sql`SELECT id FROM games WHERE id = ${gameId} FOR UPDATE`);
      if (lockedRows.rows.length === 0) throw Object.assign(new Error("Game not found"), { status: 404 });
      const [game] = await tx.select().from(gamesTable).where(eq(gamesTable.id, gameId));
      if (!game) throw Object.assign(new Error("Game not found"), { status: 404 });
      if (game.status !== "active") throw Object.assign(new Error("Game is not active"), { status: 400 });
      if (game.phase !== "end") {
        throw Object.assign(new Error("Self Repair may only be resolved in the End Phase"), { status: 400 });
      }
      if (game.activePlayerId !== userId) {
        throw Object.assign(new Error("It's not your End Phase repair window"), { status: 400 });
      }
      const alreadyPassed = userId === game.challengerId
        ? game.endPhaseChallengerPassed
        : userId === game.opponentId
        ? game.endPhaseOpponentPassed
        : true;
      if (alreadyPassed) {
        throw Object.assign(new Error("You've already passed the End Phase this round"), { status: 400 });
      }

      const [unit] = await tx.select().from(gameUnitsTable).where(and(
        eq(gameUnitsTable.id, unitId), eq(gameUnitsTable.gameId, gameId),
      ));
      if (!unit) throw Object.assign(new Error("Unit not found"), { status: 404 });
      if (unit.ownerId !== userId) throw Object.assign(new Error("Not your ship"), { status: 403 });

      const result = await resolveSelfRepairForUnit(tx, game, unit, { throwOnUnavailable: true });
      if (!result) throw Object.assign(new Error("Self Repair unavailable"), { status: 400 });

      const liveCrits = await tx.select().from(unitCriticalEffectsTable)
        .where(eq(unitCriticalEffectsTable.gameUnitId, unit.id));
      return {
        dice: result.dice,
        rolls: result.rolls,
        total: result.total,
        repaired: result.repaired,
        hullBefore: result.hullBefore,
        hullAfter: result.hullAfter,
        unit: {
          ...result.unitAfter,
          damageState: effectiveDamageState(result.unitAfter.damageState, liveCrits),
          criticals: liveCrits,
          isCrippled: isCrippledUnit(result.unitAfter),
          isSkeletonCrew: isSkeletonCrewUnit(result.unitAfter),
        },
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
// disables DC for the ship). Success removes the row's special effect only;
// Damage and Crew points lost to the critical are not restored.
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
      if (unit.hullPoints <= 0) throw Object.assign(new Error("Hulked ships cannot perform Damage Control"), { status: 400 });
      if (unit.maxCrewPoints > 0 && unit.crewPoints <= 0) {
        throw Object.assign(new Error("Crewless ships cannot perform Damage Control"), { status: 400 });
      }
      // All Hands on Deck (success) lifts the once-per-round-per-ship DC
      // cap — the ship may repair any number of criticals this End Phase.
      const allHandsActive = unit.specialAction === "all-hands-on-deck";
      if (!allHandsActive && unit.lastDcRound === game.currentRound) {
        throw Object.assign(new Error("Damage control already attempted this round"), { status: 400 });
      }
      // Damage control happens only during the End Phase, and only while
      // it's THIS player's end-phase window (initiative winner repairs
      // first, then the opponent after they pass).
      if (game.phase !== "end") {
        throw Object.assign(new Error("Damage control may only be attempted in the End Phase"), { status: 400 });
      }
      if (game.activePlayerId !== userId) {
        throw Object.assign(new Error("It's not your turn to repair — wait for the other player to pass the End Phase"), { status: 400 });
      }
      // If this player has already passed the end phase, they're done.
      const alreadyPassed = userId === game.challengerId
        ? game.endPhaseChallengerPassed
        : game.endPhaseOpponentPassed;
      if (alreadyPassed) {
        throw Object.assign(new Error("You've already passed the End Phase this round"), { status: 400 });
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
      const [unitShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, unit.shipId));
      const [unitModel] = unitShip
        ? await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, unitShip.shipModelId))
        : [];
      const unitTraits = parseShipTraits(filterLostTraits(unitModel?.traits ?? "", crits.lostTraitNames));
      const skeletonPenalty = skeletonPenaltiesApply(unit, unitTraits) ? 2 : 0;
      const dcPenalty = crits.damageControlPenalty + skeletonPenalty;
      // All Hands on Deck (declared as a movement-phase SA): +2 to all
      // damage-control rolls this round AND removes the
      // once-per-round-per-ship cap (any number of crits can be
      // repaired). The cost — only one weapon system may fire this round
      // — is latched on successful declaration via `oneWeaponThisRound`
      // and cleared at rollover.
      const allHandsBonus = allHandsActive ? 2 : 0;
      const dcTotal = dcRoll + unit.crewQuality - dcPenalty + allHandsBonus;
      const dcThreshold = 9;
      const success = dcTotal >= dcThreshold;

      // Record the attempt. When all-hands is active we deliberately do
      // NOT update lastDcRound — the cap is suspended for the round, so
      // setting it would falsely lock out follow-up repairs.
      if (!allHandsActive) {
        await tx.update(gameUnitsTable)
          .set({ lastDcRound: game.currentRound })
          .where(eq(gameUnitsTable.id, unit.id));
      }

      if (success) {
        await tx.delete(unitCriticalEffectsTable).where(eq(unitCriticalEffectsTable.id, effect.id));
      }
      const [updated] = await tx.select().from(gameUnitsTable).where(eq(gameUnitsTable.id, unit.id));
      // Attach live criticals so the response satisfies the GameUnit
      // contract and the client can refresh the panel without a roundtrip.
      const liveCrits = await tx.select().from(unitCriticalEffectsTable)
        .where(eq(unitCriticalEffectsTable.gameUnitId, unit.id));

      try {
        await recordSpecialActionAuditLog(tx, {
          game,
          actorKind: "player",
          actorPlayerId: userId,
          unitBefore: unit,
          unitAfter: updated,
          action: "damage-control",
          storedAction: "damage-control",
          success,
          cqRequired: dcThreshold,
          cqRoll: dcRoll,
          cqTotal: dcTotal,
          targetUnitId: null,
          summary: `${unit.name} ${success ? "repaired" : "failed to repair"} ${effect.name} with Damage Control (${dcRoll} + CQ ${unit.crewQuality}${dcPenalty > 0 ? ` - ${dcPenalty}` : ""}${allHandsBonus > 0 ? ` + ${allHandsBonus}` : ""} = ${dcTotal}; needed ${dcThreshold}).`,
          payload: {
            rulesPath: "end-phase-damage-control",
            effect: {
              id: effect.id,
              name: effect.name,
              location: effect.location,
              effectKey: effect.effectKey,
              appliedRound: effect.appliedRound,
              damageApplied: effect.damageApplied,
              crewApplied: effect.crewApplied,
              repairable: effect.repairable,
            },
            dcRoll,
            crewQuality: unit.crewQuality,
            dcPenalty,
            dcBonus: allHandsBonus,
            dcTotal,
            dcThreshold,
            allHandsActive,
            repairedEffect: success,
          },
        });
      } catch (err) {
        req.log.warn({ err, gameId, unitId: unit.id, effectId: effect.id }, "damage control audit log insert failed");
      }
      return {
        success, dcRoll, dcTotal, dcThreshold, dcPenalty, dcBonus: allHandsBonus, effectId,
        unit: { ...updated, damageState: effectiveDamageState(updated.damageState, liveCrits), criticals: liveCrits },
      };
    });
    res.json(out);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Unknown error" });
  }
});

export default router;
