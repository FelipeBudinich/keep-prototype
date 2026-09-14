import pg from "pg";
import { readFileSync } from "node:fs";
export const emptyData = () => ({ rooms: {}, sessions: {}, receipts: {} });
export class MemoryStore {
  constructor(data = emptyData()) {
    this.data = structuredClone(data);
    this.failCommits = false;
  }
  async load() {
    return structuredClone(this.data);
  }
  async commit(data) {
    if (this.failCommits) throw new Error("Persistence unavailable");
    this.data = structuredClone(data);
  }
  async close() {}
}
// A dedicated session-pooler connection holds a process-wide advisory lock.
// Losing this connection fences the authority; it must restart before writing again.
export class PostgresStore {
  constructor(connectionString) {
    this.client = new pg.Client({
      connectionString,
      ssl: {
        rejectUnauthorized: true,
        ca: readFileSync(
          new URL("./certs/supabase-ca.crt", import.meta.url),
          "utf8",
        ),
      },
      connectionTimeoutMillis: 15000,
      query_timeout: 15000,
      application_name: "keep-authority",
    });
    this.healthy = false;
    this.revision = 0;
    this.client.on("error", () => {
      this.healthy = false;
    });
  }
  async load() {
    await this.client.connect();
    const lock = await this.client.query(
      "select pg_try_advisory_lock(197510, 18) as owned",
    );
    if (!lock.rows[0].owned)
      throw new Error("Another Keep authority is running");
    const result = await this.client.query(
      "select revision,body from keep_private.authority where id=true",
    );
    this.revision = Number(result.rows[0].revision);
    this.healthy = true;
    return result.rows[0].body;
  }
  async commit(data) {
    if (!this.healthy) throw new Error("Persistence unavailable");
    await this.client.query("begin");
    try {
      const result = await this.client.query(
        "update keep_private.authority set body=$1, revision=revision+1, updated_at=now() where id=true and revision=$2 returning revision",
        [JSON.stringify(data), this.revision],
      );
      if (result.rowCount !== 1) throw new Error("Authority fencing conflict");
      await this.client.query("delete from keep_private.room_codes");
      for (const room of Object.values(data.rooms))
        if (room.privateCode && room.status !== "CLOSED")
          await this.client.query(
            "insert into keep_private.room_codes(code,room_id) values($1,$2)",
            [room.privateCode, room.roomId],
          );
      await this.client.query("commit");
      this.revision = Number(result.rows[0].revision);
    } catch (error) {
      // A commit error may have an uncertain outcome. Stop this writer, then
      // recover the durable snapshot and receipts on a fresh process.
      this.healthy = false;
      await this.client.query("rollback").catch(() => {});
      throw error;
    }
  }
  async close() {
    this.healthy = false;
    await this.client.end();
  }
}
