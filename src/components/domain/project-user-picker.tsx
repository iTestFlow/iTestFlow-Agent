"use client";

import * as React from "react";
import { ChevronDown, Loader2, User, Users, X } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchableMultiSelect } from "@/components/ui/searchable-multi-select";
import { cn } from "@/lib/utils";
import type { ProjectUser } from "@/types/azure-devops";

type CommonProjectUserPickerProps = {
  users: ProjectUser[];
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  ariaLabel?: string;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  align?: React.ComponentProps<typeof PopoverContent>["align"];
  triggerVariant?: React.ComponentProps<typeof Button>["variant"];
};

type SingleProjectUserPickerProps = CommonProjectUserPickerProps & {
  mode: "single";
  value: string;
  onValueChange: (value: string) => void;
  emptyOptionLabel?: string;
  clearable?: boolean;
};

type MultipleProjectUserPickerProps = CommonProjectUserPickerProps & {
  mode: "multiple";
  value: string[];
  onValueChange: (value: string[]) => void;
};

export type ProjectUserPickerProps = SingleProjectUserPickerProps | MultipleProjectUserPickerProps;

export function ProjectUserPicker(props: ProjectUserPickerProps) {
  if (props.mode === "multiple") {
    return <MultipleProjectUserPicker {...props} />;
  }
  return <SingleProjectUserPicker {...props} />;
}

function MultipleProjectUserPicker(props: MultipleProjectUserPickerProps) {
  return (
    <SearchableMultiSelect
      options={props.users}
      value={props.value}
      onValueChange={props.onValueChange}
      getOptionValue={(user) => user.id}
      getOptionLabel={projectUserLabel}
      getOptionSearchText={projectUserLabel}
      renderOption={(user) => (
        <div className="flex min-w-0 items-start gap-3">
          <ProjectUserAvatar user={user} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">{user.displayName}</div>
            {user.uniqueName ? <div className="truncate text-xs text-muted-foreground">{user.uniqueName}</div> : null}
          </div>
        </div>
      )}
      loading={props.loading}
      error={props.error}
      disabled={props.disabled}
      placeholder={props.placeholder ?? "Select members"}
      loadingText="Loading members"
      searchPlaceholder={props.searchPlaceholder ?? "Search project users"}
      emptyMessage={props.emptyMessage ?? "No project users found."}
      ariaLabel={props.ariaLabel ?? "Select project members"}
      className={props.className}
      triggerClassName={props.triggerClassName}
      contentClassName={props.contentClassName}
      align={props.align}
      triggerVariant={props.triggerVariant}
      triggerIcon={<Users className="size-4" />}
    />
  );
}

function SingleProjectUserPicker(singleProps: SingleProjectUserPickerProps) {
  const {
    users,
    loading = false,
    error = null,
    disabled = false,
    placeholder = "Unassigned",
    searchPlaceholder = "Search project users",
    emptyMessage = "No project users found.",
    ariaLabel = "Select assignee",
    className,
    triggerClassName,
    contentClassName,
    align = "start",
    triggerVariant = "outline",
  } = singleProps;
  const [open, setOpen] = React.useState(false);
  const selectedUser = users.find((user) => projectUserValue(user) === singleProps.value);
  const selectedLabel = selectedUser
    ? projectUserLabel(selectedUser)
    : singleProps.value;
  const triggerLabel = loading
    ? "Loading users..."
    : selectedLabel || placeholder;
  const triggerDisabled = disabled || loading;

  function selectSingleValue(value: string) {
    singleProps.onValueChange(value);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn("flex min-w-0 gap-2", className)}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant={triggerVariant}
            disabled={triggerDisabled}
            role="combobox"
            aria-label={ariaLabel}
            aria-expanded={open}
            className={cn("h-10 min-w-0 flex-1 justify-between px-3", triggerClassName)}
          >
            <span className="inline-flex min-w-0 items-center gap-2">
              {selectedUser ? (
                <ProjectUserAvatar user={selectedUser} />
              ) : loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <User className="size-4" />
              )}
              <span className="truncate">{triggerLabel}</span>
            </span>
            <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
          </Button>
        </PopoverTrigger>
        {singleProps.clearable && singleProps.value ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            onClick={() => singleProps.onValueChange("")}
            aria-label="Clear assignee"
          >
            <X className="size-4" />
          </Button>
        ) : null}
      </div>
      <PopoverContent
        align={align}
        className={cn("w-[380px] max-w-[calc(100vw-2rem)] p-0", contentClassName)}
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading project users
              </div>
            ) : null}
            {!loading && error ? <div className="px-3 py-4 text-sm text-destructive">{error}</div> : null}
            {!loading && !error ? (
              <>
                <CommandEmpty>{emptyMessage}</CommandEmpty>
                <CommandGroup>
                  <CommandItem
                    value={singleProps.emptyOptionLabel ?? placeholder}
                    data-checked={!singleProps.value}
                    onSelect={() => selectSingleValue("")}
                  >
                    <User className="size-4" />
                    {singleProps.emptyOptionLabel ?? placeholder}
                  </CommandItem>
                  {users.map((user) => {
                    const userValue = projectUserValue(user);
                    const selected = singleProps.value === userValue;
                    return (
                      <CommandItem
                        key={user.id}
                        value={projectUserLabel(user)}
                        data-checked={selected}
                        onSelect={() => selectSingleValue(userValue)}
                        className="items-start gap-3 py-2"
                      >
                        <ProjectUserAvatar user={user} className="mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">{user.displayName}</div>
                          {user.uniqueName ? <div className="truncate text-xs text-muted-foreground">{user.uniqueName}</div> : null}
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

function ProjectUserAvatar({ user, className }: { user: ProjectUser; className?: string }) {
  return (
    <Avatar size="sm" className={className}>
      {user.imageUrl ? <AvatarImage src={user.imageUrl} alt="" /> : null}
      <AvatarFallback>{initialsFromName(user.displayName)}</AvatarFallback>
    </Avatar>
  );
}

export function projectUserValue(user: ProjectUser) {
  return user.uniqueName ?? user.displayName;
}

export function projectUserLabel(user: ProjectUser) {
  return user.uniqueName ? `${user.displayName} (${user.uniqueName})` : user.displayName;
}

function initialsFromName(value?: string) {
  if (!value) return "AD";
  const words = value.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join("") || "AD";
}
