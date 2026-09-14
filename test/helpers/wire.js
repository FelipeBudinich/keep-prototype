import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";

export class WireClient {
  constructor(socket, session, cookie, timeout = 3000) {
    this.socket = socket;
    this.session = session;
    this.cookie = cookie;
    this.messages = [];
    this.view = null;
    this.waiters = new Set();
    this.timeout = timeout;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      this.messages.push(message);
      if (message.kind === "snapshot") this.view = message.view;
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(message)) {
          this.waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
    });
    socket.on("error", () => {});
  }

  waitFor(predicate, { after = 0, timeout = this.timeout } = {}) {
    const existing = this.messages.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(
          new Error(
            `Timed out waiting for wire message; received ${JSON.stringify(this.messages.slice(after))}`,
          ),
        );
      }, timeout);
      this.waiters.add(waiter);
    });
  }

  async version(version) {
    if (this.view && this.view.stateVersion >= version) return this.view;
    return (
      await this.waitFor(
        (message) =>
          message.kind === "snapshot" && message.view.stateVersion >= version,
      )
    ).view;
  }

  envelope(type, payload = {}, overrides = {}) {
    const command = {
      protocolVersion: 1,
      kind: "command",
      commandId: randomUUID(),
      type,
      payload,
    };
    if (
      !["CREATE_ROOM", "JOIN_PUBLIC_ROOM", "JOIN_PRIVATE_ROOM"].includes(
        type,
      ) &&
      this.view
    ) {
      command.roomId = this.view.roomId;
      command.expectedVersion = this.view.stateVersion;
      if (
        [
          "DRAW_CARD",
          "SEND_PACKET",
          "PASS_PACKET",
          "REVEAL_PACKET_TOP",
          "TAKE_RANDOM_CARD",
        ].includes(type)
      ) {
        command.matchId = this.view.matchId;
        command.decisionId =
          this.view.game?.decision?.decisionId ?? "no-current-decision";
      }
    }
    return { ...command, ...overrides };
  }

  async send(command) {
    const after = this.messages.length;
    this.socket.send(JSON.stringify(command));
    const response = await this.waitFor(
      (message) =>
        message.commandId === command.commandId &&
        ["ack", "error"].includes(message.kind),
      { after },
    );
    if (response.kind === "ack" && command.type !== "LEAVE_ROOM")
      await this.version(response.committedVersion);
    return response;
  }

  async command(type, payload = {}, overrides = {}) {
    return this.send(this.envelope(type, payload, overrides));
  }

  async accepted(type, payload = {}, overrides = {}) {
    const response = await this.command(type, payload, overrides);
    assert.equal(response.kind, "ack", JSON.stringify(response));
    assert.equal(response.status, "ACCEPTED");
    return response;
  }

  async rejected(type, payload, code, overrides = {}) {
    const response = await this.command(type, payload, overrides);
    assert.equal(response.kind, "error", JSON.stringify(response));
    assert.equal(response.code, code, JSON.stringify(response));
    return response;
  }

  async read(type, fields = {}) {
    const after = this.messages.length;
    this.socket.send(
      JSON.stringify({ protocolVersion: 1, kind: "read", type, ...fields }),
    );
    return this.waitFor(
      (message) => ["error", "snapshot", "public_rooms"].includes(message.kind),
      { after },
    );
  }

  close() {
    for (const waiter of this.waiters) clearTimeout(waiter.timer);
    this.waiters.clear();
    this.socket.terminate();
  }
}

export async function connect(
  baseUrl,
  { session, cookie, origin = baseUrl, waitTimeout = 3000 } = {},
) {
  if (!cookie) {
    const response = await fetch(`${baseUrl}/api/session`);
    assert.equal(response.status, 200);
    session = await response.json();
    cookie = response.headers.get("set-cookie").split(";")[0];
  }
  const socket = new WebSocket(
    `${baseUrl.replace("http", "ws")}/ws?protocolVersion=1`,
    {
      headers: { Cookie: cookie, Origin: origin },
    },
  );
  const client = new WireClient(socket, session, cookie, waitTimeout);
  await once(socket, "open");
  await client.waitFor((message) => message.kind === "hello");
  return client;
}

export async function rejectedUpgrade(
  baseUrl,
  { cookie, origin = baseUrl, version = 1 } = {},
) {
  return new Promise((resolve, reject) => {
    const headers = { Origin: origin };
    if (cookie) headers.Cookie = cookie;
    const socket = new WebSocket(
      `${baseUrl.replace("http", "ws")}/ws?protocolVersion=${version}`,
      { headers },
    );
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
      socket.terminate();
    });
    socket.on("error", () => {});
    socket.on("open", () => {
      socket.terminate();
      reject(
        new Error("The server accepted an unauthorized WebSocket upgrade"),
      );
    });
  });
}
