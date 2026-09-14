import http from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { RoomService } from "./service.js";
import { validateMessage, validateName, fail } from "./protocol.js";
const MONTH = 30 * 86400000;
const safeErrors = new Set([
  "INVALID_MESSAGE",
  "UNAUTHENTICATED",
  "NOT_A_MEMBER",
  "ROOM_UNAVAILABLE",
  "ROOM_FULL",
  "NOT_HOST",
  "NOT_READY",
  "STALE_STATE",
  "WRONG_MATCH",
  "WRONG_DECISION",
  "NOT_YOUR_DECISION",
  "ILLEGAL_ACTION",
  "INVALID_SELECTION",
  "INVALID_TARGET",
  "DEADLINE_EXPIRED",
  "CONTROL_MOVED",
  "COMMAND_ID_REUSED",
  "MATCH_ENDED",
  "RATE_LIMITED",
]);
function cookieToken(req) {
  const cookies = (req.headers.cookie || "").split(";").map((x) => x.trim());
  return cookies.find((c) => c.startsWith("keep_session="))?.slice(13);
}
function hash(token) {
  return createHash("sha256").update(token).digest("hex");
}
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};
export async function createApplication({
  store,
  clock,
  rng,
  timingOverrides,
  origin = process.env.APP_ORIGIN,
  production = process.env.NODE_ENV === "production",
} = {}) {
  if (!store) throw new Error("A durable store is required");
  const service = new RoomService(store, { clock, rng, timingOverrides });
  await service.init();
  const expectedOrigin = (req) => origin || `http://${req.headers.host}`;
  const validOrigin = (req) => req.headers.origin === expectedOrigin(req);
  const sessionFor = (req) => {
    const token = cookieToken(req);
    if (!token || !/^[-_A-Za-z0-9]{43}$/.test(token)) return null;
    const verifier = hash(token);
    return (
      Object.values(service.data.sessions).find(
        (s) => s.tokenHash === verifier && s.expiresAt > service.now(),
      ) || null
    );
  };
  const json = (res, status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (production)
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    try {
      const url = new URL(req.url, expectedOrigin(req));
      if (production && origin && req.headers["x-forwarded-proto"] === "http") {
        res.writeHead(308, { Location: origin + url.pathname + url.search });
        return res.end();
      }
      if (url.pathname === "/healthz") {
        if (store.healthy === false)
          return json(res, 503, { status: "unavailable" });
        return json(res, 200, {
          status: "ok",
          game: "Keep",
          protocolVersion: 1,
        });
      }
      if (url.pathname === "/api/session") {
        if (!["GET", "POST"].includes(req.method))
          return json(res, 405, { error: "Method not allowed" });
        if (
          (req.headers.origin && !validOrigin(req)) ||
          (req.method === "POST" && !validOrigin(req)) ||
          req.headers["sec-fetch-site"] === "cross-site"
        )
          return json(res, 403, { error: "Origin not allowed" });
        let displayName;
        if (req.method === "POST") {
          let raw = "";
          for await (const chunk of req) {
            raw += chunk;
            if (raw.length > 2048)
              return json(res, 413, { error: "Request too large" });
          }
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            fail("INVALID_MESSAGE", "Invalid name request.");
          }
          if (
            !parsed ||
            Object.keys(parsed).length !== 1 ||
            !Object.hasOwn(parsed, "displayName")
          )
            fail("INVALID_MESSAGE", "Invalid name request.");
          displayName = validateName(parsed.displayName, 24);
        }
        const identity = await service.queue(async () => {
          let session = sessionFor(req),
            token = cookieToken(req);
          const now = service.now();
          if (
            !session &&
            !service.rates.allow("bootstrap:" + clientIp(req), now, 0.5, 30)
          )
            fail("RATE_LIMITED", "Too many sessions. Please wait a minute.");
          const next = structuredClone(service.data);
          if (!session) {
            token = randomBytes(32).toString("base64url");
            session = {
              playerId: randomUUID(),
              displayName: displayName || "Wandering dragon",
              tokenHash: hash(token),
              expiresAt: now + MONTH,
              roomId: null,
            };
            next.sessions[session.playerId] = session;
          } else {
            session = next.sessions[session.playerId];
            session.expiresAt = now + MONTH;
            if (displayName) {
              session.displayName = displayName;
              const room = service.currentRoom(session.playerId, next);
              if (room) {
                const seat = room.seats.find(
                  (s) => s.playerId === session.playerId,
                );
                seat.displayName = displayName;
                service.mark(room);
              }
            }
          }
          await service.commit(next);
          if (session.roomId) service.publish(session.roomId);
          res.setHeader(
            "Set-Cookie",
            `keep_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${production ? "; Secure" : ""}`,
          );
          return {
            playerId: session.playerId,
            displayName: session.displayName,
            roomId: session.roomId,
          };
        });
        return json(res, 200, identity);
      }
      if (!["GET", "HEAD"].includes(req.method))
        return json(res, 405, { error: "Method not allowed" });
      if (url.pathname === "/") {
        res.writeHead(302, { Location: "/dist/keep/index.html" });
        return res.end();
      }
      if (!url.pathname.startsWith("/dist/keep/"))
        return json(res, 404, { error: "Not found" });
      const root = path.resolve("public/dist/keep"),
        file = path.resolve(
          root,
          decodeURIComponent(url.pathname.slice("/dist/keep/".length)),
        );
      if (!file.startsWith(root + path.sep))
        return json(res, 404, { error: "Not found" });
      const info = await stat(file);
      if (!info.isFile()) return json(res, 404, { error: "Not found" });
      res.writeHead(200, {
        "Content-Type": mime[path.extname(file)] || "application/octet-stream",
        "Cache-Control": file.endsWith(".html")
          ? "no-cache"
          : "public, max-age=3600",
        "Content-Length": info.size,
      });
      res.end(req.method === "HEAD" ? undefined : await readFile(file));
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR")
        return json(res, 404, { error: "Not found" });
      json(
        res,
        error.code === "INVALID_MESSAGE"
          ? 400
          : error.code === "RATE_LIMITED"
            ? 429
            : 503,
        {
          error: safeErrors.has(error.code)
            ? error.message
            : "The game is temporarily unavailable.",
        },
      );
    }
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16384,
    perMessageDeflate: false,
  });
  const safeSend = (ws, message) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 65536) {
      ws.close(1013, "Connection too slow; reconnect");
      return;
    }
    ws.send(JSON.stringify(message));
  };
  const sendSnapshot = (playerId, ws) => {
    if (service.connections.get(playerId) !== ws || ws.moved) return;
    const room = service.currentRoom(playerId);
    if (room?.seats.find((s) => s.playerId === playerId)?.unsubscribed) return;
    const view = service.snapshot(playerId);
    if (view) {
      ws.roomId = view.roomId;
      safeSend(ws, { kind: "snapshot", view });
    }
  };
  service.publish = (roomId) => {
    for (const [playerId, ws] of service.connections) {
      if (service.data.sessions[playerId]?.roomId === roomId)
        sendSnapshot(playerId, ws);
      else if (ws.roomId === roomId && !service.data.rooms[roomId]) {
        ws.roomId = null;
        safeSend(ws, { kind: "room_closed", roomId });
      }
    }
  };
  server.on("upgrade", (req, socket, head) => {
    const reject = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    try {
      const url = new URL(req.url, expectedOrigin(req));
      if (
        url.pathname !== "/ws" ||
        url.searchParams.get("protocolVersion") !== "1"
      )
        return reject(400, "Update required");
      if (!validOrigin(req)) return reject(403, "Forbidden");
      const session = sessionFor(req);
      if (!session) return reject(401, "Unauthorized");
      if (
        !service.rates.allow(
          "upgrade:" + session.playerId,
          service.now(),
          2,
          10,
        )
      )
        return reject(429, "Too Many Requests");
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req, session.playerId),
      );
    } catch {
      reject(400, "Bad Request");
    }
  });
  wss.on("connection", (ws, req, playerId) => {
    const old = service.connections.get(playerId);
    if (old) {
      old.moved = true;
      safeSend(old, {
        kind: "control_moved",
        code: "CONTROL_MOVED",
        message: "Control moved to another tab.",
      });
      old.close(4001, "Control moved");
    }
    service.connections.set(playerId, ws);
    ws.lastPong = service.now();
    ws.on("pong", () => {
      ws.lastPong = service.now();
    });
    ws.on("error", () => {});
    const ready = service
      .connected(playerId, ws)
      .then(() => {
        const session = service.data.sessions[playerId];
        safeSend(ws, {
          kind: "hello",
          protocolVersion: 1,
          playerId,
          displayName: session.displayName,
          roomId: session.roomId,
          serverTime: service.now(),
        });
        sendSnapshot(playerId, ws);
      })
      .catch(() => {
        ws.close(1013, "Game temporarily unavailable");
      });
    ws.on("message", async (raw, binary) => {
      let message;
      try {
        await ready;
        service.assertControl(playerId, ws);
        if (service.data.sessions[playerId]?.expiresAt <= service.now())
          fail("UNAUTHENTICATED", "Your guest session expired. Please reload.");
        if (binary) fail("INVALID_MESSAGE", "Only JSON messages are accepted.");
        try {
          message = JSON.parse(raw.toString());
        } catch {
          fail("INVALID_MESSAGE", "Invalid JSON message.");
        }
        if (!service.rates.allow("command:" + playerId, service.now()))
          fail("RATE_LIMITED", "Too many commands. Please slow down.");
        validateMessage(message);
        if (message.kind === "read") {
          if (message.type === "LIST_PUBLIC_ROOMS")
            safeSend(ws, { kind: "public_rooms", rooms: service.listRooms() });
          else {
            const room = service.currentRoom(playerId);
            if (
              !room ||
              (message.roomId && message.roomId !== room.roomId) ||
              room.seats.find((s) => s.playerId === playerId).unsubscribed
            )
              fail("NOT_A_MEMBER", "You are not a member of that room.");
            sendSnapshot(playerId, ws);
          }
          return;
        }
        const ack = await service.command(playerId, ws, message, clientIp(req));
        safeSend(ws, ack);
        sendSnapshot(playerId, ws);
      } catch (error) {
        const safe = safeErrors.has(error.code);
        const incidentId = safe ? undefined : randomUUID();
        if (incidentId)
          console.error(
            JSON.stringify({
              event: "command_failed",
              incidentId,
              type:
                typeof message?.type === "string" ? message.type : "unknown",
            }),
          );
        safeSend(ws, {
          kind: "error",
          commandId:
            typeof message?.commandId === "string"
              ? message.commandId
              : undefined,
          code: safe ? error.code : "PERSISTENCE_UNAVAILABLE",
          message: safe
            ? error.message
            : "The game could not save this action. Please reconnect.",
          ...(incidentId ? { incidentId } : {}),
        });
        if (message && error.code !== "NOT_A_MEMBER")
          sendSnapshot(playerId, ws);
      }
    });
    ws.on("close", () => {
      if (!service.closed) service.disconnected(playerId, ws).catch(() => {});
    });
  });
  const ticker = setInterval(() => service.tick().catch(() => {}), 250);
  ticker.unref();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (service.now() - ws.lastPong >= 45000) ws.terminate();
      else if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, service.timings.heartbeat);
  heartbeat.unref();
  async function close() {
    service.closed = true;
    clearInterval(ticker);
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    await service.tail;
    await new Promise((resolve) => wss.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await store.close();
  }
  return { server, service, close };
}
function clientIp(req) {
  return process.env.NODE_ENV === "production"
    ? (req.headers["x-forwarded-for"] || "")
        .split(",")
        .map((s) => s.trim())
        .at(-1) || req.socket.remoteAddress
    : req.socket.remoteAddress;
}
