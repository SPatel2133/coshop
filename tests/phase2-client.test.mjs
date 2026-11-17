import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomConnection } from "../client/realtime.js";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test("client coalesces rapid navigation, authenticates outside the URL, and ignores a stale socket", async (t) => {
  const saved = new Map(),
    sockets = [];
  class FakeSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = String(url);
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
  }
  const values = {
    WebSocket: FakeSocket,
    // A phone's plain-HTTP LAN context has no crypto.randomUUID.
    crypto: {
      getRandomValues: globalThis.crypto.getRandomValues.bind(
        globalThis.crypto,
      ),
    },
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
  for (const [name, value] of Object.entries(values)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  }
  let connection;
  t.after(() => {
    connection?.stop();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  let states = 0;
  connection = new RoomConnection({
    invite: "signed-invite",
    token: "a".repeat(64),
    onState() {
      states++;
    },
    onStatus() {},
    onError(error) {
      throw Error(error.message);
    },
    checkSession: async () => ({}),
  });
  connection.connect();
  const first = sockets[0];
  first.onopen();
  assert.ok(!first.url.includes("a".repeat(64)));
  assert.deepEqual(first.sent[0], { type: "auth", token: "a".repeat(64) });
  first.onmessage({
    data: JSON.stringify({ type: "state", room: { participants: [] } }),
  });
  connection.setView({
    kind: "product",
    productId: "audio",
    variantId: "audio-0",
  });
  const initial = first.sent.find((m) => m.type === "view");
  assert.match(
    initial.requestId,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  first.onmessage({
    data: JSON.stringify({
      type: "view_ack",
      requestId: initial.requestId,
      accepted: true,
    }),
  });
  connection.setView({
    kind: "product",
    productId: "audio",
    variantId: "audio-1",
  });
  connection.setView({
    kind: "product",
    productId: "shoe",
    variantId: "shoe-1",
  });
  connection.setView({ kind: "category", category: "Home" });
  await delay(600);
  const views = first.sent.filter((m) => m.type === "view");
  assert.equal(views.length, 2);
  assert.deepEqual(views[1].view, { kind: "category", category: "Home" });
  connection.retry();
  assert.equal(sockets.length, 2);
  first.onmessage({
    data: JSON.stringify({ type: "state", room: { participants: [] } }),
  });
  assert.equal(states, 1);
  const second = sockets[1];
  connection.pageHide();
  assert.equal(second.readyState, 3);
  connection.pageShow({ persisted: true });
  assert.equal(sockets.length, 3);
});
