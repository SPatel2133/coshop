import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";
import { configuration, RoomError } from "./server/config.js";
import {
  newToken,
  verifyInvite,
  tokenHash,
  sameOrigin,
  nodeRequestUrl,
} from "./server/security.js";
import { nodeStore, migrate } from "./server/storage.js";
import { Rooms, roomHttp, json } from "./server/rooms.js";
import { Storefront } from "./server/storefront.js";
import { readPaidWebhook } from "./server/order-webhook.js";
import { catalog } from "./catalog.mjs";
import { discussionFor, isDiscussion } from "./server/discussion.js";
import { consume, rateKey } from "./server/abuse.js";
import {
  parseMessage,
  errorMessage,
  stateMessage,
  presenceChanges,
} from "./server/realtime.js";
const root = new URL("./", import.meta.url);
try {
  process.loadEnvFile(fileURLToPath(new URL(".env", root)));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const dataPath = process.env.DATA_DIR
  ? pathToFileURL(resolve(process.env.DATA_DIR) + "/")
  : new URL("data/phase1/", root);
await mkdir(dataPath, { recursive: true });
if (!process.env.INVITE_SIGNING_SECRET) {
  const path = new URL("server-key", dataPath);
  try {
    process.env.INVITE_SIGNING_SECRET = (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const secret = newToken();
    try {
      await writeFile(path, secret, { flag: "wx", mode: 0o600 });
      process.env.INVITE_SIGNING_SECRET = secret;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      process.env.INVITE_SIGNING_SECRET = (await readFile(path, "utf8")).trim();
    }
  }
}
const config = configuration(process.env),
  db = new DatabaseSync(fileURLToPath(new URL("rooms.sqlite", dataPath)));
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
const store = nodeStore(db);
migrate(
  store,
  await readFile(new URL("drizzle/room-object/0001_rooms.sql", root), "utf8"),
);
migrate(
  store,
  await readFile(
    new URL("drizzle/room-object/0002_presence.sql", root),
    "utf8",
  ),
  2,
);
const presenceCache = new Map();
migrate(
  store,
  await readFile(
    new URL("drizzle/room-object/0003_hold_ups.sql", root),
    "utf8",
  ),
  3,
);
migrate(
  store,
  await readFile(
    new URL("drizzle/room-object/0004_shared_finds.sql", root),
    "utf8",
  ),
  4,
);
migrate(
  store,
  await readFile(
    new URL("drizzle/room-object/0005_discussion.sql", root),
    "utf8",
  ),
  5,
);
migrate(
  store,
  await readFile(
    new URL("drizzle/room-object/0006_storefront.sql", root),
    "utf8",
  ),
  6,
);
const storefront = new Storefront(config.shopify);
migrate(
  store,
  await readFile(new URL("drizzle/room-object/0007_haul.sql", root), "utf8"),
  7,
);
const rooms = new Rooms(store, config, Date.now, catalog, storefront, true),
  clients = new Map();
const wsServer = new WebSocketServer({ noServer: true, maxPayload: 2048 });
const clientRoot = new URL("dist/client/", root);
const assetTypes = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
};
function clientAsset(pathname) {
  if (pathname === "/" || pathname === "/index.html")
    return ["index.html", "text/html; charset=utf-8"];
  if (/^\/assets\/catalog-[a-z0-9-]+\.webp$/.test(pathname))
    return [pathname.slice(1), "image/webp"];
  const generated = /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css|woff2)$/.exec(
    pathname,
  );
  return generated && !pathname.includes("..")
    ? [pathname.slice(1), assetTypes["." + generated[1]]]
    : null;
}

function broadcast(id, deltaOnly = false) {
  let message;
  try {
    message = stateMessage(rooms, id);
    const changes = presenceChanges(message.room, presenceCache);
    if (deltaOnly && !changes.membershipChanged) {
      for (const delta of changes.messages)
        for (const [ws, c] of clients)
          if (c.roomId === id && c.person && ws.readyState === 1)
            ws.send(JSON.stringify(delta));
      return;
    }
  } catch (error) {
    presenceCache.delete(id);
    message = errorMessage(error);
  }
  for (const [ws, c] of clients)
    if (c.roomId === id && c.person && ws.readyState === 1) {
      ws.send(JSON.stringify({ ...message, me: c.person }));
      if (message.code === "ROOM_EXPIRED") ws.close(4004, "Room expired");
    }
}
const fail = (error) =>
  json(
    errorMessage(error),
    error.status || 500,
    error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {},
  );
async function limit(ip, kind) {
  consume(store, await rateKey(config, ip, kind));
}
const server = http.createServer(async (req, res) => {
  let roomId, action;
  try {
    const url = nodeRequestUrl(req, config.publicOrigin),
      headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (v) headers.set(k, Array.isArray(v) ? v.join(",") : v);
    const request = new Request(url, {
      method: req.method,
      headers,
      ...(req.method !== "GET" && req.method !== "HEAD"
        ? { body: req, duplex: "half" }
        : {}),
    });
    sameOrigin(request);
    const asset = req.method === "GET" ? clientAsset(url.pathname) : null;
    if (asset) {
      const [path, type] = asset;
      const contents = await readFile(new URL(path, clientRoot)).catch(
        (error) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        },
      );
      if (!contents) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(contents);
      return;
    }
    let response;
    if (url.pathname === "/api/shopify/orders-paid") {
      const order = await readPaidWebhook(request, config);
      if (order && (await rooms.haul.paid(order))) roomId = order.room;
      response = json({ received: true });
    } else if (url.pathname === "/api/rooms" && req.method === "POST") {
      await limit(req.socket.remoteAddress || "unknown", "create");
      roomId = crypto.randomUUID();
      response = await roomHttp(rooms, roomId, "create", request, config);
    } else {
      const match = url.pathname.match(
        /^\/api\/rooms\/([^/]+)(?:\/(join|session|catalog|checkout|checkout-release|haul-demo))?$/,
      );
      if (!match) throw new RoomError("NOT_FOUND", "Page not found.", 404);
      await limit(req.socket.remoteAddress || "unknown", "join");
      roomId = await verifyInvite(config.secret, match[1]);
      action = match[2] || "info";
      response = await roomHttp(rooms, roomId, action, request, config, () =>
        broadcast(roomId),
      );
    }
    if (roomId) broadcast(roomId);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch (error) {
    if (roomId && action === "checkout") broadcast(roomId);
    const response = fail(error);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  }
});
server.on("upgrade", async (req, socket, head) => {
  socket.on("error", () => {});
  try {
    const url = nodeRequestUrl(req, config.publicOrigin),
      match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/socket$/);
    if (!match || url.search)
      throw new RoomError("INVALID_LINK", "Invalid realtime link.", 404);
    if (req.headers.origin !== url.origin)
      throw new RoomError(
        "ORIGIN_DENIED",
        "Open this room on its own website.",
        403,
      );
    await limit(req.socket.remoteAddress || "unknown", "join");
    const roomId = await verifyInvite(config.secret, match[1]);
    rooms.require(roomId);
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      const c = {
        roomId,
        id: crypto.randomUUID(),
        person: null,
        busy: false,
        lastActivity: 0,
        messages: 0,
        window: Date.now(),
      };
      clients.set(ws, c);
      const authDeadline = setTimeout(() => {
        if (!c.person) ws.close(4001, "Authenticate first");
      }, 5000);
      ws.on("error", () => {});
      ws.on("message", async (raw, binary) => {
        try {
          if (binary || c.busy)
            throw new RoomError("INVALID_MESSAGE", "Wait for authentication.");
          if (Date.now() - c.window > 60000) {
            c.window = Date.now();
            c.messages = 0;
          }
          if (++c.messages > 240)
            throw new RoomError(
              "RATE_LIMITED",
              "Too many connection messages.",
              429,
            );
          const message = parseMessage(raw.toString());
          if (!c.person) {
            if (message.type !== "auth")
              throw new RoomError(
                "INVALID_SESSION",
                "Authenticate first.",
                401,
              );
            c.busy = true;
            const hash = await tokenHash(message.token);
            if (ws.readyState !== 1) return;
            c.person = rooms.connect(roomId, hash, c.id).id;
            clearTimeout(authDeadline);
            broadcast(roomId);
          } else if (
            message.type === "heartbeat" ||
            message.type === "activity"
          ) {
            const activity =
              message.type === "activity" &&
              Date.now() - c.lastActivity >= 1000;
            rooms.heartbeat(roomId, c.id, activity);
            if (activity) {
              c.lastActivity = Date.now();
              broadcast(roomId, true);
            } else
              ws.send(JSON.stringify({ type: "pong", serverTime: Date.now() }));
          } else if (message.type === "view") {
            const ack = rooms.publishView(
              roomId,
              c.id,
              message.view,
              message.requestId,
            );
            if (ack.accepted) broadcast(roomId, true);
            ws.send(JSON.stringify(ack));
          } else if (
            message.type === "hold_up" ||
            message.type === "react" ||
            message.type === "bag_change" ||
            isDiscussion(message.type)
          ) {
            const result = rooms.shopCommand(roomId, c.id, message);
            if (result.notification) {
              for (const [peer, member] of clients)
                if (
                  member.roomId === roomId &&
                  member.person &&
                  peer.readyState === 1
                )
                  peer.send(
                    JSON.stringify(
                      discussionFor(result.notification, member.person),
                    ),
                  );
              broadcast(roomId, true);
            }
            ws.send(JSON.stringify(result.ack));
          } else if (message.type === "resync")
            ws.send(JSON.stringify(stateMessage(rooms, roomId, c.person)));
          else
            throw new RoomError("INVALID_MESSAGE", "Unsupported room message.");
        } catch (error) {
          if (ws.readyState === 1) ws.send(JSON.stringify(errorMessage(error)));
          if ([401, 410, 429].includes(error.status))
            ws.close(4001, "Reconnect required");
        } finally {
          c.busy = false;
        }
      });
      ws.on("close", () => {
        clearTimeout(authDeadline);
        clients.delete(ws);
        rooms.disconnect(roomId, c.id);
        broadcast(roomId);
      });
    });
  } catch (error) {
    socket.end(
      `HTTP/1.1 ${error.status || 500} Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
});
const sweep = setInterval(
  () => {
    for (const room of store.all("SELECT id FROM room_records")) {
      let checkoutExpired = false;
      try {
        const result = rooms.sweep(room.id);
        checkoutExpired = result.checkoutExpired;
        for (const [ws, c] of clients)
          if (result.stale.includes(c.id))
            ws.close(4000, "Heartbeat timed out");
      } catch (e) {
        if (e.code !== "ROOM_EXPIRED") console.error("Room cleanup failed");
      }
      broadcast(room.id, !checkoutExpired);
    }
    store.run("DELETE FROM abuse_windows WHERE expires_at<=?", Date.now());
  },
  Math.min(1000, config.heartbeat, config.presenceIdle),
);
sweep.unref();
server.listen(
  Number(process.env.PORT || 4193),
  process.env.HOST || "0.0.0.0",
  () => console.log("coshop: http://localhost:" + server.address().port),
);
function shutdown() {
  clearInterval(sweep);
  for (const [ws, c] of clients) {
    rooms.disconnect(c.roomId, c.id);
    ws.terminate();
  }
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
