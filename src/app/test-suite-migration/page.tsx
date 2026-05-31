import { ContentShell } from "@/components/layout/content-shell";
import { TestSuiteMigrationClient } from "./test-suite-migration-client";

export default function TestSuiteMigrationPage() {
  return (
    <ContentShell
      title="Migrate Test Suites"
      description="Copy or move Azure DevOps Test Suites while preserving latest test point outcomes."
    >
      <TestSuiteMigrationClient />
    </ContentShell>
  );
}
