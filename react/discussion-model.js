import { MessageHistory } from "../client/discussion.js";
import { navigationId } from "../client/realtime.js";

export const validDraft = (text) =>
  text.trim().length > 0 && text.trim().length <= 400;

export function createDiscussion(command, notify) {
  let feeds = new Map();
  let summaries = new Map();
  let ratings = new Map();
  let online = false;
  let active;
  function feed(findId) {
    if (!feeds.has(findId)) {
      const model = new MessageHistory();
      model.findId = findId;
      feeds.set(findId, model);
    }
    return feeds.get(findId);
  }

  function mergeSummary(summary) {
    const previous = summaries.get(summary.findId);
    if (previous?.version > summary.version) return;
    summaries.set(summary.findId, { ...previous, ...summary });
  }

  function message({ entry, summary }) {
    if (summary) mergeSummary(summary);
    const state = feeds.get(entry?.findId);
    if (entry && state && (state.loaded || state.loading || state.pending))
      state.add(entry);
    notify();
  }

  async function load(findId, earlier = false) {
    if (!online) return;
    const state = feed(findId);
    if (state.loading || (earlier && !state.hasEarlier)) return;
    const request = { earlier };
    state.loading = request;
    state.loadError = "";
    notify();
    try {
      const before = earlier ? state.ordered()[0]?.sequence : undefined;
      const { page } = await command("discussion_history", { findId, before });
      if (state.loading !== request || feeds.get(findId) !== state) return;
      state.page(page, earlier);
      if (!earlier) state.stale = false;
    } catch (error) {
      if (state.loading === request) state.loadError = error.message;
    } finally {
      if (state.loading === request) state.loading = null;
      if (feeds.get(findId) === state) notify();
    }
  }

  async function submit(findId) {
    const state = feed(findId);
    if (!online || !validDraft(state.draft) || state.pending) return false;
    const text = state.draft.trim();
    const edit = state.edit;
    const id = state.retry?.text === text ? state.retry.id : navigationId();
    state.pending = true;
    state.error = "";
    notify();
    try {
      const ack = await command(
        findId ? "comment_post" : "chat_post",
        { findId, text },
        id,
      );
      if (feeds.get(findId) !== state) return false;
      message(ack);
      state.retry = null;
      if (state.edit !== edit) return false;
      state.draft = "";
      return true;
    } catch (error) {
      state.error = error.message;
      state.retry = error.code === "COMMAND_TIMEOUT" ? { text, id } : null;
      return false;
    } finally {
      state.pending = false;
      if (feeds.get(findId) === state) notify();
    }
  }

  async function rate(findId, score) {
    if (
      !online ||
      ratings.get(findId)?.pending ||
      summaries.get(findId)?.yourRating === score
    )
      return;
    const scope = ratings;
    const rating = { pending: true, error: "" };
    ratings.set(findId, rating);
    notify();
    try {
      const ack = await command("rate_find", { findId, score });
      if (scope === ratings) message(ack);
    } catch (error) {
      rating.error = error.message;
    } finally {
      rating.pending = false;
      if (scope === ratings) notify();
    }
  }

  return {
    feed,
    load,
    submit,
    rate,
    message,
    summary: (id) => summaries.get(id),
    rating: (id) => ratings.get(id),
    edit(id, value) {
      const state = feed(id);
      state.draft = value;
      state.edit++;
      notify();
    },
    activate(id) {
      active = id;
      if (id !== undefined && feed(id).stale) load(id);
    },
    setConnected(value) {
      if (online && !value)
        for (const state of feeds.values()) {
          state.stale = true;
          state.loading = null;
          state.resumeThrough ??= state.ordered().at(-1)?.sequence ?? 0;
        }
      online = value;
      notify();
    },
    resync() {
      const scope = feeds;
      command("discussion_summary", {})
        .then(({ summaries: current }) => {
          if (scope !== feeds) return;
          current.forEach(mergeSummary);
          notify();
        })
        .catch(() => {});
      load(null);
      if (active != null) load(active);
    },
    reset() {
      active = undefined;
      feeds = new Map();
      summaries = new Map();
      ratings = new Map();
    },
  };
}
