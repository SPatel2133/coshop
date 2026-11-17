import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeRequestUrl, sameOrigin } from "../server/security.js";
import { configuration } from "../server/config.js";
const publicOrigin = "https://coshop-preview.example";
test("explicit public HTTPS origin supports tunnel HTTP and WebSocket requests without trusting forwarded headers", () => {
  const req = {
    url: "/api/rooms",
    headers: { host: "coshop-preview.example", "x-forwarded-proto": "http" },
  };
  const url = nodeRequestUrl(req, publicOrigin);
  assert.equal(url.origin, publicOrigin);
  assert.doesNotThrow(() =>
    sameOrigin(new Request(url, { headers: { origin: publicOrigin } })),
  );
  assert.equal(
    nodeRequestUrl({ ...req, url: "/api/rooms/invite/socket" }, publicOrigin)
      .origin,
    publicOrigin,
  );
  const forged = {
    url: "/",
    headers: { host: "elsewhere.example", "x-forwarded-proto": "https" },
  };
  assert.equal(
    nodeRequestUrl(forged, publicOrigin).origin,
    "http://elsewhere.example",
  );
  assert.throws(
    () =>
      sameOrigin(
        new Request(nodeRequestUrl(forged, publicOrigin), {
          headers: { origin: publicOrigin },
        }),
      ),
    { code: "ORIGIN_DENIED" },
  );
  assert.equal(
    nodeRequestUrl(
      { url: "/", headers: { host: "localhost:4195" } },
      publicOrigin,
    ).origin,
    "http://localhost:4195",
  );
});
test("public origin configuration rejects paths, credentials and insecure URLs", () => {
  const env = { INVITE_SIGNING_SECRET: "test-only-key-012345678901234567890" };
  for (const origin of [
    "http://public.example",
    "https://user:pass@public.example",
    "https://public.example/path",
    "https://public.example/?secret=x",
  ])
    assert.throws(() => configuration({ ...env, PUBLIC_ORIGIN: origin }));
  assert.equal(
    configuration({ ...env, PUBLIC_ORIGIN: publicOrigin }).publicOrigin,
    publicOrigin,
  );
});
