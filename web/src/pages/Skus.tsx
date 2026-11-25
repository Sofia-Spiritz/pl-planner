// SKU profit: for one period, what each SKU sold, what it cost and what was left after marketing.
// Revenue is actual (Shopify). Every cost is an estimate from the client's own rates.
import { Fragment, useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from 'lucide-react'
import { Ring } from 'loading-dev'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { fmtDay, MARKETS, money, pct, type Provider, type SkuPl, type SkuRow } from '@/lib/data'

const FIELDS = ['units', 'gross_sales', 'discounts', 'net_sales', 'shipping_income', 'product_cost', 'duty_freight', 'pick_pack', 'postage', 'payment_fees', 'ad_spend'] as const
type Sum = Record<(typeof FIELDS)[number], number>
type Line = Sum & { key: string; sku: string; title: string; collection: string; is_gift: boolean; markets: Record<string, Sum> }
const zero = (): Sum => ({ units: 0, gross_sales: 0, discounts: 0, net_sales: 0, shipping_income: 0, product_cost: 0, duty_freight: 0, pick_pack: 0, postage: 0, payment_fees: 0, ad_spend: 0 })
const add = (t: Sum, r: Sum | SkuRow) => { for (const f of FIELDS) t[f] += +r[f] || 0 }
const revenue = (s: Sum) => s.net_sales + s.shipping_income
const otherCosts = (s: Sum) => s.duty_freight + s.pick_pack + s.postage + s.payment_fees
const gross = (s: Sum) => revenue(s) - s.product_cost - otherCosts(s)
const profit = (s: Sum) => gross(s) - s.ad_spend

// The lines of the breakdown, top to bottom, and whether each is actual or an estimate.
const BREAKDOWN: [string, (s: Sum) => number, 'actual' | 'estimate' | 'total', string][] = [
  ['List price of items sold', (s) => s.gross_sales, 'actual', 'revenue'],
  ['Discounts (includes free items at full price)', (s) => s.discounts, 'actual', 'revenue'],
  ['Net sales', (s) => s.net_sales, 'actual', 'revenue'],
  ['Shipping paid by customers', (s) => s.shipping_income, 'actual', 'revenue'],
  ['Revenue', revenue, 'total', ''],
  ['Product cost', (s) => -s.product_cost, 'estimate', 'product_cost'],
  ['Duty and inbound freight', (s) => -s.duty_freight, 'estimate', 'duty_freight'],
  ['Pick and pack', (s) => -s.pick_pack, 'estimate', 'pick_pack'],
  ['Postage', (s) => -s.postage, 'estimate', 'postage'],
  ['Payment fees', (s) => -s.payment_fees, 'estimate', 'payment_fees'],
  ['Profit before marketing', gross, 'total', ''],
  ['Marketing', (s) => -s.ad_spend, 'estimate', 'ad_spend'],
  ['Profit after marketing', profit, 'total', ''],
]

type SortKey = 'sku' | 'units' | 'revenue' | 'product' | 'unit' | 'other' | 'ads' | 'profit' | 'margin'
const SORT: Record<SortKey, (l: Line) => number | string> = {
  sku: (l) => l.sku, units: (l) => l.units, revenue, product: (l) => l.product_cost, unit: (l) => (l.units > 0 ? l.product_cost / l.units : 0),
  other: otherCosts, ads: (l) => l.ad_spend, profit, margin: (l) => (revenue(l) > 0 ? profit(l) / revenue(l) : -Infinity),
}
const COLS: [SortKey, string][] = [['units', 'Units'], ['revenue', 'Revenue'], ['product', 'Product cost'], ['unit', 'Cost per unit'], ['other', 'Other costs'], ['ads', 'Marketing'], ['profit', 'Profit'], ['margin', 'Margin']]

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'good' | 'bad' }) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="px-4">
        <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{label}</div>
        <div className={'text-2xl font-bold tracking-tight tabular-nums ' + (tone === 'bad' ? 'text-destructive' : tone === 'good' ? 'text-primary' : '')}>{value}</div>
        <div className="text-xs text-muted-foreground">{sub}</div>
      </CardContent>
    </Card>
  )
}

export function SkusPage({ provider }: { provider: Provider }) {
  const [data, setData] = useState<SkuPl | null>(null)
  const [loading, setLoading] = useState(true)
  const [market, setMarket] = useState('')
  const [coll, setColl] = useState('')
  const [find, setFind] = useState('')
  const [sort, setSort] = useState<[SortKey, 1 | -1]>(['revenue', -1])
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    provider.skuPl().then((d) => { if (alive) { setData(d); setLoading(false) } })
    return () => { alive = false }
  }, [provider])

  const v = useMemo(() => {
    if (!data?.rows?.length) return null
    const markets = [...new Set(data.rows.map((r) => r.market))].sort((a, b) => (a === 'Other' ? 1 : b === 'Other' ? -1 : 0))
    const inMarket = data.rows.filter((r) => !market || r.market === market)
    const byColl: Record<string, Sum> = {}
    for (const r of inMarket) add((byColl[r.collection] ||= zero()), r)
    const collections = Object.keys(byColl).sort((a, b) => revenue(byColl[b]) - revenue(byColl[a]))
    const lines: Record<string, Line> = {}
    const total = zero()
    const q = find.trim().toLowerCase()
    for (const r of inMarket) {
      if (coll && r.collection !== coll) continue
      if (q && !(r.sku + ' ' + r.title).toLowerCase().includes(q)) continue
      const l = (lines[r.sku] ||= { ...zero(), key: r.sku, sku: r.sku, title: r.title, collection: r.collection, is_gift: r.is_gift, markets: {} })
      add(l, r); add((l.markets[r.market] ||= zero()), r); add(total, r)
    }
    const [k, dir] = sort
    const list = Object.values(lines).sort((a, b) => {
      const x = SORT[k](a), y = SORT[k](b)
      return (typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number)) * dir
    })
    const maxColl = Math.max(1, ...collections.map((c) => Math.max(revenue(byColl[c]), Math.abs(profit(byColl[c])))))
    return { markets, collections, byColl, list, total, maxColl }
  }, [data, market, coll, find, sort])

  if (loading) return <div className="grid h-64 place-items-center"><Ring size={28} /></div>
  if (!data?.period || !v) return <Card><CardContent className="text-sm text-muted-foreground">No SKU profit figures are loaded yet.</CardContent></Card>

  const p = data.period, t = v.total, rev = revenue(t)
  const notes = p.notes || {}
  const sortBy = (k: SortKey) => setSort(([cur, dir]) => (cur === k ? [k, dir === 1 ? -1 : 1] : [k, k === 'sku' ? 1 : -1]))
  const num = 'text-right tabular-nums'

  return (
    <div className="space-y-4">
      <Card className="py-3">
        <CardContent className="px-4 text-sm text-muted-foreground">
          {p.sample
            ? <><Badge variant="secondary" className="mr-2 bg-amber-100 text-amber-800">Sample data</Badge>Invented products and figures for the demo. Signed in, this page shows the real week.</>
            : <><Badge className="mr-2">Real revenue</Badge><Badge variant="secondary" className="mr-2 bg-amber-100 text-amber-800">Estimated costs</Badge>
              Week of {fmtDay(p.from)} to {fmtDay(p.to, true)}. Revenue is taken from Shopify order lines. Every cost is an estimate from the client’s own rates, not from invoices, so profit here is a first view and not a final figure.</>}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        {['', ...v.markets].map((m) => (
          <Button key={m || 'all'} size="sm" variant={market === m ? 'default' : 'outline'} onClick={() => setMarket(m)}>{m ? MARKETS[m] || m : 'All markets'}</Button>
        ))}
        <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a SKU or product" className="ml-auto h-8 w-56" />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Revenue" value={money(rev)} sub={`${Math.round(t.units).toLocaleString('en-GB')} units, ex tax`} />
        <Kpi label="Product cost" value={money(t.product_cost)} sub={pct(t.product_cost, rev) + ' of revenue'} />
        <Kpi label="Shipping and handling" value={money(t.duty_freight + t.pick_pack + t.postage)} sub={pct(t.duty_freight + t.pick_pack + t.postage, rev) + ' of revenue'} />
        <Kpi label="Payment fees" value={money(t.payment_fees)} sub={pct(t.payment_fees, rev) + ' of revenue'} />
        <Kpi label="Marketing" value={money(t.ad_spend)} sub={pct(t.ad_spend, rev) + ' of revenue'} />
        <Kpi label="Profit after marketing" value={money(profit(t))} sub={pct(profit(t), rev) + ' margin'} tone={profit(t) < 0 ? 'bad' : 'good'} />
      </div>

      <Card>
        <CardHeader><CardTitle>By product group</CardTitle><CardDescription>Revenue against profit after marketing. Select a group to filter the table.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {v.collections.map((c) => {
            const s = v.byColl[c], r = revenue(s), pr = profit(s)
            return (
              <button key={c} type="button" onClick={() => setColl(coll === c ? '' : c)}
                className={'grid w-full grid-cols-[9rem_1fr_13rem] items-center gap-3 rounded-md px-2 py-1 text-left text-sm hover:bg-muted ' + (coll === c ? 'bg-muted' : '')}>
                <span className="font-medium">{c}</span>
                <span className="space-y-1">
                  <span className="block h-2 rounded bg-primary/70" style={{ width: Math.max(0.5, (r / v.maxColl) * 100) + '%' }} />
                  <span className={'block h-2 rounded ' + (pr < 0 ? 'bg-destructive/70' : 'bg-chart-3')} style={{ width: Math.max(0.5, (Math.abs(pr) / v.maxColl) * 100) + '%' }} />
                </span>
                <span className="text-right text-xs tabular-nums text-muted-foreground">
                  {money(r)} revenue<br /><span className={pr < 0 ? 'text-destructive' : ''}>{money(pr)} profit</span>
                </span>
              </button>
            )
          })}
          {coll && <Button size="sm" variant="outline" onClick={() => setColl('')}>Show all groups</Button>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Each SKU{coll ? `: ${coll}` : ''}</CardTitle>
          <CardDescription>{v.list.length} SKUs. Select a column heading to sort, or a row to see every line of its sum.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead><button type="button" className="font-medium" onClick={() => sortBy('sku')}>SKU</button></TableHead>
                {COLS.map(([k, label]) => (
                  <TableHead key={k} className="text-right">
                    <button type="button" className="inline-flex items-center gap-1 font-medium" onClick={() => sortBy(k)}>
                      {label}{sort[0] === k && (sort[1] === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow className="bg-muted/60 font-semibold">
                <TableCell>All shown</TableCell>
                <TableCell className={num}>{Math.round(t.units).toLocaleString('en-GB')}</TableCell>
                <TableCell className={num}>{money(rev)}</TableCell>
                <TableCell className={num}>{money(t.product_cost)}</TableCell>
                <TableCell className={num}>–</TableCell>
                <TableCell className={num}>{money(otherCosts(t))}</TableCell>
                <TableCell className={num}>{money(t.ad_spend)}</TableCell>
                <TableCell className={num + (profit(t) < 0 ? ' text-destructive' : '')}>{money(profit(t))}</TableCell>
                <TableCell className={num}>{pct(profit(t), rev)}</TableCell>
              </TableRow>
              {v.list.map((l) => {
                const r = revenue(l), pr = profit(l), isOpen = open === l.key
                return (
                  <Fragment key={l.key}>
                    <TableRow className="cursor-pointer" onClick={() => setOpen(isOpen ? null : l.key)}>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          {isOpen ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
                          <div>
                            <div className="font-medium">{l.sku}{l.is_gift && <Badge variant="secondary" className="ml-2">Free gift</Badge>}</div>
                            <div className="max-w-[18rem] truncate text-xs text-muted-foreground">{l.title || l.collection}</div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className={num}>{Math.round(l.units).toLocaleString('en-GB')}</TableCell>
                      <TableCell className={num}>{money(r)}</TableCell>
                      <TableCell className={num}>{money(l.product_cost)}</TableCell>
                      <TableCell className={num}>{l.units > 0 && l.product_cost > 0 ? '£' + (l.product_cost / l.units).toFixed(2) : '–'}</TableCell>
                      <TableCell className={num}>{money(otherCosts(l))}</TableCell>
                      <TableCell className={num}>{money(l.ad_spend)}</TableCell>
                      <TableCell className={num + (pr < 0 ? ' text-destructive' : '')}>{money(pr)}</TableCell>
                      <TableCell className={num}>{r > 0 ? pct(pr, r) : '–'}</TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableCell colSpan={9} className="p-4">
                          <div className="overflow-x-auto">
                            <table className="w-full max-w-3xl text-sm">
                              <thead>
                                <tr className="text-xs text-muted-foreground">
                                  <th className="py-1 text-left font-medium">Line</th>
                                  {Object.keys(l.markets).map((m) => <th key={m} className="py-1 text-right font-medium">{MARKETS[m] || m}</th>)}
                                  <th className="py-1 text-right font-medium">Total</th>
                                </tr>
                              </thead>
                              <tbody>
                                {BREAKDOWN.map(([label, fn, kind]) => (
                                  <tr key={label} className={kind === 'total' ? 'border-t font-semibold' : ''}>
                                    <td className="py-1">{label}{kind === 'estimate' && <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">estimate</span>}</td>
                                    {Object.values(l.markets).map((s, i) => <td key={i} className={'py-1 ' + num}>{money(fn(s))}</td>)}
                                    <td className={'py-1 ' + num}>{money(fn(l))}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>How each line is worked out</CardTitle><CardDescription>What is real and what is still an estimate.</CardDescription></CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm md:grid-cols-[11rem_1fr]">
            {([['Revenue', 'revenue'], ['Product cost', 'product_cost'], ['Which warehouse', 'three_pl'], ['Duty and freight', 'duty_freight'], ['Pick and pack', 'pick_pack'],
              ['Postage', 'postage'], ['Payment fees', 'payment_fees'], ['Marketing', 'ad_spend'], ['Cancelled and returned', 'cancelled']] as [string, string][])
              .filter(([, k]) => notes[k]).map(([label, k]) => (
                <Fragment key={k}><dt className="font-medium">{label}</dt><dd className="text-muted-foreground">{notes[k]}</dd></Fragment>
              ))}
          </dl>
        </CardContent>
      </Card>
    </div>
  )
}
