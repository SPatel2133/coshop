import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { configuration } from "../server/config.js";
import { Rooms } from "../server/rooms.js";
import { migrate, nodeStore } from "../server/storage.js";
import { api, launch, socket } from "./support/rooms.mjs";

test("bag keeps historical items, flags missing prices, rolls back rejected edits and expires with the room", async (t) => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  t.after(() => db.close());
  const store = nodeStore(db);
  for (const [index, name] of [
    "rooms",
    "presence",
    "hold_ups",
    "shared_finds",
    "discussion",
  ].entries())
    migrate(
      store,
      await readFile(
        new URL(
          `../drizzle/room-object/000${index + 1}_${name}.sql`,
          import.meta.url,
        ),
        "utf8",
      ),
      index + 1,
    );
  let now = 1000000;
  const config = configuration({
    INVITE_SIGNING_SECRET: "test-only-key-for-phase-four-bag",
  });
  const rooms = new Rooms(store, config, () => now);
  const id = crypto.randomUUID();
  const maya = rooms.create(id, { name: "Maya", avatar: "sage" }, "maya");
  rooms.connect(id, "maya", "maya-connection");
  for (const [product, variant, quantity] of [
    ["shoe", "shoe-2", 2],
    ["old", "old-1", 1],
    ["audio", "audio-0", 99],
  ]) {
    store.run(
      "INSERT INTO bag_lines VALUES(?,?,?,?,?,?)",
      id,
      variant,
      product,
      quantity,
      maya.id,
      now,
    );
  }
  const before = rooms.snapshot(id).bag;
  assert.equal(before.unavailable, 2);
  assert.equal(
    before.items.find((item) => item.variantId === "old-1").cents,
    null,
  );
  assert.deepEqual(before.totals, [
    { currency: "CAD", cents: 99 * 14900 + 2 * 9500 },
  ]);
  const change = (action, variantId, payload = {}) =>
    rooms.shopCommand(id, "maya-connection", {
      type: "bag_change",
      requestId: crypto.randomUUID(),
      action,
      variantId,
      ...payload,
    });
  assert.equal(change("add", "audio-0").ack.code, "INVALID_BAG");
  assert.equal(change("add", "shoe-2").ack.code, "BAG_UNAVAILABLE");
  assert.equal(change("add", "made-up").ack.code, "BAG_UNAVAILABLE");
  assert.equal(
    change("remove", "shoe-2", { expectedQuantity: 1 }).ack.code,
    "BAG_CHANGED",
  );
  assert.deepEqual(rooms.snapshot(id).bag, before);
  assert.equal(store.all("SELECT * FROM events").length, 0);
  assert.equal(
    change("decrease", "shoe-2").ack.bag.items.find(
      (item) => item.variantId === "shoe-2",
    ).quantity,
    1,
  );
  assert.equal(
    change("remove", "shoe-2", { expectedQuantity: 1 }).ack.bag.unavailable,
    1,
  );
  assert.equal(
    change("remove", "old-1", { expectedQuantity: 1 }).ack.bag.unavailable,
    0,
  );
  const restored = new Rooms(store, config, () => now);
  assert.deepEqual(restored.snapshot(id).bag, rooms.snapshot(id).bag);
  now += config.ttl;
  assert.throws(() => restored.snapshot(id), { code: "ROOM_EXPIRED" });
  assert.equal(store.all("SELECT * FROM bag_lines").length, 0);
  assert.equal(store.all("SELECT * FROM events").length, 0);
});

for (const worker of [false, true])
  test(
    `${worker ? "Cloudflare" : "Node"}: simultaneous additions converge, replay never increments twice, and only the picker can remove`,
    { timeout: 60000 },
    async (t) => {
      const { base } = await launch(t, worker, {
        TEST_PORT: worker ? "14335" : "14334",
      });
      const maya = (
        await api(base, "/api/rooms", { name: "Maya", avatar: "sage" })
      ).data;
      const path = "/api/rooms/" + maya.invite;
      const sam = (
        await api(base, path + "/join", { name: "Sam", avatar: "rose" })
      ).data;
      const priya = (
        await api(base, path + "/join", { name: "Priya", avatar: "clay" })
      ).data;
      const shoppers = [maya, sam, priya];
      const clients = shoppers.map((shopper) =>
        socket(base, maya.invite, shopper.token),
      );
      t.after(() => clients.forEach((client) => client.ws.terminate()));
      await Promise.all(
        clients.map((client) =>
          client.wait(
            (message) =>
              message.type === "state" &&
              message.room.participants.every((person) => person.connected),
          ),
        ),
      );
      async function send(index, payload) {
        const { ws, messages, wait } = clients[index];
        const requestId = payload.requestId ?? crypto.randomUUID();
        const offset = messages.length;
        ws.send(JSON.stringify({ ...payload, requestId }));
        return wait(
          (message) =>
            message.type === "command_ack" &&
            message.requestId === requestId &&
            messages.indexOf(message) >= offset,
        );
      }
      const shared = await send(2, {
        type: "hold_up",
        productId: "audio",
        variantId: "audio-0",
      });
      assert.equal(shared.bag.totalQuantity, 0);
      const add = {
        type: "bag_change",
        action: "add",
        variantId: "audio-0",
        cents: 1,
        pickedBy: priya.me,
      };
      const firstId = crypto.randomUUID();
      const secondId = crypto.randomUUID();
      const results = await Promise.all([
        send(0, { ...add, requestId: firstId }),
        send(1, { ...add, requestId: secondId }),
      ]);
      assert.ok(results.every((result) => result.ok));
      const first = results[0].bag.totalQuantity === 1 ? 0 : 1;
      const final = results[1 - first].bag;
      assert.equal(final.items.length, 1);
      assert.equal(final.items[0].quantity, 2);
      assert.equal(final.items[0].pickedBy.id, shoppers[first].me);
      assert.equal(final.items[0].name, "Over-Ear Headphones");
      assert.deepEqual(final.totals, [{ currency: "CAD", cents: 29800 }]);
      for (const client of clients) {
        const update = await client.wait(
          (message) =>
            message.type === "bag_changed" &&
            message.bag.revision === final.revision,
        );
        assert.deepEqual(update.bag, final);
      }
      const rejected = await send(1 - first, {
        ...add,
        action: "remove",
        expectedQuantity: 2,
      });
      assert.equal(rejected.code, "BAG_PICKER_ONLY");
      assert.equal(
        (await send(1 - first, { ...add, action: "decrease" })).code,
        "BAG_PICKER_ONLY",
      );
      const decreased = await send(first, { ...add, action: "decrease" });
      assert.equal(decreased.bag.totalQuantity, 1);
      const stale = await send(first, {
        ...add,
        action: "remove",
        expectedQuantity: 2,
      });
      assert.equal(stale.code, "BAG_CHANGED");
      const repeated = await send(0, { ...add, requestId: firstId });
      assert.deepEqual(repeated.bag, decreased.bag);
      const conflict = await send(0, {
        ...add,
        variantId: "audio-1",
        requestId: firstId,
      });
      assert.equal(conflict.code, "INVALID_BAG");
      const refresh = socket(base, maya.invite, priya.token);
      t.after(() => refresh.ws.terminate());
      assert.deepEqual(
        (await refresh.wait((message) => message.type === "state")).room.bag,
        decreased.bag,
      );
      const removed = await send(first, {
        ...add,
        action: "remove",
        expectedQuantity: 1,
      });
      assert.equal(removed.bag.totalQuantity, 0);
      assert.deepEqual(
        (await api(base, path + "/session", {}, sam.token)).data.room.bag,
        removed.bag,
      );
    },
  );
