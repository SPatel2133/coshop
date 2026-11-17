import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { Rooms } from "../server/rooms.js";
import { configuration } from "../server/config.js";
import { nodeStore, migrate } from "../server/storage.js";
const schemas = await Promise.all(
  [
    "0001_rooms.sql",
    "0002_presence.sql",
    "0003_hold_ups.sql",
    "0004_shared_finds.sql",
  ].map((name) =>
    readFile(
      new URL("../drizzle/room-object/" + name, import.meta.url),
      "utf8",
    ),
  ),
);
function setup(t, version = 4) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const store = nodeStore(db);
  schemas.slice(0, version).forEach((sql, i) => migrate(store, sql, i + 1));
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
const share = (extra = {}) => ({
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

test("first share is canonical, creates one find and leaves every bag field unchanged", (t) => {
  const { rooms, id, maya, sam, store } = setup(t);
  const before = rooms.snapshot(id).bag;
  const first = rooms.shopCommand(
    id,
    "maya-socket",
    share({ cents: 1, name: "forged", by: sam.id }),
  );
  assert.equal(first.ack.ok, true);
  assert.equal(first.ack.find.cents, 14900);
  assert.equal(first.ack.find.sharedBy.id, maya.id);
  assert.equal(first.ack.find.name, "A little quiet");
  assert.deepEqual(first.ack.bag, before);
  assert.deepEqual(rooms.snapshot(id).bag, before);
  assert.deepEqual(
    store.all("SELECT type FROM events").map((e) => e.type),
    ["hold_up"],
  );
  assert.equal(store.all("SELECT * FROM shared_finds").length, 1);
});
test("repeat shares keep the first sharer and card position; different variants stay separate", (t) => {
  const { rooms, id, maya, sam, tick } = setup(t);
  rooms.shopCommand(id, "maya-socket", share());
  rooms.shopCommand(id, "sam-socket", share({ variantId: "audio-0" }));
  const before = rooms.snapshot(id).finds;
  assert.deepEqual(
    before.map((f) => f.variantId),
    ["audio-0", "audio-1"],
  );
  tick(3000);
  const repeat = rooms.shopCommand(id, "sam-socket", share());
  assert.equal(repeat.ack.event.repeated, true);
  assert.equal(repeat.ack.find.sharedBy.id, maya.id);
  assert.equal(repeat.ack.find.latestShare.by.id, sam.id);
  assert.deepEqual(
    rooms.snapshot(id).finds.map((f) => f.id),
    before.map((f) => f.id),
  );
  assert.equal(rooms.snapshot(id).bag.totalQuantity, 0);
});
test("committed request retries cannot create another event, card, broadcast or change meaning", (t) => {
  const { rooms, id, store } = setup(t),
    message = share();
  const original = rooms.shopCommand(id, "maya-socket", message);
  const replay = rooms.shopCommand(id, "maya-socket", message);
  assert.deepEqual(replay.ack, original.ack);
  assert.equal(replay.notification, null);
  assert.equal(store.all("SELECT * FROM events").length, 1);
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
test("cooldown spans a person's tabs, is nonfatal and lasts exactly three seconds", (t) => {
  const { rooms, id, tick } = setup(t);
  rooms.connect(id, "maya", "second-tab");
  rooms.shopCommand(id, "maya-socket", share());
  const rejected = rooms.shopCommand(id, "second-tab", share());
  assert.equal(rejected.ack.code, "COOLDOWN");
  assert.equal(rejected.ack.retryAfterMs, 3000);
  tick(2999);
  assert.equal(
    rooms.shopCommand(id, "second-tab", share()).ack.retryAfterMs,
    1,
  );
  tick(1);
  assert.equal(rooms.shopCommand(id, "second-tab", share()).ack.ok, true);
});
test("invalid variants, malformed commands, cross-room reactions and disconnected writers are rejected safely", (t) => {
  const { rooms, id, store } = setup(t);
  for (const message of [
    share({ variantId: "shoe-0" }),
    share({ requestId: "guess" }),
    share({ productId: {} }),
    react({}),
    react(crypto.randomUUID()),
  ])
    assert.equal(rooms.shopCommand(id, "maya-socket", message).ack.ok, false);
  assert.equal(store.all("SELECT * FROM events").length, 0);
  const first = rooms.shopCommand(id, "maya-socket", share()).ack.event;
  const other = crypto.randomUUID();
  rooms.create(other, { name: "Other", avatar: "sky" }, "other");
  rooms.connect(other, "other", "other-socket");
  assert.equal(
    rooms.shopCommand(other, "other-socket", react(first.id)).ack.code,
    "INVALID_REACTION",
  );
  rooms.disconnect(id, "maya-socket");
  assert.throws(() => rooms.shopCommand(id, "maya-socket", share()), {
    code: "SESSION_DISCONNECTED",
  });
});
test("old finds and scoped reactions persist beyond two minutes without changing bag or order", (t) => {
  const { rooms, id, tick, sam } = setup(t);
  const event = rooms.shopCommand(id, "maya-socket", share()).ack.event;
  assert.equal(
    rooms.shopCommand(id, "sam-socket", react(event.id, { emoji: "<img>" })).ack
      .code,
    "INVALID_REACTION",
  );
  tick(120001);
  rooms.heartbeat(id, "sam-socket");
  const before = rooms.snapshot(id),
    message = react(event.id);
  const first = rooms.shopCommand(id, "sam-socket", message);
  assert.equal(first.ack.ok, true);
  assert.equal(first.notification.type, "reaction");
  assert.equal(first.ack.event.by.id, sam.id);
  assert.equal(first.ack.event.variantId, "audio-1");
  assert.equal("counts" in first.ack.event, false);
  assert.deepEqual(rooms.snapshot(id).finds, before.finds);
  assert.deepEqual(first.ack.bag, before.bag);
  assert.equal(rooms.shopCommand(id, "sam-socket", message).notification, null);
  assert.equal(
    rooms.shopCommand(id, "sam-socket", react(event.id)).ack.code,
    "COOLDOWN",
  );
});
test("new service instances restore all finds, while expiry removes projection and history", (t) => {
  const { rooms, id, store, tick, config } = setup(t);
  rooms.shopCommand(
    id,
    "maya-socket",
    share({ productId: "shoe", variantId: "shoe-2" }),
  );
  rooms.shopCommand(id, "sam-socket", share());
  tick(300000);
  const restored = new Rooms(store, config, rooms.clock).snapshot(id);
  assert.equal(restored.finds.length, 2);
  assert.equal(restored.finds[1].available, false);
  assert.deepEqual(
    restored.finds.map((f) => f.variantId),
    ["audio-1", "shoe-2"],
  );
  tick(config.ttl);
  assert.throws(() => rooms.snapshot(id), { code: "ROOM_EXPIRED" });
  for (const table of [
    "shared_finds",
    "bag_lines",
    "events",
    "connections",
    "participants",
    "room_records",
  ])
    assert.equal(store.all("SELECT * FROM " + table).length, 0, table);
});
test("migration four backfills all historical shares, preserving bags, events and sessions exactly", (t) => {
  const { rooms, id, store, maya, sam } = setup(t, 3);
  const payload = {
    name: "Historical headphones",
    image: "https://example.com/product.jpg",
    variant: "Black",
    cents: 14900,
    currency: "CAD",
    available: true,
  };
  for (const [eventId, user, time] of [
    ["old-first", maya, 1],
    ["old-repeat", sam, 2],
  ])
    store.run(
      "INSERT INTO events(id,room_id,user_id,product_id,variant_id,type,payload,created_at) VALUES(?,?,?,?,?,'hold_up',?,?)",
      eventId,
      id,
      user.id,
      "audio",
      "audio-1",
      JSON.stringify({
        ...payload,
        by: { id: user.id, name: user.display_name, avatar: user.avatar },
      }),
      time,
    );
  store.run(
    "INSERT INTO bag_lines VALUES(?,?,?,3,?,1)",
    id,
    "audio-1",
    "audio",
    sam.id,
  );
  store.run(
    "INSERT INTO events(id,room_id,user_id,product_id,variant_id,type,payload,created_at) VALUES('old-add',?,?,?,?,'add_to_bag','{}',1)",
    id,
    sam.id,
    "audio",
    "audio-1",
  );
  const before = ["events", "bag_lines", "participants"].map((table) =>
    store.all("SELECT * FROM " + table),
  );
  migrate(store, schemas[3], 4);
  migrate(store, schemas[3], 4);
  assert.deepEqual(
    ["events", "bag_lines", "participants"].map((table) =>
      store.all("SELECT * FROM " + table),
    ),
    before,
  );
  const snapshot = rooms.snapshot(id);
  assert.equal(snapshot.finds.length, 1);
  assert.equal(snapshot.finds[0].sharedBy.id, maya.id);
  assert.equal(snapshot.finds[0].latestShare.by.id, sam.id);
  assert.equal(snapshot.bag.items[0].pickedBy.id, sam.id);
  assert.equal(snapshot.bag.totalQuantity, 3);
  const bag = snapshot.bag;
  rooms.shopCommand(id, "maya-socket", share());
  assert.deepEqual(rooms.snapshot(id).bag, bag);
  assert.equal(store.all("SELECT * FROM schema_migrations").length, 4);
});
