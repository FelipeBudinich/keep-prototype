import ig from "../../lib/impact/impact.js";
import { S, cardLabel } from "./strings.js";
import { card, palette, rounded, text } from "./cards.js";
import { Presentation } from "./animations.js";
import { getTableState, logText } from "./table-view.js";
import { canActivateTarget, getCanvasLayout, hitTarget, pageItems } from "./canvas-layout.js";

function fit(ctx, value, width, size = 12, font = "Arial") {
  ctx.font = `${size}px ${font}`;
  let result = String(value ?? "");
  if (ctx.measureText(result).width <= width) return result;
  while (result.length && ctx.measureText(`${result}…`).width > width) result = result.slice(0, -1);
  return `${result}…`;
}

function paragraph(ctx, value, x, y, width, size = 13, color = palette.ink, lines = 3, font = "Arial") {
  ctx.font = `${size}px ${font}`;
  const words = String(value ?? "").split(/\s+/), rows = [];
  let row = "";
  for (const word of words) {
    if (row && ctx.measureText(`${row} ${word}`).width > width) {
      rows.push(row);
      row = word;
    } else row = row ? `${row} ${word}` : word;
  }
  if (row) rows.push(row);
  rows.slice(0, lines).forEach((line, i) => text(ctx,
    fit(ctx, i === lines - 1 && rows.length > lines ? `${line}…` : line, width, size, font),
    x, y + i * size * 1.35, size, color, "left", font));
}

export function canvasGameplay(store, transport, screens) {
  return {
    init() {
      this.presentation = new Presentation();
      this.targets = [];
      this.width = 0;
      this.height = 0;
      this.scale = 1;
      this.handPage = 0;
      this.trayPage = 0;
      this.logPage = 0;
      this.actionPage = 0;
      this.activePanel = undefined;
      this.background = new Image();
      this.background.src = new URL("./media/parchment-background.png", import.meta.url).href;
      this.focusId = null;
      this.hoverId = null;
      this.buttons = new Map();
      this.canvas = ig.system.canvas;
      this.controls = document.querySelector("#game-controls");
      this.wrap = document.querySelector(".canvas-wrap");
      // Activate on release; a drag should never accidentally play a card.
      this.canvas.style.touchAction = "pan-y";
      this.canvas.addEventListener("pointerdown", (event) => {
        if (event.button === 0) this.pointerDown = { x: event.clientX, y: event.clientY };
      });
      this.canvas.addEventListener("pointermove", (event) => {
        const p = this.point(event), hit = hitTarget(this.targets, p.x, p.y);
        this.hoverId = this.enabled(hit) ? hit.id : null;
        this.canvas.style.cursor = this.hoverId ? "pointer" : "default";
        if (this.pointerDown && Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y) > 10) this.pointerDown = null;
      });
      this.canvas.addEventListener("pointerup", (event) => {
        const down = this.pointerDown;
        this.pointerDown = null;
        if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 10) return;
        const p = this.point(event);
        this.canvas.focus({ preventScroll: true });
        this.activate(hitTarget(this.targets, p.x, p.y));
      });
      for (const event of ["pointercancel", "pointerleave"]) this.canvas.addEventListener(event, () => {
        this.pointerDown = null;
        this.hoverId = null;
      });
      this.wrap.addEventListener("keydown", (event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || document.querySelector("dialog[open]")) return;
        if (screens.leaving && event.key === "Escape") {
          event.preventDefault();
          this.activate(this.targets.find((t) => t.action === "cancel-leave"));
          return;
        }
        if (screens.leaving && event.key === "Tab") {
          event.preventDefault();
          const choices = [...this.buttons.values()].filter((b) => !b.disabled);
          const index = choices.indexOf(document.activeElement);
          choices[(index + (event.shiftKey ? -1 : 1) + choices.length) % choices.length]?.focus({ preventScroll: true });
          return;
        }
        if (event.key === "Escape" && this.layout?.activePanel) {
          event.preventDefault();
          this.activePanel = null;
          return;
        }
        const action = { d: "draw", p: "pass", r: "reveal", Escape: "clear-pile" }[event.key.length === 1 ? event.key.toLowerCase() : event.key];
        if (action && store.screen === "table") {
          event.preventDefault();
          this.activate(this.targets.find((t) => t.action === action));
        }
      });
    },
    point(event) {
      const rect = this.canvas.getBoundingClientRect();
      return { x: (event.clientX - rect.left) * this.width / rect.width, y: (event.clientY - rect.top) * this.height / rect.height };
    },
    enabled(target) {
      return !document.querySelector("dialog[open]") && target?.version === store.view?.stateVersion && canActivateTarget(target, store, screens.leaving);
    },
    activate(target) {
      // Re-check authority on activation; a server update can arrive after paint.
      if (!this.enabled(target)) return;
      if (target.pageKey) {
        this[target.pageKey] += target.delta;
        if (this.controls.contains(document.activeElement)) this.pageFocus = target.pageKey;
        return;
      }
      if (target.action === "panel") {
        this.activePanel = target.toggle && this.layout.activePanel === target.panel ? null : target.panel;
        return;
      }
      const handle = target.dataset?.handle;
      if (target.action === "move-up" || target.action === "move-down") {
        const index = store.draft.indexOf(handle) + (target.action === "move-up" ? -1 : 1);
        this.trayPage = Math.floor(index / this.layout.traySize);
      }
      screens.action(target.action, { dataset: target.dataset || {} });
    },
    update() {
      const bounds = this.wrap.getBoundingClientRect();
      const width = Math.max(280, Math.round(bounds.width));
      const table = store.screen === "table" && store.view;
      if (store.view?.matchId !== this.matchId) this.activePanel = undefined;
      if (this.activePanel === "tray" && !store.allowed("SEND_PACKET") && !store.draft.length) this.activePanel = "hand";
      this.model = table ? getTableState(store) : null;
      if (table && store.allowed("SEND_PACKET")) this.model.actions.push({
        id: "review-pile", action: "panel", panel: "tray", label: `${S.reviewPile}${store.draft.length ? ` · ${store.draft.length}` : ""}`, disabled: !store.draft.length,
      });
      this.layout = table ? getCanvasLayout(width, this.model.actions.length, store.allowed("SEND_PACKET") || store.draft.length > 0, Math.round(bounds.height), this.activePanel) : null;
      const height = this.layout?.height || Math.min(590, Math.max(280, width * 1.04));
      const scale = Math.min(2, window.devicePixelRatio || 1);
      if (width !== this.width || height !== this.height || scale !== this.scale) {
        this.width = width;
        this.height = height;
        this.scale = scale;
        ig.system.resize(width, height, scale);
        this.canvas.style.height = `${height}px`;
        this.canvas.style.width = "100%";
      }
      const decision = store.view?.game?.decision?.decisionId;
      if (decision !== this.decisionId || store.view?.matchId !== this.matchId) {
        this.handPage = 0;
        this.trayPage = 0;
        this.actionPage = 0;
        this.decisionId = decision;
        this.matchId = store.view?.matchId;
      }
      this.presentation.observe(store.view);
    },
    draw() {
      const ctx = ig.system.context;
      ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);
      this.targets = [];
      this.targetOffset = null;
      if (this.layout && store.screen === "table") {
        ctx.fillStyle = "#cfb081";
        ctx.fillRect(0, 0, this.width, this.height);
        if (this.background.complete && this.background.naturalWidth) {
          const zoom = Math.max(this.width / this.background.naturalWidth, this.height / this.background.naturalHeight);
          const w = this.background.naturalWidth * zoom, h = this.background.naturalHeight * zoom;
          ctx.drawImage(this.background, (this.width - w) / 2, (this.height - h) / 2, w, h);
        }
        this.drawHeader(ctx);
        if (this.layout.board) this.drawBoard(ctx, this.layout.board);
        this.drawDecision(ctx);
        if (this.layout.hand) this.drawHand(ctx);
        if (this.layout.tray) this.drawTray(ctx);
        if (this.layout.log) this.drawLog(ctx);
        if (this.layout.menu) this.drawMenu(ctx);
        this.drawFooter(ctx);
        if (screens.leaving) this.drawLeaveDialog(ctx);
        const target = this.targets.find((t) => t.id === this.focusId);
        if (target && this.enabled(target)) rounded(ctx, target.x - 3, target.y - 3, target.w + 6, target.h + 6, 7, null, "#9c6019");
        this.canvas.setAttribute("aria-label", `${S.table}. ${this.model.title} ${S.turn} ${store.view.game?.turnNumber || 1}. ${S.canvasKeyboard}`);
      } else this.drawHero(ctx);
      this.syncControls();
    },
    addTarget(target) {
      const rect = this.targetOffset;
      this.targets.push({ ...target, x: target.x + (rect?.x || 0), y: target.y + (rect?.y || 0), version: store.view?.stateVersion });
    },
    button(ctx, target, tone = "plain") {
      const enabled = canActivateTarget(target, store, false), hover = this.hoverId === target.id;
      const fill = tone === "gold" ? "#e8c374" : tone === "green" ? palette.green : hover && enabled ? "#e9e1cc" : "#fff8e7";
      ctx.save();
      if (!enabled) ctx.globalAlpha = 0.42;
      rounded(ctx, target.x, target.y, target.w, target.h, 6, fill, tone === "plain" ? "#c9bda0" : fill);
      text(ctx, fit(ctx, target.caption || target.label, target.w - 14, 12), target.x + target.w / 2, target.y + target.h / 2, 12, tone === "green" ? "#fff8e7" : palette.ink, "center");
      ctx.restore();
      this.addTarget(target);
    },
    panel(ctx, r, title) {
      rounded(ctx, r.x, r.y, r.w, r.h, 10, "#fff8e7df", "#95724380");
      text(ctx, title, r.x + 14, r.y + 21, 18, palette.ink, "left", "Georgia");
    },
    pager(ctx, rect, data, pageKey, noun) {
      if (data.pages <= 1) return;
      const y = rect.y + rect.h - 48;
      this.button(ctx, { id: `${pageKey}:previous`, action: "page", pageKey, delta: -1, label: `${S.previous}: ${noun}`, caption: "←", disabled: data.page === 0, x: rect.x + 12, y, w: 44, h: 40 });
      this.button(ctx, { id: `${pageKey}:next`, action: "page", pageKey, delta: 1, label: `${S.next}: ${noun}`, caption: "→", disabled: data.page === data.pages - 1, x: rect.x + rect.w - 56, y, w: 44, h: 40 });
      text(ctx, `${S.page} ${data.page + 1} / ${data.pages}`, rect.x + rect.w / 2, y + 20, 11, "#667268", "center");
    },
    drawHeader(ctx) {
      const r = this.layout.header;
      rounded(ctx, r.x, r.y, r.w, r.h, 8, "#fff8e7d9");
      text(ctx, fit(ctx, store.error || store.view.room.name, r.w - 92, this.layout.wide ? 24 : 19, "Georgia"), r.x + 12, r.y + 20, this.layout.wide ? 24 : 19, store.error ? palette.red : palette.ink, "left", "Georgia");
      text(ctx, `${S.turn} ${store.view.game?.turnNumber || 1}`, r.x + r.w - 12, r.y + 20, 12, "#66502e", "right");
    },
    drawDecision(ctx) {
      const r = this.layout.decision, m = this.model, wide = this.layout.wide;
      rounded(ctx, r.x, r.y, r.w, r.h, 10, "#173f34ee");
      const infoWidth = wide ? r.w * 0.43 : r.w;
      const remaining = store.remaining();
      const timer = m.ended ? "" : remaining === 0 ? S.expired : `${remaining ?? "–"}s`;
      text(ctx, fit(ctx, m.title, infoWidth - 110, wide ? 23 : 18, "Georgia"), r.x + 14, r.y + 22, wide ? 23 : 18, "#fff8e7", "left", "Georgia");
      text(ctx, timer, r.x + infoWidth - 14, r.y + 22, 17, remaining !== null && remaining <= 10 ? "#f3b59b" : "#f7e7b6", "right", "Georgia");
      text(ctx, fit(ctx, m.explanation, infoWidth - 28, 11), r.x + 14, r.y + (wide ? 51 : 41), 11, "#d7dfcb");
      const data = pageItems(m.actions, this.actionPage, this.layout.actionSize);
      this.actionPage = data.page;
      const area = { x: wide ? r.x + infoWidth + 12 : r.x + 10, y: r.y + (wide ? 17 : 53), w: wide ? r.w - infoWidth - 24 : r.w - 20 };
      const paged = data.pages > 1, inset = paged ? 48 : 0;
      const buttonWidth = (area.w - inset * 2 - Math.max(0, data.items.length - 1) * 8) / Math.max(1, data.items.length);
      data.items.forEach((action, i) => this.button(ctx, { ...action, group: "decision",
        caption: action.action === "take" ? store.view.players.find((p) => p.playerId === action.dataset.playerId)?.displayName : action.caption,
        x: area.x + inset + i * (buttonWidth + 8), y: area.y, w: buttonWidth, h: 40 }, "gold"));
      if (paged) {
        this.button(ctx, { id: "actionPage:previous", action: "page", pageKey: "actionPage", delta: -1, label: S.previous, caption: "←", disabled: data.page === 0, x: area.x, y: area.y, w: 40, h: 40 });
        this.button(ctx, { id: "actionPage:next", action: "page", pageKey: "actionPage", delta: 1, label: S.next, caption: "→", disabled: data.page === data.pages - 1, x: area.x + area.w - 40, y: area.y, w: 40, h: 40 });
      }
      if (!data.items.length) text(ctx, fit(ctx, m.status, area.w, 12), area.x + area.w / 2, area.y + 20, 12, "#e8c374", "center");
    },
    drawHand(ctx) {
      const r = this.layout.hand, hand = store.view.self.hand || [];
      this.panel(ctx, r, S.hand);
      text(ctx, `${hand.length} ${S.handCount}`, r.x + r.w - 14, r.y + 21, 11, "#59604c", "right");
      if (r.w > 700) text(ctx, S.handHelp, r.x + r.w / 2, r.y + 21, 11, "#59604c", "center");
      const data = pageItems(hand, this.handPage, this.layout.handSize);
      this.handPage = data.page;
      const cw = this.layout.cardWidth, ch = this.layout.cardHeight, gap = 12, start = r.x + (r.w - data.items.length * (cw + gap) + gap) / 2;
      data.items.forEach((c, i) => {
        const selected = store.draft.includes(c.handle), index = store.draft.indexOf(c.handle);
        const x = start + i * (cw + gap), y = r.y + (selected ? 38 : 44);
        card(ctx, c.type, x, y, cw, ch, { selected, index: data.start + i });
        if (selected) {
          rounded(ctx, x + cw - 24, y - 5, 26, 25, 12, "#b88a36");
          text(ctx, String(index + 1), x + cw - 11, y + 8, 12, "#fff8e7", "center");
        }
        this.addTarget({ id: `hand:${c.handle}`, action: "select-card", label: `${data.start + i + 1}. ${cardLabel(c.type)}${selected ? ` · ${S.selected} ${index + 1}` : ""}`, dataset: { handle: c.handle }, selected, disabled: !store.allowed("SEND_PACKET"), x, y, w: cw, h: ch });
      });
      if (!hand.length) text(ctx, S.noHand, r.x + r.w / 2, r.y + r.h / 2, 18, "#59604c", "center", "Georgia");
      if (data.pages > 1) {
        const y = r.y + 44 + (ch - 40) / 2;
        this.button(ctx, { id: "handPage:previous", action: "page", pageKey: "handPage", delta: -1, label: `${S.previous}: ${S.hand}`, caption: "←", disabled: data.page === 0, x: r.x + 8, y, w: 40, h: 40 });
        this.button(ctx, { id: "handPage:next", action: "page", pageKey: "handPage", delta: 1, label: `${S.next}: ${S.hand}`, caption: "→", disabled: data.page === data.pages - 1, x: r.x + r.w - 48, y, w: 40, h: 40 });
      }
    },
    drawTray(ctx) {
      const r = this.layout.tray;
      this.panel(ctx, r, S.tray);
      if (r.w > 600) text(ctx, `${S.sendTo} ${this.model.neighbor?.displayName || ""} · ${S.top}`, r.x + r.w / 2, r.y + 21, 11, "#667268", "center");
      const data = pageItems(store.draft, this.trayPage, this.layout.traySize);
      this.trayPage = data.page;
      data.items.forEach((handle, i) => {
        const index = data.start + i, c = store.view.self.hand.find((c) => c.handle === handle), y = r.y + 38 + i * 44;
        rounded(ctx, r.x + 12, y, r.w - 24, 40, 6, "#f1ead8");
        text(ctx, String(index + 1), r.x + 26, y + 22, 12, "#996d24", "center");
        text(ctx, fit(ctx, cardLabel(c?.type), r.w - 188, 12), r.x + 43, y + 22, 12);
        for (const [j, action, caption, disabled] of [[0, "move-up", "↑", index === 0], [1, "move-down", "↓", index === store.draft.length - 1], [2, "remove-card", "×", false]]) {
          this.button(ctx, { id: `${action}:${handle}`, action, caption, label: `${action === "move-up" ? S.moveUp : action === "move-down" ? S.moveDown : S.remove}: ${cardLabel(c?.type)} ${index + 1}`, disabled: disabled || !store.allowed("SEND_PACKET"), dataset: { handle }, x: r.x + r.w - 148 + j * 44, y, w: 40, h: 40 });
        }
      });
      if (!store.draft.length) paragraph(ctx, S.trayEmpty, r.x + 18, r.y + 66, r.w - 36, 14, "#59604c", 3, "Georgia");
      const y = r.y + r.h - 44;
      this.button(ctx, { id: "clear-pile", action: "clear-pile", label: S.clearPile, caption: S.clear, x: r.x + 10, y, w: 56, h: 36, disabled: !store.draft.length || !store.allowed("SEND_PACKET") });
      if (data.pages > 1) {
        this.button(ctx, { id: "trayPage:previous", action: "page", pageKey: "trayPage", delta: -1, label: `${S.previous}: ${S.tray}`, caption: "←", disabled: data.page === 0, x: r.x + 72, y, w: 36, h: 36 });
        this.button(ctx, { id: "trayPage:next", action: "page", pageKey: "trayPage", delta: 1, label: `${S.next}: ${S.tray}`, caption: "→", disabled: data.page === data.pages - 1, x: r.x + 114, y, w: 36, h: 36 });
      }
      this.button(ctx, { id: "send", action: "send", label: `${S.send}${store.draft.length ? ` · ${store.draft.length}` : ""}`, x: r.x + 158, y, w: r.w - 168, h: 36, disabled: !store.draft.length || !store.allowed("SEND_PACKET") }, "green");
    },
    drawLog(ctx) {
      const r = this.layout.log;
      this.panel(ctx, r, S.chronicle);
      const entries = [...(store.view.recentPublicLog || [])].reverse();
      const data = pageItems(entries, this.logPage, this.layout.logSize);
      this.logPage = data.page;
      data.items.forEach((entry, i) => paragraph(ctx, logText(entry, store.view), r.x + 16, r.y + 53 + i * 34, r.w - 32, 11, "#667268", 2));
      if (!entries.length) paragraph(ctx, S.noLog, r.x + 16, r.y + 66, r.w - 32, 13, "#667268");
      this.pager(ctx, r, data, "logPage", S.chronicle);
    },
    drawFooter(ctx) {
      const r = this.layout.footer;
      const w = (r.w - 24) / 4;
      for (const [i, panel, label] of [[0, "hand", S.handTab], [1, "tray", `${S.pileTab}${store.draft.length ? ` · ${store.draft.length}` : ""}`], [2, "log", S.historyTab], [3, "menu", S.menu]])
        this.button(ctx, { id: `panel:${panel}`, action: "panel", panel, toggle: true, label, selected: this.layout.activePanel === panel,
          disabled: panel === "tray" && !store.allowed("SEND_PACKET") && !store.draft.length,
          x: r.x + i * (w + 8), y: r.y, w, h: 44 }, this.layout.activePanel === panel ? "green" : "plain");
    },
    drawMenu(ctx) {
      const r = this.layout.menu;
      this.panel(ctx, r, S.menu);
      const actions = [{ id: "rules", action: "rules", label: S.how }];
      if (store.view.room.code) actions.push({ id: "copy-code", action: "copy-code", label: S.copyCode });
      actions.push({ id: "leave", action: "leave", label: S.leave, disabled: !store.allowed("LEAVE_ROOM") });
      const w = (r.w - 28 - (actions.length - 1) * 8) / actions.length;
      actions.forEach((action, i) => this.button(ctx, { ...action, x: r.x + 14 + i * (w + 8), y: r.y + 46, w, h: 44 }));
      paragraph(ctx, S.canvasKeyboard, r.x + 14, r.y + 115, r.w - 28, 11, "#59604c", 3);
    },
    drawLeaveDialog(ctx) {
      rounded(ctx, 0, 0, this.width, this.height, 12, "#142f26cc");
      this.targets = [];
      const bounds = this.canvas.getBoundingClientRect(), visibleTop = Math.max(0, -bounds.top), visibleBottom = Math.min(this.height, window.innerHeight - bounds.top);
      const w = Math.min(420, this.width - 24), h = 284, x = (this.width - w) / 2, y = Math.max(12, Math.min(this.height - h - 12, (visibleTop + visibleBottom - h) / 2));
      rounded(ctx, x, y, w, h, 12, "#fffaf0");
      text(ctx, S.leave, x + 20, y + 35, 27, palette.ink, "left", "Georgia");
      paragraph(ctx, S.leaveLive, x + 20, y + 79, w - 40, 14, "#667268", 4);
      this.button(ctx, { id: "cancel-leave", action: "cancel-leave", label: S.cancelLeave, x: x + 20, y: y + 166, w: w - 40, h: 44 }, "green");
      this.button(ctx, { id: "confirm-leave", action: "confirm-leave", label: S.leaveConfirm, x: x + 20, y: y + 222, w: w - 40, h: 44, disabled: !store.allowed("LEAVE_ROOM") });
    },
    syncControls() {
      const signature = JSON.stringify([store.screen, screens.leaving, this.width, this.height,
        this.targets.map((t) => [t.id, t.label, t.x, t.y, t.w, t.h, !this.enabled(t), t.selected])]);
      if (signature === this.controlSignature && !this.pageFocus) return;
      this.controlSignature = signature;
      this.controls.hidden = store.screen !== "table";
      this.controls.setAttribute("role", screens.leaving ? "dialog" : "group");
      this.controls.setAttribute("aria-label", screens.leaving ? S.leave : S.controls);
      if (screens.leaving) this.controls.setAttribute("aria-modal", "true");
      else this.controls.removeAttribute("aria-modal");
      const active = this.controls.contains(document.activeElement) ? document.activeElement : null;
      const activeId = active?.dataset.canvasTarget;
      const activeHandle = active?.dataset.handle;
      const ids = new Set(this.targets.map((t) => t.id));
      for (const [id, button] of this.buttons) if (!ids.has(id)) {
        if (document.activeElement === button) this.canvas.focus({ preventScroll: true });
        button.remove();
        this.buttons.delete(id);
        if (this.focusId === id) this.focusId = null;
      }
      for (const [index, target] of this.targets.entries()) {
        let button = this.buttons.get(target.id);
        if (!button) {
          button = document.createElement("button");
          button.type = "button";
          button.dataset.canvasTarget = target.id;
          button.addEventListener("click", () => this.activate(this.targets.find((t) => t.id === target.id)));
          button.addEventListener("focus", () => { this.focusId = target.id; });
          button.addEventListener("blur", () => { if (this.focusId === target.id) this.focusId = null; });
          this.controls.append(button);
          this.buttons.set(target.id, button);
        }
        button.textContent = target.label;
        button.dataset.handle = target.dataset?.handle || "";
        button.disabled = !this.enabled(target);
        if (target.selected !== undefined) button.setAttribute("aria-pressed", String(target.selected));
        button.style.left = `${target.x / this.width * 100}%`;
        button.style.top = `${target.y / this.height * 100}%`;
        button.style.width = `${target.w / this.width * 100}%`;
        button.style.height = `${target.h / this.height * 100}%`;
        // Keep Tab order aligned with the current painted rows, without replacing
        // the nodes that retain keyboard focus after selection or reordering.
        if (this.controls.children[index] !== button) this.controls.insertBefore(button, this.controls.children[index] || null);
      }
      let focus;
      if (screens.leaving && !this.wasLeaving) focus = this.buttons.get("cancel-leave");
      else if (!screens.leaving && this.wasLeaving) focus = this.buttons.get("leave");
      else if (this.pageFocus) {
        const target = this.targets.find((t) => this.enabled(t) &&
          (this.pageFocus === "handPage" ? t.action === "select-card" : this.pageFocus === "trayPage" ? t.action === "remove-card" : this.pageFocus === "actionPage" ? t.group === "decision" : t.pageKey === "logPage"));
        focus = this.buttons.get(target?.id) || [...this.buttons.values()].find((b) => !b.disabled && b.dataset.canvasTarget.startsWith(this.pageFocus));
      } else if (activeId) {
        focus = this.buttons.get(activeId);
        if (!focus || focus.disabled) focus = [...this.buttons.values()].find((b) => !b.disabled && activeHandle && b.dataset.handle === activeHandle);
      }
      if (focus && !focus.disabled && document.activeElement !== focus) focus.focus({ preventScroll: true });
      else if (active && (!active.isConnected || active.disabled) && document.activeElement !== this.canvas) this.canvas.focus({ preventScroll: true });
      this.pageFocus = null;
      this.wasLeaving = screens.leaving;
    },
  };
}
