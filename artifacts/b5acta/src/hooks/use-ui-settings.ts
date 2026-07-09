import { useCallback, useEffect, useState } from "react";

export type UiControlMode = "mode-a" | "mode-b" | "mode-c" | "mode-d" | "mode-e" | "mode-f";
export type UiArcColorScheme = "classic" | "side";

const CONTROL_MODE_STORAGE_KEY = "b5acta.ui.controlMode";
const ARC_COLOR_SCHEME_STORAGE_KEY = "b5acta.ui.arcColorScheme";
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

export function useUiControlMode(): [UiControlMode, (mode: UiControlMode) => void] {
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

export function useUiArcColorScheme(): [UiArcColorScheme, (scheme: UiArcColorScheme) => void] {
  const [scheme, setSchemeState] = useState<UiArcColorScheme>(() => readArcColorScheme());

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
