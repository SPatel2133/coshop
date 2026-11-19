import { moneyDetails, normalizeDomain } from "../shopify.mjs";
import { RoomError } from "./config.js";
import { haulAttribute } from "./haul.js";

const limit = 1024 * 1024;
// Rejections are logged with a reason; the response stays generic.
const denied = (request, reason) => {
  logWebhook(request, "rejected_" + reason);
  return new RoomError("WEBHOOK_SIGNATURE", "Webhook signature rejected.", 401);
};
const gid = /^gid:\/\/shopify\/Order\/\d{1,25}$/;
const marker = /^([a-f0-9-]{36})\.([a-f0-9-]{36})$/;

// Resolves to { order, outcome }; order is null when the event is ignored.
export function logWebhook(request, outcome) {
  const id = request.headers.get("x-shopify-webhook-id") ?? "";
  console.log(
    JSON.stringify({
      event: "coshop.orders_paid",
      outcome,
      webhookId: /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null,
    }),
  );
}
export async function readPaidWebhook(request, config) {
  const { webhookSecret, domain } = config.shopify;
  if (!webhookSecret || !domain || request.method !== "POST")
    throw new RoomError("NOT_FOUND", "Page not found.", 404);
  const shop = request.headers.get("x-shopify-shop-domain");
  const signature = request.headers.get("x-shopify-hmac-sha256") ?? "";
  if (shop !== normalizeDomain(domain)) throw denied(request, "shop");
  if (request.headers.get("x-shopify-topic") !== "orders/paid")
    throw denied(request, "topic");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(signature))
    throw denied(request, "signature");
  const reader = request.body?.getReader();
  if (!reader) throw denied(request, "body");
  const chunks = [];
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.length > limit) {
        await reader.cancel();
        logWebhook(request, "rejected_size");
        throw new RoomError(
          "BODY_TOO_LARGE",
          "That request is too large.",
          413,
        );
      }
      chunks.push(value);
      offset += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  const raw = new Uint8Array(offset);
  let position = 0;
  for (const chunk of chunks) {
    raw.set(chunk, position);
    position += chunk.length;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      Uint8Array.from(atob(signature), (char) => char.charCodeAt(0)),
      raw,
    ))
  )
    throw denied(request, "signature");
  let order;
  try {
    order = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new RoomError("INVALID_ORDER", "Invalid order data.");
  }
  if (order?.financial_status !== "paid")
    return { order: null, outcome: "not_paid" };
  const tag =
    Array.isArray(order.note_attributes) &&
    order.note_attributes.find((entry) => entry?.name === haulAttribute);
  const match = typeof tag?.value === "string" && tag.value.match(marker);
  if (
    !match ||
    typeof order.cart_token !== "string" ||
    !order.cart_token.length ||
    order.cart_token.length > 512 ||
    !gid.test(order.admin_graphql_api_id ?? "") ||
    !Array.isArray(order.line_items) ||
    !order.line_items.length ||
    order.line_items.length > 250
  )
    return { order: null, outcome: "unattributed" };
  try {
    const total = order.total_price_set?.presentment_money ?? {
      amount: order.total_price,
      currency_code: order.currency,
    };
    const totals = [
      moneyDetails({ amount: total.amount, currencyCode: total.currency_code }),
    ];
    const lines = order.line_items.map((line) => {
      if (
        !Number.isSafeInteger(line.quantity) ||
        line.quantity < 1 ||
        line.quantity > 10000 ||
        typeof line.title !== "string"
      )
        throw new Error();
      return {
        variantId: /^\d{1,25}$/.test(String(line.variant_id))
          ? "gid://shopify/ProductVariant/" + line.variant_id
          : null,
        quantity: line.quantity,
        name: line.title.slice(0, 160),
        variant:
          typeof line.variant_title === "string"
            ? line.variant_title.slice(0, 120)
            : "",
      };
    });
    const paidAt = Date.parse(order.processed_at ?? order.created_at ?? "");
    return {
      outcome: "verified",
      order: {
        room: match[1],
        attempt: match[2],
        shop,
        cartToken: order.cart_token,
        orderId: order.admin_graphql_api_id,
        paidAt: Number.isFinite(paidAt) ? paidAt : null,
        totals,
        lines,
      },
    };
  } catch {
    throw new RoomError("INVALID_ORDER", "Invalid order details.");
  }
}
