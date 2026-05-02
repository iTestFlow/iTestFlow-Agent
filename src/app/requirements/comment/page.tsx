import { PageHeader } from "@/shared/components/ui";
import { RequirementAnalysisClient } from "@/shared/components/live/live-workflows";

export default function RequirementCommentPage() {
  return (
    <>
      <PageHeader
        eyebrow="Requirement Analysis"
        title="Final Comment Preview"
        description="The final Azure DevOps comment includes selected findings only, with user edits applied."
      />
      <RequirementAnalysisClient />
    </>
  );
}
