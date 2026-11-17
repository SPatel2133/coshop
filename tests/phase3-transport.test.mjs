import { test } from "node:test";
import assert from "node:assert/strict";
import { launch, api, socket, delay } from "./support/rooms.mjs";

for (const worker of [false, true])
  test(
    (worker ? "Cloudflare" : "Node") +
      ": concurrent finds have one order, one bag line, live reactions and reconnect recovery",
    { timeout: 60000 },
    async (t) => {
      const { base } = await launch(t, worker, {
        TEST_PORT: worker ? "14315" : "14314",
      });
      const maya = (
        await api(base, "/api/rooms", { name: "Maya", avatar: "sage" })
      ).data;
      const path = "/api/rooms/" + maya.invite;
      const sam = (
        await api(base, path + "/join", { name: "Sam", avatar: "clay" })
      ).data;
      const priya = (
        await api(base, path + "/join", { name: "Priya", avatar: "lilac" })
      ).data;
      const clients = [maya, sam, priya].map((p) =>
        socket(base, maya.invite, p.token),
      );
      t.after(() => clients.forEach((c) => c.ws.terminate()));
      await Promise.all(
        clients.map((c) =>
          c.wait(
            (m) =>
              m.type === "state" &&
              m.room.participants.filter((p) => p.connected).length === 3,
          ),
        ),
      );
      const messages = [0, 1, 2].map((n) => ({
        type: "hold_up",
        requestId: crypto.randomUUID(),
        productId: n === 2 ? "bag" : "audio",
        variantId: n === 2 ? "bag-0" : "audio-1",
      }));
      const before = Date.now();
      clients.forEach((c, n) => c.ws.send(JSON.stringify(messages[n])));
      await Promise.all(
        clients.flatMap((c) =>
          messages.map((command) =>
            c.wait(
              (m) => m.type === "hold_up" && m.event.id === command.requestId,
            ),
          ),
        ),
      );
      assert.ok(
        Date.now() - before < 1000,
        "local propagation within one second",
      );
      const order = clients[0].messages
        .filter((m) => m.type === "hold_up")
        .map((m) => m.event.id);
      for (const c of clients)
        assert.deepEqual(
          c.messages.filter((m) => m.type === "hold_up").map((m) => m.event.id),
          order,
        );
      const snapshot = (await api(base, path + "/session", {}, maya.token)).data
        .room;
      assert.equal(snapshot.bag.items.length, 2);
      assert.equal(snapshot.bag.totalQuantity, 2);
      const original = snapshot.bag.items.find((l) => l.productId === "audio")
        .pickedBy.id;
      const audioEvents = snapshot.holdUps.filter(
        (e) => e.productId === "audio",
      );
      assert.equal(audioEvents[0].repeated, false);
      assert.equal(audioEvents[1].repeated, true);
      assert.equal(audioEvents[1].pickedBy.id, original);
      // Replay a committed command: no additional popup or bag change.
      clients[0].ws.send(JSON.stringify(messages[0]));
      await delay(80);
      assert.equal(
        clients[2].messages.filter((m) => m.type === "hold_up").length,
        3,
      );
      const tooSoon = { ...messages[0], requestId: crypto.randomUUID() };
      clients[0].ws.send(JSON.stringify(tooSoon));
      const rejected = await clients[0].wait(
        (m) => m.type === "command_ack" && m.requestId === tooSoon.requestId,
      );
      assert.equal(rejected.code, "COOLDOWN");
      assert.equal(clients[0].ws.readyState, 1);
      const reaction = {
        type: "react",
        requestId: crypto.randomUUID(),
        holdUpId: order[0],
        emoji: "🤔",
      };
      clients[1].ws.send(JSON.stringify(reaction));
      const floated = await clients[2].wait(
        (m) => m.type === "reaction" && m.event.id === reaction.requestId,
      );
      assert.equal(floated.event.by.id, sam.me);
      assert.equal("counts" in floated, false);
      clients[2].ws.terminate();
      await delay(100);
      const recovered = socket(base, maya.invite, priya.token);
      clients.push(recovered);
      const resync = await recovered.wait(
        (m) => m.type === "state" && m.me === priya.me,
      );
      assert.equal(resync.room.bag.totalQuantity, 2);
      assert.deepEqual(
        resync.room.holdUps.map((e) => e.id),
        order,
      );
      await delay(Math.max(0, before + 3100 - Date.now()));
      const repeat = { ...messages[0], requestId: crypto.randomUUID() };
      clients[0].ws.send(JSON.stringify(repeat));
      const again = await recovered.wait(
        (m) => m.type === "hold_up" && m.event.id === repeat.requestId,
      );
      assert.equal(again.event.repeated, true);
      assert.equal(again.event.pickedBy.id, original);
      assert.equal(again.bag.totalQuantity, 2);
    },
  );
