import { moneyDetails, ShopifyCartError } from "../shopify.mjs";
import { RoomError } from "./config.js";
import { haulAttribute } from "./haul.js";
import { digest } from "./security.js";

const expired = () =>
  new RoomError(
    "CHECKOUT_ENDED",
    "This checkout ended. Review the bag and try again.",
    409,
  );
const review = () =>
  new RoomError(
    "BAG_REVIEW",
    "Price or availability changed. Review the updated bag before continuing.",
    409,
  );
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class Checkout {
  constructor(rooms) {
    Object.assign(this, { rooms, store: rooms.store, clock: rooms.clock });
  }
  active(room) {
    const row = this.store.all(
      `SELECT lease.id,lease.user_id,lease.expires_at,person.display_name
      FROM checkout_leases lease JOIN participants person ON person.id=lease.user_id
      WHERE lease.room_id=? AND lease.expires_at>?`,
      room,
      this.clock(),
    )[0];
    return row
      ? {
          id: row.id,
          shopperId: row.user_id,
          name: row.display_name,
          expiresAt: row.expires_at,
        }
      : null;
  }
  release(room, user, id) {
    this.rooms.require(room);
    this.store.run(
      "DELETE FROM checkout_leases WHERE room_id=? AND user_id=? AND id=?",
      room,
      user,
      typeof id === "string" ? id : "",
    );
    return { checkout: this.active(room) };
  }
  sweep(room, now) {
    if (
      !this.store.all(
        "SELECT 1 FROM checkout_leases WHERE room_id=? AND expires_at<=?",
        room,
        now,
      ).length
    )
      return false;
    this.store.run(
      "DELETE FROM checkout_leases WHERE room_id=? AND expires_at<=?",
      room,
      now,
    );
    return true;
  }
  async start(room, person, input, publish) {
    const { revision, pricedAt, id } = input;
    this.rooms.require(room);
    const storefront = this.rooms.storefronts.get(room);
    const { client, key } = this.rooms.storefronts.provider;
    if (storefront.mode !== "shopify" || storefront.key !== key || !client)
      throw new RoomError(
        "CHECKOUT_DISABLED",
        "Shopify checkout is unavailable for this room.",
        409,
      );
    if (typeof id !== "string" || !uuid.test(id))
      throw new RoomError(
        "CHECKOUT_REQUEST",
        "Use the checkout button to continue.",
      );
    const bag = this.store.transaction(() => {
      if (this.active(room))
        throw new RoomError(
          "CHECKOUT_BUSY",
          "Someone is already checking out.",
          409,
        );
      const current = this.rooms.roomBag(room).snapshot(room);
      if (revision !== current.revision || pricedAt !== current.pricedAt)
        throw review();
      if (!current.items.length)
        throw new RoomError(
          "BAG_EMPTY",
          "Add something to the bag first.",
          409,
        );
      if (current.items.length > 250)
        throw new RoomError(
          "BAG_LIMIT",
          "Shopify supports up to 250 distinct items per cart.",
          409,
        );
      if (
        current.items.some(
          (item) =>
            !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(item.variantId),
        )
      )
        throw new RoomError(
          "BAG_UNAVAILABLE",
          "Remove items from the previous collection before checking out.",
          409,
        );
      this.store.run(
        `INSERT INTO checkout_leases(room_id,id,user_id,expires_at) VALUES(?,?,?,?)
        ON CONFLICT(room_id) DO UPDATE SET id=excluded.id,user_id=excluded.user_id,expires_at=excluded.expires_at`,
        room,
        id,
        person.id,
        this.clock() + 30000,
      );
      this.rooms.bump(room, this.clock(), true);
      return current;
    });
    const checkLease = () => {
      this.rooms.require(room);
      if (this.active(room)?.id !== id) throw expired();
    };
    try {
      await publish();
      checkLease();
      const fresh = await client.variants(
        bag.items.map((item) => item.variantId),
      );
      checkLease();
      const now = this.clock();
      const checks = Object.fromEntries(
        bag.items.map((item) => {
          const variant = fresh.get(item.variantId);
          return [
            item.variantId,
            {
              at: now,
              variant: variant ?? {
                available: false,
                cents: null,
                currency: null,
              },
            },
          ];
        }),
      );
      this.store.run(
        "UPDATE room_storefronts SET bag_checks=? WHERE room_id=?",
        JSON.stringify(checks),
        room,
      );
      const current = this.rooms.roomBag(room).snapshot(room);
      if (
        current.items.some(
          (item, index) =>
            item.cents !== bag.items[index].cents ||
            item.currency !== bag.items[index].currency ||
            item.available !== bag.items[index].available,
        )
      )
        throw review();
      if (current.unavailable)
        throw new RoomError(
          "BAG_UNAVAILABLE",
          "An item is no longer available. Its picker can remove it from the bag.",
          409,
        );
      const cart = await client.checkout(
        current.items,
        this.rooms.haul && [{ key: haulAttribute, value: room + "." + id }],
      );
      checkLease();
      const subtotal = moneyDetails(cart.cost?.subtotalAmount);
      if (
        current.totals.length !== 1 ||
        current.totals[0].cents !== subtotal.cents ||
        current.totals[0].currency !== subtotal.currency
      )
        throw new RoomError(
          "CHECKOUT_TOTAL",
          `Shopify returned a different subtotal (${subtotal.currency} ${(subtotal.cents / 100).toFixed(2)}). No checkout was opened.`,
          409,
        );
      const url = new URL(cart.checkoutUrl);
      if (![client.domain, storefront.checkoutHost].includes(url.hostname))
        throw new RoomError(
          "CHECKOUT_URL",
          "Shopify returned a checkout address outside this store.",
          502,
        );
      const cartToken = /^gid:\/\/shopify\/Cart\/([^?]+)(?:\?|$)/.exec(
        cart.id ?? "",
      )?.[1];
      const cartHash =
        this.rooms.haul && cartToken ? await digest(cartToken) : null;
      checkLease();
      this.store.transaction(() => {
        if (cartHash)
          this.rooms.haul.saveCheckout(
            room,
            id,
            client.domain,
            cartHash,
            current.items,
          );
        this.store.run(
          "UPDATE checkout_leases SET expires_at=? WHERE room_id=? AND id=?",
          this.clock() + 5 * 60000,
          room,
          id,
        );
      });
      return { checkoutUrl: url.href, checkout: this.active(room) };
    } catch (error) {
      this.store.run(
        "DELETE FROM checkout_leases WHERE room_id=? AND id=?",
        room,
        id,
      );
      if (error instanceof RoomError) throw error;
      if (error instanceof ShopifyCartError)
        throw new RoomError(
          "CHECKOUT_REVIEW",
          error.message.slice(0, 300),
          409,
        );
      throw new RoomError(
        "SHOPIFY_UNAVAILABLE",
        "Shopify couldn’t prepare checkout right now. Your bag is saved; try again.",
        502,
      );
    }
  }
}
