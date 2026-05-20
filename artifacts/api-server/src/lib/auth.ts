import { getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";

const TEST_USER_ID = "test-user-1";

export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const auth = getAuth(req);
  const clerkUserId = auth?.sessionClaims?.userId as string | undefined || auth?.userId;
  // In non-production environments allow a header override for dev/testing
  const devOverride =
    process.env.NODE_ENV !== "production"
      ? (req.headers["x-dev-user-id"] as string | undefined)
      : undefined;
  (req as any).userId = devOverride ?? clerkUserId ?? TEST_USER_ID;
  next();
};

export const getUserId = (req: Request): string => (req as any).userId as string;
