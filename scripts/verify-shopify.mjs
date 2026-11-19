// Supervised Shopify checkout verifier for the current room API.
// See docs/shopify-live-test-runbook.md. It never places an order itself.
import { writeFile } from "node:fs/promises";
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
const attempt = crypto.randomUUID();
const checkout = await call(
  path + "/checkout",
  { id: attempt, revision: bag.revision, pricedAt: bag.pricedAt },
  host.token,
);
const checkoutUrl = new URL(checkout.checkoutUrl);
let recap = null;
if (awaitPaid) {
  // The checkout URL is printed only to the operator's terminal, never to the report.
  console.error(
    `Operator: complete ONE authorized test order within ${awaitPaid}s:\n${checkoutUrl.href}`,
  );
  const until = Date.now() + awaitPaid * 1000;
  while (!recap && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const { room } = await call(path + "/session", {}, host.token);
    if (room.recap?.id === "paid:" + attempt) recap = room.recap;
  }
  if (!recap) console.error("No attributed paid recap arrived before the timeout.");
} else
  await call(path + "/checkout-release", { id: attempt }, host.token);

const report = {
  verifiedAt: new Date().toISOString(),
  target: new URL(base).origin,
  catalogMode: host.room.catalogMode,
  productsRetrieved: catalog.products.length,
  variantId: variant.id,
  requestedQuantity: 1,
  bagTotals: bag.totals,
  checkoutHost: checkoutUrl.hostname,
  attempt,
  lockReleased: !awaitPaid,
  paidRecap: recap && {
    id: recap.id,
    mode: recap.mode,
    totalQuantity: recap.totalQuantity,
    totals: recap.totals,
    itemVariantIds: recap.items.map((item) => item.variantId),
  },
  scope: awaitPaid
    ? "Created one Storefront cart through the room API and waited for a human-placed, authorized test order's signed orders/paid webhook."
    : "Created one Storefront cart through the room API. No order or payment was submitted.",
};
if (out) await writeFile(out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (awaitPaid && !recap) process.exitCode = 2;
