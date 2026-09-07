import { describe, expect, it } from "vitest";
import {
  CreateInviteInput,
  InviteRole,
  MemberRole,
  RoomVisibility,
  UpdateMemberRoleInput,
  UpdateRoomInput,
} from "@sketchsync/shared";
import { Role } from "@sketchsync/db";
import { refuseIfOwnerTarget } from "./ownerGuard.js";

// The authorization RULES, tested as pure functions. The routes that enforce
// them are thin wrappers: read params, call this, map the result to a status.
// Everything here runs without Express, Prisma or a database.

const room = { ownerId: "owner-1" };

describe("owner guard — a board must keep an owner", () => {
  it("refuses removing yourself", () => {
    expect(refuseIfOwnerTarget(room, "owner-1", "owner-1", "remove")).toMatch(
      /cannot remove yourself/i,
    );
  });

  it("refuses demoting yourself", () => {
    expect(
      refuseIfOwnerTarget(room, "owner-1", "owner-1", "change the role of"),
    ).toMatch(/cannot change the role of yourself/i);
  });

  it("refuses targeting the room's owner even when the caller is someone else", () => {
    // OWNER is a rank, and the schema permits a second OWNER-ranked member.
    // Guarding only "self" would let that member strand the board by demoting
    // the real owner.
    expect(refuseIfOwnerTarget(room, "other-owner", "owner-1", "remove")).toMatch(
      /cannot remove the board's owner/i,
    );
    expect(
      refuseIfOwnerTarget(room, "other-owner", "owner-1", "change the role of"),
    ).not.toBeNull();
  });

  it("allows operating on an ordinary member", () => {
    expect(refuseIfOwnerTarget(room, "owner-1", "member-2", "remove")).toBeNull();
    expect(
      refuseIfOwnerTarget(room, "owner-1", "member-2", "change the role of"),
    ).toBeNull();
  });

  it("is decided by id, not by role — the owner id is what matters", () => {
    // A member who happens to share no id with the owner is always operable,
    // and the owner id is always protected, regardless of anyone's rank.
    expect(refuseIfOwnerTarget({ ownerId: "x" }, "y", "z", "remove")).toBeNull();
    expect(refuseIfOwnerTarget({ ownerId: "z" }, "y", "z", "remove")).not.toBeNull();
  });
});

describe("invite role bounds", () => {
  it("accepts EDITOR and VIEWER", () => {
    expect(InviteRole.safeParse("EDITOR").success).toBe(true);
    expect(InviteRole.safeParse("VIEWER").success).toBe(true);
  });

  it("REFUSES OWNER — invites must not be a second path to ownership", () => {
    // A board has one owner column and no transfer route. Minting OWNER invites
    // would create a multi-owner state the rest of the model does not describe.
    expect(InviteRole.safeParse("OWNER").success).toBe(false);
    expect(CreateInviteInput.safeParse({ role: "OWNER" }).success).toBe(false);
    expect(UpdateMemberRoleInput.safeParse({ role: "OWNER" }).success).toBe(false);
  });

  it("rejects unknown roles", () => {
    expect(InviteRole.safeParse("ADMIN").success).toBe(false);
    expect(InviteRole.safeParse("").success).toBe(false);
  });
});

describe("shared enums match the Prisma enums", () => {
  // These are hand-written Zod copies of the generated Prisma enums, because
  // this package is browser-imported and cannot depend on Prisma. A drift here
  // would let the API accept a value the database rejects.
  it("MemberRole covers exactly the Prisma Role values", () => {
    expect([...MemberRole.options].sort()).toEqual(Object.values(Role).sort());
  });

  it("RoomVisibility covers exactly PRIVATE and LINK", () => {
    expect([...RoomVisibility.options].sort()).toEqual(["LINK", "PRIVATE"]);
  });
});

describe("CreateInviteInput defaults and bounds", () => {
  it("defaults to a single-use EDITOR invite lasting a day", () => {
    const parsed = CreateInviteInput.parse({});
    expect(parsed).toEqual({ role: "EDITOR", expiresInHours: 24, maxUses: 1 });
  });

  it("rejects a non-positive or over-long expiry", () => {
    expect(CreateInviteInput.safeParse({ expiresInHours: 0 }).success).toBe(false);
    expect(CreateInviteInput.safeParse({ expiresInHours: -1 }).success).toBe(false);
    expect(CreateInviteInput.safeParse({ expiresInHours: 24 * 31 }).success).toBe(false);
    expect(CreateInviteInput.safeParse({ expiresInHours: 1.5 }).success).toBe(false);
  });

  it("rejects a non-positive or absurd use count", () => {
    expect(CreateInviteInput.safeParse({ maxUses: 0 }).success).toBe(false);
    expect(CreateInviteInput.safeParse({ maxUses: -3 }).success).toBe(false);
    expect(CreateInviteInput.safeParse({ maxUses: 100_000 }).success).toBe(false);
  });
});

describe("UpdateRoomInput", () => {
  it("accepts a rename alone, a visibility change alone, or both", () => {
    expect(UpdateRoomInput.safeParse({ name: "Board" }).success).toBe(true);
    expect(UpdateRoomInput.safeParse({ visibility: "LINK" }).success).toBe(true);
    expect(
      UpdateRoomInput.safeParse({ name: "Board", visibility: "PRIVATE" }).success,
    ).toBe(true);
  });

  it("REJECTS an empty body rather than silently doing nothing", () => {
    expect(UpdateRoomInput.safeParse({}).success).toBe(false);
  });

  it("still enforces the shared 1..80 name bounds", () => {
    expect(UpdateRoomInput.safeParse({ name: "   " }).success).toBe(false);
    expect(UpdateRoomInput.safeParse({ name: "x".repeat(81) }).success).toBe(false);
    expect(UpdateRoomInput.safeParse({ name: "x".repeat(80) }).success).toBe(true);
  });

  it("rejects an unknown visibility", () => {
    expect(UpdateRoomInput.safeParse({ visibility: "PUBLIC" }).success).toBe(false);
  });
});
