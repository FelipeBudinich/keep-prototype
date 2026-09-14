export class ViewStore extends EventTarget {
  constructor() {
    super();
    this.view = null;
    this.session = null;
    this.status = "connecting";
    this.pending = null;
    this.rooms = [];
    this.draft = [];
    this.error = "";
    this.offset = 0;
    this.screen = "home";
  }
  emit() {
    this.dispatchEvent(new Event("change"));
  }
  snapshot(view) {
    const previous = this.view;
    const valid = new Set(view.self?.hand?.map((c) => c.handle) || []);
    if (
      previous?.game?.decision?.decisionId !==
        view.game?.decision?.decisionId ||
      previous?.game?.activePlayerId !== view.game?.activePlayerId ||
      view.game?.decision?.playerId !== view.self?.playerId
    )
      this.draft = [];
    else this.draft = this.draft.filter((h) => valid.has(h));
    this.view = view;
    this.session = { ...this.session, roomId: view.roomId };
    this.offset = new Date(view.serverTime).getTime() - Date.now();
    if (!Number.isFinite(this.offset)) this.offset = 0;
    this.screen = view.room.status === "LOBBY" ? "lobby" : "table";
    this.emit();
  }
  allowed(type) {
    if (
      [
        "DRAW_CARD",
        "SEND_PACKET",
        "PASS_PACKET",
        "REVEAL_PACKET_TOP",
        "TAKE_RANDOM_CARD",
      ].includes(type) &&
      this.view?.self?.controllerMode !== "HUMAN"
    )
      return false;
    return (
      Boolean(this.view?.allowedCommands?.types?.includes(type)) &&
      this.status === "connected" &&
      !this.pending
    );
  }
  toggle(handle) {
    if (!this.allowed("SEND_PACKET")) return;
    this.draft = this.draft.includes(handle)
      ? this.draft.filter((h) => h !== handle)
      : [...this.draft, handle];
    this.emit();
  }
  move(handle, offset) {
    const i = this.draft.indexOf(handle),
      j = i + offset;
    if (i < 0 || j < 0 || j >= this.draft.length) return;
    [this.draft[i], this.draft[j]] = [this.draft[j], this.draft[i]];
    this.emit();
  }
  remaining() {
    const deadline = this.view?.game?.decision?.deadlineAt;
    return deadline
      ? Math.max(
          0,
          Math.ceil(
            (new Date(deadline).getTime() - Date.now() - this.offset) / 1000,
          ),
        )
      : null;
  }
}
