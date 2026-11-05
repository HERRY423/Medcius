// Objective findings and the reporting clinician's impression remain separate.
// Unlabelled narrative is retained as unclassified text; never infer a diagnosis.
const clean = x => typeof x === 'string' && x.trim() ? x.trim() : null;
export function splitImagingReport(record = {}) {
  let findings = clean(record.findings ?? record.findings_text);
  let impression = clean(record.impression ?? record.impression_text);
  const parts = [];
  if (findings) parts.push({ kind: 'findings', source_field: record.findings != null ? 'findings' : 'findings_text' });
  if (impression) parts.push({ kind: 'impression', source_field: record.impression != null ? 'impression' : 'impression_text' });
  const raw = clean(record.report_text);
  if (!raw) return { findings, impression, unclassified_text: clean(record.unclassified_text), parts };
  const re = /(?:^|\n)[ \t]*(影像所见|检查所见|超声所见|内镜所见|所见|影像诊断|诊断意见|检查结论|印象|结论)[ \t]*[：:][ \t]*/g;
  const matches = [...raw.matchAll(re)];
  if (!matches.length) return { findings, impression, unclassified_text: raw, parts };
  const collected = { findings: [], impression: [] };
  matches.forEach((m, i) => {
    const start = m.index + m[0].length, end = matches[i+1]?.index ?? raw.length;
    const kind = /所见/.test(m[1]) ? 'findings' : 'impression';
    if (raw.slice(start,end).trim()) {
      collected[kind].push(raw.slice(start,end).trim());
      parts.push({ kind, source_field: 'report_text', start, end, offset_unit: 'utf16' });
    }
  });
  const fallbackFindings = collected.findings.join('\n') || null, fallbackImpression = collected.impression.join('\n') || null;
  const conflict = findings && fallbackFindings && findings !== fallbackFindings || impression && fallbackImpression && impression !== fallbackImpression;
  findings ??= fallbackFindings; impression ??= fallbackImpression;
  return { findings, impression, unclassified_text: conflict ? raw : clean(raw.slice(0,matches[0].index)), parts };
}

// Only trusted deployment code supplies this profile, never a patient record or
// request payload. PACS still authenticates the clinician and authorizes the study.
export function createPacsViewerLink(record, context, profile) {
  const unavailable = reason => ({ available: false, reason, href: null });
  if (!profile) return unavailable('NOT_CONFIGURED');
  if (!profile.mapping_ref || !profile.tenant_id || profile.tenant_id !== context?.tenant_id) return unavailable('SITE_BINDING_UNVERIFIED');
  if (!context?.patient_id || !context?.encounter_id || record?.patient_id !== context.patient_id
    || record?.encounter_id !== context.encounter_id || record?.tenant_id != null && record.tenant_id !== context.tenant_id) return unavailable('STUDY_IDENTITY_UNVERIFIED');
  const uid = record.study_uid;
  if (typeof uid !== 'string' || uid.length > 64 || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))+$/u.test(uid)) return unavailable('STUDY_UID_UNAVAILABLE');
  try {
    const origin = new URL(profile.origin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return unavailable('PROFILE_INVALID');
    if (typeof profile.path !== 'string' || !/^\/[A-Za-z0-9_/-]+$/.test(profile.path) || profile.path.includes('//')) return unavailable('PROFILE_INVALID');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(profile.study_parameter ?? '')) return unavailable('PROFILE_INVALID');
    const url = new URL(profile.path, origin);
    url.searchParams.set(profile.study_parameter, uid);
    url.searchParams.set('mode', 'readonly');
    return { available: true, href: url.href, read_only_requested: true,
      access_control: 'PACS_SESSION_REQUIRED', mapping_ref: profile.mapping_ref };
  } catch { return unavailable('PROFILE_INVALID'); }
}
