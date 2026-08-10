export type TenantThemeCandidate = {
  primary?: unknown
  primaryForeground?: unknown
  accent?: unknown
  accentForeground?: unknown
}

export const DEFAULT_TENANT_THEME = {
  primary: "#18181b",
  primaryForeground: "#fafafa",
  accent: "#2563eb",
  accentForeground: "#ffffff",
} as const

type TenantTheme = {
  primary: string
  primaryForeground: string
  accent: string
  accentForeground: string
}

function parseHex(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  const match = /^#([\da-f]{6})$/i.exec(normalized)
  if (!match) return null
  return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16)) as [number, number, number]
}

function relativeLuminance(rgb: [number, number, number]) {
  const channels = rgb.map((channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

export function contrastRatio(foreground: string, background: string) {
  const foregroundRgb = parseHex(foreground)
  const backgroundRgb = parseHex(background)
  if (!foregroundRgb || !backgroundRgb) return 0
  const lighter = Math.max(relativeLuminance(foregroundRgb), relativeLuminance(backgroundRgb))
  const darker = Math.min(relativeLuminance(foregroundRgb), relativeLuminance(backgroundRgb))
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Trusted server boundary for tenant branding. Callers must pass persisted
 * tenant configuration here; client components must never set the validated
 * attribute themselves. Unknown, malformed, or low-contrast values return the
 * complete base theme and cannot partially override a semantic pair.
 */
export function resolveValidatedTenantTheme(candidate: TenantThemeCandidate | null | undefined): {
  theme: TenantTheme
  validated: boolean
} {
  const primary = parseHex(candidate?.primary)
  const primaryForeground = parseHex(candidate?.primaryForeground)
  const accent = parseHex(candidate?.accent)
  const accentForeground = parseHex(candidate?.accentForeground)
  const isValid =
    Boolean(primary && primaryForeground && accent && accentForeground) &&
    contrastRatio(candidate?.primary as string, candidate?.primaryForeground as string) >= 4.5 &&
    contrastRatio(candidate?.accent as string, candidate?.accentForeground as string) >= 4.5

  if (!isValid) return { theme: DEFAULT_TENANT_THEME, validated: false }
  return {
    theme: {
      primary: candidate!.primary as string,
      primaryForeground: candidate!.primaryForeground as string,
      accent: candidate!.accent as string,
      accentForeground: candidate!.accentForeground as string,
    },
    validated: true,
  }
}

/** Return only server-renderable attributes/styles after validation succeeds. */
export function getValidatedTenantThemeProps(candidate: TenantThemeCandidate | null | undefined) {
  const result = resolveValidatedTenantTheme(candidate)
  if (!result.validated) return { attributes: {}, style: {} as Record<string, string> }
  return {
    attributes: { "data-theme-validated": "true" },
    style: {
      "--tenant-primary": result.theme.primary,
      "--tenant-primary-fg": result.theme.primaryForeground,
      "--tenant-accent": result.theme.accent,
      "--tenant-accent-fg": result.theme.accentForeground,
    },
  }
}
