# Interview walkthrough

Runtime candidate `f3351ac4cb612aa8bdf2d6bdaf12400d533636a0`. Use [the verified replay case study](case-study.md) and [review tracker](work-tracker.md) alongside this walkthrough.

## What I can demonstrate

Two people browse different products in one room. Sharing records a variant-specific find. Adding changes a distinct bag. Reloading gets a server snapshot. Walk through [the browser scenario](../../tests/design.spec.js) and [recorded reproduction](../evidence/reproduction.md), including the source revision attached to that older result.

## Why separate share and add?

Sharing is a suggestion. Adding is a purchasing decision. Combining them would let discussion silently change quantities. The cost is another explicit action. Trace [HoldUps](../../server/hold-ups.js), [Bag](../../server/bag.js), and command dispatch in [Rooms](../../server/rooms.js).

## What happens if two people edit together?

The server checks the bag revision inside the room mutation. The accepted mutation changes the revision, so a conflicting request must reconcile with current state. Persistent request identifiers also distinguish a retry from a new action. Show the exact transaction and regression in [bag tests](../../tests/phase4-bag.test.mjs), then walk through the final adversarial report once available. Revision conflicts and replay handling solve different problems.

## Why a Durable Object?

A room has one authoritative coordination point, with SQLite state next to its WebSocket connections. The [Worker](../../worker.mjs) routes room traffic and the [Node server](../../server.mjs) offers a local execution path using shared domain code. Separate deployment runtimes need their own transport tests even when their domain logic is shared.

## Why recheck checkout prices?

Catalog prices can change after a shopper sees them. [Checkout](../../server/checkout.js) rechecks variants, validates the subtotal and checkout host, and returns a review error when necessary. Its lease prevents overlapping bag changes during checkout preparation. Trace [checkout fixtures](../../tests/phase5-checkout.test.mjs). These fixtures do not verify Shopify payment.

## What makes payment attribution difficult?

A browser redirect cannot prove payment. The [webhook parser](../../server/order-webhook.js) authenticates raw request bytes and the [Haul service](../../server/haul.js) connects a paid order to a prepared snapshot. Network ambiguity can leave a cart created externally without a saved response locally. Duplicate delivery and delivery order must be tested separately. The candidate keeps ambiguous attempts until room expiry, resumes a bound checkout for its lease holder, and emits safe outcome diagnostics. Independent fixture results are recorded in the work tracker. An unbound ambiguous cart still needs external investigation and cannot produce a recap.

## What are the known limitations?

An unsent bag command is lost on reload. The client has no durable outgoing queue, so an add held before the server receives it disappears after a reload, with no explanation. A command the server already accepted survives reload without duplication. The independent verifier observed both behaviors (G2, G3) in the [UX audit](ux-audit.md#delivery-and-reload-probes). Shopper feedback for the dropped command is proposed and awaits user approval. An offline queue would be a new contract and is not planned here.

## What can I honestly claim about production?

Sample products and a simulated recap are available in the public demo. Existing integration fixtures are synthetic. Live checkout and paid attribution require an actual development-store test with explicit order approval. Describe the results attached to each tested SHA and environment. Local loopback convergence times do not measure internet latency or browser rendering.

