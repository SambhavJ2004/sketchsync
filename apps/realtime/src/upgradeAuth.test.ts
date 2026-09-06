import { describe, expect, it } from "vitest";
import { WS_TICKET_PROTOCOL } from "@sketchsync/shared";
import { extractTicket, hashTicket, isAllowedOrigin } from "./auth.js";

// The Origin allowlist and the subprotocol parser are the two pure pieces of
// upgrade auth. Redemption itself needs the database and is covered by the
// integration script.

describe("Origin allowlist", () => {
  it("accepts exactly the configured web origin", () => {
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
  });

  it("rejects any other origin", () => {
    expect(isAllowedOrigin("http://evil.example.com")).toBe(false);
    expect(isAllowedOrigin("https://localhost:3000")).toBe(false); // scheme
    expect(isAllowedOrigin("http://localhost:3001")).toBe(false); // port
    expect(isAllowedOrigin("http://localhost:3000/")).toBe(false); // trailing slash
    expect(isAllowedOrigin("null")).toBe(false); // sandboxed iframe
  });

  it("allows a request with NO Origin (non-browser client)", () => {
    // Browsers always send Origin on a WS upgrade, so this covers the whole
    // browser attack surface. A non-browser client could spoof any value, so
    // rejecting the absent case would add no security.
    expect(isAllowedOrigin(undefined)).toBe(true);
  });
});

// WEB_ORIGIN may list several origins (comma-separated, parsed in
// @sketchsync/config) so one deployment can serve a custom domain alongside a
// preview domain. The matching rule does NOT relax to accommodate that: every
// entry is still compared with `===`.
describe("Origin allowlist — multiple configured origins", () => {
  const list = ["https://sketchsync.app", "https://preview.sketchsync.app"];

  it("accepts every entry in the list", () => {
    expect(isAllowedOrigin("https://sketchsync.app", list)).toBe(true);
    expect(isAllowedOrigin("https://preview.sketchsync.app", list)).toBe(true);
  });

  it("STILL REFUSES an origin that is not in the list", () => {
    // The regression that matters: adding a second entry must not turn the
    // check into "any origin passes".
    expect(isAllowedOrigin("https://evil.example", list)).toBe(false);
    expect(isAllowedOrigin("http://localhost:3000", list)).toBe(false);
  });

  it("does not degrade to prefix, suffix, or substring matching", () => {
    // Each of these would pass under a looser rule and is a real hijack path.
    expect(isAllowedOrigin("https://sketchsync.app.evil.test", list)).toBe(false);
    expect(isAllowedOrigin("https://evil-sketchsync.app", list)).toBe(false);
    expect(isAllowedOrigin("https://sketchsync.app.", list)).toBe(false);
    expect(isAllowedOrigin("https://sub.sketchsync.app", list)).toBe(false);
    expect(isAllowedOrigin("sketchsync.app", list)).toBe(false);
  });

  it("keeps per-entry exactness: scheme, port and trailing slash still matter", () => {
    expect(isAllowedOrigin("http://sketchsync.app", list)).toBe(false); // scheme
    expect(isAllowedOrigin("https://sketchsync.app:443", list)).toBe(false); // port
    expect(isAllowedOrigin("https://sketchsync.app/", list)).toBe(false); // slash
  });

  it("a single-entry list behaves exactly as one configured origin", () => {
    const one = ["https://sketchsync.app"];
    expect(isAllowedOrigin("https://sketchsync.app", one)).toBe(true);
    expect(isAllowedOrigin("https://preview.sketchsync.app", one)).toBe(false);
  });

  it("still allows an absent Origin regardless of list length", () => {
    expect(isAllowedOrigin(undefined, list)).toBe(true);
  });

  it("refuses everything when the list is empty", () => {
    // Not reachable through config (the schema rejects an empty list), but the
    // function must not fail open if it ever were.
    expect(isAllowedOrigin("https://sketchsync.app", [])).toBe(false);
  });
});

describe("ticket extraction from Sec-WebSocket-Protocol", () => {
  it("reads the ticket when the marker leads", () => {
    expect(extractTicket(`${WS_TICKET_PROTOCOL}, abc123`)).toBe("abc123");
    expect(extractTicket(`${WS_TICKET_PROTOCOL},abc123`)).toBe("abc123");
  });

  it("rejects a missing or malformed header", () => {
    expect(extractTicket(undefined)).toBeNull();
    expect(extractTicket("")).toBeNull();
    expect(extractTicket(WS_TICKET_PROTOCOL)).toBeNull(); // marker only
    expect(extractTicket("abc123")).toBeNull(); // ticket only
    expect(extractTicket(`${WS_TICKET_PROTOCOL}, a, b`)).toBeNull(); // extra
  });

  it("rejects a wrong or spoofed marker", () => {
    expect(extractTicket("some.other.proto, abc123")).toBeNull();
    expect(extractTicket(`abc123, ${WS_TICKET_PROTOCOL}`)).toBeNull(); // order
  });

  it("accepts base64url ticket values (valid RFC 6455 tokens)", () => {
    const t = "Ab9-_zZ0123456789abcdefghijklmnopqrstuvwxyzABCDEF";
    expect(extractTicket(`${WS_TICKET_PROTOCOL}, ${t}`)).toBe(t);
  });
});

describe("ticket hashing", () => {
  it("is stable and 64 hex chars (sha256)", () => {
    const h = hashTicket("abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashTicket("abc")).toBe(h);
  });

  it("differs for different tickets", () => {
    expect(hashTicket("abc")).not.toBe(hashTicket("abd"));
  });

  it("never returns the raw value — the DB stores only the hash", () => {
    expect(hashTicket("abc")).not.toContain("abc");
  });
});
