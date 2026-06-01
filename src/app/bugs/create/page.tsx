import { ContentShell } from "@/components/layout/content-shell";
import { BugCreateClient } from "./bug-create-client";

export default function CreateBugPage() {
  return (
    <ContentShell
      title="Create Bug"
      description="Generate, review, and post Azure DevOps Bug work items from QA defect notes."
    >
      <BugCreateClient />
    </ContentShell>
  );
}
