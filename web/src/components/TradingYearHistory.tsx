import { useEffect, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { EChartsComposedChart as Chart } from '@/components/evilcharts/charts/echarts-composed-chart'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { money, money2, sb } from '@/lib/data'
import { LOCAL_YEAR_HISTORY } from '@/lib/reconciliation-reports'

const FROM = '2026-01-01'
const THROUGH = '2026-11-28'

const SERIES = {
  shopify_sales: { label: 'Shopify sales', colors: { light: ['#087d87'] } },
  net_revenue: { label: 'Net revenue', colors: { light: ['#4f7fe0'] } },
  ad_spend: { label: 'Ad spend', colors: { light: ['#bf6b26'] } },
  contribution: { label: 'Contribution after ads', colors: { light: ['#a9447d'] } },
}
type Metric = keyof typeof SERIES
const FIELDS = Object.keys(SERIES) as Metric[]
type MonthlyRow = { month: string; market: string; segment: string } & Record<Metric, number | null>
type History = { monthly: MonthlyRow[]; dailyThrough?: string; exportedAt?: string }

function formatMonth(day: string) {
  return new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(day + 'T00:00:00Z'))
}

async function readHistory(mode: 'demo' | 'live', signal: AbortSignal): Promise<History> {
  if (mode === 'demo') {
    const result = await fetch('./year-history-2026.json', { signal, cache: 'no-store' })
    if (!result.ok) throw new Error('Local year-to-date snapshot is unavailable.')
    return result.json()
  }
  const { data, error } = await sb.rpc('funnel_data', { p_from: FROM, p_to: THROUGH }).abortSignal(signal)
  if (error || !Array.isArray(data?.monthly)) throw new Error('Year-to-date figures are unavailable for this account.')
  return { monthly: data.monthly, dailyThrough: data.meta?.max, exportedAt: data.meta?.exported_at }
}

export function TradingYearHistory({ mode }: { mode: 'demo' | 'live' }) {
  const [result, setResult] = useState<{ history?: History; error?: string }>()
  const [market, setMarket] = useState('All markets')
  const [segment, setSegment] = useState('All products')
  const [selectedMonth, setSelectedMonth] = useState<string>()
  const reducedMotion = useReducedMotion()
  const canRead = mode === 'live' || LOCAL_YEAR_HISTORY

  useEffect(() => {
    if (!canRead) return
    const controller = new AbortController()
    readHistory(mode, controller.signal).then(history => {
      if (!controller.signal.aborted) {
        setResult(Array.isArray(history?.monthly) ? { history } : { error: 'The year-to-date snapshot is invalid.' })
      }
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ error: error instanceof Error ? error.message : 'Could not read year-to-date figures.' })
    })
    return () => controller.abort()
  }, [canRead, mode])

  if (!canRead) return <p className="text-sm text-muted-foreground">Sign in to see the client’s actual year-to-date figures.</p>
  if (!result) return <p role="status" className="text-sm text-muted-foreground">Loading year-to-date figures…</p>
  if (!result.history) return <p role="alert" className="text-sm text-destructive">{result.error}</p>

  const { monthly, dailyThrough, exportedAt } = result.history
  const markets = [...new Set(monthly.map(row => row.market))]
  const marketRows = monthly.filter(row => row.market === market)
  const segments = [...new Set(marketRows.map(row => row.segment))]
  const activeSegment = segments.includes(segment) ? segment : segments[0]
  const rows = marketRows.filter(row => row.segment === activeSegment).sort((a, b) => a.month.localeCompare(b.month))
  const chartData = rows.map(row => ({ ...row, label: formatMonth(row.month) }))
  const monthRows = monthly.filter(row => row.month === selectedMonth)
  const focusedRows = market === 'All markets'
    ? monthRows.filter(row => row.market !== 'All markets' && row.segment === activeSegment)
    : monthRows.filter(row => row.market === market && (activeSegment === 'All products' ? row.segment !== 'All products' : row.segment === activeSegment))
  const detail = focusedRows.length ? focusedRows : monthRows.filter(row => row.market === market && row.segment === activeSegment)
  const coverage = rows.length ? formatMonth(rows[0].month) + ' – ' + formatMonth(rows.at(-1).month) : 'No covered months'

  return (
    <Card>
      <CardHeader>
        <CardTitle>2026 trading history</CardTitle>
        <CardDescription>Actual monthly figures from the Daily Funnel Sheet in GBP. {coverage}. November is month to date.</CardDescription>
        <p className="text-xs text-muted-foreground">
          {exportedAt ? 'Source snapshot ' + exportedAt.slice(0, 10) + '. ' : ''}
          {dailyThrough ? 'Daily funnel coverage ends ' + dailyThrough + '. ' : ''}
          Order-level reconciliation uses a separate feed.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-3">
          <label className="grid gap-1 text-sm">Trading market
            <select className="h-8 rounded-lg border bg-background px-2" value={market} onChange={event => setMarket(event.target.value)}>
              {markets.map(value => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">Product segment
            <select className="h-8 rounded-lg border bg-background px-2" value={activeSegment} onChange={event => setSegment(event.target.value)}>
              {segments.map(value => <option key={value}>{value}</option>)}
            </select>
          </label>
        </div>
        {!!chartData.length && <p className="text-xs text-muted-foreground">Select a chart point or a month in the table to see the underlying market and product rows.</p>}
        {!!chartData.length && <div role="group" aria-label="Year-to-date trading chart">
          <Chart key={market + '/' + activeSegment} data={chartData} config={SERIES} xDataKey="label" className="h-[360px] w-full" animation={!reducedMotion}
            onPointClick={label => setSelectedMonth(chartData.find(row => row.label === label)?.month)}>
            <Chart.Grid /><Chart.XAxis tickFormatter={label => label.slice(0, 3)} />
            <Chart.YAxis tickFormatter={money} /><Chart.Tooltip /><Chart.Legend verticalAlign="top" isClickable />
            <Chart.Bar dataKey="shopify_sales" isClickable />
            <Chart.Line dataKey="net_revenue" isClickable><Chart.Dot /></Chart.Line>
            <Chart.Line dataKey="ad_spend" isClickable><Chart.Dot /></Chart.Line>
            <Chart.Line dataKey="contribution" isClickable><Chart.Dot /></Chart.Line>
            {chartData.length > 1 && <Chart.Brush height={34} />}
          </Chart>
        </div>}
        <Table>
          <TableHeader><TableRow><TableHead>Month</TableHead>
            {FIELDS.map(key => <TableHead className="text-right" key={key}>{SERIES[key].label}</TableHead>)}
          </TableRow></TableHeader>
          <TableBody>
            {chartData.map(row => <TableRow key={row.month}><TableCell><Button size="sm" variant="ghost" onClick={() => setSelectedMonth(row.month)}>{row.label}</Button></TableCell>
              {FIELDS.map(key => <TableCell key={key} className="text-right tabular-nums">{row[key] == null ? '—' : money2(row[key])}</TableCell>)}
            </TableRow>)}
            {!rows.length && <TableRow><TableCell colSpan={5}>No monthly rows for this selection.</TableCell></TableRow>}
          </TableBody>
        </Table>
        <Dialog open={Boolean(selectedMonth)} onOpenChange={open => { if (!open) setSelectedMonth(undefined) }}>
          <DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-4xl">
            <DialogHeader>
              <DialogTitle>{selectedMonth ? formatMonth(selectedMonth) + ' breakdown' : 'Monthly breakdown'}</DialogTitle>
              <DialogDescription>Daily Funnel Sheet · {market} · {activeSegment}. These are monthly figures.</DialogDescription>
            </DialogHeader>
            <Table>
              <TableHeader><TableRow><TableHead>Market</TableHead><TableHead>Product segment</TableHead>
                {FIELDS.map(key => <TableHead className="text-right" key={key}>{SERIES[key].label}</TableHead>)}
              </TableRow></TableHeader>
              <TableBody>
                {detail.map(row => <TableRow key={row.market + '/' + row.segment}>
                  <TableCell>{row.market}</TableCell><TableCell>{row.segment}</TableCell>
                  {FIELDS.map(key => <TableCell key={key} className="text-right tabular-nums">{row[key] == null ? '—' : money2(row[key])}</TableCell>)}
                </TableRow>)}
                {!detail.length && <TableRow><TableCell colSpan={6}>No source rows for this selection.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}
