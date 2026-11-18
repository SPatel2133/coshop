import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { roomRequest, withRuntime } from "./evidence-runtime.mjs";

export async function diagnose(output) {
  const clock = join(output, "fixture-clock.txt");
  const inject = join(output, "fixture-clock.mjs");
  const boundary = Date.UTC(2026, 0, 1, 1);
  await writeFile(clock, String(boundary - 5000));
  await writeFile(inject, [
    'import { readFileSync } from "node:fs";',
    'Date.now = () => Number(readFileSync(process.env.EVIDENCE_CLOCK, "utf8"));',
  ].join("\n"));
  return withRuntime(async (base) => {
    const create = () => roomRequest(base, "/api/rooms", { name: "Sam", avatar: "sage" });
    const first = await create();
    assert.equal(first.status, 201);
    const blocked = await create();
    assert.equal(blocked.status, 429);
    assert.equal(blocked.data.code, "RATE_LIMITED");
    const retryAfter = Number(blocked.headers.get("retry-after"));
    assert.equal(retryAfter, 5);
    const { invite, token, me } = first.data;
    const session = () => roomRequest(base, "/api/rooms/" + invite + "/session", {}, token);
    const control = await session();
    assert.equal(control.status, 200);
    assert.equal(control.data.me, me);
    await writeFile(clock, String(boundary - 1));
    const early = await create();
    assert.equal(early.status, 429);
    assert.equal(Number(early.headers.get("retry-after")), 1);
    await writeFile(clock, String(boundary));
    const recovered = await create();
    assert.equal(recovered.status, 201);
    const original = await session();
    assert.equal(original.status, 200);
    assert.equal(original.data.me, me);
    return {
      passed: true, fixtureCreateLimit: 1,
      firstCreate: first.status, secondCreate: blocked.status,
      code: blocked.data.code, retryAfterSeconds: retryAfter,
      existingSessionWhileLimited: control.status,
      oneMsBeforeBoundary: early.status, atBoundary: recovered.status,
      originalIdentityAfterBoundary: original.data.me === me,
    };
  }, {
    nodeArgs: ["--import", pathToFileURL(inject).href],
    env: { CREATE_LIMIT_PER_HOUR: "1", EVIDENCE_CLOCK: clock },
  });
}
