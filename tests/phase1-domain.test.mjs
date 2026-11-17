import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { Rooms } from "../server/rooms.js";
import { configuration } from "../server/config.js";
import { nodeStore, migrate } from "../server/storage.js";
import {
  digest,
  newToken,
  makeInvite,
  verifyInvite,
  tokenHash,
} from "../server/security.js";
import { displayName } from "../server/participants.js";
import { consume, rateKey } from "../server/abuse.js";
const schema = await readFile(
  new URL("../drizzle/room-object/0001_rooms.sql", import.meta.url),
  "utf8",
);
const secret = "test-only-secret-with-at-least-32-characters";
const presenceSchema = await readFile(
  new URL("../drizzle/room-object/0002_presence.sql", import.meta.url),
  "utf8",
);
function setup(t, env = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const store = nodeStore(db);
  migrate(store, schema);
  migrate(store, presenceSchema, 2);
  let now = 1000000;
  const config = configuration({ INVITE_SIGNING_SECRET: secret, ...env }),
    rooms = new Rooms(store, config, () => now);
  const id = crypto.randomUUID();
  t.after(() => db.close());
  return {
    db,
    store,
    rooms,
    config,
    id,
    tick: (n) => (now += n),
    now: () => now,
  };
}
test("new session and invite are independent cryptographic credentials; server only stores hashes", async (t) => {
  const { rooms, id, store } = setup(t),
    token = newToken(),
    hash = await tokenHash(token);
  const person = rooms.create(id, { name: "Maya", avatar: "sage" }, hash),
    invite = await makeInvite(secret, id);
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(invite, token);
  assert.equal(await verifyInvite(secret, invite), id);
  assert.equal(rooms.auth(id, hash).id, person.id);
  assert.equal(
    store.all("SELECT token_hash FROM participants")[0].token_hash,
    hash,
  );
  assert.ok(!JSON.stringify(rooms.snapshot(id)).includes(hash));
  assert.ok(!JSON.stringify(rooms.snapshot(id)).includes(token));
  await assert.rejects(verifyInvite(secret, id + "." + "0".repeat(64)), {
    code: "INVALID_LINK",
  });
  await assert.rejects(verifyInvite(secret, "not-an-invite"), {
    code: "INVALID_LINK",
  });
});
test("six equal seats, no owner powers; rejected seventh join leaves no partial record", async (t) => {
  const { rooms, id, store } = setup(t);
  rooms.create(id, { name: "Maya", avatar: "sage" }, await digest(newToken()));
  for (let i = 0; i < 5; i++)
    rooms.join(
      id,
      { name: "Friend", avatar: "clay" },
      await digest(newToken()),
    );
  assert.throws(
    () => rooms.join(id, { name: "Extra", avatar: "sky" }, "extra-hash"),
    { code: "ROOM_FULL" },
  );
  assert.equal(rooms.snapshot(id).participants.length, 6);
  assert.equal(store.all("SELECT * FROM participants").length, 6);
  assert.ok(!("owner" in rooms.snapshot(id)));
});
test("valid token rejoins same identity without duplication; invalid token cannot claim a seat", async (t) => {
  const { rooms, id } = setup(t),
    hash = await digest(newToken());
  const person = rooms.create(id, { name: "Maya", avatar: "sage" }, hash);
  for (let i = 0; i < 3; i++) assert.equal(rooms.auth(id, hash).id, person.id);
  assert.throws(() => rooms.auth(id, "wrong"), { code: "INVALID_SESSION" });
  assert.equal(rooms.snapshot(id).participants.length, 1);
});
test("duplicate names normalize case/spacing, append numbers and stay within 32 characters", async (t) => {
  const { rooms, id } = setup(t);
  rooms.create(id, { name: " Maya ", avatar: "sage" }, "one");
  const second = rooms.join(id, { name: "maya", avatar: "clay" }, "two");
  const third = rooms.join(id, { name: "Maya", avatar: "sky" }, "three");
  assert.equal(second.display_name, "maya 2");
  assert.equal(third.display_name, "Maya 3");
  const long = "A".repeat(32);
  rooms.join(id, { name: long, avatar: "rose" }, "four");
  const duplicate = rooms.join(id, { name: long, avatar: "lilac" }, "five");
  assert.equal(duplicate.display_name.length, 32);
  assert.match(duplicate.display_name, / 2$/);
});
test("names reject HTML, control characters and overlong input; Unicode names survive safely", () => {
  for (const name of ["<img src=x>", "A\nB", "\u200b", " ", "x".repeat(33)])
    assert.throws(() => displayName(name), { code: "INVALID_NAME" });
  assert.equal(displayName("Élodie O’Neil"), "Élodie O’Neil");
  assert.equal(displayName("  王  明 "), "王 明");
});
test("disconnect keeps seat for exactly ten minutes; valid identity can reclaim only if capacity permits", (t) => {
  const { rooms, id, tick, now } = setup(t);
  const maya = rooms.create(id, { name: "Maya", avatar: "sage" }, "maya");
  rooms.connect(id, "maya", "socket");
  rooms.disconnect(id, "socket");
  assert.equal(
    rooms.snapshot(id).participants[0].reservedUntil,
    now() + 600000,
  );
  tick(599999);
  assert.equal(rooms.auth(id, "maya").id, maya.id);
  tick(1);
  assert.equal(rooms.snapshot(id).participants.length, 0);
  for (let i = 0; i < 6; i++)
    rooms.join(id, { name: "Friend", avatar: "clay" }, "friend-" + i);
  assert.throws(() => rooms.auth(id, "maya"), { code: "ROOM_FULL" });
  assert.equal(rooms.snapshot(id).participants.length, 6);
});
test("released identity can safely return when there is room, including a new name collision", (t) => {
  const { rooms, id, tick } = setup(t);
  const original = rooms.create(id, { name: "Maya", avatar: "sage" }, "maya");
  tick(600001);
  rooms.join(id, { name: "Maya", avatar: "rose" }, "new-maya");
  assert.equal(rooms.auth(id, "maya").id, original.id);
  assert.equal(rooms.auth(id, "maya").display_name, "Maya 2");
  assert.equal(rooms.snapshot(id).participants.length, 2);
});
test("two connections represent one person; closing one tab does not reserve/disconnect the other", (t) => {
  const { rooms, id, tick } = setup(t);
  rooms.create(id, { name: "Maya", avatar: "sage" }, "maya");
  rooms.connect(id, "maya", "tab1");
  rooms.connect(id, "maya", "tab2");
  rooms.disconnect(id, "tab1");
  tick(100);
  const person = rooms.snapshot(id).participants[0];
  assert.equal(person.connected, true);
  assert.equal(person.reservedUntil, null);
  rooms.disconnect(id, "tab2");
  assert.equal(rooms.snapshot(id).participants[0].connected, false);
});
test("stale heartbeat transitions to reserved seat; surviving connection keeps identity connected", (t) => {
  const { rooms, id, tick } = setup(t);
  rooms.create(id, { name: "Maya", avatar: "sage" }, "maya");
  rooms.connect(id, "maya", "stale");
  tick(65000);
  assert.deepEqual(rooms.sweep(id).stale, ["stale"]);
  assert.equal(rooms.snapshot(id).participants[0].connected, false);
  rooms.connect(id, "maya", "fresh");
  assert.equal(rooms.snapshot(id).participants[0].connected, true);
});
test("heartbeats do not prolong room lifetime; expiration deletes participants and connections", (t) => {
  const { rooms, id, tick, store } = setup(t, { ROOM_TTL_MS: 10000 });
  rooms.create(id, { name: "Maya", avatar: "sage" }, "maya");
  rooms.connect(id, "maya", "socket");
  tick(9000);
  rooms.heartbeat(id, "socket");
  tick(1000);
  assert.throws(() => rooms.snapshot(id), { code: "ROOM_EXPIRED" });
  for (const table of ["room_records", "participants", "connections", "events"])
    assert.equal(store.all("SELECT * FROM " + table).length, 0);
});
test("actual activity resets inactivity deadline; expired join cannot resurrect room", (t) => {
  const { rooms, id, tick, now } = setup(t, { ROOM_TTL_MS: 10000 });
  rooms.create(id, { name: "Maya", avatar: "sage" }, "maya");
  rooms.connect(id, "maya", "socket");
  tick(9000);
  rooms.heartbeat(id, "socket", true);
  assert.equal(rooms.snapshot(id).expiresAt, now() + 10000);
  tick(10000);
  assert.throws(() => rooms.join(id, { name: "Late", avatar: "sky" }, "late"), {
    code: "ROOM_EXPIRED",
  });
  assert.equal(rooms.row(id), undefined);
});
test("rate limits are atomic, windows expire, and raw IPs never enter storage", async (t) => {
  const { store, config, now } = setup(t, { CREATE_LIMIT_PER_HOUR: 2 });
  const ip = "192.0.2.42",
    bucket = await rateKey(config, ip, "create", now());
  consume(store, bucket, now());
  consume(store, bucket, now());
  assert.throws(() => consume(store, bucket, now()), {
    code: "RATE_LIMITED",
    status: 429,
  });
  assert.ok(
    !JSON.stringify(store.all("SELECT * FROM abuse_windows")).includes(ip),
  );
  const next = await rateKey(config, ip, "create", bucket.expires);
  consume(store, next, bucket.expires);
  assert.equal(store.all("SELECT * FROM abuse_windows").length, 1);
});
test("schema migration is repeatable and does not erase existing rooms", (t) => {
  const { rooms, id, store } = setup(t);
  rooms.create(id, { name: "Maya", avatar: "sage" }, "maya");
  migrate(store, schema);
  assert.equal(rooms.snapshot(id).participants[0].name, "Maya");
  assert.equal(store.all("SELECT * FROM schema_migrations").length, 2);
});
