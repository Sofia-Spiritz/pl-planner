// A world map with one bubble per market, sized by sales. Drawn with Apache ECharts directly,
// because the chart kit has no map component. The outline file loads from a CDN on first use.
import * as echarts from 'echarts'
import { useEffect, useRef, useState } from 'react'
import { MARKETS, money } from '@/lib/data'

const GEO: Record<string, [number, number]> = { UK: [-2, 54], US: [-98, 39], AU: [134, -25] }
let worldReady: Promise<boolean> | null = null
function loadWorld() {
  if (!worldReady) {
    worldReady = fetch('https://cdn.jsdelivr.net/npm/echarts@4.9.0/map/json/world.json')
      .then((r) => { if (!r.ok) throw new Error('map'); return r.json() })
      .then((j) => { echarts.registerMap('world', j); return true })
      .catch(() => { worldReady = null; return false })
  }
  return worldReady
}
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

export type MapPoint = { market: string; sales: number; spend: number; contribution: number }

export function WorldMap({ points, dark, onPick }: { points: MapPoint[]; dark: boolean; onPick?: (market: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => { loadWorld().then((ok) => setState(ok ? 'ready' : 'failed')) }, [])

  useEffect(() => {
    if (state !== 'ready' || !ref.current) return
    const chart = echarts.init(ref.current, null, { renderer: 'svg' })
    const max = Math.max(1, ...points.map((p) => p.sales))
    chart.setOption({
      textStyle: { fontFamily: 'inherit' },
      tooltip: {
        trigger: 'item', backgroundColor: css('--popover'), borderColor: css('--border'), textStyle: { color: css('--popover-foreground'), fontSize: 12 },
        formatter: (p: any) => p.data ? `<b>${p.name}</b><br>Sales ${money(p.value[2])}<br>Ad spend ${money(p.data.spend)}<br>Contribution ${money(p.data.contribution)}` : '',
      },
      geo: { map: 'world', roam: false, silent: true, top: 6, bottom: 6, left: 0, right: 0, itemStyle: { areaColor: css('--muted'), borderColor: css('--border') } },
      series: [{
        type: 'scatter', coordinateSystem: 'geo',
        data: points.filter((p) => GEO[p.market]).map((p) => ({
          name: MARKETS[p.market] || p.market, value: [...GEO[p.market], Math.round(p.sales)], spend: p.spend, contribution: p.contribution, market: p.market,
          label: { position: GEO[p.market][0] > 60 ? 'left' : 'right' },
        })),
        symbolSize: (v: number[]) => 14 + 44 * Math.sqrt(v[2] / max),
        itemStyle: { color: '#d98a16', opacity: 0.8, borderColor: css('--card'), borderWidth: 2 },
        label: { show: true, color: css('--foreground'), fontSize: 11, fontWeight: 600, formatter: (p: any) => `${p.name}  ${money(p.value[2])}` },
      }],
    })
    chart.on('click', (p: any) => { if (p.data?.market && onPick) onPick(p.data.market) })
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(ref.current)
    return () => { ro.disconnect(); chart.dispose() }
  }, [state, points, dark, onPick])

  if (state === 'failed') return <div className="grid h-full place-items-center text-xs text-muted-foreground">The map could not load. The figures are in the table below.</div>
  return <div ref={ref} className="h-full w-full">{state === 'loading' && <div className="grid h-full place-items-center text-xs text-muted-foreground">Loading the map…</div>}</div>
}
