// Data notes: what is real, how the figures are defined, and when the sheets last synced.
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { Provider, SyncRow } from '@/lib/data'

export function NotesPage({ provider }: { provider: Provider }) {
  const [sync, setSync] = useState<SyncRow[]>([])
  useEffect(() => { provider.sync().then(setSync) }, [provider])
  const live = provider.mode === 'live'

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardHeader><CardTitle>What you are looking at</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {live
            ? <p><Badge className="mr-2">Real data</Badge>The Sheets and Marketing funnel pages show copies of the client’s own Google Sheets. They are copied on a schedule, so a change in a sheet appears here after the next copy, not instantly.</p>
            : <p><Badge variant="secondary" className="mr-2 bg-amber-100 text-amber-800">Sample data</Badge>Everything in this demo is invented so the layout can be shown. Nothing here comes from the client’s systems.</p>}
          <p>Nothing on this dashboard edits the client’s sheets. It only reads copies.</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>How the funnel figures are defined</CardTitle></CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1.5 pl-5 text-sm">
            <li><b>Shopify sales</b> include VAT, as the sheet reports them.</li>
            <li><b>Net revenue</b> excludes VAT.</li>
            <li><b>Contribution after ads</b> is the sheet’s own figure: what is left after product, fulfilment and ad costs.</li>
            <li><b>Blended ROAS</b> is Shopify sales divided by total ad spend. <b>New-customer ROAS</b> uses new-customer sales.</li>
            <li><b>App and software costs</b> are only that; they are not all overheads.</li>
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Getting around</CardTitle></CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1.5 pl-5 text-sm">
            <li>On Sheets, the row of stages (Suppliers to Forecasts) narrows the list to that stage. The search box matches sheet names and tab names.</li>
            <li>On Marketing funnel, select a market on the map, in the margin panel or in the table to filter the page to it. Select it again to clear.</li>
            <li>The switch at the bottom of the side menu changes between light and dark.</li>
          </ul>
        </CardContent>
      </Card>
      {sync.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Live sheet links</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Sheet</TableHead><TableHead>Tab</TableHead><TableHead className="text-right">Rows</TableHead><TableHead>Last synced</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>
                {sync.map((s) => (
                  <TableRow key={s.name}>
                    <TableCell>{s.name}</TableCell><TableCell>{s.tab}</TableCell><TableCell className="text-right tabular-nums">{s.rows}</TableCell>
                    <TableCell>{s.last_ok ? new Date(s.last_ok).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'}</TableCell>
                    <TableCell>{s.last_status === 'error' ? 'Problem: ' + (s.last_message || '') : s.last_status || 'waiting'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
