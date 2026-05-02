import { Download } from "lucide-react";
import { Button, Card, CardHeader, PageHeader } from "@/shared/components/ui";

const exports = [
  ["Requirement analysis", "Markdown", "Includes selected findings and scores"],
  ["Selected test cases", "CSV", "Only selected and approved test cases"],
  ["Coverage matrix", "CSV", "Traceability status by AC, rule, risk, dependency"],
  ["Full AI result", "JSON", "Raw and validated output references"],
  ["Publish summary", "Markdown / JSON", "Azure IDs, plan, suite, link status"],
];

export default function ReportsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Reports"
        title="Exports and Reports"
        description="Local export options for requirement analysis, test design, coverage, and publish summaries."
      />
      <Card>
        <CardHeader title="Available Exports" />
        <div className="divide-y">
          {exports.map((item) => (
            <div key={item[0]} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="font-medium">{item[0]}</div>
                <div className="mt-1 text-sm text-muted-foreground">{item[2]}</div>
              </div>
              <Button variant="secondary">
                <Download className="h-4 w-4" />
                Export {item[1]}
              </Button>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
