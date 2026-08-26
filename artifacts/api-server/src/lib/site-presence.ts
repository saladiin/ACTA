export const SITE_PRESENCE_TIMEOUT_MS = 90_000;

export type SitePresenceEntry = {
  userId: string;
  username: string;
  lastSeenAt: number;
};

const activePlayers = new Map<string, SitePresenceEntry>();

export function markSitePresence(userId: string, username: string, now = Date.now()): void {
  activePlayers.set(userId, { userId, username, lastSeenAt: now });
}

export function listSitePresence(now = Date.now()): SitePresenceEntry[] {
  for (const [userId, entry] of activePlayers) {
    if (now - entry.lastSeenAt > SITE_PRESENCE_TIMEOUT_MS) {
      activePlayers.delete(userId);
    }
  }

  return [...activePlayers.values()].sort((a, b) =>
    a.username.localeCompare(b.username, undefined, { sensitivity: "base" }),
  );
}

export function clearSitePresenceForTests(): void {
  activePlayers.clear();
}
