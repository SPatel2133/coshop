# Shopify checkout attribution: supervised dev-store runbook

> **Status: BLOCKED.** Do not run any live step until (1) the owner explicitly
> authorizes a test order on a named Shopify development store and (2) the
> secrets below are provisioned by the owner. Nothing in this repository places
> an order, and no production store may be used.

## Design and failure limits

Path: shared bag → `CheckoutLeases.start` (30 s lease, bag locked) → immutable
attempt snapshot in `haul_checkouts` (outcome `pending`) → Storefront `cartCreate`
with attribute `_coshop_haul = <room>.<attempt>` → validate lines, subtotal, host
→ bind `sha256(cart token)` → outcome `opened`, lease extended to 5 min and the
checkout URL is stored on the lease → shopper pays on Shopify → signed
`orders/paid` → `Haul.paid` → `haul_recaps`.

| Failure | Behaviour | Limit |
| --- | --- | --- |
| `cartCreate` throws / response lost | Snapshot kept, outcome `unconfirmed`, no cart bound, lease released. A later paid order for it reports `attempt_unbound`. | Shopify `cartCreate` has no idempotency key that CoShop relies on; a cart created during a lost response cannot be linked and is never recapped. |
| Shopify answers but CoShop refuses (user errors, line/subtotal/host mismatch, unparseable cart id) | Outcome `rejected`; returned cart hash bound when parseable; no checkout opened (fails closed). | Paid order on that cart reports `attempt_not_opened`. |
| Lease ended before handoff | Outcome `withheld`; URL never returned. | Same as above. |
| Price/availability changed during the server check | `BAG_REVIEW` / `BAG_UNAVAILABLE` before any snapshot or cart. | — |
| Browser loses the checkout response | Attempt id is stored before the request; the client retries the same id (up to 3 tries on `NETWORK` / `CHECKOUT_PENDING`). The lease holder gets the same bound URL back; no second `cartCreate`. | After the lease ends, reusing an attempt id returns `CHECKOUT_REQUEST`; a new click starts a new attempt. |
| Lease holder retries with a new attempt id (another tab) | Gets the same bound URL and the original `checkout.id`, which the client stores for release-on-return. Other participants only see `CHECKOUT_BUSY`, never the URL. | — |
| Retry of an attempt that already ended (for example after a Shopify outage) | `CHECKOUT_REQUEST` "That checkout attempt has ended"; the attempt's snapshot is kept, so a later order on it stays diagnosable. | The user must start a new attempt. |
| Lease written before migration 8 (no stored URL) | Holder gets `CHECKOUT_PENDING` until the lease expires (at most 5 min); others get `CHECKOUT_BUSY`. | No URL can be resumed for it. |
| Bag add replayed after its ack was lost and a lease started | Original ack is returned; new or altered requests stay `CHECKOUT_BUSY` / `INVALID_BAG`. | — |
| Duplicate webhook | Deduplicated exactly by `sha256(shop:order id)` → `duplicate`. | Rows written before this change used a raw key; both are checked. Migration 8 marks existing bound attempts `opened` (covered by an upgrade fixture). |
| Second order claiming an already paid attempt | `attempt_already_paid`, no recap. | — |
| Out-of-order webhooks | Every recap is kept; the room shows the most recently *received* one. Attempts are never overwritten or deleted before room expiry. | Not ordered by Shopify `processed_at`. |
| Room expired / unknown room | `room_expired`; expired rooms are deleted on touch (Worker also erases the Durable Object). | No data is retained for the order. |

All outcomes: `recorded`, `duplicate`, `unknown_attempt`, `attempt_unbound`,
`cart_mismatch`, `attempt_already_paid`, `attempt_not_opened`, `room_expired`,
`unattributed`, `not_paid`. Every case other than `recorded` is **diagnostic only:
there is no automatic or manual recovery path in CoShop.** The order stays valid in
Shopify; only the room recap is missing. To investigate, match the logged
`webhookId` with the delivery in Shopify admin's webhook delivery history.

## Privacy

- Stored per room and removed when the room expires (foreign-key cascade from
  `room_records`, asserted in `tests/phase5-attribution.test.mjs`): attempt
  snapshot (bag lines, pickers, highlights), outcome, hashed cart token, hashed
  order key, recap. No email, address, customer, raw order id or raw cart token
  is stored.
- Log lines: `{"event":"coshop.orders_paid","outcome":…,"webhookId":…}` (the
  webhook id must be ≤64 characters from `[A-Za-z0-9-]`) and
  `{"event":"coshop.checkout","outcome":"attribution_unavailable"}`. Nothing else
  from the order, cart, URL, session or invite is logged.
- Clients only receive `RoomError` codes and messages; anything else is
  `SERVER_ERROR`.

## Observability (Cloudflare)

`wrangler.jsonc` enables persisted Workers Logs at 100% head sampling with
`invocation_logs: false`, `redact_query_string: true` and traces disabled.
Invocation logs and traces would record request URLs, and room paths carry signed
invites. Volume is about one line per webhook delivery plus rare checkout
warnings, but uncaught exceptions are still logged by the runtime. Retention,
pricing tier, and whether the setting is inherited by `env.portfolio-preview`
are **unverified until a deploy**, which is out of scope here. The Node server
writes the same lines to stdout.

## Required access and secrets (owner-provisioned, never committed)

| Name | Purpose |
| --- | --- |
| `SHOPIFY_STORE_DOMAIN` | Dev store `*.myshopify.com` domain |
| `SHOPIFY_STOREFRONT_TOKEN` | Storefront API token with product-listing read and checkout write access; take the exact scope names from the access-scopes page for the configured version (below) at run time |
| `SHOPIFY_API_VERSION` | `.env.example` uses `2026-10`; must match the webhook subscription API version |
| `SHOPIFY_BUYER_COUNTRY` | Buyer country for pricing context |
| `SHOPIFY_WEBHOOK_SECRET` | Secret Shopify signs `orders/paid` with (app client secret, or the admin notifications secret) |
| `INVITE_SIGNING_SECRET` | Room invite signing |

Webhook: topic `orders/paid`, JSON, endpoint `https://<supervised host>/api/shopify/orders-paid`
(the subscriber needs order read access). Use a development store with a test payment gateway,
so **no real charge occurs**. A live run needs explicit approval from the user every time.

Sources (open the pages for the configured `SHOPIFY_API_VERSION` and replace the version in
the URL if it differs):

- Development stores and test payments: https://shopify.dev/docs/apps/build/stores/development-stores
- Cart attributes carry over to the resulting order: https://shopify.dev/docs/api/storefront/2026-10/objects/Attribute
  (reviewed at `2026-01`)
- Storefront access scopes: https://shopify.dev/docs/api/usage/access-scopes
- Webhook topics (`orders/paid`): https://shopify.dev/docs/api/admin-graphql/2026-10/enums/WebhookSubscriptionTopic

**Unproven until a real supervised test:** that the paid order payload carries
`_coshop_haul` in `note_attributes` and a `cart_token` whose SHA-256 equals the digest of
the cart id token that CoShop bound at `cartCreate`. The fixtures assume this; if it does not
hold, every live order will report `attempt_unbound` or `cart_mismatch` and no recap is written
(fail closed).

## Supervised procedure (after authorization)

1. Start the server against the dev store with the secrets set (Node:
   `pnpm start`, exposed through an owner-approved tunnel). Deploying to Cloudflare
   needs separate authorization.
2. Dry check without an order: `node scripts/verify-shopify.mjs <base> --allow-cart-create --out=evidence.json`
   creates one Storefront cart, prints the checkout URL only to the terminal and
   releases the lock.
3. Paid check: `node scripts/verify-shopify.mjs <base> --allow-cart-create --await-paid=900 --out=evidence.json`;
   the authorized human opens the printed URL and completes a test-mode order.
4. Expected sanitized evidence: `evidence.json` with `catalogMode: "shopify"`,
   `checkoutHost`, `attempt`, `bagTotals`, and `paidRecap { id: "paid:<attempt>",
   mode: "paid", totalQuantity, totals, itemVariantIds }`; one log line with
   `outcome: "recorded"`; a redelivery from Shopify admin logs `duplicate`. Do
   not capture order numbers, customer data, checkout URLs or tokens.

## Cleanup

Cancel or refund and archive the test order in the dev store, delete the webhook
subscription, revoke the Storefront token and rotate the webhook secret, delete
the local `evidence.json` and any tunnel, and let the test room expire (24 h TTL by
default), which deletes all of its rows.
