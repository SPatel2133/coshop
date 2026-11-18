import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Face } from "./ui.jsx";

const avatars = ["sage", "clay", "butter", "lilac", "sky", "rose"];

export function Header({ room }) {
  return (
    <header className="react-header">
      <a className="wordmark" aria-label="CoShop home" href="/">
        coshop<span aria-hidden="true">↗</span>
      </a>
      {!room && (
        <nav aria-label="Main">
          <a href="/#how-it-works">How it works</a>
        </nav>
      )}
      {room && <span>{room.name}</span>}
    </header>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <a className="wordmark" href="/">
        coshop<span aria-hidden="true">↗</span>
      </a>
      <a href="/#how-it-works">How it works</a>
    </footer>
  );
}

function AsciiArtwork() {
  const artwork = Array.from({ length: 40 }, (_, y) =>
    Array.from({ length: 80 }, (_, x) => {
      const dx = (x - 40) / 31;
      const dy = (y - 20) / 18;
      const radius = Math.hypot(dx, dy);
      const wave = Math.sin(dx * 5 + 0.8) * Math.cos(dy * 6 - 0.4);
      return radius < 1.1
        ? " .:+*#"[Math.min(5, Math.floor(Math.abs(wave) * (1.1 - radius) * 7))]
        : " ";
    }).join(""),
  ).join("\n");
  return (
    <div className="landing-art" aria-hidden="true">
      <pre>{artwork}</pre>
    </div>
  );
}

export function Landing({ start }) {
  const guide = useRef(null);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (!window.IntersectionObserver) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setRevealed(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(guide.current);
    return () => observer.disconnect();
  }, []);
  return (
    <main id="landing" className="site-landing">
      <section className="react-landing">
        <div className="landing-intro">
          <p className="eyebrow">A shared shopping room</p>
          <h1>
            Good finds.
            <br />
            Better together.
          </h1>
          <p>
            Browse at your own pace, send friends the exact things you like, and
            decide what goes in one shared bag.
          </p>
          <div className="landing-actions">
            <button className="primary" onClick={() => start()}>
              Start a shopping room <span aria-hidden="true">↗</span>
            </button>
          </div>
          <p className="fine">Invite up to nine friends. No accounts needed.</p>
        </div>
        <AsciiArtwork />
      </section>
      <section
        ref={guide}
        id="how-it-works"
        className={revealed ? "home-guide is-revealed" : "home-guide"}
        aria-labelledby="guide-title"
      >
        <h2 id="guide-title">How it works</h2>
        <ol>
          <li>
            <h3>Open a room</h3>
            <p>Choose a catalog and send the invite to your friends.</p>
          </li>
          <li>
            <h3>Browse on your own</h3>
            <p>
              Share the exact variant you like while everyone keeps their place.
            </p>
          </li>
          <li>
            <h3>Decide together</h3>
            <p>Talk through your finds and add your picks to the shared bag.</p>
          </li>
        </ol>
      </section>
    </main>
  );
}
export function Entry({ state, enter }) {
  const heading = useRef(null);
  useLayoutEffect(() => heading.current?.focus({ preventScroll: true }), []);
  return (
    <main id="entry" className="react-entry">
      <section className="entry-card">
        <p className="eyebrow">A seat for you</p>
        <h1 ref={heading} tabIndex={-1}>
          {state.joining ? "Join your people." : "Make yourself at home."}
        </h1>
        <p>
          {state.joining
            ? state.roomName || "Choose a name to take your seat."
            : "Choose a catalog and invite your friends."}
        </p>
        <form
          id="identity-form"
          onSubmit={(event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            enter({
              name: fields.get("name"),
              avatar: fields.get("avatar"),
              roomName: fields.get("roomName") || "",
              catalogMode: fields.get("catalogMode") || "sample",
            });
          }}
        >
          {!state.joining && (
            <label>
              Name your room <span className="fine">optional</span>
              <input
                id="room-name"
                name="roomName"
                maxLength={60}
                placeholder="Whatever we find today"
              />
            </label>
          )}
          <label>
            What should we call you?
            <input
              id="display-name"
              name="name"
              maxLength={32}
              placeholder="Your name"
              required
            />
          </label>
          {!state.joining && (
            <label>
              Catalog
              <select
                name="catalogMode"
                defaultValue="sample"
                aria-describedby="catalog-help"
              >
                <option value="sample">Sample catalog</option>
                <option value="shopify">Live Shopify catalog</option>
              </select>
              <span id="catalog-help" className="fine">
                Sample rooms use demo products. Live rooms require a configured
                Shopify store.
              </span>
            </label>
          )}
          <fieldset className="react-avatars">
            <legend>Pick a little you</legend>
            {avatars.map((avatar) => (
              <label key={avatar}>
                <input
                  type="radio"
                  name="avatar"
                  value={avatar}
                  defaultChecked={avatar === "sage"}
                  aria-label={avatar + " avatar"}
                />
                <Face avatar={avatar} />
              </label>
            ))}
          </fieldset>
          {state.entryError && (
            <p role="alert" className="form-error">
              {state.entryError}
            </p>
          )}
          <button className="primary" disabled={state.submitting}>
            {state.submitting
              ? "Connecting…"
              : state.joining
                ? "Join your people ↗"
                : "Make room ↗"}
          </button>
        </form>
        <a className="text-link" href="/">
          Back to CoShop
        </a>
        <p className="fine">
          Your identity stays on this browser. Reconnecting friends keep their
          seats for 10 minutes. Rooms expire after 24 hours without activity.
        </p>
      </section>
    </main>
  );
}

export function Status({ title, details, retry }) {
  const heading = useRef(null);
  useLayoutEffect(
    () => heading.current?.focus({ preventScroll: true }),
    [title],
  );
  return (
    <main id="status-page" className="react-entry">
      <section className="entry-card">
        <p className="eyebrow">Shopping room</p>
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        <p role="status">{details}</p>
        {retry && (
          <button className="primary" onClick={retry}>
            Try again
          </button>
        )}
        <a className="text-link" href="/">
          Back to CoShop
        </a>
      </section>
    </main>
  );
}
