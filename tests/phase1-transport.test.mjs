import { test } from "node:test";
import assert from "node:assert/strict";
import { launch, api, socket, delay } from "./support/rooms.mjs";
for (const worker of [false, true])
  test(
    (worker ? "Cloudflare" : "Node") +
      ": real inactivity expiration and released-seat readmission",
    { timeout: 60000 },
    async (t) => {
      const { base } = await launch(t, worker, {
        TEST_PORT: worker ? "14297" : "14296",
        ROOM_TTL_MS: "3000",
        SEAT_RESERVATION_MS: "900",
        HEARTBEAT_INTERVAL_MS: "100",
        HEARTBEAT_TIMEOUT_MS: "400",
      });
      const result = await api(base, "/api/rooms", {
          name: "Maya",
          avatar: "sage",
        }),
        room = result.data;
      const path = "/api/rooms/" + room.invite;
      const original = socket(base, room.invite, room.token);
      t.after(() => original.ws.terminate());
      await original.wait((m) => m.type === "state");
      original.ws.close();
      await delay(1050);
      for (let n = 0; n < 10; n++)
        assert.equal(
          (await api(base, path + "/join", { name: "Friend", avatar: "sage" }))
            .status,
          201,
        );
      const blocked = await api(base, path + "/session", {}, room.token);
      assert.equal(blocked.status, 409);
      assert.equal(blocked.data.code, "ROOM_FULL");
      await delay(1050);
      const reclaimed = await api(base, path + "/session", {}, room.token);
      assert.equal(reclaimed.status, 200);
      assert.equal(reclaimed.data.me, room.me);
      assert.equal(reclaimed.data.room.participants.length, 1);
      // No join/activity occurs. Authentication/heartbeats must not extend expiry.
      await delay(3000);
      const expired = await api(base, path + "/session", {}, room.token);
      assert.equal(expired.status, 410);
      assert.equal(expired.data.code, "ROOM_EXPIRED");
      assert.equal((await api(base, path)).data.code, "ROOM_EXPIRED");
      assert.equal(
        (await api(base, path + "/join", { name: "Late", avatar: "rose" })).data
          .code,
        "ROOM_EXPIRED",
      );
    },
  );
for (const worker of [false, true])
  test(
    (worker ? "Cloudflare Durable Objects" : "Node") +
      ": HTTP + WebSocket rooms, simultaneous admission, reconnect and security",
    { timeout: 80000 },
    async (t) => {
      const { base } = await launch(t, worker);
      const created = await api(base, "/api/rooms", {
        name: "Maya",
        avatar: "sage",
        roomName: "Whatever catches our eye",
      });
      assert.equal(created.status, 201);
      const first = created.data,
        path = "/api/rooms/" + first.invite;
      assert.match(first.token, /^[a-f0-9]{64}$/);
      assert.ok(!first.invite.includes(first.token));
      const s1 = socket(base, first.invite, first.token);
      t.after(() => s1.ws.terminate());
      const connected = await s1.wait(
        (m) => m.type === "state" && m.room.participants[0].connected,
      );
      assert.equal(connected.me, first.me);
      assert.ok(!JSON.stringify(connected).includes(first.token));
      const second = await api(base, path + "/join", {
        name: "maya",
        avatar: "clay",
      });
      assert.equal(second.status, 201);
      assert.equal(
        second.data.room.participants.find((p) => p.id === second.data.me).name,
        "maya 2",
      );
      await s1.wait(
        (m) => m.type === "state" && m.room.participants.length === 2,
      );
      const s2 = socket(base, first.invite, second.data.token);
      t.after(() => s2.ws.terminate());
      await s2.wait(
        (m) =>
          m.type === "state" &&
          m.room.participants.filter((p) => p.connected).length === 2,
      );
      const third = await api(base, path + "/join", {
        name: "Priya",
        avatar: "lilac",
      });
      const s3 = socket(base, first.invite, third.data.token);
      t.after(() => s3.ws.terminate());
      await s3.wait(
        (m) =>
          m.type === "state" &&
          m.room.participants.filter((p) => p.connected).length === 3,
      );
      await s1.wait(
        (m) =>
          m.type === "state" &&
          m.room.participants.filter((p) => p.connected).length === 3,
      );
      s2.ws.close();
      await s1.wait(
        (m) =>
          m.type === "state" &&
          m.room.participants.find((p) => p.id === second.data.me)
            ?.connected === false,
      );
      const rejoin = await api(base, path + "/session", {}, second.data.token);
      assert.equal(rejoin.status, 200);
      assert.equal(rejoin.data.me, second.data.me);
      assert.equal(rejoin.data.room.participants.length, 3);
      const reconnected = socket(base, first.invite, second.data.token);
      t.after(() => reconnected.ws.terminate());
      const resynced = await reconnected.wait(
        (m) =>
          m.type === "state" &&
          m.room.participants.filter((p) => p.connected).length === 3,
      );
      assert.equal(resynced.room.name, "Whatever catches our eye");
      assert.equal(resynced.me, second.data.me);
      reconnected.ws.send(JSON.stringify({ type: "heartbeat" }));
      await reconnected.wait((m) => m.type === "pong");
      const invalid = await api(base, path + "/session", {}, "a".repeat(64));
      assert.equal(invalid.status, 401);
      assert.equal(invalid.data.code, "INVALID_SESSION");
      const badSocket = socket(base, first.invite, "b".repeat(64));
      t.after(() => badSocket.ws.terminate());
      await badSocket.wait((m) => m.code === "INVALID_SESSION");
      assert.equal(
        badSocket.messages.some((m) => m.type === "state"),
        false,
      );
      for (let n = 0; n < 6; n++)
        assert.equal(
          (await api(base, path + "/join", { name: "Sam", avatar: "sky" }))
            .status,
          201,
        );
      assert.deepEqual((await api(base, path)).data, {
        name: "Whatever catches our eye",
        full: false,
        capacity: 10,
      });
      const race = await Promise.all([
        api(base, path + "/join", { name: "Race A", avatar: "rose" }),
        api(base, path + "/join", { name: "Race B", avatar: "butter" }),
      ]);
      assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
      assert.equal(
        race.find((result) => result.status === 409).data.code,
        "ROOM_FULL",
      );
      const final = await api(base, path + "/session", {}, first.token);
      assert.equal(final.data.room.capacity, 10);
      assert.equal(final.data.room.participants.length, 10);
      assert.equal((await api(base, path)).data.full, true);
      reconnected.ws.close();
      await s1.wait(
        (m) =>
          m.type === "state" &&
          m.room.participants.length === 10 &&
          m.room.participants.some(
            (p) => p.id === second.data.me && !p.connected,
          ),
      );
      const fullRejoin = socket(base, first.invite, second.data.token);
      t.after(() => fullRejoin.ws.terminate());
      const fullState = await fullRejoin.wait((m) => m.type === "state");
      assert.equal(fullState.me, second.data.me);
      assert.equal(fullState.room.participants.length, 10);
      assert.equal(
        (await api(base, path + "/join", { name: "Extra", avatar: "sky" })).data
          .code,
        "ROOM_FULL",
      );
      assert.equal(
        (await api(base, "/api/rooms/invalid")).data.code,
        "INVALID_LINK",
      );
      const unsafe = await api(base, "/api/rooms", {
        name: "<script>",
        avatar: "sage",
      });
      assert.equal(unsafe.data.code, "INVALID_NAME");
      const foreign = await fetch(base + "/api/rooms", {
        method: "POST",
        headers: {
          Origin: "https://other.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      assert.equal(foreign.status, 403);
      const large = await fetch(base + "/api/rooms", {
        method: "POST",
        body: "x".repeat(5000),
      });
      assert.equal(large.status, 413);
    },
  );
