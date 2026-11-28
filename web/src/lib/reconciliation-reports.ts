import { sb } from '@/lib/data'
import type { Dataset } from '@/lib/reconciliation'

const REPORTS = {
  shopifyDaily: { label: 'Shopify daily order coverage', columns: [['day', 'Created (UTC)'], ['market', 'Ship-to country'], ['orders', 'Orders'], ['cancelled', 'Cancelled'], ['sales', 'Current order total'], ['tax', 'Current tax'], ['refunds', 'Total refunded']] },
  shopifyOrders: { label: 'Shopify orders', columns: [['day', 'Created (UTC)'], ['order', 'Shopify order'], ['market', 'Ship-to country'], ['status', 'Status'], ['sales', 'Current order total'], ['tax', 'Current tax'], ['refunds', 'Total refunded']] },
  orderProfit: { label: 'Order Profit', columns: [['day', 'Day'], ['order', 'Shopify order'], ['market', 'Market'], ['revenue', 'Net revenue'], ['product', 'Product cost'], ['fulfilment', 'Fulfilment'], ['fees', 'Payment fees'], ['duties', 'Duties'], ['profit', 'Order profit']] },
  dailyPl: { label: 'Daily P&L', columns: [['day', 'Day'], ['market', 'Market'], ['orders', 'Orders'], ['revenue', 'Net revenue'], ['ads', 'Ad spend'], ['contribution', 'Contribution']] },
  fulfilment: { label: '3PL Costs', columns: [['day', 'Day'], ['market', 'Market'], ['warehouse', 'Warehouse'], ['orders', 'Orders'], ['invoiced', 'Invoiced postage'], ['estimated', 'Estimated postage'], ['fulfilment', 'Total fulfilment']] },
  paymentFees: { label: 'Payment Fees by Gateway', columns: [['day', 'Day'], ['market', 'Market'], ['gateway', 'Gateway'], ['orders', 'Orders'], ['fees', 'Payment fees']] },
  collections: { label: 'Markets & Collections', columns: [['day', 'Day'], ['market', 'Market'], ['collection', 'Collection'], ['revenue', 'Net revenue'], ['profit', 'Profit before ads']] },
  paidAds: { label: 'Paid Ads Overview', columns: [['day', 'Day'], ['platform', 'Platform'], ['campaign', 'Campaign ID'], ['market', 'Mapped market'], ['collection', 'Mapped collection'], ['ads', 'Ad spend']] },
} as const
export { REPORTS }

export type ReportKey = keyof typeof REPORTS
type Row = Record<string, string | number | null>
type Report = { refreshedAt: string; rows: Row[] }
type ReportBundle = {
  from: string
  through: string
  reports: Partial<Record<ReportKey, Report>>
  engine?: Dataset
  shopify?: Dataset
  evidence?: Dataset
}

export const LOCAL_YEAR_HISTORY = import.meta.env.VITE_LOCAL_YEAR_HISTORY === 'true'
  && location.hostname === '127.0.0.1'

export const REPORT_FEED_ENABLED = import.meta.env.VITE_RECONCILIATION_REPORTS === 'true'

// The server returns only the selected reporting window. Amounts are integer GBP pence.
export async function readReports(from: string, through: string, signal: AbortSignal): Promise<ReportBundle | null> {
  if (!REPORT_FEED_ENABLED) return null
  const { data, error } = await sb.rpc('reconciliation_reports', { p_from: from, p_through: through }).abortSignal(signal)
  if (error) throw new Error('Could not refresh the reconciliation reports.')
  if (!data || data.from !== from || data.through !== through || !data.reports || typeof data.reports !== 'object') {
    throw new Error('Report data did not cover the selected request.')
  }
  return data
}

export function sampleReports(from: string, through: string): ReportBundle {
  const day = '2026-11-18'
  const refreshedAt = '2026-11-19T08:00:00Z'
  const example: Record<ReportKey, Row[]> = {
    shopifyDaily: [{ day, market: 'AU', orders: 1, cancelled: 0, sales: 14850, tax: 1350, refunds: 500 },
      { day: '2026-11-19', market: 'GB', orders: 1, cancelled: 1, sales: 0, tax: 0, refunds: 8500 }],
    shopifyOrders: [{ day, order: 'DEMO-101', market: 'AU', status: 'PARTIALLY_REFUNDED', sales: 14850, tax: 1350, refunds: 500 },
      { day: '2026-11-19', order: 'DEMO-102', market: 'GB', status: 'Cancelled', sales: 0, tax: 0, refunds: 8500 }],
    orderProfit: [{ day, order: 'DEMO-101', market: 'AU', revenue: 14900, product: 3800, fulfilment: 1300, fees: 450, duties: 0, profit: 9350 }],
    dailyPl: [{ day, market: 'AU', orders: 1, revenue: 14900, ads: 2500, contribution: 6850 }],
    fulfilment: [{ day, market: 'AU', warehouse: 'Portless', orders: 1, invoiced: 800, estimated: 0, fulfilment: 1300 }],
    paymentFees: [{ day, market: 'AU', gateway: 'Shopify Payments', orders: 1, fees: 450 }],
    collections: [{ day, market: 'AU', collection: 'Bags', revenue: 9900, profit: 6700 }, { day, market: 'AU', collection: 'Glasses cases', revenue: 5000, profit: 2650 }],
    paidAds: [{ day, platform: 'Meta', campaign: 'DEMO-CASE', market: 'AU', collection: 'Glasses cases', ads: 2500 }],
  }
  const inPeriod = from <= day && day <= through
  const reports = Object.fromEntries(Object.entries(example).map(([key, rows]) => [key, { refreshedAt, rows: rows.filter(row => typeof row.day === 'string' && from <= row.day && row.day <= through) }]))
  const line = { id: 'DEMO-101', day, market: 'AU', product: true }
  return {
    from, through, reports,
    engine: { from, to: through, columns: ['net_sales', 'postage'], lines: inPeriod ? [{ ...line, sku: '', amounts: { net_sales: 14900, postage: 800 } }] : [] },
    shopify: { from, to: through, columns: ['net_sales'], lines: [
      { ...line, sku: 'BAGA/DEMO', amounts: { net_sales: 9900 } },
      { ...line, sku: 'GLS/DEMO', amounts: { net_sales: 4950 } },
      { id: 'DEMO-102', day: '2026-11-19', market: 'GB', sku: '', product: false, amounts: { net_sales: 0 } },
    ].filter(row => from <= row.day && row.day <= through) },
    evidence: { from, to: through, columns: ['postage'], lines: inPeriod ? [{ ...line, sku: '', amounts: { postage: 800 } }] : [] },
  }
}
