import { useEffect, useState } from "react";

export type InputKind = "mouse" | "touch" | "hybrid";
export type LayoutKind = "compact" | "roomy";
export type PlatformKind = "ios" | "android" | "desktop" | "unknown";
export type DeviceClass = "phone" | "tablet" | "desktop" | "unknown";

export interface InputProfile {
  input: InputKind;
  layout: LayoutKind;
  platform: PlatformKind;
  deviceClass: DeviceClass;
  hasTouch: boolean;
  hasHover: boolean;
  coarsePointer: boolean;
  compactViewport: boolean;
}

function detectPlatform(): PlatformKind {
  if (typeof navigator === "undefined") return "unknown";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = `${nav.userAgentData?.platform ?? nav.platform ?? ""}`.toLowerCase();
  const ua = nav.userAgent.toLowerCase();
  const maxTouchPoints = nav.maxTouchPoints ?? 0;

  if (/android/.test(ua) || platform.includes("android")) return "android";
  if (/iphone|ipad|ipod/.test(ua) || /iphone|ipad|ipod/.test(platform)) return "ios";
  if (platform.includes("mac") && maxTouchPoints > 1) return "ios";
  if (platform || ua) return "desktop";
  return "unknown";
}

function detectDeviceClass(platform: PlatformKind, hasTouch: boolean): DeviceClass {
  if (typeof window === "undefined") return "unknown";
  if (!hasTouch && platform === "desktop") return "desktop";
  if (!hasTouch) return platform === "unknown" ? "unknown" : "desktop";

  const width = window.visualViewport?.width ?? window.innerWidth;
  const height = window.visualViewport?.height ?? window.innerHeight;
  const shortestSide = Math.min(width, height);

  if (platform === "ios" || platform === "android") {
    return shortestSide >= 600 ? "tablet" : "phone";
  }

  if (hasTouch) return shortestSide >= 600 ? "tablet" : "phone";
  return "desktop";
}

function readProfile(): InputProfile {
  if (typeof window === "undefined") {
    return {
      input: "mouse",
      layout: "roomy",
      platform: "unknown",
      deviceClass: "unknown",
      hasTouch: false,
      hasHover: true,
      coarsePointer: false,
      compactViewport: false,
    };
  }

  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  const hasHover = window.matchMedia("(hover: hover)").matches;
  const compactViewport = window.matchMedia("(max-width: 767px), (max-height: 520px)").matches;
  const hasTouch = "ontouchstart" in window || (navigator.maxTouchPoints ?? 0) > 0;
  const input: InputKind =
    hasTouch && finePointer ? "hybrid" :
    hasTouch || coarsePointer || !hasHover ? "touch" :
    "mouse";
  const platform = detectPlatform();
  const deviceClass = detectDeviceClass(platform, hasTouch);

  return {
    input,
    layout: compactViewport || deviceClass === "phone" ? "compact" : "roomy",
    platform,
    deviceClass,
    hasTouch,
    hasHover,
    coarsePointer,
    compactViewport,
  };
}

export function useInputProfile(): InputProfile {
  const [profile, setProfile] = useState<InputProfile>(() => readProfile());

  useEffect(() => {
    const queries = [
      window.matchMedia("(pointer: coarse)"),
      window.matchMedia("(pointer: fine)"),
      window.matchMedia("(hover: hover)"),
      window.matchMedia("(max-width: 767px), (max-height: 520px)"),
    ];
    const update = () => setProfile(readProfile());

    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    for (const query of queries) query.addEventListener("change", update);

    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      for (const query of queries) query.removeEventListener("change", update);
    };
  }, []);

  return profile;
}
