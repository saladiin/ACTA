import type {
  AncientStatusEffect,
  GameUnit,
  ShipModel,
} from "@workspace/db";

export type RulesProfile = "standard" | "ancients" | "shadows" | "vorlons";

export const ANCIENT_SPECIAL_ACTIONS = new Set([
  "activate-jump-gate",
  "all-stop",
  "all-stop-pivot",
  "come-about-extra-turn",
  "come-about-sharp-turn",
  "initiate-jump-point",
  "maneuver-to-shield",
  "run-silent",
  "track-that-target",
]);

export const SHADOW_SPECIAL_ACTIONS = new Set([
  "initiate-jump-point",
  "maneuver-to-shield",
  "run-silent",
  "track-that-target",
]);

export const VORLON_SPECIAL_ACTIONS = new Set([
  "activate-jump-gate",
  "all-stop",
  "all-stop-pivot",
  "come-about-extra-turn",
  "come-about-sharp-turn",
  "initiate-jump-point",
  "maneuver-to-shield",
  "regenerate",
  "run-silent",
  "track-that-target",
]);

export function normalizeRulesProfile(value: unknown): RulesProfile {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "ancients" || normalized === "shadows" || normalized === "vorlons") {
    return normalized;
  }
  return "standard";
}

export function rulesProfileForModel(
  model: Pick<ShipModel, "rulesProfile" | "faction">,
): RulesProfile {
  const stored = normalizeRulesProfile(model.rulesProfile);
  if (stored !== "standard") return stored;
  const faction = model.faction.trim().toLowerCase();
  if (faction.includes("shadow")) return "shadows";
  if (faction.includes("vorlon")) return "vorlons";
  if (faction.includes("kirishiac")) return "ancients";
  return "standard";
}

export function initiativeBonusForProfile(profile: RulesProfile): number {
  if (profile === "shadows") return 6;
  if (profile === "ancients" || profile === "vorlons") return 4;
  return 0;
}

export function fixedCrewQualityForProfile(profile: RulesProfile): number | null {
  return profile === "ancients" ? 7 : null;
}

export function profileIgnoresCrewCriticals(profile: RulesProfile): boolean {
  return profile !== "standard";
}

export function profileStealthModifier(
  profile: RulesProfile,
): "ignore" | "plus-one" | "normal" {
  if (profile === "ancients") return "ignore";
  if (profile === "shadows" || profile === "vorlons") return "plus-one";
  return "normal";
}

export function specialActionAllowedForProfile(
  profile: RulesProfile,
  action: string,
): boolean {
  if (profile === "standard") return true;
  if (profile === "ancients") return ANCIENT_SPECIAL_ACTIONS.has(action);
  if (profile === "shadows") return SHADOW_SPECIAL_ACTIONS.has(action);
  return VORLON_SPECIAL_ACTIONS.has(action);
}

export function shadowMindScreamProfile(
  shipName: string,
): { fixedCrewLoss: number; dice: number } | null {
  const name = shipName.trim().replace(/\s+/g, " ").toLowerCase();
  if (name.includes("shadow stalker")) {
    return { fixedCrewLoss: 2, dice: 0 };
  }
  if (name.includes("shadow scout")) {
    return { fixedCrewLoss: 1, dice: 0 };
  }
  if (name.includes("young")) {
    return { fixedCrewLoss: 0, dice: 1 };
  }
  if (name.includes("ancient") || name.includes("battlecrab")) {
    return { fixedCrewLoss: 0, dice: 2 };
  }
  return null;
}

export function shadowTelepathicDisruptionBonus(shipName: string): number {
  return /(?:shadow\s+ship|battlecrab)/i.test(shipName) ? 2 : 0;
}

export function shieldAbsorption(args: {
  remainingHits: number;
  shieldsCurrent: number;
  damageMultiplier: number;
  bypassesShields: boolean;
}): {
  remainingHits: number;
  shieldsAfter: number;
  shieldedHits: number;
} {
  if (args.bypassesShields || args.remainingHits <= 0 || args.shieldsCurrent <= 0) {
    return {
      remainingHits: args.remainingHits,
      shieldsAfter: args.shieldsCurrent,
      shieldedHits: 0,
    };
  }
  const mult = Math.max(1, Math.trunc(args.damageMultiplier));
  const shieldedHits = Math.min(
    args.remainingHits,
    Math.ceil(args.shieldsCurrent / mult),
  );
  return {
    remainingHits: args.remainingHits - shieldedHits,
    shieldsAfter: Math.max(0, args.shieldsCurrent - shieldedHits * mult),
    shieldedHits,
  };
}

export function isProfileCrippled(
  unit: Pick<
    GameUnit,
    | "hullPoints"
    | "maxHullPoints"
    | "damageThreshold"
    | "permanentlyCrippled"
    | "isDestroyed"
  >,
): boolean {
  return !unit.isDestroyed
    && (
      unit.permanentlyCrippled
      || (
        unit.maxHullPoints > 0
        && unit.damageThreshold > 0
        && unit.hullPoints <= unit.damageThreshold
      )
    );
}

export function appendAncientStatusEffect(
  raw: AncientStatusEffect[] | null | undefined,
  effect: AncientStatusEffect,
): AncientStatusEffect[] {
  const current = Array.isArray(raw) ? raw : [];
  const duplicate = current.some((candidate) =>
    candidate.kind === effect.kind
    && candidate.sourceUnitId === effect.sourceUnitId
    && candidate.expiresAfterRound >= effect.expiresAfterRound
  );
  return duplicate ? current : [...current, effect];
}

export function activeAncientStatusEffects(
  raw: AncientStatusEffect[] | null | undefined,
  currentRound: number,
  destroyedSourceIds: ReadonlySet<number> = new Set(),
): AncientStatusEffect[] {
  return (Array.isArray(raw) ? raw : []).filter((effect) =>
    effect.expiresAfterRound >= currentRound
    && !(effect.releaseWhenSourceDestroyed && destroyedSourceIds.has(effect.sourceUnitId))
  );
}

export function unitIsPinned(
  raw: AncientStatusEffect[] | null | undefined,
  currentRound: number,
  destroyedSourceIds: ReadonlySet<number> = new Set(),
): boolean {
  return activeAncientStatusEffects(raw, currentRound, destroyedSourceIds).length > 0;
}
