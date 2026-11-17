import { $, make } from "./rooms.js";

// Pure queue: no DOM, no network and injectable timers for deterministic tests.
export class HoldUpQueue {
  constructor({
    render,
    completed = 0,
    save = () => {},
    clock = Date.now,
    later = (fn, ms) => setTimeout(fn, ms),
    cancel = (id) => clearTimeout(id),
  }) {
    Object.assign(this, { render, completed, save, clock, later, cancel });
    this.items = [];
    this.seen = new Set();
    this.paused = false;
  }
  add(events) {
    for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
      if (event.sequence <= this.completed || this.seen.has(event.id)) continue;
      this.seen.add(event.id);
      this.items.push(event);
    }
    // Live frames and resync snapshots are ordered by the authoritative server.
    this.items.sort((a, b) => a.sequence - b.sequence);
    this.update();
  }
  update() {
    const active = this.items[0];
    if (active?.id !== this.activeId) {
      this.cancel(this.timer);
      this.paused = false;
      this.activeId = active?.id;
      if (active) this.timer = this.later(() => this.dismiss(), 8000);
    }
    this.render(active || null, this.items.length, this.paused);
  }
  interact() {
    if (!this.items.length) return;
    this.paused = true;
    this.cancel(this.timer);
    this.update();
  }
  dismiss() {
    const event = this.items.shift();
    if (!event) return;
    this.completed = Math.max(this.completed, event.sequence);
    this.save(this.completed);
    this.update();
  }
  stop() {
    this.cancel(this.timer);
  }
}

export class HoldUpsUI {
  constructor({ command, view, error }) {
    Object.assign(this, { command, view, error });
    this.bagRevision = -1;
    this.reactions = new Set();
    this.online = false;
    const popup = $("hold-up-popup");
    popup.addEventListener("pointerenter", () => this.queue?.interact());
    popup.addEventListener("pointerdown", () => this.queue?.interact());
    popup.addEventListener("focusin", () => this.queue?.interact());
    document.addEventListener("keydown", (event) => {
      if (
        event.key === "Escape" &&
        !popup.hidden &&
        !document.querySelector("dialog[open]")
      )
        this.queue?.dismiss();
    });
    this.ticker = setInterval(() => this.updateButton(), 200);
  }
  setIdentity(room, me) {
    const key = "coshop:finds:" + room.id + ":" + me;
    if (this.key === key) return;
    this.key = key;
    this.queue?.stop();
    this.renderedId = null;
    this.bagRevision = -1;
    let saved = null;
    try {
      saved = sessionStorage.getItem(key);
    } catch {}
    // A new participant sees current finds, not two minutes of old popups.
    const old = room.holdUps.filter(
      (e) => e.createdAt < room.serverTime - 8000,
    );
    const completed =
      saved === null
        ? Math.max(0, ...old.map((e) => e.sequence))
        : Number(saved) || 0;
    this.queue = new HoldUpQueue({
      completed,
      render: (...args) => this.render(...args),
      save: (n) => {
        try {
          sessionStorage.setItem(key, String(n));
        } catch {}
      },
    });
    this.queue.save(completed);
  }
  snapshot(room, me) {
    this.setIdentity(room, me);
    this.setBag(room.bag);
    this.queue.add(room.holdUps);
    const latest = [...room.holdUps].reverse().find((e) => e.by.id === me);
    if (latest)
      this.cooldownUntil = Math.max(
        this.cooldownUntil || 0,
        Date.now() + Math.max(0, latest.createdAt + 3000 - room.serverTime),
      );
    this.updateButton();
  }
  message(message) {
    this.setBag(message.bag);
    if (message.type === "hold_up") this.queue.add([message.event]);
    else this.float(message.event);
  }
  setBag(bag) {
    if (!bag || bag.revision < this.bagRevision) return;
    this.bagRevision = bag.revision;
    $("bag-count").textContent = "Shared bag · " + bag.totalQuantity;
    $("bag-count").title =
      "Sample bag. Quantity controls and checkout arrive in later phases.";
  }
  setConnected(online) {
    this.online = online;
    this.updateButton();
    for (const button of $("hold-up-popup").querySelectorAll("[data-reaction]"))
      button.disabled = !online;
  }
  deactivate() {
    this.queue?.stop();
    if (this.queue) this.queue.items = [];
    this.setConnected(false);
    $("hold-up-popup").hidden = true;
  }
  attachButton(button, product, variant) {
    this.button = button;
    button.onclick = async () => {
      this.pending = true;
      this.updateButton();
      try {
        const ack = await this.command("hold_up", {
          productId: product.id,
          variantId: variant(),
        });
        this.setBag(ack.bag);
        this.queue.add([ack.event]);
        this.cooldownUntil = Date.now() + 3000;
      } catch (error) {
        if (error.retryAfterMs)
          this.cooldownUntil = Date.now() + error.retryAfterMs;
        this.error(error.message);
      } finally {
        this.pending = false;
        this.updateButton();
      }
    };
    this.updateButton();
  }
  updateButton() {
    if (!this.button) return;
    const wait = Math.max(
      0,
      Math.ceil(((this.cooldownUntil || 0) - Date.now()) / 1000),
    );
    this.button.disabled = !this.online || this.pending || wait > 0;
    this.button.textContent = !this.online
      ? "Reconnect to hold up"
      : this.pending
        ? "Sharing your find…"
        : wait
          ? "Another find in " + wait + "s"
          : "Hold up ✋";
  }
  render(event, length, paused) {
    const popup = $("hold-up-popup");
    const hadFocus = popup.contains(document.activeElement);
    popup.hidden = !event;
    if (!event) {
      this.renderedId = null;
      if (hadFocus)
        (this.button?.isConnected
          ? this.button
          : $("back-to-collection")
        ).focus();
      return;
    }
    if (event.id !== this.renderedId) {
      this.renderedId = event.id;
      popup.replaceChildren();
      const top = make("div", undefined, "find-top");
      top.append(
        make("span", "✋  " + event.by.name + " held this up", "find-person"),
        make("span", "+ +", "find-ascii"),
      );
      const body = make("div", undefined, "find-body"),
        img = make("img");
      img.src = event.image;
      img.alt = "";
      const copy = make("div");
      const heading = make("h2", event.name);
      heading.id = "find-heading";
      const price = new Intl.NumberFormat("en-CA", {
        style: "currency",
        currency: event.currency,
      }).format(event.cents / 100);
      copy.append(
        heading,
        make("p", event.variant + " · " + price),
        make(
          "p",
          event.available ? "Sample product" : "Unavailable · sample product",
          "fine",
        ),
      );
      body.append(img, copy);
      const receipt = make(
        "p",
        event.repeated
          ? "Already in the bag · picked by " +
              event.pickedBy.name +
              " · quantity " +
              event.quantity
          : "Added to your shared bag · picked by " + event.pickedBy.name,
        "find-receipt",
      );
      popup.append(top, body, receipt);
      if (event.repeated)
        popup.append(
          make(
            "p",
            "Held up again by " +
              event.by.name +
              ". The original pick and quantity stay the same.",
            "find-repeat fine",
          ),
        );
      const actions = make("div", undefined, "find-actions"),
        reactions = make("div", undefined, "find-reactions");
      reactions.setAttribute("aria-label", "React to this find");
      [
        ["❤️", "Love"],
        ["👎", "No"],
        ["🤔", "Hmm"],
      ].forEach(([emoji, label]) => {
        const button = make("button", emoji);
        button.type = "button";
        button.dataset.reaction = emoji;
        button.setAttribute("aria-label", label + " reaction");
        button.disabled = !this.online;
        button.onclick = async () => {
          this.queue.interact();
          try {
            await this.command("react", { holdUpId: event.id, emoji });
          } catch (error) {
            this.error(error.message);
          }
        };
        reactions.append(button);
      });
      const view = make("button", "View ↗", "primary");
      view.type = "button";
      view.onclick = () => {
        this.view(event.productId, event.variantId);
        this.queue.dismiss();
      };
      const dismiss = make("button", "Dismiss", "quiet");
      dismiss.type = "button";
      dismiss.onclick = () => this.queue.dismiss();
      actions.append(reactions, dismiss, view);
      this.queueNote = make("p", "", "find-queue fine");
      const floats = make("div", undefined, "find-floats");
      floats.id = "find-floats";
      floats.setAttribute("aria-live", "polite");
      popup.append(actions, this.queueNote, floats);
      if (hadFocus) dismiss.focus();
      $("find-announcement").textContent =
        event.by.name +
        " held up " +
        event.name +
        ", " +
        event.variant +
        ", " +
        price +
        ".";
    }
    this.queueNote.textContent =
      (length > 1 ? length - 1 + " more waiting · " : "") +
      ((this.queue?.paused ?? paused)
        ? "Take your time. View or dismiss when ready."
        : "Closes in 8s · interact to keep it here");
  }
  float(event) {
    if (this.reactions.has(event.id)) return;
    this.reactions.add(event.id);
    if (this.reactions.size > 256)
      this.reactions.delete(this.reactions.values().next().value);
    if (event.holdUpId !== this.renderedId) return;
    const layer = $("find-floats");
    if (layer.children.length >= 6) layer.firstElementChild.remove();
    const float = make(
      "span",
      event.emoji + " " + event.by.name,
      "floating-reaction",
    );
    float.style.setProperty("--drift", Math.random() * 60 - 30 + "px");
    layer.append(float);
    setTimeout(() => float.remove(), 1800);
  }
}
