import { useEffect, useRef, type CSSProperties, type HTMLAttributes, type ReactNode } from "react"

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

function StickyActionBarInternal({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("focus-safe-sticky-action", className)} {...props} />
}

type StickyActionLayoutProps = Omit<HTMLAttributes<HTMLDivElement>, "style"> & {
  actionBar: ReactNode
  /** A definite CSS height for the scrolling container (for example 18rem or 70vh). */
  height: CSSProperties["height"]
  style?: CSSProperties
}

/**
 * Scroll-container contract for sticky actions. The ResizeObserver keeps the
 * scroll padding equal to the rendered bar, including safe-area insets and
 * responsive wrapping, so keyboard focus cannot be hidden underneath it.
 */
function StickyActionLayout({ actionBar, className, children, height, style, ...props }: StickyActionLayoutProps) {
  const regionRef = useRef<HTMLDivElement>(null)
  const actionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const region = regionRef.current
    const action = actionRef.current
    if (!region || !action) return

    const updateSpace = () => region.style.setProperty("--sticky-action-space", `${action.offsetHeight}px`)
    updateSpace()
    const observer = new ResizeObserver(updateSpace)
    observer.observe(action)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={regionRef}
      className={cn("focus-safe-scroll-region", className)}
      style={{ ...style, height }}
      data-scroll-owner="sticky-action-layout"
      {...props}
    >
      <div>{children}</div>
      <div ref={actionRef}>
        <StickyActionBarInternal>{actionBar}</StickyActionBarInternal>
      </div>
    </div>
  )
}

export { AccessibleStatus, FormError, StickyActionLayout }
