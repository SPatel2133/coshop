# Shopify checkout attribution: supervised dev-store runbook

> **Status: BLOCKED.** Do not run any live step until (1) the owner explicitly
> authorizes a test order on a named Shopify development store and (2) the
> secrets below are provisioned by the owner. Nothing in this repository places
> an order, and no production store may be used.

## Design and failure limits

Path: shared bag → `Checkout.start` (30 s lease, bag locked) → immutable
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
| `SHOPIFY_STORE_DOMAIN` | Development store `*.myshopify.com` domain |
| `SHOPIFY_STOREFRONT_TOKEN` | Storefront API token with exactly `unauthenticated_read_product_listings` (Product, Collection: the catalog) and `unauthenticated_write_checkouts` (Cart: `cartCreate`). CoShop reads only `availableForSale`, so no inventory scope is needed |
| `SHOPIFY_API_VERSION` | `.env.example` uses `2026-10`. On 2026-11-19 shopify.dev lists `2026-10` as the release candidate and `2026-07` as latest stable. Use the version the owner chooses and use the same version for the webhook subscription |
| `SHOPIFY_BUYER_COUNTRY` | Buyer country for pricing context |
| `SHOPIFY_WEBHOOK_SECRET` | Secret that Shopify signs `orders/paid` with (the app client secret, or the admin notifications secret) |
| `INVITE_SIGNING_SECRET` | Room invite signing; a fresh value used only for this test |

Webhook: topic `orders/paid` (`ORDERS_PAID`), JSON, endpoint
`https://<supervised host>/api/shopify/orders-paid`. The topic requires `read_orders` (or
`read_marketplace_orders`, which CoShop does not use) on the app that owns the subscription.
Use a development store with Shopify's test payment gateway: **no real charge occurs**.
Each live run needs explicit approval from the user.

Sources, checked on 2026-11-19 at `2026-10` (if a different version is configured, re-check
the same pages at that version):

- Development stores and test payments: https://shopify.dev/docs/apps/build/stores/development-stores
- Cart attributes carry over to the resulting order: https://shopify.dev/docs/api/storefront/2026-10/objects/Attribute
  (reviewed at `2026-01`)
- Storefront access scopes (`unauthenticated_*` table): https://shopify.dev/docs/api/usage/access-scopes
- `cartCreate`: https://shopify.dev/docs/api/storefront/2026-10/mutations/cartCreate
- `ORDERS_PAID` and its required scopes: https://shopify.dev/docs/api/admin-graphql/2026-10/enums/WebhookSubscriptionTopic
- `orders/paid` payload (`note_attributes`, `cart_token`): https://shopify.dev/docs/api/webhooks/2026-10

**Unproven until a real supervised test:** that the paid order payload carries
`_coshop_haul` in `note_attributes` and a `cart_token` whose SHA-256 equals the digest of
the cart id token that CoShop bound at `cartCreate`. The fixtures assume this; if it does not
hold, every live order will report `attempt_unbound` or `cart_mismatch` and no recap is written
(fail closed).

## Supervised procedure (only after authorization)

Run it with the Node server so that `--data-dir` can read the room database **read-only**.
Deploying to Cloudflare needs separate authorization.

1. Start the server with the secrets set and an empty data directory, keeping stdout:
   `DATA_DIR=<dir> pnpm start 2>&1 | tee server.log`. Expose it through a tunnel the owner
   approves, then register the `orders/paid` webhook to it (manual, in Shopify).
2. Dry check, no order:
   `node scripts/verify-shopify.mjs <base> --allow-cart-create --data-dir=<dir> --out=dry.json`.
   Expected: one attempt `A1`, server `outcome: "opened"`, `cartBound: true`,
   `snapshotSha256 == bagSha256`, `recapCount: 0`, lock released.
3. Paid run (two attempts, paid in reverse order, plus one redelivery):
   `node scripts/verify-shopify.mjs <base> --allow-cart-create --attempts=2 --await-paid=1200 --await-redelivery=300 --data-dir=<dir> --out=evidence.json`.
   The script prints two checkout URLs to the terminal only. The approved human pays `A2`
   first and then `A1` with the test gateway. When asked, they redeliver `A1`'s `orders/paid`
   delivery once from Shopify's webhook delivery tooling. Whether a real delivery can be
   resent depends on how the subscription was created, so check this at run time. If it
   cannot, record "redelivery not available": duplicates are then covered only by fixtures.
4. Capture the webhook log lines: `grep '"coshop.orders_paid"' server.log > webhook-log.jsonl`.
   Each line is `{event, outcome, webhookId}`, and nothing else is logged. Delete `server.log`
   once you have done this.

| Evidence | Expected | Meaning |
| --- | --- | --- |
| `evidence.json` `bagSha256` vs `server.attempts[*].snapshotSha256` | equal for `A1` and `A2` | The immutable snapshot equals the bag that was checked out (variant ids and quantities only; no names, pickers or room secrets) |
| `server.attempts[*]` | `A1` and `A2` both `outcome: "paid"`, `cartBound: true` | Each order matched its own attempt |
| `paymentOrder` / `server.recapOrder` | `["A2","A1"]` / `["A2","A1"]` | Both events are kept in receipt order; the newest receipt (`A1`) is shown |
| `paidRecap.id` | `paid:<A1 id>` | — |
| `redelivery.recapCountBefore` / `After` | `2` / `2` | Exactly one recap per order; the redelivery is a `duplicate` |
| Log outcomes in receipt order | `recorded`, `recorded`, `duplicate` | `recorded` proves the HMAC, topic and shop matched; the `_coshop_haul` note attribute named this room and attempt; and `sha256(order.cart_token)` equalled the stored cart hash. `unattributed` means the marker or `cart_token` was missing; `cart_mismatch` means the hashes differed |
| A rejected delivery (if any) | `rejected_signature`, `rejected_topic`, `rejected_shop`, `rejected_body` or `rejected_size` | Why the request got a 401 or 413 |

Do not capture order numbers, customer data, raw `note_attributes`, cart tokens, checkout
URLs, invites, session tokens or payloads. The attempt ids in `evidence.json` are random
UUIDs that are only meaningful inside the expired test room.

## Cleanup

The test gateway makes no charges, so no refund is needed. Remove only what this test
created: archive the test orders, delete the `orders/paid` subscription, revoke the
Storefront token if it was created for this test, stop the tunnel and the server, and delete
the test `DATA_DIR`, `server.log`, `webhook-log.jsonl`, `dry.json` and `evidence.json`. Do not rotate or delete shared secrets or
store resources that existed before the test. Any room data that is left is deleted when
the room expires (24 h `ROOM_TTL_MS` by default).
