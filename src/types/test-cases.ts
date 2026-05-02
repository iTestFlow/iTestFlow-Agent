export type TestCaseType = "Functional" | "Negative" | "Integration" | "Regression" | "Accessibility"
export type TestPriority = "P0" | "P1" | "P2" | "P3"
export type TestSeverity = "Critical" | "High" | "Medium" | "Low"
export type AutomationSuitability = "High" | "Medium" | "Low" | "Manual only"

export type TestStep = {
  id: string
  action: string
  expected: string
}

export type GeneratedTestCase = {
  id: string
  projectId: string
  selected: boolean
  title: string
  type: TestCaseType
  priority: TestPriority
  severity: TestSeverity
  automationSuitability: AutomationSuitability
  preconditions: string
  steps: TestStep[]
  expectedResult: string
  testData: string
  coverage: string
  tags: string[]
}

export type LinkedTestCase = {
  id: string
  projectId: string
  title: string
  state: "Design" | "Ready" | "Active" | "Closed"
  priority: TestPriority
  automationStatus: "Automated" | "Planned" | "Manual" | "Not suitable"
  stepsCount: number
  coverageStatus: "Covered" | "Partial" | "Gap" | "Needs review"
  linkRelation: "User Story TestedBy Test Case" | "Test Case Tests User Story"
}

export type ReviewFinding = {
  id: string
  projectId: string
  category:
    | "Missing AC coverage"
    | "Missing business rule coverage"
    | "Duplicate/overlap"
    | "Weak steps"
    | "Weak expected result"
    | "Missing test data"
    | "Missing preconditions"
  severity: TestSeverity
  detail: string
  recommendation: string
}

export type TestPlan = {
  id: string
  projectId: string
  name: string
}

export type TestSuite = {
  id: string
  projectId: string
  testPlanId: string
  name: string
}

export type PublishResult = {
  id: string
  projectId: string
  title: string
  status: "Published" | "Failed"
  azureDevOpsId?: string
  linkStatus: "Linked" | "Pending" | "Failed"
  message: string
}

export type TestCaseGenerationRun = {
  id: string
  projectId: string
  targetStoryId: string
  title: string
  generatedCount: number
  selectedCount: number
  coverage: number
  status: "Draft" | "Ready to publish" | "Published"
  createdAt: string
}

