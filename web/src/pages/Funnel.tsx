// Marketing funnel: spend, sales, ROAS and contribution from the client's Daily Funnel Sheet.
import { useEffect, useMemo, useState } from 'react'
import { Ring } from 'loading-dev'
import { EChartsComposedChart } from '@/components/evilcharts/charts/echarts-composed-chart'
import { EChartsPieChart } from '@/components/evilcharts/charts/echarts-pie-chart'
import { WorldMap } from '@/components/WorldMap'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { addDays, fmtDay, MARKETS, money, money2, monthEnd, ms, pct, ratio, times, today, type Funnel as FunnelData, type Provider } from '@/lib/data'

const PRESETS: [string, string][] = [['4w', 'Last 4 weeks'], ['month', 'This month'], ['lastmonth', 'Last month'], ['90d', 'Last 90 days'], ['ytd', 'Year to date']]
function presetRange(p: string): [string, string] {
  const y = addDays(today(), -1)
  if (p === 'month') return [y.slice(0, 7) + '-01', y]
  if (p === 'lastmonth') { const e = addDays(today().slice(0, 7) + '-01', -1); return [e.slice(0, 7) + '-01', e] }
  if (p === '90d') return [addDays(y, -89), y]
  if (p === 'ytd') return [y.slice(0, 4) + '-01-01', y]
  return [addDays(y, -27), y]
}
const COLORS: Record<string, string> = { UK: '#3b6fd8', US: '#0e9aa7', AU: '#d6498f', spend: '#d98a16', contribution: '#e0703a' }
type Tot = { spend: number; meta: number; google: number; app: number; sales: number; nc: number; net: number; con: number }
const zero = (): Tot => ({ spend: 0, meta: 0, google: 0, app: 0, sales: 0, nc: 0, net: 0, con: 0 })
const N = (v: unknown) => +(v as number) || 0

function Spark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return null
  const max = Math.max(...values), min = Math.min(...values), rng = max - min || 1
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 120).toFixed(1)},${(27 - ((v - min) / rng) * 24).toFixed(1)}`)
  return (
    <svg viewBox="0 0 120 30" preserveAspectRatio="none" className="mt-2 block h-8 w-full" aria-hidden="true">
      <path d={`M0,30 L${pts.join(' L')} L120,30 Z`} fill={color} opacity={0.14} />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />
    </svg>
  )
}
function Kpi({ label, value, sub, values, color }: { label: string; value: string; sub: string; values: number[]; color: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="px-4">
        <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{label}</div>
        <div className="text-2xl font-bold tracking-tight tabular-nums">{value}</div>
        <div className="text-xs text-muted-foreground">{sub}</div>
        <Spark values={values} color={color} />
      </CardContent>
    </Card>
  )
}

export function FunnelPage({ provider, dark }: { provider: Provider; dark: boolean }) {
  const [preset, setPreset] = useState('4w')
  const [[from, to], setRange] = useState<[string, string]>(presetRange('4w'))
  const [gran, setGran] = useState<'day' | 'week' | 'month'>('day')
  const [market, setMarket] = useState('')
  const [data, setData] = useState<FunnelData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true)
    provider.funnel(from, to).then((d) => { if (live) { setData(d); setLoading(false) } })
    return () => { live = false }
  }, [provider, from, to])

  const v = useMemo(() => {
    if (!data) return null
    const add = (o: Tot, r: any) => {
      o.meta += N(r.meta_spend); o.google += N(r.google_spend); o.app += N(r.applovin_spend)
      o.spend += r.ad_spend != null ? N(r.ad_spend) : N(r.meta_spend) + N(r.google_spend) + N(r.applovin_spend)
      o.sales += N(r.shopify_sales); o.nc += N(r.new_customer_sales); o.net += N(r.net_revenue); o.con += N(r.contribution)
    }
    const bucketOf = (d: string) => gran === 'month' ? d.slice(0, 7) + '-01' : gran === 'week' ? addDays(d, -((new Date(ms(d)).getUTCDay() + 6) % 7)) : d
    const rows = data.daily.filter((r) => !market || r.market === market)
    const tot = zero(), byM: Record<string, Tot> = {}, byDay: Record<string, Tot> = {}, buckets: Record<string, any> = {}, keys: string[] = [], days: string[] = []
    for (let d = from; d <= to; d = addDays(d, 1)) {
      byDay[d] = zero(); days.push(d)
      const b = bucketOf(d)
      if (!buckets[b]) { buckets[b] = { key: b, tot: zero(), byM: {} as Record<string, Tot> }; keys.push(b) }
    }
    for (const r of rows) {
      add(tot, r); add((byM[r.market] ||= zero()), r)
      if (byDay[r.day]) add(byDay[r.day], r)
      const b = buckets[bucketOf(r.day)]
      if (b) { add(b.tot, r); add((b.byM[r.market] ||= zero()), r) }
    }
    const markets = Object.keys(byM).sort((a, b) => byM[b].sales - byM[a].sales)
    const trend = keys.map((k) => {
      const b = buckets[k], row: Record<string, unknown> = {
        label: gran === 'month' ? new Date(ms(k)).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }) : fmtDay(k),
        spend: Math.round(b.tot.spend), contribution: Math.round(b.tot.con),
      }
      for (const m of markets) row[m] = Math.round(b.byM[m]?.sales || 0)
      return row
    })
    const cat: Record<string, { market: string; category: string; spend: number; nw: number; ret: number }> = {}
    for (const r of data.category) {
      if (market && r.market !== market) continue
      const o = (cat[r.market + '|' + r.category] ||= { market: r.market, category: r.category, spend: 0, nw: 0, ret: 0 })
      o.spend += N(r.meta_spend) + N(r.google_spend) + N(r.applovin_spend); o.nw += N(r.new_sales); o.ret += N(r.returning_sales)
    }
    const cats = Object.values(cat).sort((a, b) => b.nw + b.ret - (a.nw + a.ret))
    const costs: Record<string, number> = {}
    let sheetTotal = 0
    for (const c of data.costs) {
      if (c.month > to || monthEnd(c.month) < from) continue
      if (c.is_total) sheetTotal += N(c.amount)
      else if (c.currency !== 'USD') costs[c.item] = (costs[c.item] || 0) + N(c.amount)
    }
    const line = (f: (o: Tot) => number) => days.map((d) => f(byDay[d]))
    return { rows, tot, byM, markets, trend, cats, costs: Object.entries(costs).sort((a, b) => b[1] - a[1]), sheetTotal, line }
  }, [data, market, gran, from, to])

  const pick = (m: string) => setMarket((cur) => (cur === m ? '' : m))

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex flex-wrap gap-1 rounded-lg bg-muted p-1">
        {PRESETS.map(([k, label]) => (
          <Button key={k} size="sm" variant={preset === k ? 'default' : 'ghost'} onClick={() => { setPreset(k); setRange(presetRange(k)) }}>{label}</Button>
        ))}
      </div>
      <Input type="date" aria-label="From" className="w-auto" value={from} onChange={(e) => { if (e.target.value && e.target.value <= to) { setPreset(''); setRange([e.target.value, to]) } }} />
      <Input type="date" aria-label="To" className="w-auto" value={to} onChange={(e) => { if (e.target.value && e.target.value >= from) { setPreset(''); setRange([from, e.target.value]) } }} />
      {market && <Button size="sm" variant="outline" onClick={() => setMarket('')}>{MARKETS[market] || market} ✕</Button>}
    </div>
  )

  if (loading && !data) return <div className="space-y-4">{header}<div className="grid h-64 place-items-center"><Ring size={28} /></div></div>
  if (!data || !v) return <div className="space-y-4">{header}<Card><CardContent className="text-sm text-muted-foreground">No funnel figures are available yet.</CardContent></Card></div>

  const { tot, byM, markets, trend, cats } = v
  const when = data.meta.exported_at ? new Date(data.meta.exported_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null
  const platforms = [{ name: 'meta', label: 'Meta', value: Math.round(tot.meta), color: '#3b6fd8' }, { name: 'google', label: 'Google', value: Math.round(tot.google), color: '#0e9aa7' },
    { name: 'applovin', label: 'AppLovin', value: Math.round(tot.app), color: '#d98a16' }].filter((p) => p.value > 0)
  const best = Math.max(0.0001, ...markets.map((m) => ratio(byM[m].con, byM[m].net)))
  const trendConfig: any = { spend: { label: 'Ad spend', colors: { light: [COLORS.spend] } }, contribution: { label: 'Contribution after ads', colors: { light: [COLORS.contribution] } } }
  for (const m of markets) trendConfig[m] = { label: MARKETS[m] || m, colors: { light: [COLORS[m] || '#7b8aa0'] } }
  const catRows = cats.map((c) => ({ label: `${c.market} ${c.category}`, newSales: Math.round(c.nw), returning: Math.round(c.ret), spend: Math.round(c.spend) }))

  return (
    <div className="space-y-4">
      {header}
      <p className="text-xs text-muted-foreground">
        {data.meta.sample
          ? <><Badge variant="secondary" className="mr-2 bg-amber-100 text-amber-800">Sample data</Badge>Invented figures for the demo. Signed in, this page shows the real Daily Funnel Sheet.</>
          : <><Badge className="mr-2">Real data</Badge>From the client’s Daily Funnel Sheet{when ? `, copied ${when}` : ''}. Figures run to {data.meta.max ? fmtDay(String(data.meta.max), true) : '–'}. A copy, refreshed on a schedule. Sales include VAT; net revenue excludes it.</>}
      </p>

      {!v.rows.length ? <Card><CardContent className="text-sm text-muted-foreground">No funnel figures for this period{market ? ' and market' : ''}.</CardContent></Card> : <>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Kpi label="Shopify sales" value={money(tot.sales)} sub="inc. VAT" values={v.line((o) => o.sales)} color="#3b6fd8" />
          <Kpi label="Net revenue" value={money(tot.net)} sub="ex VAT" values={v.line((o) => o.net)} color="#4f7fe0" />
          <Kpi label="Ad spend" value={money(tot.spend)} sub={`${pct(tot.spend, tot.net)} of net revenue`} values={v.line((o) => o.spend)} color="#d98a16" />
          <Kpi label="Contribution after ads" value={money(tot.con)} sub={`${pct(tot.con, tot.net)} of net revenue`} values={v.line((o) => o.con)} color="#0e9aa7" />
          <Kpi label="Blended ROAS" value={times(tot.sales, tot.spend)} sub="sales ÷ ad spend" values={v.line((o) => ratio(o.sales, o.spend))} color="#8b5cf6" />
          <Kpi label="New-customer share" value={pct(tot.nc, tot.sales)} sub={`ROAS on new customers ${times(tot.nc, tot.spend)}`} values={v.line((o) => ratio(o.nc, o.sales))} color="#d6498f" />
        </div>

        <div className="grid gap-4 xl:grid-cols-[1fr_1.5fr_1fr]">
          <Card>
            <CardHeader><CardTitle>Ad spend by platform</CardTitle></CardHeader>
            <CardContent className="relative">
              <EChartsPieChart data={platforms} dataKey="value" nameKey="name" className="h-[270px] w-full"
                config={Object.fromEntries(platforms.map((p) => [p.name, { label: p.label, colors: { light: [p.color] } }]))}>
                <EChartsPieChart.Pie innerRadius="58%" outerRadius="84%" cornerRadius={6} paddingAngle={3} />
                <EChartsPieChart.Tooltip />
                <EChartsPieChart.Legend />
              </EChartsPieChart>
              <div className="pointer-events-none absolute inset-x-0 top-[38%] text-center">
                <div className="text-xl font-bold tabular-nums">{money(tot.spend)}</div>
                <div className="text-[11px] text-muted-foreground">total ad spend</div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Sales by market</CardTitle><CardDescription>Bubble size is sales. Select a bubble to filter.</CardDescription></CardHeader>
            <CardContent className="h-[270px]">
              <WorldMap dark={dark} onPick={pick} points={markets.map((m) => ({ market: m, sales: byM[m].sales, spend: byM[m].spend, contribution: byM[m].con }))} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Contribution margin by market</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {markets.map((m) => (
                <button key={m} type="button" onClick={() => pick(m)} className="block w-full cursor-pointer text-left">
                  <div className="flex items-baseline justify-between text-sm"><b>{MARKETS[m] || m}</b><span className="tabular-nums">{pct(byM[m].con, byM[m].net)}</span></div>
                  <div className="my-1 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, (ratio(byM[m].con, byM[m].net) / best) * 100)}%` }} /></div>
                  <div className="flex justify-between text-xs text-muted-foreground"><span>{money(byM[m].con)} on {money(byM[m].net)}</span><span>ROAS {times(byM[m].sales, byM[m].spend)}</span></div>
                </button>
              ))}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle>Sales by market, with ad spend and contribution</CardTitle>
            <div className="inline-flex gap-1 rounded-lg bg-muted p-1">
              {(['day', 'week', 'month'] as const).map((g) => <Button key={g} size="sm" variant={gran === g ? 'default' : 'ghost'} onClick={() => setGran(g)}>{g[0].toUpperCase() + g.slice(1)}</Button>)}
            </div>
          </CardHeader>
          <CardContent>
            <EChartsComposedChart data={trend} config={trendConfig} xDataKey="label" className="h-[330px] w-full">
              <EChartsComposedChart.Grid />
              <EChartsComposedChart.XAxis />
              <EChartsComposedChart.YAxis tickFormatter={(n) => money(n)} />
              <EChartsComposedChart.Tooltip />
              <EChartsComposedChart.Legend verticalAlign="top" />
              {markets.map((m) => <EChartsComposedChart.Bar key={m} dataKey={m} radius={0} barProps={{ stack: 'sales' }} />)}
              <EChartsComposedChart.Line dataKey="spend" curveType="smooth" />
              <EChartsComposedChart.Line dataKey="contribution" curveType="smooth" />
            </EChartsComposedChart>
          </CardContent>
        </Card>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Bags vs glasses cases</CardTitle><CardDescription>Ad spend matched to a product category, by market.</CardDescription></CardHeader>
            <CardContent>
              {catRows.length ? (
                <EChartsComposedChart data={catRows} xDataKey="label" className="h-[280px] w-full"
                  config={{ newSales: { label: 'New-customer sales', colors: { light: ['#0e9aa7'] } }, returning: { label: 'Returning sales', colors: { light: ['#4f7fe0'] } }, spend: { label: 'Ad spend', colors: { light: ['#d98a16'] } } }}>
                  <EChartsComposedChart.Grid />
                  <EChartsComposedChart.XAxis />
                  <EChartsComposedChart.YAxis tickFormatter={(n) => money(n)} />
                  <EChartsComposedChart.Tooltip />
                  <EChartsComposedChart.Legend verticalAlign="top" />
                  <EChartsComposedChart.Bar dataKey="newSales" radius={0} barProps={{ stack: 's' }} />
                  <EChartsComposedChart.Bar dataKey="returning" radius={0} barProps={{ stack: 's' }} />
                  <EChartsComposedChart.Bar dataKey="spend" radius={3} />
                </EChartsComposedChart>
              ) : <p className="text-sm text-muted-foreground">No category figures for this period.</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>App and software costs</CardTitle><CardDescription>Whole months touching this period. Not all overheads.</CardDescription></CardHeader>
            <CardContent>
              {v.costs.length || v.sheetTotal ? (
                <Table>
                  <TableHeader><TableRow><TableHead>Item</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {v.costs.slice(0, 10).map(([item, amount]) => <TableRow key={item}><TableCell>{item}</TableCell><TableCell className="text-right tabular-nums">{money2(amount)}</TableCell></TableRow>)}
                    {v.sheetTotal > 0 && <TableRow className="font-semibold"><TableCell>Sheet’s own total</TableCell><TableCell className="text-right tabular-nums">{money2(v.sheetTotal)}</TableCell></TableRow>}
                  </TableBody>
                </Table>
              ) : <p className="text-sm text-muted-foreground">The sheet has no app costs entered for this period.</p>}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader><CardTitle>By market</CardTitle><CardDescription>Select a row to filter the page to that market.</CardDescription></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow>
                {['Market', 'Meta', 'Google', 'AppLovin', 'Ad spend', 'Shopify sales', 'Net revenue', 'Contribution', 'Contr %', 'ROAS'].map((h, i) => <TableHead key={h} className={i ? 'text-right' : ''}>{h}</TableHead>)}
              </TableRow></TableHeader>
              <TableBody>
                {markets.map((m) => { const r = byM[m]; return (
                  <TableRow key={m} onClick={() => pick(m)} className="cursor-pointer" data-state={market === m ? 'selected' : undefined}>
                    <TableCell className="font-medium">{MARKETS[m] || m}</TableCell>
                    {[money(r.meta), money(r.google), money(r.app), money(r.spend), money(r.sales), money(r.net), money(r.con), pct(r.con, r.net), times(r.sales, r.spend)].map((c, i) => <TableCell key={i} className="text-right tabular-nums">{c}</TableCell>)}
                  </TableRow>
                ) })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </>}
    </div>
  )
}
