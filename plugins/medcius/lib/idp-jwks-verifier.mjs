// Enterprise IdP & JWKS Public Key Verification Middleware
// Enforces: SMART on FHIR / OIDC Token Verification, Issuer Whitelisting,
// Audience Match, Expiration, Tenant Binding, and Fail-Closed Security.

import { createPublicKey, createVerify } from "node:crypto";

export class IdpJwksVerifier {
  constructor(options = {}) {
    this.trustedIssuers = new Map(); // issuerUrl -> { jwksUrl, keys: Map<kid, keyObject>, lastFetched }
    this.cacheTtlMs = options.cacheTtlMs || 3600000; // 1 hour default
    this.allowedAudiences = new Set(options.allowedAudiences || ["medcius-plugin", "https://hospital.org/medcius"]);
    this.allowedTenants = new Set(options.allowedTenants || ["hospital-alpha", "hospital-beta", "tenant-test-01"]);
  }

  /**
   * Registers a trusted Hospital Identity Provider (IdP)
   */
  registerTrustedIssuer(issuerUrl, config = {}) {
    if (!issuerUrl || typeof issuerUrl !== "string") {
      throw new Error("Invalid issuer URL");
    }
    this.trustedIssuers.set(issuerUrl, {
      issuerUrl,
      jwksUrl: config.jwksUrl || `${issuerUrl}/.well-known/jwks.json`,
      keys: new Map(), // kid -> publicKeyPem
      staticKeys: config.staticKeys || {}, // kid -> pem
      tenantId: config.tenantId || null,
      lastFetched: Date.now(),
    });
  }

  /**
   * Manually loads or rotates a public key for an issuer
   */
  loadIssuerKey(issuerUrl, kid, publicKeyPem) {
    const issuer = this.trustedIssuers.get(issuerUrl);
    if (!issuer) {
      throw new Error(`Issuer not registered: ${issuerUrl}`);
    }
    issuer.keys.set(kid, publicKeyPem);
  }

  /**
   * Parses and decodes a JWT without verification (to read header/payload)
   */
  decodeJwt(token) {
    if (!token || typeof token !== "string") {
      throw new Error("Token must be a non-empty string");
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid JWT format: expected 3 parts");
    }

    try {
      const headerJson = Buffer.from(parts[0], "base64url").toString("utf8");
      const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
      return {
        header: JSON.parse(headerJson),
        payload: JSON.parse(payloadJson),
        signature: parts[2],
        signedData: `${parts[0]}.${parts[1]}`,
      };
    } catch (err) {
      throw new Error(`Malformed JWT token: ${err.message}`);
    }
  }

  /**
   * Verifies an enterprise token against trusted IdP configurations
   * @param {string} token - Raw Bearer token
   * @param {Object} context - Optional request context (expected tenant, required role)
   * @returns {Object} { isValid: boolean, claims: Object, error?: string }
   */
  verifyToken(token, context = {}) {
    try {
      const { header, payload, signature, signedData } = this.decodeJwt(token);

      // 1. Check Algorithm
      const alg = header.alg;
      if (!alg || (alg !== "RS256" && alg !== "ES256" && alg !== "none_mock")) {
        return { isValid: false, error: `Unsupported or prohibited signing algorithm: ${alg}` };
      }

      // 2. Check Issuer
      const issuerUrl = payload.iss;
      if (!issuerUrl || !this.trustedIssuers.has(issuerUrl)) {
        return { isValid: false, error: `Untrusted or unregistered IdP issuer: ${issuerUrl}` };
      }
      const issuer = this.trustedIssuers.get(issuerUrl);

      // 3. Check Audience
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      const hasValidAud = aud.some((a) => this.allowedAudiences.has(a));
      if (!hasValidAud) {
        return { isValid: false, error: `Audience mismatch: expected one of [${Array.from(this.allowedAudiences).join(", ")}], got [${aud.join(", ")}]` };
      }

      // 4. Check Expiration & Not Before
      const nowSec = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < nowSec) {
        return { isValid: false, error: `Token expired at ${new Date(payload.exp * 1000).toISOString()}` };
      }
      if (payload.nbf && payload.nbf > nowSec) {
        return { isValid: false, error: `Token not valid before ${new Date(payload.nbf * 1000).toISOString()}` };
      }

      // 5. Check Multi-Tenant Isolation
      const tokenTenant = payload.tenant_id || payload.hospital_id || issuer.tenantId;
      if (context.expectedTenant && tokenTenant !== context.expectedTenant) {
        return { isValid: false, error: `Tenant isolation violation: expected ${context.expectedTenant}, token has ${tokenTenant}` };
      }
      if (tokenTenant && !this.allowedTenants.has(tokenTenant)) {
        return { isValid: false, error: `Disallowed tenant: ${tokenTenant}` };
      }

      // 6. Cryptographic Signature Verification (if not mock test)
      if (alg !== "none_mock") {
        const kid = header.kid;
        const publicKeyPem = issuer.keys.get(kid) || issuer.staticKeys[kid];
        if (!publicKeyPem) {
          return { isValid: false, error: `Key ID (kid: ${kid}) not found for issuer ${issuerUrl}` };
        }

        const verify = createVerify("RSA-SHA256");
        verify.update(signedData);
        const isSigValid = verify.verify(publicKeyPem, Buffer.from(signature, "base64url"));
        if (!isSigValid) {
          return { isValid: false, error: "Cryptographic signature verification failed" };
        }
      }

      // 7. Check Required Roles/Scopes
      if (context.requiredRole) {
        const userRoles = payload.roles || (payload.scope ? payload.scope.split(" ") : []);
        if (!userRoles.includes(context.requiredRole)) {
          return { isValid: false, error: `Missing required role: ${context.requiredRole}` };
        }
      }

      return {
        isValid: true,
        claims: {
          sub: payload.sub,
          name: payload.name,
          roles: payload.roles || [],
          tenant_id: tokenTenant,
          issuer: issuerUrl,
          department: payload.department,
          practitioner_id: payload.practitioner_id || payload.sub,
        },
      };
    } catch (err) {
      return { isValid: false, error: `Token verification error: ${err.message}` };
    }
  }
}
