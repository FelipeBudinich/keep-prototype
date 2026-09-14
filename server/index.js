import { createApplication } from "./app.js";
import { PostgresStore, MemoryStore } from "./persistence.js";
const localMemory =
  process.env.KEEP_MEMORY === "1" && process.env.NODE_ENV !== "production";
if (!localMemory && !process.env.SUPABASE_DB_URL)
  throw new Error(
    "Set SUPABASE_DB_URL. For disposable local development only, use KEEP_MEMORY=1.",
  );
const app = await createApplication({
  store: localMemory
    ? new MemoryStore()
    : new PostgresStore(process.env.SUPABASE_DB_URL),
});
app.server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () =>
  console.log(
    JSON.stringify({
      event: "server_started",
      port: Number(process.env.PORT || 3000),
      persistence: localMemory ? "memory" : "supabase",
    }),
  ),
);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 20000);
    deadline.unref();
    await app.close();
    process.exit(0);
  });

const watchdog = setInterval(async () => {
  if (stopping || localMemory || app.service.store.healthy !== false) return;
  stopping = true;
  console.error(
    JSON.stringify({ event: "authority_fenced", action: "restart_required" }),
  );
  await app.close().catch(() => {});
  process.exit(1);
}, 5000);
watchdog.unref();
