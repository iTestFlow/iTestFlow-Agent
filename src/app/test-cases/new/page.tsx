import { Button, Card, CardHeader, PageHeader, SelectInput, TextArea, TextInput } from "@/shared/components/ui";

export default function AddNewTestCasePage() {
  return (
    <>
      <PageHeader
        eyebrow="Test Case Design"
        title="Add New Test Case"
        description="Manual cases are stored as user-authored drafts and included in coverage recalculation when selected."
      />
      <Card>
        <CardHeader title="Manual Test Case" />
        <div className="grid gap-5 p-5">
          <div className="grid gap-4 lg:grid-cols-[1fr_220px_220px_220px]">
            <TextInput placeholder="New test case title" />
            <SelectInput><option>Functional</option><option>Negative</option><option>Security</option></SelectInput>
            <SelectInput><option>High priority</option><option>Medium priority</option><option>Low priority</option></SelectInput>
            <SelectInput><option>High automation suitability</option><option>Medium</option><option>Low</option></SelectInput>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <TextArea placeholder="Enter preconditions" />
            <TextArea placeholder="No steps added yet" />
            <TextArea placeholder="Enter expected result" />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <TextInput placeholder="Enter test data" />
            <TextInput placeholder="Enter tags, comma separated" />
          </div>
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button variant="secondary">Cancel</Button>
            <Button>Save Test Case</Button>
          </div>
        </div>
      </Card>
    </>
  );
}
