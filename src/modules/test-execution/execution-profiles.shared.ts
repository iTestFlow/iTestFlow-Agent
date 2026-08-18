import type { ScreenshotPolicy } from "./screenshot-policy";
import type { TestDataMetaEntry } from "./execution-test-data.shared";

export const MAX_PROFILE_NAME_LENGTH = 120;

export class ProfileNameConflictError extends Error {
  constructor(name: string) {
    super(`A profile named "${name}" already exists in this project.`);
    this.name = "ProfileNameConflictError";
  }
}

export class ProfileNotFoundError extends Error {
  constructor() {
    super("Execution profile not found.");
    this.name = "ProfileNotFoundError";
  }
}

export type ExecutionProfile = {
  id: string;
  name: string;
  baseUrl: string | null;
  executionNotes: string | null;
  screenshotPolicy: ScreenshotPolicy;
  headless: boolean;
  viewportWidth: number;
  viewportHeight: number;
  testData: TestDataMetaEntry[];
  updatedAt: string;
};
