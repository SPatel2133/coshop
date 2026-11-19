// Supervised Shopify checkout verifier for the current room API.
// See docs/shopify-live-verification.md. It never places an order itself.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";

const args = process.argv.slice(2);
const flag = (name) => args.find((arg) => arg.startsWith("--" + name));
const base = (args.find((arg) => !arg.startsWith("--")) ?? "http://localhost:4193").replace(/\/$/, "");
const awaitPaid = Number(flag("await-paid")?.split("=")[1] ?? 0);
const out = flag("out")?.split("=")[1];
if (!flag("allow-cart-create"))
  throw new Error(
    "Pass --allow-cart-create to confirm this run may create one Shopify Storefront cart on the server's configured store. No order is placed by this script.",
  );
if (!Number.isSafeInteger(awaitPaid) || awaitPaid < 0 || awaitPaid > 3600)
  throw new Error("--await-paid must be 0-3600 seconds.");
const attempts = Number(flag("attempts")?.split("=")[1] ?? 1);
const redelivery = Number(flag("await-redelivery")?.split("=")[1] ?? 0);
const dataDir = flag("data-dir")?.split("=")[1];
if (![1, 2].includes(attempts)) throw new Error("--attempts must be 1 or 2.");
if (!Number.isSafeInteger(redelivery) || redelivery < 0 || redelivery > 3600)
  throw new Error("--await-redelivery must be 0-3600 seconds.");
if (redelivery && !(awaitPaid && dataDir))
  throw new Error("--await-redelivery needs --await-paid and --data-dir.");

async function call(path, data, token) {
  const response = await fetch(base + path, {
    method: data ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: data && JSON.stringify(data),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(`${path.split("/").at(-1)}: ${value.code ?? response.status} ${value.error ?? ""}`.trim());
  return value;
}
function command(invite, token, message) {
  const ws = new WebSocket(
    base.replace(/^http/, "ws") + "/api/rooms/" + invite + "/socket",
    { origin: base },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Bag command timed out.")), 10000);
    const finish = (error, value) => {
      clearTimeout(timer);
      ws.terminate();
      error ? reject(error) : resolve(value);
    };
    ws.on("error", finish);
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
    ws.on("message", (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.type === "state") ws.send(JSON.stringify(message));
      if (data.type === "command_ack" && data.requestId === message.requestId)
        data.ok ? finish(null, data) : finish(new Error("Bag: " + data.code));
      if (data.type === "error") finish(new Error("Socket: " + data.code));
    });
  });
}

const host = await call("/api/rooms", {
  name: "Verifier",
  avatar: "sage",
  roomName: "Shopify verification",
  catalogMode: "shopify",
});
const path = "/api/rooms/" + host.invite;
if (!host.room.checkoutEnabled)
  throw new Error("The room was created without Shopify checkout enabled.");
const catalog = await call(path + "/catalog", undefined, host.token);
const variant = catalog.products
  .flatMap((product) => product.variants)
  .find((entry) => entry.available);
if (!variant) throw new Error("The Shopify catalog has no available variants.");
const { bag } = await command(host.invite, host.token, {
  type: "bag_change",
  requestId: crypto.randomUUID(),
  action: "add",
  variantId: variant.id,
});
// Only variant ids and quantities are hashed: no names, pickers or prices.
const sha256 = async (value) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
  ).toString("hex");
const lines = (items) =>
  items
    .map(({ variantId, quantity }) => ({ variantId, quantity }))
    .sort((a, b) => a.variantId.localeCompare(b.variantId));
const bagSha256 = await sha256(lines(bag.items));
const opened = [];
for (let index = 0; index < attempts; index++) {
  const id = crypto.randomUUID();
  // Each checkout re-prices the bag, so later attempts use the current bag.
  const current = index
    ? (await call(path + "/session", {}, host.token)).room.bag
    : bag;
  const checkout = await call(
    path + "/checkout",
    { id, revision: current.revision, pricedAt: current.pricedAt },
    host.token,
  );
  opened.push({ id, url: new URL(checkout.checkoutUrl) });
  // Releasing ends the lease only; the opened attempt stays attributable.
  if (index < attempts - 1 || !awaitPaid)
    await call(path + "/checkout-release", { id }, host.token);
}
const attempt = opened[0].id;
const checkoutUrl = opened[0].url;
const label = (id) => "A" + (opened.findIndex((entry) => entry.id === id) + 1);
// The room id is the unsigned half of the invite; it is used locally, never reported.
function server() {
  const db = new DatabaseSync(join(dataDir, "rooms.sqlite"), { readOnly: true });
  try {
    const room = host.invite.split(".")[0];
    const rows = db
      .prepare("SELECT id,outcome,cart_token,snapshot FROM haul_checkouts WHERE room_id=? ORDER BY rowid")
      .all(room);
    const recaps = db
      .prepare("SELECT payload FROM haul_recaps WHERE room_id=? ORDER BY sequence")
      .all(room)
      .map((row) => JSON.parse(row.payload).id.replace(/^paid:/, ""));
    return { rows, recaps };
  } finally {
    db.close();
  }
}
async function serverEvidence() {
  const { rows, recaps } = server();
  return {
    attempts: await Promise.all(
      rows.map(async (row) => ({
        attempt: label(row.id),
        outcome: row.outcome,
        cartBound: row.cart_token !== "",
        snapshotSha256: await sha256(lines(JSON.parse(row.snapshot).items)),
      })),
    ),
    recapCount: recaps.length,
    recapOrder: recaps.map(label),
  };
}
let recap = null;
const seen = [];
if (awaitPaid) {
  // Checkout URLs are printed only to the operator's terminal, never to the report.
  console.error(
    `Operator: complete ${attempts} authorized test-gateway order(s) within ${awaitPaid}s, in this order:\n` +
      [...opened].reverse().map((entry) => label(entry.id) + " " + entry.url.href).join("\n"),
  );
  const until = Date.now() + awaitPaid * 1000;
  const done = () =>
    dataDir ? server().recaps.length >= attempts : seen.includes(attempt);
  while (!done() && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const { room } = await call(path + "/session", {}, host.token);
    const id = room.recap?.id?.replace(/^paid:/, "");
    if (id && !seen.includes(id)) seen.push(id);
  }
  const { room } = await call(path + "/session", {}, host.token);
  if (room.recap?.id === "paid:" + attempt) recap = room.recap;
  if (!recap) console.error("No attributed paid recap arrived before the timeout.");
}
const beforeRedelivery = dataDir && awaitPaid ? await serverEvidence() : null;
if (redelivery) {
  console.error(
    `Operator: redeliver the ${label(attempt)} orders/paid webhook from Shopify now; waiting ${redelivery}s.`,
  );
  await new Promise((resolve) => setTimeout(resolve, redelivery * 1000));
}
const evidence = dataDir ? await serverEvidence() : null;

const report = {
  verifiedAt: new Date().toISOString(),
  target: new URL(base).origin,
  catalogMode: host.room.catalogMode,
  productsRetrieved: catalog.products.length,
  variantId: variant.id,
  requestedQuantity: 1,
  bagTotals: bag.totals,
  bagSha256,
  checkoutHost: checkoutUrl.hostname,
  attempt,
  attempts: opened.map((entry) => ({ attempt: label(entry.id), id: entry.id })),
  paymentOrder: [...opened].reverse().map((entry) => label(entry.id)),
  lockReleased: !awaitPaid,
  paidRecap: recap && {
    id: recap.id,
    mode: recap.mode,
    totalQuantity: recap.totalQuantity,
    totals: recap.totals,
    itemVariantIds: recap.items.map((item) => item.variantId),
  },
  server: evidence,
  redelivery: redelivery
    ? {
        recapCountBefore: beforeRedelivery.recapCount,
        recapCountAfter: evidence.recapCount,
      }
    : null,
  scope: awaitPaid
    ? "Created Storefront carts through the room API and waited for human-placed, authorized test-gateway orders' signed orders/paid webhooks."
    : "Created Storefront carts through the room API. No order or payment was submitted.",
};
if (out) await writeFile(out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
