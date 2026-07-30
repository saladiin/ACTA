import React, {
  useState,
  useRef,
  Suspense,
  useMemo,
  useEffect,
  useCallback,
} from "react";
import { useParams, Link, useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Canvas, useLoader, useThree, useFrame } from "@react-three/fiber";
import { Billboard, OrbitControls, Text, useGLTF, Line } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { WeaponFx } from "@/components/weapon-fx";
// @ts-ignore
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
// @ts-ignore
import * as THREE from "three";
import {
  useGetGame,
  useAcceptGame,
  useDeclineGame,
  useDeployFleet,
  useSubmitTurn,
  useMoveUnit,
  useActivateUnit,
  useEndActivation,
  useFireWeapon,
  useDamageControl,
  useRollInitiative,
  useRunAiStep,
  useChooseFirstActivator,
  usePassEndPhase,
  useSurrenderGame,
  useConcedeGame,
  useChooseSpecialAction,
  useChooseShadowPointDefense,
  useChooseShadowManeuverMode,
  useAttemptTelepathicDisruption,
  useLaunchShadowFighterDispersal,
  useChooseScoutAction,
  useListFleets,
  useListFleetShips,
  useListShipModels,
  getGetGameQueryKey,
  getListShipModelsQueryKey,
  getListTurnsQueryKey,
  getListFleetShipsQueryKey,
  customFetch,
} from "@workspace/api-client-react";
import type {
  DamageControlResult,
  GameDetail,
  GameUnit,
  ShipModel,
  Weapon,
  FireWeaponResult,
} from "@workspace/api-client-react";
import { useUser } from "@clerk/react";
import { Layout } from "@/components/layout";
import { useDevUserId } from "@/lib/dev-user";
import {
  getTemporaryUserId,
  temporaryUsernameAuthEnabled,
  useTemporaryUsername,
} from "@/lib/temporary-user";
import { useInputProfile } from "@/hooks/use-input-profile";
import {
  useUiArcColorScheme,
  useUiAttackPhasePulseOpacity,
  useUiAttackPhasePulseStrength,
  useUiBoardBackgroundMode,
  useUiBoardGrid,
  useUiBoardOpacity,
  useUiControlMode,
  useUiIsoCameraControls,
  useUiShipHullNames,
  useUiShipMeshTints,
  useUiShipStatusDisplayMode,
  useUiWeaponArcProjection,
  type UiArcColorScheme,
  type UiControlMode,
  type UiShipStatusDisplayMode,
} from "@/hooks/use-ui-settings";
import { APP_BUILD_SHA } from "@/lib/build-version";
import {
  clampPointToDeploymentZone,
  defaultDeploymentPoint,
  deploymentSideConfig,
  normalizeDeploymentConfig,
  type DeploymentConfig,
  type DeploymentSide,
} from "@/lib/deployment-zones";
import {
  ALLOCATION_TICKS_PER_FAP,
  PRIORITY_LEVELS,
  allocationTicksForShip,
  calculateAllocation,
  formatAllocationTicks,
  normalizePriorityLevel,
  type PriorityLevel,
  priorityLabel,
} from "@/lib/fleet-allocation";
import {
  findBlockingLineOfSightObstacle,
  type LineOfSightBlock,
  type LineOfSightObstacle,
} from "@/lib/line-of-sight";
import {
  ASTEROID_FIELD_MODEL_MEDIUM,
  ASTEROID_FIELD_SOURCE_DIAMETER,
  normalizeTerrainConfig,
  lineOfSightObstaclesFromTerrainConfig,
  pointInsideTerrainObject,
  terrainObjectForPlacementPreview,
  terrainObjectPolygon,
  type ManualTerrainVariant,
  type TerrainKind,
  type TerrainObject,
} from "@/lib/terrain";
import skyboxUrl from "@assets/skybox_1780215222009.png";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Swords,
  Shield,
  Target,
  CheckCircle,
  XCircle,
  Crosshair,
  Move,
  Zap,
  Flag,
  PanelRightClose,
  PanelRightOpen,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  RotateCcw,
  RotateCw,
  Check,
  X,
  Cpu,
  AlertTriangle,
  MessageCircle,
  Send,
  ChevronDown,
  ChevronUp,
  ScrollText,
  Camera,
  Compass,
  Lock,
  Unlock,
  Maximize2,
} from "lucide-react";

// Storage convention: `hexQ` / `hexR` columns hold WORLD INCHES (the field
// names are historical). Render coordinates are 1:1 with storage, so this
// is an identity mapping kept as a single function so we can audit every
// callsite in one place.
function hexToWorld(q: number, r: number): [number, number, number] {
  return [q, 0, r];
}

// Board is 48" wide × 72" deep, 1 world unit = 1 inch
const BOARD_W = 48;
const BOARD_D = 72;
type ManualTerrainChoice = "asteroid-light" | "asteroid-medium" | "gas-cloud";
const UNIT_FOCUS_CAMERA_DISTANCE = 18; // Tune this to change double-tap zoom level.
const UNIT_FOCUS_TARGET_HEIGHT = 1.4;
const BOARD_FOCUS_CAMERA_DISTANCE = 30;
const BOARD_FOCUS_TARGET_HEIGHT = 0.25;
const BOARD_SHIP_NAME_MAX_CHARS = 24;
const BOARD_LOCKED_SHIP_NAME_MAX_CHARS = 21;
const UNIT_FOCUS_LERP = 10;
const CAMERA_DRAG_PAN_SPEED = 2.35;
const CAMERA_KEYBOARD_PAN_SPEED = 38;
const CAMERA_DAMPING_FACTOR = 0.04;
const CAMERA_MAX_POLAR_ANGLE = Math.PI - 0.08;
const TOP_DOWN_POLAR_ANGLE = 0.012;
const TOP_DOWN_CAMERA_DISTANCE = 64;
const ISO_CAMERA_POLAR_ANGLE = 0.9;
const ISO_CAMERA_AZIMUTH_ANGLE = Math.PI / 4;
const ISO_CAMERA_DISTANCE = 58;
const CAMERA_PAN_MARGIN = 8;
const CAMERA_MIN_DISTANCE = 8;
const CAMERA_MAX_DISTANCE = 72;
const CAMERA_LONG_PRESS_ORBIT_MS = 320;
const TABLET_FORWARD_STEP = 0.5;
const TABLET_TURN_STEP_DEG = 5;
const CAPITAL_MOVE_DRAG_START_EXTRA_INCHES = 1.5;
const AI_OPPONENT_ID = "ai:acta-skirmish-v0";
const AI_AUTO_STEP_LIMIT = 12;

function boardShipNameLabel(
  name: string,
  maxChars = BOARD_SHIP_NAME_MAX_CHARS,
): string {
  return name.length > maxChars
    ? `${name.slice(0, Math.max(0, maxChars - 1))}...`
    : name;
}

function splitTraitList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;,]/)
    .map((trait) => trait.trim())
    .filter(Boolean);
}

function normalizeHintKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, " ");
}

function traitHint(trait: string): string {
  const normalized = normalizeHintKey(trait);
  if (/^anti fighter/.test(normalized))
    return "Defensive guns that can attack enemy fighters. Higher values mean more anti-fighter dice.";
  if (/^advanced anti fighter/.test(normalized))
    return "Improved anti-fighter fire. It is stronger than normal Anti-Fighter when fighters close in.";
  if (/^command/.test(normalized))
    return "Helps the fleet coordinate. The listed bonus applies where Command checks are used.";
  if (/^carrier/.test(normalized))
    return "Carries fighter flights and can launch or recover them. The number is bay capacity.";
  if (/^interceptors/.test(normalized))
    return "Defensive dice that can cancel incoming attack dice. They refresh by the rules each turn.";
  if (/^dodge/.test(normalized))
    return "This unit may avoid hits on the listed roll. Fighters rely on this heavily.";
  if (/^dogfight/.test(normalized))
    return "Bonus used when resolving fighter dogfights. Higher is better.";
  if (/^stealth/.test(normalized))
    return "Attackers must overcome this stealth value before firing. Strong stealth makes long shots unreliable.";
  if (/^self repair/.test(normalized))
    return "Repairs hull during the End Phase. The trait lists the repair dice available.";
  const hints: Record<string, string> = {
    accurate:
      "Improves attack reliability. Use it when checking weapon hit modifiers.",
    "adaptive armor":
      "Reduces repeated incoming damage. It makes the ship harder to wear down.",
    "advanced jump engine":
      "Scenario and jump-point capability. Advanced engines are stronger than standard jump engines.",
    agile:
      "Turns more easily than normal ships. First turns need only a quarter-speed move.",
    ancient:
      "Marks exceptionally advanced technology. Rules interactions are handled where implemented.",
    atmospheric:
      "Can operate in atmosphere. This mainly matters for scenarios and terrain rules.",
    "armor piercing":
      "Better at pushing damage through armor. It improves damage rolls against solid hits.",
    beam: "Beam weapons can chain extra hits on strong rolls. They cannot split fire.",
    "double damage":
      "Successful damage is doubled. Dangerous against both hull and crew.",
    "energy mine":
      "Area-effect weapon. It uses special targeting and cannot split fire.",
    fighter:
      "This is a fighter flight, not a capital ship. It uses fighter movement, dogfights, and fighter kill rules.",
    "fleet carrier":
      "Improves fighter support and recovery. Nearby destroyed friendly flights get better recovery odds.",
    "flight computer":
      "Keeps weapons coordinated with reduced crew. It can offset skeleton-crew firing limits.",
    "jump engine":
      "Scenario and jump-point capability. It usually matters when jump points are in play.",
    lumbering:
      "Poor maneuverability. The ship cannot use some sharp-turn movement options.",
    "mini beam":
      "A lighter beam weapon. It follows beam-style restrictions with smaller output.",
    "one shot": "Can fire only once. After that shot, the weapon is spent.",
    precise:
      "Better at causing critical damage. It rewards clean hits on vulnerable targets.",
    "quad damage":
      "Successful damage is quadrupled. Extremely punishing when it gets through.",
    "redundant systems":
      "Extra backup systems resist critical disruption. The ship is less fragile under crit pressure.",
    scout:
      "Can use scout actions. Scouts support target locks and electronic warfare.",
    shuttles:
      "Carries utility craft. This is mostly scenario or mission support.",
    "slow loading":
      "Must wait before firing again. The UI tracks the reload round.",
    "stealth penetration":
      "Helps defeat enemy stealth. Useful against Minbari and other stealthy targets.",
    "super armor piercing":
      "Stronger armor penetration. It is better than standard Armor Piercing.",
    "super maneuverable":
      "May turn freely without normal turn-distance limits. Fighters commonly have this.",
    "triple damage":
      "Successful damage is tripled. High threat against ships that fail defenses.",
    "twin linked":
      "Rerolls or improves paired-weapon accuracy. It makes light weapons more dependable.",
    weak: "Reduced damage performance. Expect fewer solid results from this weapon.",
  };
  return (
    hints[normalized] ??
    "Special rule for this ship or weapon. The game applies it when the matching situation arises."
  );
}

function criticalEffectHint(crit: {
  name: string;
  repairable?: boolean | null;
  damageApplied?: number | null;
  crewApplied?: number | null;
  randomArc?: string | null;
  lostTraits?: string[] | null;
  effectKey?: string | null;
}): string {
  const effects: string[] = [];
  const ruleText =
    CRITICAL_RULE_TEXT_BY_KEY[String(crit.effectKey ?? "")] ?? null;
  if (ruleText) effects.push(ruleText);
  if ((crit.damageApplied ?? 0) > 0)
    effects.push(`-${crit.damageApplied} hull`);
  if ((crit.crewApplied ?? 0) > 0) effects.push(`-${crit.crewApplied} crew`);
  if (crit.randomArc) effects.push(`${crit.randomArc} arc affected`);
  if ((crit.lostTraits?.length ?? 0) > 0)
    effects.push(`lost ${crit.lostTraits!.join(", ")}`);
  if (effects.length === 0) effects.push("ongoing system damage");
  const repair =
    crit.repairable === false
      ? "Cannot be cleared by Damage Control."
      : "Damage Control can clear it after the round it was caused.";
  return `${effects.join(", ")}. ${repair}`;
}

function titleCaseStatus(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  if (!text) return "None";
  return text
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function specialActionLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const failed = raw.endsWith("-failed");
  const base = failed ? raw.replace(/-failed$/, "") : raw;
  const labels: Record<string, string> = {
    "all-power-engines": "All Power to Engines",
    "all-stop": "All Stop",
    "all-stop-pivot": "All Stop and Pivot",
    "come-about-extra-turn": "Come About: Extra Turn",
    "come-about-sharp-turn": "Come About: Sharp Turn",
    "blast-doors": "Close Blast Doors",
    "intensify-defense": "Intensify Defensive Fire",
    "run-silent": "Run Silent",
    "concentrate-fire": "Concentrate All Fire",
    "cause-confusion": "Cause Confusion",
    "all-hands-on-deck": "All Hands on Deck",
    scramble: "Scramble",
    regenerate: "Regenerate",
  };
  return `${labels[base] ?? titleCaseStatus(base)}${failed ? " (failed)" : ""}`;
}

function scoutActionLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const failed = raw.endsWith("-failed");
  const base = failed ? raw.replace(/-failed$/, "") : raw;
  const labels: Record<string, string> = {
    "counter-stealth": "Counter-Stealth",
    coord: "Coordinate Fire",
  };
  return `${labels[base] ?? titleCaseStatus(base)}${failed ? " (failed)" : ""}`;
}

const CRITICAL_RULE_TEXT_BY_KEY: Record<string, string> = {
  "engines-power-relays": "-1 Speed",
  "engines-thrusters": "-2 Speed",
  "engines-fuel": "-4 Speed",
  "engines-disabled": "Ship moves as though adrift",
  "reactor-capacitors": "-2 Speed, all weapons -1 AD",
  "reactor-power-feedback": "Lose 1 random trait",
  "reactor-gas-leak": "No Special Actions",
  "reactor-explosion": "No Special Actions, lose 1 random trait",
  "weapons-targeting": "All weapons -1 AD",
  "weapons-fluctuations": "Each weapon fires only on 4+",
  "weapons-offline": "Random arc, 1 weapon may not fire",
  "weapons-catastrophic": "Random arc, no weapons can fire",
  "crew-fire": "Crew fire damage",
  "crew-multi-fires": "Damage Control suffers -1 penalty",
  "crew-decompression": "-1 Troops, no Special Actions",
  "crew-hull-breach": "-2 Troops, no Damage Control this turn",
  "vital-bridge": "No Special Actions",
  "vital-secondary": "Secondary explosion damage",
  "vital-engineering": "No Damage Control permitted",
  "vital-weapons-control": "No firing out of 1 random arc",
  "vital-implosion": "Lose 1 random trait",
  "vital-catastrophic": "Lose 2 random traits",
};

function CriticalEffectTooltip({
  crit,
  enabled,
  children,
}: {
  crit: Parameters<typeof criticalEffectHint>[0];
  enabled: boolean;
  children: React.ReactElement;
}) {
  if (!enabled) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side="left"
        align="start"
        sideOffset={8}
        className="max-w-[280px] border border-red-400/40 bg-zinc-950 px-3 py-2 font-mono text-[11px] leading-snug text-red-100 shadow-xl"
      >
        <div className="text-[10px] uppercase tracking-wider text-red-300/80">
          {crit.name}
        </div>
        <div className="mt-1 text-zinc-200">{criticalEffectHint(crit)}</div>
      </TooltipContent>
    </Tooltip>
  );
}

function TraitTooltip({
  trait,
  enabled = true,
  children,
}: {
  trait: string;
  enabled?: boolean;
  children: React.ReactElement;
}) {
  if (!enabled) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        sideOffset={8}
        className="max-w-[280px] border border-cyan-400/40 bg-zinc-950 px-3 py-2 font-mono text-[11px] leading-snug text-cyan-100 shadow-xl"
      >
        <div className="text-[10px] uppercase tracking-wider text-cyan-300/80">
          {trait}
        </div>
        <div className="mt-1 text-zinc-200">{traitHint(trait)}</div>
      </TooltipContent>
    </Tooltip>
  );
}

type AiDiagnostics = {
  status?: string;
  lastStep?: string;
  lastActionAt?: string;
  message?: string;
  lastInitiativeTieRoll?: number;
  lastInitiativeTieRound?: number;
  decisionLog?: Array<{
    at?: string;
    step?: string;
    phase?: string;
    unitId?: number;
    unitName?: string;
    summary?: string;
    details?: Record<string, unknown>;
  }>;
  lastError?: {
    message?: string;
    code?: string;
    at?: string;
  };
};

type BugRescueNotice = {
  id: number;
  at?: string;
  reporterPlayerId: string;
  reporterName?: string | null;
  round?: number;
  phase?: string;
  activePlayerId?: string | null;
  activeUnitId?: number | null;
  activeUnitName?: string | null;
  message?: string;
  rescueRequested?: boolean;
  rescueApplied?: boolean;
};

type GameChatMessage = {
  id: number;
  gameId: number;
  senderPlayerId: string;
  senderName?: string | null;
  message: string;
  createdAt: string;
};

type AiWeaponFxReplay = {
  key: string;
  attackerUnitId: number;
  targetUnitId: number;
  weaponId: number;
  hits: number;
};

type AiFiringSummaryTarget = {
  targetUnitId: number;
  targetName: string;
  weaponNames: string[];
  weaponsFired: number;
  hits: number;
  hullDamage: number;
  crewDamage: number;
  destroyed: boolean;
  crippled: boolean;
  damageState: string;
};

type AiFiringActivationSummary = {
  id: string;
  at: string;
  round: number;
  turn: number;
  attackerUnitId: number;
  attackerName: string;
  weaponsFired: number;
  totalHits: number;
  totalHullDamage: number;
  totalCrewDamage: number;
  targets: AiFiringSummaryTarget[];
};

type AntiFighterUiTarget = {
  targetUnitId: number;
  targetName: string;
  distance: number;
  hull: number;
};

type AntiFighterUiAttacker = {
  attackerUnitId: number;
  attackerName: string;
  ownerId: string;
  trait: "Anti-Fighter" | "Advanced Anti-Fighter";
  dice: number;
  bonus: number;
  eligibleTargets: AntiFighterUiTarget[];
};

type AntiFighterUiRoll = {
  attackerId: number;
  attackerName: string;
  targetId: number;
  targetName: string;
  die: number;
  bonus: number;
  total: number;
  targetHull: number;
  destroyed: boolean;
  psychicCrewDodgeRoll?: number | null;
  psychicCrewDodgeSuccessful?: boolean;
  shieldAbsorbed?: boolean;
};

type AntiFighterUiState = {
  kind: "anti-fighter-allocation";
  round: number;
  currentPlayerId: string;
  pendingPlayerIds: string[];
  completedPlayerIds: string[];
  attackers: AntiFighterUiAttacker[];
  lastResult?: {
    playerId?: string;
    round?: number;
    attacks: Array<{
      attackerId: number;
      attackerName: string;
      trait: string;
      dice: number;
      bonus: number;
      rolls: AntiFighterUiRoll[];
      destroyedTargetIds: number[];
    }>;
    destroyedUnitIds: number[];
  };
};

function formatChatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function readBugRescueNotice(raw: unknown): BugRescueNotice | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = raw as Record<string, unknown>;
  const value = state.lastBugRescue;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const notice = value as Record<string, unknown>;
  if (
    typeof notice.id !== "number" ||
    typeof notice.reporterPlayerId !== "string"
  )
    return null;
  return {
    id: notice.id,
    at: typeof notice.at === "string" ? notice.at : undefined,
    reporterPlayerId: notice.reporterPlayerId,
    reporterName:
      typeof notice.reporterName === "string" ? notice.reporterName : null,
    round: typeof notice.round === "number" ? notice.round : undefined,
    phase: typeof notice.phase === "string" ? notice.phase : undefined,
    activePlayerId:
      typeof notice.activePlayerId === "string" ? notice.activePlayerId : null,
    activeUnitId:
      typeof notice.activeUnitId === "number" ? notice.activeUnitId : null,
    activeUnitName:
      typeof notice.activeUnitName === "string" ? notice.activeUnitName : null,
    message: typeof notice.message === "string" ? notice.message : undefined,
    rescueRequested:
      typeof notice.rescueRequested === "boolean"
        ? notice.rescueRequested
        : undefined,
    rescueApplied:
      typeof notice.rescueApplied === "boolean"
        ? notice.rescueApplied
        : undefined,
  };
}

function readAntiFighterUiState(raw: unknown): AntiFighterUiState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = raw as Record<string, unknown>;
  const value = state.antiFighter;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const af = value as Partial<AntiFighterUiState>;
  if (af.kind !== "anti-fighter-allocation") return null;
  if (typeof af.round !== "number" || typeof af.currentPlayerId !== "string")
    return null;
  if (!Array.isArray(af.attackers)) return null;
  return af as AntiFighterUiState;
}

type FighterDisplacementUiEntry = {
  unitId: number;
  ownerId: string;
  name: string;
  x: number;
  z: number;
  baseRadiusInches: number;
};

type FighterDisplacementUiState = {
  kind: "fighter-displacement";
  round: number;
  displacingUnitId: number;
  displacingPlayerId: string;
  readyToPlace: boolean;
  ownerOrder: string[];
  entries: FighterDisplacementUiEntry[];
};

type ShadowDispersalPlacementState = {
  carrierId: number;
  shipModelId: number;
  itemName: string;
  activeIndex: number;
  placements: Array<{
    hexQ: number;
    hexR: number;
    heading: number;
  }>;
};

type ShadowDispersalPlacementValidation = {
  legal: boolean;
  shortReason: string;
  detail: string;
};

function uiUnitPinnedForRound(
  unit: Pick<GameUnit, "ancientStatusEffects">,
  allUnits: Array<Pick<GameUnit, "id" | "isDestroyed">>,
  currentRound: number,
): boolean {
  return (unit.ancientStatusEffects ?? []).some((effect) => {
    if (effect.expiresAfterRound < currentRound) return false;
    if (!effect.releaseWhenSourceDestroyed) return true;
    const source = allUnits.find(
      (candidate) => candidate.id === effect.sourceUnitId,
    );
    return Boolean(source && !source.isDestroyed);
  });
}

function readFighterDisplacementUiState(
  raw: unknown,
): FighterDisplacementUiState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = raw as Record<string, unknown>;
  const value = state.fighterDisplacement;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const displacement = value as Partial<FighterDisplacementUiState>;
  if (displacement.kind !== "fighter-displacement") return null;
  if (
    typeof displacement.round !== "number" ||
    typeof displacement.displacingUnitId !== "number" ||
    typeof displacement.displacingPlayerId !== "string" ||
    !Array.isArray(displacement.ownerOrder) ||
    !Array.isArray(displacement.entries)
  )
    return null;
  return {
    ...(displacement as FighterDisplacementUiState),
    readyToPlace: displacement.readyToPlace === true,
  };
}

function currentFighterDisplacementOwnerId(
  displacement: FighterDisplacementUiState | null,
): string | null {
  if (!displacement?.readyToPlace) return null;
  for (const ownerId of displacement.ownerOrder) {
    if (displacement.entries.some((entry) => entry.ownerId === ownerId))
      return ownerId;
  }
  return null;
}

function readAntiFighterLastResult(
  raw: unknown,
): AntiFighterUiState["lastResult"] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = raw as Record<string, unknown>;
  const direct = state.lastAntiFighter;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct as AntiFighterUiState["lastResult"];
  }
  const pending = readAntiFighterUiState(raw);
  return pending?.lastResult ?? null;
}

function readAiFiringSummary(raw: unknown): AiFiringActivationSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = raw as Record<string, unknown>;
  const value = state.aiFiringSummary;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = value as Record<string, unknown>;
  if (
    typeof summary.id !== "string" ||
    typeof summary.at !== "string" ||
    typeof summary.round !== "number" ||
    typeof summary.turn !== "number" ||
    typeof summary.attackerUnitId !== "number" ||
    typeof summary.attackerName !== "string" ||
    typeof summary.weaponsFired !== "number" ||
    typeof summary.totalHits !== "number" ||
    typeof summary.totalHullDamage !== "number" ||
    typeof summary.totalCrewDamage !== "number" ||
    !Array.isArray(summary.targets)
  ) {
    return null;
  }
  const targets: AiFiringSummaryTarget[] = [];
  for (const entry of summary.targets) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const target = entry as Record<string, unknown>;
    if (
      typeof target.targetUnitId !== "number" ||
      typeof target.targetName !== "string" ||
      !Array.isArray(target.weaponNames) ||
      !target.weaponNames.every((name) => typeof name === "string") ||
      typeof target.weaponsFired !== "number" ||
      typeof target.hits !== "number" ||
      typeof target.hullDamage !== "number" ||
      typeof target.crewDamage !== "number" ||
      typeof target.destroyed !== "boolean" ||
      typeof target.crippled !== "boolean" ||
      typeof target.damageState !== "string"
    ) {
      return null;
    }
    targets.push(target as AiFiringSummaryTarget);
  }
  return {
    id: summary.id,
    at: summary.at,
    round: summary.round,
    turn: summary.turn,
    attackerUnitId: summary.attackerUnitId,
    attackerName: summary.attackerName,
    weaponsFired: summary.weaponsFired,
    totalHits: summary.totalHits,
    totalHullDamage: summary.totalHullDamage,
    totalCrewDamage: summary.totalCrewDamage,
    targets,
  };
}

function aiFiringSummaryStorageKey(gameId: number): string {
  return `b5acta:ai-firing-summary:${gameId}`;
}

function readAiDiagnostics(raw: unknown): AiDiagnostics {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const state = raw as Record<string, unknown>;
  const error =
    state.lastError &&
    typeof state.lastError === "object" &&
    !Array.isArray(state.lastError)
      ? (state.lastError as Record<string, unknown>)
      : null;
  const decisionLog = Array.isArray(state.decisionLog)
    ? state.decisionLog
        .filter((entry): entry is Record<string, unknown> =>
          Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
        )
        .map((entry) => ({
          at: typeof entry.at === "string" ? entry.at : undefined,
          step: typeof entry.step === "string" ? entry.step : undefined,
          phase: typeof entry.phase === "string" ? entry.phase : undefined,
          unitId: typeof entry.unitId === "number" ? entry.unitId : undefined,
          unitName:
            typeof entry.unitName === "string" ? entry.unitName : undefined,
          summary:
            typeof entry.summary === "string" ? entry.summary : undefined,
          details:
            entry.details &&
            typeof entry.details === "object" &&
            !Array.isArray(entry.details)
              ? (entry.details as Record<string, unknown>)
              : undefined,
        }))
    : undefined;
  return {
    status: typeof state.status === "string" ? state.status : undefined,
    lastStep: typeof state.lastStep === "string" ? state.lastStep : undefined,
    lastActionAt:
      typeof state.lastActionAt === "string" ? state.lastActionAt : undefined,
    message: typeof state.message === "string" ? state.message : undefined,
    lastInitiativeTieRoll:
      typeof state.lastInitiativeTieRoll === "number"
        ? state.lastInitiativeTieRoll
        : undefined,
    lastInitiativeTieRound:
      typeof state.lastInitiativeTieRound === "number"
        ? state.lastInitiativeTieRound
        : undefined,
    decisionLog,
    lastError: error
      ? {
          message:
            typeof error.message === "string" ? error.message : undefined,
          code: typeof error.code === "string" ? error.code : undefined,
          at: typeof error.at === "string" ? error.at : undefined,
        }
      : undefined,
  };
}

function aiProgressSignature(game: GameDetail["game"]): string {
  const state = readAiDiagnostics(game.aiState);
  const displacement = readFighterDisplacementUiState(game.aiState);
  const firingSummary = readAiFiringSummary(game.aiState);
  return [
    game.status,
    game.phase,
    game.activePlayerId ?? "",
    game.activeUnitId ?? "",
    game.currentRound,
    game.currentTurn,
    game.initiativeChallengerRoll ?? "",
    game.initiativeOpponentRoll ?? "",
    game.initiativeWinnerId ?? "",
    state.status ?? "",
    state.lastStep ?? "",
    state.lastActionAt ?? "",
    firingSummary?.id ?? "",
    displacement?.readyToPlace ? "displace-ready" : "",
    currentFighterDisplacementOwnerId(displacement) ?? "",
    displacement?.entries.map((entry) => entry.unitId).join(",") ?? "",
  ].join("|");
}

function shouldStopAiAutoRun(
  game: GameDetail["game"],
  myUserId: string,
  acknowledgedFiringSummaryId: string | null = null,
): boolean {
  if (game.status !== "active") return true;
  const firingSummary = readAiFiringSummary(game.aiState);
  if (
    myUserId !== AI_OPPONENT_ID &&
    firingSummary &&
    firingSummary.id !== acknowledgedFiringSummaryId
  ) {
    return true;
  }
  const displacement = readFighterDisplacementUiState(game.aiState);
  if (currentFighterDisplacementOwnerId(displacement) === AI_OPPONENT_ID)
    return false;
  if (game.activePlayerId && game.activePlayerId !== AI_OPPONENT_ID)
    return true;
  if (game.phase === "initiative") {
    if (
      game.initiativeOpponentRoll != null &&
      game.initiativeChallengerRoll == null
    )
      return true;
    if (game.initiativeWinnerId && game.initiativeWinnerId !== AI_OPPONENT_ID)
      return true;
  }
  if (game.phase === "end" && game.activePlayerId === myUserId) return true;
  return false;
}

function AiDiagnosticsPanel({
  game,
  onToggleAuto,
  isRunning,
  autoEnabled,
  readOnly = false,
}: {
  game: GameDetail["game"];
  onToggleAuto: () => void;
  isRunning: boolean;
  autoEnabled: boolean;
  readOnly?: boolean;
}) {
  if (game.opponentKind !== "ai") return null;
  return (
    <div
      className="border-b border-cyan-500/20 px-4 py-3"
      data-testid="panel-ai-control"
    >
      <Button
        size="sm"
        variant={autoEnabled ? "default" : "outline"}
        className={`h-8 w-full gap-1.5 font-mono text-[10px] font-bold uppercase tracking-widest ${
          autoEnabled
            ? "border-orange-300/70 bg-orange-400/20 text-orange-100 hover:bg-orange-400/30"
            : "border-cyan-500/35 text-cyan-100 hover:bg-cyan-500/10"
        }`}
        onClick={onToggleAuto}
        disabled={readOnly || (isRunning && !autoEnabled)}
        data-testid="button-toggle-ai-auto"
      >
        <Cpu className="h-3.5 w-3.5" />
        {autoEnabled ? "AI Pause" : "AI Play"}
      </Button>
    </div>
  );
}
function battleLogSourceLabel(source: BattleLogEntry["source"]): string {
  if (source === "firing") return "Fire";
  if (source === "anti-fighter") return "AF";
  if (source === "special") return "SA";
  return "Move";
}

function BattleLogPanel({
  entries,
  collapsible = false,
  defaultOpen = true,
}: {
  entries: BattleLogEntry[];
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const content = (
    <div className="max-h-72 overflow-y-auto px-3 pb-3">
      {entries.length === 0 ? (
        <p className="py-3 font-mono text-[10px] text-muted-foreground">
          No recorded actions yet.
        </p>
      ) : (
        <div className="space-y-1.5">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="rounded border border-border/60 bg-black/20 px-2 py-1.5 font-mono"
            >
              <div className="mb-0.5 flex items-center gap-1.5 text-[8px] uppercase tracking-wider text-muted-foreground">
                <span>R{entry.round}</span>
                <span>{entry.phase}</span>
                <span>{battleLogSourceLabel(entry.source)}</span>
                {entry.actorKind === "ai" && (
                  <span className="text-cyan-300">AI</span>
                )}
              </div>
              <p className="text-[10px] leading-snug text-foreground/85">
                {entry.summary}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  if (collapsible) {
    return (
      <div className="border-b border-border" data-testid="battle-log-panel">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-secondary/30"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          data-testid="button-toggle-battle-log"
        >
          <ScrollText className="h-4 w-4 text-primary" />
          <span className="flex-1 text-xs font-mono font-bold uppercase tracking-widest text-primary">
            Battle Log
          </span>
          <Badge variant="outline" className="h-5 px-1.5 text-[9px] font-mono">
            {entries.length}
          </Badge>
          {open ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
        {open && content}
      </div>
    );
  }

  return (
    <div className="bg-card" data-testid="battle-log-panel">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-primary">
          Battle Log
        </span>
        <Badge variant="outline" className="h-5 px-1.5 text-[9px] font-mono">
          {entries.length}
        </Badge>
      </div>
      {content}
    </div>
  );
}

// Deep-space backdrop: an equirectangular (2:1) panorama mapped onto the scene
// background. We set it as `scene.background` only — NOT `scene.environment` —
// so it's purely a visual backdrop and doesn't change how the explicit scene
// lights fall on the ships. The texture suspends while loading, so it must be
// rendered inside a Suspense boundary. Restores the previous background on
// unmount so nothing leaks between scenes.
function Skybox({ url }: { url: string }) {
  const texture = useLoader(THREE.TextureLoader, url);
  const { scene } = useThree();
  useEffect(() => {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    const prev = scene.background;
    scene.background = texture;
    return () => {
      scene.background = prev;
    };
  }, [texture, scene]);
  return null;
}

function SpaceGrid({
  boardOpacity = 100,
  showGrid = true,
}: {
  boardOpacity?: number;
  showGrid?: boolean;
}) {
  const planeOpacity = Math.max(0, Math.min(100, boardOpacity)) / 100;
  return (
    <>
      {/* Opaque from above, invisible from below so underside camera views still
          see the scene without the board plane blocking them. */}
      <mesh
        position={[0, -0.02, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={0}
      >
        <planeGeometry args={[BOARD_W, BOARD_D]} />
        <meshBasicMaterial
          color="#020303"
          side={THREE.FrontSide}
          transparent={planeOpacity < 1}
          opacity={planeOpacity}
          depthWrite={planeOpacity >= 1}
        />
      </mesh>
      {showGrid && (
        <>
          {/* Fine 1" grid */}
          <gridHelper
            args={[72, 72, "#0d1a0d", "#0a140a"]}
            position={[0, -0.01, 0]}
          />
          {/* Bold 6" grid overlay */}
          <gridHelper
            args={[72, 12, "#172617", "#172617"]}
            position={[0, -0.005, 0]}
          />
        </>
      )}
    </>
  );
}

function AttackPhaseBoardPulse({
  active,
  opacity,
  strength,
}: {
  active: boolean;
  opacity: number;
  strength: number;
}) {
  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const opacityScale = Math.max(0, Math.min(100, opacity)) / 100;
  const strengthScale = Math.max(0, Math.min(100, strength)) / 100;

  useFrame(({ clock }) => {
    const mat = materialRef.current;
    if (!mat) return;
    const pulse = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 2.2);
    mat.opacity = active ? opacityScale * (0.38 + pulse * 0.62) : 0;
    mat.emissiveIntensity = active ? strengthScale * (0.35 + pulse * 1.15) : 0;
  });

  if (!active || (opacityScale <= 0 && strengthScale <= 0)) return null;

  return (
    <mesh
      position={[0, 0.018, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
      renderOrder={1}
    >
      <planeGeometry args={[BOARD_W, BOARD_D]} />
      <meshStandardMaterial
        ref={materialRef}
        color="#3a0508"
        emissive="#ff1f2d"
        emissiveIntensity={strengthScale}
        transparent
        opacity={opacityScale}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        side={THREE.FrontSide}
      />
    </mesh>
  );
}

type ConcentrateFireLineUnit = Pick<
  GameUnit,
  | "id"
  | "hexQ"
  | "hexR"
  | "isDestroyed"
  | "specialAction"
  | "specialActionTargetId"
  | "baseRadiusInches"
>;

function ConcentrateFireTargetLines({
  units,
}: {
  units: ConcentrateFireLineUnit[];
}) {
  const links = useMemo(() => {
    const unitById = new Map(units.map((unit) => [unit.id, unit]));
    return units.flatMap((attacker) => {
      if (
        attacker.isDestroyed ||
        attacker.specialAction !== "concentrate-fire" ||
        attacker.specialActionTargetId == null
      )
        return [];
      const target = unitById.get(attacker.specialActionTargetId);
      if (!target || target.isDestroyed) return [];

      const from = new THREE.Vector3(attacker.hexQ, 0.16, attacker.hexR);
      const to = new THREE.Vector3(target.hexQ, 0.16, target.hexR);
      const delta = to.clone().sub(from);
      const distance = delta.length();
      if (distance < 0.001) return [];

      const direction = delta.clone().normalize();
      const attackerRadius = rulesBaseRadius(attacker);
      const targetRadius = rulesBaseRadius(target);
      const edgeGap = distance - attackerRadius - targetRadius;
      const start =
        edgeGap > 0.2
          ? from
              .clone()
              .add(direction.clone().multiplyScalar(attackerRadius + 0.08))
          : from;
      const end =
        edgeGap > 0.2
          ? to
              .clone()
              .add(direction.clone().multiplyScalar(-(targetRadius + 0.08)))
          : to;
      const mid = start.clone().lerp(end, 0.5);

      return [
        {
          key: `${attacker.id}-${target.id}`,
          attackerPoints: [start, mid] as [THREE.Vector3, THREE.Vector3],
          targetPoints: [mid, end] as [THREE.Vector3, THREE.Vector3],
        },
      ];
    });
  }, [units]);

  if (links.length === 0) return null;

  return (
    <group renderOrder={4}>
      {links.map((link) => (
        <React.Fragment key={link.key}>
          <Line
            points={link.attackerPoints}
            color="#38bdf8"
            lineWidth={1.35}
            transparent
            opacity={0.88}
          />
          <Line
            points={link.targetPoints}
            color="#fb923c"
            lineWidth={1.35}
            transparent
            opacity={0.88}
          />
        </React.Fragment>
      ))}
    </group>
  );
}

// Translucent floor quads marking each player's configured deployment zones.
// Server-side validation uses the same normalized config and base footprint.
function DeploymentZones({
  config,
  mySide,
}: {
  config: DeploymentConfig;
  mySide: DeploymentSide | null;
}) {
  const renderSide = (side: DeploymentSide) => {
    const deployment = deploymentSideConfig(config, side);
    const own = mySide === side;
    return (
      <React.Fragment key={side}>
        {deployment.zones.map((zone, index) => {
          const width = zone.xMax - zone.xMin;
          const depth = zone.zMax - zone.zMin;
          return (
            <mesh
              key={`${side}-zone-${index}`}
              position={[
                (zone.xMin + zone.xMax) / 2,
                0.001,
                (zone.zMin + zone.zMax) / 2,
              ]}
              rotation={[-Math.PI / 2, 0, 0]}
              renderOrder={1}
            >
              <planeGeometry args={[width, depth]} />
              <meshBasicMaterial
                color={own ? "#f59e0b" : "#7c2d12"}
                transparent
                opacity={own ? 0.13 : 0.055}
                depthWrite={false}
              />
            </mesh>
          );
        })}
        {(deployment.exclusions ?? []).map((zone, index) => {
          const width = zone.xMax - zone.xMin;
          const depth = zone.zMax - zone.zMin;
          return (
            <mesh
              key={`${side}-exclusion-${index}`}
              position={[
                (zone.xMin + zone.xMax) / 2,
                0.003,
                (zone.zMin + zone.zMax) / 2,
              ]}
              rotation={[-Math.PI / 2, 0, 0]}
              renderOrder={2}
            >
              <planeGeometry args={[width, depth]} />
              <meshBasicMaterial
                color="#ef4444"
                transparent
                opacity={own ? 0.12 : 0.04}
                depthWrite={false}
              />
            </mesh>
          );
        })}
      </React.Fragment>
    );
  };

  return (
    <>
      {renderSide("challenger")}
      {renderSide("opponent")}
    </>
  );
}

function CarriedFighterDeploymentGuide({
  carrier,
  radius = carriedFighterDeployCenterRadius(),
}: {
  carrier: Pick<StagedUnitData, "x" | "z">;
  radius?: number;
}) {
  return (
    <group position={[carrier.x, 0, carrier.z]}>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.012, 0]}
        renderOrder={2}
      >
        <circleGeometry args={[radius, 80]} />
        <meshBasicMaterial
          color="#22d3ee"
          transparent
          opacity={0.08}
          depthWrite={false}
        />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.018, 0]}
        renderOrder={3}
      >
        <ringGeometry
          args={[Math.max(0.05, radius - 0.035), radius + 0.035, 96]}
        />
        <meshBasicMaterial
          color="#67e8f9"
          transparent
          opacity={0.72}
          depthWrite={false}
        />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.02, 0]}
        renderOrder={3}
      >
        <ringGeometry
          args={[Math.max(0.05, radius - 0.22), radius - 0.17, 96]}
        />
        <meshBasicMaterial
          color="#0891b2"
          transparent
          opacity={0.28}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function ShadowDispersalCohesionGuide({
  x,
  z,
  centerRadius,
}: {
  x: number;
  z: number;
  centerRadius: number;
}) {
  return (
    <group position={[x, 0, z]}>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.026, 0]}
        renderOrder={4}
      >
        <circleGeometry args={[centerRadius, 72]} />
        <meshBasicMaterial
          color="#a78bfa"
          transparent
          opacity={0.045}
          depthWrite={false}
        />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.03, 0]}
        renderOrder={5}
      >
        <ringGeometry
          args={[Math.max(0.05, centerRadius - 0.035), centerRadius + 0.035, 80]}
        />
        <meshBasicMaterial
          color="#c4b5fd"
          transparent
          opacity={0.68}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function EndPhaseFighterLaunchPreview({
  fighterModel,
  x,
  z,
  heading,
  legal,
  dogfightWarning = false,
  shipMeshTintsEnabled = true,
  label,
  invalidLabel,
}: {
  fighterModel: ShipModel;
  x: number;
  z: number;
  heading: number;
  legal: boolean;
  dogfightWarning?: boolean;
  shipMeshTintsEnabled?: boolean;
  label?: string;
  invalidLabel?: string;
}) {
  const color = !legal ? "#fb7185" : dogfightWarning ? "#d946ef" : "#67e8f9";
  const baseRadius = rulesBaseRadius({
    baseRadiusInches: fighterModel.baseRadiusInches,
  });
  const ringInner = Math.max(0.05, baseRadius - 0.05);
  const headingRad = (heading * Math.PI) / 180;

  return (
    <group position={[x, 0, z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]}>
        <circleGeometry args={[baseRadius, 48]} />
        <meshStandardMaterial
          color="#020617"
          transparent
          opacity={0.42}
          depthWrite={false}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.07, 0]}>
        <ringGeometry args={[ringInner, baseRadius + 0.1, 48]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={legal ? 0.75 : 0.55}
          transparent
          opacity={0.85}
          depthWrite={false}
        />
      </mesh>
      {legal && dogfightWarning && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.082, 0]}>
          <ringGeometry args={[baseRadius + 0.12, baseRadius + 0.3, 56]} />
          <meshStandardMaterial
            color="#a855f7"
            emissive="#d946ef"
            emissiveIntensity={1.05}
            transparent
            opacity={0.78}
            depthWrite={false}
          />
        </mesh>
      )}
      <group position={[0, 2, 0]} rotation={[0, headingRad, 0]}>
        <ModelErrorBoundary color={color}>
          <Suspense
            fallback={<ShipModelFallback color={color} opacity={0.55} />}
          >
            <BoardModelVisual
              filename={fighterModel.filename}
              tint={color}
              opacity={0.82}
              meshTintsEnabled={shipMeshTintsEnabled}
              ghostHighlight
            />
          </Suspense>
        </ModelErrorBoundary>
      </group>
      <CameraFacingText
        position={[0, 3.25, 0]}
        fontSize={0.26}
        color={!legal ? "#fecdd3" : dogfightWarning ? "#f5d0fe" : "#bae6fd"}
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.03}
        outlineColor="black"
      >
        {!legal
          ? invalidLabel ?? "Illegal"
          : label ?? (dogfightWarning ? "Dogfight" : "Place launch")}
      </CameraFacingText>
    </group>
  );
}

function DisplacedFighterPlacementPreview({
  x,
  z,
  baseRadiusInches,
  unit,
  legal = true,
  dogfightWarning = false,
  shipMeshTintsEnabled = true,
}: {
  x: number;
  z: number;
  baseRadiusInches?: number | null;
  unit?: {
    name: string;
    modelFilename: string;
    heading: number;
  } | null;
  legal?: boolean;
  dogfightWarning?: boolean;
  shipMeshTintsEnabled?: boolean;
}) {
  const baseRadius = rulesBaseRadius({ baseRadiusInches });
  const ringInner = Math.max(0.05, baseRadius - 0.05);
  const ringColor = !legal
    ? "#ef4444"
    : dogfightWarning
      ? "#d946ef"
      : "#38bdf8";
  const text = !legal ? "Illegal" : dogfightWarning ? "Dogfight" : "Preview";
  return (
    <group position={[x, 0, z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.065, 0]}>
        <circleGeometry args={[baseRadius, 48]} />
        <meshStandardMaterial
          color="#020617"
          transparent
          opacity={0.5}
          depthWrite={false}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.075, 0]}>
        <ringGeometry args={[ringInner, baseRadius + 0.1, 48]} />
        <meshStandardMaterial
          color={ringColor}
          emissive={ringColor}
          emissiveIntensity={0.85}
          transparent
          opacity={0.9}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[0, 0.1, baseRadius + 0.22]}>
        <boxGeometry args={[0.08, 0.06, 0.42]} />
        <meshBasicMaterial color={ringColor} transparent opacity={0.95} />
      </mesh>
      {dogfightWarning && legal && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.105, 0]}>
          <ringGeometry args={[baseRadius + 0.16, baseRadius + 0.3, 64]} />
          <meshBasicMaterial
            color="#d946ef"
            transparent
            opacity={0.8}
            depthWrite={false}
          />
        </mesh>
      )}
      {unit && (
        <group
          position={[0, 2, 0]}
          rotation={[0, (unit.heading * Math.PI) / 180, 0]}
        >
          <ModelErrorBoundary color={ringColor}>
            <Suspense fallback={<ShipModelFallback color={ringColor} />}>
              <BoardModelVisual
                filename={unit.modelFilename}
                tint={ringColor}
                opacity={legal ? 0.9 : 0.55}
                meshTintsEnabled={shipMeshTintsEnabled}
              />
            </Suspense>
          </ModelErrorBoundary>
        </group>
      )}
      <CameraFacingText
        position={[0, unit ? 3.35 : 0.8, 0]}
        fontSize={0.22}
        color={legal ? (dogfightWarning ? "#f5d0fe" : "#bae6fd") : "#fecaca"}
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.03}
        outlineColor="black"
      >
        {text}
      </CameraFacingText>
    </group>
  );
}

function BoardBoundary() {
  const geo = useMemo(() => {
    const hw = BOARD_W / 2; // 24
    const hd = BOARD_D / 2; // 36
    const pts = [
      new THREE.Vector3(-hw, 0, -hd),
      new THREE.Vector3(hw, 0, -hd),
      new THREE.Vector3(hw, 0, hd),
      new THREE.Vector3(-hw, 0, hd),
      new THREE.Vector3(-hw, 0, -hd),
    ];
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, []);

  return (
    // @ts-ignore – R3F line primitive
    <line geometry={geo}>
      <lineBasicMaterial color="#f59e0b" />
    </line>
  );
}

// Compute a uniform scale so the model's longest horizontal dimension = targetInches world units
function shipScale(object: THREE.Object3D, targetInches = 2): number {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxH = Math.max(size.x, size.z);
  return maxH > 0 ? targetInches / maxH : 1;
}

// OBJ: geometry-only load (no MTL — we apply tint via MeshStandardMaterial)
function ObjModel({
  url,
  tint,
  opacity = 1,
  meshTintsEnabled = true,
}: {
  url: string;
  tint: string;
  opacity?: number;
  meshTintsEnabled?: boolean;
}) {
  const obj = useLoader(OBJLoader, url) as THREE.Group;
  const { cloned, s } = useMemo(() => {
    const c = obj.clone(true);
    c.traverse((child: any) => {
      if (!child.isMesh) return;
      // material may be a single material or an array — normalise to array
      const mats: any[] = Array.isArray(child.material)
        ? child.material
        : [child.material];
      const tinted = mats.map((m: any) => {
        if (!meshTintsEnabled) {
          if (!m)
            return new THREE.MeshStandardMaterial({
              color: "#d1d5db",
              metalness: 0.3,
              roughness: 0.6,
              transparent: opacity < 1,
              opacity,
            });
          const clonedMat = m.clone();
          clonedMat.transparent = opacity < 1;
          clonedMat.opacity = opacity;
          return clonedMat;
        }
        if (!m)
          return new THREE.MeshStandardMaterial({
            color: tint,
            metalness: 0.3,
            roughness: 0.6,
            transparent: opacity < 1,
            opacity,
          });
        if (m.map) {
          const clonedMat = m.clone();
          clonedMat.emissive = new THREE.Color(tint);
          clonedMat.emissiveIntensity = 0.12;
          clonedMat.transparent = opacity < 1;
          clonedMat.opacity = opacity;
          return clonedMat;
        }
        return new THREE.MeshStandardMaterial({
          color: tint,
          metalness: 0.3,
          roughness: 0.6,
          transparent: opacity < 1,
          opacity,
        });
      });
      child.material = Array.isArray(child.material) ? tinted : tinted[0];
    });
    return { cloned: c, s: shipScale(c) };
  }, [obj, tint, opacity, meshTintsEnabled]);
  return <primitive object={cloned} scale={[s, s, s]} />;
}

// GLB: keep original embedded textures; apply a gentle emissive tint for team color.
// Models must be exported nose-along-local-+Z per the Model orientation spec
// in replit.md. FLIP_MODELS is kept as an (empty) set so the render-time and
// arc-math fallbacks below remain available for any one-off legacy upload, but
// the canonical fix is to re-export the model with correct orientation.
const FLIP_MODELS: Set<string> = new Set();
const OMEGA_ROTATING_MODEL_FILENAME = "omega3.glb";
const COMMAND_OMEGA_MODEL_FILENAME = "command-omega3.glb";
const OMEGA_X_MODEL_FILENAME = "omega-x.glb";
const EXPLORER_ROTATING_MODEL_FILENAME = "explorer.glb";
const PSI_CORPS_MOTHERSHIP_MODEL_FILENAME = "psicorpmother.glb";
const ORION_SPACE_STATION_MODEL_FILENAME = "orion-space-station.glb";
const COMMAND_HYPERION_MODEL_FILENAME = "command-hyperion.glb";
const DEAD_BATTLECRAB_MODEL_FILENAME = "dead-battlecrab.glb";
const RAILGUN_HYPERION_MODEL_FILENAME = "railgun-hyperion.glb";
const DEAD_BINTAK_MODEL_FILENAME = "dead-bintak.glb";
const DEAD_HYPERION_MODEL_FILENAME = "dead-hyperion.glb";
const DEAD_OMEGA_MODEL_FILENAME = "dead-omega.glb";
const RAIDER_CARRIER_MODEL_FILENAME = "raider-carrier.glb";
const RAIDER_DELTA_MODEL_FILENAME = "raider-delta.glb";
const RAIDER_FREIGHTER_MODEL_FILENAME = "raider-freighter.glb";
const RAIDER_NOVA_MODEL_FILENAME = "raider-nova.glb";
const SHADOW_SCOUT_MODEL_FILENAME = "shadow-scout.glb";
const VORLON_FIGHTER_MODEL_FILENAME = "vorlon-fighter.glb";
const VORLON_LIGHT_CRUISER_MODEL_FILENAME = "vorlon-light-cruiser.glb";
const VORLON_TRANSPORT_MODEL_FILENAME = "vorlon-transport.glb";
const DEFAULT_VISUAL_MODEL_FILENAMES: Record<string, string> = {
  "kirishiac1.glb": "kirishiac.glb",
  "omega.glb": OMEGA_ROTATING_MODEL_FILENAME,
};
const ROTATING_MODEL_PARTS: Record<
  string,
  {
    nodeName: string;
    axis: "x" | "y" | "z";
    secondsPerRotation: number;
    pivotModelPosition?: [number, number, number];
    rotationMode?: "euler" | "local-axis";
  }
> = {
  [OMEGA_ROTATING_MODEL_FILENAME]: {
    nodeName: "omg_rotator",
    // Blender Y is exported as this bone's local Z in glTF/Three.js.
    axis: "z",
    secondsPerRotation: 30,
    rotationMode: "local-axis",
  },
  [COMMAND_OMEGA_MODEL_FILENAME]: {
    nodeName: "omg_rotator",
    // Blender Y is exported as this bone's local Z in glTF/Three.js.
    axis: "z",
    secondsPerRotation: 30,
    rotationMode: "local-axis",
  },
  [OMEGA_X_MODEL_FILENAME]: {
    nodeName: "omg_rotator",
    // Blender Y is exported as this bone's local Z in glTF/Three.js.
    axis: "z",
    secondsPerRotation: 30,
    rotationMode: "local-axis",
  },
  [EXPLORER_ROTATING_MODEL_FILENAME]: {
    nodeName: "explorerRotate",
    // Blender Y is exported as this bone's local Z in glTF/Three.js.
    axis: "z",
    secondsPerRotation: 30,
  },
  [PSI_CORPS_MOTHERSHIP_MODEL_FILENAME]: {
    nodeName: "rotate_psihull",
    // This armature uses the same Blender Y -> glTF local Z export as Explorer.
    axis: "z",
    secondsPerRotation: 30,
    // Weighted center of the rotating hull section. The exported bone origin is
    // offset from this point, causing the section to orbit instead of spin.
    pivotModelPosition: [-0.9458505291, 2.1391551393, -0.1529859525],
  },
  [RAIDER_CARRIER_MODEL_FILENAME]: {
    nodeName: "rotator_raider",
    // Blender Y is exported as this bone's local Z in glTF/Three.js.
    axis: "z",
    secondsPerRotation: 30,
    pivotModelPosition: [0.0001, 0.9, -50.65],
  },
  [ORION_SPACE_STATION_MODEL_FILENAME]: {
    nodeName: "orion_rotate",
    // Preserve the exported bind rotation and spin around the bone's Blender Y axis.
    axis: "y",
    secondsPerRotation: 30,
    rotationMode: "local-axis",
  },
};
const DEAD_MODEL_FILENAMES: Record<string, string> = {
  "battlecrab.glb": DEAD_BATTLECRAB_MODEL_FILENAME,
  "hyperion.glb": DEAD_HYPERION_MODEL_FILENAME,
  [COMMAND_HYPERION_MODEL_FILENAME]: DEAD_HYPERION_MODEL_FILENAME,
  "missile-hyperion.glb": DEAD_HYPERION_MODEL_FILENAME,
  [RAILGUN_HYPERION_MODEL_FILENAME]: DEAD_HYPERION_MODEL_FILENAME,
  "omega.glb": DEAD_OMEGA_MODEL_FILENAME,
  [OMEGA_ROTATING_MODEL_FILENAME]: DEAD_OMEGA_MODEL_FILENAME,
  [COMMAND_OMEGA_MODEL_FILENAME]: DEAD_OMEGA_MODEL_FILENAME,
  [OMEGA_X_MODEL_FILENAME]: DEAD_OMEGA_MODEL_FILENAME,
  "bintak.glb": DEAD_BINTAK_MODEL_FILENAME,
};
const VISUAL_ROTATE_180_MODELS = new Set([
  OMEGA_ROTATING_MODEL_FILENAME,
  COMMAND_OMEGA_MODEL_FILENAME,
  OMEGA_X_MODEL_FILENAME,
  EXPLORER_ROTATING_MODEL_FILENAME,
  PSI_CORPS_MOTHERSHIP_MODEL_FILENAME,
  COMMAND_HYPERION_MODEL_FILENAME,
  RAIDER_CARRIER_MODEL_FILENAME,
  "black-omega.glb",
  "aurora.glb",
  "thunderbolt.glb",
  "tiger.glb",
  "nial.glb",
  "flyer.glb",
  "battlecrab.glb",
  DEAD_BATTLECRAB_MODEL_FILENAME,
  "primus.glb",
  "whitestar.glb",
  "avenger.glb",
  "tloth.glb",
  "olympus-gunship.glb",
  "orestes.glb",
  "rongoth.glb",
  "frazi.glb",
  "spitfire.glb",
  RAIDER_DELTA_MODEL_FILENAME,
  RAIDER_FREIGHTER_MODEL_FILENAME,
]);
const MODEL_SCALE_MULTIPLIERS: Record<string, number> = {
  "hyperion.glb": 1.2,
  [COMMAND_HYPERION_MODEL_FILENAME]: 1.2,
  "missile-hyperion.glb": 1.2,
  [RAILGUN_HYPERION_MODEL_FILENAME]: 1.2,
  "avenger.glb": 1.2,
  "olympus.glb": 0.5,
  "olympus-gunship.glb": 0.5,
  "artemis.glb": 0.5,
  [EXPLORER_ROTATING_MODEL_FILENAME]: 2,
  "omega.glb": 1.5,
  "nova.glb": 1.15,
  [RAIDER_NOVA_MODEL_FILENAME]: 1.15,
  "orestes.glb": 1.65,
  "tethys.glb": 0.4,
  "vorchan.glb": 0.5,
  "covran.glb": 0.5,
  "whitestar.glb": 0.5,
  "oracle.glb": 0.5,
  "sagittarius.glb": 0.5,
  "gquan.glb": 1.5,
  "bintak.glb": 1.75,
  "rongoth.glb": 0.8,
  "primus.glb": 1.875,
  "sharlin.glb": 1.5,
  "avioki.glb": 1.5,
  "battlecrab.glb": 1.5,
  [RAIDER_CARRIER_MODEL_FILENAME]: 0.75,
  [SHADOW_SCOUT_MODEL_FILENAME]: 0.42,
  "vorlon-dreadnought.glb": 1.5,
  [VORLON_LIGHT_CRUISER_MODEL_FILENAME]: 1.2,
  [VORLON_TRANSPORT_MODEL_FILENAME]: 0.6,
  "kirishiac.glb": 0.45,
  "kirishiac1.glb": 0.45,
  [ORION_SPACE_STATION_MODEL_FILENAME]: 3,
  [DEAD_BATTLECRAB_MODEL_FILENAME]: 0.975,
  [DEAD_BINTAK_MODEL_FILENAME]: 1.75,
  [DEAD_HYPERION_MODEL_FILENAME]: 1.2,
  [DEAD_OMEGA_MODEL_FILENAME]: 1.5,
  "aurora.glb": 0.165,
  "black-omega.glb": 0.165,
  "thunderbolt.glb": 0.165,
  "tiger.glb": 0.165,
  "nial.glb": 0.165,
  "flyer.glb": 0.165,
  "sentri.glb": 0.165,
  "frazi.glb": 0.165,
  "spitfire.glb": 0.165,
  [RAIDER_DELTA_MODEL_FILENAME]: 0.165,
  [VORLON_FIGHTER_MODEL_FILENAME]: 0.165,
};
const MODEL_ABSOLUTE_SCALES: Record<string, number> = {
  "kirishiac.glb": 0.078,
  "kirishiac1.glb": 0.078,
  [OMEGA_ROTATING_MODEL_FILENAME]: 0.00286936,
  [COMMAND_OMEGA_MODEL_FILENAME]: 0.00286936,
  [OMEGA_X_MODEL_FILENAME]: 0.00277311,
  [PSI_CORPS_MOTHERSHIP_MODEL_FILENAME]: 0.00300057,
  [RAIDER_FREIGHTER_MODEL_FILENAME]: 0.00475,
};
const MODEL_VISUAL_Y_OFFSETS: Record<string, number> = {
  [ORION_SPACE_STATION_MODEL_FILENAME]: 2,
  "kirishiac.glb": 0.08,
  "kirishiac1.glb": 0.08,
};
const MODEL_CENTER_ON_HORIZONTAL_BOUNDS = new Set([
  "kirishiac.glb",
  "kirishiac1.glb",
]);
const FIGHTER_SQUADRON_MODELS = new Set([
  "aurora.glb",
  "black-omega.glb",
  "thunderbolt.glb",
  "tiger.glb",
  "nial.glb",
  "flyer.glb",
  "sentri.glb",
  "frazi.glb",
  "spitfire.glb",
  RAIDER_DELTA_MODEL_FILENAME,
  VORLON_FIGHTER_MODEL_FILENAME,
]);
const FIGHTER_SQUADRON_CANONICAL_FILENAMES: Record<string, string> = {
  aurora: "aurora.glb",
  "black omega": "black-omega.glb",
  "black-omega": "black-omega.glb",
  blackomega: "black-omega.glb",
  "psi corps starfury": "black-omega.glb",
  "psi-corps starfury": "black-omega.glb",
  "psicorp starfury": "black-omega.glb",
  thunderbolt: "thunderbolt.glb",
  tiger: "tiger.glb",
  nial: "nial.glb",
  flyer: "flyer.glb",
  sentri: "sentri.glb",
  frazi: "frazi.glb",
  spitfire: "spitfire.glb",
  "shadow fighter": "spitfire.glb",
  "delta-v": RAIDER_DELTA_MODEL_FILENAME,
  "delta v": RAIDER_DELTA_MODEL_FILENAME,
  "raider delta": RAIDER_DELTA_MODEL_FILENAME,
  "raider-delta": RAIDER_DELTA_MODEL_FILENAME,
  zephyr: RAIDER_DELTA_MODEL_FILENAME,
  "vorlon fighter": VORLON_FIGHTER_MODEL_FILENAME,
  "vorlon fighter flight": VORLON_FIGHTER_MODEL_FILENAME,
  "vorlon fighter wing": VORLON_FIGHTER_MODEL_FILENAME,
};
const FIGHTER_IDENTITY_PATTERN =
  /\b(?:aurora|thunderbolt|tiger|black[-\s]?omega|nial|flyer|sentri|frazi|spitfire|delta[-\s]?v|raider[-\s]?delta|zephyr|vorlon\s+fighter)\b/i;
const FIGHTER_SQUADRON_OFFSETS: Array<{ x: number; z: number; yaw: number }> = [
  { x: 0, z: 0.24, yaw: 0 },
  { x: -0.3, z: -0.22, yaw: 0.12 },
  { x: 0.3, z: -0.22, yaw: -0.12 },
];

function modelScaleMultiplier(filename: string): number {
  return MODEL_SCALE_MULTIPLIERS[filename.toLowerCase()] ?? 1;
}

function modelAbsoluteScale(filename: string): number | null {
  return MODEL_ABSOLUTE_SCALES[filename.toLowerCase()] ?? null;
}

function modelRequiresSkeletonClone(filename: string): boolean {
  const key = filename.toLowerCase();
  return key === "kirishiac.glb" || key === "kirishiac1.glb";
}

function isKirishiacModelFilename(filename: string): boolean {
  const key = filename.toLowerCase();
  return key === "kirishiac.glb" || key === "kirishiac1.glb";
}

function createKirishiacRotatorWeightMaskMaterial(
  sourceMaterial: THREE.Material,
  mode: "static" | "rotating",
  rotatorJointIndex = 2,
): THREE.Material {
  const maskedMaterial = sourceMaterial.clone();
  const rotatorJointIndexLiteral = Number.isFinite(rotatorJointIndex)
    ? rotatorJointIndex.toFixed(1)
    : "2.0";
  maskedMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `#include <common>
      varying float vKirishiacRotatorWeight;`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <skinbase_vertex>",
      `vKirishiacRotatorWeight = 0.0;
      vKirishiacRotatorWeight += skinWeight.x * (1.0 - step(0.5, abs(skinIndex.x - ${rotatorJointIndexLiteral})));
      vKirishiacRotatorWeight += skinWeight.y * (1.0 - step(0.5, abs(skinIndex.y - ${rotatorJointIndexLiteral})));
      vKirishiacRotatorWeight += skinWeight.z * (1.0 - step(0.5, abs(skinIndex.z - ${rotatorJointIndexLiteral})));
      vKirishiacRotatorWeight += skinWeight.w * (1.0 - step(0.5, abs(skinIndex.w - ${rotatorJointIndexLiteral})));
      #include <skinbase_vertex>`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>
      varying float vKirishiacRotatorWeight;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      `void main() {
      ${
        mode === "static"
          ? "if (vKirishiacRotatorWeight > 0.5) discard;"
          : "if (vKirishiacRotatorWeight <= 0.5) discard;"
      }`,
    );
  };
  maskedMaterial.customProgramCacheKey = () =>
    `kirishiac-live-${mode}-${rotatorJointIndexLiteral}-rotator-weight-mask`;
  return maskedMaterial;
}

function modelVisualYOffset(filename: string): number {
  return MODEL_VISUAL_Y_OFFSETS[filename.toLowerCase()] ?? 0;
}

function visualModelFilenameForUnit(unit: {
  modelFilename: string;
  isDestroyed: boolean;
  damageState?: string | null;
}): string {
  const shouldUseDeadMesh =
    unit.isDestroyed || unit.damageState === "destroyed";
  const modelFilenameKey = unit.modelFilename.toLowerCase();
  if (
    unit.damageState === "adrift" &&
    (
      modelFilenameKey === "omega.glb" ||
      modelFilenameKey === OMEGA_ROTATING_MODEL_FILENAME ||
      modelFilenameKey === COMMAND_OMEGA_MODEL_FILENAME
    )
  ) {
    return "omega.glb";
  }
  if (!shouldUseDeadMesh) {
    return DEFAULT_VISUAL_MODEL_FILENAMES[modelFilenameKey] ?? unit.modelFilename;
  }
  const deadFilename = DEAD_MODEL_FILENAMES[modelFilenameKey];
  if (deadFilename) return deadFilename;
  return unit.modelFilename;
}

function unitIsCombatEffective(unit: {
  isDestroyed: boolean;
  hullPoints: number;
  crewPoints?: number | null;
  maxCrewPoints?: number | null;
}): boolean {
  return (
    !unit.isDestroyed &&
    unit.hullPoints > 0 &&
    ((unit.maxCrewPoints ?? 0) <= 0 || (unit.crewPoints ?? 0) > 0)
  );
}

type DamageVfxAnchor = {
  name: string;
  position: [number, number, number];
};

type BoardSmokeTuning = {
  color: string;
  secondaryColor: string;
  speed: number;
  size: number;
  fade: number;
  intensity: number;
  spread: number;
  count: number;
  arc: number;
  thickness: number;
};

const BOARD_SMOKE_TEXTURE_FILENAME = "cloud01-8x8.webp";
const BOARD_GAS_CLOUD_TEXTURE_FILENAMES = [
  "cloud01-8x8.webp",
  "cloud02-8x8.webp",
  "cloud03-8x8.webp",
  "cloud04-8x8.webp",
] as const;
const BOARD_DUST_CLOUD_TEXTURE_FILENAMES = [
  "wispy-smoke01-8x8.webp",
  "wispy-smoke02-8x8.webp",
  "wispy-smoke03-8x8.webp",
  "wispy-smoke03b-8x8.webp",
] as const;
const BOARD_PRAXIS_TEXTURE_FILENAME = "praxis.png";
const ORGANIC_BATTLECRAB_MODEL_FILENAME = "battlecrab.glb";
const ORGANIC_SHADOW_MODEL_FILENAMES = new Set([
  ORGANIC_BATTLECRAB_MODEL_FILENAME,
  SHADOW_SCOUT_MODEL_FILENAME,
  "spitfire.glb",
]);
const SELECTIVE_ORGANIC_SHADOW_MATERIAL_MODELS = new Set([
  OMEGA_X_MODEL_FILENAME,
]);
const SHADOW_FLESH_MATERIAL_NAME = "shadow flesh";
const ORGANIC_BATTLECRAB_TUNING = {
  speed: 2,
  intensity: 1.19,
  spread: 1.15,
  normalStrength: 0.9,
} as const;
const BOARD_TEXTURE_ASSET_REVISIONS: Record<string, string> = {
  "cloud01-8x8.webp": "20260725-cloud01-tga",
  "cloud02-8x8.webp": "20260725-cloud02-tga",
  "cloud03-8x8.webp": "20260725-cloud03-tga",
  "cloud04-8x8.webp": "20260725-cloud04-tga",
  "wispy-smoke01-8x8.webp": "20260730-wispy01-tga",
  "wispy-smoke02-8x8.webp": "20260730-wispy02-tga",
  "wispy-smoke03-8x8.webp": "20260730-wispy03-tga",
  "wispy-smoke03b-8x8.webp": "20260730-wispy03b-tga",
  [BOARD_PRAXIS_TEXTURE_FILENAME]: "20260720-120000",
  "shadow_flesh_base_tile.png": "20260720-organic-v1",
  "shadow_flesh_normal.png": "20260720-organic-v1",
  "shadow_flesh_roughness.png": "20260720-organic-v1",
  "T_FirePanningCyl45.png": "20260722-hard-plasma",
  "T_Noise1_nk.png": "20260722-hard-plasma",
  "T_Noise_HU85k.png": "20260722-hard-plasma",
  "weapon-damage-arc.png": "20260730-weapon-arc-damage-v1",
  "weapon-offline-arc.png": "20260730-weapon-arc-offline-v1",
};
const DEFAULT_BOARD_SMOKE_TUNING: BoardSmokeTuning = {
  color: "#f8fafc",
  secondaryColor: "#f97316",
  speed: 2.45,
  size: 0.25,
  fade: 1.3,
  intensity: 1.35,
  spread: 0.3,
  count: 5,
  arc: 0.35,
  thickness: 0.95,
};

function clampSmokeValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function boardTextureUrl(filename: string): string {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const revision =
    BOARD_TEXTURE_ASSET_REVISIONS[filename.toLowerCase()] ?? APP_BUILD_SHA;
  return `${basePath}/api/textures/${filename}?v=${encodeURIComponent(revision)}`;
}

function terrainVisualSeededUnit(seed: number, index: number): number {
  const value = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

type OrganicBattlecrabShader = {
  uniforms: Record<string, { value: number }>;
};

function configureOrganicBattlecrabTexture(
  texture: THREE.Texture,
  colorSpace: THREE.ColorSpace,
) {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.flipY = false;
  texture.colorSpace = colorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
}

function OrganicBattlecrabGlbModel({
  url,
  filename,
  opacity,
}: {
  url: string;
  filename: string;
  opacity: number;
}) {
  const { scene } = useGLTF(url);
  const [baseTexture, normalTexture, roughnessTexture] = useLoader(
    THREE.TextureLoader,
    [
      boardTextureUrl("shadow_flesh_base_tile.png"),
      boardTextureUrl("shadow_flesh_normal.png"),
      boardTextureUrl("shadow_flesh_roughness.png"),
    ],
  ) as THREE.Texture[];
  const elapsedRef = useRef(0);
  const shaderRefs = useRef<OrganicBattlecrabShader[]>([]);

  const organic = useMemo(() => {
    configureOrganicBattlecrabTexture(baseTexture, THREE.SRGBColorSpace);
    configureOrganicBattlecrabTexture(normalTexture, THREE.NoColorSpace);
    configureOrganicBattlecrabTexture(roughnessTexture, THREE.NoColorSpace);
    normalTexture.repeat.set(
      ORGANIC_BATTLECRAB_TUNING.spread,
      ORGANIC_BATTLECRAB_TUNING.spread,
    );
    roughnessTexture.repeat.copy(normalTexture.repeat);

    const cloned = scene.clone(true);
    const materials: THREE.MeshStandardMaterial[] = [];
    shaderRefs.current = [];
    cloned.traverse((child: any) => {
      if (!child.isMesh) return;
      child.castShadow = true;
      child.receiveShadow = true;
      const material = new THREE.MeshStandardMaterial({
        color: "#ffffff",
        map: baseTexture,
        normalMap: normalTexture,
        normalScale: new THREE.Vector2(
          ORGANIC_BATTLECRAB_TUNING.normalStrength,
          ORGANIC_BATTLECRAB_TUNING.normalStrength,
        ),
        roughness: 0.86,
        roughnessMap: roughnessTexture,
        metalness: 0,
        side: THREE.DoubleSide,
        transparent: opacity < 1,
        opacity,
      });
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uOrganicTime = { value: elapsedRef.current };
        shader.fragmentShader = shader.fragmentShader.replace(
          "void main() {",
          `
uniform float uOrganicTime;

void main() {
          `,
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <map_fragment>",
          `
#ifdef USE_MAP
  vec2 organicUv = vMapUv * ${ORGANIC_BATTLECRAB_TUNING.spread.toFixed(2)};
  float organicTravel = uOrganicTime
    * ${ORGANIC_BATTLECRAB_TUNING.speed.toFixed(2)}
    * ${ORGANIC_BATTLECRAB_TUNING.intensity.toFixed(2)};
  vec2 organicDrift = vec2(0.018, 0.006) * organicTravel;
  vec4 sampledDiffuseColor = texture2D(map, organicUv + organicDrift);
  float organicGray = dot(
    sampledDiffuseColor.rgb,
    vec3(0.2126, 0.7152, 0.0722)
  );
  organicGray = clamp(organicGray * 1.42 + 0.01, 0.0, 0.72);
  sampledDiffuseColor.rgb = vec3(organicGray);
  diffuseColor *= sampledDiffuseColor;
#endif
          `,
        );
        shaderRefs.current.push(shader as OrganicBattlecrabShader);
      };
      material.customProgramCacheKey = () =>
        "live-battlecrab-organic-single-drift-v1";
      materials.push(material);
      child.material = material;
    });

    const bounds = new THREE.Box3().setFromObject(cloned);
    const center = bounds.getCenter(new THREE.Vector3());
    const originOffset = new THREE.Vector3(-center.x, -bounds.min.y, -center.z);
    return { cloned, materials, originOffset };
  }, [baseTexture, normalTexture, opacity, roughnessTexture, scene]);

  useEffect(
    () => () => organic.materials.forEach((material) => material.dispose()),
    [organic],
  );

  useFrame((_, delta) => {
    elapsedRef.current += delta;
    for (const shader of shaderRefs.current) {
      shader.uniforms.uOrganicTime.value = elapsedRef.current;
    }
    const travel =
      elapsedRef.current *
      ORGANIC_BATTLECRAB_TUNING.speed *
      ORGANIC_BATTLECRAB_TUNING.intensity;
    normalTexture.offset.set(travel * 0.018, travel * 0.006);
    roughnessTexture.offset.copy(normalTexture.offset);
  });

  const scale = useMemo(
    () => shipScale(organic.cloned) * modelScaleMultiplier(filename),
    [filename, organic.cloned],
  );
  const visualFlip = VISUAL_ROTATE_180_MODELS.has(filename.toLowerCase());
  return (
    <group
      scale={[scale, scale, scale]}
      rotation={[0, visualFlip ? Math.PI : 0, 0]}
    >
      <primitive object={organic.cloned} position={organic.originOffset} />
    </group>
  );
}

function readEulerAxis(rotation: THREE.Euler, axis: "x" | "y" | "z"): number {
  if (axis === "x") return rotation.x;
  if (axis === "y") return rotation.y;
  return rotation.z;
}

function writeEulerAxis(
  rotation: THREE.Euler,
  axis: "x" | "y" | "z",
  value: number,
) {
  if (axis === "x") {
    rotation.x = value;
  } else if (axis === "y") {
    rotation.y = value;
  } else {
    rotation.z = value;
  }
}

function applyRotatingPartPivotOverride(
  root: THREE.Object3D,
  rotatingPart: THREE.Object3D,
  pivotModelPosition?: [number, number, number],
) {
  if (!pivotModelPosition || !rotatingPart.parent) return;
  root.updateMatrixWorld(true);
  const targetWorld = new THREE.Vector3(...pivotModelPosition);
  root.localToWorld(targetWorld);
  rotatingPart.position.copy(rotatingPart.parent.worldToLocal(targetWorld));
  root.updateMatrixWorld(true);

  const patchedSkeletons = new Set<THREE.Skeleton>();
  root.traverse((child: any) => {
    const skeleton = child.isSkinnedMesh ? child.skeleton as THREE.Skeleton : null;
    if (!skeleton || patchedSkeletons.has(skeleton)) return;
    if (!skeleton.bones.includes(rotatingPart as THREE.Bone)) return;
    skeleton.calculateInverses();
    patchedSkeletons.add(skeleton);
  });
}

function applyObjectMaterialOpacity(root: THREE.Object3D, opacity: number) {
  root.traverse((child: any) => {
    if (!child.isMesh) return;
    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];
    for (const material of materials) {
      if (!material) continue;
      material.transparent = opacity < 0.999;
      material.opacity = opacity;
      material.depthWrite = opacity >= 0.999;
      material.needsUpdate = true;
    }
  });
}

function GlbModel({
  url,
  tint,
  filename,
  opacity = 1,
  meshTintsEnabled = true,
  damageAnchorEffects = false,
  terrainMeshHighlight = false,
  ghostHighlight = false,
}: {
  url: string;
  tint: string;
  filename: string;
  opacity?: number;
  meshTintsEnabled?: boolean;
  damageAnchorEffects?: boolean;
  terrainMeshHighlight?: boolean;
  ghostHighlight?: boolean;
}) {
  const { scene } = useGLTF(url);
  const filenameKey = filename.toLowerCase();
  const rotatingPartConfig = ROTATING_MODEL_PARTS[filenameKey];
  const kirishiacLayeredRotation = isKirishiacModelFilename(filenameKey);
  const useSelectiveOrganicShadowMaterial =
    SELECTIVE_ORGANIC_SHADOW_MATERIAL_MODELS.has(filenameKey);
  const [organicBaseTexture, organicNormalTexture, organicRoughnessTexture] =
    useLoader(THREE.TextureLoader, [
      boardTextureUrl("shadow_flesh_base_tile.png"),
      boardTextureUrl("shadow_flesh_normal.png"),
      boardTextureUrl("shadow_flesh_roughness.png"),
    ]) as THREE.Texture[];
  const rotatingPartRef = useRef<THREE.Object3D | null>(null);
  const kirishiacRotatingLayerRef = useRef<THREE.Object3D | null>(null);
  const rotatingPartInitialRotationRef = useRef(0);
  const rotatingPartInitialQuaternionRef = useRef(new THREE.Quaternion());
  const rotatingPartDeltaQuaternionRef = useRef(new THREE.Quaternion());
  const rotatingPartLocalAxisRef = useRef(new THREE.Vector3(0, 1, 0));
  const selectiveOrganicElapsedRef = useRef(0);
  const selectiveOrganicShaderRefs = useRef<OrganicBattlecrabShader[]>([]);
  const { cloned, anchors, selectiveOrganicMaterials } = useMemo(() => {
    rotatingPartRef.current = null;
    kirishiacRotatingLayerRef.current = null;
    rotatingPartInitialRotationRef.current = 0;
    selectiveOrganicShaderRefs.current = [];
    const anchorNodes: THREE.Object3D[] = [];
    const organicMaterials: THREE.MeshStandardMaterial[] = [];
    if (useSelectiveOrganicShadowMaterial) {
      configureOrganicBattlecrabTexture(organicBaseTexture, THREE.SRGBColorSpace);
      configureOrganicBattlecrabTexture(organicNormalTexture, THREE.NoColorSpace);
      configureOrganicBattlecrabTexture(organicRoughnessTexture, THREE.NoColorSpace);
      organicNormalTexture.repeat.set(
        ORGANIC_BATTLECRAB_TUNING.spread,
        ORGANIC_BATTLECRAB_TUNING.spread,
      );
      organicRoughnessTexture.repeat.copy(organicNormalTexture.repeat);
    }
    const createSelectiveOrganicShadowMaterial = () => {
      const material = new THREE.MeshStandardMaterial({
        color: "#ffffff",
        map: organicBaseTexture,
        normalMap: organicNormalTexture,
        normalScale: new THREE.Vector2(
          ORGANIC_BATTLECRAB_TUNING.normalStrength,
          ORGANIC_BATTLECRAB_TUNING.normalStrength,
        ),
        roughness: 0.86,
        roughnessMap: organicRoughnessTexture,
        metalness: 0,
        side: THREE.DoubleSide,
        transparent: opacity < 1,
        opacity,
      });
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uOrganicTime = {
          value: selectiveOrganicElapsedRef.current,
        };
        shader.fragmentShader = shader.fragmentShader.replace(
          "void main() {",
          `
uniform float uOrganicTime;

void main() {
          `,
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <map_fragment>",
          `
#ifdef USE_MAP
  vec2 organicUv = vMapUv * ${ORGANIC_BATTLECRAB_TUNING.spread.toFixed(2)};
  float organicTravel = uOrganicTime
    * ${ORGANIC_BATTLECRAB_TUNING.speed.toFixed(2)}
    * ${ORGANIC_BATTLECRAB_TUNING.intensity.toFixed(2)};
  vec2 organicDrift = vec2(0.018, 0.006) * organicTravel;
  vec4 sampledDiffuseColor = texture2D(map, organicUv + organicDrift);
  float organicGray = dot(
    sampledDiffuseColor.rgb,
    vec3(0.2126, 0.7152, 0.0722)
  );
  organicGray = clamp(organicGray * 1.42 + 0.01, 0.0, 0.72);
  sampledDiffuseColor.rgb = vec3(organicGray);
  diffuseColor *= sampledDiffuseColor;
#endif
          `,
        );
        selectiveOrganicShaderRefs.current.push(
          shader as OrganicBattlecrabShader,
        );
      };
      material.customProgramCacheKey = () =>
        "live-selective-shadow-organic-single-drift-v1";
      organicMaterials.push(material);
      return material;
    };
    const cloneShipMaterial = (
      material: THREE.Material | undefined,
      maskMode?: "static" | "rotating",
      rotatorJointIndex?: number,
    ) => {
      const materialName = String(material?.name ?? "").toLowerCase();
      if (
        useSelectiveOrganicShadowMaterial &&
        materialName.includes(SHADOW_FLESH_MATERIAL_NAME)
      ) {
        return createSelectiveOrganicShadowMaterial();
      }
      const isKirishiacSpikeMaterial =
        kirishiacLayeredRotation && materialName.includes("kirishiac flame");
      const clonedMaterial = material?.clone
        ? material.clone()
        : new THREE.MeshStandardMaterial({ color: "#d1d5db" });
      if (terrainMeshHighlight && "color" in clonedMaterial) {
        const colorMaterial = clonedMaterial as THREE.Material & { color?: THREE.Color };
        if (colorMaterial.color instanceof THREE.Color) {
          colorMaterial.color = colorMaterial.color.clone().lerp(new THREE.Color("#030712"), 0.88);
        }
      }
      if (isKirishiacSpikeMaterial) {
        const spikeMaterial = clonedMaterial as THREE.MeshStandardMaterial;
        if (spikeMaterial.color instanceof THREE.Color) {
          spikeMaterial.color = spikeMaterial.color.clone().lerp(new THREE.Color("#fff7ad"), 0.34);
        }
        if (spikeMaterial.emissive instanceof THREE.Color) {
          spikeMaterial.emissive = new THREE.Color("#fff7ad");
          spikeMaterial.emissiveIntensity = 6.5;
        }
        clonedMaterial.toneMapped = false;
      } else if (
        (meshTintsEnabled || ghostHighlight) &&
        "emissive" in clonedMaterial
      ) {
        (clonedMaterial as THREE.MeshStandardMaterial).emissive =
          new THREE.Color(terrainMeshHighlight ? "#030712" : tint);
        (clonedMaterial as THREE.MeshStandardMaterial).emissiveIntensity =
          terrainMeshHighlight ? 0.64 : ghostHighlight ? 1.15 : 0.18;
        if (
          ghostHighlight &&
          "color" in clonedMaterial &&
          (clonedMaterial as THREE.MeshStandardMaterial).color instanceof
            THREE.Color
        ) {
          const highlighted = clonedMaterial as THREE.MeshStandardMaterial;
          highlighted.color = highlighted.color
            .clone()
            .lerp(new THREE.Color(tint), 0.28);
          highlighted.toneMapped = false;
        }
      }
      clonedMaterial.transparent = opacity < 1;
      clonedMaterial.opacity = opacity;
      return maskMode
        ? createKirishiacRotatorWeightMaskMaterial(clonedMaterial, maskMode, rotatorJointIndex)
        : clonedMaterial;
    };
    const cloneShipMaterials = (
      material: THREE.Material | THREE.Material[] | undefined,
      maskMode?: "static" | "rotating",
      rotatorJointIndex?: number,
    ) =>
      Array.isArray(material)
        ? material.map((entry) => cloneShipMaterial(entry, maskMode, rotatorJointIndex))
        : cloneShipMaterial(material, maskMode, rotatorJointIndex);
    const prepareMeshMaterials = (root: THREE.Object3D, mode?: "static" | "rotating") => {
      root.traverse((child: any) => {
        if (!child.isMesh) return;
        const childName = String(child.name ?? "").toLowerCase();
        const geometryName = String(child.geometry?.name ?? "").toLowerCase();
        if (childName.includes("kirishiac_beam") || geometryName.includes("kirishiac_beam")) {
          child.visible = false;
          return;
        }
        if (mode === "rotating" && !child.isSkinnedMesh) {
          child.visible = false;
          return;
        }
        const rotatorJointIndex =
          child.isSkinnedMesh && child.skeleton?.bones
            ? child.skeleton.bones.findIndex((bone: THREE.Bone) =>
                String(bone.name ?? "").toLowerCase().includes("lordship rotator"),
              )
            : undefined;
        const skinMaskJointIndex =
          typeof rotatorJointIndex === "number" && rotatorJointIndex >= 0
            ? rotatorJointIndex
            : undefined;
        child.material = Array.isArray(child.material)
          ? cloneShipMaterials(child.material, child.isSkinnedMesh ? mode : undefined, skinMaskJointIndex)
          : cloneShipMaterials(child.material, child.isSkinnedMesh ? mode : undefined, skinMaskJointIndex);
      });
    };
    const c = kirishiacLayeredRotation
      ? (() => {
          const group = new THREE.Group();
          const staticLayer = cloneSkeleton(scene);
          const rotatingLayer = cloneSkeleton(scene);
          prepareMeshMaterials(staticLayer, "static");
          prepareMeshMaterials(rotatingLayer, "rotating");
          kirishiacRotatingLayerRef.current = rotatingLayer;
          group.add(staticLayer, rotatingLayer);
          return group;
        })()
      : rotatingPartConfig || modelRequiresSkeletonClone(filenameKey)
        ? cloneSkeleton(scene)
        : scene.clone(true);
    c.traverse((child: any) => {
      const anchorName = String(child.name ?? "").toLowerCase();
      if (
        rotatingPartConfig &&
        anchorName === rotatingPartConfig.nodeName.toLowerCase()
      ) {
        rotatingPartRef.current = child;
        rotatingPartInitialRotationRef.current = readEulerAxis(
          child.rotation,
          rotatingPartConfig.axis,
        );
        rotatingPartInitialQuaternionRef.current.copy(child.quaternion);
        rotatingPartLocalAxisRef.current.set(
          rotatingPartConfig.axis === "x" ? 1 : 0,
          rotatingPartConfig.axis === "y" ? 1 : 0,
          rotatingPartConfig.axis === "z" ? 1 : 0,
        );
      }
      if (
        anchorName.startsWith("wreck_smoke") ||
        anchorName.startsWith("smoke_light") ||
        anchorName.startsWith("small_glow") ||
        anchorName.startsWith("ember_trail")
      ) {
        anchorNodes.push(child);
      }
      if (!kirishiacLayeredRotation && child.isMesh) {
        child.material = Array.isArray(child.material)
          ? cloneShipMaterials(child.material)
          : cloneShipMaterials(child.material);
      }
    });
    if (rotatingPartConfig && rotatingPartRef.current) {
      applyRotatingPartPivotOverride(
        c,
        rotatingPartRef.current,
        rotatingPartConfig.pivotModelPosition,
      );
    }
    if (MODEL_CENTER_ON_HORIZONTAL_BOUNDS.has(filenameKey)) {
      c.updateMatrixWorld(true);
      const visibleBounds = new THREE.Box3();
      const childBounds = new THREE.Box3();
      c.traverse((child: any) => {
        if (!child.isMesh || child.visible === false) return;
        childBounds.setFromObject(child);
        if (!childBounds.isEmpty()) visibleBounds.union(childBounds);
      });
      if (!visibleBounds.isEmpty()) {
        const center = new THREE.Vector3();
        visibleBounds.getCenter(center);
        c.position.x -= center.x;
        c.position.z -= center.z;
      }
    }
    c.updateMatrixWorld(true);
    const rootInverse = new THREE.Matrix4().copy(c.matrixWorld).invert();
    const anchorPoints = anchorNodes.map((node) => {
      const position = new THREE.Vector3();
      node.getWorldPosition(position);
      position.applyMatrix4(rootInverse);
      return {
        name: node.name.toLowerCase(),
        position: [position.x, position.y, position.z] as [number, number, number],
      };
    });
    return {
      cloned: c,
      anchors: anchorPoints,
      selectiveOrganicMaterials: organicMaterials,
    };
  }, [
    scene,
    tint,
    meshTintsEnabled,
    terrainMeshHighlight,
    ghostHighlight,
    rotatingPartConfig,
    kirishiacLayeredRotation,
    useSelectiveOrganicShadowMaterial,
    organicBaseTexture,
    organicNormalTexture,
    organicRoughnessTexture,
    opacity,
  ]);
  useEffect(() => {
    applyObjectMaterialOpacity(cloned, opacity);
  }, [cloned, opacity]);
  useEffect(
    () => () =>
      selectiveOrganicMaterials.forEach((material) => material.dispose()),
    [selectiveOrganicMaterials],
  );
  useFrame(({ clock }) => {
    if (useSelectiveOrganicShadowMaterial) {
      selectiveOrganicElapsedRef.current = clock.getElapsedTime();
      for (const shader of selectiveOrganicShaderRefs.current) {
        shader.uniforms.uOrganicTime.value =
          selectiveOrganicElapsedRef.current;
      }
      const travel =
        selectiveOrganicElapsedRef.current *
        ORGANIC_BATTLECRAB_TUNING.speed *
        ORGANIC_BATTLECRAB_TUNING.intensity;
      organicNormalTexture.offset.set(travel * 0.018, travel * 0.006);
      organicRoughnessTexture.offset.copy(organicNormalTexture.offset);
    }
    if (kirishiacRotatingLayerRef.current) {
      const progress = (clock.getElapsedTime() % 30) / 30;
      kirishiacRotatingLayerRef.current.rotation.z = progress * Math.PI * 2;
      kirishiacRotatingLayerRef.current.updateMatrixWorld(true);
      return;
    }
    if (!rotatingPartConfig || !rotatingPartRef.current) return;
    const cycleSeconds = Math.max(0.1, rotatingPartConfig.secondsPerRotation);
    const progress = (clock.getElapsedTime() % cycleSeconds) / cycleSeconds;
    if (rotatingPartConfig.rotationMode === "local-axis") {
      rotatingPartDeltaQuaternionRef.current.setFromAxisAngle(
        rotatingPartLocalAxisRef.current,
        progress * Math.PI * 2,
      );
      rotatingPartRef.current.quaternion
        .copy(rotatingPartInitialQuaternionRef.current)
        .multiply(rotatingPartDeltaQuaternionRef.current);
    } else {
      writeEulerAxis(
        rotatingPartRef.current.rotation,
        rotatingPartConfig.axis,
        rotatingPartInitialRotationRef.current + progress * Math.PI * 2,
      );
    }
    rotatingPartRef.current.updateMatrixWorld();
  });
  const s = useMemo(
    () => modelAbsoluteScale(filename) ?? shipScale(cloned) * modelScaleMultiplier(filename),
    [cloned, filename],
  );
  const flip = FLIP_MODELS.has(filename);
  const visualFlip =
    flip || VISUAL_ROTATE_180_MODELS.has(filename.toLowerCase());
  const yOffset = modelVisualYOffset(filename);
  return (
    <group
      position={[0, yOffset, 0]}
      scale={[s, s, s]}
      rotation={[0, visualFlip ? Math.PI : 0, 0]}
    >
      <primitive object={cloned} />
      {damageAnchorEffects
        ? anchors.map((anchor) => (
            <LiveDamageAnchorEffect
              key={`${filename}-${anchor.name}`}
              anchor={anchor}
              modelScale={s}
            />
          ))
        : null}
    </group>
  );
}

class ModelErrorBoundary extends React.Component<
  { color: string; children: React.ReactNode },
  { error: boolean }
> {
  constructor(props: { color: string; children: React.ReactNode }) {
    super(props);
    this.state = { error: false };
  }
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    if (this.state.error) return <ShipModelFallback color={this.props.color} />;
    return this.props.children;
  }
}

class OptionalFxErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: false };
  }

  static getDerivedStateFromError() {
    return { error: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Optional weapon FX failed; suppressing visual effect.", error);
  }

  render() {
    if (this.state.error) return null;
    return this.props.children;
  }
}

function ShipModelFallback({
  color,
  opacity = 1,
}: {
  color: string;
  opacity?: number;
}) {
  return (
    <mesh>
      <boxGeometry args={[0.6, 0.2, 1.2]} />
      <meshStandardMaterial
        color={color}
        transparent={opacity < 1}
        opacity={opacity}
      />
    </mesh>
  );
}

// Cache HEAD-check results so each URL is only fetched once per session
const modelExistsCache = new Map<string, boolean>();
const MODEL_ASSET_REVISIONS: Record<string, string> = {
  "artemis.glb": "20260727-artemis-v1",
  "asteroid-light.glb": "20260721-field-v2",
  "asteroids_medium.glb": "20260725-medium-v1",
  "avioki.glb": "20260719-154941",
  "vorlon-dreadnought.glb": "20260727-heavy-cruiser-v1",
  "black-omega.glb": "20260721-192023",
  "bintak.glb": "20260724-221703",
  [ORGANIC_BATTLECRAB_MODEL_FILENAME]: "20260720-214405-organic",
  [COMMAND_HYPERION_MODEL_FILENAME]: "20260719-211631",
  [DEAD_BINTAK_MODEL_FILENAME]: "20260724-223851",
  "dead-hyperion.glb": "20260718-163044",
  [DEAD_OMEGA_MODEL_FILENAME]: "20260718-231918",
  [EXPLORER_ROTATING_MODEL_FILENAME]: "20260720-160843",
  "kirishiac.glb": "20260725-004107",
  "kirishiac1.glb": "20260725-beam-0100",
  "missile-hyperion.glb": "20260719-005010",
  [OMEGA_ROTATING_MODEL_FILENAME]: "20260729-194957",
  [COMMAND_OMEGA_MODEL_FILENAME]: "20260729-195216",
  [OMEGA_X_MODEL_FILENAME]: "20260729-202747",
  "olympus-gunship.glb": "20260727-gunship-v1",
  "orestes.glb": "20260724-191655",
  [ORION_SPACE_STATION_MODEL_FILENAME]: "20260721-191433-origin",
  [PSI_CORPS_MOTHERSHIP_MODEL_FILENAME]: "20260721-183649",
  [RAILGUN_HYPERION_MODEL_FILENAME]: "20260730-railgun-v1",
  [RAIDER_CARRIER_MODEL_FILENAME]: "20260728-202413",
  [RAIDER_DELTA_MODEL_FILENAME]: "20260728-212845",
  [RAIDER_FREIGHTER_MODEL_FILENAME]: "20260730-freighter-v2",
  [RAIDER_NOVA_MODEL_FILENAME]: "20260728-221344",
  "rongoth.glb": "20260724-193659",
  [SHADOW_SCOUT_MODEL_FILENAME]: "20260728-135155",
  [VORLON_FIGHTER_MODEL_FILENAME]: "20260728-vorlon-fighter-v1",
  [VORLON_LIGHT_CRUISER_MODEL_FILENAME]: "20260728-223454",
  [VORLON_TRANSPORT_MODEL_FILENAME]: "20260728-vorlon-transport-v1",
  "vorchan.glb": "20260719-140443",
};

function useModelExists(url: string): boolean | null {
  const [exists, setExists] = useState<boolean | null>(
    modelExistsCache.has(url) ? modelExistsCache.get(url)! : null,
  );
  useEffect(() => {
    if (modelExistsCache.has(url)) {
      setExists(modelExistsCache.get(url)!);
      return;
    }
    fetch(url, { method: "HEAD" })
      .then((r) => {
        modelExistsCache.set(url, r.ok);
        setExists(r.ok);
      })
      .catch(() => {
        modelExistsCache.set(url, false);
        setExists(false);
      });
  }, [url]);
  return exists;
}

function ShipModel3D({
  filename,
  tint,
  opacity = 1,
  meshTintsEnabled = true,
  damageAnchorEffects = false,
  terrainMeshHighlight = false,
  ghostHighlight = false,
}: {
  filename: string;
  tint: string;
  opacity?: number;
  meshTintsEnabled?: boolean;
  damageAnchorEffects?: boolean;
  terrainMeshHighlight?: boolean;
  ghostHighlight?: boolean;
}) {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const assetRevision =
    MODEL_ASSET_REVISIONS[filename.toLowerCase()] ?? APP_BUILD_SHA;
  const url = `${basePath}/api/models/${filename}?v=${encodeURIComponent(assetRevision)}`;
  const isGlb =
    filename.toLowerCase().endsWith(".glb") ||
    filename.toLowerCase().endsWith(".gltf");
  const exists = useModelExists(url);
  // null = check in-flight; false = file missing — both show fallback box
  if (!exists)
    return (
      <ShipModelFallback
        color={meshTintsEnabled ? tint : "#d1d5db"}
        opacity={opacity}
      />
    );
  if (isGlb && ORGANIC_SHADOW_MODEL_FILENAMES.has(filename.toLowerCase())) {
    return (
      <OrganicBattlecrabGlbModel
        url={url}
        filename={filename}
        opacity={opacity}
      />
    );
  }
  if (isGlb)
    return (
      <GlbModel
        url={url}
        tint={tint}
        filename={filename}
        opacity={opacity}
        meshTintsEnabled={meshTintsEnabled}
        damageAnchorEffects={damageAnchorEffects}
        terrainMeshHighlight={terrainMeshHighlight}
        ghostHighlight={ghostHighlight}
      />
    );
  return (
    <ObjModel
      url={url}
      tint={tint}
      opacity={opacity}
      meshTintsEnabled={meshTintsEnabled}
    />
  );
}

function CameraFacingText({
  children,
  ...props
}: React.ComponentProps<typeof Text>) {
  const ref = useRef<any>(null);
  const { camera } = useThree();
  const parentWorldQuat = useMemo(() => new THREE.Quaternion(), []);

  useFrame(() => {
    const text = ref.current;
    if (!text) return;
    const parent = text.parent as THREE.Object3D | null;
    if (parent) {
      parent.getWorldQuaternion(parentWorldQuat);
      text.quaternion.copy(
        parentWorldQuat.invert().multiply(camera.quaternion),
      );
    } else {
      text.quaternion.copy(camera.quaternion);
    }
  });

  return (
    <Text ref={ref} {...props}>
      {children}
    </Text>
  );
}

function CameraFacingGroup({
  children,
  ...props
}: React.ComponentProps<"group">) {
  const ref = useRef<THREE.Group>(null);
  const { camera } = useThree();
  const parentWorldQuat = useMemo(() => new THREE.Quaternion(), []);

  useFrame(() => {
    const group = ref.current;
    if (!group) return;
    const parent = group.parent as THREE.Object3D | null;
    if (parent) {
      parent.getWorldQuaternion(parentWorldQuat);
      group.quaternion.copy(
        parentWorldQuat.invert().multiply(camera.quaternion),
      );
    } else {
      group.quaternion.copy(camera.quaternion);
    }
  });

  return (
    <group ref={ref} {...props}>
      {children}
    </group>
  );
}

function canonicalFighterSquadronFilename(
  filename: string | null | undefined,
): string | null {
  const normalized = (filename ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (FIGHTER_SQUADRON_MODELS.has(normalized)) return normalized;
  for (const [key, canonical] of Object.entries(
    FIGHTER_SQUADRON_CANONICAL_FILENAMES,
  )) {
    if (normalized.includes(key)) return canonical;
  }
  return null;
}

function isFighterSquadronModel(filename: string | null | undefined): boolean {
  return canonicalFighterSquadronFilename(filename) !== null;
}

function hasExplicitFighterTrait(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return raw
    .split(/[;,]/)
    .map((t) =>
      t
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, "-"),
    )
    .some((t) => t === "fighter");
}

type FighterIdentityModel = {
  filename?: string | null;
  traits?: string | null;
  name?: string | null;
  shipClass?: string | null;
};

function shipModelHasFighterTrait(
  model: FighterIdentityModel | undefined,
): boolean {
  const identity = [model?.name, model?.filename, model?.shipClass]
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .join(" ");
  return (
    hasExplicitFighterTrait(model?.traits) ||
    /\bfighter\b/i.test(model?.shipClass ?? "") ||
    /fighter flight/i.test(model?.name ?? "") ||
    isFighterSquadronModel(model?.filename ?? "") ||
    FIGHTER_IDENTITY_PATTERN.test(identity)
  );
}

const MULTI_UNIT_PURCHASE_COUNTS: Record<string, number> = {
  "aurora starfury": 4,
  "aurora starfury flight": 4,
  "aurora starfury wing": 4,
  "delta-v": 8,
  "delta-v fighter": 8,
  "delta-v fighter flight": 8,
  "delta-v fighter wing": 8,
  "delta v": 8,
  "delta v fighter": 8,
  "delta v fighter flight": 8,
  "delta v fighter wing": 8,
  "raider delta": 8,
  "raider delta fighter": 8,
  "raider delta fighter flight": 8,
  "raider delta flight": 8,
  "zephyr": 8,
  "zephyr flight": 8,
  "vorlon fighter": 3,
  "vorlon fighter flight": 3,
  "vorlon fighter wing": 3,
  "thunderbolt starfury": 4,
  "thunderbolt starfury flight": 4,
  "thunderbolt starfury wing": 4,
  "tiger starfury": 6,
  "tiger starfury flight": 6,
  "tiger starfury wing": 6,
  "black omega": 2,
  "black omega starfury": 2,
  "black omega starfury flight": 2,
  "black omega starfury wing": 2,
  "nial": 2,
  "nial fighter": 2,
  "nial heavy fighter": 2,
  "nial heavy fighter flight": 2,
  "nial wing": 2,
  "flyer": 4,
  "flyer flight": 4,
  "flyer wing": 4,
  "sentri": 4,
  "sentri flight": 4,
  "sentri wing": 4,
  "frazi": 5,
  "frazi flight": 5,
  "frazi wing": 5,
  "shadow fighter": 2,
  "shadow fighter flight": 2,
  "shadow fighter wing": 2,
  "shadow spitfire": 2,
  "spitfire": 2,
  "spitfire flight": 2,
  "tethys cutter": 2,
  "tethys class cutter": 2,
  "tethys class laser boat": 2,
  "tethys class missile boat": 2,
};

const MULTI_UNIT_PURCHASE_COUNTS_BY_FILENAME: Record<string, number> = {
  "aurora.glb": 4,
  "thunderbolt.glb": 4,
  "tiger.glb": 6,
  "black-omega.glb": 2,
  "nial.glb": 2,
  "flyer.glb": 4,
  "sentri.glb": 4,
  "frazi.glb": 5,
  "spitfire.glb": 2,
  [RAIDER_DELTA_MODEL_FILENAME]: 8,
  [VORLON_FIGHTER_MODEL_FILENAME]: 3,
  "tethys.glb": 2,
};

function multiUnitPurchaseCount(
  model: FighterIdentityModel | undefined,
): number {
  if (!model) return 1;
  const normalizedFilename = (model.filename ?? "").trim().toLowerCase();
  const filenamePurchaseCount =
    MULTI_UNIT_PURCHASE_COUNTS_BY_FILENAME[normalizedFilename];
  if (filenamePurchaseCount) return filenamePurchaseCount;
  const canonicalFilename = canonicalFighterSquadronFilename(model.filename);
  if (canonicalFilename) {
    const count = MULTI_UNIT_PURCHASE_COUNTS_BY_FILENAME[canonicalFilename];
    if (count) return count;
  }
  const identities = [model.name, model.shipClass, model.filename]
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .flatMap((value) => {
      const normalized = normalizeHintKey(value);
      return [normalized, normalized.replace(/\.(glb|gltf)$/i, "")];
    });
  for (const identity of identities) {
    const count = MULTI_UNIT_PURCHASE_COUNTS[identity];
    if (count) return count;
  }
  return 1;
}

type StagedFighterInventoryItem = {
  name: string;
  shipModelId: number | null;
  total: number;
};

const UI_SMALL_CRAFT_CANONICAL_NAMES: Record<string, string> = {
  "aurora starfury": "Aurora Starfury Flight",
  "aurora starfury flight": "Aurora Starfury Flight",
  "delta-v": "Delta-V Fighter Flight",
  "delta-v fighter": "Delta-V Fighter Flight",
  "delta-v fighter flight": "Delta-V Fighter Flight",
  "delta-v flight": "Delta-V Fighter Flight",
  "delta v": "Delta-V Fighter Flight",
  "delta v fighter": "Delta-V Fighter Flight",
  "delta v fighter flight": "Delta-V Fighter Flight",
  "delta v flight": "Delta-V Fighter Flight",
  "raider delta": "Delta-V Fighter Flight",
  "raider delta fighter": "Delta-V Fighter Flight",
  "raider delta fighter flight": "Delta-V Fighter Flight",
  "raider delta flight": "Delta-V Fighter Flight",
  zephyr: "Delta-V Fighter Flight",
  "zephyr flight": "Delta-V Fighter Flight",
  "black omega": "Black Omega Starfury Flight",
  "black omega flight": "Black Omega Starfury Flight",
  "black omega starfury": "Black Omega Starfury Flight",
  "black omega starfury flight": "Black Omega Starfury Flight",
  "black-omega": "Black Omega Starfury Flight",
  "black-omega flight": "Black Omega Starfury Flight",
  "black-omega starfury": "Black Omega Starfury Flight",
  "black-omega starfury flight": "Black Omega Starfury Flight",
  blackomega: "Black Omega Starfury Flight",
  "blackomega flight": "Black Omega Starfury Flight",
  "blackomega starfury": "Black Omega Starfury Flight",
  "blackomega starfury flight": "Black Omega Starfury Flight",
  "psi corps starfury": "Black Omega Starfury Flight",
  "psi corps starfury flight": "Black Omega Starfury Flight",
  "psi-corps starfury": "Black Omega Starfury Flight",
  "psi-corps starfury flight": "Black Omega Starfury Flight",
  "psicorp starfury": "Black Omega Starfury Flight",
  "psicorp starfury flight": "Black Omega Starfury Flight",
  thunderbolt: "Thunderbolt Starfury Flight",
  "thunderbolt starfury": "Thunderbolt Starfury Flight",
  "thunderbolt starfury flight": "Thunderbolt Starfury Flight",
  tiger: "Tiger Starfury Flight",
  "tiger starfury": "Tiger Starfury Flight",
  "tiger starfury flight": "Tiger Starfury Flight",
  nial: "Nial Heavy Fighter Flight",
  "nial fighter": "Nial Heavy Fighter Flight",
  "nial fighter flight": "Nial Heavy Fighter Flight",
  flyer: "Flyer Flight",
  "flyer flight": "Flyer Flight",
  "minbari flyer": "Flyer Flight",
  "minbari flyer flight": "Flyer Flight",
  sentri: "Sentri Flight",
  "sentri fighter": "Sentri Flight",
  "sentri fighter flight": "Sentri Flight",
  "sentri flight": "Sentri Flight",
  frazi: "Frazi Flight",
  "frazi fighter": "Frazi Flight",
  "frazi fighter flight": "Frazi Flight",
  "frazi flight": "Frazi Flight",
  spitfire: "Shadow Fighter Flight",
  "spitfire fighter": "Shadow Fighter Flight",
  "spitfire fighter flight": "Shadow Fighter Flight",
  "spitfire flight": "Shadow Fighter Flight",
  "shadow fighter": "Shadow Fighter Flight",
  "shadow fighter flight": "Shadow Fighter Flight",
  "shadow fighters": "Shadow Fighter Flight",
  "shadow spitfire": "Shadow Fighter Flight",
  "shadow spitfire flight": "Shadow Fighter Flight",
};

function normalizeSmallCraftKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseUiSmallCraftInventory(
  smallCraft: string | null | undefined,
  models: ShipModel[],
): StagedFighterInventoryItem[] {
  if (!smallCraft || /^(?:none|n\/a|-|\u2014)$/i.test(smallCraft.trim()))
    return [];
  const byName = new Map(
    models.map((model) => [normalizeSmallCraftKey(model.name), model]),
  );
  return smallCraft
    .split(/[,;]+/)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const entry = raw.match(/^(.*?)\s*(?:\((\d+)\)|x\s*(\d+)|(\d+)\s*x)?$/i);
      const rawName = (entry?.[1] ?? raw).trim();
      const total = Math.max(
        1,
        Number(entry?.[2] ?? entry?.[3] ?? entry?.[4] ?? 1),
      );
      const canonicalName =
        UI_SMALL_CRAFT_CANONICAL_NAMES[normalizeSmallCraftKey(rawName)] ??
        rawName;
      const candidates = [
        canonicalName,
        /\bflight\b/i.test(canonicalName)
          ? canonicalName
          : `${canonicalName} Flight`,
        canonicalName
          .replace(/\bfighter\b/gi, "")
          .replace(/\s+/g, " ")
          .trim(),
      ].filter(Boolean);
      const model = candidates
        .map(
          (candidate) =>
            UI_SMALL_CRAFT_CANONICAL_NAMES[normalizeSmallCraftKey(candidate)] ??
            candidate,
        )
        .map((candidate) => byName.get(normalizeSmallCraftKey(candidate)))
        .find(Boolean);
      return {
        name: model?.name ?? canonicalName,
        shipModelId: model?.id ?? null,
        total,
      };
    });
}

function uiPrebattleFighterDeploymentLimit(carrier: {
  carriedFighters?: StagedFighterInventoryItem[];
  traits?: string | null;
}): number {
  const totalFlights = (carrier.carriedFighters ?? []).reduce(
    (sum, item) => sum + item.total,
    0,
  );
  if (totalFlights <= 0) return 0;
  return /\bfleet\s+carrier\b/i.test(carrier.traits ?? "")
    ? Math.max(1, Math.floor(totalFlights / 2))
    : 1;
}

function parseUiCarrierRating(raw: string | null | undefined): number {
  const match = /\bcarrier\s+(\d+)\b/i.exec(raw ?? "");
  return match ? Math.max(0, Number(match[1]) || 0) : 0;
}

function uiFighterBayOperationLimit(carrier: {
  carriedFighters?: Array<{ total: number }> | null;
  specialAction?: string | null;
}, carrierModel?: { traits?: string | null }): number {
  const inventory = carrier.carriedFighters ?? [];
  if (inventory.length === 0) return 0;
  const carrierRating = parseUiCarrierRating(carrierModel?.traits);
  const base = Math.max(1, carrierRating || 0);
  return carrier.specialAction === "scramble"
    ? carrierRating
      ? carrierRating + 2
      : 2
    : base;
}

function uiFighterBayOperationsUsedThisRound(unit: {
  fighterBayOperationsRound?: number | null;
  fighterBayOperationsUsed?: number | null;
}, round: number): number {
  return unit.fighterBayOperationsRound === round
    ? Math.max(0, unit.fighterBayOperationsUsed ?? 0)
    : 0;
}

function hasLostCarrierCapability(unit: {
  criticals?: Array<{ lostTraits?: string[] | null }>;
}): boolean {
  return (unit.criticals ?? []).some((crit) =>
    (crit.lostTraits ?? []).some((trait) => /^carrier(?:\s+\d+)?$/i.test(normalizeHintKey(trait))),
  );
}

function isShadowCodedDamageVessel(unit: {
  faction?: string | null;
  name?: string | null;
  modelFilename?: string | null;
}): boolean {
  const text = [unit.faction, unit.name, unit.modelFilename]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return (
    /\bshadows?\b/.test(text) ||
    text.includes("shadow") ||
    text.includes("battlecrab")
  );
}

const STANDARD_BASE_RADIUS_INCHES = 0.8;
const CARRIED_FIGHTER_DEPLOY_RADIUS_INCHES = 3;
const SHADOW_DISPERSAL_COHESION_INCHES = 4;
const SHADOW_DISPERSAL_DISTANCE_EPSILON = 0.01;

function rulesBaseRadius(unit?: { baseRadiusInches?: number | null }): number {
  const radius = Number(unit?.baseRadiusInches);
  return Number.isFinite(radius) && radius > 0
    ? radius
    : STANDARD_BASE_RADIUS_INCHES;
}

function carriedFighterDeployCenterRadius(
  carrier?: { baseRadiusInches?: number | null },
  fighter?: { baseRadiusInches?: number | null },
): number {
  return (
    CARRIED_FIGHTER_DEPLOY_RADIUS_INCHES +
    rulesBaseRadius(carrier) +
    rulesBaseRadius(fighter)
  );
}

const BASE_CONTACT_EPSILON = 0.05;
const DOGFIGHT_CONTACT_GAP_EPSILON = 0.05;
const DOGFIGHT_CONTACT_OVERLAP_EPSILON = 0.02;

function uiBasesCanOverlap(
  moving: { isFighter?: boolean },
  other: { isFighter?: boolean },
): boolean {
  void moving;
  void other;
  return false;
}

function uiCapitalMovementCanDisplaceFighter(
  moving: { isFighter?: boolean },
  other: { isFighter?: boolean },
): boolean {
  return !moving.isFighter && Boolean(other.isFighter);
}

function uiBasesInContact(
  a: { hexQ: number; hexR: number; baseRadiusInches?: number | null },
  b: { hexQ: number; hexR: number; baseRadiusInches?: number | null },
): boolean {
  const edgeDistance =
    Math.hypot(a.hexQ - b.hexQ, a.hexR - b.hexR) -
    rulesBaseRadius(a) -
    rulesBaseRadius(b);
  return (
    edgeDistance >= -DOGFIGHT_CONTACT_OVERLAP_EPSILON &&
    edgeDistance <= DOGFIGHT_CONTACT_GAP_EPSILON
  );
}

type UiBaseFootprint = {
  id: string | number;
  x: number;
  z: number;
  isFighter?: boolean;
  baseRadiusInches?: number | null;
};

function uiBaseFootprintsIllegallyOverlap(
  a: UiBaseFootprint,
  b: UiBaseFootprint,
): boolean {
  if (a.id === b.id) return false;
  if (uiBasesCanOverlap(a, b)) return false;
  const minimumDistance = Math.max(
    0,
    rulesBaseRadius(a) + rulesBaseRadius(b) - BASE_CONTACT_EPSILON,
  );
  return Math.hypot(a.x - b.x, a.z - b.z) < minimumDistance;
}

function uiBaseFootprintEdgeDistance(
  a: UiBaseFootprint,
  b: UiBaseFootprint,
): number {
  return Math.max(
    0,
    Math.hypot(a.x - b.x, a.z - b.z) - rulesBaseRadius(a) - rulesBaseRadius(b),
  );
}

function finalForwardPositionOverlapsBase(
  moving: {
    id: number;
    hexQ: number;
    hexR: number;
    isFighter?: boolean;
    baseRadiusInches?: number | null;
  },
  others: Array<{
    id: number;
    hexQ: number;
    hexR: number;
    isDestroyed: boolean;
    isFighter?: boolean;
    baseRadiusInches?: number | null;
  }>,
  direction: { x: number; z: number },
  distance: number,
  options: { ignoreDisplaceableFighters?: boolean } = {},
): boolean {
  const x = moving.hexQ + direction.x * distance;
  const z = moving.hexR + direction.z * distance;
  const movingRadius = rulesBaseRadius(moving);

  for (const other of others) {
    if (other.id === moving.id || other.isDestroyed) continue;
    if (uiBasesCanOverlap(moving, other)) continue;
    if (
      options.ignoreDisplaceableFighters &&
      uiCapitalMovementCanDisplaceFighter(moving, other)
    )
      continue;
    const minDistance = Math.max(
      0,
      movingRadius + rulesBaseRadius(other) - BASE_CONTACT_EPSILON,
    );
    if (Math.hypot(x - other.hexQ, z - other.hexR) < minDistance) return true;
  }
  return false;
}

function firstLegalForwardDistanceAtOrAfter(
  moving: {
    id: number;
    hexQ: number;
    hexR: number;
    isFighter?: boolean;
    baseRadiusInches?: number | null;
  },
  others: Array<{
    id: number;
    hexQ: number;
    hexR: number;
    isDestroyed: boolean;
    isFighter?: boolean;
    baseRadiusInches?: number | null;
  }>,
  direction: { x: number; z: number },
  startDistance: number,
  maxDistance: number,
): number | null {
  const maxLegal = Math.max(0, snapMovementDistance(maxDistance));
  let distance = Math.max(0, snapMovementDistance(startDistance));
  while (distance <= maxLegal + 1e-6) {
    if (
      !finalForwardPositionOverlapsBase(moving, others, direction, distance, {
        ignoreDisplaceableFighters: true,
      })
    ) {
      return distance;
    }
    distance = snapMovementDistance(distance + TABLET_FORWARD_STEP);
  }
  return null;
}

function clampForwardDistanceToLegalRestingSpot(
  moving: {
    id: number;
    hexQ: number;
    hexR: number;
    isFighter?: boolean;
    baseRadiusInches?: number | null;
  },
  others: Array<{
    id: number;
    hexQ: number;
    hexR: number;
    isDestroyed: boolean;
    isFighter?: boolean;
    baseRadiusInches?: number | null;
  }>,
  direction: { x: number; z: number },
  requestedDistance: number,
  maxDistance: number,
  preference: "nearest" | "forward" = "nearest",
): number {
  const requested = Math.max(
    0,
    Math.min(maxDistance, snapMovementDistance(requestedDistance)),
  );
  const maxLegal = Math.max(0, snapMovementDistance(maxDistance));
  if (
    !finalForwardPositionOverlapsBase(moving, others, direction, requested, {
      ignoreDisplaceableFighters: true,
    })
  )
    return requested;

  const candidates = new Set<number>([0, maxLegal]);
  const startX = moving.hexQ;
  const startZ = moving.hexR;
  const movingRadius = rulesBaseRadius(moving);

  for (const other of others) {
    if (other.id === moving.id || other.isDestroyed) continue;
    if (uiBasesCanOverlap(moving, other)) continue;
    if (uiCapitalMovementCanDisplaceFighter(moving, other)) continue;

    const minDistance = Math.max(
      0,
      movingRadius + rulesBaseRadius(other) - BASE_CONTACT_EPSILON,
    );
    const sx = startX - other.hexQ;
    const sz = startZ - other.hexR;
    const c = sx * sx + sz * sz - minDistance * minDistance;
    const b = 2 * (sx * direction.x + sz * direction.z);
    const discriminant = b * b - 4 * c;
    if (discriminant < 0) continue;
    const sqrtDisc = Math.sqrt(discriminant);
    const entryDistance = (-b - sqrtDisc) / 2;
    const exitDistance = (-b + sqrtDisc) / 2;

    if (exitDistance < 0 || entryDistance > maxLegal) continue;
    const before = Math.max(
      0,
      Math.floor(Math.max(0, entryDistance) / TABLET_FORWARD_STEP) *
        TABLET_FORWARD_STEP,
    );
    const after = Math.min(
      maxLegal,
      Math.ceil(Math.max(0, exitDistance) / TABLET_FORWARD_STEP) *
        TABLET_FORWARD_STEP,
    );
    candidates.add(snapMovementDistance(before));
    candidates.add(snapMovementDistance(after));
  }

  const legalCandidates = [...candidates]
    .map((d) => Math.max(0, Math.min(maxLegal, snapMovementDistance(d))))
    .filter(
      (d) =>
        !finalForwardPositionOverlapsBase(moving, others, direction, d, {
          ignoreDisplaceableFighters: true,
        }),
    );

  if (preference === "forward") {
    const scannedForwardCandidate = firstLegalForwardDistanceAtOrAfter(
      moving,
      others,
      direction,
      requested,
      maxLegal,
    );
    if (scannedForwardCandidate !== null) return scannedForwardCandidate;

    const forwardCandidate = legalCandidates
      .filter((d) => d >= requested - 1e-6)
      .sort((a, b) => a - b)[0];
    if (forwardCandidate !== undefined) return forwardCandidate;
  }
  if (legalCandidates.length === 0) return 0;
  legalCandidates.sort(
    (a, b) => Math.abs(a - requested) - Math.abs(b - requested) || b - a,
  );
  return legalCandidates[0];
}

function BoardModelVisual({
  filename,
  tint,
  opacity = 1,
  meshTintsEnabled = true,
  damageAnchorEffects = false,
  terrainMeshHighlight = false,
  ghostHighlight = false,
}: {
  filename: string;
  tint: string;
  opacity?: number;
  meshTintsEnabled?: boolean;
  damageAnchorEffects?: boolean;
  terrainMeshHighlight?: boolean;
  ghostHighlight?: boolean;
}) {
  const fighterFilename = canonicalFighterSquadronFilename(filename);
  if (!fighterFilename) {
    const visualFilename =
      DEFAULT_VISUAL_MODEL_FILENAMES[filename.toLowerCase()] ?? filename;
    return (
      <ShipModel3D
        filename={visualFilename}
        tint={tint}
        opacity={opacity}
        meshTintsEnabled={meshTintsEnabled}
        damageAnchorEffects={damageAnchorEffects}
        terrainMeshHighlight={terrainMeshHighlight}
        ghostHighlight={ghostHighlight}
      />
    );
  }

  return (
    <group>
      {FIGHTER_SQUADRON_OFFSETS.map((offset, index) => (
        <group
          key={`${fighterFilename}-${index}`}
          position={[offset.x, 0, offset.z]}
          rotation={[0, offset.yaw, 0]}
        >
          <ShipModel3D
            filename={fighterFilename}
            tint={tint}
            opacity={opacity}
            meshTintsEnabled={meshTintsEnabled}
            damageAnchorEffects={false}
            terrainMeshHighlight={terrainMeshHighlight}
            ghostHighlight={ghostHighlight}
          />
        </group>
      ))}
    </group>
  );
}

function TerrainAsteroidField({ field }: { field: TerrainObject }) {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const revision =
    MODEL_ASSET_REVISIONS[field.modelFilename.toLowerCase()] ?? APP_BUILD_SHA;
  const url = `${basePath}/api/models/${field.modelFilename}?v=${encodeURIComponent(revision)}`;
  const { scene } = useGLTF(url);
  const isMediumVariant = field.modelFilename.toLowerCase() === ASTEROID_FIELD_MODEL_MEDIUM;
  const cloned = useMemo(() => {
    const c = scene.clone(true);
    c.traverse((child: any) => {
      if (String(child.name ?? "").toLowerCase().includes("circle")) {
        child.visible = false;
      }
      if (child.isMesh) {
        child.castShadow = false;
        child.receiveShadow = false;
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];
        const clonedMaterials = materials.map((material: THREE.Material | undefined) => {
          const next = material?.clone
            ? material.clone()
            : new THREE.MeshStandardMaterial({ color: "#8b949e" });
          next.transparent = true;
          next.opacity = 0.9;
          if ("emissive" in next) {
            (next as THREE.MeshStandardMaterial).emissive = new THREE.Color("#0f172a");
            (next as THREE.MeshStandardMaterial).emissiveIntensity = 0.08;
          }
          return next;
        });
        child.material = Array.isArray(child.material) ? clonedMaterials : clonedMaterials[0];
      }
    });
    return c;
  }, [scene]);
  const footprintGeometry = useMemo(() => {
    const polygon = terrainObjectPolygon(field) ?? [];
    const points = [...polygon, polygon[0]].filter(Boolean).map(
      (point) => new THREE.Vector3(point.x - field.x, 0, point.z - field.z),
    );
    return new THREE.BufferGeometry().setFromPoints(points);
  }, [field]);

  useEffect(() => () => {
    footprintGeometry.dispose();
  }, [footprintGeometry]);

  const mediumBounds = {
    sourceDiameter: 9.08,
    centerX: 0.749,
    centerZ: -1.143,
    minY: -0.69,
  };
  const terrainRotationRad = ((field.rotationDeg ?? 0) * Math.PI) / 180;
  const meshLift = 1;
  const diameter = field.radiusInches * 2;
  const visualDiameter = isMediumVariant ? Math.min(diameter, 10.5) : diameter;
  const scale = visualDiameter / (isMediumVariant ? mediumBounds.sourceDiameter : ASTEROID_FIELD_SOURCE_DIAMETER);
  const visualOffset: [number, number, number] = isMediumVariant
    ? [
        -mediumBounds.centerX * scale,
        -mediumBounds.minY * scale + meshLift,
        -mediumBounds.centerZ * scale,
      ]
    : [0, meshLift, 0];
  return (
    <group position={[field.x, 0.03, field.z]} renderOrder={2}>
      <group rotation={[0, terrainRotationRad, 0]}>
        <group position={visualOffset} scale={[scale, scale, scale]}>
          <primitive object={cloned} />
        </group>
      </group>
      {footprintGeometry.attributes.position?.count >= 3 ? (
        <lineLoop raycast={() => null} position={[0, 0.014, 0]}>
          <primitive object={footprintGeometry} attach="geometry" />
          <lineBasicMaterial color="#38bdf8" transparent opacity={0.86} depthWrite={false} />
        </lineLoop>
      ) : (
        <>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]}>
            <ringGeometry args={[field.radiusInches - 0.035, field.radiusInches + 0.035, 72]} />
            <meshBasicMaterial
              color="#38bdf8"
              transparent
              opacity={0.78}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]}>
            <circleGeometry args={[field.radiusInches, 72]} />
            <meshBasicMaterial
              color="#0e7490"
              transparent
              opacity={0.08}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        </>
      )}
      <Billboard position={[0, 0.95, 0]}>
        <Text
          fontSize={0.28}
          color="#bae6fd"
          anchorX="center"
          anchorY="middle"
          outlineColor="#020617"
          outlineWidth={0.035}
        >
          {field.name} · D{field.density}
        </Text>
      </Billboard>
    </group>
  );
}

function TerrainGasCloud({ field }: { field: TerrainObject }) {
  const dustCloud = field.visualVariant === "dust-cloud";
  const accentColor = dustCloud ? "#f7f7f7" : "#22d3ee";
  const labelColor = dustCloud ? "#e5e7eb" : "#67e8f9";
  const outlineGeometry = useMemo(() => {
    const polygon = terrainObjectPolygon(field) ?? [];
    const points = [...polygon, polygon[0]].filter(Boolean).map(
      (point) => new THREE.Vector3(point.x - field.x, 0, point.z - field.z),
    );
    return new THREE.BufferGeometry().setFromPoints(points);
  }, [field]);

  useEffect(() => () => outlineGeometry.dispose(), [outlineGeometry]);

  const rotation = ((field.rotationDeg ?? 0) * Math.PI) / 180;

  return (
    <group position={[field.x, 0.035, field.z]} renderOrder={2}>
      <lineLoop raycast={() => null}>
        <primitive object={outlineGeometry} attach="geometry" />
        <lineBasicMaterial color={accentColor} transparent opacity={0.82} depthWrite={false} />
      </lineLoop>
      <group rotation={[0, rotation, 0]}>
        <TerrainGasCloudHaze field={field} />
      </group>
      <Billboard position={[0, 1.75, 0]}>
        <Text
          fontSize={0.24}
          color={labelColor}
          anchorX="center"
          anchorY="middle"
          outlineColor="#020617"
          outlineWidth={0.032}
        >
          {field.name}
        </Text>
      </Billboard>
    </group>
  );
}

function TerrainGasCloudHaze({ field }: { field: TerrainObject }) {
  const dustCloud = field.visualVariant === "dust-cloud";
  const textureFilenames = dustCloud
    ? BOARD_DUST_CLOUD_TEXTURE_FILENAMES
    : BOARD_GAS_CLOUD_TEXTURE_FILENAMES;
  const sourceTextures = useLoader(
    THREE.TextureLoader,
    textureFilenames.map((filename) => boardTextureUrl(filename)),
  );
  const cloudGroupRef = useRef<THREE.Group>(null);
  const elapsedRef = useRef(0);
  const columns = 8;
  const rows = 8;
  const frameCount = columns * rows;
  const vfxTuning = dustCloud
    ? {
        color: "#f7f7f7",
        secondaryColor: "#8f8f8f",
        speed: 0.5,
        size: 1.85,
        fade: 1.55,
        intensity: 0.54,
        spread: 3.35,
        count: 72,
        arc: 1.25,
        thickness: 0.72,
      }
    : {
        color: "#22d3ee",
        secondaryColor: "#22d3ee",
        speed: 0.36,
        size: 2.2,
        fade: 2.05,
        intensity: 0.4,
        spread: 1.9,
        count: 36,
        arc: 0.82,
        thickness: 0.62,
      };
  const vfxFootprintRadius = 3.25 * vfxTuning.spread;
  const uniformScale = field.radiusInches / vfxFootprintRadius;
  const visualSpread = vfxTuning.spread * uniformScale;
  const visualSize = vfxTuning.size * uniformScale;
  const speed = vfxTuning.speed;
  const intensity = vfxTuning.intensity;
  const fade = vfxTuning.fade;
  const arc = vfxTuning.arc * uniformScale;
  const textureSeed = dustCloud ? 1667 : field.shapeSeed ?? 1;

  const instances = useMemo(() => {
    const desiredCount = dustCloud ? 72 : 36;
    const lowCount = dustCloud ? Math.round(desiredCount * 0.68) : 24;
    const highCount = dustCloud ? desiredCount - lowCount : 12;
    const lowColumns = 6;
    const highColumns = 4;
    const seededUnit = (index: number) => {
      const seed = dustCloud ? 1667 : field.shapeSeed ?? 1;
      const value = Math.sin((seed + index * 91.7) * 12.9898) * 43758.5453;
      return value - Math.floor(value);
    };
    const lowLayer = Array.from({ length: lowCount }, (_, i) => {
      const layerRow = Math.floor(i / lowColumns);
      const column = i % lowColumns;
      const progress = lowColumns <= 1 ? 0.5 : column / (lowColumns - 1);
      const rowOffset = dustCloud
        ? layerRow - (Math.ceil(lowCount / lowColumns) - 1) / 2
        : layerRow - 1.5;
      const edgeFade = Math.sin(progress * Math.PI);
      const jitterX = dustCloud ? (seededUnit(i + 3) - 0.5) * visualSpread * 0.34 : 0;
      const jitterZ = dustCloud ? (seededUnit(i + 7) - 0.5) * visualSpread * 0.48 : 0;
      return {
        x:
          (progress - 0.5) * visualSpread * 5.8 +
          rowOffset * visualSpread * 0.22 +
          Math.sin(i * 1.73) * visualSpread * 0.12 +
          jitterX,
        z:
          rowOffset * visualSpread * 0.72 +
          Math.cos(i * 1.29) * visualSpread * 0.18 +
          jitterZ,
        y: (0.38 + layerRow * 0.11 + edgeFade * 0.28) * uniformScale + arc +
          (dustCloud ? seededUnit(i + 11) * 0.24 * uniformScale : 0),
        scale: (1.08 + edgeFade * 0.36 + (i % 3) * 0.08 + (dustCloud ? seededUnit(i + 13) * 0.18 : 0)) * visualSize,
        opacity: (0.085 + edgeFade * 0.045) * intensity * fade,
        phase: i * 6.3 + (dustCloud ? seededUnit(i + 17) * frameCount : 0),
        rotation: rowOffset * 0.24 + Math.sin(i * 0.81) * 0.18 +
          (dustCloud ? (seededUnit(i + 19) - 0.5) * 0.7 : 0),
      };
    });
    const highLayer = Array.from({ length: highCount }, (_, highIndex) => {
      const row = Math.floor(highIndex / highColumns);
      const column = highIndex % highColumns;
      const progress = highColumns <= 1 ? 0.5 : column / (highColumns - 1);
      const rowOffset = dustCloud
        ? row - (Math.ceil(highCount / highColumns) - 1) / 2
        : row - 1;
      const edgeFade = Math.sin(progress * Math.PI);
      const i = highIndex + lowCount;
      return {
        x:
          (progress - 0.5) * visualSpread * 5.15 +
          rowOffset * visualSpread * 0.36 +
          Math.sin(i * 1.41) * visualSpread * 0.24 +
          (dustCloud ? (seededUnit(i + 23) - 0.5) * visualSpread * 0.42 : 0),
        z:
          rowOffset * visualSpread * 0.88 +
          Math.cos(i * 1.17) * visualSpread * 0.28 +
          (dustCloud ? (seededUnit(i + 29) - 0.5) * visualSpread * 0.55 : 0),
        y: (1.45 + row * 0.22 + edgeFade * 0.38) * uniformScale + arc +
          (dustCloud ? seededUnit(i + 31) * 0.42 * uniformScale : 0),
        scale: (0.92 + edgeFade * 0.3 + (highIndex % 2) * 0.12 + (dustCloud ? seededUnit(i + 37) * 0.18 : 0)) * visualSize,
        opacity: (0.045 + edgeFade * 0.026) * intensity * fade,
        phase: i * 6.3 + (dustCloud ? seededUnit(i + 41) * frameCount : 0),
        rotation: rowOffset * 0.34 + Math.sin(i * 0.69) * 0.24 +
          (dustCloud ? (seededUnit(i + 43) - 0.5) * 0.85 : 0),
      };
    });
    return [...lowLayer, ...highLayer];
  }, [arc, dustCloud, field.shapeSeed, frameCount, intensity, fade, uniformScale, visualSize, visualSpread]);

  const frameTextures = useMemo(
    () =>
      instances.map((_, index) => {
        const textureChoice = dustCloud
          ? Math.floor(
              (Math.sin((textureSeed + index * 53.1) * 78.233) * 43758.5453
                - Math.floor(Math.sin((textureSeed + index * 53.1) * 78.233) * 43758.5453)) *
                sourceTextures.length,
            )
          : Math.floor(terrainVisualSeededUnit(textureSeed, index + 101) * sourceTextures.length);
        const sourceTexture = sourceTextures[textureChoice] ?? sourceTextures[0]!;
        const texture = sourceTexture.clone();
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.repeat.set(1 / columns, 1 / rows);
        texture.needsUpdate = true;
        return texture;
      }),
    [dustCloud, instances, sourceTextures, textureSeed],
  );

  useEffect(() => () => {
    for (const texture of frameTextures) texture.dispose();
  }, [frameTextures]);

  useFrame((_, delta) => {
    elapsedRef.current += delta;
    const elapsed = elapsedRef.current;
    const frameRate = 14 * clampSmokeValue(speed, 0.15, 2.5);
    for (let i = 0; i < frameTextures.length; i += 1) {
      const texture = frameTextures[i];
      const frame = Math.floor(elapsed * frameRate + (instances[i]?.phase ?? 0)) % frameCount;
      const column = frame % columns;
      const row = Math.floor(frame / columns);
      texture.offset.x = column / columns;
      texture.offset.y = 1 - (row + 1) / rows;
    }
    if (cloudGroupRef.current) {
      cloudGroupRef.current.children.forEach((child, i) => {
        const instance = instances[i];
        if (!instance) return;
        const driftPhase = elapsed * speed * 0.48 + instance.phase;
        child.position.set(
          instance.x + Math.sin(driftPhase) * visualSpread * 0.08,
          instance.y + Math.sin(driftPhase * 1.5) * 0.06 * uniformScale,
          instance.z + Math.cos(driftPhase * 0.9) * visualSpread * 0.08,
        );
        child.rotation.y = instance.rotation + Math.sin(driftPhase * 0.35) * 0.08;
        const pulse = 1 + Math.sin(driftPhase * 1.1) * 0.045;
        child.scale.setScalar(pulse);
      });
    }
  });

  return (
    <>
      <group ref={cloudGroupRef}>
        {instances.map((instance, i) => (
          <Billboard
            key={i}
            position={[instance.x, instance.y, instance.z]}
            follow
            lockX={false}
            lockY={false}
            lockZ={false}
          >
            <mesh
              rotation={[0, 0, instance.rotation]}
              scale={[instance.scale * 1.45, instance.scale * 1.08, instance.scale]}
              raycast={() => null}
            >
              <planeGeometry args={[2.15, 2.15]} />
              <meshBasicMaterial
                map={frameTextures[i]}
                color={vfxTuning.color}
                transparent
                opacity={instance.opacity}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
                side={THREE.DoubleSide}
                toneMapped={false}
              />
            </mesh>
          </Billboard>
        ))}
      </group>
      <pointLight
        color={vfxTuning.secondaryColor}
        intensity={0.95 * intensity}
        distance={7 * visualSpread}
        position={[0, 1.1 * uniformScale, 0]}
      />
    </>
  );
}

function TerrainFields({ fields }: { fields: TerrainObject[] }) {
  if (fields.length === 0) return null;
  return (
    <Suspense fallback={null}>
      {fields.map((field) =>
        field.kind === "gas-cloud"
          ? <TerrainGasCloud key={field.id} field={field} />
          : <TerrainAsteroidField key={field.id} field={field} />,
      )}
    </Suspense>
  );
}

function TerrainPlacementPreview({
  field,
  legal,
}: {
  field: TerrainObject;
  legal: boolean;
}) {
  const geometry = useMemo(() => {
    const polygon = terrainObjectPolygon(field) ?? [];
    const points = [...polygon, polygon[0]].filter(Boolean).map(
      (point) => new THREE.Vector3(point.x - field.x, 0, point.z - field.z),
    );
    return new THREE.BufferGeometry().setFromPoints(points);
  }, [field]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  const color = legal ? "#22c55e" : "#ef4444";
  return (
    <group position={[field.x, 0.055, field.z]} renderOrder={6}>
      <lineLoop raycast={() => null}>
        <primitive object={geometry} attach="geometry" />
        <lineBasicMaterial color={color} transparent opacity={0.95} depthWrite={false} />
      </lineLoop>
      <Billboard position={[0, 1.1, 0]}>
        <Text
          fontSize={0.22}
          color={legal ? "#bbf7d0" : "#fecaca"}
          anchorX="center"
          anchorY="middle"
          outlineColor="#020617"
          outlineWidth={0.03}
        >
          {legal ? "Place terrain" : "Illegal terrain"}
        </Text>
      </Billboard>
    </group>
  );
}

function isBoardSizedRect(rect: { xMin: number; xMax: number; zMin: number; zMax: number }): boolean {
  return rect.xMin <= -BOARD_W / 2 + 1e-6 &&
    rect.xMax >= BOARD_W / 2 - 1e-6 &&
    rect.zMin <= -BOARD_D / 2 + 1e-6 &&
    rect.zMax >= BOARD_D / 2 - 1e-6;
}

function manualTerrainForbiddenRects(config: DeploymentConfig) {
  if (config.preset === "ambush-center") {
    const centerZones = [
      ...config.challenger.zones,
      ...config.opponent.zones,
    ].filter((zone) => !isBoardSizedRect(zone));
    if (centerZones.length > 0) return centerZones;
    return [
      ...(config.challenger.exclusions ?? []),
      ...(config.opponent.exclusions ?? []),
    ];
  }
  return [
    ...config.challenger.zones,
    ...config.opponent.zones,
  ];
}

function boardPointInRect(point: { x: number; z: number }, rect: { xMin: number; xMax: number; zMin: number; zMax: number }): boolean {
  return point.x >= rect.xMin - 1e-6 &&
    point.x <= rect.xMax + 1e-6 &&
    point.z >= rect.zMin - 1e-6 &&
    point.z <= rect.zMax + 1e-6;
}

function polygonContainsBoardPoint(point: { x: number; z: number }, polygon: Array<{ x: number; z: number }>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const intersects =
      (a.z > point.z) !== (b.z > point.z) &&
      point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z || 1e-6) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function boardSegmentsIntersect(a: { x: number; z: number }, b: { x: number; z: number }, c: { x: number; z: number }, d: { x: number; z: number }): boolean {
  const cross = (p: { x: number; z: number }, q: { x: number; z: number }, r: { x: number; z: number }) =>
    (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const onSegment = (p: { x: number; z: number }, q: { x: number; z: number }, r: { x: number; z: number }) =>
    Math.min(p.x, r.x) - 1e-6 <= q.x &&
    q.x <= Math.max(p.x, r.x) + 1e-6 &&
    Math.min(p.z, r.z) - 1e-6 <= q.z &&
    q.z <= Math.max(p.z, r.z) + 1e-6;
  const c1 = cross(a, b, c);
  const c2 = cross(a, b, d);
  const c3 = cross(c, d, a);
  const c4 = cross(c, d, b);
  if (Math.abs(c1) <= 1e-6 && onSegment(a, c, b)) return true;
  if (Math.abs(c2) <= 1e-6 && onSegment(a, d, b)) return true;
  if (Math.abs(c3) <= 1e-6 && onSegment(c, a, d)) return true;
  if (Math.abs(c4) <= 1e-6 && onSegment(c, b, d)) return true;
  return (c1 > 0) !== (c2 > 0) && (c3 > 0) !== (c4 > 0);
}

function boardPolygonIntersectsRect(
  polygon: Array<{ x: number; z: number }>,
  rect: { xMin: number; xMax: number; zMin: number; zMax: number },
): boolean {
  if (polygon.some((point) => boardPointInRect(point, rect))) return true;
  const corners = [
    { x: rect.xMin, z: rect.zMin },
    { x: rect.xMax, z: rect.zMin },
    { x: rect.xMax, z: rect.zMax },
    { x: rect.xMin, z: rect.zMax },
  ];
  if (corners.some((corner) => polygonContainsBoardPoint(corner, polygon))) return true;
  const rectEdges = [
    [corners[0]!, corners[1]!],
    [corners[1]!, corners[2]!],
    [corners[2]!, corners[3]!],
    [corners[3]!, corners[0]!],
  ] as const;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    if (rectEdges.some(([c, d]) => boardSegmentsIntersect(a, b, c, d))) return true;
  }
  return false;
}

function manualTerrainPreviewLegal(
  field: TerrainObject,
  deploymentConfig: DeploymentConfig,
): boolean {
  const polygon = terrainObjectPolygon(field) ?? [];
  if (polygon.length < 3) return false;
  if (polygon.some((point) =>
    point.x < -BOARD_W / 2 - 1e-6 ||
    point.x > BOARD_W / 2 + 1e-6 ||
    point.z < -BOARD_D / 2 - 1e-6 ||
    point.z > BOARD_D / 2 + 1e-6
  )) {
    return false;
  }
  return !manualTerrainForbiddenRects(deploymentConfig).some((rect) =>
    boardPolygonIntersectsRect(polygon, rect),
  );
}

function LiveCloudFlipbookSmoke({
  position = [0, 0, 0],
  modelScale = 1,
  intensityScale = 1,
  spreadScale = 1,
  color,
  secondaryColor,
}: {
  position?: [number, number, number];
  modelScale?: number;
  intensityScale?: number;
  spreadScale?: number;
  color?: string;
  secondaryColor?: string;
}) {
  const sourceTexture = useLoader(
    THREE.TextureLoader,
    boardTextureUrl(BOARD_SMOKE_TEXTURE_FILENAME),
  );
  const elapsedRef = useRef(0);
  const tuning = DEFAULT_BOARD_SMOKE_TUNING;
  const effectScale = modelScale > 0 ? 1 / modelScale : 1;
  const count = clampSmokeValue(Math.round(tuning.count), 1, 12);
  const columns = 8;
  const rows = 8;
  const frameCount = columns * rows;
  const puffs = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const angle = i * 2.399;
        const radius =
          (0.18 + (i % 4) * 0.16) * tuning.spread * spreadScale;
        return {
          x: Math.cos(angle) * radius,
          z: Math.sin(angle) * radius,
          y: tuning.arc + (i % 3) * 0.18,
          scale: (1.25 + (i % 4) * 0.24) * tuning.size,
          phase: i * 7,
          opacity:
            (0.24 + (i % 3) * 0.04) *
            tuning.intensity *
            intensityScale,
        };
      }),
    [count, intensityScale, spreadScale, tuning],
  );
  const frameTextures = useMemo(
    () =>
      puffs.map(() => {
        const texture = sourceTexture.clone();
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.repeat.set(1 / columns, 1 / rows);
        texture.needsUpdate = true;
        return texture;
      }),
    [puffs, sourceTexture],
  );

  useEffect(
    () => () => {
      for (const texture of frameTextures) texture.dispose();
    },
    [frameTextures],
  );

  useFrame((_, delta) => {
    elapsedRef.current += delta;
    const frameRate = 18 * clampSmokeValue(tuning.speed, 0.25, 3);
    for (let i = 0; i < frameTextures.length; i += 1) {
      const texture = frameTextures[i];
      const frame =
        Math.floor(elapsedRef.current * frameRate + (puffs[i]?.phase ?? 0)) %
        frameCount;
      const column = frame % columns;
      const row = Math.floor(frame / columns);
      texture.offset.x = column / columns;
      texture.offset.y = 1 - (row + 1) / rows;
    }
  });

  return (
    <group position={position} scale={[effectScale, effectScale, effectScale]}>
      {puffs.map((puff, i) => (
        <Billboard key={i} position={[puff.x, puff.y, puff.z]}>
          <mesh
            scale={[puff.scale, puff.scale, puff.scale]}
            raycast={() => null}
            renderOrder={10}
          >
            <planeGeometry args={[2.15, 2.15]} />
            <meshBasicMaterial
              map={frameTextures[i]}
              color={color ?? tuning.color}
              transparent
              opacity={puff.opacity * tuning.fade}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
              side={THREE.DoubleSide}
              toneMapped={false}
            />
          </mesh>
        </Billboard>
      ))}
      <pointLight
        color={secondaryColor ?? tuning.secondaryColor}
        intensity={1.2 * tuning.intensity * intensityScale}
        distance={5 * tuning.spread * spreadScale}
        position={[0, 1.2, 0]}
      />
    </group>
  );
}

function LiveAnchorSmoke({
  anchor,
  modelScale,
}: {
  anchor: DamageVfxAnchor;
  modelScale: number;
}) {
  return (
    <LiveCloudFlipbookSmoke
      position={anchor.position}
      modelScale={modelScale}
    />
  );
}

function LiveAnchorGlow({
  anchor,
  modelScale,
}: {
  anchor: DamageVfxAnchor;
  modelScale: number;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const effectScale = modelScale > 0 ? 1 / modelScale : 1;

  useFrame(({ clock }) => {
    const pulse = (Math.sin(clock.elapsedTime * 4.8) + 1) / 2;
    if (meshRef.current) {
      meshRef.current.scale.setScalar((0.2 + pulse * 0.04) * 0.3);
    }
    if (matRef.current) matRef.current.opacity = 0.12 + pulse * 0.24;
    if (lightRef.current) lightRef.current.intensity = 0.55 + pulse * 1.15;
  });

  return (
    <group
      position={anchor.position}
      scale={[effectScale, effectScale, effectScale]}
    >
      <mesh ref={meshRef} raycast={() => null}>
        <sphereGeometry args={[1, 24, 16]} />
        <meshBasicMaterial
          ref={matRef}
          color="#ef4444"
          transparent
          opacity={0.2}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <pointLight
        ref={lightRef}
        color="#f97316"
        intensity={0.8}
        distance={1.8}
      />
    </group>
  );
}

function LiveAnchorEmberTrail({
  anchor,
  modelScale,
}: {
  anchor: DamageVfxAnchor;
  modelScale: number;
}) {
  const effectScale = modelScale > 0 ? 1 / modelScale : 1;
  return (
    <group
      position={anchor.position}
      scale={[effectScale, effectScale, effectScale]}
    >
      <ShipDamagePointSparks level={0.85} destroyed />
    </group>
  );
}

function LiveDamageAnchorEffect({
  anchor,
  modelScale,
}: {
  anchor: DamageVfxAnchor;
  modelScale: number;
}) {
  if (
    anchor.name.startsWith("wreck_smoke") ||
    anchor.name.startsWith("smoke_light")
  ) {
    return <LiveAnchorSmoke anchor={anchor} modelScale={modelScale} />;
  }
  if (anchor.name.startsWith("small_glow")) {
    return <LiveAnchorGlow anchor={anchor} modelScale={modelScale} />;
  }
  if (anchor.name.startsWith("ember_trail")) {
    return <LiveAnchorEmberTrail anchor={anchor} modelScale={modelScale} />;
  }
  return null;
}

function LiveExplodingOriginPlume() {
  return (
    <LiveCloudFlipbookSmoke
      color="#f97316"
      secondaryColor="#facc15"
      intensityScale={1.15}
      spreadScale={0.9}
    />
  );
}

function configureExplodingOrbTexture(
  texture: THREE.Texture,
  colorSpace: THREE.ColorSpace = THREE.SRGBColorSpace,
): void {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = colorSpace;
  texture.needsUpdate = true;
}

function LiveExplodingCorePulse() {
  const meshRef = useRef<THREE.Mesh>(null);
  const coreRef = useRef<THREE.Mesh>(null);
  const coreMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const [primaryTexture, secondaryTexture, alphaTexture] = useLoader(
    THREE.TextureLoader,
    [
      boardTextureUrl("T_Noise1_nk.png"),
      boardTextureUrl("T_FirePanningCyl45.png"),
      boardTextureUrl("T_Noise_HU85k.png"),
    ],
  ) as THREE.Texture[];
  const orbSize = 0.27;
  const intensity = 1.35;
  const fade = 0.95;

  useMemo(() => {
    configureExplodingOrbTexture(primaryTexture);
    configureExplodingOrbTexture(secondaryTexture);
    configureExplodingOrbTexture(alphaTexture, THREE.NoColorSpace);
  }, [alphaTexture, primaryTexture, secondaryTexture]);

  const uniforms = useMemo(
    () => ({
      uPrimaryMap: { value: primaryTexture },
      uSecondaryMap: { value: secondaryTexture },
      uAlphaMap: { value: alphaTexture },
      uTime: { value: 0 },
      uColor: { value: new THREE.Color("#ef4444") },
      uSecondaryColor: { value: new THREE.Color("#fff7ed") },
      uIntensity: { value: intensity },
      uFade: { value: fade },
      uAlphaSource: { value: 0 },
      uAlphaFloor: { value: 0.04 },
      uAlphaStrength: { value: 1 },
      uSecondaryMix: { value: 0.18 },
      uEmissiveBoost: { value: 1.1 },
      uRimBoost: { value: 0.55 },
      uRimAlpha: { value: 0.11 },
      uFresnelPower: { value: 1.5 },
      uThreshold: { value: 0.62 },
      uPulseAmount: { value: 0.3 },
      uPrimarySpeed: { value: new THREE.Vector2(0.06, 0.05) },
      uSecondarySpeed: { value: new THREE.Vector2(0, -0.12) },
      uAlphaSpeed: { value: new THREE.Vector2(-0.04, 0.04) },
      uPrimaryRepeat: { value: new THREE.Vector2(2.8, 2.8) },
      uSecondaryRepeat: { value: new THREE.Vector2(1, 1) },
      uAlphaRepeat: { value: new THREE.Vector2(1.6, 1.6) },
    }),
    [alphaTexture, primaryTexture, secondaryTexture],
  );

  useFrame(({ clock }) => {
    const elapsed = clock.elapsedTime * 0.95;
    const pulse = (Math.sin(elapsed * 4.2) + 1) / 2;
    if (meshRef.current) {
      meshRef.current.scale.setScalar((1.16 + pulse * 0.16) * orbSize);
    }
    if (coreRef.current) {
      coreRef.current.scale.setScalar((0.38 + pulse * 0.08) * orbSize);
    }
    if (coreMatRef.current) {
      coreMatRef.current.opacity = 0.24 * intensity;
    }
    if (lightRef.current) {
      lightRef.current.intensity = (1.4 + pulse * 3.8) * intensity;
    }
    uniforms.uTime.value = elapsed;
    uniforms.uFade.value = fade;
  });

  return (
    <group>
      <mesh ref={meshRef} raycast={() => null}>
        <sphereGeometry args={[1.45, 48, 28]} />
        <shaderMaterial
          uniforms={uniforms}
          vertexShader={`
            varying vec2 vUv;
            varying vec3 vWorldNormal;
            varying vec3 vViewDir;
            void main() {
              vUv = uv;
              vec4 worldPosition = modelMatrix * vec4(position, 1.0);
              vWorldNormal = normalize(mat3(modelMatrix) * normal);
              vViewDir = normalize(cameraPosition - worldPosition.xyz);
              gl_Position = projectionMatrix * viewMatrix * worldPosition;
            }
          `}
          fragmentShader={`
            uniform sampler2D uPrimaryMap;
            uniform sampler2D uSecondaryMap;
            uniform sampler2D uAlphaMap;
            uniform float uTime;
            uniform vec3 uColor;
            uniform vec3 uSecondaryColor;
            uniform float uIntensity;
            uniform float uFade;
            uniform float uAlphaSource;
            uniform float uAlphaFloor;
            uniform float uAlphaStrength;
            uniform float uSecondaryMix;
            uniform float uEmissiveBoost;
            uniform float uRimBoost;
            uniform float uRimAlpha;
            uniform float uFresnelPower;
            uniform float uThreshold;
            uniform float uPulseAmount;
            uniform vec2 uPrimarySpeed;
            uniform vec2 uSecondarySpeed;
            uniform vec2 uAlphaSpeed;
            uniform vec2 uPrimaryRepeat;
            uniform vec2 uSecondaryRepeat;
            uniform vec2 uAlphaRepeat;
            varying vec2 vUv;
            varying vec3 vWorldNormal;
            varying vec3 vViewDir;

            void main() {
              vec4 primary = texture2D(uPrimaryMap, vUv * uPrimaryRepeat + uPrimarySpeed * uTime);
              vec4 secondary = texture2D(uSecondaryMap, vUv * uSecondaryRepeat + uSecondarySpeed * uTime);
              vec4 alphaTex = texture2D(uAlphaMap, vUv * uAlphaRepeat + uAlphaSpeed * uTime);
              float alphaSample = primary.r;
              if (uAlphaSource > 0.5 && uAlphaSource < 1.5) {
                alphaSample = secondary.r;
              } else if (uAlphaSource >= 1.5) {
                alphaSample = alphaTex.r;
              }
              float cut = smoothstep(uThreshold - 0.16, uThreshold + 0.16, alphaSample);
              float fresnel = pow(1.0 - clamp(abs(dot(normalize(vWorldNormal), normalize(vViewDir))), 0.0, 1.0), uFresnelPower);
              float pulse = 1.0 + sin(uTime * 4.2) * uPulseAmount;
              vec3 mappedColor = uColor * (0.38 + primary.rgb * 1.25);
              mappedColor = mix(mappedColor, uSecondaryColor * (0.32 + secondary.rgb * 1.25), uSecondaryMix);
              mappedColor += uSecondaryColor * alphaTex.r * uEmissiveBoost;
              mappedColor += uSecondaryColor * fresnel * uRimBoost;
              float alpha = (uAlphaFloor + cut * uAlphaStrength + fresnel * uRimAlpha) * uIntensity * uFade * pulse;
              gl_FragColor = vec4(mappedColor * uIntensity, clamp(alpha, 0.0, 0.92));
            }
          `}
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
      <mesh ref={coreRef} raycast={() => null}>
        <sphereGeometry args={[0.72, 32, 18]} />
        <meshBasicMaterial
          ref={coreMatRef}
          color="#fff7ed"
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <pointLight ref={lightRef} color="#ef4444" intensity={0} distance={8} />
    </group>
  );
}

type ScoutSupportVisualEffect = "counter-stealth" | "coord";

const SCOUT_SUPPORT_SHOCKWAVE_TUNING = {
  speed: 1,
  size: 5,
  fade: 3,
  intensity: 1.35,
  count: 2,
} as const;

function ScoutSupportPraxisShockwave({
  color,
  layer = 0,
}: {
  color: string;
  layer?: number;
}) {
  const sourceTexture = useLoader(
    THREE.TextureLoader,
    boardTextureUrl(BOARD_PRAXIS_TEXTURE_FILENAME),
  );
  const elapsedRef = useRef(layer * 0.45);
  const ringGroupRef = useRef<THREE.Group>(null);
  const repetitionCount = SCOUT_SUPPORT_SHOCKWAVE_TUNING.count;
  const lifetime = SCOUT_SUPPORT_SHOCKWAVE_TUNING.fade;
  const endDiameter = SCOUT_SUPPORT_SHOCKWAVE_TUNING.size;

  useEffect(() => {
    sourceTexture.colorSpace = THREE.SRGBColorSpace;
    sourceTexture.wrapS = THREE.ClampToEdgeWrapping;
    sourceTexture.wrapT = THREE.ClampToEdgeWrapping;
    sourceTexture.minFilter = THREE.LinearFilter;
    sourceTexture.magFilter = THREE.LinearFilter;
    sourceTexture.needsUpdate = true;
  }, [sourceTexture]);

  useFrame((_, delta) => {
    elapsedRef.current += delta * SCOUT_SUPPORT_SHOCKWAVE_TUNING.speed;
    const group = ringGroupRef.current;
    if (!group) return;

    group.children.forEach((child, index) => {
      const mesh = child as THREE.Mesh;
      const material = mesh.material as THREE.MeshBasicMaterial;
      const phase =
        ((elapsedRef.current / lifetime - index / repetitionCount) % 1 + 1) %
        1;
      const easedExpansion = 1 - Math.pow(1 - phase, 2.2);
      const diameter = Math.max(0.02, easedExpansion * endDiameter);
      const fadeIn = THREE.MathUtils.clamp(phase / 0.055, 0, 1);
      const fadeOut = Math.pow(1 - phase, 1.35);

      mesh.scale.set(diameter, diameter, 1);
      material.opacity = Math.min(
        1,
        fadeIn * fadeOut * SCOUT_SUPPORT_SHOCKWAVE_TUNING.intensity,
      );
    });
  });

  return (
    <group
      ref={ringGroupRef}
      position={[0, 0.08 + layer * 0.012, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
    >
      {Array.from({ length: repetitionCount }).map((_, index) => (
        <mesh key={index} raycast={() => null} renderOrder={18 + layer + index}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            map={sourceTexture}
            color={color}
            transparent
            opacity={0}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            depthTest
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}

function ScoutSupportShockwaves({
  effects,
}: {
  effects: ScoutSupportVisualEffect[];
}) {
  if (effects.length === 0) return null;
  return (
    <>
      {effects.map((effect, index) => (
        <ScoutSupportPraxisShockwave
          key={effect}
          color={effect === "counter-stealth" ? "#8bdcff" : "#7a30e8"}
          layer={index}
        />
      ))}
    </>
  );
}

function UnitHealthBar({
  hullPct,
  crewPct,
  hasCrewTrack,
  faceCamera = false,
}: {
  hullPct: number;
  crewPct?: number;
  hasCrewTrack?: boolean;
  faceCamera?: boolean;
}) {
  const hullWidth = hasCrewTrack ? 0.98 : 2;
  const crewWidth = 0.98;
  const hullColor = statusHullColor(hullPct);
  const crewFillPct = hasCrewTrack ? Math.max(0, Math.min(1, crewPct ?? 0)) : 0;
  const crewColor = statusCrewColor(crewFillPct);
  const content = (
    <>
      <mesh>
        <planeGeometry args={[2, 0.18]} />
        <meshBasicMaterial color="#1f2937" transparent opacity={0.9} />
      </mesh>
      <mesh
        position={[
          hasCrewTrack
            ? -1 + (hullWidth * hullPct) / 2
            : -1 + hullPct,
          0,
          0.001,
        ]}
        scale={[hullPct, 1, 1]}
      >
        <planeGeometry args={[hullWidth, 0.15]} />
        <meshBasicMaterial color={hullColor} />
      </mesh>
      {hasCrewTrack && (
        <>
          <mesh position={[0, 0, 0.002]}>
            <planeGeometry args={[0.035, 0.18]} />
            <meshBasicMaterial color="#020617" transparent opacity={0.95} />
          </mesh>
          <mesh
            position={[
              0.02 + (crewWidth * crewFillPct) / 2,
              0,
              0.001,
            ]}
            scale={[crewFillPct, 1, 1]}
          >
            <planeGeometry args={[crewWidth, 0.15]} />
            <meshBasicMaterial color={crewColor} />
          </mesh>
        </>
      )}
    </>
  );

  return faceCamera ? (
    <CameraFacingGroup position={[0, 3.2, 0]}>{content}</CameraFacingGroup>
  ) : (
    <group position={[0, 3.2, 0]}>{content}</group>
  );
}

function statusHullColor(value: number): string {
  return value > 0.5 ? "#22c55e" : value > 0.25 ? "#f59e0b" : "#ef4444";
}

function statusCrewColor(value: number): string {
  return value > 0.5 ? "#38bdf8" : value > 0.25 ? "#a855f7" : "#ec4899";
}

function UnitStatusText({
  hullPoints,
  hullPct,
  crewPoints,
  crewPct,
  hasCrewTrack,
  nameVisible,
}: {
  hullPoints: number;
  hullPct: number;
  crewPoints?: number | null;
  crewPct: number;
  hasCrewTrack: boolean;
  nameVisible: boolean;
}) {
  const y = nameVisible ? 3.42 : 3.62;
  const fontSize = 0.24;
  const outlineWidth = 0.03;
  const labelColor = "#e5e7eb";
  const hullLabelX = hasCrewTrack ? -0.68 : -0.18;
  const hullValueX = hasCrewTrack ? -0.33 : 0.2;
  const separatorX = -0.02;
  const crewLabelX = 0.3;
  const crewValueX = 0.66;

  return (
    <CameraFacingGroup position={[0, y, 0]}>
      <Text
        position={[hullLabelX, 0, 0]}
        fontSize={fontSize}
        color={labelColor}
        anchorX="center"
        anchorY="middle"
        outlineWidth={outlineWidth}
        outlineColor="black"
      >
        Hull
      </Text>
      <Text
        position={[hullValueX, 0, 0]}
        fontSize={fontSize}
        color={statusHullColor(hullPct)}
        anchorX="center"
        anchorY="middle"
        outlineWidth={outlineWidth}
        outlineColor="black"
      >
        {Math.max(0, Math.round(hullPoints))}
      </Text>
      {hasCrewTrack && (
        <>
          <Text
            position={[separatorX, 0, 0]}
            fontSize={fontSize}
            color="#94a3b8"
            anchorX="center"
            anchorY="middle"
            outlineWidth={outlineWidth}
            outlineColor="black"
          >
            |
          </Text>
          <Text
            position={[crewLabelX, 0, 0]}
            fontSize={fontSize}
            color={labelColor}
            anchorX="center"
            anchorY="middle"
            outlineWidth={outlineWidth}
            outlineColor="black"
          >
            Crew
          </Text>
          <Text
            position={[crewValueX, 0, 0]}
            fontSize={fontSize}
            color={statusCrewColor(crewPct)}
            anchorX="center"
            anchorY="middle"
            outlineWidth={outlineWidth}
            outlineColor="black"
          >
            {Math.max(0, Math.round(crewPoints ?? 0))}
          </Text>
        </>
      )}
    </CameraFacingGroup>
  );
}

function GameUnit3D({
  unit,
  isSelected,
  onClick,
  onCameraFocus,
  onHoverChange,
  myUserId,
  weapons,
  dragOffset,
  previewHeadingDelta = 0,
  visualAttackTurn,
  phaseViable,
  firingArc,
  projectedWeaponArcs = [],
  weaponArcReadiness = {},
  targetingPreview = null,
  launchHighlight = false,
  damageControlHighlight = false,
  dogfightLocked = false,
  arcColorScheme = "classic",
  healthBarFacesCamera = false,
  shipMeshTintsEnabled = true,
  shipHullNamesEnabled = true,
  shipStatusDisplayMode = "bar",
  isFighter = false,
  scoutSupportEffects = [],
  terrainFields = [],
  weaponArcProjectionOutlineOnly = false,
}: {
  unit: {
    id: number;
    hexQ: number;
    hexR: number;
    heading: number;
    name: string;
    modelFilename: string;
    ownerId: string;
    hullPoints: number;
    maxHullPoints: number;
    crewPoints?: number | null;
    maxCrewPoints?: number | null;
    isDestroyed: boolean;
    faction: string;
    speed: number;
    turnAngle: number;
    damageState?: string | null;
    baseRadiusInches?: number | null;
  };
  isSelected: boolean;
  onClick: () => void;
  onCameraFocus: () => void;
  onHoverChange?: (unitId: number | null) => void;
  myUserId: string;
  weapons: Pick<Weapon, "arc" | "range">[];
  dragOffset?: { x: number; z: number } | null;
  previewHeadingDelta?: number;
  visualAttackTurn?: { key: string; targetHeading: number } | null;
  phaseViable?: boolean;
  arcColorScheme?: UiArcColorScheme;
  healthBarFacesCamera?: boolean;
  shipMeshTintsEnabled?: boolean;
  shipHullNamesEnabled?: boolean;
  shipStatusDisplayMode?: UiShipStatusDisplayMode;
  isFighter?: boolean;
  scoutSupportEffects?: ScoutSupportVisualEffect[];
  terrainFields?: TerrainObject[];
  weaponArcProjectionOutlineOnly?: boolean;
  // When set, draws a translucent "weapon coverage" sector at full range for
  // the currently-selected firing weapon so the player can see eligible
  // targets. Only rendered for the active firing ship.
  firingArc?: { arc: string; range: number } | null;
  projectedWeaponArcs?: Array<{ arc: string; range: number }>;
  weaponArcReadiness?: WeaponArcReadinessMap;
  targetingPreview?: TargetingPreviewState | null;
  launchHighlight?: boolean;
  damageControlHighlight?: boolean;
  dogfightLocked?: boolean;
}) {
  const [bx, , bz] = hexToWorld(unit.hexQ, unit.hexR);
  const isMine = unit.ownerId === myUserId;
  const arcSide = isMine ? "friendly" : "enemy";
  const sideColor = isMine ? "#34eb52" : "#ff0004";
  const destroyedGrey = "#7f8794";
  const visuallyDestroyed = !unitIsCombatEffective(unit);
  const targetEligible = targetingPreview === "eligible" && !visuallyDestroyed;
  const targetIneligible = targetingPreview === "ineligible" && !visuallyDestroyed;
  const launchHighlighted = launchHighlight && !visuallyDestroyed;
  const lightBlueHighlight = targetEligible || launchHighlighted;
  const haloColor = visuallyDestroyed
    ? destroyedGrey
    : lightBlueHighlight
      ? "#7dd3fc"
      : targetIneligible
        ? "#334155"
    : phaseViable
      ? sideColor
      : "#ffffff";
  const selectionColor = visuallyDestroyed ? "#8a93a1" : "#f59e0b";
  const modelTint = visuallyDestroyed ? "#6b7280" : lightBlueHighlight ? "#93c5fd" : sideColor;
  const baseColor = targetIneligible ? "#030712" : "#000000";
  const baseEdgeColor = visuallyDestroyed
    ? "#6b7280"
    : targetEligible
      ? "#7dd3fc"
      : targetIneligible
        ? "#1e293b"
        : "#94a3b8";
  const hpPct =
    unit.maxHullPoints > 0
      ? Math.max(0, Math.min(1, unit.hullPoints / unit.maxHullPoints))
      : 0;
  const crewPct =
    (unit.maxCrewPoints ?? 0) > 0
      ? Math.max(
          0,
          Math.min(1, (unit.crewPoints ?? 0) / (unit.maxCrewPoints ?? 1)),
        )
      : 0;
  const hasCrewTrack = (unit.maxCrewPoints ?? 0) > 0;
  const nonNormalDamageState = Boolean(
    unit.damageState && unit.damageState !== "normal",
  );
  const fireLevel =
    unit.isDestroyed ||
    unit.hullPoints <= 0 ||
    unit.damageState === "exploding-end-of-next"
      ? 1
      : hpPct <= 0.25
        ? 0.72
        : nonNormalDamageState
          ? 0.5
          : hpPct <= 0.5
            ? 0.36
            : 0;
  const hasPreview =
    Boolean(dragOffset) || Math.abs(previewHeadingDelta) > 0.001;
  const useShadowDamageVfx = !isFighter && isShadowCodedDamageVessel(unit);
  const visualModelFilename = visualModelFilenameForUnit({
    modelFilename: unit.modelFilename,
    isDestroyed: unit.isDestroyed,
    damageState: unit.damageState,
  });
  const headingRad = (unit.heading * Math.PI) / 180;
  const previewHeadingRad =
    ((unit.heading + previewHeadingDelta) * Math.PI) / 180;
  const baseRadius = rulesBaseRadius(unit);
  const ringInner = Math.max(0.05, baseRadius - 0.05);
  const haloRingInner = baseRadius + 0.05;
  const haloRingOuter = baseRadius + 0.14;
  const pulseInner = baseRadius + 0.18;
  const pulseOuter = baseRadius + 0.28;
  const targetRingInner = baseRadius + 0.32;
  const targetRingOuter = baseRadius + 0.48;
  const haloMaterialRef = useRef<THREE.MeshStandardMaterial>(null);
  const targetMaterialRef = useRef<THREE.MeshStandardMaterial>(null);
  const damageControlDiskMaterialRef = useRef<THREE.MeshBasicMaterial>(null);
  const dogfightRimMaterialRef = useRef<THREE.MeshStandardMaterial>(null);
  const modelHeadingRef = useRef<THREE.Group>(null);
  const modelAttitudeRef = useRef<THREE.Group>(null);
  const visualAttackKeyRef = useRef<string | null>(null);
  const visualAttackStartRef = useRef(0);
  const pulseHalo = Boolean((phaseViable || lightBlueHighlight) && !visuallyDestroyed);
  const dimOpacityScale = targetIneligible ? 0.38 : 1;
  const terrainCovered = !hasPreview && !visuallyDestroyed
    ? terrainFields.some((field) =>
        pointInsideTerrainObject({ x: unit.hexQ, z: unit.hexR }, field),
      )
    : false;
  const terrainMeshHighlight = terrainCovered && !lightBlueHighlight && !targetIneligible;
  const modelOpacity = hasPreview
    ? 0.28
    : targetIneligible
      ? 0.24
      : 1;
  const usesAnchoredDeadMeshVisual = [
    DEAD_BINTAK_MODEL_FILENAME,
    DEAD_HYPERION_MODEL_FILENAME,
    DEAD_OMEGA_MODEL_FILENAME,
  ].includes(visualModelFilename.toLowerCase());
  const usesAdriftVisual = unit.damageState === "adrift" && !isFighter;
  const usesOmegaAdriftWreckVisual =
    usesAdriftVisual && visualModelFilename.toLowerCase() === "omega.glb";
  const usesAnimatedAdriftVisual =
    usesAdriftVisual && !usesOmegaAdriftWreckVisual;
  const usesExplodingVisual =
    unit.damageState === "exploding-end-of-next" && !isFighter;
  const showGenericDamageSparks =
    !usesAnimatedAdriftVisual &&
    !usesExplodingVisual &&
    !usesAnchoredDeadMeshVisual &&
    fireLevel > 0;
  const showGenericDestroyedSmoke =
    !useShadowDamageVfx &&
    !usesAnchoredDeadMeshVisual &&
    !usesExplodingVisual &&
    !usesAnimatedAdriftVisual &&
    (visuallyDestroyed || fireLevel >= 0.7);

  useFrame(({ clock }) => {
    const elapsedSeconds = clock.getElapsedTime();
    const modelHeading = modelHeadingRef.current;
    if (modelHeading) {
      let visualHeading = unit.heading;
      if (visualAttackTurn) {
        if (visualAttackKeyRef.current !== visualAttackTurn.key) {
          visualAttackKeyRef.current = visualAttackTurn.key;
          visualAttackStartRef.current = performance.now();
        }
        const elapsed = performance.now() - visualAttackStartRef.current;
        const turnToward = THREE.MathUtils.clamp(elapsed / 1000, 0, 1);
        const returnHome = THREE.MathUtils.clamp((elapsed - 4000) / 1000, 0, 1);
        const heldHeading = interpolateHeadingDegrees(
          unit.heading,
          visualAttackTurn.targetHeading,
          turnToward,
        );
        visualHeading = interpolateHeadingDegrees(
          heldHeading,
          unit.heading,
          returnHome,
        );
      } else {
        visualAttackKeyRef.current = null;
      }
      modelHeading.rotation.y = THREE.MathUtils.degToRad(visualHeading);
    }
    const modelAttitude = modelAttitudeRef.current;
    if (modelAttitude) {
      if (usesAnimatedAdriftVisual && !hasPreview) {
        const t = clock.elapsedTime * 0.35;
        modelAttitude.rotation.x = THREE.MathUtils.degToRad(
          9 + Math.sin(t * 0.83) * 8,
        );
        modelAttitude.rotation.y = Math.sin(t * 0.42) * 0.12;
        modelAttitude.rotation.z = THREE.MathUtils.degToRad(
          -11 + Math.cos(t * 0.71) * 9,
        );
      } else {
        modelAttitude.rotation.set(0, 0, 0);
      }
    }
    const mat = haloMaterialRef.current;
    if (mat) {
      if (!pulseHalo) {
        mat.emissiveIntensity = visuallyDestroyed ? 0.1 : targetIneligible ? 0.02 : 0.48;
      } else {
        const flashOn = clock.getElapsedTime() % 1 < 0.2;
        mat.emissiveIntensity = lightBlueHighlight
          ? (flashOn ? 1.8 : 0.55)
          : (flashOn ? 1.35 : 0.28);
      }
    }
    const targetMat = targetMaterialRef.current;
    if (targetMat) {
      const t = (Math.sin(elapsedSeconds * 4.5) + 1) / 2;
      targetMat.opacity = 0.58 + t * 0.24;
      targetMat.emissiveIntensity = 0.7 + t * 0.55;
    }
    const dcDiskMat = damageControlDiskMaterialRef.current;
    if (dcDiskMat) {
      const t = (Math.sin(elapsedSeconds * 4.2) + 1) / 2;
      dcDiskMat.opacity = 0.16 + t * 0.28;
    }
    const dogfightRimMat = dogfightRimMaterialRef.current;
    if (dogfightRimMat) {
      const t = (Math.sin(elapsedSeconds * 4.8) + 1) / 2;
      dogfightRimMat.opacity = 0.5 + t * 0.28;
      dogfightRimMat.emissiveIntensity = 0.7 + t * 0.55;
    }
  });

  return (
    <group
      position={[bx, 0, bz]}
      onClick={onClick}
      onPointerMove={() => onHoverChange?.(unit.id)}
      onPointerOut={() => onHoverChange?.(null)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onCameraFocus();
      }}
    >
      {!hasPreview && (
        <group rotation={[0, headingRad, 0]}>
          <BaseOrientationDisplay
            flip={FLIP_MODELS.has(unit.modelFilename)}
            baseRadius={baseRadius}
            opacityScale={(isSelected ? 1 : 0.82) * dimOpacityScale}
            muted={visuallyDestroyed || targetIneligible}
            arcColorScheme={arcColorScheme}
            arcSide={arcSide}
          />
        </group>
      )}
      {/* Opaque collision/overlap base, drawn above the orientation arcs. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <circleGeometry args={[baseRadius, 48]} />
        <meshStandardMaterial
          color={baseColor}
          transparent={hasPreview || targetIneligible}
          opacity={hasPreview ? 0.28 : targetIneligible ? 0.78 : 1}
          depthWrite={!hasPreview && !targetIneligible}
        />
      </mesh>
      {damageControlHighlight && !hasPreview && (
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.026, 0]}
          renderOrder={7}
        >
          <circleGeometry args={[Math.max(0.05, baseRadius * 0.88), 48]} />
          <meshBasicMaterial
            ref={damageControlDiskMaterialRef}
            color="#ffffff"
            transparent
            opacity={0.24}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      )}
      {dogfightLocked && isFighter && !hasPreview && !visuallyDestroyed && (
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.032, 0]}
          renderOrder={8}
        >
          <ringGeometry args={[baseRadius + 0.06, baseRadius + 0.24, 56]} />
          <meshStandardMaterial
            ref={dogfightRimMaterialRef}
            color="#a855f7"
            emissive="#d946ef"
            emissiveIntensity={0.95}
            transparent
            opacity={0.66}
            depthWrite={false}
          />
        </mesh>
      )}
      {/* Base ring edge */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <ringGeometry args={[ringInner, baseRadius, 48]} />
        <meshStandardMaterial
          color={baseEdgeColor}
          transparent
          opacity={(isSelected ? 0.72 : lightBlueHighlight ? 0.72 : 0.42) * (hasPreview ? 0.35 : dimOpacityScale)}
          emissive={baseEdgeColor}
          emissiveIntensity={lightBlueHighlight ? 0.5 : isSelected ? 0.25 : targetIneligible ? 0.02 : 0.08}
        />
      </mesh>
      {!hasPreview && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.045, 0]}>
          <ringGeometry args={[haloRingInner, haloRingOuter, 48]} />
          <meshStandardMaterial
            ref={haloMaterialRef}
            color={haloColor}
            transparent
            opacity={visuallyDestroyed ? 0.34 : targetIneligible ? 0.16 : lightBlueHighlight ? 0.92 : 0.82}
            emissive={haloColor}
            emissiveIntensity={visuallyDestroyed ? 0.1 : targetIneligible ? 0.02 : 0.48}
            depthWrite={false}
          />
        </mesh>
      )}
      {lightBlueHighlight && !hasPreview && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.055, 0]}>
          <ringGeometry args={[targetRingInner, targetRingOuter, 64]} />
          <meshStandardMaterial
            ref={targetMaterialRef}
            color="#7dd3fc"
            emissive="#38bdf8"
            emissiveIntensity={0.9}
            transparent
            opacity={0.72}
            depthWrite={false}
          />
        </mesh>
      )}
      {!hasPreview && !visuallyDestroyed && (
        <ScoutSupportShockwaves effects={scoutSupportEffects} />
      )}
      {/* Selection pulse ring */}
      {isSelected && !hasPreview && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
          <ringGeometry args={[pulseInner, pulseOuter, 48]} />
          <meshStandardMaterial
            color={selectionColor}
            emissive={selectionColor}
            emissiveIntensity={visuallyDestroyed ? 0.25 : 0.8}
            transparent
            opacity={visuallyDestroyed ? 0.46 : 0.7}
          />
        </mesh>
      )}
      {/* Weapon arcs — rotate with heading */}
      {isSelected && weapons.length > 0 && !hasPreview && (
        <group rotation={[0, headingRad, 0]}>
          <WeaponArcDisplay
            weapons={weapons}
            flip={FLIP_MODELS.has(unit.modelFilename)}
            baseRadius={baseRadius}
            muted={visuallyDestroyed}
            arcColorScheme={arcColorScheme}
            arcSide={arcSide}
            arcReadiness={weaponArcReadiness}
          />
        </group>
      )}
      {/* Firing coverage — long-range arc showing eligible-target area */}
      {firingArc && !hasPreview && (
        <group rotation={[0, headingRad, 0]}>
          <RangeArcOverlay
            arc={firingArc.arc}
            range={firingArc.range}
            flip={FLIP_MODELS.has(unit.modelFilename)}
            arcColorScheme={arcColorScheme}
            arcSide={arcSide}
            outlineOnly={weaponArcProjectionOutlineOnly}
            readiness={weaponArcReadiness[canonicalWeaponArc(firingArc.arc)]}
          />
        </group>
      )}
      {projectedWeaponArcs.length > 0 && !hasPreview && !visuallyDestroyed && (
        <group rotation={[0, headingRad, 0]}>
          <WeaponRangeProjectionDisplay
            arcs={projectedWeaponArcs}
            flip={FLIP_MODELS.has(unit.modelFilename)}
            arcColorScheme={arcColorScheme}
            arcSide={arcSide}
            arcReadiness={weaponArcReadiness}
          />
        </group>
      )}
      {/* Ship model floating 2" above the base, rotated to heading */}
      <group ref={modelHeadingRef} position={[0, 2, 0]} rotation={[0, headingRad, 0]}>
        <group ref={modelAttitudeRef}>
          <ModelErrorBoundary color={modelTint}>
            <Suspense fallback={<ShipModelFallback color={modelTint} />}>
              <BoardModelVisual
                filename={visualModelFilename}
                tint={modelTint}
                opacity={modelOpacity}
                meshTintsEnabled={shipMeshTintsEnabled}
                damageAnchorEffects={!hasPreview && usesAnchoredDeadMeshVisual}
                terrainMeshHighlight={terrainMeshHighlight}
              />
            </Suspense>
          </ModelErrorBoundary>
          {!hasPreview && usesExplodingVisual && (
            <>
              <LiveExplodingOriginPlume />
              <LiveExplodingCorePulse />
            </>
          )}
        </group>
        {!hasPreview &&
          showGenericDamageSparks &&
          (useShadowDamageVfx ? (
            <ShadowDamageParticleSpray
              level={fireLevel}
              destroyed={visuallyDestroyed}
            />
          ) : (
            <ShipDamagePointSparks
              level={fireLevel}
              destroyed={visuallyDestroyed}
            />
          ))}
        {!hasPreview && showGenericDestroyedSmoke && (
          <DestroyedSmoke
            intensity={visuallyDestroyed ? 1 : 0.45}
            spread={visuallyDestroyed ? 1 : 0.45}
          />
        )}
      </group>
      {hasPreview && (
        <group position={[dragOffset?.x ?? 0, 0, dragOffset?.z ?? 0]}>
          <group rotation={[0, previewHeadingRad, 0]}>
            <BaseOrientationDisplay
              flip={FLIP_MODELS.has(unit.modelFilename)}
              baseRadius={baseRadius}
              opacityScale={0.75}
              muted={visuallyDestroyed}
              arcColorScheme={arcColorScheme}
              arcSide={arcSide}
            />
          </group>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
            <circleGeometry args={[baseRadius, 48]} />
            <meshStandardMaterial
              color="#22d3ee"
              transparent
              opacity={0.2}
              depthWrite={false}
            />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.035, 0]}>
            <ringGeometry args={[ringInner, baseRadius + 0.02, 48]} />
            <meshStandardMaterial
              color="#22d3ee"
              transparent
              opacity={0.9}
              emissive="#22d3ee"
              emissiveIntensity={0.6}
            />
          </mesh>
          {isSelected && weapons.length > 0 && (
            <group rotation={[0, previewHeadingRad, 0]}>
              <WeaponArcDisplay
                weapons={weapons}
                flip={FLIP_MODELS.has(unit.modelFilename)}
                baseRadius={baseRadius}
                muted={visuallyDestroyed}
                arcColorScheme={arcColorScheme}
                arcSide={arcSide}
                arcReadiness={weaponArcReadiness}
              />
            </group>
          )}
          {firingArc && (
            <group rotation={[0, previewHeadingRad, 0]}>
              <RangeArcOverlay
                arc={firingArc.arc}
                range={firingArc.range}
                flip={FLIP_MODELS.has(unit.modelFilename)}
                arcColorScheme={arcColorScheme}
                arcSide={arcSide}
                outlineOnly={weaponArcProjectionOutlineOnly}
                readiness={weaponArcReadiness[canonicalWeaponArc(firingArc.arc)]}
              />
            </group>
          )}
          {projectedWeaponArcs.length > 0 && !visuallyDestroyed && (
            <group rotation={[0, previewHeadingRad, 0]}>
              <WeaponRangeProjectionDisplay
                arcs={projectedWeaponArcs}
                flip={FLIP_MODELS.has(unit.modelFilename)}
                arcColorScheme={arcColorScheme}
                arcSide={arcSide}
                arcReadiness={weaponArcReadiness}
              />
            </group>
          )}
          <group position={[0, 2, 0]} rotation={[0, previewHeadingRad, 0]}>
            <ModelErrorBoundary color="#22d3ee">
              <Suspense
                fallback={<ShipModelFallback color="#22d3ee" opacity={0.66} />}
              >
                <BoardModelVisual
                  filename={visualModelFilename}
                  tint="#22d3ee"
                  opacity={0.66}
                />
              </Suspense>
            </ModelErrorBoundary>
          </group>
          <CameraFacingText
            position={[0, 3.35, 0]}
            fontSize={0.34}
            color="#67e8f9"
            anchorX="center"
            anchorY="middle"
            outlineWidth={0.04}
            outlineColor="black"
          >
            PREVIEW
          </CameraFacingText>
        </group>
      )}
      {!hasPreview && (
        <>
          {shipStatusDisplayMode === "bar" ? (
            <UnitHealthBar
              hullPct={hpPct}
              crewPct={crewPct}
              hasCrewTrack={hasCrewTrack}
              faceCamera={healthBarFacesCamera}
            />
          ) : (
            <UnitStatusText
              hullPoints={unit.hullPoints}
              hullPct={hpPct}
              crewPoints={unit.crewPoints}
              crewPct={crewPct}
              hasCrewTrack={hasCrewTrack}
              nameVisible={shipHullNamesEnabled}
            />
          )}
          {shipHullNamesEnabled && (
            <CameraFacingText
              position={[0, 3.7, 0]}
              fontSize={0.34}
              color="white"
              anchorX="center"
              anchorY="middle"
              outlineWidth={0.035}
              outlineColor="black"
            >
              {boardShipNameLabel(unit.name)}
            </CameraFacingText>
          )}
        </>
      )}
    </group>
  );
}

// Default destroyed-ship smoke uses the Cloud Flipbook Damage preset from the
// VFX range so live smoke matches the tuned flipbook look.
function DestroyedSmoke({
  intensity = 1,
  spread = 1,
}: {
  intensity?: number;
  spread?: number;
}) {
  return (
    <LiveCloudFlipbookSmoke
      intensityScale={clampSmokeValue(intensity, 0, 1)}
      spreadScale={clampSmokeValue(spread, 0.2, 1.4)}
    />
  );
}

function dogfightSeededUnit(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function DogfightImpactFlashes({
  effect,
  onDone,
}: {
  effect: DogfightImpactEffect;
  onDone: (id: number) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const startedAtRef = useRef<number | null>(null);
  const finishedRef = useRef(false);
  const tuning = DOGFIGHT_IMPACT_TUNING;
  const flashes = useMemo(
    () =>
      Array.from({ length: tuning.count }, (_, i) => {
        const radialSeed = dogfightSeededUnit(effect.id + i + 1.3);
        const sizeSeed = dogfightSeededUnit(effect.id + i + 9.7);
        const heightSeed = dogfightSeededUnit(effect.id + i + 17.1);
        const angle =
          i * 2.399963 +
          dogfightSeededUnit(effect.id + i + 4.2) * tuning.randomness * 0.9;
        const radius = (0.25 + radialSeed * 2.45) * tuning.spread;
        const baseSize =
          (0.32 + sizeSeed * (0.85 + tuning.randomness * 0.45)) *
          tuning.size;
        const height =
          (1.35 +
            tuning.arc * 0.32 +
            heightSeed * (0.8 + tuning.arc * 0.18)) *
          tuning.size;
        return {
          x: Math.cos(angle) * radius,
          z: Math.sin(angle) * radius,
          height,
          baseSize,
          phase: dogfightSeededUnit(effect.id + i + 29.4) * Math.PI * 2,
          spin: (dogfightSeededUnit(effect.id + i + 37.8) - 0.5) * 0.018,
          pulseSpeed: 0.7 + dogfightSeededUnit(effect.id + i + 44.6) * 0.9,
          accent: dogfightSeededUnit(effect.id + i + 52.5) > 0.62,
        };
      }),
    [
      effect.id,
      tuning.arc,
      tuning.count,
      tuning.randomness,
      tuning.size,
      tuning.spread,
    ],
  );

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    if (startedAtRef.current === null) startedAtRef.current = clock.elapsedTime;
    const age = clock.elapsedTime - startedAtRef.current;
    const duration = 10;
    const progress = Math.min(1, age / duration);
    const fadeIn = THREE.MathUtils.clamp(age / 0.25, 0, 1);
    const fadeOut = THREE.MathUtils.clamp((duration - age) / tuning.fade, 0, 1);
    const life = fadeIn * fadeOut;

    groupRef.current.children.forEach((child, i) => {
      const flash = flashes[i];
      if (!flash) return;
      const pulse =
        Math.sin(
          clock.elapsedTime * tuning.speed * flash.pulseSpeed + flash.phase,
        ) *
          0.5 +
        0.5;
      child.position.set(
        flash.x,
        flash.height +
          Math.sin(clock.elapsedTime * tuning.speed * 0.42 + flash.phase) *
            0.08 *
            tuning.spread,
        flash.z,
      );
      child.rotation.y += flash.spin * tuning.speed;
      child.scale.setScalar(flash.baseSize * (0.82 + pulse * 0.34));
      child.children.forEach((mesh, meshIndex) => {
        if (!("material" in mesh)) return;
        const mat = (mesh as THREE.Mesh).material as THREE.MeshBasicMaterial;
        mat.opacity =
          (meshIndex === 0
            ? (0.14 + pulse * 0.28) * tuning.intensity
            : (0.28 + pulse * 0.38) * tuning.intensity) * life;
      });
    });

    if (progress >= 1 && !finishedRef.current) {
      finishedRef.current = true;
      onDone(effect.id);
    }
  });

  return (
    <group position={[effect.x, 0, effect.z]}>
      <group ref={groupRef}>
        {flashes.map((flash, i) => (
          <group key={i} position={[flash.x, flash.height, flash.z]}>
            <mesh raycast={() => null}>
              <sphereGeometry args={[1, 24, 24]} />
              <meshBasicMaterial
                color={flash.accent ? tuning.secondaryColor : tuning.color}
                transparent
                opacity={0.24 * tuning.intensity}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
            <mesh raycast={() => null} scale={[1.04, 1.04, 1.04]}>
              <sphereGeometry args={[1, 18, 18]} />
              <meshBasicMaterial
                color={tuning.secondaryColor}
                transparent
                opacity={0.42 * tuning.intensity}
                wireframe
                blending={THREE.AdditiveBlending}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
          </group>
        ))}
      </group>
      <pointLight
        color={tuning.secondaryColor}
        intensity={2.6 * tuning.intensity}
        distance={9 * tuning.spread}
        position={[0, 2.4 + tuning.arc * 0.2, 0]}
      />
    </group>
  );
}

// Default hull-damage effect for non-Shadow ships.
const HULL_DAMAGE_SPARK_TUNING = {
  color: "#fb923c",
  secondaryColor: "#fef3c7",
  speed: 0.15,
  size: 1.5,
  fade: 1.45,
  intensity: 1.9,
  spread: 0.85,
  count: 55,
  arc: 0.55,
  thickness: 0.8,
  randomness: 0.25,
};

const SHADOW_DAMAGE_SPRAY_TUNING = {
  color: "#000000",
  secondaryColor: "#000000",
  speed: 0.95,
  size: 0.25,
  fade: 1.3,
  intensity: 3,
  spread: 0.2,
  count: 58,
  arc: 6,
  thickness: 4,
  randomness: 1.1,
  ribbonEffect: 0,
};

type ShadowDamageParticle = {
  yaw: number;
  distance: number;
  height: number;
  rise: number;
  speed: number;
  phase: number;
  size: number;
  wobble: number;
};

function shadowDamageParticlePosition(
  particle: ShadowDamageParticle,
  local: number,
  level: number,
  destroyed: boolean,
): THREE.Vector3 {
  const eased = 1 - Math.pow(1 - local, 1.7);
  const sideWobble =
    Math.sin(local * Math.PI * 2 + particle.phase * Math.PI * 2) *
    particle.wobble *
    Math.sin(local * Math.PI);
  const yaw = particle.yaw + sideWobble;
  const radius =
    particle.distance * eased * (0.88 + level * 0.16 + (destroyed ? 0.08 : 0));
  return new THREE.Vector3(
    Math.sin(yaw) * radius,
    0.28 + Math.sin(local * Math.PI) * particle.height + local * particle.rise,
    Math.cos(yaw) * radius,
  );
}

function shadowDamagePhaseAlpha(local: number, fade = 1): number {
  if (local < 0.1) return local / 0.1;
  const fadeStart = THREE.MathUtils.clamp(0.72 - (fade - 1) * 0.12, 0.45, 0.86);
  if (local < fadeStart) return 1;
  return THREE.MathUtils.clamp(1 - (local - fadeStart) / (1 - fadeStart), 0, 1);
}

function ShadowDamageParticleSpray({
  level,
  destroyed,
}: {
  level: number;
  destroyed: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const fireLevel = Math.max(0, Math.min(1, level));
  const particles = useMemo<ShadowDamageParticle[]>(() => {
    const count = SHADOW_DAMAGE_SPRAY_TUNING.count;
    const fanAngle = Math.max(
      0.15,
      Math.min(Math.PI * 1.92, SHADOW_DAMAGE_SPRAY_TUNING.arc),
    );
    const randomness = Math.max(
      0,
      Math.min(1.5, SHADOW_DAMAGE_SPRAY_TUNING.randomness),
    );
    return Array.from({ length: count }, (_, i) => {
      const slot = count <= 1 ? 0.5 : i / (count - 1);
      const band = i % 5;
      const jitter = Math.sin(i * 12.9898) * randomness * 0.18;
      return {
        yaw: (slot - 0.5) * fanAngle + jitter,
        distance: (5.4 + (i % 9) * 0.36) * SHADOW_DAMAGE_SPRAY_TUNING.spread,
        height:
          (0.8 + band * 0.24 + Math.abs(Math.sin(i * 2.31)) * 0.36) *
          SHADOW_DAMAGE_SPRAY_TUNING.size *
          (0.85 + fanAngle * 0.12),
        rise: (0.15 + (i % 4) * 0.1) * SHADOW_DAMAGE_SPRAY_TUNING.spread,
        speed: 0.5 + (i % 7) * 0.055,
        phase: (i * 0.071) % 1,
        size: (0.105 + (i % 4) * 0.018) * SHADOW_DAMAGE_SPRAY_TUNING.size,
        wobble: randomness * (0.015 + (i % 4) * 0.012),
      };
    });
  }, []);

  useFrame(({ clock }) => {
    const g = groupRef.current;
    if (!g) return;
    const t = clock.getElapsedTime();
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i]!;
      const particleGroup = g.children[i] as THREE.Group | undefined;
      if (!particleGroup) continue;
      const local =
        (t * SHADOW_DAMAGE_SPRAY_TUNING.speed * p.speed + p.phase) % 1;
      particleGroup.position.copy(
        shadowDamageParticlePosition(p, local, fireLevel, destroyed),
      );
      particleGroup.rotation.set(t * 0.8 * p.speed, t * 1.3 * p.speed + i, 0);
      const scale =
        p.size *
        (0.82 + Math.sin(local * Math.PI) * 0.55) *
        (0.9 + fireLevel * 0.1);
      particleGroup.scale.setScalar(scale);
      const opacity = THREE.MathUtils.clamp(
        Math.sin(local * Math.PI) *
          SHADOW_DAMAGE_SPRAY_TUNING.intensity *
          shadowDamagePhaseAlpha(local, SHADOW_DAMAGE_SPRAY_TUNING.fade) *
          (0.85 + fireLevel * 0.15),
        0,
        1,
      );
      const outline = particleGroup.children[0] as THREE.Mesh | undefined;
      const core = particleGroup.children[1] as THREE.Mesh | undefined;
      if (outline) {
        const mat = outline.material as THREE.MeshBasicMaterial;
        mat.opacity = opacity * 0.82;
      }
      if (core) {
        const mat = core.material as THREE.MeshBasicMaterial;
        mat.opacity = opacity;
      }
    }
  });

  return (
    <group ref={groupRef} position={[0, destroyed ? 0.04 : 0.12, 0]}>
      {particles.map((_, i) => (
        <group key={i} raycast={() => null}>
          <mesh renderOrder={12}>
            <sphereGeometry args={[1.25, 12, 12]} />
            <meshBasicMaterial
              color={SHADOW_DAMAGE_SPRAY_TUNING.secondaryColor}
              transparent
              opacity={0}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
          <mesh scale={0.72} renderOrder={13}>
            <sphereGeometry args={[1, 10, 10]} />
            <meshBasicMaterial
              color={SHADOW_DAMAGE_SPRAY_TUNING.color}
              transparent
              opacity={0}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}

type ShipDamageSparkSeed = {
  origin: [number, number, number];
  velocity: [number, number, number];
  phase: number;
  life: number;
  wobble: number;
  colorMix: number;
};

function seededDamageSparkNoise(index: number, salt: number): number {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453123;
  return value - Math.floor(value);
}

function ShipDamagePointSparks({
  level,
  destroyed,
}: {
  level: number;
  destroyed: boolean;
}) {
  const timeRef = useRef(0);
  const lightRef = useRef<THREE.PointLight>(null);
  const fireLevel = Math.max(0, Math.min(1, level));
  const particleCount = Math.max(
    8,
    Math.min(
      220,
      Math.round(
        HULL_DAMAGE_SPARK_TUNING.count * (0.55 + fireLevel * 0.65),
      ),
    ),
  );
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(particleCount * 3), 3),
    );
    g.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(particleCount * 3), 3),
    );
    return g;
  }, [particleCount]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const seeds = useMemo<ShipDamageSparkSeed[]>(() => {
    const plumeWidth = HULL_DAMAGE_SPARK_TUNING.spread;
    const lift = HULL_DAMAGE_SPARK_TUNING.arc;
    const randomness = HULL_DAMAGE_SPARK_TUNING.randomness;
    return Array.from({ length: particleCount }, (_, index) => {
      const a = seededDamageSparkNoise(index, 0.11);
      const b = seededDamageSparkNoise(index, 1.73);
      const c = seededDamageSparkNoise(index, 4.41);
      const d = seededDamageSparkNoise(index, 8.19);
      const side = (a - 0.5) * (0.65 + plumeWidth * 0.7);
      const originY = -0.18 + b * (0.3 + randomness * 0.44);
      const originZ = -0.78 - c * (0.55 + randomness * 0.7);
      const driftX = side * (0.42 + randomness * 0.8);
      const driftY = 0.12 + lift * (0.35 + d * 0.72);
      const driftZ = -(1.35 + b * 2.4) * (0.55 + plumeWidth * 0.52);
      return {
        origin: [side * 0.72, originY, originZ],
        velocity: [driftX, driftY, driftZ],
        phase: a * 7.5,
        life: 2.8 + b * 3.4 + HULL_DAMAGE_SPARK_TUNING.fade * 0.55,
        wobble: 0.25 + c * (0.7 + randomness * 1.1),
        colorMix: d,
      };
    });
  }, [particleCount]);
  const primary = useMemo(
    () => new THREE.Color(HULL_DAMAGE_SPARK_TUNING.color),
    [],
  );
  const secondary = useMemo(
    () => new THREE.Color(HULL_DAMAGE_SPARK_TUNING.secondaryColor),
    [],
  );
  const workingColorRef = useRef(new THREE.Color());
  const sparkSize =
    0.055 *
    HULL_DAMAGE_SPARK_TUNING.size *
    HULL_DAMAGE_SPARK_TUNING.thickness *
    (destroyed ? 1.12 : 1);

  useFrame((_, delta) => {
    timeRef.current += delta * HULL_DAMAGE_SPARK_TUNING.speed;
    const positions = geometry.getAttribute("position").array as Float32Array;
    const colors = geometry.getAttribute("color").array as Float32Array;
    const time = timeRef.current;
    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i]!;
      const local = ((time + seed.phase) % seed.life) / seed.life;
      const fadeIn = Math.max(0, Math.min(1, local / 0.16));
      const fadeOut = Math.max(0, Math.min(1, 1 - (local - 0.48) / 0.52));
      const brightness =
        fadeIn *
        fadeOut *
        (0.38 +
          Math.sin((time + seed.phase) * (5.5 + seed.wobble * 4)) * 0.22 +
          seed.colorMix * 0.55);
      const wobbleX =
        Math.sin(time * 1.7 + seed.phase) * 0.08 * seed.wobble;
      const wobbleZ =
        Math.cos(time * 1.2 + seed.phase * 0.7) * 0.05 * seed.wobble;
      const driftBoost = 0.72 + fireLevel * 0.55 + (destroyed ? 0.22 : 0);
      const idx = i * 3;
      positions[idx] =
        seed.origin[0] + seed.velocity[0] * local * driftBoost + wobbleX;
      positions[idx + 1] =
        seed.origin[1] + seed.velocity[1] * local * (0.82 + fireLevel * 0.35);
      positions[idx + 2] =
        seed.origin[2] + seed.velocity[2] * local * driftBoost + wobbleZ;
      const color = workingColorRef.current
        .copy(primary)
        .lerp(secondary, seed.colorMix * 0.85);
      color.multiplyScalar(
        Math.max(
          0.04,
          Math.min(
            2.4,
            brightness *
              HULL_DAMAGE_SPARK_TUNING.intensity *
              (0.45 + fireLevel * 0.75),
          ),
        ),
      );
      colors[idx] = color.r;
      colors[idx + 1] = color.g;
      colors[idx + 2] = color.b;
    }
    geometry.getAttribute("position").needsUpdate = true;
    geometry.getAttribute("color").needsUpdate = true;
    if (lightRef.current) {
      lightRef.current.intensity =
        (0.65 + Math.sin(time * 6) * 0.12) *
        HULL_DAMAGE_SPARK_TUNING.intensity *
        fireLevel;
      lightRef.current.distance = 2.5 + fireLevel * 3.5;
    }
  });

  return (
    <group position={[0, destroyed ? 0.05 : 0.15, 0]}>
      <points geometry={geometry} raycast={() => null} renderOrder={11}>
        <pointsMaterial
          size={sparkSize}
          sizeAttenuation
          transparent
          opacity={0.86}
          vertexColors
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </points>
      <pointLight
        ref={lightRef}
        color={HULL_DAMAGE_SPARK_TUNING.color}
        distance={3}
        decay={2}
        intensity={0}
      />
    </group>
  );
}

// ── Arc visualization ─────────────────────────────────────────────────────────
// Coordinate mapping: arc mesh uses rotation [+π/2, 0, 0] so shape +Y = world +Z = forward.
// All angles are in shape-space radians (counterclockwise from shape +X).
// In a right-handed frame (Y up, +Z forward), anatomical right = forward × up
// = +Z × +Y = -X, so STARBOARD is shape -X (π) and PORT is shape +X (0).
//   Forward   = shape +Y direction = 90° (π/2)
//   Port      = shape +X direction = 0°
//   Aft       = shape -Y direction = 270° (-π/2)
//   Starboard = shape -X direction = 180° (π)
const ARC_DEFS: Record<
  string,
  {
    centerAngle: number;
    halfAngle: number;
    color: string;
    opacity: number;
    radius?: number;
  }
> = {
  Forward: {
    centerAngle: Math.PI / 2,
    halfAngle: Math.PI / 4,
    color: "#ffb000",
    opacity: 0.4,
  },
  Port: {
    centerAngle: 0,
    halfAngle: Math.PI / 4,
    color: "rgba(0, 255, 222, 1)",
    opacity: 0.34,
  },
  Starboard: {
    centerAngle: Math.PI,
    halfAngle: Math.PI / 4,
    color: "rgba(0, 255, 222, 1)",
    opacity: 0.34,
  },
  Aft: {
    centerAngle: -Math.PI / 2,
    halfAngle: Math.PI / 4,
    color: "#ff2f4f",
    opacity: 0.34,
  },
  "Boresight Forward": {
    centerAngle: Math.PI / 2,
    halfAngle: Math.PI / 24,
    color: "#fff75a",
    opacity: 0.95,
    radius: 1.65,
  },
  "Boresight Aft": {
    centerAngle: -Math.PI / 2,
    halfAngle: Math.PI / 24,
    color: "#ff7a1a",
    opacity: 0.9,
    radius: 1.65,
  },
  // Turrets fire in any direction → full 360° sector. centerAngle is arbitrary
  // since halfAngle = π covers the entire circle.
  Turret: {
    centerAngle: Math.PI / 2,
    halfAngle: Math.PI,
    color: "#b86cff",
    opacity: 0.32,
  },
};

// Label positions in the heading-group's local XZ space (local +Z = world forward)
const ARC_LABELS: Record<
  string,
  { pos: [number, number, number]; label: string }
> = {
  Forward: { pos: [0, 0.07, 1.35], label: "FWD" },
  Port: { pos: [1.35, 0.07, 0], label: "PORT" },
  Starboard: { pos: [-1.35, 0.07, 0], label: "STBD" },
  Aft: { pos: [0, 0.07, -1.35], label: "AFT" },
  "Boresight Forward": { pos: [0, 0.07, 1.72], label: "BS-F" },
  "Boresight Aft": { pos: [0, 0.07, -1.72], label: "BS-A" },
};

function canonicalWeaponArc(arcName: string): string {
  const normalized = arcName.trim().replace(/\s+/g, " ").toLowerCase();
  switch (normalized) {
    case "forward":
    case "front":
      return "Forward";
    case "aft":
    case "rear":
      return "Aft";
    case "port":
      return "Port";
    case "starboard":
    case "stbd":
      return "Starboard";
    case "turret":
      return "Turret";
    case "boresight forward":
    case "boresight fwd":
      return "Boresight Forward";
    case "boresight aft":
    case "boresight rear":
      return "Boresight Aft";
    default:
      return arcName.trim();
  }
}

const BASE_ORIENTATION_ARCS = [
  "Forward",
  "Port",
  "Starboard",
  "Aft",
  "Boresight Forward",
  "Boresight Aft",
];

type TargetingPreviewState = "eligible" | "ineligible";

type WeaponArcReadinessState = "online" | "degraded" | "offline";

type WeaponArcReadiness = {
  status: WeaponArcReadinessState;
  total: number;
  down: number;
  reasons: string[];
};

type WeaponArcReadinessMap = Record<string, WeaponArcReadiness>;

const SIDE_ARC_COLORS: Record<"friendly" | "enemy", Record<string, string>> = {
  friendly: {
    Forward: "#34eb52",
    Port: "#00d46a",
    Starboard: "#00f090",
    Aft: "#0f9f4a",
    "Boresight Forward": "#b7ff7a",
    "Boresight Aft": "#70e000",
    Turret: "#7dffb2",
  },
  enemy: {
    Forward: "#ff0004",
    Port: "#ff4f57",
    Starboard: "#ff2a35",
    Aft: "#a90012",
    "Boresight Forward": "#ffb0a8",
    "Boresight Aft": "#ff7a45",
    Turret: "#ff6b9d",
  },
};

function arcDisplayColor(
  arc: string,
  scheme: UiArcColorScheme,
  side: "friendly" | "enemy" | null,
): string {
  const canonicalArc = canonicalWeaponArc(arc);
  if (scheme === "side" && side)
    return SIDE_ARC_COLORS[side][canonicalArc] ?? ARC_DEFS[canonicalArc]?.color ?? "#ffffff";
  return ARC_DEFS[canonicalArc]?.color ?? "#ffffff";
}

function weaponCriticalDisableReason(
  weapon: Pick<Weapon, "id" | "arc" | "name">,
  crits: NonNullable<GameUnit["criticals"]>,
): string | null {
  for (const crit of crits) {
    const critName = crit.name || "critical";
    if (
      crit.effectKey === "weapons-offline" &&
      crit.randomWeaponId === weapon.id
    ) {
      return `${weapon.name || "weapon"} offline: ${critName}`;
    }
    if (
      (crit.effectKey === "weapons-catastrophic" ||
        crit.effectKey === "vital-weapons-control") &&
      crit.randomArc &&
      canonicalWeaponArc(crit.randomArc) === canonicalWeaponArc(weapon.arc)
    ) {
      return `${canonicalWeaponArc(weapon.arc)} arc offline: ${critName}`;
    }
  }
  return null;
}

function buildWeaponArcReadiness(
  unit: GameUnit,
  model: ShipModel | undefined,
  weapons: Weapon[],
  currentRound: number,
): WeaponArcReadinessMap {
  const byArc = new Map<
    string,
    { total: number; down: number; reasons: Set<string> }
  >();
  const firedSet = new Set(unit.firedWeaponIds ?? []);
  const firedArcs = new Set(
    weapons
      .filter((weapon) => firedSet.has(weapon.id))
      .map((weapon) => canonicalWeaponArc(weapon.arc)),
  );
  const baseAction = (unit.specialAction ?? "").replace(/-failed$/, "");
  const oneWeaponLimitActive =
    unit.oneWeaponThisRound ||
    baseAction === "blast-doors" ||
    baseAction === "all-stop-pivot";
  const skeletonLimitActive =
    Boolean(unit.isSkeletonCrew) &&
    !/\bflight\s+computer\b/i.test(model?.traits ?? "");
  const crits = unit.criticals ?? [];

  for (const weapon of weapons) {
    const arc = canonicalWeaponArc(weapon.arc);
    if (!ARC_DEFS[arc]) continue;
    const entry = byArc.get(arc) ?? {
      total: 0,
      down: 0,
      reasons: new Set<string>(),
    };
    entry.total += 1;
    const reasons: string[] = [];
    const critReason = weaponCriticalDisableReason(weapon, crits);
    if (critReason) reasons.push(critReason);
    if (firedSet.has(weapon.id)) reasons.push("already fired");
    const readyRound = Number(
      unit.slowLoadingWeaponCooldowns?.[String(weapon.id)] ?? 0,
    );
    if (
      /\bslow[-\s]?loading\b/i.test(weapon.traits ?? "") &&
      currentRound < readyRound
    ) {
      reasons.push(`slow-loading until round ${readyRound}`);
    }
    if (!firedSet.has(weapon.id) && firedSet.size > 0) {
      if (skeletonLimitActive) reasons.push("skeleton crew one weapon");
      if (oneWeaponLimitActive) reasons.push("one weapon limit");
      if (unit.isCrippled && firedArcs.has(arc)) {
        reasons.push("crippled arc already fired");
      }
    }
    if (reasons.length > 0) {
      entry.down += 1;
      reasons.forEach((reason) => entry.reasons.add(reason));
    }
    byArc.set(arc, entry);
  }

  const output: WeaponArcReadinessMap = {};
  for (const [arc, entry] of byArc.entries()) {
    output[arc] = {
      total: entry.total,
      down: entry.down,
      status:
        entry.down <= 0
          ? "online"
          : entry.down >= entry.total
            ? "offline"
            : "degraded",
      reasons: [...entry.reasons],
    };
  }
  return output;
}

function angleDeltaRadians(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

function isTargetInWeaponArc(
  attacker: {
    hexQ: number;
    hexR: number;
    heading: number;
    modelFilename: string;
  },
  target: { hexQ: number; hexR: number },
  arcName: string,
): boolean {
  const arc = ARC_DEFS[canonicalWeaponArc(arcName)];
  if (!arc) return false;
  const dx = target.hexQ - attacker.hexQ;
  const dz = target.hexR - attacker.hexR;
  const effectiveHeading =
    attacker.heading + (FLIP_MODELS.has(attacker.modelFilename) ? 180 : 0);
  const headingRad = (effectiveHeading * Math.PI) / 180;
  const localX = dx * Math.cos(headingRad) - dz * Math.sin(headingRad);
  const localZ = dx * Math.sin(headingRad) + dz * Math.cos(headingRad);
  if (localX === 0 && localZ === 0) return true;
  const bearing = Math.atan2(localZ, localX);
  return Math.abs(angleDeltaRadians(bearing, arc.centerAngle)) <= arc.halfAngle + 1e-6;
}

function weaponRangeDistanceForPreview(
  attacker: { hexQ: number; hexR: number; baseRadiusInches?: number | null },
  target: { hexQ: number; hexR: number; baseRadiusInches?: number | null },
  attackerIsFighter: boolean,
  targetIsFighter: boolean,
): number {
  let distance = Math.hypot(target.hexQ - attacker.hexQ, target.hexR - attacker.hexR);
  if (attackerIsFighter) distance -= rulesBaseRadius(attacker);
  if (targetIsFighter) distance -= rulesBaseRadius(target);
  return Math.max(0, distance);
}

function weaponLineOfSightBlockForPreview(
  attacker: { hexQ: number; hexR: number },
  target: { hexQ: number; hexR: number },
  obstacles: LineOfSightObstacle[],
): LineOfSightBlock | null {
  return findBlockingLineOfSightObstacle(
    { x: attacker.hexQ, z: attacker.hexR },
    { x: target.hexQ, z: target.hexR },
    obstacles,
  );
}

function ArcSector({
  centerAngle,
  halfAngle,
  radius,
  color,
  opacity,
  planeY = 0.028,
}: {
  centerAngle: number;
  halfAngle: number;
  radius: number;
  color: string;
  opacity: number;
  planeY?: number;
}) {
  const geo = useMemo(() => {
    const segments = halfAngle < 0.3 ? 8 : 36;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    for (let i = 0; i <= segments; i++) {
      const a = centerAngle - halfAngle + (2 * halfAngle * i) / segments;
      shape.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
    }
    shape.lineTo(0, 0);
    return new THREE.ShapeGeometry(shape);
  }, [centerAngle, halfAngle, radius]);
  return (
    <mesh
      rotation={[Math.PI / 2, 0, 0]}
      position={[0, planeY, 0]}
      geometry={geo}
    >
      <meshBasicMaterial
        color={color}
        transparent
        opacity={opacity}
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function PulsingArcSector({
  centerAngle,
  halfAngle,
  radius,
  color = "#ef4444",
  baseOpacity = 0.18,
  planeY = 0.019,
}: {
  centerAngle: number;
  halfAngle: number;
  radius: number;
  color?: string;
  baseOpacity?: number;
  planeY?: number;
}) {
  const materialRef = useRef<THREE.MeshBasicMaterial>(null);
  const geo = useMemo(() => {
    const segments = halfAngle < 0.3 ? 8 : 36;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    for (let i = 0; i <= segments; i++) {
      const a = centerAngle - halfAngle + (2 * halfAngle * i) / segments;
      shape.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
    }
    shape.lineTo(0, 0);
    return new THREE.ShapeGeometry(shape);
  }, [centerAngle, halfAngle, radius]);

  useFrame(({ clock }) => {
    if (!materialRef.current) return;
    const pulse = (Math.sin(clock.getElapsedTime() * 3.4) + 1) / 2;
    materialRef.current.opacity = baseOpacity + pulse * 0.18;
  });

  return (
    <mesh
      rotation={[Math.PI / 2, 0, 0]}
      position={[0, planeY, 0]}
      geometry={geo}
    >
      <meshBasicMaterial
        ref={materialRef}
        color={color}
        transparent
        opacity={baseOpacity}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        side={THREE.DoubleSide}
        toneMapped={false}
      />
    </mesh>
  );
}

function WeaponArcStatusPlate({
  centerAngle,
  radius,
  textureFilename,
}: {
  centerAngle: number;
  radius: number;
  textureFilename: string;
}) {
  const texture = useLoader(
    THREE.TextureLoader,
    boardTextureUrl(textureFilename),
  ) as THREE.Texture;
  useEffect(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
  }, [texture]);

  const geometry = useMemo(() => {
    const outward = new THREE.Vector2(
      Math.cos(centerAngle),
      Math.sin(centerAngle),
    );
    const tangent = new THREE.Vector2(-outward.y, outward.x);
    const centerDistance = radius * 0.48;
    const width = radius * 0.76;
    const height = radius * 0.76;
    const center = outward.clone().multiplyScalar(centerDistance);
    const halfTangent = tangent.multiplyScalar(width / 2);
    const halfOutward = outward.multiplyScalar(height / 2);
    const vertices = new Float32Array([
      center.x - halfTangent.x - halfOutward.x,
      0.036,
      center.y - halfTangent.y - halfOutward.y,
      center.x + halfTangent.x - halfOutward.x,
      0.036,
      center.y + halfTangent.y - halfOutward.y,
      center.x + halfTangent.x + halfOutward.x,
      0.036,
      center.y + halfTangent.y + halfOutward.y,
      center.x - halfTangent.x + halfOutward.x,
      0.036,
      center.y - halfTangent.y + halfOutward.y,
    ]);
    const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const indices = [0, 1, 2, 0, 2, 3];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }, [centerAngle, radius]);

  const material = useMemo(() => {
    const shader = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture },
        opacity: { value: 0.94 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        uniform float opacity;
        varying vec2 vUv;
        void main() {
          vec4 sampleColor = texture2D(map, vUv);
          float luma = dot(sampleColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          float keyedAlpha = smoothstep(0.018, 0.11, luma) * sampleColor.a;
          if (keyedAlpha < 0.015) discard;
          gl_FragColor = vec4(sampleColor.rgb, keyedAlpha * opacity);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    return shader;
  }, [texture]);
  useEffect(() => () => material.dispose(), [material]);

  return <mesh geometry={geometry} material={material} renderOrder={12} />;
}

// Long-range coverage arc for the FIRING PHASE — drawn at the weapon's actual
// range (in world inches) so the player can see where its eligible targets lie.
// Uses the same ARC_DEFS angles as the base arcs so the visual and server's
// `isInArc` adjudication line up; flip handling matches WeaponArcDisplay.
const ARC_DISPLAY_BASE_RADIUS_INCHES = 1.2;

function arcDisplayRadius(arc: string, _baseRadius: number): number {
  return (
    ARC_DISPLAY_BASE_RADIUS_INCHES + (arc.startsWith("Boresight") ? 0.62 : 0.34)
  );
}

function BaseOrientationDisplay({
  flip = false,
  opacityScale = 1,
  baseRadius = 1.2,
  muted = false,
  arcColorScheme = "classic",
  arcSide = null,
}: {
  flip?: boolean;
  opacityScale?: number;
  baseRadius?: number;
  muted?: boolean;
  arcColorScheme?: UiArcColorScheme;
  arcSide?: "friendly" | "enemy" | null;
}) {
  return (
    <>
      {BASE_ORIENTATION_ARCS.map((arc) => {
        const def = ARC_DEFS[arc];
        if (!def) return null;
        const centerAngle = flip ? def.centerAngle + Math.PI : def.centerAngle;
        const isBoresight = arc.startsWith("Boresight");
        const mutedOpacity = isBoresight ? 0.24 : 0.34;
        const color = arcDisplayColor(arc, arcColorScheme, arcSide);
        return (
          <ArcSector
            key={arc}
            centerAngle={centerAngle}
            halfAngle={def.halfAngle}
            radius={arcDisplayRadius(arc, baseRadius)}
            color={muted ? "#737b88" : color}
            opacity={
              (muted
                ? mutedOpacity
                : def.opacity * (isBoresight ? 0.52 : 0.62)) * opacityScale
            }
            planeY={0.012}
          />
        );
      })}
    </>
  );
}

function RangeArcOverlay({
  arc,
  range,
  flip,
  arcColorScheme = "classic",
  arcSide = null,
  colorOverride,
  outlineOnly = false,
  readiness,
}: {
  arc: string;
  range: number;
  flip: boolean;
  arcColorScheme?: UiArcColorScheme;
  arcSide?: "friendly" | "enemy" | null;
  colorOverride?: string;
  outlineOnly?: boolean;
  readiness?: WeaponArcReadiness;
}) {
  const canonicalArc = canonicalWeaponArc(arc);
  const def = ARC_DEFS[canonicalArc];
  const baseColor =
    colorOverride ?? arcDisplayColor(canonicalArc, arcColorScheme, arcSide);
  const color =
    readiness?.status === "offline"
      ? "#737b88"
      : readiness?.status === "degraded"
        ? "#ef4444"
        : baseColor;
  const geo = useMemo(() => {
    if (!def) return null;
    const segments = def.halfAngle < 0.3 ? 16 : 64;
    const centerAngle = flip ? def.centerAngle + Math.PI : def.centerAngle;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    for (let i = 0; i <= segments; i++) {
      const a =
        centerAngle - def.halfAngle + (2 * def.halfAngle * i) / segments;
      shape.lineTo(Math.cos(a) * range, Math.sin(a) * range);
    }
    shape.lineTo(0, 0);
    return new THREE.ShapeGeometry(shape);
  }, [def, range, flip]);

  // Outline polyline: origin → arc → origin (rotated into XZ plane so it
  // sits on the board, matching the fill mesh's rotation).
  const edgePoints = useMemo<[number, number, number][] | null>(() => {
    if (!def) return null;
    const segments = def.halfAngle < 0.3 ? 16 : 64;
    const centerAngle = flip ? def.centerAngle + Math.PI : def.centerAngle;
    const pts: [number, number, number][] = [[0, 0, 0]];
    for (let i = 0; i <= segments; i++) {
      const a =
        centerAngle - def.halfAngle + (2 * def.halfAngle * i) / segments;
      // Shape's local (X, Y) → world (X, Z) because we rotate the fill by +π/2 on X.
      pts.push([Math.cos(a) * range, 0, Math.sin(a) * range]);
    }
    pts.push([0, 0, 0]);
    return pts;
  }, [def, range, flip]);

  if (!def || !geo || !edgePoints) return null;
  return (
    <>
      {!outlineOnly && (
        <mesh
          rotation={[Math.PI / 2, 0, 0]}
          position={[0, 0.018, 0]}
          geometry={geo}
        >
          <meshBasicMaterial
            color={color}
            transparent
            opacity={readiness?.status === "offline" ? 0.055 : 0.1}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      {/* Outline along the arc + radial edges so the boundary reads clearly */}
      <Line
        points={edgePoints}
        color={color}
        lineWidth={outlineOnly ? 2.6 : 2}
        transparent
        opacity={readiness?.status === "offline" ? 0.62 : 0.95}
        position={[0, 0.05, 0]}
      />
    </>
  );
}

// For ships whose OBJ is flipped 180° inside the heading group, the entire arc
// frame must be rotated 180° so the visual arcs match the server's adjudication
// (server uses `effHeading = heading + 180` for FLIP_MODELS — see games.ts).
// Rotating by +π handles both axial arcs (Forward/Aft/Boresight) AND lateral
// arcs (Port/Starboard) correctly, where the older "negate axial-only" trick
// silently mirrored port/starboard onto the wrong side of the hull.
function WeaponRangeProjectionDisplay({
  arcs,
  flip,
  arcColorScheme = "classic",
  arcSide = null,
  outlineOnly = false,
  arcReadiness = {},
}: {
  arcs: Array<{ arc: string; range: number }>;
  flip: boolean;
  arcColorScheme?: UiArcColorScheme;
  arcSide?: "friendly" | "enemy" | null;
  outlineOnly?: boolean;
  arcReadiness?: WeaponArcReadinessMap;
}) {
  const maxByArc = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const item of arcs) {
      const canonicalArc = canonicalWeaponArc(item.arc);
      if (!ARC_DEFS[canonicalArc] || item.range <= 0) continue;
      grouped.set(canonicalArc, Math.max(grouped.get(canonicalArc) ?? 0, item.range));
    }
    return [...grouped.entries()].map(([arc, range]) => ({ arc, range }));
  }, [arcs]);

  return (
    <>
      {maxByArc.map((item) => (
        <RangeArcOverlay
          key={`${item.arc}-${item.range}`}
          arc={item.arc}
          range={item.range}
          flip={flip}
          arcColorScheme={arcColorScheme}
          arcSide={arcSide}
          outlineOnly={outlineOnly}
          readiness={arcReadiness[item.arc]}
        />
      ))}
    </>
  );
}

function arcLabelPosition(
  arc: string,
  baseRadius: number,
  pos: [number, number, number],
): [number, number, number] {
  const canonicalArc = canonicalWeaponArc(arc);
  const radial = Math.hypot(pos[0], pos[2]);
  if (radial < 0.001) return pos;
  const targetRadius =
    ARC_DISPLAY_BASE_RADIUS_INCHES +
    (canonicalArc.startsWith("Boresight") ? 0.72 : 0.42);
  const scale = targetRadius / radial;
  return [pos[0] * scale, pos[1], pos[2] * scale];
}

function WeaponArcDisplay({
  weapons,
  flip = false,
  baseRadius = 1.2,
  muted = false,
  arcColorScheme = "classic",
  arcSide = null,
  arcReadiness = {},
}: {
  weapons: Pick<Weapon, "arc">[];
  flip?: boolean;
  baseRadius?: number;
  muted?: boolean;
  arcColorScheme?: UiArcColorScheme;
  arcSide?: "friendly" | "enemy" | null;
  arcReadiness?: WeaponArcReadinessMap;
}) {
  const uniqueArcs = useMemo(
    () => [...new Set(weapons.map((w) => canonicalWeaponArc(w.arc)))],
    [weapons],
  );
  const weaponArcColor = muted ? "#8a93a1" : null;
  return (
    <>
      {uniqueArcs.map((arc) => {
        const def = ARC_DEFS[arc];
        if (!def) return null;
        const centerAngle = flip ? def.centerAngle + Math.PI : def.centerAngle;
        const color = arcDisplayColor(arc, arcColorScheme, arcSide);
        const readiness = arcReadiness[arc];
        const offline = readiness?.status === "offline";
        const degraded = readiness?.status === "degraded";
        const sectorColor = muted || offline ? "#737b88" : color;
        return (
          <React.Fragment key={arc}>
            <ArcSector
              centerAngle={centerAngle}
              halfAngle={def.halfAngle}
              radius={arcDisplayRadius(arc, baseRadius)}
              color={weaponArcColor ?? sectorColor}
              opacity={
                muted
                  ? 0.26
                  : offline
                    ? Math.min(0.22, def.opacity * 0.5)
                    : degraded
                      ? def.opacity * 0.72
                      : def.opacity
              }
              planeY={0.014}
            />
            {offline && !muted && (
              <WeaponArcStatusPlate
                centerAngle={centerAngle}
                radius={arcDisplayRadius(arc, baseRadius)}
                textureFilename="weapon-offline-arc.png"
              />
            )}
            {degraded && !muted && (
              <>
                <PulsingArcSector
                  centerAngle={centerAngle}
                  halfAngle={def.halfAngle}
                  radius={arcDisplayRadius(arc, baseRadius)}
                  color="#ef4444"
                  baseOpacity={0.12}
                  planeY={0.018}
                />
                <WeaponArcStatusPlate
                  centerAngle={centerAngle}
                  radius={arcDisplayRadius(arc, baseRadius)}
                  textureFilename="weapon-damage-arc.png"
                />
              </>
            )}
          </React.Fragment>
        );
      })}
      {uniqueArcs.map((arc) => {
        const lbl = ARC_LABELS[arc];
        const def = ARC_DEFS[arc];
        if (!lbl || !def) return null;
        const color = arcDisplayColor(arc, arcColorScheme, arcSide);
        const readiness = arcReadiness[arc];
        const offline = readiness?.status === "offline";
        const degraded = readiness?.status === "degraded";
        const scaledPos = arcLabelPosition(arc, baseRadius, lbl.pos);
        const pos: [number, number, number] = flip
          ? [-scaledPos[0], scaledPos[1], -scaledPos[2]]
          : scaledPos;
        const labelText = offline
          ? `${lbl.label} OFF`
          : degraded && readiness
            ? `${lbl.label} ${readiness.down}/${readiness.total}`
            : lbl.label;
        return (
          <CameraFacingText
            key={`lbl-${arc}`}
            position={pos}
            fontSize={offline ? 0.12 : 0.17}
            color={
              muted || offline
                ? "#a7afbc"
                : degraded
                  ? "#fecaca"
                  : color
            }
            anchorX="center"
            anchorY="middle"
            outlineWidth={0.04}
            outlineColor="black"
          >
            {labelText}
          </CameraFacingText>
        );
      })}
      {/* Turret: inner circle on the base + centred label */}
      {uniqueArcs.includes("Turret") && (
        (() => {
          const turretReadiness = arcReadiness.Turret;
          const turretOffline = turretReadiness?.status === "offline";
          const turretDegraded = turretReadiness?.status === "degraded";
          const turretColor =
            muted || turretOffline
              ? "#8a93a1"
              : turretDegraded
                ? "#f59e0b"
                : arcDisplayColor("Turret", arcColorScheme, arcSide);
          const turretLabel = turretOffline
            ? "TUR OFF"
            : turretDegraded && turretReadiness
              ? `TUR ${turretReadiness.down}/${turretReadiness.total}`
              : "TUR";
          return (
        <React.Fragment>
          <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.026, 0]}>
            <ringGeometry args={[0.46, 0.54, 48]} />
            <meshBasicMaterial
              color={turretColor}
              transparent
              opacity={muted ? 0.34 : turretOffline ? 0.34 : 0.75}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
          <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}>
            <circleGeometry args={[0.46, 48]} />
            <meshBasicMaterial
              color={turretColor}
              transparent
              opacity={muted ? 0.1 : turretOffline ? 0.08 : 0.18}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
          <CameraFacingText
            position={[0, 0.09, 0]}
            fontSize={turretOffline ? 0.12 : 0.17}
            color={muted || turretOffline ? "#a7afbc" : turretColor}
            anchorX="center"
            anchorY="middle"
            outlineWidth={0.03}
            outlineColor="black"
          >
            {turretLabel}
          </CameraFacingText>
        </React.Fragment>
          );
        })()
      )}
    </>
  );
}

// ── Movement planning (forward / turn previews, keyboard + mouse-drag) ───────
// turn.deltaDeg is signed in the UI's visual convention: negative = left/port,
// positive = right/starboard. Commit code translates this through flipped meshes.
// forward.distance is in inches (world units), 0..remaining-speed, controlled by mouse drag.
// Dice-modal staging. The reveal is gated behind explicit confirm buttons:
//   target-picked  → weapon + target selected, but no server action committed
//   pending        → server roll in flight (no result yet)
//   attack-ready   → result cached; press "Roll to Hit" to reveal attack dice
//   attack-rolling → attack dice shuffle animation (~700ms)
//   attack-shown   → attack dice revealed. If hits>0 prompt damage; else close.
//   damage-ready   → press "Roll Damage" to reveal damage/crit dice
//   damage-rolling → damage dice shuffle animation
//   damage-shown   → full result + summary; press "Close"
//   error          → server rejected the shot (e.g. out of arc / range)
// `confirmingClose` overlays a Yes/Cancel prompt so the player can't dismiss
// the modal by accident and lose track of what just happened.
type DiceModalPhase =
  | "target-picked"
  | "pending"
  | "attack-ready"
  | "attack-rolling"
  | "attack-shown"
  | "damage-ready"
  | "damage-rolling"
  | "damage-shown"
  // Per-crit reveal: the server already rolled the location + effect dice
  // atomically, but the player wants to feel each crit being rolled. We
  // walk the criticalsApplied array one entry at a time via critIndex.
  | "crit-ready"
  | "crit-rolling"
  | "crit-shown"
  | "error";
type DiceModalState = {
  weapon: Weapon;
  // The attacker is captured at fire-time (rather than read live from
  // activeUnitId) so the weapon-fx beam/tracer/missile renders from the right
  // origin even if the player ends activation or selects another ship while
  // the dice modal is still open.
  attackerUnitId: number;
  targetName: string;
  targetId: number;
  attackDice: number;
  useScoutCoordination?: boolean;
  phase: DiceModalPhase;
  result?: FireWeaponResult;
  error?: string;
  confirmingClose?: boolean;
  // Index into result.criticalsApplied for the per-crit reveal walk. Only
  // meaningful in phases crit-ready / crit-rolling / crit-shown.
  critIndex?: number;
};

type DogfightResult = {
  kind: "dogfight";
  round: number;
  attackerUnitId: number;
  attackerName: string;
  attackerRoll: number;
  attackerDogfight: number;
  attackerFleetCarrierBonus?: number;
  attackerSupportBonus?: number;
  attackerSupporters?: Array<{ id: number; name: string }>;
  attackerScore: number;
  targetUnitId: number;
  targetName: string;
  targetRoll: number;
  targetDogfight: number;
  targetFleetCarrierBonus?: number;
  targetSupportBonus?: number;
  targetSupporters?: Array<{ id: number; name: string }>;
  targetScore: number;
  destroyedUnitId: number | null;
  tied: boolean;
  gameCompleted?: boolean;
  winnerId?: string | null;
};

type DogfightModalState = {
  phase: "rolling" | "shown";
  result: DogfightResult;
  confirmingClose?: boolean;
};

type DogfightImpactEffect = {
  id: number;
  x: number;
  z: number;
};

const DOGFIGHT_IMPACT_TUNING = {
  color: "#f96767",
  secondaryColor: "#a86b43",
  speed: 2.95,
  size: 0.25,
  fade: 1.25,
  intensity: 0.5,
  spread: 0.7,
  count: 20,
  arc: 6,
  thickness: 1.25,
  randomness: 0,
};

type SplitFirePlan = {
  weapon: Weapon;
  attackerUnitId: number;
  firstTargetId?: number;
  firstTargetName?: string;
  firstDice: number;
  totalDice: number;
};

type SplitFireResultModalState = {
  weapon: Weapon;
  attackerUnitId: number;
  allocations: Array<{
    targetId: number;
    targetName: string;
    attackDice: number;
    result: FireWeaponResult;
  }>;
  confirmingClose?: boolean;
};

type SelfRepairModalPhase = "ready" | "rolling" | "shown" | "error";
type SelfRepairModalState = {
  unitId: number;
  unitName: string;
  dice: number;
  phase: SelfRepairModalPhase;
  rolls?: number[];
  total?: number;
  repaired?: number;
  hullBefore?: number;
  hullAfter?: number;
  error?: string;
  confirmingClose?: boolean;
};

type SelfRepairPromptCandidate = {
  key: string;
  unitId: number;
  unitName: string;
  dice: number;
};

type SelfRepairResult = {
  dice: number;
  rolls: number[];
  total: number;
  repaired: number;
  hullBefore: number;
  hullAfter: number;
  unit: GameUnit;
};

type TerrainHazardRoll = {
  fieldId: string;
  fieldName: string;
  density: number;
  segmentInchesInside?: number;
  inchesInside: number;
  checkReused?: boolean;
  automaticFailure?: boolean;
  checkRolls: number[];
  crewQuality?: number;
  checkTotal: number;
  passed: boolean;
  attackDice: number;
  cumulativeAttackDice?: number;
  hitThreshold: number;
  attackRolls: number[];
  hits: number;
  dodgeRolls?: number[];
  dodgesSuccessful?: number;
  remainingHits?: number;
  shieldedHits?: number;
  attackTableRolls?: number[];
  bulkheadHits?: number;
  solidHits?: number;
  criticalHits?: number;
  superAp?: boolean;
  damageMultiplier?: number;
  damage: number;
  crewLost: number;
  damageTable?: {
    overkill: number;
    roll: number;
    total: number;
    outcome: "adrift" | "destroyed" | "exploding-end-of-next";
  } | null;
};

type TerrainHazardMoveResult = GameUnit & {
  asteroidHazards?: TerrainHazardRoll[];
};

type TerrainHazardModalState = {
  unitName: string;
  hazards: TerrainHazardRoll[];
  phase: "rolling" | "shown";
  confirmingClose?: boolean;
};

type FighterBayActionResult = {
  carrier: GameUnit;
  fighter?: GameUnit;
  recoveredUnitId?: number;
};

type MovePlan =
  | { kind: "forward"; distance: number }
  | { kind: "turn"; deltaDeg: number }
  | { kind: "fighter-free"; x: number; z: number; heading: number }
  | null;

type MovementGesture =
  | { kind: "forward" }
  | { kind: "fighter-free" }
  | { kind: "turn"; direction: "left" | "right" | "free" }
  | null;

type MovementLedger = {
  distance: number;
  turns: number;
  distSinceLastTurn: number;
};
type RuntimeMovementUnit = GameUnit & {
  turnsMadeThisActivation?: number;
  distanceSinceLastTurnThisActivation?: number;
};
type AttackAuditUnitSnapshot = {
  id?: number;
  name?: string;
  hullPoints?: number;
  crewPoints?: number;
};
type AttackAuditWeaponSnapshot = {
  id?: number;
  name?: string;
};
type AttackAuditPayload = Record<string, unknown> & {
  attacker?: AttackAuditUnitSnapshot;
  targetBefore?: AttackAuditUnitSnapshot;
  targetAfter?: AttackAuditUnitSnapshot;
  weapon?: AttackAuditWeaponSnapshot;
  finalDamage?: number;
  finalCrewLost?: number;
};
type AttackAuditLogEntry = {
  id: number;
  gameId: number;
  round: number;
  phase: string;
  actorKind: "player" | "ai" | string;
  actorPlayerId: string | null;
  attackerUnitId: number;
  targetUnitId: number;
  weaponId: number;
  summary: string;
  payload: AttackAuditPayload;
  createdAt: string;
};
type AttackAuditLogResponse = {
  gameId: number;
  count: number;
  logs: AttackAuditLogEntry[];
};
type MovementAuditLogEntry = {
  id: number;
  gameId: number;
  round: number;
  phase: string;
  actorKind: "player" | "ai" | "system" | string;
  actorPlayerId: string | null;
  unitId: number;
  movementKind: string;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
};
type SpecialActionAuditLogEntry = {
  id: number;
  gameId: number;
  round: number;
  phase: string;
  actorKind: "player" | "ai" | string;
  actorPlayerId: string | null;
  unitId: number;
  action: string;
  success: boolean;
  cqRequired: number | null;
  cqRoll: number | null;
  cqTotal: number | null;
  targetUnitId: number | null;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
};
type AuditLogResponse<T> = {
  gameId: number;
  count: number;
  logs: T[];
};
type BattleLogEntry = {
  id: string;
  source: "movement" | "firing" | "special" | "anti-fighter";
  round: number;
  phase: string;
  actorKind: string;
  actorPlayerId: string | null;
  summary: string;
  createdAt: string;
};
const EMPTY_MOVEMENT_LEDGER: MovementLedger = {
  distance: 0,
  turns: 0,
  distSinceLastTurn: 0,
};
const TABLET_MOVEMENT_CONTROLLER_POSITION_KEY =
  "b5acta.ui.tabletMovementControllerPosition";

function cleanApiErrorMessage(
  err: unknown,
  fallback = "Action failed",
): string {
  const anyErr = err as any;
  const body = anyErr?.response?.data ?? anyErr?.data;
  if (body && typeof body === "object") {
    const bodyMessage =
      typeof body.error === "string"
        ? body.error
        : typeof body.message === "string"
          ? body.message
          : "";
    if (bodyMessage.trim()) return bodyMessage.trim();
  }

  const raw = err instanceof Error ? err.message : String(err ?? fallback);
  let cleaned = raw.replace(/^HTTP\s+\d+\s+[^:]+:\s*/i, "").trim();
  if (cleaned.startsWith("{")) {
    try {
      const parsed = JSON.parse(cleaned);
      const parsedMessage =
        typeof parsed?.error === "string"
          ? parsed.error
          : typeof parsed?.message === "string"
            ? parsed.message
            : "";
      if (parsedMessage.trim()) cleaned = parsedMessage.trim();
    } catch {
      // Leave the non-JSON text alone.
    }
  }
  return cleaned.replace(/^Error:\s*/i, "").trim() || fallback;
}

function ruleHintForFeedback(message: string | null | undefined): string | null {
  if (!message) return null;
  const normalized = message
    .replace(/^Move rejected:\s*/i, "")
    .replace(/^Cannot activate [^:]+:\s*/i, "")
    .trim()
    .toLowerCase();

  const hints: Array<{ test: RegExp; hint: string }> = [
    {
      test: /must move at least .*declare all stop/,
      hint: "Most ships must move at least half speed. To stay still, declare All Stop before moving.",
    },
    {
      test: /ship must move .* straight .* before|ship must move .* straight .* after/,
      hint: "Ships must travel straight before each turn. Move the required distance first, then stage the turn.",
    },
    {
      test: /move forward and turn as separate movement steps/,
      hint: "Movement is staged in pieces: move forward, confirm that step, then stage the turn.",
    },
    {
      test: /all stop forbids turning/,
      hint: "All Stop holds position and prevents turning this round. All Stop and Pivot requires All Stop from the previous round.",
    },
    {
      test: /current special action forbids turning/,
      hint: "That Special Action restricts maneuvering this round. Continue straight or end the activation if legal.",
    },
    {
      test: /may make at most .* turn/,
      hint: "This ship has used its allowed turns for the activation. Move forward or finish the activation.",
    },
    {
      test: /may turn at most .* degrees/,
      hint: "The turn angle is capped by the ship profile and active Special Actions. Try a smaller turn.",
    },
    {
      test: /may move at most .* this activation/,
      hint: "The ship has reached its current speed allowance. End the activation or undo and stage a shorter move.",
    },
    {
      test: /move did not change position/,
      hint: "Movement is staged first. Use F/R or drag to create a preview, then confirm the move.",
    },
    {
      test: /overlap.*base|base overlaps|overlapping bases/,
      hint: "Final base overlap is illegal. Passing over another base can be okay, but the final resting spot must be clear.",
    },
    {
      test: /inside the board|outside the board/,
      hint: "The final position must keep the unit's base fully inside the playable board.",
    },
    {
      test: /cannot declare a special action after movement has started|movement already begun/,
      hint: "Special Actions must be declared before the ship moves or turns.",
    },
    {
      test: /already used a special action/,
      hint: "A ship can only attempt one Special Action per round.",
    },
    {
      test: /all stop and pivot requires/,
      hint: "All Stop and Pivot is only available after that ship used All Stop in the previous round.",
    },
    {
      test: /lumbering ships cannot use come about.*extra turn/,
      hint: "Lumbering ships must use the sharper-turn Come About option instead of the extra-turn option.",
    },
    {
      test: /fighter flights activate after all capital ships|capital ships have finished moving/,
      hint: "Capital ships and fighters have separate timing. Finish the current segment before activating the other type.",
    },
    {
      test: /fighter flights have already completed|fighter flights attack before capital ships/,
      hint: "Fighters attack before capital ships in the Firing Phase. Use the current firing segment's eligible units.",
    },
    {
      test: /locked in a dogfight|resolve the dogfight/,
      hint: "Fighters in base contact with enemy fighters resolve dogfights instead of moving or firing normally.",
    },
    {
      test: /anti-fighter allocation|anti-fighter target|anti-fighter attacker|anti-fighter dice/,
      hint: "Anti-Fighter is resolved at the end of Movement against eligible nearby fighters. Assign only the available dice.",
    },
    {
      test: /target out of range/,
      hint: "Pick a closer target or a longer-ranged weapon. Range is measured from the firing unit to the target.",
    },
    {
      test: /target not in .* arc/,
      hint: "The selected weapon cannot draw arc to that target. Check the colored base arcs or choose another weapon.",
    },
    {
      test: /weapon has already fired/,
      hint: "Each weapon system can fire once per firing activation.",
    },
    {
      test: /weapon is offline|weapons in the .* arc are offline/,
      hint: "A critical hit has disabled that weapon or arc. Repair the critical in a later End Phase if possible.",
    },
    {
      test: /running silent/,
      hint: "Running Silent prevents firing this round as the cost of the Special Action.",
    },
    {
      test: /limits firing to 1 weapon|may fire only one weapon|may fire only one weapon system|one weapon per arc/,
      hint: "Damage state, crew state, or a Special Action is limiting how many weapons this ship can fire.",
    },
    {
      test: /concentrate all fire-power locks/,
      hint: "Concentrate All Fire-power locks this ship to the nominated target for the round.",
    },
    {
      test: /cannot target your own ship/,
      hint: "Choose an enemy unit as the target.",
    },
    {
      test: /target already destroyed|unit is destroyed|attacker is destroyed|ship destroyed/,
      hint: "Destroyed units cannot be activated or targeted for normal actions.",
    },
    {
      test: /hull is gone|hulked ships/,
      hint: "A ship with 0 hull is no longer under command for normal actions.",
    },
    {
      test: /no surviving crew|crewless ships/,
      hint: "A ship with no surviving crew cannot take normal command actions.",
    },
    {
      test: /skeleton crew cannot declare|skeleton crew may fire/,
      hint: "Skeleton crew restricts Special Actions and firing. The ship is still alive, but command capacity is badly reduced.",
    },
    {
      test: /adrift.*end phase|adrift ship/,
      hint: "Adrift ships do not maneuver normally. Their drift is handled automatically in the End Phase.",
    },
    {
      test: /pass all is only available|you still have eligible activations/,
      hint: "Passing is only allowed when the rules leave you nothing eligible to activate in that segment.",
    },
    {
      test: /resolve owned dogfighting fighters before passing/,
      hint: "Resolve your fighter dogfights before passing the firing segment.",
    },
    {
      test: /fighters launch and recover in the end phase|not your end phase fighter window/,
      hint: "Carrier fighter launch and recovery happens during your End Phase fighter window.",
    },
    {
      test: /performed a special action cannot launch|cannot launch fighters in its current state|cannot recover fighters in its current state/,
      hint: "The carrier must be eligible, not blocked by damage or Special Action limits, and have remaining bay capacity.",
    },
    {
      test: /fighters must launch within 3 inches/,
      hint: "Place launched fighters within 3 inches of their carrier and away from illegal base overlap.",
    },
    {
      test: /fighter must be in base contact with the recovering carrier/,
      hint: "To recover a fighter, move it into base contact with its carrier before attempting recovery.",
    },
    {
      test: /damage control may only|not your turn to repair|already passed the end phase/,
      hint: "Damage Control happens during your End Phase repair window before you pass.",
    },
    {
      test: /damage control already attempted/,
      hint: "A ship usually gets one Damage Control attempt per End Phase unless a rule such as All Hands on Deck allows more.",
    },
    {
      test: /cannot repair a critical the round it was applied/,
      hint: "New critical effects cannot be repaired until a later End Phase.",
    },
    {
      test: /vital systems cannot be repaired/,
      hint: "Vital Systems criticals are permanent under the current rules implementation.",
    },
    {
      test: /engineering crit prevents damage control|hull breach prevents damage control/,
      hint: "That critical effect blocks Damage Control until the rule condition is cleared or no longer applies.",
    },
    {
      test: /scout support must be declared before any weapon fires/,
      hint: "Scout support is a pre-fire action. Declare it before the first weapon is fired in the phase.",
    },
    {
      test: /counter-stealth requires/,
      hint: "Counter-Stealth can only target an enemy that currently has the Stealth trait.",
    },
    {
      test: /no unspent scout coordination token|scout coordination cannot/,
      hint: "Scout coordination needs an unused Scout token and cannot support Beam, Energy Mine, or Twin Linked weapons.",
    },
    {
      test: /not your activation|not your .*window|this unit is not the one you activated/,
      hint: "Wait for your active window, then select the highlighted active unit before acting.",
    },
  ];

  return hints.find(({ test }) => test.test(normalized))?.hint ?? null;
}

function RuleHint({
  message,
  className = "",
}: {
  message?: string | null;
  className?: string;
}) {
  const hint = ruleHintForFeedback(message);
  if (!hint) return null;
  return (
    <div
      className={`mt-1 text-[10px] leading-4 text-cyan-200/90 ${className}`}
      data-testid="rule-hint"
    >
      Hint: {hint}
    </div>
  );
}

// Heading → unit world-space forward vector (accounting for FLIP_MODELS which
// render their visual nose along local -Z).
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function attackAuditSummary(
  log: AttackAuditLogEntry,
  units: GameUnit[],
): string {
  const payload = log.payload ?? {};
  const attackerName =
    payload.attacker?.name ??
    units.find((u) => u.id === log.attackerUnitId)?.name ??
    "Opponent ship";
  const targetName =
    payload.targetAfter?.name ??
    payload.targetBefore?.name ??
    units.find((u) => u.id === log.targetUnitId)?.name ??
    "target";
  const weaponName = payload.weapon?.name;
  const damage =
    numberOrNull(payload.finalDamage) ??
    Math.max(
      0,
      (numberOrNull(payload.targetBefore?.hullPoints) ?? 0) -
        (numberOrNull(payload.targetAfter?.hullPoints) ?? 0),
    );
  const crew =
    numberOrNull(payload.finalCrewLost) ??
    Math.max(
      0,
      (numberOrNull(payload.targetBefore?.crewPoints) ?? 0) -
        (numberOrNull(payload.targetAfter?.crewPoints) ?? 0),
    );
  const effects = [`${damage} damage`, crew > 0 ? `${crew} crew` : null]
    .filter(Boolean)
    .join(", ");

  return `${attackerName} attacked ${targetName}${weaponName ? ` with ${weaponName}` : ""}; ${targetName} suffered ${effects}.`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampBaseCenterInsideBoard(
  x: number,
  z: number,
  unit?: { baseRadiusInches?: number | null },
): [number, number] {
  const radius = rulesBaseRadius(unit);
  return [
    clampNumber(x, -BOARD_W / 2 + radius, BOARD_W / 2 - radius),
    clampNumber(z, -BOARD_D / 2 + radius, BOARD_D / 2 - radius),
  ];
}

function headingForVisualVector(
  unit: { modelFilename: string },
  dx: number,
  dz: number,
): number {
  if (dx * dx + dz * dz < 0.0001) return 0;
  const sign = FLIP_MODELS.has(unit.modelFilename) ? -1 : 1;
  const degrees = THREE.MathUtils.radToDeg(Math.atan2(sign * dx, sign * dz));
  return ((degrees % 360) + 360) % 360;
}

function headingDeltaDegrees(from: number, to: number): number {
  let delta = (((to - from) % 360) + 360) % 360;
  if (delta > 180) delta = 360 - delta;
  return Math.abs(delta);
}

function signedHeadingDeltaDegrees(from: number, to: number): number {
  let delta = (((to - from) % 360) + 360) % 360;
  if (delta > 180) delta -= 360;
  return delta;
}

function interpolateHeadingDegrees(from: number, to: number, amount: number): number {
  return from + signedHeadingDeltaDegrees(from, to) * clampNumber(amount, 0, 1);
}

function isKirishiacVisualBeamWeapon(
  unit: { name: string; modelFilename: string },
  weapon: Pick<Weapon, "name" | "traits" | "arc">,
): boolean {
  const text = `${unit.name} ${unit.modelFilename}`.toLowerCase();
  const weaponName = (weapon.name ?? "").toLowerCase();
  const isForward = /\bf\b|\bforward\b/i.test(weapon.arc ?? "");
  return isForward && text.includes("kirishiac") && weaponName.includes("hyper graviton blaster");
}

function effectiveUiAttackDice(weapon: Weapon): number {
  const traits = weapon.traits ?? "";
  const weakPenalty = /\bweak\b/i.test(traits) ? 1 : 0;
  return Math.max(1, weapon.attackDice - weakPenalty);
}

function uiAllWeaponsAdModifier(unit: {
  criticals?: Array<{ effectKey?: string | null }>;
}): number {
  return (unit.criticals ?? []).reduce((sum, crit) => {
    const key = String(crit.effectKey ?? "");
    return sum + (key === "reactor-capacitors" || key === "weapons-targeting" ? -1 : 0);
  }, 0);
}

function weaponFingerprint(weapon: Weapon) {
  return {
    weaponName: weapon.name ?? "",
    weaponArc: weapon.arc,
    weaponRange: weapon.range,
    weaponAttackDice: weapon.attackDice,
    weaponTraits: weapon.traits ?? undefined,
  };
}

function splitFireBlockedReason(
  weapon: Weapon,
  useScoutCoordination: boolean,
): string | null {
  const traits = weapon.traits ?? "";
  if (effectiveUiAttackDice(weapon) < 2)
    return "Split fire requires at least 2 effective AD";
  if (useScoutCoordination)
    return "Scout Coordination cannot be used with split fire";
  if (/\bmini[-\s]?beam\b/i.test(traits) || /\bbeam\b/i.test(traits))
    return "Beam weapons cannot split fire";
  if (/\benergy[-\s]?mine\b/i.test(traits))
    return "Energy Mine weapons cannot split fire";
  if (/\bone[-\s]?shot\b/i.test(traits))
    return "One-Shot weapons cannot split fire";
  if (/\bslow[-\s]?loading\b/i.test(traits))
    return "Slow-Loading weapons cannot split fire";
  return null;
}

function headingForwardVec(unit: { heading: number; modelFilename: string }): {
  x: number;
  z: number;
} {
  const flip = FLIP_MODELS.has(unit.modelFilename);
  const sign = flip ? -1 : 1;
  const hRad = (unit.heading * Math.PI) / 180;
  return { x: sign * Math.sin(hRad), z: sign * Math.cos(hRad) };
}

type UiRulesProfile = "standard" | "ancients" | "shadows" | "vorlons";

function uiRulesProfileForModel(
  model: Pick<ShipModel, "rulesProfile" | "faction"> | null | undefined,
): UiRulesProfile {
  if (
    model?.rulesProfile === "ancients"
    || model?.rulesProfile === "shadows"
    || model?.rulesProfile === "vorlons"
  ) {
    return model.rulesProfile;
  }
  const faction = (model?.faction ?? "").toLowerCase();
  if (faction.includes("shadow")) return "shadows";
  if (faction.includes("vorlon")) return "vorlons";
  if (faction.includes("kirishiac")) return "ancients";
  return "standard";
}

function uiShadowPointDefenseWeaponActive(
  unit: Pick<GameUnit, "shadowPointDefenseRound">,
  model: ShipModel | null | undefined,
  weapon: Pick<Weapon, "traits">,
  currentRound: number,
): boolean {
  const traits = weapon.traits ?? "";
  return uiRulesProfileForModel(model) === "shadows"
    && unit.shadowPointDefenseRound === currentRound
    && /\bbeam\b/i.test(traits)
    && !/\bmini[-\s]?beam\b/i.test(traits);
}

function buildShadowDispersalPlacements(
  carrier: GameUnit,
  fighterModel: Pick<ShipModel, "baseRadiusInches">,
  units: GameUnit[],
  isFighterUnit: (unit: GameUnit) => boolean,
  count: number,
): Array<{ hexQ: number; hexR: number; heading: number }> | null {
  const formationOffsets: Record<number, Array<[number, number]>> = {
    1: [[0, 0]],
    2: [[-0.9, 0], [0.9, 0]],
    3: [[-1.8, 0], [0, 0], [1.8, 0]],
    4: [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]],
    5: [[0, 0], [-1.8, 0], [1.8, 0], [0, -1.8], [0, 1.8]],
    6: [[-1.8, -0.9], [0, -0.9], [1.8, -0.9], [-1.8, 0.9], [0, 0.9], [1.8, 0.9]],
  };
  const offsets = formationOffsets[count];
  if (!offsets) return null;
  const forward = headingForwardVec(carrier);
  const right = { x: forward.z, z: -forward.x };
  const fighterRadius = rulesBaseRadius(fighterModel);
  const existing: UiBaseFootprint[] = units
    .filter((unit) => !unit.isDestroyed)
    .map((unit) => ({
      id: unit.id,
      x: unit.hexQ,
      z: unit.hexR,
      isFighter: isFighterUnit(unit),
      baseRadiusInches: unit.baseRadiusInches,
    }));

  for (let distance = 24; distance >= 4; distance -= 1) {
    const centerX = carrier.hexQ + forward.x * distance;
    const centerZ = carrier.hexR + forward.z * distance;
    const candidates: UiBaseFootprint[] = offsets.map(([side, depth], index) => ({
      id: `shadow-dispersal-${index}`,
      x: snapBoardCoord(centerX + right.x * side + forward.x * depth),
      z: snapBoardCoord(centerZ + right.z * side + forward.z * depth),
      isFighter: true,
      baseRadiusInches: fighterRadius,
    }));
    const insideBoard = candidates.every(
      (candidate) =>
        candidate.x >= -BOARD_W / 2 + fighterRadius
        && candidate.x <= BOARD_W / 2 - fighterRadius
        && candidate.z >= -BOARD_D / 2 + fighterRadius
        && candidate.z <= BOARD_D / 2 - fighterRadius,
    );
    if (!insideBoard) continue;
    const overlaps = candidates.some((candidate, index) =>
      existing.some((footprint) =>
        uiBaseFootprintsIllegallyOverlap(candidate, footprint),
      )
      || candidates.some((other, otherIndex) =>
        index !== otherIndex
        && uiBaseFootprintsIllegallyOverlap(candidate, other),
      ),
    );
    if (overlaps) continue;
    return candidates.map((candidate) => ({
      hexQ: candidate.x,
      hexR: candidate.z,
      heading: carrier.heading,
    }));
  }
  return null;
}

function visualTurnDeltaToHeadingDelta(
  modelFilename: string,
  deltaDeg: number,
): number {
  return FLIP_MODELS.has(modelFilename) ? deltaDeg : -deltaDeg;
}

const CRIT_SPEED_REDUCE_BY_KEY: Record<string, number> = {
  "engines-power-relays": 1,
  "engines-thrusters": 2,
  "engines-fuel": 4,
  "reactor-capacitors": 2,
};

function criticalSpeedReduction(unit: {
  criticals?: Array<{ effectKey?: string | null }>;
}): number {
  let reduce = 0;
  for (const crit of unit.criticals ?? []) {
    reduce = Math.max(
      reduce,
      CRIT_SPEED_REDUCE_BY_KEY[String(crit.effectKey ?? "")] ?? 0,
    );
  }
  return reduce;
}

function effectiveUiSpeed(unit: {
  speed: number;
  isCrippled?: boolean;
  criticals?: Array<{ effectKey?: string | null }>;
}): number {
  const crippledSpeed = unit.isCrippled
    ? Math.floor(unit.speed / 2)
    : unit.speed;
  return Math.max(0, crippledSpeed - criticalSpeedReduction(unit));
}

function uiSpeedBreakdown(unit: {
  speed: number;
  isCrippled?: boolean;
  criticals?: Array<{
    effectKey?: string | null;
    name?: string | null;
  }>;
}): {
  printedSpeed: number;
  postCrippleSpeed: number;
  criticalReduction: number;
  effectiveSpeed: number;
  reasons: string[];
  shortReasons: string[];
  summary: string;
} {
  const printedSpeed = unit.speed;
  const postCrippleSpeed = unit.isCrippled
    ? Math.floor(printedSpeed / 2)
    : printedSpeed;
  const criticalReduction = criticalSpeedReduction(unit);
  const effectiveSpeed = Math.max(0, postCrippleSpeed - criticalReduction);
  const reasons: string[] = [];
  const shortReasons: string[] = [];
  if (unit.isCrippled) {
    reasons.push(`crippled halves Speed ${printedSpeed} to ${postCrippleSpeed}`);
    shortReasons.push("crippled");
  }
  if (criticalReduction > 0) {
    const speedCritNames = (unit.criticals ?? [])
      .filter(
        (crit) =>
          (CRIT_SPEED_REDUCE_BY_KEY[String(crit.effectKey ?? "")] ?? 0) ===
          criticalReduction,
      )
      .map((crit) => crit.name || "engine critical")
      .filter(Boolean);
    const critLabel =
      speedCritNames.length > 0
        ? speedCritNames.join(", ")
        : "active speed critical";
    reasons.push(
      `${critLabel} applies the highest active speed-critical penalty, -${criticalReduction} Speed`,
    );
    shortReasons.push(`${critLabel} -${criticalReduction} Speed`);
  }
  const summary =
    reasons.length > 0
      ? `Effective Speed ${effectiveSpeed}: ${reasons.join("; ")}.`
      : `Effective Speed ${effectiveSpeed}.`;
  return {
    printedSpeed,
    postCrippleSpeed,
    criticalReduction,
    effectiveSpeed,
    reasons,
    shortReasons,
    summary,
  };
}

function effectiveUiTurns(unit: {
  turns?: number | null;
  isCrippled?: boolean;
}): number {
  const turns = unit.turns ?? 1;
  return unit.isCrippled ? Math.max(1, turns - 1) : turns;
}

function effectiveUiTurnAngle(unit: {
  turnAngle: number;
  isCrippled?: boolean;
}): number {
  return unit.isCrippled ? Math.min(45, unit.turnAngle) : unit.turnAngle;
}

function parseUiMovementTraits(raw: string | null | undefined): {
  agile: boolean;
  superManeuverable: boolean;
} {
  const text = raw ?? "";
  return {
    agile: /\bagile\b/i.test(text),
    superManeuverable:
      /\bsuper[-\s]?maneuverable\b/i.test(text) ||
      /\bsuper[-\s]?manoeuvrable\b/i.test(text) ||
      /\bsuperb\s+maneuverability\b/i.test(text) ||
      /\bsuperb\s+manoeuvrability\b/i.test(text),
  };
}

function uiMovementTraitsForModel(
  model: ShipModel | undefined,
  unit: { isCrippled?: boolean },
): { agile: boolean; superManeuverable: boolean } {
  const raw = parseUiMovementTraits(model?.traits ?? "");
  const fighter = shipModelHasFighterTrait(model);
  return {
    ...raw,
    superManeuverable:
      (raw.superManeuverable || fighter) && !(unit.isCrippled && !fighter),
  };
}

function parseUiSelfRepairDice(raw: string | null | undefined): number {
  const match = (raw ?? "").match(/\bself[-\s]?repair(?:ing)?\b\s*:?\s*(\d+)/i);
  return match ? Math.max(0, Number(match[1]) || 0) : 0;
}

function parseUiPsychicCrew(raw: string | null | undefined): number {
  const match = (raw ?? "").match(/\bpsychic\s+crew(?:\s*:?\s*(\d+))?/i);
  if (!match) return 0;
  return Math.max(1, Number(match[1]) || 1);
}

function turnDistanceNeeded(
  speed: number,
  turnsMade: number,
  traits: { agile: boolean; superManeuverable: boolean },
): number {
  if (traits.superManeuverable) return 0;
  if (turnsMade === 0) {
    if (speed <= 0) return Number.POSITIVE_INFINITY;
    return traits.agile ? speed / 4 : speed / 2;
  }
  return traits.agile ? 1 : 2;
}

function snapMovementDistance(distance: number): number {
  return Math.max(
    0,
    Math.round(distance / TABLET_FORWARD_STEP) * TABLET_FORWARD_STEP,
  );
}

function formatInches(value: number): string {
  return value.toFixed(value % 1 === 0 ? 0 : 1);
}

function ShipStatusInspectorDialog({
  open,
  onOpenChange,
  unit,
  model,
  weapons,
  myUserId,
  currentRound,
  isFighter,
  dogfightLocked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unit: GameUnit | null;
  model?: ShipModel;
  weapons: Weapon[];
  myUserId: string;
  currentRound: number;
  isFighter: boolean;
  dogfightLocked: boolean;
}) {
  if (!unit) {
    return <Dialog open={false} onOpenChange={onOpenChange} />;
  }

  const traitList = splitTraitList(model?.traits ?? "");
  const crits = unit.criticals ?? [];
  const adModifier = uiAllWeaponsAdModifier(unit);
  const speedInfo = uiSpeedBreakdown(
    isFighter ? { ...unit, isCrippled: false } : unit,
  );
  const activeEffects = [
    unit.isDestroyed ? "Destroyed" : null,
    unit.isCrippled && !isFighter ? "Crippled" : null,
    unit.isSkeletonCrew ? "Skeleton Crew" : null,
    unit.damageState && unit.damageState !== "normal"
      ? titleCaseStatus(unit.damageState)
      : null,
    dogfightLocked ? "Dogfight locked" : null,
    specialActionLabel(unit.specialAction),
    unit.oneWeaponThisRound ? "One weapon this round" : null,
    unit.allStopReady ? "All Stop ready" : null,
    scoutActionLabel(unit.scoutAction),
    unit.scoutActionTargetId ? `Scout target #${unit.scoutActionTargetId}` : null,
    unit.scoutCoordConsumed ? "Scout coord spent" : null,
    unit.shadowPointDefenseRound === currentRound
      ? "Shadow point defence"
      : null,
    unit.shadowManeuverMode
      ? `Shadow ${titleCaseStatus(unit.shadowManeuverMode)}`
      : null,
    unit.telepathicDisruptionExhausted ? "Telepathic disruption spent" : null,
    (unit.mindScreamTargetIdsThisRound?.length ?? 0) > 0
      ? `Mind scream targets ${unit.mindScreamTargetIdsThisRound!.length}`
      : null,
    unit.launchedFromUnitId ? `Launched from #${unit.launchedFromUnitId}` : null,
    adModifier !== 0 ? `All weapons ${adModifier} AD` : null,
  ].filter(Boolean) as string[];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[86vh] border-cyan-500/45 bg-black/95 p-0 font-mono text-cyan-50 sm:max-w-3xl"
        data-testid="dialog-unit-status-inspector"
      >
        <DialogHeader className="border-b border-cyan-500/25 px-4 py-3 pr-10 text-left">
          <DialogTitle className="text-sm uppercase tracking-[0.2em] text-cyan-100">
            {unit.name}
          </DialogTitle>
          <DialogDescription className="text-[11px] text-cyan-100/65">
            {unit.ownerId === myUserId ? "Friendly" : "Enemy"} - {unit.faction} -{" "}
            {model?.priorityLevel ? priorityLabel(model.priorityLevel) : "Unknown priority"}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[70vh]">
          <div className="space-y-3 px-4 py-3">
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <div className="rounded border border-cyan-500/25 bg-cyan-500/5 px-2 py-1.5">
                <div className="text-[9px] uppercase tracking-widest text-cyan-200/60">
                  Hull
                </div>
                <div className="text-sm font-bold">
                  {unit.hullPoints}/{unit.maxHullPoints}
                </div>
              </div>
              <div className="rounded border border-cyan-500/25 bg-cyan-500/5 px-2 py-1.5">
                <div className="text-[9px] uppercase tracking-widest text-cyan-200/60">
                  Crew
                </div>
                <div className="text-sm font-bold">
                  {unit.maxCrewPoints > 0
                    ? `${unit.crewPoints}/${unit.maxCrewPoints}`
                    : "None"}
                </div>
              </div>
              <div className="rounded border border-cyan-500/25 bg-cyan-500/5 px-2 py-1.5">
                <div className="text-[9px] uppercase tracking-widest text-cyan-200/60">
                  Speed
                </div>
                <div className="text-sm font-bold">
                  {speedInfo.effectiveSpeed}/{unit.speed}
                </div>
              </div>
              <div className="rounded border border-cyan-500/25 bg-cyan-500/5 px-2 py-1.5">
                <div className="text-[9px] uppercase tracking-widest text-cyan-200/60">
                  Turn
                </div>
                <div className="text-sm font-bold">
                  {unit.turns}/{unit.turnAngle}
                </div>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-[1fr_1.35fr]">
              <section>
                <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-cyan-200/70">
                  Current Effects
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {activeEffects.length > 0 ? (
                    activeEffects.map((effect) => (
                      <span
                        key={effect}
                        className="rounded border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-100"
                      >
                        {effect}
                      </span>
                    ))
                  ) : (
                    <span className="text-[11px] text-slate-400">None</span>
                  )}
                </div>
              </section>
              <section>
                <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-cyan-200/70">
                  Traits
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {traitList.length > 0 ? (
                    traitList.map((trait) => (
                      <TraitTooltip key={trait} trait={trait}>
                        <span className="cursor-help rounded border border-cyan-400/25 bg-cyan-400/10 px-1.5 py-0.5 text-[10px] text-cyan-100">
                          {trait}
                        </span>
                      </TraitTooltip>
                    ))
                  ) : (
                    <span className="text-[11px] text-slate-400">None</span>
                  )}
                </div>
              </section>
            </div>

            <section>
              <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-cyan-200/70">
                Weapons
              </div>
              <div className="space-y-1">
                {weapons.length > 0 ? (
                  weapons.map((weapon) => {
                    const pointDefense = uiShadowPointDefenseWeaponActive(
                      unit,
                      model,
                      weapon,
                      currentRound,
                    );
                    const baseAd = effectiveUiAttackDice(weapon);
                    const displayAd = Math.max(1, baseAd + adModifier);
                    const displayRange = pointDefense
                      ? weapon.range / 2
                      : weapon.range;
                    const displayArc = pointDefense ? "Turret" : weapon.arc;
                    const weaponTraits = pointDefense
                      ? ["Accurate", "Mini-Beam"]
                      : splitTraitList(weapon.traits);
                    return (
                      <div
                        key={weapon.id}
                        className="rounded border border-slate-600/60 bg-slate-950/80 px-2 py-1.5 text-[11px]"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold text-cyan-50">
                            {weapon.name || weapon.arc}
                          </span>
                          <span className="shrink-0 text-cyan-200/80">
                            {displayAd}AD
                            {displayAd !== baseAd ? ` (${baseAd})` : ""} - r
                            {displayRange}" - {displayArc}
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-slate-300">
                          {weaponTraits.length > 0 ? (
                            weaponTraits.map((trait) => (
                              <TraitTooltip key={`${weapon.id}-${trait}`} trait={trait}>
                                <span className="cursor-help rounded border border-slate-500/40 px-1 text-slate-200">
                                  {trait}
                                </span>
                              </TraitTooltip>
                            ))
                          ) : (
                            <span>No weapon traits</span>
                          )}
                          {pointDefense ? " - Shadow point defence active" : ""}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="text-[11px] text-slate-400">No weapons listed</div>
                )}
              </div>
            </section>

            <section>
              <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-cyan-200/70">
                Criticals
              </div>
              <div className="space-y-1">
                {crits.length > 0 ? (
                  crits.map((crit) => (
                    <div
                      key={crit.id}
                      className="rounded border border-red-400/35 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-100"
                      title={criticalEffectHint(crit)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold uppercase">{crit.name}</span>
                        <span className="text-[10px] text-red-100/65">
                          {crit.repairable ? "repairable" : "permanent"}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[10px] text-red-100/75">
                        {criticalEffectHint(crit)}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-[11px] text-slate-400">No critical effects</div>
                )}
              </div>
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function snapBoardCoord(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// Annular sector mesh — used for the turn-arc preview that hugs the ship base.
// Shape-space coords (mesh has +π/2 X rotation): shape +Y = world +Z (forward),
// shape +X = world +X (starboard). Forward = angle π/2, starboard = 0, port = π.
function AnnularSector({
  rInner,
  rOuter,
  startAngle,
  endAngle,
  color,
  opacity,
}: {
  rInner: number;
  rOuter: number;
  startAngle: number;
  endAngle: number;
  color: string;
  opacity: number;
}) {
  const geo = useMemo(() => {
    const segments = 40;
    const shape = new THREE.Shape();
    for (let i = 0; i <= segments; i++) {
      const a = startAngle + (endAngle - startAngle) * (i / segments);
      const x = Math.cos(a) * rOuter,
        y = Math.sin(a) * rOuter;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    for (let i = segments; i >= 0; i--) {
      const a = startAngle + (endAngle - startAngle) * (i / segments);
      shape.lineTo(Math.cos(a) * rInner, Math.sin(a) * rInner);
    }
    shape.closePath();
    return new THREE.ShapeGeometry(shape);
  }, [rInner, rOuter, startAngle, endAngle]);
  return (
    <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.04, 0]} geometry={geo}>
      <meshBasicMaterial
        color={color}
        transparent
        opacity={opacity}
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function ForwardPreview({
  distance,
  maxDistance,
  minRequired,
  turnRequired,
  turnRequirementLabel,
  committedBefore,
  minExempt,
}: {
  distance: number;
  maxDistance: number;
  // Inches the ship MUST cover this activation (sheet rule: at least half
  // base speed). Zero / exempt → no minimum line, arrow always green.
  minRequired: number;
  // Inches the ship must cover before it may turn. Agile ships often have a
  // lower turn gate than their minimum activation movement requirement.
  turnRequired?: number;
  turnRequirementLabel?: string;
  // Distance already committed to the ledger before this in-progress segment.
  committedBefore: number;
  // True when ship is All Stop / All Stop & Pivot / under mandatory-move
  // status (adrift, exploding) — minimum doesn't apply, color stays neutral.
  minExempt: boolean;
}) {
  const totalAfter = committedBefore + distance;
  const meetsMin =
    minExempt || minRequired <= 0 || totalAfter + 1e-6 >= minRequired;
  // Red while short of minimum, green once met. Cyan when no minimum applies
  // (exempt: All Stop / All Stop & Pivot / adrift) so the arrow doesn't look
  // urgent for ships that genuinely don't have to move.
  const arrowColor = minExempt ? "#22d3ee" : meetsMin ? "#22c55e" : "#ef4444";
  const arrowTextColor = minExempt
    ? "#67e8f9"
    : meetsMin
      ? "#86efac"
      : "#fca5a5";
  // Where on the max-range rail the half-speed minimum sits, measured from
  // the ship's nose. Only render if a) minimum applies and b) it falls inside
  // the still-available distance (i.e. the player hasn't already covered it
  // with previously-committed movement this activation).
  const minRemaining = Math.max(0, minRequired - committedBefore);
  const turnRemaining = Math.max(0, (turnRequired ?? 0) - committedBefore);
  const showMinTick =
    !minExempt &&
    minRequired > 0 &&
    minRemaining > 0 &&
    minRemaining <= maxDistance + 1e-6;
  const showTurnTick =
    !minExempt &&
    (turnRequired ?? 0) > 0 &&
    Math.abs((turnRequired ?? 0) - minRequired) > 1e-6 &&
    turnRemaining > 0 &&
    turnRemaining <= maxDistance + 1e-6;
  return (
    <group>
      {/* Faint max-range rail showing how far this ship can still go this phase */}
      {maxDistance > 0 && (
        <mesh position={[0, 0.05, 1.2 + maxDistance / 2]}>
          <boxGeometry args={[0.06, 0.02, maxDistance]} />
          <meshBasicMaterial color="#0891b2" transparent opacity={0.35} />
        </mesh>
      )}
      {/* Half-speed minimum tick: small amber crossbar on the rail. */}
      {showMinTick && (
        <mesh position={[0, 0.07, 1.2 + minRemaining]}>
          <boxGeometry args={[0.5, 0.04, 0.06]} />
          <meshBasicMaterial color="#f59e0b" transparent opacity={0.95} />
        </mesh>
      )}
      {showTurnTick && (
        <>
          <mesh position={[0, 0.085, 1.2 + turnRemaining]}>
            <boxGeometry args={[0.36, 0.05, 0.05]} />
            <meshBasicMaterial color="#22d3ee" transparent opacity={0.95} />
          </mesh>
          <CameraFacingText
            position={[0.42, 0.12, 1.2 + turnRemaining]}
            fontSize={0.22}
            color="#67e8f9"
            anchorX="left"
            anchorY="middle"
            outlineWidth={0.035}
            outlineColor="black"
          >
            {turnRequirementLabel ?? `turn ${turnRequired?.toFixed(1)}"`}
          </CameraFacingText>
        </>
      )}
      {/* Active distance arrow */}
      {distance > 0 && (
        <>
          <mesh position={[0, 0.06, 1.2 + distance / 2]}>
            <boxGeometry args={[0.1, 0.04, distance]} />
            <meshBasicMaterial color={arrowColor} transparent opacity={0.9} />
          </mesh>
          <mesh
            position={[0, 0.06, 1.2 + distance] as [number, number, number]}
            rotation={[Math.PI / 2, 0, 0]}
          >
            <coneGeometry args={[0.28, 0.55, 14]} />
            <meshBasicMaterial color={arrowColor} transparent opacity={0.95} />
          </mesh>
          <CameraFacingText
            position={[0.55, 0.1, 1.2 + distance / 2]}
            fontSize={0.34}
            color={arrowTextColor}
            anchorX="left"
            anchorY="middle"
            outlineWidth={0.04}
            outlineColor="black"
          >{`${distance.toFixed(1)}"${minExempt || meetsMin ? "" : ` / min move ${minRequired.toFixed(1)}"`}`}</CameraFacingText>
        </>
      )}
    </group>
  );
}

function TurnArcPreview({ deltaDeg }: { deltaDeg: number }) {
  if (deltaDeg === 0) return null;
  const absDeg = Math.abs(deltaDeg);
  const angleRad = (absDeg * Math.PI) / 180;
  // Forward = shape angle π/2. Positive delta (CW from above) sweeps toward starboard
  // (decreasing shape angle); negative delta sweeps toward port (increasing shape angle).
  const start = Math.PI / 2;
  const end = deltaDeg > 0 ? start + angleRad : start - angleRad;
  const midAngle = (start + end) / 2;
  const labelR = 2.6;
  const labelX = Math.cos(midAngle) * labelR;
  const labelZ = Math.sin(midAngle) * labelR;
  return (
    <group>
      <AnnularSector
        rInner={1.2}
        rOuter={3.2}
        startAngle={Math.min(start, end)}
        endAngle={Math.max(start, end)}
        color="#22d3ee"
        opacity={0.35}
      />
      <CameraFacingText
        position={[labelX, 0.12, labelZ]}
        fontSize={0.36}
        color="#67e8f9"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.04}
        outlineColor="black"
      >{`${deltaDeg > 0 ? "+" : "-"}${absDeg} deg`}</CameraFacingText>
    </group>
  );
}

function MovementPlanner({
  unit,
  plan,
  flip,
  remainingMove,
  minRequired,
  turnRequired,
  turnRequirementLabel,
  committedBefore,
  minExempt,
}: {
  unit: { hexQ: number; hexR: number; heading: number; speed: number };
  plan: MovePlan;
  flip: boolean;
  remainingMove: number;
  minRequired: number;
  turnRequired?: number;
  turnRequirementLabel?: string;
  committedBefore: number;
  minExempt: boolean;
}) {
  const [x, , z] = hexToWorld(unit.hexQ, unit.hexR);
  const headingRad = (unit.heading * Math.PI) / 180;
  // FLIP_MODELS only swap fore↔aft (same convention used by WeaponArcDisplay's
  // axial-arc handling). A Z-mirror flips the forward arrow to point out the
  // visual nose while keeping port/starboard on the correct visual side — which
  // a 180° Y-rotation would NOT do (it mirrors both axes).
  return (
    <group position={[x, 0, z]}>
      <group rotation={[0, headingRad, 0]}>
        <group scale={flip ? [1, 1, -1] : [1, 1, 1]}>
          {(!plan || plan.kind === "forward") && (
            <ForwardPreview
              distance={plan?.kind === "forward" ? plan.distance : 0}
              maxDistance={remainingMove}
              minRequired={minRequired}
              turnRequired={turnRequired}
              turnRequirementLabel={turnRequirementLabel}
              committedBefore={committedBefore}
              minExempt={minExempt}
            />
          )}
          {plan?.kind === "turn" && <TurnArcPreview deltaDeg={plan.deltaDeg} />}
        </group>
      </group>
    </group>
  );
}

// ── Staged (drag-placed) units ────────────────────────────────────────────────
function FighterMovementPlanner({
  unit,
  plan,
  remainingMove,
  dogfightWarning = false,
}: {
  unit: {
    hexQ: number;
    hexR: number;
    heading: number;
    baseRadiusInches?: number | null;
  };
  plan: MovePlan;
  remainingMove: number;
  dogfightWarning?: boolean;
}) {
  const [x, , z] = hexToWorld(unit.hexQ, unit.hexR);
  const baseRadius = rulesBaseRadius(unit);
  const planned = plan?.kind === "fighter-free" ? plan : null;
  const [pulse, setPulse] = useState(0);
  useFrame(({ clock }) => {
    if (!dogfightWarning) {
      if (pulse !== 0) setPulse(0);
      return;
    }
    setPulse((Math.sin(clock.elapsedTime * 8) + 1) / 2);
  });
  const radiusColor = dogfightWarning ? "#a855f7" : "#22d3ee";
  const ringColor = dogfightWarning ? "#e879f9" : "#67e8f9";
  const fillOpacity = dogfightWarning ? 0.12 + pulse * 0.12 : 0.075;
  const ringOpacity = dogfightWarning ? 0.58 + pulse * 0.38 : 0.72;
  const emissiveIntensity = dogfightWarning ? 0.75 + pulse * 1.35 : 0;
  return (
    <group position={[x, 0, z]}>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.017, 0]}
        renderOrder={2}
      >
        <circleGeometry args={[Math.max(0.01, remainingMove), 96]} />
        <meshStandardMaterial
          color={radiusColor}
          emissive={radiusColor}
          emissiveIntensity={emissiveIntensity}
          transparent
          opacity={fillOpacity}
          depthWrite={false}
        />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.02, 0]}
        renderOrder={3}
      >
        <ringGeometry
          args={[
            Math.max(0.05, remainingMove - 0.045),
            remainingMove + 0.045,
            128,
          ]}
        />
        <meshStandardMaterial
          color={ringColor}
          emissive={ringColor}
          emissiveIntensity={emissiveIntensity}
          transparent
          opacity={ringOpacity}
          depthWrite={false}
        />
      </mesh>
      {planned && (
        <group position={[planned.x - unit.hexQ, 0, planned.z - unit.hexR]}>
          <mesh
            rotation={[-Math.PI / 2, 0, 0]}
            position={[0, 0.035, 0]}
            renderOrder={4}
          >
            <circleGeometry args={[baseRadius, 48]} />
            <meshBasicMaterial
              color="#facc15"
              transparent
              opacity={0.22}
              depthWrite={false}
            />
          </mesh>
          <mesh
            rotation={[-Math.PI / 2, 0, 0]}
            position={[0, 0.04, 0]}
            renderOrder={5}
          >
            <ringGeometry
              args={[Math.max(0.05, baseRadius - 0.05), baseRadius, 48]}
            />
            <meshBasicMaterial
              color="#fde68a"
              transparent
              opacity={0.9}
              depthWrite={false}
            />
          </mesh>
        </group>
      )}
    </group>
  );
}

function MovementRadialMenu({
  unit,
  flip,
  canForward,
  canTurn,
  isSuperManeuverable,
  activeGesture,
  onForward,
  onTurnLeft,
  onTurnRight,
  onFreeTurn,
}: {
  unit: { hexQ: number; hexR: number; heading: number };
  flip: boolean;
  canForward: boolean;
  canTurn: boolean;
  isSuperManeuverable: boolean;
  activeGesture: MovementGesture;
  onForward: () => void;
  onTurnLeft: () => void;
  onTurnRight: () => void;
  onFreeTurn: () => void;
}) {
  const [x, , z] = hexToWorld(unit.hexQ, unit.hexR);
  const headingRad = (unit.heading * Math.PI) / 180;
  const axisScale: [number, number, number] = flip ? [1, 1, -1] : [1, 1, 1];

  const Button3D = ({
    label,
    pos,
    disabled,
    active,
    onSelect,
  }: {
    label: string;
    pos: [number, number, number];
    disabled?: boolean;
    active?: boolean;
    onSelect: () => void;
  }) => {
    const color = disabled ? "#475569" : active ? "#f59e0b" : "#22d3ee";
    const textColor = disabled ? "#94a3b8" : active ? "#fde68a" : "#cffafe";
    return (
      <group position={pos}>
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          onClick={(e) => {
            e.stopPropagation();
            if (!disabled) onSelect();
          }}
        >
          <circleGeometry args={[0.68, 36]} />
          <meshStandardMaterial
            color={color}
            transparent
            opacity={disabled ? 0.35 : 0.78}
            emissive={color}
            emissiveIntensity={disabled ? 0.08 : 0.5}
            depthWrite={false}
          />
        </mesh>
        <CameraFacingText
          position={[0, 0.16, 0]}
          fontSize={0.34}
          color={textColor}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.04}
          outlineColor="black"
        >
          {label}
        </CameraFacingText>
      </group>
    );
  };

  return (
    <group
      position={[x, 0.12, z]}
      rotation={[0, headingRad, 0]}
      scale={axisScale}
    >
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <ringGeometry args={[2.35, 2.47, 64]} />
        <meshBasicMaterial
          color="#0891b2"
          transparent
          opacity={0.28}
          depthWrite={false}
        />
      </mesh>
      <Button3D
        label="FWD"
        pos={[0, 0, 2.55]}
        disabled={!canForward}
        active={activeGesture?.kind === "forward"}
        onSelect={onForward}
      />
      <Button3D
        label="L"
        pos={[-2.55, 0, 0]}
        disabled={!canTurn}
        active={
          activeGesture?.kind === "turn" && activeGesture.direction === "left"
        }
        onSelect={onTurnLeft}
      />
      <Button3D
        label="R"
        pos={[2.55, 0, 0]}
        disabled={!canTurn}
        active={
          activeGesture?.kind === "turn" && activeGesture.direction === "right"
        }
        onSelect={onTurnRight}
      />
      {isSuperManeuverable && (
        <Button3D
          label="360"
          pos={[0, 0, -2.55]}
          disabled={!canTurn}
          active={
            activeGesture?.kind === "turn" && activeGesture.direction === "free"
          }
          onSelect={onFreeTurn}
        />
      )}
    </group>
  );
}

function TabletMovementController({
  plan,
  canForward,
  canTurn,
  canConfirm,
  isSuperManeuverable,
  freeTurnActive,
  remainingMove,
  angleCap,
  turnHint,
  onForward,
  onBack,
  onTurnLeft,
  onTurnRight,
  onFreeTurn,
  onCancel,
  onConfirm,
  canEndActivation,
  endActivationLabel,
  endActivationTitle,
  onEndActivation,
}: {
  plan: MovePlan;
  canForward: boolean;
  canTurn: boolean;
  canConfirm: boolean;
  isSuperManeuverable: boolean;
  freeTurnActive: boolean;
  remainingMove: number;
  angleCap: number;
  turnHint: string;
  onForward: () => void;
  onBack: () => void;
  onTurnLeft: () => void;
  onTurnRight: () => void;
  onFreeTurn: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  canEndActivation: boolean;
  endActivationLabel: string;
  endActivationTitle?: string;
  onEndActivation: () => void;
}) {
  const repeatRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const controllerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(
        TABLET_MOVEMENT_CONTROLLER_POSITION_KEY,
      );
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { left?: unknown; top?: unknown };
      return typeof parsed.left === "number" && typeof parsed.top === "number"
        ? { left: parsed.left, top: parsed.top }
        : null;
    } catch {
      return null;
    }
  });

  const clampControllerPosition = useCallback(
    (next: { left: number; top: number }) => {
      const rect = controllerRef.current?.getBoundingClientRect();
      const width = rect?.width ?? 190;
      const height = rect?.height ?? 310;
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const viewportHeight =
        window.visualViewport?.height ?? window.innerHeight;
      const margin = 10;
      return {
        left: Math.max(
          margin,
          Math.min(Math.max(margin, viewportWidth - width - margin), next.left),
        ),
        top: Math.max(
          margin,
          Math.min(
            Math.max(margin, viewportHeight - height - margin),
            next.top,
          ),
        ),
      };
    },
    [],
  );

  const persistControllerPosition = useCallback(
    (next: { left: number; top: number }) => {
      try {
        window.localStorage.setItem(
          TABLET_MOVEMENT_CONTROLLER_POSITION_KEY,
          JSON.stringify(next),
        );
      } catch {
        // Local storage may be unavailable in private browsing; dragging still works for this session.
      }
    },
    [],
  );

  const stopRepeat = useCallback(() => {
    if (repeatRef.current !== null) window.clearInterval(repeatRef.current);
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    repeatRef.current = null;
    timeoutRef.current = null;
  }, []);

  useEffect(() => stopRepeat, [stopRepeat]);

  useEffect(() => {
    const rect = controllerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition((prev) => {
      const initial = prev ?? {
        left: window.innerWidth - rect.width - 20,
        top: window.innerHeight - rect.height - 20,
      };
      const clamped = clampControllerPosition(initial);
      if (
        prev &&
        Math.abs(prev.left - clamped.left) < 0.5 &&
        Math.abs(prev.top - clamped.top) < 0.5
      )
        return prev;
      persistControllerPosition(clamped);
      return clamped;
    });
  }, [clampControllerPosition, persistControllerPosition]);

  useEffect(() => {
    const onResize = () => {
      setPosition((prev) => {
        if (!prev) return prev;
        const clamped = clampControllerPosition(prev);
        persistControllerPosition(clamped);
        return clamped;
      });
    };
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
  }, [clampControllerPosition, persistControllerPosition]);

  const RepeatButton = ({
    label,
    icon,
    disabled,
    active,
    className = "",
    onPress,
  }: {
    label: string;
    icon: React.ReactNode;
    disabled?: boolean;
    active?: boolean;
    className?: string;
    onPress: () => void;
  }) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (disabled) return;
        onPress();
        stopRepeat();
        timeoutRef.current = window.setTimeout(() => {
          repeatRef.current = window.setInterval(onPress, 120);
        }, 320);
      }}
      onPointerUp={stopRepeat}
      onPointerCancel={stopRepeat}
      onPointerLeave={stopRepeat}
      className={`flex h-12 w-12 items-center justify-center border border-cyan-300/70 bg-cyan-300/15 text-cyan-100 shadow-[0_0_18px_rgba(34,211,238,0.35)] transition-colors disabled:border-slate-600/60 disabled:bg-slate-900/70 disabled:text-slate-500 disabled:shadow-none ${
        active
          ? "bg-amber-300/30 text-amber-100 shadow-[0_0_20px_rgba(251,191,36,0.45)]"
          : "hover:bg-cyan-300/25"
      } ${className}`}
    >
      {icon}
    </button>
  );

  const previewText =
    plan?.kind === "forward"
      ? `${plan.distance.toFixed(1)}" / ${remainingMove.toFixed(1)}"`
      : plan?.kind === "turn"
        ? `${plan.deltaDeg > 0 ? "+" : ""}${plan.deltaDeg}° / ${angleCap}°`
        : `0" / ${remainingMove.toFixed(1)}`;

  const onDragHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      stopRepeat();
      const rect = controllerRef.current?.getBoundingClientRect();
      if (!rect) return;
      dragRef.current = {
        pointerId: e.pointerId,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
      };
      controllerRef.current?.setPointerCapture(e.pointerId);
    },
    [stopRepeat],
  );

  const onControllerPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      e.preventDefault();
      const next = clampControllerPosition({
        left: e.clientX - drag.offsetX,
        top: e.clientY - drag.offsetY,
      });
      setPosition(next);
    },
    [clampControllerPosition],
  );

  const finishControllerDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      e.preventDefault();
      dragRef.current = null;
      setPosition((prev) => {
        if (!prev) return prev;
        const clamped = clampControllerPosition(prev);
        persistControllerPosition(clamped);
        return clamped;
      });
      try {
        controllerRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        // Pointer capture may already be released by the browser.
      }
    },
    [clampControllerPosition, persistControllerPosition],
  );

  return (
    <div
      ref={controllerRef}
      className="pointer-events-auto fixed z-40 flex touch-none select-none flex-col items-center gap-2 rounded border border-cyan-300/40 bg-black/72 p-3 shadow-2xl shadow-cyan-950/60 backdrop-blur-md"
      style={
        position
          ? { left: position.left, top: position.top }
          : {
              right: "max(1.25rem, env(safe-area-inset-right))",
              bottom: "max(1.25rem, env(safe-area-inset-bottom))",
            }
      }
      data-testid="tablet-movement-controller"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={onControllerPointerMove}
      onPointerUp={finishControllerDrag}
      onPointerCancel={finishControllerDrag}
    >
      <button
        type="button"
        aria-label="Move movement controller"
        title="Drag controller"
        className="flex h-7 w-full touch-none items-center justify-center gap-2 rounded border border-cyan-300/25 bg-cyan-300/10 font-mono text-[9px] uppercase tracking-[0.22em] text-cyan-100/75"
        onPointerDown={onDragHandlePointerDown}
        data-testid="handle-tablet-movement-controller-drag"
      >
        <Move className="h-3.5 w-3.5" />
        Drag
      </button>
      <div className="font-mono text-[10px] uppercase tracking-widest text-cyan-100/90">
        {previewText}
      </div>
      <div className="max-w-44 text-center font-mono text-[9px] uppercase leading-snug tracking-wider text-cyan-100/70">
        {turnHint}
      </div>
      <div className="grid grid-cols-3 grid-rows-3 place-items-center gap-1">
        <div />
        <RepeatButton
          label="Forward"
          icon={<ArrowUp className="h-7 w-7" />}
          disabled={!canForward}
          active={plan?.kind === "forward"}
          className="rounded-t-md"
          onPress={onForward}
        />
        <div />
        <RepeatButton
          label="Turn left"
          icon={<ArrowLeft className="h-7 w-7" />}
          disabled={!canTurn}
          active={plan?.kind === "turn" && plan.deltaDeg < 0}
          className="rounded-l-md"
          onPress={onTurnLeft}
        />
        <div className="flex h-12 w-12 items-center justify-center rounded-sm border border-cyan-200/40 bg-slate-950/80 shadow-inner shadow-cyan-300/20" />
        <RepeatButton
          label="Turn right"
          icon={<ArrowRight className="h-7 w-7" />}
          disabled={!canTurn}
          active={plan?.kind === "turn" && plan.deltaDeg > 0}
          className="rounded-r-md"
          onPress={onTurnRight}
        />
        <div />
        <RepeatButton
          label="Rewind preview"
          icon={<ArrowDown className="h-7 w-7" />}
          disabled={plan?.kind !== "forward" || plan.distance <= 0}
          active={plan?.kind === "forward" && plan.distance > 0}
          className="rounded-b-md"
          onPress={onBack}
        />
        <div />
      </div>
      <button
        type="button"
        aria-label="Super maneuverable free turn"
        title="Super maneuverable free turn"
        disabled={!isSuperManeuverable || !canTurn}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (isSuperManeuverable && canTurn) onFreeTurn();
        }}
        className={`flex h-11 w-24 items-center justify-center rounded-full border transition-colors ${
          freeTurnActive
            ? "border-amber-200/80 bg-amber-300/25 text-amber-100 shadow-[0_0_20px_rgba(251,191,36,0.4)]"
            : "border-cyan-300/70 bg-cyan-300/10 text-cyan-100 shadow-[0_0_18px_rgba(34,211,238,0.3)] hover:bg-cyan-300/20"
        } disabled:border-slate-600/60 disabled:bg-slate-900/70 disabled:text-slate-500 disabled:shadow-none`}
        data-testid="button-tablet-free-turn"
      >
        <RotateCcw className="h-7 w-7" />
      </button>
      <div className="grid w-full grid-cols-2 gap-2 pt-1">
        <button
          type="button"
          aria-label="Cancel move preview"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }}
          className="flex h-10 items-center justify-center rounded border border-slate-500/70 bg-slate-950/80 text-slate-200 hover:bg-slate-800"
          data-testid="button-tablet-cancel-move"
        >
          <X className="h-5 w-5" />
        </button>
        <button
          type="button"
          aria-label="Confirm move preview"
          disabled={!canConfirm}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onConfirm();
          }}
          className="flex h-10 items-center justify-center rounded border border-amber-300/80 bg-amber-300 text-black hover:bg-amber-200 disabled:border-slate-600/60 disabled:bg-slate-900/70 disabled:text-slate-500"
          data-testid="button-tablet-confirm-move"
        >
          <Check className="h-5 w-5" />
        </button>
      </div>
      <button
        type="button"
        aria-label={endActivationLabel}
        title={endActivationTitle ?? endActivationLabel}
        disabled={!canEndActivation}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (canEndActivation) onEndActivation();
        }}
        className="mt-1 flex h-8 w-full items-center justify-center gap-1.5 rounded border border-cyan-300/55 bg-cyan-300/10 px-2 font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-cyan-100 shadow-[0_0_14px_rgba(34,211,238,0.22)] transition-colors hover:bg-cyan-300/20 disabled:border-slate-600/60 disabled:bg-slate-900/70 disabled:text-slate-500 disabled:shadow-none"
        data-testid="button-tablet-end-activation"
      >
        <CheckCircle className="h-3.5 w-3.5" />
        {endActivationLabel}
      </button>
    </div>
  );
}

interface StagedUnitData {
  id: string;
  ownerId: string;
  shipModelId: number;
  name: string;
  modelFilename: string;
  faction: string;
  priorityLevel: string;
  hullPoints: number;
  speed: number;
  weaponRange: number;
  weaponDamage: number;
  baseRadiusInches: number;
  weapons: Pick<Weapon, "arc">[];
  traits?: string | null;
  carriedFighters?: StagedFighterInventoryItem[];
  launchedFromStagedId?: string | null;
  deploymentGroupId?: string | null;
  deploymentGroupSize?: number | null;
  deploymentGroupOrdinal?: number | null;
  x: number;
  z: number;
  heading: number; // degrees, 0 = +Z axis, clockwise
  locked: boolean;
  // Crew Quality 1..7. Always 4 in "standard" games; chosen per ship in
  // "custom" games via the expandable card in the staged-units list.
  crewQuality: number;
}

// Crew Quality labels (1=Rookie … 7=Ancient). Kept here next to the staged
// unit type so the deploy UI and any future combat overlays render the same
// names without hardcoding strings throughout the file.
const CREW_QUALITY_LABELS: Record<number, string> = {
  1: "Rookie",
  2: "Green",
  3: "Competent",
  4: "Veteran",
  5: "Elite",
  6: "Special Ops",
  7: "Ancient",
};

type FleetTemplateShip = {
  modelName: string;
  count?: number;
};

type FleetTemplate = {
  id: string;
  name: string;
  faction: string;
  scenarioPriority: string;
  allocationPoints: number;
  ships: FleetTemplateShip[];
};

const TEST_FLEET_TEMPLATES: FleetTemplate[] = [
  {
    id: "minbari-sharlin-test",
    name: "Minbari Sharlin Test",
    faction: "Minbari Federation",
    scenarioPriority: "raid",
    allocationPoints: 4,
    ships: [{ modelName: "Sharlin War Cruiser" }],
  },
  {
    id: "ea-hyperion-nova-test",
    name: "EA Hyperion/Nova Test",
    faction: "Earth Alliance",
    scenarioPriority: "raid",
    allocationPoints: 3,
    ships: [
      { modelName: "Hyperion Heavy Cruiser", count: 2 },
      { modelName: "Nova Dreadnought" },
    ],
  },
];

function chargeableStagedUnits(units: StagedUnitData[]): StagedUnitData[] {
  const seenDeploymentGroups = new Set<string>();
  const chargeable: StagedUnitData[] = [];
  for (const unit of units) {
    if (unit.launchedFromStagedId) continue;
    const groupId = unit.deploymentGroupId?.trim();
    if (groupId) {
      if (seenDeploymentGroups.has(groupId)) continue;
      seenDeploymentGroups.add(groupId);
    }
    chargeable.push(unit);
  }
  return chargeable;
}

function deploymentGroupGridOffsets(
  count: number,
  spacing: number,
): Array<{ x: number; z: number }> {
  if (count <= 1) return [{ x: 0, z: 0 }];
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  return Array.from({ length: count }, (_, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    return {
      x: (col - (columns - 1) / 2) * spacing,
      z: (row - (rows - 1) / 2) * spacing,
    };
  });
}

const PRIORITY_HUD_STYLE: Record<
  PriorityLevel,
  { fill: string; text: string; label: string }
> = {
  patrol: { fill: "bg-cyan-400", text: "text-cyan-200", label: "PAT" },
  skirmish: { fill: "bg-emerald-400", text: "text-emerald-200", label: "SKM" },
  raid: { fill: "bg-amber-400", text: "text-amber-200", label: "RAID" },
  battle: { fill: "bg-orange-500", text: "text-orange-200", label: "BTL" },
  war: { fill: "bg-violet-400", text: "text-violet-200", label: "WAR" },
  armageddon: { fill: "bg-yellow-100", text: "text-yellow-100", label: "ARM" },
  ancient: { fill: "bg-fuchsia-300", text: "text-fuchsia-200", label: "ANC" },
};

function formatAllocationRemainder(
  ticks: number,
  scenarioPriority: PriorityLevel,
): string {
  if (ticks <= 0) return "0";
  const scenarioIndex = PRIORITY_LEVELS.indexOf(scenarioPriority);
  const parts: string[] = [];
  let remaining = ticks;

  for (let i = scenarioIndex; i >= 0; i -= 1) {
    const level = PRIORITY_LEVELS[i];
    const cost = allocationTicksForShip(level, scenarioPriority);
    if (cost <= 0) continue;
    const count = Math.floor(remaining / cost);
    if (count > 0) {
      parts.push(`${priorityLabel(level)} ${count}`);
      remaining -= count * cost;
    }
  }

  return parts.length > 0 ? parts.join(" + ") : formatAllocationTicks(ticks);
}

function DeploymentAllocationHud({
  units,
  scenarioPriority,
  allocationPoints,
  legal,
  remainingTicks,
}: {
  units: StagedUnitData[];
  scenarioPriority: PriorityLevel;
  allocationPoints: number;
  legal: boolean;
  remainingTicks: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const budgetTicks = Math.max(1, allocationPoints * ALLOCATION_TICKS_PER_FAP);
  const chargeableUnits = chargeableStagedUnits(units);
  let cursor = 0;
  const segments = chargeableUnits.map((unit) => {
    const priority = normalizePriorityLevel(unit.priorityLevel);
    const cost = allocationTicksForShip(priority, scenarioPriority);
    const start = cursor;
    cursor += cost;
    return {
      id: unit.id,
      name: unit.name,
      priority,
      startPct: Math.min(100, (start / budgetTicks) * 100),
      widthPct: Math.max(
        1.25,
        ((Math.min(cursor, budgetTicks) - Math.min(start, budgetTicks)) /
          budgetTicks) *
          100,
      ),
      over: start >= budgetTicks,
    };
  });
  const overflowPct = Math.min(
    28,
    Math.max(0, ((cursor - budgetTicks) / budgetTicks) * 100),
  );
  const remainingLabel = legal
    ? formatAllocationRemainder(remainingTicks, scenarioPriority)
    : formatAllocationRemainder(Math.abs(remainingTicks), scenarioPriority);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`pointer-events-auto w-[min(42rem,calc(100vw-1.5rem))] rounded border px-3 py-2 text-left font-mono shadow-2xl backdrop-blur-md transition-colors ${
          legal
            ? "border-amber-500/40 bg-black/65 text-amber-100"
            : "border-red-500/70 bg-red-950/70 text-red-100"
        }`}
        data-testid="deployment-allocation-hud"
      >
        <div className="mb-1.5 flex items-center justify-between gap-3 text-[10px] uppercase tracking-widest">
          <span className="shrink-0">
            {priorityLabel(scenarioPriority)} {allocationPoints} FAP
          </span>
          <span className={legal ? "text-emerald-300" : "text-red-300"}>
            {legal ? `Left ${remainingLabel}` : `Over ${remainingLabel}`}
          </span>
        </div>
        <div className="relative h-5 overflow-hidden rounded border border-white/10 bg-white/5">
          {segments.map((segment) => (
            <div
              key={segment.id}
              className={`absolute top-0 h-full ${segment.over ? "bg-red-500" : PRIORITY_HUD_STYLE[segment.priority].fill}`}
              style={{
                left: `${segment.startPct}%`,
                width: `${segment.widthPct}%`,
              }}
              title={`${segment.name} · ${priorityLabel(segment.priority)}`}
            />
          ))}
          {overflowPct > 0 && (
            <div
              className="absolute right-0 top-0 h-full animate-pulse bg-red-500/80"
              style={{ width: `${overflowPct}%` }}
            />
          )}
          <div
            className="pointer-events-none absolute inset-0 z-10 grid"
            style={{
              gridTemplateColumns: `repeat(${Math.max(1, allocationPoints)}, minmax(0, 1fr))`,
            }}
          >
            {Array.from({ length: Math.max(1, allocationPoints) }).map(
              (_, index) => (
                <div
                  key={index}
                  className="border-r border-black/55 shadow-[inset_-1px_0_rgba(255,255,255,0.35)] last:border-r-0 last:shadow-none"
                />
              ),
            )}
          </div>
        </div>
        {expanded && (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            {Object.entries(PRIORITY_HUD_STYLE).map(([level, style]) => {
              const count = chargeableUnits.filter(
                (unit) => normalizePriorityLevel(unit.priorityLevel) === level,
              ).length;
              if (count === 0) return null;
              return (
                <span key={level} className={style.text}>
                  {style.label} x{count}
                </span>
              );
            })}
            {chargeableUnits.length === 0 && <span>No ships placed</span>}
          </div>
        )}
      </button>
    </div>
  );
}

function StagedUnit3D({
  unit,
  isSelected,
  onClick,
  onPointerDown,
  arcColorScheme = "classic",
  shipMeshTintsEnabled = true,
  shipHullNamesEnabled = true,
}: {
  unit: StagedUnitData;
  isSelected: boolean;
  onClick: (e: any) => void;
  onPointerDown?: (e: any) => void;
  arcColorScheme?: UiArcColorScheme;
  shipMeshTintsEnabled?: boolean;
  shipHullNamesEnabled?: boolean;
}) {
  const baseColor = unit.locked ? "#22c55e" : "#f59e0b";
  const ringOpacity = isSelected ? 0.8 : unit.locked ? 0.55 : 0.45;
  const fillOpacity = isSelected ? 0.28 : 0.15;
  const headingRad = (unit.heading * Math.PI) / 180;
  const baseRadius = rulesBaseRadius(unit);
  const ringInner = Math.max(0.05, baseRadius - 0.05);
  const pulseInner = baseRadius + 0.18;
  const pulseOuter = baseRadius + 0.28;

  return (
    <group
      position={[unit.x, 0, unit.z]}
      onClick={onClick}
      onPointerDown={onPointerDown}
    >
      {/* Selection pulse ring */}
      {isSelected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
          <ringGeometry args={[pulseInner, pulseOuter, 48]} />
          <meshStandardMaterial
            color="white"
            transparent
            opacity={0.35}
            emissive="white"
            emissiveIntensity={0.4}
            depthWrite={false}
          />
        </mesh>
      )}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <circleGeometry args={[baseRadius, 48]} />
        <meshStandardMaterial
          color={baseColor}
          transparent
          opacity={fillOpacity}
          depthWrite={false}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <ringGeometry args={[ringInner, baseRadius, 48]} />
        <meshStandardMaterial
          color={baseColor}
          transparent
          opacity={ringOpacity}
          emissive={baseColor}
          emissiveIntensity={0.25}
        />
      </mesh>
      {/* Weapon arcs — rendered in heading-rotated group so they turn with the ship */}
      <group rotation={[0, headingRad, 0]}>
        <BaseOrientationDisplay
          flip={FLIP_MODELS.has(unit.modelFilename)}
          baseRadius={baseRadius}
          opacityScale={isSelected ? 1 : 0.78}
          arcColorScheme={arcColorScheme}
          arcSide="friendly"
        />
      </group>
      {isSelected && unit.weapons.length > 0 && (
        <group rotation={[0, headingRad, 0]}>
          <WeaponArcDisplay
            weapons={unit.weapons}
            flip={FLIP_MODELS.has(unit.modelFilename)}
            baseRadius={baseRadius}
            arcColorScheme={arcColorScheme}
            arcSide="friendly"
          />
        </group>
      )}
      {/* Ship model, rotated to match heading */}
      <group position={[0, 2, 0]} rotation={[0, headingRad, 0]}>
        <ModelErrorBoundary color={baseColor}>
          <Suspense fallback={<ShipModelFallback color={baseColor} />}>
            <BoardModelVisual
              filename={unit.modelFilename}
              tint={baseColor}
              meshTintsEnabled={shipMeshTintsEnabled}
            />
          </Suspense>
        </ModelErrorBoundary>
      </group>
      {shipHullNamesEnabled && (
        <CameraFacingText
          position={[0, 3.9, 0]}
          fontSize={0.32}
          color={unit.locked ? "#86efac" : "white"}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.035}
          outlineColor="black"
        >
          {unit.locked
            ? `LOCK ${boardShipNameLabel(unit.name, BOARD_LOCKED_SHIP_NAME_MAX_CHARS)}`
            : boardShipNameLabel(unit.name)}
        </CameraFacingText>
      )}
      {/* Heading degrees label when selected and unlocked */}
      {isSelected && !unit.locked && (
        <CameraFacingText
          position={[0, 3.4, 0]}
          fontSize={0.28}
          color="#94a3b8"
          anchorX="center"
          anchorY="middle"
        >
          {`${Math.round(unit.heading)}°  Q / E`}
        </CameraFacingText>
      )}
    </group>
  );
}

// Captures camera + renderer refs from inside the Canvas for raycasting
function CameraCapture({
  refs,
}: {
  refs: React.MutableRefObject<{
    camera: THREE.Camera;
    gl: THREE.WebGLRenderer;
  } | null>;
}) {
  const { camera, gl } = useThree();
  refs.current = { camera, gl: gl as unknown as THREE.WebGLRenderer };
  return null;
}

type CameraFocusRequest = {
  seq: number;
  x: number;
  z: number;
  distance?: number;
  targetHeight?: number;
};

type TacticalCameraViewMode = "free" | "top" | "iso";

type CameraViewRequest = {
  seq: number;
  mode: TacticalCameraViewMode;
};

function BoardCameraControls({
  disabled,
  focusRequest,
  viewRequest,
  orientationLocked,
  topDownLocked,
  controlMode = "mode-a",
}: {
  disabled?: boolean;
  focusRequest?: CameraFocusRequest | null;
  viewRequest?: CameraViewRequest | null;
  orientationLocked?: boolean;
  topDownLocked?: boolean;
  controlMode?: UiControlMode;
}) {
  const controlsRef = useRef<any>(null);
  const { camera, gl } = useThree();
  const keysRef = useRef(new Set<string>());
  const focusRef = useRef<{
    camera: THREE.Vector3;
    target: THREE.Vector3;
  } | null>(null);
  const effectiveTopDownLocked = topDownLocked || controlMode === "mode-f";
  const activeViewMode = effectiveTopDownLocked
    ? "top"
    : (viewRequest?.mode ?? "free");
  const orientationPresetLocked = Boolean(
    orientationLocked && activeViewMode !== "free",
  );
  const modeBPointerRef = useRef<{
    pointers: Map<
      number,
      {
        x: number;
        y: number;
        startX: number;
        startY: number;
        startedAt: number;
      }
    >;
    gesture: "pending" | "orbit" | "pan" | "pinch" | null;
    side: "left" | "right" | null;
    lastPinchDistance: number;
    claimed: boolean;
  }>({
    pointers: new Map(),
    gesture: null,
    side: null,
    lastPinchDistance: 0,
    claimed: false,
  });
  const clampCameraTargetToBoardBounds = useCallback(() => {
    const controls = controlsRef.current;
    if (!controls) return false;

    const minX = -BOARD_W / 2 - CAMERA_PAN_MARGIN;
    const maxX = BOARD_W / 2 + CAMERA_PAN_MARGIN;
    const minZ = -BOARD_D / 2 - CAMERA_PAN_MARGIN;
    const maxZ = BOARD_D / 2 + CAMERA_PAN_MARGIN;
    const nextX = THREE.MathUtils.clamp(controls.target.x, minX, maxX);
    const nextZ = THREE.MathUtils.clamp(controls.target.z, minZ, maxZ);
    const dx = nextX - controls.target.x;
    const dz = nextZ - controls.target.z;
    if (Math.abs(dx) < 0.0001 && Math.abs(dz) < 0.0001) return false;

    controls.target.x = nextX;
    controls.target.z = nextZ;
    camera.position.x += dx;
    camera.position.z += dz;
    return true;
  }, [camera]);

  const cameraOffsetForViewMode = useCallback(
    (mode: TacticalCameraViewMode, distance: number): THREE.Vector3 => {
      if (mode === "top") {
        return new THREE.Vector3().setFromSpherical(
          new THREE.Spherical(distance, TOP_DOWN_POLAR_ANGLE, 0),
        );
      }
      if (mode === "iso") {
        return new THREE.Vector3().setFromSpherical(
          new THREE.Spherical(
            distance,
            ISO_CAMERA_POLAR_ANGLE,
            ISO_CAMERA_AZIMUTH_ANGLE,
          ),
        );
      }
      return camera.position
        .clone()
        .sub(controlsRef.current?.target ?? new THREE.Vector3(0, 0, 0));
    },
    [camera],
  );

  const enforceCameraPreset = useCallback(
    (mode: TacticalCameraViewMode, preferredDistance?: number): void => {
      const controls = controlsRef.current;
      if (!controls) return;
      const target = controls.target as THREE.Vector3;
      const currentDistance = camera.position.distanceTo(target);
      const requestedDistance = preferredDistance ?? currentDistance;
      const distance = THREE.MathUtils.clamp(
        requestedDistance ||
          (mode === "iso" ? ISO_CAMERA_DISTANCE : TOP_DOWN_CAMERA_DISTANCE),
        CAMERA_MIN_DISTANCE,
        CAMERA_MAX_DISTANCE,
      );
      target.y =
        mode === "top" || mode === "iso" ? BOARD_FOCUS_TARGET_HEIGHT : target.y;
      const offset = cameraOffsetForViewMode(mode, distance);
      camera.position.copy(target).add(offset);
    },
    [camera, cameraOffsetForViewMode],
  );

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName?.toLowerCase();
      return (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        el.isContentEditable
      );
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (
        disabled ||
        isEditableTarget(e.target) ||
        e.altKey ||
        e.ctrlKey ||
        e.metaKey
      )
        return;
      const key = e.key.toLowerCase();
      if (!["w", "a", "s", "d"].includes(key)) return;
      e.preventDefault();
      keysRef.current.add(key);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.key.toLowerCase());
    };

    const onBlur = () => keysRef.current.clear();

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [disabled]);

  useEffect(() => {
    const canvas = gl.domElement;
    const preventContextMenu = (e: MouseEvent) => e.preventDefault();
    canvas.addEventListener("contextmenu", preventContextMenu);
    return () => canvas.removeEventListener("contextmenu", preventContextMenu);
  }, [gl]);

  useEffect(() => {
    const canvas = gl.domElement;
    const usesCustomTouch =
      controlMode === "mode-b" || controlMode === "mode-d";
    if (!usesCustomTouch) {
      modeBPointerRef.current.pointers.clear();
      modeBPointerRef.current.gesture = null;
      modeBPointerRef.current.claimed = false;
      return;
    }

    const stopForCameraGesture = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const pointerDistance = () => {
      const values = [...modeBPointerRef.current.pointers.values()];
      if (values.length < 2) return 0;
      return Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
    };

    const applyOrbit = (dx: number, dy: number) => {
      const controls = controlsRef.current;
      if (!controls || effectiveTopDownLocked || orientationPresetLocked)
        return;
      const target = controls.target as THREE.Vector3;
      const offset = camera.position.clone().sub(target);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta -= dx * 0.006;
      spherical.phi = THREE.MathUtils.clamp(
        spherical.phi - dy * 0.006,
        0.08,
        CAMERA_MAX_POLAR_ANGLE,
      );
      offset.setFromSpherical(spherical);
      camera.position.copy(target).add(offset);
      controls.update();
    };

    const applyPan = (dx: number, dy: number) => {
      const controls = controlsRef.current;
      if (!controls) return;
      const target = controls.target as THREE.Vector3;
      const rect = canvas.getBoundingClientRect();
      const distance = camera.position.distanceTo(target);
      const perspectiveCamera = camera as THREE.PerspectiveCamera;
      const fov =
        typeof perspectiveCamera.fov === "number" ? perspectiveCamera.fov : 50;
      const worldPerPixel =
        (2 * distance * Math.tan(THREE.MathUtils.degToRad(fov / 2))) /
        Math.max(1, rect.height);

      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() < 0.0001) forward.set(0, 0, -1);
      forward.normalize();
      const right = new THREE.Vector3()
        .crossVectors(forward, new THREE.Vector3(0, 1, 0))
        .normalize();
      const move = right
        .multiplyScalar(-dx * worldPerPixel)
        .add(forward.multiplyScalar(dy * worldPerPixel));

      target.add(move);
      camera.position.add(move);
      clampCameraTargetToBoardBounds();
      controls.update();
    };

    const applyPinchZoom = (nextDistance: number) => {
      const controls = controlsRef.current;
      if (!controls) return;
      const state = modeBPointerRef.current;
      if (state.lastPinchDistance <= 0 || nextDistance <= 0) {
        state.lastPinchDistance = nextDistance;
        return;
      }
      const target = controls.target as THREE.Vector3;
      const offset = camera.position.clone().sub(target);
      const currentDistance = offset.length();
      if (currentDistance <= 0.001) return;
      const scaledDistance = THREE.MathUtils.clamp(
        currentDistance * (state.lastPinchDistance / nextDistance),
        CAMERA_MIN_DISTANCE,
        CAMERA_MAX_DISTANCE,
      );
      offset.setLength(scaledDistance);
      camera.position.copy(target).add(offset);
      state.lastPinchDistance = nextDistance;
      controls.update();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || disabled) return;
      const rect = canvas.getBoundingClientRect();
      const state = modeBPointerRef.current;
      state.pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        startedAt: performance.now(),
      });
      if (state.pointers.size === 1) {
        state.gesture = "pending";
        state.side =
          event.clientX < rect.left + rect.width / 2 ? "left" : "right";
        state.claimed = false;
      } else if (state.pointers.size >= 2) {
        state.gesture = "pinch";
        state.side = null;
        state.claimed = true;
        state.lastPinchDistance = pointerDistance();
        stopForCameraGesture(event);
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || disabled) return;
      const state = modeBPointerRef.current;
      const pointer = state.pointers.get(event.pointerId);
      if (!pointer) return;

      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      pointer.x = event.clientX;
      pointer.y = event.clientY;

      if (state.pointers.size >= 2) {
        state.gesture = "pinch";
        state.claimed = true;
        stopForCameraGesture(event);
        applyPinchZoom(pointerDistance());
        return;
      }

      if (state.gesture === "pending") {
        const totalDx = event.clientX - pointer.startX;
        const totalDy = event.clientY - pointer.startY;
        if (totalDx * totalDx + totalDy * totalDy < 36) return;
        if (controlMode === "mode-b") {
          state.gesture = state.side === "left" ? "orbit" : "pan";
        } else {
          state.gesture =
            performance.now() - pointer.startedAt >= CAMERA_LONG_PRESS_ORBIT_MS
              ? "orbit"
              : "pan";
        }
        state.claimed = true;
      }

      if (state.gesture === "orbit" || state.gesture === "pan") {
        stopForCameraGesture(event);
        if (state.gesture === "orbit") applyOrbit(dx, dy);
        else applyPan(dx, dy);
      }
    };

    const finishPointer = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      const state = modeBPointerRef.current;
      const shouldStop = state.claimed;
      state.pointers.delete(event.pointerId);
      if (state.pointers.size === 0) {
        state.gesture = null;
        state.side = null;
        state.lastPinchDistance = 0;
        state.claimed = false;
      } else if (state.pointers.size === 1) {
        const remaining = [...state.pointers.values()][0];
        state.gesture = "pending";
        state.side =
          remaining.x <
          canvas.getBoundingClientRect().left +
            canvas.getBoundingClientRect().width / 2
            ? "left"
            : "right";
        state.lastPinchDistance = 0;
        state.claimed = false;
      }
      if (shouldStop) stopForCameraGesture(event);
    };

    canvas.addEventListener("pointerdown", onPointerDown, { capture: true });
    canvas.addEventListener("pointermove", onPointerMove, { capture: true });
    canvas.addEventListener("pointerup", finishPointer, { capture: true });
    canvas.addEventListener("pointercancel", finishPointer, { capture: true });
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown, {
        capture: true,
      });
      canvas.removeEventListener("pointermove", onPointerMove, {
        capture: true,
      });
      canvas.removeEventListener("pointerup", finishPointer, { capture: true });
      canvas.removeEventListener("pointercancel", finishPointer, {
        capture: true,
      });
      modeBPointerRef.current.pointers.clear();
      modeBPointerRef.current.gesture = null;
      modeBPointerRef.current.claimed = false;
    };
  }, [
    camera,
    clampCameraTargetToBoardBounds,
    controlMode,
    disabled,
    effectiveTopDownLocked,
    gl,
    orientationPresetLocked,
  ]);

  useEffect(() => {
    if (!focusRequest) return;
    const controls = controlsRef.current;
    if (!controls) return;

    const target = new THREE.Vector3(
      focusRequest.x,
      focusRequest.targetHeight ?? UNIT_FOCUS_TARGET_HEIGHT,
      focusRequest.z,
    );
    const currentTarget = controls.target.clone();
    let nextCamera: THREE.Vector3;
    if (effectiveTopDownLocked || orientationPresetLocked) {
      const mode = activeViewMode === "free" ? "top" : activeViewMode;
      const distance =
        focusRequest.distance ??
        (mode === "iso" ? ISO_CAMERA_DISTANCE : TOP_DOWN_CAMERA_DISTANCE);
      const offset = cameraOffsetForViewMode(mode, distance);
      nextCamera = target.clone().add(offset);
    } else {
      const viewDir = camera.position.clone().sub(currentTarget);
      if (viewDir.lengthSq() < 0.0001) viewDir.set(0, 0.55, 0.85);
      viewDir.normalize();
      nextCamera = target
        .clone()
        .add(
          viewDir.multiplyScalar(
            focusRequest.distance ?? UNIT_FOCUS_CAMERA_DISTANCE,
          ),
        );
    }

    focusRef.current = {
      target,
      camera: nextCamera,
    };
  }, [
    activeViewMode,
    camera,
    cameraOffsetForViewMode,
    effectiveTopDownLocked,
    focusRequest,
    orientationPresetLocked,
  ]);

  useEffect(() => {
    if (!effectiveTopDownLocked) return;
    enforceCameraPreset("top", TOP_DOWN_CAMERA_DISTANCE);
    clampCameraTargetToBoardBounds();
    controlsRef.current?.update();
  }, [
    clampCameraTargetToBoardBounds,
    effectiveTopDownLocked,
    enforceCameraPreset,
  ]);

  useEffect(() => {
    if (!viewRequest || effectiveTopDownLocked || viewRequest.mode === "free")
      return;
    enforceCameraPreset(
      viewRequest.mode,
      viewRequest.mode === "iso"
        ? ISO_CAMERA_DISTANCE
        : TOP_DOWN_CAMERA_DISTANCE,
    );
    clampCameraTargetToBoardBounds();
    controlsRef.current?.update();
  }, [
    clampCameraTargetToBoardBounds,
    effectiveTopDownLocked,
    enforceCameraPreset,
    viewRequest,
  ]);

  useFrame((_, delta) => {
    const focus = focusRef.current;
    const controls = controlsRef.current;
    if (focus && controls) {
      const t = 1 - Math.exp(-UNIT_FOCUS_LERP * delta);
      camera.position.lerp(focus.camera, t);
      controls.target.lerp(focus.target, t);
      clampCameraTargetToBoardBounds();
      controls.update();
      if (
        camera.position.distanceToSquared(focus.camera) < 0.0025 &&
        controls.target.distanceToSquared(focus.target) < 0.0025
      ) {
        camera.position.copy(focus.camera);
        controls.target.copy(focus.target);
        clampCameraTargetToBoardBounds();
        controls.update();
        focusRef.current = null;
      }
      return;
    }

    if (!controls) return;
    controls.update();
    if (clampCameraTargetToBoardBounds()) controls.update();

    if (effectiveTopDownLocked) {
      enforceCameraPreset("top");
      controls.update();
      return;
    }

    if (orientationPresetLocked) {
      enforceCameraPreset(activeViewMode);
      controls.update();
      return;
    }

    if (disabled || keysRef.current.size === 0) return;

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 0.0001) forward.set(0, 0, -1);
    forward.normalize();

    const right = new THREE.Vector3()
      .crossVectors(forward, new THREE.Vector3(0, 1, 0))
      .normalize();
    const move = new THREE.Vector3();

    if (keysRef.current.has("w")) move.add(forward);
    if (keysRef.current.has("s")) move.sub(forward);
    if (keysRef.current.has("d")) move.add(right);
    if (keysRef.current.has("a")) move.sub(right);
    if (move.lengthSq() === 0) return;

    move.normalize().multiplyScalar(delta * CAMERA_KEYBOARD_PAN_SPEED);
    const nextTarget = controls.target.clone().add(move);
    nextTarget.x = THREE.MathUtils.clamp(
      nextTarget.x,
      -BOARD_W / 2 - CAMERA_PAN_MARGIN,
      BOARD_W / 2 + CAMERA_PAN_MARGIN,
    );
    nextTarget.z = THREE.MathUtils.clamp(
      nextTarget.z,
      -BOARD_D / 2 - CAMERA_PAN_MARGIN,
      BOARD_D / 2 + CAMERA_PAN_MARGIN,
    );

    const applied = nextTarget.sub(controls.target);
    controls.target.add(applied);
    camera.position.add(applied);
    controls.update();
  });

  return (
    <OrbitControls
      ref={controlsRef}
      enablePan={!disabled}
      enableZoom={!disabled}
      enableRotate={
        !disabled && !effectiveTopDownLocked && !orientationPresetLocked
      }
      enableDamping
      dampingFactor={CAMERA_DAMPING_FACTOR}
      panSpeed={CAMERA_DRAG_PAN_SPEED}
      minPolarAngle={
        effectiveTopDownLocked
          ? TOP_DOWN_POLAR_ANGLE
          : orientationPresetLocked && activeViewMode === "iso"
            ? ISO_CAMERA_POLAR_ANGLE
            : 0.08
      }
      maxPolarAngle={
        effectiveTopDownLocked
          ? TOP_DOWN_POLAR_ANGLE
          : orientationPresetLocked && activeViewMode === "iso"
            ? ISO_CAMERA_POLAR_ANGLE
            : CAMERA_MAX_POLAR_ANGLE
      }
      minDistance={CAMERA_MIN_DISTANCE}
      maxDistance={CAMERA_MAX_DISTANCE}
      mouseButtons={{
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.ROTATE,
      }}
      touches={{
        ONE:
          controlMode === "mode-b" || controlMode === "mode-d"
            ? (undefined as unknown as number)
            : controlMode === "mode-a"
              ? THREE.TOUCH.ROTATE
              : THREE.TOUCH.PAN,
        TWO:
          controlMode === "mode-b" || controlMode === "mode-d"
            ? (undefined as unknown as number)
            : controlMode === "mode-e"
              ? THREE.TOUCH.DOLLY_ROTATE
              : THREE.TOUCH.DOLLY_PAN,
      }}
    />
  );
}

function screenToBoard(
  clientX: number,
  clientY: number,
  refs: React.MutableRefObject<{
    camera: THREE.Camera;
    gl: THREE.WebGLRenderer;
  } | null>,
): [number, number] | null {
  if (!refs.current) return null;
  const { camera, gl } = refs.current;
  const canvas = (gl as any).domElement as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(plane, hit)) return null;
  return [
    Math.max(-BOARD_W / 2, Math.min(BOARD_W / 2, hit.x)),
    Math.max(-BOARD_D / 2, Math.min(BOARD_D / 2, hit.z)),
  ];
}

function boardToScreen(
  x: number,
  z: number,
  refs: React.MutableRefObject<{
    camera: THREE.Camera;
    gl: THREE.WebGLRenderer;
  } | null>,
): { x: number; y: number } | null {
  if (!refs.current) return null;
  const { camera, gl } = refs.current;
  const canvas = (gl as any).domElement as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  const projected = new THREE.Vector3(x, 2.8, z).project(camera);
  return {
    x: ((projected.x + 1) / 2) * rect.width,
    y: ((1 - projected.y) / 2) * rect.height,
  };
}

function TacticalCameraControls({
  selectedDisabled,
  activeDisabled,
  viewMode,
  orientationLocked,
  onFocusBoard,
  onFocusActive,
  onFocusSelected,
  onSetViewMode,
  onToggleOrientationLock,
}: {
  selectedDisabled: boolean;
  activeDisabled: boolean;
  viewMode: TacticalCameraViewMode;
  orientationLocked: boolean;
  onFocusBoard: () => void;
  onFocusActive: () => void;
  onFocusSelected: () => void;
  onSetViewMode: (mode: TacticalCameraViewMode) => void;
  onToggleOrientationLock: () => void;
}) {
  const ButtonContent = ({
    icon,
    label,
  }: {
    icon: React.ReactNode;
    label: string;
  }) => (
    <>
      {icon}
      <span className="text-[9px] font-bold uppercase tracking-wider">
        {label}
      </span>
    </>
  );

  const buttonClass =
    "flex min-h-9 items-center justify-center gap-1 rounded border px-2 font-mono text-cyan-100 transition-colors disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-950/70 disabled:text-slate-500";
  const inactiveClass = "border-cyan-300/45 bg-black/72 hover:bg-cyan-300/15";
  const activeClass =
    "border-amber-300/80 bg-amber-300/20 text-amber-100 shadow-[0_0_14px_rgba(251,191,36,0.25)]";

  return (
    <div
      className="pointer-events-auto absolute right-3 top-3 z-40 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-1 rounded border border-cyan-300/35 bg-black/72 p-1.5 shadow-xl shadow-cyan-950/40 backdrop-blur-md"
      data-testid="tactical-camera-controls"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onPointerCancel={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={`${buttonClass} ${inactiveClass}`}
        onClick={onFocusBoard}
        title="Focus board"
      >
        <ButtonContent
          icon={<Maximize2 className="h-3.5 w-3.5" />}
          label="Board"
        />
      </button>
      <button
        type="button"
        className={`${buttonClass} ${inactiveClass}`}
        onClick={onFocusActive}
        disabled={activeDisabled}
        title="Focus active ship"
      >
        <ButtonContent
          icon={<Target className="h-3.5 w-3.5" />}
          label="Active"
        />
      </button>
      <button
        type="button"
        className={`${buttonClass} ${inactiveClass}`}
        onClick={onFocusSelected}
        disabled={selectedDisabled}
        title="Focus selected ship"
      >
        <ButtonContent
          icon={<Crosshair className="h-3.5 w-3.5" />}
          label="Selected"
        />
      </button>
      <button
        type="button"
        className={`${buttonClass} ${viewMode === "top" ? activeClass : inactiveClass}`}
        onClick={() => onSetViewMode("top")}
        title="Top-down view"
      >
        <ButtonContent icon={<Camera className="h-3.5 w-3.5" />} label="Top" />
      </button>
      <button
        type="button"
        className={`${buttonClass} ${viewMode === "iso" ? activeClass : inactiveClass}`}
        onClick={() => onSetViewMode("iso")}
        title="Isometric view"
      >
        <ButtonContent icon={<Compass className="h-3.5 w-3.5" />} label="Iso" />
      </button>
      <button
        type="button"
        className={`${buttonClass} ${orientationLocked ? activeClass : inactiveClass}`}
        onClick={onToggleOrientationLock}
        disabled={viewMode === "free"}
        title="Lock camera orientation"
      >
        <ButtonContent
          icon={
            orientationLocked ? (
              <Lock className="h-3.5 w-3.5" />
            ) : (
              <Unlock className="h-3.5 w-3.5" />
            )
          }
          label="Lock"
        />
      </button>
    </div>
  );
}

export default function GameBoard() {
  const params = useParams<{ id: string }>();
  const gameId = parseInt(params.id ?? "0");
  const user = temporaryUsernameAuthEnabled ? null : useUser().user;
  const devUserId = useDevUserId();
  const temporaryUsername = useTemporaryUsername();
  void temporaryUsername;
  const rawMyUserId = temporaryUsernameAuthEnabled
    ? (getTemporaryUserId() ?? "")
    : import.meta.env.DEV
      ? devUserId
      : (user?.id ?? "");
  const qc = useQueryClient();
  const inputProfile = useInputProfile();
  const [uiControlMode] = useUiControlMode();
  const [uiArcColorScheme] = useUiArcColorScheme();
  const [shipMeshTintsEnabled] = useUiShipMeshTints();
  const [shipHullNamesEnabled] = useUiShipHullNames();
  const [shipStatusDisplayMode] = useUiShipStatusDisplayMode();
  const [boardOpacity] = useUiBoardOpacity();
  const [boardGridEnabled] = useUiBoardGrid();
  const [attackPulseOpacity] = useUiAttackPhasePulseOpacity();
  const [attackPulseStrength] = useUiAttackPhasePulseStrength();
  const [boardBackgroundMode] = useUiBoardBackgroundMode();
  const [weaponArcProjectionEnabled] = useUiWeaponArcProjection();
  const [isoCameraControlsEnabled] = useUiIsoCameraControls();
  const isTouchInput =
    inputProfile.input === "touch" || inputProfile.input === "hybrid";
  const isTabletDevice = inputProfile.deviceClass === "tablet";
  const mobileGameChrome =
    inputProfile.layout === "compact" || inputProfile.deviceClass === "phone";
  const touchGameControls = mobileGameChrome || isTabletDevice;
  const pcHoverHintsEnabled = !isTouchInput && !touchGameControls;
  const [opsPanelOpen, setOpsPanelOpen] = useState(false);
  const [cameraViewMode, setCameraViewMode] =
    useState<TacticalCameraViewMode>("free");
  const [cameraViewRequest, setCameraViewRequest] =
    useState<CameraViewRequest | null>(null);
  const [cameraOrientationLocked, setCameraOrientationLocked] = useState(false);

  useEffect(() => {
    setOpsPanelOpen(!mobileGameChrome);
  }, [mobileGameChrome]);

  // Live sync for two simultaneous players: poll the game state on an interval
  // so an opponent's action (movement, firing, end-phase, etc.) appears on this
  // client within a few seconds without a manual reload. We pause polling while
  // the dice-roll modal is open so a background refetch can never yank away the
  // staged dice reveal the player is stepping through, and we only poll while
  // the game is actually in progress (pending/deploying/active) — finished
  // games (completed/declined) never change, so there's nothing to fetch.
  const pausePollingRef = useRef(false);
  const POLL_INTERVAL_MS = 4000;

  const { data: gameData, isLoading } = useGetGame(gameId, {
    query: {
      queryKey: getGetGameQueryKey(gameId),
      refetchInterval: (query) => {
        if (pausePollingRef.current) return false;
        const status = query.state.data?.game?.status;
        if (
          status === "pending" ||
          status === "deploying" ||
          status === "active"
        ) {
          return POLL_INTERVAL_MS;
        }
        return false;
      },
    },
  });
  const { data: adminMe } = useQuery({
    queryKey: ["admin-me"],
    queryFn: () =>
      customFetch<{ isAdmin: boolean }>("/api/admin/me", {
        responseType: "json",
      }),
    staleTime: 60_000,
  });
  const game = gameData?.game;
  const units = gameData?.units ?? [];
  const turns = gameData?.turns ?? [];
  const [hoveredUnitId, setHoveredUnitId] = useState<number | null>(null);
  const [inspectedUnitId, setInspectedUnitId] = useState<number | null>(null);
  const terrainConfig = useMemo(
    () => normalizeTerrainConfig(game?.terrainConfig),
    [game?.terrainConfig],
  );
  const terrainFields = terrainConfig.objects;
  const manualTerrainPlacement = terrainConfig.manualPlacement ?? null;
  const lineOfSightObstacles = useMemo<LineOfSightObstacle[]>(() => {
    return lineOfSightObstaclesFromTerrainConfig(game?.terrainConfig);
  }, [game?.terrainConfig]);
  const devAiCommanderActive =
    import.meta.env.DEV &&
    (rawMyUserId === "test-user-1" || rawMyUserId === "test-user-2") &&
    game?.opponentKind === "ai" &&
    game.opponentId === AI_OPPONENT_ID &&
    rawMyUserId !== game.challengerId;
  const aiDeploymentControlActive =
    !devAiCommanderActive &&
    game?.status === "deploying" &&
    game.opponentKind === "ai" &&
    game.opponentId === AI_OPPONENT_ID &&
    rawMyUserId === game.challengerId &&
    game.challengerDeployed &&
    !game.opponentDeployed;
  const myUserId =
    devAiCommanderActive || aiDeploymentControlActive
      ? AI_OPPONENT_ID
      : rawMyUserId;
  const isChallenger = game?.challengerId === myUserId;
  const isOpponent = game?.opponentId === myUserId;
  const isParticipant = Boolean(isChallenger || isOpponent);
  const isAdminObserver = Boolean(game && adminMe?.isAdmin && !isParticipant);
  const aiFiringSummary = useMemo(
    () => readAiFiringSummary(game?.aiState),
    [game?.aiState],
  );
  const [acknowledgedAiFiringSummaryId, setAcknowledgedAiFiringSummaryId] =
    useState<string | null>(() => {
      if (typeof window === "undefined") return null;
      try {
        return window.sessionStorage.getItem(aiFiringSummaryStorageKey(gameId));
      } catch {
        return null;
      }
    });
  const acknowledgedAiFiringSummaryIdRef = useRef<string | null>(
    acknowledgedAiFiringSummaryId,
  );
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.sessionStorage.getItem(aiFiringSummaryStorageKey(gameId));
    } catch {
      stored = null;
    }
    acknowledgedAiFiringSummaryIdRef.current = stored;
    setAcknowledgedAiFiringSummaryId(stored);
  }, [gameId]);
  const pendingAiFiringSummary =
    game?.opponentKind === "ai" &&
    myUserId !== AI_OPPONENT_ID &&
    aiFiringSummary &&
    aiFiringSummary.id !== acknowledgedAiFiringSummaryId
      ? aiFiringSummary
      : null;
  const acknowledgeAiFiringSummary = useCallback(() => {
    if (!pendingAiFiringSummary) return;
    const summaryId = pendingAiFiringSummary.id;
    acknowledgedAiFiringSummaryIdRef.current = summaryId;
    setAcknowledgedAiFiringSummaryId(summaryId);
    try {
      window.sessionStorage.setItem(
        aiFiringSummaryStorageKey(gameId),
        summaryId,
      );
    } catch {
      // Session storage is an enhancement; the in-memory acknowledgement
      // still lets this client continue the match.
    }
  }, [gameId, pendingAiFiringSummary]);
  const fighterDisplacement = useMemo(
    () => readFighterDisplacementUiState(game?.aiState),
    [game?.aiState],
  );
  const displacedFighterUnitIds = useMemo(
    () =>
      new Set(
        fighterDisplacement?.entries.map((entry) => entry.unitId) ?? [],
      ),
    [fighterDisplacement],
  );
  const fighterDisplacementCurrentOwnerId = useMemo(
    () => currentFighterDisplacementOwnerId(fighterDisplacement),
    [fighterDisplacement],
  );
  const currentDisplacedFighterToPlace = useMemo(
    () =>
      fighterDisplacement?.entries.find(
        (entry) => entry.ownerId === fighterDisplacementCurrentOwnerId,
      ) ?? null,
    [fighterDisplacement, fighterDisplacementCurrentOwnerId],
  );
  const canPlaceCurrentDisplacedFighter =
    Boolean(currentDisplacedFighterToPlace) &&
    fighterDisplacementCurrentOwnerId === myUserId;
  const [
    stagedDisplacedFighterPlacement,
    setStagedDisplacedFighterPlacement,
  ] = useState<{ unitId: number; x: number; z: number } | null>(null);
  const [
    displacedFighterConfirmPopover,
    setDisplacedFighterConfirmPopover,
  ] = useState<{ x: number; y: number } | null>(null);
  const displacedFighterPlacementDraggingRef = useRef(false);
  useEffect(() => {
    setStagedDisplacedFighterPlacement((current) =>
      currentDisplacedFighterToPlace &&
      current?.unitId === currentDisplacedFighterToPlace.unitId
        ? current
        : null,
    );
  }, [currentDisplacedFighterToPlace?.unitId]);
  useEffect(() => {
    if (!canPlaceCurrentDisplacedFighter || !stagedDisplacedFighterPlacement) {
      setDisplacedFighterConfirmPopover(null);
    }
  }, [canPlaceCurrentDisplacedFighter, stagedDisplacedFighterPlacement]);
  const { data: fleets } = useListFleets();
  const { data: shipModels } = useListShipModels({
    query: {
      queryKey: getListShipModelsQueryKey(),
      staleTime: 0,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
    },
  });
  const acceptGame = useAcceptGame();
  const declineGame = useDeclineGame();
  const deployFleet = useDeployFleet();
  const submitTurn = useSubmitTurn();
  const moveUnit = useMoveUnit();
  const activateUnit = useActivateUnit();
  const endActivation = useEndActivation();
  const fireWeapon = useFireWeapon();
  const damageControl = useDamageControl();
  const rollInitiative = useRollInitiative();
  const runAiStep = useRunAiStep();
  const chooseFirstActivator = useChooseFirstActivator();
  const passEndPhase = usePassEndPhase();
  const surrenderGame = useSurrenderGame();
  const concedeGame = useConcedeGame();
  const [, setLocation] = useLocation();
  const [confirmingSurrender, setConfirmingSurrender] = useState(false);
  const [confirmingConcede, setConfirmingConcede] = useState(false);
  const [confirmingAbandon, setConfirmingAbandon] = useState(false);
  const abandonGame = useMutation({
    mutationFn: () =>
      customFetch(`/api/games/${gameId}/abandon`, { method: "POST" }),
    onSuccess: () => {
      setConfirmingAbandon(false);
      qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
      qc.invalidateQueries({ queryKey: ["getLobby"] });
      qc.invalidateQueries({ queryKey: ["listGames"] });
      setLocation("/lobby");
    },
  });
  const placeDisplacedFighter = useMutation({
    mutationFn: ({
      unitId,
      x,
      z,
    }: {
      unitId: number;
      x: number;
      z: number;
    }) =>
      customFetch<{ unit: any | null; game: any }>(
        `/api/games/${gameId}/displaced-fighters/${unitId}/place`,
        {
          method: "POST",
          body: JSON.stringify({ x, z }),
          responseType: "json",
        },
      ),
    onSuccess: (result) => {
      qc.setQueryData<any>(getGetGameQueryKey(gameId), (old: any) => {
        if (!old) return old;
        const nextUnits = result.unit
          ? old.units.map((unit: any) =>
              unit.id === result.unit?.id ? result.unit : unit,
            )
          : old.units;
        return { ...old, game: result.game, units: nextUnits };
      });
      qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
      setStagedDisplacedFighterPlacement(null);
      setDisplacedFighterConfirmPopover(null);
      setActivationFeedback(null);
    },
    onError: (err: any) => {
      setActivationFeedback(
        `Displaced fighter placement rejected: ${cleanApiErrorMessage(err)}`,
      );
    },
  });
  const clampDisplacedFighterPlacement = useCallback(
    (entry: FighterDisplacementUiEntry, rawX: number, rawZ: number) => {
      let x = rawX;
      let z = rawZ;
      const dx = x - entry.x;
      const dz = z - entry.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 3 && dist > 1e-6) {
        x = entry.x + (dx / dist) * 3;
        z = entry.z + (dz / dist) * 3;
      }
      const radius = rulesBaseRadius({
        baseRadiusInches: entry.baseRadiusInches,
      });
      x = Math.max(
        -BOARD_W / 2 + radius,
        Math.min(BOARD_W / 2 - radius, x),
      );
      z = Math.max(
        -BOARD_D / 2 + radius,
        Math.min(BOARD_D / 2 - radius, z),
      );
      return { x: snapBoardCoord(x), z: snapBoardCoord(z) };
    },
    [],
  );
  const chooseSpecialAction = useChooseSpecialAction();
  const chooseShadowPointDefense = useChooseShadowPointDefense();
  const chooseShadowManeuverMode = useChooseShadowManeuverMode();
  const attemptTelepathicDisruption = useAttemptTelepathicDisruption();
  const launchShadowFighterDispersal = useLaunchShadowFighterDispersal();
  const chooseScoutAction = useChooseScoutAction();
  const declareScoutSupport = useMutation({
    mutationFn: ({
      unitId,
      action,
    }: {
      unitId: number;
      action: "counter-stealth" | "coord";
    }) =>
      customFetch(`/api/games/${gameId}/units/${unitId}/scout-action`, {
        method: "POST",
        body: JSON.stringify({ action }),
        responseType: "json",
      }),
    onSuccess: (res: any) => {
      if (res?.unit) mergeUpdatedUnitIntoGame(res.unit);
      setActivationFeedback(
        `${res?.action === "counter-stealth" ? "Counter-Stealth" : "Coordinate Fire"} declared. Resolve Scout Support at the start of Firing.`,
      );
      qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
    },
    onError: (err: any) => {
      setActivationFeedback(
        cleanApiErrorMessage(err, "Scout Support declaration failed"),
      );
    },
  });
  const skipScoutSupport = useMutation({
    mutationFn: () =>
      customFetch(`/api/games/${gameId}/scout-support/skip`, {
        method: "POST",
        responseType: "json",
      }),
    onSuccess: () => {
      setScoutPicking(null);
      qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
    },
    onError: (err: any) => {
      setActivationFeedback(
        cleanApiErrorMessage(err, "Scout Support skip failed"),
      );
    },
  });
  useEffect(() => {
    if (!gameId) return;
    void qc.invalidateQueries({ queryKey: getListShipModelsQueryKey() });
  }, [gameId, qc]);
  // Transient feedback for the most recent special-action attempt
  // (success/fail + dice roll). Cleared when activation ends.
  const [specialActionFeedback, setSpecialActionFeedback] = useState<{
    action: string;
    success: boolean;
    cqRoll: number | null;
    cqTotal: number | null;
    cqRequired: number | null;
  } | null>(null);
  const [damageControlFeedback, setDamageControlFeedback] = useState<{
    unitId: number;
    effectId: number;
    effectName: string;
    success: boolean;
    dcRoll: number;
    dcTotal: number;
    dcThreshold: number;
    dcPenalty: number;
    dcBonus: number;
  } | null>(null);
  const [activationFeedback, setActivationFeedback] = useState<string | null>(
    null,
  );
  const [fighterBayFeedback, setFighterBayFeedback] = useState<string | null>(
    null,
  );
  const [fighterBayBusyKey, setFighterBayBusyKey] = useState<string | null>(
    null,
  );
  const [pendingFighterLaunchPlacement, setPendingFighterLaunchPlacement] =
    useState<{
      carrierId: number;
      shipModelId: number;
      itemName: string;
      x: number;
      z: number;
      heading: number;
    } | null>(null);
  const [
    pendingShadowDispersalPlacement,
    setPendingShadowDispersalPlacement,
  ] = useState<ShadowDispersalPlacementState | null>(null);
  const [
    shadowDispersalConfirmPopover,
    setShadowDispersalConfirmPopover,
  ] = useState<{ x: number; y: number } | null>(null);
  const [fighterLaunchConfirmPopover, setFighterLaunchConfirmPopover] =
    useState<{ x: number; y: number } | null>(null);
  // Targeted Special Actions need a board target picker before sending.
  const [specialActionTargetPicking, setSpecialActionTargetPicking] =
    useState<"concentrate-fire" | "cause-confusion" | null>(null);

  // Staging / fleet yards
  const threeRef = useRef<{
    camera: THREE.Camera;
    gl: THREE.WebGLRenderer;
  } | null>(null);
  const draggedShipRef = useRef<ShipModel | null>(null);
  const boardPointerDownRef = useRef<{
    x: number;
    y: number;
    time: number;
  } | null>(null);
  const lastEmptyBoardTapRef = useRef<{
    x: number;
    y: number;
    time: number;
  } | null>(null);
  const moveConfirmInFlightRef = useRef(false);
  const [stagedUnits, setStagedUnits] = useState<StagedUnitData[]>([]);
  const currentStagedUnits = useMemo(
    () => stagedUnits.filter((u) => u.ownerId === myUserId),
    [stagedUnits, myUserId],
  );
  const [selectedStagedId, setSelectedStagedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [selectedFaction, setSelectedFaction] = useState<string>("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [tapPlacementShip, setTapPlacementShip] = useState<ShipModel | null>(
    null,
  );
  const selectedStagedUnit = useMemo(
    () =>
      selectedStagedId
        ? (currentStagedUnits.find((u) => u.id === selectedStagedId) ?? null)
        : null,
    [currentStagedUnits, selectedStagedId],
  );
  const rotateSelectedStagedUnit = useCallback(
    (delta: number) => {
      if (!selectedStagedId) return;
      setStagedUnits((prev) =>
        prev.map((u) => {
          if (u.id !== selectedStagedId || u.locked) return u;
          return { ...u, heading: (((u.heading + delta) % 360) + 360) % 360 };
        }),
      );
    },
    [selectedStagedId],
  );
  const toggleSelectedStagedLock = useCallback(() => {
    if (!selectedStagedId) return;
    setStagedUnits((prev) =>
      prev.map((u) =>
        u.id === selectedStagedId ? { ...u, locked: !u.locked } : u,
      ),
    );
  }, [selectedStagedId]);
  const removeSelectedStagedUnit = useCallback(() => {
    if (!selectedStagedId) return;
    setStagedUnits((prev) => {
      const target = prev.find((u) => u.id === selectedStagedId);
      if (target?.locked) return prev;
      return prev.filter(
        (u) =>
          u.id !== selectedStagedId &&
          u.launchedFromStagedId !== selectedStagedId,
      );
    });
    setSelectedStagedId(null);
  }, [selectedStagedId]);
  // Password an accepter types to join a private engagement (only shown when
  // the open challenge has hasPassword=true).
  const [joinPassword, setJoinPassword] = useState("");

  useEffect(() => {
    if (!selectedStagedId) return;
    const stillMine = stagedUnits.some(
      (u) => u.id === selectedStagedId && u.ownerId === myUserId,
    );
    if (!stillMine) {
      setSelectedStagedId(null);
      setDraggingId(null);
    }
  }, [selectedStagedId, stagedUnits, myUserId]);

  // Keyboard handler for placement phase
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedStagedId) return;
      if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        setStagedUnits((prev) =>
          prev.map((u) =>
            u.id === selectedStagedId ? { ...u, locked: !u.locked } : u,
          ),
        );
      } else if (
        e.key === "e" ||
        e.key === "E" ||
        e.key === "q" ||
        e.key === "Q"
      ) {
        e.preventDefault();
        // E = clockwise, Q = counter-clockwise (15° per press)
        const delta = e.key === "q" || e.key === "Q" ? 15 : -15;
        setStagedUnits((prev) =>
          prev.map((u) => {
            if (u.id !== selectedStagedId || u.locked) return u;
            return { ...u, heading: (((u.heading + delta) % 360) + 360) % 360 };
          }),
        );
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        setStagedUnits((prev) => {
          const target = prev.find((u) => u.id === selectedStagedId);
          if (target?.locked) return prev;
          return prev.filter(
            (u) =>
              u.id !== selectedStagedId &&
              u.launchedFromStagedId !== selectedStagedId,
          );
        });
        setSelectedStagedId(null);
      } else if (e.key === "Escape") {
        setSelectedStagedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedStagedId]);

  const factions = useMemo(
    () => [...new Set((shipModels ?? []).map((m) => m.faction))].sort(),
    [shipModels],
  );
  const filteredModels = useMemo(
    () =>
      selectedFaction && selectedFaction !== "__all__"
        ? (shipModels ?? []).filter((m) => m.faction === selectedFaction)
        : (shipModels ?? []),
    [shipModels, selectedFaction],
  );
  // filename → weapon arcs lookup for GameUnit3D
  const shipModelById = useMemo(() => {
    const map: Record<number, ShipModel> = {};
    for (const m of shipModels ?? []) {
      map[m.id] = m;
    }
    return map;
  }, [shipModels]);
  const shipModelByName = useMemo(() => {
    const map: Record<string, ShipModel> = {};
    for (const m of shipModels ?? []) {
      map[m.name] = m;
    }
    return map;
  }, [shipModels]);
  const getShipModelForUnit = useCallback(
    (unit: {
      shipModelId?: number | null;
      name: string;
      modelFilename: string;
    }): ShipModel | undefined => {
      return (
        (unit.shipModelId != null
          ? shipModelById[unit.shipModelId]
          : undefined) ??
        shipModelByName[unit.name] ??
        (shipModels ?? []).find((m) => m.filename === unit.modelFilename)
      );
    },
    [shipModelById, shipModelByName, shipModels],
  );
  const getWeaponsForUnit = useCallback(
    (unit: {
      shipModelId?: number | null;
      name: string;
      modelFilename: string;
    }): Weapon[] => {
      return (getShipModelForUnit(unit)?.weapons as Weapon[] | undefined) ?? [];
    },
    [getShipModelForUnit],
  );

  const [selectedUnit, setSelectedUnit] = useState<number | null>(null);
  const [cameraFocusRequest, setCameraFocusRequest] =
    useState<CameraFocusRequest | null>(null);
  const [moveTarget, setMoveTarget] = useState<{ q: number; r: number } | null>(
    null,
  );
  const [attackTarget, setAttackTarget] = useState<number | null>(null);

  // ── Firing-phase state ──
  // The weapon (id) the player has selected and is about to assign to a target.
  // While set, clicking an enemy ship resolves into a fire-weapon call.
  const [firingWeaponPicking, setFiringWeaponPicking] = useState<number | null>(
    null,
  );
  const [splitFirePlan, setSplitFirePlan] = useState<SplitFirePlan | null>(
    null,
  );
  const [splitFireCommitting, setSplitFireCommitting] = useState(false);
  const [splitFireResultModal, setSplitFireResultModal] =
    useState<SplitFireResultModalState | null>(null);
  // Optimistic fired-weapon ids, scoped to a specific (unitId, phase) so a
  // late /fire-weapon onSuccess from a previous activation can't pollute the
  // next ship's button state. Merged with the server's authoritative
  // `activeUnit.firedWeaponIds` (which survives reload) for display.
  const [pendingFired, setPendingFired] = useState<{
    unitId: number;
    ids: Set<number>;
  } | null>(null);
  // Scout coordination opt-in: when true, the NEXT fire-weapon call from
  // the active ship sends `useScoutCoordination: true`, consuming an
  // allied scout's coord token to re-roll failed AD on that weapon. The
  // server validates token availability and weapon eligibility (Beam /
  // Energy Mine / Twin Linked are rejected). Auto-clears
  // after a shot fires (or errors).
  const [useCoordOnNext, setUseCoordOnNext] = useState<boolean>(false);
  // Per-scout target-picking state for Scout Support actions. Mirrors the
  // concentrate-fire picker pattern: click an action button to enter
  // pick-mode, then click an enemy ship to declare against.
  const [scoutPicking, setScoutPicking] = useState<{
    action: "counter-stealth" | "coord";
    scoutUnitId: number;
  } | null>(null);
  const [scoutFeedback, setScoutFeedback] = useState<{
    action: string;
    scoutName: string;
    crewQuality: number;
    success: boolean;
    cqRoll: number | null;
    cqTotal: number | null;
    cqRequired: number | null;
    error?: string | null;
  } | null>(null);
  // Synchronous re-entry guard for the firing-phase target click. A single
  // user click on an enemy ship produces multiple R3F onClick events (one per
  // intersected child mesh inside the ship's <group>), so React state updates
  // in onSuccess come too late to stop duplicate fire-weapon requests. The
  // ref flips synchronously the moment we kick off a mutate() and is cleared
  // when the request settles, so the 2nd–Nth events in the same gesture bail.
  const firingInFlightRef = useRef(false);
  const scoutActionInFlightRef = useRef(false);
  const [passAllFiringPending, setPassAllFiringPending] = useState(false);
  const [passAllFiringConfirmOpen, setPassAllFiringConfirmOpen] =
    useState(false);
  const [endActivationConfirmOpen, setEndActivationConfirmOpen] =
    useState(false);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [bugReportMessage, setBugReportMessage] = useState("");
  const [bugReportBlocking, setBugReportBlocking] = useState(false);
  const [bugReportPending, setBugReportPending] = useState(false);
  const [bugReportError, setBugReportError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [chatMessage, setChatMessage] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  // Dice-roll modal payload. The reveal is staged behind explicit player
  // confirmations: pending (waiting for server) → attack-ready (press to
  // roll attack) → attack-rolling (shuffle anim) → attack-shown → if hits,
  // damage-ready → damage-rolling → damage-shown → close (confirmed). The
  // server returns the full result in one shot; the staging is purely UX.
  const [diceModal, setDiceModal] = useState<DiceModalState | null>(null);
  const [terrainHazardModal, setTerrainHazardModal] =
    useState<TerrainHazardModalState | null>(null);
  const [dogfightModal, setDogfightModal] = useState<DogfightModalState | null>(
    null,
  );
  const [dogfightImpactEffects, setDogfightImpactEffects] = useState<
    DogfightImpactEffect[]
  >([]);
  const [dogfightTargetPicking, setDogfightTargetPicking] = useState(false);
  const [selfRepairModal, setSelfRepairModal] =
    useState<SelfRepairModalState | null>(null);
  const [skippedSelfRepairPromptKeys, setSkippedSelfRepairPromptKeys] =
    useState<Set<string>>(() => new Set());
  const [aiWeaponFxReplay, setAiWeaponFxReplay] =
    useState<AiWeaponFxReplay | null>(null);
  const lastSeenAiWeaponFxKeyRef = useRef<string | null>(null);
  const lastSeenAntiFighterResultKeyRef = useRef<string | null>(null);
  const antiFighterState = useMemo(
    () => readAntiFighterUiState(game?.aiState),
    [game?.aiState],
  );
  const bugRescueNotice = useMemo(
    () => readBugRescueNotice(game?.aiState),
    [game?.aiState],
  );
  const isMyAntiFighterAllocation =
    game?.status === "active" &&
    game.phase === "movement" &&
    antiFighterState?.currentPlayerId === myUserId;
  const [antiFighterAssignments, setAntiFighterAssignments] = useState<
    Record<string, number>
  >({});
  const [antiFighterCommitting, setAntiFighterCommitting] = useState(false);
  const [antiFighterError, setAntiFighterError] = useState<string | null>(null);
  const [antiFighterResult, setAntiFighterResult] = useState<
    AntiFighterUiState["lastResult"] | null
  >(null);
  useEffect(() => {
    setAntiFighterAssignments({});
    setAntiFighterError(null);
  }, [antiFighterState?.round, antiFighterState?.currentPlayerId]);
  useEffect(() => {
    const result = readAntiFighterLastResult(game?.aiState);
    if (!result) return;
    const key = [
      result.round ?? game?.currentRound ?? "",
      result.destroyedUnitIds.join(","),
      result.attacks
        .map((attack) =>
          [
            attack.attackerId,
            attack.rolls
              .map(
                (roll) =>
                  `${roll.targetId}:${roll.total}:${roll.destroyed ? 1 : 0}`,
              )
              .join("."),
          ].join("="),
        )
        .join("|"),
    ].join("::");
    if (lastSeenAntiFighterResultKeyRef.current === null) {
      lastSeenAntiFighterResultKeyRef.current = key;
      return;
    }
    if (lastSeenAntiFighterResultKeyRef.current === key) return;
    lastSeenAntiFighterResultKeyRef.current = key;
    setAntiFighterResult(result);
  }, [game?.aiState, game?.currentRound]);
  const assignAntiFighterDie = useCallback(
    (attacker: AntiFighterUiAttacker, target: AntiFighterUiTarget) => {
      setAntiFighterAssignments((prev) => {
        const used = Object.entries(prev)
          .filter(([key]) => key.startsWith(`${attacker.attackerUnitId}:`))
          .reduce((sum, [, count]) => sum + count, 0);
        if (used >= attacker.dice) return prev;
        const key = `${attacker.attackerUnitId}:${target.targetUnitId}`;
        return { ...prev, [key]: (prev[key] ?? 0) + 1 };
      });
    },
    [],
  );
  const clearAntiFighterAssignments = useCallback(() => {
    setAntiFighterAssignments({});
  }, []);
  useEffect(() => {
    if (!game || game.opponentKind !== "ai") return;
    const aiDiagnostics = readAiDiagnostics(game.aiState);
    const latestFireDecision = [...(aiDiagnostics.decisionLog ?? [])]
      .reverse()
      .find(
        (entry) =>
          entry.step === "firing.fire-weapon" ||
          entry.step === "firing.fire-weapon-game-over",
      );
    if (!latestFireDecision?.details) {
      if (lastSeenAiWeaponFxKeyRef.current === null)
        lastSeenAiWeaponFxKeyRef.current = "";
      return;
    }

    const chosen = latestFireDecision.details.chosen;
    const result = latestFireDecision.details.result;
    if (!chosen || typeof chosen !== "object" || Array.isArray(chosen)) return;
    if (!result || typeof result !== "object" || Array.isArray(result)) return;
    const chosenRecord = chosen as Record<string, unknown>;
    const resultRecord = result as Record<string, unknown>;
    const attackerUnitId = latestFireDecision.unitId;
    const weaponId =
      typeof chosenRecord.weaponId === "number" ? chosenRecord.weaponId : null;
    const targetUnitId =
      typeof chosenRecord.targetId === "number" ? chosenRecord.targetId : null;
    if (
      typeof attackerUnitId !== "number" ||
      weaponId == null ||
      targetUnitId == null
    )
      return;

    const key = [
      latestFireDecision.at ?? "",
      latestFireDecision.step ?? "",
      attackerUnitId,
      weaponId,
      targetUnitId,
      resultRecord.hits ?? "",
      resultRecord.damage ?? "",
      resultRecord.crew ?? "",
    ].join("|");

    if (lastSeenAiWeaponFxKeyRef.current === null) {
      lastSeenAiWeaponFxKeyRef.current = key;
      return;
    }
    if (lastSeenAiWeaponFxKeyRef.current === key) return;
    lastSeenAiWeaponFxKeyRef.current = key;

    const hits = typeof resultRecord.hits === "number" ? resultRecord.hits : 0;
    setAiWeaponFxReplay({ key, attackerUnitId, targetUnitId, weaponId, hits });
    const timeout = window.setTimeout(() => {
      setAiWeaponFxReplay((current) => (current?.key === key ? null : current));
    }, 5200);
    return () => window.clearTimeout(timeout);
  }, [game?.aiState, game?.opponentKind]);

  const commitAntiFighterAllocations = useCallback(async () => {
    if (
      !antiFighterState ||
      antiFighterCommitting ||
      game?.phase !== "movement"
    )
      return;
    setAntiFighterCommitting(true);
    setAntiFighterError(null);
    const allocations = Object.entries(antiFighterAssignments)
      .map(([key, dice]) => {
        const [attackerUnitId, targetUnitId] = key.split(":").map(Number);
        return { attackerUnitId, targetUnitId, dice };
      })
      .filter(
        (row) =>
          row.dice > 0 &&
          Number.isFinite(row.attackerUnitId) &&
          Number.isFinite(row.targetUnitId),
      );
    try {
      const updated = await customFetch<{ aiState?: unknown }>(
        `/api/games/${gameId}/anti-fighter/commit`,
        {
          method: "POST",
          body: JSON.stringify({ allocations }),
          responseType: "json",
        },
      );
      setAntiFighterResult(readAntiFighterLastResult(updated.aiState));
      setAntiFighterAssignments({});
      await qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
    } catch (err) {
      setAntiFighterError(
        cleanApiErrorMessage(err, "Anti-Fighter allocation failed"),
      );
    } finally {
      setAntiFighterCommitting(false);
    }
  }, [
    antiFighterAssignments,
    antiFighterCommitting,
    antiFighterState,
    game?.phase,
    gameId,
    qc,
  ]);
  // Keep the polling-pause flag in sync with the dice modal: while the staged
  // dice reveal is open we must not let a background refetch replace game state
  // mid-sequence. Pausing the interval alone isn't enough — a poll already in
  // flight when the modal opens would still resolve and clobber the cache mid-
  // reveal, so we also cancel any outstanding game fetch on open. Re-enables
  // polling as soon as the modal closes.
  useEffect(() => {
    const open =
      diceModal !== null ||
      dogfightModal !== null ||
      selfRepairModal !== null ||
      terrainHazardModal !== null ||
      pendingAiFiringSummary !== null;
    pausePollingRef.current = open;
    if (open) {
      void qc
        .cancelQueries({ queryKey: getGetGameQueryKey(gameId) })
        .catch(() => {
          // Cancelling an in-flight poll intentionally aborts its request. Some
          // dev runtimes surface that abort as an unhandled error unless it is
          // consumed here.
        });
    }
  }, [
    diceModal,
    dogfightModal,
    selfRepairModal,
    terrainHazardModal,
    pendingAiFiringSummary,
    qc,
    gameId,
  ]);
  const [turnMoves, setTurnMoves] = useState<
    Array<{
      unitId: number;
      toHexQ: number;
      toHexR: number;
      newHeading: number;
    }>
  >([]);
  const [turnAttacks, setTurnAttacks] = useState<
    Array<{ attackerUnitId: number; targetUnitId: number }>
  >([]);
  const [movePlan, setMovePlan] = useState<MovePlan>(null);
  const [movementGesture, setMovementGesture] = useState<MovementGesture>(null);
  const [moveConfirmPopover, setMoveConfirmPopover] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [endPhaseLaunchPrompt, setEndPhaseLaunchPrompt] = useState<{
    key: string;
    mode: "prompt" | "highlight" | "skipped";
  } | null>(null);
  const commitStagedShot = useCallback(
    (shot: DiceModalState) => {
      if (firingInFlightRef.current) return;
      const firedWeaponId = shot.weapon.id;
      const firingUnitId = shot.attackerUnitId;
      firingInFlightRef.current = true;
      setPendingFired((prev) => {
        if (prev && prev.unitId !== firingUnitId) {
          return { unitId: firingUnitId, ids: new Set([firedWeaponId]) };
        }
        const next = new Set(prev?.ids ?? []);
        next.add(firedWeaponId);
        return { unitId: firingUnitId, ids: next };
      });
      setFiringWeaponPicking(null);
      setDiceModal((m) =>
        m &&
        m.attackerUnitId === firingUnitId &&
        m.weapon.id === firedWeaponId &&
        m.targetId === shot.targetId
          ? { ...m, phase: "pending", confirmingClose: false }
          : m,
      );
      fireWeapon.mutate(
        {
          gameId,
          unitId: firingUnitId,
          data: {
            weaponId: firedWeaponId,
            targetUnitId: shot.targetId,
            ...weaponFingerprint(shot.weapon),
            useScoutCoordination: shot.useScoutCoordination || undefined,
          },
        },
        {
          onSuccess: (res) => {
            firingInFlightRef.current = false;
            setUseCoordOnNext(false);
            // Do NOT invalidate the game query here - that would refresh the
            // board (target HP, shields, destroyed flag) BEFORE the player has
            // revealed the dice. The modal close performs the refresh.
            setDiceModal((m) =>
              m &&
              m.attackerUnitId === firingUnitId &&
              m.weapon.id === firedWeaponId &&
              m.targetId === shot.targetId
                ? { ...m, phase: "attack-rolling", result: res }
                : m,
            );
            setTimeout(() => {
              setDiceModal((m) =>
                m &&
                m.attackerUnitId === firingUnitId &&
                m.weapon.id === firedWeaponId &&
                m.targetId === shot.targetId &&
                m.phase === "attack-rolling"
                  ? { ...m, phase: "attack-shown" }
                  : m,
              );
            }, 700);
          },
          onError: (err: any) => {
            firingInFlightRef.current = false;
            const message = cleanApiErrorMessage(err, "Shot failed");
            setPendingFired((prev) => {
              if (!prev || prev.unitId !== firingUnitId) return prev;
              const next = new Set(prev.ids);
              next.delete(firedWeaponId);
              return next.size === 0
                ? null
                : { unitId: firingUnitId, ids: next };
            });
            setActivationFeedback(message);
            setDiceModal((m) =>
              m &&
              m.attackerUnitId === firingUnitId &&
              m.weapon.id === firedWeaponId &&
              m.targetId === shot.targetId
                ? { ...m, phase: "error", error: message }
                : m,
            );
          },
        },
      );
    },
    [fireWeapon, gameId],
  );

  const commitSplitFire = useCallback(
    async (plan: SplitFirePlan, secondTarget: GameUnit) => {
      if (firingInFlightRef.current || splitFireCommitting) return;
      if (plan.firstTargetId == null || !plan.firstTargetName) return;
      if (plan.firstTargetId === secondTarget.id) {
        setActivationFeedback("Split fire requires two different targets.");
        return;
      }

      const firedWeaponId = plan.weapon.id;
      const firingUnitId = plan.attackerUnitId;
      const firstDice = clampNumber(plan.firstDice, 1, plan.totalDice - 1);
      const secondDice = plan.totalDice - firstDice;

      firingInFlightRef.current = true;
      setSplitFireCommitting(true);
      setPendingFired((prev) => {
        if (prev && prev.unitId !== firingUnitId) {
          return { unitId: firingUnitId, ids: new Set([firedWeaponId]) };
        }
        const next = new Set(prev?.ids ?? []);
        next.add(firedWeaponId);
        return { unitId: firingUnitId, ids: next };
      });

      try {
        const firstResult = await customFetch<FireWeaponResult>(
          `/api/games/${gameId}/units/${firingUnitId}/fire-weapon`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              weaponId: firedWeaponId,
              targetUnitId: plan.firstTargetId,
              ...weaponFingerprint(plan.weapon),
              splitFire: { index: 0, total: 2, attackDice: firstDice },
            }),
          },
        );
        const secondResult = await customFetch<FireWeaponResult>(
          `/api/games/${gameId}/units/${firingUnitId}/fire-weapon`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              weaponId: firedWeaponId,
              targetUnitId: secondTarget.id,
              ...weaponFingerprint(plan.weapon),
              splitFire: { index: 1, total: 2, attackDice: secondDice },
            }),
          },
        );

        setUseCoordOnNext(false);
        setFiringWeaponPicking(null);
        setSplitFirePlan(null);
        setSplitFireResultModal({
          weapon: plan.weapon,
          attackerUnitId: firingUnitId,
          allocations: [
            {
              targetId: plan.firstTargetId,
              targetName: plan.firstTargetName,
              attackDice: firstDice,
              result: firstResult,
            },
            {
              targetId: secondTarget.id,
              targetName: secondTarget.name,
              attackDice: secondDice,
              result: secondResult,
            },
          ],
        });
        setActivationFeedback(
          `Split fire resolved: ${firstDice}AD into ${plan.firstTargetName}, ${secondDice}AD into ${secondTarget.name}.`,
        );
      } catch (err) {
        const message = cleanApiErrorMessage(err, "Split fire failed");
        setActivationFeedback(message);
        setPendingFired((prev) => {
          if (!prev || prev.unitId !== firingUnitId) return prev;
          const next = new Set(prev.ids);
          next.delete(firedWeaponId);
          return next.size === 0 ? null : { unitId: firingUnitId, ids: next };
        });
      } finally {
        firingInFlightRef.current = false;
        setSplitFireCommitting(false);
        qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
      }
    },
    [gameId, qc, splitFireCommitting],
  );

  useEffect(() => {
    setMovePlan(null);
    setMovementGesture(null);
  }, [selectedUnit]);

  // Per-unit movement-phase ledger. Each ship gets ONE activation per round
  // with `speed` inches and `turns` rotations to spend; the ledger is wiped
  // when the round rolls over.
  // `distSinceLastTurn` is inches moved since the most recent committed turn
  // (or since the start of the activation, if no turn yet). It governs the
  // turn-eligibility gate: first turn requires ≥ half base speed moved;
  // each follow-up turn requires ≥ 2" moved since the previous turn.
  const [phaseLedger, setPhaseLedger] = useState<
    Record<number, MovementLedger>
  >({});
  const currentRoundNumber = gameData?.game?.currentRound ?? 1;
  useEffect(() => {
    setPhaseLedger({});
  }, [currentRoundNumber]);

  // Fleet Yards: optional pre-built fleet to deploy from. Empty string =
  // direct drop-in mode (no fleet — server materializes an ephemeral one
  // from the staged ships' shipModelIds). We do NOT auto-pick; the
  // player gets to choose between "Quick-load a saved fleet" and
  // "Just drag what I want onto the board."
  const [yardsFleetId, setYardsFleetId] = useState<string>("");
  const autoStagedFleetIdRef = useRef<string | null>(null);
  const { data: yardsFleetShips } = useListFleetShips(
    parseInt(yardsFleetId || "0"),
    {
      query: {
        queryKey: getListFleetShipsQueryKey(parseInt(yardsFleetId || "0")),
        enabled: !!yardsFleetId,
      },
    },
  );

  const [autoAiRunning, setAutoAiRunning] = useState(false);
  const [aiAutoRunEnabled, setAiAutoRunEnabled] = useState(false);
  const aiAutoRunEnabledRef = useRef(false);
  const [autoAiError, setAutoAiError] = useState<string | null>(null);
  useEffect(() => {
    aiAutoRunEnabledRef.current = aiAutoRunEnabled;
  }, [aiAutoRunEnabled]);
  const runAiUntilHuman = useCallback(
    async (respectToggle = false) => {
      if (!game || autoAiRunning || isAdminObserver) return;
      setAutoAiRunning(true);
      setAutoAiError(null);
      let lastSignature = aiProgressSignature(game);
      try {
        for (let step = 0; step < AI_AUTO_STEP_LIMIT; step++) {
          if (respectToggle && !aiAutoRunEnabledRef.current) break;
          if (
            step === 0 &&
            shouldStopAiAutoRun(
              game,
              myUserId,
              acknowledgedAiFiringSummaryIdRef.current,
            )
          )
            break;
          const next = await runAiStep.mutateAsync({ gameId });
          await qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
          const nextSignature = aiProgressSignature(next);
          if (nextSignature === lastSignature) break;
          lastSignature = nextSignature;
          if (
            shouldStopAiAutoRun(
              next,
              myUserId,
              acknowledgedAiFiringSummaryIdRef.current,
            )
          )
            break;
          if (respectToggle && !aiAutoRunEnabledRef.current) break;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      } catch (err) {
        setAutoAiError((err as Error).message || "AI auto-run failed");
        setAiAutoRunEnabled(false);
      } finally {
        setAutoAiRunning(false);
      }
    },
    [autoAiRunning, game, gameId, isAdminObserver, myUserId, qc, runAiStep],
  );
  useEffect(() => {
    if (!game || isAdminObserver || game.opponentKind !== "ai" || game.status !== "active") {
      setAiAutoRunEnabled(false);
      return;
    }
    if (!aiAutoRunEnabled || autoAiRunning || runAiStep.isPending) return;
    if (
      shouldStopAiAutoRun(
        game,
        myUserId,
        acknowledgedAiFiringSummaryIdRef.current,
      )
    )
      return;
    void runAiUntilHuman(true);
  }, [
    aiAutoRunEnabled,
    autoAiRunning,
    game,
    isAdminObserver,
    myUserId,
    acknowledgedAiFiringSummaryId,
    runAiStep.isPending,
    runAiUntilHuman,
  ]);
  type BoardUnit = (typeof units)[number];
  const isFighterUnit = useCallback(
    (unit: BoardUnit): boolean => {
      return (
        shipModelHasFighterTrait(getShipModelForUnit(unit)) ||
        shipModelHasFighterTrait({
          name: unit.name,
          filename: unit.modelFilename,
        })
      );
    },
    [getShipModelForUnit],
  );
  const unitsWithFighterFlags = useMemo(
    () =>
      units
        .filter((unit) => !displacedFighterUnitIds.has(unit.id))
        .map((unit) => ({ ...unit, isFighter: isFighterUnit(unit) })),
    [displacedFighterUnitIds, isFighterUnit, units],
  );
  const pendingShadowDispersalCarrier = useMemo(
    () =>
      pendingShadowDispersalPlacement
        ? units.find(
            (unit) =>
              unit.id === pendingShadowDispersalPlacement.carrierId,
          ) ?? null
        : null,
    [pendingShadowDispersalPlacement, units],
  );
  const pendingShadowDispersalFighterModel =
    pendingShadowDispersalPlacement?.shipModelId != null
      ? (shipModelById[pendingShadowDispersalPlacement.shipModelId] ?? null)
      : null;
  const activeShadowDispersalPlacement =
    pendingShadowDispersalPlacement?.placements[
      pendingShadowDispersalPlacement.activeIndex
    ] ?? null;
  const shadowDispersalPlacementValidation =
    useMemo<ShadowDispersalPlacementValidation>(() => {
    if (
      !pendingShadowDispersalPlacement ||
      !pendingShadowDispersalCarrier ||
      !pendingShadowDispersalFighterModel ||
      !activeShadowDispersalPlacement
    ) {
      return {
        legal: false,
        shortReason: "Unavailable",
        detail: "Fighter placement is unavailable.",
      };
    }
    const fighterRadius = rulesBaseRadius(
      pendingShadowDispersalFighterModel,
    );
    const candidate: UiBaseFootprint = {
      id: `shadow-dispersal-${pendingShadowDispersalPlacement.activeIndex}`,
      x: activeShadowDispersalPlacement.hexQ,
      z: activeShadowDispersalPlacement.hexR,
      isFighter: true,
      baseRadiusInches: fighterRadius,
    };
    if (
      candidate.x < -BOARD_W / 2 + fighterRadius ||
      candidate.x > BOARD_W / 2 - fighterRadius ||
      candidate.z < -BOARD_D / 2 + fighterRadius ||
      candidate.z > BOARD_D / 2 - fighterRadius
    ) {
      return {
        legal: false,
        shortReason: "Outside board",
        detail: "The full fighter base must remain inside the board.",
      };
    }
    const carrierFootprint: UiBaseFootprint = {
      id: pendingShadowDispersalCarrier.id,
      x: pendingShadowDispersalCarrier.hexQ,
      z: pendingShadowDispersalCarrier.hexR,
      isFighter: false,
      baseRadiusInches: pendingShadowDispersalCarrier.baseRadiusInches,
    };
    if (
      !isTargetInWeaponArc(
        pendingShadowDispersalCarrier,
        {
          hexQ: candidate.x,
          hexR: candidate.z,
        },
        "Forward",
      )
    ) {
      return {
        legal: false,
        shortReason: "Outside forward arc",
        detail:
          "Fighter Dispersal Tube is a Forward-arc system; place the flight ahead of the Shadow vessel.",
      };
    }
    const distanceFromCarrier = uiBaseFootprintEdgeDistance(
      candidate,
      carrierFootprint,
    );
    if (distanceFromCarrier > 30 + SHADOW_DISPERSAL_DISTANCE_EPSILON) {
      return {
        legal: false,
        shortReason: "Beyond 30 inches",
        detail: `${distanceFromCarrier.toFixed(1)} inches from the Shadow vessel; maximum range is 30 inches.`,
      };
    }
    const overlappingUnit = unitsWithFighterFlags.find(
      (other) =>
        !other.isDestroyed &&
        uiBaseFootprintsIllegallyOverlap(candidate, {
          id: other.id,
          x: other.hexQ,
          z: other.hexR,
          isFighter: other.isFighter,
          baseRadiusInches: other.baseRadiusInches,
        }),
    );
    if (overlappingUnit) {
      return {
        legal: false,
        shortReason: "Base overlap",
        detail: `The fighter base overlaps ${overlappingUnit.name}.`,
      };
    }
    const confirmedPlacements =
      pendingShadowDispersalPlacement.placements.slice(
        0,
        pendingShadowDispersalPlacement.activeIndex,
      );
    const confirmedFootprints = confirmedPlacements.map((placement, index) => {
      const confirmed: UiBaseFootprint = {
        id: `shadow-dispersal-confirmed-${index}`,
        x: placement.hexQ,
        z: placement.hexR,
        isFighter: true,
        baseRadiusInches: fighterRadius,
      };
      return confirmed;
    });
    const overlappingFlightIndex = confirmedFootprints.findIndex((confirmed) =>
      uiBaseFootprintsIllegallyOverlap(candidate, confirmed),
    );
    if (overlappingFlightIndex >= 0) {
      return {
        legal: false,
        shortReason: `Overlaps flight ${overlappingFlightIndex + 1}`,
        detail: `The fighter base overlaps confirmed flight ${overlappingFlightIndex + 1}.`,
      };
    }
    const leadFlight = confirmedFootprints[0];
    if (
      leadFlight &&
      uiBaseFootprintEdgeDistance(candidate, leadFlight) >
        SHADOW_DISPERSAL_COHESION_INCHES +
          SHADOW_DISPERSAL_DISTANCE_EPSILON
    ) {
      const cohesionDistance = uiBaseFootprintEdgeDistance(
        candidate,
        leadFlight,
      );
      return {
        legal: false,
        shortReason: "Too far from lead",
        detail: `${cohesionDistance.toFixed(1)} inches from the lead flight; every later flight must be within ${SHADOW_DISPERSAL_COHESION_INCHES} inches of Flight 1.`,
      };
    }
    return {
      legal: true,
      shortReason: "Legal",
      detail:
        confirmedFootprints.length > 0
          ? `${distanceFromCarrier.toFixed(1)} inches from the vessel; clear of bases and within ${SHADOW_DISPERSAL_COHESION_INCHES} inches of the lead flight.`
          : `${distanceFromCarrier.toFixed(1)} inches from the vessel and clear of other bases.`,
    };
  }, [
    activeShadowDispersalPlacement,
    pendingShadowDispersalCarrier,
    pendingShadowDispersalFighterModel,
    pendingShadowDispersalPlacement,
    unitsWithFighterFlags,
  ]);
  const shadowDispersalPlacementLegal =
    shadowDispersalPlacementValidation.legal;
  const shadowDispersalGuideRadius = useMemo(() => {
    if (
      !pendingShadowDispersalCarrier ||
      !pendingShadowDispersalFighterModel
    ) {
      return 30;
    }
    return (
      30 +
      rulesBaseRadius(pendingShadowDispersalCarrier) +
      rulesBaseRadius(pendingShadowDispersalFighterModel)
    );
  }, [
    pendingShadowDispersalCarrier,
    pendingShadowDispersalFighterModel,
  ]);
  const stageActiveShadowDispersalPlacement = useCallback(
    (clientX: number, clientY: number): boolean => {
      if (
        !pendingShadowDispersalPlacement ||
        !pendingShadowDispersalCarrier ||
        !pendingShadowDispersalFighterModel
      ) {
        return false;
      }
      const point = screenToBoard(clientX, clientY, threeRef);
      if (!point) return false;
      const fighterRadius = rulesBaseRadius(
        pendingShadowDispersalFighterModel,
      );
      let x = Math.max(
        -BOARD_W / 2 + fighterRadius,
        Math.min(BOARD_W / 2 - fighterRadius, point[0]),
      );
      let z = Math.max(
        -BOARD_D / 2 + fighterRadius,
        Math.min(BOARD_D / 2 - fighterRadius, point[1]),
      );
      const dx = x - pendingShadowDispersalCarrier.hexQ;
      const dz = z - pendingShadowDispersalCarrier.hexR;
      const centerLimit =
        30 +
        rulesBaseRadius(pendingShadowDispersalCarrier) +
        fighterRadius;
      const centerDistance = Math.hypot(dx, dz);
      if (centerDistance > centerLimit && centerDistance > 1e-6) {
        x =
          pendingShadowDispersalCarrier.hexQ +
          (dx / centerDistance) * centerLimit;
        z =
          pendingShadowDispersalCarrier.hexR +
          (dz / centerDistance) * centerLimit;
      }
      x = Math.max(
        -BOARD_W / 2 + fighterRadius,
        Math.min(BOARD_W / 2 - fighterRadius, snapBoardCoord(x)),
      );
      z = Math.max(
        -BOARD_D / 2 + fighterRadius,
        Math.min(BOARD_D / 2 - fighterRadius, snapBoardCoord(z)),
      );
      setPendingShadowDispersalPlacement((current) => {
        if (!current) return current;
        const placements = current.placements.map((placement, index) =>
          index === current.activeIndex
            ? { ...placement, hexQ: x, hexR: z }
            : placement,
        );
        return { ...current, placements };
      });
      setShadowDispersalConfirmPopover(null);
      return true;
    },
    [
      pendingShadowDispersalCarrier,
      pendingShadowDispersalFighterModel,
      pendingShadowDispersalPlacement,
    ],
  );
  const currentDisplacedFighterUnit = useMemo(
    () =>
      currentDisplacedFighterToPlace
        ? units.find((unit) => unit.id === currentDisplacedFighterToPlace.unitId) ??
          null
        : null,
    [currentDisplacedFighterToPlace, units],
  );
  const resolveDisplacedFighterPlacementCandidate = useCallback(
    (
      entry: FighterDisplacementUiEntry,
      rawX: number,
      rawZ: number,
      previous?: { x: number; z: number } | null,
    ) => {
      let candidate = clampDisplacedFighterPlacement(entry, rawX, rawZ);
      const candidateRadius = rulesBaseRadius({
        baseRadiusInches: entry.baseRadiusInches,
      });
      const blockers = unitsWithFighterFlags
        .filter((other) => !other.isDestroyed)
        .map(
          (other): UiBaseFootprint => ({
            id: other.id,
            x: other.hexQ,
            z: other.hexR,
            isFighter: other.isFighter,
            baseRadiusInches: other.baseRadiusInches,
          }),
        );

      for (let pass = 0; pass < 8; pass += 1) {
        const blocker = blockers.find((other) =>
          uiBaseFootprintsIllegallyOverlap(
            {
              id: entry.unitId,
              x: candidate.x,
              z: candidate.z,
              isFighter: true,
              baseRadiusInches: entry.baseRadiusInches,
            },
            other,
          ),
        );
        if (!blocker) break;

        let dx = candidate.x - blocker.x;
        let dz = candidate.z - blocker.z;
        let distance = Math.hypot(dx, dz);
        if (distance < 1e-6 && previous) {
          dx = previous.x - blocker.x;
          dz = previous.z - blocker.z;
          distance = Math.hypot(dx, dz);
        }
        if (distance < 1e-6) {
          dx = rawX - blocker.x;
          dz = rawZ - blocker.z;
          distance = Math.hypot(dx, dz);
        }
        if (distance < 1e-6) {
          dx = entry.x - blocker.x;
          dz = entry.z - blocker.z;
          distance = Math.hypot(dx, dz);
        }
        if (distance < 1e-6) {
          dx = 1;
          dz = 0;
          distance = 1;
        }

        const contactDistance =
          candidateRadius +
          rulesBaseRadius({ baseRadiusInches: blocker.baseRadiusInches });
        candidate = clampDisplacedFighterPlacement(
          entry,
          blocker.x + (dx / distance) * contactDistance,
          blocker.z + (dz / distance) * contactDistance,
        );
      }

      const legal = !blockers.some((other) =>
        uiBaseFootprintsIllegallyOverlap(
          {
            id: entry.unitId,
            x: candidate.x,
            z: candidate.z,
            isFighter: true,
            baseRadiusInches: entry.baseRadiusInches,
          },
          other,
        ),
      );
      return { ...candidate, legal };
    },
    [clampDisplacedFighterPlacement, unitsWithFighterFlags],
  );
  const stageDisplacedFighterPlacementAtPointer = useCallback(
    (clientX: number, clientY: number) => {
      if (!currentDisplacedFighterToPlace) return null;
      const pos = screenToBoard(clientX, clientY, threeRef);
      if (!pos) return null;
      const [rawX, rawZ] = pos;
      const next = resolveDisplacedFighterPlacementCandidate(
        currentDisplacedFighterToPlace,
        rawX,
        rawZ,
        stagedDisplacedFighterPlacement,
      );
      setStagedDisplacedFighterPlacement({
        unitId: currentDisplacedFighterToPlace.unitId,
        x: next.x,
        z: next.z,
      });
      setDisplacedFighterConfirmPopover(null);
      return { x: next.x, z: next.z };
    },
    [
      currentDisplacedFighterToPlace,
      resolveDisplacedFighterPlacementCandidate,
      stagedDisplacedFighterPlacement,
    ],
  );
  const showDisplacedFighterConfirmPopoverAtBoardPoint = useCallback(
    (x: number, z: number, container: HTMLElement) => {
      const width = 92;
      const height = 48;
      const projected = boardToScreen(x, z, threeRef);
      const left = Math.max(
        8,
        Math.min(
          container.clientWidth - width - 8,
          (projected?.x ?? container.clientWidth / 2) + 18,
        ),
      );
      const top = Math.max(
        8,
        Math.min(
          container.clientHeight - height - 8,
          (projected?.y ?? container.clientHeight / 2) - height / 2,
        ),
      );
      setMoveConfirmPopover(null);
      setFighterLaunchConfirmPopover(null);
      setDisplacedFighterConfirmPopover({ x: left, y: top });
    },
    [],
  );
  const enemyFighterContactsForUnit = useCallback(
    (
      unit: BoardUnit & { isFighter?: boolean },
      position?: { hexQ: number; hexR: number },
    ) => {
      const fighter = unit.isFighter ?? isFighterUnit(unit);
      if (!fighter) return [] as Array<BoardUnit & { isFighter: boolean }>;
      const probe = {
        ...unit,
        hexQ: position?.hexQ ?? unit.hexQ,
        hexR: position?.hexR ?? unit.hexR,
      };
      return unitsWithFighterFlags.filter(
        (other) =>
          other.id !== unit.id &&
          !other.isDestroyed &&
          other.isFighter &&
          other.ownerId !== unit.ownerId &&
          uiBasesInContact(probe, other),
      );
    },
    [isFighterUnit, unitsWithFighterFlags],
  );
  const dogfightingFighterUnitIds = useMemo(() => {
    const ids = new Set<number>();
    for (const unit of unitsWithFighterFlags) {
      if (unit.isDestroyed || !unit.isFighter) continue;
      if (ids.has(unit.id)) continue;
      const contacts = enemyFighterContactsForUnit(unit);
      if (contacts.length === 0) continue;
      ids.add(unit.id);
      for (const contact of contacts) ids.add(contact.id);
    }
    return ids;
  }, [enemyFighterContactsForUnit, unitsWithFighterFlags]);
  const stagedDisplacedFighterPlacementLegal = useMemo(() => {
    if (!currentDisplacedFighterToPlace || !stagedDisplacedFighterPlacement) {
      return false;
    }
    const candidate: UiBaseFootprint = {
      id: currentDisplacedFighterToPlace.unitId,
      x: stagedDisplacedFighterPlacement.x,
      z: stagedDisplacedFighterPlacement.z,
      isFighter: true,
      baseRadiusInches: currentDisplacedFighterToPlace.baseRadiusInches,
    };
    const radius = rulesBaseRadius(candidate);
    if (
      candidate.x < -BOARD_W / 2 + radius ||
      candidate.x > BOARD_W / 2 - radius ||
      candidate.z < -BOARD_D / 2 + radius ||
      candidate.z > BOARD_D / 2 - radius
    ) {
      return false;
    }
    return !unitsWithFighterFlags.some((other) => {
      if (other.isDestroyed) return false;
      return uiBaseFootprintsIllegallyOverlap(candidate, {
        id: other.id,
        x: other.hexQ,
        z: other.hexR,
        isFighter: other.isFighter,
        baseRadiusInches: other.baseRadiusInches,
      });
    });
  }, [
    currentDisplacedFighterToPlace,
    stagedDisplacedFighterPlacement,
    unitsWithFighterFlags,
  ]);
  const stagedDisplacedFighterDogfightContact = useMemo(() => {
    if (
      !currentDisplacedFighterToPlace ||
      !stagedDisplacedFighterPlacement ||
      !stagedDisplacedFighterPlacementLegal
    ) {
      return false;
    }
    const probe = {
      hexQ: stagedDisplacedFighterPlacement.x,
      hexR: stagedDisplacedFighterPlacement.z,
      baseRadiusInches: currentDisplacedFighterToPlace.baseRadiusInches,
    };
    return unitsWithFighterFlags.some(
      (other) =>
        !other.isDestroyed &&
        other.isFighter &&
        other.ownerId !== currentDisplacedFighterToPlace.ownerId &&
        uiBasesInContact(probe, other),
    );
  }, [
    currentDisplacedFighterToPlace,
    stagedDisplacedFighterPlacement,
    stagedDisplacedFighterPlacementLegal,
    unitsWithFighterFlags,
  ]);
  const confirmDisplacedFighterPlacement = useCallback(() => {
    if (
      !canPlaceCurrentDisplacedFighter ||
      !currentDisplacedFighterToPlace ||
      !stagedDisplacedFighterPlacement ||
      !stagedDisplacedFighterPlacementLegal ||
      placeDisplacedFighter.isPending
    ) {
      if (stagedDisplacedFighterPlacement && !stagedDisplacedFighterPlacementLegal) {
        setActivationFeedback(
          "Displaced fighter placement overlaps another base. Drag to a legal position, then confirm.",
        );
      }
      return;
    }
    placeDisplacedFighter.mutate({
      unitId: currentDisplacedFighterToPlace.unitId,
      x: stagedDisplacedFighterPlacement.x,
      z: stagedDisplacedFighterPlacement.z,
    });
  }, [
    canPlaceCurrentDisplacedFighter,
    currentDisplacedFighterToPlace,
    placeDisplacedFighter,
    stagedDisplacedFighterPlacement,
    stagedDisplacedFighterPlacementLegal,
  ]);
  const cancelDisplacedFighterPlacement = useCallback(() => {
    displacedFighterPlacementDraggingRef.current = false;
    setStagedDisplacedFighterPlacement(null);
    setDisplacedFighterConfirmPopover(null);
  }, []);
  const serverMovementLedgerByUnit = useMemo<
    Record<number, MovementLedger>
  >(() => {
    const map: Record<number, MovementLedger> = {};
    for (const unit of units as RuntimeMovementUnit[]) {
      const distance = unit.inchesMovedThisActivation ?? 0;
      map[unit.id] = {
        distance,
        turns: unit.turnsMadeThisActivation ?? 0,
        distSinceLastTurn: unit.distanceSinceLastTurnThisActivation ?? distance,
      };
    }
    return map;
  }, [units]);
  const getLedger = useCallback(
    (uid: number): MovementLedger => {
      const local = phaseLedger[uid];
      const server = serverMovementLedgerByUnit[uid];
      if (!local) return server ?? EMPTY_MOVEMENT_LEDGER;
      if (!server) return local;

      // The local ledger is an optimistic overlay, while the server ledger is
      // authoritative once a /move response or poll lands. Never let a stale
      // local zero/partial record mask server movement already spent; doing so
      // makes the ghost/vector preview overrun the real remaining allowance.
      const distance = Math.max(local.distance, server.distance);
      const turns = Math.max(local.turns, server.turns);
      let distSinceLastTurn: number;
      if (local.turns > server.turns) {
        distSinceLastTurn = local.distSinceLastTurn;
      } else if (server.turns > local.turns) {
        distSinceLastTurn = server.distSinceLastTurn;
      } else {
        distSinceLastTurn = Math.max(
          local.distSinceLastTurn,
          server.distSinceLastTurn,
        );
      }

      return { distance, turns, distSinceLastTurn };
    },
    [phaseLedger, serverMovementLedgerByUnit],
  );
  // Surrender eligibility: every one of MY ships is at ≤0 hull OR ≤0 crew
  // (or destroyed). A ship with maxCrewPoints=0 (legacy unit without a crew
  // pool) shouldn't gate surrender on its non-existent crew, so we only
  // count crew when the ship has a crew pool to begin with.
  const myUnits = units.filter((u) => u.ownerId === myUserId);
  const allMyShipsCombatInert =
    myUnits.length > 0 &&
    myUnits.every(
      (u) =>
        u.isDestroyed ||
        u.hullPoints <= 0 ||
        ((u.maxCrewPoints ?? 0) > 0 && (u.crewPoints ?? 0) <= 0),
    );

  // Deployment-zone clamp for staged ship placement during the deploy phase.
  // Existing games without structured config fall back to the classic
  // short-edge strips; new scenario presets can use asymmetric rectangles.
  const deploymentDepth = game?.deploymentDepth ?? 12;
  const deploymentConfig = useMemo(
    () => normalizeDeploymentConfig(game?.deploymentConfig, deploymentDepth),
    [game?.deploymentConfig, deploymentDepth],
  );
  const mySide: DeploymentSide | null = !game
    ? null
    : myUserId === game.challengerId
      ? "challenger"
      : myUserId === game.opponentId
        ? "opponent"
        : null;
  const [manualTerrainChoice, setManualTerrainChoice] =
    useState<ManualTerrainChoice>("asteroid-light");
  const [manualTerrainRotationDeg, setManualTerrainRotationDeg] =
    useState(0);
  const [manualTerrainPreviewPoint, setManualTerrainPreviewPoint] =
    useState<{ x: number; z: number } | null>(null);
  const manualTerrainComplete = Boolean(
    manualTerrainPlacement?.enabled &&
      terrainFields.length >= manualTerrainPlacement.totalCount,
  );
  const manualTerrainPending = Boolean(
    game?.status === "deploying" &&
      manualTerrainPlacement?.enabled &&
      !manualTerrainComplete,
  );
  const canPlaceManualTerrain = Boolean(
    manualTerrainPending && manualTerrainPlacement?.nextPlayerId === myUserId,
  );
  const manualTerrainOrdinal = terrainFields.length + 1;
  const manualTerrainChoiceOptions = useMemo<ManualTerrainChoice[]>(() => {
    if (manualTerrainPlacement?.terrainSelection === "gas-clouds") {
      return ["gas-cloud"];
    }
    if (manualTerrainPlacement?.terrainSelection === "asteroid-fields") {
      return ["asteroid-light", "asteroid-medium"];
    }
    if (manualTerrainPlacement?.terrainSelection === "mixed-terrain") {
      return ["asteroid-light", "asteroid-medium", "gas-cloud"];
    }
    return ["asteroid-light"];
  }, [manualTerrainPlacement?.terrainSelection]);
  const activeManualTerrainChoice = manualTerrainChoiceOptions.includes(manualTerrainChoice)
    ? manualTerrainChoice
    : manualTerrainChoiceOptions[0] ?? "asteroid-light";
  const activeManualTerrainKind: TerrainKind =
    activeManualTerrainChoice === "gas-cloud" ? "gas-cloud" : "asteroid-field";
  const activeManualTerrainVariant: ManualTerrainVariant | undefined =
    activeManualTerrainKind === "asteroid-field"
      ? activeManualTerrainChoice === "asteroid-medium"
        ? "asteroid-medium"
        : "asteroid-light"
      : undefined;
  useEffect(() => {
    if (!manualTerrainChoiceOptions.includes(manualTerrainChoice)) {
      setManualTerrainChoice(manualTerrainChoiceOptions[0] ?? "asteroid-light");
    }
  }, [manualTerrainChoice, manualTerrainChoiceOptions]);
  const manualTerrainPreview = useMemo(
    () =>
      manualTerrainPreviewPoint
        ? terrainObjectForPlacementPreview(
            activeManualTerrainKind,
            manualTerrainOrdinal,
            manualTerrainPreviewPoint.x,
            manualTerrainPreviewPoint.z,
            {
              variant: activeManualTerrainVariant,
              rotationDeg: manualTerrainRotationDeg,
            },
          )
        : null,
    [
      activeManualTerrainKind,
      activeManualTerrainVariant,
      manualTerrainOrdinal,
      manualTerrainPreviewPoint,
      manualTerrainRotationDeg,
    ],
  );
  const manualTerrainPreviewIsLegal = useMemo(
    () =>
      manualTerrainPreview
        ? manualTerrainPreviewLegal(manualTerrainPreview, deploymentConfig)
        : false,
    [deploymentConfig, manualTerrainPreview],
  );
  const placeManualTerrain = useMutation({
    mutationFn: ({
      kind,
      variant,
      rotationDeg,
      x,
      z,
    }: {
      kind: TerrainKind;
      variant?: ManualTerrainVariant;
      rotationDeg: number;
      x: number;
      z: number;
    }) =>
      customFetch<{ game: GameDetail["game"]; terrain: TerrainObject }>(
        `/api/games/${gameId}/terrain/place`,
        {
          method: "POST",
          body: JSON.stringify({ kind, variant, rotationDeg, x, z }),
          responseType: "json",
        },
      ),
    onSuccess: (result) => {
      qc.setQueryData<any>(getGetGameQueryKey(gameId), (old: any) =>
        old ? { ...old, game: result.game } : old,
      );
      setManualTerrainPreviewPoint(null);
      setActivationFeedback(null);
      void qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
    },
    onError: (err: any) => {
      setActivationFeedback(
        cleanApiErrorMessage(err, "Terrain placement failed"),
      );
    },
  });
  useEffect(() => {
    if (!canPlaceManualTerrain) setManualTerrainPreviewPoint(null);
  }, [canPlaceManualTerrain]);
  useEffect(() => {
    if (!canPlaceManualTerrain) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key !== "q" && event.key !== "Q" && event.key !== "e" && event.key !== "E") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === "q" || event.key === "Q" ? -15 : 15;
      setManualTerrainRotationDeg((current) => (((current + step) % 360) + 360) % 360);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [canPlaceManualTerrain]);
  const clampToDeployZone = useCallback(
    (x: number, z: number, baseRadius = 0): [number, number] => {
      const cx = Math.max(-BOARD_W / 2, Math.min(BOARD_W / 2, x));
      if (!game) return [cx, Math.max(-BOARD_D / 2, Math.min(BOARD_D / 2, z))];
      if (mySide) {
        return clampPointToDeploymentZone(
          x,
          z,
          mySide,
          deploymentConfig,
          baseRadius,
        );
      }
      return [cx, Math.max(-BOARD_D / 2, Math.min(BOARD_D / 2, z))];
    },
    [deploymentConfig, game, mySide],
  );
  const clampToCarriedFighterDeployCircle = useCallback(
    (
      rawX: number,
      rawZ: number,
      carrier: Pick<StagedUnitData, "x" | "z" | "baseRadiusInches">,
      fighter?: { baseRadiusInches?: number | null },
    ): [number, number] => {
      const radius = carriedFighterDeployCenterRadius(carrier, fighter);
      let [x, z] = clampToDeployZone(
        rawX,
        rawZ,
        fighter?.baseRadiusInches ?? 0,
      );
      for (let i = 0; i < 4; i += 1) {
        const dx = x - carrier.x;
        const dz = z - carrier.z;
        const dist = Math.hypot(dx, dz);
        if (dist > radius && dist > 1e-6) {
          x = carrier.x + (dx / dist) * radius;
          z = carrier.z + (dz / dist) * radius;
        }
        [x, z] = clampToDeployZone(x, z, fighter?.baseRadiusInches ?? 0);
      }
      return [x, z];
    },
    [clampToDeployZone],
  );
  const deploymentBoardTitle = manualTerrainPending
    ? "Place terrain"
    : aiDeploymentControlActive
      ? "Deploy AI fleet"
      : "Deploy your fleet";
  const canDevRedeployAiOpponent =
    devAiCommanderActive && game?.status === "deploying";
  const myDeploymentLocked = Boolean(
    game &&
    ((mySide === "challenger" && game.challengerDeployed) ||
      (mySide === "opponent" && game.opponentDeployed)) &&
    !canDevRedeployAiOpponent,
  );
  const canAbandonPreStart = Boolean(
    game &&
      (isChallenger || isOpponent) &&
      (game.status === "deploying" ||
        (game.status === "open" && isChallenger)),
  );
  const scenarioPriority = normalizePriorityLevel(game?.priorityLevel);
  const allocationPoints =
    game?.allocationPoints ??
    Math.max(1, Math.round((game?.pointLimit ?? 500) / 100));
  const stagedAllocation = useMemo(
    () =>
      calculateAllocation(
        chargeableStagedUnits(currentStagedUnits)
          .map((u) => normalizePriorityLevel(u.priorityLevel)),
        scenarioPriority,
        allocationPoints,
      ),
    [currentStagedUnits, scenarioPriority, allocationPoints],
  );
  const stagedUnitIsFighter = useCallback(
    (
      unit: Pick<
        StagedUnitData,
        "shipModelId" | "name" | "modelFilename" | "traits"
      >,
    ): boolean => {
      return (
        shipModelHasFighterTrait(shipModelById[unit.shipModelId]) ||
        shipModelHasFighterTrait({
          name: unit.name,
          filename: unit.modelFilename,
          traits: unit.traits ?? null,
        })
      );
    },
    [shipModelById],
  );
  const deploymentBlockers = useCallback(
    (ignoredStagedIds: Set<string> = new Set()): UiBaseFootprint[] => {
      return [
        ...units
          .filter((unit) => !unit.isDestroyed)
          .map((unit) => ({
            id: unit.id,
            x: unit.hexQ,
            z: unit.hexR,
            isFighter: isFighterUnit(unit),
            baseRadiusInches: unit.baseRadiusInches,
          })),
        ...currentStagedUnits
          .filter((unit) => !ignoredStagedIds.has(unit.id))
          .map((unit) => ({
            id: unit.id,
            x: unit.x,
            z: unit.z,
            isFighter: stagedUnitIsFighter(unit),
            baseRadiusInches: unit.baseRadiusInches,
          })),
      ];
    },
    [currentStagedUnits, isFighterUnit, stagedUnitIsFighter, units],
  );
  const deploymentPlacementOverlaps = useCallback(
    (
      candidate: UiBaseFootprint,
      ignoredStagedIds: Set<string> = new Set(),
    ): boolean => {
      return deploymentBlockers(ignoredStagedIds).some((blocker) =>
        uiBaseFootprintsIllegallyOverlap(candidate, blocker),
      );
    },
    [deploymentBlockers],
  );
  const deploymentOverlapWarning = useMemo(() => {
    for (const staged of currentStagedUnits) {
      const ignored = new Set([staged.id]);
      const candidate: UiBaseFootprint = {
        id: staged.id,
        x: staged.x,
        z: staged.z,
        isFighter: stagedUnitIsFighter(staged),
        baseRadiusInches: staged.baseRadiusInches,
      };
      if (deploymentPlacementOverlaps(candidate, ignored)) {
        return "Deployment contains overlapping bases. Move ships apart before committing.";
      }
    }
    return null;
  }, [currentStagedUnits, deploymentPlacementOverlaps, stagedUnitIsFighter]);
  const makeStagedUnit = useCallback(
    (
      ship: ShipModel,
      index: number,
      total: number,
      stagedName = ship.name,
      deploymentGroupId: string | null = null,
      deploymentGroupSize: number | null = null,
      deploymentGroupOrdinal: number | null = null,
    ): StagedUnitData => {
      const side = mySide ?? "challenger";
      const [cx, cz] = defaultDeploymentPoint(
        side,
        deploymentConfig,
        index,
        total,
        ship.baseRadiusInches,
      );
      const deployment = deploymentSideConfig(deploymentConfig, side);

      return {
        id: `staged-template-${Date.now()}-${ship.id}-${index}`,
        ownerId: myUserId,
        shipModelId: ship.id,
        name: stagedName,
        modelFilename: ship.filename,
        faction: ship.faction,
        priorityLevel: ship.priorityLevel,
        hullPoints: ship.hullPoints,
        speed: ship.speed,
        weaponRange: ship.weaponRange,
        weaponDamage: ship.weaponDamage,
        baseRadiusInches: ship.baseRadiusInches,
        weapons: ship.weapons ?? [],
        traits: ship.traits ?? null,
        carriedFighters: parseUiSmallCraftInventory(
          ship.smallCraft,
          shipModels ?? [],
        ),
        launchedFromStagedId: null,
        deploymentGroupId,
        deploymentGroupSize,
        deploymentGroupOrdinal,
        x: cx,
        z: cz,
        heading: deployment.defaultHeading,
        locked: false,
        crewQuality: 4,
      };
    },
    [deploymentConfig, mySide, myUserId, shipModels],
  );
  const makeExpandedStagedUnits = useCallback(
    (
      ships: Array<{ ship: ShipModel; name?: string }>,
      idPrefix = "staged-template",
    ): StagedUnitData[] => {
      const batchId = Date.now();
      const expanded: Array<{
        ship: ShipModel;
        name: string;
        groupId: string | null;
        groupSize: number | null;
        groupOrdinal: number | null;
      }> = [];
      ships.forEach(({ ship, name }, sourceIndex) => {
        const unitCount = multiUnitPurchaseCount(ship);
        const groupId =
          unitCount > 1
            ? `${idPrefix}-group-${batchId}-${ship.id}-${sourceIndex}`
            : null;
        for (let ordinal = 1; ordinal <= unitCount; ordinal += 1) {
          expanded.push({
            ship,
            name: name ?? ship.name,
            groupId,
            groupSize: unitCount > 1 ? unitCount : null,
            groupOrdinal: unitCount > 1 ? ordinal : null,
          });
        }
      });
      return expanded.map((entry, index) =>
        makeStagedUnit(
          entry.ship,
          index,
          expanded.length,
          entry.name,
          entry.groupId,
          entry.groupSize,
          entry.groupOrdinal,
        ),
      );
    },
    [makeStagedUnit],
  );
  const stageShipAtBoardPoint = useCallback(
    (ship: ShipModel, rawX: number, rawZ: number) => {
      if (manualTerrainPending) {
        setActivationFeedback(
          "Finish manual terrain placement before staging ships.",
        );
        return;
      }
      const purchaseUnitCount = multiUnitPurchaseCount(ship);
      const isMultiUnitPurchase = purchaseUnitCount > 1;
      const groupId = isMultiUnitPurchase
        ? `staged-group-${Date.now()}-${ship.id}`
        : null;
      const spacing = Math.max(ship.baseRadiusInches * 2 + 0.2, 1.1);
      const offsets = deploymentGroupGridOffsets(purchaseUnitCount, spacing);
      const blockers = deploymentBlockers();
      const stagedCandidates: Array<{
        unit: StagedUnitData;
        footprint: UiBaseFootprint;
      }> = [];
      const heading = mySide
        ? deploymentSideConfig(deploymentConfig, mySide).defaultHeading
        : 0;

      for (let index = 0; index < offsets.length; index += 1) {
        const offset = offsets[index]!;
        const [x, z] = clampToDeployZone(
          rawX + offset.x,
          rawZ + offset.z,
          ship.baseRadiusInches,
        );
        const candidate: UiBaseFootprint = {
          id: `candidate-${ship.id}-${index}`,
          x,
          z,
          isFighter: shipModelHasFighterTrait(ship),
          baseRadiusInches: ship.baseRadiusInches,
        };
        const overlapsExisting = blockers.some((blocker) =>
          uiBaseFootprintsIllegallyOverlap(candidate, blocker),
        );
        const overlapsNew = stagedCandidates.some(({ footprint }) =>
          uiBaseFootprintsIllegallyOverlap(candidate, footprint),
        );
        if (overlapsExisting || overlapsNew) {
          setActivationFeedback(
            isMultiUnitPurchase
              ? `Cannot place ${ship.name}: not enough legal space for ${purchaseUnitCount} units.`
              : "Cannot place ship: base overlaps another ship.",
          );
          return;
        }
        const newId = isMultiUnitPurchase
          ? `${groupId}-${index + 1}`
          : `staged-${Date.now()}-${ship.id}`;
        stagedCandidates.push({
          footprint: candidate,
          unit: {
            id: newId,
            ownerId: myUserId,
            shipModelId: ship.id,
            name: ship.name,
            modelFilename: ship.filename,
            faction: ship.faction,
            priorityLevel: ship.priorityLevel,
            hullPoints: ship.hullPoints,
            speed: ship.speed,
            weaponRange: ship.weaponRange,
            weaponDamage: ship.weaponDamage,
            baseRadiusInches: ship.baseRadiusInches,
            weapons: ship.weapons ?? [],
            traits: ship.traits ?? null,
            carriedFighters: parseUiSmallCraftInventory(
              ship.smallCraft,
              shipModels ?? [],
            ),
            launchedFromStagedId: null,
            deploymentGroupId: groupId,
            deploymentGroupSize: isMultiUnitPurchase
              ? purchaseUnitCount
              : null,
            deploymentGroupOrdinal: isMultiUnitPurchase
              ? index + 1
              : null,
            x,
            z,
            heading,
            locked: false,
            crewQuality: 4,
          },
        });
      }
      if (stagedCandidates.length === 0) {
        return;
      }
      setStagedUnits((prev) => [
        ...prev,
        ...stagedCandidates.map(({ unit }) => unit),
      ]);
      setSelectedStagedId(stagedCandidates[0]!.unit.id);
      setDraggingId(null);
      setTapPlacementShip(null);
      draggedShipRef.current = null;
      setActivationFeedback(null);
    },
    [
      clampToDeployZone,
      deploymentConfig,
      deploymentBlockers,
      manualTerrainPending,
      mySide,
      myUserId,
      shipModels,
    ],
  );
  const stageCarrierFighter = useCallback(
    (carrier: StagedUnitData, item: StagedFighterInventoryItem) => {
      if (!item.shipModelId) return;
      const fighterModel = (shipModels ?? []).find(
        (model) => model.id === item.shipModelId,
      );
      if (!fighterModel) return;
      const alreadyFromCarrier = currentStagedUnits.filter(
        (unit) => unit.launchedFromStagedId === carrier.id,
      );
      const limit = uiPrebattleFighterDeploymentLimit(carrier);
      if (alreadyFromCarrier.length >= limit) return;
      const alreadyThisModel = alreadyFromCarrier.filter(
        (unit) => unit.shipModelId === item.shipModelId,
      ).length;
      if (alreadyThisModel >= item.total) return;

      const allBlockers = [
        ...units
          .filter((unit) => !unit.isDestroyed)
          .map((unit) => ({
            id: unit.id,
            hexQ: unit.hexQ,
            hexR: unit.hexR,
            isDestroyed: false,
            isFighter: isFighterUnit(unit),
            baseRadiusInches: unit.baseRadiusInches,
          })),
        ...currentStagedUnits.map((unit, index) => ({
          id: -1000 - index,
          hexQ: unit.x,
          hexR: unit.z,
          isDestroyed: false,
          isFighter: shipModelHasFighterTrait(shipModelById[unit.shipModelId]),
          baseRadiusInches: unit.baseRadiusInches,
        })),
      ];
      const angleOffsets = [
        0,
        Math.PI / 4,
        -Math.PI / 4,
        Math.PI / 2,
        -Math.PI / 2,
        Math.PI,
        (3 * Math.PI) / 4,
        (-3 * Math.PI) / 4,
      ];
      const maxCenterDistance = carriedFighterDeployCenterRadius(
        carrier,
        fighterModel,
      );
      const distances = [1.6, 2.2, 2.8, 3.4, 4, maxCenterDistance];
      const baseAngle = (carrier.heading * Math.PI) / 180;
      let spot: { x: number; z: number } | null = null;
      for (const distance of distances) {
        for (const offset of angleOffsets) {
          const rawX = carrier.x + Math.sin(baseAngle + offset) * distance;
          const rawZ = carrier.z + Math.cos(baseAngle + offset) * distance;
          const [x, z] = clampToCarriedFighterDeployCircle(
            rawX,
            rawZ,
            carrier,
            fighterModel,
          );
          const candidate = {
            id: -1,
            x,
            z,
            isFighter: true,
            baseRadiusInches: fighterModel.baseRadiusInches,
          };
          const carrierFootprint = {
            id: -2,
            x: carrier.x,
            z: carrier.z,
            isFighter: false,
            baseRadiusInches: carrier.baseRadiusInches,
          };
          if (
            uiBaseFootprintEdgeDistance(candidate, carrierFootprint) >
            CARRIED_FIGHTER_DEPLOY_RADIUS_INCHES + 1e-6
          )
            continue;
          const illegalOverlap = allBlockers.some((other) => {
            const otherFootprint = {
              id: other.id,
              x: other.hexQ,
              z: other.hexR,
              isFighter: other.isFighter,
              baseRadiusInches: other.baseRadiusInches,
            };
            return uiBaseFootprintsIllegallyOverlap(candidate, otherFootprint);
          });
          if (!illegalOverlap) {
            spot = { x, z };
            break;
          }
        }
        if (spot) break;
      }
      if (!spot) return;
      const newId = `staged-carried-${Date.now()}-${fighterModel.id}`;
      setStagedUnits((prev) => [
        ...prev,
        {
          id: newId,
          ownerId: myUserId,
          shipModelId: fighterModel.id,
          name: fighterModel.name,
          modelFilename: fighterModel.filename,
          faction: fighterModel.faction,
          priorityLevel: fighterModel.priorityLevel,
          hullPoints: fighterModel.hullPoints,
          speed: fighterModel.speed,
          weaponRange: fighterModel.weaponRange,
          weaponDamage: fighterModel.weaponDamage,
          baseRadiusInches: fighterModel.baseRadiusInches,
          weapons: fighterModel.weapons ?? [],
          traits: fighterModel.traits ?? null,
          carriedFighters: [],
          launchedFromStagedId: carrier.id,
          x: spot.x,
          z: spot.z,
          heading: carrier.heading,
          locked: false,
          crewQuality: carrier.crewQuality,
        },
      ]);
      setSelectedStagedId(newId);
    },
    [
      clampToCarriedFighterDeployCircle,
      currentStagedUnits,
      isFighterUnit,
      myUserId,
      shipModelById,
      shipModels,
      units,
    ],
  );
  const carriedFighterDeploymentGuideCarrier = useMemo(() => {
    const activeId = draggingId ?? selectedStagedId;
    if (!activeId) return null;
    const active = currentStagedUnits.find((unit) => unit.id === activeId);
    if (!active) return null;
    if (active.launchedFromStagedId) {
      return (
        currentStagedUnits.find(
          (unit) => unit.id === active.launchedFromStagedId,
        ) ?? null
      );
    }
    const carriedFighters = active.carriedFighters ?? [];
    if (carriedFighters.length === 0) return null;
    const deployedFromCarrier = currentStagedUnits.filter(
      (unit) => unit.launchedFromStagedId === active.id,
    );
    if (deployedFromCarrier.length >= uiPrebattleFighterDeploymentLimit(active))
      return null;
    return active;
  }, [currentStagedUnits, draggingId, selectedStagedId]);
  const applyFleetTemplate = useCallback(
    (template: FleetTemplate) => {
      const roster = shipModels ?? [];
      const chosenShips: ShipModel[] = [];

      for (const entry of template.ships) {
        const ship = roster.find((model) => model.name === entry.modelName);
        if (!ship) continue;
        const count = entry.count ?? 1;
        for (let i = 0; i < count; i += 1) {
          chosenShips.push(ship);
        }
      }

      if (chosenShips.length === 0) return;
      const staged = makeExpandedStagedUnits(
        chosenShips.map((ship) => ({ ship })),
        `template-${template.id}`,
      );
      setYardsFleetId("");
      setSelectedFaction(template.faction);
      setStagedUnits((prev) => [
        ...prev.filter((u) => u.ownerId !== myUserId),
        ...staged,
      ]);
      setSelectedStagedId(staged[0]?.id ?? null);
      setDraggingId(null);
      setTapPlacementShip(null);
    },
    [makeExpandedStagedUnits, myUserId, shipModels],
  );
  useEffect(() => {
    if (!yardsFleetId) {
      autoStagedFleetIdRef.current = null;
      return;
    }
    if (!yardsFleetShips || autoStagedFleetIdRef.current === yardsFleetId)
      return;

    autoStagedFleetIdRef.current = yardsFleetId;
    const staged = makeExpandedStagedUnits(
      yardsFleetShips.map((fleetShip) => ({
        ship: fleetShip.shipModel,
        name: fleetShip.name || fleetShip.shipModel.name,
      })),
      `fleet-${yardsFleetId}`,
    );
    setStagedUnits((prev) => [
      ...prev.filter((u) => u.ownerId !== myUserId),
      ...staged,
    ]);
    setSelectedStagedId(staged[0]?.id ?? null);
    setDraggingId(null);
    setTapPlacementShip(null);
  }, [yardsFleetId, yardsFleetShips, makeExpandedStagedUnits, myUserId]);
  const canUseGameChat = Boolean(
    game &&
      game.opponentKind !== "ai" &&
      (isParticipant || isAdminObserver),
  );
  const canSendGameChat = Boolean(canUseGameChat && isParticipant);
  const gameChatQueryKey = useMemo(
    () => ["gameChat", gameId] as const,
    [gameId],
  );
  const { data: chatData } = useQuery({
    queryKey: gameChatQueryKey,
    enabled: canUseGameChat,
    refetchInterval: chatOpen ? 3000 : 6000,
    queryFn: () =>
      customFetch<{ messages: GameChatMessage[] }>(`/api/games/${gameId}/chat`),
  });
  const chatMessages = chatData?.messages ?? [];
  const latestChatMessage =
    chatMessages.length > 0 ? chatMessages[chatMessages.length - 1] : null;

  useEffect(() => {
    if (!chatOpen) return;
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chatMessages.length, chatOpen]);

  // New activation model: it's "my turn" if the server says I'm the
  // active player for the round's next ship activation.
  const isMyActivation =
    game?.status === "active" && game.activePlayerId === myUserId;
  const serverActiveUnitId = game?.activeUnitId ?? null;
  const [optimisticActiveUnitId, setOptimisticActiveUnitId] = useState<
    number | null
  >(null);
  const [activationAttemptDebug, setActivationAttemptDebug] = useState<{
    unitId: number;
    unitName: string;
    phase: string;
    source: "pick" | "swap";
    startedAt: string;
  } | null>(null);
  const activeUnitId = optimisticActiveUnitId ?? serverActiveUnitId;
  const hasActiveUnit = activeUnitId !== null;
  const activeUnitReadyForActions =
    isMyActivation &&
    serverActiveUnitId !== null &&
    activeUnitId === serverActiveUnitId;
  const activationRequestPending =
    optimisticActiveUnitId !== null &&
    serverActiveUnitId !== optimisticActiveUnitId;
  useEffect(() => {
    if (!isMyActivation || game?.status !== "active") {
      setOptimisticActiveUnitId(null);
      return;
    }
    if (
      optimisticActiveUnitId !== null &&
      serverActiveUnitId === optimisticActiveUnitId
    ) {
      setOptimisticActiveUnitId(null);
    }
    if (
      optimisticActiveUnitId !== null &&
      !activateUnit.isPending &&
      serverActiveUnitId !== optimisticActiveUnitId
    ) {
      setOptimisticActiveUnitId(null);
    }
  }, [
    activateUnit.isPending,
    game?.status,
    isMyActivation,
    optimisticActiveUnitId,
    serverActiveUnitId,
  ]);
  useEffect(() => {
    if (!activationAttemptDebug || !activateUnit.isPending) return;
    const timeout = window.setTimeout(() => {
      setActivationFeedback(
        `Still waiting for ${activationAttemptDebug.unitName} activation to confirm. If this does not clear, submit a blocker report.`,
      );
    }, 8000);
    return () => window.clearTimeout(timeout);
  }, [activationAttemptDebug, activateUnit.isPending]);
  useEffect(() => {
    if (!activateUnit.isPending && activationAttemptDebug) {
      setActivationAttemptDebug(null);
    }
  }, [activationAttemptDebug, activateUnit.isPending]);
  // With live polling, an opponent's action can advance the turn/activation
  // while this client still has a staged move preview. Drop any pending preview
  // the moment it's no longer our activation so a stale ghost can't linger; this
  // only fires on the transition away from our turn, so it never wipes a plan
  // we're actively building during our own activation.
  useEffect(() => {
    if (!isMyActivation) setMovePlan(null);
  }, [isMyActivation]);
  useEffect(() => {
    setActivationFeedback(null);
    setDamageControlFeedback(null);
  }, [game?.phase, serverActiveUnitId]);
  const selectedUnitData = units.find((u) => u.id === selectedUnit);
  const selectedShipModel = selectedUnitData
    ? getShipModelForUnit(selectedUnitData)
    : undefined;
  const selectedShipTraitList = splitTraitList(selectedShipModel?.traits);
  const inspectedUnitData =
    inspectedUnitId === null
      ? null
      : units.find((unit) => unit.id === inspectedUnitId) ?? null;
  const inspectedShipModel = inspectedUnitData
    ? getShipModelForUnit(inspectedUnitData)
    : undefined;
  const inspectedUnitWeapons = inspectedUnitData
    ? getWeaponsForUnit(inspectedUnitData)
    : [];
  const inspectedUnitIsFighter = inspectedUnitData
    ? isFighterUnit(inspectedUnitData)
    : false;
  const inspectedUnitDogfightLocked =
    !!inspectedUnitData &&
    dogfightingFighterUnitIds.has(inspectedUnitData.id);
  const handleUnitHoverChange = useCallback((unitId: number | null) => {
    setHoveredUnitId((current) => (current === unitId ? current : unitId));
  }, []);
  useEffect(() => {
    if (hoveredUnitId !== null && !units.some((unit) => unit.id === hoveredUnitId)) {
      setHoveredUnitId(null);
    }
    if (inspectedUnitId !== null && !units.some((unit) => unit.id === inspectedUnitId)) {
      setInspectedUnitId(null);
    }
  }, [hoveredUnitId, inspectedUnitId, units]);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key !== "u" && event.key !== "U") return;
      if (hoveredUnitId === null) return;
      event.preventDefault();
      setInspectedUnitId(hoveredUnitId);
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [hoveredUnitId]);
  // The selected ship is only "controllable" if it's the one the server
  // currently has activated for THIS player.
  const isSelectedUnitActive =
    !!selectedUnitData &&
    selectedUnitData.id === activeUnitId &&
    isMyActivation;
  const mergeGameIntoCache = useCallback(
    (updatedGame: GameDetail["game"]) => {
      qc.setQueryData<GameDetail | undefined>(
        getGetGameQueryKey(gameId),
        (old) => {
          if (!old) return old;
          return {
            ...old,
            game: { ...old.game, ...updatedGame },
          };
        },
      );
    },
    [gameId, qc],
  );
  const mergeUpdatedUnitIntoGame = useCallback(
    (updatedUnit: GameUnit) => {
      qc.setQueryData<GameDetail | undefined>(
        getGetGameQueryKey(gameId),
        (old) => {
          if (!old) return old;
          return {
            ...old,
            units: old.units.map((unit) =>
              unit.id === updatedUnit.id ? { ...unit, ...updatedUnit } : unit,
            ),
          };
        },
      );
    },
    [gameId, qc],
  );
  const cancelShadowDispersalPlacement = useCallback(() => {
    setShadowDispersalConfirmPopover(null);
    setPendingShadowDispersalPlacement(null);
    setActivationFeedback("Fighter Dispersal placement cancelled.");
  }, []);
  const beginShadowDispersalPlacement = useCallback(
    (
      carrier: GameUnit,
      fighterModel: ShipModel,
      count: number,
      itemName: string,
    ) => {
      const placements = buildShadowDispersalPlacements(
        carrier,
        fighterModel,
        units,
        isFighterUnit,
        count,
      );
      if (!placements) {
        setActivationFeedback(
          "No clear initial dispersal formation fits on the board. Reorient the Shadow ship or clear its launch lane.",
        );
        return;
      }
      setShadowDispersalConfirmPopover(null);
      setPendingShadowDispersalPlacement({
        carrierId: carrier.id,
        shipModelId: fighterModel.id,
        itemName,
        activeIndex: 0,
        placements,
      });
      setSelectedUnit(carrier.id);
      setActivationFeedback(
        `Place Shadow Fighter flight 1 of ${count}, then confirm.`,
      );
    },
    [isFighterUnit, units],
  );
  const confirmShadowDispersalPlacement = useCallback(() => {
    if (
      !pendingShadowDispersalPlacement ||
      !pendingShadowDispersalCarrier ||
      !shadowDispersalPlacementLegal
    ) {
      setActivationFeedback(shadowDispersalPlacementValidation.detail);
      return;
    }
    setShadowDispersalConfirmPopover(null);
    const nextIndex = pendingShadowDispersalPlacement.activeIndex + 1;
    if (nextIndex < pendingShadowDispersalPlacement.placements.length) {
      setPendingShadowDispersalPlacement((current) =>
        current ? { ...current, activeIndex: nextIndex } : current,
      );
      setActivationFeedback(
        `Place Shadow Fighter flight ${nextIndex + 1} of ${pendingShadowDispersalPlacement.placements.length}, then confirm.`,
      );
      return;
    }
    launchShadowFighterDispersal.mutate(
      {
        gameId,
        unitId: pendingShadowDispersalCarrier.id,
        data: {
          placements: pendingShadowDispersalPlacement.placements,
        },
      },
      {
        onSuccess: (result) => {
          mergeUpdatedUnitIntoGame(result.carrier);
          setPendingShadowDispersalPlacement(null);
          setActivationFeedback(
            `${result.fighters.length} Shadow Fighter flight${result.fighters.length === 1 ? "" : "s"} dispersed. They may act next turn.`,
          );
          void qc.invalidateQueries({
            queryKey: getGetGameQueryKey(gameId),
          });
        },
        onError: (err) =>
          setActivationFeedback(
            cleanApiErrorMessage(err, "Fighter Dispersal failed"),
          ),
      },
    );
  }, [
    gameId,
    launchShadowFighterDispersal,
    mergeUpdatedUnitIntoGame,
    pendingShadowDispersalCarrier,
    pendingShadowDispersalPlacement,
    qc,
    shadowDispersalPlacementLegal,
    shadowDispersalPlacementValidation.detail,
  ]);
  useEffect(() => {
    if (!pendingShadowDispersalPlacement) return;
    const placementStillActive =
      game?.status === "active" &&
      game.phase === "firing" &&
      game.activePlayerId === myUserId &&
      game.activeUnitId === pendingShadowDispersalPlacement.carrierId;
    if (!placementStillActive) {
      setShadowDispersalConfirmPopover(null);
      setPendingShadowDispersalPlacement(null);
    }
  }, [
    game?.activePlayerId,
    game?.activeUnitId,
    game?.phase,
    game?.status,
    myUserId,
    pendingShadowDispersalPlacement,
  ]);
  useEffect(() => {
    if (!pendingShadowDispersalPlacement) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (
        event.key === "Enter" ||
        event.key === " " ||
        event.code === "Space"
      ) {
        event.preventDefault();
        confirmShadowDispersalPlacement();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelShadowDispersalPlacement();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [
    cancelShadowDispersalPlacement,
    confirmShadowDispersalPlacement,
    pendingShadowDispersalPlacement,
  ]);
  const showTerrainHazardsForMove = useCallback(
    (updatedUnit: TerrainHazardMoveResult) => {
      const hazards = (Array.isArray(updatedUnit.asteroidHazards)
        ? updatedUnit.asteroidHazards
        : []).filter(
          (hazard) =>
            !hazard.checkReused ||
            hazard.attackDice > 0 ||
            hazard.damage > 0 ||
            hazard.crewLost > 0,
        );
      if (hazards.length === 0) return;
      setTerrainHazardModal({
        unitName: updatedUnit.name,
        hazards,
        phase: "rolling",
      });
      window.setTimeout(() => {
        setTerrainHazardModal((modal) =>
          modal && modal.unitName === updatedUnit.name && modal.phase === "rolling"
            ? { ...modal, phase: "shown" }
            : modal,
        );
      }, 700);
    },
    [],
  );
  const commitSelfRepair = useCallback(
    async (modal: SelfRepairModalState) => {
      if (modal.phase !== "ready" && modal.phase !== "error") return;
      setSelfRepairModal((m) =>
        m && m.unitId === modal.unitId
          ? { ...m, phase: "rolling", error: undefined, confirmingClose: false }
          : m,
      );
      try {
        const result = await customFetch<SelfRepairResult>(
          `/api/games/${gameId}/units/${modal.unitId}/self-repair`,
          {
            method: "POST",
            responseType: "json",
          },
        );
        mergeUpdatedUnitIntoGame(result.unit);
        window.setTimeout(() => {
          setSelfRepairModal((m) =>
            m && m.unitId === modal.unitId
              ? {
                  ...m,
                  phase: "shown",
                  dice: result.dice,
                  rolls: result.rolls,
                  total: result.total,
                  repaired: result.repaired,
                  hullBefore: result.hullBefore,
                  hullAfter: result.hullAfter,
                  error: undefined,
                  confirmingClose: false,
                }
              : m,
          );
        }, 700);
      } catch (err) {
        setSelfRepairModal((m) =>
          m && m.unitId === modal.unitId
            ? {
                ...m,
                phase: "error",
                error: cleanApiErrorMessage(err, "Self Repair failed"),
                confirmingClose: false,
              }
            : m,
        );
      }
    },
    [gameId, mergeUpdatedUnitIntoGame],
  );
  const mergeActiveUnitIntoGame = useCallback(
    (unitId: number | null) => {
      qc.setQueryData<GameDetail | undefined>(
        getGetGameQueryKey(gameId),
        (old) => {
          if (!old) return old;
          return {
            ...old,
            game: { ...old.game, activeUnitId: unitId },
          };
        },
      );
    },
    [gameId, qc],
  );

  const commitMovePlan = useCallback((afterSuccess?: () => void) => {
    if (moveConfirmInFlightRef.current || moveUnit.isPending) return;
    const u = units.find((x) => x.id === selectedUnit);
    if (!u || !movePlan) return;
    setMoveConfirmPopover(null);
    // Recompute SA-adjusted caps here (don't read selectedSaCaps — this
    // callback's deps would otherwise need it, and we want the authoritative
    // commit path to be self-contained).
    const baseAction = (u.specialAction ?? "").replace(/-failed$/, "");
    const isAllStop = baseAction === "all-stop";
    const isAllStopPivot = baseAction === "all-stop-pivot";
    const isAllPower = baseAction === "all-power-engines";
    const isRunSilent = baseAction === "run-silent";
    const isComeAboutExtra = u.specialAction === "come-about-extra-turn";
    const movementModel = getShipModelForUnit(u);
    const movementTraits = uiMovementTraitsForModel(movementModel, u);
    const isSuperManeuverable = movementTraits.superManeuverable;
    const baseSpeed = effectiveUiSpeed(
      shipModelHasFighterTrait(movementModel) ? { ...u, isCrippled: false } : u,
    );
    const baseTurns = isSuperManeuverable ? 999 : effectiveUiTurns(u);
    const baseTurnAngle = isSuperManeuverable ? 360 : effectiveUiTurnAngle(u);
    const speedCap = isAllStopPivot
      ? 0
      : isAllStop || isRunSilent
        ? Math.floor(baseSpeed / 2)
        : isAllPower
          ? Math.floor(baseSpeed * 1.5)
          : baseSpeed;
    const maxTurns = baseTurns + (isComeAboutExtra ? 1 : 0);
    const turnsForbidden = isAllPower || isRunSilent || isAllStop;
    const led = getLedger(u.id);
    let toHexQ = u.hexQ,
      toHexR = u.hexR,
      newHeading = u.heading;
    let distanceCommitted = 0;
    if (movePlan.kind === "fighter-free") {
      if (!isFighterUnit(u)) {
        setMovePlan(null);
        return;
      }
      if (dogfightingFighterUnitIds.has(u.id)) {
        setActivationFeedback(
          "Fighter is locked in a dogfight; use the Dogfight action instead.",
        );
        setMovePlan(null);
        setMovementGesture(null);
        return;
      }
      const candidate: UiBaseFootprint = {
        id: u.id,
        x: movePlan.x,
        z: movePlan.z,
        isFighter: true,
        baseRadiusInches: u.baseRadiusInches,
      };
      const radius = rulesBaseRadius(candidate);
      if (
        movePlan.x < -BOARD_W / 2 + radius ||
        movePlan.x > BOARD_W / 2 - radius ||
        movePlan.z < -BOARD_D / 2 + radius ||
        movePlan.z > BOARD_D / 2 - radius
      ) {
        setActivationFeedback(
          "Move rejected: fighter base must remain inside the board.",
        );
        setMovePlan(null);
        return;
      }
      const illegalOverlap = unitsWithFighterFlags.some((other) => {
        if (other.isDestroyed || other.id === u.id) return false;
        return uiBaseFootprintsIllegallyOverlap(candidate, {
          id: other.id,
          x: other.hexQ,
          z: other.hexR,
          isFighter: other.isFighter,
          baseRadiusInches: other.baseRadiusInches,
        });
      });
      if (illegalOverlap) {
        setActivationFeedback(
          "Move rejected: fighter base overlaps another ship.",
        );
        setMovePlan(null);
        return;
      }
      const requestedDistance = Math.hypot(
        movePlan.x - u.hexQ,
        movePlan.z - u.hexR,
      );
      if (led.distance + requestedDistance > speedCap + 1e-6) {
        setMovePlan(null);
        return;
      }
      toHexQ = snapBoardCoord(movePlan.x);
      toHexR = snapBoardCoord(movePlan.z);
      newHeading = Math.round(((movePlan.heading % 360) + 360) % 360);
      distanceCommitted = requestedDistance;
    } else if (movePlan.kind === "forward") {
      const v = headingForwardVec(u);
      const requestedDistance = Math.min(
        speedCap - led.distance,
        snapMovementDistance(movePlan.distance),
      );
      const plannedDistance = clampForwardDistanceToLegalRestingSpot(
        { ...u, isFighter: isFighterUnit(u) },
        unitsWithFighterFlags,
        v,
        requestedDistance,
        Math.max(0, speedCap - led.distance),
      );
      if (plannedDistance <= 0) {
        setMovePlan(null);
        return;
      }
      // SA cap re-check: a stale forward plan could otherwise commit a value
      // larger than the current allowance (e.g. if a Run Silent declaration
      // happened while a forward plan was open).
      if (led.distance + plannedDistance > speedCap + 1e-6) {
        setMovePlan(null);
        return;
      }
      // FLIP_MODELS render their nose along local -Z, so movement direction must
      // mirror the visual nose, not the abstract heading vector.
      const dx = v.x * plannedDistance;
      const dz = v.z * plannedDistance;
      // hexQ/hexR are stored as world inches (see hexToWorld above), so the
      // delta in world space IS the delta in storage units.
      toHexQ = snapBoardCoord(u.hexQ + dx);
      toHexR = snapBoardCoord(u.hexR + dz);
      distanceCommitted = plannedDistance;
    } else if (movePlan.kind === "turn") {
      // SA cap re-check on turns: forbidden under All Power / Run Silent;
      // capped at maxTurns (Come About extra-turn adds +1); per-turn angle
      // capped at turnAngle (×2 for All Stop & Pivot; +45° for one turn
      // under Come About sharp-turn).
      if (turnsForbidden) {
        setMovePlan(null);
        return;
      }
      if (led.turns >= maxTurns) {
        setMovePlan(null);
        return;
      }
      const neededStraight = isAllStopPivot
        ? 0
        : turnDistanceNeeded(baseSpeed, led.turns, movementTraits);
      if (!Number.isFinite(neededStraight)) {
        setActivationFeedback(
          "Turn rejected: effective Speed is 0. Use All Stop and Pivot if eligible.",
        );
        setMovePlan(null);
        return;
      }
      if (led.distSinceLastTurn + 1e-6 < neededStraight) {
        setMovePlan(null);
        return;
      }
      const isComeAboutSharp = u.specialAction === "come-about-sharp-turn";
      const sharpBonus = isComeAboutSharp && led.turns === 0 ? 45 : 0;
      const angleCap = isAllStopPivot
        ? baseTurnAngle * 2
        : baseTurnAngle + sharpBonus;
      if (Math.abs(movePlan.deltaDeg) > angleCap + 1e-6) {
        setMovePlan(null);
        return;
      }
      const headingDelta = visualTurnDeltaToHeadingDelta(
        u.modelFilename,
        movePlan.deltaDeg,
      );
      newHeading = (((u.heading + headingDelta) % 360) + 360) % 360;
    }
    const planKind = movePlan.kind;
    const unitId = u.id;
    const ledgerBeforeCommit = led;
    // Optimistically charge the phase ledger BEFORE the mutate resolves —
    // otherwise rapid R/F presses (or another commit) read stale allowances
    // between confirm and onSuccess, bypassing the per-phase limits.
    // distSinceLastTurn: a forward segment accumulates into it; a turn
    // commit RESETS it to 0 (next turn's eligibility starts measuring from
    // the new heading).
    const fighterHeadingChanged =
      planKind === "fighter-free" &&
      headingDeltaDegrees(u.heading, newHeading) > 0;
    const ledgerDelta =
      planKind === "forward"
        ? {
            distance: distanceCommitted,
            turns: 0,
            distSinceLastTurnDelta: distanceCommitted,
            resetSinceTurn: false,
          }
        : planKind === "fighter-free"
          ? {
              distance: distanceCommitted,
              turns: fighterHeadingChanged ? 1 : 0,
              distSinceLastTurnDelta: distanceCommitted,
              resetSinceTurn: false,
            }
          : {
              distance: 0,
              turns: 1,
              distSinceLastTurnDelta: 0,
              resetSinceTurn: true,
            };
    setPhaseLedger((prev) => {
      const cur = prev[unitId] ?? {
        distance: 0,
        turns: 0,
        distSinceLastTurn: 0,
      };
      return {
        ...prev,
        [unitId]: {
          distance: cur.distance + ledgerDelta.distance,
          turns: cur.turns + ledgerDelta.turns,
          distSinceLastTurn: ledgerDelta.resetSinceTurn
            ? 0
            : cur.distSinceLastTurn + ledgerDelta.distSinceLastTurnDelta,
        },
      };
    });
    // Apply the move immediately (real-time, single-ship). Does NOT end the turn.
    moveConfirmInFlightRef.current = true;
    moveUnit.mutate(
      { gameId, unitId, data: { toHexQ, toHexR, newHeading } },
      {
        onSuccess: (updatedUnit) => {
          moveConfirmInFlightRef.current = false;
          setActivationFeedback(null);
          const moveResult = updatedUnit as GameUnit & {
            game?: GameDetail["game"];
          };
          const { game: updatedGame, ...unitOnly } = moveResult;
          if (updatedGame) mergeGameIntoCache(updatedGame);
          mergeUpdatedUnitIntoGame(unitOnly as GameUnit);
          showTerrainHazardsForMove(unitOnly as TerrainHazardMoveResult);
          qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
          afterSuccess?.();
        },
        // Roll back the optimistic ledger charge on server rejection.
        onError: (err: any) => {
          moveConfirmInFlightRef.current = false;
          setActivationFeedback(`Move rejected: ${cleanApiErrorMessage(err)}`);
          setPhaseLedger((prev) => ({ ...prev, [unitId]: ledgerBeforeCommit }));
          qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
        },
      },
    );
    setMovePlan(null);
    setMovementGesture(null);
  }, [
    units,
    selectedUnit,
    movePlan,
    moveUnit,
    gameId,
    getLedger,
    qc,
    shipModels,
    mergeGameIntoCache,
    mergeUpdatedUnitIntoGame,
    showTerrainHazardsForMove,
    isFighterUnit,
    unitsWithFighterFlags,
    dogfightingFighterUnitIds,
  ]);

  const confirmMovePlan = useCallback(() => {
    commitMovePlan();
  }, [commitMovePlan]);

  const cancelMovePlan = useCallback(() => {
    setMovePlan(null);
    setMovementGesture(null);
    setMoveConfirmPopover(null);
  }, []);

  // Keyboard controls for movement planning:
  //   Q          -> enter/extend turn plan by -5 deg left/port
  //   E          -> enter/extend turn plan by +5 deg right/starboard
  //   F          → forward-move plan
  //   Enter      → confirm current plan (queue it)
  //   Esc        → cancel current plan, or if none, discard the queued move for this ship
  useEffect(() => {
    if (game?.status !== "active" || !isSelectedUnitActive) return;
    if (
      !selectedUnitData ||
      selectedUnitData.ownerId !== myUserId ||
      selectedUnitData.isDestroyed
    )
      return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      if (canPlaceCurrentDisplacedFighter) {
        if (e.key === "Enter" || e.key === " " || e.code === "Space") {
          e.preventDefault();
          confirmDisplacedFighterPlacement();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          cancelDisplacedFighterPlacement();
          return;
        }
      }
      // While a move is in flight the server hasn't yet updated the unit's
      // position/heading; queueing another commit would compute from stale state.
      if (moveUnit.isPending) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        if (endActivation.isPending) return;
        const phase =
          (game?.phase as
            | "initiative"
            | "movement"
            | "firing"
            | "end"
            | undefined) ?? "movement";
        if (phase === "movement" && movePlan) {
          setActivationFeedback("Committing staged movement before ending activation...");
          commitMovePlan(() => setEndActivationConfirmOpen(true));
          return;
        }
        setEndActivationConfirmOpen(true);
        return;
      }
      const phase =
        (game?.phase as
          | "initiative"
          | "movement"
          | "firing"
          | "end"
          | undefined) ?? "movement";
      if (phase !== "movement") return;
      const u = selectedUnitData;
      const selectedFighterMoveKey =
        isFighterUnit(u) &&
        dogfightingFighterUnitIds.has(u.id) &&
        (e.key === "f" ||
          e.key === "F" ||
          e.key === "r" ||
          e.key === "R" ||
          e.key === "q" ||
          e.key === "Q" ||
          e.key === "e" ||
          e.key === "E");
      if (selectedFighterMoveKey) {
        e.preventDefault();
        setActivationFeedback(
          "Fighter is locked in a dogfight; use the Dogfight action instead.",
        );
        setMovePlan(null);
        setMovementGesture(null);
        return;
      }
      const movementModel = getShipModelForUnit(u);
      const movementTraits = uiMovementTraitsForModel(movementModel, u);
      const baseSpeed = effectiveUiSpeed(
        shipModelHasFighterTrait(movementModel)
          ? { ...u, isCrippled: false }
          : u,
      );
      const isSuperManeuverable = movementTraits.superManeuverable;
      const max = isSuperManeuverable ? 360 : effectiveUiTurnAngle(u);
      const baseTurns = isSuperManeuverable ? 999 : effectiveUiTurns(u);
      const led = getLedger(u.id);
      // Special Action modifiers (read the base name; the "-failed" suffix
      // still applies the penalty side of always-on actions like Run Silent).
      const baseAction = (u.specialAction ?? "").replace(/-failed$/, "");
      const isAllStop = baseAction === "all-stop";
      const isAllStopPivot = baseAction === "all-stop-pivot";
      const isAllPower = baseAction === "all-power-engines";
      const isRunSilent = baseAction === "run-silent";
      const isComeAboutExtra = u.specialAction === "come-about-extra-turn"; // success-only
      const isComeAboutSharp = u.specialAction === "come-about-sharp-turn"; // success-only
      // Come About (extra-turn variant): +1 extra turn this activation.
      const maxTurns = baseTurns + (isComeAboutExtra ? 1 : 0);
      // No turns allowed under All Power to Engines, Run Silent, or All Stop.
      // All Stop and Pivot doubles turn rate but allows turns.
      const turnsForbidden = isAllPower || isRunSilent || isAllStop;
      // Per sheet: a ship must move ≥ ½ base speed before its FIRST turn, and
      // ≥ 2" of fresh forward motion before each follow-up turn. Agile lowers
      // those to ¼ speed and 1"; Super Manoeuvrable ignores the gate. All Stop
      // & Pivot bypasses too.
      const turnGateExempt =
        isAllStopPivot ||
        movementTraits.superManeuverable ||
        u.damageState === "adrift" ||
        u.damageState === "exploding-end-of-next";
      const neededStraight = turnDistanceNeeded(
        baseSpeed,
        led.turns,
        movementTraits,
      );
      const turnDistanceGate = turnGateExempt
        ? true
        : Number.isFinite(neededStraight) &&
          led.distSinceLastTurn + 1e-6 >= neededStraight;
      const canTurn =
        !turnsForbidden && led.turns < maxTurns && turnDistanceGate;
      // Effective speed cap per action.
      // All Power: +50% (Afterburner not modeled yet).
      // All Stop / Run Silent: half speed.
      // All Stop and Pivot: no movement.
      const speedCap = isAllStopPivot
        ? 0
        : isAllStop || isRunSilent
          ? Math.floor(baseSpeed / 2)
          : isAllPower
            ? Math.floor(baseSpeed * 1.5)
            : baseSpeed;
      const remainingMove = Math.max(0, speedCap - led.distance);
      if (e.key === "e" || e.key === "E" || e.key === "q" || e.key === "Q") {
        e.preventDefault();
        // Allow refining an in-progress turn plan even if `canTurn` is false,
        // since the plan hasn't been committed yet.
        if (!canTurn && (!movePlan || movePlan.kind !== "turn")) {
          if (!turnGateExempt && !Number.isFinite(neededStraight)) {
            setActivationFeedback(
              "Effective Speed is 0; ordinary turns require movement or All Stop and Pivot.",
            );
          }
          return;
        }
        // Match tablet controls: Q/left = negative, E/right = positive.
        const step = e.key === "q" || e.key === "Q" ? -5 : 5;
        // All Stop and Pivot doubles the per-turn cap (any direction).
        // Come About (sharp-turn variant): adds 45° to ONE turn this
        // activation — applied to the first turn the player makes
        // (`led.turns === 0`); subsequent turns revert to the normal cap.
        // Most ships have turns=1 so this is the only turn anyway; the
        // gate matters only for ships with turns≥2 that already used
        // their bonus on the first turn.
        const sharpBonus = isComeAboutSharp && led.turns === 0 ? 45 : 0;
        const cap = isAllStopPivot ? max * 2 : max + sharpBonus;
        if (isFighterUnit(u)) {
          const headingDelta = visualTurnDeltaToHeadingDelta(
            u.modelFilename,
            step,
          );
          setMovePlan((prev) => {
            const current =
              prev?.kind === "fighter-free"
                ? prev
                : {
                    kind: "fighter-free" as const,
                    x: u.hexQ,
                    z: u.hexR,
                    heading: u.heading,
                  };
            return {
              ...current,
              heading: (((current.heading + headingDelta) % 360) + 360) % 360,
            };
          });
          return;
        }
        setMovePlan((prev) => {
          const current = prev && prev.kind === "turn" ? prev.deltaDeg : 0;
          const next = Math.max(-cap, Math.min(cap, current + step));
          return { kind: "turn", deltaDeg: next };
        });
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        if (remainingMove <= 0) return;
        if (isFighterUnit(u)) {
          setMovementGesture({ kind: "fighter-free" });
          setMovePlan((prev) =>
            prev?.kind === "fighter-free"
              ? prev
              : {
                  kind: "fighter-free",
                  x: u.hexQ,
                  z: u.hexR,
                  heading: u.heading,
                },
          );
          return;
        }
        const v = headingForwardVec(u);
        setMovePlan((prev) => {
          const current = prev?.kind === "forward" ? prev.distance : 0;
          const requested = Math.max(
            0,
            Math.min(
              remainingMove,
              snapMovementDistance(current + TABLET_FORWARD_STEP),
            ),
          );
          const next = clampForwardDistanceToLegalRestingSpot(
            { ...u, isFighter: false },
            unitsWithFighterFlags,
            v,
            requested,
            remainingMove,
            "forward",
          );
          return { kind: "forward", distance: next };
        });
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        setMovePlan((prev) => {
          if (prev?.kind !== "forward") return prev;
          const next = snapMovementDistance(
            Math.max(0, prev.distance - TABLET_FORWARD_STEP),
          );
          return next > 0 ? { kind: "forward", distance: next } : null;
        });
      } else if (e.key === "Enter" || e.key === " " || e.code === "Space") {
        e.preventDefault();
        confirmMovePlan();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelMovePlan();
      }
    };
    // Capture on document so we get the keydown regardless of which element has focus.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [
    game?.status,
    game?.phase,
    isSelectedUnitActive,
    selectedUnitData,
    myUserId,
    canPlaceCurrentDisplacedFighter,
    confirmDisplacedFighterPlacement,
    cancelDisplacedFighterPlacement,
    confirmMovePlan,
    commitMovePlan,
    cancelMovePlan,
    getLedger,
    movePlan,
    moveUnit.isPending,
    endActivation,
    gameId,
    qc,
    shipModels,
    isFighterUnit,
    unitsWithFighterFlags,
    dogfightingFighterUnitIds,
  ]);

  // Special-Action-adjusted caps for the selected unit. Single source of truth
  // shared by keyboard gating, drag clamp, confirmMovePlan re-validation, and
  // the Special Actions panel (so declarations can't be made after a move that
  // would violate the declared action's constraints).
  const selectedSaCaps = useMemo(() => {
    if (!selectedUnitData) return null;
    const u = selectedUnitData;
    const baseAction = (u.specialAction ?? "").replace(/-failed$/, "");
    const isAllStop = baseAction === "all-stop";
    const isAllStopPivot = baseAction === "all-stop-pivot";
    const isAllPower = baseAction === "all-power-engines";
    const isRunSilent = baseAction === "run-silent";
    const isComeAboutExtra = u.specialAction === "come-about-extra-turn";
    const movementModel = getShipModelForUnit(u);
    const movementTraits = uiMovementTraitsForModel(movementModel, u);
    const isSuperManeuverable = movementTraits.superManeuverable;
    const baseSpeed = effectiveUiSpeed(
      shipModelHasFighterTrait(movementModel) ? { ...u, isCrippled: false } : u,
    );
    const maxTurns =
      (isSuperManeuverable ? 999 : effectiveUiTurns(u)) +
      (isComeAboutExtra ? 1 : 0);
    // Keep in sync with the keyboard handler's turnsForbidden — All Stop
    // forbids turning per the sheet ("ship halts; may not turn").
    const turnsForbidden = isAllPower || isRunSilent || isAllStop;
    const speedCap = isAllStopPivot
      ? 0
      : isAllStop || isRunSilent
        ? Math.floor(baseSpeed / 2)
        : isAllPower
          ? Math.floor(baseSpeed * 1.5)
          : baseSpeed;
    return { speedCap, maxTurns, turnsForbidden, isAllStopPivot };
  }, [selectedUnitData, shipModels]);

  // Selected-ship remaining inches this phase + drag offset for the forward
  // preview / ship slide-along-axis. Uses SA-adjusted speed cap so the drag
  // clamp can't bypass Run Silent / All Stop / All Power restrictions.
  const selectedRemainingMove =
    selectedUnitData && selectedSaCaps
      ? Math.max(
          0,
          selectedSaCaps.speedCap - getLedger(selectedUnitData.id).distance,
        )
      : 0;
  const selectedMovementUi = useMemo(() => {
    if (!selectedUnitData || !selectedSaCaps) return null;
    const u = selectedUnitData;
    const baseAction = (u.specialAction ?? "").replace(/-failed$/, "");
    const isAllStopPivot = baseAction === "all-stop-pivot";
    const isAllStop = baseAction === "all-stop";
    const isAllPower = baseAction === "all-power-engines";
    const isRunSilent = baseAction === "run-silent";
    const isComeAboutSharp = u.specialAction === "come-about-sharp-turn";
    const movementModel = getShipModelForUnit(u);
    const movementTraits = uiMovementTraitsForModel(movementModel, u);
    const led = getLedger(u.id);
    const baseSpeed = effectiveUiSpeed(
      shipModelHasFighterTrait(movementModel) ? { ...u, isCrippled: false } : u,
    );
    const baseTurnAngle = movementTraits.superManeuverable
      ? 360
      : effectiveUiTurnAngle(u);
    const sharpBonus = isComeAboutSharp && led.turns === 0 ? 45 : 0;
    const angleCap = isAllStopPivot
      ? baseTurnAngle * 2
      : baseTurnAngle + sharpBonus;
    const turnGateExempt =
      isAllStopPivot ||
      movementTraits.superManeuverable ||
      u.damageState === "adrift" ||
      u.damageState === "exploding-end-of-next";
      const neededStraight = turnDistanceNeeded(
        baseSpeed,
        led.turns,
        movementTraits,
      );
      const turnDistanceGate =
        turnGateExempt ||
        (Number.isFinite(neededStraight) &&
          led.distSinceLastTurn + 1e-6 >= neededStraight);
    const turnsForbidden = isAllPower || isRunSilent || isAllStop;
    const canTurn =
      !turnsForbidden &&
      led.turns < selectedSaCaps.maxTurns &&
      turnDistanceGate &&
      angleCap > 0;
    return {
      canForward: selectedRemainingMove > 0 && !isAllStopPivot,
      canTurn,
      angleCap,
      isSuperManeuverable: movementTraits.superManeuverable,
      turnsForbidden,
      neededStraight,
      distanceSinceLastTurn: led.distSinceLastTurn,
      turnGateExempt,
    };
  }, [
    selectedUnitData,
    selectedSaCaps,
    selectedRemainingMove,
    getLedger,
    shipModels,
  ]);
  const selectedMovementSpeedBreakdown = useMemo(() => {
    if (!selectedUnitData) return null;
    const model = getShipModelForUnit(selectedUnitData);
    return uiSpeedBreakdown(
      shipModelHasFighterTrait(model)
        ? { ...selectedUnitData, isCrippled: false }
        : selectedUnitData,
    );
  }, [getShipModelForUnit, selectedUnitData]);
  useEffect(() => {
    if (!movePlan) return;
    if (
      movePlan.kind === "forward" &&
      movePlan.distance > selectedRemainingMove
    ) {
      const clamped =
        Math.floor(selectedRemainingMove / TABLET_FORWARD_STEP) *
        TABLET_FORWARD_STEP;
      setMovePlan(clamped > 0 ? { kind: "forward", distance: clamped } : null);
      return;
    }
    if (
      movePlan.kind === "turn" &&
      selectedMovementUi &&
      Math.abs(movePlan.deltaDeg) > selectedMovementUi.angleCap
    ) {
      const clamped = Math.max(
        -selectedMovementUi.angleCap,
        Math.min(selectedMovementUi.angleCap, movePlan.deltaDeg),
      );
      setMovePlan(
        Math.abs(clamped) > 0 ? { kind: "turn", deltaDeg: clamped } : null,
      );
    }
  }, [movePlan, selectedMovementUi, selectedRemainingMove]);
  const selectedDragOffset = useMemo(() => {
    if (!selectedUnitData || !movePlan) return null;
    if (movePlan.kind === "fighter-free") {
      return {
        x: movePlan.x - selectedUnitData.hexQ,
        z: movePlan.z - selectedUnitData.hexR,
      };
    }
    if (movePlan.kind !== "forward") return null;
    const v = headingForwardVec(selectedUnitData);
    return { x: v.x * movePlan.distance, z: v.z * movePlan.distance };
  }, [selectedUnitData, movePlan]);
  const selectedPreviewHeadingDelta = useMemo(() => {
    if (!selectedUnitData || !movePlan) return 0;
    if (movePlan.kind === "fighter-free")
      return (
        (((movePlan.heading - selectedUnitData.heading) % 360) + 360) % 360
      );
    if (movePlan.kind !== "turn") return 0;
    return visualTurnDeltaToHeadingDelta(
      selectedUnitData.modelFilename,
      movePlan.deltaDeg,
    );
  }, [selectedUnitData, movePlan]);
  const selectedUnitIsFighter = selectedUnitData
    ? isFighterUnit(selectedUnitData)
    : false;
  const selectedFighterLockedInDogfight = Boolean(
    selectedUnitData &&
      selectedUnitIsFighter &&
      dogfightingFighterUnitIds.has(selectedUnitData.id),
  );
  const buildFighterMovePlan = useCallback(
    (
      unit: GameUnit,
      rawX: number,
      rawZ: number,
      headingFallback = unit.heading,
    ): Extract<MovePlan, { kind: "fighter-free" }> | null => {
      if (dogfightingFighterUnitIds.has(unit.id)) return null;
      const remaining = Math.max(
        0,
        selectedSaCaps
          ? selectedSaCaps.speedCap - getLedger(unit.id).distance
          : 0,
      );
      let x = rawX;
      let z = rawZ;
      for (let i = 0; i < 4; i += 1) {
        const dx = x - unit.hexQ;
        const dz = z - unit.hexR;
        const dist = Math.hypot(dx, dz);
        if (dist > remaining && dist > 1e-6) {
          x = unit.hexQ + (dx / dist) * remaining;
          z = unit.hexR + (dz / dist) * remaining;
        }
        [x, z] = clampBaseCenterInsideBoard(x, z, unit);
      }
      const candidate: UiBaseFootprint = {
        id: unit.id,
        x,
        z,
        isFighter: true,
        baseRadiusInches: unit.baseRadiusInches,
      };
      const illegalOverlap = unitsWithFighterFlags.some((other) => {
        if (other.isDestroyed) return false;
        return uiBaseFootprintsIllegallyOverlap(candidate, {
          id: other.id,
          x: other.hexQ,
          z: other.hexR,
          isFighter: other.isFighter,
          baseRadiusInches: other.baseRadiusInches,
        });
      });
      if (illegalOverlap) return null;
      const movedDx = x - unit.hexQ;
      const movedDz = z - unit.hexR;
      const heading =
        movedDx * movedDx + movedDz * movedDz > 0.04
          ? headingForVisualVector(unit, movedDx, movedDz)
          : headingFallback;
      return {
        kind: "fighter-free",
        x: snapBoardCoord(x),
        z: snapBoardCoord(z),
        heading: Math.round(((heading % 360) + 360) % 360),
      };
    },
    [dogfightingFighterUnitIds, getLedger, selectedSaCaps, unitsWithFighterFlags],
  );

  const currentPhase: "initiative" | "movement" | "firing" | "end" =
    (game?.phase as "initiative" | "movement" | "firing" | "end") ?? "movement";
  useEffect(() => {
    if (currentPhase !== "movement" || serverActiveUnitId == null) return;
    setPhaseLedger((prev) => {
      if (!(serverActiveUnitId in prev)) return prev;
      const next = { ...prev };
      delete next[serverActiveUnitId];
      return next;
    });
  }, [currentPhase, serverActiveUnitId]);
  const activeDogfightEnemies = useMemo(() => {
    if (currentPhase !== "firing" || !activeUnitId)
      return [] as Array<BoardUnit & { isFighter: boolean }>;
    const active = unitsWithFighterFlags.find((u) => u.id === activeUnitId);
    if (!active?.isFighter || active.ownerId !== myUserId || active.isDestroyed)
      return [] as Array<BoardUnit & { isFighter: boolean }>;
    return enemyFighterContactsForUnit(active);
  }, [
    activeUnitId,
    currentPhase,
    enemyFighterContactsForUnit,
    myUserId,
    unitsWithFighterFlags,
  ]);
  const activeFighterLockedInDogfight = activeDogfightEnemies.length > 0;
  const plannedFighterDogfightContact = useMemo(() => {
    if (
      currentPhase !== "movement" ||
      !selectedUnitData ||
      !isFighterUnit(selectedUnitData)
    )
      return false;
    if (movePlan?.kind !== "fighter-free") return false;
    return (
      enemyFighterContactsForUnit(selectedUnitData, {
        hexQ: movePlan.x,
        hexR: movePlan.z,
      }).length > 0
    );
  }, [
    currentPhase,
    enemyFighterContactsForUnit,
    isFighterUnit,
    movePlan,
    selectedUnitData,
  ]);
  const isMyEndPhaseWindow =
    game?.status === "active" &&
    currentPhase === "end" &&
    game.activePlayerId === myUserId;
  const myEndPhasePassed =
    game?.status === "active" &&
    currentPhase === "end" &&
    (myUserId === game.challengerId
      ? Boolean(game.endPhaseChallengerPassed)
      : myUserId === game.opponentId
        ? Boolean(game.endPhaseOpponentPassed)
        : false);
  useEffect(() => {
    if (currentPhase !== "end") setSkippedSelfRepairPromptKeys(new Set());
  }, [currentPhase, game?.currentRound]);
  const selfRepairPromptCandidates = useMemo<SelfRepairPromptCandidate[]>(() => {
    if (!game || !isMyEndPhaseWindow || myEndPhasePassed) return [];
    const currentRound = game.currentRound ?? 0;
    return units
      .filter((unit) => {
        if (unit.ownerId !== myUserId || unit.isDestroyed) return false;
        if (unit.hullPoints <= 0 || unit.hullPoints >= unit.maxHullPoints)
          return false;
        if ((unit.maxCrewPoints ?? 0) > 0 && (unit.crewPoints ?? 0) <= 0)
          return false;
        if ((unit.lastSelfRepairRound ?? 0) === currentRound) return false;
        return parseUiSelfRepairDice(getShipModelForUnit(unit)?.traits ?? "") > 0;
      })
      .map((unit) => {
        const dice = parseUiSelfRepairDice(getShipModelForUnit(unit)?.traits ?? "");
        return {
          key: `${game.id}:${currentRound}:${myUserId}:${unit.id}`,
          unitId: unit.id,
          unitName: unit.name,
          dice,
        };
      });
  }, [
    game,
    getShipModelForUnit,
    isMyEndPhaseWindow,
    myEndPhasePassed,
    myUserId,
    units,
  ]);
  const activeSelfRepairPrompt =
    selfRepairModal || diceModal || dogfightModal || terrainHazardModal
      ? null
      : (selfRepairPromptCandidates.find(
          (candidate) => !skippedSelfRepairPromptKeys.has(candidate.key),
        ) ?? null);
  const skipSelfRepairPrompt = useCallback((candidate: SelfRepairPromptCandidate) => {
    setSkippedSelfRepairPromptKeys((prev) => {
      const next = new Set(prev);
      next.add(candidate.key);
      return next;
    });
  }, []);
  const repairFromSelfRepairPrompt = useCallback(
    (candidate: SelfRepairPromptCandidate) => {
      skipSelfRepairPrompt(candidate);
      setSelectedUnit(candidate.unitId);
      const modal: SelfRepairModalState = {
        unitId: candidate.unitId,
        unitName: candidate.unitName,
        dice: candidate.dice,
        phase: "ready",
      };
      setSelfRepairModal(modal);
      void commitSelfRepair(modal);
    },
    [commitSelfRepair, skipSelfRepairPrompt],
  );
  const unitCanUseDamageControlNow = useCallback(
    (unit: BoardUnit): boolean => {
      if (!isMyEndPhaseWindow || myEndPhasePassed) return false;
      if (unit.ownerId !== myUserId || unit.isDestroyed) return false;
      if (unit.hullPoints <= 0) return false;
      if ((unit.maxCrewPoints ?? 0) > 0 && (unit.crewPoints ?? 0) <= 0)
        return false;
      const currentRound = game?.currentRound ?? 0;
      const rawSA = unit.specialAction ?? null;
      const baseSA = rawSA ? rawSA.replace(/-failed$/, "") : null;
      const allHandsActive =
        baseSA === "all-hands-on-deck" && !rawSA?.endsWith("-failed");
      const dcLocked = (unit.lastDcRound ?? 0) === currentRound && !allHandsActive;
      if (dcLocked || damageControl.isPending) return false;
      return (unit.criticals ?? []).some(
        (crit) => crit.repairable && crit.appliedRound !== currentRound,
      );
    },
    [
      damageControl.isPending,
      game?.currentRound,
      isMyEndPhaseWindow,
      myEndPhasePassed,
      myUserId,
    ],
  );
  const mergeFighterBayResultIntoGame = useCallback(
    (result: FighterBayActionResult) => {
      qc.setQueryData<GameDetail | undefined>(
        getGetGameQueryKey(gameId),
        (old) => {
          if (!old) return old;
          const updatedUnits = old.units
            .map((unit) =>
              unit.id === result.carrier.id
                ? { ...unit, ...result.carrier }
                : unit,
            )
            .filter((unit) => unit.id !== result.recoveredUnitId);
          if (
            result.fighter &&
            !updatedUnits.some((unit) => unit.id === result.fighter!.id)
          ) {
            updatedUnits.push(result.fighter);
          }
          return { ...old, units: updatedUnits };
        },
      );
    },
    [gameId, qc],
  );
  const findAutoLaunchSpot = useCallback(
    (
      carrier: GameUnit,
    ): { hexQ: number; hexR: number; heading: number } | null => {
      const forward = headingForwardVec(carrier);
      const baseAngle = Math.atan2(forward.z, forward.x);
      const angleOffsets = [
        0,
        Math.PI / 4,
        -Math.PI / 4,
        Math.PI / 2,
        -Math.PI / 2,
        Math.PI,
        (3 * Math.PI) / 4,
        (-3 * Math.PI) / 4,
      ];
      const maxCenterDistance = carriedFighterDeployCenterRadius(carrier, {
        baseRadiusInches: STANDARD_BASE_RADIUS_INCHES,
      });
      const distances = [1.6, 2.2, 2.8, 3.4, 4, maxCenterDistance];
      for (const distance of distances) {
        for (const offset of angleOffsets) {
          const angle = baseAngle + offset;
          const candidate = {
            id: -1,
            hexQ: snapBoardCoord(carrier.hexQ + Math.cos(angle) * distance),
            hexR: snapBoardCoord(carrier.hexR + Math.sin(angle) * distance),
            isFighter: true,
            baseRadiusInches: STANDARD_BASE_RADIUS_INCHES,
          };
          if (
            candidate.hexQ < -24 ||
            candidate.hexQ > 24 ||
            candidate.hexR < -36 ||
            candidate.hexR > 36
          )
            continue;
          const candidateFootprint = {
            id: candidate.id,
            x: candidate.hexQ,
            z: candidate.hexR,
            isFighter: candidate.isFighter,
            baseRadiusInches: candidate.baseRadiusInches,
          };
          const carrierFootprint = {
            id: carrier.id,
            x: carrier.hexQ,
            z: carrier.hexR,
            isFighter: false,
            baseRadiusInches: carrier.baseRadiusInches,
          };
          if (
            uiBaseFootprintEdgeDistance(candidateFootprint, carrierFootprint) >
            CARRIED_FIGHTER_DEPLOY_RADIUS_INCHES + 1e-6
          )
            continue;
          const illegalOverlap = unitsWithFighterFlags.some((other) => {
            if (other.isDestroyed) return false;
            return uiBaseFootprintsIllegallyOverlap(candidateFootprint, {
              id: other.id,
              x: other.hexQ,
              z: other.hexR,
              isFighter: other.isFighter,
              baseRadiusInches: other.baseRadiusInches,
            });
          });
          if (!illegalOverlap)
            return { ...candidate, heading: carrier.heading };
        }
      }
      return null;
    },
    [unitsWithFighterFlags],
  );
  const canLaunchFightersFromCarrier = useCallback(
    (carrier: GameUnit): boolean => {
      if (!game || !isMyEndPhaseWindow) return false;
      if (carrier.ownerId !== myUserId) return false;
      if (carrier.isDestroyed || !unitIsCombatEffective(carrier)) return false;
      if (
        carrier.damageState === "adrift" ||
        carrier.damageState === "exploding-end-of-next"
      ) return false;
      if (isFighterUnit(carrier)) return false;
      if (carrier.isCrippled || carrier.isSkeletonCrew) return false;
      if (hasLostCarrierCapability(carrier)) return false;
      if (carrier.specialAction && carrier.specialAction !== "scramble") return false;
      const inventory = carrier.carriedFighters ?? [];
      if (!inventory.some((item) => item.available > 0 && !!item.shipModelId)) {
        return false;
      }
      const carrierModel = getShipModelForUnit(carrier);
      const limit = uiFighterBayOperationLimit(carrier, carrierModel);
      const used = uiFighterBayOperationsUsedThisRound(
        carrier,
        game.currentRound ?? 0,
      );
      if (used >= limit) return false;
      return findAutoLaunchSpot(carrier) !== null;
    },
    [
      findAutoLaunchSpot,
      game,
      getShipModelForUnit,
      isFighterUnit,
      isMyEndPhaseWindow,
      myUserId,
    ],
  );
  const eligibleLaunchCarrierIds = useMemo(() => {
    if (!isMyEndPhaseWindow) return new Set<number>();
    return new Set(
      units
        .filter((unit) => canLaunchFightersFromCarrier(unit))
        .map((unit) => unit.id),
    );
  }, [canLaunchFightersFromCarrier, isMyEndPhaseWindow, units]);
  const endPhaseLaunchPromptKey =
    game?.status === "active" && currentPhase === "end" && game.activePlayerId
      ? `${game.id}:${game.currentRound}:${game.activePlayerId}`
      : null;
  useEffect(() => {
    if (!endPhaseLaunchPromptKey || !isMyEndPhaseWindow || eligibleLaunchCarrierIds.size === 0) {
      setEndPhaseLaunchPrompt(null);
      return;
    }
    setEndPhaseLaunchPrompt((prev) =>
      prev?.key === endPhaseLaunchPromptKey
        ? prev
        : { key: endPhaseLaunchPromptKey, mode: "prompt" },
    );
  }, [eligibleLaunchCarrierIds.size, endPhaseLaunchPromptKey, isMyEndPhaseWindow]);
  const selectedLaunchCarrier = useMemo(() => {
    if (
      endPhaseLaunchPrompt?.mode !== "highlight" ||
      selectedUnit == null ||
      !eligibleLaunchCarrierIds.has(selectedUnit)
    ) {
      return null;
    }
    return units.find((unit) => unit.id === selectedUnit) ?? null;
  }, [eligibleLaunchCarrierIds, endPhaseLaunchPrompt?.mode, selectedUnit, units]);
  const selectedLaunchCarrierItems = useMemo(
    () =>
      (selectedLaunchCarrier?.carriedFighters ?? []).filter(
        (item) => item.available > 0 && !!item.shipModelId,
      ),
    [selectedLaunchCarrier?.carriedFighters],
  );
  const pendingLaunchCarrier = useMemo(
    () =>
      pendingFighterLaunchPlacement
        ? (units.find(
            (unit) => unit.id === pendingFighterLaunchPlacement.carrierId,
          ) ?? null)
        : null,
    [pendingFighterLaunchPlacement, units],
  );
  const pendingLaunchFighterModel =
    pendingFighterLaunchPlacement?.shipModelId != null
      ? (shipModelById[pendingFighterLaunchPlacement.shipModelId] ?? null)
      : null;
  const clampEndPhaseLaunchPoint = useCallback(
    (
      rawX: number,
      rawZ: number,
      carrier: GameUnit,
      fighterModel: Pick<ShipModel, "baseRadiusInches">,
    ): [number, number] => {
      const radius = carriedFighterDeployCenterRadius(carrier, fighterModel);
      let x = Math.max(-BOARD_W / 2, Math.min(BOARD_W / 2, rawX));
      let z = Math.max(-BOARD_D / 2, Math.min(BOARD_D / 2, rawZ));
      for (let i = 0; i < 4; i += 1) {
        const dx = x - carrier.hexQ;
        const dz = z - carrier.hexR;
        const dist = Math.hypot(dx, dz);
        if (dist > radius && dist > 1e-6) {
          x = carrier.hexQ + (dx / dist) * radius;
          z = carrier.hexR + (dz / dist) * radius;
        }
        x = Math.max(-BOARD_W / 2, Math.min(BOARD_W / 2, x));
        z = Math.max(-BOARD_D / 2, Math.min(BOARD_D / 2, z));
      }
      return [snapBoardCoord(x), snapBoardCoord(z)];
    },
    [],
  );
  const isEndPhaseLaunchPointLegal = useCallback(
    (
      x: number,
      z: number,
      carrier: GameUnit,
      fighterModel: Pick<ShipModel, "baseRadiusInches">,
    ): boolean => {
      if (
        x < -BOARD_W / 2 ||
        x > BOARD_W / 2 ||
        z < -BOARD_D / 2 ||
        z > BOARD_D / 2
      ) {
        return false;
      }
      const candidate: UiBaseFootprint = {
        id: "pending-end-phase-launch",
        x,
        z,
        isFighter: true,
        baseRadiusInches: fighterModel.baseRadiusInches,
      };
      const carrierFootprint: UiBaseFootprint = {
        id: carrier.id,
        x: carrier.hexQ,
        z: carrier.hexR,
        isFighter: false,
        baseRadiusInches: carrier.baseRadiusInches,
      };
      if (
        uiBaseFootprintEdgeDistance(candidate, carrierFootprint) >
        CARRIED_FIGHTER_DEPLOY_RADIUS_INCHES + 1e-6
      ) {
        return false;
      }
      return !unitsWithFighterFlags.some((other) => {
        if (other.isDestroyed) return false;
        return uiBaseFootprintsIllegallyOverlap(candidate, {
          id: other.id,
          x: other.hexQ,
          z: other.hexR,
          isFighter: other.isFighter,
          baseRadiusInches: other.baseRadiusInches,
        });
      });
    },
    [unitsWithFighterFlags],
  );
  const pendingLaunchPlacementLegal =
    !!pendingFighterLaunchPlacement &&
    !!pendingLaunchCarrier &&
    !!pendingLaunchFighterModel &&
    isEndPhaseLaunchPointLegal(
      pendingFighterLaunchPlacement.x,
      pendingFighterLaunchPlacement.z,
      pendingLaunchCarrier,
      pendingLaunchFighterModel,
    );
  const pendingLaunchDogfightContact = useMemo(() => {
    if (
      !pendingFighterLaunchPlacement ||
      !pendingLaunchFighterModel ||
      !pendingLaunchPlacementLegal
    )
      return false;
    const probe = {
      hexQ: pendingFighterLaunchPlacement.x,
      hexR: pendingFighterLaunchPlacement.z,
      baseRadiusInches: pendingLaunchFighterModel.baseRadiusInches,
    };
    return unitsWithFighterFlags.some(
      (other) =>
        !other.isDestroyed &&
        other.isFighter &&
        other.ownerId !== myUserId &&
        uiBasesInContact(probe, other),
    );
  }, [
    myUserId,
    pendingFighterLaunchPlacement,
    pendingLaunchFighterModel,
    pendingLaunchPlacementLegal,
    unitsWithFighterFlags,
  ]);
  useEffect(() => {
    if (endPhaseLaunchPrompt?.mode !== "highlight") {
      setPendingFighterLaunchPlacement(null);
    }
  }, [endPhaseLaunchPrompt?.mode]);
  useEffect(() => {
    if (!pendingFighterLaunchPlacement || !pendingLaunchPlacementLegal) {
      setFighterLaunchConfirmPopover(null);
    }
  }, [pendingFighterLaunchPlacement, pendingLaunchPlacementLegal]);
  const launchFighterFromCarrierAtPoint = useCallback(
    async (
      carrier: GameUnit,
      item: GameUnit["carriedFighters"][number],
      spot: { hexQ: number; hexR: number; heading: number },
      options?: { keepCarrierSelected?: boolean },
    ) => {
      if (!item.shipModelId) {
        setFighterBayFeedback(
          `${item.name} is not linked to a fighter model yet.`,
        );
        return;
      }
      const key = `launch:${carrier.id}:${item.shipModelId}`;
      setFighterBayBusyKey(key);
      setFighterBayFeedback(null);
      try {
        const result = await customFetch<FighterBayActionResult>(
          `/api/games/${gameId}/units/${carrier.id}/launch-fighter`,
          {
            method: "POST",
            body: JSON.stringify({
              shipModelId: item.shipModelId,
              hexQ: spot.hexQ,
              hexR: spot.hexR,
              heading: spot.heading,
            }),
            responseType: "json",
          },
        );
        mergeFighterBayResultIntoGame(result);
        setPendingFighterLaunchPlacement(null);
        setFighterLaunchConfirmPopover(null);
        if (options?.keepCarrierSelected) {
          setSelectedUnit(carrier.id);
        } else if (result.fighter) {
          setSelectedUnit(result.fighter.id);
        }
        setFighterBayFeedback(`${item.name} launched.`);
      } catch (err) {
        setFighterBayFeedback(cleanApiErrorMessage(err, "Launch failed"));
      } finally {
        setFighterBayBusyKey(null);
        void qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
        void qc.invalidateQueries({ queryKey: ["movement-audit-log", gameId] });
      }
    },
    [
      gameId,
      mergeFighterBayResultIntoGame,
      qc,
    ],
  );
  const beginFighterLaunchPlacement = useCallback(
    (carrier: GameUnit, item: GameUnit["carriedFighters"][number]) => {
      if (!item.shipModelId) {
        setFighterBayFeedback(
          `${item.name} is not linked to a fighter model yet.`,
        );
        return;
      }
      const fighterModel = shipModelById[item.shipModelId];
      if (!fighterModel) {
        setFighterBayFeedback(`${item.name} fighter model is not loaded yet.`);
        return;
      }
      const initial = findAutoLaunchSpot(carrier);
      const [x, z] = initial
        ? [initial.hexQ, initial.hexR]
        : clampEndPhaseLaunchPoint(
            carrier.hexQ,
            carrier.hexR + carriedFighterDeployCenterRadius(carrier, fighterModel),
            carrier,
            fighterModel,
          );
      setPendingFighterLaunchPlacement({
        carrierId: carrier.id,
        shipModelId: item.shipModelId,
        itemName: item.name,
        x,
        z,
        heading: initial?.heading ?? carrier.heading,
      });
      setSelectedUnit(carrier.id);
      setFighterBayFeedback(
        touchGameControls
          ? `Tap within the launch ring, then use Confirm Launch.`
          : `Place ${item.name} within 3 inches.`,
      );
    },
    [clampEndPhaseLaunchPoint, findAutoLaunchSpot, shipModelById, touchGameControls],
  );
  const cancelFighterLaunchPlacement = useCallback(() => {
    setPendingFighterLaunchPlacement(null);
    setFighterLaunchConfirmPopover(null);
  }, []);
  const confirmFighterLaunchPlacement = useCallback(() => {
    if (
      !pendingFighterLaunchPlacement ||
      !pendingLaunchCarrier ||
      !pendingLaunchFighterModel
    )
      return;
    if (!pendingLaunchPlacementLegal) {
      setFighterBayFeedback(
        "Choose a legal launch point within 3 inches that does not overlap another base.",
      );
      setFighterLaunchConfirmPopover(null);
      return;
    }
    const item = (pendingLaunchCarrier.carriedFighters ?? []).find(
      (candidate) =>
        candidate.shipModelId === pendingFighterLaunchPlacement.shipModelId &&
        candidate.available > 0,
    );
    if (!item) {
      setFighterBayFeedback(
        `${pendingFighterLaunchPlacement.itemName} is no longer available to launch.`,
      );
      cancelFighterLaunchPlacement();
      return;
    }
    void launchFighterFromCarrierAtPoint(
      pendingLaunchCarrier,
      item,
      {
        hexQ: pendingFighterLaunchPlacement.x,
        hexR: pendingFighterLaunchPlacement.z,
        heading: pendingFighterLaunchPlacement.heading,
      },
      { keepCarrierSelected: true },
    );
  }, [
    cancelFighterLaunchPlacement,
    launchFighterFromCarrierAtPoint,
    pendingFighterLaunchPlacement,
    pendingLaunchCarrier,
    pendingLaunchFighterModel,
    pendingLaunchPlacementLegal,
  ]);
  useEffect(() => {
    if (!pendingFighterLaunchPlacement) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      if (e.key === "Enter" || e.key === " " || e.code === "Space") {
        e.preventDefault();
        confirmFighterLaunchPlacement();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancelFighterLaunchPlacement();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [
    cancelFighterLaunchPlacement,
    confirmFighterLaunchPlacement,
    pendingFighterLaunchPlacement,
  ]);
  const recoverFighterToCarrier = useCallback(
    async (fighter: GameUnit, carrier: GameUnit) => {
      const key = `recover:${fighter.id}:${carrier.id}`;
      setFighterBayBusyKey(key);
      setFighterBayFeedback(null);
      try {
        const result = await customFetch<FighterBayActionResult>(
          `/api/games/${gameId}/units/${fighter.id}/recover-fighter`,
          {
            method: "POST",
            body: JSON.stringify({ carrierUnitId: carrier.id }),
            responseType: "json",
          },
        );
        mergeFighterBayResultIntoGame(result);
        setSelectedUnit(result.carrier.id);
        setFighterBayFeedback(`${fighter.name} recovered.`);
      } catch (err) {
        setFighterBayFeedback(cleanApiErrorMessage(err, "Recovery failed"));
      } finally {
        setFighterBayBusyKey(null);
        void qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
        void qc.invalidateQueries({ queryKey: ["movement-audit-log", gameId] });
      }
    },
    [gameId, mergeFighterBayResultIntoGame, qc],
  );
  const selectedRecoveryCarriers = useMemo(() => {
    if (
      !selectedUnitData ||
      !isFighterUnit(selectedUnitData) ||
      !selectedUnitData.launchedFromUnitId
    )
      return [];
    return units.filter(
      (unit) =>
        unit.ownerId === myUserId &&
        !unit.isDestroyed &&
        !isFighterUnit(unit) &&
        (unit.carriedFighters ?? []).some(
          (item) => item.available < item.total,
        ) &&
        uiBasesInContact(selectedUnitData, unit),
    );
  }, [isFighterUnit, myUserId, selectedUnitData, units]);
  const unitCanScoutSupport = useCallback(
    (unit: BoardUnit): boolean => {
      if (unit.isDestroyed || unit.scoutAction) return false;
      if (unit.specialAction) return false;
      if (unit.hullPoints <= 0) return false;
      if ((unit.maxCrewPoints ?? 0) > 0 && (unit.crewPoints ?? 0) <= 0)
        return false;
      if (
        unit.damageState === "adrift" ||
        unit.damageState === "exploding-end-of-next"
      )
        return false;
      const maxCrew = unit.maxCrewPoints ?? 0;
      if (maxCrew > 0 && (unit.crewPoints ?? 0) <= maxCrew / 2) return false;
      const traits = getShipModelForUnit(unit)?.traits ?? "";
      return /\bscout\b/i.test(traits);
    },
    [getShipModelForUnit],
  );
  const enemyHasStealthTrait = useCallback(
    (unit: BoardUnit): boolean => {
      const traits = getShipModelForUnit(unit)?.traits ?? "";
      return /\bstealth\s*\+?\d+/i.test(traits);
    },
    [getShipModelForUnit],
  );
  const unitRangeInches = useCallback((a: BoardUnit, b: BoardUnit): number => {
    return Math.hypot((b.hexQ ?? 0) - (a.hexQ ?? 0), (b.hexR ?? 0) - (a.hexR ?? 0));
  }, []);
  const declaredScoutActionBase = useCallback(
    (raw: string | null | undefined): "counter-stealth" | "coord" | null => {
      if (raw === "counter-stealth-declared") return "counter-stealth";
      if (raw === "coord-declared") return "coord";
      return null;
    },
    [],
  );
  const canDeclareScoutSupport =
    game?.status === "active" &&
    currentPhase === "movement" &&
    isMyActivation &&
    activeUnitReadyForActions &&
    selectedUnitData?.id === activeUnitId &&
    selectedUnitData.ownerId === myUserId &&
    unitCanScoutSupport(selectedUnitData) &&
    !selectedUnitData.hasMovedThisRound &&
    !(selectedUnitData as { hasInitiatedMoveThisActivation?: boolean })
      .hasInitiatedMoveThisActivation;
  const myDeclaredScoutSupportRows = useMemo(
    () =>
      units
        .map((unit) => ({
          unit,
          action: declaredScoutActionBase(unit.scoutAction),
        }))
        .filter(
          (
            row,
          ): row is {
            unit: BoardUnit;
            action: "counter-stealth" | "coord";
          } => row.unit.ownerId === myUserId && row.action !== null,
        ),
    [declaredScoutActionBase, myUserId, units],
  );
  const currentDeclaredScoutSupport = myDeclaredScoutSupportRows[0] ?? null;
  const myDeclaredScoutSupportOpen =
    game?.status === "active" &&
    currentPhase === "firing" &&
    myDeclaredScoutSupportRows.length > 0 &&
    scoutPicking === null &&
    scoutFeedback === null;
  const declaredScoutSupportBlocksFiring =
    game?.status === "active" &&
    currentPhase === "firing" &&
    myDeclaredScoutSupportRows.length > 0;
  const hasAvailableScoutCoordToken = useMemo(() => {
    return units.some(
      (u) =>
        u.ownerId === myUserId &&
        u.scoutAction === "coord" &&
        !u.scoutCoordConsumed &&
        !u.isDestroyed &&
        u.hullPoints > 0 &&
        ((u.maxCrewPoints ?? 0) <= 0 || (u.crewPoints ?? 0) > 0),
    );
  }, [myUserId, units]);
  useEffect(() => {
    if (!hasAvailableScoutCoordToken && useCoordOnNext) {
      setUseCoordOnNext(false);
    }
  }, [hasAvailableScoutCoordToken, useCoordOnNext]);
  const scoutSupportEffectsByTargetId = useMemo(() => {
    const effectsByTarget = new Map<number, ScoutSupportVisualEffect[]>();
    if (game?.status !== "active" || currentPhase !== "firing") {
      return effectsByTarget;
    }

    const addEffect = (
      targetId: number | null | undefined,
      effect: ScoutSupportVisualEffect,
    ) => {
      if (targetId == null) return;
      const current = effectsByTarget.get(targetId) ?? [];
      if (!current.includes(effect)) current.push(effect);
      effectsByTarget.set(targetId, current);
    };

    for (const unit of units) {
      if (unit.isDestroyed || unit.hullPoints <= 0) continue;
      if ((unit.maxCrewPoints ?? 0) > 0 && (unit.crewPoints ?? 0) <= 0) continue;
      if (
        unit.damageState === "adrift" ||
        unit.damageState === "exploding-end-of-next"
      ) {
        continue;
      }
      if (unit.scoutAction === "counter-stealth") {
        addEffect(unit.scoutActionTargetId, "counter-stealth");
      } else if (unit.scoutAction === "coord" && !unit.scoutCoordConsumed) {
        addEffect(unit.scoutActionTargetId, "coord");
      }
    }

    return effectsByTarget;
  }, [currentPhase, game?.status, units]);

  // Eligible-to-activate count for the current player in the current phase.
  // Mirrors the server's `remainingFor` filter so the UI can offer a "Pass
  // Phase" affordance when the player is active but has no legal moves —
  // otherwise they'd be stuck staring at "Pick a Ship" forever (e.g. every
  // remaining ship is destroyed, already activated this phase, or inert from
  // 0-hull / 0-crew in the firing phase).
  const unitPinnedInCurrentRound = useCallback(
    (unit: BoardUnit): boolean =>
      uiUnitPinnedForRound(unit, units, game?.currentRound ?? 0),
    [game?.currentRound, units],
  );
  const selectedMovementBlockedNotice = useMemo(() => {
    if (
      !selectedUnitData ||
      currentPhase !== "movement" ||
      selectedUnitData.ownerId !== myUserId ||
      selectedUnitData.isDestroyed
    ) {
      return null;
    }
    if (unitPinnedInCurrentRound(selectedUnitData)) {
      return "Movement unavailable: ship is pinned this round.";
    }
    if (
      selectedUnitData.damageState === "adrift" ||
      selectedUnitData.damageState === "exploding-end-of-next"
    ) {
      return "Movement unavailable: ship is drifting under critical damage.";
    }
    if (
      selectedUnitIsFighter &&
      dogfightingFighterUnitIds.has(selectedUnitData.id)
    ) {
      return "Movement unavailable: fighter is locked in a dogfight.";
    }
    if (
      !selectedUnitIsFighter &&
      selectedMovementSpeedBreakdown &&
      selectedMovementSpeedBreakdown.effectiveSpeed <= 0
    ) {
      const causes = selectedMovementSpeedBreakdown.shortReasons.length
        ? selectedMovementSpeedBreakdown.shortReasons.join("; ")
        : "no movement allowance";
      return `Ship speed is zero: ${causes}.`;
    }
    return null;
  }, [
    currentPhase,
    dogfightingFighterUnitIds,
    myUserId,
    selectedMovementSpeedBreakdown,
    selectedUnitData,
    selectedUnitIsFighter,
    unitPinnedInCurrentRound,
  ]);
  const unitEligibleForCurrentPhase = useCallback(
    (u: BoardUnit): boolean => {
      if (u.isDestroyed) return false;
      if (unitPinnedInCurrentRound(u)) return false;
      const phaseDone =
        currentPhase === "firing" ? u.hasFiredThisRound : u.hasMovedThisRound;
      if (phaseDone) return false;
      if (currentPhase === "firing") {
        if (u.hullPoints <= 0) return false;
        const maxCrew = u.maxCrewPoints ?? 0;
        const crew = u.crewPoints ?? 0;
        if (maxCrew > 0 && crew <= 0) return false;
      } else {
        if (
          u.damageState === "adrift" ||
          u.damageState === "exploding-end-of-next"
        )
          return false;
        if (
          isFighterUnit(u) &&
          enemyFighterContactsForUnit({ ...u, isFighter: true }).length > 0
        )
          return false;
      }
      return true;
    },
    [
      currentPhase,
      enemyFighterContactsForUnit,
      isFighterUnit,
      unitPinnedInCurrentRound,
    ],
  );
  const activationSegment = useMemo<"capital" | "fighter" | null>(() => {
    if (currentPhase !== "movement" && currentPhase !== "firing") return null;
    const eligible = units.filter(unitEligibleForCurrentPhase);
    const hasFighter = eligible.some(isFighterUnit);
    const hasCapital = eligible.some((u) => !isFighterUnit(u));
    if (currentPhase === "firing") {
      return hasFighter ? "fighter" : hasCapital ? "capital" : null;
    }
    return hasCapital ? "capital" : hasFighter ? "fighter" : null;
  }, [
    currentPhase,
    isFighterUnit,
    unitEligibleForCurrentPhase,
    units,
  ]);
  const myEligibleActivations = useMemo(() => {
    if (!isMyActivation || !myUserId) return 0;
    return units.filter((u) => {
      if (u.ownerId !== myUserId) return false;
      if (!unitEligibleForCurrentPhase(u)) return false;
      if (activationSegment === "fighter" && !isFighterUnit(u)) return false;
      if (activationSegment === "capital" && isFighterUnit(u)) return false;
      return true;
    }).length;
  }, [
    activationSegment,
    isFighterUnit,
    isMyActivation,
    myUserId,
    unitEligibleForCurrentPhase,
    units,
  ]);
  const canPassPhase =
    isMyActivation && !hasActiveUnit && myEligibleActivations === 0;
  const canPassAllFiring =
    isMyActivation &&
    currentPhase === "firing" &&
    activationSegment !== null &&
    !antiFighterState;
  const passAllFiringLabel =
    activationSegment === "fighter"
      ? "Pass All Fighter Firing"
      : "Pass All Ship Firing";
  const passAllFiringPendingLabel =
    activationSegment === "fighter"
      ? "Passing Fighters..."
      : "Passing Ships...";
  const passAllFiringConfirmLabel =
    activationSegment === "fighter"
      ? "Confirm Pass Fighters"
      : "Confirm Pass Ships";
  const activationPickLabel =
    activationSegment === "fighter" ? "Pick a Fighter Flight" : "Pick a Ship";
  const activationPassLabel =
    activationSegment === "fighter"
      ? "No eligible fighter flights - pass to opponent"
      : "No eligible ships - pass the phase";
  const { data: attackAuditData } = useQuery<AttackAuditLogResponse>({
    queryKey: ["attack-audit-log", gameId],
    queryFn: () =>
      customFetch<AttackAuditLogResponse>(
        `/api/games/${gameId}/attack-audit-log?limit=80`,
      ),
    enabled: !!gameId && (game?.status === "active" || game?.status === "completed"),
    refetchInterval:
      game?.status === "active" && !pausePollingRef.current
        ? POLL_INTERVAL_MS
        : false,
  });
  const { data: movementAuditData } = useQuery<
    AuditLogResponse<MovementAuditLogEntry>
  >({
    queryKey: ["movement-audit-log", gameId],
    queryFn: () =>
      customFetch<AuditLogResponse<MovementAuditLogEntry>>(
        `/api/games/${gameId}/movement-audit-log?limit=80`,
      ),
    enabled: !!gameId && (game?.status === "active" || game?.status === "completed"),
    refetchInterval:
      game?.status === "active" && !pausePollingRef.current
        ? POLL_INTERVAL_MS
        : false,
  });
  const { data: specialActionAuditData } = useQuery<
    AuditLogResponse<SpecialActionAuditLogEntry>
  >({
    queryKey: ["special-action-audit-log", gameId],
    queryFn: () =>
      customFetch<AuditLogResponse<SpecialActionAuditLogEntry>>(
        `/api/games/${gameId}/special-action-audit-log?limit=80`,
      ),
    enabled: !!gameId && (game?.status === "active" || game?.status === "completed"),
    refetchInterval:
      game?.status === "active" && !pausePollingRef.current
        ? POLL_INTERVAL_MS
        : false,
  });
  const battleLogEntries = useMemo<BattleLogEntry[]>(() => {
    const entries: BattleLogEntry[] = [
      ...(movementAuditData?.logs ?? []).map((log) => ({
        id: `movement-${log.id}`,
        source: "movement" as const,
        round: log.round,
        phase: log.phase,
        actorKind: log.actorKind,
        actorPlayerId: log.actorPlayerId,
        summary: log.summary,
        createdAt: log.createdAt,
      })),
      ...(specialActionAuditData?.logs ?? []).map((log) => ({
        id: `special-${log.id}`,
        source:
          log.action === "anti-fighter"
            ? ("anti-fighter" as const)
            : ("special" as const),
        round: log.round,
        phase: log.phase,
        actorKind: log.actorKind,
        actorPlayerId: log.actorPlayerId,
        summary: log.summary,
        createdAt: log.createdAt,
      })),
      ...(attackAuditData?.logs ?? []).map((log) => ({
        id: `firing-${log.id}`,
        source: "firing" as const,
        round: log.round,
        phase: log.phase,
        actorKind: log.actorKind,
        actorPlayerId: log.actorPlayerId,
        summary: log.summary,
        createdAt: log.createdAt,
      })),
    ];
    return entries
      .sort((a, b) => {
        const timeDelta =
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        if (timeDelta !== 0) return timeDelta;
        return b.id.localeCompare(a.id);
      })
      .slice(0, 80);
  }, [
    attackAuditData?.logs,
    movementAuditData?.logs,
    specialActionAuditData?.logs,
  ]);
  const lastOpponentAttackSummary = useMemo(() => {
    if (!game || currentPhase !== "firing") return null;
    const logs = attackAuditData?.logs ?? [];
    const lastOpponentLog = [...logs].reverse().find((log) => {
      if (log.round !== game.currentRound || log.phase !== "firing")
        return false;
      if (log.actorKind === "ai") return myUserId !== AI_OPPONENT_ID;
      return !!log.actorPlayerId && log.actorPlayerId !== myUserId;
    });
    return lastOpponentLog ? attackAuditSummary(lastOpponentLog, units) : null;
  }, [attackAuditData?.logs, currentPhase, game, myUserId, units]);

  // Movement-phase minimum-speed gate (mirrors the server check in
  // /end-activation). A ship must either move at least half speed
  // inches this activation OR declare All Stop / All Stop and Pivot,
  // unless it is adrift (which has its own compulsory-drift gate).
  // We surface this in the UI so the End Activation button explains
  // itself instead of just bouncing off the server with a 400.
  const activeUnitData = hasActiveUnit
    ? (units.find((u) => u.id === activeUnitId) ?? null)
    : null;
  const activeTargetingPreview = useMemo(() => {
    if (
      !activeUnitReadyForActions ||
      currentPhase !== "firing" ||
      activeUnitId === null
    ) {
      return null;
    }
    const attacker = unitsWithFighterFlags.find((u) => u.id === activeUnitId);
    if (!attacker || attacker.ownerId !== myUserId || attacker.isDestroyed) {
      return null;
    }
    const weapon =
      splitFirePlan?.attackerUnitId === attacker.id
        ? splitFirePlan.weapon
        : firingWeaponPicking !== null
          ? getWeaponsForUnit(attacker).find((w) => w.id === firingWeaponPicking)
          : undefined;
    if (!weapon) return null;
    return { attacker, weapon };
  }, [
    activeUnitId,
    activeUnitReadyForActions,
    currentPhase,
    firingWeaponPicking,
    getWeaponsForUnit,
    myUserId,
    splitFirePlan,
    unitsWithFighterFlags,
  ]);
  const minMoveGate = useMemo(() => {
    if (!activeUnitData || currentPhase !== "movement") {
      return { blocked: false, required: 0, moved: 0 };
    }
    if (unitPinnedInCurrentRound(activeUnitData)) {
      return { blocked: false, required: 0, moved: 0 };
    }
    if (
      activeUnitData.damageState === "adrift" ||
      activeUnitData.damageState === "exploding-end-of-next"
    ) {
      return { blocked: false, required: 0, moved: 0 };
    }
    const baseSA = (activeUnitData.specialAction ?? "").replace(/-failed$/, "");
    if (baseSA === "all-stop" || baseSA === "all-stop-pivot") {
      return { blocked: false, required: 0, moved: 0 };
    }
    const movementTraits = uiMovementTraitsForModel(
      getShipModelForUnit(activeUnitData),
      activeUnitData,
    );
    if (movementTraits.superManeuverable) {
      return { blocked: false, required: 0, moved: 0 };
    }
    // Client doesn't know every server-side speed adjustment, so this is a
    // best-effort floor. Use the merged movement ledger rather than only the
    // unit row field so a rejected follow-up turn cannot leave the end button
    // stuck behind stale movement data.
    const activeEffectiveSpeed = effectiveUiSpeed(activeUnitData);
    const required =
      activeEffectiveSpeed > 0 ? Math.max(1, activeEffectiveSpeed / 2) : 0;
    const moved = getLedger(activeUnitData.id).distance;
    return { blocked: moved < required, required, moved };
  }, [
    activeUnitData,
    currentPhase,
    getLedger,
    getShipModelForUnit,
    unitPinnedInCurrentRound,
  ]);
  const activeActivationCommitted = useMemo(() => {
    if (!activeUnitData) return false;
    if (currentPhase === "firing") {
      return ((activeUnitData.firedWeaponIds ?? []) as number[]).length > 0;
    }
    if (currentPhase !== "movement") return false;
    const led = getLedger(activeUnitData.id);
    return (
      led.distance > 0 || led.turns > 0 || Boolean(activeUnitData.specialAction)
    );
  }, [activeUnitData, currentPhase, getLedger]);
  const canConfirmMovePlan =
    !!movePlan &&
    !moveUnit.isPending &&
    !activateUnit.isPending &&
    (movePlan.kind === "forward"
      ? movePlan.distance > 0
      : movePlan.kind === "turn"
        ? Math.abs(movePlan.deltaDeg) > 0
        : selectedUnitData
          ? Math.hypot(
              movePlan.x - selectedUnitData.hexQ,
              movePlan.z - selectedUnitData.hexR,
            ) > 0.001 ||
            headingDeltaDegrees(selectedUnitData.heading, movePlan.heading) > 0
          : false);
  const canUsePcMoveConfirmPopover =
    !isTouchInput &&
    !mobileGameChrome &&
    currentPhase === "movement" &&
    isSelectedUnitActive &&
    canConfirmMovePlan;
  const canEndActivationFromPcMovePopover =
    canUsePcMoveConfirmPopover &&
    hasActiveUnit &&
    !canPassPhase &&
    !minMoveGate.blocked &&
    !moveUnit.isPending &&
    !activateUnit.isPending &&
    !endActivation.isPending;
  useEffect(() => {
    if (!canUsePcMoveConfirmPopover) setMoveConfirmPopover(null);
  }, [canUsePcMoveConfirmPopover]);
  const tabletMoveHint = useMemo(() => {
    if (!selectedMovementUi) return "";
    if (activateUnit.isPending) return "Activating ship...";
    if (moveUnit.isPending) return "Committing movement...";
    if (selectedMovementUi.turnsForbidden)
      return "Current action forbids turns.";
    if (selectedMovementUi.canTurn) {
      return selectedMovementUi.isSuperManeuverable
        ? "Turn ready: tap left/right, or curved arrow for free turn."
        : "Turn ready: tap left or right.";
    }
    const forwardPreview =
      movePlan?.kind === "forward"
        ? snapMovementDistance(movePlan.distance)
        : 0;
    const previewStraight =
      selectedMovementUi.distanceSinceLastTurn + forwardPreview;
    if (
      !selectedMovementUi.turnGateExempt &&
      !Number.isFinite(selectedMovementUi.neededStraight)
    ) {
      return "Effective Speed is 0; ordinary turns require movement or All Stop and Pivot.";
    }
    if (
      forwardPreview > 0 &&
      !selectedMovementUi.turnGateExempt &&
      previewStraight + 1e-6 >= selectedMovementUi.neededStraight
    ) {
      return "Confirm forward movement to unlock turning.";
    }
    if (
      !selectedMovementUi.turnGateExempt &&
      selectedMovementUi.neededStraight > 0
    ) {
      const remaining = Math.max(
        0,
        selectedMovementUi.neededStraight -
          selectedMovementUi.distanceSinceLastTurn,
      );
      return `Move ${remaining.toFixed(remaining % 1 === 0 ? 0 : 1)}" straight before turning.`;
    }
    return "Turn unavailable.";
  }, [
    activateUnit.isPending,
    movePlan,
    moveUnit.isPending,
    selectedMovementUi,
  ]);

  const nudgeForwardPlan = useCallback(
    (delta: number) => {
      if (!selectedMovementUi || moveUnit.isPending || activateUnit.isPending)
        return;
      if (delta > 0 && !selectedMovementUi.canForward) return;
      if (delta < 0 && (movePlan?.kind !== "forward" || movePlan.distance <= 0))
        return;
      if (!selectedUnitData) return;
      if (
        isFighterUnit(selectedUnitData) &&
        dogfightingFighterUnitIds.has(selectedUnitData.id)
      ) {
        setActivationFeedback(
          "Fighter is locked in a dogfight; use the Dogfight action instead.",
        );
        return;
      }

      setMovementGesture({ kind: "forward" });
      setMovePlan((prev) => {
        const current = prev?.kind === "forward" ? prev.distance : 0;
        const requested = Math.max(
          0,
          Math.min(
            selectedRemainingMove,
            snapMovementDistance(current + delta),
          ),
        );
        const v = headingForwardVec(selectedUnitData);
        const next = clampForwardDistanceToLegalRestingSpot(
          { ...selectedUnitData, isFighter: isFighterUnit(selectedUnitData) },
          unitsWithFighterFlags,
          v,
          requested,
          selectedRemainingMove,
          delta > 0 ? "forward" : "nearest",
        );
        return { kind: "forward", distance: next };
      });
    },
    [
      activateUnit.isPending,
      movePlan,
      moveUnit.isPending,
      selectedMovementUi,
      selectedRemainingMove,
      selectedUnitData,
      unitsWithFighterFlags,
      isFighterUnit,
      dogfightingFighterUnitIds,
    ],
  );

  const nudgeTurnPlan = useCallback(
    (deltaDeg: number, visualDirection?: "left" | "right") => {
      if (
        !selectedMovementUi?.canTurn ||
        moveUnit.isPending ||
        activateUnit.isPending
      )
        return;
      if (selectedUnitData && isFighterUnit(selectedUnitData)) {
        if (dogfightingFighterUnitIds.has(selectedUnitData.id)) {
          setActivationFeedback(
            "Fighter is locked in a dogfight; use the Dogfight action instead.",
          );
          return;
        }
        const headingDelta = visualTurnDeltaToHeadingDelta(
          selectedUnitData.modelFilename,
          deltaDeg,
        );
        setMovementGesture({
          kind: "turn",
          direction: visualDirection ?? (deltaDeg < 0 ? "left" : "right"),
        });
        setMovePlan((prev) => {
          const current =
            prev?.kind === "fighter-free"
              ? prev
              : {
                  kind: "fighter-free" as const,
                  x: selectedUnitData.hexQ,
                  z: selectedUnitData.hexR,
                  heading: selectedUnitData.heading,
                };
          return {
            ...current,
            heading: (((current.heading + headingDelta) % 360) + 360) % 360,
          };
        });
        return;
      }
      const direction = visualDirection ?? (deltaDeg < 0 ? "left" : "right");
      setMovementGesture({ kind: "turn", direction });
      setMovePlan((prev) => {
        const current = prev?.kind === "turn" ? prev.deltaDeg : 0;
        const next = Math.max(
          -selectedMovementUi.angleCap,
          Math.min(selectedMovementUi.angleCap, current + deltaDeg),
        );
        return { kind: "turn", deltaDeg: next };
      });
    },
    [
      activateUnit.isPending,
      isFighterUnit,
      moveUnit.isPending,
      selectedMovementUi,
      selectedUnitData,
      dogfightingFighterUnitIds,
    ],
  );

  const startFreeTurnPlan = useCallback(() => {
    if (
      !selectedMovementUi?.canTurn ||
      !selectedMovementUi.isSuperManeuverable ||
      moveUnit.isPending ||
      activateUnit.isPending
    )
      return;
    setMovementGesture({ kind: "turn", direction: "free" });
    if (selectedUnitData && isFighterUnit(selectedUnitData)) {
      if (dogfightingFighterUnitIds.has(selectedUnitData.id)) {
        setActivationFeedback(
          "Fighter is locked in a dogfight; use the Dogfight action instead.",
        );
        return;
      }
      setMovePlan((prev) =>
        prev?.kind === "fighter-free"
          ? prev
          : {
              kind: "fighter-free",
              x: selectedUnitData.hexQ,
              z: selectedUnitData.hexR,
              heading: selectedUnitData.heading,
            },
      );
      return;
    }
    setMovePlan((prev) =>
      prev?.kind === "turn" ? prev : { kind: "turn", deltaDeg: 0 },
    );
  }, [
    activateUnit.isPending,
    isFighterUnit,
    moveUnit.isPending,
    selectedMovementUi,
    selectedUnitData,
    dogfightingFighterUnitIds,
  ]);

  const boardPointHasUnit = useCallback(
    (x: number, z: number): boolean => {
      for (const unit of units) {
        const dx = x - unit.hexQ;
        const dz = z - unit.hexR;
        const radius = rulesBaseRadius(unit) + 0.18;
        if (dx * dx + dz * dz <= radius * radius) return true;
      }
      for (const unit of currentStagedUnits) {
        const dx = x - unit.x;
        const dz = z - unit.z;
        if (dx * dx + dz * dz <= 1.8 * 1.8) return true;
      }
      return false;
    },
    [currentStagedUnits, units],
  );

  // Reset per-activation firing state whenever the active unit changes (new
  // ship picked up, or the previous activation ended). Server clears its own
  // ledger on /activate-unit; we just clear the optimistic overlay + picker.
  useEffect(() => {
    setPendingFired(null);
    setFiringWeaponPicking(null);
    // Also drop the in-flight guard so a stale latch from a previous
    // activation (e.g. a request that never settled, or the player ended
    // activation mid-roll) can't permanently block firing on the next ship.
    firingInFlightRef.current = false;
  }, [activeUnitId, currentPhase]);

  useEffect(() => {
    if (!activeFighterLockedInDogfight) return;
    setFiringWeaponPicking(null);
    setSplitFirePlan(null);
  }, [activeFighterLockedInDogfight, activeUnitId]);

  useEffect(() => {
    if (!selectedFighterLockedInDogfight || movePlan?.kind !== "fighter-free")
      return;
    setMovePlan(null);
    setMovementGesture(null);
    setMoveConfirmPopover(null);
  }, [movePlan?.kind, selectedFighterLockedInDogfight]);

  // Wipe per-activation Special Action UI state when the active unit changes
  // (handoff, end-activation, or round rollover). The server still owns the
  // committed action on the unit row; these are purely transient affordances.
  useEffect(() => {
    setSpecialActionFeedback(null);
    setSpecialActionTargetPicking(null);
  }, [activeUnitId]);

  // ── Adrift auto-drift ───────────────────────────────────────────────────────
  // When the player activates a ship whose damageState is `adrift` or
  // `exploding-end-of-next`, the engine auto-drifts it floor(speed/2) inches
  // straight ahead and ends the activation. No player input — the player
  // has no meaningful movement choice for a derelict ship anyway, so we
  // skip the planner UI entirely. The dispatch ref guards against React
  // strict-mode double-invokes and against re-firing while the server
  // call is in flight.
  // ── Compulsory drift commit ─────────────────────────────────────────────────
  // Adrift / about-to-explode ships have no movement choices — they must
  // drift their half-speed forward along current heading, after which the
  // activation ends. We used to fire this automatically the moment the
  // ship was activated, but that looked exactly like "I picked the ship
  // up and it locked instantly" to a player who hadn't realised an
  // Engines Disabled crit made the ship adrift. Now the drift is an
  // explicit button (rendered in the sidebar Adrift-Drift panel) so the
  // player sees what's about to happen and approves it. The shared
  // commit handler lives here so the panel button and the (still-valid)
  // keyboard fallback can both reuse it.
  const isAdriftActive = useMemo(() => {
    if (!selectedUnitData || !isSelectedUnitActive) return false;
    if (currentPhase !== "movement") return false;
    return (
      selectedUnitData.damageState === "adrift" ||
      selectedUnitData.damageState === "exploding-end-of-next"
    );
  }, [selectedUnitData, isSelectedUnitActive, currentPhase]);
  const commitDriftRef = useRef(false);
  const commitCompulsoryDrift = useCallback(() => {
    if (!selectedUnitData) return;
    if (commitDriftRef.current) return;
    if (moveUnit.isPending || endActivation.isPending) return;
    const u = selectedUnitData;
    commitDriftRef.current = true;
    const driftDistance = Math.floor(u.speed / 2);
    const v = headingForwardVec(u);
    const toHexQ = Math.round(u.hexQ + v.x * driftDistance);
    const toHexR = Math.round(u.hexR + v.z * driftDistance);
    moveUnit.mutate(
      { gameId, unitId: u.id, data: { toHexQ, toHexR, newHeading: u.heading } },
      {
        onSuccess: (updatedUnit) => {
          const moveResult = updatedUnit as GameUnit & {
            game?: GameDetail["game"];
          };
          const { game: updatedGame, ...unitOnly } = moveResult;
          if (updatedGame) mergeGameIntoCache(updatedGame);
          mergeUpdatedUnitIntoGame(unitOnly as GameUnit);
          showTerrainHazardsForMove(unitOnly as TerrainHazardMoveResult);
          qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
          endActivation.mutate(
            { gameId },
            {
              onSuccess: () => {
                qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
                setSelectedUnit(null);
                commitDriftRef.current = false;
              },
              onError: () => {
                commitDriftRef.current = false;
              },
            },
          );
        },
        onError: () => {
          commitDriftRef.current = false;
        },
      },
    );
  }, [
    selectedUnitData,
    moveUnit,
    endActivation,
    gameId,
    qc,
    mergeGameIntoCache,
    mergeUpdatedUnitIntoGame,
    showTerrainHazardsForMove,
  ]);
  // Reset the in-flight latch whenever the active unit changes so a new
  // adrift activation can drift on its own button click.
  useEffect(() => {
    commitDriftRef.current = false;
  }, [activeUnitId]);
  useEffect(() => {
    setFiringWeaponPicking(null);
    setSplitFirePlan(null);
  }, [activeUnitId, currentPhase]);

  const handleUnitFocus = useCallback(
    (unitId: number) => {
      const unit = units.find((u) => u.id === unitId);
      if (!unit) return;
      const [x, , z] = hexToWorld(unit.hexQ, unit.hexR);
      setSelectedUnit(unitId);
      setCameraFocusRequest({ seq: Date.now(), x, z });
    },
    [units],
  );

  const focusBoardCamera = useCallback(() => {
    setCameraFocusRequest({
      seq: Date.now(),
      x: 0,
      z: 0,
      distance:
        cameraViewMode === "iso"
          ? ISO_CAMERA_DISTANCE
          : TOP_DOWN_CAMERA_DISTANCE,
      targetHeight: BOARD_FOCUS_TARGET_HEIGHT,
    });
  }, [cameraViewMode]);

  const setTacticalCameraView = useCallback((mode: TacticalCameraViewMode) => {
    setCameraViewMode(mode);
    setCameraViewRequest({ seq: Date.now(), mode });
  }, []);

  const toggleCameraOrientationLock = useCallback(() => {
    setCameraOrientationLocked((prev) => !prev);
  }, []);

  const handleUnitClick = (unitId: number) => {
    const unit = units.find((u) => u.id === unitId);
    if (!unit || unit.isDestroyed) return;
    if (pendingFighterLaunchPlacement) {
      setFighterBayFeedback(
        "Tap a legal board point within the launch ring, or cancel placement.",
      );
      return;
    }

    // ── MOVEMENT-PHASE: targeted Special Action picker ──
    // Clicking an enemy ship while picking a target submits the action.
    if (
      game?.status === "active" &&
      isMyActivation &&
      currentPhase === "movement" &&
      specialActionTargetPicking &&
      hasActiveUnit &&
      unit.ownerId !== myUserId
    ) {
      const attackerUnitId = activeUnitId!;
      const targetId = unit.id;
      const action = specialActionTargetPicking;
      setSpecialActionTargetPicking(null);
      chooseSpecialAction.mutate(
        {
          gameId,
          unitId: attackerUnitId,
          data: { action, targetUnitId: targetId },
        },
        {
          onSuccess: (res) => {
            setSpecialActionFeedback({
              action: res.action,
              success: res.success,
              cqRoll: res.cqRoll ?? null,
              cqTotal: res.cqTotal ?? null,
              cqRequired: res.cqRequired ?? null,
            });
            mergeUpdatedUnitIntoGame(res.unit);
            qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
          },
          onError: (err: any) => {
            setSpecialActionFeedback({
              action,
              success: false,
              cqRoll: null,
              cqTotal: null,
              cqRequired: null,
            });
            setActivationFeedback(
              cleanApiErrorMessage(err, "Special action failed"),
            );
          },
        },
      );
      return;
    }

    // ── SCOUT SUPPORT target click ──
    // While a Scout-support action is in pick-mode, clicking an enemy ship
    // declares the action against that target during the shared pre-fire
    // window. This takes priority over the weapon picker.
    if (
      game?.status === "active" &&
      currentPhase === "firing" &&
      scoutPicking !== null &&
      unit.ownerId !== myUserId
    ) {
      if (scoutActionInFlightRef.current || chooseScoutAction.isPending) return;
      const scout = units.find((u) => u.id === scoutPicking.scoutUnitId);
      if (!scout || scout.ownerId !== myUserId) return;
      const declared = scoutPicking.action;
      if (unitRangeInches(scout, unit) > 36) {
        setActivationFeedback(
          `${declared === "counter-stealth" ? "Counter-Stealth" : "Coordinate Fire"} target is outside Scout range.`,
        );
        return;
      }
      if (declared === "counter-stealth" && !enemyHasStealthTrait(unit)) {
        setActivationFeedback("Counter-Stealth requires an enemy with Stealth.");
        return;
      }
      setScoutPicking(null);
      scoutActionInFlightRef.current = true;
      chooseScoutAction.mutate(
        {
          gameId,
          unitId: scout.id,
          data: { action: declared, targetUnitId: unit.id },
        },
        {
          onSuccess: (res) => {
            scoutActionInFlightRef.current = false;
            if ((res as { alreadyResolved?: boolean }).alreadyResolved) {
              mergeUpdatedUnitIntoGame(res.unit);
              qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
              return;
            }
            setScoutFeedback({
              action: res.action,
              scoutName: scout.name,
              crewQuality: scout.crewQuality,
              success: res.success,
              cqRoll: res.cqRoll ?? null,
              cqTotal: res.cqTotal ?? null,
              cqRequired: res.cqRequired ?? null,
            });
            mergeUpdatedUnitIntoGame(res.unit);
            qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
          },
          onError: (err: any) => {
            scoutActionInFlightRef.current = false;
            const message = cleanApiErrorMessage(err, "Scout action failed");
            setScoutFeedback({
              action: declared,
              scoutName: scout.name,
              crewQuality: scout.crewQuality,
              success: false,
              cqRoll: null,
              cqTotal: null,
              cqRequired: 8,
              error: message,
            });
            setActivationFeedback(message);
          },
        },
      );
      return;
    }

    // ── FIRING-PHASE target click ──
    // While picking a target for a weapon, clicking an enemy ship resolves
    // the shot immediately via the server.
    if (
      game?.status === "active" &&
      isMyActivation &&
      currentPhase === "firing" &&
      hasActiveUnit &&
      (firingWeaponPicking !== null || splitFirePlan !== null) &&
      unit.ownerId === myUserId
    ) {
      if (unit.id !== activeUnitId) {
        setActivationFeedback(
          "Targeting is active. Click an enemy target or cancel the weapon pick before selecting another unit.",
        );
      }
      return;
    }

    if (
      game?.status === "active" &&
      isMyActivation &&
      currentPhase === "firing" &&
      hasActiveUnit &&
      !activeUnitReadyForActions &&
      unit.ownerId !== myUserId
    ) {
      setActivationFeedback(
        "Activation is still syncing. Try the target again in a moment.",
      );
      return;
    }

    if (
      game?.status === "active" &&
      isMyActivation &&
      currentPhase === "firing" &&
      splitFirePlan !== null &&
      activeUnitReadyForActions &&
      unit.ownerId !== myUserId
    ) {
      if (splitFireCommitting || firingInFlightRef.current) return;
      const attacker = units.find((u) => u.id === splitFirePlan.attackerUnitId);
      if (attacker) {
        const losBlock = weaponLineOfSightBlockForPreview(
          attacker,
          unit,
          lineOfSightObstacles,
        );
        if (losBlock) {
          setActivationFeedback(
            `Line of sight is blocked by ${losBlock.obstacle.name}.`,
          );
          return;
        }
      }
      if (splitFirePlan.firstTargetId == null) {
        setSplitFirePlan((plan) =>
          plan
            ? {
                ...plan,
                firstTargetId: unit.id,
                firstTargetName: unit.name,
              }
            : plan,
        );
        setActivationFeedback(
          `Split fire: ${unit.name} selected as target one. Pick target two.`,
        );
        return;
      }
      void commitSplitFire(splitFirePlan, unit);
      return;
    }

    if (
      game?.status === "active" &&
      isMyActivation &&
      currentPhase === "firing" &&
      dogfightTargetPicking &&
      firingWeaponPicking === null &&
      splitFirePlan === null &&
      activeUnitReadyForActions &&
      unit.ownerId !== myUserId
    ) {
      const attacker = unitsWithFighterFlags.find((u) => u.id === activeUnitId);
      const target = unitsWithFighterFlags.find((u) => u.id === unitId);
      if (
        attacker?.isFighter &&
        target?.isFighter &&
        uiBasesInContact(attacker, target)
      ) {
        void resolveDogfight(target.id);
        return;
      }
    }

    if (
      game?.status === "active" &&
      isMyActivation &&
      currentPhase === "firing" &&
      firingWeaponPicking !== null &&
      activeUnitReadyForActions &&
      unit.ownerId !== myUserId
    ) {
      // Re-entry guard: a single user click on a ship produces multiple R3F
      // onClick events (one per intersected child mesh in the unit group).
      // Bail synchronously on the 2nd..Nth duplicates so we don't fire the
      // same weapon multiple times and turn the first (successful) shot
      // into a confusing "already fired" error in the dice modal.
      if (firingInFlightRef.current) return;
      const attacker = units.find((u) => u.id === activeUnitId);
      const weapon = attacker
        ? getWeaponsForUnit(attacker).find((w) => w.id === firingWeaponPicking)
        : undefined;
      if (!attacker || !weapon) return;
      if (
        isFighterUnit(attacker) &&
        enemyFighterContactsForUnit({ ...attacker, isFighter: true }).length > 0
      ) {
        setFiringWeaponPicking(null);
        setActivationFeedback(
          "This fighter is locked in a dogfight; use the Dogfight action instead.",
        );
        return;
      }
      if (
        isFighterUnit(unit) &&
        enemyFighterContactsForUnit({ ...unit, isFighter: true }).length > 0
      ) {
        setActivationFeedback(
          "Target fighter is locked in a dogfight and cannot be attacked by normal weapons.",
        );
        return;
      }
      const losBlock = weaponLineOfSightBlockForPreview(
        attacker,
        unit,
        lineOfSightObstacles,
      );
      if (losBlock) {
        setActivationFeedback(
          `Line of sight is blocked by ${losBlock.obstacle.name}.`,
        );
        return;
      }
      const firingUnitId = attacker.id;
      setFiringWeaponPicking(null);
      setSplitFirePlan(null);
      // Stage the target selection only. The weapon is not marked fired and
      // no server mutation runs until the player presses Roll to Hit.
      setDiceModal({
        weapon,
        attackerUnitId: firingUnitId,
        targetName: unit.name,
        targetId: unit.id,
        attackDice: weapon.attackDice,
        useScoutCoordination: useCoordOnNext || undefined,
        phase: "target-picked",
      });
      return;
    }

    // Legacy attack-queue path (movement phase / legacy submitTurn flow).
    if (
      currentPhase === "movement" &&
      selectedUnit &&
      selectedUnit !== unitId &&
      unit.ownerId !== myUserId
    ) {
      const attacker = units.find((u) => u.id === selectedUnit);
      if (attacker && attacker.ownerId === myUserId) {
        setTurnAttacks((prev) => [
          ...prev.filter((a) => a.attackerUnitId !== selectedUnit),
          { attackerUnitId: selectedUnit, targetUnitId: unitId },
        ]);
        setAttackTarget(unitId);
      }
      return;
    }

    if (unit.ownerId !== myUserId) return;

    // Activation model: clicking an own ship picks the next activation. The
    // server enforces this — UI only fires when it's actually our turn AND
    // the ship hasn't done THIS phase's activation yet AND nothing else is
    // currently activated.
    //
    // The End Phase has NO per-ship activation (it's the Damage Control /
    // All Hands window), so we deliberately skip this block then. Otherwise
    // `phaseDone` (= hasMovedThisRound, always true by the End Phase) would
    // make the swap guard bail at `if (phaseDone) return`, and the click
    // would never select the ship — leaving the player unable to open the
    // crit / Damage Control panel. End-phase clicks fall through to the
    // plain inspection-selection path below.
    if (game?.status === "active" && isMyActivation && currentPhase !== "end") {
      const isCurrentlyActive = activeUnitId === unitId;
      const phaseDone =
        currentPhase === "firing"
          ? unit.hasFiredThisRound
          : unit.hasMovedThisRound;
      if (unitPinnedInCurrentRound(unit)) {
        setSelectedUnit(unitId);
        setActivationFeedback(
          `${unit.name} is physically disrupted and cannot act this turn. It does not count as an eligible activation; pass the phase if no other units remain.`,
        );
        return;
      }
      // Firing-phase eligibility: a ship at 0 hull or 0 crew (when it has
      // a crew complement at all) can no longer fire — mirrors the server
      // check in /activate. Clicking such a ship in the firing phase is a
      // no-op so the player doesn't waste a server round-trip on a 400.
      const firingIneligible =
        currentPhase === "firing" &&
        (unit.hullPoints <= 0 ||
          ((unit.maxCrewPoints ?? 0) > 0 && (unit.crewPoints ?? 0) <= 0));
      if (firingIneligible) {
        setSelectedUnit(unitId);
        setActivationFeedback(
          `${unit.name} cannot fire: no surviving hull or crew.`,
        );
        return;
      }
      const unitIsFighter = isFighterUnit(unit);
      if (activationSegment === "fighter" && !unitIsFighter) {
        setSelectedUnit(unitId);
        setActivationFeedback(
          currentPhase === "movement"
            ? "Capital ships have finished moving; activate fighter flights now."
            : "Fighter flights fire before capital ships this phase.",
        );
        return;
      }
      if (activationSegment === "capital" && unitIsFighter) {
        setSelectedUnit(unitId);
        setActivationFeedback(
          currentPhase === "movement"
            ? "Capital ships must move before fighter flights."
            : "Capital ships still have firing activations pending.",
        );
        return;
      }
      if (!hasActiveUnit && !phaseDone) {
        // Pick this ship up for its activation.
        if (activateUnit.isPending) return;
        setActivationAttemptDebug({
          unitId,
          unitName: unit.name,
          phase: currentPhase,
          source: "pick",
          startedAt: new Date().toISOString(),
        });
        setSelectedUnit(unitId);
        setOptimisticActiveUnitId(unitId);
        setActivationFeedback(null);
        setMoveTarget(null);
        setAttackTarget(null);
        activateUnit.mutate(
          { gameId, unitId },
          {
            onSuccess: () => {
              setActivationAttemptDebug(null);
              mergeActiveUnitIntoGame(unitId);
              setOptimisticActiveUnitId(null);
              qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
            },
            onError: (err: any) => {
              setActivationAttemptDebug(null);
              setOptimisticActiveUnitId(null);
              setSelectedUnit(null);
              setActivationFeedback(
                `Cannot activate ${unit.name}: ${cleanApiErrorMessage(err)}`,
              );
            },
          },
        );
        return;
      }
      if (isCurrentlyActive) {
        // Selection/focus is not a committal activation choice. Keep the
        // active ship selected so a double-click camera focus cannot leave
        // the player in a visually deselected "locked-in" state.
        setSelectedUnit(unitId);
        setActivationFeedback(null);
        setMoveTarget(null);
        setAttackTarget(null);
        return;
      }
      // hasActiveUnit && different own ship: attempt to SWAP the activation.
      // The server allows this only if the current pick has made no committal
      // action yet (no movement / SA in movement phase; no shot fired in
      // firing phase). On rejection, the prior activation stays put and we
      // surface the server's reason via the existing error toast path.
      if (activeActivationCommitted) {
        if (activeUnitId !== null) setSelectedUnit(activeUnitId);
        setActivationFeedback(
          "Finish the active ship before selecting another one.",
        );
        setMovePlan(null);
        setMoveTarget(null);
        setAttackTarget(null);
        return;
      }
      if (phaseDone) {
        setSelectedUnit(unitId);
        setActivationFeedback(`${unit.name} already activated this phase.`);
        return;
      }
      if (activateUnit.isPending) return;
      // Optimistically reflect the new selection so the sidebar swaps even
      // before the server confirms; revert on error.
      const prevSelected = selectedUnit;
      const prevOptimisticActive = optimisticActiveUnitId;
      setActivationAttemptDebug({
        unitId,
        unitName: unit.name,
        phase: currentPhase,
        source: "swap",
        startedAt: new Date().toISOString(),
      });
      setSelectedUnit(unitId);
      setOptimisticActiveUnitId(unitId);
      setActivationFeedback(null);
      setMovePlan(null);
      setMoveTarget(null);
      setAttackTarget(null);
      activateUnit.mutate(
        { gameId, unitId },
        {
          onSuccess: () => {
            setActivationAttemptDebug(null);
            mergeActiveUnitIntoGame(unitId);
            setOptimisticActiveUnitId(null);
            qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
          },
          onError: (err: any) => {
            setActivationAttemptDebug(null);
            setSelectedUnit(prevSelected);
            setOptimisticActiveUnitId(prevOptimisticActive);
            setActivationFeedback(
              `Cannot activate ${unit.name}: ${cleanApiErrorMessage(err)}`,
            );
            // eslint-disable-next-line no-console
            console.warn("Swap activation failed:", err?.message);
          },
        },
      );
      return;
    }

    // Inactive game or not our activation: still allow selecting own ships
    // for inspection.
    setSelectedUnit(unitId === selectedUnit ? null : unitId);
    setMoveTarget(null);
    setAttackTarget(null);
  };

  const handleRequestEndActivation = useCallback(() => {
    // Either ending a real activation OR passing the phase when zero
    // eligible ships remain. Pass authorisation is enforced server-side.
    if ((!hasActiveUnit && !canPassPhase) || endActivation.isPending) return;
    if (
      hasActiveUnit &&
      currentPhase === "movement" &&
      movePlan &&
      canConfirmMovePlan
    ) {
      setActivationFeedback("Committing staged movement before ending activation...");
      commitMovePlan(() => setEndActivationConfirmOpen(true));
      return;
    }
    setEndActivationConfirmOpen(true);
  }, [
    canConfirmMovePlan,
    canPassPhase,
    commitMovePlan,
    currentPhase,
    endActivation.isPending,
    hasActiveUnit,
    movePlan,
  ]);

  const handleConfirmEndActivation = useCallback(() => {
    if ((!hasActiveUnit && !canPassPhase) || endActivation.isPending) return;
    setEndActivationConfirmOpen(false);
    endActivation.mutate(
      { gameId },
      {
        onSuccess: (updatedGame) => {
          mergeGameIntoCache(updatedGame);
          qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
          setMovePlan(null);
          const armedDisplacement =
            readFighterDisplacementUiState(updatedGame.aiState)?.readyToPlace ===
            true;
          if (armedDisplacement) {
            setActivationFeedback(
              "Movement complete. Place displaced fighters before ending activation.",
            );
            return;
          }
          mergeActiveUnitIntoGame(null);
          setSelectedUnit(null);
          setOptimisticActiveUnitId(null);
        },
      },
    );
  }, [
    hasActiveUnit,
    canPassPhase,
    endActivation,
    gameId,
    mergeGameIntoCache,
    mergeActiveUnitIntoGame,
    qc,
  ]);

  const handleRequestPassAllFiring = useCallback(() => {
    if (
      !canPassAllFiring ||
      passAllFiringPending ||
      antiFighterCommitting ||
      diceModal !== null ||
      dogfightModal !== null
    )
      return;
    setActivationFeedback(null);
    setPassAllFiringConfirmOpen(true);
  }, [
    antiFighterCommitting,
    canPassAllFiring,
    diceModal,
    dogfightModal,
    passAllFiringPending,
  ]);

  const handlePassAllFiring = useCallback(async () => {
    if (
      currentPhase !== "firing" ||
      activationSegment === null ||
      !isMyActivation ||
      passAllFiringPending ||
      antiFighterState
    )
      return;
    setPassAllFiringConfirmOpen(false);
    setPassAllFiringPending(true);
    setActivationFeedback(null);
    try {
      await customFetch(`/api/games/${gameId}/pass-firing`, {
        method: "POST",
        body: JSON.stringify({ segment: activationSegment }),
        responseType: "json",
      });
      mergeActiveUnitIntoGame(null);
      setSelectedUnit(null);
      setFiringWeaponPicking(null);
      setDiceModal(null);
      setDogfightModal(null);
      setUseCoordOnNext(false);
      setOptimisticActiveUnitId(null);
      qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
    } catch (err) {
      setActivationFeedback(
        cleanApiErrorMessage(err, `${passAllFiringLabel} failed`),
      );
    } finally {
      setPassAllFiringPending(false);
    }
  }, [
    activationSegment,
    antiFighterState,
    currentPhase,
    gameId,
    isMyActivation,
    mergeActiveUnitIntoGame,
    passAllFiringLabel,
    passAllFiringPending,
    qc,
  ]);

  const resolveDogfight = useCallback(
    async (targetUnitId?: number) => {
      const attacker = activeUnitId
        ? unitsWithFighterFlags.find((u) => u.id === activeUnitId)
        : undefined;
      if (!attacker?.isFighter || attacker.ownerId !== myUserId) return;
      const legalTargets = activeDogfightEnemies;
      if (legalTargets.length === 0) {
        setActivationFeedback(
          "This fighter is not in base contact with an enemy fighter.",
        );
        return;
      }
      if (targetUnitId === undefined && legalTargets.length > 1) {
        setDogfightTargetPicking(true);
        setActivationFeedback("Dogfight: pick one contacted enemy fighter.");
        return;
      }
      const target =
        targetUnitId !== undefined
          ? legalTargets.find((enemy) => enemy.id === targetUnitId)
          : legalTargets[0];
      if (!target) {
        setActivationFeedback(
          "Dogfight target must be an enemy fighter in base contact.",
        );
        return;
      }
      if (firingInFlightRef.current) return;
      firingInFlightRef.current = true;
      setDogfightTargetPicking(false);
      setFiringWeaponPicking(null);
      setSplitFirePlan(null);
      setActivationFeedback(null);
      try {
        const result = await customFetch<DogfightResult>(
          `/api/games/${gameId}/units/${attacker.id}/dogfight`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targetUnitId: target.id }),
          },
        );
        setDogfightImpactEffects((prev) => [
          ...prev.slice(-3),
          {
            id: Date.now(),
            x: (attacker.hexQ + target.hexQ) / 2,
            z: (attacker.hexR + target.hexR) / 2,
          },
        ]);
        setDogfightModal({ phase: "rolling", result });
        setTimeout(() => {
          setDogfightModal((modal) =>
            modal &&
            modal.result.attackerUnitId === result.attackerUnitId &&
            modal.result.targetUnitId === result.targetUnitId
              ? { ...modal, phase: "shown" }
              : modal,
          );
        }, 700);
        const outcome = result.tied
          ? "Dogfight tied; fighters remain locked."
          : result.destroyedUnitId === result.targetUnitId
            ? `${result.targetName} destroyed in dogfight.`
            : `${result.attackerName} destroyed in dogfight.`;
        setActivationFeedback(outcome);
      } catch (err) {
        setActivationFeedback(cleanApiErrorMessage(err, "Dogfight failed"));
      } finally {
        firingInFlightRef.current = false;
      }
    },
    [
      activeDogfightEnemies,
      activeUnitId,
      gameId,
      myUserId,
      unitsWithFighterFlags,
    ],
  );

  const handleSubmitBugReport = useCallback(async () => {
    const message = bugReportMessage.trim();
    if (message.length < 4 || bugReportPending) return;
    if (!game) {
      setBugReportError("Game data is still loading. Try again in a moment.");
      return;
    }
    setBugReportPending(true);
    setBugReportError(null);
    const clientSnapshot = {
      capturedAt: new Date().toISOString(),
      gameId,
      round: game.currentRound,
      phase: currentPhase,
      activePlayerId: game.activePlayerId,
      activeUnitId,
      selectedUnitId: selectedUnit,
      selectedUnit: selectedUnitData
        ? {
            id: selectedUnitData.id,
            name: selectedUnitData.name,
            ownerId: selectedUnitData.ownerId,
            hullPoints: selectedUnitData.hullPoints,
            maxHullPoints: selectedUnitData.maxHullPoints,
            crewPoints: selectedUnitData.crewPoints,
            maxCrewPoints: selectedUnitData.maxCrewPoints,
            damageState: selectedUnitData.damageState,
            isDestroyed: selectedUnitData.isDestroyed,
            hexQ: selectedUnitData.hexQ,
            hexR: selectedUnitData.hexR,
            heading: selectedUnitData.heading,
            specialAction: selectedUnitData.specialAction,
            speed: selectedUnitData.speed,
            turns: selectedUnitData.turns,
            turnAngle: selectedUnitData.turnAngle,
            isFighter: isFighterUnit(selectedUnitData),
          }
        : null,
      activeUnit: activeUnitData
        ? {
            id: activeUnitData.id,
            name: activeUnitData.name,
            ownerId: activeUnitData.ownerId,
            hullPoints: activeUnitData.hullPoints,
            maxHullPoints: activeUnitData.maxHullPoints,
            crewPoints: activeUnitData.crewPoints,
            maxCrewPoints: activeUnitData.maxCrewPoints,
            damageState: activeUnitData.damageState,
            isDestroyed: activeUnitData.isDestroyed,
            hexQ: activeUnitData.hexQ,
            hexR: activeUnitData.hexR,
            heading: activeUnitData.heading,
            specialAction: activeUnitData.specialAction,
            speed: activeUnitData.speed,
            turns: activeUnitData.turns,
            turnAngle: activeUnitData.turnAngle,
            isFighter: isFighterUnit(activeUnitData),
          }
        : null,
      movePlan,
      movementGesture,
      moveTarget,
      attackTarget,
      selectedSaCaps,
      selectedMovementUi,
      selectedRemainingMove,
      selectedDragOffset,
      selectedPreviewHeadingDelta,
      minMoveGate,
      phaseLedger,
      activationFeedback,
      activation: {
        activatePending: activateUnit.isPending,
        movePending: moveUnit.isPending,
        endActivationPending: endActivation.isPending,
        activeUnitReadyForActions,
        activationRequestPending,
        hasActiveUnit,
        serverActiveUnitId,
        optimisticActiveUnitId,
        activationAttempt: activationAttemptDebug,
      },
      inputProfile,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      battleLogTail: battleLogEntries.slice(-6),
    };
    try {
      const response = await customFetch<{ rescueApplied?: boolean }>(
        `/api/games/${gameId}/bug-report`,
        {
          method: "POST",
          body: JSON.stringify({
            message,
            rescueRequested: bugReportBlocking,
            clientSnapshot,
          }),
        },
      );
      setBugReportOpen(false);
      setBugReportMessage("");
      setBugReportBlocking(false);
      setActivationFeedback(
        response.rescueApplied
          ? "Bug report submitted. Current step was forced forward."
          : "Bug report submitted.",
      );
      if (response.rescueApplied) {
        mergeActiveUnitIntoGame(null);
        setSelectedUnit(null);
        setMovePlan(null);
        setMoveTarget(null);
        setAttackTarget(null);
        setFiringWeaponPicking(null);
        setDiceModal(null);
        setOptimisticActiveUnitId(null);
      }
      qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
    } catch (err) {
      setBugReportError(cleanApiErrorMessage(err, "Bug report failed"));
    } finally {
      setBugReportPending(false);
    }
  }, [
    bugReportBlocking,
    bugReportMessage,
    bugReportPending,
    activeUnitData,
    activeUnitId,
    activeUnitReadyForActions,
    activationFeedback,
    activationAttemptDebug,
    activationRequestPending,
    activateUnit.isPending,
    attackTarget,
    battleLogEntries,
    currentPhase,
    endActivation.isPending,
    game,
    gameId,
    hasActiveUnit,
    inputProfile,
    isFighterUnit,
    minMoveGate,
    mergeActiveUnitIntoGame,
    movePlan,
    moveTarget,
    moveUnit.isPending,
    movementGesture,
    optimisticActiveUnitId,
    phaseLedger,
    qc,
    selectedDragOffset,
    selectedMovementUi,
    selectedPreviewHeadingDelta,
    selectedRemainingMove,
    selectedSaCaps,
    selectedUnit,
    selectedUnitData,
    serverActiveUnitId,
  ]);

  const handleSendChat = useCallback(async () => {
    const message = chatMessage.trim();
    if (!message || chatSending || !canSendGameChat) return;
    setChatSending(true);
    setChatError(null);
    try {
      await customFetch(`/api/games/${gameId}/chat`, {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      setChatMessage("");
      setChatOpen(true);
      await qc.invalidateQueries({ queryKey: gameChatQueryKey });
    } catch (err) {
      setChatError(cleanApiErrorMessage(err, "Chat send failed"));
    } finally {
      setChatSending(false);
    }
  }, [canSendGameChat, chatMessage, chatSending, gameChatQueryKey, gameId, qc]);

  const handleSubmitTurn = () => {
    submitTurn.mutate(
      { gameId, data: { moves: turnMoves, attacks: turnAttacks } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
          qc.invalidateQueries({ queryKey: getListTurnsQueryKey(gameId) });
          setTurnMoves([]);
          setTurnAttacks([]);
          setSelectedUnit(null);
        },
      },
    );
  };

  const handleYardsDeploy = useCallback(() => {
    if (manualTerrainPending) {
      setActivationFeedback(
        "Manual terrain placement must be completed before fleet deployment.",
      );
      return;
    }
    if (currentStagedUnits.length === 0) return;
    if (deploymentOverlapWarning) {
      setActivationFeedback(deploymentOverlapWarning);
      return;
    }
    // Two paths, mirroring the API's two deploy modes:
    //   1. A saved fleet is selected → match each staged ship to a fleet
    //      Ship row by model filename and send `shipId`.
    //   2. No fleet selected → direct drop-in: send `shipModelId` per
    //      placement and let the server materialize an ephemeral fleet.
    let placements: Array<{
      shipId?: number;
      shipModelId?: number;
      hexQ: number;
      hexR: number;
      heading: number;
      crewQuality?: number;
      launchedFromPlacementIndex?: number | null;
      deploymentGroupId?: string | null;
    }>;
    let fleetIdToSend: number | undefined;
    const stagedIndexById = new Map(
      currentStagedUnits.map((unit, index) => [unit.id, index]),
    );

    if (
      yardsFleetId &&
      yardsFleetShips &&
      currentStagedUnits.every((unit) => !unit.launchedFromStagedId)
    ) {
      const available = [...yardsFleetShips];
      const shipIdByDeploymentGroup = new Map<string, number>();
      placements = [];
      for (const staged of currentStagedUnits) {
        const deploymentGroupId = staged.deploymentGroupId?.trim() || null;
        let ship: (typeof yardsFleetShips)[number] | undefined;
        if (
          deploymentGroupId &&
          shipIdByDeploymentGroup.has(deploymentGroupId)
        ) {
          const existingShipId = shipIdByDeploymentGroup.get(deploymentGroupId);
          ship = yardsFleetShips.find(
            (candidate) =>
              candidate.id === existingShipId &&
              candidate.shipModel.id === staged.shipModelId,
          );
        } else {
          const idx = available.findIndex(
            (s) => s.shipModel.id === staged.shipModelId,
          );
          if (idx !== -1) {
            ship = available.splice(idx, 1)[0];
            if (deploymentGroupId && ship) {
              shipIdByDeploymentGroup.set(deploymentGroupId, ship.id);
            }
          }
        }
        if (!ship) {
          // Staged a ship that isn't in the selected fleet — fall back
          // to direct drop-in for THIS unit so nothing silently disappears.
          placements.push({
            shipModelId: staged.shipModelId,
            hexQ: snapBoardCoord(staged.x),
            hexR: snapBoardCoord(staged.z),
            heading: staged.heading,
            crewQuality: staged.crewQuality,
            deploymentGroupId,
          });
          continue;
        }
        placements.push({
          shipId: ship.id,
          hexQ: snapBoardCoord(staged.x),
          hexR: snapBoardCoord(staged.z),
          heading: staged.heading,
          crewQuality: staged.crewQuality,
          deploymentGroupId,
        });
      }
      // Mixed fleet+drop-in payload is not supported by the API. If ANY
      // placement lacks shipId, drop the fleetId entirely and let the
      // server treat it as a pure direct-deploy.
      const allHaveShipId = placements.every((p) => p.shipId !== undefined);
      fleetIdToSend = allHaveShipId ? parseInt(yardsFleetId) : undefined;
      if (!allHaveShipId)
        placements = currentStagedUnits.map((s) => ({
          shipModelId: s.shipModelId,
          hexQ: snapBoardCoord(s.x),
          hexR: snapBoardCoord(s.z),
          heading: s.heading,
          crewQuality: s.crewQuality,
          deploymentGroupId: s.deploymentGroupId?.trim() || null,
        }));
    } else {
      // Pure direct drop-in.
      placements = currentStagedUnits.map((s) => ({
        shipModelId: s.shipModelId,
        hexQ: snapBoardCoord(s.x),
        hexR: snapBoardCoord(s.z),
        heading: s.heading,
        crewQuality: s.crewQuality,
        launchedFromPlacementIndex: s.launchedFromStagedId
          ? (stagedIndexById.get(s.launchedFromStagedId) ?? null)
          : null,
        deploymentGroupId: s.deploymentGroupId?.trim() || null,
      }));
      fleetIdToSend = undefined;
    }
    deployFleet.mutate(
      { gameId, data: { fleetId: fleetIdToSend ?? null, placements } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
          setStagedUnits((prev) => prev.filter((u) => u.ownerId !== myUserId));
          setSelectedStagedId(null);
          setTapPlacementShip(null);
        },
        onError: (err) => {
          // Surface the server's actual error message instead of the
          // mutation silently failing. The customFetch ApiError includes
          // the response body's `error` field in its message.
          console.error("[deploy] failed", err, {
            fleetId: fleetIdToSend ?? null,
            placements,
          });
        },
      },
    );
  }, [
    yardsFleetId,
    yardsFleetShips,
    currentStagedUnits,
    deploymentOverlapWarning,
    deployFleet,
    gameId,
    manualTerrainPending,
    qc,
    myUserId,
  ]);

  if (isLoading) {
    return (
      <Layout title="Loading...">
        <div className="p-6 space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-[400px] w-full" />
        </div>
      </Layout>
    );
  }

  if (!game) {
    return (
      <Layout title="Not Found">
        <div className="p-6 text-muted-foreground">Game not found.</div>
      </Layout>
    );
  }

  const completedWinnerName =
    game.winnerId === game.challengerId
      ? (game.challengerName ?? "Challenger")
      : game.winnerId === game.opponentId
        ? (game.opponentName ?? "Opponent")
        : null;
  const completedResultTitle =
    game.status !== "completed"
      ? null
      : !game.winnerId
        ? "Engagement Complete"
        : game.winnerId === myUserId
          ? "Victory"
          : mySide
            ? "Defeat"
            : "Engagement Complete";
  const completedResultDetail =
    game.status !== "completed"
      ? null
      : completedWinnerName
        ? `${completedWinnerName} wins.`
        : "Both fleets have been eliminated.";
  const boardCameraInputDisabled =
    Boolean(draggingId) ||
    Boolean(movementGesture) ||
    Boolean(pendingFighterLaunchPlacement) ||
    Boolean(pendingShadowDispersalPlacement) ||
    canPlaceManualTerrain ||
    canPlaceCurrentDisplacedFighter;
  const gameChatPanel = canUseGameChat ? (
    <div className="border-b border-border" data-testid="game-chat-panel">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-secondary/30"
        onClick={() => setChatOpen((open) => !open)}
        aria-expanded={chatOpen}
        data-testid="button-toggle-game-chat"
      >
        <MessageCircle className="h-4 w-4 text-primary" />
        <span className="flex-1 text-xs font-mono font-bold uppercase tracking-widest text-primary">
          Opponent Chat
        </span>
        {chatMessages.length > 0 && (
          <Badge variant="outline" className="h-5 px-1.5 text-[9px] font-mono">
            {chatMessages.length}
          </Badge>
        )}
        {chatOpen ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {!chatOpen && latestChatMessage && (
        <div
          className="px-4 pb-3 text-[10px] font-mono text-muted-foreground truncate"
          data-testid="game-chat-collapsed-preview"
        >
          {latestChatMessage.senderPlayerId === myUserId
            ? "You"
            : (latestChatMessage.senderName ?? "Opponent")}
          : {latestChatMessage.message}
        </div>
      )}
      {chatOpen && (
        <div className="px-3 pb-3 space-y-2">
          <div
            ref={chatScrollRef}
            className="max-h-52 overflow-y-auto rounded border border-border bg-background/70 p-2 space-y-1.5"
            data-testid="game-chat-messages"
          >
            {chatMessages.length === 0 ? (
              <p className="py-4 text-center text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                No messages yet
              </p>
            ) : (
              chatMessages.map((message) => {
                const mine = message.senderPlayerId === myUserId;
                return (
                  <div
                    key={message.id}
                    className={`rounded border px-2 py-1.5 text-xs font-mono ${
                      mine
                        ? "ml-5 border-primary/35 bg-primary/10 text-primary"
                        : "mr-5 border-border bg-card text-foreground"
                    }`}
                    data-testid={`game-chat-message-${message.id}`}
                  >
                    <div className="mb-0.5 flex items-center justify-between gap-2 text-[9px] uppercase tracking-wider opacity-70">
                      <span className="truncate">
                        {mine ? "You" : (message.senderName ?? "Opponent")}
                      </span>
                      <span className="shrink-0">
                        {formatChatTime(message.createdAt)}
                      </span>
                    </div>
                    <div className="whitespace-pre-wrap break-words leading-relaxed">
                      {message.message}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              handleSendChat();
            }}
          >
            <Textarea
              data-testid="textarea-game-chat"
              value={chatMessage}
              onChange={(event) => setChatMessage(event.target.value)}
              maxLength={500}
              rows={2}
              placeholder={
                isAdminObserver ? "Read-only observer mode" : "Message opponent..."
              }
              className="min-h-14 resize-none font-mono text-xs"
              disabled={!canSendGameChat}
            />
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[10px] font-mono text-muted-foreground">
                {chatMessage.length}/500
              </span>
              <Button
                type="submit"
                size="sm"
                className="h-8 gap-1.5 px-3 text-[10px] font-bold uppercase tracking-widest"
                disabled={
                  !canSendGameChat ||
                  chatSending ||
                  chatMessage.trim().length === 0
                }
                data-testid="button-send-game-chat"
              >
                <Send className="h-3.5 w-3.5" />
                {chatSending ? "Sending" : "Send"}
              </Button>
            </div>
            {chatError && (
              <p
                className="text-[10px] font-mono text-red-400"
                data-testid="text-game-chat-error"
              >
                {chatError}
              </p>
            )}
          </form>
        </div>
      )}
    </div>
  ) : null;

  return (
    <Layout
      title={`${game.challengerName ?? "?"} vs ${game.opponentName ?? "?"}`}
      sidebarBottom={
        gameChatPanel || !mobileGameChrome ? (
          <div className="flex min-h-0 flex-col">
            {gameChatPanel}
            {!mobileGameChrome && <BattleLogPanel entries={battleLogEntries} />}
          </div>
        ) : undefined
      }
    >
      <div
        className="game-board-shell flex flex-col lg:flex-row h-full min-h-[calc(100dvh-4rem)] lg:h-[calc(100dvh-4rem)] lg:min-h-0 lg:overflow-hidden"
        data-input={inputProfile.input}
        data-layout={inputProfile.layout}
        data-platform={inputProfile.platform}
        data-device={inputProfile.deviceClass}
        data-touch={inputProfile.hasTouch ? "true" : "false"}
        data-hover={inputProfile.hasHover ? "true" : "false"}
        data-testid="game-board-shell"
      >
        {/* 3D Board */}
        <div
          className={`game-board-viewport flex-1 relative h-[58dvh] min-h-[320px] max-h-[70dvh] lg:h-full lg:min-h-0 lg:max-h-none bg-black touch-none select-none overscroll-none ${
            isTouchInput ? "min-h-[360px]" : ""
          }`}
          data-input={inputProfile.input}
          onContextMenu={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            if (pendingShadowDispersalPlacement) {
              e.preventDefault();
              const width = 92;
              const height = 48;
              setMoveConfirmPopover(null);
              setDisplacedFighterConfirmPopover(null);
              setFighterLaunchConfirmPopover(null);
              setShadowDispersalConfirmPopover({
                x: Math.max(
                  8,
                  Math.min(rect.width - width - 8, e.clientX - rect.left),
                ),
                y: Math.max(
                  8,
                  Math.min(rect.height - height - 8, e.clientY - rect.top),
                ),
              });
              if (!shadowDispersalPlacementLegal) {
                setActivationFeedback(shadowDispersalPlacementValidation.detail);
              }
              return;
            }
            if (pendingFighterLaunchPlacement) {
              e.preventDefault();
              if (!pendingLaunchPlacementLegal) {
                setFighterBayFeedback(
                  "Choose a legal launch point within 3 inches that does not overlap another base.",
                );
                return;
              }
              const width = 92;
              const height = 48;
              setMoveConfirmPopover(null);
              setDisplacedFighterConfirmPopover(null);
              setFighterLaunchConfirmPopover({
                x: Math.max(
                  8,
                  Math.min(rect.width - width - 8, e.clientX - rect.left),
                ),
                y: Math.max(
                  8,
                  Math.min(rect.height - height - 8, e.clientY - rect.top),
                ),
              });
              return;
            }
            if (
              canPlaceCurrentDisplacedFighter &&
              stagedDisplacedFighterPlacement
            ) {
              e.preventDefault();
              const width = 92;
              const height = 48;
              setMoveConfirmPopover(null);
              setDisplacedFighterConfirmPopover({
                x: Math.max(
                  8,
                  Math.min(rect.width - width - 8, e.clientX - rect.left),
                ),
                y: Math.max(
                  8,
                  Math.min(rect.height - height - 8, e.clientY - rect.top),
                ),
              });
              return;
            }
            if (!canUsePcMoveConfirmPopover) return;
            e.preventDefault();
            const start = boardPointerDownRef.current;
            if (start) {
              const dx = e.clientX - start.x;
              const dy = e.clientY - start.y;
              if (dx * dx + dy * dy > 100) return;
            }
            const width = canEndActivationFromPcMovePopover ? 132 : 92;
            const height = canEndActivationFromPcMovePopover ? 88 : 48;
            setDisplacedFighterConfirmPopover(null);
            setMoveConfirmPopover({
              x: Math.max(8, Math.min(rect.width - width - 8, e.clientX - rect.left)),
              y: Math.max(8, Math.min(rect.height - height - 8, e.clientY - rect.top)),
            });
          }}
          onPointerDown={(e) => {
            if (e.button !== 2) setMoveConfirmPopover(null);
            if (e.button !== 2) setDisplacedFighterConfirmPopover(null);
            if (e.button !== 2) setFighterLaunchConfirmPopover(null);
            if (e.button !== 2) setShadowDispersalConfirmPopover(null);
            boardPointerDownRef.current = {
              x: e.clientX,
              y: e.clientY,
              time: performance.now(),
            };
            if (
              e.button === 0 &&
              pendingShadowDispersalPlacement &&
              pendingShadowDispersalCarrier &&
              pendingShadowDispersalFighterModel &&
              !launchShadowFighterDispersal.isPending
            ) {
              stageActiveShadowDispersalPlacement(e.clientX, e.clientY);
              setActivationFeedback(
                isTouchInput
                  ? `Position flight ${pendingShadowDispersalPlacement.activeIndex + 1} of ${pendingShadowDispersalPlacement.placements.length}, then use check/X to confirm or cancel.`
                  : `Position flight ${pendingShadowDispersalPlacement.activeIndex + 1} of ${pendingShadowDispersalPlacement.placements.length}, then right-click for check/X.`,
              );
              return;
            }
            if (
              e.button === 0 &&
              pendingFighterLaunchPlacement &&
              pendingLaunchCarrier &&
              pendingLaunchFighterModel &&
              fighterBayBusyKey === null
            ) {
              const pos = screenToBoard(e.clientX, e.clientY, threeRef);
              if (!pos) return;
              const [rx, rz] = pos;
              const [x, z] = clampEndPhaseLaunchPoint(
                rx,
                rz,
                pendingLaunchCarrier,
                pendingLaunchFighterModel,
              );
              setPendingFighterLaunchPlacement((prev) =>
                prev ? { ...prev, x, z } : prev,
              );
              setFighterBayFeedback(
                touchGameControls
                  ? "Launch placement preview staged. Use Confirm Launch or Cancel."
                  : "Launch placement preview staged. Right-click for check/X or press Enter.",
              );
              return;
            }
            if (
              e.button === 0 &&
              canPlaceCurrentDisplacedFighter &&
              currentDisplacedFighterToPlace &&
              !placeDisplacedFighter.isPending
            ) {
              displacedFighterPlacementDraggingRef.current = true;
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                // Pointer capture can fail on synthetic events; dragging still works.
              }
              if (!stageDisplacedFighterPlacementAtPointer(e.clientX, e.clientY)) {
                displacedFighterPlacementDraggingRef.current = false;
                try {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                } catch {
                  // Best effort only; some browsers release capture automatically.
                }
                return;
              }
              setActivationFeedback(
                isTouchInput
                  ? "Drag displaced fighter placement, then use check/X to confirm or cancel."
                  : "Drag displaced fighter placement, then right-click for check/X.",
              );
              return;
            }
            if (
              e.button === 0 &&
              game.status === "active" &&
              currentPhase === "movement" &&
              isSelectedUnitActive &&
              selectedUnitData &&
              selectedMovementUi?.canForward &&
              selectedUnitData.ownerId === myUserId &&
              !draggingId &&
              !movementGesture &&
              !moveConfirmPopover &&
              (!movePlan || selectedUnitIsFighter)
            ) {
              const pos = screenToBoard(e.clientX, e.clientY, threeRef);
              if (pos) {
                const [x, z] = pos;
                if (selectedUnitIsFighter) {
                  if (selectedFighterLockedInDogfight) {
                    setActivationFeedback(
                      "Fighter is locked in a dogfight; use the Dogfight action instead.",
                    );
                    return;
                  }
                  const headingFallback =
                    movePlan?.kind === "fighter-free"
                      ? movePlan.heading
                      : selectedUnitData.heading;
                  const plan = buildFighterMovePlan(
                    selectedUnitData,
                    x,
                    z,
                    headingFallback,
                  );
                  if (plan) {
                    setMovementGesture({ kind: "fighter-free" });
                    setMovePlan(plan);
                  }
                  return;
                }
                const baseRadius = rulesBaseRadius(selectedUnitData);
                const distanceFromSelected = Math.hypot(
                  x - selectedUnitData.hexQ,
                  z - selectedUnitData.hexR,
                );
                if (
                  distanceFromSelected <=
                  baseRadius + CAPITAL_MOVE_DRAG_START_EXTRA_INCHES
                ) {
                  setMovementGesture({ kind: "forward" });
                  setMovePlan({ kind: "forward", distance: 0 });
                }
              }
            }
          }}
          onPointerMove={(e) => {
            if (
              displacedFighterPlacementDraggingRef.current &&
              canPlaceCurrentDisplacedFighter &&
              !placeDisplacedFighter.isPending
            ) {
              stageDisplacedFighterPlacementAtPointer(e.clientX, e.clientY);
              return;
            }
            if (canPlaceManualTerrain && !placeManualTerrain.isPending) {
              const pos = screenToBoard(e.clientX, e.clientY, threeRef);
              if (!pos) return;
              setManualTerrainPreviewPoint({
                x: snapBoardCoord(pos[0]),
                z: snapBoardCoord(pos[1]),
              });
              return;
            }
            // Staged unit drag (deploy phase)
            if (draggingId) {
              const pos = screenToBoard(e.clientX, e.clientY, threeRef);
              if (!pos) return;
              const [rx, rz] = pos;
              setStagedUnits((prev) => {
                const moving = prev.find((unit) => unit.id === draggingId);
                if (!moving) return prev;
                const carrier = moving.launchedFromStagedId
                  ? prev.find((unit) => unit.id === moving.launchedFromStagedId)
                  : null;
                const [x, z] = carrier
                  ? clampToCarriedFighterDeployCircle(rx, rz, carrier, moving)
                  : clampToDeployZone(rx, rz, moving.baseRadiusInches);
                const ignoredStagedIds = new Set([
                  moving.id,
                  ...prev
                    .filter((unit) => unit.launchedFromStagedId === moving.id)
                    .map((unit) => unit.id),
                ]);
                const candidate: UiBaseFootprint = {
                  id: moving.id,
                  x,
                  z,
                  isFighter: stagedUnitIsFighter(moving),
                  baseRadiusInches: moving.baseRadiusInches,
                };
                if (deploymentPlacementOverlaps(candidate, ignoredStagedIds)) {
                  return prev;
                }
                const movedCarrier = { ...moving, x, z };
                return prev.map((unit) => {
                  if (unit.id === draggingId) return movedCarrier;
                  if (unit.launchedFromStagedId === draggingId) {
                    const [childX, childZ] = clampToCarriedFighterDeployCircle(
                      unit.x,
                      unit.z,
                      movedCarrier,
                      unit,
                    );
                    return { ...unit, x: childX, z: childZ };
                  }
                  return unit;
                });
              });
              return;
            }
            if (
              pendingShadowDispersalPlacement &&
              pendingShadowDispersalCarrier &&
              pendingShadowDispersalFighterModel &&
              !movementGesture &&
              !launchShadowFighterDispersal.isPending
            ) {
              stageActiveShadowDispersalPlacement(e.clientX, e.clientY);
              return;
            }
            if (
              pendingFighterLaunchPlacement &&
              pendingLaunchCarrier &&
              pendingLaunchFighterModel &&
              !movementGesture
            ) {
              const pos = screenToBoard(e.clientX, e.clientY, threeRef);
              if (!pos) return;
              const [rx, rz] = pos;
              const [x, z] = clampEndPhaseLaunchPoint(
                rx,
                rz,
                pendingLaunchCarrier,
                pendingLaunchFighterModel,
              );
              setPendingFighterLaunchPlacement((prev) =>
                prev ? { ...prev, x, z } : prev,
              );
              return;
            }
            if (
              movementGesture?.kind === "fighter-free" &&
              !moveConfirmPopover &&
              selectedUnitData &&
              selectedUnitData.ownerId === myUserId
            ) {
              if (selectedFighterLockedInDogfight) {
                setMovePlan(null);
                setMovementGesture(null);
                return;
              }
              const pos = screenToBoard(e.clientX, e.clientY, threeRef);
              if (!pos) return;
              const [px, pz] = pos;
              setMovePlan(
                (prev) =>
                  buildFighterMovePlan(
                    selectedUnitData,
                    px,
                    pz,
                    prev?.kind === "fighter-free"
                      ? prev.heading
                      : selectedUnitData.heading,
                  ) ?? prev,
              );
              return;
            }
            // Forward-move drag: project cursor onto heading axis from ship origin.
            if (
              !moveConfirmPopover &&
              movementGesture?.kind === "forward" &&
              selectedUnitData &&
              selectedUnitData.ownerId === myUserId
            ) {
              const pos = screenToBoard(e.clientX, e.clientY, threeRef);
              if (!pos) return;
              const [px, pz] = pos;
              const [sx, , sz] = hexToWorld(
                selectedUnitData.hexQ,
                selectedUnitData.hexR,
              );
              const v = headingForwardVec(selectedUnitData);
              const proj = (px - sx) * v.x + (pz - sz) * v.z;
              const requested = Math.max(
                0,
                Math.min(selectedRemainingMove, snapMovementDistance(proj)),
              );
              const previousDistance =
                movePlan?.kind === "forward" ? movePlan.distance : 0;
              const distance = clampForwardDistanceToLegalRestingSpot(
                {
                  ...selectedUnitData,
                  isFighter: isFighterUnit(selectedUnitData),
                },
                unitsWithFighterFlags,
                v,
                requested,
                selectedRemainingMove,
                requested + 1e-6 >= previousDistance ? "forward" : "nearest",
              );
              setMovePlan({ kind: "forward", distance });
              return;
            }
            if (
              movementGesture?.kind === "turn" &&
              !moveConfirmPopover &&
              selectedUnitData &&
              selectedUnitData.ownerId === myUserId &&
              selectedMovementUi?.canTurn
            ) {
              const pos = screenToBoard(e.clientX, e.clientY, threeRef);
              if (!pos) return;
              const [px, pz] = pos;
              if (isFighterUnit(selectedUnitData)) {
                setMovePlan((prev) => {
                  const current =
                    prev?.kind === "fighter-free"
                      ? prev
                      : {
                          kind: "fighter-free" as const,
                          x: selectedUnitData.hexQ,
                          z: selectedUnitData.hexR,
                          heading: selectedUnitData.heading,
                        };
                  const heading = headingForVisualVector(
                    selectedUnitData,
                    px - current.x,
                    pz - current.z,
                  );
                  return { ...current, heading };
                });
                return;
              }
              const [sx, , sz] = hexToWorld(
                selectedUnitData.hexQ,
                selectedUnitData.hexR,
              );
              const dx = px - sx;
              const dz = pz - sz;
              if (dx * dx + dz * dz < 0.2) return;
              const forward = headingForwardVec(selectedUnitData);
              const right = { x: forward.z, z: -forward.x };
              const localRight = dx * right.x + dz * right.z;
              const localForward = dx * forward.x + dz * forward.z;
              const rawDeg = THREE.MathUtils.radToDeg(
                Math.atan2(localRight, localForward),
              );
              const cap = selectedMovementUi.angleCap;
              const clamped =
                movementGesture.direction === "right"
                  ? Math.max(0, Math.min(cap, rawDeg))
                  : movementGesture.direction === "left"
                    ? Math.min(0, Math.max(-cap, rawDeg))
                    : Math.max(-cap, Math.min(cap, rawDeg));
              const snapped = Math.round(clamped / 5) * 5;
              setMovePlan({ kind: "turn", deltaDeg: snapped });
            }
          }}
          onPointerUp={(e) => {
            if (displacedFighterPlacementDraggingRef.current) {
              const finalPlacement = stageDisplacedFighterPlacementAtPointer(
                e.clientX,
                e.clientY,
              );
              displacedFighterPlacementDraggingRef.current = false;
              try {
                e.currentTarget.releasePointerCapture(e.pointerId);
              } catch {
                // Best effort only; some browsers release capture automatically.
              }
              if (isTouchInput && finalPlacement) {
                showDisplacedFighterConfirmPopoverAtBoardPoint(
                  finalPlacement.x,
                  finalPlacement.z,
                  e.currentTarget,
                );
              }
              boardPointerDownRef.current = null;
              return;
            }
            if (canPlaceManualTerrain && !placeManualTerrain.isPending) {
              const start = boardPointerDownRef.current;
              const dx = start ? e.clientX - start.x : 0;
              const dy = start ? e.clientY - start.y : 0;
              const elapsed = start ? performance.now() - start.time : 0;
              const target = e.target as HTMLElement | null;
              const boardTap =
                Boolean(start) &&
                dx * dx + dy * dy <= 144 &&
                elapsed <= 700 &&
                target?.tagName?.toLowerCase() === "canvas";
              if (boardTap) {
                const pos = screenToBoard(e.clientX, e.clientY, threeRef);
                if (pos) {
                  const x = snapBoardCoord(pos[0]);
                  const z = snapBoardCoord(pos[1]);
                  const field = terrainObjectForPlacementPreview(
                    activeManualTerrainKind,
                    manualTerrainOrdinal,
                    x,
                    z,
                    {
                      variant: activeManualTerrainVariant,
                      rotationDeg: manualTerrainRotationDeg,
                    },
                  );
                  if (!manualTerrainPreviewLegal(field, deploymentConfig)) {
                    setManualTerrainPreviewPoint({ x, z });
                    setActivationFeedback(
                      "Terrain footprint must stay inside the board and outside deployment areas.",
                    );
                    boardPointerDownRef.current = null;
                    return;
                  }
                  placeManualTerrain.mutate({
                    kind: activeManualTerrainKind,
                    variant: activeManualTerrainVariant,
                    rotationDeg: manualTerrainRotationDeg,
                    x,
                    z,
                  });
                  boardPointerDownRef.current = null;
                  return;
                }
              }
            }
            if (
              tapPlacementShip &&
              game.status === "deploying" &&
              isTouchInput &&
              !draggingId &&
              !movementGesture
            ) {
              const start = boardPointerDownRef.current;
              const dx = start ? e.clientX - start.x : 0;
              const dy = start ? e.clientY - start.y : 0;
              const elapsed = start ? performance.now() - start.time : 0;
              const target = e.target as HTMLElement | null;
              const boardTap =
                (!start || (dx * dx + dy * dy <= 144 && elapsed <= 900)) &&
                target?.tagName?.toLowerCase() === "canvas";
              if (boardTap) {
                const pos = screenToBoard(e.clientX, e.clientY, threeRef);
                if (pos) {
                  const [rx, rz] = pos;
                  stageShipAtBoardPoint(tapPlacementShip, rx, rz);
                  boardPointerDownRef.current = null;
                  return;
                }
              }
            }
            if (!tapPlacementShip && !draggingId && !movementGesture) {
              const start = boardPointerDownRef.current;
              const dx = start ? e.clientX - start.x : 0;
              const dy = start ? e.clientY - start.y : 0;
              const elapsed = start ? performance.now() - start.time : 0;
              const target = e.target as HTMLElement | null;
              const boardTap =
                Boolean(start) &&
                dx * dx + dy * dy <= 144 &&
                elapsed <= 700 &&
                target?.tagName?.toLowerCase() === "canvas";
              if (boardTap) {
                const pos = screenToBoard(e.clientX, e.clientY, threeRef);
                if (pos) {
                  const [x, z] = pos;
                  if (!boardPointHasUnit(x, z)) {
                    const now = performance.now();
                    const last = lastEmptyBoardTapRef.current;
                    const lastDx = last ? e.clientX - last.x : 999;
                    const lastDy = last ? e.clientY - last.y : 999;
                    if (
                      last &&
                      now - last.time <= 420 &&
                      lastDx * lastDx + lastDy * lastDy <= 576
                    ) {
                      lastEmptyBoardTapRef.current = null;
                      setCameraFocusRequest({
                        seq: Date.now(),
                        x,
                        z,
                        distance: BOARD_FOCUS_CAMERA_DISTANCE,
                        targetHeight: BOARD_FOCUS_TARGET_HEIGHT,
                      });
                      boardPointerDownRef.current = null;
                      return;
                    }
                    lastEmptyBoardTapRef.current = {
                      x: e.clientX,
                      y: e.clientY,
                      time: now,
                    };
                  } else {
                    lastEmptyBoardTapRef.current = null;
                  }
                }
              }
            }
            setDraggingId(null);
            if (
              movementGesture?.kind === "forward" ||
              movementGesture?.kind === "fighter-free"
            )
              setMovementGesture(null);
            boardPointerDownRef.current = null;
          }}
          onPointerCancel={() => {
            displacedFighterPlacementDraggingRef.current = false;
            setManualTerrainPreviewPoint(null);
            setDraggingId(null);
            if (
              movementGesture?.kind === "forward" ||
              movementGesture?.kind === "fighter-free"
            )
              setMovementGesture(null);
            boardPointerDownRef.current = null;
          }}
          onPointerLeave={() => {
            displacedFighterPlacementDraggingRef.current = false;
            setManualTerrainPreviewPoint(null);
            setDraggingId(null);
            if (
              movementGesture?.kind === "forward" ||
              movementGesture?.kind === "fighter-free"
            )
              setMovementGesture(null);
            boardPointerDownRef.current = null;
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragOver(false);
            if (manualTerrainPending) {
              setActivationFeedback(
                "Finish manual terrain placement before staging ships.",
              );
              return;
            }
            const ship = draggedShipRef.current!;
            if (!ship) return;
            const pos = screenToBoard(e.clientX, e.clientY, threeRef);
            if (!pos) return;
            const [rx, rz] = pos;
            stageShipAtBoardPoint(ship, rx, rz);
            return;
            const [x, z] = clampToDeployZone(rx, rz);
            const newId = `staged-${Date.now()}`;
            setStagedUnits((prev) => [
              ...prev,
              {
                id: newId,
                ownerId: myUserId,
                shipModelId: ship.id,
                name: ship.name,
                modelFilename: ship.filename,
                faction: ship.faction,
                priorityLevel: ship.priorityLevel,
                hullPoints: ship.hullPoints,
                speed: ship.speed,
                weaponRange: ship.weaponRange,
                weaponDamage: ship.weaponDamage,
                baseRadiusInches: ship.baseRadiusInches,
                weapons: ship.weapons ?? [],
                traits: ship.traits ?? null,
                carriedFighters: parseUiSmallCraftInventory(
                  ship.smallCraft,
                  shipModels ?? [],
                ),
                launchedFromStagedId: null,
                x,
                z,
                // Default facing: nose toward the opposing player's edge so a
                // freshly-dropped ship is already pointed at the enemy.
                // Challenger deploys from +Z → faces -Z (heading 180°);
                // Opponent deploys from -Z → faces +Z (heading 0°).
                heading: mySide === "challenger" ? 180 : 0,
                locked: false,
                // Default CQ is Veteran (4). In "standard" games this is also
                // the only legal value; in "custom" games the player can pick
                // 1..7 via the expandable card in the staged-units list.
                crewQuality: 4,
              },
            ]);
            setSelectedStagedId(newId);
            draggedShipRef.current = null;
          }}
        >
          {isDragOver && (
            <div className="absolute inset-0 border-2 border-primary/60 pointer-events-none z-10 rounded-sm" />
          )}
          {tapPlacementShip && game.status === "deploying" && isTouchInput && (
            <div className="absolute left-3 top-3 z-20 flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded border border-primary/50 bg-card/95 px-2 py-1.5 shadow-lg">
              <span className="min-w-0 truncate text-[10px] font-mono uppercase tracking-wider text-primary">
                Placing · {tapPlacementShip.name}
              </span>
              <button
                type="button"
                aria-label="Cancel ship placement"
                onClick={() => setTapPlacementShip(null)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground"
                data-testid="button-cancel-tap-placement"
              >
                ×
              </button>
            </div>
          )}
          {game.status === "deploying" &&
            !myDeploymentLocked &&
            isTouchInput &&
            selectedStagedUnit && (
              <div
                className="pointer-events-auto absolute bottom-16 left-1/2 z-30 w-[min(360px,calc(100%-1.5rem))] -translate-x-1/2 rounded border border-primary/45 bg-black/90 p-2 shadow-xl shadow-black/50 backdrop-blur"
                data-testid="mobile-deployment-controls"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[10px] font-mono uppercase tracking-widest text-primary">
                      {selectedStagedUnit.name}
                    </p>
                    <p className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
                      Heading {Math.round(selectedStagedUnit.heading)} deg
                    </p>
                  </div>
                  {selectedStagedUnit.locked && (
                    <span className="shrink-0 rounded border border-amber-300/40 bg-amber-300/10 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-widest text-amber-200">
                      locked
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-5 gap-1.5">
                  <button
                    type="button"
                    aria-label="Rotate staged ship left"
                    disabled={selectedStagedUnit.locked}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      rotateSelectedStagedUnit(-15);
                    }}
                    className="flex h-11 items-center justify-center rounded border border-cyan-300/60 bg-cyan-300/10 text-cyan-100 disabled:border-slate-700 disabled:bg-slate-900 disabled:text-slate-500"
                    data-testid="button-mobile-deploy-rotate-left"
                  >
                    <ArrowLeft className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Rotate staged ship right"
                    disabled={selectedStagedUnit.locked}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      rotateSelectedStagedUnit(15);
                    }}
                    className="flex h-11 items-center justify-center rounded border border-cyan-300/60 bg-cyan-300/10 text-cyan-100 disabled:border-slate-700 disabled:bg-slate-900 disabled:text-slate-500"
                    data-testid="button-mobile-deploy-rotate-right"
                  >
                    <ArrowRight className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    aria-label={
                      selectedStagedUnit.locked
                        ? "Unlock staged ship"
                        : "Lock staged ship"
                    }
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      toggleSelectedStagedLock();
                    }}
                    className="flex h-11 items-center justify-center rounded border border-amber-300/60 bg-amber-300/10 text-amber-100"
                    data-testid="button-mobile-deploy-lock"
                  >
                    {selectedStagedUnit.locked ? (
                      <Unlock className="h-5 w-5" />
                    ) : (
                      <Lock className="h-5 w-5" />
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label="Remove staged ship"
                    disabled={selectedStagedUnit.locked}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      removeSelectedStagedUnit();
                    }}
                    className="flex h-11 items-center justify-center rounded border border-red-300/50 bg-red-500/10 text-red-100 disabled:border-slate-700 disabled:bg-slate-900 disabled:text-slate-500"
                    data-testid="button-mobile-deploy-remove"
                  >
                    <X className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Deselect staged ship"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setSelectedStagedId(null);
                    }}
                    className="flex h-11 items-center justify-center rounded border border-slate-400/60 bg-slate-900/90 px-1 text-[10px] font-mono uppercase tracking-wider text-slate-100"
                    data-testid="button-mobile-deploy-deselect"
                  >
                    Done
                  </button>
                </div>
              </div>
            )}
          {pendingShadowDispersalPlacement && activeShadowDispersalPlacement && (
            <div
              className="absolute left-3 top-3 z-30 flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded border border-violet-300/60 bg-black/90 px-2 py-1.5 shadow-lg shadow-violet-500/20 backdrop-blur-sm"
              data-testid="shadow-dispersal-placement-prompt"
              onPointerDown={(event) => event.stopPropagation()}
              onPointerMove={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-[10px] font-mono uppercase tracking-wider text-violet-100">
                    Dispersal flight{" "}
                    {pendingShadowDispersalPlacement.activeIndex + 1}/
                    {pendingShadowDispersalPlacement.placements.length}
                  </span>
                  <span
                    className={`shrink-0 text-[9px] font-mono uppercase tracking-widest ${
                      shadowDispersalPlacementLegal
                        ? "text-emerald-300"
                        : "text-red-300"
                    }`}
                  >
                    {shadowDispersalPlacementValidation.shortReason}
                  </span>
                </div>
                <p
                  className={`mt-0.5 max-w-[min(68vw,34rem)] truncate font-mono text-[9px] ${
                    shadowDispersalPlacementLegal
                      ? "text-emerald-100/80"
                      : "text-red-100/90"
                  }`}
                  title={shadowDispersalPlacementValidation.detail}
                  data-testid="shadow-dispersal-placement-reason"
                >
                  {shadowDispersalPlacementValidation.detail}
                </p>
              </div>
              <button
                type="button"
                title={
                  shadowDispersalPlacementLegal
                    ? "Confirm this fighter position"
                    : shadowDispersalPlacementValidation.detail
                }
                aria-label="Confirm this fighter position"
                disabled={
                  !shadowDispersalPlacementLegal ||
                  launchShadowFighterDispersal.isPending
                }
                onClick={confirmShadowDispersalPlacement}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-emerald-300/60 bg-emerald-400/15 text-emerald-100 hover:bg-emerald-400/25 disabled:cursor-not-allowed disabled:border-slate-600 disabled:bg-slate-900 disabled:text-slate-500"
                data-testid="button-confirm-shadow-dispersal-placement"
              >
                <Check className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Cancel Fighter Dispersal placement"
                disabled={launchShadowFighterDispersal.isPending}
                onClick={cancelShadowDispersalPlacement}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground disabled:opacity-40"
                data-testid="button-cancel-shadow-dispersal-placement"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {pendingFighterLaunchPlacement && (
            <div className="absolute left-3 top-3 z-30 flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded border border-sky-300/55 bg-black/88 px-2 py-1.5 shadow-lg shadow-sky-500/15 backdrop-blur-sm">
              <span className="min-w-0 truncate text-[10px] font-mono uppercase tracking-wider text-sky-100">
                Place launch - {pendingFighterLaunchPlacement.itemName}
              </span>
              <span
                className={`shrink-0 text-[9px] font-mono uppercase tracking-widest ${pendingLaunchPlacementLegal ? "text-emerald-300" : "text-red-300"}`}
              >
                {pendingLaunchPlacementLegal ? "legal" : "illegal"}
              </span>
              {pendingLaunchDogfightContact && pendingLaunchPlacementLegal && (
                <span className="shrink-0 text-[9px] font-mono uppercase tracking-widest text-fuchsia-200">
                  Dogfight
                </span>
              )}
              <button
                type="button"
                title="Confirm fighter launch"
                aria-label="Confirm fighter launch"
                disabled={!pendingLaunchPlacementLegal || fighterBayBusyKey !== null}
                onClick={confirmFighterLaunchPlacement}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-emerald-300/60 bg-emerald-400/15 text-emerald-100 hover:bg-emerald-400/25 disabled:cursor-not-allowed disabled:border-slate-600 disabled:bg-slate-900 disabled:text-slate-500"
                data-testid="button-confirm-fighter-launch-placement"
              >
                <Check className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Cancel fighter launch placement"
                onClick={cancelFighterLaunchPlacement}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground"
                data-testid="button-cancel-fighter-launch-placement"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {isMyAntiFighterAllocation && antiFighterState && (
            <div
              className="fixed left-1/2 top-4 z-50 w-[min(420px,calc(100vw-24px))] -translate-x-1/2 rounded border border-emerald-400/50 bg-black/90 px-3 py-2 shadow-xl backdrop-blur"
              data-testid="anti-fighter-allocation-panel"
            >
              <div className="mb-2 text-[10px] font-mono uppercase tracking-wider text-emerald-200">
                end-of-movement anti-fighter - assign dice
              </div>
              <div className="max-h-[46vh] space-y-2 overflow-y-auto pr-1">
                {antiFighterState.attackers.map((attacker) => {
                  const assigned = Object.entries(antiFighterAssignments)
                    .filter(([key]) =>
                      key.startsWith(`${attacker.attackerUnitId}:`),
                    )
                    .reduce((sum, [, count]) => sum + count, 0);
                  return (
                    <div
                      key={attacker.attackerUnitId}
                      className="rounded border border-emerald-500/25 bg-emerald-500/5 p-2"
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="truncate text-[11px] font-mono text-emerald-100">
                          {attacker.attackerName}
                        </span>
                        <span className="shrink-0 text-[10px] font-mono text-emerald-300">
                          {attacker.trait} {attacker.dice}
                        </span>
                      </div>
                      <div className="mb-2 flex gap-1">
                        {Array.from({ length: attacker.dice }).map((_, i) => (
                          <span
                            key={i}
                            className={`h-3 w-3 rotate-45 border ${i < assigned ? "border-zinc-500 bg-black" : "border-emerald-200 bg-emerald-400"}`}
                            aria-label={
                              i < assigned ? "assigned die" : "unassigned die"
                            }
                          />
                        ))}
                      </div>
                      <div className="grid grid-cols-1 gap-1">
                        {attacker.eligibleTargets.map((target) => {
                          const key = `${attacker.attackerUnitId}:${target.targetUnitId}`;
                          const count = antiFighterAssignments[key] ?? 0;
                          return (
                            <button
                              key={target.targetUnitId}
                              type="button"
                              onClick={() =>
                                assignAntiFighterDie(attacker, target)
                              }
                              disabled={
                                assigned >= attacker.dice ||
                                antiFighterCommitting
                              }
                              className="flex items-center justify-between rounded border border-emerald-500/20 bg-zinc-950/80 px-2 py-1 text-left text-[11px] font-mono text-zinc-100 hover:border-emerald-300/60 disabled:cursor-not-allowed disabled:opacity-50"
                              data-testid={`anti-fighter-target-${attacker.attackerUnitId}-${target.targetUnitId}`}
                            >
                              <span className="truncate">
                                {target.targetName}
                              </span>
                              <span className="ml-2 shrink-0 text-emerald-300">
                                {count > 0
                                  ? `${count} die`
                                  : `${target.distance}" H${target.hull}`}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              {antiFighterError && (
                <div className="mt-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] font-mono text-red-200">
                  {antiFighterError}
                  <RuleHint message={antiFighterError} />
                </div>
              )}
              <div className="mt-2 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={clearAntiFighterAssignments}
                  disabled={antiFighterCommitting}
                >
                  Clear
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={commitAntiFighterAllocations}
                  disabled={antiFighterCommitting}
                >
                  {antiFighterCommitting ? "Committing..." : "Commit"}
                </Button>
              </div>
            </div>
          )}
          {antiFighterResult && (
            <div
              className="fixed left-1/2 top-4 z-50 w-[min(420px,calc(100vw-24px))] -translate-x-1/2 rounded border border-emerald-300/50 bg-zinc-950/95 px-3 py-2 shadow-xl backdrop-blur"
              data-testid="anti-fighter-result-panel"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-200">
                  End-of-Movement / Pre-Dogfight Anti-Fighter rolls
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setAntiFighterResult(null)}
                >
                  Close
                </Button>
              </div>
              <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
                {antiFighterResult.attacks.flatMap((attack) => {
                  const byTarget = new Map<number, AntiFighterUiRoll[]>();
                  for (const roll of attack.rolls) {
                    byTarget.set(roll.targetId, [
                      ...(byTarget.get(roll.targetId) ?? []),
                      roll,
                    ]);
                  }
                  return [...byTarget.entries()].map(([targetId, rolls]) => {
                    const first = rolls[0]!;
                    const destroyed = rolls.some((roll) => roll.destroyed);
                    return (
                      <div
                        key={`${attack.attackerId}-${targetId}`}
                        className="rounded border border-emerald-500/25 bg-emerald-500/5 p-2 font-mono"
                      >
                        <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
                          <span className="truncate text-zinc-100">
                            {attack.attackerName} → {first.targetName}
                          </span>
                          <span
                            className={
                              destroyed ? "text-red-300" : "text-zinc-400"
                            }
                          >
                            {destroyed
                              ? "destroyed"
                              : rolls.some((roll) => roll.psychicCrewDodgeSuccessful)
                                ? "psychic dodge"
                              : `Hull ${first.targetHull}`}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {rolls.map((roll, idx) => (
                            <span
                              key={`${roll.targetId}-${idx}`}
                              className={`flex h-7 min-w-7 items-center justify-center rounded border px-1 text-xs font-bold ${roll.destroyed ? "border-red-400 bg-red-500/20 text-red-100" : "border-emerald-400/40 bg-black text-emerald-200"}`}
                              title={`${roll.die}${roll.bonus ? ` + ${roll.bonus}` : ""} = ${roll.total}${
                                roll.psychicCrewDodgeRoll != null
                                  ? `; Psychic Crew dodge ${roll.psychicCrewDodgeRoll} (${roll.psychicCrewDodgeSuccessful ? "saved" : "failed"})`
                                  : ""
                              }${roll.shieldAbsorbed ? "; shield absorbed kill" : ""}`}
                            >
                              {roll.psychicCrewDodgeSuccessful
                                ? `${roll.total}/P`
                                : roll.total}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  });
                })}
                {antiFighterResult.attacks.every(
                  (attack) => attack.rolls.length === 0,
                ) && (
                  <div className="rounded border border-zinc-700 bg-black/60 px-2 py-2 text-center text-[11px] font-mono text-zinc-400">
                    No dice assigned.
                  </div>
                )}
              </div>
            </div>
          )}
          {currentDisplacedFighterToPlace && (
            <div
              className="fixed left-1/2 top-4 z-50 w-[min(420px,calc(100vw-24px))] -translate-x-1/2 rounded border border-sky-300/50 bg-zinc-950/95 px-3 py-2 font-mono shadow-xl backdrop-blur"
              data-testid="fighter-displacement-panel"
            >
              <div className="text-[10px] uppercase tracking-wider text-sky-200">
                Displaced fighter placement
              </div>
              <div className="mt-1 text-sm text-zinc-100">
                {canPlaceCurrentDisplacedFighter
                  ? `Drag within 3" of ${currentDisplacedFighterToPlace.name}'s previous position, then right-click for check/X.`
                  : "Waiting for the other commander to place displaced fighters."}
              </div>
              {canPlaceCurrentDisplacedFighter &&
                stagedDisplacedFighterPlacement && (
                  <div
                    className={`mt-1 text-[11px] ${
                      !stagedDisplacedFighterPlacementLegal
                        ? "text-red-200"
                        : stagedDisplacedFighterDogfightContact
                          ? "text-fuchsia-200"
                          : "text-sky-100/75"
                    }`}
                  >
                    {!stagedDisplacedFighterPlacementLegal
                      ? "Illegal overlap. Drag clear of bases, or cancel."
                      : stagedDisplacedFighterDogfightContact
                        ? "Dogfight placement. Confirm to lock contact."
                        : "Preview staged. Right-click near the fighter to confirm or cancel."}
                  </div>
                )}
              {placeDisplacedFighter.isPending && (
                <div className="mt-1 text-[11px] text-zinc-400">
                  Placing fighter...
                </div>
              )}
            </div>
          )}
          {game.status === "completed" && completedResultTitle && (
            <div
              className="pointer-events-auto absolute left-1/2 top-1/2 z-50 w-[min(420px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded border border-yellow-300/60 bg-black/88 px-5 py-4 text-center shadow-2xl shadow-yellow-950/40 backdrop-blur-md"
              data-testid="game-complete-banner"
            >
              <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-yellow-200/80">
                Game Over
              </p>
              <p className="mt-2 text-2xl font-bold uppercase tracking-[0.18em] text-yellow-200">
                {completedResultTitle}
              </p>
              <p className="mt-2 text-sm font-mono text-muted-foreground">
                {completedResultDetail}
              </p>
              <Link
                href="/lobby"
                className="mt-4 inline-flex h-9 items-center justify-center rounded border border-yellow-300/50 bg-yellow-300/10 px-3 font-mono text-[11px] uppercase tracking-widest text-yellow-100 transition-colors hover:bg-yellow-300/20"
                data-testid="link-game-complete-lobby"
              >
                Return to Lobby
              </Link>
            </div>
          )}
          {manualTerrainPending && manualTerrainPlacement && (
            <div
              className="absolute left-3 top-3 z-30 w-[min(380px,calc(100%-1.5rem))] rounded border border-cyan-300/45 bg-black/88 px-3 py-2 shadow-xl shadow-cyan-950/30 backdrop-blur"
              data-testid="manual-terrain-placement-panel"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-cyan-200">
                    Terrain setup
                  </div>
                  <div className="mt-1 text-[11px] font-mono text-slate-200">
                    {terrainFields.length}/{manualTerrainPlacement.totalCount} placed
                  </div>
                </div>
                <span
                  className={`shrink-0 rounded border px-2 py-1 text-[10px] font-mono uppercase tracking-wider ${
                    canPlaceManualTerrain
                      ? "border-emerald-300/50 bg-emerald-300/10 text-emerald-200"
                      : "border-slate-500/50 bg-slate-900/80 text-slate-300"
                  }`}
                >
                  {canPlaceManualTerrain
                    ? "your turn"
                    : manualTerrainPlacement.nextPlayerId === game.challengerId
                      ? "host turn"
                      : "opponent turn"}
                </span>
              </div>
              {canPlaceManualTerrain ? (
                <div className="mt-2 space-y-2">
                  {manualTerrainChoiceOptions.length > 1 && (
                    <div className="grid grid-cols-3 gap-1">
                      <button
                        type="button"
                        onClick={() => setManualTerrainChoice("asteroid-light")}
                        className={`rounded border px-2 py-1.5 text-[10px] font-mono uppercase tracking-wider ${
                          activeManualTerrainChoice === "asteroid-light"
                            ? "border-cyan-200 bg-cyan-300/15 text-cyan-100"
                            : "border-slate-600 bg-slate-950/80 text-slate-300"
                        }`}
                        data-testid="button-manual-terrain-asteroid-light"
                      >
                        Light
                      </button>
                      <button
                        type="button"
                        onClick={() => setManualTerrainChoice("asteroid-medium")}
                        className={`rounded border px-2 py-1.5 text-[10px] font-mono uppercase tracking-wider ${
                          activeManualTerrainChoice === "asteroid-medium"
                            ? "border-cyan-200 bg-cyan-300/15 text-cyan-100"
                            : "border-slate-600 bg-slate-950/80 text-slate-300"
                        }`}
                        data-testid="button-manual-terrain-asteroid-medium"
                      >
                        Medium
                      </button>
                      {manualTerrainChoiceOptions.includes("gas-cloud") && (
                        <button
                          type="button"
                          onClick={() => setManualTerrainChoice("gas-cloud")}
                          className={`rounded border px-2 py-1.5 text-[10px] font-mono uppercase tracking-wider ${
                            activeManualTerrainChoice === "gas-cloud"
                              ? "border-cyan-200 bg-cyan-300/15 text-cyan-100"
                              : "border-slate-600 bg-slate-950/80 text-slate-300"
                          }`}
                          data-testid="button-manual-terrain-cloud"
                        >
                          Cloud
                        </button>
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setManualTerrainRotationDeg((current) => (((current - 15) % 360) + 360) % 360)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-600 bg-slate-950/80 text-slate-200 hover:border-cyan-200 hover:text-cyan-100"
                      data-testid="button-manual-terrain-rotate-left"
                      title="Rotate left"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                    <div className="h-7 min-w-12 rounded border border-slate-700 bg-slate-950/70 px-2 text-center font-mono text-[10px] leading-7 text-slate-300">
                      {Math.round(manualTerrainRotationDeg)} deg
                    </div>
                    <button
                      type="button"
                      onClick={() => setManualTerrainRotationDeg((current) => (((current + 15) % 360) + 360) % 360)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-600 bg-slate-950/80 text-slate-200 hover:border-cyan-200 hover:text-cyan-100"
                      data-testid="button-manual-terrain-rotate-right"
                      title="Rotate right"
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
                    Q / E rotate
                  </div>
                  {manualTerrainChoiceOptions.length > 1 && !manualTerrainChoiceOptions.includes("gas-cloud") && (
                    <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
                      Asteroid fields
                    </div>
                  )}
                  <div className="text-[11px] font-mono text-slate-300">
                    Click a legal board point. The full footprint must stay out of deployment zones and inside the border.
                  </div>
                  {placeManualTerrain.isPending && (
                    <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-200">
                      placing...
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-2 text-[11px] font-mono text-slate-300">
                  Waiting for the next commander to place terrain.
                </div>
              )}
            </div>
          )}
          {isoCameraControlsEnabled && (
            <TacticalCameraControls
              selectedDisabled={!selectedUnitData}
              activeDisabled={!activeUnitData}
              viewMode={cameraViewMode}
              orientationLocked={cameraOrientationLocked}
              onFocusBoard={focusBoardCamera}
              onFocusActive={() => {
                if (activeUnitData) handleUnitFocus(activeUnitData.id);
              }}
              onFocusSelected={() => {
                if (selectedUnitData) handleUnitFocus(selectedUnitData.id);
              }}
              onSetViewMode={setTacticalCameraView}
              onToggleOrientationLock={toggleCameraOrientationLock}
            />
          )}
          <Canvas camera={{ position: [0, 40, 50], fov: 45 }} shadows>
            <CameraCapture refs={threeRef} />
            {boardBackgroundMode === "skybox" ? (
              <Suspense fallback={null}>
                <Skybox url={skyboxUrl} />
              </Suspense>
            ) : (
              <color attach="background" args={["#000000"]} />
            )}
            <ambientLight intensity={0.4} />
            <directionalLight
              position={[10, 20, 10]}
              intensity={1}
              castShadow
            />
            <pointLight position={[0, 10, 0]} intensity={0.5} color="#f59e0b" />
            {/* Fog tinted a very dark warm tone so distant ships fade into the
                nebula backdrop instead of a mismatched cold grey-black. */}
            <fog
              attach="fog"
              args={[
                boardBackgroundMode === "black" ? "#000000" : "#0a0503",
                60,
                110,
              ]}
            />
            <SpaceGrid
              boardOpacity={boardOpacity}
              showGrid={boardGridEnabled}
            />
            <AttackPhaseBoardPulse
              active={game.status === "active" && currentPhase === "firing"}
              opacity={attackPulseOpacity}
              strength={attackPulseStrength}
            />
            {game.status === "active" && (
              <ConcentrateFireTargetLines units={units} />
            )}
            <BoardBoundary />
            {game.status === "deploying" && (
              <DeploymentZones config={deploymentConfig} mySide={mySide} />
            )}
            <TerrainFields fields={terrainFields} />
            {manualTerrainPreview && canPlaceManualTerrain && (
              <TerrainPlacementPreview
                field={manualTerrainPreview}
                legal={manualTerrainPreviewIsLegal}
              />
            )}
            {game.status === "deploying" &&
              carriedFighterDeploymentGuideCarrier && (
                <CarriedFighterDeploymentGuide
                  carrier={carriedFighterDeploymentGuideCarrier}
                />
              )}
            {pendingShadowDispersalPlacement &&
              pendingShadowDispersalCarrier &&
              pendingShadowDispersalFighterModel && (
                <>
                  <group
                    position={[
                      pendingShadowDispersalCarrier.hexQ,
                      0,
                      pendingShadowDispersalCarrier.hexR,
                    ]}
                    rotation={[
                      0,
                      (pendingShadowDispersalCarrier.heading * Math.PI) / 180,
                      0,
                    ]}
                  >
                    <RangeArcOverlay
                      arc="Forward"
                      range={shadowDispersalGuideRadius}
                      flip={FLIP_MODELS.has(
                        pendingShadowDispersalCarrier.modelFilename,
                      )}
                      colorOverride="#a78bfa"
                    />
                  </group>
                  {pendingShadowDispersalPlacement.activeIndex > 0 && (
                    <ShadowDispersalCohesionGuide
                      x={
                        pendingShadowDispersalPlacement.placements[0]!.hexQ
                      }
                      z={
                        pendingShadowDispersalPlacement.placements[0]!.hexR
                      }
                      centerRadius={
                        SHADOW_DISPERSAL_COHESION_INCHES +
                        rulesBaseRadius(
                          pendingShadowDispersalFighterModel,
                        ) *
                          2 +
                        SHADOW_DISPERSAL_DISTANCE_EPSILON
                      }
                    />
                  )}
                  {pendingShadowDispersalPlacement.placements
                    .slice(
                      0,
                      pendingShadowDispersalPlacement.activeIndex + 1,
                    )
                    .map((placement, index) => {
                      const isCurrent =
                        index ===
                        pendingShadowDispersalPlacement.activeIndex;
                      return (
                        <EndPhaseFighterLaunchPreview
                          key={`shadow-dispersal-preview-${index}`}
                          fighterModel={pendingShadowDispersalFighterModel}
                          x={placement.hexQ}
                          z={placement.hexR}
                          heading={placement.heading}
                          legal={
                            isCurrent
                              ? shadowDispersalPlacementLegal
                              : true
                          }
                          label={
                            isCurrent
                              ? `Place ${index + 1}/${pendingShadowDispersalPlacement.placements.length}`
                              : index === 0
                                ? "Lead flight"
                                : `Flight ${index + 1}`
                          }
                          invalidLabel={
                            isCurrent
                              ? shadowDispersalPlacementValidation.shortReason
                              : undefined
                          }
                          shipMeshTintsEnabled={shipMeshTintsEnabled}
                        />
                      );
                    })}
                </>
              )}
            {pendingFighterLaunchPlacement &&
              pendingLaunchCarrier &&
              pendingLaunchFighterModel && (
                <>
                  <CarriedFighterDeploymentGuide
                    carrier={{
                      x: pendingLaunchCarrier.hexQ,
                      z: pendingLaunchCarrier.hexR,
                    }}
                    radius={carriedFighterDeployCenterRadius(
                      pendingLaunchCarrier,
                      pendingLaunchFighterModel,
                    )}
                  />
                  <EndPhaseFighterLaunchPreview
                    fighterModel={pendingLaunchFighterModel}
                    x={pendingFighterLaunchPlacement.x}
                    z={pendingFighterLaunchPlacement.z}
                    heading={pendingFighterLaunchPlacement.heading}
                    legal={pendingLaunchPlacementLegal}
                    dogfightWarning={pendingLaunchDogfightContact}
                    shipMeshTintsEnabled={shipMeshTintsEnabled}
                  />
                </>
              )}
            {currentDisplacedFighterToPlace && (
              <>
                <CarriedFighterDeploymentGuide
                  carrier={{
                    x: currentDisplacedFighterToPlace.x,
                    z: currentDisplacedFighterToPlace.z,
                  }}
                  radius={3}
                />
                {stagedDisplacedFighterPlacement &&
                  stagedDisplacedFighterPlacement.unitId ===
                    currentDisplacedFighterToPlace.unitId && (
                    <DisplacedFighterPlacementPreview
                      x={stagedDisplacedFighterPlacement.x}
                      z={stagedDisplacedFighterPlacement.z}
                      baseRadiusInches={
                        currentDisplacedFighterToPlace.baseRadiusInches
                      }
                      unit={currentDisplacedFighterUnit}
                      legal={stagedDisplacedFighterPlacementLegal}
                      dogfightWarning={stagedDisplacedFighterDogfightContact}
                      shipMeshTintsEnabled={shipMeshTintsEnabled}
                    />
                  )}
              </>
            )}
            {dogfightImpactEffects.map((effect) => (
              <DogfightImpactFlashes
                key={effect.id}
                effect={effect}
                onDone={(id) =>
                  setDogfightImpactEffects((prev) =>
                    prev.filter((item) => item.id !== id),
                  )
                }
              />
            ))}
            {units.map((unit) => {
              if (displacedFighterUnitIds.has(unit.id)) return null;
              const unitIsFighter = isFighterUnit(unit);
              if (unit.isDestroyed && unitIsFighter) return null;
              const weaponsForUnit = getWeaponsForUnit(unit);
              const unitModel = shipModels.find((model) => model.id === unit.shipModelId);
              const weaponArcReadiness = buildWeaponArcReadiness(
                unit,
                unitModel,
                weaponsForUnit,
                game.currentRound ?? 0,
              );
              const unitModel = getShipModelForUnit(unit);
              const phaseViable =
                game.status === "active" &&
                (currentPhase === "movement" || currentPhase === "firing") &&
                unitEligibleForCurrentPhase(unit) &&
                (currentPhase !== "firing" ||
                  activationSegment === null ||
                  (activationSegment === "fighter"
                    ? unitIsFighter
                    : !unitIsFighter));
              // Show the weapon's full-range coverage sector ONLY for the
              // active firing ship while a weapon is selected for targeting.
              let firingArc: { arc: string; range: number } | null = null;
              if (
                currentPhase === "firing" &&
                firingWeaponPicking !== null &&
                unit.id === activeUnitId
              ) {
                const w = weaponsForUnit.find(
                  (x) => x.id === firingWeaponPicking,
                );
                if (w) {
                  const shadowPointDefense =
                    uiShadowPointDefenseWeaponActive(
                      unit,
                      unitModel,
                      w,
                      game.currentRound ?? 0,
                    );
                  firingArc = {
                    arc: shadowPointDefense ? "Turret" : w.arc,
                    range:
                      (shadowPointDefense ? w.range / 2 : w.range) +
                      (unitIsFighter ? rulesBaseRadius(unit) : 0),
                  };
                }
              }
              const projectedWeaponArcs =
                weaponArcProjectionEnabled && selectedUnit === unit.id
                  ? weaponsForUnit.map((w) => {
                      const shadowPointDefense =
                        uiShadowPointDefenseWeaponActive(
                          unit,
                          unitModel,
                          w,
                          game.currentRound ?? 0,
                        );
                      return {
                        arc: shadowPointDefense ? "Turret" : w.arc,
                        range:
                          (shadowPointDefense ? w.range / 2 : w.range) +
                          (unitIsFighter ? rulesBaseRadius(unit) : 0),
                      };
                    })
                  : [];
              let targetingPreview: TargetingPreviewState | null = null;
              if (
                activeTargetingPreview &&
                unit.id !== activeTargetingPreview.attacker.id &&
                unit.ownerId !== activeTargetingPreview.attacker.ownerId &&
                unitIsCombatEffective(unit)
              ) {
                const distance = weaponRangeDistanceForPreview(
                  activeTargetingPreview.attacker,
                  unit,
                  Boolean(activeTargetingPreview.attacker.isFighter),
                  unitIsFighter,
                );
                const inRange = distance <= activeTargetingPreview.weapon.range + 1e-6;
                const inArc = isTargetInWeaponArc(
                  activeTargetingPreview.attacker,
                  unit,
                  activeTargetingPreview.weapon.arc,
                );
                const losBlocked = Boolean(
                  weaponLineOfSightBlockForPreview(
                    activeTargetingPreview.attacker,
                    unit,
                    lineOfSightObstacles,
                  ),
                );
                targetingPreview =
                  inRange && inArc && !losBlocked && !activeFighterLockedInDogfight
                    ? "eligible"
                    : "ineligible";
              }
              let visualAttackTurn: { key: string; targetHeading: number } | null = null;
              const visualAttackPhases = new Set<DiceModalPhase>([
                "attack-rolling",
                "attack-shown",
                "damage-ready",
                "damage-rolling",
                "damage-shown",
              ]);
              if (
                diceModal &&
                visualAttackPhases.has(diceModal.phase) &&
                diceModal.attackerUnitId === unit.id &&
                isKirishiacVisualBeamWeapon(unit, diceModal.weapon)
              ) {
                const target = units.find((candidate) => candidate.id === diceModal.targetId);
                if (target) {
                  const [ux, , uz] = hexToWorld(unit.hexQ, unit.hexR);
                  const [tx, , tz] = hexToWorld(target.hexQ, target.hexR);
                  visualAttackTurn = {
                    key: `player-${diceModal.attackerUnitId}-${diceModal.weapon.id}-${diceModal.targetId}`,
                    targetHeading: headingForVisualVector(unit, tx - ux, tz - uz),
                  };
                }
              } else if (aiWeaponFxReplay?.attackerUnitId === unit.id) {
                const weapon = weaponsForUnit.find((candidate) => candidate.id === aiWeaponFxReplay.weaponId);
                const target = units.find((candidate) => candidate.id === aiWeaponFxReplay.targetUnitId);
                if (weapon && target && isKirishiacVisualBeamWeapon(unit, weapon)) {
                  const [ux, , uz] = hexToWorld(unit.hexQ, unit.hexR);
                  const [tx, , tz] = hexToWorld(target.hexQ, target.hexR);
                  visualAttackTurn = {
                    key: `ai-${aiWeaponFxReplay.key}`,
                    targetHeading: headingForVisualVector(unit, tx - ux, tz - uz),
                  };
                }
              }
              return (
                <GameUnit3D
                  key={unit.id}
                  unit={unit}
                  isSelected={selectedUnit === unit.id}
                  onClick={() => handleUnitClick(unit.id)}
                  onCameraFocus={() => handleUnitFocus(unit.id)}
                  onHoverChange={handleUnitHoverChange}
                  myUserId={myUserId}
                  weapons={weaponsForUnit}
                  dragOffset={
                    unit.id === selectedUnit ? selectedDragOffset : null
                  }
                  previewHeadingDelta={
                    unit.id === selectedUnit ? selectedPreviewHeadingDelta : 0
                  }
                  visualAttackTurn={visualAttackTurn}
                  phaseViable={phaseViable}
                  firingArc={firingArc}
                  projectedWeaponArcs={projectedWeaponArcs}
                  weaponArcReadiness={weaponArcReadiness}
                  targetingPreview={targetingPreview}
                  arcColorScheme={uiArcColorScheme}
                  healthBarFacesCamera={uiControlMode === "mode-f"}
                  shipMeshTintsEnabled={shipMeshTintsEnabled}
                  shipHullNamesEnabled={shipHullNamesEnabled}
                  shipStatusDisplayMode={shipStatusDisplayMode}
                  isFighter={unitIsFighter}
                  scoutSupportEffects={
                    scoutSupportEffectsByTargetId.get(unit.id) ?? []
                  }
                  terrainFields={terrainFields}
                  dogfightLocked={dogfightingFighterUnitIds.has(unit.id)}
                  launchHighlight={
                    endPhaseLaunchPrompt?.mode === "highlight" &&
                    eligibleLaunchCarrierIds.has(unit.id)
                  }
                  damageControlHighlight={unitCanUseDamageControlNow(unit)}
                />
              );
            })}
            {game.status === "active" &&
              currentPhase === "movement" &&
              isSelectedUnitActive &&
              selectedUnitData &&
              !selectedUnitData.isDestroyed &&
              selectedUnitData.damageState !== "adrift" &&
              selectedUnitData.damageState !== "exploding-end-of-next" &&
              (() => {
                // Per sheet: every ship MUST move at least half its base speed
                // each activation UNLESS it has declared All Stop / All Stop &
                // Pivot, or is under mandatory-move status (adrift / about to
                // explode). Red-until-met / green-once-met arrow surfaces this.
                const baseAction = (
                  selectedUnitData.specialAction ?? ""
                ).replace(/-failed$/, "");
                const minExempt =
                  baseAction === "all-stop" ||
                  baseAction === "all-stop-pivot" ||
                  Boolean(selectedMovementUi?.isSuperManeuverable);
                const minRequired = minExempt
                  ? 0
                  : effectiveUiSpeed(selectedUnitData) / 2;
                const turnRequired = selectedMovementUi?.turnGateExempt
                  ? 0
                  : selectedMovementUi?.neededStraight;
                const turnRequirementLabel =
                  turnRequired &&
                  Number.isFinite(turnRequired) &&
                  turnRequired > 0
                    ? `turn ${turnRequired.toFixed(turnRequired % 1 === 0 ? 0 : 1)}"`
                    : undefined;
                const committedBefore = getLedger(selectedUnitData.id).distance;
                if (isFighterUnit(selectedUnitData)) {
                  return (
                    <FighterMovementPlanner
                      unit={selectedUnitData}
                      plan={movePlan}
                      remainingMove={selectedRemainingMove}
                      dogfightWarning={plannedFighterDogfightContact}
                    />
                  );
                }
                return (
                  <MovementPlanner
                    unit={selectedUnitData}
                    plan={movePlan}
                    flip={FLIP_MODELS.has(selectedUnitData.modelFilename)}
                    remainingMove={selectedRemainingMove}
                    minRequired={minRequired}
                    turnRequired={turnRequired}
                    turnRequirementLabel={turnRequirementLabel}
                    committedBefore={committedBefore}
                    minExempt={minExempt}
                  />
                );
              })()}
            {currentPhase === "movement" &&
              mobileGameChrome &&
              !touchGameControls &&
              isSelectedUnitActive &&
              selectedUnitData &&
              selectedMovementUi &&
              !selectedUnitData.isDestroyed &&
              selectedUnitData.damageState !== "adrift" &&
              selectedUnitData.damageState !== "exploding-end-of-next" && (
                <MovementRadialMenu
                  unit={selectedUnitData}
                  flip={FLIP_MODELS.has(selectedUnitData.modelFilename)}
                  canForward={
                    selectedMovementUi.canForward &&
                    !selectedFighterLockedInDogfight &&
                    !moveUnit.isPending &&
                    !activateUnit.isPending
                  }
                  canTurn={
                    selectedMovementUi.canTurn &&
                    !selectedFighterLockedInDogfight &&
                    !moveUnit.isPending &&
                    !activateUnit.isPending
                  }
                  isSuperManeuverable={selectedMovementUi.isSuperManeuverable}
                  activeGesture={movementGesture}
                  onForward={() => {
                    if (isFighterUnit(selectedUnitData)) {
                      if (selectedFighterLockedInDogfight) {
                        setActivationFeedback(
                          "Fighter is locked in a dogfight; use the Dogfight action instead.",
                        );
                        return;
                      }
                      setMovementGesture({ kind: "fighter-free" });
                      setMovePlan((prev) =>
                        prev?.kind === "fighter-free"
                          ? prev
                          : {
                              kind: "fighter-free",
                              x: selectedUnitData.hexQ,
                              z: selectedUnitData.hexR,
                              heading: selectedUnitData.heading,
                            },
                      );
                      return;
                    }
                    setMovementGesture({ kind: "forward" });
                    setMovePlan((prev) =>
                      prev?.kind === "forward"
                        ? prev
                        : { kind: "forward", distance: 0 },
                    );
                  }}
                  onTurnLeft={() => {
                    if (isFighterUnit(selectedUnitData)) {
                      if (selectedFighterLockedInDogfight) {
                        setActivationFeedback(
                          "Fighter is locked in a dogfight; use the Dogfight action instead.",
                        );
                        return;
                      }
                      nudgeTurnPlan(-TABLET_TURN_STEP_DEG, "left");
                      return;
                    }
                    setMovementGesture({ kind: "turn", direction: "left" });
                    setMovePlan((prev) =>
                      prev?.kind === "turn"
                        ? prev
                        : { kind: "turn", deltaDeg: 0 },
                    );
                  }}
                  onTurnRight={() => {
                    if (isFighterUnit(selectedUnitData)) {
                      if (selectedFighterLockedInDogfight) {
                        setActivationFeedback(
                          "Fighter is locked in a dogfight; use the Dogfight action instead.",
                        );
                        return;
                      }
                      nudgeTurnPlan(TABLET_TURN_STEP_DEG, "right");
                      return;
                    }
                    setMovementGesture({ kind: "turn", direction: "right" });
                    setMovePlan((prev) =>
                      prev?.kind === "turn"
                        ? prev
                        : { kind: "turn", deltaDeg: 0 },
                    );
                  }}
                  onFreeTurn={() => {
                    if (isFighterUnit(selectedUnitData)) {
                      if (selectedFighterLockedInDogfight) {
                        setActivationFeedback(
                          "Fighter is locked in a dogfight; use the Dogfight action instead.",
                        );
                        return;
                      }
                      startFreeTurnPlan();
                      return;
                    }
                    setMovementGesture({ kind: "turn", direction: "free" });
                    setMovePlan((prev) =>
                      prev?.kind === "turn"
                        ? prev
                        : { kind: "turn", deltaDeg: 0 },
                    );
                  }}
                />
              )}
            {currentStagedUnits.map((unit) => (
              <StagedUnit3D
                key={unit.id}
                unit={unit}
                isSelected={selectedStagedId === unit.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedStagedId(unit.id);
                }}
                onPointerDown={
                  unit.locked
                    ? undefined
                    : (e) => {
                        e.stopPropagation();
                        setSelectedStagedId(unit.id);
                        setDraggingId(unit.id);
                      }
                }
                arcColorScheme={uiArcColorScheme}
                shipMeshTintsEnabled={shipMeshTintsEnabled}
                shipHullNamesEnabled={shipHullNamesEnabled}
              />
            ))}
            <BoardCameraControls
              disabled={boardCameraInputDisabled}
              focusRequest={cameraFocusRequest}
              viewRequest={cameraViewRequest}
              orientationLocked={cameraOrientationLocked}
              controlMode={uiControlMode}
            />
            {/* Weapon firing FX — mounts when a shot starts rolling and stays
                mounted for the rest of the dice modal lifetime. Internal
                animations handle their own fade. */}
            {(() => {
              if (!diceModal) return null;
              const fxPhases = new Set<DiceModalPhase>([
                "attack-rolling",
                "attack-shown",
                "damage-ready",
                "damage-rolling",
                "damage-shown",
              ]);
              if (!fxPhases.has(diceModal.phase)) return null;
              const attacker = units.find(
                (u) => u.id === diceModal.attackerUnitId,
              );
              const target = units.find((u) => u.id === diceModal.targetId);
              if (!attacker || !target) return null;
              const [ax, , az] = hexToWorld(attacker.hexQ, attacker.hexR);
              const [tx, , tz] = hexToWorld(target.hexQ, target.hexR);
              // Ship models sit at y≈2; aim the beam at hull-center.
              const from = new THREE.Vector3(ax, 2, az);
              const to = new THREE.Vector3(tx, 2, tz);
              const hits = diceModal.result?.hits ?? 0;
              const fxKey = `${diceModal.attackerUnitId}-${diceModal.weapon.id}-${diceModal.targetId}`;
              return (
                <OptionalFxErrorBoundary key={fxKey}>
                  <WeaponFx
                    from={from}
                    to={to}
                    weapon={diceModal.weapon}
                    attackerFaction={attacker.faction}
                    attackerName={attacker.name}
                    attackerModelFilename={attacker.modelFilename}
                    attackerHeading={attacker.heading}
                    hits={hits}
                    totalDice={diceModal.attackDice}
                  />
                </OptionalFxErrorBoundary>
              );
            })()}
            {(() => {
              if (!aiWeaponFxReplay) return null;
              const attacker = units.find(
                (u) => u.id === aiWeaponFxReplay.attackerUnitId,
              );
              const target = units.find(
                (u) => u.id === aiWeaponFxReplay.targetUnitId,
              );
              if (!attacker || !target) return null;
              const weapon = getWeaponsForUnit(attacker).find(
                (w) => w.id === aiWeaponFxReplay.weaponId,
              );
              if (!weapon) return null;
              const [ax, , az] = hexToWorld(attacker.hexQ, attacker.hexR);
              const [tx, , tz] = hexToWorld(target.hexQ, target.hexR);
              return (
                <OptionalFxErrorBoundary key={aiWeaponFxReplay.key}>
                  <WeaponFx
                    from={new THREE.Vector3(ax, 2, az)}
                    to={new THREE.Vector3(tx, 2, tz)}
                    weapon={weapon}
                    attackerFaction={attacker.faction}
                    attackerName={attacker.name}
                    attackerModelFilename={attacker.modelFilename}
                    attackerHeading={attacker.heading}
                    hits={aiWeaponFxReplay.hits}
                    totalDice={weapon.attackDice}
                  />
                </OptionalFxErrorBoundary>
              );
            })()}
            <EffectComposer>
              <Bloom
                intensity={0.9}
                luminanceThreshold={0.55}
                luminanceSmoothing={0.2}
                mipmapBlur
              />
            </EffectComposer>
          </Canvas>
          {endPhaseLaunchPrompt?.mode === "prompt" &&
            eligibleLaunchCarrierIds.size > 0 && (
              <div
                className="pointer-events-auto absolute left-1/2 top-1/2 z-40 w-[min(18rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded border border-sky-300/45 bg-black/88 p-4 text-center shadow-2xl shadow-sky-500/20 backdrop-blur-sm"
                data-testid="end-phase-launch-fighters-prompt"
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="font-mono text-sm font-semibold uppercase tracking-[0.2em] text-sky-100">
                  Launch fighters?
                </div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-sky-200/70">
                  {eligibleLaunchCarrierIds.size} eligible carrier
                  {eligibleLaunchCarrierIds.size === 1 ? "" : "s"}
                </div>
                <div className="mt-4 flex items-center justify-center gap-3">
                  <button
                    type="button"
                    title="Show eligible carriers"
                    aria-label="Show eligible carriers"
                    className="flex h-10 w-10 items-center justify-center rounded border border-emerald-300/70 bg-emerald-400/15 text-emerald-100 shadow-[0_0_16px_rgba(52,211,153,0.24)] transition-colors hover:bg-emerald-400/25"
                    data-testid="button-show-launch-fighter-carriers"
                    onClick={() =>
                      setEndPhaseLaunchPrompt((prev) =>
                        prev ? { ...prev, mode: "highlight" } : prev,
                      )
                    }
                  >
                    <Check className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    title="Skip fighter launches"
                    aria-label="Skip fighter launches"
                    className="flex h-10 w-10 items-center justify-center rounded border border-red-300/70 bg-red-400/15 text-red-100 shadow-[0_0_14px_rgba(248,113,113,0.2)] transition-colors hover:bg-red-400/25"
                    data-testid="button-skip-launch-fighters"
                    onClick={() =>
                      setEndPhaseLaunchPrompt((prev) =>
                        prev ? { ...prev, mode: "skipped" } : prev,
                      )
                    }
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
              </div>
            )}
          {selectedLaunchCarrier &&
            selectedLaunchCarrierItems.length > 0 &&
            !pendingFighterLaunchPlacement &&
            (() => {
              const canvas = threeRef.current
                ? ((threeRef.current.gl as any).domElement as HTMLCanvasElement)
                : null;
              const rect = canvas?.getBoundingClientRect();
              const projected = boardToScreen(
                selectedLaunchCarrier.hexQ,
                selectedLaunchCarrier.hexR,
                threeRef,
              );
              const width = 260;
              const height = 72 + selectedLaunchCarrierItems.length * 38;
              const left = rect
                ? Math.max(
                    8,
                    Math.min(
                      rect.width - width - 8,
                      (projected?.x ?? rect.width / 2) + 18,
                    ),
                  )
                : 16;
              const top = rect
                ? Math.max(
                    8,
                    Math.min(
                      rect.height - height - 8,
                      (projected?.y ?? rect.height / 2) - 12,
                    ),
                  )
                : 16;
              return (
                <div
                  className="pointer-events-auto absolute z-40 w-[260px] rounded border border-sky-300/45 bg-black/88 p-2 shadow-2xl shadow-sky-500/20 backdrop-blur-sm"
                  style={{ left, top }}
                  data-testid="end-phase-launch-carrier-menu"
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <div className="space-y-1.5">
                    {selectedLaunchCarrierItems.map((item) => {
                      const key = `launch:${selectedLaunchCarrier.id}:${item.shipModelId ?? item.name}`;
                      const disabled =
                        fighterBayBusyKey !== null ||
                        !canLaunchFightersFromCarrier(selectedLaunchCarrier);
                      const beginPlacement = () => {
                        if (disabled) return;
                        beginFighterLaunchPlacement(selectedLaunchCarrier, item);
                      };
                      return (
                        <div
                          key={`${item.name}-${item.shipModelId ?? "unlinked"}`}
                          className="flex items-center justify-between gap-2 rounded border border-sky-300/15 bg-sky-300/5 px-2 py-1.5"
                          onDoubleClick={beginPlacement}
                          title="Double-click to place"
                        >
                          <div className="min-w-0 font-mono">
                            <div className="truncate text-[11px] font-semibold text-sky-100">
                              {item.name}
                            </div>
                            <div className="text-[9px] uppercase tracking-widest text-sky-200/60">
                              {item.available}/{item.total} available
                            </div>
                          </div>
                          <button
                            type="button"
                            className="h-7 shrink-0 rounded border border-emerald-300/60 bg-emerald-400/15 px-2 font-mono text-[9px] font-bold uppercase tracking-widest text-emerald-100 transition-colors hover:bg-emerald-400/25 disabled:cursor-not-allowed disabled:border-slate-600 disabled:bg-slate-900 disabled:text-slate-500"
                            disabled={disabled}
                            onClick={beginPlacement}
                            data-testid="button-launch-carrier-fighter"
                          >
                            {fighterBayBusyKey === key ? "..." : "Place"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded border border-red-300/60 bg-red-400/10 font-mono text-[10px] font-bold uppercase tracking-widest text-red-100 transition-colors hover:bg-red-400/20"
                    data-testid="button-end-fighter-launches"
                    onClick={() =>
                      setEndPhaseLaunchPrompt((prev) =>
                        prev ? { ...prev, mode: "skipped" } : prev,
                      )
                    }
                  >
                    <X className="h-3.5 w-3.5" />
                    End launches
                  </button>
                </div>
              );
            })()}
          {moveConfirmPopover && canUsePcMoveConfirmPopover && (
            <div
              className="absolute z-40 flex flex-col items-stretch gap-1 rounded border border-cyan-300/50 bg-black/88 p-1 shadow-xl shadow-black/60 backdrop-blur-sm"
              style={{
                left: moveConfirmPopover.x,
                top: moveConfirmPopover.y,
              }}
              data-testid="pc-move-confirm-popover"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerMove={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  title="Confirm move"
                  aria-label="Confirm move"
                  disabled={!canConfirmMovePlan}
                  onClick={confirmMovePlan}
                  className="flex h-9 w-9 items-center justify-center rounded border border-emerald-300/70 bg-emerald-400/15 text-emerald-100 shadow-[0_0_12px_rgba(52,211,153,0.22)] transition-colors hover:bg-emerald-400/25 disabled:cursor-not-allowed disabled:border-slate-600 disabled:bg-slate-900 disabled:text-slate-500 disabled:shadow-none"
                  data-testid="button-pc-confirm-move-plan"
                >
                  <Check className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  title="Cancel move"
                  aria-label="Cancel move"
                  onClick={cancelMovePlan}
                  className="flex h-9 w-9 items-center justify-center rounded border border-red-300/70 bg-red-400/15 text-red-100 shadow-[0_0_12px_rgba(248,113,113,0.18)] transition-colors hover:bg-red-400/25"
                  data-testid="button-pc-cancel-move-plan"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              {canEndActivationFromPcMovePopover && (
                <button
                  type="button"
                  title="End activation"
                  aria-label="End activation"
                  onClick={handleRequestEndActivation}
                  className="flex h-7 w-full items-center justify-center rounded border border-cyan-300/55 bg-cyan-300/10 px-2 font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-cyan-100 shadow-[0_0_12px_rgba(34,211,238,0.18)] transition-colors hover:bg-cyan-300/20"
                  data-testid="button-pc-popover-end-activation"
                >
                  End Activation
                </button>
              )}
            </div>
          )}
          {shadowDispersalConfirmPopover &&
            pendingShadowDispersalPlacement && (
              <div
                className="absolute z-40 flex items-center gap-1 rounded border border-violet-300/55 bg-black/88 p-1 shadow-xl shadow-black/60 backdrop-blur-sm"
                style={{
                  left: shadowDispersalConfirmPopover.x,
                  top: shadowDispersalConfirmPopover.y,
                }}
                data-testid="pc-shadow-dispersal-confirm-popover"
                onPointerDown={(e) => e.stopPropagation()}
                onPointerMove={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <button
                  type="button"
                  title={
                    shadowDispersalPlacementLegal
                      ? "Confirm fighter placement"
                      : shadowDispersalPlacementValidation.detail
                  }
                  aria-label={
                    shadowDispersalPlacementLegal
                      ? "Confirm Shadow fighter placement"
                      : shadowDispersalPlacementValidation.detail
                  }
                  disabled={
                    !shadowDispersalPlacementLegal ||
                    launchShadowFighterDispersal.isPending
                  }
                  onClick={confirmShadowDispersalPlacement}
                  className="flex h-9 w-9 items-center justify-center rounded border border-emerald-300/70 bg-emerald-400/15 text-emerald-100 shadow-[0_0_12px_rgba(52,211,153,0.22)] transition-colors hover:bg-emerald-400/25 disabled:cursor-not-allowed disabled:border-slate-600 disabled:bg-slate-900 disabled:text-slate-500 disabled:shadow-none"
                  data-testid="button-pc-confirm-shadow-dispersal"
                >
                  <Check className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  title="Cancel Fighter Dispersal"
                  aria-label="Cancel Fighter Dispersal"
                  disabled={launchShadowFighterDispersal.isPending}
                  onClick={cancelShadowDispersalPlacement}
                  className="flex h-9 w-9 items-center justify-center rounded border border-red-300/70 bg-red-400/15 text-red-100 shadow-[0_0_12px_rgba(248,113,113,0.18)] transition-colors hover:bg-red-400/25 disabled:cursor-not-allowed disabled:border-slate-600 disabled:bg-slate-900 disabled:text-slate-500 disabled:shadow-none"
                  data-testid="button-pc-cancel-shadow-dispersal"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            )}
          {fighterLaunchConfirmPopover &&
            pendingFighterLaunchPlacement &&
            pendingLaunchPlacementLegal && (
              <div
                className="absolute z-40 flex items-center gap-1 rounded border border-sky-300/50 bg-black/88 p-1 shadow-xl shadow-black/60 backdrop-blur-sm"
                style={{
                  left: fighterLaunchConfirmPopover.x,
                  top: fighterLaunchConfirmPopover.y,
                }}
                data-testid="pc-fighter-launch-confirm-popover"
                onPointerDown={(e) => e.stopPropagation()}
                onPointerMove={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <button
                  type="button"
                  title="Confirm fighter launch"
                  aria-label="Confirm fighter launch"
                  disabled={fighterBayBusyKey !== null}
                  onClick={confirmFighterLaunchPlacement}
                  className="flex h-9 w-9 items-center justify-center rounded border border-emerald-300/70 bg-emerald-400/15 text-emerald-100 shadow-[0_0_12px_rgba(52,211,153,0.22)] transition-colors hover:bg-emerald-400/25 disabled:cursor-not-allowed disabled:border-slate-600 disabled:bg-slate-900 disabled:text-slate-500 disabled:shadow-none"
                  data-testid="button-pc-confirm-fighter-launch"
                >
                  <Check className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  title="Cancel fighter launch"
                  aria-label="Cancel fighter launch"
                  disabled={fighterBayBusyKey !== null}
                  onClick={cancelFighterLaunchPlacement}
                  className="flex h-9 w-9 items-center justify-center rounded border border-red-300/70 bg-red-400/15 text-red-100 shadow-[0_0_12px_rgba(248,113,113,0.18)] transition-colors hover:bg-red-400/25 disabled:cursor-not-allowed disabled:border-slate-600 disabled:bg-slate-900 disabled:text-slate-500 disabled:shadow-none"
                  data-testid="button-pc-cancel-fighter-launch"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            )}
          {touchGameControls && pendingFighterLaunchPlacement && (
            <div
              className="pointer-events-auto absolute bottom-14 left-1/2 z-40 w-[min(92vw,24rem)] -translate-x-1/2 rounded border border-sky-300/55 bg-black/90 p-3 shadow-2xl shadow-sky-950/50 backdrop-blur-sm"
              data-testid="touch-fighter-launch-confirm-strip"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerMove={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-2 flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-wider">
                <span className="min-w-0 truncate text-sky-100">
                  {pendingFighterLaunchPlacement.itemName}
                </span>
                <span
                  className={
                    pendingLaunchPlacementLegal
                      ? "shrink-0 text-emerald-300"
                      : "shrink-0 text-red-300"
                  }
                >
                  {pendingLaunchPlacementLegal ? "Legal" : "Illegal"}
                </span>
              </div>
              <div className="mb-3 font-mono text-[10px] leading-snug text-sky-100/75">
                Tap inside the launch ring to move the preview, then confirm.
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-11 border-red-300/60 bg-red-400/10 text-xs font-bold uppercase tracking-widest text-red-100 hover:bg-red-400/20"
                  disabled={fighterBayBusyKey !== null}
                  onClick={cancelFighterLaunchPlacement}
                  data-testid="button-touch-cancel-fighter-launch"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-11 bg-emerald-400 text-xs font-black uppercase tracking-widest text-black hover:bg-emerald-300 disabled:bg-slate-700 disabled:text-slate-400"
                  disabled={
                    !pendingLaunchPlacementLegal || fighterBayBusyKey !== null
                  }
                  onClick={confirmFighterLaunchPlacement}
                  data-testid="button-touch-confirm-fighter-launch"
                >
                  {fighterBayBusyKey !== null
                    ? "Launching..."
                    : "Confirm Launch"}
                </Button>
              </div>
            </div>
          )}
          {displacedFighterConfirmPopover &&
            canPlaceCurrentDisplacedFighter &&
            stagedDisplacedFighterPlacement && (
              <div
                className="absolute z-40 flex items-center gap-1 rounded border border-cyan-300/50 bg-black/88 p-1 shadow-xl shadow-black/60 backdrop-blur-sm"
                style={{
                  left: displacedFighterConfirmPopover.x,
                  top: displacedFighterConfirmPopover.y,
                }}
                data-testid="pc-displaced-fighter-confirm-popover"
                onPointerDown={(e) => e.stopPropagation()}
                onPointerMove={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <button
                  type="button"
                  title={
                    stagedDisplacedFighterPlacementLegal
                      ? "Confirm placement"
                      : "Placement overlaps another base"
                  }
                  aria-label="Confirm placement"
                  disabled={
                    placeDisplacedFighter.isPending ||
                    !stagedDisplacedFighterPlacementLegal
                  }
                  onClick={confirmDisplacedFighterPlacement}
                  className="flex h-9 w-9 items-center justify-center rounded border border-emerald-300/70 bg-emerald-400/15 text-emerald-100 shadow-[0_0_12px_rgba(52,211,153,0.22)] transition-colors hover:bg-emerald-400/25 disabled:cursor-not-allowed disabled:border-slate-600 disabled:bg-slate-900 disabled:text-slate-500 disabled:shadow-none"
                  data-testid="button-confirm-displaced-fighter-placement"
                >
                  <Check className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  title="Cancel placement"
                  aria-label="Cancel placement"
                  disabled={placeDisplacedFighter.isPending}
                  onClick={cancelDisplacedFighterPlacement}
                  className="flex h-9 w-9 items-center justify-center rounded border border-red-300/70 bg-red-400/15 text-red-100 shadow-[0_0_12px_rgba(248,113,113,0.18)] transition-colors hover:bg-red-400/25 disabled:cursor-not-allowed disabled:border-slate-600 disabled:bg-slate-900 disabled:text-slate-500 disabled:shadow-none"
                  data-testid="button-cancel-displaced-fighter-placement"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            )}
          {touchGameControls &&
            currentPhase === "movement" &&
            isSelectedUnitActive &&
            selectedUnitData &&
            selectedMovementUi &&
            !selectedUnitData.isDestroyed &&
            selectedUnitData.damageState !== "adrift" &&
            selectedUnitData.damageState !== "exploding-end-of-next" && (
              <TabletMovementController
                plan={movePlan}
                canForward={
                  selectedMovementUi.canForward &&
                  !selectedFighterLockedInDogfight &&
                  !moveUnit.isPending &&
                  !activateUnit.isPending
                }
                canTurn={
                  selectedMovementUi.canTurn &&
                  !selectedFighterLockedInDogfight &&
                  !moveUnit.isPending &&
                  !activateUnit.isPending
                }
                canConfirm={canConfirmMovePlan}
                isSuperManeuverable={selectedMovementUi.isSuperManeuverable}
                freeTurnActive={
                  movementGesture?.kind === "turn" &&
                  movementGesture.direction === "free"
                }
                remainingMove={selectedRemainingMove}
                angleCap={selectedMovementUi.angleCap}
                turnHint={tabletMoveHint}
                onForward={() => nudgeForwardPlan(TABLET_FORWARD_STEP)}
                onBack={() => nudgeForwardPlan(-TABLET_FORWARD_STEP)}
                onTurnLeft={() => nudgeTurnPlan(-TABLET_TURN_STEP_DEG, "left")}
                onTurnRight={() => nudgeTurnPlan(TABLET_TURN_STEP_DEG, "right")}
                onFreeTurn={startFreeTurnPlan}
                onCancel={cancelMovePlan}
                onConfirm={confirmMovePlan}
                canEndActivation={
                  hasActiveUnit &&
                  !endActivation.isPending
                }
                endActivationLabel={
                  endActivation.isPending ? "Ending..." : "End Activation"
                }
                endActivationTitle={
                  minMoveGate.blocked
                    ? `Server will allow this only if no legal final resting spot can satisfy the ${formatInches(minMoveGate.required)}" minimum move`
                    : undefined
                }
                onEndActivation={handleRequestEndActivation}
              />
            )}
          {mobileGameChrome &&
            !touchGameControls &&
            currentPhase === "movement" &&
            isSelectedUnitActive &&
            selectedUnitData &&
            movePlan && (
              <div
                className="absolute bottom-14 right-3 z-20 w-[min(92vw,22rem)] rounded border border-cyan-500/50 bg-card/95 p-2 shadow-xl"
                data-testid="mobile-move-confirm-strip"
                onPointerMove={(e) => e.stopPropagation()}
              >
                <div className="mb-2 flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-wider text-cyan-200">
                  <span className="truncate">Move Preview</span>
                  <span className="text-cyan-300">
                    {movePlan.kind === "forward"
                      ? `${movePlan.distance.toFixed(1)}"`
                      : movePlan.kind === "turn"
                        ? `${movePlan.deltaDeg > 0 ? "+" : ""}${movePlan.deltaDeg} deg`
                        : `${Math.hypot(movePlan.x - selectedUnitData.hexQ, movePlan.z - selectedUnitData.hexR).toFixed(1)}" / ${Math.round(movePlan.heading)} deg`}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-10 border-border text-xs uppercase tracking-widest"
                    onClick={() => {
                      setMovementGesture(null);
                      cancelMovePlan();
                    }}
                    data-testid="button-mobile-cancel-move-plan"
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    className="h-10 text-xs font-bold uppercase tracking-widest"
                    disabled={!canConfirmMovePlan}
                    onClick={() => {
                      setMovementGesture(null);
                      confirmMovePlan();
                    }}
                    data-testid="button-mobile-confirm-move-plan"
                  >
                    Confirm
                  </Button>
                </div>
              </div>
            )}
          {game.status === "deploying" && isParticipant && !myDeploymentLocked && !manualTerrainPending && (
            <DeploymentAllocationHud
              units={currentStagedUnits}
              scenarioPriority={scenarioPriority}
              allocationPoints={allocationPoints}
              legal={stagedAllocation.legal}
              remainingTicks={stagedAllocation.remainingTicks}
            />
          )}
          {game.status === "deploying" && isParticipant && !myDeploymentLocked && (
            <div
              className="pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2 border border-primary/50 bg-black/80 px-4 py-2 text-center font-mono text-sm font-bold uppercase tracking-[0.24em] text-primary shadow-lg shadow-black/60 backdrop-blur-sm"
              data-testid="hud-deployment-owner"
            >
              {deploymentBoardTitle}
            </div>
          )}
          {/* Status overlay */}
          <div className="absolute top-3 left-3 z-20 flex flex-col gap-1.5 pointer-events-none">
            <div
              className={`px-2 py-1 rounded text-xs font-mono tracking-widest uppercase border ${
                game.status === "active"
                  ? "bg-green-500/10 border-green-500/30 text-green-400"
                  : game.status === "pending"
                    ? "bg-amber-500/10 border-amber-500/30 text-amber-400"
                    : game.status === "deploying"
                      ? "bg-blue-500/10 border-blue-500/30 text-blue-400"
                      : "bg-muted/10 border-muted/30 text-muted-foreground"
              }`}
            >
              {game.status}{" "}
              {game.status === "active" && `— Round ${game.currentRound}`}
            </div>
            {isAdminObserver && (
              <div
                className="px-2 py-1 rounded text-xs font-mono tracking-widest uppercase border border-cyan-400/45 bg-cyan-400/10 text-cyan-200"
                data-testid="hud-admin-observer"
              >
                Observer Mode
              </div>
            )}
            {game.status === "active" && isMyActivation && !hasActiveUnit && (
              <div
                className="px-2 py-1 rounded text-xs font-mono tracking-widest uppercase border border-primary/40 bg-primary/10 text-primary animate-pulse"
                data-testid="hud-pick-ship"
              >
                Pick a Ship
              </div>
            )}
            {game.status === "active" && isMyActivation && hasActiveUnit && (
              <div
                className={`px-2 py-1 rounded text-xs font-mono tracking-widest uppercase border ${
                  activationRequestPending
                    ? "border-amber-500/45 bg-amber-500/10 text-amber-200"
                    : "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
                }`}
                data-testid="hud-activating"
              >
                {activationRequestPending
                  ? "Requesting activation"
                  : "Activating"}{" "}
                ·{" "}
                {units.find((u) => u.id === activeUnitId)?.name ?? "—"}
              </div>
            )}
            {game.status === "active" &&
              isMyActivation &&
              activationFeedback && (
                <div
                  className="max-w-[min(72vw,420px)] px-2 py-1 rounded text-xs font-mono border border-amber-500/40 bg-black/70 text-amber-200 normal-case tracking-normal"
                  data-testid="hud-activation-feedback"
                >
                  {activationFeedback}
                  <RuleHint message={activationFeedback} />
                </div>
              )}
            {game.status === "active" && !isMyActivation && (
              <div
                className="px-2 py-1 rounded text-xs font-mono tracking-widest uppercase border border-muted/40 bg-muted/10 text-muted-foreground"
                data-testid="hud-waiting"
              >
                Waiting · Opponent {hasActiveUnit ? "activating" : "to pick"}
              </div>
            )}
            {game.winnerId && (
              <div className="px-2 py-1 rounded text-xs font-mono tracking-widest uppercase border border-yellow-500/40 bg-yellow-500/10 text-yellow-400">
                {game.winnerId === myUserId ? "Victory" : "Defeated"}
              </div>
            )}
          </div>
          {/* Camera / key hints */}
          <div className="absolute bottom-3 left-3 flex flex-col items-start gap-1 pointer-events-none">
            <div className="text-xs text-gray-500 font-mono">
              {isTouchInput
                ? movementGesture
                  ? "Drag ship preview · Release to stage · Confirm to commit"
                  : uiControlMode === "mode-b"
                    ? "Left side orbit - Right side pan - Pinch to zoom - Controller moves ships"
                    : uiControlMode === "mode-c"
                      ? "Drag to pan - Pinch to zoom - Two-finger drag to pan - Controller moves ships"
                      : uiControlMode === "mode-d"
                        ? "Drag to pan - Long-press then drag to orbit - Pinch to zoom - Controller moves ships"
                        : uiControlMode === "mode-e"
                          ? "Drag to pan - Pinch to zoom - Two-finger drag to orbit - Controller moves ships"
                          : uiControlMode === "mode-f"
                            ? "Top-down - Drag to pan - Pinch to zoom - Orbit locked - Controller moves ships"
                            : touchGameControls
                              ? "Drag to orbit · Pinch to zoom · Two-finger drag to pan · Controller moves ships"
                              : "Drag to orbit · Pinch to zoom · Two-finger drag to pan"
                : "WASD to pan · hold F/R forward ±0.5\" · Q/E turn · Enter/Space confirm · Scroll to zoom · Right-drag orbit"}
            </div>
            {game.status === "deploying" && (
              <div className="text-[10px] text-gray-600 font-mono">
                {selectedStagedId
                  ? "L — lock/unlock · Del — remove · Esc — deselect"
                  : "Click a placed ship to select it"}
              </div>
            )}
          </div>
        </div>

        {mobileGameChrome && (
          <>
            {!opsPanelOpen && (
              <button
                type="button"
                aria-label="Open operations panel"
                aria-expanded={opsPanelOpen}
                onClick={() => setOpsPanelOpen(true)}
                className="mobile-side-drawer-tab mobile-side-drawer-tab-right fixed right-0 top-24 z-50 flex h-12 w-9 items-center justify-center border border-r-0 border-border bg-card/95 text-primary shadow-lg"
                data-testid="button-mobile-ops-panel-open"
              >
                <PanelRightOpen className="h-4 w-4" />
              </button>
            )}
            {opsPanelOpen && (
              <button
                type="button"
                aria-label="Close operations panel overlay"
                className="fixed inset-0 z-30 bg-black/45 lg:hidden"
                onClick={() => setOpsPanelOpen(false)}
                data-testid="overlay-mobile-ops-panel"
              />
            )}
          </>
        )}

        {/* Sidebar panel */}
        <div
          className={`game-board-sidebar border-border bg-card flex flex-col transition-transform duration-200 ease-out ${
            mobileGameChrome
              ? `fixed inset-y-0 right-0 z-40 w-[min(88vw,22rem)] border-l shadow-2xl safe-top safe-bottom overflow-y-auto ${opsPanelOpen ? "translate-x-0" : "translate-x-full"}`
              : "w-full lg:w-72 lg:h-full lg:min-h-0 lg:overflow-y-auto border-t lg:border-t-0 lg:border-l"
          }`}
          data-state={opsPanelOpen ? "open" : "closed"}
          data-testid="game-operations-sidebar"
        >
          {mobileGameChrome && (
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-[10px] font-mono uppercase tracking-widest text-primary">
                Operations
              </span>
              <button
                type="button"
                aria-label="Close operations panel"
                onClick={() => setOpsPanelOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground"
                data-testid="button-mobile-ops-panel-close"
              >
                <PanelRightClose className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* ── DEPLOYED — WAITING FOR OPPONENT ── */}
          <AiDiagnosticsPanel
            game={game}
            onToggleAuto={() => {
              setAutoAiError(null);
              setAiAutoRunEnabled((enabled) => !enabled);
            }}
            isRunning={runAiStep.isPending}
            autoEnabled={aiAutoRunEnabled}
            readOnly={isAdminObserver}
          />

          {isAdminObserver && (
            <div
              className="border-b border-cyan-400/25 bg-cyan-400/10 px-4 py-3"
              data-testid="panel-admin-observer"
            >
              <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-cyan-200">
                Silent Observer
              </p>
              <p className="mt-1 text-[10px] font-mono leading-snug text-cyan-100/75">
                Read-only admin view. Game actions and chat sending are disabled.
              </p>
            </div>
          )}

          {mobileGameChrome && (
            <BattleLogPanel
              entries={battleLogEntries}
              collapsible
              defaultOpen={false}
            />
          )}

          {game.status === "deploying" && isParticipant && myDeploymentLocked && (
            <div
              className="p-4 border-b border-border space-y-2"
              data-testid="panel-awaiting-opponent"
            >
              <p className="text-xs font-mono text-green-400 uppercase tracking-widest flex items-center gap-1.5">
                <CheckCircle className="w-3.5 h-3.5" /> Fleet Deployed
              </p>
              <p className="text-xs font-mono text-muted-foreground">
                Standing by for{" "}
                {mySide === "challenger"
                  ? (game.opponentName ?? "opponent")
                  : (game.challengerName ?? "challenger")}{" "}
                to commit their fleet. The engagement will begin automatically.
              </p>
            </div>
          )}

          {/* ── FLEET YARDS (deploy phase, current player not yet deployed) ── */}
          {game.status === "deploying" && isParticipant && !myDeploymentLocked && !manualTerrainPending && (
            <div className="p-3 border-b border-border space-y-2 flex flex-col">
              <p className="text-xs font-mono text-primary uppercase tracking-widest">
                Fleet Yards
              </p>
              {!aiDeploymentControlActive &&
                ((mySide === "challenger" && game.opponentDeployed) ||
                  (mySide === "opponent" && game.challengerDeployed)) && (
                  <p
                    className="text-[10px] font-mono text-green-400/80"
                    data-testid="text-opponent-ready"
                  >
                    ⚡ Opponent has deployed — they're waiting on you.
                  </p>
                )}
              <p
                className="text-[10px] font-mono text-muted-foreground leading-snug"
                data-testid="text-deploy-hint"
              >
                {aiDeploymentControlActive
                  ? "Place the AI fleet on the opponent edge, then commit deployment to begin the engagement."
                  : "Drag ships from the roster below straight onto the board, or quick-load one of your saved fleets."}
                {fleets && fleets.length === 0 && (
                  <>
                    {" "}
                    No fleets yet?{" "}
                    <Link
                      to="/fleets"
                      data-testid="link-build-fleet"
                      className="text-primary hover:underline"
                    >
                      Build one →
                    </Link>
                  </>
                )}
              </p>

              {/* Fleet selector */}
              {TEST_FLEET_TEMPLATES.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-mono text-amber-400/90 uppercase tracking-wider">
                      Test Fleet Templates
                    </p>
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {priorityLabel(scenarioPriority)} {allocationPoints} FAP
                    </span>
                  </div>
                  <div className="space-y-1">
                    {TEST_FLEET_TEMPLATES.map((template) => {
                      const missingNames = template.ships
                        .filter(
                          (entry) =>
                            !(shipModels ?? []).some(
                              (ship) => ship.name === entry.modelName,
                            ),
                        )
                        .map((entry) => entry.modelName);
                      const scenarioFits =
                        scenarioPriority ===
                          normalizePriorityLevel(template.scenarioPriority) &&
                        allocationPoints >= template.allocationPoints;
                      const disabled = missingNames.length > 0 || !scenarioFits;
                      const composition = template.ships
                        .map(
                          (entry) =>
                            `${entry.count && entry.count > 1 ? `${entry.count}x ` : ""}${entry.modelName}`,
                        )
                        .join(", ");

                      return (
                        <button
                          key={template.id}
                          type="button"
                          disabled={disabled}
                          onClick={() => applyFleetTemplate(template)}
                          title={
                            missingNames.length > 0
                              ? `Missing: ${missingNames.join(", ")}`
                              : composition
                          }
                          className="w-full rounded border border-border bg-background px-2 py-1.5 text-left transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-45"
                          data-testid={`button-template-${template.id}`}
                        >
                          <span className="block text-xs font-mono text-foreground truncate">
                            {template.name}
                          </span>
                          <span className="block text-[10px] font-mono text-muted-foreground truncate">
                            {composition}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <Select
                value={yardsFleetId || "__none__"}
                onValueChange={(val) => {
                  const next = val === "__none__" ? "" : val;
                  setYardsFleetId(next);
                  setStagedUnits((prev) =>
                    prev.filter((u) => u.ownerId !== myUserId),
                  );
                  setSelectedStagedId(null);
                  setTapPlacementShip(null);
                }}
              >
                <SelectTrigger
                  data-testid="select-yards-fleet"
                  className="bg-background text-xs h-8"
                >
                  <SelectValue
                    placeholder={
                      aiDeploymentControlActive
                        ? "Quick-load a saved fleet for the AI (optional)"
                        : "Quick-load one of your saved fleets (optional)"
                    }
                  />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="__none__">
                    — None (direct drop) —
                  </SelectItem>
                  {fleets?.map((f) => (
                    <SelectItem key={f.id} value={String(f.id)}>
                      {f.name} ({f.shipCount} ships)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={selectedFaction}
                onValueChange={setSelectedFaction}
              >
                <SelectTrigger className="bg-background text-xs h-8">
                  <SelectValue placeholder="All factions…" />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="__all__">All factions</SelectItem>
                  {factions.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="space-y-1 max-h-44 overflow-y-auto pr-0.5">
                {filteredModels.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-2">
                    No ships
                  </p>
                )}
                {filteredModels.map((ship) => (
                  <div
                    key={ship.id}
                    draggable={!manualTerrainPending}
                    role={isTouchInput ? "button" : undefined}
                    tabIndex={isTouchInput ? 0 : undefined}
                    data-testid={`ship-card-${ship.id}`}
                    onClick={() => {
                      if (manualTerrainPending) {
                        setActivationFeedback(
                          "Finish manual terrain placement before staging ships.",
                        );
                        return;
                      }
                      if (!isTouchInput) return;
                      setTapPlacementShip((prev) =>
                        prev?.id === ship.id ? null : ship,
                      );
                      setSelectedStagedId(null);
                      if (mobileGameChrome) setOpsPanelOpen(false);
                    }}
                    onDragStart={(e) => {
                      if (manualTerrainPending) {
                        e.preventDefault();
                        setActivationFeedback(
                          "Finish manual terrain placement before staging ships.",
                        );
                        return;
                      }
                      draggedShipRef.current = ship;
                      e.dataTransfer.effectAllowed = "copy";
                      e.dataTransfer.setData("text/plain", ship.name);
                    }}
                    onDragEnd={() => {
                      draggedShipRef.current = null;
                    }}
                    className={`flex items-center justify-between px-2 py-1.5 rounded border bg-background hover:border-primary/40 hover:bg-primary/5 select-none transition-colors ${
                      manualTerrainPending
                        ? "cursor-not-allowed opacity-50"
                        : "cursor-grab active:cursor-grabbing"
                    } ${
                      tapPlacementShip?.id === ship.id
                        ? "border-primary/80 bg-primary/10 text-primary"
                        : "border-border"
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-mono text-foreground truncate">
                        {ship.name}
                      </p>
                      <p className="text-[10px] text-muted-foreground font-mono">
                        {ship.faction}
                      </p>
                    </div>
                    <div className="flex gap-1.5 text-[10px] font-mono text-muted-foreground shrink-0 ml-2">
                      <span title="Hull">{ship.hullPoints}hp</span>
                      <span title="Speed">{ship.speed}"</span>
                      <span title="Priority" className="text-amber-500/80">
                        {priorityLabel(
                          normalizePriorityLevel(ship.priorityLevel),
                        )}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              {/* Staged unit list */}
              {currentStagedUnits.length > 0 && (
                <div className="space-y-0.5 pt-1 border-t border-border/50">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
                      {currentStagedUnits.length} placed -{" "}
                      {formatAllocationTicks(stagedAllocation.spentTicks)} /{" "}
                      {allocationPoints} FAP
                    </p>
                    <button
                      className="text-[10px] text-muted-foreground hover:text-destructive font-mono"
                      onClick={() => {
                        setStagedUnits((prev) =>
                          prev.filter((u) => u.ownerId !== myUserId),
                        );
                        setSelectedStagedId(null);
                        setTapPlacementShip(null);
                      }}
                    >
                      clear all
                    </button>
                  </div>
                  {!stagedAllocation.legal && (
                    <p className="text-[10px] font-mono text-red-400 leading-snug px-1 pb-1">
                      Fleet exceeds {priorityLabel(scenarioPriority)}{" "}
                      {allocationPoints} FAP by{" "}
                      {formatAllocationTicks(
                        Math.abs(stagedAllocation.remainingTicks),
                      )}
                      .
                    </p>
                  )}
                  {deploymentOverlapWarning && (
                    <p
                      className="text-[10px] font-mono text-red-400 leading-snug px-1 pb-1"
                      data-testid="text-deploy-overlap-warning"
                    >
                      {deploymentOverlapWarning}
                    </p>
                  )}
                  {currentStagedUnits.map((u) => {
                    const isExpanded = selectedStagedId === u.id;
                    const carrier = currentStagedUnits.find(
                      (candidate) => candidate.id === u.launchedFromStagedId,
                    );
                    const carriedFighters = u.carriedFighters ?? [];
                    const deployedFromCarrier = currentStagedUnits.filter(
                      (candidate) => candidate.launchedFromStagedId === u.id,
                    );
                    const fighterDeployLimit =
                      uiPrebattleFighterDeploymentLimit(u);
                    // CQ picker only appears in "custom" games. In "standard"
                    // games crew quality is fixed at 4 (Veteran) by the
                    // server, so we don't render the picker at all to keep
                    // the deploy UI uncluttered.
                    const showCQ =
                      isExpanded && game?.crewQualityMode === "custom";
                    return (
                      <div
                        key={u.id}
                        onClick={() => setSelectedStagedId(u.id)}
                        className={`rounded text-[10px] font-mono cursor-pointer transition-colors ${
                          isExpanded
                            ? "bg-primary/10 border border-primary/40 text-foreground"
                            : "bg-background border border-border text-muted-foreground hover:border-border/80"
                        }`}
                        data-testid={`staged-card-${u.id}`}
                      >
                        <div className="flex items-center gap-1.5 px-2 py-1">
                          <span className="flex-1 truncate">
                            {u.locked ? "🔒 " : ""}
                            {u.name}
                          </span>
                          {carrier && (
                            <span
                              className="text-[9px] text-cyan-300/80 shrink-0"
                              title={`Deployed from ${carrier.name}`}
                            >
                              carried
                            </span>
                          )}
                          {u.deploymentGroupSize &&
                            u.deploymentGroupSize > 1 && (
                              <span
                                className="text-[9px] text-amber-300/80 shrink-0"
                                title="Multi-unit purchase"
                              >
                                group {u.deploymentGroupOrdinal}/
                                {u.deploymentGroupSize}
                              </span>
                            )}
                          {game?.crewQualityMode === "custom" && (
                            <span
                              className="text-[9px] text-amber-400/80 shrink-0"
                              title="Crew Quality"
                            >
                              CQ{u.crewQuality}
                            </span>
                          )}
                          {!u.locked && isExpanded && (
                            <button
                              className="text-muted-foreground hover:text-destructive ml-1"
                              data-testid={`staged-remove-${u.id}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                const deploymentGroupId =
                                  u.deploymentGroupId?.trim() || null;
                                setStagedUnits((prev) =>
                                  prev.filter(
                                    (s) =>
                                      (deploymentGroupId
                                        ? s.deploymentGroupId?.trim() !==
                                          deploymentGroupId
                                        : true) &&
                                      s.id !== u.id &&
                                      s.launchedFromStagedId !== u.id,
                                  ),
                                );
                                setSelectedStagedId(null);
                              }}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                        {showCQ && (
                          <div className="px-2 pb-1.5 pt-0.5 border-t border-primary/20">
                            <p className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">
                              Crew Quality —{" "}
                              {CREW_QUALITY_LABELS[u.crewQuality]}
                            </p>
                            <div className="grid grid-cols-6 gap-1">
                              {[1, 2, 3, 4, 5, 6, 7].map((cq) => (
                                <button
                                  key={cq}
                                  data-testid={`staged-cq-${u.id}-${cq}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setStagedUnits((prev) =>
                                      prev.map((s) =>
                                        s.id === u.id
                                          ? { ...s, crewQuality: cq }
                                          : s,
                                      ),
                                    );
                                  }}
                                  title={CREW_QUALITY_LABELS[cq]}
                                  className={`h-6 rounded border text-[10px] font-bold transition-colors ${
                                    u.crewQuality === cq
                                      ? "border-amber-400 bg-amber-400/20 text-amber-300"
                                      : "border-border bg-background text-muted-foreground hover:border-amber-400/40 hover:text-foreground"
                                  }`}
                                >
                                  {cq}
                                </button>
                              ))}
                            </div>
                            <p className="text-[9px] text-muted-foreground/70 mt-1 text-center">
                              1 Rookie · 2 Green · 3 Comp · 4 Vet · 5 Elite · 6
                              Spec Ops
                            </p>
                          </div>
                        )}
                        {isExpanded && carriedFighters.length > 0 && (
                          <div className="px-2 pb-1.5 pt-0.5 border-t border-primary/20 space-y-1">
                            <div className="flex items-center justify-between gap-2 text-[9px] uppercase tracking-wider text-muted-foreground">
                              <span>Carried Fighters</span>
                              <span>
                                {deployedFromCarrier.length}/
                                {fighterDeployLimit} setup
                              </span>
                            </div>
                            <div className="space-y-1">
                              {carriedFighters.map((item) => {
                                const deployedThisModel =
                                  deployedFromCarrier.filter(
                                    (unit) =>
                                      unit.shipModelId === item.shipModelId,
                                  ).length;
                                const disabled =
                                  !item.shipModelId ||
                                  deployedThisModel >= item.total ||
                                  deployedFromCarrier.length >=
                                    fighterDeployLimit;
                                return (
                                  <button
                                    key={`${u.id}-${item.name}-${item.shipModelId ?? "unlinked"}`}
                                    type="button"
                                    disabled={disabled}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      stageCarrierFighter(u, item);
                                    }}
                                    className="w-full rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-left text-[10px] text-cyan-100 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="truncate">
                                        {item.name}
                                      </span>
                                      <span>
                                        {deployedThisModel}/{item.total}
                                      </span>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {/* Deploy — commit the staged fleet. No per-ship lock required;
                  hitting this is the "I'm ready" gesture. */}
              {deployFleet.error && (
                <p
                  data-testid="text-deploy-error"
                  className="text-[10px] font-mono text-red-400 leading-snug px-1"
                >
                  ⚠ {(deployFleet.error as Error).message}
                </p>
              )}
              <Button
                data-testid="button-confirm-deployment"
                className="w-full mt-2 uppercase tracking-widest text-xs gap-2"
                disabled={
                  currentStagedUnits.length === 0 ||
                  !stagedAllocation.legal ||
                  Boolean(deploymentOverlapWarning) ||
                  deployFleet.isPending
                }
                onClick={handleYardsDeploy}
              >
                <Swords className="w-3.5 h-3.5" />
                {deployFleet.isPending
                  ? "Deploying…"
                  : currentStagedUnits.length === 0
                    ? "Drag ships onto the board"
                    : `Commit & Engage (${currentStagedUnits.length} ship${currentStagedUnits.length === 1 ? "" : "s"})`}
              </Button>
              <p className="text-[9px] text-muted-foreground font-mono text-center -mt-1 leading-snug">
                Locking a ship (<kbd>L</kbd>) is optional — it just freezes
                position. Hit{" "}
                <span className="text-primary">Commit &amp; Engage</span> when
                ready; the battle starts once both commanders commit.
              </p>
            </div>
          )}

          {/* Targeted pending challenge — opponent can accept or decline. */}
          {game.status === "pending" && isOpponent && (
            <div className="p-4 border-b border-border space-y-2">
              <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
                Challenge from {game.challengerName}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  data-testid="button-accept-game"
                  className="flex-1 gap-1.5 uppercase tracking-wider text-xs"
                  onClick={() =>
                    acceptGame.mutate(
                      { gameId },
                      {
                        onSuccess: () =>
                          qc.invalidateQueries({
                            queryKey: getGetGameQueryKey(gameId),
                          }),
                      },
                    )
                  }
                  disabled={acceptGame.isPending}
                >
                  <CheckCircle className="w-3.5 h-3.5" /> Accept
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  data-testid="button-decline-game"
                  className="flex-1 gap-1.5 uppercase tracking-wider text-xs"
                  onClick={() =>
                    declineGame.mutate(
                      { gameId },
                      {
                        onSuccess: () =>
                          qc.invalidateQueries({
                            queryKey: getGetGameQueryKey(gameId),
                          }),
                      },
                    )
                  }
                  disabled={declineGame.isPending}
                >
                  <XCircle className="w-3.5 h-3.5" /> Decline
                </Button>
              </div>
            </div>
          )}

          {/* Open challenge — any non-challenger can claim it; challenger can withdraw it. */}
          {game.status === "open" && !isChallenger && !isAdminObserver && (
            <div className="p-4 border-b border-border space-y-2">
              <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
                {game.visibility === "private"
                  ? "Private engagement"
                  : "Open challenge"}{" "}
                from {game.challengerName}
              </p>
              {game.hasPassword && (
                <Input
                  data-testid="input-accept-password"
                  type="password"
                  autoComplete="off"
                  placeholder="Engagement password"
                  value={joinPassword}
                  onChange={(e) => setJoinPassword(e.target.value)}
                  className="bg-background h-8 text-xs"
                />
              )}
              <Button
                size="sm"
                data-testid="button-accept-open-game"
                className="w-full gap-1.5 uppercase tracking-wider text-xs"
                onClick={() =>
                  acceptGame.mutate(
                    {
                      gameId,
                      data: game.hasPassword ? { password: joinPassword } : {},
                    },
                    {
                      onSuccess: () =>
                        qc.invalidateQueries({
                          queryKey: getGetGameQueryKey(gameId),
                        }),
                    },
                  )
                }
                disabled={
                  acceptGame.isPending ||
                  (game.hasPassword && joinPassword.length === 0)
                }
              >
                <CheckCircle className="w-3.5 h-3.5" /> Accept{" "}
                {game.visibility === "private"
                  ? "Private Engagement"
                  : "Open Challenge"}
              </Button>
              {acceptGame.isError && (
                <p
                  className="text-[11px] text-red-400 font-mono"
                  data-testid="text-accept-error"
                >
                  {(acceptGame.error as Error).message}
                </p>
              )}
            </div>
          )}
          {game.status === "open" && isChallenger && (
            <div className="p-4 border-b border-border space-y-2">
              <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
                Open challenge — awaiting a commander to accept
              </p>
            </div>
          )}

          {canAbandonPreStart && (
            <div className="p-4 border-b border-red-500/30 bg-red-950/15 space-y-2">
              <p className="text-[11px] text-red-300/90 font-mono uppercase tracking-wider">
                Leave before the engagement starts
              </p>
              <Button
                size="sm"
                variant="destructive"
                data-testid="button-abandon-game"
                className="w-full gap-1.5 uppercase tracking-wider text-xs"
                onClick={() => setConfirmingAbandon(true)}
                disabled={abandonGame.isPending}
              >
                <XCircle className="w-3.5 h-3.5" />
                {abandonGame.isPending ? "Abandoning..." : "Abandon Game"}
              </Button>
              {abandonGame.isError && (
                <p className="text-[11px] text-red-400 font-mono">
                  {(abandonGame.error as Error).message}
                </p>
              )}
            </div>
          )}

          {/* Concede. Available only after both sides deploy and the match is active.
              Completing a still-deploying setup room is too easy to do
              accidentally and can strand players before fleets exist. */}
          {game.status === "active" && (isChallenger || isOpponent) && (
            <div
              className="p-4 border-b border-border space-y-2"
              data-testid="concede-panel"
            >
                {confirmingConcede ? (
                  <>
                    <p className="text-[11px] text-amber-300/90 font-mono uppercase tracking-wider">
                      Concede this engagement to your opponent? This cannot be
                      undone.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        data-testid="button-confirm-concede"
                        className="flex-1 gap-1.5 uppercase tracking-wider text-xs"
                        onClick={() =>
                          concedeGame.mutate(
                            { gameId },
                            {
                              onSuccess: () => {
                                qc.invalidateQueries({
                                  queryKey: getGetGameQueryKey(gameId),
                                });
                                qc.invalidateQueries({
                                  queryKey: ["getLobby"],
                                });
                                qc.invalidateQueries({
                                  queryKey: ["listGames"],
                                });
                                setLocation("/lobby");
                              },
                            },
                          )
                        }
                        disabled={concedeGame.isPending}
                      >
                        <Flag className="w-3.5 h-3.5" />
                        {concedeGame.isPending
                          ? "Conceding…"
                          : "Confirm Concede"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid="button-cancel-concede"
                        className="gap-1.5 uppercase tracking-wider text-xs"
                        onClick={() => setConfirmingConcede(false)}
                        disabled={concedeGame.isPending}
                      >
                        Cancel
                      </Button>
                    </div>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="button-concede"
                    className="w-full gap-1.5 uppercase tracking-wider text-xs border-amber-500/40 text-amber-300/90 hover:bg-amber-500/10"
                    onClick={() => setConfirmingConcede(true)}
                  >
                    <Flag className="w-3.5 h-3.5" /> Concede Engagement
                  </Button>
                )}
                {concedeGame.isError && (
                  <p
                    className="text-[11px] text-red-400 font-mono"
                    data-testid="text-concede-error"
                  >
                    {(concedeGame.error as Error).message}
                  </p>
                )}
              </div>
            )}

          {/* Surrender. Appears only when every one of MY ships is at 0 hp,
              0 crew, or both — i.e. there's no realistic recovery left.
              Per product spec, surrender ends AND deletes the game (server
              cascade-deletes units/turns/crits), so we redirect to /lobby on
              success. The "Are you sure?" inline confirm prevents misclicks
              from nuking a still-recoverable engagement. */}
          {game.status === "active" &&
            (isChallenger || isOpponent) &&
            allMyShipsCombatInert && (
              <div
                className="p-4 border-b border-border space-y-2"
                data-testid="surrender-panel"
              >
                <p className="text-xs text-red-400/90 font-mono uppercase tracking-wider">
                  All ships disabled — no combat-effective units remain
                </p>
                {confirmingSurrender ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      data-testid="button-confirm-surrender"
                      className="flex-1 gap-1.5 uppercase tracking-wider text-xs"
                      onClick={() =>
                        surrenderGame.mutate(
                          { gameId },
                          {
                            onSuccess: () => {
                              qc.invalidateQueries({ queryKey: ["getLobby"] });
                              qc.invalidateQueries({ queryKey: ["listGames"] });
                              setLocation("/lobby");
                            },
                          },
                        )
                      }
                      disabled={surrenderGame.isPending}
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      {surrenderGame.isPending
                        ? "Surrendering…"
                        : "Confirm Surrender"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="button-cancel-surrender"
                      className="gap-1.5 uppercase tracking-wider text-xs"
                      onClick={() => setConfirmingSurrender(false)}
                      disabled={surrenderGame.isPending}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="destructive"
                    data-testid="button-surrender"
                    className="w-full gap-1.5 uppercase tracking-wider text-xs"
                    onClick={() => setConfirmingSurrender(true)}
                  >
                    <XCircle className="w-3.5 h-3.5" /> Surrender Engagement
                  </Button>
                )}
                {surrenderGame.isError && (
                  <p
                    className="text-[11px] text-red-400 font-mono"
                    data-testid="text-surrender-error"
                  >
                    {(surrenderGame.error as Error).message}
                  </p>
                )}
              </div>
            )}

          {game.status === "active" &&
            bugRescueNotice &&
            bugRescueNotice.reporterPlayerId !== myUserId && (
              <div
                className="p-4 border-b border-red-500/30 bg-red-950/20 space-y-1.5"
                data-testid="bug-rescue-notice"
              >
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-300" />
                  <p className="text-xs font-mono uppercase tracking-wider text-red-200">
                    Step rescue used
                  </p>
                </div>
                <p className="text-[11px] font-mono leading-relaxed text-red-100/85">
                  {bugRescueNotice.reporterName ?? "Opponent"} reported a
                  blocker
                  {bugRescueNotice.activeUnitName
                    ? ` on ${bugRescueNotice.activeUnitName}`
                    : ""}
                  {bugRescueNotice.rescueApplied
                    ? " and forced the current step forward."
                    : "."}
                </p>
                {bugRescueNotice.message && (
                  <p className="text-[10px] font-mono leading-relaxed text-red-100/65">
                    {bugRescueNotice.message}
                  </p>
                )}
              </div>
            )}

          {/* Selected unit info */}
          {selectedUnitData && (
            <div
              data-testid="selected-unit-panel"
              className="p-4 border-b border-border"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                  Selected Unit
                </span>
                <button
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setSelectedUnit(null)}
                >
                  clear
                </button>
              </div>
              <div className="space-y-1">
                <p className="font-bold text-sm text-primary">
                  {selectedUnitData.name}
                </p>
                <p className="text-xs text-muted-foreground font-mono">
                  {selectedUnitData.faction}
                </p>
                <div className="flex gap-3 text-xs font-mono mt-1">
                  <span className="flex items-center gap-1">
                    <Shield className="w-3 h-3 text-green-400" />
                    {selectedUnitData.hullPoints}/
                    {selectedUnitData.maxHullPoints}
                  </span>
                  <span className="flex items-center gap-1">
                    <Zap className="w-3 h-3 text-amber-400" />
                    {selectedUnitData.weaponDamage} dmg
                  </span>
                  <span className="flex items-center gap-1">
                    <Crosshair className="w-3 h-3 text-blue-400" />r
                    {selectedUnitData.weaponRange}
                  </span>
                </div>
                {pcHoverHintsEnabled && selectedShipTraitList.length > 0 && (
                  <div
                    className="mt-1.5 flex flex-wrap gap-1"
                    data-testid="selected-unit-traits"
                  >
                    {selectedShipTraitList.map((trait) => (
                      <TraitTooltip
                        key={`${selectedUnitData.id}-${trait}`}
                        trait={trait}
                      >
                        <span className="cursor-help rounded border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[9px] text-cyan-200">
                          {trait}
                        </span>
                      </TraitTooltip>
                    ))}
                  </div>
                )}
                {/* Slice C: crew + damage-state badges. Crippled/Skeleton are
                    server-derived; damageState exposes adrift / delayed-boom. */}
                <div className="flex gap-1.5 text-[10px] font-mono mt-1 flex-wrap">
                  {(selectedUnitData.maxCrewPoints ?? 0) > 0 && (
                    <span
                      data-testid="badge-crew"
                      className={`px-1.5 py-0.5 rounded border ${
                        selectedUnitData.isSkeletonCrew
                          ? "border-red-500/60 text-red-300 bg-red-500/10"
                          : "border-border text-muted-foreground"
                      }`}
                      title="Crew"
                    >
                      CREW {selectedUnitData.crewPoints}/
                      {selectedUnitData.maxCrewPoints}
                    </span>
                  )}
                  {selectedUnitData.isCrippled &&
                    !isFighterUnit(selectedUnitData) && (
                      <span
                        data-testid="badge-crippled"
                        className="px-1.5 py-0.5 rounded border border-red-500/60 text-red-300 bg-red-500/10 uppercase tracking-wider"
                      >
                        Crippled
                      </span>
                    )}
                  {selectedUnitData.isSkeletonCrew && (
                    <span
                      data-testid="badge-skeleton"
                      className="px-1.5 py-0.5 rounded border border-orange-500/60 text-orange-300 bg-orange-500/10 uppercase tracking-wider"
                    >
                      Skeleton
                    </span>
                  )}
                  {!unitIsCombatEffective(selectedUnitData) && (
                    <span
                      data-testid="badge-hulked"
                      className="px-1.5 py-0.5 rounded border border-slate-400/70 text-slate-200 bg-slate-500/15 uppercase tracking-wider"
                    >
                      {selectedUnitData.hullPoints <= 0
                        ? "Hulked"
                        : "Derelict"}
                    </span>
                  )}
                  {selectedUnitData.damageState === "adrift" && (
                    <span
                      data-testid="badge-adrift"
                      className="px-1.5 py-0.5 rounded border border-yellow-500/60 text-yellow-300 bg-yellow-500/10 uppercase tracking-wider"
                    >
                      Adrift
                    </span>
                  )}
                  {selectedUnitData.damageState === "exploding-end-of-next" && (
                    <span
                      data-testid="badge-exploding"
                      className="px-1.5 py-0.5 rounded border border-red-500/80 text-red-200 bg-red-500/20 uppercase tracking-wider animate-pulse"
                    >
                      Detonating
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Hex: {selectedUnitData.hexQ},{selectedUnitData.hexR}
                </p>
                {selectedMovementBlockedNotice && (
                  <div
                    className="mt-2 rounded border border-amber-500/45 bg-amber-500/10 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-amber-200"
                    data-testid="selected-movement-blocked-reason"
                  >
                    {selectedMovementBlockedNotice}
                  </div>
                )}
                {selectedUnitData.ownerId === myUserId &&
                  !selectedUnitData.isDestroyed && (
                    <div className="mt-3 space-y-2">
                      {(selectedUnitData.carriedFighters ?? []).length > 0 && (
                        <div className="rounded border border-border/70 bg-black/20 p-2 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-mono uppercase tracking-widest text-primary">
                              Fighter Bay
                            </span>
                            <span className="text-[9px] font-mono text-muted-foreground">
                              {isMyEndPhaseWindow ? "End Phase" : "Standby"}
                            </span>
                          </div>
                          <div className="space-y-1.5">
                            {selectedUnitData.carriedFighters.map((item) => {
                              const key = `launch:${selectedUnitData.id}:${item.shipModelId ?? item.name}`;
                              const carrierCanLaunch =
                                canLaunchFightersFromCarrier(selectedUnitData);
                              const disabled =
                                !carrierCanLaunch ||
                                fighterBayBusyKey !== null ||
                                item.available <= 0 ||
                                !item.shipModelId;
                              return (
                                <div
                                  key={`${item.name}-${item.shipModelId ?? "unlinked"}`}
                                  className="flex items-center justify-between gap-2 rounded bg-muted/20 px-2 py-1"
                                >
                                  <div className="min-w-0">
                                    <div className="truncate text-[11px] font-mono text-foreground">
                                      {item.name}
                                    </div>
                                    <div className="text-[9px] font-mono text-muted-foreground">
                                      {item.available}/{item.total} bay ·{" "}
                                      {item.launched} out
                                    </div>
                                  </div>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="h-7 shrink-0 px-2 text-[10px] uppercase tracking-widest"
                                    disabled={disabled}
                                    onClick={() =>
                                      beginFighterLaunchPlacement(selectedUnitData, item)
                                    }
                                  >
                                    {fighterBayBusyKey === key
                                      ? "..."
                                      : "Place"}
                                  </Button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {selectedRecoveryCarriers.length > 0 && (
                        <div className="rounded border border-border/70 bg-black/20 p-2 space-y-2">
                          <span className="text-[10px] font-mono uppercase tracking-widest text-primary">
                            Recovery
                          </span>
                          {selectedRecoveryCarriers.map((carrier) => {
                            const key = `recover:${selectedUnitData.id}:${carrier.id}`;
                            return (
                              <Button
                                key={carrier.id}
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7 w-full justify-between px-2 text-[10px] uppercase tracking-widest"
                                disabled={
                                  !isMyEndPhaseWindow ||
                                  fighterBayBusyKey !== null ||
                                  !!carrier.specialAction
                                }
                                onClick={() =>
                                  void recoverFighterToCarrier(
                                    selectedUnitData,
                                    carrier,
                                  )
                                }
                              >
                                <span className="truncate">
                                  Recover to {carrier.name}
                                </span>
                                <span>
                                  {fighterBayBusyKey === key ? "..." : "Dock"}
                                </span>
                              </Button>
                            );
                          })}
                        </div>
                      )}
                      {fighterBayFeedback && (
                        <div className="text-[10px] font-mono text-muted-foreground">
                          {fighterBayFeedback}
                          <RuleHint message={fighterBayFeedback} />
                        </div>
                      )}
                    </div>
                  )}
              </div>
            </div>
          )}

          {/* ── INITIATIVE PHASE PANEL ───────────────────────────────────────
              Both participants see this whenever phase === initiative. The
              roll button is enabled only for the local player and only until
              they've submitted their 2d6 this round. */}
          {game.status === "active" &&
            currentPhase === "initiative" &&
            (myUserId === game.challengerId ||
              myUserId === game.opponentId) && (
              <div
                className="p-4 border-b border-border space-y-3"
                data-testid="initiative-panel"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-xs font-mono text-primary uppercase tracking-wider">
                    Round {game.currentRound}
                  </p>
                  <Badge
                    variant="outline"
                    className="text-[10px] font-mono uppercase tracking-widest border-purple-500/60 text-purple-300 bg-purple-500/10"
                  >
                    Initiative
                  </Badge>
                </div>
                <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                  Both commanders roll 2d6. High roll wins initiative (ties
                  re-roll). The winner then chooses who activates first this
                  round.
                </p>
                {(() => {
                  const isChallenger = myUserId === game.challengerId;
                  const myRoll = isChallenger
                    ? game.initiativeChallengerRoll
                    : game.initiativeOpponentRoll;
                  const oppRoll = isChallenger
                    ? game.initiativeOpponentRoll
                    : game.initiativeChallengerRoll;
                  const haveRolled = myRoll !== null && myRoll !== undefined;
                  const oppRolled = oppRoll !== null && oppRoll !== undefined;
                  const bothRolled = haveRolled && oppRolled;
                  const winnerKnown = bothRolled && !!game.initiativeWinnerId;
                  const iWon =
                    winnerKnown && game.initiativeWinnerId === myUserId;
                  const oppName = isChallenger
                    ? game.opponentName
                    : game.challengerName;
                  const aiDiagnostics = readAiDiagnostics(game.aiState);
                  const initiativeTieMessage =
                    !haveRolled &&
                    !oppRolled &&
                    aiDiagnostics.lastStep === "initiative.tie" &&
                    aiDiagnostics.lastInitiativeTieRound === game.currentRound
                      ? (aiDiagnostics.message ??
                        "Initiative tied; re-roll initiative.")
                      : null;
                  return (
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-2 text-center">
                        <div
                          className={`rounded border px-2 py-1.5 ${winnerKnown && iWon ? "border-green-500/60 bg-green-500/10" : "border-purple-500/40 bg-purple-500/5"}`}
                        >
                          <div className="text-[9px] uppercase tracking-wider text-purple-300/70 font-mono">
                            You
                          </div>
                          <div
                            className={`text-lg font-bold font-mono ${winnerKnown && iWon ? "text-green-300" : "text-purple-200"}`}
                            data-testid="text-my-init-roll"
                          >
                            {haveRolled ? myRoll : "—"}
                          </div>
                        </div>
                        <div
                          className={`rounded border px-2 py-1.5 ${winnerKnown && !iWon ? "border-green-500/60 bg-green-500/10" : "border-muted/40 bg-muted/5"}`}
                        >
                          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-mono">
                            {oppName ?? "Opponent"}
                          </div>
                          <div
                            className={`text-lg font-bold font-mono ${winnerKnown && !iWon ? "text-green-300" : "text-muted-foreground"}`}
                            data-testid="text-opp-init-roll"
                          >
                            {oppRolled ? oppRoll : "—"}
                          </div>
                        </div>
                      </div>

                      {/* Outcome banner — only visible after both rolls are in.
                        Tied rolls are auto-cleared server-side so we never
                        land here with cRoll === oRoll. */}
                      {winnerKnown && (
                        <div
                          className={`rounded border px-2 py-1.5 text-center font-mono text-[11px] uppercase tracking-widest ${
                            iWon
                              ? "border-green-500/60 bg-green-500/10 text-green-300"
                              : "border-amber-500/60 bg-amber-500/10 text-amber-300"
                          }`}
                          data-testid="text-initiative-outcome"
                        >
                          {iWon
                            ? "✓ You won initiative"
                            : `✗ ${oppName ?? "Opponent"} won initiative`}
                        </div>
                      )}

                      {initiativeTieMessage && (
                        <div
                          className="rounded border border-amber-500/60 bg-amber-500/10 px-2 py-1.5 text-center font-mono text-[11px] uppercase tracking-widest text-amber-300"
                          data-testid="text-initiative-tie"
                        >
                          {initiativeTieMessage}
                        </div>
                      )}

                      {/* Pre-roll / waiting-for-opponent: Roll button. */}
                      {!winnerKnown && (
                        <Button
                          size="sm"
                          data-testid="button-roll-initiative"
                          className="w-full gap-1.5 uppercase tracking-widest text-xs font-bold"
                          disabled={haveRolled || rollInitiative.isPending}
                          onClick={() => {
                            rollInitiative.mutate(
                              { gameId },
                              {
                                onSuccess: mergeGameIntoCache,
                                onSettled: () =>
                                  qc.invalidateQueries({
                                    queryKey: getGetGameQueryKey(gameId),
                                  }),
                              },
                            );
                          }}
                        >
                          {rollInitiative.isPending
                            ? "Rolling…"
                            : haveRolled
                              ? "Waiting for opponent…"
                              : "Roll 2d6"}
                        </Button>
                      )}

                      {/* Winner picks who moves first. Loser waits. */}
                      {winnerKnown && iWon && (
                        <div className="space-y-1.5">
                          <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider text-center">
                            Choose who activates first
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <Button
                              size="sm"
                              data-testid="button-first-activator-me"
                              variant="default"
                              className="uppercase tracking-widest text-[10px] font-bold"
                              disabled={chooseFirstActivator.isPending}
                              onClick={() => {
                                chooseFirstActivator.mutate(
                                  {
                                    gameId,
                                    data: { activatorUserId: myUserId! },
                                  },
                                  {
                                    onSettled: () =>
                                      qc.invalidateQueries({
                                        queryKey: getGetGameQueryKey(gameId),
                                      }),
                                  },
                                );
                              }}
                            >
                              We Move First
                            </Button>
                            <Button
                              size="sm"
                              data-testid="button-first-activator-opp"
                              variant="outline"
                              className="uppercase tracking-widest text-[10px] font-bold"
                              disabled={chooseFirstActivator.isPending}
                              onClick={() => {
                                const oppId = isChallenger
                                  ? game.opponentId
                                  : game.challengerId;
                                if (!oppId) return;
                                chooseFirstActivator.mutate(
                                  { gameId, data: { activatorUserId: oppId } },
                                  {
                                    onSettled: () =>
                                      qc.invalidateQueries({
                                        queryKey: getGetGameQueryKey(gameId),
                                      }),
                                  },
                                );
                              }}
                            >
                              Opponent First
                            </Button>
                          </div>
                        </div>
                      )}
                      {winnerKnown && !iWon && (
                        <div
                          className="text-[10px] font-mono text-muted-foreground text-center italic"
                          data-testid="text-awaiting-first-activator"
                        >
                          Waiting for {oppName ?? "opponent"} to choose who
                          moves first…
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

          {/* ── END PHASE PANEL ──────────────────────────────────────────────
              Both participants see this whenever phase === end. Pass button
              is enabled only for the current end-phase active player. Damage
              Control buttons live in the per-ship crit panel below; this
              block is the round-progression control. */}
          {game.status === "active" &&
            currentPhase === "end" &&
            (myUserId === game.challengerId ||
              myUserId === game.opponentId) && (
              <div
                className="p-4 border-b border-border space-y-3"
                data-testid="end-phase-panel"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-xs font-mono text-primary uppercase tracking-wider">
                    Round {game.currentRound}
                  </p>
                  <Badge
                    variant="outline"
                    className="text-[10px] font-mono uppercase tracking-widest border-amber-500/60 text-amber-300 bg-amber-500/10"
                  >
                    End Phase
                  </Badge>
                </div>
                {(() => {
                  const isChallenger = myUserId === game.challengerId;
                  const myPassed = isChallenger
                    ? game.endPhaseChallengerPassed
                    : game.endPhaseOpponentPassed;
                  const oppPassed = isChallenger
                    ? game.endPhaseOpponentPassed
                    : game.endPhaseChallengerPassed;
                  const myTurn = game.activePlayerId === myUserId;
                  return (
                    <>
                      <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                        Damage Control window — one repair attempt per ship.
                        Initiative winner repairs first.
                        {myTurn
                          ? " It's your repair window — DC eligible ships from the crit panel, then pass."
                          : myPassed
                            ? " You've passed. Waiting for opponent to finish."
                            : " Waiting for the other commander."}
                      </p>
                      <Button
                        size="sm"
                        data-testid="button-pass-end-phase"
                        className="w-full gap-1.5 uppercase tracking-widest text-xs font-bold"
                        disabled={!myTurn || myPassed || passEndPhase.isPending}
                        onClick={() => {
                          passEndPhase.mutate(
                            { gameId },
                            {
                              onSettled: () =>
                                qc.invalidateQueries({
                                  queryKey: getGetGameQueryKey(gameId),
                                }),
                            },
                          );
                        }}
                      >
                        {passEndPhase.isPending
                          ? "Passing…"
                          : myPassed
                            ? "Passed"
                            : !myTurn
                              ? `Waiting · Opponent ${oppPassed ? "passed" : "repairing"}`
                              : "Pass End Phase"}
                      </Button>
                    </>
                  );
                })()}
              </div>
            )}

          {/* Turn actions — hidden during End phase, which has no
              per-ship activations. End-phase commitment is handled by
              the dedicated "Pass End Phase" panel above; rendering this
              generic activation panel here would show a redundant
              "Pass Phase" button alongside it. */}
          {game.status === "active" &&
            isMyActivation &&
            currentPhase !== "end" && (
              <div className="p-4 border-b border-border space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-xs font-mono text-primary uppercase tracking-wider">
                    Round {game.currentRound}
                  </p>
                  <Badge
                    data-testid="badge-phase"
                    variant="outline"
                    className={`text-[10px] font-mono uppercase tracking-widest ${
                      currentPhase === "firing"
                        ? "border-red-500/60 text-red-300 bg-red-500/10"
                        : currentPhase === "initiative"
                          ? "border-purple-500/60 text-purple-300 bg-purple-500/10"
                          : "border-cyan-500/60 text-cyan-300 bg-cyan-500/10"
                    }`}
                  >
                    {currentPhase === "firing"
                      ? activationSegment === "fighter"
                        ? "Fighter Firing"
                        : activationSegment === "capital"
                          ? "Ship Firing"
                          : "Firing"
                      : currentPhase === "initiative"
                        ? "Initiative"
                        : "Movement"}
                  </Badge>
                </div>
                <p className="text-xs font-mono text-muted-foreground">
                  {hasActiveUnit
                    ? `Activating ${units.find((u) => u.id === activeUnitId)?.name ?? "—"}`
                    : canPassPhase
                      ? activationPassLabel
                      : activationPickLabel}
                </p>
                {currentPhase === "firing" && lastOpponentAttackSummary && (
                  <div
                    data-testid="panel-last-opponent-attack"
                    className="rounded border border-red-500/35 bg-red-950/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-red-100"
                  >
                    <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-red-300/80">
                      Opponent last attack
                    </div>
                    <div>{lastOpponentAttackSummary}</div>
                  </div>
                )}
                {currentPhase === "firing" &&
                  activeUnitReadyForActions &&
                  activeFighterLockedInDogfight && (
                    <Button
                      size="sm"
                      data-testid="button-dogfight"
                      className="w-full gap-1.5 border border-fuchsia-400/70 bg-fuchsia-500/20 font-mono text-xs font-bold uppercase tracking-widest text-fuchsia-100 hover:bg-fuchsia-500/30"
                      onClick={() => void resolveDogfight()}
                      disabled={
                        dogfightModal !== null ||
                        fireWeapon.isPending ||
                        passAllFiringPending
                      }
                      title={
                        activeDogfightEnemies.length > 1
                          ? "Pick which contacted enemy fighter to dogfight"
                          : "Resolve this fighter dogfight"
                      }
                    >
                      <Swords className="h-3.5 w-3.5" />
                      {dogfightTargetPicking
                        ? "Pick Dogfight Target"
                        : "Dogfight"}
                    </Button>
                  )}
                <Button
                  size="sm"
                  data-testid="button-end-activation"
                  className="w-full gap-1.5 uppercase tracking-widest text-xs font-bold"
                  onClick={handleRequestEndActivation}
                  disabled={
                    (!hasActiveUnit && !canPassPhase) ||
                    endActivation.isPending
                  }
                >
                  {endActivation.isPending
                    ? "Ending…"
                    : canPassPhase
                      ? "Pass Phase (N)"
                      : "End Activation (N)"}
                </Button>
                {currentPhase === "firing" && (
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="button-pass-all-firing"
                    className="w-full gap-1.5 uppercase tracking-widest text-xs font-bold"
                    onClick={handleRequestPassAllFiring}
                    disabled={
                      !canPassAllFiring ||
                      passAllFiringPending ||
                      antiFighterCommitting ||
                      diceModal !== null ||
                      dogfightModal !== null
                    }
                    title={
                      antiFighterState
                        ? "Resolve pending Anti-Fighter allocation first"
                        : activationSegment === "fighter"
                          ? "Skip every remaining fighter-flight firing activation for your fleet"
                          : "Skip every remaining capital-ship firing activation for your fleet"
                    }
                  >
                    {passAllFiringPending
                      ? passAllFiringPendingLabel
                      : passAllFiringLabel}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="button-open-bug-rescue"
                  className="w-full gap-1.5 uppercase tracking-widest text-xs font-bold border-red-500/35 text-red-200 hover:bg-red-500/10"
                  onClick={() => {
                    setBugReportError(null);
                    setBugReportBlocking(false);
                    setBugReportOpen(true);
                  }}
                  disabled={bugReportPending}
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Report Bug / Step Rescue
                </Button>
                {minMoveGate.blocked && (
                  <p
                    data-testid="text-min-move-gate"
                    className="text-[10px] font-mono uppercase tracking-wider text-amber-400/90"
                  >
                    Must move ≥ {formatInches(minMoveGate.required)}" or declare
                    All Stop (moved {formatInches(minMoveGate.moved)}")
                  </p>
                )}
                <div className="space-y-1 text-xs text-muted-foreground font-mono">
                  <p className="flex items-center gap-1">
                    <Move className="w-3 h-3" /> {turnMoves.length} moves queued
                  </p>
                  <p className="flex items-center gap-1">
                    <Target className="w-3 h-3" /> {turnAttacks.length} attacks
                    queued
                  </p>
                </div>
                {currentPhase === "movement" &&
                  selectedUnitData &&
                  selectedUnitData.ownerId === myUserId &&
                  !selectedUnitData.isDestroyed &&
                  (selectedUnitData.damageState === "adrift" ||
                    selectedUnitData.damageState ===
                      "exploding-end-of-next") && (
                    <div
                      className="space-y-1.5"
                      data-testid="adrift-end-phase-note"
                    >
                      <div className="text-[10px] uppercase tracking-wider text-yellow-400/90 font-mono flex items-center justify-between">
                        <span>Adrift</span>
                        <Badge
                          variant="outline"
                          className="text-[9px] font-mono border-yellow-500/60 text-yellow-300 bg-yellow-500/10"
                        >
                          End Phase drift
                        </Badge>
                      </div>
                      <div className="text-[10px] font-mono text-yellow-300/80 border border-yellow-500/40 bg-yellow-500/10 rounded px-2 py-1">
                        This ship has no movement activation. It will drift
                        automatically when both players pass the End Phase.
                      </div>
                    </div>
                  )}
                {selectedUnitData &&
                  selectedUnitData.ownerId === myUserId &&
                  !selectedUnitData.isDestroyed &&
                  currentPhase === "movement" &&
                  isSelectedUnitActive &&
                  !isAdriftActive &&
                  (() => {
                    if (isFighterUnit(selectedUnitData)) return null;
                    const modelForSA = getShipModelForUnit(selectedUnitData);
                    const traitsForSA = modelForSA?.traits ?? "";
                    const rulesProfile = uiRulesProfileForModel(modelForSA);
                    const isShadowProfile = rulesProfile === "shadows";
                    const isVorlonProfile = rulesProfile === "vorlons";
                    const hasShadowBeam = (modelForSA?.weapons ?? []).some(
                      (weapon) =>
                        /\bbeam\b/i.test(weapon.traits ?? "") &&
                        !/\bmini[-\s]?beam\b/i.test(weapon.traits ?? ""),
                    );
                    const isLumbering = /\blumbering\b/i.test(traitsForSA);
                    const psychicCrewForSA = parseUiPsychicCrew(traitsForSA);
                    const SPECIAL_ACTIONS: {
                      id:
                        | "all-power-engines"
                        | "all-stop"
                        | "all-stop-pivot"
                        | "come-about-extra-turn"
                        | "come-about-sharp-turn"
                        | "blast-doors"
                        | "intensify-defense"
                        | "run-silent"
                        | "concentrate-fire"
                        | "cause-confusion"
                        | "all-hands-on-deck"
                        | "scramble"
                        | "regenerate";
                      label: string;
                      cq: number | null;
                      hint: string;
                      hidden?: boolean;
                    }[] = [
                      {
                        id: "all-power-engines",
                        label: "All Power to Engines!",
                        cq: null,
                        hint: "Speed +50%; no turns",
                      },
                      {
                        id: "all-stop",
                        label: "All Stop!",
                        cq: null,
                        hint: "0..½ speed; no turns",
                      },
                      {
                        id: "all-stop-pivot",
                        label: "All Stop & Pivot!",
                        cq: null,
                        hint: "No move; 1 weapon; 2× turn rate",
                      },
                      // Come About splits into two mutually-exclusive variants.
                      // Lumbering ships cannot use the extra-turn variant
                      // (sheet rule: lumbering hulls only get the sharp-turn
                      // bonus).
                      {
                        id: "come-about-extra-turn",
                        label: "Come About — Extra Turn",
                        cq: 9,
                        hint: isLumbering
                          ? "Forbidden: Lumbering"
                          : "+1 turn this activation",
                        hidden: isLumbering,
                      },
                      {
                        id: "come-about-sharp-turn",
                        label: "Come About — Sharp Turn",
                        cq: 9,
                        hint: "+45° to one turn this activation",
                      },
                      {
                        id: "blast-doors",
                        label: "Close Blast Doors!",
                        cq: null,
                        hint: "1 weapon; 5+ saves vs damage",
                      },
                      {
                        id: "intensify-defense",
                        label: "Intensify Defensive Fire!",
                        cq: 8,
                        hint: "½ AD on all weapons",
                      },
                      {
                        id: "run-silent",
                        label: "Run Silent!",
                        cq: 8,
                        hint: "Stealth; no fire/turn; ≤½ speed",
                      },
                      {
                        id: "concentrate-fire",
                        label: "Concentrate All Fire!",
                        cq: 8,
                        hint: "Re-roll missed AD vs picked target",
                      },
                      {
                        id: "cause-confusion",
                        label: "Cause Confusion",
                        cq: null,
                        hint: "Opposed Psychic Crew vs CQ; clears target Special Action",
                        hidden:
                          psychicCrewForSA <= 0 ||
                          isFighterUnit(selectedUnitData),
                      },
                      {
                        id: "all-hands-on-deck",
                        label: "All Hands on Deck!",
                        cq: 9,
                        hint: "1 weapon this round; +2 DC & ∞ repairs in End Phase",
                      },
                      {
                        id: "scramble",
                        label: "Scramble! Scramble!",
                        cq: 7,
                        hint: "Launch +2 fighter flights in End Phase",
                      },
                      {
                        id: "regenerate",
                        label: "Regenerate!",
                        cq: 9,
                        hint: "Adrift; no attacks; double Self Repair",
                        hidden: !isVorlonProfile,
                      },
                    ];
                    const profileActionIds =
                      rulesProfile === "shadows"
                        ? new Set(["run-silent"])
                        : rulesProfile === "vorlons"
                          ? new Set([
                              "all-stop",
                              "all-stop-pivot",
                              "come-about-extra-turn",
                              "come-about-sharp-turn",
                              "run-silent",
                              "regenerate",
                            ])
                          : rulesProfile === "ancients"
                            ? new Set([
                                "all-stop",
                                "all-stop-pivot",
                                "come-about-extra-turn",
                                "come-about-sharp-turn",
                                "run-silent",
                              ])
                            : null;
                    const rawAction = selectedUnitData.specialAction ?? null;
                    const baseAction = rawAction
                      ? rawAction.replace(/-failed$/, "")
                      : null;
                    const actionFailed =
                      !!rawAction && rawAction.endsWith("-failed");
                    const actionLocked = !!rawAction;
                    const activeLabel = baseAction
                      ? (SPECIAL_ACTIONS.find((a) => a.id === baseAction)
                          ?.label ?? baseAction)
                      : null;
                    const panelLed = getLedger(selectedUnitData.id);
                    const movedAlready =
                      panelLed.distance > 0 || panelLed.turns > 0;
                    // Pre-compute the server's noSA gates so the buttons can be
                    // disabled with an explanatory banner instead of letting the
                    // user click and eat a 400. Keep keys in sync with
                    // artifacts/api-server/src/lib/critical-table.ts and the
                    // skeleton-crew / adrift rules in /special-action.
                    const NO_SA_CRIT_KEYS = new Set([
                      "reactor-gas-leak",
                      "reactor-explosion",
                      "crew-decompression",
                      "vital-bridge",
                    ]);
                    const noSACrit = (selectedUnitData.criticals ?? []).find(
                      (c) => NO_SA_CRIT_KEYS.has(c.effectKey),
                    );
                    const isAdrift = selectedUnitData.damageState === "adrift";
                    const maxCrewSA = selectedUnitData.maxCrewPoints ?? 0;
                    const crewSA = selectedUnitData.crewPoints ?? 0;
                    const isSkeletonSA =
                      maxCrewSA > 0 && crewSA * 2 <= maxCrewSA;
                    const noSAReason = noSACrit
                      ? `Cannot declare — ${noSACrit.name} active`
                      : isAdrift
                        ? "Cannot declare — ship is adrift"
                        : isSkeletonSA
                          ? "Cannot declare — skeleton crew"
                          : null;
                    const scoutActionLocked = !!selectedUnitData.scoutAction;
                    const selectedHasScoutTrait = /\bscout\b/i.test(
                      getShipModelForUnit(selectedUnitData)?.traits ?? "",
                    );
                    return (
                      <>
                        {isShadowProfile && (
                          <div
                            className="space-y-1.5 border border-violet-400/35 bg-violet-500/5 p-2"
                            data-testid="shadow-systems-panel"
                          >
                            <div className="flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-wider text-violet-200">
                              <span>Shadow Systems</span>
                              <span className="text-[8px] text-violet-200/65">
                                No CQ check · no Special Action
                              </span>
                            </div>
                            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                              {hasShadowBeam && (
                                <button
                                  type="button"
                                  aria-pressed={
                                    selectedUnitData.shadowPointDefenseRound ===
                                    (game.currentRound ?? 0)
                                  }
                                  disabled={
                                    movedAlready ||
                                    chooseShadowPointDefense.isPending
                                  }
                                  onClick={() => {
                                    chooseShadowPointDefense.mutate(
                                      {
                                        gameId,
                                        unitId: selectedUnitData.id,
                                      },
                                      {
                                        onSuccess: (unit) => {
                                          mergeUpdatedUnitIntoGame(unit);
                                          qc.invalidateQueries({
                                            queryKey:
                                              getGetGameQueryKey(gameId),
                                          });
                                        },
                                        onError: (err) =>
                                          setActivationFeedback(
                                            cleanApiErrorMessage(
                                              err,
                                              "Slicer point-defence selection failed",
                                            ),
                                          ),
                                      },
                                    );
                                  }}
                                  className="border border-violet-300/45 bg-violet-400/10 px-2 py-1 text-left font-mono text-[10px] text-violet-100 disabled:opacity-35"
                                  data-testid="shadow-system-slicer-point-defence"
                                >
                                  <span className="block font-bold">
                                    Slicer Point-Defence Mode
                                  </span>
                                  <span className="block text-[8px] opacity-70">
                                    {selectedUnitData.shadowPointDefenseRound ===
                                    (game.currentRound ?? 0)
                                      ? "Active this round · half Range · Turret · Accurate Mini-Beam"
                                      : "Select before movement · converts Molecular Slicer fire"}
                                  </span>
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={
                                  movedAlready ||
                                  chooseShadowManeuverMode.isPending
                                }
                                onClick={() => {
                                  const mode =
                                    selectedUnitData.shadowManeuverMode ===
                                    "sweep"
                                      ? "normal"
                                      : "sweep";
                                  chooseShadowManeuverMode.mutate(
                                    {
                                      gameId,
                                      unitId: selectedUnitData.id,
                                      data: { mode },
                                    },
                                    {
                                      onSuccess: (unit) => {
                                        mergeUpdatedUnitIntoGame(unit);
                                        qc.invalidateQueries({
                                          queryKey:
                                            getGetGameQueryKey(gameId),
                                        });
                                      },
                                      onError: (err) =>
                                        setActivationFeedback(
                                          cleanApiErrorMessage(
                                            err,
                                            "Shadow manoeuvre selection failed",
                                          ),
                                        ),
                                    },
                                  );
                                }}
                                className="border border-violet-300/45 bg-violet-400/10 px-2 py-1 text-left font-mono text-[10px] text-violet-100 disabled:opacity-35"
                                data-testid="shadow-system-manoeuvre-mode"
                              >
                                <span className="block font-bold">
                                  {selectedUnitData.shadowManeuverMode ===
                                  "sweep"
                                    ? "Sweep Mode"
                                    : "Normal Superb Manoeuvrability"}
                                </span>
                                <span className="block text-[8px] opacity-70">
                                  Sweep: turn 90°, then move straight at up to
                                  twice Speed
                                </span>
                              </button>
                            </div>
                            {movedAlready && (
                              <div className="font-mono text-[8px] text-red-300/75">
                                Shadow system choices lock when movement begins.
                              </div>
                            )}
                          </div>
                        )}
                        <div
                          className="space-y-1.5"
                          data-testid="special-actions-panel"
                        >
                        <div className="text-[10px] uppercase tracking-wider text-amber-400/80 font-mono flex items-center justify-between">
                          <span>
                            Special Action · CQ {selectedUnitData.crewQuality}
                          </span>
                          {actionLocked && (
                            <Badge
                              variant="outline"
                              className={`text-[9px] font-mono ${actionFailed ? "border-red-500/60 text-red-300 bg-red-500/10" : "border-green-500/60 text-green-300 bg-green-500/10"}`}
                              data-testid="badge-active-special-action"
                            >
                              {actionFailed ? "✗" : "✓"} {activeLabel}
                            </Badge>
                          )}
                        </div>
                        {!actionLocked && movedAlready && (
                          <div
                            className="text-[9px] font-mono text-red-300/80 border border-red-500/40 bg-red-500/10 rounded px-2 py-1"
                            data-testid="special-action-locked-by-movement"
                          >
                            ✗ Cannot declare — movement already begun this
                            activation
                          </div>
                        )}
                        {!actionLocked && noSAReason && (
                          <div
                            className="text-[9px] font-mono text-red-300/80 border border-red-500/40 bg-red-500/10 rounded px-2 py-1"
                            data-testid="special-action-locked-by-crit"
                          >
                            ✗ {noSAReason}
                          </div>
                        )}
                        {!actionLocked && scoutActionLocked && (
                          <div
                            className="text-[9px] font-mono text-cyan-300/85 border border-cyan-500/40 bg-cyan-500/10 rounded px-2 py-1"
                            data-testid="special-action-locked-by-scout"
                          >
                            Scout Support already used this round
                          </div>
                        )}
                        {!actionLocked && (
                          <div className="grid grid-cols-1 gap-1">
                            {selectedHasScoutTrait &&
                              (["counter-stealth", "coord"] as const).map(
                              (a) => {
                                const disabled =
                                  !canDeclareScoutSupport ||
                                  declareScoutSupport.isPending;
                                const label =
                                  a === "counter-stealth"
                                    ? "Counter-Stealth"
                                    : "Coordinate Fire";
                                const hint =
                                  a === "counter-stealth"
                                    ? "Reduce enemy Stealth by 1 this round"
                                    : "Mark enemy for one re-roll this round";
                                return (
                                  <button
                                    key={`scout-${a}`}
                                    type="button"
                                    data-testid={`scout-action-${a}`}
                                    disabled={disabled}
                                    onClick={() => {
                                      declareScoutSupport.mutate({
                                        unitId: selectedUnitData.id,
                                        action: a,
                                      });
                                    }}
                                    className={`text-left rounded border px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-35 disabled:cursor-not-allowed ${
                                      "border-cyan-500/35 bg-cyan-500/10 text-cyan-200/90 hover:bg-cyan-500/15"
                                    }`}
                                  >
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="font-bold">{label}</span>
                                      <span className="text-[9px] opacity-70">
                                        CQ 8+
                                      </span>
                                    </div>
                                    <div className="text-[9px] opacity-70">
                                      {`${hint} - activate during Movement phase`}
                                    </div>
                                  </button>
                                );
                              },
                            )}
                            {SPECIAL_ACTIONS.filter((a) =>
                              !a.hidden
                              && (!profileActionIds || profileActionIds.has(a.id))
                            ).map(
                              (a) => {
                                const needsTarget =
                                  a.id === "concentrate-fire" ||
                                  a.id === "cause-confusion";
                                const targetAction = needsTarget
                                  ? a.id === "cause-confusion"
                                    ? "cause-confusion"
                                    : "concentrate-fire"
                                  : null;
                                const picking =
                                  specialActionTargetPicking === a.id;
                                const enemyAlive = units.some(
                                  (x) =>
                                    x.ownerId !== myUserId && !x.isDestroyed,
                                );
                                // Block declarations once any movement/turn has been committed in
                                // this activation — declared actions exist to constrain the
                                // activation that follows, so declaring after the fact would let
                                // a ship bypass speed/turn caps (e.g. move full speed then claim
                                // Run Silent's stealth without paying its ½-speed cost).
                                const ledAct = getLedger(selectedUnitData.id);
                                const alreadyMoved =
                                  ledAct.distance > 0 || ledAct.turns > 0;
                                // All Stop and Pivot: only available if this ship
                                // declared All Stop the previous round (server
                                // enforces the same gate via unit.allStopReady).
                                const needsAllStopPrereq =
                                  a.id === "all-stop-pivot" &&
                                  !selectedUnitData.allStopReady;
                                const conflictsWithShadowSweep =
                                  a.id === "run-silent" &&
                                  selectedUnitData.shadowManeuverMode ===
                                    "sweep";
                                const disabled =
                                  chooseSpecialAction.isPending ||
                                  (needsTarget && !enemyAlive) ||
                                  alreadyMoved ||
                                  scoutActionLocked ||
                                  !!noSAReason ||
                                  needsAllStopPrereq ||
                                  conflictsWithShadowSweep;
                                return (
                                  <button
                                    key={a.id}
                                    data-testid={`special-action-${a.id}`}
                                    disabled={disabled}
                                    onClick={() => {
                                      if (needsTarget) {
                                        setSpecialActionTargetPicking((p) =>
                                          p === targetAction
                                            ? null
                                            : targetAction,
                                        );
                                        return;
                                      }
                                      chooseSpecialAction.mutate(
                                        {
                                          gameId,
                                          unitId: selectedUnitData.id,
                                          data: { action: a.id },
                                        },
                                        {
                                          onSuccess: (res) => {
                                            setSpecialActionFeedback({
                                              action: res.action,
                                              success: res.success,
                                              cqRoll: res.cqRoll ?? null,
                                              cqTotal: res.cqTotal ?? null,
                                              cqRequired:
                                                res.cqRequired ?? null,
                                            });
                                            mergeUpdatedUnitIntoGame(res.unit);
                                            qc.invalidateQueries({
                                              queryKey:
                                                getGetGameQueryKey(gameId),
                                            });
                                          },
                                          onError: (err: any) => {
                                            setSpecialActionFeedback({
                                              action: a.id,
                                              success: false,
                                              cqRoll: null,
                                              cqTotal: null,
                                              cqRequired: a.cq,
                                            });
                                            setActivationFeedback(
                                              cleanApiErrorMessage(
                                                err,
                                                "Special action failed",
                                              ),
                                            );
                                          },
                                        },
                                      );
                                    }}
                                    className={`text-left rounded border px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                                      picking
                                        ? "border-amber-400/80 bg-amber-400/15 text-amber-200"
                                        : "border-amber-500/30 bg-black/40 text-amber-300/90 hover:bg-amber-500/10"
                                    }`}
                                  >
                                    <div className="flex items-center justify-between">
                                      <span className="font-bold">
                                        {a.label}
                                      </span>
                                      <span className="text-[9px] opacity-70">
                                        {a.id === "cause-confusion"
                                          ? "OPPOSED"
                                          : a.cq === null
                                            ? "AUTO"
                                            : `CQ ${a.cq}+`}
                                      </span>
                                    </div>
                                    <div className="text-[9px] opacity-70">
                                      {picking
                                        ? a.id === "cause-confusion"
                                          ? "▸ Click an enemy ship with an active Special Action"
                                          : "▸ Click an enemy ship to nominate"
                                        : needsAllStopPrereq
                                          ? "Requires All Stop last round"
                                          : conflictsWithShadowSweep
                                            ? "Unavailable in Shadow sweep mode"
                                          : a.hint}
                                    </div>
                                  </button>
                                );
                              },
                            )}
                          </div>
                        )}
                        {specialActionFeedback && (
                          <div
                            className={`rounded border px-2 py-1 text-[10px] font-mono ${
                              specialActionFeedback.success
                                ? "border-green-500/50 bg-green-500/10 text-green-300"
                                : "border-red-500/50 bg-red-500/10 text-red-300"
                            }`}
                            data-testid="special-action-feedback"
                          >
                            {specialActionFeedback.cqRoll !== null &&
                            specialActionFeedback.cqTotal !== null &&
                            specialActionFeedback.cqRequired !== null
                              ? `Rolled ${specialActionFeedback.cqRoll} + CQ ${selectedUnitData.crewQuality} = ${specialActionFeedback.cqTotal} vs ${specialActionFeedback.cqRequired}+ → ${specialActionFeedback.success ? "SUCCESS" : "FAIL"}`
                              : `${specialActionFeedback.success ? "✓ ENGAGED" : "✗ FAILED"}`}
                          </div>
                        )}
                      </div>
                      </>
                    );
                  })()}

                {/* Critical-damage / End-Phase damage-control panel has moved
                  outside this movement-only parent block so it renders during
                  the End Phase too. See the sibling block below the parent
                  <div
                    className={`rounded border px-2 py-1.5 font-mono text-xs ${
                      movePlan
                        ? "border-cyan-500/60 bg-cyan-500/10 text-cyan-300"
                        : turnMoves.some(m => m.unitId === selectedUnitData.id)
                        ? "border-green-500/50 bg-green-500/10 text-green-400"
                        : "border-amber-500/30 bg-black/40 text-amber-400/70"
                    }`}
                    data-testid="move-plan-hud"
                  >
                    <div className="text-[10px] uppercase tracking-wider opacity-70 mb-0.5">
                      Plan · {selectedUnitData.name}
                    </div>
                    <div className="text-sm font-bold">
                      {movePlan?.kind === "forward" && `FORWARD ${movePlan.distance.toFixed(1)}" / ${selectedRemainingMove.toFixed(1)}" left`}
                      {movePlan?.kind === "turn" && `TURN ${movePlan.deltaDeg > 0 ? "+" : "−"}${Math.abs(movePlan.deltaDeg)}° / ±${selectedMovementUi?.angleCap ?? selectedUnitData.turnAngle}°`}
                      {!movePlan && turnMoves.some(m => m.unitId === selectedUnitData.id) && "QUEUED"}
                      {!movePlan && !turnMoves.some(m => m.unitId === selectedUnitData.id) && "— idle —"}
                    </div>
                    <div className="text-[10px] uppercase tracking-wider opacity-70 mt-1">
                      Phase: {getLedger(selectedUnitData.id).distance.toFixed(1)}"/{selectedUnitData.speed}" moved · {getLedger(selectedUnitData.id).turns}/{selectedSaCaps?.maxTurns ?? selectedUnitData.turns ?? 1} turns
                    </div>
                    {(() => {
                      // Surface the turn-eligibility gate alongside the phase
                      // counters so the player knows WHY R is/isn't accepted.
                      const baseAction = (selectedUnitData.specialAction ?? "").replace(/-failed$/, "");
                      const isAllStopPivot = baseAction === "all-stop-pivot";
                      const isAllStop = baseAction === "all-stop";
                      const isAllPower = baseAction === "all-power-engines";
                      const isRunSilent = baseAction === "run-silent";
                      if (isAllStop || isAllPower || isRunSilent) return null;
                      const led = getLedger(selectedUnitData.id);
                      const movementTraits = uiMovementTraitsForModel(getShipModelForUnit(selectedUnitData), selectedUnitData);
                      const exempt = isAllStopPivot
                        || movementTraits.superManeuverable
                        || selectedUnitData.damageState === "adrift"
                        || selectedUnitData.damageState === "exploding-end-of-next";
                      if (exempt) return null;
                      const isFirstTurn = led.turns === 0;
                      const need = turnDistanceNeeded(effectiveUiSpeed(selectedUnitData), led.turns, movementTraits);
                      if (!Number.isFinite(need)) {
                        return (
                          <div
                            className="text-[10px] uppercase tracking-wider mt-0.5 text-red-400/80"
                            data-testid="turn-eligibility-hud"
                          >
                            ✗ 1st turn: effective Speed 0 requires All Stop and Pivot
                          </div>
                        );
                      }
                      const have = led.distSinceLastTurn;
                      const met = have + 1e-6 >= need;
                      return (
                        <div
                          className={`text-[10px] uppercase tracking-wider mt-0.5 ${met ? "text-green-400/80" : "text-red-400/80"}`}
                          data-testid="turn-eligibility-hud"
                        >
                          {met ? "✓" : "✗"} {isFirstTurn ? "1st turn" : "next turn"}: {have.toFixed(1)}"/{need.toFixed(1)}" {isFirstTurn ? (movementTraits.agile ? "(¼ speed)" : "(½ speed)") : "since last turn"}
                        </div>
                      );
                    })()}
                  </div>
                  <p className="text-[10px] text-muted-foreground font-mono leading-relaxed">
                    <span className="text-amber-400">F</span> fwd (drag mouse) · <span className="text-amber-400">R</span> turn CW · <span className="text-amber-400">⇧R</span> turn CCW · <span className="text-amber-400">␣</span>/<span className="text-amber-400">↵</span> commit · <span className="text-amber-400">Esc</span> cancel
                  </p>
                </div>
              )}

              {/* ── FIRING PHASE: weapon list for the active ship ── */}
                {currentPhase === "firing" &&
                  activeUnitReadyForActions &&
                  (() => {
                    const attacker = units.find((u) => u.id === activeUnitId);
                    if (!attacker || attacker.ownerId !== myUserId) return null;
                    const weapons = getWeaponsForUnit(attacker);
                    // Authoritative fired-set = server's ledger ∪ optimistic local
                    // adds (covers the brief window before query invalidation lands).
                    const serverFired = new Set(
                      (attacker.firedWeaponIds ?? []) as number[],
                    );
                    const pendingForThisUnit =
                      pendingFired && pendingFired.unitId === attacker.id
                        ? pendingFired.ids
                        : null;
                    const firedSet = new Set<number>([
                      ...serverFired,
                      ...(pendingForThisUnit ?? []),
                    ]);
                    const attackerModel = getShipModelForUnit(attacker);
                    const attackerTraits = attackerModel?.traits ?? "";
                    const attackerRulesProfile =
                      uiRulesProfileForModel(attackerModel);
                    const psychicCrew = isFighterUnit(attacker)
                      ? 0
                      : parseUiPsychicCrew(attackerTraits);
                    const telepathicTargets =
                      psychicCrew > 0
                        ? units.filter((target) => {
                            if (
                              target.ownerId === myUserId
                              || target.isDestroyed
                              || isFighterUnit(target)
                              || uiRulesProfileForModel(
                                getShipModelForUnit(target),
                              ) !== "shadows"
                            ) {
                              return false;
                            }
                            const attemptMarker = 800_000_000 + target.id;
                            const alreadyAttempted = units.some((unit) =>
                              ((unit.firedWeaponIds ?? []) as number[]).includes(
                                attemptMarker,
                              ),
                            );
                            if (alreadyAttempted) return false;
                            return (
                              uiBaseFootprintEdgeDistance(
                                {
                                  id: attacker.id,
                                  x: attacker.hexQ,
                                  z: attacker.hexR,
                                  baseRadiusInches:
                                    attacker.baseRadiusInches,
                                },
                                {
                                  id: target.id,
                                  x: target.hexQ,
                                  z: target.hexR,
                                  baseRadiusInches: target.baseRadiusInches,
                                },
                              ) <=
                              12 + 1e-6
                            );
                          })
                        : [];
                    const shadowDispersalBay =
                      attackerRulesProfile === "shadows"
                        ? (attacker.carriedFighters ?? []).find(
                            (item) =>
                              normalizeSmallCraftKey(item.name) ===
                                "shadow fighter flight" &&
                              item.available > 0 &&
                              item.shipModelId != null,
                          )
                        : undefined;
                    const shadowDispersalFighterModel =
                      shadowDispersalBay?.shipModelId != null
                        ? shipModelById[shadowDispersalBay.shipModelId]
                        : undefined;
                    const skeletonFiringLimited =
                      attacker.isSkeletonCrew &&
                      !/\bflight\s+computer\b/i.test(attackerTraits);
                    const attackerLockedInDogfight =
                      isFighterUnit(attacker) && activeFighterLockedInDogfight;
                    return (
                      <div className="space-y-1.5" data-testid="firing-panel">
                        {attackerLockedInDogfight && (
                          <div
                            className="rounded border border-fuchsia-400/60 bg-fuchsia-500/10 px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider text-fuchsia-100"
                            data-testid="dogfight-locked-note"
                          >
                            Locked in dogfight - use the Dogfight action. Normal
                            fighter attacks are unavailable.
                          </div>
                        )}
                        {psychicCrew > 0 && (
                          <div
                            className="space-y-1 rounded border border-fuchsia-400/45 bg-fuchsia-500/10 p-2 font-mono text-[10px] text-fuchsia-100"
                            data-testid="telepathic-disruption-panel"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-bold uppercase tracking-wider">
                                Telepathic Disruption
                              </span>
                              <span className="text-[9px] opacity-70">
                                Psychic Crew {psychicCrew}
                              </span>
                            </div>
                            {attacker.telepathicDisruptionExhausted ? (
                              <div className="text-red-200">
                                Telepaths burned out for this battle.
                              </div>
                            ) : firedSet.size > 0 ? (
                              <div className="text-red-200">
                                Must be attempted before firing another weapon.
                              </div>
                            ) : telepathicTargets.length === 0 ? (
                              <div className="opacity-70">
                                No eligible Shadow vessel within 12 inches.
                              </div>
                            ) : (
                              <div className="grid grid-cols-1 gap-1">
                                {telepathicTargets.map((target) => (
                                  <button
                                    key={`telepathic-${target.id}`}
                                    type="button"
                                    disabled={
                                      attemptTelepathicDisruption.isPending
                                    }
                                    onClick={() => {
                                      attemptTelepathicDisruption.mutate(
                                        {
                                          gameId,
                                          unitId: attacker.id,
                                          data: { targetUnitId: target.id },
                                        },
                                        {
                                          onSuccess: (result) => {
                                            mergeUpdatedUnitIntoGame(
                                              result.attacker,
                                            );
                                            mergeUpdatedUnitIntoGame(
                                              result.target,
                                            );
                                            setActivationFeedback(
                                              `${result.success ? "Telepathic Disruption succeeded" : "Telepathic Disruption failed"}: ${result.attackerRoll} + Psychic Crew ${result.attackerPsychicCrew} = ${result.attackerTotal} vs ${result.shadowRoll} + CQ ${result.shadowCrewQuality}${result.shadowBonus ? ` + ${result.shadowBonus}` : ""} = ${result.shadowTotal}.`,
                                            );
                                            void qc.invalidateQueries({
                                              queryKey:
                                                getGetGameQueryKey(gameId),
                                            });
                                          },
                                          onError: (err) =>
                                            setActivationFeedback(
                                              cleanApiErrorMessage(
                                                err,
                                                "Telepathic Disruption failed",
                                              ),
                                            ),
                                        },
                                      );
                                    }}
                                    className="border border-fuchsia-300/45 bg-black/35 px-2 py-1 text-left hover:bg-fuchsia-400/15 disabled:opacity-40"
                                  >
                                    Jam {target.name}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {shadowDispersalBay && (
                          <div
                            className="space-y-1 rounded border border-violet-400/45 bg-violet-500/10 p-2 font-mono text-[10px] text-violet-100"
                            data-testid="shadow-dispersal-panel"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-bold uppercase tracking-wider">
                                Fighter Dispersal Tube
                              </span>
                              <span className="text-[9px] opacity-70">
                                {shadowDispersalBay.available} ready
                              </span>
                            </div>
                            <div className="opacity-70">
                              Select a flight count, place each flight within
                              30", then confirm. All flights must remain within
                              3" of one another. Replaces all weapon fire.
                            </div>
                            <div className="grid grid-cols-3 gap-1">
                              {Array.from(
                                {
                                  length: Math.min(
                                    6,
                                    shadowDispersalBay.available,
                                  ),
                                },
                                (_, index) => index + 1,
                              ).map((count) => (
                                <button
                                  key={`shadow-dispersal-${count}`}
                                  type="button"
                                  disabled={
                                    firedSet.size > 0
                                    || !shadowDispersalFighterModel
                                    || launchShadowFighterDispersal.isPending
                                    || pendingShadowDispersalPlacement !== null
                                  }
                                  onClick={() => {
                                    if (!shadowDispersalFighterModel) {
                                      setActivationFeedback(
                                        "Shadow Fighter model is not linked.",
                                      );
                                      return;
                                    }
                                    beginShadowDispersalPlacement(
                                      attacker,
                                      shadowDispersalFighterModel,
                                      count,
                                      shadowDispersalBay.name,
                                    );
                                  }}
                                  className="border border-violet-300/45 bg-black/35 px-2 py-1 text-center hover:bg-violet-400/15 disabled:opacity-40"
                                >
                                  Launch {count}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="text-[10px] uppercase tracking-wider text-red-300/80 font-mono">
                          Weapons · {attacker.name}
                        </div>
                        {weapons.length === 0 && (
                          <p className="text-xs text-muted-foreground font-mono italic">
                            No weapons.
                          </p>
                        )}
                        {splitFirePlan &&
                          splitFirePlan.attackerUnitId === attacker.id && (
                            <div
                              className="rounded border border-sky-400/60 bg-sky-500/10 px-2 py-1.5 font-mono text-[10px] text-sky-100"
                              data-testid="split-fire-plan"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-bold uppercase tracking-wider">
                                  Split Fire
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setSplitFirePlan(null)}
                                  disabled={splitFireCommitting}
                                  className="rounded border border-slate-500 bg-slate-950 px-1.5 py-0.5 text-[9px] text-slate-200 disabled:opacity-40"
                                >
                                  Cancel
                                </button>
                              </div>
                              <div className="mt-1">
                                {splitFirePlan.weapon.name ||
                                  splitFirePlan.weapon.arc}{" "}
                                - {splitFirePlan.totalDice}AD total
                              </div>
                              <div className="mt-1 flex items-center justify-between gap-2">
                                <span>Target one AD</span>
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setSplitFirePlan((plan) =>
                                        plan
                                          ? {
                                              ...plan,
                                              firstDice: clampNumber(
                                                plan.firstDice - 1,
                                                1,
                                                plan.totalDice - 1,
                                              ),
                                            }
                                          : plan,
                                      )
                                    }
                                    disabled={
                                      splitFireCommitting ||
                                      splitFirePlan.firstDice <= 1
                                    }
                                    className="h-6 w-6 rounded border border-sky-400/60 bg-black/50 disabled:opacity-40"
                                  >
                                    -
                                  </button>
                                  <span className="min-w-8 text-center text-xs font-bold tabular-nums">
                                    {splitFirePlan.firstDice}/
                                    {splitFirePlan.totalDice -
                                      splitFirePlan.firstDice}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setSplitFirePlan((plan) =>
                                        plan
                                          ? {
                                              ...plan,
                                              firstDice: clampNumber(
                                                plan.firstDice + 1,
                                                1,
                                                plan.totalDice - 1,
                                              ),
                                            }
                                          : plan,
                                      )
                                    }
                                    disabled={
                                      splitFireCommitting ||
                                      splitFirePlan.firstDice >=
                                        splitFirePlan.totalDice - 1
                                    }
                                    className="h-6 w-6 rounded border border-sky-400/60 bg-black/50 disabled:opacity-40"
                                  >
                                    +
                                  </button>
                                </div>
                              </div>
                              <div className="mt-1 uppercase tracking-wider text-sky-200/80">
                                {splitFireCommitting
                                  ? "Resolving split fire..."
                                  : splitFirePlan.firstTargetName
                                    ? `Target one: ${splitFirePlan.firstTargetName}. Pick target two.`
                                    : "Pick target one."}
                              </div>
                            </div>
                          )}
                        {hasAvailableScoutCoordToken && (
                          <label
                            className={`flex cursor-pointer select-none items-center justify-between gap-3 rounded border px-3 py-2 font-mono text-[11px] transition-colors ${
                              useCoordOnNext
                                ? "border-sky-200/80 bg-sky-300/20 text-sky-50 shadow-[0_0_18px_rgba(125,211,252,0.22)]"
                                : "border-sky-300/45 bg-sky-400/10 text-sky-100 hover:bg-sky-400/20"
                            }`}
                            data-testid="scout-coord-toggle"
                          >
                            <span>
                              <span className="block text-xs font-bold uppercase tracking-wider">
                                Expend Coordinated Fire?
                              </span>
                              <span className="text-[10px] text-sky-100/70">
                                Next eligible weapon into the marked target rerolls missed AD.
                              </span>
                            </span>
                            <input
                              type="checkbox"
                              checked={useCoordOnNext}
                              onChange={(e) =>
                                setUseCoordOnNext(e.target.checked)
                              }
                              className="h-4 w-4 accent-sky-300"
                              data-testid="scout-coord-checkbox"
                            />
                          </label>
                        )}
                        {weapons.map((w) => {
                          const fired = firedSet.has(w.id);
                          const skeletonBlocked =
                            skeletonFiringLimited &&
                            !fired &&
                            firedSet.size > 0;
                          const crippledArcBlocked =
                            attacker.isCrippled &&
                            !fired &&
                            weapons.some(
                              (prev) =>
                                firedSet.has(prev.id) && prev.arc === w.arc,
                            );
                          const slowLoading = /\bslow[-\s]?loading\b/i.test(
                            w.traits ?? "",
                          );
                          const slowLoadingReadyRound = Number(
                            attacker.slowLoadingWeaponCooldowns?.[
                              String(w.id)
                            ] ?? 0,
                          );
                          const slowLoadingCooling =
                            slowLoading &&
                            game.currentRound < slowLoadingReadyRound;
                          const picking = firingWeaponPicking === w.id;
                          const splitActive =
                            splitFirePlan?.attackerUnitId === attacker.id &&
                            splitFirePlan.weapon.id === w.id;
                          const splitTotalDice = effectiveUiAttackDice(w);
                          const splitFireReason = splitFireBlockedReason(
                            w,
                            useCoordOnNext,
                          );
                          const unavailable =
                            attackerLockedInDogfight ||
                            fired ||
                            slowLoadingCooling ||
                            skeletonBlocked ||
                            crippledArcBlocked;
                          const shadowPointDefense =
                            uiShadowPointDefenseWeaponActive(
                              attacker,
                              attackerModel,
                              w,
                              game.currentRound ?? 0,
                            );
                          const displayArc = shadowPointDefense
                            ? "Turret"
                            : w.arc;
                          const displayRange = shadowPointDefense
                            ? w.range / 2
                            : w.range;
                          const weaponTraitList = shadowPointDefense
                            ? ["Accurate", "Mini-Beam"]
                            : splitTraitList(w.traits);
                          return (
                            <div
                              key={w.id}
                              className="grid grid-cols-[1fr_auto] gap-1"
                            >
                              <button
                                key={w.id}
                                data-testid={`weapon-${w.id}`}
                                disabled={
                                  unavailable ||
                                  declaredScoutSupportBlocksFiring ||
                                  fireWeapon.isPending ||
                                  splitFireCommitting
                                }
                                onClick={() => {
                                  if (declaredScoutSupportBlocksFiring) {
                                    setActivationFeedback(
                                      "Resolve declared Scout Support before firing weapons.",
                                    );
                                    return;
                                  }
                                  setSplitFirePlan(null);
                                  setFiringWeaponPicking(picking ? null : w.id);
                                }}
                                className={`w-full text-left rounded border px-2 py-1.5 font-mono text-xs transition-colors ${
                                  unavailable
                                    ? "border-red-500/30 bg-red-500/5 text-red-300/60 line-through cursor-not-allowed"
                                    : picking
                                      ? "border-amber-400/80 bg-amber-400/15 text-amber-200"
                                      : "border-green-500/40 bg-green-500/5 text-green-300 hover:bg-green-500/10"
                                }`}
                              >
                                <div className="flex items-center justify-between">
                                  <span className="font-bold">
                                    {w.name || w.arc}
                                  </span>
                                  <span className="text-[10px] opacity-70">
                                    {w.attackDice}AD · r{displayRange}"
                                  </span>
                                </div>
                                <div className="text-[10px] opacity-70 mt-0.5">
                                  {pcHoverHintsEnabled ? (
                                    <>
                                      <span>{displayArc}</span>
                                      {weaponTraitList.length > 0 && (
                                        <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
                                          {weaponTraitList.map((trait) => (
                                            <TraitTooltip
                                              key={`${w.id}-${trait}`}
                                              trait={trait}
                                            >
                                              <span className="cursor-help rounded border border-current/20 px-1">
                                                {trait}
                                              </span>
                                            </TraitTooltip>
                                          ))}
                                        </span>
                                      )}
                                    </>
                                  ) : (
                                    <>
                                      {displayArc}
                                      {shadowPointDefense
                                        ? " · Accurate, Mini-Beam · Shadow point defence"
                                        : w.traits
                                          ? ` · ${w.traits}`
                                          : ""}
                                    </>
                                  )}
                                </div>
                                {picking && (
                                  <div className="text-[10px] text-amber-200 mt-1 uppercase tracking-wider">
                                    ▸ Click an enemy ship to fire
                                  </div>
                                )}
                                {slowLoadingCooling && (
                                  <div className="text-[10px] text-red-200 mt-1 uppercase tracking-wider">
                                    Reloading · ready round{" "}
                                    {slowLoadingReadyRound}
                                  </div>
                                )}
                                {skeletonBlocked && (
                                  <div className="text-[10px] text-red-200 mt-1 uppercase tracking-wider">
                                    Skeleton Crew - one weapon system
                                  </div>
                                )}
                                {crippledArcBlocked && (
                                  <div className="text-[10px] text-red-200 mt-1 uppercase tracking-wider">
                                    Crippled - {w.arc} arc already fired
                                  </div>
                                )}
                              </button>
                              <button
                                type="button"
                                data-testid={`split-fire-${w.id}`}
                                title={
                                  splitFireReason ??
                                  "Split this weapon across two targets"
                                }
                                disabled={
                                  unavailable ||
                                  declaredScoutSupportBlocksFiring ||
                                  splitFireReason !== null ||
                                  fireWeapon.isPending ||
                                  splitFireCommitting
                                }
                                onClick={() => {
                                  const firstDice = clampNumber(
                                    Math.floor(splitTotalDice / 2),
                                    1,
                                    splitTotalDice - 1,
                                  );
                                  setFiringWeaponPicking(null);
                                  setSplitFirePlan(
                                    splitActive
                                      ? null
                                      : {
                                          weapon: w,
                                          attackerUnitId: attacker.id,
                                          firstDice,
                                          totalDice: splitTotalDice,
                                        },
                                  );
                                  if (!splitActive)
                                    setActivationFeedback(
                                      "Split fire: pick target one.",
                                    );
                                }}
                                className={`rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                                  splitActive
                                    ? "border-sky-300/90 bg-sky-300/20 text-sky-100"
                                    : "border-sky-500/40 bg-sky-500/5 text-sky-300 hover:bg-sky-500/10"
                                }`}
                              >
                                Split
                              </button>
                            </div>
                          );
                        })}
                        {/* Scout Coordination opt-in. Server validates token /
                        weapon eligibility on submit; we show the checkbox
                        unconditionally so the player can see it as an
                        option. */}
                        {hasAvailableScoutCoordToken && (
                          <label
                            className="hidden"
                            data-testid="scout-coord-toggle"
                          >
                            <input
                              type="checkbox"
                              checked={useCoordOnNext}
                              onChange={(e) =>
                                setUseCoordOnNext(e.target.checked)
                              }
                              className="accent-cyan-400"
                              data-testid="scout-coord-checkbox"
                            />
                            <span>
                              Use Scout Coord on next shot · re-roll missed AD
                            </span>
                          </label>
                        )}
                        <p className="text-[10px] text-muted-foreground font-mono">
                          Pick weapons → target → End Activation when done.
                        </p>
                      </div>
                    );
                  })()}

              </div>
            )}

          {/* ── Critical-damage / End-Phase Damage-Control panel ─────────────
              Rendered as a sibling of the activation panel above so it
              survives the End Phase (when that panel is hidden). Shows
              for own non-destroyed ships either when crits exist, or
              unconditionally during the End Phase so the player always
              sees what DC + All Hands on Deck options are available. */}
          {game.status === "active" &&
            selectedUnitData &&
            selectedUnitData.ownerId === myUserId &&
            !selectedUnitData.isDestroyed &&
            (currentPhase === "end" ||
              (selectedUnitData.criticals?.length ?? 0) > 0) &&
            (() => {
              const crits = selectedUnitData.criticals ?? [];
              const currentRound = game.currentRound ?? 0;
              const dcAttemptedThisRound =
                (selectedUnitData.lastDcRound ?? 0) === currentRound;
              const inEndPhase = currentPhase === "end";
              const isMyEndWindow =
                inEndPhase && game.activePlayerId === myUserId;
              const myPassedEnd =
                inEndPhase &&
                (myUserId === game.challengerId
                  ? !!game.endPhaseChallengerPassed
                  : myUserId === game.opponentId
                    ? !!game.endPhaseOpponentPassed
                    : false);
              const rawSA = selectedUnitData.specialAction ?? null;
              const baseSA = rawSA ? rawSA.replace(/-failed$/, "") : null;
              const allHandsActive =
                baseSA === "all-hands-on-deck" && !rawSA?.endsWith("-failed");
              const allHandsFailed = rawSA === "all-hands-on-deck-failed";
              const cq = selectedUnitData.crewQuality;
              const allHandsBonus = allHandsActive ? 2 : 0;
              const traitsForSelfRepair =
                getShipModelForUnit(selectedUnitData)?.traits ?? "";
              const selfRepairDice = parseUiSelfRepairDice(traitsForSelfRepair);
              const selfRepairUsedThisRound =
                (selectedUnitData.lastSelfRepairRound ?? 0) === currentRound;
              const selfRepairBusy =
                selfRepairModal?.unitId === selectedUnitData.id &&
                selfRepairModal.phase === "rolling";
              const selfRepairBlockedReason =
                selectedUnitData.hullPoints <= 0
                  ? "Hulked ships cannot use Self Repair"
                  : (selectedUnitData.maxCrewPoints ?? 0) > 0 &&
                      (selectedUnitData.crewPoints ?? 0) <= 0
                    ? "Crewless ships cannot use Self Repair"
                    : null;
              const damageControlBlockedReason =
                selectedUnitData.hullPoints <= 0
                  ? "Hulked ships cannot perform Damage Control"
                  : (selectedUnitData.maxCrewPoints ?? 0) > 0 &&
                      (selectedUnitData.crewPoints ?? 0) <= 0
                    ? "Crewless ships cannot perform Damage Control"
                    : null;
              const canSelfRepair =
                selfRepairDice > 0 &&
                selfRepairBlockedReason === null &&
                selectedUnitData.hullPoints < selectedUnitData.maxHullPoints &&
                !selfRepairUsedThisRound &&
                !selfRepairBusy &&
                isMyEndWindow &&
                !myPassedEnd;
              return (
                <div
                  className="p-4 border-b border-border space-y-1.5"
                  data-testid="crit-panel"
                >
                  <div className="text-[10px] uppercase tracking-wider text-red-400/80 font-mono flex items-center justify-between">
                    <span>
                      {inEndPhase
                        ? `End Phase · Damage Control · ${selectedUnitData.name}`
                        : `Critical Damage · ${crits.length}`}
                    </span>
                    {dcAttemptedThisRound && (
                      <span className="text-[9px] text-red-300/60">
                        DC used this round
                      </span>
                    )}
                  </div>
                  {inEndPhase && allHandsActive && (
                    <div
                      className="rounded border border-green-500/60 bg-green-500/10 px-2 py-1 font-mono text-[10px] text-green-300"
                      data-testid="all-hands-status-active"
                    >
                      ✓ All Hands on Deck — +2 DC &amp; unlimited repairs this
                      round (declared in Movement)
                    </div>
                  )}
                  {inEndPhase && allHandsFailed && (
                    <div
                      className="rounded border border-red-500/50 bg-red-500/10 px-2 py-1 font-mono text-[10px] text-red-300"
                      data-testid="all-hands-status-failed"
                    >
                      ✗ All Hands on Deck failed this round — no DC bonus
                    </div>
                  )}
                  {crits.length === 0 && inEndPhase && (
                    <div
                      className="rounded border border-emerald-500/30 bg-emerald-500/5 px-2 py-1.5 font-mono text-[10px] text-emerald-300/80"
                      data-testid="crit-panel-empty"
                    >
                      No critical damage to repair on this ship.
                    </div>
                  )}
                  {damageControlFeedback &&
                    damageControlFeedback.unitId === selectedUnitData.id && (
                      <div
                        className={`rounded border px-2 py-1.5 font-mono text-[10px] ${
                          damageControlFeedback.success
                            ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                            : "border-red-500/50 bg-red-500/10 text-red-300"
                        }`}
                        data-testid="damage-control-feedback"
                      >
                        <div className="font-bold uppercase">
                          {damageControlFeedback.success
                            ? "Damage Control Success"
                            : "Damage Control Failed"}
                        </div>
                        <div className="mt-0.5">
                          {damageControlFeedback.effectName}: rolled{" "}
                          {damageControlFeedback.dcRoll} + CQ {cq}
                          {damageControlFeedback.dcBonus > 0
                            ? ` + ${damageControlFeedback.dcBonus}`
                            : ""}
                          {damageControlFeedback.dcPenalty > 0
                            ? ` - ${damageControlFeedback.dcPenalty}`
                            : ""}
                          {" = "}
                          {damageControlFeedback.dcTotal} vs{" "}
                          {damageControlFeedback.dcThreshold}+.
                        </div>
                      </div>
                    )}
                  {inEndPhase && selfRepairDice > 0 && (
                    <div
                      className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1.5 font-mono text-[11px] text-sky-200"
                      data-testid="self-repair-row"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold uppercase">Self Repair</span>
                        <span className="text-[9px] opacity-70">
                          {selectedUnitData.hullPoints}/
                          {selectedUnitData.maxHullPoints} hull
                        </span>
                      </div>
                      <button
                        data-testid="button-self-repair"
                        disabled={!canSelfRepair}
                        onClick={() => {
                          setSelfRepairModal({
                            unitId: selectedUnitData.id,
                            unitName: selectedUnitData.name,
                            dice: selfRepairDice,
                            phase: "ready",
                          });
                        }}
                        className="mt-1 w-full rounded border border-sky-400/50 bg-sky-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-sky-200 hover:bg-sky-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {selfRepairBusy
                          ? "Rolling..."
                          : selfRepairBlockedReason
                            ? selfRepairBlockedReason
                            : selectedUnitData.hullPoints >=
                              selectedUnitData.maxHullPoints
                            ? "Hull fully repaired"
                            : selfRepairUsedThisRound
                              ? "Self Repair used this round"
                              : myPassedEnd
                                ? "You've passed End Phase"
                                : !isMyEndWindow
                                  ? "Available in your End Phase"
                                  : `Self Repair (${selfRepairDice}d6)`}
                      </button>
                    </div>
                  )}
                  {crits.map((c) => {
                    const isSameRound = c.appliedRound === currentRound;
                    // All Hands on Deck lifts the once-per-round DC cap — when
                    // active, dcAttemptedThisRound no longer locks repairs.
                    const dcLocked = dcAttemptedThisRound && !allHandsActive;
                    const canRepair =
                      c.repairable &&
                      damageControlBlockedReason === null &&
                      !isSameRound &&
                      !dcLocked &&
                      !damageControl.isPending &&
                      isMyEndWindow &&
                      !myPassedEnd;
                    const dcFormula = `1d6+CQ${cq}${allHandsBonus > 0 ? `+${allHandsBonus}` : ""}≥9`;
                    return (
                      <CriticalEffectTooltip
                        key={c.id}
                        crit={c}
                        enabled={pcHoverHintsEnabled}
                      >
                      <div
                        className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 font-mono text-[11px] text-red-200 focus:outline-none focus:ring-1 focus:ring-red-300/60 data-[hint=true]:cursor-help"
                        data-hint={pcHoverHintsEnabled ? "true" : "false"}
                        data-testid={`crit-row-${c.id}`}
                        tabIndex={pcHoverHintsEnabled ? 0 : undefined}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold uppercase">
                            {c.name}
                          </span>
                          <span className="text-[9px] opacity-70">
                            {c.damageApplied > 0 && `−${c.damageApplied}H `}
                            {c.crewApplied > 0 && `−${c.crewApplied}C`}
                          </span>
                        </div>
                        {(c.randomArc || (c.lostTraits?.length ?? 0) > 0) && (
                          <div className="text-[9px] opacity-70 mt-0.5">
                            {c.randomArc && <>arc: {c.randomArc} </>}
                            {(c.lostTraits?.length ?? 0) > 0 && (
                              <>
                                lost:{" "}
                                {c.lostTraits!.map((trait, index) => (
                                  <React.Fragment key={`${c.id}-lost-${trait}`}>
                                    {index > 0 ? ", " : ""}
                                    <TraitTooltip
                                      trait={trait}
                                      enabled={pcHoverHintsEnabled}
                                    >
                                      <span className="cursor-help">{trait}</span>
                                    </TraitTooltip>
                                  </React.Fragment>
                                ))}
                              </>
                            )}
                          </div>
                        )}
                        <button
                          data-testid={`damage-control-${c.id}`}
                          disabled={!canRepair}
                          onClick={() => {
                            damageControl.mutate(
                              {
                                gameId,
                                unitId: selectedUnitData.id,
                                data: { effectId: c.id },
                              },
                              {
                                onSuccess: (res: DamageControlResult) => {
                                  mergeUpdatedUnitIntoGame(res.unit);
                                  setDamageControlFeedback({
                                    unitId: selectedUnitData.id,
                                    effectId: c.id,
                                    effectName: c.name,
                                    success: res.success,
                                    dcRoll: res.dcRoll,
                                    dcTotal: res.dcTotal,
                                    dcThreshold: res.dcThreshold,
                                    dcPenalty: res.dcPenalty,
                                    dcBonus: res.dcBonus,
                                  });
                                  setActivationFeedback(
                                    res.success
                                      ? `Damage Control repaired ${c.name}.`
                                      : `Damage Control failed on ${c.name}.`,
                                  );
                                },
                                onError: (err: unknown) => {
                                  setDamageControlFeedback(null);
                                  setActivationFeedback(
                                    cleanApiErrorMessage(
                                      err,
                                      "Damage Control failed",
                                    ),
                                  );
                                },
                                onSettled: () => {
                                  void qc.invalidateQueries({
                                    queryKey: getGetGameQueryKey(gameId),
                                  });
                                  void qc.invalidateQueries({
                                    queryKey: [
                                      "special-action-audit-log",
                                      gameId,
                                    ],
                                  });
                                },
                              },
                            );
                          }}
                          className="mt-1 w-full rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-300 hover:bg-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {damageControlBlockedReason
                            ? damageControlBlockedReason
                            : !c.repairable
                            ? "Unrepairable (Vital Systems)"
                            : isSameRound
                              ? "Wait until next round"
                              : dcLocked
                                ? "DC locked this round"
                                : myPassedEnd
                                  ? "You've passed End Phase"
                                  : !isMyEndWindow
                                    ? "Available in End Phase"
                                    : `Damage Control (${dcFormula})`}
                        </button>
                      </div>
                      </CriticalEffectTooltip>
                    );
                  })}
                </div>
              );
            })()}

          {/* Enemy fleet roster (top) */}
          <div className="flex-1 overflow-hidden flex flex-col border-b border-border">
            <div className="px-4 pt-3 pb-2 border-b border-border flex items-center justify-between">
              <p className="text-xs font-mono text-red-400 uppercase tracking-wider">
                Enemy Fleet
              </p>
              <span className="text-[10px] font-mono text-muted-foreground">
                {
                  units.filter(
                    (u) => u.ownerId !== myUserId && unitIsCombatEffective(u),
                  ).length
                }
                /{units.filter((u) => u.ownerId !== myUserId).length}
              </span>
            </div>
            <ScrollArea className="flex-1 px-4 py-2">
              {units.filter((u) => u.ownerId !== myUserId).length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">
                  No enemy contacts
                </p>
              ) : (
                <div className="space-y-1">
                  {units
                    .filter((u) => u.ownerId !== myUserId)
                    .map((unit) => {
                      const selected = selectedUnit === unit.id;
                      const combatEffective = unitIsCombatEffective(unit);
                      return (
                        <div
                          key={unit.id}
                          data-testid={`unit-${unit.id}`}
                          className={`flex items-center justify-between text-xs rounded px-2 py-1 cursor-pointer transition-colors ${selected ? "border border-yellow-400/60 bg-yellow-400/10" : combatEffective ? "border border-red-500/30 bg-red-500/5 hover:bg-red-500/10" : "border border-slate-500/30 bg-slate-500/5 hover:bg-slate-500/10"} ${combatEffective ? "" : "opacity-40 line-through"}`}
                          onClick={() => handleUnitClick(unit.id)}
                        >
                          <span
                            className={`font-mono truncate max-w-[110px] ${selected ? "text-yellow-300" : combatEffective ? "text-red-300" : "text-slate-300"}`}
                          >
                            {unit.name}
                          </span>
                          <span className="font-mono text-muted-foreground shrink-0">
                            {unit.hullPoints}/{unit.maxHullPoints}
                          </span>
                        </div>
                      );
                    })}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* My fleet roster (bottom) */}
          <div>
            <div className="px-4 pt-3 pb-2 flex items-center justify-between">
              <p className="text-xs font-mono text-green-400 uppercase tracking-wider">
                My Fleet
              </p>
              <span className="text-[10px] font-mono text-muted-foreground">
                {
                  units.filter(
                    (u) => u.ownerId === myUserId && unitIsCombatEffective(u),
                  ).length
                }
                /{units.filter((u) => u.ownerId === myUserId).length}
              </span>
            </div>
            <ScrollArea className="h-32 px-4 pb-3">
              <div className="space-y-1">
                {units.filter((u) => u.ownerId === myUserId).length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2 text-center">
                    No units deployed
                  </p>
                ) : (
                  units
                    .filter((u) => u.ownerId === myUserId)
                    .map((unit) => {
                      const selected = selectedUnit === unit.id;
                      const active = activeUnitId === unit.id;
                      const combatEffective = unitIsCombatEffective(unit);
                      const unavailableDuringCommittedActivation =
                        game.status === "active" &&
                        isMyActivation &&
                        currentPhase !== "end" &&
                        hasActiveUnit &&
                        !active &&
                        activeActivationCommitted;
                      // Firing-phase derelict: hull or crew gone. Cannot be
                      // activated to fire. Greyed out + "INERT" badge so the
                      // player understands why clicking does nothing.
                      const firingInert =
                        currentPhase === "firing" &&
                        !unit.isDestroyed &&
                        (unit.hullPoints <= 0 ||
                          ((unit.maxCrewPoints ?? 0) > 0 &&
                            (unit.crewPoints ?? 0) <= 0));
                      return (
                        <div
                          key={unit.id}
                          data-testid={`unit-${unit.id}`}
                          className={`flex items-center justify-between text-xs rounded px-2 py-1 transition-colors ${active ? "border border-amber-300/80 bg-amber-300/15" : selected ? "border border-blue-400/60 bg-blue-400/10" : combatEffective ? "border border-green-500/30 bg-green-500/5 hover:bg-green-500/10" : "border border-slate-500/30 bg-slate-500/5 hover:bg-slate-500/10"} ${combatEffective ? firingInert || unavailableDuringCommittedActivation ? "opacity-50 cursor-not-allowed" : "cursor-pointer" : "opacity-40 line-through cursor-not-allowed"}`}
                          onClick={() => handleUnitClick(unit.id)}
                          title={
                            firingInert
                              ? unit.hullPoints <= 0
                                ? "Hull breached — cannot fire"
                                : "No surviving crew — cannot fire"
                              : undefined
                          }
                        >
                          <span
                            className={`font-mono truncate max-w-[110px] ${active ? "text-amber-200" : selected ? "text-blue-300" : combatEffective ? "text-green-300" : "text-slate-300"}`}
                          >
                            {unit.name}
                          </span>
                          <div className="flex items-center gap-1 shrink-0">
                            {active && (
                              <span
                                data-testid={`unit-${unit.id}-active-badge`}
                                className="font-mono text-[9px] uppercase tracking-wider px-1 py-px rounded bg-amber-400/20 text-amber-200 border border-amber-400/50"
                              >
                                Active
                              </span>
                            )}
                            {unavailableDuringCommittedActivation && (
                              <span
                                data-testid={`unit-${unit.id}-locked-badge`}
                                className="font-mono text-[9px] uppercase tracking-wider px-1 py-px rounded bg-slate-500/20 text-slate-300 border border-slate-500/40"
                              >
                                Locked
                              </span>
                            )}
                            {firingInert && (
                              <span
                                data-testid={`unit-${unit.id}-inert-badge`}
                                className="font-mono text-[9px] uppercase tracking-wider px-1 py-px rounded bg-red-500/20 text-red-300 border border-red-500/40"
                              >
                                Inert
                              </span>
                            )}
                            <span className="font-mono text-muted-foreground">
                              {unit.hullPoints}/{unit.maxHullPoints}
                            </span>
                          </div>
                        </div>
                      );
                    })
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      </div>

      {/* Result and confirmation modals */}
      {/* AI firing activation summary */}
      <Dialog
        open={pendingAiFiringSummary !== null}
        onOpenChange={(open) => {
          if (!open) acknowledgeAiFiringSummary();
        }}
      >
        <DialogContent
          className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-lg flex-col gap-0 overflow-hidden border-amber-300/70 bg-black/95 p-0 font-mono text-amber-50 shadow-[0_0_45px_rgba(251,191,36,0.24)]"
          data-testid="dialog-ai-firing-summary"
        >
          <DialogHeader className="shrink-0 border-b border-amber-300/25 px-4 py-4 pr-12 text-left">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-amber-300/70 bg-amber-300 text-black">
                <Swords className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="text-sm uppercase tracking-[0.18em] text-amber-200">
                  AI Firing Summary
                </DialogTitle>
                <DialogDescription className="mt-1 truncate text-[11px] text-amber-100/65">
                  Round {pendingAiFiringSummary?.round ?? 0} ·{" "}
                  {pendingAiFiringSummary?.attackerName ?? "AI ship"} completed
                  firing
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
            <div className="divide-y divide-amber-300/15 border border-amber-300/25 bg-amber-300/5">
              {pendingAiFiringSummary?.targets.map((target) => {
                const outcome = target.destroyed
                  ? "Destroyed"
                  : target.damageState === "exploding-end-of-next"
                    ? "Exploding"
                    : target.damageState === "adrift"
                      ? "Adrift"
                      : target.crippled
                        ? "Crippled"
                        : null;
                return (
                  <div
                    key={target.targetUnitId}
                    className="px-3 py-3"
                    data-testid={`ai-firing-summary-target-${target.targetUnitId}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 text-xs leading-relaxed text-amber-50">
                        <span className="font-bold text-amber-200">
                          {pendingAiFiringSummary.attackerName}
                        </span>{" "}
                        attacked{" "}
                        <span className="font-bold text-cyan-200">
                          {target.targetName}
                        </span>{" "}
                        for{" "}
                        <span className="font-bold text-red-300">
                          {target.hullDamage} hull
                        </span>
                        ,{" "}
                        <span className="font-bold text-sky-300">
                          {target.crewDamage} crew
                        </span>
                        .
                      </p>
                      {outcome && (
                        <Badge
                          variant="outline"
                          className="shrink-0 border-red-400/60 bg-red-500/10 text-[9px] uppercase text-red-200"
                        >
                          {outcome}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                      {target.weaponsFired} weapon
                      {target.weaponsFired === 1 ? "" : "s"} · {target.hits} hit
                      {target.hits === 1 ? "" : "s"} ·{" "}
                      {target.weaponNames.join(", ")}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

          <DialogFooter className="shrink-0 gap-3 border-t border-amber-300/25 bg-black/95 px-4 py-3 sm:items-center sm:justify-between sm:space-x-0">
            <div className="text-[10px] uppercase tracking-wider text-slate-400">
              {pendingAiFiringSummary?.weaponsFired ?? 0} weapons ·{" "}
              {pendingAiFiringSummary?.targets.length ?? 0} targets ·{" "}
              {pendingAiFiringSummary?.totalHullDamage ?? 0} hull ·{" "}
              {pendingAiFiringSummary?.totalCrewDamage ?? 0} crew
            </div>
            <Button
              type="button"
              onClick={acknowledgeAiFiringSummary}
              className="bg-amber-300 font-mono text-xs font-black uppercase tracking-widest text-black hover:bg-amber-200"
              data-testid="button-continue-ai-firing"
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={bugReportOpen}
        onOpenChange={(open) => {
          if (!bugReportPending) {
            setBugReportOpen(open);
            if (!open) setBugReportError(null);
          }
        }}
      >
        <DialogContent className="border-red-500/30 bg-background/95">
          <DialogHeader>
            <DialogTitle className="font-mono text-lg uppercase tracking-[0.18em] text-red-200">
              Report Blocker
            </DialogTitle>
            <DialogDescription className="font-mono text-xs leading-relaxed">
              Send a short alpha bug report. If this step is blocking the game,
              you can force the current movement or firing step forward.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea
              data-testid="textarea-bug-report"
              value={bugReportMessage}
              onChange={(event) => setBugReportMessage(event.target.value)}
              maxLength={800}
              rows={5}
              placeholder="What happened? Example: Oracle cannot finish movement although a legal space appears available."
              className="font-mono text-xs"
            />
            <label className="flex items-start gap-2 rounded border border-red-500/25 bg-red-950/20 p-3 text-xs font-mono leading-relaxed text-red-100/85">
              <input
                data-testid="checkbox-bug-rescue"
                type="checkbox"
                className="mt-0.5"
                checked={bugReportBlocking}
                onChange={(event) => setBugReportBlocking(event.target.checked)}
              />
              <span>
                This bug is blocking the current step. Force this activation
                forward and notify my opponent.
              </span>
            </label>
            {bugReportError && (
              <p
                className="text-[11px] font-mono text-red-300"
                data-testid="text-bug-report-error"
              >
                {bugReportError}
              </p>
            )}
          </div>
          <DialogFooter className="gap-2 sm:space-x-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => setBugReportOpen(false)}
              disabled={bugReportPending}
              data-testid="button-cancel-bug-report"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={bugReportBlocking ? "destructive" : "default"}
              onClick={handleSubmitBugReport}
              disabled={bugReportPending || bugReportMessage.trim().length < 4}
              data-testid="button-submit-bug-report"
            >
              {bugReportPending
                ? "Submitting..."
                : bugReportBlocking
                  ? "Submit and Force Step"
                  : "Submit Report"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmingAbandon}
        onOpenChange={(open) => {
          if (!abandonGame.isPending) setConfirmingAbandon(open);
        }}
      >
        <AlertDialogContent
          className="fixed max-h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] overflow-hidden border-2 border-red-500/90 bg-black p-0 text-red-50 shadow-[0_0_45px_rgba(239,68,68,0.32)] sm:max-w-md"
          data-testid="dialog-abandon-game-confirm"
        >
          <div
            className="absolute inset-0 opacity-25"
            style={{
              backgroundImage:
                "repeating-linear-gradient(135deg, #ef4444 0 18px, #ef4444 18px 34px, #020617 34px 52px, #020617 52px 68px)",
            }}
          />
          <div className="relative m-2 max-h-[calc(100dvh-2.5rem)] overflow-y-auto border border-red-400/60 bg-black/95 p-4 shadow-inner shadow-black sm:p-5">
            <AlertDialogHeader className="space-y-3 text-left">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-red-400/80 bg-red-500 text-black shadow-[0_0_18px_rgba(239,68,68,0.45)]">
                  <AlertTriangle className="h-6 w-6" />
                </div>
                <AlertDialogTitle className="font-mono text-lg uppercase tracking-[0.18em] text-red-200">
                  Abandon Game?
                </AlertDialogTitle>
              </div>
              <AlertDialogDescription className="font-mono text-xs leading-relaxed text-red-100/85">
                {isOpponent && game?.status === "deploying"
                  ? "You will leave this setup. Any ships you deployed will be removed, and the challenge will return to the lobby for another commander."
                  : "This will close this pre-start setup. It will not be recorded as a completed battle."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="my-4 border border-red-400/35 bg-red-500/10 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-red-100/90">
              This action is only for games that have not started.
            </div>
            <AlertDialogFooter className="gap-2 sm:space-x-0">
              <AlertDialogCancel
                disabled={abandonGame.isPending}
                className="border-slate-500 bg-slate-950 font-mono text-xs uppercase tracking-widest text-slate-100 hover:bg-slate-800"
                data-testid="button-cancel-abandon-game"
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={abandonGame.isPending}
                onClick={(event) => {
                  event.preventDefault();
                  abandonGame.mutate();
                }}
                className="bg-red-500 font-mono text-xs font-black uppercase tracking-widest text-black hover:bg-red-400 disabled:bg-slate-700 disabled:text-slate-400"
                data-testid="button-confirm-abandon-game"
              >
                {abandonGame.isPending ? "Abandoning..." : "Confirm Abandon"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={endActivationConfirmOpen}
        onOpenChange={(open) => {
          if (!endActivation.isPending) setEndActivationConfirmOpen(open);
        }}
      >
        <AlertDialogContent
          className="fixed max-h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] overflow-hidden border-2 border-amber-300/90 bg-black p-0 text-amber-50 shadow-[0_0_45px_rgba(251,191,36,0.28)] sm:max-w-md"
          data-testid="dialog-end-activation-confirm"
        >
          <div className="relative m-2 max-h-[calc(100dvh-2.5rem)] overflow-y-auto border border-amber-300/60 bg-black/95 p-4 shadow-inner shadow-black sm:p-5">
            <AlertDialogHeader className="space-y-3 text-left">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-amber-300/80 bg-amber-300 text-black shadow-[0_0_18px_rgba(251,191,36,0.45)]">
                  <CheckCircle className="h-6 w-6" />
                </div>
                <AlertDialogTitle className="font-mono text-base tracking-[0.04em] text-amber-200">
                  Confirm end of activation?
                </AlertDialogTitle>
              </div>
              <AlertDialogDescription className="sr-only">
                Confirm ending the current activation.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {hasActiveUnit && (
              <div className="my-4 border border-amber-300/35 bg-amber-300/10 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-amber-100/90">
                Active unit:{" "}
                {units.find((u) => u.id === activeUnitId)?.name ?? "Unknown"}
              </div>
            )}
            <AlertDialogFooter className="gap-2 sm:space-x-0">
              <AlertDialogCancel
                disabled={endActivation.isPending}
                className="border-slate-500 bg-slate-950 font-mono text-xs tracking-wide text-slate-100 hover:bg-slate-800"
                data-testid="button-cancel-end-activation"
              >
                cancel
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={endActivation.isPending}
                onClick={handleConfirmEndActivation}
                className="bg-amber-300 font-mono text-xs font-black tracking-wide text-black hover:bg-amber-200 disabled:bg-slate-700 disabled:text-slate-400"
                data-testid="button-confirm-end-activation"
              >
                confirm
              </AlertDialogAction>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={passAllFiringConfirmOpen}
        onOpenChange={(open) => {
          if (!passAllFiringPending) setPassAllFiringConfirmOpen(open);
        }}
      >
        <AlertDialogContent
          className="fixed max-h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] overflow-hidden border-2 border-yellow-300/90 bg-black p-0 text-yellow-50 shadow-[0_0_45px_rgba(250,204,21,0.32)] sm:max-w-md"
          data-testid="dialog-pass-all-firing-confirm"
        >
          <div
            className="absolute inset-0 opacity-35"
            style={{
              backgroundImage:
                "repeating-linear-gradient(135deg, #facc15 0 18px, #facc15 18px 34px, #020617 34px 52px, #020617 52px 68px)",
            }}
          />
          <div className="relative m-2 max-h-[calc(100dvh-2.5rem)] overflow-y-auto border border-yellow-300/60 bg-black/95 p-4 shadow-inner shadow-black sm:p-5">
            <AlertDialogHeader className="space-y-3 text-left">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-yellow-300/80 bg-yellow-300 text-black shadow-[0_0_18px_rgba(250,204,21,0.45)]">
                  <AlertTriangle className="h-6 w-6" />
                </div>
                <AlertDialogTitle className="font-mono text-lg uppercase tracking-[0.18em] text-yellow-200">
                  {passAllFiringLabel}?
                </AlertDialogTitle>
              </div>
              <AlertDialogDescription className="font-mono text-xs leading-relaxed text-yellow-100/85">
                {activationSegment === "fighter"
                  ? "This will end every remaining fighter-flight firing activation for your fleet. Your capital ships will remain available when Ship Firing begins."
                  : "This will end every remaining capital-ship firing activation for your fleet. No further ship weapons will be fired this phase."}{" "}
                No dice will be rolled, and the action cannot be undone after
                confirmation.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="my-4 border border-yellow-300/35 bg-yellow-300/10 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-yellow-100/90">
              Remaining eligible{" "}
              {activationSegment === "fighter" ? "fighter" : "ship"}{" "}
              activations: {myEligibleActivations}
            </div>
            <AlertDialogFooter className="gap-2 sm:space-x-0">
              <AlertDialogCancel
                disabled={passAllFiringPending}
                className="border-slate-500 bg-slate-950 font-mono text-xs uppercase tracking-widest text-slate-100 hover:bg-slate-800"
                data-testid="button-cancel-pass-all-firing"
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={passAllFiringPending}
                onClick={handlePassAllFiring}
                className="bg-yellow-300 font-mono text-xs font-black uppercase tracking-widest text-black hover:bg-yellow-200 disabled:bg-slate-700 disabled:text-slate-400"
                data-testid="button-confirm-pass-all-firing"
              >
                {passAllFiringPending
                  ? passAllFiringPendingLabel
                  : passAllFiringConfirmLabel}
              </AlertDialogAction>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={myDeclaredScoutSupportOpen}
        onOpenChange={() => {}}
      >
        <DialogContent
          className="border-cyan-500/60 bg-black/95 font-mono text-cyan-50 shadow-[0_0_45px_rgba(34,211,238,0.28)] sm:max-w-md"
          data-testid="dialog-declared-scout-support"
        >
          <DialogHeader>
            <DialogTitle className="text-sm uppercase tracking-[0.22em] text-cyan-200">
              Resolve Scout Support
            </DialogTitle>
            <DialogDescription className="text-xs text-cyan-100/75">
              {currentDeclaredScoutSupport?.unit.name ?? "Scout"} declared{" "}
              {currentDeclaredScoutSupport?.action === "coord"
                ? "Coordinate Fire"
                : "Counter-Stealth"}
              . Choose a legal target before weapons fire.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={!currentDeclaredScoutSupport || chooseScoutAction.isPending}
              onClick={() => {
                if (!currentDeclaredScoutSupport) return;
                setSelectedUnit(currentDeclaredScoutSupport.unit.id);
                setScoutPicking({
                  action: currentDeclaredScoutSupport.action,
                  scoutUnitId: currentDeclaredScoutSupport.unit.id,
                });
                setActivationFeedback(
                  `${currentDeclaredScoutSupport.action === "counter-stealth" ? "Counter-Stealth" : "Coordinate Fire"}: click an enemy target within 36".`,
                );
              }}
              className="justify-start border-cyan-500/45 bg-cyan-500/5 text-left font-mono text-cyan-100 hover:bg-cyan-500/15"
              data-testid="button-resolve-declared-scout"
            >
              Select Target On Board
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={skipScoutSupport.isPending || chooseScoutAction.isPending}
              onClick={() => skipScoutSupport.mutate()}
              className="justify-start font-mono text-slate-300 hover:bg-slate-800"
              data-testid="button-skip-declared-scout-support"
            >
              {skipScoutSupport.isPending ? "Skipping..." : "Skip Declared Scout Support"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={scoutFeedback !== null}
        onOpenChange={(open) => {
          if (!open) setScoutFeedback(null);
        }}
      >
        <DialogContent
          className="border-cyan-500/60 bg-black/95 font-mono text-cyan-50 sm:max-w-md"
          data-testid="dialog-scout-roll-result"
        >
          <DialogHeader>
            <DialogTitle
              className={`text-sm uppercase tracking-[0.22em] ${
                scoutFeedback?.success ? "text-cyan-200" : "text-red-200"
              }`}
            >
              {scoutFeedback?.success ? "Scout Support Succeeds" : "Scout Support Fails"}
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-300">
              {scoutFeedback?.scoutName ?? "Scout"} attempted{" "}
              {scoutFeedback?.action === "coord"
                ? "Coordinate Fire"
                : "Counter-Stealth"}
              .
            </DialogDescription>
          </DialogHeader>
          {scoutFeedback && (
            <div
              className={`rounded border px-3 py-3 text-sm ${
                scoutFeedback.success
                  ? "border-cyan-500/45 bg-cyan-500/10 text-cyan-100"
                  : "border-red-500/45 bg-red-500/10 text-red-100"
              }`}
            >
              {scoutFeedback.cqRoll !== null &&
              scoutFeedback.cqTotal !== null &&
              scoutFeedback.cqRequired !== null ? (
                <>
                  Roll {scoutFeedback.cqRoll} + CQ{" "}
                  {scoutFeedback.crewQuality} = {scoutFeedback.cqTotal} vs{" "}
                  {scoutFeedback.cqRequired}+
                </>
              ) : scoutFeedback.error ? (
                scoutFeedback.error
              ) : (
                "No roll data returned."
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              onClick={() => setScoutFeedback(null)}
              className="font-mono"
              data-testid="button-close-scout-roll-result"
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {activeSelfRepairPrompt && (
        <div
          className="fixed left-1/2 top-20 z-[65] w-[min(18rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded border border-sky-300/55 bg-black/90 p-3 text-center shadow-2xl shadow-sky-950/40 backdrop-blur"
          data-testid="self-repair-prompt"
        >
          <div className="font-mono text-sm font-bold uppercase tracking-[0.18em] text-sky-100">
            Repair {activeSelfRepairPrompt.unitName}?
          </div>
          <div className="mt-3 flex justify-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => repairFromSelfRepairPrompt(activeSelfRepairPrompt)}
              className="bg-sky-300 font-mono text-xs font-black uppercase tracking-widest text-black hover:bg-sky-200"
              data-testid="button-self-repair-prompt-repair"
            >
              Repair
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => skipSelfRepairPrompt(activeSelfRepairPrompt)}
              className="border-slate-600 bg-slate-950 font-mono text-xs uppercase tracking-widest text-slate-100 hover:bg-slate-800"
              data-testid="button-self-repair-prompt-skip"
            >
              Skip
            </Button>
          </div>
        </div>
      )}

      <ShipStatusInspectorDialog
        open={inspectedUnitData !== null}
        onOpenChange={(open) => {
          if (!open) setInspectedUnitId(null);
        }}
        unit={inspectedUnitData}
        model={inspectedShipModel}
        weapons={inspectedUnitWeapons}
        myUserId={myUserId}
        currentRound={currentRoundNumber}
        isFighter={inspectedUnitIsFighter}
        dogfightLocked={inspectedUnitDogfightLocked}
      />

      {diceModal && (
        <DiceRollModal
          modal={diceModal}
          setModal={setDiceModal}
          pcHoverHintsEnabled={pcHoverHintsEnabled}
          onCommitShot={commitStagedShot}
          onCancelBeforeRoll={(modal) => {
            setFiringWeaponPicking(modal.weapon.id);
            setDiceModal(null);
          }}
          onClose={() => {
            // The shot was already applied authoritatively on the server,
            // but we deliberately deferred the cache invalidation so the
            // board didn't reveal the outcome before the player rolled.
            // Refresh now that the dice modal is dismissed.
            qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
            setDiceModal(null);
          }}
        />
      )}
      {dogfightModal && (
        <DogfightResultModal
          modal={dogfightModal}
          onClose={() => {
            qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
            setDogfightModal(null);
          }}
        />
      )}
      {terrainHazardModal && (
        <TerrainHazardDiceModal
          modal={terrainHazardModal}
          setModal={setTerrainHazardModal}
          onClose={() => {
            qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
            setTerrainHazardModal(null);
          }}
        />
      )}
      {splitFireResultModal && (
        <SplitFireResultModal
          modal={splitFireResultModal}
          setModal={setSplitFireResultModal}
          onClose={() => {
            qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
            setSplitFireResultModal(null);
          }}
        />
      )}
      {selfRepairModal && (
        <SelfRepairDiceModal
          modal={selfRepairModal}
          setModal={setSelfRepairModal}
          onRoll={commitSelfRepair}
          onClose={() => {
            qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
            setSelfRepairModal(null);
          }}
        />
      )}
    </Layout>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Dice roll modal — plays a brief shuffle animation, then reveals the server's
// authoritative attack rolls / hits / damage / crits.
// ─────────────────────────────────────────────────────────────────────────────
function DiceFace({
  value,
  rolling,
  tone = "default",
}: {
  value: number;
  rolling: boolean;
  tone?: "default" | "bulkhead" | "solid" | "crit";
}) {
  const [display, setDisplay] = useState<number>(value);
  useEffect(() => {
    if (!rolling) {
      setDisplay(value);
      return;
    }
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last > 80) {
        setDisplay(1 + Math.floor(Math.random() * 6));
        last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [rolling, value]);
  const toneClass =
    tone === "bulkhead"
      ? "border-red-500/80 text-red-200 shadow-[0_0_8px_rgba(239,68,68,0.35)]"
      : tone === "solid"
        ? "border-green-400/80 text-green-200 shadow-[0_0_8px_rgba(74,222,128,0.3)]"
        : tone === "crit"
          ? "border-sky-300/90 text-sky-100 shadow-[0_0_10px_rgba(125,211,252,0.4)]"
          : "border-amber-500/60 text-amber-300";
  return (
    <span
      className={`inline-flex items-center justify-center w-9 h-9 rounded border bg-black/60 font-mono text-lg font-bold tabular-nums ${toneClass}`}
    >
      {display}
    </span>
  );
}

function TerrainHazardDiceModal({
  modal,
  setModal,
  onClose,
}: {
  modal: TerrainHazardModalState;
  setModal: React.Dispatch<
    React.SetStateAction<TerrainHazardModalState | null>
  >;
  onClose: () => void;
}) {
  const { unitName, hazards, phase, confirmingClose } = modal;
  const rolling = phase === "rolling";
  const requestClose = () =>
    setModal((m) => (m ? { ...m, confirmingClose: true } : null));
  const cancelClose = () =>
    setModal((m) => (m ? { ...m, confirmingClose: false } : null));
  const failedCount = hazards.filter((hazard) => !hazard.passed).length;
  const totalDamage = hazards.reduce((sum, hazard) => sum + hazard.damage, 0);
  const totalCrew = hazards.reduce((sum, hazard) => sum + hazard.crewLost, 0);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 px-4"
      role="dialog"
      aria-modal="true"
      data-testid="terrain-hazard-dice-modal"
    >
      <div className="relative max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto rounded border border-orange-400/60 bg-slate-950/95 p-4 shadow-2xl shadow-orange-950/40">
        <button
          type="button"
          onClick={requestClose}
          className="absolute right-3 top-3 rounded border border-slate-600 bg-slate-900 px-2 py-0.5 font-mono text-xs text-slate-200 hover:bg-slate-800"
          aria-label="Close terrain hazard result"
        >
          X
        </button>

        <div className="pr-8">
          <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-orange-300/80">
            Movement Hazard
          </div>
          <div className="mt-1 font-mono text-lg font-black uppercase text-orange-100">
            Damaging Terrain
          </div>
          <p className="mt-1 font-mono text-xs text-slate-300">
            {unitName} moved through {hazards.length === 1 ? hazards[0]?.fieldName : `${hazards.length} terrain fields`}.
          </p>
        </div>

        <div className="mt-4 space-y-3">
          {hazards.map((hazard) => (
            <div
              key={hazard.fieldId}
              className="rounded border border-orange-400/30 bg-black/45 p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-wider text-orange-200/80">
                    {hazard.fieldName}
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-slate-400">
                    {hazard.inchesInside}" cumulative through field
                    {hazard.segmentInchesInside != null &&
                    Math.abs(hazard.segmentInchesInside - hazard.inchesInside) > 0.01
                      ? ` (${hazard.segmentInchesInside}" this segment)`
                      : ""}
                    {" - "}density {hazard.density}
                  </div>
                </div>
                <div
                  className={`rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${
                    hazard.passed
                      ? "border-emerald-400/40 text-emerald-200"
                      : "border-red-400/50 text-red-200"
                  }`}
                >
                  {rolling
                    ? "Rolling"
                    : hazard.automaticFailure
                      ? "Automatic Impact"
                      : hazard.passed
                      ? "Check Passed"
                      : "Check Failed"}
                </div>
              </div>

              <div className="mt-3">
                <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                  {hazard.automaticFailure
                    ? "Adrift ship - density check automatically failed"
                    : `Density Check - 1D6 + CQ need ${hazard.density}+`}
                </div>
                {!hazard.automaticFailure && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {hazard.checkRolls.map((roll, idx) => (
                      <DiceFace
                        key={`${hazard.fieldId}-check-${idx}`}
                        value={roll}
                        rolling={rolling}
                        tone={hazard.passed ? "solid" : "bulkhead"}
                      />
                    ))}
                    <span className="font-mono text-xs font-semibold text-slate-400">
                      + CQ {hazard.crewQuality ?? 0}
                    </span>
                    <span className="font-mono text-sm font-bold text-slate-200">
                      {rolling ? "..." : `= ${hazard.checkTotal}`}
                    </span>
                  </div>
                )}
              </div>

              {!hazard.passed && (
                <div className="mt-4">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                    Asteroid Attack - {hazard.attackDice}AD vs Hull {hazard.hitThreshold}+ - Super AP, Triple Damage
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {hazard.attackRolls.map((roll, idx) => (
                      <DiceFace
                        key={`${hazard.fieldId}-attack-${idx}`}
                        value={roll}
                        rolling={rolling}
                        tone={roll >= hazard.hitThreshold ? "crit" : "default"}
                      />
                    ))}
                    {hazard.attackRolls.length === 0 && (
                      <span className="font-mono text-xs text-slate-500">
                        No attack dice rolled.
                      </span>
                    )}
                  </div>
                  {(hazard.dodgeRolls?.length ?? 0) > 0 && (
                    <div className="mt-3">
                      <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                        Dodge - {hazard.dodgesSuccessful ?? 0} avoided
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {hazard.dodgeRolls?.map((roll, idx) => (
                          <DiceFace
                            key={`${hazard.fieldId}-dodge-${idx}`}
                            value={roll}
                            rolling={rolling}
                            tone="solid"
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  {(hazard.attackTableRolls?.length ?? 0) > 0 && (
                    <div className="mt-3">
                      <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                        Attack Table - {hazard.bulkheadHits ?? 0} bulkhead, {hazard.solidHits ?? 0} solid, {hazard.criticalHits ?? 0} critical
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {hazard.attackTableRolls?.map((roll, idx) => (
                          <DiceFace
                            key={`${hazard.fieldId}-table-${idx}`}
                            value={roll}
                            rolling={rolling}
                            tone={roll === 1 ? "bulkhead" : roll === 6 ? "crit" : "solid"}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="mt-2 font-mono text-xs text-slate-200">
                    {rolling
                      ? "Resolving impact..."
                      : `${hazard.hits} hit(s), ${hazard.dodgesSuccessful ?? 0} dodged, ${hazard.shieldedHits ?? 0} shielded, ${hazard.damage} damage, ${hazard.crewLost} crew`}
                  </div>
                  {!rolling && hazard.damageTable && (
                    <div className="mt-1 font-mono text-[10px] text-orange-200/90">
                      Hull zero table: d6 {hazard.damageTable.roll} + overkill {hazard.damageTable.overkill} = {hazard.damageTable.total}, {hazard.damageTable.outcome}.
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {!rolling && (
          <div className="mt-4 rounded border border-slate-700 bg-slate-900/70 p-3 font-mono text-xs text-slate-200">
            {failedCount === 0
              ? "All terrain checks passed."
              : `Terrain caused ${totalDamage} damage and ${totalCrew} crew loss.`}
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <Button
            type="button"
            onClick={requestClose}
            disabled={rolling}
            className="font-mono uppercase tracking-widest"
            data-testid="button-close-terrain-hazard-modal"
          >
            {rolling ? "Rolling..." : "Continue"}
          </Button>
        </div>

        {confirmingClose && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/75 p-4">
            <div className="w-full max-w-sm rounded border border-orange-400/50 bg-slate-950 p-4 text-center shadow-2xl">
              <div className="font-mono text-sm font-bold text-orange-100">
                Close terrain dice?
              </div>
              <p className="mt-2 font-mono text-xs text-slate-300">
                The result is already recorded in the battle log.
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="font-mono"
                  onClick={cancelClose}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  className="font-mono"
                  onClick={onClose}
                >
                  Close
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DogfightResultModal({
  modal,
  onClose,
}: {
  modal: DogfightModalState;
  onClose: () => void;
}) {
  const { result, phase } = modal;
  const rolling = phase === "rolling";
  const requestClose = () => {
    if (!rolling) onClose();
  };
  const winnerName = result.tied
    ? null
    : result.destroyedUnitId === result.targetUnitId
      ? result.attackerName
      : result.targetName;
  const loserName = result.tied
    ? null
    : result.destroyedUnitId === result.targetUnitId
      ? result.targetName
      : result.attackerName;
  const formatSupport = (supporters?: Array<{ id: number; name: string }>) =>
    supporters && supporters.length > 0
      ? supporters.map((s) => s.name).join(", ")
      : "None";
  const scoreLine = (
    roll: number,
    dogfight: number,
    fleetCarrier = 0,
    support = 0,
    total: number,
  ) => {
    const parts = [`roll ${roll}`, `dogfight ${dogfight}`];
    if (fleetCarrier) parts.push(`fleet carrier +${fleetCarrier}`);
    if (support) parts.push(`support +${support}`);
    return `${parts.join(" + ")} = ${total}`;
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 px-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-lg rounded border border-fuchsia-400/60 bg-slate-950/95 p-4 shadow-2xl shadow-fuchsia-950/40">
        <button
          type="button"
          onClick={requestClose}
          className="absolute right-3 top-3 rounded border border-slate-600 bg-slate-900 px-2 py-0.5 font-mono text-xs text-slate-200 hover:bg-slate-800"
          aria-label="Close dogfight result"
        >
          X
        </button>
        <div className="pr-8">
          <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-fuchsia-300/80">
            Fighter Combat
          </div>
          <div className="mt-1 font-mono text-lg font-black uppercase text-fuchsia-100">
            Dogfight
          </div>
          <p className="mt-1 font-mono text-xs text-slate-300">
            {result.attackerName} vs {result.targetName}
          </p>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded border border-fuchsia-400/30 bg-black/45 p-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-fuchsia-200/80">
              {result.attackerName}
            </div>
            <div className="mt-2 flex items-center gap-3">
              <DiceFace value={result.attackerRoll} rolling={rolling} />
              <div className="font-mono text-sm font-bold text-fuchsia-100">
                {rolling ? "Rolling..." : result.attackerScore}
              </div>
            </div>
            <div className="mt-2 font-mono text-[10px] text-slate-300">
              {scoreLine(
                result.attackerRoll,
                result.attackerDogfight,
                result.attackerFleetCarrierBonus ?? 0,
                result.attackerSupportBonus ?? 0,
                result.attackerScore,
              )}
            </div>
            <div className="mt-1 font-mono text-[10px] text-slate-500">
              Support: {formatSupport(result.attackerSupporters)}
            </div>
          </div>
          <div className="rounded border border-red-400/30 bg-black/45 p-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-red-200/80">
              {result.targetName}
            </div>
            <div className="mt-2 flex items-center gap-3">
              <DiceFace value={result.targetRoll} rolling={rolling} />
              <div className="font-mono text-sm font-bold text-red-100">
                {rolling ? "Rolling..." : result.targetScore}
              </div>
            </div>
            <div className="mt-2 font-mono text-[10px] text-slate-300">
              {scoreLine(
                result.targetRoll,
                result.targetDogfight,
                result.targetFleetCarrierBonus ?? 0,
                result.targetSupportBonus ?? 0,
                result.targetScore,
              )}
            </div>
            <div className="mt-1 font-mono text-[10px] text-slate-500">
              Support: {formatSupport(result.targetSupporters)}
            </div>
          </div>
        </div>

        <div className="mt-4 rounded border border-slate-700 bg-slate-900/70 px-3 py-2 font-mono text-xs text-slate-200">
          {rolling
            ? "Resolving dogfight..."
            : result.tied
              ? "Tie. Fighters remain locked in dogfight."
              : `${winnerName} wins. ${loserName} is destroyed.`}
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            size="sm"
            onClick={requestClose}
            disabled={rolling}
            className="bg-fuchsia-300 font-mono text-xs font-black uppercase tracking-widest text-black hover:bg-fuchsia-200"
            data-testid="button-close-dogfight-modal"
          >
            Close
          </Button>
        </div>

      </div>
    </div>
  );
}

function SplitFireResultModal({
  modal,
  setModal,
  onClose,
}: {
  modal: SplitFireResultModalState;
  setModal: React.Dispatch<
    React.SetStateAction<SplitFireResultModalState | null>
  >;
  onClose: () => void;
}) {
  const requestClose = () => {
    setModal((m) => (m ? { ...m, confirmingClose: true } : m));
  };
  const cancelClose = () =>
    setModal((m) => (m ? { ...m, confirmingClose: false } : m));
  const confirmClose = () => onClose();

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 px-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-lg rounded border border-sky-400/50 bg-slate-950/95 p-4 shadow-2xl shadow-sky-950/40">
        <button
          type="button"
          onClick={requestClose}
          className="absolute right-3 top-3 rounded border border-slate-600 bg-slate-900 px-2 py-0.5 font-mono text-xs text-slate-200 hover:bg-slate-800"
          aria-label="Close split fire result"
        >
          X
        </button>
        <div className="pr-8">
          <div className="text-[10px] uppercase tracking-[0.18em] text-sky-300/80 font-mono">
            Split Fire
          </div>
          <div className="mt-1 text-lg font-bold text-sky-100 font-mono">
            {modal.weapon.name || modal.weapon.arc}
          </div>
        </div>
        <div className="mt-4 grid gap-2">
          {modal.allocations.map((allocation, index) => {
            const result = allocation.result as FireWeaponResult & {
              hits?: number;
              totalDamage?: number;
              crewLost?: number;
              criticalHits?: number;
              targetHullBefore?: number;
              targetHullAfter?: number;
              targetCrewBefore?: number;
              targetCrewAfter?: number;
              targetDestroyed?: boolean;
            };
            return (
              <div
                key={`${allocation.targetId}-${index}`}
                className="rounded border border-slate-600 bg-black/35 px-3 py-2 font-mono"
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-bold text-sky-100">
                    {allocation.targetName}
                  </span>
                  <span className="text-sky-300">
                    {allocation.attackDice}AD
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-4 gap-1 text-center text-[10px] uppercase tracking-wider">
                  <div className="rounded border border-slate-700 bg-slate-900/70 px-1 py-1">
                    <div className="text-slate-400">Hits</div>
                    <div className="text-sm font-bold text-amber-200">
                      {result.hits ?? 0}
                    </div>
                  </div>
                  <div className="rounded border border-slate-700 bg-slate-900/70 px-1 py-1">
                    <div className="text-slate-400">Damage</div>
                    <div className="text-sm font-bold text-red-200">
                      {result.totalDamage ?? 0}
                    </div>
                  </div>
                  <div className="rounded border border-slate-700 bg-slate-900/70 px-1 py-1">
                    <div className="text-slate-400">Crew</div>
                    <div className="text-sm font-bold text-orange-200">
                      {result.crewLost ?? 0}
                    </div>
                  </div>
                  <div className="rounded border border-slate-700 bg-slate-900/70 px-1 py-1">
                    <div className="text-slate-400">Crits</div>
                    <div className="text-sm font-bold text-sky-200">
                      {result.criticalHits ?? 0}
                    </div>
                  </div>
                </div>
                <div className="mt-2 text-[10px] text-slate-300">
                  Hull {result.targetHullBefore ?? "?"}
                  {" -> "}
                  {result.targetHullAfter ?? "?"} · Crew{" "}
                  {result.targetCrewBefore ?? "?"}
                  {" -> "}
                  {result.targetCrewAfter ?? "?"}
                  {result.targetDestroyed ? (
                    <span className="text-red-300"> · Destroyed</span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            type="button"
            onClick={requestClose}
            className="bg-sky-300 text-black hover:bg-sky-200 font-mono text-xs uppercase tracking-widest"
          >
            Close
          </Button>
        </div>
        {modal.confirmingClose && (
          <div className="absolute inset-0 flex items-center justify-center rounded bg-black/70 p-4">
            <div className="w-full max-w-sm rounded border border-amber-400/60 bg-slate-950 p-3 text-center shadow-xl">
              <div className="font-mono text-sm font-bold text-amber-200">
                Close split fire results?
              </div>
              <div className="mt-3 flex justify-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={cancelClose}
                  className="border-slate-500 bg-slate-950 text-slate-100 hover:bg-slate-800 font-mono text-xs"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={confirmClose}
                  className="bg-amber-300 text-black hover:bg-amber-200 font-mono text-xs"
                >
                  Close
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SelfRepairDiceModal({
  modal,
  setModal,
  onRoll,
  onClose,
}: {
  modal: SelfRepairModalState;
  setModal: React.Dispatch<React.SetStateAction<SelfRepairModalState | null>>;
  onRoll: (modal: SelfRepairModalState) => void;
  onClose: () => void;
}) {
  const rolling = modal.phase === "rolling";
  const shown = modal.phase === "shown";
  const error = modal.phase === "error";
  const displayRolls =
    shown && modal.rolls?.length
      ? modal.rolls
      : Array.from({ length: modal.dice }, () => 1);

  const requestClose = () => {
    if (rolling) return;
    if (shown) {
      setModal((m) => (m ? { ...m, confirmingClose: true } : m));
      return;
    }
    onClose();
  };
  const cancelClose = () =>
    setModal((m) => (m ? { ...m, confirmingClose: false } : m));
  const confirmClose = () => onClose();

  const footer = (() => {
    if (modal.phase === "ready") {
      return {
        label: `Roll Self Repair - ${modal.dice}D`,
        disabled: false,
        onClick: () => onRoll(modal),
        testid: "button-roll-self-repair",
      };
    }
    if (rolling) {
      return {
        label: "Rolling...",
        disabled: true,
        onClick: () => {},
        testid: "button-self-repair-rolling",
      };
    }
    return {
      label: "Close",
      disabled: false,
      onClick: requestClose,
      testid: "button-close-self-repair",
    };
  })();

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 px-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-md rounded border border-sky-400/50 bg-slate-950/95 p-4 shadow-2xl shadow-sky-950/40">
        <button
          type="button"
          onClick={requestClose}
          disabled={rolling}
          className="absolute right-3 top-3 rounded border border-slate-600 bg-slate-900 px-2 py-0.5 font-mono text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40"
          aria-label="Close Self Repair roll"
        >
          X
        </button>
        <div className="pr-8">
          <div className="text-[10px] uppercase tracking-[0.18em] text-sky-300/80 font-mono">
            End Phase
          </div>
          <h2 className="mt-1 font-mono text-lg font-black uppercase text-sky-100">
            Self Repair
          </h2>
          <p className="mt-1 font-mono text-xs text-slate-300">
            {modal.unitName}
          </p>
        </div>

        <div className="mt-4 rounded border border-sky-500/30 bg-sky-500/10 p-3">
          <div className="flex flex-wrap gap-2">
            {displayRolls.map((roll, idx) => (
              <DiceFace key={idx} value={roll} rolling={rolling} tone="solid" />
            ))}
          </div>
          {shown && (
            <div className="mt-3 space-y-1 font-mono text-xs text-sky-100">
              <div>
                Total rolled:{" "}
                <span className="font-bold text-white">{modal.total}</span>
              </div>
              <div>
                Hull restored:{" "}
                <span className="font-bold text-white">{modal.repaired}</span>
              </div>
              <div>
                Hull:{" "}
                <span className="font-bold text-white">
                  {modal.hullBefore} -&gt; {modal.hullAfter}
                </span>
              </div>
            </div>
          )}
          {error && (
            <div className="mt-3 rounded border border-red-500/50 bg-red-500/10 px-2 py-1.5 font-mono text-xs text-red-200">
              {modal.error ?? "Self Repair failed"}
            </div>
          )}
          {modal.phase === "ready" && (
            <p className="mt-3 font-mono text-xs text-slate-300">
              Roll {modal.dice}d6 and restore that many hull points, capped at
              the ship's maximum hull.
            </p>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          {modal.phase === "ready" && (
            <Button
              variant="outline"
              size="sm"
              onClick={requestClose}
              className="border-slate-600 bg-slate-900 font-mono text-xs uppercase text-slate-100 hover:bg-slate-800"
              data-testid="button-cancel-self-repair"
            >
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            disabled={footer.disabled}
            onClick={footer.onClick}
            className="bg-sky-300 font-mono text-xs font-black uppercase text-black hover:bg-sky-200 disabled:bg-slate-700 disabled:text-slate-400"
            data-testid={footer.testid}
          >
            {footer.label}
          </Button>
        </div>

        {modal.confirmingClose && (
          <div className="absolute inset-0 flex items-center justify-center rounded bg-black/70 p-4">
            <div className="w-full max-w-xs rounded border border-sky-400/60 bg-slate-950 p-3 text-center shadow-xl">
              <div className="font-mono text-sm font-bold uppercase text-sky-100">
                Close repair roll?
              </div>
              <div className="mt-1 font-mono text-xs text-slate-300">
                The hull repair has already been applied.
              </div>
              <div className="mt-3 flex justify-center">
                <Button
                  size="sm"
                  onClick={confirmClose}
                  className="bg-sky-300 font-mono text-xs font-black uppercase text-black hover:bg-sky-200"
                >
                  Close
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function attackTableOutcomeLabel(raw: number, effective: number): string {
  const adjusted = effective !== raw ? `Precise ${raw}->${effective} - ` : "";
  if (effective <= 1) return `${adjusted}Bulkhead`;
  if (effective <= 5) return `${adjusted}Solid`;
  return `${adjusted}Crit`;
}

function DiceRollModal({
  modal,
  setModal,
  pcHoverHintsEnabled,
  onCommitShot,
  onCancelBeforeRoll,
  onClose,
}: {
  modal: DiceModalState;
  setModal: React.Dispatch<React.SetStateAction<DiceModalState | null>>;
  pcHoverHintsEnabled: boolean;
  onCommitShot: (modal: DiceModalState) => void;
  onCancelBeforeRoll: (modal: DiceModalState) => void;
  onClose: () => void;
}) {
  const {
    weapon,
    targetName,
    attackDice,
    phase,
    result,
    error,
    confirmingClose,
    critIndex,
  } = modal;
  const attackRolling = phase === "attack-rolling";
  const damageRolling = phase === "damage-rolling";
  const critRolling = phase === "crit-rolling";
  // Show attack dice once we've started rolling them; before that they're hidden.
  const attackVisible =
    phase !== "target-picked" &&
    phase !== "pending" &&
    phase !== "attack-ready" &&
    phase !== "error";
  // Show damage dice once we've started rolling them. They persist through the
  // per-crit reveal so the player keeps the context of where each crit came from.
  const damageVisible =
    phase === "damage-rolling" ||
    phase === "damage-shown" ||
    phase === "crit-ready" ||
    phase === "crit-rolling" ||
    phase === "crit-shown";
  // Crit reveal panel: only after the first crit roll has started.
  const critVisible = phase === "crit-rolling" || phase === "crit-shown";
  const crits = result?.criticalsApplied ?? [];
  const hasCrits = crits.length > 0;
  const ancientSuppressedCrits = result
    ? Math.max(0, (result.criticalHits ?? 0) - crits.length)
    : 0;
  const damageDiceCount = result?.damageRolls.length ?? 0;
  const hasDamageDice = damageDiceCount > 0;
  // Final summary only after the entire reveal is done (last crit shown,
  // or damage-shown with no crits, or attack-shown with no damage dice).
  const summaryVisible =
    (phase === "crit-shown" &&
      critIndex !== undefined &&
      critIndex >= crits.length - 1) ||
    (phase === "damage-shown" && !hasCrits) ||
    (phase === "attack-shown" && result !== undefined && !hasDamageDice);

  const rolls =
    result?.attackRolls ?? Array.from({ length: attackDice }, () => 0);
  const rollKinds = result?.attackRollKinds ?? [];
  const rolledAttackDice = result
    ? rollKinds.filter((kind) => kind === "normal").length
    : attackDice;
  const interceptedAttackDice = result?.interceptedHits ?? 0;
  const hasStealthCheck = result?.stealthCheckTarget != null;
  const rawHitThreshold = result?.hitThreshold;
  const stealthCheckUnresolved =
    hasStealthCheck && (attackRolling || !result?.stealthCheckPassed);
  const hitThreshold = stealthCheckUnresolved ? undefined : rawHitThreshold;
  const attackThresholdLabel = stealthCheckUnresolved
    ? "pending stealth"
    : rawHitThreshold
      ? `need ${rawHitThreshold}+`
      : "";

  // ── Stage transitions ──
  // Roll-to-hit: attack-ready → attack-rolling (animate ~700ms) → attack-shown.
  const handleCommitShot = () => {
    if (phase !== "target-picked") return;
    onCommitShot(modal);
  };

  const handleRollAttack = () => {
    setModal((m) => (m ? { ...m, phase: "attack-rolling" } : null));
    setTimeout(() => {
      setModal((m) =>
        m && m.phase === "attack-rolling" ? { ...m, phase: "attack-shown" } : m,
      );
    }, 700);
  };
  // Roll-damage: damage-ready → damage-rolling → damage-shown.
  const handleRollDamage = () => {
    setModal((m) => (m ? { ...m, phase: "damage-rolling" } : null));
    setTimeout(() => {
      setModal((m) =>
        m && m.phase === "damage-rolling" ? { ...m, phase: "damage-shown" } : m,
      );
    }, 700);
  };
  // Attack-shown → if any hits queue damage-ready, otherwise this is terminal
  // and the close button takes over (no damage to roll).
  const handleProceedToDamage = () => {
    setModal((m) => (m ? { ...m, phase: "damage-ready" } : null));
  };
  // Damage-shown → if any crits queue per-crit reveal, otherwise terminal.
  const handleProceedToCrits = () => {
    setModal((m) => (m ? { ...m, phase: "crit-ready", critIndex: 0 } : null));
  };
  // Crit-ready (or crit-shown for non-last) → start rolling the next crit.
  const handleRollCrit = () => {
    setModal((m) => {
      if (!m) return null;
      // If we're advancing from a previously-shown crit, bump the index.
      const nextIdx =
        m.phase === "crit-shown" ? (m.critIndex ?? 0) + 1 : (m.critIndex ?? 0);
      return { ...m, phase: "crit-rolling", critIndex: nextIdx };
    });
    setTimeout(() => {
      setModal((m) =>
        m && m.phase === "crit-rolling" ? { ...m, phase: "crit-shown" } : m,
      );
    }, 700);
  };
  // Close flow always passes through a confirm step so the player can't lose
  // the result by misclicking the backdrop or the corner X. Final confirm
  // delegates to the parent so it can invalidate the game query (deferred
  // until close so the board doesn't reveal damage before the dice roll).
  const requestClose = () => {
    if (phase === "target-picked") {
      onCancelBeforeRoll(modal);
      return;
    }
    setModal((m) => (m ? { ...m, confirmingClose: true } : null));
  };
  const cancelClose = () =>
    setModal((m) => (m ? { ...m, confirmingClose: false } : null));
  const confirmClose = () => onClose();

  // The footer button is contextual based on phase. Disabled while shuffles play.
  const footer = (() => {
    if (phase === "target-picked") {
      return {
        label: `Roll to Hit - ${attackDice}D`,
        onClick: handleCommitShot,
        testid: "button-commit-shot",
        disabled: false,
      };
    }
    if (phase === "error") {
      return {
        label: "Close",
        onClick: requestClose,
        testid: "button-close-dice-modal",
        disabled: false,
      };
    }
    if (phase === "pending") {
      return {
        label: "Resolving…",
        onClick: () => {},
        testid: "button-pending",
        disabled: true,
      };
    }
    if (phase === "attack-ready") {
      return {
        label: `Roll to Hit · ${rolledAttackDice}D`,
        onClick: handleRollAttack,
        testid: "button-roll-attack",
        disabled: false,
      };
    }
    if (phase === "attack-rolling") {
      return {
        label: "Rolling…",
        onClick: () => {},
        testid: "button-rolling-attack",
        disabled: true,
      };
    }
    if (phase === "attack-shown") {
      if (result && damageDiceCount > 0) {
        return {
          label: `Roll Damage · ${damageDiceCount}D`,
          onClick: handleProceedToDamage,
          testid: "button-proceed-damage",
          disabled: false,
        };
      }
      return {
        label: "Close",
        onClick: requestClose,
        testid: "button-close-dice-modal",
        disabled: false,
      };
    }
    if (phase === "damage-ready") {
      return {
        label: `Roll Damage · ${damageDiceCount}D`,
        onClick: handleRollDamage,
        testid: "button-roll-damage",
        disabled: false,
      };
    }
    if (phase === "damage-rolling") {
      return {
        label: "Rolling…",
        onClick: () => {},
        testid: "button-rolling-damage",
        disabled: true,
      };
    }
    if (phase === "damage-shown") {
      if (hasCrits) {
        return {
          label: `Roll Crits · ${crits.length}`,
          onClick: handleProceedToCrits,
          testid: "button-proceed-crits",
          disabled: false,
        };
      }
      return {
        label: "Close",
        onClick: requestClose,
        testid: "button-close-dice-modal",
        disabled: false,
      };
    }
    if (phase === "crit-ready") {
      const idx = (critIndex ?? 0) + 1;
      return {
        label: `Roll Crit ${idx} of ${crits.length}`,
        onClick: handleRollCrit,
        testid: "button-roll-crit",
        disabled: false,
      };
    }
    if (phase === "crit-rolling") {
      return {
        label: "Rolling…",
        onClick: () => {},
        testid: "button-rolling-crit",
        disabled: true,
      };
    }
    if (phase === "crit-shown") {
      const cur = critIndex ?? 0;
      if (cur < crits.length - 1) {
        return {
          label: `Roll Crit ${cur + 2} of ${crits.length}`,
          onClick: handleRollCrit,
          testid: "button-roll-next-crit",
          disabled: false,
        };
      }
      return {
        label: "Close",
        onClick: requestClose,
        testid: "button-close-dice-modal",
        disabled: false,
      };
    }
    // Fallback (unreachable in normal flow): treat as terminal.
    return {
      label: "Close",
      onClick: requestClose,
      testid: "button-close-dice-modal",
      disabled: false,
    };
  })();

  // ── Free-floating, draggable panel ──
  // No backdrop — the battlefield underneath stays visible AND clickable so
  // the player can watch a fresh shot fly while the previous dice result is
  // still on screen. The header bar is the drag handle; position is clamped
  // to the viewport on every move and on window resize so the panel can't
  // get marooned offscreen.
  const PANEL_W = 448; // ~max-w-md
  const PANEL_H_ESTIMATE = 360; // generous; only used for initial clamp
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    if (typeof window === "undefined") return { x: 100, y: 80 };
    return { x: Math.max(16, window.innerWidth - PANEL_W - 24), y: 80 };
  });
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const clamp = useCallback((x: number, y: number) => {
    if (typeof window === "undefined") return { x, y };
    const h = panelRef.current?.offsetHeight ?? PANEL_H_ESTIMATE;
    const w = panelRef.current?.offsetWidth ?? PANEL_W;
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - h);
    return {
      x: Math.min(Math.max(0, x), maxX),
      y: Math.min(Math.max(0, y), maxY),
    };
  }, []);

  useEffect(() => {
    const onResize = () => setPos((p) => clamp(p.x, p.y));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Ignore drags initiated on interactive controls inside the header (X button, etc.).
    if ((e.target as HTMLElement).closest("button")) return;
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    setPos(
      clamp(e.clientX - dragRef.current.dx, e.clientY - dragRef.current.dy),
    );
  };
  const onHeaderPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
  };

  return (
    <div
      ref={panelRef}
      className="fixed z-50 flex w-[calc(100vw-1rem)] max-w-md flex-col overflow-hidden rounded-md border border-amber-500/40 bg-card p-3 shadow-2xl sm:p-5"
      style={{
        left: pos.x,
        top: pos.y,
        maxHeight:
          "calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 1rem)",
      }}
      data-testid="dice-modal"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Corner X — routes through confirm-close. */}
      <button
        type="button"
        data-testid="button-x-dice-modal"
        aria-label="Close"
        className="absolute top-2 right-2 text-amber-400/60 hover:text-amber-300 font-mono text-sm w-7 h-7 flex items-center justify-center z-10"
        onClick={requestClose}
      >
        ✕
      </button>

      {/* Header doubles as drag handle. */}
      <div
        className="mb-3 flex shrink-0 cursor-move touch-none select-none items-center justify-between pr-7"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
        data-testid="dice-modal-drag-handle"
        title="Drag to move"
      >
        <div>
          <p className="text-[10px] uppercase tracking-widest text-amber-400/70 font-mono flex items-center gap-1.5">
            <span className="inline-block w-3 text-amber-400/50">⋮⋮</span>{" "}
            Firing
          </p>
          <p className="text-sm font-mono font-bold text-amber-300">
            {weapon.name || weapon.arc} → {targetName}
          </p>
        </div>
        <p className="text-[10px] font-mono text-muted-foreground">
          {attackDice}AD · r{weapon.range}" · {weapon.arc}
        </p>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1"
        data-testid="dice-modal-content"
      >
        {phase === "target-picked" && (
          <div
            className="space-y-3 py-4 text-center"
            data-testid="target-picked-prompt"
          >
            <div className="text-sm font-mono text-amber-300">
              Target selected. No dice have been rolled yet.
            </div>
            <div className="text-[11px] font-mono text-muted-foreground">
              Roll to commit this shot, or pick a different target.
            </div>
            <Button
              type="button"
              variant="outline"
              className="border-amber-500/40 uppercase tracking-widest text-xs"
              data-testid="button-change-target"
              onClick={() => onCancelBeforeRoll(modal)}
            >
              Change Target
            </Button>
          </div>
        )}

        {phase === "error" && (
          <div
            className="text-sm font-mono text-red-400 py-4 text-center"
            data-testid="dice-error"
          >
            ✕ {error}
          </div>
        )}

        {phase === "pending" && (
          <div
            className="text-sm font-mono text-amber-300/70 py-6 text-center"
            data-testid="dice-pending"
          >
            Resolving shot on the server…
          </div>
        )}

        {phase === "attack-ready" && (
          <div
            className="text-sm font-mono text-muted-foreground py-4 text-center"
            data-testid="dice-prompt-attack"
          >
            {hasStealthCheck ? (
              <>
                Ready to roll stealth check before attack dice.
                {rawHitThreshold ? (
                  <div className="mt-1 text-[11px] text-muted-foreground/80">
                    If stealth is beaten,{" "}
                    <span className="text-amber-300 font-bold">
                      {rolledAttackDice}
                    </span>{" "}
                    attack dice need{" "}
                    <span className="text-amber-300 font-bold">
                      {rawHitThreshold}+
                    </span>{" "}
                    to hit.
                  </div>
                ) : null}
              </>
            ) : (
              <>
                Ready to roll{" "}
                <span className="text-amber-300 font-bold">
                  {rolledAttackDice}
                </span>{" "}
                attack dice
                {hitThreshold ? (
                  <>
                    {" "}
                    · need{" "}
                    <span className="text-amber-300 font-bold">
                      {hitThreshold}+
                    </span>{" "}
                    to hit
                  </>
                ) : null}
                .
              </>
            )}
            {interceptedAttackDice > 0 && (
              <div className="mt-1 text-[11px] text-cyan-300/80">
                {interceptedAttackDice} AD intercepted before the to-hit roll.
              </div>
            )}
            {result?.stealthCheckTarget != null && (
              <div
                className="mt-2 text-[11px] text-cyan-300/80"
                data-testid="stealth-prompt"
              >
                Target is stealthed — single 1d6 must hit{" "}
                <span className="font-bold">{result.stealthCheckTarget}+</span>{" "}
                (nat 6 always passes) or the attack misses.
                {((result.scoutStealthReduction ?? 0) > 0 ||
                  (result.fleetSupportStealthReduction ?? 0) > 0) && (
                  <span
                    className="ml-1 text-amber-300/90"
                    data-testid="stealth-mods"
                  >
                    [−
                    {(result.scoutStealthReduction ?? 0) +
                      (result.fleetSupportStealthReduction ?? 0)}{" "}
                    Stealth:
                    {(result.scoutStealthReduction ?? 0) > 0
                      ? ` Scout ×${result.scoutStealthReduction}`
                      : ""}
                    {(result.fleetSupportStealthReduction ?? 0) > 0
                      ? " · Fleet Support"
                      : ""}
                    ]
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Stealth check (per-attack 1d6, defender's Stealth trait). Shows
            during/after the attack roll. PASS → continues to AD; FAIL →
            attack misses entirely (server returns 0 AD rolled). */}
        {attackVisible &&
          result?.stealthCheckTarget != null &&
          result?.stealthCheckRoll != null && (
            <div className="space-y-1" data-testid="stealth-panel">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
                Stealth Check · need {result.stealthCheckTarget}+
                {!attackRolling &&
                  (result.stealthCheckPassed ? (
                    <span
                      className="ml-2 text-green-400"
                      data-testid="stealth-result-pass"
                    >
                      PASS{result.stealthCheckNat6Auto ? " (NAT 6)" : ""}
                    </span>
                  ) : (
                    <span
                      className="ml-2 text-red-400 animate-pulse"
                      data-testid="stealth-result-fail"
                    >
                      MISS — STEALTH
                    </span>
                  ))}
              </p>
              <div className="flex items-center gap-2">
                <div
                  className={`relative rounded ${
                    !attackRolling && !result.stealthCheckPassed
                      ? "ring-2 ring-red-500 ring-offset-2 ring-offset-background shadow-[0_0_8px_rgba(248,113,113,0.7)]"
                      : !attackRolling
                        ? "ring-1 ring-cyan-400/60 ring-offset-1 ring-offset-background"
                        : ""
                  }`}
                  data-testid="stealth-die"
                >
                  <DiceFace
                    value={result.stealthCheckRoll}
                    rolling={attackRolling}
                  />
                </div>
                {!attackRolling && !result.stealthCheckPassed && (
                  <span className="text-[11px] font-mono text-red-400/90">
                    Attack does not get through.
                    {result.stealthFailWastedSlowLoading && (
                      <span
                        className="ml-1 text-amber-300/90"
                        data-testid="stealth-fail-not-fired"
                      >
                        Slow-Loading/One-Shot — weapon NOT marked as fired.
                      </span>
                    )}
                  </span>
                )}
              </div>
            </div>
          )}

        {/* Attack dice (revealed during/after rolling). Beam-trait dice that
            "exploded" (rolled 4+ and spawned another die) get a glowing
            orange ring + EXPL tag so the player can spot Beam chains at a
            glance. Twin-Linked / Concentrate Fire re-rolls get a subtler
            cyan tag. */}
        {attackVisible && (
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
              Attack {hitThreshold ? `· need ${hitThreshold}+` : ""}
              {!attackRolling && (result?.beamExplosions ?? 0) > 0 && (
                <span
                  className="ml-2 text-orange-400 animate-pulse"
                  data-testid="badge-beam-chain"
                >
                  ⚡ {result?.beamExplosions} beam explosion
                  {(result?.beamExplosions ?? 0) === 1 ? "" : "s"}
                </span>
              )}
            </p>
            <div className="flex flex-wrap gap-2" data-testid="attack-dice">
              {rolls.map((r, i) => {
                const kind = rollKinds[i] ?? "normal";
                const exploded = kind === "explosion";
                const reroll =
                  kind === "twin-reroll" || kind === "concentrate-reroll";
                const hit =
                  !attackRolling &&
                  rawHitThreshold !== undefined &&
                  r >= rawHitThreshold;
                // Broader orange ring (ring-2 + offset) + soft glow for
                // exploded dice. Cyan ring for re-rolls so all three flavours
                // of "extra" die are visually distinct from regular AD.
                const ringCls = exploded
                  ? "ring-2 ring-orange-400 ring-offset-2 ring-offset-background shadow-[0_0_8px_rgba(251,146,60,0.7)] rounded"
                  : reroll
                    ? "ring-1 ring-cyan-400/70 ring-offset-1 ring-offset-background rounded"
                    : "";
                return (
                  <div
                    key={i}
                    className={`relative ${ringCls} ${hit ? "" : !attackRolling ? "opacity-60" : ""}`}
                    data-testid={`attack-die-${i}`}
                    data-kind={kind}
                  >
                    <DiceFace value={r} rolling={attackRolling} />
                    {hit && (
                      <span className="absolute -bottom-1 -right-1 text-[8px] font-mono text-green-400 bg-black/80 px-1 rounded">
                        HIT
                      </span>
                    )}
                    {!attackRolling && exploded && (
                      <span className="absolute -top-1 -left-1 text-[8px] font-mono text-orange-300 bg-black/80 px-1 rounded">
                        EXPL
                      </span>
                    )}
                    {!attackRolling && reroll && (
                      <span className="absolute -top-1 -left-1 text-[8px] font-mono text-cyan-300 bg-black/80 px-1 rounded">
                        RR
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {phase === "attack-shown" && result && (
              <p className="text-[11px] font-mono text-amber-300/80 pt-1">
                {result.hits} hit{result.hits === 1 ? "" : "s"} of{" "}
                {rolledAttackDice}.
              </p>
            )}
          </div>
        )}

        {/* Interceptor reveal — one row per incoming hit, dice rolled at the
            then-current threshold; dice showing 1 burn out of the pool and
            ramp the threshold (2+ → 6+) for subsequent attempts this turn. */}
        {/* Dodge reveal - defender rolls one d6 per hit. Successful Dodge
            rolls cancel hits before Interceptors, Shields, or damage dice. */}
        {attackVisible && result && result.dodgeRolls.length > 0 && (
          <div className="mt-3 space-y-1.5" data-testid="dodge-reveal">
            <p className="text-[10px] uppercase tracking-wider text-cyan-300/80 font-mono">
              Dodge
              {result.dodgeTarget ? <> · need {result.dodgeTarget}+</> : ""}
              {!attackRolling && result.dodgesSuccessful > 0 && (
                <span
                  className="ml-2 text-cyan-300"
                  data-testid="dodge-success-count"
                >
                  -{result.dodgesSuccessful} hit
                  {result.dodgesSuccessful === 1 ? "" : "s"}
                </span>
              )}
            </p>
            <div className="flex flex-wrap gap-2" data-testid="dodge-dice">
              {result.dodgeRolls.map((d, i) => {
                const saved =
                  result.dodgeTarget != null && d >= result.dodgeTarget;
                return (
                  <div
                    key={i}
                    className={`relative rounded ${!attackRolling && saved ? "ring-2 ring-cyan-400 ring-offset-2 ring-offset-background shadow-[0_0_8px_rgba(34,211,238,0.55)]" : !attackRolling ? "opacity-70" : ""}`}
                    data-testid={`dodge-die-${i}`}
                  >
                    <DiceFace value={d} rolling={attackRolling} />
                    {!attackRolling && (
                      <span
                        className={`absolute -bottom-1 -right-1 rounded bg-black/80 px-1 font-mono text-[8px] ${saved ? "text-cyan-300" : "text-muted-foreground"}`}
                      >
                        {saved ? "DODGE" : "HIT"}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {phase === "attack-shown" &&
          result &&
          (result.interceptorAttempts?.length ?? 0) > 0 && (
            <div className="mt-3 space-y-1.5" data-testid="interceptor-reveal">
              <p className="text-[10px] uppercase tracking-wider text-cyan-300/80 font-mono">
                Interceptors · pool {result.interceptorDiceBefore} →{" "}
                {result.interceptorDiceAfter}
                {" · threshold "}
                {result.interceptorThresholdBefore}+
                {result.interceptorThresholdAfter !==
                  result.interceptorThresholdBefore && (
                  <> → {result.interceptorThresholdAfter}+</>
                )}
              </p>
              <div className="space-y-1" data-testid="interceptor-attempts">
                {result.interceptorAttempts.map((att, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <span className="text-[9px] font-mono text-muted-foreground w-14">
                      AD {idx + 1} · {att.threshold}+
                    </span>
                    <div
                      className="flex flex-wrap gap-1"
                      data-testid={`interceptor-attempt-${idx}`}
                    >
                      {att.rolls.map((d, i) => {
                        const hit = d >= att.threshold;
                        const burned = d === 1;
                        return (
                          <div key={i} className="flex flex-col items-center">
                            <DiceFace value={d} rolling={false} />
                            <span
                              className={`text-[9px] font-mono mt-0.5 ${hit ? "text-cyan-300 font-bold" : burned ? "text-red-400 font-bold" : "text-muted-foreground"}`}
                            >
                              {hit ? "✓" : burned ? "✕" : "·"}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <span
                      className={`text-[10px] font-mono ${att.success ? "text-cyan-300" : "text-muted-foreground"}`}
                    >
                      {att.success ? "intercepted" : "through"}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] font-mono text-cyan-300/80 pt-0.5">
                {result.interceptedHits > 0 ? (
                  <>−{result.interceptedHits} AD intercepted.</>
                ) : (
                  <>No interceptions.</>
                )}
                {result.interceptorDiceAfter < result.interceptorDiceBefore && (
                  <>
                    {" "}
                    {result.interceptorDiceBefore -
                      result.interceptorDiceAfter}{" "}
                    die
                    {result.interceptorDiceBefore -
                      result.interceptorDiceAfter ===
                    1
                      ? ""
                      : "s"}{" "}
                    burned out (lost for the rest of the turn).
                  </>
                )}
              </p>
            </div>
          )}

        {/* Damage prompt */}
        {phase === "damage-ready" && result && (
          <div
            className="mt-4 text-sm font-mono text-muted-foreground text-center"
            data-testid="dice-prompt-damage"
          >
            Ready to roll{" "}
            <span className="text-amber-300 font-bold">{damageDiceCount}</span>{" "}
            damage dice (6 = crit).
          </div>
        )}

        {/* Damage dice (during/after damage roll) */}
        {damageVisible && result && hasDamageDice && (
          <div className="mt-3 space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
              Damage · {damageDiceCount} die{damageDiceCount === 1 ? "" : "s"}
            </p>
            <div className="flex flex-wrap gap-1.5" data-testid="damage-dice">
              {result.damageRolls.map((d, i) => {
                const effective = result.attackTableModifiedRolls?.[i] ?? d;
                const outcomeLabel = attackTableOutcomeLabel(d, effective);
                const tone =
                  effective <= 1
                    ? "bulkhead"
                    : effective <= 5
                      ? "solid"
                      : "crit";
                return (
                  <div key={i} className="flex flex-col items-center">
                    <DiceFace
                      value={d}
                      rolling={damageRolling}
                      tone={damageRolling ? "default" : tone}
                    />
                    {!damageRolling && (
                      <span
                        className={`text-[10px] font-mono mt-0.5 ${effective === 6 ? "text-red-400 font-bold" : effective === 1 ? "text-muted-foreground" : "text-amber-300"}`}
                      >
                        {outcomeLabel}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Per-crit reveal — only after the player has clicked "Roll Crits".
            Walks one crit at a time; each gets a location-d6 + effect-d6
            shuffle animation, then the entry is revealed and the player
            either rolls the next one or closes. The "Roll Crits" prompt
            sits between Damage and the first crit so the reveal is
            explicitly player-driven, not automatic. */}
        {phase === "damage-shown" && hasCrits && (
          <div
            className="mt-3 text-sm font-mono text-red-300/90 text-center py-2 border-t border-red-500/30 pt-3"
            data-testid="crit-prompt"
          >
            <span className="font-bold">{crits.length}</span> critical hit
            {crits.length === 1 ? "" : "s"} pending — press{" "}
            <span className="text-amber-300 font-bold">Roll Crits</span> to
            resolve.
          </div>
        )}
        {phase === "damage-shown" && ancientSuppressedCrits > 0 && (
          <div
            className="mt-2 rounded border border-violet-400/35 bg-violet-500/10 px-2 py-1.5 text-center font-mono text-[11px] text-violet-100"
            data-testid="ancient-suppressed-crits"
          >
            {ancientSuppressedCrits} crit
            {ancientSuppressedCrits === 1 ? "" : "s"} suppressed by Ancient
            traits.
          </div>
        )}
        {phase === "crit-ready" && (
          <div
            className="mt-3 text-sm font-mono text-red-300/90 text-center py-2 border-t border-red-500/30 pt-3"
            data-testid="crit-ready-prompt"
          >
            Ready to roll crit{" "}
            <span className="text-amber-300 font-bold">
              {(critIndex ?? 0) + 1}
            </span>{" "}
            of {crits.length}.
            <p className="text-[10px] text-muted-foreground mt-1">
              1d6 location, then 1d6 effect.
            </p>
          </div>
        )}
        {critVisible && (
          <div className="mt-3 space-y-2" data-testid="criticals-applied">
            <p className="text-[10px] uppercase tracking-wider text-red-300/80 font-mono">
              Criticals · {(critIndex ?? 0) + (phase === "crit-shown" ? 1 : 1)}{" "}
              of {crits.length}
            </p>
            <div className="space-y-2">
              {crits.map((c, i) => {
                const cur = critIndex ?? 0;
                if (i > cur) return null; // not yet rolled
                const isCurrent = i === cur;
                const rolling = isCurrent && critRolling;
                return (
                  <CriticalEffectTooltip
                    key={c.id}
                    crit={c}
                    enabled={pcHoverHintsEnabled && !rolling}
                  >
                  <div
                    className={`rounded px-2 py-1.5 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-red-300/60 data-[hint=true]:cursor-help ${
                      isCurrent
                        ? "border-2 border-red-400 bg-red-500/20 text-red-100 shadow-[0_0_8px_rgba(248,113,113,0.5)]"
                        : "border border-red-500/40 bg-red-500/10 text-red-200"
                    }`}
                    data-hint={pcHoverHintsEnabled && !rolling ? "true" : "false"}
                    data-testid={`crit-${c.effectKey}`}
                    tabIndex={pcHoverHintsEnabled && !rolling ? 0 : undefined}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[9px] uppercase text-muted-foreground">
                        Loc
                      </span>
                      <DiceFace value={c.locationRoll ?? 0} rolling={rolling} />
                      <span className="text-[9px] uppercase text-muted-foreground">
                        Eff
                      </span>
                      <DiceFace value={c.effectRoll ?? 0} rolling={rolling} />
                      {!rolling && (
                        <span className="ml-auto opacity-70 text-[10px]">
                          {c.damageApplied > 0 && `−${c.damageApplied}H `}
                          {c.crewApplied > 0 && `−${c.crewApplied}C`}
                        </span>
                      )}
                    </div>
                    {!rolling && (
                      <>
                        <div className="font-bold uppercase">
                          {c.name}
                        </div>
                        {(c.randomArc || c.lostTraits.length > 0) && (
                          <div className="opacity-70 mt-0.5">
                            {c.randomArc && <>arc: {c.randomArc} </>}
                            {c.lostTraits.length > 0 && (
                              <>
                                lost:{" "}
                                {c.lostTraits.map((trait, index) => (
                                  <React.Fragment
                                    key={`${c.id}-modal-lost-${trait}`}
                                  >
                                    {index > 0 ? ", " : ""}
                                    <TraitTooltip
                                      trait={trait}
                                      enabled={pcHoverHintsEnabled}
                                    >
                                      <span className="cursor-help">{trait}</span>
                                    </TraitTooltip>
                                  </React.Fragment>
                                ))}
                              </>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  </CriticalEffectTooltip>
                );
              })}
            </div>
          </div>
        )}

        {/* "All misses" sits in place of the damage section when applicable. */}
        {phase === "attack-shown" && result && !hasDamageDice && (
          <div className="mt-3 text-sm font-mono text-muted-foreground text-center py-2">
            {result.hits === 0 ? "All misses" : "No damage dice to roll"} — no
            damage roll.
          </div>
        )}

        {/* Final summary (only after the player has actually seen all dice). */}
        {summaryVisible && result && (
          <div
            className="mt-4 border-t border-border pt-3 space-y-1 font-mono text-sm"
            data-testid="dice-summary"
          >
            {/* Defender pipeline — only show rows that actually fired. */}
            {result.dodgesSuccessful > 0 && (
              <div className="flex justify-between" data-testid="row-dodges">
                <span className="text-muted-foreground">Dodged</span>
                <span className="text-cyan-300">
                  −{result.dodgesSuccessful} hit
                  {result.dodgesSuccessful === 1 ? "" : "s"}
                </span>
              </div>
            )}
            {result.interceptedHits > 0 && (
              <div
                className="flex justify-between"
                data-testid="row-intercepted"
              >
                <span className="text-muted-foreground">Interceptors</span>
                <span className="text-cyan-300">
                  −{result.interceptedHits} AD
                </span>
              </div>
            )}
            {(result.shieldedHits > 0 ||
              result.targetShieldsBefore !== result.targetShieldsAfter) && (
              <div className="flex justify-between" data-testid="row-shields">
                <span className="text-muted-foreground">
                  Shields{" "}
                  {result.shieldedHits > 0
                    ? `· −${result.shieldedHits} hit${result.shieldedHits === 1 ? "" : "s"}`
                    : ""}
                </span>
                <span className="text-blue-300">
                  {result.targetShieldsBefore} → {result.targetShieldsAfter}
                </span>
              </div>
            )}
            {result.bulkheadHits + result.solidHits + result.criticalHits >
              0 && (
              <div
                className="flex justify-between"
                data-testid="row-attack-table"
              >
                <span className="text-muted-foreground">Attack table</span>
                <span className="text-foreground">
                  {result.bulkheadHits > 0 && <>{result.bulkheadHits}B </>}
                  {result.solidHits > 0 && <>{result.solidHits}S </>}
                  {result.criticalHits > 0 && (
                    <span className="text-red-400">{result.criticalHits}C</span>
                  )}
                </span>
              </div>
            )}
            {ancientSuppressedCrits > 0 && (
              <div
                className="flex justify-between gap-3 text-violet-200"
                data-testid="row-ancient-suppressed-crits"
              >
                <span className="text-muted-foreground">Ancient traits</span>
                <span>
                  {ancientSuppressedCrits} crit
                  {ancientSuppressedCrits === 1 ? "" : "s"} suppressed
                </span>
              </div>
            )}
            {result.gegReduction > 0 && (
              <div className="flex justify-between" data-testid="row-geg">
                <span className="text-muted-foreground">GEG reduction</span>
                <span className="text-emerald-300">−{result.gegReduction}</span>
              </div>
            )}
            {result.adaptiveHalved && (
              <div className="flex justify-between" data-testid="row-adaptive">
                <span className="text-muted-foreground">Adaptive armour</span>
                <span className="text-emerald-300">halved</span>
              </div>
            )}
            {(result.blastDoorsDamageSaved > 0 ||
              result.blastDoorsCrewSaved > 0) && (
              <div
                className="flex justify-between"
                data-testid="row-blast-doors"
              >
                <span className="text-muted-foreground">Blast doors</span>
                <span className="text-emerald-300">
                  −{result.blastDoorsDamageSaved} dmg
                  {result.blastDoorsCrewSaved > 0 && (
                    <> · −{result.blastDoorsCrewSaved} crew</>
                  )}
                </span>
              </div>
            )}
            <div className="flex justify-between pt-1 border-t border-border/50">
              <span className="text-muted-foreground">Total damage</span>
              <span className="text-amber-300 font-bold">
                {result.totalDamage}
              </span>
            </div>
            {result.crewLost > 0 && (
              <div className="flex justify-between" data-testid="row-crew-lost">
                <span className="text-muted-foreground">Crew lost</span>
                <span className="text-amber-300/80">{result.crewLost}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">{targetName} hull</span>
              <span
                className={
                  result.targetDestroyed
                    ? "text-red-400 font-bold"
                    : "text-foreground"
                }
              >
                {result.targetHullBefore} → {result.targetHullAfter}
                {result.targetDestroyed && " · DESTROYED"}
              </span>
            </div>
            {(result as FireWeaponResult & { gameCompleted?: boolean })
              .gameCompleted && (
              <div
                className="mt-3 rounded border border-yellow-300/55 bg-yellow-300/10 px-3 py-2 text-center text-[11px] uppercase tracking-widest text-yellow-200"
                data-testid="dice-game-complete"
              >
                This shot ended the game. Close to view the final result.
              </div>
            )}
          </div>
        )}
      </div>

      <Button
        data-testid={footer.testid}
        className="mt-3 w-full shrink-0 border border-amber-500/40 uppercase tracking-widest text-xs shadow-[0_-10px_20px_rgba(0,0,0,0.35)]"
        disabled={footer.disabled}
        onClick={footer.onClick}
      >
        {footer.label}
      </Button>

      {/* Confirm-close overlay — small inline prompt above the modal body. */}
      {confirmingClose && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-black/85 rounded-md"
          data-testid="confirm-close-overlay"
        >
          <div className="text-center space-y-3 px-6">
            <p className="font-mono text-sm text-amber-300 uppercase tracking-wider">
              Close window?
            </p>
            <p className="font-mono text-[11px] text-muted-foreground">
              {phase === "damage-shown" ||
              (phase === "attack-shown" && result?.hits === 0) ||
              phase === "error"
                ? "The shot is already resolved on the server."
                : "The shot is resolved on the server — you'll lose the dice reveal but the result stands."}
            </p>
            <div className="flex gap-2 justify-center pt-1">
              <Button
                data-testid="button-confirm-close-yes"
                className="uppercase tracking-widest text-xs"
                onClick={confirmClose}
              >
                Close
              </Button>
              <Button
                data-testid="button-confirm-close-cancel"
                variant="outline"
                className="uppercase tracking-widest text-xs"
                onClick={cancelClose}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
