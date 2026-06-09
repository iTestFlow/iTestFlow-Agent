"use client";

import { useId } from "react";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export function SettingSwitch({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();

  return (
    <div className={cn("flex items-start justify-between gap-4 rounded-md border border-border bg-card p-3", className)}>
      <Label htmlFor={id} className="min-w-0 cursor-pointer space-y-1">
        <span className="block text-sm font-semibold text-foreground">{label}</span>
        {description ? (
          <span className="block text-xs font-normal leading-5 text-muted-foreground">{description}</span>
        ) : null}
      </Label>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={label}
        className="mt-0.5"
      />
    </div>
  );
}
