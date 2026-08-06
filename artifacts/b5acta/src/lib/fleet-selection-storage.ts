export type StoredFleetSelectionEntry = {
  shipModelId: number;
  count: number;
};

export type StoredFleetSelection = {
  gameId: number;
  ownerId: string;
  savedFleetId?: number | null;
  entries: StoredFleetSelectionEntry[];
  updatedAt: number;
};

export function fleetSelectionStorageKey(gameId: number, ownerId: string) {
  return `b5acta:fleet-selection:${gameId}:${ownerId}`;
}

export function readStoredFleetSelection(
  gameId: number,
  ownerId: string,
): StoredFleetSelection | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(
      fleetSelectionStorageKey(gameId, ownerId),
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredFleetSelection>;
    if (parsed.gameId !== gameId || parsed.ownerId !== ownerId) return null;
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries
          .map((entry) => ({
            shipModelId: Number(entry?.shipModelId),
            count: Math.max(0, Math.trunc(Number(entry?.count))),
          }))
          .filter((entry) => entry.shipModelId > 0 && entry.count > 0)
      : [];
    if (entries.length === 0) return null;
    return {
      gameId,
      ownerId,
      savedFleetId:
        typeof parsed.savedFleetId === "number" ? parsed.savedFleetId : null,
      entries,
      updatedAt:
        typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function writeStoredFleetSelection(selection: StoredFleetSelection) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(
    fleetSelectionStorageKey(selection.gameId, selection.ownerId),
    JSON.stringify(selection),
  );
}

export function clearStoredFleetSelection(gameId: number, ownerId: string) {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(fleetSelectionStorageKey(gameId, ownerId));
}
