#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const inner = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins", "medcius", "scripts", "import-official.mjs");
const r = spawnSync("node", [inner, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
