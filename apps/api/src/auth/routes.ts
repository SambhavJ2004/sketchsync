import { Router } from "express";
import { SigninInput, SignupInput } from "@sketchsync/shared";
import { Prisma, prismaClient } from "@sketchsync/db";
import { requireAuth } from "../middleware/requireAuth.js";
import { formatZodError } from "../lib/validation.js";
import { DUMMY_HASH, hashPassword, verifyPassword } from "./password.js";
import { WS_TICKET_TTL_SECONDS, signToken } from "@sketchsync/auth";
import { env } from "../env.js";
import { clearAuthCookie, setAuthCookie } from "./cookies.js";
import { toSafeUser } from "./user.js";
import { issueTicket } from "./ticket.js";
import { allowTicket } from "./ticketLimiter.js";

export const authRouter: Router = Router();

// POST /auth/signup
authRouter.post("/signup", async (req, res) => {
  const parsed = SignupInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(formatZodError(parsed.error));
    return;
  }

  const email = parsed.data.email.trim().toLowerCase();
  const { name } = parsed.data;

  // Hash before the insert so the duplicate-email path costs about the same as
  // the success path (avoids an obvious timing signal).
  const passwordHash = await hashPassword(parsed.data.password);

  try {
    const user = await prismaClient.user.create({
      data: { email, passwordHash, name },
    });
    setAuthCookie(res, signToken({ userId: user.id }, env.JWT_SECRET));
    res.status(201).json(toSafeUser(user));
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Unique constraint on email — generic message, don't confirm the account.
      res.status(409).json({ message: "Email already registered" });
      return;
    }
    throw err;
  }
});

// POST /auth/signin
authRouter.post("/signin", async (req, res) => {
  const parsed = SigninInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(formatZodError(parsed.error));
    return;
  }

  const email = parsed.data.email.trim().toLowerCase();
  const user = await prismaClient.user.findUnique({ where: { email } });

  // Always run a bcrypt compare (against a dummy hash when the user is missing)
  // so both failure cases take similar time and return the SAME message.
  const passwordOk = await verifyPassword(
    parsed.data.password,
    user?.passwordHash ?? DUMMY_HASH,
  );

  if (!user || !passwordOk) {
    res.status(401).json({ message: "Invalid email or password" });
    return;
  }

  setAuthCookie(res, signToken({ userId: user.id }, env.JWT_SECRET));
  res.status(200).json(toSafeUser(user));
});

// POST /auth/signout
authRouter.post("/signout", (_req, res) => {
  clearAuthCookie(res);
  res.status(200).json({ ok: true });
});

// GET /auth/me
authRouter.get("/me", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  const user = await prismaClient.user.findUnique({ where: { id: userId } });
  if (!user) {
    // Token valid but the user no longer exists — clear the stale cookie.
    clearAuthCookie(res);
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  res.status(200).json(toSafeUser(user));
});

// POST /auth/ws-ticket
//
// Mints a short-lived, single-use credential for opening the WebSocket. Reached
// SAME-ORIGIN through the web app's /api proxy, so the ordinary session cookie
// authenticates it; the socket itself cannot use that cookie because it must
// reach the realtime host directly and cross-origin.
//
// The ticket carries the userId and nothing else — deliberately no room scope.
// Room membership is still checked at `join` on the gateway (decision #9), so a
// ticket grants "you are this user", never "you may enter this board".
authRouter.post("/ws-ticket", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ message: "Not authenticated" });
    return;
  }

  // A ticket endpoint that can be hammered is a token-minting oracle.
  if (!allowTicket(userId)) {
    res.status(429).json({ message: "Too many ticket requests" });
    return;
  }

  const { ticket, expiresAt } = await issueTicket(userId);
  res.status(201).json({
    ticket,
    expiresAt: expiresAt.toISOString(),
    ttlSeconds: WS_TICKET_TTL_SECONDS,
  });
});
