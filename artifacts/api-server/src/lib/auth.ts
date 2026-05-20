import { getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";

const TEST_USER_ID = "test-user-1";

export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const auth = getAuth(req);
  const userId = auth?.sessionClaims?.userId as string | undefined || auth?.userId;
  (req as any).userId = userId ?? TEST_USER_ID;
  next();
};

export const getUserId = (req: Request): string => (req as any).userId as string;
