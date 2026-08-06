"use client";

import { useMemo, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const TOKEN_GROUPS = [
  {
    title: "Colour",
    tokens: [
      "--color-bg",
      "--color-fg",
      "--color-muted",
      "--color-muted-fg",
      "--color-border",
      "--color-border-strong",
      "--color-primary",
      "--color-primary-fg",
      "--color-primary-hover",
      "--color-accent",
      "--color-accent-fg",
      "--color-accent-hover",
      "--color-success",
      "--color-warning",
      "--color-danger",
      "--color-info",
      "--color-focus-ring",
    ],
  },
  {
    title: "Typography",
    tokens: [
      "--font-sans",
      "--font-mono",
      "--text-xs",
      "--text-sm",
      "--text-base",
      "--text-lg",
      "--text-xl",
      "--text-2xl",
      "--text-3xl",
      "--text-4xl",
      "--leading-tight",
      "--leading-normal",
      "--leading-relaxed",
    ],
  },
  {
    title: "Spacing",
    tokens: [
      "--space-1",
      "--space-2",
      "--space-3",
      "--space-4",
      "--space-5",
      "--space-6",
      "--space-8",
      "--space-10",
      "--space-12",
      "--space-16",
    ],
  },
  {
    title: "Radii",
    tokens: ["--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius-full"],
  },
  {
    title: "Motion",
    tokens: ["--duration-fast", "--duration-base", "--duration-slow", "--easing-standard"],
  },
  {
    title: "Accessibility",
    tokens: ["--touch-min"],
  },
] as const;

function Swatch({ name }: { name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const preview = useMemo(() => {
    if (name.startsWith("--color-")) {
      return {
        kind: "color" as const,
        style: { background: `var(${name})` },
      };
    }
    if (name.startsWith("--text-") || name.startsWith("--font-")) {
      return {
        kind: "text" as const,
        style: name.startsWith("--font-")
          ? { fontFamily: `var(${name})` }
          : { fontSize: `var(${name})` },
      };
    }
    if (name.startsWith("--space-")) {
      return {
        kind: "block" as const,
        style: { width: `var(${name})`, height: `var(${name})` },
      };
    }
    if (name.startsWith("--radius-")) {
      return {
        kind: "block" as const,
        style: { width: "5rem", height: "2.5rem", borderRadius: `var(${name})`, border: "1px solid var(--color-border)" },
      };
    }
    if (name.startsWith("--duration-") || name.startsWith("--easing-") || name === "--touch-min") {
      return {
        kind: "text" as const,
        style: {},
      };
    }
    return { kind: "text" as const, style: {} };
  }, [name]);

  return (
    <div
      ref={ref}
      className="flex items-center gap-3 rounded-md border border-border bg-card p-3"
    >
      {preview.kind === "color" ? (
        <div
          aria-hidden
          className="size-10 rounded border border-border"
          style={preview.style}
        />
      ) : null}
      {preview.kind === "block" ? (
        <div aria-hidden style={preview.style} />
      ) : null}
      <div className="flex flex-col text-xs">
        <code
          className="font-mono text-fg"
          style={preview.kind === "text" ? preview.style : undefined}
        >
          {name}
        </code>
        <span className="text-muted-foreground">var({name})</span>
      </div>
    </div>
  );
}

export default function DesignSystemPage() {
  if (process.env.NODE_ENV === "production") {
    return null;
  }

  return (
    <main data-org="demo" className="mx-auto max-w-5xl px-6 py-10 space-y-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Design system reference</h1>
        <p className="text-muted-foreground">
          Dev-only route. Token layer + shadcn/ui component baseline. Tenant theming
          hook (<code>data-org=&quot;demo&quot;</code>) is attached to this page only — real
          overrides land in a later ticket. This page does <strong>not</strong> ship
          to production; it&apos;s a local reference while you build.
        </p>
      </header>

      <section className="space-y-6">
        <h2 className="text-xl font-semibold">Tokens</h2>
        {TOKEN_GROUPS.map((group) => (
          <div key={group.title} className="space-y-2">
            <h3 className="text-base font-medium">{group.title}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {group.tokens.map((name) => (
                <Swatch key={name} name={name} />
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Components</h2>
        <p className="text-muted-foreground">
          Representative samples of the shadcn primitives installed in this ticket.
          Each renders through our token layer; retarget a token and these update.
        </p>

        <Card className="p-4 space-y-3">
          <h3 className="text-base font-medium">Buttons</h3>
          <div className="flex flex-wrap gap-2">
            <Button>Primary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
          </div>
        </Card>

        <Card className="p-4 space-y-3">
          <h3 className="text-base font-medium">Touch target</h3>
          <p className="text-sm text-muted-foreground">
            Buttons and form controls in the worker app must clear the 44 px tap
            target via the <code>--touch-min</code> token.
          </p>
          <Button
            style={{ minHeight: "var(--touch-min)", minWidth: "var(--touch-min)" }}
          >
            44 px tap
          </Button>
        </Card>

        <Card className="p-4 space-y-3 max-w-md">
          <h3 className="text-base font-medium">Form fields</h3>
          <div className="space-y-2">
            <Label htmlFor="ds-name">Full name</Label>
            <Input id="ds-name" type="text" placeholder="Jordan Walker" />
            <p className="text-xs text-muted-foreground">
              Visible focus ring respects WCAG 2.2 AA contrast against the page
              background.
            </p>
          </div>
        </Card>
      </section>
    </main>
  );
}
