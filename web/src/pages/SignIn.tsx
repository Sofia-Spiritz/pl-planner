// Sign-in screen, with a way into the demo that needs no account.
import { useState, type FormEvent } from 'react'
import { Ring } from 'loading-dev'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { sb } from '@/lib/data'

export function SignInPage({ onSignedIn, onDemo }: { onSignedIn: (email: string) => void; onDemo: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setMessage('')
    const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password })
    setBusy(false)
    if (error) { setMessage('Sign-in failed: ' + error.message); return }
    setPassword('')
    onSignedIn(data.user?.email ?? email.trim())
  }

  return (
    <div className="grid min-h-svh place-items-center bg-[linear-gradient(160deg,var(--sidebar)_0_46%,var(--background)_46%)] p-4">
      <Card className="w-full max-w-sm shadow-xl">
        <CardHeader>
          <div className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">Sofia &amp; Spiritz</div>
          <CardTitle className="text-2xl">P&amp;L Planner</CardTitle>
          <CardDescription>The client’s sheets and numbers, in one place.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-1.5"><Label htmlFor="email">Email</Label><Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="password">Password</Label><Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
            <Button type="submit" className="w-full" disabled={busy}>{busy ? <Ring size={16} color="currentColor" /> : 'Sign in'}</Button>
            {message && <p role="status" className="text-sm text-destructive">{message}</p>}
          </form>
          <Separator className="my-4" />
          <Button variant="outline" className="w-full" onClick={onDemo}>Open the demo with sample data</Button>
          <p className="mt-2 text-xs text-muted-foreground">The demo uses invented numbers made in your browser. It reads nothing from the database.</p>
        </CardContent>
      </Card>
    </div>
  )
}
