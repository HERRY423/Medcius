/** Minimal CSV parse (RFC4180-ish). Header row required. */

export function parseCsv(text) {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let i = 0;
  let inQ = false;
  while (i < src.length) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQ = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQ = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (c === "\n" || (c === "\r" && src[i + 1] === "\n")) {
      row.push(cell);
      if (row.some((x) => String(x).trim() !== "")) rows.push(row);
      row = [];
      cell = "";
      i += c === "\r" ? 2 : 1;
      continue;
    }
    if (c === "\r") {
      row.push(cell);
      if (row.some((x) => String(x).trim() !== "")) rows.push(row);
      row = [];
      cell = "";
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    if (row.some((x) => String(x).trim() !== "")) rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h).trim());
  return rows.slice(1).map((r) => {
    /** @type {Record<string, string>} */
    const o = {};
    for (let k = 0; k < header.length; k++) o[header[k]] = r[k] != null ? String(r[k]).trim() : "";
    return o;
  });
}

/** @param {Record<string, string>} row @param {string[]} aliases */
export function pick(row, aliases) {
  const keys = Object.keys(row);
  for (const a of aliases) {
    const hit = keys.find((k) => k === a || k.toLowerCase() === a.toLowerCase());
    if (hit && row[hit]) return row[hit];
  }
  return "";
}
