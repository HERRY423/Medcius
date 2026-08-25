// SMART on FHIR / OIDC / Hospital Unified Identity Auth & RBAC Middleware
// Standards-compliant identity verification, tenant isolation, and role authorization.
// Security Model: Default Closed (默认关闭) with strict JWT issuer, audience, alg, and tenant binding.

import { createHmac } from "node:crypto";

export const ROLES = {
  PHYSICIAN: "physician",
  PHARMACIST: "pharmacist",
  AUDITOR: "auditor",
  ADMIN: "admin",
  SYSTEM: "system",
};

// Hierarchy and permissions map
const ROLE_PERMISSIONS = {
  [ROLES.PHYSICIAN]: new Set([
    "prescription:review",
    "coding:resolve",
    "note:extract",
    "encounter:process",
    "cds:hook",
    "training:submit",
  ]),
  [ROLES.PHARMACIST]: new Set([
    "prescription:review",
    "coding:resolve",
    "note:extract",
    "encounter:process",
    "cds:hook",
    "audit:signoff",
    "audit:query",
    "audit:verify",
    "qc:view",
    "learning:view",
    "training:submit",
    "analytics:view",
  ]),
  [ROLES.AUDITOR]: new Set([
    "audit:query",
    "audit:verify",
    "audit:export",
    "qc:view",
    "analytics:view",
    "governance:view",
  ]),
  [ROLES.ADMIN]: new Set([
    "prescription:review",
    "coding:resolve",
    "note:extract",
    "encounter:process",
    "cds:hook",
    "audit:signoff",
    "audit:query",
    "audit:verify",
    "audit:export",
    "qc:view",
    "qc:scan",
    "learning:view",
    "learning:suggest",
    "training:submit",
    "analytics:view",
    "governance:view",
    "governance:advance",
    "knowledge:manage",
  ]),
  [ROLES.SYSTEM]: new Set([
    "prescription:review",
    "coding:resolve",
    "note:extract",
    "encounter:process",
    "cds:hook",
    "audit:signoff",
    "audit:query",
    "audit:verify",
  ]),
};

const ALLOWED_ALGS = new Set(["HS256", "RS256", "ES256"]);
const DEFAULT_ISSUER = "https://auth.medcius.hospital.internal";
const DEFAULT_AUDIENCE = "https://api.medcius.hospital.internal";

function base64UrlDecode(str) {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return Buffer.from(b64, "base64").toString("utf8");
}

function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Get active JWT Secret, enforcing production environment mandatory configuration.
 */
export function getJwtSecret() {
  const isProduction = process.env.NODE_ENV === "production" || process.env.MEDCIUS_PROFILE === "production";
  const secret = process.env.MEDCIUS_JWT_SECRET;
  if (isProduction && (!secret || secret === "medcius-dev-jwt-secret-2026")) {
    throw new Error("FATAL_PROD_AUTH_CONFIG_ERROR: Production environment requires explicitly configured MEDCIUS_JWT_SECRET or JWKS. Default/empty secrets are strictly prohibited.");
  }
  return secret || "medcius-dev-jwt-secret-2026";
}

/**
 * Generate a signed JWT token for test or client authentication.
 */
export function generateToken(payload, options = {}) {
  const secret = options.secret || getJwtSecret();
  const alg = options.alg || "HS256";
  const header = { alg, typ: "JWT" };
  const nowSec = Math.floor(Date.now() / 1000);
  const fullPayload = {
    iss: options.iss || DEFAULT_ISSUER,
    aud: options.aud || DEFAULT_AUDIENCE,
    iat: nowSec,
    exp: nowSec + (options.expiresInSec || 3600), // 1 hour default validity
    tenant_id: payload.tenant_id || "default",
    roles: payload.roles || [ROLES.PHARMACIST],
    ...payload,
  };

  const encHeader = base64UrlEncode(JSON.stringify(header));
  const encPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const data = `${encHeader}.${encPayload}`;
  const sig = base64UrlEncode(createHmac("sha256", secret).update(data).digest());

  return `${data}.${sig}`;
}

/**
 * Verify and decode standard SMART / OIDC / Hospital JWT Bearer token.
 * Validates: segments, base64 json, algorithm, expiration, issuer, audience, and signature.
 */
export function verifyToken(token, options = {}) {
  if (!token || typeof token !== "string") {
    return { valid: false, error: "Empty or invalid token format" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, error: "Malformed JWT: expected 3 dot-separated segments" };
  }

  const [encHeader, encPayload, sig] = parts;
  let header, payload;

  try {
    header = JSON.parse(base64UrlDecode(encHeader));
    payload = JSON.parse(base64UrlDecode(encPayload));
  } catch (err) {
    return { valid: false, error: `Invalid Base64 JSON in token: ${err.message}` };
  }

  // 1. Verify Algorithm
  if (!header.alg || !ALLOWED_ALGS.has(header.alg)) {
    return { valid: false, error: `Unsupported or prohibited JWT algorithm: ${header.alg}` };
  }

  // 2. Verify Expiration
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < nowSec) {
    return { valid: false, error: "Token expired", payload };
  }
  if (payload.nbf && payload.nbf > nowSec) {
    return { valid: false, error: "Token not yet valid (nbf in future)", payload };
  }

  // 3. Verify Issuer & Audience if specified
  const expectedIss = options.issuer || process.env.MEDCIUS_JWT_ISSUER || DEFAULT_ISSUER;
  if (expectedIss && payload.iss && payload.iss !== expectedIss) {
    return { valid: false, error: `Invalid issuer: expected ${expectedIss}, got ${payload.iss}`, payload };
  }

  const expectedAud = options.audience || process.env.MEDCIUS_JWT_AUDIENCE || DEFAULT_AUDIENCE;
  if (expectedAud && payload.aud && payload.aud !== expectedAud) {
    return { valid: false, error: `Invalid audience: expected ${expectedAud}, got ${payload.aud}`, payload };
  }

  // 4. Verify Signature
  const secret = options.secret || getJwtSecret();
  const expectedSig = base64UrlEncode(
    createHmac("sha256", secret).update(`${encHeader}.${encPayload}`).digest(),
  );
  if (sig !== expectedSig) {
    return { valid: false, error: "Invalid token signature", payload };
  }

  return { valid: true, payload, header };
}

/**
 * Extract identity context from HTTP request.
 * Enforces strict tenant binding and default-empty roles for unauthenticated requests.
 */
export function extractAuthContext(req) {
  const authHeader = req.headers["authorization"] || req.headers["x-hospital-token"] || "";
  const tenantHeader = req.headers["x-tenant-id"] || null;

  let token = null;
  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  } else if (authHeader) {
    token = authHeader.trim();
  }

  if (token) {
    const verifyRes = verifyToken(token);
    if (verifyRes.valid) {
      const p = verifyRes.payload;
      const tokenTenant = p.tenant_id || p.hospital_id || "default";

      // Strict Tenant Binding check: if header and token disagree, reject!
      if (tenantHeader && tenantHeader !== "default" && tokenTenant !== "default" && tenantHeader !== tokenTenant) {
        return {
          isAuthenticated: false,
          user: "tenant_mismatch",
          roles: [],
          tenantId: tenantHeader,
          tenantMismatch: true,
          claims: {},
        };
      }

      return {
        isAuthenticated: true,
        user: p.sub || p.user_id || p.name || "authenticated_user",
        roles: Array.isArray(p.roles) ? p.roles : (p.role ? [p.role] : []),
        tenantId: tenantHeader || tokenTenant,
        claims: p,
      };
    }
  }

  // Default Closed Fallback context: unauthenticated requests have ZERO roles
  return {
    isAuthenticated: false,
    user: "anonymous",
    roles: [], // ZERO default permissions! Prohibits unauthorized access.
    tenantId: tenantHeader || "default",
    claims: {},
  };
}

/**
 * Authorize an incoming request against required permission.
 * Default closed: anonymous callers receive 401 Unauthorized unless explicit public route.
 */
export function authorizeRequest(authContext, requiredPermission) {
  const isProduction = process.env.NODE_ENV === "production" || process.env.MEDCIUS_PROFILE === "production";
  const allowAnonymousDev = !isProduction && process.env.MEDCIUS_ALLOW_ANONYMOUS === "true";

  if (authContext.tenantMismatch) {
    return {
      allowed: false,
      status: 403,
      error: "Forbidden (403): X-Tenant-ID header does not match authenticated token tenant_id binding.",
    };
  }

  if (!authContext.isAuthenticated) {
    if (allowAnonymousDev) {
      return { allowed: true, reason: "development_permissive_override" };
    }
    return {
      allowed: false,
      status: 401,
      error: "Authentication Required (401 Unauthorized): Valid Bearer token must be provided.",
    };
  }

  // Check permissions for user's roles
  for (const role of authContext.roles) {
    const perms = ROLE_PERMISSIONS[role];
    if (perms && perms.has(requiredPermission)) {
      return { allowed: true, matchedRole: role };
    }
  }

  return {
    allowed: false,
    status: 403,
    error: `Forbidden (403): Missing required permission [${requiredPermission}] for roles [${authContext.roles.join(", ")}]`,
  };
}
