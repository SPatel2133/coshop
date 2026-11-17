import { RoomError } from "./config.js";
export function normalizeView(input, products) {
  if (!input || typeof input !== "object")
    throw new RoomError(
      "INVALID_VIEW",
      "Choose a product or category from this collection.",
    );
  if (input.kind === "category") {
    const categories = new Set(["All", ...products.map((p) => p.category)]);
    if (!categories.has(input.category))
      throw new RoomError(
        "INVALID_VIEW",
        "That category is not in this collection.",
      );
    return {
      kind: "category",
      category: input.category,
      productId: null,
      variantId: null,
    };
  }
  if (input.kind === "product") {
    const product = products.find((p) => p.id === input.productId);
    if (!product || !product.variants.some((v) => v.id === input.variantId))
      throw new RoomError(
        "INVALID_VIEW",
        "That product or variant is no longer in this collection.",
      );
    return {
      kind: "product",
      category: product.category,
      productId: product.id,
      variantId: input.variantId,
    };
  }
  throw new RoomError(
    "INVALID_VIEW",
    "Choose a product or category from this collection.",
  );
}
export class Events {
  constructor(store, products) {
    Object.assign(this, { store, products });
  }
  latest(roomId, userId) {
    return this.store.all(
      "SELECT * FROM events WHERE room_id=? AND user_id=? AND type='view' ORDER BY sequence DESC LIMIT 1",
      roomId,
      userId,
    )[0];
  }
  location(event) {
    if (!event) return null;
    return {
      ...JSON.parse(event.payload),
      productId: event.product_id,
      variantId: event.variant_id,
      eventId: event.id,
      updatedAt: event.created_at,
    };
  }
  appendView(roomId, userId, input, requestId, now, products = this.products) {
    if (
      typeof requestId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        requestId,
      )
    )
      throw new RoomError(
        "INVALID_VIEW",
        "Use a valid navigation request identifier.",
      );
    const view = normalizeView(input, products);
    const existing = this.store.all(
      "SELECT * FROM events WHERE id=?",
      requestId,
    )[0];
    if (existing) {
      const previous = this.location(existing);
      if (
        existing.room_id !== roomId ||
        existing.user_id !== userId ||
        existing.type !== "view" ||
        previous.kind !== view.kind ||
        previous.category !== view.category ||
        previous.productId !== view.productId ||
        previous.variantId !== view.variantId
      )
        throw new RoomError(
          "INVALID_VIEW",
          "That navigation identifier has already been used.",
        );
      return { accepted: true, replay: true };
    }
    const latest = this.latest(roomId, userId);
    if (latest && now - latest.created_at < 500)
      return { accepted: false, retryAfterMs: 500 - (now - latest.created_at) };
    this.store.run(
      "INSERT INTO events(id,room_id,user_id,product_id,variant_id,type,payload,created_at) VALUES(?,?,?,?,?,?,?,?)",
      requestId,
      roomId,
      userId,
      view.productId,
      view.variantId,
      "view",
      JSON.stringify({ kind: view.kind, category: view.category }),
      now,
    );
    return { accepted: true, replay: false };
  }
}
