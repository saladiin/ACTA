import { getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";

export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
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
