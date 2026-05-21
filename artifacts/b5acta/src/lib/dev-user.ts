import { useEffect, useState } from "react";

const LS_KEY = "dev-user-id";
const EVENT = "dev-user-changed";
const DEFAULT_ID = "test-user-1";

export function getDevUserId(): string {
  if (typeof window === "undefined") return DEFAULT_ID;
  return localStorage.getItem(LS_KEY) ?? DEFAULT_ID;
}

export function setDevUserId(id: string): void {
  localStorage.setItem(LS_KEY, id);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
}

export function useDevUserId(): string {
  const [id, setId] = useState<string>(getDevUserId);
  useEffect(() => {
    const handler = () => setId(getDevUserId());
    window.addEventListener(EVENT, handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener(EVENT, handler);
      window.removeEventListener("storage", handler);
    };
  }, []);
  return id;
}
