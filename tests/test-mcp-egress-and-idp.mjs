import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { guardToolOutput } from "../plugins/medcius/servers/shared/phi-output.mjs";
import { IdpJwksVerifier } from "../plugins/medcius/lib/idp-jwks-verifier.mjs";
import { extractAuthContext, generateToken } from "../plugins/medcius/servers/api/src/auth-middleware.mjs";

const data = mkdtempSync(join(tmpdir(), "medcius-egress-"));
const env = { ...process.env, CLAUDE_MEDCIUS_DATA: data, NODE_NO_WARNINGS: "1" };
const phi = "姓名：张三 电话：13800138000 肌酐 90 μmol/L";
function noPhi(value) { assert.doesNotMatch(JSON.stringify(value), /张三|13800138000/); }
async function rpc(entry, messages, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { env: { ...env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", err = "";
    const results = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error("MCP_TEST_TIMEOUT " + err)); }, 10000);
    child.stderr.on("data", d => { err += d; });
    child.on("error", reject);
    child.on("exit", () => { clearTimeout(timer); if (results.length !== messages.length) reject(new Error("MCP_TEST_EARLY_EXIT " + err)); });
    child.stdout.on("data", d => {
      buf += d;
      while (buf.includes("\n")) {
        const i = buf.indexOf("\n"), line = buf.slice(0, i); buf = buf.slice(i + 1);
        results.push(JSON.parse(line));
        if (results.length === messages.length) { clearTimeout(timer); child.stdin.end(); resolve(results); }
        else child.stdin.write(JSON.stringify(messages[results.length]) + "\n");
      }
    });
    child.stdin.write(JSON.stringify(messages[0]) + "\n");
  });
}
const call = (id, name, args = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("serialized FHIR resources, narratives, attachments and malicious keys are guarded", () => {
  const result = guardToolOutput({ content: [{ type: "text", text: JSON.stringify({ resourceType: "Patient", id: "p1", name: [{ given: ["张三"] }], text: { div: phi }, attachment: { contentType: "application/pdf", data: "UNSCANNABLE" } }) }] });
  noPhi(result);
  assert.match(JSON.stringify(result), /PHI_UNSCANNABLE_ATTACHMENT/);
  assert.match(JSON.stringify(result), /p1/);
  assert.throws(() => guardToolOutput({ "13800138000": "x" }), /UNSAFE_KEY/);
  assert.throws(() => guardToolOutput({ type: "image", data: "binary" }), /UNSCANNABLE/);
  assert.deepEqual(guardToolOutput(result), result);
});

test("FHIR MCP remains read-only even with the former opt-out", async () => {
  const [list, save] = await rpc("plugins/medcius/servers/fhir/src/index.mjs", [{ jsonrpc: "2.0", id: 1, method: "tools/list" }, call(2, "save_document_for_extraction", { doc_ref_id: "test" })], { MEDCIUS_FHIR_READ_ONLY: "false" });
  assert.ok(!list.result.tools.some(t => ["create_resource", "update_resource"].includes(t.name)));
  assert.match(JSON.stringify(save), /PHI_UNSCANNABLE_ATTACHMENT_EXPORT/);
});

test("actual documents MCP, CLI, dump files, prompts and observation log enforce PHI egress", async () => {
  const seed = spawnSync(process.execPath, ["--input-type=module", "-e", `import {db} from './plugins/medcius/servers/documents/src/db.mjs'; db.prepare('INSERT INTO documents(id,content,sha256,family) VALUES(1,?,?,?)').run(${JSON.stringify(phi)},'fixture-hash','fixture'); db.exec("INSERT INTO corpus_documents(corpus,uri,doc_id) VALUES('fixture','note.txt',1); INSERT INTO runs(run_id,question,corpus) VALUES('test','q','fixture')");`], { env, encoding: "utf8" });
  assert.equal(seed.status, 0, seed.stderr);
  const results = await rpc("plugins/medcius/servers/documents/src/index.mjs", [
    call(1, "doc_text", { doc_id: 1 }),
    call(2, "sql", { query: "SELECT '姓名：张三 电话：13800138000' AS excerpt" }),
    call(3, "dump", { run_id: "test", shards: [{ label: "one", doc_ids: [1] }], rubric: phi }),
    call(4, "log_observation", { entry: phi }),
    call(5, "sql", { query: "SELECT * FROM '13800138000'" }),
  ]);
  results.forEach(noPhi);
  for (const r of results.slice(0, 4)) assert.notEqual(r.result.isError, true, JSON.stringify(r));
  assert.equal(results[4].result.isError, true);
  const dump = JSON.parse(results[2].result.content.at(-1).text);
  noPhi(readFileSync(dump.shards[0].prompt_path, "utf8"));
  const { readdirSync } = await import("node:fs");
  for (const file of readdirSync(join(data, "documents/shards/test/one"))) noPhi(readFileSync(join(data, "documents/shards/test/one", file), "utf8"));
  noPhi(readFileSync(join(data, "documents/observations.md"), "utf8"));
  const cli = spawnSync(process.execPath, ["plugins/medcius/servers/documents/src/index.mjs", "doc_text", '{"doc_id":1}'], { env, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr); noPhi(cli.stdout);
});

test("RSA/EC verification reaches HTTP auth context and rejects mock, missing claims, bad config and HMAC fallback", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const verifier = new IdpJwksVerifier({ allowedAudiences: ["api"], allowedTenants: ["site"] });
  const staticKeys = { rsa: rsa.publicKey.export({ type: "spki", format: "pem" }), ec: ec.publicKey.export({ type: "spki", format: "pem" }) };
  verifier.registerTrustedIssuer("https://fixture.invalid", { staticKeys, tenantId: "site" });
  function token(alg = "RS256", overrides = {}) {
    const h = Buffer.from(JSON.stringify({ alg, kid: alg === "ES256" ? "ec" : "rsa" })).toString("base64url");
    const p = Buffer.from(JSON.stringify({ sub: "doctor", iss: "https://fixture.invalid", aud: ["api"], tenant_id: "site", roles: ["physician"], exp: Math.floor(Date.now()/1000)+60, ...overrides })).toString("base64url");
    const sig = sign("sha256", Buffer.from(`${h}.${p}`), { key: alg === "ES256" ? ec.privateKey : rsa.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return `${h}.${p}.${sig}`;
  }
  assert.equal(verifier.verifyToken(token("ES256")).isValid, true);
  for (const t of [token("none_mock"), token("RS256", { exp: null }), token("RS256", { exp: Math.floor(Date.now()/1000) }), token("RS256", { tenant_id: null }), token("RS256", { sub: "" }), token("RS256", { roles: "physician" }), token("RS256", { nbf: "bad" }), token("RS256", { aud: "other" })]) assert.equal(verifier.verifyToken(t).isValid, false);
  const config = join(data, "idp.json");
  writeFileSync(config, JSON.stringify({ allowedAudiences: ["api"], allowedTenants: ["site"], issuers: [{ issuerUrl: "https://fixture.invalid", tenantId: "site", staticKeys }] }));
  const prior = process.env.MEDCIUS_IDP_CONFIG;
  process.env.MEDCIUS_IDP_CONFIG = config;
  try {
    const req = { headers: { authorization: `Bearer ${token()}`, "x-tenant-id": "site" } };
    assert.equal(extractAuthContext(req).isAuthenticated, true);
    assert.equal(extractAuthContext({ headers: { ...req.headers, "x-tenant-id": "other" } }).isAuthenticated, false);
    assert.equal(extractAuthContext({ headers: { authorization: `Bearer ${generateToken({ sub: "doctor", tenant_id: "site" })}` } }).isAuthenticated, false);
    writeFileSync(config, "{}");
    assert.equal(extractAuthContext(req).isAuthenticated, false);
  } finally { if (prior === undefined) delete process.env.MEDCIUS_IDP_CONFIG; else process.env.MEDCIUS_IDP_CONFIG = prior; }
});
