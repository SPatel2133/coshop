import React, { useId, useLayoutEffect, useRef } from "react";
import {
  countItems,
  DialogClose,
  exact,
  Face,
  focus,
  Modal,
  money,
} from "./ui.jsx";

export function Bag({ state, store, finish }) {
  const bag = state.bag;
  const {
    confirmed,
    items,
    pending,
    checkout,
    checkoutEnabled,
    checkoutPending,
    releasing,
    feedback,
    cue,
    changed,
  } = bag;
  const count = items.reduce((sum, item) => sum + item.quantity, 0);
  const blocked = !state.online || Boolean(checkout) || checkoutPending;
  const totals = new Map();
  for (const item of items)
    if (item.currency && item.cents != null)
      totals.set(
        item.currency,
        (totals.get(item.currency) || 0) + item.cents * item.quantity,
      );

  return (
    <Modal
      id="bag-drawer"
      label="bag-heading"
      side="right"
      active
      close={finish}
    >
      {(dismiss) => (
        <>
          <header className="react-drawer-head">
            <div>
              <p className="eyebrow">Picked together</p>
              <h2 id="bag-heading">Shared bag</h2>
              <p className="fine">{countItems(count)}</p>
            </div>
            <DialogClose onClick={() => dismiss()} label="Close shared bag" />
          </header>
          <p id="bag-status" role="status" className="fine">
            {!state.online
              ? "Reconnecting… Your bag is saved."
              : pending.size
                ? "Saving your bag…"
                : state.demoError ||
                  (checkout ? checkout.name + " is checking out…" : feedback)}
          </p>
          <ul id="bag-items" className="react-bag-items">
            {!items.length && (
              <li className="react-empty">
                The bag is empty. Add a variant from a product page.
              </li>
            )}
            {items.map((item) => (
              <BagLine
                key={item.variantId}
                item={item}
                me={state.me}
                blocked={blocked || pending.has(item.variantId)}
                store={store}
                cue={cue}
                changed={changed?.variantIds.has(item.variantId)}
              />
            ))}
          </ul>
          <footer className="react-bag-footer">
            <div>
              <span>Estimated subtotal</span>
              <strong>
                {[...totals]
                  .map(([currency, cents]) =>
                    money({ currency, cents }, "code"),
                  )
                  .join(" + ") || "—"}
              </strong>
            </div>
            {items.some((item) => !item.available) && (
              <p role="status">
                Unavailable items must be removed by their picker before
                checkout.
              </p>
            )}
            {state.room.catalogMode === "sample" ? (
              <>
                <p className="fine">
                  Sample collection · reference prices. Checkout isn’t available
                  in this demo.
                </p>
                <button
                  className="primary full"
                  disabled={
                    state.demoPending ||
                    !state.online ||
                    pending.size > 0 ||
                    !confirmed?.items.length ||
                    confirmed.unavailable
                  }
                  onClick={async () => {
                    if (await store.demo()) dismiss("haul", true);
                  }}
                >
                  {state.demoPending
                    ? "Creating the demo recap…"
                    : "Demo completion · simulated"}
                </button>
              </>
            ) : (
              <>
                <p className="fine">
                  {checkoutEnabled
                    ? "One shopper checks out for the group. Shopify shows shipping and taxes at checkout."
                    : "Shopify checkout is unavailable for this room’s store."}
                </p>
                {checkoutEnabled && (
                  <button
                    className="primary full"
                    disabled={
                      blocked ||
                      pending.size > 0 ||
                      !count ||
                      confirmed?.unavailable
                    }
                    onClick={() => store.bag.startCheckout()}
                  >
                    Continue to Shopify checkout ↗
                  </button>
                )}
                {checkout?.shopperId === state.me && (
                  <button
                    className="secondary full"
                    disabled={Boolean(releasing)}
                    onClick={() => store.bag.releaseCheckout()}
                  >
                    Release checkout lock
                  </button>
                )}
              </>
            )}
          </footer>
        </>
      )}
    </Modal>
  );
}

function BagLine({ item, me, blocked, store, cue, changed }) {
  const row = useRef(null);
  const noteId = useId();
  const original = item.pickedBy.id === me;
  const capped = item.quantity >= 99;
  const notes = [
    !original && "Only " + item.pickedBy.name + " can lower or remove this.",
    capped && "Limit 99 per item.",
  ].filter(Boolean);
  useLayoutEffect(() => {
    const element = row.current;
    return () => {
      if (element.contains(document.activeElement))
        focus(element.closest("dialog")?.querySelector("[data-dialog-close]"));
    };
  }, []);
  return (
    <li
      className={"react-bag-line" + (changed ? " line-changed" : "")}
      ref={row}
    >
      {item.image && <img src={item.image} alt="" loading="lazy" />}
      <div>
        <h3>{item.name}</h3>
        <p>
          {item.variant} · {money(item, "code")}
          {changed && <strong className="line-updated"> · Updated</strong>}
        </p>
        <p className="bag-picker">
          <Face avatar={item.pickedBy.avatar} />
          Picked by {item.pickedBy.name}
        </p>
        {!item.available && (
          <p className="fine">Unavailable in this collection</p>
        )}
      </div>
      <div className="bag-line-controls">
        {original && (
          <button
            className="quiet"
            aria-disabled={blocked || item.quantity <= 1}
            aria-label={"Decrease quantity of " + exact(item)}
            onClick={() => {
              if (!blocked) store.bag.change("decrease", item);
            }}
          >
            −
          </button>
        )}
        <span
          aria-label={"Quantity " + item.quantity}
          key={cue?.variantId === item.variantId ? cue.id : "quantity"}
          className={cue?.variantId === item.variantId ? "confirmed-cue" : ""}
        >
          {item.quantity}
        </span>
        <button
          className="quiet"
          aria-disabled={blocked || !item.available || capped}
          aria-label={"Increase quantity of " + exact(item)}
          aria-describedby={capped ? noteId : undefined}
          onClick={() => {
            if (!blocked) store.bag.change("add", item);
          }}
        >
          +
        </button>
        {original && (
          <button
            className="quiet"
            aria-disabled={blocked}
            aria-label={"Remove " + exact(item)}
            onClick={() => {
              if (!blocked) store.bag.change("remove", item);
            }}
          >
            Remove
          </button>
        )}
      </div>
      {notes.length > 0 && (
        <p id={noteId} className="fine bag-line-note">
          {notes.join(" ")}
        </p>
      )}
    </li>
  );
}

const total = (recap) =>
  recap.totals.map((item) => money(item, "code")).join(" + ");

export function HaulBanner({ recap, open }) {
  return (
    <section className="react-recap-shortcut" aria-label="Shopping recap">
      <button
        id="open-haul"
        aria-label="See the haul"
        className="quiet"
        title={
          recap.mode === "demo"
            ? "Simulated haul ready"
            : "Shopify payment verified"
        }
        onClick={(event) => open(event.currentTarget)}
      >
        Haul ↗
      </button>
    </section>
  );
}

export function Haul({ recap, finish }) {
  const demo = recap.mode === "demo";
  return (
    <Modal id="haul-dialog" label="haul-heading" active close={finish}>
      {(dismiss) => (
        <>
          <DialogClose onClick={() => dismiss()} label="Close the haul" />
          <p className="eyebrow">
            {demo ? "Sample room · simulation" : "Shopify payment verified"}
          </p>
          <h2 id="haul-heading">The haul.</h2>
          <p className="fine">
            {demo
              ? "This is a simulated recap. No order was placed and no payment was taken."
              : "Shopify confirmed this order was paid. The order total includes applicable taxes and shipping."}
          </p>
          <ul className="react-bag-items">
            {recap.items.map((item) => (
              <li className="haul-item" key={item.variantId}>
                <span className="haul-photo">
                  {item.image && <img src={item.image} alt="" />}
                </span>
                <div>
                  <h3>{item.name}</h3>
                  <p>{item.variant}</p>
                  {item.pickedBy && (
                    <p className="fine">Picked by {item.pickedBy.name}</p>
                  )}
                </div>
                <span
                  className="haul-quantity"
                  aria-label={countItems(item.quantity)}
                >
                  ×{item.quantity}
                </span>
              </li>
            ))}
          </ul>
          <div className="haul-summary">
            <span>{countItems(recap.totalQuantity)}</span>
            <strong>
              {demo ? "Estimated total " : "Paid total "}
              {total(recap)}
            </strong>
          </div>
          {recap.highlights.length > 0 && (
            <>
              <h3 className="haul-highlights-title">Most shared</h3>
              <ul className="haul-highlights">
                {recap.highlights.map((item) => (
                  <li key={item.variantId || exact(item)}>
                    <span>{exact(item)}</span>
                    <span className="fine">Shared {item.count}×</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
