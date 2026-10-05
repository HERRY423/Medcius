// Deterministic Post-Hoc Claim-to-Evidence Verifier (F-01)
// Enforces sentence-level attribution checking between LLM narratives and grounded evidence items.
// Pure ESM, zero third-party runtime dependencies.

const CITATION_REGEX = /\[(?:\^)?([A-Za-z0-9_\-]+)\]|\(([A-Za-z0-9_\-]+)\)/g;

// This is a bounded text verifier, not a medical entailment model. Only exact
// evidence text (ignoring presentation punctuation/spacing) can be supported.
function evidenceText(text) {
  return String(text || "").normalize("NFKC")
    .replace(CITATION_REGEX, "")
    .replace(/^(?:【(?:事实|原文事实|阴性事实|资料不足|规则提醒|待核实)】|\[(?:检验|影像|医嘱变更|待办事项|临床提醒|资料缺口)\])\s*/, "")
    .replace(/[\s。！？；;，,]/g, "").trim();
}

function exactEvidenceMatch(sentence, items) {
  const plain = evidenceText(sentence);
  if (!plain) return false;
  return items.some((item) => [item.summary, item.span].some((text) =>
    typeof text === "string" && text.trim() && plain === evidenceText(text)));
}

function matchesCitedClauses(sentence, itemMap) {
  const allIds = PostHocClaimVerifier.parseCitations(sentence);
  if (allIds.length === 1 && exactEvidenceMatch(sentence, [itemMap.get(allIds[0].toUpperCase())])) return true;
  const clauses = sentence.split(/[，,；;。！？]/).filter((part) => part.trim());
  return clauses.length > 0 && clauses.every((clause) => {
    const ids = PostHocClaimVerifier.parseCitations(clause);
    return ids.length > 0 && exactEvidenceMatch(clause, ids.map((id) => itemMap.get(id.toUpperCase())));
  });
}

export class PostHocClaimVerifier {
  /**
   * Extract verifiable sentence-level claims from a narrative text.
   * Filters only a bounded set of standalone structural headings.
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

      // Skip only known standalone headings. A heading prefix must never hide
      // clinical content following it, including diagnosis/eGFR lines.
      if (
        /^(?:【(?:日常查房记录(?: - 病情演变摘要)?|多源跨系统临床对齐 \(NIS\/LIS\/PACS\/HIS\))】|[一二三四五六七]、(?:今日病情变化与症状演变|主要异常检验及指标趋势|今日用药调整|未闭环事项与临床提醒|已知临床资料缺口提示|医师查房意见与下一步处置))$/.test(trimmedLine)
      ) {
        continue;
      }

      // Subdivide line into individual sentences
      const parts = trimmedLine
        .split(/(?<=[。！？；;])\s*|\s{2,}/)
        .map((s) => s.trim())
        .filter(Boolean);

      for (const s of parts) {
        // Strip bullet prefixes
        const cleanS = s.replace(/^(?:[•\-*]\s+|\d+[.)、]\s+)/, "").trim();
        if (!cleanS) continue;

        // Unknown prose cannot be assumed neutral merely because a keyword is
        // absent from a finite vocabulary.
        const isClinicalClaim = true;
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
        if (itemMap.has(String(item.id).toUpperCase())) throw new Error(`DUPLICATE_EVIDENCE_ID: ${item.id}`);
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
      } else if (validCitations > 0 && matchesCitedClauses(s.raw, itemMap)) {
        supportedCount++;
        totalVerifiedCitations += validCitations;
        verifiedClaims.push({
          sentence: s.raw,
          status: "SUPPORTED",
          citations: s.citations,
          matched_items: matchedItems.map((i) => ({ id: i.id, title: i.title, summary: i.summary })),
          verification_basis: "exact_evidence_text",
          reason: "Exact match to supplied evidence text; source validity remains an upstream requirement",
        });
      } else {
        unsupportedCount++;
        verifiedClaims.push({
          sentence: s.raw,
          status: "UNVERIFIED_CLAIM",
          citations: s.citations,
          reason: "Citation exists but the full claim is not an exact supported excerpt; semantic review required",
        });
      }
    }

    const totalAudited = supportedCount + unsupportedCount + invalidCitationCount + contradictoryCount;
    const flawedCount = unsupportedCount + invalidCitationCount + contradictoryCount;
    const unsupportedRate = totalAudited > 0 ? flawedCount / totalAudited : 0.0;
    const isPassing = totalAudited > 0 && unsupportedRate <= maxUnsupportedRate && invalidCitationCount === 0 && contradictoryCount === 0;

    const result = {
      is_passing: isPassing,
      verification_scope: "exact_text_only_not_clinical_entailment",
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
