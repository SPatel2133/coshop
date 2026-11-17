import {
  $,
  make,
  showScreen,
  showStatus,
  showEntry,
  renderRoom,
} from "./client/rooms.js";
import {
  loadSession,
  saveSession,
  clearSession,
  canSaveSession,
  guest,
} from "./client/session.js";
import { RoomConnection } from "./client/realtime.js";
import { catalog } from "./catalog.mjs";
import { Presence, resolveLocation } from "./client/presence.js";
import { FindsUI } from "./client/hold-ups.js";
let invite = new URLSearchParams(location.search).get("room"),
  connection,
  session,
  joining = Boolean(invite),
  toastTimer,
  roomState,
  selectedProduct = null,
  category = "All",
  localView = { kind: "category", category: "All" };
const presence = new Presence(catalog, (destination) => {
  if (destination.product)
    openProduct(destination.product, destination.variant.id);
  else showCollection(destination.category || "All");
});
const finds = new FindsUI({
  command: (type, payload) => connection.command(type, payload),
  view: (productId, variantId) => {
    const product = catalog.find((p) => p.id === productId);
    if (product) openProduct(product, variantId);
    else toast("That product is no longer in the collection.");
  },
  error: toast,
});
function receiveRoom(room) {
  roomState = room;
  renderRoom(room, session.me);
  presence.setRoom(room, session.me);
  finds.snapshot(room, session.me);
  $("first-friend").hidden =
    Boolean(selectedProduct) ||
    room.participants.filter((p) => p.connected).length > 1;
}
function publishView(view) {
  localView = view;
  connection?.setView(view);
}
async function request(path, { body, token, method } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method: method || (body !== undefined ? "POST" : "GET"),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12000),
      cache: "no-store",
    });
  } catch {
    throw Object.assign(
      new Error("Couldn’t connect. Check your connection and try again."),
      { code: "NETWORK" },
    );
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw Object.assign(
      new Error("The room service is temporarily unavailable. Please retry."),
      { code: "NETWORK" },
    );
  }
  if (!response.ok)
    throw Object.assign(new Error(result.message || "Please try again."), {
      code: result.code,
      retryAfter: result.retryAfter,
    });
  return result;
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
}
function onError(error) {
  if (
    [
      "INVALID_SESSION",
      "ROOM_FULL",
      "ROOM_EXPIRED",
      "INVALID_LINK",
      "RATE_LIMITED",
    ].includes(error.code)
  )
    finds.deactivate();
  if (error.code === "INVALID_SESSION") {
    connection?.stop();
    clearSession(invite);
    session = null;
    showStatus(error.code, error.message, () =>
      showEntry(true, "Choose a name to join as a new person."),
    );
  } else if (
    ["ROOM_FULL", "ROOM_EXPIRED", "INVALID_LINK"].includes(error.code)
  ) {
    connection?.stop();
    if (error.code === "ROOM_EXPIRED") clearSession(invite);
    showStatus(
      error.code,
      error.message,
      error.code === "ROOM_FULL" ? bootstrap : null,
    );
  } else if (error.code === "RATE_LIMITED") {
    connection?.stop();
    showStatus(
      error.code,
      error.message + " Retry in " + (error.retryAfter || 60) + " seconds.",
      bootstrap,
    );
  } else toast(error.message);
}
function connected(result) {
  session = { token: result.token || session.token, me: result.me };
  saveSession(invite, session);
  const previousView = result.room.participants.find(
    (p) => p.id === session.me,
  )?.view;
  const destination = resolveLocation(previousView, catalog);
  if (destination.product)
    openProduct(destination.product, destination.variant.id, false);
  else showCollection(destination.category || "All", false);
  receiveRoom(result.room);
  connection?.stop();
  connection = new RoomConnection({
    invite,
    token: session.token,
    interval: result.heartbeatInterval,
    onState: (result) => {
      session.me = result.me;
      receiveRoom(result.room);
    },
    onPresence: (message) => {
      if (!roomState || message.version < roomState.version) return;
      const index = roomState.participants.findIndex(
        (p) => p.id === message.participant.id,
      );
      if (index < 0) return; // Membership arrives as an authoritative full snapshot.
      roomState.participants[index] = message.participant;
      roomState.version = message.version;
      roomState.expiresAt = message.expiresAt;
      presence.setRoom(roomState, session.me);
    },
    onReady: () => connection.setView(localView),
    onShopping: (message) => finds.message(message),
    onStatus: (healthy) => {
      $("connection").textContent = healthy ? "Connected" : "Reconnecting…";
      $("connection").classList.toggle("disconnected", !healthy);
      $("reconnect-notice").hidden = healthy;
      presence.setConnected(healthy);
      finds.setConnected(healthy);
    },
    onError,
    checkSession: () =>
      request("/api/rooms/" + invite + "/session", {
        method: "POST",
        token: session.token,
        body: {},
      }),
  });
  connection.connect();
}
$("start-room").onclick = () => {
  joining = false;
  showEntry(false);
};
$("identity-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!canSaveSession()) {
    $("entry-error").textContent =
      "Allow browser storage for coshop so refreshing keeps your identity.";
    return;
  }
  const submit = $("enter-room");
  submit.disabled = true;
  $("entry-error").textContent = "";
  try {
    const result = await request(
      joining ? "/api/rooms/" + invite + "/join" : "/api/rooms",
      {
        body: {
          name: $("display-name").value,
          avatar: new FormData(event.currentTarget).get("avatar"),
          roomName: $("room-name").value,
        },
      },
    );
    invite = result.invite;
    session = { token: result.token, me: result.me };
    saveSession(invite, session);
    const url = new URL(location.href);
    url.search = "";
    url.searchParams.set("room", invite);
    if (guest) url.searchParams.set("guest", guest);
    history.replaceState(null, "", url);
    joining = true;
    connected(result);
  } catch (error) {
    if (
      ["ROOM_FULL", "ROOM_EXPIRED", "INVALID_LINK", "RATE_LIMITED"].includes(
        error.code,
      )
    )
      onError(error);
    else $("entry-error").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};
async function bootstrap() {
  if (!invite) {
    showScreen("landing");
    return;
  }
  joining = true;
  showStatus("LOADING", "Finding your people and your saved seat.");
  session = loadSession(invite);
  try {
    if (session?.token)
      connected(
        await request("/api/rooms/" + invite + "/session", {
          method: "POST",
          token: session.token,
          body: {},
        }),
      );
    else {
      const info = await request("/api/rooms/" + invite);
      if (info.full)
        showStatus(
          "ROOM_FULL",
          "All six seats are taken, including any seats reserved for reconnecting friends.",
          bootstrap,
        );
      else showEntry(true, info.name);
    }
  } catch (error) {
    if (error.code === "NETWORK")
      showStatus(error.code, error.message, bootstrap);
    else onError(error);
  }
}
function openInvite() {
  const url = new URL("/", location.origin);
  url.searchParams.set("room", invite);
  $("invite-url").value = url.href;
  $("copy-status").textContent = "";
  $("guest-links").replaceChildren(
    ...[1, 2].map((n) => {
      const link = make("a", "Open demo shopper " + n + " ↗", "text-link");
      const target = new URL(url);
      target.searchParams.set("guest", String(n));
      link.href = target.href;
      link.target = "_blank";
      link.rel = "noopener";
      return link;
    }),
  );
  $("invite-dialog").showModal();
}
$("invite").onclick = openInvite;
$("invite-empty").onclick = openInvite;
$("copy-invite").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("invite-url").value);
    $("copy-status").textContent = "Copied. Drop it in your call chat.";
  } catch {
    $("invite-url").focus();
    $("invite-url").select();
    $("copy-status").textContent = "Copy the selected invite link.";
  }
};
$("reconnect-now").onclick = () => connection?.retry();
for (const event of ["pointerdown", "pointermove", "keydown", "scroll"])
  document.addEventListener(event, () => connection?.activity(), {
    passive: true,
  });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) connection?.activity();
});
for (const close of document.querySelectorAll("[data-close]"))
  close.onclick = () => $(close.dataset.close).close();
const money = (v) =>
  new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: v.currency,
  }).format(v.cents / 100);
function openProduct(
  product,
  variantId = product.variants[0].id,
  publish = true,
) {
  const selected = product.variants.find((v) => v.id === variantId);
  if (!selected) {
    toast("That variant is no longer in this collection.");
    return;
  }
  selectedProduct = product.id;
  localView = {
    kind: "product",
    productId: product.id,
    variantId: selected.id,
  };
  const detail = $("product-detail");
  detail.replaceChildren();
  const img = make("img");
  img.src = product.image;
  img.alt = product.name;
  const copy = make("div", undefined, "product-copy");
  copy.append(
    make("p", "Sample collection", "eyebrow"),
    make("h2", product.name),
    make("p", product.description),
  );
  const label = make("label", "Choose a variant"),
    select = make("select");
  select.setAttribute("aria-label", "Choose a variant");
  product.variants.forEach((v) => {
    const option = make(
      "option",
      v.title + (v.available ? "" : " · unavailable"),
    );
    option.value = v.id;
    select.append(option);
  });
  select.value = selected.id;
  const price = make("strong", money(selected), "product-price");
  const availability = make(
    "p",
    selected.available
      ? "Sample product · preview only"
      : "This variant is currently unavailable.",
    "availability-note",
  );
  select.onchange = () => {
    const variant = product.variants.find((v) => v.id === select.value);
    price.textContent = money(variant);
    availability.textContent = variant.available
      ? "Sample product · preview only"
      : "This variant is currently unavailable.";
    publishView({
      kind: "product",
      productId: product.id,
      variantId: variant.id,
    });
    connection?.activity();
    finds.variantChanged();
  };
  copy.append(
    label,
    select,
    price,
    availability,
    make(
      "p",
      "Sample collection · reference prices and availability, not live merchandise. Sharing is separate from buying.",
      "fine",
    ),
  );
  const share = make("button", "Share find", "primary share-find-button");
  share.type = "button";
  const note = make("p", "", "share-find-note fine");
  note.id = "share-find-note";
  share.setAttribute("aria-describedby", note.id);
  copy.insertBefore(share, copy.lastElementChild);
  copy.insertBefore(note, copy.lastElementChild);
  finds.attachButton(share, note, product, () => select.value);
  detail.append(img, copy);
  $("product-dialog").hidden = false;
  $("collection-page").hidden = true;
  $("first-friend").hidden = true;
  presence.setLocalProduct(product.id);
  if (publish) {
    publishView(localView);
    requestAnimationFrame(() => {
      const heading = detail.querySelector("h2");
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      const top =
        $("product-dialog").getBoundingClientRect().top +
        scrollY -
        document.querySelector(".presence-strip").getBoundingClientRect()
          .height -
        12;
      scrollTo({ top: Math.max(0, top), behavior: "instant" });
    });
  }
}
function renderCollection() {
  const categories = ["All", ...new Set(catalog.map((p) => p.category))];
  $("category-filters").replaceChildren(
    ...categories.map((label) => {
      const chip = make(
        "button",
        label === "All" ? "Everything" : label,
        "category-chip",
      );
      chip.type = "button";
      chip.setAttribute("aria-pressed", String(category === label));
      chip.onclick = () => showCollection(label);
      return chip;
    }),
  );
  $("products").replaceChildren(
    ...catalog
      .filter((product) => category === "All" || product.category === category)
      .map((product) => {
        const card = make("button", undefined, "product sample-product");
        card.type = "button";
        card.setAttribute("aria-label", "View " + product.name);
        const img = make("img");
        img.src = product.image;
        img.alt = "";
        img.loading = "lazy";
        const copy = make("div", undefined, "sample-product-copy");
        copy.append(
          make("span", product.category, "fine"),
          make("h3", product.name),
          make("span", money(product.variants[0])),
        );
        card.append(img, copy);
        card.onclick = () => openProduct(product);
        return card;
      }),
  );
}
function showCollection(nextCategory = category, publish = true) {
  category = ["All", ...catalog.map((p) => p.category)].includes(nextCategory)
    ? nextCategory
    : "All";
  selectedProduct = null;
  localView = { kind: "category", category };
  $("product-dialog").hidden = true;
  $("collection-page").hidden = false;
  $("first-friend").hidden =
    !roomState || roomState.participants.filter((p) => p.connected).length > 1;
  presence.setLocalProduct(null);
  renderCollection();
  if (publish) publishView(localView);
}
$("back-to-collection").onclick = () => showCollection();
renderCollection();
// Existing monochrome ASCII interference artwork, kept in the AIR / CART lineage.
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let frame = 0;
function drawAscii() {
  const chars = " .:+*#";
  let output = "";
  for (let y = 0; y < 44; y++) {
    for (let x = 0; x < 68; x++) {
      const dx = (x - 34) / 25,
        dy = (y - 22) / 19,
        radius = Math.hypot(dx, dy),
        wave = Math.sin(dx * 5 + frame) * Math.cos(dy * 6 - frame * 0.5);
      output +=
        radius < 1.1
          ? chars[Math.min(5, Math.floor(Math.abs(wave) * (1.1 - radius) * 7))]
          : " ";
    }
    output += "\n";
  }
  $("ascii").textContent = output;
  frame += 0.05;
}
drawAscii();
if (!reducedMotion)
  setInterval(() => {
    if (!document.hidden && !$("landing").hidden) drawAscii();
  }, 150);
bootstrap();
