import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  campaignBattlePriorityChoicesTable,
  campaignBattleShipAssignmentsTable,
  campaignBattlesTable,
  campaignInitiativeRollsTable,
  campaignLogEntriesTable,
  campaignPlayersTable,
  campaignResourceLedgerTable,
  campaignShipInstancesTable,
  campaignStrategicTargetsTable,
  campaignTargetOwnershipEventsTable,
  campaignTargetNominationsTable,
  campaignTurnPlayerStatesTable,
  campaignTurnsTable,
  campaignsTable,
  db,
  gameAttackAuditLogsTable,
  gameSpecialActionAuditLogsTable,
  gameUnitsTable,
  gamesTable,
  playersTable,
  pool,
  shipModelsTable,
  shipsTable,
  unitCriticalEffectsTable,
} from "@workspace/db";
import { requireAuth, getUserId } from "../lib/auth";
import { logger } from "../lib/logger";
import { createDeploymentConfig } from "../lib/deployment-zones";
import {
  generateTerrainSelectionConfig,
} from "../lib/terrain";
import {
  campaignRulesSnapshot,
  normalizeCampaignEngagementRules,
  type CampaignEngagementRules,
  type CampaignPriorityLevel,
  type CampaignScenarioKey,
} from "../lib/campaign-engagement";
import {
  campaignGeneratedEngagementRules,
  campaignScenarioFleetLimits,
  campaignShipWasUsedThisTurn,
  resolveCampaignScenario,
  rollCampaignPriority,
  shipModelHasTwoFlights,
  type CampaignPriorityRollResult,
  type CampaignScenarioRollResult,
} from "../lib/campaign-scenario";
import {
  generateCampaignSystem,
  rollStartingCrewQuality,
  validateCampaignStartingRoster,
} from "../lib/campaign-setup";
import {
  campaignChallengeOrder,
  campaignInitiativeTotal,
  resolveCampaignInitiative,
  rollCampaignInitiativeDice,
} from "../lib/campaign-turn";
import {
  PRIORITY_LEVELS,
  calculateAllocation,
  normalizePriorityLevel,
} from "../lib/fleet-allocation";
import {
  campaignCrewRepairCost,
  campaignCriticalRepairCost,
  campaignDestroyXpDice,
  campaignHullRepairCost,
  campaignPartialDamageXpDice,
  campaignReinforcementCost,
  campaignRrIncome,
  rollCampaignDice,
} from "../lib/campaign-resolution";
import { parseShipTraits } from "../lib/traits";
import { ensurePlayer } from "./players";

const router: IRouter = Router();

type CampaignRow = typeof campaignsTable.$inferSelect;
type CampaignPlayerRow = typeof campaignPlayersTable.$inferSelect;
type CampaignLogRow = typeof campaignLogEntriesTable.$inferSelect;
type ShipModelRow = typeof shipModelsTable.$inferSelect;
type CampaignBattleRow = typeof campaignBattlesTable.$inferSelect;
type CampaignBattlePriorityChoiceRow = typeof campaignBattlePriorityChoicesTable.$inferSelect;
type CampaignStrategicTargetRow = typeof campaignStrategicTargetsTable.$inferSelect;
type CampaignTurnRow = typeof campaignTurnsTable.$inferSelect;
type CampaignInitiativeRollRow = typeof campaignInitiativeRollsTable.$inferSelect;
type CampaignTargetNominationRow = typeof campaignTargetNominationsTable.$inferSelect;
type TacticalUnitRow = typeof gameUnitsTable.$inferSelect;
type UnitCriticalEffectRow = typeof unitCriticalEffectsTable.$inferSelect;
type CampaignRosterRow = typeof campaignShipInstancesTable.$inferSelect & {
  shipModel: ShipModelRow | null;
};
type CampaignVisibility = "private" | "public";
type CampaignVariant = "core" | "campaign-of-terror";

type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

// Stored in the legacy `faction` column for compatibility, but this value is
// a commander-facing fleet label and does not restrict campaign roster models.
function normalizeOptionalFleetLabel(value: unknown): ParseResult<string | null> {
  if (value === undefined || value === null || value === "") return { success: true, data: null };
  if (typeof value !== "string") return { success: false, error: "Fleet label must be text" };
  const fleetLabel = value.trim();
  if (!fleetLabel) return { success: true, data: null };
  if (fleetLabel.length < 2) return { success: false, error: "Fleet label must be at least 2 characters" };
  if (fleetLabel.length > 80) return { success: false, error: "Fleet label must be 80 characters or fewer" };
  return { success: true, data: fleetLabel };
}

function parseCreateCampaignBody(body: unknown): ParseResult<{
  name: string;
  faction: string | null;
  visibility: CampaignVisibility;
  variant: CampaignVariant;
}> {
  if (!body || typeof body !== "object") return { success: false, error: "Campaign body is required" };
  const raw = body as Record<string, unknown>;
  if (typeof raw.name !== "string") return { success: false, error: "Campaign name is required" };
  const name = raw.name.trim();
  if (name.length < 3) return { success: false, error: "Campaign name must be at least 3 characters" };
  if (name.length > 80) return { success: false, error: "Campaign name must be 80 characters or fewer" };

  const faction = normalizeOptionalFleetLabel(raw.faction);
  if (!faction.success) return faction;

  const visibility = raw.visibility === "public" ? "public" : "private";
  const variant = raw.variant === "campaign-of-terror" ? "campaign-of-terror" : "core";
  return { success: true, data: { name, faction: faction.data, visibility, variant } };
}

function parseJoinCampaignBody(body: unknown): ParseResult<{ faction: string | null }> {
  const raw = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const faction = normalizeOptionalFleetLabel(raw.faction);
  if (!faction.success) return faction;
  return { success: true, data: { faction: faction.data } };
}

function parseCampaignRosterBody(body: unknown): ParseResult<{
  shipModelId: number;
  name: string | null;
}> {
  if (!body || typeof body !== "object") return { success: false, error: "Roster body is required" };
  const raw = body as Record<string, unknown>;
  const shipModelId = Number(raw.shipModelId);
  if (!Number.isInteger(shipModelId) || shipModelId <= 0) {
    return { success: false, error: "Valid ship model is required" };
  }
  if (raw.name === undefined || raw.name === null || raw.name === "") {
    return { success: true, data: { shipModelId, name: null } };
  }
  if (typeof raw.name !== "string") return { success: false, error: "Ship name must be text" };
  const name = raw.name.trim();
  if (name.length > 80) return { success: false, error: "Ship name must be 80 characters or fewer" };
  return { success: true, data: { shipModelId, name: name || null } };
}

function parseCampaignShipIdList(value: unknown, label: string): ParseResult<number[]> {
  if (!Array.isArray(value)) return { success: false, error: `${label} must be a list` };
  const ids = value.map(Number);
  if (ids.length < 1) return { success: false, error: `${label} must include at least one ship` };
  if (ids.length > 50) return { success: false, error: `${label} can include at most 50 ships` };
  const unique = Array.from(new Set(ids));
  if (unique.length !== ids.length) return { success: false, error: `${label} cannot contain duplicate ships` };
  if (unique.some((id) => !Number.isInteger(id) || id <= 0)) {
    return { success: false, error: `${label} contains an invalid ship id` };
  }
  return { success: true, data: unique };
}

function parseCampaignBattleBody(body: unknown): ParseResult<{
  attackerPlayerId: string;
  defenderPlayerId: string;
  attackerShipInstanceIds: number[];
  defenderShipInstanceIds: number[];
  name: string | null;
  rules: CampaignEngagementRules;
}> {
  if (!body || typeof body !== "object") return { success: false, error: "Battle body is required" };
  const raw = body as Record<string, unknown>;
  if (typeof raw.attackerPlayerId !== "string" || !raw.attackerPlayerId.trim()) {
    return { success: false, error: "Attacker commander is required" };
  }
  if (typeof raw.defenderPlayerId !== "string" || !raw.defenderPlayerId.trim()) {
    return { success: false, error: "Defender commander is required" };
  }
  const attackerPlayerId = raw.attackerPlayerId.trim();
  const defenderPlayerId = raw.defenderPlayerId.trim();
  if (attackerPlayerId === defenderPlayerId) {
    return { success: false, error: "Attacker and defender must be different commanders" };
  }
  const attackerShips = parseCampaignShipIdList(raw.attackerShipInstanceIds, "Attacker ships");
  if (!attackerShips.success) return { success: false, error: attackerShips.error };
  const defenderShips = parseCampaignShipIdList(raw.defenderShipInstanceIds, "Defender ships");
  if (!defenderShips.success) return { success: false, error: defenderShips.error };

  const name = typeof raw.name === "string" && raw.name.trim()
    ? raw.name.trim().slice(0, 80)
    : null;
  const rules = normalizeCampaignEngagementRules(raw);
  if (!rules.success) return rules;
  return {
    success: true,
    data: {
      attackerPlayerId,
      defenderPlayerId,
      attackerShipInstanceIds: attackerShips.data,
      defenderShipInstanceIds: defenderShips.data,
      name,
      rules: rules.data,
    },
  };
}

function parseCampaignId(raw: unknown): ParseResult<number> {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return { success: false, error: "Invalid campaign id" };
  return { success: true, data: id };
}

function parseBattleId(raw: unknown): ParseResult<number> {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return { success: false, error: "Invalid campaign battle id" };
  return { success: true, data: id };
}

function parseShipInstanceId(raw: unknown): ParseResult<number> {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return { success: false, error: "Invalid campaign ship id" };
  return { success: true, data: id };
}

function parseReadyBody(body: unknown): ParseResult<{ ready: boolean }> {
  if (!body || typeof body !== "object") return { success: false, error: "Ready state is required" };
  const ready = (body as Record<string, unknown>).ready;
  if (typeof ready !== "boolean") return { success: false, error: "Ready state must be true or false" };
  return { success: true, data: { ready } };
}

function parseInitiativeModifierBody(body: unknown): ParseResult<{ initiativeModifier: number }> {
  if (!body || typeof body !== "object") {
    return { success: false, error: "Fleet Initiative modifier is required" };
  }
  const initiativeModifier = Number((body as Record<string, unknown>).initiativeModifier);
  if (!Number.isInteger(initiativeModifier) || initiativeModifier < -5 || initiativeModifier > 5) {
    return { success: false, error: "Fleet Initiative modifier must be a whole number from -5 to 5" };
  }
  return { success: true, data: { initiativeModifier } };
}

function parseTargetNominationBody(body: unknown): ParseResult<{ targetId: number }> {
  if (!body || typeof body !== "object") return { success: false, error: "Strategic Target is required" };
  const targetId = Number((body as Record<string, unknown>).targetId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return { success: false, error: "Choose a valid Strategic Target" };
  }
  return { success: true, data: { targetId } };
}

function parseTargetChallengeBody(body: unknown): ParseResult<{ challenge: boolean }> {
  if (!body || typeof body !== "object") return { success: false, error: "Challenge response is required" };
  const challenge = (body as Record<string, unknown>).challenge;
  if (typeof challenge !== "boolean") {
    return { success: false, error: "Challenge response must be true or false" };
  }
  return { success: true, data: { challenge } };
}

function parsePriorityModifierBody(body: unknown): ParseResult<{ modifier: number }> {
  if (!body || typeof body !== "object") {
    return { success: false, error: "Priority modifier is required" };
  }
  const modifier = Number((body as Record<string, unknown>).modifier);
  if (!Number.isInteger(modifier) || modifier < -3 || modifier > 3) {
    return { success: false, error: "Priority modifier must be a whole number from -3 to 3" };
  }
  return { success: true, data: { modifier } };
}

function parseScenarioChoiceBody(body: unknown): ParseResult<{
  scenarioKey: "supply-ships" | "planetary-assault";
}> {
  if (!body || typeof body !== "object") {
    return { success: false, error: "Scenario choice is required" };
  }
  const scenarioKey = (body as Record<string, unknown>).scenarioKey;
  if (scenarioKey !== "supply-ships" && scenarioKey !== "planetary-assault") {
    return { success: false, error: "Choose Supply Ships or Planetary Assault" };
  }
  return { success: true, data: { scenarioKey } };
}

function parseFleetAssignmentBody(body: unknown): ParseResult<{ shipInstanceIds: number[] }> {
  if (!body || typeof body !== "object") {
    return { success: false, error: "Fleet assignment is required" };
  }
  const ships = parseCampaignShipIdList(
    (body as Record<string, unknown>).shipInstanceIds,
    "Campaign fleet",
  );
  if (!ships.success) return ships;
  return { success: true, data: { shipInstanceIds: ships.data } };
}

function parseNominationId(raw: unknown): ParseResult<number> {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return { success: false, error: "Invalid target nomination id" };
  return { success: true, data: id };
}

function parseCrewQualitySwapBody(body: unknown): ParseResult<{
  firstShipInstanceId: number;
  secondShipInstanceId: number;
}> {
  if (!body || typeof body !== "object") return { success: false, error: "Two campaign ships are required" };
  const raw = body as Record<string, unknown>;
  const firstShipInstanceId = Number(raw.firstShipInstanceId);
  const secondShipInstanceId = Number(raw.secondShipInstanceId);
  if (!Number.isInteger(firstShipInstanceId) || firstShipInstanceId <= 0
    || !Number.isInteger(secondShipInstanceId) || secondShipInstanceId <= 0) {
    return { success: false, error: "Choose two valid campaign ships" };
  }
  if (firstShipInstanceId === secondShipInstanceId) {
    return { success: false, error: "Choose two different campaign ships" };
  }
  return { success: true, data: { firstShipInstanceId, secondShipInstanceId } };
}

function parseResolutionShipBody(body: unknown): ParseResult<{ shipInstanceId: number }> {
  if (!body || typeof body !== "object") return { success: false, error: "Campaign ship is required" };
  const shipInstanceId = Number((body as Record<string, unknown>).shipInstanceId);
  if (!Number.isInteger(shipInstanceId) || shipInstanceId <= 0) {
    return { success: false, error: "Choose a valid campaign ship" };
  }
  return { success: true, data: { shipInstanceId } };
}

function parseExperienceRepairBody(body: unknown): ParseResult<{ shipInstanceId: number; dice: number }> {
  const ship = parseResolutionShipBody(body);
  if (!ship.success) return ship;
  const dice = Number((body as Record<string, unknown>).dice);
  if (!Number.isInteger(dice) || dice < 1 || dice > 50) {
    return { success: false, error: "XP repair dice must be a whole number from 1 to 50" };
  }
  return { success: true, data: { ...ship.data, dice } };
}

function parseCriticalRepairBody(body: unknown): ParseResult<{ shipInstanceId: number; criticalIndex: number }> {
  const ship = parseResolutionShipBody(body);
  if (!ship.success) return ship;
  const criticalIndex = Number((body as Record<string, unknown>).criticalIndex);
  if (!Number.isInteger(criticalIndex) || criticalIndex < 0) {
    return { success: false, error: "Choose a valid critical effect" };
  }
  return { success: true, data: { ...ship.data, criticalIndex } };
}

function parseRecruitBody(body: unknown): ParseResult<{ shipInstanceId: number; track: "crew" | "troops" }> {
  const ship = parseResolutionShipBody(body);
  if (!ship.success) return ship;
  const track = (body as Record<string, unknown>).track;
  if (track !== "crew" && track !== "troops") {
    return { success: false, error: "Choose crew or troops" };
  }
  return { success: true, data: { ...ship.data, track } };
}

function parseReinforcementBody(body: unknown): ParseResult<{ shipModelId: number; name: string | null }> {
  return parseCampaignRosterBody(body);
}

let campaignSchemaPromise: Promise<void> | null = null;

function ensureCampaignSchema(): Promise<void> {
  campaignSchemaPromise ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id SERIAL PRIMARY KEY,
        owner_player_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'setup',
        ruleset TEXT NOT NULL DEFAULT 'acta-2e',
        variant TEXT NOT NULL DEFAULT 'core',
        visibility TEXT NOT NULL DEFAULT 'private',
        current_turn INTEGER NOT NULL DEFAULT 0,
        phase TEXT NOT NULL DEFAULT 'setup',
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_players (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        display_name TEXT,
        faction TEXT,
        role TEXT NOT NULL DEFAULT 'member',
        status TEXT NOT NULL DEFAULT 'active',
        ready BOOLEAN NOT NULL DEFAULT FALSE,
        crew_quality_swap_used BOOLEAN NOT NULL DEFAULT FALSE,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS campaign_players_campaign_player_idx
      ON campaign_players (campaign_id, player_id)
    `);
    await pool.query(`ALTER TABLE campaign_players ADD COLUMN IF NOT EXISTS crew_quality_swap_used BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE campaign_players ADD COLUMN IF NOT EXISTS initiative_modifier INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_log_entries (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        turn_number INTEGER NOT NULL DEFAULT 0,
        actor_player_id TEXT,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS campaign_log_entries_campaign_created_idx
      ON campaign_log_entries (campaign_id, created_at DESC, id DESC)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_turns (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        turn_number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'planning',
        initiative_order JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS campaign_turns_campaign_turn_idx
      ON campaign_turns (campaign_id, turn_number)
    `);
    await pool.query(`ALTER TABLE campaign_turns ADD COLUMN IF NOT EXISTS target_selection_index INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_initiative_rolls (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        campaign_turn_id INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        dice JSONB NOT NULL DEFAULT '[]'::jsonb,
        fleet_modifier INTEGER NOT NULL DEFAULT 0,
        target_penalty INTEGER NOT NULL DEFAULT 0,
        initial_total INTEGER NOT NULL,
        final_total INTEGER NOT NULL,
        rerolls JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS campaign_initiative_rolls_turn_player_idx
      ON campaign_initiative_rolls (campaign_turn_id, player_id)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_target_nominations (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        campaign_turn_id INTEGER NOT NULL,
        turn_number INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        nominator_player_id TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        target_owner_player_id TEXT,
        defender_player_id TEXT,
        challenger_player_id TEXT,
        challenge_order JSONB NOT NULL DEFAULT '[]'::jsonb,
        challenge_index INTEGER NOT NULL DEFAULT 0,
        declined_player_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        status TEXT NOT NULL DEFAULT 'awaiting-challenge',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS campaign_target_nominations_turn_target_idx
      ON campaign_target_nominations (campaign_turn_id, target_id)
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS campaign_target_nominations_turn_nominator_idx
      ON campaign_target_nominations (campaign_turn_id, nominator_player_id)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_strategic_targets (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        key TEXT NOT NULL,
        category TEXT NOT NULL,
        subtype TEXT NOT NULL,
        name TEXT NOT NULL,
        owner_player_id TEXT,
        rr_value INTEGER NOT NULL DEFAULT 0,
        rr_formula TEXT,
        explored BOOLEAN NOT NULL DEFAULT TRUE,
        is_trade_route BOOLEAN NOT NULL DEFAULT FALSE,
        category_roll INTEGER,
        subtype_roll INTEGER,
        unusual_features JSONB NOT NULL DEFAULT '[]'::jsonb,
        rules_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS campaign_strategic_targets_campaign_sequence_idx
      ON campaign_strategic_targets (campaign_id, sequence)
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS campaign_strategic_targets_campaign_key_idx
      ON campaign_strategic_targets (campaign_id, key)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_battles (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        campaign_turn_id INTEGER,
        nomination_id INTEGER,
        turn_number INTEGER NOT NULL DEFAULT 0,
        target_id INTEGER,
        attacker_player_id TEXT NOT NULL,
        defender_player_id TEXT NOT NULL,
        tactical_game_id INTEGER,
        name TEXT,
        scenario_key TEXT NOT NULL DEFAULT 'campaign-linked-battle',
        priority_level TEXT NOT NULL DEFAULT 'raid',
        rules_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'deployment',
        result_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS campaign_battles_campaign_status_idx
      ON campaign_battles (campaign_id, status, id DESC)
    `);
    await pool.query(`ALTER TABLE campaign_battles ADD COLUMN IF NOT EXISTS rules_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await pool.query(`ALTER TABLE campaign_battles ADD COLUMN IF NOT EXISTS nomination_id INTEGER`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS campaign_battles_nomination_idx
      ON campaign_battles (nomination_id)
      WHERE nomination_id IS NOT NULL
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_battle_priority_choices (
        id SERIAL PRIMARY KEY,
        campaign_battle_id INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        modifier INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS campaign_battle_priority_choices_battle_player_idx
      ON campaign_battle_priority_choices (campaign_battle_id, player_id)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_battle_ship_assignments (
        id SERIAL PRIMARY KEY,
        campaign_battle_id INTEGER NOT NULL,
        campaign_ship_instance_id INTEGER NOT NULL,
        tactical_ship_id INTEGER,
        tactical_game_unit_id INTEGER,
        side TEXT NOT NULL,
        pre_battle_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        post_battle_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS campaign_battle_ship_assignments_battle_idx
      ON campaign_battle_ship_assignments (campaign_battle_id, side, campaign_ship_instance_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS campaign_battle_ship_assignments_ship_idx
      ON campaign_battle_ship_assignments (campaign_ship_instance_id)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_ship_instances (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        owner_player_id TEXT NOT NULL,
        source_ship_model_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        hull_current INTEGER NOT NULL,
        hull_max INTEGER NOT NULL,
        crew_current INTEGER NOT NULL DEFAULT 0,
        crew_max INTEGER NOT NULL DEFAULT 0,
        troops_current INTEGER NOT NULL DEFAULT 0,
        troops_max INTEGER NOT NULL DEFAULT 0,
        crew_quality INTEGER NOT NULL DEFAULT 4,
        crew_quality_roll INTEGER,
        crew_quality_dice JSONB NOT NULL DEFAULT '[]'::jsonb,
        xp_dice INTEGER NOT NULL DEFAULT 0,
        refits JSONB NOT NULL DEFAULT '[]'::jsonb,
        duties JSONB NOT NULL DEFAULT '[]'::jsonb,
        carried_fighters JSONB NOT NULL DEFAULT '[]'::jsonb,
        critical_effects JSONB NOT NULL DEFAULT '[]'::jsonb,
        unavailable_until_turn INTEGER NOT NULL DEFAULT 0,
        used_turn INTEGER NOT NULL DEFAULT 0,
        destroyed BOOLEAN NOT NULL DEFAULT FALSE,
        captured_by_player_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS campaign_ship_instances_campaign_owner_idx
      ON campaign_ship_instances (campaign_id, owner_player_id, status, id)
    `);
    await pool.query(`ALTER TABLE campaign_ship_instances ADD COLUMN IF NOT EXISTS crew_quality_roll INTEGER`);
    await pool.query(`ALTER TABLE campaign_ship_instances ADD COLUMN IF NOT EXISTS crew_quality_dice JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await pool.query(`ALTER TABLE campaign_ship_instances ADD COLUMN IF NOT EXISTS crew_quality_attempted_turn INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE campaign_ship_instances ADD COLUMN IF NOT EXISTS crippled_repair_paid_turn INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_turn_player_states (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        campaign_turn_id INTEGER NOT NULL,
        turn_number INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        experience_complete BOOLEAN NOT NULL DEFAULT FALSE,
        rr_income_generated BOOLEAN NOT NULL DEFAULT FALSE,
        repairs_complete BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS campaign_turn_player_states_turn_player_idx
      ON campaign_turn_player_states (campaign_turn_id, player_id)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_resource_ledger (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        campaign_turn_id INTEGER,
        turn_number INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        campaign_ship_instance_id INTEGER,
        resource TEXT NOT NULL,
        amount INTEGER NOT NULL,
        event_key TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS campaign_resource_ledger_event_idx
      ON campaign_resource_ledger (event_key)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS campaign_resource_ledger_campaign_player_idx
      ON campaign_resource_ledger (campaign_id, player_id, resource, id)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_target_ownership_events (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        campaign_turn_id INTEGER NOT NULL,
        turn_number INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        previous_owner_player_id TEXT,
        new_owner_player_id TEXT,
        campaign_battle_id INTEGER,
        nomination_id INTEGER,
        event_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS campaign_target_ownership_events_event_idx
      ON campaign_target_ownership_events (event_key)
    `);
    await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS campaign_id INTEGER`);
    await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS campaign_turn_id INTEGER`);
    await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS campaign_battle_id INTEGER`);
    await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS campaign_target_id INTEGER`);
    await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS campaign_scenario_key TEXT`);
    await pool.query(`ALTER TABLE game_units ADD COLUMN IF NOT EXISTS campaign_ship_instance_id INTEGER`);
    await pool.query(`ALTER TABLE game_units ADD COLUMN IF NOT EXISTS campaign_pre_battle_snapshot JSONB`);
  })().catch((err) => {
    campaignSchemaPromise = null;
    logger.error({ err }, "Failed to ensure campaign schema");
    throw err;
  });
  return campaignSchemaPromise;
}

async function currentPlayerName(userId: string): Promise<string | null> {
  await ensurePlayer(userId);
  const [player] = await db
    .select({ username: playersTable.username })
    .from(playersTable)
    .where(eq(playersTable.clerkUserId, userId));
  return player?.username ?? null;
}

async function campaignPlayers(campaignId: number): Promise<CampaignPlayerRow[]> {
  return db
    .select()
    .from(campaignPlayersTable)
    .where(eq(campaignPlayersTable.campaignId, campaignId));
}

async function recentCampaignLog(campaignId: number, limit = 8): Promise<CampaignLogRow[]> {
  const entries = await db
    .select()
    .from(campaignLogEntriesTable)
    .where(eq(campaignLogEntriesTable.campaignId, campaignId))
    .orderBy(desc(campaignLogEntriesTable.createdAt), desc(campaignLogEntriesTable.id))
    .limit(limit);
  return entries.reverse();
}

async function campaignRoster(campaignId: number): Promise<CampaignRosterRow[]> {
  const roster = await db
    .select()
    .from(campaignShipInstancesTable)
    .where(eq(campaignShipInstancesTable.campaignId, campaignId))
    .orderBy(asc(campaignShipInstancesTable.ownerPlayerId), asc(campaignShipInstancesTable.id));
  const modelIds = Array.from(new Set(roster.map((ship) => ship.sourceShipModelId)));
  const models = modelIds.length > 0
    ? await db
        .select()
        .from(shipModelsTable)
        .where(inArray(shipModelsTable.id, modelIds))
    : [];
  const modelById = new Map(models.map((model) => [model.id, model]));
  return roster.map((ship) => ({
    ...ship,
    shipModel: modelById.get(ship.sourceShipModelId) ?? null,
  }));
}

async function campaignStrategicTargets(campaignId: number): Promise<CampaignStrategicTargetRow[]> {
  return db
    .select()
    .from(campaignStrategicTargetsTable)
    .where(eq(campaignStrategicTargetsTable.campaignId, campaignId))
    .orderBy(asc(campaignStrategicTargetsTable.sequence));
}

async function campaignCurrentTurnState(campaign: CampaignRow) {
  if (campaign.currentTurn < 1) return null;
  const [turn] = await db
    .select()
    .from(campaignTurnsTable)
    .where(and(
      eq(campaignTurnsTable.campaignId, campaign.id),
      eq(campaignTurnsTable.turnNumber, campaign.currentTurn),
    ))
    .limit(1);
  if (!turn) return null;
  const initiativeRolls = await db
    .select()
    .from(campaignInitiativeRollsTable)
    .where(eq(campaignInitiativeRollsTable.campaignTurnId, turn.id))
    .orderBy(asc(campaignInitiativeRollsTable.id));
  const targetNominations = await db
    .select()
    .from(campaignTargetNominationsTable)
    .where(eq(campaignTargetNominationsTable.campaignTurnId, turn.id))
    .orderBy(asc(campaignTargetNominationsTable.sequence));
  return {
    turn,
    initiativeRolls,
    targetNominations: targetNominations.map((nomination) => ({
      ...nomination,
      currentChallengerPlayerId: nomination.status === "awaiting-challenge"
        ? nomination.challengeOrder[nomination.challengeIndex] ?? null
        : null,
    })),
  };
}

async function campaignResolutionState(campaign: CampaignRow, roster: CampaignRosterRow[]) {
  if (campaign.currentTurn < 1) return null;
  const [turn] = await db
    .select()
    .from(campaignTurnsTable)
    .where(and(
      eq(campaignTurnsTable.campaignId, campaign.id),
      eq(campaignTurnsTable.turnNumber, campaign.currentTurn),
    ))
    .limit(1);
  if (!turn) return null;
  const [playerStates, ledger, ownershipEvents] = await Promise.all([
    db.select().from(campaignTurnPlayerStatesTable)
      .where(eq(campaignTurnPlayerStatesTable.campaignTurnId, turn.id))
      .orderBy(asc(campaignTurnPlayerStatesTable.id)),
    db.select().from(campaignResourceLedgerTable)
      .where(eq(campaignResourceLedgerTable.campaignId, campaign.id))
      .orderBy(asc(campaignResourceLedgerTable.id)),
    db.select().from(campaignTargetOwnershipEventsTable)
      .where(eq(campaignTargetOwnershipEventsTable.campaignTurnId, turn.id))
      .orderBy(asc(campaignTargetOwnershipEventsTable.id)),
  ]);
  const rrBalances = new Map<string, number>();
  for (const entry of ledger) {
    if (entry.resource !== "rr") continue;
    rrBalances.set(entry.playerId, (rrBalances.get(entry.playerId) ?? 0) + entry.amount);
  }
  const factionsByPlayer = new Map<string, Set<string>>();
  for (const ship of roster) {
    const faction = ship.shipModel?.faction?.trim();
    if (!faction) continue;
    const factions = factionsByPlayer.get(ship.ownerPlayerId) ?? new Set<string>();
    factions.add(faction);
    factionsByPlayer.set(ship.ownerPlayerId, factions);
  }
  return {
    playerStates,
    ledger: ledger.filter((entry) => entry.turnNumber === campaign.currentTurn),
    ownershipEvents,
    rrBalances: Object.fromEntries(rrBalances),
    reinforcementFactions: Object.fromEntries(
      Array.from(factionsByPlayer, ([playerId, factions]) => [playerId, Array.from(factions).sort()]),
    ),
  };
}

function campaignSetupState(players: CampaignPlayerRow[], roster: CampaignRosterRow[]) {
  const activePlayers = players.filter((player) => player.status === "active");
  const playerStates = activePlayers.map((player) => {
    const playerRoster = roster.filter((ship) => ship.ownerPlayerId === player.playerId);
    const validation = validateCampaignStartingRoster(playerRoster.map((ship) => ({
      id: ship.id,
      priorityLevel: ship.shipModel?.priorityLevel,
      crewQualityRoll: ship.crewQualityRoll,
    })));
    const missingModels = playerRoster.filter((ship) => !ship.shipModel).map((ship) => ship.name);
    const issues = [...validation.issues];
    if (missingModels.length > 0) {
      issues.push(`Ship model data is unavailable for: ${missingModels.join(", ")}.`);
    }
    return {
      playerId: player.playerId,
      displayName: player.displayName,
      ready: player.ready,
      crewQualitySwapUsed: player.crewQualitySwapUsed,
      initiativeModifier: player.initiativeModifier,
      ...validation,
      legal: validation.legal && missingModels.length === 0,
      issues,
    };
  });
  const issues: string[] = [];
  if (activePlayers.length < 2) issues.push("At least two active commanders are required.");
  for (const player of playerStates) {
    if (!player.legal) issues.push(`${player.displayName ?? "Commander"} has an incomplete roster.`);
    if (!player.ready) issues.push(`${player.displayName ?? "Commander"} is not ready.`);
  }
  return {
    startingAllocationPoints: 10,
    startingPriorityLevel: "battle",
    minimumPlayers: 2,
    playerStates,
    canStart: issues.length === 0,
    issues,
  };
}

async function campaignBattles(
  campaignId: number,
  rosterRows?: CampaignRosterRow[],
  viewerPlayerId?: string,
) {
  const battles = await db
    .select()
    .from(campaignBattlesTable)
    .where(eq(campaignBattlesTable.campaignId, campaignId))
    .orderBy(desc(campaignBattlesTable.createdAt), desc(campaignBattlesTable.id))
    .limit(12);
  if (battles.length === 0) return [];
  const battleIds = battles.map((battle) => battle.id);
  const priorityChoices = await db
    .select()
    .from(campaignBattlePriorityChoicesTable)
    .where(inArray(campaignBattlePriorityChoicesTable.campaignBattleId, battleIds))
    .orderBy(asc(campaignBattlePriorityChoicesTable.id));
  const assignments = await db
    .select()
    .from(campaignBattleShipAssignmentsTable)
    .where(inArray(campaignBattleShipAssignmentsTable.campaignBattleId, battleIds))
    .orderBy(asc(campaignBattleShipAssignmentsTable.side), asc(campaignBattleShipAssignmentsTable.id));
  const tacticalGameIds = battles
    .map((battle) => battle.tacticalGameId)
    .filter((id): id is number => Number.isInteger(id));
  const tacticalGames = tacticalGameIds.length > 0
    ? await db
        .select()
        .from(gamesTable)
        .where(inArray(gamesTable.id, tacticalGameIds))
    : [];
  const tacticalGameById = new Map(tacticalGames.map((game) => [game.id, game]));
  const roster = rosterRows ?? await campaignRoster(campaignId);
  const rosterById = new Map(roster.map((ship) => [ship.id, ship]));
  return battles.map((battle) => ({
    ...battle,
    priorityModifiers: campaignBattlePriorityState(
      battle,
      priorityChoices.filter((choice) => choice.campaignBattleId === battle.id),
      viewerPlayerId,
    ),
    tacticalGameStatus: battle.tacticalGameId
      ? tacticalGameById.get(battle.tacticalGameId)?.status ?? null
      : null,
    tacticalWinnerId: battle.tacticalGameId
      ? tacticalGameById.get(battle.tacticalGameId)?.winnerId ?? null
      : null,
    assignments: assignments
      .filter((assignment) => assignment.campaignBattleId === battle.id)
      .map((assignment) => ({
        ...assignment,
        rosterShip: rosterById.get(assignment.campaignShipInstanceId) ?? null,
      })),
  }));
}

async function getMembership(campaignId: number, userId: string): Promise<CampaignPlayerRow | null> {
  const [membership] = await db
    .select()
    .from(campaignPlayersTable)
    .where(and(
      eq(campaignPlayersTable.campaignId, campaignId),
      eq(campaignPlayersTable.playerId, userId),
    ))
    .limit(1);
  return membership ?? null;
}

async function canReadCampaign(campaign: CampaignRow, userId: string): Promise<boolean> {
  if (campaign.ownerPlayerId === userId) return true;
  if (campaign.visibility === "public" && campaign.status === "setup") return true;
  return Boolean(await getMembership(campaign.id, userId));
}

function toCampaignSummary(campaign: CampaignRow, players: CampaignPlayerRow[]) {
  return {
    ...campaign,
    playerCount: players.length,
    players,
  };
}

async function campaignDetail(campaign: CampaignRow, viewerPlayerId?: string) {
  const players = await campaignPlayers(campaign.id);
  const recentLog = await recentCampaignLog(campaign.id);
  const roster = await campaignRoster(campaign.id);
  const battles = await campaignBattles(campaign.id, roster, viewerPlayerId);
  const strategicTargets = await campaignStrategicTargets(campaign.id);
  const currentTurnState = await campaignCurrentTurnState(campaign);
  const resolution = await campaignResolutionState(campaign, roster);
  return {
    ...toCampaignSummary(campaign, players),
    recentLog,
    roster,
    battles,
    strategicTargets,
    currentTurnState,
    resolution,
    setup: campaignSetupState(players, roster),
  };
}

async function appendCampaignLog(args: {
  campaignId: number;
  turnNumber?: number;
  actorPlayerId?: string | null;
  type: string;
  message: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(campaignLogEntriesTable).values({
    campaignId: args.campaignId,
    turnNumber: args.turnNumber ?? 0,
    actorPlayerId: args.actorPlayerId ?? null,
    type: args.type,
    message: args.message,
    payload: args.payload ?? {},
  });
}

function campaignModelIsFighter(model: Pick<ShipModelRow, "shipClass" | "name"> | null | undefined): boolean {
  const label = `${model?.shipClass ?? ""} ${model?.name ?? ""}`;
  return /\b(fighter|flight|breaching pod|boarding pod|shuttle)\b/i.test(label);
}

function campaignModelIsSpaceStation(
  model: Pick<ShipModelRow, "name" | "shipClass" | "traits"> | null | undefined,
): boolean {
  const traits = parseShipTraits(model?.traits ?? "");
  return traits.spaceStation
    || /\bspace\s+station\b/i.test(model?.name ?? "")
    || /\bstar\s*base\b/i.test(model?.name ?? "")
    || /\bstation\b/i.test(model?.shipClass ?? "");
}

function campaignModelIsCivilian(model: Pick<ShipModelRow, "shipClass" | "priorityLevel"> | null | undefined): boolean {
  return /\bcivilian\b/i.test(`${model?.shipClass ?? ""} ${model?.priorityLevel ?? ""}`);
}

async function insertCampaignLedgerEntry(tx: any, entry: {
  campaignId: number;
  campaignTurnId: number | null;
  turnNumber: number;
  playerId: string;
  campaignShipInstanceId?: number | null;
  resource: "rr" | "xp-dice";
  amount: number;
  eventKey: string;
  type: string;
  message: string;
  payload?: Record<string, unknown>;
}) {
  const rows = await tx.insert(campaignResourceLedgerTable).values({
    ...entry,
    campaignShipInstanceId: entry.campaignShipInstanceId ?? null,
    payload: entry.payload ?? {},
  }).onConflictDoNothing().returning();
  return rows[0] ?? null;
}

async function awardCampaignShipXp(tx: any, args: {
  campaign: CampaignRow;
  campaignTurnId: number | null;
  turnNumber: number;
  ship: typeof campaignShipInstancesTable.$inferSelect;
  amount: number;
  eventKey: string;
  type: string;
  message: string;
  payload?: Record<string, unknown>;
}) {
  if (args.amount === 0) return false;
  const inserted = await insertCampaignLedgerEntry(tx, {
    campaignId: args.campaign.id,
    campaignTurnId: args.campaignTurnId,
    turnNumber: args.turnNumber,
    playerId: args.ship.ownerPlayerId,
    campaignShipInstanceId: args.ship.id,
    resource: "xp-dice",
    amount: args.amount,
    eventKey: args.eventKey,
    type: args.type,
    message: args.message,
    payload: args.payload,
  });
  if (!inserted) return false;
  await tx.update(campaignShipInstancesTable).set({
    xpDice: sql`GREATEST(0, ${campaignShipInstancesTable.xpDice} + ${args.amount})`,
    updatedAt: new Date(),
  }).where(eq(campaignShipInstancesTable.id, args.ship.id));
  return true;
}

async function campaignRrBalance(tx: any, campaignId: number, playerId: string): Promise<number> {
  const entries = await tx.select({ amount: campaignResourceLedgerTable.amount })
    .from(campaignResourceLedgerTable)
    .where(and(
      eq(campaignResourceLedgerTable.campaignId, campaignId),
      eq(campaignResourceLedgerTable.playerId, playerId),
      eq(campaignResourceLedgerTable.resource, "rr"),
    ));
  return entries.reduce((sum: number, entry: { amount: number }) => sum + entry.amount, 0);
}

async function ensureCampaignTurnPlayerStates(tx: any, campaign: CampaignRow, turn: CampaignTurnRow) {
  const players = await tx.select().from(campaignPlayersTable).where(and(
    eq(campaignPlayersTable.campaignId, campaign.id),
    eq(campaignPlayersTable.status, "active"),
  ));
  for (const player of players) {
    await tx.insert(campaignTurnPlayerStatesTable).values({
      campaignId: campaign.id,
      campaignTurnId: turn.id,
      turnNumber: turn.turnNumber,
      playerId: player.playerId,
    }).onConflictDoNothing();
  }
  return players as CampaignPlayerRow[];
}

function auditState(payload: Record<string, unknown>, key: "targetBefore" | "targetAfter") {
  const value = payload[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function auditTrack(state: Record<string, unknown> | null, key: string): number {
  const value = Number(state?.[key]);
  return Number.isFinite(value) ? value : 0;
}

async function awardCampaignBattleXp(tx: any, args: {
  campaign: CampaignRow;
  turn: CampaignTurnRow;
  battle: CampaignBattleRow;
  game: typeof gamesTable.$inferSelect;
  assignments: Array<typeof campaignBattleShipAssignmentsTable.$inferSelect>;
  campaignShips: Array<typeof campaignShipInstancesTable.$inferSelect>;
  tacticalUnits: TacticalUnitRow[];
  models: ShipModelRow[];
}) {
  const shipById = new Map(args.campaignShips.map((ship) => [ship.id, ship]));
  const unitById = new Map(args.tacticalUnits.map((unit) => [unit.id, unit]));
  const assignmentByUnitId = new Map<number, typeof campaignBattleShipAssignmentsTable.$inferSelect>();
  for (const assignment of args.assignments) {
    const unit = args.tacticalUnits.find((candidate) => candidate.campaignShipInstanceId === assignment.campaignShipInstanceId);
    if (unit) assignmentByUnitId.set(unit.id, assignment);
  }
  const modelById = new Map(args.models.map((model) => [model.id, model]));
  const campaignModel = (shipId: number) => {
    const ship = shipById.get(shipId);
    return ship ? modelById.get(ship.sourceShipModelId) ?? null : null;
  };

  for (const assignment of args.assignments) {
    const ship = shipById.get(assignment.campaignShipInstanceId);
    const unit = args.tacticalUnits.find((candidate) => candidate.campaignShipInstanceId === assignment.campaignShipInstanceId);
    const model = ship ? modelById.get(ship.sourceShipModelId) ?? null : null;
    if (!ship || !unit || unit.isDestroyed || unit.damageState === "destroyed"
      || unit.capturedByOwnerId || unit.surrenderedToOwnerId || campaignModelIsFighter(model)) continue;
    const participation = args.game.winnerId === ship.ownerPlayerId ? 2 : 1;
    await awardCampaignShipXp(tx, {
      campaign: args.campaign,
      campaignTurnId: args.turn.id,
      turnNumber: args.turn.turnNumber,
      ship,
      amount: participation,
      eventKey: `campaign:${args.campaign.id}:battle:${args.battle.id}:ship:${ship.id}:participation`,
      type: "campaign.xp.participation",
      message: `${ship.name} earned ${participation} XP dice for taking part in ${args.battle.name ?? `battle ${args.battle.id}`}.`,
      payload: { battleId: args.battle.id, winnerId: args.game.winnerId },
    });

    const threshold = unit.crewThreshold > 0 ? unit.crewThreshold : Math.floor(unit.maxCrewPoints / 2);
    const beforeCrew = Number((assignment.preBattleSnapshot as Record<string, unknown>).crewCurrent ?? ship.crewMax);
    if (threshold > 0 && beforeCrew > threshold && unit.crewPoints <= threshold) {
      const inserted = await awardCampaignShipXp(tx, {
        campaign: args.campaign,
        campaignTurnId: args.turn.id,
        turnNumber: args.turn.turnNumber,
        ship,
        amount: -2,
        eventKey: `campaign:${args.campaign.id}:battle:${args.battle.id}:ship:${ship.id}:skeleton-penalty`,
        type: "campaign.xp.skeleton-penalty",
        message: `${ship.name} lost 2 XP dice and 1 Crew Quality after being reduced to Skeleton Crew.`,
        payload: { battleId: args.battle.id, crewThreshold: threshold },
      });
      if (inserted) {
        await tx.update(campaignShipInstancesTable).set({
          crewQuality: Math.max(1, ship.crewQuality - 1),
          updatedAt: new Date(),
        }).where(eq(campaignShipInstancesTable.id, ship.id));
      }
    }
  }

  const attackLogs = await tx.select().from(gameAttackAuditLogsTable)
    .where(eq(gameAttackAuditLogsTable.gameId, args.game.id))
    .orderBy(asc(gameAttackAuditLogsTable.id));
  const milestones = new Map<string, {
    attackerShipId: number;
    targetShipId: number;
    crippleLogId: number | null;
    skeletonLogId: number | null;
    destroyLogId: number | null;
  }>();
  for (const log of attackLogs) {
    const attackerAssignment = assignmentByUnitId.get(log.attackerUnitId);
    const targetAssignment = assignmentByUnitId.get(log.targetUnitId);
    if (!attackerAssignment || !targetAssignment) continue;
    const attackerShip = shipById.get(attackerAssignment.campaignShipInstanceId);
    const targetShip = shipById.get(targetAssignment.campaignShipInstanceId);
    const targetUnit = unitById.get(log.targetUnitId);
    if (!attackerShip || !targetShip || !targetUnit) continue;
    const attackerModel = campaignModel(attackerShip.id);
    const targetModel = campaignModel(targetShip.id);
    if (campaignModelIsFighter(attackerModel) || campaignModelIsFighter(targetModel) || campaignModelIsCivilian(targetModel)) continue;
    const before = auditState(log.payload, "targetBefore");
    const after = auditState(log.payload, "targetAfter");
    if (!before || !after) continue;
    const key = `${attackerShip.id}:${targetShip.id}`;
    const entry = milestones.get(key) ?? {
      attackerShipId: attackerShip.id,
      targetShipId: targetShip.id,
      crippleLogId: null,
      skeletonLogId: null,
      destroyLogId: null,
    };
    const damageThreshold = Math.max(0, targetUnit.damageThreshold);
    const crewThreshold = targetUnit.crewThreshold > 0
      ? targetUnit.crewThreshold
      : Math.floor(targetUnit.maxCrewPoints / 2);
    if (!entry.crippleLogId && damageThreshold > 0
      && auditTrack(before, "hullPoints") > damageThreshold
      && auditTrack(after, "hullPoints") <= damageThreshold) {
      entry.crippleLogId = log.id;
    }
    if (!entry.skeletonLogId && crewThreshold > 0
      && auditTrack(before, "crewPoints") > crewThreshold
      && auditTrack(after, "crewPoints") <= crewThreshold) {
      entry.skeletonLogId = log.id;
    }
    const beforeDestroyed = before.isDestroyed === true || before.damageState === "destroyed";
    const afterDestroyed = after.isDestroyed === true || after.damageState === "destroyed";
    if (!entry.destroyLogId && !beforeDestroyed && afterDestroyed) entry.destroyLogId = log.id;
    milestones.set(key, entry);
  }

  const surrenderLogs = await tx.select().from(gameSpecialActionAuditLogsTable).where(and(
    eq(gameSpecialActionAuditLogsTable.gameId, args.game.id),
    eq(gameSpecialActionAuditLogsTable.action, "stand-down-and-prepare-to-be-boarded"),
    eq(gameSpecialActionAuditLogsTable.success, true),
  ));
  const surrenderPairs = new Set<string>();
  for (const log of surrenderLogs) {
    if (!log.targetUnitId) continue;
    const attackerAssignment = assignmentByUnitId.get(log.unitId);
    const targetAssignment = assignmentByUnitId.get(log.targetUnitId);
    if (!attackerAssignment || !targetAssignment) continue;
    const attackerShip = shipById.get(attackerAssignment.campaignShipInstanceId);
    const targetShip = shipById.get(targetAssignment.campaignShipInstanceId);
    if (!attackerShip || !targetShip) continue;
    const attackerModel = campaignModel(attackerShip.id);
    const targetModel = campaignModel(targetShip.id);
    if (campaignModelIsFighter(attackerModel) || campaignModelIsFighter(targetModel) || campaignModelIsCivilian(targetModel)) continue;
    const pairKey = `${attackerShip.id}:${targetShip.id}`;
    surrenderPairs.add(pairKey);
    const xp = campaignDestroyXpDice(attackerModel?.priorityLevel, targetModel?.priorityLevel) * 2;
    await awardCampaignShipXp(tx, {
      campaign: args.campaign,
      campaignTurnId: args.turn.id,
      turnNumber: args.turn.turnNumber,
      ship: attackerShip,
      amount: xp,
      eventKey: `campaign:${args.campaign.id}:battle:${args.battle.id}:surrender:${log.id}`,
      type: "campaign.xp.forced-surrender",
      message: `${attackerShip.name} earned ${xp} XP dice for forcing ${targetShip.name} to surrender.`,
      payload: { battleId: args.battle.id, targetShipInstanceId: targetShip.id },
    });
  }

  for (const [pairKey, milestone] of milestones) {
    if (surrenderPairs.has(pairKey)) continue;
    const attackerShip = shipById.get(milestone.attackerShipId);
    const targetShip = shipById.get(milestone.targetShipId);
    if (!attackerShip || !targetShip) continue;
    const destroyXp = campaignDestroyXpDice(
      campaignModel(attackerShip.id)?.priorityLevel,
      campaignModel(targetShip.id)?.priorityLevel,
    );
    if (milestone.destroyLogId) {
      await awardCampaignShipXp(tx, {
        campaign: args.campaign,
        campaignTurnId: args.turn.id,
        turnNumber: args.turn.turnNumber,
        ship: attackerShip,
        amount: destroyXp,
        eventKey: `campaign:${args.campaign.id}:battle:${args.battle.id}:destroy:${milestone.destroyLogId}`,
        type: "campaign.xp.destroyed-enemy",
        message: `${attackerShip.name} earned ${destroyXp} XP dice for destroying ${targetShip.name}.`,
        payload: { battleId: args.battle.id, targetShipInstanceId: targetShip.id },
      });
      continue;
    }
    const partialXp = campaignPartialDamageXpDice(destroyXp);
    for (const [kind, logId] of [["crippled", milestone.crippleLogId], ["skeleton", milestone.skeletonLogId]] as const) {
      if (!logId || partialXp < 1) continue;
      await awardCampaignShipXp(tx, {
        campaign: args.campaign,
        campaignTurnId: args.turn.id,
        turnNumber: args.turn.turnNumber,
        ship: attackerShip,
        amount: partialXp,
        eventKey: `campaign:${args.campaign.id}:battle:${args.battle.id}:${kind}:${logId}`,
        type: `campaign.xp.${kind}-enemy`,
        message: `${attackerShip.name} earned ${partialXp} XP dice for reducing ${targetShip.name} to ${kind === "crippled" ? "Crippled" : "Skeleton Crew"}.`,
        payload: { battleId: args.battle.id, targetShipInstanceId: targetShip.id },
      });
    }
  }
}

async function resolveCampaignBattleOutcome(tx: any, args: {
  campaign: CampaignRow;
  turn: CampaignTurnRow;
  battle: CampaignBattleRow;
  game: typeof gamesTable.$inferSelect;
}) {
  const winnerId = args.game.winnerId;
  if (winnerId) {
    await insertCampaignLedgerEntry(tx, {
      campaignId: args.campaign.id,
      campaignTurnId: args.turn.id,
      turnNumber: args.turn.turnNumber,
      playerId: winnerId,
      resource: "rr",
      amount: 5,
      eventKey: `campaign:${args.campaign.id}:battle:${args.battle.id}:victory`,
      type: "campaign.rr.battle-victory",
      message: `Won ${args.battle.name ?? `battle ${args.battle.id}`}: +5 RR.`,
      payload: { battleId: args.battle.id },
    });
  }
  if (!args.battle.targetId) return;
  const [target] = await tx.select().from(campaignStrategicTargetsTable).where(and(
    eq(campaignStrategicTargetsTable.id, args.battle.targetId),
    eq(campaignStrategicTargetsTable.campaignId, args.campaign.id),
  )).limit(1);
  if (!target || !winnerId) return;

  if (target.isTradeRoute) {
    const nominatorWon = winnerId === args.battle.attackerPlayerId;
    const bonus = nominatorWon ? 15 : 10;
    await insertCampaignLedgerEntry(tx, {
      campaignId: args.campaign.id,
      campaignTurnId: args.turn.id,
      turnNumber: args.turn.turnNumber,
      playerId: winnerId,
      resource: "rr",
      amount: bonus,
      eventKey: `campaign:${args.campaign.id}:battle:${args.battle.id}:trade-route`,
      type: "campaign.rr.trade-route",
      message: `${target.name} result: +${bonus} RR.`,
      payload: { battleId: args.battle.id, nominatorWon },
    });
    const players = await tx.select().from(campaignPlayersTable).where(and(
      eq(campaignPlayersTable.campaignId, args.campaign.id),
      eq(campaignPlayersTable.status, "active"),
    ));
    for (const player of players) {
      if (player.playerId === winnerId) continue;
      await insertCampaignLedgerEntry(tx, {
        campaignId: args.campaign.id,
        campaignTurnId: args.turn.id,
        turnNumber: args.turn.turnNumber,
        playerId: player.playerId,
        resource: "rr",
        amount: -2,
        eventKey: `campaign:${args.campaign.id}:battle:${args.battle.id}:trade-route-loss:${player.playerId}`,
        type: "campaign.rr.trade-route-loss",
        message: `${target.name} was lost to a rival: -2 RR.`,
        payload: { battleId: args.battle.id, winnerId },
      });
    }
    return;
  }

  const previousOwnerPlayerId = target.ownerPlayerId;
  if (previousOwnerPlayerId === winnerId) return;
  const eventKey = `campaign:${args.campaign.id}:battle:${args.battle.id}:target:${target.id}:ownership`;
  const inserted = await tx.insert(campaignTargetOwnershipEventsTable).values({
    campaignId: args.campaign.id,
    campaignTurnId: args.turn.id,
    turnNumber: args.turn.turnNumber,
    targetId: target.id,
    previousOwnerPlayerId,
    newOwnerPlayerId: winnerId,
    campaignBattleId: args.battle.id,
    nominationId: args.battle.nominationId,
    eventKey,
    reason: "battle-victory",
  }).onConflictDoNothing().returning();
  if (inserted.length === 0) return;
  await tx.update(campaignStrategicTargetsTable).set({
    ownerPlayerId: winnerId,
    updatedAt: new Date(),
  }).where(eq(campaignStrategicTargetsTable.id, target.id));
  await insertCampaignLedgerEntry(tx, {
    campaignId: args.campaign.id,
    campaignTurnId: args.turn.id,
    turnNumber: args.turn.turnNumber,
    playerId: winnerId,
    resource: "rr",
    amount: 10,
    eventKey: `${eventKey}:capture-rr`,
    type: "campaign.rr.target-captured",
    message: `Captured ${target.name}: +10 RR.`,
    payload: { targetId: target.id, battleId: args.battle.id },
  });
  if (previousOwnerPlayerId) {
    await insertCampaignLedgerEntry(tx, {
      campaignId: args.campaign.id,
      campaignTurnId: args.turn.id,
      turnNumber: args.turn.turnNumber,
      playerId: previousOwnerPlayerId,
      resource: "rr",
      amount: -15,
      eventKey: `${eventKey}:loss-rr`,
      type: "campaign.rr.target-lost",
      message: `Lost ${target.name}: -15 RR.`,
      payload: { targetId: target.id, battleId: args.battle.id, winnerId },
    });
  }
  await tx.insert(campaignLogEntriesTable).values({
    campaignId: args.campaign.id,
    turnNumber: args.turn.turnNumber,
    actorPlayerId: winnerId,
    type: "campaign.target.captured-after-battle",
    message: `${target.name} changed hands after ${args.battle.name ?? `battle ${args.battle.id}`}.`,
    payload: { targetId: target.id, previousOwnerPlayerId, newOwnerPlayerId: winnerId },
  });
}

async function maybeAdvanceCampaignToExperience(tx: any, campaign: CampaignRow, turn: CampaignTurnRow) {
  const battles = await tx.select().from(campaignBattlesTable).where(and(
    eq(campaignBattlesTable.campaignId, campaign.id),
    eq(campaignBattlesTable.turnNumber, turn.turnNumber),
  ));
  if (battles.length === 0 || battles.some((battle: CampaignBattleRow) => battle.status !== "imported")) return false;
  await ensureCampaignTurnPlayerStates(tx, campaign, turn);
  await tx.update(campaignTurnsTable).set({ status: "ship-experience", updatedAt: new Date() })
    .where(eq(campaignTurnsTable.id, turn.id));
  await tx.update(campaignsTable).set({ phase: "ship-experience", updatedAt: new Date() })
    .where(eq(campaignsTable.id, campaign.id));
  return true;
}

async function generateCampaignRrIncome(tx: any, campaign: CampaignRow, turn: CampaignTurnRow) {
  const players = await ensureCampaignTurnPlayerStates(tx, campaign, turn);
  const targets = await tx.select().from(campaignStrategicTargetsTable)
    .where(eq(campaignStrategicTargetsTable.campaignId, campaign.id));
  const roster = await tx.select().from(campaignShipInstancesTable)
    .where(eq(campaignShipInstancesTable.campaignId, campaign.id));
  const modelIds: number[] = Array.from(new Set<number>(
    roster.map((ship: typeof campaignShipInstancesTable.$inferSelect) => ship.sourceShipModelId),
  ));
  const models = modelIds.length > 0
    ? await tx.select().from(shipModelsTable).where(inArray(shipModelsTable.id, modelIds))
    : [];
  const modelById = new Map<number, ShipModelRow>(models.map((model: ShipModelRow) => [model.id, model]));

  for (const player of players) {
    const [state] = await tx.select().from(campaignTurnPlayerStatesTable).where(and(
      eq(campaignTurnPlayerStatesTable.campaignTurnId, turn.id),
      eq(campaignTurnPlayerStatesTable.playerId, player.playerId),
    )).limit(1);
    if (!state || state.rrIncomeGenerated) continue;
    const heldTargets = targets.filter((target: CampaignStrategicTargetRow) =>
      target.ownerPlayerId === player.playerId && !target.isTradeRoute
    );
    const heldValues = heldTargets.map((target: CampaignStrategicTargetRow) => {
      if (target.rrFormula === "1d6") return rollCampaignDice(1)[0] ?? 1;
      return target.rrValue;
    });
    const stationCount = roster.filter((ship: typeof campaignShipInstancesTable.$inferSelect) =>
      ship.ownerPlayerId === player.playerId
      && !ship.destroyed
      && !ship.capturedByPlayerId
      && campaignModelIsSpaceStation(modelById.get(ship.sourceShipModelId))
    ).length;
    const income = campaignRrIncome({
      heldTargetValues: heldValues,
      battlesWon: 0,
      targetsCaptured: 0,
      targetsLost: 0,
      stationCount,
    });
    for (const [kind, amount] of [
      ["base", income.base],
      ["held-targets", income.heldTargets],
      ["stations", income.stations],
    ] as const) {
      if (amount === 0) continue;
      await insertCampaignLedgerEntry(tx, {
        campaignId: campaign.id,
        campaignTurnId: turn.id,
        turnNumber: turn.turnNumber,
        playerId: player.playerId,
        resource: "rr",
        amount,
        eventKey: `campaign:${campaign.id}:turn:${turn.turnNumber}:rr-income:${player.playerId}:${kind}`,
        type: `campaign.rr.income.${kind}`,
        message: `${kind === "base" ? "Campaign grant" : kind === "held-targets" ? "Strategic Target income" : "Station upkeep"}: ${amount >= 0 ? "+" : ""}${amount} RR.`,
        payload: { heldTargetIds: heldTargets.map((target: CampaignStrategicTargetRow) => target.id), stationCount },
      });
    }
    await tx.update(campaignTurnPlayerStatesTable).set({ rrIncomeGenerated: true, updatedAt: new Date() })
      .where(eq(campaignTurnPlayerStatesTable.id, state.id));
  }
  await tx.update(campaignTurnsTable).set({ status: "repairs-reinforcements", updatedAt: new Date() })
    .where(eq(campaignTurnsTable.id, turn.id));
  await tx.update(campaignsTable).set({ phase: "repairs-reinforcements", updatedAt: new Date() })
    .where(eq(campaignsTable.id, campaign.id));
}

async function advanceCampaignTurn(tx: any, campaign: CampaignRow, turn: CampaignTurnRow) {
  const nextTurnNumber = turn.turnNumber + 1;
  const roster = await tx.select().from(campaignShipInstancesTable)
    .where(eq(campaignShipInstancesTable.campaignId, campaign.id));
  const modelIds: number[] = Array.from(new Set<number>(
    roster.map((ship: typeof campaignShipInstancesTable.$inferSelect) => ship.sourceShipModelId),
  ));
  const models = modelIds.length > 0
    ? await tx.select().from(shipModelsTable).where(inArray(shipModelsTable.id, modelIds))
    : [];
  const modelById = new Map<number, ShipModelRow>(models.map((model: ShipModelRow) => [model.id, model]));
  for (const ship of roster) {
    const model = modelById.get(ship.sourceShipModelId);
    if (ship.status === "high-command-repair" && ship.unavailableUntilTurn <= nextTurnNumber) {
      await tx.update(campaignShipInstancesTable).set({
        status: "active",
        hullCurrent: ship.hullMax,
        crewCurrent: ship.crewMax,
        troopsCurrent: ship.troopsMax,
        criticalEffects: [],
        updatedAt: new Date(),
      }).where(eq(campaignShipInstancesTable.id, ship.id));
      continue;
    }
    const canReplenishFighters = !ship.destroyed && !ship.capturedByPlayerId && ship.status !== "surrendered";
    let fighterReplacements = canReplenishFighters ? 2 : 0;
    const replenishedFighters = Array.isArray(ship.carriedFighters)
      ? ship.carriedFighters.map((raw: unknown) => {
          const item = raw as Record<string, unknown>;
          const total = Number(item.total);
          const available = Number(item.available);
          const destroyed = Number(item.destroyed);
          if (!Number.isFinite(total) || !Number.isFinite(available) || !Number.isFinite(destroyed) || fighterReplacements <= 0) {
            return raw;
          }
          const replaced = Math.min(fighterReplacements, Math.max(0, Math.trunc(destroyed)));
          fighterReplacements -= replaced;
          return {
            ...item,
            available: Math.min(Math.max(0, Math.trunc(total)), Math.max(0, Math.trunc(available)) + replaced),
            destroyed: Math.max(0, Math.trunc(destroyed) - replaced),
          };
        })
      : ship.carriedFighters;
    if (canReplenishFighters && fighterReplacements < 2) {
      await tx.update(campaignShipInstancesTable).set({
        carriedFighters: replenishedFighters,
        updatedAt: new Date(),
      }).where(eq(campaignShipInstancesTable.id, ship.id));
    }
    if (!ship.destroyed && !ship.capturedByPlayerId && ship.status !== "surrendered"
      && parseShipTraits(model?.traits ?? "").selfRepairDice > 0) {
      await tx.update(campaignShipInstancesTable).set({
        hullCurrent: ship.hullMax,
        status: ship.crewMax > 0 && ship.crewCurrent <= 0 ? "adrift" : "active",
        updatedAt: new Date(),
      }).where(eq(campaignShipInstancesTable.id, ship.id));
    }
  }
  await tx.update(campaignStrategicTargetsTable).set({ ownerPlayerId: null, updatedAt: new Date() }).where(and(
    eq(campaignStrategicTargetsTable.campaignId, campaign.id),
    eq(campaignStrategicTargetsTable.isTradeRoute, true),
  ));
  await tx.update(campaignTurnsTable).set({ status: "completed", updatedAt: new Date() })
    .where(eq(campaignTurnsTable.id, turn.id));

  const targets = await tx.select().from(campaignStrategicTargetsTable).where(and(
    eq(campaignStrategicTargetsTable.campaignId, campaign.id),
    eq(campaignStrategicTargetsTable.isTradeRoute, false),
  ));
  const activePlayers = await tx.select().from(campaignPlayersTable).where(and(
    eq(campaignPlayersTable.campaignId, campaign.id),
    eq(campaignPlayersTable.status, "active"),
  ));
  const victor = activePlayers.find((player: CampaignPlayerRow) =>
    targets.length > 0 && targets.every((target: CampaignStrategicTargetRow) => target.ownerPlayerId === player.playerId)
  );
  if (victor) {
    await tx.update(campaignsTable).set({ status: "completed", phase: "completed", updatedAt: new Date() })
      .where(eq(campaignsTable.id, campaign.id));
    await tx.insert(campaignLogEntriesTable).values({
      campaignId: campaign.id,
      turnNumber: turn.turnNumber,
      actorPlayerId: victor.playerId,
      type: "campaign.completed",
      message: `${campaignPlayerLabel(victor)} controls every Strategic Target and wins the campaign.`,
      payload: { winnerId: victor.playerId },
    });
    return;
  }

  const [nextTurn] = await tx.insert(campaignTurnsTable).values({
    campaignId: campaign.id,
    turnNumber: nextTurnNumber,
    status: "initiative",
    initiativeOrder: [],
    targetSelectionIndex: 0,
  }).returning();
  await tx.update(campaignsTable).set({
    currentTurn: nextTurnNumber,
    phase: "initiative",
    updatedAt: new Date(),
  }).where(eq(campaignsTable.id, campaign.id));
  await tx.insert(campaignLogEntriesTable).values({
    campaignId: campaign.id,
    turnNumber: nextTurnNumber,
    actorPlayerId: null,
    type: "campaign.turn.started",
    message: `Campaign Turn ${nextTurnNumber} began.`,
    payload: { campaignTurnId: nextTurn.id },
  });
}

async function campaignResolutionContext(
  tx: any,
  campaignId: number,
  playerId: string,
  requiredPhase: "ship-experience" | "repairs-reinforcements",
) {
  const [campaign] = await tx.select().from(campaignsTable)
    .where(eq(campaignsTable.id, campaignId)).limit(1);
  if (!campaign) throw Object.assign(new Error("Campaign not found"), { status: 404 });
  if (campaign.status !== "active" || campaign.phase !== requiredPhase) {
    throw Object.assign(new Error(
      requiredPhase === "ship-experience"
        ? "The campaign is not currently resolving Ship Experience"
        : "The campaign is not currently resolving repairs and reinforcements",
    ), { status: 409 });
  }
  const [membership] = await tx.select().from(campaignPlayersTable).where(and(
    eq(campaignPlayersTable.campaignId, campaign.id),
    eq(campaignPlayersTable.playerId, playerId),
    eq(campaignPlayersTable.status, "active"),
  )).limit(1);
  if (!membership) throw Object.assign(new Error("You are not an active commander in this campaign"), { status: 403 });
  const [turn] = await tx.select().from(campaignTurnsTable).where(and(
    eq(campaignTurnsTable.campaignId, campaign.id),
    eq(campaignTurnsTable.turnNumber, campaign.currentTurn),
  )).limit(1);
  if (!turn) throw Object.assign(new Error("Current campaign turn was not found"), { status: 409 });
  await ensureCampaignTurnPlayerStates(tx, campaign, turn);
  const [playerState] = await tx.select().from(campaignTurnPlayerStatesTable).where(and(
    eq(campaignTurnPlayerStatesTable.campaignTurnId, turn.id),
    eq(campaignTurnPlayerStatesTable.playerId, playerId),
  )).limit(1);
  if (!playerState) throw Object.assign(new Error("Campaign resolution state was not found"), { status: 409 });
  if (requiredPhase === "ship-experience" && playerState.experienceComplete) {
    throw Object.assign(new Error("You have already completed Ship Experience for this turn"), { status: 409 });
  }
  if (requiredPhase === "repairs-reinforcements" && playerState.repairsComplete) {
    throw Object.assign(new Error("You have already completed repairs and reinforcements for this turn"), { status: 409 });
  }
  return { campaign: campaign as CampaignRow, membership: membership as CampaignPlayerRow, turn: turn as CampaignTurnRow, playerState };
}

async function ownedCampaignShip(tx: any, campaignId: number, playerId: string, shipInstanceId: number) {
  const [ship] = await tx.select().from(campaignShipInstancesTable).where(and(
    eq(campaignShipInstancesTable.id, shipInstanceId),
    eq(campaignShipInstancesTable.campaignId, campaignId),
    eq(campaignShipInstancesTable.ownerPlayerId, playerId),
  )).limit(1);
  if (!ship) throw Object.assign(new Error("Campaign ship not found in your roster"), { status: 404 });
  return ship as typeof campaignShipInstancesTable.$inferSelect;
}

function assertCampaignShipCanBeMaintained(ship: typeof campaignShipInstancesTable.$inferSelect) {
  if (ship.destroyed || ship.status === "destroyed") {
    throw Object.assign(new Error("Destroyed ships are removed from the campaign roster"), { status: 400 });
  }
  if (ship.capturedByPlayerId || ship.status === "captured" || ship.status === "surrendered") {
    throw Object.assign(new Error("Captured or surrendered ships cannot be maintained by their former owner"), { status: 400 });
  }
  if (ship.status === "high-command-repair") {
    throw Object.assign(new Error("This ship is already undergoing repairs at High Command"), { status: 400 });
  }
}

const OPEN_CAMPAIGN_BATTLE_STATUSES = new Set([
  "setup",
  "deployment",
  "active",
  "resolving",
]);

type CampaignScenarioTargetRow = Pick<CampaignStrategicTargetRow, "id" | "name" | "category" | "subtype">;

type GeneratedCampaignRulesSnapshot = Omit<ReturnType<typeof campaignRulesSnapshot>, "version"> & {
  version: 2;
  nominationId: number;
  target: {
    id: number;
    name: string;
    category: string;
    subtype: string;
  };
  generation: {
    state: "awaiting-priority-modifiers" | "awaiting-scenario-choice" | "awaiting-fleet-assignments";
    scenarioRoll: CampaignScenarioRollResult | null;
    priorityRoll: CampaignPriorityRollResult | null;
    scenarioChoiceRequired: boolean;
  };
  sideAllocationPoints: {
    attacker: number;
    defender: number;
  };
};

function generatedCampaignRulesSnapshot(args: {
  nominationId: number;
  target: CampaignScenarioTargetRow;
  scenarioKey: CampaignScenarioKey;
  priorityRoll: CampaignPriorityRollResult;
  scenarioRoll: CampaignScenarioRollResult;
  scenarioChoiceRequired: boolean;
}): GeneratedCampaignRulesSnapshot {
  const rules = campaignGeneratedEngagementRules({
    scenarioKey: args.scenarioKey,
    priorityLevel: args.priorityRoll.priorityLevel,
    targetName: args.target.name,
  });
  return {
    ...campaignRulesSnapshot(rules),
    version: 2,
    nominationId: args.nominationId,
    target: {
      id: args.target.id,
      name: args.target.name,
      category: args.target.category,
      subtype: args.target.subtype,
    },
    generation: {
      state: args.scenarioChoiceRequired ? "awaiting-scenario-choice" : "awaiting-fleet-assignments",
      scenarioRoll: args.scenarioRoll,
      priorityRoll: args.priorityRoll,
      scenarioChoiceRequired: args.scenarioChoiceRequired,
    },
    sideAllocationPoints: campaignScenarioFleetLimits(args.scenarioKey),
  };
}

function pendingCampaignRulesSnapshot(args: {
  nominationId: number;
  target: CampaignScenarioTargetRow;
}): GeneratedCampaignRulesSnapshot {
  const placeholderRules = campaignGeneratedEngagementRules({
    scenarioKey: "campaign-engagement",
    priorityLevel: "raid",
    targetName: args.target.name,
  });
  return {
    ...campaignRulesSnapshot(placeholderRules),
    version: 2,
    nominationId: args.nominationId,
    target: {
      id: args.target.id,
      name: args.target.name,
      category: args.target.category,
      subtype: args.target.subtype,
    },
    generation: {
      state: "awaiting-priority-modifiers",
      scenarioRoll: null,
      priorityRoll: null,
      scenarioChoiceRequired: false,
    },
    sideAllocationPoints: { attacker: 5, defender: 5 },
  };
}

function campaignBattlePriorityState(
  battle: CampaignBattleRow,
  choices: CampaignBattlePriorityChoiceRow[],
  viewerPlayerId?: string,
) {
  const attackerChoice = choices.find((choice) => choice.playerId === battle.attackerPlayerId);
  const defenderChoice = choices.find((choice) => choice.playerId === battle.defenderPlayerId);
  const revealed = battle.status !== "awaiting-priority-modifiers" && attackerChoice && defenderChoice
    ? {
        attacker: attackerChoice.modifier,
        defender: defenderChoice.modifier,
      }
    : null;
  return {
    attackerSubmitted: Boolean(attackerChoice),
    defenderSubmitted: Boolean(defenderChoice),
    myModifier: choices.find((choice) => choice.playerId === viewerPlayerId)?.modifier ?? null,
    revealed,
  };
}

function generatedBattleSnapshot(battle: CampaignBattleRow): GeneratedCampaignRulesSnapshot | null {
  const snapshot = battle.rulesSnapshot as Partial<GeneratedCampaignRulesSnapshot> | null;
  if (!snapshot || snapshot.version !== 2 || !snapshot.generation || !snapshot.sideAllocationPoints) {
    return null;
  }
  return snapshot as GeneratedCampaignRulesSnapshot;
}

function campaignBattleSideAllocation(
  battle: CampaignBattleRow,
  side: "attacker" | "defender",
): number {
  const generated = generatedBattleSnapshot(battle);
  if (generated) return generated.sideAllocationPoints[side];
  const rules = battle.rulesSnapshot as { allocationPoints?: unknown } | null;
  const allocationPoints = Number(rules?.allocationPoints ?? 5);
  return Number.isFinite(allocationPoints) ? Math.max(1, Math.trunc(allocationPoints)) : 5;
}

function campaignShipSnapshot(ship: typeof campaignShipInstancesTable.$inferSelect): Record<string, unknown> {
  return {
    campaignShipInstanceId: ship.id,
    ownerPlayerId: ship.ownerPlayerId,
    sourceShipModelId: ship.sourceShipModelId,
    name: ship.name,
    status: ship.status,
    hullCurrent: ship.hullCurrent,
    hullMax: ship.hullMax,
    crewCurrent: ship.crewCurrent,
    crewMax: ship.crewMax,
    troopsCurrent: ship.troopsCurrent,
    troopsMax: ship.troopsMax,
    crewQuality: ship.crewQuality,
    xpDice: ship.xpDice,
    refits: ship.refits,
    duties: ship.duties,
    carriedFighters: ship.carriedFighters,
    criticalEffects: ship.criticalEffects,
    unavailableUntilTurn: ship.unavailableUntilTurn,
    usedTurn: ship.usedTurn,
    destroyed: ship.destroyed,
    capturedByPlayerId: ship.capturedByPlayerId,
  };
}

function clampCampaignTrack(value: number, max: number): number {
  return Math.max(0, Math.min(Math.max(0, max), Math.trunc(value)));
}

function campaignCriticalSnapshot(effect: UnitCriticalEffectRow): Record<string, unknown> {
  return {
    effectKey: effect.effectKey,
    location: effect.location,
    name: effect.name,
    damageApplied: effect.damageApplied,
    crewApplied: effect.crewApplied,
    randomArc: effect.randomArc,
    randomWeaponId: effect.randomWeaponId,
    lostTraits: effect.lostTraits,
    appliedRound: effect.appliedRound,
    repairable: effect.repairable,
  };
}

function campaignStatusFromTacticalUnit(unit: TacticalUnitRow): string {
  if (unit.isDestroyed || unit.damageState === "destroyed") return "destroyed";
  if (unit.capturedByOwnerId) return "captured";
  if (unit.surrenderedToOwnerId) return "surrendered";
  if (unit.damageState === "exploding-end-of-next") return "exploding";
  if (unit.damageState === "adrift") return "adrift";
  if (unit.hullPoints <= 0) return "adrift";
  if (unit.maxCrewPoints > 0 && unit.crewPoints <= 0) return "adrift";
  return "active";
}

function campaignPostBattleSnapshot(
  unit: TacticalUnitRow,
  criticalEffects: UnitCriticalEffectRow[],
): Record<string, unknown> {
  return {
    tacticalGameUnitId: unit.id,
    campaignShipInstanceId: unit.campaignShipInstanceId,
    name: unit.name,
    ownerId: unit.ownerId,
    shipId: unit.shipId,
    boardState: unit.boardState,
    hullPoints: unit.hullPoints,
    maxHullPoints: unit.maxHullPoints,
    crewPoints: unit.crewPoints,
    maxCrewPoints: unit.maxCrewPoints,
    troopPoints: unit.troopPoints,
    maxTroopPoints: unit.maxTroopPoints,
    crewQuality: unit.crewQuality,
    damageState: unit.damageState,
    isDestroyed: unit.isDestroyed,
    capturedByOwnerId: unit.capturedByOwnerId,
    capturedRound: unit.capturedRound,
    surrenderedToOwnerId: unit.surrenderedToOwnerId,
    surrenderedRound: unit.surrenderedRound,
    carriedFighters: unit.carriedFighters,
    criticalEffects: criticalEffects.map(campaignCriticalSnapshot),
  };
}

function campaignImportSummaryLine(args: {
  shipName: string;
  status: string;
  hullCurrent: number;
  hullMax: number;
  crewCurrent: number;
  crewMax: number;
  troopsCurrent: number;
  troopsMax: number;
}): string {
  return `${args.shipName}: ${args.status}, hull ${args.hullCurrent}/${args.hullMax}, crew ${args.crewCurrent}/${args.crewMax}, troops ${args.troopsCurrent}/${args.troopsMax}`;
}

function campaignPlayerLabel(player: CampaignPlayerRow | undefined): string {
  return player?.displayName ?? player?.playerId ?? "Commander";
}

async function campaignRosterForTransaction(tx: any, campaignId: number): Promise<CampaignRosterRow[]> {
  const roster = await tx
    .select()
    .from(campaignShipInstancesTable)
    .where(eq(campaignShipInstancesTable.campaignId, campaignId))
    .orderBy(asc(campaignShipInstancesTable.ownerPlayerId), asc(campaignShipInstancesTable.id)) as Array<typeof campaignShipInstancesTable.$inferSelect>;
  const modelIds: number[] = Array.from(new Set(roster.map((ship) => ship.sourceShipModelId)));
  const models = modelIds.length > 0
    ? await tx.select().from(shipModelsTable).where(inArray(shipModelsTable.id, modelIds)) as ShipModelRow[]
    : [] as ShipModelRow[];
  const modelById = new Map<number, ShipModelRow>(models.map((model) => [model.id, model]));
  return roster.map((ship) => ({
    ...ship,
    shipModel: modelById.get(ship.sourceShipModelId) ?? null,
  }));
}

async function ensureCampaignScenarioBattles(
  tx: any,
  campaign: CampaignRow,
  turn: CampaignTurnRow,
): Promise<number[]> {
  const nominations = await tx
    .select()
    .from(campaignTargetNominationsTable)
    .where(and(
      eq(campaignTargetNominationsTable.campaignTurnId, turn.id),
      eq(campaignTargetNominationsTable.status, "battle-ready"),
    ))
    .orderBy(asc(campaignTargetNominationsTable.sequence)) as CampaignTargetNominationRow[];
  if (nominations.length === 0) return [];

  const nominationIds = nominations.map((nomination) => nomination.id);
  const existingBattles = await tx
    .select()
    .from(campaignBattlesTable)
    .where(inArray(campaignBattlesTable.nominationId, nominationIds)) as CampaignBattleRow[];
  const existingNominationIds = new Set(
    existingBattles.map((battle) => battle.nominationId).filter((id): id is number => Boolean(id)),
  );
  const targetIds: number[] = Array.from(new Set(nominations.map((nomination) => nomination.targetId)));
  const targets = await tx
    .select()
    .from(campaignStrategicTargetsTable)
    .where(inArray(campaignStrategicTargetsTable.id, targetIds)) as CampaignStrategicTargetRow[];
  const targetById = new Map<number, CampaignStrategicTargetRow>(targets.map((target) => [target.id, target]));
  const players = await tx
    .select()
    .from(campaignPlayersTable)
    .where(eq(campaignPlayersTable.campaignId, campaign.id)) as CampaignPlayerRow[];
  const playerById = new Map<string, CampaignPlayerRow>(players.map((player) => [player.playerId, player]));
  const createdIds: number[] = [];

  for (const nomination of nominations) {
    if (existingNominationIds.has(nomination.id)) continue;
    const defenderPlayerId = nomination.defenderPlayerId ?? nomination.challengerPlayerId;
    const target = targetById.get(nomination.targetId);
    if (!defenderPlayerId || !target) {
      throw new Error("A contested Strategic Target is missing its defender or target data");
    }
    const name = `${target.name}: ${campaignPlayerLabel(playerById.get(nomination.nominatorPlayerId))} vs ${campaignPlayerLabel(playerById.get(defenderPlayerId))}`;
    const [battle] = await tx
      .insert(campaignBattlesTable)
      .values({
        campaignId: campaign.id,
        campaignTurnId: turn.id,
        nominationId: nomination.id,
        turnNumber: turn.turnNumber,
        targetId: target.id,
        attackerPlayerId: nomination.nominatorPlayerId,
        defenderPlayerId,
        tacticalGameId: null,
        name,
        scenarioKey: "campaign-engagement",
        priorityLevel: "raid",
        rulesSnapshot: pendingCampaignRulesSnapshot({ nominationId: nomination.id, target }),
        status: "awaiting-priority-modifiers",
      })
      .returning();
    createdIds.push(battle.id);
    await tx.insert(campaignLogEntriesTable).values({
      campaignId: campaign.id,
      turnNumber: turn.turnNumber,
      actorPlayerId: null,
      type: "campaign.scenario.prepared",
      message: `${target.name} is ready for secret Priority modifiers and scenario generation.`,
      payload: {
        battleId: battle.id,
        nominationId: nomination.id,
        targetId: target.id,
        attackerPlayerId: nomination.nominatorPlayerId,
        defenderPlayerId,
      },
    });
  }
  return createdIds;
}

async function syncCampaignBattlePlanningPhase(
  tx: any,
  campaign: CampaignRow,
  turn: CampaignTurnRow,
): Promise<string> {
  const battles = await tx
    .select()
    .from(campaignBattlesTable)
    .where(eq(campaignBattlesTable.campaignTurnId, turn.id));
  let phase = "generate-scenarios";
  if (battles.length > 0 && battles.every((battle: CampaignBattleRow) => (
    battle.status !== "awaiting-priority-modifiers" && battle.status !== "awaiting-scenario-choice"
  ))) {
    phase = battles.some((battle: CampaignBattleRow) => battle.status === "awaiting-fleet-assignments")
      ? "fleet-assignment"
      : "tactical-battles";
  }
  await tx.update(campaignTurnsTable).set({ status: phase, updatedAt: new Date() })
    .where(eq(campaignTurnsTable.id, turn.id));
  await tx.update(campaignsTable).set({ phase, updatedAt: new Date() })
    .where(eq(campaignsTable.id, campaign.id));
  return phase;
}

function rosterShipIsAvailableForBattle(ship: CampaignRosterRow, turnNumber: number): string | null {
  if (ship.destroyed || ship.status !== "active") return `${ship.name} is not available for battle`;
  if (ship.capturedByPlayerId) return `${ship.name} is captured and cannot be assigned from its original roster`;
  if (ship.unavailableUntilTurn > turnNumber) {
    return `${ship.name} is unavailable until campaign turn ${ship.unavailableUntilTurn}`;
  }
  if (campaignShipWasUsedThisTurn(ship.usedTurn, turnNumber)) {
    return `${ship.name} has already been committed during campaign turn ${turnNumber}`;
  }
  if (!ship.shipModel) return `${ship.name} is missing its ship model data`;
  return null;
}

function validateGeneratedCampaignForce(args: {
  battle: CampaignBattleRow;
  side: "attacker" | "defender";
  ships: CampaignRosterRow[];
}): void {
  const scenarioPriority = normalizePriorityLevel(args.battle.priorityLevel);
  const allocationPoints = campaignBattleSideAllocation(args.battle, args.side);
  const allocation = calculateAllocation(
    args.ships.map((ship) => normalizePriorityLevel(ship.shipModel?.priorityLevel)),
    scenarioPriority,
    allocationPoints,
  );
  if (!allocation.legal) {
    throw Object.assign(
      new Error(`Selected force exceeds ${allocationPoints} FAP at ${scenarioPriority} Priority`),
      { status: 400 },
    );
  }

  if (args.battle.scenarioKey === "carrier-clash") {
    const carrierShips = new Set(
      args.ships.filter((ship) => shipModelHasTwoFlights(ship.shipModel?.smallCraft)).map((ship) => ship.id),
    );
    if (carrierShips.size === 0) {
      throw Object.assign(new Error("Carrier Clash requires a ship carrying at least two flights"), { status: 400 });
    }
    const scenarioIndex = PRIORITY_LEVELS.indexOf(scenarioPriority);
    const invalidEscort = args.ships.find((ship) => (
      !carrierShips.has(ship.id)
      && PRIORITY_LEVELS.indexOf(normalizePriorityLevel(ship.shipModel?.priorityLevel)) > scenarioIndex
    ));
    if (invalidEscort) {
      throw Object.assign(
        new Error(`${invalidEscort.name} is above the Carrier Clash Priority limit for non-carrier ships`),
        { status: 400 },
      );
    }
  }

  if (args.battle.scenarioKey === "flee-to-jump-gate" && args.side === "attacker") {
    const hasJumpShip = args.ships.some((ship) => parseShipTraits(ship.shipModel?.traits).jumpEngine);
    if (!hasJumpShip) {
      throw Object.assign(
        new Error("Flee to the Jump Gate requires the attacker to field a Jump Engine ship"),
        { status: 400 },
      );
    }
  }
}

async function launchGeneratedCampaignBattleIfReady(
  tx: any,
  campaign: CampaignRow,
  turn: CampaignTurnRow,
  battle: CampaignBattleRow,
): Promise<number | null> {
  if (battle.tacticalGameId) return battle.tacticalGameId;
  const assignments = await tx
    .select()
    .from(campaignBattleShipAssignmentsTable)
    .where(eq(campaignBattleShipAssignmentsTable.campaignBattleId, battle.id));
  const attackerReady = assignments.some((assignment: typeof campaignBattleShipAssignmentsTable.$inferSelect) => assignment.side === "attacker");
  const defenderReady = assignments.some((assignment: typeof campaignBattleShipAssignmentsTable.$inferSelect) => assignment.side === "defender");
  if (!attackerReady || !defenderReady) return null;

  const snapshot = generatedBattleSnapshot(battle);
  if (!snapshot || !snapshot.generation.scenarioRoll || !snapshot.generation.priorityRoll) {
    throw new Error("Generated campaign battle is missing its locked scenario rules");
  }
  const players = await tx.select().from(campaignPlayersTable)
    .where(eq(campaignPlayersTable.campaignId, campaign.id)) as CampaignPlayerRow[];
  const playerById = new Map<string, CampaignPlayerRow>(players.map((player) => [player.playerId, player]));
  const attacker = playerById.get(battle.attackerPlayerId);
  const defender = playerById.get(battle.defenderPlayerId);
  if (!attacker || !defender) throw new Error("Generated campaign battle is missing a commander");

  const rules = campaignGeneratedEngagementRules({
    scenarioKey: battle.scenarioKey as CampaignScenarioKey,
    priorityLevel: battle.priorityLevel as CampaignPriorityLevel,
    targetName: snapshot.target.name,
  });
  const deploymentConfig = createDeploymentConfig({
    preset: rules.deploymentPreset,
    deploymentDepth: rules.deploymentDepth,
    ambushPlayer: rules.ambushCenterSide === "attacker" ? "challenger" : "opponent",
  });
  const terrainConfig = rules.terrain === "none"
    ? { version: 1 as const, objects: [] }
    : generateTerrainSelectionConfig(deploymentConfig, rules.terrain, rules.terrainCount || 3);
  const stationConfig = {
    version: 1,
    enabled: rules.stations === "enabled",
    objects: [],
  };
  const [game] = await tx.insert(gamesTable).values({
    challengerId: battle.attackerPlayerId,
    opponentId: battle.defenderPlayerId,
    opponentKind: "human",
    challengerName: attacker.displayName,
    opponentName: defender.displayName,
    matchName: battle.name,
    status: "deploying",
    pointLimit: Math.max(snapshot.sideAllocationPoints.attacker, snapshot.sideAllocationPoints.defender) * 100,
    priorityLevel: battle.priorityLevel,
    allocationPoints: Math.max(snapshot.sideAllocationPoints.attacker, snapshot.sideAllocationPoints.defender),
    skybox: rules.skybox,
    visibility: "private",
    allowObservers: true,
    deploymentDepth: rules.deploymentDepth,
    deploymentConfig,
    terrainConfig,
    stationConfig,
    crewQualityMode: "custom",
    campaignId: campaign.id,
    campaignTurnId: turn.id,
    campaignBattleId: battle.id,
    campaignTargetId: battle.targetId,
    campaignScenarioKey: battle.scenarioKey,
    aiState: {},
  }).returning();
  await tx.update(campaignBattlesTable).set({
    tacticalGameId: game.id,
    status: "deployment",
    updatedAt: new Date(),
  }).where(eq(campaignBattlesTable.id, battle.id));
  await tx.insert(campaignLogEntriesTable).values({
    campaignId: campaign.id,
    turnNumber: turn.turnNumber,
    actorPlayerId: null,
    type: "campaign.battle.launched",
    message: `${battle.name ?? `Battle ${battle.id}`} is ready for deployment.`,
    payload: {
      battleId: battle.id,
      tacticalGameId: game.id,
      targetId: battle.targetId,
      scenarioKey: battle.scenarioKey,
      priorityLevel: battle.priorityLevel,
    },
  });
  await syncCampaignBattlePlanningPhase(tx, campaign, turn);
  return game.id;
}

async function advanceCampaignTargetSelection(
  tx: any,
  campaign: CampaignRow,
  turn: CampaignTurnRow,
): Promise<{ completed: boolean; nextIndex: number }> {
  const nextIndex = turn.targetSelectionIndex + 1;
  const completed = nextIndex >= turn.initiativeOrder.length;
  await tx
    .update(campaignTurnsTable)
    .set({
      targetSelectionIndex: nextIndex,
      status: completed ? "generate-scenarios" : "select-targets",
      updatedAt: new Date(),
    })
    .where(eq(campaignTurnsTable.id, turn.id));
  if (completed) {
    await tx
      .update(campaignsTable)
      .set({ phase: "generate-scenarios", updatedAt: new Date() })
      .where(eq(campaignsTable.id, campaign.id));
    await ensureCampaignScenarioBattles(tx, campaign, turn);
  }
  return { completed, nextIndex };
}

router.get("/campaigns", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);

  const memberships = await db
    .select()
    .from(campaignPlayersTable)
    .where(eq(campaignPlayersTable.playerId, userId));
  const memberCampaignIds = memberships.map((membership) => membership.campaignId);
  const memberCampaigns = memberCampaignIds.length > 0
    ? await db
        .select()
        .from(campaignsTable)
        .where(inArray(campaignsTable.id, memberCampaignIds))
        .orderBy(desc(campaignsTable.updatedAt), desc(campaignsTable.id))
    : [];

  const publicOpen = await db
    .select()
    .from(campaignsTable)
    .where(and(eq(campaignsTable.visibility, "public"), eq(campaignsTable.status, "setup")))
    .orderBy(desc(campaignsTable.updatedAt), desc(campaignsTable.id))
    .limit(20);

  const seen = new Set<number>();
  const myCampaigns: unknown[] = [];
  for (const campaign of memberCampaigns) {
    seen.add(campaign.id);
    myCampaigns.push(toCampaignSummary(campaign, await campaignPlayers(campaign.id)));
  }

  const openCampaigns: unknown[] = [];
  for (const campaign of publicOpen) {
    if (seen.has(campaign.id)) continue;
    openCampaigns.push(toCampaignSummary(campaign, await campaignPlayers(campaign.id)));
  }

  res.json({ myCampaigns, openCampaigns });
});

router.post("/campaigns", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const parsed = parseCreateCampaignBody(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const displayName = await currentPlayerName(userId);
  const [campaign] = await db
    .insert(campaignsTable)
    .values({
      ownerPlayerId: userId,
      name: parsed.data.name,
      visibility: parsed.data.visibility,
      variant: parsed.data.variant,
      settings: {
        source: "acta-2e",
        initialFleet: { allocationPoints: 10, priorityLevel: "battle" },
        automation: "campaign-shell",
      },
    })
    .returning();

  await db.insert(campaignPlayersTable).values({
    campaignId: campaign.id,
    playerId: userId,
    displayName,
    faction: parsed.data.faction,
    role: "owner",
    status: "active",
  });
  await appendCampaignLog({
    campaignId: campaign.id,
    actorPlayerId: userId,
    type: "campaign.created",
    message: `${displayName ?? "Commander"} created campaign ${campaign.name}.`,
    payload: { visibility: campaign.visibility, variant: campaign.variant },
  });

  res.status(201).json({ campaign: await campaignDetail(campaign, userId) });
});

router.get("/campaigns/:campaignId", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const params = parseCampaignId(req.params.campaignId);
  if (!params.success) {
    res.status(400).json({ error: params.error });
    return;
  }

  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, params.data))
    .limit(1);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  if (!(await canReadCampaign(campaign, userId))) {
    res.status(403).json({ error: "You do not have access to this campaign" });
    return;
  }

  res.json({ campaign: await campaignDetail(campaign, userId) });
});

router.get("/campaigns/:campaignId/roster", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const params = parseCampaignId(req.params.campaignId);
  if (!params.success) {
    res.status(400).json({ error: params.error });
    return;
  }

  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, params.data))
    .limit(1);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  if (!(await canReadCampaign(campaign, userId))) {
    res.status(403).json({ error: "You do not have access to this campaign" });
    return;
  }

  res.json({ roster: await campaignRoster(campaign.id) });
});

router.post("/campaigns/:campaignId/roster", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const params = parseCampaignId(req.params.campaignId);
  if (!params.success) {
    res.status(400).json({ error: params.error });
    return;
  }
  const parsed = parseCampaignRosterBody(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, params.data))
    .limit(1);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  if (campaign.status !== "setup") {
    res.status(400).json({ error: "Campaign rosters can only be edited during setup" });
    return;
  }

  const membership = await getMembership(campaign.id, userId);
  if (!membership) {
    res.status(403).json({ error: "Join the campaign before adding ships" });
    return;
  }

  const [model] = await db
    .select()
    .from(shipModelsTable)
    .where(eq(shipModelsTable.id, parsed.data.shipModelId))
    .limit(1);
  if (!model) {
    res.status(404).json({ error: "Ship model not found" });
    return;
  }
  const hullMax = Math.max(0, model.hullPoints);
  const crewMax = Math.max(0, model.crew ?? 0);
  const troopsMax = Math.max(0, model.troops ?? 0);
  const [ship] = await db
    .insert(campaignShipInstancesTable)
    .values({
      campaignId: campaign.id,
      ownerPlayerId: userId,
      sourceShipModelId: model.id,
      name: parsed.data.name ?? model.name,
      status: "active",
      hullCurrent: hullMax,
      hullMax,
      crewCurrent: crewMax,
      crewMax,
      troopsCurrent: troopsMax,
      troopsMax,
      crewQuality: 4,
      crewQualityRoll: null,
      crewQualityDice: [],
      carriedFighters: model.smallCraft ? [{ printed: model.smallCraft }] : [],
    })
    .returning();

  await db
    .update(campaignPlayersTable)
    .set({ ready: false, updatedAt: new Date() })
    .where(eq(campaignPlayersTable.id, membership.id));
  await db
    .update(campaignsTable)
    .set({ updatedAt: new Date() })
    .where(eq(campaignsTable.id, campaign.id));
  await appendCampaignLog({
    campaignId: campaign.id,
    actorPlayerId: userId,
    type: "campaign.roster.ship-added",
    message: `${membership.displayName ?? "Commander"} added ${ship.name} to their campaign roster.`,
    payload: {
      shipInstanceId: ship.id,
      shipModelId: model.id,
      sourceName: model.name,
      faction: model.faction,
      priorityLevel: model.priorityLevel,
    },
  });

  const [updated] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaign.id))
    .limit(1);
  res.status(201).json({ campaign: await campaignDetail(updated ?? campaign, userId) });
});

router.delete("/campaigns/:campaignId/roster/:shipInstanceId", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  const shipInstanceId = parseShipInstanceId(req.params.shipInstanceId);
  if (!campaignId.success) {
    res.status(400).json({ error: campaignId.error });
    return;
  }
  if (!shipInstanceId.success) {
    res.status(400).json({ error: shipInstanceId.error });
    return;
  }

  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaignId.data))
    .limit(1);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  if (campaign.status !== "setup") {
    res.status(400).json({ error: "Campaign rosters can only be edited during setup" });
    return;
  }

  const membership = await getMembership(campaign.id, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this campaign" });
    return;
  }

  const [ship] = await db
    .select()
    .from(campaignShipInstancesTable)
    .where(and(
      eq(campaignShipInstancesTable.id, shipInstanceId.data),
      eq(campaignShipInstancesTable.campaignId, campaign.id),
    ))
    .limit(1);
  if (!ship) {
    res.status(404).json({ error: "Campaign ship not found" });
    return;
  }
  if (ship.ownerPlayerId !== userId && membership.role !== "owner") {
    res.status(403).json({ error: "Only the ship owner or campaign owner can remove this roster entry" });
    return;
  }

  await db
    .delete(campaignShipInstancesTable)
    .where(and(
      eq(campaignShipInstancesTable.id, ship.id),
      eq(campaignShipInstancesTable.campaignId, campaign.id),
    ));
  await db
    .update(campaignPlayersTable)
    .set({ ready: false, updatedAt: new Date() })
    .where(and(
      eq(campaignPlayersTable.campaignId, campaign.id),
      eq(campaignPlayersTable.playerId, ship.ownerPlayerId),
    ));
  await db
    .update(campaignsTable)
    .set({ updatedAt: new Date() })
    .where(eq(campaignsTable.id, campaign.id));
  await appendCampaignLog({
    campaignId: campaign.id,
    actorPlayerId: userId,
    type: "campaign.roster.ship-removed",
    message: `${membership.displayName ?? "Commander"} removed ${ship.name} from the campaign roster.`,
    payload: { shipInstanceId: ship.id, shipModelId: ship.sourceShipModelId },
  });

  const [updated] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaign.id))
    .limit(1);
  res.json({ campaign: await campaignDetail(updated ?? campaign, userId) });
});

router.post("/campaigns/:campaignId/setup/crew-quality/roll", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  if (!campaignId.success) {
    res.status(400).json({ error: campaignId.error });
    return;
  }

  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaignId.data))
    .limit(1);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  if (campaign.status !== "setup") {
    res.status(400).json({ error: "Starting Crew Quality can only be generated during setup" });
    return;
  }
  const membership = await getMembership(campaign.id, userId);
  if (!membership || membership.status !== "active") {
    res.status(403).json({ error: "You are not an active commander in this campaign" });
    return;
  }
  if (membership.ready) {
    res.status(400).json({ error: "Unlock your setup before changing Crew Quality" });
    return;
  }

  const crewQualityRolls = await db.transaction(async (tx) => {
    const ships = await tx
      .select()
      .from(campaignShipInstancesTable)
      .where(and(
        eq(campaignShipInstancesTable.campaignId, campaign.id),
        eq(campaignShipInstancesTable.ownerPlayerId, userId),
      ))
      .orderBy(asc(campaignShipInstancesTable.id));
    if (ships.length === 0) {
      throw Object.assign(new Error("Add at least one ship before generating Crew Quality"), { status: 400 });
    }
    const unrolled = ships.filter((ship) => !Number.isInteger(ship.crewQualityRoll));
    const results = unrolled.map((ship) => ({ ship, roll: rollStartingCrewQuality() }));
    for (const result of results) {
      await tx
        .update(campaignShipInstancesTable)
        .set({
          crewQuality: result.roll.score,
          crewQualityRoll: result.roll.total,
          crewQualityDice: result.roll.dice,
          updatedAt: new Date(),
        })
        .where(eq(campaignShipInstancesTable.id, result.ship.id));
    }
    if (results.length > 0) {
      await tx.insert(campaignLogEntriesTable).values({
        campaignId: campaign.id,
        actorPlayerId: userId,
        type: "campaign.setup.crew-quality-rolled",
        message: `${membership.displayName ?? "Commander"} generated starting Crew Quality for ${results.length} ship${results.length === 1 ? "" : "s"}.`,
        payload: {
          rolls: results.map(({ ship, roll }) => ({
            shipInstanceId: ship.id,
            shipName: ship.name,
            dice: roll.dice,
            total: roll.total,
            crewQuality: roll.score,
            label: roll.label,
          })),
        },
      });
    }
    return results.map(({ ship, roll }) => ({
      shipInstanceId: ship.id,
      shipName: ship.name,
      ...roll,
    }));
  });

  const [updated] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaign.id))
    .limit(1);
  res.json({ campaign: await campaignDetail(updated ?? campaign, userId), crewQualityRolls });
});

router.post("/campaigns/:campaignId/setup/crew-quality/swap", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  const parsed = parseCrewQualitySwapBody(req.body ?? {});
  if (!campaignId.success) {
    res.status(400).json({ error: campaignId.error });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaignId.data))
    .limit(1);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  if (campaign.status !== "setup") {
    res.status(400).json({ error: "Crew Quality can only be swapped during setup" });
    return;
  }
  const membership = await getMembership(campaign.id, userId);
  if (!membership || membership.status !== "active") {
    res.status(403).json({ error: "You are not an active commander in this campaign" });
    return;
  }
  if (membership.ready) {
    res.status(400).json({ error: "Unlock your setup before swapping Crew Quality" });
    return;
  }
  if (membership.crewQualitySwapUsed) {
    res.status(400).json({ error: "Your one starting Crew Quality swap has already been used" });
    return;
  }

  const swapResult = await db.transaction(async (tx) => {
    const [claimedSwap] = await tx
      .update(campaignPlayersTable)
      .set({ crewQualitySwapUsed: true, updatedAt: new Date() })
      .where(and(
        eq(campaignPlayersTable.id, membership.id),
        eq(campaignPlayersTable.ready, false),
        eq(campaignPlayersTable.crewQualitySwapUsed, false),
      ))
      .returning();
    if (!claimedSwap) {
      throw Object.assign(new Error("Crew Quality swap is no longer available"), { status: 409 });
    }
    const ships = await tx
      .select()
      .from(campaignShipInstancesTable)
      .where(inArray(campaignShipInstancesTable.id, [
        parsed.data.firstShipInstanceId,
        parsed.data.secondShipInstanceId,
      ]));
    if (ships.length !== 2 || ships.some((ship) => ship.campaignId !== campaign.id)) {
      throw Object.assign(new Error("One or both campaign ships were not found"), { status: 404 });
    }
    if (ships.some((ship) => ship.ownerPlayerId !== userId)) {
      throw Object.assign(new Error("You may only swap Crew Quality between your own ships"), { status: 403 });
    }
    if (ships.some((ship) => !Number.isInteger(ship.crewQualityRoll))) {
      throw Object.assign(new Error("Generate starting Crew Quality for both ships before swapping"), { status: 400 });
    }
    const first = ships.find((ship) => ship.id === parsed.data.firstShipInstanceId)!;
    const second = ships.find((ship) => ship.id === parsed.data.secondShipInstanceId)!;
    await tx
      .update(campaignShipInstancesTable)
      .set({ crewQuality: second.crewQuality, updatedAt: new Date() })
      .where(eq(campaignShipInstancesTable.id, first.id));
    await tx
      .update(campaignShipInstancesTable)
      .set({ crewQuality: first.crewQuality, updatedAt: new Date() })
      .where(eq(campaignShipInstancesTable.id, second.id));
    const payload = {
      firstShipInstanceId: first.id,
      firstShipName: first.name,
      firstCrewQualityBefore: first.crewQuality,
      firstCrewQualityAfter: second.crewQuality,
      secondShipInstanceId: second.id,
      secondShipName: second.name,
      secondCrewQualityBefore: second.crewQuality,
      secondCrewQualityAfter: first.crewQuality,
    };
    await tx.insert(campaignLogEntriesTable).values({
      campaignId: campaign.id,
      actorPlayerId: userId,
      type: "campaign.setup.crew-quality-swapped",
      message: `${membership.displayName ?? "Commander"} used their starting Crew Quality swap between ${first.name} and ${second.name}.`,
      payload,
    });
    return payload;
  });

  res.json({ campaign: await campaignDetail(campaign, userId), crewQualitySwap: swapResult });
});

router.post("/campaigns/:campaignId/setup/initiative-modifier", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  const parsed = parseInitiativeModifierBody(req.body ?? {});
  if (!campaignId.success) {
    res.status(400).json({ error: campaignId.error });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaignId.data))
    .limit(1);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  if (campaign.status !== "setup") {
    res.status(400).json({ error: "Fleet Initiative can only be set during campaign setup" });
    return;
  }
  const membership = await getMembership(campaign.id, userId);
  if (!membership || membership.status !== "active") {
    res.status(403).json({ error: "You are not an active commander in this campaign" });
    return;
  }
  if (membership.ready) {
    res.status(400).json({ error: "Unlock your setup before changing Fleet Initiative" });
    return;
  }

  await db
    .update(campaignPlayersTable)
    .set({ initiativeModifier: parsed.data.initiativeModifier, updatedAt: new Date() })
    .where(eq(campaignPlayersTable.id, membership.id));
  await appendCampaignLog({
    campaignId: campaign.id,
    actorPlayerId: userId,
    type: "campaign.setup.initiative-modifier",
    message: `${membership.displayName ?? "Commander"} set Fleet Initiative to ${parsed.data.initiativeModifier >= 0 ? "+" : ""}${parsed.data.initiativeModifier}.`,
    payload: { initiativeModifier: parsed.data.initiativeModifier },
  });
  res.json({ campaign: await campaignDetail(campaign, userId) });
});

router.post("/campaigns/:campaignId/setup/ready", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  const parsed = parseReadyBody(req.body ?? {});
  if (!campaignId.success) {
    res.status(400).json({ error: campaignId.error });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaignId.data))
    .limit(1);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  if (campaign.status !== "setup") {
    res.status(400).json({ error: "Campaign setup is already locked" });
    return;
  }
  const membership = await getMembership(campaign.id, userId);
  if (!membership || membership.status !== "active") {
    res.status(403).json({ error: "You are not an active commander in this campaign" });
    return;
  }

  if (parsed.data.ready) {
    const roster = await campaignRoster(campaign.id);
    const setup = campaignSetupState(await campaignPlayers(campaign.id), roster);
    const playerSetup = setup.playerStates.find((player) => player.playerId === userId);
    if (!playerSetup?.legal) {
      res.status(400).json({ error: playerSetup?.issues.join(" ") || "Campaign roster is not ready" });
      return;
    }
  }

  await db
    .update(campaignPlayersTable)
    .set({ ready: parsed.data.ready, updatedAt: new Date() })
    .where(eq(campaignPlayersTable.id, membership.id));
  await db
    .update(campaignsTable)
    .set({ updatedAt: new Date() })
    .where(eq(campaignsTable.id, campaign.id));
  await appendCampaignLog({
    campaignId: campaign.id,
    actorPlayerId: userId,
    type: parsed.data.ready ? "campaign.setup.ready" : "campaign.setup.unlocked",
    message: `${membership.displayName ?? "Commander"} ${parsed.data.ready ? "marked their roster ready" : "unlocked their roster for changes"}.`,
  });
  const [updated] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaign.id))
    .limit(1);
  res.json({ campaign: await campaignDetail(updated ?? campaign, userId) });
});

router.post("/campaigns/:campaignId/start", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  if (!campaignId.success) {
    res.status(400).json({ error: campaignId.error });
    return;
  }

  try {
    const startedCampaign = await db.transaction(async (tx) => {
      const [campaign] = await tx
        .select()
        .from(campaignsTable)
        .where(eq(campaignsTable.id, campaignId.data))
        .limit(1);
      if (!campaign) throw Object.assign(new Error("Campaign not found"), { status: 404 });
      if (campaign.ownerPlayerId !== userId) {
        throw Object.assign(new Error("Only the campaign owner can start the campaign"), { status: 403 });
      }
      if (campaign.status !== "setup") {
        throw Object.assign(new Error("Campaign setup has already ended"), { status: 409 });
      }
      const [claimed] = await tx
        .update(campaignsTable)
        .set({ status: "starting", updatedAt: new Date() })
        .where(and(
          eq(campaignsTable.id, campaign.id),
          eq(campaignsTable.status, "setup"),
        ))
        .returning();
      if (!claimed) throw Object.assign(new Error("Campaign start is already in progress"), { status: 409 });

      const players = await tx
        .select()
        .from(campaignPlayersTable)
        .where(eq(campaignPlayersTable.campaignId, campaign.id));
      const roster = await tx
        .select()
        .from(campaignShipInstancesTable)
        .where(eq(campaignShipInstancesTable.campaignId, campaign.id));
      const modelIds = Array.from(new Set(roster.map((ship) => ship.sourceShipModelId)));
      const models = modelIds.length > 0
        ? await tx.select().from(shipModelsTable).where(inArray(shipModelsTable.id, modelIds))
        : [];
      const modelById = new Map(models.map((model) => [model.id, model]));
      const rosterWithModels: CampaignRosterRow[] = roster.map((ship) => ({
        ...ship,
        shipModel: modelById.get(ship.sourceShipModelId) ?? null,
      }));
      const setup = campaignSetupState(players, rosterWithModels);
      if (!setup.canStart) {
        throw Object.assign(new Error(setup.issues.join(" ")), { status: 400 });
      }

      const existingTargets = await tx
        .select({ id: campaignStrategicTargetsTable.id })
        .from(campaignStrategicTargetsTable)
        .where(eq(campaignStrategicTargetsTable.campaignId, campaign.id))
        .limit(1);
      if (existingTargets.length > 0) {
        throw Object.assign(new Error("Campaign strategic targets have already been generated"), { status: 409 });
      }

      const activePlayerCount = players.filter((player) => player.status === "active").length;
      const system = generateCampaignSystem(activePlayerCount);
      await tx.insert(campaignStrategicTargetsTable).values(system.targets.map((target) => ({
        campaignId: campaign.id,
        sequence: target.sequence,
        key: target.key,
        category: target.category,
        subtype: target.subtype,
        name: target.name,
        ownerPlayerId: null,
        rrValue: target.rrValue,
        rrFormula: target.rrFormula,
        explored: target.explored,
        isTradeRoute: target.isTradeRoute,
        categoryRoll: target.categoryRoll,
        subtypeRoll: target.subtypeRoll,
        unusualFeatures: target.unusualFeatures,
        rulesPayload: target.rulesPayload,
      })));

      const [campaignTurn] = await tx
        .insert(campaignTurnsTable)
        .values({
          campaignId: campaign.id,
          turnNumber: 1,
          status: "initiative",
          initiativeOrder: [],
        })
        .returning();
      const startedAt = new Date();
      const [updated] = await tx
        .update(campaignsTable)
        .set({
          status: "active",
          phase: "initiative",
          currentTurn: 1,
          settings: {
            ...campaign.settings,
            setupLockedAt: startedAt.toISOString(),
            campaignMap: {
              targetCountDice: system.targetCountDice,
              baseTargetCount: system.baseTargetCount,
              playerBonusTargets: system.playerBonusTargets,
              strategicTargetCount: system.strategicTargetCount,
              unusualFeatureDie: system.unusualFeatureDie,
              unusualFeatureCount: system.unusualFeatureCount,
            },
          },
          updatedAt: startedAt,
        })
        .where(eq(campaignsTable.id, campaign.id))
        .returning();
      await tx.insert(campaignLogEntriesTable).values({
        campaignId: campaign.id,
        turnNumber: 1,
        actorPlayerId: userId,
        type: "campaign.started",
        message: `${campaign.name} began Campaign Turn 1 with ${system.strategicTargetCount} strategic targets and the Trade Route.`,
        payload: {
          campaignTurnId: campaignTurn.id,
          targetCountDice: system.targetCountDice,
          strategicTargetCount: system.strategicTargetCount,
          unusualFeatureDie: system.unusualFeatureDie,
          unusualFeatureCount: system.unusualFeatureCount,
        },
      });
      return updated ?? campaign;
    });
    res.json({ campaign: await campaignDetail(startedCampaign, userId) });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Campaign could not be started" });
  }
});

router.post("/campaigns/:campaignId/turns/current/initiative-roll", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  if (!campaignId.success) {
    res.status(400).json({ error: campaignId.error });
    return;
  }

  try {
    const campaignRow = await db.transaction(async (tx) => {
      const [campaign] = await tx
        .select()
        .from(campaignsTable)
        .where(eq(campaignsTable.id, campaignId.data))
        .limit(1);
      if (!campaign) throw Object.assign(new Error("Campaign not found"), { status: 404 });
      if (campaign.status !== "active" || campaign.phase !== "initiative" || campaign.currentTurn < 1) {
        throw Object.assign(new Error("Campaign is not currently resolving initiative"), { status: 409 });
      }
      const [membership] = await tx
        .select()
        .from(campaignPlayersTable)
        .where(and(
          eq(campaignPlayersTable.campaignId, campaign.id),
          eq(campaignPlayersTable.playerId, userId),
        ))
        .limit(1);
      if (!membership || membership.status !== "active") {
        throw Object.assign(new Error("You are not an active commander in this campaign"), { status: 403 });
      }
      const [turn] = await tx
        .select()
        .from(campaignTurnsTable)
        .where(and(
          eq(campaignTurnsTable.campaignId, campaign.id),
          eq(campaignTurnsTable.turnNumber, campaign.currentTurn),
        ))
        .limit(1);
      if (!turn) throw Object.assign(new Error("Current campaign turn was not found"), { status: 409 });

      await tx.execute(sql`SELECT id FROM campaign_turns WHERE id = ${turn.id} FOR UPDATE`);
      const [existingRoll] = await tx
        .select()
        .from(campaignInitiativeRollsTable)
        .where(and(
          eq(campaignInitiativeRollsTable.campaignTurnId, turn.id),
          eq(campaignInitiativeRollsTable.playerId, userId),
        ))
        .limit(1);
      if (existingRoll) return campaign;

      const heldTargets = await tx
        .select({ id: campaignStrategicTargetsTable.id })
        .from(campaignStrategicTargetsTable)
        .where(and(
          eq(campaignStrategicTargetsTable.campaignId, campaign.id),
          eq(campaignStrategicTargetsTable.ownerPlayerId, userId),
        ));
      const dice = rollCampaignInitiativeDice();
      const initiativeEntry = {
        playerId: userId,
        dice,
        fleetModifier: membership.initiativeModifier,
        targetPenalty: -heldTargets.length,
      };
      const initialTotal = campaignInitiativeTotal(initiativeEntry);
      await tx.insert(campaignInitiativeRollsTable).values({
        campaignId: campaign.id,
        campaignTurnId: turn.id,
        playerId: userId,
        dice,
        fleetModifier: membership.initiativeModifier,
        targetPenalty: -heldTargets.length,
        initialTotal,
        finalTotal: initialTotal,
        rerolls: [],
      });
      await tx.insert(campaignLogEntriesTable).values({
        campaignId: campaign.id,
        turnNumber: campaign.currentTurn,
        actorPlayerId: userId,
        type: "campaign.initiative.rolled",
        message: `${campaignPlayerLabel(membership)} rolled ${dice[0]} + ${dice[1]} for campaign initiative.`,
        payload: {
          dice,
          fleetModifier: membership.initiativeModifier,
          heldTargetPenalty: -heldTargets.length,
          initialTotal,
        },
      });

      const activePlayers = await tx
        .select()
        .from(campaignPlayersTable)
        .where(and(
          eq(campaignPlayersTable.campaignId, campaign.id),
          eq(campaignPlayersTable.status, "active"),
        ));
      const activeIds = activePlayers.map((player) => player.playerId);
      const initiativeRolls = await tx
        .select()
        .from(campaignInitiativeRollsTable)
        .where(and(
          eq(campaignInitiativeRollsTable.campaignTurnId, turn.id),
          inArray(campaignInitiativeRollsTable.playerId, activeIds),
        ));
      if (initiativeRolls.length < activePlayers.length) return campaign;

      const resolved = resolveCampaignInitiative(initiativeRolls.map((roll) => ({
        playerId: roll.playerId,
        dice: [Number(roll.dice[0]), Number(roll.dice[1])] as [number, number],
        fleetModifier: roll.fleetModifier,
        targetPenalty: roll.targetPenalty,
        rerolls: roll.rerolls.map((reroll) => ({
          dice: [Number(reroll.dice[0]), Number(reroll.dice[1])] as [number, number],
          total: reroll.total,
        })),
      })));
      for (const entry of resolved) {
        await tx
          .update(campaignInitiativeRollsTable)
          .set({ finalTotal: entry.finalTotal, rerolls: entry.rerolls, updatedAt: new Date() })
          .where(and(
            eq(campaignInitiativeRollsTable.campaignTurnId, turn.id),
            eq(campaignInitiativeRollsTable.playerId, entry.playerId),
          ));
      }
      const initiativeOrder = resolved.map((entry) => entry.playerId);
      await tx
        .update(campaignTurnsTable)
        .set({ status: "select-targets", initiativeOrder, targetSelectionIndex: 0, updatedAt: new Date() })
        .where(eq(campaignTurnsTable.id, turn.id));
      const [updatedCampaign] = await tx
        .update(campaignsTable)
        .set({ phase: "select-targets", updatedAt: new Date() })
        .where(eq(campaignsTable.id, campaign.id))
        .returning();
      const playerById = new Map(activePlayers.map((player) => [player.playerId, player]));
      await tx.insert(campaignLogEntriesTable).values({
        campaignId: campaign.id,
        turnNumber: campaign.currentTurn,
        actorPlayerId: null,
        type: "campaign.initiative.resolved",
        message: `Campaign initiative order: ${initiativeOrder.map((id) => campaignPlayerLabel(playerById.get(id))).join(", ")}.`,
        payload: {
          initiativeOrder,
          results: resolved.map((entry) => ({
            playerId: entry.playerId,
            finalTotal: entry.finalTotal,
            rerolls: entry.rerolls,
          })),
        },
      });
      return updatedCampaign ?? campaign;
    });
    res.json({ campaign: await campaignDetail(campaignRow, userId) });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Campaign initiative roll failed" });
  }
});

router.post("/campaigns/:campaignId/turns/current/targets/nominate", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  const parsed = parseTargetNominationBody(req.body ?? {});
  if (!campaignId.success) {
    res.status(400).json({ error: campaignId.error });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const campaignRow = await db.transaction(async (tx) => {
      const [campaign] = await tx.select().from(campaignsTable)
        .where(eq(campaignsTable.id, campaignId.data)).limit(1);
      if (!campaign) throw Object.assign(new Error("Campaign not found"), { status: 404 });
      if (campaign.status !== "active" || campaign.phase !== "select-targets") {
        throw Object.assign(new Error("Campaign is not currently selecting Strategic Targets"), { status: 409 });
      }
      const [membership] = await tx.select().from(campaignPlayersTable).where(and(
        eq(campaignPlayersTable.campaignId, campaign.id),
        eq(campaignPlayersTable.playerId, userId),
      )).limit(1);
      if (!membership || membership.status !== "active") {
        throw Object.assign(new Error("You are not an active commander in this campaign"), { status: 403 });
      }
      let [turn] = await tx.select().from(campaignTurnsTable).where(and(
        eq(campaignTurnsTable.campaignId, campaign.id),
        eq(campaignTurnsTable.turnNumber, campaign.currentTurn),
      )).limit(1);
      if (!turn) throw Object.assign(new Error("Current campaign turn was not found"), { status: 409 });
      await tx.execute(sql`SELECT id FROM campaign_turns WHERE id = ${turn.id} FOR UPDATE`);
      [turn] = await tx.select().from(campaignTurnsTable).where(eq(campaignTurnsTable.id, turn.id)).limit(1);

      const [pendingChallenge] = await tx.select().from(campaignTargetNominationsTable).where(and(
        eq(campaignTargetNominationsTable.campaignTurnId, turn.id),
        eq(campaignTargetNominationsTable.status, "awaiting-challenge"),
      )).limit(1);
      if (pendingChallenge) {
        throw Object.assign(new Error("Resolve the pending Strategic Target challenge first"), { status: 409 });
      }
      const currentNominatorId = turn.initiativeOrder[turn.targetSelectionIndex];
      if (!currentNominatorId) {
        throw Object.assign(new Error("All commanders have already nominated a Strategic Target"), { status: 409 });
      }
      if (currentNominatorId !== userId) {
        throw Object.assign(new Error("It is another commander's turn to nominate a Strategic Target"), { status: 403 });
      }
      const [existingNomination] = await tx.select().from(campaignTargetNominationsTable).where(and(
        eq(campaignTargetNominationsTable.campaignTurnId, turn.id),
        eq(campaignTargetNominationsTable.nominatorPlayerId, userId),
      )).limit(1);
      if (existingNomination) {
        throw Object.assign(new Error("You have already nominated a Strategic Target this turn"), { status: 409 });
      }
      const [target] = await tx.select().from(campaignStrategicTargetsTable).where(and(
        eq(campaignStrategicTargetsTable.id, parsed.data.targetId),
        eq(campaignStrategicTargetsTable.campaignId, campaign.id),
      )).limit(1);
      if (!target) throw Object.assign(new Error("Strategic Target not found"), { status: 404 });
      if (target.ownerPlayerId === userId) {
        throw Object.assign(new Error("You cannot nominate a Strategic Target you already control"), { status: 400 });
      }
      const [alreadyNominated] = await tx.select().from(campaignTargetNominationsTable).where(and(
        eq(campaignTargetNominationsTable.campaignTurnId, turn.id),
        eq(campaignTargetNominationsTable.targetId, target.id),
      )).limit(1);
      if (alreadyNominated) {
        throw Object.assign(new Error("That Strategic Target has already been nominated this turn"), { status: 409 });
      }

      const challengeOrder = target.ownerPlayerId
        ? []
        : campaignChallengeOrder(turn.initiativeOrder, userId);
      const status = target.ownerPlayerId ? "battle-ready" : "awaiting-challenge";
      const [nomination] = await tx.insert(campaignTargetNominationsTable).values({
        campaignId: campaign.id,
        campaignTurnId: turn.id,
        turnNumber: campaign.currentTurn,
        sequence: turn.targetSelectionIndex + 1,
        nominatorPlayerId: userId,
        targetId: target.id,
        targetOwnerPlayerId: target.ownerPlayerId,
        defenderPlayerId: target.ownerPlayerId,
        challengerPlayerId: null,
        challengeOrder,
        challengeIndex: 0,
        declinedPlayerIds: [],
        status,
      }).returning();
      if (status === "battle-ready") {
        await advanceCampaignTargetSelection(tx, campaign, turn);
      }
      await tx.insert(campaignLogEntriesTable).values({
        campaignId: campaign.id,
        turnNumber: campaign.currentTurn,
        actorPlayerId: userId,
        type: "campaign.target.nominated",
        message: `${campaignPlayerLabel(membership)} nominated ${target.name}${target.ownerPlayerId ? " for battle" : " for challenge"}.`,
        payload: {
          nominationId: nomination.id,
          targetId: target.id,
          targetOwnerPlayerId: target.ownerPlayerId,
          challengeOrder,
          status,
        },
      });
      const [updatedCampaign] = await tx.select().from(campaignsTable)
        .where(eq(campaignsTable.id, campaign.id)).limit(1);
      return updatedCampaign ?? campaign;
    });
    res.json({ campaign: await campaignDetail(campaignRow, userId) });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Strategic Target nomination failed" });
  }
});

router.post("/campaigns/:campaignId/turns/current/targets/:nominationId/respond", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  const nominationId = parseNominationId(req.params.nominationId);
  const parsed = parseTargetChallengeBody(req.body ?? {});
  if (!campaignId.success) {
    res.status(400).json({ error: campaignId.error });
    return;
  }
  if (!nominationId.success) {
    res.status(400).json({ error: nominationId.error });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const campaignRow = await db.transaction(async (tx) => {
      const [campaign] = await tx.select().from(campaignsTable)
        .where(eq(campaignsTable.id, campaignId.data)).limit(1);
      if (!campaign) throw Object.assign(new Error("Campaign not found"), { status: 404 });
      if (campaign.status !== "active" || campaign.phase !== "select-targets") {
        throw Object.assign(new Error("Campaign is not currently selecting Strategic Targets"), { status: 409 });
      }
      const [membership] = await tx.select().from(campaignPlayersTable).where(and(
        eq(campaignPlayersTable.campaignId, campaign.id),
        eq(campaignPlayersTable.playerId, userId),
      )).limit(1);
      if (!membership || membership.status !== "active") {
        throw Object.assign(new Error("You are not an active commander in this campaign"), { status: 403 });
      }
      let [turn] = await tx.select().from(campaignTurnsTable).where(and(
        eq(campaignTurnsTable.campaignId, campaign.id),
        eq(campaignTurnsTable.turnNumber, campaign.currentTurn),
      )).limit(1);
      if (!turn) throw Object.assign(new Error("Current campaign turn was not found"), { status: 409 });
      await tx.execute(sql`SELECT id FROM campaign_turns WHERE id = ${turn.id} FOR UPDATE`);
      [turn] = await tx.select().from(campaignTurnsTable).where(eq(campaignTurnsTable.id, turn.id)).limit(1);
      const [nomination] = await tx.select().from(campaignTargetNominationsTable).where(and(
        eq(campaignTargetNominationsTable.id, nominationId.data),
        eq(campaignTargetNominationsTable.campaignTurnId, turn.id),
      )).limit(1);
      if (!nomination) throw Object.assign(new Error("Strategic Target nomination not found"), { status: 404 });
      if (nomination.status !== "awaiting-challenge") {
        throw Object.assign(new Error("This Strategic Target challenge is already resolved"), { status: 409 });
      }
      const expectedChallengerId = nomination.challengeOrder[nomination.challengeIndex];
      if (expectedChallengerId !== userId) {
        throw Object.assign(new Error("It is another commander's turn to answer this challenge"), { status: 403 });
      }
      const [target] = await tx.select().from(campaignStrategicTargetsTable)
        .where(eq(campaignStrategicTargetsTable.id, nomination.targetId)).limit(1);
      if (!target || target.campaignId !== campaign.id) {
        throw Object.assign(new Error("Strategic Target not found"), { status: 404 });
      }

      if (parsed.data.challenge) {
        await tx.update(campaignTargetNominationsTable).set({
          status: "battle-ready",
          challengerPlayerId: userId,
          defenderPlayerId: userId,
          updatedAt: new Date(),
        }).where(eq(campaignTargetNominationsTable.id, nomination.id));
        await advanceCampaignTargetSelection(tx, campaign, turn);
        await tx.insert(campaignLogEntriesTable).values({
          campaignId: campaign.id,
          turnNumber: campaign.currentTurn,
          actorPlayerId: userId,
          type: "campaign.target.challenged",
          message: `${campaignPlayerLabel(membership)} challenged for ${target.name}.`,
          payload: { nominationId: nomination.id, targetId: target.id },
        });
      } else {
        const declinedPlayerIds = [...nomination.declinedPlayerIds, userId];
        const nextChallengeIndex = nomination.challengeIndex + 1;
        const challengesExhausted = nextChallengeIndex >= nomination.challengeOrder.length;
        if (challengesExhausted) {
          await tx.update(campaignTargetNominationsTable).set({
            status: "captured-unopposed",
            challengeIndex: nextChallengeIndex,
            declinedPlayerIds,
            updatedAt: new Date(),
          }).where(eq(campaignTargetNominationsTable.id, nomination.id));
          await tx.update(campaignStrategicTargetsTable).set({
            ownerPlayerId: nomination.nominatorPlayerId,
            updatedAt: new Date(),
          }).where(eq(campaignStrategicTargetsTable.id, target.id));
          const ownershipEventKey = `campaign:${campaign.id}:turn:${campaign.currentTurn}:nomination:${nomination.id}:unopposed`;
          await tx.insert(campaignTargetOwnershipEventsTable).values({
            campaignId: campaign.id,
            campaignTurnId: turn.id,
            turnNumber: campaign.currentTurn,
            targetId: target.id,
            previousOwnerPlayerId: target.ownerPlayerId,
            newOwnerPlayerId: nomination.nominatorPlayerId,
            campaignBattleId: null,
            nominationId: nomination.id,
            eventKey: ownershipEventKey,
            reason: "unopposed-capture",
          }).onConflictDoNothing();
          await insertCampaignLedgerEntry(tx, {
            campaignId: campaign.id,
            campaignTurnId: turn.id,
            turnNumber: campaign.currentTurn,
            playerId: nomination.nominatorPlayerId,
            resource: "rr",
            amount: 10,
            eventKey: `${ownershipEventKey}:rr`,
            type: "campaign.rr.target-captured",
            message: `Captured ${target.name} without a battle: +10 RR.`,
            payload: { targetId: target.id, nominationId: nomination.id },
          });
          await advanceCampaignTargetSelection(tx, campaign, turn);
          await tx.insert(campaignLogEntriesTable).values({
            campaignId: campaign.id,
            turnNumber: campaign.currentTurn,
            actorPlayerId: userId,
            type: "campaign.target.captured-unopposed",
            message: `${target.name} was captured without a battle after every eligible commander declined.`,
            payload: {
              nominationId: nomination.id,
              targetId: target.id,
              ownerPlayerId: nomination.nominatorPlayerId,
              declinedPlayerIds,
            },
          });
        } else {
          await tx.update(campaignTargetNominationsTable).set({
            challengeIndex: nextChallengeIndex,
            declinedPlayerIds,
            updatedAt: new Date(),
          }).where(eq(campaignTargetNominationsTable.id, nomination.id));
          await tx.insert(campaignLogEntriesTable).values({
            campaignId: campaign.id,
            turnNumber: campaign.currentTurn,
            actorPlayerId: userId,
            type: "campaign.target.challenge-declined",
            message: `${campaignPlayerLabel(membership)} declined to challenge for ${target.name}.`,
            payload: {
              nominationId: nomination.id,
              targetId: target.id,
              nextChallengerPlayerId: nomination.challengeOrder[nextChallengeIndex],
            },
          });
        }
      }
      const [updatedCampaign] = await tx.select().from(campaignsTable)
        .where(eq(campaignsTable.id, campaign.id)).limit(1);
      return updatedCampaign ?? campaign;
    });
    res.json({ campaign: await campaignDetail(campaignRow, userId) });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Strategic Target challenge response failed" });
  }
});

router.post("/campaigns/:campaignId/turns/current/scenarios/prepare", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  if (!campaignId.success) {
    res.status(400).json({ error: campaignId.error });
    return;
  }
  try {
    const campaignRow = await db.transaction(async (tx) => {
      const [campaign] = await tx.select().from(campaignsTable)
        .where(eq(campaignsTable.id, campaignId.data)).limit(1);
      if (!campaign) throw Object.assign(new Error("Campaign not found"), { status: 404 });
      if (campaign.status !== "active" || campaign.phase !== "generate-scenarios") {
        throw Object.assign(new Error("Campaign target selection must be complete first"), { status: 409 });
      }
      const [membership] = await tx.select().from(campaignPlayersTable).where(and(
        eq(campaignPlayersTable.campaignId, campaign.id),
        eq(campaignPlayersTable.playerId, userId),
      )).limit(1);
      if (!membership || membership.status !== "active") {
        throw Object.assign(new Error("You are not an active commander in this campaign"), { status: 403 });
      }
      const [turn] = await tx.select().from(campaignTurnsTable).where(and(
        eq(campaignTurnsTable.campaignId, campaign.id),
        eq(campaignTurnsTable.turnNumber, campaign.currentTurn),
      )).limit(1);
      if (!turn) throw Object.assign(new Error("Current campaign turn was not found"), { status: 409 });
      await tx.execute(sql`SELECT id FROM campaign_turns WHERE id = ${turn.id} FOR UPDATE`);
      await ensureCampaignScenarioBattles(tx, campaign, turn);
      const turnBattles = await tx.select({ id: campaignBattlesTable.id }).from(campaignBattlesTable)
        .where(eq(campaignBattlesTable.campaignTurnId, turn.id));
      if (turnBattles.length === 0) {
        await ensureCampaignTurnPlayerStates(tx, campaign, turn);
        await tx.update(campaignTurnsTable).set({ status: "ship-experience", updatedAt: new Date() })
          .where(eq(campaignTurnsTable.id, turn.id));
        await tx.update(campaignsTable).set({ phase: "ship-experience", updatedAt: new Date() })
          .where(eq(campaignsTable.id, campaign.id));
      } else {
        await syncCampaignBattlePlanningPhase(tx, campaign, turn);
      }
      const [updated] = await tx.select().from(campaignsTable)
        .where(eq(campaignsTable.id, campaign.id)).limit(1);
      return updated ?? campaign;
    });
    res.json({ campaign: await campaignDetail(campaignRow, userId) });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Campaign scenario preparation failed" });
  }
});

router.post("/campaigns/:campaignId/battles/:battleId/priority-modifier", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  const battleId = parseBattleId(req.params.battleId);
  const parsed = parsePriorityModifierBody(req.body ?? {});
  if (!campaignId.success) {
    res.status(400).json({ error: campaignId.error });
    return;
  }
  if (!battleId.success) {
    res.status(400).json({ error: battleId.error });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const campaignRow = await db.transaction(async (tx) => {
      const [campaign] = await tx.select().from(campaignsTable)
        .where(eq(campaignsTable.id, campaignId.data)).limit(1);
      if (!campaign) throw Object.assign(new Error("Campaign not found"), { status: 404 });
      let [battle] = await tx.select().from(campaignBattlesTable).where(and(
        eq(campaignBattlesTable.id, battleId.data),
        eq(campaignBattlesTable.campaignId, campaign.id),
      )).limit(1);
      if (!battle) throw Object.assign(new Error("Campaign battle not found"), { status: 404 });
      await tx.execute(sql`SELECT id FROM campaign_battles WHERE id = ${battle.id} FOR UPDATE`);
      [battle] = await tx.select().from(campaignBattlesTable)
        .where(eq(campaignBattlesTable.id, battle.id)).limit(1);
      if (battle.status !== "awaiting-priority-modifiers") {
        throw Object.assign(new Error("Priority modifiers are already resolved for this battle"), { status: 409 });
      }
      if (userId !== battle.attackerPlayerId && userId !== battle.defenderPlayerId) {
        throw Object.assign(new Error("Only the two battle commanders may submit Priority modifiers"), { status: 403 });
      }
      const [existingChoice] = await tx.select().from(campaignBattlePriorityChoicesTable).where(and(
        eq(campaignBattlePriorityChoicesTable.campaignBattleId, battle.id),
        eq(campaignBattlePriorityChoicesTable.playerId, userId),
      )).limit(1);
      if (existingChoice) {
        throw Object.assign(new Error("Your secret Priority modifier is already committed"), { status: 409 });
      }
      await tx.insert(campaignBattlePriorityChoicesTable).values({
        campaignBattleId: battle.id,
        playerId: userId,
        modifier: parsed.data.modifier,
      });

      const choices = await tx.select().from(campaignBattlePriorityChoicesTable)
        .where(eq(campaignBattlePriorityChoicesTable.campaignBattleId, battle.id));
      const attackerChoice = choices.find((choice: CampaignBattlePriorityChoiceRow) => choice.playerId === battle.attackerPlayerId);
      const defenderChoice = choices.find((choice: CampaignBattlePriorityChoiceRow) => choice.playerId === battle.defenderPlayerId);
      const [turn] = await tx.select().from(campaignTurnsTable)
        .where(eq(campaignTurnsTable.id, battle.campaignTurnId ?? 0)).limit(1);
      if (!turn) throw new Error("Campaign battle is missing its campaign turn");

      if (attackerChoice && defenderChoice) {
        const [target] = await tx.select().from(campaignStrategicTargetsTable)
          .where(eq(campaignStrategicTargetsTable.id, battle.targetId ?? 0)).limit(1);
        if (!target || target.campaignId !== campaign.id) {
          throw new Error("Campaign battle is missing its Strategic Target");
        }
        const roster = await campaignRosterForTransaction(tx, campaign.id);
        const carrierReady = (playerId: string) => roster.some((ship) => (
          ship.ownerPlayerId === playerId
          && rosterShipIsAvailableForBattle(ship, turn.turnNumber) === null
          && shipModelHasTwoFlights(ship.shipModel?.smallCraft)
        ));
        const scenarioRoll = resolveCampaignScenario({
          target,
          attackerHasCarrier: carrierReady(battle.attackerPlayerId),
          defenderHasCarrier: carrierReady(battle.defenderPlayerId),
        });
        const priorityRoll = rollCampaignPriority({
          attackerModifier: attackerChoice.modifier,
          defenderModifier: defenderChoice.modifier,
        });
        const scenarioChoiceRequired = scenarioRoll.planetaryAssaultEligible;
        const snapshot = generatedCampaignRulesSnapshot({
          nominationId: battle.nominationId ?? 0,
          target,
          scenarioKey: scenarioRoll.scenarioKey,
          priorityRoll,
          scenarioRoll,
          scenarioChoiceRequired,
        });
        const status = scenarioChoiceRequired
          ? "awaiting-scenario-choice"
          : "awaiting-fleet-assignments";
        await tx.update(campaignBattlesTable).set({
          scenarioKey: scenarioRoll.scenarioKey,
          priorityLevel: priorityRoll.priorityLevel,
          rulesSnapshot: snapshot,
          status,
          updatedAt: new Date(),
        }).where(eq(campaignBattlesTable.id, battle.id));
        await tx.insert(campaignLogEntriesTable).values({
          campaignId: campaign.id,
          turnNumber: turn.turnNumber,
          actorPlayerId: null,
          type: "campaign.scenario.generated",
          message: `${target.name}: ${scenarioRoll.scenarioLabel} at ${priorityRoll.priorityLevel} Priority.`,
          payload: {
            battleId: battle.id,
            targetId: target.id,
            scenarioRoll,
            priorityRoll,
            scenarioChoiceRequired,
          },
        });
      }
      await syncCampaignBattlePlanningPhase(tx, campaign, turn);
      const [updated] = await tx.select().from(campaignsTable)
        .where(eq(campaignsTable.id, campaign.id)).limit(1);
      return updated ?? campaign;
    });
    res.json({ campaign: await campaignDetail(campaignRow, userId) });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Priority modifier submission failed" });
  }
});

router.post("/campaigns/:campaignId/battles/:battleId/scenario-choice", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  const battleId = parseBattleId(req.params.battleId);
  const parsed = parseScenarioChoiceBody(req.body ?? {});
  if (!campaignId.success) {
    res.status(400).json({ error: campaignId.error });
    return;
  }
  if (!battleId.success) {
    res.status(400).json({ error: battleId.error });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const campaignRow = await db.transaction(async (tx) => {
      const [campaign] = await tx.select().from(campaignsTable)
        .where(eq(campaignsTable.id, campaignId.data)).limit(1);
      if (!campaign) throw Object.assign(new Error("Campaign not found"), { status: 404 });
      let [battle] = await tx.select().from(campaignBattlesTable).where(and(
        eq(campaignBattlesTable.id, battleId.data),
        eq(campaignBattlesTable.campaignId, campaign.id),
      )).limit(1);
      if (!battle) throw Object.assign(new Error("Campaign battle not found"), { status: 404 });
      await tx.execute(sql`SELECT id FROM campaign_battles WHERE id = ${battle.id} FOR UPDATE`);
      [battle] = await tx.select().from(campaignBattlesTable)
        .where(eq(campaignBattlesTable.id, battle.id)).limit(1);
      if (battle.status !== "awaiting-scenario-choice") {
        throw Object.assign(new Error("This battle is not awaiting a scenario choice"), { status: 409 });
      }
      if (battle.attackerPlayerId !== userId) {
        throw Object.assign(new Error("Only the attacking commander chooses this scenario"), { status: 403 });
      }
      const snapshot = generatedBattleSnapshot(battle);
      if (!snapshot?.generation.scenarioRoll || !snapshot.generation.priorityRoll
        || !snapshot.generation.scenarioChoiceRequired) {
        throw new Error("Campaign scenario choice data is incomplete");
      }
      const updatedSnapshot = generatedCampaignRulesSnapshot({
        nominationId: battle.nominationId ?? 0,
        target: snapshot.target,
        scenarioKey: parsed.data.scenarioKey,
        priorityRoll: snapshot.generation.priorityRoll,
        scenarioRoll: snapshot.generation.scenarioRoll,
        scenarioChoiceRequired: false,
      });
      await tx.update(campaignBattlesTable).set({
        scenarioKey: parsed.data.scenarioKey,
        rulesSnapshot: updatedSnapshot,
        status: "awaiting-fleet-assignments",
        updatedAt: new Date(),
      }).where(eq(campaignBattlesTable.id, battle.id));
      const [turn] = await tx.select().from(campaignTurnsTable)
        .where(eq(campaignTurnsTable.id, battle.campaignTurnId ?? 0)).limit(1);
      if (!turn) throw new Error("Campaign battle is missing its campaign turn");
      await tx.insert(campaignLogEntriesTable).values({
        campaignId: campaign.id,
        turnNumber: turn.turnNumber,
        actorPlayerId: userId,
        type: "campaign.scenario.chosen",
        message: `${parsed.data.scenarioKey === "planetary-assault" ? "Planetary Assault" : "Supply Ships"} was chosen for ${snapshot.target.name}.`,
        payload: { battleId: battle.id, scenarioKey: parsed.data.scenarioKey },
      });
      await syncCampaignBattlePlanningPhase(tx, campaign, turn);
      const [updated] = await tx.select().from(campaignsTable)
        .where(eq(campaignsTable.id, campaign.id)).limit(1);
      return updated ?? campaign;
    });
    res.json({ campaign: await campaignDetail(campaignRow, userId) });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Campaign scenario choice failed" });
  }
});

router.post("/campaigns/:campaignId/battles/:battleId/assign-fleet", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  const battleId = parseBattleId(req.params.battleId);
  const parsed = parseFleetAssignmentBody(req.body ?? {});
  if (!campaignId.success) {
    res.status(400).json({ error: campaignId.error });
    return;
  }
  if (!battleId.success) {
    res.status(400).json({ error: battleId.error });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const campaignRow = await db.transaction(async (tx) => {
      const [campaign] = await tx.select().from(campaignsTable)
        .where(eq(campaignsTable.id, campaignId.data)).limit(1);
      if (!campaign) throw Object.assign(new Error("Campaign not found"), { status: 404 });
      // Fleet commitments affect a campaign-wide once-per-turn resource. Serialize
      // them on the campaign row so two battles cannot claim the same ship at once.
      await tx.execute(sql`SELECT id FROM campaigns WHERE id = ${campaign.id} FOR UPDATE`);
      let [battle] = await tx.select().from(campaignBattlesTable).where(and(
        eq(campaignBattlesTable.id, battleId.data),
        eq(campaignBattlesTable.campaignId, campaign.id),
      )).limit(1);
      if (!battle) throw Object.assign(new Error("Campaign battle not found"), { status: 404 });
      await tx.execute(sql`SELECT id FROM campaign_battles WHERE id = ${battle.id} FOR UPDATE`);
      [battle] = await tx.select().from(campaignBattlesTable)
        .where(eq(campaignBattlesTable.id, battle.id)).limit(1);
      if (battle.status !== "awaiting-fleet-assignments") {
        throw Object.assign(new Error("This battle is not accepting fleet assignments"), { status: 409 });
      }
      const side = userId === battle.attackerPlayerId
        ? "attacker"
        : userId === battle.defenderPlayerId
          ? "defender"
          : null;
      if (!side) throw Object.assign(new Error("You are not a commander in this battle"), { status: 403 });
      const [existingSideAssignment] = await tx.select().from(campaignBattleShipAssignmentsTable).where(and(
        eq(campaignBattleShipAssignmentsTable.campaignBattleId, battle.id),
        eq(campaignBattleShipAssignmentsTable.side, side),
      )).limit(1);
      if (existingSideAssignment) {
        throw Object.assign(new Error("Your fleet assignment is already locked"), { status: 409 });
      }
      const [turn] = await tx.select().from(campaignTurnsTable)
        .where(eq(campaignTurnsTable.id, battle.campaignTurnId ?? 0)).limit(1);
      if (!turn) throw new Error("Campaign battle is missing its campaign turn");
      const roster = await campaignRosterForTransaction(tx, campaign.id);
      const rosterById = new Map(roster.map((ship) => [ship.id, ship]));
      const selectedShips = parsed.data.shipInstanceIds.map((shipId) => rosterById.get(shipId));
      if (selectedShips.some((ship) => !ship)) {
        throw Object.assign(new Error("One or more selected ships are not in this campaign roster"), { status: 400 });
      }
      const ships = selectedShips as CampaignRosterRow[];
      for (const ship of ships) {
        if (ship.ownerPlayerId !== userId) {
          throw Object.assign(new Error(`${ship.name} does not belong to your campaign fleet`), { status: 403 });
        }
        const unavailableReason = rosterShipIsAvailableForBattle(ship, turn.turnNumber);
        if (unavailableReason) throw Object.assign(new Error(unavailableReason), { status: 400 });
      }

      const existingAssignments = await tx.select().from(campaignBattleShipAssignmentsTable)
        .where(inArray(campaignBattleShipAssignmentsTable.campaignShipInstanceId, parsed.data.shipInstanceIds));
      const priorBattleIds = Array.from(new Set(
        existingAssignments.map((assignment: typeof campaignBattleShipAssignmentsTable.$inferSelect) => assignment.campaignBattleId),
      ));
      if (priorBattleIds.length > 0) {
        const priorBattles = await tx.select().from(campaignBattlesTable)
          .where(inArray(campaignBattlesTable.id, priorBattleIds));
        const sameTurnBattle = priorBattles.find((prior: CampaignBattleRow) => (
          prior.campaignId === campaign.id && prior.turnNumber === turn.turnNumber
        ));
        if (sameTurnBattle) {
          const blockedAssignment = existingAssignments.find(
            (assignment: typeof campaignBattleShipAssignmentsTable.$inferSelect) => assignment.campaignBattleId === sameTurnBattle.id,
          );
          const blockedShip = blockedAssignment ? rosterById.get(blockedAssignment.campaignShipInstanceId) : null;
          throw Object.assign(
            new Error(`${blockedShip?.name ?? "Campaign ship"} is already committed to another battle this turn`),
            { status: 409 },
          );
        }
      }

      validateGeneratedCampaignForce({ battle, side, ships });
      await tx.insert(campaignBattleShipAssignmentsTable).values(ships.map((ship) => ({
        campaignBattleId: battle.id,
        campaignShipInstanceId: ship.id,
        side,
        preBattleSnapshot: campaignShipSnapshot(ship),
      })));
      await tx.update(campaignShipInstancesTable).set({
        usedTurn: turn.turnNumber,
        updatedAt: new Date(),
      }).where(inArray(campaignShipInstancesTable.id, ships.map((ship) => ship.id)));
      await tx.insert(campaignLogEntriesTable).values({
        campaignId: campaign.id,
        turnNumber: turn.turnNumber,
        actorPlayerId: userId,
        type: "campaign.battle.fleet-assigned",
        message: `${campaignPlayerLabel((await tx.select().from(campaignPlayersTable).where(and(
          eq(campaignPlayersTable.campaignId, campaign.id),
          eq(campaignPlayersTable.playerId, userId),
        )).limit(1))[0])} committed ${ships.length} ship${ships.length === 1 ? "" : "s"} to ${battle.name ?? `Battle ${battle.id}`}.`,
        payload: {
          battleId: battle.id,
          side,
          shipInstanceIds: ships.map((ship) => ship.id),
          allocationPoints: campaignBattleSideAllocation(battle, side),
        },
      });
      await launchGeneratedCampaignBattleIfReady(tx, campaign, turn, battle);
      await syncCampaignBattlePlanningPhase(tx, campaign, turn);
      const [updated] = await tx.select().from(campaignsTable)
        .where(eq(campaignsTable.id, campaign.id)).limit(1);
      return updated ?? campaign;
    });
    res.json({ campaign: await campaignDetail(campaignRow, userId) });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Campaign fleet assignment failed" });
  }
});

router.post("/campaigns/:campaignId/battles", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  if (!campaignId.success) {
    res.status(400).json({ error: campaignId.error });
    return;
  }
  const parsed = parseCampaignBattleBody(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaignId.data))
    .limit(1);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  if (campaign.status !== "active") {
    res.status(400).json({ error: "Start the campaign before creating campaign engagements" });
    return;
  }
  const membership = await getMembership(campaign.id, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this campaign" });
    return;
  }
  if (campaign.ownerPlayerId !== userId && membership.role !== "owner") {
    res.status(403).json({ error: "Only the campaign owner can create campaign engagements for now" });
    return;
  }

  try {
    const updatedCampaign = await db.transaction(async (tx) => {
      const players = await tx
        .select()
        .from(campaignPlayersTable)
        .where(eq(campaignPlayersTable.campaignId, campaign.id));
      const playerById = new Map(players.map((player) => [player.playerId, player]));
      const attacker = playerById.get(parsed.data.attackerPlayerId);
      const defender = playerById.get(parsed.data.defenderPlayerId);
      if (!attacker || attacker.status !== "active") {
        throw Object.assign(new Error("Attacker is not an active campaign commander"), { status: 400 });
      }
      if (!defender || defender.status !== "active") {
        throw Object.assign(new Error("Defender is not an active campaign commander"), { status: 400 });
      }

      const allShipIds = [
        ...parsed.data.attackerShipInstanceIds,
        ...parsed.data.defenderShipInstanceIds,
      ];
      const shipRows = await tx
        .select()
        .from(campaignShipInstancesTable)
        .where(inArray(campaignShipInstancesTable.id, allShipIds));
      const shipById = new Map(shipRows.map((ship) => [ship.id, ship]));
      for (const shipId of allShipIds) {
        const ship = shipById.get(shipId);
        if (!ship || ship.campaignId !== campaign.id) {
          throw Object.assign(new Error("One or more campaign ships were not found in this campaign"), { status: 400 });
        }
        if (ship.destroyed || ship.status !== "active") {
          throw Object.assign(new Error(`${ship.name} is not available for battle`), { status: 400 });
        }
        if (ship.capturedByPlayerId) {
          throw Object.assign(new Error(`${ship.name} is captured and cannot be assigned from its original roster`), { status: 400 });
        }
        const turnNumberForAvailability = Math.max(1, campaign.currentTurn || 0);
        if (ship.unavailableUntilTurn > turnNumberForAvailability) {
          throw Object.assign(new Error(`${ship.name} is unavailable until campaign turn ${ship.unavailableUntilTurn}`), { status: 400 });
        }
        if (campaignShipWasUsedThisTurn(ship.usedTurn, turnNumberForAvailability)) {
          throw Object.assign(new Error(`${ship.name} has already been committed during campaign turn ${turnNumberForAvailability}`), { status: 409 });
        }
      }
      for (const shipId of parsed.data.attackerShipInstanceIds) {
        const ship = shipById.get(shipId)!;
        if (ship.ownerPlayerId !== parsed.data.attackerPlayerId) {
          throw Object.assign(new Error(`${ship.name} does not belong to the selected attacker`), { status: 400 });
        }
      }
      for (const shipId of parsed.data.defenderShipInstanceIds) {
        const ship = shipById.get(shipId)!;
        if (ship.ownerPlayerId !== parsed.data.defenderPlayerId) {
          throw Object.assign(new Error(`${ship.name} does not belong to the selected defender`), { status: 400 });
        }
      }

      const existingAssignments = await tx
        .select()
        .from(campaignBattleShipAssignmentsTable)
        .where(inArray(campaignBattleShipAssignmentsTable.campaignShipInstanceId, allShipIds));
      const existingBattleIds = Array.from(new Set(existingAssignments.map((assignment) => assignment.campaignBattleId)));
      if (existingBattleIds.length > 0) {
        const existingBattles = await tx
          .select()
          .from(campaignBattlesTable)
          .where(inArray(campaignBattlesTable.id, existingBattleIds));
        const openBattleIds = new Set(
          existingBattles
            .filter((battle) => battle.campaignId === campaign.id && OPEN_CAMPAIGN_BATTLE_STATUSES.has(battle.status))
            .map((battle) => battle.id),
        );
        const blocked = existingAssignments.find((assignment) => openBattleIds.has(assignment.campaignBattleId));
        if (blocked) {
          const ship = shipById.get(blocked.campaignShipInstanceId);
          throw Object.assign(new Error(`${ship?.name ?? "Campaign ship"} is already assigned to an unresolved campaign battle`), { status: 400 });
        }
      }

      const turnNumber = Math.max(1, campaign.currentTurn || 0);
      let [campaignTurn] = await tx
        .select()
        .from(campaignTurnsTable)
        .where(and(
          eq(campaignTurnsTable.campaignId, campaign.id),
          eq(campaignTurnsTable.turnNumber, turnNumber),
        ))
        .limit(1);
      if (!campaignTurn) {
        [campaignTurn] = await tx
          .insert(campaignTurnsTable)
          .values({
            campaignId: campaign.id,
            turnNumber,
            status: "battle-planning",
          })
          .returning();
      }

      const battleName = parsed.data.name
        ?? `${campaign.name}: ${campaignPlayerLabel(attacker)} vs ${campaignPlayerLabel(defender)}`;
      const rules = parsed.data.rules;
      const rulesSnapshot = campaignRulesSnapshot(rules);
      const deploymentConfig = createDeploymentConfig({
        preset: rules.deploymentPreset,
        deploymentDepth: rules.deploymentDepth,
        ambushPlayer: rules.ambushCenterSide === "attacker" ? "challenger" : "opponent",
      });
      const terrainConfig = rules.terrain === "none"
        ? { version: 1 as const, objects: [] }
        : generateTerrainSelectionConfig(
            deploymentConfig,
            rules.terrain,
            rules.terrainCount || 3,
          );
      const stationConfig = {
        version: 1,
        enabled: rules.stations === "enabled",
        objects: [],
      };
      const [game] = await tx
        .insert(gamesTable)
        .values({
          challengerId: parsed.data.attackerPlayerId,
          opponentId: parsed.data.defenderPlayerId,
          opponentKind: "human",
          challengerName: attacker.displayName,
          opponentName: defender.displayName,
          matchName: battleName,
          status: "deploying",
          pointLimit: rules.allocationPoints * 100,
          priorityLevel: rules.priorityLevel,
          allocationPoints: rules.allocationPoints,
          skybox: rules.skybox,
          visibility: "private",
          allowObservers: true,
          deploymentDepth: rules.deploymentDepth,
          deploymentConfig,
          terrainConfig,
          stationConfig,
          crewQualityMode: "custom",
          campaignId: campaign.id,
          campaignTurnId: campaignTurn.id,
          campaignScenarioKey: rules.scenarioKey,
          aiState: {},
        })
        .returning();
      const [battle] = await tx
        .insert(campaignBattlesTable)
        .values({
          campaignId: campaign.id,
          campaignTurnId: campaignTurn.id,
          turnNumber,
          attackerPlayerId: parsed.data.attackerPlayerId,
          defenderPlayerId: parsed.data.defenderPlayerId,
          tacticalGameId: game.id,
          name: battleName,
          scenarioKey: rules.scenarioKey,
          priorityLevel: rules.priorityLevel,
          rulesSnapshot,
          status: "deployment",
        })
        .returning();

      await tx
        .update(gamesTable)
        .set({
          campaignBattleId: battle.id,
        })
        .where(eq(gamesTable.id, game.id));

      const assignmentRows = [
        ...parsed.data.attackerShipInstanceIds.map((shipInstanceId) => ({
          campaignBattleId: battle.id,
          campaignShipInstanceId: shipInstanceId,
          side: "attacker",
          preBattleSnapshot: campaignShipSnapshot(shipById.get(shipInstanceId)!),
        })),
        ...parsed.data.defenderShipInstanceIds.map((shipInstanceId) => ({
          campaignBattleId: battle.id,
          campaignShipInstanceId: shipInstanceId,
          side: "defender",
          preBattleSnapshot: campaignShipSnapshot(shipById.get(shipInstanceId)!),
        })),
      ];
      await tx.insert(campaignBattleShipAssignmentsTable).values(assignmentRows);
      await tx.update(campaignShipInstancesTable).set({
        usedTurn: turnNumber,
        updatedAt: new Date(),
      }).where(inArray(campaignShipInstancesTable.id, allShipIds));

      await tx
        .update(campaignsTable)
        .set({
          status: campaign.status === "setup" ? "active" : campaign.status,
          phase: "tactical-battles",
          currentTurn: turnNumber,
          updatedAt: new Date(),
        })
        .where(eq(campaignsTable.id, campaign.id));
      await tx.insert(campaignLogEntriesTable).values({
        campaignId: campaign.id,
        turnNumber,
        actorPlayerId: userId,
        type: "campaign.battle.created",
        message: `Campaign engagement created: ${battleName}.`,
        payload: {
          battleId: battle.id,
          tacticalGameId: game.id,
          scenarioKey: rules.scenarioKey,
          priorityLevel: rules.priorityLevel,
          allocationPoints: rules.allocationPoints,
          rulesSnapshot,
          attackerShipInstanceIds: parsed.data.attackerShipInstanceIds,
          defenderShipInstanceIds: parsed.data.defenderShipInstanceIds,
        },
      });

      const [updated] = await tx
        .select()
        .from(campaignsTable)
        .where(eq(campaignsTable.id, campaign.id))
        .limit(1);
      return updated ?? campaign;
    });

    res.status(201).json({ campaign: await campaignDetail(updatedCampaign, userId) });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Campaign battle creation failed" });
  }
});

router.post("/campaigns/:campaignId/battles/:battleId/import-result", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  const battleId = parseBattleId(req.params.battleId);
  if (!campaignId.success) {
    res.status(400).json({ error: campaignId.error });
    return;
  }
  if (!battleId.success) {
    res.status(400).json({ error: battleId.error });
    return;
  }

  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaignId.data))
    .limit(1);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  const membership = await getMembership(campaign.id, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this campaign" });
    return;
  }
  if (campaign.ownerPlayerId !== userId && membership.role !== "owner") {
    res.status(403).json({ error: "Only the campaign owner can import battle results for now" });
    return;
  }

  try {
    const importSummary = await db.transaction(async (tx) => {
      const [battle] = await tx
        .select()
        .from(campaignBattlesTable)
        .where(and(
          eq(campaignBattlesTable.id, battleId.data),
          eq(campaignBattlesTable.campaignId, campaign.id),
        ))
        .limit(1);
      if (!battle) {
        throw Object.assign(new Error("Campaign battle not found"), { status: 404 });
      }
      if (battle.status === "imported") {
        return {
          alreadyImported: true,
          battleId: battle.id,
          tacticalGameId: battle.tacticalGameId,
          shipResults: [],
        };
      }
      if (!battle.tacticalGameId) {
        throw Object.assign(new Error("Campaign battle has no linked tactical game"), { status: 400 });
      }

      const [game] = await tx
        .select()
        .from(gamesTable)
        .where(eq(gamesTable.id, battle.tacticalGameId))
        .limit(1);
      if (!game || game.campaignId !== campaign.id || game.campaignBattleId !== battle.id) {
        throw Object.assign(new Error("Linked tactical game does not match this campaign battle"), { status: 400 });
      }
      if (game.status !== "completed") {
        throw Object.assign(new Error("The tactical game must be completed before importing campaign results"), { status: 400 });
      }

      const assignments = await tx
        .select()
        .from(campaignBattleShipAssignmentsTable)
        .where(eq(campaignBattleShipAssignmentsTable.campaignBattleId, battle.id))
        .orderBy(asc(campaignBattleShipAssignmentsTable.side), asc(campaignBattleShipAssignmentsTable.id));
      if (assignments.length === 0) {
        throw Object.assign(new Error("Campaign battle has no assigned roster ships"), { status: 400 });
      }

      const campaignShipIds = assignments.map((assignment) => assignment.campaignShipInstanceId);
      const campaignShips = await tx
        .select()
        .from(campaignShipInstancesTable)
        .where(inArray(campaignShipInstancesTable.id, campaignShipIds));
      const sourceModelIds = Array.from(new Set(campaignShips.map((ship) => ship.sourceShipModelId)));
      const campaignModels = sourceModelIds.length > 0
        ? await tx.select().from(shipModelsTable).where(inArray(shipModelsTable.id, sourceModelIds))
        : [];
      const [turn] = await tx.select().from(campaignTurnsTable).where(and(
        eq(campaignTurnsTable.campaignId, campaign.id),
        eq(campaignTurnsTable.turnNumber, battle.turnNumber),
      )).limit(1);
      if (!turn) {
        throw Object.assign(new Error("Campaign turn for this battle was not found"), { status: 409 });
      }
      const campaignShipById = new Map(campaignShips.map((ship) => [ship.id, ship]));
      const tacticalUnits = await tx
        .select()
        .from(gameUnitsTable)
        .where(eq(gameUnitsTable.gameId, game.id));
      const unitByCampaignShipId = new Map<number, TacticalUnitRow>();
      for (const unit of tacticalUnits as TacticalUnitRow[]) {
        if (unit.campaignShipInstanceId) {
          unitByCampaignShipId.set(unit.campaignShipInstanceId, unit);
        }
      }

      const assignedUnitIds = assignments
        .map((assignment) => unitByCampaignShipId.get(assignment.campaignShipInstanceId)?.id ?? assignment.tacticalGameUnitId ?? null)
        .filter((id): id is number => Number.isInteger(id));
      const criticalRows = assignedUnitIds.length > 0
        ? await tx
            .select()
            .from(unitCriticalEffectsTable)
            .where(inArray(unitCriticalEffectsTable.gameUnitId, assignedUnitIds))
        : [];
      const criticalsByUnitId = new Map<number, UnitCriticalEffectRow[]>();
      for (const effect of criticalRows as UnitCriticalEffectRow[]) {
        const list = criticalsByUnitId.get(effect.gameUnitId) ?? [];
        list.push(effect);
        criticalsByUnitId.set(effect.gameUnitId, list);
      }

      const shipResults: Array<Record<string, unknown>> = [];
      for (const assignment of assignments) {
        const campaignShip = campaignShipById.get(assignment.campaignShipInstanceId);
        if (!campaignShip) {
          throw Object.assign(new Error("An assigned campaign ship no longer exists"), { status: 400 });
        }
        const unit = unitByCampaignShipId.get(assignment.campaignShipInstanceId);
        if (!unit) {
          throw Object.assign(new Error(`${campaignShip.name} was assigned but never deployed in the tactical game`), { status: 400 });
        }

        const criticalEffects = criticalsByUnitId.get(unit.id) ?? [];
        const status = campaignStatusFromTacticalUnit(unit);
        const destroyed = status === "destroyed";
        const capturedByPlayerId = unit.capturedByOwnerId ?? unit.surrenderedToOwnerId ?? null;
        const hullCurrent = clampCampaignTrack(unit.hullPoints, campaignShip.hullMax);
        const crewCurrent = clampCampaignTrack(unit.crewPoints, campaignShip.crewMax);
        const troopsCurrent = clampCampaignTrack(unit.troopPoints, campaignShip.troopsMax);
        const postBattleSnapshot = campaignPostBattleSnapshot(unit, criticalEffects);

        await tx
          .update(campaignShipInstancesTable)
          .set({
            status,
            hullCurrent,
            crewCurrent,
            troopsCurrent,
            crewQuality: unit.crewQuality,
            carriedFighters: unit.carriedFighters ?? [],
            criticalEffects: criticalEffects.map(campaignCriticalSnapshot),
            usedTurn: battle.turnNumber,
            destroyed,
            capturedByPlayerId,
            updatedAt: new Date(),
          })
          .where(and(
            eq(campaignShipInstancesTable.id, campaignShip.id),
            eq(campaignShipInstancesTable.campaignId, campaign.id),
          ));

        await tx
          .update(campaignBattleShipAssignmentsTable)
          .set({
            tacticalGameUnitId: unit.id,
            tacticalShipId: unit.shipId,
            postBattleSnapshot,
          })
          .where(eq(campaignBattleShipAssignmentsTable.id, assignment.id));

        shipResults.push({
          campaignShipInstanceId: campaignShip.id,
          tacticalGameUnitId: unit.id,
          name: campaignShip.name,
          side: assignment.side,
          status,
          hullCurrent,
          hullMax: campaignShip.hullMax,
          crewCurrent,
          crewMax: campaignShip.crewMax,
          troopsCurrent,
          troopsMax: campaignShip.troopsMax,
          criticalCount: criticalEffects.length,
          capturedByPlayerId,
          summary: campaignImportSummaryLine({
            shipName: campaignShip.name,
            status,
            hullCurrent,
            hullMax: campaignShip.hullMax,
            crewCurrent,
            crewMax: campaignShip.crewMax,
            troopsCurrent,
            troopsMax: campaignShip.troopsMax,
          }),
        });
      }

      const resultPayload = {
        importedAt: new Date().toISOString(),
        importedBy: userId,
        tacticalGameId: game.id,
        winnerId: game.winnerId,
        shipResults,
      };
      await tx
        .update(campaignBattlesTable)
        .set({
          status: "imported",
          resultPayload,
          updatedAt: new Date(),
        })
        .where(eq(campaignBattlesTable.id, battle.id));
      await awardCampaignBattleXp(tx, {
        campaign,
        turn,
        battle,
        game,
        assignments,
        campaignShips,
        tacticalUnits: tacticalUnits as TacticalUnitRow[],
        models: campaignModels as ShipModelRow[],
      });
      await resolveCampaignBattleOutcome(tx, { campaign, turn, battle, game });
      const advancedToExperience = await maybeAdvanceCampaignToExperience(tx, campaign, turn);
      if (!advancedToExperience) {
        await tx.update(campaignsTable).set({ phase: "tactical-battles", updatedAt: new Date() })
          .where(eq(campaignsTable.id, campaign.id));
      }
      await tx.insert(campaignLogEntriesTable).values({
        campaignId: campaign.id,
        turnNumber: battle.turnNumber,
        actorPlayerId: userId,
        type: "campaign.battle.imported",
        message: `Imported results for ${battle.name ?? `battle ${battle.id}`}.`,
        payload: resultPayload,
      });

      return {
        alreadyImported: false,
        battleId: battle.id,
        tacticalGameId: game.id,
        winnerId: game.winnerId,
        shipResults,
      };
    });

    const [updated] = await db
      .select()
      .from(campaignsTable)
      .where(eq(campaignsTable.id, campaign.id))
      .limit(1);
    res.json({ campaign: await campaignDetail(updated ?? campaign, userId), importSummary });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Campaign battle result import failed" });
  }
});

router.post("/campaigns/:campaignId/turns/current/experience/crew-quality", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  const parsed = parseResolutionShipBody(req.body ?? {});
  if (!campaignId.success) { res.status(400).json({ error: campaignId.error }); return; }
  if (!parsed.success) { res.status(400).json({ error: parsed.error }); return; }
  try {
    const result = await db.transaction(async (tx) => {
      const context = await campaignResolutionContext(tx, campaignId.data, userId, "ship-experience");
      const ship = await ownedCampaignShip(tx, context.campaign.id, userId, parsed.data.shipInstanceId);
      assertCampaignShipCanBeMaintained(ship);
      if (ship.crewQualityAttemptedTurn === context.turn.turnNumber) {
        throw Object.assign(new Error("This ship has already attempted a Crew Quality increase this turn"), { status: 409 });
      }
      if (ship.xpDice < 1) throw Object.assign(new Error("This ship has no XP dice to spend"), { status: 400 });
      if (ship.crewQuality >= 6) throw Object.assign(new Error("This ship already has maximum Crew Quality"), { status: 400 });
      const roll = rollCampaignDice(1)[0] ?? 1;
      const success = roll > ship.crewQuality;
      const eventKey = `campaign:${context.campaign.id}:turn:${context.turn.turnNumber}:ship:${ship.id}:cq-attempt`;
      const inserted = await insertCampaignLedgerEntry(tx, {
        campaignId: context.campaign.id,
        campaignTurnId: context.turn.id,
        turnNumber: context.turn.turnNumber,
        playerId: userId,
        campaignShipInstanceId: ship.id,
        resource: "xp-dice",
        amount: -1,
        eventKey,
        type: "campaign.xp.crew-quality-attempt",
        message: `${ship.name} spent 1 XP die on Crew Quality and rolled ${roll}${success ? ", succeeding" : ", failing"}.`,
        payload: { roll, target: ship.crewQuality + 1, success },
      });
      if (!inserted) throw Object.assign(new Error("This Crew Quality attempt was already resolved"), { status: 409 });
      await tx.update(campaignShipInstancesTable).set({
        xpDice: ship.xpDice - 1,
        crewQuality: success ? ship.crewQuality + 1 : ship.crewQuality,
        crewQualityAttemptedTurn: context.turn.turnNumber,
        updatedAt: new Date(),
      }).where(eq(campaignShipInstancesTable.id, ship.id));
      return { campaign: context.campaign, roll, success, crewQuality: success ? ship.crewQuality + 1 : ship.crewQuality };
    });
    const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, result.campaign.id)).limit(1);
    res.json({ campaign: await campaignDetail(campaign ?? result.campaign, userId), result: { roll: result.roll, success: result.success, crewQuality: result.crewQuality } });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Crew Quality attempt failed" });
  }
});

router.post("/campaigns/:campaignId/turns/current/experience/repair-hull", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  const parsed = parseExperienceRepairBody(req.body ?? {});
  if (!campaignId.success) { res.status(400).json({ error: campaignId.error }); return; }
  if (!parsed.success) { res.status(400).json({ error: parsed.error }); return; }
  try {
    const result = await db.transaction(async (tx) => {
      const context = await campaignResolutionContext(tx, campaignId.data, userId, "ship-experience");
      const ship = await ownedCampaignShip(tx, context.campaign.id, userId, parsed.data.shipInstanceId);
      assertCampaignShipCanBeMaintained(ship);
      if (ship.xpDice < parsed.data.dice) throw Object.assign(new Error("This ship does not have that many XP dice"), { status: 400 });
      if (ship.hullCurrent >= ship.hullMax) throw Object.assign(new Error("This ship has no hull damage to repair"), { status: 400 });
      const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.sourceShipModelId)).limit(1);
      if (model?.damageThreshold && ship.hullCurrent <= model.damageThreshold) {
        throw Object.assign(new Error("Crippled ships cannot repair hull with Experience dice"), { status: 400 });
      }
      const dice = rollCampaignDice(parsed.data.dice);
      const repairRolled = dice.reduce((sum, value) => sum + value, 0) * 3;
      const hullAfter = Math.min(ship.hullMax, ship.hullCurrent + repairRolled);
      await insertCampaignLedgerEntry(tx, {
        campaignId: context.campaign.id,
        campaignTurnId: context.turn.id,
        turnNumber: context.turn.turnNumber,
        playerId: userId,
        campaignShipInstanceId: ship.id,
        resource: "xp-dice",
        amount: -parsed.data.dice,
        eventKey: `campaign:${context.campaign.id}:turn:${context.turn.turnNumber}:ship:${ship.id}:xp-repair:${Date.now()}:${Math.random()}`,
        type: "campaign.xp.hull-repair",
        message: `${ship.name} spent ${parsed.data.dice} XP dice and repaired ${hullAfter - ship.hullCurrent} hull.`,
        payload: { dice, repairRolled, hullBefore: ship.hullCurrent, hullAfter },
      });
      await tx.update(campaignShipInstancesTable).set({
        xpDice: ship.xpDice - parsed.data.dice,
        hullCurrent: hullAfter,
        updatedAt: new Date(),
      }).where(eq(campaignShipInstancesTable.id, ship.id));
      return { campaign: context.campaign, dice, repairRolled, hullAfter };
    });
    const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, result.campaign.id)).limit(1);
    res.json({ campaign: await campaignDetail(campaign ?? result.campaign, userId), result: { dice: result.dice, repairRolled: result.repairRolled, hullAfter: result.hullAfter } });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Experience repair failed" });
  }
});

router.post("/campaigns/:campaignId/turns/current/experience/complete", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  if (!campaignId.success) { res.status(400).json({ error: campaignId.error }); return; }
  try {
    const campaignRow = await db.transaction(async (tx) => {
      const context = await campaignResolutionContext(tx, campaignId.data, userId, "ship-experience");
      await tx.update(campaignTurnPlayerStatesTable).set({ experienceComplete: true, updatedAt: new Date() })
        .where(eq(campaignTurnPlayerStatesTable.id, context.playerState.id));
      const states = await tx.select().from(campaignTurnPlayerStatesTable)
        .where(eq(campaignTurnPlayerStatesTable.campaignTurnId, context.turn.id));
      if (states.length > 0 && states.every((state) => state.experienceComplete)) {
        await generateCampaignRrIncome(tx, context.campaign, context.turn);
      }
      const [updated] = await tx.select().from(campaignsTable).where(eq(campaignsTable.id, context.campaign.id)).limit(1);
      return updated ?? context.campaign;
    });
    res.json({ campaign: await campaignDetail(campaignRow, userId) });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Ship Experience could not be completed" });
  }
});

router.post("/campaigns/:campaignId/turns/current/repairs/hull", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  const parsed = parseResolutionShipBody(req.body ?? {});
  if (!campaignId.success) { res.status(400).json({ error: campaignId.error }); return; }
  if (!parsed.success) { res.status(400).json({ error: parsed.error }); return; }
  try {
    const result = await db.transaction(async (tx) => {
      const context = await campaignResolutionContext(tx, campaignId.data, userId, "repairs-reinforcements");
      const ship = await ownedCampaignShip(tx, context.campaign.id, userId, parsed.data.shipInstanceId);
      assertCampaignShipCanBeMaintained(ship);
      const missingHull = ship.hullMax - ship.hullCurrent;
      if (missingHull <= 0) throw Object.assign(new Error("This ship has no hull damage to repair"), { status: 400 });
      const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, ship.sourceShipModelId)).limit(1);
      const [spaceDocks] = await tx.select({ id: campaignStrategicTargetsTable.id }).from(campaignStrategicTargetsTable).where(and(
        eq(campaignStrategicTargetsTable.campaignId, context.campaign.id),
        eq(campaignStrategicTargetsTable.ownerPlayerId, userId),
        eq(campaignStrategicTargetsTable.subtype, "space-docks"),
      )).limit(1);
      const cost = campaignHullRepairCost({
        missingHull,
        crippled: Boolean(model?.damageThreshold && ship.hullCurrent <= model.damageThreshold),
        crippledPremiumPaid: ship.crippledRepairPaidTurn === context.turn.turnNumber,
        hasSpaceDocks: Boolean(spaceDocks),
      });
      const balance = await campaignRrBalance(tx, context.campaign.id, userId);
      if (balance < cost.total) throw Object.assign(new Error(`Repair requires ${cost.total} RR; you have ${balance}`), { status: 400 });
      await insertCampaignLedgerEntry(tx, {
        campaignId: context.campaign.id,
        campaignTurnId: context.turn.id,
        turnNumber: context.turn.turnNumber,
        playerId: userId,
        campaignShipInstanceId: ship.id,
        resource: "rr",
        amount: -cost.total,
        eventKey: `campaign:${context.campaign.id}:turn:${context.turn.turnNumber}:ship:${ship.id}:rr-hull:${Date.now()}`,
        type: "campaign.rr.hull-repair",
        message: `${ship.name} repaired ${missingHull} hull for ${cost.total} RR.`,
        payload: { ...cost, missingHull, usedSpaceDocks: Boolean(spaceDocks) },
      });
      await tx.update(campaignShipInstancesTable).set({
        hullCurrent: ship.hullMax,
        status: ship.crewMax > 0 && ship.crewCurrent <= 0 ? "adrift" : "active",
        crippledRepairPaidTurn: cost.crippledPremium > 0 ? context.turn.turnNumber : ship.crippledRepairPaidTurn,
        updatedAt: new Date(),
      }).where(eq(campaignShipInstancesTable.id, ship.id));
      return { campaign: context.campaign, cost: cost.total };
    });
    const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, result.campaign.id)).limit(1);
    res.json({ campaign: await campaignDetail(campaign ?? result.campaign, userId), result: { cost: result.cost } });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Hull repair failed" });
  }
});

router.post("/campaigns/:campaignId/turns/current/repairs/critical", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  const parsed = parseCriticalRepairBody(req.body ?? {});
  if (!campaignId.success) { res.status(400).json({ error: campaignId.error }); return; }
  if (!parsed.success) { res.status(400).json({ error: parsed.error }); return; }
  try {
    const campaignRow = await db.transaction(async (tx) => {
      const context = await campaignResolutionContext(tx, campaignId.data, userId, "repairs-reinforcements");
      const ship = await ownedCampaignShip(tx, context.campaign.id, userId, parsed.data.shipInstanceId);
      assertCampaignShipCanBeMaintained(ship);
      const criticals = ship.criticalEffects as Array<Record<string, unknown>>;
      const critical = criticals[parsed.data.criticalIndex];
      if (!critical) throw Object.assign(new Error("Critical effect was not found"), { status: 404 });
      const cost = campaignCriticalRepairCost(critical.location);
      const balance = await campaignRrBalance(tx, context.campaign.id, userId);
      if (balance < cost) throw Object.assign(new Error(`Critical repair requires ${cost} RR; you have ${balance}`), { status: 400 });
      await insertCampaignLedgerEntry(tx, {
        campaignId: context.campaign.id,
        campaignTurnId: context.turn.id,
        turnNumber: context.turn.turnNumber,
        playerId: userId,
        campaignShipInstanceId: ship.id,
        resource: "rr",
        amount: -cost,
        eventKey: `campaign:${context.campaign.id}:turn:${context.turn.turnNumber}:ship:${ship.id}:critical:${parsed.data.criticalIndex}:${Date.now()}`,
        type: "campaign.rr.critical-repair",
        message: `${ship.name} repaired ${String(critical.name ?? "a critical effect")} for ${cost} RR.`,
        payload: { critical, cost },
      });
      await tx.update(campaignShipInstancesTable).set({
        criticalEffects: criticals.filter((_, index) => index !== parsed.data.criticalIndex),
        updatedAt: new Date(),
      }).where(eq(campaignShipInstancesTable.id, ship.id));
      return context.campaign;
    });
    const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaignRow.id)).limit(1);
    res.json({ campaign: await campaignDetail(campaign ?? campaignRow, userId) });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Critical repair failed" });
  }
});

router.post("/campaigns/:campaignId/turns/current/repairs/recruit", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  const parsed = parseRecruitBody(req.body ?? {});
  if (!campaignId.success) { res.status(400).json({ error: campaignId.error }); return; }
  if (!parsed.success) { res.status(400).json({ error: parsed.error }); return; }
  try {
    const campaignRow = await db.transaction(async (tx) => {
      const context = await campaignResolutionContext(tx, campaignId.data, userId, "repairs-reinforcements");
      const ship = await ownedCampaignShip(tx, context.campaign.id, userId, parsed.data.shipInstanceId);
      assertCampaignShipCanBeMaintained(ship);
      const current = parsed.data.track === "crew" ? ship.crewCurrent : ship.troopsCurrent;
      const max = parsed.data.track === "crew" ? ship.crewMax : ship.troopsMax;
      const missing = max - current;
      if (missing <= 0) throw Object.assign(new Error(`${parsed.data.track === "crew" ? "Crew" : "Troops"} are already full`), { status: 400 });
      const replacingZeroCrew = parsed.data.track === "crew" && current <= 0;
      if (replacingZeroCrew) {
        const assignments = await tx.select().from(campaignBattleShipAssignmentsTable).where(
          eq(campaignBattleShipAssignmentsTable.campaignShipInstanceId, ship.id),
        );
        const battleIds = assignments.map((assignment: typeof campaignBattleShipAssignmentsTable.$inferSelect) => assignment.campaignBattleId);
        const battles = battleIds.length > 0
          ? await tx.select().from(campaignBattlesTable).where(inArray(campaignBattlesTable.id, battleIds))
          : [];
        const recoveredByVictory = battles.some((battle: CampaignBattleRow) =>
          battle.turnNumber === context.turn.turnNumber
          && (battle.resultPayload as Record<string, unknown>).winnerId === userId
        );
        if (!recoveredByVictory) {
          throw Object.assign(new Error("A zero-crew ship can only be recovered when its roster owner won that battle"), { status: 400 });
        }
      }
      const replacementCrewQuality = replacingZeroCrew ? rollStartingCrewQuality() : null;
      const cost = campaignCrewRepairCost(missing);
      const balance = await campaignRrBalance(tx, context.campaign.id, userId);
      if (balance < cost) throw Object.assign(new Error(`Recruiting requires ${cost} RR; you have ${balance}`), { status: 400 });
      await insertCampaignLedgerEntry(tx, {
        campaignId: context.campaign.id,
        campaignTurnId: context.turn.id,
        turnNumber: context.turn.turnNumber,
        playerId: userId,
        campaignShipInstanceId: ship.id,
        resource: "rr",
        amount: -cost,
        eventKey: `campaign:${context.campaign.id}:turn:${context.turn.turnNumber}:ship:${ship.id}:${parsed.data.track}:${Date.now()}`,
        type: `campaign.rr.${parsed.data.track}-recruitment`,
        message: replacementCrewQuality
          ? `${ship.name} received a replacement crew at CQ ${replacementCrewQuality.score} for ${cost} RR.`
          : `${ship.name} restored ${missing} ${parsed.data.track} for ${cost} RR.`,
        payload: { track: parsed.data.track, missing, cost, replacementCrewQuality },
      });
      await tx.update(campaignShipInstancesTable).set({
        ...(parsed.data.track === "crew" ? {
          crewCurrent: ship.crewMax,
          ...(replacementCrewQuality ? {
            crewQuality: replacementCrewQuality.score,
            crewQualityRoll: replacementCrewQuality.total,
            crewQualityDice: replacementCrewQuality.dice,
          } : {}),
        } : { troopsCurrent: ship.troopsMax }),
        status: ship.hullCurrent > 0
          && (parsed.data.track === "crew" ? ship.crewMax > 0 : ship.crewCurrent > 0)
          ? "active"
          : ship.status,
        updatedAt: new Date(),
      }).where(eq(campaignShipInstancesTable.id, ship.id));
      return context.campaign;
    });
    const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaignRow.id)).limit(1);
    res.json({ campaign: await campaignDetail(campaign ?? campaignRow, userId) });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Recruitment failed" });
  }
});

router.post("/campaigns/:campaignId/turns/current/repairs/high-command", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  const parsed = parseResolutionShipBody(req.body ?? {});
  if (!campaignId.success) { res.status(400).json({ error: campaignId.error }); return; }
  if (!parsed.success) { res.status(400).json({ error: parsed.error }); return; }
  try {
    const campaignRow = await db.transaction(async (tx) => {
      const context = await campaignResolutionContext(tx, campaignId.data, userId, "repairs-reinforcements");
      const ship = await ownedCampaignShip(tx, context.campaign.id, userId, parsed.data.shipInstanceId);
      assertCampaignShipCanBeMaintained(ship);
      if (ship.hullCurrent >= ship.hullMax && ship.crewCurrent >= ship.crewMax && ship.troopsCurrent >= ship.troopsMax && ship.criticalEffects.length === 0) {
        throw Object.assign(new Error("This ship does not require High Command repairs"), { status: 400 });
      }
      await tx.update(campaignShipInstancesTable).set({
        status: "high-command-repair",
        unavailableUntilTurn: context.turn.turnNumber + 3,
        updatedAt: new Date(),
      }).where(eq(campaignShipInstancesTable.id, ship.id));
      await tx.insert(campaignLogEntriesTable).values({
        campaignId: context.campaign.id,
        turnNumber: context.turn.turnNumber,
        actorPlayerId: userId,
        type: "campaign.ship.high-command-repair",
        message: `${ship.name} was sent to High Command and will return fully repaired for Turn ${context.turn.turnNumber + 3}.`,
        payload: { shipInstanceId: ship.id, unavailableUntilTurn: context.turn.turnNumber + 3 },
      });
      return context.campaign;
    });
    const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaignRow.id)).limit(1);
    res.json({ campaign: await campaignDetail(campaign ?? campaignRow, userId) });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "High Command repair failed" });
  }
});

router.post("/campaigns/:campaignId/turns/current/reinforcements", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  const parsed = parseReinforcementBody(req.body ?? {});
  if (!campaignId.success) { res.status(400).json({ error: campaignId.error }); return; }
  if (!parsed.success) { res.status(400).json({ error: parsed.error }); return; }
  try {
    const result = await db.transaction(async (tx) => {
      const context = await campaignResolutionContext(tx, campaignId.data, userId, "repairs-reinforcements");
      const [model] = await tx.select().from(shipModelsTable).where(eq(shipModelsTable.id, parsed.data.shipModelId)).limit(1);
      if (!model) throw Object.assign(new Error("Ship model not found"), { status: 404 });
      const existingRoster = await tx.select().from(campaignShipInstancesTable).where(and(
        eq(campaignShipInstancesTable.campaignId, context.campaign.id),
        eq(campaignShipInstancesTable.ownerPlayerId, userId),
      ));
      const existingModelIds = Array.from(new Set(existingRoster.map((ship: typeof campaignShipInstancesTable.$inferSelect) => ship.sourceShipModelId)));
      const existingModels = existingModelIds.length > 0
        ? await tx.select().from(shipModelsTable).where(inArray(shipModelsTable.id, existingModelIds))
        : [];
      const allowedFactions = new Set(existingModels.map((candidate: ShipModelRow) => candidate.faction));
      if (allowedFactions.size > 0 && !allowedFactions.has(model.faction)) {
        throw Object.assign(new Error("Reinforcements must come from a fleet list already represented in your campaign roster"), { status: 400 });
      }
      const cost = campaignReinforcementCost(model.priorityLevel, campaignModelIsSpaceStation(model));
      const balance = await campaignRrBalance(tx, context.campaign.id, userId);
      if (balance < cost) throw Object.assign(new Error(`${model.name} costs ${cost} RR; you have ${balance}`), { status: 400 });
      const cq = rollStartingCrewQuality();
      const [ship] = await tx.insert(campaignShipInstancesTable).values({
        campaignId: context.campaign.id,
        ownerPlayerId: userId,
        sourceShipModelId: model.id,
        name: parsed.data.name ?? model.name,
        status: "active",
        hullCurrent: Math.max(0, model.hullPoints),
        hullMax: Math.max(0, model.hullPoints),
        crewCurrent: Math.max(0, model.crew ?? 0),
        crewMax: Math.max(0, model.crew ?? 0),
        troopsCurrent: Math.max(0, model.troops ?? 0),
        troopsMax: Math.max(0, model.troops ?? 0),
        crewQuality: cq.score,
        crewQualityRoll: cq.total,
        crewQualityDice: cq.dice,
        carriedFighters: model.smallCraft ? [{ printed: model.smallCraft }] : [],
      }).returning();
      await insertCampaignLedgerEntry(tx, {
        campaignId: context.campaign.id,
        campaignTurnId: context.turn.id,
        turnNumber: context.turn.turnNumber,
        playerId: userId,
        campaignShipInstanceId: ship.id,
        resource: "rr",
        amount: -cost,
        eventKey: `campaign:${context.campaign.id}:turn:${context.turn.turnNumber}:reinforcement:${ship.id}`,
        type: "campaign.rr.reinforcement",
        message: `${ship.name} joined the roster for ${cost} RR.`,
        payload: { shipInstanceId: ship.id, shipModelId: model.id, cost, crewQualityRoll: cq },
      });
      return { campaign: context.campaign, ship, cost };
    });
    const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, result.campaign.id)).limit(1);
    res.status(201).json({ campaign: await campaignDetail(campaign ?? result.campaign, userId), result: { ship: result.ship, cost: result.cost } });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Reinforcement purchase failed" });
  }
});

router.post("/campaigns/:campaignId/turns/current/repairs/complete", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const campaignId = parseCampaignId(req.params.campaignId);
  if (!campaignId.success) { res.status(400).json({ error: campaignId.error }); return; }
  try {
    const campaignRow = await db.transaction(async (tx) => {
      const context = await campaignResolutionContext(tx, campaignId.data, userId, "repairs-reinforcements");
      await tx.update(campaignTurnPlayerStatesTable).set({ repairsComplete: true, updatedAt: new Date() })
        .where(eq(campaignTurnPlayerStatesTable.id, context.playerState.id));
      const states = await tx.select().from(campaignTurnPlayerStatesTable)
        .where(eq(campaignTurnPlayerStatesTable.campaignTurnId, context.turn.id));
      if (states.length > 0 && states.every((state) => state.repairsComplete)) {
        await advanceCampaignTurn(tx, context.campaign, context.turn);
      }
      const [updated] = await tx.select().from(campaignsTable).where(eq(campaignsTable.id, context.campaign.id)).limit(1);
      return updated ?? context.campaign;
    });
    res.json({ campaign: await campaignDetail(campaignRow, userId) });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    res.status(err.status ?? 500).json({ error: err.message ?? "Repairs and reinforcements could not be completed" });
  }
});

router.post("/campaigns/:campaignId/join", requireAuth, async (req, res): Promise<void> => {
  await ensureCampaignSchema();
  const userId = getUserId(req);
  const params = parseCampaignId(req.params.campaignId);
  if (!params.success) {
    res.status(400).json({ error: params.error });
    return;
  }
  const parsed = parseJoinCampaignBody(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, params.data))
    .limit(1);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  if (campaign.status !== "setup") {
    res.status(400).json({ error: "Campaign is no longer accepting commanders" });
    return;
  }
  if (campaign.visibility !== "public" && campaign.ownerPlayerId !== userId) {
    res.status(403).json({ error: "Private campaigns are invite-only in this shell" });
    return;
  }

  const existing = await getMembership(campaign.id, userId);
  if (existing) {
    res.json({ campaign: await campaignDetail(campaign, userId) });
    return;
  }

  const displayName = await currentPlayerName(userId);
  await db.insert(campaignPlayersTable).values({
    campaignId: campaign.id,
    playerId: userId,
    displayName,
    faction: parsed.data.faction,
    role: "member",
    status: "active",
  });
  await db
    .update(campaignsTable)
    .set({ updatedAt: new Date() })
    .where(eq(campaignsTable.id, campaign.id));
  await appendCampaignLog({
    campaignId: campaign.id,
    actorPlayerId: userId,
    type: "campaign.joined",
    message: `${displayName ?? "Commander"} joined the campaign.`,
    payload: { faction: parsed.data.faction },
  });

  const [updated] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaign.id))
    .limit(1);
  res.status(201).json({ campaign: await campaignDetail(updated ?? campaign, userId) });
});

export default router;
