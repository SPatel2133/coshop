import React, { memo, useMemo, useRef, useState } from "react";
import { Face, Photo, money } from "./ui.jsx";
import { resolveLocation } from "../client/presence.js";

export const Collection = memo(function Collection({
  products,
  storefront,
  category,
  query,
  setQuery,
  chooseCategory,
  openProduct,
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
          <p className="eyebrow">
            {storefront?.name || "The sample collection"}
          </p>
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
          <button
            key={product.id}
            className="react-product"
            data-product={product.id}
            type="button"
            aria-label={"View " + product.name}
            onClick={() => openProduct(product)}
          >
            <Photo src={product.image} lazy />
            <div className="react-card-copy">
              <span className="eyebrow">{product.category}</span>
              <h3>{product.name}</h3>
              <span>
                {product.variants[0]
                  ? money(product.variants[0])
                  : "Price unavailable"}
              </span>
            </div>
          </button>
        ))}
      </div>
      <p className="fine catalog-note">
        {storefront?.mode === "shopify"
          ? "Prices and availability come from Shopify and are checked again before checkout."
          : "Sample products and reference prices. Share to save in Our finds, or add to make a shared pick."}
      </p>
    </section>
  );
});

export function Product({
  state,
  store,
  product,
  variant,
  back,
  select,
  peek,
}) {
  const bag = state.bag;
  const person = state.room.participants.find(
    (person) => person.id === state.me,
  );
  const nearby = state.room.participants.filter(
    (person) =>
      person.id !== state.me &&
      person.connected &&
      person.view?.productId === product.id,
  );
  const line = bag.confirmed?.items.find(
    (item) => item.variantId === variant.id,
  );
  const addLabel = !variant.available
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
  const shared = state.shareResult?.variantId === variant.id;
  return (
    <section
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
        <Photo
          className="product-media detail-media"
          src={variant.image || product.image}
          alt={product.name}
        />
        <div className="product-copy">
          <p className="eyebrow">
            {state.storefront?.name || "Sample collection"}
          </p>
          <h2 id="product-heading" tabIndex={-1}>
            {product.name}
          </h2>
          <p className="detail-price">{money(variant)}</p>
          <p>{product.description}</p>
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
          <p className="fine">
            {!variant.available
              ? "This variant is unavailable."
              : state.room.catalogMode === "shopify"
                ? "Available on Shopify"
                : "Sample product · preview only"}
          </p>
          <div className="react-product-actions">
            <button
              className="primary"
              aria-disabled={addLabel !== "Add to bag"}
              onClick={() => {
                if (person && addLabel === "Add to bag")
                  store.bag.change("add", {
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
              }}
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
                ? "Shared " +
                  product.name +
                  " · " +
                  variant.title +
                  " in Our finds."
                : state.shareWait
                  ? "Ready to share again in " + state.shareWait + "s."
                  : "Sharing saves a find without adding it to the bag."}
          </p>
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
