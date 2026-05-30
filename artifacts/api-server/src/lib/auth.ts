import { getAuth } from "@clerk/express";
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

export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const devUserId = getDevOverrideUserId(req);
  if (devUserId) {
    (req as any).userId = devUserId;
    next();
    return;
  }
  const auth = getAuth(req);
  const clerkUserId = (auth?.sessionClaims?.userId as string | undefined) || auth?.userId;
  if (!clerkUserId) {
    res.status(401).json({ title: "Unauthorized", detail: "Authentication required." });
    return;
  }
  (req as any).userId = clerkUserId;
  next();
};

export const getUserId = (req: Request): string => (req as any).userId as string;
