// Medcius SMART-on-FHIR OAuth2 client.
//
// Implements the SMART standalone-launch flow: PKCE (S256) for the code
// exchange, discovery against {iss}/.well-known/smart-configuration, a
// redirect listener bound to localhost, and state verification on the
// callback. Two fetches here carry credentials or one-time codes — discovery
// and the token request — so both set redirect: "error", the same pin the FHIR
// data path enforces.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { validateBaseUrl } from "../fhir-client.mjs";

/**
 * @typedef {object} SmartConfig
 * @property {string} authorization_endpoint
 * @property {string} token_endpoint
 * @property {string[]} [scopes_supported]
 * @property {string[]} [capabilities]
 */

/**
 * @typedef {object} SmartTokens
 * @property {string} access_token
 * @property {string} [refresh_token]
 * @property {number} [expires_in]
 * @property {string} [scope]
 * @property {string} [patient]
 * @property {string} [fhirUser]
 * @property {string} [id_token]
 */

/**
 * @typedef {object} PendingAuth
 * @property {string} authorize_url
 * @property {(callbackUrl: string) => Promise<SmartTokens>} complete
 */

const REDIRECT_PORTS = [53682, 53683];

/** @param {Buffer} buf @returns {string} */
function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function makePkce() {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** @param {URL} iss @returns {Promise<SmartConfig>} */
export async function discover(iss) {
  const endpoint = new URL(".well-known/smart-configuration", iss.href.replace(/\/+$/, "") + "/");
  const res = await fetch(endpoint, {
    headers: { Accept: "application/json" },
    // a redirect could steer discovery to endpoints validateBaseUrl never saw
    redirect: "error",
  });
  if (!res.ok) throw new Error(`SMART discovery failed: ${res.status}`);
  const cfg = /** @type {SmartConfig} */ (await res.json());
  validateBaseUrl(cfg.authorization_endpoint);
  validateBaseUrl(cfg.token_endpoint);
  return cfg;
}

// SMART scope v2 (`.rs`/`.cruds`) falls back to v1 (`.read`/`.write`) when the
// server doesn't advertise permission-v2 — keeps one default scope string
// portable across Epic (v1+v2) and Cerner/athenahealth (historically v1).
/** @param {SmartConfig} cfg @param {string} scope @returns {string} */
export function negotiateScope(cfg, scope) {
  if (cfg.capabilities?.includes("permission-v2")) return scope;
  return scope.replace(
    /([A-Za-z*]+\/[A-Za-z*]+)\.([cruds]+)\b/g,
    (_, /** @type {string} */ resource, /** @type {string} */ ops) => {
      /** @type {string[]} */
      const mapped = [];
      if (/[rs]/.test(ops)) mapped.push(`${resource}.read`);
      if (/[cud]/.test(ops)) mapped.push(`${resource}.write`);
      return mapped.join(" ");
    },
  );
}

/**
 * @param {SmartConfig} cfg
 * @param {{ iss: URL, client_id: string, scope: string, redirect_uri: string, state: string, challenge: string }} params
 * @returns {URL}
 */
function assembleAuthorizeUrl(cfg, params) {
  const url = new URL(cfg.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.client_id);
  url.searchParams.set("redirect_uri", params.redirect_uri);
  url.searchParams.set("scope", params.scope);
  url.searchParams.set("state", params.state);
  url.searchParams.set("aud", params.iss.href);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

/** @param {string} url */
function openBrowser(url) {
  const argv =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  try {
    const child = spawn(argv[0], argv.slice(1), { stdio: "ignore", detached: true });
    child.on("error", () => {}); // ENOENT arrives async; unhandled it kills the process
    child.unref();
  } catch {}
}

/**
 * @typedef {object} CallbackServer
 * @property {string} redirect_uri
 * @property {() => Promise<string>} waitForUrl
 * @property {() => void} close
 */

/** @returns {Promise<CallbackServer>} */
async function bindCallback() {
  /** @type {unknown} */
  let lastError;
  for (const port of REDIRECT_PORTS) {
    const redirectUri = `http://localhost:${port}/callback`;
    try {
      return await new Promise((resolveBind, rejectBind) => {
        /** @type {(u: string) => void} */
        let resolveUrl;
        /** @type {Promise<string>} */
        const urlPromise = new Promise((res) => (resolveUrl = res));
        const server = createServer((req, res) => {
          const parsed = new URL(req.url ?? "/", redirectUri);
          if (parsed.pathname !== "/callback") {
            res.writeHead(404).end();
            return;
          }
          res
            .writeHead(200, { "Content-Type": "text/html" })
            .end("<p>Signed in. You can close this tab.</p>");
          server.close();
          resolveUrl(parsed.href);
        });
        server.on("error", rejectBind);
        server.listen(port, "127.0.0.1", () =>
          resolveBind({
            redirect_uri: redirectUri,
            waitForUrl: () => urlPromise,
            close: () => server.close(),
          }),
        );
      });
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`could not bind redirect port ${REDIRECT_PORTS.join("/")}: ${lastError}`);
}

/** @param {SmartConfig} cfg @param {Record<string, string>} body @returns {Promise<SmartTokens>} */
async function exchange(cfg, body) {
  const res = await fetch(cfg.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body),
    // a 307/308 would re-POST the authorization code / PKCE verifier /
    // signed client assertion to wherever the redirect points — the
    // credential-bearing sibling of the data-path pin
    redirect: "error",
  });
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return /** @type {SmartTokens} */ (await res.json());
}

/**
 * @param {{ iss: URL, client_id: string, scope: string, redirect_uri: string }} opts
 * @returns {Promise<PendingAuth>}
 */
export async function smartBegin(opts) {
  const cfg = await discover(opts.iss);
  const scope = negotiateScope(cfg, opts.scope);
  const pkce = makePkce();
  const state = b64url(randomBytes(16));
  const authorizeUrl = assembleAuthorizeUrl(cfg, {
    ...opts,
    scope,
    state,
    challenge: pkce.challenge,
  });
  return {
    authorize_url: authorizeUrl.href,
    complete: async (callbackUrl) => {
      const callback = new URL(callbackUrl, opts.redirect_uri);
      const error = callback.searchParams.get("error");
      if (error)
        throw new Error(`authorize error: ${error} ${callback.searchParams.get("error_description") ?? ""}`);
      if (callback.searchParams.get("state") !== state) throw new Error("state mismatch");
      const code = callback.searchParams.get("code");
      if (!code) throw new Error("missing code");
      return exchange(cfg, {
        grant_type: "authorization_code",
        code,
        redirect_uri: opts.redirect_uri,
        client_id: opts.client_id,
        code_verifier: pkce.verifier,
      });
    },
  };
}

/** @returns {boolean} */
export function isHeadless() {
  if (process.env.FHIR_AUTH_MODE === "manual") return true;
  if (process.env.COWORK_VSOCK_ADDR) return true;
  if (process.platform === "darwin" || process.platform === "win32") return false;
  return !process.env.DISPLAY;
}

/**
 * @param {{ iss: URL, client_id: string, scope: string }} opts
 * @returns {Promise<SmartTokens>}
 */
export async function smartLaunch(opts) {
  const callback = await bindCallback();
  try {
    const pending = await smartBegin({ ...opts, redirect_uri: callback.redirect_uri });
    process.stderr.write(`\nSign in: ${pending.authorize_url}\n`);
    openBrowser(pending.authorize_url);
    return await pending.complete(await callback.waitForUrl());
  } finally {
    callback.close();
  }
}

/**
 * @param {SmartConfig} cfg
 * @param {string} client_id
 * @param {string} refresh_token
 * @returns {Promise<SmartTokens>}
 */
export async function smartRefresh(cfg, client_id, refresh_token) {
  return exchange(cfg, { grant_type: "refresh_token", refresh_token, client_id });
}
