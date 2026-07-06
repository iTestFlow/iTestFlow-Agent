import { describe, expect, it } from "vitest";

import {
  attachmentKey,
  buildRequiredFieldRows,
  coerceCustomFieldValue,
  customFieldsToRows,
  defaultFieldValue,
  findField,
  formatFileSize,
  mergeCustomFields,
  rowsToCustomFields,
  type BugFieldMetadata,
} from "./bug-custom-fields";

const fields: BugFieldMetadata[] = [
  {
    name: "Story Points",
    referenceName: "Microsoft.VSTS.Scheduling.StoryPoints",
    type: "double",
    required: true,
    defaultValue: 3,
  },
  {
    name: "Customer Impact",
    referenceName: "Custom.CustomerImpact",
    type: "picklistInteger",
    allowedValues: [1, 2, 3],
  },
  {
    name: "Escalated",
    referenceName: "Custom.Escalated",
    type: "boolean",
  },
  {
    name: "Title",
    referenceName: "System.Title",
    required: true,
  },
];

describe("bug custom fields", () => {
  it("preserves the typed value from an allowed-values match", () => {
    expect(coerceCustomFieldValue("2", fields[1])).toBe(2);
  });

  it("coerces integer, double, and boolean Azure field types", () => {
    expect(coerceCustomFieldValue("4.9", { name: "I", referenceName: "I", type: "integer" })).toBe(4);
    expect(coerceCustomFieldValue("4.9", { name: "D", referenceName: "D", type: "double" })).toBe(4.9);
    expect(coerceCustomFieldValue(" yes ", fields[2])).toBe(true);
    expect(coerceCustomFieldValue("0", fields[2])).toBe(false);
  });

  it("leaves invalid numeric and unknown boolean text observable", () => {
    expect(coerceCustomFieldValue("many", fields[0])).toBe("many");
    expect(coerceCustomFieldValue("sometimes", fields[2])).toBe("sometimes");
  });

  it("maps rows by display name, coerces values, and drops blank or reserved fields", () => {
    expect(rowsToCustomFields([
      { id: "1", referenceName: "customer impact", value: "3" },
      { id: "2", referenceName: "System.Title", value: "Injected title" },
      { id: "3", referenceName: " ", value: "ignored" },
    ], fields)).toEqual([{
      referenceName: "Custom.CustomerImpact",
      name: "Customer Impact",
      value: 3,
    }]);
  });

  it("creates required rows from editable non-reserved metadata", () => {
    const rows = buildRequiredFieldRows([
      ...fields,
      { name: "Read only", referenceName: "Custom.ReadOnly", required: true, readOnly: true },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      referenceName: "Microsoft.VSTS.Scheduling.StoryPoints",
      value: "3",
    });
  });

  it("falls back to required rows when generated custom fields are empty", () => {
    expect(customFieldsToRows([], fields)).toEqual([
      expect.objectContaining({
        referenceName: "Microsoft.VSTS.Scheduling.StoryPoints",
        value: "3",
      }),
    ]);
  });

  it("round-trips custom fields through canonical metadata names", () => {
    const rows = customFieldsToRows([
      { referenceName: "custom.customerimpact", name: "Old name", value: 2 },
    ], fields);
    expect(rows[0]).toMatchObject({
      referenceName: "Custom.CustomerImpact",
      name: "Customer Impact",
      value: "2",
    });
  });

  it("merges case-insensitively with reviewed fields taking precedence", () => {
    expect(mergeCustomFields(
      [{ referenceName: "custom.value", value: "reviewed" }],
      [
        { referenceName: "Custom.Value", value: "generated" },
        { referenceName: "Custom.Other", value: 2 },
        { referenceName: "System.Title", value: "reserved" },
      ],
    )).toEqual([
      { referenceName: "custom.value", value: "reviewed" },
      { referenceName: "Custom.Other", value: 2 },
    ]);
  });

  it("finds fields case-insensitively by reference name or display name", () => {
    expect(findField(fields, " custom.customerimpact ")).toBe(fields[1]);
    expect(findField(fields, "STORY POINTS")).toBe(fields[0]);
    expect(findField(fields, "missing")).toBeUndefined();
  });

  it("normalizes default values without inventing one", () => {
    expect(defaultFieldValue(fields[0])).toBe("3");
    expect(defaultFieldValue(fields[2])).toBe("");
  });

  it("formats file-size boundaries and builds a stable attachment identity", () => {
    expect(formatFileSize(1023)).toBe("1023 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
    expect(attachmentKey({
      name: "evidence.png",
      size: 20,
      lastModified: 123,
      type: "image/png",
    })).toBe("evidence.png-20-123-image/png");
  });
});
