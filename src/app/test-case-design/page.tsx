import type { Metadata } from "next"
import { ContentShell } from "@/components/layout/content-shell"
import { TestCaseDesignClient } from "./test-case-design-client"
import { TEST_CASE_DESIGN_PAGE_DESCRIPTION } from "./test-case-design-copy"

export const metadata: Metadata = { title: "Test Case Design" }

export default function TestCaseDesignPage() {
  return (
    <ContentShell
      title="Test Case Design"
      description={TEST_CASE_DESIGN_PAGE_DESCRIPTION}
    >
      <TestCaseDesignClient />
    </ContentShell>
  )
}
