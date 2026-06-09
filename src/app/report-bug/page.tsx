import { ContentShell } from "@/components/layout/content-shell";
import { ReportBugClient } from "./report-bug-client";

export default function ReportBugPage() {
  return (
    <ContentShell
      title="Report Bug"
      description="Generate, review, and post Azure DevOps Bug work items from QA defect notes."
    >
      <ReportBugClient />
    </ContentShell>
  );
}
