# coshop · Phase 2

A shared shopping room for friends already on a call. This phase adds live product/category presence, away states, Peek, Join, and nearby shopper avatars on top of the secure six-seat rooms. Everyone has equal permissions. Keep Discord or FaceTime open; coshop does not provide calling.

**Current source:** Phase 2, runnable locally with Node or Cloudflare's local runtime. **Not yet published to Cloudflare.** The previous [Sites demo](https://coshop.valiantartichoke2.chatgpt.site) remains an older build; it does not demonstrate this phase.

![Live presence while browsing independently](docs/phase2-peek.jpg)

## Phase 2: try it with three windows

Use the same Node setup below, or the Cloudflare local runtime. Both apply migration 2 automatically. The current workspace preview is **http://localhost:4195**. To restart it in PowerShell after stopping the running server:

```powershell
$env:PORT='4195'
node server.mjs
```

1. Create a room as **Maya**. Open **Invite your people → Testing on one browser?** and use the two demo links for **Sam** and **Priya**. Refresh keeps each identity; ordinary tabs on the same browser share one identity.
2. In Maya's tab open **A little quiet**. In Sam's tab open **Time well spent** and select **Tan**. In Priya's tab choose the **Wear** category. Everyone's people strip should show these different places within about one second. No other product/category page should move.
3. From Maya's headphones page, tap Sam's avatar. **Peek** shows the watch, Tan variant and sample price. Close Peek: Maya should still be looking at the same headphones and variant; Sam stays on his watch and Priya stays in Wear.
4. Open Sam's Peek again and select **Join Sam here**. Only Maya should move to the watch, with **Tan** selected. Both watch pages show the other person's small avatar under **At this rack with you**. Tapping a nearby avatar also opens Peek.
5. Change Sam's variant while his Peek is open elsewhere. The Peek updates, while the viewer's underlying page stays put. The Join button uses the latest displayed location. A category Peek can join that category. Unavailable variants show a clear note and remain viewable; missing catalog items disable Join.
6. Leave Sam's tab untouched for 30 seconds. The other tabs should dim Sam's avatar and label it **Away**, retaining his last product. Move/click/type in Sam's page: he becomes active again. This is an activity signal only; no cursor coordinates, scroll position or search text is sent.
7. Navigate Sam's tab away and back to simulate disconnect without clearing demo session storage. His avatar gently exits the strip, but the room still reserves his seat for ten minutes. Returning restores the same identity and its saved product/variant. Refresh a product page: your own last accepted location returns without moving anyone else.
8. Test at phone width: the people strip stays sticky and horizontally scrollable; product pages and Peek remain usable. Invite links work between devices on the same Wi-Fi using the laptop's Wi-Fi address. A localhost URL opens only on this computer.

**Done looks like:** Maya, Sam and Priya browse independently; their location labels update promptly; Peek never changes a page; Join changes only the joiner's page and exact variant; same-product avatars appear; away/disconnect/reconnect behave correctly.

## Phase 2 implementation and acceptance

- One append-only event log derives presence. Only authenticated connections can record a view, using server-validated catalog IDs and categories. Client-supplied names/prices/images/identities are ignored.
- The server accepts at most one new view every **500 ms per participant across all tabs**. Clients coalesce rapid changes and keep the latest destination, retry throttled proposals, and reuse request IDs when acknowledgements are lost. Replays cannot duplicate an event or change its meaning.
- Navigation and idle changes send small participant deltas. Full snapshots are used for joining, membership changes and reconnect. Heartbeat-only traffic does not repeatedly broadcast a catalog or whole room.
- Product pages remain inside the storefront so the sticky presence strip stays usable. No leader/follower controls, approval counts, comparison board, or remote navigation commands return.
- Real interaction and heartbeat timestamps are separate. Idle is derived on the server; Cloudflare alarms deliver away transitions even when no one navigates. The Node adapter uses a lightweight timer. Browser page-hide/page-show handling closes sockets before the back/forward cache freezes a page and reconnects when it returns. Multiple tabs still occupy one seat, and any active tab can keep the identity active.
- Peek is local UI state. Opening/closing it sends no navigation event. Join publishes only the viewer's new location; the destination shopper has no special role or powers.

| Phase 2 check                                                         | Result                                                                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Append-only canonical views, identity scoping, validation             | Passed                                                                                             |
| Server throttle across multiple connections and idempotent replay     | Passed                                                                                             |
| Latest product/category/variant restored from SQLite                  | Passed                                                                                             |
| Heartbeat versus 30-second idle, wake and multi-tab behavior          | Passed                                                                                             |
| Expiry deletes event records; migration preserves existing identities | Passed                                                                                             |
| Actual Node and Cloudflare runtime, three clients                     | Passed: location deltas delivered within one second locally; away and reconnect snapshots verified |
| Client rapid navigation coalescing and stale-socket rejection         | Passed                                                                                             |
| Browser Peek preserves underlying page; Join moves only viewer        | Passed with Maya on headphones, Sam on Tan watch, Priya in Wear                                    |
| Browser refresh and nearby avatars                                    | Passed: same watch variant restored, other shoppers stayed put                                     |
| Browser away, navigation exit and Back                                | Passed: 30-second away labels, immediate exit, reserved seat and same-identity recovery            |
| Phone viewports                                                       | Passed: Peek and Join at 390px, sticky strip at 320px, no horizontal overflow; browser emulation   |

Phase 2 file changes:

| Files                                                                                           | Purpose                                                                                               |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `server/events.js`, `drizzle/room-object/0002_presence.sql`                                     | Shared event log, canonical view records, request replay and throttle                                 |
| `server/rooms.js`, `server/storage.js`, `server/config.js`, `server/realtime.js`                | Derived location/idle, activity clocks, versioned migrations, compact deltas and cleanup              |
| `server.mjs`, `worker.mjs`                                                                      | View acknowledgements, broadcasts, away timers/alarms and assets                                      |
| `client/presence.js`                                                                            | Stable avatar strip, live Peek, Join and same-product avatars                                         |
| `client/realtime.js`, `client/rooms.js`, `app.js`                                               | Coalesced navigation, state reconciliation, independent product/category pages and refresh restore    |
| `index.html`, `style.css`                                                                       | Sticky people strip, inline product page, category filters and responsive Peek                        |
| `docs/phase2-peek.jpg`, `docs/phase2-phone-peek.jpg`                                            | Desktop and phone browser proof using fictional identities                                            |
| `tests/phase2-*.test.mjs`, `tests/support/rooms.mjs`                                            | Phase 2 invariants, real-runtime checks and client queue tests; shared harness extracted from Phase 1 |
| `tests/phase1-domain.test.mjs`, `tests/phase1-transport.test.mjs`                               | Run foundation checks against the migrated schema; original acceptance assertions retained            |
| `package.json`, `.github/workflows/check.yml`, `scripts/build.mjs`, `.env.example`, `README.md` | Full checks, build label, documented idle configuration and this handoff                              |

`0001_rooms.sql` is unchanged. No Phase 3 Hold up/bag feature files were added. No new API vendor or paid service was introduced.

## Run with Node

Requires Node 24+ and pnpm 11.25.0. If needed, install pnpm with `npm install --global pnpm@11.25.0`.

```sh
pnpm install --frozen-lockfile
pnpm start
```

Open **http://localhost:4193**. The handoff preview in the current workspace uses **http://localhost:4195** because an older demo was using port 4193. In PowerShell, choose a port with `$env:PORT='4195'` before `pnpm start`.

The server binds to `0.0.0.0` for testing with phones on the same Wi-Fi. Open `http://YOUR-LAPTOP-WIFI-IP:4193` on both devices, substituting the chosen port. Keep the laptop running. Setting `HOST=127.0.0.1` restricts it to this computer. Clipboard access may be unavailable on a plain-HTTP phone connection; the invitation field supports selecting and copying manually.

No account or Shopify key is needed for Phase 2. Local data lives in ignored `data/phase1/rooms.sqlite`, separate from the old demo database. A random signing key is generated once in ignored `data/phase1/server-key` unless you supply `INVITE_SIGNING_SECRET`. Keep that key stable across restarts so existing invitations continue to verify. Do not commit it.

Optionally copy `.env.example` to `.env`. Empty `INVITE_SIGNING_SECRET` uses the generated local key. `DATA_DIR` can select another local database directory.

## Test with three browser windows

1. In window A, open the app, select **Start a shopping room**, optionally name it, enter **Maya**, choose an avatar and select **Make room**. Expect one connected person and the “You're the first one here” message.
2. Select **Invite your people**, then **Testing on one browser?** Open **demo shopper 1** and **demo shopper 2** in separate tabs/windows. These use separate demo session-storage keys, so one browser can represent three people. On separate devices or browser profiles, use the ordinary invite instead.
3. In B join as **Maya** with Clay; in C join as **Priya** with Lilac. Expect **Maya**, **Maya 2**, and **Priya**, the chosen avatars, and **3 / 6 seats** in every window. No one is a host or leader.
4. Refresh B. Expect **Maya 2 (you)** and still three seats. Normal tabs on the same browser share the same saved identity; they are not new participants.
5. Temporarily stop the server. Every window should retain its visible room and show **Reconnecting…**. Restart using the same data directory/key. Each window should reconnect automatically, receive a complete current snapshot, and retain its identity. **Retry now** retries immediately.
6. To test seats, navigate a demo tab away and back, or temporarily disconnect a real device. Its seat stays reserved for ten minutes after the final connection is lost. A silent network failure is detected after the heartbeat timeout. Returning during the reservation restores the person; after release, a valid old identity can return only if there is space. Demo identities persist across refresh/back navigation, but closing the demo tab ends its session storage; normal identities persist in local storage.
7. To test the limit, use six separate browser profiles/devices, or distinct `guest` values in the invite URL to create six demo identities. A seventh gets the full-room screen. Existing seated members can still refresh a full room. Reserved disconnected seats count toward six.
8. Open `/?room=invalid` to see the invalid-link screen. To test expiry quickly, use a **separate test data directory** with `ROOM_TTL_MS=10000`; leave it untouched for ten seconds, then retry the invite. Expect the expired-room screen. Do not use a short TTL on a database whose rooms you want to keep.

**Done looks like:** three distinct identities appear consistently, refresh never duplicates them, reconnect restores the current room, and simultaneous attempts cannot exceed six seats.

## Automated verification

```sh
pnpm build
pnpm test
node --test tests/shopify.test.mjs
```

`pnpm test` runs all 35 checks. It exercises the shared domain against SQLite and runs actual HTTP/WebSocket clients against **both Node and Wrangler's local Durable Object runtime**, including a race for the last seat. It does not replace Cloudflare with an in-memory fake. Tests use disposable databases and require ports 14294–14297 and 14304–14305 to be available.

Room foundation acceptance results, retained in this build:

| Check                                       | Result                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Simultaneous joins with five occupied seats | Exactly one accepted, one refused; six persisted, on both backends                                 |
| Valid/invalid session tokens                | Same person restored / invalid rejected without a room snapshot                                    |
| Duplicate names, Unicode, unsafe input      | Numbered names preserved; HTML/control characters rejected                                         |
| Six seats and reserved-seat readmission     | Enforced; released identity refused when room has filled                                           |
| Multiple tabs for one identity              | One person; closing one connection does not disconnect the other                                   |
| Inactivity and cleanup                      | Heartbeats do not extend expiry; participant/connection rows deleted; expired invites stay expired |
| Actual Cloudflare-runtime expiry            | Expired responses remain HTTP 410 after storage deletion                                           |
| Creation/join abuse controls                | Expiring atomic counters; no stored raw IPs                                                        |
| Three real browser tabs                     | Joined, synchronized and refreshed without duplication                                             |
| Browser reconnect after server restart      | All three recovered automatically with the same identities                                         |
| Browser responsive checks                   | 390px and 320px, no horizontal overflow; not physical iPhone testing                               |
| Build                                       | Worker bundle and static assets build successfully                                                 |

There are **17 room-foundation tests**, **13 Phase 2 tests**, and **5 existing Shopify-client regression tests**. Shopify regressions use fixtures; they are not a live Shopify verification of this phase. GitHub Actions installs dependencies, builds the Worker, then runs these checks.

## Data and concurrency

Production target: **one SQLite-backed Durable Object per room**, with hibernating WebSockets. Its synchronous transaction commits capacity checks and participant inserts together. There is no second D1 copy of room state. A second Durable Object class handles expiring abuse counters, addressed by a temporary keyed hash of the source IP and time window.

The Node adapter uses built-in `node:sqlite`, the same SQL schema, and `BEGIN IMMEDIATE` transactions. Room metadata is in `room_records`; identities in `participants`; live connection leases in `connections`. Only display names and the optional room title are user-entered text. Avatars are preset identifiers. There are no emails, accounts, recordings, raw stored IP addresses, or user-agent profiles. Logs do not record bodies or tokens; direct Cloudflare observability is disabled in the configuration.

Migrations: [`0001_rooms.sql`](drizzle/room-object/0001_rooms.sql) and the new [`0002_presence.sql`](drizzle/room-object/0002_presence.sql). They run at Node startup / object initialization and record schema versions 1 and 2. Version 2 adds the shared event log and a separate connection activity timestamp; it preserves existing rooms and token hashes. Future changes need new migrations, not edits to an applied version. `wrangler.jsonc` also declares the `v1-rooms` SQLite class migration. Original D1 SQL files/journal remain unchanged for the legacy deployment.

Room activity means creation, a new join, or a throttled actual interaction in the room. Heartbeats, reconnect attempts, snapshots and avatar connection updates do not keep an abandoned room alive. Room expiry deletes application records; Durable Object expiry also deletes the object's storage. No expired participant/event archive or identity-bearing tombstone is retained. The `events` table now stores append-only `view` events with room/user/product/variant IDs, a canonical JSON payload and server timestamp. Presence is derived from each participant’s latest view. Event records are deleted with the room. Later event types are reserved in the schema but are not implemented by Phase 2.

A valid signed invitation to an absent room produces **expired**; a forged/malformed invitation produces **invalid**. This distinction needs no expired-user records. Node performs periodic cleanup; Durable Objects use alarms. Access is denied at the expiry deadline even if background cleanup runs slightly later.

Membership tokens contain 256 random bits and are stored as SHA-256 hashes on the server. Invitation signatures and membership tokens are separate credentials. API authentication uses a Bearer header; WebSockets authenticate in the first frame, never the URL or WebSocket subprotocol. Only an authenticated connection receives room state. Incoming origins, body/message sizes, and avatar/name values are checked server-side; names render through `textContent`.

The old UUID + SHA-256 token scheme was cryptographically sound. Phase 1 creates a new room schema/namespace with new tokens; legacy rooms/tokens are not silently mapped by name or imported. The old hosted app remains available while this replacement is tested.

Clients reconnect with exponential backoff and jitter, capped around 15 seconds, and get a full snapshot on every authenticated connection. Default heartbeat interval is 20 seconds; a 65-second missed-heartbeat timeout detects silent loss. Clean disconnects reserve the seat immediately. Connected tabs belonging to one person share one seat. Membership is authoritative on the server; browser storage retains only that browser's credential.

## Configuration

| Variable                   | Default / purpose                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `INVITE_SIGNING_SECRET`    | Required in production, 32+ random characters; generated/persisted for Node locally |
| `PORT`, `HOST`             | Node only: `4193`, `0.0.0.0`                                                        |
| `DATA_DIR`                 | Node only: `data/phase1`                                                            |
| `ROOM_TTL_MS`              | `86400000` — 24 hours without actual activity                                       |
| `SEAT_RESERVATION_MS`      | `600000` — ten minutes after disconnect                                             |
| `HEARTBEAT_INTERVAL_MS`    | `20000`                                                                             |
| `PRESENCE_IDLE_MS`         | `30000` — actual interaction idle threshold; heartbeats do not reset it             |
| `HEARTBEAT_TIMEOUT_MS`     | `65000`                                                                             |
| `CREATE_LIMIT_PER_HOUR`    | `10` per IP/window                                                                  |
| `JOIN_LIMIT_PER_10_MIN`    | `60` per IP/window, including invitation/session/connection attempts                |
| `SHOPIFY_STORE_DOMAIN`     | Environment configuration only; no hard-coded store                                 |
| `SHOPIFY_STOREFRONT_TOKEN` | Public Storefront token, never an Admin/private token                               |
| `SHOPIFY_API_VERSION`      | Set explicitly; example config uses `2026-10`                                       |
| `SHOPIFY_BUYER_COUNTRY`    | Set explicitly; example config uses `CA`                                            |

Keep heartbeat interval comfortably below its timeout. Limits apply to a shared source IP, including several devices on one Wi-Fi. A quota response includes `Retry-After`; the interface does not loop aggressively through it.

## Cloudflare local runtime and deployment

No Cloudflare login is needed for local tests:

1. Copy `.dev.vars.example` to `.dev.vars` and fill `INVITE_SIGNING_SECRET` with 32+ random characters. Generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Keep it out of chat and Git.
2. Run `pnpm build`, then `pnpm dev:cloudflare`.
3. Open http://localhost:4194. Wrangler persists local Durable Objects under ignored `.wrangler/`.

Direct publication needs a free Cloudflare account because the existing Sites hosting contract exposes D1/R2, not Durable Object bindings. **Do not deploy this source through Sites**: `.openai/hosting.json` identifies the old site and is retained for provenance. Its generated legacy bundle is no longer tracked or produced. `pnpm build` creates `dist/client/` plus the direct Worker bundle `dist/server/worker.js`; Wrangler deploys `worker.mjs` and assets using `wrangler.jsonc`.

When ready to publish:

```sh
pnpm exec wrangler login
pnpm exec wrangler secret put INVITE_SIGNING_SECRET
pnpm deploy:cloudflare
```

Complete Cloudflare login yourself. The signing secret must be stable across deploys. Configure other environment values in Cloudflare's Worker settings. No paid plan or custom domain is required; a `workers.dev` address is sufficient. The app has not been uploaded to a user-owned Cloudflare account by this phase.

Why Durable Objects rather than Supabase: one authoritative room object naturally owns capacity and connection ordering without adding a second provider. The [documented Cloudflare Free plan](https://developers.cloudflare.com/durable-objects/platform/pricing/) includes 100,000 object requests/day, 13,000 GB-s/day, 5 million SQLite rows read/day, 100,000 written/day and 5 GB storage. Workers have a separate 100,000-request daily limit. Exceeding Free limits rejects operations; free does not mean unlimited. Hibernating sockets avoid keeping the object continuously active. Supabase's alternative [Free limits](https://supabase.com/docs/guides/realtime/limits) include 200 concurrent connections and 100 messages/second, with [2 million messages/month](https://supabase.com/docs/guides/realtime/pricing).

## Shopify and later phases

Phase 2 displays the clearly labelled sample catalog. Product/category/variant presence, Peek, Join and nearby avatars are implemented. Hold up, the bag, Shopify checkout and recap are **not implemented by this phase**. No inert purchase controls pretend otherwise. Sound remains absent/muted.

`catalog.mjs`, the reusable Shopify client and legacy storefront domain source are retained. The client now requires an explicit API version; the application config reads all four Shopify values from the environment. The public Hydrogen store can be configured using the public example credentials in [Shopify's official Hydrogen documentation](https://shopify.dev/docs/api/hydrogen/2026-04); they are not embedded in application code. Live catalog caching, country-context pricing, cart warnings and checkout will be wired and verified in Phase 5.

Legacy `room-domain.mjs`, `scripts/benchmark.mjs`, `scripts/verify-shopify.mjs`, their reports, and the three old domain/room/worker test files describe the previous API. They are retained for reference, are not imported by the current server, and are not part of the current test command. Do not use their historical results as proof of this version. The legacy verifier now reads credentials from environment variables. The original D1 migrations and old screenshots are unchanged.

Phase 6 will distinguish a verified server-side Shopify order from an explicitly labelled simulated demo completion. Returning from checkout will not count as proof of a purchase. That work is deferred until its phase is approved.

## Phase 1 foundation file handoff

| Files                                                             | What changed / why                                                                                                                             |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`, `app.js`                                            | Replaced old leader/approval/table flow with create, join, avatars, room shell and error screens; retained sample storefront and ASCII artwork |
| `style.css`, `mobile.css`                                         | Additive Phase 1 styles, keeping the neutral palette, typography and artwork                                                                   |
| `client/rooms.js`                                                 | New screen and participant rendering                                                                                                           |
| `client/session.js`                                               | New persisted normal identity / isolated demo identities                                                                                       |
| `client/realtime.js`                                              | New authenticated WebSocket, heartbeat, backoff and resync lifecycle                                                                           |
| `server.mjs`                                                      | Replaced snapshot/polling API with shared room rules, SQLite, WebSockets and local cleanup                                                     |
| `worker.mjs`                                                      | Replaced D1 snapshot API with room/abuse Durable Objects, alarms and WebSockets                                                                |
| `server/rooms.js`                                                 | New authoritative room/admission/reservation/expiry rules and HTTP responses                                                                   |
| `server/participants.js`                                          | New validation, name collision handling and avatar allowlist                                                                                   |
| `server/security.js`                                              | New independent invite/session credentials, hashing and origin checks                                                                          |
| `server/abuse.js`                                                 | New atomic expiring IP-derived quotas                                                                                                          |
| `server/storage.js`, `server/config.js`, `server/realtime.js`     | New shared SQLite adapters, environment config and protocol helpers                                                                            |
| `drizzle/room-object/0001_rooms.sql`, `wrangler.jsonc`            | New SQL schema, class migrations and direct deployment bindings                                                                                |
| `.env.example`, `.dev.vars.example`, `.gitignore`                 | New documented config; ignore secrets, local state and generated output                                                                        |
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`           | WebSocket/runtime dependencies pinned, reproducible install, allow build scripts only for esbuild/workerd                                      |
| `scripts/build.mjs`                                               | Replaced concatenation with static-asset copy and Wrangler validation/bundle                                                                   |
| `.github/workflows/check.yml`                                     | Installs, builds and runs current checks                                                                                                       |
| `tests/phase1-domain.test.mjs`, `tests/phase1-transport.test.mjs` | New invariant, transport, race, expiry and recovery checks                                                                                     |
| `shopify.mjs`, `tests/shopify.test.mjs`                           | Remove hard-coded API version; preserve and check client behavior with explicit config                                                         |
| `room-domain.mjs`, `scripts/verify-shopify.mjs`                   | Mark legacy engine; remove embedded demo credentials from verifier                                                                             |
| `docs/phase1-room.jpg`, `docs/phase1-phone.jpg`                   | New browser proof using fictional demo identities                                                                                              |
| `README.md`                                                       | This phase's complete setup, test procedure, results and scope                                                                                 |

Unchanged source/assets: `catalog.mjs`, `font.woff2`, `OFL-PlusJakartaSans.txt`, historical screenshots/reports, original D1 migrations and Sites identity. Generated `dist/` output is no longer version-controlled. No placeholder files for later phases were added.

## Design credits

Retains the ElevenLabs-inspired neutral direction, bundled Plus Jakarta Sans (SIL OFL), original ASCII interference animation, and illustrative Unsplash sample photography. Preset faces are text, not collected photos. Reduced-motion settings disable animation. Phone checks are browser emulation, not a claim of physical-device testing.
