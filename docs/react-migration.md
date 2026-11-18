# CoShop React migration

The React entry is `react/index.html` and `react/main.jsx`. The active rendering layer includes landing, create/join/status, room and presence, catalog and product, invite, activity, comment and chat interfaces, Peek, bag and checkout state, and haul. Obsolete DOM renderers and the root HTML/CSS entry were retired. The pre-migration diff is available in the evidence folder.

## Ownership

- `room-store.js` owns one session and socket. It republishes server snapshots and deltas, holds the independent local view, and guards async work by room or identity. React subscribes with `useSyncExternalStore`.
- `bag-model.js` retains revision and price reconciliation, pending projections, request-ID matching, picker rules, checkout preflight, and lock release. The visible count represents accepted state.
- `discussion-model.js` owns keyed histories, drafts, submit and retry IDs, and rating reconciliation. The panel retains the same DOM while switching between desktop and mobile presentation.
- The code reuses `RoomConnection`, the session helpers, `FindsState`, `MessageHistory`, and the exact location resolver. React owns all visual markup. Collection rendering is memoized across live updates.
- The native dialog wrapper owns backdrop, modality, page lock, transitions, and dismissal. Unique dismissal intents prevent an old exit from closing another presentation.

## Build and serve

React and React DOM 19.3.1 render the client. Vite 8.3.8 bundles JSX, CSS and the existing Jakarta font to `dist/client`. The asset directory is isolated from the Wrangler Worker bundle. Node serves only the built shell and generated JS/CSS/font names. The existing Worker paths serve the same assets and handle the same API routes.

- `pnpm install --frozen-lockfile`
- `pnpm start` builds assets and starts Node. Default URL is http://localhost:4193.
- `pnpm build` builds the production client and performs a Wrangler dry run.
- `pnpm start:preview` serves the existing production bundle with Node.
- `pnpm build` then `pnpm dev:cloudflare` serves the local Worker.
- `pnpm test` builds assets and exercises the existing service suite plus frontend serving and model tests.
