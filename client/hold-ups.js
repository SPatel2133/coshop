import { $, make } from "./rooms.js";

// Local seen state is per viewer, keyed by variant, and never sent to the server.
export class FindsState {
  constructor(seen = [], save = () => {}) {
    this.cards = new Map();
    this.seen = new Set(seen);
    this.save = save;
  }
  merge(find) {
    const old = this.cards.get(find.variantId);
    if (old && old.latestShare.sequence >= find.latestShare.sequence)
      return false;
    this.cards.set(find.variantId, find);
    return true;
  }
  snapshot(finds) {
    const present = new Set(finds.map((f) => f.variantId));
    for (const id of this.cards.keys())
      if (!present.has(id)) this.cards.delete(id);
    for (const find of finds) this.merge(find);
  }
  ordered() {
    return [...this.cards.values()].sort((a, b) => b.sequence - a.sequence);
  }
  unseen() {
    return this.ordered().filter((f) => !this.seen.has(f.variantId)).length;
  }
  markSeen(id, visible) {
    if (!visible || !this.cards.has(id) || this.seen.has(id)) return false;
    this.seen.add(id);
    this.save([...this.seen]);
    return true;
  }
}

export class FindsUI {
  constructor({ command, view, error }) {
    Object.assign(this, { command, view, error });
    this.nodes = new Map();
    this.reactions = new Set();
    this.bagRevision = -1;
    this.panel = $("finds-panel");
    this.list = $("finds-list");
    this.drawer = $("finds-drawer");
    this.wide = matchMedia("(min-width: 1180px)");
    this.wide.addEventListener("change", () => this.placePanel());
    $("open-finds").onclick = () => this.openDrawer();
    $("close-finds").onclick = () => this.closeDrawer();
    this.drawer.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.closeDrawer();
    });
    this.drawer.addEventListener("keydown", (event) => {
      if (event.key !== "Tab" || !this.drawer.open) return;
      const controls = [
        ...this.drawer.querySelectorAll(
          "button:not([disabled]), [tabindex='0']",
        ),
      ].filter((node) => node.getClientRects().length > 0);
      const first = controls[0],
        last = controls.at(-1);
      if (
        (event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    });
    this.drawer.addEventListener("close", () => {
      this.finishDrawer();
    });
    this.observer = new IntersectionObserver(() => this.checkVisible(), {
      root: this.list,
      threshold: [0.5],
    });
    document.addEventListener("visibilitychange", () => this.checkVisible());
    document.addEventListener(
      "scroll",
      () => {
        this.sizePanel();
        this.checkVisible();
      },
      {
        passive: true,
      },
    );
    addEventListener("resize", () => this.sizePanel());
    this.list.addEventListener("scroll", () => this.checkVisible(), {
      passive: true,
    });
    this.stripObserver = new ResizeObserver((entries) => {
      document.documentElement.style.setProperty(
        "--presence-height",
        entries[0].contentRect.height + 36 + "px",
      );
      this.sizePanel();
    });
    this.stripObserver.observe(document.querySelector(".presence-strip"));
    this.placePanel();
    this.ticker = setInterval(() => this.updateButton(), 200);
  }
  placePanel() {
    if (this.wide.matches && this.drawer.open) this.closeDrawer(false);
    const host = this.wide.matches ? $("finds-desktop") : this.drawer;
    if (this.panel.parentElement !== host) host.append(this.panel);
    this.sizePanel();
    this.checkVisible();
  }
  sizePanel() {
    if (!this.wide.matches || $("room").hidden) return;
    const host = $("finds-desktop");
    const height = Math.max(
      240,
      Math.floor(
        innerHeight - Math.max(0, host.getBoundingClientRect().top) - 16,
      ),
    );
    if (host.style.height !== height + "px") host.style.height = height + "px";
  }
  openDrawer() {
    if (this.wide.matches || this.drawer.open) return;
    this.pageTop = scrollY;
    this.restoreFocus = true;
    this.locked = true;
    document.body.style.setProperty(
      "--drawer-scroll-top",
      -this.pageTop + "px",
    );
    document.documentElement.classList.add("finds-modal-open");
    this.drawer.showModal();
    this.checkVisible();
  }
  closeDrawer(restore = true) {
    this.restoreFocus = restore;
    if (this.drawer.open) {
      this.drawer.close();
      this.finishDrawer();
    }
  }
  finishDrawer() {
    if (!this.locked) return;
    this.locked = false;
    document.documentElement.classList.remove("finds-modal-open");
    document.body.style.removeProperty("--drawer-scroll-top");
    scrollTo({ top: this.pageTop || 0, left: 0, behavior: "instant" });
    if (this.restoreFocus && !this.wide.matches)
      $("open-finds").focus({ preventScroll: true });
  }
  isVisible() {
    return (
      !document.hidden &&
      !$("room").hidden &&
      (this.wide.matches || this.drawer.open)
    );
  }
  checkVisible() {
    if (!this.state || !this.isVisible()) return;
    const bounds = this.list.getBoundingClientRect();
    const top = Math.max(0, bounds.top),
      bottom = Math.min(innerHeight, bounds.bottom);
    for (const [id, node] of this.nodes) {
      const rect = node.getBoundingClientRect();
      this.state.markSeen(
        id,
        rect.height > 0 &&
          Math.max(
            0,
            Math.min(rect.bottom, bottom) - Math.max(rect.top, top),
          ) >=
            rect.height * 0.5,
      );
    }
    this.indicator();
  }
  setIdentity(room, me) {
    const key = "coshop:seen-finds:" + room.id + ":" + me;
    if (key === this.key) return;
    this.key = key;
    this.bagRevision = -1;
    this.cooldownUntil = 0;
    this.successUntil = 0;
    let seen = [];
    try {
      const value = JSON.parse(localStorage.getItem(key) || "[]");
      if (Array.isArray(value))
        seen = value.filter((x) => typeof x === "string");
    } catch {}
    this.state = new FindsState(seen, (ids) => {
      try {
        localStorage.setItem(key, JSON.stringify(ids));
      } catch {}
    });
    for (const node of this.nodes.values()) this.observer.unobserve(node);
    this.nodes.clear();
    this.list.replaceChildren();
  }
  snapshot(room, me) {
    this.setIdentity(room, me);
    this.setBag(room.bag);
    this.state.snapshot(room.finds);
    this.render();
    const mine = room.finds
      .map((f) => f.latestShare)
      .filter((e) => e.by.id === me);
    if (mine.length)
      this.cooldownUntil = Math.max(
        this.cooldownUntil || 0,
        Date.now() +
          Math.max(
            0,
            Math.max(...mine.map((e) => e.createdAt)) + 3000 - room.serverTime,
          ),
      );
    this.updateButton();
  }
  message(message) {
    this.setBag(message.bag);
    if (message.type === "hold_up") {
      const changed = this.state.merge(message.find);
      if (changed)
        this.render(
          message.find.variantId,
          message.event.repeated ? message.event.by.name : null,
        );
    } else this.float(message.event);
  }
  setBag(bag) {
    if (!bag || bag.revision <= this.bagRevision) return;
    this.bagRevision = bag.revision;
    $("bag-count").textContent = "Shared bag · " + bag.totalQuantity;
    $("bag-count").title =
      "Sharing never adds to the bag. Existing saved items are kept; bag editing arrives in Phase 4.";
  }
  setConnected(online) {
    this.online = online;
    this.updateButton();
    for (const node of this.nodes.values())
      for (const button of node.querySelectorAll("[data-reaction]"))
        button.disabled = !online;
    $("finds-connection").textContent = online
      ? "Worth a look, together."
      : "Reconnecting… Saved finds stay here.";
  }
  deactivate() {
    this.setConnected(false);
    this.closeDrawer(false);
  }
  attachButton(button, note, product, variant) {
    this.button = button;
    this.buttonNote = note;
    const context = { product, variant };
    this.buttonContext = context;
    button.onclick = async () => {
      const chosen = variant();
      this.pending = true;
      this.successUntil = 0;
      this.updateButton();
      try {
        const ack = await this.command("hold_up", {
          productId: product.id,
          variantId: chosen,
        });
        this.setBag(ack.bag);
        if (this.state.merge(ack.find)) this.render(ack.find.variantId);
        this.cooldownUntil = Date.now() + 3000;
        if (this.buttonContext === context && variant() === chosen)
          this.successUntil = Date.now() + 1300;
      } catch (error) {
        if (error.retryAfterMs)
          this.cooldownUntil = Date.now() + error.retryAfterMs;
        this.error(
          error.message +
            (error.code === "COOLDOWN"
              ? " Try again when the cooldown ends."
              : " Your page is safe; check your connection and retry."),
        );
      } finally {
        this.pending = false;
        this.updateButton();
      }
    };
    this.updateButton();
  }
  variantChanged() {
    this.successUntil = 0;
    this.updateButton();
  }
  updateButton() {
    if (!this.button) return;
    const wait = Math.max(
      0,
      Math.ceil(((this.cooldownUntil || 0) - Date.now()) / 1000),
    );
    this.button.disabled = !this.online || this.pending || wait > 0;
    this.button.textContent = this.pending
      ? "Sharing…"
      : Date.now() < (this.successUntil || 0)
        ? "Shared ✓"
        : "Share find";
    this.buttonNote.textContent = !this.online
      ? "Reconnect to share a find. You can keep browsing."
      : wait
        ? "Ready to share again in " + wait + "s."
        : "Worth a look? Sharing doesn’t add it to the bag.";
  }
  indicator() {
    const count = this.state?.unseen() || 0;
    $("finds-unseen").textContent = String(count);
    $("finds-unseen").hidden = !count;
    $("finds-count").textContent = String(this.state?.cards.size || 0);
    $("open-finds").setAttribute(
      "aria-label",
      "Our finds" + (count ? ", " + count + " unseen" : ""),
    );
  }
  card(find) {
    const node = make("article", undefined, "shared-find");
    node.dataset.variant = find.variantId;
    const image = make("img");
    image.alt = "";
    image.loading = "lazy";
    const copy = make("div", undefined, "shared-find-copy"),
      heading = make("h3"),
      variant = make("p", "", "find-variant"),
      price = make("p", "", "find-price");
    copy.append(heading, variant, price);
    const warning = make("p", "", "find-warning");
    const by = make("p", "Shared by " + find.sharedBy.name, "shared-by");
    const actions = make("div", undefined, "shared-find-actions"),
      reactions = make("div", undefined, "find-reactions");
    reactions.setAttribute(
      "aria-label",
      "React to " + find.name + ", " + find.variant,
    );
    for (const [emoji, label] of [
      ["❤️", "Love"],
      ["👎", "No"],
      ["🤔", "Hmm"],
    ]) {
      const button = make("button", emoji);
      button.type = "button";
      button.dataset.reaction = emoji;
      button.setAttribute("aria-label", label + " reaction");
      button.disabled = !this.online;
      button.onclick = async () => {
        try {
          await this.command("react", {
            holdUpId: this.state.cards.get(find.variantId).id,
            emoji,
          });
        } catch (error) {
          this.error(error.message);
        }
      };
      reactions.append(button);
    }
    const view = make("button", "View product", "find-view");
    view.type = "button";
    view.onclick = () => {
      this.closeDrawer(false);
      this.view(find.productId, find.variantId);
    };
    actions.append(reactions, view);
    const again = make("p", "", "find-again fine"),
      floats = make("div", undefined, "find-floats");
    floats.setAttribute("aria-live", "polite");
    node.append(image, copy, warning, by, actions, again, floats);
    node.parts = { image, heading, variant, price, warning, by, again, floats };
    return node;
  }
  render(highlight, repeatedBy) {
    this.sizePanel();
    const bounds = this.list.getBoundingClientRect();
    const anchor =
      this.list.scrollTop > 0
        ? [...this.list.children].find(
            (n) => n.getBoundingClientRect().bottom > bounds.top + 1,
          )
        : null;
    const offset = anchor?.getBoundingClientRect().top;
    const ordered = this.state.ordered();
    for (const [id, node] of this.nodes)
      if (!this.state.cards.has(id)) {
        this.observer.unobserve(node);
        node.remove();
        this.nodes.delete(id);
      }
    let next = this.list.firstElementChild;
    for (const find of ordered) {
      let node = this.nodes.get(find.variantId);
      if (!node) {
        node = this.card(find);
        this.nodes.set(find.variantId, node);
        this.observer.observe(node);
      }
      if (node !== next) this.list.insertBefore(node, next);
      next = node.nextElementSibling;
      const p = node.parts;
      if (p.image.getAttribute("src") !== find.image) p.image.src = find.image;
      p.heading.textContent = find.name;
      p.variant.textContent = find.variant;
      p.price.textContent = new Intl.NumberFormat("en-CA", {
        style: "currency",
        currency: find.currency,
        currencyDisplay: "code",
      }).format(find.cents / 100);
      p.warning.hidden = find.available !== false;
      p.warning.textContent =
        find.available === false ? "Unavailable in the sample catalog" : "";
      if (find.variantId === highlight) {
        clearTimeout(node.highlightTimer);
        node.classList.add("find-highlight");
        node.highlightTimer = setTimeout(
          () => node.classList.remove("find-highlight"),
          1600,
        );
        if (repeatedBy) {
          clearTimeout(node.repeatTimer);
          p.again.textContent = repeatedBy + " shared this again";
          node.repeatTimer = setTimeout(() => (p.again.textContent = ""), 3500);
        }
      }
    }
    if (anchor?.isConnected)
      this.list.scrollTop += anchor.getBoundingClientRect().top - offset;
    $("finds-empty").hidden = ordered.length > 0;
    this.indicator();
    this.checkVisible();
  }
  float(event) {
    if (this.reactions.has(event.id)) return;
    this.reactions.add(event.id);
    if (this.reactions.size > 256)
      this.reactions.delete(this.reactions.values().next().value);
    const node = this.nodes.get(event.variantId);
    if (!node || !this.isVisible()) return;
    const layer = node.parts.floats;
    if (layer.children.length >= 6) layer.firstElementChild.remove();
    const float = make(
      "span",
      event.emoji + " " + event.by.name,
      "floating-reaction",
    );
    layer.append(float);
    setTimeout(() => float.remove(), 1800);
  }
}
