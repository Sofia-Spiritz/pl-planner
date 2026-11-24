// Where the dashboard's data comes from. Two providers with the same shape:
//   live — the Sofia & Spiritz Supabase project (signed-in users on the allowed list)
//   demo — invented numbers made in the browser, so the layout can be shown without signing in
import { createClient } from '@supabase/supabase-js'

// Public values: the publishable key is safe to ship in the browser.
export const SUPABASE_URL = 'https://gbbzlqqzctftahjfjbzq.supabase.co'
export const SUPABASE_KEY = 'sb_publishable_qsHWAn5IvYIrWxZPXOG5QQ_G-KrzntJ'
export const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

export type FunnelRow = {
  day: string; market: string; meta_spend: number; google_spend: number; applovin_spend: number
  ad_spend: number | null; shopify_sales: number; new_customer_sales: number; net_revenue: number; contribution: number
}
export type CategoryRow = {
  day: string; market: string; category: string; meta_spend: number; google_spend: number; applovin_spend: number
  new_sales: number; returning_sales: number
}
export type CostRow = { month: string; item: string; amount: number; currency: string; is_total: boolean }
export type Funnel = {
  daily: FunnelRow[]; category: CategoryRow[]; costs: CostRow[]
  meta: { sample?: boolean; source?: string; exported_at?: string | null; min?: string; max?: string }
}
export type SnapTab = { id: number; sheet: string; tab: string; copied_at: string | null; rows: number; cols: number }
export type SyncRow = { name: string; tab: string; enabled: boolean; rows: number; last_ok: string | null; last_status: string | null; last_message: string | null }

export type Provider = {
  mode: 'live' | 'demo'
  funnel(from: string, to: string): Promise<Funnel | null>
  snapList(): Promise<SnapTab[]>
  snapTab(id: number): Promise<string[][]>
  sync(): Promise<SyncRow[]>
}

export const live: Provider = {
  mode: 'live',
  async funnel(from, to) {
    const { data, error } = await sb.rpc('funnel_data', { p_from: from, p_to: to })
    return error ? null : data
  },
  async snapList() {
    const { data, error } = await sb.rpc('snap_list')
    return error ? [] : data || []
  },
  async snapTab(id) {
    const { data, error } = await sb.rpc('snap_tab', { p_id: id })
    if (error) throw new Error(error.message)
    return data || []
  },
  async sync() {
    const { data, error } = await sb.rpc('sync_status')
    return error ? [] : data || []
  },
}

// ---------- dates ----------
const DAY = 864e5
export const ms = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))
export const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
export const addDays = (s: string, n: number) => iso(ms(s) + n * DAY)
export const today = () => { const d = new Date(); return iso(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) }
export const monthEnd = (s: string) => iso(Date.UTC(+s.slice(0, 4), +s.slice(5, 7), 0))

// ---------- demo ----------
function prng(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const r2 = (n: number) => Math.round(n * 100) / 100

export function demo(): Provider {
  const rnd = prng(42), end = addDays(today(), -1), start = addDays(end, -149)
  const daily: FunnelRow[] = [], category: CategoryRow[] = []
  const base: Record<string, number> = { UK: 2100, US: 1350, AU: 430 }
  for (let d = start, i = 0; d <= end; d = addDays(d, 1), i++) {
    const dow = new Date(ms(d)).getUTCDay(), lift = (dow === 0 || dow === 6 ? 1.18 : 1) * (1 + i / 420)
    for (const m of Object.keys(base)) {
      const sales = r2(base[m] * lift * (0.82 + 0.36 * rnd()))
      const net = r2(sales * (m === 'US' ? 1 : m === 'UK' ? 5 / 6 : 10 / 11))
      const meta = r2(net * 0.15 * (0.8 + 0.4 * rnd())), google = r2(net * 0.07 * (0.8 + 0.4 * rnd())), app = r2(net * 0.025 * (0.6 + 0.8 * rnd()))
      daily.push({ day: d, market: m, meta_spend: meta, google_spend: google, applovin_spend: app, ad_spend: r2(meta + google + app),
        shopify_sales: sales, new_customer_sales: r2(sales * (0.76 + 0.1 * rnd())), net_revenue: net, contribution: r2(net * 0.58 - meta - google - app) })
      const bagShare = 0.74 + 0.08 * rnd()
      for (const [c, share] of [['Bags', bagShare], ['Glasses cases', 1 - bagShare]] as [string, number][]) {
        category.push({ day: d, market: m, category: c, meta_spend: r2(meta * share * 0.9), google_spend: r2(google * share * 0.9), applovin_spend: r2(app * share * 0.9),
          new_sales: r2(sales * share * 0.8), returning_sales: r2(sales * share * 0.2) })
      }
    }
  }
  const costs: CostRow[] = []
  for (let mo = start.slice(0, 7) + '-01'; mo <= end; mo = addDays(monthEnd(mo), 1)) {
    for (const [item, amount] of [['Sample store platform', 945], ['Sample email tool', 630], ['Sample reporting tool', 525]] as [string, number][]) costs.push({ month: mo, item, amount, currency: 'GBP', is_total: false })
    costs.push({ month: mo, item: 'TOTAL', amount: 2100, currency: 'GBP', is_total: true })
  }
  const names = ['Order 2 - Sample supplier', 'Order 10 - Sample supplier', 'Sample stock check', 'Sample supplier tracker', 'Sample forecast', 'Sample shipping rates', 'Sample P&L by location']
  return {
    mode: 'demo',
    async funnel(from, to) {
      return { daily: daily.filter((r) => r.day >= from && r.day <= to), category: category.filter((r) => r.day >= from && r.day <= to),
        costs: costs.filter((c) => c.month <= to && monthEnd(c.month) >= from), meta: { sample: true, source: 'sample generator', exported_at: null, min: start, max: end } }
    },
    async snapList() {
      return [
        { id: 1, sheet: 'Sample sheet (invented)', tab: 'Monthly P&L', copied_at: null, rows: 9, cols: 4 },
        { id: 2, sheet: 'Sample sheet (invented)', tab: 'Fixes list', copied_at: null, rows: 4, cols: 4 },
        ...names.map((n, i) => ({ id: 10 + i, sheet: n, tab: i === 2 ? 'Daily check' : 'Sheet1', copied_at: null, rows: 3, cols: 3 })),
      ]
    },
    async snapTab(id) {
      if (id >= 10) return [['Item', 'Quantity', 'Value'], ['Sample row A', '120', '£1,440'], ['Sample row B', '80', '£960']]
      return id === 1
        ? [['Sample monthly P&L'], ['Invented numbers, for the demo only.'], [], ['£', 'Sep 26', 'Oct 26', 'Nov 26'], ['Revenue'],
           ['Net revenue', '£120,400', '£134,900', '£141,250'], ['Product cost', '-£31,300', '-£35,100', '-£36,700'],
           ['Gross profit', '£89,100', '£99,800', '£104,550'], ['Gross margin', '74.0%', '74.0%', '74.0%']]
        : [['#', 'Priority', 'What we found', 'Status'], ['1', 'High', 'Sample: duty invoices booked under postage', 'Open'],
           ['2', 'Medium', 'Sample: supplier payment coded to the wrong account', 'Asked'], ['3', 'Low', 'Sample: one month booked late', 'Done']]
    },
    async sync() { return [] },
  }
}

// ---------- formatting ----------
export const money = (n: number) => (n < 0 ? '−' : '') + '£' + Math.round(Math.abs(n)).toLocaleString('en-GB')
export const money2 = (n: number) => (n < 0 ? '−' : '') + '£' + Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) + '%' : '–')
export const times = (a: number, b: number) => (b ? (a / b).toFixed(2) + 'x' : '–')
export const ratio = (a: number, b: number) => (b ? a / b : 0)
export const fmtDay = (s: string, year = false) =>
  new Date(ms(s)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC', ...(year ? { year: 'numeric' } : {}) })
export const MARKETS: Record<string, string> = { UK: 'United Kingdom', US: 'United States', AU: 'Australia' }
