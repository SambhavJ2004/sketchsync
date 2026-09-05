import { expect, test } from "@playwright/test";
import { WS_TICKET_PROTOCOL } from "@sketchsync/shared";
import {
  cleanup,
  createRoom,
  createUser,
  type SeededRoom,
  type SeededUser,
} from "../fixtures/seed.js";
import { contextFor, boardUrl, waitForSocket, waitForCanvas } from "../fixtures/board.js";

/** Ticket transport + cookie scoping. One board load covers both. */

let owner: SeededUser;
let room: SeededRoom;

test.beforeAll(async () => {
  owner = await createUser("transport");
  room = await createRoom(owner, "transport board");
});
test.afterAll(async () => {
  await cleanup([room], [owner]);
});

test("ticket rides in Sec-WebSocket-Protocol, never a query string", async ({ browser }) => {
  const ctx = await contextFor(browser, owner);
  const page = await ctx.newPage();

  const upgrades: { url: string; requested: string | undefined; selected: string | undefined }[] = [];
  page.on("websocket", (ws) => {
    upgrades.push({ url: ws.url(), requested: undefined, selected: undefined });
  });
  // The request headers are only visible via CDP.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  const seen: { req?: string; res?: string; url?: string } = {};
  cdp.on("Network.webSocketWillSendHandshakeRequest", (e) => {
    seen.req = (e.request.headers as Record<string, string>)["Sec-WebSocket-Protocol"];
  });
  cdp.on("Network.webSocketHandshakeResponseReceived", (e) => {
    const h = e.response.headers as Record<string, string>;
    seen.res = h["sec-websocket-protocol"] ?? h["Sec-WebSocket-Protocol"];
  });
  cdp.on("Network.webSocketCreated", (e) => {
    seen.url = e.url;
  });

  await page.goto(boardUrl(room.slug));
  await waitForCanvas(page);
  await waitForSocket(page);

  expect(seen.url, "socket URL must exist").toBeTruthy();
  expect(seen.url, "credential must NOT be in the query string").not.toContain("?");
  expect(seen.req, "request must offer the marker + ticket").toContain(WS_TICKET_PROTOCOL);
  const offered = (seen.req ?? "").split(",").map((s) => s.trim());
  expect(offered.length, "marker and ticket").toBe(2);
  expect(seen.res, "response selects ONLY the marker").toBe(WS_TICKET_PROTOCOL);
  expect(seen.res, "response must not echo the ticket").not.toBe(offered[1]);
  console.log(`[transport] url=${seen.url} selected=${seen.res}`);
  await ctx.close();
});

test("auth cookie is on the web origin with Path=/, and nothing hits the API port", async ({
  browser,
}) => {
  const ctx = await contextFor(browser, owner);
  const page = await ctx.newPage();
  const direct: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes(":3001")) direct.push(u);
  });

  await page.goto(boardUrl(room.slug));
  await waitForCanvas(page);
  await waitForSocket(page);

  // Re-authenticate FROM THE PAGE so the browser stores a real Set-Cookie.
  // Asserting attributes on the fixture-injected cookie would only test the
  // fixture — addCookies() sets whatever we tell it to.
  const status = await page.evaluate(
    async ([email, password]) => {
      const r = await fetch("/api/auth/signin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
        credentials: "include",
      });
      return r.status;
    },
    [owner.email, owner.password],
  );
  expect(status, "in-page signin must succeed").toBe(200);

  const cookies = await ctx.cookies();
  const auth = cookies.find((c) => c.name === "sketchsync_token");
  expect(auth, "cookie must exist").toBeTruthy();
  expect(auth?.domain).toBe("localhost");
  expect(auth?.path, "Path must be / — a narrowed /api path is the subtle failure").toBe("/");
  expect(auth?.httpOnly, "browser-stored cookie must be httpOnly").toBe(true);
  expect(direct, `browser must never call the API origin directly: ${direct.join(", ")}`).toEqual([]);
  console.log(`[cookie] domain=${auth?.domain} path=${auth?.path} httpOnly=${auth?.httpOnly}`);
  await ctx.close();
});
