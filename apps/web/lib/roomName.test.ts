import { describe, expect, it } from "vitest";
import { RoomName, ROOM_NAME_MAX, ROOM_NAME_MIN } from "@sketchsync/shared";

// Shared by create AND rename, so client and server cannot disagree.
describe("RoomName bounds", () => {
  it("accepts an ordinary name", () => {
    expect(RoomName.parse("Sprint planning")).toBe("Sprint planning");
  });

  it("trims before validating", () => {
    expect(RoomName.parse("  Retro  ")).toBe("Retro");
  });

  it("rejects empty and whitespace-only", () => {
    expect(RoomName.safeParse("").success).toBe(false);
    expect(RoomName.safeParse("   ").success).toBe(false);
  });

  it(`accepts exactly ${ROOM_NAME_MAX} characters and rejects one more`, () => {
    expect(RoomName.safeParse("x".repeat(ROOM_NAME_MAX)).success).toBe(true);
    expect(RoomName.safeParse("x".repeat(ROOM_NAME_MAX + 1)).success).toBe(false);
  });

  it(`accepts the minimum of ${ROOM_NAME_MIN}`, () => {
    expect(RoomName.safeParse("x").success).toBe(true);
  });

  it("counts length AFTER trimming", () => {
    expect(RoomName.safeParse(`  ${"x".repeat(ROOM_NAME_MAX)}  `).success).toBe(true);
  });
});
