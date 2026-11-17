import { RoomError } from "./config.js";

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const REACTIONS = ["❤️", "👎", "🤔"];

// Mutations run inside the room's synchronous transaction, on both runtimes.
// Internal hold_up commands now mean Share find. Finds and bag are independent
// projections; sharing never writes to bag_lines or add_to_bag events.
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
      productId: row.product_id,
      variantId: row.variant_id,
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
  finds(room, variantId) {
    return this.store
      .all(
        "SELECT first.*, last.id AS latest_id, last.sequence AS latest_sequence, last.created_at AS latest_at, last.payload AS latest_payload FROM shared_finds f JOIN events first ON first.id=f.first_event_id JOIN events last ON last.id=f.latest_event_id WHERE f.room_id=?" +
          (variantId ? " AND f.variant_id=?" : "") +
          " ORDER BY first.sequence DESC",
        room,
        ...(variantId ? [variantId] : []),
      )
      .map((row) => {
        const first = this.event(row),
          latest = JSON.parse(row.latest_payload);
        return {
          id: first.id,
          sequence: first.sequence,
          createdAt: first.createdAt,
          productId: first.productId,
          variantId: first.variantId,
          name: latest.name,
          image: latest.image,
          variant: latest.variant,
          cents: latest.cents,
          currency: latest.currency,
          available: latest.available,
          sharedBy: first.by,
          latestShare: {
            id: row.latest_id,
            sequence: row.latest_sequence,
            createdAt: row.latest_at,
            by: latest.by,
          },
        };
      });
  }
  append(room, user, message, now, products = this.products) {
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
      if (!target || !REACTIONS.includes(message.emoji))
        throw new RoomError(
          "INVALID_REACTION",
          "Choose a reaction on a find in this room.",
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
    const product = products.find((p) => p.id === message.productId);
    const variant = product?.variants.find((v) => v.id === message.variantId);
    if (!variant)
      throw new RoomError(
        "INVALID_PRODUCT",
        "That product or variant is no longer in this collection.",
      );
    const previous = this.store.all(
      "SELECT * FROM shared_finds WHERE room_id=? AND variant_id=?",
      room,
      variant.id,
    )[0];
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
        image: variant.image || product.image,
        variant: variant.title,
        cents: variant.cents,
        currency: variant.currency,
        available: variant.available,
        by: this.person(user),
        repeated: Boolean(previous),
      },
      now,
    );
    this.store.run(
      "INSERT INTO shared_finds(room_id,variant_id,first_event_id,latest_event_id) VALUES(?,?,?,?) ON CONFLICT(room_id,variant_id) DO UPDATE SET latest_event_id=excluded.latest_event_id",
      room,
      variant.id,
      requestId,
      requestId,
    );
    return { replay: false, event };
  }
}
