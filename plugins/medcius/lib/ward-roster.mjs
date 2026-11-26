// Validate a roster supplied by a read-only hospital or synthetic replay adapter.
const present = value => typeof value === "string" && value.trim().length > 0;

export function wardInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  const day = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(time) && Number(value.slice(11, 13)) < 24 && Number.isFinite(day)
    && new Date(day).toISOString().slice(0, 10) === value.slice(0, 10) ? time : null;
}

export function createWardMorningClock(timeZone) {
  if (!present(timeZone)) throw new Error("WARD_TIME_ZONE_REQUIRED");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  });
  return {
    timeZone: formatter.resolvedOptions().timeZone,
    at(ms) {
      const { year, month, day, hour } = Object.fromEntries(formatter.formatToParts(ms).map(part => [part.type, part.value]));
      return { date: `${year}-${month}-${day}`, beforeDeadline: Number(hour) < 7 };
    },
  };
}

export function readWardRoster(roster, scope) {
  const cutoff = wardInstant(scope?.as_of);
  const synchronized = wardInstant(roster?.synchronized_through);
  const fetched = wardInstant(roster?.fetched_at);
  if (cutoff == null || !present(scope.tenant_id) || scope.tenant_id === "default" || !present(scope.ward_id)
      || roster?.tenant_id !== scope.tenant_id || roster?.ward_id !== scope.ward_id
      || wardInstant(roster.as_of) !== cutoff || roster.status !== "complete" || roster.read_only_enforced !== true
      || !present(roster.source_id) || !present(roster.source_version) || synchronized == null || fetched == null
      || synchronized < cutoff || fetched < synchronized || !Array.isArray(roster.members)) {
    throw new Error("WARD_ROSTER_UNVERIFIED");
  }
  const patients = new Set(), encounters = new Set(), beds = new Set();
  return Array.from(roster.members, row => {
    if (row?.tenant_id !== scope.tenant_id || row?.ward_id !== scope.ward_id
        || !present(row.patient_id) || !present(row.encounter_id) || patients.has(row.patient_id) || encounters.has(row.encounter_id)) {
      throw new Error("WARD_ROSTER_MEMBERSHIP_UNVERIFIED");
    }
    const rawBed = row.bed_number;
    const bed = typeof rawBed === "string" ? rawBed.normalize("NFKC").trim().replace(/床$/, "").trim()
      : Number.isSafeInteger(rawBed) && rawBed >= 0 && rawBed <= 999 ? String(rawBed) : rawBed ?? null;
    if (bed != null) {
      if (typeof bed !== "string" || !/^[A-Z]?\d{1,3}(?:[-][A-Z0-9]{1,3}|[A-Z])?$/.test(bed)) throw new Error("WARD_ROSTER_BED_UNVERIFIED");
      const key = bed.replace(/\d+/g, digits => String(Number(digits)));
      if (beds.has(key)) throw new Error("WARD_ROSTER_BED_UNVERIFIED");
      beds.add(key);
    }
    patients.add(row.patient_id);
    encounters.add(row.encounter_id);
    return { patient_id: row.patient_id, encounter_id: row.encounter_id, ...(bed == null ? {} : { bed_number: bed }) };
  });
}
