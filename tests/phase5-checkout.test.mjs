import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { Rooms, roomHttp } from "../server/rooms.js";
import { Storefront } from "../server/storefront.js";
import { ShopifyClient } from "../shopify.mjs";
import { migrate, nodeStore } from "../server/storage.js";
import { configuration } from "../server/config.js";
import { catalog } from "../catalog.mjs";
import { digest } from "../server/security.js";
import { readPaidWebhook } from "../server/order-webhook.js";
import { createHmac } from "node:crypto";

const variantId = "gid://shopify/ProductVariant/42";
const productId = "gid://shopify/Product/24";
const price = (amount) => ({ amount, currencyCode: "CAD" });
function fixture() {
  const state = {
    amount: "25.00",
    available: true,
    warnings: [],
    calls: [],
    cartQuantity: 1,
  };
  const client = new ShopifyClient(
    "example.myshopify.com",
    "public-token-for-test",
    {
      apiVersion: "2026-10",
      country: "CA",
      fetcher: async (_, request) => {
        const { query, variables } = JSON.parse(request.body);
        state.calls.push({ query, variables });
        const variant = {
          id: variantId,
          title: "Forest",
          availableForSale: state.available,
          price: price(state.amount),
        };
        const data = query.includes("CoshopProducts")
          ? {
              shop: {
                name: "Example",
                primaryDomain: { host: "checkout.example.com" },
              },
              products: {
                nodes: [
                  {
                    id: productId,
                    title: "Jacket",
                    description: "A jacket.",
                    productType: "Wear",
                    variants: {
                      nodes: [variant],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                ],
              },
            }
          : query.includes("CoshopVariants")
            ? { nodes: [state.missing ? null : variant] }
            : {
                cartCreate: {
                  warnings: state.warnings,
                  userErrors: [],
                  cart: {
                    id: "gid://shopify/Cart/test-cart?key=server-only-key",
                    checkoutUrl:
                      state.url ??
                      "https://checkout.example.com/checkouts/test",
                    lines: {
                      nodes: [
                        {
                          quantity: state.cartQuantity,
                          merchandise: { id: variantId },
                        },
                      ],
                    },
                    cost: {
                      subtotalAmount: price(state.cartAmount ?? state.amount),
                    },
                  },
                },
              };
        return Response.json({ data });
      },
    },
  );
  return { state, client };
}
const names = [
  "rooms",
  "presence",
  "hold_ups",
  "shared_finds",
  "discussion",
  "storefront",
  "haul",
  "checkout_resume",
];
async function setup(t, haul = false) {
  let now = 100000;
  const clock = () => now;
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  t.after(() => db.close());
  const store = nodeStore(db);
  for (const [index, name] of names.entries())
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
  const { client, state } = fixture();
  const provider = new Storefront({}, clock, client);
  const config = configuration({
    INVITE_SIGNING_SECRET: "phase-five-only-test-signing-secret",
  });
  const rooms = new Rooms(store, config, clock, catalog, provider, haul);
  const legacy = crypto.randomUUID();
  rooms.create(legacy, { name: "Legacy", avatar: "sage" }, "legacy");
  const room = crypto.randomUUID();
  const token = "a".repeat(64);
  const maya = rooms.create(
    room,
    { name: "Maya", avatar: "sage" },
    await digest(token),
    await provider.load(),
  );
  const sam = rooms.join(room, { name: "Sam", avatar: "clay" }, "sam");
  rooms.connect(room, await digest(token), "maya-socket");
  rooms.connect(room, "sam", "sam-socket");
  const command = (type, options, shopper = "maya") =>
    rooms.shopCommand(room, shopper + "-socket", {
      type,
      requestId: crypto.randomUUID(),
      ...options,
    });
  const bag = () => rooms.snapshot(room).bag;
  const input = () => ({
    id: crypto.randomUUID(),
    revision: bag().revision,
    pricedAt: bag().pricedAt,
  });
  return {
    rooms,
    room,
    legacy,
    maya,
    sam,
    token,
    state,
    provider,
    config,
    command,
    bag,
    input,
    tick: (duration) => (now += duration),
  };
}

test("paid recap follows the verified order, not the unlocked bag or abandoned checkout", async (t) => {
  const { rooms, room, maya, state, command, bag, input } = await setup(
    t,
    true,
  );
  command("bag_change", { action: "add", variantId });
  command("hold_up", { variantId, productId });
  const proposal = input();
  await rooms.checkout.start(room, maya, proposal, () => {});
  assert.deepEqual(state.calls.at(-1).variables.input.attributes, [
    { key: "_coshop_haul", value: room + "." + proposal.id },
  ]);
  rooms.checkout.release(room, maya.id, proposal.id);
  command("bag_change", { action: "add", variantId });
  assert.equal(rooms.snapshot(room).recap, null);
  const config = {
    shopify: {
      domain: "example.myshopify.com",
      webhookSecret: "test-only-webhook-secret",
    },
  };
  const event = {
    admin_graphql_api_id: "gid://shopify/Order/100",
    financial_status: "paid",
    cart_token: "test-cart",
    note_attributes: [
      { name: "_coshop_haul", value: room + "." + proposal.id },
    ],
    total_price_set: {
      presentment_money: { amount: "27.50", currency_code: "CAD" },
    },
    line_items: [
      { variant_id: 42, title: "Jacket", variant_title: "Forest", quantity: 1 },
    ],
    email: "discard@example.com",
  };
  const deliver = (payload, signature, shop = config.shopify.domain) => {
    const body = JSON.stringify(payload);
    return readPaidWebhook(
      new Request("http://localhost/api/shopify/orders-paid", {
        method: "POST",
        body,
        headers: {
          "x-shopify-shop-domain": shop,
          "x-shopify-topic": "orders/paid",
          "x-shopify-hmac-sha256":
            signature ??
            createHmac("sha256", config.shopify.webhookSecret)
              .update(body)
              .digest("base64"),
        },
      }),
      config,
    );
  };
  await assert.rejects(deliver(event, "A".repeat(43) + "="), {
    code: "WEBHOOK_SIGNATURE",
  });
  await assert.rejects(deliver(event, undefined, "wrong.myshopify.com"), {
    code: "WEBHOOK_SIGNATURE",
  });
  assert.deepEqual(await deliver({ ...event, financial_status: "pending" }), {
    order: null,
    outcome: "not_paid",
  });
  assert.equal(
    await rooms.haul.paid(
      (await deliver({ ...event, cart_token: "another-cart" })).order,
    ),
    "cart_mismatch",
  );
  const { order: verified } = await deliver(event);
  assert.equal(await rooms.haul.paid(verified), "recorded");
  assert.equal(await rooms.haul.paid(verified), "duplicate");
  const { recap } = rooms.snapshot(room);
  assert.equal(recap.mode, "paid");
  assert.equal(recap.items[0].pickedBy.name, "Maya");
  assert.equal(recap.totalQuantity, 1);
  assert.equal(recap.highlights[0].count, 1);
  assert.deepEqual(recap.totals, [{ cents: 2750, currency: "CAD" }]);
  assert.equal(bag().totalQuantity, 2);
  assert.ok(!JSON.stringify(recap).includes("discard@example.com"));
  assert.throws(() => rooms.haul.demo(room, proposal), { code: "DEMO_ONLY" });
});

test("room creation defaults to sample and only an explicit Shopify choice loads live products", async (t) => {
  const { rooms, provider, config, state } = await setup(t);
  provider.saved = null;
  const create = (catalogMode) =>
    roomHttp(
      rooms,
      crypto.randomUUID(),
      "create",
      new Request("http://local/api/rooms", {
        method: "POST",
        body: JSON.stringify({ name: "Maya", avatar: "sage", catalogMode }),
      }),
      config,
    );
  assert.equal((await (await create()).json()).room.catalogMode, "sample");
  assert.equal(
    (await (await create("sample")).json()).room.checkoutEnabled,
    false,
  );
  assert.equal(state.calls.length, 1);
  assert.equal(
    (await (await create("shopify")).json()).room.checkoutEnabled,
    true,
  );
  assert.equal(state.calls.length, 2);
  provider.client = null;
  await assert.rejects(create("shopify"), { code: "SHOPIFY_UNAVAILABLE" });
  await assert.rejects(create("unknown"), { code: "INVALID_CATALOG" });
});

test("Shopify room catalog is scoped and cached; shared finds and sample rooms retain their own catalog", async (t) => {
  const { rooms, room, legacy, token, config, provider, state, command, tick } =
    await setup(t);
  assert.equal(rooms.snapshot(legacy).catalogMode, "sample");
  assert.equal(rooms.snapshot(room).catalogMode, "shopify");
  const request = new Request("http://local/catalog", {
    headers: { Authorization: "Bearer " + token },
  });
  const catalog = await (
    await roomHttp(rooms, room, "catalog", request, config)
  ).json();
  assert.equal(catalog.products[0].variants[0].cents, 2500);
  assert.equal(catalog.country, "CA");
  await assert.rejects(
    () =>
      roomHttp(
        rooms,
        room,
        "catalog",
        new Request("http://local/catalog"),
        config,
      ),
    { code: "INVALID_SESSION" },
  );
  assert.equal(
    command("bag_change", { action: "add", variantId: "audio-0" }).ack.code,
    "BAG_UNAVAILABLE",
  );
  const sharing = command("hold_up", { variantId, productId });
  assert.equal(sharing.ack.find.cents, 2500);
  assert.equal(sharing.ack.bag.totalQuantity, 0);
  await Promise.all([provider.load(), provider.load()]);
  assert.equal(state.calls.length, 1);
  tick(60001);
  await Promise.all([provider.load(), provider.load()]);
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[0].variables.country, "CA");
});

test("checkout locks one revision, sends canonical picker and quantity, and unlocks on return or expiry", async (t) => {
  const { rooms, room, maya, sam, state, command, bag, input, tick } =
    await setup(t);
  assert.ok(command("bag_change", { action: "add", variantId }).ack.ok);
  const proposal = input();
  const checkout = await rooms.checkout.start(
    room,
    maya,
    proposal,
    async () => {
      assert.equal(rooms.snapshot(room).checkout.name, "Maya");
      assert.equal(
        command("bag_change", { action: "add", variantId }, "sam").ack.code,
        "CHECKOUT_BUSY",
      );
      await assert.rejects(
        rooms.checkout.start(room, sam, input(), () => {}),
        { code: "CHECKOUT_BUSY" },
      );
    },
  );
  assert.equal(
    checkout.checkoutUrl,
    "https://checkout.example.com/checkouts/test",
  );
  assert.equal("checkoutUrl" in rooms.snapshot(room).checkout, false);
  assert.deepEqual(state.calls.at(-1).variables.input, {
    buyerIdentity: { countryCode: "CA" },
    lines: [
      {
        merchandiseId: variantId,
        quantity: 1,
        attributes: [{ key: "picked_by", value: "Maya" }],
      },
    ],
  });
  assert.equal(
    rooms.checkout.release(room, sam.id, proposal.id).checkout.name,
    "Maya",
  );
  assert.equal(
    rooms.checkout.release(room, maya.id, proposal.id).checkout,
    null,
  );
  assert.equal(bag().totalQuantity, 1);
  await rooms.checkout.start(room, maya, input(), () => {});
  tick(300001);
  assert.equal(rooms.sweep(room).checkoutExpired, true);
  assert.equal(rooms.snapshot(room).checkout, null);
  assert.equal(bag().totalQuantity, 1);
});

test("checkout requires explicit retry after a price change and blocks unavailable, partial and mismatched Shopify carts", async (t) => {
  const { rooms, room, maya, state, command, bag, input, tick } =
    await setup(t);
  command("bag_change", { action: "add", variantId });
  state.amount = "30.00";
  const start = () => rooms.checkout.start(room, maya, input(), () => {});
  await assert.rejects(start(), { code: "BAG_REVIEW" });
  assert.deepEqual(bag().totals, [{ currency: "CAD", cents: 3000 }]);
  assert.equal(
    state.calls.some((entry) => entry.query.includes("mutation")),
    false,
  );
  assert.equal(rooms.snapshot(room).checkout, null);
  state.warnings = [{ message: "Inventory changed" }];
  await assert.rejects(start(), {
    code: "CHECKOUT_REVIEW",
    message: "Inventory changed",
  });
  state.warnings = [];
  state.cartQuantity = 0;
  await assert.rejects(start(), { code: "CHECKOUT_REVIEW" });
  state.cartQuantity = 1;
  state.cartAmount = "31.00";
  await assert.rejects(start(), { code: "CHECKOUT_TOTAL" });
  state.cartAmount = "30.00";
  state.url = "https://unrelated.example/checkouts/test";
  await assert.rejects(start(), { code: "CHECKOUT_URL" });
  state.missing = true;
  tick(1);
  await assert.rejects(start(), { code: "BAG_REVIEW" });
  assert.equal(bag().unavailable, 1);
  assert.equal(bag().items[0].cents, null);
  assert.equal(rooms.snapshot(room).checkout, null);
});
