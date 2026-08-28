// API Security Hardening — rate limiting, brute-force lockout, security headers.
//
// Complements the existing default-closed JWT/RBAC layer (auth-middleware.mjs)
// with transport-edge controls required by the security architecture baseline
// (docs/compliance/SECURITY-ARCHITECTURE.md §4):
//   - fixed-window rate limiting per client identity (default 240 req/min,
//     tunable via MEDCIUS_RATE_LIMIT_PER_MIN; health/OPTIONS exempt);
//   - brute-force lockout on repeated authorization failures (default
//     5 failures / 5 min window → 15 min lockout);
//   - strict security response headers on every response (HSTS only when TLS).
//
// Zero third-party dependencies; all state is in-process memory by design —
// a horizontal deployment would move this to the mTLS gateway (ops manual §3).

const DEFAULT_RATE_WINDOW_MS = 60_000;
// MEDCIUS_RATE_LIMIT_PER_MIN is resolved lazily inside check() so that module
// load order never freezes the limit (tests set it before hammering endpoints).

export function clientKey(req, auth = null) {
  return auth?.user || req?.socket?.remoteAddress || "unknown";
}

/**
 * Fixed-window rate limiter. check(key) -> { allowed, remaining, retryAfterSec }.
 */
export function createRateLimiter({ windowMs = DEFAULT_RATE_WINDOW_MS, max } = {}) {
  if (max != null && (!Number.isInteger(max) || max < 1)) throw new Error("RATE_LIMITER_MAX_INVALID");
  if (!Number.isFinite(windowMs) || windowMs < 100) throw new Error("RATE_LIMITER_WINDOW_INVALID");
  const buckets = new Map();

  function bucketFor(key, now) {
    const windowStart = Math.floor(now / windowMs) * windowMs;
    let bucket = buckets.get(key);
    if (!bucket || bucket.windowStart !== windowStart) {
      bucket = { windowStart, count: 0 };
      buckets.set(key, bucket);
    }
    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) {
        if (b.windowStart < windowStart) buckets.delete(k);
      }
    }
    return bucket;
  }

  return {
    check(key) {
      // Lazy env resolution: module-load order must not freeze the limit
      // (tests set MEDCIUS_RATE_LIMIT_PER_MIN before hammering endpoints).
      const effectiveMax = max ?? Number(process.env.MEDCIUS_RATE_LIMIT_PER_MIN || 240);
      const now = Date.now();
      const bucket = bucketFor(String(key), now);
      bucket.count += 1;
      const allowed = bucket.count <= effectiveMax;
      const retryAfterSec = allowed ? 0 : Math.ceil((bucket.windowStart + windowMs - now) / 1000);
      return { allowed, remaining: Math.max(0, effectiveMax - bucket.count), retryAfterSec };
    },
    reset() {
      buckets.clear();
    },
  };
}

/**
 * Brute-force lockout guard for authentication/authorization failures.
 * recordFailure(key) / recordSuccess(key) / isLocked(key).
 */
export function createBruteForceGuard({
  maxFailures = 5,
  windowMs = 5 * 60_000,
  lockoutMs = 15 * 60_000,
} = {}) {
  if (!Number.isInteger(maxFailures) || maxFailures < 1) throw new Error("BRUTE_GUARD_MAX_FAILURES_INVALID");
  const state = new Map();

  function entryFor(key, now) {
    let entry = state.get(key);
    if (!entry || now - entry.firstFailureAt > windowMs) {
      entry = { failures: 0, firstFailureAt: now, lockedUntil: 0 };
      state.set(key, entry);
    }
    return entry;
  }

  return {
    recordFailure(key) {
      const now = Date.now();
      const entry = entryFor(String(key), now);
      entry.failures += 1;
      if (entry.failures >= maxFailures) {
        entry.lockedUntil = now + lockoutMs;
      }
      return { failures: entry.failures, locked: entry.lockedUntil > now };
    },
    recordSuccess(key) {
      state.delete(String(key));
    },
    isLocked(key) {
      const entry = state.get(String(key));
      if (!entry) return { locked: false, remainingLockSec: 0 };
      const now = Date.now();
      if (entry.lockedUntil > now) {
        return { locked: true, remainingLockSec: Math.ceil((entry.lockedUntil - now) / 1000) };
      }
      // Lock expired: clear so failures restart from zero.
      if (entry.lockedUntil !== 0 && entry.lockedUntil <= now) state.delete(String(key));
      return { locked: false, remainingLockSec: 0 };
    },
    reset() {
      state.clear();
    },
  };
}

/**
 * Strict security headers applied to every response before routing.
 * HSTS is added only when the connection is TLS (never over plain HTTP).
 */
export function securityHeaders({ isTls = false } = {}) {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  };
  if (isTls) {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}

export function applySecurityHeaders(res, { isTls = false } = {}) {
  for (const [name, value] of Object.entries(securityHeaders({ isTls }))) {
    res.setHeader(name, value);
  }
}
