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
    blue: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
    cyan: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
    emerald: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    amber: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    red: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    orange: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
    violet: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
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
    blue: "text-blue-700 bg-blue-500/10 border-blue-500/30 dark:text-blue-300",
    cyan: "text-cyan-700 bg-cyan-500/10 border-cyan-500/30 dark:text-cyan-300",
    emerald: "text-emerald-700 bg-emerald-500/10 border-emerald-500/30 dark:text-emerald-300",
    amber: "text-amber-700 bg-amber-500/10 border-amber-500/30 dark:text-amber-300",
    red: "text-red-700 bg-red-500/10 border-red-500/30 dark:text-red-300",
    orange: "text-orange-700 bg-orange-500/10 border-orange-500/30 dark:text-orange-300",
    violet: "text-violet-700 bg-violet-500/10 border-violet-500/30 dark:text-violet-300",
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
