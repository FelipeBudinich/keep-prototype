/** Policies receive only the same allowlisted view as a player, never a match. */
function sample(list, rng) {
  return list[rng.int(list.length)];
}

function send(view, rng, single = false) {
  const available = view.self.hand.map((card) => card.handle);
  const size = single ? 1 : 1 + rng.int(Math.min(3, available.length));
  const selected = [];
  // Sequential uniform sampling without replacement also uniformly orders the pile.
  for (let i = 0; i < size; i += 1)
    selected.push(available.splice(rng.int(available.length), 1)[0]);
  return { type: "SEND_PACKET", payload: { orderedHandCardHandles: selected } };
}

export function chooseBotCommand(view, rng) {
  const types = view.allowedCommands.types;
  if (types.includes("PASS_PACKET") && types.includes("REVEAL_PACKET_TOP")) {
    const ownSeat = view.players.find(
      (player) => player.playerId === view.self.playerId,
    );
    const probability =
      ownSeat.visibleGoblinCount > 0
        ? 70
        : ownSeat.visibleTreasureCount > 0
          ? 35
          : 55;
    return {
      type: rng.int(100) < probability ? "REVEAL_PACKET_TOP" : "PASS_PACKET",
      payload: {},
    };
  }
  const draw = types.includes("DRAW_CARD");
  const canSend = types.includes("SEND_PACKET");
  if (draw && (!canSend || rng.int(100) < 40))
    return { type: "DRAW_CARD", payload: {} };
  if (canSend) return send(view, rng);
  if (types.includes("TAKE_RANDOM_CARD"))
    return {
      type: "TAKE_RANDOM_CARD",
      payload: {
        targetPlayerId: sample(
          view.allowedCommands.legalTakeTargetPlayerIds,
          rng,
        ),
      },
    };
  return null;
}

export function fallbackBotCommand(view, rng) {
  const types = view.allowedCommands.types;
  if (types.includes("DRAW_CARD")) return { type: "DRAW_CARD", payload: {} };
  if (types.includes("SEND_PACKET")) return send(view, rng, true);
  if (types.includes("REVEAL_PACKET_TOP"))
    return { type: "REVEAL_PACKET_TOP", payload: {} };
  if (types.includes("TAKE_RANDOM_CARD"))
    return {
      type: "TAKE_RANDOM_CARD",
      payload: {
        targetPlayerId: sample(
          view.allowedCommands.legalTakeTargetPlayerIds,
          rng,
        ),
      },
    };
  return null;
}

export function botThinkingDelay(rng) {
  return 750 + rng.int(751);
}
