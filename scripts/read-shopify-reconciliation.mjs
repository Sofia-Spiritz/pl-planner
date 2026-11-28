// Read-only Shopify snapshot grouped by order creation day (UTC).
// Requires SHOPIFY_RECON_STORE and SHOPIFY_RECON_TOKEN in the server environment.
import { pathToFileURL } from 'node:url'

const SHOPIFY_API_VERSION = '2026-10'
const MONEY = 'shopMoney { amount currencyCode }'
const ITEMS = 'nodes { sku currentQuantity } pageInfo { hasNextPage endCursor }'
const ORDERS = `query ReconciliationOrders($search: String!, $after: String) {
  orders(first: 50, query: $search, after: $after, sortKey: CREATED_AT) {
    nodes {
      id name createdAt cancelledAt test displayFinancialStatus
      shippingAddress { countryCodeV2 }
      currentTotalPriceSet { ${MONEY} }
      currentTotalTaxSet { ${MONEY} }
      totalRefundedSet { ${MONEY} }
      lineItems(first: 10) { ${ITEMS} }
    }
    pageInfo { hasNextPage endCursor }
  }
}`
const MORE_ITEMS = `query ReconciliationItems($id: ID!, $after: String!) {
  node(id: $id) { ... on Order { lineItems(first: 100, after: $after) { ${ITEMS} } } }
}`
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function utcDay(value) {
  const date = new Date(value + 'T00:00:00Z')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(+date) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('Dates must be valid YYYY-MM-DD days.')
  }
  return date
}

function pence(set) {
  const { amount, currencyCode } = set?.shopMoney ?? {}
  if (currencyCode !== 'GBP' || !/^-?\d+(?:\.\d{1,2})?$/.test(amount)) {
    throw new Error('Shopify returned a missing or non-GBP amount.')
  }
  const [whole, fraction = ''] = amount.replace(/^-/, '').split('.')
  const result = (Number(whole) * 100 + Number(fraction.padEnd(2, '0'))) * (amount.startsWith('-') ? -1 : 1)
  if (!Number.isSafeInteger(result)) throw new Error('Shopify returned an out-of-range amount.')
  return result
}

function nextPage(connection, seen) {
  if (!Array.isArray(connection?.nodes) || typeof connection?.pageInfo?.hasNextPage !== 'boolean') {
    throw new Error('Shopify returned an incomplete result page.')
  }
  if (!connection.pageInfo.hasNextPage) return null
  const { endCursor } = connection.pageInfo
  if (!endCursor || seen.has(endCursor)) throw new Error('Shopify did not advance pagination.')
  seen.add(endCursor)
  return endCursor
}

export async function readShopifyReconciliation({ store, token, from, through, fetcher = fetch, pause = wait }) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(store ?? '') || !token) {
    throw new Error('An approved Shopify store and read-only access token are required.')
  }
  const firstDay = utcDay(from)
  const end = utcDay(through)
  if (end < firstDay || end - firstDay >= 31 * 864e5) throw new Error('Choose a range of 1 to 31 days.')
  end.setUTCDate(end.getUTCDate() + 1)
  const search = `created_at:>='${firstDay.toISOString()}' created_at:<'${end.toISOString()}'`
  const url = `https://${store}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`

  async function query(document, variables) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetcher(url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query: document, variables }),
        signal: AbortSignal.timeout(30000),
      })
      const data = response.ok ? await response.json() : null
      if (response.status === 429 || response.status >= 500 || data?.errors?.some(error => error.extensions?.code === 'THROTTLED')) {
        if (attempt < 3) {
          const retry = Number(response.headers.get('Retry-After'))
          await pause(Math.max(Math.min(retry * 1000 || 0, 30000), 1000 * 2 ** attempt))
          continue
        }
        throw new Error('Shopify remained unavailable after retries.')
      }
      if (!response.ok || data?.errors?.length || !data?.data) throw new Error(`Shopify rejected the read request (HTTP ${response.status}).`)
      return data.data
    }
  }

  const orders = [], lines = [], byDay = new Map(), orderIds = new Set(), orderCursors = new Set()
  let after = null
  do {
    const { orders: page } = await query(ORDERS, { search, after })
    after = nextPage(page, orderCursors)
    for (const order of page.nodes) {
      if (order.test) continue
      const day = new Date(order.createdAt).toISOString().slice(0, 10)
      const market = order.shippingAddress?.countryCodeV2 ?? 'Unknown'
      if (day < from || day > through || !order.id || !order.name || orderIds.has(order.id)) {
        throw new Error('Shopify returned an unexpected or duplicate order.')
      }
      orderIds.add(order.id)
      const sales = pence(order.currentTotalPriceSet)
      const tax = pence(order.currentTotalTaxSet)
      const refunds = pence(order.totalRefundedSet)
      const cancelled = Boolean(order.cancelledAt)
      orders.push({ day, order: order.name, orderId: order.id, market, sales, tax, refunds, status: cancelled ? 'Cancelled' : order.displayFinancialStatus ?? 'Unknown' })
      const key = day + '|' + market
      const total = byDay.get(key) ?? { day, market, orders: 0, cancelled: 0, sales: 0, tax: 0, refunds: 0 }
      total.orders++
      total.cancelled += Number(cancelled)
      total.sales += sales
      total.tax += tax
      total.refunds += refunds
      byDay.set(key, total)
      // One row preserves the order ID even if all lines were removed.
      lines.push({ id: order.id, day, market, sku: '', product: false, amounts: {} })
      if (cancelled) continue
      let items = order.lineItems
      const itemCursors = new Set()
      for (;;) {
        const cursor = nextPage(items, itemCursors)
        for (const item of items.nodes) {
          if (item.currentQuantity > 0 && item.sku) {
            lines.push({ id: order.id, day, market, sku: item.sku.toUpperCase(), product: true, amounts: {} })
          }
        }
        if (!cursor) break
        const { node } = await query(MORE_ITEMS, { id: order.id, after: cursor })
        items = node?.lineItems
      }
    }
  } while (after)

  const refreshedAt = new Date().toISOString()
  return {
    from, through,
    reports: {
      shopifyDaily: { refreshedAt, rows: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day) || a.market.localeCompare(b.market)) },
      shopifyOrders: { refreshedAt, rows: orders },
    },
    // Shopify's current order totals are not equivalent to period-ledger measures.
    shopify: { from, to: through, columns: [], lines },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [from, through] = process.argv.slice(2)
  try {
    const bundle = await readShopifyReconciliation({
      store: process.env.SHOPIFY_RECON_STORE, token: process.env.SHOPIFY_RECON_TOKEN, from, through,
    })
    process.stdout.write(JSON.stringify(bundle) + '\n')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
