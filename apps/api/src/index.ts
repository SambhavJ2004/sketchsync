import { env } from "./env.js";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { authRouter } from "./auth/routes.js";
import { roomRouter } from "./rooms/routes.js";

const app = express();

// DEFENCE IN DEPTH, no longer load-bearing. The browser now reaches this API
// same-origin through the web app's `/api/*` rewrite, so these headers are not
// exercised by normal traffic — a proxied request carries no `Origin` the
// browser will police. Kept because it still constrains anything that DOES call
// this port directly from a page (a stray tool, a misconfigured deploy that
// exposes the API publicly), and removing it would silently widen that surface.
// `origin` takes an array as readily as a string, and `cors` compares each
// entry with an exact string match — the same semantics as the single-value
// form, just several of them. Passing the parsed list keeps this and the
// realtime upgrade allowlist reading from one configured value.
app.use(cors({ origin: [...env.WEB_ORIGIN], credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.use("/auth", authRouter);
app.use("/rooms", roomRouter);

// Central error handler: log only the message (never request bodies/passwords)
// and return a generic 500 so internals aren't leaked.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  console.error("Unhandled error:", err instanceof Error ? err.message : err);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ message: "Internal server error" });
});

app.listen(env.API_PORT, () => {
  console.log(`api up on http://localhost:${env.API_PORT}`);
});
