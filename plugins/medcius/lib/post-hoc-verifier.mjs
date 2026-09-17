// Deterministic Post-Hoc Claim-to-Evidence Verifier (F-01)
// Enforces sentence-level attribution checking between LLM narratives and grounded evidence items.
// Pure ESM, zero third-party runtime dependencies.

const CITATION_REGEX = /\[(?:\^)?([A-Za-z0-9_\-]+)\]|\(([A-Za-z0-9_\-]+)\)/g;

// Clinical assertion trigger keywords to detect sentences asserting medical facts
const CLINICAL_ASSERTION_KEYWORDS = [
  "体温", "血压", "心率", "脉搏", "呼吸", "氧饱和度", "spo2",
  "肌酐", "alt", "ast", "白细胞", "血红蛋白", "血小板", "钾", "钠", "氯", "钙", "血糖",
  "胸闷", "胸痛", "气促", "气短", "喘", "发热", "咳", "痰", "腹痛", "水肿", "尿量", "出入量",
  "头痛", "恶心", "呕吐", "黄疸", "腹泻", "便秘", "引流", "抗生素", "停用", "新增", "调整",
  "阿司匹林", "他汀", "头孢", "青霉素", "美罗培南", "哌拉西林", "多巴胺", "去甲肾上腺素",
  "超声", "ct", "mri", "胸片", "x线", "阴影", "渗出", "积液", "骨折", "结节",
];

export class PostHocClaimVerifier {
  /**
   * Extract verifiable sentence-level claims from a narrative text.
   * Filters out structural headings, timestamps, and doctor signatures.
   * @param {string} text
   * @returns {Array<{ index: number, raw: string, isClinicalClaim: boolean, citations: string[] }>}
   */
  static extractSentences(text = "") {
    if (typeof text !== "string" || !text.trim()) return [];

    const rawLines = text.split(/\n+/);
    const sentences = [];
    let idx = 0;

    for (const line of rawLines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      // Skip non-claim metadata headers and signatures
      if (
        /^(?:【.*?】|一、|二、|三、|四、|五、|六、|七、|记录时间|查房医师|患者姓名|床号|主诊断|肾功能估算|医师签名)/.test(
          trimmedLine
        )
      ) {
        continue;
      }

      // Subdivide line into individual sentences
      const parts = trimmedLine
        .split(/(?<=[。！？；;])\s*|\s{2,}/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 3);

      for (const s of parts) {
        // Strip bullet prefixes
        const cleanS = s.replace(/^[•\-\*\d+\.\s]+/, "").trim();
        if (cleanS.length < 3) continue;

        const lower = cleanS.toLowerCase();
        const isClinicalClaim = CLINICAL_ASSERTION_KEYWORDS.some((kw) => lower.includes(kw));
        const citations = this.parseCitations(cleanS);

        sentences.push({
          index: idx++,
          raw: cleanS,
          isClinicalClaim,
          citations,
        });
      }
    }

    return sentences;
  }

  /**
   * Parse cited evidence item IDs from a sentence.
   * Supports format [^ITEM-001], [ITEM-001], (ITEM-001).
   * @param {string} sentence
   * @returns {string[]}
   */
  static parseCitations(sentence = "") {
    const hits = new Set();
    const matches = sentence.matchAll(CITATION_REGEX);
    for (const m of matches) {
      const id = (m[1] || m[2] || "").trim();
      if (id) hits.add(id);
    }
    return Array.from(hits);
  }

  /**
   * Deterministically verify narrative claims against grounded items.
   * @param {Object} params
   * @param {string} params.narrativeText - Generated natural language draft or narrative
   * @param {Array<Object>} params.verifiableItems - Grounded items from PatientEvolutionEngine
   * @param {Object} [params.options] - Configuration options
   * @param {boolean} [params.options.strict] - Whether to throw on any unsupported claim
   * @param {number} [params.options.maxUnsupportedRate=0.0] - Maximum acceptable unsupported rate (0.0 to 1.0)
   */
  static verifyClaims({ narrativeText = "", verifiableItems = [], options = {} } = {}) {
    const { strict = false, maxUnsupportedRate = 0.0 } = options;

    const itemMap = new Map();
    for (const item of verifiableItems) {
      if (item?.id) {
        itemMap.set(String(item.id).toUpperCase(), item);
        itemMap.set(String(item.id), item);
      }
    }

    const sentences = this.extractSentences(narrativeText);
    const verifiedClaims = [];
    let supportedCount = 0;
    let totalVerifiedCitations = 0;
    let unsupportedCount = 0;
    let invalidCitationCount = 0;
    let contradictoryCount = 0;

    for (const s of sentences) {
      // If the sentence makes no clinical claim and has no citations, it's neutral text (e.g. greeting, transition)
      if (!s.isClinicalClaim && s.citations.length === 0) {
        verifiedClaims.push({
          sentence: s.raw,
          status: "NEUTRAL",
          citations: [],
          reason: "Non-clinical transition or structural text",
        });
        continue;
      }

      // If it makes a clinical claim but has no citations -> UNSUPPORTED
      if (s.isClinicalClaim && s.citations.length === 0) {
        unsupportedCount++;
        verifiedClaims.push({
          sentence: s.raw,
          status: "UNSUPPORTED_CLAIM",
          citations: [],
          reason: "Sentence asserts clinical facts without explicit citation tag",
        });
        continue;
      }

      // Check cited IDs validity
      let validCitations = 0;
      let hasInvalidCitation = false;
      let hasContradiction = false;
      const matchedItems = [];

      for (const citeId of s.citations) {
        const item = itemMap.get(citeId.toUpperCase()) || itemMap.get(citeId);
        if (!item) {
          hasInvalidCitation = true;
          continue;
        }

        validCitations++;
        matchedItems.push(item);

        // Polarity / Negation Contradiction Check
        // If evidence is explicitly negative / absent, but sentence claims positive occurrence without negation words
        const isEvidenceNegative =
          item.presence === "negative" ||
          item.presence === "absent" ||
          item.tag?.includes("阴性") ||
          item.tag?.includes("否定");

        const sentenceHasNegation = /无|未|否认|未见|未触及|未诉|未出|未有|正常/.test(s.raw);

        if (isEvidenceNegative && !sentenceHasNegation) {
          hasContradiction = true;
        }
      }

      if (hasInvalidCitation) {
        invalidCitationCount++;
        verifiedClaims.push({
          sentence: s.raw,
          status: "INVALID_CITATION",
          citations: s.citations,
          reason: "Cited item ID does not exist in grounded evidence items",
        });
      } else if (hasContradiction) {
        contradictoryCount++;
        verifiedClaims.push({
          sentence: s.raw,
          status: "CONTRADICTORY_CLAIM",
          citations: s.citations,
          reason: "Sentence polarity contradicts grounded evidence item status",
        });
      } else if (validCitations > 0) {
        supportedCount++;
        totalVerifiedCitations += validCitations;
        verifiedClaims.push({
          sentence: s.raw,
          status: "SUPPORTED",
          citations: s.citations,
          matched_items: matchedItems.map((i) => ({ id: i.id, title: i.title, summary: i.summary })),
          reason: "Verified against grounded evidence",
        });
      }
    }

    const totalAudited = supportedCount + unsupportedCount + invalidCitationCount + contradictoryCount;
    const flawedCount = unsupportedCount + invalidCitationCount + contradictoryCount;
    const unsupportedRate = totalAudited > 0 ? flawedCount / totalAudited : 0.0;
    const isPassing = unsupportedRate <= maxUnsupportedRate && invalidCitationCount === 0 && contradictoryCount === 0;

    const result = {
      is_passing: isPassing,
      total_sentences: sentences.length,
      total_audited_claims: totalAudited,
      supported_count: supportedCount,
      total_verified_citations: totalVerifiedCitations,
      unsupported_count: unsupportedCount,
      invalid_citation_count: invalidCitationCount,
      contradictory_count: contradictoryCount,
      unsupported_claim_rate: Number(unsupportedRate.toFixed(4)),
      claims_detail: verifiedClaims,
    };

    if (strict && !isPassing) {
      throw new Error(
        `POST_HOC_VERIFICATION_FAIL_CLOSED: Narrative contains unsupported or invalid claims (rate: ${(
          unsupportedRate * 100
        ).toFixed(1)}%, unsupported: ${unsupportedCount}, invalid: ${invalidCitationCount}, contradictory: ${contradictoryCount})`
      );
    }

    return result;
  }

  /**
   * Sanitize narrative by redacting or flagging unsupported claims.
   * @param {Object} params
   * @returns {{ sanitized_text: string, redacted_sentences: string[] }}
   */
  static sanitizeNarrative({ narrativeText = "", verifiableItems = [], flagTag = "【⚠️未经证据核验】" } = {}) {
    const report = this.verifyClaims({ narrativeText, verifiableItems });
    const redacted = [];
    const sanitizedLines = [];

    const lines = narrativeText.split("\n");
    for (const line of lines) {
      let modLine = line;
      for (const claim of report.claims_detail) {
        if (claim.status !== "SUPPORTED" && claim.status !== "NEUTRAL" && modLine.includes(claim.sentence)) {
          modLine = modLine.replace(claim.sentence, `${flagTag} ${claim.sentence}`);
          redacted.push(claim.sentence);
        }
      }
      sanitizedLines.push(modLine);
    }

    return {
      sanitized_text: sanitizedLines.join("\n"),
      redacted_sentences: redacted,
      verification_report: report,
    };
  }
}
