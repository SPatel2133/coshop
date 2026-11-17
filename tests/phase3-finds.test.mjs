import { test } from "node:test";
import assert from "node:assert/strict";
import { FindsState } from "../client/hold-ups.js";
const find = (variantId, sequence, latest = sequence) => ({
  id: "first-" + sequence,
  variantId,
  sequence,
  sharedBy: { name: "Maya" },
  latestShare: { sequence: latest, by: { name: "Sam" } },
});
test("one card per variant, newest first; repeats and stale replay never change position or attribution", () => {
  const state = new FindsState();
  state.snapshot([find("audio-0", 1), find("audio-1", 3)]);
  assert.deepEqual(
    state.ordered().map((f) => f.variantId),
    ["audio-1", "audio-0"],
  );
  state.merge(find("audio-0", 1, 4));
  state.merge(find("audio-0", 1, 2));
  assert.deepEqual(
    state.ordered().map((f) => f.sequence),
    [3, 1],
  );
  assert.equal(state.cards.get("audio-0").latestShare.sequence, 4);
  assert.equal(state.cards.get("audio-0").sharedBy.name, "Maya");
});
test("snapshots, repeats and reactions do not mark unseen finds seen or inflate their count", () => {
  const state = new FindsState();
  state.snapshot([find("audio", 1), find("bag", 2)]);
  assert.equal(state.unseen(), 2);
  state.snapshot([find("audio", 1), find("bag", 2)]);
  state.merge(find("audio", 1, 3));
  assert.equal(state.unseen(), 2);
  assert.equal(state.markSeen("audio", false), false);
  assert.equal(state.unseen(), 2);
  assert.equal(state.markSeen("audio", true), true);
  assert.equal(state.unseen(), 1);
  state.merge(find("audio", 1, 4));
  assert.equal(state.unseen(), 1);
  assert.equal(state.markSeen("unknown", true), false);
});
test("seen variants survive refresh, remain local to the viewer and deduplicate reconnect", () => {
  let saved = [];
  const a = new FindsState([], (ids) => (saved = ids)),
    b = new FindsState();
  for (const state of [a, b])
    state.snapshot([find("audio", 1), find("bag", 2)]);
  a.markSeen("audio", true);
  a.markSeen("audio", true);
  assert.deepEqual(saved, ["audio"]);
  assert.equal(b.unseen(), 2);
  const restored = new FindsState(saved);
  restored.snapshot([find("audio", 1, 8), find("bag", 2)]);
  assert.equal(restored.unseen(), 1);
  restored.snapshot([find("audio", 1, 8), find("bag", 2)]);
  assert.equal(restored.unseen(), 1);
});
