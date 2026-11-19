import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Rooms } from "../server/rooms.js";
import { Storefront } from "../server/storefront.js";
import { ShopifyClient } from "../shopify.mjs";
import { migrate, nodeStore } from "../server/storage.js";
import { configuration } from "../server/config.js";
import { catalog } from "../catalog.mjs";
import { digest } from "../server/security.js";
import { readPaidWebhook, logWebhook } from "../server/order-webhook.js";
import { launch, api } from "./support/rooms.mjs";

const variantId = "gid://shopify/ProductVariant/42";
const productId = "gid://shopify/Product/24";
const domain = "example.myshopify.com";
const secret = "test-only-webhook-secret";
const money = (amount) => ({ amount, currencyCode: "CAD" });
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

// Fault-injectable Storefront fake: `onVariants` / `onCart` run before the
// response is produced and may throw, tick the clock or mutate state.
function fixture(hooks) {
  const state = { amount: "25.00", available: true, carts: 0, calls: [] };
  const client = new ShopifyClient(domain, "public-token-for-test", {
    apiVersion: "2026-10",
    country: "CA",
    fetcher: async (_, request) => {
      const { query, variables } = JSON.parse(request.body);
      state.calls.push(query.match(/(Coshop\w+)/)[1]);
      if (query.includes("CoshopVariants")) await hooks.onVariants?.(state);
      const variant = {
        id: variantId,
        title: "Forest",
        availableForSale: state.available,
        price: money(state.amount),
      };
      if (query.includes("CoshopProducts"))
        return Response.json({
          data: {
            shop: { name: "Example", primaryDomain: { host: domain } },
            products: {
              nodes: [
                {
                  id: productId,
                  title: "Jacket",
                  description: "",
                  productType: "Wear",
                  variants: {
                    nodes: [variant],
                    pageInfo: { hasNextPage: false },
                  },
                },
              ],
            },
          },
        });
      if (query.includes("CoshopVariants"))
        return Response.json({ data: { nodes: [variant] } });
      await hooks.onCart?.(state, variables.input);
      const [line] = variables.input.lines;
      const token = state.token ?? "cart-" + ++state.carts;
      return Response.json({
        data: {
          cartCreate: {
            userErrors: [],
            warnings: [],
            cart: {
              id: state.rawId ?? `gid://shopify/Cart/${token}?key=secret-key`,
              checkoutUrl: `https://${domain}/cart/c/${token}`,
              lines: {
                nodes: [
                  { quantity: line.quantity, merchandise: { id: variantId } },
                ],
              },
              cost: {
                subtotalAmount: money(
                  (line.quantity * Number(state.amount)).toFixed(2),
                ),
              },
            },
          },
        },
      });
    },
  });
  return { state, client };
}

const schema = (name, index) =>
  readFile(
    new URL(`../drizzle/room-object/000${index + 1}_${name}.sql`, import.meta.url),
    "utf8",
  );
async function setup(t, through = names.length) {
  let now = 100000;
  const clock = () => now;
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  t.after(() => db.close());
  const store = nodeStore(db);
  for (const [index, name] of names.slice(0, through).entries())
    migrate(store, await schema(name, index), index + 1);
  const upgrade = async () => {
    for (const [index, name] of names.entries())
      if (index >= through) migrate(store, await schema(name, index), index + 1);
  };
  const hooks = {};
  const { client, state } = fixture(hooks);
  const provider = new Storefront({}, clock, client);
  const config = configuration({
    INVITE_SIGNING_SECRET: "attribution-only-test-signing-secret",
  });
  const rooms = new Rooms(store, config, clock, catalog, provider, true);
  const room = crypto.randomUUID();
  const maya = rooms.create(
    room,
    { name: "Maya", avatar: "sage" },
    "maya",
    await provider.load(),
  );
  const sam = rooms.join(room, { name: "Sam", avatar: "clay" }, "sam");
  rooms.connect(room, "maya", "maya-socket");
  rooms.connect(room, "sam", "sam-socket");
  const command = (type, options, shopper = "maya") =>
    rooms.shopCommand(room, shopper + "-socket", {
      type,
      requestId: crypto.randomUUID(),
      ...options,
    });
  const bag = () => rooms.snapshot(room).bag;
  const input = (id = crypto.randomUUID()) => ({
    id,
    revision: bag().revision,
    pricedAt: bag().pricedAt,
  });
  const count = (table) =>
    store.all(`SELECT COUNT(*) AS n FROM ${table} WHERE room_id=?`, room)[0].n;
  const attempts = () =>
    store
      .all(
        "SELECT id,cart_token<>'' AS bound,outcome FROM haul_checkouts WHERE room_id=? ORDER BY rowid",
        room,
      )
      .map((row) => ({ ...row, bound: Boolean(row.bound) }));
  const deliver = async (attempt, cartToken, extra = {}) => {
    const body = JSON.stringify({
      admin_graphql_api_id: "gid://shopify/Order/" + (extra.order ?? 1),
      financial_status: "paid",
      cart_token: cartToken,
      processed_at: extra.processedAt ?? "2026-11-19T10:00:00Z",
      note_attributes: [
        { name: "_coshop_haul", value: room + "." + attempt },
      ],
      total_price_set: {
        presentment_money: { amount: "28.75", currency_code: "CAD" },
      },
      line_items: [
        {
          variant_id: 42,
          title: "Jacket",
          variant_title: "Forest",
          quantity: extra.quantity ?? 1,
        },
      ],
      email: "not-retained@example.invalid",
      ...extra.payload,
    });
    const parsed = await readPaidWebhook(
      new Request("http://localhost/api/shopify/orders-paid", {
        method: "POST",
        body,
        headers: {
          "x-shopify-shop-domain": domain,
          "x-shopify-topic": "orders/paid",
          "x-shopify-hmac-sha256": createHmac("sha256", secret)
            .update(body)
            .digest("base64"),
        },
      }),
      { shopify: { domain, webhookSecret: secret } },
    );
    return parsed.order ? rooms.haul.paid(parsed.order) : parsed.outcome;
  };
  const start = (proposal = input(), person = maya) =>
    rooms.checkout.start(room, person, proposal, () => {});
  return {
    rooms,
    room,
    maya,
    sam,
    state,
    hooks,
    store,
    command,
    bag,
    input,
    count,
    attempts,
    deliver,
    start,
    upgrade,
    tick: (duration) => (now += duration),
  };
}

test("attempt snapshot is persisted before cartCreate; an ambiguous cartCreate failure keeps it unbound and fails closed", async (t) => {
  const { hooks, command, input, start, attempts, deliver, rooms, room } =
    await setup(t);
  command("bag_change", { action: "add", variantId });
  const proposal = input();
  let seen;
  hooks.onCart = () => {
    seen = attempts();
    // Shopify may have created the cart; the response is lost.
    throw new TypeError("fetch failed");
  };
  await assert.rejects(start(proposal), { code: "SHOPIFY_UNAVAILABLE" });
  assert.deepEqual(seen, [
    { id: proposal.id, bound: false, outcome: "pending" },
  ]);
  assert.deepEqual(attempts(), [
    { id: proposal.id, bound: false, outcome: "unconfirmed" },
  ]);
  assert.equal(rooms.snapshot(room).checkout, null);
  assert.equal(await deliver(proposal.id, "cart-1"), "attempt_unbound");
  await assert.rejects(start(input(proposal.id)), { code: "CHECKOUT_REQUEST" });
  hooks.onCart = null;
  const retry = input();
  await start(retry);
  assert.equal(attempts().length, 2);
  assert.equal(await deliver(retry.id, "cart-1"), "recorded");
  assert.equal(rooms.snapshot(room).recap.id, "paid:" + retry.id);
  const retained = JSON.stringify(
    rooms.store.all("SELECT * FROM haul_recaps"),
  ) + JSON.stringify(rooms.store.all("SELECT * FROM haul_checkouts"));
  for (const secret of ["example.invalid", "cart-1", "Order/1"])
    assert.equal(retained.includes(secret), false, secret);
});

test("a cartCreate response that returns after the lease expired is withheld; its cart stays bound but is never recapped", async (t) => {
  const { hooks, command, input, start, attempts, deliver, tick, state } =
    await setup(t);
  command("bag_change", { action: "add", variantId });
  const proposal = input();
  hooks.onCart = () => tick(30001);
  await assert.rejects(start(proposal), { code: "CHECKOUT_ENDED" });
  assert.equal(state.carts, 1);
  assert.deepEqual(attempts(), [
    { id: proposal.id, bound: true, outcome: "withheld" },
  ]);
  assert.equal(await deliver(proposal.id, "cart-2"), "cart_mismatch");
  assert.equal(await deliver(proposal.id, "cart-1"), "attempt_not_opened");
});

test("price or availability changing during the server check blocks cartCreate and records no attempt", async (t) => {
  const { hooks, command, input, start, attempts, state, bag } = await setup(t);
  command("bag_change", { action: "add", variantId });
  hooks.onVariants = (s) => (s.available = false);
  await assert.rejects(start(), { code: "BAG_REVIEW" });
  assert.equal(bag().unavailable, 1);
  hooks.onVariants = (s) => {
    s.available = true;
    s.amount = "26.00";
  };
  await assert.rejects(start(), { code: "BAG_REVIEW" });
  assert.equal(state.calls.includes("CoshopCheckout"), false);
  assert.deepEqual(attempts(), []);
});

test("an unparseable cart id fails closed: no checkout opens and its webhook is reported as unbound", async (t) => {
  const { state, command, input, start, deliver, attempts, rooms, room } =
    await setup(t);
  command("bag_change", { action: "add", variantId });
  state.rawId = "gid://shopify/Cart";
  const warn = t.mock.method(console, "warn", () => {});
  const proposal = input();
  await assert.rejects(start(proposal), { code: "CHECKOUT_ATTRIBUTION" });
  assert.match(warn.mock.calls[0].arguments[0], /attribution_unavailable/);
  assert.equal(rooms.snapshot(room).checkout, null);
  assert.deepEqual(attempts(), [
    { id: proposal.id, bound: false, outcome: "rejected" },
  ]);
  assert.equal(await deliver(proposal.id, "cart-1"), "attempt_unbound");
});

test("attempt ids must be lowercase and cannot be reused after a cart was opened", async (t) => {
  const { command, input, start, state, rooms, room, maya } = await setup(t);
  command("bag_change", { action: "add", variantId });
  await assert.rejects(start(input(crypto.randomUUID().toUpperCase())), {
    code: "CHECKOUT_REQUEST",
  });
  assert.equal(state.calls.includes("CoshopVariants"), false);
  const proposal = input();
  await start(proposal);
  rooms.checkout.release(room, maya.id, proposal.id);
  await assert.rejects(start(input(proposal.id)), {
    code: "CHECKOUT_REQUEST",
  });
});

test("multiple attempts persist past release and lease expiry; out-of-order and duplicate webhooks record each order exactly once", async (t) => {
  const {
    rooms,
    room,
    maya,
    sam,
    command,
    input,
    start,
    attempts,
    deliver,
    tick,
    bag,
  } = await setup(t);
  command("bag_change", { action: "add", variantId });
  const first = input();
  await start(first);
  rooms.checkout.release(room, maya.id, first.id);
  command("bag_change", { action: "add", variantId }, "sam");
  const second = input();
  await start(second, sam);
  tick(300001);
  assert.equal(rooms.sweep(room).checkoutExpired, true);
  assert.equal(attempts().length, 2);
  rooms.connect(room, "maya", "maya-socket");
  command("bag_change", { action: "add", variantId });
  assert.equal(
    await deliver(second.id, "cart-2", {
      order: 2,
      quantity: 2,
      processedAt: "2026-11-19T10:05:00Z",
    }),
    "recorded",
  );
  assert.equal(await deliver(first.id, "cart-2", { order: 1 }), "cart_mismatch");
  assert.equal(
    await deliver(first.id, "cart-1", {
      order: 1,
      processedAt: "2026-11-19T10:01:00Z",
    }),
    "recorded",
  );
  assert.equal(
    await deliver(first.id, "cart-1", { order: 1 }),
    "duplicate",
  );
  assert.equal(
    await deliver(second.id, "cart-2", { order: 2, quantity: 2 }),
    "duplicate",
  );
  assert.equal(
    await deliver(first.id, "cart-1", { order: 3 }),
    "attempt_already_paid",
  );
  const recaps = rooms.store
    .all("SELECT payload FROM haul_recaps WHERE room_id=? ORDER BY sequence", room)
    .map((row) => JSON.parse(row.payload));
  assert.deepEqual(
    recaps.map((recap) => [recap.id, recap.totalQuantity]),
    [
      ["paid:" + second.id, 2],
      ["paid:" + first.id, 1],
    ],
  );
  const { recap } = rooms.snapshot(room);
  assert.equal(recap.id, "paid:" + first.id);
  assert.equal(recap.items[0].pickedBy.name, "Maya");
  assert.equal(bag().totalQuantity, 3);
  assert.deepEqual(attempts(), [
    { id: first.id, bound: true, outcome: "paid" },
    { id: second.id, bound: true, outcome: "paid" },
  ]);
});

test("unattributed and malformed orders are reported, and room expiry erases attempts, recaps and leases", async (t) => {
  const { rooms, room, command, input, start, deliver, count, tick } =
    await setup(t);
  command("bag_change", { action: "add", variantId });
  const proposal = input();
  await start(proposal);
  assert.equal(
    await deliver(proposal.id, "cart-1", { payload: { note_attributes: [] } }),
    "unattributed",
  );
  assert.equal(
    await deliver(proposal.id.toUpperCase(), "cart-1"),
    "unattributed",
  );
  assert.equal(
    await deliver(proposal.id, "cart-1", {
      payload: { financial_status: "pending" },
    }),
    "not_paid",
  );
  await start(input()).catch((error) => assert.equal(error.code, "CHECKOUT_BUSY"));
  assert.equal(await deliver(proposal.id, "cart-1"), "recorded");
  await start(input());
  for (const table of ["haul_checkouts", "haul_recaps", "checkout_leases"])
    assert.ok(count(table) > 0, table);
  tick(rooms.config.ttl);
  assert.throws(() => rooms.require(room), { code: "ROOM_EXPIRED" });
  for (const table of [
    "haul_checkouts",
    "haul_recaps",
    "checkout_leases",
    "room_storefronts",
    "bag_lines",
    "participants",
  ])
    assert.equal(count(table), 0, table);
  assert.equal(await deliver(proposal.id, "cart-1", { order: 9 }), "room_expired");
  assert.equal(
    await deliver(crypto.randomUUID(), "cart-9", { order: 10 }),
    "room_expired",
  );
  assert.equal(count("haul_recaps"), 0);
});

const webhookEnv = {
  SHOPIFY_STORE_DOMAIN: "fake-store.myshopify.com",
  SHOPIFY_WEBHOOK_SECRET: "test-only-webhook-secret-route",
};
function signed(base, payload, signature) {
  const body = JSON.stringify(payload);
  return fetch(base + "/api/shopify/orders-paid", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "x-shopify-shop-domain": webhookEnv.SHOPIFY_STORE_DOMAIN,
      "x-shopify-topic": "orders/paid",
      "x-shopify-webhook-id": "fixture-webhook-1",
      "x-shopify-hmac-sha256":
        signature ??
        createHmac("sha256", webhookEnv.SHOPIFY_WEBHOOK_SECRET)
          .update(body)
          .digest("base64"),
    },
  });
}
const order = (room, attempt, cartToken, extra = {}) => ({
  admin_graphql_api_id: "gid://shopify/Order/7",
  financial_status: "paid",
  cart_token: cartToken,
  processed_at: "2026-11-19T10:00:00Z",
  note_attributes: [{ name: "_coshop_haul", value: room + "." + attempt }],
  total_price_set: {
    presentment_money: { amount: "25.00", currency_code: "CAD" },
  },
  line_items: [
    { variant_id: 42, title: "Jacket", variant_title: "Forest", quantity: 1 },
  ],
  ...extra,
});

for (const worker of [false, true])
  test(
    `${worker ? "Cloudflare" : "Node"}: signed orders-paid route reports diagnostics without changing unknown rooms`,
    { timeout: 60000 },
    async (t) => {
      const { base } = await launch(t, worker, {
        TEST_PORT: worker ? "14371" : "14370",
        ...webhookEnv,
      });
      const room = crypto.randomUUID();
      const attempt = crypto.randomUUID();
      const outcome = async (payload, signature) => {
        const response = await signed(base, payload, signature);
        const body = await response.json();
        if (response.ok)
          assert.deepEqual(Object.keys(body).sort(), ["outcome", "received"]);
        return [response.status, body.outcome];
      };
      assert.deepEqual(
        await outcome(order(room, attempt, "x"), "A".repeat(43) + "="),
        [401, undefined],
      );
      assert.deepEqual(await outcome(order(room, attempt, "x")), [
        200,
        "room_expired",
      ]);
      assert.deepEqual(
        await outcome(order(room, attempt, "x", { note_attributes: [] })),
        [200, "unattributed"],
      );
      assert.deepEqual(
        await outcome(order(room, attempt, "x", { financial_status: "pending" })),
        [200, "not_paid"],
      );
    },
  );

test("Node: verify-shopify drives the current room routes, and a signed paid webhook produces the recap", { timeout: 60000 }, async (t) => {
  const env = {
    TEST_PORT: "14372",
    ...webhookEnv,
    SHOPIFY_STOREFRONT_TOKEN: "public-token-for-fake-store",
    SHOPIFY_API_VERSION: "2026-10",
    SHOPIFY_BUYER_COUNTRY: "CA",
    DATA_DIR: await mkdtemp(join(tmpdir(), "coshop-verify-")),
  };
  // Hooks run in registration order: launch's server kill, the CLI kill below,
  // then the delete, so no process still holds rooms.sqlite (Windows locks it).
  const { base, child: server } = await launch(t, false, env, [
    "--import",
    // A file: URL, not a path: Windows rejects bare "C:\\" paths for --import.
    new URL("./support/fake-shopify.mjs", import.meta.url).href,
  ]);
  const exited = (child) =>
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => {
          const timer = setTimeout(resolve, 10000);
          child.once("exit", () => resolve(clearTimeout(timer)));
        });
  const clis = new Set();
  t.after(async () => {
    for (const child of clis) child.kill();
    await Promise.all([...clis, server].map(exited));
    await rm(env.DATA_DIR, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  });
  const script = fileURLToPath(
    new URL("../scripts/verify-shopify.mjs", import.meta.url),
  );
  const run = (args, operator) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [script, base, ...args], {
        env: { ...process.env, VERIFY_POLL_MS: "100" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      clis.add(child);
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (b) => (stdout += b));
      child.stderr.on("data", (b) => {
        stderr += b;
        operator?.(stderr);
      });
      child.on("exit", (code) => {
        clis.delete(child);
        resolve({ code, stdout, stderr });
      });
    });
  const refused = await run([]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /--allow-cart-create/);
  for (const bad of [
    ["--allow-cart-createNO"],
    ["--allow-cart-create=yes"],
    ["--allow-cart-create", "--await-paid"],
    ["--allow-cart-create", "--5"],
    ["--allow-cart-create", "5"],
    ["--allow-cart-create", "--attempt=2"],
  ]) {
    const rejected = await run(bad);
    assert.notEqual(rejected.code, 0, bad);
    assert.equal(rejected.stdout, "", bad);
  }
  const empty = await mkdtemp(join(tmpdir(), "coshop-wrong-db-"));
  t.after(() => rm(empty, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  await writeFile(join(empty, "rooms.sqlite"), "");
  for (const [dir, reason] of [
    [join(empty, "missing"), "server_db_unreadable"],
    [empty, "server_db_unreadable"],
  ]) {
    const wrong = await run(["--allow-cart-create", "--data-dir=" + dir]);
    assert.equal(wrong.code, 1, wrong.stderr);
    assert.deepEqual(JSON.parse(wrong.stdout).failures, [reason]);
  }
  const unpaid = await run(["--allow-cart-create", "--await-paid=1", "--data-dir=" + env.DATA_DIR]);
  assert.equal(unpaid.code, 1, unpaid.stderr);
  const missed = JSON.parse(unpaid.stdout);
  assert.equal(missed.passed, false);
  assert.deepEqual(missed.failures, ["paid_recap_missing", "outcome_opened_A1", "recap_order"]);
  const outFile = join(env.DATA_DIR, "dry=run.json");
  const cartOnly = await run(["--allow-cart-create", "--data-dir=" + env.DATA_DIR, "--out=" + outFile]);
  assert.equal(cartOnly.code, 0, cartOnly.stderr);
  assert.equal(await readFile(outFile, "utf8"), cartOnly.stdout);
  const report = JSON.parse(cartOnly.stdout);
  assert.equal(report.checkoutHost, "fake-store.myshopify.com");
  assert.equal(report.lockReleased, true);
  assert.equal(report.paidRecap, null);
  assert.deepEqual(report.bagTotals, [{ currency: "CAD", cents: 2500 }]);
  assert.deepEqual([report.passed, report.failures], [true, []]);
  for (const leak of ["key=", "/cart/c/", "token", "invite"])
    assert.ok(!cartOnly.stdout.includes(leak), leak);
  // Supervised mode: this test plays the operator and "pays" by delivering
  // the signed webhook Shopify would send for the printed checkout.
  let paid;
  const supervised = await run(
    ["--allow-cart-create", "--await-paid=20"],
    (stderr) => {
      const match = stderr.match(/\/cart\/c\/([a-f0-9-]{36})\.([a-f0-9-]{36})/);
      if (!match || paid) return;
      const [, room, attempt] = match;
      paid = Promise.all([
        signed(base, order(room, attempt, "fake-" + attempt)),
        signed(base, order(room, attempt, "fake-" + attempt)),
      ]).then((responses) => Promise.all(responses.map((r) => r.json())));
    },
  );
  assert.equal(supervised.code, 0, supervised.stderr);
  assert.deepEqual((await paid).map((r) => r.outcome).sort(), [
    "duplicate",
    "recorded",
  ]);
  const evidence = JSON.parse(supervised.stdout);
  assert.equal(evidence.lockReleased, false);
  assert.deepEqual(evidence.paidRecap, {
    attempt: "A1",
    mode: "paid",
    totalQuantity: 1,
    totals: [{ cents: 2500, currency: "CAD" }],
    itemVariantIds: ["gid://shopify/ProductVariant/42"],
  });
  assert.ok(!supervised.stdout.includes("/cart/c/"));

  // Two attempts paid in reverse order, then one redelivery of the newest.
  const outcomes = [];
  let started, redelivered;
  const deliver = async ([n, room, attempt]) =>
    outcomes.push(
      (
        await (
          await signed(
            base,
            order(room, attempt, "fake-" + attempt, {
              admin_graphql_api_id: "gid://shopify/Order/10" + n,
            }),
          )
        ).json()
      ).outcome,
    );
  const urls = /^A(\d) \S+\/cart\/c\/([a-f0-9-]{36})\.([a-f0-9-]{36})$/gm;
  const twice = await run(
    [
      "--allow-cart-create",
      "--attempts=2",
      "--await-paid=30",
      "--await-redelivery=2",
      "--data-dir=" + env.DATA_DIR,
    ],
    (stderr) => {
      const found = [...stderr.matchAll(urls)].map(([, n, room, id]) => [n, room, id]);
      if (found.length === 2 && !started)
        started = deliver(found[0]).then(() => deliver(found[1]));
      if (/redeliver/.test(stderr) && !redelivered)
        redelivered = started.then(() => deliver(found[1]));
    },
  );
  assert.equal(twice.code, 0, twice.stderr);
  await redelivered;
  assert.deepEqual(outcomes, ["recorded", "recorded", "duplicate"]);
  const proof = JSON.parse(twice.stdout);
  assert.deepEqual(proof.paymentOrder, ["A2", "A1"]);
  assert.deepEqual(proof.server.recapOrder, ["A2", "A1"]);
  assert.deepEqual([proof.passed, proof.failures], [true, []]);
  assert.equal(proof.redelivery.recapCountBefore, 2);
  assert.equal(proof.redelivery.recapCountAfter, 2);
  assert.equal(proof.redelivery.duplicateDeliveryVerified, false);
  assert.equal(proof.paidRecap.attempt, "A1");
  for (const entry of proof.server.attempts)
    assert.deepEqual(entry, {
      attempt: entry.attempt,
      outcome: "paid",
      cartBound: true,
      snapshotSha256: proof.bagSha256,
    });
  for (const leak of ["/cart/c/", "token", "invite", "Verifier"])
    assert.ok(!twice.stdout.includes(leak), leak);
  for (const report of [cartOnly.stdout, supervised.stdout, twice.stdout])
    assert.doesNotMatch(report, /[a-f0-9]{8}-[a-f0-9]{4}-/);
});

test("a committed bag change replays its original ack after a checkout lease starts; new or altered changes stay locked", async (t) => {
  const { rooms, room, start, bag } = await setup(t);
  const requestId = crypto.randomUUID();
  const add = (shopper = "maya", options = {}) =>
    rooms.shopCommand(room, shopper + "-socket", {
      type: "bag_change",
      requestId,
      action: "add",
      variantId,
      ...options,
    });
  assert.ok(add().ack.ok);
  await start();
  const replay = add();
  assert.equal(replay.ack.ok, true);
  assert.equal(replay.ack.bag.totalQuantity, 1);
  assert.equal(replay.notification, undefined);
  const refused = (...args) => add(...args).ack.code;
  assert.equal(refused("sam"), "INVALID_BAG");
  assert.equal(refused("maya", { action: "decrease" }), "INVALID_BAG");
  assert.equal(
    refused("maya", { requestId: crypto.randomUUID() }),
    "CHECKOUT_BUSY",
  );
  assert.equal(refused("sam", { requestId: crypto.randomUUID() }), "CHECKOUT_BUSY");
  assert.equal(bag().totalQuantity, 1);
});

test("retrying the same attempt after a lost response resumes its cart without a second cartCreate", async (t) => {
  const { rooms, room, maya, sam, hooks, state, command, input, start } =
    await setup(t);
  command("bag_change", { action: "add", variantId });
  const proposal = input();
  let release;
  hooks.onCart = () => new Promise((resolve) => (release = resolve));
  const first = start(proposal);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(start(proposal), { code: "CHECKOUT_PENDING" });
  await assert.rejects(start(proposal, sam), { code: "CHECKOUT_BUSY" });
  release();
  const opened = await first;
  hooks.onCart = null;
  state.amount = "30.00";
  const resumed = await start(proposal);
  assert.equal(resumed.checkoutUrl, opened.checkoutUrl);
  assert.equal(resumed.checkout.id, proposal.id);
  const denied = await start(input(), sam).catch((error) => error);
  assert.equal(denied.code, "CHECKOUT_BUSY");
  assert.equal(JSON.stringify(denied).includes("checkout.example"), false);
  assert.equal(denied.message.includes("checkout.example"), false);
  const otherTab = await start(input());
  assert.equal(otherTab.checkoutUrl, opened.checkoutUrl);
  assert.equal(otherTab.checkout.id, proposal.id);
  assert.equal(state.calls.filter((c) => c === "CoshopCheckout").length, 1);
  assert.equal("checkoutUrl" in rooms.snapshot(room).checkout, false);
  rooms.checkout.release(room, maya.id, proposal.id);
  await assert.rejects(start(proposal), { code: "CHECKOUT_REQUEST" });
});

test("bag model retries a lost checkout response with the same attempt id", async () => {
  const { createBag } = await import("../react/bag-model.js");
  const requests = [];
  const store = new Map();
  globalThis.sessionStorage = {
    setItem: (key, value) => store.set(key, value),
    getItem: (key) => store.get(key) ?? null,
    removeItem: (key) => store.delete(key),
  };
  let assigned;
  globalThis.location = { assign: (url) => (assigned = url) };
  try {
    const model = createBag(
      () => {},
      async (action, body) => {
        requests.push({ action, ...body });
        if (requests.length < 3)
          throw Object.assign(new Error("offline"), {
            code: requests.length === 1 ? "NETWORK" : "CHECKOUT_PENDING",
          });
        return { checkoutUrl: "https://example.myshopify.com/cart/c/x" };
      },
      () => {},
      () => {},
    );
    model.retryDelay = 1;
    model.snapshot(
      {
        id: "room",
        checkoutEnabled: true,
        bag: {
          revision: 4,
          pricedAt: 9,
          items: [{ variantId, quantity: 1, available: true }],
          totalQuantity: 1,
          unavailable: 0,
        },
      },
      "maya",
    );
    model.setConnected(true);
    await model.startCheckout();
    assert.equal(requests.length, 3);
    assert.equal(new Set(requests.map((r) => r.id)).size, 1);
    assert.equal(store.get("coshop:checkout:room:maya"), requests[0].id);
    assert.equal(assigned, "https://example.myshopify.com/cart/c/x");
    const resumedId = crypto.randomUUID();
    requests.length = 2;
    model.checkoutRequest = async (action, body) => {
      requests.push(body);
      return {
        checkoutUrl: "https://example.myshopify.com/cart/c/x",
        checkout: { id: resumedId },
      };
    };
    model.departing = false;
    await model.startCheckout();
    assert.notEqual(requests.at(-1).id, resumedId);
    assert.equal(store.get("coshop:checkout:room:maya"), resumedId);
  } finally {
    delete globalThis.sessionStorage;
    delete globalThis.location;
  }
});

test("upgrading a populated v7 room keeps attribution, legacy dedup and legacy leases", async (t) => {
  const { rooms, room, maya, sam, store, upgrade, deliver, attempts, start, input, command } =
    await setup(t, 7);
  command("bag_change", { action: "add", variantId });
  const legacy = crypto.randomUUID();
  const unbound = crypto.randomUUID();
  const items = rooms.snapshot(room).bag.items;
  rooms.haul.saveCheckout(room, legacy, domain, items);
  rooms.haul.bindCart(room, legacy, await digest("cart-legacy"));
  rooms.haul.saveCheckout(room, unbound, domain, items);
  store.run(
    "INSERT INTO haul_recaps(room_id,event_key,payload) VALUES(?,?,?)",
    room,
    "paid:" + domain + ":gid://shopify/Order/5",
    JSON.stringify({ id: "paid:old", mode: "paid", items: [] }),
  );
  store.run(
    "INSERT INTO checkout_leases(room_id,id,user_id,expires_at) VALUES(?,?,?,?)",
    room,
    legacy,
    maya.id,
    rooms.clock() + 60000,
  );
  await upgrade();
  assert.deepEqual(attempts(), [
    { id: legacy, bound: true, outcome: "opened" },
    { id: unbound, bound: false, outcome: "pending" },
  ]);
  await assert.rejects(start(input()), { code: "CHECKOUT_PENDING" });
  await assert.rejects(start(input(), sam), { code: "CHECKOUT_BUSY" });
  assert.equal(await deliver(legacy, "cart-legacy", { order: 5 }), "duplicate");
  assert.equal(await deliver(unbound, "cart-x", { order: 6 }), "attempt_unbound");
  assert.equal(await deliver(legacy, "cart-legacy", { order: 7 }), "recorded");
  assert.equal(await deliver(legacy, "cart-legacy", { order: 7 }), "duplicate");
  assert.equal(rooms.checkout.active(room), null);
  assert.equal(rooms.snapshot(room).recap.id, "paid:" + legacy);
});

test("webhook diagnostics log only the outcome and a well-formed webhook id", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const request = (id) =>
    new Request("http://localhost/api/shopify/orders-paid", {
      method: "POST",
      headers: id ? { "x-shopify-webhook-id": id } : {},
    });
  logWebhook(request("b1d2-77"), "attempt_unbound");
  logWebhook(request("x".repeat(65)), "recorded");
  logWebhook(request("a b@example.com"), "duplicate");
  logWebhook(request(), "unattributed");
  const forged = (headers) =>
    readPaidWebhook(
      new Request("http://localhost/api/shopify/orders-paid", {
        method: "POST",
        headers: {
          "x-shopify-shop-domain": domain,
          "x-shopify-topic": "orders/paid",
          "x-shopify-hmac-sha256": "A".repeat(43) + "=",
          "x-shopify-webhook-id": "w-1",
          ...headers,
        },
        body: "{}",
      }),
      { shopify: { webhookSecret: "test-secret", domain } },
    );
  for (const headers of [
    {},
    { "x-shopify-topic": "orders/create" },
    { "x-shopify-shop-domain": "other.myshopify.com" },
    { "x-shopify-hmac-sha256": "short" },
  ])
    await assert.rejects(forged(headers), { code: "WEBHOOK_SIGNATURE" });
  assert.deepEqual(
    log.mock.calls.slice(4).map((call) => JSON.parse(call.arguments[0]).outcome),
    ["rejected_signature", "rejected_topic", "rejected_shop", "rejected_signature"],
  );
  assert.deepEqual(
    log.mock.calls.slice(0, 4).map((call) => JSON.parse(call.arguments[0])),
    [
      { event: "coshop.orders_paid", outcome: "attempt_unbound", webhookId: "b1d2-77" },
      { event: "coshop.orders_paid", outcome: "recorded", webhookId: null },
      { event: "coshop.orders_paid", outcome: "duplicate", webhookId: null },
      { event: "coshop.orders_paid", outcome: "unattributed", webhookId: null },
    ],
  );
});
