import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { Rooms } from "../server/rooms.js";
import { configuration } from "../server/config.js";
import { nodeStore, migrate } from "../server/storage.js";
import { DiscussionUI, MessageHistory } from "../client/discussion.js";
import { launch, api, socket, delay } from "./support/rooms.mjs";

const schemas = await Promise.all(
  ["rooms", "presence", "hold_ups", "shared_finds", "discussion"].map(
    (name, index) =>
      readFile(
        new URL(
          `../drizzle/room-object/000${index + 1}_${name}.sql`,
          import.meta.url,
        ),
        "utf8",
      ),
  ),
);

test("discussion migration preserves finds; history is paged, room-scoped and erased at expiry", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const store = nodeStore(db);
  schemas
    .slice(0, 4)
    .forEach((schema, index) => migrate(store, schema, index + 1));
  const config = configuration({
    INVITE_SIGNING_SECRET: "test-only-discussion-migration-key",
    ROOM_TTL_MS: 90000,
  });
  let now = 1000000;
  const rooms = new Rooms(store, config, () => now);
  const room = crypto.randomUUID(),
    other = crypto.randomUUID();
  rooms.create(room, { name: "Maya", avatar: "sage" }, "hash-maya");
  rooms.create(other, { name: "Sam", avatar: "clay" }, "hash-sam");
  rooms.connect(room, "hash-maya", "connection-maya");
  rooms.connect(other, "hash-sam", "connection-sam");
  const run = (type, payload = {}, id = crypto.randomUUID()) =>
    rooms.shopCommand(room, "connection-maya", {
      type,
      requestId: id,
      ...payload,
    });
  const find = run("hold_up", { productId: "audio", variantId: "audio-0" }).ack
    .find;
  const original = rooms.snapshot(room);
  migrate(store, schemas[4], 5);
  migrate(store, schemas[4], 5);
  assert.deepEqual(rooms.snapshot(room), original);
  for (let index = 1; index <= 32; index++) {
    now += 800;
    assert.equal(run("chat_post", { text: `Message ${index}` }).ack.ok, true);
  }
  const recent = run("discussion_history").ack.page;
  assert.equal(recent.hasEarlier, true);
  assert.deepEqual(
    recent.entries.map((entry) => entry.text),
    Array.from({ length: 30 }, (_, index) => `Message ${index + 3}`),
  );
  const earlier = run("discussion_history", {
    before: recent.entries[0].sequence,
  }).ack.page;
  assert.deepEqual(
    earlier.entries.map((entry) => entry.text),
    ["Message 1", "Message 2"],
  );
  assert.equal(earlier.hasEarlier, false);
  assert.equal(run("chat_post", { text: "Too soon" }).ack.code, "COOLDOWN");
  assert.equal(run("chat_post", { text: " " }).ack.code, "INVALID_DISCUSSION");
  assert.equal(
    run("chat_post", { text: "x".repeat(401) }).ack.code,
    "INVALID_DISCUSSION",
  );
  assert.equal(
    run("discussion_history", { before: -1 }).ack.code,
    "INVALID_DISCUSSION",
  );
  now += 800;
  const requestId = crypto.randomUUID();
  const post = run(
    "comment_post",
    { findId: find.id, text: "<b>Literal text</b>" },
    requestId,
  );
  assert.equal(post.ack.summary.commentCount, 1);
  assert.equal(
    run(
      "comment_post",
      { findId: find.id, text: "<b>Literal text</b>" },
      requestId,
    ).notification,
    null,
  );
  assert.equal(
    run("comment_post", { findId: find.id, text: "Different" }, requestId).ack
      .code,
    "INVALID_DISCUSSION",
  );
  assert.equal(
    run("discussion_history", { findId: find.id }).ack.page.entries[0].author,
    "Maya",
  );
  for (const type of ["discussion_history", "comment_post", "rate_find"]) {
    assert.equal(
      rooms.shopCommand(other, "connection-sam", {
        type,
        requestId: crypto.randomUUID(),
        findId: find.id,
        score: 5,
        text: "Wrong room",
      }).ack.code,
      "FIND_NOT_FOUND",
    );
  }
  for (const score of [0, 6, 4.5, "4", null])
    assert.equal(
      run("rate_find", { findId: find.id, score }).ack.code,
      "INVALID_DISCUSSION",
    );
  assert.equal(
    run("rate_find", { findId: find.id, score: 4 }).ack.summary.average,
    4,
  );
  assert.equal(run("discussion_history").ack.page.entries.length, 30);
  const sharedAgain = run("hold_up", {
    productId: "audio",
    variantId: "audio-0",
  }).ack.find;
  assert.equal(sharedAgain.id, find.id);
  assert.equal(
    run("discussion_history", { findId: sharedAgain.id }).ack.page.entries
      .length,
    1,
  );
  now += config.ttl;
  assert.throws(() => run("discussion_history"), { code: "ROOM_EXPIRED" });
  assert.equal(store.all("SELECT * FROM discussion_entries").length, 0);
  assert.equal(store.all("SELECT * FROM find_ratings").length, 0);
});

test("comment submit keeps new typing, ignores replaced composers and preserves the timeout retry ID", async () => {
  const state = Object.assign(new MessageHistory(), {
    findId: "stone",
    draft: " Good pick ",
  });
  const actions = [];
  let finish;
  const original = { card: { announcement: { textContent: "" } } };
  const different = { card: {} };
  const discussion = Object.assign(Object.create(DiscussionUI.prototype), {
    online: true,
    feeds: new Map([[state.findId, state]]),
    quick: original,
    command: (...args) => {
      actions.push(args);
      return new Promise((resolve, reject) => {
        finish = { resolve, reject };
      });
    },
    paintComposer() {},
    message() {},
    syncDraft() {},
    collapseQuick() {
      assert.fail("Do not close a replaced or edited composer");
    },
  });
  const first = discussion.submit(state, original);
  await discussion.submit(state, original);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].slice(0, 2), [
    "comment_post",
    { findId: "stone", text: "Good pick" },
  ]);
  finish.reject(
    Object.assign(new Error("Lost ACK"), { code: "COMMAND_TIMEOUT" }),
  );
  await first;
  assert.equal(state.draft, " Good pick ");
  assert.equal(state.error, "Lost ACK");
  const retry = discussion.submit(state, original);
  assert.equal(actions[1][2], actions[0][2]);
  discussion.quick = different;
  state.draft = "Writing a second comment";
  state.edit++;
  finish.resolve({});
  await retry;
  assert.equal(discussion.quick, different);
  assert.equal(state.draft, "Writing a second comment");
  assert.equal(state.retry, null);
  assert.equal(original.card.announcement.textContent, "Comment posted.");

  const stale = discussion.submit(state, original);
  const newRoom = Object.assign(new MessageHistory(), {
    findId: "stone",
    draft: "Different room",
  });
  discussion.feeds = new Map([[state.findId, newRoom]]);
  finish.resolve({});
  await stale;
  assert.equal(newRoom.draft, "Different room");
});

test("client history deduplicates live messages and paginates across a reconnect gap", () => {
  const entry = (sequence) => ({ sequence, id: `entry-${sequence}` });
  const state = new MessageHistory();
  state.add(entry(3));
  state.page({ entries: [1, 2, 3].map(entry), hasEarlier: false }, false);
  assert.equal(state.add(entry(3)), false);
  state.resumeThrough = 3;
  state.add(entry(43));
  state.page({ entries: [41, 42, 43].map(entry), hasEarlier: true }, false);
  assert.deepEqual(
    state.ordered().map((item) => item.sequence),
    [41, 42, 43],
  );
  state.page({ entries: [39, 40].map(entry), hasEarlier: true }, true);
  assert.deepEqual(
    state.ordered().map((item) => item.sequence),
    [39, 40, 41, 42, 43],
  );
});

for (const worker of [false, true])
  test(
    `${worker ? "Cloudflare" : "Node"}: live and later chat, separate variant threads and editable ratings`,
    { timeout: 60000 },
    async (t) => {
      const { base } = await launch(t, worker, {
        TEST_PORT: worker ? "14325" : "14324",
      });
      const maya = (
        await api(base, "/api/rooms", { name: "Maya", avatar: "sage" })
      ).data;
      const path = "/api/rooms/" + maya.invite;
      const sam = (
        await api(base, path + "/join", { name: "Sam", avatar: "clay" })
      ).data;
      const clients = [];
      t.after(() => clients.forEach((client) => client.ws.terminate()));
      async function connect(member) {
        const client = socket(base, maya.invite, member.token);
        clients.push(client);
        await client.wait((message) => message.type === "state");
        return client;
      }
      async function send(
        client,
        type,
        payload = {},
        requestId = crypto.randomUUID(),
      ) {
        const existing = client.messages.length;
        client.ws.send(JSON.stringify({ type, ...payload, requestId }));
        return client.wait(
          (message) =>
            message.type === "command_ack" &&
            message.requestId === requestId &&
            client.messages.indexOf(message) >= existing,
        );
      }
      const first = await connect(maya),
        second = await connect(sam);
      const find = (
        await send(first, "hold_up", {
          productId: "audio",
          variantId: "audio-0",
        })
      ).find;
      const other = (
        await send(second, "hold_up", {
          productId: "audio",
          variantId: "audio-1",
        })
      ).find;
      const chat = await send(first, "chat_post", { text: "Room message" });
      await second.wait(
        (message) =>
          message.type === "discussion" && message.entry?.id === chat.entry.id,
      );
      const comment = await send(second, "comment_post", {
        findId: find.id,
        text: "This color",
      });
      await first.wait(
        (message) =>
          message.type === "discussion" &&
          message.entry?.id === comment.entry.id &&
          message.summary.commentCount === 1,
      );
      assert.deepEqual(
        (await send(first, "discussion_history", { findId: other.id })).page
          .entries,
        [],
      );
      const ratingRequest = crypto.randomUUID();
      await send(
        first,
        "rate_find",
        { findId: find.id, score: 3 },
        ratingRequest,
      );
      const secondRating = await send(second, "rate_find", {
        findId: find.id,
        score: 5,
      });
      assert.equal(secondRating.summary.average, 4);
      assert.equal(secondRating.summary.ratingCount, 2);
      const publicRating = await first.wait(
        (message) =>
          message.type === "discussion" && message.summary?.ratingCount === 2,
      );
      assert.equal("yourRating" in publicRating.summary, false);
      first.ws.close();
      await delay(800);
      const laterMessage = await send(second, "chat_post", {
        text: "I’ll leave this here for later.",
      });
      assert.equal(laterMessage.ok, true);
      second.ws.close();
      const later = await connect(maya);
      const ownSummary = (await send(later, "discussion_summary")).summaries[0];
      assert.equal(ownSummary.yourRating, 3);
      assert.equal(ownSummary.commentCount, 1);
      assert.deepEqual(
        (await send(later, "discussion_history")).page.entries.map(
          (entry) => entry.text,
        ),
        ["Room message", "I’ll leave this here for later."],
      );
      assert.deepEqual(
        (
          await send(later, "discussion_history", { findId: find.id })
        ).page.entries.map((entry) => entry.text),
        ["This color"],
      );
      const edited = await send(later, "rate_find", {
        findId: find.id,
        score: 1,
      });
      assert.equal(edited.summary.ratingCount, 2);
      assert.equal(edited.summary.average, 3);
      const replay = await send(
        later,
        "rate_find",
        { findId: find.id, score: 3 },
        ratingRequest,
      );
      assert.equal(replay.summary.yourRating, 1);
      assert.equal(replay.summary.average, 3);
      assert.equal(
        (await api(base, path + "/session", {}, maya.token)).data.room.bag
          .totalQuantity,
        0,
      );
    },
  );
