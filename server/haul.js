import { RoomError } from "./config.js";
import { digest } from "./security.js";

export const haulAttribute = "_coshop_haul";
const validId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class Haul {
  constructor(rooms) {
    Object.assign(this, { rooms, store: rooms.store, clock: rooms.clock });
  }
  highlights(room) {
    const counts = this.store.all(
      `SELECT variant_id,COUNT(*) AS count FROM events
       WHERE room_id=? AND type='hold_up' AND variant_id IS NOT NULL
       GROUP BY variant_id ORDER BY count DESC, MIN(sequence) LIMIT 3`,
      room,
    );
    return counts.flatMap(({ variant_id, count }) => {
      const find = this.rooms.holdUps.finds(room, variant_id)[0];
      return find ? [{ name: find.name, variant: find.variant, count }] : [];
    });
  }
  saveCheckout(room, id, shop, cartToken, items) {
    this.store.run(
      "INSERT INTO haul_checkouts(room_id,id,shop,cart_token,snapshot) VALUES(?,?,?,?,?)",
      room,
      id,
      shop,
      cartToken,
      JSON.stringify({ items, highlights: this.highlights(room) }),
    );
  }
  latest(room) {
    const row = this.store.all(
      "SELECT payload FROM haul_recaps WHERE room_id=? ORDER BY sequence DESC LIMIT 1",
      room,
    )[0];
    return row ? JSON.parse(row.payload) : null;
  }
  record(room, eventKey, recap) {
    this.store.run(
      "INSERT INTO haul_recaps(room_id,event_key,payload) VALUES(?,?,?)",
      room,
      eventKey,
      JSON.stringify(recap),
    );
    this.rooms.bump(room, this.clock(), true);
    return recap;
  }
  demo(room, { id, revision }) {
    this.rooms.require(room);
    if (this.rooms.storefronts.get(room).mode !== "sample")
      throw new RoomError(
        "DEMO_ONLY",
        "Simulated completion is only available in sample rooms.",
        409,
      );
    if (typeof id !== "string" || !validId.test(id))
      throw new RoomError("RECAP_REQUEST", "Use the demo completion button.");
    return this.store.transaction(() => {
      const eventKey = "demo:" + id;
      const old = this.store.all(
        "SELECT payload FROM haul_recaps WHERE room_id=? AND event_key=?",
        room,
        eventKey,
      )[0];
      if (old) return JSON.parse(old.payload);
      const bag = this.rooms.roomBag(room).snapshot(room);
      if (bag.revision !== revision)
        throw new RoomError(
          "BAG_REVIEW",
          "The bag changed. Review it and try again.",
          409,
        );
      if (!bag.items.length || bag.unavailable)
        throw new RoomError(
          "BAG_REVIEW",
          "Add an available item to the bag before simulating completion.",
          409,
        );
      return this.record(room, eventKey, {
        id,
        mode: "demo",
        createdAt: this.clock(),
        items: bag.items,
        totalQuantity: bag.totalQuantity,
        totals: bag.totals,
        highlights: this.highlights(room),
      });
    });
  }
  async paid(order) {
    const { room, attempt, shop, cartToken, orderId, totals, lines } = order;
    const tokenHash = await digest(cartToken);
    try {
      this.rooms.require(room);
    } catch (error) {
      if (error.code === "ROOM_EXPIRED") return false;
      throw error;
    }
    return this.store.transaction(() => {
      const checkout = this.store.all(
        "SELECT * FROM haul_checkouts WHERE room_id=? AND id=? AND shop=? AND cart_token=?",
        room,
        attempt,
        shop,
        tokenHash,
      )[0];
      const eventKey = "paid:" + shop + ":" + orderId;
      if (
        !checkout ||
        this.store.all(
          "SELECT 1 FROM haul_recaps WHERE room_id=? AND event_key=?",
          room,
          eventKey,
        ).length
      )
        return false;
      const { items: prepared, highlights } = JSON.parse(checkout.snapshot);
      const byVariant = new Map(prepared.map((item) => [item.variantId, item]));
      const items = lines.map((line) => {
        const picked = byVariant.get(line.variantId);
        return {
          name: line.name,
          variant: line.variant || picked?.variant || "",
          variantId: line.variantId,
          quantity: line.quantity,
          image: picked?.image ?? null,
          pickedBy: picked?.pickedBy ?? null,
        };
      });
      this.record(room, eventKey, {
        id: "paid:" + attempt,
        mode: "paid",
        createdAt: this.clock(),
        items,
        totals,
        highlights,
        totalQuantity: items.reduce((count, line) => count + line.quantity, 0),
      });
      this.store.run(
        "DELETE FROM haul_checkouts WHERE room_id=? AND id=?",
        room,
        attempt,
      );
      this.store.run(
        "DELETE FROM checkout_leases WHERE room_id=? AND id=?",
        room,
        attempt,
      );
      return true;
    });
  }
}
