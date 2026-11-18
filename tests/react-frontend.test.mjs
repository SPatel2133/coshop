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
