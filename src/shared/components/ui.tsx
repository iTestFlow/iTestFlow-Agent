import type { LucideIcon } from "lucide-react";
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
    <section className={cn("rounded-[10px] border border-[#c8d4e4] bg-white text-slate-950 shadow-command", className)}>
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
    <div className="flex items-start justify-between gap-3 border-b border-[#d8e2ef] px-5 py-4">
      <div>
        <h2 className="text-base font-bold tracking-normal text-slate-950">{title}</h2>
        {description ? <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function Button({
  children,
  variant = "primary",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button
      className={cn(
        "focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-[7px] px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-[#2f62e6] text-white hover:bg-[#2554d9]",
        variant === "secondary" && "border border-blue-600 bg-white text-blue-600 hover:bg-blue-50",
        variant === "ghost" && "text-slate-700 hover:bg-[#edf2f7]",
        variant === "danger" && "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

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
    blue: "border-blue-500 bg-blue-50 text-blue-600",
    cyan: "border-cyan-500 bg-cyan-50 text-cyan-700",
    emerald: "border-emerald-400 bg-emerald-50 text-emerald-600",
    amber: "border-amber-400 bg-amber-50 text-amber-700",
    red: "border-red-400 bg-red-50 text-red-600",
    orange: "border-orange-400 bg-orange-50 text-orange-700",
    violet: "border-violet-400 bg-violet-50 text-violet-700",
    slate: "border-slate-300 bg-white text-slate-600",
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
    blue: "text-blue-600 bg-blue-50 border-blue-500",
    cyan: "text-cyan-700 bg-cyan-50 border-cyan-500",
    emerald: "text-emerald-600 bg-emerald-50 border-emerald-400",
    amber: "text-amber-700 bg-amber-50 border-amber-400",
    red: "text-red-600 bg-red-50 border-red-400",
    orange: "text-orange-700 bg-orange-50 border-orange-400",
    violet: "text-violet-700 bg-violet-50 border-violet-400",
  }[tone];

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-500">{title}</p>
          <div className="mt-2 text-[22px] font-bold text-slate-950">{value}</div>
          <p className="mt-1 text-xs text-slate-500">{description}</p>
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
        "focus-ring h-10 w-full rounded-[6px] border border-[#c8d4e4] bg-white px-3 text-sm text-slate-950 placeholder:text-slate-500",
        props.className,
      )}
    />
  );
}

export function SelectInput(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn("focus-ring h-10 w-full rounded-[6px] border border-[#c8d4e4] bg-white px-3 text-sm text-slate-950", props.className)}
    />
  );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        "focus-ring min-h-24 w-full rounded-[6px] border border-[#c8d4e4] bg-[#f8fafc] px-3 py-2 text-sm text-slate-950 placeholder:text-slate-500",
        props.className,
      )}
    />
  );
}
