import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
const root = fileURLToPath(new URL("../", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function launch(t, worker, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), "coshop-phase1-")),
    port = Number(extra.TEST_PORT || (worker ? 14295 : 14294));
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    DATA_DIR: directory,
    INVITE_SIGNING_SECRET: "test-secret-not-for-production-0123456789",
    JOIN_LIMIT_PER_10_MIN: "500",
    CREATE_LIMIT_PER_HOUR: "100",
    WRANGLER_SEND_METRICS: "false",
    ...extra,
  };
  const bindings = [
    "INVITE_SIGNING_SECRET",
    "JOIN_LIMIT_PER_10_MIN",
    "CREATE_LIMIT_PER_HOUR",
    "ROOM_TTL_MS",
    "SEAT_RESERVATION_MS",
    "HEARTBEAT_INTERVAL_MS",
    "HEARTBEAT_TIMEOUT_MS",
  ]
    .filter((key) => env[key])
    .flatMap((key) => ["--var", key + ":" + env[key]]);
  const args = worker
    ? [
        "node_modules/wrangler/bin/wrangler.js",
        "dev",
        "--port",
        String(port),
        "--ip",
        "127.0.0.1",
        "--persist-to",
        directory,
        ...bindings,
      ]
    : ["server.mjs"];
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  t.after(async () => {
    child.kill();
    if (child.exitCode === null)
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        delay(2500),
      ]);
    assert.ok(directory.startsWith(join(tmpdir(), "coshop-phase1-")));
    try {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch {}
  });
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error("Server exited: " + output);
    try {
      if ((await fetch(base)).status === 200) return { base, child };
    } catch {}
    await delay(200);
  }
  throw new Error("Server did not start: " + output);
}

for (const worker of [false, true])
  test(
    (worker ? "Cloudflare" : "Node") +
      ": real inactivity expiration and released-seat readmission",
    { timeout: 60000 },
    async (t) => {
      const { base } = await launch(t, worker, {
        TEST_PORT: worker ? "14297" : "14296",
        ROOM_TTL_MS: "1800",
        SEAT_RESERVATION_MS: "250",
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
      await delay(400);
      const reclaimed = await api(base, path + "/session", {}, room.token);
      assert.equal(reclaimed.status, 200);
      assert.equal(reclaimed.data.me, room.me);
      assert.equal(reclaimed.data.room.participants.length, 1);
      // No join/activity occurs. Authentication/heartbeats must not extend expiry.
      await delay(1800);
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
async function api(base, path, body, token) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    data: await response.json(),
    headers: response.headers,
  };
}
function socket(base, invite, token) {
  const ws = new WebSocket(
    base.replace("http:", "ws:") + "/api/rooms/" + invite + "/socket",
    { origin: base },
  );
  const messages = [];
  ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  ws.on("error", () => {});
  const wait = async (predicate) => {
    for (let n = 0; n < 150; n++) {
      const found = messages.find(predicate);
      if (found) return found;
      await delay(20);
    }
    throw new Error("Missing websocket message: " + JSON.stringify(messages));
  };
  return { ws, messages, wait };
}
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
      for (let n = 0; n < 2; n++)
        assert.equal(
          (await api(base, path + "/join", { name: "Sam", avatar: "sky" }))
            .status,
          201,
        );
      // Five seats exist. Exactly one of these concurrent requests may commit.
      const race = await Promise.all([
        api(base, path + "/join", { name: "Race A", avatar: "rose" }),
        api(base, path + "/join", { name: "Race B", avatar: "butter" }),
      ]);
      assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
      const final = await api(base, path + "/session", {}, first.token);
      assert.equal(final.data.room.participants.length, 6);
      assert.equal(
        (await api(base, path + "/join", { name: "Seventh", avatar: "sky" }))
          .data.code,
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
