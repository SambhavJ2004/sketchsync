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
/** Roles an invite or a role change may grant. OWNER is deliberately excluded —
 *  a board has one owner and no transfer route (see @sketchsync/shared). */
export type GrantableRole = "EDITOR" | "VIEWER";
export type Visibility = "PRIVATE" | "LINK";

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
  visibility: Visibility;
  role: Role;
}

/** One member of a board (GET /rooms/:slug/members). */
export interface MemberView {
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: Role;
  /** True for `Room.ownerId`. The owner cannot be removed or demoted. */
  isOwner: boolean;
}

/** An invite as the owner sees it. NEVER carries the token. */
export interface InviteView {
  id: string;
  role: Role;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  usedCount: number;
  revokedAt: string | null;
  /** Derived server-side: would this be accepted right now? */
  active: boolean;
}

/** The one response that carries a raw token — shown once, never recoverable. */
export interface CreatedInvite extends InviteView {
  token: string;
  acceptUrl: string;
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
 *
 * `visibility` rides on a 403 from the room routes. Before private boards, every
 * 403 meant "you could join this if you asked", and the board page rendered all
 * of them as a join prompt. Now PRIVATE means "you cannot join without an
 * invite" and LINK means "you may join" — two different screens that the status
 * code alone cannot distinguish.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: FieldIssue[],
    readonly visibility?: Visibility,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ErrorBody {
  message?: string;
  issues?: FieldIssue[];
  visibility?: Visibility;
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
      err.visibility,
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
  /** Rename and/or change visibility. OWNER only; the API enforces it. */
  updateRoom(slug: string, patch: { name?: string; visibility?: Visibility }) {
    return request<RoomSummary>(`/rooms/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },

  // ── Members ───────────────────────────────────────────────────────────
  listMembers(slug: string) {
    return request<MemberView[]>(`/rooms/${encodeURIComponent(slug)}/members`);
  },
  updateMemberRole(slug: string, userId: string, role: GrantableRole) {
    return request<{ userId: string; role: Role }>(
      `/rooms/${encodeURIComponent(slug)}/members/${encodeURIComponent(userId)}`,
      { method: "PATCH", body: JSON.stringify({ role }) },
    );
  },
  removeMember(slug: string, userId: string) {
    return request<{ ok: true; userId: string }>(
      `/rooms/${encodeURIComponent(slug)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
  },

  // ── Invites ───────────────────────────────────────────────────────────
  /** Mint an invite. The response is the ONLY time the raw token exists. */
  createInvite(
    slug: string,
    input: { role: GrantableRole; expiresInHours: number; maxUses: number },
  ) {
    return request<CreatedInvite>(`/rooms/${encodeURIComponent(slug)}/invites`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  listInvites(slug: string) {
    return request<InviteView[]>(`/rooms/${encodeURIComponent(slug)}/invites`);
  },
  revokeInvite(slug: string, inviteId: string) {
    return request<{ ok: true; alreadyRevoked: boolean }>(
      `/rooms/${encodeURIComponent(slug)}/invites/${encodeURIComponent(inviteId)}`,
      { method: "DELETE" },
    );
  },
  /** Redeem an invite. 401 = not signed in, 404 = unknown, 410 = expired /
   *  revoked / used up (the message says which). */
  acceptInvite(token: string) {
    return request<RoomSummary>(`/invites/${encodeURIComponent(token)}/accept`, {
      method: "POST",
    });
  },
};
