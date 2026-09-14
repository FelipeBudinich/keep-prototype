// Run with: node --env-file=.env scripts/configure-heroku.mjs
// Passes secrets as structured subprocess arguments, never through a shell.
import { execFileSync } from "node:child_process";
if (!process.env.SUPABASE_DB_URL)
  throw new Error("SUPABASE_DB_URL is required");
try {
  execFileSync(
    "heroku",
    [
      "config:set",
      "-a",
      "keep2",
      `SUPABASE_DB_URL=${process.env.SUPABASE_DB_URL}`,
      "NODE_ENV=production",
      "APP_ORIGIN=https://keep2-65fe1099bb65.herokuapp.com",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  console.log(
    "keep2 server environment configured. Credentials were not printed.",
  );
} catch {
  console.error("Heroku configuration failed; inspect account/app access.");
  process.exit(1);
}
