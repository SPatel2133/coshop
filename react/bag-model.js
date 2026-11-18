import { navigationId } from "../client/realtime.js";

export function createBag(command, checkoutRequest, publish, error) {
  return new BagModel(command, checkoutRequest, publish, error);
}

class BagModel {
  constructor(command, checkoutRequest, publish, error) {
    Object.assign(this, { command, checkoutRequest, publish, error });
    this.pending = new Map();
  }

  pageShow = () => {
    this.departing = false;
    this.releaseOnReturn();
  };

  snapshot(room, me) {
    const identity = room.id + ":" + me;
    if (this.identity !== identity) {
      this.identity = identity;
      this.me = me;
      this.pending.clear();
      this.checkoutPending = this.releasing = this.departing = false;
      this.cue = null;
      this.bag = null;
      this.feedback = "";
      this.checkoutFeedback = "";
    }
    this.checkoutEnabled = room.checkoutEnabled;
    this.checkout = room.checkout;
    this.merge(room.bag);
    this.releaseOnReturn();
  }
  merge(bag, change) {
    if (change) {
      const pending = this.pending.get(change.variantId);
      if (pending?.id === change.requestId) pending.confirmed = true;
    }
    if (
      !this.bag ||
      bag.revision > this.bag.revision ||
      (bag.revision === this.bag.revision &&
        (bag.pricedAt ?? 0) > (this.bag.pricedAt ?? 0))
    ) {
      this.bag = bag;
      if (change?.action === "add")
        this.cue = { id: change.requestId, variantId: change.variantId };
    }
    this.render();
  }
  async startCheckout() {
    if (
      !this.checkoutEnabled ||
      !this.online ||
      this.checkout ||
      this.checkoutPending ||
      this.pending.size ||
      !this.bag?.items.length ||
      this.bag.unavailable
    )
      return;
    this.checkoutPending = true;
    this.checkoutFeedback = "Checking prices and availability with Shopify…";
    this.render();
    const id = navigationId();
    const identity = this.identity;
    try {
      const result = await this.checkoutRequest("checkout", {
        id,
        revision: this.bag.revision,
        pricedAt: this.bag.pricedAt,
      });
      if (identity !== this.identity) return;
      try {
        sessionStorage.setItem("coshop:checkout:" + identity, id);
      } catch {}
      this.departing = true;
      location.assign(result.checkoutUrl);
    } catch (error) {
      this.departing = false;
      if (identity === this.identity) this.checkoutFeedback = error.message;
    } finally {
      if (identity === this.identity) {
        this.checkoutPending = false;
        this.render();
      }
    }
  }
  async releaseCheckout() {
    if (!this.checkout || this.checkout.shopperId !== this.me || this.releasing)
      return;
    const id = this.checkout.id;
    const identity = this.identity;
    this.releasing = true;
    this.render();
    try {
      const { checkout } = await this.checkoutRequest("checkout-release", {
        id,
      });
      if (identity !== this.identity) return;
      if (this.checkout?.id === id) this.checkout = checkout;
      try {
        sessionStorage.removeItem("coshop:checkout:" + this.identity);
      } catch {}
      this.checkoutFeedback = "Bag unlocked. No purchase was confirmed.";
    } catch (error) {
      if (identity === this.identity) this.checkoutFeedback = error.message;
    } finally {
      if (identity === this.identity) {
        this.releasing = false;
        this.render();
      }
    }
  }
  releaseOnReturn() {
    if (
      !this.online ||
      !this.checkout ||
      this.checkoutPending ||
      this.departing ||
      this.checkout.shopperId !== this.me
    )
      return;
    let id;
    try {
      id = sessionStorage.getItem("coshop:checkout:" + this.identity);
    } catch {}
    if (id === this.checkout.id) this.releaseCheckout();
  }
  setConnected(online) {
    this.online = online;
    if (!online)
      for (const pending of this.pending.values()) pending.confirmed = true;
    this.render();
  }
  projected() {
    const items = new Map(
      (this.bag?.items ?? []).map((item) => [item.variantId, item]),
    );
    for (const [variantId, pending] of this.pending) {
      if (pending.confirmed) continue;
      const item = items.get(variantId) ?? pending.item;
      const quantity =
        pending.action === "add"
          ? Math.min(99, item.quantity + 1)
          : pending.action === "decrease"
            ? Math.max(1, item.quantity - 1)
            : 0;
      if (quantity) items.set(variantId, { ...item, quantity });
      else items.delete(variantId);
    }
    return [...items.values()];
  }
  async change(action, item) {
    const { variantId } = item;
    if (
      !this.online ||
      this.checkout ||
      this.checkoutPending ||
      this.pending.has(variantId)
    )
      return;
    const actual = this.bag?.items.find((line) => line.variantId === variantId);
    if (action === "add" && (!item.available || (actual?.quantity ?? 0) >= 99))
      return;
    if (action !== "add" && (!actual || actual.pickedBy.id !== this.me)) return;
    if (action === "decrease" && actual.quantity < 2) return;
    const payload = {
      action,
      variantId,
      ...(action === "remove" ? { expectedQuantity: actual.quantity } : {}),
    };
    const pending = { id: navigationId(), action, item };
    this.pending.set(variantId, pending);
    this.checkoutFeedback = "";
    this.feedback = "Saving your bag…";
    this.render();
    try {
      const ack = await this.command("bag_change", payload, pending.id);
      if (this.pending.get(variantId) !== pending) return;
      this.pending.delete(variantId);
      this.feedback =
        action === "add"
          ? `Added ${item.name} · ${item.variant}.`
          : action === "remove"
            ? `Removed ${item.name} · ${item.variant}.`
            : "Quantity updated.";
      this.merge(ack.bag);
      if (!this.isOpen) this.error(this.feedback);
    } catch (error) {
      if (this.pending.get(variantId) !== pending) return;
      this.pending.delete(variantId);
      this.feedback = error.message;
      this.render();
      if (!this.isOpen) this.error(error.message);
    }
  }

  render() {
    this.publish({
      confirmed: this.bag,
      items: this.projected(),
      pending: new Set(this.pending.keys()),
      checkout: this.checkout,
      checkoutEnabled: this.checkoutEnabled,
      checkoutPending: this.checkoutPending,
      releasing: this.releasing,
      feedback: this.checkoutFeedback || this.feedback || "",
      cue: this.cue,
    });
  }
}
