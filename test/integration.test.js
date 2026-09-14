import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApplication } from "../server/app.js";
import { MemoryStore } from "../server/persistence.js";
import { connect, rejectedUpgrade } from "./helpers/wire.js";

const slowTiming = {
  active: 600_000,
  recipient: 600_000,
  bot: 600_000,
  botDelayMin: 600_000,
  botDelayMax: 600_000,
  lobbyGrace: 600_000,
  hostGrace: 600_000,
  abandon: 600_000,
};

async function fixture(t, options = {}) {
  const store = options.store ?? new MemoryStore();
  const app = await createApplication({
    store,
    timingOverrides: slowTiming,
    ...options,
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const clients = [];
  let closed = false;
  const result = {
    app,
    store,
    baseUrl,
    clients,
    async client(credentials) {
      const client = await connect(baseUrl, credentials);
      clients.push(client);
      return client;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const client of clients) client.close();
      await app.close();
    },
  };
  t.after(() => result.close());
  return result;
}

async function roomFixture(
  t,
  { humans = 3, visibility = "PRIVATE", start = true, ...options } = {},
) {
  const f = await fixture(t, options);
  const clients = await Promise.all(
    Array.from({ length: humans }, () => f.client()),
  );
  const [host] = clients;
  await host.accepted("CREATE_ROOM", {
    name: "Wire test dragons",
    visibility,
    additionalHumans: humans - 1,
    bots: 0,
  });
  for (const client of clients.slice(1)) {
    const response =
      visibility === "PRIVATE"
        ? await client.accepted("JOIN_PRIVATE_ROOM", {
            code: host.view.room.code,
          })
        : await client.accepted("JOIN_PUBLIC_ROOM", {
            roomId: host.view.roomId,
          });
    await host.version(response.committedVersion);
  }
  await Promise.all(
    clients.map((client) => client.version(host.view.stateVersion)),
  );
  if (start) {
    for (const client of clients) {
      await client.version(host.view.stateVersion);
      const response = await client.accepted("SET_READY", { ready: true });
      await Promise.all(
        clients.map((peer) => peer.version(response.committedVersion)),
      );
    }
    const response = await host.accepted("START_MATCH");
    await Promise.all(
      clients.map((peer) => peer.version(response.committedVersion)),
    );
  }
  return { ...f, host, players: clients };
}

function activeClient(clients) {
  return clients.find(
    (client) => client.session.playerId === client.view.game.decision.playerId,
  );
}

function assertPrivateViews(clients) {
  const privateKeys = new Set([
    "cardsByInternalId",
    "handsByPlayer",
    "lairsByPlayer",
    "drawPile",
    "orderedCardIds",
    "handHandles",
    "handlesByPlayer",
    "handHandlesByPlayer",
    "tokenVerifier",
    "sessions",
    "receipts",
    "randomOutcomes",
    "seed",
    "internalCardId",
  ]);
  const inspect = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(
        !privateKeys.has(key),
        `Private canonical field leaked: ${key}`,
      );
      inspect(child);
    }
  };
  for (const client of clients) {
    const view = client.view;
    inspect(view);
    assert.equal(view.self.playerId, client.session.playerId);
    assert.ok(Array.isArray(view.self.hand));
    for (const player of view.players) {
      assert.ok(!("hand" in player));
      assert.ok(!("cards" in player));
      assert.equal(typeof player.handCount, "number");
    }
    if (view.game.packet) {
      assert.deepEqual(Object.keys(view.game.packet).sort(), [
        "count",
        "originPlayerId",
        "recipientPlayerId",
      ]);
    }
    for (const other of clients.filter((peer) => peer !== client)) {
      for (const card of other.view.self.hand) {
        assert.ok(
          !JSON.stringify(view).includes(card.handle),
          "Another player received an owner-only card handle",
        );
      }
    }
  }
}

test("guest sessions use protected cookies, stable ownership, bounded names, and authenticated same-origin upgrades", async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.baseUrl}/api/session`);
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.equal(typeof session.playerId, "string");
  const setCookie = response.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=(Strict|Lax)/i);
  const cookie = setCookie.split(";")[0];
  assert.ok(cookie.split("=")[1].length >= 32);
  const again = await fetch(`${f.baseUrl}/api/session`, {
    headers: { Cookie: cookie },
  });
  assert.equal((await again.json()).playerId, session.playerId);

  const renamed = await fetch(`${f.baseUrl}/api/session`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: f.baseUrl,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ displayName: "A dragon" }),
  });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).displayName, "A dragon");
  const invalidName = await fetch(`${f.baseUrl}/api/session`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: f.baseUrl,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ displayName: "x".repeat(25) }),
  });
  assert.equal(invalidName.status, 400);
  assert.equal(await rejectedUpgrade(f.baseUrl), 401);
  assert.equal(
    await rejectedUpgrade(f.baseUrl, {
      cookie,
      origin: "https://unrelated.example",
    }),
    403,
  );
  assert.equal(
    await rejectedUpgrade(f.baseUrl, { cookie: "keep_session=invalid" }),
    401,
  );
  assert.ok(
    [400, 426].includes(
      await rejectedUpgrade(f.baseUrl, { cookie, version: 2 }),
    ),
  );
});

test("exact schemas reject actor impersonation, undeclared state, malformed room counts, and internal commands", async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  const create = {
    name: "Validation room",
    visibility: "PRIVATE",
    additionalHumans: 1,
    bots: 0,
  };
  await client.rejected(
    "CREATE_ROOM",
    { ...create, bots: 0.5 },
    "INVALID_MESSAGE",
  );
  await client.rejected(
    "CREATE_ROOM",
    { ...create, additionalHumans: 0 },
    "INVALID_MESSAGE",
  );
  await client.rejected(
    "CREATE_ROOM",
    { ...create, bots: 6 },
    "INVALID_MESSAGE",
  );
  await client.rejected(
    "CREATE_ROOM",
    { ...create, name: "x".repeat(49) },
    "INVALID_MESSAGE",
  );
  await client.rejected("CREATE_ROOM", create, "INVALID_MESSAGE", {
    actorId: "someone-else",
  });
  await client.rejected(
    "CREATE_ROOM",
    { ...create, shuffleSeed: 1 },
    "INVALID_MESSAGE",
  );
  await client.rejected("DECISION_TIMEOUT", {}, "INVALID_MESSAGE");
  await client.rejected("__proto__", {}, "INVALID_MESSAGE");
  await client.rejected("constructor", {}, "INVALID_MESSAGE");
  await client.rejected("CREATE_ROOM", create, "INVALID_MESSAGE", {
    type: ["CREATE_ROOM"],
  });
  assert.equal(Object.keys(f.store.data.rooms).length, 0);
});

test("create receipts are durable and content-sensitive; discovery excludes private rooms and codes", async (t) => {
  const f = await fixture(t);
  const [privateHost, publicHost, browser] = await Promise.all([
    f.client(),
    f.client(),
    f.client(),
  ]);
  const command = privateHost.envelope("CREATE_ROOM", {
    name: "Secret lair",
    visibility: "PRIVATE",
    additionalHumans: 1,
    bots: 0,
  });
  const first = await privateHost.send(command);
  assert.equal(first.kind, "ack");
  const firstRoom = privateHost.view.roomId;
  assert.match(privateHost.view.room.code, /^\d{6}$/);
  const duplicate = await privateHost.send(command);
  assert.equal(duplicate.kind, "ack");
  assert.equal(duplicate.committedVersion, first.committedVersion);
  assert.equal(privateHost.view.roomId, firstRoom);
  assert.equal(Object.keys(f.store.data.rooms).length, 1);
  const reused = await privateHost.send({
    ...command,
    payload: { ...command.payload, name: "Changed" },
  });
  assert.equal(reused.code, "COMMAND_ID_REUSED");

  await publicHost.accepted("CREATE_ROOM", {
    name: "Visible lair",
    visibility: "PUBLIC",
    additionalHumans: 1,
    bots: 1,
  });
  const listing = await browser.read("LIST_PUBLIC_ROOMS");
  assert.equal(listing.kind, "public_rooms");
  assert.equal(listing.rooms.length, 1);
  assert.equal(listing.rooms[0].roomId, publicHost.view.roomId);
  assert.ok(!JSON.stringify(listing).includes(firstRoom));
  assert.ok(!JSON.stringify(listing).includes(privateHost.view.room.code));
  assert.ok(!JSON.stringify(listing).includes("hand"));
  const denied = await browser.read("REQUEST_SNAPSHOT", { roomId: firstRoom });
  assert.equal(denied.kind, "error");
  assert.equal(denied.code, "NOT_A_MEMBER");
  assert.ok(!JSON.stringify(denied).includes(privateHost.view.room.code));
});

test("two private joins racing for the last human seat commit exactly one membership", async (t) => {
  const f = await fixture(t);
  const [host, left, right] = await Promise.all([
    f.client(),
    f.client(),
    f.client(),
  ]);
  await host.accepted("CREATE_ROOM", {
    name: "Last seat",
    visibility: "PRIVATE",
    additionalHumans: 1,
    bots: 0,
  });
  const joins = await Promise.all(
    [left, right].map((client) =>
      client.command("JOIN_PRIVATE_ROOM", { code: host.view.room.code }),
    ),
  );
  assert.equal(joins.filter((result) => result.kind === "ack").length, 1);
  assert.equal(
    joins.filter((result) => result.code === "ROOM_UNAVAILABLE").length,
    1,
  );
  await host.version(
    joins.find((result) => result.kind === "ack").committedVersion,
  );
  assert.equal(host.view.players.filter((player) => player.playerId).length, 2);
  const outsider = joins[0].kind === "error" ? left : right;
  const denied = await outsider.read("REQUEST_SNAPSHOT", {
    roomId: host.view.roomId,
  });
  assert.equal(denied.code, "NOT_A_MEMBER");
});

test("starting requires all humans ready and connected; concurrent starts and exact retries deal once", async (t) => {
  const f = await roomFixture(t, { start: false });
  await f.host.rejected("START_MATCH", {}, "NOT_READY");
  const [, guest] = f.players;
  await guest.rejected("START_MATCH", {}, "NOT_HOST");
  for (const client of f.players) {
    await client.version(f.host.view.stateVersion);
    const ready = await client.accepted("SET_READY", { ready: true });
    await Promise.all(
      f.players.map((peer) => peer.version(ready.committedVersion)),
    );
  }
  const start = f.host.envelope("START_MATCH");
  const responses = await Promise.all([
    f.host.send(start),
    f.host.send({ ...start, commandId: `${start.commandId}-other` }),
  ]);
  assert.equal(responses.filter((result) => result.kind === "ack").length, 1);
  assert.equal(responses.filter((result) => result.kind === "error").length, 1);
  const accepted = responses.find((result) => result.kind === "ack");
  await Promise.all(
    f.players.map((peer) => peer.version(accepted.committedVersion)),
  );
  const matchId = f.host.view.matchId;
  const repeat = await f.host.send(start);
  assert.equal(repeat.kind, "ack");
  assert.equal(repeat.committedVersion, accepted.committedVersion);
  assert.equal(f.host.view.matchId, matchId);
  for (const player of f.players) assert.equal(player.view.self.hand.length, 3);
  assert.equal(f.host.view.game.drawPileCount, 9);
  assertPrivateViews(f.players);
});

test("three actual clients receive only their own hands; drawing is private and duplicate-safe", async (t) => {
  const f = await roomFixture(t);
  assertPrivateViews(f.players);
  const drawer = activeClient(f.players);
  const before = structuredClone(drawer.view);
  const ownHandles = new Set(before.self.hand.map((card) => card.handle));
  const othersBefore = f.players
    .filter((client) => client !== drawer)
    .map((client) => structuredClone(client.view.self.hand));
  const draw = drawer.envelope("DRAW_CARD");
  const response = await drawer.send(draw);
  assert.equal(response.kind, "ack");
  await Promise.all(
    f.players.map((client) => client.version(response.committedVersion)),
  );
  assert.equal(drawer.view.self.hand.length, 4);
  assert.equal(drawer.view.game.drawPileCount, before.game.drawPileCount - 1);
  assert.notEqual(drawer.view.game.activePlayerId, before.game.activePlayerId);
  const drawn = drawer.view.self.hand.find(
    (card) => !ownHandles.has(card.handle),
  );
  assert.ok(drawn);
  for (const [index, other] of f.players
    .filter((client) => client !== drawer)
    .entries()) {
    assert.deepEqual(other.view.self.hand, othersBefore[index]);
    assert.ok(!JSON.stringify(other.view).includes(drawn.handle));
  }
  const publicDraw = drawer.view.recentPublicLog
    .filter((event) => event.type === "PlayerDrewCard")
    .at(-1);
  assert.ok(publicDraw, "An accepted draw produces a safe public event");
  assert.ok(!("cardType" in publicDraw));
  assert.ok(!("card" in publicDraw));
  assert.ok(!("handle" in publicDraw));
  const current = structuredClone(drawer.view);
  const repeated = await drawer.send(draw);
  assert.equal(repeated.kind, "ack");
  assert.equal(repeated.committedVersion, response.committedVersion);
  assert.deepEqual(drawer.view.self.hand, current.self.hand);
  assert.equal(drawer.view.game.drawPileCount, current.game.drawPileCount);
  assertPrivateViews(f.players);
});

test("foreign handles, wrong actors, stale versions, and stale decisions cannot mutate or disclose a hand", async (t) => {
  const f = await roomFixture(t);
  const actor = activeClient(f.players);
  const other = f.players.find((client) => client !== actor);
  const before = structuredClone(actor.view);
  await other.rejected("DRAW_CARD", {}, "NOT_YOUR_DECISION");
  await actor.rejected(
    "SEND_PACKET",
    { orderedHandCardHandles: [other.view.self.hand[0].handle] },
    "INVALID_SELECTION",
  );
  await actor.rejected(
    "SEND_PACKET",
    {
      orderedHandCardHandles: [
        actor.view.self.hand[0].handle,
        actor.view.self.hand[0].handle,
      ],
    },
    "INVALID_SELECTION",
  );
  await actor.rejected(
    "SEND_PACKET",
    { orderedHandCardHandles: [] },
    "INVALID_SELECTION",
  );
  await actor.rejected("DRAW_CARD", {}, "STALE_STATE", {
    expectedVersion: before.stateVersion - 1,
  });
  await actor.rejected("DRAW_CARD", {}, "WRONG_MATCH", {
    matchId: "other-match",
  });
  await actor.rejected("DRAW_CARD", {}, "WRONG_DECISION", {
    decisionId: "other-decision",
  });
  await actor.rejected("DRAW_CARD", {}, "INVALID_MESSAGE", {
    playerId: other.session.playerId,
  });
  const snapshot = await actor.read("REQUEST_SNAPSHOT", {
    roomId: actor.view.roomId,
  });
  assert.equal(snapshot.view.stateVersion, before.stateVersion);
  assert.deepEqual(snapshot.view.self.hand, before.self.hand);
  assertPrivateViews(f.players);
});

test("packet contents stay hidden after sending, passing retains origin, and reconnect preserves personal state", async (t) => {
  const f = await roomFixture(t);
  const sender = activeClient(f.players);
  const handles = sender.view.self.hand.map((card) => card.handle);
  const sent = await sender.accepted("SEND_PACKET", {
    orderedHandCardHandles: handles,
  });
  await Promise.all(
    f.players.map((client) => client.version(sent.committedVersion)),
  );
  assert.equal(sender.view.self.hand.length, 0);
  assert.equal(sender.view.game.packet.count, 3);
  assert.equal(sender.view.game.packet.originPlayerId, sender.session.playerId);
  assert.equal(sender.view.game.activePlayerId, sender.session.playerId);
  for (const client of f.players) {
    for (const handle of handles)
      assert.ok(!JSON.stringify(client.view).includes(handle));
  }
  assertPrivateViews(f.players);
  const receiver = activeClient(f.players);
  const passed = await receiver.accepted("PASS_PACKET");
  await Promise.all(
    f.players.map((client) => client.version(passed.committedVersion)),
  );
  assert.equal(sender.view.game.packet.count, 3);
  assert.equal(sender.view.game.activePlayerId, sender.session.playerId);
  assert.notEqual(
    sender.view.game.decision.playerId,
    receiver.session.playerId,
  );
  const current = structuredClone(receiver.view);
  const replacement = await f.client({
    cookie: receiver.cookie,
    session: receiver.session,
  });
  await replacement.waitFor((message) => message.kind === "snapshot");
  assert.equal(replacement.view.roomId, current.roomId);
  assert.equal(replacement.view.matchId, current.matchId);
  assert.deepEqual(replacement.view.self.hand, current.self.hand);
  assert.deepEqual(replacement.view.game.packet, current.game.packet);
  assert.equal(
    replacement.view.game.decision.deadlineAt,
    current.game.decision.deadlineAt,
  );
  await receiver.waitFor(
    (message) =>
      message.code === "CONTROL_MOVED" || message.kind === "control_moved",
  );
  assertPrivateViews([
    replacement,
    ...f.players.filter((client) => client !== receiver),
  ]);
});

test("committed draw and receipt survive authority restart without redealing or replaying the draw", async (t) => {
  const f = await roomFixture(t);
  const actor = activeClient(f.players);
  const draw = actor.envelope("DRAW_CARD");
  const ack = await actor.send(draw);
  assert.equal(ack.kind, "ack");
  const committed = structuredClone(actor.view);
  const credentials = { cookie: actor.cookie, session: actor.session };
  const persisted = structuredClone(await f.store.load());
  await f.close();
  const recovered = await fixture(t, { store: new MemoryStore(persisted) });
  const client = await recovered.client(credentials);
  await client.waitFor((message) => message.kind === "snapshot");
  assert.equal(client.view.matchId, committed.matchId);
  assert.deepEqual(client.view.self.hand, committed.self.hand);
  assert.equal(client.view.game.drawPileCount, committed.game.drawPileCount);
  assert.equal(
    client.view.game.decision.decisionId,
    committed.game.decision.decisionId,
  );
  assert.equal(
    client.view.game.decision.deadlineAt,
    committed.game.decision.deadlineAt,
  );
  const duplicate = await client.send(draw);
  assert.equal(duplicate.kind, "ack");
  assert.equal(duplicate.committedVersion, ack.committedVersion);
  assert.deepEqual(client.view.self.hand, committed.self.hand);
  assert.equal(client.view.game.drawPileCount, committed.game.drawPileCount);
});

test("persistence failure produces no success, no speculative snapshot, and permits retry after restoration", async (t) => {
  const f = await roomFixture(t);
  const actor = activeClient(f.players);
  const before = structuredClone(actor.view);
  const persisted = structuredClone(await f.store.load());
  const command = actor.envelope("DRAW_CARD");
  const messageCounts = f.players.map((client) => client.messages.length);
  f.store.failCommits = true;
  const rejected = await actor.send(command);
  assert.equal(rejected.kind, "error");
  assert.notEqual(rejected.code, "INVALID_MESSAGE");
  assert.deepEqual(await f.store.load(), persisted);
  for (const [index, client] of f.players.entries()) {
    const broadcasts = client.messages
      .slice(messageCounts[index])
      .filter((message) => message.kind === "snapshot");
    for (const snapshot of broadcasts)
      assert.equal(snapshot.view.stateVersion, before.stateVersion);
  }
  f.store.failCommits = false;
  const retried = await actor.send(command);
  assert.equal(retried.kind, "ack");
  assert.equal(actor.view.self.hand.length, before.self.hand.length + 1);
  assert.equal(actor.view.game.drawPileCount, before.game.drawPileCount - 1);
});

test("database exception codes and messages stay private in both HTTP and WebSocket errors", async (t) => {
  const f = await roomFixture(t);
  const actor = activeClient(f.players);
  const privateMessage =
    "relation confidential_passwords_123 does not exist for postgres://secret-credential";
  f.store.commit = async () => {
    throw Object.assign(new Error(privateMessage), { code: "42P01" });
  };
  const failed = await actor.command("DRAW_CARD");
  assert.equal(failed.kind, "error");
  assert.equal(failed.code, "PERSISTENCE_UNAVAILABLE");
  assert.ok(!JSON.stringify(failed).includes("confidential_passwords_123"));
  assert.ok(!JSON.stringify(failed).includes("secret-credential"));
  assert.ok(failed.incidentId);
  const response = await fetch(`${f.baseUrl}/api/session`, {
    headers: { Cookie: actor.cookie },
  });
  assert.equal(response.status, 503);
  const error = await response.text();
  assert.ok(!error.includes("confidential_passwords_123"));
  assert.ok(!error.includes("secret-credential"));
  assert.ok(!error.includes("42P01"));
});

test("a committed transaction with a lost acknowledgment recovers its receipt and applies an uncertain draw once", async (t) => {
  const f = await roomFixture(t);
  const actor = activeClient(f.players);
  const before = structuredClone(actor.view);
  const command = actor.envelope("DRAW_CARD");
  const originalCommit = f.store.commit.bind(f.store);
  let loseReply = true;
  f.store.commit = async (data) => {
    await originalCommit(data);
    if (loseReply) {
      loseReply = false;
      throw new Error(
        "Simulated process loss after durable commit and before acknowledgment",
      );
    }
  };
  const uncertain = await actor.send(command);
  assert.equal(uncertain.kind, "error");
  const committed = await f.store.load();
  await f.close();
  const recovered = await fixture(t, { store: new MemoryStore(committed) });
  const client = await recovered.client({
    cookie: actor.cookie,
    session: actor.session,
  });
  await client.waitFor((message) => message.kind === "snapshot");
  assert.equal(client.view.self.hand.length, before.self.hand.length + 1);
  assert.equal(client.view.game.drawPileCount, before.game.drawPileCount - 1);
  const repeat = await client.send(command);
  assert.equal(repeat.kind, "ack");
  assert.equal(repeat.committedVersion, before.stateVersion + 1);
  assert.equal(client.view.self.hand.length, before.self.hand.length + 1);
  assert.equal(client.view.game.drawPileCount, before.game.drawPileCount - 1);
});

test("random taking crosses the actual wire privately, validates largest donors, and has a duplicate-safe receipt", async (t) => {
  const source = await roomFixture(t, { humans: 6 });
  const active = activeClient(source.players);
  const credentials = source.players.map((client) => ({
    cookie: client.cookie,
    session: client.session,
  }));
  const persisted = await source.store.load();
  const room = persisted.rooms[active.view.roomId];
  const match = room.match;
  const donorId = match.seatOrder.find(
    (playerId) => playerId !== active.session.playerId,
  );
  // Arrange a valid empty-hand/empty-deck state in protected test persistence.
  // Production clients have no route that accepts this state.
  for (const [index, cardId] of match.handsByPlayer[active.session.playerId]
    .splice(0)
    .entries()) {
    match.handsByPlayer[donorId].push(cardId);
    match.handHandlesByPlayer[donorId][`fixture-private-handle-${index}`] =
      cardId;
  }
  match.handHandlesByPlayer[active.session.playerId] = {};
  await source.close();
  const f = await fixture(t, {
    store: new MemoryStore(persisted),
    rng: { int: () => 0 },
  });
  const clients = await Promise.all(credentials.map((item) => f.client(item)));
  await Promise.all(
    clients.map((client) =>
      client.waitFor((message) => message.kind === "snapshot"),
    ),
  );
  const actor = clients.find(
    (client) => client.session.playerId === active.session.playerId,
  );
  const donor = clients.find((client) => client.session.playerId === donorId);
  const latest = Math.max(...clients.map((client) => client.view.stateVersion));
  await Promise.all(clients.map((client) => client.version(latest)));
  assert.deepEqual(actor.view.allowedCommands.legalTakeTargetPlayerIds, [
    donorId,
  ]);
  const invalidDonor = clients.find(
    (client) =>
      ![donorId, active.session.playerId].includes(client.session.playerId),
  );
  await actor.rejected(
    "TAKE_RANDOM_CARD",
    { targetPlayerId: invalidDonor.session.playerId },
    "INVALID_TARGET",
  );
  const previousDonorHand = structuredClone(donor.view.self.hand);
  const command = actor.envelope("TAKE_RANDOM_CARD", {
    targetPlayerId: donorId,
  });
  const take = await actor.send(command);
  assert.equal(take.kind, "ack");
  await Promise.all(
    clients.map((client) => client.version(take.committedVersion)),
  );
  assert.equal(actor.view.self.hand.length, 1);
  assert.equal(donor.view.self.hand.length, 5);
  const removed = previousDonorHand.find(
    (card) =>
      !donor.view.self.hand.some((current) => current.handle === card.handle),
  );
  assert.equal(actor.view.self.hand[0].type, removed.type);
  assert.notEqual(actor.view.self.hand[0].handle, removed.handle);
  const takenEvent = actor.view.recentPublicLog.findLast(
    (event) => event.type === "RandomCardTaken",
  );
  assert.ok(takenEvent);
  assert.ok(!("cardType" in takenEvent));
  assert.ok(!("handle" in takenEvent));
  assertPrivateViews(clients);
  const duplicate = await actor.send(command);
  assert.equal(duplicate.kind, "ack");
  assert.equal(duplicate.committedVersion, take.committedVersion);
  assert.equal(actor.view.self.hand.length, 1);
  assert.equal(donor.view.self.hand.length, 5);
});

test("winning reveal ends circulation immediately, terminal snapshots stay private, and rematches reject old epochs", async (t) => {
  const source = await roomFixture(t);
  const current = activeClient(source.players);
  const credentials = source.players.map((client) => ({
    cookie: client.cookie,
    session: client.session,
  }));
  const persisted = await source.store.load();
  const room = persisted.rooms[current.view.roomId];
  const match = room.match;
  const senderId = match.activePlayerId;
  const recipientId =
    match.seatOrder[
      (match.seatOrder.indexOf(senderId) + 1) % match.seatOrder.length
    ];
  const treasureIds = Object.keys(match.cardsByInternalId).filter(
    (id) => match.cardsByInternalId[id].type === "TREASURE",
  );
  const goblinId = Object.keys(match.cardsByInternalId).find(
    (id) => match.cardsByInternalId[id].type === "GOBLIN",
  );
  function removeFromZone(cardId) {
    match.drawPile = match.drawPile.filter((id) => id !== cardId);
    for (const playerId of match.seatOrder) {
      match.handsByPlayer[playerId] = match.handsByPlayer[playerId].filter(
        (id) => id !== cardId,
      );
      match.lairsByPlayer[playerId].treasures = match.lairsByPlayer[
        playerId
      ].treasures.filter((id) => id !== cardId);
      match.lairsByPlayer[playerId].goblins = match.lairsByPlayer[
        playerId
      ].goblins.filter((id) => id !== cardId);
      for (const [handle, id] of Object.entries(
        match.handHandlesByPlayer[playerId],
      )) {
        if (id === cardId) delete match.handHandlesByPlayer[playerId][handle];
      }
    }
  }
  for (const treasureId of treasureIds.slice(0, 2)) {
    removeFromZone(treasureId);
    match.lairsByPlayer[recipientId].treasures.push(treasureId);
  }
  for (const [index, cardId] of [treasureIds[2], goblinId].entries()) {
    removeFromZone(cardId);
    match.handsByPlayer[senderId].push(cardId);
    match.handHandlesByPlayer[senderId][`fixture-terminal-handle-${index}`] =
      cardId;
  }
  await source.close();
  const f = await fixture(t, { store: new MemoryStore(persisted) });
  const clients = await Promise.all(credentials.map((item) => f.client(item)));
  await Promise.all(
    clients.map((client) =>
      client.waitFor((message) => message.kind === "snapshot"),
    ),
  );
  await Promise.all(
    clients.map((client) =>
      client.version(
        Math.max(...clients.map((peer) => peer.view.stateVersion)),
      ),
    ),
  );
  const sender = clients.find((client) => client.session.playerId === senderId);
  const recipient = clients.find(
    (client) => client.session.playerId === recipientId,
  );
  const host = clients.find(
    (client) => client.session.playerId === room.hostPlayerId,
  );
  const oldMatchId = sender.view.matchId;
  const send = await sender.accepted("SEND_PACKET", {
    orderedHandCardHandles: [
      "fixture-terminal-handle-0",
      "fixture-terminal-handle-1",
    ],
  });
  await Promise.all(
    clients.map((client) => client.version(send.committedVersion)),
  );
  const reveal = recipient.envelope("REVEAL_PACKET_TOP");
  const win = await recipient.send(reveal);
  assert.equal(win.kind, "ack");
  await Promise.all(
    clients.map((client) => client.version(win.committedVersion)),
  );
  for (const client of clients) {
    assert.equal(client.view.room.status, "FINISHED");
    assert.equal(client.view.game.winnerPlayerId, recipientId);
    assert.equal(client.view.game.decision, null);
    assert.equal(client.view.game.activePlayerId, senderId);
    assert.equal(client.view.game.packet.count, 1);
  }
  assertPrivateViews(clients);
  const duplicate = await recipient.send(reveal);
  assert.equal(duplicate.kind, "ack");
  assert.equal(duplicate.committedVersion, win.committedVersion);
  await recipient.rejected("REVEAL_PACKET_TOP", {}, "MATCH_ENDED", {
    matchId: oldMatchId,
    decisionId: reveal.decisionId,
  });
  const returned = await host.accepted("RETURN_TO_LOBBY");
  await Promise.all(
    clients.map((client) => client.version(returned.committedVersion)),
  );
  for (const client of clients) {
    assert.equal(client.view.room.status, "LOBBY");
    assert.deepEqual(client.view.self.hand, []);
    assert.equal(client.view.game, null);
    assert.ok(client.view.players.every((player) => !player.ready));
  }
  for (const client of clients) {
    const ready = await client.accepted("SET_READY", { ready: true });
    await Promise.all(
      clients.map((peer) => peer.version(ready.committedVersion)),
    );
  }
  const started = await host.accepted("START_MATCH");
  await Promise.all(
    clients.map((client) => client.version(started.committedVersion)),
  );
  assert.notEqual(host.view.matchId, oldMatchId);
  const newActor = activeClient(clients);
  await newActor.rejected("DRAW_CARD", {}, "WRONG_MATCH", {
    matchId: oldMatchId,
  });
  assertPrivateViews(clients);
});

test("expired deadlines serialize before late human input and one reclaim restores control without a new clock", async (t) => {
  let now = Date.now();
  const f = await roomFixture(t, { clock: { now: () => now } });
  const actor = activeClient(f.players);
  const late = actor.envelope("DRAW_CARD");
  now = actor.view.game.decision.deadlineAt;
  await f.app.service.tick();
  await actor.waitFor(
    (message) =>
      message.kind === "snapshot" &&
      message.view.stateVersion > late.expectedVersion,
  );
  const failed = await actor.send(late);
  assert.equal(failed.kind, "error");
  assert.ok(
    [
      "STALE_STATE",
      "WRONG_DECISION",
      "DEADLINE_EXPIRED",
      "ILLEGAL_ACTION",
    ].includes(failed.code),
  );
  const takeover = actor.view;
  assert.equal(takeover.self.controllerMode, "TEMP_BOT");
  const deadline = takeover.game.decision?.deadlineAt;
  await actor.accepted("RECLAIM_CONTROL");
  assert.equal(actor.view.self.controllerMode, "HUMAN");
  if (deadline && actor.view.game.decision?.playerId === actor.session.playerId)
    assert.equal(actor.view.game.decision.deadlineAt, deadline);
});

test("private-code attempts are limited per session and IP without confirming which codes exist", async (t) => {
  let now = Date.now();
  const f = await fixture(t, { clock: { now: () => now } });
  const [first, second] = await Promise.all([f.client(), f.client()]);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await first.rejected(
      "JOIN_PRIVATE_ROOM",
      { code: "000000" },
      "ROOM_UNAVAILABLE",
    );
  }
  await first.rejected("JOIN_PRIVATE_ROOM", { code: "000000" }, "RATE_LIMITED");
  await second.rejected(
    "JOIN_PRIVATE_ROOM",
    { code: "000001" },
    "RATE_LIMITED",
  );
  now += 60_001;
  await second.rejected(
    "JOIN_PRIVATE_ROOM",
    { code: "000001" },
    "ROOM_UNAVAILABLE",
  );
});

test("command bursts are bounded and an oversized frame closes only the offending connection", async (t) => {
  const now = Date.now();
  const f = await fixture(t, { clock: { now: () => now } });
  const [flood, observer] = await Promise.all([f.client(), f.client()]);
  const after = flood.messages.length;
  for (let index = 0; index < 35; index += 1)
    flood.socket.send(
      JSON.stringify({
        protocolVersion: 1,
        kind: "read",
        type: "LIST_PUBLIC_ROOMS",
      }),
    );
  await flood.waitFor(() => flood.messages.length >= after + 35, { after });
  const replies = flood.messages.slice(after);
  assert.equal(
    replies.filter((message) => message.kind === "public_rooms").length,
    30,
  );
  assert.equal(
    replies.filter((message) => message.code === "RATE_LIMITED").length,
    5,
  );
  const closed = once(flood.socket, "close");
  flood.socket.send("x".repeat(16_385));
  const [code] = await closed;
  assert.equal(code, 1009);
  const alive = await observer.read("LIST_PUBLIC_ROOMS");
  assert.equal(alive.kind, "public_rooms");
});

test("a rate-limited well-formed command retains its command identifier for pending-client recovery", async (t) => {
  const now = Date.now();
  const f = await fixture(t, { clock: { now: () => now } });
  const client = await f.client();
  for (let index = 0; index < 30; index += 1)
    await client.read("LIST_PUBLIC_ROOMS");
  const command = client.envelope("CREATE_ROOM", {
    name: "Limited command",
    visibility: "PRIVATE",
    additionalHumans: 1,
    bots: 0,
  });
  const after = client.messages.length;
  client.socket.send(JSON.stringify(command));
  const error = await client.waitFor((message) => message.kind === "error", {
    after,
  });
  assert.equal(error.code, "RATE_LIMITED");
  assert.equal(error.commandId, command.commandId);
  assert.equal(Object.keys(f.store.data.rooms).length, 0);
});

test("a replacement connection fences an older command that was already waiting in the executor queue", async (t) => {
  const f = await roomFixture(t);
  const actor = activeClient(f.players);
  const before = structuredClone(actor.view);
  const command = actor.envelope("DRAW_CARD");
  let releaseQueue;
  const blocked = new Promise((resolve) => {
    releaseQueue = resolve;
  });
  const blocker = f.app.service.queue(() => blocked);
  actor.socket.send(JSON.stringify(command));
  const oldClosed = once(actor.socket, "close");
  const connecting = f.client({ cookie: actor.cookie, session: actor.session });
  await oldClosed;
  releaseQueue();
  await blocker;
  const replacement = await connecting;
  await replacement.waitFor((message) => message.kind === "snapshot");
  assert.deepEqual(replacement.view.self.hand, before.self.hand);
  assert.equal(replacement.view.game.drawPileCount, before.game.drawPileCount);
  assert.equal(
    replacement.view.game.decision.decisionId,
    before.game.decision.decisionId,
  );
  assert.ok(
    !actor.messages.some(
      (message) =>
        message.kind === "ack" && message.commandId === command.commandId,
    ),
  );
  const draw = await replacement.accepted("DRAW_CARD");
  assert.equal(draw.kind, "ack");
  assert.equal(replacement.view.self.hand.length, before.self.hand.length + 1);
});

test("voluntary live departure unsubscribes private views, retains the seat, and invalidates a queued bot on reclaim", async (t) => {
  let now = Date.now();
  const f = await roomFixture(t, {
    clock: { now: () => now },
    timingOverrides: { ...slowTiming, botDelayMin: 100, botDelayMax: 100 },
  });
  const actor = activeClient(f.players);
  const before = structuredClone(actor.view);
  const leave = actor.envelope("LEAVE_ROOM");
  const departed = await actor.send(leave);
  assert.equal(departed.kind, "ack");
  const observers = f.players.filter((client) => client !== actor);
  await Promise.all(
    observers.map((client) => client.version(departed.committedVersion)),
  );
  const absentSeat = observers[0].view.players.find(
    (player) => player.playerId === actor.session.playerId,
  );
  assert.equal(absentSeat.connected, false);
  assert.equal(absentSeat.controllerMode, "TEMP_BOT");
  const denied = await actor.read("REQUEST_SNAPSHOT", {
    roomId: before.roomId,
  });
  assert.equal(denied.code, "NOT_A_MEMBER");
  const retry = await actor.send(leave);
  assert.equal(retry.kind, "ack");
  assert.equal(retry.committedVersion, departed.committedVersion);
  await f.app.service.tick();
  const replacement = await f.client({
    cookie: actor.cookie,
    session: actor.session,
  });
  await replacement.waitFor((message) => message.kind === "snapshot");
  assert.equal(replacement.view.self.controllerMode, "TEMP_BOT");
  assert.deepEqual(replacement.view.self.hand, before.self.hand);
  await replacement.accepted("RECLAIM_CONTROL");
  now += 101;
  await f.app.service.tick();
  const fresh = await replacement.read("REQUEST_SNAPSHOT", {
    roomId: before.roomId,
  });
  assert.equal(fresh.view.self.controllerMode, "HUMAN");
  assert.deepEqual(fresh.view.self.hand, before.self.hand);
  assert.equal(
    fresh.view.game.decision.decisionId,
    before.game.decision.decisionId,
  );
  assert.equal(
    fresh.view.game.decision.deadlineAt,
    before.game.decision.deadlineAt,
  );
});

test("restart resolves an elapsed decision once and gives the replacement decision a fresh deadline", async (t) => {
  let now = Date.now();
  const source = await roomFixture(t, { clock: { now: () => now } });
  const actor = activeClient(source.players);
  const before = structuredClone(actor.view);
  const persisted = await source.store.load();
  await source.close();
  now = before.game.decision.deadlineAt + 100;
  const f = await fixture(t, {
    store: new MemoryStore(persisted),
    clock: { now: () => now },
  });
  const restored = await f.client({
    cookie: actor.cookie,
    session: actor.session,
  });
  await restored.waitFor((message) => message.kind === "snapshot");
  assert.equal(restored.view.self.controllerMode, "TEMP_BOT");
  assert.notEqual(
    restored.view.game.decision.decisionId,
    before.game.decision.decisionId,
  );
  assert.equal(restored.view.game.decision.deadlineAt, now + slowTiming.bot);
  assert.equal(restored.view.game.turnNumber, before.game.turnNumber);
  assert.equal(restored.view.game.drawPileCount, before.game.drawPileCount);
  const replaced = restored.view.game.decision.decisionId;
  await f.app.service.tick();
  const current = await restored.read("REQUEST_SNAPSHOT", {
    roomId: restored.view.roomId,
  });
  assert.equal(current.view.game.decision.decisionId, replaced);
});

test("a corrupted committed match reconnects to a safe stopped-room view without fabricating replacement cards", async (t) => {
  const source = await roomFixture(t);
  const actor = activeClient(source.players);
  const credentials = { cookie: actor.cookie, session: actor.session };
  const persisted = await source.store.load();
  const room = persisted.rooms[actor.view.roomId];
  const missingId = room.match.handsByPlayer[actor.session.playerId][0];
  delete room.match.cardsByInternalId[missingId];
  await source.close();
  const f = await fixture(t, { store: new MemoryStore(persisted) });
  const restored = await f.client(credentials);
  await restored.waitFor((message) => message.kind === "snapshot");
  assert.equal(restored.view.room.status, "ERROR");
  assert.ok(!restored.view.allowedCommands.types.includes("DRAW_CARD"));
  assert.ok(!restored.view.allowedCommands.types.includes("SEND_PACKET"));
  assert.ok(!JSON.stringify(restored.view).includes(missingId));
  assert.equal(
    Object.keys(f.store.data.rooms[room.roomId].match.cardsByInternalId).length,
    17,
  );
  assert.ok(
    f.store.data.rooms[room.roomId].match.handsByPlayer[
      actor.session.playerId
    ].includes(missingId),
  );
  await restored.accepted("LEAVE_ROOM");
  const denied = await restored.read("REQUEST_SNAPSHOT", {
    roomId: room.roomId,
  });
  assert.equal(denied.code, "NOT_A_MEMBER");
  const session = await fetch(`${f.baseUrl}/api/session`, {
    headers: { Cookie: restored.cookie },
  });
  assert.equal((await session.json()).roomId, null);
});

test("terminal inactivity expiry notifies every subscribed socket and removes snapshot and session membership", async (t) => {
  let now = Date.now();
  const source = await roomFixture(t, { clock: { now: () => now } });
  const credentials = source.players.map((client) => ({
    cookie: client.cookie,
    session: client.session,
  }));
  const persisted = await source.store.load();
  const roomId = source.host.view.roomId;
  const room = persisted.rooms[roomId];
  room.status = "ABANDONED";
  room.match.phase = "TERMINAL";
  room.match.decision = null;
  room.match.terminalReason = "ABANDONED";
  room.match.winnerPlayerId = null;
  await source.close();
  const f = await fixture(t, {
    store: new MemoryStore(persisted),
    clock: { now: () => now },
    timingOverrides: { ...slowTiming, terminalExpiry: 1000 },
  });
  const clients = await Promise.all(credentials.map((item) => f.client(item)));
  await Promise.all(
    clients.map((client) =>
      client.waitFor((message) => message.kind === "snapshot"),
    ),
  );
  assert.ok(clients.every((client) => client.view.room.status === "ABANDONED"));
  now += 1000;
  await f.app.service.tick();
  for (const client of clients) {
    const expired = await client.waitFor(
      (message) => message.kind === "room_closed",
    );
    assert.equal(expired.roomId, roomId);
    const denied = await client.read("REQUEST_SNAPSHOT", { roomId });
    assert.equal(denied.code, "NOT_A_MEMBER");
    const response = await fetch(`${f.baseUrl}/api/session`, {
      headers: { Cookie: client.cookie },
    });
    assert.equal((await response.json()).roomId, null);
  }
  assert.ok(!f.store.data.rooms[roomId]);
});
