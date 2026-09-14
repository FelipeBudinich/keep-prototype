// CSS-pixel geometry is shared by painting, pointer input, and accessible controls.
export function pageItems(items, page, size) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.max(0, Math.min(pages - 1, page));
  return { items: items.slice(current * size, (current + 1) * size), page: current, pages, start: current * size };
}

export function getCanvasLayout(width, actionCount = 0, showTray = false) {
  const wide = width >= 900, pad = wide ? 20 : 12, gap = 16;
  const inner = width - pad * 2;
  const sidebar = wide ? Math.max(300, Math.min(360, inner * 0.3)) : inner;
  const boardWidth = wide ? inner - sidebar - gap : inner;
  const header = { x: pad, y: 14, w: inner, h: 48 };
  const board = { x: pad, y: 76, w: boardWidth, h: boardWidth < 480 ? 430 : 450 };
  const decision = { x: wide ? pad + boardWidth + gap : pad, y: wide ? 76 : board.y + board.h + gap, w: sidebar, h: 174 + Math.max(2, actionCount) * 50 };
  const hand = { x: pad, y: wide ? board.y + board.h + gap : decision.y + decision.h + gap, w: boardWidth, h: 264 };
  const tray = showTray ? { x: decision.x, y: wide ? decision.y + decision.h + gap : hand.y + hand.h + gap, w: sidebar, h: 388 } : null;
  const log = { x: pad, y: wide ? hand.y + hand.h + gap : (tray || hand).y + (tray || hand).h + gap, w: boardWidth, h: 210 };
  const footer = { x: pad, y: Math.max(log.y + log.h, (tray || decision).y + (tray || decision).h) + gap, w: inner, h: 48 };
  return { wide, width, height: footer.y + footer.h + pad, header, board, decision, hand, tray, log, footer, handSize: Math.max(2, Math.floor((boardWidth - 24) / 108)), traySize: 4, logSize: 3 };
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
