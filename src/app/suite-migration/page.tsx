import { ContentShell } from "@/components/layout/content-shell";
import { SuiteMigrationClient } from "./suite-migration-client";

export default function SuiteMigrationPage() {
  return (
    <ContentShell
      title="Suite Migration"
      description="Copy or move Azure DevOps Test Suites while preserving latest test point outcomes."
    >
      <SuiteMigrationClient />
    </ContentShell>
  );
}
