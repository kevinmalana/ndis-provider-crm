import type { HTMLAttributes, ReactNode } from "react"

import { cn } from "@/lib/utils"

type AccessibleStatusProps = HTMLAttributes<HTMLParagraphElement> & {
  children: ReactNode
  assertive?: boolean
}

/** A persistent, visible status that does not depend on colour, sound, or motion. */
function AccessibleStatus({ className, assertive = false, children, ...props }: AccessibleStatusProps) {
  return (
    <p
      className={cn("rounded-md border border-border bg-muted px-3 py-2 text-sm", className)}
      role={assertive ? "alert" : "status"}
      aria-live={assertive ? "assertive" : "polite"}
      aria-atomic="true"
      {...props}
    >
      {children}
    </p>
  )
}

type FormErrorProps = HTMLAttributes<HTMLParagraphElement> & {
  id: string
  children: ReactNode
}

function FormError({ id, className, children, ...props }: FormErrorProps) {
  return (
    <p
      id={id}
      className={cn("text-sm font-medium text-danger", className)}
      role="alert"
      aria-live="assertive"
      {...props}
    >
      {children}
    </p>
  )
}

function StickyActionBar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("focus-safe-sticky-action", className)} {...props} />
}

export { AccessibleStatus, FormError, StickyActionBar }
