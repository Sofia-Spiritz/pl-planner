// The app shell: sign-in or demo first, then a side menu with Sheets, Marketing funnel and Data notes.
import { useCallback, useEffect, useState } from 'react'
import { BookOpen, LogOut, Moon, Sheet as SheetIcon, Sun, TrendingUp } from 'lucide-react'
import { Ring } from 'loading-dev'
import { toast } from 'sonner'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarInset, SidebarMenu,
  SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger,
} from '@/components/ui/sidebar'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { demo, live, sb, type Provider } from '@/lib/data'
import { FunnelPage } from '@/pages/Funnel'
import { NotesPage } from '@/pages/Notes'
import { SheetsPage } from '@/pages/Sheets'
import { SignInPage } from '@/pages/SignIn'

type Page = 'sheets' | 'funnel' | 'notes'
const PAGES: { id: Page; label: string; icon: typeof SheetIcon }[] = [
  { id: 'sheets', label: 'Sheets', icon: SheetIcon },
  { id: 'funnel', label: 'Marketing funnel', icon: TrendingUp },
  { id: 'notes', label: 'Data notes', icon: BookOpen },
]
const pageFromHash = (): Page => {
  const h = location.hash.replace('#', '')
  return PAGES.some((p) => p.id === h) ? (h as Page) : 'sheets'
}

// Light or dark, remembered in this browser only.
function readTheme() {
  try { return localStorage.getItem('pl-theme') === 'dark' } catch { return false }
}

export default function App() {
  const [provider, setProvider] = useState<Provider | null>(null)
  const [checking, setChecking] = useState(true)
  const [page, setPage] = useState<Page>(pageFromHash)
  const [dark, setDark] = useState(readTheme)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    try { localStorage.setItem('pl-theme', dark ? 'dark' : 'light') } catch { /* private window */ }
  }, [dark])

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => {
      if (data.session) setProvider(live)
      setChecking(false)
    }).catch(() => setChecking(false))
  }, [])

  useEffect(() => {
    const onHash = () => setPage(pageFromHash())
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [])

  const go = useCallback((p: Page) => { location.hash = p; setPage(p) }, [])

  async function leave() {
    if (provider?.mode === 'live') await sb.auth.signOut()
    setProvider(null)
    toast(provider?.mode === 'live' ? 'Signed out' : 'Left the demo')
  }

  let body
  if (checking) body = <div className="grid min-h-svh place-items-center"><Ring size={32} /></div>
  else if (!provider) body = (
    <SignInPage
      onSignedIn={() => { setProvider(live); go('sheets'); toast.success('Signed in') }}
      onDemo={() => { setProvider(demo()); go('sheets') }}
    />
  )
  else {
    const current = PAGES.find((p) => p.id === page)!
    body = (
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarHeader className="px-4 py-4 group-data-[collapsible=icon]:px-2">
            <div className="text-[10px] font-semibold tracking-widest uppercase opacity-70 group-data-[collapsible=icon]:hidden">Sofia &amp; Spiritz</div>
            <div className="text-lg font-bold group-data-[collapsible=icon]:hidden">P&amp;L Planner</div>
            <div className="hidden text-sm font-bold group-data-[collapsible=icon]:block">PL</div>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarMenu>
                {PAGES.map((p) => (
                  <SidebarMenuItem key={p.id}>
                    <SidebarMenuButton isActive={page === p.id} tooltip={p.label} onClick={() => go(p.id)}>
                      <p.icon /><span>{p.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip={dark ? 'Light mode' : 'Dark mode'} onClick={() => setDark(!dark)}>
                  {dark ? <Sun /> : <Moon />}<span>{dark ? 'Light mode' : 'Dark mode'}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip={provider.mode === 'live' ? 'Sign out' : 'Leave demo'} onClick={leave}>
                  <LogOut /><span>{provider.mode === 'live' ? 'Sign out' : 'Leave demo'}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset>
          <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur">
            <SidebarTrigger />
            <Separator orientation="vertical" className="mx-1 h-5" />
            <h1 className="text-base font-semibold">{current.label}</h1>
            {provider.mode === 'demo' && <Badge variant="secondary" className="ml-auto bg-amber-100 text-amber-800">Demo · sample data</Badge>}
          </header>
          <div className="min-w-0 p-4 md:p-6">
            {page === 'sheets' && <SheetsPage provider={provider} />}
            {page === 'funnel' && <FunnelPage provider={provider} dark={dark} />}
            {page === 'notes' && <NotesPage provider={provider} />}
          </div>
        </SidebarInset>
      </SidebarProvider>
    )
  }

  return (
    <TooltipProvider>
      {body}
      <Toaster theme={dark ? 'dark' : 'light'} position="bottom-right" />
    </TooltipProvider>
  )
}
