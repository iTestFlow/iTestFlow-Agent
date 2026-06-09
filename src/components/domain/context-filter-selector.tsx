"use client"

import { ListFilter } from "lucide-react"

import { SearchableMultiSelect } from "@/components/ui/searchable-multi-select"

type ContextFilterSelectorProps = {
  title: string
  description: string
  options: string[]
  selectedValues: string[]
  onChange: (values: string[]) => void
  loading?: boolean
  error?: string | null
  disabled?: boolean
  searchPlaceholder?: string
  emptyMessage?: string
  onRetry?: () => void
}

export function ContextFilterSelector({
  title,
  description,
  options,
  selectedValues,
  onChange,
  loading = false,
  error = null,
  disabled = false,
  searchPlaceholder = `Search ${title.toLocaleLowerCase()}`,
  emptyMessage = `No ${title.toLocaleLowerCase()} found.`,
  onRetry,
}: ContextFilterSelectorProps) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">{title}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{description}</div>
        </div>
        <div className="text-xs text-muted-foreground">{selectedValues.length} selected</div>
      </div>

      <SearchableMultiSelect
        className="mt-3"
        options={options}
        value={selectedValues}
        onValueChange={onChange}
        getOptionValue={(option) => option}
        getOptionLabel={(option) => option}
        loading={loading}
        error={error}
        disabled={disabled}
        placeholder={`Select ${title.toLocaleLowerCase()}`}
        loadingText={`Loading ${title.toLocaleLowerCase()}...`}
        searchPlaceholder={searchPlaceholder}
        emptyMessage={emptyMessage}
        ariaLabel={`Select ${title.toLocaleLowerCase()}`}
        triggerIcon={<ListFilter className="size-4" />}
        showSelectedTags
        selectedTagsEmptyText={`No ${title.toLocaleLowerCase()} selected`}
        contentClassName="w-[min(520px,calc(100vw-2rem))]"
        onRetry={onRetry}
      />
    </div>
  )
}
