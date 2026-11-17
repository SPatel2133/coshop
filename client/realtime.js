// getRandomValues also works on a plain-HTTP LAN preview; randomUUID is limited
// to secure contexts on phones. Membership credentials come from the server.
export function navigationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((n) => n.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
// Authentication is the first frame, never part of the WebSocket URL.
export class RoomConnection {
  constructor({
    invite,
    token,
    interval = 20000,
    onState,
    onPresence = () => {},
    onShopping = () => {},
    onReady = () => {},
    onStatus,
    onError,
    checkSession,
  }) {
    Object.assign(this, {
      invite,
      token,
      interval,
      onState,
      onPresence,
      onShopping,
      onReady,
      onStatus,
      onError,
      checkSession,
    });
    this.attempt = 0;
    this.commands = new Map();
    this.stopped = false;
    this.generation = 0;
    this.online = () => this.retry();
    this.offline = () => {
      clearTimeout(this.retryTimer);
      this.socket?.close();
      this.onStatus(false);
    };
    this.visible = () => {
      if (!document.hidden && !this.ready) this.retry();
    };
    this.pageHide = () => {
      // Browsers may freeze a page in their back/forward cache instead of
      // destroying it. Explicitly close its socket so friends see the exit.
      this.generation++;
      this.ready = false;
      clearTimeout(this.retryTimer);
      clearInterval(this.heartbeatTimer);
      this.clearViewTimers();
      this.inFlightView = null;
      this.socket?.close(1000, "Page left");
    };
    this.pageShow = (event) => {
      if (event.persisted && !this.stopped) this.retry();
    };
    addEventListener("online", this.online);
    addEventListener("offline", this.offline);
    addEventListener("pagehide", this.pageHide);
    addEventListener("pageshow", this.pageShow);
    document.addEventListener("visibilitychange", this.visible);
  }
  connect() {
    if (this.stopped || !navigator.onLine) {
      this.onStatus(false);
      return;
    }
    const generation = ++this.generation;
    this.ready = false;
    this.onStatus(false);
    const url = new URL(
      "/api/rooms/" + this.invite + "/socket",
      location.origin,
    );
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = (this.socket = new WebSocket(url));
    const deadline = setTimeout(() => {
      if (!this.ready) socket.close();
    }, 12000);
    socket.onopen = () => {
      if (generation === this.generation)
        socket.send(JSON.stringify({ type: "auth", token: this.token }));
    };
    socket.onmessage = (event) => {
      if (generation !== this.generation || this.stopped) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.lastReply = Date.now();
      if (message.type === "state") {
        clearTimeout(deadline);
        const firstSnapshot = !this.ready;
        if (!this.ready) {
          this.ready = true;
          this.attempt = 0;
          this.onStatus(true);
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = setInterval(() => {
            if (Date.now() - this.lastReply > this.interval * 2.5) {
              socket.close();
              return;
            }
            this.send({ type: "heartbeat" });
          }, this.interval);
        }
        this.onState(message);
        if (firstSnapshot) {
          this.onReady();
          this.flushView();
          this.flushCommands();
        }
      } else if (message.type === "hold_up" || message.type === "reaction")
        this.onShopping(message);
      else if (message.type === "command_ack") {
        const pending = this.commands.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.commands.delete(message.requestId);
        if (message.ok) pending.resolve(message);
        else pending.reject(Object.assign(new Error(message.message), message));
      } else if (message.type === "presence") this.onPresence(message);
      else if (message.type === "view_ack") {
        if (this.inFlightView?.requestId !== message.requestId) return;
        clearTimeout(this.viewAckTimer);
        const flight = this.inFlightView;
        this.inFlightView = null;
        if (message.accepted) {
          if (this.desiredView?.requestId === flight.requestId)
            this.desiredView = null;
          this.flushView();
        } else
          this.viewTimer = setTimeout(
            () => this.flushView(),
            (message.retryAfterMs || 500) + 20,
          );
      } else if (message.type === "error") {
        if (message.code === "INVALID_VIEW") {
          this.clearViewTimers();
          this.inFlightView = null;
          this.desiredView = null;
        }
        this.onError(message);
      }
    };
    socket.onerror = () => {};
    socket.onclose = async () => {
      clearTimeout(deadline);
      if (generation !== this.generation || this.stopped) return;
      clearInterval(this.heartbeatTimer);
      this.clearViewTimers();
      this.inFlightView = null;
      this.ready = false;
      this.onStatus(false);
      // An HTTP request distinguishes expired/full/invalid sessions from a lost
      // network connection, since browsers hide failed upgrade response bodies.
      if (navigator.onLine) {
        try {
          await this.checkSession();
        } catch (error) {
          if (error.code && error.code !== "NETWORK") this.onError(error);
        }
      }
      if (this.stopped || generation !== this.generation || !navigator.onLine)
        return;
      const delay =
        Math.min(15000, 500 * 2 ** Math.min(this.attempt++, 5)) *
        (0.8 + Math.random() * 0.4);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }
  send(message) {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }
  command(type, payload) {
    if (!this.ready || this.stopped)
      return Promise.reject(new Error("Reconnect before sharing a find."));
    if (!["hold_up", "react"].includes(type))
      return Promise.reject(new Error("Unsupported shopping action."));
    const message = { ...payload, type, requestId: navigationId() };
    return new Promise((resolve, reject) => {
      const pending = { message, resolve, reject, expires: Date.now() + 15000 };
      this.commands.set(message.requestId, pending);
      this.sendCommand(pending);
    });
  }
  sendCommand(pending) {
    clearTimeout(pending.timer);
    if (Date.now() >= pending.expires) {
      this.commands.delete(pending.message.requestId);
      pending.reject(
        new Error(
          "Couldn’t confirm that action. Reconnect to check the shared bag before trying again.",
        ),
      );
      return;
    }
    // An acknowledgement may be lost after the server commits. Keep its ID.
    this.send(pending.message);
    pending.timer = setTimeout(
      () => this.sendCommand(pending),
      Math.min(3000, pending.expires - Date.now()),
    );
  }
  flushCommands() {
    for (const pending of this.commands.values()) this.sendCommand(pending);
  }
  setView(view) {
    this.desiredView = { type: "view", requestId: navigationId(), view };
    this.flushView();
  }
  flushView() {
    clearTimeout(this.viewTimer);
    if (!this.ready || this.inFlightView || !this.desiredView) return;
    const wait = 500 - (Date.now() - (this.lastViewSent || 0));
    if (wait > 0) {
      this.viewTimer = setTimeout(() => this.flushView(), wait);
      return;
    }
    const next = this.desiredView;
    if (!this.send(next)) return;
    this.lastViewSent = Date.now();
    this.inFlightView = next;
    // Reuse the same identifier if an acknowledgement is lost.
    this.viewAckTimer = setTimeout(() => {
      this.inFlightView = null;
      this.flushView();
    }, 3000);
  }
  clearViewTimers() {
    clearTimeout(this.viewTimer);
    clearTimeout(this.viewAckTimer);
  }
  activity() {
    if (!this.ready || Date.now() - (this.lastActivity || 0) < 1100) return;
    this.lastActivity = Date.now();
    this.send({ type: "activity" });
  }
  retry() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeatTimer);
    this.clearViewTimers();
    this.inFlightView = null;
    this.generation++;
    this.socket?.close();
    this.attempt = 0;
    this.connect();
  }
  stop() {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeatTimer);
    this.clearViewTimers();
    this.inFlightView = null;
    for (const pending of this.commands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The shopping session ended."));
    }
    this.commands.clear();
    this.socket?.close();
    removeEventListener("online", this.online);
    removeEventListener("offline", this.offline);
    removeEventListener("pagehide", this.pageHide);
    removeEventListener("pageshow", this.pageShow);
    document.removeEventListener("visibilitychange", this.visible);
  }
}
