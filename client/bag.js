import { $, faces, make } from "./rooms.js";
import { navigationId } from "./realtime.js";

const money = ({ currency, cents }) =>
  new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    currencyDisplay: "code",
  }).format(cents / 100);
const bagButton = (text, label) => {
  const button = make("button", text, "quiet");
  button.type = "button";
  if (label) button.setAttribute("aria-label", label);
  return button;
};
export class BagUI {
  constructor(command, error, displayName, checkoutRequest) {
    Object.assign(this, { command, error, displayName, checkoutRequest });
    this.openers = [$("open-bag"), $("open-bag-quick")];
    this.dialog = $("bag-drawer");
    this.list = $("bag-items");
    this.pending = new Map();
    this.rows = new Map();
    for (const opener of this.openers) opener.onclick = () => this.open(opener);
    $("close-bag").onclick = () => this.close();
    $("bag-checkout").onclick = () => this.startCheckout();
    $("bag-checkout-release").onclick = () => this.releaseCheckout();
    addEventListener("pageshow", () => {
      this.departing = false;
      this.releaseOnReturn();
    });
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    this.dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const buttons = [...this.dialog.querySelectorAll("button")].filter(
        (button) => !button.disabled && button.getClientRects().length,
      );
      const first = buttons[0],
        last = buttons.at(-1);
      if (
        event.shiftKey
          ? document.activeElement === first
          : document.activeElement === last
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    });
  }
  open(trigger) {
    if (this.dialog.open) return;
    this.trigger = trigger;
    this.pageTop = scrollY;
    this.dialog.showModal();
    for (const opener of this.openers)
      opener.setAttribute("aria-expanded", "true");
    document.body.style.setProperty("--bag-scroll-top", -this.pageTop + "px");
    document.documentElement.classList.add("bag-open");
    $("close-bag").focus({ preventScroll: true });
    this.render();
  }
  close(restore = true) {
    if (!this.dialog.open) return;
    this.dialog.close();
    for (const opener of this.openers)
      opener.setAttribute("aria-expanded", "false");
    document.documentElement.classList.remove("bag-open");
    document.body.style.removeProperty("--bag-scroll-top");
    scrollTo({ top: this.pageTop, behavior: "instant" });
    if (restore) this.trigger.focus({ preventScroll: true });
  }
  snapshot(room, me) {
    const identity = room.id + ":" + me;
    if (this.identity !== identity) {
      this.identity = identity;
      this.me = me;
      this.pending.clear();
      this.bag = null;
      this.feedback = "";
      this.checkoutFeedback = "";
    }
    this.checkoutEnabled = room.checkoutEnabled;
    this.checkout = room.checkout;
    this.live = room.catalogMode === "shopify";
    this.updateBanner();
    this.merge(room.bag);
    this.releaseOnReturn();
  }
  updateBanner() {
    $("checkout-banner").hidden = !this.checkout;
    $("checkout-banner").textContent = this.checkout
      ? this.checkout.name +
        " is checking out on Shopify. The bag is read-only for now."
      : "";
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
      if (change?.action === "add") this.animate(change.variantId);
    }
    this.render();
  }
  animate(variantId) {
    for (const opener of this.openers) opener.classList.remove("bag-landing");
    this.rows.get(variantId)?.row.classList.remove("bag-line-landing");
    requestAnimationFrame(() => {
      for (const opener of this.openers) opener.classList.add("bag-landing");
      this.rows.get(variantId)?.row.classList.add("bag-line-landing");
    });
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
      this.checkoutPending = false;
      this.render();
    }
  }
  async releaseCheckout() {
    if (!this.checkout || this.checkout.shopperId !== this.me || this.releasing)
      return;
    const id = this.checkout.id;
    this.releasing = true;
    try {
      const { checkout } = await this.checkoutRequest("checkout-release", {
        id,
      });
      if (this.checkout?.id === id) this.checkout = checkout;
      this.updateBanner();
      try {
        sessionStorage.removeItem("coshop:checkout:" + this.identity);
      } catch {}
      this.checkoutFeedback = "Bag unlocked. No purchase was confirmed.";
    } catch (error) {
      this.checkoutFeedback = error.message;
    } finally {
      this.releasing = false;
      this.render();
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
  attach(button, product, selected) {
    this.product = { button, product, selected };
    button.onclick = () => {
      const variant = selected();
      const person = this.displayName();
      if (!person) return;
      this.change("add", {
        productId: product.id,
        variantId: variant.id,
        quantity: 0,
        name: product.name,
        image: product.image,
        variant: variant.title,
        cents: variant.cents,
        currency: variant.currency,
        available: variant.available,
        pickedBy: person,
      });
    };
    this.updateProduct();
  }
  updateProduct() {
    if (!this.product) return;
    const { button, selected } = this.product;
    const variant = selected();
    const line = this.bag?.items.find((item) => item.variantId === variant.id);
    const pending = this.pending.has(variant.id);
    button.disabled =
      !this.online ||
      Boolean(this.checkout) ||
      this.checkoutPending ||
      !variant.available ||
      pending ||
      (line?.quantity ?? 0) >= 99;
    button.textContent = !variant.available
      ? "Unavailable"
      : pending
        ? "Saving…"
        : this.checkout || this.checkoutPending
          ? "Bag locked"
          : !this.online
            ? "Reconnect to add"
            : line?.quantity >= 99
              ? "Bag limit reached"
              : "Add to bag";
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
      if (!this.dialog.open) this.error(this.feedback);
    } catch (error) {
      if (this.pending.get(variantId) !== pending) return;
      this.pending.delete(variantId);
      this.feedback = error.message;
      this.render();
      if (!this.dialog.open) this.error(error.message);
    }
  }
  createRow(item) {
    const row = make("li", undefined, "bag-line");
    const image = make("img");
    image.alt = "";
    image.loading = "lazy";
    if (item.image) image.src = item.image;
    else image.hidden = true;
    const title = make("h3", item.name),
      variant = make("p", item.variant, "bag-variant");
    const price = make("p", "", "bag-price"),
      picker = make("p", "", "bag-picker");
    const face = make("span", "", "face");
    face.setAttribute("aria-hidden", "true");
    const pickerName = make("span");
    picker.append(face, pickerName);
    const warning = make(
      "p",
      "Unavailable in this collection",
      "bag-line-warning",
    );
    warning.hidden = item.available;
    const detail = make("div", undefined, "bag-line-detail");
    detail.append(title, variant, price, picker, warning);
    const controls = make("div", undefined, "bag-line-controls");
    const label = item.name + ", " + item.variant;
    const minus = bagButton("−", "Decrease quantity of " + label);
    const plus = bagButton("+", "Increase quantity of " + label);
    const remove = bagButton("Remove", "Remove " + label);
    const quantity = make("span", "", "bag-quantity");
    controls.append(minus, quantity, plus, remove);
    row.append(image, detail, controls);
    const record = {
      row,
      image,
      title,
      variant,
      warning,
      price,
      face,
      pickerName,
      minus,
      plus,
      remove,
      quantity,
    };
    minus.onclick = () => this.change("decrease", record.item);
    plus.onclick = () => this.change("add", record.item);
    remove.onclick = () => this.change("remove", record.item);
    return record;
  }
  render() {
    const items = this.projected();
    const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
    $("bag-count").textContent = String(quantity);
    $("bag-count-quick").textContent = String(quantity);
    for (const [index, opener] of this.openers.entries())
      opener.setAttribute(
        "aria-label",
        `${index ? "Bag" : "Shared bag"}, ${quantity} ${quantity === 1 ? "item" : "items"}`,
      );
    this.updateProduct();
    this.onChange?.(this.bag, this.pending.size > 0);
    if (!this.dialog.open) return;
    $("bag-summary").textContent =
      `${quantity} ${quantity === 1 ? "item" : "items"}`;
    $("bag-status").textContent = !this.online
      ? "Reconnecting… Your bag is saved."
      : this.pending.size
        ? "Saving your bag…"
        : this.checkoutPending
          ? this.checkoutFeedback
          : this.checkout
            ? this.checkout.name + " is checking out…"
            : this.checkoutFeedback || this.feedback;
    $("bag-disclosure").textContent = this.live
      ? this.checkoutEnabled
        ? "One shopper checks out for the group. Shopify shows shipping and taxes at checkout."
        : "Shopify checkout is unavailable for this room’s store."
      : "Sample collection · reference prices. Checkout isn’t available in this demo.";
    $("bag-checkout-actions").hidden = !this.checkoutEnabled;
    $("bag-checkout").disabled =
      !quantity ||
      !this.online ||
      Boolean(this.checkout) ||
      this.checkoutPending ||
      Boolean(this.pending.size) ||
      Boolean(this.bag?.unavailable);
    $("bag-checkout-release").hidden =
      !this.checkout ||
      this.checkout.shopperId !== this.me ||
      this.checkoutPending;
    $("bag-empty").hidden = items.length > 0;
    const active = document.activeElement;
    const keys = new Set(items.map((item) => item.variantId));
    for (const [key, record] of this.rows) {
      if (keys.has(key)) continue;
      if (record.row.contains(active))
        $("close-bag").focus({ preventScroll: true });
      record.row.remove();
      this.rows.delete(key);
    }
    let next = this.list.firstElementChild;
    for (const item of items) {
      const record = this.rows.get(item.variantId) ?? this.createRow(item);
      record.item = item;
      this.rows.set(item.variantId, record);
      if (record.row !== next) this.list.insertBefore(record.row, next);
      next = record.row.nextElementSibling;
      const { face, price, pickerName, quantity, minus, plus, remove } = record;
      record.title.textContent = item.name;
      record.variant.textContent = item.variant;
      record.image.hidden = !item.image;
      if (item.image && record.image.getAttribute("src") !== item.image)
        record.image.src = item.image;
      record.warning.hidden = item.available;
      price.textContent =
        item.cents === null ? "Price unavailable" : money(item) + " each";
      face.textContent = faces[item.pickedBy.avatar] || ":)";
      face.className = "face " + item.pickedBy.avatar;
      pickerName.textContent = "Picked by " + item.pickedBy.name;
      quantity.textContent = String(item.quantity);
      quantity.setAttribute("aria-label", "Quantity " + item.quantity);
      const owner = item.pickedBy.id === this.me;
      const inactive =
        !this.online ||
        Boolean(this.checkout) ||
        this.checkoutPending ||
        this.pending.has(item.variantId);
      minus.hidden = remove.hidden = !owner;
      minus.setAttribute(
        "aria-disabled",
        String(inactive || item.quantity <= 1),
      );
      plus.setAttribute(
        "aria-disabled",
        String(inactive || !item.available || item.quantity >= 99),
      );
      remove.setAttribute("aria-disabled", String(inactive));
    }
    const totals = new Map();
    for (const item of items)
      if (item.currency && item.cents !== null)
        totals.set(
          item.currency,
          (totals.get(item.currency) ?? 0) + item.cents * item.quantity,
        );
    $("bag-total").textContent =
      [...totals]
        .map(([currency, cents]) => money({ currency, cents }))
        .join(" + ") || "—";
    const unavailable = items.some((item) => !item.available);
    $("bag-warning").hidden = !unavailable;
    $("bag-warning").textContent = unavailable
      ? "Unavailable items must be removed by their picker before checkout."
      : "";
  }
}
