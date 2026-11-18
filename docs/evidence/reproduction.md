# Three shoppers, two concurrent shares, one bag change

From the repository root, use Node 24 and pnpm 11.25.0. Install dependencies and Chromium once:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

Run the check:

```sh
node scripts/evidence.mjs reproduce
```

The command builds a same-origin frontend, starts a Node/SQLite server on a dynamically allocated loopback port, and uses disposable room data. It runs the three-shopper test and prints the output directory. Run `pnpm exec playwright show-report "<output-directory>/playwright-report" --host 127.0.0.1` to open the HTML report. `playwright.json` has machine-readable results and `result.json` records the commit, dirty flag, runtime, scenario, and outcome. Keep the full Playwright reports local. In failing runs, Playwright call logs can include a disposable local invite.

Three isolated browser contexts exercise independent browsing. Two shoppers share Stone and Black in parallel. All three see the same ordered pair, a repeat keeps the original sharer and creates no extra card, and all three bags stay empty. After refresh the finds persist. An explicit Black add updates each bag to one, and another refresh preserves both the bag and ordered finds.

Recorded outcome: **1 passed**, 8.7 seconds in the Playwright runner, Windows x64, Node 24.22.1, pnpm 11.25.0. The local HEAD was `86d91123c0bbe3479f578a3cc68739a1339bbff0` with **uncommitted evidence scripts and expanded browser assertions**. See the [safe run record](reproduction-result.json). This check does not exercise the public deployment.
