import { z } from "zod";

export const AzureDevOpsSettingsSchema = z.object({
  organizationUrl: z.string().url(),
  personalAccessToken: z.string().min(1),
});

export const AzureProjectSelectionSchema = z.object({
  projectId: z.string().min(1),
  azureProjectId: z.string().min(1),
  azureProjectName: z.string().min(1),
  azureOrganizationUrl: z.string().url(),
});
