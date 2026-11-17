import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { Rooms } from "../server/rooms.js";
import { configuration } from "../server/config.js";
import { nodeStore, migrate } from "../server/storage.js";
const schemas = await Promise.all(
  ["0001_rooms.sql", "0002_presence.sql", "0003_hold_ups.sql"].map((name) =>
    readFile(
      new URL("../drizzle/room-object/" + name, import.meta.url),
      "utf8",
    ),
  ),
);
function setup(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const store = nodeStore(db);
  schemas.forEach((sql, i) => migrate(store, sql, i + 1));
  let now = 1000000;
  const config = configuration({
    INVITE_SIGNING_SECRET: "phase3-test-only-signing-key-0123456789",
  });
  const rooms = new Rooms(store, config, () => now),
    id = crypto.randomUUID();
  const maya = rooms.create(id, { name: "Maya", avatar: "sage" }, "maya");
  const sam = rooms.join(id, { name: "Sam", avatar: "clay" }, "sam");
  rooms.connect(id, "maya", "maya-socket");
  rooms.connect(id, "sam", "sam-socket");
  t.after(() => db.close());
  return { rooms, id, maya, sam, store, config, tick: (n) => (now += n) };
}
const hold = (extra = {}) => ({
  type: "hold_up",
  requestId: crypto.randomUUID(),
  productId: "audio",
  variantId: "audio-1",
  ...extra,
});
const react = (holdUpId, extra = {}) => ({
  type: "react",
  requestId: crypto.randomUUID(),
  holdUpId,
  emoji: "❤️",
  ...extra,
});

test("first hold records canonical metadata and one atomic bag addition; repeats keep picker and quantity", (t) => {
  const { rooms, id, maya, sam, store, tick } = setup(t);
  const first = rooms.shopCommand(
    id,
    "maya-socket",
    hold({ cents: 1, name: "forged", by: sam.id }),
  );
  assert.equal(first.ack.ok, true);
  assert.equal(first.notification.event.cents, 14900);
  assert.equal(first.ack.event.by.id, maya.id);
  assert.equal(first.ack.event.name, "A little quiet");
  assert.equal(first.ack.bag.totalQuantity, 1);
  assert.deepEqual(
    store.all("SELECT type FROM events ORDER BY sequence").map((e) => e.type),
    ["hold_up", "add_to_bag"],
  );
  const repeat = rooms.shopCommand(id, "sam-socket", hold());
  assert.equal(repeat.ack.event.repeated, true);
  assert.equal(repeat.ack.event.by.id, sam.id);
  assert.equal(repeat.ack.event.pickedBy.id, maya.id);
  assert.equal(repeat.ack.bag.totalQuantity, 1);
  // Future explicit Add-to-bag quantities must not be reset by a repeated hold.
  store.run("UPDATE bag_lines SET quantity=4 WHERE room_id=?", id);
  tick(3000);
  const third = rooms.shopCommand(id, "sam-socket", hold());
  assert.equal(third.ack.bag.items[0].quantity, 4);
  assert.equal(third.ack.event.quantity, 4);
  assert.equal(third.ack.bag.items[0].pickedBy.id, maya.id);
});
test("request retries replay the same event without duplicate bag mutations, broadcasts or cooldown", (t) => {
  const { rooms, id, store } = setup(t),
    message = hold();
  const original = rooms.shopCommand(id, "maya-socket", message);
  const replay = rooms.shopCommand(id, "maya-socket", message);
  assert.deepEqual(replay.ack, original.ack);
  assert.equal(replay.notification, null);
  assert.equal(store.all("SELECT * FROM events").length, 2);
  assert.equal(
    rooms.shopCommand(id, "sam-socket", message).ack.code,
    "INVALID_COMMAND",
  );
  assert.equal(
    rooms.shopCommand(id, "maya-socket", { ...message, variantId: "audio-0" })
      .ack.code,
    "INVALID_COMMAND",
  );
});
test("cooldown is shared across one person's tabs, nonfatal and exactly three seconds", (t) => {
  const { rooms, id, tick } = setup(t);
  rooms.connect(id, "maya", "second-tab");
  rooms.shopCommand(id, "maya-socket", hold());
  const rejected = rooms.shopCommand(
    id,
    "second-tab",
    hold({ productId: "bag", variantId: "bag-0" }),
  );
  assert.equal(rejected.ack.code, "COOLDOWN");
  assert.equal(rejected.ack.retryAfterMs, 3000);
  tick(2999);
  assert.equal(rooms.shopCommand(id, "second-tab", hold()).ack.retryAfterMs, 1);
  tick(1);
  assert.equal(rooms.shopCommand(id, "second-tab", hold()).ack.ok, true);
});
test("bad product, malformed command and cross-room reactions never write partial events", (t) => {
  const { rooms, id, store } = setup(t);
  for (const message of [
    hold({ variantId: "shoe-0" }),
    hold({ requestId: "guess" }),
    hold({ productId: {} }),
    react({}),
    react(crypto.randomUUID()),
    { ...hold(), type: "other" },
  ]) {
    assert.equal(rooms.shopCommand(id, "maya-socket", message).ack.ok, false);
  }
  assert.equal(store.all("SELECT * FROM events").length, 0);
  assert.equal(rooms.snapshot(id).bag.totalQuantity, 0);
  const first = rooms.shopCommand(id, "maya-socket", hold()).ack.event;
  const other = crypto.randomUUID();
  rooms.create(other, { name: "Other", avatar: "sky" }, "other");
  rooms.connect(other, "other", "other-socket");
  assert.equal(
    rooms.shopCommand(other, "other-socket", react(first.id)).ack.code,
    "INVALID_REACTION",
  );
});
test("reactions are allowlisted, idempotent floating events with no tally and expire after two minutes", (t) => {
  const { rooms, id, tick, sam } = setup(t);
  const event = rooms.shopCommand(id, "maya-socket", hold()).ack.event;
  assert.equal(
    rooms.shopCommand(id, "sam-socket", react(event.id, { emoji: "<img>" })).ack
      .code,
    "INVALID_REACTION",
  );
  const message = react(event.id),
    first = rooms.shopCommand(id, "sam-socket", message);
  assert.equal(first.notification.type, "reaction");
  assert.equal(first.ack.event.by.id, sam.id);
  assert.equal("counts" in first.ack.event, false);
  assert.equal(first.ack.bag.totalQuantity, 1);
  assert.equal(rooms.shopCommand(id, "sam-socket", message).notification, null);
  assert.equal(
    rooms.shopCommand(id, "sam-socket", react(event.id)).ack.code,
    "COOLDOWN",
  );
  tick(120001);
  rooms.heartbeat(id, "sam-socket");
  assert.equal(
    rooms.shopCommand(id, "sam-socket", react(event.id)).ack.code,
    "INVALID_REACTION",
  );
  assert.equal(rooms.snapshot(id).holdUps.length, 0);
});
test("resync includes ordered recent holds and bag ownership after disconnect, while expiry deletes everything", (t) => {
  const { rooms, id, store, tick, config, maya } = setup(t);
  rooms.shopCommand(
    id,
    "maya-socket",
    hold({ productId: "shoe", variantId: "shoe-2" }),
  );
  rooms.shopCommand(id, "sam-socket", hold());
  rooms.disconnect(id, "maya-socket");
  const snapshot = rooms.snapshot(id);
  assert.equal(snapshot.holdUps.length, 2);
  assert.equal(snapshot.holdUps[0].available, false);
  assert.ok(snapshot.holdUps[0].sequence < snapshot.holdUps[1].sequence);
  assert.equal(
    snapshot.bag.items.find((l) => l.productId === "shoe").pickedBy.id,
    maya.id,
  );
  tick(config.ttl);
  assert.throws(() => rooms.snapshot(id), { code: "ROOM_EXPIRED" });
  for (const table of [
    "bag_lines",
    "events",
    "connections",
    "participants",
    "room_records",
  ])
    assert.equal(
      store.all("SELECT * FROM " + table).length,
      0,
      table + " must be empty",
    );
});
test("migration three upgrades populated Phase 2 storage without losing sessions or views", (t) => {
  const db = new DatabaseSync(":memory:");
  const store = nodeStore(db);
  t.after(() => db.close());
  migrate(store, schemas[0]);
  migrate(store, schemas[1], 2);
  store.run("INSERT INTO room_records VALUES('old','Room',1,1,1)");
  store.run(
    "INSERT INTO participants VALUES('person','old','Maya','sage','hash',1,1,1000000)",
  );
  store.run(
    "INSERT INTO events(id,room_id,user_id,type,payload,created_at) VALUES('view','old','person','view','{}',1)",
  );
  migrate(store, schemas[2], 3);
  migrate(store, schemas[2], 3);
  assert.equal(store.all("SELECT * FROM participants")[0].token_hash, "hash");
  assert.equal(store.all("SELECT * FROM events").length, 1);
  assert.equal(store.all("SELECT * FROM schema_migrations").length, 3);
});
