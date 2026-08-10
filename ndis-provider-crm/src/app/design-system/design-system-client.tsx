"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"

import { AccessibleStatus, FormError, StickyActionLayout } from "@/components/ui/accessibility"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"

const TOKEN_GROUPS = [
  ["Colour", ["--color-bg", "--color-fg", "--color-muted", "--color-muted-fg", "--color-border", "--color-border-strong", "--color-primary", "--color-primary-fg", "--color-primary-hover", "--color-accent", "--color-accent-fg", "--color-accent-hover", "--color-success", "--color-success-fg", "--color-warning", "--color-warning-fg", "--color-danger", "--color-danger-fg", "--color-info", "--color-info-fg", "--color-focus-ring"]],
  ["Typography", ["--font-sans", "--font-mono", "--text-xs", "--text-sm", "--text-base", "--text-lg", "--text-xl", "--text-2xl", "--text-3xl", "--text-4xl", "--leading-tight", "--leading-normal", "--leading-relaxed", "--weight-normal", "--weight-medium", "--weight-semibold", "--weight-bold"]],
  ["Spacing", ["--space-0", "--space-1", "--space-2", "--space-3", "--space-4", "--space-5", "--space-6", "--space-8", "--space-10", "--space-12", "--space-16", "--space-20"]],
  ["Radii", ["--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius-full"]],
  ["Motion", ["--duration-fast", "--duration-base", "--duration-slow", "--easing-standard", "--easing-emphasized"]],
  ["Accessibility", ["--touch-ordinary-min", "--touch-worker-min", "--touch-min", "--z-dropdown", "--z-sticky", "--z-dialog", "--z-toast"]],
] as const

const ALL_TOKENS = TOKEN_GROUPS.flatMap(([, tokens]) => tokens)

function TokenRow({ name, value }: { name: string; value: string }) {
  const isColor = name.startsWith("--color-")
  const isText = name.startsWith("--text-") || name.startsWith("--font-")
  const isSpace = name.startsWith("--space-")
  const isRadius = name.startsWith("--radius-")
  return (
    <div className="flex min-h-16 items-center gap-3 rounded-md border border-border bg-card p-3">
      {isColor ? <div aria-hidden className="size-10 shrink-0 rounded border border-border" style={{ background: value }} /> : null}
      {isSpace ? <div aria-hidden className="shrink-0 bg-accent" style={{ width: value, height: value }} /> : null}
      {isRadius ? <div aria-hidden className="size-10 shrink-0 border border-accent bg-muted" style={{ borderRadius: value }} /> : null}
      <div className="min-w-0 text-xs">
        <code className="block truncate font-mono text-fg" style={isText ? (name.startsWith("--font-") ? { fontFamily: value } : { fontSize: value }) : undefined}>{name}</code>
        <span className="break-all text-muted-foreground">{value || "(unresolved)"}</span>
      </div>
    </div>
  )
}

export default function DesignSystemClient() {
  const [resolved, setResolved] = useState<Record<string, string>>({})
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const styles = getComputedStyle(document.documentElement)
      setResolved(Object.fromEntries(ALL_TOKENS.map((token) => [token, styles.getPropertyValue(token).trim()])))
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <main data-org="demo" className="mx-auto max-w-5xl space-y-12 px-6 py-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Design system reference</h1>
        <p className="text-muted-foreground">Development-only token and component reference. Values below are resolved with <code>getComputedStyle</code>; tenant overrides are accepted only after server validation.</p>
      </header>

      <section className="space-y-6" aria-labelledby="tokens-heading">
        <h2 id="tokens-heading" className="text-xl font-semibold">Resolved tokens</h2>
        {TOKEN_GROUPS.map(([title, tokens]) => <div key={title} className="space-y-2"><h3 className="text-base font-medium">{title}</h3><div className="grid grid-cols-1 gap-2 md:grid-cols-2">{tokens.map((name) => <TokenRow key={name} name={name} value={resolved[name] ?? ""} />)}</div></div>)}
      </section>

      <section className="space-y-4" aria-labelledby="components-heading">
        <h2 id="components-heading" className="text-xl font-semibold">Installed components</h2>
        <Card className="space-y-3 p-4"><h3 className="text-base font-medium">Buttons and worker control</h3><div className="flex flex-wrap gap-2"><Button className="ordinary-control">Primary</Button><Button variant="outline" className="ordinary-control">Outline</Button><Button variant="secondary" className="ordinary-control">Secondary</Button><Button variant="ghost" className="ordinary-control">Ghost</Button><Button variant="destructive" className="ordinary-control">Destructive</Button><Button className="worker-control">Worker action (48 px)</Button></div></Card>
        <Card className="space-y-3 p-4"><h3 className="text-base font-medium">Card, label, input and form error</h3><div className="max-w-md space-y-2"><Label htmlFor="ds-name">Full name</Label><Input id="ds-name" aria-describedby="ds-name-error" className="ordinary-control" placeholder="Jordan Walker" /><FormError id="ds-name-error">Example error remains visible and is announced.</FormError></div></Card>
        <Card className="space-y-3 p-4"><h3 className="text-base font-medium">Status and sticky action</h3><AccessibleStatus>Saved locally. Foreground retry remains available even when optional enhancements are unavailable.</AccessibleStatus><StickyActionLayout height="18rem" actionBar={<div className="flex flex-wrap justify-end gap-2"><Button variant="outline" className="ordinary-control">Cancel</Button><Button className="worker-control">Save changes</Button></div>}><div className="min-h-[32rem] space-y-3 text-sm text-muted-foreground"><p>The configured 18rem scroller owns overflow; the document body does not.</p><Input aria-label="Focus visibility fixture" className="ordinary-control" placeholder="Tab here near the action bar" /></div></StickyActionLayout></Card>
        <Card className="space-y-3 p-4"><h3 className="text-base font-medium">Dialog and dropdown menu</h3><div className="flex flex-wrap gap-2"><Dialog><DialogTrigger asChild><Button className="ordinary-control">Open dialog</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>Accessible dialog</DialogTitle><DialogDescription>Focus is trapped and restored by the primitive.</DialogDescription></DialogHeader><Button className="worker-control">Confirm</Button></DialogContent></Dialog><DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" className="ordinary-control">Open menu</Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem>First action</DropdownMenuItem><DropdownMenuItem>Second action</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div></Card>
        <Card className="space-y-3 p-4"><h3 className="text-base font-medium">Sheet and Sonner</h3><div className="flex flex-wrap gap-2"><Sheet><SheetTrigger asChild><Button variant="outline" className="ordinary-control">Open sheet</Button></SheetTrigger><SheetContent><SheetHeader><SheetTitle>Accessible sheet</SheetTitle><SheetDescription>Escape and the close button both remain available.</SheetDescription></SheetHeader></SheetContent></Sheet><Button className="ordinary-control" onClick={() => toast.success("Saved", { description: "This notification is supplementary to visible status." })}>Show toast</Button></div></Card>
      </section>
    </main>
  )
}
