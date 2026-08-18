"use client";

import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * In-app preview for screenshot evidence. The artifact route deliberately
 * forces downloads (Content-Disposition: attachment), which browsers ignore
 * for <img> loads — so the dialog previews inline while the Download button
 * keeps the hardened download path.
 */
export function ScreenshotPreviewDialog({ href, trigger }: { href: string; trigger: React.ReactNode }) {
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-[min(1600px,92vw)]">
        <DialogHeader>
          <DialogTitle>Screenshot evidence</DialogTitle>
          <DialogDescription>Captured during the run. Use Download to save a copy.</DialogDescription>
        </DialogHeader>
        {/* eslint-disable-next-line @next/next/no-img-element -- streamed evidence bytes, not an optimizable asset */}
        <img src={href} alt="Step screenshot evidence" className="max-h-[80vh] w-full rounded-md border border-border bg-muted/20 object-contain" />
        <DialogFooter showCloseButton>
          <Button asChild variant="outline">
            <a href={href}>
              <Download className="size-4" aria-hidden="true" />
              Download
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
