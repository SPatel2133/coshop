# CoShop DESIGN.md implementation review

The November 18 attachment is the reference for this pass. The earlier repository DESIGN.md and React migration verification describe the previous design. The final production assets are index-uYeKuuN8.js and index-Bl2XQASW.css. The local preview uses the existing React/Node build on port 4204 with isolated sample data. Screenshots omit the address bar and invitation dialogs.

## Measurements

The spacing tokens in react/theme.css follow the 8px rhythm in [Atlassian spacing](https://atlassian.design/foundations/spacing), with 4px and 12px for compact groupings. The shared page gutters are 16, 24, and 32px, with 1280px maximum inner width. Room header, presence, disclosure, controls and the first grid track aligned at x=16, 24 and 80px at the three target sizes. The 80px at 1440px is the centered maximum width. The entry form uses a narrower 600px reading width with the same minimum gutters. The existing fluid landing vertical padding measured 48, 69, and 116px and product-detail gaps 8, 31, and 58px. These retain the existing landing rhythm and product image proportions. The Bag keeps 20px of bottom padding or the device safe area, whichever is larger.

| Width | Tracks | Gap | Measured photo | Drawer |
| --- | ---: | ---: | --- | --- |
| 360 | 2 | 12px | 158 × 118.5px | 344px, native modal |
| 768 | 3 | 16px | 229.33 × 171.98px | 352px, nonmodal |
| 1440 | 4 | 24px | 298.66 × 223.98px | 352px, nonmodal |

Metadata uses 8px above the first line and 4px between lines. At 1440px the previous desktop storefront had three large portrait frames. The final screenshots show four landscape frames in the same viewport. Images reserve the same frame while loading, and failed photos keep the same frame with an unavailable label. Sample metadata is available with the initial collection.

[Atlassian motion](https://atlassian.design/foundations/motion/applying-motion) informed purpose-based tokens for feedback and entry/exit. Entry is 240ms cubic-bezier(0, 0, 0.2, 1) with at most 12px of travel. Exit is 160ms cubic-bezier(0.4, 0, 1, 1). Controls use 120ms ease-out, and the accepted bag count uses a 150ms ease-out highlight. The share cue stays in its dedicated row. The solo art uses five rows and four frames at 0, 250, 500 and 750ms. The fifth sampled state stayed on frame four. Browser-emulated reduced motion zeroed drawer transition duration and showed the settled frame immediately.

## Acceptance checklist

| Area | Result and evidence |
| --- | --- |
| Shared spacing | **PASS** for measured room alignment, card metadata, gutters and drawer padding. The homepage, entry and room status share the tokens. **BLOCKED** for an exhaustive visual matrix of every uncommon error state at all three widths. |
| Responsive room | **PASS** at 360, 768 and 1440. Room and catalog stayed within the viewport. Long test room name wrapped, and the 450px-tall drawer kept its Close control reachable. |
| Our finds | **PASS**. Enter opens and focuses Close. A solo shopper can open Invite inside the mobile drawer. First Escape returns to Invite a friend and keeps the drawer locked. Second Escape dismisses the drawer, returns to the page opener, and restores the original 85px scroll and filter. Desktop remains nonmodal from 768px. The open drawer reserves space for the catalog and search. The underlying grid uses two columns at 768 and three at 1440 while the drawer is open. |
| Compact tiles | **PASS** for the measured grid, same-frame failed photo placeholder, keyboard card activation and focus return. |
| Catalog and detail | **PASS**. Audio and search combined to one result. Zero results reset the query and category. Returning from the Black variant restored the search, filter, origin card, and scroll in the checked flow. |
| Shared behavior | **PASS** with two independent Chromium contexts. While Sam stayed on Black, Maya shared Tan and moved on. Peek resolved the saved Tan variant. Draft text survived Peek. Sharing left the bag at zero. Add synchronized the confirmed count, and each shopper opened the simulated haul. A six-line bag kept its footer reachable at 360 × 450px. One socket on normal mount, browser offline/reconnect, actual copy in reviewer context and a denied-clipboard fallback passed. |
| Motion and ASCII | **PASS** for computed enter/exit timing, focus through dismissal, four art positions in fixed geometry, and emulated reduced motion. 4× desktop CPU throttling passed rapid Bag dismissal, focus return, and reopening. A frame-by-frame performance trace and physical device playback remain unverified. |
| Engineering | **PASS**. Frozen lockfile install, production build, 69 service/model tests and 9 browser tests passed. No lint or typecheck script is configured. |

The accessibility behavior follows [Atlassian accessibility](https://atlassian.design/foundations/accessibility). Connection and share feedback use status regions, clipboard denial selects the link, modal dialogs retain native focus containment, and keyboard focus remains visibly outlined. The browser suite exercised reduced motion and actual 200% page zoom in a temporary Chromium profile. The 1440px viewport reflowed to 720 CSS pixels at device pixel ratio 2, with usable keyboard dismissal and no horizontal page overflow. **BLOCKED** for screen-reader speech and a physical phone keyboard. Live Shopify checkout and paid recap remain covered by service fixtures.

## Independent review

The same reviewer retested final assets on a separate loopback server. Eight browser checks passed on that run. The open desktop panel kept Search, Invite, and Shared bag visible, and opening and closing preserved 487px of catalog scroll at both 768 and 1440px.

## Reproduce

- Run pnpm install --frozen-lockfile and pnpm build.
- In PowerShell, set `$env:PORT` to 4204, `$env:HOST` to 127.0.0.1, `$env:DATA_DIR` to an isolated temporary directory and `$env:CREATE_LIMIT_PER_HOUR` to 100 for repeat tests. Run pnpm start:preview.
- Run pnpm exec playwright install chromium once, then set COSHOP_TEST_URL=http://127.0.0.1:4204 and run pnpm exec playwright test tests/design.spec.js --workers=1.
- Optional COSHOP_EVIDENCE points to a local screenshot folder. The delivered room and open-drawer shots are in the sibling coshop-design folder. The earlier before-room-1440.jpg is in coshop-react.
- The first repeated browser batch on port 4203 reached the sample room creation limiter. It was rerun on a fresh isolated database with the above fixture-only limit. An exit assertion then waited on a role that disappeared during dismissal. The final test uses the persistent dialog selector and waits for entrance to settle before measuring exit.