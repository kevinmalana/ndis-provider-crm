/**
 * Tiny helper for scripts that must read env vars from .env.local at
 * runtime. The application (Next.js) reads env vars directly; this file
 * exists because the bootstrap / seed scripts run via `tsx` outside of
 * the Next.js environment.
 */

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    process.stderr.write(
      `[env] missing required env var: ${name}\n` +
        `[env] set it in .env.local and re-run.\n`,
    );
    process.exit(1);
  }
  return value;
}