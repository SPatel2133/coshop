# CoShop portfolio preview

Build from the repository root with pinned pnpm and Node 24. Vercel uses the build in `vercel.json`, publishes `dist/client`, and sets public `VITE_ROOM_BACKEND_ORIGIN` to the isolated Worker's HTTPS origin. Browser HTTP and WebSocket connections go directly to the Worker. Invite links use the frontend origin.

Use the Wrangler environment `portfolio-preview` for the separate `coshop-portfolio-preview` Worker. It declares its own room and abuse-limit SQLite Durable Objects. Set an exact `ROOM_FRONTEND_ORIGIN` for the Vercel preview. Supply a new invite-signing secret through Cloudflare's secret mechanism and keep any Shopify test-store credentials and webhook secret in the Worker runtime. Start with the sample catalog.

Vercel documents external API rewrites and native Function WebSockets. External rewrite upgrade forwarding remains unverified for this app. Same-origin Cloudflare hosting would eliminate preflight and the second origin configuration, and simplify rollback. The candidate uses the requested split.

- [Vercel rewrites](https://vercel.com/docs/routing/rewrites)
- [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/)
- [SQLite Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

## Local check

Build assets with `VITE_ROOM_BACKEND_ORIGIN=http://127.0.0.1:4251` and serve a temporary copy of `dist/client` at `http://127.0.0.1:4250`. Run Wrangler locally in `portfolio-preview` on port 4251 with a unique persistence directory. Use a temporary environment file containing `ROOM_FRONTEND_ORIGIN=http://127.0.0.1:4250` and a separate synthetic signing secret. Rebuild without the Vite setting for a same-origin artifact.

## After preview approval

Read-only inspection found zero Worker scripts and no workers.dev subdomain on the connected Cloudflare account. Activate the subdomain and authenticate Wrangler only after preview approval. Create the isolated Worker, publish a Vercel preview against it, and set the exact preview origin on the Worker before testing. Use a public preview URL only for the authorized demo.

From two fresh browsers on the actual preview URL, verify fonts and WebPs, HTTP preflight, the direct WSS upgrade and first-frame auth, invite join, exact Black variant and canonical image, share with unchanged bags, explicit add, refresh and reconnect. Verify Shopify handoff only with test-store configuration, without placing an order. Record the Vercel deployment and Worker version before requesting production authorization.

## Existing links and rollback

The current public Sites page still returns the older title “coshop — good finds, together.” The existing Sites URL is the rollback target for a failed preview. Its underlying deployment identifier and backend were not verified. Keep that host and runtime serving its existing invites through room expiry. Preview invites use separate room storage and signer. At a later cutover, changing signer or room namespace prevents existing invites from opening on the new backend, and changing frontend origin leaves browser-local seat tokens on the old origin. Preserve the legacy path for active rooms.

For production, capture the actual prior frontend deployment and paired backend version, origin settings and Durable Object namespaces before switching traffic. A Worker code rollback does not restore Durable Object data. No production cutover is part of preview authorization.

## Authorized preview record

- Vercel preview: `https://coshop-portfolio-preview-bpcp5g1ec-s668pate-7365.vercel.app`, deployment `dpl_2gs4DZQT6rJsXixAGyBu6tcAPX2w`, bundle `index-DUnKbkmG.js`.
- Cloudflare Worker: `https://coshop-portfolio-preview.coshop-portfolio-2133.workers.dev`, version `d53601bc-0659-477a-85c8-0dede924c2a7`, configured for the exact Vercel preview origin.
- The first deployment on the new Vercel project was automatically assigned to its production target. It was removed after the real Preview deployment was ready. The older CoShop Sites deployment was left in place.
- Three Playwright tests passed on the public preview, covering second-shopper invite joins, real room sync, exact Black photo and price, separate bag add, refresh, and reconnect. Shopify test-store configuration was unavailable for checkout verification.

## Authorized production launch

- Stable portfolio URL: `https://coshop-portfolio-preview.vercel.app/`
- Vercel deployment: `dpl_AdD4V7knGVWeZErBJX9Yy6wPsQN9`, bundle `index-CiBKXWXO.js`.
- Production Worker: `https://coshop.coshop-portfolio-2133.workers.dev`, version `12dfaac2-d8e6-4c2b-8189-be241e7ada56`. Its signing secret, room state and abuse-limit storage are separate from preview. Its cross-origin allowlist is the stable Vercel origin.
- The existing Sites URL and preview URL remain available for rooms created there. New portfolio links should point to the stable Vercel origin. Keep that origin and its Worker bindings together for future releases.
- GitHub main remained at `067b8a4` at launch. The deployment was built directly from the working tree.

The recruiter-facing production address is now `https://trycoshop.vercel.app/`. The original Vercel hostname remains active for existing invites. The production Worker allows these two exact production origins. Preview still has its own Worker and storage.

For later production Worker releases, follow the [backend rollout runbook](launch/backend-rollout.md).
