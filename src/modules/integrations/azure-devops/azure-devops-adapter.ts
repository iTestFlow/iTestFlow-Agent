import type { TestManagementProvider } from "../core/test-management-provider";
import type { WorkManagementProvider } from "../core/work-management-provider";

export interface AzureDevOpsAdapter extends WorkManagementProvider, TestManagementProvider {}
