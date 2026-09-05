import type { NextFunction, Request, Response } from "express";
import { AUTH_COOKIE, verifyToken } from "@sketchsync/auth";
import { env } from "../env.js";

/**
 * Verifies the auth cookie's JWT and attaches `req.userId`. Responds 401 if the
 * cookie is missing or the token is invalid/expired. Room routes will reuse this
 * in the next step.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token: unknown = req.cookies?.[AUTH_COOKIE];
  if (typeof token !== "string") {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  const payload = verifyToken(token, env.JWT_SECRET);
  if (!payload) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  req.userId = payload.userId;
  next();
}
