import type { CookieOptions, Response } from "express";
import { AUTH_COOKIE, TOKEN_TTL_SECONDS } from "@sketchsync/auth";
import { env } from "../env.js";

// Re-exported so existing imports of `AUTH_COOKIE` from this module keep working;
// the definition itself lives in @sketchsync/auth.
export { AUTH_COOKIE };

/**
 * Base cookie attributes. `secure` is driven by env: false over plain http in
 * dev, true in production (so the cookie is only sent over https).
 */
const baseCookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: env.NODE_ENV === "production",
};

export function setAuthCookie(res: Response, token: string): void {
  res.cookie(AUTH_COOKIE, token, {
    ...baseCookieOptions,
    maxAge: TOKEN_TTL_SECONDS * 1000, // maxAge is in milliseconds
  });
}

export function clearAuthCookie(res: Response): void {
  // Options (path/sameSite/secure) must match those used to set it.
  res.clearCookie(AUTH_COOKIE, baseCookieOptions);
}
