import { RoomError } from "./config.js";
import { displayName, avatar, roomName, uniqueName } from "./participants.js";
import { newToken, digest, tokenHash, makeInvite } from "./security.js";
import { Events } from "./events.js";
import { HoldUps } from "./hold-ups.js";
import { Discussion, isDiscussion } from "./discussion.js";
import { Bag } from "./bag.js";
import { RoomStorefronts } from "./storefront.js";
import { Checkout } from "./checkout.js";
import { Haul } from "./haul.js";
import { catalog } from "../catalog.mjs";
const roomCapacity = 10;
export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
export async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return {};
  let length = 0,
    text = "";
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 4096) {
      await reader.cancel();
      throw new RoomError("BODY_TOO_LARGE", "That request is too large.", 413);
    }
    text += decoder.decode(value, { stream: true });
  }
  try {
    const value = JSON.parse(text + decoder.decode() || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new RoomError("INVALID_REQUEST", "Send a valid room request.");
  }
}
export async function roomHttp(
  rooms,
  id,
  action,
  request,
  config,
  publish = () => {},
) {
  if (
    action === "catalog" ||
    action === "checkout" ||
    action === "checkout-release" ||
    action === "haul-demo"
  ) {
    if (request.method !== (action === "catalog" ? "GET" : "POST"))
      throw new RoomError(
        "METHOD_NOT_ALLOWED",
        "Use the room controls to continue.",
        405,
      );
    const person = rooms.auth(
      id,
      await tokenHash(
        request.headers.get("authorization")?.replace(/^Bearer /, ""),
      ),
      false,
    );
    if (action === "catalog") {
      await rooms.storefronts.refresh(
        id,
        rooms.storefronts.get(id),
        () => !rooms.checkout.active(id),
      );
      rooms.require(id);
      return json(rooms.storefronts.public(id));
    }
    const input = await readBody(request);
    if (action === "haul-demo")
      return json({ recap: rooms.haul.demo(id, input) });
    if (action === "checkout-release")
      return json(rooms.checkout.release(id, person.id, input.id));
    return json(await rooms.checkout.start(id, person, input, publish));
  }
  if (action === "info" && request.method === "GET") {
    rooms.require(id);
    return json({
      name: rooms.row(id).name,
      full: rooms.seated(id).length >= roomCapacity,
      capacity: roomCapacity,
    });
  }
  if (request.method !== "POST")
    throw new RoomError(
      "METHOD_NOT_ALLOWED",
      "Use the room form to continue.",
      405,
    );
  const input = await readBody(request);
  if (action === "create" || action === "join") {
    let storefront;
    if (action === "create") {
      const mode = input.catalogMode ?? "sample";
      if (mode !== "sample" && mode !== "shopify")
        throw new RoomError(
          "INVALID_CATALOG",
          "Choose a sample or Shopify room.",
        );
      if (mode === "shopify") {
        const provider = rooms.storefronts?.provider;
        if (!provider || provider.configurationIssue)
          throw new RoomError(
            "SHOPIFY_UNAVAILABLE",
            provider?.configurationIssue === "invalid"
              ? "The Shopify store configuration is invalid. Choose Sample catalog or try again after it is corrected."
              : "No Shopify store is configured. Choose Sample catalog to continue.",
            503,
          );
        storefront = await provider.load();
        if (!storefront)
          throw new RoomError(
            "SHOPIFY_UNAVAILABLE",
            "Shopify could not load the catalog right now. Retry or choose Sample catalog.",
            503,
          );
      }
    }
    const token = newToken(),
      hash = await digest(token);
    const person =
      action === "create"
        ? rooms.create(id, input, hash, storefront)
        : rooms.join(id, input, hash);
    return json(
      {
        invite: await makeInvite(config.secret, id),
        token,
        me: person.id,
        room: rooms.snapshot(id),
        heartbeatInterval: config.heartbeat,
      },
      201,
    );
  }
  if (action === "session") {
    const person = rooms.auth(
      id,
      await tokenHash(
        request.headers.get("authorization")?.replace(/^Bearer /, ""),
      ),
    );
    return json({
      me: person.id,
      room: rooms.snapshot(id),
      heartbeatInterval: config.heartbeat,
    });
  }
  throw new RoomError("NOT_FOUND", "That room action does not exist.", 404);
}
export class Rooms {
  constructor(
    store,
    config,
    clock = Date.now,
    products = catalog,
    storefront = null,
    haul = false,
  ) {
    Object.assign(this, { store, config, clock });
    this.events = new Events(store, products);
    this.holdUps = new HoldUps(store, products);
    this.discussion = new Discussion(store);
    this.bag = new Bag(store, products);
    if (storefront) {
      this.storefronts = new RoomStorefronts(
        store,
        storefront,
        products,
        clock,
      );
      this.checkout = new Checkout(this);
    }
    if (haul) this.haul = new Haul(this);
  }
  products(id) {
    const storefront = this.storefronts?.get(id);
    return storefront?.mode === "shopify"
      ? storefront.products
      : this.events.products;
  }
  roomBag(id) {
    const storefront = this.storefronts?.get(id);
    if (storefront?.mode !== "shopify") return this.bag;
    if (!storefront.bag)
      storefront.bag = new Bag(
        this.store,
        storefront.products,
        storefront.checks,
        storefront.expiresAt - 60000,
      );
    return storefront.bag;
  }
  row(id) {
    return this.store.all("SELECT * FROM room_records WHERE id=?", id)[0];
  }
  delete(id) {
    this.storefronts?.cache.delete(id);
    this.store.run("DELETE FROM shared_finds WHERE room_id=?", id);
    this.store.run("DELETE FROM bag_lines WHERE room_id=?", id);
    this.store.run("DELETE FROM events WHERE room_id=?", id);
    this.store.run("DELETE FROM connections WHERE room_id=?", id);
    this.store.run("DELETE FROM participants WHERE room_id=?", id);
    this.store.run("DELETE FROM room_records WHERE id=?", id);
  }
  require(id, now = this.clock()) {
    const room = this.row(id);
    if (!room)
      throw new RoomError(
        "ROOM_EXPIRED",
        "This room has expired. Start a fresh one together.",
        410,
      );
    if (now >= room.last_active_at + this.config.ttl) {
      this.delete(id);
      throw new RoomError(
        "ROOM_EXPIRED",
        "This room has expired. Start a fresh one together.",
        410,
      );
    }
    return room;
  }
  bump(id, now, activity = false) {
    this.store.run(
      activity
        ? "UPDATE room_records SET version=version+1,last_active_at=? WHERE id=?"
        : "UPDATE room_records SET version=version+1 WHERE id=?",
      ...(activity ? [now, id] : [id]),
    );
  }
  seated(id, now = this.clock()) {
    return this.store.all(
      "SELECT * FROM participants WHERE room_id=? AND seat_until>? ORDER BY joined_at,id",
      id,
      now,
    );
  }
  create(id, input, hash, storefront) {
    const now = this.clock(),
      name = displayName(input.name),
      color = avatar(input.avatar),
      title = roomName(input.roomName);
    return this.store.transaction(() => {
      if (this.row(id))
        throw new RoomError("CONFLICT", "Try creating your room again.", 409);
      this.store.run(
        "INSERT INTO room_records(id,name,created_at,last_active_at,version) VALUES(?,?,?,?,1)",
        id,
        title,
        now,
        now,
      );
      this.storefronts?.create(id, storefront);
      return this.insert(id, name, color, hash, now);
    });
  }
  insert(id, name, color, hash, now) {
    const person = {
      id: crypto.randomUUID(),
      room_id: id,
      display_name: name,
      avatar: color,
      token_hash: hash,
      joined_at: now,
      last_seen_at: now,
      seat_until: now + this.config.reservation,
    };
    this.store.run(
      "INSERT INTO participants(id,room_id,display_name,avatar,token_hash,joined_at,last_seen_at,seat_until) VALUES(?,?,?,?,?,?,?,?)",
      ...Object.values(person),
    );
    return person;
  }
  join(id, input, hash) {
    const now = this.clock(),
      name = displayName(input.name),
      color = avatar(input.avatar);
    // Expiration deletion must happen outside a transaction that will roll back
    // if require() throws. This is synchronous and cannot interleave with join.
    this.require(id, now);
    return this.store.transaction(() => {
      const seated = this.seated(id, now);
      if (seated.length >= roomCapacity)
        throw new RoomError(
          "ROOM_FULL",
          `All ${roomCapacity} seats are taken, including seats reserved for reconnecting friends.`,
          409,
        );
      const person = this.insert(
        id,
        uniqueName(
          name,
          seated.map((p) => p.display_name),
        ),
        color,
        hash,
        now,
      );
      this.bump(id, now, true);
      return person;
    });
  }
  auth(id, hash, reserve = true) {
    const now = this.clock();
    this.require(id, now);
    return this.store.transaction(() => {
      const person = this.store.all(
        "SELECT * FROM participants WHERE room_id=? AND token_hash=?",
        id,
        hash,
      )[0];
      if (!person)
        throw new RoomError(
          "INVALID_SESSION",
          "Your saved session is not valid. You can join with a new identity.",
          401,
        );
      if (person.seat_until <= now) {
        const seated = this.seated(id, now);
        if (seated.length >= roomCapacity)
          throw new RoomError(
            "ROOM_FULL",
            `Your reserved seat expired, and all ${roomCapacity} seats are now taken.`,
            409,
          );
        if (reserve) {
          person.display_name = uniqueName(
            person.display_name,
            seated.map((p) => p.display_name),
          );
          person.seat_until = now + this.config.reservation;
          this.store.run(
            "UPDATE participants SET seat_until=?,display_name=? WHERE id=?",
            person.seat_until,
            person.display_name,
            person.id,
          );
          this.bump(id, now);
        }
      }
      return person;
    });
  }
  connect(id, hash, connectionId) {
    const person = this.auth(id, hash),
      now = this.clock();
    this.store.transaction(() => {
      this.store.run(
        "INSERT INTO connections(id,room_id,participant_id,last_seen_at,last_activity_at) VALUES(?,?,?,?,?)",
        connectionId,
        id,
        person.id,
        now,
        now,
      );
      this.store.run(
        "UPDATE participants SET last_seen_at=?,seat_until=? WHERE id=?",
        now,
        now + this.config.heartbeatTimeout + this.config.reservation,
        person.id,
      );
      this.bump(id, now);
    });
    return person;
  }
  heartbeat(id, connectionId, activity = false) {
    const now = this.clock();
    this.require(id, now);
    const connection = this.store.all(
      "SELECT * FROM connections WHERE id=? AND room_id=?",
      connectionId,
      id,
    )[0];
    if (!connection)
      throw new RoomError(
        "SESSION_DISCONNECTED",
        "Reconnect to restore your session.",
        401,
      );
    this.store.transaction(() => {
      this.store.run(
        "UPDATE connections SET last_seen_at=? WHERE id=?",
        now,
        connectionId,
      );
      this.store.run(
        "UPDATE participants SET last_seen_at=?,seat_until=? WHERE id=?",
        now,
        now + this.config.heartbeatTimeout + this.config.reservation,
        connection.participant_id,
      );
      if (activity) {
        this.store.run(
          "UPDATE connections SET last_activity_at=? WHERE id=?",
          now,
          connectionId,
        );
        this.bump(id, now, true);
      }
    });
  }
  disconnect(id, connectionId) {
    const now = this.clock();
    const connection = this.store.all(
      "SELECT * FROM connections WHERE id=? AND room_id=?",
      connectionId,
      id,
    )[0];
    if (!connection || !this.row(id)) return;
    this.store.transaction(() => {
      this.store.run("DELETE FROM connections WHERE id=?", connectionId);
      const other = this.store.all(
        "SELECT id FROM connections WHERE participant_id=? AND last_seen_at>?",
        connection.participant_id,
        now - this.config.heartbeatTimeout,
      );
      if (!other.length)
        this.store.run(
          "UPDATE participants SET seat_until=? WHERE id=?",
          now + this.config.reservation,
          connection.participant_id,
        );
      this.bump(id, now);
    });
  }
  sweep(id) {
    const now = this.clock();
    this.require(id, now);
    const before = this.seated(id, now).length;
    const stale = this.store.all(
      "SELECT id FROM connections WHERE room_id=? AND last_seen_at<=?",
      id,
      now - this.config.heartbeatTimeout,
    );
    for (const c of stale) this.disconnect(id, c.id);
    return {
      stale: stale.map((c) => c.id),
      seats: before,
      checkoutExpired: this.checkout?.sweep(id, now),
    };
  }
  publishView(id, connectionId, input, requestId) {
    const now = this.clock();
    this.require(id, now);
    const connection = this.store.all(
      "SELECT * FROM connections WHERE room_id=? AND id=? AND last_seen_at>?",
      id,
      connectionId,
      now - this.config.heartbeatTimeout,
    )[0];
    if (!connection)
      throw new RoomError(
        "SESSION_DISCONNECTED",
        "Reconnect to restore your session.",
        401,
      );
    return this.store.transaction(() => {
      const result = this.events.appendView(
        id,
        connection.participant_id,
        input,
        requestId,
        now,
        this.products(id),
      );
      if (result.accepted && !result.replay) {
        this.store.run(
          "UPDATE connections SET last_activity_at=? WHERE id=?",
          now,
          connectionId,
        );
        this.bump(id, now, true);
      }
      return { type: "view_ack", requestId, ...result };
    });
  }
  shopCommand(id, connectionId, message) {
    const now = this.clock();
    const room = this.require(id, now);
    const connection = this.store.all(
      "SELECT * FROM connections WHERE room_id=? AND id=? AND last_seen_at>?",
      id,
      connectionId,
      now - this.config.heartbeatTimeout,
    )[0];
    if (!connection)
      throw new RoomError(
        "SESSION_DISCONNECTED",
        "Reconnect to restore your session.",
        401,
      );
    try {
      return this.store.transaction(() => {
        const touch = () => {
          this.store.run(
            "UPDATE connections SET last_activity_at=? WHERE id=?",
            now,
            connectionId,
          );
          this.bump(id, now, true);
        };
        if (isDiscussion(message.type))
          return this.discussion.command(
            id,
            connection.participant_id,
            message,
            now,
            room.version,
            touch,
          );
        if (message.type === "bag_change") {
          // A committed request replays its original ack even while locked;
          // Bag.command rejects replays that change meaning or owner.
          const replay =
            typeof message.requestId === "string" &&
            this.store.all(
              "SELECT 1 FROM events WHERE id=? AND room_id=?",
              message.requestId,
              id,
            ).length;
          if (!replay && this.checkout?.active(id))
            throw new RoomError(
              "CHECKOUT_BUSY",
              "The shared bag is locked while someone checks out.",
              409,
            );
          return this.roomBag(id).command(
            id,
            connection.participant_id,
            message,
            now,
            touch,
          );
        }
        const result = this.holdUps.append(
          id,
          connection.participant_id,
          message,
          now,
          this.products(id),
        );
        if (!result.replay) touch();
        const bag = this.roomBag(id).snapshot(id);
        const find = this.holdUps.finds(id, result.event.variantId)[0];
        return {
          ack: {
            type: "command_ack",
            requestId: message.requestId,
            ok: true,
            event: result.event,
            find,
            bag,
          },
          notification: result.replay
            ? null
            : {
                type: message.type === "hold_up" ? "hold_up" : "reaction",
                event: result.event,
                find,
                bag,
                version: this.row(id).version,
                serverTime: now,
              },
        };
      });
    } catch (error) {
      if (!(error instanceof RoomError)) throw error;
      return {
        ack: {
          type: "command_ack",
          requestId: message.requestId,
          ok: false,
          code: error.code,
          message: error.message,
          retryAfterMs: error.retryAfterMs,
        },
      };
    }
  }
  snapshot(id) {
    const now = this.clock(),
      room = this.require(id, now);
    const connections = this.store.all(
      "SELECT participant_id,last_activity_at FROM connections WHERE room_id=? AND last_seen_at>?",
      id,
      now - this.config.heartbeatTimeout,
    );
    const online = new Set(connections.map((c) => c.participant_id));
    const participants = this.seated(id, now).map((p) => ({
      id: p.id,
      name: p.display_name,
      avatar: p.avatar,
      connected: online.has(p.id),
      away:
        online.has(p.id) &&
        now -
          Math.max(
            ...connections
              .filter((c) => c.participant_id === p.id)
              .map((c) => c.last_activity_at),
          ) >=
          this.config.presenceIdle,
      view: this.events.location(this.events.latest(id, p.id)),
      reservedUntil: online.has(p.id) ? null : p.seat_until,
    }));
    return {
      id: room.id,
      name: room.name,
      version: room.version,
      expiresAt: room.last_active_at + this.config.ttl,
      capacity: roomCapacity,
      participants,
      bag: this.roomBag(id).snapshot(id),
      finds: this.holdUps.finds(id),
      catalogMode: this.storefronts?.get(id).mode || "sample",
      checkoutEnabled: this.storefronts?.enabled(id) ?? false,
      ...(this.checkout ? { checkout: this.checkout.active(id) } : {}),
      ...(this.haul ? { recap: this.haul.latest(id) } : {}),
      serverTime: now,
    };
  }
  nextAlarm(id) {
    const room = this.row(id);
    if (!room) return null;
    const now = this.clock(),
      deadlines = [room.last_active_at + this.config.ttl];
    const checkout = this.checkout?.active(id);
    if (checkout) deadlines.push(checkout.expiresAt);
    for (const c of this.store.all(
      "SELECT last_seen_at,last_activity_at FROM connections WHERE room_id=?",
      id,
    )) {
      deadlines.push(c.last_seen_at + this.config.heartbeatTimeout);
      const idleAt = c.last_activity_at + this.config.presenceIdle;
      if (idleAt > now) deadlines.push(idleAt);
    }
    for (const p of this.seated(id, now)) deadlines.push(p.seat_until);
    return Math.max(now + 100, Math.min(...deadlines));
  }
}
