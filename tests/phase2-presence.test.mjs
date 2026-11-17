import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { Rooms } from "../server/rooms.js";
import { nodeStore, migrate } from "../server/storage.js";
import { configuration } from "../server/config.js";
import { presenceChanges } from "../server/realtime.js";
import { resolveLocation } from "../client/presence.js";
const schemas = await Promise.all(
  ["0001_rooms.sql", "0002_presence.sql", "0003_hold_ups.sql"].map((name) =>
    readFile(
      new URL("../drizzle/room-object/" + name, import.meta.url),
      "utf8",
    ),
  ),
);
function setup(t, env = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const store = nodeStore(db);
  schemas.forEach((sql, i) => migrate(store, sql, i + 1));
  let now = 1000000;
  const config = configuration({
    INVITE_SIGNING_SECRET: "phase2-test-only-signing-key-0123456789",
    ...env,
  });
  const rooms = new Rooms(store, config, () => now),
    id = crypto.randomUUID();
  const maya = rooms.create(id, { name: "Maya", avatar: "sage" }, "maya");
  rooms.connect(id, "maya", "maya-socket");
  const sam = rooms.join(id, { name: "Sam", avatar: "clay" }, "sam");
  rooms.connect(id, "sam", "sam-socket");
  t.after(() => db.close());
  return {
    db,
    store,
    rooms,
    id,
    maya,
    sam,
    config,
    now: () => now,
    tick: (n) => (now += n),
  };
}
const view = (productId = "audio", variantId = "audio-0") => ({
  kind: "product",
  productId,
  variantId,
});
test("append-only view events are canonical, scoped to the authenticated shopper, and survive service reconstruction", (t) => {
  const { rooms, id, maya, sam, store, config, now } = setup(t);
  const requestId = crypto.randomUUID();
  const ack = rooms.publishView(
    id,
    "maya-socket",
    { ...view(), userId: sam.id, title: "<script>", category: "forged" },
    requestId,
  );
  assert.equal(ack.accepted, true);
  const event = store.all("SELECT * FROM events")[0];
  assert.equal(event.user_id, maya.id);
  assert.equal(event.type, "view");
  assert.equal(event.product_id, "audio");
  assert.equal(event.variant_id, "audio-0");
  assert.deepEqual(JSON.parse(event.payload), {
    kind: "product",
    category: "Audio",
  });
  const restored = new Rooms(store, config, now).snapshot(id);
  assert.equal(
    restored.participants.find((p) => p.id === maya.id).view.eventId,
    requestId,
  );
  assert.equal(restored.participants.find((p) => p.id === sam.id).view, null);
});
test("500ms server throttle applies across tabs; retries are idempotent and IDs cannot change meaning", (t) => {
  const { rooms, id, store, tick } = setup(t);
  rooms.connect(id, "maya", "second-tab");
  const requestId = crypto.randomUUID();
  rooms.publishView(id, "maya-socket", view(), requestId);
  assert.equal(
    rooms.publishView(id, "second-tab", view(), requestId).replay,
    true,
  );
  assert.equal(store.all("SELECT * FROM events").length, 1);
  const nextId = crypto.randomUUID();
  const rejected = rooms.publishView(
    id,
    "second-tab",
    view("watch", "watch-1"),
    nextId,
  );
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.retryAfterMs, 500);
  tick(499);
  assert.equal(
    rooms.publishView(id, "second-tab", view("watch", "watch-1"), nextId)
      .retryAfterMs,
    1,
  );
  tick(1);
  assert.equal(
    rooms.publishView(id, "second-tab", view("watch", "watch-1"), nextId)
      .accepted,
    true,
  );
  assert.equal(store.all("SELECT * FROM events").length, 2);
  assert.throws(
    () =>
      rooms.publishView(id, "maya-socket", view("shoe", "shoe-0"), requestId),
    { code: "INVALID_VIEW" },
  );
  assert.throws(() => rooms.publishView(id, "sam-socket", view(), requestId), {
    code: "INVALID_VIEW",
  });
});
test("untrusted product/category data and disconnected writers never enter the event log", (t) => {
  const { rooms, id, store } = setup(t);
  for (const input of [
    view("missing", "missing-0"),
    view("shoe", "watch-0"),
    { kind: "category", category: "<img>" },
    { kind: "cursor", x: 2 },
    null,
  ])
    assert.throws(
      () => rooms.publishView(id, "maya-socket", input, crypto.randomUUID()),
      { code: "INVALID_VIEW" },
    );
  rooms.disconnect(id, "maya-socket");
  assert.throws(
    () => rooms.publishView(id, "maya-socket", view(), crypto.randomUUID()),
    { code: "SESSION_DISCONNECTED" },
  );
  assert.equal(store.all("SELECT * FROM events").length, 0);
});
test("presence derives latest category/product/variant; unavailable variants remain viewable", (t) => {
  const { rooms, id, maya, tick } = setup(t);
  rooms.publishView(
    id,
    "maya-socket",
    view("shoe", "shoe-2"),
    crypto.randomUUID(),
  );
  assert.equal(
    rooms.snapshot(id).participants.find((p) => p.id === maya.id).view
      .variantId,
    "shoe-2",
  );
  tick(500);
  rooms.publishView(
    id,
    "maya-socket",
    { kind: "category", category: "Wear" },
    crypto.randomUUID(),
  );
  const location = rooms
    .snapshot(id)
    .participants.find((p) => p.id === maya.id).view;
  assert.equal(location.kind, "category");
  assert.equal(location.category, "Wear");
  assert.equal(location.productId, null);
  assert.equal(location.variantId, null);
});
test("30s idle is independent of heartbeat; real interaction wakes the shopper without inventing a view", (t) => {
  const { rooms, id, maya, tick, store } = setup(t);
  rooms.publishView(id, "maya-socket", view(), crypto.randomUUID());
  tick(29999);
  rooms.heartbeat(id, "maya-socket");
  assert.equal(
    rooms.snapshot(id).participants.find((p) => p.id === maya.id).away,
    false,
  );
  tick(1);
  assert.equal(
    rooms.snapshot(id).participants.find((p) => p.id === maya.id).away,
    true,
  );
  rooms.heartbeat(id, "maya-socket", true);
  assert.equal(
    rooms.snapshot(id).participants.find((p) => p.id === maya.id).away,
    false,
  );
  assert.equal(store.all("SELECT * FROM events").length, 1);
});
test("any active tab can keep one identity here; disconnected tabs do not supply activity", (t) => {
  const { rooms, id, maya, tick } = setup(t);
  tick(20000);
  rooms.connect(id, "maya", "second-tab");
  tick(15000);
  assert.equal(
    rooms.snapshot(id).participants.find((p) => p.id === maya.id).away,
    false,
  );
  rooms.disconnect(id, "second-tab");
  assert.equal(
    rooms.snapshot(id).participants.find((p) => p.id === maya.id).away,
    true,
  );
  assert.equal(
    rooms.snapshot(id).participants.find((p) => p.id === maya.id).connected,
    true,
  );
});
test("event records are removed with room expiry, including after a rejected expired request", (t) => {
  const { rooms, id, tick, store } = setup(t, { ROOM_TTL_MS: 1000 });
  rooms.publishView(id, "maya-socket", view(), crypto.randomUUID());
  tick(1000);
  assert.throws(
    () => rooms.publishView(id, "maya-socket", view(), crypto.randomUUID()),
    { code: "ROOM_EXPIRED" },
  );
  for (const table of ["events", "participants", "connections", "room_records"])
    assert.equal(store.all("SELECT * FROM " + table).length, 0);
});
test("upgrading a Phase 1 database preserves identities and applies migration 2 only once", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const store = nodeStore(db);
  migrate(store, schemas[0]);
  store.run(
    "INSERT INTO room_records(id,name,created_at,last_active_at,version) VALUES('old','Existing room',1,1,1)",
  );
  store.run(
    "INSERT INTO participants VALUES('person','old','Maya','sage','valid-old-hash',1,1,100000)",
  );
  migrate(store, schemas[1], 2);
  migrate(store, schemas[1], 2);
  assert.equal(
    store.all("SELECT token_hash FROM participants")[0].token_hash,
    "valid-old-hash",
  );
  assert.equal(store.all("SELECT * FROM schema_migrations").length, 2);
  assert.equal(store.all("SELECT * FROM events").length, 0);
});
test("presence deltas contain only changed people; routine heartbeats do not fan out full states", (t) => {
  const { rooms, id, maya, tick } = setup(t),
    cache = new Map();
  presenceChanges(rooms.snapshot(id), cache);
  rooms.heartbeat(id, "maya-socket");
  assert.equal(presenceChanges(rooms.snapshot(id), cache).messages.length, 0);
  rooms.publishView(id, "maya-socket", view(), crypto.randomUUID());
  const change = presenceChanges(rooms.snapshot(id), cache);
  assert.equal(change.membershipChanged, false);
  assert.equal(change.messages.length, 1);
  assert.equal(change.messages[0].participant.id, maya.id);
  assert.ok(JSON.stringify(change.messages[0]).length < 1000);
  assert.ok(!("room" in change.messages[0]));
  tick(30000);
  assert.equal(
    presenceChanges(rooms.snapshot(id), cache).messages.filter(
      (m) => m.participant.away,
    ).length,
    2,
  );
});
test("peek resolution handles removed items and keeps exact unavailable variants", () => {
  const products = [
    { id: "a", name: "A", variants: [{ id: "a-2", available: false }] },
  ];
  assert.equal(
    resolveLocation(
      { kind: "product", productId: "gone", variantId: "gone-1" },
      products,
    ).missing,
    true,
  );
  assert.equal(
    resolveLocation(
      { kind: "product", productId: "a", variantId: "a-2" },
      products,
    ).variant.available,
    false,
  );
  assert.equal(
    resolveLocation({ kind: "category", category: "Wear" }, products).category,
    "Wear",
  );
});
