import { test } from "node:test";
import assert from "node:assert/strict";
import { HoldUpQueue } from "../client/hold-ups.js";

function fixture() {
  let now = 0,
    serial = 0,
    last;
  const timers = new Map(),
    saves = [];
  const queue = new HoldUpQueue({
    render: (event, length, paused) => (last = { event, length, paused }),
    clock: () => now,
    save: (n) => saves.push(n),
    later: (fn, ms) => {
      const id = ++serial;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    cancel: (id) => timers.delete(id),
  });
  return {
    queue,
    saves,
    state: () => last,
    tick(ms) {
      const end = now + ms;
      while (true) {
        const due = [...timers]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}
const event = (n) => ({ id: "find-" + n, sequence: n });
test("default browser timers are called without using the queue as their receiver", (t) => {
  const originalSet = globalThis.setTimeout,
    originalClear = globalThis.clearTimeout;
  t.after(() => {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  });
  globalThis.setTimeout = function () {
    assert.ok(!(this instanceof HoldUpQueue));
    return 1;
  };
  globalThis.clearTimeout = function () {
    assert.ok(!(this instanceof HoldUpQueue));
  };
  const queue = new HoldUpQueue({ render() {} });
  queue.add([event(1)]);
  queue.interact();
  queue.dismiss();
  queue.stop();
});
test("FIFO queue sorts simultaneous finds, deduplicates replay and gives each find eight seconds", () => {
  const f = fixture();
  f.queue.add([event(3), event(1), event(2)]);
  assert.equal(f.state().event.id, "find-1");
  assert.equal(f.state().length, 3);
  f.tick(7999);
  assert.equal(f.state().event.id, "find-1");
  f.queue.add([event(1), event(2)]);
  f.tick(1);
  assert.equal(f.state().event.id, "find-2");
  assert.equal(f.state().length, 2);
  f.tick(8000);
  assert.equal(f.state().event.id, "find-3");
  f.tick(8000);
  assert.equal(f.state().event, null);
  assert.deepEqual(f.saves, [1, 2, 3]);
  f.queue.add([event(2), event(3)]);
  assert.equal(f.state().event, null);
});
test("interaction stops auto-dismiss, and explicit dismissal advances only the active find", () => {
  const f = fixture();
  f.queue.add([event(1), event(2)]);
  f.tick(3000);
  f.queue.interact();
  f.tick(60000);
  assert.equal(f.state().event.id, "find-1");
  assert.equal(f.state().paused, true);
  f.queue.dismiss();
  assert.equal(f.state().event.id, "find-2");
  assert.equal(f.state().paused, false);
  f.tick(8000);
  assert.equal(f.state().event, null);
});
test("a restored completion cursor skips dismissed finds while recovering unseen ones", () => {
  const f = fixture();
  f.queue.completed = 4;
  f.queue.add([event(3), event(4), event(5)]);
  assert.equal(f.state().event.id, "find-5");
  f.queue.stop();
  f.tick(9000);
  assert.equal(f.state().event.id, "find-5");
});
