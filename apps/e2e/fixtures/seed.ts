import "./env.js"; // MUST precede the @sketchsync/db import (see env.ts)
import { randomUUID } from "node:crypto";
import { prismaClient } from "@sketchsync/db";

/**
 * Test fixtures that talk to the API and the database DIRECTLY — never through
 * the UI. Driving sign-up and room creation by clicking costs a page load and a
 * form round trip per test and couples every test to the auth UI.
 */

export const WEB_ORIGIN = process.env.E2E_WEB_ORIGIN ?? "http://localhost:3000";

export interface SeededUser {
  email: string;
  password: string;
  userId: string;
  /** Raw `name=value` cookie pair, ready for context.addCookies(). */
  cookieValue: string;
}

export interface SeededRoom {
  id: string;
  slug: string;
  name: string;
}

const PASSWORD = "e2e-password-12345";

/**
 * Create a user via the web origin's /api proxy — NOT the API port directly.
 * That way the Set-Cookie is attributed to the web origin exactly as it is for a
 * real browser, so the cookie a test injects is the cookie the app would have.
 */
export async function createUser(label = "user"): Promise<SeededUser> {
  const email = `e2e-${label}-${randomUUID()}@test.local`;
  const res = await fetch(`${WEB_ORIGIN}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, name: `E2E ${label}` }),
  });
  if (!res.ok) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const user = (await res.json()) as { id: string };
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("signup returned no Set-Cookie");
  const cookieValue = setCookie.split(";")[0] ?? "";
  return { email, password: PASSWORD, userId: user.id, cookieValue };
}

export interface CreateRoomOptions {
  /**
   * Defaults to PRIVATE, matching production: `POST /rooms` has no visibility
   * field and the column defaults to PRIVATE.
   *
   * Pass `"LINK"` when a test needs a second user in the board but is not
   * testing how they got there — the open-gap timing tests, drawing
   * propagation, resilience, the colour-drag undo test. Those want `joinRoom()`
   * to work without the test having to care about membership at all.
   *
   * Do NOT reach for this in a test that is genuinely about ACCESS. "Can a
   * stranger get in?" must run against a PRIVATE board, or it asserts nothing.
   */
  visibility?: "PRIVATE" | "LINK";
}

export async function createRoom(
  user: SeededUser,
  name = "e2e board",
  opts: CreateRoomOptions = {},
): Promise<SeededRoom> {
  const res = await fetch(`${WEB_ORIGIN}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: user.cookieValue },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`create room failed: ${res.status}`);
  const room = (await res.json()) as SeededRoom;

  // Opening a board up is a separate, deliberate act — visibility is not
  // settable at creation. Done over the real owner-only PATCH rather than by
  // writing the column, so the fixture reaches LINK the same way a user would.
  if (opts.visibility === "LINK") {
    const patch = await fetch(`${WEB_ORIGIN}/api/rooms/${room.slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: user.cookieValue },
      body: JSON.stringify({ visibility: "LINK" }),
    });
    if (!patch.ok) {
      throw new Error(`set visibility=LINK failed: ${patch.status}`);
    }
  }

  return room;
}

/**
 * Add `user` to `room` as EDITOR (idempotent), the same way a share link does.
 *
 * ONLY WORKS ON A `LINK` BOARD. Since private boards landed, `POST
 * /rooms/:slug/join` 403s unless the room opted in, so callers must create the
 * room with `{ visibility: "LINK" }`. A 403 here means the room was left
 * PRIVATE, not that auth broke.
 */
export async function joinRoom(user: SeededUser, slug: string): Promise<void> {
  const res = await fetch(`${WEB_ORIGIN}/api/rooms/${slug}/join`, {
    method: "POST",
    headers: { cookie: user.cookieValue },
  });
  if (!res.ok) {
    throw new Error(
      `join failed: ${res.status}` +
        (res.status === 403
          ? " — is the room LINK? createRoom(..., { visibility: \"LINK\" })"
          : ""),
    );
  }
}

/**
 * Add a member with an explicit role, straight to the database.
 *
 * An HTTP route CAN now grant VIEWER — `POST /invites/:token/accept` redeems an
 * invite at whatever role it was minted for. This helper stays because it is
 * still the cheapest way to put a user in a board at a chosen role: no invite to
 * mint, no token to carry, and the row it writes is exactly the row the API
 * would produce. Use the invite route when the test is about ACQUIRING access;
 * use this when a test merely needs a VIEWER to already exist.
 */
export async function addMember(
  user: SeededUser,
  room: SeededRoom,
  role: "OWNER" | "EDITOR" | "VIEWER",
): Promise<void> {
  await prismaClient.roomMember.upsert({
    where: { roomId_userId: { roomId: room.id, userId: user.userId } },
    create: { roomId: room.id, userId: user.userId, role },
    update: { role },
  });
}

export type SeedShape =
  | { kind: "rect"; x: number; y: number; w?: number; h?: number; stroke?: string }
  | { kind: "pencil"; points: number };

function shapeData(s: SeedShape, i: number): unknown {
  const style = { stroke: s.kind === "rect" ? (s.stroke ?? "#111827") : "#111827", width: 2 };
  if (s.kind === "rect") {
    return { type: "rect", x: s.x, y: s.y, width: s.w ?? 40, height: s.h ?? 30, style };
  }
  return {
    type: "pencil",
    points: Array.from({ length: s.points }, (_, k) => ({ x: k + i, y: k * 1.5 })),
    style,
  };
}

/**
 * Seed elements straight into the database, through the SAME plpgsql function
 * the gateway uses (`sketchsync_insert_element`).
 *
 * Going through the WebSocket instead would be far slower for a large board and
 * would be shaped by the mutation rate limiter, which has nothing to do with
 * what these tests are asserting. Calling the real insert function keeps the
 * per-room advisory-lock zIndex assignment — and therefore every ordering
 * invariant — exactly as production produces it.
 */
export async function seedElements(
  room: SeededRoom,
  owner: SeededUser,
  shapes: SeedShape[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, s] of shapes.entries()) {
    const id = randomUUID();
    const data = shapeData(s, i);
    await prismaClient.$queryRawUnsafe(
      `SELECT * FROM "sketchsync_insert_element"($1::uuid,$2::uuid,$3,$4::jsonb,$5::uuid)`,
      id,
      room.id,
      (data as { type: string }).type,
      JSON.stringify(data),
      owner.userId,
    );
    ids.push(id);
  }
  return ids;
}

/** Seed a board of N small rects, ascending zIndex. */
export function rects(n: number): SeedShape[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: "rect" as const,
    x: (i % 20) * 45,
    y: Math.floor(i / 20) * 35,
  }));
}

/** Delete everything a test created. Room cascades elements + members. */
export async function cleanup(rooms: SeededRoom[], users: SeededUser[]): Promise<void> {
  for (const r of rooms) {
    await prismaClient.room.deleteMany({ where: { id: r.id } }).catch(() => undefined);
  }
  for (const u of users) {
    await prismaClient.user.deleteMany({ where: { id: u.userId } }).catch(() => undefined);
  }
}

export async function disconnect(): Promise<void> {
  await prismaClient.$disconnect();
}
