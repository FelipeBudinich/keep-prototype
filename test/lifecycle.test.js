import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "../server/persistence.js";
import { RoomService } from "../server/service.js";
import { assertInvariants } from "../server/game.js";

async function fixture({
  humans = 3,
  bots = 0,
  start = false,
  botPolicy,
  codeRng,
  timingOverrides = {},
} = {}) {
  let now = 1_000;
  const data = { rooms: {}, receipts: {}, sessions: {} };
  for (let i = 0; i < humans; i++) {
    const playerId = String.fromCharCode(65 + i);
    data.sessions[playerId] = {
      playerId,
      displayName: playerId,
      roomId: null,
      expiresAt: 31 * 86400000,
    };
  }
  const store = new MemoryStore(data);
  const service = new RoomService(store, {
    clock: { now: () => now },
    rng: { int: () => 0 },
    codeRng,
    botPolicy,
    timingOverrides,
  });
  await service.init();
  const connections = {};
  for (const playerId of Object.keys(data.sessions)) {
    connections[playerId] = {};
    service.connections.set(playerId, connections[playerId]);
  }
  const result = {
    service,
    store,
    connections,
    setNow: (value) => {
      now = value;
    },
    now: () => now,
    get room() {
      return Object.values(service.data.rooms)[0];
    },
  };
  result.command = async (playerId, type, payload = {}) => {
    const room = service.currentRoom(playerId);
    const envelope = {
      protocolVersion: 1,
      kind: "command",
      commandId: randomUUID(),
      type,
      payload,
    };
    if (
      !["CREATE_ROOM", "JOIN_PRIVATE_ROOM", "JOIN_PUBLIC_ROOM"].includes(type)
    )
      Object.assign(envelope, {
        roomId: room.roomId,
        expectedVersion: room.stateVersion,
      });
    return service.command(playerId, connections[playerId], envelope);
  };
  await result.command("A", "CREATE_ROOM", {
    name: "Lifecycle keep",
    visibility: "PRIVATE",
    additionalHumans: humans - 1,
    bots,
  });
  for (const playerId of Object.keys(data.sessions).slice(1))
    await result.command(playerId, "JOIN_PRIVATE_ROOM", {
      code: result.room.privateCode,
    });
  if (start) {
    for (const playerId of Object.keys(data.sessions))
      await result.command(playerId, "SET_READY", { ready: true });
    await result.command("A", "START_MATCH");
  }
  return result;
}

function abandonFixture(room, now = 1_000) {
  room.status = "ABANDONED";
  room.match.phase = "TERMINAL";
  room.match.decision = null;
  room.match.winnerPlayerId = null;
  room.match.terminalReason = "ABANDONED";
  room.lastActivityAt = now;
  assertInvariants(room);
}
function zones(room) {
  return structuredClone({
    draw: room.match.drawPile,
    hands: room.match.handsByPlayer,
    lairs: room.match.lairsByPlayer,
    packet: room.match.packet,
  });
}

test("private codes preserve leading zeroes and retry collisions using randomness independent of gameplay", async () => {
  const values = [7, 7, 7, 42],
    bounds = [];
  const f = await fixture({
    codeRng: {
      int: (max) => {
        bounds.push(max);
        return values.shift();
      },
    },
  });
  assert.equal(f.room.privateCode, "000007");
  assert.equal(f.service.code(f.service.data), "000042");
  assert.deepEqual(bounds, [1_000_000, 1_000_000, 1_000_000, 1_000_000]);
});

test("one hundred code collisions fail creation without partial room, membership, or receipt", async () => {
  let attempts = 0;
  const f = await fixture({
    codeRng: {
      int: () => {
        attempts++;
        return 7;
      },
    },
  });
  f.service.data.sessions.D = {
    playerId: "D",
    displayName: "D",
    roomId: null,
    expiresAt: 31 * 86400000,
  };
  f.connections.D = {};
  f.service.connections.set("D", f.connections.D);
  await f.service.commit(structuredClone(f.service.data));
  const before = structuredClone(f.service.data);
  attempts = 0;
  await assert.rejects(
    f.command("D", "CREATE_ROOM", {
      name: "Colliding keep",
      visibility: "PRIVATE",
      additionalHumans: 1,
      bots: 0,
    }),
    { code: "ROOM_UNAVAILABLE" },
  );
  assert.equal(attempts, 100);
  assert.deepEqual(f.service.data, before);
  assert.deepEqual(await f.store.load(), before);
});

test("lobby host departure selects earliest remaining human even when that human is disconnected", async () => {
  const f = await fixture();
  await f.service.disconnected("B", f.connections.B);
  await f.command("A", "LEAVE_ROOM");
  assert.equal(f.room.hostPlayerId, "B");
  assert.deepEqual(
    f.room.seats.map((s) => s.seatIndex),
    [1, 2],
  );
  f.setNow(61_000);
  await f.service.tick();
  assert.equal(f.room.hostPlayerId, "C");
  assert.equal(f.service.data.sessions.B.roomId, null);
});

test("live host departure waits sixty seconds and transfers only to a connected human", async () => {
  const f = await fixture({ start: true });
  await f.service.disconnected("B", f.connections.B);
  await f.command("A", "LEAVE_ROOM");
  assert.equal(f.room.hostPlayerId, "A");
  f.setNow(60_999);
  await f.service.tick();
  assert.equal(f.room.hostPlayerId, "A");
  f.setNow(61_000);
  await f.service.tick();
  assert.equal(f.room.hostPlayerId, "C");
  assert.deepEqual(
    f.room.seats.map((s) => s.seatIndex),
    [0, 1, 2],
  );
  f.service.connections.set("A", f.connections.A);
  await f.service.connected("A", f.connections.A);
  assert.equal(f.room.hostPlayerId, "C");
});

test("live host remains unchanged when no connected successor exists", async () => {
  const f = await fixture({ start: true });
  for (const playerId of ["A", "B", "C"])
    await f.service.disconnected(playerId, f.connections[playerId]);
  f.setNow(61_000);
  await f.service.tick();
  assert.equal(f.room.hostPlayerId, "A");
  assert.equal(f.room.noHumansSince, 1_000);
  assert.equal(f.room.status, "PLAYING");
});

test("lobby configuration edits preserve feasible seat positions and bot identities", async () => {
  const f = await fixture({ humans: 3, bots: 1 });
  await f.command("A", "LEAVE_ROOM");
  const before = f.room.seats.map((s) => ({
    playerId: s.playerId,
    seatIndex: s.seatIndex,
  }));
  await f.command("B", "UPDATE_ROOM", {
    name: "Renamed keep",
    visibility: "PRIVATE",
    additionalHumans: 2,
    bots: 1,
  });
  assert.deepEqual(
    f.room.seats.map((s) => ({ playerId: s.playerId, seatIndex: s.seatIndex })),
    before,
  );
  assert.ok(
    f.room.seats.filter((s) => s.kind === "HUMAN").every((s) => !s.ready),
  );
  const bot = f.room.seats.find((s) => s.kind === "BOT").playerId;
  await f.command("B", "UPDATE_ROOM", {
    name: "Smaller keep",
    visibility: "PUBLIC",
    additionalHumans: 1,
    bots: 1,
  });
  assert.deepEqual(
    f.room.seats.map((s) => s.seatIndex),
    [0, 1, 2],
  );
  assert.deepEqual(
    f.room.seats.filter((s) => s.kind === "HUMAN").map((s) => s.playerId),
    ["B", "C"],
  );
  assert.equal(f.room.seats.find((s) => s.kind === "BOT").playerId, bot);
  assert.equal(f.room.privateCode, null);
  await assert.rejects(
    f.command("B", "UPDATE_ROOM", {
      name: "Too small",
      visibility: "PUBLIC",
      additionalHumans: 0,
      bots: 1,
    }),
    { code: "ILLEGAL_ACTION" },
  );
});

test("a disconnected lobby closes after seat grace and releases membership, code, and receipts", async () => {
  const f = await fixture({ humans: 2 });
  const roomId = f.room.roomId;
  for (const playerId of ["A", "B"])
    await f.service.disconnected(playerId, f.connections[playerId]);
  f.setNow(60_999);
  await f.service.tick();
  assert.ok(f.service.data.rooms[roomId]);
  f.setNow(61_000);
  await f.service.tick();
  assert.equal(f.service.data.rooms[roomId], undefined);
  assert.ok(
    Object.values(f.service.data.sessions).every((s) => s.roomId === null),
  );
  assert.ok(
    Object.values(f.service.data.receipts).every((r) => r.roomId !== roomId),
  );
});

test("continuous human absence abandons at ten minutes independently of bot actions and preserves card zones", async () => {
  const f = await fixture({ start: true });
  for (const playerId of ["A", "B", "C"])
    await f.service.disconnected(playerId, f.connections[playerId]);
  f.setNow(600_999);
  await f.service.tick();
  assert.equal(f.room.status, "PLAYING");
  const before = zones(f.room);
  f.setNow(601_000);
  await f.service.tick();
  assert.equal(f.room.status, "ABANDONED");
  assert.equal(f.room.match.decision, null);
  assert.equal(f.room.match.winnerPlayerId, null);
  assert.deepEqual(zones(f.room), before);
  assert.equal(f.service.botJobs.has(f.room.roomId), false);
  assertInvariants(f.room);
});

test("a returning human resets the continuous-absence abandonment clock", async () => {
  const f = await fixture({ start: true });
  for (const playerId of ["A", "B", "C"])
    await f.service.disconnected(playerId, f.connections[playerId]);
  f.setNow(590_000);
  f.service.connections.set("C", f.connections.C);
  await f.service.connected("C", f.connections.C);
  assert.equal(f.room.noHumansSince, null);
  await f.service.disconnected("C", f.connections.C);
  assert.equal(f.room.noHumansSince, 590_000);
  f.setNow(601_000);
  await f.service.tick();
  assert.equal(f.room.status, "PLAYING");
});

test("terminal room inactivity expires after thirty minutes even if a member left the tab connected", async () => {
  const f = await fixture({ start: true });
  const roomId = f.room.roomId;
  abandonFixture(f.room);
  await f.service.commit(structuredClone(f.service.data));
  f.setNow(1_800_999);
  await f.service.tick();
  assert.ok(f.service.data.rooms[roomId]);
  f.setNow(1_801_000);
  await f.service.tick();
  assert.equal(f.service.data.rooms[roomId], undefined);
  assert.ok(
    Object.values(f.service.data.sessions).every((s) => s.roomId === null),
  );
});

test("rematch preserves room settings and seat order, removes absent memberships, and resets readiness and epochs", async () => {
  const f = await fixture({ humans: 3, bots: 1, start: true });
  const prior = {
    code: f.room.privateCode,
    additional: f.room.configuredAdditionalHumans,
    bots: f.room.configuredBots,
    matchId: f.room.match.matchId,
  };
  await f.service.disconnected("B", f.connections.B);
  abandonFixture(f.room);
  await f.command("A", "RETURN_TO_LOBBY");
  assert.equal(f.room.status, "LOBBY");
  assert.equal(f.room.match, null);
  assert.equal(f.room.privateCode, prior.code);
  assert.equal(f.room.configuredAdditionalHumans, prior.additional);
  assert.equal(f.room.configuredBots, prior.bots);
  assert.deepEqual(
    f.room.seats.map((s) => s.seatIndex),
    [0, 2, 3],
  );
  assert.equal(f.service.data.sessions.B.roomId, null);
  assert.ok(f.room.seats.every((s) => s.ready === (s.kind === "BOT")));
  assert.ok(
    f.room.seats.every(
      (s) => s.controllerMode === (s.kind === "BOT" ? "BOT" : "HUMAN"),
    ),
  );
  f.service.connections.set("B", f.connections.B);
  await f.command("B", "JOIN_PRIVATE_ROOM", { code: f.room.privateCode });
  assert.equal(f.room.seats.find((s) => s.playerId === "B").seatIndex, 1);
  for (const playerId of ["A", "B", "C"])
    await f.command(playerId, "SET_READY", { ready: true });
  await f.command("A", "START_MATCH");
  assert.notEqual(f.room.match.matchId, prior.matchId);
  assert.equal(f.room.match.turnNumber, 1);
  assertInvariants(f.room);
});

test("startup durably quarantines a corrupt match even when no presence fields change", async () => {
  const f = await fixture({ start: true });
  for (const playerId of ["A", "B", "C"])
    await f.service.disconnected(playerId, f.connections[playerId]);
  const persisted = await f.store.load();
  const room = Object.values(persisted.rooms)[0];
  room.match.drawPile.pop();
  const oldVersion = room.stateVersion;
  const recoveredStore = new MemoryStore(persisted);
  const service = new RoomService(recoveredStore, {
    clock: { now: () => 2_000 },
    rng: { int: () => 0 },
  });
  await service.init();
  const recovered = Object.values((await recoveredStore.load()).rooms)[0];
  assert.equal(recovered.status, "ERROR");
  assert.equal(recovered.match.phase, "TERMINAL");
  assert.equal(recovered.match.decision, null);
  assert.equal(recovered.match.terminalReason, "INTERNAL_ERROR");
  assert.equal(recovered.stateVersion, oldVersion + 1);
  assert.equal(
    recovered.match.drawPile.length,
    room.match.drawPile.length,
    "Quarantine must not invent or discard cards to repair a corrupt deck",
  );
  assert.match(recovered.incidentId, /^[a-f0-9-]{36}$/);
  assert.equal(service.botJobs.size, 0);
});

test("a member can leave a quarantined ERROR room while its corrupt diagnostic match remains unchanged", async () => {
  const f = await fixture({ start: true });
  const broken = Object.keys(f.room.match.cardsByInternalId)[0];
  delete f.room.match.cardsByInternalId[broken];
  f.service.errorRoom(f.room);
  await f.service.commit(structuredClone(f.service.data));
  const before = structuredClone(f.room.match);
  const ack = await f.command("A", "LEAVE_ROOM");
  assert.equal(ack.status, "ACCEPTED");
  assert.equal(f.service.data.sessions.A.roomId, null);
  assert.deepEqual(f.room.match, before);
  assert.equal(f.room.status, "ERROR");
});

for (const policy of [
  () => {
    throw new Error("Policy failed");
  },
  () => null,
  () => ({
    type: "SEND_PACKET",
    payload: { orderedHandCardHandles: ["invalid"] },
  }),
]) {
  test("a failed bot policy immediately uses one ordinary fallback and commits a durable receipt", async () => {
    const f = await fixture({
      humans: 1,
      bots: 1,
      start: true,
      botPolicy: policy,
      timingOverrides: { botDelayMin: 10, botDelayMax: 10 },
    });
    await f.command("A", "LEAVE_ROOM");
    const before = f.room.match.drawPile.length;
    await f.service.tick();
    f.setNow(1_011);
    await f.service.tick();
    assert.equal(f.room.match.drawPile.length, before - 1);
    assert.equal(f.room.match.turnNumber, 2);
    assert.equal(f.room.status, "PLAYING");
    assert.equal(
      Object.keys(f.service.data.receipts).filter((key) =>
        key.startsWith("bot:"),
      ).length,
      1,
    );
    assertInvariants(f.room);
  });
}

test("watchdog uses fallback before the bot deadline without re-invoking a delayed policy", async () => {
  let called = 0;
  const f = await fixture({
    humans: 1,
    bots: 1,
    start: true,
    botPolicy: () => {
      called++;
      throw new Error("Should not run at watchdog");
    },
    timingOverrides: { botDelayMin: 100_000, botDelayMax: 100_000 },
  });
  await f.command("A", "LEAVE_ROOM");
  const before = f.room.match.drawPile.length;
  f.setNow(f.room.match.decision.deadlineAt - 250);
  await f.service.tick();
  assert.equal(called, 0);
  assert.equal(f.room.match.drawPile.length, before - 1);
  assert.equal(f.room.match.turnNumber, 2);
});

test("expired bot deadline is replaced and immediately resolved by a fallback in one committed version", async () => {
  const f = await fixture({ humans: 1, bots: 1, start: true });
  await f.command("A", "LEAVE_ROOM");
  const before = {
    version: f.room.stateVersion,
    draw: f.room.match.drawPile.length,
    decision: f.room.match.decision.decisionId,
  };
  f.setNow(f.room.match.decision.deadlineAt);
  await f.service.tick();
  assert.equal(f.room.stateVersion, before.version + 1);
  assert.equal(f.room.match.drawPile.length, before.draw - 1);
  assert.equal(f.room.match.turnNumber, 2);
  assert.notEqual(f.room.match.decision.decisionId, before.decision);
  assert.equal(f.room.match.decision.deadlineAt, f.now() + 5_000);
});

test("bot persistence failure broadcasts no speculative state and retries the unchanged decision", async () => {
  const f = await fixture({
    humans: 1,
    bots: 1,
    start: true,
    timingOverrides: { botDelayMin: 0, botDelayMax: 0 },
  });
  await f.command("A", "LEAVE_ROOM");
  const before = structuredClone(f.service.data);
  let published = 0;
  f.service.publish = () => {
    published++;
  };
  f.store.failCommits = true;
  await assert.rejects(f.service.tick(), /Persistence unavailable/);
  assert.deepEqual(f.service.data, before);
  assert.equal(published, 0);
  f.store.failCommits = false;
  await f.service.tick();
  assert.equal(f.room.match.turnNumber, 2);
  assert.equal(published, 1);
});
