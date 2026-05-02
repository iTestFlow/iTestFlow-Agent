import { PageHeader } from "@/shared/components/ui";
import { ExistingTestCaseReviewClient } from "@/shared/components/live/live-workflows";

export default function SuggestedAdditionsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Existing Linked Test Case Review"
        title="Suggested Additions"
        description="Suggested additions are drafts only. Select, edit, and approve before publishing to Azure Test Plans."
      />
      <ExistingTestCaseReviewClient />
    </>
  );
}
