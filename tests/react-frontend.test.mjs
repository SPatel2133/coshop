import assert from "node:assert/strict";
import { test } from "node:test";
import { createBag } from "../react/bag-model.js";
import sampleGallery from "../react/sample-gallery.json" with { type: "json" };
import samplePhotos from "../sample-photos.json" with { type: "json" };
import { launch } from "./support/rooms.mjs";

for (const worker of [false, true]) {
  test(
    (worker ? "Cloudflare" : "Node") +
      " serves the production React shell at invite URLs",
    { timeout: 60000 },
    async (t) => {
      const { base } = await launch(t, worker, {
        TEST_PORT: worker ? "14347" : "14346",
      });
      const home = await fetch(base);
      const shell = await home.text();
      assert.match(shell, /id="root"/);
      const invite = await fetch(base + "/?room=fixture-example&guest=1");
      assert.equal(invite.status, 200);
      assert.equal(await invite.text(), shell);
      const js = shell.match(/<script[^>]+src="([^"]+)"/)?.[1];
      const css = shell.match(/<link[^>]+href="([^"]+\.css)"/)?.[1];
      assert.ok(js && css);
      const javascript = await fetch(base + js);
      assert.equal(javascript.status, 200);
      assert.match(javascript.headers.get("content-type"), /javascript/);
      assert.match(await javascript.text(), /Browse the collection/);
      const style = await fetch(base + css);
      assert.equal(style.status, 200);
      assert.match(style.headers.get("content-type"), /text\/css/);
      const font = (await style.text()).match(
        /url\((\/assets\/[^)]+\.woff2)\)/,
      )?.[1];
      assert.ok(font);
      assert.match(
        (await fetch(base + font)).headers.get("content-type"),
        /font\/woff2/,
      );
      const photoPaths = [
        ...samplePhotos.map((id) => "/assets/catalog-" + id + ".webp"),
        ...Object.values(sampleGallery).flat().map(({ src }) => src),
      ];
      const photos = await Promise.all(photoPaths.map((path) => fetch(base + path)));
      for (const photo of photos) {
        assert.equal(photo.status, 200);
        assert.equal(photo.headers.get("content-type"), "image/webp");
        assert.ok((await photo.arrayBuffer()).byteLength > 1000);
      }
      const missing = await fetch(base + "/api/not-a-route");
      assert.equal(missing.status, 404);
      assert.match(missing.headers.get("content-type"), /json/);
      assert.equal((await fetch(base + "/missing-coshop-page")).status, 404);
    },
  );
}

test("React bag model separates pending rows from accepted quantity and ignores replay", async () => {
  const item = {
    productId: "watch",
    variantId: "watch-1",
    name: "Wristwatch",
    variant: "Tan",
    quantity: 0,
    cents: 7900,
    currency: "CAD",
    available: true,
    pickedBy: { id: "maya", name: "Maya" },
  };
  let view;
  let operation;
  let complete;
  const model = createBag(
    (...args) => {
      operation = args;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    null,
    (next) => {
      view = next;
    },
    () => {},
  );
  model.snapshot(
    {
      id: "sample",
      catalogMode: "sample",
      bag: { revision: 0, items: [], totalQuantity: 0 },
    },
    "maya",
  );
  model.setConnected(true);
  const adding = model.change("add", item);
  assert.equal(view.items[0].quantity, 1);
  assert.equal(view.confirmed.totalQuantity, 0);
  assert.equal(view.cue, null);
  const accepted = {
    revision: 1,
    items: [{ ...item, quantity: 1 }],
    totalQuantity: 1,
  };
  const event = {
    action: "add",
    variantId: item.variantId,
    requestId: operation[2],
  };
  model.merge(accepted, event);
  assert.equal(view.items[0].quantity, 1);
  assert.equal(view.confirmed.totalQuantity, 1);
  const cue = view.cue;
  complete({ bag: accepted });
  await adding;
  model.merge(accepted, event);
  assert.equal(view.cue, cue);
  assert.equal(view.items[0].quantity, 1);
});

test("bag highlights only changed lines on resync and flags an interrupted change", async () => {
  const store = new Map();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
  });
  try {
    const line = (variantId, quantity, cents = 1000) => ({
      variantId, quantity, cents, available: true, pickedBy: { id: "me" },
    });
    const room = (revision, items) => ({
      id: "room", checkoutEnabled: false, checkout: null,
      bag: { revision, pricedAt: 1, items },
    });
    let view;
    const toasts = [];
    let send;
    const model = createBag(
      () => new Promise((resolve, reject) => (send = { resolve, reject })),
      null,
      (next) => (view = next),
      (message) => toasts.push(message),
    );
    model.highlightMs = 20;
    model.setConnected(true);
    model.snapshot(room(1, [line("a", 3), line("b", 1)]), "me");
    assert.equal(view.changed, null);

    model.snapshot(room(1, [line("a", 3), line("b", 1)]), "me");
    assert.equal(view.changed, null, "an unchanged reconnect does not highlight");

    model.snapshot(room(2, [line("a", 4), line("b", 1, 1200)]), "me");
    assert.deepEqual([...view.changed.variantIds].sort(), ["a", "b"]);
    assert.equal(view.feedback, "Bag refreshed · 2 lines changed.");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(view.changed, null, "the highlight clears");

    model.snapshot(room(3, [line("a", 4)]), "me");
    assert.equal(view.changed, null);
    assert.equal(view.feedback, "Bag refreshed · 1 removed.");

    model.change("add", { ...line("a", 4), name: "Cap", variant: "Black" });
    const key = "coshop:bag-pending:room:me";
    const marker = JSON.parse(store.get(key));
    assert.deepEqual(Object.keys(marker), ["a"]);
    assert.match(marker.a, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(store.get(key), /Cap|Black|token|invite/);

    const reloaded = createBag(() => new Promise(() => {}), null, (next) => (view = next), (m) => toasts.push(m));
    reloaded.setConnected(true);
    reloaded.snapshot(room(3, [line("a", 4)]), "me");
    assert.equal(view.feedback, "Review your bag; an update was interrupted.");
    assert.equal(toasts.at(-1), "Review your bag; an update was interrupted.");
    assert.equal(store.has(key), false, "the marker clears after the authoritative snapshot");

    send.resolve({ bag: { revision: 4, pricedAt: 1, items: [line("a", 5)] } });
    await new Promise((resolve) => setTimeout(resolve));
    assert.equal(view.changed, null, "an own acknowledgement does not highlight");
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, "sessionStorage", previousStorage);
    else delete globalThis.sessionStorage;
  }
});
