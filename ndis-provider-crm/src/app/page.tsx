import Link from "next/link";

const BRIEF_URL =
  "https://github.com/traycer/epics/blob/main/ndis-provider-crm-brief/index.md";
const TECH_PLAN_URL =
  "https://github.com/traycer/epics/blob/main/ndis-provider-crm-technical-plan/index.md";

export default function Home() {
  return (
    <main
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        maxWidth: 720,
        margin: "4rem auto",
        padding: "0 1.5rem",
        lineHeight: 1.6,
      }}
    >
      <h1 style={{ marginBottom: "0.5rem" }}>NDIS Provider CRM</h1>
      <p style={{ color: "#555", marginTop: 0 }}>
        Bootstrap scaffold — Next.js + Supabase (Sydney region).
      </p>

      <section style={{ marginTop: "2rem" }}>
        <h2>Status</h2>
        <ul>
          <li>
            Healthcheck:{" "}
            <Link href="/api/health" prefetch={false}>
              <code>/api/health</code>
            </Link>{" "}
            — should return <code>{`{ ok: true, supabase: true }`}</code>{" "}
            against the configured Sydney Supabase project.
          </li>
        </ul>
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h2>Project artifacts</h2>
        <ul>
          <li>
            <a href={BRIEF_URL} target="_blank" rel="noopener noreferrer">
              Epic brief
            </a>
          </li>
          <li>
            <a href={TECH_PLAN_URL} target="_blank" rel="noopener noreferrer">
              Technical plan
            </a>
          </li>
        </ul>
      </section>

      <section style={{ marginTop: "2rem", color: "#777", fontSize: 14 }}>
        <p>
          Authentication, MFA, full RLS suite, UI library, and Vercel
          deployment land in subsequent tickets.
        </p>
      </section>
    </main>
  );
}