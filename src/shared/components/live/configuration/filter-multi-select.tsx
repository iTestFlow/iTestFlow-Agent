"use client";

import { Button } from "@/components/ui/button";
import { ContextFilterSelector } from "@/components/domain/context-filter-selector";

/**
 * Wraps {@link ContextFilterSelector} (search + chips + selected count) with
 * Select all / Clear shortcuts and an optional "select at least one" warning.
 */
export function FilterMultiSelect({
  title,
  description,
  options,
  selectedValues,
  onChange,
  loading,
  error,
  disabled,
  searchPlaceholder,
  emptyMessage,
  onRetry,
  requireSelection = false,
}: {
  title: string;
  description: string;
  options: string[];
  selectedValues: string[];
  onChange: (values: string[]) => void;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  searchPlaceholder?: string;
  emptyMessage?: string;
  onRetry?: () => void;
  requireSelection?: boolean;
}) {
  const showWarning = requireSelection && !disabled && selectedValues.length === 0;

  return (
    <div className="space-y-2">
      <ContextFilterSelector
        title={title}
        description={description}
        options={options}
        selectedValues={selectedValues}
        onChange={onChange}
        loading={loading}
        error={error}
        disabled={disabled}
        searchPlaceholder={searchPlaceholder}
        emptyMessage={emptyMessage}
        onRetry={onRetry}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled || loading || !options.length || selectedValues.length === options.length}
            onClick={() => onChange(options)}
          >
            Select all
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled || loading || !selectedValues.length}
            onClick={() => onChange([])}
          >
            Clear
          </Button>
        </div>
        {showWarning ? (
          <p className="text-xs text-warning-foreground dark:text-warning">
            Select at least one to include in the sync.
          </p>
        ) : null}
      </div>
    </div>
  );
}
