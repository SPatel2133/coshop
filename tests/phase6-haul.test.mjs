import { test } from "node:test";
import assert from "node:assert/strict";
import { launch, api, socket } from "./support/rooms.mjs";

for (const worker of [false, true]) {
  test(
    `${worker ? "Cloudflare" : "Node"}: simulated haul reaches peers, deduplicates and survives reconnect`,
    { timeout: 60000 },
    async (t) => {
      const { base } = await launch(t, worker, {
        TEST_PORT: worker ? "14345" : "14344",
      });
      const maya = (
        await api(base, "/api/rooms", { name: "Maya", avatar: "sage" })
      ).data;
      const path = "/api/rooms/" + maya.invite;
      const sam = (
        await api(base, path + "/join", { name: "Sam", avatar: "clay" })
      ).data;
      const first = socket(base, maya.invite, maya.token);
      const second = socket(base, maya.invite, sam.token);
      t.after(() => {
        first.ws.terminate();
        second.ws.terminate();
      });
      await Promise.all([
        first.wait((message) => message.type === "state"),
        second.wait((message) => message.type === "state"),
      ]);
      const command = async (type, data) => {
        const requestId = crypto.randomUUID();
        first.ws.send(JSON.stringify({ type, requestId, ...data }));
        return first.wait(
          (message) =>
            message.type === "command_ack" && message.requestId === requestId,
        );
      };
      await command("hold_up", { productId: "audio", variantId: "audio-0" });
      const { bag } = await command("bag_change", {
        action: "add",
        variantId: "audio-0",
      });
      const input = { id: crypto.randomUUID(), revision: bag.revision };
      assert.equal((await api(base, path + "/haul-demo", input)).status, 401);
      assert.equal(
        (
          await api(
            base,
            path + "/haul-demo",
            { ...input, revision: 0 },
            maya.token,
          )
        ).data.code,
        "BAG_REVIEW",
      );
      const response = await api(
        base,
        path + "/haul-demo",
        { ...input, mode: "paid" },
        maya.token,
      );
      assert.equal(response.status, 200);
      const { recap } = response.data;
      assert.equal(recap.mode, "demo");
      assert.equal(recap.totalQuantity, 1);
      assert.equal(recap.items[0].pickedBy.name, "Maya");
      assert.equal(recap.highlights[0].count, 1);
      await second.wait((message) => message.room?.recap?.id === recap.id);
      assert.deepEqual(
        (await api(base, path + "/haul-demo", input, maya.token)).data.recap,
        recap,
      );
      await command("bag_change", { action: "add", variantId: "audio-0" });
      const reconnect = await api(base, path + "/session", {}, sam.token);
      assert.equal(reconnect.data.room.bag.totalQuantity, 2);
      assert.deepEqual(reconnect.data.room.recap, recap);
      assert.equal(
        (await api(base, "/api/shopify/orders-paid", {})).status,
        404,
      );
    },
  );
}
