import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DialogClose, exact, focus, money } from "./ui.jsx";
import { validDraft } from "./discussion-model.js";

const time = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});
const empty = {};

function Composer({ id, online, store, quick, finish, cancel }) {
  const state = store.discussion.feed(id);
  const input = useRef(null);
  useLayoutEffect(() => {
    if (quick) {
      focus(input.current);
      input.current.scrollIntoView({ block: "nearest" });
    }
  }, [quick]);
  return (
    <form
      className={quick ? "quick-comment" : id ? "react-composer" : "react-composer room-composer"}
      onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        if (await store.discussion.submit(id))
          finish?.(form.contains(document.activeElement));
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && quick && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <label>
        <span className={id ? undefined : "sr-only"}>
          {id ? "Comment on this find" : "Message the room"}
        </span>
        <textarea
          ref={input}
          value={state.draft}
          maxLength={400}
          rows={id ? 2 : 1}
          onChange={(event) => store.discussion.edit(id, event.target.value)}
        />
      </label>
      <p className="fine composer-status" role="status">
        {state.error || (!online ? "Reconnect to send." : "")}
      </p>
      <div className="quick-comment-tools">
        {quick && (
          <button type="button" className="quiet" onClick={cancel}>
            Cancel
          </button>
        )}
        <button
          type="submit"
          className="primary"
          disabled={!online || !validDraft(state.draft) || state.pending}
        >
          {state.pending ? "Sending…" : id ? "Post comment" : "Send"}
        </button>
      </div>
    </form>
  );
}

function Thread({ id, online, store, find, back, active, memory }) {
  const model = store.discussion.feed(id);
  const scroller = useRef(null);
  const entries = model.ordered();
  const position = memory.get(id) || {
    follow: true,
    top: 0,
    last: 0,
    unread: false,
  };
  const [unread, setUnread] = useState(position.unread);
  useLayoutEffect(() => {
    if (!active) return;
    const node = scroller.current;
    const newEntry = entries.at(-1)?.sequence || 0;
    const anchor =
      position.anchor &&
      [...node.children].find(
        (child) => child.dataset.message === position.anchor,
      );
    if (position.follow) node.scrollTop = node.scrollHeight;
    else if (anchor)
      node.scrollTop +=
        anchor.getBoundingClientRect().top -
        node.getBoundingClientRect().top -
        position.offset;
    else node.scrollTop = position.top;
    const hasNew =
      !position.follow &&
      Boolean((position.last && newEntry > position.last) || position.unread);
    memory.set(id, { ...position, last: newEntry, unread: hasNew });
    setUnread(hasNew);
  }, [active, model.entries.size, entries[0]?.id, entries.at(-1)?.id]);
  function remember() {
    const node = scroller.current;
    const top = node.getBoundingClientRect().top;
    const first = [...node.children].find(
      (child) => child.getBoundingClientRect().bottom > top + 1,
    );
    const follow = node.scrollHeight - node.clientHeight - node.scrollTop <= 16;
    memory.set(id, {
      ...memory.get(id),
      unread: !follow && unread,
      follow,
      top: node.scrollTop,
      anchor: first?.dataset.message,
      offset: first?.getBoundingClientRect().top - top,
    });
    if (follow) setUnread(false);
  }
  return (
    <div className="react-thread">
      {find && (
        <div>
          <button
            className="quiet"
            type="button"
            data-thread-back
            onClick={back}
          >
            ← Our finds
          </button>
          <h3>{find.name}</h3>
          <p className="fine">{find.variant}</p>
        </div>
      )}
      {model.hasEarlier && (
        <button
          className="quiet"
          type="button"
          disabled={!online || Boolean(model.loading)}
          onClick={() => store.discussion.load(id, true)}
        >
          {model.loading?.earlier
            ? "Loading earlier messages…"
            : "Load earlier messages"}
        </button>
      )}
      {model.loadError && (
        <p role="status">
          {model.loadError}{" "}
          <button
            className="quiet"
            disabled={!online}
            onClick={() => store.discussion.load(id)}
          >
            Retry
          </button>
        </p>
      )}
      <ul
        className="react-messages"
        ref={scroller}
        tabIndex={0}
        aria-label={id ? "Find comments" : "Room chat messages"}
        onScroll={remember}
      >
        {!entries.length && (
          <li className="fine">
            {model.loading
              ? "Loading messages…"
              : !online
                ? "Reconnect to load messages."
                : id
                  ? "No comments yet."
                  : "Say hi or ask what everyone’s looking for."}
          </li>
        )}
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="discussion-entry"
            data-message={entry.id}
          >
            <div className="discussion-meta">
              <strong>{entry.author}</strong>
              <time dateTime={new Date(entry.createdAt).toISOString()}>
                {time.format(entry.createdAt)}
              </time>
            </div>
            <p>{entry.text}</p>
          </li>
        ))}
      </ul>
      {unread && (
        <button
          className="quiet"
          onClick={() => {
            scroller.current.scrollTop = scroller.current.scrollHeight;
            focus(scroller.current);
          }}
        >
          New messages ↓
        </button>
      )}
      <Composer id={id} online={online} store={store} />
    </div>
  );
}

function FindCard({
  find,
  state,
  store,
  preview,
  navigate,
  social,
  setSocial,
  quickToken,
}) {
  const summary = store.discussion.summary(find.id) || empty;
  const rating = store.discussion.rating(find.id);
  const quickOpen = social.quick?.id === find.id;
  const comment = useRef(null);
  function endQuick(restore = true) {
    quickToken.current = null;
    setSocial((current) => ({ ...current, quick: null }));
    if (restore) focus(comment.current);
  }
  async function react(emoji) {
    if (!state.online) return;
    try {
      await store.command("react", { holdUpId: find.id, emoji });
    } catch (error) {
      store.toast(error.message);
    }
  }
  return (
    <article
      className="react-find"
      data-find={find.id}
      data-find-variant={find.variantId}
    >
      <div className="react-find-head">
        {find.image && <img src={find.image} alt="" loading="lazy" />}
        <div>
          <h3>{find.name}</h3>
          <p>
            {find.variant} · {money(find, "code")}
          </p>
          <p className="fine">Shared by {find.sharedBy.name}</p>
        </div>
      </div>
      {find.available === false && (
        <p className="fine">Unavailable when shared</p>
      )}
      {state.repeated?.id === find.id && (
        <p className="fine">{state.repeated.name} shared this again</p>
      )}
      <div className="react-find-actions">
        <div
          className="find-reactions"
          role="group"
          aria-label={"React to " + exact(find)}
        >
          {[
            ["❤️", "Love"],
            ["👎", "No"],
            ["🤔", "Hmm"],
          ].map(([emoji, name]) => (
            <button
              key={emoji}
              type="button"
              aria-disabled={!state.online}
              aria-label={name + " reaction"}
              onClick={() => react(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
        <button
          className="secondary"
          data-peek={find.id}
          aria-label={"View find: " + exact(find)}
          onClick={(event) => preview(find, event.currentTarget)}
        >
          View find
        </button>
        <button className="quiet" onClick={() => navigate(find)}>
          View product
        </button>
      </div>
      <div className="find-floats" aria-live="polite">
        {state.reactions
          .filter((event) => event.variantId === find.variantId)
          .map((event) => (
            <span key={event.id} className="floating-reaction">
              {event.emoji} {event.by.name}
            </span>
          ))}
      </div>
      <div className="find-comment-actions">
        <button
          ref={comment}
          className="quiet"
          aria-expanded={quickOpen}
          aria-label={"Comment on " + exact(find)}
          onClick={() => {
            if (quickOpen) return endQuick();
            const current = { id: find.id };
            quickToken.current = current;
            setSocial((previous) => ({ ...previous, quick: current }));
          }}
        >
          + Comment
        </button>
        <button
          className="quiet"
          data-comments={find.id}
          onClick={() => {
            quickToken.current = null;
            setSocial({ screen: "thread", find: find.id, quick: null });
          }}
        >
          See all comments ({summary.commentCount || 0})
        </button>
      </div>
      {quickOpen && (
        <Composer
          id={find.id}
          online={state.online}
          store={store}
          quick
          cancel={endQuick}
          finish={(restore) => {
            if (quickToken.current === social.quick) endQuick(restore);
          }}
        />
      )}
      <div className="find-rating" role="group" aria-label="Your rating">
        <span className="fine">Your rating</span>
        <div className="rating-options">
          {[1, 2, 3, 4, 5].map((score) => (
            <button
              key={score}
              type="button"
              aria-pressed={summary.yourRating === score}
              aria-label={"Rate " + score + " out of 5"}
              aria-disabled={!state.online || Boolean(rating?.pending)}
              onClick={() => store.discussion.rate(find.id, score)}
            >
              {score}
            </button>
          ))}
        </div>
      </div>
      <p className="fine">
        {summary.ratingCount
          ? summary.average.toFixed(1) +
            " / 5 · " +
            summary.ratingCount +
            (summary.ratingCount === 1 ? " rating" : " ratings")
          : "No ratings yet"}
      </p>
      <p role="status" className="fine">
        {rating?.pending ? "Saving rating…" : rating?.error}
      </p>
    </article>
  );
}

export function Activity({
  state,
  store,
  social,
  setSocial,
  close,
  preview,
  navigate,
  active,
  anchors,
  quickToken,
  invite,
}) {
  const section = useRef(null);
  const solo = state.room.participants.length === 1;
  const list = useRef(null);
  const chat = social.screen === "chat";
  const find =
    social.screen === "thread"
      ? state.cards.find(({ id }) => id === social.find)
      : null;
  const showFinds = !chat && !find;
  useEffect(() => {
    store.discussion.activate(active ? (chat ? null : find?.id) : undefined);
  }, [active, chat, find?.id, store]);
  useLayoutEffect(() => {
    if (!active || !showFinds || !list.current) return;
    list.current.scrollTop = anchors.finds;
  }, [active, showFinds]);
  useLayoutEffect(() => {
    if (active && find)
      focus(section.current.querySelector("[data-thread-back]"));
  }, [active, find?.id]);
  useEffect(() => {
    if (!active || !showFinds || !list.current) return;
    const container = list.current;
    let disposed = false;
    const cards = [...container.children].filter((child) => child.dataset.find);
    const observer = new IntersectionObserver(
      (entries) => {
        if (disposed || document.hidden) return;
        const bounds = container.getBoundingClientRect();
        const visibleHeight = Math.max(
          0,
          Math.min(innerHeight, bounds.bottom) - Math.max(0, bounds.top),
        );
        if (!visibleHeight) return;
        for (const entry of entries)
          if (
            entry.intersectionRatio >= 0.5 ||
            (entry.isIntersecting &&
              entry.intersectionRect.height >= visibleHeight - 2)
          )
            store.markSeen(entry.target.dataset.findVariant);
      },
      { threshold: [0, 0.25, 0.5] },
    );
    const observe = () => {
      observer.disconnect();
      if (!document.hidden) cards.forEach((card) => observer.observe(card));
    };
    observe();
    document.addEventListener("visibilitychange", observe);
    return () => {
      disposed = true;
      observer.disconnect();
      document.removeEventListener("visibilitychange", observe);
    };
  }, [active, showFinds, state.cards, store]);

  function tab(next) {
    quickToken.current = null;
    setSocial({ screen: next, find: null, quick: null });
  }
  return (
    <section
      ref={section}
      id="finds-panel"
      className="react-activity"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.nativeEvent.isComposing &&
          !event.defaultPrevented
        ) {
          event.preventDefault();
          close();
        }
      }}
    >
      <header>
        <h2 id="finds-heading">Around the room</h2>
        <p className="fine">
          {state.room.participants.length} / {state.room.capacity} seats ·{" "}
          {state.online ? "Connected" : "Reconnecting…"}
        </p>
        <DialogClose onClick={close} label="Close room panel">
          Close
        </DialogClose>
      </header>
      <div className="activity-people">
        {state.room.participants.map((person) => {
          const product = state.products.find(
            (item) => item.id === person.view?.productId,
          );
          return (
            <p key={person.id}>
              <strong>{person.name}</strong> ·{" "}
              {!person.connected
                ? "Reconnecting"
                : person.away
                  ? "Away"
                  : product?.name || person.view?.category || "Browsing"}
            </p>
          );
        })}
        {solo && (
          <div className="activity-solo">
            <p>
              You’re the first one here. Invite a friend to browse together.
            </p>
            <button
              className="primary"
              onClick={(event) => invite(event.currentTarget)}
            >
              Invite a friend
            </button>
          </div>
        )}
      </div>
      <div role="tablist" aria-label="Room activity" className="react-tabs">
        {[
          ["finds", "Our finds"],
          ["chat", "Chat"],
        ].map(([id, label], index) => {
          const selected = chat === Boolean(index);
          return (
            <button
              key={id}
              id={id + "-tab"}
              type="button"
              role="tab"
              aria-controls={id + "-view"}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => tab(id)}
              onKeyDown={(event) => {
                if (
                  !["Home", "End", "ArrowLeft", "ArrowRight"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? "finds"
                    : event.key === "End"
                      ? "chat"
                      : index
                        ? "finds"
                        : "chat";
                tab(next);
                focus(section.current.querySelector("#" + next + "-tab"));
              }}
            >
              {label}
              {!index && (
                <span className="tab-count"> {state.cards.length}</span>
              )}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id="finds-view"
        aria-labelledby="finds-tab"
        className="react-panel-body"
        hidden={chat}
      >
        {showFinds ? (
          <>
            <div
              className="react-find-list"
              id="finds-list"
              ref={list}
              onScroll={(event) => {
                anchors.finds = event.currentTarget.scrollTop;
              }}
            >
              {!state.cards.length && (
                <p className="react-empty">
                  No shared finds yet. Share one from a product page.
                </p>
              )}
              {state.cards.map((card) => (
                <FindCard
                  key={card.id}
                  find={card}
                  {...{
                    state,
                    store,
                    preview,
                    navigate,
                    social,
                    setSocial,
                    quickToken,
                  }}
                />
              ))}
            </div>
          </>
        ) : (
          find && (
            <Thread
              key={find.id}
              id={find.id}
              {...{ find, store, active }}
              online={state.online}
              memory={anchors.threads}
              back={() => {
                tab("finds");
                requestAnimationFrame(() =>
                  focus(
                    [
                      ...section.current.querySelectorAll("[data-comments]"),
                    ].find((node) => node.dataset.comments === find.id) ||
                      section.current.querySelector("#finds-tab"),
                  ),
                );
              }}
            />
          )
        )}
      </div>
      <div
        role="tabpanel"
        id="chat-view"
        aria-labelledby="chat-tab"
        className="react-panel-body"
        hidden={!chat}
      >
        {chat && (
          <Thread
            id={null}
            store={store}
            online={state.online}
            active={active}
            memory={anchors.threads}
          />
        )}
      </div>
    </section>
  );
}
