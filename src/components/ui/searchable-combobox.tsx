"use client";

import * as React from "react";
import { ChevronDown, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
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

export type SearchableComboboxOption = {
  value: string;
  label: string;
  description?: string;
  searchText?: string;
};

export function SearchableCombobox({
  value,
  options,
  onValueChange,
  loading = false,
  disabled = false,
  placeholder = "Select an option",
  loadingText = "Loading options...",
  searchPlaceholder = "Search options",
  emptyMessage = "No options found.",
  ariaLabel = placeholder,
  selectedLabel,
  className,
  triggerClassName,
  contentClassName,
}: {
  value: string;
  options: SearchableComboboxOption[];
  onValueChange: (value: string) => void;
  loading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  loadingText?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  ariaLabel?: string;
  selectedLabel?: string;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const selectedOption = options.find((option) => option.value === value);
  const normalizedSearch = normalizeSearch(search);
  const filteredOptions = React.useMemo(() => {
    if (!normalizedSearch) return options;
    return options.filter((option) =>
      normalizeSearch(
        [option.value, option.label, option.description, option.searchText]
          .filter(Boolean)
          .join(" "),
      ).includes(normalizedSearch),
    );
  }, [normalizedSearch, options]);

  const triggerLabel = loading
    ? loadingText
    : selectedLabel ?? selectedOption?.label ?? (value || placeholder);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) setSearch("");
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          disabled={disabled || loading}
          className={cn("h-10 w-full justify-between px-3 text-left font-normal", className, triggerClassName)}
        >
          <span className="inline-flex min-w-0 items-center gap-2">
            {loading ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" /> : null}
            <span className="truncate">{triggerLabel}</span>
          </span>
          <ChevronDown
            className={cn("ml-2 size-4 shrink-0 opacity-50 transition-transform", open && "rotate-180")}
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn("w-[min(520px,calc(100vw-2rem))] p-0", contentClassName)}
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={searchPlaceholder}
          />
          <CommandList className="max-h-80">
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {filteredOptions.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  data-checked={option.value === value}
                  onSelect={() => {
                    onValueChange(option.value);
                    handleOpenChange(false);
                  }}
                  className="items-start"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{option.label}</span>
                    {option.description ? (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function normalizeSearch(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
