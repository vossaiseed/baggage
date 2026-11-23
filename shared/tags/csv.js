/**
 * Minimal RFC-4180-ish CSV parser. Every cell is kept as a STRING — an LPN
 * such as 0650012345 must never be turned into a number (leading zero!).
 * @param {string} text
 * @returns {{ header: string[], rows: {line:number, cells: Record<string,string>}[] }}
 */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  /** @type {string[][]} */
  const records = [];
  const lineOf = [];
  let cur = [];
  let cell = '';
  let q = false;
  let line = 1;
  let recLine = 1;
  const pushCell = () => { cur.push(cell); cell = ''; };
  const pushRec = () => {
    pushCell();
    if (cur.some((c) => c.trim() !== '')) { records.push(cur); lineOf.push(recLine); }
    cur = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else { if (ch === '\n') line++; cell += ch; }
    } else if (ch === '"') q = true;
    else if (ch === ',') pushCell();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      pushRec(); line++; recLine = line;
    } else cell += ch;
  }
  pushRec();
  if (!records.length) return { header: [], rows: [] };
  const header = records[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const rows = records.slice(1).map((r, i) => ({
    line: lineOf[i + 1],
    cells: Object.fromEntries(header.map((h, j) => [h, (r[j] ?? '').trim()])),
  }));
  return { header, rows };
}
