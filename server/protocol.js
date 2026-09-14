export const gameplay = new Set([
  "DRAW_CARD",
  "SEND_PACKET",
  "PASS_PACKET",
  "REVEAL_PACKET_TOP",
  "TAKE_RANDOM_CARD",
]);
export const joining = new Set([
  "CREATE_ROOM",
  "JOIN_PUBLIC_ROOM",
  "JOIN_PRIVATE_ROOM",
]);
const schemas = {
  CREATE_ROOM: ["name", "visibility", "additionalHumans", "bots"],
  JOIN_PUBLIC_ROOM: ["roomId"],
  JOIN_PRIVATE_ROOM: ["code"],
  UPDATE_ROOM: ["name", "visibility", "additionalHumans", "bots"],
  SET_READY: ["ready"],
  START_MATCH: [],
  LEAVE_ROOM: [],
  DRAW_CARD: [],
  SEND_PACKET: ["orderedHandCardHandles"],
  PASS_PACKET: [],
  REVEAL_PACKET_TOP: [],
  TAKE_RANDOM_CARD: ["targetPlayerId"],
  RECLAIM_CONTROL: [],
  RETURN_TO_LOBBY: [],
};
export function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value, keys, required = keys) {
  if (
    !object(value) ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    required.some((k) => !(k in value))
  )
    fail("INVALID_MESSAGE", "Invalid message.");
}
export function validateMessage(message) {
  if (!object(message) || message.protocolVersion !== 1)
    fail("INVALID_MESSAGE", "Please update the game and reconnect.");
  if (message.kind === "read") {
    exact(
      message,
      ["protocolVersion", "kind", "type", "roomId"],
      ["protocolVersion", "kind", "type"],
    );
    if (!["LIST_PUBLIC_ROOMS", "REQUEST_SNAPSHOT"].includes(message.type))
      fail("INVALID_MESSAGE", "Unknown request.");
    if (message.roomId !== undefined && typeof message.roomId !== "string")
      fail("INVALID_MESSAGE", "Invalid room.");
    return message;
  }
  const payloadKeys =
    typeof message.type === "string" && Object.hasOwn(schemas, message.type)
      ? schemas[message.type]
      : null;
  if (message.kind !== "command" || !payloadKeys)
    fail("INVALID_MESSAGE", "Unknown command.");
  const keys = ["protocolVersion", "kind", "commandId", "type", "payload"];
  if (!joining.has(message.type)) keys.push("roomId", "expectedVersion");
  if (gameplay.has(message.type)) keys.push("matchId", "decisionId");
  exact(message, keys);
  exact(message.payload, payloadKeys);
  if (
    typeof message.commandId !== "string" ||
    !/^[a-zA-Z0-9_-]{8,100}$/.test(message.commandId)
  )
    fail("INVALID_MESSAGE", "Invalid command identifier.");
  if (
    !joining.has(message.type) &&
    (typeof message.roomId !== "string" ||
      !Number.isSafeInteger(message.expectedVersion) ||
      message.expectedVersion < 0)
  )
    fail("INVALID_MESSAGE", "Invalid room version.");
  if (
    gameplay.has(message.type) &&
    [message.matchId, message.decisionId].some(
      (x) => typeof x !== "string" || x.length > 100,
    )
  )
    fail("INVALID_MESSAGE", "Invalid decision.");
  if (
    message.type === "SET_READY" &&
    typeof message.payload.ready !== "boolean"
  )
    fail("INVALID_MESSAGE", "Readiness must be true or false.");
  if (
    message.type === "JOIN_PRIVATE_ROOM" &&
    (typeof message.payload.code !== "string" ||
      !/^\d{6}$/.test(message.payload.code))
  )
    fail("ROOM_UNAVAILABLE", "Room unavailable.");
  if (
    message.type === "JOIN_PUBLIC_ROOM" &&
    typeof message.payload.roomId !== "string"
  )
    fail("INVALID_MESSAGE", "Invalid room.");
  if (
    message.type === "TAKE_RANDOM_CARD" &&
    typeof message.payload.targetPlayerId !== "string"
  )
    fail("INVALID_MESSAGE", "Invalid target.");
  if (
    message.type === "SEND_PACKET" &&
    (!Array.isArray(message.payload.orderedHandCardHandles) ||
      message.payload.orderedHandCardHandles.length > 18 ||
      message.payload.orderedHandCardHandles.some(
        (x) => typeof x !== "string" || x.length > 100,
      ))
  )
    fail("INVALID_SELECTION", "Invalid card selection.");
  return message;
}
export function validateName(name, max) {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > max ||
    /[\x00-\x1f\x7f]/.test(name)
  )
    fail("INVALID_MESSAGE", `Enter a name with 1–${max} characters.`);
  return name.trim();
}
export function configuration(payload) {
  const name = validateName(payload.name, 48);
  const { visibility, additionalHumans, bots } = payload;
  if (
    !["PUBLIC", "PRIVATE"].includes(visibility) ||
    ![additionalHumans, bots].every(
      (n) => Number.isInteger(n) && n >= 0 && n <= 5,
    ) ||
    1 + additionalHumans + bots < 2 ||
    1 + additionalHumans + bots > 6
  )
    fail("INVALID_MESSAGE", "Choose 2–6 players, including yourself.");
  return { name, visibility, additionalHumans, bots };
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
      .join(",")}}`;
  return JSON.stringify(value);
}
export class RateLimiter {
  constructor() {
    this.buckets = new Map();
  }
  allow(key, now, rate = 20, burst = 30) {
    const old = this.buckets.get(key) || { tokens: burst, at: now };
    const tokens = Math.min(burst, old.tokens + ((now - old.at) * rate) / 1000);
    this.buckets.set(key, {
      tokens: tokens >= 1 ? tokens - 1 : tokens,
      at: now,
    });
    return tokens >= 1;
  }
  prune(now) {
    for (const [key, b] of this.buckets)
      if (now - b.at > 120000) this.buckets.delete(key);
  }
}
