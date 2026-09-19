import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = path.join(process.cwd(), "migrations", "1710000049000_story_attachments.js");

describe("story attachment schema", () => {
  it("creates scoped attachment records, derived visuals, and tombstones", () => {
    expect(existsSync(migrationPath)).toBe(true);

    const ddl = readFileSync(migrationPath, "utf8");
    expect(ddl).toContain("CREATE TABLE story_attachments");
    expect(ddl).toContain("CREATE TABLE story_attachment_visuals");
    expect(ddl).toContain("canonical_story_id");
    expect(ddl).toContain("lifecycle_status");
    expect(ddl).toContain("parse_generation");
    expect(ddl).toContain("storage_cleanup_status");
    expect(ddl).toContain("uq_story_attachments_active_content");
  });
});
