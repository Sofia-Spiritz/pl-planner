// Sheets: read-only copies of the client's sheets, grouped by supply-chain stage, shown tab by tab.
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { Ring } from 'loading-dev'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { Provider, SnapTab } from '@/lib/data'

// Which group a sheet belongs to, judged from its name. First match wins.
const GROUPS: [string, RegExp][] = [
  ['Start here', /^a guide/i],
  ['Forecasts', /forecast/i],
  ['Purchase orders', /^order \d|^hql-|\bpo \d|order sheet|allocation of po|template orders/i],
  ['Suppliers', /supplier|lead-time|pricing compare/i],
  ['Finance and margins', /p&l|margin|financ|funnel/i],
  ['Stock and supply', /stock|supply|resuppl|inventory|loading plan|reorder/i],
  ['Shipping and tariffs', /shipping|tariff|freight|rates|routing|air ship/i],
]
const groupOf = (name: string) => GROUPS.find(([, re]) => re.test(name))?.[0] ?? 'Other'
const FLOW = ['Suppliers', 'Purchase orders', 'Stock and supply', 'Shipping and tariffs', 'Finance and margins', 'Forecasts']
const isNum = (c: string) => /^[\s(\-−]*[£$€]?\s*[\d,]+(\.\d+)?\s*(%|x)?\)?$/.test(c) && /\d/.test(c)
type NavSheet = { name: string; first: number; hit: boolean; tabHit?: SnapTab }

export function SheetsPage({ provider }: { provider: Provider }) {
  const [list, setList] = useState<SnapTab[] | null>(null)
  const [id, setId] = useState<number | null>(null)
  const [rows, setRows] = useState<string[][] | null>(null)
  const [find, setFind] = useState('')
  const [inTab, setInTab] = useState('')
  const [stage, setStage] = useState('')
  const [closed, setClosed] = useState<Record<string, boolean>>({})

  useEffect(() => { provider.snapList().then((l) => { setList(l); if (l.length) setId(l[0].id) }) }, [provider])
  useEffect(() => {
    if (id == null) return
    let live = true
    setRows(null); setInTab('')
    provider.snapTab(id).then((r) => { if (live) setRows(r) }).catch(() => { if (live) setRows([]) })
    return () => { live = false }
  }, [provider, id])

  const cur = list?.find((t) => t.id === id) ?? list?.[0]
  const nav = useMemo(() => {
    const sheets = new Map<string, NavSheet>()
    const needle = find.trim().toLowerCase()
    for (const t of list ?? []) {
      let s = sheets.get(t.sheet)
      if (!s) { s = { name: t.sheet, first: t.id, hit: !needle || t.sheet.toLowerCase().includes(needle) }; sheets.set(t.sheet, s) }
      if (needle && !s.hit && !s.tabHit && t.tab.toLowerCase().includes(needle)) s.tabHit = t
    }
    const counts: Record<string, number> = {}
    const groups: Record<string, NavSheet[]> = {}
    for (const s of sheets.values()) {
      const g = groupOf(s.name)
      counts[g] = (counts[g] || 0) + 1
      if (s.hit || s.tabHit) (groups[g] ||= []).push(s)
    }
    for (const g of Object.keys(groups)) groups[g].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
    const order = [...GROUPS.map(([g]) => g), 'Other'].filter((g) => groups[g] && (needle || !stage || g === stage))
    return { counts, groups, order, total: sheets.size, needle }
  }, [list, find, stage])

  if (!list) return <div className="grid h-64 place-items-center"><Ring size={28} /></div>
  if (!list.length || !cur) return <Card><CardContent className="text-sm text-muted-foreground">No sheets have been copied in yet.</CardContent></Card>

  const tabs = list.filter((t) => t.sheet === cur.sheet)
  const needle2 = inTab.trim().toLowerCase()
  const width = rows?.reduce((m, r) => Math.max(m, r.length), 0) ?? 0
  const shown = rows?.filter((r) => !needle2 || r.join(' ').toLowerCase().includes(needle2)) ?? []
  const when = cur.copied_at ? new Date(cur.copied_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {when ? <><Badge className="mr-2">Real data</Badge>A read-only copy of the client’s sheet, taken {when}. Nothing here changes the sheet.</>
          : <><Badge variant="secondary" className="mr-2 bg-amber-100 text-amber-800">Sample data</Badge>Invented content for the demo. Signed in, this page shows copies of the real sheets.</>}
      </p>

      {/* The stages a product moves through. Each one narrows the list to its sheets. */}
      <div className="flex overflow-x-auto rounded-xl border bg-card shadow-xs">
        {FLOW.map((g, i) => (
          <button key={g} type="button" aria-pressed={stage === g} onClick={() => { setStage(stage === g ? '' : g); setFind('') }}
            className={cn('min-w-36 flex-1 cursor-pointer px-5 py-3 text-left transition-colors', i > 0 && 'border-l',
              stage === g ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}>
            <span className="block text-xl font-bold tabular-nums">{nav.counts[g] || 0}</span>
            <span className={cn('block text-[11px] font-semibold tracking-wider uppercase', stage === g ? 'opacity-90' : 'text-muted-foreground')}>{g}</span>
          </button>
        ))}
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <Card className="gap-3 py-4 lg:sticky lg:top-4">
          <CardContent className="space-y-3 px-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-8" type="search" placeholder={`Search ${nav.total} sheets and their tabs`} aria-label="Search sheets and tabs" value={find} onChange={(e) => setFind(e.target.value)} />
            </div>
            <div className="max-h-[60vh] overflow-y-auto pr-1">
              {nav.order.length === 0 && <p className="px-2 text-xs text-muted-foreground">No sheet or tab name matches “{find}”.</p>}
              {nav.order.map((g) => {
                const isClosed = !nav.needle && closed[g] && groupOf(cur.sheet) !== g
                return (
                  <div key={g} className="mb-2">
                    <button type="button" aria-expanded={!isClosed} onClick={() => setClosed({ ...closed, [g]: !closed[g] })}
                      className="flex w-full cursor-pointer items-center gap-1 px-1 py-1 text-[11px] font-bold tracking-wider text-muted-foreground uppercase hover:text-foreground">
                      {isClosed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}{g}<span className="ml-1 font-normal">{nav.groups[g].length}</span>
                    </button>
                    {!isClosed && nav.groups[g].map((s) => (
                      <button key={s.name} type="button" title={s.name} onClick={() => setId(s.tabHit ? s.tabHit.id : s.first)}
                        className={cn('block w-full cursor-pointer truncate rounded-md px-3 py-1.5 text-left text-[13px] hover:bg-muted', s.name === cur.sheet && 'bg-primary/10 font-semibold text-primary')}>
                        {s.name}{s.tabHit && <span className="text-xs text-muted-foreground"> › {s.tabHit.tab}</span>}
                      </button>
                    ))}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="min-w-0 truncate">{cur.sheet}</CardTitle>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">{cur.rows.toLocaleString('en-GB')} rows · {cur.cols} columns</span>
              <Input className="w-44" type="search" placeholder="Find in this tab" aria-label="Find in this tab" value={inTab} onChange={(e) => setInTab(e.target.value)} />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {tabs.map((t) => <Button key={t.id} size="sm" variant={t.id === cur.id ? 'default' : 'secondary'} className="rounded-full" onClick={() => setId(t.id)}>{t.tab}</Button>)}
            </div>
            {!rows ? <div className="grid h-40 place-items-center"><Ring size={24} /></div>
              : !shown.length ? <p className="text-sm text-muted-foreground">{needle2 ? `Nothing in this tab matches “${inTab}”.` : 'This tab is empty.'}</p>
              : (
                <div className="max-h-[68vh] overflow-auto rounded-lg border">
                  <table className="min-w-full border-collapse text-[12.5px]">
                    <tbody>
                      {shown.map((r, i) => {
                        const filled = r.filter((c) => c !== '').length
                        if (!r.length) return <tr key={i}><td colSpan={width} className="h-2.5" /></tr>
                        if (filled === 1 && r[0] !== '') return <tr key={i} className="border-t bg-muted/60"><td colSpan={width} className="px-3 py-2 font-bold">{r[0]}</td></tr>
                        return (
                          <tr key={i} className="border-t hover:bg-muted/50">
                            {Array.from({ length: width }, (_, j) => { const c = r[j] ?? ''; return (
                              <td key={j} className={cn('max-w-[460px] px-3 py-1.5 align-top', j === 0 && 'sticky left-0 min-w-44 bg-card font-medium', isNum(c) ? 'text-right whitespace-nowrap tabular-nums' : 'break-words')}>{c}</td>
                            ) })}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
