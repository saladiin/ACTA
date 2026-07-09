import { Router, type IRouter } from "express";
import { eq, and, or, isNull, sql, inArray } from "drizzle-orm";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, gamesTable, gameUnitsTable, turnsTable, fleetsTable, shipsTable, shipModelsTable, playersTable, weaponsTable, unitCriticalEffectsTable } from "@workspace/db";
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
}, crits: { speedReduce: number }): number {
  const crippledSpeed = isCrippledUnit(unit) ? Math.floor(unit.speed / 2) : unit.speed;
  return Math.max(0, crippledSpeed - crits.speedReduce);
}

function movementSpeedCap(unit: {
  speed: number;
  hullPoints: number;
  maxHullPoints: number;
  damageThreshold?: number | null;
  isDestroyed?: boolean;
  specialAction: string | null;
}, crits: { speedReduce: number }): number {
  const baseAction = (unit.specialAction ?? "").replace(/-failed$/, "");
  const baseSpeed = effectiveBaseSpeed(unit, crits);
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
}, traits?: { superManeuverable?: boolean }): { maxTurns: number; turnAngle: number; turnsForbidden: boolean } {
  const baseAction = (unit.specialAction ?? "").replace(/-failed$/, "");
  const crippled = isCrippledUnit(unit);
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

function snapHalfInch(value: number): number {
  return Math.round(value * 2) / 2;
}

function snapBoardCoord(value: number): number {
  return Math.round(value * 1000) / 1000;
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
  shipClass?: string | null;
  traits?: string | null;
}): boolean {
  return parseShipTraits(model.traits ?? "").fighter || /\bfighter\b/i.test(model.shipClass ?? "");
}

const STANDARD_BASE_RADIUS_INCHES = 0.8;
const BASE_CONTACT_EPSILON = 0.05;

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
  return normalizeShipAiProfile(model?.aiProfile) ?? fallbackShipAiProfileByName(model?.name);
}

function canBasesOverlap(a: Pick<UnitFootprint, "isFighter">, b: Pick<UnitFootprint, "isFighter">): boolean {
  return false;
}

function basesOverlap(a: UnitFootprint, b: UnitFootprint): boolean {
  return centerDistance(a, b) < rulesBaseRadius(a) + rulesBaseRadius(b) - BASE_CONTACT_EPSILON;
}

function findIllegalBaseOverlap(candidate: UnitFootprint, others: UnitFootprint[]): UnitFootprint | null {
  for (const other of others) {
    if (candidate.id === other.id) continue;
    if (canBasesOverlap(candidate, other)) continue;
    if (basesOverlap(candidate, other)) return other;
  }
  return null;
}

function findLegalEndpointAlongSegment(
  start: { x: number; z: number },
  requestedEnd: { x: number; z: number },
  moving: UnitFootprint,
  blockers: UnitFootprint[],
): { x: number; z: number; moved: number; blocker: UnitFootprint | null } {
  const vx = requestedEnd.x - start.x;
  const vz = requestedEnd.z - start.z;
  const length = Math.hypot(vx, vz);
  const normalized = length > 1e-9
    ? { x: vx / length, z: vz / length }
    : { x: 0, z: 0 };

  for (let distance = snapHalfInch(length); distance >= 0; distance -= 0.5) {
    const x = snapBoardCoord(start.x + normalized.x * distance);
    const z = snapBoardCoord(start.z + normalized.z * distance);
    const candidate: UnitFootprint = {
      ...moving,
      x,
      z,
    };
    const blocker = findIllegalBaseOverlap(candidate, blockers);
    if (!blocker) return { x, z, moved: distance, blocker: null };
  }

  const candidate: UnitFootprint = {
    ...moving,
    x: snapBoardCoord(start.x),
    z: snapBoardCoord(start.z),
  };
  return {
    x: candidate.x,
    z: candidate.z,
    moved: 0,
    blocker: findIllegalBaseOverlap(candidate, blockers),
  };
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
      if (x < -24 || x > 24 || z < -36 || z > 36) continue;

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
      const attackScore = ownArc.threat * 5 + broadsideBonus + jousterBonus;
      const desiredRange = aiProfile === "standoff"
        ? 18
        : aiProfile === "broadside"
          ? 10
          : aiProfile === "jouster"
            ? 12
            : 3;
      const rangeScore = target
        ? aiProfile === "brawler"
          ? -targetEdgeDistance * 1.4
          : -Math.abs(targetEdgeDistance - desiredRange)
        : moved;
      const profileMoveBias = aiProfile === "standoff"
        ? nearestEnemyDistance * 0.75
        : aiProfile === "brawler"
          ? moved * 0.12
          : 0;
      const survivalScore = lowHealth
        ? nearestEnemyDistance * 1.2 - incomingThreat * 18
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

function clampMovementToFirstIllegalContact(
  start: { x: number; z: number },
  requestedEnd: { x: number; z: number },
  moving: Pick<UnitFootprint, "id" | "isFighter" | "baseRadiusInches">,
  blockers: UnitFootprint[],
): { x: number; z: number; clamped: boolean; blocker: UnitFootprint | null } {
  const vx = requestedEnd.x - start.x;
  const vz = requestedEnd.z - start.z;
  const a = vx * vx + vz * vz;
  if (a <= 1e-9) return { ...requestedEnd, clamped: false, blocker: null };

  let bestT = 1;
  let bestBlocker: UnitFootprint | null = null;
  for (const blocker of blockers) {
    if (moving.id === blocker.id) continue;
    if (canBasesOverlap(moving, blocker)) continue;

    const minDistance = rulesBaseRadius(moving) + rulesBaseRadius(blocker);
    const sx = start.x - blocker.x;
    const sz = start.z - blocker.z;
    const currentDistance = Math.hypot(sx, sz);
    const b = 2 * (sx * vx + sz * vz);
    const c = sx * sx + sz * sz - minDistance * minDistance;
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) continue;

    const sqrtDisc = Math.sqrt(discriminant);
    const roots = [(-b - sqrtDisc) / (2 * a), (-b + sqrtDisc) / (2 * a)]
      .filter(t => t >= -1e-6 && t <= 1 + 1e-6)
      .map(t => Math.max(0, Math.min(1, t)))
      .sort((x, y) => x - y);
    const hitT = roots[0];
    if (hitT === undefined) continue;
    if (hitT <= BASE_CONTACT_EPSILON && currentDistance <= minDistance + BASE_CONTACT_EPSILON) {
      continue;
    }
    if (hitT < bestT) {
      bestT = hitT;
      bestBlocker = blocker;
    }
  }

  if (!bestBlocker || bestT >= 1) return { ...requestedEnd, clamped: false, blocker: null };
  return {
    x: start.x + vx * bestT,
    z: start.z + vz * bestT,
    clamped: true,
    blocker: bestBlocker,
  };
}

function fighterWeaponRangeDistance(
  attacker: UnitFootprint,
  target: { x: number; z: number },
): number {
  const dist = centerDistance(attacker, target);
  return attacker.isFighter ? Math.max(0, dist - rulesBaseRadius(attacker)) : dist;
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
    const [row] = await tx.update(gamesTable).set({
      ...baseUpdate,
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
  for (const u of units) {
    const [ship] = await tx.select().from(shipsTable).where(eq(shipsTable.id, u.shipId));
    if (!ship) continue;
    const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.shipModelId));
    if (model && parseShipTraits(model.traits).ancient) return 4;
  }
  return 0;
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

  const [row] = await tx.update(gamesTable).set({
    phase: "movement",
    activePlayerId: game.challengerId,
    activeUnitId: null,
    aiState: mergeAiState(game.aiState, aiState("acted", "initiative.choose-first-activator", {
      message: "AI won initiative and chose the human commander to activate first.",
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

async function aiMovementEligible(tx: any, unit: typeof gameUnitsTable.$inferSelect): Promise<boolean> {
  if (unit.isDestroyed || unit.hasMovedThisRound) return false;
  const critRows = await tx.select().from(unitCriticalEffectsTable)
    .where(eq(unitCriticalEffectsTable.gameUnitId, unit.id));
  const state = effectiveDamageState(unit.damageState, critRows);
  return state !== "adrift" && state !== "exploding-end-of-next";
}

function aiFiringEligible(unit: typeof gameUnitsTable.$inferSelect): boolean {
  return !unit.isDestroyed
    && !unit.hasFiredThisRound
    && unit.hullPoints > 0
    && (unit.maxCrewPoints === 0 || unit.crewPoints > 0);
}

async function firstAiEligibleUnit(
  tx: any,
  game: typeof gamesTable.$inferSelect,
  phase: "movement" | "firing",
): Promise<typeof gameUnitsTable.$inferSelect | null> {
  const rows = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.ownerId, AI_OPPONENT_ID),
    eq(gameUnitsTable.isDestroyed, false),
    eq(phase === "movement" ? gameUnitsTable.hasMovedThisRound : gameUnitsTable.hasFiredThisRound, false),
  ));
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
): Promise<number> {
  const rows = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.ownerId, ownerId),
    eq(gameUnitsTable.isDestroyed, false),
    eq(phase === "movement" ? gameUnitsTable.hasMovedThisRound : gameUnitsTable.hasFiredThisRound, false),
  ));
  let count = 0;
  for (const row of rows) {
    if (phase === "movement" && await aiMovementEligible(tx, row)) count++;
    if (phase === "firing" && aiFiringEligible(row)) count++;
  }
  return count;
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
  const humanRemaining = await countEligibleForAiStep(tx, game, humanId, phase);
  const aiRemaining = await countEligibleForAiStep(tx, game, AI_OPPONENT_ID, phase);
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
  const unit = await firstAiEligibleUnit(tx, game, phase);
  if (!unit) {
    const [row] = await tx.update(gamesTable).set({
      aiState: mergeAiState(game.aiState, aiState("idle", `${phase}.no-eligible-unit`, {
        message: `AI has no eligible ${phase} activations.`,
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
  const traits = parseShipTraits(filterLostTraits(model?.traits ?? "", crits.lostTraitNames));
  const speedCap = movementSpeedCap(unit, crits);
  const minMove = traits.superManeuverable ? 0 : speedCap > 0 ? Math.max(1, Math.ceil(effectiveBaseSpeed(unit, crits) / 2)) : 0;
  const enemies = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.ownerId, game.challengerId),
    eq(gameUnitsTable.isDestroyed, false),
  ));
  const nearest = (enemies as Array<typeof gameUnitsTable.$inferSelect>)
    .map((enemy: typeof gameUnitsTable.$inferSelect) => ({ enemy, distance: centerDistance({ x: unit.hexQ, z: unit.hexR }, { x: enemy.hexQ, z: enemy.hexR }) }))
    .sort((a: { distance: number }, b: { distance: number }) => a.distance - b.distance)[0]?.enemy ?? null;
  const targetPoint = nearest ? { x: nearest.hexQ, z: nearest.hexR } : {
    x: unit.hexQ + headingForwardVec(unit).x * Math.max(1, speedCap),
    z: unit.hexR + headingForwardVec(unit).z * Math.max(1, speedCap),
  };
  const newHeading = headingToPoint({ x: unit.hexQ, z: unit.hexR }, targetPoint);
  const headingRad = (newHeading * Math.PI) / 180;
  const movementDirection = { x: Math.sin(headingRad), z: Math.cos(headingRad) };
  const novaBroadsideBias = model ? isNovaDreadnought(model, unit) : false;
  const shipAiProfile = shipAiProfileForModel(model);
  const lowHealth = lowHullRatio(unit) < 0.3;
  const normalizeHeading = (heading: number) => ((Math.round(heading) % 360) + 360) % 360;
  const headingCandidates: AiMovementHeadingCandidate[] = [{ heading: normalizeHeading(newHeading), label: "approach" }];
  if (nearest && (shipAiProfile === "broadside" || novaBroadsideBias)) {
    headingCandidates.push(
      { heading: normalizeHeading(newHeading - 90), label: novaBroadsideBias ? "nova-port-broadside" : "profile-port-broadside" },
      { heading: normalizeHeading(newHeading + 90), label: novaBroadsideBias ? "nova-starboard-broadside" : "profile-starboard-broadside" },
    );
  }
  if (nearest && shipAiProfile === "brawler") {
    headingCandidates.push(
      { heading: normalizeHeading(newHeading - 30), label: "profile-close-port" },
      { heading: normalizeHeading(newHeading + 30), label: "profile-close-starboard" },
    );
  }
  if (nearest && shipAiProfile === "jouster") {
    headingCandidates.push(
      { heading: normalizeHeading(unit.heading), label: "profile-hold-line" },
      { heading: normalizeHeading(newHeading - 15), label: "profile-joust-port" },
      { heading: normalizeHeading(newHeading + 15), label: "profile-joust-starboard" },
    );
  }
  if (nearest && shipAiProfile === "standoff") {
    const escapeHeading = headingToPoint({ x: nearest.hexQ, z: nearest.hexR }, { x: unit.hexQ, z: unit.hexR });
    headingCandidates.push(
      { heading: normalizeHeading(escapeHeading), label: "profile-kite" },
      { heading: normalizeHeading(escapeHeading - 45), label: "profile-kite-port" },
      { heading: normalizeHeading(escapeHeading + 45), label: "profile-kite-starboard" },
      { heading: normalizeHeading(newHeading - 90), label: "profile-standoff-port" },
      { heading: normalizeHeading(newHeading + 90), label: "profile-standoff-starboard" },
    );
  }
  if (nearest && lowHealth) {
    const escapeHeading = headingToPoint({ x: nearest.hexQ, z: nearest.hexR }, { x: unit.hexQ, z: unit.hexR });
    headingCandidates.push(
      { heading: normalizeHeading(escapeHeading), label: "low-health-retreat" },
      { heading: normalizeHeading(escapeHeading - 45), label: "low-health-retreat-port" },
      { heading: normalizeHeading(escapeHeading + 45), label: "low-health-retreat-starboard" },
    );
  }
  const dedupedHeadingCandidates = Array.from(
    new Map(headingCandidates.map(candidate => [candidate.heading, candidate])).values(),
  );
  const availableDistance = nearest
    ? Math.max(0, centerDistance({ x: unit.hexQ, z: unit.hexR }, targetPoint) - rulesBaseRadius(unit) - rulesBaseRadius(nearest) - 1)
    : speedCap;
  const desiredDistance = Math.min(speedCap, Math.max(minMove, availableDistance));
  const requested = {
    x: Math.max(-24, Math.min(24, unit.hexQ + movementDirection.x * desiredDistance)),
    z: Math.max(-36, Math.min(36, unit.hexR + movementDirection.z * desiredDistance)),
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
  const legalEndpoint = findBestAiMovementEndpoint(
    { x: unit.hexQ, z: unit.hexR },
    speedCap,
    minMove,
    movingFootprint,
    blockerFootprints,
    nearestFootprint,
    dedupedHeadingCandidates,
    model ? await tx.select().from(weaponsTable).where(eq(weaponsTable.shipModelId, model.id)) : [],
    FLIP_MODELS.has(unit.modelFilename),
    enemyThreats,
    lowHealth,
    novaBroadsideBias,
    shipAiProfile,
  );
  const finalX = legalEndpoint?.x ?? snapBoardCoord(unit.hexQ);
  const finalZ = legalEndpoint?.z ?? snapBoardCoord(unit.hexR);
  const moved = legalEndpoint?.moved ?? 0;
  const finalHeading = legalEndpoint?.heading ?? newHeading;
  const movementDetails = {
    unit: { id: unit.id, name: unit.name, from: { x: unit.hexQ, z: unit.hexR }, heading: unit.heading },
    nearestEnemy: nearest ? { id: nearest.id, name: nearest.name, x: nearest.hexQ, z: nearest.hexR } : null,
    lowHealth,
    shipAiProfile,
    novaBroadsideBias,
    speedCap,
    minMove,
    availableDistance: Number(availableDistance.toFixed(3)),
    desiredDistance: Number(desiredDistance.toFixed(3)),
    requested: { x: Number(requested.x.toFixed(3)), z: Number(requested.z.toFixed(3)), heading: newHeading },
    headingCandidates: dedupedHeadingCandidates,
    finalEndpoint: {
      x: finalX,
      z: finalZ,
      moved,
      heading: finalHeading,
      headingLabel: legalEndpoint?.headingLabel ?? null,
      passOverAllowed: true,
      scoredAgainstTargetId: nearestFootprint?.id ?? null,
      incomingThreat: Number((legalEndpoint?.incomingThreat ?? 0).toFixed(2)),
      ownThreat: Number((legalEndpoint?.ownThreat ?? 0).toFixed(2)),
      sideArcThreat: Number((legalEndpoint?.sideArcThreat ?? 0).toFixed(2)),
      forwardArcThreat: Number((legalEndpoint?.forwardArcThreat ?? 0).toFixed(2)),
    },
  };

  if (!legalEndpoint || (minMove > 0 && moved + 1e-6 < minMove)) {
    const [stoppedUnit] = await tx.update(gameUnitsTable).set({
      specialAction: "all-stop",
      allStopReady: true,
      hasInitiatedMoveThisActivation: true,
      inchesMovedThisActivation: 0,
      distanceSinceLastTurnThisActivation: 0,
      turnsMadeThisActivation: 0,
    }).where(and(eq(gameUnitsTable.id, unit.id), eq(gameUnitsTable.gameId, game.id))).returning();
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
    distanceSinceLastTurnThisActivation: moved,
    turnsMadeThisActivation: 0,
    allStopReady: false,
  }).where(and(eq(gameUnitsTable.id, unit.id), eq(gameUnitsTable.gameId, game.id))).returning();

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
      const tPos = hexToWorld(target.hexQ, target.hexR);
      const distance = fighterWeaponRangeDistance({
        id: attacker.id,
        ownerId: attacker.ownerId,
        x: aPos.x,
        z: aPos.z,
        baseRadiusInches: rulesBaseRadius(attacker),
        isFighter: shipModelIsFighter(attackerModel),
      }, tPos);
      if (distance > weapon.range) {
        rejected.push({ weaponId: weapon.id, weaponName: weapon.name, targetId: target.id, targetName: target.name, reason: `out-of-range-${distance.toFixed(1)}-gt-${weapon.range}` });
        continue;
      }
      if (!isInArc({ x: aPos.x, z: aPos.z, headingDeg: attacker.heading, flipped }, tPos, weapon.arc)) {
        rejected.push({ weaponId: weapon.id, weaponName: weapon.name, targetId: target.id, targetName: target.name, reason: `not-in-${weapon.arc}-arc` });
        continue;
      }
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
      const score =
        expectedDamage * 14 +
        expectedHits * 4 +
        woundedBonus +
        killBonus +
        novaSideArcBonus +
        profileArcBonus +
        brawlerRangeBonus +
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
  }, tPos);

  const rawAction = attacker.specialAction ?? "";
  const baseAction = rawAction.replace(/-failed$/, "");
  const weaponAd = effectiveAttackDice(weapon.attackDice, wt);
  const adAfterCrits = Math.max(1, weaponAd + attackerCrits.allWeaponsAdMod);
  const finalAttackDice = baseAction === "intensify-defense" ? Math.max(1, Math.floor(adAfterCrits / 2)) : adAfterCrits;
  const baseThreshold = (wt.beam || wt.miniBeam) ? 4 : targetModel.hullRating;
  const critFloor = attackerCrits.weaponsHitOn4 ? 4 : 0;
  const hitThreshold = Math.max(1, Math.max(baseThreshold, critFloor) - attackRollModifier(wt));

  let stealthPassed = true;
  if (targetTraits.stealth > 0 && !wt.energyMine) {
    const stealthTarget = stealthFloor(targetTraits.stealth, distance);
    const stealthRoll = rollD6();
    stealthPassed = stealthRoll >= stealthTarget || stealthRoll === 6;
  }
  const stealthFailWastedSlowLoading = !stealthPassed && (wt.slowLoading || wt.oneShot);

  let interceptorRemaining = targetCrippled ? 0 : Math.min(target.interceptorDiceRemaining, targetTraits.interceptors);
  let interceptorThreshold = target.interceptorThresholdCurrent;
  let attackDiceAfterInterceptors = finalAttackDice;
  const interceptorsBypassed = wt.beam || wt.miniBeam || wt.massDriver || wt.energyMine;
  if (stealthPassed && !interceptorsBypassed && interceptorRemaining > 0) {
    const diceToAttempt = attackDiceAfterInterceptors;
    for (let ad = 0; ad < diceToAttempt; ad++) {
      if (interceptorRemaining <= 0 || attackDiceAfterInterceptors <= 0) break;
      let anySuccess = false;
      let onesRolled = 0;
      for (let i = 0; i < interceptorRemaining; i++) {
        const d = rollD6();
        if (d >= interceptorThreshold) anySuccess = true;
        if (d === 1) onesRolled++;
      }
      if (anySuccess) attackDiceAfterInterceptors--;
      interceptorRemaining = Math.max(0, interceptorRemaining - onesRolled);
      if (interceptorRemaining > 0) {
        interceptorThreshold = Math.min(6, interceptorThreshold + onesRolled);
        if (interceptorRemaining === 1) interceptorThreshold = 6;
      }
    }
  }

  let hits = 0;
  const EXPLODE_CAP_PER_DIE = 100;
  for (let i = 0; stealthPassed && i < attackDiceAfterInterceptors; i++) {
    let roll = rollD6();
    let hit = roll >= hitThreshold;
    if (!hit && wt.twinLinked) {
      roll = rollD6();
      hit = roll >= hitThreshold;
    }
    if (hit) hits++;
    if (wt.beam) {
      let chain = 0;
      while (roll >= hitThreshold && chain < EXPLODE_CAP_PER_DIE) {
        roll = rollD6();
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
  if (targetTraits.dodge > 0 && !wt.accurate && !wt.energyMine && targetCanManeuver) {
    let dodges = 0;
    for (let i = 0; i < remainingHits; i++) {
      if (rollD6() >= targetTraits.dodge) dodges++;
    }
    remainingHits = Math.max(0, remainingHits - dodges);
  }

  const { mult, bulkheadFloor } = damageMultiplier(wt);
  let shieldsCurrent = targetCrippled ? 0 : target.shieldsCurrent;
  let shieldedHits = 0;
  if (!wt.massDriver && !wt.energyMine && shieldsCurrent > 0 && remainingHits > 0) {
    while (remainingHits > 0 && shieldsCurrent >= mult) {
      shieldsCurrent -= mult;
      shieldedHits++;
      remainingHits--;
    }
    if (remainingHits > 0 && shieldsCurrent > 0) shieldsCurrent = 0;
  }

  let totalDamage = 0;
  let totalCrewLost = 0;
  for (let i = 0; i < remainingHits; i++) {
    const tableRoll = Math.min(6, rollD6() + (wt.precise ? 1 : 0));
    if (tableRoll === 1) {
      totalDamage += bulkheadFloor;
    } else {
      totalDamage += mult;
      totalCrewLost += mult;
    }
  }

  const gegReduction = wt.massDriver ? 0 : targetTraits.geg * remainingHits;
  let damageAfterGeg = Math.max(0, totalDamage - gegReduction);
  let crewAfterGeg = Math.max(0, totalCrewLost - gegReduction);
  if (targetTraits.adaptiveArmour && (damageAfterGeg > 0 || crewAfterGeg > 0)) {
    damageAfterGeg = damageAfterGeg > 0 ? Math.max(1, Math.floor(damageAfterGeg / 2)) : 0;
    crewAfterGeg = crewAfterGeg > 0 ? Math.max(1, Math.floor(crewAfterGeg / 2)) : 0;
  }
  if (target.specialAction === "blast-doors") {
    let damageSaved = 0;
    let crewSaved = 0;
    for (let i = 0; i < damageAfterGeg; i++) if (rollD6() >= 5) damageSaved++;
    for (let i = 0; i < crewAfterGeg; i++) if (rollD6() >= 5) crewSaved++;
    damageAfterGeg = Math.max(0, damageAfterGeg - damageSaved);
    crewAfterGeg = Math.max(0, crewAfterGeg - crewSaved);
  }

  const finalDamage = damageAfterGeg;
  const targetHasCrewTrack = target.maxCrewPoints > 0;
  const finalCrewLost = targetHasCrewTrack ? crewAfterGeg : 0;
  const targetHullAfter = Math.max(0, target.hullPoints - finalDamage);
  const targetCrewAfter = targetHasCrewTrack
    ? Math.max(0, target.crewPoints - finalCrewLost)
    : target.crewPoints;
  let nextDamageState = target.damageState;
  let targetDestroyed = target.isDestroyed;
  if (targetHullAfter === 0 && target.damageState === "normal" && !target.isDestroyed) {
    const overkill = Math.max(0, finalDamage - target.hullPoints);
    const total = rollD6() + overkill;
    if (total <= 6) nextDamageState = "adrift";
    else if (total <= 11) {
      nextDamageState = "destroyed";
      targetDestroyed = true;
    } else {
      nextDamageState = "exploding-end-of-next";
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
    if (u.isDestroyed) continue;
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

  return {
    target: updatedTarget,
    hits,
    remainingHits,
    finalDamage,
    finalCrewLost,
    shieldedHits,
    targetDestroyed,
    winnerId,
    gameCompleted,
  };
}

async function finishActiveAiFiringWithoutShot(tx: any, game: typeof gamesTable.$inferSelect): Promise<typeof gamesTable.$inferSelect> {
  if (!game.activeUnitId) return activateAiUnitForPhase(tx, game, "firing");
  const [unit] = await tx.select().from(gameUnitsTable).where(and(
    eq(gameUnitsTable.id, game.activeUnitId),
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.ownerId, AI_OPPONENT_ID),
  ));
  if (!unit) throw new Error("AI active firing unit not found");
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
    await tx.update(gameUnitsTable)
      .set({
        hexQ: Math.round(u.hexQ + forward.x * driftDistance),
        hexR: Math.round(u.hexR + forward.z * driftDistance),
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
      ));
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

  await tx.update(gameUnitsTable).set({
    damageState: "destroyed",
    isDestroyed: true,
  }).where(and(
    eq(gameUnitsTable.gameId, game.id),
    eq(gameUnitsTable.damageState, "exploding-end-of-next"),
  ));

  await autoRepairRedundantSystemCriticals(tx, game.id);

  const gameUpdate = aiStatePatch
    ? { aiState: mergeAiState(game.aiState, aiStatePatch) }
    : {};

  const postExplosion = await tx.select().from(gameUnitsTable)
    .where(eq(gameUnitsTable.gameId, game.id));
  let cAlive = 0, oAlive = 0;
  for (const u of postExplosion) {
    if (u.isDestroyed) continue;
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

  if (!game.endPhaseChallengerPassed) {
    const [row] = await tx.update(gamesTable).set({
      endPhaseOpponentPassed: true,
      activePlayerId: game.challengerId,
      activeUnitId: null,
      aiState: mergeAiState(game.aiState, aiState("acted", "end.pass", {
        message: "AI passed the End Phase; waiting for the human commander.",
      })),
    }).where(eq(gamesTable.id, game.id)).returning();
    return row;
  }

  return rollOverRoundAfterEndPhase(tx, game, aiState("acted", "end.pass-and-rollover", {
    message: "AI passed the End Phase and advanced the game to the next round.",
  }));
}

const router: IRouter = Router();

function isDevBuiltinCommander(userId: string): boolean {
  return process.env.NODE_ENV !== "production" && (userId === "test-user-1" || userId === "test-user-2");
}

function isDevAiCommander(game: typeof gamesTable.$inferSelect, userId: string): boolean {
  return isDevBuiltinCommander(userId) && game.opponentKind === "ai" && game.opponentId === AI_OPPONENT_ID && userId !== game.challengerId;
}

function effectiveGameUserId(game: typeof gamesTable.$inferSelect, userId: string): string {
  return isDevAiCommander(game, userId) ? AI_OPPONENT_ID : userId;
}

function shouldAutoDeployAiOpponentOnCreate(): boolean {
  return process.env.NODE_ENV === "production";
}

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

  const [game] = await db.insert(gamesTable).values({
    challengerId: userId,
    opponentId: opponentKind === "ai" ? AI_OPPONENT_ID : null,
    opponentKind,
    challengerName: challenger?.username ?? null,
    opponentName: opponentKind === "ai" ? AI_OPPONENT_NAME : null,
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
            : "AI opponent game created; deployment is waiting for the dev AI-side commander.",
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
    return {
      ...u,
      // Centralized adrift overlay — see `effectiveDamageState` for the
      // why. Used here AND by every mutation route that echoes a unit row,
      // so all consumers see the same canonical state.
      damageState: effectiveDamageState(u.damageState, rows),
      criticals: rows,
      // Slice C derived flags — surfaced to the client so badges can render
      // without re-deriving the rule.
      isCrippled: isCrippledUnit(u),
      isSkeletonCrew: isSkeletonCrewUnit(u),
    };
  });
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

// Surrender: a player concedes an active (or still-deploying) game. Per the
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
      if (game.status !== "active" && game.status !== "deploying") {
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
// entirely). Unlike /surrender — which is gated on "all my ships are
// combat-inert" as a forfeit-the-corpse escape hatch — concession is
// available at any time during 'deploying' or 'active' so a player can bow
// out early. The game ends with status='completed' and winnerId set to the
// OTHER player, and shows up in Recent Engagements as a normal loss/win.
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
      if (game.status !== "active" && game.status !== "deploying") {
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
      const scenarioPriority = normalizePriorityLevel(game.priorityLevel);
      const allocation = calculateAllocation(
        placedShips.map(ship => normalizePriorityLevel(placedModelByShipId.get(ship.id)?.priorityLevel)),
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

      for (const placement of parsed.data.placements) {
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
        await tx.insert(gameUnitsTable).values({
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
          isDestroyed: false,
        });
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
  {
    const baseAction = (unit.specialAction ?? "").replace(/-failed$/, "");
    if (baseAction === "all-stop" && body.data.newHeading !== unit.heading) {
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
  const moveTraits = parseShipTraits(filterLostTraits(moveModel.traits, moveCrits.lostTraitNames));
  const currentSpeedCap = movementSpeedCap(unit, moveCrits);
  const turnProfile = effectiveTurnProfile(unit, moveTraits);
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
  const requestedStepDq = body.data.toHexQ - unit.hexQ;
  const requestedStepDr = body.data.toHexR - unit.hexR;
  const requestedStepInches = snapHalfInch(Math.hypot(requestedStepDq, requestedStepDr));
  const headingDelta = headingDeltaDegrees(unit.heading, body.data.newHeading);
  const isTurn = headingDelta > 0;
  if (requestedStepInches <= 0 && !isTurn) {
    res.status(400).json({ error: "Move did not change position" });
    return;
  }

  if (unit.inchesMovedThisActivation + requestedStepInches > currentSpeedCap) {
    res.status(400).json({
      error: `Ship may move at most ${currentSpeedCap}" this activation (would move ${unit.inchesMovedThisActivation + requestedStepInches}")`,
    });
    return;
  }
  if (isTurn) {
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
    if (headingDelta > turnProfile.turnAngle + 1e-6) {
      res.status(400).json({ error: `Ship may turn at most ${turnProfile.turnAngle} degrees at once` });
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
    isFighter: shipModelIsFighter(moveModel),
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
  const finalHexQ = snapBoardCoord(body.data.toHexQ);
  const finalHexR = snapBoardCoord(body.data.toHexR);
  const finalFootprint: UnitFootprint = {
    ...candidateFootprint,
    x: finalHexQ,
    z: finalHexR,
  };
  if (findIllegalBaseOverlap(finalFootprint, otherFootprints)) {
    res.status(400).json({ error: "Move would overlap another base illegally" });
    return;
  }
  const actualStepInches = snapHalfInch(Math.hypot(finalHexQ - unit.hexQ, finalHexR - unit.hexR));

  const nextDistanceSinceLastTurn = isTurn
    ? 0
    : unit.distanceSinceLastTurnThisActivation + actualStepInches;
  const [updated] = await db.update(gameUnitsTable)
    .set({
      hexQ: finalHexQ,
      hexR: finalHexR,
      heading: body.data.newHeading,
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

  res.json({ ...updated, damageState: effectiveDamageState(updated.damageState, moveCritRows) });
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
      const eligibleRows = async (): Promise<Array<typeof gameUnitsTable.$inferSelect>> => {
        const rows = await tx.select().from(gameUnitsTable).where(and(
          eq(gameUnitsTable.gameId, game.id),
          eq(gameUnitsTable.ownerId, userId),
          eq(gameUnitsTable.isDestroyed, false),
          eq(game.phase === "firing" ? gameUnitsTable.hasFiredThisRound : gameUnitsTable.hasMovedThisRound, false),
        ));
        const eligible: Array<typeof gameUnitsTable.$inferSelect> = [];
        for (const row of rows) {
          if (game.phase === "firing") {
            if (row.hullPoints <= 0) continue;
            if (row.maxCrewPoints > 0 && row.crewPoints <= 0) continue;
          } else {
            const critRows = await tx.select().from(unitCriticalEffectsTable)
              .where(eq(unitCriticalEffectsTable.gameUnitId, row.id));
            const state = effectiveDamageState(row.damageState, critRows);
            if (state === "adrift" || state === "exploding-end-of-next") continue;
          }
          eligible.push(row);
        }
        return eligible;
      };
      const activationSegment = async (): Promise<"capital" | "fighter" | null> => {
        const rows = await eligibleRows();
        let hasCapital = false;
        let hasFighter = false;
        for (const row of rows) {
          if (await isFighterUnit(row)) hasFighter = true;
          else hasCapital = true;
        }
        if (game.phase === "movement") {
          return hasCapital ? "capital" : hasFighter ? "fighter" : null;
        }
        return hasFighter ? "fighter" : hasCapital ? "capital" : null;
      };

      const segment = await activationSegment();
      const unitIsFighter = await isFighterUnit(unit);
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
        const critRows = await tx.select().from(unitCriticalEffectsTable)
          .where(eq(unitCriticalEffectsTable.gameUnitId, unitRow.id));
        const state = effectiveDamageState(unitRow.damageState, critRows);
        return state !== "adrift" && state !== "exploding-end-of-next";
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
                const endedTraits = parseShipTraits(filterLostTraits(endedModel?.traits ?? "", cap.lostTraitNames));
                const effectiveMax = effectiveBaseSpeed(endedUnit, cap);
                const minRequired = endedTraits.superManeuverable
                  ? 0
                  : effectiveMax > 0 ? Math.max(1, Math.ceil(effectiveMax / 2)) : 0;
                if (minRequired > 0 && endedUnit.inchesMovedThisActivation < minRequired) {
                  throw Object.assign(
                    new Error(
                      `Ship must move at least ${minRequired}" this activation or declare All Stop (moved ${endedUnit.inchesMovedThisActivation}")`,
                    ),
                    { status: 400 },
                  );
                }
              }
            }
          }
        }
        // Mark the just-ended activation as done for THIS phase only.
        await tx.update(gameUnitsTable)
          .set(isFiring ? { hasFiredThisRound: true } : { hasMovedThisRound: true })
          .where(and(eq(gameUnitsTable.id, endedUnitId), eq(gameUnitsTable.gameId, gameId)));
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
router.post("/games/:gameId/units/:unitId/fire-weapon", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const params = FireWeaponParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = FireWeaponBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const { gameId, unitId } = params.data;
  const { weaponId, targetUnitId, useScoutCoordination } = body.data;

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
      // Hull or crew exhausted → ineligible to fire even if activation was
      // somehow obtained (race with damage application from another shot).
      if (attacker.hullPoints <= 0) {
        throw Object.assign(new Error("Hull is gone — ship cannot fire"), { status: 400 });
      }
      if (attacker.maxCrewPoints > 0 && attacker.crewPoints <= 0) {
        throw Object.assign(new Error("No surviving crew — ship cannot fire"), { status: 400 });
      }
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
      // All Hands on Deck (cost): only 1 weapon system may fire this
      // round. Latched on successful declaration in /special-action;
      // cleared at round rollover.
      if (attacker.oneWeaponThisRound && alreadyFired.length >= 1) {
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

      // Weapon must belong to the attacker's ship class.
      const [attackerShip] = await tx.select().from(shipsTable).where(eq(shipsTable.id, attacker.shipId));
      if (!attackerShip) throw Object.assign(new Error("Attacker ship record missing"), { status: 500 });
      const [attackerModel] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, attackerShip.shipModelId));
      if (!attackerModel) throw Object.assign(new Error("Attacker ship model missing"), { status: 500 });
      const [weapon] = await tx.select().from(weaponsTable).where(eq(weaponsTable.id, weaponId));
      if (!weapon) throw Object.assign(new Error("Weapon not found"), { status: 404 });
      if (weapon.shipModelId !== attackerShip.shipModelId) {
        throw Object.assign(new Error("Selected weapon is not available on this ship. Refresh the page and choose one of the attacker's listed weapons."), { status: 400 });
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
      const attackerTraits = parseShipTraits(filterLostTraits(attackerModel.traits, attackerCrits.lostTraitNames));
      if (skeletonPenaltiesApply(attacker, attackerTraits) && alreadyFired.length >= 1) {
        throw Object.assign(new Error("Skeleton crew may fire only one weapon system this turn"), { status: 400 });
      }
      if (isCrippledUnit(attacker) && alreadyFired.length > 0) {
        const priorWeapons = await tx.select().from(weaponsTable).where(inArray(weaponsTable.id, alreadyFired));
        if (priorWeapons.some(w => w.arc === weapon.arc)) {
          throw Object.assign(new Error(`Crippled ships may fire only one weapon per arc; ${weapon.arc} has already fired`), { status: 400 });
        }
      }

      // Range check (world units = inches; the OpenAPI spec stores weapon.range
      // in inches and the board is laid out at 1 unit = 1 inch).
      const aPos = hexToWorld(attacker.hexQ, attacker.hexR);
      const tPos = hexToWorld(target.hexQ, target.hexR);
      const dist = fighterWeaponRangeDistance({
        id: attacker.id,
        ownerId: attacker.ownerId,
        x: aPos.x,
        z: aPos.z,
        baseRadiusInches: rulesBaseRadius(attacker),
        isFighter: shipModelIsFighter(attackerModel),
      }, tPos);
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

      // ── Trait parse ──────────────────────────────────────────────────────
      // Filter the target's ship traits by any crit-lost trait names so
      // Adaptive Armour / Stealth / Interceptors / etc. drop out when a
      // power-feedback/implosion/etc. crit nuked them.
      const wt = parseWeaponTraits(weapon.traits);
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
      const finalAttackDice = intensifyActive ? Math.max(1, Math.floor(adAfterCrits / 2)) : adAfterCrits;

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
      for (let i = 0; i < remainingHits; i++) {
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
            explosionVictims.push({
              unitId: v.id, hitsTaken, finalDamage: vDmg,
              finalCrewLost: vFinalCrewLost, hullAfter: vHullAfter, destroyed: vDestroyed,
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

      await tx.update(gameUnitsTable).set({
        hullPoints: targetHullAfter,
        crewPoints: targetCrewAfter,
        shieldsCurrent: persistedShieldsCurrent,
        // Persist the post-attack interceptor state so the next attack
        // this turn sees the burned dice / raised threshold.
        interceptorDiceRemaining: persistedInterceptorRemaining,
        interceptorThresholdCurrent: persistedInterceptorThreshold,
        damageState: nextDamageState,
        isDestroyed: targetDestroyed,
      }).where(eq(gameUnitsTable.id, target.id));

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
        await tx.update(gameUnitsTable)
          .set({
            firedWeaponIds: [...alreadyFired, weaponId],
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
      if (skeletonPenaltiesApply(unit, unitTraits)) {
        throw Object.assign(new Error("Skeleton crew cannot declare Special Actions"), { status: 400 });
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
      const isChallenger = userId === game.challengerId;
      const isOpponent = userId === game.opponentId;
      if (!isChallenger && !isOpponent) throw Object.assign(new Error("Not a participant"), { status: 403 });
      const alreadyRolled = isChallenger
        ? game.initiativeChallengerRoll !== null
        : game.initiativeOpponentRoll !== null;
      if (alreadyRolled) throw Object.assign(new Error("Already rolled this round"), { status: 400 });

      const myRoll = rollD6() + rollD6() + await initiativeModifierForPlayer(tx, game.id, userId);
      const cRoll = isChallenger ? myRoll : game.initiativeChallengerRoll;
      const oRoll = isOpponent ? myRoll : game.initiativeOpponentRoll;

      // Only one player has rolled so far — record and wait.
      if (cRoll === null || oRoll === null) {
        const [row] = await tx.update(gamesTable).set({
          initiativeChallengerRoll: cRoll,
          initiativeOpponentRoll: oRoll,
        }).where(eq(gamesTable.id, gameId)).returning();
        return row;
      }

      // Both rolled. Tie → clear both, re-roll.
      if (cRoll === oRoll) {
        const [row] = await tx.update(gamesTable).set({
          initiativeChallengerRoll: null,
          initiativeOpponentRoll: null,
        }).where(eq(gamesTable.id, gameId)).returning();
        return row;
      }

      // Winner determined. Record both rolls and the winner, but DO NOT
      // auto-transition to movement — the winner chooses who activates
      // first via POST /games/:id/choose-first-activator. activePlayerId
      // stays null until that choice is made so neither side can act yet.
      const winnerId = cRoll > oRoll ? game.challengerId : game.opponentId;
      const [row] = await tx.update(gamesTable).set({
        initiativeChallengerRoll: cRoll,
        initiativeOpponentRoll: oRoll,
        initiativeWinnerId: winnerId,
        activePlayerId: null,
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
      const [row] = await tx.update(gamesTable).set({
        phase: "movement",
        activePlayerId: activatorUserId,
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
        await tx.update(gameUnitsTable)
          .set({
            hexQ: Math.round(u.hexQ + forward.x * driftDistance),
            hexR: Math.round(u.hexR + forward.z * driftDistance),
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
          ));
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
      }).where(and(eq(gameUnitsTable.gameId, game.id), eq(gameUnitsTable.isDestroyed, false)));

      // 2. Resolve delayed catastrophic kills.
      await tx.update(gameUnitsTable).set({
        damageState: "destroyed",
        isDestroyed: true,
      }).where(and(
        eq(gameUnitsTable.gameId, game.id),
        eq(gameUnitsTable.damageState, "exploding-end-of-next"),
      ));

      await autoRepairRedundantSystemCriticals(tx, game.id);

      // 3. Re-evaluate win condition.
      const postExplosion = await tx.select().from(gameUnitsTable)
        .where(eq(gameUnitsTable.gameId, game.id));
      let cAlive = 0, oAlive = 0;
      for (const u of postExplosion) {
        if (u.isDestroyed) continue;
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
