import { roomUrl } from "../client/room-url.js";
import { catalog as sample } from "../catalog.mjs";
import { RoomConnection, navigationId } from "../client/realtime.js";
import {
  canSaveSession,
  clearSession,
  guest,
  loadSession,
  saveSession,
} from "../client/session.js";
import { FindsState } from "../client/hold-ups.js";
import { resolveLocation } from "../client/presence.js";
import { createDiscussion } from "./discussion-model.js";
import { createBag } from "./bag-model.js";

const terminal = new Set([
  "INVALID_SESSION",
  "ROOM_FULL",
  "ROOM_EXPIRED",
  "INVALID_LINK",
  "RATE_LIMITED",
]);
const errors = {
  INVALID_SESSION: "Your saved seat is no longer available",
  ROOM_FULL: "This room is full",
  ROOM_EXPIRED: "This room has expired",
  INVALID_LINK: "That invitation isn’t valid",
  NETWORK: "Couldn’t connect",
  RATE_LIMITED: "Give it a moment",
};

const initialView = { kind: "category", category: "All" };

async function request(path, { token, body } = {}) {
  let response;
  let result;
  try {
    response = await fetch(roomUrl(path), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(path.endsWith("/checkout") ? 22000 : 12000),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    result = await response.json();
  } catch {
    throw Object.assign(
      new Error(
        "Couldn’t reach the room service. Check your connection and try again.",
      ),
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

export function createRoomStore() {
  let invite = new URL(location.href).searchParams.get("room");
  let session;
  let connection;
  let generation = 0;
  let identity;
  let toastTimer;
  let shareTimer;
  let cooldownTimer;
  let busy = false;
  let finds = new FindsState();
  const timers = new Set();
  const listeners = new Set();
  const reactionIds = new Set();
  let demoAttempt;
  let demoRetry;
  const initialSocial = {
    cards: [],
    unseen: 0,
    announcement: null,
    shareWait: 0,
    sharing: false,
    shareResult: null,
    repeated: null,
    reactions: [],
  };
  let state = {
    screen: invite ? "status" : "landing",
    demoPending: false,
    title: "Finding your room…",
    details: "Looking for your saved seat.",
    view: initialView,
    products: sample,
    online: false,
    ...initialSocial,
  };

  const publish = (changes) => {
    state = { ...state, ...changes };
    for (const notify of listeners) notify();
  };
  const later = (fn, delay) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, delay);
    timers.add(id);
    return id;
  };
  const cancel = (id) => {
    clearTimeout(id);
    timers.delete(id);
  };
  const command = (...args) => connection.command(...args);
  const service = (action, body) =>
    request("/api/rooms/" + invite + "/" + action, {
      token: session.token,
      body,
    });
  const toast = (message) => {
    cancel(toastTimer);
    publish({ toast: message });
    toastTimer = later(() => publish({ toast: "" }), 5000);
  };

  const discussion = createDiscussion(command, () =>
    publish({ discussionRevision: (state.discussionRevision || 0) + 1 }),
  );
  const bag = createBag(
    command,
    service,
    (next) =>
      publish({
        bag: next,
        ...(state.demoError &&
        next.confirmed?.revision > (state.bag?.confirmed?.revision ?? Infinity)
          ? { demoError: "" }
          : {}),
      }),
    toast,
  );

  function setView(view) {
    publish({ view });
    connection?.setView(view);
  }

  function showEntry(joining = false, roomName = "") {
    publish({
      screen: "entry",
      joining,
      roomName,
      entryError: "",
      submitting: false,
    });
  }

  function showStatus(code, details, retry) {
    publish({
      screen: "status",
      title: errors[code] || "Room unavailable",
      details,
      retry,
    });
  }

  function onError(error) {
    if (!terminal.has(error.code)) return toast(error.message);
    connection?.stop();
    connection = undefined;
    publish({ online: false });
    if (error.code === "INVALID_SESSION" || error.code === "ROOM_EXPIRED") {
      clearSession(invite);
      session = null;
    }
    const retry =
      error.code === "INVALID_SESSION"
        ? () => showEntry(true)
        : ["ROOM_FULL", "RATE_LIMITED"].includes(error.code)
          ? bootstrap
          : null;
    showStatus(
      error.code,
      error.code === "RATE_LIMITED"
        ? error.message + " Retry in " + (error.retryAfter || 60) + " seconds."
        : error.message,
      retry,
    );
  }

  function receiveRoom(room, me) {
    const newIdentity = room.id + ":" + me;
    if (identity !== newIdentity) {
      identity = newIdentity;
      discussion.reset();
      reactionIds.clear();
      demoAttempt = demoRetry = null;
      shareUntil = 0;
      cancel(shareTimer);
      cancel(cooldownTimer);
      publish({
        ...initialSocial,
        incoming: null,
        demoPending: false,
        demoError: "",
      });
      const key = "coshop:seen-finds:" + newIdentity;
      let seen = [];
      try {
        const value = JSON.parse(localStorage.getItem(key) || "[]");
        if (Array.isArray(value))
          seen = value.filter((id) => typeof id === "string");
      } catch {}
      finds = new FindsState(seen, (ids) => {
        try {
          localStorage.setItem(key, JSON.stringify(ids));
        } catch {}
      });
    }
    finds.snapshot(room.finds);
    const lastOwnShare = Math.max(
      0,
      ...room.finds
        .filter((find) => find.latestShare.by.id === me)
        .map((find) => find.latestShare.createdAt),
    );
    if (lastOwnShare)
      cooldown(Math.max(0, lastOwnShare + 3000 - room.serverTime), true);
    bag.snapshot(room, me);
    publish({
      room,
      me,
      screen: "room",
      invite,
      cards: finds.ordered(),
      unseen: finds.unseen(),
    });
  }

  function shopping(message) {
    if (message.type === "bag_changed") return bag.merge(message.bag, message);
    if (message.type === "discussion") return discussion.message(message);
    const { event, find } = message;
    if (message.type === "hold_up") {
      const first = !finds.cards.has(find.variantId) && !event.repeated;
      if (!finds.merge(find)) return;
      if (event.by.id === state.me) finds.markSeen(find.variantId, true);
      publish({ cards: finds.ordered(), unseen: finds.unseen() });
      if (event.repeated) {
        const repeated = { id: find.id, name: event.by.name };
        publish({ repeated });
        later(() => {
          if (state.repeated === repeated) publish({ repeated: null });
        }, 3500);
      }
      if (first && event.by.id !== state.me)
        publish({ incoming: { id: event.id, find, sender: event.by.name } });
    } else if (event && !reactionIds.has(event.id)) {
      reactionIds.add(event.id);
      if (reactionIds.size > 256)
        reactionIds.delete(reactionIds.values().next().value);
      publish({ reactions: [...state.reactions.slice(-5), event] });
      later(
        () =>
          publish({
            reactions: state.reactions.filter((item) => item.id !== event.id),
          }),
        1800,
      );
    }
  }

  async function connected(result, attempt) {
    if (attempt !== generation) return;
    session = { token: result.token || session?.token, me: result.me };
    saveSession(invite, session);
    const storefront =
      result.room.catalogMode === "shopify"
        ? await service("catalog")
        : { mode: "sample" };
    if (attempt !== generation) return;
    const products = storefront.products ?? sample;
    const person = result.room.participants.find((p) => p.id === result.me);
    const place = resolveLocation(person?.view, products);
    const view = place.product
      ? person.view
      : { kind: "category", category: place.category || "All" };
    publish({ storefront, products, view, online: false });
    receiveRoom(result.room, result.me);
    connection?.stop();
    connection = new RoomConnection({
      invite,
      token: session.token,
      interval: result.heartbeatInterval,
      onState: ({ room, me }) => {
        if (attempt === generation) receiveRoom(room, me);
      },
      onPresence: (message) => {
        const room = state.room;
        if (
          attempt !== generation ||
          !room ||
          message.version < room.version ||
          !room.participants.some((p) => p.id === message.participant.id)
        )
          return;
        publish({
          room: {
            ...room,
            version: message.version,
            expiresAt: message.expiresAt,
            participants: room.participants.map((p) =>
              p.id === message.participant.id ? message.participant : p,
            ),
          },
        });
      },
      onReady: () => {
        connection.setView(state.view);
        discussion.resync();
      },
      onShopping: shopping,
      onStatus: (online) => {
        publish({ online });
        discussion.setConnected(online);
        bag.setConnected(online);
      },
      onError,
      checkSession: () => service("session", {}),
    });
    connection.connect();
  }

  async function bootstrap() {
    if (!invite) return publish({ screen: "landing" });
    const attempt = ++generation;
    publish({
      screen: "status",
      title: "Finding your room…",
      details: "Looking for your saved seat.",
      retry: null,
    });
    session = loadSession(invite);
    try {
      if (session?.token)
        await connected(await service("session", {}), attempt);
      else {
        const info = await request("/api/rooms/" + invite);
        if (attempt !== generation) return;
        if (info.full)
          showStatus(
            "ROOM_FULL",
            "All " +
              info.capacity +
              " seats are taken, including reserved seats.",
            bootstrap,
          );
        else showEntry(true, info.name);
      }
    } catch (error) {
      if (attempt !== generation) return;
      if (terminal.has(error.code)) onError(error);
      else showStatus(error.code, error.message, bootstrap);
    }
  }

  async function enter(values) {
    if (busy) return;
    if (!canSaveSession())
      return publish({
        entryError: "Allow browser storage so refreshing keeps your identity.",
      });
    busy = true;
    const { joining } = state;
    const { catalogMode, ...identityFields } = values;
    const attempt = ++generation;
    publish({ submitting: true, entryError: "" });
    try {
      const result = await request(
        joining ? "/api/rooms/" + invite + "/join" : "/api/rooms",
        {
          body: joining ? identityFields : { ...identityFields, catalogMode },
        },
      );
      if (attempt !== generation) return;
      invite = result.invite;
      const url = new URL(location.href);
      url.search = "";
      url.searchParams.set("room", invite);
      if (guest) url.searchParams.set("guest", guest);
      history.replaceState(null, "", url);
      await connected(result, attempt);
    } catch (error) {
      if (attempt !== generation) return;
      if (terminal.has(error.code)) onError(error);
      else if (session?.token && invite)
        showStatus(error.code, error.message, bootstrap);
      else publish({ entryError: error.message });
    } finally {
      busy = false;
      if (attempt === generation) publish({ submitting: false });
    }
  }

  let shareUntil = 0;
  function cooldown(ms, extend = false) {
    if (extend && shareUntil > Date.now() + ms) return;
    shareUntil = Date.now() + ms;
    cancel(cooldownTimer);
    function tick() {
      const wait = Math.max(0, Math.ceil((shareUntil - Date.now()) / 1000));
      if (state.shareWait !== wait) publish({ shareWait: wait });
      if (wait)
        cooldownTimer = later(tick, Math.min(1000, shareUntil - Date.now()));
    }
    tick();
  }
  async function share(product, variant) {
    if (!state.online || state.shareWait || state.sharing) return;
    const scope = identity;
    publish({ sharing: true, shareResult: null });
    try {
      const { find } = await command("hold_up", {
        productId: product.id,
        variantId: variant.id,
      });
      if (scope !== identity) return;
      finds.merge(find);
      if (find.sharedBy.id === state.me) finds.markSeen(find.variantId, true);
      publish({
        cards: finds.ordered(),
        unseen: finds.unseen(),
        shareResult: find,
      });
      cooldown(3000);
    } catch (error) {
      if (scope !== identity) return;
      if (error.retryAfterMs) cooldown(error.retryAfterMs);
      toast(error.message);
    } finally {
      if (scope === identity) publish({ sharing: false });
    }
  }

  function markSeen(id) {
    finds.markSeen(id, true);
    const unseen = finds.unseen();
    if (unseen !== state.unseen) publish({ unseen });
  }

  function start() {
    const events = new AbortController();
    const activity = () => connection?.activity();
    for (const event of ["pointerdown", "pointermove", "keydown", "scroll"])
      document.addEventListener(event, activity, {
        passive: true,
        signal: events.signal,
      });
    const visibility = () => {
      if (!document.hidden) activity();
    };
    document.addEventListener("visibilitychange", visibility, {
      signal: events.signal,
    });
    window.addEventListener("pageshow", bag.pageShow, {
      signal: events.signal,
    });
    // Deferring boot avoids issuing two requests during Strict Mode's setup probe.
    const kick = later(bootstrap, 0);
    return () => {
      events.abort();
      cancel(kick);
      generation++;
      connection?.stop();
      connection = undefined;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      bag.dispose();
    };
  }

  return {
    getSnapshot: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start,
    enter,
    showEntry,
    setView,
    share,
    markSeen,
    toast,
    command,
    discussion,
    bag,
    async demo() {
      const confirmed = state.bag?.confirmed;
      if (
        demoAttempt ||
        state.room?.catalogMode !== "sample" ||
        !state.online ||
        !confirmed?.items.length ||
        confirmed.unavailable ||
        state.bag.pending.size
      )
        return false;
      const { revision } = confirmed;
      const attempt =
        demoRetry?.revision === revision
          ? demoRetry
          : { revision, id: navigationId() };
      demoAttempt = attempt;
      publish({ demoPending: true, demoError: "" });
      try {
        const { recap } = await service("haul-demo", attempt);
        if (demoAttempt !== attempt) return false;
        demoRetry = null;
        publish({ room: { ...state.room, recap } });
        return true;
      } catch (error) {
        if (demoAttempt === attempt) {
          demoRetry = error.code === "NETWORK" ? attempt : null;
          publish({ demoError: error.message });
        }
        return false;
      } finally {
        if (demoAttempt === attempt) {
          demoAttempt = null;
          publish({ demoPending: false });
        }
      }
    },
    retry: () => connection?.retry(),
  };
}
