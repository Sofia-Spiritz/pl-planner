import { useMemo, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { EChartsComposedChart as Chart } from '@/components/evilcharts/charts/echarts-composed-chart'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { money } from '@/lib/data'

type DailyRow = Record<string, string | number | null>
const SERIES = {
  orders: { label: 'Orders', colors: { light: ['#087d87'] } },
  cancelled: { label: 'Cancelled', colors: { light: ['#bf6b26'] } },
  sales: { label: 'Current order total', colors: { light: ['#087d87'] } },
  tax: { label: 'Current tax', colors: { light: ['#4f7fe0'] } },
  refunds: { label: 'Total refunded', colors: { light: ['#bf6b26'] } },
}
const FIELDS = Object.keys(SERIES) as (keyof typeof SERIES)[]

export function ShopifyReconciliationChart({ rows }: { rows: DailyRow[] }) {
  const [measure, setMeasure] = useState('orders')
  const [country, setCountry] = useState('')
  const reducedMotion = useReducedMotion()
  const countries = useMemo(() => [...new Set(rows.map(row => String(row.market ?? 'Unknown')))].sort(), [rows])
  const market = countries.includes(country) ? country : ''
  const points = useMemo(() => {
    const byDay = new Map<string, Record<keyof typeof SERIES, number | null>>()
    for (const row of rows) {
      if (typeof row.day !== 'string' || (market && String(row.market ?? 'Unknown') !== market)) continue
      const start = byDay.get(row.day) ?? { orders: 0, cancelled: 0, sales: 0, tax: 0, refunds: 0 }
      for (const field of FIELDS) {
        const value = row[field]
        start[field] = start[field] === null || typeof value !== 'number' ? null : start[field] + value
      }
      byDay.set(row.day, start)
    }
    return [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, totals]) => ({
      day, ...totals,
      sales: totals.sales === null ? null : totals.sales / 100,
      tax: totals.tax === null ? null : totals.tax / 100,
      refunds: totals.refunds === null ? null : totals.refunds / 100,
    }))
  }, [rows, market])

  if (!points.length) return null

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>Shopify activity by day</CardTitle>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            Ship-to country
            <select className="h-8 rounded-lg border bg-background px-2" value={market} onChange={event => setCountry(event.target.value)}>
              <option value="">All countries</option>
              {countries.map(code => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
          <Tabs value={measure} onValueChange={value => setMeasure(value as string)}>
            <TabsList aria-label="Chart measure">
              <TabsTrigger value="orders">Order counts</TabsTrigger>
              <TabsTrigger value="amounts">Amounts in GBP</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent>
        <div role="group" aria-label="Shopify daily chart">
          <Chart key={measure + market} data={points} config={SERIES} xDataKey="day" className="h-[320px] w-full" animation={!reducedMotion}>
            <Chart.Grid />
            <Chart.XAxis tickFormatter={day => day.slice(5)} />
            <Chart.YAxis tickFormatter={value => measure === 'orders' ? value.toLocaleString('en-GB') : money(value)} />
            <Chart.Tooltip />
            <Chart.Legend verticalAlign="top" isClickable />
            {measure === 'orders' && <Chart.Bar dataKey="orders" isClickable />}
            {measure === 'orders' && <Chart.Bar dataKey="cancelled" isClickable />}
            {measure === 'amounts' && <Chart.Bar dataKey="sales" isClickable />}
            {measure === 'amounts' && <Chart.Line dataKey="tax" isClickable><Chart.Dot /></Chart.Line>}
            {measure === 'amounts' && <Chart.Line dataKey="refunds" isClickable><Chart.Dot /></Chart.Line>}
            {points.length > 1 && <Chart.Brush height={34} />}
          </Chart>
        </div>
      </CardContent>
    </Card>
  )
}
