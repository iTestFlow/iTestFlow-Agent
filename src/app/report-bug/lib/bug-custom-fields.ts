import { createLocalId } from "./reproduction-test-case";

export type FieldValue = string | number | boolean;

export type BugFieldMetadata = {
  name: string;
  referenceName: string;
  type?: string;
  helpText?: string;
  required?: boolean;
  alwaysRequired?: boolean;
  readOnly?: boolean;
  defaultValue?: unknown;
  allowedValues?: FieldValue[];
};

export type BugCustomField = {
  referenceName: string;
  name?: string;
  value: FieldValue;
};

export type CustomFieldRow = {
  id: string;
  referenceName: string;
  name?: string;
  value: string;
};

export const reservedBugFields = new Set([
  "System.Title",
  "System.State",
  "Microsoft.VSTS.TCM.ReproSteps",
  "Microsoft.VSTS.Common.Priority",
  "Microsoft.VSTS.Common.Severity",
  "System.AssignedTo",
  "System.AreaPath",
  "System.AreaId",
  "System.IterationPath",
  "System.IterationId",
  "Microsoft.VSTS.Common.ValueArea",
]);

export function buildRequiredFieldRows(fields: BugFieldMetadata[]): CustomFieldRow[] {
  return fields
    .filter((field) =>
      (field.alwaysRequired || field.required) &&
      !field.readOnly &&
      !reservedBugFields.has(field.referenceName)
    )
    .map((field) => ({
      id: createLocalId(field.referenceName),
      referenceName: field.referenceName,
      name: field.name,
      value: defaultFieldValue(field),
    }));
}

export function rowsToCustomFields(
  rows: CustomFieldRow[],
  fields: BugFieldMetadata[],
): BugCustomField[] {
  const customFields: BugCustomField[] = [];
  for (const row of rows) {
    const field = findField(fields, row.referenceName);
    const referenceName = field?.referenceName ?? row.referenceName.trim();
    if (!referenceName || reservedBugFields.has(referenceName)) continue;
    customFields.push({
      referenceName,
      name: field?.name ?? row.name,
      value: coerceCustomFieldValue(row.value, field),
    });
  }
  return customFields;
}

export function customFieldsToRows(
  customFields: BugCustomField[],
  fields: BugFieldMetadata[],
): CustomFieldRow[] {
  if (!customFields.length) return buildRequiredFieldRows(fields);
  return customFields
    .filter((field) =>
      !reservedBugFields.has(
        findField(fields, field.referenceName)?.referenceName ?? field.referenceName,
      )
    )
    .map((field) => {
      const metadataField = findField(fields, field.referenceName);
      return {
        id: createLocalId(field.referenceName),
        referenceName: metadataField?.referenceName ?? field.referenceName,
        name: metadataField?.name ?? field.name,
        value: String(field.value ?? ""),
      };
    });
}

export function mergeCustomFields(
  existing: BugCustomField[],
  generated: BugCustomField[],
) {
  const merged = new Map<string, BugCustomField>();
  generated
    .filter((field) => !reservedBugFields.has(field.referenceName))
    .forEach((field) => merged.set(field.referenceName.toLowerCase(), field));
  existing
    .filter((field) => !reservedBugFields.has(field.referenceName))
    .forEach((field) => merged.set(field.referenceName.toLowerCase(), field));
  return [...merged.values()];
}

export function coerceCustomFieldValue(
  value: string,
  field?: BugFieldMetadata,
): FieldValue {
  if (field?.allowedValues?.length) {
    const matched = field.allowedValues.find(
      (allowed) => String(allowed).toLowerCase() === value.toLowerCase(),
    );
    if (matched !== undefined) return matched;
  }
  if (field?.type === "integer" || field?.type === "picklistInteger") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : value;
  }
  if (field?.type === "double" || field?.type === "picklistDouble") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (field?.type === "boolean") {
    if (/^(true|yes|1)$/i.test(value.trim())) return true;
    if (/^(false|no|0)$/i.test(value.trim())) return false;
  }
  return value;
}

export function findField(fields: BugFieldMetadata[], value: string) {
  const normalized = value.trim().toLowerCase();
  return fields.find(
    (field) =>
      field.referenceName.toLowerCase() === normalized ||
      field.name.toLowerCase() === normalized,
  );
}

export function defaultFieldValue(field: BugFieldMetadata) {
  if (field.defaultValue !== undefined && field.defaultValue !== null) {
    return String(field.defaultValue);
  }
  return "";
}

export function attachmentKey(
  file: Pick<File, "name" | "size" | "lastModified" | "type">,
) {
  return `${file.name}-${file.size}-${file.lastModified}-${file.type}`;
}

export function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
