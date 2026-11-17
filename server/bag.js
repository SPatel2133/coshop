import { RoomError } from "./config.js";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = (message) => new RoomError("INVALID_BAG", message);

export class Bag {
  constructor(store, products, checks = {}, catalogTime = 0) {
    this.store = store;
    this.checks = checks;
    this.catalogTime = catalogTime;
    this.products = new Map(
      products.flatMap((product) =>
        product.variants.map((variant) => [variant.id, { product, variant }]),
      ),
    );
  }
  snapshot(room) {
    const items = this.store
      .all(
        `SELECT line.*,person.display_name,person.avatar FROM bag_lines line
      JOIN participants person ON person.id=line.picked_by
      WHERE line.room_id=? ORDER BY line.created_at, line.variant_id`,
        room,
      )
      .map((row) => {
        const entry = this.products.get(row.variant_id);
        const { product, variant: baseline } =
          entry?.product.id === row.product_id ? entry : {};
        const checked = this.checks[row.variant_id];
        const variant =
          checked?.at >= this.catalogTime
            ? { ...baseline, ...checked.variant }
            : baseline;
        return {
          productId: row.product_id,
          variantId: row.variant_id,
          quantity: row.quantity,
          pickedBy: {
            id: row.picked_by,
            name: row.display_name,
            avatar: row.avatar,
          },
          name: product?.name ?? "Item no longer in the collection",
          image: variant?.image || product?.image || null,
          variant: variant?.title ?? row.variant_id,
          cents: variant?.cents ?? null,
          currency: variant?.currency ?? null,
          available: variant?.available === true,
        };
      });
    const revision = this.store.all(
      "SELECT COALESCE(MAX(sequence),0) AS revision FROM events WHERE room_id=? AND type IN ('add_to_bag','remove_from_bag')",
      room,
    )[0].revision;
    const totals = new Map();
    for (const item of items)
      if (item.currency && Number.isSafeInteger(item.cents))
        totals.set(
          item.currency,
          (totals.get(item.currency) ?? 0) + item.cents * item.quantity,
        );
    return {
      revision,
      items,
      totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
      totals: [...totals].map(([currency, cents]) => ({ currency, cents })),
      unavailable: items.filter((item) => !item.available).length,
      ...(this.catalogTime
        ? {
            pricedAt: Math.max(
              this.catalogTime,
              ...Object.values(this.checks).map((check) => check.at),
            ),
          }
        : {}),
    };
  }
  command(room, user, message, now, touch) {
    const { action, requestId, variantId } = message;
    const expected = action === "remove" ? message.expectedQuantity : null;
    if (
      !["add", "decrease", "remove"].includes(action) ||
      typeof requestId !== "string" ||
      !uuid.test(requestId) ||
      typeof variantId !== "string" ||
      !variantId ||
      variantId.length > 128 ||
      (action === "remove" &&
        (!Number.isInteger(expected) || expected < 1 || expected > 99))
    )
      throw invalid("Choose a valid bag action.");
    const eventType = action === "add" ? "add_to_bag" : "remove_from_bag";
    const previous = this.store.all(
      "SELECT * FROM events WHERE id=?",
      requestId,
    )[0];
    if (previous) {
      const payload = JSON.parse(previous.payload);
      if (
        previous.room_id !== room ||
        previous.user_id !== user ||
        previous.variant_id !== variantId ||
        previous.type !== eventType ||
        payload.action !== action ||
        payload.expected !== expected
      )
        throw invalid("That request identifier has already been used.");
      return {
        ack: {
          type: "command_ack",
          requestId,
          ok: true,
          bag: this.snapshot(room),
        },
      };
    }
    const line = this.store.all(
      "SELECT * FROM bag_lines WHERE room_id=? AND variant_id=?",
      room,
      variantId,
    )[0];
    const entry = this.products.get(variantId);
    const check = this.checks[variantId];
    if (action === "add") {
      if (
        !entry ||
        !(check?.at >= this.catalogTime
          ? check.variant.available
          : entry.variant.available) ||
        (line && line.product_id !== entry.product.id)
      )
        throw new RoomError(
          "BAG_UNAVAILABLE",
          "That variant isn’t available in this collection.",
          409,
        );
      if (line?.quantity === 99) throw invalid("This item is already at 99.");
    } else {
      if (!line)
        throw new RoomError(
          "BAG_CHANGED",
          "This item is no longer in the bag.",
          409,
        );
      if (line.picked_by !== user)
        throw new RoomError(
          "BAG_PICKER_ONLY",
          "Only the original picker can reduce or remove this item.",
          403,
        );
      if (action === "remove" && expected !== line.quantity)
        throw new RoomError(
          "BAG_CHANGED",
          "The quantity changed. Review it before removing this item.",
          409,
        );
      if (action === "decrease" && line.quantity === 1)
        throw invalid("Use Remove to take the last one out.");
    }
    const before = line?.quantity ?? 0;
    const after =
      action === "add" ? before + 1 : action === "decrease" ? before - 1 : 0;
    const productId = line?.product_id ?? entry.product.id;
    const pickedBy = line?.picked_by ?? user;
    if (!after)
      this.store.run(
        "DELETE FROM bag_lines WHERE room_id=? AND variant_id=?",
        room,
        variantId,
      );
    else if (line)
      this.store.run(
        "UPDATE bag_lines SET quantity=? WHERE room_id=? AND variant_id=?",
        after,
        room,
        variantId,
      );
    else
      this.store.run(
        "INSERT INTO bag_lines(room_id,variant_id,product_id,quantity,picked_by,created_at) VALUES(?,?,?,?,?,?)",
        room,
        variantId,
        productId,
        after,
        pickedBy,
        now,
      );
    this.store.run(
      "INSERT INTO events(id,room_id,user_id,product_id,variant_id,type,payload,created_at) VALUES(?,?,?,?,?,?,?,?)",
      requestId,
      room,
      user,
      productId,
      variantId,
      eventType,
      JSON.stringify({
        action,
        expected,
        pickedBy,
        quantity: Math.abs(after - before),
        before,
        after,
      }),
      now,
    );
    touch();
    const bag = this.snapshot(room);
    return {
      ack: { type: "command_ack", requestId, ok: true, bag },
      notification: { type: "bag_changed", requestId, action, variantId, bag },
    };
  }
}
