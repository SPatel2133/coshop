# Two-shopper UX audit

Observed at baseline `2b53c5229e8cc77111c41b9dd36a280a45772495` in two independently authenticated local sample-room browser sessions. [Two-minute recording](https://app.devin.ai/sessions/1045c6a3a800452da98cf56473556601?testRecording=3b1a89fe-eedd-4d72-a0e3-2892859281c4). [Independent reviewer](https://app.devin.ai/sessions/1045c6a3a800452da98cf56473556601). [Supplemental recording](https://app.devin.ai/attachments/e307f1ff-f1ac-49db-8d32-d0eaeac2d739/rec-098eb108-35b9-4797-8dd4-e9be56efbb53-edited.mp4), also at baseline.

| Priority | Observation | Proposed change |
| --- | --- | --- |
| High | A shopper scrolled to product controls missed the friend's find cue above the viewport. | Keep the unseen-find cue visible in persistent controls. |
| Medium | Reconnect restored quantity from three to four but repeated the shopper's old add confirmation. | Clear stale action feedback and highlight lines changed during resync. |
| Medium | In the sample demo, a checkout error stays visible after a later successful add. | Clear the stale checkout error once a later bag action succeeds. |
| Medium | Price-review feedback asks for a retry without identifying the changed line. | Highlight the affected bag line and its current value. |
| Medium | A shopper could add to another picker's line but could not remove it, with no explanation of that permission. | Explain picker ownership next to the quantity controls. |
| Medium | A shared find does not indicate whether it is already in the bag. | Show current bag status on the find. |
| Low | Refresh preserves product, variant and room state but resets the selected image. Following a find lacks return navigation to the previous product. | Restore the selected photo. Further navigation changes need separate design review. |
| Low | The increment button dims at quantity 99 without naming the cap. | Explain the cap at the control. |

The audit observed clear pending-action feedback and preserved identities, variants, finds and bag after refresh. These observations apply to the recorded baseline. Phone width and server-rejected share/add paths were not covered in the main recording. Automated mobile/browser regression coverage is recorded separately.

The supplemental recording covers those paths at baseline `2b53c52`, not at the final candidate. At 360 px and 390 px widths there was no horizontal overflow, and focus was restored. It reconfirmed the high-priority finding that the friend's find cue goes offscreen, and the medium finding that old feedback repeats after reconnect. It also found the stale checkout error listed above. These errors came from real requests: rollback of a stale remove, the 99 cap, an unavailable size, a tampered variant and an expired room. The checkout-busy lock and rate-limit errors were simulated.

## Delivery and reload probes

The independent verifier ran these probes at integration candidate `cfa00e7bac781e6ff2806cfa1d12f6d43476146d`.

| Probe | Observation | Status |
| --- | --- | --- |
| G1 | Concurrent shares of distinct variants plus repeated requests, on both Node and Worker transports, produced exactly two finds and an empty bag. | Passed |
| G2 | Playwright held the add acknowledgement after the server accepted it, then reloaded. The bag showed quantity one, no duplicate appeared after three seconds, and the Saving indicator cleared. | Passed |
| G3 | Playwright held an outgoing add before the server received it, then reloaded. The bag showed zero. The unsent command was discarded without explanation. | Limitation |

The user approved the focused UI changes. At integration candidate `b6fa7f35466301883d0998e378d0aa35d30deed3`, the client still has no durable outgoing command queue and never replays an ambiguous add. Instead, if a bag command times out while offline, the first authoritative snapshot after reconnect shows the cautious message “Review your bag; an update was interrupted.” The message does not claim the add failed, persists until the shopper's next action, and does not return on a later reload.

An independent >17-second WebSocket-outage retest ran twice at `b6fa7f3`: a server-accepted add with a lost acknowledgement converged once without duplication, while a never-sent add was not replayed. In both cases the bags converged, identity was retained, and the same cautious review notice appeared only after reconnect. The 31-test browser suite and the associated 89-test repository suite passed in CI. Desktop motion preserves the approved direction and reduced-motion behavior.
