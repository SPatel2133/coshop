import React, { useRef, useState } from "react";
import { DialogClose, exact, Face, focus, Modal, money, Photo } from "./ui.jsx";
import { resolveLocation } from "../client/presence.js";

export function Invite({ room, invite, finish }) {
  const input = useRef(null);
  const [feedback, setFeedback] = useState("");
  const url = new URL("/", location.origin);
  url.searchParams.set("room", invite);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url.href);
      setFeedback("Copied. Drop it in your call chat.");
    } catch {
      focus(input.current);
      input.current?.select();
      setFeedback("Copy the selected invite link.");
    }
  }
  return (
    <Modal id="invite-dialog" label="invite-title" active close={finish}>
      {(dismiss) => (
        <>
          <DialogClose onClick={() => dismiss()} label="Close invitation" />
          <p className="eyebrow">Save them a seat</p>
          <h2 id="invite-title">Invite your people</h2>
          <p>
            Send this link in your call chat. Up to {room.capacity} people,
            including you.
          </p>
          <label htmlFor="invite-url">Invitation link</label>
          <input
            id="invite-url"
            ref={input}
            readOnly
            value={url.href}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button type="button" className="primary" onClick={copy}>
            Copy invite link
          </button>
          <p role="status" className="fine">
            {feedback}
          </p>
          <details>
            <summary>Testing on one browser?</summary>
            <p>
              These links open separate demo identities. Refreshing keeps each
              identity.
            </p>
            {[1, 2].map((n) => {
              const target = new URL(url);
              target.searchParams.set("guest", String(n));
              return (
                <a
                  className="text-link"
                  key={n}
                  href={target.href}
                  target="_blank"
                  rel="noopener"
                >
                  Open demo shopper {n} ↗
                </a>
              );
            })}
          </details>
        </>
      )}
    </Modal>
  );
}

export function Peek({ overlay, state, finish, navigate }) {
  const find =
    overlay.find &&
    state.cards.find(
      (find) =>
        find.id === overlay.find.id &&
        find.variantId === overlay.find.variantId,
    );
  const person =
    overlay.person &&
    state.room.participants.find(({ id }) => id === overlay.person);
  const place = resolveLocation(
    find
      ? {
          kind: "product",
          productId: find.productId,
          variantId: find.variantId,
        }
      : person?.view,
    state.products,
  );
  const sender = overlay.find ? find?.sharedBy : person;
  const missing = overlay.find
    ? !find || place.missing
    : !person || place.missing;
  const canNavigate =
    !missing && (overlay.find || (state.online && person.connected));
  const label = overlay.find
    ? find
      ? "Shared find: " + exact(find)
      : "Find unavailable"
    : "Peek at " + (person?.name || "a shopper");
  return (
    <Modal
      id="peek-dialog"
      label="peek-heading"
      active
      close={(action) =>
        finish(action === "navigate" ? () => navigate(place) : null)
      }
    >
      {(dismiss) => (
        <>
          <DialogClose onClick={() => dismiss()} label="Close peek" />
          <h2 id="peek-heading" className="sr-only">
            {label}
          </h2>
          {sender && (
            <div className="peek-person">
              <Face avatar={sender.avatar} />
              <p className="eyebrow">
                {overlay.find
                  ? "Shared by " + sender.name
                  : sender.name + (sender.away ? " · away" : "")}
              </p>
            </div>
          )}
          {missing ? (
            <>
              <h3>
                {overlay.find
                  ? "This find is no longer available"
                  : "This view is no longer available"}
              </h3>
              <p className="fine">Close this peek to keep browsing.</p>
            </>
          ) : (
            <>
              {place.product ? (
                <div className="peek-card">
                  <Photo
                    src={place.variant.image || place.product.image}
                    alt={place.product.name}
                    className="peek-photo"
                  />
                  <h3>{place.product.name}</h3>
                  <p className="peek-variant">{place.variant.title}</p>
                  <strong>{money(place.variant)}</strong>
                  {!place.variant.available && (
                    <p className="fine">
                      This variant is unavailable to add to the bag.
                    </p>
                  )}
                </div>
              ) : (
                <h3>{place.title}</h3>
              )}
              {overlay.find ? (
                <p className="fine">Your place in the store is saved.</p>
              ) : (
                (!state.online || !person.connected) && (
                  <p className="fine">
                    Last seen here. Reconnect to follow this view.
                  </p>
                )
              )}
            </>
          )}
          <button
            className="primary full"
            aria-disabled={!canNavigate}
            onClick={() => {
              if (canNavigate) dismiss("navigate", true);
            }}
          >
            {overlay.find ? "View product ↗" : "Join this view ↗"}
          </button>
        </>
      )}
    </Modal>
  );
}
