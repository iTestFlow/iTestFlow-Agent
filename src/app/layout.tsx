import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/shared/components/app-shell";

export const metadata: Metadata = {
  title: "iTestFlow Agent",
  description: "Local-first QA intelligence command center for Azure DevOps testing workflows.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
