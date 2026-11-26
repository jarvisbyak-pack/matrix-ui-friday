import type { NextFunction, Request, Response } from "express";
import { AuthService, type AuthenticatedUser } from "./service.js";

export type AuthenticatedRequest = Request & {
  userId: string;
  user: AuthenticatedUser;
};

export function requireAuth(auth = new AuthService()) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      res.status(401).json({ error: { code: "AUTH_REQUIRED", message: "Authentication required." } });
      return;
    }

    try {
      const user = await auth.authenticate(token);
      if (!user) {
        res.status(401).json({ error: { code: "INVALID_SESSION", message: "Invalid or expired session." } });
        return;
      }
      const authReq = req as unknown as AuthenticatedRequest;
      authReq.userId = user.id;
      authReq.user = user;
      next();
    } catch (error) {
      console.error("Authentication failed:", error);
      res.status(503).json({ error: { code: "AUTH_UNAVAILABLE", message: "Authentication service unavailable." } });
    }
  };
}
