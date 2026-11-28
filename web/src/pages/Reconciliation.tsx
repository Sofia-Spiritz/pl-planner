import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ShopifyReconciliationChart } from '@/components/ShopifyReconciliationChart'
import { TradingYearHistory } from '@/components/TradingYearHistory'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { money2 } from '@/lib/data'
import { LOCAL_YEAR_HISTORY, readReports, REPORT_FEED_ENABLED, REPORTS, sampleReports, type ReportKey } from '@/lib/reconciliation-reports'
import { compareOrders, COSTS, groupOrders, mixedBaskets, SALES, type Dataset, type Metric } from '@/lib/reconciliation'

const amount = (pence?: number) => pence === undefined ? '—' : money2(pence / 100)
const number = new Intl.NumberFormat('en-GB')
type Bundle = ReturnType<typeof sampleReports>

function ReportTable({ name, bundle }: { name: ReportKey; bundle?: Bundle }) {
  const { label } = REPORTS[name]
  const columns: ReadonlyArray<readonly [string, string]> = REPORTS[name].columns
  const report = bundle?.reports[name]
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const rows = report?.rows.filter(row => columns.some(([key]) => String(row[key] ?? '').toLowerCase().includes(query))) ?? []
  return (
    <Card>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <CardDescription>{report ? 'Feed refreshed ' + new Date(report.refreshedAt).toLocaleString('en-GB', { timeZone: 'UTC' }) + ' UTC' : 'Waiting for the report feed.'}</CardDescription>
      </CardHeader>
      {report && <CardContent className="space-y-3">
        {!!report.rows.length && <Input aria-label={'Search ' + label} placeholder="Search this report" value={search} onChange={event => setSearch(event.target.value)} />}
        <Table>
          <TableHeader><TableRow>{columns.map(([key, heading]) => <TableHead key={key}>{heading}</TableHead>)}</TableRow></TableHeader>
          <TableBody>
            {rows.slice(0, 100).map((row, index) => <TableRow key={index}>
              {columns.map(([key]) => {
                const value = row[key]
                return <TableCell key={key} className="tabular-nums">{typeof value === 'number' ? (key === 'orders' || key === 'cancelled') ? number.format(value) : amount(value) : value ?? '—'}</TableCell>
              })}
            </TableRow>)}
            {!rows.length && <TableRow><TableCell colSpan={columns.length}>No rows in this view.</TableCell></TableRow>}
          </TableBody>
        </Table>
        {rows.length > 100 && <p className="text-xs text-muted-foreground">First 100 of {number.format(rows.length)} rows. Search to narrow the view.</p>}
      </CardContent>}
    </Card>
  )
}

type Orders = ReturnType<typeof groupOrders>

function Comparisons({ engine, reference, referenceLabel, options, ready }: {
  engine: Orders; reference: Orders; referenceLabel: string; options: Partial<Record<Metric, string>>; ready: boolean
}) {
  const [metricChoice, setMetricChoice] = useState<Metric>()
  const [search, setSearch] = useState('')
  const [onlyExceptions, setOnlyExceptions] = useState(true)
  const columns = Object.keys(options) as Metric[]
  const metric = metricChoice && options[metricChoice] ? metricChoice : columns[0]
  const rows = useMemo(() => ready && metric ? compareOrders(engine, reference, metric) : [], [engine, reference, metric, ready])
  const query = search.trim().toLowerCase().replace(/^#/, '')
  const filtered = rows.filter(row => (!onlyExceptions || row.status !== 'Match') && row.id.toLowerCase().includes(query))
  const paired = rows.filter(row => row.delta !== undefined)
  const delta = paired.length ? paired.reduce((total, row) => total + row.delta!, 0) : undefined

  if (!ready) return <p className="py-4 text-muted-foreground">Waiting for both comparison feeds for this date range.</p>
  if (!metric) return <p className="py-4 text-muted-foreground">The feeds have no equivalent measures for this tab.</p>

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <label className="grid gap-1 text-sm">
          Measure
          <select className="h-8 rounded-lg border bg-background px-2" value={metric} onChange={e => setMetricChoice(e.target.value as Metric)}>
            {columns.map(key => <option key={key} value={key}>{options[key]}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm">Find order ID<Input value={search} onChange={e => setSearch(e.target.value)} /></label>
        <label className="flex min-h-8 items-center gap-2 text-sm">
          <input type="checkbox" checked={onlyExceptions} onChange={e => setOnlyExceptions(e.target.checked)} /> Exceptions only
        </label>
      </div>
      <p className="text-sm text-muted-foreground">
        {paired.length.toLocaleString()} comparable orders · Net difference {amount(delta)} · {filtered.length.toLocaleString()} results
        {filtered.length > 100 ? ' · First 100 shown. Search by order ID for more.' : ''}
      </p>
      <Table>
        <TableHeader><TableRow>
          <TableHead>Order ID</TableHead><TableHead className="text-right">Engine</TableHead><TableHead className="text-right">{referenceLabel}</TableHead>
          <TableHead className="text-right">Engine less source</TableHead><TableHead>Status</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {filtered.slice(0, 100).map(row => <TableRow key={row.id}>
            <TableCell className="font-mono">{row.id}</TableCell>
            <TableCell className="text-right tabular-nums">{amount(row.engine)}</TableCell>
            <TableCell className="text-right tabular-nums">{amount(row.reference)}</TableCell>
            <TableCell className="text-right tabular-nums">{amount(row.delta)}</TableCell>
            <TableCell>{row.status}</TableCell>
          </TableRow>)}
          {!filtered.length && <TableRow><TableCell colSpan={5}>No orders match these filters.</TableCell></TableRow>}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">A blank amount is incomplete evidence. Use the same date basis, definition and currency on both sides.</p>
    </div>
  )
}

export function ReconciliationPage({ mode }: { mode: 'demo' | 'live' }) {
  const [view, setView] = useState(LOCAL_YEAR_HISTORY ? 'year' : 'overview')
  const [from, setFrom] = useState('2026-11-16')
  const [to, setTo] = useState('2026-11-22')
  const [refresh, setRefresh] = useState(0)
  const [liveRead, setLiveRead] = useState<{ key: string; bundle?: Bundle; error?: string }>()
  const valid = Boolean(from && to && from <= to)
  const key = [from, to, refresh].join('/')
  useEffect(() => {
    if (mode !== 'live' || !valid || !REPORT_FEED_ENABLED) return
    const controller = new AbortController()
    readReports(from, to, controller.signal).then(bundle => {
      if (!controller.signal.aborted) setLiveRead({ key, bundle })
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLiveRead({ key, error: error instanceof Error ? error.message : 'Could not load reports.' })
    })
    return () => controller.abort()
  }, [from, to, key, mode, valid])
  const example = useMemo(() => mode === 'demo' && valid ? sampleReports(from, to) : undefined, [mode, valid, from, to])
  const current = liveRead?.key === key ? liveRead : undefined
  const bundle = mode === 'demo' ? example : current?.bundle
  const { shopify, engine, evidence } = bundle ?? {}
  const shop = useMemo(() => groupOrders(shopify, from, to), [shopify, from, to])
  const engines = useMemo(() => groupOrders(engine, from, to), [engine, from, to])
  const costs = useMemo(() => groupOrders(evidence, from, to), [evidence, from, to])
  const baskets = useMemo(() => mixedBaskets(shop), [shop])
  const orderReady = valid && Boolean(shopify && engine)
  const costReady = valid && Boolean(evidence && engine)
  const matched = orderReady ? [...shop.keys()].filter(id => engines.has(id)).length : undefined
  const shared = (reference: Dataset | undefined, fields: Partial<Record<Metric, string>>) =>
    Object.fromEntries(Object.entries(fields).filter(([k]) => engine?.columns.includes(k as Metric) && reference?.columns.includes(k as Metric)))

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      {view !== 'year' && <div className="flex flex-wrap items-end justify-between gap-4">
        <p className="text-sm text-muted-foreground">{mode === 'demo' ? 'Sample reports · invented figures' : 'Shopify and engine reconciliation feeds'}</p>
        <div className="flex flex-wrap gap-3">
          <label className="grid gap-1 text-xs font-medium">From<Input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
          <label className="grid gap-1 text-xs font-medium">Through<Input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
          {mode === 'live' && REPORT_FEED_ENABLED && <Button className="self-end" variant="outline" size="sm" disabled={!valid || !current} onClick={() => setRefresh(value => value + 1)}>Refresh</Button>}
        </div>
      </div>}
      {view !== 'year' && !valid && <p role="alert" className="text-sm text-destructive">Choose a start and end day in chronological order.</p>}
      {view !== 'year' && mode === 'demo' && valid && !bundle?.reports.shopifyDaily?.rows.length && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <p role="status" className="text-muted-foreground">The demo contains orders on 18–19 November 2026.</p>
          <Button variant="outline" size="sm" onClick={() => { setFrom('2026-11-16'); setTo('2026-11-22') }}>Show demo week</Button>
        </div>
      )}
      {view !== 'year' && mode === 'live' && !REPORT_FEED_ENABLED && <p role="status" className="text-sm text-muted-foreground">Automatic feeds are pending configuration.</p>}
      {view !== 'year' && mode === 'live' && REPORT_FEED_ENABLED && valid && !current && <p role="status" className="text-sm">Loading reports…</p>}
      {view !== 'year' && current?.error && <p role="alert" className="text-sm text-destructive">{current.error}</p>}
      <Tabs value={view} onValueChange={value => setView(value as string)} className="space-y-3">
        <TabsList className="max-w-full justify-start overflow-x-auto" aria-label="Reconciliation views">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="year">Year to date</TabsTrigger>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="costs">Costs</TabsTrigger>
          <TabsTrigger value="attribution">Ads &amp; attribution</TabsTrigger>
        </TabsList>
        <TabsContent value="year"><TradingYearHistory mode={mode} /></TabsContent>
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {[
              ['Shopify order IDs', valid && shopify ? shop.size : undefined],
              ['Engine order IDs', valid && engine ? engines.size : undefined],
              ['IDs in both', matched],
              ['Shopify only', matched === undefined ? undefined : shop.size - matched],
              ['Engine only', matched === undefined ? undefined : engines.size - matched],
            ].map(([label, value]) => <Card key={label}><CardContent>
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-xl font-semibold tabular-nums">{value?.toLocaleString() ?? '—'}</p>
            </CardContent></Card>)}
          </div>
          {bundle?.reports.shopifyDaily && <ShopifyReconciliationChart rows={bundle.reports.shopifyDaily.rows} />}
          <ReportTable name="shopifyDaily" bundle={bundle} />
          <p className="text-xs text-muted-foreground">Shopify groups orders by creation day in UTC. Current totals and cumulative refunds are an order snapshot. Use a transaction-date report for sales or refunds booked within the period.</p>
          {bundle?.reports.dailyPl ? <ReportTable name="dailyPl" bundle={bundle} /> : <p className="text-sm text-muted-foreground">Engine feed unavailable. Shopify coverage remains visible when its feed is ready.</p>}
        </TabsContent>
        <TabsContent value="orders" className="space-y-4">
          <ReportTable name="shopifyOrders" bundle={bundle} />
          {bundle?.reports.orderProfit && <ReportTable name="orderProfit" bundle={bundle} />}
          {engine ? <Comparisons engine={engines} reference={shop} referenceLabel="Shopify" options={shared(shopify, SALES)} ready={orderReady} /> :
            <p className="text-sm text-muted-foreground">Engine feed unavailable. Per-order differences require both feeds.</p>}
        </TabsContent>
        <TabsContent value="costs" className="space-y-4">
          <ReportTable name="fulfilment" bundle={bundle} />
          <ReportTable name="paymentFees" bundle={bundle} />
          <Comparisons engine={engines} reference={costs} referenceLabel="Independent cost" options={shared(evidence, COSTS)} ready={costReady} />
        </TabsContent>
        <TabsContent value="attribution" className="space-y-3">
          <ReportTable name="collections" bundle={bundle} />
          <ReportTable name="paidAds" bundle={bundle} />
          <Card>
            <CardHeader>
              <CardTitle>Mixed bag and glasses-case orders</CardTitle>
              <CardDescription>Counts distinct Shopify order IDs with positive units in both categories in the selected period, using BAG and GLS SKU prefixes.</CardDescription>
            </CardHeader>
            <CardContent>
              {valid && shopify ? <Table>
                <TableHeader><TableRow><TableHead>Shipping market</TableHead><TableHead className="text-right">Mixed orders</TableHead></TableRow></TableHeader>
                <TableBody>
                  {baskets.map(([market, count]) => <TableRow key={market}><TableCell>{market}</TableCell><TableCell className="text-right tabular-nums">{count.toLocaleString()}</TableCell></TableRow>)}
                  {!baskets.length && <TableRow><TableCell colSpan={2}>No mixed orders found in this period.</TableCell></TableRow>}
                </TableBody>
              </Table> : <p className="text-muted-foreground">Waiting for the Shopify order-line feed.</p>}
            </CardContent>
          </Card>
          <p className="text-sm text-muted-foreground">Campaign profitability needs Meta spend by campaign and day, a campaign-to-market/category mapping, and order attribution evidence.</p>
        </TabsContent>
      </Tabs>
    </div>
  )
}
