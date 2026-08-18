// Medcius FHIR R4 transport.
//
// Every outbound FHIR request flows through this module so the security
// invariants live in one place instead of being re-derived by each tool:
//   - base URLs are validated up front: https only, or http loopback; no
//     private / link-local IP literals, no cloud-metadata hostnames,
//   - any URL pulled out of a FHIR resource (attachment.url, Bundle link) is
//     pinned to the connected server's origin — one recovery exception exists
//     for attachments whose off-origin path still carries a valid Binary id,
//   - redirects are refused outright, because following one could silently
//     deliver a request to an origin the pin above never approved,
//   - errors are scrubbed so a Bearer credential can never leak into a message
//     the model (or its provider) will see.

import { isIP } from "node:net";

/**
 * @typedef {object} FhirSession
 * @property {URL} baseUrl
 * @property {string | null} token
 */

/** FHIR logical id: 1–64 characters, URL-unreserved, dot or dash allowed. */
const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/;
/** FHIR resource type: PascalCase, at least two letters. */
const FHIR_TYPE = /^[A-Z][A-Za-z]{1,63}$/;

/** @param {string} id @param {string} kind @returns {string} */
export function validateFhirId(id, kind) {
  if (!FHIR_ID.test(id)) throw new Error(`Invalid ${kind} id`);
  return id;
}

/** @param {string} type @returns {string} */
export function validateResourceType(type) {
  if (!FHIR_TYPE.test(type)) throw new Error(`Invalid FHIR resource type: ${type}`);
  return type;
}

// Literal private/link-local IP blocks and well-known metadata hostnames.
// This is a syntactic guard on the literal host only — an internal DNS name
// that resolves to a private address is not caught (socket-level filtering is
// a follow-up), but the obvious probe patterns are.
const PRIVATE_IP =
  /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i;
const METADATA_HOST =
  /^(metadata\.google\.internal|metadata\.goog|instance-data|.*\.(nip\.io|sslip\.io|xip\.io))$/i;

/** @param {string} raw @returns {URL} */
export function validateBaseUrl(raw) {
  const url = new URL(raw.replace(/\/+$/, ""));
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`FHIR base URL must be https (or http://localhost): ${url.origin}`);
  }
  if (!loopback && (METADATA_HOST.test(host) || (isIP(host) && PRIVATE_IP.test(host)))) {
    throw new Error(
      `FHIR base URL must not target a private/link-local or metadata address: ${host}`,
    );
  }
  return url;
}

// URL.href re-adds a trailing slash for path-less origins; joining with "/"
// would yield "//metadata", which most servers 404.
/** @param {FhirSession} session @returns {string} */
export function baseHref(session) {
  return session.baseUrl.href.replace(/\/+$/, "");
}

/** @param {FhirSession} session @param {string} ref @returns {URL} */
export function resolveSameOrigin(session, ref) {
  const resolved = new URL(ref, baseHref(session) + "/");
  if (resolved.origin !== session.baseUrl.origin) {
    throw new Error(`refusing to follow off-origin reference (${resolved.origin})`);
  }
  return resolved;
}

// FHIR logical id with the first char restricted to alnum so "." / ".." path
// segments can never match. Case-insensitive: Medplum's storage paths spell
// the segment "binary".
const BINARY_ID = /\/Binary\/([A-Za-z0-9][A-Za-z0-9.-]{0,63})(?:[/?#]|$)/i;

// Some EHRs (Medplum) rewrite attachment.url to a signed absolute URL on an
// off-origin storage host. Those refs stay refused — but when the off-origin
// path still carries the Binary's logical id, the same bytes are reachable
// same-origin at {base}/Binary/{id}. Recovery never contacts the off-origin
// host and never widens the allowed origin: the re-fetch URL is built only
// from the connected base plus the validated id, then goes back through
// resolveSameOrigin.
/** @param {FhirSession} session @param {string} ref @returns {URL} */
export function resolveAttachmentRef(session, ref) {
  try {
    return resolveSameOrigin(session, ref);
  } catch (refusal) {
    /** @type {string} */
    let pathname;
    try {
      pathname = new URL(ref, baseHref(session) + "/").pathname;
    } catch {
      throw refusal;
    }
    const match = BINARY_ID.exec(pathname);
    if (!match) throw refusal;
    return resolveSameOrigin(session, `Binary/${match[1]}`);
  }
}

// undici buries the useful detail ("unexpected redirect", DNS failure) in
// cause; without it the user sees a bare "fetch failed". The Bearer scrub
// keeps a token that slipped into a URL or body from reaching the caller.
/** @param {unknown} e @returns {Error} */
function scrub(e) {
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : "";
  const message = (e instanceof Error ? e.message : String(e)) + (cause ? `: ${cause}` : "");
  return new Error(message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]"));
}

/** Build the fetch init for a request. A caller-provided contentType sends
 *  body verbatim (the form-encoded POST _search requires it); otherwise the
 *  body is JSON.stringify'd under application/fhir+json.
 *  @param {string} method
 *  @param {FhirSession} session
 *  @param {string} accept
 *  @param {{ method: "POST" | "PUT", body: unknown, contentType?: string }} [write]
 *  @returns {RequestInit} */
function buildInit(method, session, accept, write) {
  /** @type {Record<string, string>} */
  const headers = { Accept: accept };
  if (write) headers["Content-Type"] = write.contentType ?? "application/fhir+json";
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  return {
    method,
    redirect: "error",
    headers,
    body: write
      ? write.contentType
        ? String(write.body)
        : JSON.stringify(write.body)
      : undefined,
  };
}

/**
 * The choke point for every request. Resource-derived URLs (fhirGetRaw /
 * fhirGetBytes) are already origin-pinned by resolveSameOrigin, so following
 * any redirect — or replaying a write at a Location — would bypass the pin.
 *
 * @param {FhirSession} session
 * @param {URL} url
 * @param {string} accept
 * @param {{ method: "POST" | "PUT", body: unknown, contentType?: string }} [write]
 * @returns {Promise<Response>}
 */
async function transmit(session, url, accept, write) {
  const method = write?.method ?? "GET";
  /** @type {Response} */
  let res;
  try {
    res = await fetch(url, buildInit(method, session, accept, write));
  } catch (e) {
    throw scrub(e);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw scrub(
      new Error(
        `FHIR ${method} ${res.status} ${res.statusText} at ${url.pathname}: ${detail.slice(0, 500)}`,
      ),
    );
  }
  return res;
}

/**
 * @template T
 * @param {FhirSession} session
 * @param {URL} url
 * @param {string} accept
 * @returns {Promise<{ body: T, contentType: string }>}
 */
async function roundTrip(session, url, accept) {
  const res = await transmit(session, url, accept);
  const contentType = res.headers.get("content-type") ?? "";
  const body = /** @type {T} */ (accept.includes("json") ? await res.json() : await res.text());
  return { body, contentType };
}

/** Expand a scalar-or-array param value into the list of values to send.
 *  Falsy scalars are dropped — an empty string must not reach the URL or form.
 *  @param {string | string[] | undefined} value @returns {string[]} */
function flatten(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

/** @param {URLSearchParams} target @param {Record<string, string | string[] | undefined> | undefined} params */
function appendParams(target, params) {
  for (const [key, value] of Object.entries(params ?? {})) {
    for (const item of flatten(value)) target.append(key, item);
  }
  return target;
}

/** @typedef {{ recoverBinaryRef?: boolean }} RefOpts */

/** @param {FhirSession} session @param {string} ref @param {RefOpts} [opts] @returns {URL} */
function resolveRef(session, ref, opts) {
  return opts?.recoverBinaryRef ? resolveAttachmentRef(session, ref) : resolveSameOrigin(session, ref);
}

/**
 * @template T
 * @param {FhirSession} session
 * @param {string} path
 * @param {Record<string, string | string[] | undefined>} [params]
 * @returns {Promise<T>}
 */
export async function fhirGet(session, path, params) {
  const url = new URL(`${baseHref(session)}/${path}`);
  appendParams(url.searchParams, params);
  const { body } = await roundTrip(session, url, "application/fhir+json");
  return /** @type {T} */ (body);
}

/** Search via POST {type}/_search with a form-encoded body (FHIR R4
 *  §3.1.0.10). Parameters never enter the request URL, which proxy and server
 *  access logs record — required for searches whose parameters are direct
 *  patient identifiers (name, birthdate, MRN), and the safe default for any
 *  search whose parameters are caller-arbitrary.
 *
 * @template T
 * @param {FhirSession} session
 * @param {string} type
 * @param {Record<string, string | string[] | undefined>} [params]
 * @returns {Promise<T>}
 */
export async function fhirSearch(session, type, params) {
  const url = new URL(`${baseHref(session)}/${type}/_search`);
  const form = appendParams(new URLSearchParams(), params);
  const res = await transmit(session, url, "application/fhir+json", {
    method: "POST",
    body: form.toString(),
    contentType: "application/x-www-form-urlencoded",
  });
  return /** @type {T} */ (await res.json());
}

/**
 * @template T
 * @param {FhirSession} session
 * @param {"POST" | "PUT"} method
 * @param {string} path
 * @param {unknown} body
 * @returns {Promise<T>}
 */
export async function fhirWrite(session, method, path, body) {
  const url = new URL(`${baseHref(session)}/${path}`);
  const res = await transmit(session, url, "application/fhir+json", { method, body });
  return /** @type {T} */ (await res.json());
}

/**
 * @param {FhirSession} session
 * @param {string} ref
 * @param {string} accept
 * @param {RefOpts} [opts]
 * @returns {Promise<{ body: string, contentType: string }>}
 */
export async function fhirGetRaw(session, ref, accept, opts) {
  return roundTrip(session, resolveRef(session, ref, opts), accept);
}

/**
 * @param {FhirSession} session
 * @param {string} ref
 * @param {string} accept
 * @param {RefOpts} [opts]
 * @returns {Promise<Buffer>}
 */
export async function fhirGetBytes(session, ref, accept, opts) {
  const res = await transmit(session, resolveRef(session, ref, opts), accept);
  return Buffer.from(await res.arrayBuffer());
}
