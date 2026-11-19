import React, {
  StrictMode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { createRoomStore } from "./room-store.js";
import { Entry, Footer, Header, Landing, Status } from "./entry.jsx";
import { Collection, People, Product, QuickAdd } from "./shopping.jsx";
import { Activity } from "./activity.jsx";
import { Invite, Peek } from "./overlays.jsx";
import { Bag, Haul, HaulBanner } from "./bag.jsx";
import {
  countItems,
  focus,
  Modal,
  useMedia,
  visible,
  wideQuery,
} from "./ui.jsx";
import "./base.css";
import "./theme.css";

function Room({ state, store }) {
  const wide = useMedia(wideQuery);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(state.view.category || "All");
  const [overlay, setOverlay] = useState(null);
  const [panel, setPanel] = useState(false);
  const [social, setSocial] = useState({
    screen: "finds",
    find: null,
    quick: null,
  });
  const [notice, setNotice] = useState(null);
  const panelOrigin = useRef(null);
  const quickToken = useRef(null);
  const anchors = useRef({ finds: 0, threads: new Map() });
  const roomHeading = useRef(null);
  const activityButton = useRef(null);
  const bagButton = useRef(null);
  const trigger = useRef(null);
  const collectionReturn = useRef(null);
  const positionIntent = useRef(null);
  const detailTop = useRef(null);
  const desktopPanel = wide && panel;
  const activityOpen = panel && (wide || !overlay || overlay.kind === "invite");
  const product =
    state.view.kind === "product"
      ? state.products.find((product) => product.id === state.view.productId)
      : null;
  const variant = product?.variants.find(
    (variant) => variant.id === state.view.variantId,
  );
  const showingProduct = Boolean(product && variant);
  const count = state.bag.confirmed?.totalQuantity || 0;

  useEffect(() => {
    if (state.incoming && !panel) setNotice(state.incoming);
  }, [state.incoming]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  useLayoutEffect(() => focus(roomHeading.current), []);
  function openPanel(origin) {
    panelOrigin.current = origin;
    setNotice(null);
    setPanel(true);
  }
  function restore(node, fallback) {
    requestAnimationFrame(() =>
      focus(
        visible(node)
          ? node
          : typeof fallback === "function"
            ? fallback()
            : fallback,
      ),
    );
  }

  function open(kind, from, data) {
    trigger.current = from;
    setOverlay({ kind, ...data });
  }

  const quickAdd = useCallback((product, opener) => {
    trigger.current = opener;
    setOverlay({ kind: "quick-add", product });
  }, []);

  function finish(action) {
    const origin = trigger.current;
    setOverlay(null);
    if (typeof action === "function") {
      setPanel(wide && panel);
      action();
    } else if (action === "haul") {
      trigger.current = bagButton.current;
      setOverlay({ kind: "haul" });
    } else if (overlay?.fromPanel) {
      if (!state.cards.some((find) => find.id === overlay.find.id)) {
        setPanel(false);
        restore(activityButton.current);
        return;
      }
      restore(
        origin,
        () =>
          [...document.querySelectorAll("[data-peek]")].find(
            (node) => node.dataset.peek === overlay.find.id,
          ) || activityButton.current,
      );
    } else {
      restore(
        origin,
        overlay?.kind === "bag" ? bagButton.current : activityButton.current,
      );
    }
  }

  useLayoutEffect(() => {
    store.bag.isOpen = overlay?.kind === "bag";
    return () => {
      store.bag.isOpen = false;
    };
  }, [overlay?.kind, store]);

  const chooseCategory = useCallback(
    (label) => {
      setCategory(label);
      store.setView({ kind: "category", category: label });
    },
    [store],
  );

  const openProduct = useCallback(
    (item, variantId) => {
      const selected = variantId
        ? item.variants.find((variant) => variant.id === variantId)
        : item.variants[0];
      if (!selected)
        return store.toast("That variant is no longer in this collection.");
      if (store.getSnapshot().view.kind === "category")
        collectionReturn.current = { top: scrollY, id: item.id };
      positionIntent.current = "product";
      store.setView({
        kind: "product",
        productId: item.id,
        variantId: selected.id,
      });
    },
    [store],
  );

  useLayoutEffect(() => {
    const intent = positionIntent.current;
    if (!intent) return;
    positionIntent.current = null;
    if (intent === "product") {
      const heading = document.querySelector("#product-heading");
      focus(heading);
      alignDetail();
    } else {
      const back = collectionReturn.current;
      const card = [...document.querySelectorAll("[data-product]")].find(
        (node) => node.dataset.product === back?.id,
      );
      focus(card || document.querySelector("#collection-heading"));
      if (back) scrollTo(0, back.top);
      collectionReturn.current = null;
    }
  }, [state.view]);

  function alignDetail() {
    const section = document.querySelector("#product-dialog");
    const presence = document.querySelector(".react-presence");
    if (!section || !presence) return;
    const top = section.getBoundingClientRect().top + scrollY;
    scrollTo(0, Math.max(0, top - presence.offsetHeight - 12));
    detailTop.current = scrollY;
  }

  useLayoutEffect(() => {
    if (!showingProduct) {
      detailTop.current = null;
      return;
    }
    const presence = document.querySelector(".react-presence");
    const section = document.querySelector("#product-dialog");
    const correct = () => {
      // Re-align only while the shopper is still at the aligned position, never over their own scroll.
      if (detailTop.current == null || Math.abs(scrollY - detailTop.current) > 1)
        return;
      const bar = presence.getBoundingClientRect();
      if (section.getBoundingClientRect().top < bar.bottom + 4) alignDetail();
    };
    const resize = new ResizeObserver(correct);
    resize.observe(presence);
    resize.observe(section);
    window.addEventListener("resize", correct);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", correct);
    };
  }, [showingProduct]);

  function navigate(place) {
    if (place.product) openProduct(place.product, place.variant.id);
    else if (place.category) {
      positionIntent.current = "collection";
      chooseCategory(place.category);
    }
  }

  function navigateFind(find) {
    const item = state.products.find((item) => item.id === find.productId);
    if (!item)
      return store.toast("That product is no longer in the collection.");
    if (!wide) setPanel(false);
    openProduct(item, find.variantId);
  }

  function closePanel() {
    setPanel(false);
    quickToken.current = null;
    setSocial((current) => ({ ...current, quick: null }));
    restore(panelOrigin.current, activityButton.current);
    panelOrigin.current = null;
  }

  function preview(find, node) {
    open("peek", node, { find, fromPanel: true });
  }

  return (
    <main id="room" className="react-room">
      <div className="react-room-head">
        <h1 ref={roomHeading} tabIndex={-1}>
          {state.room.name}
        </h1>
        <div className="react-room-tools">
          <span
            className={"react-connection" + (state.online ? "" : " is-offline")}
          >
            <span role="status">
              {state.online ? "Connected" : "Reconnecting…"}
            </span>
            {!state.online && (
              <button className="quiet" onClick={store.retry}>
                Retry
              </button>
            )}
          </span>

          <div className="activity-launcher">
            <button
              ref={activityButton}
              id="open-finds"
              className="secondary activity-launch"
              aria-expanded={panel}
              aria-haspopup="dialog"
              aria-controls="finds-drawer"
              aria-label={
                "Around the room" +
                (state.unseen ? ", " + state.unseen + " unseen" : "")
              }
              onClick={() => {
                if (panel) return closePanel();
                openPanel(activityButton.current);
              }}
            >
              Around the room{" "}
              {state.unseen > 0 && (
                <span key={state.unseen} className="react-count unseen-pulse">
                  {state.unseen}
                </span>
              )}
            </button>
            <div className="find-live-notice" role="status" aria-atomic="true">
              {notice && !panel && <span>{notice.sender} shared a find.</span>}
            </div>
          </div>
          <button
            className="secondary"
            onClick={(event) => open("invite", event.currentTarget)}
          >
            Invite
          </button>
        </div>
      </div>

      <People
        room={state.room}
        me={state.me}
        online={state.online}
        products={state.products}
        peek={(person, node) => open("peek", node, { person })}
      >
        <div className="react-share-slot">
          <button
            ref={bagButton}
            id="open-bag"
            className="react-bag-button"
            aria-haspopup="dialog"
            aria-expanded={overlay?.kind === "bag"}
            aria-label={"Shared bag, " + countItems(count)}
            onClick={(event) => open("bag", event.currentTarget)}
          >
            Shared bag{" "}
            <span
              key={state.bag.cue?.id || "bag"}
              className={
                "react-count" + (state.bag.cue ? " confirmed-cue" : "")
              }
            >
              {count}
            </span>
          </button>
          <button
            type="button"
            className="secondary finds-shortcut"
            aria-haspopup="dialog"
            aria-controls="finds-drawer"
            aria-expanded={panel}
            aria-label={
              "Our finds" +
              (state.unseen ? ", " + state.unseen + " unseen" : "")
            }
            onClick={(event) =>
              panel ? closePanel() : openPanel(event.currentTarget)
            }
          >
            Our finds
            {state.unseen > 0 && (
              <span key={state.unseen} className="react-count unseen-pulse">
                {state.unseen}
              </span>
            )}
          </button>
          {state.bag.checkout && (
            <p
              className="react-checkout-note fine"
              role="status"
              title={state.bag.checkout.name + " is checking out on Shopify."}
            >
              Shopify checkout in progress
            </p>
          )}
          {state.room.recap && (
            <HaulBanner
              recap={state.room.recap}
              open={(node) => open("haul", node)}
            />
          )}

        </div>
      </People>
      <div
        className={
          "react-shopping-layout" + (desktopPanel ? " with-activity" : "")
        }
      >
        <div>
          <Collection
            products={state.products}
            storefront={state.storefront}
            hidden={showingProduct}
            quickAdd={quickAdd}
            {...{ category, query, setQuery, chooseCategory, openProduct }}
          />
          {showingProduct && (
            <Product
              {...{ state, store, product, variant }}
              peek={(person, node) => open("peek", node, { person })}
              select={(variantId) =>
                store.setView({
                  kind: "product",
                  productId: product.id,
                  variantId,
                })
              }
              back={() => {
                positionIntent.current = "collection";
                chooseCategory(category);
              }}
            />
          )}
        </div>
        <Modal
          id="finds-drawer"
          label="finds-heading"
          side="right"
          className={wide ? "react-activity-dock" : ""}
          active={activityOpen}
          modal={!wide}
          close={closePanel}
        >
          {(dismiss) => (
            <Activity
              {...{ state, store, social, setSocial, preview, quickToken }}
              active={panel && !overlay}
              invite={(node) => open("invite", node)}
              anchors={anchors.current}
              close={() => dismiss()}
              navigate={navigateFind}
            />
          )}
        </Modal>
      </div>
      {overlay?.kind === "quick-add" && (
        <QuickAdd product={overlay.product} state={state} store={store} close={finish} />
      )}
      {overlay?.kind === "invite" && (
        <Invite room={state.room} invite={state.invite} finish={finish} />
      )}
      {overlay?.kind === "peek" && (
        <Peek {...{ state, overlay, finish, navigate }} />
      )}
      {overlay?.kind === "bag" && (
        <Bag state={state} store={store} finish={finish} />
      )}
      {overlay?.kind === "haul" && state.room.recap && (
        <Haul recap={state.room.recap} finish={finish} />
      )}
    </main>
  );
}

const store = createRoomStore();

function App() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(store.start, []);
  return (
    <>
      <Header room={state.screen === "room" ? state.room : undefined} />
      {state.screen === "landing" && <Landing start={store.showEntry} />}
      {state.screen === "entry" && <Entry state={state} enter={store.enter} />}
      {state.screen === "status" && <Status {...state} />}
      {state.screen === "room" && (
        <Room
          state={state}
          store={store}
          key={state.room.id + ":" + state.me}
        />
      )}
      <Footer />
      <div className="react-toast" role="status" hidden={!state.toast}>
        {state.toast}
      </div>
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
