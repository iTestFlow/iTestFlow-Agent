"use client";

import * as React from "react";
import { ChevronDown, Loader2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type SearchableMultiSelectProps<T> = {
  options: T[];
  value: string[];
  onValueChange: (value: string[]) => void;
  getOptionValue: (option: T) => string;
  getOptionLabel: (option: T) => string;
  getOptionSearchText?: (option: T) => string;
  renderOption?: (option: T) => React.ReactNode;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  placeholder?: string;
  loadingText?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  ariaLabel?: string;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  align?: React.ComponentProps<typeof PopoverContent>["align"];
  triggerVariant?: React.ComponentProps<typeof Button>["variant"];
  triggerIcon?: React.ReactNode;
  showSelectedTags?: boolean;
  selectedTagsEmptyText?: string;
  onRetry?: () => void;
};

export function SearchableMultiSelect<T>({
  options,
  value,
  onValueChange,
  getOptionValue,
  getOptionLabel,
  getOptionSearchText,
  renderOption,
  loading = false,
  error = null,
  disabled = false,
  placeholder = "Select options",
  loadingText = "Loading options...",
  searchPlaceholder = "Search options",
  emptyMessage = "No options found.",
  ariaLabel = placeholder,
  className,
  triggerClassName,
  contentClassName,
  align = "start",
  triggerVariant = "outline",
  triggerIcon,
  showSelectedTags = false,
  selectedTagsEmptyText,
  onRetry,
}: SearchableMultiSelectProps<T>) {
  const [open, setOpen] = React.useState(false);
  const selectedValueSet = React.useMemo(
    () => new Set(value.map(normalizeOptionValue)),
    [value],
  );
  const triggerLabel = loading
    ? loadingText
    : value.length
      ? `${value.length} selected`
      : placeholder;
  const optionLabelByValue = React.useMemo(
    () => new Map(
      options.map((option) => [
        normalizeOptionValue(getOptionValue(option)),
        getOptionLabel(option),
      ]),
    ),
    [getOptionLabel, getOptionValue, options],
  );

  function setOptionSelected(optionValue: string, selected: boolean) {
    const normalizedValue = normalizeOptionValue(optionValue);
    const nextValue = selected
      ? [...value, optionValue].filter(
          (item, index, values) =>
            values.findIndex((candidate) => normalizeOptionValue(candidate) === normalizeOptionValue(item)) === index,
        )
      : value.filter((item) => normalizeOptionValue(item) !== normalizedValue);
    onValueChange(nextValue);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn("min-w-0", className)}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant={triggerVariant}
            disabled={disabled}
            role="combobox"
            aria-label={ariaLabel}
            aria-expanded={open}
            aria-haspopup="listbox"
            className={cn("h-10 w-full min-w-0 justify-between px-3", triggerClassName)}
          >
            <span className="inline-flex min-w-0 items-center gap-2">
              {loading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : triggerIcon}
              <span className="truncate">{triggerLabel}</span>
            </span>
            <ChevronDown
              className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")}
              aria-hidden="true"
            />
          </Button>
        </PopoverTrigger>
        {showSelectedTags ? (
          <div className="mt-2 flex min-h-7 flex-wrap items-center gap-2">
            {value.length ? value.map((selectedValue) => {
              const label = optionLabelByValue.get(normalizeOptionValue(selectedValue)) ?? selectedValue;
              return (
                <Badge
                  key={normalizeOptionValue(selectedValue)}
                  variant="secondary"
                  className="h-7 max-w-full gap-1 rounded-md pl-2 pr-1"
                >
                  <span className="max-w-[240px] truncate">{label}</span>
                  <button
                    type="button"
                    className="rounded-[4px] p-0.5 text-muted-foreground hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                    onClick={() => setOptionSelected(selectedValue, false)}
                    disabled={disabled}
                    aria-label={`Remove ${label}`}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              );
            }) : selectedTagsEmptyText ? (
              <span className="text-sm text-muted-foreground">{selectedTagsEmptyText}</span>
            ) : null}
          </div>
        ) : null}
      </div>
      <PopoverContent
        align={align}
        className={cn("w-[380px] max-w-[calc(100vw-2rem)] p-0", contentClassName)}
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList role="listbox" aria-multiselectable="true">
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {loadingText}
              </div>
            ) : null}
            {!loading && error ? (
              <div className="space-y-3 px-3 py-4 text-sm">
                <div className="text-destructive">{error}</div>
                {onRetry ? (
                  <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : null}
            {!loading && !error ? (
              <>
                <CommandEmpty>{emptyMessage}</CommandEmpty>
                <CommandGroup>
                  {options.map((option) => {
                    const optionValue = getOptionValue(option);
                    const selected = selectedValueSet.has(normalizeOptionValue(optionValue));
                    const optionLabel = getOptionLabel(option);
                    const searchValue = getOptionSearchText?.(option) ?? optionLabel;
                    return (
                      <CommandItem
                        key={optionValue}
                        value={searchValue}
                        data-checked={undefined}
                        aria-selected={selected}
                        onSelect={() => setOptionSelected(optionValue, !selected)}
                        className="items-start gap-3 py-2"
                      >
                        <Checkbox
                          checked={selected}
                          onClick={(event) => event.stopPropagation()}
                          onCheckedChange={(checked) => setOptionSelected(optionValue, checked === true)}
                          aria-label={`Select ${optionLabel}`}
                          className="mt-0.5"
                        />
                        <div className="min-w-0 flex-1">
                          {renderOption ? renderOption(option) : (
                            <div className="truncate text-sm font-medium text-foreground">{optionLabel}</div>
                          )}
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function normalizeOptionValue(value: string) {
  return value.trim().toLocaleLowerCase();
}
