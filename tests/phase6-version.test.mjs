import { test } from "node:test";
import assert from "node:assert/strict";
import { launch, api } from "./support/rooms.mjs";

const commit = "0123456789abcdef0123456789abcdef01234567";

for (const [name, extra, expected] of [
  ["the packaged commit", { COSHOP_BUILD_COMMIT: commit }, commit],
  ["unknown without a packaged commit", {}, "unknown"],
])
  test(`Cloudflare: GET /api/version reports ${name}`, { timeout: 60000 }, async (t) => {
    const { base } = await launch(t, true, {
      TEST_PORT: extra.COSHOP_BUILD_COMMIT ? "14331" : "14333",
      ...extra,
    });
    const version = await api(base, "/api/version");
    assert.equal(version.status, 200);
    assert.deepEqual(version.data, { commit: expected });
    assert.equal(version.headers.get("cache-control"), "no-store");
    assert.equal(version.headers.get("access-control-allow-origin"), null);
    const post = await api(base, "/api/version", {});
    assert.equal(post.status, 404);
  });
