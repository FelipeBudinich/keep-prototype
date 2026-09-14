import { randomUUID, randomInt } from "node:crypto";
import {
  startMatch,
  applyGameplay,
  replaceDecision,
  assertInvariants,
} from "./game.js";
import { projectRoom } from "./projector.js";
import { chooseBotCommand, fallbackBotCommand } from "./bot.js";
import {
  fail,
  configuration,
  canonical,
  gameplay,
  joining,
  RateLimiter,
  validateMessage,
} from "./protocol.js";
export const defaults = {
  active: 60000,
  recipient: 30000,
  bot: 5000,
  botDelayMin: 750,
  botDelayMax: 1500,
  lobbyGrace: 60000,
  hostGrace: 60000,
  abandon: 600000,
  terminalExpiry: 1800000,
  heartbeat: 15000,
};
export class RoomService {
  constructor(
    store,
    {
      clock = { now: () => Date.now() },
      rng = { int: randomInt },
      codeRng = { int: randomInt },
      timingOverrides = {},
      botPolicy = chooseBotCommand,
    } = {},
  ) {
    this.store = store;
    this.clock = clock;
    this.rng = rng;
    this.codeRng = codeRng;
    this.timings = { ...defaults, ...timingOverrides };
    this.botPolicy = botPolicy;
    this.tail = Promise.resolve();
    this.connections = new Map();
    this.botJobs = new Map();
    this.codeAttempts = new Map();
    this.rates = new RateLimiter();
    this.publish = () => {};
    this.closed = false;
  }
  now() {
    return this.clock.now();
  }
  context() {
    return {
      now: this.now(),
      rng: this.rng,
      id: randomUUID,
      timings: {
        active: this.timings.active,
        recipient: this.timings.recipient,
        bot: this.timings.bot,
      },
    };
  }
  queue(fn) {
    const task = this.tail.then(fn);
    this.tail = task.catch(() => {});
    return task;
  }
  async init() {
    this.data = await this.store.load();
    const next = structuredClone(this.data);
    let changed = false;
    for (const room of Object.values(next.rooms)) {
      let roomChanged = false;
      try {
        assertInvariants(room);
      } catch {
        this.errorRoom(room);
        roomChanged = true;
      }
      for (const seat of room.seats)
        if (seat.kind === "HUMAN" && seat.connected) {
          seat.connected = false;
          seat.disconnectedAt = this.now();
          if (room.status === "LOBBY") seat.ready = false;
          roomChanged = true;
        }
      if (room.noHumansSince == null) {
        room.noHumansSince = this.now();
        roomChanged = true;
      }
      if (roomChanged) {
        room.stateVersion++;
        changed = true;
      }
    }
    // Persist quarantine even when every recovered player was already absent.
    if (changed) await this.commit(next);
    await this.tick();
  }
  async commit(next) {
    await this.store.commit(next);
    this.data = next;
  }
  event(room, type, details = {}) {
    if (
      room.match &&
      room.match.effects?.[0]?.roomVersion !== room.stateVersion + 1
    )
      room.match.effects = [];
    const effect = {
      type,
      roomVersion: room.stateVersion + 1,
      effectIndex: room.match?.effects?.length ?? 0,
      ...details,
    };
    if (room.match) (room.match.effects ??= []).push(effect);
    room.recentPublicLog = [...(room.recentPublicLog ?? []), effect].slice(
      -100,
    );
  }
  errorRoom(room) {
    room.status = "ERROR";
    room.incidentId = randomUUID();
    if (room.match) {
      room.match.phase = "TERMINAL";
      room.match.decision = null;
      room.match.winnerPlayerId = null;
      room.match.terminalReason = "INTERNAL_ERROR";
      room.match.effects = [];
    }
    this.event(room, "RoomError", { incidentId: room.incidentId });
    room.lastActivityAt = this.now();
    this.botJobs.delete(room.roomId);
  }
  async stopRoom(roomId) {
    const next = structuredClone(this.data),
      room = next.rooms[roomId];
    if (!room || room.status === "ERROR") return;
    this.errorRoom(room);
    this.mark(room);
    await this.commit(next);
    this.publish(roomId);
  }
  currentRoom(playerId, data = this.data) {
    const sid = data.sessions[playerId]?.roomId;
    const room = data.rooms[sid];
    return room &&
      room.status !== "CLOSED" &&
      room.seats.some((s) => s.playerId === playerId)
      ? room
      : null;
  }
  assertControl(playerId, connection) {
    if (this.connections.get(playerId) !== connection || connection.moved)
      fail("CONTROL_MOVED", "Control moved to another tab.");
  }
  snapshot(playerId) {
    const room = this.currentRoom(playerId);
    return room ? projectRoom(room, playerId, this.now()) : null;
  }
  listRooms() {
    return Object.values(this.data.rooms)
      .filter(
        (r) =>
          r.visibility === "PUBLIC" &&
          r.status === "LOBBY" &&
          r.seats.filter((s) => s.kind === "HUMAN").length <
            r.configuredAdditionalHumans + 1,
      )
      .map((r) => ({
        roomId: r.roomId,
        name: r.roomName,
        hostDisplayName: r.seats.find((s) => s.playerId === r.hostPlayerId)
          ?.displayName,
        additionalHumans: r.configuredAdditionalHumans,
        bots: r.configuredBots,
        availableHumanSeats:
          r.configuredAdditionalHumans +
          1 -
          r.seats.filter((s) => s.kind === "HUMAN").length,
      }));
  }
  seat(playerId, displayName, seatIndex, kind = "HUMAN") {
    return {
      playerId,
      displayName,
      seatIndex,
      kind,
      connected: kind === "HUMAN",
      ready: kind === "BOT",
      controllerMode: kind === "BOT" ? "BOT" : "HUMAN",
      controlGeneration: 0,
      disconnectedAt: null,
    };
  }
  code(data) {
    for (let i = 0; i < 100; i++) {
      const value = this.codeRng.int(1000000);
      if (!Number.isInteger(value) || value < 0 || value >= 1000000)
        fail("ROOM_UNAVAILABLE", "Could not create a room. Please try again.");
      const code = String(value).padStart(6, "0");
      if (
        !Object.values(data.rooms).some(
          (r) => r.status !== "CLOSED" && r.privateCode === code,
        )
      )
        return code;
    }
    fail("ROOM_UNAVAILABLE", "Could not create a room. Please try again.");
  }
  mark(room) {
    room.stateVersion++;
    room.lastActivityAt = this.now();
    room.noHumansSince = room.seats.some(
      (s) => s.kind === "HUMAN" && s.connected,
    )
      ? null
      : (room.noHumansSince ?? this.now());
  }
  release(data, room) {
    room.status = "CLOSED";
    room.privateCode = null;
    for (const s of room.seats)
      if (data.sessions[s.playerId]?.roomId === room.roomId)
        data.sessions[s.playerId].roomId = null;
    for (const [key, receipt] of Object.entries(data.receipts))
      if (receipt.roomId === room.roomId) delete data.receipts[key];
    delete data.rooms[room.roomId];
  }
  transferHost(room) {
    const next = room.seats
      .filter(
        (s) => s.kind === "HUMAN" && (room.status === "LOBBY" || s.connected),
      )
      .sort((a, b) => a.seatIndex - b.seatIndex)[0];
    if (next && next.playerId !== room.hostPlayerId) {
      room.hostPlayerId = next.playerId;
      this.event(room, "HostTransferred", { playerId: next.playerId });
      return true;
    }
    return false;
  }
  async connected(playerId, connection) {
    return this.queue(async () => {
      this.assertControl(playerId, connection);
      const next = structuredClone(this.data),
        room = this.currentRoom(playerId, next);
      if (room) {
        const seat = room.seats.find((s) => s.playerId === playerId);
        seat.connected = true;
        seat.disconnectedAt = null;
        seat.unsubscribed = false;
        room.noHumansSince = null;
        this.mark(room);
        await this.commit(next);
        this.publish(room.roomId);
      }
      return this.snapshot(playerId);
    });
  }
  async disconnected(playerId, connection) {
    return this.queue(async () => {
      if (this.connections.get(playerId) !== connection) return;
      this.connections.delete(playerId);
      const next = structuredClone(this.data),
        room = this.currentRoom(playerId, next);
      if (!room) return;
      const seat = room.seats.find((s) => s.playerId === playerId);
      seat.connected = false;
      seat.disconnectedAt ??= this.now();
      if (room.status === "LOBBY") seat.ready = false;
      this.mark(room);
      await this.commit(next);
      this.publish(room.roomId);
    });
  }
  failedCode(playerId, ip) {
    const now = this.now();
    for (const key of ["session:" + playerId, "ip:" + ip]) {
      const xs = (this.codeAttempts.get(key) || []).filter(
        (at) => now - at < 60000,
      );
      this.codeAttempts.set(key, xs);
      if (xs.length >= 10)
        fail("RATE_LIMITED", "Too many join attempts. Try again in a minute.");
    }
  }
  recordCodeFailure(playerId, ip) {
    for (const key of ["session:" + playerId, "ip:" + ip]) {
      const xs = this.codeAttempts.get(key) || [];
      xs.push(this.now());
      this.codeAttempts.set(key, xs);
    }
  }
  async command(playerId, connection, command, ip = "local") {
    return this.queue(async () => {
      try {
        this.assertControl(playerId, connection);
        const key = playerId + ":" + command.commandId,
          body = canonical(command),
          receipt = this.data.receipts[key];
        if (receipt) {
          if (receipt.body !== body)
            fail(
              "COMMAND_ID_REUSED",
              "That command identifier was already used.",
            );
          return { ...receipt.ack };
        }
        if (!this.data.sessions[playerId])
          fail("UNAUTHENTICATED", "Please reconnect.");
        const next = structuredClone(this.data);
        let room;
        const now = this.now();
        if (joining.has(command.type)) {
          const existing = this.currentRoom(playerId, next);
          if (command.type === "CREATE_ROOM") {
            if (existing)
              fail(
                "ILLEGAL_ACTION",
                "Resume or leave your current room first.",
              );
            const c = configuration(command.payload);
            room = {
              roomId: randomUUID(),
              stateVersion: 0,
              roomName: c.name,
              visibility: c.visibility,
              privateCode: c.visibility === "PRIVATE" ? this.code(next) : null,
              hostPlayerId: playerId,
              configuredAdditionalHumans: c.additionalHumans,
              configuredBots: c.bots,
              status: "LOBBY",
              seats: [
                this.seat(playerId, next.sessions[playerId].displayName, 0),
              ],
              match: null,
              recentPublicLog: [],
              lastActivityAt: now,
              noHumansSince: null,
            };
            for (let i = 0; i < c.bots; i++)
              room.seats.push(
                this.seat(
                  randomUUID(),
                  ["Ember", "Moss", "Flint", "Saffron", "Onyx"][i],
                  1 + c.additionalHumans + i,
                  "BOT",
                ),
              );
            next.rooms[room.roomId] = room;
          } else {
            const privateJoin = command.type === "JOIN_PRIVATE_ROOM";
            if (privateJoin) this.failedCode(playerId, ip);
            room = privateJoin
              ? Object.values(next.rooms).find(
                  (r) =>
                    r.visibility === "PRIVATE" &&
                    r.privateCode === command.payload.code,
                )
              : next.rooms[command.payload.roomId];
            const canResume = room && existing?.roomId === room.roomId;
            const unavailable =
              !room ||
              room.status === "CLOSED" ||
              (!privateJoin && room.visibility !== "PUBLIC") ||
              (!canResume &&
                (room.status !== "LOBBY" ||
                  room.seats.filter((s) => s.kind === "HUMAN").length >=
                    room.configuredAdditionalHumans + 1));
            if (unavailable) {
              if (privateJoin) this.recordCodeFailure(playerId, ip);
              fail(
                privateJoin
                  ? "ROOM_UNAVAILABLE"
                  : room?.status === "LOBBY"
                    ? "ROOM_FULL"
                    : "ROOM_UNAVAILABLE",
                "Room unavailable.",
              );
            }
            if (existing && !canResume)
              fail(
                "ILLEGAL_ACTION",
                "Resume or leave your current room first.",
              );
            if (canResume) {
              const seat = room.seats.find((s) => s.playerId === playerId);
              seat.connected = true;
              seat.unsubscribed = false;
              seat.disconnectedAt = null;
            } else {
              let i = 0;
              while (room.seats.some((s) => s.seatIndex === i)) i++;
              room.seats.push(
                this.seat(playerId, next.sessions[playerId].displayName, i),
              );
              room.seats.sort((a, b) => a.seatIndex - b.seatIndex);
            }
          }
          next.sessions[playerId].roomId = room.roomId;
        } else {
          room = next.rooms[command.roomId];
          if (!room || this.currentRoom(playerId, next)?.roomId !== room.roomId)
            fail("NOT_A_MEMBER", "You are not a member of this room.");
          // Expiry wins arbitration even when a scheduler callback was delayed.
          if (
            room.status === "PLAYING" &&
            room.match.decision &&
            now >= room.match.decision.deadlineAt
          ) {
            await this.timeoutRoom(command.roomId);
            if (gameplay.has(command.type))
              fail(
                "DEADLINE_EXPIRED",
                "That decision expired. The table has moved on.",
              );
            fail("STALE_STATE", "The table changed. Please try again.");
          }
          if (command.expectedVersion !== room.stateVersion)
            fail("STALE_STATE", "The table changed. Please choose again.");
          const seat = room.seats.find((s) => s.playerId === playerId);
          const host = () => {
            if (room.hostPlayerId !== playerId)
              fail("NOT_HOST", "Only the host can do that.");
          };
          if (gameplay.has(command.type)) {
            if (room.status !== "PLAYING")
              fail("MATCH_ENDED", "This match has ended.");
            if (command.matchId !== room.match.matchId)
              fail("WRONG_MATCH", "That command belongs to a different match.");
            if (command.decisionId !== room.match.decision?.decisionId)
              fail("WRONG_DECISION", "That decision is no longer open.");
            if (seat.controllerMode !== "HUMAN" || seat.unsubscribed)
              fail("ILLEGAL_ACTION", "Reclaim control before playing.");
            applyGameplay(
              room,
              playerId,
              command.type,
              command.payload,
              this.context(),
            );
          } else
            switch (command.type) {
              case "UPDATE_ROOM": {
                host();
                if (room.status !== "LOBBY")
                  fail(
                    "ILLEGAL_ACTION",
                    "Room settings are locked during a match.",
                  );
                const c = configuration(command.payload);
                const humans = room.seats
                  .filter((s) => s.kind === "HUMAN")
                  .sort((a, b) => a.seatIndex - b.seatIndex);
                if (humans.length > c.additionalHumans + 1)
                  fail(
                    "ILLEGAL_ACTION",
                    "There are too many seated humans for that configuration.",
                  );
                if (c.visibility === "PRIVATE" && room.visibility !== "PRIVATE")
                  room.privateCode = this.code(next);
                if (c.visibility === "PUBLIC") room.privateCode = null;
                const previousBots = room.seats
                  .filter((s) => s.kind === "BOT")
                  .sort((a, b) => a.seatIndex - b.seatIndex);
                const keepIndices = humans.every(
                  (s) => s.seatIndex <= c.additionalHumans,
                );
                Object.assign(room, {
                  roomName: c.name,
                  visibility: c.visibility,
                  configuredAdditionalHumans: c.additionalHumans,
                  configuredBots: c.bots,
                });
                // Preserve occupied positions when they fit. A capacity reduction may
                // compact holes, while preserving the humans' relative table order.
                room.seats = humans.map((s, i) => ({
                  ...s,
                  seatIndex: keepIndices ? s.seatIndex : i,
                  ready: false,
                }));
                for (let i = 0; i < c.bots; i++)
                  room.seats.push(
                    previousBots[i]
                      ? {
                          ...previousBots[i],
                          seatIndex: 1 + c.additionalHumans + i,
                        }
                      : this.seat(
                          randomUUID(),
                          ["Ember", "Moss", "Flint", "Saffron", "Onyx"][i],
                          1 + c.additionalHumans + i,
                          "BOT",
                        ),
                  );
                break;
              }
              case "SET_READY":
                if (room.status !== "LOBBY" || !seat.connected)
                  fail(
                    "ILLEGAL_ACTION",
                    "Readiness is only available in the lobby.",
                  );
                seat.ready = command.payload.ready;
                break;
              case "START_MATCH":
                host();
                if (room.status !== "LOBBY")
                  fail("ILLEGAL_ACTION", "The match has already started.");
                if (
                  room.seats.filter((s) => s.kind === "HUMAN").length !==
                    room.configuredAdditionalHumans + 1 ||
                  room.seats.some(
                    (s) => s.kind === "HUMAN" && (!s.ready || !s.connected),
                  )
                )
                  fail(
                    "NOT_READY",
                    "All human seats must be filled, connected, and ready.",
                  );
                startMatch(room, this.context());
                break;
              case "LEAVE_ROOM": {
                seat.connected = false;
                seat.disconnectedAt = now;
                seat.unsubscribed = true;
                seat.ready = false;
                if (room.status === "LOBBY") {
                  room.seats = room.seats.filter(
                    (s) => s.playerId !== playerId,
                  );
                  next.sessions[playerId].roomId = null;
                  if (room.hostPlayerId === playerId) this.transferHost(room);
                } else if (room.status === "PLAYING") {
                  seat.controllerMode = "TEMP_BOT";
                  seat.controlGeneration++;
                  this.event(room, "ControlTransferred", {
                    playerId,
                    controllerMode: "TEMP_BOT",
                  });
                } else next.sessions[playerId].roomId = null;
                break;
              }
              case "RECLAIM_CONTROL":
                if (
                  room.status !== "PLAYING" ||
                  seat.kind !== "HUMAN" ||
                  seat.controllerMode !== "TEMP_BOT"
                )
                  fail("ILLEGAL_ACTION", "You already control this seat.");
                seat.controllerMode = "HUMAN";
                seat.controlGeneration++;
                seat.connected = true;
                seat.unsubscribed = false;
                seat.disconnectedAt = null;
                this.event(room, "ControlReclaimed", { playerId });
                break;
              case "RETURN_TO_LOBBY":
                host();
                if (!["FINISHED", "ABANDONED"].includes(room.status))
                  fail("ILLEGAL_ACTION", "Wait for the match to end.");
                for (const s of room.seats)
                  if (
                    s.kind === "HUMAN" &&
                    !s.connected &&
                    next.sessions[s.playerId]
                  )
                    next.sessions[s.playerId].roomId = null;
                room.seats = room.seats
                  .filter((s) => s.kind === "BOT" || s.connected)
                  .map((s) => ({
                    ...s,
                    ready: s.kind === "BOT",
                    controllerMode: s.kind === "BOT" ? "BOT" : "HUMAN",
                    unsubscribed: false,
                  }));
                room.match = null;
                room.recentPublicLog = [];
                room.status = "LOBBY";
                break;
              default:
                fail("INVALID_MESSAGE", "Unknown command.");
            }
        }
        this.assertControl(playerId, connection);
        this.mark(room);
        if (room.status === "ERROR" && command.type === "LEAVE_ROOM") {
          // An invariant failure intentionally preserves the broken match for
          // diagnosis. A member may release that stopped seat, but this path must
          // never alter or "repair" any part of the quarantined game.
          const committed = this.data.rooms[room.roomId];
          if (
            committed?.status !== "ERROR" ||
            canonical(room.match) !== canonical(committed.match) ||
            (room.match &&
              (room.match.phase !== "TERMINAL" || room.match.decision !== null))
          )
            fail("INTERNAL_ERROR", "The stopped game could not be released.");
        } else assertInvariants(room);
        const ack = {
          kind: "ack",
          commandId: command.commandId,
          status: "ACCEPTED",
          committedVersion: room.stateVersion,
        };
        next.receipts[key] = { body, ack, roomId: room.roomId, at: now };
        next.sessions[playerId].expiresAt = now + 30 * 86400000;
        if (
          room.status === "LOBBY" &&
          !room.seats.some((s) => s.kind === "HUMAN")
        )
          this.release(next, room);
        // Retain the departing actor's receipt even after the room has closed.
        if (!next.rooms[room.roomId])
          next.receipts[key] = {
            body,
            ack,
            roomId: room.roomId,
            at: now,
            expiresAt: now + 1800000,
          };
        await this.commit(next);
        this.publish(room.roomId);
        return ack;
      } catch (error) {
        if (error.code === "INTERNAL_ERROR" && this.data.rooms[command.roomId])
          await this.stopRoom(command.roomId);
        throw error;
      }
    });
  }
  botFence(room) {
    const d = room.match.decision,
      s = room.seats.find((s) => s.playerId === d.playerId);
    return {
      playerId: d.playerId,
      matchId: room.match.matchId,
      decisionId: d.decisionId,
      stateVersion: room.stateVersion,
      controlGeneration: s.controlGeneration,
    };
  }
  botCommand(room, intent, fence, context) {
    const seat = room.seats.find((s) => s.playerId === fence.playerId);
    if (
      room.status !== "PLAYING" ||
      room.match.matchId !== fence.matchId ||
      room.stateVersion !== fence.stateVersion ||
      room.match.decision?.decisionId !== fence.decisionId ||
      !seat ||
      seat.controllerMode === "HUMAN" ||
      seat.controlGeneration !== fence.controlGeneration
    )
      fail("WRONG_DECISION", "That bot decision is no longer open.");
    if (!intent || !gameplay.has(intent.type))
      fail("INVALID_MESSAGE", "The bot did not choose a gameplay action.");
    const command = {
      protocolVersion: 1,
      kind: "command",
      commandId: randomUUID(),
      roomId: room.roomId,
      matchId: fence.matchId,
      decisionId: fence.decisionId,
      expectedVersion: fence.stateVersion,
      type: intent.type,
      payload: intent.payload,
    };
    validateMessage(command);
    applyGameplay(room, fence.playerId, command.type, command.payload, context);
    return command;
  }
  botReceipt(data, room, actor, command) {
    data.receipts["bot:" + actor + ":" + command.commandId] = {
      body: canonical(command),
      ack: {
        kind: "ack",
        commandId: command.commandId,
        status: "ACCEPTED",
        committedVersion: room.stateVersion,
      },
      roomId: room.roomId,
      at: this.now(),
    };
  }
  async timeoutRoom(roomId) {
    const next = structuredClone(this.data),
      room = next.rooms[roomId],
      context = this.context();
    if (
      !room ||
      room.status !== "PLAYING" ||
      !room.match.decision ||
      context.now < room.match.decision.deadlineAt
    )
      return false;
    const actor = room.match.decision.playerId,
      wasBot =
        room.seats.find((s) => s.playerId === actor).controllerMode !== "HUMAN";
    let command;
    try {
      replaceDecision(room, context);
      if (wasBot) {
        const intent = fallbackBotCommand(
          projectRoom(room, actor, context.now),
          this.rng,
        );
        command = this.botCommand(room, intent, this.botFence(room), context);
      }
      this.mark(room);
      assertInvariants(room);
    } catch {
      await this.stopRoom(roomId);
      return false;
    }
    if (command) this.botReceipt(next, room, actor, command);
    // Durable storage errors propagate without acknowledging or publishing the
    // speculative timeout. A later recovery sees either complete transaction.
    await this.commit(next);
    this.botJobs.delete(roomId);
    this.publish(roomId);
    return true;
  }
  async runBot(roomId, fence, watchdog = false) {
    const current = this.data.rooms[roomId];
    if (!current || current.status !== "PLAYING") return;
    const context = this.context();
    if (context.now >= current.match.decision.deadlineAt) {
      await this.timeoutRoom(roomId);
      return;
    }
    const view = projectRoom(current, fence.playerId, context.now);
    let intent;
    if (!watchdog) {
      try {
        intent = this.botPolicy(view, this.rng);
      } catch {
        /* A failed policy falls through to the restricted fallback. */
      }
    }
    let next, room, command;
    for (let attempt = 0; attempt < 2; attempt++) {
      next = structuredClone(this.data);
      room = next.rooms[roomId];
      try {
        if (!intent || attempt === 1)
          intent = fallbackBotCommand(
            projectRoom(room, fence.playerId, context.now),
            this.rng,
          );
        command = this.botCommand(room, intent, fence, context);
        this.mark(room);
        assertInvariants(room);
        break;
      } catch (error) {
        command = null;
        if (error.code === "WRONG_DECISION") {
          this.botJobs.delete(roomId);
          return;
        }
        if (error.code === "DEADLINE_EXPIRED") {
          await this.timeoutRoom(roomId);
          return;
        }
        if (error.code === "INTERNAL_ERROR" || attempt === 1) {
          await this.stopRoom(roomId);
          return;
        }
      }
    }
    this.botReceipt(next, room, fence.playerId, command);
    await this.commit(next);
    this.botJobs.delete(roomId);
    this.publish(roomId);
  }
  async tick() {
    return this.queue(async () => {
      if (this.closed) return;
      const now = this.now();
      this.rates.prune(now);
      for (const [key, arr] of this.codeAttempts) {
        const recent = arr.filter((at) => now - at < 60000);
        if (recent.length) this.codeAttempts.set(key, recent);
        else this.codeAttempts.delete(key);
      }
      for (const roomId of Object.keys(this.data.rooms)) {
        let room = this.data.rooms[roomId];
        if (!room) continue;
        const next = structuredClone(this.data),
          working = next.rooms[roomId];
        let changed = false;
        if (working.status === "LOBBY") {
          const expired = working.seats.filter(
            (s) =>
              s.kind === "HUMAN" &&
              !s.connected &&
              now - (s.disconnectedAt ?? now) >= this.timings.lobbyGrace,
          );
          if (expired.length) {
            for (const seat of expired)
              if (next.sessions[seat.playerId])
                next.sessions[seat.playerId].roomId = null;
            working.seats = working.seats.filter((s) => !expired.includes(s));
            if (expired.some((s) => s.playerId === working.hostPlayerId))
              this.transferHost(working);
            changed = true;
          }
          if (!working.seats.some((s) => s.kind === "HUMAN")) {
            this.release(next, working);
            changed = true;
          }
        } else if (working.status === "PLAYING") {
          const host = working.seats.find(
            (s) => s.playerId === working.hostPlayerId,
          );
          if (
            host &&
            !host.connected &&
            now - (host.disconnectedAt ?? now) >= this.timings.hostGrace &&
            working.seats.some((s) => s.kind === "HUMAN" && s.connected)
          ) {
            changed = this.transferHost(working) || changed;
          }
          if (
            working.noHumansSince !== null &&
            working.noHumansSince !== undefined &&
            now - working.noHumansSince >= this.timings.abandon
          ) {
            working.status = "ABANDONED";
            working.match.phase = "TERMINAL";
            working.match.decision = null;
            working.match.terminalReason = "ABANDONED";
            working.match.winnerPlayerId = null;
            this.event(working, "MatchAbandoned");
            changed = true;
          }
        } else if (
          now - working.lastActivityAt >=
          this.timings.terminalExpiry
        ) {
          this.release(next, working);
          changed = true;
        }
        if (changed) {
          if (next.rooms[roomId]) {
            this.mark(working);
            assertInvariants(working);
          }
          await this.commit(next);
          this.publish(roomId);
        }
        room = this.data.rooms[roomId];
        if (!room || room.status !== "PLAYING") {
          this.botJobs.delete(roomId);
          continue;
        }
        const decision = room.match.decision;
        if (!decision) continue;
        if (now >= decision.deadlineAt) {
          await this.timeoutRoom(roomId);
          this.botJobs.delete(roomId);
          continue;
        }
        const seat = room.seats.find((s) => s.playerId === decision.playerId);
        if (seat.controllerMode === "HUMAN") {
          this.botJobs.delete(roomId);
          continue;
        }
        const generation =
          room.match.matchId +
          ":" +
          decision.decisionId +
          ":" +
          seat.controlGeneration;
        let job = this.botJobs.get(roomId);
        if (!job || job.generation !== generation) {
          job = {
            generation,
            due:
              now +
              this.timings.botDelayMin +
              this.rng.int(
                Math.max(
                  1,
                  this.timings.botDelayMax - this.timings.botDelayMin + 1,
                ),
              ),
          };
          this.botJobs.set(roomId, job);
        }
        if (now >= job.due || now >= decision.deadlineAt - 250)
          await this.runBot(
            roomId,
            this.botFence(room),
            now >= decision.deadlineAt - 250,
          );
      }
      // Prune only expired sessions without retained membership and orphan receipts.
      const expiredSessions = Object.values(this.data.sessions).filter(
        (s) => s.expiresAt < now && !s.roomId,
      );
      const expiredReceipts = Object.entries(this.data.receipts).filter(
        ([, r]) => r.expiresAt && r.expiresAt < now,
      );
      if (expiredSessions.length || expiredReceipts.length) {
        const next = structuredClone(this.data);
        for (const s of expiredSessions) delete next.sessions[s.playerId];
        for (const [key] of expiredReceipts) delete next.receipts[key];
        await this.commit(next);
      }
    });
  }
}
