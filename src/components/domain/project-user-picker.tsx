"use client";

import * as React from "react";
import { ChevronDown, Loader2, User, Users, X } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  const {
    users,
    loading = false,
    error = null,
    disabled = false,
    placeholder = props.mode === "single" ? "Unassigned" : "Select members",
    searchPlaceholder = "Search project users",
    emptyMessage = "No project users found.",
    ariaLabel = props.mode === "single" ? "Select assignee" : "Select project members",
    className,
    triggerClassName,
    contentClassName,
    align = "start",
    triggerVariant = "outline",
  } = props;
  const [open, setOpen] = React.useState(false);
  const selectedValueSet = React.useMemo(
    () => new Set(props.mode === "multiple" ? props.value : []),
    [props.mode, props.value],
  );
  const selectedUser = props.mode === "single"
    ? users.find((user) => projectUserValue(user) === props.value)
    : undefined;
  const selectedLabel = selectedUser
    ? projectUserLabel(selectedUser)
    : props.mode === "single"
      ? props.value
      : "";
  const triggerLabel = loading
    ? props.mode === "single" ? "Loading users..." : "Loading members"
    : props.mode === "multiple" && props.value.length
      ? `${props.value.length} selected`
      : selectedLabel || placeholder;
  const triggerDisabled = disabled || loading;

  function selectSingleValue(value: string) {
    if (props.mode !== "single") return;
    props.onValueChange(value);
    setOpen(false);
  }

  function setMultipleValue(userId: string, selected: boolean) {
    if (props.mode !== "multiple") return;
    const nextValue = selected
      ? [...props.value, userId].filter((value, index, values) => values.indexOf(value) === index)
      : props.value.filter((value) => value !== userId);
    props.onValueChange(nextValue);
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
              ) : props.mode === "multiple" ? (
                <Users className="size-4" />
              ) : (
                <User className="size-4" />
              )}
              <span className="truncate">{triggerLabel}</span>
            </span>
            <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
          </Button>
        </PopoverTrigger>
        {props.mode === "single" && props.clearable && props.value ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            onClick={() => props.onValueChange("")}
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
                  {props.mode === "single" ? (
                    <CommandItem
                      value={props.emptyOptionLabel ?? placeholder}
                      data-checked={!props.value}
                      onSelect={() => selectSingleValue("")}
                    >
                      <User className="size-4" />
                      {props.emptyOptionLabel ?? placeholder}
                    </CommandItem>
                  ) : null}
                  {users.map((user) => {
                    const userValue = projectUserValue(user);
                    const selected = props.mode === "single"
                      ? props.value === userValue
                      : selectedValueSet.has(user.id);
                    return (
                      <CommandItem
                        key={user.id}
                        value={projectUserLabel(user)}
                        data-checked={props.mode === "single" ? selected : undefined}
                        onSelect={() => {
                          if (props.mode === "single") {
                            selectSingleValue(userValue);
                          } else {
                            setMultipleValue(user.id, !selected);
                          }
                        }}
                        className="items-start gap-3 py-2"
                      >
                        {props.mode === "multiple" ? (
                          <Checkbox
                            checked={selected}
                            onClick={(event) => event.stopPropagation()}
                            onCheckedChange={(checked) => setMultipleValue(user.id, checked === true)}
                            aria-label={`Select ${user.displayName}`}
                            className="mt-2"
                          />
                        ) : null}
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
