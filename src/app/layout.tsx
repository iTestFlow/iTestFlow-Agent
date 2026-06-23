import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/layout/app-shell";
import { Toaster } from "@/components/ui/sonner";
import { SessionExpiryRedirect } from "@/components/auth/session-expiry-redirect";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Inter } from "next/font/google";
import { cn } from "@/lib/utils";
import { UnsavedChangesProvider } from "@/components/navigation/unsaved-changes-provider";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "iTestFlow",
  description: "Local-first test intelligence command center for Azure DevOps testing workflows.",
  icons: {
    icon: [{ url: "/brand/itestflow-icon.png", type: "image/png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={cn("font-sans", inter.variable)} suppressHydrationWarning>
      <body className="font-sans antialiased">
        <ThemeProvider>
          <TooltipProvider>
            <UnsavedChangesProvider>
              <SessionExpiryRedirect />
              <AppShell>{children}</AppShell>
              <Toaster richColors closeButton />
            </UnsavedChangesProvider>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
