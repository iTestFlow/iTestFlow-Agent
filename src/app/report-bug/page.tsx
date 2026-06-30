import type { Metadata } from "next"
import { ContentShell } from "@/components/layout/content-shell";
import { ReportBugClient } from "./report-bug-client";

export const metadata: Metadata = { title: "Report Bug" }

export default function ReportBugPage() {
  return (
    <ContentShell
      title="Report Bug"
      maxWidth="dashboard"
      description="Generate, review, and post Azure DevOps Bug work items from QA defect notes."
    >
      <ReportBugClient />
    </ContentShell>
  );
}
