import { describe, expect, it } from "vitest";
import { INTERNAL_SECRET_HEADER, WS_CLOSE_EVICTED } from "@sketchsync/shared";
import { Role } from "@sketchsync/db";
import { RoomRegistry, type Conn } from "./registry.js";
import { applyEviction, isAuthorizedInternal } from "./internal.js";
import { createRateLimitState } from "./rateLimit.js";

// Eviction against a real RoomRegistry with stub sockets. No HTTP server and no
// database: the registry is plain in-memory state, which is exactly what makes
// this testable without either.

const SECRET = "an-internal-secret-at-least-16";

interface StubSocket {
  readyState: number;
  closes: { code: number; reason: string }[];
  sent: string[];
  close: (code: number, reason: string) => void;
  send: (payload: string) => void;
}

function stubSocket(readyState = 1 /* OPEN */): StubSocket {
  const s: StubSocket = {
    readyState,
    closes: [],
    sent: [],
    close: (code, reason) => {
      s.closes.push({ code, reason });
      s.readyState = 3; // CLOSED
    },
    send: (payload) => s.sent.push(payload),
  };
  return s;
}

function connFor(userId: string, role: Role, ws: StubSocket): Conn {
  return {
    ws: ws as unknown as Conn["ws"],
    userId,
    name: userId,
    avatarUrl: null,
    roomId: null,
    role,
    rate: createRateLimitState(0),
    parseErrorSent: false,
  };
}

/** A registry with one user's socket in each of two rooms. */
function setup() {
  const registry = new RoomRegistry();
  const socks = {
    targetRoomA: stubSocket(),
    targetRoomA2: stubSocket(), // same user, second tab, same board
    targetRoomB: stubSocket(), // same user, DIFFERENT board
    bystanderRoomA: stubSocket(), // different user, same board
  };
  const conns = {
    targetRoomA: connFor("user-target", Role.EDITOR, socks.targetRoomA),
    targetRoomA2: connFor("user-target", Role.EDITOR, socks.targetRoomA2),
    targetRoomB: connFor("user-target", Role.EDITOR, socks.targetRoomB),
    bystanderRoomA: connFor("user-bystander", Role.EDITOR, socks.bystanderRoomA),
  };
  registry.join("room-a", conns.targetRoomA);
  registry.join("room-a", conns.targetRoomA2);
  registry.join("room-b", conns.targetRoomB);
  registry.join("room-a", conns.bystanderRoomA);
  return { registry, socks, conns };
}

describe("internal endpoint authorization", () => {
  it("refuses a WRONG secret", () => {
    expect(isAuthorizedInternal("not-the-secret-at-all-x", SECRET)).toBe(false);
  });

  it("refuses a MISSING secret header", () => {
    expect(isAuthorizedInternal(undefined, SECRET)).toBe(false);
    expect(isAuthorizedInternal("", SECRET)).toBe(false);
  });

  it("refuses when the header arrives as an array (duplicated header)", () => {
    expect(isAuthorizedInternal([SECRET, SECRET], SECRET)).toBe(false);
  });

  it("FAILS CLOSED when no secret is configured — never falls open", () => {
    // With eviction switched off, an unauthenticated caller must not be able to
    // close anyone's sockets. Refusing everything is the only safe reading.
    expect(isAuthorizedInternal("anything", undefined)).toBe(false);
    expect(isAuthorizedInternal(undefined, undefined)).toBe(false);
    expect(isAuthorizedInternal("", "")).toBe(false);
  });

  it("accepts the exact secret", () => {
    expect(isAuthorizedInternal(SECRET, SECRET)).toBe(true);
  });

  it("is not fooled by a prefix or a longer string", () => {
    expect(isAuthorizedInternal(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(isAuthorizedInternal(SECRET + "x", SECRET)).toBe(false);
  });
});

describe("eviction: removed", () => {
  it("closes every socket that user holds IN THAT ROOM, with a clear code", () => {
    const { registry, socks } = setup();

    const result = applyEviction(registry, {
      action: "removed",
      roomId: "room-a",
      userId: "user-target",
    });

    expect(result).toEqual({ closed: 2, updated: 0 }); // both tabs
    expect(socks.targetRoomA.closes).toEqual([
      { code: WS_CLOSE_EVICTED, reason: "removed from board" },
    ]);
    expect(socks.targetRoomA2.closes).toHaveLength(1);
  });

  it("LEAVES SOCKETS IN OTHER ROOMS UNTOUCHED", () => {
    // Removal is per-board. Losing access to one board must not disconnect the
    // user from every other board they have open.
    const { registry, socks } = setup();

    applyEviction(registry, {
      action: "removed",
      roomId: "room-a",
      userId: "user-target",
    });

    expect(socks.targetRoomB.closes).toEqual([]);
    expect(socks.targetRoomB.readyState).toBe(1);
  });

  it("leaves OTHER USERS in the same room untouched", () => {
    const { registry, socks } = setup();

    applyEviction(registry, {
      action: "removed",
      roomId: "room-a",
      userId: "user-target",
    });

    expect(socks.bystanderRoomA.closes).toEqual([]);
  });

  it("is a no-op for an unknown room or a user with no sockets", () => {
    const { registry } = setup();
    expect(
      applyEviction(registry, {
        action: "removed",
        roomId: "room-nope",
        userId: "user-target",
      }),
    ).toEqual({ closed: 0, updated: 0 });
    expect(
      applyEviction(registry, {
        action: "removed",
        roomId: "room-a",
        userId: "user-nobody",
      }),
    ).toEqual({ closed: 0, updated: 0 });
  });
});

describe("eviction: role changed", () => {
  it("UPDATES THE ROLE IN PLACE WITHOUT CLOSING the socket", () => {
    // A demotion is not a disconnect: the user stays on the board, they just
    // stop being able to write. `canWrite` reads conn.role on every mutation,
    // so rewriting it here is the whole enforcement mechanism.
    const { registry, socks, conns } = setup();

    const result = applyEviction(registry, {
      action: "roleChanged",
      roomId: "room-a",
      userId: "user-target",
      role: "VIEWER",
    });

    expect(result).toEqual({ closed: 0, updated: 2 });
    expect(conns.targetRoomA.role).toBe(Role.VIEWER);
    expect(conns.targetRoomA2.role).toBe(Role.VIEWER);
    expect(socks.targetRoomA.closes).toEqual([]);
    expect(socks.targetRoomA2.closes).toEqual([]);
  });

  it("tells the client, using the existing `error` frame", () => {
    // Deliberately NOT a new ServerMessage type: the client validates inbound
    // frames against the union and silently drops unknown ones, so a new type
    // would be invisible without a client change. `error` already surfaces as a
    // toast.
    const { registry, socks } = setup();

    applyEviction(registry, {
      action: "roleChanged",
      roomId: "room-a",
      userId: "user-target",
      role: "VIEWER",
    });

    expect(socks.targetRoomA.sent).toHaveLength(1);
    const frame = JSON.parse(socks.targetRoomA.sent[0] ?? "{}") as {
      type: string;
      message: string;
    };
    expect(frame.type).toBe("error");
    expect(frame.message).toMatch(/view-only/i);
  });

  it("does not touch the same user's role in a DIFFERENT room", () => {
    const { registry, conns } = setup();

    applyEviction(registry, {
      action: "roleChanged",
      roomId: "room-a",
      userId: "user-target",
      role: "VIEWER",
    });

    expect(conns.targetRoomB.role).toBe(Role.EDITOR);
  });

  it("does not touch other users' roles", () => {
    const { registry, conns } = setup();

    applyEviction(registry, {
      action: "roleChanged",
      roomId: "room-a",
      userId: "user-target",
      role: "VIEWER",
    });

    expect(conns.bystanderRoomA.role).toBe(Role.EDITOR);
  });

  it("skips sending to a socket that is not OPEN, but still rewrites the role", () => {
    const registry = new RoomRegistry();
    const closing = stubSocket(2 /* CLOSING */);
    const conn = connFor("user-target", Role.EDITOR, closing);
    registry.join("room-a", conn);

    const result = applyEviction(registry, {
      action: "roleChanged",
      roomId: "room-a",
      userId: "user-target",
      role: "VIEWER",
    });

    expect(result.updated).toBe(1);
    expect(conn.role).toBe(Role.VIEWER);
    expect(closing.sent).toEqual([]);
  });
});

describe("registry survives a socket that throws on close", () => {
  it("counts what it could close and does not propagate", () => {
    const registry = new RoomRegistry();
    const angry = stubSocket();
    angry.close = () => {
      throw new Error("socket already destroyed");
    };
    const ok = stubSocket();
    registry.join("room-a", connFor("u", Role.EDITOR, angry));
    registry.join("room-a", connFor("u", Role.EDITOR, ok));

    const result = applyEviction(registry, {
      action: "removed",
      roomId: "room-a",
      userId: "u",
    });

    expect(result.closed).toBe(1); // the healthy one
    expect(ok.closes).toHaveLength(1);
  });
});

describe("the header constant", () => {
  it("is lowercase, because Node lowercases incoming header names", () => {
    // req.headers[INTERNAL_SECRET_HEADER] only works if the constant is already
    // lowercase; an uppercase constant would silently always read undefined and
    // every eviction would 403.
    expect(INTERNAL_SECRET_HEADER).toBe(INTERNAL_SECRET_HEADER.toLowerCase());
  });
});

describe("close code", () => {
  it("is in the application-private range (RFC 6455: 4000-4999)", () => {
    expect(WS_CLOSE_EVICTED).toBeGreaterThanOrEqual(4000);
    expect(WS_CLOSE_EVICTED).toBeLessThanOrEqual(4999);
  });
});
