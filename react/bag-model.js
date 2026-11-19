import { navigationId } from "../client/realtime.js";

export const INTERRUPTED = "Review your bag; an update was interrupted.";
const pendingKey = (identity) => "coshop:bag-pending:" + identity;

export function createBag(command, checkoutRequest, publish, error) {
  return new BagModel(command, checkoutRequest, publish, error);
}

class BagModel {
  constructor(command, checkoutRequest, publish, error) {
    Object.assign(this, { command, checkoutRequest, publish, error });
    this.pending = new Map();
    this.own = new Set();
  }

  dispose() {
    clearTimeout(this.changeTimer);
    this.changed = null;
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
      this.changed = null;
      clearTimeout(this.changeTimer);
      // A marker left by an unacknowledged change means it may or may not have been accepted.
      try {
        if (sessionStorage.getItem(pendingKey(identity)))
          this.feedback = INTERRUPTED;
        sessionStorage.removeItem(pendingKey(identity));
      } catch {}
      if (this.feedback) this.error(this.feedback);
    }
    this.checkoutEnabled = room.checkoutEnabled;
    this.checkout = room.checkout;
    this.merge(room.bag, null, true);
    this.releaseOnReturn();
  }
  merge(bag, change, resync = false) {
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
      const previous = this.bag;
      this.bag = bag;
      if (change?.action === "add")
        this.cue = { id: change.requestId, variantId: change.variantId };
      if (previous && (resync || (change && !change.action)))
        this.highlight(previous, bag, resync);
      else if (
        change?.action &&
        !this.own.has(change.requestId) &&
        !this.pending.size &&
        this.feedback !== INTERRUPTED
      )
        this.feedback = "";
    }
    this.render();
  }
  highlight(previous, bag, resync) {
    if (!this.pending.size) {
      if (this.feedback !== INTERRUPTED) this.feedback = "";
      if (resync) this.checkoutFeedback = "";
    }
    const before = new Map(previous.items.map((item) => [item.variantId, item]));
    const after = new Set(bag.items.map((item) => item.variantId));
    const ids = bag.items
      .filter((item) => {
        const old = before.get(item.variantId);
        return (
          !old ||
          old.quantity !== item.quantity ||
          old.cents !== item.cents ||
          old.currency !== item.currency ||
          old.available !== item.available
        );
      })
      .map((item) => item.variantId);
    const removed = previous.items.filter(
      (item) => !after.has(item.variantId),
    ).length;
    if (!ids.length && !removed) return;
    clearTimeout(this.changeTimer);
    this.changed = ids.length
      ? { id: navigationId(), variantIds: new Set(ids) }
      : null;
    if (!this.pending.size && this.feedback !== INTERRUPTED)
      this.feedback =
        "Bag refreshed · " +
        [
          ids.length && ids.length + (ids.length === 1 ? " line" : " lines") + " changed",
          removed && removed + " removed",
        ]
          .filter(Boolean)
          .join(", ") +
        ".";
    if (this.changed)
      this.changeTimer = setTimeout(() => {
        this.changed = null;
        if (this.feedback.startsWith("Bag refreshed")) this.feedback = "";
        this.render();
      }, this.highlightMs ?? 4000);
  }
  remember(identity, variantId, requestId) {
    try {
      const key = pendingKey(identity);
      const marks = JSON.parse(sessionStorage.getItem(key) || "{}");
      if (requestId) marks[variantId] = requestId;
      else delete marks[variantId];
      if (Object.keys(marks).length)
        sessionStorage.setItem(key, JSON.stringify(marks));
      else sessionStorage.removeItem(key);
    } catch {}
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
    const request = {
      id,
      revision: this.bag.revision,
      pricedAt: this.bag.pricedAt,
    };
    // Saved first so a lock from a lost response is released on return.
    try {
      sessionStorage.setItem("coshop:checkout:" + identity, id);
    } catch {}
    try {
      let result;
      // Retrying the same id resumes a checkout whose response was lost.
      for (let attempt = 1; ; attempt++)
        try {
          result = await this.checkoutRequest("checkout", request);
          break;
        } catch (error) {
          if (
            attempt === 3 ||
            !["NETWORK", "CHECKOUT_PENDING"].includes(error.code)
          )
            throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, (this.retryDelay ?? 750) * attempt),
          );
          if (identity !== this.identity) return;
        }
      if (identity !== this.identity) return;
      if (result.checkout?.id && result.checkout.id !== id)
        try {
          sessionStorage.setItem(
            "coshop:checkout:" + identity,
            result.checkout.id,
          );
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
    const identity = this.identity;
    this.pending.set(variantId, pending);
    this.own.add(pending.id);
    if (this.own.size > 64) this.own.delete(this.own.values().next().value);
    this.remember(identity, variantId, pending.id);
    this.checkoutFeedback = "";
    this.feedback = "Saving your bag…";
    this.render();
    try {
      const ack = await this.command("bag_change", payload, pending.id);
      this.remember(identity, variantId);
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
      this.remember(identity, variantId);
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
      changed: this.changed,
    });
  }
}
