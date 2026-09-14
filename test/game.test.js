import test from "node:test";
import assert from "node:assert/strict";
import {
  applyGameplay,
  assertInvariants,
  legalGameplay,
  replaceDecision,
  startMatch,
} from "../server/game.js";
import { projectEffects, projectRoom } from "../server/projector.js";
import {
  botThinkingDelay,
  chooseBotCommand,
  fallbackBotCommand,
} from "../server/bot.js";

let serial = 0;
const ctx = (now = 1_000, int = () => 0) => ({
  now,
  rng: { int },
  id: () => `opaque-${++serial}`,
});

function roomFor(count = 3, bots = false) {
  return {
    roomId: "room-test",
    stateVersion: 0,
    visibility: "PRIVATE",
    privateCode: "001234",
    hostPlayerId: "A",
    configuredAdditionalHumans: bots ? 0 : count - 1,
    configuredBots: bots ? count - 1 : 0,
    roomName: "Test keep",
    status: "LOBBY",
    seats: Array.from({ length: count }, (_, seatIndex) => ({
      playerId: String.fromCharCode(65 + seatIndex),
      seatIndex,
      kind: bots && seatIndex > 0 ? "BOT" : "HUMAN",
      displayName: `Dragon ${seatIndex}`,
      connected: true,
      ready: true,
      controllerMode: bots && seatIndex > 0 ? "BOT" : "HUMAN",
      disconnectedAt: null,
      controlGeneration: 0,
    })),
    match: null,
    recentPublicLog: [],
    lastActivityAt: 1_000,
    noHumansSince: null,
  };
}

function started(count = 3, bots = false) {
  const room = roomFor(count, bots);
  startMatch(room, ctx());
  return room;
}

const expanded = { T: "TREASURE", A: "ADVENTURER", G: "GOBLIN" };
function arrange(
  room,
  {
    hands = {},
    lairs = {},
    packet = null,
    active = "A",
    remainderTo = null,
  } = {},
) {
  const match = room.match;
  const unused = Object.keys(match.cardsByInternalId);
  const pick = (type) => {
    const index = unused.findIndex(
      (id) => match.cardsByInternalId[id].type === (expanded[type] ?? type),
    );
    assert.notEqual(index, -1, `Fixture has enough ${type}`);
    return unused.splice(index, 1)[0];
  };
  for (const id of match.seatOrder) {
    match.handsByPlayer[id] = (hands[id] ?? []).map(pick);
    match.handHandlesByPlayer[id] = {};
    match.lairsByPlayer[id] = {
      treasures: (lairs[id]?.treasures ?? []).map(pick),
      goblins: (lairs[id]?.goblins ?? []).map(pick),
    };
  }
  match.packet = packet
    ? {
        originPlayerId: packet.origin ?? active,
        recipientPlayerId: packet.recipient ?? "B",
        orderedCardIds: packet.cards.map(pick),
      }
    : null;
  if (remainderTo) {
    match.handsByPlayer[remainderTo].push(...unused);
    match.drawPile = [];
  } else match.drawPile = unused;
  for (const id of match.seatOrder)
    for (const cardId of match.handsByPlayer[id])
      match.handHandlesByPlayer[id][`handle-${++serial}`] = cardId;
  match.activePlayerId = active;
  match.phase = packet ? "PACKET_CHOICE" : "ACTIVE_CHOICE";
  match.decision = {
    decisionId: `decision-${++serial}`,
    playerId: packet ? match.packet.recipientPlayerId : active,
    kind: match.phase,
    deadlineAt: 61_000,
  };
  match.effects = [];
  room.recentPublicLog = [];
  assertInvariants(room);
  return room;
}

function handles(room, playerId = "A") {
  return projectRoom(room, playerId, 1_000).self.hand.map(
    (card) => card.handle,
  );
}
function typesOf(room, ids) {
  return ids.map((id) => room.match.cardsByInternalId[id].type);
}
function act(room, playerId, type, payload = {}, context = ctx()) {
  applyGameplay(room, playerId, type, payload, context);
  room.stateVersion += 1;
  assertInvariants(room);
}
function rejectsUnchanged(
  room,
  playerId,
  type,
  payload,
  code,
  context = ctx(),
) {
  const before = structuredClone(room);
  assert.throws(() => applyGameplay(room, playerId, type, payload, context), {
    code,
  });
  assert.deepEqual(room, before);
}

for (let count = 2; count <= 6; count += 1) {
  test(`${count} seats deal exactly three, conserve 9/5/4, and use unbiased shuffle bounds`, () => {
    const room = roomFor(count);
    const bounds = [];
    startMatch(
      room,
      ctx(1_000, (max) => {
        bounds.push(max);
        return max - 1;
      }),
    );
    assert.equal(room.match.drawPile.length, 18 - 3 * count);
    for (const playerId of room.match.seatOrder)
      assert.equal(room.match.handsByPlayer[playerId].length, 3);
    assert.deepEqual(bounds, [
      ...Array.from({ length: 17 }, (_, index) => 18 - index),
      count,
    ]);
    assert.equal(room.match.activePlayerId, String.fromCharCode(64 + count));
    assert.equal(room.match.decision.deadlineAt, 61_000);
    assertInvariants(room);
  });
}

test("start rejects incomplete or unready human seats without changing the lobby", () => {
  const room = roomFor();
  room.seats[1].ready = false;
  const before = structuredClone(room);
  assert.throws(() => startMatch(room, ctx()), { code: "NOT_READY" });
  assert.deepEqual(room, before);
  room.seats.pop();
  assert.throws(() => startMatch(room, ctx()), { code: "NOT_READY" });
});

test("draw adds only a private card, advances once, and publishes only an identity-free draw", () => {
  const room = started();
  const beforeHand = handles(room);
  const top = room.match.drawPile[0];
  act(room, "A", "DRAW_CARD");
  assert.equal(room.match.activePlayerId, "B");
  assert.equal(room.match.turnNumber, 2);
  assert.equal(room.match.handsByPlayer.A.at(-1), top);
  assert.deepEqual(handles(room).slice(0, -1), beforeHand);
  assert.deepEqual(room.match.effects[0], {
    type: "PlayerDrewCard",
    roomVersion: 1,
    effectIndex: 0,
    playerId: "A",
  });
  for (const viewer of ["A", "B", "C"]) {
    const view = projectRoom(room, viewer, 1_000);
    assert.equal(view.self.hand.length, viewer === "A" ? 4 : 3);
    const wire = JSON.stringify(view);
    for (const id of Object.keys(room.match.cardsByInternalId))
      assert.equal(wire.includes(`"${id}"`), false);
    assert.deepEqual(Object.keys(view.players[0]), [
      "playerId",
      "displayName",
      "seatIndex",
      "kind",
      "connected",
      "ready",
      "controllerMode",
      "handCount",
      "visibleTreasureCount",
      "visibleGoblinCount",
    ]);
  }
});

test("send rejects empty, duplicate, foreign, guessed, expired and malformed handles without mutation", () => {
  const room = arrange(started(), { hands: { A: ["T", "G"], B: ["A"] } });
  const [first] = handles(room);
  for (const invalid of [
    [],
    [first, first],
    handles(room, "B"),
    ["unknown"],
    [1],
    Array(19).fill(first),
  ]) {
    rejectsUnchanged(
      room,
      "A",
      "SEND_PACKET",
      { orderedHandCardHandles: invalid },
      "INVALID_SELECTION",
    );
  }
  rejectsUnchanged(
    room,
    "A",
    "SEND_PACKET",
    { orderedHandCardHandles: [first], extra: true },
    "INVALID_MESSAGE",
  );
  rejectsUnchanged(
    room,
    "B",
    "SEND_PACKET",
    { orderedHandCardHandles: handles(room, "B") },
    "NOT_YOUR_DECISION",
  );
  act(room, "A", "SEND_PACKET", { orderedHandCardHandles: [first] });
  assert.equal(Object.hasOwn(room.match.handHandlesByPlayer.A, first), false);
  rejectsUnchanged(
    room,
    "A",
    "SEND_PACKET",
    { orderedHandCardHandles: [first] },
    "NOT_YOUR_DECISION",
  );
});

test("worked example preserves order, reveals for C and forced origin A, then collects inert adventurer", () => {
  const room = arrange(started(), { hands: { A: ["T", "G", "A"] } });
  const originalHandles = handles(room);
  act(room, "A", "SEND_PACKET", { orderedHandCardHandles: originalHandles });
  assert.deepEqual(typesOf(room, room.match.packet.orderedCardIds), [
    "TREASURE",
    "GOBLIN",
    "ADVENTURER",
  ]);
  assert.deepEqual(projectRoom(room, "A", 1_000).game.packet, {
    originPlayerId: "A",
    recipientPlayerId: "B",
    count: 3,
  });
  act(room, "B", "PASS_PACKET");
  assert.equal(room.match.activePlayerId, "A");
  assert.equal(room.match.decision.playerId, "C");
  assert.deepEqual(typesOf(room, room.match.packet.orderedCardIds), [
    "TREASURE",
    "GOBLIN",
    "ADVENTURER",
  ]);
  act(room, "C", "REVEAL_PACKET_TOP");
  assert.equal(room.match.lairsByPlayer.C.treasures.length, 1);
  assert.equal(room.match.lairsByPlayer.A.goblins.length, 1);
  assert.deepEqual(typesOf(room, room.match.handsByPlayer.A), ["ADVENTURER"]);
  assert.equal(room.match.packet, null);
  assert.equal(room.match.activePlayerId, "B");
  assert.equal(room.match.decision.playerId, "B");
  assert.equal(room.match.turnNumber, 2);
  assert.ok(handles(room).every((handle) => !originalHandles.includes(handle)));
  assert.deepEqual(
    room.match.effects.map((effect) => effect.type),
    ["CardRevealed", "CardRevealed", "PacketCollected", "TurnStarted"],
  );
  assert.deepEqual(
    room.match.effects.map((effect) => effect.effectIndex),
    [0, 1, 2, 3],
  );
});

for (const card of ["T", "G"]) {
  test(`revealing ${card} gives its face-up effect to the recipient and automatically routes once`, () => {
    const room = arrange(started(4), {
      packet: { cards: [card, "A"], recipient: "B" },
    });
    act(room, "B", "REVEAL_PACKET_TOP");
    assert.equal(
      room.match.lairsByPlayer.B[card === "T" ? "treasures" : "goblins"].length,
      1,
    );
    assert.equal(room.match.decision.playerId, "C");
    assert.equal(room.match.packet.orderedCardIds.length, 1);
    assert.equal(room.match.activePlayerId, "A");
    rejectsUnchanged(room, "B", "REVEAL_PACKET_TOP", {}, "NOT_YOUR_DECISION");
  });
}

for (const config of [
  {
    title: "unprotected treasures",
    treasures: ["T", "T"],
    goblins: [],
    hand: ["ADVENTURER", "TREASURE", "TREASURE"],
    remainingTreasures: 0,
  },
  {
    title: "all protecting goblins",
    treasures: ["T", "T"],
    goblins: ["G", "G"],
    hand: ["ADVENTURER", "GOBLIN", "GOBLIN"],
    remainingTreasures: 2,
  },
  {
    title: "empty lair",
    treasures: [],
    goblins: [],
    hand: ["ADVENTURER"],
    remainingTreasures: 0,
  },
]) {
  test(`adventurer resolves ${config.title} atomically`, () => {
    const room = arrange(started(), {
      lairs: { B: { treasures: config.treasures, goblins: config.goblins } },
      packet: { cards: ["A", "T"] },
    });
    act(room, "B", "REVEAL_PACKET_TOP");
    assert.deepEqual(typesOf(room, room.match.handsByPlayer.B), config.hand);
    assert.equal(
      room.match.lairsByPlayer.B.treasures.length,
      config.remainingTreasures,
    );
    assert.equal(room.match.lairsByPlayer.B.goblins.length, 0);
    assert.equal(room.match.decision.playerId, "C");
    assert.equal(handles(room, "B").length, config.hand.length);
    assert.equal(room.match.effects[1].type, "LairCardsReturned");
    assert.equal(room.match.effects[1].goblinCount, config.goblins.length);
  });
}

test("emptying a packet advances from origin even when C reveals the last card", () => {
  const room = arrange(started(4), {
    packet: { cards: ["G"], recipient: "C" },
  });
  act(room, "C", "REVEAL_PACKET_TOP");
  assert.equal(room.match.activePlayerId, "B");
  assert.equal(room.match.packet, null);
  assert.equal(room.match.lairsByPlayer.C.goblins.length, 1);
});

for (const cards of [["T"], ["G", "A", "T", "T", "G"]]) {
  test(`two-player origin must reveal exactly one of ${cards.length} returned cards and collect the rest`, () => {
    const room = arrange(started(2), { hands: { A: cards } });
    const oldHandles = handles(room);
    act(room, "A", "SEND_PACKET", { orderedHandCardHandles: oldHandles });
    act(room, "B", "PASS_PACKET");
    assert.equal(
      room.match.lairsByPlayer.A.treasures.length +
        room.match.lairsByPlayer.A.goblins.length,
      1,
    );
    assert.deepEqual(
      typesOf(room, room.match.handsByPlayer.A),
      cards.slice(1).map((type) => expanded[type]),
    );
    assert.ok(handles(room).every((handle) => !oldHandles.includes(handle)));
    assert.equal(room.match.packet, null);
    assert.equal(room.match.activePlayerId, "B");
    assert.equal(
      room.match.effects.filter((effect) => effect.type === "CardRevealed")
        .length,
      1,
    );
  });
}

test("expired handles remain invalid when a returned card reenters its former owner hand", () => {
  const room = arrange(started(2), { hands: { A: ["G", "A"] } });
  const oldHandles = handles(room);
  act(room, "A", "SEND_PACKET", { orderedHandCardHandles: oldHandles });
  act(room, "B", "PASS_PACKET");
  act(room, "B", "DRAW_CARD");
  rejectsUnchanged(
    room,
    "A",
    "SEND_PACKET",
    { orderedHandCardHandles: [oldHandles[1]] },
    "INVALID_SELECTION",
  );
  assert.equal(projectRoom(room, "A", 1_000).self.hand[0].type, "ADVENTURER");
});

test("a card revealed into its owner lair gets a fresh private handle after an adventurer returns it", () => {
  const room = arrange(started(2), { hands: { A: ["G", "A"] } });
  const [oldGoblin, oldAdventurer] = handles(room);
  act(room, "A", "SEND_PACKET", { orderedHandCardHandles: [oldGoblin] });
  act(room, "B", "PASS_PACKET");
  assert.equal(room.match.lairsByPlayer.A.goblins.length, 1);
  assert.deepEqual(handles(room), [oldAdventurer]);
  act(room, "B", "DRAW_CARD");
  act(room, "A", "SEND_PACKET", { orderedHandCardHandles: [oldAdventurer] });
  act(room, "B", "PASS_PACKET");
  assert.equal(room.match.lairsByPlayer.A.goblins.length, 0);
  assert.deepEqual(
    projectRoom(room, "A", 1_000).self.hand.map((card) => card.type),
    ["ADVENTURER", "GOBLIN"],
  );
  assert.ok(
    handles(room).every(
      (handle) => handle !== oldGoblin && handle !== oldAdventurer,
    ),
  );
  const otherWire = JSON.stringify(projectRoom(room, "B", 1_000));
  for (const handle of [...handles(room), oldGoblin, oldAdventurer])
    assert.equal(otherWire.includes(handle), false);
  act(room, "B", "DRAW_CARD");
  rejectsUnchanged(
    room,
    "A",
    "SEND_PACKET",
    { orderedHandCardHandles: [oldGoblin] },
    "INVALID_SELECTION",
  );
});

test("explicitly reordered selected subset becomes packet order and untouched own handles remain stable", () => {
  const room = arrange(started(), { hands: { A: ["T", "G", "A", "T"] } });
  const initial = handles(room);
  act(room, "A", "SEND_PACKET", {
    orderedHandCardHandles: [initial[2], initial[0], initial[1]],
  });
  assert.deepEqual(typesOf(room, room.match.packet.orderedCardIds), [
    "ADVENTURER",
    "TREASURE",
    "GOBLIN",
  ]);
  assert.deepEqual(handles(room), [initial[3]]);
  act(room, "B", "PASS_PACKET");
  assert.deepEqual(typesOf(room, room.match.packet.orderedCardIds), [
    "ADVENTURER",
    "TREASURE",
    "GOBLIN",
  ]);
});

test("take requires both an empty draw pile and empty active hand", () => {
  const room = arrange(started(), { hands: { B: ["T"] } });
  rejectsUnchanged(
    room,
    "A",
    "TAKE_RANDOM_CARD",
    { targetPlayerId: "B" },
    "ILLEGAL_ACTION",
  );
  arrange(room, { hands: { A: ["A"], B: ["T"] }, remainderTo: "B" });
  rejectsUnchanged(
    room,
    "A",
    "TAKE_RANDOM_CARD",
    { targetPlayerId: "B" },
    "ILLEGAL_ACTION",
  );
});

test("take targets exactly tied largest donors and uniformly samples privately with fresh ownership handles", () => {
  const room = arrange(started(), {
    hands: { B: ["T", "T", "T", "T", "T", "A", "A", "G", "G"] },
    remainderTo: "C",
  });
  assert.deepEqual(legalGameplay(room, "A", 1_000), {
    types: ["TAKE_RANDOM_CARD"],
    legalTakeTargetPlayerIds: ["B", "C"],
  });
  rejectsUnchanged(
    room,
    "A",
    "TAKE_RANDOM_CARD",
    { targetPlayerId: "A" },
    "INVALID_TARGET",
  );
  rejectsUnchanged(
    room,
    "A",
    "TAKE_RANDOM_CARD",
    { targetPlayerId: "intruder" },
    "INVALID_TARGET",
  );
  const taken = room.match.handsByPlayer.B[8];
  const formerHandle = Object.entries(room.match.handHandlesByPlayer.B).find(
    ([, id]) => id === taken,
  )[0];
  const bounds = [];
  act(
    room,
    "A",
    "TAKE_RANDOM_CARD",
    { targetPlayerId: "B" },
    ctx(1_000, (max) => {
      bounds.push(max);
      return max - 1;
    }),
  );
  assert.deepEqual(bounds, [9]);
  assert.deepEqual(room.match.handsByPlayer.A, [taken]);
  assert.equal(room.match.handsByPlayer.B.length, 8);
  assert.equal(
    Object.hasOwn(room.match.handHandlesByPlayer.B, formerHandle),
    false,
  );
  assert.notEqual(handles(room)[0], formerHandle);
  assert.deepEqual(room.match.effects[0], {
    type: "RandomCardTaken",
    roomVersion: 1,
    effectIndex: 0,
    donorPlayerId: "B",
    recipientPlayerId: "A",
  });
  assert.equal(room.match.activePlayerId, "B");
  assert.equal(room.match.lairsByPlayer.A.goblins.length, 0);
});

test("a smaller hand cannot be selected as a random-card donor", () => {
  const room = arrange(started(), { hands: { B: ["T"] }, remainderTo: "C" });
  assert.deepEqual(legalGameplay(room, "A", 1_000).legalTakeTargetPlayerIds, [
    "C",
  ]);
  rejectsUnchanged(
    room,
    "A",
    "TAKE_RANDOM_CARD",
    { targetPlayerId: "B" },
    "INVALID_TARGET",
  );
});

for (const winner of ["B", "A"]) {
  for (const cards of [["T"], ["T", "G", "A"]]) {
    test(`${winner === "A" ? "forced origin" : "recipient"} third treasure wins immediately with ${cards.length - 1} hidden cards remaining`, () => {
      const room = arrange(started(2), {
        lairs: { [winner]: { treasures: ["T", "T"] } },
        packet: { cards },
      });
      const beforeActive = room.match.activePlayerId;
      act(room, "B", winner === "A" ? "PASS_PACKET" : "REVEAL_PACKET_TOP");
      assert.equal(room.status, "FINISHED");
      assert.equal(room.match.winnerPlayerId, winner);
      assert.equal(room.match.terminalReason, "WIN");
      assert.equal(room.match.phase, "TERMINAL");
      assert.equal(room.match.decision, null);
      assert.equal(room.match.activePlayerId, beforeActive);
      assert.equal(room.match.turnNumber, 1);
      assert.equal(room.match.packet.orderedCardIds.length, cards.length - 1);
      assert.equal(room.match.handsByPlayer.A.length, 0);
      assert.equal(room.match.effects.at(-1).type, "MatchWon");
      rejectsUnchanged(room, "B", "DRAW_CARD", {}, "MATCH_ENDED");
      assert.equal(replaceDecision(room, ctx(100_000)), false);
      const terminalView = projectRoom(room, "A", 1_000);
      assert.deepEqual(terminalView.allowedCommands.types, [
        "LEAVE_ROOM",
        "RETURN_TO_LOBBY",
      ]);
      assert.deepEqual(Object.keys(terminalView.game.packet), [
        "originPlayerId",
        "recipientPlayerId",
        "count",
      ]);
    });
  }
}

test("deadline is strict at execution boundary and replaces once with bot control without moving cards", () => {
  const room = started();
  const deadline = room.match.decision.deadlineAt;
  rejectsUnchanged(
    room,
    "A",
    "DRAW_CARD",
    {},
    "DEADLINE_EXPIRED",
    ctx(deadline),
  );
  const beforeZones = JSON.stringify([
    room.match.drawPile,
    room.match.handsByPlayer,
    room.match.lairsByPlayer,
  ]);
  const beforeId = room.match.decision.decisionId;
  assert.equal(replaceDecision(room, ctx(deadline - 1)), false);
  assert.equal(replaceDecision(room, ctx(deadline)), true);
  assert.notEqual(room.match.decision.decisionId, beforeId);
  assert.equal(room.match.decision.deadlineAt, deadline + 5_000);
  assert.equal(room.match.decision.playerId, "A");
  assert.equal(room.seats[0].controllerMode, "TEMP_BOT");
  assert.equal(room.seats[0].controlGeneration, 1);
  assert.equal(
    JSON.stringify([
      room.match.drawPile,
      room.match.handsByPlayer,
      room.match.lairsByPlayer,
    ]),
    beforeZones,
  );
  assert.equal(replaceDecision(room, ctx(deadline)), false);
  act(room, "A", "DRAW_CARD", {}, ctx(deadline + 1));
  assert.equal(room.match.activePlayerId, "B");
});

test("human decisions use phase timings, bot decisions use five seconds, and disconnect alone does not shorten one", () => {
  const room = started(3, true);
  act(room, "A", "SEND_PACKET", { orderedHandCardHandles: [handles(room)[0]] });
  assert.equal(room.match.decision.deadlineAt, 6_000);
  const humans = started();
  act(humans, "A", "SEND_PACKET", {
    orderedHandCardHandles: [handles(humans)[0]],
  });
  assert.equal(humans.match.decision.deadlineAt, 31_000);
  humans.seats[1].connected = false;
  assert.equal(humans.match.decision.deadlineAt, 31_000);
  assert.equal(humans.seats[1].controllerMode, "HUMAN");
});

test("view rejects nonmembers and never includes canonical state or stable card identities", () => {
  const room = started();
  assert.throws(() => projectRoom(room, "intruder", 1_000), {
    code: "NOT_A_MEMBER",
  });
  const view = projectRoom(room, "A", 1_000);
  assert.equal(view.room.code, "001234");
  assert.equal("cardsByInternalId" in view, false);
  assert.equal("handsByPlayer" in view, false);
  assert.equal("handHandlesByPlayer" in view, false);
  assert.equal("drawPile" in view.game, false);
  assert.equal("controlGeneration" in view.self, false);
  assert.equal("effects" in view, false);
  assert.equal("hand" in view.players[1], false);
  room.visibility = "PUBLIC";
  assert.equal("code" in projectRoom(room, "A", 1_000).room, false);
});

test("permuting hidden opponent, draw and packet cards preserves the viewer projection and legal metadata", () => {
  const room = arrange(started(4), {
    hands: { A: ["T"], B: ["G", "A"], C: ["T"] },
    packet: { origin: "A", recipient: "B", cards: ["A", "G", "T"] },
  });
  const before = projectRoom(room, "A", 1_000);
  const changed = structuredClone(room);
  const hidden = [
    ...changed.match.handsByPlayer.B,
    ...changed.match.handsByPlayer.C,
    ...changed.match.drawPile,
    ...changed.match.packet.orderedCardIds,
  ];
  const hiddenTypes = hidden.map(
    (id) => changed.match.cardsByInternalId[id].type,
  );
  hidden.forEach((id, i) => {
    changed.match.cardsByInternalId[id].type =
      hiddenTypes[(i + 1) % hiddenTypes.length];
  });
  assertInvariants(changed);
  assert.deepEqual(projectRoom(changed, "A", 1_000), before);
  assert.deepEqual(
    projectRoom(changed, "D", 1_000),
    projectRoom(room, "D", 1_000),
  );
});

test("projector copies allowed data and strips accidental internal fields from public effects", () => {
  const room = started();
  room.recentPublicLog.push({
    type: "PlayerDrewCard",
    roomVersion: 2,
    effectIndex: 0,
    playerId: "B",
    cardType: "TREASURE",
    internalCardId: "private",
    orderedCardIds: ["private"],
  });
  room.recentPublicLog.push({ type: "UnknownSecretEvent", secret: "private" });
  const view = projectRoom(room, "A", 1_000);
  assert.deepEqual(view.recentPublicLog.at(-1), {
    type: "PlayerDrewCard",
    roomVersion: 2,
    effectIndex: 0,
    playerId: "B",
  });
  view.self.hand[0].type = "CHANGED";
  view.game.seatOrder.reverse();
  assertInvariants(room);
  assert.equal(room.match.seatOrder[0], "A");
  assert.deepEqual(
    projectEffects([
      {
        type: "RandomCardTaken",
        roomVersion: 1,
        effectIndex: 0,
        donorPlayerId: "B",
        recipientPlayerId: "A",
        cardType: "GOBLIN",
      },
    ]),
    [
      {
        type: "RandomCardTaken",
        roomVersion: 1,
        effectIndex: 0,
        donorPlayerId: "B",
        recipientPlayerId: "A",
      },
    ],
  );
});

test("lobby host action permissions reflect configured human readiness and member access", () => {
  const room = roomFor();
  assert.deepEqual(projectRoom(room, "A", 1_000).allowedCommands.types, [
    "SET_READY",
    "UPDATE_ROOM",
    "START_MATCH",
    "LEAVE_ROOM",
  ]);
  assert.deepEqual(projectRoom(room, "B", 1_000).allowedCommands.types, [
    "SET_READY",
    "LEAVE_ROOM",
  ]);
  room.seats[1].ready = false;
  assert.equal(
    projectRoom(room, "A", 1_000).allowedCommands.types.includes("START_MATCH"),
    false,
  );
  room.seats.pop();
  assert.equal(
    projectRoom(room, "A", 1_000).allowedCommands.types.includes("START_MATCH"),
    false,
  );
});

test("invariants catch duplicate/lost cards, illegal lairs, stale handles and invalid decisions", () => {
  for (const breakState of [
    (match) => match.drawPile.push(match.drawPile[0]),
    (match) => match.drawPile.pop(),
    (match) => match.lairsByPlayer.A.treasures.push(match.handsByPlayer.A[0]),
    (match) => {
      match.handHandlesByPlayer.A.guessed = match.drawPile[0];
    },
    (match) => {
      match.decision.playerId = "B";
    },
    (match) => {
      match.decision = null;
    },
  ]) {
    const room = started();
    breakState(room.match);
    assert.throws(() => assertInvariants(room), { code: "INTERNAL_ERROR" });
  }
});

test("bot active policy applies the exact draw threshold and samples ordered own handles only", () => {
  const view = projectRoom(started(), "A", 1_000);
  assert.equal(chooseBotCommand(view, { int: () => 39 }).type, "DRAW_CARD");
  const sequence = [40, 2, 2, 0, 0];
  const command = chooseBotCommand(view, {
    int: (max) => {
      const value = sequence.shift();
      assert.ok(value < max);
      return value;
    },
  });
  assert.equal(command.type, "SEND_PACKET");
  assert.deepEqual(command.payload.orderedHandCardHandles, [
    view.self.hand[2].handle,
    view.self.hand[0].handle,
    view.self.hand[1].handle,
  ]);
  assert.equal(sequence.length, 0);
  assert.deepEqual(fallbackBotCommand(view, { int: () => 0 }), {
    type: "DRAW_CARD",
    payload: {},
  });
});

for (const { lairs, threshold } of [
  { lairs: {}, threshold: 55 },
  { lairs: { treasures: ["T"] }, threshold: 35 },
  { lairs: { treasures: ["T"], goblins: ["G"] }, threshold: 70 },
]) {
  test(`bot reveal threshold ${threshold}% depends only on its visible lair`, () => {
    const room = arrange(started(), {
      lairs: { B: lairs },
      packet: { cards: ["A"] },
    });
    const view = projectRoom(room, "B", 1_000);
    assert.equal(
      chooseBotCommand(view, { int: () => threshold - 1 }).type,
      "REVEAL_PACKET_TOP",
    );
    assert.equal(
      chooseBotCommand(view, { int: () => threshold }).type,
      "PASS_PACKET",
    );
    assert.equal(
      fallbackBotCommand(view, { int: () => 0 }).type,
      "REVEAL_PACKET_TOP",
    );
  });
}

test("bot forced take and fallback use public donors; thinking delay stays 750–1500 ms", () => {
  const room = arrange(started(), { hands: { B: ["T"] }, remainderTo: "C" });
  const view = projectRoom(room, "A", 1_000);
  assert.deepEqual(chooseBotCommand(view, { int: () => 0 }), {
    type: "TAKE_RANDOM_CARD",
    payload: { targetPlayerId: "C" },
  });
  assert.deepEqual(fallbackBotCommand(view, { int: () => 0 }), {
    type: "TAKE_RANDOM_CARD",
    payload: { targetPlayerId: "C" },
  });
  assert.equal(botThinkingDelay({ int: () => 0 }), 750);
  assert.equal(botThinkingDelay({ int: (max) => max - 1 }), 1500);
});

test("reproducible full games at every seat count conserve every card through thousands of ordinary bot commands", () => {
  let randomState = 147;
  const rng = {
    int(max) {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return Math.floor((randomState / 4294967296) * max);
    },
  };
  for (let count = 2; count <= 6; count += 1) {
    for (let game = 0; game < 8; game += 1) {
      const room = roomFor(count, true);
      const context = { ...ctx(), rng };
      startMatch(room, context);
      let actions = 0;
      while (room.status === "PLAYING" && actions < 10_000) {
        const playerId = room.match.decision.playerId;
        const view = projectRoom(room, playerId, context.now);
        const command = chooseBotCommand(view, rng);
        assert.ok(command);
        act(room, playerId, command.type, command.payload, context);
        actions += 1;
      }
      assert.equal(
        room.status,
        "FINISHED",
        `${count}-player game ${game} completed in ${actions} actions`,
      );
      assert.equal(
        room.match.lairsByPlayer[room.match.winnerPlayerId].treasures.length,
        3,
      );
    }
  }
});
