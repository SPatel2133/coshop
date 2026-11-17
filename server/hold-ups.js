import { RoomError } from "./config.js";

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const REACTIONS = ["❤️", "👎", "🤔"];
export const HOLD_REPLAY_MS = 120000;

// Mutations run inside the room's synchronous transaction, on both runtimes.
// The event log is the history; bag_lines is its materialized current state.
export class HoldUps {
  constructor(store, products) {
    Object.assign(this, { store, products });
  }
  person(id) {
    const p = this.store.all(
      "SELECT id,display_name,avatar FROM participants WHERE id=?",
      id,
    )[0];
    return { id: p.id, name: p.display_name, avatar: p.avatar };
  }
  event(row) {
    return {
      ...JSON.parse(row.payload),
      id: row.id,
      sequence: row.sequence,
      createdAt: row.created_at,
    };
  }
  insert(id, room, user, type, product, variant, payload, now) {
    this.store.run(
      "INSERT INTO events(id,room_id,user_id,product_id,variant_id,type,payload,created_at) VALUES(?,?,?,?,?,?,?,?)",
      id,
      room,
      user,
      product,
      variant,
      type,
      JSON.stringify(payload),
      now,
    );
    return this.event(this.store.all("SELECT * FROM events WHERE id=?", id)[0]);
  }
  recent(room, now) {
    return this.store
      .all(
        "SELECT * FROM (SELECT * FROM events WHERE room_id=? AND type='hold_up' AND created_at>=? ORDER BY sequence DESC LIMIT 128) ORDER BY sequence",
        room,
        now - HOLD_REPLAY_MS,
      )
      .map((row) => this.event(row));
  }
  bag(room) {
    const items = this.store
      .all(
        "SELECT * FROM bag_lines WHERE room_id=? ORDER BY created_at,variant_id",
        room,
      )
      .map((row) => ({
        productId: row.product_id,
        variantId: row.variant_id,
        quantity: row.quantity,
        pickedBy: this.person(row.picked_by),
      }));
    const revision = this.store.all(
      "SELECT COALESCE(MAX(sequence),0) AS revision FROM events WHERE room_id=? AND type IN ('add_to_bag','remove_from_bag')",
      room,
    )[0].revision;
    return {
      revision,
      items,
      totalQuantity: items.reduce((n, item) => n + item.quantity, 0),
    };
  }
  append(room, user, message, now) {
    const { type, requestId } = message;
    if (
      !["hold_up", "react"].includes(type) ||
      (type === "hold_up" &&
        (typeof message.productId !== "string" ||
          typeof message.variantId !== "string")) ||
      (type === "react" &&
        (typeof message.holdUpId !== "string" ||
          typeof message.emoji !== "string"))
    )
      throw new RoomError("INVALID_COMMAND", "Send a valid shopping action.");
    if (typeof requestId !== "string" || !UUID.test(requestId))
      throw new RoomError("INVALID_COMMAND", "Use a valid request identifier.");
    const old = this.store.all("SELECT * FROM events WHERE id=?", requestId)[0];
    if (old) {
      const p = JSON.parse(old.payload);
      if (
        old.room_id !== room ||
        old.user_id !== user ||
        old.type !== type ||
        (type === "hold_up"
          ? old.product_id !== message.productId ||
            old.variant_id !== message.variantId
          : p.holdUpId !== message.holdUpId || p.emoji !== message.emoji)
      )
        throw new RoomError(
          "INVALID_COMMAND",
          "That request identifier has already been used.",
        );
      return { replay: true, event: this.event(old) };
    }
    const latest = this.store.all(
      "SELECT created_at FROM events WHERE room_id=? AND user_id=? AND type=? ORDER BY sequence DESC LIMIT 1",
      room,
      user,
      type,
    )[0];
    const cooldown = type === "hold_up" ? 3000 : 500;
    if (latest && now - latest.created_at < cooldown) {
      const error = new RoomError(
        "COOLDOWN",
        type === "hold_up"
          ? "Give everyone a moment to see your find."
          : "Give that reaction a moment.",
      );
      error.retryAfterMs = cooldown - (now - latest.created_at);
      throw error;
    }
    if (type === "react") {
      const target = this.store.all(
        "SELECT * FROM events WHERE id=? AND room_id=? AND type='hold_up'",
        message.holdUpId || "",
        room,
      )[0];
      if (
        !target ||
        !REACTIONS.includes(message.emoji) ||
        now - target.created_at > HOLD_REPLAY_MS
      )
        throw new RoomError(
          "INVALID_REACTION",
          "Choose a reaction on a recent find.",
        );
      return {
        replay: false,
        event: this.insert(
          requestId,
          room,
          user,
          type,
          target.product_id,
          target.variant_id,
          { holdUpId: target.id, emoji: message.emoji, by: this.person(user) },
          now,
        ),
      };
    }
    const product = this.products.find((p) => p.id === message.productId);
    const variant = product?.variants.find((v) => v.id === message.variantId);
    if (!variant)
      throw new RoomError(
        "INVALID_PRODUCT",
        "That product or variant is no longer in this collection.",
      );
    const line = this.store.all(
      "SELECT * FROM bag_lines WHERE room_id=? AND variant_id=?",
      room,
      variant.id,
    )[0];
    const pickedBy = this.person(line?.picked_by || user);
    const event = this.insert(
      requestId,
      room,
      user,
      type,
      product.id,
      variant.id,
      {
        productId: product.id,
        variantId: variant.id,
        name: product.name,
        image: product.image,
        variant: variant.title,
        cents: variant.cents,
        currency: variant.currency,
        available: variant.available,
        by: this.person(user),
        pickedBy,
        repeated: Boolean(line),
        quantity: line?.quantity || 1,
      },
      now,
    );
    if (!line) {
      this.store.run(
        "INSERT INTO bag_lines(room_id,variant_id,product_id,quantity,picked_by,created_at) VALUES(?,?,?,1,?,?)",
        room,
        variant.id,
        product.id,
        user,
        now,
      );
      this.insert(
        crypto.randomUUID(),
        room,
        user,
        "add_to_bag",
        product.id,
        variant.id,
        { source: "hold_up", holdUpId: requestId, quantity: 1, pickedBy },
        now,
      );
    }
    return { replay: false, event };
  }
}
