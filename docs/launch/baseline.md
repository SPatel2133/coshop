# Reproducible baseline

Independent execution by [Devin baseline reviewer](https://app.devin.ai/sessions/a5c5bc19a9df49a68c9a37a6fedc9192), 2026-11-19. These results describe the original baseline, before checkout fixes.

Source SHA `2b53c5229e8cc77111c41b9dd36a280a45772495`, clean fresh clone, Linux x64, Node v24.22.3, pnpm 11.25.0.

| Command or setup | Observed result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed |
| `pnpm build` | Vite production build and Worker dry-run passed |
| `pnpm test` | 70 passed |
| `pnpm start` | Local Node frontend GET returned 200, room create and join returned 201 |
| Local `.dev.vars` with a disposable signing secret, then `pnpm dev:cloudflare` | Frontend GET 200, create/join 201; three-shopper and Quick add browser checks passed |
| Install Chromium, start isolated preview at port 4204, then `pnpm exec playwright test tests/design.spec.js --workers=1` | 19 passed |
| `node scripts/evidence.mjs reproduce` | Passed |
| `node scripts/evidence.mjs measure` | Passed, local three-client baseline |
| `node scripts/evidence.mjs diagnose` | Passed |

## Prerequisites

Chromium needs a separate `pnpm exec playwright install chromium`; Linux CI needs `--with-deps`. The local Worker simulation needs `.dev.vars` and a local signing secret. Shopify secrets are unnecessary for sample tests. Use the [quick start](../../README.md#run-locally) and isolated runtime instructions in [reproduction](../evidence/reproduction.md).

## CI coverage decision

The original workflow ran the production build and `pnpm test`, excluding the browser suite and evidence commands. The [dedicated CI draft PR](https://github.com/SPatel2133/coshop/pull/1) adds those checks. Its candidate `b6fb28e9a4b086f677fca3df56f07d28d093d763` passed [CI run 44491244382](https://github.com/SPatel2133/coshop/actions/runs/44491244382) and remains an unmerged draft.

The files `tests/domain.test.mjs`, `tests/room.test.mjs` and `tests/worker.test.mjs` target legacy contracts. The reviewer traced their exclusion to commit `950cf65`, observed the old room test fail against current routes and the old worker test fail on its platform import, and found `room-domain.mjs` unused by current production entry points. They remain outside current CI. This does not certify the legacy implementation.

## Local Windows execution limit

The main agent used Node v24.22.3 and pnpm 11.25.0. Its full suite was blocked by the managed sandbox denying local loopback access to Wrangler (`connect EACCES 127.0.0.1:15347`). A second attempted mixed domain/transport subset had the same environment restriction. Neither is recorded as passing. Independent fresh Linux results above cover execution on that environment.

Final combined candidate results must be recorded separately after integrating the focused branches without merging or deploying.
