import { $, make } from "./rooms.js";
import { navigationId } from "./realtime.js";

export class MessageHistory {
  constructor() {
    this.entries = new Map();
    this.hasEarlier = false;
    this.loaded = false;
    this.draft = "";
    this.edit = 0;
    this.stale = true;
    this.top = null;
  }
  ordered() {
    return [...this.entries.values()].sort(
      (left, right) => left.sequence - right.sequence,
    );
  }
  add(entry) {
    if (this.entries.has(entry.id)) return false;
    this.entries.set(entry.id, entry);
    return true;
  }
  page(page, earlier) {
    const overlap =
      this.loaded &&
      page.entries.some(
        (entry) =>
          this.entries.has(entry.id) &&
          entry.sequence <= (this.resumeThrough ?? Infinity),
      );
    if (!earlier && !overlap && page.entries.length) {
      const oldest = page.entries[0].sequence;
      for (const [id, entry] of this.entries)
        if (entry.sequence < oldest) this.entries.delete(id);
    }
    if (
      earlier ||
      !overlap ||
      this.ordered()[0]?.sequence >= page.entries[0]?.sequence
    )
      this.hasEarlier = page.hasEarlier;
    for (const entry of page.entries) this.add(entry);
    this.loaded = true;
    if (!earlier) this.resumeThrough = undefined;
  }
}

const timestamp = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});
const fromBottom = (node) =>
  node.scrollHeight - node.clientHeight - node.scrollTop;
const validDraft = (text) => text.length > 0 && text.length <= 400;

export class DiscussionUI {
  constructor({ command, onFindsVisible, isOpen }) {
    Object.assign(this, { command, onFindsVisible, isOpen });
    this.scroller = $("discussion-scroll");
    this.input = $("discussion-input");
    this.list = $("discussion-entries");
    this.tabs = [$("finds-tab"), $("chat-tab")];
    this.cards = new Map();
    this.reset();
    for (const [index, tab] of this.tabs.entries()) {
      tab.onclick = () => this.show(index === 0 ? "finds" : "chat");
      tab.onkeydown = (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const next =
          event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
        this.tabs[next].click();
        this.tabs[next].focus({ preventScroll: true });
      };
    }
    $("discussion-back").onclick = () =>
      this.show("finds", null, this.threadButton);
    $("discussion-earlier").onclick = () => this.load(this.active, true);
    $("discussion-retry").onclick = () => this.load(this.active);
    $("discussion-new").onclick = () => {
      this.jump();
      this.scroller.focus({ preventScroll: true });
    };
    this.scroller.onscroll = () => {
      if (!this.active || !this.isOpen() || !this.scroller.clientHeight) return;
      this.active.top = this.scroller.scrollTop;
      if (fromBottom(this.scroller) <= 16) {
        this.active.newMessages = false;
        $("discussion-new").hidden = true;
      }
    };
    this.input.oninput = () => {
      this.active.draft = this.input.value;
      this.active.edit++;
      this.updateControls();
    };
    $("discussion-form").onsubmit = (event) => {
      event.preventDefault();
      this.submit(this.active);
    };
  }
  reset() {
    this.collapseQuick();
    this.feeds = new Map();
    this.summaries = new Map();
    this.cards.clear();
    this.findsAnchor = null;
    this.show("finds");
  }
  feed(findId) {
    if (!this.feeds.has(findId)) {
      const state = new MessageHistory();
      state.findId = findId;
      this.feeds.set(findId, state);
    }
    return this.feeds.get(findId);
  }
  setConnected(online) {
    if (this.online && !online)
      for (const state of this.feeds.values()) {
        state.stale = true;
        state.loading = null;
        state.resumeThrough ??= state.ordered().at(-1)?.sequence ?? 0;
      }
    this.online = online;
    this.updateControls();
    this.paintQuick(this.quick?.card);
    for (const id of this.cards.keys()) this.paintRating(id);
  }
  resync() {
    const session = this.feeds;
    this.command("discussion_summary", {})
      .then(({ summaries }) => {
        if (session === this.feeds)
          for (const summary of summaries) this.mergeSummary(summary);
      })
      .catch(() => {});
    const chat = this.feed(null);
    this.load(chat);
    if (this.active && this.active !== chat) this.load(this.active);
  }
  show(view, find = null, focus = null) {
    this.collapseQuick();
    const oldView = this.view;
    const findsList = $("finds-list");
    if (oldView === "finds" && view !== "finds")
      this.findsAnchor = this.anchor(findsList, findsList);
    this.remember();
    this.view = view;
    this.active = view === "finds" ? null : this.feed(find?.id ?? null);
    const chat = view === "chat";
    const thread = view === "thread";
    for (const [index, tab] of this.tabs.entries()) {
      const selected = index === Number(chat);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    $("finds-view").hidden = chat;
    $("finds-content").hidden = view !== "finds";
    $("finds-thread").hidden = !thread;
    $("chat-view").hidden = !chat;
    $("discussion-view").hidden = !this.active;
    if (this.active) {
      (chat ? $("chat-view") : $("finds-thread")).append($("discussion-view"));
      $("discussion-heading").hidden = !thread;
      $("discussion-product").textContent = find?.name ?? "";
      $("discussion-variant").textContent = find?.variant ?? "";
      $("discussion-label").textContent = thread
        ? "Comment on this find"
        : "Message the room";
      this.scroller.setAttribute(
        "aria-label",
        thread ? "Find comments" : "Room chat messages",
      );
      this.input.value = this.active.draft;
      this.reveal();
      if (thread) $("discussion-back").focus({ preventScroll: true });
      if (this.active.stale) this.load(this.active);
    } else {
      if (oldView !== "finds") this.restoreAnchor(findsList, this.findsAnchor);
      this.onFindsVisible();
      focus?.focus({ preventScroll: true });
    }
  }
  anchor(scroll, list) {
    const top = scroll.getBoundingClientRect().top;
    const node = [...list.children].find(
      (node) => node.getBoundingClientRect().bottom > top + 1,
    );
    return {
      node,
      offset: node?.getBoundingClientRect().top - top,
      top: scroll.scrollTop,
    };
  }
  remember() {
    if (!this.active || !this.isOpen() || !this.scroller.clientHeight) return;
    this.active.top = this.scroller.scrollTop;
    this.active.follow = fromBottom(this.scroller) <= 16;
  }
  reveal() {
    if (this.active) this.render({ bottom: this.active.follow });
  }
  restoreAnchor(scroll, anchor) {
    if (!anchor) return;
    if (anchor.node?.isConnected)
      scroll.scrollTop +=
        anchor.node.getBoundingClientRect().top -
        scroll.getBoundingClientRect().top -
        anchor.offset;
    else scroll.scrollTop = anchor.top;
  }
  jump() {
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.active.top = this.scroller.scrollTop;
    this.active.newMessages = false;
    $("discussion-new").hidden = true;
  }
  render({ anchor, bottom = false } = {}) {
    const state = this.active;
    if (!state) return;
    const entries = state.ordered();
    const old = new Map(
      [...this.list.children].map((node) => [node.dataset.message, node]),
    );
    let next = this.list.firstElementChild;
    for (const entry of entries) {
      let node = old.get(entry.id);
      if (node) old.delete(entry.id);
      else {
        node = make("li", undefined, "discussion-entry");
        node.dataset.message = entry.id;
        const header = make("div", undefined, "discussion-meta");
        const time = make("time", timestamp.format(entry.createdAt));
        time.dateTime = new Date(entry.createdAt).toISOString();
        header.append(make("strong", entry.author), time);
        node.append(header, make("p", entry.text));
      }
      if (node !== next) this.list.insertBefore(node, next);
      next = node.nextElementSibling;
    }
    for (const node of old.values()) node.remove();
    this.updateControls();
    if (!this.isOpen() || !this.scroller.clientHeight) return;
    if (anchor) this.restoreAnchor(this.scroller, anchor);
    else if (bottom || state.top === null) this.jump();
    else this.scroller.scrollTop = state.top;
  }
  updateControls() {
    const state = this.active;
    if (!state) return;
    const empty = $("discussion-empty");
    empty.hidden = state.entries.size > 0;
    empty.textContent =
      state.loading && !state.loaded
        ? "Loading messages…"
        : !state.loaded && !this.online
          ? "Reconnect to load messages."
          : state.loadError && !state.loaded
            ? "Couldn’t load messages."
            : state.findId
              ? "No comments yet. What do you think?"
              : "Start the conversation.";
    $("discussion-retry").hidden =
      !state.loadError || !state.stale || !this.online;
    $("discussion-earlier").hidden = !state.hasEarlier;
    $("discussion-earlier").disabled = !this.online || Boolean(state.loading);
    $("discussion-earlier").textContent = state.loading?.earlier
      ? "Loading earlier messages…"
      : "Load earlier messages";
    $("discussion-new").hidden = !state.newMessages;
    const send = $("discussion-send");
    send.disabled =
      !this.online || !validDraft(state.draft.trim()) || Boolean(state.pending);
    send.textContent = state.pending
      ? state.findId
        ? "Posting…"
        : "Sending…"
      : state.findId
        ? "Post comment"
        : "Send";
    $("discussion-status").textContent =
      state.error || state.loadError || (!this.online ? "Reconnecting…" : "");
  }
  async load(state, earlier = false) {
    if (
      !this.online ||
      !state ||
      state.loading ||
      (earlier && !state.hasEarlier)
    )
      return;
    const request = { earlier };
    state.loading = request;
    state.loadError = "";
    if (this.active === state) this.updateControls();
    try {
      const before = earlier ? state.ordered()[0]?.sequence : undefined;
      const { page } = await this.command("discussion_history", {
        findId: state.findId,
        before,
      });
      if (state.loading !== request) return;
      const current = this.active === state;
      const anchor =
        current &&
        this.scroller.clientHeight &&
        (earlier || fromBottom(this.scroller) > 16)
          ? this.anchor(this.scroller, this.list)
          : null;
      const last = state.ordered().at(-1)?.sequence ?? 0;
      state.page(page, earlier);
      if (!earlier) state.stale = false;
      if (
        anchor &&
        !earlier &&
        page.entries.some((entry) => entry.sequence > last)
      )
        state.newMessages = true;
      if (current)
        this.render({
          anchor,
          bottom: !earlier && !anchor && Boolean(this.scroller.clientHeight),
        });
    } catch (error) {
      if (state.loading === request) state.loadError = error.message;
    } finally {
      if (state.loading === request) state.loading = null;
      if (this.active === state) this.updateControls();
    }
  }
  message({ entry, summary }) {
    if (summary) this.mergeSummary(summary);
    if (!entry) return;
    const state = this.feeds.get(entry.findId);
    if (
      !state ||
      (!state.loaded && !state.loading && !state.pending) ||
      !state.add(entry)
    )
      return;
    if (
      this.active !== state ||
      !this.isOpen() ||
      !this.scroller.clientHeight
    ) {
      if (state.follow === false) state.newMessages = true;
      return;
    }
    const bottom = fromBottom(this.scroller) <= 16;
    if (!bottom) state.newMessages = true;
    this.render({
      bottom,
      anchor: bottom ? null : this.anchor(this.scroller, this.list),
    });
  }
  async submit(state, quick = null) {
    const text = state?.draft.trim();
    if (!this.online || !state || !validDraft(text) || state.pending) return;
    const edit = state.edit;
    const id = state.retry?.text === text ? state.retry.id : navigationId();
    state.pending = true;
    state.error = "";
    this.paintComposer(state);
    try {
      const ack = await this.command(
        state.findId ? "comment_post" : "chat_post",
        { findId: state.findId, text },
        id,
      );
      if (this.feeds.get(state.findId) !== state) return;
      this.message(ack);
      state.retry = null;
      if (state.edit === edit) {
        state.draft = "";
        this.syncDraft(state);
        if (quick && this.quick === quick)
          this.collapseQuick(quick.card.form.contains(document.activeElement));
      }
      if (quick) quick.card.announcement.textContent = "Comment posted.";
    } catch (error) {
      state.error = error.message;
      state.retry = error.code === "COMMAND_TIMEOUT" ? { text, id } : null;
    } finally {
      state.pending = false;
      if (this.feeds.get(state.findId) === state) this.paintComposer(state);
    }
  }
  syncDraft(state) {
    if (this.active === state) this.input.value = state.draft;
    const card = this.cards.get(state.findId);
    if (card) card.input.value = state.draft;
  }
  paintComposer(state) {
    if (this.active === state) this.updateControls();
    this.paintQuick(this.cards.get(state.findId));
  }
  paintQuick(card) {
    if (!card) return;
    const state = this.feeds.get(card.id);
    card.post.disabled =
      !this.online ||
      !validDraft(state?.draft.trim() ?? "") ||
      Boolean(state?.pending);
    card.post.textContent = state?.pending ? "Posting…" : "Post";
    card.quickStatus.textContent =
      state?.error || (!this.online ? "Reconnect to post a comment." : "");
  }
  collapseQuick(restore = false) {
    const card = this.quick?.card;
    if (!card) return;
    this.quick = null;
    card.form.hidden = true;
    card.trigger.setAttribute("aria-expanded", "false");
    if (restore) card.trigger.focus({ preventScroll: true });
  }
  toggleQuick(card) {
    if (this.quick?.card === card) {
      this.collapseQuick(true);
      return;
    }
    this.collapseQuick();
    this.quick = { card };
    const state = this.feed(card.id);
    card.input.value = state.draft;
    card.announcement.textContent = "";
    card.form.hidden = false;
    card.trigger.setAttribute("aria-expanded", "true");
    this.paintQuick(card);
    card.input.focus({ preventScroll: true });
    const list = $("finds-list");
    const bounds = list.getBoundingClientRect();
    const form = card.form.getBoundingClientRect();
    if (form.height > bounds.height || form.top < bounds.top)
      list.scrollTop += form.top - bounds.top;
    else if (form.bottom > bounds.bottom)
      list.scrollTop += form.bottom - bounds.bottom;
  }
  mergeSummary(summary) {
    const previous = this.summaries.get(summary.findId);
    if (previous?.version > summary.version) return;
    this.summaries.set(summary.findId, { ...previous, ...summary });
    this.paintRating(summary.findId);
  }
  controls(find, node) {
    const wrap = make("div", undefined, "find-discussion");
    const actions = make("div", undefined, "find-comment-actions");
    const exact = find.name + ", " + find.variant;
    const trigger = make("button", "+ Comment", "quiet find-comments");
    trigger.type = "button";
    trigger.setAttribute("aria-label", "Comment on " + exact);
    trigger.setAttribute("aria-expanded", "false");
    const comments = make("button", "", "quiet find-comments");
    comments.type = "button";
    comments.onclick = () => {
      this.threadButton = comments;
      this.show("thread", find);
    };
    actions.append(trigger, comments);
    const form = make("form", undefined, "quick-comment");
    form.id = "quick-comment-" + find.id;
    form.hidden = true;
    trigger.setAttribute("aria-controls", form.id);
    const labelInput = make("label", "Comment on this find");
    const input = make("textarea");
    input.id = form.id + "-input";
    input.rows = 2;
    input.maxLength = 400;
    input.placeholder = "What do you think?";
    labelInput.htmlFor = input.id;
    const quickStatus = make("p", "", "fine quick-comment-status");
    quickStatus.setAttribute("role", "status");
    const tools = make("div", undefined, "quick-comment-tools");
    const cancel = make("button", "Cancel", "quiet");
    cancel.type = "button";
    const post = make("button", "Post");
    post.type = "submit";
    tools.append(cancel, post);
    form.append(labelInput, input, quickStatus, tools);
    const announcement = make("span", "", "sr-only");
    announcement.setAttribute("role", "status");
    const card = {
      id: find.id,
      exact,
      trigger,
      form,
      input,
      post,
      quickStatus,
      announcement,
      comments,
    };
    trigger.onclick = () => this.toggleQuick(card);
    cancel.onclick = () => this.collapseQuick(true);
    form.onkeydown = (event) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      this.collapseQuick(true);
    };
    input.oninput = () => {
      const state = this.feed(find.id);
      state.draft = input.value;
      state.edit++;
      this.paintComposer(state);
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      if (this.quick?.card === card)
        this.submit(this.feed(find.id), this.quick);
    };
    const rating = make("div", undefined, "find-rating");
    rating.setAttribute("role", "group");
    rating.setAttribute("aria-label", "Your rating");
    const label = make("span", "Your rating", "fine");
    label.setAttribute("aria-hidden", "true");
    rating.append(label);
    const options = make("div", undefined, "rating-options");
    const buttons = Array.from({ length: 5 }, (_, index) => {
      const score = index + 1;
      const button = make("button", String(score));
      button.type = "button";
      button.setAttribute("aria-label", `Rate ${score} out of 5`);
      button.onclick = () => this.rate(find.id, score);
      options.append(button);
      return button;
    });
    const aggregate = make("p", "", "fine rating-aggregate");
    const status = make("p", "", "fine rating-error");
    status.setAttribute("role", "status");
    rating.append(options);
    wrap.append(actions, form, announcement, rating, aggregate, status);
    node.append(wrap);
    this.cards.set(
      find.id,
      Object.assign(card, { buttons, aggregate, status }),
    );
    this.paintRating(find.id);
  }
  async rate(id, score) {
    const card = this.cards.get(id);
    if (
      !this.online ||
      !card ||
      card.pending ||
      this.summaries.get(id)?.yourRating === score
    )
      return;
    card.pending = true;
    card.error = "";
    this.paintRating(id);
    try {
      const ack = await this.command("rate_find", { findId: id, score });
      if (this.cards.get(id) === card) this.message(ack);
    } catch (error) {
      card.error = error.message;
    } finally {
      card.pending = false;
      this.paintRating(id);
    }
  }
  paintRating(id) {
    const card = this.cards.get(id);
    if (!card) return;
    const {
      commentCount = 0,
      ratingCount = 0,
      average,
      yourRating,
    } = this.summaries.get(id) || {};
    card.comments.textContent = `See all comments (${commentCount})`;
    card.comments.setAttribute(
      "aria-label",
      `See all comments (${commentCount}) on ${card.exact}`,
    );
    card.aggregate.textContent = ratingCount
      ? `${average.toFixed(1)} / 5 · ${ratingCount} ${ratingCount === 1 ? "rating" : "ratings"}`
      : "No ratings yet";
    card.status.textContent = card.pending
      ? "Saving rating…"
      : card.error || "";
    card.status.hidden = !card.status.textContent;
    for (const [index, button] of card.buttons.entries()) {
      button.setAttribute("aria-pressed", String(yourRating === index + 1));
      button.setAttribute(
        "aria-disabled",
        String(!this.online || Boolean(card.pending)),
      );
    }
  }
}
