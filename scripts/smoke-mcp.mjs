// MCP transport smoke: spawn a plugin server over stdio, complete the
// initialize handshake, list its tools, and assert the expected tool count.
// Usage: node scripts/smoke-mcp.mjs <server> <expected-tools> [server-args...]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [server, expected, ...serverArgs] = [process.argv[2], Number(process.argv[3]), ...process.argv.slice(4)];
if (!server || !Number.isInteger(expected)) {
  console.error("usage: node scripts/smoke-mcp.mjs <server> <expected-tools> [server-args...]");
  process.exit(2);
}

const child = spawn("node", [server, ...serverArgs], { stdio: ["pipe", "pipe", "inherit"] });
const rl = createInterface({ input: child.stdout });
const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

const timeout = setTimeout(() => {
  console.error(`TIMEOUT waiting on ${server}`);
  child.kill();
  process.exit(1);
}, 15000);

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === 1) {
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  } else if (msg.id === 2) {
    clearTimeout(timeout);
    const tools = msg.result?.tools?.length ?? -1;
    const names = (msg.result?.tools ?? []).map((t) => t.name);
    console.log(`${server}: tools=${tools} (expected ${expected})`);
    console.log(tools === expected ? "TOOLS LIST OK" : `TOOLS LIST MISMATCH: ${names.join(", ")}`);
    child.kill();
    process.exit(tools === expected ? 0 : 1);
  }
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05" },
});
