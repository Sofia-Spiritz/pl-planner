import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { money2 } from '@/lib/data'
import { compareOrders, COSTS, groupOrders, mixedBaskets, parseExport, SALES, type Dataset, type Metric, type Source } from '@/lib/reconciliation'

type Import = { name: string; dataset: Dataset }
const amount = (pence?: number) => pence === undefined ? '—' : money2(pence / 100)

function FileSource({ label, help, source, value, onChange }: {
  label: string; help: string; source: Source; value?: Import; onChange: (result?: Import) => void
}) {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [shopifyYear, setShopifyYear] = useState('2026')

  async function load(file: File) {
    setLoading(true)
    setError('')
    onChange(undefined)
    try {
      if (file.size > 30_000_000) throw new Error('Choose a CSV smaller than 30 MB.')
      onChange({ name: file.name, dataset: parseExport(await file.text(), source, shopifyYear) })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read this CSV.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-2">
      <label htmlFor={source} className="text-sm font-medium">{label}</label>
      <Input id={source} type="file" accept=".csv,text/csv" disabled={loading} aria-describedby={source + '-help'} onChange={event => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (file) void load(file)
      }} />
      <p id={source + '-help'} className="text-xs text-muted-foreground">{help}</p>
      {source === 'shopify' && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Year for dates without a year
          <Input className="w-20" type="number" min={1900} max={9999} value={shopifyYear} disabled={loading} onChange={event => {
            setShopifyYear(event.target.value)
            if (value) onChange(undefined)
            setError('')
          }} />
        </label>
      )}
      {loading && <p role="status" className="text-xs">Reading CSV…</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {value && (
        <div className="flex items-center gap-2 text-xs">
          <span className="min-w-0 break-all">{value.name} · {value.dataset.lines.length.toLocaleString()} rows · {value.dataset.from} to {value.dataset.to}</span>
          <Button variant="ghost" size="sm" onClick={() => onChange(undefined)}>Remove</Button>
        </div>
      )}
    </div>
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

  if (!ready) return <p className="py-4 text-muted-foreground">Load both required CSVs on Overview and select a valid date range.</p>
  if (!metric) return <p className="py-4 text-muted-foreground">The two files have no comparable amount columns for this tab.</p>

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

export function ReconciliationPage() {
  const [shopify, setShopify] = useState<Import>()
  const [engine, setEngine] = useState<Import>()
  const [evidence, setEvidence] = useState<Import>()
  const [from, setFrom] = useState('2026-11-16')
  const [to, setTo] = useState('2026-11-22')
  const valid = Boolean(from && to && from <= to)
  const shop = useMemo(() => groupOrders(shopify?.dataset, from, to), [shopify, from, to])
  const engines = useMemo(() => groupOrders(engine?.dataset, from, to), [engine, from, to])
  const costs = useMemo(() => groupOrders(evidence?.dataset, from, to), [evidence, from, to])
  const baskets = useMemo(() => mixedBaskets(shop), [shop])
  const orderReady = valid && Boolean(shopify && engine)
  const costReady = valid && Boolean(evidence && engine)
  const matched = orderReady ? [...shop.keys()].filter(id => engines.has(id)).length : undefined
  const shared = (reference: Import | undefined, fields: Partial<Record<Metric, string>>) =>
    Object.fromEntries(Object.entries(fields).filter(([k]) => engine?.dataset.columns.includes(k as Metric) && reference?.dataset.columns.includes(k as Metric)))

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <p className="text-sm text-muted-foreground">Compare source exports in this browser. Imported files are cleared when you leave Reconciliation.</p>
        <div className="flex flex-wrap gap-3">
          <label className="grid gap-1 text-xs font-medium">From<Input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
          <label className="grid gap-1 text-xs font-medium">Through<Input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
        </div>
      </div>
      {!valid && <p role="alert" className="text-sm text-destructive">Choose a start and end day in chronological order.</p>}
      <Tabs defaultValue="overview" className="space-y-3">
        <TabsList className="max-w-full justify-start overflow-x-auto" aria-label="Reconciliation views">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="costs">Costs</TabsTrigger>
          <TabsTrigger value="attribution">Ads &amp; attribution</TabsTrigger>
        </TabsList>
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
          <Card>
            <CardHeader><CardTitle>Source files</CardTitle><CardDescription>Use GBP amounts and Shopify order numbers in both exports. Dates are inclusive.</CardDescription></CardHeader>
            <CardContent className="grid gap-5 lg:grid-cols-3">
              <FileSource label="Shopify order-line CSV" source="shopify" value={shopify} onChange={setShopify} help="Use the existing Shopify sales report export with day and order_name." />
              <FileSource label="Engine order CSV" source="engine" value={engine} onChange={setEngine} help="Map to day, order_id and comparable GBP amount columns." />
              <FileSource label="Independent cost CSV" source="evidence" value={evidence} onChange={setEvidence} help="Optional. Map invoice or payment records to day, order_id and cost columns." />
            </CardContent>
          </Card>
          <details className="rounded-lg border p-3 text-sm">
            <summary className="cursor-pointer font-medium">CSV column guide</summary>
            <p className="mt-2 text-muted-foreground">For engine and cost files, use one row per order or additive order line. Use YYYY-MM-DD dates and the same Shopify order number shown in the Shopify export. Use positive costs and signed adjustments, with empty fields for unknown amounts. Do not repeat an order-level total on every line.</p>
            <div className="mt-2 break-all font-mono text-xs">{Object.keys(SALES).join(', ')}</div>
            <div className="mt-2 break-all font-mono text-xs">{Object.keys(COSTS).join(', ')}</div>
          </details>
        </TabsContent>
        <TabsContent value="orders">
          <Comparisons engine={engines} reference={shop} referenceLabel="Shopify" options={shared(shopify, SALES)} ready={orderReady} />
        </TabsContent>
        <TabsContent value="costs">
          <Comparisons engine={engines} reference={costs} referenceLabel="Independent cost" options={shared(evidence, COSTS)} ready={costReady} />
        </TabsContent>
        <TabsContent value="attribution" className="space-y-3">
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
              </Table> : <p className="text-muted-foreground">Load Shopify order lines and select a valid date range.</p>}
            </CardContent>
          </Card>
          <p className="text-sm text-muted-foreground">Campaign profitability needs Meta spend by campaign and day, a campaign-to-market/category mapping, and order attribution evidence.</p>
        </TabsContent>
      </Tabs>
    </div>
  )
}
