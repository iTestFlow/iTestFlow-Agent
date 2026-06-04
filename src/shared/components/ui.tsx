import type { LucideIcon } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "@/shared/lib/utils";

export function PageHeader({
  title,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  if (!action) {
    return <h1 className="sr-only">{title}</h1>;
  }

  return (
    <div className="mb-5 flex justify-end">
      <h1 className="sr-only">{title}</h1>
      <div className="flex shrink-0 items-center gap-2">{action}</div>
    </div>
  );
}

export function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-2xl border border-border bg-card text-card-foreground shadow-[0_12px_35px_rgba(15,23,42,0.07)] dark:shadow-[0_18px_60px_rgba(0,0,0,0.28)]", className)}>
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div>
        <h2 className="text-base font-bold tracking-normal text-foreground">{title}</h2>
        {description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export const Button = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "ghost" | "danger";
  }
>(function Button({ children, variant = "primary", className, ...props }, ref) {
  return (
    <button
      ref={ref}
      className={cn(
        "focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-[7px] px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-primary text-primary-foreground hover:bg-primary/90",
        variant === "secondary" && "border border-border bg-secondary text-secondary-foreground hover:bg-secondary/80",
        variant === "ghost" && "text-muted-foreground hover:bg-muted hover:text-foreground",
        variant === "danger" && "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});

export function Badge({
  children,
  tone = "slate",
  className,
}: {
  children: React.ReactNode;
  tone?: "blue" | "cyan" | "emerald" | "amber" | "red" | "orange" | "violet" | "slate";
  className?: string;
}) {
  const tones = {
    blue: "border-primary/30 bg-primary/10 text-primary dark:text-primary",
    cyan: "border-info/30 bg-info/10 text-info dark:text-info",
    emerald: "border-success/30 bg-success/10 text-success dark:text-success",
    amber: "border-warning/40 bg-warning/15 text-warning-foreground dark:text-warning",
    red: "border-destructive/30 bg-destructive/10 text-destructive dark:text-destructive",
    orange: "border-warning/40 bg-warning/15 text-warning-foreground dark:text-warning",
    violet: "border-[hsl(var(--chart-3)/0.3)] bg-[hsl(var(--chart-3)/0.12)] text-[hsl(var(--chart-3))] dark:text-[hsl(var(--chart-3))]",
    slate: "border-border bg-secondary text-secondary-foreground",
  };

  return (
    <span className={cn("inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium", tones[tone], className)}>
      {children}
    </span>
  );
}

export function MetricCard({
  title,
  value,
  description,
  icon: Icon,
  tone = "blue",
}: {
  title: string;
  value: string;
  description: string;
  icon: LucideIcon;
  tone?: "blue" | "cyan" | "emerald" | "amber" | "red" | "orange" | "violet";
}) {
  const color = {
    blue: "text-primary bg-primary/10 border-primary/30 dark:text-primary",
    cyan: "text-info bg-info/10 border-info/30 dark:text-info",
    emerald: "text-success bg-success/10 border-success/30 dark:text-success",
    amber: "text-warning-foreground bg-warning/15 border-warning/40 dark:text-warning",
    red: "text-destructive bg-destructive/10 border-destructive/30 dark:text-destructive",
    orange: "text-warning-foreground bg-warning/15 border-warning/40 dark:text-warning",
    violet: "text-[hsl(var(--chart-3))] bg-[hsl(var(--chart-3)/0.12)] border-[hsl(var(--chart-3)/0.3)] dark:text-[hsl(var(--chart-3))]",
  }[tone];

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <div className="mt-2 text-[22px] font-bold text-foreground">{value}</div>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
        <div className={cn("rounded-full border p-2", color)}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </Card>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "focus-ring h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground",
        props.className,
      )}
    />
  );
}

export function SelectInput(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn("focus-ring h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground", props.className)}
    />
  );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        "focus-ring min-h-24 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground",
        props.className,
      )}
    />
  );
}
