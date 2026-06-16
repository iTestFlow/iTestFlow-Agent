import type { StatusValue } from "./types";
import { StatusBadge } from "./section-card";

/** Compact at-a-glance status bar shown at the top of the settings page. */
export function StatusSummary({
  azure,
  ai,
  sync,
  dirty = false,
}: {
  azure: StatusValue;
  ai: StatusValue;
  sync: StatusValue;
  dirty?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      <StatusItem title="Azure DevOps" status={azure} />
      <StatusItem title="AI Provider" status={ai} />
      <StatusItem title="Knowledge Sync" status={sync} />
      {dirty ? (
        <div className="flex items-center gap-2 border-border text-xs text-muted-foreground sm:border-l sm:pl-4">
          <span className="font-medium text-foreground">Unsaved changes</span>
        </div>
      ) : null}
    </div>
  );
}

function StatusItem({ title, status }: { title: string; status: StatusValue }) {
  return (
    <div className="flex items-center gap-2 border-border pr-0 sm:border-r sm:pr-4">
      <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">{title}</span>
      <StatusBadge tone={status.tone} label={status.label} />
      {status.detail ? <span className="hidden max-w-56 truncate text-xs text-muted-foreground lg:inline">{status.detail}</span> : null}
    </div>
  );
}
