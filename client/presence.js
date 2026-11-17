import { $, make, faces } from "./rooms.js";
export function resolveLocation(view, products) {
  if (!view)
    return { title: "Looking around", kind: "category", category: "All" };
  if (view.kind === "category")
    return {
      ...view,
      title: view.category === "All" ? "The whole collection" : view.category,
    };
  const product = products.find((p) => p.id === view.productId);
  const variant = product?.variants.find((v) => v.id === view.variantId);
  if (!product || !variant)
    return { ...view, missing: true, title: "An item no longer here" };
  return { ...view, product, variant, title: product.name };
}
export class Presence {
  constructor(products, onJoin) {
    this.products = products;
    this.onJoin = onJoin;
    this.people = new Map();
    this.nodes = new Map();
    this.removalTimers = new Map();
    this.stale = true;
    $("close-peek").onclick = () => $("peek-dialog").close();
    $("peek-dialog").addEventListener("close", () => {
      this.peekId = null;
    });
  }
  setRoom(room, me) {
    this.me = me;
    this.people = new Map(room.participants.map((p) => [p.id, p]));
    this.render();
  }
  setConnected(connected) {
    this.stale = !connected;
    this.render();
  }
  button(person, small = false) {
    const button = make(
      "button",
      undefined,
      small ? "nearby-person" : "presence-person",
    );
    button.type = "button";
    const face = make(
      "span",
      faces[person.avatar] || ":)",
      "face " + person.avatar,
    );
    face.setAttribute("aria-hidden", "true");
    button.append(face);
    if (!small) {
      const text = make("span", undefined, "presence-copy");
      text.append(make("strong"), make("span", undefined, "presence-location"));
      button.append(text);
    }
    button.onclick = () => this.peek(person.id);
    return button;
  }
  render() {
    const connected = [...this.people.values()].filter((p) => p.connected);
    for (const person of connected) {
      clearTimeout(this.removalTimers.get(person.id));
      this.removalTimers.delete(person.id);
      let li = this.nodes.get(person.id);
      if (!li) {
        li = make("li", undefined, "presence-seat");
        li.append(this.button(person));
        this.nodes.set(person.id, li);
        $("members").append(li);
      }
      const button = li.firstElementChild,
        place = resolveLocation(person.view, this.products);
      li.classList.remove("leaving");
      li.classList.toggle("away", person.away);
      li.classList.toggle("presence-stale", this.stale);
      button.disabled = false;
      button.querySelector("strong").textContent =
        person.name + (person.id === this.me ? " (you)" : "");
      button.querySelector(".presence-location").textContent =
        (person.away ? "Away · " : "") + place.title;
      button.setAttribute(
        "aria-label",
        "Peek at " +
          person.name +
          (person.away ? ", away" : "") +
          ": " +
          place.title,
      );
      button.title =
        person.name +
        " · " +
        place.title +
        (place.variant ? " · " + place.variant.title : "");
    }
    for (const [id, li] of this.nodes)
      if (!this.people.get(id)?.connected && !this.removalTimers.has(id)) {
        li.classList.add("leaving");
        li.firstElementChild.disabled = true;
        this.removalTimers.set(
          id,
          setTimeout(() => {
            li.remove();
            this.nodes.delete(id);
            this.removalTimers.delete(id);
          }, 220),
        );
      }
    // Preserve the room's stable participant order after refresh/reconnect,
    // without replacing focused avatar buttons on each presence update.
    let nextNode = $("members").firstElementChild;
    for (const person of connected) {
      const li = this.nodes.get(person.id);
      if (li !== nextNode) $("members").insertBefore(li, nextNode);
      nextNode = li.nextElementSibling;
    }
    const reserved = [...this.people.values()].filter(
      (p) => !p.connected,
    ).length;
    $("company-note").textContent = this.stale
      ? "Reconnecting. These are the last places we saw your people."
      : reserved
        ? `${reserved} ${reserved === 1 ? "seat is" : "seats are"} saved for reconnecting friends. Tap an avatar to peek.`
        : "See what catches their eye. Tap an avatar to peek without leaving your place.";
    this.renderNearby();
    if (this.peekId) this.renderPeek();
  }
  peek(id) {
    if (!this.people.get(id)?.connected) return;
    this.peekId = id;
    this.peekSignature = null;
    this.renderPeek();
    if (!$("peek-dialog").open) $("peek-dialog").showModal();
  }
  renderPeek() {
    const person = this.people.get(this.peekId),
      content = $("peek-content");
    const signature = JSON.stringify([
      this.peekId,
      this.stale,
      person?.connected,
      person?.away,
      person?.view?.eventId,
    ]);
    if (signature === this.peekSignature) return;
    this.peekSignature = signature;
    const hadJoinFocus = document.activeElement?.id === "peek-join";
    if (!person) {
      content.replaceChildren(
        make("h2", "They stepped out."),
        make("p", "Your place is still right where you left it."),
      );
      return;
    }
    const place = resolveLocation(person.view, this.products);
    $("peek-heading").textContent = "A peek at " + person.name + "’s find";
    const headline = make("div", undefined, "peek-person");
    headline.append(
      make("span", faces[person.avatar], "face " + person.avatar),
      make("p", person.name + (person.away ? " · away" : ""), "eyebrow"),
    );
    const card = make("div", undefined, "peek-card");
    if (place.product) {
      const image = make("img");
      image.src = place.variant.image || place.product.image;
      image.alt = place.product.name;
      card.append(image);
      card.append(
        make("h2", place.product.name),
        make("p", place.variant.title, "peek-variant"),
      );
      card.append(
        make(
          "strong",
          new Intl.NumberFormat("en-CA", {
            style: "currency",
            currency: place.variant.currency,
          }).format(place.variant.cents / 100),
          "peek-price",
        ),
      );
      if (!place.variant.available)
        card.append(
          make(
            "p",
            "Currently unavailable. You can still take a look.",
            "availability-note",
          ),
        );
    } else {
      card.append(
        make(
          "pre",
          place.missing ? "[ item not found ]" : "[ : ) ]  [ : ) ]",
          "peek-ascii",
        ),
        make("h2", place.title),
      );
      card.append(
        make(
          "p",
          place.missing
            ? "This item is no longer in the collection."
            : "A little wander through " + place.title.toLowerCase() + ".",
          "fine",
        ),
      );
    }
    const state = make(
      "p",
      this.stale
        ? "Reconnect before joining their place."
        : !person.connected
          ? "They lost connection. Their seat is saved."
          : "Just a peek. Your page hasn’t moved.",
      "fine",
    );
    const join = make(
      "button",
      place.product
        ? "Join " + person.name + " here ↗"
        : "Join this category ↗",
      "primary full",
    );
    join.type = "button";
    join.id = "peek-join";
    join.disabled = this.stale || !person.connected || Boolean(place.missing);
    join.onclick = () => {
      // Resolve again at click time: a live peek may have moved since it opened.
      const latest = this.people.get(this.peekId),
        destination = resolveLocation(latest?.view, this.products);
      if (!latest?.connected || destination.missing || this.stale) return;
      this.onJoin(destination);
      $("peek-dialog").close();
    };
    content.replaceChildren(headline, card, state, join);
    if (hadJoinFocus) join.focus({ preventScroll: true });
  }
  setLocalProduct(productId) {
    this.localProductId = productId;
    this.renderNearby();
  }
  renderNearby() {
    const nearby = [...this.people.values()].filter(
      (p) =>
        p.connected &&
        p.id !== this.me &&
        p.view?.kind === "product" &&
        p.view.productId === this.localProductId,
    );
    const signature = JSON.stringify(nearby.map((p) => [p.id, p.away]));
    if (signature === this.nearbySignature) return;
    this.nearbySignature = signature;
    const container = $("nearby-people");
    container.replaceChildren(
      ...nearby.map((person) => {
        const button = this.button(person, true);
        button.title =
          person.name +
          (person.away ? " · away" : "") +
          " is looking at this too";
        button.setAttribute(
          "aria-label",
          "Peek at " + person.name + " on this product",
        );
        button.classList.toggle("away", person.away);
        return button;
      }),
    );
    $("nearby-note").textContent = nearby.length
      ? "At this rack with you"
      : "A little space to look around";
  }
}
