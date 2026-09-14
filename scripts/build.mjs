import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, ".build", "theseus");
await rm(stage, { recursive: true, force: true });
await mkdir(path.join(stage, "public", "games"), { recursive: true });
await cp(
  path.join(root, "vendor", "theseus", "public", "lib"),
  path.join(stage, "public", "lib"),
  { recursive: true },
);
await cp(
  path.join(root, "vendor", "theseus", "tools"),
  path.join(stage, "tools"),
  { recursive: true },
);
await cp(
  path.join(root, "public", "games", "keep"),
  path.join(stage, "public", "games", "keep"),
  { recursive: true },
);
const { buildGames } = await import(
  path.join(stage, "tools", "bake", "build-games.mjs")
);
await buildGames();
await mkdir(path.join(root, "public", "dist"), { recursive: true });
await rm(path.join(root, "public", "dist", "keep"), {
  recursive: true,
  force: true,
});
await cp(
  path.join(stage, "public", "dist", "keep"),
  path.join(root, "public", "dist", "keep"),
  { recursive: true },
);
await cp(
  path.join(root, "vendor", "theseus", "LICENSE"),
  path.join(root, "public", "dist", "keep", "THESEUS-LICENSE.txt"),
);
console.log("Keep baked with pinned Theseus a6c5535 → public/dist/keep");
