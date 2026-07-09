import "server-only";

import { NextResponse } from "next/server";

import { isIntegrationError } from "@/modules/integrations/core/integration-error";
import { toFriendlyErrorResponse, type FriendlyErrorOptions } from "./error-response";

export function integrationScopeHeaders(error: unknown) {
  return isIntegrationError(error) ? { "x-itf-error-scope": "integration" } : undefined;
}

export function routeErrorResponse(error: unknown, options: FriendlyErrorOptions = {}) {
  const { body, status } = toFriendlyErrorResponse(error, options);
  const headers = integrationScopeHeaders(error);
  return NextResponse.json(body, headers ? { status, headers } : { status });
}
