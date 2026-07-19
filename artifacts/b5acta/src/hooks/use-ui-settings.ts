import { useCallback, useEffect, useState } from "react";

export type UiControlMode =
  | "mode-a"
  | "mode-b"
  | "mode-c"
  | "mode-d"
  | "mode-e"
  | "mode-f";
export type UiArcColorScheme = "classic" | "side";
export type UiBoardBackgroundMode = "skybox" | "black";
export type UiShipStatusDisplayMode = "bar" | "text";

const CONTROL_MODE_STORAGE_KEY = "b5acta.ui.controlMode";
const ARC_COLOR_SCHEME_STORAGE_KEY = "b5acta.ui.arcColorScheme";
const SHIP_MESH_TINTS_STORAGE_KEY = "b5acta.ui.shipMeshTints";
const SHIP_HULL_NAMES_STORAGE_KEY = "b5acta.ui.shipHullNames";
const SHIP_STATUS_DISPLAY_MODE_STORAGE_KEY = "b5acta.ui.shipStatusDisplayMode";
const BOARD_OPACITY_STORAGE_KEY = "b5acta.ui.boardOpacity";
const BOARD_GRID_STORAGE_KEY = "b5acta.ui.boardGrid";
const ATTACK_PHASE_PULSE_OPACITY_STORAGE_KEY =
  "b5acta.ui.attackPhasePulseOpacity";
const ATTACK_PHASE_PULSE_STRENGTH_STORAGE_KEY =
  "b5acta.ui.attackPhasePulseStrength";
const BOARD_BACKGROUND_MODE_STORAGE_KEY = "b5acta.ui.boardBackgroundMode";
const WEAPON_ARC_PROJECTION_STORAGE_KEY = "b5acta.ui.weaponArcProjection";
const ISO_CAMERA_CONTROLS_STORAGE_KEY = "b5acta.ui.isoCameraControls";
const SETTINGS_CHANGED_EVENT = "b5acta-ui-settings-change";

function readControlMode(): UiControlMode {
  if (typeof window === "undefined") return "mode-a";
  const raw = window.localStorage.getItem(CONTROL_MODE_STORAGE_KEY);
  return raw === "mode-a" ||
    raw === "mode-b" ||
    raw === "mode-c" ||
    raw === "mode-d" ||
    raw === "mode-e" ||
    raw === "mode-f"
    ? raw
    : "mode-a";
}

function readArcColorScheme(): UiArcColorScheme {
  if (typeof window === "undefined") return "classic";
  const raw = window.localStorage.getItem(ARC_COLOR_SCHEME_STORAGE_KEY);
  return raw === "side" ? "side" : "classic";
}

function readShipMeshTintsEnabled(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(SHIP_MESH_TINTS_STORAGE_KEY) !== "false";
}

function readShipHullNamesEnabled(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(SHIP_HULL_NAMES_STORAGE_KEY) !== "false";
}

function readShipStatusDisplayMode(): UiShipStatusDisplayMode {
  if (typeof window === "undefined") return "bar";
  return window.localStorage.getItem(SHIP_STATUS_DISPLAY_MODE_STORAGE_KEY) ===
    "text"
    ? "text"
    : "bar";
}

function readBoardOpacity(): number {
  if (typeof window === "undefined") return 100;
  const raw = Number(window.localStorage.getItem(BOARD_OPACITY_STORAGE_KEY));
  return Number.isFinite(raw)
    ? Math.max(0, Math.min(100, Math.round(raw)))
    : 100;
}

function readBoardGridEnabled(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(BOARD_GRID_STORAGE_KEY) !== "false";
}

function readAttackPhasePulseOpacity(): number {
  if (typeof window === "undefined") return 18;
  const raw = Number(
    window.localStorage.getItem(ATTACK_PHASE_PULSE_OPACITY_STORAGE_KEY),
  );
  return Number.isFinite(raw)
    ? Math.max(0, Math.min(100, Math.round(raw)))
    : 18;
}

function readAttackPhasePulseStrength(): number {
  if (typeof window === "undefined") return 35;
  const raw = Number(
    window.localStorage.getItem(ATTACK_PHASE_PULSE_STRENGTH_STORAGE_KEY),
  );
  return Number.isFinite(raw)
    ? Math.max(0, Math.min(100, Math.round(raw)))
    : 35;
}

function readBoardBackgroundMode(): UiBoardBackgroundMode {
  if (typeof window === "undefined") return "skybox";
  return window.localStorage.getItem(BOARD_BACKGROUND_MODE_STORAGE_KEY) ===
    "black"
    ? "black"
    : "skybox";
}

function readWeaponArcProjectionEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.localStorage.getItem(WEAPON_ARC_PROJECTION_STORAGE_KEY) === "true"
  );
}

function readIsoCameraControlsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.localStorage.getItem(ISO_CAMERA_CONTROLS_STORAGE_KEY) === "true"
  );
}

export function useUiControlMode(): [
  UiControlMode,
  (mode: UiControlMode) => void,
] {
  const [mode, setModeState] = useState<UiControlMode>(() => readControlMode());

  useEffect(() => {
    const sync = () => setModeState(readControlMode());
    window.addEventListener("storage", sync);
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
    };
  }, []);

  const setMode = useCallback((nextMode: UiControlMode) => {
    window.localStorage.setItem(CONTROL_MODE_STORAGE_KEY, nextMode);
    setModeState(nextMode);
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  }, []);

  return [mode, setMode];
}

export function useUiArcColorScheme(): [
  UiArcColorScheme,
  (scheme: UiArcColorScheme) => void,
] {
  const [scheme, setSchemeState] = useState<UiArcColorScheme>(() =>
    readArcColorScheme(),
  );

  useEffect(() => {
    const sync = () => setSchemeState(readArcColorScheme());
    window.addEventListener("storage", sync);
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
    };
  }, []);

  const setScheme = useCallback((nextScheme: UiArcColorScheme) => {
    window.localStorage.setItem(ARC_COLOR_SCHEME_STORAGE_KEY, nextScheme);
    setSchemeState(nextScheme);
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  }, []);

  return [scheme, setScheme];
}

export function useUiShipMeshTints(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabledState] = useState<boolean>(() =>
    readShipMeshTintsEnabled(),
  );

  useEffect(() => {
    const sync = () => setEnabledState(readShipMeshTintsEnabled());
    window.addEventListener("storage", sync);
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
    };
  }, []);

  const setEnabled = useCallback((nextEnabled: boolean) => {
    window.localStorage.setItem(
      SHIP_MESH_TINTS_STORAGE_KEY,
      String(nextEnabled),
    );
    setEnabledState(nextEnabled);
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  }, []);

  return [enabled, setEnabled];
}

export function useUiShipHullNames(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabledState] = useState<boolean>(() =>
    readShipHullNamesEnabled(),
  );

  useEffect(() => {
    const sync = () => setEnabledState(readShipHullNamesEnabled());
    window.addEventListener("storage", sync);
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
    };
  }, []);

  const setEnabled = useCallback((nextEnabled: boolean) => {
    window.localStorage.setItem(
      SHIP_HULL_NAMES_STORAGE_KEY,
      String(nextEnabled),
    );
    setEnabledState(nextEnabled);
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  }, []);

  return [enabled, setEnabled];
}

export function useUiShipStatusDisplayMode(): [
  UiShipStatusDisplayMode,
  (mode: UiShipStatusDisplayMode) => void,
] {
  const [mode, setModeState] = useState<UiShipStatusDisplayMode>(() =>
    readShipStatusDisplayMode(),
  );

  useEffect(() => {
    const sync = () => setModeState(readShipStatusDisplayMode());
    window.addEventListener("storage", sync);
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
    };
  }, []);

  const setMode = useCallback((nextMode: UiShipStatusDisplayMode) => {
    window.localStorage.setItem(
      SHIP_STATUS_DISPLAY_MODE_STORAGE_KEY,
      nextMode,
    );
    setModeState(nextMode);
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  }, []);

  return [mode, setMode];
}

export function useUiBoardOpacity(): [number, (opacity: number) => void] {
  const [opacity, setOpacityState] = useState<number>(() => readBoardOpacity());

  useEffect(() => {
    const sync = () => setOpacityState(readBoardOpacity());
    window.addEventListener("storage", sync);
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
    };
  }, []);

  const setOpacity = useCallback((nextOpacity: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(nextOpacity)));
    window.localStorage.setItem(BOARD_OPACITY_STORAGE_KEY, String(clamped));
    setOpacityState(clamped);
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  }, []);

  return [opacity, setOpacity];
}

export function useUiBoardGrid(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabledState] = useState<boolean>(() =>
    readBoardGridEnabled(),
  );

  useEffect(() => {
    const sync = () => setEnabledState(readBoardGridEnabled());
    window.addEventListener("storage", sync);
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
    };
  }, []);

  const setEnabled = useCallback((nextEnabled: boolean) => {
    window.localStorage.setItem(BOARD_GRID_STORAGE_KEY, String(nextEnabled));
    setEnabledState(nextEnabled);
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  }, []);

  return [enabled, setEnabled];
}

export function useUiAttackPhasePulseOpacity(): [
  number,
  (opacity: number) => void,
] {
  const [opacity, setOpacityState] = useState<number>(() =>
    readAttackPhasePulseOpacity(),
  );

  useEffect(() => {
    const sync = () => setOpacityState(readAttackPhasePulseOpacity());
    window.addEventListener("storage", sync);
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
    };
  }, []);

  const setOpacity = useCallback((nextOpacity: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(nextOpacity)));
    window.localStorage.setItem(
      ATTACK_PHASE_PULSE_OPACITY_STORAGE_KEY,
      String(clamped),
    );
    setOpacityState(clamped);
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  }, []);

  return [opacity, setOpacity];
}

export function useUiAttackPhasePulseStrength(): [
  number,
  (strength: number) => void,
] {
  const [strength, setStrengthState] = useState<number>(() =>
    readAttackPhasePulseStrength(),
  );

  useEffect(() => {
    const sync = () => setStrengthState(readAttackPhasePulseStrength());
    window.addEventListener("storage", sync);
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
    };
  }, []);

  const setStrength = useCallback((nextStrength: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(nextStrength)));
    window.localStorage.setItem(
      ATTACK_PHASE_PULSE_STRENGTH_STORAGE_KEY,
      String(clamped),
    );
    setStrengthState(clamped);
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  }, []);

  return [strength, setStrength];
}

export function useUiBoardBackgroundMode(): [
  UiBoardBackgroundMode,
  (mode: UiBoardBackgroundMode) => void,
] {
  const [mode, setModeState] = useState<UiBoardBackgroundMode>(() =>
    readBoardBackgroundMode(),
  );

  useEffect(() => {
    const sync = () => setModeState(readBoardBackgroundMode());
    window.addEventListener("storage", sync);
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
    };
  }, []);

  const setMode = useCallback((nextMode: UiBoardBackgroundMode) => {
    window.localStorage.setItem(BOARD_BACKGROUND_MODE_STORAGE_KEY, nextMode);
    setModeState(nextMode);
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  }, []);

  return [mode, setMode];
}

export function useUiWeaponArcProjection(): [
  boolean,
  (enabled: boolean) => void,
] {
  const [enabled, setEnabledState] = useState<boolean>(() =>
    readWeaponArcProjectionEnabled(),
  );

  useEffect(() => {
    const sync = () => setEnabledState(readWeaponArcProjectionEnabled());
    window.addEventListener("storage", sync);
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
    };
  }, []);

  const setEnabled = useCallback((nextEnabled: boolean) => {
    window.localStorage.setItem(
      WEAPON_ARC_PROJECTION_STORAGE_KEY,
      String(nextEnabled),
    );
    setEnabledState(nextEnabled);
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  }, []);

  return [enabled, setEnabled];
}

export function useUiIsoCameraControls(): [
  boolean,
  (enabled: boolean) => void,
] {
  const [enabled, setEnabledState] = useState<boolean>(() =>
    readIsoCameraControlsEnabled(),
  );

  useEffect(() => {
    const sync = () => setEnabledState(readIsoCameraControlsEnabled());
    window.addEventListener("storage", sync);
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
    };
  }, []);

  const setEnabled = useCallback((nextEnabled: boolean) => {
    window.localStorage.setItem(
      ISO_CAMERA_CONTROLS_STORAGE_KEY,
      String(nextEnabled),
    );
    setEnabledState(nextEnabled);
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  }, []);

  return [enabled, setEnabled];
}
