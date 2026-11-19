# A committed add rejected on replay during checkout

Baseline `2b53c5229e8cc77111c41b9dd36a280a45772495`. Fix verified independently at runtime candidate `f3351ac4cb612aa8bdf2d6bdaf12400d533636a0` in [checkout PR #2](https://github.com/SPatel2133/coshop/pull/2). [Independent verifier and probe evidence](https://app.devin.ai/sessions/1045c6a3a800452da98cf56473556601).

## Symptom and minimal reproduction

1. Sam submits a bag add with request ID X. The server accepts it, leaving quantity one.
2. Drop the acknowledgement so Sam cannot know it succeeded.
3. Maya acquires the checkout lease.
4. Sam resends the original request X.

The verifier observed `CHECKOUT_BUSY` for the replay. Its Linux environment used Node v24.22.3 and pnpm 11.25.0. The baseline repository suite passed 70 tests, while the independent P03 probe exposed this failure.

## Initial hypothesis and evidence

The checkout lock correctly blocked a new bag mutation, but it also blocked recognition of an accepted mutation. In [Rooms](../../server/rooms.js), the checkout guard ran before the request reached replay handling in [Bag](../../server/bag.js). The same repeated request succeeded outside the lease in comparison probe P04. That comparison identified guard ordering as the cause.

## Fix

The narrow replay branch in `shopCommand` now recognizes an existing identical `bag_change` from the authenticated participant before blocking new bag edits. It returns the original acknowledgement and current bag. It does not increment quantity again. A new or altered request still follows validation and the checkout lock.

## Regression and result

The test named `a committed bag change replays its original ack after a checkout lease starts; new or altered changes stay locked` in [attribution tests](../../tests/phase5-attribution.test.mjs) asserts successful replay, unchanged quantity and rejection of a new or altered mutation. Run the focused test with:

```sh
node --test --test-name-pattern='a committed bag change' tests/phase5-attribution.test.mjs
```

The original independent P03 probe passed on the candidate. The verifier also ran the candidate's 87 repository tests, 19 browser tests, seven Node/Worker transport probes and six ambiguity probes successfully. The main agent's local selected attribution suite passed 12 tests, including this regression. Combined integration evidence is tracked in [the work tracker](work-tracker.md).

## Remaining limits

The paid webhook contract now returns explicit outcome codes. Six original adversarial assertions needed adaptation to those contracts, recorded by the independent verifier. A failed checkout attempt ID must be replaced by a new ID. Those compatibility changes are distinct from this replay fix.

This local state-transition regression does not prove live Shopify payment or order attribution. An ambiguous cart creation retains a snapshot but cannot attribute a later payment without the returned cart binding. See [the supervised runbook](../shopify-live-verification.md).
