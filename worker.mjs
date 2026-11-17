import { DurableObject } from "cloudflare:workers";
import schema from "./drizzle/room-object/0001_rooms.sql";
import presenceSchema from "./drizzle/room-object/0002_presence.sql";
import holdUpSchema from "./drizzle/room-object/0003_hold_ups.sql";
import findsSchema from "./drizzle/room-object/0004_shared_finds.sql";
import { configuration, RoomError } from "./server/config.js";
import { verifyInvite, tokenHash, sameOrigin } from "./server/security.js";
import { objectStore, migrate } from "./server/storage.js";
import { Rooms, roomHttp, json } from "./server/rooms.js";
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
    });
    this.rooms = new Rooms(this.store, this.config);
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
    try {
      const url = new URL(request.url),
        id = request.headers.get("x-room-id");
      if (!id) throw new RoomError("INVALID_LINK", "Invalid invite.", 404);
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
      );
      this.broadcast(id);
      await this.schedule(id);
      return response;
    } catch (error) {
      if (error.code === "ROOM_EXPIRED" || !this.id()) await this.erase();
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
      } else if (message.type === "hold_up" || message.type === "react") {
        const result = this.rooms.shopCommand(c.roomId, c.id, message);
        if (result.notification) {
          for (const peer of this.ctx.getWebSockets())
            if (peer.deserializeAttachment()?.person && peer.readyState === 1)
              peer.send(JSON.stringify(result.notification));
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
      const { stale } = this.rooms.sweep(id);
      for (const ws of this.ctx.getWebSockets()) {
        const c = ws.deserializeAttachment();
        if (
          (!c?.person && Date.now() - c.created >= 5000) ||
          stale.includes(c.id)
        )
          ws.close(4000, "Connection timed out");
      }
      this.broadcast(id, true);
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
export default {
  async fetch(request, env) {
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
      sameOrigin(request);
      const config = configuration(env);
      const create = url.pathname === "/api/rooms" && request.method === "POST";
      const match = url.pathname.match(
        /^\/api\/rooms\/([^/]+)(?:\/(join|session|socket))?$/,
      );
      if (!create && !match)
        throw new RoomError("NOT_FOUND", "Page not found.", 404);
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
      if (!limited.ok) return limited;
      const id = create
          ? crypto.randomUUID()
          : await verifyInvite(config.secret, match[1]),
        action = create ? "create" : match[2] || "info";
      if (
        action === "socket" &&
        (request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
          request.headers.get("origin") !== url.origin ||
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
      return await env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(
        new Request(internal, {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
};
