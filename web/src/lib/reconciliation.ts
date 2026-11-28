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
type Line = { id: string; day: string; sku: string; product: boolean; market: string; amounts: Amounts }
export type Dataset = { columns: Metric[]; lines: Line[]; from: string; to: string }
type Order = { count: number; amounts: Amounts; coverage: Amounts; bags: boolean; glasses: boolean; markets: Set<string> }

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
