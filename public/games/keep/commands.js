const gameplay = new Set([
  "DRAW_CARD",
  "SEND_PACKET",
  "PASS_PACKET",
  "REVEAL_PACKET_TOP",
  "TAKE_RANDOM_CARD",
]);
const entrance = new Set([
  "CREATE_ROOM",
  "JOIN_PUBLIC_ROOM",
  "JOIN_PRIVATE_ROOM",
]);
export function commandFor(store, type, payload = {}) {
  const command = {
    protocolVersion: 1,
    kind: "command",
    commandId: crypto.randomUUID(),
    type,
    payload,
  };
  if (!entrance.has(type)) {
    command.roomId = store.view.roomId;
    command.expectedVersion = store.view.stateVersion;
  }
  if (gameplay.has(type)) {
    command.matchId = store.view.matchId;
    command.decisionId = store.view.game.decision.decisionId;
  }
  return command;
}
