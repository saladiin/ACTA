import { getAuth } from "@clerk/express";
import { clerkClient } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";

// DEV-ONLY player-switch override. When NOT running in production, an
// `x-dev-user-id` request header lets a single tester act as either commander
// (e.g. test-user-1 / test-user-2) so they can set up and play both sides of a
// game without two real Clerk accounts. This is the mechanism the b5acta dev
// toggle drives. It is hard-gated on NODE_ENV: the published deployment runs
// with NODE_ENV=production (see artifact.toml), so the header is ALWAYS ignored
// there and can never be used to impersonate a real user.
function getDevOverrideUserId(req: Request): string | null {
  if (process.env.NODE_ENV === "production") return null;
  const header = req.header("x-dev-user-id");
  const id = header?.trim();
  return id ? id : null;
}

const accessCache = new Map<string, boolean>();

function allowedRemoteUsers(): Set<string> {
  const raw = process.env.B5_ALLOWED_USERS ?? process.env.B5_ACCESS_ALLOWLIST ?? "";
  return new Set(
    raw
      .split(/[\s,;]+/g)
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function isAllowedRemoteUser(userId: string): Promise<boolean> {
  const allowed = allowedRemoteUsers();
  if (allowed.size === 0) return true;
  const cacheKey = `${userId}:${Array.from(allowed).join("|")}`;
  const cached = accessCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let ok = allowed.has(userId.toLowerCase());
  if (!ok) {
    try {
      const user = await clerkClient.users.getUser(userId);
      const identifiers = [
        user.username,
        ...user.emailAddresses.map((email) => email.emailAddress),
      ]
        .filter((v): v is string => Boolean(v))
        .map((v) => v.toLowerCase());
      ok = identifiers.some((value) => allowed.has(value));
    } catch {
      ok = false;
    }
  }

  accessCache.set(cacheKey, ok);
  return ok;
}

export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const devUserId = getDevOverrideUserId(req);
  if (devUserId) {
    void isAllowedRemoteUser(devUserId)
      .then((ok) => {
        if (!ok) {
          res.status(403).json({ title: "Forbidden", detail: "This account is not on the game access list." });
          return;
        }
        (req as any).userId = devUserId;
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
