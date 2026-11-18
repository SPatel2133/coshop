# Local concurrent-share convergence baseline

Install with `pnpm install --frozen-lockfile` on Node 24 and run `node scripts/evidence.mjs measure` from the repository root. The printed temp directory contains `result.json`. This uses the real Node room runtime and SQLite over loopback. It requires no browser or public endpoint.

Each trial creates a fresh room, authenticates three WebSocket clients, and checks the empty initial state. Two clients issue Stone and Black shared-find commands back to back in one process, without awaiting either response. All three apply the real client `FindsState` reducer. The monotonic `performance.now()` clock starts immediately before sending the pair and the measured endpoint is when the last client has merged both events and can read its ordered list.

The runner checks both acknowledgements and compares each client's exact variants and order with the authoritative event sequence. Outside the timed interval it sends a repeat share, checks deduplication and first-sharer attribution, and checks persistent order and zero bag items, quantity, and revision on the server. Any failed assertion invalidates the trial. Each HTTP request and WebSocket wait has a 2-second deadline. Timeouts and failures remain in the raw result, and a run with any failure exits nonzero.

| Local Windows x64, Node 24.22.1 | Result |
| --- | ---: |
| Warm-up trials passed | 3 of 3 |
| Measured trials passed | 20 of 20 |
| Failures or timeouts | 0 |
| p50 convergence | 7.26 ms |
| p95 convergence | 10.84 ms |

The table uses nearest-rank percentiles over successful measured trials. [Raw result](benchmark-result.json). This is a small sample on one host, with no competing room workload beyond the three clients. It excludes connection setup, HTTP snapshot checks, browser rendering, and network distance. The independent rerun is a reproducibility check, and these numbers are a baseline. Earlier polling benchmarks used a different protocol and are unsuitable for a comparison.
