export const SALES = {
  net_sales: 'Net sales',
  shipping_charges: 'Shipping income',
  taxes: 'Tax',
  total_sales: 'Total sales',
} as const

export const COSTS = {
  product_cost: 'Product cost',
  postage: 'Postage',
  pick_pack: 'Pick and pack',
  payment_fees: 'Payment fees',
  duties: 'Duties',
} as const

export type Metric = keyof typeof SALES | keyof typeof COSTS
type Amounts = Partial<Record<Metric, number>>
export type Source = 'shopify' | 'engine' | 'evidence'
type Line = { id: string; day: string; sku: string; product: boolean; market: string; amounts: Amounts }
export type Dataset = { columns: Metric[]; lines: Line[]; from: string; to: string }
type Order = { count: number; amounts: Amounts; coverage: Amounts; bags: boolean; glasses: boolean; markets: Set<string> }

// The exported Shopify file uses quoted CSV, including embedded commas and newlines.
function parseCsv(text: string) {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let closed = false
  const field = () => { row.push(cell.trim()); cell = ''; closed = false }
  const line = () => { field(); if (row.some(Boolean)) rows.push(row); row = [] }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (char === '"') { quoted = false; closed = true }
      else cell += char
    } else if (char === ',') field()
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      line()
    } else if (char === '"' && !cell && !closed) quoted = true
    else if (closed || char === '"') throw new Error('Invalid CSV quoting.')
    else cell += char
  }
  if (quoted) throw new Error('The CSV ends inside a quoted field.')
  line()
  return rows
}

const metrics = Object.keys({ ...SALES, ...COSTS }) as Metric[]

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function normalizeDay(raw: string, year?: string) {
  const old = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) (\d{1,2})$/.exec(raw)
  if (!old || !year || !/^\d{4}$/.test(year)) return raw
  const month = MONTH.indexOf(old[2]) + 1
  if (!month) return raw
  const normalized = year + '-' + String(month).padStart(2, '0') + '-' + old[3].padStart(2, '0')
  return WEEKDAY[new Date(normalized + 'T00:00:00Z').getUTCDay()] === old[1] ? normalized : raw
}

export function parseExport(text: string, source: Source, shopifyYear?: string): Dataset {
  const [head, ...rows] = parseCsv(text.replace(/^\uFEFF/, ''))
  if (!head || rows.length === 0) throw new Error('The CSV has no data rows.')
  const headers = head.map(h => h.toLowerCase())
  if (new Set(headers).size !== headers.length) throw new Error('The CSV contains duplicate headers.')
  const key = source === 'shopify' ? 'order_name' : 'order_id'
  for (const required of ['day', key]) {
    if (!headers.includes(required)) throw new Error('Missing column: ' + required)
  }
  const columns = metrics.filter(metric => headers.includes(metric) && (source !== 'evidence' || metric in COSTS))
  if (!columns.length) throw new Error('No supported amount columns found.')
  const indexes = Object.fromEntries(headers.map((name, index) => [name, index]))
  let from = '9999-12-31'
  let to = '0000-01-01'
  let present = false
  const lines = rows.map((r, index) => {
    if (r.length !== head.length) throw new Error(`CSV record ${index + 2} has the wrong number of fields.`)
    const day = normalizeDay(r[indexes.day], source === 'shopify' ? shopifyYear : undefined)
    const id = r[indexes[key]].replace(/^#/, '').trim()
    const date = new Date(day + 'T00:00:00Z')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(+date) || date.toISOString().slice(0, 10) !== day || !id) {
      throw new Error(`CSV record ${index + 2} needs an order identifier and a valid YYYY-MM-DD day.${source === 'shopify' ? ' Check the export year if dates omit it.' : ''}`)
    }
    const amounts: Amounts = {}
    for (const metric of columns) {
      const value = r[indexes[metric]]
      if (value === '') continue
      if (!/^-?\d+(?:\.\d{1,2})?$/.test(value)) throw new Error(`Invalid GBP amount in ${metric}, CSV record ${index + 2}.`)
      const [pounds, pennies = ''] = value.replace(/^-/, '').split('.')
      const amount = (Number(pounds) * 100 + Number(pennies.padEnd(2, '0'))) * (value.startsWith('-') ? -1 : 1)
      if (!Number.isSafeInteger(amount)) throw new Error(`Amount is out of range in CSV record ${index + 2}.`)
      amounts[metric] = amount
      present = true
    }
    if (day < from) from = day
    if (day > to) to = day
    return {
      day, id, amounts,
      sku: (r[indexes.sku] ?? '').toUpperCase(),
      product: r[indexes.line_type] === 'product' && Number(r[indexes.net_items_sold]) > 0,
      market: r[indexes.shipping_country] || 'Unknown',
    }
  })
  if (!present) throw new Error('The CSV amount columns are all blank.')
  return { columns, lines, from, to }
}

export function groupOrders(dataset: Dataset | undefined, from: string, to: string) {
  const orders = new Map<string, Order>()
  for (const line of dataset?.lines ?? []) {
    if (line.day < from || line.day > to) continue
    let order = orders.get(line.id)
    if (!order) {
      order = { count: 0, amounts: {}, coverage: {}, bags: false, glasses: false, markets: new Set() }
      orders.set(line.id, order)
    }
    order.count++
    for (const metric of dataset.columns) {
      const amount = line.amounts[metric]
      if (amount === undefined) continue
      order.coverage[metric] = (order.coverage[metric] ?? 0) + 1
      order.amounts[metric] = (order.amounts[metric] ?? 0) + amount
    }
    if (line.product) {
      order.bags ||= /^BAG/.test(line.sku)
      order.glasses ||= /^GLS/.test(line.sku)
      order.markets.add(line.market)
    }
  }
  return orders
}

export function compareOrders(engine: Map<string, Order>, reference: Map<string, Order>, metric: Metric) {
  return [...new Set([...engine.keys(), ...reference.keys()])].map(id => {
    const left = engine.get(id)
    const right = reference.get(id)
    const a = left && left.coverage[metric] === left.count ? left.amounts[metric] : undefined
    const b = right && right.coverage[metric] === right.count ? right.amounts[metric] : undefined
    const delta = a !== undefined && b !== undefined ? a - b : undefined
    const status = !left ? 'Source only' : !right ? 'Engine only' : delta === undefined ? 'Missing amount' : delta === 0 ? 'Match' : 'Difference'
    return { id, engine: a, reference: b, delta, status }
  })
}

export function mixedBaskets(orders: Map<string, Order>) {
  const byMarket = new Map<string, number>()
  for (const order of orders.values()) {
    if (!order.bags || !order.glasses) continue
    const market = order.markets.size === 1 ? [...order.markets][0] : 'Multiple destinations'
    byMarket.set(market, (byMarket.get(market) ?? 0) + 1)
  }
  return [...byMarket].sort(([a], [b]) => a.localeCompare(b))
}
