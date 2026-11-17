import { test } from "node:test";
import assert from "node:assert/strict";
import { launch, api, socket, delay } from "./support/rooms.mjs";
for (const worker of [false, true])
  test(
    (worker ? "Cloudflare" : "Node") +
      ": three shoppers receive ordered location deltas, away changes and a complete reconnect snapshot",
    { timeout: 60000 },
    async (t) => {
      const { base } = await launch(t, worker, {
        TEST_PORT: worker ? "14305" : "14304",
        PRESENCE_IDLE_MS: "1400",
      });
      const room = (
        await api(base, "/api/rooms", { name: "Maya", avatar: "sage" })
      ).data;
      const path = "/api/rooms/" + room.invite;
      const sam = (
        await api(base, path + "/join", { name: "Sam", avatar: "clay" })
      ).data;
      const priya = (
        await api(base, path + "/join", { name: "Priya", avatar: "lilac" })
      ).data;
      const a = socket(base, room.invite, room.token),
        b = socket(base, room.invite, sam.token),
        c = socket(base, room.invite, priya.token);
      for (const client of [a, b, c]) t.after(() => client.ws.terminate());
      await a.wait(
        (m) =>
          m.type === "state" &&
          m.room.participants.filter((p) => p.connected).length === 3,
      );
      await b.wait((m) => m.type === "state");
      await c.wait((m) => m.type === "state");
      async function publish(client, view) {
        const requestId = crypto.randomUUID();
        client.ws.send(JSON.stringify({ type: "view", requestId, view }));
        const ack = await client.wait(
          (m) => m.type === "view_ack" && m.requestId === requestId,
        );
        assert.equal(ack.accepted, true);
        return requestId;
      }
      const before = Date.now();
      const firstId = await publish(a, {
        kind: "product",
        productId: "audio",
        variantId: "audio-1",
      });
      const received = await c.wait(
        (m) => m.type === "presence" && m.participant.view?.eventId === firstId,
      );
      assert.ok(
        Date.now() - before < 1000,
        "location propagation should fit the one-second target locally",
      );
      assert.equal(received.participant.id, room.me);
      assert.equal(received.participant.view.variantId, "audio-1");
      assert.ok(JSON.stringify(received).length < 1000);
      assert.ok(!("room" in received));
      await publish(b, {
        kind: "product",
        productId: "watch",
        variantId: "watch-0",
      });
      await publish(c, { kind: "category", category: "Wear" });
      const current = (await api(base, path + "/session", {}, room.token)).data
        .room;
      assert.equal(
        current.participants.find((p) => p.id === sam.me).view.productId,
        "watch",
      );
      assert.equal(
        current.participants.find((p) => p.id === priya.me).view.category,
        "Wear",
      );
      // Sending a second view immediately gets a nonfatal acknowledgement. It does
      // not disconnect the shopper or overwrite a newer accepted location.
      const tooSoon = crypto.randomUUID();
      c.ws.send(
        JSON.stringify({
          type: "view",
          requestId: tooSoon,
          view: { kind: "category", category: "Home" },
        }),
      );
      const throttle = await c.wait(
        (m) => m.type === "view_ack" && m.requestId === tooSoon,
      );
      assert.equal(throttle.accepted, false);
      assert.ok(throttle.retryAfterMs > 0);
      await delay(throttle.retryAfterMs + 30);
      const nextId = await publish(c, { kind: "category", category: "Home" });
      await b.wait(
        (m) => m.type === "presence" && m.participant.view?.eventId === nextId,
      );
      // A per-connection heartbeat does not prevent the 1.4s test idle transition.
      a.ws.send(JSON.stringify({ type: "heartbeat" }));
      await a.wait((m) => m.type === "pong");
      const idle = await b.wait(
        (m) =>
          m.type === "presence" &&
          m.participant.id === room.me &&
          m.participant.away,
      );
      assert.equal(idle.participant.view.productId, "audio");
      const oldLength = b.messages.length;
      a.ws.send(JSON.stringify({ type: "activity" }));
      for (
        let n = 0;
        n < 100 &&
        !b.messages
          .slice(oldLength)
          .some(
            (m) =>
              m.type === "presence" &&
              m.participant.id === room.me &&
              !m.participant.away,
          );
        n++
      )
        await delay(20);
      assert.ok(
        b.messages
          .slice(oldLength)
          .some(
            (m) =>
              m.type === "presence" &&
              m.participant.id === room.me &&
              !m.participant.away,
          ),
      );
      b.ws.close();
      await a.wait(
        (m) =>
          m.type === "state" &&
          m.room.participants.find((p) => p.id === sam.me)?.connected === false,
      );
      const restored = socket(base, room.invite, sam.token);
      t.after(() => restored.ws.terminate());
      const full = await restored.wait(
        (m) => m.type === "state" && m.me === sam.me,
      );
      assert.equal(
        full.room.participants.find((p) => p.id === sam.me).view.variantId,
        "watch-0",
      );
      assert.equal(
        full.room.participants.find((p) => p.id === room.me).view.variantId,
        "audio-1",
      );
      assert.equal(
        full.room.participants.find((p) => p.id === priya.me).view.category,
        "Home",
      );
      const invalidId = crypto.randomUUID();
      restored.ws.send(
        JSON.stringify({
          type: "view",
          requestId: invalidId,
          view: { kind: "product", productId: "missing", variantId: "nope" },
        }),
      );
      await restored.wait(
        (m) => m.type === "error" && m.code === "INVALID_VIEW",
      );
      restored.ws.send(JSON.stringify({ type: "heartbeat" }));
      await restored.wait((m) => m.type === "pong");
    },
  );
