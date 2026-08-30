// Clinician Directory Authentication (医院目录身份适配层 · 缺口三).
//
// Bridges the hospital employee directory (LDAP/AD/统一身份平台) to Medcius
// sessions. The deployment injects a `directory` transport adapter; this module
// performs zero I/O itself and contains zero PHI.
//
// Fail-closed discipline:
//   - unknown user / wrong password → AUTH_INVALID_CREDENTIALS (no distinction
//     leaked between the two, to avoid user enumeration);
//   - repeated failures lock the (tenant, username) pair;
//   - a directory identity without a hospital-configured Medcius role mapping
//     is REJECTED — no implicit privileges, ever;
//   - sessions are standard JWTs with strict tenant binding (auth-middleware),
//     revocable in-memory.
//
// Role mapping is a deterministic, hospital-owned configuration
// (department/title → Medcius roles), mirroring 《处方审核规范》第八条's
// "规则由医疗机构确认" discipline on the identity side.

import { createHash } from "node:crypto";
import { generateToken, verifyToken, ROLES } from "../servers/api/src/auth-middleware.mjs";

const MEDCIUS_ROLES = new Set(Object.values(ROLES));

function sha(input) {
  return createHash("sha256").update(String(input)).digest("hex");
}

export function createSyntheticClinicianDirectory({ clinicians = [] } = {}) {
  if (!Array.isArray(clinicians)) throw new Error("DIRECTORY_CLINICIANS_ARRAY_REQUIRED");
  const byUsername = new Map(clinicians.map((c) => [String(c.username), c]));
  return {
    id: "synthetic-clinician-directory",
    async authenticate({ username, password }) {
      const record = byUsername.get(String(username));
      if (!record || record.password !== String(password)) return { matched: false };
      return {
        matched: true,
        employee_id: record.employeeId ?? record.username,
        display_name: record.displayName ?? record.username,
        department: record.department ?? null,
        title: record.title ?? null,
        dn: record.dn ?? `cn=${record.username},ou=clinicians,dc=synthetic`,
      };
    },
  };
}

export function createClinicianDirectoryAuth({
  directory,
  roleAssignments = [],
  sessionTtlSec = 3600,
  maxFailedAttempts = 5,
  lockoutSec = 300,
  jwtSecret,
} = {}) {
  if (!directory || typeof directory.authenticate !== "function") {
    throw new Error("DIRECTORY_ADAPTER_REQUIRED");
  }
  if (typeof sessionTtlSec !== "number" || sessionTtlSec < 60 || sessionTtlSec > 86400) {
    throw new Error("DIRECTORY_SESSION_TTL_INVALID");
  }
  for (const assignment of roleAssignments) {
    if (!assignment || !Array.isArray(assignment.roles) || assignment.roles.length === 0) {
      throw new Error("DIRECTORY_ROLE_ASSIGNMENT_INVALID");
    }
    for (const role of assignment.roles) {
      if (!MEDCIUS_ROLES.has(role)) throw new Error(`DIRECTORY_UNKNOWN_ROLE: ${role}`);
    }
  }

  const failures = new Map(); // key "tenant|username" -> {count, lockedUntil}
  const revoked = new Set(); // sha(token)

  function lockState(key) {
    const state = failures.get(key) ?? { count: 0, lockedUntil: 0 };
    return state;
  }

  function mapRoles({ department, title }) {
    for (const assignment of roleAssignments) {
      const match = assignment.match ?? {};
      const deptOk = !match.department || String(department ?? "").includes(match.department);
      const titleOk = !match.title || String(title ?? "").includes(match.title);
      if (deptOk && titleOk) return [...assignment.roles];
    }
    return null; // fail-closed: no implicit privileges
  }

  return {
    id: `directory-auth:${directory.id ?? "custom"}`,

    async login({ username, password, tenantId = "default", now = new Date() }) {
      if (typeof username !== "string" || !username.trim() || typeof password !== "string" || !password) {
        throw new Error("AUTH_CREDENTIALS_REQUIRED");
      }
      const key = `${tenantId}|${username}`;
      const state = lockState(key);
      if (state.lockedUntil > now.getTime()) {
        const error = new Error(`AUTH_LOCKED: account locked, retry after ${Math.ceil((state.lockedUntil - now.getTime()) / 1000)}s`);
        error.code = "AUTH_LOCKED";
        throw error;
      }

      let identity;
      try {
        identity = await directory.authenticate({ username, password, tenantId });
      } catch (err) {
        // Directory transport failure must NOT count as a credential failure,
        // and must fail closed without leaking whether the user exists.
        const error = new Error(`AUTH_DIRECTORY_UNAVAILABLE: ${err.message}`);
        error.code = "AUTH_DIRECTORY_UNAVAILABLE";
        throw error;
      }
      if (!identity?.matched) {
        state.count += 1;
        if (state.count >= maxFailedAttempts) {
          state.lockedUntil = now.getTime() + lockoutSec * 1000;
          state.count = 0;
        }
        failures.set(key, state);
        const error = new Error("AUTH_INVALID_CREDENTIALS");
        error.code = "AUTH_INVALID_CREDENTIALS";
        error.audit_event = {
          action: "workstation_login_denied",
          subject_ref: `PSN-DIR-${sha(`${tenantId}|${username}`).slice(0, 12)}`,
          payload: { tenant_id: tenantId, reason: "invalid_credentials", failures: state.count },
        };
        throw error;
      }

      const roles = mapRoles(identity);
      if (!roles) {
        const error = new Error("AUTH_NO_ROLE_MAPPED: directory identity has no hospital-configured Medcius role; access denied (fail-closed, no implicit privileges)");
        error.code = "AUTH_NO_ROLE_MAPPED";
        error.audit_event = {
          action: "workstation_login_denied",
          subject_ref: `PSN-DIR-${sha(`${tenantId}|${identity.employee_id}`).slice(0, 12)}`,
          payload: { tenant_id: tenantId, reason: "no_role_mapped", department: identity.department ?? null },
        };
        throw error;
      }

      failures.delete(key);
      const payload = {
        sub: identity.employee_id,
        name: identity.display_name,
        tenant_id: tenantId,
        roles,
        department: identity.department ?? null,
        title: identity.title ?? null,
        auth_source: directory.id ?? "custom",
      };
      const token = generateToken(payload, { expiresInSec: sessionTtlSec, ...(jwtSecret ? { secret: jwtSecret } : {}) });
      return {
        session: {
          token,
          token_type: "Bearer",
          expires_in: sessionTtlSec,
          clinician: {
            id: identity.employee_id,
            display_name: identity.display_name,
            department: identity.department ?? null,
            title: identity.title ?? null,
            roles,
          },
        },
        audit_event: {
          action: "workstation_login",
          subject_ref: `PSN-DIR-${sha(`${tenantId}|${identity.employee_id}`).slice(0, 12)}`,
          payload: { tenant_id: tenantId, roles, auth_source: directory.id ?? "custom" },
        },
      };
    },

    /** Verify a session token; returns { valid, session?, error? }. */
    verifySession(token) {
      if (typeof token !== "string" || !token) return { valid: false, error: "AUTH_TOKEN_REQUIRED" };
      if (revoked.has(sha(token))) return { valid: false, error: "AUTH_TOKEN_REVOKED" };
      const result = verifyToken(token, ...(jwtSecret ? [{ secret: jwtSecret }] : []));
      if (!result.valid) return { valid: false, error: `AUTH_TOKEN_INVALID: ${result.error}` };
      const p = result.payload;
      return {
        valid: true,
        session: {
          clinician: { id: p.sub, display_name: p.name ?? null, department: p.department ?? null, title: p.title ?? null, roles: p.roles ?? [] },
          tenant_id: p.tenant_id ?? "default",
          auth_source: p.auth_source ?? null,
          expires_at: p.exp ? new Date(p.exp * 1000).toISOString() : null,
        },
      };
    },

    logout(token) {
      if (typeof token === "string" && token) {
        revoked.add(sha(token));
        return {
          revoked: true,
          audit_event: {
            action: "workstation_logout",
            subject_ref: "session",
            payload: { token_fingerprint: sha(token).slice(0, 12) },
          },
        };
      }
      return { revoked: false };
    },
  };
}
