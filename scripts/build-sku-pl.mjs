// Builds an estimated profit-and-loss per SKU and market for one period.
//
//   node scripts/build-sku-pl.mjs <order-lines.csv> <sheets-all.json> <daily-funnel.json> <settings.json>
//
// Inputs (all private, kept outside this public project):
//   order-lines.csv   one row per order line from Shopify's sales report
//   sheets-all.json   the copy of the client's sheets (for their cost inputs and product list)
//   daily-funnel.json the copy of the Daily Funnel Sheet (for ad spend by market)
//   settings.json     the period, which sheets hold the cost inputs and product lists, and any
//                     rates that are not in the sheets
// Output: supabase/seeds/04_private_sku_pl.sql (never committed) and a summary on screen.
//
// Revenue is actual. Every cost is an estimate from the client's own rates, not an invoice.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [linesFile, sheetsFile, funnelFile, settingsFile] = process.argv.slice(2)
if (!settingsFile) { console.error('Usage: node scripts/build-sku-pl.mjs <order-lines.csv> <sheets-all.json> <daily-funnel.json> <settings.json>'); process.exit(1) }
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const settings = JSON.parse(readFileSync(settingsFile, 'utf8'))
const { period_from, period_to } = settings

// ---------- helpers ----------
function parseCsv(s) {
  const out = []; let row = [], cur = '', q = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++ } else q = false } else cur += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(cur); cur = '' }
    else if (c === '\n') { row.push(cur); out.push(row); row = []; cur = '' }
    else if (c !== '\r') cur += c
  }
  row.push(cur); out.push(row); return out
}
const num = (x) => { const n = parseFloat(String(x ?? '').replace(/[£$,\s]/g, '')); return Number.isFinite(n) ? n : 0 }
const pct = (x) => { const s = String(x ?? ''); const n = num(s.replace('%', '')); return s.includes('%') ? n / 100 : n }
const r2 = (n) => Math.round(n * 100) / 100
const sheets = JSON.parse(readFileSync(sheetsFile, 'utf8')).sheets
const tab = (sheetName, tabName) => {
  const s = sheets.find((x) => x.sheet.includes(sheetName)); if (!s) throw new Error('Sheet not found: ' + sheetName)
  const k = Object.keys(s.tabs).find((x) => x.includes(tabName)); if (!k) throw new Error('Tab not found: ' + tabName)
  const t = s.tabs[k]
  return (Array.isArray(t) ? t : t.rows ? t.rows : parseCsv(String(t))).map((r) => r.map((c) => String(c == null ? '' : c.v !== undefined ? c.v : c).trim()))
}

// ---------- the client's cost inputs ----------
const costSheet = settings.cost_sheet   // the client's own P&L model: tabs "Inputs" and "Unit Costs"
const inputs = tab(costSheet, 'Inputs')
const inputRow = (label) => inputs.find((r) => r.some((c) => c.startsWith(label)))
const valueAfter = (label) => { const r = inputRow(label); if (!r) throw new Error('Input not found: ' + label); const i = r.findIndex((c) => c.startsWith(label)); return r.slice(i + 1).find(Boolean) }
const feeRate = pct(valueAfter('Payment fees, % of gross revenue'))
const ukInbound = pct(valueAfter('UK 3PL inbound freight and duty'))
const usdPerGbp = num(valueAfter('US dollars per pound'))

// Per-order costs by location and 3PL.
const hdrIx = inputs.findIndex((r) => r.includes('Key') && r.some((c) => c.startsWith('Pick & pack')))
const hdr = inputs[hdrIx]
const col = (startsWith) => hdr.findIndex((c) => c.startsWith(startsWith))
const perOrder = {}
for (const r of inputs.slice(hdrIx + 1)) {
  const key = r[col('Key')]; if (!key || !key.includes('|')) break
  perOrder[key] = { pick: num(r[col('Pick & pack')]), postBag: num(r[col('Postage, order with a bag')]), postOther: num(r[col('Postage, case-only')]), duty: pct(r[col('Import duty rate')]), dutyBasis: r[col('Duty basis')] }
}
// Which 3PL ships each market this month.
const month = period_from.slice(0, 7)
const monthLabel = new Date(period_from + 'T00:00:00Z').toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }) + ' ' + period_from.slice(2, 4)
const shareIx = inputs.findIndex((r) => r.includes('Location') && r.includes(monthLabel))
const shareCol = inputs[shareIx].indexOf(monthLabel)
const threePl = {}
for (const r of inputs.slice(shareIx + 1, shareIx + 5)) { const loc = r[inputs[shareIx].indexOf('Location')]; if (loc) threePl[loc] = pct(r[shareCol]) >= 0.5 ? 'Portless' : 'UK 3PL' }

// Unit cost in force this month, by 3PL and product type.
const uc = tab(costSheet, 'Unit Costs')
const ucHdr = uc.find((r) => r[0] === 'Key')
const unitCost = {}
for (const pl of ['UK 3PL', 'Portless']) {
  const r = uc.find((x) => x[0] === month + '|' + pl); if (!r) throw new Error('No unit costs for ' + month + ' ' + pl)
  unitCost[pl] = {}; ucHdr.forEach((h, i) => { if (i > 3 && h) unitCost[pl][h] = num(r[i]) })
}
const costType = (sku) => /^BAGA/.test(sku) ? 'Alba bag' : /^BAGL/.test(sku) ? 'Lyla bag' : /^BAG/.test(sku) ? 'Other bag' : /^GLS/.test(sku) ? 'Glasses case'
  : /^STP/.test(sku) ? 'Strap' : /^TAS/.test(sku) ? 'Tassel' : /^CRD/.test(sku) ? 'Card holder' : /^PRS/.test(sku) ? 'Purse' : null
const collection = (sku) => /^BAG/.test(sku) ? 'Bags' : /^GLS/.test(sku) ? 'Glasses cases' : /^STP/.test(sku) ? 'Straps' : /^TAS/.test(sku) ? 'Tassels'
  : /^CRD/.test(sku) ? 'Card holders' : /^PRS/.test(sku) ? 'Purses' : /^CCB/.test(sku) ? 'Dust bags' : 'Other'
const isGift = (sku) => /-1$/.test(sku)

// Product names from the client's product lists.
const names = new Map()
for (const [sn, tn] of settings.product_lists || []) {   // [sheet name, tab name] pairs
  try {
    const t = tab(sn, tn); const h = t.find((r) => r.includes('New SKU Code')); if (!h) continue
    const si = h.indexOf('New SKU Code'), ni = h.indexOf('Product Name')
    for (const r of t) if (r[si] && r[ni] && r[si] !== 'New SKU Code' && !names.has(r[si])) names.set(r[si], r[ni])
  } catch { /* that list is not in this copy */ }
}

// ---------- ad spend for the period, by market ----------
const funnel = JSON.parse(readFileSync(funnelFile, 'utf8'))
const ft = (funnel.tabs || funnel)['UK vs US Daily Data']
const fcols = (ft.cols || []).map((c) => (typeof c === 'string' ? c : (c && (c.label || c.v || c.f)) || '').replace(/\s+/g, ' ').trim())
const fsum = (label) => { const i = fcols.indexOf(label); if (i < 0) return null; let s = 0; for (const r of ft.rows) { const d = r[0]?.v; if (d >= period_from && d <= period_to) s += r[i]?.v || 0 } return s }
const MK = { UK: 'UK', US: 'US', AU: 'AUS' }
const adSpend = {}, sheetContribution = {}, sheetNet = {}
for (const [m, lab] of Object.entries(MK)) { adSpend[m] = fsum(lab + ' Total ad spend') || 0; sheetContribution[m] = fsum(lab + ' Contribution profit after ads'); sheetNet[m] = fsum(lab + ' Net revenue (ex VAT)') }

// ---------- order lines ----------
const L = parseCsv(readFileSync(linesFile, 'utf8').trim()); const H = L[0]
const ix = Object.fromEntries(H.map((h, i) => [h, i]))
const marketOf = (c) => c === 'United Kingdom' ? 'UK' : c === 'United States' ? 'US' : c === 'Australia' ? 'AU' : 'Other'
const orders = new Map()
for (const r of L.slice(1)) {
  const o = orders.get(r[ix.order_name]) || { market: marketOf(r[ix.shipping_country]), lines: [], ship: 0, other: 0, total: 0 }
  orders.set(r[ix.order_name], o)
  o.total += num(r[ix.total_sales])
  if (r[ix.line_type] === 'product') o.lines.push({ sku: r[ix.sku] || '(none)', units: num(r[ix.net_items_sold]), gross: num(r[ix.gross_sales]), disc: num(r[ix.discounts]), net: num(r[ix.net_sales]) })
  else if (r[ix.line_type] === 'shipping') o.ship += num(r[ix.shipping_charges])
  else o.other += num(r[ix.net_sales])          // sale adjustments and similar
}

const P = settings.portless_pick   // { base_usd, included_picks, extra_pick_usd, surcharge_usd }
const agg = new Map()
const get = (market, sku) => {
  const k = market + '|' + sku
  if (!agg.has(k)) agg.set(k, { market, three_pl: threePl[market] || 'UK 3PL', sku, title: names.get(sku) || names.get(sku.replace(/-1$/, '')) || '', collection: collection(sku), is_gift: isGift(sku),
    units: 0, gross_sales: 0, discounts: 0, net_sales: 0, shipping_income: 0, product_cost: 0, duty_freight: 0, pick_pack: 0, postage: 0, payment_fees: 0, ad_spend: 0 })
  return agg.get(k)
}
let shippedOrders = 0
for (const o of orders.values()) {
  const pl = threePl[o.market] || 'UK 3PL'
  const rates = perOrder[o.market + '|' + pl]
  const sold = o.lines.reduce((a, l) => a + Math.max(l.units, 0), 0)
  // Order-level costs only where something was actually sent out.
  let pick = 0, post = 0, fee = 0
  if (sold > 0) {
    shippedOrders++
    if (pl === 'Portless' && P) {
      const picks = o.lines.reduce((a, l) => a + (!isGift(l.sku) || /^CCB/.test(l.sku) ? Math.max(l.units, 0) : 0), 0)
      pick = (P.base_usd + Math.max(0, picks - P.included_picks) * P.extra_pick_usd + (P.surcharge_usd || 0)) / usdPerGbp
    } else pick = rates.pick
    post = o.lines.some((l) => l.units > 0 && /^BAG/.test(l.sku)) ? rates.postBag : rates.postOther
    fee = Math.max(o.total, 0) * feeRate
  }
  // Share order-level amounts across the lines by what each line earned (free lines get none).
  let w = o.lines.map((l) => Math.max(l.net, 0)); let ws = w.reduce((a, b) => a + b, 0)
  if (ws <= 0) { w = o.lines.map((l) => Math.max(l.units, 0)); ws = w.reduce((a, b) => a + b, 0) }
  o.lines.forEach((l, i) => {
    const a = get(o.market, l.sku); const share = ws > 0 ? w[i] / ws : 0
    const type = costType(l.sku)
    const cost = isGift(l.sku) || !type ? 0 : Math.max(l.units, 0) * (unitCost[pl][type] || 0)
    a.units += l.units; a.gross_sales += l.gross; a.discounts += l.disc; a.net_sales += l.net
    a.shipping_income += (o.ship + o.other) * share
    a.product_cost += cost
    a.duty_freight += pl === 'UK 3PL' ? cost * ukInbound : rates.dutyBasis.includes('product cost') ? cost * rates.duty : 0
    a.pick_pack += pick * share; a.postage += post * share; a.payment_fees += fee * share
  })
}
// Ad spend: each market's spend shared across SKUs by the revenue each one earned there.
for (const m of Object.keys(MK)) {
  const rows = [...agg.values()].filter((a) => a.market === m)
  const rev = rows.reduce((s, a) => s + Math.max(a.net_sales + a.shipping_income, 0), 0)
  for (const a of rows) a.ad_spend = rev > 0 ? adSpend[m] * Math.max(a.net_sales + a.shipping_income, 0) / rev : 0
}

// ---------- output ----------
const rows = [...agg.values()].filter((a) => a.units !== 0 || Math.abs(a.net_sales) > 0.005 || Math.abs(a.gross_sales) > 0.005)
const F = ['units', 'gross_sales', 'discounts', 'net_sales', 'shipping_income', 'product_cost', 'duty_freight', 'pick_pack', 'postage', 'payment_fees', 'ad_spend']
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"
const notes = {
  revenue: 'Actual, from Shopify sales lines.',
  product_cost: `Estimate: the client's unit cost in force for ${monthLabel} by 3PL (latest purchase order price), not FIFO. Free-gift "-1" SKUs cost 0 because the bag price covers them.`,
  three_pl: Object.entries(threePl).map(([k, v]) => k + ': ' + v).join(', '),
  duty_freight: `Estimate: UK 3PL inbound freight and duty ${(ukInbound * 100).toFixed(1)}% of product cost; import duty on US orders from Portless ${(perOrder['US|Portless'].duty * 100).toFixed(0)}% of product cost.`,
  pick_pack: 'Estimate: per-order rate, shared across the paid lines of each order.',
  postage: 'Estimate: flat rate per order by market, not the invoiced cost.',
  payment_fees: `Estimate: ${(feeRate * 100).toFixed(1)}% of what the customer paid.`,
  ad_spend: 'Actual total per market from the Daily Funnel Sheet, shared across SKUs by the revenue each earned in that market.',
  cancelled: 'Orders with nothing sent out carry no order costs. Returns reduce revenue but do not give product cost back.',
}
let sql = `-- Estimated profit per SKU and market. Private client data: never commit this file.\n`
sql += `delete from public.sku_pl where period_from = ${q(period_from)} and period_to = ${q(period_to)};\n`
sql += `delete from public.sku_pl_meta where period_from = ${q(period_from)} and period_to = ${q(period_to)};\n`
sql += `insert into public.sku_pl_meta (period_from, period_to, built_at, notes) values (${q(period_from)}, ${q(period_to)}, now(), ${q(JSON.stringify(notes))}::jsonb);\n`
for (let i = 0; i < rows.length; i += 200) {
  sql += `insert into public.sku_pl (period_from, period_to, market, three_pl, sku, title, collection, is_gift, ${F.join(', ')}) values\n`
  sql += rows.slice(i, i + 200).map((a) => `(${q(period_from)}, ${q(period_to)}, ${q(a.market)}, ${q(a.three_pl)}, ${q(a.sku)}, ${q(a.title)}, ${q(a.collection)}, ${a.is_gift}, ${F.map((f) => r2(a[f])).join(', ')})`).join(',\n') + ';\n'
}
writeFileSync(join(root, 'supabase', 'seeds', '04_private_sku_pl.sql'), sql)

const tot = (list) => { const t = Object.fromEntries(F.map((f) => [f, list.reduce((s, a) => s + a[f], 0)])); t.revenue = t.net_sales + t.shipping_income; t.gross_profit = t.revenue - t.product_cost - t.duty_freight - t.pick_pack - t.postage - t.payment_fees; t.contribution = t.gross_profit - t.ad_spend; return t }
const money = (n) => '£' + Math.round(n).toLocaleString('en-GB')
console.log(`Period ${period_from} to ${period_to}. Orders ${orders.size}, with something sent out ${shippedOrders}. SKU and market rows ${rows.length}. Names found for ${rows.filter((a) => a.title).length}.`)
console.log('3PL by market:', notes.three_pl, '| fee rate', feeRate, '| UK inbound', ukInbound, '| USD per GBP', usdPerGbp)
console.log('Unit costs UK 3PL:', JSON.stringify(unitCost['UK 3PL']), '\nUnit costs Portless:', JSON.stringify(unitCost['Portless']))
console.log('Per-order rates:', JSON.stringify(perOrder))
for (const m of ['UK', 'US', 'AU', 'Other', 'ALL']) {
  const t = tot(rows.filter((a) => m === 'ALL' || a.market === m))
  console.log(`${m.padEnd(5)} revenue ${money(t.revenue)} (net sales ${money(t.net_sales)} + shipping ${money(t.shipping_income)}) | product ${money(t.product_cost)} | duty/freight ${money(t.duty_freight)} | pick ${money(t.pick_pack)} | postage ${money(t.postage)} | fees ${money(t.payment_fees)} | gross profit ${money(t.gross_profit)} (${(100 * t.gross_profit / t.revenue).toFixed(1)}%) | ads ${money(t.ad_spend)} | contribution ${money(t.contribution)} (${(100 * t.contribution / t.revenue).toFixed(1)}%)` +
    (sheetContribution[m] != null ? ` | funnel sheet: net revenue ${money(sheetNet[m])}, contribution ${money(sheetContribution[m])}` : ''))
}
const byColl = {}; for (const a of rows) { (byColl[a.collection] ||= []).push(a) }
for (const [c, list] of Object.entries(byColl)) { const t = tot(list); console.log(`  ${c.padEnd(14)} units ${String(t.units).padStart(6)} | revenue ${money(t.revenue)} | product cost ${money(t.product_cost)} | contribution ${money(t.contribution)}`) }
console.log('Wrote supabase/seeds/04_private_sku_pl.sql')
