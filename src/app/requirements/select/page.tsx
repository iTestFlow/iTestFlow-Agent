import { PageHeader } from "@/shared/components/ui";
import { RequirementAnalysisClient } from "@/shared/components/live/live-workflows";

export default function RequirementAnalysisSelectPage() {
  return (
    <>
      <PageHeader
        eyebrow="Requirement Analysis"
        title="Select Requirement and Context Stories"
        description="Review LLM/RAG suggested context before running analysis. Suggestions can be removed or extended manually."
      />
      <RequirementAnalysisClient />
    </>
  );
}
