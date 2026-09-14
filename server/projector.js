import { gameError, legalGameplay } from "./game.js";

// Deliberately construct effects field by field. Canonical state is never spread.
const EFFECT_FIELDS = Object.freeze({
  MatchStarted: ["activePlayerId"],
  TurnStarted: ["activePlayerId", "turnNumber"],
  PlayerDrewCard: ["playerId"],
  PacketSent: ["originPlayerId", "recipientPlayerId", "count"],
  PacketPassed: ["playerId", "recipientPlayerId", "count"],
  CardRevealed: ["playerId", "cardType", "forced"],
  LairCardsReturned: ["playerId", "treasureCount", "goblinCount"],
  PacketCollected: ["playerId", "count"],
  RandomCardTaken: ["donorPlayerId", "recipientPlayerId"],
  MatchWon: ["playerId"],
  ControlTransferred: ["playerId", "controllerMode"],
  ControlReclaimed: ["playerId"],
  HostTransferred: ["playerId"],
  MatchAbandoned: [],
  RoomError: ["incidentId"],
});

export function projectEffects(effects) {
  return (effects ?? [])
    .filter((effect) => Object.hasOwn(EFFECT_FIELDS, effect.type))
    .map((effect) => {
      const safe = {
        type: effect.type,
        roomVersion: Number.isInteger(effect.roomVersion)
          ? effect.roomVersion
          : 0,
        effectIndex: Number.isInteger(effect.effectIndex)
          ? effect.effectIndex
          : 0,
      };
      for (const key of EFFECT_FIELDS[effect.type]) {
        const value = effect[key];
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        )
          safe[key] = value;
      }
      return safe;
    });
}

/** The only room snapshot boundary used by human connections and bot policy. */
export function projectRoom(room, playerId, now) {
  const self = room.seats.find((seat) => seat.playerId === playerId);
  if (!self || room.status === "CLOSED")
    throw gameError("NOT_A_MEMBER", "You are not a member of this room.");
  // A quarantined match may be structurally corrupt. Keep its diagnostic state
  // server-side and publish an explicit stopped view without dereferencing cards.
  const quarantined = room.status === "ERROR";
  const match = quarantined ? null : room.match;
  const legal = legalGameplay(room, playerId, now);
  const types = [...legal.types];
  if (room.status === "LOBBY") {
    if (self.kind === "HUMAN" && self.connected) types.push("SET_READY");
    if (room.hostPlayerId === playerId) {
      types.push("UPDATE_ROOM");
      const humans = room.seats.filter((seat) => seat.kind === "HUMAN");
      if (
        humans.length === room.configuredAdditionalHumans + 1 &&
        room.seats.filter((seat) => seat.kind === "BOT").length ===
          room.configuredBots &&
        humans.every((seat) => seat.connected && seat.ready)
      )
        types.push("START_MATCH");
    }
  }
  if (self.kind === "HUMAN") types.push("LEAVE_ROOM");
  if (
    room.status === "PLAYING" &&
    self.kind === "HUMAN" &&
    self.controllerMode === "TEMP_BOT"
  )
    types.push("RECLAIM_CONTROL");
  if (
    (room.status === "FINISHED" || room.status === "ABANDONED") &&
    room.hostPlayerId === playerId
  )
    types.push("RETURN_TO_LOBBY");
  const handleById = new Map(
    Object.entries(match?.handHandlesByPlayer[playerId] ?? {}).map(
      ([handle, id]) => [id, handle],
    ),
  );
  const roomView = {
    name: room.roomName,
    visibility: room.visibility,
    hostPlayerId: room.hostPlayerId,
    configuration: {
      additionalHumans: room.configuredAdditionalHumans,
      bots: room.configuredBots,
      totalPlayers: 1 + room.configuredAdditionalHumans + room.configuredBots,
    },
    status: room.status,
  };
  if (room.visibility === "PRIVATE") roomView.code = room.privateCode;
  const view = {
    protocolVersion: 1,
    roomId: room.roomId,
    stateVersion: room.stateVersion,
    room: roomView,
    self: {
      playerId: self.playerId,
      seatIndex: self.seatIndex,
      controllerMode: self.controllerMode,
      hand: (match?.handsByPlayer[playerId] ?? []).map((id) => ({
        handle: handleById.get(id),
        type: match.cardsByInternalId[id].type,
      })),
    },
    players: [...room.seats]
      .sort((a, b) => a.seatIndex - b.seatIndex)
      .map((seat) => ({
        playerId: seat.playerId,
        displayName: seat.displayName,
        seatIndex: seat.seatIndex,
        kind: seat.kind,
        connected: Boolean(seat.connected),
        ready: Boolean(seat.ready),
        controllerMode: seat.controllerMode,
        handCount: match?.handsByPlayer[seat.playerId]?.length ?? 0,
        visibleTreasureCount:
          match?.lairsByPlayer[seat.playerId]?.treasures.length ?? 0,
        visibleGoblinCount:
          match?.lairsByPlayer[seat.playerId]?.goblins.length ?? 0,
      })),
    game: quarantined
      ? {
          phase: "TERMINAL",
          seatOrder: [...room.seats]
            .sort((a, b) => a.seatIndex - b.seatIndex)
            .map((seat) => seat.playerId),
          turnNumber: 0,
          activePlayerId: null,
          drawPileCount: 0,
          packet: null,
          decision: null,
          winnerPlayerId: null,
          terminalReason: "INTERNAL_ERROR",
        }
      : match
        ? {
            phase: match.phase,
            seatOrder: [...match.seatOrder],
            turnNumber: match.turnNumber,
            activePlayerId: match.activePlayerId,
            drawPileCount: match.drawPile.length,
            packet: match.packet
              ? {
                  originPlayerId: match.packet.originPlayerId,
                  recipientPlayerId: match.packet.recipientPlayerId,
                  count: match.packet.orderedCardIds.length,
                }
              : null,
            decision: match.decision
              ? {
                  decisionId: match.decision.decisionId,
                  playerId: match.decision.playerId,
                  kind: match.decision.kind,
                  deadlineAt: match.decision.deadlineAt,
                }
              : null,
            winnerPlayerId: match.winnerPlayerId,
            terminalReason: match.terminalReason,
          }
        : null,
    allowedCommands: {
      types,
      legalTakeTargetPlayerIds: [...legal.legalTakeTargetPlayerIds],
    },
    recentPublicLog: projectEffects(room.recentPublicLog).slice(-100),
    serverTime: now,
  };
  if (quarantined && typeof room.incidentId === "string")
    view.room.incidentId = room.incidentId;
  if (match) {
    view.matchId = match.matchId;
    view.rulesetVersion = match.rulesetVersion;
  }
  return view;
}
