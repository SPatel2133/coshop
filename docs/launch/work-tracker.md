# Integration work tracker

## Current status

Updated 2026-11-19. Read this first. The sections below are chronological, so rows marked pending there describe the state when they were written.

- [Integration PR #3](https://github.com/SPatel2133/coshop/pull/3) is an unmerged draft. It combines checkout [PR #2](https://github.com/SPatel2133/coshop/pull/2) head `ae2d286f4a6e97ce32c1500662a1693d6c7f0ef6` with CI [PR #1](https://github.com/SPatel2133/coshop/pull/1) head `b6fb28e9a4b086f677fca3df56f07d28d093d763`, plus this documentation set.
- Tested integration commit `8690efcf4b50be29c123bdf9ddef8c5d42dea7bb` passed [CI run 44495198821](https://github.com/SPatel2133/coshop/actions/runs/44495198821): build, 87 tests, 19 browser tests and all three evidence commands. A fresh Linux clone (Node v24.22.3, pnpm 11.25.0) gave the same results, with evidence reporting `dirty=false`. The [sanitized CI artifact](https://github.com/SPatel2133/coshop/actions/runs/44495198821/artifacts/14514866670) expires 2026-12-03. Later commits on PR #3 change documentation only.
- After `f3351ac`, runtime source changed only in `server/order-webhook.js` (`f037cd2`). That change logs a reason for each webhook rejection. The response is still a generic 401. Every other change after `f3351ac` touches the verifier script, tests or runbook.
- Independent verifier evidence: earlier evidence covers runtime candidate `f3351ac` ([case study](case-study.md)) and integration candidate `cfa00e7` ([G1–G3 probes](ux-audit.md#delivery-and-reload-probes)). The independent retest of the final verifier script and webhook at `ae2d286` is pending.
- Open gates:
  - The supervised live Shopify test needs development-store secrets and explicit approval to place an order.
  - Visual UX changes need user approval.
  - Merge and deployment need user approval.
- Nothing has been merged to main or deployed.

Started 2026-11-19 against `2b53c5229e8cc77111c41b9dd36a280a45772495`.

The requested priority order is baseline, checkout attribution, adversarial verification, UX audit and approval, then portfolio handoff. This document records ongoing work. It does not certify completion.

| Area | Owner | Candidate and evidence |
| --- | --- | --- |
| Fresh environment, setup and CI | Independent Devin [session](https://app.devin.ai/sessions/a5c5bc19a9df49a68c9a37a6fedc9192) | Baseline `2b53c52` verified ([baseline](baseline.md)). [PR #1](https://github.com/SPatel2133/coshop/pull/1) `b6fb28e` passed [CI run 44491244382](https://github.com/SPatel2133/coshop/actions/runs/44491244382). |
| Checkout, webhook attribution and verifier | Devin [session](https://app.devin.ai/sessions/d8d45d65a3b447bdb75b10b3f6b25701) | [PR #2](https://github.com/SPatel2133/coshop/pull/2) head `ae2d286`, retested in integration PR #3. Live Shopify is unverified. |
| Adversarial verification and UX recording | Independent Devin [session](https://app.devin.ai/sessions/1045c6a3a800452da98cf56473556601) | [Ranked UX audit, recording and G1–G3 probes](ux-audit.md) are ready. Visual changes are pending approval. |
| Integration review and portfolio documentation | Codex | [PR #3](https://github.com/SPatel2133/coshop/pull/3) is an unmerged draft. See current status above. |

## Gates

Live Shopify tests need development-store secrets and explicit approval to create a test order. Creating a cart alone does not verify checkout or payment. Local fixtures continue independently.

Proposed visual changes require user approval after the ranked UX findings and recording. Merging and deployment require user approval.

The supplied brief refers to earlier numbered phases and design requirements without including those documents. Current repository behavior and the requirements in the supplied priority section govern this work. Any visual implementation remains pending the explicit design review.

Existing unrelated untracked design notes and `.codex/` are preserved.

## Baseline results received

Independent baseline at clean `2b53c5229e8cc77111c41b9dd36a280a45772495`, Linux x64, Node v24.22.3 and pnpm 11.25.0, reports frozen install, production build, 70/70 repository tests, 19/19 browser tests, Node and local Cloudflare startup and all three evidence commands passing. [Draft CI PR](https://github.com/SPatel2133/coshop/pull/1) adds missing browser/evidence coverage. Its final candidate and CI results remain under review.

The Windows local suite hit managed-sandbox `connect EACCES 127.0.0.1:15347` during the Wrangler React fixture. This run is blocked, and the disposable Linux baseline supplies the independent execution evidence.

Independent adversarial probes confirmed replay-during-checkout and lost-checkout-response recovery defects. The checkout owner received both reproductions. Final fixes and independent retests are pending.

## Focused backend and integration candidates

- [CI PR #1](https://github.com/SPatel2133/coshop/pull/1), candidate `b6fb28e9a4b086f677fca3df56f07d28d093d763`, passed [CI run 44491244382](https://github.com/SPatel2133/coshop/actions/runs/44491244382). [Sanitized CI artifact](https://github.com/SPatel2133/coshop/actions/runs/44491244382/artifacts/14512961783) expires 2026-12-03.
- [Checkout PR #2](https://github.com/SPatel2133/coshop/pull/2), runtime candidate `f3351ac4cb612aa8bdf2d6bdaf12400d533636a0`, reports 87 tests and build passing. Live Shopify remains unverified. See the [supervised runbook](../shopify-live-verification.md).
- [Integration PR #3](https://github.com/SPatel2133/coshop/pull/3), combined candidate `cfa00e7bac781e6ff2806cfa1d12f6d43476146d`, reports a clean fresh Linux run of 87 tests, 19 browser tests, build, and all three evidence commands. CI and the final runbook update remain pending.

The original local working tree has the focused CI and checkout changes applied without a commit. Twelve selected attribution-domain tests and the public-error regression passed locally. The full local transport suite remains blocked by the Windows sandbox loopback restriction.

The [ranked UX review and recording](ux-audit.md) are ready. Proposed visual work is awaiting user approval. No branch has been merged to main and no deployment or live Shopify test was performed.
