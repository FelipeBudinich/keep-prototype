import { S, cardLabel } from "./strings.js";
import { getTableState, logText } from "./table-view.js";
export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const e = escapeHtml;
const button = (text, action, classes = "", disabled = false, extra = "") =>
  `<button type="button" class="button ${classes}" data-action="${action}" ${disabled ? "disabled" : ""} ${extra}>${e(text)}</button>`;
const badge = (text, style = "") =>
  `<span class="badge ${style}">${e(text)}</span>`;
export class Screens {
  constructor(store, transport) {
    this.store = store;
    this.transport = transport;
    this.panel = document.querySelector("#screen-panel");
    this.editing = false;
    this.leaving = false;
    this.toastTimer = null;
    this.lastAnnouncement = "";
    document.querySelector("#header-note").textContent = S.invitation;
    document.querySelector("#hero-invitation").textContent = S.invitation;
    document.querySelector("#footer-left").textContent = S.cards;
    document.querySelector("#footer-right").textContent = S.engine;
    document.querySelector("#rules-open").textContent = S.how;
    document.querySelector("#rules-open").onclick = () =>
      document.querySelector("#rules-dialog").showModal();
    document.querySelector("#rules-close").onclick = () =>
      document.querySelector("#rules-dialog").close();
    document.querySelector("#rules-content").innerHTML =
      `<p class="eyebrow">${S.rulesTitle}</p><h2>${S.rulesGoal}</h2><p class="muted">${S.rulesIntro}</p><div class="rules-grid"><section><h3>${S.send}</h3><p>${S.rulesSend}</p><p>${S.rulesReceive}</p></section><section><h3>${S.treasure}</h3><p>${S.rulesTreasure}</p></section><section><h3>${S.goblin}</h3><p>${S.rulesGoblin}</p></section><section><h3>${S.adventurer}</h3><p>${S.rulesAdventurer}</p></section><section><h3>${S.take}</h3><p>${S.rulesTake}</p></section><section><h3>${S.table}</h3><p>${S.rulesOrder}</p><p>${S.rulesTime}</p></section></div>`;
    document.addEventListener("click", (event) => {
      const target = event.target.closest("[data-action]");
      if (target && !target.disabled)
        this.action(target.dataset.action, target);
    });
    this.panel.addEventListener("submit", (event) => this.submit(event));
    this.panel.addEventListener("input", () => this.updateTotal());
    store.addEventListener("change", () => this.render());
    this.render();
    setInterval(() => this.tick(), 250);
  }
  toast(text) {
    const el = document.querySelector("#toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (el.hidden = true), 3000);
  }
  render() {
    const s = this.store,
      v = s.view,
      screen = s.screen;
    const landing = !["table", "lobby"].includes(screen);
    const preserve = landing && this.renderedScreen === screen;
    const fields = preserve
      ? [...this.panel.querySelectorAll("form")].flatMap((form) =>
          [...form.elements].filter((el) => el.name && el.value !== (
            el.tagName === "SELECT"
              ? [...el.options].find((option) => option.defaultSelected)?.value || el.options[0]?.value
              : el.defaultValue
          )).map((el) => ({
            form: form.dataset.form, name: el.name, value: el.value,
          })),
        )
      : [];
    const nameOpen = preserve && this.panel.querySelector(".name-editor")?.open;
    const focused = preserve && this.panel.contains(document.activeElement)
      ? document.activeElement : null;
    const selection = focused?.tagName === "INPUT" && focused.selectionStart !== null
      ? [focused.selectionStart, focused.selectionEnd] : null;
    document.body.classList.toggle("landing", landing);
    document.body.classList.toggle("playing", screen === "table");
    const connected = s.status === "connected";
    const conn = document.querySelector("#connection");
    conn.textContent = connected ? S.connected : S.reconnecting;
    conn.classList.toggle("warning", !connected);
    const banner = document.querySelector("#status");
    let notice = "",
      act = "";
    if (s.status === "control_moved") {
      notice = `${S.moved} ${S.movedHelp}`;
      act = button(S.returnHere, "reconnect", "small");
    } else if (!connected) {
      notice = S[s.status] || S.connecting;
      if (s.status === "offline") act = button(S.retry, "reconnect", "small");
    } else if (s.pending) notice = S.pending;
    banner.classList.toggle("visible", Boolean(notice));
    banner.innerHTML = `${e(notice)} ${act}`;
    document.querySelector("#layout").className =
      `layout ${screen === "table" ? "table-layout" : screen === "lobby" ? "lobby-layout" : "home-layout"}`;
    this.panel.hidden = screen === "table";
    const summary = document.querySelector("#game-summary");
    summary.hidden = screen !== "table";
    summary.innerHTML = screen === "table" ? this.table() : "";
    this.panel.innerHTML =
      (s.error ? `<div class="error" role="alert">${e(s.error)}</div>` : "") +
      (screen === "table"
        ? ""
        : screen === "lobby"
          ? this.lobby()
          : this.home());
    for (const field of fields) {
      const form = [...this.panel.querySelectorAll("form")].find(
        (form) => form.dataset.form === field.form,
      );
      const input = form?.elements.namedItem(field.name);
      if (input) input.value = field.value;
    }
    const nameEditor = this.panel.querySelector(".name-editor");
    if (nameEditor && nameOpen) nameEditor.open = true;
    if (focused) {
      const replacement = [...this.panel.querySelectorAll("input, select, button, summary")].find(
        (el) => el.tagName === focused.tagName &&
          el.name === focused.name &&
          el.form?.dataset.form === focused.form?.dataset.form &&
          el.dataset.action === focused.dataset.action &&
          el.dataset.roomId === focused.dataset.roomId,
      );
      replacement?.focus({ preventScroll: true });
      if (replacement && selection) replacement.setSelectionRange(...selection);
    }
    this.renderedScreen = screen;
    if (fields.length) this.updateTotal();
    this.tick();
    if (screen !== "table") {
      document.querySelector("#announcement").textContent = "";
      this.lastAnnouncement = "";
    }
    if (screen === "table" && v?.game) {
      const player = v.players.find(
        (p) => p.playerId === v.game.decision?.playerId,
      );
      const announcement = v.game.winnerPlayerId
        ? `${v.players.find((p) => p.playerId === v.game.winnerPlayerId)?.displayName} ${S.won}`
        : v.self.controllerMode === "TEMP_BOT"
          ? S.botControl
          : v.game.decision?.playerId === v.self.playerId
            ? s.allowed("REVEAL_PACKET_TOP")
              ? S.receivePrompt
              : S.yourTurn
            : `${player?.displayName || ""} ${S.deciding}`;
      if (announcement !== this.lastAnnouncement) {
        document.querySelector("#announcement").textContent = announcement;
        this.lastAnnouncement = announcement;
      }
    }
  }
  home() {
    const s = this.store;
    const disabled = s.status !== "connected" || Boolean(s.pending);
    const back = `<button class="back-button" data-action="home">${S.back}</button>`;
    if (s.screen === "create")
      return `${back}<p class="eyebrow">${S.invitation}</p><h2>${S.create}</h2><p class="muted">${S.createHelp}</p>${this.configurationForm(false)}`;
    if (s.screen === "join")
      return `${back}<p class="eyebrow">${S.privateTable || S.private}</p><h2>${S.join}</h2><p class="intro">${S.privateHelp}</p><form data-form="join"><div class="form-fields"><label>${S.code}<input class="code-input" name="code" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="000000" autocomplete="off" required aria-label="${S.code}"></label></div><button class="button primary wide" ${disabled ? "disabled" : ""}>${S.joinTable}</button></form>`;
    if (s.screen === "browse")
      return `${back}<p class="eyebrow">${S.publicTable}</p><h2>${S.browse}</h2>${button(S.refresh, "refresh", "small", disabled)}<div class="room-list">${s.rooms.length ? s.rooms.map((r) => `<article class="room-item"><h3>${e(r.name)}</h3><p class="muted">${e(r.hostDisplayName)} · ${r.bots} ${S.bots.toLowerCase()}<br>${r.availableHumanSeats} ${S.publicCount}</p>${button(S.joinTable, "join-public", "primary wide", disabled, `data-room-id="${e(r.roomId)}"`)}</article>`).join("") : `<div class="empty-state"><h3>${S.noRooms}</h3><p class="muted">${S.noRoomsHelp}</p></div>`}</div>`;
    return `<header class="table-panel-heading"><h1>${S.tablePanelTitle}</h1><details class="name-editor"><summary><span class="guest-name">${e(s.session?.displayName || S.guest)}</span><span>${S.changeName}</span></summary><form data-form="rename" class="name-inline"><label>${S.name}<input name="displayName" maxlength="24" required autocomplete="nickname" value="${e(s.session?.displayName || "")}" placeholder="${S.guest}"></label><button class="button small" ${disabled ? "disabled" : ""}>${S.saveName}</button></form></details></header>
      ${s.session?.roomId ? `<div class="resume-table">${button(S.resume, "resume", "gold wide", disabled)}</div>` : ""}
      <section class="table-option" aria-labelledby="public-tables-title"><div class="section-heading"><h2 id="public-tables-title">${S.publicTables} <span class="table-count">${s.roomsLoaded ? s.rooms.length : "–"}</span></h2>${button(S.refreshShort, "refresh", "text-button small", disabled, `aria-label="${S.refresh}"`)}</div><div class="room-list landing-rooms" aria-live="polite">${this.publicRooms(disabled)}</div></section>
      <section class="table-option" aria-labelledby="private-tables-title"><h2 id="private-tables-title">${S.privateTables}</h2><p class="muted" id="private-join-help">${S.privateJoinHelp}</p><form data-form="join" class="private-join"><label class="sr-only" for="private-code">${S.code}</label><input id="private-code" class="code-input" name="code" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="000000" autocomplete="off" required aria-describedby="private-join-help"><button class="button" ${disabled ? "disabled" : ""}>${S.joinTable}</button></form></section>
      <div class="landing-footer">${button(S.create, "create", "primary wide create-table", disabled)}${button(S.how, "rules", "text-button wide")}</div>`;
  }
  publicRooms(disabled) {
    const s = this.store;
    if (!s.roomsLoaded)
      return `<div class="empty-state"><p class="muted">${S.loadingTables}</p></div>`;
    if (!s.rooms.length)
      return `<div class="empty-state"><p>${S.noRooms}</p><p class="muted">${S.noRoomsHelp}</p></div>`;
    return s.rooms.map((r) => `<article class="room-item"><div class="room-info"><h3>${e(r.name)}</h3><p class="muted">${e(r.hostDisplayName)} · ${r.availableHumanSeats} ${S.publicCount}${r.bots ? ` · ${r.bots} ${r.bots === 1 ? S.botDragon : S.bots.toLowerCase()}` : ""}</p></div>${button(S.joinTable, "join-public", "small", disabled, `data-room-id="${e(r.roomId)}" aria-label="${e(`${S.joinTable}: ${r.name}`)}"`)}</article>`).join("");
  }

  configurationForm(edit) {
    const v = this.store.view,
      config = edit ? v.room.configuration : { additionalHumans: 1, bots: 0 };
    const disabled =
      this.store.status !== "connected" || Boolean(this.store.pending);
    return `<form data-form="${edit ? "settings" : "create"}"><div class="form-fields"><label>${S.roomName}<input name="name" maxlength="48" required value="${e(edit ? v.room.name : S.newRoom)}"></label><label>${S.visibility}<select name="visibility"><option value="PRIVATE" ${!edit || v.room.visibility === "PRIVATE" ? "selected" : ""}>${S.private}</option><option value="PUBLIC" ${edit && v.room.visibility === "PUBLIC" ? "selected" : ""}>${S.public}</option></select></label><div class="two-fields"><label>${S.additionalHumans}<input type="number" name="additionalHumans" min="0" max="5" step="1" required value="${config.additionalHumans}"></label><label>${S.bots}<input type="number" name="bots" min="0" max="5" step="1" required value="${config.bots}"></label></div></div><div class="total-count"><span>${S.total}</span><strong id="total-preview">${1 + config.additionalHumans + config.bots}</strong></div><p id="count-error" class="error" hidden>${S.invalidCounts}</p><button class="button primary wide" ${disabled ? "disabled" : ""}>${edit ? S.saveSettings : S.create}</button>${edit ? button(S.cancel, "cancel-settings", "text-button wide") : ""}</form>`;
  }
  lobby() {
    const s = this.store,
      v = s.view;
    if (!v) return "";
    const self = v.players.find((p) => p.playerId === v.self.playerId),
      host = v.room.hostPlayerId === v.self.playerId;
    const config = v.room.configuration;
    if (this.editing && host)
      return `<p class="eyebrow">${S.settings}</p><h2>${e(v.room.name)}</h2>${this.configurationForm(true)}`;
    const seats = Array.from(
      { length: 1 + config.additionalHumans + config.bots },
      (_, i) => {
        const p = v.players.find((p) => p.seatIndex === i);
        return p
          ? `<div class="seat-row"><span class="seat-number">${i + 1}</span><div class="seat-info"><div class="seat-name">${e(p.displayName)} ${p.playerId === self?.playerId ? `· ${S.you}` : ""}</div><p class="muted">${p.kind === "BOT" ? S.bot : S.human}${p.playerId === v.room.hostPlayerId ? ` · ${S.host}` : ""}${!p.connected && p.kind !== "BOT" ? ` · ${S.disconnected}` : ""}</p></div>${badge(p.ready || p.kind === "BOT" ? S.ready : S.notReady, p.ready || p.kind === "BOT" ? "ready" : "")}</div>`
          : `<div class="seat-row empty"><span class="seat-number">${i + 1}</span><div class="seat-info"><span class="seat-name">${S.empty}</span></div></div>`;
      },
    ).join("");
    return `<p class="eyebrow">${S.lobby}</p><h2>${e(v.room.name)}</h2><p class="muted">${S.lobbyIntro}</p>${v.room.code ? `<div class="invite"><div><p class="eyebrow">${S.privateCode}</p><span class="invite-code">${e(v.room.code)}</span></div>${button(S.copyCode, "copy-code", "small")}</div>` : `<div class="invite"><span>${S.publicTable}</span>${badge(S.public)}</div>`}<div class="seat-list">${seats}</div><p class="form-note">${S.readyTime}</p><div class="button-row">${button(self?.ready ? S.unready : S.markReady, "ready", self?.ready ? "" : "primary", !s.allowed("SET_READY"))}${host ? button(S.start, "start", "primary", !s.allowed("START_MATCH")) : ""}</div>${host && !s.allowed("START_MATCH") ? `<p class="muted" style="margin-top:10px">${S.waitingStart}</p>` : ""}<div class="table-bottom">${host ? button(S.settings, "settings", "text-button", !s.allowed("UPDATE_ROOM")) : "<span></span>"}${button(S.leave, "leave", "text-button", !s.allowed("LEAVE_ROOM"))}</div>`;
  }
  table() {
    const s = this.store,
      v = s.view,
      state = getTableState(s, this.leaving);
    if (!state) return "";
    const game = v.game || {};
    return `${s.error ? `<p role="alert">${e(s.error)}</p>` : ""}<h2>${e(v.room.name)}</h2><p>${S.turn} ${game.turnNumber || 1}. ${e(state.status)}</p><section aria-labelledby="game-decision-title"><h3 id="game-decision-title">${e(state.title)}</h3><p>${e(state.explanation)}</p>${!state.ended ? `<p id="countdown" aria-label="${S.countdownLabel}"></p>` : ""}${state.ended && !s.allowed("RETURN_TO_LOBBY") ? `<p>${S.waitRematch}</p>` : ""}</section><p id="game-keyboard-help">${S.keyboard}</p><section aria-labelledby="game-lairs-title"><h3 id="game-lairs-title">${S.table}</h3><ul>${v.players.map((player) => `<li>${e(player.displayName)}${player.playerId === v.self.playerId ? ` (${S.you})` : ""}: ${player.visibleTreasureCount}/3 ${S.treasures}, ${player.visibleGoblinCount} ${S.goblins}, ${player.handCount} ${S.handCount}. ${player.playerId === game.activePlayerId ? `${S.active}.` : ""} ${player.playerId === game.decision?.playerId ? `${S.deciding}.` : ""}</li>`).join("")}</ul></section><section aria-labelledby="game-hand-title"><h3 id="game-hand-title">${S.hand}</h3><p>${v.self.hand?.length || 0} ${S.handCount}.</p>${!v.self.hand?.length ? `<p>${S.noHand}</p>` : `<ol>${v.self.hand.map((card) => `<li>${e(cardLabel(card.type))}${s.draft.includes(card.handle) ? ` · ${S.selected}` : ""}</li>`).join("")}</ol>`}</section><section aria-labelledby="game-draft-title"><h3 id="game-draft-title">${S.tray}</h3><p>${S.sendTo} ${e(state.neighbor?.displayName)}. ${S.top}.</p>${s.draft.length ? `<ol>${s.draft.map((handle) => `<li>${e(cardLabel(v.self.hand.find((card) => card.handle === handle)?.type))}</li>`).join("")}</ol>` : `<p>${S.trayEmpty}</p>`}</section><section aria-labelledby="game-log-title"><h3 id="game-log-title">${S.chronicle}</h3><ol>${(v.recentPublicLog || []).slice(-12).reverse().map((entry) => `<li>${e(logText(entry, v))}</li>`).join("") || `<li>${S.noLog}</li>`}</ol></section>`;
  }
  tick() {
    const el = document.querySelector("#countdown");
    if (el) {
      const n = this.store.remaining();
      el.textContent = n === 0 ? S.expired : `${n ?? "–"} ${S.countdown}`;
    }
  }
  updateTotal() {
    const form = this.panel.querySelector(
      "form[data-form=create],form[data-form=settings]",
    );
    if (!form) return;
    const a = Number(form.elements.additionalHumans.value),
      b = Number(form.elements.bots.value),
      n = 1 + a + b,
      valid =
        Number.isInteger(a) &&
        Number.isInteger(b) &&
        a >= 0 &&
        b >= 0 &&
        a <= 5 &&
        b <= 5 &&
        n >= 2 &&
        n <= 6;
    document.querySelector("#total-preview").textContent = n;
    document.querySelector("#count-error").hidden = valid;
    form.querySelector("button[type=submit],button.primary").disabled =
      !valid || this.store.status !== "connected" || Boolean(this.store.pending);
  }
  async submit(event) {
    event.preventDefault();
    const form = event.target,
      data = new FormData(form),
      type = form.dataset.form;
    try {
      if (type === "rename") {
        await this.transport.rename(String(data.get("displayName")).trim());
        this.toast(S.saved);
      } else if (type === "create" || type === "settings") {
        const payload = {
          name: String(data.get("name")).trim(),
          visibility: data.get("visibility"),
          additionalHumans: Number(data.get("additionalHumans")),
          bots: Number(data.get("bots")),
        };
        const n = 1 + payload.additionalHumans + payload.bots;
        if (n < 2 || n > 6) throw new Error(S.invalidCounts);
        this.editing = false;
        this.transport.send(
          type === "create" ? "CREATE_ROOM" : "UPDATE_ROOM",
          payload,
        );
      } else if (type === "join") {
        const code = String(data.get("code"));
        if (!/^\d{6}$/.test(code)) throw new Error(S.invalidCode);
        this.transport.send("JOIN_PRIVATE_ROOM", { code });
      }
    } catch (error) {
      this.store.error = error.message;
      this.store.emit();
    }
  }
  async action(action, el) {
    const s = this.store,
      t = this.transport;
    const commands = {
      draw: "DRAW_CARD",
      pass: "PASS_PACKET",
      reveal: "REVEAL_PACKET_TOP",
      start: "START_MATCH",
      reclaim: "RECLAIM_CONTROL",
      rematch: "RETURN_TO_LOBBY",
    };
    if (commands[action]) return t.send(commands[action]);
    if (["home", "create", "join", "browse"].includes(action)) {
      s.screen = action;
      s.error = "";
      if (action === "browse" || action === "home") t.read("LIST_PUBLIC_ROOMS");
      s.emit();
    } else if (action === "rules") document.querySelector("#rules-dialog").showModal();
    else if (action === "refresh") t.read("LIST_PUBLIC_ROOMS");
    else if (action === "reconnect") {
      t.start();
    } else if (action === "resume") t.start();
    else if (action === "join-public")
      t.send("JOIN_PUBLIC_ROOM", { roomId: el.dataset.roomId });
    else if (action === "ready")
      t.send("SET_READY", {
        ready: !s.view.players.find((p) => p.playerId === s.view.self.playerId)
          ?.ready,
      });
    else if (action === "settings") {
      this.editing = true;
      this.render();
    } else if (action === "cancel-settings") {
      this.editing = false;
      this.render();
    } else if (action === "copy-code") {
      try {
        await navigator.clipboard.writeText(s.view.room.code);
        this.toast(S.codeCopied);
      } catch {
        this.toast(`${S.copyFailed} ${s.view.room.code}`);
      }
    } else if (action === "leave") {
      if (
        s.view.room.status === "LOBBY" ||
        s.view.game?.winnerPlayerId ||
        s.view.game?.terminalReason
      )
        t.send("LEAVE_ROOM");
      else {
        this.leaving = true;
        this.render();
      }
    } else if (action === "confirm-leave") {
      this.leaving = false;
      t.send("LEAVE_ROOM");
    } else if (action === "cancel-leave") {
      this.leaving = false;
      this.render();
    } else if (action === "select-card" || action === "remove-card") {
      const handle = el.dataset.handle;
      s.toggle(handle);
    } else if (action === "move-up" || action === "move-down") {
      const handle = el.dataset.handle;
      s.move(handle, action === "move-up" ? -1 : 1);
    } else if (action === "clear-pile") {
      s.draft = [];
      s.emit();
    } else if (action === "send")
      t.send("SEND_PACKET", { orderedHandCardHandles: [...s.draft] });
    else if (action === "take")
      t.send("TAKE_RANDOM_CARD", { targetPlayerId: el.dataset.playerId });
  }
}
