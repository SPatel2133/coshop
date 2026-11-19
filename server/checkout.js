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
// Lowercase only: the orders/paid marker is matched case-sensitively.
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const unchanged = (before, after) =>
  before.length === after.length &&
  after.every(
    (item, index) =>
      item.variantId === before[index].variantId &&
      item.quantity === before[index].quantity &&
      item.cents === before[index].cents &&
      item.currency === before[index].currency &&
      item.available === before[index].available,
  );

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
      const lease = this.active(room);
      if (lease?.shopperId === person.id) {
        // The holder retried after a lost response: hand back the same cart.
        const resume = this.store.all(
          "SELECT checkout_url FROM checkout_leases WHERE room_id=?",
          room,
        )[0]?.checkout_url;
        if (resume) return { resume };
        throw new RoomError(
          "CHECKOUT_PENDING",
          "Shopify checkout is still being prepared. Try again in a moment.",
          409,
        );
      }
      if (lease)
        throw new RoomError(
          "CHECKOUT_BUSY",
          "Someone is already checking out.",
          409,
        );
      if (this.rooms.haul?.attempt(room, id))
        throw new RoomError(
          "CHECKOUT_REQUEST",
          "That checkout attempt has ended. Start checkout again.",
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
        ON CONFLICT(room_id) DO UPDATE SET id=excluded.id,user_id=excluded.user_id,expires_at=excluded.expires_at,checkout_url=NULL`,
        room,
        id,
        person.id,
        this.clock() + 30000,
      );
      this.rooms.bump(room, this.clock(), true);
      return current;
    });
    if (bag.resume)
      return { checkoutUrl: bag.resume, checkout: this.active(room) };
    let saved = false;
    let returned = false;
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
      if (!unchanged(bag.items, current.items)) throw review();
      if (current.unavailable)
        throw new RoomError(
          "BAG_UNAVAILABLE",
          "An item is no longer available. Its picker can remove it from the bag.",
          409,
        );
      // Persist the immutable attempt snapshot before the external cartCreate.
      // The cart token is bound only after Shopify's response is validated.
      this.store.transaction(() => {
        checkLease();
        this.rooms.haul?.saveCheckout(room, id, client.domain, current.items);
      });
      saved = true;
      const cart = await client.checkout(
        current.items,
        this.rooms.haul && [{ key: haulAttribute, value: room + "." + id }],
      );
      returned = true;
      const cartToken = /^gid:\/\/shopify\/Cart\/([^?]+)(?:\?|$)/.exec(
        cart.id ?? "",
      )?.[1];
      const cartHash =
        this.rooms.haul && cartToken ? await digest(cartToken) : null;
      // Bind the returned cart even if this attempt is then refused, so a
      // later paid order on it is diagnosed rather than unknown.
      if (cartHash) this.rooms.haul.bindCart(room, id, cartHash);
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
      if (this.rooms.haul && !cartHash) {
        console.warn(
          JSON.stringify({
            event: "coshop.checkout",
            outcome: "attribution_unavailable",
          }),
        );
        throw new RoomError(
          "CHECKOUT_ATTRIBUTION",
          "Shopify returned a cart CoShop can’t track, so no checkout was opened. Try again.",
          502,
        );
      }
      this.store.transaction(() => {
        checkLease();
        this.rooms.haul?.settle(room, id, "opened");
        this.store.run(
          "UPDATE checkout_leases SET expires_at=?,checkout_url=? WHERE room_id=? AND id=?",
          this.clock() + 5 * 60000,
          url.href,
          room,
          id,
        );
      });
      return { checkoutUrl: url.href, checkout: this.active(room) };
    } catch (error) {
      this.store.transaction(() => {
        this.store.run(
          "DELETE FROM checkout_leases WHERE room_id=? AND id=?",
          room,
          id,
        );
        if (saved)
          this.rooms.haul?.settle(
            room,
            id,
            error.code === "CHECKOUT_ENDED"
              ? "withheld"
              : returned || error instanceof ShopifyCartError
                ? "rejected"
                : "unconfirmed",
          );
      });
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
