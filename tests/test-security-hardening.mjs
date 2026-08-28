// API Security Hardening Tests: rate limiter, brute-force lockout,
// security headers, and live-server 429 behavior.
import assert from "node:assert/strict";
import { createRateLimiter, createBruteForceGuard, securityHeaders, clientKey } from "../plugins/medcius/servers/api/src/security-hardening.mjs";
import { resetTransportEdgeGuards } from "../plugins/medcius/servers/api/src/rest-routes.mjs";

console.log("== Testing API security hardening (rate limit / lockout / headers) ==");

// ----------------------------------------------------
// Test 1: rate limiter — fixed window, per-key isolation
// ----------------------------------------------------
console.log("\n[Test 1] Rate limiter blocks beyond max and isolates keys...");
const rl = createRateLimiter({ windowMs: 60_000, max: 5 });
for (let i = 0; i < 5; i++) {
  const r = rl.check("ip-a");
  assert.equal(r.allowed, true, `request ${i + 1} must pass`);
}
const blocked = rl.check("ip-a");
assert.equal(blocked.allowed, false);
assert.ok(blocked.retryAfterSec > 0 && blocked.retryAfterSec <= 60);
assert.equal(rl.check("ip-b").allowed, true, "different key must be independent");
rl.reset();
assert.equal(rl.check("ip-a").allowed, true, "reset must clear counters");

// ----------------------------------------------------
// Test 2: brute-force guard — lock after N failures, success clears
// ----------------------------------------------------
console.log("\n[Test 2] Brute-force lockout after repeated failures...");
const bg = createBruteForceGuard({ maxFailures: 3, windowMs: 60_000, lockoutMs: 60_000 });
for (let i = 0; i < 3; i++) bg.recordFailure("attacker");
assert.equal(bg.isLocked("attacker").locked, true);
assert.ok(bg.isLocked("attacker").remainingLockSec > 0);
assert.equal(bg.isLocked("innocent").locked, false);
bg.recordSuccess("attacker");
assert.equal(bg.isLocked("attacker").locked, false, "explicit success must clear state");

// Expiry path: tiny window/lockout.
const bgFast = createBruteForceGuard({ maxFailures: 1, windowMs: 60_000, lockoutMs: 30 });
bgFast.recordFailure("tmp");
assert.equal(bgFast.isLocked("tmp").locked, true);
await new Promise((r) => setTimeout(r, 40));
assert.equal(bgFast.isLocked("tmp").locked, false, "lockout must expire");
console.log("✓ Lockout engages at threshold, expires on time, and clears on success");

// ----------------------------------------------------
// Test 3: security headers — strict set, HSTS only with TLS
// ----------------------------------------------------
console.log("\n[Test 3] Security headers policy...");
const plain = securityHeaders({ isTls: false });
const tls = securityHeaders({ isTls: true });
assert.equal(plain["X-Content-Type-Options"], "nosniff");
assert.equal(plain["X-Frame-Options"], "DENY");
assert.equal(plain["Referrer-Policy"], "no-referrer");
assert.equal(plain["Cache-Control"], "no-store");
assert.ok(plain["Content-Security-Policy"].includes("frame-ancestors 'none'"));
assert.ok(!("Strict-Transport-Security" in plain), "HSTS must not appear over plain HTTP");
assert.ok(tls["Strict-Transport-Security"].includes("max-age=31536000"));
console.log("✓ Header set correct; HSTS gated on TLS");

// clientKey fallback order
assert.equal(clientKey({ socket: { remoteAddress: "10.0.0.1" } }, null), "10.0.0.1");
assert.equal(clientKey({ socket: { remoteAddress: "10.0.0.1" } }, { user: "DOC-1" }), "DOC-1", "authenticated identity takes precedence");
assert.equal(clientKey({}, null), "unknown");

// ----------------------------------------------------
// Test 4: live server — headers present, rate limit returns 429
// ----------------------------------------------------
console.log("\n[Test 4] Live server integration (low rate limit)...");
process.env.MEDCIUS_RATE_LIMIT_PER_MIN = "15";
const { createServer } = await import("../plugins/medcius/servers/api/src/server.mjs");
const server = createServer({});
await new Promise((resolve, reject) => {
  server.listen(0, "127.0.0.1", resolve);
  server.on("error", reject);
});
const port = server.address().port;
try {
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.equal(health.headers.get("x-frame-options"), "DENY");
  assert.ok(!health.headers.get("strict-transport-security"), "no HSTS over plain HTTP in test");

  // Hammer a rate-limited endpoint.
  let saw429 = false;
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/cds-services`);
    if (res.status === 429) {
      saw429 = true;
      assert.ok(res.headers.get("retry-after"), "429 must carry Retry-After");
      break;
    }
  }
  assert.equal(saw429, true, "must hit RATE_LIMIT_EXCEEDED within 40 requests at limit=15/min");

  const healthAgain = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(healthAgain.status, 200, "health endpoint must remain exempt from rate limiting");
} finally {
  server.close();
  const { resetTransportEdgeGuards } = await import("../plugins/medcius/servers/api/src/rest-routes.mjs");
  resetTransportEdgeGuards();
}
delete process.env.MEDCIUS_RATE_LIMIT_PER_MIN;

// ----------------------------------------------------
// Test 5: token issuance brute-force discipline
// ----------------------------------------------------
console.log("\n[Test 5] Token endpoint records failures and locks out...");
{
  const server2 = createServer({});
  await new Promise((resolve, reject) => {
    server2.listen(0, "127.0.0.1", resolve);
    server2.on("error", reject);
  });
  const port2 = server2.address().port;
  try {
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`http://127.0.0.1:${port2}/api/v1/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (i < 5) {
        assert.equal(res.status, 400, `attempt ${i + 1} should be INVALID_TOKEN_REQUEST`);
      } else {
        assert.equal(res.status, 429, "6th attempt must be locked out");
      }
    }
    const ok = await fetch(`http://127.0.0.1:${port2}/api/v1/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sub: "DOC-X", role: "pharmacist" }),
    });
    assert.equal(ok.status, 429, "locked-out client cannot mint tokens even with valid body");
  } finally {
    server2.close();
    resetTransportEdgeGuards();
  }
}

console.log("\nALL SECURITY HARDENING TESTS PASSED!\n");

