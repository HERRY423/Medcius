#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const inner = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins", "medcius", "scripts", "settlement-from-note.mjs");
process.exit(spawnSync("node", [inner, ...process.argv.slice(2)], { stdio: "inherit" }).status ?? 1);
