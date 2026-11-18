# Diagnosing an HTTP 429 during room creation

**Symptom.** Repeated hosted QA hit an HTTP 429 from the room service. The interface displayed a retry interval. The historical run did not retain enough logs to identify the exact request, bucket, or IP.

**Reproduction.** Run `node scripts/evidence.mjs diagnose`. The script starts a disposable Node/SQLite runtime on loopback with a fixture-only limit of one create per hour. It fixes the test clock five seconds before a window boundary. The printed temp directory contains the result.

| Probe | Observed |
| --- | --- |
| First create | 201 |
| Second create, same window | 429, `RATE_LIMITED`, `Retry-After: 5` |
| Authenticated request for the existing room while creation is blocked | 200, same participant |
| Create 1 ms before the boundary | 429, `Retry-After: 1` |
| Create at the boundary | 201 |
| Existing session after the boundary | 200, same participant |

The unchanged authenticated session showed the service and session were still functional. The boundary probe isolated the failure to the create quota. [Rate policy and bucket calculation](../../server/abuse.js) key the counter by action, IP, and fixed time window. The error carries the remaining time to the client. Waiting out that window restores creation. Automated checks use disposable local room state and a dedicated test configuration. The production guardrail was left in place.

[Safe run record](diagnosis-result.json). The reproduction verifies the mechanism locally. It establishes neither the exact production bucket nor its historical configuration.
