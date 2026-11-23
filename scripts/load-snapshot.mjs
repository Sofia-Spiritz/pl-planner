// Turns an export of a whole spreadsheet (every tab as CSV text) into a private seed file.
//
//   node scripts/load-snapshot.mjs "C:\path\to\export.json"
//   npx supabase db push --remote --include-seed --yes
//
// The export is { sheet, exported_at, tabs: { "Tab name": "csv text", ... } }, made from the
// sheet in the browser. Both it and the seed file hold real client figures, so neither is
// committed: the export lives outside this folder and the seed file is in .gitignore.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const input = process.argv[2];
if (!input) { console.error('Usage: node scripts/load-snapshot.mjs "<path to export.json>"'); process.exit(1); }
const data = JSON.parse(readFileSync(input, "utf8"));
const slug = data.sheet.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "seeds", "10_private_snap_" + slug + ".sql");
const MAX_ROWS = 5000, MAX_COLS = 60;

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// A small CSV reader: handles quoted cells, doubled quotes and line breaks inside cells.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const sql = ["-- PRIVATE: a copy of the client's sheet \"" + data.sheet.replace(/\n/g, " ") + "\". Not committed.", "begin;",
  "delete from public.snap_tabs where sheet = " + q(data.sheet) + ";"];
const report = [];
let position = 0;
for (const [tab, csv] of Object.entries(data.tabs)) {
  let rows = parseCsv(csv).map((r) => { let n = r.length; while (n && r[n - 1] === "") n--; return r.slice(0, Math.min(n, MAX_COLS)); });
  while (rows.length && !rows[rows.length - 1].length) rows.pop();
  const truncated = rows.length > MAX_ROWS;
  if (truncated) rows = rows.slice(0, MAX_ROWS);
  const nCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  position++;
  sql.push("insert into public.snap_tabs (sheet, tab, position, copied_at, n_rows, n_cols) values (" +
    [q(data.sheet), q(tab), position, q(data.exported_at || new Date().toISOString()), rows.length, nCols].join(", ") + ");");
  const keep = rows.map((r, i) => [i + 1, r]).filter(([, r]) => r.length);
  for (let i = 0; i < keep.length; i += 200) {
    sql.push("insert into public.snap_rows (tab_id, row_no, cells)\nselect t.id, v.row_no, v.cells::jsonb from public.snap_tabs t,\n(values\n  " +
      keep.slice(i, i + 200).map(([n, r]) => "(" + n + ", " + q(JSON.stringify(r)) + ")").join(",\n  ") +
      "\n) as v(row_no, cells) where t.sheet = " + q(data.sheet) + " and t.tab = " + q(tab) + ";");
  }
  report.push(tab + ": " + rows.length + " rows x " + nCols + " cols" + (truncated ? " (cut at " + MAX_ROWS + ")" : ""));
}
sql.push("commit;", "");
writeFileSync(out, sql.join("\n"), "utf8");
console.log("Wrote the private seed file for \"" + data.sheet + "\":\n  " + report.join("\n  "));
