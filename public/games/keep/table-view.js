import { S, logMessages } from "./strings.js";

// Shared presentation state keeps canvas controls and their accessible counterparts
// on the same decision, including temporary bot control and terminal rooms.
export function getTableState(store, leaving = false) {
  const view = store.view;
  if (!view) return null;
  const game = view.game || {},
    me = view.self,
    ended =
      ["FINISHED", "ABANDONED", "CLOSED", "ERROR"].includes(view.room.status) ||
      Boolean(game.winnerPlayerId) ||
      Boolean(game.terminalReason),
    winner = view.players.find((player) => player.playerId === game.winnerPlayerId),
    myDecision = game.decision?.playerId === me.playerId,
    receiver = store.allowed("REVEAL_PACKET_TOP"),
    take = store.allowed("TAKE_RANDOM_CARD"),
    ordered = [...view.players].sort((a, b) => a.seatIndex - b.seatIndex),
    seat = ordered.findIndex((player) => player.playerId === me.playerId),
    neighbor = ordered[(seat + 1) % ordered.length];
  const title = leaving
    ? S.leave
    : view.room.status === "ERROR"
      ? S.roomErrorTitle
      : ended
        ? winner?.playerId === me.playerId
          ? S.victory
          : winner
            ? `${winner.displayName} ${S.won}`
            : S.abandoned
        : me.controllerMode === "TEMP_BOT"
          ? S.botControl
          : myDecision
            ? receiver ? S.receivePrompt : S.yourTurn
            : S.waitPrompt;
  const explanation = leaving
    ? S.leaveLive
    : view.room.status === "ERROR"
      ? S.roomErrorHelp
      : ended
        ? winner ? S.resultHelp : S.abandonedHelp
        : me.controllerMode === "TEMP_BOT"
          ? S.botHelp
          : myDecision
            ? receiver ? S.receiveHelp : take ? S.takeHelp : S.sendPrompt
            : S.waitHelp;
  const status = ended
    ? S.finalBoard
    : myDecision
      ? S.controls
      : `${S.deciding}: ${view.players.find((player) => player.playerId === game.decision?.playerId)?.displayName || S.thinking}`;
  const actions = [];
  const add = (id, label, action = id, dataset = {}) =>
    actions.push({ id, label, action, disabled: false, dataset });
  if (leaving) {
    actions.push(
      { id: "confirm-leave", label: S.leaveConfirm, action: "confirm-leave", disabled: !store.allowed("LEAVE_ROOM"), dataset: {} },
      { id: "cancel-leave", label: S.cancelLeave, action: "cancel-leave", disabled: false, dataset: {} },
    );
  } else {
    if (store.allowed("DRAW_CARD")) add("draw", S.draw);
    if (store.allowed("PASS_PACKET")) add("pass", S.pass);
    if (receiver) add("reveal", S.reveal);
    if (take)
      for (const playerId of view.allowedCommands.legalTakeTargetPlayerIds || [])
        add(`take:${playerId}`, `${S.take} · ${view.players.find((player) => player.playerId === playerId)?.displayName || S.guest}`, "take", { playerId });
    if (store.allowed("RECLAIM_CONTROL")) add("reclaim", S.reclaim);
    if (store.allowed("RETURN_TO_LOBBY")) add("rematch", S.rematch);
  }
  return { ended, winner, myDecision, receiver, take, title, explanation, status, neighbor, actions };
}

export function logText(entry, view) {
  if (typeof entry === "string") return entry;
  if (entry.message) return entry.message;
  const name = (id) =>
    view.players.find((player) => player.playerId === id)?.displayName || S.guest;
  return logMessages[entry.type || entry.kind]?.(entry, name) || S.noLog;
}
