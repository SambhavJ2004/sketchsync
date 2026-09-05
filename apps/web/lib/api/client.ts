// Centralized HTTP client for the api service. Every call sends credentials so
// the httpOnly `sketchsync_token` cookie rides along (auth is cookie-based; the
// client can never read the token). All fetches go through `request`, which
// surfaces the API's JSON error shape (message + Zod field issues) as ApiError.

/**
 * SAME-ORIGIN by construction. `/api/*` is rewritten to the real API by
 * next.config.ts, so the session cookie is a first-party cookie on the web
 * origin — `SameSite=Lax` cookies are not sent (nor even stored) cross-site,
 * which broke auth completely whenever web and api were on different origins.
 *
 * Being a relative path also means no origin is inlined into the bundle at
 * build time: pointing an environment at a different API is a server-side
 * `API_ORIGIN` change, not a rebuild.
 */
const API_URL = "/api";

// Still absolute: the WebSocket is a separate origin and is NOT covered by the
// rewrite (a rewrite cannot proxy a WebSocket). It does NOT use the session
// cookie — since 4.3b the socket authenticates with a single-use ticket minted
// by POST /auth/ws-ticket and passed via Sec-WebSocket-Protocol, verified at the
// upgrade behind an Origin allowlist. There is deliberately no cookie fallback.
// Unlike API_URL this one IS inlined at build time, so changing it is a rebuild.
export const REALTIME_URL =
  process.env.NEXT_PUBLIC_REALTIME_URL ?? "ws://localhost:3002";

export type Role = "OWNER" | "EDITOR" | "VIEWER";

/** Safe user shape returned by the api (never the passwordHash). */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

/** A room plus the caller's role in it (GET /rooms, POST /rooms, join). */
export interface RoomSummary {
  id: string;
  slug: string;
  name: string;
  ownerId: string;
  role: Role;
}

/** GET /rooms/:slug adds the member count. */
export interface RoomDetail extends RoomSummary {
  memberCount: number;
}

/** One field-level validation issue mirrored from the api's Zod formatter. */
export interface FieldIssue {
  path: string;
  message: string;
}

/**
 * Thrown for any non-2xx response. `status` lets callers branch (401/403/404),
 * `issues` carries per-field Zod errors for form display.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: FieldIssue[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ErrorBody {
  message?: string;
  issues?: FieldIssue[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      credentials: "include",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      ...init,
    });
  } catch {
    // Network / server-down: give callers a stable status to branch on.
    throw new ApiError(0, "Can't reach the server. Is the API running?");
  }

  if (res.status === 204) return undefined as T;

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body — fall through to generic handling.
  }

  if (!res.ok) {
    const err = (body ?? {}) as ErrorBody;
    throw new ApiError(
      res.status,
      err.message ?? `Request failed (${res.status})`,
      err.issues,
    );
  }
  return body as T;
}

// ── Auth ──────────────────────────────────────────────────────────────────
export const api = {
  signup(input: { name: string; email: string; password: string }) {
    return request<AuthUser>("/auth/signup", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  signin(input: { email: string; password: string }) {
    return request<AuthUser>("/auth/signin", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  signout() {
    return request<{ ok: true }>("/auth/signout", { method: "POST" });
  },
  me() {
    return request<AuthUser>("/auth/me");
  },
  /**
   * Mint a single-use, seconds-lived ticket for opening the WebSocket. Goes
   * through the same-origin /api proxy, so the session cookie authenticates it;
   * the socket itself cannot use that cookie (different origin, and a rewrite
   * cannot proxy a WebSocket).
   *
   * A 401 here is the authoritative "your session is gone" signal — the browser
   * cannot read the status of a failed WS handshake, so this call is where the
   * client learns the difference between a bad ticket and a bad session.
   */
  wsTicket() {
    return request<{ ticket: string; expiresAt: string; ttlSeconds: number }>(
      "/auth/ws-ticket",
      { method: "POST" },
    );
  },

  // ── Rooms ─────────────────────────────────────────────────────────────
  listRooms() {
    return request<RoomSummary[]>("/rooms");
  },
  createRoom(name: string) {
    return request<RoomSummary>("/rooms", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },
  getRoom(slug: string) {
    return request<RoomDetail>(`/rooms/${encodeURIComponent(slug)}`);
  },
  /** Rename a board. OWNER only — the API returns 403 for anyone else. */
  renameRoom(slug: string, name: string) {
    return request<RoomSummary>(`/rooms/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  },
  joinRoom(slug: string) {
    return request<RoomSummary>(`/rooms/${encodeURIComponent(slug)}/join`, {
      method: "POST",
    });
  },
};
