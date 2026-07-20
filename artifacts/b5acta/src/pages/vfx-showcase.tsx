import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { Canvas, useFrame, useLoader } from "@react-three/fiber";
import { Billboard, OrbitControls, Text, useGLTF } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
// @ts-ignore
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { Copy, RotateCcw, SlidersHorizontal, Sparkles, Target, Waves } from "lucide-react";

import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import type { Weapon } from "@workspace/api-client-react";

type Vec2 = [number, number];
type ProjectileShape = "sphere" | "cylinder";

type Tuning = {
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
  randomness?: number;
  projectileShape?: ProjectileShape;
  cylinderLength?: number;
  ribbonEffect?: number;
  meshSize?: number;
  flareSize?: number;
};

type WeaponStation = {
  kind: "weapon";
  id: string;
  label: string;
  note: string;
  faction: string;
  weapon: Pick<Weapon, "id" | "name" | "traits" | "attackDice">;
  from: Vec2;
  to: Vec2;
  hits: number;
  totalDice: number;
  tuning?: Partial<Tuning>;
};

type AmbientStation = {
  kind: "ambient";
  id: string;
  label: string;
  note: string;
  effect: "fire" | "smoke" | "impact";
  position: Vec2;
  tuning?: Partial<Tuning>;
};

type SpecialStation = {
  kind: "special";
  id: string;
  label: string;
  note: string;
  effect:
    | "shield-ripple"
    | "interceptor-burst"
    | "jump-point"
    | "energy-mine"
    | "stealth-shimmer"
    | "vortex-ribbons"
    | "jump-vortex"
    | "vortex-helix-lines"
    | "vortex-cone-shell"
    | "vortex-noise-sheets"
    | "vortex-ring-compression"
    | "tractor-lock"
    | "sensor-sweep"
    | "phase-cloak"
    | "debris-sparks"
    | "arc-particle-spray"
    | "persistent-impact-flashes"
    | "shockwave-dome"
    | "jump-point-aperture"
    | "hyperspace-wake"
    | "rift-shear"
    | "beacon-pulse"
    | "gravity-lens"
    | "damage-glow-core"
    | "godot-jump-point-mesh"
    | "cloud-flipbook-damage"
    | "missile-impact-flipbook-test"
    | "standalone-flipbook-preview"
    | "mesh-missile-salvo"
    | "texture-missile-salvo";
  position: Vec2;
  to?: Vec2;
  modelFilename?: string;
  textureFilename?: string;
  impactTextureFilename?: string;
  tuning?: Partial<Tuning>;
};

type HullStateStation = {
  kind: "hull-state";
  id: string;
  label: string;
  note: string;
  mode: "intact" | "adrift-tumble" | "adrift-askew" | "destroyed" | "exploding";
  modelFilename: string;
  position: Vec2;
  tuning?: Partial<Tuning>;
};

type AnimatedModelStation = {
  kind: "animated-model";
  id: string;
  label: string;
  note: string;
  modelFilename: string;
  position: Vec2;
  rotatingBoneName: string;
  rotationAxis: "x" | "y" | "z";
  secondsPerRotation: number;
  tuning?: Partial<Tuning>;
};

type ShowcaseStation =
  | WeaponStation
  | AmbientStation
  | SpecialStation
  | HullStateStation
  | AnimatedModelStation;

type ShowcaseBoard = {
  id: string;
  name: string;
  summary: string;
  stations: ShowcaseStation[];
};

type TuningOverrides = Record<string, Partial<Tuning>>;

const DEFAULT_TUNING: Tuning = {
  color: "#ff2a2a",
  secondaryColor: "#ffd166",
  speed: 1,
  size: 1,
  fade: 1,
  intensity: 1,
  spread: 1,
  count: 4,
  arc: 2.5,
  thickness: 1,
};

const CLOUD_FLIPBOOK_DAMAGE_SMOKE_TUNING: Tuning = {
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

const FACTION_COLORS: Record<string, string> = {
  "Earth Alliance": "#ff2a2a",
  "Minbari Federation": "#22ff66",
  "Shadows": "#b85cff",
  "Centauri Republic": "#ffa040",
};

const SHOWCASE_BOARDS: ShowcaseBoard[] = [
  {
    id: "core-weapons",
    name: "Core Weapons",
    summary: "Primary attack visuals used by weapon resolution.",
    stations: [
      {
        kind: "weapon",
        id: "earth-beam",
        label: "Earth Beam",
        note: "Beam trait with red EA color.",
        faction: "Earth Alliance",
        weapon: { id: 9001, name: "Heavy Laser Cannon", traits: "Beam; Double Damage", attackDice: 4 },
        from: [-18, -24],
        to: [-4, -24],
        hits: 2,
        totalDice: 4,
        tuning: { color: "#ff2a2a", count: 4, thickness: 1 },
      },
      {
        kind: "weapon",
        id: "shadow-slicer",
        label: "Shadow Slicer",
        note: "Molecular slicer beam in purple.",
        faction: "Shadows",
        weapon: { id: 9002, name: "Molecular Slicer Beam", traits: "Beam; Precise; Quad Damage", attackDice: 6 },
        from: [6, -24],
        to: [20, -24],
        hits: 3,
        totalDice: 6,
        tuning: { color: "#b85cff", count: 6, thickness: 1.35, intensity: 1.2 },
      },
      {
        kind: "weapon",
        id: "tracer-salvo",
        label: "Tracer Salvo",
        note: "Default cannon / pulse / ion projectile path.",
        faction: "Centauri Republic",
        weapon: { id: 9003, name: "Ion Cannon", traits: "Double Damage; Twin-Linked", attackDice: 8 },
        from: [-18, -4],
        to: [-4, 6],
        hits: 3,
        totalDice: 8,
        tuning: {
          color: "#76bb40",
          secondaryColor: "#96d35f",
          speed: 1,
          size: 0.3,
          fade: 2.9,
          intensity: 1,
          spread: 1,
          count: 7,
          arc: 2.5,
          thickness: 1,
        },
      },
      {
        kind: "special",
        id: "missile-impact-flipbook-test",
        label: "Missile Impact Flipbook",
        note: "Missile Hyperion launches three 0.4-inch texture-flare missiles at 0.0s, 0.5s, and 1.2s, each with a 3s flight and Explosion00 impact.",
        effect: "missile-impact-flipbook-test",
        position: [-16, 0],
        to: [6, 0],
        modelFilename: "missile1.glb",
        textureFilename: "missileflare.png",
        impactTextureFilename: "explosion00-5x5-keyed.webp",
        tuning: {
          color: "#f97316",
          secondaryColor: "#fef08a",
          speed: 1.3,
          size: 0.85,
          fade: 1,
          intensity: 1.55,
          spread: 1,
          count: 3,
          arc: 2.2,
          thickness: 0.25,
          meshSize: 0.4,
          flareSize: 4,
        },
      },
    ],
  },
  {
    id: "flipbook-tests",
    name: "Flipbook Tests",
    summary: "Standalone generated 25-frame texture flipbook previews.",
    stations: [
      {
        kind: "special",
        id: "codex-sci-fi-explosion-1280",
        label: "Generated 1280 Flipbook",
        note: "Exact 5x5 sheet at 1280px, 256px per frame, converted to WebP.",
        effect: "standalone-flipbook-preview",
        position: [-6, -24],
        textureFilename: "codex-sci-fi-explosion-5x5-1280.webp",
        tuning: {
          color: "#ffffff",
          secondaryColor: "#60a5fa",
          speed: 1,
          size: 1.2,
          fade: 1,
          intensity: 1.25,
          spread: 1,
          count: 1,
          arc: 0,
          thickness: 1,
        },
      },
      {
        kind: "special",
        id: "codex-sci-fi-explosion-1254",
        label: "Generated 1254 Flipbook",
        note: "Earlier generated 5x5 sheet at 1254px, converted to WebP for comparison.",
        effect: "standalone-flipbook-preview",
        position: [6, -24],
        textureFilename: "codex-sci-fi-explosion-5x5.webp",
        tuning: {
          color: "#ffffff",
          secondaryColor: "#a78bfa",
          speed: 1,
          size: 1.2,
          fade: 1,
          intensity: 1.25,
          spread: 1,
          count: 1,
          arc: 0,
          thickness: 1,
        },
      },
    ],
  },
  {
    id: "damage-states",
    name: "Damage States",
    summary: "Persistent board ambience and impact accents.",
    stations: [
      {
        kind: "hull-state",
        id: "hyperion-adrift-tumble",
        label: "Adrift Tumble",
        note: "Powerless hull with slow visual-only roll and pitch drift.",
        mode: "adrift-tumble",
        modelFilename: "hyperion.glb",
        position: [-9, -26],
        tuning: { color: "#94a3b8", secondaryColor: "#67e8f9", speed: 0.35, intensity: 0.45 },
      },
      {
        kind: "hull-state",
        id: "hyperion-adrift-askew",
        label: "Adrift Askew",
        note: "Static off-axis hull for a quieter no-power state.",
        mode: "adrift-askew",
        modelFilename: "hyperion.glb",
        position: [0, -26],
        tuning: { color: "#94a3b8", secondaryColor: "#cbd5e1", intensity: 0.38 },
      },
      {
        kind: "hull-state",
        id: "hyperion-exploding-delayed",
        label: "Exploding",
        note: "Delayed explosion warning with red internal pulse.",
        mode: "exploding",
        modelFilename: "hyperion.glb",
        position: [9, -26],
        tuning: { color: "#ef4444", secondaryColor: "#f97316", speed: 1.25, size: 0.9, intensity: 1.35, count: 18, spread: 0.72 },
      },
      {
        kind: "hull-state",
        id: "hyperion-destroyed-wreck",
        label: "Destroyed Wreck",
        note: "Cold wreck sample using the dead Hyperion mesh and smoke.",
        mode: "destroyed",
        modelFilename: "dead-hyperion.glb",
        position: [18, -26],
        tuning: { color: "#64748b", secondaryColor: "#f8fafc", speed: 0.5, size: 0.8, intensity: 0.8, count: 30, spread: 0.95 },
      },
      {
        kind: "ambient",
        id: "hull-fire",
        label: "Hull Fire",
        note: "Localized fire used for damaged ships.",
        effect: "fire",
        position: [-16, -18],
        tuning: { color: "#ff7a18", secondaryColor: "#ffd166", speed: 1.1, size: 0.75, fade: 1, intensity: 0.8, spread: 0.45, count: 16, arc: 0.15, thickness: 0.9 },
      },
      {
        kind: "special",
        id: "cloud-flipbook-damage",
        label: "Cloud Flipbook Damage",
        note: "Converted Cloud01 8x8 WebP flipbook as a damage-emitter candidate.",
        effect: "cloud-flipbook-damage",
        position: [8, -18],
        textureFilename: "cloud01-8x8.webp",
        tuning: CLOUD_FLIPBOOK_DAMAGE_SMOKE_TUNING,
      },
      {
        kind: "animated-model",
        id: "omega1-rotator-bone-test",
        label: "Omega Rotator Bone",
        note: "omega1.glb rotatorhull rotates around Blender Y/front-back over 30 seconds.",
        modelFilename: "omega1.glb",
        position: [-18, -10],
        rotatingBoneName: "rotatorhull",
        rotationAxis: "z",
        secondsPerRotation: 30,
        tuning: { color: "#38bdf8", secondaryColor: "#f8fafc", speed: 1, size: 1, intensity: 0.4 },
      },
      {
        kind: "hull-state",
        id: "omega-destroyed-wreck",
        label: "Destroyed Omega Wreck",
        note: "Dead Omega mesh with smoke_light and small_glow emitter empties.",
        mode: "destroyed",
        modelFilename: "dead-omega.glb",
        position: [-9, -10],
        tuning: { color: "#64748b", secondaryColor: "#f8fafc", speed: 0.5, size: 0.85, intensity: 0.85, count: 30, spread: 0.95 },
      },
      {
        kind: "hull-state",
        id: "nova-destroyed-wreck",
        label: "Destroyed Nova Wreck",
        note: "Dead Nova mesh with smoke_light and small_glow emitter empties.",
        mode: "destroyed",
        modelFilename: "dead-nova.glb",
        position: [0, -10],
        tuning: { color: "#64748b", secondaryColor: "#f8fafc", speed: 0.5, size: 0.85, intensity: 0.85, count: 34, spread: 0.95 },
      },
    ],
  },
  {
    id: "special-systems",
    name: "Special Systems",
    summary: "Additional plausible game effects for defenses, special actions, and battlefield events.",
    stations: [
      {
        kind: "special",
        id: "shield-ripple",
        label: "Shield Ripple",
        note: "Defensive hit absorption or adaptive armor feedback.",
        effect: "shield-ripple",
        position: [-17, -22],
        tuning: { color: "#38bdf8", secondaryColor: "#a7f3d0", speed: 1, size: 1, fade: 1.1, intensity: 1.2 },
      },
      {
        kind: "special",
        id: "interceptor-burst",
        label: "Interceptor Burst",
        note: "Short defensive fire blossoms around a target.",
        effect: "interceptor-burst",
        position: [0, -22],
        tuning: { color: "#facc15", secondaryColor: "#fb923c", speed: 1.3, size: 1, count: 10, spread: 1.2 },
      },
      {
        kind: "special",
        id: "jump-point",
        label: "Jump Point",
        note: "Horizontal ribbon vortex with origin at the base and portal at the far end.",
        effect: "jump-point",
        position: [17, -22],
        tuning: { color: "#2dd4bf", secondaryColor: "#01c7fc", speed: 3, size: 1, fade: 1.55, intensity: 2.9, spread: 1.5, count: 16, arc: 2.7, thickness: 4, randomness: 1 },
      },
      {
        kind: "special",
        id: "energy-mine",
        label: "Energy Mine",
        note: "Expanding area pulse for mine detonation.",
        effect: "energy-mine",
        position: [-9, 8],
        tuning: { color: "#f472b6", secondaryColor: "#fde68a", speed: 0.85, size: 1.15, fade: 1, thickness: 1.2 },
      },
      {
        kind: "special",
        id: "stealth-shimmer",
        label: "Stealth Shimmer",
        note: "Scout, stealth, or sensor ghost visualization.",
        effect: "stealth-shimmer",
        position: [10, 8],
        tuning: { color: "#c4b5fd", secondaryColor: "#67e8f9", speed: 0.75, size: 1, fade: 1.5, intensity: 0.85 },
      },
    ],
  },
  {
    id: "battlefield-events",
    name: "Battlefield Events",
    summary: "Utility and scenario VFX for locks, scans, cloaks, debris, and shockwaves.",
    stations: [
      {
        kind: "special",
        id: "tractor-lock",
        label: "Tractor Lock",
        note: "Constraining rings and beam column for gravitic holds.",
        effect: "tractor-lock",
        position: [-17, -22],
        tuning: { color: "#38bdf8", secondaryColor: "#facc15", speed: 0.9, size: 1, fade: 1.1, intensity: 1, spread: 1, count: 4, arc: 3.2, thickness: 1 },
      },
      {
        kind: "special",
        id: "sensor-sweep",
        label: "Sensor Sweep",
        note: "Expanding tactical scan rings with a rotating sweep plane.",
        effect: "sensor-sweep",
        position: [0, -22],
        tuning: { color: "#22d3ee", secondaryColor: "#bef264", speed: 1, size: 1, fade: 1.4, intensity: 0.9, spread: 1.2, count: 5, arc: 2.8, thickness: 0.8 },
      },
      {
        kind: "special",
        id: "phase-cloak",
        label: "Phase Cloak",
        note: "Layered wire shells for stealth, dodge, or phase transition states.",
        effect: "phase-cloak",
        position: [17, -22],
        tuning: { color: "#a78bfa", secondaryColor: "#67e8f9", speed: 0.65, size: 1, fade: 1.6, intensity: 0.75, spread: 1, count: 3, arc: 2.5, thickness: 1 },
      },
      {
        kind: "special",
        id: "debris-sparks",
        label: "Debris Sparks",
        note: "Angular fragments for hull breach or wreckage events.",
        effect: "debris-sparks",
        position: [-9, 8],
        tuning: { color: "#f97316", secondaryColor: "#fde68a", speed: 1.2, size: 1, fade: 1.1, intensity: 1.15, spread: 1.35, count: 14, arc: 2.2, thickness: 1 },
      },
      {
        kind: "special",
        id: "arc-particle-spray",
        label: "Arc Particle Spray",
        note: "Outlined black particles spraying from one origin in adjustable ballistic arcs.",
        effect: "arc-particle-spray",
        position: [0, -6],
        tuning: {
          color: "#050505",
          secondaryColor: "#f8fafc",
          speed: 1,
          size: 0.72,
          fade: 1.2,
          intensity: 1,
          spread: 1.45,
          count: 42,
          arc: 2.6,
          thickness: 1,
          randomness: 0.45,
          ribbonEffect: 0.75,
        },
      },
      {
        kind: "special",
        id: "persistent-impact-flashes",
        label: "Persistent Impact Flashes",
        note: "Multiple full-sphere impact blooms suspended above the board with randomized sizes.",
        effect: "persistent-impact-flashes",
        position: [10, 8],
        tuning: {
          color: "#67e8f9",
          secondaryColor: "#ffffff",
          speed: 0.85,
          size: 1,
          fade: 1.25,
          intensity: 1.15,
          spread: 1.35,
          count: 14,
          arc: 3.2,
          thickness: 1,
          randomness: 0.85,
        },
      },
      {
        kind: "special",
        id: "shockwave-dome",
        label: "Shockwave Dome",
        note: "Expanding shell for large detonations or spatial pressure waves.",
        effect: "shockwave-dome",
        position: [10, 8],
        tuning: { color: "#fb7185", secondaryColor: "#fef08a", speed: 0.8, size: 1.1, fade: 1.25, intensity: 0.9, spread: 1, count: 3, arc: 2.8, thickness: 1.2 },
      },
    ],
  },
  {
    id: "command-status",
    name: "Command Status",
    summary: "Readable activation, command, and defensive-state candidates for live board feedback.",
    stations: [
      {
        kind: "special",
        id: "scout-coordination-lock",
        label: "Scout Coordination",
        note: "Target-designation sweep for scout reroll support.",
        effect: "sensor-sweep",
        position: [-17, -22],
        tuning: { color: "#38bdf8", secondaryColor: "#bef264", speed: 0.75, size: 0.95, fade: 1.35, intensity: 0.95, spread: 1.05, count: 4, arc: 2.8, thickness: 0.7 },
      },
      {
        kind: "special",
        id: "concentrate-fire-vector",
        label: "Concentrated Fire",
        note: "Focused firing-solution marker for nominated targets.",
        effect: "tractor-lock",
        position: [0, -22],
        tuning: { color: "#facc15", secondaryColor: "#fb923c", speed: 0.65, size: 0.95, fade: 1.1, intensity: 1, spread: 0.85, count: 3, arc: 2.6, thickness: 0.75 },
      },
      {
        kind: "special",
        id: "defensive-grid",
        label: "Defensive Grid",
        note: "Close blast doors / intensified defense visual state.",
        effect: "shield-ripple",
        position: [17, -22],
        tuning: { color: "#60a5fa", secondaryColor: "#fef08a", speed: 0.75, size: 0.9, fade: 1.2, intensity: 0.85, spread: 1, count: 4, arc: 2.4, thickness: 1.3 },
      },
      {
        kind: "special",
        id: "crippled-power-flicker",
        label: "Crippled Power",
        note: "Low-intensity shield flicker for crippled or skeleton-crew ships.",
        effect: "stealth-shimmer",
        position: [-9, 8],
        tuning: { color: "#f97316", secondaryColor: "#94a3b8", speed: 0.52, size: 0.85, fade: 1.75, intensity: 0.65, spread: 0.85, count: 3, arc: 2.5, thickness: 0.8 },
      },
      {
        kind: "ambient",
        id: "reactor-bleed",
        label: "Reactor Bleed",
        note: "Persistent internal-fire accent for critical reactor damage.",
        effect: "fire",
        position: [10, 8],
        tuning: { color: "#ef4444", secondaryColor: "#fef08a", speed: 0.85, size: 0.58, fade: 1.25, intensity: 0.75, spread: 0.36, count: 18, arc: 0.2, thickness: 0.8 },
      },
    ],
  },
  {
    id: "terrain-hazards",
    name: "Terrain Hazards",
    summary: "Environmental VFX candidates for asteroid fields, dust clouds, anomalies, and scenario markers.",
    stations: [
      {
        kind: "special",
        id: "asteroid-scrape",
        label: "Asteroid Scrape",
        note: "Fragment scatter for asteroid-field movement checks.",
        effect: "debris-sparks",
        position: [-17, -22],
        tuning: { color: "#a16207", secondaryColor: "#facc15", speed: 0.72, size: 0.9, fade: 1.4, intensity: 0.8, spread: 1.45, count: 22, arc: 1.45, thickness: 0.9 },
      },
      {
        kind: "ambient",
        id: "dust-cloud-bank",
        label: "Dust Cloud",
        note: "Low-opacity drifting haze for sensor-obscuring terrain.",
        effect: "smoke",
        position: [0, -22],
        tuning: CLOUD_FLIPBOOK_DAMAGE_SMOKE_TUNING,
      },
      {
        kind: "special",
        id: "gravity-well",
        label: "Gravity Well",
        note: "Lens shell for gravity anomalies or terrain pull zones.",
        effect: "gravity-lens",
        position: [17, -22],
        tuning: { color: "#93c5fd", secondaryColor: "#f0abfc", speed: 0.45, size: 1.05, fade: 1.9, intensity: 0.7, spread: 1.15, count: 5, arc: 3.2, thickness: 0.8 },
      },
      {
        kind: "special",
        id: "radiation-front",
        label: "Radiation Front",
        note: "Expanding hazard pulse for dangerous clouds or scenario waves.",
        effect: "energy-mine",
        position: [-9, 8],
        tuning: { color: "#bef264", secondaryColor: "#22d3ee", speed: 0.42, size: 1.25, fade: 1.45, intensity: 0.72, spread: 1.2, count: 4, arc: 3.2, thickness: 0.9 },
      },
      {
        kind: "special",
        id: "spatial-anomaly",
        label: "Spatial Anomaly",
        note: "Noise-sheet distortion for unstable terrain regions.",
        effect: "vortex-noise-sheets",
        position: [10, 8],
        tuning: { color: "#818cf8", secondaryColor: "#67e8f9", speed: 0.5, size: 1.1, fade: 1.8, intensity: 0.62, spread: 1.25, count: 7, arc: 3.1, thickness: 0.9 },
      },
    ],
  },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toVector3([x, z]: Vec2, y = 0.8): THREE.Vector3 {
  return new THREE.Vector3(x, y, z);
}

function stationTypeLabel(station: ShowcaseStation): string {
  if (station.kind === "weapon") return station.weapon.name;
  if (station.kind === "hull-state") return station.mode;
  if (station.kind === "animated-model") return "bone test";
  return station.effect;
}

function supportsRibbonRandomness(station: ShowcaseStation): boolean {
  if (station.kind !== "special") return false;
  return station.effect === "jump-point" || station.effect === "vortex-ribbons" || station.effect === "jump-vortex" || station.effect === "jump-point-aperture" || station.effect === "arc-particle-spray" || station.effect === "persistent-impact-flashes";
}

function isArcParticleSpray(station: ShowcaseStation): boolean {
  return station.kind === "special" && station.effect === "arc-particle-spray";
}

function isPersistentImpactFlashes(station: ShowcaseStation): boolean {
  return station.kind === "special" && station.effect === "persistent-impact-flashes";
}

function baseTuningFor(station: ShowcaseStation): Tuning {
  const stationColor = station.kind === "weapon"
    ? FACTION_COLORS[station.faction] ?? DEFAULT_TUNING.color
    : DEFAULT_TUNING.color;
  return {
    ...DEFAULT_TUNING,
    color: stationColor,
    count: station.kind === "weapon" ? station.totalDice : DEFAULT_TUNING.count,
    ...station.tuning,
  };
}

function effectiveTuning(station: ShowcaseStation, overrides: TuningOverrides): Tuning {
  return { ...baseTuningFor(station), ...(overrides[station.id] ?? {}) };
}

function classifyWeapon(weapon: Pick<Weapon, "name" | "traits">): "beam" | "tracer" | "missile" {
  const name = (weapon.name ?? "").toLowerCase();
  const traits = (weapon.traits ?? "").toLowerCase();
  if (name.includes("missile")) return "missile";
  if (name.includes("molecular slicer")) return "beam";
  if (name.includes("laser")) return "beam";
  if (/\bmini[- ]?beam\b/.test(traits) || /\bbeam\b/.test(traits)) return "beam";
  return "tracer";
}

function phaseAlpha(t: number, fade = 1): number {
  if (t < 0.1) return t / 0.1;
  const fadeStart = clamp(0.72 - (fade - 1) * 0.12, 0.45, 0.86);
  if (t < fadeStart) return 1;
  return clamp(1 - (t - fadeStart) / (1 - fadeStart), 0, 1);
}

function BoardPlane() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.04, 0]} receiveShadow>
        <planeGeometry args={[48, 72]} />
        <meshStandardMaterial color="#091109" roughness={0.88} metalness={0.05} />
      </mesh>
      <gridHelper args={[72, 72, "#12301a", "#0e1f14"]} position={[0, 0, 0]} />
      <lineSegments position={[0, 0.02, 0]}>
        <edgesGeometry args={[new THREE.BoxGeometry(48, 0.02, 72)]} />
        <lineBasicMaterial color="#f4c95d" transparent opacity={0.65} />
      </lineSegments>
    </group>
  );
}

function StationLabel({ station, selected }: { station: ShowcaseStation; selected: boolean }) {
  const [x, z] = station.kind === "weapon"
    ? [(station.from[0] + station.to[0]) / 2, (station.from[1] + station.to[1]) / 2]
    : station.position;

  return (
    <Billboard position={[x, 2.8, z]} follow>
      <Text fontSize={0.54} color={selected ? "#facc15" : "#f8fafc"} anchorX="center" anchorY="middle" outlineWidth={0.035} outlineColor="#020617">
        {station.label}
      </Text>
      <Text position={[0, -0.58, 0]} fontSize={0.28} color="#cbd5e1" anchorX="center" anchorY="middle" outlineWidth={0.025} outlineColor="#020617">
        {station.note}
      </Text>
    </Billboard>
  );
}

function EndpointMarker({ position, color, selected = false }: { position: Vec2; color: string; selected?: boolean }) {
  return (
    <group position={[position[0], 0.12, position[1]]}>
      <mesh raycast={() => null}>
        <cylinderGeometry args={[selected ? 0.62 : 0.45, selected ? 0.62 : 0.45, 0.05, 32]} />
        <meshBasicMaterial color={color} transparent opacity={selected ? 0.94 : 0.78} />
      </mesh>
      <pointLight color={color} intensity={selected ? 1.8 : 1.1} distance={5} />
    </group>
  );
}

function showcaseShipScale(object: THREE.Object3D, targetInches = 2.4): number {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxHorizontal = Math.max(size.x, size.z);
  return maxHorizontal > 0 ? targetInches / maxHorizontal : 1;
}

function readEulerAxis(rotation: THREE.Euler, axis: "x" | "y" | "z"): number {
  if (axis === "x") return rotation.x;
  if (axis === "y") return rotation.y;
  return rotation.z;
}

function writeEulerAxis(rotation: THREE.Euler, axis: "x" | "y" | "z", value: number) {
  if (axis === "x") rotation.x = value;
  else if (axis === "y") rotation.y = value;
  else rotation.z = value;
}

const SHOWCASE_MODEL_ASSET_REVISIONS: Record<string, string> = {
  "dead-hyperion.glb": "20260718-163044",
  "dead-nova.glb": "20260718-233153",
  "dead-omega.glb": "20260718-231918",
  "hyperion.glb": "20260719-local",
  "missile.glb": "20260719-010532",
  "missile-hyperion.glb": "20260719-local",
  "missile1.glb": "20260719-013547",
  "omega1.glb": "20260718-223718",
  "_jumppoint.glb": "20260719-192131",
};

const SHOWCASE_TEXTURE_ASSET_REVISIONS: Record<string, string> = {
  "t_noise1_nk.png": "20260719-182302",
  "cloud01-8x8.webp": "20260719-032240",
  "codex-sci-fi-explosion-5x5.webp": "20260719-122000",
  "codex-sci-fi-explosion-5x5-1280.webp": "20260719-122000",
  "explosion00-5x5-keyed.webp": "20260719-113000",
  "missileflare.png": "20260719-011930",
};

function showcaseModelUrl(filename: string): string {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const revision =
    SHOWCASE_MODEL_ASSET_REVISIONS[filename.toLowerCase()] ?? "vfx-range";
  return `${basePath}/api/models/${filename}?v=${encodeURIComponent(revision)}`;
}

function showcaseTextureUrl(filename: string): string {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const revision =
    SHOWCASE_TEXTURE_ASSET_REVISIONS[filename.toLowerCase()] ?? "vfx-range";
  return `${basePath}/api/textures/${filename}?v=${encodeURIComponent(revision)}`;
}

type ShowcaseModelAnchor = {
  name: string;
  position: [number, number, number];
};

function ShowcaseGlbModel({
  filename,
  tint,
  opacity = 1,
  emissiveColor,
  emissiveIntensity = 0,
  emissivePulse = false,
  anchorEffects = false,
  rotation = [0, 0, 0],
  targetInches = 2.4,
}: {
  filename: string;
  tint: string;
  opacity?: number;
  emissiveColor?: string;
  emissiveIntensity?: number;
  emissivePulse?: boolean;
  anchorEffects?: boolean;
  rotation?: [number, number, number];
  targetInches?: number;
}) {
  const url = showcaseModelUrl(filename);
  const { scene } = useGLTF(url);
  const emissiveMaterialsRef = useRef<Array<THREE.Material & { emissive?: THREE.Color; emissiveIntensity?: number }>>([]);

  const { cloned, anchors } = useMemo(() => {
    const c = scene.clone(true);
    const emissiveMaterials: Array<THREE.Material & { emissive?: THREE.Color; emissiveIntensity?: number }> = [];
    const tintColor = new THREE.Color(tint);
    const glowColor = new THREE.Color(emissiveColor ?? tint);
    const anchorPoints: ShowcaseModelAnchor[] = [];

    c.traverse((child: any) => {
      const anchorName = String(child.name ?? "").toLowerCase();
      if (
        anchorName.startsWith("wreck_smoke") ||
        anchorName.startsWith("smoke_light") ||
        anchorName.startsWith("small_glow")
      ) {
        anchorPoints.push({
          name: anchorName,
          position: [child.position.x, child.position.y, child.position.z],
        });
      }
      if (!child.isMesh) return;
      const sourceMaterials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      const materials = sourceMaterials.map((material: THREE.Material | undefined) => {
        const clonedMaterial = material?.clone
          ? material.clone()
          : new THREE.MeshStandardMaterial({ color: "#d1d5db" });
        const adjustable = clonedMaterial as THREE.Material & {
          color?: THREE.Color;
          emissive?: THREE.Color;
          emissiveIntensity?: number;
        };
        if (adjustable.color instanceof THREE.Color) {
          adjustable.color = adjustable.color.clone().lerp(tintColor, 0.14);
        }
        if (adjustable.emissive instanceof THREE.Color) {
          adjustable.emissive = glowColor.clone();
          adjustable.emissiveIntensity = emissiveIntensity;
          emissiveMaterials.push(adjustable);
        }
        clonedMaterial.transparent = opacity < 1;
        clonedMaterial.opacity = opacity;
        return clonedMaterial;
      });
      child.material = Array.isArray(child.material) ? materials : materials[0];
    });

    emissiveMaterialsRef.current = emissiveMaterials;
    return { cloned: c, anchors: anchorPoints };
  }, [scene, tint, opacity, emissiveColor, emissiveIntensity]);

  useFrame(({ clock }) => {
    if (!emissivePulse) return;
    const pulse = 0.65 + (Math.sin(clock.elapsedTime * 5.2) + 1) * 0.75;
    for (const material of emissiveMaterialsRef.current) {
      material.emissiveIntensity = emissiveIntensity * pulse;
    }
  });

  const scale = useMemo(() => showcaseShipScale(cloned, targetInches), [cloned, targetInches]);
  return (
    <group rotation={rotation} scale={[scale, scale, scale]}>
      <primitive object={cloned} />
      {anchorEffects
        ? anchors.map((anchor) => (
            <ModelAnchorEffect
              key={`${filename}-${anchor.name}`}
              anchor={anchor}
              modelScale={scale}
            />
          ))
        : null}
    </group>
  );
}

function RotatingBoneShowcaseModel({
  filename,
  tint,
  rotatingBoneName,
  rotationAxis,
  secondsPerRotation,
}: {
  filename: string;
  tint: string;
  rotatingBoneName: string;
  rotationAxis: "x" | "y" | "z";
  secondsPerRotation: number;
}) {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const revision =
    SHOWCASE_MODEL_ASSET_REVISIONS[filename.toLowerCase()] ?? "vfx-range";
  const url = `${basePath}/api/models/${filename}?v=${encodeURIComponent(revision)}`;
  const { scene } = useGLTF(url);
  const boneRef = useRef<THREE.Object3D | null>(null);
  const initialRotationRef = useRef(0);

  const cloned = useMemo(() => {
    const c = cloneSkeleton(scene) as THREE.Object3D;
    const tintColor = new THREE.Color(tint);
    const targetBoneName = rotatingBoneName.toLowerCase();
    boneRef.current = null;
    initialRotationRef.current = 0;

    c.traverse((child: any) => {
      const childName = String(child.name ?? "").toLowerCase();
      if (childName === targetBoneName) {
        boneRef.current = child;
        initialRotationRef.current = readEulerAxis(child.rotation, rotationAxis);
      }
      if (!child.isMesh) return;
      child.castShadow = true;
      child.receiveShadow = true;
      const sourceMaterials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      const materials = sourceMaterials.map((material: THREE.Material | undefined) => {
        const clonedMaterial = material?.clone
          ? material.clone()
          : new THREE.MeshStandardMaterial({ color: "#d1d5db" });
        const adjustable = clonedMaterial as THREE.Material & {
          color?: THREE.Color;
          emissive?: THREE.Color;
          emissiveIntensity?: number;
        };
        if (adjustable.color instanceof THREE.Color) {
          adjustable.color = adjustable.color.clone().lerp(tintColor, 0.1);
        }
        if (adjustable.emissive instanceof THREE.Color) {
          adjustable.emissive = tintColor.clone();
          adjustable.emissiveIntensity = 0.06;
        }
        return clonedMaterial;
      });
      child.material = Array.isArray(child.material) ? materials : materials[0];
    });

    return c;
  }, [scene, tint, rotatingBoneName, rotationAxis]);

  useFrame(({ clock }) => {
    const bone = boneRef.current;
    if (!bone) return;
    const cycle = Math.max(0.1, secondsPerRotation);
    const progress = (clock.elapsedTime % cycle) / cycle;
    writeEulerAxis(
      bone.rotation,
      rotationAxis,
      initialRotationRef.current + progress * Math.PI * 2,
    );
    bone.updateMatrixWorld();
  });

  const scale = useMemo(() => showcaseShipScale(cloned, 3.2), [cloned]);

  return (
    <group scale={[scale, scale, scale]}>
      <primitive object={cloned} />
    </group>
  );
}

function AnimatedModelFxStation({ station, tuning, selected, showLabel }: { station: AnimatedModelStation; tuning: Tuning; selected: boolean; showLabel: boolean }) {
  return (
    <group>
      <EndpointMarker position={station.position} color={tuning.color} selected={selected} />
      <group position={[station.position[0], 0, station.position[1]]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]} raycast={() => null}>
          <ringGeometry args={[1.45, 1.62, 64]} />
          <meshBasicMaterial color={tuning.color} transparent opacity={selected ? 0.9 : 0.42} />
        </mesh>
        <group position={[0, 1.35, 0]}>
          <Suspense fallback={null}>
            <RotatingBoneShowcaseModel
              filename={station.modelFilename}
              tint={tuning.secondaryColor}
              rotatingBoneName={station.rotatingBoneName}
              rotationAxis={station.rotationAxis}
              secondsPerRotation={station.secondsPerRotation}
            />
          </Suspense>
        </group>
      </group>
      {showLabel ? <StationLabel station={station} selected={selected} /> : null}
    </group>
  );
}

function ModelAnchorSmoke({
  anchor,
  modelScale,
}: {
  anchor: ShowcaseModelAnchor;
  modelScale: number;
}) {
  const sourceTexture = useLoader(
    THREE.TextureLoader,
    showcaseTextureUrl("cloud01-8x8.webp"),
  );
  const elapsedRef = useRef(0);
  const tuning = CLOUD_FLIPBOOK_DAMAGE_SMOKE_TUNING;
  const effectScale = modelScale > 0 ? 1 / modelScale : 1;
  const count = clamp(Math.round(tuning.count), 1, 12);
  const columns = 8;
  const rows = 8;
  const frameCount = columns * rows;
  const puffs = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const angle = i * 2.399;
        const radius = (0.18 + (i % 4) * 0.16) * tuning.spread;
        return {
          x: Math.cos(angle) * radius,
          z: Math.sin(angle) * radius,
          y: tuning.arc + (i % 3) * 0.18,
          scale: (1.25 + (i % 4) * 0.24) * tuning.size,
          phase: i * 7,
          opacity: (0.24 + (i % 3) * 0.04) * tuning.intensity,
        };
      }),
    [count, tuning],
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

  useEffect(() => () => {
    for (const texture of frameTextures) texture.dispose();
  }, [frameTextures]);

  useFrame((_, delta) => {
    elapsedRef.current += delta;
    const frameRate = 18 * clamp(tuning.speed, 0.25, 3);
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
    <group position={anchor.position} scale={[effectScale, effectScale, effectScale]}>
      {puffs.map((puff, i) => (
        <Billboard key={i} position={[puff.x, puff.y, puff.z]}>
          <mesh scale={[puff.scale, puff.scale, puff.scale]} raycast={() => null}>
            <planeGeometry args={[2.15, 2.15]} />
            <meshBasicMaterial
              map={frameTextures[i]}
              color={tuning.color}
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
      <pointLight color={tuning.secondaryColor} intensity={1.2 * tuning.intensity} distance={5 * tuning.spread} position={[0, 1.2, 0]} />
    </group>
  );
}

function ModelAnchorGlow({
  anchor,
  modelScale,
}: {
  anchor: ShowcaseModelAnchor;
  modelScale: number;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const effectScale = modelScale > 0 ? 1 / modelScale : 1;

  useFrame(({ clock }) => {
    const pulse = (Math.sin(clock.elapsedTime * 4.8) + 1) / 2;
    if (meshRef.current) meshRef.current.scale.setScalar((0.2 + pulse * 0.04) * 0.3);
    if (matRef.current) matRef.current.opacity = 0.12 + pulse * 0.24;
    if (lightRef.current) lightRef.current.intensity = 0.55 + pulse * 1.15;
  });

  return (
    <group position={anchor.position} scale={[effectScale, effectScale, effectScale]}>
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
      <pointLight ref={lightRef} color="#f97316" intensity={0.8} distance={1.8} />
    </group>
  );
}

function DamageGlowCore({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const coreRef = useRef<THREE.Mesh>(null);
  const shellRef = useRef<THREE.Mesh>(null);
  const coreMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const shellMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);

  useFrame(({ clock }) => {
    const pulse = (Math.sin(clock.elapsedTime * 4.8 * tuning.speed) + 1) / 2;
    const size = tuning.size * (1 + pulse * 0.08);
    if (coreRef.current) coreRef.current.scale.setScalar(size);
    if (shellRef.current) shellRef.current.scale.setScalar(tuning.size * (1.18 + pulse * 0.1));
    if (coreMatRef.current) coreMatRef.current.opacity = (0.62 + pulse * 0.28) * tuning.intensity;
    if (shellMatRef.current) shellMatRef.current.opacity = (0.18 + pulse * 0.22) * tuning.intensity;
    if (lightRef.current) lightRef.current.intensity = (1.8 + pulse * 2.8) * tuning.intensity;
  });

  return (
    <group position={[position[0], 1.2, position[1]]}>
      <mesh ref={shellRef} raycast={() => null}>
        <sphereGeometry args={[0.34, 32, 20]} />
        <meshBasicMaterial
          ref={shellMatRef}
          color={tuning.color}
          transparent
          opacity={0.28}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh ref={coreRef} raycast={() => null}>
        <sphereGeometry args={[0.14, 24, 16]} />
        <meshBasicMaterial
          ref={coreMatRef}
          color={tuning.secondaryColor}
          transparent
          opacity={0.78}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <pointLight ref={lightRef} color={tuning.color} intensity={2.4} distance={5} />
    </group>
  );
}

function CloudFlipbookDamageEmitter({
  position,
  tuning,
  textureFilename,
  paused,
}: {
  position: Vec2;
  tuning: Tuning;
  textureFilename: string;
  paused: boolean;
}) {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const revision =
    SHOWCASE_TEXTURE_ASSET_REVISIONS[textureFilename.toLowerCase()] ?? "vfx-range";
  const url = `${basePath}/api/textures/${textureFilename}?v=${encodeURIComponent(revision)}`;
  const sourceTexture = useLoader(THREE.TextureLoader, url);
  const elapsedRef = useRef(0);
  const count = clamp(Math.round(tuning.count), 1, 12);
  const columns = 8;
  const rows = 8;
  const frameCount = columns * rows;

  const puffs = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const angle = i * 2.399;
        const radius = (0.18 + (i % 4) * 0.16) * tuning.spread;
        return {
          x: Math.cos(angle) * radius,
          z: Math.sin(angle) * radius,
          y: 1.1 + (i % 3) * 0.18 + tuning.arc,
          scale: (1.25 + (i % 4) * 0.24) * tuning.size,
          phase: i * 7,
          opacity: (0.24 + (i % 3) * 0.04) * tuning.intensity,
        };
      }),
    [count, tuning.arc, tuning.intensity, tuning.size, tuning.spread],
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

  useEffect(() => () => {
    for (const texture of frameTextures) texture.dispose();
  }, [frameTextures]);

  useFrame((_, delta) => {
    if (!paused) elapsedRef.current += delta;
    const frameRate = 18 * clamp(tuning.speed, 0.25, 3);
    for (let i = 0; i < frameTextures.length; i += 1) {
      const texture = frameTextures[i];
      const frame = Math.floor(elapsedRef.current * frameRate + (puffs[i]?.phase ?? 0)) % frameCount;
      const column = frame % columns;
      const row = Math.floor(frame / columns);
      texture.offset.x = column / columns;
      texture.offset.y = 1 - (row + 1) / rows;
    }
  });

  return (
    <group position={[position[0], 0, position[1]]}>
      {puffs.map((puff, i) => (
        <Billboard key={i} position={[puff.x, puff.y, puff.z]}>
          <mesh scale={[puff.scale, puff.scale, puff.scale]} raycast={() => null}>
            <planeGeometry args={[2.15, 2.15]} />
            <meshBasicMaterial
              map={frameTextures[i]}
              color={tuning.color}
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
      <pointLight color={tuning.secondaryColor} intensity={1.2 * tuning.intensity} distance={5 * tuning.spread} position={[0, 1.2, 0]} />
    </group>
  );
}

function ModelAnchorEffect({
  anchor,
  modelScale,
}: {
  anchor: ShowcaseModelAnchor;
  modelScale: number;
}) {
  if (anchor.name.startsWith("wreck_smoke") || anchor.name.startsWith("smoke_light")) {
    return <ModelAnchorSmoke anchor={anchor} modelScale={modelScale} />;
  }
  if (anchor.name.startsWith("small_glow")) {
    return <ModelAnchorGlow anchor={anchor} modelScale={modelScale} />;
  }
  return null;
}

function ExplodingHullPulse({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);

  useFrame(({ clock }) => {
    const pulse = (Math.sin(clock.elapsedTime * 5.2 * tuning.speed) + 1) / 2;
    if (meshRef.current) {
      meshRef.current.scale.setScalar((1.15 + pulse * 0.18) * tuning.size);
    }
    if (matRef.current) {
      matRef.current.opacity = (0.08 + pulse * 0.22) * tuning.intensity;
    }
    if (lightRef.current) {
      lightRef.current.intensity = (1.2 + pulse * 4.5) * tuning.intensity;
    }
  });

  return (
    <group position={[position[0], 1.35, position[1]]}>
      <mesh ref={meshRef} raycast={() => null}>
        <sphereGeometry args={[1.45, 32, 16]} />
        <meshBasicMaterial
          ref={matRef}
          color={tuning.color}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <pointLight ref={lightRef} color={tuning.color} intensity={0} distance={8} />
    </group>
  );
}

function ExplodingOriginSmoke({ tuning }: { tuning: Tuning }) {
  const groupRef = useRef<THREE.Group>(null);
  const plumeColors = ["#ef4444", "#f97316", "#facc15", "#fde68a"];
  const particles = useMemo(
    () =>
      Array.from({ length: 16 }, (_, i) => ({
        angle: i * 2.399,
        radius: 0.1 + (i % 5) * 0.035,
        speed: 0.18 + (i % 4) * 0.035,
        offset: i * 0.13,
        size: 0.14 + (i % 4) * 0.04,
      })),
    [],
  );

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    groupRef.current.children.forEach((child, i) => {
      const p = particles[i];
      if (!p) return;
      const t = (clock.elapsedTime * p.speed * tuning.speed + p.offset) % 1;
      child.position.set(
        Math.cos(p.angle + t * 0.7) * p.radius * (1 + t * 2.2),
        t * 1.25,
        Math.sin(p.angle + t * 0.7) * p.radius * (1 + t * 2.2),
      );
      child.scale.setScalar(p.size * (0.85 + t * 1.45) * tuning.size);
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = 0.22 * (1 - t) * tuning.intensity;
    });
  });

  return (
    <group ref={groupRef}>
      {particles.map((_, i) => (
        <mesh key={i} raycast={() => null}>
          <sphereGeometry args={[1, 12, 10]} />
          <meshBasicMaterial
            color={plumeColors[i % plumeColors.length]}
            transparent
            opacity={0}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}

function HullStateFxStation({ station, tuning, selected, showLabel }: { station: HullStateStation; tuning: Tuning; selected: boolean; showLabel: boolean }) {
  const modelGroupRef = useRef<THREE.Group>(null);
  const staticRotation = useMemo<[number, number, number]>(() => {
    if (station.mode === "adrift-askew") return [THREE.MathUtils.degToRad(18), 0, THREE.MathUtils.degToRad(-23)];
    if (station.mode === "destroyed") return [THREE.MathUtils.degToRad(7), 0, THREE.MathUtils.degToRad(5)];
    return [0, 0, 0];
  }, [station.mode]);
  const modelTint =
    station.mode === "intact"
      ? "#dbeafe"
      : station.mode === "exploding"
        ? "#fecaca"
        : "#94a3b8";
  const markerColor =
    station.mode === "exploding"
      ? "#ef4444"
      : station.mode === "destroyed"
        ? "#64748b"
        : station.mode === "intact"
          ? "#38bdf8"
          : "#facc15";

  useFrame(({ clock }) => {
    if (!modelGroupRef.current || station.mode !== "adrift-tumble") return;
    const t = clock.elapsedTime * tuning.speed;
    modelGroupRef.current.rotation.x = THREE.MathUtils.degToRad(9 + Math.sin(t * 0.83) * 8);
    modelGroupRef.current.rotation.y = Math.sin(t * 0.42) * 0.12;
    modelGroupRef.current.rotation.z = THREE.MathUtils.degToRad(-11 + Math.cos(t * 0.71) * 9);
  });

  return (
    <group>
      <EndpointMarker position={station.position} color={markerColor} selected={selected} />
      <group position={[station.position[0], 0, station.position[1]]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]} raycast={() => null}>
          <ringGeometry args={[1.25, 1.42, 64]} />
          <meshBasicMaterial color={markerColor} transparent opacity={selected ? 0.9 : 0.42} />
        </mesh>
        <group ref={modelGroupRef} position={[0, 1.35, 0]} rotation={staticRotation}>
          <Suspense fallback={null}>
            <ShowcaseGlbModel
              filename={station.modelFilename}
              tint={modelTint}
              opacity={station.mode === "destroyed" ? 0.92 : 1}
              emissiveColor={station.mode === "exploding" ? tuning.color : tuning.secondaryColor}
              emissiveIntensity={station.mode === "exploding" ? 0.85 : 0.08 * tuning.intensity}
              emissivePulse={station.mode === "exploding"}
              anchorEffects={station.mode === "destroyed"}
            />
          </Suspense>
        </group>
      </group>
      {station.mode === "exploding" ? (
        <>
          <group position={[station.position[0], 1.35, station.position[1]]}>
            <ExplodingOriginSmoke tuning={tuning} />
          </group>
          <ExplodingHullPulse position={station.position} tuning={tuning} />
        </>
      ) : null}
      {showLabel ? <StationLabel station={station} selected={selected} /> : null}
    </group>
  );
}

function BeamPreview({ from, to, tuning }: { from: THREE.Vector3; to: THREE.Vector3; tuning: Tuning }) {
  const coreRef = useRef<THREE.MeshBasicMaterial>(null);
  const haloRef = useRef<THREE.MeshBasicMaterial>(null);
  const { mid, quat, len } = useMemo(() => {
    const dir = new THREE.Vector3().subVectors(to, from);
    const length = dir.length();
    const midpoint = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    return { mid: midpoint, quat: q, len: length };
  }, [from, to]);

  useFrame(({ clock }) => {
    const cycle = 2.6 / clamp(tuning.speed, 0.25, 3);
    const t = (clock.elapsedTime % cycle) / cycle;
    const a = phaseAlpha(t, tuning.fade);
    if (coreRef.current) coreRef.current.opacity = a * clamp(tuning.intensity, 0.1, 3);
    if (haloRef.current) haloRef.current.opacity = a * 0.34 * clamp(tuning.intensity, 0.1, 3);
  });

  const thickness = 0.018 * tuning.thickness * tuning.size;
  return (
    <group position={mid.toArray()} quaternion={quat}>
      <mesh raycast={() => null}>
        <cylinderGeometry args={[thickness, thickness, len, 8, 1]} />
        <meshBasicMaterial ref={coreRef} color={tuning.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh raycast={() => null}>
        <cylinderGeometry args={[thickness * 3.8, thickness * 3.8, len, 12, 1]} />
        <meshBasicMaterial ref={haloRef} color={tuning.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

function ProjectilePreview({
  from,
  to,
  tuning,
  index,
  missile = false,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  tuning: Tuning;
  index: number;
  missile?: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const trailRef = useRef<THREE.MeshBasicMaterial>(null);
  const ribbonRef = useRef<THREE.Mesh>(null);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const projectileShape = tuning.projectileShape ?? "sphere";
  const cylinderLength = tuning.cylinderLength ?? 1.3;

  const pointAt = (t: number) => {
    const x = from.x + (to.x - from.x) * t;
    const z = from.z + (to.z - from.z) * t;
    const yLinear = from.y + (to.y - from.y) * t;
    const y = yLinear + (missile ? Math.sin(Math.PI * t) * tuning.arc * (1 + (index % 2) * 0.25) : 0);
    return new THREE.Vector3(x, y, z);
  };

  const directionAt = (t: number) => {
    const ahead = pointAt(clamp(t + 0.01, 0, 1));
    const behind = pointAt(clamp(t - 0.01, 0, 1));
    return ahead.sub(behind).normalize();
  };

  useFrame(({ clock }) => {
    if (!groupRef.current || !matRef.current || !trailRef.current) return;
    const count = Math.max(1, tuning.count);
    const delay = index * (missile ? 0.18 : 0.075);
    const duration = (missile ? 1.25 : 0.48) / clamp(tuning.speed, 0.25, 3);
    const cycle = delay + duration + 0.55 * tuning.fade + 0.6;
    const elapsed = ((clock.elapsedTime + index * 0.02) % cycle) - delay;
    if (elapsed < 0) {
      matRef.current.opacity = 0;
      trailRef.current.opacity = 0;
      if (ribbonRef.current) ribbonRef.current.visible = false;
      return;
    }
    const t = clamp(elapsed / duration, 0, 1);
    const current = pointAt(t);
    groupRef.current.position.copy(current);
    if (projectileShape === "cylinder") groupRef.current.quaternion.setFromUnitVectors(up, directionAt(t));
    if (t < 1) {
      matRef.current.opacity = clamp(tuning.intensity, 0.1, 3);
      trailRef.current.opacity = 0.42 * clamp(tuning.intensity, 0.1, 3);
    } else if (projectileShape === "cylinder") {
      matRef.current.opacity = 0;
      trailRef.current.opacity = 0;
    } else {
      const a = clamp(1 - ((elapsed - duration) / (0.34 * tuning.fade)), 0, 1);
      matRef.current.opacity = a;
      trailRef.current.opacity = a * 0.42;
    }

    if (missile && ribbonRef.current) {
      const tail = pointAt(Math.max(0, t - 0.12));
      const localTail = tail.sub(current);
      const len = localTail.length();
      ribbonRef.current.visible = len > 0.01 && trailRef.current.opacity > 0.01;
      if (ribbonRef.current.visible) {
        ribbonRef.current.position.copy(localTail).multiplyScalar(0.5);
        ribbonRef.current.quaternion.setFromUnitVectors(up, localTail.clone().normalize());
        ribbonRef.current.scale.set(0.18 * tuning.size, len, 1);
      }
    }
  });

  const size = (missile ? 0.065 : 0.16) * tuning.size;
  return (
    <group ref={groupRef}>
      <mesh raycast={() => null}>
        {projectileShape === "cylinder" ? (
          <cylinderGeometry args={[size * 0.62, size * 0.62, cylinderLength * tuning.size, 12, 1]} />
        ) : (
          <sphereGeometry args={[size, 10, 10]} />
        )}
        <meshBasicMaterial ref={matRef} color={tuning.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      {missile ? (
        <mesh ref={ribbonRef} visible={false} raycast={() => null}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial ref={trailRef} color={tuning.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      ) : (
        <mesh raycast={() => null}>
          <sphereGeometry args={[size * 2.5, 10, 10]} />
          <meshBasicMaterial ref={trailRef} color={tuning.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

function MissileEngineGlow({
  position,
  modelScale,
  color,
  secondaryColor,
  intensity,
  flareSize,
}: {
  position: THREE.Vector3;
  modelScale: number;
  color: string;
  secondaryColor: string;
  intensity: number;
  flareSize: number;
}) {
  const coreRef = useRef<THREE.MeshBasicMaterial>(null);
  const haloRef = useRef<THREE.MeshBasicMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const effectScale = modelScale > 0 ? 1 / modelScale : 1;

  useFrame(({ clock }) => {
    const pulse = (Math.sin(clock.elapsedTime * 18) + 1) / 2;
    if (coreRef.current) coreRef.current.opacity = 0.74 + pulse * 0.2;
    if (haloRef.current) haloRef.current.opacity = (0.18 + pulse * 0.16) * intensity;
    if (lightRef.current) lightRef.current.intensity = (0.7 + pulse * 1.3) * intensity;
  });

  return (
    <group position={position.toArray()} scale={[effectScale, effectScale, effectScale]}>
      <mesh raycast={() => null}>
        <sphereGeometry args={[0.014 * flareSize, 14, 14]} />
        <meshBasicMaterial ref={coreRef} color={secondaryColor} transparent opacity={0.8} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh raycast={() => null}>
        <sphereGeometry args={[0.042 * flareSize, 18, 18]} />
        <meshBasicMaterial ref={haloRef} color={color} transparent opacity={0.2} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <pointLight ref={lightRef} color={color} intensity={0.9} distance={0.38 * flareSize} />
    </group>
  );
}

function MissileTextureFlare({
  filename,
  color,
  intensity,
  flareSize,
}: {
  filename: string;
  color: string;
  intensity: number;
  flareSize: number;
}) {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const revision =
    SHOWCASE_TEXTURE_ASSET_REVISIONS[filename.toLowerCase()] ?? "vfx-range";
  const url = `${basePath}/api/textures/${filename}?v=${encodeURIComponent(revision)}`;
  const texture = useLoader(THREE.TextureLoader, url);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const length = 0.34 * flareSize;
  const height = 0.16 * flareSize;

  useMemo(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
  }, [texture]);

  useFrame(({ clock }) => {
    const pulse = (Math.sin(clock.elapsedTime * 14) + 1) / 2;
    if (matRef.current) matRef.current.opacity = (0.5 + pulse * 0.22) * intensity;
    if (lightRef.current) lightRef.current.intensity = (0.7 + pulse * 1.1) * intensity;
  });

  return (
    <group position={[0, 0, -length / 2]} rotation={[0, Math.PI / 2, 0]}>
      <mesh raycast={() => null} renderOrder={5}>
        <planeGeometry args={[length, height]} />
        <meshBasicMaterial
          ref={matRef}
          map={texture}
          color={color}
          transparent
          opacity={0.7 * intensity}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
      <pointLight
        ref={lightRef}
        color={color}
        intensity={1}
        distance={0.4 * flareSize}
      />
    </group>
  );
}

function MissileMeshModel({
  filename,
  textureFilename,
  textureFlare,
  tint,
  glowColor,
  glowCoreColor,
  intensity,
  targetSize,
  flareSize,
}: {
  filename: string;
  textureFilename?: string;
  textureFlare?: boolean;
  tint: string;
  glowColor: string;
  glowCoreColor: string;
  intensity: number;
  targetSize: number;
  flareSize: number;
}) {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const revision =
    SHOWCASE_MODEL_ASSET_REVISIONS[filename.toLowerCase()] ?? "vfx-range";
  const url = `${basePath}/api/models/${filename}?v=${encodeURIComponent(revision)}`;
  const { scene } = useGLTF(url);
  const useOriginEngineFlare = filename.toLowerCase() === "missile1.glb";

  const { cloned, scale, engineAnchor } = useMemo(() => {
    const c = scene.clone(true);
    const tintColor = new THREE.Color(tint);
    const anchor = new THREE.Vector3(0, 0, 0);
    let anchorNode: THREE.Object3D | undefined;

    c.traverse((child: any) => {
      const childName = String(child.name ?? "").trim().toLowerCase();
      if (!useOriginEngineFlare && (childName === "engine flare" || childName === "missileflare" || childName === "missile flare")) anchorNode = child;
      if (!child.isMesh) return;
      child.castShadow = true;
      child.receiveShadow = true;
      const sourceMaterials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      const materials = sourceMaterials.map((material: THREE.Material | undefined) => {
        const clonedMaterial = material?.clone
          ? material.clone()
          : new THREE.MeshStandardMaterial({ color: "#d1d5db" });
        const adjustable = clonedMaterial as THREE.Material & {
          color?: THREE.Color;
          emissive?: THREE.Color;
          emissiveIntensity?: number;
        };
        if (adjustable.color instanceof THREE.Color) {
          adjustable.color = adjustable.color.clone().lerp(tintColor, 0.08);
        }
        if (adjustable.emissive instanceof THREE.Color) {
          adjustable.emissive = tintColor.clone();
          adjustable.emissiveIntensity = 0.04;
        }
        return clonedMaterial;
      });
      child.material = Array.isArray(child.material) ? materials : materials[0];
    });

    c.updateMatrixWorld(true);
    if (anchorNode) {
      const rootWorld = new THREE.Vector3();
      const anchorWorld = new THREE.Vector3();
      c.getWorldPosition(rootWorld);
      anchorNode.getWorldPosition(anchorWorld);
      anchor.copy(anchorWorld.sub(rootWorld));
    }
    const scaledModel = showcaseShipScale(c, targetSize);
    const scaledAnchor = anchor.multiplyScalar(scaledModel);

    return {
      cloned: c,
      scale: scaledModel,
      engineAnchor: scaledAnchor,
    };
  }, [scene, targetSize, tint, useOriginEngineFlare]);

  return (
    <group>
      <primitive object={cloned} scale={[scale, scale, scale]} />
      {textureFlare && textureFilename ? (
        <MissileTextureFlare
          filename={textureFilename}
          color={glowColor}
          intensity={intensity}
          flareSize={flareSize}
        />
      ) : (
        <MissileEngineGlow
          position={engineAnchor}
          modelScale={1}
          color={glowColor}
          secondaryColor={glowCoreColor}
          intensity={intensity}
          flareSize={flareSize}
        />
      )}
    </group>
  );
}

const MESH_MISSILE_FLIGHT_SECONDS = 3;
const MESH_MISSILE_LAUNCH_DELAYS_SECONDS = [0, 0.5, 1.2] as const;

function meshMissileLaunchDelaySeconds(index: number): number {
  return MESH_MISSILE_LAUNCH_DELAYS_SECONDS[index] ?? MESH_MISSILE_LAUNCH_DELAYS_SECONDS[MESH_MISSILE_LAUNCH_DELAYS_SECONDS.length - 1];
}

function MeshMissileRound({
  filename,
  textureFilename,
  textureFlare,
  from,
  to,
  tuning,
  index,
  paused,
  timelineRef,
  cycleDuration,
}: {
  filename: string;
  textureFilename?: string;
  textureFlare?: boolean;
  from: THREE.Vector3;
  to: THREE.Vector3;
  tuning: Tuning;
  index: number;
  paused: boolean;
  timelineRef?: MutableRefObject<number>;
  cycleDuration?: number;
}) {
  const missileRef = useRef<THREE.Group>(null);
  const smokeTrailRef = useRef<THREE.Group>(null);
  const localElapsedRef = useRef(0);
  const forward = useMemo(() => new THREE.Vector3(0, 0, 1), []);
  const smokePuffs = useMemo(
    () =>
      Array.from({ length: 21 }, (_, i) => ({
        lag: 0.025 + i * 0.014,
        side: ((i % 3) - 1) * 0.035,
        lift: 0.015 + (i % 2) * 0.012,
        size: 0.045 + i * 0.005,
      })),
    [],
  );

  const flight = useMemo(() => {
    const dir = new THREE.Vector3().subVectors(to, from).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
    const offsets = [-0.42, -0.14, 0.14, 0.42];
    const start = from.clone().add(side.multiplyScalar(offsets[index % offsets.length] ?? 0));
    start.y += 0.12 + (index % 2) * 0.08;
    const end = to.clone().add(new THREE.Vector3((index - 1.5) * 0.12, 0.08, 0));
    return { start, end };
  }, [from, index, to]);

  const pointAt = useCallback(
    (t: number) => {
      const p = flight.start.clone().lerp(flight.end, t);
      p.y += Math.sin(Math.PI * t) * tuning.arc * (1 + (index % 2) * 0.12);
      return p;
    },
    [flight.end, flight.start, index, tuning.arc],
  );

  const directionAt = useCallback(
    (t: number) => {
      const ahead = pointAt(clamp(t + 0.012, 0, 1));
      const behind = pointAt(clamp(t - 0.012, 0, 1));
      return ahead.sub(behind).normalize();
    },
    [pointAt],
  );

  useFrame((_, delta) => {
    const group = missileRef.current;
    const smokeTrail = smokeTrailRef.current;
    if (!group || (!textureFlare && !smokeTrail)) return;
    if (!timelineRef && !paused) localElapsedRef.current += delta;

    const duration = MESH_MISSILE_FLIGHT_SECONDS;
    const delay = meshMissileLaunchDelaySeconds(index);
    const cycle = cycleDuration ?? duration + meshMissileLaunchDelaySeconds(2) + 1.4;
    const timelineSeconds = timelineRef?.current ?? localElapsedRef.current;
    const elapsed = (timelineSeconds % cycle) - delay;
    if (elapsed < 0) {
      group.visible = false;
      if (smokeTrail) smokeTrail.visible = false;
      return;
    }

    const t = clamp(elapsed / duration, 0, 1);
    const current = pointAt(t);
    const direction = directionAt(t);
    const visible = t < 1;
    group.visible = visible;
    group.position.copy(current);
    group.quaternion.setFromUnitVectors(forward, direction);

    if (textureFlare) {
      if (smokeTrail) smokeTrail.visible = false;
      return;
    }

    if (!smokeTrail) return;
    smokeTrail.visible = visible && t > 0.025;
    if (smokeTrail.visible) {
      const side = new THREE.Vector3(-direction.z, 0, direction.x).normalize();
      smokeTrail.children.forEach((child, puffIndex) => {
        const puff = smokePuffs[puffIndex];
        if (!puff) return;
        const lagT = clamp(t - puff.lag, 0, 1);
        const smokePoint = pointAt(lagT)
          .add(side.clone().multiplyScalar(puff.side * (1 + t)))
          .add(new THREE.Vector3(0, puff.lift + puffIndex * 0.006, 0));
        child.position.copy(smokePoint);
        child.scale.setScalar(puff.size * tuning.size * (1 + puffIndex * 0.22));
        const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
        mat.opacity = lagT <= 0 ? 0 : 0.18 * tuning.intensity * (1 - puffIndex / smokePuffs.length);
      });
    }
  });

  return (
    <>
      <group ref={missileRef} visible={false}>
        <Suspense fallback={null}>
          <MissileMeshModel
            filename={filename}
            textureFilename={textureFilename}
            textureFlare={textureFlare}
            tint="#d1d5db"
            glowColor={tuning.color}
            glowCoreColor={tuning.secondaryColor}
            intensity={tuning.intensity}
            targetSize={tuning.meshSize ?? 0.4}
            flareSize={tuning.flareSize ?? 1}
          />
        </Suspense>
      </group>
      {textureFlare ? null : (
        <group ref={smokeTrailRef} visible={false}>
          {smokePuffs.map((_, smokeIndex) => (
            <mesh key={smokeIndex} raycast={() => null}>
              <sphereGeometry args={[1, 12, 10]} />
              <meshBasicMaterial
                color="#9ca3af"
                transparent
                opacity={0}
                depthWrite={false}
              />
            </mesh>
          ))}
        </group>
      )}
    </>
  );
}

function MeshMissileSalvo({
  station,
  tuning,
  paused,
  timelineRef,
  cycleDuration,
}: {
  station: SpecialStation;
  tuning: Tuning;
  paused: boolean;
  timelineRef?: MutableRefObject<number>;
  cycleDuration?: number;
}) {
  const from = useMemo(() => toVector3(station.position, 1.28), [station.position]);
  const targetPosition = station.to ?? [station.position[0] + 18, station.position[1] + 8];
  const to = useMemo(() => toVector3(targetPosition, 1.15), [targetPosition]);
  const filename = station.modelFilename ?? "missile.glb";
  const textureFilename = station.textureFilename;
  const textureFlare = station.effect === "texture-missile-salvo" || station.effect === "missile-impact-flipbook-test";
  const count = station.effect === "missile-impact-flipbook-test" ? 3 : clamp(Math.round(tuning.count), 1, 5);

  return (
    <group>
      <EndpointMarker position={station.position} color="#38bdf8" />
      <EndpointMarker position={targetPosition} color="#f97316" />
      {Array.from({ length: count }).map((_, i) => (
        <MeshMissileRound
          key={`${station.id}-${i}`}
          filename={filename}
          textureFilename={textureFilename}
          textureFlare={textureFlare}
          from={from}
          to={to}
          tuning={tuning}
          index={i}
          paused={paused}
          timelineRef={timelineRef}
          cycleDuration={cycleDuration}
        />
      ))}
    </group>
  );
}

function StandaloneFlipbookPreview({
  position,
  textureFilename,
  tuning,
  paused,
}: {
  position: Vec2;
  textureFilename: string;
  tuning: Tuning;
  paused: boolean;
}) {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const revision =
    SHOWCASE_TEXTURE_ASSET_REVISIONS[textureFilename.toLowerCase()] ?? "vfx-range";
  const url = `${basePath}/api/textures/${textureFilename}?v=${encodeURIComponent(revision)}`;
  const sourceTexture = useLoader(THREE.TextureLoader, url);
  const elapsedRef = useRef(0);
  const mainMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const glowMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const columns = 5;
  const rows = 5;
  const frameCount = columns * rows;

  const { mainTexture, glowTexture } = useMemo(() => {
    const configure = (texture: THREE.Texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.repeat.set(1 / columns, 1 / rows);
      texture.needsUpdate = true;
      return texture;
    };
    return {
      mainTexture: configure(sourceTexture.clone()),
      glowTexture: configure(sourceTexture.clone()),
    };
  }, [sourceTexture]);

  useEffect(() => () => {
    mainTexture.dispose();
    glowTexture.dispose();
  }, [glowTexture, mainTexture]);

  useFrame((_, delta) => {
    if (!paused) elapsedRef.current += delta;
    const cycle = 1.35 / clamp(tuning.speed, 0.25, 3);
    const t = (elapsedRef.current % cycle) / cycle;
    const frame = clamp(Math.floor(t * frameCount), 0, frameCount - 1);
    const column = frame % columns;
    const row = Math.floor(frame / columns);

    for (const texture of [mainTexture, glowTexture]) {
      texture.offset.x = column / columns;
      texture.offset.y = 1 - (row + 1) / rows;
    }

    const bloom = Math.sin(Math.PI * t);
    if (mainMatRef.current) mainMatRef.current.opacity = (0.76 + bloom * 0.18) * tuning.intensity;
    if (glowMatRef.current) glowMatRef.current.opacity = bloom * 0.5 * tuning.intensity;
    if (lightRef.current) lightRef.current.intensity = (0.9 + bloom * 5.5) * tuning.intensity;
  });

  const scale = 1.25 * tuning.size;
  return (
    <group position={[position[0], 1.6, position[1]]}>
      <Billboard>
        <mesh scale={[scale, scale, scale]} raycast={() => null} renderOrder={8}>
          <planeGeometry args={[2.6, 2.6]} />
          <meshBasicMaterial
            ref={mainMatRef}
            map={mainTexture}
            color={tuning.color}
            transparent
            opacity={0}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
        <mesh scale={[scale * 0.82, scale * 0.82, scale * 0.82]} raycast={() => null} renderOrder={9}>
          <planeGeometry args={[2.6, 2.6]} />
          <meshBasicMaterial
            ref={glowMatRef}
            map={glowTexture}
            color={tuning.secondaryColor}
            transparent
            opacity={0}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
      </Billboard>
      <pointLight ref={lightRef} color={tuning.secondaryColor} intensity={0} distance={7 * tuning.spread} />
    </group>
  );
}

function FlipbookExplosionImpact({
  position,
  textureFilename,
  tuning,
  paused,
  delaySeconds = MESH_MISSILE_FLIGHT_SECONDS,
  timelineRef,
  cycleDuration,
}: {
  position: THREE.Vector3;
  textureFilename: string;
  tuning: Tuning;
  paused: boolean;
  delaySeconds?: number;
  timelineRef?: MutableRefObject<number>;
  cycleDuration?: number;
}) {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const revision =
    SHOWCASE_TEXTURE_ASSET_REVISIONS[textureFilename.toLowerCase()] ?? "vfx-range";
  const url = `${basePath}/api/textures/${textureFilename}?v=${encodeURIComponent(revision)}`;
  const sourceTexture = useLoader(THREE.TextureLoader, url);
  const localElapsedRef = useRef(0);
  const mainMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const glowMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const columns = 5;
  const rows = 5;
  const frameCount = columns * rows;
  const impactDelay = delaySeconds;
  const activeDuration = 1.25;
  const cycle = cycleDuration ?? impactDelay + activeDuration + 1.15;

  const { mainTexture, glowTexture } = useMemo(() => {
    const configure = (texture: THREE.Texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.repeat.set(1 / columns, 1 / rows);
      texture.needsUpdate = true;
      return texture;
    };
    return {
      mainTexture: configure(sourceTexture.clone()),
      glowTexture: configure(sourceTexture.clone()),
    };
  }, [sourceTexture]);

  useEffect(() => () => {
    mainTexture.dispose();
    glowTexture.dispose();
  }, [glowTexture, mainTexture]);

  useFrame((_, delta) => {
    if (!timelineRef && !paused) localElapsedRef.current += delta;
    const elapsed = (timelineRef?.current ?? localElapsedRef.current) % cycle;
    const activeT = (elapsed - impactDelay) / activeDuration;
    const visible = activeT >= 0 && activeT <= 1;
    const frame = clamp(Math.floor(activeT * frameCount), 0, frameCount - 1);
    const column = frame % columns;
    const row = Math.floor(frame / columns);

    for (const texture of [mainTexture, glowTexture]) {
      texture.offset.x = column / columns;
      texture.offset.y = 1 - (row + 1) / rows;
    }

    const bloom = visible ? Math.sin(Math.PI * clamp(activeT, 0, 1)) : 0;
    if (mainMatRef.current) mainMatRef.current.opacity = visible ? (0.78 + bloom * 0.18) * tuning.intensity : 0;
    if (glowMatRef.current) glowMatRef.current.opacity = visible ? bloom * 0.62 * tuning.intensity : 0;
    if (lightRef.current) lightRef.current.intensity = visible ? (1.5 + bloom * 8) * tuning.intensity : 0;
  });

  const scale = 0.775 * tuning.size;
  return (
    <group position={position.toArray()}>
      <Billboard position={[0, 0.35, 0]}>
        <mesh scale={[scale, scale, scale]} raycast={() => null} renderOrder={8}>
          <planeGeometry args={[2.3, 2.3]} />
          <meshBasicMaterial
            ref={mainMatRef}
            map={mainTexture}
            transparent
            opacity={0}
            depthWrite={false}
            depthTest={false}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
        <mesh scale={[scale * 0.74, scale * 0.74, scale * 0.74]} raycast={() => null} renderOrder={9}>
          <planeGeometry args={[2.3, 2.3]} />
          <meshBasicMaterial
            ref={glowMatRef}
            map={glowTexture}
            color={tuning.secondaryColor}
            transparent
            opacity={0}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            depthTest={false}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
      </Billboard>
      <pointLight ref={lightRef} color={tuning.color} intensity={0} distance={8 * tuning.spread} position={[0, 1.2, 0]} />
    </group>
  );
}

function MissileImpactFlipbookTest({ station, tuning, paused }: { station: SpecialStation; tuning: Tuning; paused: boolean }) {
  const targetPosition = station.to ?? [station.position[0] + 18, station.position[1]];
  const targetVector = useMemo(() => toVector3(targetPosition, 1.85), [targetPosition]);
  const salvoTimelineRef = useRef(0);
  const missileCount = 3;
  const cycleDuration = MESH_MISSILE_FLIGHT_SECONDS + meshMissileLaunchDelaySeconds(missileCount - 1) + 1.25 + 1.15;
  const impactTextureFilename = station.impactTextureFilename;
  const impactPositions = useMemo(
    () =>
      Array.from({ length: missileCount }, (_, i) =>
        targetVector.clone().add(new THREE.Vector3((i - 1.5) * 0.12, 0.08 + (i % 2) * 0.05, 0)),
      ),
    [missileCount, targetVector],
  );
  const heading = useMemo(() => {
    const dx = targetPosition[0] - station.position[0];
    const dz = targetPosition[1] - station.position[1];
    return Math.atan2(dx, dz);
  }, [station.position, targetPosition]);

  useFrame((_, delta) => {
    if (!paused) salvoTimelineRef.current += delta;
  });

  return (
    <group>
      <group position={[station.position[0], 1.35, station.position[1]]} rotation={[0, heading, 0]}>
        <Suspense fallback={null}>
          <ShowcaseGlbModel filename="missile-hyperion.glb" tint="#dbeafe" emissiveColor={tuning.color} emissiveIntensity={0.06} />
        </Suspense>
      </group>
      <group position={[targetPosition[0], 1.35, targetPosition[1]]} rotation={[0, heading + Math.PI, 0]}>
        <Suspense fallback={null}>
          <ShowcaseGlbModel filename="hyperion.glb" tint="#dbeafe" emissiveColor={tuning.secondaryColor} emissiveIntensity={0.06} />
        </Suspense>
      </group>
      <MeshMissileSalvo
        station={station}
        tuning={tuning}
        paused={paused}
        timelineRef={salvoTimelineRef}
        cycleDuration={cycleDuration}
      />
      {impactTextureFilename ? (
        impactPositions.map((position, i) => (
          <FlipbookExplosionImpact
            key={`impact-${i}`}
            position={position}
            textureFilename={impactTextureFilename}
            tuning={tuning}
            paused={paused}
            delaySeconds={MESH_MISSILE_FLIGHT_SECONDS + meshMissileLaunchDelaySeconds(i)}
            timelineRef={salvoTimelineRef}
            cycleDuration={cycleDuration}
          />
        ))
      ) : null}
    </group>
  );
}

function ImpactPulse({ position, tuning, delay = 0 }: { position: THREE.Vector3; tuning: Tuning; delay?: number }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);

  useFrame(({ clock }) => {
    const cycle = 1.4 / clamp(tuning.speed, 0.25, 3);
    const t = ((clock.elapsedTime + delay) % cycle) / cycle;
    const alpha = clamp(1 - t, 0, 1) * clamp(tuning.intensity, 0.1, 3);
    if (meshRef.current) meshRef.current.scale.setScalar((0.28 + t * 1.9) * tuning.size);
    if (matRef.current) matRef.current.opacity = alpha;
    if (lightRef.current) lightRef.current.intensity = alpha * 4.5;
  });

  return (
    <group position={position.toArray()}>
      <mesh ref={meshRef} raycast={() => null}>
        <sphereGeometry args={[1, 16, 16]} />
        <meshBasicMaterial ref={matRef} color={tuning.secondaryColor} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <pointLight ref={lightRef} color={tuning.secondaryColor} intensity={0} distance={7} />
    </group>
  );
}

function TunableWeaponStation({ station, tuning, selected, showLabel }: { station: WeaponStation; tuning: Tuning; selected: boolean; showLabel: boolean }) {
  const from = useMemo(() => toVector3(station.from), [station.from]);
  const to = useMemo(() => toVector3(station.to), [station.to]);
  const weaponKind = classifyWeapon(station.weapon);
  const count = clamp(Math.round(tuning.count), 1, weaponKind === "beam" ? 1 : 14);

  return (
    <group>
      <EndpointMarker position={station.from} color="#38bdf8" selected={selected} />
      <EndpointMarker position={station.to} color="#f97316" selected={selected} />
      {weaponKind === "beam" ? (
        <BeamPreview from={from} to={to} tuning={tuning} />
      ) : (
        Array.from({ length: count }).map((_, i) => (
          <ProjectilePreview key={i} from={from} to={to} tuning={tuning} index={i} missile={weaponKind === "missile"} />
        ))
      )}
      {Array.from({ length: clamp(Math.round(station.hits), 1, 6) }).map((_, i) => (
        <ImpactPulse key={i} position={to} tuning={tuning} delay={i * 0.12} />
      ))}
      {showLabel ? <StationLabel station={station} selected={selected} /> : null}
    </group>
  );
}

function FireColumn({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const groupRef = useRef<THREE.Group>(null);
  const count = clamp(Math.round(tuning.count), 4, 40);
  const particles = useMemo(
    () => Array.from({ length: count }, (_, i) => ({
      angle: i * 2.399,
      radius: (0.13 + (i % 5) * 0.08) * tuning.spread,
      speed: (0.48 + (i % 4) * 0.12) * tuning.speed,
      offset: i * 0.19,
      size: (0.18 + (i % 3) * 0.08) * tuning.size,
    })),
    [count, tuning.size, tuning.speed, tuning.spread],
  );

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    groupRef.current.children.forEach((child, i) => {
      const p = particles[i];
      if (!p) return;
      const t = (clock.elapsedTime * p.speed + p.offset) % 1;
      child.position.set(Math.cos(p.angle) * p.radius * (1 + t), 0.25 + t * 1.7 * tuning.spread, Math.sin(p.angle) * p.radius * (1 + t));
      child.scale.setScalar(p.size * (1.4 - t * 0.45));
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = 0.9 * (1 - t) * tuning.intensity;
    });
  });

  return (
    <group position={[position[0], 0.1, position[1]]}>
      <group ref={groupRef}>
        {particles.map((_, i) => (
          <mesh key={i} raycast={() => null}>
            <sphereGeometry args={[1, 10, 10]} />
            <meshBasicMaterial color={i % 3 === 0 ? tuning.secondaryColor : tuning.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
          </mesh>
        ))}
      </group>
      <pointLight color={tuning.color} intensity={3 * tuning.intensity} distance={6} />
    </group>
  );
}

function SmokeColumn({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  return (
    <CloudFlipbookDamageEmitter
      position={position}
      tuning={tuning}
      textureFilename="cloud01-8x8.webp"
      paused={false}
    />
  );
}

function AmbientFxStation({ station, tuning, selected, showLabel }: { station: AmbientStation; tuning: Tuning; selected: boolean; showLabel: boolean }) {
  const position = toVector3(station.position, 0.85);
  return (
    <group>
      <EndpointMarker position={station.position} color={tuning.color} selected={selected} />
      {station.effect === "fire" ? <FireColumn position={station.position} tuning={tuning} /> : null}
      {station.effect === "smoke" ? <SmokeColumn position={station.position} tuning={tuning} /> : null}
      {station.effect === "impact" ? <ImpactPulse position={position} tuning={tuning} /> : null}
      {showLabel ? <StationLabel station={station} selected={selected} /> : null}
    </group>
  );
}

function ShieldRipple({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const shellRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const ringMatRef = useRef<THREE.MeshBasicMaterial>(null);

  useFrame(({ clock }) => {
    const t = (clock.elapsedTime * tuning.speed) % 1;
    if (shellRef.current) shellRef.current.scale.setScalar((1.15 + Math.sin(clock.elapsedTime * 3.2 * tuning.speed) * 0.05) * tuning.size);
    if (ringRef.current) {
      ringRef.current.scale.setScalar((0.35 + t * 2.4) * tuning.size);
      ringRef.current.rotation.y += 0.012 * tuning.speed;
    }
    if (matRef.current) matRef.current.opacity = 0.14 * tuning.intensity;
    if (ringMatRef.current) ringMatRef.current.opacity = (1 - t) * 0.7 * tuning.intensity;
  });

  return (
    <group position={[position[0], 1.0, position[1]]}>
      <mesh ref={shellRef} raycast={() => null}>
        <sphereGeometry args={[1.35, 32, 16]} />
        <meshBasicMaterial ref={matRef} color={tuning.color} transparent opacity={0.14} wireframe blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={ringRef} rotation={[Math.PI / 2, 0, 0]} raycast={() => null}>
        <torusGeometry args={[0.9, 0.018 * tuning.thickness, 8, 80]} />
        <meshBasicMaterial ref={ringMatRef} color={tuning.secondaryColor} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

function InterceptorBurst({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const groupRef = useRef<THREE.Group>(null);
  const count = clamp(Math.round(tuning.count), 4, 18);

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const cycle = (clock.elapsedTime * tuning.speed) % 1;
    groupRef.current.children.forEach((child, i) => {
      const angle = (i / count) * Math.PI * 2 + cycle * Math.PI * 2;
      const radius = (0.55 + cycle * 2.1) * tuning.spread;
      child.position.set(Math.cos(angle) * radius, 0.7 + Math.sin(angle * 2) * 0.18, Math.sin(angle) * radius);
      child.scale.setScalar((0.09 + cycle * 0.08) * tuning.size);
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = (1 - cycle) * tuning.intensity;
    });
  });

  return (
    <group position={[position[0], 0.55, position[1]]} ref={groupRef}>
      {Array.from({ length: count }).map((_, i) => (
        <mesh key={i} raycast={() => null}>
          <sphereGeometry args={[1, 10, 10]} />
          <meshBasicMaterial color={i % 2 ? tuning.secondaryColor : tuning.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

function JumpPoint({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const groupRef = useRef<THREE.Group>(null);
  const shearRef = useRef<THREE.Group>(null);
  const coreMatRef = useRef<THREE.MeshBasicMaterial>(null);

  useFrame(({ clock }) => {
    const pulse = Math.sin(clock.elapsedTime * 2.4 * tuning.speed) * 0.5 + 0.5;
    if (groupRef.current) {
      groupRef.current.rotation.y = clock.elapsedTime * 0.65 * tuning.speed;
      groupRef.current.children.forEach((child, i) => {
        if (!("material" in child)) return;
        const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
        mat.opacity = (0.18 + pulse * 0.28 + i * 0.03) * tuning.intensity;
      });
    }
    if (shearRef.current) {
      shearRef.current.rotation.y = -clock.elapsedTime * 0.95 * tuning.speed;
      shearRef.current.children.forEach((child, i) => {
        if (!("material" in child)) return;
        child.rotation.z = clock.elapsedTime * (0.18 + i * 0.04) * tuning.speed;
        const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
        mat.opacity = (0.1 + pulse * 0.16) * tuning.intensity;
      });
    }
    if (coreMatRef.current) coreMatRef.current.opacity = (0.18 + pulse * 0.35) * tuning.intensity;
  });

  const radius = tuning.size * tuning.spread;
  return (
    <group position={[position[0], 1.0, position[1]]}>
      <group ref={groupRef}>
        <mesh rotation={[Math.PI / 2, 0, 0]} scale={[radius, radius, radius]} raycast={() => null}>
          <torusGeometry args={[1.0, 0.095 * tuning.thickness, 16, 128]} />
          <meshBasicMaterial color={tuning.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, Math.PI / 5]} scale={[radius * 1.42, radius * 1.42, radius * 1.42]} raycast={() => null}>
          <torusGeometry args={[1.0, 0.045 * tuning.thickness, 12, 128]} />
          <meshBasicMaterial color={tuning.secondaryColor} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, -Math.PI / 7]} scale={[radius * 1.85, radius * 1.85, radius * 1.85]} raycast={() => null}>
          <torusGeometry args={[1.0, 0.022 * tuning.thickness, 8, 128]} />
          <meshBasicMaterial color={tuning.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
      <mesh rotation={[Math.PI / 2, 0, 0]} scale={[radius * 1.35, radius * 1.35, radius * 1.35]} raycast={() => null}>
        <circleGeometry args={[1, 96]} />
        <meshBasicMaterial ref={coreMatRef} color={tuning.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      <group ref={shearRef}>
        {Array.from({ length: 4 }).map((_, i) => (
          <mesh key={i} rotation={[Math.PI / 2, 0, (i / 4) * Math.PI]} scale={[radius * 2.15, radius * 0.18 * tuning.thickness, 1]} raycast={() => null}>
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial color={i % 2 ? tuning.secondaryColor : tuning.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
          </mesh>
        ))}
      </group>
      <pointLight color={tuning.color} intensity={5.5 * tuning.intensity} distance={9} />
      <pointLight color={tuning.secondaryColor} intensity={2.5 * tuning.intensity} distance={6} />
    </group>
  );
}

function EnergyMinePulse({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const ringRef = useRef<THREE.Mesh>(null);
  const coreRef = useRef<THREE.Mesh>(null);
  const ringMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const coreMatRef = useRef<THREE.MeshBasicMaterial>(null);

  useFrame(({ clock }) => {
    const t = (clock.elapsedTime * tuning.speed * 0.5) % 1;
    if (ringRef.current) ringRef.current.scale.setScalar((0.6 + t * 5.0) * tuning.size);
    if (coreRef.current) coreRef.current.scale.setScalar((0.35 + Math.sin(t * Math.PI) * 0.4) * tuning.size);
    if (ringMatRef.current) ringMatRef.current.opacity = (1 - t) * 0.8 * tuning.intensity;
    if (coreMatRef.current) coreMatRef.current.opacity = Math.sin(t * Math.PI) * 0.65 * tuning.intensity;
  });

  return (
    <group position={[position[0], 0.45, position[1]]}>
      <mesh ref={ringRef} rotation={[Math.PI / 2, 0, 0]} raycast={() => null}>
        <torusGeometry args={[0.55, 0.02 * tuning.thickness, 8, 96]} />
        <meshBasicMaterial ref={ringMatRef} color={tuning.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={coreRef} raycast={() => null}>
        <sphereGeometry args={[1, 16, 16]} />
        <meshBasicMaterial ref={coreMatRef} color={tuning.secondaryColor} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

function StealthShimmer({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const shellRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);

  useFrame(({ clock }) => {
    const pulse = Math.sin(clock.elapsedTime * 2.6 * tuning.speed) * 0.5 + 0.5;
    if (shellRef.current) {
      shellRef.current.rotation.y += 0.004 * tuning.speed;
      shellRef.current.scale.setScalar((1.15 + pulse * 0.08) * tuning.size);
    }
    if (matRef.current) matRef.current.opacity = (0.08 + pulse * 0.16) * tuning.intensity;
  });

  return (
    <group position={[position[0], 0.95, position[1]]}>
      <mesh ref={shellRef} raycast={() => null}>
        <sphereGeometry args={[1.35, 28, 14]} />
        <meshBasicMaterial ref={matRef} color={tuning.color} transparent opacity={0} wireframe blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <pointLight color={tuning.secondaryColor} intensity={1.5 * tuning.intensity} distance={5} />
    </group>
  );
}

function makeRibbonGeometry({
  height,
  bottomRadius,
  topRadius,
  turns,
  phase,
  width,
  randomness = 0,
  seed = 0,
}: {
  height: number;
  bottomRadius: number;
  topRadius: number;
  turns: number;
  phase: number;
  width: number;
  randomness?: number;
  seed?: number;
}) {
  const segments = 44;
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const wobble =
      Math.sin(t * Math.PI * 5.2 + seed * 1.7) * 0.34 +
      Math.sin(t * Math.PI * 11.3 + seed * 0.83) * 0.18;
    const radiusNoise =
      Math.sin(t * Math.PI * 4.7 + seed * 2.11) * 0.16 +
      Math.sin(t * Math.PI * 8.9 + seed * 1.31) * 0.08;
    const angle = phase + t * Math.PI * 2 * turns + wobble * randomness;
    const radius = (bottomRadius + (topRadius - bottomRadius) * t) * Math.max(0.45, 1 + radiusNoise * randomness);
    const y = t * height;
    const tangent = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle)).multiplyScalar(width * (0.65 + t * 0.45) * (1 + Math.sin(seed + t * Math.PI * 7.1) * 0.08 * randomness));
    const center = new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
    const left = center.clone().add(tangent);
    const right = center.clone().sub(tangent);
    vertices.push(left.x, left.y, left.z, right.x, right.y, right.z);
    if (i < segments) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function makeHorizontalRibbonGeometry({
  length,
  bottomRadius,
  topRadius,
  turns,
  phase,
  width,
  randomness = 0,
  seed = 0,
}: {
  length: number;
  bottomRadius: number;
  topRadius: number;
  turns: number;
  phase: number;
  width: number;
  randomness?: number;
  seed?: number;
}) {
  const segments = 52;
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const wobble =
      Math.sin(t * Math.PI * 5.6 + seed * 1.91) * 0.3 +
      Math.sin(t * Math.PI * 12.4 + seed * 0.77) * 0.16;
    const radiusNoise =
      Math.sin(t * Math.PI * 4.2 + seed * 2.07) * 0.14 +
      Math.sin(t * Math.PI * 9.6 + seed * 1.23) * 0.08;
    const angle = phase + t * Math.PI * 2 * turns + wobble * randomness;
    const radius = (bottomRadius + (topRadius - bottomRadius) * t) * Math.max(0.45, 1 + radiusNoise * randomness);
    const x = t * length;
    const center = new THREE.Vector3(x, Math.cos(angle) * radius, Math.sin(angle) * radius);
    const tangent = new THREE.Vector3(0, -Math.sin(angle), Math.cos(angle)).multiplyScalar(width * (0.72 + t * 0.34) * (1 + Math.sin(seed + t * Math.PI * 7.4) * 0.08 * randomness));
    const left = center.clone().add(tangent);
    const right = center.clone().sub(tangent);
    vertices.push(left.x, left.y, left.z, right.x, right.y, right.z);
    if (i < segments) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function TwistingRibbonVortex({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const groupRef = useRef<THREE.Group>(null);
  const count = clamp(Math.round(tuning.count), 2, 24);
  const randomness = clamp(tuning.randomness ?? 0, 0, 1.5);
  const height = Math.max(1.8, tuning.arc) * tuning.size;
  const ribbons = useMemo(
    () => Array.from({ length: count }, (_, i) => makeRibbonGeometry({
      height,
      bottomRadius: 0.34 * tuning.size,
      topRadius: 1.35 * tuning.spread * tuning.size,
      turns: 1.45 + tuning.thickness * 0.55,
      phase: (i / count) * Math.PI * 2,
      width: 0.07 * tuning.thickness * tuning.size,
      randomness,
      seed: i + 1,
    })),
    [count, height, randomness, tuning.size, tuning.spread, tuning.thickness],
  );

  useFrame(({ clock }) => {
    if (groupRef.current) groupRef.current.rotation.y = clock.elapsedTime * 0.8 * tuning.speed;
    groupRef.current?.children.forEach((child, i) => {
      if (!("material" in child)) return;
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = (0.18 + Math.sin(clock.elapsedTime * 2.2 * tuning.speed + i) * 0.05) * tuning.intensity;
    });
  });

  return (
    <group ref={groupRef} position={[position[0], 0.12, position[1]]}>
      {ribbons.map((geometry, i) => (
        <mesh key={i} geometry={geometry} raycast={() => null}>
          <meshBasicMaterial color={i % 2 ? tuning.secondaryColor : tuning.color} transparent opacity={0.18} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
      <pointLight color={tuning.color} intensity={2.5 * tuning.intensity} distance={7} />
    </group>
  );
}

function HorizontalJumpVortex({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const groupRef = useRef<THREE.Group>(null);
  const originRingRef = useRef<THREE.MeshBasicMaterial>(null);
  const count = clamp(Math.round(tuning.count), 2, 24);
  const randomness = clamp(tuning.randomness ?? 0, 0, 1.5);
  const length = Math.max(3.2, tuning.arc * 1.35) * tuning.size;
  const bottomRadius = 0.12 * tuning.size;
  const topRadius = 0.62 * tuning.spread * tuning.size;
  const lift = topRadius + 0.28;
  const ribbons = useMemo(
    () => Array.from({ length: count }, (_, i) => makeHorizontalRibbonGeometry({
      length,
      bottomRadius,
      topRadius,
      turns: 1.45 + tuning.thickness * 0.55,
      phase: (i / count) * Math.PI * 2,
      width: 0.026 * tuning.thickness * tuning.size,
      randomness,
      seed: i + 1,
    })),
    [bottomRadius, count, length, randomness, topRadius, tuning.size, tuning.thickness],
  );

  useFrame(({ clock }) => {
    const spin = clock.elapsedTime * 0.9 * tuning.speed;
    const pulse = Math.sin(clock.elapsedTime * 2.2 * tuning.speed) * 0.5 + 0.5;
    if (groupRef.current) {
      groupRef.current.rotation.x = spin;
      groupRef.current.children.forEach((child, i) => {
        if (!("material" in child)) return;
        const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
        mat.opacity = (0.1 + pulse * 0.09 + (i % 3) * 0.012) * tuning.intensity;
      });
    }
    if (originRingRef.current) originRingRef.current.opacity = (0.2 + pulse * 0.18) * tuning.intensity;
  });

  return (
    <group position={[position[0] - length * 0.5, lift, position[1]]}>
      <group ref={groupRef}>
        {ribbons.map((geometry, i) => (
          <mesh key={i} geometry={geometry} raycast={() => null}>
            <meshBasicMaterial color={i % 2 ? tuning.secondaryColor : tuning.color} transparent opacity={0.18} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
          </mesh>
        ))}
        <mesh position={[0, 0, 0]} rotation={[0, Math.PI / 2, 0]} raycast={() => null}>
          <torusGeometry args={[Math.max(0.22, bottomRadius * 1.7), 0.018 * tuning.thickness, 8, 72]} />
          <meshBasicMaterial ref={originRingRef} color={tuning.secondaryColor} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
      <pointLight position={[0, 0, 0]} color={tuning.color} intensity={2.2 * tuning.intensity} distance={7} />
      <pointLight position={[length, 0, 0]} color={tuning.secondaryColor} intensity={3.2 * tuning.intensity} distance={8} />
    </group>
  );
}

function makeHelixCurve(height: number, radius: number, turns: number, phase: number) {
  const points = Array.from({ length: 80 }, (_, i) => {
    const t = i / 79;
    const taper = 0.28 + t * 0.82;
    const angle = phase + t * Math.PI * 2 * turns;
    return new THREE.Vector3(Math.cos(angle) * radius * taper, t * height, Math.sin(angle) * radius * taper);
  });
  return new THREE.CatmullRomCurve3(points);
}

function HelicalLineVortex({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const groupRef = useRef<THREE.Group>(null);
  const count = clamp(Math.round(tuning.count), 2, 12);
  const height = Math.max(1.6, tuning.arc) * tuning.size;
  const curves = useMemo(
    () => Array.from({ length: count }, (_, i) => makeHelixCurve(height, 1.05 * tuning.spread * tuning.size, 1.2 + tuning.thickness * 0.8, (i / count) * Math.PI * 2)),
    [count, height, tuning.spread, tuning.size, tuning.thickness],
  );

  useFrame(({ clock }) => {
    if (groupRef.current) groupRef.current.rotation.y = -clock.elapsedTime * 0.9 * tuning.speed;
    groupRef.current?.children.forEach((child, i) => {
      if (!("material" in child)) return;
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = (0.28 + Math.sin(clock.elapsedTime * 3 * tuning.speed + i * 0.7) * 0.11) * tuning.intensity;
    });
  });

  return (
    <group ref={groupRef} position={[position[0], 0.16, position[1]]}>
      {curves.map((curve, i) => (
        <mesh key={i} raycast={() => null}>
          <tubeGeometry args={[curve, 72, 0.018 * tuning.thickness * tuning.size, 7, false]} />
          <meshBasicMaterial color={i % 2 ? tuning.secondaryColor : tuning.color} transparent opacity={0.3} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
      <pointLight color={tuning.secondaryColor} intensity={2.2 * tuning.intensity} distance={7} />
    </group>
  );
}

function ConeShellVortex({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const shellRef = useRef<THREE.Mesh>(null);
  const wireRef = useRef<THREE.Mesh>(null);
  const shellMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const wireMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const height = Math.max(1.7, tuning.arc) * tuning.size;

  useFrame(({ clock }) => {
    if (shellRef.current) shellRef.current.rotation.y = clock.elapsedTime * 0.85 * tuning.speed;
    if (wireRef.current) wireRef.current.rotation.y = -clock.elapsedTime * 0.55 * tuning.speed;
    const pulse = Math.sin(clock.elapsedTime * 2.5 * tuning.speed) * 0.5 + 0.5;
    if (shellMatRef.current) shellMatRef.current.opacity = (0.06 + pulse * 0.08) * tuning.intensity;
    if (wireMatRef.current) wireMatRef.current.opacity = (0.18 + pulse * 0.14) * tuning.intensity;
  });

  return (
    <group position={[position[0], height * 0.5 + 0.1, position[1]]}>
      <mesh ref={shellRef} raycast={() => null}>
        <coneGeometry args={[1.45 * tuning.spread * tuning.size, height, 72, 8, true]} />
        <meshBasicMaterial ref={shellMatRef} color={tuning.color} transparent opacity={0.1} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={wireRef} raycast={() => null}>
        <coneGeometry args={[1.55 * tuning.spread * tuning.size, height * 0.96, 28, 8, true]} />
        <meshBasicMaterial ref={wireMatRef} color={tuning.secondaryColor} transparent opacity={0.24} wireframe blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

function makeNoiseTexture(color: string, accent: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "rgba(255,255,255,0)");
    gradient.addColorStop(0.5, color);
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "source-in";
    for (let i = 0; i < 95; i++) {
      const alpha = 0.08 + (i % 5) * 0.025;
      ctx.strokeStyle = i % 3 === 0 ? accent : `rgba(255,255,255,${alpha})`;
      ctx.lineWidth = 1 + (i % 4);
      ctx.beginPath();
      const y = (i / 95) * canvas.height;
      ctx.moveTo(Math.sin(i) * 20 + 30, y);
      ctx.bezierCurveTo(90, y + 18, 12, y + 42, 72 + Math.cos(i) * 28, y + 66);
      ctx.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function NoiseSheetVortex({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const groupRef = useRef<THREE.Group>(null);
  const count = clamp(Math.round(tuning.count), 3, 10);
  const texture = useMemo(() => makeNoiseTexture(tuning.color, tuning.secondaryColor), [tuning.color, tuning.secondaryColor]);
  const height = Math.max(1.8, tuning.arc) * tuning.size;

  useFrame(({ clock }) => {
    if (groupRef.current) groupRef.current.rotation.y = clock.elapsedTime * 0.5 * tuning.speed;
    texture.offset.y = (clock.elapsedTime * 0.16 * tuning.speed) % 1;
    groupRef.current?.children.forEach((child, i) => {
      child.rotation.y = (i / count) * Math.PI + clock.elapsedTime * 0.22 * tuning.speed;
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = (0.08 + Math.sin(clock.elapsedTime * 1.7 * tuning.speed + i) * 0.025) * tuning.intensity;
    });
  });

  return (
    <group ref={groupRef} position={[position[0], height * 0.5 + 0.15, position[1]]}>
      {Array.from({ length: count }).map((_, i) => (
        <mesh key={i} raycast={() => null}>
          <planeGeometry args={[2.2 * tuning.spread * tuning.size, height]} />
          <meshBasicMaterial map={texture} color={i % 2 ? tuning.secondaryColor : tuning.color} transparent opacity={0.08} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

function RingCompressionVortex({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const groupRef = useRef<THREE.Group>(null);
  const count = clamp(Math.round(tuning.count), 3, 14);
  const height = Math.max(1.5, tuning.arc) * tuning.size;

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    groupRef.current.rotation.y = clock.elapsedTime * 0.28 * tuning.speed;
    groupRef.current.children.forEach((child, i) => {
      if (!("material" in child)) return;
      const phase = (i / count + clock.elapsedTime * 0.18 * tuning.speed) % 1;
      const radius = (1.35 - phase * 1.04) * tuning.spread * tuning.size;
      child.position.y = phase * height;
      child.scale.set(radius, radius, radius);
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = Math.sin(phase * Math.PI) * 0.55 * tuning.intensity;
    });
  });

  return (
    <group ref={groupRef} position={[position[0], 0.18, position[1]]}>
      {Array.from({ length: count }).map((_, i) => (
        <mesh key={i} rotation={[Math.PI / 2, 0, 0]} raycast={() => null}>
          <torusGeometry args={[1, 0.018 * tuning.thickness, 8, 72]} />
          <meshBasicMaterial color={i % 2 ? tuning.secondaryColor : tuning.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
      <pointLight color={tuning.color} intensity={2 * tuning.intensity} distance={6} />
    </group>
  );
}

function TractorLock({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const ringGroupRef = useRef<THREE.Group>(null);
  const beamMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const count = clamp(Math.round(tuning.count), 2, 8);
  const height = Math.max(1.8, tuning.arc) * tuning.size;

  useFrame(({ clock }) => {
    if (ringGroupRef.current) {
      ringGroupRef.current.rotation.y = clock.elapsedTime * 0.55 * tuning.speed;
      ringGroupRef.current.children.forEach((child, i) => {
        if (!("material" in child)) return;
        const phase = (i / count + clock.elapsedTime * 0.18 * tuning.speed) % 1;
        child.position.y = phase * height;
        child.scale.setScalar((0.75 + Math.sin(phase * Math.PI) * 0.45) * tuning.spread * tuning.size);
        const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
        mat.opacity = Math.sin(phase * Math.PI) * 0.55 * tuning.intensity;
      });
    }
    if (beamMatRef.current) {
      const pulse = Math.sin(clock.elapsedTime * 3 * tuning.speed) * 0.5 + 0.5;
      beamMatRef.current.opacity = (0.05 + pulse * 0.08) * tuning.intensity;
    }
  });

  return (
    <group position={[position[0], 0.18, position[1]]}>
      <mesh position={[0, height * 0.5, 0]} raycast={() => null}>
        <cylinderGeometry args={[0.34 * tuning.thickness, 0.72 * tuning.thickness, height, 18, 1, true]} />
        <meshBasicMaterial ref={beamMatRef} color={tuning.color} transparent opacity={0.08} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <group ref={ringGroupRef}>
        {Array.from({ length: count }).map((_, i) => (
          <mesh key={i} rotation={[Math.PI / 2, 0, 0]} raycast={() => null}>
            <torusGeometry args={[0.9, 0.02 * tuning.thickness, 8, 72]} />
            <meshBasicMaterial color={i % 2 ? tuning.secondaryColor : tuning.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
          </mesh>
        ))}
      </group>
      <pointLight color={tuning.color} intensity={2.2 * tuning.intensity} distance={7} />
    </group>
  );
}

function SensorSweep({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const ringGroupRef = useRef<THREE.Group>(null);
  const sweepRef = useRef<THREE.Mesh>(null);
  const sweepMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const count = clamp(Math.round(tuning.count), 2, 8);

  useFrame(({ clock }) => {
    if (sweepRef.current) sweepRef.current.rotation.y = clock.elapsedTime * 1.4 * tuning.speed;
    if (sweepMatRef.current) sweepMatRef.current.opacity = 0.22 * tuning.intensity;
    ringGroupRef.current?.children.forEach((child, i) => {
      const phase = (i / count + clock.elapsedTime * 0.28 * tuning.speed) % 1;
      child.scale.setScalar((0.35 + phase * 3.2) * tuning.spread * tuning.size);
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = (1 - phase) * 0.5 * tuning.intensity;
    });
  });

  return (
    <group position={[position[0], 0.08, position[1]]}>
      <group ref={ringGroupRef}>
        {Array.from({ length: count }).map((_, i) => (
          <mesh key={i} rotation={[Math.PI / 2, 0, 0]} raycast={() => null}>
            <torusGeometry args={[1, 0.012 * tuning.thickness, 8, 96]} />
            <meshBasicMaterial color={i % 2 ? tuning.secondaryColor : tuning.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
          </mesh>
        ))}
      </group>
      <mesh ref={sweepRef} position={[0, 0.08, 0]} raycast={() => null}>
        <planeGeometry args={[5.0 * tuning.spread * tuning.size, 0.22 * tuning.thickness]} />
        <meshBasicMaterial ref={sweepMatRef} color={tuning.color} transparent opacity={0.2} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
    </group>
  );
}

function PhaseCloak({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const groupRef = useRef<THREE.Group>(null);
  const count = clamp(Math.round(tuning.count), 2, 6);

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    groupRef.current.rotation.y = clock.elapsedTime * 0.35 * tuning.speed;
    groupRef.current.children.forEach((child, i) => {
      if (!("material" in child)) return;
      child.rotation.x = Math.sin(clock.elapsedTime * 0.8 * tuning.speed + i) * 0.18;
      child.rotation.z = Math.cos(clock.elapsedTime * 0.7 * tuning.speed + i) * 0.18;
      const pulse = Math.sin(clock.elapsedTime * 2.1 * tuning.speed + i) * 0.5 + 0.5;
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = (0.08 + pulse * 0.16) * tuning.intensity;
    });
  });

  return (
    <group ref={groupRef} position={[position[0], 1.15 * tuning.size, position[1]]}>
      {Array.from({ length: count }).map((_, i) => (
        <mesh key={i} scale={(1 + i * 0.09) * tuning.size} raycast={() => null}>
          <icosahedronGeometry args={[1.15, 1]} />
          <meshBasicMaterial color={i % 2 ? tuning.secondaryColor : tuning.color} transparent opacity={0} wireframe blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
      <pointLight color={tuning.secondaryColor} intensity={1.4 * tuning.intensity} distance={6} />
    </group>
  );
}

function DebrisSparks({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const groupRef = useRef<THREE.Group>(null);
  const count = clamp(Math.round(tuning.count), 4, 30);
  const shards = useMemo(
    () => Array.from({ length: count }, (_, i) => ({
      angle: i * 2.399,
      radius: 0.35 + (i % 7) * 0.13,
      height: 0.12 + (i % 5) * 0.18,
      speed: 0.5 + (i % 6) * 0.09,
      spin: 0.02 + (i % 5) * 0.01,
    })),
    [count],
  );

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    groupRef.current.children.forEach((child, i) => {
      const shard = shards[i];
      if (!shard || !("material" in child)) return;
      const t = (clock.elapsedTime * tuning.speed * shard.speed + i * 0.037) % 1;
      const radius = shard.radius * tuning.spread * (1 + t * 1.1);
      child.position.set(Math.cos(shard.angle + t * 2.2) * radius, shard.height + Math.sin(t * Math.PI) * tuning.arc * 0.42, Math.sin(shard.angle + t * 2.2) * radius);
      child.rotation.set(clock.elapsedTime * shard.spin * 18, clock.elapsedTime * shard.spin * 29 + i, clock.elapsedTime * shard.spin * 11);
      child.scale.setScalar((0.08 + (i % 4) * 0.025) * tuning.size);
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = Math.sin(t * Math.PI) * tuning.intensity;
    });
  });

  return (
    <group ref={groupRef} position={[position[0], 0.1, position[1]]}>
      {shards.map((_, i) => (
        <mesh key={i} raycast={() => null}>
          <tetrahedronGeometry args={[1, 0]} />
          <meshBasicMaterial color={i % 3 === 0 ? tuning.secondaryColor : tuning.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
      <pointLight color={tuning.color} intensity={2 * tuning.intensity} distance={6} />
    </group>
  );
}

type ArcParticle = {
  yaw: number;
  distance: number;
  height: number;
  rise: number;
  speed: number;
  phase: number;
  size: number;
  wobble: number;
};

function arcParticlePosition(particle: ArcParticle, t: number): THREE.Vector3 {
  const eased = 1 - Math.pow(1 - t, 1.7);
  const sideWobble = Math.sin(t * Math.PI * 2 + particle.phase * Math.PI * 2) * particle.wobble * Math.sin(t * Math.PI);
  const yaw = particle.yaw + sideWobble;
  const radius = particle.distance * eased;
  return new THREE.Vector3(
    Math.sin(yaw) * radius,
    0.28 + Math.sin(t * Math.PI) * particle.height + t * particle.rise,
    Math.cos(yaw) * radius,
  );
}

function ArcParticleSpray({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const particleGroupRef = useRef<THREE.Group>(null);
  const ribbonGroupRef = useRef<THREE.Group>(null);
  const count = clamp(Math.round(tuning.count), 4, 96);
  const ribbonEffect = clamp(tuning.ribbonEffect ?? 0.7, 0, 2);
  const fanAngle = clamp(tuning.arc, 0.15, Math.PI * 1.92);
  const randomness = clamp(tuning.randomness ?? 0.35, 0, 1.5);
  const ribbonStride = Math.max(1, Math.ceil(count / 24));

  const particles = useMemo(
    () => Array.from({ length: count }, (_, i): ArcParticle => {
      const slot = count === 1 ? 0.5 : i / (count - 1);
      const band = i % 5;
      const jitter = Math.sin(i * 12.9898) * randomness * 0.18;
      return {
        yaw: (slot - 0.5) * fanAngle + jitter,
        distance: (5.4 + (i % 9) * 0.36) * tuning.spread,
        height: (0.8 + band * 0.24 + Math.abs(Math.sin(i * 2.31)) * 0.36) * tuning.size * (0.85 + fanAngle * 0.12),
        rise: (0.15 + (i % 4) * 0.1) * tuning.spread,
        speed: 0.5 + (i % 7) * 0.055,
        phase: (i * 0.071) % 1,
        size: (0.105 + (i % 4) * 0.018) * tuning.size,
        wobble: randomness * (0.015 + (i % 4) * 0.012),
      };
    }),
    [count, fanAngle, randomness, tuning.size, tuning.spread],
  );

  const ribbonCurves = useMemo(
    () => particles
      .filter((_, i) => i % ribbonStride === 0)
      .map(particle => new THREE.CatmullRomCurve3(
        Array.from({ length: 18 }, (_, step) => arcParticlePosition(particle, step / 17)),
      )),
    [particles, ribbonStride],
  );

  useFrame(({ clock }) => {
    particleGroupRef.current?.children.forEach((child, i) => {
      const particle = particles[i];
      if (!particle) return;
      const t = (clock.elapsedTime * tuning.speed * particle.speed + particle.phase) % 1;
      const opacity = Math.sin(t * Math.PI) * tuning.intensity * phaseAlpha(t, tuning.fade);
      child.position.copy(arcParticlePosition(particle, t));
      child.rotation.set(clock.elapsedTime * 0.8 * particle.speed, clock.elapsedTime * 1.3 * particle.speed + i, 0);
      child.scale.setScalar(particle.size * (0.82 + Math.sin(t * Math.PI) * 0.55));

      const outline = child.children[0] as THREE.Mesh | undefined;
      const core = child.children[1] as THREE.Mesh | undefined;
      if (outline?.material) {
        const mat = outline.material as THREE.MeshBasicMaterial;
        mat.opacity = clamp(opacity * 0.95, 0, 1);
      }
      if (core?.material) {
        const mat = core.material as THREE.MeshBasicMaterial;
        mat.opacity = clamp(opacity, 0, 1);
      }
    });

    ribbonGroupRef.current?.children.forEach((child, i) => {
      if (!("material" in child)) return;
      const pulse = Math.sin(clock.elapsedTime * 1.8 * tuning.speed + i * 0.47) * 0.5 + 0.5;
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = (0.05 + pulse * 0.13) * tuning.intensity * ribbonEffect;
    });
  });

  return (
    <group position={[position[0], 0.12, position[1]]}>
      <group ref={ribbonGroupRef}>
        {ribbonCurves.map((curve, i) => (
          <mesh key={i} raycast={() => null}>
            <tubeGeometry args={[curve, 40, 0.018 * tuning.thickness * Math.max(0.15, ribbonEffect), 6, false]} />
            <meshBasicMaterial color={i % 2 ? tuning.secondaryColor : tuning.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
          </mesh>
        ))}
      </group>
      <group ref={particleGroupRef}>
        {particles.map((_, i) => (
          <group key={i}>
            <mesh raycast={() => null}>
              <sphereGeometry args={[1.25, 12, 12]} />
              <meshBasicMaterial color={tuning.secondaryColor} transparent opacity={0} depthWrite={false} toneMapped={false} />
            </mesh>
            <mesh scale={0.72} raycast={() => null}>
              <sphereGeometry args={[1, 12, 12]} />
              <meshBasicMaterial color={tuning.color} transparent opacity={0} depthWrite={false} toneMapped={false} />
            </mesh>
          </group>
        ))}
      </group>
      <mesh raycast={() => null}>
        <sphereGeometry args={[0.22 * tuning.size, 16, 16]} />
        <meshBasicMaterial color={tuning.secondaryColor} transparent opacity={0.85 * tuning.intensity} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <pointLight color={tuning.secondaryColor} intensity={1.3 * tuning.intensity} distance={7 * tuning.spread} />
    </group>
  );
}

function ShockwaveDome({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const domeRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const domeMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const ringMatRef = useRef<THREE.MeshBasicMaterial>(null);

  useFrame(({ clock }) => {
    const t = (clock.elapsedTime * 0.45 * tuning.speed) % 1;
    const radius = (0.35 + t * 4.2) * tuning.size * tuning.spread;
    if (domeRef.current) {
      domeRef.current.scale.set(radius, radius * 0.38, radius);
      domeRef.current.rotation.y = clock.elapsedTime * 0.18 * tuning.speed;
    }
    if (ringRef.current) ringRef.current.scale.setScalar(radius);
    const opacity = (1 - t) * 0.55 * tuning.intensity;
    if (domeMatRef.current) domeMatRef.current.opacity = opacity * 0.42;
    if (ringMatRef.current) ringMatRef.current.opacity = opacity;
  });

  return (
    <group position={[position[0], 0.22, position[1]]}>
      <mesh ref={domeRef} raycast={() => null}>
        <sphereGeometry args={[1, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshBasicMaterial ref={domeMatRef} color={tuning.color} transparent opacity={0} wireframe blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={ringRef} rotation={[Math.PI / 2, 0, 0]} raycast={() => null}>
        <torusGeometry args={[1, 0.018 * tuning.thickness, 8, 96]} />
        <meshBasicMaterial ref={ringMatRef} color={tuning.secondaryColor} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <pointLight color={tuning.secondaryColor} intensity={2.5 * tuning.intensity} distance={8} />
    </group>
  );
}

function HyperspaceWake({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const groupRef = useRef<THREE.Group>(null);
  const count = clamp(Math.round(tuning.count), 2, 9);
  const curves = useMemo(
    () => Array.from({ length: count }, (_, i) => {
      const side = i % 2 === 0 ? 1 : -1;
      const offset = (i - (count - 1) / 2) * 0.22;
      return new THREE.CatmullRomCurve3([
        new THREE.Vector3(-2.2 * tuning.spread, 0.15 + i * 0.03, offset),
        new THREE.Vector3(-1.2 * tuning.spread, 0.55 + side * 0.12, offset + side * 0.45),
        new THREE.Vector3(0.15 * tuning.spread, 1.05 + side * 0.22, offset - side * 0.25),
        new THREE.Vector3(1.75 * tuning.spread, 1.55 + i * 0.02, offset + side * 0.12),
      ]);
    }),
    [count, tuning.spread],
  );

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    groupRef.current.rotation.y = Math.sin(clock.elapsedTime * 0.45 * tuning.speed) * 0.18;
    groupRef.current.children.forEach((child, i) => {
      if (!("material" in child)) return;
      child.position.x = Math.sin(clock.elapsedTime * tuning.speed + i) * 0.08;
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = (0.18 + Math.sin(clock.elapsedTime * 2.4 * tuning.speed + i) * 0.08) * tuning.intensity;
    });
  });

  return (
    <group ref={groupRef} position={[position[0], 0.25, position[1]]} scale={tuning.size}>
      {curves.map((curve, i) => (
        <mesh key={i} raycast={() => null}>
          <tubeGeometry args={[curve, 48, 0.026 * tuning.thickness, 7, false]} />
          <meshBasicMaterial color={i % 2 ? tuning.secondaryColor : tuning.color} transparent opacity={0.2} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
      <pointLight color={tuning.secondaryColor} intensity={2.4 * tuning.intensity} distance={8} />
    </group>
  );
}

function RiftShear({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const groupRef = useRef<THREE.Group>(null);
  const count = clamp(Math.round(tuning.count), 3, 9);
  const texture = useMemo(() => makeNoiseTexture(tuning.color, tuning.secondaryColor), [tuning.color, tuning.secondaryColor]);

  useFrame(({ clock }) => {
    texture.offset.y = (clock.elapsedTime * 0.22 * tuning.speed) % 1;
    if (!groupRef.current) return;
    groupRef.current.rotation.y = clock.elapsedTime * 0.28 * tuning.speed;
    groupRef.current.children.forEach((child, i) => {
      if (!("material" in child)) return;
      child.rotation.z = Math.sin(clock.elapsedTime * 0.8 * tuning.speed + i) * 0.28;
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = (0.09 + Math.sin(clock.elapsedTime * 2.2 * tuning.speed + i) * 0.04) * tuning.intensity;
    });
  });

  return (
    <group ref={groupRef} position={[position[0], 1.45 * tuning.size, position[1]]}>
      {Array.from({ length: count }).map((_, i) => (
        <mesh key={i} rotation={[0, (i / count) * Math.PI, (i % 2 ? -0.5 : 0.5)]} raycast={() => null}>
          <planeGeometry args={[0.7 * tuning.thickness * tuning.size, Math.max(1.8, tuning.arc) * tuning.size]} />
          <meshBasicMaterial map={texture} color={i % 2 ? tuning.secondaryColor : tuning.color} transparent opacity={0.1} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
      <pointLight color={tuning.color} intensity={1.8 * tuning.intensity} distance={7} />
    </group>
  );
}

function BeaconPulse({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const columnMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const ringGroupRef = useRef<THREE.Group>(null);
  const count = clamp(Math.round(tuning.count), 2, 10);
  const height = Math.max(1.6, tuning.arc) * tuning.size;

  useFrame(({ clock }) => {
    const pulse = Math.sin(clock.elapsedTime * 2.3 * tuning.speed) * 0.5 + 0.5;
    if (columnMatRef.current) columnMatRef.current.opacity = (0.07 + pulse * 0.12) * tuning.intensity;
    ringGroupRef.current?.children.forEach((child, i) => {
      if (!("material" in child)) return;
      const phase = (i / count + clock.elapsedTime * 0.22 * tuning.speed) % 1;
      child.position.y = phase * height;
      child.scale.setScalar((0.35 + phase * 1.25) * tuning.spread * tuning.size);
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = Math.sin(phase * Math.PI) * 0.55 * tuning.intensity;
    });
  });

  return (
    <group position={[position[0], 0.12, position[1]]}>
      <mesh position={[0, height * 0.5, 0]} raycast={() => null}>
        <cylinderGeometry args={[0.12 * tuning.thickness, 0.28 * tuning.thickness, height, 20, 1, true]} />
        <meshBasicMaterial ref={columnMatRef} color={tuning.color} transparent opacity={0} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <group ref={ringGroupRef}>
        {Array.from({ length: count }).map((_, i) => (
          <mesh key={i} rotation={[Math.PI / 2, 0, 0]} raycast={() => null}>
            <torusGeometry args={[1, 0.014 * tuning.thickness, 8, 80]} />
            <meshBasicMaterial color={i % 2 ? tuning.secondaryColor : tuning.color} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
          </mesh>
        ))}
      </group>
      <pointLight color={tuning.color} intensity={2.8 * tuning.intensity} distance={8} />
    </group>
  );
}

function GravityLens({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const lensRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const lensMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const ringMatRef = useRef<THREE.MeshBasicMaterial>(null);

  useFrame(({ clock }) => {
    const pulse = Math.sin(clock.elapsedTime * 1.6 * tuning.speed) * 0.5 + 0.5;
    if (lensRef.current) {
      lensRef.current.rotation.y = clock.elapsedTime * 0.38 * tuning.speed;
      lensRef.current.scale.set(tuning.size * tuning.spread * (1.1 + pulse * 0.08), tuning.size * 0.24, tuning.size * tuning.spread * (1.1 + pulse * 0.08));
    }
    if (ringRef.current) {
      ringRef.current.rotation.z = clock.elapsedTime * 0.42 * tuning.speed;
      ringRef.current.scale.setScalar(tuning.size * tuning.spread * (1.25 + pulse * 0.1));
    }
    if (lensMatRef.current) lensMatRef.current.opacity = (0.07 + pulse * 0.12) * tuning.intensity;
    if (ringMatRef.current) ringMatRef.current.opacity = (0.22 + pulse * 0.22) * tuning.intensity;
  });

  return (
    <group position={[position[0], 1.05 * tuning.size, position[1]]}>
      <mesh ref={lensRef} raycast={() => null}>
        <sphereGeometry args={[1.35, 32, 12]} />
        <meshBasicMaterial ref={lensMatRef} color={tuning.color} transparent opacity={0} wireframe blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={ringRef} rotation={[Math.PI / 2, 0, 0]} raycast={() => null}>
        <torusGeometry args={[1.2, 0.026 * tuning.thickness, 8, 96]} />
        <meshBasicMaterial ref={ringMatRef} color={tuning.secondaryColor} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
      <pointLight color={tuning.secondaryColor} intensity={1.7 * tuning.intensity} distance={6} />
    </group>
  );
}

function seededUnit(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function PersistentImpactFlashes({ position, tuning }: { position: Vec2; tuning: Tuning }) {
  const groupRef = useRef<THREE.Group>(null);
  const count = clamp(Math.round(tuning.count), 2, 40);
  const randomness = clamp(tuning.randomness ?? 0.75, 0, 1.5);
  const flashes = useMemo(
    () => Array.from({ length: count }, (_, i) => {
      const radialSeed = seededUnit(i + 1.3);
      const sizeSeed = seededUnit(i + 9.7);
      const heightSeed = seededUnit(i + 17.1);
      const angle = i * 2.399963 + seededUnit(i + 4.2) * randomness * 0.9;
      const radius = (0.25 + radialSeed * 2.45) * tuning.spread;
      const baseSize = (0.32 + sizeSeed * (0.85 + randomness * 0.45)) * tuning.size;
      const height = (1.35 + tuning.arc * 0.32 + heightSeed * (0.8 + tuning.arc * 0.18)) * tuning.size;
      return {
        x: Math.cos(angle) * radius,
        z: Math.sin(angle) * radius,
        height,
        baseSize,
        phase: seededUnit(i + 29.4) * Math.PI * 2,
        spin: (seededUnit(i + 37.8) - 0.5) * 0.018,
        pulseSpeed: 0.7 + seededUnit(i + 44.6) * 0.9,
        accent: seededUnit(i + 52.5) > 0.62,
      };
    }),
    [count, randomness, tuning.arc, tuning.size, tuning.spread],
  );

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    groupRef.current.children.forEach((child, i) => {
      const flash = flashes[i];
      if (!flash) return;
      const pulse = Math.sin(clock.elapsedTime * tuning.speed * flash.pulseSpeed + flash.phase) * 0.5 + 0.5;
      child.position.set(flash.x, flash.height + Math.sin(clock.elapsedTime * tuning.speed * 0.42 + flash.phase) * 0.08 * tuning.spread, flash.z);
      child.rotation.y += flash.spin * tuning.speed;
      child.scale.setScalar(flash.baseSize * (0.82 + pulse * 0.34));
      child.children.forEach((mesh, meshIndex) => {
        if (!("material" in mesh)) return;
        const mat = (mesh as THREE.Mesh).material as THREE.MeshBasicMaterial;
        mat.opacity = meshIndex === 0
          ? (0.14 + pulse * 0.28) * tuning.intensity
          : (0.28 + pulse * 0.38) * tuning.intensity;
      });
    });
  });

  return (
    <group position={[position[0], 0, position[1]]}>
      <group ref={groupRef}>
        {flashes.map((flash, i) => (
          <group key={i} position={[flash.x, flash.height, flash.z]}>
            <mesh raycast={() => null}>
              <sphereGeometry args={[1, 24, 24]} />
              <meshBasicMaterial color={flash.accent ? tuning.secondaryColor : tuning.color} transparent opacity={0.24} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
            </mesh>
            <mesh raycast={() => null} scale={[1.04, 1.04, 1.04]}>
              <sphereGeometry args={[1, 18, 18]} />
              <meshBasicMaterial color={tuning.secondaryColor} transparent opacity={0.42} wireframe blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
            </mesh>
          </group>
        ))}
      </group>
      <pointLight color={tuning.secondaryColor} intensity={2.6 * tuning.intensity} distance={9 * tuning.spread} position={[0, 2.4 + tuning.arc * 0.2, 0]} />
    </group>
  );
}

function GodotJumpPointShaderModel({
  filename,
  textureFilename,
  tuning,
}: {
  filename: string;
  textureFilename: string;
  tuning: Tuning;
}) {
  const { scene } = useGLTF(showcaseModelUrl(filename));
  const baseTexture = useLoader(THREE.TextureLoader, showcaseTextureUrl(textureFilename));
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);

  useMemo(() => {
    baseTexture.wrapS = THREE.RepeatWrapping;
    baseTexture.wrapT = THREE.RepeatWrapping;
    baseTexture.colorSpace = THREE.NoColorSpace;
    baseTexture.needsUpdate = true;
  }, [baseTexture]);

  const material = useMemo(() => {
    const shaderMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uBaseMap: { value: baseTexture },
        uTime: { value: 0 },
        uOpacity: { value: tuning.intensity },
        uSpeed: { value: new THREE.Vector2(-0.5, -0.5) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uBaseMap;
        uniform float uTime;
        uniform float uOpacity;
        uniform vec2 uSpeed;
        varying vec2 vUv;

        vec4 colorRamp(float value) {
          vec4 c0 = vec4(0.0, 0.1625, 0.65, 0.0);
          vec4 c1 = vec4(0.0, 0.1625, 0.65, 1.0);
          vec4 c2 = vec4(0.093007304, 0.33048636, 1.0, 1.0);
          vec4 c3 = vec4(0.1748, 0.68402004, 0.92, 1.0);
          if (value < 0.102564104) {
            return mix(c0, c1, smoothstep(0.0076923077, 0.102564104, value));
          }
          if (value < 0.33076924) {
            return mix(c1, c2, smoothstep(0.102564104, 0.33076924, value));
          }
          return mix(c2, c3, smoothstep(0.33076924, 0.6948718, value));
        }

        float subtractionMask(vec2 uv) {
          float diagonal = clamp((uv.x + uv.y) * 0.5, 0.0, 1.0);
          float nearStart = 1.0 - smoothstep(0.0, 0.07948718, diagonal);
          float nearEnd = smoothstep(0.94871795, 1.0, diagonal);
          return max(nearStart, nearEnd) * 0.65;
        }

        float edgeFade(vec2 uv) {
          float vertical = smoothstep(0.0, 0.14, uv.y) * (1.0 - smoothstep(0.86, 1.0, uv.y));
          float horizontal = smoothstep(0.0, 0.035, uv.x) * (1.0 - smoothstep(0.965, 1.0, uv.x));
          float diagonal = clamp((uv.x + uv.y) * 0.5, 0.0, 1.0);
          float diagonalGate = smoothstep(0.02, 0.16, diagonal) * (1.0 - smoothstep(0.84, 0.98, diagonal));
          return vertical * horizontal * mix(0.35, 1.0, diagonalGate);
        }

        void main() {
          vec2 pannedUv = fract(vUv + uSpeed * uTime);
          vec3 baseSample = texture2D(uBaseMap, pannedUv).rgb;
          float baseValue = max(max(baseSample.r, baseSample.g), baseSample.b);
          float shaped = clamp(baseValue - subtractionMask(vUv), 0.0, 1.0);
          shaped = smoothstep(0.02, 0.78, shaped);
          vec4 ramped = colorRamp(shaped);
          float alpha = ramped.a * shaped * edgeFade(vUv) * uOpacity;
          if (alpha < 0.015) discard;
          gl_FragColor = vec4(ramped.rgb * (1.0 + shaped * 0.8), alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    materialRef.current = shaderMaterial;
    return shaderMaterial;
  }, [baseTexture]);

  useFrame(({ clock }) => {
    if (!materialRef.current) return;
    materialRef.current.uniforms.uTime.value = clock.elapsedTime * tuning.speed;
    materialRef.current.uniforms.uOpacity.value = clamp(tuning.intensity, 0, 4);
  });

  const cloned = useMemo(() => {
    const c = scene.clone(true);
    c.traverse((child: any) => {
      if (!child.isMesh) return;
      child.material = material;
      child.castShadow = false;
      child.receiveShadow = false;
      child.raycast = () => null;
    });
    return c;
  }, [scene, material]);

  const scale = useMemo(() => showcaseShipScale(cloned, 7.5 * tuning.size), [cloned, tuning.size]);
  return (
    <group rotation={[Math.PI / 2, 0, 0]} scale={[scale, scale, scale]}>
      <primitive object={cloned} />
    </group>
  );
}

function GodotJumpPointMesh({ station, tuning }: { station: SpecialStation; tuning: Tuning }) {
  const filename = station.modelFilename ?? "_jumppoint.glb";
  return (
    <group position={[station.position[0], 2.35, station.position[1]]}>
      <Suspense fallback={null}>
        <GodotJumpPointShaderModel
          filename={filename}
          textureFilename="T_Noise1_nk.png"
          tuning={tuning}
        />
      </Suspense>
      <pointLight
        color={tuning.color}
        intensity={1.4 * tuning.intensity}
        distance={8 * tuning.spread}
        position={[0, 1.2, 0]}
      />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.33, 0]} raycast={() => null}>
        <ringGeometry args={[2.45 * tuning.size, 2.65 * tuning.size, 96]} />
        <meshBasicMaterial
          color={tuning.color}
          transparent
          opacity={0.4}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

function SpecialFxStation({
  station,
  tuning,
  selected,
  animationPaused,
  showLabel,
}: {
  station: SpecialStation;
  tuning: Tuning;
  selected: boolean;
  animationPaused: boolean;
  showLabel: boolean;
}) {
  return (
    <group>
      <EndpointMarker position={station.position} color={tuning.color} selected={selected} />
      {station.effect === "shield-ripple" ? <ShieldRipple position={station.position} tuning={tuning} /> : null}
      {station.effect === "interceptor-burst" ? <InterceptorBurst position={station.position} tuning={tuning} /> : null}
      {station.effect === "jump-point" ? <HorizontalJumpVortex position={station.position} tuning={tuning} /> : null}
      {station.effect === "energy-mine" ? <EnergyMinePulse position={station.position} tuning={tuning} /> : null}
      {station.effect === "stealth-shimmer" ? <StealthShimmer position={station.position} tuning={tuning} /> : null}
      {station.effect === "vortex-ribbons" ? <TwistingRibbonVortex position={station.position} tuning={tuning} /> : null}
      {station.effect === "jump-vortex" ? <HorizontalJumpVortex position={station.position} tuning={tuning} /> : null}
      {station.effect === "vortex-helix-lines" ? <HelicalLineVortex position={station.position} tuning={tuning} /> : null}
      {station.effect === "vortex-cone-shell" ? <ConeShellVortex position={station.position} tuning={tuning} /> : null}
      {station.effect === "vortex-noise-sheets" ? <NoiseSheetVortex position={station.position} tuning={tuning} /> : null}
      {station.effect === "vortex-ring-compression" ? <RingCompressionVortex position={station.position} tuning={tuning} /> : null}
      {station.effect === "tractor-lock" ? <TractorLock position={station.position} tuning={tuning} /> : null}
      {station.effect === "sensor-sweep" ? <SensorSweep position={station.position} tuning={tuning} /> : null}
      {station.effect === "phase-cloak" ? <PhaseCloak position={station.position} tuning={tuning} /> : null}
      {station.effect === "debris-sparks" ? <DebrisSparks position={station.position} tuning={tuning} /> : null}
      {station.effect === "arc-particle-spray" ? <ArcParticleSpray position={station.position} tuning={tuning} /> : null}
      {station.effect === "persistent-impact-flashes" ? <PersistentImpactFlashes position={station.position} tuning={tuning} /> : null}
      {station.effect === "shockwave-dome" ? <ShockwaveDome position={station.position} tuning={tuning} /> : null}
      {station.effect === "jump-point-aperture" ? <HorizontalJumpVortex position={station.position} tuning={tuning} /> : null}
      {station.effect === "hyperspace-wake" ? <HyperspaceWake position={station.position} tuning={tuning} /> : null}
      {station.effect === "rift-shear" ? <RiftShear position={station.position} tuning={tuning} /> : null}
      {station.effect === "beacon-pulse" ? <BeaconPulse position={station.position} tuning={tuning} /> : null}
      {station.effect === "gravity-lens" ? <GravityLens position={station.position} tuning={tuning} /> : null}
      {station.effect === "damage-glow-core" ? <DamageGlowCore position={station.position} tuning={tuning} /> : null}
      {station.effect === "godot-jump-point-mesh" ? <GodotJumpPointMesh station={station} tuning={tuning} /> : null}
      {station.effect === "cloud-flipbook-damage" && station.textureFilename ? (
        <Suspense fallback={null}>
          <CloudFlipbookDamageEmitter position={station.position} tuning={tuning} textureFilename={station.textureFilename} paused={animationPaused} />
        </Suspense>
      ) : null}
      {station.effect === "standalone-flipbook-preview" && station.textureFilename ? (
        <Suspense fallback={null}>
          <StandaloneFlipbookPreview position={station.position} tuning={tuning} textureFilename={station.textureFilename} paused={animationPaused} />
        </Suspense>
      ) : null}
      {station.effect === "missile-impact-flipbook-test" ? <MissileImpactFlipbookTest station={station} tuning={tuning} paused={animationPaused} /> : null}
      {station.effect === "mesh-missile-salvo" ? <MeshMissileSalvo station={station} tuning={tuning} paused={animationPaused} /> : null}
      {station.effect === "texture-missile-salvo" ? <MeshMissileSalvo station={station} tuning={tuning} paused={animationPaused} /> : null}
      {showLabel ? <StationLabel station={station} selected={selected} /> : null}
    </group>
  );
}

function ShowcaseScene({
  board,
  overrides,
  selectedStationId,
  animationPaused,
}: {
  board: ShowcaseBoard;
  overrides: TuningOverrides;
  selectedStationId: string;
  animationPaused: boolean;
}) {
  return (
    <>
      <color attach="background" args={["#03060a"]} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[10, 24, 14]} intensity={1.4} castShadow />
      <BoardPlane />
      {board.stations.map(station => {
        const tuning = effectiveTuning(station, overrides);
        const selected = station.id === selectedStationId;
        const showLabel = board.id !== "damage-states";
        if (station.kind === "weapon") return <TunableWeaponStation key={station.id} station={station} tuning={tuning} selected={selected} showLabel={showLabel} />;
        if (station.kind === "ambient") return <AmbientFxStation key={station.id} station={station} tuning={tuning} selected={selected} showLabel={showLabel} />;
        if (station.kind === "hull-state") return <HullStateFxStation key={station.id} station={station} tuning={tuning} selected={selected} showLabel={showLabel} />;
        if (station.kind === "animated-model") return <AnimatedModelFxStation key={station.id} station={station} tuning={tuning} selected={selected} showLabel={showLabel} />;
        return <SpecialFxStation key={station.id} station={station} tuning={tuning} selected={selected} animationPaused={animationPaused} showLabel={showLabel} />;
      })}
      <OrbitControls makeDefault enableDamping dampingFactor={0.06} minDistance={14} maxDistance={72} maxPolarAngle={Math.PI * 0.49} target={[0, 0, 0]} />
      <EffectComposer>
        <Bloom intensity={1.35} luminanceThreshold={0.08} luminanceSmoothing={0.24} />
      </EffectComposer>
    </>
  );
}

function SliderControl({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</span>
        <span className="font-mono text-xs text-primary">{value.toFixed(step < 1 ? 2 : 0)}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={values => onChange(values[0] ?? value)} />
    </label>
  );
}

function ColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="grid gap-2">
      <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={event => onChange(event.target.value)}
          className="h-9 w-12 cursor-pointer rounded border border-border bg-transparent p-1"
        />
        <input
          value={value}
          onChange={event => onChange(event.target.value)}
          className="h-9 min-w-0 flex-1 rounded border border-input bg-background px-2 font-mono text-xs text-foreground"
        />
      </div>
    </label>
  );
}

function ProjectileShapeControl({
  value,
  onChange,
}: {
  value: ProjectileShape;
  onChange: (value: ProjectileShape) => void;
}) {
  return (
    <div className="grid gap-2">
      <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Projectile Shape</span>
      <div className="grid grid-cols-2 overflow-hidden rounded border border-border">
        {(["sphere", "cylinder"] as const).map(shape => (
          <button
            key={shape}
            type="button"
            className={`h-9 border-r border-border px-3 font-mono text-xs font-bold uppercase tracking-widest transition-colors last:border-r-0 ${
              value === shape ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-secondary"
            }`}
            onClick={() => onChange(shape)}
          >
            {shape}
          </button>
        ))}
      </div>
    </div>
  );
}

function exportPresetFor(station: ShowcaseStation, tuning: Tuning): string {
  return JSON.stringify(
    {
      stationId: station.id,
      label: station.label,
      source: "vfx-showcase-preview-only",
      effect: station.kind === "weapon"
        ? classifyWeapon(station.weapon)
        : station.kind === "hull-state"
          ? station.mode
          : station.kind === "animated-model"
            ? "bone-animation"
            : station.effect,
      tuning,
    },
    null,
    2,
  );
}

export default function VfxShowcase() {
  const [activeBoardId, setActiveBoardId] = useState(SHOWCASE_BOARDS[0]?.id ?? "");
  const activeBoard = SHOWCASE_BOARDS.find(board => board.id === activeBoardId) ?? SHOWCASE_BOARDS[0];
  const [selectedStationId, setSelectedStationId] = useState(activeBoard.stations[0]?.id ?? "");
  const [overrides, setOverrides] = useState<TuningOverrides>({});
  const [animationPaused, setAnimationPaused] = useState(false);

  useEffect(() => {
    setSelectedStationId(activeBoard.stations[0]?.id ?? "");
  }, [activeBoard.id]);

  const selectedStation = activeBoard.stations.find(station => station.id === selectedStationId) ?? activeBoard.stations[0];
  const selectedTuning = selectedStation ? effectiveTuning(selectedStation, overrides) : DEFAULT_TUNING;
  const selectedIsArcParticleSpray = selectedStation ? isArcParticleSpray(selectedStation) : false;
  const selectedIsPersistentImpactFlashes = selectedStation ? isPersistentImpactFlashes(selectedStation) : false;
  const exportText = selectedStation ? exportPresetFor(selectedStation, selectedTuning) : "";

  const updateSelected = (patch: Partial<Tuning>) => {
    if (!selectedStation) return;
    setOverrides(prev => ({
      ...prev,
      [selectedStation.id]: { ...(prev[selectedStation.id] ?? {}), ...patch },
    }));
  };

  const resetSelected = () => {
    if (!selectedStation) return;
    setOverrides(prev => {
      const next = { ...prev };
      delete next[selectedStation.id];
      return next;
    });
  };

  const copyPreset = async () => {
    await navigator.clipboard.writeText(exportText);
  };

  return (
    <Layout title="VFX Showcase">
      <div className="flex h-full min-h-[calc(100dvh-4rem)] flex-col overflow-hidden">
        <section className="border-b border-border bg-background/75 px-4 py-3 md:px-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <Sparkles className="h-5 w-5 shrink-0 text-primary" />
              <div className="min-w-0">
                <h2 className="text-sm font-bold uppercase tracking-[0.22em] text-primary">Effect Test Range</h2>
                <p className="mt-1 text-sm text-muted-foreground">{activeBoard.summary}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant={animationPaused ? "default" : "outline"}
                className="gap-2 uppercase tracking-widest text-xs"
                onClick={() => setAnimationPaused(prev => !prev)}
              >
                {animationPaused ? "Resume Animation" : "Pause Animation"}
              </Button>
              {SHOWCASE_BOARDS.map(board => (
                <Button
                  key={board.id}
                  type="button"
                  size="sm"
                  variant={board.id === activeBoard.id ? "default" : "outline"}
                  className="gap-2 uppercase tracking-widest text-xs"
                  onClick={() => setActiveBoardId(board.id)}
                >
                  <Waves className="h-3.5 w-3.5" />
                  {board.name}
                </Button>
              ))}
            </div>
          </div>
        </section>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_24rem]">
          <div className="relative min-h-[34rem] overflow-hidden bg-black">
            <Canvas camera={{ position: [0, 39, 48], fov: 45 }} shadows>
              <ShowcaseScene
                board={activeBoard}
                overrides={overrides}
                selectedStationId={selectedStationId}
                animationPaused={animationPaused}
              />
            </Canvas>
          </div>

          <aside className="overflow-y-auto border-t border-border bg-card/65 lg:border-l lg:border-t-0">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <Target className="h-4 w-4 text-primary" />
                <span className="font-mono text-xs font-bold uppercase tracking-widest">Stations</span>
              </div>
              <Badge variant="outline">{activeBoard.stations.length}</Badge>
            </div>
            <div className="grid gap-2 p-3">
              {activeBoard.stations.map(station => (
                <button
                  key={station.id}
                  type="button"
                  className={`rounded border p-3 text-left transition-colors ${
                    station.id === selectedStationId
                      ? "border-primary bg-primary/10"
                      : "border-border bg-background/65 hover:border-primary/50"
                  }`}
                  onClick={() => setSelectedStationId(station.id)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-xs font-bold uppercase tracking-widest text-foreground">{station.label}</span>
                    <Badge variant="secondary">{stationTypeLabel(station)}</Badge>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">{station.note}</p>
                </button>
              ))}
            </div>

            {selectedStation ? (
              <div className="border-t border-border p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <SlidersHorizontal className="h-4 w-4 text-primary" />
                    <span className="font-mono text-xs font-bold uppercase tracking-widest">Tune Preview</span>
                  </div>
                  <Button type="button" variant="outline" size="sm" className="gap-2 text-xs uppercase tracking-widest" onClick={resetSelected}>
                    <RotateCcw className="h-3.5 w-3.5" />
                    Reset
                  </Button>
                </div>

                <div className="grid gap-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
                    <ColorControl label="Primary Color" value={selectedTuning.color} onChange={color => updateSelected({ color })} />
                    <ColorControl label={selectedIsArcParticleSpray ? "Outline Color" : "Accent Color"} value={selectedTuning.secondaryColor} onChange={secondaryColor => updateSelected({ secondaryColor })} />
                  </div>
                  <SliderControl label="Speed" value={selectedTuning.speed} min={0.25} max={3} step={0.05} onChange={speed => updateSelected({ speed })} />
                  <SliderControl label="Size" value={selectedTuning.size} min={0.25} max={3} step={0.05} onChange={size => updateSelected({ size })} />
                  <SliderControl label="Fade" value={selectedTuning.fade} min={0.25} max={3} step={0.05} onChange={fade => updateSelected({ fade })} />
                  <SliderControl label="Intensity" value={selectedTuning.intensity} min={0.1} max={3} step={0.05} onChange={intensity => updateSelected({ intensity })} />
                  <SliderControl label="Spread" value={selectedTuning.spread} min={0.2} max={3} step={0.05} onChange={spread => updateSelected({ spread })} />
                  <SliderControl label="Count" value={selectedTuning.count} min={1} max={selectedIsArcParticleSpray ? 96 : selectedIsPersistentImpactFlashes ? 40 : 16} step={1} onChange={count => updateSelected({ count })} />
                  <SliderControl label={selectedIsArcParticleSpray ? "Arc Angle" : "Arc Height"} value={selectedTuning.arc} min={0} max={6} step={0.05} onChange={arc => updateSelected({ arc })} />
                  <SliderControl label="Thickness" value={selectedTuning.thickness} min={0.25} max={4} step={0.05} onChange={thickness => updateSelected({ thickness })} />
                  {supportsRibbonRandomness(selectedStation) ? (
                    <SliderControl
                      label="Randomness"
                      value={selectedTuning.randomness ?? 0}
                      min={0}
                      max={1.5}
                      step={0.05}
                      onChange={randomness => updateSelected({ randomness })}
                    />
                  ) : null}
                  {selectedIsArcParticleSpray ? (
                    <SliderControl
                      label="Ribbon Effect"
                      value={selectedTuning.ribbonEffect ?? 0.7}
                      min={0}
                      max={2}
                      step={0.05}
                      onChange={ribbonEffect => updateSelected({ ribbonEffect })}
                    />
                  ) : null}
                </div>

                <div className="mt-4 border-t border-border pt-4">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="font-mono text-xs font-bold uppercase tracking-widest text-primary">Export Preset</span>
                    <Button type="button" variant="outline" size="sm" className="gap-2 text-xs uppercase tracking-widest" onClick={copyPreset}>
                      <Copy className="h-3.5 w-3.5" />
                      Copy
                    </Button>
                  </div>
                  <Textarea value={exportText} readOnly className="min-h-48 font-mono text-xs" />
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </Layout>
  );
}
