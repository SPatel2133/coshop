// Authentication is the first frame, never part of the WebSocket URL.
export class RoomConnection {
  constructor({
    invite,
    token,
    interval = 20000,
    onState,
    onStatus,
    onError,
    checkSession,
  }) {
    Object.assign(this, {
      invite,
      token,
      interval,
      onState,
      onStatus,
      onError,
      checkSession,
    });
    this.attempt = 0;
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
    addEventListener("online", this.online);
    addEventListener("offline", this.offline);
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
      } else if (message.type === "error") this.onError(message);
    };
    socket.onerror = () => {};
    socket.onclose = async () => {
      clearTimeout(deadline);
      if (generation !== this.generation || this.stopped) return;
      clearInterval(this.heartbeatTimer);
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
    if (this.ready && this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(message));
  }
  activity() {
    if (!this.ready || Date.now() - (this.lastActivity || 0) < 15000) return;
    this.lastActivity = Date.now();
    this.send({ type: "activity" });
  }
  retry() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeatTimer);
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
    this.socket?.close();
    removeEventListener("online", this.online);
    removeEventListener("offline", this.offline);
    document.removeEventListener("visibilitychange", this.visible);
  }
}
