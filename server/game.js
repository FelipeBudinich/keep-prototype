/** Authoritative Keep rules. No transport, storage, or browser dependencies. */
export const CARD_TYPES = Object.freeze({
  TREASURE: "TREASURE",
  ADVENTURER: "ADVENTURER",
  GOBLIN: "GOBLIN",
});
export const GAMEPLAY_TYPES = Object.freeze([
  "DRAW_CARD",
  "SEND_PACKET",
  "PASS_PACKET",
  "REVEAL_PACKET_TOP",
  "TAKE_RANDOM_CARD",
]);
export const DEFAULT_TIMINGS = Object.freeze({
  active: 60_000,
  recipient: 30_000,
  bot: 5_000,
});

export function gameError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireRule(condition, code, message) {
  if (!condition) throw gameError(code, message);
}

function randomInt(ctx, max) {
  const value = ctx.rng.int(max);
  requireRule(
    Number.isInteger(value) && value >= 0 && value < max,
    "INTERNAL_ERROR",
    "The game could not complete this action.",
  );
  return value;
}

function seatFor(room, playerId) {
  return room.seats.find((seat) => seat.playerId === playerId);
}

function beginEffects(room) {
  room.match.effects = [];
}

function emit(room, type, details = {}) {
  const match = room.match;
  const effect = {
    type,
    roomVersion: room.stateVersion + 1,
    effectIndex: match.effects.length,
    ...details,
  };
  match.effects.push(effect);
  room.recentPublicLog = [...(room.recentPublicLog ?? []), effect].slice(-100);
}

function enterHand(match, playerId, cardId, ctx) {
  match.handsByPlayer[playerId].push(cardId);
  match.handHandlesByPlayer[playerId][ctx.id()] = cardId;
}

function leaveHand(match, playerId, cardId) {
  const hand = match.handsByPlayer[playerId];
  const index = hand.indexOf(cardId);
  requireRule(
    index !== -1,
    "INTERNAL_ERROR",
    "The game could not complete this action.",
  );
  hand.splice(index, 1);
  const handles = match.handHandlesByPlayer[playerId];
  for (const [handle, id] of Object.entries(handles))
    if (id === cardId) delete handles[handle];
}

function rightOf(match, playerId) {
  const index = match.seatOrder.indexOf(playerId);
  requireRule(
    index !== -1,
    "INTERNAL_ERROR",
    "The game could not complete this action.",
  );
  return match.seatOrder[(index + 1) % match.seatOrder.length];
}

function openDecision(room, playerId, kind, ctx, forceBot = false) {
  const match = room.match;
  const seat = seatFor(room, playerId);
  const bot = forceBot || seat.controllerMode !== "HUMAN";
  const duration = bot
    ? match.timings.bot
    : kind === "ACTIVE_CHOICE"
      ? match.timings.active
      : match.timings.recipient;
  match.phase = kind;
  match.decision = {
    decisionId: ctx.id(),
    playerId,
    kind,
    deadlineAt: ctx.now + duration,
  };
}

/** Deal a fresh game. The room executor commits and increments stateVersion. */
export function startMatch(room, ctx) {
  requireRule(
    room.status === "LOBBY",
    "ILLEGAL_ACTION",
    "A match can only start from the lobby.",
  );
  const orderedSeats = [...room.seats].sort(
    (a, b) => a.seatIndex - b.seatIndex,
  );
  const expectedHumans = room.configuredAdditionalHumans + 1;
  const humans = orderedSeats.filter((seat) => seat.kind === "HUMAN");
  const bots = orderedSeats.filter((seat) => seat.kind === "BOT");
  requireRule(
    orderedSeats.length >= 2 &&
      orderedSeats.length <= 6 &&
      humans.length === expectedHumans &&
      bots.length === room.configuredBots,
    "NOT_READY",
    "Every configured seat must be occupied.",
  );
  requireRule(
    humans.every((seat) => seat.connected && seat.ready),
    "NOT_READY",
    "Every human player must be connected and ready.",
  );
  requireRule(
    new Set(orderedSeats.map((seat) => seat.playerId)).size ===
      orderedSeats.length,
    "INTERNAL_ERROR",
    "The game could not start.",
  );

  const match = {
    matchId: ctx.id(),
    rulesetVersion: "1.0",
    turnNumber: 1,
    phase: "ACTIVE_CHOICE",
    seatOrder: orderedSeats.map((seat) => seat.playerId),
    activePlayerId: null,
    cardsByInternalId: {},
    drawPile: [],
    handsByPlayer: {},
    lairsByPlayer: {},
    handHandlesByPlayer: {},
    packet: null,
    decision: null,
    winnerPlayerId: null,
    terminalReason: null,
    timings: { ...DEFAULT_TIMINGS, ...(ctx.timings ?? {}) },
    effects: [],
  };
  for (const seat of orderedSeats) {
    match.handsByPlayer[seat.playerId] = [];
    match.lairsByPlayer[seat.playerId] = { treasures: [], goblins: [] };
    match.handHandlesByPlayer[seat.playerId] = {};
  }
  for (const [type, count] of [
    ["TREASURE", 9],
    ["ADVENTURER", 5],
    ["GOBLIN", 4],
  ]) {
    for (let i = 0; i < count; i += 1) {
      const id = ctx.id();
      match.cardsByInternalId[id] = { type };
      match.drawPile.push(id);
    }
  }
  for (let i = match.drawPile.length - 1; i > 0; i -= 1) {
    const j = randomInt(ctx, i + 1);
    [match.drawPile[i], match.drawPile[j]] = [
      match.drawPile[j],
      match.drawPile[i],
    ];
  }
  for (let round = 0; round < 3; round += 1) {
    for (const playerId of match.seatOrder)
      enterHand(match, playerId, match.drawPile.shift(), ctx);
  }
  match.activePlayerId = match.seatOrder[randomInt(ctx, orderedSeats.length)];
  room.match = match;
  room.status = "PLAYING";
  room.recentPublicLog = [];
  emit(room, "MatchStarted", { activePlayerId: match.activePlayerId });
  openDecision(room, match.activePlayerId, "ACTIVE_CHOICE", ctx);
  assertInvariants(room);
  return match;
}

/** Only publicly derivable action metadata; safe to use for any seat's projection. */
export function legalGameplay(room, playerId, now = -Infinity) {
  const result = { types: [], legalTakeTargetPlayerIds: [] };
  const match = room.match;
  if (
    room.status !== "PLAYING" ||
    !match?.decision ||
    match.decision.playerId !== playerId ||
    now >= match.decision.deadlineAt
  )
    return result;
  if (match.phase === "PACKET_CHOICE") {
    result.types.push("PASS_PACKET", "REVEAL_PACKET_TOP");
    return result;
  }
  const hand = match.handsByPlayer[playerId];
  if (match.drawPile.length > 0) result.types.push("DRAW_CARD");
  if (hand.length > 0) result.types.push("SEND_PACKET");
  if (match.drawPile.length === 0 && hand.length === 0) {
    const opponents = match.seatOrder.filter((id) => id !== playerId);
    const largest = Math.max(
      ...opponents.map((id) => match.handsByPlayer[id].length),
    );
    if (largest > 0) {
      result.types.push("TAKE_RANDOM_CARD");
      result.legalTakeTargetPlayerIds = opponents.filter(
        (id) => match.handsByPlayer[id].length === largest,
      );
    }
  }
  return result;
}

function validatePayload(type, payload) {
  requireRule(
    payload && typeof payload === "object" && !Array.isArray(payload),
    "INVALID_MESSAGE",
    "Invalid command payload.",
  );
  const allowed =
    type === "SEND_PACKET"
      ? ["orderedHandCardHandles"]
      : type === "TAKE_RANDOM_CARD"
        ? ["targetPlayerId"]
        : [];
  requireRule(
    Object.keys(payload).length === allowed.length &&
      Object.keys(payload).every((key) => allowed.includes(key)),
    "INVALID_MESSAGE",
    "Invalid command payload.",
  );
  if (type === "TAKE_RANDOM_CARD")
    requireRule(
      typeof payload.targetPlayerId === "string",
      "INVALID_MESSAGE",
      "Invalid command payload.",
    );
}

function finishTurn(room, ctx) {
  const match = room.match;
  match.packet = null;
  match.activePlayerId = rightOf(match, match.activePlayerId);
  match.turnNumber += 1;
  emit(room, "TurnStarted", {
    activePlayerId: match.activePlayerId,
    turnNumber: match.turnNumber,
  });
  openDecision(room, match.activePlayerId, "ACTIVE_CHOICE", ctx);
}

function revealTop(room, playerId, forced, ctx) {
  const match = room.match;
  const cardId = match.packet.orderedCardIds.shift();
  const type = match.cardsByInternalId[cardId].type;
  const lair = match.lairsByPlayer[playerId];
  emit(room, "CardRevealed", { playerId, cardType: type, forced });
  if (type === "TREASURE") {
    lair.treasures.push(cardId);
    if (lair.treasures.length === 3) {
      match.winnerPlayerId = playerId;
      match.terminalReason = "WIN";
      match.phase = "TERMINAL";
      match.decision = null;
      room.status = "FINISHED";
      emit(room, "MatchWon", { playerId });
      return true;
    }
  } else if (type === "GOBLIN") {
    lair.goblins.push(cardId);
  } else {
    enterHand(match, playerId, cardId, ctx);
    const protectedByGoblins = lair.goblins.length > 0;
    const returned = protectedByGoblins
      ? lair.goblins.splice(0)
      : lair.treasures.splice(0);
    for (const returnedId of returned)
      enterHand(match, playerId, returnedId, ctx);
    emit(room, "LairCardsReturned", {
      playerId,
      treasureCount: protectedByGoblins ? 0 : returned.length,
      goblinCount: protectedByGoblins ? returned.length : 0,
    });
  }
  return false;
}

function routePacket(room, lastRecipient, ctx) {
  const match = room.match;
  if (room.status !== "PLAYING") return;
  if (match.packet.orderedCardIds.length === 0) {
    finishTurn(room, ctx);
    return;
  }
  const next = rightOf(match, lastRecipient);
  match.packet.recipientPlayerId = next;
  if (next !== match.packet.originPlayerId) {
    openDecision(room, next, "PACKET_CHOICE", ctx);
    return;
  }
  if (revealTop(room, next, true, ctx)) return;
  const remaining = match.packet.orderedCardIds.splice(0);
  for (const cardId of remaining) enterHand(match, next, cardId, ctx);
  if (remaining.length)
    emit(room, "PacketCollected", { playerId: next, count: remaining.length });
  finishTurn(room, ctx);
}

/** Validates and resolves one intent including all automatic circulation effects. */
export function applyGameplay(room, playerId, type, payload, ctx) {
  requireRule(
    Boolean(seatFor(room, playerId)),
    "NOT_A_MEMBER",
    "You are not a member of this room.",
  );
  requireRule(
    GAMEPLAY_TYPES.includes(type),
    "INVALID_MESSAGE",
    "Unknown gameplay command.",
  );
  validatePayload(type, payload);
  requireRule(
    room.status === "PLAYING" && room.match?.phase !== "TERMINAL",
    "MATCH_ENDED",
    "This match is not accepting gameplay.",
  );
  const match = room.match;
  requireRule(
    match.decision?.playerId === playerId,
    "NOT_YOUR_DECISION",
    "Another player is deciding.",
  );
  requireRule(
    ctx.now < match.decision.deadlineAt,
    "DEADLINE_EXPIRED",
    "This decision has expired.",
  );
  const legal = legalGameplay(room, playerId, ctx.now);
  if (!legal.types.length)
    throw gameError("INTERNAL_ERROR", "The game cannot continue.");
  requireRule(
    legal.types.includes(type),
    "ILLEGAL_ACTION",
    "That action is not available.",
  );
  let selectedIds;
  if (type === "SEND_PACKET") {
    const handles = payload.orderedHandCardHandles;
    requireRule(
      Array.isArray(handles) &&
        handles.length > 0 &&
        handles.length <= 18 &&
        handles.every((handle) => typeof handle === "string") &&
        new Set(handles).size === handles.length,
      "INVALID_SELECTION",
      "Select distinct cards from your current hand.",
    );
    const ownedHandles = match.handHandlesByPlayer[playerId];
    requireRule(
      handles.every(
        (handle) =>
          Object.hasOwn(ownedHandles, handle) &&
          match.handsByPlayer[playerId].includes(ownedHandles[handle]),
      ),
      "INVALID_SELECTION",
      "Select distinct cards from your current hand.",
    );
    selectedIds = handles.map((handle) => ownedHandles[handle]);
    requireRule(
      new Set(selectedIds).size === selectedIds.length,
      "INVALID_SELECTION",
      "Select distinct cards from your current hand.",
    );
  }
  if (type === "TAKE_RANDOM_CARD")
    requireRule(
      legal.legalTakeTargetPlayerIds.includes(payload.targetPlayerId),
      "INVALID_TARGET",
      "Choose a player with the largest hand.",
    );

  beginEffects(room);
  match.decision = null;
  if (type === "DRAW_CARD") {
    enterHand(match, playerId, match.drawPile.shift(), ctx);
    emit(room, "PlayerDrewCard", { playerId });
    finishTurn(room, ctx);
  } else if (type === "SEND_PACKET") {
    for (const cardId of selectedIds) leaveHand(match, playerId, cardId);
    const recipientPlayerId = rightOf(match, playerId);
    match.packet = {
      originPlayerId: playerId,
      recipientPlayerId,
      orderedCardIds: selectedIds,
    };
    emit(room, "PacketSent", {
      originPlayerId: playerId,
      recipientPlayerId,
      count: selectedIds.length,
    });
    openDecision(room, recipientPlayerId, "PACKET_CHOICE", ctx);
  } else if (type === "PASS_PACKET") {
    emit(room, "PacketPassed", {
      playerId,
      recipientPlayerId: rightOf(match, playerId),
      count: match.packet.orderedCardIds.length,
    });
    routePacket(room, playerId, ctx);
  } else if (type === "REVEAL_PACKET_TOP") {
    if (!revealTop(room, playerId, false, ctx))
      routePacket(room, playerId, ctx);
  } else {
    const donor = payload.targetPlayerId;
    const hand = match.handsByPlayer[donor];
    const cardId = hand[randomInt(ctx, hand.length)];
    leaveHand(match, donor, cardId);
    enterHand(match, playerId, cardId, ctx);
    emit(room, "RandomCardTaken", {
      donorPlayerId: donor,
      recipientPlayerId: playerId,
    });
    finishTurn(room, ctx);
  }
  assertInvariants(room);
  return match;
}

/** Timeout transition; the executor fences by the old decision ID before calling. */
export function replaceDecision(room, ctx) {
  const match = room.match;
  if (
    room.status !== "PLAYING" ||
    !match?.decision ||
    ctx.now < match.decision.deadlineAt
  )
    return false;
  const { playerId, kind } = match.decision;
  const seat = seatFor(room, playerId);
  beginEffects(room);
  if (seat.kind === "HUMAN" && seat.controllerMode === "HUMAN") {
    seat.controllerMode = "TEMP_BOT";
    emit(room, "ControlTransferred", { playerId, controllerMode: "TEMP_BOT" });
  }
  seat.controlGeneration = (seat.controlGeneration ?? 0) + 1;
  openDecision(room, playerId, kind, ctx, true);
  assertInvariants(room);
  return true;
}

/** Conservation, zone ownership, handle lifetime, table, and decision invariants. */
export function assertInvariants(room) {
  try {
    return validateInvariants(room);
  } catch {
    throw gameError(
      "INTERNAL_ERROR",
      "The game encountered an internal error.",
    );
  }
}

function validateInvariants(room) {
  const fail = () => {
    throw gameError(
      "INTERNAL_ERROR",
      "The game encountered an internal error.",
    );
  };
  const ensure = (condition) => {
    if (!condition) fail();
  };
  ensure(Array.isArray(room.seats));
  ensure(
    new Set(room.seats.map((seat) => seat.playerId)).size === room.seats.length,
  );
  ensure(
    new Set(room.seats.map((seat) => seat.seatIndex)).size ===
      room.seats.length,
  );
  const match = room.match;
  if (!match) {
    ensure(
      room.status === "LOBBY" ||
        room.status === "CLOSED" ||
        room.status === "ERROR",
    );
    return true;
  }
  ensure(match.seatOrder.length >= 2 && match.seatOrder.length <= 6);
  ensure(new Set(match.seatOrder).size === match.seatOrder.length);
  ensure(
    match.seatOrder.every((id) =>
      room.seats.some((seat) => seat.playerId === id),
    ),
  );
  ensure(match.seatOrder.includes(match.activePlayerId));
  ensure(Number.isInteger(match.turnNumber) && match.turnNumber >= 1);
  const allIds = Object.keys(match.cardsByInternalId);
  ensure(allIds.length === 18);
  const totals = { TREASURE: 0, ADVENTURER: 0, GOBLIN: 0 };
  for (const id of allIds) {
    const type = match.cardsByInternalId[id].type;
    ensure(Object.hasOwn(totals, type));
    totals[type] += 1;
  }
  ensure(
    totals.TREASURE === 9 && totals.ADVENTURER === 5 && totals.GOBLIN === 4,
  );
  const located = [];
  const globalHandles = new Set();
  ensure(Array.isArray(match.drawPile));
  located.push(...match.drawPile);
  for (const playerId of match.seatOrder) {
    const hand = match.handsByPlayer[playerId];
    const lair = match.lairsByPlayer[playerId];
    const handles = match.handHandlesByPlayer[playerId];
    ensure(
      Array.isArray(hand) &&
        lair &&
        Array.isArray(lair.treasures) &&
        Array.isArray(lair.goblins) &&
        handles &&
        typeof handles === "object",
    );
    ensure(
      lair.treasures.every(
        (id) => match.cardsByInternalId[id]?.type === "TREASURE",
      ),
    );
    ensure(
      lair.goblins.every(
        (id) => match.cardsByInternalId[id]?.type === "GOBLIN",
      ),
    );
    ensure(lair.treasures.length <= 3);
    const handleEntries = Object.entries(handles);
    ensure(
      handleEntries.length === hand.length &&
        new Set(Object.values(handles)).size === hand.length,
    );
    for (const [handle, id] of handleEntries) {
      ensure(
        hand.includes(id) &&
          typeof handle === "string" &&
          handle.length > 0 &&
          !globalHandles.has(handle) &&
          !Object.hasOwn(match.cardsByInternalId, handle),
      );
      globalHandles.add(handle);
    }
    located.push(...hand, ...lair.treasures, ...lair.goblins);
  }
  if (match.packet) {
    ensure(
      match.packet.originPlayerId === match.activePlayerId &&
        match.seatOrder.includes(match.packet.recipientPlayerId),
    );
    ensure(Array.isArray(match.packet.orderedCardIds));
    located.push(...match.packet.orderedCardIds);
  }
  ensure(
    located.length === 18 &&
      new Set(located).size === 18 &&
      located.every((id) => Object.hasOwn(match.cardsByInternalId, id)),
  );
  ensure(
    match.timings &&
      ["active", "recipient", "bot"].every(
        (key) => Number.isFinite(match.timings[key]) && match.timings[key] > 0,
      ),
  );
  if (room.status === "PLAYING") {
    ensure(match.phase === "ACTIVE_CHOICE" || match.phase === "PACKET_CHOICE");
    ensure(!match.winnerPlayerId && !match.terminalReason);
    ensure(
      match.seatOrder.every(
        (id) => match.lairsByPlayer[id].treasures.length < 3,
      ),
    );
    ensure(
      match.decision &&
        typeof match.decision.decisionId === "string" &&
        Number.isFinite(match.decision.deadlineAt),
    );
    ensure(match.decision.kind === match.phase);
    if (match.phase === "ACTIVE_CHOICE") {
      ensure(!match.packet && match.decision.playerId === match.activePlayerId);
      ensure(
        match.drawPile.length > 0 ||
          match.handsByPlayer[match.activePlayerId].length > 0 ||
          match.seatOrder.some((id) => match.handsByPlayer[id].length > 0),
      );
    } else {
      ensure(match.packet && match.packet.orderedCardIds.length > 0);
      ensure(match.packet.recipientPlayerId !== match.packet.originPlayerId);
      ensure(match.decision.playerId === match.packet.recipientPlayerId);
    }
  } else {
    ensure(["FINISHED", "ABANDONED", "ERROR", "CLOSED"].includes(room.status));
    ensure(match.phase === "TERMINAL" && match.decision === null);
    if (room.status === "FINISHED") {
      ensure(
        match.terminalReason === "WIN" &&
          match.seatOrder.includes(match.winnerPlayerId),
      );
      ensure(match.lairsByPlayer[match.winnerPlayerId].treasures.length === 3);
    } else if (room.status === "ABANDONED")
      ensure(
        match.terminalReason === "ABANDONED" && match.winnerPlayerId === null,
      );
  }
  return true;
}
