import { ProductGallery } from "./product-gallery.jsx";
import React, { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DialogClose, Face, Modal, Photo, money } from "./ui.jsx";
import { resolveLocation } from "../client/presence.js";

export const Collection = memo(function Collection({
  products,
  storefront,
  category,
  query,
  setQuery,
  chooseCategory,
  openProduct,
  quickAdd,
  hidden,
}) {
  const search = useRef(null);
  const categories = useMemo(
    () => ["All", ...new Set(products.map((product) => product.category))],
    [products],
  );
  const filtered = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return products.filter((product) => {
      if (category !== "All" && product.category !== category) return false;
      const words = [
        product.name,
        product.description,
        product.category,
        ...product.variants.map((variant) => variant.title),
      ]
        .join(" ")
        .toLocaleLowerCase();
      return terms.every((term) => words.includes(term));
    });
  }, [products, category, query]);
  function reset() {
    setQuery("");
    search.current.focus();
  }
  return (
    <section id="collection-page" className="react-collection" hidden={hidden}>
      <div className="catalog-heading">
        <div>
          <h2 id="collection-heading" tabIndex={-1}>
            Browse the collection
          </h2>
        </div>
        <p className="fine">
          {storefront?.mode === "shopify"
            ? "Shopify · " + storefront.country
            : "Sample · no checkout"}
        </p>
      </div>
      <div className="collection-tools">
        <nav aria-label="Product categories" className="category-filters">
          {categories.map((label) => (
            <button
              key={label}
              className="category-chip"
              type="button"
              aria-pressed={category === label}
              onClick={() => chooseCategory(label)}
            >
              {label === "All" ? "Everything" : label}
            </button>
          ))}
        </nav>
        <div role="search" aria-label="Catalog" className="react-search">
          <label htmlFor="catalog-search" className="sr-only">
            Search the collection
          </label>
          <input
            ref={search}
            id="catalog-search"
            type="search"
            placeholder="Search the collection"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button className="quiet" onClick={reset}>
              Clear
            </button>
          )}
        </div>
      </div>
      <p className="react-result fine" role="status">
        {filtered.length} {filtered.length === 1 ? "product" : "products"}
      </p>
      {!filtered.length && (
        <div className="react-empty">
          <p>
            {products.length
              ? "No products match your search."
              : "This collection is empty."}
          </p>
          {products.length > 0 && (
            <button
              className="secondary"
              onClick={() => {
                chooseCategory("All");
                reset();
              }}
            >
              Reset filters
            </button>
          )}
        </div>
      )}
      <div id="products" className="react-grid">
        {filtered.map((product) => (
          <div className="product-tile" key={product.id}>
            <button
              className="react-product"
              data-product={product.id}
              type="button"
              aria-label={"View " + (product.name || "Untitled product")}
              onClick={() => openProduct(product)}
            >
              <Photo src={product.image} lazy />
              <div className="react-card-copy">
                <h3>{product.name || "Untitled product"}</h3>
                <span>
                  {product.variants[0]
                    ? money(product.variants[0])
                    : "Price unavailable"}
                </span>
              </div>
            </button>
            <button
              type="button"
              className="secondary tile-quick-add"
              aria-label={"Quick add " + (product.name || "Untitled product")}
              aria-haspopup="dialog"
              onClick={(event) => quickAdd(product, event.currentTarget)}
            >
              <span aria-hidden="true">+</span>
            </button>
          </div>
        ))}
      </div>
    </section>
  );
});

function bagAddLabel(state, variant) {
  const bag = state.bag;
  const line = bag.confirmed?.items.find(
    (item) => item.variantId === variant.id,
  );
  return !variant.available
    ? "Unavailable"
    : bag.pending.has(variant.id)
      ? "Saving…"
      : bag.checkout || bag.checkoutPending
        ? "Bag locked"
        : !state.online
          ? "Reconnect to add"
          : line?.quantity >= 99
            ? "Bag limit reached"
            : "Add to bag";
}

function addVariant(state, store, product, variant) {
  const person = state.room.participants.find(({ id }) => id === state.me);
  if (!person || bagAddLabel(state, variant) !== "Add to bag") return;
  return store.bag.change("add", {
    productId: product.id,
    variantId: variant.id,
    quantity: 0,
    name: product.name,
    image: variant.image || product.image,
    variant: variant.title,
    cents: variant.cents,
    currency: variant.currency,
    available: variant.available,
    pickedBy: person,
  });
}

export function QuickAdd({ product, state, store, close, openFinds }) {
  const [variantId, setVariantId] = useState(product.variants[0]?.id);
  const [action, setAction] = useState(null);
  const variant = product.variants.find(({ id }) => id === variantId);
  const addLabel = variant ? bagAddLabel(state, variant) : "Unavailable";
  const shared = action === "share" && state.shareResult?.variantId === variantId;
  return (
    <Modal id="quick-add" label="quick-add-title" active close={close}>
      {(dismiss) => (
        <div className="quick-add-content">
          <h2 id="quick-add-title">{product.name || "Untitled product"}</h2>
          <DialogClose onClick={() => dismiss()} label="Close quick add">Close</DialogClose>
          {variant ? (
            <>
              <label>
                Choose a variant
                <select value={variantId} onChange={(event) => {
                  setVariantId(event.target.value);
                  setAction(null);
                }}>
                  {product.variants.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title} · {money(item, "code")}
                      {!item.available ? " · Unavailable" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <p className="fine">{variant.available ? "In stock" : "Unavailable"}</p>
              <div className="react-product-actions">
                <button type="button" className="primary"
                  disabled={addLabel !== "Add to bag"}
                  onClick={() => {
                    setAction("bag");
                    addVariant(state, store, product, variant);
                  }}>
                  {addLabel}
                </button>
                <button type="button" className="secondary"
                  disabled={!state.online || state.sharing || state.shareWait > 0}
                  onClick={() => {
                    setAction("share");
                    store.share(product, variant);
                  }}>
                  {state.sharing ? "Sharing…" : shared ? "Shared ✓" : "Share find"}
                </button>
              </div>
              <p className="fine" role="status">
                {action === "bag" ? state.bag.feedback :
                  shared ? "Shared to Our finds." :
                  !state.online ? "Reconnect to share or add to the bag." :
                  state.shareWait ? "Ready to share again in " + state.shareWait + "s." :
                  action === "share" ? state.toast : ""}
              </p>
              {shared && (
                <button type="button" className="quiet" onClick={() => dismiss(openFinds)}>
                  Open Our finds
                </button>
              )}
            </>
          ) : <p>No variants available.</p>}
        </div>
      )}
    </Modal>
  );
}

// The sample catalog does not send option names or verified swatch values.
const sampleColorProducts = new Set([
  "bag", "audio", "camera", "cap", "sunglasses", "speaker", "earbuds",
  "lamp", "plant", "sofa", "pillow", "mug",
]);

export function Product({
  state,
  store,
  product,
  variant,
  back,
  select,
  peek,
  openFinds,
}) {
  const section = useRef(null);
  useLayoutEffect(() => {
    const page = section.current;
    const media = page.querySelector(".detail-media");
    const measure = () => {
      const singlePhoto = !page.querySelector(".thumbnail-rail");
      const inset = singlePhoto
        ? media.getBoundingClientRect().left - page.getBoundingClientRect().left
        : 0;
      page.style.setProperty("--back-media-inset", Math.max(0, inset) + "px");
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    observer.observe(media);
    return () => observer.disconnect();
  }, [product.id, variant.id]);

  const nearby = state.room.participants.filter(
    (person) =>
      person.id !== state.me &&
      person.connected &&
      person.view?.productId === product.id,
  );
  const addLabel = bagAddLabel(state, variant);
  const shared = state.shareResult?.variantId === variant.id;
  return (
    <section
      ref={section}
      id="product-dialog"
      className="react-product-page"
      aria-label="Product"
    >
      <button className="quiet" onClick={back}>
        ← Back to the collection
      </button>
      {nearby.length > 0 && (
        <div className="nearby-rack">
          <span>Also looking here</span>
          {nearby.map((person) => (
            <button
              key={person.id}
              type="button"
              className="nearby-person"
              aria-label={"Peek at " + person.name}
              onClick={(event) => peek(person.id, event.currentTarget)}
            >
              <Face avatar={person.avatar} />
            </button>
          ))}
        </div>
      )}
      <div id="product-detail" className="react-product-detail">
        <ProductGallery
          product={product}
          variant={variant}
          scope={state.room.id + ":" + state.me}
        />
        <div className="product-copy">
          <h2 id="product-heading" tabIndex={-1}>
            {product.name || "Untitled product"}
          </h2>
          <p className="detail-price">{money(variant)}</p>
          <p className="detail-description">{product.description}</p>
          <div className="detail-variants">
            {state.room.catalogMode === "sample" && sampleColorProducts.has(product.id) ? (
              <fieldset className="color-options">
                <legend>Color: {variant.title}</legend>
                <div className="color-option-list">
                  {product.variants.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="secondary"
                      aria-pressed={item.id === variant.id}
                      disabled={!item.available}
                      onClick={() => select(item.id)}
                    >
                      {item.title}{item.available ? "" : " · unavailable"}
                    </button>
                  ))}
                </div>
              </fieldset>
            ) : (
              <>
                <label htmlFor="product-variant">Choose a variant</label>
                <select
                  id="product-variant"
                  value={variant.id}
                  onChange={(event) => select(event.target.value)}
                >
                  {product.variants.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                      {item.available ? "" : " · unavailable"}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
          {!variant.available && <p className="fine">This variant is unavailable.</p>}
          <div className="react-product-actions">
            <button
              className="primary"
              aria-disabled={addLabel !== "Add to bag"}
              onClick={() => addVariant(state, store, product, variant)}
            >
              {addLabel}
            </button>
            <button
              className="secondary"
              aria-describedby="share-find-note"
              aria-disabled={
                !state.online || state.sharing || state.shareWait > 0
              }
              onClick={() => store.share(product, variant)}
            >
              {state.sharing
                ? "Sharing…"
                : shared && state.shareWait > 0
                  ? "Shared ✓"
                  : "Share find"}
            </button>
          </div>
          <p id="share-find-note" className="fine" role="status">
            {!state.online
              ? "Reconnect to share. You can keep browsing."
              : shared
                ? "Shared to Our finds."
                : state.shareWait
                  ? "Ready to share again in " + state.shareWait + "s."
                  : "Sharing sends this exact variant to Our finds. It doesn’t add it to the bag."}
          </p>
          {shared && state.online && (
            <button type="button" className="quiet" onClick={(event) => openFinds(event.currentTarget)}>
              Open Our finds
            </button>
          )}
          {state.room.catalogMode === "sample" && (
            <p className="fine">Sample catalog · checkout unavailable</p>
          )}
        </div>
      </div>
    </section>
  );
}

export function People({ room, me, online, products, peek, children }) {
  return (
    <section className="react-presence" aria-label="People in this room">
      <div className="company-heading">
        <span>
          {room.participants.length <= 1
            ? "You’re the first one here"
            : "Good company"}
        </span>
        <span>
          {room.participants.length} / {room.capacity} seats
        </span>
      </div>
      <ul id="members" className="seat-list">
        {room.participants.map((person) => {
          const place = resolveLocation(person.view, products);
          const status = !person.connected
            ? "Reconnecting"
            : !online
              ? "Last seen"
              : person.away
                ? "Away"
                : "";
          return (
            <li key={person.id} className="presence-seat">
              <button
                type="button"
                className="presence-person"
                aria-label={
                  "Peek at " +
                  person.name +
                  (status ? ", " + status.toLowerCase() : "") +
                  ": " +
                  place.title
                }
                onClick={(event) => peek(person.id, event.currentTarget)}
              >
                <Face avatar={person.avatar} />
                <span className="presence-copy">
                  <strong>
                    {person.name}
                    {person.id === me ? " (you)" : ""}
                  </strong>
                  <span className="presence-location">
                    {status && status + " · "}
                    {place.title}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {children}
    </section>
  );
}
