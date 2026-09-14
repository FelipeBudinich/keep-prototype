import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "../test/helpers/wire.js";
import { chooseBotCommand } from "../server/bot.js";

// This opt-in check writes one private verification room to the deployed game.
// RUN_HEROKU_RESTART=1 also checks a real dyno restart. Never print credentials,
// room admission codes, card handles, or private hands to terminal output.
const baseUrl = process.env.KEEP_BASE_URL?.replace(/\/$/, "");
if (!baseUrl)
  throw new Error(
    "Set KEEP_BASE_URL to the explicit deployment or localhost URL.",
  );
const targetUrl = new URL(baseUrl);
if (
  targetUrl.protocol !== "https:" &&
  !(
    targetUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(targetUrl.hostname)
  )
)
  throw new Error("Remote verification requires HTTPS.");
const restart = process.env.RUN_HEROKU_RESTART === "1";
const herokuApp = process.env.HEROKU_APP;
if (restart && !herokuApp)
  throw new Error("Set HEROKU_APP when enabling the real restart check.");
const run = promisify(execFile);
const report = {
  url: baseUrl,
  clients: 3,
  restart,
  actions: 0,
  privacyChecks: 0,
};
let clients = [];

function ownPrivacy(client) {
  const view = client.view;
  assert.equal(view.self.playerId, client.session.playerId);
  assert.ok(Array.isArray(view.self.hand));
  for (const player of view.players) {
    assert.ok(!("hand" in player));
    assert.ok(!("cards" in player));
    assert.equal(typeof player.handCount, "number");
  }
  if (view.game?.packet)
    assert.deepEqual(Object.keys(view.game.packet).sort(), [
      "count",
      "originPlayerId",
      "recipientPlayerId",
    ]);
  const text = JSON.stringify(view);
  for (const other of clients.filter((peer) => peer !== client)) {
    for (const card of other.view.self.hand)
      assert.ok(!text.includes(card.handle), "A private handle crossed seats");
  }
  for (const key of [
    "cardsByInternalId",
    "handsByPlayer",
    "orderedCardIds",
    "handHandlesByPlayer",
    "tokenHash",
  ])
    assert.ok(!text.includes(`"${key}"`));
  report.privacyChecks += 1;
}

async function synchronize(version) {
  await Promise.all(clients.map((client) => client.version(version)));
  clients.forEach(ownPrivacy);
}

async function command(client, type, payload = {}) {
  const reply = await client.command(type, payload);
  if (reply.code === "STALE_STATE") {
    await client.read("REQUEST_SNAPSHOT", { roomId: client.view.roomId });
    return command(client, type, payload);
  }
  assert.equal(reply.kind, "ack", `${type}: ${JSON.stringify(reply)}`);
  report.actions += 1;
  await synchronize(reply.committedVersion);
  return reply;
}

async function waitForHealth() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return;
    } catch {}
    await delay(1000);
  }
  throw new Error("The deployment did not become healthy within 90 seconds.");
}

try {
  await waitForHealth();
  const entry = await fetch(baseUrl);
  assert.equal(entry.status, 200);
  assert.match(entry.url, /\/dist\/keep\/index\.html$/);
  assert.match(
    entry.headers.get("content-security-policy") ?? "",
    /default-src 'self'/,
  );
  const html = await entry.text();
  assert.match(html, /type="module"/);
  const bootstrap = await fetch(`${baseUrl}/api/session`);
  assert.equal(bootstrap.status, 200);
  if (targetUrl.protocol === "https:")
    assert.match(bootstrap.headers.get("set-cookie"), /Secure/);
  assert.match(bootstrap.headers.get("set-cookie"), /HttpOnly/);
  const firstSession = await bootstrap.json();
  const firstCookie = bootstrap.headers.get("set-cookie").split(";")[0];
  clients = await Promise.all([
    connect(baseUrl, {
      session: firstSession,
      cookie: firstCookie,
      waitTimeout: 15_000,
    }),
    connect(baseUrl, { waitTimeout: 15_000 }),
    connect(baseUrl, { waitTimeout: 15_000 }),
  ]);
  const host = clients[0];
  const creation = host.envelope("CREATE_ROOM", {
    name: `Verification ${new Date().toISOString().slice(0, 16)}`,
    visibility: "PRIVATE",
    additionalHumans: 2,
    bots: 0,
  });
  const created = await host.send(creation);
  assert.equal(created.kind, "ack");
  const duplicateCreate = await host.send(creation);
  assert.equal(duplicateCreate.committedVersion, created.committedVersion);
  report.roomId = host.view.roomId;
  for (const client of clients.slice(1)) {
    const joined = await client.accepted("JOIN_PRIVATE_ROOM", {
      code: host.view.room.code,
    });
    await host.version(joined.committedVersion);
  }
  await synchronize(host.view.stateVersion);
  for (const client of clients)
    await command(client, "SET_READY", { ready: true });
  await command(host, "START_MATCH");
  report.initialMatchId = host.view.matchId;
  const actor = clients.find(
    (client) => client.session.playerId === client.view.game.decision.playerId,
  );
  const drawCommand = actor.envelope("DRAW_CARD");
  const draw = await actor.send(drawCommand);
  assert.equal(draw.kind, "ack");
  await synchronize(draw.committedVersion);
  const committed = clients.map((client) => ({
    cookie: client.cookie,
    session: client.session,
    hand: structuredClone(client.view.self.hand),
    game: structuredClone(client.view.game),
    matchId: client.view.matchId,
  }));
  report.drawCommittedVersion = draw.committedVersion;

  if (restart) {
    console.log(
      JSON.stringify({
        phase: "restarting",
        app: herokuApp,
        roomId: report.roomId,
      }),
    );
    // Keep the current sockets until Heroku stops the old process; its normal
    // connection-loss lifecycle then runs exactly as it would for real players.
    await run("heroku", ["restart", "--app", herokuApp], {
      timeout: 60_000,
      maxBuffer: 256 * 1024,
    });
    clients.forEach((client) => client.close());
    await waitForHealth();
    clients = await Promise.all(
      committed.map((item) =>
        connect(baseUrl, {
          cookie: item.cookie,
          session: item.session,
          waitTimeout: 15_000,
        }),
      ),
    );
    await Promise.all(
      clients.map((client) =>
        client.waitFor((message) => message.kind === "snapshot"),
      ),
    );
    await synchronize(
      Math.max(...clients.map((client) => client.view.stateVersion)),
    );
    for (const [index, client] of clients.entries()) {
      assert.equal(client.view.matchId, committed[index].matchId);
      assert.deepEqual(client.view.self.hand, committed[index].hand);
      assert.equal(
        client.view.game.drawPileCount,
        committed[index].game.drawPileCount,
      );
      assert.equal(
        client.view.game.decision.decisionId,
        committed[index].game.decision.decisionId,
      );
      assert.equal(
        client.view.game.decision.deadlineAt,
        committed[index].game.decision.deadlineAt,
      );
    }
    const restoredActor = clients.find(
      (client) => client.session.playerId === actor.session.playerId,
    );
    const receipt = await restoredActor.send(drawCommand);
    assert.equal(receipt.kind, "ack");
    assert.equal(receipt.committedVersion, draw.committedVersion);
    assert.equal(
      restoredActor.view.game.drawPileCount,
      committed[0].game.drawPileCount,
    );
    report.recoveryVerified = true;
    console.log(
      JSON.stringify({ phase: "recovery-verified", roomId: report.roomId }),
    );
  }

  while (clients[0].view.room.status === "PLAYING") {
    if (report.actions > 2000)
      throw new Error("Verification match exceeded 2000 actions.");
    const decision = clients[0].view.game.decision;
    const player = clients.find(
      (client) => client.session.playerId === decision.playerId,
    );
    assert.ok(
      player,
      "A configured human decision must have a matching authenticated connection",
    );
    if (player.view.self.controllerMode === "TEMP_BOT")
      await command(player, "RECLAIM_CONTROL");
    const intent = chooseBotCommand(player.view, { int: randomInt });
    assert.ok(intent, "The ordinary player projection supplies a legal move");
    await command(player, intent.type, intent.payload);
    if (report.actions % 25 === 0)
      console.log(
        JSON.stringify({
          phase: "playing",
          actions: report.actions,
          turn: player.view.game.turnNumber,
        }),
      );
    await delay(60);
  }
  assert.equal(clients[0].view.room.status, "FINISHED");
  assert.equal(clients[0].view.game.terminalReason, "WIN");
  report.winnerPlayerId = clients[0].view.game.winnerPlayerId;
  clients.forEach(ownPrivacy);
  const finalHost = clients.find(
    (client) => client.session.playerId === client.view.room.hostPlayerId,
  );
  await command(finalHost, "RETURN_TO_LOBBY");
  for (const client of clients.filter((peer) => peer !== finalHost)) {
    await client.accepted("LEAVE_ROOM");
    await finalHost.read("REQUEST_SNAPSHOT", { roomId: report.roomId });
  }
  await finalHost.accepted("LEAVE_ROOM");
  const absent = await finalHost.read("REQUEST_SNAPSHOT", {
    roomId: report.roomId,
  });
  assert.equal(absent.code, "NOT_A_MEMBER");
  report.cleanedUp = true;
  console.log(JSON.stringify({ phase: "complete", ...report }, null, 2));
} finally {
  clients.forEach((client) => client.close());
}
