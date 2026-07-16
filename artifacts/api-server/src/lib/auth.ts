import { getAuth } from "@clerk/express";
import { clerkClient } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";

function temporaryUsernameAuthEnabled(): boolean {
  return process.env.B5_USERNAME_AUTH === "true" || process.env.B5_TEMP_USERNAME_AUTH === "true";
}

function isTemporaryUserId(id: string): boolean {
  return id.startsWith("temp-user:");
}

// DEV player-switch override, plus an explicitly-enabled temporary callsign
// mode for local/TailScale testing without Clerk email/password auth.
function getHeaderOverrideUserId(req: Request): { userId: string; skipAllowlist: boolean } | null {
  const header = req.header("x-dev-user-id");
  const id = header?.trim();
  if (!id) return null;
  if (process.env.NODE_ENV !== "production") return { userId: id, skipAllowlist: false };
  if (temporaryUsernameAuthEnabled() && isTemporaryUserId(id)) {
    return { userId: id, skipAllowlist: true };
  }
  return null;
}

const accessCache = new Map<string, boolean>();

function parseIdentityList(raw: string): Set<string> {
  return new Set(
    raw
      .split(/[\s,;]+/g)
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
}

function allowedRemoteUsers(): Set<string> {
  const raw = process.env.B5_ALLOWED_USERS ?? process.env.B5_ACCESS_ALLOWLIST ?? "";
  return parseIdentityList(raw);
}

function configuredAdminUsers(): Set<string> {
  const raw = process.env.B5_ADMIN_USERS ?? process.env.B5_ADMIN_EMAILS ?? "";
  return parseIdentityList(raw);
}

export async function getUserIdentityValues(userId: string): Promise<string[]> {
  const values = new Set<string>([userId.toLowerCase()]);
  try {
    const user = await clerkClient.users.getUser(userId);
    for (const value of [
      user.username,
      ...user.emailAddresses.map((email) => email.emailAddress),
    ]) {
      if (value) values.add(value.toLowerCase());
    }
  } catch {
    // Local/dev temporary users may not exist in Clerk. Their userId remains
    // usable for explicit allowlists such as B5_ADMIN_USERS=test-user-1.
  }
  return [...values];
}

async function isAllowedRemoteUser(userId: string): Promise<boolean> {
  const allowed = allowedRemoteUsers();
  if (allowed.size === 0) return true;
  const cacheKey = `${userId}:${Array.from(allowed).join("|")}`;
  const cached = accessCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const identifiers = await getUserIdentityValues(userId);
  const ok = identifiers.some((value) => allowed.has(value));

  accessCache.set(cacheKey, ok);
  return ok;
}

export async function isAdminUser(userId: string): Promise<boolean> {
  const admins = configuredAdminUsers();
  if (admins.size === 0) return false;
  const identifiers = await getUserIdentityValues(userId);
  return identifiers.some((value) => admins.has(value));
}

export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const headerOverride = getHeaderOverrideUserId(req);
  if (headerOverride) {
    if (headerOverride.skipAllowlist) {
      (req as any).userId = headerOverride.userId;
      next();
      return;
    }
    void isAllowedRemoteUser(headerOverride.userId)
      .then((ok) => {
        if (!ok) {
          res.status(403).json({ title: "Forbidden", detail: "This account is not on the game access list." });
          return;
        }
        (req as any).userId = headerOverride.userId;
        next();
      })
      .catch(next);
    return;
  }
  const auth = getAuth(req);
  const clerkUserId = (auth?.sessionClaims?.userId as string | undefined) || auth?.userId;
  if (!clerkUserId) {
    res.status(401).json({ title: "Unauthorized", detail: "Authentication required." });
    return;
  }
  void isAllowedRemoteUser(clerkUserId)
    .then((ok) => {
      if (!ok) {
        res.status(403).json({ title: "Forbidden", detail: "This account is not on the game access list." });
        return;
      }
      (req as any).userId = clerkUserId;
      next();
    })
    .catch(next);
};

export const getUserId = (req: Request): string => (req as any).userId as string;

export const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
  requireAuth(req, res, () => {
    const userId = getUserId(req);
    void isAdminUser(userId)
      .then((ok) => {
        if (!ok) {
          res.status(403).json({ title: "Forbidden", detail: "Admin access required." });
          return;
        }
        next();
      })
      .catch(next);
  });
};
