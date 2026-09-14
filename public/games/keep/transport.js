import { commandFor } from "./commands.js";
import { S } from "./strings.js";
export class Transport {
  constructor(store) {
    this.store = store;
    this.socket = null;
    this.attempt = 0;
    this.timer = null;
    this.stopped = false;
    this.retryAfterSnapshot = false;
    setInterval(
      () => {
        if (!this.stopped && this.store.status === "connected")
          fetch("/api/session", { credentials: "same-origin" }).catch(() => {});
      },
      12 * 60 * 60 * 1000,
    );
  }
  async start() {
    this.stopped = false;
    clearTimeout(this.timer);
    const old = this.socket;
    this.socket = null;
    old?.close();
    this.store.status = "connecting";
    this.store.emit();
    try {
      const r = await fetch("/api/session", { credentials: "same-origin" });
      if (!r.ok) throw new Error();
      this.store.session = await r.json();
      this.connect();
    } catch {
      this.store.status = "offline";
      this.store.error = S.connectionFailed;
      this.store.emit();
      this.schedule();
    }
  }
  connect() {
    clearTimeout(this.timer);
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?protocolVersion=1`,
    );
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      if (socket !== this.socket) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.receive(message);
    });
    socket.addEventListener("close", () => {
      if (socket !== this.socket || this.stopped) return;
      this.store.status = "reconnecting";
      this.store.emit();
      this.schedule();
    });
    socket.addEventListener("error", () => socket.close());
  }
  receive(message) {
    const s = this.store;
    if (message.kind === "hello") {
      s.session = {
        playerId: message.playerId,
        displayName: message.displayName,
        roomId: message.roomId,
      };
      s.status = "connected";
      s.roomsLoaded = false;
      this.attempt = 0;
      s.error = "";
      if (!message.roomId) {
        s.view = null;
        s.draft = [];
        s.screen = "home";
      }
      this.retryAfterSnapshot = Boolean(s.pending && message.roomId);
      if (message.roomId)
        this.read("REQUEST_SNAPSHOT", { roomId: message.roomId });
      else if (s.pending) this.retry();
      this.read("LIST_PUBLIC_ROOMS");
      s.emit();
    } else if (message.kind === "snapshot") {
      s.snapshot(message.view);
      if (this.retryAfterSnapshot) {
        this.retryAfterSnapshot = false;
        this.retry();
      }
    } else if (message.kind === "public_rooms") {
      s.rooms = message.rooms || [];
      s.roomsLoaded = true;
      s.emit();
    } else if (message.kind === "ack") {
      if (s.pending?.commandId === message.commandId) {
        const type = s.pending.type;
        s.pending = null;
        if (type === "LEAVE_ROOM") {
          if (s.view?.room.status !== "PLAYING") s.session.roomId = null;
          s.view = null;
          s.draft = [];
          s.screen = "home";
          this.read("LIST_PUBLIC_ROOMS");
        } else if (s.view)
          this.read("REQUEST_SNAPSHOT", { roomId: s.view.roomId });
      }
      s.emit();
    } else if (message.kind === "error") {
      if (!message.commandId || message.commandId === s.pending?.commandId)
        s.pending = null;
      s.error =
        message.code === "ROOM_UNAVAILABLE"
          ? S.roomUnavailable
          : message.message || S.error;
      s.emit();
      if (
        ["STALE_STATE", "WRONG_DECISION", "DEADLINE_EXPIRED"].includes(
          message.code,
        ) &&
        s.view
      )
        this.read("REQUEST_SNAPSHOT", { roomId: s.view.roomId });
    } else if (message.kind === "room_closed") {
      if (s.session?.roomId === message.roomId) {
        s.view = null;
        s.draft = [];
        s.session.roomId = null;
        s.screen = "home";
        s.error = S.roomClosed;
        s.emit();
      }
    } else if (message.kind === "control_moved") {
      this.stopped = true;
      s.status = "control_moved";
      s.pending = null;
      s.draft = [];
      s.emit();
      this.socket?.close();
    }
  }
  schedule() {
    if (this.stopped) return;
    const delay =
      Math.min(10000, 500 * 2 ** this.attempt++) * (0.8 + Math.random() * 0.4);
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => (this.store.session ? this.connect() : this.start()),
      delay,
    );
  }
  read(type, extra = {}) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(
        JSON.stringify({ protocolVersion: 1, kind: "read", type, ...extra }),
      );
  }
  send(type, payload = {}) {
    const s = this.store;
    if (s.pending || s.status !== "connected") return;
    const command = commandFor(s, type, payload);
    s.pending = command;
    s.error = "";
    s.emit();
    this.retry();
  }
  retry() {
    if (this.store.pending && this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(this.store.pending));
  }
  async rename(displayName) {
    const r = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ displayName }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || body.message || S.error);
    this.store.session = { ...this.store.session, ...body };
    this.store.emit();
  }
}
