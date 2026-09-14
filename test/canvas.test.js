import test from "node:test";
import assert from "node:assert/strict";
import {
  canActivateTarget,
  getCanvasLayout,
  hitTarget,
  pageItems,
} from "../public/games/keep/canvas-layout.js";
import { ViewStore } from "../public/games/keep/store.js";
import { commandFor } from "../public/games/keep/commands.js";
import { getTableState } from "../public/games/keep/table-view.js";
import { S } from "../public/games/keep/strings.js";
import { applyGameplay, assertInvariants, startMatch } from "../server/game.js";
import { projectRoom } from "../server/projector.js";

let serial = 0;
const context = () => ({ now: 1_000, rng: { int: () => 0 }, id: () => `canvas-${++serial}` });

function fixture() {
  const room = {
    roomId: "canvas-room",
    roomName: "Canvas table",
    stateVersion: 1,
    visibility: "PUBLIC",
    hostPlayerId: "A",
    configuredAdditionalHumans: 2,
    configuredBots: 0,
    status: "LOBBY",
    seats: ["A", "B", "C"].map((playerId, seatIndex) => ({
      playerId,
      seatIndex,
      displayName: `Dragon ${playerId}`,
      kind: "HUMAN",
      controllerMode: "HUMAN",
      connected: true,
      ready: true,
      disconnectedAt: null,
      controlGeneration: 0,
    })),
    match: null,
    recentPublicLog: [],
    lastActivityAt: 1_000,
    noHumansSince: null,
  };
  startMatch(room, context());
  const match = room.match;
  // All 18 cards can collect in one hand; the canvas must keep every one reachable.
  const cards = Object.keys(match.cardsByInternalId);
  match.drawPile = [];
  for (const playerId of match.seatOrder) {
    match.handsByPlayer[playerId] = playerId === "A" ? [...cards] : [];
    match.handHandlesByPlayer[playerId] = playerId === "A"
      ? Object.fromEntries(cards.map((id, index) => [`own-${index + 1}`, id]))
      : {};
  }
  match.activePlayerId = "A";
  match.decision = { decisionId: "sender-decision", playerId: "A", kind: "ACTIVE_CHOICE", deadlineAt: 61_000 };
  assertInvariants(room);
  const store = new ViewStore();
  store.status = "connected";
  store.snapshot(projectRoom(room, "A", 1_000));
  return { room, store };
}

const target = (action, dataset = {}) => ({ action, dataset });
const handles = (items) => items.map((card) => card.handle);
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const viewports = [
  [280, 800], [320, 568], [390, 844], [768, 1024],
  [900, 800], [1280, 800], [1440, 900], [844, 390], [568, 320],
];
const panelNames = ["hand", "tray", "log", "menu"];

test("every visible gameplay panel fits the exact viewport without overlap in every panel state", () => {
  for (const [width, height] of viewports) {
    for (const actionCount of [0, 1, 2, 5]) {
      for (const showTray of [false, true]) {
        for (const activePanel of [null, ...panelNames]) {
          const layout = getCanvasLayout(width, actionCount, showTray, height, activePanel);
          const scenario = `${width}x${height}, ${actionCount} actions, sender ${showTray}, panel ${activePanel}`;
          assert.equal(layout.width, width, `canvas width stays at the viewport width: ${scenario}`);
          assert.equal(layout.height, height, `canvas height stays at the viewport height: ${scenario}`);
          const expectedPanel = activePanel === "tray" && !showTray ? "hand" : activePanel;
          assert.equal(layout.activePanel, expectedPanel, `unavailable sender tray falls back to the hand: ${scenario}`);
          assert.deepEqual(panelNames.filter((name) => layout[name]), expectedPanel ? [expectedPanel] : [],
            `only the selected dock panel is visible: ${scenario}`);
          for (const name of ["header", "decision", "footer"])
            assert.ok(layout[name], `${name} stays available: ${scenario}`);
          assert.equal(Boolean(layout.board), !(height < 620 && expectedPanel),
            `short viewports replace the board only while a dock panel is open: ${scenario}`);
          const panels = ["header", "board", "decision", ...panelNames, "footer"]
            .filter((name) => layout[name])
            .map((name) => ({ name, ...layout[name] }));
          for (const panel of panels) {
            assert.ok([panel.x, panel.y, panel.w, panel.h].every(Number.isFinite),
              `${panel.name} has finite geometry: ${scenario}`);
            assert.ok(panel.w > 0 && panel.h > 0, `${panel.name} has positive size: ${scenario}`);
            assert.ok(panel.x >= 0 && panel.y >= 0 && panel.x + panel.w <= width && panel.y + panel.h <= height,
              `${panel.name} fits inside the viewport: ${scenario}`);
          }
          for (let i = 0; i < panels.length; i++)
            for (const other of panels.slice(i + 1))
              assert.equal(overlaps(panels[i], other), false, `${panels[i].name} overlaps ${other.name}: ${scenario}`);
        }
      }
    }
  }
});

test("all 18 hand cards and selected pile entries remain reachable in every viewport and panel state", () => {
  const { store } = fixture();
  const hand = store.view.self.hand;
  for (const [width, height] of viewports) {
    for (const showTray of [false, true]) {
      for (const activePanel of [null, ...panelNames]) {
        const layout = getCanvasLayout(width, 2, showTray, height, activePanel);
        const scenario = `${width}x${height}, sender ${showTray}, panel ${activePanel}`;
        for (const name of ["handSize", "traySize"]) {
          const size = layout[name];
          assert.ok(Number.isInteger(size) && size > 0, `${name} supports at least one card: ${scenario}`);
          const first = pageItems(hand, 0, size);
          assert.equal(first.pages, Math.ceil(hand.length / size), `page count exposes the complete hand: ${scenario}`);
          const visited = [];
          for (let page = 0; page < first.pages; page++) {
            const result = pageItems(hand, page, size);
            assert.equal(result.page, page);
            assert.ok(result.items.length > 0 && result.items.length <= size);
            visited.push(...handles(result.items));
          }
          assert.deepEqual(visited, handles(hand), `${name}: 18 cards are reachable exactly once: ${scenario}`);
          assert.equal(new Set(visited).size, 18);
        }
      }
    }
  }
  const compactTray = getCanvasLayout(568, 2, true, 320, "tray");
  const tallTray = getCanvasLayout(568, 2, true, 800, "tray");
  assert.ok(compactTray.traySize < tallTray.traySize, "landscape coverage exercises a smaller tray page");
  assert.ok(pageItems(hand, 0, compactTray.traySize).pages > 1, "the compact tray requires pagination");
});

test("page navigation clamps safely when a hand shrinks or becomes empty", () => {
  const { store } = fixture();
  const hand = store.view.self.hand;
  assert.deepEqual(pageItems(hand, -1, 4), pageItems(hand, 0, 4));
  assert.deepEqual(pageItems(hand, 999, 4), pageItems(hand, 4, 4));
  assert.deepEqual(pageItems(hand.slice(0, 3), 4, 4), {
    items: hand.slice(0, 3), page: 0, pages: 1, start: 0,
  });
  assert.deepEqual(pageItems([], 4, 4), { items: [], page: 0, pages: 1, start: 0 });
});

test("selection survives hand pages and the reordered 18-card pile is accepted in exactly that order", () => {
  const { room, store } = fixture();
  const hand = store.view.self.hand;
  const size = getCanvasLayout(280, 0, true).handSize;
  const pages = pageItems(hand, 0, size).pages;
  for (let page = 0; page < pages; page++) {
    for (const card of pageItems(hand, page, size).items) {
      assert.equal(canActivateTarget(target("select-card", { handle: card.handle }), store), true);
      store.toggle(card.handle);
    }
  }
  assert.deepEqual(store.draft, handles(hand));
  const lastHandle = hand.at(-1).handle;
  for (let i = 1; i < hand.length; i++) {
    assert.equal(canActivateTarget(target("move-up", { handle: lastHandle }), store), true);
    store.move(lastHandle, -1);
  }
  const expectedHandles = [lastHandle, ...handles(hand).slice(0, -1)];
  assert.deepEqual(store.draft, expectedHandles);
  assert.equal(canActivateTarget(target("send"), store), true);
  const command = commandFor(store, "SEND_PACKET", { orderedHandCardHandles: [...store.draft] });
  const expectedIds = expectedHandles.map((handle) => room.match.handHandlesByPlayer.A[handle]);
  applyGameplay(room, "A", command.type, command.payload, context());
  assert.deepEqual(room.match.packet.orderedCardIds, expectedIds);
  assert.equal(room.match.packet.recipientPlayerId, "B");
  assert.equal(room.match.handsByPlayer.A.length, 0);
  assertInvariants(room);
});

test("sender controls reject empty drafts, expired handles, and pile endpoints", () => {
  const { store } = fixture();
  const [first, second, unselected] = handles(store.view.self.hand);
  assert.equal(canActivateTarget(target("send"), store), false);
  assert.equal(canActivateTarget(target("clear-pile"), store), false);
  store.toggle(first);
  store.toggle(second);
  assert.equal(canActivateTarget(target("move-up", { handle: first }), store), false);
  assert.equal(canActivateTarget(target("move-down", { handle: second }), store), false);
  assert.equal(canActivateTarget(target("move-down", { handle: first }), store), true);
  assert.equal(canActivateTarget(target("move-up", { handle: second }), store), true);
  assert.equal(canActivateTarget(target("remove-card", { handle: unselected }), store), false);
  assert.equal(canActivateTarget(target("clear-pile"), store), true);
  for (const action of ["select-card", "remove-card", "move-up", "move-down"])
    assert.equal(canActivateTarget(target(action, { handle: "expired-handle" }), store), false);
  store.draft.push("expired-handle");
  assert.equal(canActivateTarget(target("send"), store), false);
});

test("snapshots preserve valid ordered selections and discard them when the decision changes", () => {
  const { store } = fixture();
  const [first, second, third] = handles(store.view.self.hand);
  store.toggle(third);
  store.toggle(first);
  store.toggle(second);
  const sameDecision = structuredClone(store.view);
  sameDecision.stateVersion++;
  sameDecision.self.hand = sameDecision.self.hand.filter((card) => card.handle !== first);
  store.snapshot(sameDecision);
  assert.deepEqual(store.draft, [third, second]);
  const nextDecision = structuredClone(sameDecision);
  nextDecision.game.decision.decisionId = "replacement-decision";
  store.snapshot(nextDecision);
  assert.deepEqual(store.draft, []);
  assert.equal(canActivateTarget(target("send"), store), false);
});

test("stale gameplay targets cannot activate while pending, disconnected, or controlled by a bot", () => {
  const { store } = fixture();
  const [handle, second] = handles(store.view.self.hand);
  store.toggle(handle);
  store.toggle(second);
  store.view.allowedCommands = {
    types: ["DRAW_CARD", "SEND_PACKET", "PASS_PACKET", "REVEAL_PACKET_TOP", "TAKE_RANDOM_CARD", "RECLAIM_CONTROL"],
    legalTakeTargetPlayerIds: ["B"],
  };
  const staleTargets = [
    target("draw"), target("send"), target("pass"), target("reveal"), target("take", { playerId: "B" }),
    target("select-card", { handle }), target("remove-card", { handle }), target("clear-pile"),
    target("move-down", { handle }), target("move-up", { handle: second }),
  ];
  for (const item of staleTargets) {
    assert.equal(canActivateTarget(item, store), true, `${item.action} begins enabled`);
    assert.equal(canActivateTarget({ ...item, disabled: true }, store), false, `${item.action} respects disabled state`);
  }
  const assertBlocked = (reason) => {
    for (const item of staleTargets)
      assert.equal(canActivateTarget(item, store), false, `${item.action} blocked while ${reason}`);
  };
  for (const status of ["connecting", "reconnecting", "offline", "control_moved"]) {
    store.status = status;
    assertBlocked(status);
  }
  store.status = "connected";
  store.pending = { commandId: "unacknowledged-command" };
  assertBlocked("pending");
  store.pending = null;
  store.view.self.controllerMode = "TEMP_BOT";
  assertBlocked("TEMP_BOT");
  assert.equal(canActivateTarget(target("reclaim"), store), true);
  store.view.self.controllerMode = "HUMAN";
  assert.equal(canActivateTarget(target("send"), store), true);
  store.screen = "home";
  assertBlocked("outside the table");
});

test("random taking exposes exactly the server's tied legal donors", () => {
  const { store } = fixture();
  store.view.self.hand = [];
  store.view.players[0].handCount = 0;
  store.view.players[1].handCount = 8;
  store.view.players[2].handCount = 8;
  store.view.players.push({ playerId: "D", displayName: "Smaller hand", seatIndex: 3, handCount: 2 });
  store.view.allowedCommands = { types: ["TAKE_RANDOM_CARD", "LEAVE_ROOM"], legalTakeTargetPlayerIds: ["B", "C"] };
  const actions = getTableState(store).actions;
  assert.deepEqual(actions.map((item) => item.dataset.playerId), ["B", "C"]);
  for (const item of actions) assert.equal(canActivateTarget(item, store), true);
  for (const playerId of ["A", "D", "unknown"])
    assert.equal(canActivateTarget(target("take", { playerId }), store), false);
  store.view.allowedCommands.legalTakeTargetPlayerIds = ["C"];
  assert.equal(canActivateTarget(actions[0], store), false, "a previously legal donor is rechecked on activation");
});

test("a recipient receives pass/reveal controls and stale sender targets stop working", () => {
  const { room, store } = fixture();
  const handle = store.view.self.hand[0].handle;
  applyGameplay(room, "A", "SEND_PACKET", { orderedHandCardHandles: [handle] }, context());
  store.snapshot(projectRoom(room, "B", 1_000));
  const state = getTableState(store);
  assert.equal(state.receiver, true);
  assert.equal(state.title, S.receivePrompt);
  assert.deepEqual(state.actions.map((item) => item.action), ["pass", "reveal"]);
  for (const item of state.actions) assert.equal(canActivateTarget(item, store), true);
  for (const item of [target("draw"), target("send"), target("select-card", { handle })])
    assert.equal(canActivateTarget(item, store), false);
  assert.deepEqual(store.view.game.packet, { originPlayerId: "A", recipientPlayerId: "B", count: 1 });
});

test("the next dragon follows seat order even when player data arrives unsorted", () => {
  const { store } = fixture();
  store.view.players.reverse();
  assert.equal(getTableState(store).neighbor.playerId, "B");
  store.view.self.playerId = "C";
  assert.equal(getTableState(store).neighbor.playerId, "A");
});

test("leave confirmation blocks every background target until cancelled", () => {
  const { store } = fixture();
  const handle = store.view.self.hand[0].handle;
  store.toggle(handle);
  for (const item of [target("send"), target("select-card", { handle }), target("hand-next"), target("rules"), target("leave")])
    assert.equal(canActivateTarget(item, store, true), false);
  const state = getTableState(store, true);
  assert.deepEqual(state.actions.map((item) => item.action), ["confirm-leave", "cancel-leave"]);
  for (const item of state.actions) assert.equal(canActivateTarget(item, store, true), true);
  store.status = "offline";
  assert.equal(canActivateTarget(state.actions[0], store, true), false);
  assert.equal(canActivateTarget(state.actions[1], store, true), true, "cancelling remains local while offline");
  store.status = "connected";
  assert.equal(canActivateTarget(target("send"), store, false), true);
});

test("finished and quarantined tables tolerate null decisions and empty hands", () => {
  const { store } = fixture();
  store.view.room.status = "FINISHED";
  store.view.game.decision = null;
  store.view.game.winnerPlayerId = "A";
  store.view.allowedCommands.types = ["RETURN_TO_LOBBY", "LEAVE_ROOM"];
  assert.equal(getTableState(store).title, S.victory);
  assert.deepEqual(getTableState(store).actions.map((item) => item.action), ["rematch"]);
  store.view.room.status = "ERROR";
  store.view.self.hand = [];
  store.view.game = { phase: "TERMINAL", decision: null, packet: null, terminalReason: "INTERNAL_ERROR", winnerPlayerId: null };
  store.view.allowedCommands.types = ["LEAVE_ROOM"];
  const state = getTableState(store);
  assert.equal(state.ended, true);
  assert.equal(state.title, S.roomErrorTitle);
  assert.deepEqual(state.actions, []);
  assert.equal(canActivateTarget(target("leave"), store), true);
});

test("hit testing respects canvas coordinates, boundaries, and the topmost painted target", () => {
  const background = { ...target("draw"), x: 100, y: 200, w: 80, h: 120 };
  const foreground = { ...target("confirm-leave"), x: 120, y: 220, w: 40, h: 60 };
  assert.equal(hitTarget([background, foreground], 140, 250), foreground);
  assert.equal(hitTarget([background, foreground], 100, 200), background);
  assert.equal(hitTarget([background, foreground], 180, 320), background);
  assert.equal(hitTarget([background, foreground], 99, 250), undefined);
  assert.equal(hitTarget([], 140, 250), undefined);
});
