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
