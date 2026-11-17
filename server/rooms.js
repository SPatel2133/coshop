import { RoomError } from "./config.js";
import { displayName, avatar, roomName, uniqueName } from "./participants.js";
import { newToken, digest, tokenHash, makeInvite } from "./security.js";
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
export async function roomHttp(rooms, id, action, request, config) {
  if (action === "info" && request.method === "GET") {
    rooms.require(id);
    return json({
      name: rooms.row(id).name,
      full: rooms.seated(id).length >= 6,
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
    const token = newToken(),
      hash = await digest(token);
    const person =
      action === "create"
        ? rooms.create(id, input, hash)
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
  constructor(store, config, clock = Date.now) {
    Object.assign(this, { store, config, clock });
  }
  row(id) {
    return this.store.all("SELECT * FROM room_records WHERE id=?", id)[0];
  }
  delete(id) {
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
  create(id, input, hash) {
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
      if (seated.length >= 6)
        throw new RoomError(
          "ROOM_FULL",
          "This room has six seats, and they’re all taken.",
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
        if (seated.length >= 6)
          throw new RoomError(
            "ROOM_FULL",
            "Your reserved seat expired, and this room is now full.",
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
        "INSERT INTO connections(id,room_id,participant_id,last_seen_at) VALUES(?,?,?,?)",
        connectionId,
        id,
        person.id,
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
      if (activity) this.bump(id, now, true);
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
    return { stale: stale.map((c) => c.id), seats: before };
  }
  snapshot(id) {
    const now = this.clock(),
      room = this.require(id, now);
    const connections = this.store.all(
      "SELECT participant_id FROM connections WHERE room_id=? AND last_seen_at>?",
      id,
      now - this.config.heartbeatTimeout,
    );
    const online = new Set(connections.map((c) => c.participant_id));
    const participants = this.seated(id, now).map((p) => ({
      id: p.id,
      name: p.display_name,
      avatar: p.avatar,
      connected: online.has(p.id),
      reservedUntil: online.has(p.id) ? null : p.seat_until,
    }));
    return {
      id: room.id,
      name: room.name,
      version: room.version,
      expiresAt: room.last_active_at + this.config.ttl,
      capacity: 6,
      participants,
      serverTime: now,
    };
  }
  nextAlarm(id) {
    const room = this.row(id);
    if (!room) return null;
    const now = this.clock(),
      deadlines = [room.last_active_at + this.config.ttl];
    for (const c of this.store.all(
      "SELECT last_seen_at FROM connections WHERE room_id=?",
      id,
    ))
      deadlines.push(c.last_seen_at + this.config.heartbeatTimeout);
    for (const p of this.seated(id, now)) deadlines.push(p.seat_until);
    return Math.max(now + 100, Math.min(...deadlines));
  }
}
