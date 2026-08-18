// Medcius MCP stdio transport.
//
// Line-delimited JSON-RPC 2.0 over stdin/stdout implementing the four methods
// the plugin servers expose (initialize, ping, tools/list, tools/call). No
// SDK: the schemas arrive as frozen literals and shared/validate.mjs does the
// argument checking.
//
// Wire rules, kept deliberately:
//   - A frame carrying an id is a request and gets a reply; one without an id
//     is a notification — ignored and never executed.
//   - Batch arrays and non-object frames are rejected with -32600; the
//     2025-03-26 revision is not advertised because it mandates batching.
//   - Tool failures (including argument-validation failures) are in-band
//     isError results, never protocol errors: the model reads the reason and
//     corrects its call.
//   - Requests run one at a time on a serialized chain — handlers may be
//     async (document extraction spawns subprocesses) and a second frame must
//     not interleave a side-effecting call over shared state.
//   - If the host dies (EPIPE on stdout) we exit rather than keep executing
//     calls whose results nobody can observe.

import { createInterface } from "node:readline";

import { checkAndStrip } from "./validate.mjs";

/** @typedef {Record<string, unknown>} Args */

/**
 * @typedef {object} ToolDef
 * @property {string} name
 * @property {string} description
 * @property {Record<string, unknown>} inputSchema
 * @property {Record<string, unknown>} [annotations]
 */

/**
 * @typedef {object} ServeConfig
 * @property {{ name: string, version: string }} serverInfo
 * @property {string} [instructions]
 * @property {ToolDef[]} tools
 * @property {Record<string, (a: Args) => unknown | Promise<unknown>>} handlers
 * @property {Record<string, (result: unknown, args: Args) => string>} [summarize]
 */

const PROTOCOL_VERSIONS = ["2024-11-05", "2025-06-18"];

/**
 * Invoke a single tool with no MCP host — schema validation + handler, raw
 * result, thrown errors. Skills use this to drive a server as a CLI where no
 * host is present (cloud containers sync plugin skills but do not start the
 * servers).
 * @param {Pick<ServeConfig, "tools" | "handlers">} cfg
 * @param {string} name
 * @param {unknown} rawArgs
 * @returns {Promise<unknown>}
 */
export async function runOnce(cfg, name, rawArgs) {
  const def = cfg.tools.find((t) => t.name === name);
  if (!def)
    throw new Error(`unknown tool "${name}" — one of: ${cfg.tools.map((t) => t.name).join(", ")}`);
  return cfg.handlers[name](checkAndStrip(name, def.inputSchema, rawArgs));
}

/** Wrap a plain handler result in the MCP content envelope. */
function toContent(result, summary) {
  const blocks = [];
  if (summary) blocks.push({ type: "text", text: summary });
  blocks.push({ type: "text", text: JSON.stringify(result ?? { ok: true }) });
  return { content: blocks };
}

/** Build the in-band error result the model can read and react to. */
function toError(err) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: String(err?.message ?? err) }) }],
    isError: true,
  };
}

/**
 * Serve the transport until stdin closes or the host disconnects.
 * @param {ServeConfig} cfg
 * @returns {void}
 */
export function serve(cfg) {
  const { serverInfo, tools, handlers, summarize, instructions } = cfg;
  const byName = new Map(tools.map((t) => [t.name, t]));

  const send = (msg) => void process.stdout.write(`${JSON.stringify(msg)}\n`);
  const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
  const respondError = (id, code, message) =>
    send({ jsonrpc: "2.0", id, error: { code, message } });

  /** Run one tools/call; returns the MCP result envelope (never throws). */
  async function callTool(name, rawArgs) {
    const def = byName.get(name);
    if (!def) throw Object.assign(new Error(`unknown tool: ${name}`), { rpcCode: -32602 });
    try {
      const args = checkAndStrip(name, def.inputSchema, rawArgs);
      const result = await handlers[name](args);
      // Handlers may already return a ready-made content envelope (the FHIR
      // server's text()/json() helpers do) — pass those through untouched.
      if (result && typeof result === "object" && Array.isArray(result.content)) return result;
      let note;
      try {
        note = summarize?.[name]?.(result, args);
      } catch {
        note = undefined;
      }
      return toContent(result, note);
    } catch (e) {
      return toError(e);
    }
  }

  /** Handle one parsed request/notification frame; self-contained error handling. */
  async function dispatch(msg) {
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
      switch (msg.method) {
        case "initialize": {
          if (!isRequest) return;
          const wanted = msg.params?.protocolVersion ?? PROTOCOL_VERSIONS[0];
          respond(msg.id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(wanted) ? wanted : PROTOCOL_VERSIONS.at(-1),
            capabilities: { tools: { listChanged: true } },
            serverInfo,
            ...(instructions ? { instructions } : {}),
          });
          return;
        }
        case "ping":
          if (isRequest) respond(msg.id, {});
          return;
        case "tools/list":
          if (isRequest) respond(msg.id, { tools });
          return;
        case "tools/call":
          if (isRequest) respond(msg.id, await callTool(msg.params?.name, msg.params?.arguments));
          return;
        default:
          if (isRequest) respondError(msg.id, -32601, `method not found: ${msg.method}`);
          return;
      }
    } catch (e) {
      if (isRequest) respondError(msg.id, e.rpcCode ?? -32603, String(e.message ?? e));
    }
  }

  // Serialized chain: one request runs to completion before the next begins.
  let tail = Promise.resolve();
  const enqueue = (work) => {
    tail = tail
      .then(work)
      .catch((e) => {
        process.stderr.write(`${serverInfo.name}: dispatch failed: ${String(e?.message ?? e)}\n`);
        if (e?.code === "EPIPE") process.exit(1);
      });
  };

  process.stdout.on("error", (e) => {
    process.stderr.write(`${serverInfo.name}: stdout write failed: ${String(e?.message ?? e)}\n`);
    if (e?.code === "EPIPE") process.exit(1);
    throw e;
  });

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      respondError(null, -32700, "parse error: invalid JSON");
      return;
    }
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      respondError(
        null,
        -32600,
        Array.isArray(msg) ? "batch requests are not supported" : "invalid request",
      );
      return;
    }
    enqueue(() => dispatch(msg));
  });
  rl.on("close", () => process.exit(0));

  process.stderr.write(`${serverInfo.name}: stdio ready\n`);
}
