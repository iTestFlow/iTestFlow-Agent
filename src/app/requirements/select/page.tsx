import { PageHeader } from "@/shared/components/ui";
import { RequirementAnalysisClient } from "@/shared/components/live/live-workflows";

export default function RequirementAnalysisSelectPage() {
  return (
    <>
      <PageHeader
        eyebrow="Requirement Analysis"
        title="Analyze Requirement"
        description="Run grounded requirement analysis with automatic project context selection."
      />
      <RequirementAnalysisClient />
    </>
  );
}
