// Enhanced PHI Guard (增强型隐式 PHI 脱敏与医学专有名词保护引擎)
import { createHmac } from "node:crypto";

const MEDICAL_EPONYMS_WHITELIST = [
  "柯兴", "库欣", "巴宾斯基", "巴斯德", "帕金森", "阿尔茨海默", "克罗恩", "布加",
  "霍奇金", "非霍奇金", "吉兰巴雷", "马凡", "川崎", "桥本", "痛风", "瓦氏",
  "cushing", "babinski", "parkinson", "alzheimer", "crohn", "kawasaki", "hashimoto"
];

export class EnhancedPhiGuard {
  static generateToken(rawText, category, salt = "MEDCIUS_DEFAULT_SALT") {
    const hash = createHmac("sha256", salt).update(`${category}:${rawText}`).digest("hex").slice(0, 8);
    return `[${category}_${hash}]`;
  }

  static sanitize(text = "", { salt = "MEDCIUS_SALT_2026", mode = "PSEUDONYMIZE" } = {}) {
    if (typeof text !== "string" || text.trim() === "") {
      return { sanitized: text, detected_count: 0, detected_entities: [] };
    }

    let result = text;
    const detectedEntities = [];

    // 1. Protect medical eponyms while preserving exact case
    const protectedMap = new Map();
    let protectIdx = 0;
    for (const eponym of MEDICAL_EPONYMS_WHITELIST) {
      const reg = new RegExp(eponym, "gi");
      result = result.replace(reg, (match) => {
        const ph = `__MED_EPONYM_${protectIdx++}__`;
        protectedMap.set(ph, match);
        return ph;
      });
    }

    // 2. Scan Phone Numbers
    const phoneReg = /(?:\+?86)?1[3-9]\d{9}/g;
    result = result.replace(phoneReg, (match) => {
      const token = mode === "PSEUDONYMIZE" ? this.generateToken(match, "PHONE", salt) : "[REDACTED_PHONE]";
      detectedEntities.push({ type: "PHONE", replacement: token });
      return token;
    });

    // 3. Scan ID Cards
    const idReg = /[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g;
    result = result.replace(idReg, (match) => {
      const token = mode === "PSEUDONYMIZE" ? this.generateToken(match, "ID_CARD", salt) : "[REDACTED_ID_CARD]";
      detectedEntities.push({ type: "ID_CARD", replacement: token });
      return token;
    });

    // 4. Scan Medical Record / Hospital IDs
    const mrnReg = /(?:住院号|病案号|门诊号|ID|No\.?)[:：\s]*([A-Za-z0-9\-_]{5,25})/gi;
    result = result.replace(mrnReg, (full, id) => {
      const token = mode === "PSEUDONYMIZE" ? this.generateToken(id, "MRN", salt) : "[REDACTED_MRN]";
      detectedEntities.push({ type: "MRN", replacement: token });
      return full.replace(id, token);
    });

    // 5. Scan Job / Leadership Titles
    const titleReg = /(?:患者系|为|就职于|任职于|担任|系)(?:某|原)?(?:市委|省委|局长|科长|主任|书记|董事长|老总|总经理|校长|院长)/g;
    result = result.replace(titleReg, (match) => {
      const token = mode === "PSEUDONYMIZE" ? this.generateToken(match, "TITLE", salt) : "[REDACTED_TITLE]";
      detectedEntities.push({ type: "TITLE", replacement: token });
      return token;
    });

    // 6. Scan Caregiver / Relative Names
    const relReg = /(?:(?:陪护人|家属|联系人|儿子|女儿|妻子|丈夫|爱人|母亲|父亲|配偶|亲属|监护人)+(?:姓名)?[:：\s]*)([\u4e00-\u9fa5]{2,4})/g;
    result = result.replace(relReg, (full, name) => {
      const token = mode === "PSEUDONYMIZE" ? this.generateToken(name, "RELATIVE", salt) : "[REDACTED_RELATIVE]";
      detectedEntities.push({ type: "RELATIVE", replacement: token });
      return full.replace(name, token);
    });

    // 7. Scan Patient Names
    const patReg = /(?:患者|病人|姓名|名字|姓氏)[:：\s]*([\u4e00-\u9fa5]{2,4})/g;
    result = result.replace(patReg, (full, name) => {
      const token = mode === "PSEUDONYMIZE" ? this.generateToken(name, "PATIENT_NAME", salt) : "[REDACTED_NAME]";
      detectedEntities.push({ type: "PATIENT_NAME", replacement: token });
      return full.replace(name, token);
    });

    // 8. Restore Protected Medical Eponyms with Exact Original Case
    for (const [placeholder, originalEponym] of protectedMap.entries()) {
      result = result.replaceAll(placeholder, originalEponym);
    }

    return {
      sanitized: result,
      detected_count: detectedEntities.length,
      detected_entities: detectedEntities,
      phi_safe: true,
    };
  }

  static assertSafeOrThrow(text = "") {
    if (/(?:\+?86)?1[3-9]\d{9}/.test(text) || /[1-9]\d{5}(?:18|19|20)\d{2}\d{7}[\dXx]/.test(text)) {
      throw new Error("PHI_GUARD_FAIL_CLOSED: High-confidence raw personal identifiers detected in output stream.");
    }
    return true;
  }
}
