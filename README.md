# CoShop

CoShop lets friends shop the same catalog while staying on their own product pages. When you share a find, everyone sees the exact size or color you picked in **Our finds**. The **Shared bag** holds the items the group decides to buy.

**[Try the public demo](https://trycoshop.vercel.app/)** · Sample catalog · No sign-in or installation. The hosted build predates the release candidate’s **Our finds** launcher and clickable share alerts. Run this branch locally to try those updates.

## Try it in two windows

| Do this | Look for this |
| --- | --- |
| Start a **Sample catalog** room. Copy its invite and open it in a private window or on a second device. | Both shoppers appear in the room and can browse independently. |
| In the first window, use **Quick add** on **Over-Ear Headphones**, select **Black**, and click **Share find**. | In the second window, choose **View find** on the alert or open **Our finds** from the toolbar. On the older hosted build, use **Around the room** instead. Both bags stay at zero. |
| Click **Add to bag** in the first window. | Both bag counts become **1**. Refresh the second window to see the find and bag persist. |

![CoShop product gallery and the shared Black headphone find with an empty bag](docs/images/coshop-demo.jpg)

## How the room stays in sync

- **React and Vercel** serve the storefront, catalog, Quick add, and product galleries. Each shopper controls their own view.
- **Cloudflare Workers** handle room HTTP requests and direct WebSockets. The invite points to the frontend. Member sessions authenticate in the first WebSocket frame.
- **SQLite-backed Durable Objects** coordinate room state, ordered events, chat and per-variant comments, and reconnect snapshots. Sharing records a find for the exact variant. Adding changes a distinct bag projection. Ordered server acknowledgements and request IDs keep explicit mutations consistent across clients and retries.

## What the demo includes

The public demo uses sample products and reference prices. **Demo completion · simulated** shows a Haul recap without payment. The optional Shopify path uses the Storefront API for catalog data, price and availability checks, and cart creation. [Shopify fixture tests](tests/phase5-attribution.test.mjs) exercise cart and signed webhook handling with synthetic data. Live paid-order attribution still needs a supervised Shopify development-store test.

## Run locally

Use Node 24 and pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile
pnpm start
```

Open [localhost:4193](http://localhost:4193). Node creates a local signing secret and room database when needed. For a Cloudflare simulation, copy `.dev.vars.example` to `.dev.vars`, set a local-only signing secret, build, and run `pnpm dev:cloudflare` at [localhost:4194](http://localhost:4194).

```sh
pnpm build                                      # Vite production build and Worker dry run
pnpm test                                       # Node and local Cloudflare transport and domain tests
pnpm exec playwright install chromium
pnpm exec playwright test tests/design.spec.js --workers=1
```

The browser suite defaults to port 4204. Start a preview server with a fresh `DATA_DIR`, `PORT=4204`, `CREATE_LIMIT_PER_HOUR=100`, and `JOIN_LIMIT_PER_10_MIN=150` using `pnpm start:preview`. Set `COSHOP_TEST_URL` to point the browser suite at a different isolated server. Vercel's assets-only command is `node scripts/build.mjs --assets-only`, with output in `dist/client`.

See the [deployment runbook](docs/portfolio-preview.md) for preview isolation, origin settings, and rollback. Keep Shopify credentials, webhook secrets, and invite-signing secrets in server runtime configuration.

## Engineering evidence

- [Reproduce the three-shopper check and open the Playwright report](docs/evidence/reproduction.md).
- [Measure local share convergence and inspect the raw trials](docs/evidence/benchmark.md).
- [Trace a rate-limit response from symptom to recovery](docs/evidence/diagnosis.md).

Sharing records an exact variant in the room. An explicit add changes the bag. The [room command handling](server/rooms.js), [sharing implementation](server/hold-ups.js), and [browser regressions](tests/design.spec.js) show how the two actions stay separate.

## Reconnection and release checks

On reconnect, the client takes the authoritative room snapshot. If an in-flight bag update timed out offline, CoShop asks the shopper to review the bag because the server may already have accepted it. The client does not replay that update.

The draft PR links the GitHub Actions run for its exact candidate commit. See the [branch’s CI history](https://github.com/SPatel2133/coshop/actions?query=branch%3Areview%2Fcoshop-release-candidate), the [architecture notes](docs/launch/architecture.md), and the [supervised Shopify test procedure](docs/shopify-live-verification.md).
