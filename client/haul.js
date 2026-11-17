import { $, faces, make } from "./rooms.js";
import { navigationId } from "./realtime.js";

const total = (recap) =>
  recap.totals
    .map(({ currency, cents }) =>
      new Intl.NumberFormat("en-CA", {
        style: "currency",
        currency,
        currencyDisplay: "code",
      }).format(cents / 100),
    )
    .join(" + ");
const count = (recap) =>
  `${recap.totalQuantity} ${recap.totalQuantity === 1 ? "item" : "items"}`;

export class HaulUI {
  constructor(request) {
    this.request = request;
    this.dialog = $("haul-dialog");
    $("open-haul").onclick = () => this.open($("open-haul"));
    $("close-haul").onclick = () => this.close();
    $("bag-demo-complete").onclick = () => this.complete();
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
  }
  setConnected(online) {
    this.online = online;
    this.updateDemo();
  }
  snapshot(room) {
    if (this.room !== room.id) {
      this.room = room.id;
      this.recap = null;
      this.pending = null;
      this.retry = null;
      $("haul-banner").hidden = true;
    }
    this.sample = room.catalogMode === "sample";
    this.updateDemo();
    this.show(room.recap);
  }
  updateDemo() {
    $("bag-demo-actions").hidden = !this.sample;
    const button = $("bag-demo-complete");
    button.disabled =
      !this.online ||
      Boolean(this.pending) ||
      !this.bag?.items.length ||
      Boolean(this.bag?.unavailable) ||
      this.bagPending;
    button.textContent = this.pending
      ? "Creating the demo recap…"
      : "Demo completion · simulated";
  }
  show(recap) {
    if (!recap || this.recap?.id === recap.id) return;
    this.recap = recap;
    const demo = recap.mode === "demo";
    $("haul-banner").hidden = false;
    $("haul-banner-label").textContent = demo
      ? "Simulated haul ready"
      : "Shopify payment verified";
    $("haul-banner-summary").textContent = count(recap) + " · " + total(recap);
    $("haul-mode").textContent = demo
      ? "Sample room · simulation"
      : "Shopify payment verified";
    $("haul-detail").textContent = demo
      ? "This is a simulated recap. No order was placed and no payment was taken."
      : "Shopify confirmed this order was paid. The total below is the order total, including applicable taxes and shipping.";
    $("haul-count").textContent = count(recap);
    $("haul-total").textContent = total(recap);
    $("haul-items").replaceChildren(
      ...recap.items.map((item) => {
        const row = make("li", undefined, "haul-item");
        if (item.image) {
          const image = make("img");
          image.alt = "";
          image.src = item.image;
          row.append(image);
        }
        const copy = make("div");
        copy.append(make("h3", item.name), make("p", item.variant));
        if (item.pickedBy) {
          const picker = make("p", undefined, "haul-picker");
          const face = make(
            "span",
            faces[item.pickedBy.avatar] || ":)",
            "face " + item.pickedBy.avatar,
          );
          face.setAttribute("aria-hidden", "true");
          picker.append(face, make("span", "Picked by " + item.pickedBy.name));
          copy.append(picker);
        }
        row.append(copy, make("span", "×" + item.quantity, "haul-quantity"));
        return row;
      }),
    );
    $("haul-highlights").hidden = !recap.highlights.length;
    $("haul-shares").replaceChildren(
      ...recap.highlights.map((item) =>
        make("li", `${item.name} · ${item.variant} · shared ${item.count}×`),
      ),
    );
  }
  open(trigger) {
    if (!this.recap || this.dialog.open) return;
    this.trigger = trigger;
    this.dialog.showModal();
  }
  close() {
    if (!this.dialog.open) return;
    this.dialog.close();
    if (this.trigger?.getClientRects().length)
      this.trigger.focus({ preventScroll: true });
  }
  async complete() {
    if (
      !this.sample ||
      !this.online ||
      this.pending ||
      !this.bag?.items.length ||
      this.bag.unavailable ||
      this.bagPending
    )
      return;
    const revision = this.bag.revision;
    const attempt =
      this.retry?.revision === revision
        ? this.retry
        : { revision, id: navigationId() };
    this.pending = attempt;
    this.updateDemo();
    try {
      const { recap } = await this.request(attempt);
      if (this.pending !== attempt) return;
      this.retry = null;
      this.show(recap);
      if ($("bag-drawer").open) this.open($("bag-demo-complete"));
    } catch (error) {
      if (this.pending !== attempt) return;
      this.retry = error.code === "NETWORK" ? attempt : null;
      $("bag-status").textContent = error.message;
    } finally {
      if (this.pending === attempt) {
        this.pending = null;
        this.updateDemo();
      }
    }
  }
  bagState(bag, pending) {
    this.bag = bag;
    this.bagPending = pending;
    this.updateDemo();
  }
}
