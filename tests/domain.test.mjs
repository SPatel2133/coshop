import { test } from "node:test";
import assert from "node:assert/strict";
import { update, view } from "../room-domain.mjs";
import { catalog } from "../catalog.mjs";

function fixture() {
  const members = [
    { id: "host", name: "Host", hash: "private-hash" },
    { id: "friend", name: "Friend", hash: "another-hash" },
  ];
  return {
    members,
    room: {
      owner: "host",
      leaderId: "host",
      members,
      version: 4,
      basketVersion: 2,
      catalog: structuredClone(catalog),
      basket: [],
      table: [],
      approvals: [],
      activity: [],
    },
  };
}
test("replaying a committed command cannot add a second item", async () => {
  const { room, members } = fixture();
  const command = {
    action: "add",
    variantId: catalog[0].variants[0].id,
    basketVersion: 2,
    operationId: crypto.randomUUID(),
  };
  await update(room, members[0], command);
  room.version++;
  await update(room, members[0], command);
  assert.equal(room.basket[0].quantity, 1);
  assert.equal(room.basketVersion, 3);
  assert.equal(view(room, members[0]).receipts, undefined);
  await assert.rejects(
    () =>
      update(room, members[0], {
        ...command,
        variantId: catalog[1].variants[0].id,
      }),
    /different action/,
  );
});
test("browsing changes do not block an edit to an unchanged basket", async () => {
  const { room, members } = fixture();
  await update(room, members[1], {
    action: "browse",
    variantId: catalog[1].variants[0].id,
  });
  room.version++;
  await update(room, members[0], {
    action: "add",
    version: 4,
    basketVersion: 2,
    variantId: catalog[0].variants[0].id,
  });
  await assert.rejects(
    () =>
      update(room, members[1], {
        action: "add",
        basketVersion: 2,
        variantId: catalog[1].variants[0].id,
      }),
    (error) => error.status === 409,
  );
});
test("leaving transfers leadership, preserves the basket and resets approval", async () => {
  const { room, members } = fixture();
  await update(room, members[0], {
    action: "add",
    basketVersion: 2,
    variantId: catalog[0].variants[0].id,
  });
  room.approvals = ["host", "friend"];
  await update(room, members[0], { action: "leave", version: room.version });
  assert.equal(room.owner, "friend");
  assert.equal(room.leaderId, "friend");
  assert.equal(room.members.length, 1);
  assert.equal(room.basket.length, 1);
  assert.deepEqual(room.approvals, []);
  assert.equal(room.departedNames.host, "Host");
  await update(room, members[1], { action: "leave", version: room.version });
  assert.ok(room.closedAt);
});
test("malformed operations leave the board unchanged", async () => {
  const { room, members } = fixture();
  const before = JSON.stringify(room);
  await assert.rejects(
    () => update(room, members[0], null),
    /valid room action/,
  );
  await assert.rejects(
    () =>
      update(room, members[0], {
        action: "add",
        basketVersion: 2,
        variantId: "invented",
      }),
    /Product not found/,
  );
  assert.equal(JSON.stringify(room), before);
});
