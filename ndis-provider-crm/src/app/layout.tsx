import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "NDIS Provider CRM",
  description:
    "Multi-tenant SaaS CRM for Australian NDIS providers — roster support workers, capture mobile service records, and share appropriate information with participants, nominees, and authorised external parties.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}