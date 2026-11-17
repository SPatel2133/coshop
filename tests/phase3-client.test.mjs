import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomConnection } from "../client/realtime.js";
test("shopping commands retain their id across reconnect and settle once; cooldown does not break the room", async (t) => {
  const originals = new Map(),
    sockets = [],
    shopping = [];
  class FakeSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
      this.sent = [];
      sockets.push(this);
    }
    send(message) {
      this.sent.push(JSON.parse(message));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    emit(message) {
      this.onmessage({ data: JSON.stringify(message) });
    }
  }
  const globals = {
    WebSocket: FakeSocket,
    location: { origin: "http://test.local", protocol: "http:" },
    navigator: { onLine: true },
    document: {
      hidden: false,
      addEventListener() {},
      removeEventListener() {},
    },
    addEventListener() {},
    removeEventListener() {},
  };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const connection = new RoomConnection({
    invite: "invite",
    token: "test",
    onState() {},
    onShopping: (m) => shopping.push(m),
    onStatus() {},
    onError: (e) => assert.fail(e.message),
    checkSession: async () => ({}),
  });
  t.after(() => {
    connection.stop();
    for (const [key, value] of originals) {
      if (value) Object.defineProperty(globalThis, key, value);
      else delete globalThis[key];
    }
  });
  await assert.rejects(connection.command("hold_up", {}), /Reconnect/);
  connection.connect();
  const first = sockets[0];
  first.onopen();
  first.emit({ type: "state", room: {} });
  const promise = connection.command("hold_up", {
    productId: "audio",
    variantId: "audio-0",
  });
  const sent = first.sent.find((m) => m.type === "hold_up");
  connection.retry();
  const second = sockets[1];
  second.onopen();
  second.emit({ type: "state", room: {} });
  assert.deepEqual(
    second.sent.find((m) => m.type === "hold_up"),
    sent,
  );
  first.emit({
    type: "command_ack",
    requestId: sent.requestId,
    ok: false,
    message: "stale",
  });
  second.emit({
    type: "command_ack",
    requestId: sent.requestId,
    ok: true,
    event: { id: sent.requestId },
  });
  assert.equal((await promise).event.id, sent.requestId);
  assert.equal(connection.commands.size, 0);
  second.emit({ type: "hold_up", event: { id: sent.requestId } });
  second.emit({ type: "reaction", event: { emoji: "❤️" } });
  assert.deepEqual(
    shopping.map((m) => m.type),
    ["hold_up", "reaction"],
  );
  const failed = connection.command("hold_up", {
    productId: "bag",
    variantId: "bag-0",
  });
  const next = second.sent.filter((m) => m.type === "hold_up").at(-1);
  second.emit({
    type: "command_ack",
    requestId: next.requestId,
    ok: false,
    code: "COOLDOWN",
    retryAfterMs: 1200,
    message: "Wait",
  });
  await assert.rejects(failed, { code: "COOLDOWN", retryAfterMs: 1200 });
  assert.equal(connection.ready, true);
  const stopped = connection.command("react", {
    holdUpId: sent.requestId,
    emoji: "❤️",
  });
  connection.stop();
  await assert.rejects(stopped, /ended/);
  assert.equal(connection.commands.size, 0);
});
