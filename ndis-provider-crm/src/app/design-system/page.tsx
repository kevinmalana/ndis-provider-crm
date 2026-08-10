import { notFound } from "next/navigation"

import DesignSystemClient from "./design-system-client"

export default function DesignSystemPage() {
  if (process.env.NODE_ENV === "production") notFound()
  return <DesignSystemClient />
}
