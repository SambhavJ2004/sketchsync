import { env } from "./env.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WS_TICKET_PROTOCOL } from "@sketchsync/shared";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { authenticateUpgrade } from "./auth.js";
import { RoomRegistry, type Conn } from "./registry.js";
import { handleLeave, handleMessage } from "./messages.js";
import { createRateLimitState } from "./rateLimit.js";

/**
 * Hard frame-size ceiling. `ws` enforces this itself: an oversized frame is
 * rejected during protocol decoding, BEFORE our "message" handler ever runs, and
 * the socket is closed with 1009 (message too big). Nothing reaches JSON.parse.
 */
const MAX_PAYLOAD_BYTES = 1024 * 1024; // 1 MiB

const registry = new RoomRegistry();

/**
 * Every live socket. Each Conn owns its limiter state, so this set IS the count
 * of live limiter states — it must return to 0 once all sockets close.
 */
const connections = new Set<Conn>();

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, connections: connections.size }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: "Not found" }));
});

/**
 * `noServer` so WE own the upgrade. Auth must complete DURING the handshake so a
 * refusal is an HTTP status the client (and any proxy or log) can see — the old
 * shape accepted the socket with 101 and then closed 1008, which cannot express
 * "your ticket expired, get another" versus "you are signed out, stop trying".
 */
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_PAYLOAD_BYTES,
  // Echo back ONLY the marker. Never reflect the ticket itself into a response
  // header, where it could be logged.
  handleProtocols: () => WS_TICKET_PROTOCOL,
});

function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n" +
      "\r\n",
  );
  socket.destroy();
}

httpServer.on("upgrade", (req, socket, head) => {
  void (async () => {
    try {
      const result = await authenticateUpgrade(req);
      if ("rejected" in result) {
        // 403 for a disallowed Origin (the request is not ours to serve);
        // 401 for a missing/expired/already-redeemed ticket (retry with a new
        // one). The distinction is what lets a client act correctly.
        if (result.rejected === "origin") {
          console.warn(`upgrade refused: origin=${req.headers.origin ?? "-"}`);
          refuseUpgrade(socket, 403, "Forbidden");
        } else {
          refuseUpgrade(socket, 401, "Unauthorized");
        }
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, result.userId);
      });
    } catch (err) {
      console.error(
        "upgrade error:",
        err instanceof Error ? err.message : err,
      );
      refuseUpgrade(socket, 500, "Internal Server Error");
    }
  })();
});

function toText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

// `userId` is supplied by the upgrade handler above — by the time a connection
// exists it is already authenticated, so there is no post-handshake auth check.
wss.on("connection", (ws: WebSocket, _req: IncomingMessage, userId: string) => {
  const conn: Conn = {
    ws,
    userId,
    name: "",
    avatarUrl: null,
    roomId: null,
    role: null,
    rate: createRateLimitState(Date.now()),
    parseErrorSent: false,
  };
  connections.add(conn);

  const release = (): void => {
    connections.delete(conn); // drops the limiter state with the connection
    handleLeave(conn, registry);
  };

  ws.on("message", (data: RawData) => {
    void handleMessage(conn, registry, toText(data));
  });
  ws.on("close", release);
  ws.on("error", release);
});

httpServer.listen(env.REALTIME_PORT, () => {
  console.log(`realtime up on ws://localhost:${env.REALTIME_PORT}`);
});
