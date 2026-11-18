import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AmbientArt } from "./ambient-art.jsx";
import { Face } from "./ui.jsx";

const avatars = ["sage", "clay", "butter", "lilac", "sky", "rose"];

export function Header({ room }) {
  return (
    <header className="react-header">
      <a className="wordmark" aria-label="CoShop home" href="/">
        CoShop<span aria-hidden="true">↗</span>
      </a>
      {!room && (
        <nav aria-label="Main">
          <a href="/#how-it-works">How it works</a>
        </nav>
      )}
    </header>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <a className="wordmark" href="/">
        CoShop<span aria-hidden="true">↗</span>
      </a>
      <a href="/#how-it-works">How it works</a>
    </footer>
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
          <h1>CoShop</h1>
          <p>Find it. Share it. Shop together.</p>
          <div className="landing-actions">
            <button className="primary" onClick={() => start()}>
              Start a shopping room
            </button>
          </div>
        </div>
        <AmbientArt />
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
  const nameInput = useRef(null);
  const [nameError, setNameError] = useState(false);
  useLayoutEffect(() => heading.current?.focus({ preventScroll: true }), []);
  return (
    <main id="entry" className="react-entry">
      <section className="entry-card">
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
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            const name = String(fields.get("name") || "").trim();
            if (!name) {
              setNameError(true);
              nameInput.current.focus();
              return;
            }
            setNameError(false);
            enter({
              name,
              avatar: fields.get("avatar"),
              roomName: fields.get("roomName") || "",
              catalogMode: fields.get("catalogMode") || "sample",
            });
          }}
        >
          {!state.joining && (
            <label>
              Room Name (Optional)
              <input
                id="room-name"
                name="roomName"
                maxLength={60}
                placeholder="Whatever we find today"
              />
            </label>
          )}
          <label>
            Name (required)
            <input
              ref={nameInput}
              id="display-name"
              aria-invalid={nameError || undefined}
              aria-describedby={nameError ? "name-error" : undefined}
              onChange={(event) => {
                if (event.target.value.trim()) setNameError(false);
              }}
              name="name"
              maxLength={32}
              placeholder="Your name"
              required
            />
          </label>
          {nameError && (
            <p id="name-error" role="alert" className="form-error">
              Enter your name.
            </p>
          )}
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
            <legend>Avatar</legend>
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
