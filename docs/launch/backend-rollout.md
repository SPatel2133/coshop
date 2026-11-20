# Production backend rollout

This runbook releases the CoShop room backend to the production Cloudflare Worker. Every step that changes production needs explicit approval first.

- **Target:** Worker `coshop`, using the top-level Wrangler environment (`--env=`). Its public origin is `https://coshop.coshop-portfolio-2133.workers.dev`.
- **Never target** `portfolio-preview` (`coshop-portfolio-preview`). Preview has its own room storage, abuse-limit storage, signing secret and origins.
- **Frontend:** Vercel serves the frontend separately. Leave it out of a backend rollout unless the frontend bundle changed.

## Production state before this rollout

Recorded 2026-11-19 from read-only Cloudflare inspection and public HTTP.

| Item | Value |
| --- | --- |
| Frontend | `https://trycoshop.vercel.app/` serves `index-DcdKKuEi.js` and `index-g4cDBWjh.css`, built from `28ab8e8` with `VITE_ROOM_BACKEND_ORIGIN` set to the Worker. It is Vercel deployment `dpl_Dgifn7mHfuCMnUnRjd4gRP5HV4nD` (production target, uploaded from the CLI). |
| Active Worker version | `41f35bc0-070c-4255-9522-f8e5d39610d1` at 100% of traffic, released from `28ab8e8` on 2026-11-20; `GET /api/version` reports that commit. The previous release is `b54ddaa4-c28d-4773-a921-3b9bcaeae8cb` (`e6d9249`), and before it `5a68859d-3695-4032-b909-1c250e62fc2e`. |
| Worker source revision | `86d9112`, taken from the deployment message `GitHub release 86d9112… - add production alias`. That message is the only revision evidence. The Worker has no `/api/version` route. |
| Room storage | `ROOMS` binds to the `coshop` script's `RoomObject` SQLite Durable Object namespace. |
| Rate limits | `ABUSE_LIMITS` binds to the `coshop` script's `AbuseObject` SQLite Durable Object namespace. |
| Assets | `ASSETS`, from `dist/client`. Only `/api/*` runs the Worker first. |
| Invite signing | `INVITE_SIGNING_SECRET` is a secret binding. It is not in `wrangler.jsonc`. |
| Approved frontend origins | `ROOM_FRONTEND_ORIGIN` is a plain-text variable set only in the Worker settings: `https://coshop-portfolio-preview.vercel.app,https://trycoshop.vercel.app`. |
| Durable Object migrations | Tag `v1-rooms`, the same as `wrangler.jsonc`. No class migration is pending. |
| Observability | Off on the active version. |

### What preserves current rooms and invites

- **Room data.** A deploy to the same script keeps the class names `RoomObject` and `AbuseObject` on the same namespaces. Existing rooms and limits stay in place.
- **Invites.** Wrangler keeps secret bindings on deploy, so the signing secret stays the same and current invites and seat tokens keep working.
- **Origins.** `--keep-vars` keeps `ROOM_FRONTEND_ORIGIN`. Without it, a deploy from `wrangler.jsonc` deletes that variable and breaks cross-origin access from the Vercel frontend. `pnpm run deploy:cloudflare` always passes `--keep-vars`.
- **No preview settings.** Never copy preview bindings, secrets or origins into production, and don't pass `--var` for production secrets.

## What the release changes

These are the backend changes from the deployed `86d9112` to this release:

- **Checkout resume:** `server/checkout.js` and `server/haul.js`. A checkout lease remembers its hosted checkout URL, and checkout attempts record an outcome.
- **Migration 0008:** `drizzle/room-object/0008_checkout_resume.sql` adds `checkout_leases.checkout_url` and `haul_checkouts.outcome`. Attempts that already have a cart are marked `opened`. Each room's Durable Object runs the migration the first time it starts on the new code.
- **Committed bag-command replay:** `server/rooms.js`. If a client retries a bag change the server already accepted, it gets the original acknowledgement back, even while checkout locks the bag.
- **Generic errors:** `server/realtime.js` and `worker.mjs`. Unexpected failures return `SERVER_ERROR` and nothing internal.
- **Webhook outcome logging:** `server/order-webhook.js` and `worker.mjs`. The log records only the outcome and a well-formed webhook ID.
- **Build marker:** `GET /api/version` returns `{"commit":"<40-hex SHA>"}`, or `"unknown"` when no commit was stamped. It returns only the commit, with no account identifiers, configuration or credentials.

### Migration checks

All on disposable local Wrangler storage, never production:

- **Fresh storage:** schema versions 1–8 are recorded, and a bag add succeeds.
- **Upgrade:** a room built on `86d9112` (schema 7) had a bag line plus synthetic checkout rows added, one with a cart and one without. After the candidate started on the same storage:
  - Schema 8 was recorded.
  - The existing seat token resumed with 200.
  - The bag was unchanged.
  - The pre-upgrade invite still admitted a new shopper (201).
  - New bag changes succeeded.
  - The attempt with a cart reads `outcome='opened'`, the one without reads `pending`, and the lease gained an empty `checkout_url`.
- **Code rollback:** `86d9112` started again on the upgraded storage. It resumed the same room (200) with the bag and all three shoppers, and accepted a new bag change.

## Persisted Worker logs

This rollout keeps `"observability": { "enabled": false }`, the same as the active production version, so it changes no logging settings. Persisted logs are a separate approval decision.

- **Enabling them:** replace that line in `wrangler.jsonc` with the following, merge, and run the normal release:

  ```jsonc
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1,
    "redact_query_string": true,
    "logs": { "enabled": true, "head_sampling_rate": 1, "invocation_logs": false, "persist": true },
    "traces": { "enabled": false },
  },
  ```

- **What gets recorded:** the `console.log` outcome line from `logWebhook` in `server/order-webhook.js` (outcome plus a well-formed webhook ID), the `console.warn` in `server/checkout.js`, and uncaught exceptions. Invocation logs and traces stay off because request URLs carry signed invites.
- **Why it isn't needed now:** the sample demo never calls the webhook or checkout paths, and production has no Shopify configuration. Without persisted logs those lines are still visible live through `wrangler tail`.

## Approval gate

Before any production command:

1. This change is merged to `main`, and GitHub Actions passed `test` and `browser` on the merge commit.
2. You approved the exact SHA to deploy. Call it `SHA` below.
3. Wrangler is logged in to the account that owns `coshop`.
4. Optional: from `https://trycoshop.vercel.app/`, create a controlled sample room and keep its invite private. You'll use it after the rollout to confirm older invites still work.

## Dry run, from the exact SHA

```sh
git fetch origin
git switch --detach "$SHA"
git status --porcelain                     # must be empty
pnpm install --frozen-lockfile
pnpm exec wrangler deployments status --name coshop   # expect the new version at 100%
pnpm run deploy:cloudflare                 # dry run
grep -c "\"$SHA\"" dist/release/worker.js  # expect a non-zero count
```

`scripts/worker-release.mjs` refuses to run on a checkout with modified or untracked files, so use a fresh checkout rather than one where the browser suite left `test-results/`. It deletes `dist/release` first and fails if the new bundle does not contain the checkout's commit, so a stale bundle cannot pass. It reads the commit with `git rev-parse HEAD` and builds the same-origin assets. Then it runs:

```sh
wrangler deploy --env= --keep-vars \
  --define COSHOP_BUILD_COMMIT:"$SHA" \
  --message "GitHub release $SHA" \
  --dry-run --outdir dist/release
```

The dry run must list exactly `env.ROOMS (RoomObject)`, `env.ABUSE_LIMITS (AbuseObject)` and `env.ASSETS`. The commit is never written in the source; the build substitutes it.

## Deploy (approved SHA only)

```sh
pnpm run deploy:cloudflare --deploy
```

This runs the same command without `--dry-run`. The new version gets 100% of traffic.

## Post-release checks

- [ ] `curl -s https://coshop.coshop-portfolio-2133.workers.dev/api/version` returns `{"commit":"<SHA>"}`.
- [ ] `pnpm exec wrangler deployments status --name coshop` shows the new version at 100%, with the message `GitHub release <SHA>`.
- [ ] `https://trycoshop.vercel.app/` still serves the intended frontend bundle.
- [ ] A fresh two-shopper sample flow passes at 390 px and 1440 px, including reconnect.
- [ ] No new Worker errors: keep `pnpm exec wrangler tail coshop --format pretty` open during the checks, and confirm the error count in the Worker's dashboard metrics stays flat.
- [ ] If you created a controlled pre-release room, its invite still joins.
- [ ] Update the README backend status only after the checks above pass.
- [ ] Physical iPhone Safari and production Shopify paid-order attribution stay marked unverified unless someone tests them with authorization.

## Rollback

Roll the Worker code back to the previous version:

```sh
pnpm exec wrangler rollback b54ddaa4-c28d-4773-a921-3b9bcaeae8cb \
  --name coshop --message "Roll back to e6d9249"
```

- **Data is not rolled back.** Migration 0008 stays applied, and so do any room changes made in the meantime. `e6d9249` and the older `86d9112` (`5a68859d-…`) both run on schema 8 storage.
- **`/api/version` reports the rolled-back commit.** Only rolling back to `5a68859d-…` (`86d9112`) makes it return 404.
- **Leave the frontend alone.** A backend rollback doesn't need a Vercel change.

## README wording after verification

Once the post-release checks pass, replace the **Hosted backend status** paragraph with:

> **Hosted backend status.** The public demo runs release `<SHA>` on both the Vercel frontend and the Cloudflare Worker. `GET https://coshop.coshop-portfolio-2133.workers.dev/api/version` reports the Worker's build commit. Physical iPhone Safari and live Shopify paid-order attribution remain unverified.
