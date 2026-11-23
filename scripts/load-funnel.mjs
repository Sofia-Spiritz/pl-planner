// Turns an export of the client's Daily Funnel Sheet into a private seed file for Supabase.
//
//   node scripts/load-funnel.mjs "C:\path\to\daily-funnel.json"
//   npx supabase db push --remote --include-seed --yes
//
// The export (made from the sheet in the browser) and the seed file it writes both hold
// real client figures, so neither is committed: the export lives outside this folder and
// the seed file is listed in .gitignore.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const input = process.argv[2];
if (!input) { console.error('Usage: node scripts/load-funnel.mjs "<path to daily-funnel.json>"'); process.exit(1); }
const data = JSON.parse(readFileSync(input, "utf8"));
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "seeds", "03_private_funnel.sql");

const MARKETS = { UK: "UK", US: "US", AUS: "AU" };
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const n = (c) => (c && typeof c.v === "number" && isFinite(c.v) ? (Math.round(c.v * 100) / 100).toString() : "null");
const isDate = (s) => typeof s === "string" && /^\d{4}-\d\d-\d\d$/.test(s);
// Column whose heading ends with exactly these words ("US Meta spend" must not match "AUS Meta spend").
const col = (cols, words) => cols.findIndex((c) => new RegExp("(^|\\s)" + words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$").test(c.trim()));
const pick = (row, i) => (i < 0 ? null : row[i]);

function tab(name) {
  const t = data.tabs[name];
  if (!t) throw new Error('Tab "' + name + '" is missing from the export.');
  return t;
}
const sql = ["-- PRIVATE: real client figures from the Daily Funnel Sheet. Not committed.", "begin;"];
const counts = {};
function insert(table, columns, rows) {
  counts[table] = rows.length;
  sql.push("delete from public." + table + ";");
  for (let i = 0; i < rows.length; i += 200) {
    sql.push("insert into public." + table + " (" + columns.join(", ") + ") values\n  " +
      rows.slice(i, i + 200).map((r) => "(" + r.join(", ") + ")").join(",\n  ") + ";");
  }
}

// 1. Daily by market
{
  const t = tab("UK vs US Daily Data"), rows = [];
  for (const [mk, code] of Object.entries(MARKETS)) {
    const ix = ["Meta spend", "Google spend", "AppLovin spend", "Total ad spend", "Shopify sales",
      "Shopify new-customer sales", "Net revenue (ex VAT)", "Contribution profit after ads"].map((w) => col(t.cols, mk + " " + w));
    if (ix[4] < 0) continue; // this market is not in the sheet
    for (const r of t.rows) {
      const day = r[0]?.v;
      if (!isDate(day)) continue;
      const vals = ix.map((i) => n(pick(r, i)));
      if (vals.every((v) => v === "null")) continue;
      rows.push([q(day), q(code), ...vals]);
    }
  }
  insert("funnel_daily", ["day", "market", "meta_spend", "google_spend", "applovin_spend", "ad_spend",
    "shopify_sales", "new_customer_sales", "net_revenue", "contribution"], rows);
}

// 2. Daily by market and category
{
  const t = tab("SKU Daily Data"), rows = [];
  for (const [mk, code] of Object.entries(MARKETS)) {
    for (const [cat, label] of [["Bags", "Bags"], ["Cases", "Glasses cases"]]) {
      const ix = ["Meta spend", "Google spend", "AppLovin spend", "new-customer sales", "returning sales"]
        .map((w) => col(t.cols, mk + " " + cat + " " + w));
      if (ix[0] < 0 && ix[3] < 0) continue;
      for (const r of t.rows) {
        const day = r[0]?.v;
        if (!isDate(day)) continue;
        const vals = ix.map((i) => n(pick(r, i)));
        if (vals.every((v) => v === "null")) continue;
        rows.push([q(day), q(code), q(label), ...vals]);
      }
    }
  }
  insert("funnel_category_daily", ["day", "market", "category", "meta_spend", "google_spend", "applovin_spend",
    "new_sales", "returning_sales"], rows);
}

// 3. Monthly by market and segment
{
  const t = tab("Monthly Market Data"), rows = [], seen = new Set();
  const ix = ["Meta spend", "Google spend", "AppLovin spend", "Total ad spend", "Shopify sales", "New-customer sales",
    "Net revenue (ex tax)", "Gross profit before ads", "Contribution profit after ads"].map((w) => t.cols.findIndex((c) => c.trim() === w));
  const mi = t.cols.findIndex((c) => c.trim() === "Market"), si = t.cols.findIndex((c) => c.trim() === "Segment");
  for (const r of t.rows) {
    const month = r[0]?.v, market = r[mi]?.v, segment = r[si]?.v;
    if (!isDate(month) || !market || !segment) continue;
    const code = MARKETS[String(market).trim()] || String(market).trim();
    const key = month + "|" + code + "|" + segment;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([q(month), q(code), q(String(segment).trim()), ...ix.map((i) => n(pick(r, i)))]);
  }
  insert("funnel_monthly_market", ["month", "market", "segment", "meta_spend", "google_spend", "applovin_spend", "ad_spend",
    "shopify_sales", "new_customer_sales", "net_revenue", "gross_profit_before_ads", "contribution"], rows);
}

// 4. App and software costs: first row holds the months, first column the item.
{
  const t = tab("Monthly OPEX Breakdown"), rows = [], seen = new Set();
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const monthOf = (c) => {
    if (!c) return null;
    if (isDate(c.v)) return c.v.slice(0, 7) + "-01";
    const m = /^([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(String(c.f ?? c.v ?? "").trim());
    return m && MON[m[1].toLowerCase()] ? m[2] + "-" + String(MON[m[1].toLowerCase()]).padStart(2, "0") + "-01" : null;
  };
  const head = t.rows.find((r) => r.slice(1).filter((c) => monthOf(c)).length >= 3);
  if (!head) throw new Error("Could not find the row of months in the OPEX tab.");
  const months = head.map((c, i) => (i === 0 ? null : monthOf(c)));
  const SKIP = /^(products|usd \(\$\)|gbp \(£\)|exchange rate|usd to gbp|creative tools)/i;
  for (const r of t.rows) {
    if (r === head) continue;
    const item = String(r[0]?.v ?? "").trim();
    if (!item || item.length > 60 || SKIP.test(item)) continue;
    const isTotal = /^total/i.test(item);
    months.forEach((month, i) => {
      const c = r[i];
      if (!month || !c) return;
      let amount = null, currency = "GBP";
      if (typeof c.v === "number") { amount = c.v; if (/^\s*\$/.test(c.f || "")) currency = "USD"; }
      else if (typeof c.v === "string") {
        const m = /^\s*([$£])\s*([\d,]+(?:\.\d+)?)\s*$/.exec(c.v);
        if (m) { amount = +m[2].replace(/,/g, ""); currency = m[1] === "$" ? "USD" : "GBP"; }
      }
      if (amount == null || !isFinite(amount) || amount === 0) return;
      const key = month + "|" + item + "|" + currency;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push([q(month), q(item), (Math.round(amount * 100) / 100).toString(), q(currency), isTotal ? "true" : "false"]);
    });
  }
  insert("funnel_app_costs", ["month", "item", "amount", "currency", "is_total"], rows);
}

sql.push("delete from public.funnel_meta;");
sql.push("insert into public.funnel_meta (key, value) values ('exported_at', " + q(data.exported_at || new Date().toISOString()) +
  "), ('source', " + q(data.sheet || "Daily Funnel Sheet") + ");");
sql.push("commit;", "");
writeFileSync(out, sql.join("\n"), "utf8");
console.log("Wrote the private seed file. Rows per table:", JSON.stringify(counts));
