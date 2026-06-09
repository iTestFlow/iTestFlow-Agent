import { ContentShell } from "@/components/layout/content-shell";
import { BusinessOwnerAssistantClient } from "./business-owner-assistant-client";

export default function BusinessOwnerAssistantPage() {
  return (
    <ContentShell
      title="Business Owner Assistant"
      description="Ask questions grounded in the selected project's indexed context and saved knowledge hub."
    >
      <BusinessOwnerAssistantClient />
    </ContentShell>
  );
}
