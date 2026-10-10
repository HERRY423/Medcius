// Test suite for enhanced PHI Guard & AES-256-GCM Secure Storage

import assert from "node:assert/strict";
import { unlinkSync, existsSync } from "node:fs";
import { scanText, redactText, pseudonymizeText } from "../plugins/medcius/servers/phiguard/src/lib.mjs";
import { encryptPayload, decryptPayload, SecureRecordStore, resolveKeyHex, describeKeySource, isProductionStoreProfile } from "../plugins/medcius/servers/shared/secure-store.mjs";
import { EnhancedPhiGuard, PHI_BARE_NAME_LIMITATION } from "../plugins/medcius/lib/enhanced-phi-guard.mjs";

console.log("== Testing Enhanced PHI Guard ==");

// Test 1: Medical record with doctor, bed/ward, address, fixed phone, bank card, and ID card
const clinicalSample = `
入院记录
患者：张三峰  性别：男  年龄：62岁
住院号：ZY-20260824-001  病区：心内科三病区  床位：32床
联系地址：北京市朝阳区北苑路108号院
银行卡号：6222021234567890123
固定电话：010-84981234  联系电话：13812345678
身份证号：110101199003072378
科主任：陈大夫  主管医师：李四光  审核药师：王五
诊断：冠状动脉粥样硬化性心脏病
`;

const scanRes = scanText(clinicalSample);
console.log(`Scan findings count: ${scanRes.total}`);
const typesFound = new Set(scanRes.findings.map((f) => f.type));
console.log("Types found:", Array.from(typesFound));

assert.ok(typesFound.has("name_label"), "Should detect patient name");
assert.ok(typesFound.has("mrn_label"), "Should detect MRN label");
assert.ok(typesFound.has("bed_ward"), "Should detect bed/ward");
assert.ok(typesFound.has("address_label"), "Should detect address label");
assert.ok(typesFound.has("phone_cn_fixed"), "Should detect fixed phone");
assert.ok(typesFound.has("phone_cn_mobile"), "Should detect mobile phone");
assert.ok(typesFound.has("id_card"), "Should detect 18-digit ID card");
assert.ok(typesFound.has("bank_card"), "Should detect bank card");
assert.ok(typesFound.has("doctor_label"), "Should detect doctor/pharmacist signature");

// Test 2: Redaction
const redacted = redactText(clinicalSample, { mode: "mask" });
console.log("\nRedacted snippet preview:\n" + redacted.text.slice(0, 300) + "...\n");
assert.ok(!redacted.text.includes("13812345678"), "Mobile number must be redacted");
assert.ok(!redacted.text.includes("110101199003072378"), "ID card must be redacted");
assert.ok(!redacted.text.includes("李四光"), "Doctor name must be masked");

// Test 3: Pseudonymization
const salt = "test-phi-salt-2026";
const psn = pseudonymizeText(clinicalSample, { salt });
assert.ok(psn.text.includes("[PSN:"), "Should contain pseudonymized tokens");
assert.ok(!psn.text.includes("张三峰"), "Patient name should not appear");

console.log("✓ PHI Guard tests passed");

console.log("\n== Testing AES-256-GCM Secure Storage ==");

const sensitiveData = {
  patient_id: "PSN:9876abcd",
  diagnoses: ["I25.101", "E11.900"],
  prescription: [{ drug: "阿托伐他汀钙片", dose: "20mg qn" }],
  timestamp: new Date().toISOString(),
};

// Test 4: Payload encrypt / decrypt
// 低熵确定性合成密钥（32 字节全 0x5a）：仅用于加解密回环，避免触发 secret-scan 的
// generic-api-key 高熵规则；历史字面量已在 .gitleaksignore 登记 fingerprint 豁免。
const explicitKey = Buffer.alloc(32, 0x5a).toString("hex");
const enc = encryptPayload(sensitiveData, explicitKey);
assert.ok(enc.encrypted.startsWith("v1."), "Envelope should start with v1.");

const dec = decryptPayload(enc.encrypted, explicitKey);
assert.deepEqual(dec, sensitiveData, "Decrypted data must match original");

// Test 5: SecureRecordStore disk read/write
const testFile = "./tests/temp-encrypted-store.json";
if (existsSync(testFile)) unlinkSync(testFile);

const store = new SecureRecordStore(testFile, explicitKey);
store.save(sensitiveData);
assert.ok(existsSync(testFile), "Encrypted file should exist on disk");

const loaded = store.load();
assert.deepEqual(loaded, sensitiveData, "Loaded data from secure store must match original");

// Clean up
unlinkSync(testFile);
console.log("✓ AES-256-GCM Secure Storage tests passed");

console.log("\n== Testing key domain separation & production fail-closed (P0-2) ==");
// Test 6: production without dedicated key must fail closed (salt/ephemeral rejected).
{
  const savedNodeEnv = process.env.NODE_ENV;
  const savedProfile = process.env.MEDCIUS_PROFILE;
  const savedKey = process.env.CLAUDE_MEDCIUS_ENCRYPTION_KEY;
  const savedSalt = process.env.CLAUDE_MEDCIUS_PHI_SALT;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.CLAUDE_MEDCIUS_ENCRYPTION_KEY;
    process.env.CLAUDE_MEDCIUS_PHI_SALT = "dev-only-salt-1234";
    assert.equal(isProductionStoreProfile(), true, "production profile must be detected");
    assert.equal(describeKeySource(undefined), "missing-production");
    assert.throws(() => resolveKeyHex(undefined), /SECURE_STORE_KEY_REQUIRED/, "production salt-derived fallback must fail closed");
    assert.throws(() => new SecureRecordStore("./tests/temp-prod-store.json"), /SECURE_STORE_KEY_REQUIRED/);
    assert.throws(() => encryptPayload({ a: 1 }), /SECURE_STORE_KEY_REQUIRED/);
    // Explicit 64hex key remains legal in production.
    assert.doesNotThrow(() => resolveKeyHex(explicitKey));
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    if (savedProfile === undefined) delete process.env.MEDCIUS_PROFILE; else process.env.MEDCIUS_PROFILE = savedProfile;
    if (savedKey === undefined) delete process.env.CLAUDE_MEDCIUS_ENCRYPTION_KEY; else process.env.CLAUDE_MEDCIUS_ENCRYPTION_KEY = savedKey;
    if (savedSalt === undefined) delete process.env.CLAUDE_MEDCIUS_PHI_SALT; else process.env.CLAUDE_MEDCIUS_PHI_SALT = savedSalt;
  }
  // Test 7: non-production salt-derived fallback is labeled dev-only, never production_safe.
  {
    const sSalt = process.env.CLAUDE_MEDCIUS_PHI_SALT;
    const sKey = process.env.CLAUDE_MEDCIUS_ENCRYPTION_KEY;
    try {
      delete process.env.CLAUDE_MEDCIUS_ENCRYPTION_KEY;
      process.env.CLAUDE_MEDCIUS_PHI_SALT = "dev-only-salt-1234";
      const encDev = encryptPayload({ b: 2 });
      assert.equal(encDev.key_source, "derived-salt-dev-only");
      assert.equal(encDev.production_safe, false);
    } finally {
      if (sKey === undefined) delete process.env.CLAUDE_MEDCIUS_ENCRYPTION_KEY; else process.env.CLAUDE_MEDCIUS_ENCRYPTION_KEY = sKey;
      if (sSalt === undefined) delete process.env.CLAUDE_MEDCIUS_PHI_SALT; else process.env.CLAUDE_MEDCIUS_PHI_SALT = sSalt;
    }
  }
  console.log("✓ Key domain separation & production fail-closed tests passed");
}

console.log("\n== Testing PHI bare-name limitation honesty (P0-3) ==");
{
  // 裸姓名（无“患者：/姓名：”标签）在叙事文本中不保证检出：启发式如实暴露缺口，不伪装全覆盖。
  const bareNameText = "王建国因胸痛入院，昨日行冠脉造影（合成演示文本，无标签人名）。";
  const bareScan = scanText(bareNameText, { contextual: true });
  console.log(`Bare-name scan total: ${bareScan.total} (expected 0: limitation honestly exposed)`);
  assert.equal(bareScan.total, 0, "Bare narrative name must NOT be claimed as detected by heuristics");
  assert.ok(typeof PHI_BARE_NAME_LIMITATION === "string" && PHI_BARE_NAME_LIMITATION.includes("bare names"), "Bare-name limitation string must be exported");
  const labeled = EnhancedPhiGuard.sanitize("患者：张三峰因胸痛入院（合成）。", { salt: "test-phi-salt-2026" });
  assert.equal(labeled.phi_safe, true);
  assert.equal(labeled.assurance, "heuristic_scan_only");
  assert.equal(labeled.bare_name_limited, true, "sanitize must flag bare_name_limited even when labeled PHI passes");
  assert.ok(labeled.sanitized.includes("[PSN:"), "Labeled name must still be pseudonymized");
  assert.ok(!labeled.sanitized.includes("张三峰"));
  console.log("✓ Bare-name limitation honesty tests passed");
}

console.log("\nALL SECURITY TESTS PASSED!");
