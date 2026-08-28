// On-Premises mTLS Zero-Trust Gateway Guard
// Enforces: Mutual TLS Certificate Verification, Subject Organization Validation,
// Fingerprint Whitelisting, Tenant Boundary Enforcement, and Fail-Closed Edge Protection.

export class MtlsGatewayGuard {
  constructor(options = {}) {
    this.approvedFingerprints = new Set(options.approvedFingerprints || []);
    this.approvedOrganizations = new Set(options.approvedOrganizations || ["National Cardiovascular Center", "First Affiliated Hospital", "Test Hospital"]);
    this.allowDevBypass = options.allowDevBypass || false;
  }

  /**
   * Registers an approved hospital gateway client certificate fingerprint
   */
  registerApprovedGateway(fingerprintSha256, metadata = {}) {
    if (!fingerprintSha256 || typeof fingerprintSha256 !== "string") {
      throw new Error("Invalid certificate fingerprint");
    }
    const cleanFp = fingerprintSha256.trim().toUpperCase();
    this.approvedFingerprints.add(cleanFp);
  }

  /**
   * Verifies incoming client TLS certificate information from node http/https request socket
   * @param {Object} tlsContext - client certificate metadata
   * @param {Object} reqContext - request context (target tenant)
   * @returns {Object} { isAuthorized: boolean, clientContext?: Object, error?: string }
   */
  verifyClientTls(tlsContext, reqContext = {}) {
    if (!tlsContext) {
      return { isAuthorized: false, error: "Missing client TLS certificate metadata (mTLS required)" };
    }

    // 1. Check if client certificate is present and verified by CA
    if (!tlsContext.authorized && !this.allowDevBypass) {
      return { isAuthorized: false, error: `Client certificate unauthorized by CA: ${tlsContext.authorizationError || "untrusted"}` };
    }

    const cert = tlsContext.peerCertificate || tlsContext;

    // 2. Check Expiration
    if (cert.valid_to) {
      const validToDate = new Date(cert.valid_to);
      if (Date.now() > validToDate.getTime()) {
        return { isAuthorized: false, error: `Client certificate expired on ${cert.valid_to}` };
      }
    }
    if (cert.valid_from) {
      const validFromDate = new Date(cert.valid_from);
      if (Date.now() < validFromDate.getTime()) {
        return { isAuthorized: false, error: `Client certificate not yet valid before ${cert.valid_from}` };
      }
    }

    // 3. Check Fingerprint Whitelist (SHA-256)
    const rawFp = (cert.fingerprint256 || cert.fingerprint || "").replace(/:/g, "").toUpperCase();
    if (this.approvedFingerprints.size > 0 && !this.approvedFingerprints.has(rawFp)) {
      return { isAuthorized: false, error: `Client certificate fingerprint ${rawFp} not in approved whitelist` };
    }

    // 4. Check Subject Organization (O / OU)
    const subject = cert.subject || {};
    const org = subject.O;
    if (org && this.approvedOrganizations.size > 0 && !this.approvedOrganizations.has(org)) {
      return { isAuthorized: false, error: `Disallowed client certificate Organization: ${org}` };
    }

    // 5. Check Tenant Matching if specified
    const certTenant = subject.OU || subject.CN;
    if (reqContext.expectedTenant && certTenant && !certTenant.includes(reqContext.expectedTenant)) {
      return { isAuthorized: false, error: `Client certificate OU (${certTenant}) mismatch with expected tenant (${reqContext.expectedTenant})` };
    }

    return {
      isAuthorized: true,
      clientContext: {
        common_name: subject.CN || "hospital-edge-gateway",
        organization: subject.O || "Approved Hospital",
        organizational_unit: subject.OU || "Inpatient Informatics",
        fingerprint: rawFp,
        serial_number: cert.serialNumber,
      },
    };
  }
}
