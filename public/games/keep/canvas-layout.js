// CSS-pixel geometry is shared by painting, pointer input, and accessible controls.
export function pageItems(items, page, size) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.max(0, Math.min(pages - 1, page));
  return { items: items.slice(current * size, (current + 1) * size), page: current, pages, start: current * size };
}

export function getCanvasLayout(width, actionCount = 0, showTray = false, height = 800, activePanel = height < 620 ? null : "hand") {
  const short = height < 620, wide = width >= 800 || (short && width >= 560);
  const pad = !short && width >= 600 ? 24 : 10, gap = 8;
  const inner = width - pad * 2;
  const panel = activePanel === "tray" && !showTray ? "hand" : activePanel;
  const header = { x: pad, y: pad, w: inner, h: short ? 32 : 40 };
  const footer = { x: pad, y: height - pad - 44, w: inner, h: 44 };
  const dockHeight = 180;
  const decisionHeight = wide ? short ? 62 : 78 : 102;
  // In short landscape windows, a selected tray replaces the table until closed.
  // All controls keep their actual CSS-pixel size instead of scaling a tall page.
  const dock = panel ? { x: pad, y: short ? header.y + header.h + gap : footer.y - gap - dockHeight, w: inner,
    h: short ? footer.y - header.y - header.h - decisionHeight - gap * 3 : dockHeight } : null;
  const decision = { x: pad, y: (short || !dock ? footer.y : dock.y) - gap - decisionHeight, w: inner, h: decisionHeight };
  const board = short && dock ? null : { x: pad, y: header.y + header.h + gap, w: inner, h: decision.y - header.y - header.h - gap * 2 };
  const cardHeight = Math.min(124, (dock?.h || dockHeight) - 48);
  const cardWidth = cardHeight / 1.42;
  return {
    wide, short, width, height, header, board, decision, footer, activePanel: panel,
    hand: panel === "hand" ? dock : null, tray: panel === "tray" ? dock : null,
    log: panel === "log" ? dock : null, menu: panel === "menu" ? dock : null,
    cardWidth, cardHeight,
    handSize: Math.max(1, Math.floor((inner - 112) / (cardWidth + 12))),
    traySize: Math.max(1, Math.floor(((dock?.h || dockHeight) - 84) / 44)),
    logSize: Math.max(1, Math.floor(((dock?.h || dockHeight) - 84) / 36)),
    actionSize: Math.min(actionCount || 1, wide ? Math.max(2, Math.floor(inner * 0.55 / 140)) : 2),
  };
}

export function hitTarget(targets, x, y) {
  return [...targets].reverse().find((t) => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h);
}

const commands = {
  draw: "DRAW_CARD", send: "SEND_PACKET", pass: "PASS_PACKET",
  reveal: "REVEAL_PACKET_TOP", take: "TAKE_RANDOM_CARD", reclaim: "RECLAIM_CONTROL",
  rematch: "RETURN_TO_LOBBY", leave: "LEAVE_ROOM", "confirm-leave": "LEAVE_ROOM",
};
export function canActivateTarget(target, store, leaving = false) {
  if (!target || target.disabled || store.screen !== "table") return false;
  if (leaving && !["confirm-leave", "cancel-leave"].includes(target.action)) return false;
  const { action, dataset = {} } = target;
  if (commands[action] && !store.allowed(commands[action])) return false;
  if (action === "take") return store.view?.allowedCommands?.legalTakeTargetPlayerIds?.includes(dataset.playerId);
  if (action === "send") return store.draft.length > 0 && store.draft.every((h) => store.view.self.hand.some((c) => c.handle === h));
  if (["select-card", "remove-card", "move-up", "move-down", "clear-pile"].includes(action)) {
    if (!store.allowed("SEND_PACKET")) return false;
    if (action === "clear-pile") return store.draft.length > 0;
    if (!store.view.self.hand.some((c) => c.handle === dataset.handle)) return false;
    const index = store.draft.indexOf(dataset.handle);
    if (action === "remove-card") return index >= 0;
    if (action === "move-up") return index > 0;
    if (action === "move-down") return index >= 0 && index < store.draft.length - 1;
  }
  return true;
}
