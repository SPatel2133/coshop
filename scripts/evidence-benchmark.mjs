import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { FindsState } from "../client/hold-ups.js";
import { roomRequest as api } from "./evidence-runtime.mjs";

const warmups = 3;
const samples = 20;
const timeoutMs = 2000;
const variants = ["audio-0", "audio-1"];
const order = (finds) => finds.map(({ variantId }) => variantId);

function shopper(base, invite, token) {
  const finds = new FindsState();
  const ws = new WebSocket(base.replace("http:", "ws:") + "/api/rooms/" + invite + "/socket", { origin: base });
  const send = (command) => ws.send(JSON.stringify(command));
  ws.on("open", () => send({ type: "auth", token }));
  ws.on("error", () => {});
  function wait(predicate) {
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        ws.off("message", receive);
        ws.off("close", closed);
      };
      const closed = () => {
        finish();
        reject(new Error("socket-closed"));
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error("timeout"));
      }, timeoutMs);
      const receive = (raw) => {
        try {
          const message = JSON.parse(raw);
          if (!predicate(message)) return;
          finish();
          resolve(message);
        } catch (error) {
          finish();
          reject(error);
        }
      };
      ws.on("message", receive);
      ws.once("close", closed);
    });
  }
  return { ws, sends: send, finds, wait };
}

function share(variantId) {
  return { type: "hold_up", requestId: crypto.randomUUID(), productId: "audio", variantId };
}

async function trial(base) {
  const create = await api(base, "/api/rooms", { name: "Sam", avatar: "sage" });
  assert.equal(create.status, 201, "create");
  const room = create.data;
  const path = "/api/rooms/" + room.invite;
  const joined = await Promise.all(["Maya", "Priya"].map((name) =>
    api(base, path + "/join", { name, avatar: "rose" })));
  for (const result of joined) assert.equal(result.status, 201, "join");
  const identities = [room, ...joined.map(({ data }) => data)];
  const clients = identities.map(({ token }) => shopper(base, room.invite, token));
  try {
    const baseline = await Promise.all(clients.map((client) =>
      client.wait(({ type, room }) =>
        type === "state" && room.participants.filter((entry) => entry.connected).length === 3)));
    for (const { room } of baseline) {
      assert.equal(room.finds.length, 0, "empty-finds-baseline");
      assert.equal(room.bag.totalQuantity, 0, "empty-bag-baseline");
    }

    const commands = variants.map(share);
    const acks = Promise.all(commands.map(async (command, i) => {
      const ack = await clients[i].wait((event) =>
        event.type === "command_ack" && event.requestId === command.requestId);
      if (!ack.ok) throw Object.assign(new Error("share-rejected"), { code: ack.code });
      return ack;
    }));
    const observations = Promise.all(clients.map(async (client) => {
      const received = new Set();
      await client.wait((event) => {
        if (event.type !== "hold_up" || !commands.some((cmd) => cmd.requestId === event.event.id))
          return false;
        received.add(event.event.id);
        client.finds.merge(event.find);
        return received.size === 2;
      });
      return { end: performance.now(), found: order(client.finds.ordered()) };
    }));
    const started = performance.now();
    commands.forEach((command, i) => clients[i].sends(command));
    const [observed, acknowledged] = await Promise.all([observations, acks]);
    const elapsed = Math.max(...observed.map(({ end }) => end)) - started;
    const expected = order(acknowledged.map(({ find }) => find).sort((a, b) => b.sequence - a.sequence));
    assert.deepEqual([...expected].sort(), variants, "exact-variants");
    for (const result of observed) assert.deepEqual(result.found, expected, "client-order");

    const repeated = share(variants[0]);
    const repeats = Promise.all(clients.map((client) =>
      client.wait((event) => {
        if (event.type !== "hold_up" || event.event.id !== repeated.requestId) return false;
        client.finds.merge(event.find);
        assert.equal(event.event.repeated, true, "repeat-event");
        assert.equal(event.find.sharedBy.id, identities[0].me, "first-sharer");
        return true;
      })));
    clients[2].sends(repeated);
    await repeats;
    for (const client of clients) assert.deepEqual(order(client.finds.ordered()), expected, "repeat-dedup");
    const snapshot = await api(base, path + "/session", {}, room.token);
    assert.equal(snapshot.status, 200, "snapshot");
    assert.deepEqual(order(snapshot.data.room.finds), expected, "persisted-order");
    const bag = snapshot.data.room.bag;
    assert.equal(bag.items.length, 0, "unchanged-bag-items");
    assert.equal(bag.totalQuantity, 0, "unchanged-bag-quantity");
    assert.equal(bag.revision, 0, "unchanged-bag-revision");
    return elapsed;
  } finally {
    for (const client of clients) client.ws.terminate();
  }
}

function nearestRank(sorted, fraction) {
  return sorted.at(Math.ceil(sorted.length * fraction) - 1) ?? null;
}

export async function benchmark(base) {
  const trials = [];
  for (let i = 0; i < warmups + samples; i++) {
    const phase = i < warmups ? "warmup" : "measured";
    const number = i < warmups ? i + 1 : i - warmups + 1;
    try {
      const milliseconds = await trial(base);
      trials.push({ phase, number, status: "pass", milliseconds });
    } catch (error) {
      const status = error.name === "TimeoutError" ? "timeout"
        : ["timeout", "socket-closed"].includes(error.message) ? error.message : "failure";
      trials.push({ phase, number, status, code: error.code || null });
    }
  }
  const measured = trials.filter(({ phase, status }) => phase === "measured" && status === "pass")
    .map(({ milliseconds }) => milliseconds).sort((a, b) => a - b);
  return {
    passed: trials.every(({ status }) => status === "pass"),
    warmups, samples, socketsPerRoom: 3, concurrentShares: 2, timeoutMs,
    measurement: "performance.now(), before pair send through last client's second merged event",
    successfulMeasured: measured.length,
    p50Ms: nearestRank(measured, 0.5),
    p95Ms: nearestRank(measured, 0.95),
    trials,
  };
}
