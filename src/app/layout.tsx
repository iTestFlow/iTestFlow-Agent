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
  title: {
    default: "iTestFlow",
    template: "%s | iTestFlow",
  },
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
      {/* suppressHydrationWarning: browser extensions (Grammarly, password managers, etc.)
          inject attributes like data-gr-ext-installed onto <body> before React hydrates;
          harmless and outside the app's control, so silence the resulting mismatch. */}
      <body className="font-sans antialiased" suppressHydrationWarning>
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
