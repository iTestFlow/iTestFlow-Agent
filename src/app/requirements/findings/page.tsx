import { PageHeader } from "@/shared/components/ui";
import { RequirementAnalysisClient } from "@/shared/components/live/live-workflows";

export default function RequirementFindingsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Requirement Analysis"
        title="Findings Results List"
        description="Select, deselect, and edit AI findings before composing the final Azure DevOps comment."
      />
      <RequirementAnalysisClient />
    </>
  );
}
