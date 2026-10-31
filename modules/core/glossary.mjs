// RFC 4180-style quoted CSV, including embedded commas/newlines and escaped quotes.
export function parseGlossary(text, sourceLocale, targetLocale) {
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(field); field = ''; closed = false;
      if (c !== ',') { if (row.some(Boolean)) rows.push(row); row = []; if (c === '\r' && input[i + 1] === '\n') i++; }
    } else if (c === '"' && !field && !closed) quoted = true;
    else { if (closed || c === '"') throw new Error('Malformed glossary CSV quoting.'); field += c; }
  }
  if (quoted) throw new Error('Unterminated glossary CSV quote.');
  row.push(field); if (row.some(Boolean)) rows.push(row);
  const headers = rows.shift()?.map(x => x.trim()) ?? [];
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate glossary CSV header.');
  const column = locale => { const exact = headers.indexOf(locale); return exact >= 0 ? exact : headers.indexOf(locale.split(/[-_]/)[0]); };
  const s = column(sourceLocale), t = column(targetLocale);
  if (s < 0 || t < 0) throw new Error(`Glossary CSV needs ${sourceLocale} and ${targetLocale} columns.`);
  const unchanged = new Set();
  for (const values of rows) {
    if (values.length !== headers.length) throw new Error('Glossary CSV row has a different column count.');
    const a = values[s].trim().toLocaleLowerCase(), b = values[t].trim().toLocaleLowerCase();
    if (a && a === b) unchanged.add(a);
  }
  return { unchanged, rowCount: rows.length };
}
