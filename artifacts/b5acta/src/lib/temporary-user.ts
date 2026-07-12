import { useEffect, useState } from "react";

const LS_KEY = "b5-temporary-username";
const EVENT = "b5-temporary-user-changed";

export const temporaryUsernameAuthEnabled = import.meta.env.VITE_B5_USERNAME_AUTH === "true";

export function sanitizeTemporaryUsername(raw: string): string {
  return raw.replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 24);
}

export function getTemporaryUsername(): string | null {
  if (typeof window === "undefined" || !temporaryUsernameAuthEnabled) return null;
  const username = sanitizeTemporaryUsername(localStorage.getItem(LS_KEY) ?? "");
  return username.length >= 2 ? username : null;
}

export function getTemporaryUserId(): string | null {
  const username = getTemporaryUsername();
  return username ? `temp-user:${encodeURIComponent(username)}` : null;
}

export function setTemporaryUsername(username: string): void {
  const cleaned = sanitizeTemporaryUsername(username);
  if (cleaned.length >= 2) {
    localStorage.setItem(LS_KEY, cleaned);
  } else {
    localStorage.removeItem(LS_KEY);
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: cleaned }));
}

export function clearTemporaryUsername(): void {
  localStorage.removeItem(LS_KEY);
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function useTemporaryUsername(): string | null {
  const [username, setUsername] = useState<string | null>(getTemporaryUsername);
  useEffect(() => {
    const handler = () => setUsername(getTemporaryUsername());
    window.addEventListener(EVENT, handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener(EVENT, handler);
      window.removeEventListener("storage", handler);
    };
  }, []);
  return username;
}
