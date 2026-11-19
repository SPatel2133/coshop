import { DurableObject } from "cloudflare:workers";
import schema from "./drizzle/room-object/0001_rooms.sql";
import presenceSchema from "./drizzle/room-object/0002_presence.sql";
import holdUpSchema from "./drizzle/room-object/0003_hold_ups.sql";
import findsSchema from "./drizzle/room-object/0004_shared_finds.sql";
import discussionSchema from "./drizzle/room-object/0005_discussion.sql";
import storefrontSchema from "./drizzle/room-object/0006_storefront.sql";
import haulSchema from "./drizzle/room-object/0007_haul.sql";
import checkoutResumeSchema from "./drizzle/room-object/0008_checkout_resume.sql";
import { configuration, RoomError } from "./server/config.js";
import { verifyInvite, tokenHash, sameOrigin } from "./server/security.js";
import { objectStore, migrate } from "./server/storage.js";
import { Rooms, roomHttp, json } from "./server/rooms.js";
import { Storefront } from "./server/storefront.js";
import { logWebhook, readPaidWebhook } from "./server/order-webhook.js";
import { catalog } from "./catalog.mjs";
import { discussionFor, isDiscussion } from "./server/discussion.js";
import { rateKey, consume } from "./server/abuse.js";
import {
  errorMessage,
  parseMessage,
  stateMessage,
  presenceChanges,
} from "./server/realtime.js";
const failure = (error) =>
  json(
    errorMessage(error),
    error.status || 500,
    error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {},
  );
export class RoomObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.config = configuration(env);
    this.store = objectStore(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      migrate(this.store, schema);
      migrate(this.store, presenceSchema, 2);
      migrate(this.store, holdUpSchema, 3);
      migrate(this.store, findsSchema, 4);
      migrate(this.store, discussionSchema, 5);
      migrate(this.store, storefrontSchema, 6);
      migrate(this.store, haulSchema, 7);
      migrate(this.store, checkoutResumeSchema, 8);
    });
    this.rooms = new Rooms(
      this.store,
      this.config,
      Date.now,
      catalog,
      new Storefront(this.config.shopify),
      true,
    );
    this.presenceCache = new Map();
  }
  id() {
    return this.erased
      ? undefined
      : this.store.all("SELECT id FROM room_records")[0]?.id;
  }
  async schedule(id) {
    const deadlines = [this.rooms.nextAlarm(id)];
    for (const ws of this.ctx.getWebSockets()) {
      const c = ws.deserializeAttachment();
      if (!c?.person) deadlines.push(c.created + 5000);
    }
    const deadline = Math.min(...deadlines.filter(Boolean));
    if (Number.isFinite(deadline))
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, deadline));
  }
  broadcast(id, deltaOnly = false) {
    const room = this.rooms.snapshot(id);
    const changes = presenceChanges(room, this.presenceCache);
    for (const ws of this.ctx.getWebSockets()) {
      const c = ws.deserializeAttachment();
      if (!c?.person || ws.readyState !== 1) continue;
      try {
        if (deltaOnly && !changes.membershipChanged) {
          for (const delta of changes.messages) ws.send(JSON.stringify(delta));
        } else ws.send(JSON.stringify({ type: "state", room, me: c.person }));
      } catch (error) {
        ws.send(JSON.stringify(errorMessage(error)));
        ws.close(4004, "Room expired");
      }
    }
  }
  async erase() {
    this.erased = true;
    this.presenceCache.clear();
    for (const ws of this.ctx.getWebSockets())
      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            type: "error",
            code: "ROOM_EXPIRED",
            message: "This room has expired. Start a fresh one together.",
          }),
        );
        ws.close(4004, "Room expired");
      }
    await this.ctx.storage.deleteAll();
  }
  async fetch(request) {
    if (this.erased)
      return failure(
        new RoomError(
          "ROOM_EXPIRED",
          "This room has expired. Start a fresh one together.",
          410,
        ),
      );
    const url = new URL(request.url),
      id = request.headers.get("x-room-id");
    try {
      if (!id) throw new RoomError("INVALID_LINK", "Invalid invite.", 404);
      if (url.pathname === "/internal/paid") {
        const order = await request.json();
        if (order.room !== id)
          return json({ received: true, outcome: "unknown_attempt" });
        const outcome = await this.rooms.haul.paid(order);
        if (outcome === "room_expired") await this.erase();
        if (outcome === "recorded") {
          this.broadcast(id);
          await this.schedule(id);
        }
        return json({ received: true, outcome });
      }
      if (url.pathname === "/socket") {
        this.rooms.require(id);
        const [client, server] = Object.values(new WebSocketPair());
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({
          id: crypto.randomUUID(),
          roomId: id,
          person: null,
          created: Date.now(),
          messages: 0,
          window: Date.now(),
          lastActivity: 0,
        });
        await this.schedule(id);
        return new Response(null, { status: 101, webSocket: client });
      }
      const response = await roomHttp(
        this.rooms,
        id,
        url.pathname.slice(1),
        request,
        this.config,
        async () => {
          this.broadcast(id);
          await this.schedule(id);
        },
      );
      this.broadcast(id);
      await this.schedule(id);
      return response;
    } catch (error) {
      if (error.code === "ROOM_EXPIRED" || !this.id()) await this.erase();
      else if (url.pathname === "/checkout") {
        this.broadcast(id);
        await this.schedule(id);
      }
      return failure(error);
    }
  }
  async webSocketMessage(ws, raw) {
    if (this.erased) {
      ws.close(4004, "Room expired");
      return;
    }
    const c = ws.deserializeAttachment();
    try {
      if (!c)
        throw new RoomError(
          "INVALID_SESSION",
          "Reconnect to restore your session.",
          401,
        );
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
      ws.serializeAttachment(c);
      const message = parseMessage(raw);
      if (!c.person) {
        if (message.type !== "auth" || c.authenticating)
          throw new RoomError("INVALID_SESSION", "Authenticate first.", 401);
        c.authenticating = true;
        ws.serializeAttachment(c);
        const hash = await tokenHash(message.token);
        if (ws.readyState !== 1) return;
        c.person = this.rooms.connect(c.roomId, hash, c.id).id;
        delete c.authenticating;
        ws.serializeAttachment(c);
        this.broadcast(c.roomId);
      } else if (message.type === "heartbeat" || message.type === "activity") {
        const activity =
          message.type === "activity" && Date.now() - c.lastActivity >= 1000;
        this.rooms.heartbeat(c.roomId, c.id, activity);
        if (activity) {
          c.lastActivity = Date.now();
          this.broadcast(c.roomId, true);
        } else
          ws.send(JSON.stringify({ type: "pong", serverTime: Date.now() }));
        ws.serializeAttachment(c);
      } else if (message.type === "view") {
        const ack = this.rooms.publishView(
          c.roomId,
          c.id,
          message.view,
          message.requestId,
        );
        if (ack.accepted) this.broadcast(c.roomId, true);
        ws.send(JSON.stringify(ack));
        ws.serializeAttachment(c);
      } else if (
        message.type === "hold_up" ||
        message.type === "react" ||
        message.type === "bag_change" ||
        isDiscussion(message.type)
      ) {
        const result = this.rooms.shopCommand(c.roomId, c.id, message);
        if (result.notification) {
          for (const peer of this.ctx.getWebSockets()) {
            const person = peer.deserializeAttachment()?.person;
            if (person && peer.readyState === 1)
              peer.send(
                JSON.stringify(discussionFor(result.notification, person)),
              );
          }
          this.broadcast(c.roomId, true);
        }
        ws.send(JSON.stringify(result.ack));
      } else if (message.type === "resync")
        ws.send(JSON.stringify(stateMessage(this.rooms, c.roomId, c.person)));
      else throw new RoomError("INVALID_MESSAGE", "Unsupported room message.");
      await this.schedule(c.roomId);
    } catch (error) {
      if (error.code === "ROOM_EXPIRED") {
        await this.erase();
        return;
      }
      if (ws.readyState === 1) ws.send(JSON.stringify(errorMessage(error)));
      if ([401, 429].includes(error.status))
        ws.close(4001, "Reconnect required");
    }
  }
  async webSocketClose(ws) {
    if (this.erased) return;
    const c = ws.deserializeAttachment();
    if (!c?.person) return;
    try {
      this.rooms.disconnect(c.roomId, c.id);
      this.broadcast(c.roomId);
      await this.schedule(c.roomId);
    } catch (error) {
      if (error.code === "ROOM_EXPIRED") await this.erase();
      else throw error;
    }
  }
  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
  async alarm() {
    if (this.erased) return;
    const id = this.id();
    if (!id) {
      await this.erase();
      return;
    }
    try {
      const { stale, checkoutExpired } = this.rooms.sweep(id);
      for (const ws of this.ctx.getWebSockets()) {
        const c = ws.deserializeAttachment();
        if (
          (!c?.person && Date.now() - c.created >= 5000) ||
          stale.includes(c.id)
        )
          ws.close(4000, "Connection timed out");
      }
      this.broadcast(id, !checkoutExpired);
      await this.schedule(id);
    } catch (error) {
      if (error.code === "ROOM_EXPIRED") await this.erase();
      else throw error;
    }
  }
}
export class AbuseObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = objectStore(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      this.store.run(
        "CREATE TABLE IF NOT EXISTS abuse_windows(id TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL)",
      );
    });
  }
  async fetch(request) {
    try {
      const bucket = await request.json();
      consume(this.store, bucket);
      await this.ctx.storage.setAlarm(bucket.expires);
      return json({ ok: true });
    } catch (error) {
      return failure(error);
    }
  }
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
function roomCors(response, origin) {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.append("Vary", "Origin");
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(response.body, { status: response.status, headers });
}

function allowFrontend(origin, setting) {
  if (!origin || !setting?.split(",").map((entry) => entry.trim()).includes(origin) || !URL.canParse(origin)) return false;
  const url = new URL(origin);
  return url.origin === origin && (
    url.protocol === "https:" ||
    (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  );
}

export default {
  async fetch(request, env) {
    let corsOrigin;
    let roomRoute = false;
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/")) {
        const response = await env.ASSETS.fetch(request),
          headers = new Headers(response.headers);
        headers.set("Referrer-Policy", "no-referrer");
        headers.set("X-Content-Type-Options", "nosniff");
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      }
      if (url.pathname === "/api/shopify/orders-paid") {
        sameOrigin(request);
        const config = configuration(env);
        const { order, outcome } = await readPaidWebhook(request, config);
        if (!order) {
          logWebhook(request, outcome);
          return json({ received: true, outcome });
        }
        const response = await env.ROOMS.get(
          env.ROOMS.idFromName(order.room),
        ).fetch(
          new Request("https://internal/internal/paid", {
            method: "POST",
            headers: { "x-room-id": order.room },
            body: JSON.stringify(order),
          }),
        );
        if (response.status === 410) {
          logWebhook(request, "room_expired");
          return json({ received: true, outcome: "room_expired" });
        }
        if (response.ok) logWebhook(request, (await response.clone().json()).outcome);
        return response;
      }
      const roomPath = url.pathname === "/api/rooms";
      const match = url.pathname.match(
        /^\/api\/rooms\/([^/]+)(?:\/(join|session|socket|catalog|checkout|checkout-release|haul-demo))?$/,
      );
      if (!roomPath && !match)
        throw new RoomError("NOT_FOUND", "Page not found.", 404);
      roomRoute = true;
      const origin = request.headers.get("origin");
      if (allowFrontend(origin, env.ROOM_FRONTEND_ORIGIN)) corsOrigin = origin;
      else sameOrigin(request);
      if (request.method === "OPTIONS") {
        const method = request.headers.get("access-control-request-method");
        const names = (request.headers.get("access-control-request-headers") || "")
          .split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
        if (!corsOrigin || match?.[2] === "socket" ||
            !["GET", "POST"].includes(method) ||
            names.some((name) => !["authorization", "content-type"].includes(name)))
          throw new RoomError("ORIGIN_DENIED", "Room preflight denied.", 403);
        return roomCors(new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Methods": "GET, POST",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Cache-Control": "no-store",
          },
        }), corsOrigin);
      }
      const create = roomPath && request.method === "POST";
      if (!create && !match)
        throw new RoomError("NOT_FOUND", "Page not found.", 404);
      const config = configuration(env);
      const bucket = await rateKey(
        config,
        request.headers.get("cf-connecting-ip") || "unknown",
        create ? "create" : "join",
      );
      const limited = await env.ABUSE_LIMITS.get(
        env.ABUSE_LIMITS.idFromName(bucket.id),
      ).fetch(
        new Request("https://internal/limit", {
          method: "POST",
          body: JSON.stringify(bucket),
        }),
      );
      if (!limited.ok) return roomCors(limited, corsOrigin);
      const id = create
          ? crypto.randomUUID()
          : await verifyInvite(config.secret, match[1]),
        action = create ? "create" : match[2] || "info";
      if (
        action === "socket" &&
        (request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
          (!corsOrigin && origin !== url.origin) ||
          url.search)
      )
        throw new RoomError(
          "ORIGIN_DENIED",
          "Open the room on its own website.",
          403,
        );
      const internal = new URL(request.url);
      internal.pathname = "/" + action;
      const headers = new Headers(request.headers);
      headers.set("x-room-id", id);
      const response = await env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(
        new Request(internal, {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
        }),
      );
      return roomCors(response, corsOrigin);
    } catch (error) {
      const response = failure(error);
      return roomRoute ? roomCors(response, corsOrigin) : response;
    }
  },
};
